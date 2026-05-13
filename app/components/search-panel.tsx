"use client";

interface SearchProgress {
  reviewed: number; passed: number; keyword: string;
  keywords: { done: number; total: number };
  phase2?: { reviewed: number; total: number };
  skipReasons?: { price: number; banned: number; country: number; sales: number; duplicate: number; condition: number };
}

interface SearchPanelProps {
  searchMode: "auto" | "keyword" | "url" | "1688";
  setSearchMode: (m: "auto" | "keyword" | "url" | "1688") => void;
  searching: boolean;
  paused: boolean;
  setPaused: (v: boolean) => void;
  pauseRef: React.MutableRefObject<boolean>;
  kwInput: string;
  setKwInput: (v: string) => void;
  urlInput: string;
  setUrlInput: (v: string) => void;
  storeUrlInput: string;
  setStoreUrlInput: (v: string) => void;
  keyword1688: string;
  setKeyword1688: (v: string) => void;
  importingStore: boolean;
  importProgress: { checked: number; added: number; seller: string } | null;
  searchProgress: SearchProgress | null;
  tokenExpiredStore: string | null;
  setTokenExpiredStore: (v: string | null) => void;
  savedSearchState: { keyword: string; keywordIndex: number; total: number; savedAt: number } | null;
  onSearch: (auto: boolean, startIndex?: number) => void;
  onImport: () => void;
  onImportStore: () => void;
  onSearch1688: () => void;
  onDiscardSaved: () => void;
  isStoreConnected: boolean;
}

