import { db, COLLECTIONS } from "@/lib/firebase";

// ─── App Token (Client Credentials) ──────────────────────────────────────────
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

// ─── User Token (OAuth — stored per store in Firestore) ───────────────────────
export async function getUserToken(storeId: string): Promise<string> {
  const doc = await db.collection("tokens").doc(storeId).get();
  if (!doc.exists) throw new Error(`Tienda "${storeId}" no conectada. Ve a Configuración → Mis Tiendas.`);

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
        "https://api.ebay.com/oauth/api_scope/sell.marketing",
        "https://api.ebay.com/oauth/api_scope/sell.marketing.readonly",
      ].join(" ")),
    ].join("&"),
  });

  const refreshText = await res.text();
  if (!res.ok) throw new Error(`No se pudo renovar el token de eBay: ${refreshText.slice(0, 200)}`);
  let data: Record<string, string & number>;
  try { data = JSON.parse(refreshText); }
  catch { throw new Error(`Refresh token invalid JSON: ${refreshText.slice(0, 200)}`); }

  await db.collection("tokens").doc(storeId).update({
    access_token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });

  return data.access_token;
}

// ─── Browse API: Keyword Search ───────────────────────────────────────────────
// Sort orders eBay supports — 5 options give access to different ranking slices
const SORT_ORDERS = ["bestMatch", "newlyListed", "price", "-price", "distance"] as const;

export async function searchProducts(keywords: string, limit = 200, userId = "default") {
  const token = await getAppToken();

  // ── Stateless sort+offset derivation ─────────────────────────────────────
  // No in-memory Map needed — derived purely from inputs so it survives server
  // restarts, scales across serverless instances, and never gets stale.
  //
  // kwHash:   different keywords → different sort orders in the SAME session
  //           e.g. "portable fan" uses price sort while "yoga mat" uses newlyListed
  //
  // timeSlot: 1-hour bucket — rotates sort+offset every hour so repeated sessions
  //           pick up fresh results automatically (no manual reset needed)
  //
  // userHash: different users get different result sets for the same keyword
  //           prevents two users from always scanning the same 200 items
  //
  // After 5 hours: full sort rotation complete, offset bumps by 200
  // After 25 hours: second offset bucket (offset=200), full 1000-item coverage in 5 days
  const kwHash   = [...keywords.toLowerCase().trim()].reduce((a, c) => a + c.charCodeAt(0), 0);
  const userHash = [...userId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const timeSlot = Math.floor(Date.now() / (60 * 60 * 1000)); // 1-hour bucket
  const combined = kwHash + userHash + timeSlot;

  const sort         = SORT_ORDERS[combined % SORT_ORDERS.length];
  const offsetBucket = Math.floor(combined / SORT_ORDERS.length) % 5;
  const offset       = offsetBucket * 200;

  console.log(`[search] "${keywords.trim()}" user=${userId.slice(0,6)} sort=${sort} offset=${offset}`);

  const params = new URLSearchParams({
    q: keywords,
    limit: Math.min(limit, 200).toString(),
    sort,
    offset: offset.toString(),
    filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:CN,conditions:{NEW}",
    fieldgroups: "EXTENDED",
  });

  const res = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30000),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Browse API ${res.status}: ${errText.slice(0, 300)}`);
  }

  return res.json();
}

// ─── Browse API: Multi-page parallel search ──────────────────────────────────
// Fetches up to 5 pages of 200 items in parallel = up to 1000 items total.
// Uses all 5 sort orders in one shot for maximum diversity.
// Deduplicates by itemId before returning.
export async function searchProductsMultiPage(
  keywords: string,
  pages = 5,
  userId = "default",
): Promise<{ itemSummaries: Record<string, unknown>[] }> {
  const token   = await getAppToken();
  const headers = {
    Authorization:             `Bearer ${token}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    "Content-Type":            "application/json",
  };

  const sorts = ["bestMatch", "newlyListed", "price", "-price", "distance"] as const;
  const kwHash   = [...keywords.toLowerCase().trim()].reduce((a, c) => a + c.charCodeAt(0), 0);
  const userHash = [...userId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const timeSlot = Math.floor(Date.now() / (60 * 60 * 1000));
  const baseBucket = Math.floor((kwHash + userHash + timeSlot) / sorts.length) % 5;
  const baseOffset = baseBucket * 200;

  const fetchPage = (i: number) => {
    const sort   = sorts[i % sorts.length];
    const offset = (baseOffset + i * 200) % 1000;
    const params = new URLSearchParams({
      q: keywords, limit: "200", sort, offset: offset.toString(),
      filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:CN,conditions:{NEW}",
      fieldgroups: "EXTENDED",
    });
    return fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      { headers, signal: AbortSignal.timeout(30000) });
  };

  console.log(`[search-multi] "${keywords.trim()}" — ${pages} pages in parallel (baseOffset=${baseOffset})`);
  const responses = await Promise.allSettled(Array.from({ length: Math.min(pages, 5) }, (_, i) => fetchPage(i)));

  const seen = new Set<string>();
  const items: Record<string, unknown>[] = [];
  for (const r of responses) {
    if (r.status !== "fulfilled" || !r.value.ok) continue;
    const data = await r.value.json() as { itemSummaries?: Record<string, unknown>[] };
    for (const item of data.itemSummaries ?? []) {
      const id = item.itemId as string;
      if (id && !seen.has(id)) { seen.add(id); items.push(item); }
    }
  }
  console.log(`[search-multi] "${keywords.trim()}" — ${items.length} unique items`);
  return { itemSummaries: items };
}

