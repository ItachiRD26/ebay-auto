"use client";

import { useState, useEffect, useRef } from "react";
import { db } from "@/lib/firebase-client";
import { collection, query, where, onSnapshot, orderBy, limit } from "firebase/firestore";
import { QueueProduct } from "@/types";
import ProductCard from "@/components/product-card";
import SearchBar from "@/components/search-bar";
import StatsBar from "@/components/stats-bar";

type TabType = "pending" | "approved" | "published" | "rejected" | "failed";

export default function Dashboard() {
  const [products, setProducts] = useState<QueueProduct[]>([]);
  const [activeTab, setActiveTab] = useState<TabType>("pending");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [paused, setPaused] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<{delisted:number,checked:number} | null>(null);
  const pauseRef = useRef(false);
  const [searchProgress, setSearchProgress] = useState<{reviewed:number;passed:number;published:number;failed:number;keyword:string;keywords:{done:number;total:number}} | null>(null);
  const [stats, setStats] = useState({ pending: 0, approved: 0, published: 0, rejected: 0, failed: 0 });

  useEffect(() => {
    const q = query(
      collection(db, "products_queue"),
      where("status", "==", activeTab),
      orderBy("createdAt", "desc"),
      limit(50)
    );
    const unsub = onSnapshot(q, (snap) => {
      setProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as QueueProduct[]);
      setLoading(false);
    });
    return () => unsub();
  }, [activeTab]);

  useEffect(() => {
    const statuses: TabType[] = ["pending", "approved", "published", "rejected", "failed"];
    const unsubs = statuses.map((status) =>
      onSnapshot(
        query(collection(db, "products_queue"), where("status", "==", status)),
        (snap) => setStats((p) => ({ ...p, [status]: snap.size }))
      )
    );
    return () => unsubs.forEach((u) => u());
  }, []);

  // Poll search progress while searching
  useEffect(() => {
    if (!searching) { setSearchProgress(null); return; }
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/ebay/search-status");
        const data = await res.json();
        if (data.active) setSearchProgress(data);
        else if (searchProgress) setSearchProgress(null);
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [searching]);

  const handleSearch = async (keywords: string, isAuto = false) => {
    setSearching(true);
    try {
      if (isAuto) {
        // Fetch keyword list from server
        const kwRes = await fetch("/api/ebay/search");
        const { keywords: allKws } = await kwRes.json() as { keywords: string[] };
        const reversed = [...allKws].reverse();

        // Init progress
        setSearchProgress({ reviewed: 0, passed: 0, published: 0, failed: 0, keyword: "", keywords: { done: 0, total: reversed.length } });

        for (let i = 0; i < reversed.length; i++) {
          // Wait while paused
          while (pauseRef.current) {
            await new Promise(r => setTimeout(r, 500));
          }
          const kw = reversed[i];
          setSearchProgress(p => p ? { ...p, keyword: kw, keywords: { done: i, total: reversed.length } } : p);
          try {
            const res = await fetch("/api/ebay/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ keywords: kw }),
            });
            const data = await res.json();
            setSearchProgress(p => p ? {
              ...p,
              reviewed:  p.reviewed  + (data.reviewed  ?? 0),
              passed:    p.passed    + (data.added      ?? 0),
              published: p.published + (data.published  ?? 0),
              failed:    p.failed    + (data.skipped    ?? 0),
              keyword: kw,
              keywords: { done: i + 1, total: reversed.length },
            } : p);
          } catch (e) {
            console.warn(`Keyword "${kw}" failed:`, e);
            setSearchProgress(p => p ? { ...p, keywords: { done: i + 1, total: reversed.length } } : p);
          }
        }
      } else {
        await fetch("/api/ebay/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords, limit: 50 }),
        });
      }
    } finally {
      setSearching(false);
      setPaused(false);
      pauseRef.current = false;
      setSearchProgress(null);
    }
  };;

  const handleAutoSearch = async () => {
    await handleSearch("", true);
  };;

  const handleImport = async (urls: string[]) => {
    setSearching(true);
    try {
      const res = await fetch("/api/ebay/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Build a detailed result message
      let msg = `✅ Importados: ${data.added}  |  ⚠️ Duplicados: ${data.skipped}`;

      if (data.filtered > 0) {
        msg += `
🔍 Filtrados (${data.filtered}):`;
        (data.filterLog as string[])?.forEach((l) => { msg += `
  • ${l}`; });
      }

      if (data.errors > 0) {
        msg += `

❌ Errores (${data.errors}):`;
        (data.errorLog as string[])?.forEach((l) => { msg += `
  • ${l}`; });
      }

      alert(msg);
      setActiveTab("pending");
    } catch (err: unknown) {
      alert("Error: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSearching(false);
    }
  };

  const patch = (productId: string, updates: object) =>
    fetch("/api/ebay/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, updates }),
    });

  const handlePublish = async (productId: string) => {
    const res = await fetch("/api/ebay/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId }),
    });
    const data = await res.json();
    if (data.error) alert("Error al publicar: " + data.error);
  };

  const [publishingAll, setPublishingAll] = useState(false);
  const [publishProgress, setPublishProgress] = useState({ done: 0, total: 0, errors: 0 });

  const handlePublishAll = async () => {
    if (!confirm(`¿Publicar todos los ${stats.approved} productos aprobados?`)) return;
    setPublishingAll(true);
    setPublishProgress({ done: 0, total: stats.approved, errors: 0 });
    let done = 0, errors = 0;
    for (const p of products) {
      try {
        const res = await fetch("/api/ebay/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: p.id }),
        });
        const data = await res.json();
        if (data.error) errors++;
        else done++;
      } catch { errors++; }
      setPublishProgress({ done: done + errors, total: stats.approved, errors });
      await new Promise(r => setTimeout(r, 500)); // small delay between publishes
    }
    setPublishingAll(false);
    alert(`✅ Publicados: ${done} | ❌ Errores: ${errors}`);
  };


  const handleCleanPublished = async () => {
    if (!confirm("¿Revisar todos los listings publicados y deslistar los que tengan keywords baneadas?")) return;
    setCleaning(true);
    setCleanResult(null);
    try {
      const res = await fetch("/api/ebay/clean-published", { method: "POST" });
      const data = await res.json();
      if (data.error) alert("Error: " + data.error);
      else {
        setCleanResult({ delisted: data.delisted, checked: data.checked }); // onSnapshot updates automatically
      }
    } finally {
      setCleaning(false);
    }
  };

  const handlePromoteAll = async () => {
    if (!confirm(`¿Agregar 2% Promoted Listings a todos los productos publicados? (los que ya lo tengan serán ignorados por eBay)`)) return;
    setPromoting(true);
    try {
      const res = await fetch("/api/ebay/promote", { method: "POST" });
      const data = await res.json();
      if (data.error) alert("Error: " + data.error);
      else alert(`✅ Actualizados: ${data.updated} | ❌ Fallidos: ${data.failed}`);
    } finally {
      setPromoting(false);
    }
  };

  const tabs = [
    { key: "pending" as TabType, label: "Pendientes", color: "#f59e0b" },
    { key: "approved" as TabType, label: "Aprobados", color: "#10b981" },
    { key: "published" as TabType, label: "Publicados", color: "#3b82f6" },
    { key: "rejected" as TabType, label: "Rechazados", color: "#ef4444" },
    { key: "failed" as TabType, label: "Fallidos", color: "#f97316" },
  ];

  const activeTabLabel = tabs.find((t) => t.key === activeTab)?.label?.toLowerCase() ?? "";

  return (
    <div className="dashboard">
      <header className="header">
        <div className="header-left">
          <div className="logo">⚡ <span>DropFlow</span></div>
          <span className="header-sub">eBay Automation</span>
        </div>
        <a href="/settings" className="settings-btn">⚙ Settings</a>
      </header>

      <main className="main">
        <StatsBar stats={stats} />

        <SearchBar
          onSearch={handleSearch}
          onAutoSearch={handleAutoSearch}
          onImport={handleImport}
          loading={searching}
        />

        {searching && (
          <div style={{ display:"flex", alignItems:"center", gap:"1rem", justifyContent:"space-between", padding:"0.75rem 1rem", background:"#0d0d14", border:"1px solid #1e2235", borderRadius:"10px", marginBottom:"1rem", fontSize:"0.85rem", color:"#94a3b8" }}>
            <div style={{ display:"flex", alignItems:"center", gap:"0.75rem", flex:1 }}>
              {!paused && <div style={{ width:16, height:16, border:"2px solid #3b82f6", borderTopColor:"transparent", borderRadius:"50%", animation:"spin 0.8s linear infinite", flexShrink:0 }} />}
              {paused && <div style={{ width:16, height:16, background:"#f59e0b", borderRadius:"50%", flexShrink:0 }} />}
              {searchProgress ? (
                <div style={{ display:"flex", gap:"1.5rem", flexWrap:"wrap" }}>
                  {searchProgress.keywords.total > 1 && (
                    <span>📋 Keywords: <strong style={{color:"#e2e8f0"}}>{searchProgress.keywords.done}/{searchProgress.keywords.total}</strong></span>
                  )}
                  {searchProgress.keyword && (
                    <span>🔍 <strong style={{color:"#e2e8f0"}}>"{searchProgress.keyword}"</strong></span>
                  )}
                  <span>👁 Revisados: <strong style={{color:"#e2e8f0"}}>{searchProgress.reviewed}</strong></span>
                  <span>✅ Pasaron: <strong style={{color:"#10b981"}}>{searchProgress.passed}</strong></span>
                  <span>🚀 Publicados: <strong style={{color:"#3b82f6"}}>{searchProgress.published}</strong></span>
                  {searchProgress.failed > 0 && <span>🚫 Filtrados: <strong style={{color:"#64748b"}}>{searchProgress.failed}</strong></span>}
                </div>
              ) : (
                <span>Iniciando búsqueda...</span>
              )}
            </div>
            <button
              onClick={() => { paused ? (setPaused(false), pauseRef.current = false) : (setPaused(true), pauseRef.current = true); }}
              style={{ flexShrink:0, padding:"0.35rem 0.9rem", borderRadius:"6px", border:"none", fontWeight:600, cursor:"pointer", fontSize:"0.8rem",
                background: paused ? "#10b981" : "#f59e0b", color:"#000" }}>
              {paused ? "▶ Reanudar" : "⏸ Pausar"}
            </button>
          </div>
        )}

        <div className="tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`tab ${activeTab === tab.key ? "tab-active" : ""}`}
              style={activeTab === tab.key ? { borderColor: tab.color, color: tab.color } : {}}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              <span className="tab-badge" style={activeTab === tab.key ? { background: tab.color } : {}}>
                {stats[tab.key]}
              </span>
            </button>
          ))}
        </div>


        {activeTab === "published" && stats.published > 0 && (
          <div style={{ display:"flex", justifyContent:"flex-end", gap:"0.75rem", marginBottom:"1rem", alignItems:"center" }}>
            {cleanResult && (
              <span style={{ fontSize:"0.82rem", color: cleanResult.delisted > 0 ? "#f87171" : "#10b981" }}>
                {cleanResult.delisted > 0
                  ? `🗑 ${cleanResult.delisted} deslisting de ${cleanResult.checked} revisados`
                  : `✅ ${cleanResult.checked} revisados — todo limpio`}
              </span>
            )}
            <button onClick={handleCleanPublished} disabled={cleaning}
              style={{ background:"#dc2626", color:"#fff", border:"none", borderRadius:"8px", padding:"0.5rem 1.2rem", fontWeight:600, cursor:cleaning?"not-allowed":"pointer", opacity:cleaning?0.6:1 }}>
              {cleaning ? "Revisando..." : `🧹 Limpiar baneados`}
            </button>
            <button onClick={handlePromoteAll} disabled={promoting}
              style={{ background:"#7c3aed", color:"#fff", border:"none", borderRadius:"8px", padding:"0.5rem 1.2rem", fontWeight:600, cursor:promoting?"not-allowed":"pointer", opacity:promoting?0.6:1 }}>
              {promoting ? "Aplicando ads..." : `📢 Agregar 2% Ads a todos (${stats.published})`}
            </button>
          </div>
        )}
        {activeTab === "approved" && stats.approved > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
            {publishingAll && (
              <span style={{ color: "#64748b", fontSize: "0.85rem", marginRight: "1rem", alignSelf: "center" }}>
                {publishProgress.done}/{publishProgress.total} publicados
                {publishProgress.errors > 0 && ` · ${publishProgress.errors} errores`}
              </span>
            )}
            <button
              onClick={handlePublishAll}
              disabled={publishingAll}
              style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: "8px", padding: "0.5rem 1.2rem", fontWeight: 600, cursor: publishingAll ? "not-allowed" : "pointer", opacity: publishingAll ? 0.6 : 1 }}
            >
              {publishingAll ? "Publicando..." : `🚀 Publicar Todos (${stats.approved})`}
            </button>
          </div>
        )}

        <div className="products-grid">
          {loading ? (
            <div className="empty-state">
              <div className="spinner" />
              <p>Cargando...</p>
            </div>
          ) : products.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: "3rem" }}>
                {activeTab === "pending" ? "🔍" : activeTab === "approved" ? "✅" : activeTab === "published" ? "🚀" : activeTab === "failed" ? "⚠️" : "❌"}
              </span>
              <p style={{ color: "#64748b", fontWeight: 600 }}>
                {activeTab === "pending" ? "Cola vacía — busca productos arriba" : activeTab === "failed" ? "No hay productos fallidos ✅" : `No hay productos ${activeTabLabel}`}
              </p>
            </div>
          ) : (
            products.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                onApprove={() => patch(p.id, { status: "approved" })}
                onReject={() => patch(p.id, { status: "rejected" })}
                onPublish={() => handlePublish(p.id)}
                onUpdate={(updates) => patch(p.id, updates)}
              />
            ))
          )}
        </div>
      </main>

      <style jsx>{`
        .dashboard { min-height: 100vh; background: #0a0a0f; color: #e2e8f0; font-family: var(--font-geist-sans), sans-serif; }
        .header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 2rem; border-bottom: 1px solid #1e2235; background: #0d0d14; position: sticky; top: 0; z-index: 100; }
        .header-left { display: flex; align-items: center; gap: 1rem; }
        .logo { display: flex; align-items: center; gap: 0.5rem; font-size: 1.2rem; font-weight: 700; }
        .header-sub { color: #4a5568; font-size: 0.8rem; border-left: 1px solid #2d3748; padding-left: 1rem; }
        .settings-btn { background: #1a1a2e; border: 1px solid #2d3748; color: #94a3b8; padding: 0.5rem 1rem; border-radius: 8px; font-size: 0.85rem; text-decoration: none; }
        .main { max-width: 1400px; margin: 0 auto; padding: 2rem; }
        .tabs { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; border-bottom: 1px solid #1e2235; }
        .tab { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1.2rem; background: none; border: none; border-bottom: 2px solid transparent; color: #4a5568; font-size: 0.9rem; cursor: pointer; margin-bottom: -1px; }
        .tab:hover { color: #94a3b8; }
        .tab-active { font-weight: 600; }
        .tab-badge { background: #2d3748; color: #fff; font-size: 0.7rem; font-weight: 700; padding: 1px 6px; border-radius: 99px; }
        .products-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.25rem; }
        .empty-state { grid-column: 1/-1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 5rem 2rem; gap: 1rem; }
        .spinner { width: 36px; height: 36px; border: 3px solid #1e2235; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}