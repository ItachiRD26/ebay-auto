import { NextRequest, NextResponse } from "next/server";
import { getSearchProgress } from "@/lib/search-progress";
import { getTokenExpiredStore } from "@/api/ebay/search/route";

export async function GET(req: NextRequest) {
  const userId  = new URL(req.url).searchParams.get("userId") ?? "";
  const storeId = new URL(req.url).searchParams.get("storeId") ?? "";
  const progress = getSearchProgress(userId);
  const expiredStore = getTokenExpiredStore();
  return NextResponse.json({
    ...progress,
    tokenExpired: expiredStore && expiredStore === storeId ? expiredStore : null,
  });
}