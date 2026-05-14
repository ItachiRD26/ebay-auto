// ─── Firebase config ──────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:     "AIzaSyC2pPD1o4ffg6XkUjlpIe17IEppk25urjk",
  authDomain: "ebay-5984f.firebaseapp.com",
  projectId:  "ebay-5984f",
};

const DROPFLOW_API = "https://www.dropflow-app.com";

// ─── Firebase Auth via REST API ───────────────────────────────────────────────
async function firebaseSignIn(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_CONFIG.apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Login failed");
  return data;
}

async function firebaseRefreshToken(refreshToken) {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("Token refresh failed");
  return data;
}

// ─── Storage ──────────────────────────────────────────────────────────────────
function saveAuth(d) {
  return chrome.storage.local.set({
    idToken: d.idToken, refreshToken: d.refreshToken,
    uid: d.localId, email: d.email,
    expiresAt: Date.now() + parseInt(d.expiresIn) * 1000,
  });
}
function getAuth() {
  return chrome.storage.local.get(["idToken","refreshToken","uid","email","expiresAt"]);
}
function clearAuth() {
  return chrome.storage.local.remove(["idToken","refreshToken","uid","email","expiresAt"]);
}
async function getValidToken() {
  const auth = await getAuth();
  if (!auth.idToken) return null;
  if (Date.now() > auth.expiresAt - 300_000) {
    try {
      const r = await firebaseRefreshToken(auth.refreshToken);
      await chrome.storage.local.set({ idToken: r.id_token, refreshToken: r.refresh_token, expiresAt: Date.now() + 3600000 });
      return r.id_token;
    } catch { return null; }
  }
  return auth.idToken;
}

// ─── UI ───────────────────────────────────────────────────────────────────────
function showOnly(id) {
  ["screenLogin","screenNotOn1688","screenLoading","screenProduct"].forEach(s => {
    const el = document.getElementById(s);
    el.classList.remove("active");
    el.style.display = "none";
  });
  const el = document.getElementById(id);
  el.style.display = "flex";
  el.classList.add("active");
}
function setStatus(msg) { document.getElementById("footerStatus").textContent = msg; }

// ─── Pricing ──────────────────────────────────────────────────────────────────
function calcSuggestedPrice(usdCost, markupPct = 40) {
  const shipping = usdCost < 5 ? 4.5 : usdCost < 15 ? 5.5 : 6.5;
  const ebayFee  = (usdCost + shipping) * 0.135;
  return Math.ceil((usdCost + shipping + ebayFee) * (1 + markupPct / 100) * 10) / 10;
}

