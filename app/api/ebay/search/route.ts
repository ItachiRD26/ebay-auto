import { NextRequest, NextResponse } from "next/server";
import { searchProducts, searchProductsMultiPage, getUserToken, getAppToken } from "@/lib/ebay";
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
  STOCK:              10,   // default — overridden by userSettings.defaultStock per-user
  ITEMS_PER_SEARCH:   200,   // Browse API max per request
  PAGES_PER_SEARCH:   5,     // parallel pages = 5×200 = 1000 items per keyword
};

// ─── Keywords — loaded dynamically from Firestore, fallback to defaults ─────────
import { DEFAULT_AUTO_KEYWORDS, DEFAULT_EXCLUDED_KEYWORDS } from "@/api/ebay/keywords/route";
import { queueCol, settingsDoc, seenCol } from "@/lib/firebase";

// 60-second in-memory cache so we don't hit Firestore on every item
const _kwCache = new Map<string, { auto: string[]; excluded: string[]; fetchedAt: number }>();

async function getUserSettings(userId: string): Promise<{ minSoldCount: number; minSold30d: number; defaultStock: number }> {
  try {
    const snap = await settingsDoc(userId, "main").get();
    const data = snap.data() as Record<string, number> | undefined;
    return {
      minSoldCount:  data?.minSoldCount  ?? 5,
      minSold30d:    data?.minSold30d    ?? 3,
      defaultStock:  data?.defaultStock  ?? 10,
    };
  } catch { return { minSoldCount: 5, minSold30d: 3, defaultStock: 10 }; }
}

async function getKeywords(userId: string): Promise<{ auto: string[]; excluded: string[] }> {
  const cached = _kwCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < 60_000) return cached;
  try {
    const snap = await settingsDoc(userId, "keywords").get();
    const data = snap.exists ? snap.data() : {};
    const entry = {
      auto:     data?.autoKeywords?.length     ? data.autoKeywords     : DEFAULT_AUTO_KEYWORDS,
      excluded: data?.excludedKeywords?.length ? data.excludedKeywords : DEFAULT_EXCLUDED_KEYWORDS,
      fetchedAt: Date.now(),
    };
    _kwCache.set(userId, entry);
    return entry;
  } catch {
    const fallback = { auto: DEFAULT_AUTO_KEYWORDS, excluded: DEFAULT_EXCLUDED_KEYWORDS, fetchedAt: Date.now() };
    _kwCache.set(userId, fallback);
    return fallback;
  }
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
      // Floor: if a listing has meaningful total sales and is still active,
      // give it at least 1 est/30d so it's not unfairly rejected.
      // A product with 10+ total sales over years is a steady seller.
      if (estimatedSold30d === 0 && soldCount >= 10) estimatedSold30d = 1;
      if (estimatedSold30d === 0 && soldCount >= 5 && listingAgeDays < 730) estimatedSold30d = 1;
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

// ─── Phase 1: Fast pre-filter using only Browse summary data (0 extra API calls) ──
// Returns false immediately for obvious rejects.
// Only items that pass go to Phase 2 (Insights API).
function preFilterItem(
  item: Record<string, unknown>,
  excluded: string[],
  seenIds: Set<string>,
  minPrice: number,
  maxPrice: number,
): boolean {
  const title     = (item.title as string) ?? "";
  const itemId    = item.itemId as string;
  const numericId = extractNumericId(itemId);

  // Price
  const pricing = calcPricing(item);
  if (pricing.ebayRefPrice < minPrice || pricing.ebayRefPrice > maxPrice) return false;

  // Banned keywords in title
  if (isBannedWith(title, excluded)) return false;

  // Country from summary (CN filter already applied in Browse API query,
  // but some items slip through with HK/TW — check just in case)
  const summaryCountry = (item.itemLocation as { country?: string })?.country ?? "";
  if (notChina(summaryCountry)) return false;

  // Condition
  const conditionId = (item.conditionId as string) ?? "";
  if (conditionId && !["1000", "1500"].includes(conditionId)) return false;

  // Shipping cost sanity — block $30+ shipping (industrial tools, heavy items)
  const shippingOpts = item.shippingOptions as Array<{ shippingCost?: { value?: string } }> | undefined;
  const shippingVal  = parseFloat(shippingOpts?.[0]?.shippingCost?.value ?? "0") || 0;
  if (shippingVal > 30) return false;

  // Already seen
  if (seenIds.has(numericId)) return false;

  return true;
}

