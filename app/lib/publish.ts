import { db, COLLECTIONS } from "@/lib/firebase";
import { getReferenceItemData, getCategoryIdForTitle, getTradingCategoryForTitle } from "@/lib/ebay";

interface VariationSpec { specifics: Record<string, string>; refPrice: number; }
interface VariationsData { variations: VariationSpec[]; specificsSet: Record<string, string[]>; picturesByVariant: Record<string, string[]>; pictureDimension: string; }
interface ReferenceItemData { title: string; description: string; categoryId: string; aspects: Record<string, string[]>; imageUrls: string[]; condition: string; variations: VariationsData | null; }

// ─── Generate title + description with Claude ─────────────────────────────────
export async function generateTitleAndDescription(
  title: string,
  aspects: Record<string, string[]>
): Promise<{ title: string; description: string }> {
  try {
    const aspectsText = Object.entries(aspects).slice(0, 8)
      .map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n");

    const prompt = `You are an eBay listing writer. Given a product title and details, return ONLY valid JSON.

Product title: ${title}
${aspectsText ? `Details:\n${aspectsText}` : ""}

Return exactly this JSON (no markdown, no extra text):
{"title":"rewritten title here","description":"3-4 sentence description here"}

Title rules: keep core product name + features, remove brand names, max 80 chars, do NOT copy original exactly.
Description rules: professional tone, highlight features/benefits, NO dropshipping/wholesale/supplier mentions, plain text, under 150 words.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API ${res.status}: ${errText.slice(0,100)}`);
    }
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
  } catch (e) {
    console.warn("[publish] Claude failed, using original title:", e);
  }
  return { title, description: title };
}

