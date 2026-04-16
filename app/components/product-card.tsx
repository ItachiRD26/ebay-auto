"use client";

import { useState, useEffect } from "react";
import { QueueProduct } from "@/types";

interface Props {
  product: QueueProduct;
  onApprove: () => void;
  onReject: () => void;
  onPublish: () => void;
  onForcePublish?: () => void;
  onUpdate: (updates: Partial<QueueProduct>) => void;
}

export default function ProductCard({ product, onApprove, onReject, onPublish, onForcePublish, onUpdate }: Props) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(product.title ?? "");
  const [editCategoryId, setEditCategoryId] = useState(product.categoryId ?? "");
  const [price, setPrice] = useState((product.suggestedSellingPrice ?? 0).toString());
  const [eproloPrice, setEproloPrice] = useState(product.eproloPrice?.toString() ?? "");
  const [description, setDescription] = useState(product.description ?? "");
  const [stock, setStock] = useState(product.stock?.toString() ?? "10");
  const [currentImg, setCurrentImg] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [delisting, setDelisting] = useState(false);
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [showForceModal, setShowForceModal] = useState(false);
  const [generatingDesc, setGeneratingDesc] = useState(false);

  const generateDescription = async (titleToUse?: string) => {
    setGeneratingDesc(true);
    try {
      const res = await fetch("/api/ebay/generate-desc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: titleToUse ?? editTitle ?? product.title }),
      });
      const data = await res.json();
      if (data.description) setDescription(data.description);
    } catch { /* silent fail */ } finally {
      setGeneratingDesc(false);
    }
  };

  // ── Pricing ───────────────────────────────────────────────────────────────
  // isVariation: has a REAL price range from GetItem (refPriceMax > refPriceMin)
  // showMarkupUI: show the markup slider for ALL products (old+new, variation+single)
  //   Old products in Firestore don't have refPriceMin/Max yet — they still get the slider
  //   using ebayReferencePrice as the base. New variation products show a range.
  const refMin = product.refPriceMin ?? product.ebayReferencePrice ?? 0;
  const refMax = product.refPriceMax ?? product.ebayReferencePrice ?? 0;
  const isVariation = refMax > refMin && refMin > 0;
  const showMarkupUI = (refMin > 0) || (product.markupPercent !== undefined);

  const defaultMarkup = product.markupPercent ?? 6;
  const [markupPct, setMarkupPct] = useState<number>(defaultMarkup);

  // Sync local state when product prop changes from outside (Firestore real-time updates)
  // Only sync when not actively editing to avoid interrupting user input
  useEffect(() => {
    if (!editing) {
      setPrice((product.suggestedSellingPrice ?? 0).toString());
      setMarkupPct(product.markupPercent ?? 6);
      setDescription(product.description ?? "");
      setStock(product.stock?.toString() ?? "10");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.suggestedSellingPrice, product.markupPercent, product.description, product.stock]);

  // Live preview prices based on current slider value
  const myMinPrice = +((refMin || product.totalMarketCost || 0) * (1 + markupPct / 100)).toFixed(2);
  const myMaxPrice = isVariation ? +(refMax * (1 + markupPct / 100)).toFixed(2) : myMinPrice;

  // ── Non-variation pricing (kept for editing single-price products) ─────────
  const sellingPrice = parseFloat(price) || 0;
  const costPrice = parseFloat(eproloPrice) || 0;
  const margin = costPrice > 0 ? sellingPrice - costPrice : null;
  const marginPct = margin !== null && sellingPrice > 0 ? ((margin / sellingPrice) * 100).toFixed(1) : null;
  const marginColor = marginPct === null ? "#64748b" : parseFloat(marginPct) >= 30 ? "#10b981" : parseFloat(marginPct) >= 15 ? "#f59e0b" : "#ef4444";

  const handleSave = () => {
    if (editTitle && editTitle !== product.title) onUpdate({ title: editTitle });
    if (editCategoryId && editCategoryId !== product.categoryId) onUpdate({ categoryId: editCategoryId });
    if (isVariation) {
      onUpdate({
        markupPercent: markupPct,
        suggestedSellingPrice: myMinPrice || product.suggestedSellingPrice,
        description,
        stock: parseInt(stock) || 10,
      });
    } else {
      onUpdate({
        suggestedSellingPrice: sellingPrice,
        markupPercent: product.totalMarketCost > 0
          ? Math.round(((sellingPrice / product.totalMarketCost) - 1) * 100)
          : product.markupPercent ?? 6,
        eproloPrice: costPrice || null,
        description,
        stock: parseInt(stock) || 10,
        margin,
        marginPercent: marginPct ? parseFloat(marginPct) : null,
      });
    }
    setEditing(false);
  };

  const handleForcePublish = async () => {
    setPublishing(true);
    try { await onForcePublish?.(); } finally { setPublishing(false); }
  };

  const handleDelist = async () => {
    if (!confirm("Delist this product from eBay?")) return;
    setDelisting(true);
    try {
      const res = await fetch("/api/ebay/delist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.id, listingId: product.listingId, storeId: product.storeId, userId: product.userId }),
      });
      const data = await res.json();
      if (data.error) { alert("Error delisting: " + data.error); } else { alert("✅ Product delisted from eBay"); }
    } finally { setDelisting(false); }
  };

  const handlePublish = async () => {
    setPublishing(true);
    if (product.status === "failed") {
      await onUpdate({ status: "approved" });
    }
    await onPublish();
    setPublishing(false);
  };


  const saveMarkup = (pct: number) => {
    const base = refMin || product.totalMarketCost || product.ebayReferencePrice || 0;
    onUpdate({
      markupPercent: pct,
      suggestedSellingPrice: +(base * (1 + pct / 100)).toFixed(2),
    });
  };

  const images = product.images?.length ? product.images : [];

  return (
    <div className={`card card-${product.status}`}>

      {/* Image */}
      <div className="img-wrap">
        {images.length > 0 ? (
          <img
            src={images[currentImg]}
            alt={product.title}
            className="product-img"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div className="no-img">Sin imagen</div>
        )}
        {images.length > 1 && (
          <div className="img-dots">
            {images.map((_, i) => (
              <button key={i} className={`dot ${i === currentImg ? "dot-active" : ""}`} onClick={() => setCurrentImg(i)} />
            ))}
          </div>
        )}
        <div className="img-count">{images.length} photos</div>
        <div className={`status-badge status-${product.status}`}>
          {product.status === "pending" ? "⏳ Pendiente"
            : product.status === "approved" ? "✅ Aprobado"
            : product.status === "published" ? "🚀 Publicado"
            : "❌ Rejected"}
        </div>
      </div>

      {/* Body */}
      <div className="card-body">
        <p className="category">{product.categoryName || "Sin categoría"}</p>
        <h3 className="title">{product.title}</h3>

        <div className="meta-row">
          {(product.soldCount ?? 0) > 0 && (
            <span className="meta-item">📦 {product.soldCount.toLocaleString()} sold</span>
          )}
          {product.status === "published" && product.listingId ? (
            <a href={`https://www.ebay.com/itm/${product.listingId}`} target="_blank" rel="noreferrer" className="source-link">🛒 Ver mi listing ↗</a>
          ) : (
            <a href={product.sourceUrl} target="_blank" rel="noreferrer" className="source-link">View reference ↗</a>
          )}
        </div>

        {/* Pricing */}
        <div className="pricing">
          {/* Price row — always shown */}
          <div className="price-row" style={{ marginBottom: showMarkupUI ? "0.6rem" : 0 }}>
            <div className="price-item">
              <span className="price-label">Ref. eBay</span>
              <span className="price-value ref">
                ${refMin.toFixed(2)}
                {isVariation && (
                  <span style={{ fontSize: "0.8rem", color: "#64748b" }}> – ${refMax.toFixed(2)}</span>
                )}
              </span>
            </div>
            <div className="price-item">
              <span className="price-label">{isVariation ? "Tu rango" : "Tu precio"}</span>
              <span className="price-value sell">
                {/* Variations: markup-calculated range. Single items: actual saved price */}
                ${(isVariation ? myMinPrice : (product.suggestedSellingPrice ?? myMinPrice)).toFixed(2)}
                {isVariation && myMaxPrice !== myMinPrice && (
                  <span style={{ fontSize: "0.8rem" }}> – ${myMaxPrice.toFixed(2)}</span>
                )}
              </span>
            </div>
            {product.eproloPrice && !showMarkupUI && (
              <div className="price-item">
                <span className="price-label">eProlo</span>
                <span className="price-value cost">${product.eproloPrice.toFixed(2)}</span>
              </div>
            )}
          </div>

          {/* Price editor — shown when editing */}
          {editing && (
            <div style={{ background: "#0d0d14", borderRadius: 6, padding: "0.5rem 0.6rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="price-label">{isVariation ? "Markup %" : "Tu precio"}</span>
                {isVariation ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="number" min={0} max={100} value={markupPct}
                      onChange={e => setMarkupPct(Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                      onBlur={() => saveMarkup(markupPct)}
                      style={{ width: 50, background: "#0d0d14", border: "1px solid #2d3748", borderRadius: 4, color: "#e2e8f0", fontSize: "0.85rem", padding: "2px 6px", textAlign: "right", outline: "none" }}
                    />
                    <span style={{ fontSize: "0.75rem", color: "#64748b" }}>%</span>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: "0.8rem", color: "#64748b" }}>$</span>
                    <input
                      type="number" min={0} step={0.01} value={price}
                      onChange={e => setPrice(e.target.value)}
                      onBlur={() => {
                        const v = parseFloat(price);
                        if (!isNaN(v) && v > 0) {
                          const base = refMin || product.totalMarketCost || 0;
                          const newMarkup = base > 0 ? Math.round(((v / base) - 1) * 100) : (product.markupPercent ?? 6);
                          setMarkupPct(newMarkup);
                          onUpdate({ suggestedSellingPrice: v, markupPercent: newMarkup });
                        }
                      }}
                      style={{ width: 70, background: "#0d0d14", border: "1px solid #2d3748", borderRadius: 4, color: "#e2e8f0", fontSize: "0.85rem", padding: "2px 6px", textAlign: "right", outline: "none" }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Margin bar — single-price products without markup UI (eProlo price set) */}
          {!showMarkupUI && marginPct !== null && (
            <div className="margin-bar">
              <span className="margin-label">Margen</span>
              <span className="margin-value" style={{ color: marginColor }}>${margin?.toFixed(2)} · {marginPct}%</span>
            </div>
          )}
        </div>

        {/* Edit form (non-failed) */}
        {editing && (
          <div className="desc-wrap">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.3rem" }}>
              <label className="field-label" style={{ margin: 0 }}>Descripción</label>
              <button onClick={() => generateDescription()} disabled={generatingDesc}
                style={{ background: "linear-gradient(135deg, #6366f1, #4f46e5)", border: "none", borderRadius: 5, color: "#fff", fontSize: "0.65rem", fontWeight: 600, padding: "2px 8px", cursor: generatingDesc ? "not-allowed" : "pointer", opacity: generatingDesc ? 0.7 : 1 }}>
                {generatingDesc ? "⏳" : "✨ IA"}
              </button>
            </div>
            <textarea className="desc-input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Short product description..." rows={3} />
            <div style={{ marginTop: "0.5rem" }}>
              <label className="field-label">Stock</label>
              <input className="stock-input" type="number" value={stock} onChange={e => setStock(e.target.value)} min="1" />
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div>
          {product.status === "pending" && (
            <div style={{ display: "grid", gap: "0.4rem", gridTemplateColumns: editing ? "auto auto 1fr 1fr" : "1fr 1fr" }}>
              <button className="btn btn-edit" onClick={() => setEditing(!editing)}>{editing ? "✕" : "✏ Edit"}</button>
              {editing && <button className="btn btn-save" onClick={handleSave}>💾</button>}
              <button className="btn btn-reject" onClick={() => setShowRejectConfirm(true)}>✕ Reject</button>
              <button className="btn btn-approve" onClick={() => { handleSave(); onApprove(); }}>✓ Aprobar</button>
            </div>
          )}

          {product.status === "approved" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              <div style={{ display: "grid", gap: "0.4rem", gridTemplateColumns: editing ? "auto auto auto 1fr" : "auto auto 1fr" }}>
                <button className="btn btn-icon btn-edit" onClick={() => setEditing(!editing)} title={editing ? "Cancel" : "Edit"}>{editing ? "✕" : "✏"}</button>
                {editing && <button className="btn btn-icon btn-save" onClick={handleSave} title="Save">💾</button>}
                <button className="btn btn-icon btn-reject" onClick={() => setShowRejectConfirm(true)} title="Reject">✕</button>
                <button className="btn btn-publish" onClick={handlePublish} disabled={publishing}
                  title="DropFlow publica automáticamente con Claude" style={{ fontSize: "0.78rem" }}>
                  {publishing ? "..." : "🚀 Auto"}
                </button>
              </div>
              {publishing && (
                <div style={{ fontSize: "0.72rem", color: "var(--text3)", textAlign: "center" }}>
                  {publishing ? "🚀 Publicando automáticamente..." : "🚀 Publicando..."}
                </div>
              )}
            </div>
          )}

          {product.status === "published" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.4rem", alignItems: "center" }}>
              <span className="published-info" title={`ID: ${product.listingId}`}>
                ✅ ID {product.listingId}{product.bidPercentage ? ` · 📢 ${product.bidPercentage}%` : ""}
              </span>
              <button className="btn btn-delist" onClick={handleDelist} disabled={delisting} style={{ whiteSpace: "nowrap" }}>
                {delisting ? "..." : "🗑 Delist"}
              </button>
            </div>
          )}

          {product.status === "failed" && (() => {
            const reason = product.failReason ?? "";
            const isImproper  = /improper|policy|violation|not be permitted/i.test(reason);
            const isCategory  = /category|leaf|not a valid/i.test(reason);
            const isMissing   = /missing|item specific/i.test(reason) && !isImproper;
            const isLimit     = /límite mensual|monthly limit/i.test(reason);
            const isVariation = (product as QueueProduct & { tooManyVariations?: boolean }).tooManyVariations;

            const diagColor  = isImproper ? "#f97316" : isCategory ? "#a78bfa" : isMissing ? "#f59e0b" : isLimit ? "#60a5fa" : "#ef4444";
            const diagLabel  = isImproper ? "🚫 Palabras / Permisos" : isCategory ? "📂 Categoría" : isMissing ? "📋 Aspect faltante" : isLimit ? "📊 Límite mensual" : "⚠️ Error eBay";
            const diagTip    = isImproper
              ? "Cambia la categoría a una menos restrictiva (ej. Home & Garden) o edita el título."
              : isCategory
              ? "La categoría actual no es válida. Selecciona una categoría diferente."
              : isMissing
              ? "Falta un item specific requerido. Reintenta — se agrega automáticamente."
              : isLimit
              ? "Alcanzaste el límite mensual de listings. Disponible el próximo mes."
              : "Revisa el título y descripción, luego reintenta.";

            return (
            <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>

              {/* ── Error diagnosis banner ── */}
              <div style={{ background: "#0a0a14", border: `1px solid ${diagColor}33`, borderRadius: "8px 8px 0 0", padding: "0.6rem 0.75rem", borderBottom: "none" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                  <span style={{ fontSize: "0.7rem", fontWeight: 700, color: diagColor, textTransform: "uppercase", letterSpacing: "0.05em" }}>{diagLabel}</span>
                  <button onClick={() => setShowRejectConfirm(true)} style={{ background: "none", border: "none", color: "#4a5568", cursor: "pointer", fontSize: "0.7rem", padding: "0 2px" }} title="Rechazar producto">✕ Reject</button>
                </div>
                <p style={{ fontSize: "0.73rem", color: "#94a3b8", margin: 0, lineHeight: 1.4 }}>{reason.slice(0, 120)}{reason.length > 120 ? "…" : ""}</p>
                <p style={{ fontSize: "0.7rem", color: diagColor, margin: "0.3rem 0 0", opacity: 0.85 }}>💡 {diagTip}</p>
              </div>

              {/* ── Edit form — always open for failed ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem", padding: "0.75rem", background: "#080810", borderRadius: "0 0 8px 8px", border: `1px solid ${diagColor}22`, borderTop: `1px solid #1e2235` }}>

                {/* Title */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.3rem" }}>
                    <label className="field-label">Título</label>
                    <span style={{ fontSize: "0.65rem", color: editTitle.length > 75 ? "#ef4444" : "#475569" }}>{editTitle.length}/80</span>
                  </div>
                  <input
                    className="stock-input" style={{ width: "100%", fontSize: "0.8rem", boxSizing: "border-box", borderColor: isImproper ? "#f9741344" : "#2d3748" }}
                    value={editTitle} onChange={e => setEditTitle(e.target.value.slice(0, 80))}
                    placeholder="Listing title..."
                  />
                </div>

                {/* Category — highlighted when category error */}
                <div>
                  <label className="field-label" style={{ color: isCategory || isImproper ? "#a78bfa" : undefined }}>
                    {isCategory || isImproper ? "📂 Categoría (cambia esto)" : "Categoría"}
                    {isCategory || isImproper ? <span style={{ color: "#64748b", fontSize: "0.65rem", fontWeight: 400 }}> · actual: {editCategoryId || product.categoryId}</span> : null}
                  </label>
                  <select className="stock-input" style={{ width: "100%", fontSize: "0.78rem", boxSizing: "border-box", borderColor: (isCategory || isImproper) ? "#a78bfa66" : "#2d3748" }} value={editCategoryId} onChange={e => setEditCategoryId(e.target.value)}>
                    <option value="">-- Seleccionar categoría --</option>
                    <optgroup label="🏠 Home &amp; Garden ★ (sin restricciones)">
                      <option value="20625">Kitchen, Dining &amp; Bar Storage</option>
                      <option value="20686">Mugs &amp; Cups</option>
                      <option value="20579">Water Bottles &amp; Hydration</option>
                      <option value="20697">Lamps</option>
                      <option value="20455">Throw Pillows</option>
                      <option value="20460">Blankets &amp; Throws</option>
                      <option value="20461">Bath Towels</option>
                      <option value="20580">Area Rugs &amp; Mats</option>
                      <option value="3815">Decorative Clocks</option>
                      <option value="92074">Picture Frames</option>
                      <option value="116656">Vases</option>
                      <option value="37592">Household Cleaning Supplies</option>
                      <option value="11700">Home &amp; Garden (general)</option>
                    </optgroup>
                    <optgroup label="🐾 Pet Supplies ★ (sin restricciones)">
                      <option value="116381">Dog Collars &amp; Tags</option>
                      <option value="66863">Dog Leashes</option>
                      <option value="66864">Dog Harnesses</option>
                      <option value="117426">Dog Beds</option>
                      <option value="66783">Dog Toys</option>
                      <option value="20748">Cat Collars &amp; Tags</option>
                      <option value="20750">Cat Supplies</option>
                      <option value="1281">Pet Supplies (general)</option>
                    </optgroup>
                    <optgroup label="👟 Footwear — Men's">
                      <option value="45333">Men's Loafers &amp; Slip-Ons</option>
                      <option value="63867">Men's Slippers</option>
                      <option value="15709">Men's Sneakers</option>
                      <option value="11498">Men's Boots</option>
                      <option value="57929">Men's Dress Shoes</option>
                      <option value="11499">Men's Sandals &amp; Flip Flops</option>
                    </optgroup>
                    <optgroup label="👠 Footwear — Women's">
                      <option value="55793">Women's Boots</option>
                      <option value="55791">Women's Heels</option>
                      <option value="55789">Women's Flats</option>
                      <option value="57988">Women's Sneakers</option>
                      <option value="11504">Women's Sandals</option>
                      <option value="63870">Women's Slippers</option>
                      <option value="179297">Women's Loafers &amp; Slip-Ons</option>
                      <option value="179299">Women's Mules &amp; Clogs</option>
                    </optgroup>
                    <optgroup label="👔 Clothing — Men's">
                      <option value="53159">Men's T-Shirts</option>
                      <option value="15689">Men's Jeans</option>
                      <option value="57990">Men's Jackets &amp; Coats</option>
                      <option value="57991">Men's Sweaters</option>
                      <option value="57992">Men's Shirts</option>
                      <option value="15690">Men's Shorts</option>
                    </optgroup>
                    <optgroup label="👗 Clothing — Women's">
                      <option value="63861">Women's Dresses</option>
                      <option value="63862">Women's Tops &amp; Blouses</option>
                      <option value="63863">Women's Pants</option>
                      <option value="63864">Women's Jackets &amp; Coats</option>
                      <option value="63865">Women's Shorts</option>
                      <option value="63866">Women's Sweaters</option>
                    </optgroup>
                    <optgroup label="💪 Fitness">
                      <option value="158902">Fitness Equipment</option>
                      <option value="111844">Yoga &amp; Pilates</option>
                    </optgroup>
                    <optgroup label="🚗 Auto">
                      <option value="179690">Car Care</option>
                      <option value="14927">Car Interior Accessories</option>
                    </optgroup>
                    <optgroup label="📱 Tech">
                      <option value="175759">Cell Phone Accessories</option>
                      <option value="58058">Laptop &amp; Desktop Accessories</option>
                      <option value="139762">Outlet Adapters &amp; Converters</option>
                    </optgroup>
                    <optgroup label="✈️ Travel">
                      <option value="169291">Travel Accessories</option>
                      <option value="45229">Luggage</option>
                    </optgroup>
                    <optgroup label="🌿 Health &amp; Beauty">
                      <option value="26395">Nail Care Tools</option>
                      <option value="45255">Makeup Brushes &amp; Tools</option>
                      <option value="11854">Health Care</option>
                    </optgroup>
                  </select>
                </div>

                {/* Price + Stock row */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                  <div>
                    <label className="field-label">Precio ($)</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ fontSize: "0.75rem", color: "#64748b" }}>$</span>
                      <input className="stock-input" style={{ flex: 1, fontSize: "0.82rem" }} type="number" step="0.01" min="0" value={price} onChange={e => setPrice(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <label className="field-label">Stock</label>
                    <input className="stock-input" style={{ width: "100%", fontSize: "0.82rem" }} type="number" min="1" value={stock} onChange={e => setStock(e.target.value)} />
                  </div>
                </div>

                {/* Description */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.3rem" }}>
                    <label className="field-label" style={{ color: isImproper ? "#f97316" : undefined, margin: 0 }}>
                      {isImproper ? "Descripción (revisa por palabras problemáticas)" : "Descripción"}
                    </label>
                    <button onClick={() => generateDescription(editTitle || product.title)} disabled={generatingDesc}
                      style={{ background: "linear-gradient(135deg, #6366f1, #4f46e5)", border: "none", borderRadius: 5, color: "#fff", fontSize: "0.65rem", fontWeight: 600, padding: "2px 8px", cursor: generatingDesc ? "not-allowed" : "pointer", opacity: generatingDesc ? 0.7 : 1 }}>
                      {generatingDesc ? "⏳ Generando..." : "✨ Generar con IA"}
                    </button>
                  </div>
                  <textarea className="desc-input" value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Descripción del producto..." style={{ borderColor: isImproper ? "#f9741333" : undefined }} />
                </div>

                {/* Action buttons */}
                <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.1rem" }}>
                  {isVariation ? (
                    <button onClick={() => setShowForceModal(true)} disabled={publishing}
                      style={{ flex: 1, padding: "0.55rem", background: "linear-gradient(135deg, #7c3aed, #6d28d9)", color: "#fff", border: "none", borderRadius: 7, fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>
                      ⚡ List anyway
                    </button>
                  ) : (
                    <button className="btn btn-save" onClick={handleSave} style={{ flex: "0 0 auto", padding: "0.55rem 0.9rem" }}>💾 Guardar</button>
                  )}
                  <button className="btn btn-publish" onClick={() => { handleSave(); handlePublish(); }} disabled={publishing} style={{ flex: 1, fontSize: "0.8rem" }}>
                    {publishing ? "⏳ Publicando..." : "🚀 Guardar & Publicar"}
                  </button>
                </div>

                {/* Quick retry without editing */}
                {!isImproper && !isCategory && (
                  <button onClick={handlePublish} disabled={publishing}
                    style={{ background: "transparent", border: "1px solid #1e2235", borderRadius: 6, color: "#64748b", fontSize: "0.72rem", padding: "0.3rem", cursor: "pointer" }}>
                    🔄 Reintentar sin editar
                  </button>
                )}
              </div>
            </div>
            );
          })()}
        </div>
      </div>{/* end card-body */}

      <style jsx>{`
        .card { background: #0d0d14; border: 1px solid #1e2235; border-radius: 12px; overflow: hidden; transition: border-color 0.2s, transform 0.2s; }
        .card:hover { border-color: #2d3748; transform: translateY(-2px); }
        .card-approved { border-color: #064e3b44; }
        .card-published { border-color: #1e3a5f44; }
        .card-rejected { opacity: 0.5; }
        .img-wrap { position: relative; aspect-ratio: 1; background: #111120; overflow: hidden; }
        .product-img { width: 100%; height: 100%; object-fit: contain; padding: 1rem; }
        .no-img { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: #4a5568; font-size: 0.8rem; }
        .img-dots { position: absolute; bottom: 0.5rem; left: 50%; transform: translateX(-50%); display: flex; gap: 4px; }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: #4a5568; border: none; cursor: pointer; padding: 0; }
        .dot-active { background: #fff; }
        .img-count { position: absolute; top: 0.5rem; right: 0.5rem; background: #00000088; color: #94a3b8; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; }
        .status-badge { position: absolute; top: 0.5rem; left: 0.5rem; font-size: 0.7rem; font-weight: 600; padding: 3px 8px; border-radius: 99px; }
        .status-pending { background: #92400e44; color: #f59e0b; }
        .status-approved { background: #064e3b44; color: #10b981; }
        .status-published { background: #1e3a5f44; color: #60a5fa; }
        .status-rejected { background: #7f1d1d44; color: #ef4444; }
        .card-body { padding: 1rem; }
        .category { font-size: 0.7rem; color: #4a5568; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 0.4rem; }
        .title { font-size: 0.9rem; font-weight: 600; color: #e2e8f0; margin: 0 0 0.75rem; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .meta-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
        .meta-item { font-size: 0.78rem; color: #64748b; }
        .source-link { font-size: 0.75rem; color: #3b82f6; text-decoration: none; }
        .fail-reason { font-size: 0.75rem; color: #f97316; margin: 0.5rem 0 0; line-height: 1.4; }
        .pricing { background: #111120; border-radius: 8px; padding: 0.75rem; margin-bottom: 0.75rem; }
        .price-row { display: flex; gap: 0.75rem; flex-wrap: wrap; }
        .price-item { display: flex; flex-direction: column; gap: 0.2rem; flex: 1; min-width: 70px; }
        .price-label { font-size: 0.65rem; color: #4a5568; text-transform: uppercase; letter-spacing: 0.04em; }
        .price-value { font-size: 1rem; font-weight: 700; }
        .price-value.ref { color: #64748b; }
        .price-value.cost { color: #f59e0b; }
        .price-value.sell { color: #10b981; }
        .price-input-wrap { display: flex; align-items: center; background: #0d0d14; border: 1px solid #2d3748; border-radius: 6px; }
        .price-prefix { padding: 0 0.4rem; color: #64748b; font-size: 0.85rem; }
        .price-input { background: none; border: none; color: #e2e8f0; font-size: 0.9rem; font-weight: 600; width: 70px; padding: 0.3rem 0; outline: none; }
        .margin-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid #1e2235; }
        .margin-label { font-size: 0.75rem; color: #64748b; }
        .margin-value { font-size: 0.85rem; font-weight: 700; }
        .desc-wrap { margin-bottom: 0.75rem; }
        .field-label { display: block; font-size: 0.7rem; color: #4a5568; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.3rem; }
        .desc-input { width: 100%; background: #111120; border: 1px solid #2d3748; border-radius: 6px; color: #e2e8f0; font-size: 0.82rem; padding: 0.5rem; resize: vertical; outline: none; box-sizing: border-box; }
        .stock-input { background: #111120; border: 1px solid #2d3748; border-radius: 6px; color: #e2e8f0; font-size: 0.85rem; padding: 0.3rem 0.5rem; width: 80px; outline: none; }
        .btn { padding: 0.5rem 0.7rem; border-radius: 7px; font-size: 0.8rem; font-weight: 600; cursor: pointer; border: none; transition: all 0.15s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-icon { padding: 0.5rem 0.65rem; flex-shrink: 0; }
        .btn-edit    { background: #1a1a2e; color: #94a3b8; border: 1px solid #2d3748; }
        .btn-save    { background: #1e3a5f; color: #60a5fa; border: 1px solid #1d4ed855; }
        .btn-reject  { background: #1a0a0a; color: #ef4444; border: 1px solid #7f1d1d44; }
        .btn-approve { background: #064e3b44; color: #10b981; border: 1px solid #064e3b; }
        .btn-publish { background: linear-gradient(135deg, #1d4ed8, #2563eb); color: #fff; }
        .btn-delist  { background: #1a0a0a; color: #ef4444; border: 1px solid #7f1d1d44; }
        .published-info { font-size: 0.73rem; color: #64748b; display: flex; align-items: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      `}</style>

      {/* List Anyway Modal */}
      {showForceModal && (
        <div onClick={() => setShowForceModal(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#0f0f1a", border: "1px solid #4c1d95", borderRadius: 12, width: "100%", maxWidth: 400, overflow: "hidden" }}>
            <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid #1e2235", background: "linear-gradient(135deg, rgba(124,58,237,0.15), rgba(109,40,217,0.08))" }}>
              <div style={{ fontSize: "1.4rem", marginBottom: "0.3rem" }}>⚡</div>
              <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#e2e8f0" }}>List with trimmed variations?</div>
            </div>
            <div style={{ display: "flex", gap: "0.75rem", padding: "0.9rem 1.25rem", borderBottom: "1px solid #1e2235", alignItems: "center" }}>
              {product.images?.[0]
                ? <img src={product.images[0]} alt="" style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                : <div style={{ width: 52, height: 52, background: "#1a1a2e", borderRadius: 6, flexShrink: 0 }} />
              }
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{product.title}</div>
                <div style={{ fontSize: "0.72rem", color: "#64748b", marginTop: 3 }}>${product.suggestedSellingPrice?.toFixed(2)}</div>
              </div>
            </div>
            <div style={{ padding: "1rem 1.25rem", fontSize: "0.82rem", color: "#94a3b8", lineHeight: 1.6 }}>
              <p style={{ margin: 0 }}>This product exceeds your max variations limit. If you list anyway, <strong style={{ color: "#a78bfa" }}>all variants will be published</strong> regardless of the limit.</p>
              <p style={{ margin: "0.6rem 0 0", fontSize: "0.76rem", color: "#64748b" }}>Note: eBay allows up to 250 variations per listing.</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", padding: "0 1.25rem 1.25rem" }}>
              <button onClick={() => setShowForceModal(false)} style={{ padding: "0.6rem", background: "#1a1a2e", border: "1px solid #2d3748", borderRadius: 7, color: "#94a3b8", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => { setShowForceModal(false); handleForcePublish(); }} disabled={publishing} style={{ padding: "0.6rem", background: "linear-gradient(135deg, #7c3aed, #6d28d9)", border: "none", borderRadius: 7, color: "#fff", fontWeight: 700, fontSize: "0.85rem", cursor: "pointer", opacity: publishing ? 0.6 : 1 }}>
                {publishing ? "Publishing..." : "⚡ List anyway"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Confirmation Modal */}
      {showRejectConfirm && (
        <div onClick={() => setShowRejectConfirm(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#0f0f1a", border: "1px solid #2d3748", borderRadius: 12, width: "100%", maxWidth: 380, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: "0.75rem", padding: "1rem", borderBottom: "1px solid #1e2235", alignItems: "center" }}>
              {product.images?.[0]
                ? <img src={product.images[0]} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                : <div style={{ width: 56, height: 56, background: "#1a1a2e", borderRadius: 6, flexShrink: 0 }} />
              }
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{product.title}</div>
                <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: 2 }}>${product.suggestedSellingPrice?.toFixed(2)}</div>
              </div>
            </div>
            <div style={{ padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>🗑</div>
              <div style={{ fontSize: "0.88rem", fontWeight: 600, color: "#e2e8f0", marginBottom: "0.35rem" }}>Reject this product?</div>
              <div style={{ fontSize: "0.78rem", color: "#64748b", lineHeight: 1.5 }}>It will be removed from the queue and won&apos;t appear in future searches.</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", padding: "0 1rem 1rem" }}>
              <button onClick={() => setShowRejectConfirm(false)} style={{ padding: "0.55rem", background: "#1a1a2e", border: "1px solid #2d3748", borderRadius: 7, color: "#94a3b8", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => { setShowRejectConfirm(false); onReject(); }} style={{ padding: "0.55rem", background: "#1a0a0a", border: "1px solid #7f1d1d44", borderRadius: 7, color: "#ef4444", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer" }}>✕ Reject</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}