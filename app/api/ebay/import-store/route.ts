import { NextRequest, NextResponse } from "next/server";
import { getUserToken } from "@/lib/ebay";
import { db, queueCol, settingsDoc as getSettingsDoc, DEFAULT_SETTINGS } from "@/lib/firebase";
import { QueueProduct, Settings } from "@/types";

// ─── Config — 5× more relaxed than search ────────────────────────────────────
// The store itself is the quality signal. Individual items don't need validation.
const CONFIG = {
  MIN_PRICE:      10,    // was 20
  MAX_PRICE:      500,   // was 250
  MIN_SOLD:       1,     // was 5 — use GetSellerList's own QuantitySold
  MARKUP_PERCENT: 6,
  STOCK:          1,
  MAX_ITEMS:      1000,
  MAX_PAGES:      20,    // 200 items/page × 20 = 4000 max scanned
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

// ─── Fetch one page of seller listings via GetSellerList ─────────────────────
// GetSellerList already includes QuantitySold per item — zero extra API calls needed.
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
  page: number,
  userToken: string,
): Promise<{ items: SellerItem[]; hasMore: boolean; total: number }> {
  const now    = new Date().toISOString();
  const future = new Date(Date.now() + 120 * 86400000).toISOString();

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <UserID>${seller}</UserID>
  <ActiveList>true</ActiveList>
  <ListingType>FixedPriceItem</ListingType>
  <GranularityLevel>Fine</GranularityLevel>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
  <EndTimeFrom>${now}</EndTimeFrom>
  <EndTimeTo>${future}</EndTimeTo>
  <IncludeVariations>false</IncludeVariations>
</GetSellerListRequest>`;

  try {
    const res = await fetch("https://api.ebay.com/ws/api.dll", {
      method: "POST",
      headers: {
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetSellerList",
        "Content-Type": "text/xml",
      },
      body: xml,
      signal: AbortSignal.timeout(30000),
    });

    const text = await res.text();

    if (!res.ok || text.includes("<Ack>Failure</Ack>")) {
      const errMsg = text.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] ?? "unknown";
      console.warn(`[import-store] GetSellerList p${page} failed: ${errMsg.slice(0, 100)}`);
      return { items: [], hasMore: false, total: 0 };
    }

    const totalPages   = parseInt(text.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? "1", 10);
    const totalEntries = parseInt(text.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/)?.[1] ?? "0", 10);

    const itemBlocks = text.match(/<Item>[\s\S]*?<\/Item>/g) ?? [];

    const items: SellerItem[] = itemBlocks.flatMap(block => {
      const get = (tag: string) =>
        block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`))?.[1]?.trim() ?? "";

      const itemId = get("ItemID");
      const title  = get("Title");
      if (!itemId || !title) return [];

      const priceRaw =
        block.match(/<ConvertedCurrentPrice[^>]*>([\d.]+)<\/ConvertedCurrentPrice>/)?.[1] ||
        block.match(/<CurrentPrice[^>]*>([\d.]+)<\/CurrentPrice>/)?.[1] ||
        block.match(/<BuyItNowPrice[^>]*>([\d.]+)<\/BuyItNowPrice>/)?.[1] ||
        block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] ||
        "0";
      const price = parseFloat(priceRaw) || 0;

      const sold = parseInt(get("QuantitySold") || "0", 10);

      const shippingCost =
        parseFloat(block.match(/<ShippingServiceCost[^>]*>([\d.]+)<\/ShippingServiceCost>/)?.[1] ?? "0") || 0;

      const startTime  = get("StartTime");
      const categoryId = get("CategoryID");
      const pic        = block.match(/<PictureURL>(https?:\/\/[^<]+)<\/PictureURL>/)?.[1]?.trim() ?? "";
      const condition  = get("ConditionDisplayName") || (get("ConditionID") === "1000" ? "New" : "Used");

      return [{ itemId, title, price, shippingCost, sold, startTime, categoryId, pic, condition }];
    });

    return { items, hasMore: page < totalPages, total: totalEntries };
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

    // ── Load settings ───────────────────────────────────────────────────────
    const [settingsSnap, kwSnap] = await Promise.all([
      getSettingsDoc(userId, "main").get(),
      db.collection("users").doc(userId).collection("settings").doc("keywords").get(),
    ]);
    const settings    = (settingsSnap.exists ? settingsSnap.data() : DEFAULT_SETTINGS) as Settings;
    const markupPct   = settings.markupPercent ?? CONFIG.MARKUP_PERCENT;
    const minPrice    = settings.minPrice  ?? CONFIG.MIN_PRICE;
    const maxPrice    = settings.maxPrice  ?? CONFIG.MAX_PRICE;
    // 5× more relaxed than normal search min sold
    const minSold     = Math.max(1, Math.floor((settings.minSoldCount ?? 5) / 5));

    const userBlocked = (kwSnap.data() as { excludedKeywords?: string[] } | undefined)?.excludedKeywords ?? [];
    const extraBlocked = userBlocked.map(k => k.toLowerCase().trim()).filter(Boolean);

    // ── Connect user account ────────────────────────────────────────────────
    let userToken: string;
    try {
      userToken = await getUserToken(storeId);
    } catch {
      return NextResponse.json(
        { error: "Tienda no conectada. Ve a Mis Tiendas → Conectar tu cuenta eBay primero." },
        { status: 400 }
      );
    }

    // ── Pre-load existing queue to avoid per-item Firestore queries ─────────
    // Batch fetch all existing itemIds + normalized titles — much faster than
    // N individual .where() calls inside the loop.
    const existingSnap = await queueCol(userId)
      .select("ebayItemId", "normalizedTitle")
      .limit(5000)
      .get();
    const existingIds    = new Set<string>(existingSnap.docs.map(d => String(d.data().ebayItemId ?? "")));
    const existingTitles = new Set<string>(existingSnap.docs.map(d => String(d.data().normalizedTitle ?? "")));

    console.log(`[import-store] Filters: $${minPrice}-$${maxPrice} | minSold=${minSold} | ${existingIds.size} existing items`);

    // ── Paginate GetSellerList — no per-item API calls ───────────────────────
    let page    = 1;
    let hasMore = true;
    let checked = 0;
    let added   = 0;
    let skipped = 0;
    const seenThisRun = new Set<string>();

    while (hasMore && page <= CONFIG.MAX_PAGES && checked < CONFIG.MAX_ITEMS) {
      const { items, hasMore: more, total } = await fetchSellerPage(seller, page, userToken);
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

        // ── Local filters — zero API calls ───────────────────────────────
        if (item.price < minPrice || item.price > maxPrice)          { skipped++; continue; }
        if (item.condition && !item.condition.toLowerCase().includes("new")) { skipped++; continue; }
        if (isBanned(item.title, extraBlocked))                      { skipped++; continue; }
        if (item.sold < minSold)                                      { skipped++; continue; }
        if (existingIds.has(item.itemId))                             { skipped++; continue; }

        const normTitle = item.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim();
        if (existingTitles.has(normTitle))                            { skipped++; continue; }

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
      if (hasMore) await new Promise(r => setTimeout(r, 250));
    }

    const message = added === 0
      ? `No se encontraron productos de "${seller}" en el rango $${minPrice}-$${maxPrice} con al menos ${minSold} venta.`
      : `${added} productos importados de "${seller}" → estado "${importStatus}". ${skipped} descartados.`;

    console.log(`[import-store] ✅ Finalizado — added=${added} skipped=${skipped} checked=${checked}`);
    return NextResponse.json({ success: true, seller, checked, added, skipped, message });

  } catch (e) {
    console.error("[import-store] ❌", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}