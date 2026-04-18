import { NextRequest, NextResponse } from "next/server";
import { queueCol, db } from "@/lib/firebase";
import { getUserToken } from "@/lib/ebay";

// ─── eBay Marketing API — Promoted Listings Standard (General campaign) ───────
// Uses sell/marketing/v1 REST API which correctly creates/updates ad campaigns.
// The Trading API ReviseFixedPriceItem approach was accepted but didn't apply ads.

async function getOrCreateCampaign(token: string): Promise<string | null> {
  // List existing campaigns
  const res = await fetch(
    "https://api.ebay.com/sell/marketing/v1/ad_campaign?campaign_type=COST_PER_SALE&limit=10",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    }
  );

  if (res.ok) {
    const data = await res.json() as { campaigns?: { campaignId: string; campaignStatus: string; campaignName: string }[] };
    const active = data.campaigns?.find(c => c.campaignStatus === "RUNNING");
    if (active) {
      console.log(`[promote] Using existing campaign: ${active.campaignId} (${active.campaignName})`);
      return active.campaignId;
    }
  }

  // No active campaign — create one
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const createRes = await fetch("https://api.ebay.com/sell/marketing/v1/ad_campaign", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    body: JSON.stringify({
      campaignName: `DropFlow Auto Ads ${new Date().toISOString().slice(0, 10)}`,
      campaignType: "COST_PER_SALE",
      startDate: tomorrow,
      fundingStrategy: {
        biddingStrategy: "FIXED",
        bidPercentage: "2.0",
      },
      marketplaceId: "EBAY_US",
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    console.error(`[promote] Failed to create campaign: ${createRes.status} ${err.slice(0, 200)}`);
    return null;
  }

  const loc = createRes.headers.get("Location") ?? "";
  const campaignId = loc.split("/").pop() ?? "";
  if (!campaignId) {
    const body = await createRes.json() as { campaignId?: string };
    return body.campaignId ?? null;
  }
  console.log(`[promote] Created new campaign: ${campaignId}`);
  return campaignId || null;
}

async function addAdsToCampaign(
  campaignId: string,
  listings: { listingId: string; bidPercent: string }[],
  token: string
): Promise<{ success: number; failed: number }> {
  // Bulk create ads — max 500 per request
  const CHUNK = 500;
  let success = 0, failed = 0;

  for (let i = 0; i < listings.length; i += CHUNK) {
    const chunk = listings.slice(i, i + CHUNK);
    const body = {
      requests: chunk.map(l => ({
        listingId: l.listingId,
        bidPercentage: l.bidPercent,
      })),
    };

    const res = await fetch(
      `https://api.ebay.com/sell/marketing/v1/ad_campaign/${campaignId}/bulk_create_ads_by_listing_id`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error(`[promote] bulk_create_ads failed: ${res.status} ${err.slice(0, 200)}`);
      failed += chunk.length;
      continue;
    }

    const data = await res.json() as {
      responses?: { listingId: string; errors?: unknown[] }[];
    };

    for (const r of data.responses ?? []) {
      if (r.errors && (r.errors as unknown[]).length > 0) failed++;
      else success++;
    }
  }

  return { success, failed };
}

export async function POST(req: NextRequest) {
  try {
    const { storeId, userId } = await req.json() as { storeId: string; userId: string };
    if (!userId)  return NextResponse.json({ error: "userId required" },  { status: 400 });
    if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });

    let token: string;
    try { token = await getUserToken(storeId); }
    catch { return NextResponse.json({ error: "Token expired — reconnect your store" }, { status: 401 }); }

    // Get all published products for this store
    const snap = await queueCol(userId)
      .where("status", "==", "published")
      .where("storeId", "==", storeId)
      .get();

    const products = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as { id: string; listingId?: string }))
      .filter(p => p.listingId);

    if (!products.length) {
      return NextResponse.json({ success: true, updated: 0, message: "No published listings found" });
    }

    console.log(`[promote] ${products.length} listings to promote for store ${storeId}`);

    // Get or create campaign
    const campaignId = await getOrCreateCampaign(token);
    if (!campaignId) {
      return NextResponse.json({ error: "Could not get or create eBay ad campaign" }, { status: 500 });
    }

    // Add all listings to campaign at 2%
    const listings = products.map(p => ({ listingId: p.listingId!, bidPercent: "2.0" }));
    const { success, failed } = await addAdsToCampaign(campaignId, listings, token);

    // Save bidPercentage to Firestore for successful ones (batch)
    if (success > 0) {
      const batch = db.batch();
      let ops = 0;
      for (const p of products) {
        batch.update(queueCol(userId).doc(p.id), { bidPercentage: 2.0, updatedAt: Date.now() });
        ops++;
        if (ops >= 400) { await batch.commit(); ops = 0; }
      }
      if (ops > 0) await batch.commit();
    }

    console.log(`[promote] Done: ${success} ok, ${failed} failed, campaignId=${campaignId}`);
    return NextResponse.json({ success: true, updated: success, failed, campaignId });

  } catch (e) {
    console.error("[promote] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}