// ─── Phase 2: Deep evaluation for candidates (Insights API → Trading API fallback) ──
async function processCandidate(
  item: Record<string, unknown>,
  label: string,
  storeId: string,
  userId: string,
  minSoldTotal: number,
  minSold30d: number,
  defaultStock: number,
  appToken: string,
): Promise<string | false> {
  const title      = (item.title as string) ?? "";
  const itemId     = item.itemId as string;
  const numericId  = extractNumericId(itemId);
  const itemUrl    = item.itemWebUrl as string;
  const categoryId = ((item.categories as { categoryId: string }[])?.[0]?.categoryId) ?? "";
  const catName    = ((item.categories as { categoryName: string }[])?.[0]?.categoryName) ?? "";
  const pricing    = calcPricing(item);

  // ── Sales data: Insights API first, Trading API fallback ──────────────────
  let td = await getSoldDataFromInsights(numericId, appToken);
  if (!td) {
    // Insights API failed or returned nothing — fall back to Trading API
    td = await getItemDataViaTradingAPI(numericId, storeId);
  }

  // Confirm country via Trading API data
  if (notChina(td.shipFromCountry)) {
    skipProgress(userId, "country", td.shipFromCountry ?? "?");
    return false;
  }

  const ageLabel = td.listingAgeDays < 90  ? "nuevo" :
                   td.listingAgeDays < 365  ? `${Math.round(td.listingAgeDays/30)}m` :
                   `${(td.listingAgeDays/365).toFixed(1)}a`;

  console.log(`\n   🔎 "${title.slice(0, 60)}"`);
  console.log(`      Precio: $${pricing.ebayRefPrice} + $${pricing.ebayShippingCost} envio = $${pricing.totalMarketCost} mercado`);
  console.log(`      Ventas: ${td.soldCount} total | ~${td.estimatedSold30d} est/30d | listing: ${ageLabel} | ID:${numericId}`);

  if (td.soldCount < minSoldTotal) {
    skipProgress(userId, "sales", `${td.soldCount} sold < ${minSoldTotal} min`);
    return false;
  }
  if (td.estimatedSold30d < minSold30d) {
    skipProgress(userId, "sales", `~${td.estimatedSold30d}/30d < ${minSold30d} min`);
    return false;
  }

  // ── Queue duplicate check ─────────────────────────────────────────────────
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim();
  const dup = await queueCol(userId).where("ebayItemId", "==", numericId).limit(1).get();
  if (!dup.empty) { skipProgress(userId, "duplicate"); return false; }
  const titleDup = await queueCol(userId).where("normalizedTitle", "==", normalizedTitle).limit(1).get();
  if (!titleDup.empty) { skipProgress(userId, "duplicate"); return false; }

  // ── Accept — save to queue ────────────────────────────────────────────────
  console.log(`      ✅ ACEPTADO | mercado $${pricing.totalMarketCost} | listamos $${pricing.suggestedSellingPrice} | ~${td.estimatedSold30d}/30d`);

  const images =
    (item.thumbnailImages as { imageUrl: string }[])?.map((i) => i.imageUrl) ||
    ((item.image as { imageUrl: string })?.imageUrl ? [(item.image as { imageUrl: string }).imageUrl] : []);

  const queueProduct: Omit<import("@/types").QueueProduct, "id"> = {
    userId, storeId,
    ebayItemId:            numericId,
    title,
    normalizedTitle,
    images,
    ebayReferencePrice:    pricing.ebayRefPrice,
    ebayShippingCost:      pricing.ebayShippingCost,
    totalMarketCost:       pricing.totalMarketCost,
    refPriceMin:           pricing.ebayRefPrice,
    refPriceMax:           pricing.ebayRefPrice,
    eproloPrice:           null,
    eproloUrl:             null,
    suggestedSellingPrice: pricing.suggestedSellingPrice,
    markupPercent:         6,
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
    stock:                 defaultStock,
    createdAt:             Date.now(),
    updatedAt:             Date.now(),
    expiresAt:             Date.now() + 24 * 60 * 60 * 1000 as unknown as Date,
  };

  const docRef = queueCol(userId).doc();
  await docRef.set({ ...queueProduct, status: "approved" });
  return docRef.id;
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

    if (_tokenExpiredStoreId === storeId) {
      console.warn(`[search] ⛔ Aborting — token expired for store ${storeId}`);
      return NextResponse.json({ error: "TOKEN_EXPIRED", message: "eBay token expired — please reconnect your store", storeId }, { status: 401 });
    }
    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

    const kw = keywords || "";
    if (!kw) return NextResponse.json({ error: "keywords required" }, { status: 400 });

    const kws          = await getKeywords(userId);
    const userSettings = await getUserSettings(userId);
    const appToken     = await getAppToken();

    // ── Fetch 1000 items in parallel (5 × 200) ─────────────────────────────
    console.log(`\n🔍 Búsqueda: "${kw}" — fetching up to ${CONFIG.PAGES_PER_SEARCH * 200} items`);
    let allItems: Record<string, unknown>[];
    try {
      const result = await searchProductsMultiPage(kw, CONFIG.PAGES_PER_SEARCH, userId);
      allItems = result.itemSummaries;
    } catch (searchErr) {
      const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
      console.warn(`[search] ⚠️ Failed "${kw}":`, msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    console.log(`   ${allItems.length} items fetched`);

    // ── Phase 1: Load seen_items IDs into memory (1 Firestore query) ────────
    // Much cheaper than 1 query per item. Covers all items in one shot.
    const seenSnap = await seenCol(userId).select().get();  // select() = IDs only, no data
    const seenIds  = new Set(seenSnap.docs.map(d => d.id));
    console.log(`   ${seenIds.size} items already seen (loaded in 1 query)`);

    // Phase 1 pre-filter — pure Browse data, 0 extra API calls
    const candidates = allItems.filter(item =>
      preFilterItem(item, kws.excluded, seenIds, CONFIG.MIN_PRICE, CONFIG.MAX_PRICE)
    );
    const phase1Rejected = allItems.length - candidates.length;
    console.log(`   Phase 1: ${candidates.length} candidates (rejected ${phase1Rejected} without API calls)`);

    // ── Phase 2: Deep evaluation for candidates only ─────────────────────────
    // Progress shows Phase 2 candidates only — Phase 1 is instant so no point showing it
    resetProgress(userId, candidates.length);
    updateProgress(userId, { keyword: kw, reviewed: 0, passed: 0 });

    let totalAdded    = 0;
    let totalReviewed = 0;

    for (const item of candidates) {
      totalReviewed++;
      const productId = await processCandidate(
        item, kw, storeId, userId,
        userSettings.minSoldCount, userSettings.minSold30d, userSettings.defaultStock,
        appToken,
      );
      if (productId) totalAdded++;

      updateProgress(userId, { reviewed: totalReviewed, passed: totalAdded });
      await new Promise(r => setTimeout(r, 200));
    }

    endProgress(userId);

    console.log(`\n✅ "${kw}" — revisados ${allItems.length} | candidatos ${candidates.length} | añadidos ${totalAdded}`);
    return NextResponse.json({
      success: true,
      added:      totalAdded,
      published:  0,
      reviewed:   allItems.length,
      candidates: candidates.length,
      skipped:    allItems.length - totalAdded,
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}