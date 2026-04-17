import { NextRequest, NextResponse } from "next/server";
import { settingsDoc } from "@/lib/firebase";

export const DEFAULT_AUTO_KEYWORDS = [
  // ── Kitchen & Cooking ────────────────────────────────────────────────────
  "kitchen gadget set",
  "vegetable chopper",
  "mandoline slicer",
  "avocado slicer",
  "garlic press stainless",
  "salad spinner",
  "fruit infuser bottle",
  "silicone cooking utensils",
  "kitchen scale digital",
  "oil dispenser bottle",
  "egg separator tool",
  "herb stripper tool",
  "pasta maker manual",
  "dough scraper",
  "pastry brush silicone",
  "food storage containers set",
  "meal prep container",
  "vacuum sealer bags",
  "pour over coffee dripper",
  "french press coffee",
  "milk frother handheld",
  "electric can opener",
  "jar opener grip",
  "cutting board bamboo",
  "knife sharpener manual",
  "cheese grater box",
  "colander silicone",
  "splatter screen pan",

  // ── Home Organization ────────────────────────────────────────────────────
  "drawer organizer divider",
  "closet organizer shelf",
  "under sink organizer",
  "over door organizer",
  "bathroom organizer set",
  "medicine cabinet organizer",
  "cable organizer box",
  "desk organizer set",
  "file organizer desktop",
  "spice rack organizer",
  "pantry organizer bins",
  "refrigerator organizer",
  "stackable storage bins",
  "modular storage cube",
  "collapsible storage box",
  "bed storage bags",
  "vacuum storage bags",
  "shoe storage box clear",
  "shoe rack portable",
  "belt tie organizer",
  "jewelry organizer box",
  "makeup organizer acrylic",
  "hair tool organizer",

  // ── Home Decor ───────────────────────────────────────────────────────────
  "LED candles flameless",
  "fairy lights string",
  "macrame wall hanging",
  "boho wall art",
  "geometric plant stand",
  "succulent planter ceramic",
  "hanging planter wall",
  "terrarium glass",
  "diffuser reed home",
  "wax melt burner",
  "floating shelves wall",
  "decorative throw pillow",
  "faux fur throw blanket",
  "linen table runner",
  "rattan basket storage",
  "woven seagrass basket",
  "wooden picture frame set",
  "photo display wall",
  "clock wall silent",
  "tapestry boho bedroom",
  "LED moon lamp",
  "night light projector",
  "neon light sign",
  "mirror decorative wall",
  "abstract painting canvas",

  // ── Bathroom ─────────────────────────────────────────────────────────────
  "shower caddy organizer",
  "toothbrush holder wall",
  "soap dispenser pump",
  "towel ring holder",
  "toilet paper holder",
  "bathroom accessories set",
  "bath mat non slip",
  "shower curtain liner",
  "showerhead high pressure",
  "water saving shower",
  "bath pillow spa",
  "loofah bath scrubber",
  "pumice stone foot",
  "exfoliating scrub glove",
  "facial steamer portable",
  "blackhead remover tool",
  "face roller jade",
  "gua sha stone",

  // ── Women's Fashion & Accessories ────────────────────────────────────────
  "pearl hair clips set",
  "butterfly hair clips",
  "scrunchie hair ties set",
  "headband wide fashion",
  "hair claw clips large",
  "bobby pins decorative",
  "crystal hair pins",
  "braided headband",
  "body chain jewelry",
  "layered necklace set",
  "choker necklace gold",
  "pendant necklace dainty",
  "hoop earrings gold",
  "stud earrings set",
  "dangle earrings crystal",
  "cuff bracelet adjustable",
  "beaded bracelet set",
  "charm bracelet women",
  "statement ring oversized",
  "ring set adjustable",
  "anklet gold layered",
  "crossbody bag women",
  "tote bag canvas",
  "wristlet clutch bag",
  "coin purse leather",
  "cosmetic bag travel",
  "scarf silk women",
  "hair wrap scarf",
  "oversized sunglasses women",
  "cat eye sunglasses",

  // ── Men's Accessories ────────────────────────────────────────────────────
  "men wallet slim",
  "men bifold wallet leather",
  "money clip wallet",
  "men braided bracelet",
  "men beaded bracelet",
  "men ring titanium",
  "men necklace chain",
  "men sunglasses polarized",
  "tie clip set",
  "cufflinks set men",
  "keychain organizer",
  "carabiner keychain multi",

  // ── Fitness & Sports ─────────────────────────────────────────────────────
  "resistance bands set",
  "exercise bands loop",
  "pull up bar doorframe",
  "push up board",
  "ab roller wheel",
  "jump rope weighted",
  "foam roller massage",
  "massage ball set",
  "yoga mat thick",
  "yoga blocks set",
  "yoga strap stretch",
  "balance board wobble",
  "ankle weights set",
  "wrist weights pair",
  "fitness gloves grip",
  "knee sleeve support",
  "elbow brace support",
  "posture corrector brace",
  "back stretcher device",
  "lumbar support cushion",
  "seat cushion coccyx",
  "swimming goggles adult",
  "water bottle sport",
  "gym bag drawstring",
  "workout headband sweat",

  // ── Outdoor & Garden ─────────────────────────────────────────────────────
  "solar garden lights",
  "solar pathway lights set",
  "garden stakes decorative",
  "wind chime large",
  "bird feeder hanging",
  "bird bath solar",
  "hummingbird feeder",
  "plant watering globe",
  "self watering planter",
  "hanging basket planter",
  "garden kneeler cushion",
  "gardening gloves waterproof",
  "garden tool set",
  "pruning shears professional",
  "succulent soil mix",
  "plant pot drainage",
  "outdoor string lights",
  "camping hammock portable",
  "camping lantern solar",
  "picnic blanket waterproof",
  "beach towel oversized",
  "cooler bag insulated",
  "water gun large",
  "bubble machine kids",

  // ── Pet Supplies ─────────────────────────────────────────────────────────
  "cat bed donut",
  "cat cave bed",
  "dog bed washable",
  "orthopedic dog bed",
  "pet blanket waterproof",
  "cat tunnel toy",
  "feather wand cat toy",
  "catnip toy fish",
  "dog rope toy set",
  "dog squeaky toy set",
  "dog treat puzzle",
  "slow feeder dog bowl",
  "stainless dog bowl",
  "elevated dog bowl",
  "pet food storage container",
  "cat water fountain",
  "dog water bottle portable",
  "pet grooming glove",
  "deshedding brush dog",
  "nail grinder pet",
  "dog poop bag holder",
  "dog car seat cover",
  "pet carrier backpack",
  "dog life vest",

  // ── Travel Accessories ───────────────────────────────────────────────────
  "packing cubes set",
  "compression packing cubes",
  "luggage organizer bags",
  "passport holder wallet",
  "luggage tag leather",
  "travel adapter universal",
  "travel pillow memory foam",
  "eye mask sleep",
  "earplugs sleeping",
  "toiletry bag hanging",
  "dry bag waterproof",
  "travel umbrella compact",
  "fanny pack crossbody",
  "backpack daypack lightweight",
  "duffel bag gym",
  "money belt hidden",

  // ── Baby & Kids ──────────────────────────────────────────────────────────
  "baby monitor camera",
  "baby food maker",
  "silicone baby spoon",
  "suction bowl baby",
  "baby bib waterproof",
  "nursing cover breastfeeding",
  "diaper bag backpack",
  "stroller organizer bag",
  "baby carrier wrap",
  "white noise machine baby",
  "baby nail file set",
  "teething toy silicone",
  "baby play mat foam",
  "kids lunch box",
  "water bottle kids straw",
  "kids art supplies",
  "drawing tablet kids",

  // ── Office & Desk ────────────────────────────────────────────────────────
  "monitor stand riser",
  "laptop stand adjustable",
  "laptop cooling pad",
  "mouse pad large desk",
  "desk pad leather",
  "cable management sleeve",
  "power strip surge",
  "wireless charging pad",
  "USB hub multi port",
  "screen cleaner kit",
  "keyboard wrist rest",
  "ergonomic mouse pad",
  "document holder stand",
  "sticky note dispenser",
  "pen holder organizer",
  "planner notebook",
  "self inking stamp",
  "label maker handheld",

  // ── LED & Lighting ───────────────────────────────────────────────────────
  "LED strip lights room",
  "smart LED bulb color",
  "LED desk lamp USB",
  "touch lamp bedside",
  "reading light book",
  "motion sensor light",
  "closet light stick on",
  "under cabinet light",
  "solar powered lantern",
  "string lights outdoor",
  "RGB light strip gaming",
  "color changing light bulb",
  "projection light star",
  "aurora light projector",

  // ── Phone Accessories (unbranded) ────────────────────────────────────────
  "wireless charger stand",
  "MagSafe compatible case",
  "screen protector tempered",
  "phone grip ring holder",
  "phone stand desk",
  "car phone holder vent",
  "phone pouch waterproof",
  "cable organizer ties",
  "charging cable braided",
  "earphone storage case",

  // ── Seasonal & Gifting ───────────────────────────────────────────────────
  "gift box set women",
  "self care gift set",
  "spa gift basket",
  "scented candle set",
  "wax seal stamp set",
  "calligraphy pen set",
  "journal notebook aesthetic",
  "sticker book aesthetic",
  "photo album scrapbook",
  "polaroid photo frame",
  "birthday decoration set",
  "balloon arch kit",
  "table runner linen",
  "napkin ring set",
  "coaster set marble",
  "tray decorative gold",

  // ── Footwear (safe keywords) ─────────────────────────────────────────────
  "women platform sandals",
  "women wedge sandals",
  "women slide sandals",
  "women loafers slip on",
  "women ballet flats",
  "men casual sneakers",
  "men loafers leather",
  "men dress shoes oxfords",
  "men ankle boots",
  "slipper memory foam",
  "outdoor sandals women",

  // ── Clothing (generic, no brands) ────────────────────────────────────────
  "women floral dress",
  "women wrap dress midi",
  "women linen dress summer",
  "women bodycon dress",
  "women blazer oversized",
  "women cardigan loose",
  "women crop top ribbed",
  "women wide leg pants",
  "women pleated skirt",
  "men linen shirt",
  "men polo shirt",
  "men jogger pants",
  "men bomber jacket",
  "women swim cover up",
  "rash guard women",
];


