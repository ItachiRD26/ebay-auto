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

    // ── Helpers ──────────────────────────────────────────────────────────────
    function cleanUrl(raw) {
      if (!raw || !raw.includes("alicdn")) return null;
      let url = raw.startsWith("//") ? "https:" + raw : raw;
      url = url.split("?")[0].split("_.")[0]; // strip alicdn resize suffixes
      if (!url.match(/\.(jpg|jpeg|png|webp)$/i)) url = url.replace(/(_[a-z0-9]+)?$/, ".jpg");
      return url;
    }
    function cleanImg(el) {
      if (!el) return null;
      const raw = el.getAttribute("data-src") || el.getAttribute("src") || "";
      return cleanUrl(raw);
    }
    const images = [], seen = new Set();
    function addImg(src) {
      const clean = typeof src === "string" && src.includes("alicdn") ? cleanUrl(src) : src;
      if (clean && !seen.has(clean) && images.length < 12) { images.push(clean); seen.add(clean); }
    }

    // ── Check login status ───────────────────────────────────────────────────
    // 1688 hides skuProps/variants behind login — FE_GLOBALS.loginId is null when not logged in
    const is1688LoggedIn = window.FE_GLOBALS?.loginId != null;

    // ── PRIMARY: read from window.context (embedded JSON in page) ────────────
    // 1688 inlines ALL product data as window.context — far more reliable than DOM scraping
    const ctx = window.context?.result;
    const globalModel  = ctx?.global?.globalData?.model ?? {};
    const offerDetail  = globalModel.offerDetail ?? {};
    const tradeModel   = globalModel.tradeModel ?? {};
    const dataJson     = ctx?.data?.Root?.fields?.dataJson ?? {};
    const galleryFields = ctx?.data?.gallery?.fields ?? {};

    // ── Title ────────────────────────────────────────────────────────────────
    let title = offerDetail.subject
             || dataJson.tempModel?.offerTitle
             || ctx?.data?.productTitle?.fields?.title
             || "";
    if (!title) {
      for (const sel of ['.title-text','[class*="title-text"]','[class*="offer-title"]','h1']) {
        const t = document.querySelector(sel)?.textContent?.trim();
        if (t && t.length > 5) { title = t; break; }
      }
    }
    if (!title) title = document.title.replace(/[-|].*$/,"").trim();

    // ── Price ─────────────────────────────────────────────────────────────────
    let priceCNY = parseFloat(tradeModel.minPrice ?? 0)
                || parseFloat(dataJson.orderParamModel?.orderParam?.skuParam?.skuRangePrices?.[0]?.price ?? 0)
                || 0;
    if (!priceCNY) {
      // DOM fallback — look for price in em tags inside price containers
      for (const sel of ['[class*="price"] em','em[class*="price"]','.price-num']) {
        const num = parseFloat(document.querySelector(sel)?.textContent?.replace(/[^\d.]/g,"") ?? "0");
        if (num > 0) { priceCNY = num; break; }
      }
      if (!priceCNY) {
        document.querySelectorAll("em").forEach(em => {
          if (priceCNY) return;
          const num = parseFloat(em.textContent?.replace(/[^\d.]/g,"") ?? "0");
          if (num > 0.5 && num < 50000) priceCNY = num;
        });
      }
    }

    // ── Images ───────────────────────────────────────────────────────────────
    // From window.context gallery (most reliable — full-size URLs)
    const ctxImgs = galleryFields.offerImgList ?? galleryFields.mainImage ?? [];
    ctxImgs.forEach(u => addImg(u));

    // Also grab skuProp images from context
    const ctxSkuProps = offerDetail.skuProps ?? dataJson.skuModel?.skuProps ?? [];
    ctxSkuProps.forEach(prop => {
      (prop.value ?? []).forEach(v => { if (v.imageUrl) addImg(v.imageUrl); });
    });

    // DOM fallback for images if context gave us nothing
    if (images.length < 3) {
      for (const sel of [
        '[class*="main-image"] img', '[class*="mainImage"] img',
        '[class*="gallery"] img',    '[class*="preview"] img',
        '.img-spot img',
      ]) {
        document.querySelectorAll(sel).forEach(img => addImg(cleanImg(img)));
        if (images.length >= 3) break;
      }
      if (images.length < 3) {
        document.querySelectorAll("img").forEach(img => addImg(cleanImg(img)));
      }
    }

    // ── Variants ─────────────────────────────────────────────────────────────
    const variantGroups = [];

    // PRIMARY: read from window.context skuProps — always has correct data
    // Path 1: offerDetail.skuProps  (most pages)
    // Path 2: dataJson.skuModel.skuProps  (alternative path)
    const skuProps = (ctxSkuProps.length > 0) ? ctxSkuProps : [];

    skuProps.forEach(prop => {
      const name = prop.prop ?? prop.name ?? "Option";
      const values = (prop.value ?? [])
        .map(v => ({ value: v.name ?? v.value ?? "", image: v.imageUrl ?? null }))
        .filter(v => v.value);
      if (values.length) variantGroups.push({ name, values: values.slice(0, 20) });
    });

    // FALLBACK: DOM scraping if context had no skuProps
    // 1688 renders variants as: .sku-filter-button > .label-name  (with optional .ant-image-img)
    // Groups are wrapped in a container that has a sibling prop-name element
    if (!variantGroups.length) {
      // Each prop group is a container with a title and buttons
      const groupContainers = document.querySelectorAll(
        '[class*="SkuItem"], [class*="sku-select-item"], [class*="skuSelectItem"], [class*="prop-wrap"], [class*="propWrap"]'
      );
      groupContainers.forEach(group => {
        const propName = (
          group.querySelector('[class*="prop-title"], [class*="propTitle"], [class*="sku-name"]')
          ?? group.previousElementSibling
        )?.textContent?.trim() ?? "Option";

        const values = [];
        // Each clickable option: button.sku-filter-button > span.label-name
        group.querySelectorAll('.sku-filter-button, [class*="filter-button"], [class*="filterButton"]').forEach(btn => {
          const text = btn.querySelector('.label-name, [class*="label-name"]')?.textContent?.trim()
                    ?? btn.textContent?.trim();
          if (!text || text.length > 80) return;
          const imgEl = btn.querySelector('img.ant-image-img, img[class*="image"]');
          const imgSrc = imgEl ? cleanImg(imgEl) : null;
          if (imgSrc) addImg(imgSrc);
          values.push({ value: text, image: imgSrc });
        });
        if (values.length) variantGroups.push({ name: propName, values: values.slice(0, 20) });
      });
    }

    // Last-resort flat variant text collect
    const variantTexts = new Set();
    if (!variantGroups.length) {
      document.querySelectorAll('.sku-filter-button .label-name, [class*="label-name"]').forEach(el => {
        const t = el.textContent?.trim();
        if (t && t.length < 80) variantTexts.add(t);
      });
    }

    // ── Shop / Sold ───────────────────────────────────────────────────────────
    const shopName = globalModel.sellerModel?.loginId
                  || dataJson.tempModel?.sellerLoginId
                  || document.querySelector('[class*="company-name"],[class*="shop-name"],[class*="seller-name"]')?.textContent?.trim()
                  || "";
    const soldCount = dataJson.tempModel?.saledCount
                   || tradeModel.saleCount
                   || 0;

    return {
      title: title.slice(0, 200),
      priceCNY,
      images: images.slice(0, 12),
      variantGroups,
      variants: variantGroups.length > 0
        ? variantGroups.flatMap(g => g.values.map(v => `${g.name}: ${v.value}`))
        : [...variantTexts].slice(0, 20),
      shopName,
      soldCount,
      sourceUrl: window.location.href,
      is1688LoggedIn,
    };
  } catch(e) {
    return { title:"", priceCNY:0, images:[], variantGroups:[], variants:[], shopName:"", soldCount:0, sourceUrl: window.location.href, _err: e.message };
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

  // Warn if not logged into 1688 — variants and extra images won't be available
  const loginWarnEl = document.getElementById("warn1688Login");
  if (loginWarnEl) {
    loginWarnEl.style.display = product.is1688LoggedIn ? "none" : "flex";
  }

  showOnly("screenProduct");
  setStatus(product.is1688LoggedIn ? "Ready to import" : "⚠️ Log into 1688 for variants");
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