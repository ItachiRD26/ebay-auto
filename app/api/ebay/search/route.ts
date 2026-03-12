import { NextRequest, NextResponse } from "next/server";
import { searchProducts, getUserToken } from "@/lib/ebay";
import { db, COLLECTIONS } from "@/lib/firebase";
import { QueueProduct } from "@/types";
import { publishProductById, markPublishFailed } from "@/lib/publish";

// ─── Dropshipping config ──────────────────────────────────────────────────────
const CONFIG = {
  MIN_PRICE:          20,    // min eBay reference listing price
  MAX_PRICE:          250,   // max eBay reference listing price
  MIN_SOLD_TOTAL:     5,     // min total sales (all time) on reference listing
  MIN_SOLD_30D:       3,     // min estimated sales in last 30 days (activity filter)
  EPROLO_SHIP_LOW:    7,     // Eprolo min shipping cost ($)
  EPROLO_SHIP_HIGH:   15,    // Eprolo max shipping cost ($)
  EPROLO_SHIP_AVG:    10,    // Eprolo avg shipping — used when no Eprolo price yet
  STOCK:              1,
};

// ─── Keyword list for auto-search ────────────────────────────────────────────
const AUTO_KEYWORDS = [
  // Organization & Storage
  "caddy","canister","compartment","organizerbox","sorter","keeper","stash",
  "slot","holderrack","tier","layer","locker","cabinet","organizertray",
  "stacker","tote","cubby","pocket","carrier","wrapcase","keeperbox",

  // Home & Living
  "decor","ornament","accent","display","centerpiece","tabletop","backdrop",
  "panel","board","plaque","tile","strip","plate","paneling","liner",
  "overlay","insert","fixture","panelcover","trim","edging","border",

  // Mounting / Hardware
  "anchor","clamp","grip","latch","catch","pin","peg","loop","band",
  "strap","ring","bolt","stud","bar","rail","pole","rod","arm",
  "post","hinge","lock","cap","stopper","sealring","plug",

  // Kitchen & Household Tools
  "ladle","masher","crusher","skimmer","shaker","baster","dripper",
  "infuser","sprayer","spreader","pincer","stirrer","twister","flipper",
  "rollerpin","grinder","sifter","separator","breaker","twirl",

  // Containers & Drinkware
  "canteen","flask","pitcher","jug","decanter","thermos","kettle",
  "carafe","dispenserjar","drinkholder","beaker","minijar","pourer",

  // Cleaning & Maintenance
  "polisher","sweeper","lintroller","dustpan","cloth","wipe","rag",
  "absorber","refill","spraybottle","mistbottle","washer","rinser",

  // Bathroom / Utility
  "soapdish","soaptray","toothholder","cupholder","tissueholder",
  "toothcup","rinsecup","brushholder","paperholder","washbin",

  // Furniture / Home Accessories
  "footrest","armrest","headrest","seatpad","benchpad","linerpad",
  "chairpad","tablepad","protector","guard","edgeguard",

  // Misc useful product nouns
  "kit","set","bundle","pack","bundlepack","multi","combo",
  "portable","foldable","extendable","adjuster","adapter",
  "inserttray","dividertray","organizergrid","rackstand"
];

