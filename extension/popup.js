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
    // Title
    const titleEl = document.querySelector(".offer-title, h1.title, .title-text, [class*='title']");
    const title = titleEl?.textContent?.trim() ?? document.title ?? "";

    // Price — 1688 shows price in various formats
    const priceEl = document.querySelector(".price-value, .price-number, [class*='price'] em, [class*='Price'] span");
    const priceText = priceEl?.textContent?.trim().replace(/[^\d.]/g, "") ?? "0";
    const priceCNY = parseFloat(priceText) || 0;

    // Images — main image and gallery
    const images = [];
    const mainImg = document.querySelector(".main-photo img, .gallery-photo img, [class*='main-pic'] img");
    if (mainImg?.src) images.push(mainImg.src.replace(/_.+\.jpg/, ".jpg")); // remove size suffix

    const galleryImgs = document.querySelectorAll(".img-spot img, .gallery img, [class*='gallery'] img, [class*='thumbnail'] img");
    galleryImgs.forEach(img => {
      const src = img.src?.replace(/_.+\.jpg/, ".jpg");
      if (src && !images.includes(src) && images.length < 10) images.push(src);
    });

    // Variants (colors, sizes)
    const variantEls = document.querySelectorAll("[class*='sku'] [class*='item'], [class*='prop'] [class*='item']");
    const variants = [];
    variantEls.forEach(el => {
      const text = el.textContent?.trim();
      if (text && text.length < 50) variants.push(text);
    });

    // Shop name
    const shopEl = document.querySelector("[class*='company'] a, [class*='shop-name'], [class*='seller']");
    const shopName = shopEl?.textContent?.trim() ?? "";

    // Sold count
    const soldEl = document.querySelector("[class*='sold'], [class*='volume']");
    const soldText = soldEl?.textContent?.match(/\d+/)?.[0] ?? "0";

    return {
      title:    title.slice(0, 200),
      priceCNY,
      images:   images.slice(0, 8),
      variants: [...new Set(variants)].slice(0, 20),
      shopName,
      soldCount: parseInt(soldText) || 0,
      sourceUrl: window.location.href,
    };
  } catch (e) {
    return null;
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