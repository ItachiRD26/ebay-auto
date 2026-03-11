import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";

// GET — eBay redirige aquí después de autorizar
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const error = searchParams.get("error");

    if (error || !code) {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/settings?error=oauth_denied`
      );
    }

    const credentials = Buffer.from(
      `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
    ).toString("base64");

    // ⚠️ En el token exchange se usa el RuName, NO la URL real
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
          redirect_uri: process.env.EBAY_REDIRECT_URI!, // RuName aquí
        }),
      }
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("Token exchange failed:", err);
      throw new Error("Token exchange failed");
    }

    const tokens = await tokenRes.json();

    await db.collection("tokens").doc("ebay_user").set({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      createdAt: Date.now(),
    });

    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/settings?success=connected`
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("OAuth callback error:", msg);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/settings?error=oauth_failed`
    );
  }
}

// POST — Genera URL de autorización
export async function POST() {
  const scopes = [
    "https://api.ebay.com/oauth/api_scope",
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  ].join(" ");

  // ⚠️ En la URL de autorización el redirect_uri es el RuName sin encodear
  const url =
    `https://auth.ebay.com/oauth2/authorize` +
    `?client_id=${process.env.EBAY_CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${process.env.EBAY_REDIRECT_URI}` +  // RuName sin encodeURIComponent
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=dropflow_state`;

  return NextResponse.json({ url });
}