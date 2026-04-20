import { NextRequest, NextResponse } from "next/server";
import { getSearchProgress } from "@/lib/search-progress";
import { getTokenExpiredStore, clearTokenExpired } from "@/api/ebay/search/route";
import { db } from "@/lib/firebase";

export async function GET(req: NextRequest) {
  const userId  = new URL(req.url).searchParams.get("userId")  ?? "";
  const storeId = new URL(req.url).searchParams.get("storeId") ?? "";
  const progress = getSearchProgress(userId);

  let expiredStore = getTokenExpiredStore(); // in-memory check first

  if (storeId) {
    try {
      const tokenDoc = await db.collection("tokens").doc(storeId).get();
      const firestoreExpiredAt = tokenDoc.data()?.tokenExpiredAt ?? null;

      if (expiredStore === storeId && !firestoreExpiredAt) {
        // In-memory says expired but Firestore is clear (user reconnected) — clear memory
        clearTokenExpired();
        expiredStore = null;
      } else if (!expiredStore && firestoreExpiredAt) {
        // Firestore says expired but memory doesn't know (different serverless instance)
        expiredStore = storeId;
      }
    } catch { /* non-fatal — fall back to memory only */ }
  }

  return NextResponse.json({
    ...progress,
    tokenExpired: expiredStore === storeId && storeId ? expiredStore : null,
  });
}

// DELETE — manually clear the token expiry flag
export async function DELETE(req: NextRequest) {
  const storeId = new URL(req.url).searchParams.get("storeId") ?? "";
  if (storeId) {
    clearTokenExpired();
    try {
      await db.collection("tokens").doc(storeId).update({ tokenExpiredAt: null, tokenExpiredReason: null });
    } catch { /* non-fatal */ }
  }
  return NextResponse.json({ ok: true });
}