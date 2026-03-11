import { NextRequest, NextResponse } from "next/server";
import { searchProducts } from "@/lib/ebay";
import { db, COLLECTIONS, DEFAULT_SETTINGS } from "@/lib/firebase";
import { QueueProduct, Settings } from "@/types";

export const WINNING_KEYWORDS = [
  "kitchen gadgets", "home organization", "storage solutions",
  "bathroom accessories", "cleaning tools", "wall art decor",
  "led strip lights", "phone accessories", "pet accessories",
  "dog toys", "cat accessories", "baby accessories",
  "fitness equipment", "yoga mat", "resistance bands",
  "garden tools", "outdoor furniture", "plant pots",
  "jewelry organizer", "makeup organizer", "hair accessories",
  "office supplies", "desk organizer", "notebook planner",
  "candles home decor", "picture frames", "throw pillows",
  "kids toys", "board games", "puzzles adults",
];

// ── Keywords/titles that signal branded or excluded products ──────────────────
const EXCLUDED_KEYWORDS = [
  // Automotive
  "car engine", "motor oil", "transmission", "brake pad", "tire",
  "exhaust", "catalytic", "alternator", "radiator", "carburetor",
  // Brand electronics
  "iphone", "samsung galaxy", "apple watch", "airpods", "macbook",
  "playstation", "xbox", "nintendo switch", "gpu", "cpu", "graphics card",
  "laptop", "tablet", "smart tv", "ipad",
  // Brand clothing
  "nike", "adidas", "gucci", "louis vuitton", "supreme", "yeezy",
  "jordan", "off-white", "balenciaga", "versace", "prada",
  // Other problematic
  "replica", "counterfeit", "fake",
];

// ── eBay category IDs to skip ─────────────────────────────────────────────────
const EXCLUDED_CATEGORY_IDS = [
  "6000",   // eBay Motors
  "293",    // Consumer Electronics
  "9355",   // Computers/Tablets & Networking
  "15032",  // Cell Phones & Accessories (brand heavy)
  "260",    // Stamps
  "267",    // Books (low margin)
  "11450",  // Clothing, Shoes (brand issues)
];

function isBannedProduct(title: string, categoryId: string): boolean {
  const titleLower = title.toLowerCase();

  // Check excluded keywords in title
  if (EXCLUDED_KEYWORDS.some((kw) => titleLower.includes(kw))) return true;

  // Check excluded categories
  if (EXCLUDED_CATEGORY_IDS.includes(categoryId)) return true;

  return false;
}

async function processItems(
  items: Record<string, unknown>[],
  settings: Settings
): Promise<number> {
  const {
    minSoldCount = 20,
    minPrice = 15,
    maxPrice = 80,
    markupPercent = 40,
    defaultStock = 10,
    onlyNewCondition = true,
    onlyFreeShipping = false,
  } = settings;

  const batch = db.batch();
  let added = 0;

  for (const item of items) {
    const price = parseFloat((item.price as { value: string })?.value ?? "0");
    const soldCount = (item.unitSoldCount as number) ?? 0;
    const condition = (item.condition as string) ?? "";
    const title = (item.title as string) ?? "";
    const categoryId = ((item.categories as { categoryId: string }[])?.[0]?.categoryId) ?? "";
    const shippingOptions = item.shippingOptions as { shippingCostType: string }[] | undefined;
    const hasFreeShipping = shippingOptions?.some((s) => s.shippingCostType === "FREE") ?? false;

    // ── Apply all filters ────────────────────────────────────────────────────
    if (price < minPrice) continue;
    if (price > maxPrice) continue;
    if (soldCount < minSoldCount) continue;
    if (onlyNewCondition && !condition.toLowerCase().includes("new")) continue;
    if (onlyFreeShipping && !hasFreeShipping) continue;
    if (isBannedProduct(title, categoryId)) continue;

    // Skip duplicates
    const existing = await db
      .collection(COLLECTIONS.QUEUE)
      .where("ebayItemId", "==", item.itemId)
      .limit(1)
      .get();
    if (!existing.empty) continue;

    const suggestedSellingPrice = parseFloat(
      (price * (1 + markupPercent / 100)).toFixed(2)
    );

    const product: Omit<QueueProduct, "id"> = {
      ebayItemId: item.itemId as string,
      title,
      images:
        (item.thumbnailImages as { imageUrl: string }[])?.map((img) => img.imageUrl) ||
        ((item.image as { imageUrl: string })?.imageUrl
          ? [(item.image as { imageUrl: string }).imageUrl]
          : []),
      ebayReferencePrice: price,
      eproloPrice: null,
      eproloUrl: null,
      suggestedSellingPrice,
      margin: null,
      marginPercent: null,
      categoryId,
      categoryName: ((item.categories as { categoryName: string }[])?.[0]?.categoryName) ?? "",
      soldCount,
      condition,
      sourceUrl: item.itemWebUrl as string,
      status: "pending",
      description: "",
      stock: defaultStock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ref = db.collection(COLLECTIONS.QUEUE).doc();
    batch.set(ref, product);
    added++;
  }

  await batch.commit();
  return added;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { keywords, limit = 30, autoSearch = false } = body;

    const settingsDoc = await db.collection(COLLECTIONS.SETTINGS).doc("main").get();
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(settingsDoc.exists ? settingsDoc.data() : {}),
    } as Settings;

    let totalAdded = 0;

    if (autoSearch) {
      for (const kw of WINNING_KEYWORDS) {
        try {
          const result = await searchProducts(kw, 10);
          const items = result.itemSummaries || [];
          const added = await processItems(items, settings);
          totalAdded += added;
          await new Promise((r) => setTimeout(r, 300));
        } catch {
          // skip failed keyword, continue with next
        }
      }
    } else {
      if (!keywords) {
        return NextResponse.json({ error: "keywords required" }, { status: 400 });
      }
      const result = await searchProducts(keywords, limit);
      const items = result.itemSummaries || [];
      totalAdded = await processItems(items, settings);
    }

    return NextResponse.json({ success: true, added: totalAdded });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}