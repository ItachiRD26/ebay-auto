import { NextRequest, NextResponse } from "next/server";
import { searchProducts, getUserToken } from "@/lib/ebay";
import { db, COLLECTIONS } from "@/lib/firebase";
import { QueueProduct } from "@/types";

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
  "kitchen gadget",   "slicer",   "vegetable chopper",   "mandoline slicer",   "avocado slicer",   "egg slicer",
  "strawberry slicer",   "apple corer",   "cherry pitter",   "mango splitter",   "pineapple corer",   "watermelon cutter",
  "herb mincer",   "garlic press",   "garlic peeler",   "ginger grater",   "cheese grater",   "box grater",
  "microplane grater",   "zester",   "potato peeler",   "vegetable peeler",   "y peeler",   "julienne peeler",
  "spiralizer",   "vegetable spiralizer",   "pasta maker hand",   "ravioli mold",   "dumpling maker press",   "empanada press",
  "tortilla press",   "cookie scoop",   "ice cream scoop",   "melon baller",   "colander strainer",   "salad spinner",
  "pasta strainer",   "can opener",   "bottle opener",   "jar opener",   "wine opener",   "corkscrew",
  "oil dispenser",   "oil sprayer",   "olive oil sprayer",   "salad dressing shaker",   "food storage container",   "glass food container",
  "meal prep container",   "silicone food bag",   "reusable food wrap",   "beeswax wrap",   "silicone lid",   "stretch lid",
  "bowl cover",   "food keeper",   "lunch box",   "bento box",   "salad container",   "snack box",
  "stackable container",   "air fryer rack",   "air fryer accessories",   "air fryer liner",   "baking mat",   "silicone baking mat",
  "pastry mat",   "rolling pin",   "dough scraper",   "bench scraper",   "cake turntable",   "icing spatula",
  "piping bag set",   "cake decorating set",   "cookie cutter set",   "cupcake mold",   "silicone mold",   "ice cube tray",
  "ice ball maker",   "popsicle mold",   "chocolate mold",   "bundt pan",   "springform pan",   "sink caddy",
  "sink organizer",   "dish drying rack",   "over sink rack",   "kitchen shelf",   "spice rack",   "spice organizer",
  "cabinet organizer kitchen",   "drawer organizer kitchen",   "utensil holder",   "cutlery organizer",   "pot lid organizer",   "pan organizer",
  "cutting board set",   "bamboo cutting board",   "flexible cutting mat",   "kitchen scale",   "measuring spoon set",   "measuring cup set",
  "kitchen timer",   "cooking thermometer",   "meat thermometer",   "instant read thermometer",   "whisk set",   "silicone whisk",
  "spatula set",   "silicone spatula",   "wooden spoon set",   "ladle set",   "tongs set",   "kitchen scissors",
  "herb scissors",   "pizza cutter",   "cheese knife",   "butter spreader",   "grease separator",   "turkey baster",
  "marinade injector",   "pot holder set",   "oven mitt set",   "silicone glove kitchen",   "kitchen apron",   "waterproof apron",
  "dish soap dispenser",   "soap pump kitchen",   "fruit basket",   "bread basket",   "fruit bowl",   "banana hanger",
  "napkin holder",   "paper towel holder",   "wine rack",   "wine bottle holder",   "wine glass holder",   "stemware rack",
  "mandoline finger guard",   "cut resistant glove",   "herb storage keeper",   "produce saver container",   "salad keeper",   "lettuce saver",
  "berry container",   "onion keeper",   "avocado saver",   "egg storage rack",   "deviled egg tray",   "butter dish",
  "honey dispenser",   "syrup dispenser",   "spoon rest",   "pot trivet silicone",   "steam rack insert",   "instant pot rack",
  "bamboo wok spatula",   "mortar and pestle",   "tea infuser",   "loose leaf strainer",   "handheld milk frother",   "matcha whisk",
  "lemon squeezer",   "cocktail mixing set",   "ice cube mold",   "bread scoring lame",   "proofing basket",   "mason jar fermentation lid",
  "sushi making kit",   "takoyaki pan",   "egg ring mold",   "donut baking pan",   "cake smoothing tool",   "silicone pastry brush",
  "basting brush",   "cleaning brush set",   "toilet brush set",   "bathroom brush",   "grout cleaning brush",   "tile scrub brush",
  "bottle brush baby",   "straw cleaning brush",   "detail brush kit",   "electric scrubber",   "power scrubber",   "cordless tile scrubber",
  "drill brush attachment",   "spin scrubber",   "floor scrubber",   "window squeegee",   "shower squeegee",   "rubber squeegee",
  "extendable squeegee",   "microfiber cloth set",   "cleaning cloth",   "glass cleaning cloth",   "mop head replacement",   "flat mop",
  "spin mop",   "steam mop pad",   "broom dustpan set",   "mini dustpan",   "handheld dustpan",   "dust mop pad",
  "lint roller refill",   "lint remover brush",   "pet hair remover brush",   "fabric shaver",   "lint brush clothes",   "fur remover roller",
  "reusable lint roller",   "small trash can",   "bathroom trash bin",   "compost bin countertop",   "drain hair catcher",   "shower drain strainer",
  "sink strainer",   "sponge holder sink",   "dish brush holder",   "magic eraser sponge",   "melamine sponge set",   "scrub sponge set",
  "extendable duster",   "ceiling fan duster",   "cobweb duster",   "blind duster cleaner",   "laundry mesh bag",   "clothes drying rack",
  "collapsible drying rack",   "ironing board cover",   "shower caddy tension",   "corner shower shelf",   "over door bathroom organizer",   "over toilet storage",
  "bathroom floating shelf",   "soap dish holder",   "wall soap holder",   "foaming soap dispenser",   "automatic soap dispenser",   "toothbrush wall holder",
  "electric toothbrush holder",   "towel ring",   "towel bar",   "adhesive towel hook",   "bath towel rack",   "hand towel ring",
  "memory foam bath mat",   "diatomite bath mat",   "non slip shower mat",   "bathtub suction mat",   "toilet paper stand",   "toilet roll holder",
  "bathroom trash can",   "makeup organizer bathroom",   "cosmetic storage organizer",   "vanity organizer tray",   "under sink organizer",   "bathroom drawer organizer",
  "shower curtain hooks",   "rustproof shower rings",   "shower head bracket",   "adjustable shower holder",   "razor wall holder",   "hair dryer wall holder",
  "hair tool organizer wall",   "flat iron holder wall",   "bath pillow suction",   "bathtub tray bamboo",   "scalp shampoo brush",   "shower scalp massager",
  "back seat car organizer",   "car trunk organizer",   "car storage box",   "center console organizer",   "car cup holder insert",   "seat gap filler",
  "dashboard phone mount",   "windshield phone mount",   "air vent phone holder",   "cd slot phone holder",   "car headrest hook",   "car seat hanger",
  "car trash can mini",   "car garbage bin",   "car windshield sunshade",   "baby car window shade",   "steering wheel cover",   "car gear shift cover",
  "car door handle guard",   "car key organizer",   "car tissue holder",   "sun visor organizer",   "car interior brush",   "dashboard cleaning brush",
  "car ambient led light",   "dual car usb charger",   "car vent freshener",   "car armrest organizer",   "cargo net car",   "car laptop desk",
  "adjustable phone stand",   "foldable phone stand",   "lazy phone holder",   "gooseneck phone holder",   "tablet desk stand",   "foldable laptop stand",
  "portable laptop stand",   "laptop cooling pad",   "laptop ergonomic stand",   "monitor desk stand",   "screen riser",   "keyboard wrist rest",
  "extended mouse pad",   "desk mat xl",   "cable management clips",   "cord organizer sleeve",   "charging station dock",   "wireless charging pad",
  "fast wireless charger",   "headphone stand desk",   "headset holder",   "under desk hook",   "screen cleaner kit",   "silicone keyboard cover",
  "led usb desk lamp",   "clip on reading light",   "webcam privacy cover",   "clip on phone lens",   "mini ring light phone",   "pop socket grip",
  "desk organizer set",   "pen cup holder",   "document tray organizer",   "packing cube set",   "compression packing cube",   "hanging toiletry bag",
  "tsa toiletry bag",   "refillable travel bottles",   "rfid passport holder",   "rfid travel wallet",   "money belt travel",   "luggage strap",
  "memory foam neck pillow",   "inflatable travel pillow",   "sleep eye mask",   "noise canceling ear plug",   "compact travel umbrella",   "travel shoe bag",
  "travel laundry bag",   "universal travel adapter",   "digital luggage scale",   "tsa combination lock",   "vacuum travel bag",   "travel clothesline",
  "quick dry travel towel",   "slim card holder wallet",   "automatic pet feeder",   "slow feeder bowl",   "elevated pet feeder",   "portable dog water bottle",
  "pet travel bottle",   "collapsible pet bowl",   "cat water fountain",   "dog drinking fountain",   "pet food container",   "stainless pet bowl",
  "non slip dog bowl",   "waterproof pet mat",   "squeaky dog toy",   "rope chew toy",   "interactive treat toy dog",   "cat feather wand",
  "cat crinkle toy",   "catnip toy set",   "cat tunnel toy",   "slicker brush dog",   "deshedding pet brush",   "cat grooming glove",
  "dog nail clippers",   "pet grooming kit",   "pet toothbrush set",   "reflective dog collar",   "breakaway cat collar",   "retractable dog leash",
  "no pull dog harness",   "step in harness",   "soft pet carrier",   "backpack cat carrier",   "dog waste bag holder",   "paw cleaner cup",
  "muddy paw washer",   "cat litter mat",   "dog training treat pouch",   "obedience clicker",   "floating wall shelf",   "corner shelf",
  "display ledge shelf",   "bamboo wall shelf",   "wall hook set",   "decorative coat hooks",   "key holder wall",   "metal wall art",
  "wooden wall sign",   "macrame wall hanging",   "boho tapestry wall",   "silent wall clock",   "frameless clock",   "multi photo frame",
  "collage picture frame",   "touch bedside lamp",   "usb bedside lamp",   "plug in night light",   "sensor night light",   "flameless led candle",
  "remote candle set",   "outdoor fairy lights",   "bedroom string lights",   "globe string lights",   "glass bud vase",   "ceramic nordic vase",
  "wall plant hanger",   "macrame plant holder",   "geometric planter",   "terracotta pot set",   "tiered plant stand",   "corner plant stand",
  "geometric candle holder",   "pillar candle stand",   "throw pillow cover",   "cushion cover set",   "woven area rug",   "reed diffuser set",
  "essential oil diffuser",   "cabinet knob set",   "drawer pull handles",   "curtain ring clips",   "decorative bookend",   "vanity tray",
  "round wall mirror",   "decorative mirror",   "tabletop mirror",   "fabric resistance band",   "loop resistance band",   "pull up band",
  "non slip yoga mat",   "travel yoga mat",   "cork yoga block",   "yoga strap buckle",   "foam roller muscle",   "massage spike ball",
  "speed jump rope",   "weighted jump rope",   "ab wheel roller",   "core slider disc",   "push up board",   "push up handle",
  "ankle weight set",   "wrist weight set",   "hand grip strengthener",   "balance wobble board",   "doorway pull up bar",   "sports shaker bottle",
  "sports headband",   "sweat wristband",   "knee compression sleeve",   "elbow support brace",   "ice gel pack reusable",   "posture corrector brace",
  "acupressure spike mat",   "silicone watch sport band",   "workout lifting gloves",   "jade face roller",   "rose quartz roller",   "gua sha tool",
  "eyelash curler",   "eyebrow razor",   "glass nail file set",   "nail buffer block",   "cuticle trimmer",   "nail art brush kit",
  "nail dotting tool",   "makeup brush set",   "kabuki brush",   "beauty blender sponge",   "brush cleaner mat",   "makeup brush rack",
  "brush holder organizer",   "cosmetic travel bag",   "led vanity mirror",   "magnifying makeup mirror",   "hair claw clip set",   "butterfly clip set",
  "hair pin organizer",   "silk scrunchie set",   "wide tooth comb",   "wet detangling brush",   "head scalp massager",   "shampoo scalp brush",
  "dry body brush",   "exfoliating bath glove",   "loofah pad set",   "pumice stone foot",   "nose hair trimmer",   "reusable cotton rounds",
  "bamboo drawer divider",   "expandable drawer organizer",   "closet shelf divider",   "velvet slim hanger set",   "clear shoe box stackable",   "over door shoe organizer",
  "under bed storage",   "vacuum space saver bag",   "fabric storage bin",   "fridge storage bin",   "refrigerator organizer",   "can rack pantry organizer",
  "pantry storage container",   "lazy susan organizer",   "stackable cabinet shelf",   "cord management box",   "jewelry tray organizer",   "watch stand organizer",
  "sunglasses holder display",   "silicone baby bib",   "waterproof bib set",   "baby suction bowl",   "silicone suction plate",   "silicone baby spoon",
  "teether cooling toy",   "baby nail trimmer",   "baby nail care kit",   "soft baby brush",   "bathtub baby mat",   "bath toy organizer",
  "diaper clutch",   "portable changing pad",   "reusable wet dry bag",   "cabinet baby lock",   "corner guard baby",   "outlet plug cover",
  "baby night light",   "car seat strap cover",   "stroller organizer",   "activity play mat",   "growth chart wall",   "garden kneeler pad",
  "hand trowel set",   "pruning shears",   "garden marker stake",   "seed tray starter",   "indoor watering can",   "adjustable hose nozzle",
  "plant misting bottle",   "soil moisture meter",   "velcro plant tie",   "climbing trellis net",   "waterproof garden gloves",   "window bird feeder",
  "solar path light",   "garden wind spinner",   "fabric grow bag",   "drip irrigation kit",   "garden utility apron",   "sticky insect trap",
  "large pencil case",   "desk organizer caddy",   "sticky note set",   "binder clip assorted",   "pastel highlighter set",   "planner sticker set",
  "washi tape assorted",   "spiral notebook cover",   "index tab set",   "magnetic bookmark",   "laptop neoprene sleeve",   "tech cable organizer",
  "backpack insert organizer",   "lanyard badge holder",   "whiteboard eraser",   "office chair cushion",   "adjustable footrest desk",   "monitor bar light",
  "mini succulent pot",   "usb rechargeable hand warmer",   "bathtub bamboo tray",   "bath bomb mold",   "body scrub storage jar",   "himalayan salt lamp",
  "lavender eye pillow",   "meditation floor cushion",   "foot soak basin",   "massage stone set",   "facial cupping set",   "microfiber hair turban",
  "wide spa headband",   "candle wick trimmer",   "aromatherapy lava bracelet",   "pillow mist spray",   "watercolor brush set",   "palette knife set",
  "self healing cutting mat",   "craft heat gun",   "embroidery floss organizer",   "knitting needle case",   "embroidery hoop set",   "reusable craft stencil",
  "mini glue gun" 
];

