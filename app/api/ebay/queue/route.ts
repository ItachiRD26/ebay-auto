import { NextRequest, NextResponse } from "next/server";
import { db, COLLECTIONS } from "@/lib/firebase";

export async function PATCH(req: NextRequest) {
  try {
    const { productId, updates } = await req.json();
    if (!productId || !updates) {
      return NextResponse.json({ error: "productId and updates required" }, { status: 400 });
    }

    const allowed = ["status", "suggestedSellingPrice", "description", "stock", "eproloPrice", "eproloUrl", "margin", "marginPercent"];
    const safeUpdates: Record<string, any> = { updatedAt: Date.now() };
    for (const key of allowed) {
      if (key in updates) safeUpdates[key] = updates[key];
    }

    // Auto-calcular margen
    const price = safeUpdates.suggestedSellingPrice ?? updates.suggestedSellingPrice;
    const cost = safeUpdates.eproloPrice ?? updates.eproloPrice;
    if (price && cost) {
      safeUpdates.margin = parseFloat((price - cost).toFixed(2));
      safeUpdates.marginPercent = parseFloat(((safeUpdates.margin / price) * 100).toFixed(1));
    }

    await db.collection(COLLECTIONS.QUEUE).doc(productId).update(safeUpdates);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const productId = new URL(req.url).searchParams.get("productId");
    if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });
    await db.collection(COLLECTIONS.QUEUE).doc(productId).delete();
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}