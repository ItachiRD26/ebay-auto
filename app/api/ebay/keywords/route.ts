import { NextRequest, NextResponse } from "next/server";
import { settingsDoc } from "@/lib/firebase";

export const DEFAULT_AUTO_KEYWORDS = [
"viral","trending","new","smart","mini","portable","foldable","electric","wireless","rechargeable","automatic","digital","led","usb","magnetic","waterproof","durable","adjustable","expandable","multifunction","creative","innovative","premium","luxury","budget","compact","lightweight","powerful","silent","fast","quick","instant","easy","simple","pro","advanced","universal","flexible","rotating","360","clip","holder","stand","mount","case","cover","protector","cleaner","brush","roller","sponge","spray","bottle","organizer","storage","basket","rack","tray","bag","pouch","kit","set","tool","gadget","device","machine","fan","lamp","light","charger","cable","adapter","sensor","timer","scale","pump","filter","nozzle","blade","pad","mat","glove","strap","belt","hook","tape","wheel","mirror","camera","speaker","headset","mug","cup","plate","knife","slicer","peeler","grinder","opener","sealer","heater","cooler","humidifier","diffuser","steamer","massager","trainer","shaper","support","corrector","shield","guard","cap","mask","glasses","watch","wallet","keychain","game","puzzle","drone","robot","printer","projector","keyboard","mouse","tablet","battery","panel","solar","engine","motor","switch","socket","plug","frame","sticker","paint","polish","wax","towel","blanket","pillow","sheet","curtain","carpet","rug","chair","desk","shelf","drawer","cabinet","closet","hanger","shoe","boot","sneaker","shirt","jacket","hoodie","pants","shorts","dress","ring","necklace","bracelet","earring","razor","trimmer","toothbrush","band","resistance","dumbbell","yoga","ball","bicycle","scooter","tent","flashlight","backpack","lunchbox","thermos","umbrella","gift","bundle","deal","bestseller","popular","exclusive","limited","original","upgrade","winner","hot","top","rank","boost","trend","niche","target","buyer","seller","listing","stock","inventory","delivery","secure","safe","trusted","guarantee","warranty","guide","repair","replace","spare","accessory","feature","solution","design","style","color","shape","size","material","metal","plastic","silicone","rubber","wood","glass","ceramic","steel","aluminum","nylon","cotton","leather","bamboo","eco","organic","reusable","energy","efficient","quality","value","select","discover","explore","filter","scan","track","monitor","measure","connect","sync","share","store","carry","protect","decorate","improve","enhance","transform","custom","unique","classic","modern","retro","vintage","tech","cool","awesome","amazing","essential","daily","travel","home","office","kitchen","bathroom","bedroom","garage","garden","outdoor","indoor","car","pet","baby","kids","men","women","fitness","health","beauty","gaming","music","photo","video","security","lighting","heating","cooling","cleaning","cooking","navigation","entertainment","education","automation","efficiency","convenience","comfort","safety","durability","portability","versatility","affordability","reliability","compatibility","flexibility","stability","precision","accuracy","speed","power","capacity","range","control","grip","resistant","shockproof","dustproof","waterproof","foldable","stackable","collapsible","extendable","detachable","washable","programmable","touch","voice","remote","bluetooth","wifi","gps","laser","infrared","cordless","modular","ergonomic","minimal","sleek","robust","rugged","professional","starter","complete","deluxe","basic","standard","max","ultra","lite","micro","nano","mega","super","turbo","prime","core","edge","hub","cloud","signal","enhanced","refined","engineered","certified","recommended","featured"
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
"gun","firearm","ammo","ammunition","rifle","pistol","replica","counterfeit","fake",
"mercedes","bmw","audi","porsche","ferrari","lamborghini","tesla","ford","chevrolet",
"toyota","honda","nissan","hyundai","volkswagen","subaru","mazda",
"starbucks","nespresso","keurig","red bull","monster energy","coca cola","pepsi",
"anime","manga","waifu","yugioh","magic the gathering","tcg","ccg","playmat"
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