export default function SearchPanel({
  searchMode, setSearchMode, searching, paused, setPaused, pauseRef,
  kwInput, setKwInput, urlInput, setUrlInput, storeUrlInput, setStoreUrlInput,
  keyword1688, setKeyword1688,
  importingStore, importProgress, searchProgress, tokenExpiredStore, setTokenExpiredStore,
  savedSearchState, onSearch, onImport, onImportStore, onSearch1688, onDiscardSaved,
  isStoreConnected,
}: SearchPanelProps) {

  const MODES = [
    { key: "auto",    label: "🤖 Auto" },
    { key: "keyword", label: "🔍 Keyword" },
    { key: "url",     label: "🔗 URL / Store" },
    { key: "1688",    label: "🇨🇳 1688" },
  ] as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>

      {/* Resume banner */}
      {savedSearchState && !searching && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 1rem",
          background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.3)",
          borderRadius: "var(--radius)", fontSize: "0.82rem" }}>
          <span>💾</span>
          <div style={{ flex: 1 }}>
            <span style={{ color: "var(--text)", fontWeight: 600 }}>Tienes una búsqueda guardada</span>
            <span style={{ color: "var(--text2)", marginLeft: 8 }}>
              &quot;{savedSearchState.keyword}&quot; ({savedSearchState.keywordIndex}/{savedSearchState.total})
            </span>
          </div>
          <button onClick={() => onSearch(true, savedSearchState.keywordIndex)}
            style={{ padding: "0.38rem 0.9rem", background: "var(--blue)", color: "#fff", border: "none",
              borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>
            ▶ Resume
          </button>
          <button onClick={onDiscardSaved}
            style={{ padding: "0.38rem 0.7rem", background: "transparent", color: "var(--text3)",
              border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "0.8rem", cursor: "pointer" }}>
            Descartar
          </button>
        </div>
      )}

      {/* Search panel */}
      <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1rem 1.1rem" }}>
        {/* Mode tabs */}
        <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.85rem" }}>
          {MODES.map(m => (
            <button key={m.key} onClick={() => setSearchMode(m.key)}
              style={{ padding: "0.28rem 0.85rem", borderRadius: 99, border: "1px solid",
                fontSize: "0.78rem", cursor: "pointer", fontWeight: 600,
                borderColor: searchMode === m.key ? "var(--blue)" : "var(--border)",
                background: searchMode === m.key ? "rgba(59,130,246,0.12)" : "transparent",
                color: searchMode === m.key ? "var(--blue)" : "var(--text2)" }}>
              {m.label}
            </button>
          ))}
        </div>

        {/* Auto mode */}
        {searchMode === "auto" && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <p style={{ flex: 1, fontSize: "0.8rem", color: "var(--text2)" }}>
              Cycles through all keywords searching for CN products with validated sales.
            </p>
            {!isStoreConnected && (
              <span style={{ fontSize: "0.75rem", color: "var(--amber)" }}>⚠ Connect store first</span>
            )}
            <button onClick={() => onSearch(true)} disabled={searching}
              style={{ flexShrink: 0, padding: "0.5rem 1.1rem", background: "var(--blue)", color: "#fff",
                border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.83rem",
                cursor: searching ? "not-allowed" : "pointer", opacity: searching ? 0.7 : 1 }}>
              {searching ? "⏳ Searching..." : "▶ Start search"}
            </button>
          </div>
        )}

        {/* Keyword mode */}
        {searchMode === "keyword" && (
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input value={kwInput} onChange={e => setKwInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !searching && onSearch(false)}
              placeholder="e.g. portable fan, magnetic wallet..."
              style={{ flex: 1, padding: "0.5rem 0.8rem", background: "var(--bg3)",
                border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)",
                color: "var(--text)", fontSize: "0.85rem", outline: "none" }} />
            <button onClick={() => onSearch(false)} disabled={searching}
              style={{ padding: "0.5rem 1.1rem", background: "var(--blue)", color: "#fff",
                border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.83rem", cursor: "pointer" }}>
              Buscar
            </button>
          </div>
        )}

        {/* URL mode */}
        {searchMode === "url" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <textarea value={urlInput} onChange={e => setUrlInput(e.target.value)}
              placeholder={"eBay URLs — one per line\nhttps://www.ebay.com/itm/..."} rows={3}
              style={{ padding: "0.5rem 0.8rem", background: "var(--bg3)", border: "1px solid var(--border2)",
                borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: "0.83rem", resize: "vertical", outline: "none" }} />
            <button onClick={onImport} disabled={searching || !urlInput.trim()}
              style={{ padding: "0.5rem 1.1rem", background: "var(--blue)", color: "#fff", border: "none",
                borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.83rem", cursor: "pointer", alignSelf: "flex-end" }}>
              {searching ? "⏳ Importing..." : "📥 Import URLs"}
            </button>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input value={storeUrlInput} onChange={e => setStoreUrlInput(e.target.value)}
                placeholder="eBay store URL — ebay.com/str/..."
                style={{ flex: 1, padding: "0.5rem 0.8rem", background: "var(--bg3)",
                  border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)",
                  color: "var(--text)", fontSize: "0.83rem", outline: "none" }} />
              <button onClick={onImportStore} disabled={importingStore || !storeUrlInput.trim()}
                style={{ flexShrink: 0, padding: "0.5rem 1rem", background: "var(--cyan)", color: "#fff",
                  border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>
                {importingStore ? "⏳ Scanning..." : "🏪 Import store"}
              </button>
            </div>
            {importingStore && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.5rem 0.75rem",
                background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
                fontSize: "0.78rem", color: "var(--text2)" }}>
                <div style={{ width: 12, height: 12, border: "2px solid var(--cyan)", borderTopColor: "transparent",
                  borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                Escaneando listings — puede tardar unos minutos...
              </div>
            )}
            {importProgress && !importingStore && (
              <div style={{ padding: "0.5rem 0.75rem", background: "rgba(16,185,129,0.08)",
                border: "1px solid rgba(16,185,129,0.2)", borderRadius: "var(--radius-sm)", fontSize: "0.78rem" }}>
                <strong style={{ color: "var(--green)" }}>✅ {importProgress.seller}</strong>
                <span style={{ color: "var(--text2)", marginLeft: "0.5rem" }}>
                  {importProgress.added} añadidos · {importProgress.checked} escaneados
                </span>
              </div>
            )}
          </div>
        )}

        {/* 1688 mode */}
        {searchMode === "1688" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <p style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
              Busca productos directamente en 1688.com — precios CNY convertidos a USD automáticamente.
            </p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input value={keyword1688} onChange={e => setKeyword1688(e.target.value)}
                onKeyDown={e => e.key === "Enter" && onSearch1688()}
                placeholder="e.g. organizador escritorio, soporte teléfono..."
                style={{ flex: 1, padding: "0.5rem 0.8rem", background: "var(--bg3)",
                  border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)",
                  color: "var(--text)", fontSize: "0.85rem", outline: "none" }} />
              <button onClick={onSearch1688} disabled={searching || !keyword1688.trim()}
                style={{ padding: "0.5rem 1.1rem", background: "#e4393c", color: "#fff",
                  border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.83rem", cursor: "pointer" }}>
                {searching ? "⏳ Buscando..." : "🇨🇳 Buscar en 1688"}
              </button>
            </div>
            <div style={{ fontSize: "0.71rem", color: "var(--text3)" }}>
              Powered by Oxylabs · los productos van directo a Pending para revisión manual
            </div>
          </div>
        )}
      </div>

      {/* Search progress */}
      {searching && searchProgress && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.7rem 1rem",
          background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
          fontSize: "0.8rem", color: "var(--text2)" }}>
          {!paused
            ? <div style={{ width: 14, height: 14, border: "2px solid var(--blue)", borderTopColor: "transparent",
                borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
            : <div style={{ width: 14, height: 14, background: "var(--amber)", borderRadius: "50%", flexShrink: 0 }} />
          }
          <div style={{ flex: 1, display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            {searchProgress.keywords.total > 1 && (
              <span>📋 <strong style={{ color: "var(--text)" }}>{searchProgress.keywords.done}/{searchProgress.keywords.total}</strong></span>
            )}
            {searchProgress.keyword && (
              <span>🔍 <strong style={{ color: "var(--text)" }}>&quot;{searchProgress.keyword}&quot;</strong></span>
            )}
            {searchProgress.reviewed > 0 && (
              <span>👁 <strong style={{ color: "var(--text)" }}>{searchProgress.reviewed.toLocaleString()}</strong></span>
            )}
            {searchProgress.phase2 && searchProgress.phase2.total > 0 && (
              <span style={{ color: "var(--blue)", fontSize: "0.75rem" }}>
                ↳ candidatos <strong style={{ color: "var(--text)" }}>{searchProgress.phase2.reviewed}/{searchProgress.phase2.total}</strong>
              </span>
            )}
            <span style={{ color: "var(--green)" }}>✅ <strong>{searchProgress.passed}</strong> añadidos</span>
            {searchProgress.skipReasons && (
              <>
                {searchProgress.skipReasons.sales    > 0 && <span style={{ color: "var(--amber)" }}>📉 {searchProgress.skipReasons.sales}</span>}
                {searchProgress.skipReasons.price    > 0 && <span style={{ color: "var(--text3)" }}>💰 {searchProgress.skipReasons.price}</span>}
                {searchProgress.skipReasons.banned   > 0 && <span style={{ color: "var(--red)" }}>🚫 {searchProgress.skipReasons.banned}</span>}
              </>
            )}
          </div>
          <button onClick={() => { const next = !paused; setPaused(next); pauseRef.current = next; }}
            style={{ padding: "0.28rem 0.8rem", borderRadius: "var(--radius-sm)", border: "none",
              fontWeight: 600, cursor: "pointer", fontSize: "0.75rem",
              background: paused ? "var(--green)" : "var(--amber)", color: "#000" }}>
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
        </div>
      )}

      {/* Token expired banner */}
      {tokenExpiredStore && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.8rem 1rem",
          background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: "var(--radius)", fontSize: "0.82rem" }}>
          <span style={{ fontSize: "1.1rem" }}>🔑</span>
          <div style={{ flex: 1 }}>
            <strong style={{ color: "var(--red)" }}>eBay token expired</strong>
            <span style={{ color: "var(--text2)", marginLeft: "0.5rem" }}>— Reconnect your store to continue.</span>
          </div>
          <button onClick={() => window.open(`/connect?storeId=${tokenExpiredStore}`, "_blank")}
            style={{ padding: "0.35rem 0.85rem", background: "var(--blue)", color: "#fff", border: "none",
              borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.78rem", cursor: "pointer" }}>
            🔗 Reconnect
          </button>
          <button onClick={async () => {
            await fetch(`/api/ebay/search-status?storeId=${tokenExpiredStore}`, { method: "DELETE" }).catch(() => {});
            setTokenExpiredStore(null);
          }} style={{ padding: "0.35rem 0.6rem", background: "transparent", color: "var(--text3)",
            border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "0.78rem", cursor: "pointer" }}>✕</button>
        </div>
      )}
    </div>
  );
}