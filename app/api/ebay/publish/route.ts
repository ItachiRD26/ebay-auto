// publish route — eBay Inventory API flow
import { NextRequest, NextResponse } from "next/server";
import { createInventoryItem, createOffer, publishOffer, getReferenceItemData } from "@/lib/ebay";
import { db, COLLECTIONS } from "@/lib/firebase";

export async function POST(req: NextRequest) {
  try {
    const { productId } = await req.json();
    if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

    const docRef = db.collection(COLLECTIONS.QUEUE).doc(productId);
    const doc = await docRef.get();
    if (!doc.exists) return NextResponse.json({ error: "Product not found" }, { status: 404 });

    const product = doc.data()!;
    if (product.status !== "approved") {
      return NextResponse.json({ error: "Product must be approved first" }, { status: 400 });
    }

    // ── Get user token ─────────────────────────────────────────────────────────
    const tokenDoc = await db.collection("tokens").doc("ebay_user").get();
    if (!tokenDoc.exists) {
      return NextResponse.json(
        { error: "eBay no conectado. Ve a /connect." },
        { status: 401 }
      );
    }
    const userToken = tokenDoc.data()!.access_token;

    // ── Fetch reference item data (aspects, description, images) ──────────────
    // We copy item specifics from the reference Chinese listing so our listing
    // passes eBay's category requirements automatically — same strategy as
    // "Sell One Like This" but fully programmatic.
    let refAspects: Record<string, string[]> = {};
    let refDescription = product.description || product.title;
    let refImages: string[] = product.images ?? [];

    if (product.ebayItemId) {
      console.log(`[publish] Fetching reference item data for ${product.ebayItemId}...`);
      const refData = await getReferenceItemData(product.ebayItemId, userToken);
      if (refData) {
        refAspects     = refData.aspects;
        refDescription = refData.description || refDescription;
        // Merge images: prefer our saved ones, supplement with reference
        const merged = [...refImages];
        refData.imageUrls.forEach((u) => { if (!merged.includes(u)) merged.push(u); });
        refImages = merged.slice(0, 12);
        console.log(`[publish] Got ${Object.keys(refAspects).length} aspects from reference listing`);
      } else {
        console.warn(`[publish] Could not fetch reference data, proceeding without aspects`);
      }
    }

    // ── Create inventory item ─────────────────────────────────────────────────
    const sku = `DRPSHP-${product.ebayItemId}-${Date.now()}`;

    await createInventoryItem(
      sku,
      {
        title:       product.title,
        description: refDescription,
        images:      refImages,
        condition:   product.condition ?? "New",
        aspects:     refAspects,
      },
      product.stock ?? 1,
      userToken
    );

    // ── Create offer ──────────────────────────────────────────────────────────
    const offerRes = await createOffer(
      sku,
      product.suggestedSellingPrice,
      product.categoryId,
      refDescription,
      userToken
    );

    // ── Publish offer (make listing live) ─────────────────────────────────────
    const publishRes = await publishOffer(offerRes.offerId, userToken);

    // ── Update Firestore ──────────────────────────────────────────────────────
    const batch = db.batch();
    batch.update(docRef, {
      status:      "published",
      publishedAt: Date.now(),
      listingId:   publishRes.listingId,
      offerId:     offerRes.offerId,
      sku,
      updatedAt:   Date.now(),
    });
    batch.set(db.collection(COLLECTIONS.PUBLISHED).doc(productId), {
      ...product,
      status:      "published",
      publishedAt: Date.now(),
      listingId:   publishRes.listingId,
      sku,
    });
    await batch.commit();

    console.log(`[publish] ✅ Published: listingId=${publishRes.listingId} sku=${sku}`);
    return NextResponse.json({ success: true, listingId: publishRes.listingId, sku });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[publish] ❌ Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}