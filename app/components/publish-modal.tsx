"use client";

import { useState } from "react";
import { QueueProduct, Store } from "@/types";

interface Props {
  product: QueueProduct;
  stores: Store[];
  defaultStoreId?: string;
  onClose: () => void;
  onConfirm: (productId: string, storeIds: string[]) => Promise<void>;
}

export default function PublishModal({ product, stores, defaultStoreId, onClose, onConfirm }: Props) {
  const connectedStores = stores.filter(s => s.connected);
  // Multi-select: default to the currently active store
  const [selectedIds, setSelectedIds] = useState<string[]>(
    defaultStoreId ? [defaultStoreId] : connectedStores.length ? [connectedStores[0].id] : []
  );
  const [loading, setLoading] = useState(false);

  const toggle = (storeId: string) => {
    setSelectedIds(prev =>
      prev.includes(storeId) ? prev.filter(id => id !== storeId) : [...prev, storeId]
    );
  };

  const canPublish = selectedIds.length > 0 && selectedIds.every(id => stores.find(s => s.id === id)?.connected);
  const disconnectedSelected = selectedIds.filter(id => !stores.find(s => s.id === id)?.connected);

  const handleConfirm = async () => {
    if (!canPublish || loading) return;
    setLoading(true);
    try {
      await onConfirm(product.id, selectedIds);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  const img = product.images?.[0];

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600, fontSize: "0.92rem" }}>🚀 Publicar producto</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text2)", cursor: "pointer", fontSize: "1.1rem", lineHeight: 1 }}>✕</button>
        </div>

        {/* Product preview */}
        <div style={{ padding: "0.85rem 1.25rem", display: "flex", gap: "0.75rem", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
          {img
            ? <img src={img} alt="" style={{ width: 52, height: 52, objectFit: "cover", borderRadius: "var(--radius-sm)", flexShrink: 0, background: "var(--bg3)" }} />
            : <div style={{ width: 52, height: 52, background: "var(--bg3)", borderRadius: "var(--radius-sm)", flexShrink: 0 }} />
          }
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "0.83rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{product.title}</div>
            <div style={{ fontSize: "0.78rem", color: "var(--text2)", marginTop: 2 }}>
              ${product.suggestedSellingPrice.toFixed(2)}
              {product.marginPercent != null && <span style={{ marginLeft: 6, color: "var(--green)" }}>+{product.marginPercent.toFixed(0)}%</span>}
            </div>
          </div>
        </div>

        {/* Store multi-selector */}
        <div style={{ padding: "0.85rem 1.25rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 2 }}>
            Publicar en tiendas <span style={{ color: "var(--text3)", fontWeight: 400, textTransform: "none" }}>(select one or more)</span>
          </div>

          {stores.length === 0 ? (
            <div style={{ padding: "0.75rem", background: "var(--bg3)", borderRadius: "var(--radius-sm)", fontSize: "0.82rem", color: "var(--amber)" }}>
              ⚠ No stores found. Create one in My Stores.
            </div>
          ) : (
            stores.map(store => {
              const isSelected = selectedIds.includes(store.id);
              return (
                <div
                  key={store.id}
                  onClick={() => toggle(store.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: "0.75rem",
                    padding: "0.65rem 0.85rem", borderRadius: "var(--radius-sm)",
                    border: "1px solid", cursor: "pointer",
                    borderColor: isSelected ? "var(--blue)" : "var(--border)",
                    background: isSelected ? "rgba(59,130,246,0.07)" : "var(--bg3)",
                  }}
                >
                  {/* Checkbox */}
                  <div style={{
                    width: 16, height: 16, borderRadius: 4, border: `2px solid ${isSelected ? "var(--blue)" : "var(--border2)"}`,
                    background: isSelected ? "var(--blue)" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  }}>
                    {isSelected && <span style={{ color: "#fff", fontSize: 10, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                  </div>
                  {/* Status dot */}
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: store.connected ? "var(--green)" : "var(--text3)", flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>{store.name}</div>
                    <div style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
                      {store.marketplace}{store.connected ? " · Connected" : " · Not connected"}
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {disconnectedSelected.length > 0 && (
            <div style={{ padding: "0.5rem 0.75rem", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: "var(--radius-sm)", fontSize: "0.76rem", color: "var(--amber)" }}>
              ⚠ {disconnectedSelected.map(id => stores.find(s => s.id === id)?.name).join(", ")} no active token → Go to My Stores → Connect.
            </div>
          )}

          {selectedIds.length > 1 && (
            <div style={{ padding: "0.4rem 0.75rem", background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: "var(--radius-sm)", fontSize: "0.73rem", color: "var(--blue)" }}>
              📢 Will publish to {selectedIds.length} stores simultaneously
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ padding: "0.85rem 1.25rem", borderTop: "1px solid var(--border)", display: "flex", gap: "0.6rem", justifyContent: "flex-end" }}>
          <button onClick={onClose}
            style={{ padding: "0.5rem 1rem", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text2)", fontSize: "0.85rem", cursor: "pointer" }}>
            Cancelar
          </button>
          <button onClick={handleConfirm} disabled={loading || !canPublish || selectedIds.length === 0}
            style={{
              padding: "0.5rem 1.1rem",
              background: canPublish && selectedIds.length > 0 ? "var(--green)" : "var(--border2)",
              border: "none", borderRadius: "var(--radius-sm)", color: "#fff",
              fontSize: "0.85rem", fontWeight: 600,
              cursor: loading || !canPublish || selectedIds.length === 0 ? "not-allowed" : "pointer",
              opacity: loading ? 0.7 : 1,
            }}>
            {loading
              ? "Publishing..."
              : selectedIds.length === 0
                ? "Select a store"
                : selectedIds.length === 1
                  ? `Publish to ${stores.find(s => s.id === selectedIds[0])?.name ?? "..."}`
                  : `Publish to ${selectedIds.length} stores`}
          </button>
        </div>
      </div>
    </div>
  );
}