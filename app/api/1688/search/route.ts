import { NextRequest, NextResponse } from "next/server";
import { db, queueCol } from "@/lib/firebase";
import { getExchangeRate } from "@/lib/currency";

// ─── OTCommerce / Otapi — 1688 official API reseller ─────────────────────────
// Key is domain-locked to dropflow-app.com — only works from Vercel production.
// Docs: https://docs-en.otcommerce.com
const OTAPI_KEY  = process.env.OTAPI_KEY ?? "b24af13d-7f79-4648-8d25-be9951e709cb";
const OTAPI_BASE = "https://otapi.net/service-json";

type OtapiItem = {
  Id:           string;
  Title:        string;
  Price:        { ConvertedOriginalPrice?: number; OriginalPrice?: number };
  MainPictureUrl?: string;
  TotalSoldQuantity?: number;
  OriginalUrl?:  string;
  Vendor?:       { Title?: string };
  Volume?:       number;
};

// ─── Search 1688 via OTCommerce API ──────────────────────────────────────────
async function searchOtapi(keyword: string, page = 0): Promise<OtapiItem[]> {
  // OTCommerce uses XML parameters for search
  const xmlParams = `<SearchItemsParameters><SearchText>${keyword}</SearchText><Pagination><Page>${page}</Page><ItemsPerPage>40</ItemsPerPage></Pagination></SearchItemsParameters>`;

  const url = `${OTAPI_BASE}/BatchSearchItemsFrame?instanceKey=${OTAPI_KEY}&language=en&xmlParameters=${encodeURIComponent(xmlParams)}`;
  console.log(`[1688] OTCommerce search: "${keyword}" page ${page}`);

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`OTCommerce ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`);

  const data = await res.json() as {
    Result?: string;
    ErrorCode?: string;
    ErrorMessage?: string;
    ItemsResult?: { Items?: { Content?: OtapiItem[] } };
  };

  console.log(`[1688] OTCommerce result: ${data.Result} error: ${data.ErrorCode ?? "none"}`);

  if (data.Result !== "Ok") {
    throw new Error(`OTCommerce error: ${data.ErrorCode} — ${data.ErrorMessage}`);
  }

  return data.ItemsResult?.Items?.Content ?? [];
}

// ─── Alternative: simple search endpoint ─────────────────────────────────────
async function searchOtapiSimple(keyword: string): Promise<OtapiItem[]> {
  const url = `${OTAPI_BASE}/SearchItems?instanceKey=${OTAPI_KEY}&language=en&searchText=${encodeURIComponent(keyword)}&page=0&itemsPerPage=40`;
  console.log(`[1688] OTCommerce simple search: "${keyword}"`);

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`OTCommerce ${res.status}`);

  const data = await res.json() as {
    Result?: string;
    ErrorCode?: string;
    Items?: OtapiItem[];
  };

  console.log(`[1688] Result: ${data.Result} items: ${data.Items?.length ?? 0}`);
  if (data.Result !== "Ok") throw new Error(`OTCommerce: ${data.ErrorCode}`);
  return data.Items ?? [];
}

// ─── Pricing ──────────────────────────────────────────────────────────────────
function calcPricing(priceUSD: number, markupPct: number) {
  const shipping  = priceUSD < 5 ? 4.5 : priceUSD < 15 ? 5.5 : 6.5;
  const ebayFee   = (priceUSD + shipping) * 0.135;
  const suggested = Math.ceil((priceUSD + shipping + ebayFee) * (1 + markupPct / 100) * 10) / 10;
  return { shipping, suggested };
}

// ─── POST /api/1688/search ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { keyword, userId, storeId, markupPct = 40 } = await req.json() as {
      keyword: string; userId: string; storeId: string; markupPct?: number;
    };

    if (!keyword || !userId || !storeId)
      return NextResponse.json({ error: "keyword, userId, storeId required" }, { status: 400 });

    console.log(`[1688] Searching: "${keyword}"`);

    // Try BatchSearchItemsFrame first, fallback to SearchItems
    let items: OtapiItem[] = [];
    try {
      items = await searchOtapi(keyword);
    } catch (e1) {
      console.warn(`[1688] BatchSearch failed: ${e1} — trying simple search`);
      try {
        items = await searchOtapiSimple(keyword);
      } catch (e2) {
        throw new Error(`Both OTCommerce endpoints failed: ${e2}`);
      }
    }

    console.log(`[1688] Found ${items.length} products`);

    if (items.length === 0) {
      return NextResponse.json({ added: 0, message: "No products found for this keyword" });
    }

    // Get USD rate for CNY conversion (OTCommerce may return USD already)
    const usdRate = await getExchangeRate("CNY", "USD").catch(() => 0.138);
    const batch   = db.batch();
    let added = 0;

    for (const item of items) {
      // OTCommerce returns price in USD (ConvertedOriginalPrice) or CNY (OriginalPrice)
      const priceUSD = item.Price?.ConvertedOriginalPrice
        ?? (item.Price?.OriginalPrice ? item.Price.OriginalPrice * usdRate : 0);

      if (!priceUSD || priceUSD < 1) continue;

      const title = item.Title ?? "";
      if (!title || title.length < 3) continue;

      const { shipping, suggested } = calcPricing(priceUSD, markupPct);
      if (suggested < 8 || suggested > 800) continue;

      const imageUrl  = item.MainPictureUrl ?? "";
      const sourceUrl = item.OriginalUrl ?? `https://detail.1688.com/offer/${item.Id}.html`;

      batch.set(queueCol(userId).doc(), {
        title,
        price:          Math.round(priceUSD * 100) / 100,
        suggestedPrice: suggested,
        shipping,
        images:         imageUrl ? [imageUrl] : [],
        source:         "1688",
        source1688Url:  sourceUrl,
        soldCount:      item.TotalSoldQuantity ?? item.Volume ?? 0,
        shopName:       item.Vendor?.Title ?? "",
        storeId,
        status:         "pending",
        createdAt:      Date.now(),
        updatedAt:      Date.now(),
      });
      added++;
      if (added >= 25) break;
    }

    if (added > 0) await batch.commit();
    console.log(`[1688] ✅ ${added} products added from "${keyword}"`);
    return NextResponse.json({ success: true, added, total: items.length });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[1688] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}