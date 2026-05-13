import { NextRequest, NextResponse } from "next/server";
import { db, queueCol } from "@/lib/firebase";
import { getExchangeRate } from "@/lib/currency";

const OXYLABS_AUTH = Buffer.from(
  `${process.env.OXYLABS_USERNAME}:${process.env.OXYLABS_PASSWORD}`
).toString("base64");

// ─── 1688 internal JSON API ───────────────────────────────────────────────────
// 1688's search page is a JS shell — products live in their internal JSON API.
// We use Oxylabs to call the JSON API endpoint directly (bypasses geo-blocks).
async function search1688Api(keyword: string): Promise<Record<string, unknown>> {
  // 1688 JSON search API — returns structured product data directly
  const url = `https://search.1688.com/service/searchService.do?keywords=${encodeURIComponent(keyword)}&n=y&beginPage=1&pageSize=60`;

  const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${OXYLABS_AUTH}` },
    body: JSON.stringify({
      source: "universal",
      url,
      // No render needed — this is a JSON API endpoint
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`Oxylabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { results?: { content?: string }[] };
  const content = data?.results?.[0]?.content ?? "";
  console.log(`[1688] JSON API response length: ${content.length}`);
  console.log(`[1688] Content preview: ${content.slice(0, 300)}`);
  return data;
}

// ─── Fallback: render:html for JS-heavy pages ─────────────────────────────────
async function search1688Render(keyword: string): Promise<string> {
  const url = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}`;
  const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${OXYLABS_AUTH}` },
    body: JSON.stringify({
      source: "universal",
      url,
      render: "html",  // JS rendering — costs more credits but gets full page
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Oxylabs render ${res.status}`);
  const data = await res.json() as { results?: { content?: string }[] };
  return data?.results?.[0]?.content ?? "";
}

// ─── Parse JSON API response ──────────────────────────────────────────────────
type Offer = { title: string; price: number; imageUrl: string; productUrl: string; sales: number; shopName: string };

function parseJsonApiResponse(content: string): Offer[] {
  // The content might be JSON directly or JSON embedded in HTML
  let json: Record<string, unknown> | null = null;

  // Try parsing as direct JSON
  try {
    json = JSON.parse(content);
  } catch {
    // Try extracting JSON from HTML
    const match = content.match(/\{[\s\S]*"offerList"[\s\S]*\}/);
    if (match) {
      try { json = JSON.parse(match[0]); } catch { /* skip */ }
    }
  }

  if (!json) {
    console.log("[1688] Could not parse JSON API response");
    return [];
  }

  // Navigate possible response structures
  const offerList: Record<string, unknown>[] =
    (json?.data as Record<string, unknown>)?.offerList as Record<string, unknown>[] ??
    (json as Record<string, unknown>)?.offerList as Record<string, unknown>[] ??
    (json?.result as Record<string, unknown>)?.offerList as Record<string, unknown>[] ??
    [];

  if (!Array.isArray(offerList) || offerList.length === 0) {
    console.log(`[1688] offerList empty. Top-level keys: ${Object.keys(json).join(", ")}`);
    return [];
  }

  console.log(`[1688] Found ${offerList.length} offers in JSON API`);

  return offerList.map(offer => {
    const priceInfo = offer?.priceInfo as Record<string, unknown> | undefined;
    const imgInfo   = offer?.image     as Record<string, unknown> | undefined;
    const price = parseFloat(String(priceInfo?.price ?? priceInfo?.minPrice ?? offer?.price ?? "0"));
    return {
      title:      String(offer?.subject ?? offer?.title ?? ""),
      price,
      imageUrl:   String(imgInfo?.imgUrl ?? offer?.imgUrl ?? ""),
      productUrl: `https://detail.1688.com/offer/${offer?.offerId ?? ""}.html`,
      sales:      parseInt(String(offer?.tradeCount ?? "0")) || 0,
      shopName:   String(offer?.companyName ?? ""),
    };
  }).filter(o => o.price > 0 && o.title.length > 2);
}

