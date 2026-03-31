import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";

// GET — eBay redirige aquí después de autorizar (con state=storeId)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code  = searchParams.get("code");
    const error = searchParams.get("error");
    const storeId = searchParams.get("state"); // storeId encoded in state

    if (error || !code) {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/settings?error=oauth_denied`
      );
    }

    if (!storeId || !storeId.startsWith("store_")) {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/settings?error=invalid_state`
      );
    }

    const credentials = Buffer.from(
      `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
    ).toString("base64");

    const tokenRes = await fetch(
      "https://api.ebay.com/identity/v1/oauth2/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: process.env.EBAY_REDIRECT_URI!,
        }),
      }
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("Token exchange failed:", err);
      throw new Error("Token exchange failed");
    }

    const tokens = await tokenRes.json();

    // Store token under the specific storeId
    await db.collection("tokens").doc(storeId).set({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiresAt:     Date.now() + tokens.expires_in * 1000,
      createdAt:     Date.now(),
    });

    // Mark store as connected
    await db.collection("stores").doc(storeId).update({
      connected:    true,
      connectedAt:  Date.now(),
    }).catch(() => {}); // store doc might not exist if connecting manually

    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/settings?success=connected&storeId=${storeId}`
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("OAuth callback error:", msg);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/settings?error=oauth_failed`
    );
  }
}

// POST — Genera URL de autorización para un storeId específico
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const storeId = body.storeId as string;

    if (!storeId) {
      return NextResponse.json({ error: "storeId requerido" }, { status: 400 });
    }

    const scopes = [
      "https://api.ebay.com/oauth/api_scope",
      "https://api.ebay.com/oauth/api_scope/sell.inventory",
      "https://api.ebay.com/oauth/api_scope/sell.account",
      "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    ].join(" ");

    const url =
      `https://auth.ebay.com/oauth2/authorize` +
      `?client_id=${process.env.EBAY_CLIENT_ID}` +
      `&response_type=code` +
      `&redirect_uri=${process.env.EBAY_REDIRECT_URI}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&state=${storeId}`; // Pass storeId as state

    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}