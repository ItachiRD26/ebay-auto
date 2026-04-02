import { db, COLLECTIONS, queueCol, settingsDoc, seenCol } from "@/lib/firebase";
import { getReferenceItemData, getCategoryIdForTitle, getTradingCategoryForTitle } from "@/lib/ebay";

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
  return { title, description: title };
}

async function findAlternativeReference(title: string, originalItemId: string, userToken: string): Promise<{ itemId: string; categoryId: string; aspects: Record<string, string[]>; images: string[] } | null> {
  try {
    const appToken = await (await import("@/lib/ebay")).getAppToken();
    const params = new URLSearchParams({ q: title.split(" ").slice(0, 5).join(" "), limit: "10", filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:CN,conditions:{NEW}", fieldgroups: "EXTENDED" });
    const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, { headers: { Authorization: `Bearer ${appToken}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json() as { itemSummaries?: Record<string, unknown>[] };
    for (const item of data.itemSummaries ?? []) {
      const rawId = (item.itemId as string) ?? "";
      const numericId = rawId.split("|")[1] ?? rawId;
      if (numericId === originalItemId) continue;
      if (numericId.startsWith(originalItemId.slice(0, 6))) continue;
      const { getReferenceItemData } = await import("@/lib/ebay");
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
      const smartDefaults: Record<string, string> = {
        Style: t.includes("vintage") ? "Vintage" : t.includes("modern") ? "Modern" : t.includes("retro") ? "Retro" : t.includes("classic") ? "Classic" : t.includes("sport") ? "Sport" : "Casual",
        Department: t.includes("men") || t.includes("male") || t.includes("boy") ? "Men" : t.includes("women") || t.includes("female") || t.includes("girl") || t.includes("lady") ? "Women" : t.includes("kid") || t.includes("child") || t.includes("baby") ? "Kids" : "Unisex Adults",
        Model: "Compatible",
        "Occasion": t.includes("sport") || t.includes("gym") || t.includes("bike") || t.includes("cycling") ? "Sport" : t.includes("office") || t.includes("work") ? "Work" : "Casual",
        "Sleeve Length": t.includes("short sleeve") ? "Short Sleeve" : t.includes("long sleeve") || t.includes("long-sleeve") ? "Long Sleeve" : t.includes("sleeveless") ? "Sleeveless" : "Long Sleeve",
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

// Known verified leaf category IDs — tested against Trading API
function getLeafCategoryByTitle(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("pet") || t.includes("dog") || t.includes("cat") || t.includes("puppy") || t.includes("kitten")) return "117426"; // Dog Beds
  if (t.includes("adapter") || t.includes("converter") || t.includes("plug"))  return "139762"; // Outlet Adapters
  if (t.includes("phone stand") || t.includes("phone holder") || t.includes("phone mount")) return "116458"; // Phone Mounts
  if (t.includes("car") || t.includes("auto") || t.includes("vehicle"))        return "179690"; // Car Care
  if (t.includes("yoga") || t.includes("fitness") || t.includes("exercise"))   return "158902"; // Fitness
  if (t.includes("light") || t.includes("lamp") || t.includes("led"))          return "20697";  // Lamps
  if (t.includes("brush") || t.includes("clean") || t.includes("scrub"))       return "37592";  // Cleaning
  if (t.includes("travel") || t.includes("packing") || t.includes("luggage"))  return "169291"; // Travel
  if (t.includes("mug") || t.includes("cup"))                                   return "20686";  // Mugs
  if (t.includes("bottle") || t.includes("tumbler"))                            return "20579";  // Bottles
  if (t.includes("pillow"))                                                      return "20455";  // Pillows
  if (t.includes("blanket") || t.includes("throw"))                             return "20460";  // Blankets
  if (t.includes("towel"))                                                       return "20461";  // Towels
  if (t.includes("rug") || t.includes("mat"))                                   return "20580";  // Rugs/Mats
  if (t.includes("vase") || t.includes("planter"))                              return "116656"; // Vases
  if (t.includes("clock"))                                                       return "3815";   // Clocks
  if (t.includes("frame"))                                                       return "92074";  // Frames
  if (t.includes("shoe"))                                                        return "112576"; // Shoe Organizers
  return "20625"; // Kitchen Storage — default verified leaf
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
  const isChinese = (v: string) => /[\u4e00-\u9fff]/.test(v);
  const aspects = { ...product.aspects };
  for (const key of Object.keys(aspects)) { aspects[key] = aspects[key].filter((v: string) => !isChinese(v)); if (aspects[key].length === 0) delete aspects[key]; }
  aspects["Brand"] = aspects["Brand"]?.length ? aspects["Brand"] : ["Unbranded"];
  aspects["MPN"]   = ["Does Not Apply"];
  for (const key of Object.keys(aspects)) {
    aspects[key] = aspects[key].map((v: string) => v.slice(0, 65).trim()).filter((v: string) => v.length > 0).slice(0, 5);
    if (aspects[key].length === 0) delete aspects[key];
  }
  const t = product.title.toLowerCase();
  const isClothing = ["dress","shirt","pants","jacket","coat","skirt","leggings","hoodie","sweater","blouse","shorts","jeans","suit"].some(w => t.includes(w));
  if (isClothing) {
    if (!aspects["Department"]) aspects["Department"] = ["Women"];
    if (!aspects["Sleeve Length"]) aspects["Sleeve Length"] = t.includes("sleeveless") ? ["Sleeveless"] : t.includes("short sleeve") ? ["Short Sleeve"] : ["Long Sleeve"];
    if (!aspects["Neckline"]) aspects["Neckline"] = ["Round Neck"];
    if (!aspects["Occasion"]) aspects["Occasion"] = ["Casual"];
    if (!aspects["Style"]) aspects["Style"] = ["Casual"];
    if (!aspects["Pattern"]) aspects["Pattern"] = t.includes("floral") ? ["Floral"] : t.includes("stripe") ? ["Striped"] : ["Solid"];
  }
  if (!aspects["Type"]) {
    if (t.includes("led strip") || t.includes("strip light")) aspects["Type"] = ["LED Strip Light"];
    else if (t.includes("lamp") || t.includes("light") || t.includes("led")) aspects["Type"] = ["LED"];
    else if (t.includes("mug")) aspects["Type"] = ["Mug"];
    else if (t.includes("bottle")) aspects["Type"] = ["Water Bottle"];
    else if (t.includes("pillow")) aspects["Type"] = ["Throw Pillow"];
    else if (t.includes("blanket") || t.includes("throw")) aspects["Type"] = ["Throw Blanket"];
    else if (t.includes("frame")) aspects["Type"] = ["Picture Frame"];
    else if (t.includes("rack") || t.includes("organizer") || t.includes("holder")) aspects["Type"] = ["Organizer"];
    else if (t.includes("box")) aspects["Type"] = ["Storage Box"];
    else if (t.includes("brush")) aspects["Type"] = ["Cleaning Brush"];
    else if (t.includes("mat") || t.includes("rug")) aspects["Type"] = ["Mat"];
    else aspects["Type"] = ["Other"];
  }
  const hasVariationData = !!(product.variations?.variations?.length);
  if (!aspects["Color"] && !hasVariationData) {
    if (t.includes("black")) aspects["Color"] = ["Black"];
    else if (t.includes("white")) aspects["Color"] = ["White"];
    else if (t.includes("silver") || t.includes("stainless")) aspects["Color"] = ["Silver"];
    else if (t.includes("gold")) aspects["Color"] = ["Gold"];
    else if (t.includes("brown") || t.includes("bamboo") || t.includes("wood")) aspects["Color"] = ["Brown"];
    else if (t.includes("clear") || t.includes("transparent")) aspects["Color"] = ["Clear"];
    else aspects["Color"] = ["Multicolor"];
  }
  if (!aspects["Material"]) {
    if (t.includes("stainless") || t.includes("steel") || t.includes("metal") || t.includes("aluminum")) aspects["Material"] = ["Metal"];
    else if (t.includes("ceramic")) aspects["Material"] = ["Ceramic"];
    else if (t.includes("plastic") || t.includes("acrylic") || t.includes("pvc")) aspects["Material"] = ["Plastic"];
    else if (t.includes("bamboo")) aspects["Material"] = ["Bamboo"];
    else if (t.includes("wood")) aspects["Material"] = ["Wood"];
    else if (t.includes("glass")) aspects["Material"] = ["Glass"];
    else if (t.includes("silicone")) aspects["Material"] = ["Silicone"];
    else if (t.includes("foam")) aspects["Material"] = ["Memory Foam"];
    else if (t.includes("cotton") || t.includes("fabric")) aspects["Material"] = ["Cotton"];
    else aspects["Material"] = ["Mixed Materials"];
  }
  if (!aspects["Size"] && !hasVariationData) { const sm = product.title.match(/\b(\d+["x]\d+|small|medium|large|xl|xxl|one size)\b/i); aspects["Size"] = sm ? [sm[0]] : ["One Size"]; }
  if (!aspects["Volume"] && !hasVariationData) { const vm = product.title.match(/(\d+)\s*(oz|ml)/i); if (vm) aspects["Volume"] = [`${vm[1]}${vm[2].toLowerCase()}`]; }
  if (!aspects["Item Length"]) aspects["Item Length"] = ["10 in"];
  if (!aspects["Item Width"])  aspects["Item Width"]  = ["10 in"];
  if (!aspects["Item Height"]) aspects["Item Height"] = ["5 in"];

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
  // 1. Strip all HTML tags (no active content allowed)
  // 2. Remove non-ASCII chars (Chinese, special chars that trigger policy filter)
  // 3. Remove HTTP links (must be HTTPS — but we strip all links from desc to be safe)
  // 4. Remove known trigger patterns: brand names, medical claims, adult terms
  // 5. Limit to 500 chars
  const stripProblematic = (text: string): string => {
    return text
      .replace(/<[^>]+>/g, " ")                           // strip HTML tags
      .replace(/https?:\/\/\S+/gi, "")                    // strip all URLs
      .replace(/[^ -~]/g, "")                       // strip non-ASCII
      .replace(/(cure|treat|heal|diagnos|medic|FDA|prescription|drug|narcotic|weapon|gun|ammo|counterfeit|replica|fake|copyright|trademark|brand)/gi, "") // policy triggers
      .replace(/(sexy|adult|xxx|porn|nude|erotic|fetish|explicit)/gi, "") // adult triggers
      .replace(/\s{2,}/g, " ")
      .trim();
  };

  let safeDesc = stripProblematic(product.description || product.title).slice(0, 500);

  // If description is too short or empty after stripping, generate a neutral fallback
  if (safeDesc.length < 20) {
    const titleWords = product.title.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    safeDesc = `High-quality ${titleWords.slice(0, 60)}. Durable and practical design for everyday use. Easy to use and maintain. Ships worldwide with tracking.`;
  }
  console.log(`[publish] safeDesc preview: "${safeDesc.slice(0,100)}"`);

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


// ─── Validate category is a leaf — fix it if not ─────────────────────────────
async function validateAndFixCategory(categoryId: string, title: string): Promise<string> {
  try {
    const appToken = await (await import("@/lib/ebay")).getAppToken();
    // getItemAspectsForCategory returns 200 only for valid leaf categories
    const res = await fetch(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`,
      { headers: { Authorization: `Bearer ${appToken}` }, signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      console.log(`[category] ${categoryId} ✅ confirmed leaf`);
      return categoryId;
    }
    // Not a leaf — get fresh suggestion
    console.log(`[category] ${categoryId} ❌ not a leaf — fetching suggestion for "${title.slice(0,40)}"`);
    const { getCategoryIdForTitle } = await import("@/lib/ebay");
    const fresh = await getCategoryIdForTitle(title);
    if (fresh) {
      console.log(`[category] Fresh leaf: ${fresh}`);
      return fresh;
    }
  } catch (e) { console.warn("[category] validation error:", e); }
  return categoryId; // fallback: return original and let eBay error handle it
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
          // Trim to MAX_VARIATIONS keeping the cheapest variants first (sorted by refPrice asc)
          refVariations = {
            ...refVariations,
            variations: [...refVariations.variations]
              .sort((a, b) => a.refPrice - b.refPrice)
              .slice(0, MAX_VARIATIONS),
          };
          console.log(`[publish] ⚡ forceVariations=true — trimmed to ${MAX_VARIATIONS} cheapest variants`);
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
    publishDesc  = description;
  }

  let itemId: string;
  const rawCatId    = refCategoryId || getLeafCategoryByTitle(product.title);
  let publishCatId  = await validateAndFixCategory(rawCatId, product.title);
  let publishAspects = { ...refAspects };

  const FIXABLE = ["missing", "category", "leaf", "improper", "policy", "violation", "Model", "item specific", "too long", "characters", "Style", "Department", "Occasion", "Sleeve"];

  try {
    const result = await addFixedPriceItem({ title: publishTitle, description: publishDesc, categoryId: publishCatId, price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1), images: refImages, condition: product.condition ?? "New", aspects: publishAspects, variations: refVariations, markupRatio , fulfillmentPolicyId: policies.fulfillmentPolicyId, paymentPolicyId: policies.paymentPolicyId, returnPolicyId: policies.returnPolicyId , itemCountry: policies.itemCountry, itemLocation: policies.itemLocation }, userToken);
    itemId = result.itemId;
  } catch (firstErr: unknown) {
    const errMsg = String(firstErr instanceof Error ? firstErr.message : firstErr);
    const isFixable = FIXABLE.some(kw => errMsg.toLowerCase().includes(kw.toLowerCase()));
    if (!isFixable) throw firstErr;

    console.log(`[publish] ⚠️ Error fixable detectado — pidiendo a Claude que corrija...`);
    console.log(`[publish] Error: ${errMsg}`);

    const fix = await autoFixWithClaude(errMsg, { title: publishTitle, description: publishDesc, categoryId: publishCatId, aspects: publishAspects });

    // Category / leaf error → use known verified leaf
    if (errMsg.includes("category") || errMsg.includes("Categor") || errMsg.includes("leaf")) {
      publishCatId = getLeafCategoryByTitle(publishTitle);
      console.log(`[publish] 🔧 Categoría hoja por keyword: ${publishCatId}`);
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
      const result2 = await addFixedPriceItem({ title: publishTitle, description: publishDesc, categoryId: publishCatId, price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1), images: refImages, condition: product.condition ?? "New", aspects: publishAspects, variations: refVariations, markupRatio , fulfillmentPolicyId: policies.fulfillmentPolicyId, paymentPolicyId: policies.paymentPolicyId, returnPolicyId: policies.returnPolicyId , itemCountry: policies.itemCountry, itemLocation: policies.itemLocation }, userToken);
      itemId = result2.itemId;
      console.log(`[publish] ✅ Publicado tras corrección automática — ID: ${itemId}`);
    } catch (retryErr: unknown) {
      const retryMsg = String(retryErr instanceof Error ? retryErr.message : retryErr);
      if (retryMsg.includes("improper") || retryMsg.includes("policy")) {
        console.log(`[publish] 🔍 Buscando listing alternativo para: "${publishTitle}"...`);
        const altRef = await findAlternativeReference(publishTitle, product.ebayItemId, userToken);
        if (!altRef) throw new Error(`Vendedor bloqueado y no se encontró referencia alternativa`);
        console.log(`[publish] ✅ Referencia alternativa encontrada: ${altRef.itemId}`);
        if (altRef.categoryId) publishCatId = altRef.categoryId;
        if (altRef.aspects && Object.keys(altRef.aspects).length > 0) publishAspects = { ...publishAspects, ...altRef.aspects };
        try {
          const result3 = await addFixedPriceItem({ title: publishTitle, description: publishDesc, categoryId: publishCatId, price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1), images: refImages.length > 0 ? refImages : altRef.images, condition: product.condition ?? "New", aspects: publishAspects, variations: refVariations, markupRatio , fulfillmentPolicyId: policies.fulfillmentPolicyId, paymentPolicyId: policies.paymentPolicyId, returnPolicyId: policies.returnPolicyId , itemCountry: policies.itemCountry, itemLocation: policies.itemLocation }, userToken);
          itemId = result3.itemId;
          console.log(`[publish] ✅ Publicado con referencia alternativa — ID: ${itemId}`);
        } catch (altErr: unknown) {
          const altMsg = String(altErr instanceof Error ? altErr.message : altErr);
          if (altMsg.includes("improper") || altMsg.includes("policy") || altMsg.includes("leaf") || altMsg.includes("category")) {
            publishCatId = getLeafCategoryByTitle(publishTitle);
            publishAspects = { Brand: ["Unbranded"], MPN: ["Does Not Apply"] };
            console.log(`[publish] 🔧 Último recurso: cat=${publishCatId} para "${publishTitle.slice(0,40)}"`);
            const result4 = await addFixedPriceItem({ title: publishTitle, description: publishDesc, categoryId: publishCatId, price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1), images: refImages.length > 0 ? refImages : altRef.images, condition: product.condition ?? "New", aspects: publishAspects, variations: null, markupRatio , fulfillmentPolicyId: policies.fulfillmentPolicyId, paymentPolicyId: policies.paymentPolicyId, returnPolicyId: policies.returnPolicyId , itemCountry: policies.itemCountry, itemLocation: policies.itemLocation }, userToken);
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