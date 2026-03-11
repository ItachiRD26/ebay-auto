"use client";

import { useState, useEffect } from "react";
import { db } from "@/lib/firebase-client";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { Settings } from "@/types";

const DEFAULTS: Settings = {
  minPrice: 15,
  maxPrice: 150,
  markupPercent: 40,
  minSoldCount: 2,
  minMarginPercent: 30,
  defaultStock: 10,
  ebayMarketplace: "EBAY_US",
  autoSearchEnabled: false,
  searchIntervalMinutes: 60,
  searchKeywords: [],
  onlyFreeShipping: false,
  onlyNewCondition: true,
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [ebayConnected, setEbayConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [kwInput, setKwInput] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("success") === "connected") setEbayConnected(true);
    getDoc(doc(db, "settings", "main")).then((s) => {
      if (s.exists()) setSettings({ ...DEFAULTS, ...s.data() as Settings });
    });
    getDoc(doc(db, "tokens", "ebay_user")).then((s) => {
      if (s.exists()) setEbayConnected(true);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    await setDoc(doc(db, "settings", "main"), settings);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleConnect = async () => {
    setConnecting(true);
    const res = await fetch("/api/ebay/oauth", { method: "POST" });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    setConnecting(false);
  };

  const set = (key: keyof Settings, val: unknown) =>
    setSettings((p) => ({ ...p, [key]: val }));

  return (
    <div className="page">
      <header className="header">
        <a href="/" className="back">← Dashboard</a>
        <h1>⚙ Configuración</h1>
      </header>

      <main className="main">

        {/* ── eBay Connection ───────────────────────────────────────── */}
        <section className="section">
          <h2 className="section-title">Conexión eBay</h2>
          <div className="card">
            <div className="status-row">
              <span className={`dot ${ebayConnected ? "on" : "off"}`} />
              <span className="status-text">{ebayConnected ? "Tienda conectada ✅" : "No conectado"}</span>
            </div>
            <p className="desc">Conecta tu cuenta de vendedor para publicar automáticamente.</p>
            <button className={`btn ${ebayConnected ? "btn-secondary" : "btn-primary"}`} onClick={handleConnect} disabled={connecting}>
              {connecting ? "Redirigiendo..." : ebayConnected ? "Reconectar cuenta" : "Conectar cuenta eBay"}
            </button>
          </div>
        </section>

        {/* ── Price Filters ─────────────────────────────────────────── */}
        <section className="section">
          <h2 className="section-title">💰 Filtros de precio</h2>
          <p className="section-desc">Solo productos dentro de este rango entrarán a la cola.</p>
          <div className="fields-row">
            <div className="field">
              <label className="field-label">Precio mínimo ($)</label>
              <div className="input-prefix-wrap">
                <span className="prefix">$</span>
                <input className="field-input" type="number" min="0"
                  value={settings.minPrice}
                  onChange={(e) => set("minPrice", parseInt(e.target.value))} />
              </div>
            </div>
            <div className="field">
              <label className="field-label">Precio máximo ($)</label>
              <div className="input-prefix-wrap">
                <span className="prefix">$</span>
                <input className="field-input" type="number" min="0"
                  value={settings.maxPrice}
                  onChange={(e) => set("maxPrice", parseInt(e.target.value))} />
              </div>
            </div>
            <div className="field">
              <label className="field-label">Markup automático (%)</label>
              <div className="input-prefix-wrap">
                <span className="prefix">%</span>
                <input className="field-input" type="number" min="0" max="200"
                  value={settings.markupPercent}
                  onChange={(e) => set("markupPercent", parseInt(e.target.value))} />
              </div>
            </div>
            <div className="field">
              <label className="field-label">Margen mínimo (%)</label>
              <div className="input-prefix-wrap">
                <span className="prefix">%</span>
                <input className="field-input" type="number" min="0" max="100"
                  value={settings.minMarginPercent}
                  onChange={(e) => set("minMarginPercent", parseInt(e.target.value))} />
              </div>
            </div>
          </div>
        </section>

        {/* ── Sales Filter ──────────────────────────────────────────── */}
        <section className="section">
          <h2 className="section-title">📦 Filtros de ventas</h2>
          <p className="section-desc">Criterios para considerar un producto como ganador.</p>
          <div className="fields-row">
            <div className="field">
              <label className="field-label">Ventas mínimas</label>
              <p className="field-desc">Unidades vendidas requeridas</p>
              <input className="field-input" type="number" min="0"
                value={settings.minSoldCount}
                onChange={(e) => set("minSoldCount", parseInt(e.target.value))} />
            </div>
            <div className="field">
              <label className="field-label">Stock por defecto</label>
              <p className="field-desc">Cantidad en cada listing nuevo</p>
              <input className="field-input" type="number" min="1"
                value={settings.defaultStock}
                onChange={(e) => set("defaultStock", parseInt(e.target.value))} />
            </div>
          </div>
        </section>

        {/* ── Quality Filters ───────────────────────────────────────── */}
        <section className="section">
          <h2 className="section-title">🔍 Filtros de calidad</h2>
          <div className="toggles">
            <label className="toggle-row">
              <div className="toggle-info">
                <span className="toggle-label">Solo condición NEW</span>
                <span className="toggle-desc">Excluir productos usados o reacondicionados</span>
              </div>
              <div
                className={`toggle ${settings.onlyNewCondition ? "toggle-on" : ""}`}
                onClick={() => set("onlyNewCondition", !settings.onlyNewCondition)}
              >
                <div className="toggle-thumb" />
              </div>
            </label>
            <label className="toggle-row">
              <div className="toggle-info">
                <span className="toggle-label">Solo Free Shipping</span>
                <span className="toggle-desc">Solo productos con envío gratis disponible</span>
              </div>
              <div
                className={`toggle ${settings.onlyFreeShipping ? "toggle-on" : ""}`}
                onClick={() => set("onlyFreeShipping", !settings.onlyFreeShipping)}
              >
                <div className="toggle-thumb" />
              </div>
            </label>
          </div>
        </section>

        {/* ── Blocked Categories ────────────────────────────────────── */}
        <section className="section">
          <h2 className="section-title">🚫 Categorías bloqueadas</h2>
          <p className="section-desc">Estas categorías siempre se excluyen automáticamente.</p>
          <div className="blocked-list">
            {[
              { label: "🚗 Automotive / Motors", id: "6000" },
              { label: "📱 Consumer Electronics (marca)", id: "293" },
              { label: "💻 Computers & Networking", id: "9355" },
              { label: "👟 Clothing de marca", id: "11450" },
              { label: "📚 Books (bajo margen)", id: "267" },
            ].map((cat) => (
              <div key={cat.id} className="blocked-item">
                <span className="blocked-icon">🚫</span>
                <span>{cat.label}</span>
                <span className="blocked-id">ID: {cat.id}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Keywords ─────────────────────────────────────────────── */}
        <section className="section">
          <h2 className="section-title">🔑 Palabras clave personalizadas</h2>
          <p className="section-desc">Se agregan a las {29} keywords predefinidas en la auto-búsqueda.</p>
          <div className="kw-row">
            <input className="kw-input" value={kwInput} onChange={(e) => setKwInput(e.target.value)}
              placeholder="ej: wireless earbuds" onKeyDown={(e) => e.key === "Enter" && kwInput.trim() && (set("searchKeywords", [...settings.searchKeywords, kwInput.trim()]), setKwInput(""))} />
            <button className="btn btn-secondary kw-add" onClick={() => {
              if (kwInput.trim() && !settings.searchKeywords.includes(kwInput.trim())) {
                set("searchKeywords", [...settings.searchKeywords, kwInput.trim()]);
                setKwInput("");
              }
            }}>+ Agregar</button>
          </div>
          <div className="kw-list">
            {settings.searchKeywords.length === 0
              ? <p className="kw-empty">Sin palabras clave personalizadas</p>
              : settings.searchKeywords.map((kw) => (
                <span key={kw} className="kw-tag">
                  {kw}
                  <button className="kw-remove" onClick={() => set("searchKeywords", settings.searchKeywords.filter((k) => k !== kw))}>×</button>
                </span>
              ))}
          </div>
        </section>

        <button className="btn btn-save" onClick={handleSave} disabled={saving}>
          {saving ? "Guardando..." : saved ? "✓ Guardado!" : "Guardar cambios"}
        </button>
      </main>

      <style jsx>{`
        .page { min-height: 100vh; background: #0a0a0f; color: #e2e8f0; font-family: var(--font-geist-sans), sans-serif; }
        .header { display: flex; align-items: center; gap: 1.5rem; padding: 1rem 2rem; border-bottom: 1px solid #1e2235; background: #0d0d14; }
        .back { color: #4a5568; text-decoration: none; font-size: 0.85rem; transition: color 0.2s; }
        .back:hover { color: #94a3b8; }
        h1 { font-size: 1.1rem; font-weight: 600; margin: 0; }
        .main { max-width: 760px; margin: 0 auto; padding: 2rem; display: flex; flex-direction: column; gap: 2rem; }
        .section { display: flex; flex-direction: column; gap: 1rem; }
        .section-title { font-size: 1rem; font-weight: 700; padding-bottom: 0.5rem; border-bottom: 1px solid #1e2235; margin: 0; }
        .section-desc { font-size: 0.82rem; color: #64748b; margin: 0; }

        .card { background: #0d0d14; border: 1px solid #1e2235; border-radius: 12px; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
        .status-row { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; }
        .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
        .dot.on { background: #10b981; box-shadow: 0 0 6px #10b981; }
        .dot.off { background: #ef4444; }
        .status-text { font-size: 0.9rem; }
        .desc { font-size: 0.82rem; color: #64748b; margin: 0; }

        .fields-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 1rem; }
        .field { display: flex; flex-direction: column; gap: 0.3rem; }
        .field-label { font-size: 0.82rem; font-weight: 600; color: #94a3b8; }
        .field-desc { font-size: 0.72rem; color: #4a5568; margin: 0; }

        .input-prefix-wrap { display: flex; align-items: center; background: #0d0d14; border: 1px solid #2d3748; border-radius: 8px; overflow: hidden; width: fit-content; }
        .prefix { padding: 0.45rem 0.5rem; color: #4a5568; font-size: 0.85rem; background: #111120; border-right: 1px solid #2d3748; }
        .field-input { background: #0d0d14; border: none; border-radius: 0; color: #e2e8f0; font-size: 0.95rem; padding: 0.45rem 0.6rem; outline: none; width: 80px; }

        .toggles { display: flex; flex-direction: column; gap: 0; background: #0d0d14; border: 1px solid #1e2235; border-radius: 12px; overflow: hidden; }
        .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; border-bottom: 1px solid #1e2235; cursor: pointer; }
        .toggle-row:last-child { border-bottom: none; }
        .toggle-row:hover { background: #111120; }
        .toggle-info { display: flex; flex-direction: column; gap: 0.2rem; }
        .toggle-label { font-size: 0.88rem; font-weight: 600; color: #e2e8f0; }
        .toggle-desc { font-size: 0.75rem; color: #4a5568; }
        .toggle { width: 40px; height: 22px; background: #2d3748; border-radius: 99px; position: relative; transition: background 0.2s; flex-shrink: 0; }
        .toggle-on { background: #10b981; }
        .toggle-thumb { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; background: #fff; border-radius: 50%; transition: transform 0.2s; }
        .toggle-on .toggle-thumb { transform: translateX(18px); }

        .blocked-list { background: #0d0d14; border: 1px solid #1e2235; border-radius: 12px; overflow: hidden; }
        .blocked-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1.25rem; border-bottom: 1px solid #1e2235; font-size: 0.85rem; }
        .blocked-item:last-child { border-bottom: none; }
        .blocked-icon { font-size: 0.9rem; }
        .blocked-id { margin-left: auto; font-size: 0.72rem; color: #4a5568; font-family: monospace; }

        .kw-row { display: flex; gap: 0.5rem; }
        .kw-input { flex: 1; background: #0d0d14; border: 1px solid #2d3748; border-radius: 8px; color: #e2e8f0; font-size: 0.9rem; padding: 0.5rem 0.75rem; outline: none; }
        .kw-input:focus { border-color: #3b82f6; }
        .kw-add { white-space: nowrap; }
        .kw-list { display: flex; flex-wrap: wrap; gap: 0.4rem; min-height: 36px; }
        .kw-empty { font-size: 0.82rem; color: #4a5568; }
        .kw-tag { display: flex; align-items: center; gap: 0.4rem; background: #1e2235; border: 1px solid #2d3748; color: #94a3b8; font-size: 0.8rem; padding: 0.3rem 0.6rem; border-radius: 99px; }
        .kw-remove { background: none; border: none; color: #64748b; cursor: pointer; font-size: 1rem; line-height: 1; padding: 0; }
        .kw-remove:hover { color: #ef4444; }

        .btn { padding: 0.6rem 1.25rem; border-radius: 8px; font-size: 0.85rem; font-weight: 600; cursor: pointer; border: none; transition: all 0.2s; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-primary { background: #2563eb; color: #fff; }
        .btn-primary:hover:not(:disabled) { background: #1d4ed8; }
        .btn-secondary { background: #1a1a2e; color: #94a3b8; border: 1px solid #2d3748; }
        .btn-secondary:hover:not(:disabled) { border-color: #4a5568; color: #e2e8f0; }
        .btn-save { background: #10b981; color: #fff; padding: 0.75rem 2rem; font-size: 0.95rem; align-self: flex-start; }
        .btn-save:hover:not(:disabled) { background: #059669; }
      `}</style>
    </div>
  );
}