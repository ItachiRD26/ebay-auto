import { NextRequest, NextResponse } from "next/server";

const OXYLABS_AUTH = Buffer.from(
  `${process.env.OXYLABS_USERNAME}:${process.env.OXYLABS_PASSWORD}`
).toString("base64");

// Fetch full product detail page from 1688
async function scrape1688Product(productUrl: string): Promise<string> {
  const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${OXYLABS_AUTH}` },
    body: JSON.stringify({ source: "universal", url: productUrl, render: "html", geo_location: "China" }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Oxylabs error: ${res.status}`);
  const data = await res.json() as { results?: { content?: string }[] };
  return data?.results?.[0]?.content ?? "";
}

function parseProductDetail(html: string) {
  // Extract images
  const images: string[] = [];
  const imgRegex = /https:\/\/cbu01\.alicdn\.com\/[^"'\s]+\.(?:jpg|jpeg|png)/g;
  let m;
  while ((m = imgRegex.exec(html)) !== null && images.length < 12) {
    if (!images.includes(m[0])) images.push(m[0]);
  }

  // Extract variants from JSON
  const variants: { name: string; price: number; imageUrl: string }[] = [];
  const jsonMatch = html.match(/skuMap\s*[:=]\s*(\{[\s\S]*?\})\s*[,;]/);
  if (jsonMatch) {
    try {
      const skuMap = JSON.parse(jsonMatch[1]);
      for (const [key, val] of Object.entries(skuMap)) {
        const v = val as { price?: string; imgUrl?: string };
        variants.push({
          name: key,
          price: parseFloat(v?.price ?? "0") || 0,
          imageUrl: v?.imgUrl ?? "",
        });
      }
    } catch { /* fallback */ }
  }

  // Extract title
  const titleMatch = html.match(/<title>([^<]{10,150})<\/title>/);
  const title = titleMatch?.[1]?.replace(/[-|].*$/, "").trim() ?? "";

  // Extract base price
  const priceMatch = html.match(/["']price["']\s*:\s*["'](\d+\.?\d*)["']/);
  const price = parseFloat(priceMatch?.[1] ?? "0");

  return { title, price, images, variants };
}

// POST /api/1688/product
export async function POST(req: NextRequest) {
  try {
    const { productUrl } = await req.json() as { productUrl: string };
    if (!productUrl || !productUrl.includes("1688.com"))
      return NextResponse.json({ error: "Valid 1688 product URL required" }, { status: 400 });

    const html = await scrape1688Product(productUrl);
    if (!html) return NextResponse.json({ error: "No content from Oxylabs" }, { status: 502 });

    const detail = parseProductDetail(html);
    return NextResponse.json({ success: true, ...detail });

  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}