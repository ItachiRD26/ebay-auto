// ─── Firebase config — same as DropFlow ──────────────────────────────────────
// Replace these with your actual Firebase config values
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyC2pPD1o4ffg6XkUjlpIe17IEppk25urjk",
  authDomain:        "ebay-5984f.firebaseapp.com",
  projectId:         "ebay-5984f",
};

const DROPFLOW_API = "https://www.dropflow-app.com";
 
// ─── Firebase Auth via REST API (no SDK needed in extension) ─────────────────
async function firebaseSignIn(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_CONFIG.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Login failed");
  return data; // { idToken, refreshToken, localId (uid), email, expiresIn }
}
 
async function firebaseRefreshToken(refreshToken) {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("Token refresh failed");
  return data; // { id_token, refresh_token, user_id }
}
 
// ─── Storage helpers ──────────────────────────────────────────────────────────
function saveAuth(authData) {
  return chrome.storage.local.set({
    idToken:      authData.idToken,
    refreshToken: authData.refreshToken,
    uid:          authData.localId,
    email:        authData.email,
    expiresAt:    Date.now() + parseInt(authData.expiresIn) * 1000,
  });
}
 
function getAuth() {
  return chrome.storage.local.get(["idToken", "refreshToken", "uid", "email", "expiresAt"]);
}
 
function clearAuth() {
  return chrome.storage.local.remove(["idToken", "refreshToken", "uid", "email", "expiresAt"]);
}
 
async function getValidToken() {
  const auth = await getAuth();
  if (!auth.idToken) return null;
  // Refresh if expiring in < 5 min
  if (Date.now() > auth.expiresAt - 300_000) {
    try {
      const refreshed = await firebaseRefreshToken(auth.refreshToken);
      await chrome.storage.local.set({
        idToken:   refreshed.id_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: Date.now() + 3600 * 1000,
      });
      return refreshed.id_token;
    } catch { return null; }
  }
  return auth.idToken;
}
 
// ─── UI helpers ───────────────────────────────────────────────────────────────
function show(id)  { document.getElementById(id).style.display = "flex"; document.getElementById(id).classList.add("active"); }
function hide(id)  { document.getElementById(id).style.display = "none";  document.getElementById(id).classList.remove("active"); }
function showOnly(id) {
  ["screenLogin", "screenNotOn1688", "screenLoading", "screenProduct"].forEach(s => {
    document.getElementById(s).classList.remove("active");
    document.getElementById(s).style.display = "none";
  });
  show(id);
}
function setStatus(msg) { document.getElementById("footerStatus").textContent = msg; }
 
// ─── CNY → USD pricing ────────────────────────────────────────────────────────
function calcSuggestedPrice(usdCost, markupPct = 40) {
  const shipping = usdCost < 5 ? 4.5 : usdCost < 15 ? 5.5 : 6.5;
  const ebayFee  = (usdCost + shipping) * 0.135;
  return Math.ceil((usdCost + shipping + ebayFee) * (1 + markupPct / 100) * 10) / 10;
}
 
