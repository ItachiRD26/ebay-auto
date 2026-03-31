import { NextRequest, NextResponse } from "next/server";
import { getUserToken } from "@/lib/ebay";

// ─── GET: Fetch all existing policies + inventory locations ──────────────────
// Usage: GET /api/ebay/setup?storeId=store_xxx
// Call this once to discover the policy IDs you need for your .env
export async function GET(req: NextRequest) {
  try {
    const storeId = new URL(req.url).searchParams.get("storeId");
    if (!storeId) return NextResponse.json({ error: "storeId requerido como query param" }, { status: 400 });

    const token = await getUserToken(storeId);

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    };

    const [fulfillmentRes, paymentRes, returnRes, locationRes] = await Promise.all([
      fetch("https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US", { headers }),
      fetch("https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US",    { headers }),
      fetch("https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US",     { headers }),
      fetch("https://api.ebay.com/sell/inventory/v1/location",                                { headers }),
    ]);

    const [fulfillmentData, paymentData, returnData, locationData] = await Promise.all([
      fulfillmentRes.json(),
      paymentRes.json(),
      returnRes.json(),
      locationRes.json(),
    ]);

    const fulfillmentPolicies = (fulfillmentData.fulfillmentPolicies ?? []).map(
      (p: { fulfillmentPolicyId: string; name: string; marketplaceId: string }) => ({
        id: p.fulfillmentPolicyId, name: p.name, marketplace: p.marketplaceId,
      })
    );
    const paymentPolicies = (paymentData.paymentPolicies ?? []).map(
      (p: { paymentPolicyId: string; name: string; marketplaceId: string }) => ({
        id: p.paymentPolicyId, name: p.name, marketplace: p.marketplaceId,
      })
    );
    const returnPolicies = (returnData.returnPolicies ?? []).map(
      (p: { returnPolicyId: string; name: string; marketplaceId: string }) => ({
        id: p.returnPolicyId, name: p.name, marketplace: p.marketplaceId,
      })
    );
    const locations = (locationData.locations ?? []).map(
      (l: { merchantLocationKey: string; name?: string; location?: { address?: { country?: string; postalCode?: string } }; locationStatus?: string }) => ({
        key: l.merchantLocationKey, name: l.name ?? "(sin nombre)",
        country: l.location?.address?.country ?? "", postalCode: l.location?.address?.postalCode ?? "",
        status: l.locationStatus ?? "",
      })
    );

    const suggestedEnv = buildEnvSuggestion(fulfillmentPolicies, paymentPolicies, returnPolicies, locations);

    return NextResponse.json({
      fulfillmentPolicies, paymentPolicies, returnPolicies, locations, suggestedEnv,
      _errors: {
        fulfillment: fulfillmentRes.ok ? null : `HTTP ${fulfillmentRes.status}`,
        payment:     paymentRes.ok     ? null : `HTTP ${paymentRes.status}`,
        return:      returnRes.ok      ? null : `HTTP ${returnRes.status}`,
        location:    locationRes.ok    ? null : `HTTP ${locationRes.status}`,
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── POST: Create a new inventory location ────────────────────────────────────
// Body: { storeId, locationKey, name, postalCode, country? }
export async function POST(req: NextRequest) {
  try {
    const { storeId, locationKey, name, postalCode, country = "US" } = await req.json();

    if (!storeId)     return NextResponse.json({ error: "storeId requerido" },     { status: 400 });
    if (!locationKey) return NextResponse.json({ error: "locationKey requerido" }, { status: 400 });
    if (!postalCode)  return NextResponse.json({ error: "postalCode requerido" },  { status: 400 });

    const token = await getUserToken(storeId);

    const res = await fetch(
      `https://api.ebay.com/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Language": "en-US",
        },
        body: JSON.stringify({
          name: name ?? locationKey,
          locationTypes: ["WAREHOUSE"],
          location: { address: { country, postalCode } },
          merchantLocationStatus: "ENABLED",
        }),
      }
    );

    if (!res.ok && res.status !== 204) {
      const err = await res.text();
      return NextResponse.json({ error: `eBay error (${res.status}): ${err.slice(0, 300)}` }, { status: res.status });
    }

    return NextResponse.json({
      success: true, locationKey,
      message: `Location "${locationKey}" creada. Agrégala a tu .env como EBAY_MERCHANT_LOCATION_KEY=${locationKey}`,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function buildEnvSuggestion(
  fulfillment: { id: string; name: string }[],
  payment: { id: string; name: string }[],
  returnP: { id: string; name: string }[],
  locations: { key: string; name: string }[]
): string {
  const f = fulfillment[0], p = payment[0], r = returnP[0], l = locations[0];
  const lines = [
    "# ── Pega esto en tu .env ──────────────────────────────────────",
    `EBAY_FULFILLMENT_POLICY_ID=${f ? f.id : "⚠️  NO ENCONTRADO"}`,
    `EBAY_PAYMENT_POLICY_ID=${p ? p.id : "⚠️  NO ENCONTRADO"}`,
    `EBAY_RETURN_POLICY_ID=${r ? r.id : "⚠️  NO ENCONTRADO"}`,
    `EBAY_MERCHANT_LOCATION_KEY=${l ? l.key : "⚠️  NO ENCONTRADO"}`,
  ];
  if (fulfillment.length > 1) {
    lines.push(`\n# Otras fulfillment policies:`);
    fulfillment.slice(1).forEach(fp => lines.push(`#   ${fp.id}  →  ${fp.name}`));
  }
  if (locations.length > 1) {
    lines.push(`\n# Otras locations:`);
    locations.slice(1).forEach(loc => lines.push(`#   ${loc.key}  →  ${loc.name}`));
  }
  return lines.join("\n");
}