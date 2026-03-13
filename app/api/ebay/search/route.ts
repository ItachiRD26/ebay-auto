import { NextRequest, NextResponse } from "next/server";
import { searchProducts, getUserToken } from "@/lib/ebay";
import { db, COLLECTIONS } from "@/lib/firebase";
import { QueueProduct } from "@/types";

// ─── Dropshipping config ──────────────────────────────────────────────────────
const CONFIG = {
  MIN_PRICE:          20,    // min eBay reference listing price
  MAX_PRICE:          250,   // max eBay reference listing price
  MIN_SOLD_TOTAL:     5,     // min total sales (all time) on reference listing
  MIN_SOLD_30D:       3,     // min estimated sales in last 30 days (activity filter)
  EPROLO_SHIP_LOW:    7,     // Eprolo min shipping cost ($)
  EPROLO_SHIP_HIGH:   15,    // Eprolo max shipping cost ($)
  EPROLO_SHIP_AVG:    10,    // Eprolo avg shipping — used when no Eprolo price yet
  STOCK:              1,
};

// ─── Keyword list for auto-search ────────────────────────────────────────────
const AUTO_KEYWORDS = [
  // COCINA VIRAL / UTIL
  "kitchen gadget","slicer","chopper","cutter","peeler","grater",
  "strainer","colander","opener","dispenser","oil sprayer",
  "food storage","lunch box","meal prep","silicone lid",
  "air fryer accessory","sink organizer","drying rack",

  // LIMPIEZA TOP VENTAS
  "cleaning brush","electric scrubber","spin brush","dust remover",
  "lint remover","pet hair remover","window cleaner","squeegee",
  "microfiber","mop head","magic sponge","drain cleaner",

  // BAÑO
  "shower caddy","soap holder","toothbrush holder","towel rack",
  "bath mat","non slip mat","toilet organizer","dispenser set",

  // AUTO
  "car organizer","seat gap filler","car hook","phone mount",
  "car trash can","car storage","sunshade","steering cover",

  // TECH ACCESORIOS GENERICOS
  "phone stand","tablet stand","cable organizer","charging dock",
  "desk organizer","laptop stand","mouse pad","led strip",

  // VIAJE / UTILIDAD
  "travel organizer","packing cube","compression bag",
  "toiletry bag","passport holder","luggage tag",

  // MASCOTAS (MUY BUEN NICHO)
  "pet feeder","pet water bottle","dog toy","cat toy",
  "pet grooming","fur remover","pet bed","pet bowl",

  // DECORACION SIMPLE
  "wall decor","floating shelf","plant hanger","planter",
  "vase","led light","night light","ambient light",

  // TRENDY / VIRAL PALABRAS MAGICAS
  "multi function","adjustable","portable","reusable",
  "self adhesive","automatic","smart","mini","compact"
];

const EXCLUDED_KEYWORDS: string[] = [
  // ── Major brands ──────────────────────────────────────────────────────────
  "iphone","samsung galaxy","apple watch","airpods","macbook","ipad",
  "playstation","xbox","nintendo switch","nvidia","radeon",
  "nike","adidas","gucci","louis vuitton","supreme","yeezy","jordan","off-white",
  "balenciaga","versace","prada","dior","burberry","chanel","hermes","fendi",
  "lululemon","north face","under armour","new balance","reebok","vans","converse",
  "timberland","owala","stanley cup","hydro flask","yeti","contigo","camelbak",
  "ralph lauren","lacoste","tommy hilfiger","calvin klein","hugo boss",
  "michael kors","coach","kate spade","marc jacobs","victoria secret",
  "lego","barbie","disney","marvel","pokemon","naruto","one piece","dragon ball",
  "rolex","omega watch","cartier","tiffany",
  // ── Sexual / adult ────────────────────────────────────────────────────────
  "dildo","vibrator","sex toy","anal","butt plug","penis enlargement",
  "male enhancement","adult toy","erection","cock ring","chastity",
  "penis pump","penile","erectile","extender penis",
];

// Auto-generated from EXCLUDED_KEYWORDS — checks title for any brand mention

function isBanned(title: string): boolean {
  const t = title.toLowerCase();
  return EXCLUDED_KEYWORDS.some((kw) => t.includes(kw.toLowerCase()));
}

function extractNumericId(browseItemId: string): string {
  const parts = browseItemId.split("|");
  return parts.length >= 2 ? parts[1] : browseItemId;
}

