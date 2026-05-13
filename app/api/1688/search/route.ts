import { NextRequest, NextResponse } from "next/server";
import { db, queueCol } from "@/lib/firebase";
import { getExchangeRate } from "@/lib/currency";

const OXYLABS_AUTH = Buffer.from(
  `${process.env.OXYLABS_USERNAME}:${process.env.OXYLABS_PASSWORD}`
).toString("base64");

// ─── Fetch HTML from Oxylabs ──────────────────────────────────────────────────
async function oxylabsFetch(url: string): Promise<string> {
  const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${OXYLABS_AUTH}` },
    body: JSON.stringify({
      source: "universal",
      url,
      // No render:html — use static HTML which is faster and cheaper
      // 1688 embeds product data in <script> tags as JSON
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Oxylabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { results?: { content?: string }[] };
  return data?.results?.[0]?.content ?? "";
}

// ─── Try every known 1688 JSON embedding pattern ─────────────────────────────
function extractOffers(html: string): { title: string; price: number; imageUrl: string; productUrl: string; sales: number; shopName: string }[] {

  // Pattern 1: window.__INIT_DATA__ = {...}
  const patterns = [
    /window\.__INIT_DATA__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\._duxData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /"offerList"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"offers"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /g_page_config\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\.pageData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      // Try multiple paths where offerList might live
      const list =
        parsed?.data?.offerList ??
        parsed?.offerList ??
        parsed?.result?.offerList ??
        parsed?.mods?.offerList?.data ??
        (Array.isArray(parsed) ? parsed : null);

      if (Array.isArray(list) && list.length > 0) {
        console.log(`[1688] Found ${list.length} offers via pattern: ${pattern.source.slice(0, 40)}`);
        return list.slice(0, 30).map((offer: Record<string, unknown>) => {
          const priceInfo = offer?.priceInfo as Record<string, unknown> | undefined;
          const price = parseFloat(
            String(priceInfo?.price ?? priceInfo?.minPrice ?? offer?.price ?? "0")
          );
          const imgObj = offer?.image as Record<string, unknown> | undefined;
          return {
            title:      String(offer?.subject ?? offer?.title ?? offer?.offerName ?? ""),
            price,
            imageUrl:   String(imgObj?.imgUrl ?? offer?.imgUrl ?? offer?.image ?? ""),
            productUrl: `https://detail.1688.com/offer/${offer?.offerId ?? ""}.html`,
            sales:      parseInt(String(offer?.tradeCount ?? offer?.soldCount ?? "0")) || 0,
            shopName:   String(offer?.companyName ?? offer?.sellerName ?? ""),
          };
        }).filter(o => o.price > 0 && o.title);
      }
    } catch { /* try next pattern */ }
  }

  // Pattern 2: Extract individual offer blocks via regex (last resort)
  console.log("[1688] JSON patterns failed — trying regex extraction");
  const results: { title: string; price: number; imageUrl: string; productUrl: string; sales: number; shopName: string }[] = [];

  // offerId + price pairs
  const offerRegex = /"offerId"\s*:\s*"(\d+)"[\s\S]{0,500}?"price"\s*:\s*"([\d.]+)"/g;
  const titleRegex = /"subject"\s*:\s*"([^"]{10,200})"/g;
  const imgRegex   = /"imgUrl"\s*:\s*"(https?:[^"]+)"/g;

  const offerIds: string[] = [], prices: number[] = [], titles: string[] = [], imgs: string[] = [];
  let m;
  while ((m = offerRegex.exec(html)) !== null) { offerIds.push(m[1]); prices.push(parseFloat(m[2])); }
  while ((m = titleRegex.exec(html)) !== null && titles.length < 30) titles.push(m[1]);
  while ((m = imgRegex.exec(html)) !== null && imgs.length < 30) imgs.push(m[1]);

  const count = Math.min(offerIds.length, titles.length, 30);
  for (let i = 0; i < count; i++) {
    if (!prices[i] || prices[i] < 0.5) continue;
    results.push({
      title: titles[i] ?? "",
      price: prices[i],
      imageUrl: imgs[i] ?? "",
      productUrl: `https://detail.1688.com/offer/${offerIds[i]}.html`,
      sales: 0,
      shopName: "",
    });
  }

  console.log(`[1688] Regex extraction found ${results.length} products`);
  return results;
}

