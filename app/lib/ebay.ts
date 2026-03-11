const EBAY_BASE_URL = "https://api.ebay.com";
const EBAY_AUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";

let cachedToken: { token: string; expiresAt: number } | null = null;

// ── App Token (búsquedas públicas) ──────────────────────────────────────────
export async function getAppToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) {
    return cachedToken.token;
  }
  const credentials = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(EBAY_AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });

  if (!res.ok) throw new Error(`eBay auth failed: ${res.statusText}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

// ── Browse API: buscar productos ─────────────────────────────────────────────
export async function searchProducts(keywords: string, limit = 20, marketplace = "EBAY_US") {
  const token = await getAppToken();
  const params = new URLSearchParams({
    q: keywords,
    limit: limit.toString(),
    sort: "bestMatch",
    filter: "buyingOptions:{FIXED_PRICE}",
  });
  const res = await fetch(`${EBAY_BASE_URL}/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
    },
  });
  if (!res.ok) throw new Error(`eBay search failed: ${res.statusText}`);
  return res.json();
}

// ── Sell API: crear inventory item ───────────────────────────────────────────
export async function createInventoryItem(
  sku: string,
  product: { title: string; description: string; images: string[]; condition: string },
  quantity: number,
  userToken: string
) {
  const res = await fetch(`${EBAY_BASE_URL}/sell/inventory/v1/inventory_item/${sku}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
    },
    body: JSON.stringify({
      availability: { shipToLocationAvailability: { quantity } },
      condition: product.condition || "NEW",
      product: { title: product.title, description: product.description, imageUrls: product.images },
    }),
  });
  if (!res.ok) throw new Error(`Create inventory failed: ${await res.text()}`);
  return res.status === 204 ? { success: true } : res.json();
}

// ── Sell API: crear offer ────────────────────────────────────────────────────
export async function createOffer(
  sku: string, price: number, categoryId: string,
  description: string, userToken: string, marketplace = "EBAY_US"
) {
  const res = await fetch(`${EBAY_BASE_URL}/sell/inventory/v1/offer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
    },
    body: JSON.stringify({
      sku, marketplaceId: marketplace, format: "FIXED_PRICE",
      categoryId, listingDescription: description,
      listingPolicies: {
        fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID,
        paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID,
        returnPolicyId: process.env.EBAY_RETURN_POLICY_ID,
      },
      pricingSummary: { price: { value: price.toFixed(2), currency: "USD" } },
    }),
  });
  if (!res.ok) throw new Error(`Create offer failed: ${await res.text()}`);
  return res.json();
}

// ── Sell API: publicar offer ─────────────────────────────────────────────────
export async function publishOffer(offerId: string, userToken: string) {
  const res = await fetch(`${EBAY_BASE_URL}/sell/inventory/v1/offer/${offerId}/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Publish offer failed: ${await res.text()}`);
  return res.json();
}

// ── Helper: extraer item ID de URL eBay ──────────────────────────────────────
export function extractItemIdFromUrl(url: string): string | null {
  const match = url.match(/\/itm\/(?:[^/]+\/)?(\d+)/);
  return match ? match[1] : null;
}