const EXCLUDED_KEYWORDS = [
  // Tech brands
  "iphone","samsung galaxy","apple watch","airpods","macbook","playstation","xbox",
  "nintendo switch","nvidia","radeon","graphics card","laptop","smart tv","ipad",
  // Fashion brands
  "nike","adidas","gucci","louis vuitton","supreme","yeezy","jordan","off-white",
  "balenciaga","versace","prada","dior","burberry","chanel","hermes","fendi","lululemon",
  "north face","under armour","new balance","reebok","vans","converse","timberland",
  // Water bottle brands
  "owala","stanley cup","hydro flask","yeti","contigo","nalgene","camelbak",
  // Anime
  "anime","manga","naruto","dragon ball","one piece","demon slayer","attack on titan","pokemon","waifu",
  "tony chopper","luffy","zoro","nami","sanji","nico robin","franky","brook","usopp",
  "playmat","playing mat","trading card game mat","tcg mat","ccg mat","card game mat",
  "opcg","tcg","ccg","yugioh","yu-gi-oh","magic the gathering","mtg","flesh and blood",
  "dragon shield","ultra pro","card sleeve","card mat","card game","board game mat",
  // Auto brands
  "mercedes","mercedes-benz","bmw","audi","porsche","ferrari","lamborghini","maserati",
  "ford","chevrolet","chevy","dodge","jeep","tesla","honda","toyota","nissan","hyundai",
  "volkswagen","volvo","lexus","infiniti","cadillac","buick","lincoln","ram truck",
  "subaru","mazda","mitsubishi","kia","acura","genesis","alfa romeo","bentley","rolls royce",
  // General brand protection
  "replica","counterfeit","fake","gun","firearm","ammo","ammunition","rifle","pistol",
  // Food & beverage brands
  "starbucks","nespresso","keurig","nescafe","lavazza","dunkin","red bull","monster energy",
  "coca cola","pepsi","heineken","corona","budweiser","jack daniels","johnnie walker",
  // Beauty consumables (creams, perfumes, deodorants — usually branded)
  "face cream","moisturizer","serum","perfume","cologne","deodorant","antiperspirant",
  "body lotion","body cream","sunscreen","spf","retinol","vitamin c cream","eye cream",
  "anti-aging","anti aging","wrinkle","dark spot","whitening cream","bleaching",
  "toner","essence","ampoule","bb cream","cc cream","foundation","concealer",
  "lipstick","lip gloss","eyeshadow","mascara","blush","highlighter","powder makeup",
  "hair dye","hair color","keratin","shampoo","conditioner","hair mask","hair oil",
  "body wash","shower gel","bath bomb","soap bar","hand cream","foot cream",
  // Electronics components & wiring
  "wire","cable","awg","stranded","insulated","pvc wire","coaxial","ethernet cable",
  "breadboard","arduino","raspberry pi","esp32","sensor","module","led strip driver",
  "battery pack","lithium","18650","charger module","buck converter","voltage",
  "oscilloscope","multimeter","soldering","flux","pcb board","prototype",
  // Toys & toy parts
  "toy","lego","action figure","doll","barbie","stuffed animal","toy car","toy gun",
  "toy part","toy accessory","playset","building block",
  // Adult / sexual
  "dildo","vibrator","sex toy","anal","butt plug","penis","enlargement","erection",
  "male enhancement","adult toy","lubricant","condom","lingerie",
  // Spare parts & electronics components
  "pump","diaphragm","impeller","valve","compressor","capacitor","resistor","transistor",
  "motherboard","circuit","pcb","ic chip","relay","solenoid","actuator","servo",
  "replacement part","spare part","repair kit","oem","aftermarket","compatible with",
  "for model","series part","assembly kit","wiring harness","fuse","transformer",
  "power supply","inverter","regulator","heat sink","thermal paste","solder",
  "connector","terminal","fitting","coupling","manifold","nozzle","gasket","seal",
  // Medical / personal health devices
  "catheter","incontinence","colostomy","stoma","dialysis","surgical",
  "hearing aid","cpap","nebulizer","syringe","insulin",
  "dental","dentist","orthodontic","tooth whitening","teeth whitening","mouthguard",
  "retainer","braces","aligner","whitening strips","dental bib","tooth paste","toothpaste",
  // Adult enhancement / sexual wellness devices
  "extender","traction device","stretcher penis","male enlarger","penis pump",
  "pro extender","apexdrive","apex drive","bigger growth","penile",
  "erectile","male enhancement device","cock ring","chastity",
  // Electronic massage devices & body stimulators
  "electric massager","massage gun","percussion massager","vibrating massager",
  "body massager","handheld massager","muscle massager","deep tissue massager",
  "tens unit","ems machine","muscle stimulator","electro stimulator",
  "infrared massager","heating massager","foot massager","neck massager",
  "back massager","eye massager","scalp massager electric","massage wand",
  // Medical & clinical
  "compression sleeve","medical grade","orthopedic","therapeutic","clinical",
  "blood pressure","pulse oximeter","glucose","ecg","ekg","stethoscope",
  "thermometer medical","wound care","bandage","splint","brace medical",
  // Skincare & cosmetic treatments (high return rate)
  "retinol","vitamin c serum","hyaluronic","niacinamide","peptide cream",
  "kojic acid","salicylic","glycolic","aha bha","chemical peel","microneedling",
  "derma roller","led face mask","microcurrent","rf skin","ultrasonic skin",
  "anti wrinkle device","skin tightening","photon therapy","collagen machine",
  "ipl hair removal","laser hair","epilation device","hair removal device",
  // Toy parts, upgrade kits, action figure accessories
  "upgrade kit","3d printed","head upgrade","weapon kit","arm upgrade","wing kit",
  "transformers","optimus prime","megatron","gundam","model kit","figure kit",
  "resin kit","conversion kit","add-on kit","parts kit","custom part",
  "injection molding","abs upgrade","pvc figure","diecast","figurine kit",
  "killing arm","onyx prime","ss86","age of the primes",
  // Food & Plants (cannot dropship)
  "food","snack","candy","chocolate","coffee beans","tea leaves","protein powder",
  "supplement","vitamin","seeds","plant","succulent","cactus","flower bouquet",
  "live plant","fruit","vegetable","edible","organic food","gummies","jerky",
  "spices","herbs","seasoning","powder drink","energy drink","juice",
];

