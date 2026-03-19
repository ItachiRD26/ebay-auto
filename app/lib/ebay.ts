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

  const tokenText = await res.text();
  let data: Record<string, string & number>;
  try { data = JSON.parse(tokenText); }
  catch { throw new Error(`App token invalid JSON: ${tokenText.slice(0, 200)}`); }
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

  const refreshText = await res.text();
  if (!res.ok) throw new Error(`No se pudo renovar el token de eBay: ${refreshText.slice(0, 200)}`);
  let data: Record<string, string & number>;
  try { data = JSON.parse(refreshText); }
  catch { throw new Error(`Refresh token invalid JSON: ${refreshText.slice(0, 200)}`); }
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

export async function searchProducts(keywords: string, limit = 200) {
  const token = await getAppToken();

  // Browse API max is 200 per request
  // sort=PRICE_DESC puts higher-priced (more profitable) items first
  // We can't sort by soldQuantity in Browse API, but bestMatch favors popular items
  const params = new URLSearchParams({
    q: keywords,
    limit: Math.min(limit, 200).toString(),
    sort: "bestMatch",
    filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:CN,conditions:{NEW}",
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

  const text = await res.text();
  if (!res.ok) throw new Error(`Browse API error (${res.status}): ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Browse API returned invalid JSON: ${text.slice(0, 200)}`);
  }
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

  let data: Record<string, string>;
  try { data = JSON.parse(resBody); }
  catch { throw new Error(`createOffer invalid JSON: ${resBody.slice(0, 200)}`); }
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

  let data: Record<string, string> = {};
  try { if (resBody) data = JSON.parse(resBody); }
  catch { throw new Error(`publishOffer invalid JSON: ${resBody.slice(0, 200)}`); }
  return { listingId: data.listingId };
}
// ─── Trading API: Get full item details including ItemSpecifics ───────────────
// Used by publish route to copy aspects from reference listing so our
// listing passes eBay's category-specific item requirements automatically.

export interface VariationSpec {
  specifics: Record<string, string>;  // e.g. { Size: "S", Color: "Red" }
  refPrice: number;                   // reference listing price for this variant
}

export interface VariationsData {
  variations: VariationSpec[];
  specificsSet: Record<string, string[]>;       // e.g. { Size: ["S","M","L"], Color: ["Red","Blue"] }
  picturesByVariant: Record<string, string[]>;  // e.g. { "Red": ["url1","url2"], "Blue": ["url3"] }
  pictureDimension: string;                     // which dimension has pictures, e.g. "Color"
}

export interface ReferenceItemData {
  title: string;
  description: string;
  categoryId: string;
  aspects: Record<string, string[]>;
  imageUrls: string[];
  condition: string;
  variations: VariationsData | null;   // null if no variations
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

    if (!res.ok) {
      const errText = await res.text();
      console.log(`[getReferenceItemData] HTTP ${res.status}: ${errText.slice(0,200)}`);
      return null;
    }
    const text = await res.text();
    if (text.includes("<Ack>Failure</Ack>")) {
      const errMatch = text.match(/<LongMessage>(.*?)<\/LongMessage>/);
      console.log(`[getReferenceItemData] eBay Failure: ${errMatch?.[1] ?? text.slice(0,200)}`);
      return null;
    }
    const hasVariations = text.includes("<Variations>");
    console.log(`[getReferenceItemData] OK — hasVariations=${hasVariations} textLen=${text.length}`);

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

    // ── Variations ───────────────────────────────────────────────────────────
    let variations: VariationsData | null = null;
    if (text.includes("<Variations>")) {
      // Parse each <Variation> block
      const varSpecs: VariationSpec[] = [];
      const varRegex = /<Variation>([\s\S]*?)<\/Variation>/g;
      let varMatch;
      while ((varMatch = varRegex.exec(text)) !== null) {
        const block = varMatch[1];
        const priceMatch = block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
        const refPrice = priceMatch ? parseFloat(priceMatch[1]) : 0;
        const specifics: Record<string, string> = {};
        const specRegex = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
        let specMatch;
        while ((specMatch = specRegex.exec(block)) !== null) {
          const nameM = specMatch[1].match(/<Name>(.*?)<\/Name>/);
          const valM  = specMatch[1].match(/<Value>(.*?)<\/Value>/);
          if (nameM && valM) specifics[nameM[1].trim()] = valM[1].trim();
        }
        if (Object.keys(specifics).length > 0) varSpecs.push({ specifics, refPrice });
      }

      // Parse <VariationSpecificsSet> for the full list of options
      const specificsSet: Record<string, string[]> = {};
      const setMatch = text.match(/<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/);
      if (setMatch) {
        const setRegex = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
        let setNvl;
        while ((setNvl = setRegex.exec(setMatch[1])) !== null) {
          const nameM = setNvl[1].match(/<Name>(.*?)<\/Name>/);
          if (!nameM) continue;
          const name = nameM[1].trim();
          const vals: string[] = [];
          const valRegex = /<Value>(.*?)<\/Value>/g;
          let valM;
          while ((valM = valRegex.exec(setNvl[1])) !== null) vals.push(valM[1].trim());
          if (vals.length > 0) specificsSet[name] = vals;
        }
      }

      // Parse <Pictures> block — maps a variation dimension to image URLs per value
      // eBay XML: <Pictures><VariationSpecificName>Color</VariationSpecificName>
      //           <VariationSpecificPictureSet><VariationSpecificValue>Red</VariationSpecificValue>
      //           <PictureURL>...</PictureURL></VariationSpecificPictureSet></Pictures>
      const picturesByVariant: Record<string, string[]> = {};
      let pictureDimension = "";
      const picsMatch = text.match(/<Pictures>([\s\S]*?)<\/Pictures>/);
      if (picsMatch) {
        const dimMatch = picsMatch[1].match(/<VariationSpecificName>(.*?)<\/VariationSpecificName>/);
        if (dimMatch) pictureDimension = dimMatch[1].trim();
        const setPicRegex = /<VariationSpecificPictureSet>([\s\S]*?)<\/VariationSpecificPictureSet>/g;
        let setPicMatch;
        while ((setPicMatch = setPicRegex.exec(picsMatch[1])) !== null) {
          const valMatch = setPicMatch[1].match(/<VariationSpecificValue>(.*?)<\/VariationSpecificValue>/);
          if (!valMatch) continue;
          const varValue = valMatch[1].trim();
          const picUrls: string[] = [];
          const picUrlRegex = /<PictureURL>(https?:\/\/[^<]+)<\/PictureURL>/g;
          let picUrlMatch;
          while ((picUrlMatch = picUrlRegex.exec(setPicMatch[1])) !== null) {
            picUrls.push(picUrlMatch[1]);
          }
          if (picUrls.length > 0) picturesByVariant[varValue] = picUrls;
        }
      }

      if (varSpecs.length > 0) variations = { variations: varSpecs, specificsSet, picturesByVariant, pictureDimension };
    }

    return { title, description, categoryId, aspects, imageUrls, condition, variations };
  } catch {
    return null;
  }
}

