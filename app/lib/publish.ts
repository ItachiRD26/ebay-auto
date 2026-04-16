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
    const prompt = `You are an eBay listing writer AND content policy specialist. Your job is two things at once:
1. Rewrite the title to be clear, keyword-rich, and eBay-compliant
2. Proactively identify and replace ANY word that could be flagged by eBay automated content filter

Product title: ${title}
${aspectsText ? `Details:\n${aspectsText}` : ""}

eBay filter is aggressive and flags words based on pattern-matching, not context. It flags innocent words if they have ANY possible adult/violent connotation elsewhere.

THINK BEFORE WRITING: scan each word. Ask: "Could this word EVER appear in adult content, weapons, or hate speech contexts?" If yes, replace it even if innocent here.

Common flagged words and safe replacements (not exhaustive — use your judgment for others):
- clip / clip-on → "attachable", "mount", "holder"
- clamp / clamping → "grip", "bracket", "securing"
- chain → "link", "metal band", "steel band"
- strip → "band", "tape", "panel"
- drag → "slip-on", "backless", "pull-on"
- choke → "standard collar", "flat collar"
- shock → "vibration", "static"
- prong → "pin", "contact point"
- bang, thrust, penetrate → rephrase completely
- nude, naked, flesh → "natural", "skin-tone"
- male (apparel) → "men's"
- screw (as verb) → "fasten", "attach"
- suction cup → "vacuum mount", "adhesive mount"
- whip, bondage, fetish, restraint → never use
- loose (apparel) → "relaxed fit" or "comfortable"
- cropped → "short length" or "ankle length"
- harem (pants style) → "wide leg" or "relaxed"
- oversized → "comfortable fit" or "relaxed"

For ANY other word you identify as potentially flagged: use your best judgment to replace it with a neutral, professional alternative that preserves the product meaning.

Return ONLY valid JSON (no markdown, no extra text):
{"title":"compliant rewritten title","description":"3-4 sentence professional description"}

Title rules: max 80 chars, keep core product name + key features, remove all brand names and trademarked terms, remove Chinese characters, no HTML, no URLs.
Description rules: professional tone, highlight features and practical benefits, NO brand names, NO medical claims, NO adult content, NO URLs, plain text only, under 150 words.`;

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
        Style: isFootwearCtx
          ? (t.includes("casual") || t.includes("loafer") || t.includes("mule") || t.includes("slip") ? "Casual" : t.includes("sport") || t.includes("running") ? "Athletic" : t.includes("formal") || t.includes("dress") || t.includes("oxford") ? "Formal" : "Casual")
          : (t.includes("vintage") ? "Vintage" : t.includes("modern") ? "Modern" : t.includes("retro") ? "Retro" : t.includes("sport") ? "Athletic" : "Casual"),
        Department: t.includes("men") || t.includes("male") || t.includes("boy") ? "Men" : t.includes("women") || t.includes("female") || t.includes("girl") || t.includes("lady") ? "Women" : t.includes("kid") || t.includes("child") || t.includes("baby") ? "Kids" : "Men",
        Model: "Compatible",
        // Size Type: the width/fit type — almost always "Regular" for standard shoes
        "Size Type": t.includes("wide") ? "Wide" : t.includes("narrow") ? "Narrow" : t.includes("extra wide") ? "Extra Wide" : "Regular",
        // Size: eBay requires this even for variation products in some footwear categories.
        // Use a common men's or women's size as the representative value.
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
    return callClaudeForRewrite(prompt, 400);
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

  const picturesXml = product.images.slice(0, 12).map(url => `<PictureURL>${escXml(url)}</PictureURL>`).join("");
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
  const varData: VariationsData | null = rawVarData ? {
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
      const pictureSets = Object.entries(varData.picturesByVariant).map(([value, urls]) => { const urlsXml = (urls as string[]).slice(0, 6).map((u: string) => `<PictureURL>${escXml(u)}</PictureURL>`).join(""); return `<VariationSpecificPictureSet><VariationSpecificValue>${escVal(value)}</VariationSpecificValue>${urlsXml}</VariationSpecificPictureSet>`; }).join("");
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
    .map(([name, values]) => values.map(v => `<NameValueList><n>${escXml(name)}</n><Value>${escXml(v)}</Value></NameValueList>`).join(""))
    .join("");
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

  // Log so we can debug "improper" rejections that aren't in the title
  console.log(`[publish] 📄 Desc sent (${safeDesc.length} chars): "${safeDesc.slice(0, 150)}"`);

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
      refImages     = merged.slice(0, 12);
      refVariations = (refData as unknown as ReferenceItemData).variations ?? null;

      // Update real variation price range in Firestore for the product card
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

NEVER USE: clip, clamp, chain, strip, hard, tight, drag, harem, sexy, nude, naked, whip, shock, prong, thrust, penetrate, bondage, fetish, restraint, screw, bang, male (for apparel)

Return ONLY JSON: {"title":"safe rewritten title max 80 chars","description":"2-3 factual sentences, professional, no brand names, no URLs"}`, 400);
    publishTitle = rewrite?.title ?? preScreened;
    publishDesc  = rewrite?.description ?? "";
    console.log(`[publish] 🔒 wasImproper rewrite: "${publishTitle}"`);
  } else {
    const { title, description } = await generateTitleAndDescription(preScreened, refAspects);
    publishTitle = title;
    publishDesc  = description || `${title}. Quality construction for everyday use. Ships with tracking.`;
  }

  // Generate description from aspects if CN listing was image-based (no text desc)
  const rawCNDesc = (product.description || "").replace(/<[^>]+>/g, " ").replace(/[^ -~]/g, "").trim();
  if (rawCNDesc.length < 30 && !publishDesc && Object.keys(refAspects).length > 0) {
    const aspectsSummary = Object.entries(refAspects).filter(([k]) => !["Brand","MPN","Item Length","Item Width","Item Height"].includes(k)).slice(0, 8).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join("; ");
    try {
      const dr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200, messages: [{ role: "user", content: `Write a 2-3 sentence eBay product description for: "${publishTitle}". Specs: ${aspectsSummary}. Rules: professional, highlight features/benefits, NO brand names, NO medical claims, NO adult content, NO URLs, plain text only. Return ONLY the description.` }] }),
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

  console.log(`[publish] 🚀 Attempt 1: cat=${refCategoryId} title="${publishTitle}"`);
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

    // ── Missing item specific: Claude adds it, retry immediately ──────────────
    if (isMissing && !isImproper && !isCategoryErr) {
      console.log(`[publish] 🔧 Missing item specific — Claude fixing aspects: ${msg1.slice(0, 80)}`);
      const fix = await autoFixWithClaude(msg1, {
        title: publishTitle, description: publishDesc,
        categoryId: refCategoryId, aspects: publishAspects,
      });
      if (fix?.aspects) {
        Object.assign(publishAspects, fix.aspects);
        console.log(`[publish] 🔧 Added aspects: ${JSON.stringify(fix.aspects)}`);
      }
      // Safety net: Brand and MPN are always required — force them
      if (!publishAspects["Brand"]?.length) publishAspects["Brand"] = ["Unbranded"];
      publishAspects["MPN"] = ["Does Not Apply"];
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
      // Auto-reject if both attempts blocked by "improper" — product can't be listed
      const finalStatus = (msg2.includes("improper") || msg2.includes("policy")) ? "rejected" : "failed";
      const failReason  = finalStatus === "rejected"
        ? `AUTO-RECHAZADO: eBay bloqueó el listing 2 veces por palabras problemáticas. Producto no listable en esta cuenta.`
        : msg2.slice(0, 500);
      await docRef.update({ status: finalStatus, failReason, updatedAt: Date.now() });
      throw new Error(failReason);
    }
    } // end else (improper)
    } // end else (isMissing)
  } // end catch (err1)

  // ── Step 6: Success — update Firestore ───────────────────────────────────
  await docRef.update({ status: "published", listingId: itemId, failReason: null, updatedAt: Date.now() });
  await counterRef.set({ count: currentCount + 1 }, { merge: true });

  // ── Step 7: Promoted listings (2%) ───────────────────────────────────────
  try {
    await applyPromotedListing(itemId, userToken);
  } catch { /* non-fatal */ }

  return { listingId: itemId };
}

async function applyPromotedListing(listingId: string, userToken: string): Promise<void> {
  try {
    const xml = `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials><Item><ItemID>${listingId}</ItemID><PromotedListingDetails><BidPercentage>2.0</BidPercentage><PromotionMethod>COST_PER_SALE</PromotionMethod></PromotedListingDetails></Item></ReviseFixedPriceItemRequest>`;
    const https = await import("node:https");
    await new Promise<void>((resolve) => {
      const buf = Buffer.from(xml, "utf-8");
      const req = https.request({
        hostname: "api.ebay.com", path: "/ws/api.dll", method: "POST",
        headers: { "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "967", "X-EBAY-API-CALL-NAME": "ReviseFixedPriceItem", "Content-Type": "text/xml", "Content-Length": buf.length.toString() }
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (body.includes("<Ack>Failure</Ack>")) {
            const m = body.match(/<LongMessage>(.*?)<\/LongMessage>/);
            console.warn(`[promote] ⚠️ ${listingId}: ${m?.[1] ?? "Unknown error"}`);
          } else {
            console.log(`[promote] ✅ 2% ad applied to ${listingId}`);
          }
          resolve();
        });
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