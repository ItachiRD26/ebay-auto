import { NextRequest, NextResponse } from "next/server";
import { getAppToken } from "@/lib/ebay";
import { db } from "@/lib/firebase";

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_LISTINGS    = 50;
const MAX_LISTINGS    = 10_000;
const MIN_SOLD_QTY    = 5;    // min sold quantity seen for at least one item from this seller
const TOP_PER_SCAN    = 40;
const SELLERS_COLLECTION = "discovered_sellers";

// Leaf categories to scan for best sellers — spread across niches
// These are verified eBay US leaf category IDs
const SCAN_CATEGORIES: { id: string; name: string }[] = [
  { id: "20625",  name: "Kitchen Storage"    },
  { id: "20742",  name: "Dog Supplies"       },
  { id: "116458", name: "Phone Mounts"       },
  { id: "37592",  name: "Cleaning Tools"     },
  { id: "169291", name: "Travel Accessories" },
  { id: "66862",  name: "Dog Collars"        },
  { id: "20686",  name: "Mugs"               },
  { id: "20697",  name: "Lamps"              },
  { id: "158902", name: "Fitness"            },
  { id: "20455",  name: "Pillows"            },
  { id: "116656", name: "Vases & Planters"   },
  { id: "139762", name: "Outlet Adapters"    },
  { id: "20579",  name: "Water Bottles"      },
  { id: "20580",  name: "Rugs & Mats"        },
  { id: "92074",  name: "Picture Frames"     },
  { id: "3815",   name: "Clocks"             },
  { id: "79651",  name: "Wall Organizers"    },
  { id: "20460",  name: "Blankets & Throws"  },
];

export interface SavedSeller {
  id?:              string;
  username:         string;
  storeUrl:         string;
  userUrl:          string;
  totalListings:    number;
  topSoldQty:       number;   // highest soldQuantity seen across their items
  totalSoldQty:     number;   // sum of soldQuantity across all seen items
  categoriesFound:  string[]; // which categories they appeared in
  sampleTitles:     string[];
  score:            number;
  discoveredAt:     number;
}