// ─── Pricing ──────────────────────────────────────────────────────────────────
function calcPricing(cnyPrice: number, usdRate: number, markupPct: number) {
  const costUSD  = cnyPrice * usdRate;
  const shipping = costUSD < 5 ? 4.5 : costUSD < 15 ? 5.5 : 6.5;
  const ebayFee  = (costUSD + shipping) * 0.135;
  const suggested = Math.ceil((costUSD + shipping + ebayFee) * (1 + markupPct / 100) * 10) / 10;
  return { costUSD: Math.round(costUSD * 100) / 100, shipping, suggested };
}

// ─── POST /api/1688/search ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { keyword, userId, storeId, markupPct = 40 } = await req.json() as {
      keyword: string; userId: string; storeId: string; markupPct?: number;
    };

    if (!keyword || !userId || !storeId)
      return NextResponse.json({ error: "keyword, userId, storeId required" }, { status: 400 });
    if (!process.env.OXYLABS_USERNAME || !process.env.OXYLABS_PASSWORD)
      return NextResponse.json({ error: "OXYLABS_USERNAME / OXYLABS_PASSWORD not set" }, { status: 500 });

    // Try multiple 1688 search URLs — different pages have different HTML structures
    const searchUrls = [
      `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}`,
      `https://www.1688.com/s/offer_search.htm?keywords=${encodeURIComponent(keyword)}&n=y`,
    ];

    let html = "";
    let usedUrl = "";
    for (const url of searchUrls) {
      console.log(`[1688] Fetching: ${url}`);
      html = await oxylabsFetch(url).catch(e => { console.warn(`[1688] URL failed: ${e.message}`); return ""; });
      if (html.length > 1000) { usedUrl = url; break; }
    }

    if (!html || html.length < 1000) {
      console.error("[1688] Empty or too-short HTML response");
      return NextResponse.json({ error: "1688 page returned no content — check Oxylabs plan/credentials" }, { status: 502 });
    }

    console.log(`[1688] HTML length: ${html.length} chars from ${usedUrl}`);

    // Log a snippet to see what structure we got
    const scriptSnippet = html.match(/window\.[A-Z_a-z]+\s*=\s*\{/g)?.slice(0, 5) ?? [];
    console.log(`[1688] Script globals found: ${JSON.stringify(scriptSnippet)}`);

    const offers = extractOffers(html);
    console.log(`[1688] Parsed ${offers.length} products for "${keyword}"`);

    if (offers.length === 0) {
      // Save a snippet to help debug
      const snippet = html.slice(0, 2000);
      console.log(`[1688] HTML snippet for debug:\n${snippet}`);
      return NextResponse.json({ added: 0, message: "Parser found 0 products — check logs for HTML structure" });
    }

    const usdRate = await getExchangeRate("CNY", "USD").catch(() => 0.138);
    const batch   = db.batch();
    let added = 0;

    for (const p of offers) {
      if (!p.title || p.price < 0.5) continue;
      const { costUSD, shipping, suggested } = calcPricing(p.price, usdRate, markupPct);
      if (suggested < 8 || suggested > 600) continue;

      const docRef = queueCol(userId).doc();
      batch.set(docRef, {
        title:         p.title,
        price:         costUSD,
        suggestedPrice: suggested,
        shipping,
        images:        p.imageUrl ? [p.imageUrl] : [],
        source:        "1688",
        source1688Url: p.productUrl,
        cnyPrice:      p.price,
        shopName:      p.shopName,
        soldCount:     p.sales,
        storeId,
        status:        "pending",
        createdAt:     Date.now(),
        updatedAt:     Date.now(),
      });
      added++;
      if (added >= 25) break;
    }

    if (added > 0) await batch.commit();
    console.log(`[1688] ✅ Added ${added} products from "${keyword}"`);
    return NextResponse.json({ success: true, added, total: offers.length });

  } catch (e) {
    console.error("[1688] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}