// Auto-generated from EXCLUDED_KEYWORDS — checks title for any brand mention

function isBanned(title: string): boolean {
  const t = title.toLowerCase();
  return EXCLUDED_KEYWORDS.some((kw) => t.includes(kw.toLowerCase()));
}

function extractNumericId(browseItemId: string): string {
  const parts = browseItemId.split("|");
  return parts.length >= 2 ? parts[1] : browseItemId;
}

// ─── Shipping cost from Browse API item summary ───────────────────────────────
// Returns 0 for FREE shipping, otherwise the actual cost.
function getShippingCost(item: Record<string, unknown>): number {
  const options = item.shippingOptions as Array<{
    shippingCostType?: string;
    shippingCost?: { value?: string };
  }> | undefined;

  if (!options || options.length === 0) return 0;

  const first = options[0];
  // FREE shipping variants
  if (
    first.shippingCostType === "FREE" ||
    first.shippingCost?.value === "0.0" ||
    first.shippingCost?.value === "0.00" ||
    first.shippingCost?.value === "0"
  ) return 0;

  return parseFloat(first.shippingCost?.value ?? "0") || 0;
}

// ─── Smart pricing engine ─────────────────────────────────────────────────────
//
// Context:
//   - We are looking at a Chinese seller's eBay listing as our market reference.
//   - That listing has a price + optional shipping cost (totalMarketCost = what the
//     buyer actually pays).
//   - We will list the SAME product at FREE SHIPPING to be competitive.
//   - Our cost = eproloProductCost (unknown until Eprolo lookup) + eproloShipping ($7-$15).
//
// Goal: suggest a listing price that is competitive AND profitable.
//
// Strategy:
//   1. totalMarketCost = refPrice + refShipping  (the real market benchmark)
//   2. suggestedPrice  = totalMarketCost * competitiveFactor
//      - We use 0.97 (3% below market) to rank higher in eBay search.
//      - If totalMarketCost is already very low, we cap at a floor that ensures
//        we at least cover average Eprolo shipping ($10).
//   3. We also store priceFloor = refPrice + EPROLO_SHIP_AVG so that when the
//      Eprolo product price is fetched later, the UI can warn if we'd be at a loss.
//
interface PricingResult {
  ebayRefPrice:          number;  // raw listing price of the reference item
  ebayShippingCost:      number;  // shipping the reference seller charges (0 = free)
  totalMarketCost:       number;  // refPrice + refShipping = true buyer cost
  suggestedSellingPrice: number;  // our recommended listing price (FREE shipping)
  priceFloor:            number;  // minimum we should charge to cover Eprolo shipping
}

