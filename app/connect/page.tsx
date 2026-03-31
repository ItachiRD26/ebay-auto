"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { Store } from "@/types";

function ConnectPageInner() {
  const { user }    = useAuth();
  const router      = useRouter();
  const params      = useSearchParams();

  const [stores, setStores]         = useState<Store[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [url, setUrl]               = useState("");
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState("");

  useEffect(() => {
    if (!user) return;
    fetch(`/api/ebay/stores?userId=${user.uid}`)
      .then(r => r.json())
      .then(d => {
        if (!d.stores) return;
        setStores(d.stores);
        const paramId = params.get("storeId");
        if (paramId && d.stores.find((s: Store) => s.id === paramId)) {
          setSelectedId(paramId);
        } else {
          const disc = d.stores.find((s: Store) => !s.connected);
          setSelectedId(disc ? disc.id : d.stores[0]?.id ?? "");
        }
      });
  }, [user, params]);

  const handleGoToEbay = async () => {
    if (!selectedId) { setError("Selecciona una tienda primero"); return; }
    const res  = await fetch("/api/ebay/oauth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeId: selectedId }),
    });
    const data = await res.json();
    if (data.url) window.open(data.url, "_blank");
    else setError("No se pudo generar URL de autorización");
  };

  const handleConnect = async () => {
    setError("");
    setLoading(true);
    try {
      if (!selectedId) { setError("Selecciona una tienda primero"); return; }
      let code = "";
      try {
        code = new URL(url).searchParams.get("code") ?? "";
      } catch {
        setError("URL inválida. Pega la URL completa de redirección de eBay."); return;
      }
      if (!code) { setError("No se encontró el código en la URL. Pega la URL completa."); return; }

      const res  = await fetch("/api/ebay/oauth/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, storeId: selectedId, userId: user?.uid ?? "" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al conectar");
      router.push("/?connected=1");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  const selectedStore = stores.find(s => s.id === selectedId);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1.5rem" }}>
      <div style={{ width: "100%", maxWidth: 500, background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "2rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>

        <div>
          <div style={{ fontSize: "1.5rem", marginBottom: "0.35rem" }}>🔗</div>
          <h1 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "0.3rem" }}>Conectar cuenta eBay</h1>
          <p style={{ fontSize: "0.8rem", color: "var(--text3)" }}>Vincula una cuenta de vendedor eBay a una de tus tiendas.</p>
        </div>

        {/* Store selector */}
        {stores.length === 0 ? (
          <div style={{ padding: "0.85rem", background: "var(--bg3)", borderRadius: "var(--radius-sm)", fontSize: "0.83rem", color: "var(--amber)" }}>
            ⚠ No tienes tiendas. Crea una desde el dashboard → Mis Tiendas.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            <label style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text2)" }}>Tienda a conectar</label>
            <select
              value={selectedId}
              onChange={e => setSelectedId(e.target.value)}
              style={{ padding: "0.5rem 0.75rem", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: "0.88rem", outline: "none" }}
            >
              {stores.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.connected ? "✓ Conectada" : "— Sin conectar"}
                </option>
              ))}
            </select>
            {selectedStore?.connected && (
              <p style={{ fontSize: "0.73rem", color: "var(--amber)" }}>⚠ Ya conectada. Reconectar reemplazará el token actual.</p>
            )}
          </div>
        )}

        {/* Steps */}
        <div style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0.85rem", fontSize: "0.78rem", color: "var(--text3)", lineHeight: 1.7 }}>
          <strong style={{ color: "var(--text2)", display: "block", marginBottom: "0.3rem" }}>📋 Pasos:</strong>
          1. Selecciona la tienda arriba<br />
          2. Click en «Ir a eBay» — se abre en nueva pestaña<br />
          3. Inicia sesión con tu cuenta de vendedor y autoriza<br />
          4. eBay te redirigirá — copia la URL completa<br />
          5. Pégala abajo y click «Conectar»
        </div>

        {/* Step 1 */}
        <button
          onClick={handleGoToEbay}
          disabled={!selectedId}
          style={{ padding: "0.65rem", background: selectedId ? "var(--blue)" : "var(--bg3)", color: selectedId ? "#fff" : "var(--text3)", border: selectedId ? "none" : "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.9rem", cursor: selectedId ? "pointer" : "not-allowed" }}
        >
          → Ir a eBay a autorizar
        </button>

        {/* Step 2 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <label style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text2)" }}>URL de redirección de eBay</label>
          <textarea
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="Pega aquí la URL completa después de autorizar..."
            rows={3}
            style={{ padding: "0.65rem 0.75rem", background: "var(--bg)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: "0.8rem", resize: "vertical", outline: "none" }}
          />
        </div>

        {error && (
          <div style={{ padding: "0.55rem 0.8rem", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: "var(--radius-sm)", color: "var(--red)", fontSize: "0.78rem" }}>
            ❌ {error}
          </div>
        )}

        <button
          onClick={handleConnect}
          disabled={loading || !url.trim() || !selectedId}
          style={{ padding: "0.65rem", background: "var(--green)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 700, fontSize: "0.92rem", cursor: loading || !url.trim() || !selectedId ? "not-allowed" : "pointer", opacity: loading || !url.trim() || !selectedId ? 0.5 : 1 }}
        >
          {loading ? "Conectando..." : "✅ Conectar"}
        </button>

        <a href="/" style={{ textAlign: "center", fontSize: "0.78rem", color: "var(--text3)", textDecoration: "none" }}>← Volver al dashboard</a>
      </div>
    </div>
  );
}

export default function ConnectPage() {
  return (
    <Suspense>
      <ConnectPageInner />
    </Suspense>
  );
}