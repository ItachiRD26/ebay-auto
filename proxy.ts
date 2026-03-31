import { NextRequest, NextResponse } from "next/server";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow login page, privacy policy, and all API routes
  if (pathname === "/login" || pathname === "/privacy" || pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Check session cookie
  const session = req.cookies.get("dropflow_session")?.value;
  if (!session) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};