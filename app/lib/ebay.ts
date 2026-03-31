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
// storeId corresponds to the document ID in the "tokens" collection.
// Each connected eBay store has its own token document: tokens/{storeId}

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
export async function searchProducts(keywords: string, limit = 200) {
  const token = await getAppToken();

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
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        "X-EBAY-C-ENDUSERCTX": "affiliateCampaignId=<ePNCampaignId>,affiliateReferenceId=<referenceId>",
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

// ─── Taxonomy helpers ─────────────────────────────────────────────────────────
const _taxonomyCache = new Map<string, string>();

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
    const data = await res.json() as { categorySubtreeNode?: { childCategoryTreeNodes?: unknown[] } };
    const root = data.categorySubtreeNode;
    if (!root) return null;

    let bestLeaf: string | null = null;
    let bestLevel = -1;
    const queue: unknown[] = [root];
    while (queue.length) {
      const current = queue.shift() as { leafCategoryTreeNode?: boolean; categoryTreeNodeLevel?: number; category?: { categoryId?: string; categoryName?: string }; childCategoryTreeNodes?: unknown[] };
      const subChildren = current.childCategoryTreeNodes ?? [];
      const isLeaf = current.leafCategoryTreeNode === true || subChildren.length === 0;
      const level = current.categoryTreeNodeLevel ?? 0;

      if (isLeaf && level >= bestLevel) {
        bestLeaf  = current.category?.categoryId ?? null;
        bestLevel = level;
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
    const params = new URLSearchParams({
      q: title.split(" ").slice(0, 5).join(" "),
      limit: "20",
      filter: "conditions:{NEW},buyingOptions:{FIXED_PRICE}",
    });
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

    const best = suggestions[0];
    const leafId = await getLeafChildId(best.category.categoryId, token);
    const finalId = leafId ?? best.category.categoryId;
    _taxonomyCache.set(cacheKey, finalId);
    return finalId;
  } catch (e) {
    console.warn("[taxonomy] Error:", e);
    return null;
  }
}

export async function getItemSalesFromInsights(
  itemId: string,
  title: string
): Promise<{ soldCount: number } | null> {
  try {
    const token = await getAppToken();
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
    if (!res.ok) return null;
    const data = await res.json() as {
      itemSales?: { itemId?: string; totalSoldItems?: number }[];
    };
    for (const item of data.itemSales ?? []) {
      const rawId = (item.itemId ?? "").split("|")[1] ?? item.itemId ?? "";
      if (rawId === itemId) {
        return { soldCount: item.totalSoldItems ?? 0 };
      }
    }
    return null;
  } catch {
    return null;
  }
}