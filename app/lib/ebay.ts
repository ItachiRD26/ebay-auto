// ─── NOTE: Add TOKENS to your COLLECTIONS in firebase.ts ────────────────────
// export const COLLECTIONS = {
//   QUEUE: "products_queue",
//   PUBLISHED: "published",
//   SETTINGS: "settings",
//   LOGS: "logs",
//   TOKENS: "tokens",   ← ADD THIS LINE
// };
// ─────────────────────────────────────────────────────────────────────────────

import { db, COLLECTIONS } from "@/lib/firebase";

// ─── App Token (Client Credentials) ──────────────────────────────────────────
// Used for public eBay APIs (Browse, Marketing). No user login needed.
// Exported so import/route.ts and other routes can use it directly.

let appTokenCache: { token: string; expiresAt: number } | null = null;

export async function getAppToken(): Promise<string> {
  if (appTokenCache && Date.now() < appTokenCache.expiresAt - 60_000) {
    return appTokenCache.token;
  }

  const clientId = process.env.EBAY_CLIENT_ID!;
  const clientSecret = process.env.EBAY_CLIENT_SECRET!;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`App token error: ${err}`);
  }

  const data = await res.json();
  appTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return appTokenCache.token;
}

// ─── User Token (OAuth — stored in Firestore) ─────────────────────────────────
// Used for Sell API (publishing listings to your store).

export async function getUserToken(): Promise<string> {
  const doc = await db.collection((COLLECTIONS as Record<string, string>)["TOKENS"] ?? "tokens").doc("ebay_user").get();
  if (!doc.exists) throw new Error("eBay no conectado. Ve a /connect.");

  const { access_token, expiresAt, refresh_token } = doc.data()!;
  if (Date.now() < expiresAt - 60_000) return access_token;

  const clientId = process.env.EBAY_CLIENT_ID!;
  const clientSecret = process.env.EBAY_CLIENT_SECRET!;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: [
      "grant_type=refresh_token",
      `refresh_token=${encodeURIComponent(refresh_token)}`,
      "scope=" + encodeURIComponent([
        "https://api.ebay.com/oauth/api_scope",
        "https://api.ebay.com/oauth/api_scope/sell.inventory",
        "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
        "https://api.ebay.com/oauth/api_scope/sell.account",
        "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
      ].join(" ")),
    ].join("&"),
  });

  if (!res.ok) throw new Error("No se pudo renovar el token de eBay.");

  const data = await res.json();
  await db
    .collection((COLLECTIONS as Record<string, string>)["TOKENS"] ?? "tokens")
    .doc("ebay_user")
    .update({
      access_token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });

  return data.access_token;
}

// ─── Browse API: Keyword Search ───────────────────────────────────────────────

export async function searchProducts(keywords: string, limit = 50) {
  const token = await getAppToken();

  const params = new URLSearchParams({
    q: keywords,
    limit: limit.toString(),
    sort: "bestMatch",
    // buyingOptions: only Buy It Now
    // itemLocationCountry:CN — only show items located/shipped FROM China
    // These are the reference listings we use for dropshipping pricing
    filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:CN",
    fieldgroups: "EXTENDED",
  });

  const res = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Browse API error: ${err}`);
  }

  return res.json();
}

// ─── Marketing API: Best-Selling Products by Category ────────────────────────

export interface MerchandisedProduct {
  epid: string;
  title: string;
  image?: { imageUrl: string };
  marketPriceDetails?: Array<{
    conditionGroup: string;
    estimatedStartPrice: { value: string; currency: string };
  }>;
  estimatedSoldQuantity: number;
  itemGroupHref?: string;
  averageRating?: string;
  reviewCount?: number;
}

export async function getBestSellingProducts(
  categoryId: string,
  limit = 20
): Promise<MerchandisedProduct[]> {
  const token = await getAppToken();

  const params = new URLSearchParams({
    metric_name: "BEST_SELLING",
    category_id: categoryId,
    limit: Math.min(limit, 20).toString(),
  });

  const res = await fetch(
    `https://api.ebay.com/buy/marketing/v1_beta/merchandised_product?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error(`❌ Marketing API [cat ${categoryId}]:`, errText);
    return [];
  }

  const data = await res.json();
  return (data.merchandisedProducts ?? []) as MerchandisedProduct[];
}

