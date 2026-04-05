import { NextRequest, NextResponse } from "next/server";
import { searchProducts, getUserToken, getAppToken } from "@/lib/ebay";
import { QueueProduct } from "@/types";
import { resetProgress, updateProgress, endProgress, skipProgress } from "@/lib/search-progress";

// ─── Dropshipping config ──────────────────────────────────────────────────────
const CONFIG = {
  MIN_PRICE:          25,    // raised: cheap items rarely profitable after fees
  MAX_PRICE:          150,   // lowered: most viral CN products are $25-150
  MIN_SOLD_TOTAL:     5,     // min total sales — enough to validate demand
  MIN_SOLD_30D:       1,     // lowered: 1 sale/month is enough signal
  EPROLO_SHIP_LOW:    7,
  EPROLO_SHIP_HIGH:   15,
  EPROLO_SHIP_AVG:    10,
  STOCK:              1,
  ITEMS_PER_SEARCH:   200,   // Browse API max per request
};

// ─── Keywords — loaded dynamically from Firestore, fallback to defaults ─────────
import { DEFAULT_AUTO_KEYWORDS, DEFAULT_EXCLUDED_KEYWORDS } from "@/api/ebay/keywords/route";
import { queueCol, settingsDoc, seenCol } from "@/lib/firebase";

// 60-second in-memory cache so we don't hit Firestore on every item
let _kwCache: { auto: string[]; excluded: string[]; fetchedAt: number } | null = null;

async function getUserSettings(userId: string): Promise<{ minSoldCount: number; minSold30d: number }> {
  try {
    const snap = await settingsDoc(userId, "main").get();
    const data = snap.data() as Record<string, number> | undefined;
    return { minSoldCount: data?.minSoldCount ?? 5, minSold30d: data?.minSold30d ?? 3 };
  } catch { return { minSoldCount: 5, minSold30d: 3 }; }
}

async function getKeywords(userId: string): Promise<{ auto: string[]; excluded: string[] }> {
  if (_kwCache && Date.now() - _kwCache.fetchedAt < 60_000) return _kwCache;
  try {
    const snap = await settingsDoc(userId, "keywords").get();
    const data = snap.exists ? snap.data() : {};
    _kwCache = {
      auto:     data?.autoKeywords?.length     ? data.autoKeywords     : DEFAULT_AUTO_KEYWORDS,
      excluded: data?.excludedKeywords?.length ? data.excludedKeywords : DEFAULT_EXCLUDED_KEYWORDS,
      fetchedAt: Date.now(),
    };
  } catch {
    _kwCache = { auto: DEFAULT_AUTO_KEYWORDS, excluded: DEFAULT_EXCLUDED_KEYWORDS, fetchedAt: Date.now() };
  }
  return _kwCache;
}

function isBannedWith(title: string, excluded: string[]): boolean {
  const t = title.toLowerCase();
  return excluded.some((kw) => t.includes(kw.toLowerCase()));
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
  // For variation products, item.price = the cheapest variant ("starting from" price)
  // priceRange gives us min and max — we use min as the base, which is item.price
  const priceRange    = item.priceRange as { minimum?: { value: string }; maximum?: { value: string } } | undefined;
  const rawPrice      = (item.price as { value: string })?.value ?? "0";
  const minRefPrice   = parseFloat(priceRange?.minimum?.value ?? rawPrice);
  const maxRefPrice   = parseFloat(priceRange?.maximum?.value ?? rawPrice);

  const ebayRefPrice     = minRefPrice;  // use MIN variant as base for filter + pricing
  const ebayShippingCost = getShippingCost(item);
  const totalMarketCost  = ebayRefPrice + ebayShippingCost;

  // 6% markup over min variant price — each variant scales proportionally in publish.ts
  const suggestedSellingPrice = parseFloat((totalMarketCost * 1.06).toFixed(2));
  const priceFloor = CONFIG.EPROLO_SHIP_AVG + 2;

  if (maxRefPrice > minRefPrice) {
    console.log(`   [pricing] Variation product: min=$${minRefPrice} max=$${maxRefPrice} → base=$${suggestedSellingPrice}`);
  }

  return { ebayRefPrice, ebayShippingCost, totalMarketCost, suggestedSellingPrice, priceFloor };
}

// ─── Marketplace Insights API — real 30-day sold data ───────────────────────
//
// Uses buy.marketplaceinsight item_sales/search which returns SOLD listings
// with lastSoldDate, soldQuantity, and seller info — no Trading API needed.
//
// This replaces Trading API GetItem for sales validation, saving ~60% of
// Trading API quota. Falls back to GetItem if Insights API fails.
//
interface TradingItemData {
  soldCount:        number;
  estimatedSold30d: number;
  listingAgeDays:   number;
  shipFromCountry:  string | null;
}

// Cache for Marketplace Insights results to avoid duplicate calls
const _insightsCache = new Map<string, { data: TradingItemData; fetchedAt: number }>();
const INSIGHTS_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

const _tokenCache: Record<string, { token: string; fetchedAt: number }> = {};

// Token expiry signal
let _tokenExpiredStoreId: string | null = null;
let _tokenExpiredAt: number = 0;