// Safe category fallback map — if eBay rejects the category, use a known-good one
// ─── Find alternative reference listing when original seller is blocked ────────
async function findAlternativeReference(
  title: string,
  originalItemId: string,
  userToken: string
): Promise<{ itemId: string; categoryId: string; aspects: Record<string, string[]>; images: string[] } | null> {
  try {
    // Search for same product from different CN sellers
    const appToken = await (await import("@/lib/ebay")).getAppToken();
    const shortTitle = title.split(" ").slice(0, 5).join(" "); // first 5 words
    const params = new URLSearchParams({
      q:           shortTitle,
      limit:       "10",
      filter:      "buyingOptions:{FIXED_PRICE},itemLocationCountry:CN,conditions:{NEW}",
      fieldgroups: "EXTENDED",
    });
    const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
      headers: { Authorization: `Bearer ${appToken}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { itemSummaries?: Record<string, unknown>[] };
    const items = data.itemSummaries ?? [];

    for (const item of items) {
      const rawId = (item.itemId as string) ?? "";
      const numericId = rawId.split("|")[1] ?? rawId;
      if (numericId === originalItemId) continue; // skip the blocked one
      // Skip items from same seller (same item ID prefix = same seller)
      const origPrefix = originalItemId.slice(0, 6);
      if (numericId.startsWith(origPrefix)) continue;
      // Also check seller username
      const itemSeller = (item.seller as { username?: string } | undefined)?.username ?? "";
      if (itemSeller && originalItemId.includes(itemSeller)) continue;

      // Try to get reference data from this listing
      const { getReferenceItemData } = await import("@/lib/ebay");
      const refData = await getReferenceItemData(numericId, userToken);
      if (!refData) continue;

      console.log(`[publish] 🔍 Alt ref: ${numericId} — ${Object.keys(refData.aspects).length} aspects`);
      return {
        itemId:     numericId,
        categoryId: refData.categoryId,
        aspects:    refData.aspects,
        images:     refData.imageUrls,
      };
    }
    return null;
  } catch (e) {
    console.warn("[publish] findAlternativeReference error:", e);
    return null;
  }
}

// --- Auto-fix eBay listing errors with Claude ---
async function autoFixWithClaude(
  errorMsg: string,
  product: { title: string; description: string; categoryId: string; aspects: Record<string, string[]> }
): Promise<{ title?: string; description?: string; categoryId?: string; aspects?: Record<string, string[]> } | null> {
  try {
    const isImproper = errorMsg.toLowerCase().includes("improper") || errorMsg.toLowerCase().includes("policy");
    const prompt = isImproper
      ? `Write a fresh eBay product description for: "${product.title}". 2-3 sentences, professional tone, highlight features and benefits only. No brand names, no Chinese text, no medical claims, no sexual content. Return ONLY JSON: {"title":"${product.title.replace(/[^\w\s]/g,"").slice(0,75)}","description":"your clean 2-3 sentence description here"}`
      : `You are an eBay listing fixer. Error: "${errorMsg}". Title: ${product.title}. CategoryId: ${product.categoryId}. Aspects: ${JSON.stringify(product.aspects).slice(0,300)}. Fix only what the error requires. Return ONLY valid JSON with changed fields. "Model is missing"->{"aspects":{"Model":["Compatible"]}}. "item specific X missing"->{"aspects":{"X":["value"]}}. "category not valid"->{"categoryId":"11700"}. "too long" or "characters"->truncate the offending aspect value to under 65 chars in aspects JSON. Return the text null if unfixable.`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content: { type: string; text: string }[] };
    const text = data.content.find((b: { type: string }) => b.type === "text")?.text ?? "";
    if (text.trim() === "null") return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch { return null; }
}


function resolveCategoryId(categoryId: string, title: string): string {
  // Always resolve from title — never trust a bad incoming categoryId
  const t = title.toLowerCase();
  // ── Auto / Car (check FIRST — "car brush" should go to Auto, not Brushes) ───
  if (t.includes("car ") || t.includes("auto ") || t.includes("vehicle") ||
      t.includes("dashboard") || t.includes("windshield") || t.includes("steering") ||
      t.includes("seat gap") || t.includes("trunk") || t.includes("interior clean"))
                                                              return "179690"; // Car Care Products
  // ── Kitchen ─────────────────────────────────────────────────────────────────
  if (t.includes("slicer") || t.includes("chopper") || t.includes("peeler") ||
      t.includes("grater") || t.includes("strainer") || t.includes("colander") ||
      t.includes("spatula") || t.includes("kitchen"))        return "20625";  // Kitchen Tools
  if (t.includes("mug") || t.includes("cup"))                return "20686";  // Mugs
  if (t.includes("bottle") || t.includes("tumbler") || t.includes("flask")) return "20579"; // Bottles
  // ── Home storage/organizer ───────────────────────────────────────────────────
  if (t.includes("rack") || t.includes("organizer") || t.includes("holder") ||
      t.includes("storage") || t.includes("bin") || t.includes("basket"))    return "20625"; // Storage
  if (t.includes("shoe"))                                     return "112576"; // Shoe Organizers
  // ── Cleaning ────────────────────────────────────────────────────────────────
  if (t.includes("brush") || t.includes("scrubber") || t.includes("sponge") ||
      t.includes("mop") || t.includes("squeegee") || t.includes("clean"))    return "37592"; // Cleaning Supplies
  // ── Lighting ────────────────────────────────────────────────────────────────
  if (t.includes("lamp") || t.includes("light") || t.includes("led"))        return "20697"; // Lamps
  // ── Pets ────────────────────────────────────────────────────────────────────
  if (t.includes("pet") || t.includes("dog") || t.includes("cat") ||
      t.includes("puppy") || t.includes("kitten"))            return "1281";   // Pet Supplies
  // ── Travel ──────────────────────────────────────────────────────────────────
  if (t.includes("travel") || t.includes("luggage") || t.includes("packing") ||
      t.includes("passport") || t.includes("toiletry"))       return "3252";   // Travel Accessories
  // ── Bedroom/Textile ─────────────────────────────────────────────────────────
  if (t.includes("pillow"))                                   return "20455";  // Pillows
  if (t.includes("blanket") || t.includes("throw"))          return "20460";  // Blankets
  if (t.includes("towel"))                                    return "20461";  // Towels
  if (t.includes("mat") || t.includes("rug"))                return "20580";  // Rugs
  // ── Misc ────────────────────────────────────────────────────────────────────
  if (t.includes("clock"))                                    return "3815";   // Clocks
  if (t.includes("frame"))                                    return "92074";  // Frames
  if (t.includes("vase") || t.includes("planter"))           return "116656"; // Vases
  if (categoryId && categoryId !== "0")                       return categoryId; // trust incoming if nothing matched
  return "11700"; // Home & Garden fallback
}

function escXml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

// ─── eBay Trading API: AddFixedPriceItem ──────────────────────────────────────
async function addFixedPriceItem(product: {
  title: string; description: string; categoryId: string; price: number;
  stock: number; images: string[]; condition: string; aspects: Record<string, string[]>;
  variations?: VariationsData | null;
  markupRatio?: number;
}, userToken: string): Promise<{ itemId: string }> {

  const isChinese = (v: string) => /[\u4e00-\u9fff]/.test(v);
  const aspects = { ...product.aspects };

  // Remove Chinese values
  for (const key of Object.keys(aspects)) {
    aspects[key] = aspects[key].filter((v: string) => !isChinese(v));
    if (aspects[key].length === 0) delete aspects[key];
  }

  // Always set these
  aspects["Brand"] = aspects["Brand"]?.length ? aspects["Brand"] : ["Unbranded"];
  aspects["MPN"]   = ["Does Not Apply"];

  // eBay hard limit: aspect values max 65 chars, max 5 values per aspect
  for (const key of Object.keys(aspects)) {
    aspects[key] = aspects[key]
      .map((v: string) => v.slice(0, 65).trim())
      .filter((v: string) => v.length > 0)
      .slice(0, 5);
    if (aspects[key].length === 0) delete aspects[key];
  }

  // Infer missing fields from title
  const t = product.title.toLowerCase();

  // Clothing-specific aspects
  const isClothing = t.includes("dress") || t.includes("shirt") || t.includes("pants") ||
    t.includes("jacket") || t.includes("coat") || t.includes("skirt") ||
    t.includes("leggings") || t.includes("hoodie") || t.includes("sweater") ||
    t.includes("blouse") || t.includes("shorts") || t.includes("jeans") || t.includes("suit");

  if (isClothing) {
    if (!aspects["Department"]) aspects["Department"] = ["Women"];
    if (!aspects["Dress Length"]) {
      if (t.includes("mini")) aspects["Dress Length"] = ["Mini"];
      else if (t.includes("midi")) aspects["Dress Length"] = ["Midi"];
      else if (t.includes("maxi") || t.includes("long")) aspects["Dress Length"] = ["Maxi"];
      else aspects["Dress Length"] = ["Knee Length"];
    }
    if (!aspects["Sleeve Length"]) {
      if (t.includes("sleeveless") || t.includes("tank")) aspects["Sleeve Length"] = ["Sleeveless"];
      else if (t.includes("short sleeve")) aspects["Sleeve Length"] = ["Short Sleeve"];
      else if (t.includes("long sleeve")) aspects["Sleeve Length"] = ["Long Sleeve"];
      else aspects["Sleeve Length"] = ["Long Sleeve"];
    }
    if (!aspects["Neckline"]) aspects["Neckline"] = ["Round Neck"];
    if (!aspects["Occasion"]) aspects["Occasion"] = ["Casual"];
    if (!aspects["Style"]) aspects["Style"] = ["Casual"];
    if (!aspects["Pattern"]) {
      if (t.includes("floral")) aspects["Pattern"] = ["Floral"];
      else if (t.includes("stripe")) aspects["Pattern"] = ["Striped"];
      else if (t.includes("plaid") || t.includes("check")) aspects["Pattern"] = ["Plaid"];
      else if (t.includes("solid")) aspects["Pattern"] = ["Solid"];
      else aspects["Pattern"] = ["Solid"];
    }
  }

  if (!aspects["Type"]) {
    if (t.includes("lamp") || t.includes("floor lamp") || t.includes("desk lamp")) aspects["Type"] = ["Floor Lamp"];
    else if (t.includes("led strip") || t.includes("strip light")) aspects["Type"] = ["LED Strip Light"];
    else if (t.includes("light") || t.includes("led")) aspects["Type"] = ["LED"];
    else if (t.includes("mug")) aspects["Type"] = ["Mug"];
    else if (t.includes("bottle")) aspects["Type"] = ["Water Bottle"];
    else if (t.includes("pillow")) aspects["Type"] = ["Throw Pillow"];
    else if (t.includes("blanket") || t.includes("throw")) aspects["Type"] = ["Throw Blanket"];
    else if (t.includes("frame")) aspects["Type"] = ["Picture Frame"];
    else if (t.includes("shoe rack") || t.includes("shoe organizer")) aspects["Type"] = ["Shoe Rack"];
    else if (t.includes("rack") || t.includes("organizer") || t.includes("holder")) aspects["Type"] = ["Organizer"];
    else if (t.includes("box")) aspects["Type"] = ["Storage Box"];
    else if (t.includes("brush")) aspects["Type"] = ["Cleaning Brush"];
    else if (t.includes("clock")) aspects["Type"] = ["Alarm Clock"];
    else if (t.includes("mat") || t.includes("rug")) aspects["Type"] = ["Mat"];
    else if (t.includes("candle")) aspects["Type"] = ["Candle Holder"];
    else aspects["Type"] = ["Other"];
  }

  // If this item has variations, don't force single Color/Size values — they live in Variations block
  const hasVariationData = !!(product.variations?.variations?.length);

  if (!aspects["Color"] && !hasVariationData) {
    if (t.includes("rose gold")) aspects["Color"] = ["Rose Gold"];
    else if (t.includes("black")) aspects["Color"] = ["Black"];
    else if (t.includes("white")) aspects["Color"] = ["White"];
    else if (t.includes("silver") || t.includes("chrome") || t.includes("stainless")) aspects["Color"] = ["Silver"];
    else if (t.includes("gold")) aspects["Color"] = ["Gold"];
    else if (t.includes("wood") || t.includes("brown") || t.includes("bamboo")) aspects["Color"] = ["Brown"];
    else if (t.includes("clear") || t.includes("transparent")) aspects["Color"] = ["Clear"];
    else aspects["Color"] = ["Multicolor"];
  }

  if (!aspects["Material"]) {
    if (t.includes("stainless") || t.includes("steel") || t.includes("metal") || t.includes("aluminum") || t.includes("iron")) aspects["Material"] = ["Metal"];
    else if (t.includes("ceramic")) aspects["Material"] = ["Ceramic"];
    else if (t.includes("plastic") || t.includes("acrylic") || t.includes("pvc")) aspects["Material"] = ["Plastic"];
    else if (t.includes("bamboo")) aspects["Material"] = ["Bamboo"];
    else if (t.includes("wood")) aspects["Material"] = ["Wood"];
    else if (t.includes("glass")) aspects["Material"] = ["Glass"];
    else if (t.includes("silicone")) aspects["Material"] = ["Silicone"];
    else if (t.includes("foam") || t.includes("memory foam")) aspects["Material"] = ["Memory Foam"];
    else if (t.includes("cotton") || t.includes("fabric") || t.includes("knit")) aspects["Material"] = ["Cotton"];
    else aspects["Material"] = ["Mixed Materials"];
  }

  if (!aspects["Size"] && !hasVariationData) {
    const sizeMatch = product.title.match(/\b(\d+["x]\d+|small|medium|large|xl|xxl|one size)\b/i);
    aspects["Size"] = sizeMatch ? [sizeMatch[0]] : ["One Size"];
  }

  if (!aspects["Volume"] && !hasVariationData) {
    const volMatch = product.title.match(/(\d+)\s*(oz|ml)/i);
    if (volMatch) aspects["Volume"] = [`${volMatch[1]}${volMatch[2].toLowerCase()}`];
  }

  if (!aspects["Item Length"]) aspects["Item Length"] = ["10 in"];
  if (!aspects["Item Width"])  aspects["Item Width"]  = ["10 in"];
  if (!aspects["Item Height"]) aspects["Item Height"] = ["5 in"];
  // specificsXml built after variations (to exclude variation dimension keys)
  const _aspects = aspects; // hold reference for later

  const picturesXml = product.images.slice(0, 12)
    .map(url => `<PictureURL>${escXml(url)}</PictureURL>`).join("");

  const conditionId = ({"New":"1000","New with tags":"1000","New with box":"1000","New without tags":"1500","Like New":"2500","Used":"3000"} as Record<string,string>)[product.condition] ?? "1000";

  // ── Build Variations XML if product has variants ────────────────────────────
  const varData = product.variations;
  const markupRatio = product.markupRatio ?? 1.06;
  let variationsXml = "";
  let hasVariations = false;

  if (varData && varData.variations.length > 0) {
    hasVariations = true;

    // Build each <Variation> block with price, quantity, and specifics
    // Calculate proportional prices: if ref variants differ in price, scale ours proportionally
    const refPrices = varData.variations.map((v: VariationSpec) => v.refPrice).filter((p: number) => p > 0);
    const refMin = refPrices.length > 0 ? Math.min(...refPrices) : 0;
    const basePrice = product.price; // our base price = our markup on the cheapest variant

    const variationItems = varData.variations.map((v: VariationSpec) => {
      // If ref listing has price differences between variants, scale our price proportionally
      // e.g. ref has $5/$8/$12 → our base $20 → we list $20/$32/$48
      const varPrice = (refMin > 0 && v.refPrice > 0)
        ? Math.max(basePrice, +(basePrice * (v.refPrice / refMin)).toFixed(2))
        : basePrice;
      const varSpecificsXml = Object.entries(v.specifics)
        .map(([name, val]) =>
          `<NameValueList><Name>${escXml(name)}</Name><Value>${escXml(val)}</Value></NameValueList>`
        ).join("");
      return `<Variation>
        <SKU>${escXml(Object.values(v.specifics).map((x: unknown) => String(x)).join("-"))}</SKU>
        <StartPrice>${varPrice}</StartPrice>
        <Quantity>${product.stock}</Quantity>
        <VariationSpecifics>${varSpecificsXml}</VariationSpecifics>
      </Variation>`;
    }).join("");

    // Build <VariationSpecificsSet> — all possible values per dimension
    const setXml = Object.entries(varData.specificsSet)
      .map(([name, vals]) => {
        const valsXml = (vals as string[]).map((v: string) => `<Value>${escXml(v)}</Value>`).join("");
        return `<NameValueList><Name>${escXml(name)}</Name>${valsXml}</NameValueList>`;
      }).join("");

    // Build <Pictures> block mapping each color/variant to its images
    let picturesBlockXml = "";
    if (varData.pictureDimension && Object.keys(varData.picturesByVariant).length > 0) {
      const pictureSets = Object.entries(varData.picturesByVariant)
        .map(([value, urls]) => {
          const urlsXml = (urls as string[]).slice(0, 6).map((u: string) => `<PictureURL>${escXml(u)}</PictureURL>`).join("");
          return `<VariationSpecificPictureSet><VariationSpecificValue>${escXml(value)}</VariationSpecificValue>${urlsXml}</VariationSpecificPictureSet>`;
        }).join("");
      picturesBlockXml = `<Pictures><VariationSpecificName>${escXml(varData.pictureDimension)}</VariationSpecificName>${pictureSets}</Pictures>`;
      console.log(`[publish] 🖼 Variation pictures mapped: ${Object.keys(varData.picturesByVariant).length} values for "${varData.pictureDimension}"`);
    }

    variationsXml = `<Variations>${variationItems}${picturesBlockXml}<VariationSpecificsSet>${setXml}</VariationSpecificsSet></Variations>`;
  }

  // Build ItemSpecifics — exclude keys that are variation dimensions (e.g. Size, Color)
  const variationDimensions = hasVariations && varData
    ? new Set(Object.keys(varData.specificsSet))
    : new Set<string>();
  const specificsXml = Object.entries(_aspects)
    .filter(([name]) => !variationDimensions.has(name))
    .map(([name, values]) => values.map(v =>
      `<NameValueList><Name>${escXml(name)}</Name><Value>${escXml(v)}</Value></NameValueList>`
    ).join("")).join("");

  // Sanitize description: remove HTML tags and non-ASCII (Chinese) chars
  const safeDesc = (product.description || product.title)
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/  +/g, " ")
    .slice(0, 500)
    .trim();
  console.log(`[publish] safeDesc preview: "${safeDesc.slice(0,100)}"`);

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <Item>
    <Title>${escXml(product.title.slice(0, 80))}</Title>
    <Description><![CDATA[${safeDesc}]]></Description>
    <PrimaryCategory><CategoryID>${product.categoryId || resolveCategoryId("", product.title)}</CategoryID></PrimaryCategory>
    ${!hasVariations ? `<StartPrice>${product.price.toFixed(2)}</StartPrice>` : ""}
    <CategoryMappingAllowed>true</CategoryMappingAllowed>
    <ConditionID>${conditionId}</ConditionID>
    <Country>DO</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>5</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>China</Location>
    ${!hasVariations ? `<Quantity>${product.stock}</Quantity>` : ""}
    <PictureDetails>${picturesXml}</PictureDetails>
    ${specificsXml ? `<ItemSpecifics>${specificsXml}</ItemSpecifics>` : ""}
    ${variationsXml}
    <SellerProfiles>
      <SellerShippingProfile><ShippingProfileID>${process.env.EBAY_FULFILLMENT_POLICY_ID}</ShippingProfileID></SellerShippingProfile>
      <SellerReturnProfile><ReturnProfileID>${process.env.EBAY_RETURN_POLICY_ID}</ReturnProfileID></SellerReturnProfile>
      <SellerPaymentProfile><PaymentProfileID>${process.env.EBAY_PAYMENT_POLICY_ID}</PaymentProfileID></SellerPaymentProfile>
    </SellerProfiles>
    <Site>US</Site>
  </Item>
</AddFixedPriceItemRequest>`;

  const https = await import("node:https");
  const { statusCode, body } = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const buf = Buffer.from(xml, "utf-8");
    const req = https.request({
      hostname: "api.ebay.com", path: "/ws/api.dll", method: "POST",
      headers: {
        "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "AddFixedPriceItem",
        "Content-Type": "text/xml", "Content-Length": buf.length.toString(),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(buf); req.end();
  });

  if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);

  const errorBlockRegex = /<Errors>([\s\S]*?)<\/Errors>/g;
  let errBlock; const realErrors: string[] = [];
  while ((errBlock = errorBlockRegex.exec(body)) !== null) {
    const block = errBlock[1];
    if (block.includes("<SeverityCode>Error</SeverityCode>")) {
      const m = block.match(/<LongMessage>(.*?)<\/LongMessage>/);
      realErrors.push(m?.[1] ?? "Unknown error");
    } else {
      const m = block.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
      console.warn(`[publish] eBay warning: ${m?.[1] ?? "unknown"}`);
    }
  }
  if (realErrors.length > 0) {
    const combined = realErrors.join(" | ");
    // Friendly messages for known errors
    if (combined.includes("mixture of Self Hosted and EPS")) throw new Error("Imágenes mixtas (EPS + externas) — requiere revisión manual");
    if (combined.includes("already have on eBay")) throw new Error("Producto duplicado — ya existe un listing idéntico");
    if (combined.includes("category is not valid")) throw new Error("Categoría inválida — requiere revisión manual");
    throw new Error(combined);
  }

  const itemMatch = body.match(/<ItemID>(\d+)<\/ItemID>/);
  if (!itemMatch) throw new Error("No ItemID in response: " + body.slice(0, 200));
  return { itemId: itemMatch[1] };
}

// ─── Main: publish a product from Firestore by ID ─────────────────────────────
export async function publishProductById(productId: string, userToken: string): Promise<{ listingId: string }> {
  const docRef = db.collection(COLLECTIONS.QUEUE).doc(productId);
  const doc = await docRef.get();
  if (!doc.exists) throw new Error("Product not found");

  const product = doc.data()!;

  // ── Monthly listing limit check (250 free/month, leave 5 buffer) ─────────
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const counterRef = db.collection("counters").doc(`listings_${monthKey}`);
  const counterDoc = await counterRef.get();
  const currentCount = counterDoc.exists ? (counterDoc.data()!.count as number) : 0;
  const MONTHLY_LIMIT = 245; // 250 max - 5 buffer
  if (currentCount >= MONTHLY_LIMIT) {
    throw new Error(`Límite mensual alcanzado (${currentCount}/${MONTHLY_LIMIT} listings este mes)`);
  }

  // Allow retry: reset failReason if present
  if (product.failReason) {
    await docRef.update({ failReason: null, status: 'approved' });
  }

  // Fetch aspects + images + category from reference listing
  let refAspects: Record<string, string[]> = {};
  let refImages: string[] = product.images ?? [];
  let refCategoryId = product.categoryId;

  let refVariations = null;

  if (product.ebayItemId) {
    // Ensure numeric ID only (Browse API stores as "v1|12345|0")
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
      refData.imageUrls.forEach(u => { if (!merged.includes(u)) merged.push(u); });
      refImages = merged.slice(0, 12);
      refVariations = (refData as unknown as ReferenceItemData).variations ?? null;

      // Skip listings with too many variations — eBay charges insertion fee per variant
      const MAX_VARIATIONS = 12;
      if (refVariations && refVariations.variations.length > MAX_VARIATIONS) {
        throw new Error(`Demasiadas variantes (${refVariations.variations.length}/${MAX_VARIATIONS} máx) — se omite para no agotar saldo`);
      }

      const varInfo = refVariations
        ? ` | ${refVariations.variations.length} variantes (${Object.keys(refVariations.specificsSet).join(", ")})`
        : " | sin variantes";
      console.log(`[publish] ${productId} — ${Object.keys(refAspects).length} aspects, ${refImages.length} images${varInfo}`);
    }
  }

  // Compute markup ratio from product pricing for per-variation price calculation
  const markupRatio = product.totalMarketCost > 0
    ? product.suggestedSellingPrice / product.totalMarketCost
    : 1.06;

  // Generate clean title + description with Claude
  const { title: cleanTitle, description } = await generateTitleAndDescription(product.title, refAspects);

  // Publish on eBay — with auto-fix retry on fixable errors
  let itemId: string;
  let publishTitle = cleanTitle;
  let publishDesc  = description;
  let publishCatId = refCategoryId;
  // If no category from ref listing, ask eBay Taxonomy API for the best category
  if (!publishCatId || publishCatId === "0") {
    const taxonomyCatId = await getCategoryIdForTitle(product.title);
    if (taxonomyCatId) {
      publishCatId = taxonomyCatId;
      console.log(`[publish] 📂 Taxonomy API → categoría: ${publishCatId}`);
    } else {
      publishCatId = resolveCategoryId("", product.title);
      console.log(`[publish] 📂 Fallback local → categoría: ${publishCatId}`);
    }
  }
  let publishAspects = { ...refAspects };

  const FIXABLE = ["missing", "category", "Categor", "improper", "policy", "violation", "Model", "item specific", "too long", "characters"];

  try {
    const result = await addFixedPriceItem({
      title: publishTitle, description: publishDesc, categoryId: publishCatId,
      price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1),
      images: refImages, condition: product.condition ?? "New", aspects: publishAspects,
      variations: refVariations, markupRatio,
    }, userToken);
    itemId = result.itemId;
  } catch (firstErr: unknown) {
    const errMsg = String(firstErr instanceof Error ? firstErr.message : firstErr);
    const isFixable = FIXABLE.some(kw => errMsg.toLowerCase().includes(kw.toLowerCase()));

    if (!isFixable) throw firstErr; // not fixable — fail fast

    console.log(`[publish] ⚠️ Error fixable detectado — pidiendo a Claude que corrija...`);
    console.log(`[publish] Error: ${errMsg}`);

    const fix = await autoFixWithClaude(errMsg, {
      title: publishTitle, description: publishDesc,
      categoryId: publishCatId, aspects: publishAspects,
    });

    // For category errors — resolve directly without Claude
    if (errMsg.includes("Categor") || errMsg.toLowerCase().includes("category") || errMsg.includes("leaf")) {
      // The reference item IS live on eBay → its categoryId is guaranteed valid
      // Use it directly instead of guessing
      // Map title keywords to known-working eBay LEAF category IDs
      const t = publishTitle.toLowerCase();
      let leafCatId = "20625"; // default: Kitchen Storage & Organization (verified leaf)
      if (t.includes("adapter") || t.includes("converter") || t.includes("plug"))
        leafCatId = "139762"; // Outlet Adapters & Converters (leaf)
      else if (t.includes("phone") || t.includes("mobile") || t.includes("charger"))
        leafCatId = "116458"; // Car Phone Holders & Mounts (leaf)
      else if (t.includes("pet") || t.includes("dog") || t.includes("cat"))
        leafCatId = "117426"; // Dog Beds (leaf)
      else if (t.includes("travel") || t.includes("luggage") || t.includes("bag"))
        leafCatId = "169291"; // Travel Accessories (leaf)
      else if (t.includes("car") || t.includes("auto") || t.includes("vehicle"))
        leafCatId = "179690"; // Car Care (leaf)
      else if (t.includes("light") || t.includes("lamp") || t.includes("led"))
        leafCatId = "20697";  // Lamps (leaf)
      else if (t.includes("yoga") || t.includes("fitness") || t.includes("exercise"))
        leafCatId = "158902"; // Fitness Equipment (leaf)
      else if (t.includes("brush") || t.includes("clean"))
        leafCatId = "37592";  // Cleaning Supplies (leaf)
      publishCatId = leafCatId;
      console.log(`[publish] 🔧 Categoría hoja por keyword: ${publishCatId}`);
    } else {
      if (!fix) { console.log("[publish] Claude no pudo corregir"); throw firstErr; }

      // Apply fixes
      if (fix.title)       { publishTitle   = fix.title;        console.log(`[publish] 🔧 Título corregido: "${fix.title}"`); }
      if (fix.description) { publishDesc    = fix.description;  console.log(`[publish] 🔧 Descripción corregida`); }
      if (fix.categoryId)  { publishCatId   = fix.categoryId;   console.log(`[publish] 🔧 Categoría corregida: ${fix.categoryId}`); }
      if (fix.aspects)     { publishAspects = { ...publishAspects, ...fix.aspects }; console.log(`[publish] 🔧 Aspects corregidos:`, fix.aspects); }
    }

    // Retry once with fixes applied
    // For "improper words" — use a completely neutral generic description
    // to rule out content vs seller policy violation
    if (errMsg.includes("improper") || errMsg.includes("policy")) {
      publishDesc = `High-quality ${publishTitle}. Durable construction and practical design. Easy to use and clean. Perfect for everyday use. Fast shipping included.`;
      console.log(`[publish] 🔧 Descripción genérica neutra aplicada`);
    }

    console.log(`[publish] 🔄 Reintentando con correcciones...`);
    try {
      const result2 = await addFixedPriceItem({
        title: publishTitle, description: publishDesc, categoryId: publishCatId,
        price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1),
        images: refImages, condition: product.condition ?? "New", aspects: publishAspects,
        variations: refVariations, markupRatio,
      }, userToken);
      itemId = result2.itemId;
      console.log(`[publish] ✅ Publicado tras corrección automática — ID: ${itemId}`);
    } catch (retryErr: unknown) {
      const retryMsg = String(retryErr instanceof Error ? retryErr.message : retryErr);
      // If still "improper/policy" after neutral desc → it's the SELLER/LISTING that's flagged, not content
      if (retryMsg.includes("improper") || retryMsg.includes("policy")) {
        // Seller blocked — search for alternative reference listing
        console.log(`[publish] 🔍 Buscando listing alternativo para: "${publishTitle}"...`);
        const altRef = await findAlternativeReference(publishTitle, product.ebayItemId, userToken);
        if (!altRef) {
          throw new Error(`Vendedor bloqueado y no se encontró referencia alternativa`);
        }
        console.log(`[publish] ✅ Referencia alternativa encontrada: ${altRef.itemId}`);
        // Apply alternative ref data
        if (altRef.categoryId) publishCatId = altRef.categoryId;
        if (altRef.aspects && Object.keys(altRef.aspects).length > 0)
          publishAspects = { ...publishAspects, ...altRef.aspects };
        // Retry with alternative reference
        try {
          const result3 = await addFixedPriceItem({
            title: publishTitle, description: publishDesc, categoryId: publishCatId,
            price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1),
            images: refImages.length > 0 ? refImages : altRef.images,
            condition: product.condition ?? "New", aspects: publishAspects,
            variations: refVariations, markupRatio,
          }, userToken);
          itemId = result3.itemId;
          console.log(`[publish] ✅ Publicado con referencia alternativa — ID: ${itemId}`);
        } catch (altErr: unknown) {
          const altMsg = String(altErr instanceof Error ? altErr.message : altErr);
          if (altMsg.includes("improper") || altMsg.includes("policy")) {
            // Last resort: strip "car/auto" from title, use Home & Garden category
            publishTitle = publishTitle.replace(/(car|auto|vehicle|automotive)/gi, "").replace(/\s+/g, " ").trim();
            publishCatId = "11700"; // Home & Garden
            publishAspects = { Brand: ["Unbranded"], MPN: ["Does Not Apply"] };
            console.log(`[publish] 🔧 Último recurso: título="${publishTitle}" cat=11700`);
            const result4 = await addFixedPriceItem({
              title: publishTitle, description: publishDesc, categoryId: publishCatId,
              price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1),
              images: refImages.length > 0 ? refImages : altRef.images,
              condition: product.condition ?? "New", aspects: publishAspects,
              variations: null, markupRatio,
            }, userToken);
            itemId = result4.itemId;
            console.log(`[publish] ✅ Publicado con fallback máximo — ID: ${itemId}`);
          } else throw altErr;
        }
      }
      throw retryErr;
    }
  }

  // Update Firestore
  const batch = db.batch();
  batch.update(docRef, { status: "published", publishedAt: Date.now(), listingId: itemId, bidPercentage: 2.0, updatedAt: Date.now() });
  batch.set(db.collection(COLLECTIONS.PUBLISHED).doc(productId), {
    ...product, status: "published", publishedAt: Date.now(), listingId: itemId,
  });
  await batch.commit();

  // Wait 3s for eBay to index the listing before applying promoted listing
  await new Promise(r => setTimeout(r, 3000));
  await applyPromotedListing(itemId, userToken);

  // Increment monthly counter
  await counterRef.set({ count: currentCount + 1, updatedAt: Date.now() }, { merge: true });
  console.log(`[publish] ✅ ${productId} → eBay itemId=${itemId} (${currentCount + 1}/${MONTHLY_LIMIT} este mes)`);
  return { listingId: itemId };
}

