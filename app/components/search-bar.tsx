"use client";

import { useState, useRef } from "react";

interface Props {
  onSearch: (keywords: string) => void;
  onImport: (urls: string[]) => void;
  onAutoSearch: () => void;
  loading: boolean;
}

type Mode = "auto" | "keywords" | "urls";

const PREDEFINED_KEYWORDS = [
  "kitchen gadgets", "home organization", "storage solutions",
  "bathroom accessories", "cleaning tools", "wall art decor",
  "led strip lights", "phone accessories", "pet accessories",
  "dog toys", "cat accessories", "baby accessories",
  "fitness equipment", "yoga mat", "resistance bands",
  "garden tools", "outdoor furniture", "plant pots",
  "jewelry organizer", "makeup organizer", "hair accessories",
  "office supplies", "desk organizer", "notebook planner",
  "candles", "picture frames", "throw pillows",
  "car accessories", "trunk organizer", "seat covers",
  "kids toys", "board games", "puzzles",
];

export default function SearchBar({ onSearch, onImport, onAutoSearch, loading }: Props) {
  const [mode, setMode] = useState<Mode>("auto");
  const [keyword, setKeyword] = useState("");
  const [urlText, setUrlText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parseUrls = (text: string): string[] => {
    const lines = text.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean);
    return lines.filter((l) => l.includes("ebay.com/itm") || l.includes("ebay.com/i/"));
  };

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setUrlText(text);
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".txt")) handleFile(file);
  };

  const handleImportSubmit = () => {
    const urls = parseUrls(urlText);
    if (urls.length === 0) {
      alert("No se encontraron URLs válidas de eBay.\nAsegúrate que incluyan 'ebay.com/itm'");
      return;
    }
    onImport(urls);
  };

  const urlCount = parseUrls(urlText).length;

  return (
    <div className="search-wrap">
      {/* Mode selector */}
      <div className="mode-tabs">
        <button
          className={`mode-tab ${mode === "auto" ? "active" : ""}`}
          onClick={() => setMode("auto")}
        >
          ⚡ Auto-búsqueda
        </button>
        <button
          className={`mode-tab ${mode === "keywords" ? "active" : ""}`}
          onClick={() => setMode("keywords")}
        >
          🔍 Por keyword
        </button>
        <button
          className={`mode-tab ${mode === "urls" ? "active" : ""}`}
          onClick={() => setMode("urls")}
        >
          🔗 Importar URLs
        </button>
      </div>

      {/* AUTO MODE */}
      {mode === "auto" && (
        <div className="panel auto-panel">
          <div className="auto-info">
            <div className="auto-icon">⚡</div>
            <div>
              <p className="auto-title">Búsqueda automática inteligente</p>
              <p className="auto-desc">
                Busca <strong>{PREDEFINED_KEYWORDS.length} categorías</strong> de productos ganadores automáticamente —
                sin marcas, sin electrónica, sin autos. Solo nichos rentables de dropshipping.
              </p>
              <div className="kw-preview">
                {PREDEFINED_KEYWORDS.slice(0, 8).map((kw) => (
                  <span key={kw} className="kw-chip">{kw}</span>
                ))}
                <span className="kw-chip kw-more">+{PREDEFINED_KEYWORDS.length - 8} más</span>
              </div>
            </div>
          </div>
          <button className="btn-auto" onClick={onAutoSearch} disabled={loading}>
            {loading ? <><span className="spinner-sm" /> Buscando...</> : "⚡ Iniciar búsqueda automática"}
          </button>
        </div>
      )}

      {/* KEYWORD MODE */}
      {mode === "keywords" && (
        <div className="panel">
          <div className="search-inner">
            <span>🔍</span>
            <input
              className="search-input"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && keyword.trim() && onSearch(keyword.trim())}
              placeholder="ej: kitchen gadgets, pet accessories..."
              disabled={loading}
            />
            <button
              className="btn-search"
              onClick={() => keyword.trim() && onSearch(keyword.trim())}
              disabled={loading || !keyword.trim()}
            >
              {loading ? <span className="spinner-sm" /> : "Buscar"}
            </button>
          </div>
          <div className="quick-kws">
            <span className="quick-label">Sugerencias:</span>
            {PREDEFINED_KEYWORDS.slice(0, 10).map((kw) => (
              <button key={kw} className="kw-chip kw-clickable" onClick={() => onSearch(kw)}>
                {kw}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* URL IMPORT MODE */}
      {mode === "urls" && (
        <div className="panel url-panel">
          <div className="url-cols">
            {/* Left: paste */}
            <div className="url-col">
              <label className="col-label">📋 Pegar URLs</label>
              <textarea
                className="url-textarea"
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                placeholder={`Pega las URLs de eBay aquí, una por línea:\n\nhttps://www.ebay.com/itm/123456789\nhttps://www.ebay.com/itm/987654321\n...`}
                rows={6}
              />
            </div>

            {/* Divider */}
            <div className="url-divider">
              <div className="divider-line" />
              <span className="divider-text">ó</span>
              <div className="divider-line" />
            </div>

            {/* Right: file upload */}
            <div className="url-col">
              <label className="col-label">📄 Subir archivo .txt</label>
              <div
                className={`drop-zone ${dragOver ? "drag-over" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
              >
                <span className="drop-icon">📂</span>
                <p className="drop-title">Arrastra tu .txt aquí</p>
                <p className="drop-sub">o haz clic para seleccionar</p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt"
                  style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                />
              </div>
            </div>
          </div>

          {/* Import button */}
          <div className="import-footer">
            {urlText && (
              <span className={`url-count ${urlCount > 0 ? "valid" : "invalid"}`}>
                {urlCount > 0 ? `✅ ${urlCount} URLs válidas de eBay detectadas` : "⚠️ No se detectaron URLs válidas de eBay"}
              </span>
            )}
            <button
              className="btn-import"
              onClick={handleImportSubmit}
              disabled={loading || urlCount === 0}
            >
              {loading ? <><span className="spinner-sm" /> Importando...</> : `🚀 Importar ${urlCount > 0 ? urlCount : ""} productos`}
            </button>
          </div>
        </div>
      )}

      <style jsx>{`
        .search-wrap { margin-bottom: 1.5rem; }

        .mode-tabs {
          display: flex;
          gap: 0;
          margin-bottom: 0;
          background: #0d0d14;
          border: 1px solid #2d3748;
          border-bottom: none;
          border-radius: 10px 10px 0 0;
          overflow: hidden;
        }

        .mode-tab {
          flex: 1;
          padding: 0.7rem 1rem;
          background: none;
          border: none;
          border-right: 1px solid #2d3748;
          color: #4a5568;
          font-size: 0.85rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .mode-tab:last-child { border-right: none; }
        .mode-tab:hover { color: #94a3b8; background: #111120; }
        .mode-tab.active { color: #e2e8f0; background: #111120; font-weight: 700; }

        .panel {
          background: #0d0d14;
          border: 1px solid #2d3748;
          border-radius: 0 0 10px 10px;
          padding: 1.25rem;
        }

        /* AUTO */
        .auto-panel { display: flex; flex-direction: column; gap: 1rem; }
        .auto-info { display: flex; gap: 1rem; align-items: flex-start; }
        .auto-icon { font-size: 2rem; }
        .auto-title { font-size: 0.95rem; font-weight: 700; color: #e2e8f0; margin-bottom: 0.3rem; }
        .auto-desc { font-size: 0.82rem; color: #64748b; line-height: 1.5; margin-bottom: 0.6rem; }

        .kw-preview { display: flex; flex-wrap: wrap; gap: 0.4rem; }

        .kw-chip {
          background: #1e2235;
          border: 1px solid #2d3748;
          color: #64748b;
          font-size: 0.72rem;
          padding: 2px 8px;
          border-radius: 99px;
        }

        .kw-more { color: #3b82f6; border-color: #1e3a5f; background: #1e3a5f44; }

        .btn-auto {
          background: linear-gradient(135deg, #d97706, #f59e0b);
          color: #000;
          border: none;
          border-radius: 8px;
          padding: 0.7rem 1.5rem;
          font-size: 0.9rem;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          align-self: flex-start;
          transition: opacity 0.2s;
        }
        .btn-auto:disabled { opacity: 0.5; cursor: not-allowed; }

        /* KEYWORDS */
        .search-inner {
          display: flex;
          align-items: center;
          background: #111120;
          border: 1px solid #2d3748;
          border-radius: 8px;
          padding: 0.4rem 0.4rem 0.4rem 1rem;
          gap: 0.75rem;
          margin-bottom: 0.75rem;
        }
        .search-inner:focus-within { border-color: #3b82f6; }
        .search-input { flex: 1; background: none; border: none; color: #e2e8f0; font-size: 0.9rem; outline: none; }
        .search-input::placeholder { color: #4a5568; }
        .btn-search {
          background: #2563eb; color: #fff; border: none; border-radius: 6px;
          padding: 0.5rem 1.1rem; font-size: 0.85rem; font-weight: 600; cursor: pointer;
          display: flex; align-items: center; justify-content: center; min-width: 80px; height: 34px;
        }
        .btn-search:disabled { opacity: 0.5; cursor: not-allowed; }

        .quick-kws { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
        .quick-label { font-size: 0.75rem; color: #4a5568; margin-right: 0.25rem; }
        .kw-clickable {
          background: #1e2235; border: 1px solid #2d3748; color: #64748b;
          font-size: 0.72rem; padding: 3px 10px; border-radius: 99px;
          cursor: pointer; transition: all 0.15s;
        }
        .kw-clickable:hover { border-color: #3b82f6; color: #93c5fd; background: #1e3a5f44; }

        /* URLS */
        .url-panel { display: flex; flex-direction: column; gap: 1rem; }
        .url-cols { display: flex; gap: 0; align-items: stretch; }
        .url-col { flex: 1; display: flex; flex-direction: column; gap: 0.5rem; }
        .col-label { font-size: 0.8rem; font-weight: 600; color: #94a3b8; }

        .url-textarea {
          flex: 1;
          background: #111120;
          border: 1px solid #2d3748;
          border-radius: 8px;
          color: #e2e8f0;
          font-size: 0.8rem;
          padding: 0.75rem;
          resize: none;
          outline: none;
          font-family: monospace;
          line-height: 1.6;
          min-height: 130px;
        }
        .url-textarea:focus { border-color: #3b82f6; }
        .url-textarea::placeholder { color: #2d3748; }

        .url-divider {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 0 1rem;
          justify-content: center;
          gap: 0.5rem;
        }
        .divider-line { flex: 1; width: 1px; background: #2d3748; }
        .divider-text { font-size: 0.75rem; color: #4a5568; }

        .drop-zone {
          flex: 1;
          border: 2px dashed #2d3748;
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
          padding: 1.5rem;
          cursor: pointer;
          transition: all 0.2s;
          min-height: 130px;
          background: #111120;
        }
        .drop-zone:hover { border-color: #3b82f6; background: #1e3a5f22; }
        .drop-zone.drag-over { border-color: #3b82f6; background: #1e3a5f44; }
        .drop-icon { font-size: 1.75rem; }
        .drop-title { font-size: 0.85rem; font-weight: 600; color: #94a3b8; }
        .drop-sub { font-size: 0.75rem; color: #4a5568; }

        .import-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          flex-wrap: wrap;
        }

        .url-count { font-size: 0.82rem; font-weight: 600; }
        .url-count.valid { color: #10b981; }
        .url-count.invalid { color: #f59e0b; }

        .btn-import {
          background: linear-gradient(135deg, #1d4ed8, #2563eb);
          color: #fff; border: none; border-radius: 8px;
          padding: 0.65rem 1.5rem; font-size: 0.88rem; font-weight: 700;
          cursor: pointer; display: flex; align-items: center; gap: 0.5rem;
          margin-left: auto;
          transition: opacity 0.2s;
        }
        .btn-import:disabled { opacity: 0.5; cursor: not-allowed; }

        .spinner-sm {
          width: 14px; height: 14px;
          border: 2px solid #00000033;
          border-top-color: currentColor;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
          display: inline-block;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}