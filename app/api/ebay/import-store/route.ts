import { NextRequest, NextResponse } from "next/server";
import { getAppToken, getUserToken } from "@/lib/ebay";
import { db, COLLECTIONS, DEFAULT_SETTINGS } from "@/lib/firebase";
import { QueueProduct, Settings } from "@/types";
import { SELLER_CATEGORIES } from "@/api/ebay/discover-sellers/route";

// Flat fallback keywords if no category known
const DEFAULT_SCAN_KEYWORDS = [
  "organizer","holder","storage","rack","stand","hook","hanger","mat","pad",
  "brush","cleaner","dispenser","case","cover","bag","pouch","set","box",
];

// ─── Same filters as search route ────────────────────────────────────────────
const CONFIG = {
  MIN_PRICE:      20,
  MAX_PRICE:      250,
  MIN_SOLD_TOTAL: 5,    // min all-time sales
  MIN_SOLD_30D:   3,    // min estimated sales last 30 days
  MARKUP_PERCENT: 6,
  STOCK:          1,
  MAX_VARIATIONS: 12,   // skip listings with too many variants
};

// Cache user token for Trading API calls
let _userToken: string | null = null;
let _tokenFetchedAt = 0;

async function getTradingData(numericId: string): Promise<{ soldCount: number; estimatedSold30d: number; listingAgeDays: number; shipFromCountry: string | null; variationCount: number }> {
  const empty = { soldCount: 0, estimatedSold30d: 0, listingAgeDays: 0, shipFromCountry: null, variationCount: 0 };
  try {
    if (!_userToken || Date.now() - _tokenFetchedAt > 55_000) {
      _userToken = await getUserToken();
      _tokenFetchedAt = Date.now();
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${_userToken}</eBayAuthToken></RequesterCredentials>
  <ItemID>${numericId}</ItemID>
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
    if (!res.ok) return empty;
    const text = await res.text();
    if (text.includes("<Ack>Failure</Ack>")) return empty;

    const soldMatch = text.match(/<QuantitySold>(\d+)<\/QuantitySold>/);
    const soldCount = soldMatch ? parseInt(soldMatch[1], 10) : 0;

    const startMatch = text.match(/<StartTime>(.*?)<\/StartTime>/);
    let estimatedSold30d = soldCount;
    let listingAgeDays = 0;
    if (startMatch) {
      listingAgeDays = Math.max(1, (Date.now() - new Date(startMatch[1]).getTime()) / 86400000);
      const soldPerDay = soldCount / listingAgeDays;
      let decay = 1.0;
      if      (listingAgeDays > 730) decay = 0.35;
      else if (listingAgeDays > 365) decay = 0.50;
      else if (listingAgeDays > 180) decay = 0.65;
      else if (listingAgeDays > 90)  decay = 0.80;
      estimatedSold30d = Math.round(soldPerDay * 30 * decay);
    }
    // Count variations
    const varMatches = text.match(/<Variation>/g);
    const variationCount = varMatches ? varMatches.length : 0;

    const countryMatch = text.match(/<Country>(.*?)<\/Country>/);
    const shipFromCountry = countryMatch ? countryMatch[1].trim() : null;
    return { soldCount, estimatedSold30d, listingAgeDays, shipFromCountry, variationCount };
  } catch { return empty; }
}

const EXCLUDED_KEYWORDS = [
  "iphone","samsung galaxy","apple watch","airpods","macbook","playstation","xbox",
  "nintendo switch","nvidia","radeon","graphics card","laptop","smart tv","ipad",
  "nike","adidas","gucci","louis vuitton","supreme","yeezy","jordan","off-white",
  "balenciaga","versace","prada","dior","burberry","chanel","hermes","fendi","lululemon",
  "north face","under armour","new balance","reebok","vans","converse","timberland",
  "owala","stanley cup","hydro flask","yeti","contigo","nalgene","camelbak",
  "anime","manga","naruto","dragon ball","one piece","demon slayer","attack on titan","pokemon","waifu",
  "tony chopper","luffy","zoro","nami","sanji","nico robin","franky","brook","usopp",
  "playmat","playing mat","trading card game mat","tcg mat","ccg mat","card game mat",
  "opcg","tcg","ccg","yugioh","yu-gi-oh","magic the gathering","mtg","flesh and blood",
  "dragon shield","ultra pro","card sleeve","card mat","card game","board game mat",
  "mercedes","mercedes-benz","bmw","audi","porsche","ferrari","lamborghini","maserati",
  "ford","chevrolet","chevy","dodge","jeep","tesla","honda","toyota","nissan","hyundai",
  "volkswagen","volvo","lexus","infiniti","cadillac","buick","lincoln","ram truck",
  "subaru","mazda","mitsubishi","kia","acura","genesis","alfa romeo","bentley","rolls royce",
  "replica","counterfeit","fake","gun","firearm","ammo","ammunition","rifle","pistol",
  "polo","ralph lauren","lacoste","tommy hilfiger","calvin klein","hugo boss",
  "michael kors","coach","kate spade","marc jacobs","tommy","nautica","izod",
  "charlotte","victoria secret","victoria's secret","fredericks","fredericks of hollywood",
  "maxlone","meguiar","turtle wax","armor all","mothers","chemical guys",
  "car spray","car wax","car polish","car detailing","car cleaner","car shampoo",
  "waterless wash","quick detailer","paint sealant","ceramic coat","car coating",
  "car freshener","car deodorizer","windshield cleaner","wheel cleaner","tire shine",
  "triphene","spray wipe","car care","auto care","auto detailing",
  "starbucks","nespresso","keurig","nescafe","lavazza","dunkin","red bull","monster energy",
  "coca cola","pepsi","heineken","corona","budweiser","jack daniels","johnnie walker",
  "face cream","moisturizer","serum","perfume","cologne","deodorant","antiperspirant",
  "body lotion","body cream","sunscreen","spf","retinol","vitamin c cream","eye cream",
  "anti-aging","anti aging","wrinkle","dark spot","whitening cream","bleaching",
  "toner","essence","ampoule","bb cream","cc cream","foundation","concealer",
  "lipstick","lip gloss","eyeshadow","mascara","blush","highlighter","powder makeup",
  "hair dye","hair color","keratin","shampoo","conditioner","hair mask","hair oil",
  "body wash","shower gel","bath bomb","soap bar","hand cream","foot cream",
  "wire","cable","awg","stranded","insulated","pvc wire","coaxial","ethernet cable",
  "breadboard","arduino","raspberry pi","esp32","sensor","module","led strip driver",
  "battery pack","lithium","18650","charger module","buck converter","voltage",
  "oscilloscope","multimeter","soldering","flux","pcb board","prototype",
  "toy","lego","action figure","doll","barbie","stuffed animal","toy car","toy gun",
  "toy part","toy accessory","playset","building block",
  "dildo","vibrator","sex toy","anal","butt plug","penis","enlargement","erection",
  "male enhancement","adult toy","lubricant","condom","lingerie",
  "pump","diaphragm","impeller","valve","compressor","capacitor","resistor","transistor",
  "motherboard","circuit","pcb","ic chip","relay","solenoid","actuator","servo",
  "replacement part","spare part","repair kit","oem","aftermarket","compatible with",
  "wiring harness","fuse","transformer","power supply","inverter","heat sink",
  "catheter","incontinence","colostomy","stoma","dialysis","surgical",
  "hearing aid","cpap","nebulizer","syringe","insulin",
  "dental","dentist","orthodontic","tooth whitening","teeth whitening","mouthguard",
  "retainer","braces","aligner","whitening strips","dental bib","toothpaste",
  "extender","traction device","male enlarger","pro extender","apexdrive","apex drive",
  "bigger growth","penile","erectile","male enhancement device","cock ring","chastity",
  "electric massager","massage gun","percussion massager","vibrating massager",
  "body massager","handheld massager","muscle massager","deep tissue massager",
  "tens unit","ems machine","muscle stimulator","electro stimulator",
  "infrared massager","heating massager","foot massager","neck massager",
  "back massager","eye massager","scalp massager electric","massage wand",
  "compression sleeve","medical grade","orthopedic","therapeutic","clinical",
  "blood pressure","pulse oximeter","glucose","ecg","ekg","stethoscope",
  "wound care","bandage","splint","brace medical",
  "hyaluronic","niacinamide","peptide cream","kojic acid","salicylic","glycolic",
  "aha bha","chemical peel","microneedling","derma roller","led face mask",
  "microcurrent","rf skin","ultrasonic skin","anti wrinkle device","skin tightening",
  "photon therapy","collagen machine","ipl hair removal","laser hair","epilation device",
  "hair removal device","upgrade kit","3d printed","head upgrade","weapon kit",
  "arm upgrade","wing kit","transformers","optimus prime","megatron","gundam",
  "model kit","figure kit","resin kit","conversion kit","add-on kit","parts kit",
  "injection molding","abs upgrade","pvc figure","diecast","figurine kit",
  "killing arm","onyx prime","ss86","age of the primes",
  "food","snack","candy","chocolate","coffee beans","tea leaves","protein powder",
  "supplement","vitamin","seeds","plant","succulent","cactus","flower bouquet",
  "live plant","fruit","vegetable","edible","gummies","jerky","spices","herbs","seasoning",
];

function isChina(country: string | null | undefined): boolean {
  if (!country) return false;
  return ["CN","HK","TW"].includes(country.toUpperCase());
}

function isBanned(title: string): boolean {
  const t = title.toLowerCase();
  return EXCLUDED_KEYWORDS.some(kw => t.includes(kw));
}

// ─── Extract seller username from any eBay store/seller URL ──────────────────
function extractSeller(url: string): string | null {
  url = url.trim();
  // https://www.ebay.com/str/sellername
  const strMatch = url.match(/ebay\.com\/str\/([^/?&#]+)/i);
  if (strMatch) return strMatch[1];
  // https://www.ebay.com/sch/i.html?_ssn=sellername
  const ssnMatch = url.match(/[?&]_ssn=([^&]+)/i);
  if (ssnMatch) return decodeURIComponent(ssnMatch[1]);
  // https://www.ebay.com/usr/sellername
  const usrMatch = url.match(/ebay\.com\/usr\/([^/?&#]+)/i);
  if (usrMatch) return usrMatch[1];
  // bare username
  if (/^[a-z0-9_\-\.]+$/i.test(url) && !url.includes('/')) return url;
  return null;
}

// ─── Fetch one page of seller listings via Browse API ────────────────────────
async function fetchSellerPage(seller: string, offset: number, token: string, keyword = "a") {
  const params = new URLSearchParams({
    q:     keyword,
    limit: "100",
    offset: offset.toString(),
    filter: `sellers:{${seller}},buyingOptions:{FIXED_PRICE},conditions:{NEW}`,
    fieldgroups: "EXTENDED",
    sort: "bestMatch",  // most sold first
  });

  const res = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
      signal: AbortSignal.timeout(15000),
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Browse API ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { itemSummaries: [] }; }
}


// ─── Process a single item from Browse API ───────────────────────────────────
async function processItem(
  item: Record<string, unknown>,
  settings: Settings,
  seller: string,
  _htmlSoldCount?: number
): Promise<{ added: boolean; reason: string; title: string }> {
  const title      = (item.title as string) ?? "";
  const shortTitle = title.slice(0, 50);
  const rawId      = (item.itemId as string) ?? "";
  const numericId  = rawId.split("|")[1] ?? rawId;

  // Price check
  const ebayRefPrice    = parseFloat((item.price as { value: string })?.value ?? "0");
  const shippingCost    = parseFloat((item.shippingOptions as { shippingCost?: { value: string } }[] | undefined)?.[0]?.shippingCost?.value ?? "0");
  const totalMarketCost = ebayRefPrice + shippingCost;
  const minPrice = settings.minPrice ?? CONFIG.MIN_PRICE;
  const maxPrice = settings.maxPrice ?? CONFIG.MAX_PRICE;
  if (ebayRefPrice < minPrice || ebayRefPrice > maxPrice)
    return { added: false, reason: `precio $${ebayRefPrice} fuera de rango`, title: shortTitle };

  // Banned keywords
  if (isBanned(title)) return { added: false, reason: "banned", title: shortTitle };

  // China origin check from Browse API
  const summaryCountry = (item.itemLocation as { country?: string })?.country ?? "";
  if (summaryCountry && !isChina(summaryCountry))
    return { added: false, reason: `pais ${summaryCountry}`, title: shortTitle };

  // Duplicate check by itemId
  const dup = await db.collection(COLLECTIONS.QUEUE).where("ebayItemId", "==", numericId).limit(1).get();
  if (!dup.empty) return { added: false, reason: "duplicado", title: shortTitle };

  // Duplicate check by normalized title
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim();
  const titleDup = await db.collection(COLLECTIONS.QUEUE).where("normalizedTitle", "==", normalizedTitle).limit(1).get();
  if (!titleDup.empty) return { added: false, reason: "titulo duplicado", title: shortTitle };

  // Trading API: sales, country, variations
  const td = await getTradingData(numericId);

  if (td.shipFromCountry && !isChina(td.shipFromCountry))
    return { added: false, reason: `pais-trading ${td.shipFromCountry}`, title: shortTitle };

  if (td.variationCount > CONFIG.MAX_VARIATIONS)
    return { added: false, reason: `demasiadas variantes (${td.variationCount}/${CONFIG.MAX_VARIATIONS} max)`, title: shortTitle };

  if (td.soldCount < CONFIG.MIN_SOLD_TOTAL)
    return { added: false, reason: `${td.soldCount} ventas < min ${CONFIG.MIN_SOLD_TOTAL}`, title: shortTitle };

  if (td.estimatedSold30d < CONFIG.MIN_SOLD_30D)
    return { added: false, reason: `~${td.estimatedSold30d}/30d < min ${CONFIG.MIN_SOLD_30D}`, title: shortTitle };

  // Compute suggested price
  const markupPercent       = settings.markupPercent ?? CONFIG.MARKUP_PERCENT;
  const suggestedSellingPrice = parseFloat((totalMarketCost * (1 + markupPercent / 100)).toFixed(2));

  const imageUrls: string[] =
    (item.thumbnailImages as { imageUrl: string }[])?.map(i => i.imageUrl) ||
    ((item.image as { imageUrl: string })?.imageUrl ? [(item.image as { imageUrl: string }).imageUrl] : []);

  const condition  = (item.condition as string) ?? "New";
  const categoryId = (item.categories as { categoryId: string }[])?.[0]?.categoryId ?? "";

  const product: Omit<QueueProduct, "id"> = {
    ebayItemId:           numericId,
    title,
    normalizedTitle,
    images:               imageUrls,
    ebayReferencePrice:   ebayRefPrice,
    ebayShippingCost:     shippingCost,
    totalMarketCost,
    eproloPrice:          null,
    eproloUrl:            null,
    suggestedSellingPrice,
    stock:                CONFIG.STOCK,
    condition,
    categoryId,
    categoryName:         "",
    soldCount:            td.soldCount,
    estimatedSold30d:     td.estimatedSold30d,
    listingAgeDays:       td.listingAgeDays,
    sourceUrl:            `https://www.ebay.com/itm/${numericId}`,
    description:          "",
    margin:               null,
    marginPercent:        null,
    status:               "approved",
    createdAt:            Date.now(),
    updatedAt:            Date.now(),
  };

  await db.collection(COLLECTIONS.QUEUE).add(product);
  return { added: true, reason: "ok", title: shortTitle };
}

// ─── POST handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { storeUrl, category } = await req.json() as { storeUrl: string; category?: string };
    if (!storeUrl) return NextResponse.json({ error: "storeUrl requerida" }, { status: 400 });

    const seller = extractSeller(storeUrl);
    if (!seller) return NextResponse.json({ error: "No se pudo extraer el nombre del vendedor de la URL" }, { status: 400 });

    console.log(`\n[import-store] 🏪 Importando tienda: ${seller}`);

    const token = await getAppToken();

    // Load settings for markup
    const settingsDoc = await db.collection("settings").doc("main").get();
    const settings: Settings = settingsDoc.exists
      ? (settingsDoc.data() as Settings)
      : DEFAULT_SETTINGS;

    // Single pass with keywords — stop a keyword early if yield drops
    // Use category keywords if available — much more targeted than letters
    const SCAN_KEYWORDS = category && SELLER_CATEGORIES[category]
      ? SELLER_CATEGORIES[category]
      : DEFAULT_SCAN_KEYWORDS;
    const MAX_ITEMS_PER_STORE = 2000;
    console.log(`[import-store] 📂 Categoría: ${category ?? "general"} — ${SCAN_KEYWORDS.length} keywords`);

    let totalChecked = 0;
    let totalAdded   = 0;
    let totalSkipped = 0;
    const seenIds    = new Set<string>();

    outer:
    for (const kw of SCAN_KEYWORDS) {
      let offset    = 0;
      let kwNew     = 0;
      let hasMore   = true;

      while (hasMore) {
        if (totalChecked >= MAX_ITEMS_PER_STORE) {
          console.log(`[import-store] 🛑 Límite ${MAX_ITEMS_PER_STORE} items alcanzado`);
          break outer;
        }

        const result = await fetchSellerPage(seller, offset, token, kw);
        const items  = (result.itemSummaries ?? []) as Record<string, unknown>[];
        const total  = (result.total as number) ?? 0;
        if (items.length === 0) break;

        const newItems = items.filter(item => {
          const id = ((item.itemId as string) ?? "").split("|")[1] ?? (item.itemId as string);
          if (seenIds.has(id)) return false;
          seenIds.add(id);
          return true;
        });

        // If less than 10% new items in this page, keyword is exhausted — skip to next
        if (offset > 0 && newItems.length < items.length * 0.1) {
          console.log(`[import-store] ⏭ "${kw}" agotado (${newItems.length}/${items.length} nuevos) — siguiente keyword`);
          break;
        }

        console.log(`[import-store] 📦 "${kw}" offset=${offset} — ${newItems.length} nuevos / ${items.length} (total tienda: ${total})`);

        for (const item of newItems) {
          totalChecked++;
          kwNew++;
          const { added, reason, title } = await processItem(item, settings, seller, undefined);
          if (added) totalAdded++;
          else {
            totalSkipped++;
            if (reason !== "duplicado" && reason !== "banned" && reason !== "titulo duplicado")
              console.log(`[import-store] SKIP [${reason}] "${title}"`);
          }
          await new Promise(r => setTimeout(r, 50)); // reduced delay
        }

        offset  += items.length;
        hasMore  = offset < Math.min(total, 5000) && items.length === 100;
        if (hasMore) await new Promise(r => setTimeout(r, 300)); // reduced delay
      }

      console.log(`[import-store] ✅ "${kw}" — ${kwNew} nuevos | acumulado: ${totalChecked}`);
      if (kwNew === 0) break; // keyword found nothing new — stop
    }

    console.log(`[import-store] ✅ Done — ${totalAdded} agregados | ${totalSkipped} saltados | ${totalChecked} revisados`);
    return NextResponse.json({ success: true, seller, checked: totalChecked, added: totalAdded, skipped: totalSkipped });

  } catch (e) {
    console.error("[import-store] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}