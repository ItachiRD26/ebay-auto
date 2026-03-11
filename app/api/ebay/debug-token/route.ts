import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";

export async function GET() {
  try {
    const doc = await db.collection("tokens").doc("ebay_user").get();
    if (!doc.exists) {
      return NextResponse.json({ exists: false, message: "No hay token guardado en Firestore" });
    }
    const data = doc.data()!;
    return NextResponse.json({
      exists: true,
      hasAccessToken: !!data.access_token,
      hasRefreshToken: !!data.refresh_token,
      expiresAt: data.expiresAt,
      expiresIn: Math.round((data.expiresAt - Date.now()) / 1000 / 60) + " minutos",
      isExpired: Date.now() > data.expiresAt,
      createdAt: new Date(data.createdAt).toISOString(),
      // Solo muestra los primeros chars del token para verificar que existe
      accessTokenPreview: data.access_token?.slice(0, 20) + "...",
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}