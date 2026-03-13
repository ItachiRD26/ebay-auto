import { NextResponse } from "next/server";
import { db, COLLECTIONS } from "@/lib/firebase";
import { getUserToken } from "@/lib/ebay";

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
  // Clothing & lifestyle brands
  "polo","ralph lauren","lacoste","tommy hilfiger","calvin klein","hugo boss",
  "michael kors","coach","kate spade","marc jacobs","tommy","nautica","izod",
  // Generic female names used as brands
  "charlotte","victoria secret","victoria's secret","fredericks","fredericks of hollywood",
  // Car care & detailing brands/products
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
  "retainer","braces","aligner","whitening strips","dental bib","tooth paste","toothpaste",
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
  "car seat cover","car organizer","car phone mount","dash cam","car vacuum",
  "steering wheel cover","windshield",
];

function isBanned(title: string): boolean {
  const t = title.toLowerCase();
  return EXCLUDED_KEYWORDS.some(kw => t.includes(kw));
}

async function endListing(listingId: string, userToken: string): Promise<boolean> {
  const https = await import("node:https");
  return new Promise((resolve) => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>
  <ItemID>${listingId}</ItemID>
  <EndingReason>NotAvailable</EndingReason>
</EndFixedPriceItemRequest>`;
    const buf = Buffer.from(xml, "utf-8");
    const req = https.request({
      hostname: "api.ebay.com", path: "/ws/api.dll", method: "POST",
      headers: {
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "EndFixedPriceItem",
        "Content-Type": "text/xml",
        "Content-Length": buf.length.toString(),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(!body.includes("<Ack>Failure</Ack>"));
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(buf); req.end();
  });
}

export async function POST() {
  try {
    const userToken = await getUserToken();

    const snap = await db.collection(COLLECTIONS.QUEUE)
      .where("status", "==", "published")
      .get();

    const products = snap.docs.map(d => ({ id: d.id, ...d.data() } as {
      id: string; title?: string; listingId?: string;
    }));

    console.log(`[clean] Checking ${products.length} published listings...`);

    let delisted = 0;
    const flagged: string[] = [];

    for (const p of products) {
      if (!p.title) continue;
      if (isBanned(p.title)) {
        flagged.push(`${p.id} — "${p.title.slice(0, 60)}"`);
        // Delist from eBay if has listingId
        if (p.listingId) {
          const ok = await endListing(p.listingId, userToken);
          console.log(`[clean] ${ok ? "✅" : "⚠️"} Delisted ${p.listingId} — "${p.title.slice(0, 50)}"`);
        }
        // Move to rejected in Firestore
        await db.collection(COLLECTIONS.QUEUE).doc(p.id).update({
          status: "rejected",
          failReason: "Eliminado por filtro de keywords baneadas",
          updatedAt: Date.now(),
        });
        delisted++;
        await new Promise(r => setTimeout(r, 300));
      }
    }

    console.log(`[clean] Done — ${delisted} delisted out of ${products.length} checked`);
    if (flagged.length > 0) console.log("[clean] Flagged:\n" + flagged.join("\n"));

    return NextResponse.json({ success: true, checked: products.length, delisted });
  } catch (e) {
    console.error("[clean] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}