// ─── Buy Marketing API — best sellers by category ─────────────────────────────
async function getBestSellersInCategory(
  categoryId: string,
  token: string
): Promise<{ username: string; soldQty: number; title: string }[]> {
  const params = new URLSearchParams({
    category_id:  categoryId,
    metric_name:  "BEST_SELLING",
    limit:        "50",
  });

  const res = await fetch(
    `https://api.ebay.com/buy/marketing/v1_beta/merchandised_product?${params}`,
    {
      headers: {
        Authorization:              `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID":  "EBAY_US",
        "Content-Type":             "application/json",
      },
      signal: AbortSignal.timeout(12000),
    }
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(`[discover-sellers] Marketing API ${res.status} for cat ${categoryId}: ${txt.slice(0, 120)}`);
    return [];
  }

  let data: {
    merchandisedProducts?: {
      itemId?:             string;
      title?:              string;
      marketingPrice?:     { soldQuantityInEbay?: number };
      additionalImages?:   unknown[];
      seller?:             { username?: string; feedbackScore?: number; feedbackPercentage?: string };
      itemLocation?:       { country?: string };
    }[];
  };

  try { data = await res.json(); } catch { return []; }

  const results: { username: string; soldQty: number; title: string }[] = [];

  for (const p of data.merchandisedProducts ?? []) {
    const username = p.seller?.username;
    if (!username) continue;

    // Only CN sellers
    const country = p.itemLocation?.country ?? "";
    if (!["CN","HK","TW"].includes(country.toUpperCase())) continue;

    const soldQty = p.marketingPrice?.soldQuantityInEbay ?? 0;
    if (soldQty < MIN_SOLD_QTY) continue;

    results.push({
      username,
      soldQty,
      title: (p.title ?? "").slice(0, 65),
    });
  }

  return results;
}

// ─── Verify listing count via Browse API ──────────────────────────────────────
async function getSellerListingCount(seller: string, token: string): Promise<number> {
  const params = new URLSearchParams({
    q:      "a",
    limit:  "1",
    filter: `sellers:{${seller}},buyingOptions:{FIXED_PRICE},conditions:{NEW},itemLocationCountry:CN`,
  });
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
  try { return ((await res.json()) as { total?: number }).total ?? 0; } catch { return 0; }
}

// ─── GET — load saved sellers ─────────────────────────────────────────────────
export async function GET() {
  try {
    const snap = await db.collection(SELLERS_COLLECTION).orderBy("score", "desc").limit(200).get();
    const sellers = snap.docs.map(d => ({ id: d.id, ...d.data() } as SavedSeller));
    return NextResponse.json({ success: true, sellers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ─── POST — scan using Marketing API best sellers ─────────────────────────────
export async function POST(_req: NextRequest) {
  try {
    const token = await getAppToken();
    console.log(`[discover-sellers] Scanning ${SCAN_CATEGORIES.length} categories via Marketing API best sellers...`);

    // Aggregate seller data across all categories
    const aggregate: Record<string, {
      totalSoldQty:    number;
      topSoldQty:      number;
      categories:      Set<string>;
      titles:          string[];
    }> = {};

    for (const cat of SCAN_CATEGORIES) {
      console.log(`[discover-sellers] 📦 ${cat.name} (cat ${cat.id})`);
      const results = await getBestSellersInCategory(cat.id, token);

      for (const { username, soldQty, title } of results) {
        if (!aggregate[username]) {
          aggregate[username] = { totalSoldQty: 0, topSoldQty: 0, categories: new Set(), titles: [] };
        }
        aggregate[username].totalSoldQty += soldQty;
        aggregate[username].topSoldQty    = Math.max(aggregate[username].topSoldQty, soldQty);
        aggregate[username].categories.add(cat.name);
        if (aggregate[username].titles.length < 3 && title)
          aggregate[username].titles.push(title);
      }

      console.log(`[discover-sellers]   → ${results.length} CN sellers with soldQty >= ${MIN_SOLD_QTY}`);
      await new Promise(r => setTimeout(r, 200));
    }

    const uniqueSellers = Object.keys(aggregate).length;
    console.log(`[discover-sellers] ${uniqueSellers} unique CN sellers found with real sales data`);

    // Sort by score: categories (breadth) × topSoldQty (depth)
    const ranked = Object.entries(aggregate)
      .sort(([, a], [, b]) => {
        const sA = a.categories.size * Math.log1p(a.topSoldQty) * 10 + a.totalSoldQty;
        const sB = b.categories.size * Math.log1p(b.topSoldQty) * 10 + b.totalSoldQty;
        return sB - sA;
      });

    // Verify listing count for top candidates + save
    const qualified: SavedSeller[] = [];

    for (const [username, data] of ranked.slice(0, 100)) {
      if (qualified.length >= TOP_PER_SCAN) break;

      const totalListings = await getSellerListingCount(username, token);

      if (totalListings < MIN_LISTINGS || totalListings > MAX_LISTINGS) {
        console.log(`[discover-sellers] SKIP ${username} — ${totalListings} listings (out of ${MIN_LISTINGS}-${MAX_LISTINGS.toLocaleString()} range)`);
        await new Promise(r => setTimeout(r, 80));
        continue;
      }

      const score = Math.round(
        data.categories.size    * 30 +
        Math.log1p(data.topSoldQty)  * 20 +
        data.totalSoldQty            * 0.5 +
        Math.log1p(totalListings)    * 5
      );

      const seller: SavedSeller = {
        username,
        storeUrl:        `https://www.ebay.com/str/${username}`,
        userUrl:         `https://www.ebay.com/sch/i.html?_ssn=${username}&_ipg=240&_sop=12`,
        totalListings,
        topSoldQty:      data.topSoldQty,
        totalSoldQty:    data.totalSoldQty,
        categoriesFound: Array.from(data.categories),
        sampleTitles:    data.titles,
        score,
        discoveredAt:    Date.now(),
      };

      await db.collection(SELLERS_COLLECTION).doc(username).set(seller, { merge: true });
      qualified.push(seller);
      console.log(
        `[discover-sellers] ✅ ${username} — ${totalListings} listings | ` +
        `top sold: ${data.topSoldQty} | cats: ${data.categories.size} | score: ${score}`
      );
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`[discover-sellers] ✅ Done — ${qualified.length} sellers saved`);
    return NextResponse.json({ success: true, found: qualified.length, sellers: qualified });

  } catch (e) {
    console.error("[discover-sellers] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  try {
    const { username } = await req.json() as { username: string };
    await db.collection(SELLERS_COLLECTION).doc(username).delete();
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}