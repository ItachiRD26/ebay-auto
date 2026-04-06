import { NextRequest, NextResponse } from "next/server";
import { getAppToken } from "@/lib/ebay";
import { db, queueCol, settingsDoc as getSettingsDoc, DEFAULT_SETTINGS, storesCol } from "@/lib/firebase";
import { QueueProduct, Settings } from "@/types";

// ─── Config — 5× more relaxed than search ────────────────────────────────────
// The store itself is the quality signal. Individual items don't need validation.
const CONFIG = {
  MIN_PRICE:      15,    // only filter: >= $15
  MIN_SOLD:       3,     // only filter: >= 3 lifetime sales
  MARKUP_PERCENT: 6,
  STOCK:          1,
  MAX_ITEMS:      50_000, // scan up to 50k unique items across all queries
  MAX_PAGES:      50,    // kept for reference (not used directly in multi-query scanner)
};

// ─── Slim excluded keywords — only hard IP / adult / dangerous blockers ────────
const BLOCKED_IP = [
  "nike","adidas","gucci","louis vuitton","supreme","yeezy","jordan","off-white",
  "balenciaga","versace","prada","dior","burberry","chanel","hermes","fendi",
  "lululemon","north face","under armour","reebok","vans","converse","timberland",
  "ralph lauren","lacoste","tommy hilfiger","calvin klein","hugo boss",
  "michael kors","coach","kate spade","marc jacobs","rolex","omega watch","cartier",
  "iphone","samsung galaxy","apple watch","airpods","macbook","ipad",
  "playstation","xbox","nintendo switch","nvidia","radeon",
  "owala","stanley cup","hydro flask","yeti","contigo","camelbak",
  "naruto","dragon ball","one piece","demon slayer","pokemon",
  "yugioh","yu-gi-oh","magic the gathering","lego","disney","marvel","barbie",
  "mercedes","bmw","audi","porsche","ferrari","lamborghini","tesla",
  "dildo","vibrator","sex toy","anal","penis enlargement","male enhancement",
  "adult toy","cock ring","chastity","gun","firearm","ammunition","rifle","pistol",
  "replica","counterfeit","fake",
];

function isBanned(title: string, extra: string[]): boolean {
  const t = title.toLowerCase();
  return [...BLOCKED_IP, ...extra].some(kw => kw && t.includes(kw));
}

