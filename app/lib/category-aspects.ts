/**
 * category-aspects.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for:
 *   1. Mapping product titles → verified eBay leaf category IDs
 *   2. Fetching required/recommended aspects from eBay Taxonomy API
 *   3. Building the correct ItemSpecifics for each category type
 *
 * Why this file exists:
 *   - publish.ts had inline aspect logic that only covered clothing, not footwear
 *   - validateAndFixCategory trusted hardcoded IDs without API validation
 *   - refAspects from CN sellers bled into unrelated categories (e.g. "Department"
 *     on dog collars because the CN seller listed shoes in the wrong category)
 */

import { getAppToken } from "@/lib/ebay";

// ─── Category types ────────────────────────────────────────────────────────────
export type CategoryType =
  | "footwear_men"
  | "footwear_women"
  | "footwear_kids"
  | "clothing_men"
  | "clothing_women"
  | "clothing_kids"
  | "pet_dog"
  | "pet_cat"
  | "pet_generic"
  | "home_kitchen"
  | "home_decor"
  | "home_textile"
  | "electronics"
  | "jewelry"
  | "bags"
  | "sports"
  | "tools"
  | "generic";

// ─── Aspect info (from eBay Taxonomy API) ─────────────────────────────────────
export interface AspectInfo {
  name: string;
  required: boolean;
  recommended: boolean;
  selectionOnly: boolean;
  validValues: string[];    // empty = free text
  maxLength: number;
}

// ─── Verified eBay US leaf category IDs ───────────────────────────────────────
// Key: keyword pattern function
// Value: { id, type }
// IMPORTANT: These are verified against Trading API. If eBay restructures their
// taxonomy, validateAndFixCategory() will catch it via API and override.

export const CATEGORY_TYPES: Record<string, CategoryType> = {
  // ── Men's footwear ────────────────────────────────────────────────────────
  "45333": "footwear_men",   // Men's Loafers & Slip-Ons
  "63867": "footwear_men",   // Men's Slippers
  "15709": "footwear_men",   // Men's Sneakers
  "11498": "footwear_men",   // Men's Boots
  "57929": "footwear_men",   // Men's Dress Shoes
  "11499": "footwear_men",   // Men's Sandals & Flip Flops
  // ── Women's footwear ──────────────────────────────────────────────────────
  "55793": "footwear_women", // Women's Boots
  "55791": "footwear_women", // Women's Heels
  "55789": "footwear_women", // Women's Flats
  "57988": "footwear_women", // Women's Sneakers & Athletic
  "11504": "footwear_women", // Women's Sandals
  "63870": "footwear_women", // Women's Slippers
  "179297":"footwear_women", // Women's Loafers & Slip-Ons
  "179299":"footwear_women", // Women's Mules & Clogs
  // ── Men's clothing ────────────────────────────────────────────────────────
  "53159": "clothing_men",   // Men's T-Shirts
  "15689": "clothing_men",   // Men's Jeans
  "57990": "clothing_men",   // Men's Jackets & Coats
  "57991": "clothing_men",   // Men's Sweaters
  "57992": "clothing_men",   // Men's Shirts
  "15690": "clothing_men",   // Men's Shorts
  // ── Women's clothing ──────────────────────────────────────────────────────
  "63861": "clothing_women", // Women's Dresses
  "63862": "clothing_women", // Women's Tops & Blouses
  "63863": "clothing_women", // Women's Pants
  "63864": "clothing_women", // Women's Jackets & Coats
  "63865": "clothing_women", // Women's Shorts
  "63866": "clothing_women", // Women's Sweaters
  // ── Pet ───────────────────────────────────────────────────────────────────
  // NOTE: 66862 is NOT a leaf (returns 400 from get_item_aspects_for_category)
  // 116381 is the correct leaf for "Dog Collars & Tags"
  // 66774  is "Bark Collars" (electronic/shock) — only for training collars
  "116381":"pet_dog",        // Dog Collars & Tags (leaf — plain/fashion collars)
  "66774": "pet_dog",        // Bark Collars (leaf — only for electronic/shock collars)
  "66863": "pet_dog",        // Dog Leashes
  "66864": "pet_dog",        // Dog Harnesses
  "20742": "pet_dog",        // Dog Supplies (fallback parent)
  "20748": "pet_cat",        // Cat Collars & Tags
  "20750": "pet_cat",        // Cat Supplies
  // ── Home ──────────────────────────────────────────────────────────────────
  "20625": "home_kitchen",   // Kitchen Storage (default fallback)
  "20686": "home_kitchen",   // Mugs
  "20579": "home_kitchen",   // Bottles & Tumblers
  "20455": "home_textile",   // Pillows
  "20460": "home_textile",   // Blankets & Throws
  "20461": "home_textile",   // Towels
  "20580": "home_decor",     // Rugs & Mats
  "20697": "home_decor",     // Lamps & Lighting
  "3815":  "home_decor",     // Clocks
  "92074": "home_decor",     // Frames
  "116656":"home_decor",     // Vases & Decorative Bowls
  // ── Electronics ───────────────────────────────────────────────────────────
  // NOTE: 116458 (Cell Phone Mounts) is NOT a leaf — removed from map.
  // 19591 (Lighting Kits) is returned by Taxonomy API for phone mount queries
  // but is WRONG — overridden in getVerifiedLeafCategory.
  "139762":"electronics",    // Outlet Adapters
  // ── Sports ────────────────────────────────────────────────────────────────
  "158902":"sports",         // Fitness Equipment
  "112576":"home_decor",     // Shoe Organizers (home, not footwear)
  // ── Travel / Bags ─────────────────────────────────────────────────────────
  "169291":"bags",           // Travel Accessories
};

// ─── Keyword → category mapping ───────────────────────────────────────────────
// Ordered: most specific first. Returns { id, type }.
// This is the STARTING POINT — always validated with isLeafCategory() after.

interface CategoryMatch { id: string; type: CategoryType }

