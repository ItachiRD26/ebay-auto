import { NextRequest, NextResponse } from "next/server";
import { queueCol, seenCol } from "@/lib/firebase";

export async function PATCH(req: NextRequest) {
  try {
    const { productId, updates, userId } = await req.json();
    if (!productId || !updates) return NextResponse.json({ error: "productId and updates required" }, { status: 400 });
    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

    const allowed = ["status", "suggestedSellingPrice", "description", "stock", "eproloPrice", "eproloUrl", "margin", "marginPercent"];
    const safeUpdates: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of allowed) {
      if (key in updates) safeUpdates[key] = updates[key];
    }

    // Auto-calculate margin
    const price = safeUpdates.suggestedSellingPrice ?? updates.suggestedSellingPrice;
    const cost  = safeUpdates.eproloPrice ?? updates.eproloPrice;
    if (price && cost) {
      safeUpdates.margin        = parseFloat((price - cost).toFixed(2));
      safeUpdates.marginPercent = parseFloat(((safeUpdates.margin as number / price) * 100).toFixed(1));
    }

    await queueCol(userId).doc(productId).update(safeUpdates);

    // When rejecting: write to seen_items so it never shows up again, then delete from queue
    if (updates.status === "rejected") {
      const productDoc = await queueCol(userId).doc(productId).get();
      const product = productDoc.data() as Record<string, unknown> | undefined;
      const ebayItemId = product?.ebayItemId ? String(product.ebayItemId).split("|")[1] ?? String(product.ebayItemId) : null;
      if (ebayItemId) {
        await seenCol(userId).doc(ebayItemId).set({
          ebayItemId,
          title:     product?.title ?? "",
          reason:    "rejected",
          seenAt:    Date.now(),
          productId,
        });
      }
      // Delete from queue to save space — seen_items keeps the memory
      await queueCol(userId).doc(productId).delete();
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const productId = searchParams.get("productId");
    const userId    = searchParams.get("userId");
    if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });
    if (!userId)    return NextResponse.json({ error: "userId required" }, { status: 400 });

    await queueCol(userId).doc(productId).delete();
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}