// ─── Parse seller username from any eBay URL format ──────────────────────────
export function extractSeller(input: string): string | null {
  const s = input.trim();
  const strMatch = s.match(/ebay\.com\/str\/([^/?&#\s]+)/i);
  if (strMatch) return decodeURIComponent(strMatch[1]);
  const ssnMatch = s.match(/[?&]_ssn=([^&\s]+)/i);
  if (ssnMatch) return decodeURIComponent(ssnMatch[1]);
  const usrMatch = s.match(/ebay\.com\/usr\/([^/?&#\s]+)/i);
  if (usrMatch) return decodeURIComponent(usrMatch[1]);
  if (/^[\w\-\.]+$/.test(s) && !s.includes("/")) return s;
  return null;
}

// ─── Browse API item type ─────────────────────────────────────────────────────
interface SellerItem {
  itemId:        string;
  title:         string;
  price:         number;
  shippingCost:  number;
  sold:          number;
  startTime:     string;
  categoryId:    string;
  pic:           string;
  condition:     string;
}

type BrowseSummary = {
  itemId?: string; title?: string;
  price?: { value?: string };
  shippingOptions?: Array<{ shippingCost?: { value?: string }; shippingCostType?: string }>;
  unitSoldCount?: number; itemCreationDate?: string;
  categories?: Array<{ categoryId?: string }>;
  image?: { imageUrl?: string };
  thumbnailImages?: Array<{ imageUrl?: string }>;
  condition?: string; conditionId?: string;
};

function parseBrowseItem(item: BrowseSummary): SellerItem | null {
  const itemId = item.itemId?.split("|")[1] ?? item.itemId ?? "";
  const title  = item.title ?? "";
  if (!itemId || !title) return null;
  const price        = parseFloat(item.price?.value ?? "0") || 0;
  const shipping     = item.shippingOptions?.[0];
  const shippingCost = shipping?.shippingCostType === "FREE" ? 0
    : parseFloat(shipping?.shippingCost?.value ?? "0") || 0;
  return {
    itemId, title, price, shippingCost,
    sold:       item.unitSoldCount ?? 0,
    startTime:  item.itemCreationDate ?? "",
    categoryId: item.categories?.[0]?.categoryId ?? "",
    pic:        item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? "",
    condition:  item.condition || "New",
  };
}

async function browseOnePage(
  seller: string, q: string, offset: number, appToken: string,
): Promise<{ items: SellerItem[]; total: number }> {
  const params = new URLSearchParams({
    q, limit: "200", offset: String(offset), sort: "NEWLY_LISTED",
    filter:      `sellers:{${seller}},buyingOptions:{FIXED_PRICE}`,
    fieldgroups: "EXTENDED",
  });
  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      { headers: { Authorization: `Bearer ${appToken}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
        signal: AbortSignal.timeout(20000) }
    );
    if (!res.ok) {
      console.warn(`[import-store] Browse q="${q}" offset=${offset} → ${res.status}`);
      return { items: [], total: 0 };
    }
    const data = await res.json() as { itemSummaries?: BrowseSummary[]; total?: number };
    const items = (data.itemSummaries ?? []).map(parseBrowseItem).filter((x): x is SellerItem => x !== null);
    return { items, total: data.total ?? 0 };
  } catch (e) {
    console.warn(`[import-store] browseOnePage error:`, e);
    return { items: [], total: 0 };
  }
}

// ─── Multi-query scanner — maximizes store coverage ───────────────────────────
// Problem: Browse API with a single query returns at most the top ~200 items by
// relevance, even for stores with 10k+ listings.
//
// Solution: rotate through multiple common queries. Each query returns a DIFFERENT
// subset of the seller's catalog (Browse API ranks by query relevance, so different
// terms surface different products). Deduplicate by itemId across all queries.
//
// 8 queries × up to 5,000 items each = up to 40,000 coverage points before dedup.
// In practice covers 60-80% of a store's catalog in 20-50 Browse API calls.
// 15 queries × up to 10,000 items each (Browse API hard cap) = ~150k coverage points before dedup
// In practice: ~50-80k unique items from a large store with ~400-600 Browse API calls (~8-12 min)
const SCAN_QUERIES = [
  "a",          // broadest — catches ~60% of any store
  "set",        // kits, bundles, multipacks
  "for",        // descriptive ("X for Y")
  "with",       // feature listings ("X with Y")
  "new",        // condition prefix common in titles
  "women",      // fashion / accessories
  "men",        // men's products
  "dog",        // pet supplies
  "home",       // home & kitchen
  "kids",       // children's products
  "black",      // color variant — surfaces different items
  "portable",   // gadgets, fans, chargers
  "electric",   // electronics / appliances
  "1",          // numbered products (size 1, 1-pack, etc.)
  "bag",        // bags, cases, pouches
];

async function* scanAllSellerItems(
  seller: string,
  appToken: string,
  maxItems: number,
): AsyncGenerator<SellerItem> {
  const seenIds    = new Set<string>();
  let totalYielded = 0;

  for (const q of SCAN_QUERIES) {
    if (totalYielded >= maxItems) break;

    let offset      = 0;
    let queryTotal  = Infinity;
    let pagesFetched = 0;
    const MAX_PER_QUERY = 50; // Browse API hard cap: offset max ~9,800 → 50 pages × 200 = 10,000 items per query

    while (offset < queryTotal && pagesFetched < MAX_PER_QUERY && totalYielded < maxItems) {
      const { items, total } = await browseOnePage(seller, q, offset, appToken);
      queryTotal = Math.min(total, 10000); // Browse API hard cap

      let newThisPage = 0;
      for (const item of items) {
        if (seenIds.has(item.itemId)) continue;
        seenIds.add(item.itemId);
        newThisPage++;
        totalYielded++;
        yield item;
        if (totalYielded >= maxItems) break;
      }

      console.log(
        `[import-store] q="${q}" offset=${offset} → ${items.length} items | ` +
        `+${newThisPage} new | ${seenIds.size} unique total | store total for q: ${total}`
      );

      if (items.length < 200) break; // last page for this query
      offset += 200;
      pagesFetched++;
      await new Promise(r => setTimeout(r, 150));
    }

    console.log(`[import-store] q="${q}" exhausted — ${seenIds.size} unique items so far`);
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[import-store] ✅ Full scan complete — ${seenIds.size} unique items fetched`);
}


// ─── POST /api/ebay/import-store ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      storeUrl: string;
      storeId:  string;
      userId:   string;
      status?:  "pending" | "approved";
    };

    const { storeUrl, storeId, userId } = body;
    const importStatus = body.status ?? "pending"; // default pending — user reviews before publish

    if (!storeUrl) return NextResponse.json({ error: "storeUrl requerida" }, { status: 400 });
    if (!storeId)  return NextResponse.json({ error: "storeId required" },   { status: 400 });
    if (!userId)   return NextResponse.json({ error: "userId required" },    { status: 400 });

    const seller = extractSeller(storeUrl);
    if (!seller) {
      return NextResponse.json(
        { error: "URL inválida. Pega el link de la tienda (ebay.com/str/seller) o el username directamente." },
        { status: 400 }
      );
    }

    console.log(`\n[import-store] 🏪 "${seller}" — importando, status="${importStatus}"`);

    // ── Self-import guard ───────────────────────────────────────────────────
    // Prevent importing from the user's own connected eBay stores.
    // This happens when the user accidentally pastes their own store URL.
    try {
      const userStoresSnap = await storesCol(userId).get();
      for (const storeDoc of userStoresSnap.docs) {
        const storeData = storeDoc.data() as { ebayUsername?: string; name?: string };
        const connectedUsername = (storeData.ebayUsername ?? "").toLowerCase().trim();
        if (connectedUsername && connectedUsername === seller.toLowerCase().trim()) {
          console.warn(`[import-store] 🚫 Self-import blocked: "${seller}" is the user's own connected store`);
          return NextResponse.json({
            error: `"${seller}" es tu propia tienda de eBay. Pega el link de una tienda CN diferente.`,
            selfImport: true,
          }, { status: 400 });
        }
      }
    } catch (e) {
      console.warn("[import-store] Could not verify self-import:", e);
      // Don't block — just warn and continue
    }

    // ── Load settings ───────────────────────────────────────────────────────
    const [settingsSnap, kwSnap] = await Promise.all([
      getSettingsDoc(userId, "main").get(),
      db.collection("users").doc(userId).collection("settings").doc("keywords").get(),
    ]);
    const settings    = (settingsSnap.exists ? settingsSnap.data() : DEFAULT_SETTINGS) as Settings;
    const markupPct   = settings.markupPercent ?? CONFIG.MARKUP_PERCENT;
    // Single filter: min price $15. No sold filter — unitSoldCount from Browse API
    // is unreliable (often 0/undefined even for items with real sales).
    // User reviews everything in the pending queue.
    const minPrice = 15;
    const minSold  = 0; // kept for logging only

    const userBlocked = (kwSnap.data() as { excludedKeywords?: string[] } | undefined)?.excludedKeywords ?? [];
    const extraBlocked = userBlocked.map(k => k.toLowerCase().trim()).filter(Boolean);

    // ── App token — Browse API works for ANY public seller, no user auth needed ──
    // Unlike GetSellerList (Trading API) which only returns YOUR OWN listings,
    // Browse API with sellers:{username} can fetch any public seller's listings.
    const appToken = await getAppToken();

    // ── Pre-load existing queue to avoid per-item Firestore queries ─────────
    // Batch fetch all existing itemIds + normalized titles — much faster than
    // N individual .where() calls inside the loop.
    const existingSnap = await queueCol(userId)
      .select("ebayItemId", "normalizedTitle")
      .limit(5000)
      .get();
    const existingIds    = new Set<string>(existingSnap.docs.map(d => String(d.data().ebayItemId ?? "")));
    const existingTitles = new Set<string>(existingSnap.docs.map(d => String(d.data().normalizedTitle ?? "")));

    console.log(`[import-store] Filters: price >= $${minPrice} | no sold filter (Browse API unreliable) | existing=${existingIds.size} items`);

    // ── Stream items from multi-query scanner — maximizes store coverage ──────
    // scanAllSellerItems rotates through 8 common queries, each surfacing a
    // different subset of the seller's catalog. Items are deduplicated by itemId
    // across all queries. Up to CONFIG.MAX_ITEMS unique items total.
    let checked = 0;
    let added   = 0;
    let skipped = 0;
    let firstItem = true;

    // Batch write buffer — flush every 100 items
    let batch    = db.batch();
    let batchOps = 0;

    for await (const item of scanAllSellerItems(seller, appToken, CONFIG.MAX_ITEMS)) {
      checked++;

      if (firstItem) {
        firstItem = false;
        console.log(`[import-store] First item received — seller "${seller}" is valid`);
      }

      // ── Filters: just price + IP blocklist ────────────────────────────────
      if (item.price < minPrice)              { skipped++; continue; }
      if (isBanned(item.title, extraBlocked)) { skipped++; continue; }
      if (existingIds.has(item.itemId))       { skipped++; continue; }

      const normTitle = item.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim();
      if (existingTitles.has(normTitle))      { skipped++; continue; }

      // ── Build product ─────────────────────────────────────────────────────
      const totalMarketCost       = parseFloat((item.price + item.shippingCost).toFixed(2));
      const suggestedSellingPrice = parseFloat((totalMarketCost * (1 + markupPct / 100)).toFixed(2));
      const listingAgeDays        = item.startTime
        ? Math.max(1, (Date.now() - new Date(item.startTime).getTime()) / 86400000)
        : 180;
      const soldPerDay      = item.sold / listingAgeDays;
      const decay           = listingAgeDays > 730 ? 0.35 : listingAgeDays > 365 ? 0.50 : listingAgeDays > 180 ? 0.65 : listingAgeDays > 90 ? 0.80 : 1.0;
      const estimatedSold30d = Math.round(soldPerDay * 30 * decay);

      const product: Omit<QueueProduct, "id"> = {
        ebayItemId: item.itemId, title: item.title, normalizedTitle: normTitle,
        images: item.pic ? [item.pic] : [], userId, storeId,
        ebayReferencePrice: item.price, ebayShippingCost: item.shippingCost,
        totalMarketCost, refPriceMin: item.price, refPriceMax: item.price,
        eproloPrice: null, eproloUrl: null,
        suggestedSellingPrice, markupPercent: Math.round(markupPct),
        margin: null, marginPercent: null,
        categoryId: item.categoryId, categoryName: "",
        soldCount: item.sold, estimatedSold30d,
        listingAgeDays: Math.round(listingAgeDays),
        condition: item.condition || "New",
        sourceUrl: `https://www.ebay.com/itm/${item.itemId}`,
        description: "", stock: CONFIG.STOCK, status: importStatus,
        createdAt: Date.now(), updatedAt: Date.now(),
      };

      batch.set(queueCol(userId).doc(), product);
      batchOps++;
      existingIds.add(item.itemId);
      existingTitles.add(normTitle);
      added++;

      // Flush batch every 100 items (well within Firestore's 500 op limit)
      if (batchOps >= 100) {
        await batch.commit();
        console.log(`[import-store] ✅ Batch +${batchOps} (total added: ${added}, checked: ${checked})`);
        batch    = db.batch();
        batchOps = 0;
      }
    }

    // Flush remaining
    if (batchOps > 0) {
      await batch.commit();
      console.log(`[import-store] ✅ Final batch +${batchOps} (total added: ${added})`);
    }

    if (firstItem) {
      // scanAllSellerItems yielded nothing — seller not found or no listings
      return NextResponse.json({
        success: false, seller, checked: 0, added: 0, skipped: 0,
        message: `No se encontraron listings activos para "${seller}". Verifica el username.`,
      });
    }

    const message = added === 0
      ? `Se escanearon ${checked} listings de "${seller}" pero ninguno cumplió los filtros (precio ≥ $${minPrice}, sin IP violations).`
      : `${added} productos importados de "${seller}" → "${importStatus}". ${skipped} descartados de ${checked} escaneados.`;

    console.log(`[import-store] ✅ Finalizado — added=${added} skipped=${skipped} checked=${checked}`);
    return NextResponse.json({ success: true, seller, checked, added, skipped, message });

  } catch (e) {
    console.error("[import-store] ❌", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}