export function matchCategoryByTitle(title: string): CategoryMatch {
  const t = title.toLowerCase();

  // ── Pet — most specific first ──────────────────────────────────────────────
  // Bark/shock/training collars — 66774 (Bark Collars, leaf)
  const isBarkCollar = (t.includes("bark") || t.includes("shock") || t.includes("static") ||
    t.includes("electric") || t.includes("training collar") || t.includes("remote collar") ||
    t.includes("e-collar") || t.includes("anti-bark"));
  if ((t.includes("dog") || t.includes("pet")) && isBarkCollar)
    return { id: "66774", type: "pet_dog" };

  // Plain/fashion/walking collars — 116381 (Dog Collars & Tags, leaf)
  // NOT 66862 (parent, returns 400) and NOT 66774 (bark collars)
  const isDogCollar = (t.includes("dog") || t.includes("puppy") || t.includes("pet"))
    && (t.includes("collar") || t.includes("leash") || t.includes("harness") ||
        t.includes("chain collar") || t.includes("link collar") || t.includes("walking chain"));
  if (isDogCollar) return { id: "116381", type: "pet_dog" };

  const isCatCollar = (t.includes("cat") || t.includes("kitten"))
    && (t.includes("collar") || t.includes("harness"));
  if (isCatCollar) return { id: "20748", type: "pet_cat" };

  if (t.includes("dog") || t.includes("puppy") || (t.includes("pet") && !t.includes("petit")))
    return { id: "20742", type: "pet_dog" };
  if (t.includes("cat") || t.includes("kitten"))
    return { id: "20750", type: "pet_cat" };

  // ── Footwear — detect gender first ────────────────────────────────────────
  const isMale =
    t.includes("men") || t.includes("male") || t.includes("boys") || t.includes("boy shoe");
  const isFemale =
    t.includes("women") || t.includes("ladies") || t.includes("female") ||
    t.includes("girls") || t.includes("girl shoe");

  const isFootwear = [
    "shoe", "boot", "sneaker", "sandal", "slipper", "loafer", "mule",
    "heel", "pump", "stiletto", "flat", "oxford", "derby", "trainer",
    "footwear", "slide", "flip flop", "wedge",
  ].some((w) => t.includes(w));

  if (isFootwear && !t.includes("shoe organizer") && !t.includes("shoe rack") && !t.includes("shoe storage")) {
    // Women's subcategories
    if (isFemale || (!isMale && (t.includes("heel") || t.includes("pump") || t.includes("stiletto") || t.includes("wedge")))) {
      if (t.includes("boot"))    return { id: "55793", type: "footwear_women" };
      if (t.includes("heel") || t.includes("pump") || t.includes("stiletto") || t.includes("wedge"))
        return { id: "55791", type: "footwear_women" };
      if (t.includes("sandal") || t.includes("flip flop") || t.includes("slide") || t.includes("thong"))
        return { id: "11504", type: "footwear_women" };
      if (t.includes("slipper")) return { id: "63870", type: "footwear_women" };
      if (t.includes("sneaker") || t.includes("trainer") || t.includes("running"))
        return { id: "57988", type: "footwear_women" };
      if (t.includes("loafer") || t.includes("mule") || t.includes("slip on") || t.includes("slip-on"))
        return { id: "179297", type: "footwear_women" };
      return { id: "55789", type: "footwear_women" }; // Women's Flats (safe default)
    }

    // Men's subcategories (default when no gender detected)
    if (t.includes("boot"))     return { id: "11498", type: "footwear_men" };
    if (t.includes("oxford") || t.includes("derby") || t.includes("dress shoe") || t.includes("formal shoe"))
      return { id: "57929", type: "footwear_men" };
    if (t.includes("sandal") || t.includes("flip flop") || t.includes("slide") && !t.includes("slipper"))
      return { id: "11499", type: "footwear_men" };
    if (t.includes("slipper")) return { id: "63867", type: "footwear_men" };
    if (t.includes("sneaker") || t.includes("trainer") || t.includes("running"))
      return { id: "15709", type: "footwear_men" };
    // Loafers / mules / slip-on / casual
    return { id: "45333", type: "footwear_men" };
  }

  // Shoe organizer → home, not footwear
  if (t.includes("shoe organizer") || t.includes("shoe rack") || t.includes("shoe storage"))
    return { id: "112576", type: "home_decor" };

  // ── Clothing ──────────────────────────────────────────────────────────────
  const isMaleclothing = isMale || t.includes("men's") || t.includes("him ");
  const isFemaleClothing = isFemale || t.includes("women's") || t.includes("ladies'");

  const clothingKeywords = ["dress", "shirt", "pants", "jacket", "coat", "skirt",
    "leggings", "hoodie", "sweater", "blouse", "shorts", "jeans", "suit",
    "cardigan", "sweatshirt", "turtleneck", "pullover", "polo"];
  const isClothing = clothingKeywords.some((w) => t.includes(w));

  if (isClothing) {
    if (isMaleclothing) {
      if (t.includes("jacket") || t.includes("coat")) return { id: "57990", type: "clothing_men" };
      if (t.includes("sweater") || t.includes("cardigan") || t.includes("pullover"))
        return { id: "57991", type: "clothing_men" };
      if (t.includes("shirt")) return { id: "57992", type: "clothing_men" };
      if (t.includes("jeans")) return { id: "15689", type: "clothing_men" };
      if (t.includes("shorts")) return { id: "15690", type: "clothing_men" };
      return { id: "53159", type: "clothing_men" };
    }
    if (t.includes("dress") || t.includes("skirt")) return { id: "63861", type: "clothing_women" };
    if (t.includes("jacket") || t.includes("coat")) return { id: "63864", type: "clothing_women" };
    if (t.includes("sweater") || t.includes("hoodie") || t.includes("cardigan"))
      return { id: "63866", type: "clothing_women" };
    if (t.includes("pants") || t.includes("jeans") || t.includes("leggings"))
      return { id: "63863", type: "clothing_women" };
    if (t.includes("shorts")) return { id: "63865", type: "clothing_women" };
    return { id: "63862", type: "clothing_women" };
  }

  // ── Electronics ───────────────────────────────────────────────────────────
  // NOTE: 116458 (Cell Phone Mounts) returns 400 — it is NOT a leaf category.
  // The Taxonomy API often suggests 19591 (Lighting Kits) for phone mount queries
  // which is completely wrong. We fall through to Taxonomy API for phone mounts
  // and let getVerifiedLeafCategory handle it, with the 19591 override below.
  if (t.includes("adapter") || t.includes("converter") || t.includes("plug"))
    return { id: "139762", type: "electronics" };

  // ── Sports / Fitness ──────────────────────────────────────────────────────
  if (t.includes("yoga") || t.includes("fitness") || t.includes("exercise") || t.includes("gym"))
    return { id: "158902", type: "sports" };

  // ── Home — Textile ────────────────────────────────────────────────────────
  if (t.includes("pillow") || t.includes("cushion")) return { id: "20455", type: "home_textile" };
  if (t.includes("blanket") || t.includes("throw"))  return { id: "20460", type: "home_textile" };
  if (t.includes("towel"))                            return { id: "20461", type: "home_textile" };

  // ── Home — Decor ──────────────────────────────────────────────────────────
  if (t.includes("lamp") || t.includes("led strip") || t.includes("light"))
    return { id: "20697", type: "home_decor" };
  if (t.includes("rug") || t.includes("mat") || t.includes("carpet"))
    return { id: "20580", type: "home_decor" };
  if (t.includes("vase") || t.includes("planter"))   return { id: "116656", type: "home_decor" };
  if (t.includes("clock"))                            return { id: "3815",   type: "home_decor" };
  if (t.includes("frame"))                            return { id: "92074",  type: "home_decor" };

  // ── Home — Kitchen ────────────────────────────────────────────────────────
  if (t.includes("mug") || t.includes("cup"))        return { id: "20686", type: "home_kitchen" };
  if (t.includes("bottle") || t.includes("tumbler") || t.includes("flask"))
    return { id: "20579", type: "home_kitchen" };

  // ── Travel / Bags ─────────────────────────────────────────────────────────
  if (t.includes("travel") || t.includes("packing") || t.includes("luggage") || t.includes("suitcase"))
    return { id: "169291", type: "bags" };

  // Default — Kitchen Storage is the safest verified leaf
  return { id: "20625", type: "home_kitchen" };
}