function calcPricing(item: Record<string, unknown>): PricingResult {
  const ebayRefPrice     = parseFloat((item.price as { value: string })?.value ?? "0");
  const ebayShippingCost = getShippingCost(item);
  const totalMarketCost  = ebayRefPrice + ebayShippingCost;

  // 6% markup over total market cost (covers eBay fees + margin)
  const suggestedSellingPrice = parseFloat((totalMarketCost * 1.06).toFixed(2));
  const priceFloor = CONFIG.EPROLO_SHIP_AVG + 2;
  return { ebayRefPrice, ebayShippingCost, totalMarketCost, suggestedSellingPrice, priceFloor };
}

// ─── Trading API + 30-day sales estimator ────────────────────────────────────
//
// eBay's public APIs don't expose "sold in last 30 days" directly.
// We approximate it using StartTime + QuantitySold from Trading API GetItem.
//
// The key insight: older listings accumulate sales over time, making raw
// velocity (total/months) an overestimate of CURRENT demand.
// We apply a decay factor for old listings to be conservative:
//
//   listing age   | decay factor | reasoning
//   < 90 days     | 1.00         | velocity IS recent, very reliable
//   90-180 days   | 0.80         | slight slowdown typical after initial burst
//   180-365 days  | 0.65         | many products peak early then plateau
//   1-2 years     | 0.50         | half-life assumption for commodity products
//   2+ years      | 0.35         | mostly long-tail residual sales
//
// estimatedSold30d = (soldCount / daysActive) * 30 * decayFactor
//
interface TradingItemData {
  soldCount:        number;
  estimatedSold30d: number;  // our best estimate of sales in last 30 days
  listingAgeDays:   number;
  shipFromCountry:  string | null;
}

let cachedUserToken: string | null = null;
let tokenFetchedAt = 0;

