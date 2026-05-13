import { NextRequest, NextResponse } from "next/server";
import { db, queueCol } from "@/lib/firebase";
import { getExchangeRate } from "@/lib/currency";

// ─── Translate keyword to Chinese for 1688 ────────────────────────────────────
// 1688 is Chinese — English keywords return empty results.
// We use Claude to translate the keyword before searching.
async function translateToChinesé(keyword: string): Promise<string> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{
          role: "user",
          content: `Translate this product keyword to Simplified Chinese for searching on 1688.com. Return ONLY the Chinese translation, nothing else: "${keyword}"`
        }]
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json() as { content?: { text: string }[] };
    const translated = data?.content?.[0]?.text?.trim() ?? keyword;
    console.log(`[1688] Translated "${keyword}" → "${translated}"`);
    return translated;
  } catch {
    console.warn("[1688] Translation failed, using original keyword");
    return keyword;
  }
}

// ─── ScraperAPI fetch ─────────────────────────────────────────────────────────
async function scrape1688(keyword: string): Promise<string> {
  const target = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&n=y`;
  // wait=5000 — wait 5s after JS render for async XHR product data to load
  const scraperUrl = `https://api.scraperapi.com/?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(target)}&render=true&country_code=cn&wait=5000`;

  console.log(`[1688] ScraperAPI fetching: ${target}`);

  const res = await fetch(scraperUrl, {
    signal: AbortSignal.timeout(55000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ScraperAPI ${res.status}: ${err.slice(0, 200)}`);
  }

  const html = await res.text();
  console.log(`[1688] HTML length: ${html.length} chars`);
  return html;
}

// ─── Parse rendered HTML ──────────────────────────────────────────────────────
type Offer = { title: string; price: number; imageUrl: string; productUrl: string; sales: number; shopName: string };

function parseHtml(html: string): Offer[] {
  // Debug: log globals and check for offer data
  const globals = html.match(/window\.[\w$]+\s*[=:]\s*[\[{]/g) ?? [];
  console.log(`[1688] window globals: ${JSON.stringify(globals.slice(0, 12))}`);
  const hasOfferId = html.includes('"offerId"');
  const hasSubject = html.includes('"subject"');
  console.log(`[1688] hasOfferId=${hasOfferId} hasSubject=${hasSubject} htmlLen=${html.length}`);

  if (!hasOfferId && !hasSubject) {
    console.log(`[1688] No product data found. HTML[30k-32k]: ${html.slice(30000, 32000)}`);
    return [];
  }

  // Try JSON patterns first
  const patterns = [
    /window\.__INIT_DATA__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\.__modData__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\.g_srp_data\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\.data\s*=\s*(\{[\s\S]*?\});\s*(?:window|var|<\/script>)/,
    /"offerList"\s*:\s*(\[[\s\S]{100,200000}\])/,
  ];

  for (const pat of patterns) {
    const m = html.match(pat);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[1]);
      const list: Record<string, unknown>[] =
        parsed?.data?.offerList ??
        parsed?.offerList ??
        parsed?.mods?.offerList?.data ??
        (Array.isArray(parsed) ? parsed : null);

      if (Array.isArray(list) && list.length > 0) {
        console.log(`[1688] ✅ Found ${list.length} offers via JSON pattern`);
        return list.map(toOffer).filter(o => o.price > 0 && o.title.length > 2);
      }
    } catch { /* next */ }
  }

  // Regex fallback
  console.log("[1688] JSON patterns failed — trying field regex");
  const offerIds = [...html.matchAll(/"offerId"\s*:\s*"(\d+)"/g)].map(m => m[1]);
  const subjects = [...html.matchAll(/"subject"\s*:\s*"([^"]{5,200})"/g)].map(m => m[1]);
  const prices   = [...html.matchAll(/"price"\s*:\s*"([\d.]+)"/g)].map(m => parseFloat(m[1]));
  const imgUrls  = [...html.matchAll(/"imgUrl"\s*:\s*"(https?:[^"]+)"/g)].map(m => m[1]);

  console.log(`[1688] Regex: ${offerIds.length} ids / ${subjects.length} subjects / ${prices.length} prices`);
  const count = Math.min(offerIds.length, subjects.length, prices.length, 25);
  return Array.from({ length: count }, (_, i) => ({
    title:      subjects[i] ?? "",
    price:      prices[i]   ?? 0,
    imageUrl:   imgUrls[i]  ?? "",
    productUrl: `https://detail.1688.com/offer/${offerIds[i]}.html`,
    sales:      0,
    shopName:   "",
  })).filter(o => o.price > 0 && o.title.length > 2);
}

function toOffer(offer: Record<string, unknown>): Offer {
  const priceInfo = offer?.priceInfo as Record<string, unknown> | undefined;
  const imgInfo   = offer?.image     as Record<string, unknown> | undefined;
  return {
    title:      String(offer?.subject ?? offer?.title ?? ""),
    price:      parseFloat(String(priceInfo?.price ?? priceInfo?.minPrice ?? offer?.price ?? "0")),
    imageUrl:   String(imgInfo?.imgUrl ?? offer?.imgUrl ?? ""),
    productUrl: `https://detail.1688.com/offer/${offer?.offerId ?? ""}.html`,
    sales:      parseInt(String(offer?.tradeCount ?? "0")) || 0,
    shopName:   String(offer?.companyName ?? ""),
  };
}

// ─── Pricing ──────────────────────────────────────────────────────────────────
function calcPricing(cnyPrice: number, usdRate: number, markupPct: number) {
  const costUSD   = cnyPrice * usdRate;
  const shipping  = costUSD < 5 ? 4.5 : costUSD < 15 ? 5.5 : 6.5;
  const ebayFee   = (costUSD + shipping) * 0.135;
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
    if (!process.env.SCRAPERAPI_KEY)
      return NextResponse.json({ error: "SCRAPERAPI_KEY not set in env" }, { status: 500 });

    console.log(`[1688] Searching: "${keyword}"`);

    // Translate to Chinese — 1688 is Chinese-only, English returns 0 results
    const chineseKeyword = await translateToChinesé(keyword);
    const html = await scrape1688(chineseKeyword);

    if (!html || html.length < 5000) {
      return NextResponse.json({ error: "1688 returned empty page" }, { status: 502 });
    }

    const offers = parseHtml(html);
    console.log(`[1688] Total offers: ${offers.length}`);

    if (offers.length === 0) {
      return NextResponse.json({ added: 0, message: "Parser found 0 products — check Vercel logs" });
    }

    const usdRate = await getExchangeRate("CNY", "USD").catch(() => 0.138);
    const batch   = db.batch();
    let added = 0;

    for (const p of offers) {
      if (!p.title || p.price < 0.5) continue;
      const { costUSD, shipping, suggested } = calcPricing(p.price, usdRate, markupPct);
      if (suggested < 8 || suggested > 800) continue;

      batch.set(queueCol(userId).doc(), {
        title:          p.title,
        price:          costUSD,
        suggestedPrice: suggested,
        shipping,
        images:         p.imageUrl ? [p.imageUrl] : [],
        source:         "1688",
        source1688Url:  p.productUrl,
        cnyPrice:       p.price,
        shopName:       p.shopName,
        soldCount:      p.sales,
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
    return NextResponse.json({ success: true, added, total: offers.length });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[1688] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}