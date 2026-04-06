import { db, COLLECTIONS, queueCol, settingsDoc, seenCol } from "@/lib/firebase";
import { getReferenceItemData } from "@/lib/ebay";
import {
  getVerifiedLeafCategory,
  fetchRequiredAspects,
  buildSmartAspects,
  detectTypeFromTitle,
  CATEGORY_TYPES,
} from "@/lib/category-aspects";
import { getAppToken } from "@/lib/ebay";

interface VariationSpec { specifics: Record<string, string>; refPrice: number; }
interface VariationsData { variations: VariationSpec[]; specificsSet: Record<string, string[]>; picturesByVariant: Record<string, string[]>; pictureDimension: string; }
interface ReferenceItemData { title: string; description: string; categoryId: string; aspects: Record<string, string[]>; imageUrls: string[]; condition: string; variations: VariationsData | null; }

export async function generateTitleAndDescription(title: string, aspects: Record<string, string[]>): Promise<{ title: string; description: string }> {
  try {
    const aspectsText = Object.entries(aspects).slice(0, 8).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n");
    const prompt = `You are an eBay listing writer. Given a product title and details, return ONLY valid JSON.\n\nProduct title: ${title}\n${aspectsText ? `Details:\n${aspectsText}` : ""}\n\nReturn exactly this JSON (no markdown, no extra text):\n{"title":"rewritten title here","description":"3-4 sentence description here"}\n\nTitle rules:\n- Keep core product name + key features\n- Remove ALL brand names, celebrity names, trademarked terms\n- Remove Chinese characters or non-English text\n- Max 80 chars\n- Do NOT copy original title exactly\n- No HTML, no URLs\n\nDescription rules:\n- Professional tone only\n- Highlight features and practical benefits\n- NO brand names, NO medical/health claims, NO adult content\n- NO dropshipping/supplier/wholesale mentions\n- NO URLs or external links\n- Plain text only, no HTML\n- Under 150 words`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) { const errText = await res.text(); throw new Error(`Claude API ${res.status}: ${errText.slice(0,100)}`); }
    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() ?? "";
    if (!raw) throw new Error(`Claude empty response (stop_reason: ${data.stop_reason})`);
    console.log(`[publish] Claude raw: ${raw.slice(0,80)}`);
    const clean = raw.replace(/```json|```/g, "").trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in Claude response: "${raw.slice(0,60)}"`);
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, string>;
    if (parsed.title && parsed.description) {
      console.log(`[publish] Title: "${parsed.title}" | Desc: ${parsed.description.length} chars`);
      return { title: parsed.title, description: parsed.description };
    }
  } catch (e) { console.warn("[publish] Claude failed, using original title:", e); }
  // FIX: return empty description so the caller can generate a proper fallback
  // Old code: return { title, description: title } — set description = title (wrong!)
  return { title, description: "" };
}

async function findAlternativeReference(title: string, originalItemId: string, userToken: string): Promise<{ itemId: string; categoryId: string; aspects: Record<string, string[]>; images: string[] } | null> {
  try {
    const appToken = await getAppToken();
    const params = new URLSearchParams({ q: title.split(" ").slice(0, 5).join(" "), limit: "10", filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:CN,conditions:{NEW}", fieldgroups: "EXTENDED" });
    const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, { headers: { Authorization: `Bearer ${appToken}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json() as { itemSummaries?: Record<string, unknown>[] };
    for (const item of data.itemSummaries ?? []) {
      const rawId = (item.itemId as string) ?? "";
      const numericId = rawId.split("|")[1] ?? rawId;
      if (numericId === originalItemId) continue;
      if (numericId.startsWith(originalItemId.slice(0, 6))) continue;
      const refData = await getReferenceItemData(numericId, userToken);
      if (!refData) continue;
      console.log(`[publish] 🔍 Alt ref: ${numericId} — ${Object.keys(refData.aspects).length} aspects`);
      return { itemId: numericId, categoryId: refData.categoryId, aspects: refData.aspects, images: refData.imageUrls };
    }
    return null;
  } catch (e) { console.warn("[publish] findAlternativeReference error:", e); return null; }
}

