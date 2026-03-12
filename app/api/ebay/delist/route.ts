import { NextRequest, NextResponse } from "next/server";
import { db, COLLECTIONS } from "@/lib/firebase";

export async function POST(req: NextRequest) {
  try {
    const { productId, listingId } = await req.json();
    if (!productId || !listingId) return NextResponse.json({ error: "productId y listingId requeridos" }, { status: 400 });

    const tokenDoc = await db.collection("tokens").doc("ebay_user").get();
    if (!tokenDoc.exists) return NextResponse.json({ error: "No token" }, { status: 401 });
    const userToken = tokenDoc.data()!.access_token;

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <ItemID>${listingId}</ItemID>
  <EndingReason>NotAvailable</EndingReason>
</EndFixedPriceItemRequest>`;

    const https = await import("node:https");
    const { body } = await new Promise<{ body: string }>((resolve, reject) => {
      const buf = Buffer.from(xml, "utf-8");
      const req = https.request({
        hostname: "api.ebay.com", path: "/ws/api.dll", method: "POST",
        headers: {
          "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
          "X-EBAY-API-CALL-NAME": "EndFixedPriceItem",
          "Content-Type": "text/xml",
          "Content-Length": buf.length.toString(),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf-8") }));
      });
      req.on("error", reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
      req.write(buf); req.end();
    });

    if (body.includes("<Ack>Failure</Ack>")) {
      const m = body.match(/<LongMessage>(.*?)<\/LongMessage>/);
      return NextResponse.json({ error: m?.[1] ?? "Error al deslistar" }, { status: 500 });
    }

    // Update Firestore — move back to rejected
    await db.collection(COLLECTIONS.QUEUE).doc(productId).update({
      status: "rejected",
      listingId: null,
      delistedAt: Date.now(),
      updatedAt: Date.now(),
    });

    console.log(`[delist] ✅ ${listingId} eliminado`);
    return NextResponse.json({ success: true });

  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}