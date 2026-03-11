import { NextResponse } from "next/server";
import { getUserToken } from "@/lib/ebay";

// ─── GET: Fetch all existing policies + inventory locations ──────────────────
// Call this once to discover the IDs you need for your .env
export async function GET() {
  try {
    const token = await getUserToken();

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    };

    // Fetch all 3 policy types in parallel
    const [fulfillmentRes, paymentRes, returnRes, locationRes] =
      await Promise.all([
        fetch("https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US", { headers }),
        fetch("https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US", { headers }),
        fetch("https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US", { headers }),
        fetch("https://api.ebay.com/sell/inventory/v1/location", { headers }),
      ]);

    const [fulfillmentData, paymentData, returnData, locationData] =
      await Promise.all([
        fulfillmentRes.json(),
        paymentRes.json(),
        returnRes.json(),
        locationRes.json(),
      ]);

    // Extract just the useful info
    const fulfillmentPolicies = (fulfillmentData.fulfillmentPolicies ?? []).map(
      (p: { fulfillmentPolicyId: string; name: string; marketplaceId: string }) => ({
        id: p.fulfillmentPolicyId,
        name: p.name,
        marketplace: p.marketplaceId,
      })
    );

    const paymentPolicies = (paymentData.paymentPolicies ?? []).map(
      (p: { paymentPolicyId: string; name: string; marketplaceId: string }) => ({
        id: p.paymentPolicyId,
        name: p.name,
        marketplace: p.marketplaceId,
      })
    );

    const returnPolicies = (returnData.returnPolicies ?? []).map(
      (p: { returnPolicyId: string; name: string; marketplaceId: string }) => ({
        id: p.returnPolicyId,
        name: p.name,
        marketplace: p.marketplaceId,
      })
    );

    const locations = (locationData.locations ?? []).map(
      (l: {
        merchantLocationKey: string;
        name?: string;
        location?: { address?: { country?: string; postalCode?: string } };
        locationStatus?: string;
      }) => ({
        key: l.merchantLocationKey,
        name: l.name ?? "(sin nombre)",
        country: l.location?.address?.country ?? "",
        postalCode: l.location?.address?.postalCode ?? "",
        status: l.locationStatus ?? "",
      })
    );

    // Build suggested .env snippet
    const suggestedEnv = buildEnvSuggestion(
      fulfillmentPolicies,
      paymentPolicies,
      returnPolicies,
      locations
    );

    return NextResponse.json({
      fulfillmentPolicies,
      paymentPolicies,
      returnPolicies,
      locations,
      suggestedEnv,
      // Raw errors if any fetch failed
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

// ─── POST: Create a new inventory location if none exist ─────────────────────
export async function POST(req: Request) {
  try {
    const { locationKey, name, postalCode, country = "US" } = await req.json();

    if (!locationKey || !postalCode) {
      return NextResponse.json(
        { error: "locationKey and postalCode are required" },
        { status: 400 }
      );
    }

    const token = await getUserToken();

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
          location: {
            address: {
              country,
              postalCode,
            },
          },
          merchantLocationStatus: "ENABLED",
        }),
      }
    );

    if (!res.ok && res.status !== 204) {
      const err = await res.text();
      return NextResponse.json(
        { error: `eBay error (${res.status}): ${err.slice(0, 300)}` },
        { status: res.status }
      );
    }

    return NextResponse.json({
      success: true,
      locationKey,
      message: `Location "${locationKey}" creada correctamente. Agrégala a tu .env como EBAY_MERCHANT_LOCATION_KEY=${locationKey}`,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── Helper: build suggested .env block ──────────────────────────────────────
function buildEnvSuggestion(
  fulfillment: { id: string; name: string }[],
  payment: { id: string; name: string }[],
  returnP: { id: string; name: string }[],
  locations: { key: string; name: string }[]
): string {
  const f = fulfillment[0];
  const p = payment[0];
  const r = returnP[0];
  const l = locations[0];

  const lines: string[] = [
    "# ── Pega esto en tu .env ──────────────────────────────────────",
    `EBAY_FULFILLMENT_POLICY_ID=${f ? f.id : "⚠️  NO ENCONTRADO — crea una política de envío en eBay Business Policies"}`,
    `EBAY_PAYMENT_POLICY_ID=${p ? p.id : "⚠️  NO ENCONTRADO — crea una política de pago en eBay Business Policies"}`,
    `EBAY_RETURN_POLICY_ID=${r ? r.id : "⚠️  NO ENCONTRADO — crea una política de devolución en eBay Business Policies"}`,
    `EBAY_MERCHANT_LOCATION_KEY=${l ? l.key : "⚠️  NO ENCONTRADO — haz POST a este endpoint con { locationKey, postalCode } para crear una"}`,
  ];

  if (fulfillment.length > 1) {
    lines.push(`\n# Tienes ${fulfillment.length} fulfillment policies, se usó la primera. Otras opciones:`);
    fulfillment.slice(1).forEach((fp) => lines.push(`#   ${fp.id}  →  ${fp.name}`));
  }
  if (locations.length > 1) {
    lines.push(`\n# Tienes ${locations.length} locations, se usó la primera. Otras opciones:`);
    locations.slice(1).forEach((loc) => lines.push(`#   ${loc.key}  →  ${loc.name}`));
  }

  return lines.join("\n");
}