// ─── Parse rendered HTML (fallback) ──────────────────────────────────────────
function parseRenderedHtml(html: string): Offer[] {
  // Log all window.X = { globals to find where products live
  const globals = html.match(/window\.[\w$]+\s*[=:]\s*\{/g) ?? [];
  console.log(`[1688] window globals in rendered HTML: ${JSON.stringify(globals.slice(0, 15))}`);

  // Log all script tags content snippet
  const scripts = html.match(/<script[^>]*>([\s\S]{100,2000}?)<\/script>/g) ?? [];
  console.log(`[1688] Script blocks found: ${scripts.length}`);
  for (const s of scripts.slice(0, 8)) {
    if (s.includes("offerId") || s.includes("offerList") || s.includes("subject") || s.includes("priceInfo")) {
      console.log(`[1688] Promising script block: ${s.slice(0, 400)}`);
    }
  }

  // Log snippet around "offerId" if it exists
  const offerIdIdx = html.indexOf('"offerId"');
  if (offerIdIdx > -1) {
    console.log(`[1688] Found "offerId" at idx ${offerIdIdx}: ${html.slice(Math.max(0, offerIdIdx - 100), offerIdIdx + 300)}`);
  } else {
    console.log("[1688] 'offerId' not found in rendered HTML");
    // Log a middle chunk to see what the rendered content looks like
    console.log(`[1688] HTML middle chunk (50k-52k): ${html.slice(50000, 52000)}`);
  }

  const patterns = [
    /window\.data\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/,
    /window\.__INIT_DATA__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\.__modData__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /"offerList"\s*:\s*(\[[\s\S]{50,}\])\s*[,}]/,
    /"offers"\s*:\s*(\[[\s\S]{50,}\])\s*[,}]/,
  ];

  for (const pat of patterns) {
    const m = html.match(pat);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[1]);
      const list: Record<string, unknown>[] =
        parsed?.data?.offerList ?? parsed?.offerList ?? (Array.isArray(parsed) ? parsed : null);
      if (Array.isArray(list) && list.length > 0) {
        console.log(`[1688] render:html found ${list.length} offers via ${pat.source.slice(0, 40)}`);
        return list.map(offer => {
          const priceInfo = offer?.priceInfo as Record<string, unknown> | undefined;
          const imgInfo   = offer?.image     as Record<string, unknown> | undefined;
          const price = parseFloat(String(priceInfo?.price ?? offer?.price ?? "0"));
          return {
            title:      String(offer?.subject ?? offer?.title ?? ""),
            price,
            imageUrl:   String(imgInfo?.imgUrl ?? offer?.imgUrl ?? ""),
            productUrl: `https://detail.1688.com/offer/${offer?.offerId ?? ""}.html`,
            sales:      parseInt(String(offer?.tradeCount ?? "0")) || 0,
            shopName:   String(offer?.companyName ?? ""),
          };
        }).filter(o => o.price > 0 && o.title.length > 2);
      }
    } catch { /* next */ }
  }
  return [];
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
      return NextResponse.json({ error: "OXYLABS_USERNAME / OXYLABS_PASSWORD not configured" }, { status: 500 });

    console.log(`[1688] Searching: "${keyword}"`);

    // ── Step 1: Try JSON API (fast, cheap) ────────────────────────────────────
    let offers: Offer[] = [];

    try {
      const apiData = await search1688Api(keyword);
      const content = (apiData as { results?: { content?: string }[] })?.results?.[0]?.content ?? "";
      offers = parseJsonApiResponse(content);
    } catch (e) {
      console.warn(`[1688] JSON API failed: ${e instanceof Error ? e.message : e}`);
    }

    // ── Step 2: Fallback to render:html (slower, costs more Oxylabs credits) ──
    if (offers.length === 0) {
      console.log("[1688] Falling back to render:html...");
      try {
        const html = await search1688Render(keyword);
        console.log(`[1688] Rendered HTML length: ${html.length}`);
        offers = parseRenderedHtml(html);
      } catch (e) {
        console.warn(`[1688] render:html failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    console.log(`[1688] Total offers found: ${offers.length}`);

    if (offers.length === 0) {
      return NextResponse.json({
        added: 0,
        message: "1688 returned 0 products — the keyword may not exist on 1688 or the page structure changed",
      });
    }

    // ── Save to queue ─────────────────────────────────────────────────────────
    const usdRate = await getExchangeRate("CNY", "USD").catch(() => 0.138);
    const batch   = db.batch();
    let added = 0;

    for (const p of offers) {
      if (!p.title || p.price < 0.5) continue;
      const { costUSD, shipping, suggested } = calcPricing(p.price, usdRate, markupPct);
      if (suggested < 8 || suggested > 800) continue;

      const docRef = queueCol(userId).doc();
      batch.set(docRef, {
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
    console.error("[1688] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}