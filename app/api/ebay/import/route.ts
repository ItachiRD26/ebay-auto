import { NextRequest, NextResponse } from "next/server";
import { getAppToken } from "@/lib/ebay";
import { db, COLLECTIONS, DEFAULT_SETTINGS } from "@/lib/firebase";
import { QueueProduct, Settings } from "@/types";

const EXCLUDED_KEYWORDS = [
  "iphone", "samsung galaxy", "apple watch", "airpods", "macbook",
  "playstation", "xbox", "nintendo switch", "gpu", "cpu",
  "nike", "adidas", "gucci", "louis vuitton", "supreme", "yeezy",
  "car engine", "motor oil", "brake pad", "tire", "exhaust",
  "replica", "counterfeit",
];

const EXCLUDED_CATEGORY_IDS = [
  "6000", "293", "9355", "15032", "260", "267", "11450",
];

function isBannedProduct(title: string, categoryId: string): boolean {
  const t = title.toLowerCase();
  if (EXCLUDED_KEYWORDS.some((kw) => t.includes(kw))) return true;
  if (EXCLUDED_CATEGORY_IDS.includes(categoryId)) return true;
  return false;
}

function extractItemId(url: string): string | null {
  const match = url.match(/\/itm\/(?:[^/?]+\/)?(\d{10,})/);
  return match ? match[1] : null;
}

export async function POST(req: NextRequest) {
  try {
    const { urls } = await req.json();
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json({ error: "URLs array required" }, { status: 400 });
    }

    const token = await getAppToken();

    const settingsDoc = await db.collection(COLLECTIONS.SETTINGS).doc("main").get();
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(settingsDoc.exists ? settingsDoc.data() : {}),
    } as Settings;

    const {
      minPrice = 15,
      maxPrice = 80,
      markupPercent = 40,
      defaultStock = 10,
      onlyNewCondition = true,
    } = settings;

    const results = { added: 0, skipped: 0, filtered: 0, errors: 0 };
    const batch = db.batch();

    for (const url of urls) {
      try {
        const itemId = extractItemId(url);
        if (!itemId) { results.errors++; continue; }

        // Skip duplicates
        const existing = await db
          .collection(COLLECTIONS.QUEUE)
          .where("ebayItemId", "==", itemId)
          .limit(1)
          .get();
        if (!existing.empty) { results.skipped++; continue; }

        // Fetch from eBay
        const res = await fetch(
          `https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
            },
          }
        );

        if (!res.ok) { results.errors++; continue; }
        const item = await res.json();

        const price = parseFloat(item.price?.value ?? "0");
        const condition = item.condition ?? "";
        const categoryId = item.categories?.[0]?.categoryId ?? "";
        const title = item.title ?? "";

        // Apply filters
        if (price < minPrice || price > maxPrice) { results.filtered++; continue; }
        if (onlyNewCondition && !condition.toLowerCase().includes("new")) { results.filtered++; continue; }
        if (isBannedProduct(title, categoryId)) { results.filtered++; continue; }

        const suggestedSellingPrice = parseFloat(
          (price * (1 + markupPercent / 100)).toFixed(2)
        );

        // Extract all images
        const images: string[] = [];
        if (item.image?.imageUrl) images.push(item.image.imageUrl);
        if (item.additionalImages) {
          item.additionalImages.forEach((img: { imageUrl: string }) => {
            if (!images.includes(img.imageUrl)) images.push(img.imageUrl);
          });
        }

        const product: Omit<QueueProduct, "id"> = {
          ebayItemId: itemId,
          title,
          images,
          ebayReferencePrice: price,
          eproloPrice: null,
          eproloUrl: null,
          suggestedSellingPrice,
          margin: null,
          marginPercent: null,
          categoryId,
          categoryName: item.categories?.[0]?.categoryName ?? "",
          soldCount: item.unitSoldCount ?? 0,
          condition,
          sourceUrl: url,
          status: "pending",
          description: "",
          stock: defaultStock,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        const ref = db.collection(COLLECTIONS.QUEUE).doc();
        batch.set(ref, product);
        results.added++;

        await new Promise((r) => setTimeout(r, 200));
      } catch {
        results.errors++;
      }
    }

    await batch.commit();
    return NextResponse.json({ success: true, ...results });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}