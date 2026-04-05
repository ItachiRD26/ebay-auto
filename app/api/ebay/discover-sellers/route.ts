import { NextRequest, NextResponse } from "next/server";
import { getAppToken } from "@/lib/ebay";
import { db } from "@/lib/firebase";

const MIN_LISTINGS       = 50;
const MAX_LISTINGS       = 10_000;
const MIN_SOLD_SIGNALS   = 3;
const TOP_PER_SCAN       = 30;
const SELLERS_COLLECTION = "discovered_sellers";

const SEED_QUERIES = [
  { q: "home organizer",  offset: 0   },
  { q: "home organizer",  offset: 200 },
  { q: "kitchen gadget",  offset: 0   },
  { q: "kitchen gadget",  offset: 200 },
  { q: "storage box",     offset: 0   },
  { q: "cable charger",   offset: 0   },
  { q: "pet supplies",    offset: 0   },
  { q: "cleaning brush",  offset: 0   },
  { q: "travel bag",      offset: 0   },
  { q: "outdoor tool",    offset: 0   },
  { q: "car accessories", offset: 0   },
  { q: "fitness band",    offset: 0   },
  { q: "wall mount",      offset: 0   },
  { q: "desk organizer",  offset: 0   },
  { q: "phone holder",    offset: 0   },
];

export interface SavedSeller {
  id?:            string;
  username:       string;
  storeUrl:       string;
  userUrl:        string;
  totalListings:  number;
  soldSignals:    number;
  topSoldCount:   number;
  sampleTitles:   string[];
  category:       string;
  score:          number;
  discoveredAt:   number;
}

async function searchPage(q: string, offset: number, token: string): Promise<Record<string, { appearances: number; soldSignals: number; topSold: number; titles: string[] }>> {
  const params = new URLSearchParams({
    q, limit: "200", offset: offset.toString(),
    filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:CN,conditions:{NEW}",
    fieldgroups: "EXTENDED", sort: "bestMatch",
  });
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return {};
  let data: { itemSummaries?: unknown[] };
  try { data = await res.json(); } catch { return {}; }

  const sellers: Record<string, { appearances: number; soldSignals: number; topSold: number; titles: string[] }> = {};
  for (const item of (data.itemSummaries ?? []) as Record<string, unknown>[]) {
    const username = (item.seller as { username?: string } | undefined)?.username;
    if (!username) continue;
    const country = (item.itemLocation as { country?: string } | undefined)?.country ?? "";
    if (!["CN","HK","TW"].includes(country.toUpperCase())) continue;
    if (!sellers[username]) sellers[username] = { appearances: 0, soldSignals: 0, topSold: 0, titles: [] };
    sellers[username].appearances++;
    const sold = (item as { soldQuantity?: number }).soldQuantity ?? 0;
    if (sold > 0) { sellers[username].soldSignals++; sellers[username].topSold = Math.max(sellers[username].topSold, sold); }
    const title = (item.title as string ?? "").slice(0, 65);
    if (sellers[username].titles.length < 3 && title) sellers[username].titles.push(title);
  }
  return sellers;
}

async function getSellerListingCount(seller: string, token: string): Promise<number> {
  const params = new URLSearchParams({ q: "a", limit: "1", filter: `sellers:{${seller}},buyingOptions:{FIXED_PRICE},conditions:{NEW},itemLocationCountry:CN` });
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return 0;
  try { return ((await res.json()) as { total?: number }).total ?? 0; } catch { return 0; }
}

export async function GET() {
  try {
    const snap = await db.collection(SELLERS_COLLECTION).orderBy("score", "desc").limit(200).get();
    const sellers = snap.docs.map(d => ({ id: d.id, ...d.data() } as SavedSeller));
    return NextResponse.json({ success: true, sellers });
  } catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}

export async function POST(_req: NextRequest) {
  try {
    const token = await getAppToken();
    console.log(`[discover-sellers] Sampling across ${SEED_QUERIES.length} broad queries...`);
    const aggregate: Record<string, { appearances: number; soldSignals: number; topSold: number; titles: string[] }> = {};

    for (const seed of SEED_QUERIES) {
      const page = await searchPage(seed.q, seed.offset, token);
      for (const [username, data] of Object.entries(page)) {
        if (!aggregate[username]) aggregate[username] = { appearances: 0, soldSignals: 0, topSold: 0, titles: [] };
        aggregate[username].appearances  += data.appearances;
        aggregate[username].soldSignals  += data.soldSignals;
        aggregate[username].topSold       = Math.max(aggregate[username].topSold, data.topSold);
        for (const t of data.titles)
          if (aggregate[username].titles.length < 3 && !aggregate[username].titles.includes(t))
            aggregate[username].titles.push(t);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`[discover-sellers] ${Object.keys(aggregate).length} unique CN sellers found`);

    const withSales = Object.entries(aggregate)
      .filter(([, d]) => d.soldSignals >= MIN_SOLD_SIGNALS)
      .sort((a, b) => {
        const scoreA = a[1].soldSignals * Math.log1p(a[1].topSold) + a[1].appearances;
        const scoreB = b[1].soldSignals * Math.log1p(b[1].topSold) + b[1].appearances;
        return scoreB - scoreA;
      });

    console.log(`[discover-sellers] ${withSales.length} passed sold signals filter`);

    const qualified: SavedSeller[] = [];
    for (const [username, data] of withSales.slice(0, 80)) {
      if (qualified.length >= TOP_PER_SCAN) break;
      const totalListings = await getSellerListingCount(username, token);
      if (totalListings < MIN_LISTINGS || totalListings > MAX_LISTINGS) {
        await new Promise(r => setTimeout(r, 100)); continue;
      }
      const score = Math.round(data.soldSignals * Math.log1p(data.topSold) * 10 + data.appearances + Math.log1p(totalListings) * 5);
      const seller: SavedSeller = {
        username, storeUrl: `https://www.ebay.com/str/${username}`,
        userUrl: `https://www.ebay.com/sch/i.html?_ssn=${username}&_ipg=240&_sop=12`,
        totalListings, soldSignals: data.soldSignals, topSoldCount: data.topSold,
        sampleTitles: data.titles, category: "CN Sellers", score, discoveredAt: Date.now(),
      };
      await db.collection(SELLERS_COLLECTION).doc(username).set(seller, { merge: true });
      qualified.push(seller);
      console.log(`[discover-sellers] ✅ ${username} — ${totalListings} listings | ${data.soldSignals} sold signals | top ${data.topSold} | score ${score}`);
      await new Promise(r => setTimeout(r, 250));
    }

    return NextResponse.json({ success: true, found: qualified.length, sellers: qualified });
  } catch (e) {
    console.error("[discover-sellers] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { username } = await req.json() as { username: string };
    await db.collection(SELLERS_COLLECTION).doc(username).delete();
    return NextResponse.json({ success: true });
  } catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}