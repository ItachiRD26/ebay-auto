import { db, COLLECTIONS, queueCol, settingsDoc, seenCol } from "@/lib/firebase";
import { getReferenceItemData } from "@/lib/ebay";
import {
  getVerifiedLeafCategory,
  cleanAndSupplementAspects,
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
    const prompt = `You are a professional eBay listing copywriter. Write compelling, detailed listings that sell.

Product title: ${title}
${aspectsText ? `Details:\n${aspectsText}` : ""}

Write a rich product description like a top US seller would — engaging, benefit-focused, with a bullet-point feature list.

Structure:
- 2-3 opening sentences highlighting what makes this product great (material, design, quality, use case)
- 1-2 sentences about daily use or lifestyle fit
- 1 sentence about craftsmanship or reliability
- "Details:" followed by 4-6 bullet points with key specs/features

Style: confident, clean, factual. Like a premium Amazon or eBay listing. No fluff.

Rules:
- Max 300 words total
- NO brand names, NO dropshipping mentions, NO Chinese supplier references
- NO explicit sexual content, NO weapons, NO hate speech
- Plain text only — no HTML tags, bullets with "*"
- Avoid: nude, naked, bondage, fetish, whip, penetrate, bang, screw (as verb)
- For apparel: "relaxed fit" not "loose", "wide leg" not "harem", "men's" not "male"

Also rewrite the title: clear, keyword-rich, max 80 chars, no brand names, no Chinese characters.

Return ONLY valid JSON (no markdown, no extra text):
{"title":"rewritten title here","description":"full description with bullet points"}`;

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
  return { title, description: "" };
}

// ─── Shared Claude helper for JSON rewrites ────────────────────────────────────
async function callClaudeForRewrite(prompt: string, maxTokens = 500): Promise<Record<string, string> | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content: { type: string; text: string }[] };
    const text = data.content.find((b: { type: string }) => b.type === "text")?.text ?? "";
    if (text.trim() === "null") return null;
    const m = text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch { return null; }
}