export function getTokenExpiredStore() { return _tokenExpiredStoreId; }
export function clearTokenExpired()   { _tokenExpiredStoreId = null; _tokenExpiredAt = 0; }

// ─── Marketplace Insights API call ───────────────────────────────────────────
async function getSoldDataFromInsights(itemId: string, appToken: string): Promise<TradingItemData | null> {
  const cached = _insightsCache.get(itemId);
  if (cached && Date.now() - cached.fetchedAt < INSIGHTS_CACHE_TTL) return cached.data;

  try {
    const params = new URLSearchParams({
      q:           itemId,
      limit:       "1",
      fieldgroups: "ADDITIONAL_SELLER_DETAILS",
    });

    const res = await fetch(
      `https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search?${params}`,
      {
        headers: {
          Authorization:             `Bearer ${appToken}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
          "Content-Type":            "application/json",
        },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!res.ok) {
      if (res.status === 403) console.warn("[insights] 403 — API may need higher limit approval");
      return null;
    }

    const data = await res.json() as {
      itemSales?: {
        itemId?:       string;
        soldQuantity?: number;
        lastSoldDate?: string;
        seller?:       { feedbackScore?: number };
        itemLocation?: { country?: string };
      }[];
    };

    const sale = data.itemSales?.[0];
    if (!sale) return null;

    // lastSoldDate tells us when it last sold — use as proxy for recency
    const lastSold    = sale.lastSoldDate ? new Date(sale.lastSoldDate) : null;
    const daysSinceSold = lastSold ? (Date.now() - lastSold.getTime()) / 86400000 : 999;
    const soldQty     = sale.soldQuantity ?? 0;
    const country     = sale.itemLocation?.country ?? null;

    // Estimate 30d: if sold recently, assume it sells regularly
    // If last sold > 60 days ago, it's slow-moving
    const estimatedSold30d = daysSinceSold < 30  ? Math.max(1, Math.round(soldQty * 0.3)) :
                             daysSinceSold < 60  ? Math.max(1, Math.round(soldQty * 0.15)) :
                             daysSinceSold < 90  ? Math.round(soldQty * 0.08) :
                             0;

    const result: TradingItemData = {
      soldCount:        soldQty,
      estimatedSold30d,
      listingAgeDays:   daysSinceSold, // days since last sold
      shipFromCountry:  country,
    };

    _insightsCache.set(itemId, { data: result, fetchedAt: Date.now() });
    return result;

  } catch (e) {
    console.warn(`[insights] Error for ${itemId}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

async function getItemDataViaTradingAPI(numericItemId: string, storeId: string): Promise<TradingItemData> {
  const empty: TradingItemData = { soldCount: 0, estimatedSold30d: 0, listingAgeDays: 0, shipFromCountry: null };

  try {
    if (!_tokenCache[storeId] || Date.now() - _tokenCache[storeId].fetchedAt > 60_000) {
      try {
        _tokenCache[storeId] = { token: await getUserToken(storeId), fetchedAt: Date.now() };
      } catch {
        return empty;
      }
    }
    const cachedUserToken = _tokenCache[storeId].token;

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
      const errMatch   = text.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
      const errCodeMatch = text.match(/<ErrorCode>(\d+)<\/ErrorCode>/);
      const errCode    = errCodeMatch ? parseInt(errCodeMatch[1], 10) : 0;
      const errMsg     = errMatch?.[1] ?? "unknown";

      // eBay auth error codes: 931 = token invalid, 932 = token expired, 930 = auth required
      if ([930, 931, 932].includes(errCode) || errMsg.toLowerCase().includes("token") || errMsg.toLowerCase().includes("auth")) {
        console.error(`   [Trading] ⚠️ TOKEN EXPIRED/INVALID for store ${storeId}: ${errMsg}`);
        _tokenExpiredStoreId = storeId;
        _tokenExpiredAt      = Date.now();
        delete _tokenCache[storeId]; // clear cached token
      } else {
        console.warn(`   [Trading] Error ${numericItemId}: ${errMsg}`);
      }
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
  storeId: string,
  userId: string,
  excluded: string[],
  minSoldTotal: number,
  minSold30d: number,
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
    skipProgress("price", `$${pricing.ebayRefPrice}`);
    return false;
  }
  if (isBannedWith(title, excluded)) {
    skipProgress("banned", title.slice(0, 40));
    return false;
  }

  // ── 2. China origin check (Browse API summary) ──────────────────────────────
  const summaryCountry = (item.itemLocation as { country?: string })?.country ?? "";
  if (notChina(summaryCountry)) {
    skipProgress("country", summaryCountry);
    return false;
  }

  // ── 3. Quick pre-checks before expensive Trading API call ─────────────────
  // Skip if condition is clearly not new
  const conditionId = (item.conditionId as string) ?? "";
  if (conditionId && !["1000","1500"].includes(conditionId)) {
    skipProgress("condition", conditionId);
    return false;
  }

  // ── 4. Trading API: sales data + country confirmation ──────────────────────
  const td = await getItemDataViaTradingAPI(numericId, storeId);

  // Confirm China origin via Trading API
  if (notChina(td.shipFromCountry)) {
    skipProgress("country", td.shipFromCountry ?? "?");
    return false;
  }

  // ── 5. Sales filters ────────────────────────────────────────────────────────
  const ageLabel = td.listingAgeDays < 90 ? "nuevo" :
                   td.listingAgeDays < 365 ? `${Math.round(td.listingAgeDays/30)}m` :
                   `${(td.listingAgeDays/365).toFixed(1)}a`;

  console.log(`\n   🔎 "${title.slice(0,60)}"`);
  console.log(`      Precio: $${pricing.ebayRefPrice} + $${pricing.ebayShippingCost} envio = $${pricing.totalMarketCost} mercado`);
  console.log(`      Ventas: ${td.soldCount} total | ~${td.estimatedSold30d} est/30d | listing: ${ageLabel} | ID:${numericId}`);

  if (td.soldCount < minSoldTotal) {
    skipProgress("sales", `${td.soldCount} sold < ${minSoldTotal} min`);
    return false;
  }

  if (td.estimatedSold30d < minSold30d) {
    skipProgress("sales", `~${td.estimatedSold30d}/30d < ${minSold30d} min`);
    return false;
  }

  // ── 6. Duplicate check — seen_items first (fast), then queue ────────────────
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim();

  // Check seen_items (light collection — survives product deletion)
  const seenDoc = await seenCol(userId).doc(numericId).get();
  if (seenDoc.exists) {
    skipProgress("duplicate");
    return false;
  }

  // Fallback: also check queue (for items added before seen_items existed)
  const dup = await queueCol(userId).where("ebayItemId", "==", numericId).limit(1).get();
  if (!dup.empty) {
    skipProgress("duplicate");
    return false;
  }

  const titleDup = await queueCol(userId).where("normalizedTitle", "==", normalizedTitle).limit(1).get();
  if (!titleDup.empty) {
    skipProgress("duplicate");
    return false;
  }

  // ── 7. Build and save queue product ─────────────────────────────────────────
  console.log(`      ✅ ACEPTADO | mercado $${pricing.totalMarketCost} | listamos $${pricing.suggestedSellingPrice} | ~${td.estimatedSold30d}/30d`);

  const images =
    (item.thumbnailImages as { imageUrl: string }[])?.map((i) => i.imageUrl) ||
    ((item.image as { imageUrl: string })?.imageUrl
      ? [(item.image as { imageUrl: string }).imageUrl]
      : []);

  const queueProduct: Omit<QueueProduct, "id"> = {
    userId,
    storeId,
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
    expiresAt:             new Date(Date.now() + 24 * 60 * 60 * 1000),
  };

  const docRef = queueCol(userId).doc();
  await docRef.set({ ...queueProduct, status: "approved" });
  return docRef.id; // return ID for auto-publish
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const uid = new URL(req.url).searchParams.get("userId") ?? "";
  const kws = await getKeywords(uid);
  return NextResponse.json({ keywords: kws.auto, excludedKeywords: kws.excluded });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { keywords, limit = 50, autoSearch = false, storeId, userId } = body;
    if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });

    // Check if token was already detected as expired in a previous call
    if (_tokenExpiredStoreId === storeId) {
      console.warn(`[search] ⛔ Aborting — token expired for store ${storeId}`);
      return NextResponse.json({
        error: "TOKEN_EXPIRED",
        message: "eBay token expired — please reconnect your store",
        storeId,
      }, { status: 401 });
    }
    if (!userId)  return NextResponse.json({ error: "userId required" },  { status: 400 });

    let totalAdded = 0;
    const kws          = await getKeywords(userId);
    const userSettings = await getUserSettings(userId);

    // Single keyword search (frontend loops for auto-search)
    const kw = keywords || "";
    if (!kw) return NextResponse.json({ error: "keywords required" }, { status: 400 });

    console.log(`\n🔍 Búsqueda: "${kw}"`);
    let result: { itemSummaries?: unknown[] };
    try {
      result = await searchProducts(kw, CONFIG.ITEMS_PER_SEARCH);
    } catch (searchErr) {
      const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
      console.warn(`[search] ⚠️ Failed "${kw}":`, msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const items = (result.itemSummaries ?? []) as Record<string, unknown>[];
    console.log(`   ${items.length} items`);
    let totalReviewed = 0;
    let totalSkipped = 0;

    // Reset server-side progress so the polling endpoint shows live data
    resetProgress(items.length);
    updateProgress({ keyword: kw });

    for (const item of items) {
      totalReviewed++;
      const productId = await processItem(item, kw, storeId, userId, kws.excluded, userSettings.minSoldCount, userSettings.minSold30d);
      if (productId) {
        totalAdded++;
      } else {
        totalSkipped++;
      }
      // Update server-side progress after every item — frontend polls this
      updateProgress({ reviewed: totalReviewed, passed: totalAdded });
      await new Promise((r) => setTimeout(r, 200));
    }

    endProgress();

    return NextResponse.json({ success: true, added: totalAdded, published: 0, reviewed: totalReviewed, skipped: totalSkipped });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}