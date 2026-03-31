"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth-context";

interface Props { onClose: () => void }

export default function KeywordsModal({ onClose }: Props) {
  const { user } = useAuth();
  const [autoKws, setAutoKws]         = useState<string[]>([]);
  const [excludedKws, setExcludedKws] = useState<string[]>([]);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState<"auto" | "excluded" | null>(null);
  const [saved, setSaved]             = useState<"auto" | "excluded" | null>(null);
  const [activeTab, setActiveTab]     = useState<"auto" | "excluded">("auto");
  const [addInput, setAddInput]       = useState("");
  const [rawText, setRawText]         = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const isAuto     = activeTab === "auto";
  const setKws     = isAuto ? setAutoKws : setExcludedKws;

  useEffect(() => {
    fetch(`/api/ebay/keywords?userId=${user?.uid ?? ""}`)
      .then(r => r.json())
      .then(d => {
        if (d.autoKeywords)     setAutoKws(d.autoKeywords);
        if (d.excludedKeywords) setExcludedKws(d.excludedKeywords);
        setLoading(false);
      });
  }, []);

  // Sync rawText when tab changes or list loads
  useEffect(() => {
    const list = isAuto ? autoKws : excludedKws;
    setRawText(list.join("\n"));
  }, [activeTab, loading]); // eslint-disable-line

  const parseRaw = (text: string): string[] =>
    text.split("\n").map(k => k.trim()).filter(Boolean);

  const flushAndSetKws = () => {
    const parsed = parseRaw(rawText);
    setKws(parsed);
    return parsed;
  };

  const handleAdd = () => {
    const raw = addInput.trim();
    if (!raw) return;

    let newKws: string[];

    // If contains explicit separators (comma, newline, tab, semicolon) — split on those
    if (/[,\n\t;]/.test(raw)) {
      newKws = raw.split(/[,\n\t;]+/).map(k => k.trim().toLowerCase()).filter(Boolean);
    } else if (raw.includes(" ")) {
      // Space only — could be multi-word phrase or space-separated words
      // Heuristic: if average word count per "token" > 1.5, treat whole thing as one phrase
      // Otherwise split by space (user is pasting a list of single words)
      const words = raw.split(/\s+/);
      newKws = words.length <= 3 ? [raw.toLowerCase()] : words.map(k => k.toLowerCase());
    } else {
      newKws = [raw.toLowerCase()];
    }

    newKws = newKws.filter(Boolean);
    if (!newKws.length) return;

    const current = parseRaw(rawText);
    const unique  = newKws.filter(k => !current.includes(k));
    if (!unique.length) { setAddInput(""); return; }
    const merged = [...current, ...unique];
    setKws(merged);
    setRawText(merged.join("\n"));
    setAddInput("");
    inputRef.current?.focus();
  };

  const handleSave = async () => {
    const list = flushAndSetKws();
    setSaving(activeTab);
    const key = isAuto ? "autoKeywords" : "excludedKeywords";
    await fetch("/api/ebay/keywords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: list, userId: user?.uid ?? "" }),
    });
    setSaving(null);
    setSaved(activeTab);
    setTimeout(() => setSaved(null), 2000);
  };

  const handleReset = async () => {
    if (!confirm("Resetear ambas listas a los valores por defecto?")) return;
    await fetch(`/api/ebay/keywords?userId=${user?.uid ?? ""}`, { method: "DELETE" });
    const res  = await fetch(`/api/ebay/keywords?userId=${user?.uid ?? ""}`);
    const data = await res.json();
    setAutoKws(data.autoKeywords);
    setExcludedKws(data.excludedKeywords);
    setRawText((isAuto ? data.autoKeywords : data.excludedKeywords).join("\n"));
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", width: "100%", maxWidth: 560, height: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontWeight: 600, fontSize: "0.92rem" }}>🔑 Keywords</span>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button onClick={handleReset} style={{ fontSize: "0.75rem", padding: "0.25rem 0.7rem", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text3)", cursor: "pointer" }}>
              ↺ Reset defaults
            </button>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text2)", cursor: "pointer", fontSize: "1.1rem" }}>✕</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          {([ ["auto", "🔍 Auto-search"], ["excluded", "🚫 Blocked"] ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => { flushAndSetKws(); setActiveTab(key); }}
              style={{
                flex: 1, padding: "0.6rem", background: "none", border: "none",
                borderBottom: activeTab === key ? "2px solid var(--blue)" : "2px solid transparent",
                color: activeTab === key ? "var(--blue)" : "var(--text2)",
                fontWeight: activeTab === key ? 600 : 400,
                fontSize: "0.85rem", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: "0.4rem",
              }}
            >
              {label}
              <span style={{ fontSize: "0.7rem", padding: "1px 6px", borderRadius: 99, background: "var(--border2)", color: "var(--text2)" }}>
                {key === "auto" ? autoKws.length : excludedKws.length}
              </span>
            </button>
          ))}
        </div>

        {/* Add input */}
        <div style={{ padding: "0.65rem 1.25rem", borderBottom: "1px solid var(--border)", display: "flex", gap: "0.5rem", flexShrink: 0 }}>
          <input
            ref={inputRef}
            value={addInput}
            onChange={e => setAddInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAdd()}
            placeholder="Paste keywords — comma, space, newline, any format"
            style={{ flex: 1, padding: "0.45rem 0.75rem", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: "0.83rem", outline: "none" }}
          />
          <button
            onClick={handleAdd}
            disabled={!addInput.trim()}
            style={{ padding: "0.45rem 0.9rem", background: "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.83rem", cursor: "pointer", opacity: addInput.trim() ? 1 : 0.4, whiteSpace: "nowrap" }}
          >
            + Agregar
          </button>
        </div>

        {/* Desc */}
        <div style={{ padding: "0.4rem 1.25rem", background: "var(--bg3)", flexShrink: 0, fontSize: "0.73rem", color: "var(--text3)" }}>
          {isAuto ? "Edit directly or add from above. One per line. Save when done." : "Product is discarded if its title contains any of these. One per line."}
        </div>

        {/* Textarea — raw, sin filtrar al escribir */}
        <div style={{ flex: 1, padding: "0.75rem 1.25rem", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {loading ? (
            <div style={{ color: "var(--text3)", fontSize: "0.85rem" }}>Cargando...</div>
          ) : (
            <textarea
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              spellCheck={false}
              placeholder="One keyword per line..."
              style={{
                flex: 1, width: "100%", padding: "0.75rem",
                background: "var(--bg3)", border: "1px solid var(--border2)",
                borderRadius: "var(--radius-sm)", color: "var(--text)",
                fontSize: "0.82rem", fontFamily: "var(--font-geist-mono), monospace",
                resize: "none", outline: "none", lineHeight: 1.7,
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "0.85rem 1.25rem", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>
            {parseRaw(rawText).length} keywords
          </span>
          <button
            onClick={handleSave}
            disabled={saving !== null}
            style={{
              padding: "0.5rem 1.25rem",
              background: saved === activeTab ? "var(--green)" : isAuto ? "var(--blue)" : "var(--red)",
              color: "#fff", border: "none", borderRadius: "var(--radius-sm)",
              fontWeight: 600, fontSize: "0.85rem", cursor: "pointer",
            }}
          >
            {saving === activeTab ? "Saving..." : saved === activeTab ? "✓ Saved" : "💾 Save list"}
          </button>
        </div>
      </div>
    </div>
  );
}