const EXCLUDED_KEYWORDS: string[] = [
  // ── Major brands ──────────────────────────────────────────────────────────
  "iphone","samsung galaxy","apple watch","airpods","macbook","ipad",
  "playstation","xbox","nintendo switch","nvidia","radeon",
  "nike","adidas","gucci","louis vuitton","supreme","yeezy","jordan","off-white",
  "balenciaga","versace","prada","dior","burberry","chanel","hermes","fendi",
  "lululemon","north face","under armour","new balance","reebok","vans","converse",
  "timberland","owala","stanley cup","hydro flask","yeti","contigo","camelbak",
  "ralph lauren","lacoste","tommy hilfiger","calvin klein","hugo boss",
  "michael kors","coach","kate spade","marc jacobs","victoria secret",
  "lego","barbie","disney","marvel","pokemon","naruto","one piece","dragon ball",
  "rolex","omega watch","cartier","tiffany",
  // ── Sexual / adult ────────────────────────────────────────────────────────
  "dildo","vibrator","sex toy","anal","butt plug","penis enlargement",
  "male enhancement","adult toy","erection","cock ring","chastity",
  "penis pump","penile","erectile","extender penis",
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

  // ── 3. Quick pre-checks before expensive Trading API call ─────────────────
  // Skip if condition is clearly not new
  const conditionId = (item.conditionId as string) ?? "";
  if (conditionId && !["1000","1500"].includes(conditionId)) {
    console.log(`   SKIP [condicion] "${title.slice(0,50)}" — ${conditionId}`);
    return false;
  }

  // ── 4. Trading API: sales data + country confirmation ──────────────────────
  const td = await getItemDataViaTradingAPI(numericId);

  // Confirm China origin via Trading API
  if (notChina(td.shipFromCountry)) {
    console.log(`   SKIP [pais-trading] "${title.slice(0,50)}" — ${td.shipFromCountry}`);
    return false;
  }

  // ── 5. Sales filters ────────────────────────────────────────────────────────
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

  // ── 6. Duplicate check ──────────────────────────────────────────────────────
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

  // ── 7. Build and save queue product ─────────────────────────────────────────
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

    // Single keyword search (frontend loops for auto-search)
    const kw = keywords || "";
    if (!kw) return NextResponse.json({ error: "keywords required" }, { status: 400 });

    console.log(`\n🔍 Búsqueda: "${kw}"`);
    let result: { itemSummaries?: unknown[] };
    try {
      result = await searchProducts(kw, 50);
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
        totalAdded++; // saved as "approved" — waits for manual review
      } else {
        totalSkipped++;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return NextResponse.json({ success: true, added: totalAdded, published: 0, reviewed: totalReviewed, skipped: totalSkipped });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}