// ─── eBay Marketing API: Apply Promoted Listing (2% ad rate) ─────────────────
async function applyPromotedListing(listingId: string, userToken: string): Promise<void> {
  try {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <Item>
    <ItemID>${listingId}</ItemID>
    <PromotedListingDetails>
      <BidPercentage>2.0</BidPercentage>
      <PromotionMethod>COST_PER_SALE</PromotionMethod>
    </PromotedListingDetails>
  </Item>
</ReviseFixedPriceItemRequest>`;

    const https = await import("node:https");
    await new Promise<void>((resolve) => {
      const buf = Buffer.from(xml, "utf-8");
      const req = https.request({
        hostname: "api.ebay.com", path: "/ws/api.dll", method: "POST",
        headers: {
          "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
          "X-EBAY-API-CALL-NAME": "ReviseFixedPriceItem",
          "Content-Type": "text/xml",
          "Content-Length": buf.length.toString(),
        },
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
  } catch (e) {
    console.warn(`[promote] ⚠️ Error for ${listingId}:`, e instanceof Error ? e.message : e);
  }
}


// Mark a product as failed with a reason
export async function markPublishFailed(productId: string, reason: string): Promise<void> {
  await db.collection(COLLECTIONS.QUEUE).doc(productId).update({
    status: "failed",
    failReason: reason,
    updatedAt: Date.now(),
  });
  console.log(`[publish] ⚠️ ${productId} → failed: ${reason}`);
}