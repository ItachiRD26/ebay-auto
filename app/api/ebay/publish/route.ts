import { NextRequest, NextResponse } from "next/server";
import { getReferenceItemData } from "@/lib/ebay";
import { db, COLLECTIONS } from "@/lib/firebase";

// ─── Trading API: AddFixedPriceItem ──────────────────────────────────────────
// Uses the same SOAP/XML API as GetItem — no Content-Language issues.
// Copies ItemSpecifics directly from the reference listing.

async function addFixedPriceItem(
  product: {
    title: string;
    description: string;
    categoryId: string;
    price: number;
    stock: number;
    images: string[];
    condition: string;
    aspects: Record<string, string[]>;
  },
  userToken: string
): Promise<{ itemId: string }> {
  // Build ItemSpecifics XML
  const specificsXml = Object.entries(product.aspects)
    .map(([name, values]) =>
      values.map(v => `<NameValueList><Name>${escXml(name)}</Name><Value>${escXml(v)}</Value></NameValueList>`).join("")
    ).join("");

  // Build PictureURL XML (max 12)
  const picturesXml = product.images.slice(0, 12)
    .map(url => `<PictureURL>${escXml(url)}</PictureURL>`).join("");

  // Condition ID mapping
  const conditionIdMap: Record<string, string> = {
    "New": "1000", "New with tags": "1000", "New with box": "1000",
    "New without tags": "1500", "New without box": "1500",
    "Like New": "2500", "Used": "3000",
  };
  const conditionId = conditionIdMap[product.condition] ?? "1000";

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <Item>
    <Title>${escXml(product.title.slice(0, 80))}</Title>
    <Description><![CDATA[${product.description || product.title}]]></Description>
    <PrimaryCategory><CategoryID>${product.categoryId}</CategoryID></PrimaryCategory>
    <StartPrice>${product.price.toFixed(2)}</StartPrice>
    <CategoryMappingAllowed>true</CategoryMappingAllowed>
    <ConditionID>${conditionId}</ConditionID>
    <Country>CN</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>7</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Quantity>${product.stock}</Quantity>
    <PictureDetails>${picturesXml}</PictureDetails>
    <ItemSpecifics>${specificsXml}</ItemSpecifics>
    <SellerProfiles>
      <SellerShippingProfile>
        <ShippingProfileID>${process.env.EBAY_FULFILLMENT_POLICY_ID}</ShippingProfileID>
      </SellerShippingProfile>
      <SellerReturnProfile>
        <ReturnProfileID>${process.env.EBAY_RETURN_POLICY_ID}</ReturnProfileID>
      </SellerReturnProfile>
      <SellerPaymentProfile>
        <PaymentProfileID>${process.env.EBAY_PAYMENT_POLICY_ID}</PaymentProfileID>
      </SellerPaymentProfile>
    </SellerProfiles>
    <Site>US</Site>
  </Item>
</AddFixedPriceItemRequest>`;

  const https = await import("node:https");
  const { statusCode, body } = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const bodyBuf = Buffer.from(xml, "utf-8");
    const req = https.request({
      hostname: "api.ebay.com",
      path: "/ws/api.dll",
      method: "POST",
      headers: {
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "AddFixedPriceItem",
        "Content-Type": "text/xml",
        "Content-Length": bodyBuf.length.toString(),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(bodyBuf);
    req.end();
  });

  if (statusCode !== 200) throw new Error(`AddFixedPriceItem HTTP ${statusCode}`);
  if (body.includes("<Ack>Failure</Ack>")) {
    const errMatch = body.match(/<LongMessage>(.*?)<\/LongMessage>/);
    throw new Error(`AddFixedPriceItem failed: ${errMatch?.[1] ?? body.slice(0, 300)}`);
  }

  const itemMatch = body.match(/<ItemID>(\d+)<\/ItemID>/);
  if (!itemMatch) throw new Error("No ItemID in response: " + body.slice(0, 300));
  return { itemId: itemMatch[1] };
}

function escXml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

// ─── POST /api/ebay/publish ───────────────────────────────────────────────────
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
      return NextResponse.json({ error: "eBay no conectado. Ve a /connect." }, { status: 401 });
    }
    const userToken = tokenDoc.data()!.access_token;

    // Fetch reference item aspects
    let refAspects: Record<string, string[]> = {};
    let refDescription = product.description || product.title;
    let refImages: string[] = product.images ?? [];
    let refCategoryId = product.categoryId;

    if (product.ebayItemId) {
      console.log(`[publish] Fetching reference data for ${product.ebayItemId}...`);
      const refData = await getReferenceItemData(product.ebayItemId, userToken);
      if (refData) {
        refAspects = refData.aspects;
        if (refData.description) refDescription = refData.description;
        if (refData.categoryId) refCategoryId = refData.categoryId;
        const merged = [...refImages];
        refData.imageUrls.forEach(u => { if (!merged.includes(u)) merged.push(u); });
        refImages = merged.slice(0, 12);
        console.log(`[publish] Got ${Object.keys(refAspects).length} aspects`);
      }
    }

    // Publish via Trading API AddFixedPriceItem
    const { itemId } = await addFixedPriceItem({
      title:       product.title,
      description: refDescription,
      categoryId:  refCategoryId,
      price:       product.suggestedSellingPrice,
      stock:       product.stock ?? 1,
      images:      refImages,
      condition:   product.condition ?? "New",
      aspects:     refAspects,
    }, userToken);

    // Update Firestore
    const batch = db.batch();
    batch.update(docRef, { status: "published", publishedAt: Date.now(), listingId: itemId, updatedAt: Date.now() });
    batch.set(db.collection(COLLECTIONS.PUBLISHED).doc(productId), {
      ...product, status: "published", publishedAt: Date.now(), listingId: itemId,
    });
    await batch.commit();

    console.log(`[publish] ✅ Listed! itemId=${itemId}`);
    return NextResponse.json({ success: true, listingId: itemId });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[publish] ❌", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}