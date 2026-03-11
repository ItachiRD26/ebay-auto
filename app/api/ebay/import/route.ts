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

// ─── Fetch item from Browse API, trying multiple ID formats ──────────────────
// eBay Browse API can return 404 for some items when using v1|id|0 format:
//   - Item group listings (variations): need get_items_by_item_group
//   - Ended or removed listings
//   - Some legacy item formats
// We try formats in order and return the first success.
async function fetchEbayItem(
  itemId: string,
  token: string
): Promise<{ item: Record<string, unknown> | null; error: string | null }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    "Content-Type": "application/json",
  };

  // Format 1: Standard single item
  const res1 = await fetch(
    `https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`,
    { headers, signal: AbortSignal.timeout(10000) }
  );
  if (res1.ok) {
    const data = await res1.json() as Record<string, unknown>;
    return { item: data, error: null };
  }

  const errBody = await res1.text();

  // Format 2: If it's an item group (variations), fetch by group and take first item
  if (res1.status === 404 || res1.status === 400) {
    const res2 = await fetch(
      `https://api.ebay.com/buy/browse/v1/item/get_items_by_item_group?item_group_id=${itemId}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (res2.ok) {
      const groupData = await res2.json() as { items?: Record<string, unknown>[] };
      const firstItem = groupData.items?.[0];
      if (firstItem) return { item: firstItem, error: null };
    }
  }

  // Both failed
  return {
    item: null,
    error: `HTTP ${res1.status}: ${errBody.slice(0, 150)}`,
  };
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
      minPrice       = 15,
      maxPrice       = 250,   // raised — DEFAULT_SETTINGS has 150 but import should be generous
      markupPercent  = 40,
      defaultStock   = 10,
      onlyNewCondition = false, // disabled by default on manual import — user already chose these
    } = settings;

    const results = {
      added:    0,
      skipped:  0,
      filtered: 0,
      errors:   0,
      errorLog: [] as string[],   // full detail of each error
      filterLog: [] as string[],  // full detail of each filtered item
    };

    const batch = db.batch();

    for (const url of urls) {
      try {
        const itemId = extractItemId(url);
        if (!itemId) {
          const msg = `No se pudo extraer ID de: ${url}`;
          results.errors++;
          results.errorLog.push(msg);
          console.warn(`[import] ${msg}`);
          continue;
        }

        // Duplicate check
        const existing = await db
          .collection(COLLECTIONS.QUEUE)
          .where("ebayItemId", "==", itemId)
          .limit(1)
          .get();
        if (!existing.empty) {
          console.log(`[import] SKIP duplicado: ${itemId}`);
          results.skipped++;
          continue;
        }

        // Fetch item with fallback formats
        const { item, error: fetchError } = await fetchEbayItem(itemId, token);
        if (!item) {
          const msg = `ID ${itemId} — fetch falló: ${fetchError}`;
          results.errors++;
          results.errorLog.push(msg);
          console.warn(`[import] ERROR: ${msg}`);
          continue;
        }

        const price      = parseFloat((item.price as { value?: string })?.value ?? "0");
        const condition  = (item.condition as string) ?? "";
        const categoryId = (item.categories as { categoryId: string }[])?.[0]?.categoryId ?? "";
        const title      = (item.title as string) ?? "";

        console.log(`[import] ${itemId} — "${title.slice(0, 50)}" $${price} ${condition}`);

        // ── Filters ────────────────────────────────────────────────────────────
        if (price < minPrice || price > maxPrice) {
          const msg = `"${title.slice(0,50)}" — precio $${price} fuera de rango $${minPrice}-$${maxPrice}`;
          results.filtered++;
          results.filterLog.push(msg);
          console.log(`[import] FILTRADO: ${msg}`);
          continue;
        }
        if (onlyNewCondition && condition && !condition.toLowerCase().includes("new")) {
          const msg = `"${title.slice(0,50)}" — condición "${condition}" (solo New)`;
          results.filtered++;
          results.filterLog.push(msg);
          console.log(`[import] FILTRADO: ${msg}`);
          continue;
        }
        if (isBannedProduct(title, categoryId)) {
          const msg = `"${title.slice(0,50)}" — keyword/categoría bloqueada`;
          results.filtered++;
          results.filterLog.push(msg);
          console.log(`[import] FILTRADO: ${msg}`);
          continue;
        }

        // ── Pricing ────────────────────────────────────────────────────────────
        const shippingOptions = item.shippingOptions as Array<{
          shippingCostType?: string;
          shippingCost?: { value?: string };
        }> | undefined;
        const firstShipping   = shippingOptions?.[0];
        const ebayShippingCost =
          !firstShipping ||
          firstShipping.shippingCostType === "FREE" ||
          firstShipping.shippingCost?.value === "0.0" ||
          firstShipping.shippingCost?.value === "0"
            ? 0
            : parseFloat(firstShipping.shippingCost?.value ?? "0") || 0;

        const totalMarketCost        = parseFloat((price + ebayShippingCost).toFixed(2));
        const suggestedSellingPrice  = parseFloat((totalMarketCost * (1 + markupPercent / 100)).toFixed(2));

        // ── Images ─────────────────────────────────────────────────────────────
        const images: string[] = [];
        if ((item.image as { imageUrl?: string })?.imageUrl) {
          images.push((item.image as { imageUrl: string }).imageUrl);
        }
        if (item.additionalImages) {
          (item.additionalImages as { imageUrl: string }[]).forEach((img) => {
            if (!images.includes(img.imageUrl)) images.push(img.imageUrl);
          });
        }

        // ── Save ───────────────────────────────────────────────────────────────
        const product: Omit<QueueProduct, "id"> = {
          ebayItemId:            itemId,
          title,
          images,
          ebayReferencePrice:    price,
          ebayShippingCost,
          totalMarketCost,
          eproloPrice:           null,
          eproloUrl:             null,
          suggestedSellingPrice,
          margin:                null,
          marginPercent:         null,
          categoryId,
          categoryName:          (item.categories as { categoryName: string }[])?.[0]?.categoryName ?? "",
          soldCount:             (item.unitSoldCount as number) ?? 0,
          estimatedSold30d:      0,
          listingAgeDays:        0,
          condition,
          sourceUrl:             url,
          status:                "pending",
          description:           "",
          stock:                 defaultStock,
          createdAt:             Date.now(),
          updatedAt:             Date.now(),
        };

        const ref = db.collection(COLLECTIONS.QUEUE).doc();
        batch.set(ref, product);
        results.added++;
        console.log(`[import] ✅ AGREGADO: "${title.slice(0,50)}" $${price} → sugerido $${suggestedSellingPrice}`);

        await new Promise((r) => setTimeout(r, 200));

      } catch (e: unknown) {
        const msg = `Excepción inesperada: ${e instanceof Error ? e.message : String(e)}`;
        results.errors++;
        results.errorLog.push(msg);
        console.error(`[import] EXCEPCIÓN:`, e);
      }
    }

    await batch.commit();

    // Return full detail so the UI can show exactly what happened
    return NextResponse.json({
      success:   true,
      added:     results.added,
      skipped:   results.skipped,
      filtered:  results.filtered,
      errors:    results.errors,
      errorLog:  results.errorLog,
      filterLog: results.filterLog,
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[import] Fatal error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}