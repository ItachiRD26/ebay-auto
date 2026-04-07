import { db, queueCol, settingsDoc, seenCol } from "@/lib/firebase";
import { getReferenceItemData, getUserToken, getAppToken } from "@/lib/ebay";

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

      // Apply directly — no need to ask Claude, smartDefaults already has the right values
      console.log(`[publish] 🔧 Adding missing aspects directly:`, aspectsToAdd);
      return { aspects: aspectsToAdd };
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


// Simple keyword-based leaf category — no API calls, always works
function getLeafCategoryByTitle(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("dog") || t.includes("cat") || t.includes("pet") || t.includes("puppy") || t.includes("kitten")) return "117426";
  if (t.includes("adapter") || t.includes("converter") || t.includes("plug"))  return "139762";
  if (t.includes("phone stand") || t.includes("phone holder") || t.includes("phone mount")) return "175759";
  if (t.includes("yoga") || t.includes("fitness") || t.includes("exercise") || t.includes("resistance band")) return "158902";
  if (t.includes("light") || t.includes("lamp") || t.includes("led"))          return "20697";
  if (t.includes("brush") || t.includes("clean") || t.includes("scrub"))       return "37592";
  if (t.includes("travel") || t.includes("packing") || t.includes("luggage"))  return "169291";
  if (t.includes("mug") || t.includes("cup"))                                   return "20686";
  if (t.includes("bottle") || t.includes("tumbler"))                            return "20579";
  if (t.includes("pillow"))                                                      return "20455";
  if (t.includes("blanket") || t.includes("throw"))                             return "20460";
  if (t.includes("towel"))                                                       return "20461";
  if (t.includes("rug") || t.includes("mat"))                                   return "20580";
  if (t.includes("vase") || t.includes("planter"))                              return "116656";
  if (t.includes("clock"))                                                       return "3815";
  if (t.includes("frame"))                                                       return "92074";
  if (t.includes("organizer") || t.includes("storage") || t.includes("rack") || t.includes("holder")) return "20625";
  if (t.includes("necklace") || t.includes("bracelet") || t.includes("earring") || t.includes("ring")) return "10968";
  if (t.includes("shirt") || t.includes("tee") || t.includes("top"))           return "53159";
  if (t.includes("pants") || t.includes("trousers") || t.includes("jeans"))    return "63863";
  if (t.includes("dress"))                                                       return "63861";
  if (t.includes("shoe") || t.includes("sneaker") || t.includes("loafer") || t.includes("boot")) return "45333";
  return "20625"; // Kitchen Storage — always a valid leaf
}

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
  title: string; description: string; categoryId: string; price: number;
  stock: number; images: string[]; condition: string; aspects: Record<string, string[]>;
  variations?: VariationsData | null; markupRatio?: number;
  fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string;
  itemCountry?: string; itemLocation?: string;
}, userToken: string): Promise<{ itemId: string }> {

  // Clean aspects: strip Chinese, reset Brand/MPN, supplement missing basics
  const isChinese = (v: string) => /[\u4e00-\u9fff]/.test(v);
  const aspects = { ...product.aspects };
  for (const key of Object.keys(aspects)) {
    aspects[key] = (aspects[key] as string[]).filter((v: string) => !isChinese(v));
    if (aspects[key].length === 0) delete aspects[key];
  }
  aspects["Brand"] = aspects["Brand"]?.length ? aspects["Brand"] : ["Unbranded"];
  aspects["MPN"]   = ["Does Not Apply"];
  for (const key of Object.keys(aspects)) {
    aspects[key] = (aspects[key] as string[]).map((v: string) => v.slice(0, 65).trim()).filter((v: string) => v.length > 0).slice(0, 5);
    if (aspects[key].length === 0) delete aspects[key];
  }
  const t_asp = product.title.toLowerCase();
  if (!aspects["Type"]) {
    if (t_asp.includes("led strip") || t_asp.includes("strip light")) aspects["Type"] = ["LED Strip Light"];
    else if (t_asp.includes("lamp") || t_asp.includes("light") || t_asp.includes("led")) aspects["Type"] = ["LED"];
    else if (t_asp.includes("mug")) aspects["Type"] = ["Mug"];
    else if (t_asp.includes("bottle")) aspects["Type"] = ["Water Bottle"];
    else if (t_asp.includes("pillow")) aspects["Type"] = ["Throw Pillow"];
    else if (t_asp.includes("blanket") || t_asp.includes("throw")) aspects["Type"] = ["Throw Blanket"];
    else if (t_asp.includes("frame")) aspects["Type"] = ["Picture Frame"];
    else if (t_asp.includes("rack") || t_asp.includes("organizer") || t_asp.includes("holder")) aspects["Type"] = ["Organizer"];
    else if (t_asp.includes("box")) aspects["Type"] = ["Storage Box"];
    else if (t_asp.includes("mat") || t_asp.includes("rug")) aspects["Type"] = ["Mat"];
    else if (t_asp.includes("fountain") || t_asp.includes("bird bath")) aspects["Type"] = ["Fountain"];
    else aspects["Type"] = ["Other"];
  }
  if (!aspects["Color"] && !product.variations?.variations?.length) {
    if (t_asp.includes("black")) aspects["Color"] = ["Black"];
    else if (t_asp.includes("white")) aspects["Color"] = ["White"];
    else if (t_asp.includes("silver") || t_asp.includes("stainless")) aspects["Color"] = ["Silver"];
    else aspects["Color"] = ["Multicolor"];
  }
  if (!aspects["Material"]) {
    if (t_asp.includes("stainless") || t_asp.includes("steel") || t_asp.includes("metal")) aspects["Material"] = ["Metal"];
    else if (t_asp.includes("ceramic")) aspects["Material"] = ["Ceramic"];
    else if (t_asp.includes("plastic") || t_asp.includes("acrylic")) aspects["Material"] = ["Plastic"];
    else if (t_asp.includes("bamboo")) aspects["Material"] = ["Bamboo"];
    else if (t_asp.includes("wood")) aspects["Material"] = ["Wood"];
    else if (t_asp.includes("glass")) aspects["Material"] = ["Glass"];
    else if (t_asp.includes("silicone")) aspects["Material"] = ["Silicone"];
    else if (t_asp.includes("cotton") || t_asp.includes("fabric")) aspects["Material"] = ["Cotton"];
    else aspects["Material"] = ["Mixed Materials"];
  }

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
  // isChinese defined above
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
        : +(product.price * markupRatio).toFixed(2);
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





async function findAlternativeReference(title: string, originalItemId: string, userToken: string): Promise<{ itemId: string; categoryId: string; aspects: Record<string, string[]>; images: string[] } | null> {
  try {
    const params = new URLSearchParams({ q: title.split(" ").slice(0, 5).join(" "), limit: "10", filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:CN,conditions:{NEW}", fieldgroups: "EXTENDED" });
    const appToken = await getAppToken();
    const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, { headers: { Authorization: `Bearer ${appToken}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json() as { itemSummaries?: Record<string, unknown>[] };
    for (const item of data.itemSummaries ?? []) {
      const rawId = (item.itemId as string) ?? "";
      const numericId = rawId.split("|")[1] ?? rawId;
      if (numericId === originalItemId) continue;
      const refData = await getReferenceItemData(numericId, userToken);
      if (!refData) continue;
      console.log(`[publish] 🔍 Alt ref: ${numericId} — ${Object.keys(refData.aspects).length} aspects`);
      return { itemId: numericId, categoryId: refData.categoryId, aspects: refData.aspects, images: refData.imageUrls };
    }
    return null;
  } catch (e) { console.warn("[publish] findAlternativeReference error:", e); return null; }
}

export async function publishProductById(
  productId: string,
  userToken: string,
  userId: string,
  storeId?: string,
  forceVariations = false,
): Promise<{ listingId: string }> {
  const docRef = queueCol(userId).doc(productId);
  const doc    = await docRef.get();
  if (!doc.exists) throw new Error("Product not found");
  const product = doc.data()!;

  // ── Monthly limit ─────────────────────────────────────────────────────────
  const now      = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const counterRef = db.collection("counters").doc(`listings_${monthKey}`);
  const counterDoc = await counterRef.get();
  const currentCount = counterDoc.exists ? (counterDoc.data()!.count as number) : 0;
  const MONTHLY_LIMIT = 245;
  if (currentCount >= MONTHLY_LIMIT)
    throw new Error(`Límite mensual alcanzado (${currentCount}/${MONTHLY_LIMIT} listings este mes)`);

  // ── Store policies (country, location, policy IDs) ────────────────────────
  const sid = storeId ?? (product.storeId as string) ?? "";
  const policies = await getStorePolicies(userId, sid);

  if (product.failReason) await docRef.update({ failReason: null, status: "approved" });

  // ── GetItem — pull category, aspects, images, variations from CN ref ───────
  let refAspects:    Record<string, string[]> = {};
  let refImages:     string[]                 = product.images ?? [];
  let refCategoryId: string                   = product.categoryId;
  let refVariations: VariationsData | null    = null;

  if (product.ebayItemId) {
    const rawId       = String(product.ebayItemId);
    const numericId   = rawId.split("|")[1] ?? rawId;
    console.log(`[publish] GetItem ref → rawId="${rawId}" numericId="${numericId}"`);
    const refData = await getReferenceItemData(numericId, userToken);
    console.log(`[publish] refData=${refData ? "OK" : "NULL"}`);
    if (refData) {
      refAspects = refData.aspects;
      if (refData.categoryId) refCategoryId = refData.categoryId;
      const merged = [...refImages];
      refData.imageUrls.forEach((u: string) => { if (!merged.includes(u)) merged.push(u); });
      refImages = merged.slice(0, 12);
      refVariations = (refData as unknown as ReferenceItemData).variations ?? null;

      // Update real variation price range in Firestore for the product card
      if (refVariations?.variations.length) {
        const varPrices = refVariations.variations.map((v: VariationSpec) => v.refPrice).filter((p: number) => p > 0);
        if (varPrices.length)
          await docRef.update({ refPriceMin: Math.min(...varPrices), refPriceMax: Math.max(...varPrices) });
      }

      const MAX_VARIATIONS = 250;
      if (refVariations && refVariations.variations.length > MAX_VARIATIONS) {
        if (forceVariations) {
          console.log(`[publish] ⚡ forceVariations — listing all ${refVariations.variations.length} variants`);
        } else {
          throw new Error(`TOO_MANY_VARIATIONS:${refVariations.variations.length}:${MAX_VARIATIONS}`);
        }
      }
      const varInfo = refVariations
        ? ` | ${refVariations.variations.length} variantes (${Object.keys(refVariations.specificsSet).join(", ")})`
        : " | sin variantes";
      console.log(`[publish] ${productId} — ${Object.keys(refAspects).length} aspects, ${refImages.length} images${varInfo}`);
    }
  }

  // ── Markup ratio ──────────────────────────────────────────────────────────
  const markupPercent = (product.markupPercent as number | undefined) ?? 6;
  const markupRatio   = 1 + markupPercent / 100;

  // ── Claude rewrites title + description ───────────────────────────────────
  const { title: cleanTitle, description } = await generateTitleAndDescription(
    product.title as string, refAspects
  );
  let publishTitle  = cleanTitle;
  let publishDesc   = description || `${cleanTitle}. Durable and practical for everyday use. Fast shipping with tracking.`;
  let publishCatId  = refCategoryId || getLeafCategoryByTitle(product.title as string);
  let publishAspects = { ...refAspects };

  // ── Pre-populate required aspects for clothing categories ─────────────────
  // GetItem often doesn't return Department/Style/Size/SizeType for CN clothing.
  // eBay requires them — add defaults upfront so attempt 1 doesn't fail for this reason.
  const CLOTHING_CATS = new Set(["63863","63861","53159","63862","57990","11483","11484","15724","11517","177"]);
  const t_title = (product.title as string).toLowerCase();
  const isClothingCat = CLOTHING_CATS.has(publishCatId);
  const isClothingTitle = ["pants","trousers","shirt","dress","top","blouse","skirt","jacket","coat","shorts","jeans","legging","hoodie","sweater","vest","tank"].some(w => t_title.includes(w));

  if (isClothingCat || isClothingTitle) {
    if (!publishAspects["Department"])
      publishAspects["Department"] = [t_title.includes("men") && !t_title.includes("women") ? "Men" : t_title.includes("kid") || t_title.includes("boy") || t_title.includes("girl") ? "Kids" : "Women"];
    if (!publishAspects["Style"])
      publishAspects["Style"] = ["Casual"];
    if (!publishAspects["Size Type"])
      publishAspects["Size Type"] = ["Regular"];
    if (!publishAspects["Size"] && !refVariations?.variations.length)
      publishAspects["Size"] = [t_title.includes("men") && !t_title.includes("women") ? "US 9" : "US 7"];
    if (!publishAspects["Occasion"])
      publishAspects["Occasion"] = ["Casual"];
    console.log(`[publish] 👕 Clothing aspects pre-filled: Department=${publishAspects["Department"]}, Style=${publishAspects["Style"]}, SizeType=${publishAspects["Size Type"]}`);
  }

  const FIXABLE = ["missing", "category", "leaf", "improper", "policy", "violation", "Model", "item specific", "too long", "characters"];

  let itemId: string;

  // ── Attempt 1 ────────────────────────────────────────────────────────────
  try {
    const r = await addFixedPriceItem({
      title: publishTitle, description: publishDesc,
      categoryId: publishCatId, price: product.suggestedSellingPrice,
      stock: Math.min(product.stock ?? 1, 1), images: refImages,
      condition: product.condition ?? "New", aspects: publishAspects,
      variations: refVariations, markupRatio,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      paymentPolicyId:     policies.paymentPolicyId,
      returnPolicyId:      policies.returnPolicyId,
      itemCountry:         policies.itemCountry,
      itemLocation:        policies.itemLocation,
    }, userToken);
    itemId = r.itemId;

  } catch (firstErr: unknown) {
    const errMsg    = String(firstErr instanceof Error ? firstErr.message : firstErr);
    const isFixable = FIXABLE.some(kw => errMsg.toLowerCase().includes(kw.toLowerCase()));
    if (!isFixable) throw firstErr;

    console.log(`[publish] ⚠️ Error fixable — pidiendo a Claude que corrija: ${errMsg.slice(0, 100)}`);

    const fix = await autoFixWithClaude(errMsg, {
      title:      publishTitle,
      description: publishDesc,
      categoryId:  publishCatId,
      aspects:     publishAspects,
    });

    if (errMsg.includes("category") || errMsg.includes("Categor") || errMsg.includes("leaf")) {
      publishCatId = getLeafCategoryByTitle(publishTitle);
      console.log(`[publish] 🔧 Categoría por keyword: ${publishCatId}`);
    } else {
      if (!fix) { console.log("[publish] Claude no pudo corregir"); throw firstErr; }
      if (fix.title)       { publishTitle   = fix.title;                              console.log(`[publish] 🔧 Título: "${fix.title}"`); }
      if (fix.description) { publishDesc    = fix.description;                        console.log(`[publish] 🔧 Descripción corregida`); }
      if (fix.aspects)     {
        for (const [k, v] of Object.entries(fix.aspects)) {
          publishAspects[k] = Array.isArray(v) ? v : [String(v)];
        }
        console.log(`[publish] 🔧 Aspects merged:`, fix.aspects);
      }
    }

    if (errMsg.includes("improper") || errMsg.includes("policy")) {
      publishDesc = `High-quality ${publishTitle}. Durable construction and practical design. Easy to use and clean. Perfect for everyday use. Fast shipping included.`;
      console.log(`[publish] 🔧 Descripción genérica neutra aplicada`);
    }

    // ── Attempt 2 ──────────────────────────────────────────────────────────
    console.log(`[publish] 🔄 Reintentando con correcciones...`);
    try {
      const r2 = await addFixedPriceItem({
        title: publishTitle, description: publishDesc,
        categoryId: publishCatId, price: product.suggestedSellingPrice,
        stock: Math.min(product.stock ?? 1, 1), images: refImages,
        condition: product.condition ?? "New", aspects: publishAspects,
        variations: refVariations, markupRatio,
        fulfillmentPolicyId: policies.fulfillmentPolicyId,
        paymentPolicyId:     policies.paymentPolicyId,
        returnPolicyId:      policies.returnPolicyId,
        itemCountry:         policies.itemCountry,
        itemLocation:        policies.itemLocation,
      }, userToken);
      itemId = r2.itemId;
      console.log(`[publish] ✅ Publicado tras corrección — ID: ${itemId}`);

    } catch (retryErr: unknown) {
      const retryMsg = String(retryErr instanceof Error ? retryErr.message : retryErr);

      if (retryMsg.includes("improper") || retryMsg.includes("policy")) {
        // ── Attempt 3: find alt reference ────────────────────────────────
        console.log(`[publish] 🔍 Buscando referencia alternativa...`);
        const altRef = await findAlternativeReference(publishTitle, String(product.ebayItemId ?? ""), userToken);

        if (!altRef) {
          await docRef.update({ status: "rejected", failReason: "Bloqueado por eBay — producto no listable en esta cuenta", updatedAt: Date.now() });
          throw new Error("AUTO-RECHAZADO: bloqueado por eBay tras 3 intentos");
        }

        console.log(`[publish] ✅ Alt ref: ${altRef.itemId}`);
        if (altRef.categoryId) publishCatId = altRef.categoryId;
        if (altRef.aspects && Object.keys(altRef.aspects).length > 0)
          publishAspects = { ...publishAspects, ...altRef.aspects };

        try {
          const r3 = await addFixedPriceItem({
            title: publishTitle, description: publishDesc,
            categoryId: publishCatId, price: product.suggestedSellingPrice,
            stock: Math.min(product.stock ?? 1, 1), images: refImages.length > 0 ? refImages : altRef.images,
            condition: product.condition ?? "New", aspects: publishAspects,
            variations: refVariations, markupRatio,
            fulfillmentPolicyId: policies.fulfillmentPolicyId,
            paymentPolicyId:     policies.paymentPolicyId,
            returnPolicyId:      policies.returnPolicyId,
            itemCountry:         policies.itemCountry,
            itemLocation:        policies.itemLocation,
          }, userToken);
          itemId = r3.itemId;
          console.log(`[publish] ✅ Publicado con alt ref — ID: ${itemId}`);

        } catch (altErr: unknown) {
          const altMsg = String(altErr instanceof Error ? altErr.message : altErr);
          if (altMsg.includes("improper") || altMsg.includes("policy") || altMsg.includes("leaf") || altMsg.includes("category")) {
            // ── Attempt 4: last resort ──────────────────────────────────
            publishCatId   = getLeafCategoryByTitle(publishTitle);
            publishAspects = { Brand: ["Unbranded"], MPN: ["Does Not Apply"] };
            console.log(`[publish] 🔧 Último recurso: cat=${publishCatId} "${publishTitle.slice(0,40)}"`);
            const r4 = await addFixedPriceItem({
              title: publishTitle, description: publishDesc,
              categoryId: publishCatId, price: product.suggestedSellingPrice,
              stock: Math.min(product.stock ?? 1, 1), images: refImages.length > 0 ? refImages : altRef.images,
              condition: product.condition ?? "New", aspects: publishAspects,
              variations: null, markupRatio,
              fulfillmentPolicyId: policies.fulfillmentPolicyId,
              paymentPolicyId:     policies.paymentPolicyId,
              returnPolicyId:      policies.returnPolicyId,
              itemCountry:         policies.itemCountry,
              itemLocation:        policies.itemLocation,
            }, userToken);
            itemId = r4.itemId;
            console.log(`[publish] ✅ Publicado con fallback máximo — ID: ${itemId}`);
          } else throw altErr;
        }
      } else throw retryErr;
    }
  }

  // ── Success ───────────────────────────────────────────────────────────────
  await docRef.update({ status: "published", publishedAt: Date.now(), listingId: itemId!, bidPercentage: 2.0, updatedAt: Date.now() });

  // Mark as seen so it never re-enters the queue
  const rawItemId = String(product.ebayItemId ?? "");
  const numericItemId = rawItemId.split("|")[1] ?? rawItemId;
  if (numericItemId) {
    await seenCol(userId).doc(numericItemId).set({
      ebayItemId: numericItemId, title: product.title ?? "",
      reason: "published", listingId: itemId!, seenAt: Date.now(), productId,
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