import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";

// GET — list all stores
export async function GET() {
  try {
    const snap = await db.collection("stores").orderBy("createdAt", "asc").get();
    const stores = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return NextResponse.json({ stores });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST — create a new store slot
export async function POST(req: NextRequest) {
  try {
    const { name, marketplace = "EBAY_US" } = await req.json();
    if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

    const storeId = `store_${Date.now()}`;
    const store = {
      id: storeId,
      name: name.trim(),
      marketplace,
      connected: false,
      createdAt: Date.now(),
    };

    await db.collection("stores").doc(storeId).set(store);
    return NextResponse.json({ store });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH — update store metadata
export async function PATCH(req: NextRequest) {
  try {
    const { storeId, updates } = await req.json();
    if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });

    await db.collection("stores").doc(storeId).update({ ...updates, updatedAt: Date.now() });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// DELETE — remove a store and its token
export async function DELETE(req: NextRequest) {
  try {
    const { storeId } = await req.json();
    if (!storeId) return NextResponse.json({ error: "storeId required" }, { status: 400 });

    // Delete token and store doc
    await Promise.all([
      db.collection("stores").doc(storeId).delete(),
      db.collection("tokens").doc(storeId).delete().catch(() => {}),
    ]);

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}