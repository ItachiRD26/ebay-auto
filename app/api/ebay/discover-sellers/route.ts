import { NextRequest, NextResponse } from "next/server";
import { getAppToken } from "@/lib/ebay";
import { db } from "@/lib/firebase";

export const SELLER_CATEGORIES: Record<string, string[]> = {
  "🍳 Cocina": [
    "kitchen gadget","slicer","chopper","cutter","peeler","grater",
    "strainer","colander","opener","dispenser","oil sprayer",
    "food storage","lunch box","meal prep","silicone lid",
    "air fryer accessory","sink organizer","drying rack",
  ],
  "🧹 Limpieza": [
    "cleaning brush","electric scrubber","spin brush","dust remover",
    "lint remover","pet hair remover","window cleaner","squeegee",
    "microfiber","mop head","magic sponge","drain cleaner",
  ],
  "🚿 Baño": [
    "shower caddy","soap holder","toothbrush holder","towel rack",
    "bath mat","non slip mat","toilet organizer","dispenser set",
  ],
  "🚗 Auto": [
    "car organizer","seat gap filler","car hook","phone mount car",
    "car trash can","car storage","sunshade","steering cover",
  ],
  "📱 Tech Accesorios": [
    "phone stand","tablet stand","cable organizer","charging dock",
    "desk organizer","laptop stand","mouse pad","led strip",
  ],
  "✈️ Viaje": [
    "travel organizer","packing cube","compression bag",
    "toiletry bag","passport holder","luggage tag",
  ],
  "🐾 Mascotas": [
    "pet feeder","pet water bottle","dog toy","cat toy",
    "pet grooming","fur remover","pet bed","pet bowl",
  ],
  "🏠 Decoracion": [
    "wall decor","floating shelf","plant hanger","planter",
    "vase","led light","night light","ambient light",
  ],
  "Viral / Trendy": [
    "multi function","adjustable portable","reusable",
    "self adhesive","automatic","smart gadget","mini compact",
  ],
};

const MIN_LISTINGS       = 100;
const MAX_LISTINGS       = 5000;
const TOP_PER_CAT        = 5;
const LIMIT_PER_REQ      = 100;
const SELLERS_COLLECTION = "discovered_sellers";

export interface SavedSeller {
  id?:           string;
  username:      string;
  storeUrl:      string;
  userUrl:       string;
  totalListings: number;
  sampleTitles:  string[];
  category:      string;
  discoveredAt:  number;
}

async function searchPage(keyword: string, token: string): Promise<Record<string, { count: number; titles: string[] }>> {
  const params = new URLSearchParams({
    q: keyword, limit: LIMIT_PER_REQ.toString(), offset: "0",
    filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:CN",
    fieldgroups: "EXTENDED",
  });
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return {};
  let data: { itemSummaries?: unknown[] };
  try { data = await res.json(); } catch { return {}; }
  const sellers: Record<string, { count: number; titles: string[] }> = {};
  for (const item of (data.itemSummaries ?? []) as Record<string, unknown>[]) {
    const seller = (item.seller as { username?: string } | undefined)?.username;
    if (!seller) continue;
    if (!sellers[seller]) sellers[seller] = { count: 0, titles: [] };
    sellers[seller].count++;
    if (sellers[seller].titles.length < 3)
      sellers[seller].titles.push((item.title as string ?? "").slice(0, 60));
  }
  return sellers;
}

async function getSellerListingCount(seller: string, token: string): Promise<number> {
  const params = new URLSearchParams({ q: "a", limit: "1", filter: `sellers:{${seller}},buyingOptions:{FIXED_PRICE}` });
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return 0;
  try { return ((await res.json()) as { total?: number }).total ?? 0; } catch { return 0; }
}

// GET — load all saved sellers
export async function GET() {
  try {
    const snap = await db.collection(SELLERS_COLLECTION).get();
    const sellers = snap.docs.map(d => ({ id: d.id, ...d.data() } as SavedSeller));
    sellers.sort((a, b) => a.category.localeCompare(b.category) || b.totalListings - a.totalListings);
    return NextResponse.json({ success: true, sellers, categories: Object.keys(SELLER_CATEGORIES) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST — scan a category (or all) and save top sellers to Firestore
export async function POST(req: NextRequest) {
  try {
    const { category } = await req.json() as { category?: string };
    const token = await getAppToken();
    const toScan = category ? { [category]: SELLER_CATEGORIES[category] ?? [] } : SELLER_CATEGORIES;
    const results: SavedSeller[] = [];

    for (const [cat, keywords] of Object.entries(toScan)) {
      console.log(`[discover-sellers] 🔍 ${cat}`);
      const appearances: Record<string, { count: number; titles: string[] }> = {};

      for (const kw of keywords) {
        const page = await searchPage(kw, token);
        for (const [username, data] of Object.entries(page)) {
          if (!appearances[username]) appearances[username] = { count: 0, titles: [] };
          appearances[username].count += data.count;
          for (const t of data.titles)
            if (appearances[username].titles.length < 5 && !appearances[username].titles.includes(t))
              appearances[username].titles.push(t);
        }
        await new Promise(r => setTimeout(r, 150));
      }

      const candidates = Object.entries(appearances).sort((a, b) => b[1].count - a[1].count).slice(0, 30);
      const qualified: SavedSeller[] = [];

      for (const [username, data] of candidates) {
        if (qualified.length >= TOP_PER_CAT) break;
        const totalListings = await getSellerListingCount(username, token);
        if (totalListings >= MIN_LISTINGS && totalListings <= MAX_LISTINGS) {
          qualified.push({ username, storeUrl: `https://www.ebay.com/str/${username}`,
            userUrl: `https://www.ebay.com/sch/i.html?_ssn=${username}&_ipg=240&_sop=12`,
            totalListings, sampleTitles: data.titles, category: cat, discoveredAt: Date.now() });
          console.log(`[discover-sellers] ✅ ${username} — ${totalListings} listings`);
        }
        await new Promise(r => setTimeout(r, 250));
      }

      for (const seller of qualified) {
        await db.collection(SELLERS_COLLECTION).doc(seller.username).set(seller, { merge: true });
        results.push(seller);
      }
    }

    return NextResponse.json({ success: true, found: results.length, sellers: results });
  } catch (e) {
    console.error("[discover-sellers] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// DELETE — remove seller from saved list
export async function DELETE(req: NextRequest) {
  try {
    const { username } = await req.json() as { username: string };
    await db.collection(SELLERS_COLLECTION).doc(username).delete();
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}