import { NextRequest, NextResponse } from "next/server";
import { db, queueCol } from "@/lib/firebase";

// ─── Verify Firebase ID token via REST API ────────────────────────────────────
async function verifyFirebaseToken(idToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as { users?: { localId: string }[] };
    return data.users?.[0]?.localId ?? null;
  } catch { return null; }
}

// ─── Detect if string contains Chinese characters ─────────────────────────────
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

// ─── Translate title to English with Claude Haiku ─────────────────────────────
async function translateTitle(title: string): Promise<string> {
  if (!hasChinese(title)) return title;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [{
          role: "user",
          content: `Translate this 1688.com product title to English for an eBay listing. Return ONLY the translated title, nothing else, max 80 characters:\n\n${title}`,
        }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json() as { content?: { text: string }[] };
    const translated = data?.content?.[0]?.text?.trim() ?? title;
    console.log(`[extension] Translated: "${title.slice(0,40)}" → "${translated.slice(0,40)}"`);
    return translated;
  } catch {
    console.warn("[extension] Translation failed, keeping original");
    return title;
  }
}

// ─── POST /api/dropflow/import-extension ─────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const idToken    = authHeader.replace("Bearer ", "").trim();

    if (!idToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Verify token and get uid
    const uid = await verifyFirebaseToken(idToken);
    if (!uid) return NextResponse.json({ error: "Invalid or expired token — sign in again" }, { status: 401 });

    const body = await req.json() as {
      userId: string; storeId: string; title: string;
      price: number; suggestedPrice: number; shipping: number;
      cnyPrice?: number; images: string[]; variants?: string[];
      shopName?: string; soldCount?: number; source1688Url?: string;
    };

    if (body.userId !== uid) return NextResponse.json({ error: "User mismatch" }, { status: 403 });

    const { storeId, title, price, suggestedPrice, shipping, images, variants, shopName, soldCount, cnyPrice, source1688Url } = body;
    if (!storeId || !title || !price) return NextResponse.json({ error: "storeId, title, price required" }, { status: 400 });

    // Translate Chinese title to English
    const finalTitle = await translateTitle(title);

    const docRef = queueCol(uid).doc();
    await docRef.set({
      title:                finalTitle.slice(0, 200),
      // Fields ProductCard reads for prices
      totalMarketCost:      Math.round(price * 100) / 100,  // USD cost → "Ref. eBay" base
      suggestedSellingPrice: suggestedPrice,                 // → "Tu precio"
      ebayReferencePrice:   suggestedPrice,                  // fallback ref price
      // Raw data fields
      price:                Math.round(price * 100) / 100,
      suggestedPrice,
      shipping,
      cnyPrice:             cnyPrice ?? 0,
      images:               (images ?? []).slice(0, 10),
      variants:             variants ?? [],
      shopName:             shopName ?? "",
      soldCount:            soldCount ?? 0,
      source:               "1688-extension",
      source1688Url:        source1688Url ?? "",
      storeId,
      status:               "pending",
      createdAt:            Date.now(),
      updatedAt:            Date.now(),
    });

    console.log(`[extension] ✅ "${title.slice(0, 50)}" → ${uid} / ${storeId}`);
    return NextResponse.json({ success: true, productId: docRef.id });

  } catch (e) {
    console.error("[extension] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}