// ─── Trading API: GetSuggestedCategories — guaranteed valid for listing ────────
export async function getTradingCategoryForTitle(title: string, userToken: string): Promise<string | null> {
  try {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetSuggestedCategoriesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <Query>${title.slice(0, 80).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</Query>
</GetSuggestedCategoriesRequest>`;

    const res = await fetch("https://api.ebay.com/ws/api.dll", {
      method: "POST",
      headers: {
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetSuggestedCategories",
        "Content-Type": "text/xml",
      },
      body: xml,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[trading-cat] HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    if (text.includes("<Ack>Failure</Ack>")) {
      const err = text.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1];
      console.warn(`[trading-cat] Failure: ${err}`);
      return null;
    }
    console.log(`[trading-cat] response snippet: ${text.slice(0, 200)}`);

    // Pick the category with the highest PercentItemFound (most relevant)
    const blocks = [...text.matchAll(/<SuggestedCategory>([\s\S]*?)<\/SuggestedCategory>/g)];
    let bestId = "";
    let bestPct = 0;
    for (const block of blocks) {
      const idMatch   = block[1].match(/<CategoryID>(\d+)<\/CategoryID>/);
      const pctMatch  = block[1].match(/<PercentItemFound>(\d+)<\/PercentItemFound>/);
      const nameMatch = block[1].match(/<CategoryName>(.*?)<\/CategoryName>/);
      const pct = pctMatch ? parseInt(pctMatch[1]) : 0;
      if (idMatch && pct > bestPct) {
        bestPct = pct;
        bestId  = idMatch[1];
        console.log(`[trading-cat] ${idMatch[1]} (${nameMatch?.[1]}) — ${pct}%`);
      }
    }
    return bestId || null;
  } catch (e) {
    console.warn("[trading-cat] Error:", e);
    return null;
  }
}

// ─── Taxonomy API: get best eBay category ID for a product title ──────────────
// Uses getCategorySuggestions — 5,000 calls/day app-level limit
// category_tree_id 0 = eBay US
const _taxonomyCache = new Map<string, string>();

// Get deepest leaf child of a category via subtree
async function getLeafChildId(categoryId: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_subtree?category_id=${categoryId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;

    type TreeNode = {
      category?: { categoryId: string; categoryName?: string };
      childCategoryTreeNodes?: TreeNode[];
      leafCategoryTreeNode?: boolean;
      categoryTreeNodeLevel?: number;
    };

    const rawText = await res.text();
    let data: { categorySubtreeNode?: TreeNode };
    try { data = JSON.parse(rawText); } catch { return null; }
    const root = data.categorySubtreeNode;
    if (!root) return null;

    // Check leafCategoryTreeNode field directly (from Taxonomy API docs)
    if (root.leafCategoryTreeNode === true) {
      console.log(`[taxonomy-subtree] ${categoryId} IS a leaf (leafCategoryTreeNode=true)`);
      return root.category?.categoryId ?? null;
    }

    const children = root.childCategoryTreeNodes ?? [];
    console.log(`[taxonomy-subtree] ${categoryId} (${root.category?.categoryName}) — ${children.length} children, leafCategoryTreeNode=${root.leafCategoryTreeNode}`);

    if (children.length === 0) {
      // No children but leafCategoryTreeNode not true — likely is a leaf anyway
      return root.category?.categoryId ?? null;
    }

    // BFS — find deepest node where leafCategoryTreeNode=true
    const queue: TreeNode[] = [...children];
    let bestLeaf: string | null = null;
    let bestLevel = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      const subChildren = current.childCategoryTreeNodes ?? [];
      const isLeaf = current.leafCategoryTreeNode === true || subChildren.length === 0;
      const level = current.categoryTreeNodeLevel ?? 0;

      if (isLeaf && level >= bestLevel) {
        bestLeaf  = current.category?.categoryId ?? null;
        bestLevel = level;
        console.log(`[taxonomy-subtree] leaf candidate: ${current.category?.categoryId} (${current.category?.categoryName}) level=${level}`);
      }
      if (!isLeaf) queue.push(...subChildren);
    }
    return bestLeaf;
  } catch { return null; }
}

export async function getCategoryIdForTitle(title: string): Promise<string | null> {
  const cacheKey = title.toLowerCase().slice(0, 40);
  if (_taxonomyCache.has(cacheKey)) return _taxonomyCache.get(cacheKey)!;

  try {
    const token = await getAppToken();
    const res = await fetch(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(title.slice(0, 80))}`,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      categorySuggestions?: {
        category: { categoryId: string; categoryName: string };
        categoryTreeNodeLevel?: number;
      }[];
    };
    const suggestions = (data.categorySuggestions ?? [])
      .sort((a, b) => (b.categoryTreeNodeLevel ?? 0) - (a.categoryTreeNodeLevel ?? 0));
    if (!suggestions.length) return null;

    // Use deepest suggestion — then verify/drill to leaf via subtree
    const best = suggestions[0];
    const leafId = await getLeafChildId(best.category.categoryId, token);
    const finalId = leafId ?? best.category.categoryId;

    console.log(`[taxonomy] "${title.slice(0, 40)}" → ${finalId} (was: ${best.category.categoryId} ${best.category.categoryName}) level=${best.categoryTreeNodeLevel}`);
    _taxonomyCache.set(cacheKey, finalId);
    return finalId;
  } catch (e) {
    console.warn("[taxonomy] Error:", e);
    return null;
  }
}