// ─── Browse API: Get Listings for an Item Group ───────────────────────────────

export async function getItemsByItemGroup(itemGroupId: string) {
  const token = await getAppToken();

  const res = await fetch(
    `https://api.ebay.com/buy/browse/v1/item/get_items_by_item_group?item_group_id=${itemGroupId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    }
  );

  if (!res.ok) return null;
  return res.json();
}

// ─── Browse API: Get Single Item ──────────────────────────────────────────────

export async function getItem(itemId: string) {
  const token = await getAppToken();

  const res = await fetch(
    `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    }
  );

  if (!res.ok) return null;
  return res.json();
}

// ─── Sell Inventory API: Create or Replace a single Inventory Item ────────────
// Docs: https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/createOrReplaceInventoryItem

export async function createInventoryItem(
  sku: string,
  product: {
    title: string;
    description: string;
    images: string[];
    condition: string;
    aspects?: Record<string, string[]>;  // item specifics copied from reference listing
  },
  stock: number,
  userToken: string
): Promise<void> {
  const conditionMap: Record<string, string> = {
    "New":           "NEW",
    "New with tags": "NEW",
    "Like New":      "LIKE_NEW",
    "Used":          "USED_EXCELLENT",
  };
  const ebayCondition = conditionMap[product.condition] ?? "NEW";

  const body = {
    availability: {
      shipToLocationAvailability: {
        quantity: stock,
      },
    },
    condition: ebayCondition,
    product: {
      title:       product.title.slice(0, 80),
      description: product.description || product.title,
      imageUrls:   product.images.slice(0, 12),
      // Use aspects from reference listing if available, otherwise empty object
      // Empty aspects {} causes eBay to reject with missing item specifics errors
      aspects:     product.aspects && Object.keys(product.aspects).length > 0
                     ? product.aspects
                     : undefined,
    },
  };

  // Use Node.js https module directly to bypass Next.js App Router header
  // propagation — Next.js automatically forwards the browser's Accept-Language
  // to all fetch() calls, and eBay Inventory API rejects non-en-US values (25709)
  const { statusCode, body: resBody } = await nodeHttpsRequest(
    "api.ebay.com",
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    "PUT",
    {
      Authorization:              `Bearer ${userToken}`,
      "Content-Type":             "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    JSON.stringify(body)
  );

  if (statusCode !== 200 && statusCode !== 204) {
    throw new Error(`createInventoryItem failed (${statusCode}): ${resBody.slice(0, 300)}`);
  }
}

// ─── Raw Node.js HTTPS request (bypasses Next.js header propagation) ─────────
async function nodeHttpsRequest(
  hostname: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ statusCode: number; body: string }> {
  const https = await import("node:https");
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(body, "utf-8") : undefined;
    const req = https.request(
      {
        hostname,
        path,
        method,
        headers: {
          ...headers,
          ...(bodyBuf ? { "Content-Length": bodyBuf.length.toString() } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("HTTPS request timeout")); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ─── Sell Inventory API: Create Offer ────────────────────────────────────────
// Docs: https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/createOffer

export async function createOffer(
  sku: string,
  price: number,
  categoryId: string,
  description: string,
  userToken: string
): Promise<{ offerId: string }> {
  const body = {
    sku,
    marketplaceId:  "EBAY_US",
    format:         "FIXED_PRICE",
    availableQuantity: 1,
    categoryId,
    listingDescription: description || sku,
    pricingSummary: {
      price: {
        currency: "USD",
        value:    price.toFixed(2),
      },
    },
    listingPolicies: {
      // These must be valid policy IDs from your eBay seller account.
      // If not set up, go to: My eBay > Account > Business Policies
      fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID ?? "",
      paymentPolicyId:     process.env.EBAY_PAYMENT_POLICY_ID    ?? "",
      returnPolicyId:      process.env.EBAY_RETURN_POLICY_ID     ?? "",
    },
    merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY ?? "default",
  };

  const { statusCode, body: resBody } = await nodeHttpsRequest(
    "api.ebay.com",
    "/sell/inventory/v1/offer",
    "POST",
    {
      Authorization:              `Bearer ${userToken}`,
      "Content-Type":             "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    JSON.stringify(body)
  );

  if (statusCode !== 200 && statusCode !== 201) {
    throw new Error(`createOffer failed (${statusCode}): ${resBody.slice(0, 300)}`);
  }

  const data = JSON.parse(resBody);
  return { offerId: data.offerId };
}

// ─── Sell Inventory API: Publish Offer (make listing live) ───────────────────
// Docs: https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/publishOffer

export async function publishOffer(
  offerId: string,
  userToken: string
): Promise<{ listingId: string }> {
  const { statusCode, body: resBody } = await nodeHttpsRequest(
    "api.ebay.com",
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
    "POST",
    {
      Authorization:              `Bearer ${userToken}`,
      "Content-Type":             "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    }
  );

  if (statusCode !== 200 && statusCode !== 204) {
    throw new Error(`publishOffer failed (${statusCode}): ${resBody.slice(0, 300)}`);
  }

  const data = JSON.parse(resBody || "{}");
  return { listingId: data.listingId };
}
// ─── Trading API: Get full item details including ItemSpecifics ───────────────
// Used by publish route to copy aspects from reference listing so our
// listing passes eBay's category-specific item requirements automatically.

export interface ReferenceItemData {
  title: string;
  description: string;
  categoryId: string;
  aspects: Record<string, string[]>;   // ItemSpecifics as { Name: [Value] }
  imageUrls: string[];
  condition: string;
}

export async function getReferenceItemData(
  itemId: string,
  userToken: string
): Promise<ReferenceItemData | null> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ItemReturnDescription</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
</GetItemRequest>`;

  try {
    const res = await fetch("https://api.ebay.com/ws/api.dll", {
      method: "POST",
      headers: {
        "X-EBAY-API-SITEID":               "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL":  "967",
        "X-EBAY-API-CALL-NAME":            "GetItem",
        "Content-Type":                    "text/xml",
      },
      body: xml,
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) return null;
    const text = await res.text();
    if (text.includes("<Ack>Failure</Ack>")) return null;

    // Title
    const titleMatch = text.match(/<Title>([\s\S]*?)<\/Title>/);
    const title = titleMatch ? titleMatch[1].trim() : "";

    // Description (may be HTML)
    const descMatch = text.match(/<Description>([\s\S]*?)<\/Description>/);
    const description = descMatch ? descMatch[1].trim() : title;

    // Category
    const catMatch = text.match(/<PrimaryCategory>[\s\S]*?<CategoryID>(\d+)<\/CategoryID>/);
    const categoryId = catMatch ? catMatch[1] : "";

    // Condition
    const condMatch = text.match(/<ConditionDisplayName>(.*?)<\/ConditionDisplayName>/);
    const condition = condMatch ? condMatch[1].trim() : "New";

    // Images — grab all PictureURL entries
    const imageUrls: string[] = [];
    const imgRegex = /<PictureURL>(https?:\/\/[^<]+)<\/PictureURL>/g;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(text)) !== null) {
      if (!imageUrls.includes(imgMatch[1])) imageUrls.push(imgMatch[1]);
    }

    // ItemSpecifics — parse all <NameValueList> blocks
    const aspects: Record<string, string[]> = {};
    const nvRegex = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
    let nvMatch;
    while ((nvMatch = nvRegex.exec(text)) !== null) {
      const block = nvMatch[1];
      const nameMatch  = block.match(/<Name>(.*?)<\/Name>/);
      const valueMatch = block.match(/<Value>(.*?)<\/Value>/);
      if (nameMatch && valueMatch) {
        const name  = nameMatch[1].trim();
        const value = valueMatch[1].trim();
        if (name && value && value !== "Does not apply") {
          if (!aspects[name]) aspects[name] = [];
          if (!aspects[name].includes(value)) aspects[name].push(value);
        }
      }
    }

    return { title, description, categoryId, aspects, imageUrls, condition };
  } catch {
    return null;
  }
}