// ─── Taxonomy helpers ─────────────────────────────────────────────────────────
const _taxonomyCache = new Map<string, string>();

async function getLeafChildId(categoryId: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_subtree?category_id=${categoryId}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { categorySubtreeNode?: { childCategoryTreeNodes?: unknown[] } };
    const root = data.categorySubtreeNode;
    if (!root) return null;

    let bestLeaf: string | null = null;
    let bestLevel = -1;
    const queue: unknown[] = [root];
    while (queue.length) {
      const current = queue.shift() as {
        leafCategoryTreeNode?: boolean; categoryTreeNodeLevel?: number;
        category?: { categoryId?: string }; childCategoryTreeNodes?: unknown[];
      };
      const subChildren = current.childCategoryTreeNodes ?? [];
      const isLeaf = current.leafCategoryTreeNode === true || subChildren.length === 0;
      const level = current.categoryTreeNodeLevel ?? 0;
      if (isLeaf && level >= bestLevel) { bestLeaf = current.category?.categoryId ?? null; bestLevel = level; }
      if (!isLeaf) queue.push(...subChildren);
    }
    return bestLeaf;
  } catch { return null; }
}


// ─── Validate that a category is a leaf using getItemAspectsForCategory ────────
// If it returns aspects, it's a leaf. If it fails, it's not.
const _leafCache = new Map<string, boolean>();

async function isLeafCategory(categoryId: string, token: string): Promise<boolean> {
  if (_leafCache.has(categoryId)) return _leafCache.get(categoryId)!;
  try {
    const res = await fetch(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(6000) }
    );
    // 200 = leaf with aspects, 400/404 = not a leaf or invalid
    const isLeaf = res.ok;
    _leafCache.set(categoryId, isLeaf);
    return isLeaf;
  } catch { return false; }
}

// Force-drill into a leaf using getCategorySubtree
async function forceLeaf(categoryId: string, token: string): Promise<string> {
  const leaf = await getLeafChildId(categoryId, token);
  return leaf ?? categoryId;
}

