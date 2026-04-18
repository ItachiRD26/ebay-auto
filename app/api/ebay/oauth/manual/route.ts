import { NextRequest, NextResponse } from "next/server";
import { db, storesCol } from "@/lib/firebase";

export async function POST(req: NextRequest) {
  try {
    const { code, storeId, userId } = await req.json();

    if (!code)    return NextResponse.json({ error: "code requerido" },    { status: 400 });
    if (!storeId) return NextResponse.json({ error: "storeId requerido" }, { status: 400 });
    if (!userId)  return NextResponse.json({ error: "userId requerido" },  { status: 400 });

    const credentials = Buffer.from(
      `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
    ).toString("base64");

    const tokenRes = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: process.env.EBAY_REDIRECT_URI!,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Token exchange failed: ${err.slice(0, 200)}`);
    }

    const tokens = await tokenRes.json();

    // Token stored at root level keyed by storeId — accessible by server only
    await db.collection("tokens").doc(storeId).set({
      access_token:       tokens.access_token,
      refresh_token:      tokens.refresh_token,
      expiresAt:          Date.now() + tokens.expires_in * 1000,
      createdAt:          Date.now(),
      userId,
      tokenExpiredAt:     null,    // clear any previous expiry flag
      tokenExpiredReason: null,
    });

    // Mark store as connected in the USER'S subcollection
    await storesCol(userId).doc(storeId).update({
      connected:   true,
      connectedAt: Date.now(),
    });

    return NextResponse.json({ success: true, storeId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}