import { NextRequest, NextResponse } from "next/server";
import { getAppToken } from "@/lib/ebay";
import { db } from "@/lib/firebase";

// ─── Constants ────────────────────────────────────────────────────────────────
const SELLERS_COLLECTION = "discovered_sellers";
const SETTINGS_DOC       = "discover_sellers_settings";
const TOP_SELLERS        = 50;
const ITEMS_PER_CATEGORY = 200; // Browse API max per request

// Default listing range — user can override via /api/ebay/discover-sellers (PATCH)
const DEFAULT_MIN_LISTINGS = 200;
const DEFAULT_MAX_LISTINGS = 10_000;

// ─── Categories to scan — verified leaf IDs, diverse niches ──────────────────
const SCAN_CATEGORIES: { id: string; name: string }[] = [
  // Home & Kitchen
  { id: "20625",  name: "Kitchen Storage"      },
  { id: "20686",  name: "Mugs & Cups"           },
  { id: "20579",  name: "Water Bottles"         },
  { id: "20697",  name: "Lamps"                 },
  { id: "20455",  name: "Pillows"               },
  { id: "20460",  name: "Blankets"              },
  { id: "20461",  name: "Towels"                },
  { id: "20580",  name: "Rugs & Mats"           },
  { id: "3815",   name: "Clocks"                },
  { id: "92074",  name: "Picture Frames"        },
  { id: "116656", name: "Vases & Planters"      },
  // Pet
  { id: "116381", name: "Dog Collars"           },
  { id: "66863",  name: "Dog Leashes"           },
  { id: "20742",  name: "Dog Supplies"          },
  // Fashion & Accessories
  { id: "45333",  name: "Men's Loafers"         },
  { id: "55793",  name: "Women's Boots"         },
  { id: "55791",  name: "Women's Heels"         },
  { id: "57988",  name: "Women's Sneakers"      },
  { id: "63861",  name: "Women's Dresses"       },
  { id: "63862",  name: "Women's Tops"          },
  // Fitness & Outdoor
  { id: "158902", name: "Fitness Equipment"     },
  { id: "169291", name: "Travel Accessories"    },
  // Tech accessories (unbranded)
  { id: "139762", name: "Outlet Adapters"       },
  { id: "175759", name: "Phone Accessories"     },
  // Jewelry
  { id: "10968",  name: "Fashion Necklaces"     },
  { id: "10978",  name: "Fashion Earrings"      },
  { id: "10986",  name: "Fashion Bracelets"     },
  // Garden & Outdoor
  { id: "20612",  name: "Portable Fans"         },
  { id: "28071",  name: "Solar Garden Lights"   },
  { id: "2996",   name: "Home Decor Accents"    },
];

export interface SavedSeller {
  id?:              string;
  username:         string;
  storeUrl:         string;
  userUrl:          string;
  totalListings:    number;
  appearances:      number;   // how many times seen across category scans
  uniqueQueries:    number;   // how many distinct categories they appeared in
  topSoldQty:       number;
  totalSoldQty:     number;
  categoriesFound:  string[];
  sampleTitles:     string[];
  score:            number;
  discoveredAt:     number;
  category?:        string;   // legacy field — kept for UI compatibility
}

// ─── Load configurable listing range from Firestore ───────────────────────────
async function getListingRange(): Promise<{ min: number; max: number }> {
  try {
    const snap = await db.collection(SETTINGS_DOC).doc("config").get();
    if (snap.exists) {
      const d = snap.data() as { minListings?: number; maxListings?: number };
      return {
        min: d.minListings ?? DEFAULT_MIN_LISTINGS,
        max: d.maxListings ?? DEFAULT_MAX_LISTINGS,
      };
    }
  } catch { /* use defaults */ }
  return { min: DEFAULT_MIN_LISTINGS, max: DEFAULT_MAX_LISTINGS };
}

