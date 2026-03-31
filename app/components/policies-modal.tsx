"use client";

import { useState, useEffect } from "react";
import { db } from "@/lib/firebase-client";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { Store, StorePolicy, Settings } from "@/types";
import { useAuth } from "@/lib/auth-context";

interface Props { onClose: () => void }

const EMPTY_POLICY: StorePolicy = {
  fulfillmentPolicyId: "",
  paymentPolicyId:     "",
  returnPolicyId:      "",
  merchantLocationKey: "",
  itemCountry:         "CN",
  itemLocation:        "Shenzhen",
};

export default function PoliciesModal({ onClose }: Props) {
  const { user }    = useAuth();
  const [stores, setStores]       = useState<Store[]>([]);
  const [activeStore, setActiveStore] = useState<string>("");
  const [policies, setPolicies]   = useState<Record<string, StorePolicy>>({});
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      fetch(`/api/ebay/stores?userId=${user.uid}`).then(r => r.json()),
      getDoc(doc(db, "users", user.uid, "settings", "main")),
    ]).then(([storesData, settingsSnap]) => {
      if (storesData.stores?.length) {
        setStores(storesData.stores);
        setActiveStore(storesData.stores[0].id);
      }
      const data = settingsSnap.exists() ? settingsSnap.data() as Settings : null;
      setPolicies((data?.policies as Record<string, StorePolicy>) ?? {});
      setLoading(false);
    });
  }, [user]);

  const activePolicy: StorePolicy = policies[activeStore] ?? { ...EMPTY_POLICY };

  const setField = (field: keyof StorePolicy, val: string) => {
    setPolicies(p => ({
      ...p,
      [activeStore]: { ...(p[activeStore] ?? EMPTY_POLICY), [field]: val },
    }));
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    // Merge policies into existing settings doc
    const ref  = doc(db, "users", user.uid, "settings", "main");
    await setDoc(ref, { policies }, { merge: true });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const fields: { label: string; field: keyof StorePolicy; placeholder: string; hint: string }[] = [
    { label: "Fulfillment Policy ID", field: "fulfillmentPolicyId", placeholder: "ej: 123456789010", hint: "Política de envío" },
    { label: "Payment Policy ID",     field: "paymentPolicyId",     placeholder: "ej: 123456789011", hint: "Política de pago" },
    { label: "Return Policy ID",      field: "returnPolicyId",       placeholder: "ej: 123456789012", hint: "Política de devoluciones" },
    { label: "Merchant Location Key", field: "merchantLocationKey",  placeholder: "ej: warehouse-2",   hint: "Clave de ubicación de inventario" },
    { label: "País del item (Country code)", field: "itemCountry",  placeholder: "ej: CN",            hint: "Código ISO del país de origen" },
    { label: "Ciudad / Ubicación visible",   field: "itemLocation", placeholder: "ej: Shenzhen",      hint: "Lo que ve el comprador como origen" },
  ];

  const isDone = (p: StorePolicy) =>
    p.fulfillmentPolicyId && p.paymentPolicyId && p.returnPolicyId && p.merchantLocationKey;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", width: "100%", maxWidth: 460, maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontWeight: 600, fontSize: "0.92rem" }}>📋 Políticas eBay</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text2)", cursor: "pointer", fontSize: "1.1rem" }}>✕</button>
        </div>

        {/* Store tabs */}
        {stores.length > 1 && (
          <div style={{ display: "flex", gap: "0.35rem", padding: "0.75rem 1.25rem", borderBottom: "1px solid var(--border)", flexWrap: "wrap", flexShrink: 0 }}>
            {stores.map(s => (
              <button key={s.id} onClick={() => setActiveStore(s.id)}
                style={{
                  padding: "0.25rem 0.75rem", borderRadius: 99, border: "1px solid",
                  fontSize: "0.78rem", fontWeight: 600, cursor: "pointer",
                  borderColor: activeStore === s.id ? "var(--blue)" : "var(--border)",
                  background: activeStore === s.id ? "rgba(59,130,246,0.12)" : "transparent",
                  color: activeStore === s.id ? "var(--blue)" : "var(--text2)",
                  display: "flex", alignItems: "center", gap: "0.35rem",
                }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: isDone(policies[s.id] ?? EMPTY_POLICY) ? "var(--green)" : "var(--text3)", flexShrink: 0 }} />
                {s.name}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          {loading ? (
            <div style={{ color: "var(--text3)", fontSize: "0.85rem" }}>Cargando...</div>
          ) : stores.length === 0 ? (
            <div style={{ padding: "1.5rem", textAlign: "center", color: "var(--text3)", fontSize: "0.85rem" }}>
              Create a store first in <strong>Mis Tiendas</strong>
            </div>
          ) : (
            <>
              {/* How to find IDs */}
              <div style={{ padding: "0.65rem 0.85rem", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "0.75rem", color: "var(--text2)", lineHeight: 1.6 }}>
                <strong style={{ color: "var(--text)" }}>¿Dónde obtengo estos IDs?</strong><br />
                Call this endpoint with the store connected:<br />
                <code style={{ fontSize: "0.72rem", background: "var(--bg2)", padding: "2px 5px", borderRadius: 3, userSelect: "all" }}>
                  /api/ebay/setup?storeId={activeStore || "store_xxx"}
                </code>
                <br />
                Te devuelve todos los IDs listos para copiar.
              </div>

              {/* Policy fields */}
              {fields.map(f => (
                <div key={f.field} style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <label style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text2)" }}>{f.label}</label>
                    <span style={{ fontSize: "0.68rem", color: "var(--text3)" }}>{f.hint}</span>
                  </div>
                  <input
                    value={activePolicy[f.field]}
                    onChange={e => setField(f.field, e.target.value)}
                    placeholder={f.placeholder}
                    style={{
                      padding: "0.5rem 0.75rem",
                      background: activePolicy[f.field] ? "var(--bg3)" : "var(--bg3)",
                      border: `1px solid ${activePolicy[f.field] ? "var(--green)" : "var(--border2)"}`,
                      borderRadius: "var(--radius-sm)",
                      color: "var(--text)",
                      fontSize: "0.83rem",
                      fontFamily: "var(--font-geist-mono), monospace",
                      outline: "none",
                      transition: "border-color 0.15s",
                    }}
                    onFocus={e => e.target.style.borderColor = "var(--blue)"}
                    onBlur={e => e.target.style.borderColor = activePolicy[f.field] ? "var(--green)" : "var(--border2)"}
                  />
                </div>
              ))}

              {/* Status */}
              <div style={{ padding: "0.55rem 0.85rem", borderRadius: "var(--radius-sm)", fontSize: "0.75rem", background: isDone(activePolicy) ? "rgba(16,185,129,0.08)" : "rgba(245,158,11,0.07)", border: `1px solid ${isDone(activePolicy) ? "rgba(16,185,129,0.25)" : "rgba(245,158,11,0.25)"}`, color: isDone(activePolicy) ? "var(--green)" : "var(--amber)" }}>
                {isDone(activePolicy)
                  ? "✅ Policies complete — this store can publish"
                  : "⚠ Fill in all 4 fields to publish. Empty = uses .env values"}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "0.85rem 1.25rem", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: "0.6rem", flexShrink: 0 }}>
          <button onClick={onClose} style={{ padding: "0.5rem 1rem", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text2)", fontSize: "0.85rem", cursor: "pointer" }}>
            Cerrar
          </button>
          <button onClick={handleSave} disabled={saving || loading || stores.length === 0}
            style={{ padding: "0.5rem 1.25rem", background: saved ? "var(--green)" : "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer" }}>
            {saving ? "Saving..." : saved ? "✓ Saved" : "Save policies"}
          </button>
        </div>
      </div>
    </div>
  );
}