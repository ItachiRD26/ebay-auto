"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ConnectPage() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleGoToEbay = async () => {
    const res = await fetch("/api/ebay/oauth", { method: "POST" });
    const data = await res.json();
    if (data.url) window.open(data.url, "_blank");
  };

  const handleConnect = async () => {
    try {
      setLoading(true);
      setError("");

      const parsed = new URL(url);
      const code = parsed.searchParams.get("code");

      if (!code) {
        setError("No se encontró el código en la URL. Asegúrate de pegar la URL completa.");
        return;
      }

      const res = await fetch("/api/ebay/oauth/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al conectar");

      router.push("/settings?success=connected");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0f", color: "#e2e8f0", fontFamily: "sans-serif", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 560, padding: "2rem", background: "#0d0d14", border: "1px solid #1e2235", borderRadius: 16 }}>
        <h1 style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "0.5rem" }}>🔗 Conectar cuenta eBay</h1>
        <p style={{ fontSize: "0.85rem", color: "#64748b", marginBottom: "1.5rem" }}>
          Después de autorizar en eBay, copia la URL completa de la página a la que te redirigió y pégala aquí.
        </p>

        <div style={{ background: "#111120", border: "1px solid #1e2235", borderRadius: 10, padding: "1rem", marginBottom: "1.25rem", fontSize: "0.8rem", color: "#64748b" }}>
          <p style={{ margin: "0 0 0.5rem 0", color: "#94a3b8", fontWeight: 600 }}>📋 Pasos:</p>
          <p style={{ margin: "0.2rem 0" }}>1. Click en &quot;Ir a eBay&quot; abajo</p>
          <p style={{ margin: "0.2rem 0" }}>2. Inicia sesión con tu cuenta de vendedor</p>
          <p style={{ margin: "0.2rem 0" }}>3. Autoriza la app</p>
          <p style={{ margin: "0.2rem 0" }}>4. eBay te redirige a una página — copia la URL completa</p>
          <p style={{ margin: "0.2rem 0" }}>5. Pégala aquí y click &quot;Conectar&quot;</p>
        </div>

        <button
          onClick={handleGoToEbay}
          style={{ display: "block", width: "100%", textAlign: "center", background: "#2563eb", color: "#fff", padding: "0.65rem", borderRadius: 8, border: "none", marginBottom: "1.25rem", fontSize: "0.9rem", fontWeight: 600, cursor: "pointer" }}
        >
          → Ir a eBay a autorizar
        </button>

        <textarea
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Pega aquí la URL completa de eBay después de autorizar..."
          style={{ width: "100%", minHeight: 90, background: "#0a0a0f", border: "1px solid #2d3748", borderRadius: 8, color: "#e2e8f0", padding: "0.75rem", fontSize: "0.8rem", resize: "vertical", boxSizing: "border-box" }}
        />

        {error && (
          <p style={{ color: "#ef4444", fontSize: "0.8rem", margin: "0.5rem 0" }}>{error}</p>
        )}

        <button
          onClick={handleConnect}
          disabled={loading || !url.trim()}
          style={{ width: "100%", marginTop: "0.75rem", padding: "0.7rem", background: "#10b981", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: "0.95rem", cursor: loading || !url.trim() ? "not-allowed" : "pointer", opacity: loading || !url.trim() ? 0.5 : 1 }}
        >
          {loading ? "Conectando..." : "✅ Conectar"}
        </button>
      </div>
    </div>
  );
}