export async function getCategoryIdForTitle(title: string): Promise<string | null> {
  const cacheKey = title.toLowerCase().slice(0, 40);
  if (_taxonomyCache.has(cacheKey)) return _taxonomyCache.get(cacheKey)!;
  try {
    const token = await getAppToken();
    const res = await fetch(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(title.slice(0, 80))}`,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      categorySuggestions?: { category: { categoryId: string; categoryName: string }; categoryTreeNodeLevel?: number }[];
    };
    const suggestions = (data.categorySuggestions ?? []).sort((a, b) => (b.categoryTreeNodeLevel ?? 0) - (a.categoryTreeNodeLevel ?? 0));
    if (!suggestions.length) return null;

    // Try each suggestion until we find a confirmed leaf
    for (const suggestion of suggestions.slice(0, 5)) {
      const candidateId = suggestion.category.categoryId;
      // Check if it's already a leaf
      if (await isLeafCategory(candidateId, token)) {
        console.log(`[taxonomy] "${title.slice(0,40)}" → ${candidateId} (${suggestion.category.categoryName}) ✅ leaf confirmed`);
        _taxonomyCache.set(cacheKey, candidateId);
        return candidateId;
      }
      // Drill down to find leaf child
      const leafId = await getLeafChildId(candidateId, token);
      if (leafId && await isLeafCategory(leafId, token)) {
        console.log(`[taxonomy] "${title.slice(0,40)}" → ${candidateId} drilled to leaf ${leafId}`);
        _taxonomyCache.set(cacheKey, leafId);
        return leafId;
      }
    }

    // Fallback: force drill the best suggestion
    const best = suggestions[0];
    const finalId = await forceLeaf(best.category.categoryId, token);
    console.log(`[taxonomy] "${title.slice(0,40)}" → ${finalId} (forced leaf)`);
    _taxonomyCache.set(cacheKey, finalId);
    return finalId;
  } catch (e) { console.warn("[taxonomy] Error:", e); return null; }
}

export async function getItemSalesFromInsights(itemId: string, title: string): Promise<{ soldCount: number } | null> {
  try {
    const token = await getAppToken();
    const params = new URLSearchParams({ q: title.split(" ").slice(0, 5).join(" "), limit: "20", filter: "conditions:{NEW},buyingOptions:{FIXED_PRICE}" });
    const res = await fetch(`https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search?${params}`, {
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { itemSales?: { itemId?: string; totalSoldItems?: number }[] };
    for (const item of data.itemSales ?? []) {
      const rawId = (item.itemId ?? "").split("|")[1] ?? item.itemId ?? "";
      if (rawId === itemId) return { soldCount: item.totalSoldItems ?? 0 };
    }
    return null;
  } catch { return null; }
}

// ─── Trading API: Get full item details including variations ──────────────────
// Used by publish to copy aspects + variation images from the reference listing.

export interface VariationSpec {
  specifics: Record<string, string>;
  refPrice: number;
}

export interface VariationsData {
  variations: VariationSpec[];
  specificsSet: Record<string, string[]>;
  picturesByVariant: Record<string, string[]>;
  pictureDimension: string;
}

export interface ReferenceItemData {
  title: string;
  description: string;
  categoryId: string;
  aspects: Record<string, string[]>;
  imageUrls: string[];
  condition: string;
  variations: VariationsData | null;
}

export async function getReferenceItemData(itemId: string, userToken: string): Promise<ReferenceItemData | null> {
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
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetItem",
        "Content-Type": "text/xml",
      },
      body: xml,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.includes("<Ack>Failure</Ack>")) {
      const m = text.match(/<LongMessage>(.*?)<\/LongMessage>/);
      console.log(`[getReferenceItemData] eBay Failure: ${m?.[1] ?? "unknown"}`);
      return null;
    }

    const titleMatch = text.match(/<Title>([\s\S]*?)<\/Title>/);
    const descMatch  = text.match(/<Description>([\s\S]*?)<\/Description>/);
    const catMatch   = text.match(/<PrimaryCategory>[\s\S]*?<CategoryID>(\d+)<\/CategoryID>/);
    const condMatch  = text.match(/<ConditionDisplayName>(.*?)<\/ConditionDisplayName>/);

    const imageUrls: string[] = [];
    const imgRegex = /<PictureURL>(https?:\/\/[^<]+)<\/PictureURL>/g;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(text)) !== null) {
      if (!imageUrls.includes(imgMatch[1])) imageUrls.push(imgMatch[1]);
    }

    const aspects: Record<string, string[]> = {};
    const nvRegex = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
    let nvMatch;
    while ((nvMatch = nvRegex.exec(text)) !== null) {
      const block = nvMatch[1];
      const nameM  = block.match(/<Name>(.*?)<\/Name>/);
      const valueM = block.match(/<Value>(.*?)<\/Value>/);
      if (nameM && valueM) {
        const name = nameM[1].trim(); const value = valueM[1].trim();
        if (name && value && value !== "Does not apply") {
          if (!aspects[name]) aspects[name] = [];
          if (!aspects[name].includes(value)) aspects[name].push(value);
        }
      }
    }

    let variations: VariationsData | null = null;
    if (text.includes("<Variations>")) {
      const varSpecs: VariationSpec[] = [];
      const varRegex = /<Variation>([\s\S]*?)<\/Variation>/g;
      let varMatch;
      while ((varMatch = varRegex.exec(text)) !== null) {
        const block = varMatch[1];
        const priceM = block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
        const refPrice = priceM ? parseFloat(priceM[1]) : 0;
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

      const picturesByVariant: Record<string, string[]> = {};
      let pictureDimension = "";
      const picsMatch = text.match(/<Pictures>([\s\S]*?)<\/Pictures>/);
      if (picsMatch) {
        const dimMatch = picsMatch[1].match(/<VariationSpecificName>(.*?)<\/VariationSpecificName>/);
        if (dimMatch) pictureDimension = dimMatch[1].trim();
        const setPicRegex = /<VariationSpecificPictureSet>([\s\S]*?)<\/VariationSpecificPictureSet>/g;
        let setPicMatch;
        while ((setPicMatch = setPicRegex.exec(picsMatch[1])) !== null) {
          const valM = setPicMatch[1].match(/<VariationSpecificValue>(.*?)<\/VariationSpecificValue>/);
          if (!valM) continue;
          const varValue = valM[1].trim();
          const picUrls: string[] = [];
          const picUrlRegex = /<PictureURL>(https?:\/\/[^<]+)<\/PictureURL>/g;
          let picUrlMatch;
          while ((picUrlMatch = picUrlRegex.exec(setPicMatch[1])) !== null) picUrls.push(picUrlMatch[1]);
          if (picUrls.length > 0) picturesByVariant[varValue] = picUrls;
        }
      }

      if (varSpecs.length > 0) {
        variations = { variations: varSpecs, specificsSet, picturesByVariant, pictureDimension };
        console.log(`[getReferenceItemData] ${varSpecs.length} variants, dim="${pictureDimension}", pics=${Object.keys(picturesByVariant).length}`);
      }
    }

    return {
      title:       titleMatch?.[1]?.trim() ?? "",
      description: descMatch?.[1]?.trim() ?? "",
      categoryId:  catMatch?.[1] ?? "",
      aspects,
      imageUrls,
      condition:   condMatch?.[1]?.trim() ?? "New",
      variations,
    };
  } catch { return null; }
}

// ─── Trading API: GetSuggestedCategories ─────────────────────────────────────
export async function getTradingCategoryForTitle(title: string, userToken: string): Promise<string | null> {
  try {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetSuggestedCategoriesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <Query>${title.slice(0, 80).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</Query>
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
    if (!res.ok) return null;
    const text = await res.text();
    if (text.includes("<Ack>Failure</Ack>")) return null;

    const blocks = [...text.matchAll(/<SuggestedCategory>([\s\S]*?)<\/SuggestedCategory>/g)];
    let bestId = ""; let bestPct = 0;
    for (const block of blocks) {
      const idM  = block[1].match(/<CategoryID>(\d+)<\/CategoryID>/);
      const pctM = block[1].match(/<PercentItemFound>(\d+)<\/PercentItemFound>/);
      const pct  = pctM ? parseInt(pctM[1]) : 0;
      if (idM && pct > bestPct) { bestPct = pct; bestId = idM[1]; }
    }
    return bestId || null;
  } catch { return null; }
}