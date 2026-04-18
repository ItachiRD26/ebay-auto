import { NextRequest, NextResponse } from "next/server";
import { db, COLLECTIONS, queueCol } from "@/lib/firebase";
import { getUserToken } from "@/lib/ebay";

export async function POST(req: NextRequest) {
  try {
    const { storeId, userId } = await req.json();
    if (!userId)  return NextResponse.json({ error: "userId required" },  { status: 400 });
    if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });

    let userToken: string;
    try { userToken = await getUserToken(storeId); }
    catch { return NextResponse.json({ error: "No token or token expired — reconnect your store" }, { status: 401 }); }

    // Get all published products for this store
    const snap = await queueCol(userId)
      .where("status", "==", "published")
      .where("storeId", "==", storeId)
      .get();

    const products = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as { id: string; listingId?: string; title?: string }))
      .filter(p => p.listingId);

    console.log(`[promote] Found ${products.length} published listings for store ${storeId}`);

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
              const errCode = body.match(/<ErrorCode>(\d+)<\/ErrorCode>/)?.[1] ?? "?";
              const m = body.match(/<LongMessage>(.*?)<\/LongMessage>/);
              const errMsg = m?.[1] ?? "Unknown error";
              console.warn(`[promote] ❌ ${listingId} [${errCode}]: ${errMsg.slice(0, 120)}`);
              resolve({ ok: false, error: `[${errCode}] ${errMsg}` });
            } else if (body.includes("<Ack>Success</Ack>") || body.includes("<Ack>Warning</Ack>")) {
              console.log(`[promote] ✅ ${listingId} — 2% ad applied`);
              resolve({ ok: true });
            } else {
              console.warn(`[promote] ⚠️ ${listingId} unexpected response: ${body.slice(0, 200)}`);
              resolve({ ok: false, error: "Unexpected response" });
            }
          });
        });
        req.on("error", (e) => resolve({ ok: false, error: e.message }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, error: "Timeout" }); });
        req.write(buf); req.end();
      });

    let success = 0, failed = 0;
    const updateBatch = db.batch();
    let batchOps = 0;
    for (const p of products) {
      const result = await revise(p.listingId!);
      if (result.ok) {
        success++;
        // Save bidPercentage so card shows "📢 2%" badge
        updateBatch.update(queueCol(userId).doc(p.id), { bidPercentage: 2.0, updatedAt: Date.now() });
        batchOps++;
        if (batchOps >= 400) {
          await updateBatch.commit();
          batchOps = 0;
        }
      } else failed++;
      await new Promise(r => setTimeout(r, 300));
    }
    if (batchOps > 0) await updateBatch.commit();

    console.log(`[promote] ✅ Done: ${success} ok, ${failed} failed`);
    return NextResponse.json({ success: true, updated: success, failed });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}