export const DEFAULT_EXCLUDED_KEYWORDS = [
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
"dildo","vibrator","sex toy","anal","butt plug","penis enlargement",
"male enhancement","adult toy","erection","cock ring","chastity",
"penis pump","penile","erectile","extender penis",
"bdsm","bondage","restraint","fetish",
"gun","firearm","ammo","ammunition","rifle","pistol","replica","counterfeit","fake",
"mercedes","bmw","audi","porsche","ferrari","lamborghini","tesla","ford","chevrolet",
"toyota","honda","nissan","hyundai","volkswagen","subaru","mazda",
"starbucks","nespresso","keurig","red bull","monster energy","coca cola","pepsi",
"anime","manga","waifu","yugioh","magic the gathering","tcg","ccg","playmat",
"keyway broach","broaching","hss cutter","metric broach","push type broach"
];

// GET — return keyword lists for this user
export async function GET(req: NextRequest) {
  try {
    const userId = new URL(req.url).searchParams.get("userId");
    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

    const snap = await settingsDoc(userId, "keywords").get();
    const data = snap.exists ? snap.data() : {};

    return NextResponse.json({
      autoKeywords:     data?.autoKeywords     ?? DEFAULT_AUTO_KEYWORDS,
      excludedKeywords: data?.excludedKeywords ?? DEFAULT_EXCLUDED_KEYWORDS,
      isCustom: snap.exists,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST — save keyword lists for this user
export async function POST(req: NextRequest) {
  try {
    const { autoKeywords, excludedKeywords, userId } = await req.json();
    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

    const updates: Record<string, string[]> = {};
    if (Array.isArray(autoKeywords))     updates.autoKeywords     = autoKeywords.map((k: string) => k.trim().toLowerCase()).filter(Boolean);
    if (Array.isArray(excludedKeywords)) updates.excludedKeywords = excludedKeywords.map((k: string) => k.trim().toLowerCase()).filter(Boolean);

    await settingsDoc(userId, "keywords").set(updates, { merge: true });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// DELETE — reset to defaults for this user
export async function DELETE(req: NextRequest) {
  try {
    const userId = new URL(req.url).searchParams.get("userId");
    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

    await settingsDoc(userId, "keywords").delete();
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}