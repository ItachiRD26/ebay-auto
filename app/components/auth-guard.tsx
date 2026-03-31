"use client";

import { useEffect, ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export default function AuthGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    const publicPaths = ["/login", "/privacy"];
    if (!user && !publicPaths.includes(pathname)) {
      router.replace("/login");
    } else if (user && pathname === "/login") {
      router.replace("/");
    }
  }, [user, loading, pathname, router]);

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: "1rem",
      }}>
        <div style={{ fontSize: "2.5rem" }}>⚡</div>
        <div style={{
          width: 28,
          height: 28,
          border: "3px solid var(--border2)",
          borderTopColor: "var(--blue)",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Public pages render without auth, any page renders with auth
  const publicPaths = ["/login", "/privacy"];
  if ((!user && publicPaths.includes(pathname)) || user) {
    return <>{children}</>;
  }

  // Redirecting — show nothing
  return null;
}