// ─── Fetch stores from DropFlow ───────────────────────────────────────────────
async function fetchStores(uid, token) {
  const res = await fetch(`${DROPFLOW_API}/api/ebay/stores?userId=${uid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.stores ?? [];
}
 
// ─── Get current tab product data via content script ─────────────────────────
async function getProductFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("1688.com")) return null;
 
  // Inject content script to extract product data
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractProductData,
  });
  return results?.[0]?.result ?? null;
}
 
// ─── This function runs IN the 1688 page context ──────────────────────────────
function extractProductData() {
  try {
    // ── Title ────────────────────────────────────────────────────────────────
    // 1688 product title is usually in a specific h1 or title element
    // AVOID shop/company name elements
    let title = "";
    const titleSelectors = [
      '[class*="offer-title"]',
      '[class*="product-title"]',
      '[class*="detail-title"]',
      'h1[class*="title"]',
      '.title-text',
      '[class*="offerTitle"]',
    ];
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      const t = el?.textContent?.trim();
      // Skip if it looks like a company/shop name (contains 厂/公司/店/号)
      if (t && t.length > 5 && !/厂|公司|店铺|旗舰|号|factory/i.test(t)) {
        title = t; break;
      }
    }
    // Fallback: use page title (strip 1688 suffix)
    if (!title) {
      title = document.title
        .replace(/[-|].*1688.*$/i, "")
        .replace(/1688.*$/i, "")
        .trim();
    }
 
    // ── Price — try to find CNY number ───────────────────────────────────────
    // 1688 prices are often in <em> tags or price-specific elements
    let priceCNY = 0;
    const priceSelectors = [
      '[class*="price-range"] em',
      '[class*="price"] em',
      '[class*="Price"] em',
      '[class*="price-number"]',
      '[class*="priceText"]',
      '.price em',
      'em[class*="price"]',
    ];
    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const num = parseFloat(el.textContent?.replace(/[^\d.]/g, "") ?? "0");
        if (num > 0) { priceCNY = num; break; }
      }
    }
 
    // Fallback: scan all <em> tags for a price-like number
    if (!priceCNY) {
      document.querySelectorAll("em").forEach(em => {
        if (priceCNY) return;
        const num = parseFloat(em.textContent?.replace(/[^\d.]/g, "") ?? "0");
        if (num > 0.5 && num < 10000) priceCNY = num;
      });
    }
 
    // ── Images ───────────────────────────────────────────────────────────────
    const images = [];
    const seen = new Set();
 
    // Main large image first
    const mainSelectors = [
      '[class*="main-image"] img',
      '[class*="mainImage"] img',
      '[class*="gallery"] img',
      '[class*="detail-image"] img',
      '.img-spot img',
    ];
    for (const sel of mainSelectors) {
      document.querySelectorAll(sel).forEach(img => {
        const src = img.src?.split("?")[0].replace(/_\d+x\d+\.jpg/, ".jpg");
        if (src && src.includes("alicdn") && !seen.has(src) && images.length < 8) {
          images.push(src); seen.add(src);
        }
      });
      if (images.length > 0) break;
    }
 
    // Also grab any alicdn images from the page
    if (images.length === 0) {
      document.querySelectorAll("img").forEach(img => {
        const src = img.src?.split("?")[0];
        if (src && src.includes("alicdn") && !seen.has(src) && images.length < 8) {
          images.push(src); seen.add(src);
        }
      });
    }
 
    // ── Variants ─────────────────────────────────────────────────────────────
    const variantTexts = new Set();
    const varSelectors = [
      '[class*="sku"] [class*="item"]',
      '[class*="prop"] [class*="item"]',
      '[class*="attribute"] [class*="item"]',
      '[class*="sku-item"]',
    ];
    for (const sel of varSelectors) {
      document.querySelectorAll(sel).forEach(el => {
        const t = el.textContent?.trim();
        if (t && t.length < 60 && t.length > 0) variantTexts.add(t);
      });
    }
 
    // ── Shop name ─────────────────────────────────────────────────────────────
    const shopEl =
      document.querySelector('[class*="company-name"]') ??
      document.querySelector('[class*="seller-name"]') ??
      document.querySelector('[class*="shop-name"]');
    const shopName = shopEl?.textContent?.trim() ?? "";
 
    // ── Sold count ────────────────────────────────────────────────────────────
    let soldCount = 0;
    document.querySelectorAll("*").forEach(el => {
      if (soldCount) return;
      const text = el.textContent ?? "";
      const m = text.match(/(\d+)\s*(?:笔交易|成交|sold)/i);
      if (m) soldCount = parseInt(m[1]);
    });
 
    return {
      title:     title.slice(0, 200),
      priceCNY,
      images:    images.slice(0, 8),
      variants:  [...variantTexts].slice(0, 20),
      shopName,
      soldCount,
      sourceUrl: window.location.href,
    };
  } catch (e) {
    return { title: "", priceCNY: 0, images: [], variants: [], shopName: "", soldCount: 0, sourceUrl: window.location.href };
  }
}
 
// ─── Main init ────────────────────────────────────────────────────────────────
let currentProduct = null;
let stores = [];
const USD_RATE = 0.138; // fallback; ideally fetch from DropFlow
 
async function init() {
  const auth = await getAuth();
 
  if (!auth.idToken) {
    showOnly("screenLogin");
    document.getElementById("btnLogout").style.display = "none";
    return;
  }
 
  // Logged in
  document.getElementById("userEmail").textContent = auth.email ?? "";
  document.getElementById("btnLogout").style.display = "block";
  setStatus("Logged in");
 
  // Check if on 1688
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const is1688 = tab?.url?.includes("1688.com") && tab?.url?.includes("/offer/");
 
  if (!is1688) {
    showOnly("screenNotOn1688");
    return;
  }
 
  // Extract product data
  showOnly("screenLoading");
  setStatus("Reading product...");
 
  const token = await getValidToken();
  if (!token) { await clearAuth(); showOnly("screenLogin"); return; }
 
  // Load stores
  try {
    stores = await fetchStores(auth.uid, token);
    const sel = document.getElementById("storeSelect");
    sel.innerHTML = stores.map(s =>
      `<option value="${s.id}">${s.connected ? "🟢" : "🔴"} ${s.name || s.id}</option>`
    ).join("");
  } catch { /* non-fatal */ }
 
  // Extract product
  const product = await getProductFromTab();
 
  if (!product || !product.title) {
    showOnly("screenNotOn1688");
    document.querySelector("#screenNotOn1688 .info-msg").textContent =
      "⚠️ Could not read product data. Make sure you are on a product detail page.";
    return;
  }
 
  currentProduct = product;
 
  // Calculate prices
  const usdCost   = product.priceCNY * USD_RATE;
  const suggested = calcSuggestedPrice(usdCost);
 
  // Show product
  document.getElementById("productImg").src       = product.images[0] ?? "";
  document.getElementById("productTitle").textContent = product.title;
  document.getElementById("priceCNY").textContent  = `¥${product.priceCNY.toFixed(2)} CNY`;
  document.getElementById("priceUSD").textContent  = `$${usdCost.toFixed(2)}`;
  document.getElementById("priceSuggested").textContent = `→ eBay $${suggested}`;
  document.getElementById("productVariants").textContent =
    product.variants.length > 0
      ? `${product.variants.length} variants: ${product.variants.slice(0, 3).join(", ")}${product.variants.length > 3 ? "..." : ""}`
      : "No variants";
 
  showOnly("screenProduct");
  setStatus("Ready to import");
}
 
// ─── Login handler ────────────────────────────────────────────────────────────
document.getElementById("btnLogin").addEventListener("click", async () => {
  const email    = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl    = document.getElementById("loginError");
  const btn      = document.getElementById("btnLogin");
 
  errEl.style.display = "none";
  if (!email || !password) { errEl.textContent = "Email and password required"; errEl.style.display = "block"; return; }
 
  btn.disabled = true;
  btn.textContent = "Signing in...";
 
  try {
    const auth = await firebaseSignIn(email, password);
    await saveAuth(auth);
    await init();
  } catch (e) {
    errEl.textContent = e.message.replace("EMAIL_NOT_FOUND", "Email not found")
      .replace("INVALID_PASSWORD", "Wrong password")
      .replace("INVALID_LOGIN_CREDENTIALS", "Invalid email or password");
    errEl.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
});
 
// ─── Enter key on password ────────────────────────────────────────────────────
document.getElementById("loginPassword").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("btnLogin").click();
});
 
// ─── Import handler ───────────────────────────────────────────────────────────
document.getElementById("btnImport").addEventListener("click", async () => {
  if (!currentProduct) return;
  const btn      = document.getElementById("btnImport");
  const errEl    = document.getElementById("importError");
  const successEl = document.getElementById("importSuccess");
  const storeId  = document.getElementById("storeSelect").value;
 
  if (!storeId) { errEl.textContent = "Select a store first"; errEl.style.display = "block"; return; }
 
  errEl.style.display = "none";
  successEl.style.display = "none";
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Adding...';
  setStatus("Importing...");
 
  const auth  = await getAuth();
  const token = await getValidToken();
  if (!token) { await clearAuth(); showOnly("screenLogin"); return; }
 
  const usdCost   = currentProduct.priceCNY * USD_RATE;
  const suggested = calcSuggestedPrice(usdCost);
 
  try {
    const res = await fetch(`${DROPFLOW_API}/api/dropflow/import-extension`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        userId:     auth.uid,
        storeId,
        title:      currentProduct.title,
        price:      Math.round(usdCost * 100) / 100,
        suggestedPrice: suggested,
        shipping:   usdCost < 5 ? 4.5 : usdCost < 15 ? 5.5 : 6.5,
        cnyPrice:   currentProduct.priceCNY,
        images:     currentProduct.images,
        variants:   currentProduct.variants,
        shopName:   currentProduct.shopName,
        soldCount:  currentProduct.soldCount,
        source:     "1688-extension",
        source1688Url: currentProduct.sourceUrl,
      }),
    });
 
    const data = await res.json();
    if (data.error) throw new Error(data.error);
 
    successEl.textContent = "✅ Added to Pending! Open DropFlow to review.";
    successEl.style.display = "block";
    btn.innerHTML = "✅ Added!";
    setStatus("Done");
  } catch (e) {
    errEl.textContent = "❌ " + e.message;
    errEl.style.display = "block";
    btn.disabled = false;
    btn.innerHTML = "📥 Add to DropFlow";
    setStatus("Error");
  }
});
 
// ─── Logout ───────────────────────────────────────────────────────────────────
document.getElementById("btnLogout").addEventListener("click", async () => {
  await clearAuth();
  document.getElementById("userEmail").textContent = "";
  document.getElementById("btnLogout").style.display = "none";
  showOnly("screenLogin");
  setStatus("Signed out");
});
 
// ─── Start ────────────────────────────────────────────────────────────────────
init();
 