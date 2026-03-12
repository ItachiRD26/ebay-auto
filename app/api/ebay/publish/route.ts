import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { publishProductById, markPublishFailed } from "@/lib/publish";

export async function POST(req: NextRequest) {
  try {
    const { productId } = await req.json();
    if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

    const tokenDoc = await db.collection("tokens").doc("ebay_user").get();
    if (!tokenDoc.exists) return NextResponse.json({ error: "eBay no conectado. Ve a /connect." }, { status: 401 });
    const userToken = tokenDoc.data()!.access_token;

    try {
      const { listingId } = await publishProductById(productId, userToken);
      return NextResponse.json({ success: true, listingId });
    } catch (publishError: unknown) {
      const reason = publishError instanceof Error ? publishError.message : String(publishError);
      await markPublishFailed(productId, reason);
      return NextResponse.json({ error: reason, failed: true }, { status: 500 });
    }

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[publish] ❌", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}