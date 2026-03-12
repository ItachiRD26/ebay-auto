import { NextResponse } from "next/server";
import { getSearchProgress } from "@/lib/search-progress";

export async function GET() {
  return NextResponse.json(getSearchProgress());
}