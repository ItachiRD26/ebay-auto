import { db, COLLECTIONS } from "@/lib/firebase";
import { getReferenceItemData } from "@/lib/ebay";

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
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`Claude API ${res.status}`);
    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() ?? "";
    const clean = raw.replace(/^```json[\s\S]*?```$|^```[\s\S]*?```$/gm, "").trim();
    // Find JSON object in response (Claude sometimes adds extra text)
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in Claude response");
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
function resolveCategoryId(categoryId: string, title: string): string {
  if (categoryId) return categoryId;
  const t = title.toLowerCase();
  if (t.includes("lamp") || t.includes("light") || t.includes("led")) return "20697";    // Lamps
  if (t.includes("mug") || t.includes("cup")) return "20686";                             // Mugs
  if (t.includes("bottle") || t.includes("tumbler") || t.includes("flask")) return "20579"; // Bottles
  if (t.includes("clock")) return "3815";                                                  // Clocks
  if (t.includes("pillow")) return "20455";                                                // Pillows
  if (t.includes("blanket") || t.includes("throw")) return "20460";                       // Blankets
  if (t.includes("frame")) return "92074";                                                 // Frames
  if (t.includes("rack") || t.includes("organizer")) return "20625";                      // Storage
  if (t.includes("shoe")) return "112576";                                                 // Shoe Organizers
  if (t.includes("brush")) return "13093";                                                 // Brushes
  if (t.includes("mat") || t.includes("rug")) return "20580";                             // Rugs
  if (t.includes("towel")) return "20461";                                                 // Towels
  return "11700";                                                                          // Home & Garden (generic)
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

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <Item>
    <Title>${escXml(product.title.slice(0, 80))}</Title>
    <Description><![CDATA[${product.description}]]></Description>
    <PrimaryCategory><CategoryID>${resolveCategoryId(product.categoryId, product.title)}</CategoryID></PrimaryCategory>
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

  // Publish on eBay
  const { itemId } = await addFixedPriceItem({
    title: cleanTitle, description, categoryId: refCategoryId,
    price: product.suggestedSellingPrice, stock: Math.min(product.stock ?? 1, 1),
    images: refImages, condition: product.condition ?? "New", aspects: refAspects,
    variations: refVariations, markupRatio,
  }, userToken);

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