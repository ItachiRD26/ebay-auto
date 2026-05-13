import { NextRequest, NextResponse } from "next/server";
import { db, queueCol } from "@/lib/firebase";
import { getExchangeRate } from "@/lib/currency";

// ─── Oxylabs scraper for 1688 ─────────────────────────────────────────────────
const OXYLABS_AUTH = Buffer.from(
  `${process.env.OXYLABS_USERNAME}:${process.env.OXYLABS_PASSWORD}`
).toString("base64");

async function scrape1688Search(keyword: string, page = 1): Promise<Record<string, unknown>> {
  const url = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&beginPage=${page}`;
  const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${OXYLABS_AUTH}`,
    },
    body: JSON.stringify({
      source: "universal",
      url,
      render: "html",   // 1688 needs JS rendering
      geo_location: "China",
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`Oxylabs error: ${res.status} ${await res.text().then(t => t.slice(0, 200))}`);
  return await res.json() as Record<string, unknown>;
}

// ─── Parse 1688 search results from HTML ─────────────────────────────────────
function parseSearchResults(html: string): {
  title: string; price: number; imageUrl: string;
  productUrl: string; sales: number; shopName: string;
}[] {
  const results: { title: string; price: number; imageUrl: string; productUrl: string; sales: number; shopName: string }[] = [];

  // Extract product cards — 1688 uses offer cards with data attributes
  const cardRegex = /<div[^>]+class="[^"]*offer-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  
  // Simpler approach: extract JSON data embedded in page
  const jsonMatch = html.match(/window\.__INIT_DATA__\s*=\s*({[\s\S]*?});?\s*<\/script>/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const offers = data?.data?.offerList ?? data?.offerList ?? [];
      for (const offer of offers.slice(0, 30)) {
        const price = parseFloat(offer?.priceInfo?.price ?? offer?.price ?? "0");
        if (!price) continue;
        results.push({
          title: offer?.subject ?? offer?.title ?? "",
          price,
          imageUrl: offer?.image?.imgUrl ?? offer?.imgUrl ?? "",
          productUrl: `https://detail.1688.com/offer/${offer?.offerId}.html`,
          sales: parseInt(offer?.tradeCount ?? offer?.soldCount ?? "0") || 0,
          shopName: offer?.companyName ?? offer?.shop ?? "",
        });
      }
      return results;
    } catch { /* fall through to regex parsing */ }
  }

  // Regex fallback for price and title extraction
  const titleRegex = /class="[^"]*title[^"]*"[^>]*>([^<]{10,100})</g;
  const priceRegex = /class="[^"]*price[^"]*"[^>]*>[\s\S]*?(\d+\.?\d*)/g;
  const imgRegex = /<img[^>]+src="(https:\/\/[^"]+1688[^"]*\.(?:jpg|jpeg|png|webp))[^"]*"/g;
  const linkRegex = /href="(https:\/\/detail\.1688\.com\/offer\/\d+\.html)"/g;

  const titles: string[] = [], prices: number[] = [], images: string[] = [], links: string[] = [];

  let m;
  while ((m = titleRegex.exec(html)) !== null) titles.push(m[1].trim());
  while ((m = priceRegex.exec(html)) !== null) prices.push(parseFloat(m[1]));
  while ((m = imgRegex.exec(html)) !== null && images.length < 30) images.push(m[1]);
  while ((m = linkRegex.exec(html)) !== null && links.length < 30) links.push(m[1]);

  const count = Math.min(titles.length, prices.length, 30);
  for (let i = 0; i < count; i++) {
    results.push({
      title: titles[i] ?? "",
      price: prices[i] ?? 0,
      imageUrl: images[i] ?? "",
      productUrl: links[i] ?? "",
      sales: 0,
      shopName: "",
    });
  }
  return results;
}

// ─── Convert CNY to USD and calculate suggested price ────────────────────────
function calcPricing(cnyPrice: number, usdRate: number, markupPct: number) {
  const costUSD = cnyPrice * usdRate;
  const shipping = costUSD < 5 ? 4.5 : costUSD < 15 ? 5.5 : 6.5; // rough estimate
  const ebayFee = (costUSD + shipping) * 0.135;
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
      return NextResponse.json({ error: "Oxylabs credentials not configured" }, { status: 500 });

    console.log(`[1688] Searching: "${keyword}"`);

    // Scrape 1688
    const scraped = await scrape1688Search(keyword);
    const html = (scraped as { results?: { content?: string }[] })?.results?.[0]?.content ?? "";
    if (!html) return NextResponse.json({ error: "No content from Oxylabs" }, { status: 502 });

    // Parse results
    const products = parseSearchResults(html);
    console.log(`[1688] Found ${products.length} products for "${keyword}"`);

    if (products.length === 0)
      return NextResponse.json({ added: 0, message: "No products found — try a different keyword" });

    // Get exchange rate (CNY → USD)
    const usdRate = await getExchangeRate("CNY", "USD").catch(() => 0.138); // fallback rate

    // Add to queue
    const batch = db.batch();
    let added = 0;

    for (const p of products) {
      if (!p.title || !p.price || p.price < 1) continue;

      const { costUSD, shipping, suggested } = calcPricing(p.price, usdRate, markupPct);
      if (suggested < 10 || suggested > 500) continue; // sanity check

      const docRef = queueCol(userId).doc();
      batch.set(docRef, {
        title:          p.title,
        price:          costUSD,
        suggestedPrice: suggested,
        shipping:       shipping,
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
      if (added >= 20) break; // max 20 per search
    }

    if (added > 0) await batch.commit();
    console.log(`[1688] ✅ Added ${added} products from "${keyword}"`);

    return NextResponse.json({ success: true, added, total: products.length });

  } catch (e) {
    console.error("[1688] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}