// ─── Fetch + parse required aspects from eBay Taxonomy API ───────────────────
// Returns aspects sorted: required first, then recommended.
// In-memory cache (best-effort in serverless; TTL 24h).

const _aspectCache = new Map<string, { aspects: AspectInfo[]; fetchedAt: number }>();

export async function fetchRequiredAspects(
  categoryId: string,
  appToken: string
): Promise<AspectInfo[]> {
  const cached = _aspectCache.get(categoryId);
  if (cached && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) return cached.aspects;

  try {
    const res = await fetch(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`,
      { headers: { Authorization: `Bearer ${appToken}` }, signal: AbortSignal.timeout(8000) }
    );

    if (!res.ok) {
      // Non-200 means not a leaf — caller should re-validate the category
      console.warn(`[aspects] ${categoryId} → ${res.status} (not a leaf or API error)`);
      return [];
    }

    const data = await res.json() as {
      aspects?: Array<{
        localizedAspectName: string;
        aspectConstraint?: {
          aspectRequired?: boolean;
          aspectUsage?: string;
          aspectMode?: string;
          aspectMaxLength?: number;
        };
        aspectValues?: Array<{ localizedValue: string }>;
      }>;
    };

    const aspects: AspectInfo[] = (data.aspects ?? []).map((a) => ({
      name: a.localizedAspectName,
      required: a.aspectConstraint?.aspectRequired === true,
      recommended: a.aspectConstraint?.aspectUsage === "RECOMMENDED",
      selectionOnly: a.aspectConstraint?.aspectMode === "SELECTION_ONLY",
      validValues: (a.aspectValues ?? []).map((v) => v.localizedValue),
      maxLength: a.aspectConstraint?.aspectMaxLength ?? 65,
    }));

    // Sort: required → recommended → optional
    aspects.sort((a, b) => {
      if (a.required && !b.required) return -1;
      if (!a.required && b.required) return 1;
      if (a.recommended && !b.recommended) return -1;
      if (!a.recommended && b.recommended) return 1;
      return 0;
    });

    _aspectCache.set(categoryId, { aspects, fetchedAt: Date.now() });
    console.log(`[aspects] ${categoryId}: ${aspects.filter((a) => a.required).length} required, ${aspects.filter((a) => a.recommended).length} recommended`);
    return aspects;
  } catch (e) {
    console.warn("[aspects] fetch error:", e);
    return [];
  }
}

// ─── Validate a category is a leaf ───────────────────────────────────────────
const _leafCache = new Map<string, boolean>();

export async function validateLeafCategory(
  categoryId: string,
  appToken: string
): Promise<boolean> {
  if (_leafCache.has(categoryId)) return _leafCache.get(categoryId)!;
  // fetchRequiredAspects returns [] for non-leaves (non-200)
  const aspects = await fetchRequiredAspects(categoryId, appToken);
  const isLeaf = aspects.length > 0;
  _leafCache.set(categoryId, isLeaf);
  return isLeaf;
}

// ─── Get a validated leaf category for a product title ───────────────────────
// Flow:
//   1. Keyword map → candidate ID
//   2. API validate → if leaf, done
//   3. Taxonomy API suggest → if leaf, done
//   4. Original category ID → if leaf, done
//   5. Fallback to "20625" (Kitchen Storage, always a leaf)

export async function getVerifiedLeafCategory(
  title: string,
  originalCategoryId: string,
): Promise<{ id: string; type: CategoryType }> {
  const appToken = await getAppToken();

  // Step 1 — keyword match
  const keywordMatch = matchCategoryByTitle(title);

  // Step 2 — validate keyword match
  const kwIsLeaf = await validateLeafCategory(keywordMatch.id, appToken);
  if (kwIsLeaf) {
    console.log(`[category] keyword match ${keywordMatch.id} ✅ leaf`);
    return keywordMatch;
  }

  console.log(`[category] keyword match ${keywordMatch.id} ❌ not a leaf — trying Taxonomy API`);

  // Step 3 — Taxonomy API suggestion for the title
  try {
    const { getCategoryIdForTitle } = await import("@/lib/ebay");
    const suggested = await getCategoryIdForTitle(title);
    if (suggested) {
      // Override: Taxonomy API often returns 66774 (Bark Collars) for any "dog collar"
      // query. That's wrong for plain/fashion collars and triggers extra eBay policy
      // scrutiny. If the title has no bark/shock/training signals, use 116381 instead.
      const isBarkCollarSuggestion = suggested === "66774";
      const titleHasBarkSignals = /bark|shock|static|electric|training collar|remote collar|e-collar|anti.?bark/i.test(title);
      // Override: Taxonomy API returns 19591 (Lighting Kits) for phone mount queries —
      // completely wrong. Fall through to original CN category or use a known electronics leaf.
      const isLightingKitsSuggestion = suggested === "19591";
      const titleHasLightingSignals = /light kit|led kit|lighting kit|underglow|light strip/i.test(title);

      let finalSuggested = suggested;
      if (isBarkCollarSuggestion && !titleHasBarkSignals) {
        finalSuggested = "116381";
        console.log(`[category] Overriding 66774 (Bark Collars) → 116381 (Dog Collars & Tags) — no bark signals in title`);
      } else if (isLightingKitsSuggestion && !titleHasLightingSignals) {
        // For phone mounts / car mounts, use CN seller's original category directly —
        // it's more reliable than a wrong Taxonomy API suggestion.
        // Return null so getVerifiedLeafCategory falls through to the original CN category.
        console.log(`[category] Overriding 19591 (Lighting Kits) → skipping, will use CN category — no lighting signals`);
        finalSuggested = "";
      }

      if (finalSuggested) {
        const suggestedType = CATEGORY_TYPES[finalSuggested] ?? detectTypeFromTitle(title);
        console.log(`[category] Taxonomy suggestion: ${finalSuggested} (${suggestedType})`);
        return { id: finalSuggested, type: suggestedType };
      }
    }
  } catch (e) {
    console.warn("[category] Taxonomy API error:", e);
  }

  // Step 4 — original category from CN seller
  if (originalCategoryId && originalCategoryId !== keywordMatch.id) {
    const origIsLeaf = await validateLeafCategory(originalCategoryId, appToken);
    if (origIsLeaf) {
      const origType = CATEGORY_TYPES[originalCategoryId] ?? detectTypeFromTitle(title);
      console.log(`[category] original ${originalCategoryId} ✅ leaf`);
      return { id: originalCategoryId, type: origType };
    }
  }

  // Step 5 — absolute fallback
  console.log(`[category] ⚠️ All sources failed — using fallback 20625`);
  return { id: "20625", type: "home_kitchen" };
}

// ─── Detect category type from title (when category ID not in map) ────────────
export function detectTypeFromTitle(title: string): CategoryType {
  const match = matchCategoryByTitle(title);
  return match.type;
}

// ─── Aspect value inference helpers ───────────────────────────────────────────

function inferDepartment(t: string, defaultDept: "Men" | "Women" | "Kids" | "Unisex Adults"): string {
  if (t.includes("men") || t.includes("male") || t.includes("boys") || t.includes("boy's"))
    return "Men";
  if (t.includes("women") || t.includes("female") || t.includes("ladies") || t.includes("girls") || t.includes("girl's"))
    return "Women";
  if (t.includes("kids") || t.includes("children") || t.includes("child") || t.includes("baby") || t.includes("toddler"))
    return "Kids";
  if (t.includes("unisex")) return "Unisex Adults";
  return defaultDept;
}

function inferStyle(t: string, category: CategoryType): string {
  if (category.startsWith("footwear")) {
    if (t.includes("casual") || t.includes("loafer") || t.includes("mule") || t.includes("slip")) return "Casual";
    if (t.includes("sport") || t.includes("running") || t.includes("athletic") || t.includes("gym")) return "Athletic";
    if (t.includes("formal") || t.includes("dress") || t.includes("oxford") || t.includes("derby")) return "Formal";
    if (t.includes("outdoor") || t.includes("hiking") || t.includes("work boot")) return "Outdoor";
    if (t.includes("slipper") || t.includes("house")) return "Casual";
    return "Casual";
  }
  // Clothing
  if (t.includes("vintage") || t.includes("retro")) return "Vintage";
  if (t.includes("sport") || t.includes("athletic")) return "Athletic";
  if (t.includes("formal") || t.includes("business") || t.includes("office")) return "Formal";
  if (t.includes("boho") || t.includes("bohemian")) return "Boho";
  if (t.includes("streetwear") || t.includes("street")) return "Streetwear";
  return "Casual";
}

function inferFastening(t: string): string {
  if (t.includes("lace") || t.includes("lace-up") || t.includes("lace up")) return "Lace Up";
  if (t.includes("buckle")) return "Buckle";
  if (t.includes("velcro") || t.includes("hook and loop") || t.includes("hook & loop")) return "Hook & Loop";
  if (t.includes("zip") || t.includes("zipper")) return "Zip";
  if (t.includes("elastic")) return "Elastic";
  if (t.includes("slip") || t.includes("loafer") || t.includes("mule") || t.includes("slide") ||
      t.includes("slipper") || t.includes("sandal") || t.includes("flip flop")) return "Slip On";
  return "Slip On";
}

function inferUpperMaterial(t: string): string {
  if (t.includes("suede")) return "Suede";
  if (t.includes("leather")) return "Leather";
  if (t.includes("canvas")) return "Canvas";
  if (t.includes("mesh") || t.includes("knit")) return "Mesh";
  if (t.includes("fabric") || t.includes("textile")) return "Fabric";
  if (t.includes("rubber")) return "Rubber";
  if (t.includes("velvet")) return "Velvet";
  return "Synthetic";
}

function inferToeShape(t: string): string {
  if (t.includes("round toe") || t.includes("rounded")) return "Round Toe";
  if (t.includes("pointed") || t.includes("point") || t.includes("almond")) return "Pointed Toe";
  if (t.includes("square") || t.includes("block")) return "Square Toe";
  if (t.includes("open toe") || t.includes("peep")) return "Open Toe";
  if (t.includes("round")) return "Round Toe";
  return "Round Toe";
}

function inferHeelType(t: string): string {
  if (t.includes("stiletto")) return "Stiletto";
  if (t.includes("block heel") || t.includes("block")) return "Block";
  if (t.includes("wedge")) return "Wedge";
  if (t.includes("kitten")) return "Kitten";
  if (t.includes("platform")) return "Platform";
  if (t.includes("cone")) return "Cone";
  if (t.includes("flat") || t.includes("no heel")) return "Flat";
  return "Flat";
}

function inferHeelHeight(t: string): string {
  if (t.includes("flat") || t.includes("no heel") || t.includes("loafer") ||
      t.includes("sandal") || t.includes("slipper") || t.includes("slide")) return "Flat (0 to 1/2 in.)";
  if (t.includes("kitten")) return "Kitten (1 to 1 1/2 in.)";
  if (t.includes("low heel") || t.includes("block") || t.includes("chunky")) return "Low (1 1/2 to 2 1/2 in.)";
  if (t.includes("mid") || t.includes("medium heel")) return "Medium (2 1/2 to 3 in.)";
  if (t.includes("high heel") || t.includes("stiletto") || t.includes("pumps")) return "High (3 in. & Above)";
  return "Flat (0 to 1/2 in.)";
}

function inferOccasion(t: string, category: CategoryType): string {
  if (t.includes("sport") || t.includes("running") || t.includes("gym") || t.includes("athletic"))
    return "Athletic";
  if (t.includes("formal") || t.includes("dress") || t.includes("office") || t.includes("business"))
    return "Formal";
  if (t.includes("outdoor") || t.includes("hiking") || t.includes("beach"))
    return category.startsWith("footwear") ? "Outdoor" : "Casual";
  if (t.includes("party") || t.includes("evening") || t.includes("wedding") || t.includes("prom"))
    return "Evening";
  return "Casual";
}

function inferMaterial(t: string): string {
  if (t.includes("stainless") || t.includes("steel") || t.includes("metal") ||
      t.includes("aluminum") || t.includes("alloy")) return "Metal";
  if (t.includes("ceramic")) return "Ceramic";
  if (t.includes("plastic") || t.includes("acrylic") || t.includes("pvc")) return "Plastic";
  if (t.includes("bamboo")) return "Bamboo";
  if (t.includes("wood") || t.includes("wooden")) return "Wood";
  if (t.includes("glass")) return "Glass";
  if (t.includes("silicone")) return "Silicone";
  if (t.includes("foam") || t.includes("memory foam")) return "Foam";
  if (t.includes("nylon")) return "Nylon";
  if (t.includes("leather")) return "Leather";
  if (t.includes("cotton")) return "Cotton";
  if (t.includes("polyester")) return "Polyester";
  if (t.includes("fleece")) return "Fleece";
  if (t.includes("wool")) return "Wool";
  if (t.includes("rubber")) return "Rubber";
  return "Mixed Materials";
}

function inferColor(t: string): string {
  const colors: Record<string, string> = {
    black: "Black", white: "White", gray: "Gray", grey: "Gray",
    red: "Red", blue: "Blue", green: "Green", yellow: "Yellow",
    orange: "Orange", purple: "Purple", pink: "Pink", brown: "Brown",
    beige: "Beige", tan: "Tan", gold: "Gold", silver: "Silver",
    navy: "Navy Blue", khaki: "Khaki", olive: "Olive", cream: "Cream",
    burgundy: "Burgundy", coral: "Coral", teal: "Teal",
    stainless: "Silver", transparent: "Clear", clear: "Clear",
    bamboo: "Brown", wood: "Brown",
  };
  for (const [kw, val] of Object.entries(colors)) {
    if (t.includes(kw)) return val;
  }
  return "Multicolor";
}

function inferSleeve(t: string): string {
  if (t.includes("sleeveless") || t.includes("no sleeve") || t.includes("tank")) return "Sleeveless";
  if (t.includes("short sleeve") || t.includes("short-sleeve") || t.includes("t-shirt") ||
      t.includes("tshirt") || t.includes("tee ")) return "Short Sleeve";
  if (t.includes("3/4") || t.includes("three quarter")) return "3/4 Sleeve";
  return "Long Sleeve";
}

function inferNeckline(t: string): string {
  if (t.includes("v-neck") || t.includes("vneck") || t.includes("v neck")) return "V-Neck";
  if (t.includes("turtleneck") || t.includes("mock neck") || t.includes("polo"))
    return "Turtleneck";
  if (t.includes("hooded") || t.includes("hoodie")) return "Hooded";
  if (t.includes("off shoulder")) return "Off the Shoulder";
  if (t.includes("crew")) return "Crew Neck";
  if (t.includes("scoop")) return "Scoop Neck";
  if (t.includes("collar")) return "Collared";
  return "Round Neck";
}

function inferPattern(t: string): string {
  if (t.includes("floral") || t.includes("flower")) return "Floral";
  if (t.includes("stripe") || t.includes("striped")) return "Striped";
  if (t.includes("plaid") || t.includes("check") || t.includes("tartan")) return "Plaid";
  if (t.includes("polka") || t.includes("dot")) return "Polka Dot";
  if (t.includes("camo") || t.includes("camouflage")) return "Camouflage";
  if (t.includes("animal") || t.includes("leopard") || t.includes("zebra")) return "Animal Print";
  if (t.includes("graphic") || t.includes("print")) return "Graphic Print";
  if (t.includes("abstract")) return "Abstract";
  return "Solid";
}

function inferPetMaterial(t: string): string {
  if (t.includes("stainless") || t.includes("steel") || t.includes("chain") ||
      t.includes("metal") || t.includes("alloy")) return "Metal";
  if (t.includes("leather")) return "Leather";
  if (t.includes("nylon")) return "Nylon";
  if (t.includes("rope") || t.includes("cotton")) return "Cotton";
  if (t.includes("rubber") || t.includes("silicone")) return "Rubber";
  if (t.includes("polyester")) return "Polyester";
  return "Nylon";
}

// ─── Aspect filters by category type ─────────────────────────────────────────
// Which aspect keys are VALID for each category type.
// Ref aspects outside this set are stripped to prevent eBay rejections.
// "always" = present in all categories.

const ALWAYS_VALID = new Set(["brand", "mpn"]);

const VALID_ASPECTS: Record<CategoryType, Set<string>> = {
  footwear_men: new Set([
    "department", "style", "fastening", "upper material", "toe shape",
    "occasion", "heel type", "insole material", "sole material",
    "lining material", "shoe width", "type", "color", "material",
    "size", "size type", "us shoe size", "uk shoe size", "eu shoe size",
    "performance/activity", "pattern", "closure", "shaft style",
  ]),
  footwear_women: new Set([
    "department", "style", "fastening", "upper material", "toe shape",
    "occasion", "heel height", "heel type", "insole material", "sole material",
    "lining material", "shoe width", "type", "color", "material",
    "size", "size type", "us shoe size", "uk shoe size", "eu shoe size",
    "performance/activity", "pattern", "closure", "shaft style",
  ]),
  footwear_kids: new Set([
    "department", "style", "fastening", "upper material", "toe shape",
    "occasion", "color", "material", "size", "size type", "us shoe size",
    "type", "pattern", "closure",
  ]),
  clothing_men: new Set([
    "department", "style", "sleeve length", "neckline", "occasion",
    "pattern", "type", "color", "material", "size", "fit", "rise",
    "theme", "season",
  ]),
  clothing_women: new Set([
    "department", "style", "sleeve length", "neckline", "occasion",
    "pattern", "type", "color", "material", "size", "fit", "rise",
    "theme", "season",
  ]),
  clothing_kids: new Set([
    "department", "style", "sleeve length", "occasion", "pattern",
    "type", "color", "material", "size", "theme",
  ]),
  pet_dog: new Set([
    "material", "color", "size", "type", "features", "closure",
    "width", "length", "weight capacity",
  ]),
  pet_cat: new Set([
    "material", "color", "size", "type", "features", "closure",
    "width", "length",
  ]),
  pet_generic: new Set(["material", "color", "size", "type", "features"]),
  home_kitchen: new Set([
    "material", "color", "type", "size", "capacity", "volume",
    "shape", "style", "finish", "features", "occasion",
  ]),
  home_decor: new Set([
    "material", "color", "type", "style", "size", "shape",
    "finish", "theme", "occasion",
  ]),
  home_textile: new Set([
    "material", "color", "type", "size", "fill material",
    "thread count", "pattern", "style", "features",
  ]),
  electronics: new Set([
    "type", "color", "material", "compatible model", "connectivity",
    "features", "interface", "power source",
  ]),
  jewelry: new Set([
    "material", "color", "metal", "type", "style", "size",
    "length", "stone", "gemstone", "occasion", "finish",
  ]),
  bags: new Set([
    "material", "color", "style", "size", "closure", "type",
    "features", "occasion", "strap drop",
  ]),
  sports: new Set([
    "type", "color", "material", "size", "features",
    "sport", "activity",
  ]),
  tools: new Set(["type", "color", "material", "size", "features", "power source"]),
  generic: new Set(["type", "color", "material", "size", "style", "features"]),
};

// ─── Main: build smart ItemSpecifics for a category ──────────────────────────
/**
 * Builds the optimal set of ItemSpecifics for an eBay listing.
 *
 * Algorithm:
 *   1. Filter refAspects to only valid keys for this category type
 *   2. Add required/recommended aspects from eBay API (if we fetched them)
 *   3. Infer missing required values from title keywords
 *   4. Always add Brand=Unbranded and MPN=Does Not Apply
 *   5. Truncate values to 65 chars, strip Chinese, limit to 5 values each
 *
 * @param title           Product title (already cleaned, no Chinese)
 * @param categoryType    Detected category type
 * @param refAspects      Raw aspects from CN seller's listing (may be polluted)
 * @param requiredAspects Aspects from eBay's get_item_aspects_for_category API
 */
export function buildSmartAspects(
  title: string,
  categoryType: CategoryType,
  refAspects: Record<string, string[]>,
  requiredAspects: AspectInfo[] = [],
): Record<string, string[]> {
  const t = title.toLowerCase();
  const isChinese = (v: string) => /[\u4e00-\u9fff]/.test(v);

  // ── Step 1: filter refAspects by category type ────────────────────────────
  const validKeys = VALID_ASPECTS[categoryType] ?? VALID_ASPECTS.generic;
  const aspects: Record<string, string[]> = {};

  for (const [key, values] of Object.entries(refAspects)) {
    const keyLower = key.toLowerCase();
    if (ALWAYS_VALID.has(keyLower) || validKeys.has(keyLower)) {
      // Filter Chinese values, truncate, limit count
      const cleaned = values
        .filter((v) => !isChinese(v) && v.trim().length > 0)
        .map((v) => v.slice(0, 65).trim())
        .slice(0, 5);
      if (cleaned.length > 0) aspects[key] = cleaned;
    }
  }

  // ── Step 2: Add required aspects from API (override if already present) ───
  if (requiredAspects.length > 0) {
    const requiredNames = new Set(
      requiredAspects.filter((a) => a.required).map((a) => a.name.toLowerCase())
    );
    // Make sure no required aspect is accidentally missing after filtering
    for (const aspect of requiredAspects.filter((a) => a.required)) {
      if (!aspects[aspect.name]) {
        aspects[aspect.name] = []; // placeholder, filled in step 3
      }
    }
    // Remove ref values for required aspects if they're SELECTION_ONLY with valid values
    // (ref values might be invalid for the new category)
    for (const aspect of requiredAspects.filter((a) => a.required && a.selectionOnly && a.validValues.length > 0)) {
      if (aspects[aspect.name]) {
        const valid = new Set(aspect.validValues.map((v) => v.toLowerCase()));
        const filtered = (aspects[aspect.name]).filter((v) => valid.has(v.toLowerCase()));
        if (filtered.length > 0) aspects[aspect.name] = filtered;
        else delete aspects[aspect.name]; // will be re-inferred
      }
    }
    // Track required
    void requiredNames; // used for clarity
  }

  // ── Step 3: infer by category type ────────────────────────────────────────
  switch (categoryType) {
    case "footwear_men":
      aspects["Department"]     = ["Men"];
      if (!aspects["Style"])          aspects["Style"]          = [inferStyle(t, categoryType)];
      if (!aspects["Fastening"])      aspects["Fastening"]      = [inferFastening(t)];
      if (!aspects["Upper Material"]) aspects["Upper Material"] = [inferUpperMaterial(t)];
      if (!aspects["Toe Shape"])      aspects["Toe Shape"]      = [inferToeShape(t)];
      if (!aspects["Occasion"])       aspects["Occasion"]       = [inferOccasion(t, categoryType)];
      if (!aspects["Heel Type"])      aspects["Heel Type"]      = [inferHeelType(t)];
      if (!aspects["Color"])          aspects["Color"]          = [inferColor(t)];
      // Size Type is always required for eBay footwear categories.
      // "Regular" covers ~95% of standard-width shoes.
      if (!aspects["Size Type"])      aspects["Size Type"]      = [
        t.includes("wide") ? "Wide" :
        t.includes("narrow") ? "Narrow" :
        t.includes("extra wide") ? "Extra Wide" :
        "Regular"
      ];
      // Size: eBay requires it even for variation products (category-specific).
      // When shoe size is in variations (US Shoe Size), we still need a value here.
      // addFixedPriceItem will filter out the variant-dimension aspects from
      // ItemSpecifics but Size (generic) stays — put a sensible default.
      if (!aspects["Size"])           aspects["Size"]           = ["US 8"];
      break;

    case "footwear_women":
      aspects["Department"]     = ["Women"];
      if (!aspects["Style"])          aspects["Style"]          = [inferStyle(t, categoryType)];
      if (!aspects["Fastening"])      aspects["Fastening"]      = [inferFastening(t)];
      if (!aspects["Upper Material"]) aspects["Upper Material"] = [inferUpperMaterial(t)];
      if (!aspects["Toe Shape"])      aspects["Toe Shape"]      = [inferToeShape(t)];
      if (!aspects["Occasion"])       aspects["Occasion"]       = [inferOccasion(t, categoryType)];
      if (!aspects["Heel Type"])      aspects["Heel Type"]      = [inferHeelType(t)];
      if (!aspects["Heel Height"])    aspects["Heel Height"]    = [inferHeelHeight(t)];
      if (!aspects["Color"])          aspects["Color"]          = [inferColor(t)];
      if (!aspects["Size Type"])      aspects["Size Type"]      = [
        t.includes("wide") ? "Wide" :
        t.includes("narrow") ? "Narrow" :
        "Regular"
      ];
      if (!aspects["Size"])           aspects["Size"]           = ["US 7"];
      break;

    case "footwear_kids":
      aspects["Department"]     = [
        t.includes("boy") ? "Boys" : t.includes("girl") ? "Girls" : "Kids",
      ];
      if (!aspects["Style"])     aspects["Style"]     = [inferStyle(t, categoryType)];
      if (!aspects["Color"])     aspects["Color"]     = [inferColor(t)];
      if (!aspects["Occasion"])  aspects["Occasion"]  = [inferOccasion(t, categoryType)];
      if (!aspects["Size Type"]) aspects["Size Type"] = ["Regular"];
      if (!aspects["Size"])      aspects["Size"]      = ["US 4"];
      break;

    case "clothing_men":
      aspects["Department"] = [inferDepartment(t, "Men")];
      if (!aspects["Style"])          aspects["Style"]          = [inferStyle(t, categoryType)];
      if (!aspects["Sleeve Length"])  aspects["Sleeve Length"]  = [inferSleeve(t)];
      if (!aspects["Neckline"])       aspects["Neckline"]       = [inferNeckline(t)];
      if (!aspects["Occasion"])       aspects["Occasion"]       = [inferOccasion(t, categoryType)];
      if (!aspects["Pattern"])        aspects["Pattern"]        = [inferPattern(t)];
      if (!aspects["Color"])          aspects["Color"]          = [inferColor(t)];
      if (!aspects["Material"])       aspects["Material"]       = [inferMaterial(t)];
      break;

    case "clothing_women":
      aspects["Department"] = [inferDepartment(t, "Women")];
      if (!aspects["Style"])          aspects["Style"]          = [inferStyle(t, categoryType)];
      if (!aspects["Sleeve Length"])  aspects["Sleeve Length"]  = [inferSleeve(t)];
      if (!aspects["Neckline"])       aspects["Neckline"]       = [inferNeckline(t)];
      if (!aspects["Occasion"])       aspects["Occasion"]       = [inferOccasion(t, categoryType)];
      if (!aspects["Pattern"])        aspects["Pattern"]        = [inferPattern(t)];
      if (!aspects["Color"])          aspects["Color"]          = [inferColor(t)];
      if (!aspects["Material"])       aspects["Material"]       = [inferMaterial(t)];
      break;

    case "pet_dog":
    case "pet_cat":
    case "pet_generic":
      // NO Department, Style, Neckline, Sleeve Length — pet categories don't have these
      delete aspects["Department"];
      delete aspects["Style"];
      delete aspects["Sleeve Length"];
      delete aspects["Neckline"];
      delete aspects["Occasion"];
      delete aspects["Pattern"];
      if (!aspects["Material"]) aspects["Material"] = [inferPetMaterial(t)];
      if (!aspects["Color"])    aspects["Color"]    = [inferColor(t)];
      if (!aspects["Size"]) {
        const sizeMatch = title.match(/\b(xs|s|m|l|xl|xxl|small|medium|large|extra large)\b/i);
        aspects["Size"] = sizeMatch ? [sizeMatch[1]] : ["Medium"];
      }
      if (!aspects["Type"]) {
        if (t.includes("collar")) aspects["Type"] = ["Collar"];
        else if (t.includes("leash")) aspects["Type"] = ["Leash"];
        else if (t.includes("harness")) aspects["Type"] = ["Harness"];
        else if (t.includes("chain")) aspects["Type"] = ["Chain"];
      }
      break;

    case "home_kitchen":
      if (!aspects["Material"]) aspects["Material"] = [inferMaterial(t)];
      if (!aspects["Color"])    aspects["Color"]    = [inferColor(t)];
      if (!aspects["Type"]) {
        if (t.includes("mug") || t.includes("cup")) aspects["Type"] = ["Mug"];
        else if (t.includes("bottle")) aspects["Type"] = ["Water Bottle"];
        else if (t.includes("tumbler")) aspects["Type"] = ["Tumbler"];
        else if (t.includes("organizer") || t.includes("rack") || t.includes("holder"))
          aspects["Type"] = ["Organizer"];
        else if (t.includes("box")) aspects["Type"] = ["Storage Box"];
        else aspects["Type"] = ["Other"];
      }
      break;

    case "home_decor":
    case "home_textile":
      if (!aspects["Material"]) aspects["Material"] = [inferMaterial(t)];
      if (!aspects["Color"])    aspects["Color"]    = [inferColor(t)];
      if (!aspects["Type"]) {
        if (t.includes("pillow") || t.includes("cushion")) aspects["Type"] = ["Throw Pillow"];
        else if (t.includes("blanket") || t.includes("throw")) aspects["Type"] = ["Throw Blanket"];
        else if (t.includes("rug") || t.includes("mat")) aspects["Type"] = ["Rug"];
        else if (t.includes("lamp") || t.includes("light")) aspects["Type"] = ["Lamp"];
        else if (t.includes("frame")) aspects["Type"] = ["Picture Frame"];
        else if (t.includes("clock")) aspects["Type"] = ["Wall Clock"];
        else aspects["Type"] = ["Other"];
      }
      break;

    default:
      if (!aspects["Material"]) aspects["Material"] = [inferMaterial(t)];
      if (!aspects["Color"])    aspects["Color"]    = [inferColor(t)];
      if (!aspects["Type"])     aspects["Type"]     = ["Other"];
      break;
  }

  // ── Step 4: always-present aspects ────────────────────────────────────────
  aspects["Brand"] = (aspects["Brand"]?.filter((v) => !isChinese(v) && v.toLowerCase() !== "no brand" && v.trim().length > 0)) ?? [];
  if (aspects["Brand"].length === 0) aspects["Brand"] = ["Unbranded"];
  aspects["MPN"] = ["Does Not Apply"];

  // ── Step 5: final cleanup ─────────────────────────────────────────────────
  for (const key of Object.keys(aspects)) {
    aspects[key] = aspects[key]
      .filter((v) => !isChinese(v) && v.trim().length > 0)
      .map((v) => v.slice(0, 65).trim())
      .slice(0, 5);
    if (aspects[key].length === 0) delete aspects[key];
  }

  return aspects;
}

// ─── Option A: clean + supplement (REPLACES buildSmartAspects in normal flow) ─
/**
 * cleanAndSupplementAspects — the "Trust but verify" approach.
 *
 * The CN seller already published their listing → their aspects are valid.
 * We do NOT filter them aggressively. Instead:
 *
 *   1. CLEAN: strip Chinese values, reset Brand/MPN, truncate to 65 chars
 *   2. REMOVE: aspects that genuinely don't belong (e.g. "Department" in pet categories
 *      when CN seller mislabeled their listing)
 *   3. SUPPLEMENT: add only what's actually missing (Size Type for footwear,
 *      Department if absent, etc.)
 *
 * This is in contrast to buildSmartAspects which filtered aggressively through
 * VALID_ASPECTS and often threw away perfectly valid data the CN seller had.
 */
export function cleanAndSupplementAspects(
  refAspects: Record<string, string[]>,
  title: string,
  categoryType: CategoryType,
): Record<string, string[]> {
  const t = title.toLowerCase();
  const isChinese = (v: string) => /[\u4e00-\u9fff]/.test(v);

  // ── Step 1: clean refAspects — preserve everything, just sanitize ──────────
  const aspects: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(refAspects)) {
    const cleaned = values
      .filter((v) => !isChinese(v) && v.trim().length > 0)
      .map((v) => v.slice(0, 65).trim())
      .slice(0, 5);
    if (cleaned.length > 0) aspects[key] = cleaned;
  }

  // ── Step 2: always override Brand + MPN ────────────────────────────────────
  // CN seller's brand name would be a violation on our listing
  aspects["Brand"] = ["Unbranded"];
  aspects["MPN"]   = ["Does Not Apply"];

  // ── Step 3: category-specific cleanup + supplement ─────────────────────────
  switch (categoryType) {

    case "footwear_men":
    case "footwear_women":
    case "footwear_kids": {
      // Footwear needs Department, Size Type, Size — supplement only if missing
      const dept =
        categoryType === "footwear_men"   ? "Men"   :
        categoryType === "footwear_women" ? "Women" :
        t.includes("boy") ? "Boys" : t.includes("girl") ? "Girls" : "Kids";

      if (!aspects["Department"]) aspects["Department"] = [dept];
      // Override Department if CN seller put wrong gender (e.g. "Women" for men's shoes)
      // We trust the CATEGORY TYPE (footwear_men/women) more than the CN seller's value
      else aspects["Department"] = [dept];

      if (!aspects["Size Type"]) aspects["Size Type"] = [
        t.includes("wide")       ? "Wide"       :
        t.includes("extra wide") ? "Extra Wide" :
        t.includes("narrow")     ? "Narrow"     :
        "Regular"
      ];

      // Size: required by some eBay footwear categories even for variation products.
      // Add a representative value only if completely absent (CN might have it).
      if (!aspects["Size"] && !aspects["US Shoe Size"]) {
        aspects["Size"] = [dept === "Women" ? "US 7" : "US 9"];
      }

      if (!aspects["Style"])    aspects["Style"]    = [inferStyle(t, categoryType)];
      if (!aspects["Occasion"]) aspects["Occasion"] = [inferOccasion(t, categoryType)];
      // Color and Upper Material: supplement from title inference if CN seller didn't provide
      // These are required by eBay for most footwear categories.
      if (!aspects["Color"])          aspects["Color"]          = [inferColor(t)];
      if (!aspects["Upper Material"]) aspects["Upper Material"] = [inferUpperMaterial(t)];
      break;
    }

    case "clothing_men":
    case "clothing_women":
    case "clothing_kids": {
      const dept =
        categoryType === "clothing_men"   ? "Men"   :
        categoryType === "clothing_women" ? "Women" :
        t.includes("boy") ? "Boys" : t.includes("girl") ? "Girls" : "Kids";
      if (!aspects["Department"])    aspects["Department"]    = [dept];
      if (!aspects["Style"])         aspects["Style"]         = [inferStyle(t, categoryType)];
      if (!aspects["Sleeve Length"]) aspects["Sleeve Length"] = [inferSleeve(t)];
      if (!aspects["Occasion"])      aspects["Occasion"]      = [inferOccasion(t, categoryType)];
      break;
    }

    case "pet_dog":
    case "pet_cat":
    case "pet_generic":
      // REMOVE clothing-specific aspects — CN sellers sometimes list pet products
      // in fashion categories, so their refAspects may contain "Department: Women",
      // "Style: Casual", "Sleeve Length", etc. These cause eBay rejections.
      delete aspects["Department"];
      delete aspects["Style"];
      delete aspects["Sleeve Length"];
      delete aspects["Neckline"];
      delete aspects["Occasion"];
      delete aspects["Pattern"];
      delete aspects["Heel Type"];
      delete aspects["Heel Height"];
      delete aspects["Size Type"];
      delete aspects["Fastening"];
      delete aspects["Upper Material"];
      delete aspects["Toe Shape"];
      // Supplement pet-specific aspects if missing
      if (!aspects["Material"]) aspects["Material"] = [inferPetMaterial(t)];
      if (!aspects["Color"])    aspects["Color"]    = [inferColor(t)];
      break;

    case "electronics":
      // Remove clothing/footwear aspects if CN seller mislabeled
      delete aspects["Department"];
      delete aspects["Style"];
      delete aspects["Size Type"];
      delete aspects["Sleeve Length"];
      // Type is required in many electronics categories
      if (!aspects["Type"]) {
        if (t.includes("mount") || t.includes("holder") || t.includes("stand"))
          aspects["Type"] = [t.includes("car") || t.includes("vehicle") ? "Car Mount" : "Phone Stand"];
        else if (t.includes("charger") || t.includes("charging"))
          aspects["Type"] = [t.includes("wireless") ? "Wireless Charger" : "Car Charger"];
        else if (t.includes("cable"))    aspects["Type"] = ["USB Cable"];
        else if (t.includes("adapter"))  aspects["Type"] = ["Power Adapter"];
        else if (t.includes("case"))     aspects["Type"] = ["Phone Case"];
        else if (t.includes("screen"))   aspects["Type"] = ["Screen Protector"];
        else aspects["Type"] = ["Other"];
      }
      if (!aspects["Color"]) aspects["Color"] = [inferColor(t)];
      break;
  }

  // ── Step 4: final cleanup ──────────────────────────────────────────────────
  for (const key of Object.keys(aspects)) {
    aspects[key] = aspects[key]
      .filter((v) => !isChinese(v) && v.trim().length > 0)
      .map((v) => v.slice(0, 65).trim())
      .slice(0, 5);
    if (aspects[key].length === 0) delete aspects[key];
  }

  return aspects;
}