// ─── Marketplace Insights API: check if an item has been sold ─────────────────
// Searches sold items by item ID — avoids GetItem call for sales verification
// Returns sold count from sold history (last 90 days) or null if not found
export async function getItemSalesFromInsights(
  itemId: string,
  title: string
): Promise<{ soldCount: number } | null> {
  try {
    const token = await getAppToken();
    // Search by keyword (title) since direct item ID lookup isn't supported
    const q = encodeURIComponent(title.split(" ").slice(0, 5).join(" "));
    const params = new URLSearchParams({
      q: title.split(" ").slice(0, 5).join(" "),
      limit: "20",
      filter: "conditions:{NEW},buyingOptions:{FIXED_PRICE}",
    });
    const res = await fetch(
      `https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search?${params}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[insights] HTTP ${res.status}: ${errText.slice(0, 150)}`);
      return null;
    }
    const data = await res.json() as {
      itemSales?: { itemId?: string; totalSoldItems?: number }[];
    };
    console.log(`[insights] ${res.status} — ${data.itemSales?.length ?? 0} sold items returned`);

    // Find our specific item in the results
    for (const item of data.itemSales ?? []) {
      const rawId = (item.itemId ?? "").split("|")[1] ?? item.itemId ?? "";
      if (rawId === itemId) {
        return { soldCount: item.totalSoldItems ?? 0 };
      }
    }
    return null; // item not found in sold history
  } catch {
    return null;
  }
}