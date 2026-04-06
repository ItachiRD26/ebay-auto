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

export async function POST(req: NextRequest) {
  // Bulk reject — rejects ALL products of a given status for a user.
  // Runs entirely server-side via Firestore query, not limited by frontend pagination.
  try {
    const { action, status, userId } = await req.json() as {
      action: string;
      status: string;
      userId: string;
    };

    if (action !== "reject_all") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    if (!status) return NextResponse.json({ error: "status required" }, { status: 400 });
    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

    const ALLOWED_STATUSES = ["pending", "approved", "failed"];
    if (!ALLOWED_STATUSES.includes(status)) {
      return NextResponse.json({ error: `Cannot bulk-reject status "${status}"` }, { status: 400 });
    }

    // Query ALL matching docs — no pagination limit
    const snap = await queueCol(userId).where("status", "==", status).get();
    if (snap.empty) return NextResponse.json({ success: true, rejected: 0 });

    // Firestore batch limit is 500 ops — chunk into batches
    const { db } = await import("@/lib/firebase");
    const BATCH_SIZE = 400; // leave headroom (delete + seenCol set = 2 ops per item)
    const docs = snap.docs;
    let rejected = 0;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const chunk = docs.slice(i, i + BATCH_SIZE);
      const batch = db.batch();

      for (const doc of chunk) {
        const product = doc.data() as Record<string, unknown>;
        const ebayItemId = product?.ebayItemId
          ? String(product.ebayItemId).split("|")[1] ?? String(product.ebayItemId)
          : null;

        // Write to seen_items so this product never appears in search again
        if (ebayItemId) {
          const seenRef = seenCol(userId).doc(ebayItemId);
          batch.set(seenRef, {
            ebayItemId,
            title:     product?.title ?? "",
            reason:    "rejected",
            seenAt:    Date.now(),
            productId: doc.id,
          });
        }

        // Delete from queue
        batch.delete(doc.ref);
        rejected++;
      }

      await batch.commit();
      console.log(`[queue] bulk reject: committed ${rejected}/${docs.length}`);
    }

    return NextResponse.json({ success: true, rejected });
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