// ─── Browse API: search top items from CN sellers in a category ───────────────
// Sort options: BEST_MATCH (most relevant) | NEWLY_LISTED | PRICE_HIGH | PRICE_LOW
async function searchCNItemsInCategory(
  categoryId: string,
  token: string,
  limit = ITEMS_PER_CATEGORY,
): Promise<{ username: string; title: string; soldQty: number; feedbackScore: number }[]> {
  const params = new URLSearchParams({
    category_ids: categoryId,
    limit:        String(Math.min(limit, 200)),
    sort:         "BEST_MATCH",
    filter:       "itemLocationCountry:CN,conditions:{NEW},buyingOptions:{FIXED_PRICE}",
    fieldgroups:  "EXTENDED",
  });

  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      {
        headers: {
          Authorization:             `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        signal: AbortSignal.timeout(12000),
      }
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[discover-sellers] Browse API ${res.status} cat=${categoryId}: ${txt.slice(0, 100)}`);
      return [];
    }

    const data = await res.json() as {
      itemSummaries?: Array<{
        seller?: { username?: string; feedbackScore?: number; feedbackPercentage?: string };
        title?:  string;
        itemId?: string;
        unitSoldCount?: number;
        additionalImages?: unknown[];
        itemLocation?: { country?: string };
      }>;
      total?: number;
    };

    console.log(`[discover-sellers]   cat=${categoryId} → ${data.total ?? 0} total, ${data.itemSummaries?.length ?? 0} returned`);

    const results: { username: string; title: string; soldQty: number; feedbackScore: number }[] = [];

    for (const item of data.itemSummaries ?? []) {
      const username = item.seller?.username;
      if (!username) continue;

      // Double-check CN location (some items slip through)
      const country = item.itemLocation?.country ?? "";
      if (country && !["CN", "HK", "TW"].includes(country.toUpperCase())) continue;

      results.push({
        username,
        title:         (item.title ?? "").slice(0, 65),
        soldQty:       item.unitSoldCount ?? 0,
        feedbackScore: item.seller?.feedbackScore ?? 0,
      });
    }

    return results;
  } catch (e) {
    console.warn(`[discover-sellers] searchCNItems error cat=${categoryId}:`, e);
    return [];
  }
}

