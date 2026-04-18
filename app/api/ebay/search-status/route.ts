import { NextRequest, NextResponse } from "next/server";
import { getSearchProgress } from "@/lib/search-progress";
import { getTokenExpiredStore } from "@/api/ebay/search/route";
import { db } from "@/lib/firebase";

export async function GET(req: NextRequest) {
  const userId  = new URL(req.url).searchParams.get("userId")  ?? "";
  const storeId = new URL(req.url).searchParams.get("storeId") ?? "";
  const progress = getSearchProgress(userId);

  // Check in-memory first (fast, works in single-instance / dev)
  let expiredStore = getTokenExpiredStore();

  // If not in memory (serverless multi-instance), check Firestore
  if (!expiredStore && storeId) {
    try {
      const tokenDoc = await db.collection("tokens").doc(storeId).get();
      const data = tokenDoc.data();
      // tokenExpiredAt is set when Trading API returns auth error.
      // It's cleared to null when user reconnects via oauth/manual.
      if (data?.tokenExpiredAt) {
        expiredStore = storeId;
      }
    } catch { /* non-fatal */ }
  }

  return NextResponse.json({
    ...progress,
    tokenExpired: expiredStore === storeId && storeId ? expiredStore : null,
  });
}

// DELETE — clear the token expiry flag (called when user reconnects)
export async function DELETE(req: NextRequest) {
  const storeId = new URL(req.url).searchParams.get("storeId") ?? "";
  if (storeId) {
    try {
      await db.collection("tokens").doc(storeId).update({
        tokenExpiredAt: null,
        tokenExpiredReason: null,
      });
    } catch { /* non-fatal */ }
  }
  return NextResponse.json({ ok: true });
}