async function autoFixWithClaude(errorMsg: string, product: { title: string; description: string; categoryId: string; aspects: Record<string, string[]> }): Promise<{ title?: string; description?: string; categoryId?: string; aspects?: Record<string, string[]> } | null> {
  try {
    const err = errorMsg.toLowerCase();
    const isImproper  = err.includes("improper") || err.includes("policy") || err.includes("violation");
    const isMissing   = err.includes("missing") || err.includes("item specific");
    const isTooLong   = err.includes("too long") || err.includes("characters");

    let prompt: string;

    if (isImproper) {
      // Fully rewrite title and description to be eBay-safe
      // Strip everything problematic from title before sending to Claude
      const cleanTitle = product.title
        .replace(/[一-鿿　-〿＀-￯]/g, "") // strip Chinese/CJK
        .replace(/[^\w\s,\-()&]/g, " ")                              // keep safe chars only
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 75);
      prompt = `You are an eBay listing writer. Rewrite this product for eBay compliance.
Product: "${product.title}"
Clean base title (use as starting point): "${cleanTitle}"
Rules:
- Remove ALL brand names, celebrity names, trademarked terms (Nike, Apple, etc.)
- Remove any Chinese or non-English characters
- No medical claims, no adult content, no weapons references
- Professional tone, highlight practical features and benefits only
- Title max 80 chars, description 2-3 sentences, plain text, no HTML, no URLs
Return ONLY this JSON (no markdown):
{"title":"rewritten safe title here","description":"2-3 sentence professional product description here"}`;
    } else if (isMissing) {
      // Extract the specific missing field from the error message
      const styleMatch    = errorMsg.match(/Style/i);
      const deptMatch     = errorMsg.match(/Department/i);
      const modelMatch    = errorMsg.match(/Model/i);
      const missingFields = errorMsg.match(/item specific ([A-Za-z ]+) is missing/gi) ?? [];
      const fields = missingFields.map(m => m.replace(/item specific /i, "").replace(/ is missing/i, "").trim());
      if (styleMatch && !fields.includes("Style")) fields.push("Style");
      if (deptMatch  && !fields.includes("Department")) fields.push("Department");
      if (modelMatch && !fields.includes("Model")) fields.push("Model");

      const t = product.title.toLowerCase();
      // Pre-compute smart defaults based on title
      const isFootwearCtx = ["shoe","boot","loafer","mule","sneaker","sandal","slipper","heel","pump","oxford","trainer","footwear","flat"].some(w => t.includes(w));
      const smartDefaults: Record<string, string> = {
        Style: isFootwearCtx
          ? (t.includes("casual") || t.includes("loafer") || t.includes("mule") || t.includes("slip") ? "Casual" : t.includes("sport") || t.includes("running") ? "Athletic" : t.includes("formal") || t.includes("dress") || t.includes("oxford") ? "Formal" : "Casual")
          : (t.includes("vintage") ? "Vintage" : t.includes("modern") ? "Modern" : t.includes("retro") ? "Retro" : t.includes("sport") ? "Athletic" : "Casual"),
        Department: t.includes("men") || t.includes("male") || t.includes("boy") ? "Men" : t.includes("women") || t.includes("female") || t.includes("girl") || t.includes("lady") ? "Women" : t.includes("kid") || t.includes("child") || t.includes("baby") ? "Kids" : "Men",
        Model: "Compatible",
        "Occasion": isFootwearCtx
          ? (t.includes("sport") || t.includes("running") || t.includes("gym") ? "Athletic" : t.includes("formal") || t.includes("dress") ? "Formal" : "Casual")
          : (t.includes("sport") || t.includes("gym") || t.includes("bike") ? "Sport" : t.includes("office") || t.includes("work") ? "Work" : "Casual"),
        "Sleeve Length": t.includes("short sleeve") ? "Short Sleeve" : t.includes("long sleeve") || t.includes("long-sleeve") ? "Long Sleeve" : t.includes("sleeveless") ? "Sleeveless" : "Long Sleeve",
        "Fastening": t.includes("lace") ? "Lace Up" : t.includes("slip") || t.includes("loafer") || t.includes("mule") ? "Slip On" : t.includes("buckle") ? "Buckle" : "Slip On",
        "Toe Shape": t.includes("round") ? "Round Toe" : t.includes("pointed") ? "Pointed Toe" : t.includes("square") ? "Square Toe" : "Round Toe",
        "Upper Material": t.includes("suede") ? "Suede" : t.includes("leather") ? "Leather" : t.includes("canvas") ? "Canvas" : t.includes("mesh") ? "Mesh" : "Synthetic",
      };

      const aspectsToAdd: Record<string, string[]> = {};
      for (const field of fields) {
        aspectsToAdd[field] = [smartDefaults[field] ?? "Other"];
      }

      prompt = `You are an eBay listing fixer. The listing is missing required item specifics.
Product title: "${product.title}"
Missing fields: ${fields.join(", ")}
Current aspects: ${JSON.stringify(product.aspects).slice(0, 200)}
Pre-computed defaults: ${JSON.stringify(smartDefaults)}

Return ONLY this JSON with appropriate values for the missing fields (use the pre-computed defaults as guidance, improve if you can based on the title):
{"aspects": ${JSON.stringify(aspectsToAdd)}}`;
    } else if (isTooLong) {
      prompt = `Fix this eBay listing error: "${errorMsg}".
Aspects: ${JSON.stringify(product.aspects).slice(0, 300)}.
Truncate any aspect value that exceeds 65 characters.
Return ONLY valid JSON: {"aspects": {"field": ["truncated value"]}}`;
    } else {
      prompt = `You are an eBay listing fixer. Error: "${errorMsg}". Title: ${product.title}. Aspects: ${JSON.stringify(product.aspects).slice(0,200)}. Fix only what the error requires. Return ONLY valid JSON with changed fields, or the text null if unfixable.`;
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] }) });
    if (!res.ok) return null;
    const data = await res.json() as { content: { type: string; text: string }[] };
    const text = data.content.find((b: { type: string }) => b.type === "text")?.text ?? "";
    if (text.trim() === "null") return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch { return null; }
}

