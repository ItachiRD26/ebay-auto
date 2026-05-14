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

    const docRef = queueCol(uid).doc();
    await docRef.set({
      title:         title.slice(0, 200),
      price:         Math.round(price * 100) / 100,
      suggestedPrice,
      shipping,
      cnyPrice:      cnyPrice ?? 0,
      images:        (images ?? []).slice(0, 10),
      variants:      variants ?? [],
      shopName:      shopName ?? "",
      soldCount:     soldCount ?? 0,
      source:        "1688-extension",
      source1688Url: source1688Url ?? "",
      storeId,
      status:        "pending",
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
    });

    console.log(`[extension] ✅ "${title.slice(0, 50)}" → ${uid} / ${storeId}`);
    return NextResponse.json({ success: true, productId: docRef.id });

  } catch (e) {
    console.error("[extension] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}