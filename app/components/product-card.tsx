"use client";

import { useState } from "react";
import { QueueProduct } from "@/types";

interface Props {
  product: QueueProduct;
  onApprove: () => void;
  onReject: () => void;
  onPublish: () => void;
  onUpdate: (updates: Partial<QueueProduct>) => void;
}

export default function ProductCard({ product, onApprove, onReject, onPublish, onUpdate }: Props) {
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

  const sellingPrice = parseFloat(price) || 0;
  const costPrice = parseFloat(eproloPrice) || 0;
  const margin = costPrice > 0 ? sellingPrice - costPrice : null;
  const marginPct = margin !== null && sellingPrice > 0 ? ((margin / sellingPrice) * 100).toFixed(1) : null;
  const marginColor = marginPct === null ? "#64748b" : parseFloat(marginPct) >= 30 ? "#10b981" : parseFloat(marginPct) >= 15 ? "#f59e0b" : "#ef4444";

  const handleSave = () => {
    if (editTitle && editTitle !== product.title) onUpdate({ title: editTitle });
    if (editCategoryId && editCategoryId !== product.categoryId) onUpdate({ categoryId: editCategoryId });
    onUpdate({ suggestedSellingPrice: sellingPrice, eproloPrice: costPrice || null, description, stock: parseInt(stock) || 10, margin, marginPercent: marginPct ? parseFloat(marginPct) : null });
    setEditing(false);
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
    } finally {
      setDelisting(false);
    }
  };

  const handlePublish = async () => {
    setPublishing(true);
    // If retrying a failed product, reset to approved first
    if (product.status === "failed") {
      await onUpdate({ status: "approved", failReason: undefined });
    }
    await onPublish();
    setPublishing(false);
  };

  const images = product.images?.length ? product.images : [];

  return (
    <div className={`card card-${product.status}`}>
      <div className="img-wrap">
        {images.length > 0 ? (
          <img src={images[currentImg]} alt={product.title} className="product-img"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
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
        <div className="img-count">{images.length} fotos</div>
        <div className={`status-badge status-${product.status}`}>
          {product.status === "pending" ? "⏳ Pendiente" : product.status === "approved" ? "✅ Aprobado" : product.status === "published" ? "🚀 Publicado" : "❌ Rechazado"}
        </div>
      </div>

      <div className="card-body">
        <p className="category">{product.categoryName || "Sin categoría"}</p>
        <h3 className="title">{product.title}</h3>

        <div className="meta-row">
          {(product.soldCount ?? 0) > 0 && <span className="meta-item">📦 {product.soldCount.toLocaleString()} vendidos</span>}
          {product.status === "published" && product.listingId
            ? <a href={`https://www.ebay.com/itm/${product.listingId}`} target="_blank" rel="noreferrer" className="source-link">🛒 Ver mi listing ↗</a>
            : <a href={product.sourceUrl} target="_blank" rel="noreferrer" className="source-link">Ver referencia ↗</a>
          }
        </div>

        <div className="pricing">
          <div className="price-row">
            <div className="price-item">
              <span className="price-label">Ref. eBay</span>
              <span className="price-value ref">${product.ebayReferencePrice?.toFixed(2)}</span>
            </div>
            {editing ? (
              <>
                <div className="price-item">
                  <span className="price-label">Costo eProlo</span>
                  <div className="price-input-wrap"><span className="price-prefix">$</span>
                    <input className="price-input" value={eproloPrice} onChange={(e) => setEproloPrice(e.target.value)} placeholder="0.00" />
                  </div>
                </div>
                <div className="price-item">
                  <span className="price-label">Tu precio</span>
                  <div className="price-input-wrap"><span className="price-prefix">$</span>
                    <input className="price-input" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
                  </div>
                </div>
              </>
            ) : (
              <>
                {product.eproloPrice && (
                  <div className="price-item">
                    <span className="price-label">eProlo</span>
                    <span className="price-value cost">${product.eproloPrice.toFixed(2)}</span>
                  </div>
                )}
                <div className="price-item">
                  <span className="price-label">Tu precio</span>
                  <span className="price-value sell">${sellingPrice.toFixed(2)}</span>
                </div>
              </>
            )}
          </div>
          {marginPct !== null && (
            <div className="margin-bar">
              <span className="margin-label">Margen</span>
              <span className="margin-value" style={{ color: marginColor }}>${margin?.toFixed(2)} · {marginPct}%</span>
            </div>
          )}
        </div>

        {editing && (
          <div className="desc-wrap">
            <label className="field-label">Descripción</label>
            <textarea className="desc-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short product description..." rows={3} />
            <div style={{ marginTop: "0.5rem" }}>
              <label className="field-label">Stock</label>
              <input className="stock-input" type="number" value={stock} onChange={(e) => setStock(e.target.value)} min="1" />
            </div>
          </div>
        )}

        <div>
          {product.status === "pending" && (
            <div className={`actions-pending ${editing ? "actions-pending" : ""}`} style={{ display: "grid", gap: "0.4rem", gridTemplateColumns: editing ? "auto auto 1fr 1fr" : "1fr 1fr" }}>
              <button className="btn btn-edit" onClick={() => setEditing(!editing)} style={{ gridColumn: editing ? "1" : "1" }}>{editing ? "✕" : "✏ Edit"}</button>
              {editing && <button className="btn btn-save" onClick={handleSave}>💾</button>}
              <button className="btn btn-reject" onClick={onReject}>✕ Rechazar</button>
              <button className="btn btn-approve" onClick={() => { handleSave(); onApprove(); }}>✓ Aprobar</button>
            </div>
          )}
          {product.status === "approved" && (
            <div style={{ display: "grid", gap: "0.4rem", gridTemplateColumns: editing ? "auto auto auto 1fr" : "auto auto 1fr" }}>
              <button className="btn btn-icon btn-edit" onClick={() => setEditing(!editing)} title={editing ? "Cancel editing" : "Edit"}>
                {editing ? "✕" : "✏"}
              </button>
              {editing && <button className="btn btn-icon btn-save" onClick={handleSave} title="Save changes">💾</button>}
              <button className="btn btn-icon btn-reject" onClick={onReject} title="Move to rejected">✕</button>
              <button className="btn btn-publish" onClick={handlePublish} disabled={publishing}>
                {publishing ? "Publishing..." : "🚀 Publish to eBay"}
              </button>
            </div>
          )}
          {product.status === "published" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.4rem", alignItems: "center" }}>
              <span className="published-info" title={`ID: ${product.listingId}`}>
                ✅ ID {product.listingId}{product.bidPercentage ? ` · 📢 ${product.bidPercentage}%` : ""}
              </span>
              <button className="btn btn-delist" onClick={handleDelist} disabled={delisting} title="Delist from eBay" style={{ whiteSpace: "nowrap" }}>
                {delisting ? "..." : "🗑 Delist"}
              </button>
            </div>
          )}
          {product.status === "failed" && (
            <div style={{ display:"flex", flexDirection:"column", gap:"0.5rem" }}>
              <p className="fail-reason">⚠️ {product.failReason ?? "Error desconocido"}</p>
              <button className="btn btn-edit" onClick={() => setEditing(!editing)} style={{ width: "100%" }}>
                {editing ? "✕ Close editor" : "✏ Edit & retry"}
              </button>
              {editing && (
                <div style={{ display:"flex", flexDirection:"column", gap:"0.5rem", padding:"0.75rem", background:"#080810", borderRadius:"8px", border:"1px solid #1e2235" }}>
                  <label className="field-label">Título (max 80 chars)</label>
                  <input
                    className="stock-input"
                    style={{ width:"100%", fontSize:"0.8rem" }}
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value.slice(0, 80))}
                    placeholder="Listing title..."
                  />
                  <div style={{ fontSize:"0.7rem", color: editTitle.length > 75 ? "#ef4444" : "#475569", textAlign:"right" }}>
                    {editTitle.length}/80
                  </div>
                  <label className="field-label">Categoría</label>
                  <select
                    className="stock-input"
                    style={{ width:"100%", fontSize:"0.78rem" }}
                    value={editCategoryId}
                    onChange={e => setEditCategoryId(e.target.value)}
                  >
                    <option value="">-- Seleccionar categoría --</option>
                    <optgroup label="🏠 Home &amp; Garden">
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
                      <option value="112576">Shoe Organizers &amp; Racks</option>
                      <option value="11700">Home &amp; Garden (general)</option>
                    </optgroup>
                    <optgroup label="🐾 Pet Supplies">
                      <option value="117426">Dog Beds</option>
                      <option value="116381">Dog Collars &amp; Tags</option>
                      <option value="66783">Dog Toys</option>
                      <option value="20748">Cat Supplies</option>
                      <option value="1281">Pet Supplies (general)</option>
                    </optgroup>
                    <optgroup label="🚗 Auto">
                      <option value="179690">Car Care</option>
                      <option value="14927">Car Interior Accessories</option>
                      <option value="116458">Car Phone Holders &amp; Mounts</option>
                    </optgroup>
                    <optgroup label="📱 Tech Accessories">
                      <option value="175759">Cell Phone Accessories</option>
                      <option value="58058">Laptop &amp; Desktop Accessories</option>
                      <option value="139762">Outlet Adapters &amp; Converters</option>
                    </optgroup>
                    <optgroup label="💪 Fitness">
                      <option value="158902">Fitness Equipment</option>
                      <option value="111844">Yoga &amp; Pilates</option>
                    </optgroup>
                    <optgroup label="✈️ Travel">
                      <option value="169291">Travel Accessories</option>
                      <option value="45229">Luggage</option>
                    </optgroup>
                    <optgroup label="👶 Baby">
                      <option value="20394">Baby Feeding Supplies</option>
                      <option value="162231">Baby Safety</option>
                    </optgroup>
                    <optgroup label="🌿 Health &amp; Beauty">
                      <option value="26395">Nail Care Tools</option>
                      <option value="45255">Makeup Brushes &amp; Tools</option>
                      <option value="11854">Health Care</option>
                    </optgroup>
                  </select>
                  <label className="field-label">Descripción</label>
                  <textarea className="desc-input" value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Descripción del producto..." />
                  <label className="field-label">Tu precio ($)</label>
                  <input className="stock-input" type="number" step="0.01" value={price} onChange={e => setPrice(e.target.value)} />
                  <div style={{ display:"flex", gap:"0.5rem", marginTop:"0.25rem" }}>
                    <button className="btn btn-save" onClick={handleSave} style={{ flex:1 }}>💾 Guardar cambios</button>
                    <button className="btn btn-publish" onClick={() => { handleSave(); handlePublish(); }} disabled={publishing} style={{ flex:1 }}>
                      {publishing ? "Publishing..." : "🚀 Publish now"}
                    </button>
                  </div>
                </div>
              )}
              {!editing && (
                <button className="btn btn-publish" onClick={handlePublish} disabled={publishing}>
                  {publishing ? "Reintentando..." : "🔄 Reintentar sin editar"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

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
        .actions { display: grid; gap: 0.4rem; }
        .actions-pending  { grid-template-columns: auto auto 1fr 1fr; }
        .actions-approved { grid-template-columns: auto auto 1fr; }
        .actions-published { grid-template-columns: 1fr auto; }
        .actions-failed   { grid-template-columns: 1fr; }
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
    </div>
  );
}