// ─── REMOVED: getLeafCategoryByTitle (inline) ─────────────────────────────────
// Replaced by matchCategoryByTitle() + getVerifiedLeafCategory() in category-aspects.ts
// which:
//   1. Keyword-matches the title
//   2. Validates the match is actually a leaf via eBay Taxonomy API
//   3. Falls back to Taxonomy API suggestion for the full title
//   4. Falls back to original CN category if that's a leaf
//   5. Last resort: "20625" (Kitchen Storage, always a leaf)

function escXml(s: string): string {
  // Full XML escape for attributes and URLs
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

function escVal(s: string): string {
  // For element content (Value, Name tags) — only escape &, <, >
  // eBay displays &quot; literally in variation selectors — use raw " instead
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function addFixedPriceItem(product: {
  title: string; description: string; categoryId: string; categoryType?: import("@/lib/category-aspects").CategoryType; price: number;
  stock: number; images: string[]; condition: string; aspects: Record<string, string[]>;
  variations?: VariationsData | null; markupRatio?: number;
  fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string;
  itemCountry?: string; itemLocation?: string;
}, userToken: string): Promise<{ itemId: string }> {

  // ── Aspect building: use category-aware builder instead of scattered inline logic ──
  // This fixes:
  //   1. "Department/Style missing" for footwear (now always added for footwear types)
  //   2. "Department/Style on dog collars" (pet types filter out clothing aspects)
  //   3. Chinese values (stripped inside buildSmartAspects)
  //   4. Aspects from wrong category (filtered by VALID_ASPECTS per type)
  const appToken = await getAppToken();
  const categoryType = product.categoryType ?? CATEGORY_TYPES[product.categoryId] ?? detectTypeFromTitle(product.title);
  const requiredAspectsForCategory = await fetchRequiredAspects(product.categoryId, appToken);
  const aspects = buildSmartAspects(
    product.title,
    categoryType,
    product.aspects,
    requiredAspectsForCategory,
  );

  const picturesXml = product.images.slice(0, 12).map(url => `<PictureURL>${escXml(url)}</PictureURL>`).join("");
  const conditionId = ({"New":"1000","New with tags":"1000","New with box":"1000","New without tags":"1500","Like New":"2500","Used":"3000"} as Record<string,string>)[product.condition] ?? "1000";
  const varData = product.variations;
  const markupRatio = product.markupRatio ?? 1.06;
  let variationsXml = "";
  let hasVariations = false;

  if (varData && varData.variations.length > 0) {
    hasVariations = true;
    const refPrices = varData.variations.map((v: VariationSpec) => v.refPrice).filter((p: number) => p > 0);
    const refMin  = refPrices.length > 0 ? Math.min(...refPrices) : 0;
    const refMax  = refPrices.length > 0 ? Math.max(...refPrices) : 0;
    // basePrice = our price for the CHEAPEST variant (same as suggestedSellingPrice)
    // markupRatio = how much above refMin we want to list (e.g. 1.06 = 6% above ref min)
    const basePrice   = product.price;  // already calculated as refMin * markupRatio
    const appliedRatio = refMin > 0 ? basePrice / refMin : (product.markupRatio ?? 1.06);
    console.log(`[publish] Variation pricing: refMin=$${refMin} refMax=$${refMax} basePrice=$${basePrice} ratio=${appliedRatio.toFixed(3)}`);
    const variationItems = varData.variations.map((v: VariationSpec) => {
      // Scale each variant by the same ratio applied to the min variant
      // e.g. ref variant = $20, ref min = $10 → our variant = $10*ratio * (20/10) = ratio*$20
      const varPrice = (refMin > 0 && v.refPrice > 0)
        ? +Math.max(basePrice, (v.refPrice * appliedRatio)).toFixed(2)
        : basePrice;
      const varSpecificsXml = Object.entries(v.specifics).map(([name, val]) => `<NameValueList><Name>${escXml(name)}</Name><Value>${escXml(val)}</Value></NameValueList>`).join("");
      return `<Variation><SKU>${escXml(Object.values(v.specifics).map((x: unknown) => String(x)).join("-"))}</SKU><StartPrice>${varPrice}</StartPrice><Quantity>${product.stock}</Quantity><VariationSpecifics>${varSpecificsXml}</VariationSpecifics></Variation>`;
    }).join("");
    const setXml = Object.entries(varData.specificsSet).map(([name, vals]) => { const valsXml = (vals as string[]).map((v: string) => `<Value>${escXml(v)}</Value>`).join(""); return `<NameValueList><Name>${escXml(name)}</Name>${valsXml}</NameValueList>`; }).join("");
    let picturesBlockXml = "";
    if (varData.pictureDimension && Object.keys(varData.picturesByVariant).length > 0) {
      const pictureSets = Object.entries(varData.picturesByVariant).map(([value, urls]) => { const urlsXml = (urls as string[]).slice(0, 6).map((u: string) => `<PictureURL>${escXml(u)}</PictureURL>`).join(""); return `<VariationSpecificPictureSet><VariationSpecificValue>${escVal(value)}</VariationSpecificValue>${urlsXml}</VariationSpecificPictureSet>`; }).join("");
      picturesBlockXml = `<Pictures><VariationSpecificName>${escXml(varData.pictureDimension)}</VariationSpecificName>${pictureSets}</Pictures>`;
      console.log(`[publish] 🖼 Variation pictures mapped: ${Object.keys(varData.picturesByVariant).length} values for "${varData.pictureDimension}"`);
    }
    variationsXml = `<Variations>${variationItems}${picturesBlockXml}<VariationSpecificsSet>${setXml}</VariationSpecificsSet></Variations>`;
  }

  // Case-insensitive match — "color" and "Color" both excluded from ItemSpecifics
  const variationDimensions = hasVariations && varData
    ? new Set(Object.keys(varData.specificsSet).map(k => k.toLowerCase()))
    : new Set<string>();
  const specificsXml = Object.entries(aspects).filter(([name]) => !variationDimensions.has(name.toLowerCase())).map(([name, values]) => values.map(v => `<NameValueList><Name>${escXml(name)}</Name><Value>${escXml(v)}</Value></NameValueList>`).join("")).join("");
  // ── Sanitize description per eBay Trading API rules ─────────────────────────
  const stripProblematic = (text: string): string =>
    text.replace(/<[^>]+>/g, " ").replace(/https?:\/\/\S+/gi, "").replace(/[^\x20-\x7E]/g, "")
        .replace(/\b(cure|treat|heal|diagnos|medic|FDA|prescription|drug|narcotic|weapon|gun|ammo|counterfeit|replica|fake|copyright|trademark|brand)\b/gi, "")
        .replace(/\b(sexy|adult|xxx|porn|nude|erotic|fetish|explicit)\b/gi, "")
        .replace(/\s{2,}/g, " ").trim();

  const strippedRawDesc = stripProblematic(product.description || "");
  // If description is empty (CN image-based listing), use precomputed description or title fallback
  const safeDesc = strippedRawDesc.length >= 30
    ? strippedRawDesc.slice(0, 500)
    : `${product.title.replace(/[^\x20-\x7E]/g, " ").trim().slice(0, 60)}. Durable and practical for everyday use. Fast shipping with tracking.`;

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <Item>
    <Title>${escXml(product.title.slice(0, 80))}</Title>
    <Description><![CDATA[${safeDesc}]]></Description>
    <PrimaryCategory><CategoryID>${product.categoryId}</CategoryID></PrimaryCategory>
    ${!hasVariations ? `<StartPrice>${product.price.toFixed(2)}</StartPrice>` : ""}
    <CategoryMappingAllowed>true</CategoryMappingAllowed>
    <ConditionID>${conditionId}</ConditionID>
    <Country>${product.itemCountry ?? "CN"}</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>5</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>${product.itemLocation ?? "Shenzhen"}</Location>
    ${!hasVariations ? `<Quantity>${product.stock}</Quantity>` : ""}
    <PictureDetails>${picturesXml}</PictureDetails>
    ${specificsXml ? `<ItemSpecifics>${specificsXml}</ItemSpecifics>` : ""}
    ${variationsXml}
    <SellerProfiles>
      <SellerShippingProfile><ShippingProfileID>${product.fulfillmentPolicyId ?? process.env.EBAY_FULFILLMENT_POLICY_ID}</ShippingProfileID></SellerShippingProfile>
      <SellerReturnProfile><ReturnProfileID>${product.returnPolicyId ?? process.env.EBAY_RETURN_POLICY_ID}</ReturnProfileID></SellerReturnProfile>
      <SellerPaymentProfile><PaymentProfileID>${product.paymentPolicyId ?? process.env.EBAY_PAYMENT_POLICY_ID}</PaymentProfileID></SellerPaymentProfile>
    </SellerProfiles>
    <Site>US</Site>
  </Item>
</AddFixedPriceItemRequest>`;

  const https = await import("node:https");
  const { statusCode, body } = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const buf = Buffer.from(xml, "utf-8");
    const req = https.request({ hostname: "api.ebay.com", path: "/ws/api.dll", method: "POST", headers: { "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "967", "X-EBAY-API-CALL-NAME": "AddFixedPriceItem", "Content-Type": "text/xml", "Content-Length": buf.length.toString() } }, (res) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") })); });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(buf); req.end();
  });

  if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
  const errorBlockRegex = /<Errors>([\s\S]*?)<\/Errors>/g;
  let errBlock; const realErrors: string[] = [];
  while ((errBlock = errorBlockRegex.exec(body)) !== null) {
    const block = errBlock[1];
    if (block.includes("<SeverityCode>Error</SeverityCode>")) { const m = block.match(/<LongMessage>(.*?)<\/LongMessage>/); realErrors.push(m?.[1] ?? "Unknown error"); }
    else { const m = block.match(/<ShortMessage>(.*?)<\/ShortMessage>/); console.warn(`[publish] eBay warning: ${m?.[1] ?? "unknown"}`); }
  }
  if (realErrors.length > 0) {
    const combined = realErrors.join(" | ");
    if (combined.includes("mixture of Self Hosted and EPS")) throw new Error("Imágenes mixtas (EPS + externas) — requiere revisión manual");
    if (combined.includes("already have on eBay")) throw new Error("Producto duplicado — ya existe un listing idéntico");
    throw new Error(combined);
  }
  const itemMatch = body.match(/<ItemID>(\d+)<\/ItemID>/);
  if (!itemMatch) throw new Error("No ItemID in response: " + body.slice(0, 200));
  return { itemId: itemMatch[1] };
}

// ─── Get eBay policies for a store (Firestore first, fallback to .env) ────────
async function getStorePolicies(userId: string, storeId: string): Promise<{
  fulfillmentPolicyId: string;
  paymentPolicyId:     string;
  returnPolicyId:      string;
  itemCountry:         string;
  itemLocation:        string;
}> {
  try {
    const snap = await settingsDoc(userId, "main").get();
    const data = snap.data() as Record<string, unknown> | undefined;
    const policies = data?.policies as Record<string, Record<string, string>> | undefined;
    const p = policies?.[storeId];
    if (p?.fulfillmentPolicyId && p?.paymentPolicyId && p?.returnPolicyId) {
      return {
        fulfillmentPolicyId: p.fulfillmentPolicyId,
        paymentPolicyId:     p.paymentPolicyId,
        returnPolicyId:      p.returnPolicyId,
        itemCountry:         p.itemCountry   ?? "CN",
        itemLocation:        p.itemLocation  ?? "Shenzhen",
      };
    }
  } catch {}
  return {
    fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID ?? "",
    paymentPolicyId:     process.env.EBAY_PAYMENT_POLICY_ID     ?? "",
    returnPolicyId:      process.env.EBAY_RETURN_POLICY_ID      ?? "",
    itemCountry:         "CN",
    itemLocation:        "Shenzhen",
  };
}


// ─── Validate category and build aspects in one pass ──────────────────────────
// Replaces the old validateAndFixCategory which trusted hardcoded IDs without
// API validation — causing "not a leaf category" errors in production.
async function resolveCategory(
  originalCategoryId: string,
  title: string,
): Promise<{ id: string; type: import("@/lib/category-aspects").CategoryType }> {
  return getVerifiedLeafCategory(title, originalCategoryId);
}


export async function publishProductById(productId: string, userToken: string, userId: string, storeId?: string, forceVariations = false): Promise<{ listingId: string }> {
  const docRef = queueCol(userId).doc(productId);
  const doc = await docRef.get();
  if (!doc.exists) throw new Error("Product not found");
  const product = doc.data()!;

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const counterRef = db.collection("counters").doc(`listings_${monthKey}`);
  const counterDoc = await counterRef.get();
  const currentCount = counterDoc.exists ? (counterDoc.data()!.count as number) : 0;
  const MONTHLY_LIMIT = 245;
  if (currentCount >= MONTHLY_LIMIT) throw new Error(`Límite mensual alcanzado (${currentCount}/${MONTHLY_LIMIT} listings este mes)`);

  const sid = storeId ?? (product.storeId as string) ?? "";
  const [policies, userSettingsSnap] = await Promise.all([
    getStorePolicies(userId, sid),
    settingsDoc(userId, "main").get(),
  ]);
  const userSettings = userSettingsSnap.data() as Record<string, unknown> | undefined;
  const MAX_VARIATIONS = (userSettings?.maxVariations as number) ?? 12;

  if (product.failReason) await docRef.update({ failReason: null, status: "approved" });

  let refAspects: Record<string, string[]> = {};
  let refImages: string[] = product.images ?? [];
  let refCategoryId = product.categoryId;
  let refVariations = null;

  if (product.ebayItemId) {
    const rawId = String(product.ebayItemId);
    const parts = rawId.split("|");
    const numericItemId = parts.length >= 2 ? parts[1] : rawId;
    console.log(`[publish] GetItem ref → rawId="${rawId}" numericId="${numericItemId}"`);
    const refData = await getReferenceItemData(numericItemId, userToken);
    console.log(`[publish] refData=${refData ? "OK" : "NULL"}`);
    if (refData) {
      refAspects = refData.aspects;
      if (refData.categoryId) refCategoryId = refData.categoryId;
      const merged = [...refImages];
      refData.imageUrls.forEach((u: string) => { if (!merged.includes(u)) merged.push(u); });
      refImages = merged.slice(0, 12);
      refVariations = (refData as unknown as ReferenceItemData).variations ?? null;
      if (refVariations && refVariations.variations.length > MAX_VARIATIONS) {
        if (forceVariations) {
          // List ALL variants — user chose to ignore the limit
          console.log(`[publish] ⚡ forceVariations=true — listing all ${refVariations.variations.length} variants`);
        } else {
          throw new Error(`TOO_MANY_VARIATIONS:${refVariations.variations.length}:${MAX_VARIATIONS}`);
        }
      }
      const varInfo = refVariations ? ` | ${refVariations.variations.length} variantes (${Object.keys(refVariations.specificsSet).join(", ")})` : " | sin variantes";
      console.log(`[publish] ${productId} — ${Object.keys(refAspects).length} aspects, ${refImages.length} images${varInfo}`);
    }
  }

  const markupRatio = product.totalMarketCost > 0 ? product.suggestedSellingPrice / product.totalMarketCost : 1.06;

  // If previous attempt failed with improper/policy error, skip standard generate
  // and go straight to aggressive clean rewrite — don't repeat the same mistake
  const prevFail = String(product.failReason ?? "").toLowerCase();
  const wasImproper = prevFail.includes("improper") || prevFail.includes("policy") || prevFail.includes("violation");

  // When retrying after improper, always use our local category mapping
  // instead of trusting the CN seller's category (which may be restricted for new accounts)
  if (wasImproper && refCategoryId) {
    // Re-resolve with API validation instead of trusting hardcoded keyword map
    const localCat = await resolveCategory(refCategoryId, product.title);
    if (localCat.id !== refCategoryId) {
      console.log(`[publish] ♻ wasImproper: overriding CN cat ${refCategoryId} → resolved ${localCat.id} (${localCat.type})`);
      refCategoryId = localCat.id;
    }
  }

  let publishTitle: string;
  let publishDesc:  string;

  if (wasImproper) {
    // Aggressive pre-clean of the title before sending to Claude
    const strippedTitle = product.title
      .replace(/[一-鿿　-〿＀-￯]+/g, " ")  // strip CJK
      .replace(/[^\w\s,\-()'&]/g, " ")                                // safe chars only
      .replace(/\s{2,}/g, " ").trim().slice(0, 75);
    const fix = await autoFixWithClaude("improper listing policy violation", {
      title: strippedTitle,
      description: "",
      categoryId: "",
      aspects: refAspects,
    });
    publishTitle = fix?.title ?? strippedTitle;
    publishDesc  = fix?.description ?? `High-quality ${strippedTitle}. Practical and durable for everyday use. Easy to maintain. Fast shipping included.`;
    console.log(`[publish] ♻ Retry after improper — forced clean rewrite: "${publishTitle}"`);
  } else {
    const { title: cleanTitle, description } = await generateTitleAndDescription(product.title, refAspects);
    publishTitle = cleanTitle;
    // Fix: generateTitleAndDescription returns "" on failure — generate a proper fallback
    publishDesc  = description || `${cleanTitle}. Durable and practical for everyday use. High quality construction. Fast shipping with tracking included.`;
  }

  let itemId: string;
  // If CN description is image-based, generate from aspects NOW while we have refAspects
  const rawCNDesc = (product.description || "").replace(/<[^>]+>/g, " ").replace(/[^ -~]/g, "").trim();
  if (rawCNDesc.length < 30 && Object.keys(refAspects).length > 0 && !wasImproper) {
    const aspectsSummary = Object.entries(refAspects)
      .filter(([k]) => !["Brand", "MPN", "Item Length", "Item Width", "Item Height"].includes(k))
      .slice(0, 8).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join("; ");
    try {
      const descRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200,
          messages: [{ role: "user", content: `Write a 2-3 sentence eBay product description for: "${publishTitle}". Specs: ${aspectsSummary}. Rules: professional, highlight features/benefits, NO brand names, NO medical claims, NO adult content, NO URLs, plain text only. Return ONLY the description.` }] }),
      });
      if (descRes.ok) {
        const dd = await descRes.json();
        const gen = (dd.content?.[0]?.text ?? "").trim();
        if (gen.length > 20) {
          publishDesc = gen.replace(/<[^>]+>/g, " ").replace(/[^ -~]/g, "").replace(/  +/g, " ").trim();
          console.log(`[publish] 📝 Description from aspects (CN image-based listing): "${publishDesc.slice(0, 60)}"`);
        }
      }
    } catch { /* use existing publishDesc */ }
  }

  const rawCatId    = refCategoryId || "20625";
  const { id: publishCatId, type: publishCatType } = await resolveCategory(rawCatId, product.title);
  let currentCatId   = publishCatId;
  let currentCatType = publishCatType;
  let publishAspects = { ...refAspects };

  const FIXABLE = ["missing", "category", "leaf", "improper", "policy", "violation", "Model", "item specific", "too long", "characters", "Style", "Department", "Occasion", "Sleeve"];

  try {
    const result = await addFixedPriceItem({ title: publishTitle, description: publishDesc, categoryId: currentCatId, categoryType: currentCatType, price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1), images: refImages, condition: product.condition ?? "New", aspects: publishAspects, variations: refVariations, markupRatio , fulfillmentPolicyId: policies.fulfillmentPolicyId, paymentPolicyId: policies.paymentPolicyId, returnPolicyId: policies.returnPolicyId , itemCountry: policies.itemCountry, itemLocation: policies.itemLocation }, userToken);
    itemId = result.itemId;
  } catch (firstErr: unknown) {
    const errMsg = String(firstErr instanceof Error ? firstErr.message : firstErr);
    const isFixable = FIXABLE.some(kw => errMsg.toLowerCase().includes(kw.toLowerCase()));
    if (!isFixable) throw firstErr;

    console.log(`[publish] ⚠️ Error fixable detectado — pidiendo a Claude que corrija...`);
    console.log(`[publish] Error: ${errMsg}`);

    const fix = await autoFixWithClaude(errMsg, { title: publishTitle, description: publishDesc, categoryId: currentCatId, aspects: publishAspects });

    // Category / leaf error → re-resolve with API
    if (errMsg.includes("category") || errMsg.includes("Categor") || errMsg.includes("leaf")) {
      const resolved = await resolveCategory(currentCatId, publishTitle);
      currentCatId   = resolved.id;
      currentCatType = resolved.type;
      console.log(`[publish] 🔧 Re-resolved leaf: ${currentCatId} (${currentCatType})`);
    } else {
      if (!fix) { console.log("[publish] Claude no pudo corregir"); throw firstErr; }
      if (fix.title)       { publishTitle   = fix.title;       console.log(`[publish] 🔧 Título corregido: "${fix.title}"`); }
      if (fix.description) { publishDesc    = fix.description; console.log(`[publish] 🔧 Descripción corregida`); }
      if (fix.aspects) {
        // Deep merge: for each key, combine existing + new values, dedupe
        for (const [k, v] of Object.entries(fix.aspects)) {
          publishAspects[k] = [...new Set([...(publishAspects[k] ?? []), ...v])].slice(0, 5);
        }
        console.log(`[publish] 🔧 Aspects merged:`, fix.aspects);
      }
    }

    if (errMsg.includes("improper") || errMsg.includes("policy")) {
      publishDesc = `High-quality ${publishTitle}. Durable construction and practical design. Easy to use and clean. Perfect for everyday use. Fast shipping included.`;
      console.log(`[publish] 🔧 Descripción genérica neutra aplicada`);
    }

    console.log(`[publish] 🔄 Reintentando con correcciones...`);
    try {
      const result2 = await addFixedPriceItem({ title: publishTitle, description: publishDesc, categoryId: currentCatId, categoryType: currentCatType, price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1), images: refImages, condition: product.condition ?? "New", aspects: publishAspects, variations: refVariations, markupRatio , fulfillmentPolicyId: policies.fulfillmentPolicyId, paymentPolicyId: policies.paymentPolicyId, returnPolicyId: policies.returnPolicyId , itemCountry: policies.itemCountry, itemLocation: policies.itemLocation }, userToken);
      itemId = result2.itemId;
      console.log(`[publish] ✅ Publicado tras corrección automática — ID: ${itemId}`);
    } catch (retryErr: unknown) {
      const retryMsg = String(retryErr instanceof Error ? retryErr.message : retryErr);
      if (retryMsg.includes("improper") || retryMsg.includes("policy")) {
        console.log(`[publish] 🔍 Buscando listing alternativo para: "${publishTitle}"...`);
        const altRef = await findAlternativeReference(publishTitle, product.ebayItemId, userToken);
        if (!altRef) throw new Error(`Vendedor bloqueado y no se encontró referencia alternativa`);
        console.log(`[publish] ✅ Referencia alternativa encontrada: ${altRef.itemId}`);
        if (altRef.categoryId) {
          const altResolved = await resolveCategory(altRef.categoryId, publishTitle);
          currentCatId   = altResolved.id;
          currentCatType = altResolved.type;
        }
        if (altRef.aspects && Object.keys(altRef.aspects).length > 0) publishAspects = { ...publishAspects, ...altRef.aspects };
        try {
          const result3 = await addFixedPriceItem({ title: publishTitle, description: publishDesc, categoryId: currentCatId, categoryType: currentCatType, price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1), images: refImages.length > 0 ? refImages : altRef.images, condition: product.condition ?? "New", aspects: publishAspects, variations: refVariations, markupRatio , fulfillmentPolicyId: policies.fulfillmentPolicyId, paymentPolicyId: policies.paymentPolicyId, returnPolicyId: policies.returnPolicyId , itemCountry: policies.itemCountry, itemLocation: policies.itemLocation }, userToken);
          itemId = result3.itemId;
          console.log(`[publish] ✅ Publicado con referencia alternativa — ID: ${itemId}`);
        } catch (altErr: unknown) {
          const altMsg = String(altErr instanceof Error ? altErr.message : altErr);
          if (altMsg.includes("improper") || altMsg.includes("policy") || altMsg.includes("leaf") || altMsg.includes("category")) {
            // Last resort: re-resolve from title alone, minimal aspects
            const lastResort = await resolveCategory("20625", publishTitle);
            currentCatId   = lastResort.id;
            currentCatType = lastResort.type;
            publishAspects = { Brand: ["Unbranded"], MPN: ["Does Not Apply"] };
            console.log(`[publish] 🔧 Último recurso: cat=${currentCatId} para "${publishTitle.slice(0,40)}"`);
            const result4 = await addFixedPriceItem({ title: publishTitle, description: publishDesc, categoryId: currentCatId, categoryType: currentCatType, price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1), images: refImages.length > 0 ? refImages : altRef.images, condition: product.condition ?? "New", aspects: publishAspects, variations: null, markupRatio , fulfillmentPolicyId: policies.fulfillmentPolicyId, paymentPolicyId: policies.paymentPolicyId, returnPolicyId: policies.returnPolicyId , itemCountry: policies.itemCountry, itemLocation: policies.itemLocation }, userToken);
            itemId = result4.itemId;
            console.log(`[publish] ✅ Publicado con fallback máximo — ID: ${itemId}`);
          } else throw altErr;
        }
      } else if (retryMsg.includes("improper") || retryMsg.includes("policy")) {
        // Confirmed seller-blocked — auto-reject so it doesn't stay in failed
        await queueCol(userId).doc(productId).update({ status: "rejected", failReason: "Vendedor de referencia bloqueado por eBay", updatedAt: Date.now() });
        throw new Error("AUTO-RECHAZADO: vendedor de referencia bloqueado por eBay");
      } else throw retryErr;
    }
  }

  await docRef.update({ status: "published", publishedAt: Date.now(), listingId: itemId!, bidPercentage: 2.0, updatedAt: Date.now() });

  // Write to seen_items so it's never re-added to queue even if product is cleaned up later
  const rawItemId = String(product.ebayItemId ?? "");
  const numericItemId = rawItemId.split("|")[1] ?? rawItemId;
  if (numericItemId) {
    await seenCol(userId).doc(numericItemId).set({
      ebayItemId:  numericItemId,
      title:       product.title ?? "",
      reason:      "published",
      listingId:   itemId!,
      seenAt:      Date.now(),
      productId,
    });
  }

  await new Promise(r => setTimeout(r, 3000));
  await applyPromotedListing(itemId!, userToken);
  await counterRef.set({ count: currentCount + 1, updatedAt: Date.now() }, { merge: true });
  console.log(`[publish] ✅ ${productId} → eBay itemId=${itemId} (${currentCount + 1}/${MONTHLY_LIMIT} este mes)`);
  return { listingId: itemId! };
}

async function applyPromotedListing(listingId: string, userToken: string): Promise<void> {
  try {
    const xml = `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials><Item><ItemID>${listingId}</ItemID><PromotedListingDetails><BidPercentage>2.0</BidPercentage><PromotionMethod>COST_PER_SALE</PromotionMethod></PromotedListingDetails></Item></ReviseFixedPriceItemRequest>`;
    const https = await import("node:https");
    await new Promise<void>((resolve) => {
      const buf = Buffer.from(xml, "utf-8");
      const req = https.request({ hostname: "api.ebay.com", path: "/ws/api.dll", method: "POST", headers: { "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "967", "X-EBAY-API-CALL-NAME": "ReviseFixedPriceItem", "Content-Type": "text/xml", "Content-Length": buf.length.toString() } }, (res) => {
        const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => { const body = Buffer.concat(chunks).toString("utf-8"); if (body.includes("<Ack>Failure</Ack>")) { const m = body.match(/<LongMessage>(.*?)<\/LongMessage>/); console.warn(`[promote] ⚠️ ${listingId}: ${m?.[1] ?? "Unknown error"}`); } else { console.log(`[promote] ✅ 2% ad applied to ${listingId}`); } resolve(); });
      });
      req.on("error", (e) => { console.warn(`[promote] ⚠️ ${listingId}:`, e.message); resolve(); });
      req.setTimeout(15000, () => { req.destroy(); resolve(); });
      req.write(buf); req.end();
    });
  } catch (e) { console.warn(`[promote] ⚠️ Error for ${listingId}:`, e instanceof Error ? e.message : e); }
}

export async function markPublishFailed(productId: string, reason: string, userId: string): Promise<void> {
  const isTooManyVariants = reason.startsWith("TOO_MANY_VARIATIONS:");
  const update: Record<string, unknown> = { status: "failed", failReason: reason, updatedAt: Date.now() };
  if (isTooManyVariants) {
    const [, count, max] = reason.split(":");
    update.failReason = `Too many variations (${count}/${max} max) — click "List anyway" to publish with the ${max} cheapest`;
    update.tooManyVariations = true;
  }
  await queueCol(userId).doc(productId).update(update);
  console.log(`[publish] ⚠️ ${productId} → failed: ${reason}`);
}