// ─── Shipping cost from Browse API item summary ───────────────────────────────
// Returns 0 for FREE shipping, otherwise the actual cost.
function getShippingCost(item: Record<string, unknown>): number {
  const options = item.shippingOptions as Array<{
    shippingCostType?: string;
    shippingCost?: { value?: string };
  }> | undefined;

  if (!options || options.length === 0) return 0;

  const first = options[0];
  // FREE shipping variants
  if (
    first.shippingCostType === "FREE" ||
    first.shippingCost?.value === "0.0" ||
    first.shippingCost?.value === "0.00" ||
    first.shippingCost?.value === "0"
  ) return 0;

  return parseFloat(first.shippingCost?.value ?? "0") || 0;
}

// ─── Smart pricing engine ─────────────────────────────────────────────────────
//
// Context:
//   - We are looking at a Chinese seller's eBay listing as our market reference.
//   - That listing has a price + optional shipping cost (totalMarketCost = what the
//     buyer actually pays).
//   - We will list the SAME product at FREE SHIPPING to be competitive.
//   - Our cost = eproloProductCost (unknown until Eprolo lookup) + eproloShipping ($7-$15).
//
// Goal: suggest a listing price that is competitive AND profitable.
//
// Strategy:
//   1. totalMarketCost = refPrice + refShipping  (the real market benchmark)
//   2. suggestedPrice  = totalMarketCost * competitiveFactor
//      - We use 0.97 (3% below market) to rank higher in eBay search.
//      - If totalMarketCost is already very low, we cap at a floor that ensures
//        we at least cover average Eprolo shipping ($10).
//   3. We also store priceFloor = refPrice + EPROLO_SHIP_AVG so that when the
//      Eprolo product price is fetched later, the UI can warn if we'd be at a loss.
//
interface PricingResult {
  ebayRefPrice:          number;  // raw listing price of the reference item
  ebayShippingCost:      number;  // shipping the reference seller charges (0 = free)
  totalMarketCost:       number;  // refPrice + refShipping = true buyer cost
  suggestedSellingPrice: number;  // our recommended listing price (FREE shipping)
  priceFloor:            number;  // minimum we should charge to cover Eprolo shipping
}

function calcPricing(item: Record<string, unknown>): PricingResult {
  const ebayRefPrice     = parseFloat((item.price as { value: string })?.value ?? "0");
  const ebayShippingCost = getShippingCost(item);
  const totalMarketCost  = ebayRefPrice + ebayShippingCost;

  // 6% markup over total market cost (covers eBay fees + margin)
  const suggestedSellingPrice = parseFloat((totalMarketCost * 1.06).toFixed(2));
  const priceFloor = CONFIG.EPROLO_SHIP_AVG + 2;
  return { ebayRefPrice, ebayShippingCost, totalMarketCost, suggestedSellingPrice, priceFloor };
}

// ─── Trading API + 30-day sales estimator ────────────────────────────────────
//
// eBay's public APIs don't expose "sold in last 30 days" directly.
// We approximate it using StartTime + QuantitySold from Trading API GetItem.
//
// The key insight: older listings accumulate sales over time, making raw
// velocity (total/months) an overestimate of CURRENT demand.
// We apply a decay factor for old listings to be conservative:
//
//   listing age   | decay factor | reasoning
//   < 90 days     | 1.00         | velocity IS recent, very reliable
//   90-180 days   | 0.80         | slight slowdown typical after initial burst
//   180-365 days  | 0.65         | many products peak early then plateau
//   1-2 years     | 0.50         | half-life assumption for commodity products
//   2+ years      | 0.35         | mostly long-tail residual sales
//
// estimatedSold30d = (soldCount / daysActive) * 30 * decayFactor
//
interface TradingItemData {
  soldCount:        number;
  estimatedSold30d: number;  // our best estimate of sales in last 30 days
  listingAgeDays:   number;
  shipFromCountry:  string | null;
}

let cachedUserToken: string | null = null;
let tokenFetchedAt = 0;

