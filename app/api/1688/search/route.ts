import { NextRequest, NextResponse } from "next/server";
import { db, queueCol } from "@/lib/firebase";
import { getExchangeRate } from "@/lib/currency";

const OXYLABS_AUTH = Buffer.from(
  `${process.env.OXYLABS_USERNAME}:${process.env.OXYLABS_PASSWORD}`
).toString("base64");

// ─── Scrape 1688 with render:html ─────────────────────────────────────────────
// 1688 search pages are JS-rendered — we need render:html to get product data.
// This route needs maxDuration: 60 in vercel.json.
async function scrape1688(keyword: string): Promise<string> {
  const url = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&n=y`;
  console.log(`[1688] Fetching with render:html — ${url}`);

  // Match Oxylabs docs exactly: source universal + render html
  const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${OXYLABS_AUTH}`,
    },
    body: JSON.stringify({
      source: "universal",
      url,
      render: "html",
    }),
    signal: AbortSignal.timeout(50000), // 50s — under Vercel's 60s limit
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Oxylabs ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json() as { results?: { content?: string; status_code?: number }[] };
  const content = data?.results?.[0]?.content ?? "";
  const statusCode = data?.results?.[0]?.status_code ?? 0;
  console.log(`[1688] Response: ${content.length} chars, status_code=${statusCode}`);
  return content;
}

// ─── Parse rendered HTML ──────────────────────────────────────────────────────
type Offer = { title: string; price: number; imageUrl: string; productUrl: string; sales: number; shopName: string };

function parseHtml(html: string): Offer[] {
  // Log what globals exist to help debug
  const globals = html.match(/window\.[\w$]+\s*[=:]\s*[\[{]/g) ?? [];
  console.log(`[1688] window globals: ${JSON.stringify(globals.slice(0, 12))}`);

  // Check if offerId exists at all
  const hasOfferId = html.includes('"offerId"');
  const hasSubject = html.includes('"subject"');
  console.log(`[1688] hasOfferId=${hasOfferId} hasSubject=${hasSubject}`);

  if (!hasOfferId) {
    // Log middle of HTML to understand page state
    console.log(`[1688] HTML[40k-42k]: ${html.slice(40000, 42000)}`);
    return [];
  }

  // Try all known patterns where 1688 embeds offer data
  const tryPatterns = [
    /window\.__INIT_DATA__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\.__modData__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\.g_srp_data\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\.data\s*=\s*(\{[\s\S]*?\});\s*(?:window|var|<\/script>)/,
    /\"offerList\"\s*:\s*(\[[\s\S]{100,100000}\])/,
  ];

  for (const pat of tryPatterns) {
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
        console.log(`[1688] Found ${list.length} offers via pattern`);
        return list.map(toOffer).filter(o => o.price > 0 && o.title.length > 2);
      }
    } catch { /* try next */ }
  }

  // Last resort: extract individual fields with regex
  console.log("[1688] Trying field-level regex extraction");
  const offerIds   = [...html.matchAll(/"offerId"\s*:\s*"(\d+)"/g)].map(m => m[1]);
  const subjects   = [...html.matchAll(/"subject"\s*:\s*"([^"]{5,200})"/g)].map(m => m[1]);
  const prices     = [...html.matchAll(/"price"\s*:\s*"([\d.]+)"/g)].map(m => parseFloat(m[1]));
  const imgUrls    = [...html.matchAll(/"imgUrl"\s*:\s*"(https?:[^"]+)"/g)].map(m => m[1]);

  console.log(`[1688] Field regex: ${offerIds.length} ids, ${subjects.length} subjects, ${prices.length} prices`);
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
    if (!process.env.OXYLABS_USERNAME || !process.env.OXYLABS_PASSWORD)
      return NextResponse.json({ error: "OXYLABS_USERNAME / OXYLABS_PASSWORD not set in env" }, { status: 500 });

    console.log(`[1688] Searching: "${keyword}"`);
    const html = await scrape1688(keyword);

    if (!html || html.length < 5000) {
      console.error(`[1688] HTML too short (${html.length} chars) — page may be blocked`);
      return NextResponse.json({ error: "1688 returned empty page — may be geo-blocked" }, { status: 502 });
    }

    const offers = parseHtml(html);
    console.log(`[1688] Total offers parsed: ${offers.length}`);

    if (offers.length === 0) {
      return NextResponse.json({ added: 0, message: "Parser found 0 products — check logs for HTML structure" });
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