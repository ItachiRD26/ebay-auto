import { NextRequest, NextResponse } from "next/server";
import { getSearchProgress } from "@/lib/search-progress";

export async function GET(req: NextRequest) {
  const userId = new URL(req.url).searchParams.get("userId") ?? "";
  return NextResponse.json(getSearchProgress(userId));
}