// ─── Fetch stores ─────────────────────────────────────────────────────────────
async function fetchStores(uid, token) {
  const res = await fetch(`${DROPFLOW_API}/api/ebay/stores?userId=${uid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.stores ?? [];
}

// ─── Extract product from 1688 page ──────────────────────────────────────────
// IMPORTANT: runs in page context via executeScript — NO outer scope access
function extractProductData() {
  try {

    // cleanImg MUST be defined inside this function
    function cleanImg(el) {
      if (!el) return null;
      // 1688 lazy-loads — data-src has the real URL
      const raw = el.getAttribute("data-src") || el.getAttribute("src") || "";
      if (!raw || !raw.includes("alicdn")) return null;
      let url = raw.startsWith("//") ? "https:" + raw : raw;
      url = url.split("?")[0];
      // Remove numeric size suffix only: _60x60.jpg, _400x400xz.jpg
      url = url.replace(/_\d+x\d+[a-z]?\.(jpg|jpeg|png|webp)$/i, ".$1");
      return url;
    }

    // ── Title ────────────────────────────────────────────────────────────────
    let title = "";
    for (const sel of ['[class*="offer-title"]','[class*="product-title"]','[class*="detail-title"]','h1[class*="title"]','.title-text','[class*="offerTitle"]']) {
      const t = document.querySelector(sel)?.textContent?.trim();
      if (t && t.length > 5 && !/厂|公司|店铺|旗舰|号|factory/i.test(t)) { title = t; break; }
    }
    if (!title) title = document.title.replace(/[-|].*1688.*$/i,"").replace(/1688.*$/i,"").trim();

    // ── Price ─────────────────────────────────────────────────────────────────
    let priceCNY = 0;
    for (const sel of ['[class*="price-range"] em','[class*="price"] em','[class*="Price"] em','[class*="price-number"]','[class*="priceText"]','.price em','em[class*="price"]']) {
      const num = parseFloat(document.querySelector(sel)?.textContent?.replace(/[^\d.]/g,"") ?? "0");
      if (num > 0) { priceCNY = num; break; }
    }
    if (!priceCNY) {
      document.querySelectorAll("em").forEach(em => {
        if (priceCNY) return;
        const num = parseFloat(em.textContent?.replace(/[^\d.]/g,"") ?? "0");
        if (num > 0.5 && num < 10000) priceCNY = num;
      });
    }

    // ── Images ───────────────────────────────────────────────────────────────
    const images = [], seen = new Set();
    function addImg(src) {
      if (src && !seen.has(src) && images.length < 12) { images.push(src); seen.add(src); }
    }

    // Main images
    for (const sel of ['[class*="main-image"] img','[class*="mainImage"] img','[class*="detail-image"] img','[class*="preview"] img','.img-spot img']) {
      document.querySelectorAll(sel).forEach(img => addImg(cleanImg(img)));
      if (images.length > 0) break;
    }

    // ── Variants ─────────────────────────────────────────────────────────────
    const variantGroups = [], processedGroups = new Set();

    for (const groupSel of ['[class*="sku-prop"]','[class*="skuProp"]','[class*="sku-item"]','[class*="prop-item"]','[class*="attribute-item"]']) {
      const groups = document.querySelectorAll(groupSel);
      if (!groups.length) continue;
      groups.forEach(group => {
        const propName = group.querySelector('[class*="name"],[class*="label"],[class*="title"]')?.textContent?.trim() ?? "Option";
        if (processedGroups.has(propName)) return;
        processedGroups.add(propName);
        const values = [];
        for (const itemSel of ['[class*="sku-item"]','[class*="prop-item"]','li','span[class*="item"]']) {
          const items = group.querySelectorAll(itemSel);
          if (!items.length) continue;
          items.forEach(item => {
            const text = item.textContent?.trim().replace(/\s+/g," ");
            if (!text || text.length > 80 || text === propName) return;
            const imgSrc = cleanImg(item.querySelector("img"));
            if (imgSrc) addImg(imgSrc);
            values.push({ value: text, image: imgSrc });
          });
          if (values.length) break;
        }
        if (values.length) variantGroups.push({ name: propName, values: values.slice(0,20) });
      });
      if (variantGroups.length) break;
    }

    // Fallback — grab all alicdn images
    if (images.length < 4) {
      document.querySelectorAll("img").forEach(img => addImg(cleanImg(img)));
    }

    // Flat variant fallback
    const variantTexts = new Set();
    if (!variantGroups.length) {
      ["[class*='sku'] [class*='item']","[class*='prop'] [class*='item']"].forEach(sel => {
        document.querySelectorAll(sel).forEach(el => { const t = el.textContent?.trim(); if (t && t.length < 60) variantTexts.add(t); });
      });
    }

    // ── Shop / Sold ───────────────────────────────────────────────────────────
    const shopName = (document.querySelector('[class*="company-name"],[class*="seller-name"],[class*="shop-name"]'))?.textContent?.trim() ?? "";
    let soldCount = 0;
    document.querySelectorAll("*").forEach(el => {
      if (soldCount) return;
      const m = (el.textContent??"").match(/(\d+)\s*(?:笔交易|成交|sold)/i);
      if (m) soldCount = parseInt(m[1]);
    });

    return {
      title: title.slice(0,200), priceCNY,
      images: images.slice(0,12),
      variantGroups,
      variants: variantGroups.length > 0
        ? variantGroups.flatMap(g => g.values.map(v => `${g.name}: ${v.value}`))
        : [...variantTexts].slice(0,20),
      shopName, soldCount, sourceUrl: window.location.href,
    };
  } catch(e) {
    return { title:"", priceCNY:0, images:[], variantGroups:[], variants:[], shopName:"", soldCount:0, sourceUrl: window.location.href };
  }
}

async function getProductFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("1688.com")) return null;
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractProductData });
  return results?.[0]?.result ?? null;
}

// ─── State ────────────────────────────────────────────────────────────────────
let currentProduct = null;
let stores = [];
const USD_RATE = 0.138;

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const auth = await getAuth();
  if (!auth.idToken) {
    showOnly("screenLogin");
    document.getElementById("btnLogout").style.display = "none";
    return;
  }
  document.getElementById("userEmail").textContent = auth.email ?? "";
  document.getElementById("btnLogout").style.display = "block";
  setStatus("Logged in");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("1688.com") || !tab?.url?.includes("/offer/")) {
    showOnly("screenNotOn1688"); return;
  }

  showOnly("screenLoading");
  setStatus("Reading product...");

  const token = await getValidToken();
  if (!token) { await clearAuth(); showOnly("screenLogin"); return; }

  try {
    stores = await fetchStores(auth.uid, token);
    document.getElementById("storeSelect").innerHTML = stores.map(s =>
      `<option value="${s.id}">${s.connected ? "🟢" : "🔴"} ${s.name || s.id}</option>`
    ).join("");
  } catch {}

  const product = await getProductFromTab();
  if (!product || !product.title) {
    showOnly("screenNotOn1688");
    document.querySelector("#screenNotOn1688 .info-msg").textContent =
      "⚠️ Could not read product data. Make sure you are on a product detail page.";
    return;
  }

  currentProduct = product;
  const usdCost = product.priceCNY * USD_RATE;
  const suggested = calcSuggestedPrice(usdCost);

  // Image with fallback cycling
  const imgEl = document.getElementById("productImg");
  let imgIdx = 0;
  function tryNextImg() {
    if (imgIdx < product.images.length) { imgEl.src = product.images[imgIdx++]; }
    else imgEl.style.display = "none";
  }
  imgEl.onerror = tryNextImg;
  tryNextImg();

  document.getElementById("productTitle").textContent   = product.title;
  document.getElementById("priceCNY").textContent       = `¥${product.priceCNY.toFixed(2)} CNY`;
  document.getElementById("priceUSD").textContent       = `$${usdCost.toFixed(2)}`;
  document.getElementById("priceSuggested").textContent = `→ eBay $${suggested}`;
  document.getElementById("productVariants").textContent =
    product.variantGroups?.length > 0
      ? product.variantGroups.map(g => `${g.name}: ${g.values.slice(0,4).map(v=>v.value).join(", ")}${g.values.length>4?"...":""}`).join(" · ")
      : product.variants?.length > 0
        ? `${product.variants.length} variants: ${product.variants.slice(0,3).join(", ")}${product.variants.length>3?"...":""}`
        : "No variants";

  showOnly("screenProduct");
  setStatus("Ready to import");
}

// ─── Event handlers ───────────────────────────────────────────────────────────
document.getElementById("btnLogin").addEventListener("click", async () => {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  const btn = document.getElementById("btnLogin");
  errEl.style.display = "none";
  if (!email || !password) { errEl.textContent = "Email and password required"; errEl.style.display = "block"; return; }
  btn.disabled = true; btn.textContent = "Signing in...";
  try {
    await saveAuth(await firebaseSignIn(email, password));
    await init();
  } catch(e) {
    errEl.textContent = e.message.replace("EMAIL_NOT_FOUND","Email not found").replace("INVALID_PASSWORD","Wrong password").replace("INVALID_LOGIN_CREDENTIALS","Invalid email or password");
    errEl.style.display = "block"; btn.disabled = false; btn.textContent = "Sign In";
  }
});

document.getElementById("loginPassword").addEventListener("keydown", e => { if (e.key==="Enter") document.getElementById("btnLogin").click(); });

document.getElementById("btnImport").addEventListener("click", async () => {
  if (!currentProduct) return;
  const btn = document.getElementById("btnImport");
  const errEl = document.getElementById("importError");
  const successEl = document.getElementById("importSuccess");
  const storeId = document.getElementById("storeSelect").value;
  if (!storeId) { errEl.textContent = "Select a store first"; errEl.style.display = "block"; return; }
  errEl.style.display = "none"; successEl.style.display = "none";
  btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Adding...';
  setStatus("Importing...");
  const auth = await getAuth();
  const token = await getValidToken();
  if (!token) { await clearAuth(); showOnly("screenLogin"); return; }
  const usdCost = currentProduct.priceCNY * USD_RATE;
  const suggested = calcSuggestedPrice(usdCost);
  try {
    const res = await fetch(`${DROPFLOW_API}/api/dropflow/import-extension`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userId: auth.uid, storeId,
        title: currentProduct.title,
        price: Math.round(usdCost*100)/100,
        suggestedPrice: suggested,
        shipping: usdCost < 5 ? 4.5 : usdCost < 15 ? 5.5 : 6.5,
        cnyPrice: currentProduct.priceCNY,
        images: currentProduct.images,
        variants: currentProduct.variants,
        variantGroups: currentProduct.variantGroups ?? [],
        shopName: currentProduct.shopName,
        soldCount: currentProduct.soldCount,
        source: "1688-extension",
        source1688Url: currentProduct.sourceUrl,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    successEl.textContent = "✅ Added to Pending! Open DropFlow to review.";
    successEl.style.display = "block";
    btn.innerHTML = "✅ Added!";
    setStatus("Done");
  } catch(e) {
    errEl.textContent = "❌ " + e.message;
    errEl.style.display = "block"; btn.disabled = false; btn.innerHTML = "📥 Add to DropFlow"; setStatus("Error");
  }
});

document.getElementById("btnLogout").addEventListener("click", async () => {
  await clearAuth();
  document.getElementById("userEmail").textContent = "";
  document.getElementById("btnLogout").style.display = "none";
  showOnly("screenLogin"); setStatus("Signed out");
});

init();