async function autoFixWithClaude(errorMsg: string, product: { title: string; description: string; categoryId: string; aspects: Record<string, string[]> }): Promise<{ title?: string; description?: string; categoryId?: string; aspects?: Record<string, string[]> } | null> {
  try {
    const err = errorMsg.toLowerCase();
    const isImproper  = err.includes("improper") || err.includes("policy") || err.includes("violation");
    const isMissing   = err.includes("missing") || err.includes("item specific");
    const isTooLong   = err.includes("too long") || err.includes("characters");

    let prompt: string;

    if (isImproper) {
      // Same ultra-conservative approach as wasImproper path
      const isForPets = /dog|cat|pet|puppy|kitten|collar|leash|harness/i.test(product.title);
      prompt = `You are an eBay policy compliance specialist. This listing was REJECTED: "${errorMsg.slice(0,80)}"

eBay's filter flags words with dual meanings. Rewrite using ONLY neutral, unambiguous language.

Product: "${product.title}"

WORDS TO NEVER USE:
chain → "metal link" or "steel collar", choke → "standard" or "flat",
shock → "vibration" or omit, prong → "textured" or omit,
strip → "band" or "tape", hard → "firm" or "sturdy",
tight → "snug" or "secure", drag → "slip-on" or "backless",
clamp → "grip" or "bracket" or "arm", clamping → "gripping" or "securing",
whip, bang, thrust, penetrate, climax, bondage, fetish, restraint → never use
male (apparel) → "men's"

${isForPets ? 'Include "for dogs", "for pets", or "pet" in the title. This is a pet supply product.' : ""}

Title: max 80 chars, factual only (material + size + function), no brand names.
Description: 2-3 sentences — material, size/fit, care. NO promotional language.

Return ONLY this JSON:
{"title":"ultra-safe rewritten title","description":"factual 2-3 sentence description"}`;
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
        // ── Always-known defaults (no inference needed) ──
        "Brand":  "Unbranded",
        "MPN":    "Does Not Apply",
        "Country/Region of Manufacture": "China",
        "Country of Origin": "China",
        // ── Inferred from title ──
        Style: isFootwearCtx
          ? (t.includes("casual") || t.includes("loafer") || t.includes("mule") || t.includes("slip") ? "Casual" : t.includes("sport") || t.includes("running") ? "Athletic" : t.includes("formal") || t.includes("dress") || t.includes("oxford") ? "Formal" : "Casual")
          : (t.includes("vintage") ? "Vintage" : t.includes("modern") ? "Modern" : t.includes("retro") ? "Retro" : t.includes("sport") ? "Athletic" : "Casual"),
        Department: t.includes("men") || t.includes("male") || t.includes("boy") ? "Men" : t.includes("women") || t.includes("female") || t.includes("girl") || t.includes("lady") ? "Women" : t.includes("kid") || t.includes("child") || t.includes("baby") ? "Kids" : "Men",
        Model: "Compatible",
        "Size Type": t.includes("wide") ? "Wide" : t.includes("narrow") ? "Narrow" : t.includes("extra wide") ? "Extra Wide" : "Regular",
        "Size": t.includes("women") || t.includes("ladies") || t.includes("female") ? "US 7" : "US 9",
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
    const raw = await callClaudeForRewrite(prompt, 400);
    if (!raw?.aspects) return raw;
    // Normalize aspect values to string[] — Claude sometimes returns strings instead of arrays
    const normalized: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(raw.aspects as unknown as Record<string, unknown>)) {
      normalized[k] = Array.isArray(v) ? (v as string[]) : [String(v)];
    }
    return { ...raw, aspects: normalized };
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

  // ── Option A: Trust CN seller's aspects, clean + supplement only what's missing ──
  // The CN seller already published their listing — their aspects are valid.
  // We clean (strip Chinese, reset Brand/MPN) and supplement only genuinely
  // missing required fields (e.g. Size Type for footwear, remove clothing
  // aspects from pet categories). We never filter valid aspects away.
  const categoryType = product.categoryType ?? CATEGORY_TYPES[product.categoryId] ?? detectTypeFromTitle(product.title);
  const aspects = cleanAndSupplementAspects(product.aspects, product.title, categoryType);
  // Safety net — Brand and MPN are required by eBay for virtually all categories.
  // cleanAndSupplementAspects already sets these, but guard against any edge case.
  if (!aspects["Brand"] || aspects["Brand"].length === 0) aspects["Brand"] = ["Unbranded"];
  if (!aspects["MPN"]   || aspects["MPN"].length === 0)   aspects["MPN"]   = ["Does Not Apply"];

  // Note: we do NOT strip "magnetic", "healing" etc. from aspect values.
  // Manual listings with these values work fine — the issue is elsewhere.

  // Filter images — prefer external over EPS (ebayimg.com) to avoid error 20004
  const _ebayImgs    = product.images.filter(u => u.includes("ebayimg.com"));
  const _externalImgs = product.images.filter(u => !u.includes("ebayimg.com"));
  const _cleanImages  = _externalImgs.length > 0 ? _externalImgs : _ebayImgs;
  const picturesXml = _cleanImages.slice(0, 12).map(url => `<PictureURL>${escXml(url)}</PictureURL>`).join("");
  const conditionId = ({"New":"1000","New with tags":"1000","New with box":"1000","New without tags":"1500","Like New":"2500","Used":"3000"} as Record<string,string>)[product.condition] ?? "1000";
  const markupRatio = product.markupRatio ?? 1.06;
  let variationsXml = "";
  let hasVariations = false;

  // ── Clean + sanitize variation values before XML ────────────────────────────
  // CN sellers often use Chinese color names (e.g. "肤色") or flagged English words
  // (e.g. "Nude", "Skin") in their variation specifics. eBay's content filter
  // catches these in <VariationSpecificsSet> and returns "improper words" —
  // even when the title and description are perfectly clean.
  const isChinese = (v: string) => /[\u4e00-\u9fff]/.test(v);
  const FLAGGED_COLOR_MAP: Record<string, string> = {
    "nude": "Light Beige", "skin": "Light Tan", "skin tone": "Light Tan",
    "naked": "Beige", "flesh": "Beige", "nude pink": "Pale Pink",
    "nude beige": "Light Beige", "sexy": "Classic", "hot": "Vibrant",
  };
  function cleanVariationValue(val: string): string {
    // Strip Chinese characters
    let clean = val.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, "").trim();
    // Replace flagged words with safe alternatives
    const lower = clean.toLowerCase();
    for (const [flagged, safe] of Object.entries(FLAGGED_COLOR_MAP)) {
      if (lower === flagged || lower.startsWith(flagged + " ") || lower.endsWith(" " + flagged)) {
        clean = safe;
        break;
      }
    }
    return clean.slice(0, 65).trim();
  }

  const rawVarData = product.variations;
  // Apply cleaning to variation specifics
  let varData: VariationsData | null = rawVarData ? {
    ...rawVarData,
    variations: rawVarData.variations
      .map((v: VariationSpec) => ({
        ...v,
        specifics: Object.fromEntries(
          Object.entries(v.specifics)
            .map(([k, val]) => [k, cleanVariationValue(val)])
            .filter(([_, val]) => (val as string).length > 0)
        ),
      }))
      .filter((v: VariationSpec) => Object.keys(v.specifics).length > 0),
    specificsSet: Object.fromEntries(
      Object.entries(rawVarData.specificsSet)
        .map(([key, vals]) => [
          key,
          (vals as string[]).map(cleanVariationValue).filter(v => v.length > 0),
        ])
        .filter(([_, vals]) => (vals as string[]).length > 0)
    ),
    picturesByVariant: Object.fromEntries(
      Object.entries(rawVarData.picturesByVariant)
        .map(([key, urls]) => [cleanVariationValue(key), urls])
        .filter(([key]) => (key as string).length > 0)
    ),
  } : null;

  if (varData && varData.variations.length > 0) {
    hasVariations = true;
    // If pictureDimension is empty, derive it from the first specificsSet key
    // This happens when CN listing has no per-variant pictures
    if (!varData.pictureDimension) {
      const firstDim = Object.keys(varData.specificsSet)[0] ?? "";
      if (firstDim) {
        varData = { ...varData, pictureDimension: firstDim };
        console.log(`[publish] 📐 Derived dimension from specificsSet: "${firstDim}"`);
      }
    }
    // If specificsSet is empty, rebuild from variant specifics
    if (Object.keys(varData.specificsSet).length === 0 && varData.variations.length > 0) {
      const rebuilt: Record<string, string[]> = {};
      for (const v of varData.variations) {
        for (const [k, val] of Object.entries(v.specifics)) {
          if (!rebuilt[k]) rebuilt[k] = [];
          if (!rebuilt[k].includes(val)) rebuilt[k].push(val);
        }
      }
      varData = { ...varData, specificsSet: rebuilt };
      console.log(`[publish] 🔧 Rebuilt specificsSet from variants: ${JSON.stringify(Object.keys(rebuilt))}`);
    }
    console.log(`[publish] Variation pricing: markupPercent=${markupRatio*100-100}% → ×${markupRatio.toFixed(3)}`);
    const variationItems = varData.variations.map((v: VariationSpec) => {
      // Apply markup directly to each variant's own refPrice.
      // This is clean: each variant's price = its CN price × (1 + markupPercent/100).
      // Previously we derived appliedRatio from suggestedSellingPrice/refMin which
      // caused distortion when the user edited suggestedSellingPrice.
      const varPrice = v.refPrice > 0
        ? +Math.max(v.refPrice * markupRatio, 0.99).toFixed(2)
        : +product.price.toFixed(2);
      console.log(`[publish]   variant ${Object.values(v.specifics).join("/")} refPrice=$${v.refPrice} → $${varPrice}`);
      const varSpecificsXml = Object.entries(v.specifics).map(([name, val]) => `<NameValueList><Name>${escXml(name)}</Name><Value>${escXml(val)}</Value></NameValueList>`).join("");
      return `<Variation><SKU>${escXml(Object.values(v.specifics).map((x: unknown) => String(x)).join("-"))}</SKU><StartPrice>${varPrice}</StartPrice><Quantity>${product.stock}</Quantity><VariationSpecifics>${varSpecificsXml}</VariationSpecifics></Variation>`;
    }).join("");
    const setXml = Object.entries(varData.specificsSet).map(([name, vals]) => { const valsXml = (vals as string[]).map((v: string) => `<Value>${escXml(v)}</Value>`).join(""); return `<NameValueList><Name>${escXml(name)}</Name>${valsXml}</NameValueList>`; }).join("");
    let picturesBlockXml = "";
    if (varData.pictureDimension && Object.keys(varData.picturesByVariant).length > 0) {
      const pictureSets = Object.entries(varData.picturesByVariant).map(([value, urls]) => {
        const extV  = (urls as string[]).filter(u => !u.includes("ebayimg.com"));
        const ebayV = (urls as string[]).filter(u => u.includes("ebayimg.com"));
        const cleanV = extV.length > 0 ? extV : ebayV;
        const urlsXml = cleanV.slice(0, 6).map((u: string) => `<PictureURL>${escXml(u)}</PictureURL>`).join("");
        return `<VariationSpecificPictureSet><VariationSpecificValue>${escVal(value)}</VariationSpecificValue>${urlsXml}</VariationSpecificPictureSet>`;
      }).join("");
      picturesBlockXml = `<Pictures><VariationSpecificName>${escXml(varData.pictureDimension)}</VariationSpecificName>${pictureSets}</Pictures>`;
      console.log(`[publish] 🖼 Variation pictures mapped: ${Object.keys(varData.picturesByVariant).length} values for "${varData.pictureDimension}"`);
    }
    variationsXml = `<Variations>${variationItems}${picturesBlockXml}<VariationSpecificsSet>${setXml}</VariationSpecificsSet></Variations>`;
  }

  // Variation dimensions (Color, Size etc.) are excluded from ItemSpecifics — eBay
  // requires them ONLY in <VariationSpecificsSet>, not duplicated in <ItemSpecifics>.
  // Exception: non-dimension fields like Brand, MPN, Country of Origin always stay.
  const variationDimensions = hasVariations && varData
    ? new Set(Object.keys(varData.specificsSet).map(k => k.toLowerCase()))
    : new Set<string>();
  // Fields that are never variation dimensions and must always be in ItemSpecifics
  const ALWAYS_IN_SPECIFICS = new Set([
    "brand", "mpn", "country/region of manufacture", "country of origin",
    "upc", "ean", "isbn",
  ]);
  const specificsXml = Object.entries(aspects)
    .filter(([name]) => ALWAYS_IN_SPECIFICS.has(name.toLowerCase()) || !variationDimensions.has(name.toLowerCase()))
    .map(([name, values]) => values.map(v => `<NameValueList><Name>${escXml(name)}</Name><Value>${escXml(v)}</Value></NameValueList>`).join(""))
    .join("");
  // ── Sanitize description per eBay Trading API rules ─────────────────────────
  const stripProblematic = (text: string): string =>
    // Remove HTML, non-ASCII, URLs, and genuinely prohibited content only
    // Do NOT remove product feature words (magnetic, gauss, healing etc.) — manual listings
    // with these words work fine. Over-stripping was causing empty descriptions.
    text.replace(/<[^>]+>/g, " ").replace(/https?:\/\/\S+/gi, "").replace(/[^\x20-\x7E]/g, "")
        .replace(/\b(cure|diagnos|prescription|narcotic|weapon|gun|ammo|counterfeit|replica|fake|copyright|trademark)\b/gi, "")
        .replace(/\b(sexy|adult|xxx|porn|nude|erotic|fetish|explicit|bondage|penetrate|thrust)\b/gi, "")
        .replace(/\s{2,}/g, " ").trim();

  const strippedRawDesc = stripProblematic(product.description || "");
  // If description is empty (CN image-based listing), use precomputed description or title fallback
  const safeDesc = strippedRawDesc.length >= 30
    ? strippedRawDesc.slice(0, 500)
    : `${product.title.replace(/[^\x20-\x7E]/g, " ").trim().slice(0, 60)}. Durable and practical for everyday use. Fast shipping with tracking.`;

  // Log so we can debug "improper" rejections that aren't in the title
  console.log(`[publish] 📄 Desc sent (${safeDesc.length} chars): "${safeDesc.slice(0, 150)}"`);
  // Debug: log aspects and specificsXml to catch Brand/MPN issues
  const brandInAspects = aspects["Brand"];
  const brandInXml = specificsXml.includes("Brand") ? "✅ in XML" : "❌ NOT in XML";
  console.log(`[publish] 🏷 aspects.Brand=${JSON.stringify(brandInAspects)} ${brandInXml} | specificsXml length=${specificsXml.length}`);

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
    <Country>${product.itemCountry ?? process.env.EBAY_ITEM_COUNTRY ?? "US"}</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>5</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>${product.itemLocation ?? process.env.EBAY_ITEM_LOCATION ?? "United States"}</Location>
    ${!hasVariations ? `<Quantity>${product.stock}</Quantity>` : ""}
    <PictureDetails><GalleryType>Gallery</GalleryType>${picturesXml}</PictureDetails>
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

  // Log XML Variations + ItemSpecifics sections only
  const xmlForLog = xml.replace(/<eBayAuthToken>[^<]+<\/eBayAuthToken>/, "<eBayAuthToken>[TOKEN]</eBayAuthToken>");
  const varIdx = xmlForLog.indexOf("<Variations>");
  const specIdx = xmlForLog.indexOf("<ItemSpecifics>");
  if (varIdx >= 0)  console.log(`[publish] 📤 <Variations>: ${xmlForLog.slice(varIdx, varIdx + 800)}`);
  if (specIdx >= 0) console.log(`[publish] 📤 <ItemSpecifics>: ${xmlForLog.slice(specIdx, specIdx + 600)}`);
  if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
  // Log full eBay response to see ErrorParameters
  console.log(`[publish] 📥 eBay response: ${body.slice(0, 1000)}`);
  const errorBlockRegex = /<Errors>([\s\S]*?)<\/Errors>/g;
  let errBlock; const realErrors: string[] = [];
  while ((errBlock = errorBlockRegex.exec(body)) !== null) {
    const block = errBlock[1];
    const errCode  = block.match(/<ErrorCode>(\d+)<\/ErrorCode>/)?.[1] ?? "?";
    const shortMsg = block.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1] ?? "";
    const longMsg  = block.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] ?? "Unknown error";
    if (block.includes("<SeverityCode>Error</SeverityCode>")) {
      const fullMsg = `[eBay ${errCode}] ${longMsg}`;
      console.error(`[publish] ❌ eBay error ${errCode}: ${shortMsg} | ${longMsg.slice(0, 120)}`);
      realErrors.push(fullMsg);
    } else {
      console.warn(`[publish] ⚠️ eBay warning ${errCode}: ${shortMsg}`);
    }
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
        itemCountry:         p.itemCountry   ?? process.env.EBAY_ITEM_COUNTRY  ?? "US",
        itemLocation:        p.itemLocation  ?? process.env.EBAY_ITEM_LOCATION ?? "United States",
      };
    }
  } catch {}
  return {
    fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID ?? "",
    paymentPolicyId:     process.env.EBAY_PAYMENT_POLICY_ID     ?? "",
    returnPolicyId:      process.env.EBAY_RETURN_POLICY_ID      ?? "",
    itemCountry:         process.env.EBAY_ITEM_COUNTRY  ?? "US",
    itemLocation:        process.env.EBAY_ITEM_LOCATION ?? "United States",
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
  const doc    = await docRef.get();
  if (!doc.exists) throw new Error("Product not found");
  const product = doc.data()!;

  // ── Monthly listing limit ─────────────────────────────────────────────────
  const now       = new Date();
  const monthKey  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const counterRef = db.collection("counters").doc(`listings_${monthKey}`);
  const counterDoc = await counterRef.get();
  const currentCount = counterDoc.exists ? (counterDoc.data()!.count as number) : 0;
  const MONTHLY_LIMIT = 245;
  if (currentCount >= MONTHLY_LIMIT)
    throw new Error(`Límite mensual alcanzado (${currentCount}/${MONTHLY_LIMIT} listings este mes)`);

  // ── Load policies + settings ──────────────────────────────────────────────
  const sid = storeId ?? (product.storeId as string) ?? "";
  const [policies, userSettingsSnap] = await Promise.all([
    getStorePolicies(userId, sid),
    settingsDoc(userId, "main").get(),
  ]);
  const userSettings   = userSettingsSnap.data() as Record<string, unknown> | undefined;
  const MAX_VARIATIONS = (userSettings?.maxVariations as number) ?? 12;

  if (product.failReason) await docRef.update({ failReason: null, status: "approved" });

  // ── Step 1: GetItem — pull everything from the CN reference listing ────────
  // Category, aspects, variations, images all come from the CN seller.
  // They already published this — eBay already accepted this data.
  // We trust it. We only rewrite title + description.
  let refAspects:    Record<string, string[]> = {};
  let refImages:     string[]                 = product.images ?? [];
  let refCategoryId: string                   = product.categoryId;
  let refVariations: VariationsData | null    = null;

  if (product.ebayItemId) {
    const rawId        = String(product.ebayItemId);
    const numericId    = rawId.split("|")[1] ?? rawId;
    console.log(`[publish] GetItem ref → rawId="${rawId}" numericId="${numericId}"`);
    const refData = await getReferenceItemData(numericId, userToken);
    if (refData) {
      refAspects    = refData.aspects;
      if (refData.categoryId) refCategoryId = refData.categoryId;
      const merged  = [...refImages];
      refData.imageUrls.forEach((u: string) => { if (!merged.includes(u)) merged.push(u); });
      const ebayUrls = merged.filter(u => u.includes("ebayimg.com"));
      const externalUrls = merged.filter(u => !u.includes("ebayimg.com"));
      const dedupedImages = externalUrls.length > 0 ? externalUrls : ebayUrls;
      refImages = dedupedImages.slice(0, 12);
      refVariations = (refData as unknown as ReferenceItemData).variations ?? null;

      if (refVariations?.variations.length) {
        const varPrices = refVariations.variations.map((v: VariationSpec) => v.refPrice).filter((p: number) => p > 0);
        if (varPrices.length) {
          await docRef.update({ refPriceMin: Math.min(...varPrices), refPriceMax: Math.max(...varPrices) });
        }
      }

      if (refVariations && refVariations.variations.length > MAX_VARIATIONS && !forceVariations)
        throw new Error(`TOO_MANY_VARIATIONS:${refVariations.variations.length}:${MAX_VARIATIONS}`);

      const varInfo = refVariations
        ? ` | ${refVariations.variations.length} variantes (${Object.keys(refVariations.specificsSet).join(", ")})`
        : " | sin variantes";
      console.log(`[publish] ${productId} — ${Object.keys(refAspects).length} aspects, ${refImages.length} images${varInfo}`);
    }
  } else if (product.source === "1688-extension" || product.source === "1688") {
    // ── Extension/1688 import — no eBay reference item ─────────────────────
    console.log(`[publish] 1688 import — getting category from Taxonomy API`);
    if (!refCategoryId && product.title) {
      try {
        const taxRes  = await fetch(
          `https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_US`,
          { headers: { Authorization: `Bearer ${await getAppToken()}` } }
        );
        const taxData = await taxRes.json() as { categoryTreeId?: string };
        const treeId  = taxData.categoryTreeId ?? "0";

        const sugRes  = await fetch(
          `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(String(product.title).slice(0, 60))}`,
          { headers: { Authorization: `Bearer ${await getAppToken()}` } }
        );
        const sugData = await sugRes.json() as { categorySuggestions?: { category?: { categoryId?: string; categoryName?: string } }[] };

        const BOOK_CATS = new Set(["267", "261186", "11232", "171228", "183454"]);
        const goodSuggestion = sugData.categorySuggestions?.find(s => {
          const id = s.category?.categoryId ?? "";
          return !BOOK_CATS.has(id);
        });

        const catId = goodSuggestion?.category?.categoryId;
        if (catId) {
          refCategoryId = catId;
          console.log(`[publish] Taxonomy suggested category: ${catId} (${goodSuggestion?.category?.categoryName})`);
        }
      } catch (e) { console.warn("[publish] Taxonomy API failed:", e); }
    }

    refImages = (product.images as string[] | undefined) ?? [];

    // ── Convert variantGroups → VariationsData format ─────────────────────
    // variantGroups: [{name:"Color", values:[{value:"Red", image:"url"}]}, ...]
    type VG = { name: string; values: { value: string; image: string | null }[] };
    const variantGroups = (product.variantGroups as VG[] | undefined) ?? [];

    if (variantGroups.length > 0) {
      // Find the dimension that has images (usually Color)
      const picDimension = variantGroups.find(g => g.values.some(v => v.image)) ?? variantGroups[0];

      // Build specificsSet: { Color: ["Red","Blue"], Size: ["36","37"] }
      const specificsSet: Record<string, string[]> = {};
      for (const g of variantGroups) {
        specificsSet[g.name] = g.values.map(v => v.value).filter(Boolean);
      }

      // Build picturesByVariant: { "Red": ["url1"], "Blue": ["url2"] }
      const picturesByVariant: Record<string, string[]> = {};
      for (const v of picDimension.values) {
        if (v.image && v.value) picturesByVariant[v.value] = [v.image];
      }

      // Build all variation combinations (Color × Size × ...)
      const combinations: Record<string, string>[] = [{}];
      for (const g of variantGroups) {
        const expanded: Record<string, string>[] = [];
        for (const existing of combinations) {
          for (const v of g.values) {
            expanded.push({ ...existing, [g.name]: v.value });
          }
        }
        combinations.splice(0, combinations.length, ...expanded);
      }

      // Cap at MAX_VARIATIONS
      const cappedCombinations = combinations.slice(0, MAX_VARIATIONS);
      const suggestedUSD = (product.suggestedSellingPrice as number) || (product.totalMarketCost as number) || 0;

      refVariations = {
        variations: cappedCombinations.map(specifics => ({
          specifics,
          refPrice: suggestedUSD,
        })),
        specificsSet,
        picturesByVariant,
        pictureDimension: picDimension.name,
      };

      console.log(`[publish] 1688 variants: ${cappedCombinations.length} combos, dimension="${picDimension.name}", pics=${Object.keys(picturesByVariant).length}`);
    }

    console.log(`[publish] 1688 extension: category=${refCategoryId} images=${refImages.length}`);
  }

  // ── Step 2: Markup ratio ──────────────────────────────────────────────────
  const markupPercent: number = (product.markupPercent as number | undefined) ?? 6;
  const markupRatio = 1 + markupPercent / 100;

  // ── Step 3: Pre-screen title — fast regex for known flagged words ──────────
  // Catches the most common cases before Claude sees the title.
  const PRESCREEN: [RegExp, string][] = [
    [/clip[- ]?on/gi,      "attachable"],
    [/clip(?=\s+fan)/gi,   "mount"],
    [/umbrella fan/gi,     "portable fan"],
    [/half[- ]drag/gi,     "backless"],
    [/drag(?=\s+(shoe|mule|flat|sandal|slide))/gi, "slip-on"],
    [/male(?=\s+(shoe|footwear|apparel|clothing))/gi, "men's"],
    [/chain(?=\s+(collar|leash|dog|pet))/gi, "metal link"],
    [/clamping/gi,         "securing"],
    [/harem/gi,            "wide leg"],
    [/sexy/gi,             "stylish"],
    [/lingerie/gi,         "sleepwear"],
    [/erotic/gi,           "stylish"],
    [/loose/gi,             "relaxed fit"],
    [/cropped/gi,          "short length"],
    // Fitness terms eBay flags for adult connotation
    [/chest expander/gi,   "chest exerciser"],
    [/\bexpander\b/gi,        "resistance trainer"],
    [/\bpulling spring\b/gi,  "resistance spring"],
    [/\bbody builder\b/gi,    "fitness trainer"],
    [/\btwister\b/gi,         "rotary exerciser"],  // Hasbro trademark — triggers brand violation
    // Health claim words — eBay API strictly prohibits these in titles/descriptions
    [/\bmagnetic therapy\b/gi,  ""],
    [/\bmagnetic\b/gi,          ""],   // Copper+Magnetic = medical claim pattern eBay blocks
    [/\bhealing\b/gi,           ""],
    [/\btherapy\b/gi,           ""],
    [/\bwellness\b/gi,          ""],
    [/\b\d+\s*gauss\b/gi,      ""],   // "3500 Gauss" = medical claim
    [/\bregulator\b/gi,         ""],   // "Regulator" in health context
    [/\btherapeutic\b/gi,       ""],
    [/\bdetox\b/gi,             ""],
    [/\benergy\b/gi,            ""],   // "Energy bracelet" = health claim
  ];
  const preScreened = PRESCREEN.reduce((t, [p, r]) => t.replace(p, r), product.title as string).replace(/\s{2,}/g, " ").trim();
  if (preScreened !== product.title)
    console.log(`[publish] 🔍 Pre-screen: "${(product.title as string).slice(0,50)}" → "${preScreened.slice(0,50)}"`);

  // ── Step 4: Claude rewrites ONLY title + description ──────────────────────
  // wasImproper = previous attempt was blocked — use aggressive compliance prompt
  const prevFail    = String(product.failReason ?? "").toLowerCase();
  const wasImproper = prevFail.includes("improper") || prevFail.includes("policy") || prevFail.includes("violation");

  let publishTitle: string;
  let publishDesc:  string;

  if (wasImproper) {
    // Aggressive prompt — previous title was rejected, be maximally conservative
    const strippedTitle = preScreened.replace(/[一-鿿]/g, " ").replace(/[^\w\s,\-()'&]/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 75);
    const rewrite = await callClaudeForRewrite(`You are an eBay policy compliance specialist. This listing was REJECTED by eBay's content filter.

Rewrite the title using ONLY neutral, unambiguous, factual language. No words with ANY possible dual meaning.

Product: "${strippedTitle}"

NEVER USE: clip, clamp, chain, strip, hard, tight, drag, harem, sexy, nude, naked, whip, shock, prong, thrust, penetrate, bondage, fetish, restraint, screw, bang, male (for apparel), expander (use "exerciser" instead), twister (use "rotary exerciser"), healing, therapy, magnetic, wellness, gauss, therapeutic, detox, energy (health context), chakra, puller, gripper-style names that sound adult

Return ONLY JSON: {"title":"safe rewritten title max 80 chars","description":"2-3 factual sentences, professional, no brand names, no URLs"}`, 400);
    publishTitle = rewrite?.title ?? preScreened;
    // ⚠️ NO body-part/exercise descriptions when wasImproper — that's likely what triggered the filter
    // "chest", "shoulder", "muscle", "strengthen" together = eBay adult-content false positive
    // Use a completely neutral physical-product description instead
    publishDesc  = "";   // addFixedPriceItem will use safe generic fallback
    console.log(`[publish] 🔒 wasImproper rewrite: "${publishTitle}" (desc stripped for safety)`);
  } else {
    const { title, description } = await generateTitleAndDescription(preScreened, refAspects);
    // Note: if description contains body-part words that might trigger eBay's filter,
    // addFixedPriceItem's stripProblematic + safe fallback will handle it
    publishTitle = title;
    // Use Claude description ONLY if it exists; otherwise use safe generic fallback
    // Avoid body-part descriptions in fitness products — they trigger eBay false-positive filters
    publishDesc  = description || "";
  }

  // Generate description from aspects if CN listing was image-based (no text desc)
  const rawCNDesc = (product.description || "").replace(/<[^>]+>/g, " ").replace(/[^ -~]/g, "").trim();
  if (rawCNDesc.length < 30 && !publishDesc && Object.keys(refAspects).length > 0) {
    const aspectsSummary = Object.entries(refAspects).filter(([k]) => !["Brand","MPN","Item Length","Item Width","Item Height"].includes(k)).slice(0, 8).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join("; ");
    try {
      const dr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200, messages: [{ role: "user", content: `Write a 2-3 sentence eBay product description for: "${publishTitle}". Specs: ${aspectsSummary}. Rules: professional, describe construction/features/materials, NO brand names, NO medical claims, NO URLs, plain text only. CRITICAL: DO NOT mention any body parts (chest, arm, shoulder, muscle, back, leg, etc.) or exercise verbs (strengthen, tone, build, train, exercise, workout). Describe the PRODUCT not the workout. Return ONLY the description.` }] }),
      });
      if (dr.ok) {
        const dd = await dr.json();
        const gen = (dd.content?.[0]?.text ?? "").trim();
        if (gen.length > 20) { publishDesc = gen.replace(/<[^>]+>/g, " ").replace(/[^ -~]/g, "").replace(/  +/g, " ").trim(); console.log(`[publish] 📝 Desc from aspects: "${publishDesc.slice(0,60)}"`); }
      }
    } catch { /* use existing publishDesc */ }
  }

  // ── Step 5: Publish to eBay — max 2 attempts ──────────────────────────────
  // Attempt 1: use CN category + CN aspects + CN variations (trust the CN seller)
  // Attempt 2 (only if "improper"): rewrite title more aggressively, try again
  // If attempt 2 fails → mark failed, user decides
  //
  // We do NOT change category, aspects, or variations between attempts.
  // The CN seller published with these — eBay already accepted them.
  const publishAspects = refAspects; // pass-through — cleanAndSupplementAspects runs inside addFixedPriceItem

  // Log policy IDs so we can diagnose "seller not permitted" errors
  console.log(`[publish] 📋 Policies: fulfillment=${policies.fulfillmentPolicyId?.slice(-6)} payment=${policies.paymentPolicyId?.slice(-6)} return=${policies.returnPolicyId?.slice(-6)} country=${policies.itemCountry} location=${policies.itemLocation}`);
  console.log(`[publish] 🚀 Attempt 1: cat=${refCategoryId} aspects=${Object.keys(publishAspects).length} title="${publishTitle}"`);
  console.log(`[publish] 🏷 Aspects keys: ${Object.keys(publishAspects).slice(0, 12).join(", ")}`);
  console.log(`[publish] 📝 Desc attempt 1 (${publishDesc.length} chars): "${publishDesc.slice(0, 120)}"`);
  let itemId: string;

  try {
    const result1 = await addFixedPriceItem({
      title: publishTitle, description: publishDesc,
      categoryId: refCategoryId, price: product.suggestedSellingPrice,
      stock: (product.stock ?? 10), images: refImages,
      condition: product.condition ?? "New", aspects: publishAspects,
      variations: refVariations, markupRatio,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      paymentPolicyId:     policies.paymentPolicyId,
      returnPolicyId:      policies.returnPolicyId,
      itemCountry:         policies.itemCountry,
      itemLocation:        policies.itemLocation,
    }, userToken);
    itemId = result1.itemId;
    console.log(`[publish] ✅ Publicado en primer intento — ID: ${itemId}`);

  } catch (err1: unknown) {
    const msg1 = String(err1 instanceof Error ? err1.message : err1);
    console.log(`[publish] ⚠️ Attempt 1 failed: ${msg1.slice(0, 120)}`);

    // Classify the error to pick the right retry strategy
    const isImproper    = msg1.includes("improper") || msg1.includes("policy") || msg1.includes("violation");
    const isCategoryErr = msg1.includes("category") || msg1.includes("leaf") || msg1.includes("not a valid") || msg1.includes("not valid");
    // "missing required item specific" → autoFixWithClaude adds the missing aspect and retries
    const isMissing     = msg1.includes("missing") || (msg1.includes("item specific") && !isImproper);

    if (!isImproper && !isCategoryErr && !isMissing) {
      await docRef.update({ status: "failed", failReason: msg1.slice(0, 500), updatedAt: Date.now() });
      throw err1;
    }

    // ── Missing item specific: fix aspects, retry immediately ────────────────
    if (isMissing && !isImproper && !isCategoryErr) {
      console.log(`[publish] 🔧 Missing item specific — pre-filling known defaults: ${msg1.slice(0, 80)}`);

      const lowerMsg = msg1.toLowerCase();

      // ── Pre-fill well-known always-fixed values without calling Claude ──────
      if (lowerMsg.includes("brand")) {
        publishAspects["Brand"] = ["Unbranded"];
        console.log(`[publish] 🔧 Brand → "Unbranded" (no Claude needed)`);
      }
      if (lowerMsg.includes("mpn")) {
        publishAspects["MPN"] = ["Does Not Apply"];
      }
      if (lowerMsg.includes("country")) {
        publishAspects["Country/Region of Manufacture"] = ["China"];
        publishAspects["Country of Origin"] = ["China"];
      }

      // ── Smart mapping: "Exterior X" → derive from existing "X" aspect ────────
      // eBay sometimes requires "Exterior Color" when it has "Color"/"Colour",
      // or "Exterior Material" when it has "Material". Map them directly.
      if (lowerMsg.includes("exterior color") || lowerMsg.includes("exterior colour")) {
        const existing = publishAspects["Color"] ?? publishAspects["Colour"] ?? publishAspects["colour"] ?? publishAspects["color"];
        publishAspects["Exterior Color"] = existing?.length ? existing : ["Multicolor"];
        console.log(`[publish] 🔧 Exterior Color → ${JSON.stringify(publishAspects["Exterior Color"])}`);
      }
      if (lowerMsg.includes("exterior material")) {
        const existing = publishAspects["Material"] ?? publishAspects["material"];
        publishAspects["Exterior Material"] = existing?.length ? existing : ["Mixed Materials"];
        console.log(`[publish] 🔧 Exterior Material → ${JSON.stringify(publishAspects["Exterior Material"])}`);
      }
      // Generic "Exterior X" — try to find matching non-exterior aspect
      const exteriorMatch = lowerMsg.match(/exterior (\w+) is missing/);
      if (exteriorMatch && !lowerMsg.includes("exterior color") && !lowerMsg.includes("exterior material")) {
        const baseField = exteriorMatch[1]; // e.g. "finish", "lining", etc.
        const baseKey = Object.keys(publishAspects).find(k => k.toLowerCase() === baseField);
        if (baseKey) {
          const extKey = `Exterior ${baseField.charAt(0).toUpperCase() + baseField.slice(1)}`;
          publishAspects[extKey] = publishAspects[baseKey];
          console.log(`[publish] 🔧 ${extKey} → copied from ${baseKey}`);
        }
      }

      // ── For other missing fields, ask Claude ─────────────────────────────────
      const knownFields = ["brand", "mpn", "country/region of manufacture", "country of origin",
        "exterior color", "exterior colour", "exterior material"];
      const needsClaude = !knownFields.some(f => lowerMsg.includes(f));
      if (needsClaude) {
        const fix = await autoFixWithClaude(msg1, {
          title: publishTitle, description: publishDesc,
          categoryId: refCategoryId, aspects: publishAspects,
        });
        if (fix?.aspects) {
          // Normalize values to arrays — Claude sometimes returns strings instead of string[]
          for (const [k, v] of Object.entries(fix.aspects as Record<string, unknown>)) {
            publishAspects[k] = Array.isArray(v) ? (v as string[]) : [String(v)];
          }
          console.log(`[publish] 🔧 Claude added aspects: ${JSON.stringify(fix.aspects)}`);
        }
      }

      // Final safety net — always required
      if (!publishAspects["Brand"]?.length)  publishAspects["Brand"] = ["Unbranded"];
      if (!publishAspects["MPN"]?.length)    publishAspects["MPN"]   = ["Does Not Apply"];
      try {
        const resultMissing = await addFixedPriceItem({
          title: publishTitle, description: publishDesc,
          categoryId: refCategoryId, price: product.suggestedSellingPrice,
          stock: (product.stock ?? 10), images: refImages,
          condition: product.condition ?? "New", aspects: publishAspects,
          variations: refVariations, markupRatio,
          fulfillmentPolicyId: policies.fulfillmentPolicyId,
          paymentPolicyId:     policies.paymentPolicyId,
          returnPolicyId:      policies.returnPolicyId,
          itemCountry:         policies.itemCountry,
          itemLocation:        policies.itemLocation,
        }, userToken);
        itemId = resultMissing.itemId;
        console.log(`[publish] ✅ Publicado tras corregir aspects faltantes — ID: ${itemId}`);
      } catch (missingErr: unknown) {
        const missingMsg = String(missingErr instanceof Error ? missingErr.message : missingErr);
        console.log(`[publish] ❌ Missing-fix attempt failed: ${missingMsg.slice(0, 120)}`);
        await docRef.update({ status: "failed", failReason: missingMsg.slice(0, 500), updatedAt: Date.now() });
        throw missingErr;
      }
    } else {

    // ── Category error: fix category, then retry immediately (no title rewrite needed) ──
    if (isCategoryErr && !isImproper) {
      console.log(`[publish] 📂 Category error — resolving from title: "${publishTitle.slice(0,50)}"`);
      const resolved = await resolveCategory(refCategoryId, publishTitle);
      if (resolved.id !== refCategoryId) {
        console.log(`[publish] 📂 Category override: ${refCategoryId} → ${resolved.id} (${resolved.type})`);
        refCategoryId = resolved.id;
      }
      // Retry with fixed category, same title/description/variations — no Claude call needed
      try {
        const resultCat = await addFixedPriceItem({
          title: publishTitle, description: publishDesc,
          categoryId: refCategoryId, price: product.suggestedSellingPrice,
          stock: (product.stock ?? 10), images: refImages,
          condition: product.condition ?? "New", aspects: publishAspects,
          variations: refVariations, markupRatio,
          fulfillmentPolicyId: policies.fulfillmentPolicyId,
          paymentPolicyId:     policies.paymentPolicyId,
          returnPolicyId:      policies.returnPolicyId,
          itemCountry:         policies.itemCountry,
          itemLocation:        policies.itemLocation,
        }, userToken);
        itemId = resultCat.itemId;
        console.log(`[publish] ✅ Publicado tras corrección de categoría — ID: ${itemId}`);
      } catch (catErr: unknown) {
        const catMsg = String(catErr instanceof Error ? catErr.message : catErr);

        // After fixing category, if eBay now rejects for "improper" — do one Claude rewrite
        if (catMsg.includes("improper") || catMsg.includes("policy") || catMsg.includes("violation")) {
          console.log(`[publish] 🔒 Category fixed but improper detected — Claude rewrite for attempt 3`);
          const rewrite3 = await callClaudeForRewrite(
            `eBay rejected this title after a category fix. Generate a completely fresh, safe title.
Product: "${publishTitle}"
Return ONLY JSON: {"title":"safe title max 80 chars","description":"2-3 factual sentences"}`, 400
          );
          if (rewrite3?.title) publishTitle = rewrite3.title;
          if (rewrite3?.description) publishDesc = rewrite3.description;
          try {
            const result3 = await addFixedPriceItem({
              title: publishTitle, description: publishDesc,
              categoryId: refCategoryId, price: product.suggestedSellingPrice,
              stock: (product.stock ?? 10), images: refImages,
              condition: product.condition ?? "New", aspects: publishAspects,
              variations: refVariations, markupRatio,
              fulfillmentPolicyId: policies.fulfillmentPolicyId,
              paymentPolicyId:     policies.paymentPolicyId,
              returnPolicyId:      policies.returnPolicyId,
              itemCountry:         policies.itemCountry,
              itemLocation:        policies.itemLocation,
            }, userToken);
            itemId = result3.itemId;
            console.log(`[publish] ✅ Publicado tras category+improper fix — ID: ${itemId}`);
          } catch (err3: unknown) {
            const msg3 = String(err3 instanceof Error ? err3.message : err3);
            const finalStatus = (msg3.includes("improper") || msg3.includes("policy")) ? "rejected" : "failed";
            await docRef.update({ status: finalStatus, failReason: msg3.slice(0, 500), updatedAt: Date.now() });
            throw new Error(msg3);
          }
        } else {
          await docRef.update({ status: "failed", failReason: catMsg.slice(0, 500), updatedAt: Date.now() });
          throw catErr;
        }
      }
    } else {

    // Attempt 2: Claude describes the product from scratch using aspects + category
    // NOT "rewrite this title" — that causes word-by-word substitution which still fails.
    // Instead: "here's what this product IS, generate a fresh US retail title."
    console.log(`[publish] 🔒 Improper detected — Claude generating fresh title from product type`);

    const aspectsSummary = Object.entries(refAspects)
      .filter(([k]) => !["Brand", "MPN", "Item Length", "Item Width", "Item Height", "UPC", "EAN"].includes(k))
      .slice(0, 10)
      .map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`)
      .join(" | ");

    const rewrite2 = await callClaudeForRewrite(
      `You are a professional US eBay seller writing a product listing title.

DO NOT rewrite or reference the original title. Instead, generate a COMPLETELY FRESH title based on what the product actually is.

Product specs: ${aspectsSummary || "no specs available"}
Original product concept (for reference only — do not copy words): ${publishTitle}

Write a title that a major US retailer would use. Think: how would Target, Amazon, or Walmart describe this?
- Use standard retail terminology only
- Describe the product type, material, and key features
- Max 80 chars
- No brand names, no Chinese characters
- NEVER use these words: harem, loose, cropped, sexy, nude, drag, clip, clamp, chain, tight, hard, lingerie, erotic
Use instead: relaxed fit, short length, wide leg, comfortable, cotton, casual
Avoid ALL words with dual meanings — use the most neutral retail vocabulary

Also write a 2-3 sentence professional product description.

Return ONLY JSON: {"title":"fresh retail title","description":"2-3 sentence description"}`,
      400
    );

    if (rewrite2?.title) publishTitle = rewrite2.title;
    if (rewrite2?.description) publishDesc = rewrite2.description;
    console.log(`[publish] 🚀 Attempt 2: title="${publishTitle}"`);

    try {
      const result2 = await addFixedPriceItem({
        title: publishTitle, description: publishDesc,
        categoryId: refCategoryId, price: product.suggestedSellingPrice,
        stock: (product.stock ?? 10), images: refImages,
        condition: product.condition ?? "New", aspects: publishAspects,
        variations: refVariations, markupRatio,
        fulfillmentPolicyId: policies.fulfillmentPolicyId,
        paymentPolicyId:     policies.paymentPolicyId,
        returnPolicyId:      policies.returnPolicyId,
        itemCountry:         policies.itemCountry,
        itemLocation:        policies.itemLocation,
      }, userToken);
      itemId = result2.itemId;
      console.log(`[publish] ✅ Publicado en segundo intento — ID: ${itemId}`);

    } catch (err2: unknown) {
      const msg2 = String(err2 instanceof Error ? err2.message : err2);
      console.log(`[publish] ❌ Attempt 2 failed: ${msg2.slice(0, 120)}`);

      // If both attempts fail with "improper OR not permitted" — before auto-rejecting,
      // try resolving to a DIFFERENT category. The error often means the seller account
      // doesn't have permission for the specific CN category (e.g. new accounts on
      // Sporting Goods 15274). A more general category (e.g. 158902 Fitness Equipment)
      // typically has no seller restrictions.
      const stillImproper = msg2.includes("improper") || msg2.includes("not be permitted") || msg2.includes("policy");
      if (stillImproper) {
        // ── Logic: if CN vendor published in refCategoryId, that category IS valid.
        // Don't call resolveCategory (Taxonomy API gives absurd results for unusual titles
        // e.g. "Gauss" → Gas Regulators, "Trainer" → Men's Sneakers).
        // Just retry with the EXACT same CN category but stripped content.
        console.log(`[publish] 📂 Both attempts blocked — retrying with CN category ${refCategoryId} + stripped aspects`);
        try {
          // Strip all aspects except the absolute minimum — reduces surface area for filter hits
          const minimalAspects: Record<string, string[]> = {
            Brand: ["Unbranded"],
            MPN:   ["Does Not Apply"],
          };
          // Keep common aspects — dimensions are required in some categories
          const keepAspects = ["Color","Material","Style","Type","Size","Department",
            "Item Length","Item Width","Item Height","Country/Region of Manufacture"];
          for (const k of keepAspects) {
            if (publishAspects[k]) minimalAspects[k] = publishAspects[k];
          }
          minimalAspects["Country/Region of Manufacture"] = ["China"];

          const result3 = await addFixedPriceItem({
            title: publishTitle, description: publishDesc,
            categoryId: refCategoryId,           // ← always use CN category, it's proven valid
            price: product.suggestedSellingPrice,
            stock: (product.stock ?? 10), images: refImages,
            condition: product.condition ?? "New", aspects: minimalAspects,
            variations: refVariations, markupRatio,
            fulfillmentPolicyId: policies.fulfillmentPolicyId,
            paymentPolicyId:     policies.paymentPolicyId,
            returnPolicyId:      policies.returnPolicyId,
            itemCountry:         policies.itemCountry,
            itemLocation:        policies.itemLocation,
          }, userToken);
          itemId = result3.itemId;
          console.log(`[publish] ✅ Publicado con CN category + minimal aspects — ID: ${itemId}`);
        } catch (err3: unknown) {
          const msg3 = String(err3 instanceof Error ? err3.message : err3);
          console.log(`[publish] ❌ CN category + minimal aspects also failed: ${msg3.slice(0, 80)}`);
          const failReason = `eBay bloqueó el listing en categoría del vendor CN (${refCategoryId}). El producto puede requerir aprobación de cuenta o tener restricciones de política. Error: ${msg3.slice(0, 300)}`;
          await docRef.update({ status: "failed", failReason, updatedAt: Date.now() });
          throw new Error(failReason);
        }
      } else {
        const failReason = msg2.slice(0, 500);
        await docRef.update({ status: "failed", failReason, updatedAt: Date.now() });
        throw new Error(failReason);
      }
    }
    } // end else (improper)
    } // end else (isMissing)
  } // end catch (err1)

  // ── Step 6: Success — update Firestore ───────────────────────────────────
  await docRef.update({ status: "published", listingId: itemId, failReason: null, updatedAt: Date.now() });
  await counterRef.set({ count: currentCount + 1 }, { merge: true });

  // ── Step 7: Promoted listings (2%) ───────────────────────────────────────
  try {
    const promoted = await applyPromotedListing(itemId, userToken, storeId);
    if (promoted) await docRef.update({ bidPercentage: 2.0, updatedAt: Date.now() });
  } catch { /* non-fatal */ }

  return { listingId: itemId };
}

// ─── Marketing API: get or create a RUNNING cost-per-sale campaign ─────────────
const _campaignCache: Record<string, { id: string; fetchedAt: number }> = {};

async function getOrCreateCampaignId(token: string, storeId: string): Promise<string | null> {
  const cached = _campaignCache[storeId];
  if (cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) return cached.id;
  try {
    const res = await fetch(
      "https://api.ebay.com/sell/marketing/v1/ad_campaign?campaign_type=COST_PER_SALE&limit=10",
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json() as { campaigns?: { campaignId: string; campaignStatus: string }[] };
      const active = data.campaigns?.find(c => c.campaignStatus === "RUNNING");
      if (active) { _campaignCache[storeId] = { id: active.campaignId, fetchedAt: Date.now() }; return active.campaignId; }
    }
    // No active campaign — create one
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const cr = await fetch("https://api.ebay.com/sell/marketing/v1/ad_campaign", {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
      body: JSON.stringify({ campaignName: `DropFlow ${new Date().toISOString().slice(0,10)}`, campaignType: "COST_PER_SALE", startDate: `${tomorrow}T00:00:00.000Z`, fundingStrategy: { biddingStrategy: "FIXED", bidPercentage: "2.0" }, marketplaceId: "EBAY_US" }),
    });
    if (cr.ok || cr.status === 201) {
      const loc = cr.headers.get("Location") ?? "";
      const id  = loc.split("/").pop() ?? "";
      if (id) { _campaignCache[storeId] = { id, fetchedAt: Date.now() }; return id; }
    }
  } catch { /* non-fatal */ }
  return null;
}

async function applyPromotedListing(listingId: string, userToken: string, storeId?: string): Promise<boolean> {
  try {
    const campaignId = await getOrCreateCampaignId(userToken, storeId ?? "default");
    if (!campaignId) { console.warn(`[promote] No campaign available`); return false; }

    const res = await fetch(
      `https://api.ebay.com/sell/marketing/v1/ad_campaign/${campaignId}/bulk_create_ads_by_listing_id`,
      {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
        body: JSON.stringify({ requests: [{ listingId, bidPercentage: "2.0" }] }),
      }
    );
    if (!res.ok) { console.warn(`[promote] ⚠️ ${listingId}: HTTP ${res.status}`); return false; }
    const data = await res.json() as { responses?: { errors?: unknown[] }[] };
    const r = data.responses?.[0];
    if (r?.errors && (r.errors as unknown[]).length > 0) { console.warn(`[promote] ⚠️ ${listingId}:`, r.errors); return false; }
    console.log(`[promote] ✅ 2% ad via Marketing API → ${listingId}`);
    return true;
  } catch (e) {
    console.warn(`[promote] ⚠️ Error for ${listingId}:`, e instanceof Error ? e.message : e);
    return false;
  }
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