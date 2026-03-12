import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";

export async function GET() {
  try {
    const tokenDoc = await db.collection("tokens").doc("ebay_user").get();
    if (!tokenDoc.exists) return NextResponse.json({ error: "No token" }, { status: 401 });
    const userToken = tokenDoc.data()!.access_token;

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <StartTimeFrom>${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}</StartTimeFrom>
  <StartTimeTo>${new Date().toISOString()}</StartTimeTo>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination><EntriesPerPage>5</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
</GetSellerListRequest>`;

    const https = await import("node:https");
    const { body } = await new Promise<{ body: string }>((resolve, reject) => {
      const buf = Buffer.from(xml, "utf-8");
      const req = https.request({
        hostname: "api.ebay.com",
        path: "/ws/api.dll",
        method: "POST",
        headers: {
          "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
          "X-EBAY-API-CALL-NAME": "GetSellerList",
          "Content-Type": "text/xml",
          "Content-Length": buf.length.toString(),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf-8") }));
      });
      req.on("error", reject);
      req.write(buf); req.end();
    });

    const items: Record<string, string>[] = [];
    const itemBlocks = body.match(/<Item>([\s\S]*?)<\/Item>/g) ?? [];
    for (const block of itemBlocks) {
      const get = (tag: string) => block.match(new RegExp(`<${tag}>(.*?)</${tag}>`))?.[1] ?? "—";
      items.push({
        ItemID:          get("ItemID"),
        Title:           get("Title"),
        Country:         get("Country"),
        Location:        get("Location"),
        PostalCode:      get("PostalCode"),
        ListingType:     get("ListingType"),
        ListingDuration: get("ListingDuration"),
        ConditionID:     get("ConditionID"),
        StartPrice:      get("StartPrice"),
        DispatchTimeMax: get("DispatchTimeMax"),
        ShipToLocations: get("ShipToLocations"),
      });
    }

    return NextResponse.json({ count: items.length, items, raw: body.slice(0, 4000) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}