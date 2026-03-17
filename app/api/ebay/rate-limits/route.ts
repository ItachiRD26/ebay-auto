import { NextResponse } from "next/server";
import { getUserToken } from "@/lib/ebay";

export async function GET() {
  try {
    const token = await getUserToken();

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Fetch both user-level AND app-level rate limits in parallel
    const [userRes, appRes] = await Promise.all([
      fetch("https://api.ebay.com/developer/analytics/v1_beta/user_rate_limit/", { headers, signal: AbortSignal.timeout(10000) }),
      fetch("https://api.ebay.com/developer/analytics/v1_beta/rate_limit/", { headers, signal: AbortSignal.timeout(10000) }),
    ]);

    const userText = await userRes.text();
    const appText  = await appRes.text();

    let userLimits: unknown[] = [];
    let appLimits:  unknown[] = [];
    try { userLimits = (JSON.parse(userText) as { rateLimits?: unknown[] }).rateLimits ?? []; } catch {}
    try { appLimits  = (JSON.parse(appText)  as { rateLimits?: unknown[] }).rateLimits ?? []; } catch {}

    return NextResponse.json({ success: true, userLimits, appLimits });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}