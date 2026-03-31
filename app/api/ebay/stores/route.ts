import { NextRequest, NextResponse } from "next/server";
import { db, storesCol } from "@/lib/firebase";

// GET — no orderBy to avoid composite index requirement
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

    const snap = await storesCol(userId).get();

    // Sort in JS — avoids composite index
    const stores = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a: any, b: any) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

    return NextResponse.json({ stores });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name, marketplace = "EBAY_US", userId } = await req.json();
    if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (!userId)       return NextResponse.json({ error: "userId required" }, { status: 400 });

    const existing = await storesCol(userId).get();
    if (existing.size >= 20)
      return NextResponse.json({ error: "Máximo 20 tiendas por usuario" }, { status: 400 });

    const storeId = `store_${Date.now()}`;
    const store = { id: storeId, name: name.trim(), marketplace, connected: false, createdAt: Date.now(), userId };
    await storesCol(userId).doc(storeId).set(store);
    return NextResponse.json({ store });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { storeId, updates, userId } = await req.json();
    if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });
    if (!userId)  return NextResponse.json({ error: "userId required" }, { status: 400 });

    const doc = await storesCol(userId).doc(storeId).get();
    if (!doc.exists || doc.data()?.userId !== userId)
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });

    await storesCol(userId).doc(storeId).update({ ...updates, updatedAt: Date.now() });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { storeId, userId } = await req.json();
    if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });
    if (!userId)  return NextResponse.json({ error: "userId required" }, { status: 400 });

    const doc = await storesCol(userId).doc(storeId).get();
    if (!doc.exists || doc.data()?.userId !== userId)
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });

    await Promise.all([
      storesCol(userId).doc(storeId).delete(),
      db.collection("tokens").doc(storeId).delete().catch(() => {}),
    ]);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}