// ─── Verify listing count for a seller via Browse API ─────────────────────────
// KEY FIX: do NOT filter by itemLocationCountry when verifying — some CN sellers
// ship from US warehouses. Just count all their NEW Fixed Price items.
async function getSellerListingCount(seller: string, token: string): Promise<number> {
  const params = new URLSearchParams({
    q:      "a",
    limit:  "1",
    filter: `sellers:{${seller}},buyingOptions:{FIXED_PRICE},conditions:{NEW}`,
  });

  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      {
        headers: {
          Authorization:             `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return 0;
    const data = await res.json() as { total?: number };
    return data.total ?? 0;
  } catch {
    return 0;
  }
}

// ─── GET — load saved sellers ──────────────────────────────────────────────────
export async function GET() {
  try {
    const [sellersSnap, settingsSnap] = await Promise.all([
      db.collection(SELLERS_COLLECTION).orderBy("score", "desc").limit(200).get(),
      db.collection(SETTINGS_DOC).doc("config").get(),
    ]);

    const sellers = sellersSnap.docs.map(d => ({ id: d.id, ...d.data() } as SavedSeller));

    const settings = settingsSnap.exists
      ? (settingsSnap.data() as { minListings?: number; maxListings?: number })
      : { minListings: DEFAULT_MIN_LISTINGS, maxListings: DEFAULT_MAX_LISTINGS };

    return NextResponse.json({
      success: true,
      sellers,
      settings: {
        minListings: settings.minListings ?? DEFAULT_MIN_LISTINGS,
        maxListings: settings.maxListings ?? DEFAULT_MAX_LISTINGS,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ─── PATCH — update discover settings (minListings / maxListings) ─────────────
export async function PATCH(req: NextRequest) {
  try {
    const { minListings, maxListings } = await req.json() as {
      minListings?: number;
      maxListings?: number;
    };

    const update: Record<string, number> = {};
    if (typeof minListings === "number" && minListings >= 1)   update.minListings = minListings;
    if (typeof maxListings === "number" && maxListings >= 100) update.maxListings = maxListings;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    await db.collection(SETTINGS_DOC).doc("config").set(update, { merge: true });
    return NextResponse.json({ success: true, updated: update });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ─── POST — scan Browse API across categories to find top CN sellers ──────────
export async function POST(_req: NextRequest) {
  try {
    const token = await getAppToken();
    const { min: minListings, max: maxListings } = await getListingRange();

    console.log(`\n[discover-sellers] 🔍 Scanning ${SCAN_CATEGORIES.length} categories | listing range: ${minListings.toLocaleString()}-${maxListings.toLocaleString()}`);

    // ── Aggregate seller signals across all categories ─────────────────────
    const aggregate: Record<string, {
      appearances:   number;
      categories:    Set<string>;
      titles:        string[];
      topSoldQty:    number;
      totalSoldQty:  number;
      feedbackScore: number;
    }> = {};

    for (const cat of SCAN_CATEGORIES) {
      console.log(`[discover-sellers] 📦 ${cat.name} (cat ${cat.id})`);

      const items = await searchCNItemsInCategory(cat.id, token);

      for (const { username, title, soldQty, feedbackScore } of items) {
        if (!aggregate[username]) {
          aggregate[username] = {
            appearances:   0,
            categories:    new Set(),
            titles:        [],
            topSoldQty:    0,
            totalSoldQty:  0,
            feedbackScore: 0,
          };
        }
        aggregate[username].appearances++;
        aggregate[username].categories.add(cat.name);
        aggregate[username].topSoldQty   = Math.max(aggregate[username].topSoldQty, soldQty);
        aggregate[username].totalSoldQty += soldQty;
        aggregate[username].feedbackScore = Math.max(aggregate[username].feedbackScore, feedbackScore);

        if (aggregate[username].titles.length < 3 && title) {
          aggregate[username].titles.push(title);
        }
      }

      console.log(`[discover-sellers]   → ${items.length} CN items, sellers seen: ${Object.keys(aggregate).length}`);
      await new Promise(r => setTimeout(r, 150));
    }

    const totalUnique = Object.keys(aggregate).length;
    console.log(`[discover-sellers] Found ${totalUnique} unique CN sellers across all categories`);

    if (totalUnique === 0) {
      return NextResponse.json({
        success: false,
        found: 0,
        sellers: [],
        message: "No se encontraron vendedores CN. Verifica que la Browse API esté activa.",
      });
    }

    // ── Pre-score without listing count (fast sort) ────────────────────────
    // Score: appearances (breadth) × categories (diversity) × feedback
    const preSorted = Object.entries(aggregate)
      .map(([username, d]) => ({
        username,
        preScore: d.appearances * 2 + d.categories.size * 5 + Math.log1p(d.feedbackScore),
        ...d,
      }))
      .sort((a, b) => b.preScore - a.preScore);

    // ── Verify listing count for top 150 candidates ────────────────────────
    // We check more candidates than TOP_SELLERS because many will be filtered by range
    const CANDIDATES_TO_CHECK = Math.min(150, preSorted.length);
    console.log(`[discover-sellers] Verifying listing counts for top ${CANDIDATES_TO_CHECK} candidates...`);

    const qualified: SavedSeller[] = [];
    let checked = 0;

    for (const candidate of preSorted.slice(0, CANDIDATES_TO_CHECK)) {
      if (qualified.length >= TOP_SELLERS) break;
      checked++;

      const totalListings = await getSellerListingCount(candidate.username, token);

      if (totalListings < minListings || totalListings > maxListings) {
        console.log(`[discover-sellers] SKIP ${candidate.username} — ${totalListings} listings (range: ${minListings}-${maxListings})`);
        await new Promise(r => setTimeout(r, 60));
        continue;
      }

      // Final score: appearances + category diversity + feedback + listing count signal
      const score = Math.round(
        candidate.appearances    * 10 +
        candidate.categories.size * 25 +
        Math.log1p(candidate.feedbackScore) * 5 +
        Math.log1p(totalListings) * 8
      );

      const seller: SavedSeller = {
        username:        candidate.username,
        storeUrl:        `https://www.ebay.com/str/${candidate.username}`,
        userUrl:         `https://www.ebay.com/sch/i.html?_ssn=${candidate.username}&_ipg=240&_sop=12`,
        totalListings,
        appearances:     candidate.appearances,
        uniqueQueries:   candidate.categories.size,
        topSoldQty:      candidate.topSoldQty,
        totalSoldQty:    candidate.totalSoldQty,
        categoriesFound: Array.from(candidate.categories),
        sampleTitles:    candidate.titles,
        score,
        discoveredAt:    Date.now(),
        // Legacy field for UI grouping — use most frequent category
        category:        Array.from(candidate.categories)[0] ?? "General",
      };

      await db.collection(SELLERS_COLLECTION).doc(candidate.username).set(seller, { merge: true });
      qualified.push(seller);

      console.log(
        `[discover-sellers] ✅ ${candidate.username} — ${totalListings.toLocaleString()} listings | ` +
        `${candidate.appearances} appearances | ${candidate.categories.size} niches | score: ${score}`
      );

      await new Promise(r => setTimeout(r, 120));
    }

    console.log(`[discover-sellers] ✅ Done — ${qualified.length} sellers saved | ${checked} checked`);

    return NextResponse.json({
      success: true,
      found:   qualified.length,
      sellers: qualified.sort((a, b) => b.score - a.score),
      message: qualified.length === 0
        ? `Se escanearon ${totalUnique} vendedores CN pero ninguno tiene entre ${minListings.toLocaleString()} y ${maxListings.toLocaleString()} listings. Ajusta el rango en configuración.`
        : `${qualified.length} vendedores encontrados de ${totalUnique} únicos escaneados.`,
    });

  } catch (e) {
    console.error("[discover-sellers] ❌", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ─── DELETE — remove a saved seller ───────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  try {
    const { username } = await req.json() as { username: string };
    if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });
    await db.collection(SELLERS_COLLECTION).doc(username).delete();
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}