async function getItemDataViaTradingAPI(numericItemId: string): Promise<TradingItemData> {
  const empty: TradingItemData = { soldCount: 0, estimatedSold30d: 0, listingAgeDays: 0, shipFromCountry: null };

  try {
    if (!cachedUserToken || Date.now() - tokenFetchedAt > 60_000) {
      cachedUserToken = await getUserToken();
      tokenFetchedAt = Date.now();
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${cachedUserToken}</eBayAuthToken></RequesterCredentials>
  <ItemID>${numericItemId}</ItemID>
  <DetailLevel>ItemReturnDescription</DetailLevel>
</GetItemRequest>`;

    const res = await fetch("https://api.ebay.com/ws/api.dll", {
      method: "POST",
      headers: {
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetItem",
        "Content-Type": "text/xml",
      },
      body: xml,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`   [Trading] HTTP ${res.status} for ${numericItemId}`);
      return empty;
    }

    const text = await res.text();

    if (text.includes("<Ack>Failure</Ack>")) {
      const errMatch = text.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
      console.warn(`   [Trading] Error ${numericItemId}: ${errMatch?.[1] ?? "unknown"}`);
      return empty;
    }

    // ── QuantitySold ──────────────────────────────────────────────────────────
    const soldMatch = text.match(/<QuantitySold>(\d+)<\/QuantitySold>/);
    const soldCount = soldMatch ? parseInt(soldMatch[1], 10) : 0;

    // ── StartTime → listing age → 30-day estimate ─────────────────────────────
    const startMatch = text.match(/<StartTime>(.*?)<\/StartTime>/);
    let estimatedSold30d = soldCount; // fallback: no date → treat as brand new
    let listingAgeDays   = 0;

    if (startMatch) {
      const startDate    = new Date(startMatch[1]);
      listingAgeDays     = Math.max(1, (Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      const soldPerDay   = soldCount / listingAgeDays;

      // Decay factor: conservative estimate of current demand relative to average
      let decay = 1.0;
      if      (listingAgeDays > 730) decay = 0.35;
      else if (listingAgeDays > 365) decay = 0.50;
      else if (listingAgeDays > 180) decay = 0.65;
      else if (listingAgeDays > 90)  decay = 0.80;
      // < 90 days: decay = 1.0 (velocity is fresh and reliable)

      estimatedSold30d = Math.round(soldPerDay * 30 * decay);
    }

    // ── Country ───────────────────────────────────────────────────────────────
    const countryMatch   = text.match(/<Country>(.*?)<\/Country>/);
    const shipFromCountry = countryMatch ? countryMatch[1].trim() : null;

    return { soldCount, estimatedSold30d, listingAgeDays, shipFromCountry };
  } catch (e) {
    console.warn(`   [Trading] Exception ${numericItemId}:`, e);
    return empty;
  }
}

// ─── Country check helper ─────────────────────────────────────────────────────
function isChina(country: string | null | undefined): boolean {
  if (!country) return false;
  return ["CN", "HK", "TW"].includes(country.toUpperCase());
}

function notChina(country: string | null | undefined): boolean {
  if (!country || !country.trim()) return false; // unknown = don't block
  return !isChina(country);
}

// ─── Core: process one item and add to queue if it passes all filters ─────────
async function processItem(
  item: Record<string, unknown>,
  label: string,
): Promise<string | false> {
  const title      = (item.title as string) ?? "";
  const itemId     = item.itemId as string;
  const numericId  = extractNumericId(itemId);
  const itemUrl    = item.itemWebUrl as string;
  const categoryId = ((item.categories as { categoryId: string }[])?.[0]?.categoryId) ?? "";
  const catName    = ((item.categories as { categoryName: string }[])?.[0]?.categoryName) ?? "";

  // ── 1. Basic filters ────────────────────────────────────────────────────────
  const pricing = calcPricing(item);

  if (pricing.ebayRefPrice < CONFIG.MIN_PRICE || pricing.ebayRefPrice > CONFIG.MAX_PRICE) {
    console.log(`   SKIP [precio] "${title.slice(0,50)}" $${pricing.ebayRefPrice}`);
    return false;
  }
  if (isBanned(title)) {
    console.log(`   SKIP [banned] "${title.slice(0,50)}"`);
    return false;
  }

  // ── 2. China origin check (Browse API summary) ──────────────────────────────
  const summaryCountry = (item.itemLocation as { country?: string })?.country ?? "";
  if (notChina(summaryCountry)) {
    console.log(`   SKIP [pais] "${title.slice(0,50)}" — ${summaryCountry}`);
    return false;
  }

  // ── 3. Trading API: sales data + country confirmation ──────────────────────
  const td = await getItemDataViaTradingAPI(numericId);

  // Confirm China origin via Trading API
  if (notChina(td.shipFromCountry)) {
    console.log(`   SKIP [pais-trading] "${title.slice(0,50)}" — ${td.shipFromCountry}`);
    return false;
  }

  // ── 4. Sales filters ────────────────────────────────────────────────────────
  const ageLabel = td.listingAgeDays < 90 ? "nuevo" :
                   td.listingAgeDays < 365 ? `${Math.round(td.listingAgeDays/30)}m` :
                   `${(td.listingAgeDays/365).toFixed(1)}a`;

  console.log(`\n   🔎 "${title.slice(0,60)}"`);
  console.log(`      Precio: $${pricing.ebayRefPrice} + $${pricing.ebayShippingCost} envio = $${pricing.totalMarketCost} mercado`);
  console.log(`      Ventas: ${td.soldCount} total | ~${td.estimatedSold30d} est/30d | listing: ${ageLabel} | ID:${numericId}`);

  if (td.soldCount < CONFIG.MIN_SOLD_TOTAL) {
    console.log(`      ❌ ${td.soldCount} ventas totales < min ${CONFIG.MIN_SOLD_TOTAL}`);
    return false;
  }

  if (td.estimatedSold30d < CONFIG.MIN_SOLD_30D) {
    console.log(`      ❌ ~${td.estimatedSold30d} est/30d < min ${CONFIG.MIN_SOLD_30D} — producto lento`);
    return false;
  }

  // ── 5. Duplicate check ──────────────────────────────────────────────────────
  const dup = await db.collection(COLLECTIONS.QUEUE).where("ebayItemId", "==", numericId).limit(1).get();
  if (!dup.empty) {
    console.log(`      ⚠️  DUPLICADO (itemId)`);
    return false;
  }

  // Also check by normalized title (first 60 chars) to catch same product with diff ID
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim();
  const titleDup = await db.collection(COLLECTIONS.QUEUE)
    .where("normalizedTitle", "==", normalizedTitle).limit(1).get();
  if (!titleDup.empty) {
    console.log(`      ⚠️  DUPLICADO (título: "${normalizedTitle.slice(0, 40)}")`);
    return false;
  }

  // ── 6. Build and save queue product ─────────────────────────────────────────
  console.log(`      ✅ ACEPTADO | mercado $${pricing.totalMarketCost} | listamos $${pricing.suggestedSellingPrice} | ~${td.estimatedSold30d}/30d`);

  const images =
    (item.thumbnailImages as { imageUrl: string }[])?.map((i) => i.imageUrl) ||
    ((item.image as { imageUrl: string })?.imageUrl
      ? [(item.image as { imageUrl: string }).imageUrl]
      : []);

  const queueProduct: Omit<QueueProduct, "id"> = {
    ebayItemId:            numericId,  // numeric only — needed for Trading API GetItem
    title,
    normalizedTitle:       title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim(),
    images,
    ebayReferencePrice:    pricing.ebayRefPrice,
    ebayShippingCost:      pricing.ebayShippingCost,
    totalMarketCost:       pricing.totalMarketCost,
    eproloPrice:           null,
    eproloUrl:             null,
    suggestedSellingPrice: pricing.suggestedSellingPrice,
    margin:                null,
    marginPercent:         null,
    categoryId,
    categoryName:          catName,
    soldCount:             td.soldCount,
    estimatedSold30d:      td.estimatedSold30d,
    listingAgeDays:        Math.round(td.listingAgeDays),
    condition:             (item.condition as string) ?? "New",
    sourceUrl:             itemUrl,
    status:                "approved",
    description:           "",
    stock:                 CONFIG.STOCK,
    createdAt:             Date.now(),
    updatedAt:             Date.now(),
  };

  const docRef = db.collection(COLLECTIONS.QUEUE).doc();
  await docRef.set({ ...queueProduct, status: "approved" });
  return docRef.id; // return ID for auto-publish
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET() {
  return NextResponse.json({ keywords: AUTO_KEYWORDS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { keywords, limit = 50, autoSearch = false } = body;

    let totalAdded = 0;
    let totalPublished = 0;

    // Get user token for auto-publishing (getUserToken auto-refreshes if expired)
    let userToken: string | null = null;
    try {
      userToken = await getUserToken();
    } catch {
      console.warn("[search] No user token — products will be saved but NOT published");
    }

    const autoPublish = async (productId: string) => {
      if (!userToken) return;
      try {
        await publishProductById(productId, userToken);
        totalPublished++;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`[search] ❌ Auto-publish failed for ${productId}: ${reason}`);
        await markPublishFailed(productId, reason);
      }
    };

    // Single keyword search (frontend loops for auto-search)
    const kw = keywords || "";
    if (!kw) return NextResponse.json({ error: "keywords required" }, { status: 400 });

    console.log(`\n🔍 Búsqueda: "${kw}"`);
    let result: { itemSummaries?: unknown[] };
    try {
      result = await searchProducts(kw, 20);
    } catch (searchErr) {
      const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
      console.warn(`[search] ⚠️ Failed "${kw}":`, msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const items = (result.itemSummaries ?? []) as Record<string, unknown>[];
    console.log(`   ${items.length} items`);
    let totalReviewed = 0;
    let totalSkipped = 0;

    for (const item of items) {
      totalReviewed++;
      const productId = await processItem(item, kw);
      if (productId) {
        totalAdded++;
        await autoPublish(productId);
      } else {
        totalSkipped++;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    return NextResponse.json({ success: true, added: totalAdded, published: totalPublished, reviewed: totalReviewed, skipped: totalSkipped });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}