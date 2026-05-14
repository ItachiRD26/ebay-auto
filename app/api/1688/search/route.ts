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
  OriginalTitle?: string;
  MainPictureUrl?: string;
  Volume?:       number;
  TaobaoItemUrl?: string;
  ExternalItemUrl?: string;
  VendorName?:   string;
  VendorDisplayName?: string;
  Price?: {
    OriginalPrice?: number;           // CNY price
    OriginalCurrencyCode?: string;
    ConvertedPriceList?: {
      Internal?: { Price?: number; Code?: string }; // USD already converted
    };
  };
};

// ─── Search 1688 via OTCommerce API ──────────────────────────────────────────
async function searchOtapi(keyword: string, page = 0): Promise<OtapiItem[]> {
  // Per docs: use <ItemTitle> not <SearchText>, add <Provider>Alibaba1688</Provider>
  // framePosition=page, frameSize=40, blockList can be empty for basic search
  const xmlParams = [
    `<SearchItemsParameters>`,
    `<ItemTitle>${keyword}</ItemTitle>`,
    `<Provider>Alibaba1688</Provider>`,
    `<UseOptimalFrameSize>true</UseOptimalFrameSize>`,
    `</SearchItemsParameters>`,
  ].join("");

  const params = new URLSearchParams({
    instanceKey:   OTAPI_KEY,
    language:      "en",
    sessionId:     "",
    framePosition: String(page * 40),
    frameSize:     "40",
    blockList:     "",
    xmlParameters: xmlParams,
  });

  const url = `${OTAPI_BASE}/BatchSearchItemsFrame?${params.toString()}`;
  console.log(`[1688] OTCommerce search: "${keyword}" page ${page}`);
  console.log(`[1688] URL: ${url.slice(0, 200)}`);

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  console.log(`[1688] Raw response (500 chars): ${text.slice(0, 500)}`);

  if (!res.ok) throw new Error(`OTCommerce HTTP ${res.status}: ${text.slice(0, 200)}`);

  const data = JSON.parse(text) as {
    ErrorCode?: string;
    ErrorMessage?: string;
    Result?: {
      Items?: {
        Items?: {
          Content?: OtapiItem[];
          TotalCount?: number;
        };
      };
    };
  };

  console.log(`[1688] ErrorCode: ${data.ErrorCode} items: ${data.Result?.Items?.Items?.Content?.length ?? 0}`);
  
  // Log first item to see full structure
  const firstItem = data.Result?.Items?.Items?.Content?.[0];
  if (firstItem) console.log(`[1688] First item structure: ${JSON.stringify(firstItem).slice(0, 1000)}`);

  if (data.ErrorCode !== "Ok") {
    throw new Error(`OTCommerce error: ${data.ErrorCode} — ${data.ErrorMessage}`);
  }

  return data.Result?.Items?.Items?.Content ?? [];
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

    // Search via OTCommerce API
    let items: OtapiItem[] = [];
    try {
      items = await searchOtapi(keyword);
    } catch (e) {
      throw new Error(`OTCommerce search failed: ${e}`);
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
      // Use USD price if already converted, else convert from CNY
      const usdFromApi = item.Price?.ConvertedPriceList?.Internal?.Price;
      const cnyPrice   = item.Price?.OriginalPrice ?? 0;
      const priceUSD   = usdFromApi && usdFromApi > 0
        ? usdFromApi
        : cnyPrice * usdRate;

      if (!priceUSD || priceUSD < 1) continue;

      const title = item.Title ?? item.OriginalTitle ?? "";
      if (!title || title.length < 3) continue;

      const { shipping, suggested } = calcPricing(priceUSD, markupPct);
      if (suggested < 8 || suggested > 800) continue;

      const imageUrl  = item.MainPictureUrl ?? "";
      const sourceUrl = item.TaobaoItemUrl ?? item.ExternalItemUrl
        ?? `https://detail.1688.com/offer/${item.Id.replace("abb-", "")}.html`;
      const shopName  = item.VendorDisplayName ?? item.VendorName ?? "";

      console.log(`[1688] Adding: "${title.slice(0, 40)}" CNY=${cnyPrice} USD=${priceUSD.toFixed(2)} → $${suggested}`);

      batch.set(queueCol(userId).doc(), {
        title,
        totalMarketCost:       Math.round(priceUSD * 100) / 100,
        suggestedSellingPrice: suggested,
        ebayReferencePrice:    suggested,
        price:                 Math.round(priceUSD * 100) / 100,
        suggestedPrice:        suggested,
        shipping,
        images:                imageUrl ? [imageUrl] : [],
        source:                "1688",
        source1688Url:         sourceUrl,
        cnyPrice,
        shopName,
        soldCount:             item.Volume ?? 0,
        storeId,
        status:                "pending",
        createdAt:             Date.now(),
        updatedAt:             Date.now(),
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