import { NextRequest, NextResponse } from "next/server";
import { getReferenceItemData, getUserToken } from "@/lib/ebay";
import { queueCol, settingsDoc } from "@/lib/firebase";
import { generateTitleAndDescription } from "@/lib/publish";
import { getVerifiedLeafCategory, CATEGORY_TYPES, detectTypeFromTitle } from "@/lib/category-aspects";

async function getStorePolicies(userId: string, storeId: string) {
  try {
    const snap = await settingsDoc(userId, "main").get();
    const data = snap.data() as Record<string, unknown> | undefined;
    const policies = data?.policies as Record<string, Record<string, string>> | undefined;
    const p = policies?.[storeId];
    if (p?.fulfillmentPolicyId) return p;
  } catch { /* fallback */ }
  return {
    fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID ?? "",
    paymentPolicyId:     process.env.EBAY_PAYMENT_POLICY_ID     ?? "",
    returnPolicyId:      process.env.EBAY_RETURN_POLICY_ID      ?? "",
    merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY ?? "",
  };
}

export async function POST(req: NextRequest) {
  try {
    const { productId, storeId, userId } = await req.json() as {
      productId: string; storeId: string; userId: string;
    };
    if (!productId || !storeId || !userId)
      return NextResponse.json({ error: "productId, storeId, userId required" }, { status: 400 });

    // ── Load product ──────────────────────────────────────────────────────────
    const docRef  = queueCol(userId).doc(productId);
    const doc     = await docRef.get();
    if (!doc.exists) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    const product = doc.data()!;

    // ── GetItem ref ───────────────────────────────────────────────────────────
    let userToken: string;
    try { userToken = await getUserToken(storeId); }
    catch { return NextResponse.json({ error: "Store not connected" }, { status: 400 }); }

    const rawId     = String(product.ebayItemId ?? "");
    const numericId = rawId.split("|")[1] ?? rawId;
    const refData   = await getReferenceItemData(numericId, userToken);

    const refAspects    = refData?.aspects ?? {};
    const refCategoryId = refData?.categoryId ?? product.categoryId;
    const refImages     = (refData?.imageUrls ?? product.images ?? []).slice(0, 12);
    const refVariations = refData?.variations ?? null;

    // ── Claude rewrites title + description ───────────────────────────────────
    const { title: draftTitle, description: draftDesc } =
      await generateTitleAndDescription(product.title as string, refAspects);

    // ── Markup ────────────────────────────────────────────────────────────────
    const markupPercent = (product.markupPercent as number | undefined) ?? 6;
    const markupRatio   = 1 + markupPercent / 100;
    const price         = refVariations?.variations[0]?.refPrice
      ? +(refVariations.variations[0].refPrice * markupRatio).toFixed(2)
      : +((product.suggestedSellingPrice as number ?? 30) * markupRatio).toFixed(2);

    const policies = await getStorePolicies(userId, storeId);

    // ── Try Inventory API (create UNPUBLISHED offer = draft) ──────────────────
    try {
      const sku = `DROPFLOW-${productId.slice(0, 12)}`;

      // Step 1: createOrReplaceInventoryItem
      const invRes = await fetch(
        `https://api.ebay.com/sell/inventory/v1/inventory_item/${sku}`,
        {
          method: "PUT",
          headers: {
            Authorization:  `Bearer ${userToken}`,
            "Content-Type": "application/json",
            "Content-Language": "en-US",
          },
          body: JSON.stringify({
            product: {
              title:       draftTitle,
              description: draftDesc,
              imageUrls:   refImages,
              aspects:     Object.fromEntries(
                Object.entries(refAspects).map(([k, v]) => [k, v as string[]])
              ),
            },
            condition:         "NEW",
            availability: {
              shipToLocationAvailability: { quantity: product.stock ?? 1 },
            },
          }),
          signal: AbortSignal.timeout(15000),
        }
      );

      if (!invRes.ok && invRes.status !== 204) {
        const errTxt = await invRes.text();
        throw new Error(`Inventory API ${invRes.status}: ${errTxt.slice(0, 100)}`);
      }

      // Step 2: createOffer (UNPUBLISHED = draft visible in Seller Hub)
      const categoryType = CATEGORY_TYPES[refCategoryId] ?? detectTypeFromTitle(draftTitle);
      const leafCat = await getVerifiedLeafCategory(draftTitle, refCategoryId);

      const offerRes = await fetch(
        "https://api.ebay.com/sell/inventory/v1/offer",
        {
          method: "POST",
          headers: {
            Authorization:  `Bearer ${userToken}`,
            "Content-Type": "application/json",
            "Content-Language": "en-US",
          },
          body: JSON.stringify({
            sku,
            marketplaceId:         "EBAY_US",
            format:                "FIXED_PRICE",
            listingDescription:    draftDesc,
            availableQuantity:     product.stock ?? 1,
            categoryId:            leafCat.id,
            listingPolicies: {
              fulfillmentPolicyId: policies.fulfillmentPolicyId,
              paymentPolicyId:     policies.paymentPolicyId,
              returnPolicyId:      policies.returnPolicyId,
            },
            merchantLocationKey:   policies.merchantLocationKey ?? "",
            pricingSummary: {
              price: { value: String(price), currency: "USD" },
            },
            includeCatalogProductDetails: false,
          }),
          signal: AbortSignal.timeout(15000),
        }
      );

      if (!offerRes.ok) {
        const errTxt = await offerRes.text();
        throw new Error(`createOffer ${offerRes.status}: ${errTxt.slice(0, 150)}`);
      }

      const offerData = await offerRes.json() as { offerId?: string };
      const offerId   = offerData.offerId;

      // Save draft info to Firestore
      await docRef.update({
        status:     "approved",
        draftSku:   sku,
        offerId,
        draftTitle,
        updatedAt:  Date.now(),
      });

      console.log(`[draft] ✅ Draft created in eBay Seller Hub — offerId=${offerId}`);
      return NextResponse.json({
        success: true,
        mode:    "ebay_draft",
        offerId,
        sellerHubUrl: "https://www.ebay.com/sh/lst/active",
        message: `Draft creado en eBay Seller Hub. Búscalo en Listings → Drafts y publícalo desde ahí.`,
      });

    } catch (invErr) {
      // ── Fallback: save prepared data to Firestore for manual review ──────────
      console.warn("[draft] Inventory API failed, saving to Firestore:", invErr);

      const draftData = {
        draftTitle,
        draftDesc,
        draftPrice:    price,
        draftCategory: refCategoryId,
        draftAspects:  refAspects,
        draftImages:   refImages,
        draftVariations: refVariations ? {
          count: refVariations.variations.length,
          dimensions: Object.keys(refVariations.specificsSet),
        } : null,
        draftCreatedAt: Date.now(),
        draftStoreId:   storeId,
      };

      await docRef.update({ ...draftData, status: "approved", updatedAt: Date.now() });

      // Build eBay Sell page URL with pre-filled title
      const sellUrl = `https://www.ebay.com/sl/list?title=${encodeURIComponent(draftTitle)}&CategoryID=${refCategoryId}`;

      return NextResponse.json({
        success:  true,
        mode:     "firestore_draft",
        draftData,
        sellUrl,
        message:  `Datos preparados. Inventory API no disponible — usa el link para pre-llenar el listing en eBay.`,
      });
    }

  } catch (e) {
    console.error("[draft] ❌", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}