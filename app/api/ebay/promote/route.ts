import { NextResponse } from "next/server";
import { db, COLLECTIONS } from "@/lib/firebase";

export async function POST() {
  try {
    const tokenDoc = await db.collection("tokens").doc("ebay_user").get();
    if (!tokenDoc.exists) return NextResponse.json({ error: "No token" }, { status: 401 });
    const userToken = tokenDoc.data()!.access_token;

    // Get all published products with a listingId
    const snap = await db.collection(COLLECTIONS.QUEUE)
      .where("status", "==", "published")
      .get();

    const products = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as { id: string; listingId?: string; title?: string }))
      .filter(p => p.listingId);

    console.log(`[promote] Found ${products.length} published listings`);

    const https = await import("node:https");

    const revise = (listingId: string): Promise<{ ok: boolean; error?: string }> =>
      new Promise((resolve) => {
        const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <Item>
    <ItemID>${listingId}</ItemID>
    <PromotedListingDetails>
      <BidPercentage>2.0</BidPercentage>
      <PromotionMethod>COST_PER_SALE</PromotionMethod>
    </PromotedListingDetails>
  </Item>
</ReviseFixedPriceItemRequest>`;

        const buf = Buffer.from(xml, "utf-8");
        const req = https.request({
          hostname: "api.ebay.com", path: "/ws/api.dll", method: "POST",
          headers: {
            "X-EBAY-API-SITEID": "0",
            "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
            "X-EBAY-API-CALL-NAME": "ReviseFixedPriceItem",
            "Content-Type": "text/xml",
            "Content-Length": buf.length.toString(),
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf-8");
            if (body.includes("<Ack>Failure</Ack>")) {
              const m = body.match(/<LongMessage>(.*?)<\/LongMessage>/);
              resolve({ ok: false, error: m?.[1] ?? "Unknown error" });
            } else {
              resolve({ ok: true });
            }
          });
        });
        req.on("error", (e) => resolve({ ok: false, error: e.message }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, error: "Timeout" }); });
        req.write(buf); req.end();
      });

    let success = 0, failed = 0;
    for (const p of products) {
      const result = await revise(p.listingId!);
      if (result.ok) {
        success++;
        console.log(`[promote] ✅ ${p.listingId} — ${p.title?.slice(0, 40)}`);
      } else {
        failed++;
        console.warn(`[promote] ❌ ${p.listingId} — ${result.error}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[promote] Done — ✅ ${success} | ❌ ${failed}`);
    return NextResponse.json({ success: true, updated: success, failed });

  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}