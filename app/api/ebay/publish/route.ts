import { NextRequest, NextResponse } from "next/server";
import { createInventoryItem, createOffer, publishOffer } from "@/lib/ebay";
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

    const tokenDoc = await db.collection("tokens").doc("ebay_user").get();
    if (!tokenDoc.exists) {
      return NextResponse.json(
        { error: "eBay token not found. Connect your account in Settings." },
        { status: 401 }
      );
    }

    const userToken = tokenDoc.data()!.access_token;
    const sku = `DRPSHP-${product.ebayItemId}-${Date.now()}`;

    await createInventoryItem(
      sku,
      { title: product.title, description: product.description || product.title, images: product.images, condition: product.condition },
      product.stock,
      userToken
    );

    const offerRes = await createOffer(sku, product.suggestedSellingPrice, product.categoryId, product.description || product.title, userToken);
    const publishRes = await publishOffer(offerRes.offerId, userToken);

    const batch = db.batch();
    batch.update(docRef, { status: "published", publishedAt: Date.now(), listingId: publishRes.listingId, offerId: offerRes.offerId, sku, updatedAt: Date.now() });
    batch.set(db.collection(COLLECTIONS.PUBLISHED).doc(productId), { ...product, status: "published", publishedAt: Date.now(), listingId: publishRes.listingId, sku });
    await batch.commit();

    return NextResponse.json({ success: true, listingId: publishRes.listingId, sku });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}