"use client";

import { useState, useEffect } from "react";
import { db } from "@/lib/firebase-client";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { Settings, StorePolicy, Store } from "@/types";
import { useAuth } from "@/lib/auth-context";

const DEFAULTS: Settings = {
  minPrice: 15, maxPrice: 150, markupPercent: 6, minSoldCount: 5,
  minSold30d: 3, maxVariations: 12, minMarginPercent: 30, defaultStock: 10,
  ebayMarketplace: "EBAY_US", autoSearchEnabled: false,
  searchIntervalMinutes: 60, searchKeywords: [],
  onlyFreeShipping: false, onlyNewCondition: true,
  policies: {},
};

interface Props { onClose: () => void }

export default function FiltersModal({ onClose }: Props) {
  const { user }        = useAuth();
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [stores, setStores]     = useState<Store[]>([]);
  const [activeStore, setActiveStore] = useState<string>("");

  useEffect(() => {
    if (!user) return;
    getDoc(doc(db, "users", user.uid, "settings", "main")).then(s => {
      if (s.exists()) setSettings({ ...DEFAULTS, ...s.data() as Settings });
    });
    fetch(`/api/ebay/stores?userId=${user.uid}`)
      .then(r => r.json())
      .then(d => {
        if (d.stores?.length) {
          setStores(d.stores);
          setActiveStore(d.stores[0].id);
        }
      });
  }, [user]);

  const set = (key: keyof Settings, val: unknown) =>
    setSettings(p => ({ ...p, [key]: val }));

  const setPolicy = (storeId: string, field: keyof StorePolicy, val: string) => {
    setSettings(p => ({
      ...p,
      policies: {
        ...p.policies,
        [storeId]: { ...(p.policies?.[storeId] ?? { fulfillmentPolicyId: "", paymentPolicyId: "", returnPolicyId: "", merchantLocationKey: "", itemCountry: "CN", itemLocation: "Shenzhen" }), [field]: val },
      },
    }));
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    await setDoc(doc(db, "users", user.uid, "settings", "main"), settings);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const activePolicy: StorePolicy = settings.policies?.[activeStore] ?? { fulfillmentPolicyId: "", paymentPolicyId: "", returnPolicyId: "", merchantLocationKey: "", itemCountry: "CN", itemLocation: "Shenzhen" };

  const NumField = ({ label, field, prefix, desc }: { label: string; field: keyof Settings; prefix: string; desc?: string }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
      <label style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text2)" }}>{label}</label>
      {desc && <span style={{ fontSize: "0.68rem", color: "var(--text3)" }}>{desc}</span>}
      <div style={{ display: "flex", alignItems: "center", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
        <span style={{ padding: "0.4rem 0.6rem", color: "var(--text3)", fontSize: "0.85rem", background: "var(--bg2)", borderRight: "1px solid var(--border2)" }}>{prefix}</span>
        <input
          type="number" min="0"
          value={settings[field] as number}
          onChange={e => set(field, parseFloat(e.target.value) || 0)}
          style={{ background: "none", border: "none", color: "var(--text)", fontSize: "0.9rem", padding: "0.4rem 0.6rem", outline: "none", width: 80 }}
        />
      </div>
    </div>
  );

  const Toggle = ({ label, desc, field }: { label: string; desc: string; field: keyof Settings }) => (
    <div onClick={() => set(field, !settings[field])}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.75rem 0", borderBottom: "1px solid var(--border)", cursor: "pointer", gap: "1rem" }}>
      <div>
        <div style={{ fontSize: "0.87rem", fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: "0.73rem", color: "var(--text3)" }}>{desc}</div>
      </div>
      <div style={{ width: 36, height: 20, borderRadius: 99, background: settings[field] ? "var(--green)" : "var(--border2)", position: "relative", flexShrink: 0, transition: "background 0.2s" }}>
        <div style={{ position: "absolute", top: 3, left: settings[field] ? 18 : 3, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
      </div>
    </div>
  );

  const PolicyField = ({ label, field, placeholder }: { label: string; field: keyof StorePolicy; placeholder: string }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
      <label style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text2)" }}>{label}</label>
      <input
        value={activePolicy[field]}
        onChange={e => setPolicy(activeStore, field, e.target.value)}
        placeholder={placeholder}
        style={{ padding: "0.45rem 0.7rem", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: "0.82rem", outline: "none", fontFamily: "var(--font-geist-mono), monospace" }}
      />
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }} onClick={onClose}>
      <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", width: "100%", maxWidth: 480, maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden" }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontWeight: 600, fontSize: "0.92rem" }}>⚙ Filtros y configuración</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text2)", cursor: "pointer", fontSize: "1.1rem" }}>✕</button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.25rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>

          {/* Precio */}
          <section>
            <div style={sectionLabel}>💰 Precio</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <NumField label="Min price" field="minPrice" prefix="$" />
              <NumField label="Max price" field="maxPrice" prefix="$" />
              <NumField label="Markup %" field="markupPercent" prefix="%" />
              <NumField label="Min margin" field="minMarginPercent" prefix="%" />
            </div>
          </section>

          {/* Ventas */}
          <section>
            <div style={sectionLabel}>📦 Ventas mínimas requeridas</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <NumField label="Total sales" field="minSoldCount" prefix="#" desc="Historical minimum" />
              <NumField label="Sales / 30 days" field="minSold30d" prefix="#" desc="Estimated minimum/month" />
              <NumField label="Default stock" field="defaultStock" prefix="#" />
              <NumField label="Max variations" field="maxVariations" prefix="#" desc="Products with more variations are skipped" />
            </div>
          </section>

          {/* Calidad */}
          <section>
            <div style={sectionLabel}>🔍 Calidad</div>
            <Toggle label="NEW condition only" desc="Exclude used and refurbished" field="onlyNewCondition" />
            <Toggle label="Free Shipping only" desc="Only products with free shipping" field="onlyFreeShipping" />
          </section>

          {/* Policies por tienda */}
          <section>
            <div style={sectionLabel}>📋 Políticas eBay por tienda</div>
            <p style={{ fontSize: "0.73rem", color: "var(--text3)", marginBottom: "0.75rem", lineHeight: 1.5 }}>
              IDs of your eBay Business Policies. Get them: <code style={{ fontSize: "0.7rem", background: "var(--bg3)", padding: "1px 4px", borderRadius: 3 }}>/api/ebay/setup?storeId=...</code>
            </p>

            {/* Store selector */}
            {stores.length > 0 && (
              <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginBottom: "0.85rem" }}>
                {stores.map(s => (
                  <button key={s.id} onClick={() => setActiveStore(s.id)}
                    style={{ padding: "0.25rem 0.7rem", borderRadius: 99, border: "1px solid", fontSize: "0.75rem", cursor: "pointer", fontWeight: 600,
                      borderColor: activeStore === s.id ? "var(--blue)" : "var(--border)",
                      background: activeStore === s.id ? "rgba(59,130,246,0.12)" : "transparent",
                      color: activeStore === s.id ? "var(--blue)" : "var(--text2)",
                    }}>
                    {s.name}
                  </button>
                ))}
              </div>
            )}

            {activeStore && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                <PolicyField label="Fulfillment Policy ID" field="fulfillmentPolicyId" placeholder="ej: 12345678901" />
                <PolicyField label="Payment Policy ID"     field="paymentPolicyId"     placeholder="ej: 12345678902" />
                <PolicyField label="Return Policy ID"      field="returnPolicyId"       placeholder="ej: 12345678903" />
                <PolicyField label="Merchant Location Key" field="merchantLocationKey"  placeholder="ej: WAREHOUSE_1" />
                <p style={{ fontSize: "0.68rem", color: "var(--text3)" }}>
                  Vacío = usa el .env como fallback. Cada tienda puede tener políticas distintas.
                </p>
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div style={{ padding: "0.85rem 1.25rem", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: "0.6rem", flexShrink: 0 }}>
          <button onClick={onClose} style={{ padding: "0.5rem 1rem", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text2)", fontSize: "0.85rem", cursor: "pointer" }}>
            Cerrar
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: "0.5rem 1.25rem", background: saved ? "var(--green)" : "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer" }}>
            {saving ? "Saving..." : saved ? "✓ Saved" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: "0.72rem", fontWeight: 700, color: "var(--text3)",
  textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "0.75rem",
};