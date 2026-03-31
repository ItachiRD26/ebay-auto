"use client";

import { useState } from "react";
import { Store } from "@/types";

const MARKETPLACES = [
  { value: "EBAY_US", label: "🇺🇸 eBay USA" },
  { value: "EBAY_UK", label: "🇬🇧 eBay UK" },
  { value: "EBAY_DE", label: "🇩🇪 eBay Alemania" },
  { value: "EBAY_AU", label: "🇦🇺 eBay Australia" },
  { value: "EBAY_CA", label: "🇨🇦 eBay Canadá" },
  { value: "EBAY_ES", label: "🇪🇸 eBay España" },
];

interface Props {
  stores: Store[];
  userId: string;
  onClose: () => void;
  onStoresChange: (stores: Store[]) => void;
}

export default function StoreModal({ stores, userId, onClose, onStoresChange }: Props) {
  const [newName, setNewName]       = useState("");
  const [newMarket, setNewMarket]   = useState("EBAY_US");
  const [adding, setAdding]         = useState(false);
  const [showForm, setShowForm]     = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError]           = useState("");

  const toast = (msg: string) => { setError(msg); setTimeout(() => setError(""), 3000); };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const res  = await fetch("/api/ebay/stores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), marketplace: newMarket, userId }),
      });
      const data = await res.json();
      if (data.error) { toast("❌ " + data.error); return; }
      onStoresChange([...stores, data.store]);
      setNewName("");
      setShowForm(false);
    } finally {
      setAdding(false);
    }
  };

  const handleConnect = (storeId: string) => {
    window.location.href = `/connect?storeId=${storeId}`;
  };

  const handleDelete = async (storeId: string, name: string) => {
    if (!confirm(`¿Eliminar "${name}"? Se eliminarán sus tokens de acceso.`)) return;
    setDeletingId(storeId);
    try {
      await fetch("/api/ebay/stores", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId, userId }),
      });
      onStoresChange(stores.filter(s => s.id !== storeId));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", width: "100%", maxWidth: 460, maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontWeight: 600, fontSize: "0.92rem" }}>🏪 Mis Tiendas eBay</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text2)", cursor: "pointer", fontSize: "1.1rem" }}>✕</button>
        </div>

        {/* Store list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0.75rem 1.25rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {stores.length === 0 && !showForm && (
            <div style={{ textAlign: "center", padding: "2rem", color: "var(--text3)", fontSize: "0.85rem" }}>
              <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🏪</div>
              No tienes tiendas. Agrega una abajo.
            </div>
          )}

          {stores.map(store => (
            <div key={store.id} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.8rem 0.9rem", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: store.connected ? "var(--green)" : "var(--text3)", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "0.87rem" }}>{store.name}</div>
                <div style={{ fontSize: "0.73rem", color: "var(--text3)" }}>
                  {MARKETPLACES.find(m => m.value === store.marketplace)?.label ?? store.marketplace}
                  {store.connected
                    ? store.connectedAt ? ` · Conectada ${new Date(store.connectedAt).toLocaleDateString()}` : " · Conectada"
                    : " · Sin conectar"}
                  {(store as unknown as { ebayUsername?: string }).ebayUsername
                    ? ` · @${(store as unknown as { ebayUsername: string }).ebayUsername}`
                    : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.35rem", flexShrink: 0 }}>
                <button
                  onClick={() => handleConnect(store.id)}
                  style={{ padding: "0.3rem 0.75rem", background: store.connected ? "transparent" : "var(--blue)", color: store.connected ? "var(--text2)" : "#fff", border: `1px solid ${store.connected ? "var(--border)" : "var(--blue)"}`, borderRadius: "var(--radius-sm)", fontSize: "0.75rem", fontWeight: 600, cursor: "pointer" }}
                >
                  {store.connected ? "Reconectar" : "Conectar →"}
                </button>
                <button
                  onClick={() => handleDelete(store.id, store.name)}
                  disabled={deletingId === store.id}
                  style={{ padding: "0.3rem 0.6rem", background: "transparent", color: "var(--red)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "0.75rem", cursor: "pointer" }}
                >
                  {deletingId === store.id ? "..." : "✕"}
                </button>
              </div>
            </div>
          ))}

          {/* Add store form */}
          {showForm && (
            <div style={{ padding: "0.85rem", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <div style={{ fontSize: "0.82rem", fontWeight: 600 }}>Nueva tienda</div>
              <input
                placeholder="Nombre (ej: US Store Principal)"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleAdd()}
                autoFocus
                style={{ padding: "0.5rem 0.75rem", background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: "0.85rem", outline: "none" }}
              />
              <select
                value={newMarket}
                onChange={e => setNewMarket(e.target.value)}
                style={{ padding: "0.5rem 0.75rem", background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: "0.85rem", outline: "none" }}
              >
                {MARKETPLACES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  onClick={handleAdd}
                  disabled={adding || !newName.trim()}
                  style={{ flex: 1, padding: "0.5rem", background: "var(--green)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer" }}
                >
                  {adding ? "Creating..." : "Create store"}
                </button>
                <button
                  onClick={() => { setShowForm(false); setNewName(""); }}
                  style={{ padding: "0.5rem 0.85rem", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text2)", fontSize: "0.85rem", cursor: "pointer" }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {error && (
            <div style={{ padding: "0.5rem 0.75rem", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "var(--radius-sm)", color: "var(--red)", fontSize: "0.8rem" }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "0.85rem 1.25rem", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          {!showForm && stores.length < 5 ? (
            <button
              onClick={() => setShowForm(true)}
              style={{ width: "100%", padding: "0.55rem", background: "transparent", border: "1px dashed var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--blue)", fontSize: "0.85rem", fontWeight: 600, cursor: "pointer" }}
            >
              + Agregar tienda ({stores.length}/5)
            </button>
          ) : !showForm ? (
            <p style={{ textAlign: "center", fontSize: "0.8rem", color: "var(--text3)" }}>Maximum de 5 stores limit reached</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}