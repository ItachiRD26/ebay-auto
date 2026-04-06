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
  MAX_ITEMS:      5000,  // scan up to 5000 items (Browse API hard limit ~10k)
  MAX_PAGES:      50,    // 200 items/page × 50 = 10k max
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

// ─── Fetch seller listings via Browse API (app token) ────────────────────────
// KEY: Browse API with sellers:{username} filter works for ANY public seller.
// GetSellerList (Trading API) only works for the authenticated user's OWN listings —
// that's why it was importing your own store instead of the target seller.
//
// Tradeoff: Browse API doesn't return QuantitySold directly, but unitSoldCount
// is available on some items. We use it when present, else default to 0.
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

async function fetchSellerPage(
  seller: string,
  page: number,           // 0-based offset page (offset = page * 200)
  appToken: string,
): Promise<{ items: SellerItem[]; hasMore: boolean; total: number }> {
  const offset = page * 200;

  // Browse API requires q OR category_ids — without it returns 0 results silently.
  // "a" matches virtually every listing title (most titles contain the letter a).
  // We rely on the sellers:{} filter to scope the results to the target seller.
  const params = new URLSearchParams({
    q:           "a",
    limit:       "200",
    offset:      String(offset),
    sort:        "BEST_MATCH",
    filter:      `sellers:{${seller}},buyingOptions:{FIXED_PRICE}`,
    fieldgroups: "EXTENDED",
  });

  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      {
        headers: {
          Authorization:             `Bearer ${appToken}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        signal: AbortSignal.timeout(20000),
      }
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[import-store] Browse API offset=${offset} failed ${res.status}: ${txt.slice(0, 100)}`);
      return { items: [], hasMore: false, total: 0 };
    }

    const data = await res.json() as {
      itemSummaries?: Array<{
        itemId?:        string;
        title?:         string;
        price?:         { value?: string };
        shippingOptions?: Array<{ shippingCost?: { value?: string }; shippingCostType?: string }>;
        unitSoldCount?: number;
        itemCreationDate?: string;
        categories?:    Array<{ categoryId?: string }>;
        image?:         { imageUrl?: string };
        thumbnailImages?: Array<{ imageUrl?: string }>;
        condition?:     string;
        conditionId?:   string;
      }>;
      total?: number;
    };

    const total = data.total ?? 0;
    const summaries = data.itemSummaries ?? [];

    const items: SellerItem[] = summaries.flatMap(item => {
      const itemId = item.itemId?.split("|")[1] ?? item.itemId ?? "";
      const title  = item.title ?? "";
      if (!itemId || !title) return [];

      const price = parseFloat(item.price?.value ?? "0") || 0;

      const shipping = item.shippingOptions?.[0];
      const shippingCost =
        shipping?.shippingCostType === "FREE" ? 0 :
        parseFloat(shipping?.shippingCost?.value ?? "0") || 0;

      const sold = item.unitSoldCount ?? 0;

      const categoryId = item.categories?.[0]?.categoryId ?? "";
      const pic =
        item.image?.imageUrl ??
        item.thumbnailImages?.[0]?.imageUrl ?? "";

      const conditionName = item.condition ?? "";
      const condition = conditionName || (item.conditionId === "1000" ? "New" : "New");

      return [{ itemId, title, price, shippingCost, sold, startTime: item.itemCreationDate ?? "", categoryId, pic, condition }];
    });

    console.log(`[import-store] Browse offset=${offset} → ${items.length} items (total: ${total})`);
    return { items, hasMore: offset + 200 < total, total };
  } catch (e) {
    console.warn(`[import-store] fetchSellerPage error:`, e);
    return { items: [], hasMore: false, total: 0 };
  }
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

    // ── Paginate GetSellerList — no per-item API calls ───────────────────────
    let page    = 0;  // Browse API uses 0-based offset pages
    let hasMore = true;
    let checked = 0;
    let added   = 0;
    let skipped = 0;
    const seenThisRun = new Set<string>();

    while (hasMore && page <= CONFIG.MAX_PAGES && checked < CONFIG.MAX_ITEMS) {
      const { items, hasMore: more, total } = await fetchSellerPage(seller, page, appToken);
      hasMore = more;

      if (items.length === 0 && page === 1) {
        return NextResponse.json({
          success: false,
          seller,
          checked: 0, added: 0, skipped: 0,
          message: `No se encontraron listings activos para "${seller}". Verifica el username.`,
        });
      }

      console.log(`[import-store] Page ${page}/${Math.ceil(total / 200)} — ${items.length} items (store total: ${total})`);

      // Batch write — Firestore allows 500 ops per batch
      const batch = db.batch();
      let batchOps = 0;

      for (const item of items) {
        if (checked >= CONFIG.MAX_ITEMS) break;
        if (seenThisRun.has(item.itemId)) continue;
        seenThisRun.add(item.itemId);
        checked++;

        // ── Filters — minimal by design (status=pending means user reviews manually) ──
        // Only two hard filters: minimum price + minimum lifetime sales.
        // No max price, no condition filter, no category filter.
        // IP/adult blocklist still applies to protect from eBay policy violations.
        if (item.price < minPrice)                 { skipped++; continue; }
        // sold filter removed — unitSoldCount is unreliable in Browse API
        // (undefined = unknown, not 0 sales). User reviews everything in pending.
        if (isBanned(item.title, extraBlocked))    { skipped++; continue; }
        if (existingIds.has(item.itemId))          { skipped++; continue; }

        const normTitle = item.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim();
        if (existingTitles.has(normTitle))         { skipped++; continue; }

        // ── Build product ─────────────────────────────────────────────────
        const totalMarketCost       = parseFloat((item.price + item.shippingCost).toFixed(2));
        const suggestedSellingPrice = parseFloat((totalMarketCost * (1 + markupPct / 100)).toFixed(2));

        const listingAgeDays = item.startTime
          ? Math.max(1, (Date.now() - new Date(item.startTime).getTime()) / 86400000)
          : 180;
        const soldPerDay      = item.sold / listingAgeDays;
        const decay           = listingAgeDays > 730 ? 0.35 : listingAgeDays > 365 ? 0.50 : listingAgeDays > 180 ? 0.65 : listingAgeDays > 90 ? 0.80 : 1.0;
        const estimatedSold30d = Math.round(soldPerDay * 30 * decay);

        const product: Omit<QueueProduct, "id"> = {
          ebayItemId:           item.itemId,
          title:                item.title,
          normalizedTitle:      normTitle,
          images:               item.pic ? [item.pic] : [],
          userId,
          storeId,
          ebayReferencePrice:   item.price,
          ebayShippingCost:     item.shippingCost,
          totalMarketCost,
          refPriceMin:          item.price,
          refPriceMax:          item.price,
          eproloPrice:          null,
          eproloUrl:            null,
          suggestedSellingPrice,
          markupPercent:        Math.round(markupPct),
          margin:               null,
          marginPercent:        null,
          categoryId:           item.categoryId,
          categoryName:         "",
          soldCount:            item.sold,
          estimatedSold30d,
          listingAgeDays:       Math.round(listingAgeDays),
          condition:            item.condition || "New",
          sourceUrl:            `https://www.ebay.com/itm/${item.itemId}`,
          description:          "",
          stock:                CONFIG.STOCK,
          status:               importStatus,
          createdAt:            Date.now(),
          updatedAt:            Date.now(),
        };

        const ref = queueCol(userId).doc();
        batch.set(ref, product);
        batchOps++;

        // Track for dedup within this import run
        existingIds.add(item.itemId);
        existingTitles.add(normTitle);
        added++;
      }

      if (batchOps > 0) {
        await batch.commit();
        console.log(`[import-store] ✅ Batch +${batchOps} (total: ${added})`);
      }

      page++;
      if (hasMore && page <= CONFIG.MAX_PAGES) await new Promise(r => setTimeout(r, 250));
    }

    const message = added === 0
      ? `No se encontraron productos de "${seller}" con precio >= $${minPrice} y al menos ${minSold} ventas.`
      : `${added} productos importados de "${seller}" → estado "${importStatus}". ${skipped} descartados.`;

    console.log(`[import-store] ✅ Finalizado — added=${added} skipped=${skipped} checked=${checked}`);
    return NextResponse.json({ success: true, seller, checked, added, skipped, message });

  } catch (e) {
    console.error("[import-store] ❌", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}