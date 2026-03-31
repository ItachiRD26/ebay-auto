"use client";

import { useState, useEffect } from "react";
import { db } from "@/lib/firebase-client";
import { useAuth } from "@/lib/auth-context";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { Settings } from "@/types";

const DEFAULTS: Settings = {
  minPrice: 15, maxPrice: 150, markupPercent: 6, minSoldCount: 5,
  minMarginPercent: 30, defaultStock: 1, ebayMarketplace: "EBAY_US",
  autoSearchEnabled: false, searchIntervalMinutes: 60,
  searchKeywords: [], onlyFreeShipping: false, onlyNewCondition: true,
};

interface Props { onClose: () => void }

export default function FiltersModal({ onClose }: Props) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);

  useEffect(() => {
    getDoc(doc(db, "users", user?.uid ?? "", "settings", "main")).then(s => {
      if (s.exists()) setSettings({ ...DEFAULTS, ...s.data() as Settings });
    });
  }, []);

  const set = (key: keyof Settings, val: unknown) =>
    setSettings(p => ({ ...p, [key]: val }));

  const handleSave = async () => {
    setSaving(true);
    await setDoc(doc(db, "users", user?.uid ?? "", "settings", "main"), settings);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const NumField = ({ label, field, prefix }: { label: string; field: keyof Settings; prefix: string }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
      <label style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text2)" }}>{label}</label>
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
    <div
      onClick={() => set(field, !settings[field])}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.75rem 0", borderBottom: "1px solid var(--border)", cursor: "pointer", gap: "1rem" }}
    >
      <div>
        <div style={{ fontSize: "0.87rem", fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: "0.73rem", color: "var(--text3)" }}>{desc}</div>
      </div>
      <div style={{ width: 36, height: 20, borderRadius: 99, background: settings[field] ? "var(--green)" : "var(--border2)", position: "relative", flexShrink: 0, transition: "background 0.2s" }}>
        <div style={{ position: "absolute", top: 3, left: settings[field] ? 18 : 3, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
      </div>
    </div>
  );

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
          <span style={{ fontWeight: 600, fontSize: "0.92rem" }}>⚙ Filtros y configuración</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text2)", cursor: "pointer", fontSize: "1.1rem" }}>✕</button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.25rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>

          {/* Precio */}
          <div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "0.75rem" }}>💰 Precio</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <NumField label="Precio mínimo" field="minPrice" prefix="$" />
              <NumField label="Precio máximo" field="maxPrice" prefix="$" />
              <NumField label="Markup %" field="markupPercent" prefix="%" />
              <NumField label="Margen mínimo" field="minMarginPercent" prefix="%" />
            </div>
          </div>

          {/* Ventas */}
          <div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "0.75rem" }}>📦 Ventas y stock</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <NumField label="Ventas mínimas totales" field="minSoldCount" prefix="#" />
              <NumField label="Stock por defecto" field="defaultStock" prefix="#" />
            </div>
          </div>

          {/* Calidad */}
          <div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "0.25rem" }}>🔍 Calidad</div>
            <Toggle label="Solo condición NEW" desc="Excluir usados y reacondicionados" field="onlyNewCondition" />
            <Toggle label="Solo Free Shipping" desc="Solo productos con envío gratis" field="onlyFreeShipping" />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "0.85rem 1.25rem", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: "0.6rem", flexShrink: 0 }}>
          <button onClick={onClose} style={{ padding: "0.5rem 1rem", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text2)", fontSize: "0.85rem", cursor: "pointer" }}>
            Cerrar
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ padding: "0.5rem 1.25rem", background: saved ? "var(--green)" : "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer" }}
          >
            {saving ? "Guardando..." : saved ? "✓ Guardado" : "Guardar cambios"}
          </button>
        </div>
      </div>
    </div>
  );
}