async function getItemDataViaTradingAPI(numericItemId: string): Promise<TradingItemData> {
  const empty: TradingItemData = { soldCount: 0, estimatedSold30d: 0, listingAgeDays: 0, shipFromCountry: null };

  try {
    if (!cachedUserToken || Date.now() - tokenFetchedAt > 60_000) {
      cachedUserToken = await getUserToken();
      tokenFetchedAt = Date.now();
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${cachedUserToken}</eBayAuthToken></RequesterCredentials>
  <ItemID>${numericItemId}</ItemID>
  <DetailLevel>ItemReturnDescription</DetailLevel>
</GetItemRequest>`;

    const res = await fetch("https://api.ebay.com/ws/api.dll", {
      method: "POST",
      headers: {
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetItem",
        "Content-Type": "text/xml",
      },
      body: xml,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`   [Trading] HTTP ${res.status} for ${numericItemId}`);
      return empty;
    }

    const text = await res.text();

    if (text.includes("<Ack>Failure</Ack>")) {
      const errMatch = text.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
      console.warn(`   [Trading] Error ${numericItemId}: ${errMatch?.[1] ?? "unknown"}`);
      return empty;
    }

    // ── QuantitySold ──────────────────────────────────────────────────────────
    const soldMatch = text.match(/<QuantitySold>(\d+)<\/QuantitySold>/);
    const soldCount = soldMatch ? parseInt(soldMatch[1], 10) : 0;

    // ── StartTime → listing age → 30-day estimate ─────────────────────────────
    const startMatch = text.match(/<StartTime>(.*?)<\/StartTime>/);
    let estimatedSold30d = soldCount; // fallback: no date → treat as brand new
    let listingAgeDays   = 0;

    if (startMatch) {
      const startDate    = new Date(startMatch[1]);
      listingAgeDays     = Math.max(1, (Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      const soldPerDay   = soldCount / listingAgeDays;

      // Decay factor: conservative estimate of current demand relative to average
      let decay = 1.0;
      if      (listingAgeDays > 730) decay = 0.35;
      else if (listingAgeDays > 365) decay = 0.50;
      else if (listingAgeDays > 180) decay = 0.65;
      else if (listingAgeDays > 90)  decay = 0.80;
      // < 90 days: decay = 1.0 (velocity is fresh and reliable)

      estimatedSold30d = Math.round(soldPerDay * 30 * decay);
    }

    // ── Country ───────────────────────────────────────────────────────────────
    const countryMatch   = text.match(/<Country>(.*?)<\/Country>/);
    const shipFromCountry = countryMatch ? countryMatch[1].trim() : null;

    return { soldCount, estimatedSold30d, listingAgeDays, shipFromCountry };
  } catch (e) {
    console.warn(`   [Trading] Exception ${numericItemId}:`, e);
    return empty;
  }
}

// ─── Country check helper ─────────────────────────────────────────────────────
function isChina(country: string | null | undefined): boolean {
  if (!country) return false;
  return ["CN", "HK", "TW"].includes(country.toUpperCase());
}

function notChina(country: string | null | undefined): boolean {
  if (!country || !country.trim()) return false; // unknown = don't block
  return !isChina(country);
}

// ─── Core: process one item and add to queue if it passes all filters ─────────
async function processItem(
  item: Record<string, unknown>,
  label: string,
): Promise<string | false> {
  const title      = (item.title as string) ?? "";
  const itemId     = item.itemId as string;
  const numericId  = extractNumericId(itemId);
  const itemUrl    = item.itemWebUrl as string;
  const categoryId = ((item.categories as { categoryId: string }[])?.[0]?.categoryId) ?? "";
  const catName    = ((item.categories as { categoryName: string }[])?.[0]?.categoryName) ?? "";

  // ── 1. Basic filters ────────────────────────────────────────────────────────
  const pricing = calcPricing(item);

  if (pricing.ebayRefPrice < CONFIG.MIN_PRICE || pricing.ebayRefPrice > CONFIG.MAX_PRICE) {
    console.log(`   SKIP [precio] "${title.slice(0,50)}" $${pricing.ebayRefPrice}`);
    return false;
  }
  if (isBanned(title)) {
    console.log(`   SKIP [banned] "${title.slice(0,50)}"`);
    return false;
  }

  // ── 2. China origin check (Browse API summary) ──────────────────────────────
  const summaryCountry = (item.itemLocation as { country?: string })?.country ?? "";
  if (notChina(summaryCountry)) {
    console.log(`   SKIP [pais] "${title.slice(0,50)}" — ${summaryCountry}`);
    return false;
  }

  // ── 3. Trading API: sales data + country confirmation ──────────────────────
  const td = await getItemDataViaTradingAPI(numericId);

  // Confirm China origin via Trading API
  if (notChina(td.shipFromCountry)) {
    console.log(`   SKIP [pais-trading] "${title.slice(0,50)}" — ${td.shipFromCountry}`);
    return false;
  }

  // ── 4. Sales filters ────────────────────────────────────────────────────────
  const ageLabel = td.listingAgeDays < 90 ? "nuevo" :
                   td.listingAgeDays < 365 ? `${Math.round(td.listingAgeDays/30)}m` :
                   `${(td.listingAgeDays/365).toFixed(1)}a`;

  console.log(`\n   🔎 "${title.slice(0,60)}"`);
  console.log(`      Precio: $${pricing.ebayRefPrice} + $${pricing.ebayShippingCost} envio = $${pricing.totalMarketCost} mercado`);
  console.log(`      Ventas: ${td.soldCount} total | ~${td.estimatedSold30d} est/30d | listing: ${ageLabel} | ID:${numericId}`);

  if (td.soldCount < CONFIG.MIN_SOLD_TOTAL) {
    console.log(`      ❌ ${td.soldCount} ventas totales < min ${CONFIG.MIN_SOLD_TOTAL}`);
    return false;
  }

  if (td.estimatedSold30d < CONFIG.MIN_SOLD_30D) {
    console.log(`      ❌ ~${td.estimatedSold30d} est/30d < min ${CONFIG.MIN_SOLD_30D} — producto lento`);
    return false;
  }

  // ── 5. Duplicate check ──────────────────────────────────────────────────────
  const dup = await db.collection(COLLECTIONS.QUEUE).where("ebayItemId", "==", numericId).limit(1).get();
  if (!dup.empty) {
    console.log(`      ⚠️  DUPLICADO (itemId)`);
    return false;
  }

  // Also check by normalized title (first 60 chars) to catch same product with diff ID
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim();
  const titleDup = await db.collection(COLLECTIONS.QUEUE)
    .where("normalizedTitle", "==", normalizedTitle).limit(1).get();
  if (!titleDup.empty) {
    console.log(`      ⚠️  DUPLICADO (título: "${normalizedTitle.slice(0, 40)}")`);
    return false;
  }

  // ── 6. Build and save queue product ─────────────────────────────────────────
  console.log(`      ✅ ACEPTADO | mercado $${pricing.totalMarketCost} | listamos $${pricing.suggestedSellingPrice} | ~${td.estimatedSold30d}/30d`);

  const images =
    (item.thumbnailImages as { imageUrl: string }[])?.map((i) => i.imageUrl) ||
    ((item.image as { imageUrl: string })?.imageUrl
      ? [(item.image as { imageUrl: string }).imageUrl]
      : []);

  const queueProduct: Omit<QueueProduct, "id"> = {
    ebayItemId:            numericId,  // numeric only — needed for Trading API GetItem
    title,
    normalizedTitle:       title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim(),
    images,
    ebayReferencePrice:    pricing.ebayRefPrice,
    ebayShippingCost:      pricing.ebayShippingCost,
    totalMarketCost:       pricing.totalMarketCost,
    eproloPrice:           null,
    eproloUrl:             null,
    suggestedSellingPrice: pricing.suggestedSellingPrice,
    margin:                null,
    marginPercent:         null,
    categoryId,
    categoryName:          catName,
    soldCount:             td.soldCount,
    estimatedSold30d:      td.estimatedSold30d,
    listingAgeDays:        Math.round(td.listingAgeDays),
    condition:             (item.condition as string) ?? "New",
    sourceUrl:             itemUrl,
    status:                "approved",
    description:           "",
    stock:                 CONFIG.STOCK,
    createdAt:             Date.now(),
    updatedAt:             Date.now(),
  };

  const docRef = db.collection(COLLECTIONS.QUEUE).doc();
  await docRef.set({ ...queueProduct, status: "approved" });
  return docRef.id; // return ID for auto-publish
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET() {
  return NextResponse.json({ keywords: AUTO_KEYWORDS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { keywords, limit = 50, autoSearch = false } = body;

    let totalAdded = 0;

    // Single keyword search (frontend loops for auto-search)
    const kw = keywords || "";
    if (!kw) return NextResponse.json({ error: "keywords required" }, { status: 400 });

    console.log(`\n🔍 Búsqueda: "${kw}"`);
    let result: { itemSummaries?: unknown[] };
    try {
      result = await searchProducts(kw, 20);
    } catch (searchErr) {
      const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
      console.warn(`[search] ⚠️ Failed "${kw}":`, msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const items = (result.itemSummaries ?? []) as Record<string, unknown>[];
    console.log(`   ${items.length} items`);
    let totalReviewed = 0;
    let totalSkipped = 0;

    for (const item of items) {
      totalReviewed++;
      const productId = await processItem(item, kw);
      if (productId) {
        totalAdded++; // saved as "approved" — waits for manual review
      } else {
        totalSkipped++;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    return NextResponse.json({ success: true, added: totalAdded, published: 0, reviewed: totalReviewed, skipped: totalSkipped });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}