"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { db } from "@/lib/firebase-client";
import { collection, query, where, orderBy, limit, startAfter, onSnapshot, getDocs, QueryDocumentSnapshot, DocumentData } from "firebase/firestore";
import { QueueProduct, Store } from "@/types";
import { useAuth } from "@/lib/auth-context";
import ProductCard from "@/components/product-card";
import PublishModal  from "@/components/publish-modal";
import StoreModal    from "@/components/store-modal";
import FiltersModal  from "@/components/filters-modal";
import KeywordsModal    from "@/components/keywords-modal";
import PoliciesModal   from "@/components/policies-modal";
import { saveSearchState, loadSearchState, clearSearchState, type SavedSearchState } from "@/lib/search-state";

// ─── Types ────────────────────────────────────────────────────────────────────
type TabType = "pending" | "approved" | "published" | "rejected" | "failed";

interface Toast { id: number; msg: string; type: "ok" | "err" | "info" }

type RLGroup = {
  apiName: string; apiContext: string;
  resources: { name: string; rates: { count: number; limit: number; remaining: number; reset: string; timeWindow: number }[] }[];
};

const QUEUE_TABS: { key: TabType; label: string; color: string }[] = [
  { key: "pending",   label: "Pending",  color: "var(--amber)"  },
  { key: "approved",  label: "Approved",   color: "var(--green)"  },
  { key: "published", label: "Published",  color: "var(--blue)"   },
  { key: "rejected",  label: "Rejected",  color: "var(--red)"    },
  { key: "failed",    label: "Failed",    color: "var(--text2)"  },
];

const CATEGORIES = [
  "🍳 Cocina","🧹 Limpieza","🚿 Baño","🚗 Auto",
  "📱 Tech Accesorios","✈️ Viaje","🐾 Mascotas","🏠 Decoracion","Viral / Trendy",
];

// ─── Main component ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user, logout } = useAuth();

  // ── Stores ──────────────────────────────────────────────────────────────────
  const [stores, setStores]                 = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>("");

  // ── Products ────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabType>("pending");
  const [loading, setLoading] = useState(true);

  // ── Search ──────────────────────────────────────────────────────────────────
  const [searching,         setSearching]        = useState(false);
  const [tokenExpiredStore, setTokenExpiredStore] = useState<string | null>(null);
  const [searchMode, setSearchMode]     = useState<"auto" | "keyword" | "url">("auto");
  const [kwInput, setKwInput]           = useState("");
  const [urlInput, setUrlInput]         = useState("");
  const [storeUrlInput, setStoreUrlInput] = useState("");
  const [paused, setPaused]             = useState(false);
  const pauseRef                        = useRef(false);
  const [savedSearchState, setSavedSearchState] = useState<SavedSearchState | null>(null);
  const currentSearchRef = useRef<{ index: number; keyword: string; total: number; storeId: string } | null>(null);
  const [searchProgress, setSearchProgress] = useState<{
    reviewed: number; passed: number; keyword: string;
    keywords: { done: number; total: number };
  } | null>(null);

  // ── Publish modal ────────────────────────────────────────────────────────────
  const [publishTarget, setPublishTarget] = useState<QueueProduct | null>(null);

  // ── Modals ───────────────────────────────────────────────────────────────────
  const [showStoreModal,    setShowStoreModal]    = useState(false);
  const [showFiltersModal,  setShowFiltersModal]  = useState(false);
  const [showKeywordsModal, setShowKeywordsModal] = useState(false);
  const [showPoliciesModal, setShowPoliciesModal]   = useState(false);
  const [showRateLimits,    setShowRateLimits]    = useState(false);
  const [showSellers,       setShowSellers]       = useState(false);

  // ── Rate limits ──────────────────────────────────────────────────────────────
  const [rateLimits, setRateLimits]           = useState<{ user: RLGroup[]; app: RLGroup[] } | null>(null);
  const [loadingRateLimits, setLoadingRateLimits] = useState(false);

  // ── Sellers ──────────────────────────────────────────────────────────────────
  const [savedSellers, setSavedSellers] = useState<Array<{
    id: string; username: string; storeUrl: string; userUrl: string;
    totalListings: number; sampleTitles: string[]; category: string;
    appearances?: number; uniqueQueries?: number; score?: number;
  }>>([]);
  const [scanningCategory, setScanningCategory] = useState<string | null>(null);
  const [importingStore,  setImportingStore]    = useState(false);
  const [importProgress,  setImportProgress]   = useState<{ checked: number; added: number; seller: string } | null>(null);
  const [listingRange, setListingRange] = useState<{ min: number; max: number }>({ min: 200, max: 10000 });
  const [editingRange, setEditingRange] = useState(false);

  // ── Actions ──────────────────────────────────────────────────────────────────
  const [promoting, setPromoting]       = useState(false);
  const [cleaning, setCleaning]         = useState(false);
  const [publishingAll, setPublishingAll] = useState(false);
  const [publishProgress, setPublishProgress] = useState({ done: 0, total: 0, errors: 0 });
  const [rejectingAll, setRejectingAll] = useState(false);
  const [showRejectAllConfirm, setShowRejectAllConfirm] = useState(false);
  const [cleanResult, setCleanResult]   = useState<{ delisted: number; checked: number } | null>(null);

  // ── Toasts ───────────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const toast = useCallback((msg: string, type: Toast["type"] = "info") => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }, []);

  // ── Load stores (filtered by userId) ─────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    fetch(`/api/ebay/stores?userId=${user.uid}`)
      .then(r => r.json())
      .then(d => {
        if (d.stores?.length) {
          setStores(d.stores);
          setSelectedStoreId(d.stores[0].id);
        }
      });
    // Load any saved search state for this user
    const saved = loadSearchState(user.uid);
    if (saved) setSavedSearchState(saved);
  }, [user]);

  // ── Save state when paused so user can resume later ───────────────────────────
  useEffect(() => {
    if (paused && currentSearchRef.current && user) {
      const { index, keyword, total, storeId } = currentSearchRef.current;
      const state: SavedSearchState = { userId: user.uid, storeId, keywordIndex: index, keyword, total, savedAt: Date.now() };
      saveSearchState(state);
      setSavedSearchState(state);
      toast("💾 Progreso guardado — puedes cerrar y reanudar después", "info");
    }
  }, [paused, user]);

  // ── Save state on page close if searching ─────────────────────────────────────
  useEffect(() => {
    const handleUnload = () => {
      if (currentSearchRef.current && user) {
        const { index, keyword, total, storeId } = currentSearchRef.current;
        saveSearchState({ userId: user.uid, storeId, keywordIndex: index, keyword, total, savedAt: Date.now() });
      }
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [user]);

  // ── Products with pagination ──────────────────────────────────────────────────
  const PAGE_SIZE = 50;
  const [allProducts, setAllProducts]     = useState<QueueProduct[]>([]);
  const [stats, setStats]                 = useState<Record<TabType, number>>({ pending: 0, approved: 0, published: 0, rejected: 0, failed: 0 });
  const [lastDoc, setLastDoc]             = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore]             = useState(false);
  const [loadingMore, setLoadingMore]     = useState(false);

  // Reset pagination when tab/store changes
  useEffect(() => {
    setLastDoc(null);
    setHasMore(false);
    setAllProducts([]);
  }, [user, selectedStoreId, activeTab]);

  // Real-time listener for first page
  useEffect(() => {
    if (!user || !selectedStoreId) return;
    setLoading(true);
    const q = query(
      collection(db, "users", user.uid, "products_queue"),
      where("storeId", "==", selectedStoreId),
      where("status",  "==", activeTab),
      orderBy("createdAt", "desc"),
      limit(PAGE_SIZE)
    );
    const unsub = onSnapshot(q,
      snap => {
        const docs = snap.docs;
        setAllProducts(docs.map(d => ({ id: d.id, ...d.data() })) as QueueProduct[]);
        setLastDoc(docs[docs.length - 1] ?? null);
        setHasMore(docs.length === PAGE_SIZE);
        setLoading(false);
      },
      err => {
        console.error("[products] Firestore error — check browser console for index link:", err.message);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [user, selectedStoreId, activeTab]);

  // Load more (cursor pagination — getDocs, not real-time)
  const handleLoadMore = async () => {
    if (!user || !selectedStoreId || !lastDoc || loadingMore) return;
    setLoadingMore(true);
    try {
      const q = query(
        collection(db, "users", user.uid, "products_queue"),
        where("storeId", "==", selectedStoreId),
        where("status",  "==", activeTab),
        orderBy("createdAt", "desc"),
        startAfter(lastDoc),
        limit(PAGE_SIZE)
      );
      const snap = await getDocs(q);
      const newDocs = snap.docs;
      setAllProducts(prev => [...prev, ...newDocs.map(d => ({ id: d.id, ...d.data() })) as QueueProduct[]]);
      setLastDoc(newDocs[newDocs.length - 1] ?? lastDoc);
      setHasMore(newDocs.length === PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  };

  const products = allProducts;

  // ── Stats listeners — one per status tab (each needs its own index) ─────────────
  // These use the same index: storeId ASC + status ASC + createdAt DESC
  useEffect(() => {
    if (!user || !selectedStoreId) return;
    const tabs: TabType[] = ["pending", "approved", "published", "rejected", "failed"];
    const unsubs = tabs.map(status => {
      const q = query(
        collection(db, "users", user.uid, "products_queue"),
        where("storeId", "==", selectedStoreId),
        where("status",  "==", status)
      );
      return onSnapshot(q,
        snap => setStats(p => ({ ...p, [status]: snap.size })),
        err  => console.error(`[stats:${status}] ${err.message}`)
      );
    });
    return () => unsubs.forEach(u => u());
  }, [user, selectedStoreId]);

  // ── Load sellers ──────────────────────────────────────────────────────────────
  const loadSellers = useCallback(async () => {
    const res  = await fetch("/api/ebay/discover-sellers");
    const data = await res.json();
    if (data.sellers)  setSavedSellers(data.sellers);
    if (data.settings) setListingRange({ min: data.settings.minListings ?? 200, max: data.settings.maxListings ?? 10000 });
  }, []);

  useEffect(() => {
    if (showSellers && savedSellers.length === 0) loadSellers();
  }, [showSellers, savedSellers.length, loadSellers]);

  // ── Poll /api/ebay/search-status for real-time progress ──────────────────────
  // ONLY update reviewed/passed from server — the loop owns keyword + keywords.done/total
  useEffect(() => {
    if (!searching) { setSearchProgress(null); return; }
    const interval = setInterval(async () => {
      try {
        const res  = await fetch("/api/ebay/search-status");
        const data = await res.json();
        if (data.active) {
          setSearchProgress(p => p ? {
            ...p,                              // keep keyword + keywords from the loop
            reviewed: data.reviewed ?? p.reviewed,
            passed:   data.passed   ?? p.passed,
          } : p);
        }
      } catch {}
    }, 1500);
    return () => clearInterval(interval);
  }, [searching]);

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const uid = user?.uid ?? "";

  const requireStore = (): boolean => {
    if (!selectedStoreId) { toast("⚠ Select a store first", "err"); return false; }
    return true;
  };

  const patch = (productId: string, updates: object) =>
    fetch("/api/ebay/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, updates, userId: uid }),
    });

  // ── Publish single (opens modal) ──────────────────────────────────────────────
  const openPublishModal = (product: QueueProduct) => {
    if (!requireStore()) return;
    setPublishTarget(product);
  };

  const handlePublishConfirm = async (productId: string, storeIds: string[]) => {
    const errors: string[] = [];
    for (const storeId of storeIds) {
      const res  = await fetch("/api/ebay/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, storeId, userId: uid }),
      });
      const data = await res.json();
      if (data.error) errors.push(`${stores.find(s => s.id === storeId)?.name ?? storeId}: ${data.error}`);
    }
    if (errors.length) {
      toast("❌ " + errors.join(" | "), "err");
      throw new Error(errors.join(", "));
    }
    toast(`✅ Publicado en ${storeIds.length} tienda${storeIds.length > 1 ? "s" : ""}`, "ok");
  };

  // ── Publish all (uses selectedStoreId) ────────────────────────────────────────
  const handlePublishAll = async () => {
    if (!requireStore()) return;
    const connectedStore = stores.find(s => s.id === selectedStoreId);
    if (!connectedStore?.connected) { toast("⚠ La tienda seleccionada no está conectada", "err"); return; }

    // Derive from already-loaded allProducts — no Firestore query needed
    const ids = allProducts
      .filter(p => p.status === "approved")
      .map(p => p.id);
    if (!ids.length) { toast("No hay aprobados", "info"); return; }
    setPublishingAll(true);
    setPublishProgress({ done: 0, total: ids.length, errors: 0 });

    for (const id of ids) {
      const res  = await fetch("/api/ebay/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: id, storeId: selectedStoreId, userId: uid }),
      });
      const data = await res.json();
      setPublishProgress(p => ({ done: p.done + 1, total: p.total, errors: p.errors + (data.error ? 1 : 0) }));
      await new Promise(r => setTimeout(r, 300));
    }
    setPublishingAll(false);
    toast(`✅ ${ids.length} publicados`, "ok");
  };

  const handleManualList = async (productId: string) => {
    if (!requireStore()) return;
    const res = await fetch("/api/ebay/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, storeId: selectedStoreId, userId: uid }),
    });
    const data = await res.json();
    if (data.error) { toast("❌ " + data.error, "err"); return; }
    if (data.mode === "ebay_draft") {
      toast("✅ Borrador creado en eBay Seller Hub — ve a Listings → Drafts", "ok");
      window.open(data.sellerHubUrl, "_blank");
    } else {
      toast("📋 Datos preparados — abriendo eBay para pre-llenar", "ok");
      window.open(data.sellUrl, "_blank");
    }
  };

  const handleRejectAll = async () => {
    const targetStatus = activeTab as string;
    setShowRejectAllConfirm(false);
    setRejectingAll(true);
    try {
      // Server-side bulk reject — queries ALL docs of this status in Firestore,
      // not limited by what's currently loaded in the frontend.
      const res = await fetch("/api/ebay/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject_all", status: targetStatus, userId: uid }),
      });
      const data = await res.json();
      if (data.error) {
        toast(`❌ Error: ${data.error}`, "err");
      } else {
        toast(`🗑 ${data.rejected} productos rechazados`, "ok");
        // Reload products to reflect the change
        setAllProducts(p => p.filter(x => x.status !== targetStatus));
      }
    } catch (e) {
      toast("❌ Error rechazando productos", "err");
    } finally {
      setRejectingAll(false);
    }
  };

  // ── Search ────────────────────────────────────────────────────────────────────
  const handleSearch = async (isAuto = false, startIndex = 0) => {
    if (!requireStore()) return;
    setSearching(true);
    // Clear saved state when starting fresh
    if (startIndex === 0 && user) {
      clearSearchState(user.uid);
      setSavedSearchState(null);
    }
    try {
      if (isAuto) {
        const kwRes = await fetch(`/api/ebay/search?userId=${uid}`);
        const { keywords: allKws } = await kwRes.json() as { keywords: string[] };
        const reversed = [...allKws].reverse();
        setSearchProgress({ reviewed: 0, passed: 0, keyword: reversed[startIndex] ?? "", keywords: { done: startIndex, total: reversed.length } });

        for (let i = startIndex; i < reversed.length; i++) {
          const kw = reversed[i];
          // Track current position in ref (used by save-on-pause/close)
          currentSearchRef.current = { index: i, keyword: kw, total: reversed.length, storeId: selectedStoreId };
          // Auto-save every 10 keywords
          if (i % 10 === 0 && i > startIndex && user) {
            saveSearchState({ userId: user.uid, storeId: selectedStoreId, keywordIndex: i, keyword: kw, total: reversed.length, savedAt: Date.now() });
          }

          while (pauseRef.current) await new Promise(r => setTimeout(r, 500));

          // Polling handles reviewed/passed in real-time — just track loop position
          setSearchProgress(p => p ? { ...p, keyword: kw, keywords: { done: i, total: reversed.length } } : p);
          try {
            const sr = await fetch("/api/ebay/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ keywords: kw, storeId: selectedStoreId, userId: uid }),
            });
            if (sr.status === 401) {
              const errData = await sr.json();
              if (errData.error === "TOKEN_EXPIRED") {
                setTokenExpiredStore(selectedStoreId);
                setPaused(true);
                pauseRef.current = true;
                toast("⚠️ eBay token expired — reconnect your store", "err");
                break; // stop keyword loop
              }
            }
          } catch { /* continue on error, next keyword */ }
        }
        // Completed — clear saved state
        if (user) { clearSearchState(user.uid); setSavedSearchState(null); }
        currentSearchRef.current = null;
      } else if (searchMode === "keyword") {
        if (!kwInput.trim()) { toast("Type a keyword first", "err"); return; }
        // Show progress for single keyword search
        setSearchProgress({ reviewed: 0, passed: 0, keyword: kwInput.trim(), keywords: { done: 0, total: 1 } });
        const sr = await fetch("/api/ebay/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords: kwInput.trim(), storeId: selectedStoreId, userId: uid }),
        });
        if (sr.status === 401) {
          const errData = await sr.json();
          if (errData.error === "TOKEN_EXPIRED") {
            setTokenExpiredStore(selectedStoreId);
            toast("⚠️ eBay token expired — reconnect your store", "err");
          }
        } else {
          toast("✅ Search complete", "ok");
        }
      } else {
        await handleImport();
        return;
      }
    } finally {
      setSearching(false);
      setPaused(false);
      pauseRef.current = false;
      setSearchProgress(null);
      // Only clear ref if not paused mid-search (paused = user might resume)
      if (!pauseRef.current) currentSearchRef.current = null;
    }
  };

  const handleForcePublish = async (product: QueueProduct) => {
    if (!requireStore()) return;
    for (const storeId of [selectedStoreId]) {
      const res  = await fetch("/api/ebay/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.id, storeId, userId: uid, forceVariations: true }),
      });
      const data = await res.json();
      if (data.error) toast("❌ " + data.error, "err");
      else toast(`✅ Listed with trimmed variants`, "ok");
    }
  };

    const handleImport = async () => {
    if (!requireStore()) return;
    const urls = urlInput.split("\n").map(u => u.trim()).filter(Boolean);
    if (!urls.length) { toast("Pega al menos una URL", "err"); return; }
    setSearching(true);
    try {
      const res  = await fetch("/api/ebay/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls, storeId: selectedStoreId, userId: uid }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast(`✅ ${data.added} importados · ${data.skipped} duplicados · ${data.filtered} filtrados`, "ok");
      if (data.errors > 0) toast(`❌ ${data.errors} errors`, "err");
      setActiveTab("approved");
    } catch (e: unknown) {
      toast("❌ " + (e instanceof Error ? e.message : String(e)), "err");
    } finally {
      setSearching(false);
    }
  };

  const handleImportStore = async () => {
    if (!requireStore()) return;
    if (!storeUrlInput.trim()) { toast("Paste a store URL first", "err"); return; }
    setImportingStore(true);
    setImportProgress(null);
    try {
      const res  = await fetch("/api/ebay/import-store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeUrl: storeUrlInput.trim(), storeId: selectedStoreId, userId: uid }),
      });
      const data = await res.json();
      if (data.error) { toast("❌ " + data.error, "err"); return; }
      setImportProgress({ checked: data.checked, added: data.added, seller: data.seller });
      toast(`✅ ${data.seller}: ${data.added} products added from ${data.checked} scanned`, "ok");
      setActiveTab("approved");
    } finally {
      setImportingStore(false);
    }
  };

  // ── Promote / clean ────────────────────────────────────────────────────────────
  const handlePromoteAll = async () => {
    if (!requireStore()) return;
    setPromoting(true);
    try {
      const res  = await fetch("/api/ebay/promote", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: selectedStoreId, userId: uid }),
      });
      const data = await res.json();
      toast(data.error ? "❌ " + data.error : `✅ Ads aplicados a ${data.updated ?? 0} listings`, data.error ? "err" : "ok");
    } finally { setPromoting(false); }
  };

  const handleClean = async () => {
    if (!requireStore()) return;
    setCleaning(true);
    try {
      const res  = await fetch("/api/ebay/clean-published", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: selectedStoreId, userId: uid }),
      });
      const data = await res.json();
      setCleanResult(data);
      toast(data.delisted > 0 ? `🗑 ${data.delisted} deslistados de ${data.checked}` : `✅ ${data.checked} reviewed — todo limpio`, "info");
    } finally { setCleaning(false); }
  };

  // ── Rate limits ───────────────────────────────────────────────────────────────
  const handleRateLimits = async () => {
    if (!requireStore()) return;
    setLoadingRateLimits(true);
    setShowRateLimits(true);
    try {
      const res  = await fetch(`/api/ebay/rate-limits?storeId=${selectedStoreId}`);
      const data = await res.json();
      if (data.error) { toast("❌ " + data.error, "err"); setShowRateLimits(false); return; }
      setRateLimits({ user: Array.isArray(data.userLimits) ? data.userLimits : [], app: Array.isArray(data.appLimits) ? data.appLimits : [] });
    } finally { setLoadingRateLimits(false); }
  };

  // ── Sellers ───────────────────────────────────────────────────────────────────
  const handleScanCategory = async (cat?: string) => {
    if (!requireStore()) return;
    setScanningCategory(cat ?? "all");
    try {
      const res  = await fetch("/api/ebay/discover-sellers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: cat, storeId: selectedStoreId, userId: uid }),
      });
      const data = await res.json();
      if (data.error) { toast("❌ " + data.error, "err"); return; }
      await loadSellers();
      toast(`✅ ${data.found ?? 0} vendedores encontrados`, "ok");
    } finally { setScanningCategory(null); }
  };

  const handleImportSeller = async (userUrl: string, category: string) => {
    if (!requireStore()) return;
    setImportingStore(true);
    try {
      const res  = await fetch("/api/ebay/import-store", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeUrl: userUrl, category, storeId: selectedStoreId, userId: uid }),
      });
      const data = await res.json();
      if (data.error) { toast("❌ " + data.error, "err"); return; }
      toast(`✅ ${data.added} agregados de ${data.seller}`, "ok");
      setActiveTab("approved");
      setShowSellers(false);
    } finally { setImportingStore(false); }
  };

  const handleDeleteSeller = async (username: string) => {
    await fetch("/api/ebay/discover-sellers", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    setSavedSellers(s => s.filter(x => x.username !== username));
  };

  // ── Sidebar item renderer ──────────────────────────────────────────────────────
  const SidebarItem = ({
    icon, label, badge, active, onClick,
  }: { icon: string; label: string; badge?: number; active?: boolean; onClick: () => void }) => (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: "calc(100% - 0.8rem)", margin: "1px 0.4rem",
        padding: "0.55rem 0.85rem", borderRadius: "var(--radius-sm)",
        border: "none", background: active ? "rgba(255,255,255,0.06)" : "transparent",
        color: active ? "var(--text)" : "var(--text2)",
        fontWeight: active ? 600 : 400, cursor: "pointer",
        fontSize: "0.83rem", textAlign: "left",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
        <span style={{ fontSize: "0.9rem" }}>{icon}</span>
        <span>{label}</span>
      </span>
      {badge !== undefined && (
        <span style={{
          fontSize: "0.68rem", fontWeight: 700, minWidth: 18, textAlign: "center",
          padding: "1px 5px", borderRadius: 99,
          background: active ? "var(--blue)" : "var(--border2)",
          color: active ? "#fff" : "var(--text3)",
        }}>
          {badge}
        </span>
      )}
    </button>
  );

  const SidebarLabel = ({ text }: { text: string }) => (
    <div style={{ padding: "0.6rem 0.85rem 0.2rem 1.25rem", fontSize: "0.65rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.09em" }}>
      {text}
    </div>
  );

  const SidebarDivider = () => (
    <div style={{ height: 1, background: "var(--border)", margin: "0.4rem 0.75rem" }} />
  );

  // ─── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">

      {/* ── Header ── */}
      <header className="app-header">
        <div style={{ fontWeight: 700, fontSize: "1.05rem", display: "flex", alignItems: "center", gap: "0.35rem", marginRight: "1rem" }}>
          ⚡ <span>DropFlow</span>
        </div>
        {/* Store pills */}
        <div style={{ display: "flex", gap: "0.35rem", flex: 1, flexWrap: "wrap", alignItems: "center" }}>
          {stores.map(s => (
            <button
              key={s.id}
              onClick={() => setSelectedStoreId(s.id)}
              style={{
                display: "flex", alignItems: "center", gap: "0.35rem",
                padding: "0.22rem 0.7rem", borderRadius: 99,
                border: "1px solid", fontSize: "0.78rem", fontWeight: 600, cursor: "pointer",
                borderColor: selectedStoreId === s.id ? "var(--blue)" : "var(--border)",
                background: selectedStoreId === s.id ? "rgba(59,130,246,0.12)" : "transparent",
                color: selectedStoreId === s.id ? "var(--blue)" : "var(--text2)",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.connected ? "var(--green)" : "var(--text3)", flexShrink: 0 }} />
              {s.name}
            </button>
          ))}
          {stores.length === 0 && (
            <span style={{ fontSize: "0.78rem", color: "var(--text3)" }}>Sin tiendas — crea una en Mis Tiendas</span>
          )}
        </div>
        <span style={{ fontSize: "0.75rem", color: "var(--text3)", marginLeft: "0.5rem" }}>{user?.email}</span>
      </header>

      <div className="app-body">

        {/* ── Sidebar ── */}
        <nav className="app-sidebar" style={{ padding: "0.5rem 0", overflowY: "auto" }}>

          <SidebarLabel text="Queue" />
          {QUEUE_TABS.map(tab => (
            <SidebarItem
              key={tab.key}
              icon={tab.key === "pending" ? "🔍" : tab.key === "approved" ? "✅" : tab.key === "published" ? "🚀" : tab.key === "rejected" ? "❌" : "⚠️"}
              label={tab.label}
              badge={stats[tab.key]}
              active={activeTab === tab.key && !showSellers}
              onClick={() => { setActiveTab(tab.key); setShowSellers(false); }}
            />
          ))}

          <SidebarDivider />
          <SidebarLabel text="Herramientas" />
          <SidebarItem icon="🏪" label="Vendedores CN" active={showSellers} onClick={() => setShowSellers(s => !s)} />
          <SidebarItem icon="📊" label="Rate Limits" onClick={handleRateLimits} />

          <SidebarDivider />
          <SidebarLabel text="Configuración" />
          <SidebarItem icon="🏬" label="My Stores" onClick={() => setShowStoreModal(true)} />
          <SidebarItem icon="⚙" label="Filters" onClick={() => setShowFiltersModal(true)} />
          <SidebarItem icon="🔑" label="Keywords" onClick={() => setShowKeywordsModal(true)} />
          <SidebarItem icon="📋" label="eBay Policies" onClick={() => setShowPoliciesModal(true)} />

          <div style={{ flex: 1 }} />
          <SidebarDivider />
          <SidebarItem icon="→" label="Sign Out" onClick={async () => {
            document.cookie = "dropflow_session=; path=/; max-age=0";
            await logout();
          }} />
        </nav>

        {/* ── Main content ── */}
        <main style={{ flex: 1, overflowY: "auto", padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>

          {/* ── Resume search banner ── */}
          {savedSearchState && !searching && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 1rem", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.3)", borderRadius: "var(--radius)", fontSize: "0.82rem" }}>
              <span style={{ fontSize: "1rem" }}>💾</span>
              <div style={{ flex: 1 }}>
                <span style={{ color: "var(--text)", fontWeight: 600 }}>Tienes una búsqueda guardada</span>
                <span style={{ color: "var(--text2)", marginLeft: 8 }}>
                  Keyword <strong style={{ color: "var(--blue)" }}>"{savedSearchState.keyword}"</strong>
                  {" "}({savedSearchState.keywordIndex}/{savedSearchState.total}) · guardada {new Date(savedSearchState.savedAt).toLocaleTimeString()}
                </span>
              </div>
              <button
                onClick={() => { handleSearch(true, savedSearchState.keywordIndex); }}
                style={{ padding: "0.38rem 0.9rem", background: "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer", whiteSpace: "nowrap" }}
              >
                ▶ Resume
              </button>
              <button
                onClick={() => { if (user) clearSearchState(user.uid); setSavedSearchState(null); }}
                style={{ padding: "0.38rem 0.7rem", background: "transparent", color: "var(--text3)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "0.8rem", cursor: "pointer" }}
              >
                Descartar
              </button>
            </div>
          )}

          {/* ── Search panel ── */}
          <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1rem 1.1rem" }}>
            {/* Mode tabs */}
            <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.85rem" }}>
              {(["auto", "keyword", "url"] as const).map(m => (
                <button key={m} onClick={() => setSearchMode(m)}
                  style={{
                    padding: "0.28rem 0.85rem", borderRadius: 99,
                    border: "1px solid", fontSize: "0.78rem", cursor: "pointer", fontWeight: 600,
                    borderColor: searchMode === m ? "var(--blue)" : "var(--border)",
                    background: searchMode === m ? "rgba(59,130,246,0.12)" : "transparent",
                    color: searchMode === m ? "var(--blue)" : "var(--text2)",
                  }}>
                  {m === "auto" ? "🤖 Auto" : m === "keyword" ? "🔍 Keyword" : "🔗 URL / Store"}
                </button>
              ))}
            </div>

            {searchMode === "auto" && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <p style={{ flex: 1, fontSize: "0.8rem", color: "var(--text2)" }}>
                  Automatically cycles through all keywords searching for CN products with validated sales.
                </p>
                {stores.length > 0 && !stores.some(s => s.id === selectedStoreId && s.connected) && (
                  <span style={{ fontSize: "0.75rem", color: "var(--amber)", display: "flex", alignItems: "center", gap: "0.35rem" }}>
                    ⚠ Connect the store first to get sales data
                  </span>
                )}
                <button onClick={() => handleSearch(true)} disabled={searching}
                  style={{ flexShrink: 0, padding: "0.5rem 1.1rem", background: searching ? "var(--blue-dim)" : "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.83rem", cursor: searching ? "not-allowed" : "pointer" }}>
                  {searching ? "⏳ Searching..." : "▶ Start search"}
                </button>
              </div>
            )}

            {searchMode === "keyword" && (
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  value={kwInput} onChange={e => setKwInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && !searching && handleSearch(false)}
                  placeholder="e.g. portable fan, magnetic wallet..."
                  style={{ flex: 1, padding: "0.5rem 0.8rem", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: "0.85rem", outline: "none" }}
                />
                <button onClick={() => handleSearch(false)} disabled={searching}
                  style={{ padding: "0.5rem 1.1rem", background: "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.83rem", cursor: "pointer" }}>
                  Buscar
                </button>
              </div>
            )}

            {searchMode === "url" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                <textarea
                  value={urlInput} onChange={e => setUrlInput(e.target.value)}
                  placeholder={"eBay URLs — one per line\nhttps://www.ebay.com/itm/..."}
                  rows={3}
                  style={{ padding: "0.5rem 0.8rem", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: "0.83rem", resize: "vertical", outline: "none" }}
                />
                <button onClick={handleImport} disabled={searching || !urlInput.trim()}
                  style={{ padding: "0.5rem 1.1rem", background: "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.83rem", cursor: "pointer", alignSelf: "flex-end" }}>
                  {searching ? "⏳ Importing..." : "📥 Import URLs"}
                </button>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    value={storeUrlInput} onChange={e => setStoreUrlInput(e.target.value)}
                    placeholder="eBay store URL — ebay.com/str/... o username directo"
                    style={{ flex: 1, padding: "0.5rem 0.8rem", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: "0.83rem", outline: "none" }}
                  />
                  <button onClick={handleImportStore} disabled={importingStore || !storeUrlInput.trim()}
                    style={{ flexShrink: 0, padding: "0.5rem 1rem", background: "var(--cyan)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>
                    {importingStore ? "⏳ Scanning..." : "🏪 Import store"}
                  </button>
                </div>
                <div style={{ fontSize: "0.71rem", color: "var(--text3)", marginTop: "0.15rem" }}>
                  Filtros: precio ≥ $15 · mínimo 3 ventas · sin IP violations · hasta 5,000 listings escaneados → pending para revisión manual
                </div>
                {/* Import progress */}
                {importingStore && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.5rem 0.75rem", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "0.78rem", color: "var(--text2)" }}>
                    <div style={{ width: 12, height: 12, border: "2px solid var(--cyan)", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                    Escaneando listings — precio ≥ $15, mínimo 3 ventas. Puede tardar unos minutos...
                  </div>
                )}
                {importProgress && !importingStore && (
                  <div style={{ padding: "0.5rem 0.75rem", background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: "var(--radius-sm)", fontSize: "0.78rem" }}>
                    <strong style={{ color: "var(--green)" }}>✅ {importProgress.seller}</strong>
                    <span style={{ color: "var(--text2)", marginLeft: "0.5rem" }}>
                      {importProgress.added} products added · {importProgress.checked} listings scanned
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Search progress ── */}
          {searching && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.7rem 1rem", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: "0.8rem", color: "var(--text2)" }}>
              {!paused
                ? <div style={{ width: 14, height: 14, border: "2px solid var(--blue)", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                : <div style={{ width: 14, height: 14, background: "var(--amber)", borderRadius: "50%", flexShrink: 0 }} />
              }
              <div style={{ flex: 1, display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                {searchProgress ? (
                  <>
                    {searchProgress.keywords.total > 1 && <span>📋 <strong style={{ color: "var(--text)" }}>{searchProgress.keywords.done}/{searchProgress.keywords.total}</strong></span>}
                    {searchProgress.keyword && <span>🔍 <strong style={{ color: "var(--text)" }}>"{searchProgress.keyword}"</strong></span>}
                    <span>👁 <strong style={{ color: "var(--text)" }}>{searchProgress.reviewed}</strong></span>
                    <span style={{ color: "var(--green)" }}>✅ <strong>{searchProgress.passed}</strong></span>
                    {(searchProgress as unknown as Record<string,unknown>).skipReasons && (() => {
                      const sr = ((searchProgress as unknown as Record<string, Record<string,number>>).skipReasons);
                      return <>
                        {sr.sales    > 0 && <span style={{ color: "var(--amber)" }}>📉 {sr.sales} low sales</span>}
                        {sr.price    > 0 && <span style={{ color: "var(--text3)" }}>💰 {sr.price} price</span>}
                        {sr.banned   > 0 && <span style={{ color: "var(--red)" }}>🚫 {sr.banned} IP</span>}
                        {sr.country  > 0 && <span style={{ color: "var(--text3)" }}>🌍 {sr.country} not CN</span>}
                        {sr.duplicate > 0 && <span style={{ color: "var(--text3)" }}>♻ {sr.duplicate} dup</span>}
                      </>;
                    })()}
                    {(searchProgress as unknown as Record<string,string>).lastSkipReason && (
                      <span style={{ color: "var(--text3)", fontStyle: "italic", fontSize: "0.72rem" }}>
                        last: {((searchProgress as unknown as Record<string,string>).lastSkipReason).slice(0,30)}
                      </span>
                    )}
                  </>
                ) : <span>Starting...</span>}
              </div>
              <button
                onClick={() => { const next = !paused; setPaused(next); pauseRef.current = next; }}
                style={{ padding: "0.28rem 0.8rem", borderRadius: "var(--radius-sm)", border: "none", fontWeight: 600, cursor: "pointer", fontSize: "0.75rem", background: paused ? "var(--green)" : "var(--amber)", color: "#000" }}
              >
                {paused ? "▶ Resume" : "⏸ Pause"}
              </button>
            </div>
          )}


          {/* ── Token expired banner ── */}
          {tokenExpiredStore && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.8rem 1rem", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "var(--radius)", fontSize: "0.82rem" }}>
              <span style={{ fontSize: "1.1rem" }}>🔑</span>
              <div style={{ flex: 1 }}>
                <strong style={{ color: "var(--red)" }}>eBay token expired</strong>
                <span style={{ color: "var(--text2)", marginLeft: "0.5rem" }}>— Search paused. Reconnect your store to continue.</span>
              </div>
              <button
                onClick={() => { window.open(`/connect?storeId=${tokenExpiredStore}`, "_blank"); }}
                style={{ padding: "0.35rem 0.85rem", background: "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.78rem", cursor: "pointer", whiteSpace: "nowrap" }}
              >
                🔗 Reconnect
              </button>
              <button
                onClick={() => setTokenExpiredStore(null)}
                style={{ padding: "0.35rem 0.6rem", background: "transparent", color: "var(--text3)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "0.78rem", cursor: "pointer" }}
              >✕</button>
            </div>
          )}

          {/* ── Action bar for current tab ── */}
          {!showSellers && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 36 }}>
              <div style={{ fontSize: "0.82rem", color: "var(--text3)", fontWeight: 500 }}>
                {QUEUE_TABS.find(t => t.key === activeTab)?.label} — {stats[activeTab]} products
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                {(activeTab === "pending" || activeTab === "approved" || activeTab === "failed") && stats[activeTab] > 0 && (
                  <button
                    onClick={() => setShowRejectAllConfirm(true)}
                    disabled={rejectingAll}
                    style={{ padding: "0.4rem 0.9rem", background: "transparent", color: "var(--red)", border: "1px solid var(--red)", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer", opacity: rejectingAll ? 0.6 : 1 }}
                  >
                    {rejectingAll ? "Rechazando..." : `🗑 Reject all (${stats[activeTab]})`}
                  </button>
                )}
                {activeTab === "approved" && stats.approved > 0 && (
                  <>
                    {publishingAll && (
                      <span style={{ fontSize: "0.78rem", color: "var(--text2)", alignSelf: "center" }}>
                        {publishProgress.done}/{publishProgress.total}
                        {publishProgress.errors > 0 ? ` · ${publishProgress.errors} errors` : ""}
                      </span>
                    )}
                    <button onClick={handlePublishAll} disabled={publishingAll}
                      style={{ padding: "0.4rem 1rem", background: "var(--green)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer", opacity: publishingAll ? 0.6 : 1 }}>
                      {publishingAll ? "Publishing..." : `🚀 Publish all (${stats.approved})`}
                    </button>
                  </>
                )}
                {activeTab === "published" && stats.published > 0 && (
                  <>
                    {cleanResult && (
                      <span style={{ fontSize: "0.75rem", color: cleanResult.delisted > 0 ? "var(--red)" : "var(--green)", alignSelf: "center" }}>
                        {cleanResult.delisted > 0 ? `🗑 ${cleanResult.delisted} deslistados` : `✅ Todo limpio`}
                      </span>
                    )}
                    <button onClick={handleClean} disabled={cleaning}
                      style={{ padding: "0.4rem 0.9rem", background: "var(--red)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer", opacity: cleaning ? 0.6 : 1 }}>
                      {cleaning ? "Revisando..." : "🧹 Limpiar"}
                    </button>
                    <button onClick={handlePromoteAll} disabled={promoting}
                      style={{ padding: "0.4rem 0.9rem", background: "var(--purple)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer", opacity: promoting ? 0.6 : 1 }}>
                      {promoting ? "Aplicando..." : "📢 Ads 2%"}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── Sellers view ── */}
          {showSellers && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {/* ── Top bar: scan button + range config ── */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
                <button onClick={() => handleScanCategory(undefined)} disabled={!!scanningCategory}
                  style={{ padding: "0.38rem 0.9rem", background: "var(--purple)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.78rem", cursor: "pointer", opacity: scanningCategory ? 0.5 : 1 }}>
                  {scanningCategory ? "⏳ Scanning..." : "🔎 Scan for CN sellers"}
                </button>
                {scanningCategory && (
                  <span style={{ fontSize: "0.75rem", color: "var(--text3)", alignSelf: "center" }}>
                    Searching 30 categories via Browse API...
                  </span>
                )}
                {/* Range config toggle */}
                <button onClick={() => setEditingRange(r => !r)}
                  style={{ padding: "0.38rem 0.75rem", background: "transparent", color: "var(--text2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: "0.78rem", cursor: "pointer", marginLeft: "auto" }}>
                  ⚙ Rango: {listingRange.min.toLocaleString()}–{listingRange.max.toLocaleString()} listings
                </button>
              </div>

              {/* ── Listing range editor ── */}
              {editingRange && (
                <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0.75rem 1rem", display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end" }}>
                  <div>
                    <div style={{ fontSize: "0.68rem", color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Min listings</div>
                    <input type="number" min={1} max={listingRange.max - 1}
                      value={listingRange.min}
                      onChange={e => setListingRange(r => ({ ...r, min: Math.max(1, parseInt(e.target.value) || 1) }))}
                      style={{ width: 90, background: "var(--bg1)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text1)", padding: "0.3rem 0.5rem", fontSize: "0.85rem", outline: "none" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: "0.68rem", color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Max listings</div>
                    <input type="number" min={listingRange.min + 1}
                      value={listingRange.max}
                      onChange={e => setListingRange(r => ({ ...r, max: Math.max(r.min + 1, parseInt(e.target.value) || 10000) }))}
                      style={{ width: 90, background: "var(--bg1)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text1)", padding: "0.3rem 0.5rem", fontSize: "0.85rem", outline: "none" }} />
                  </div>
                  <button
                    onClick={async () => {
                      await fetch("/api/ebay/discover-sellers", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ minListings: listingRange.min, maxListings: listingRange.max }),
                      });
                      setEditingRange(false);
                      toast(`✅ Rango guardado: ${listingRange.min.toLocaleString()}–${listingRange.max.toLocaleString()}`, "ok");
                    }}
                    style={{ padding: "0.38rem 0.9rem", background: "var(--green)", color: "#fff", border: "none", borderRadius: "var(--radius-sm)", fontWeight: 600, fontSize: "0.78rem", cursor: "pointer" }}>
                    💾 Guardar
                  </button>
                  <span style={{ fontSize: "0.72rem", color: "var(--text3)", alignSelf: "center" }}>
                    El scan buscará vendedores con este rango de listings activos.
                  </span>
                </div>
              )}

              {savedSellers.length === 0 && !scanningCategory && (
                <div style={{ textAlign: "center", color: "var(--text3)", padding: "2rem", fontSize: "0.85rem", lineHeight: 1.6 }}>
                  Sin vendedores guardados — presiona <strong>Scan for CN sellers</strong> para encontrar los top {listingRange.min.toLocaleString()}–{listingRange.max.toLocaleString()} listings
                </div>
              )}

              {savedSellers.length > 0 && (
                <div style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
                  {savedSellers.length} vendedores encontrados — ordenados por score (apariciones × diversidad de nichos × feedback)
                </div>
              )}

              {(() => {
                const grouped: Record<string, typeof savedSellers> = {};
                for (const s of savedSellers) { if (!grouped[s.category]) grouped[s.category] = []; grouped[s.category].push(s); }
                return Object.entries(grouped).map(([cat, sellers]) => (
                  <div key={cat}>
                    <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--purple)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "0.4rem" }}>{cat}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                      {sellers.map(s => (
                        <div key={s.username} style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0.65rem 0.9rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                            <a href={s.userUrl} target="_blank" rel="noopener noreferrer"
                              style={{ fontWeight: 700, fontSize: "0.88rem", color: "var(--blue)", textDecoration: "none", flex: 1, minWidth: 120 }}>
                              🏪 {s.username} ↗
                            </a>
                            <span style={{ fontSize: "0.72rem", background: "rgba(16,185,129,0.12)", color: "var(--green)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 99, padding: "0.15rem 0.55rem", whiteSpace: "nowrap" }}>
                              {s.totalListings.toLocaleString()} listings
                            </span>
                            {s.uniqueQueries ? (
                              <span style={{ fontSize: "0.72rem", background: "rgba(168,85,247,0.1)", color: "var(--purple)", border: "1px solid rgba(168,85,247,0.2)", borderRadius: 99, padding: "0.15rem 0.55rem", whiteSpace: "nowrap" }}>
                                🎯 {s.uniqueQueries} nichos
                              </span>
                            ) : null}
                            {s.appearances ? (
                              <span style={{ fontSize: "0.72rem", background: "rgba(16,185,129,0.1)", color: "var(--green)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 99, padding: "0.15rem 0.55rem", whiteSpace: "nowrap" }}>
                                👁 {s.appearances} visto
                              </span>
                            ) : null}
                            <button onClick={() => handleDeleteSeller(s.username)}
                              style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", background: "transparent", color: "var(--red)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer", flexShrink: 0 }}>✕</button>
                          </div>

                          {s.sampleTitles?.slice(0, 2).map((t: string, i: number) => (
                            <div key={i} style={{ fontSize: "0.72rem", color: "var(--text3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              · {t}
                            </div>
                          ))}

                          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.15rem" }}>
                            <button
                              onClick={() => { navigator.clipboard.writeText(s.storeUrl); toast("📋 Link copiado", "ok"); }}
                              style={{ fontSize: "0.71rem", padding: "0.22rem 0.6rem", background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer" }}>
                              📋 Copiar link
                            </button>
                            <span style={{ fontSize: "0.7rem", color: "var(--text3)", alignSelf: "center" }}>
                              Pega en Import Store para importar
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ));
              })()}
            </div>
          )}

          {/* ── Products grid ── */}
          {!showSellers && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "1rem" }}>
              {loading ? (
                <div style={{ gridColumn: "1/-1", display: "flex", flexDirection: "column", alignItems: "center", padding: "4rem", gap: "1rem" }}>
                  <div style={{ width: 30, height: 30, border: "3px solid var(--border)", borderTopColor: "var(--blue)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                  <span style={{ color: "var(--text2)", fontSize: "0.85rem" }}>Loading...</span>
                </div>
              ) : products.length === 0 ? (
                <div style={{ gridColumn: "1/-1", display: "flex", flexDirection: "column", alignItems: "center", padding: "4rem", gap: "0.75rem" }}>
                  <span style={{ fontSize: "2.5rem" }}>
                    {activeTab === "pending" ? "🔍" : activeTab === "approved" ? "✅" : activeTab === "published" ? "🚀" : activeTab === "failed" ? "⚠️" : "❌"}
                  </span>
                  <p style={{ color: "var(--text3)", fontWeight: 600, fontSize: "0.88rem" }}>
                    {activeTab === "pending" ? "Cola vacía — busca products arriba" : `No hay products ${QUEUE_TABS.find(t => t.key === activeTab)?.label.toLowerCase()}`}
                  </p>
                  {!selectedStoreId && <p style={{ color: "var(--amber)", fontSize: "0.8rem" }}>⚠ Crea y selecciona una tienda primero</p>}
                </div>
              ) : (
                products.map(p => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    onApprove={() => patch(p.id, { status: "approved" })}
                    onReject={() => patch(p.id, { status: "rejected" })}
                    onPublish={() => openPublishModal(p)}
                    onManualList={() => handleManualList(p.id)}
                    onUpdate={updates => patch(p.id, updates)}
                    onForcePublish={() => handleForcePublish(p)}
                  />
                ))
              )}

              {/* Load more */}
              {!loading && hasMore && (
                <div style={{ gridColumn: "1/-1", display: "flex", justifyContent: "center", padding: "0.75rem 0" }}>
                  <button
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    style={{ padding: "0.55rem 2rem", background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)", color: "var(--text2)", fontSize: "0.85rem", fontWeight: 600, cursor: loadingMore ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "0.5rem", opacity: loadingMore ? 0.6 : 1 }}
                  >
                    {loadingMore
                      ? <><div style={{ width: 14, height: 14, border: "2px solid var(--border2)", borderTopColor: "var(--blue)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} /> Loading...</>
                      : "↓ Load more products"}
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* ── Rate Limits Modal ── */}
      {showRateLimits && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setShowRateLimits(false)}>
          <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1.25rem", maxWidth: 680, width: "90%", maxHeight: "80vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
              <strong style={{ fontSize: "0.95rem" }}>📊 eBay API Rate Limits</strong>
              <button onClick={() => setShowRateLimits(false)} style={{ background: "none", border: "none", color: "var(--text2)", cursor: "pointer", fontSize: "1.1rem" }}>✕</button>
            </div>
            {loadingRateLimits && <div style={{ color: "var(--text2)", textAlign: "center", padding: "2rem" }}>Loading...</div>}
            {rateLimits && [
              { group: rateLimits.app,  label: "⚠️ App-level (diario)", color: "var(--amber)" },
              { group: rateLimits.user, label: "✅ User-level (por hora)", color: "var(--green)" },
            ].map(({ group, label, color }, gi) => (
              <div key={gi} style={{ marginBottom: "1rem" }}>
                <div style={{ fontSize: "0.72rem", fontWeight: 700, color, marginBottom: "0.5rem" }}>{label}</div>
                {(!group || group.length === 0) && <div style={{ fontSize: "0.78rem", color: "var(--text3)" }}>Sin datos</div>}
                {(group ?? []).map((api, ai) => (
                  <div key={ai} style={{ marginBottom: "0.85rem" }}>
                    <div style={{ fontSize: "0.76rem", fontWeight: 700, color: "var(--purple)", marginBottom: "0.35rem" }}>
                      {api.apiName} <span style={{ color: "var(--text3)", fontWeight: 400 }}>({api.apiContext})</span>
                    </div>
                    {api.resources.map((r, ri) => (r.rates ?? []).map((rate, rti) => (
                      <div key={`${ai}-${ri}-${rti}`} style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.3rem 0.5rem", marginBottom: "0.2rem", background: "var(--bg3)", borderRadius: "var(--radius-sm)", flexWrap: "wrap" }}>
                        <span style={{ color: "var(--text2)", fontSize: "0.73rem", minWidth: 180 }}>{r.name}</span>
                        <div style={{ flex: 1, minWidth: 100, height: 5, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ height: "100%", borderRadius: 3, width: `${Math.round((rate.remaining / rate.limit) * 100)}%`, background: rate.remaining < rate.limit * 0.1 ? "var(--red)" : rate.remaining < rate.limit * 0.3 ? "var(--amber)" : "var(--green)" }} />
                        </div>
                        <span style={{ fontSize: "0.7rem", minWidth: 75, textAlign: "right", color: rate.remaining < rate.limit * 0.1 ? "var(--red)" : rate.remaining < rate.limit * 0.3 ? "var(--amber)" : "var(--green)" }}>
                          {rate.remaining.toLocaleString()} / {rate.limit.toLocaleString()}
                        </span>
                        <span style={{ fontSize: "0.67rem", color: "var(--text3)" }}>reset {new Date(rate.reset).toLocaleTimeString()}</span>
                      </div>
                    )))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Publish modal ── */}
      {publishTarget && (
        <PublishModal
          product={publishTarget}
          stores={stores}
          defaultStoreId={selectedStoreId}
          onClose={() => setPublishTarget(null)}
          onConfirm={handlePublishConfirm}
        />
      )}


      {/* ── Reject All confirm modal ── */}
      {showRejectAllConfirm && (
        <div
          onClick={() => setShowRejectAllConfirm(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: "var(--bg1)", border: "1px solid var(--border)", borderRadius: 14, width: "100%", maxWidth: 380, overflow: "hidden" }}
          >
            {/* Header */}
            <div style={{ padding: "1.25rem 1.25rem 1rem", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: "1.5rem", marginBottom: "0.4rem" }}>🗑</div>
              <div style={{ fontWeight: 700, fontSize: "1rem", color: "var(--text1)" }}>
                Reject all {activeTab}?
              </div>
            </div>
            {/* Body */}
            <div style={{ padding: "1rem 1.25rem", fontSize: "0.85rem", color: "var(--text2)", lineHeight: 1.6 }}>
              <p style={{ margin: 0 }}>
                Se moverán <strong style={{ color: "var(--text1)" }}>{stats[activeTab as keyof typeof stats]} productos</strong> al estado <strong style={{ color: "var(--text1)" }}>Rejected</strong>.
              </p>
              <p style={{ margin: "0.5rem 0 0", fontSize: "0.78rem", color: "var(--text3)" }}>
                Los productos rechazados no aparecerán en futuras búsquedas. Esta acción no se puede deshacer.
              </p>
            </div>
            {/* Actions */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", padding: "0 1.25rem 1.25rem" }}>
              <button
                onClick={() => setShowRejectAllConfirm(false)}
                style={{ padding: "0.6rem", background: "transparent", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text2)", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer" }}
              >
                Cancelar
              </button>
              <button
                onClick={handleRejectAll}
                style={{ padding: "0.6rem", background: "var(--red)", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: "0.85rem", cursor: "pointer" }}
              >
                🗑 Reject all
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Settings modals ── */}
      {showStoreModal    && <StoreModal    stores={stores} userId={uid} onClose={() => setShowStoreModal(false)}    onStoresChange={setStores} />}
      {showFiltersModal  && <FiltersModal  onClose={() => setShowFiltersModal(false)} />}
      {showKeywordsModal && <KeywordsModal  onClose={() => setShowKeywordsModal(false)} />}
      {showPoliciesModal  && <PoliciesModal   onClose={() => setShowPoliciesModal(false)} />}

      {/* ── Toast stack ── */}
      <div style={{ position: "fixed", bottom: "1.25rem", right: "1.25rem", zIndex: 1000, display: "flex", flexDirection: "column", gap: "0.4rem", pointerEvents: "none" }}>
        {toasts.map(t => (
          <div key={t.id} style={{
            padding: "0.6rem 0.95rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem", fontWeight: 500,
            maxWidth: 340, boxShadow: "0 4px 20px rgba(0,0,0,0.4)", border: "1px solid",
            background: t.type === "ok" ? "rgba(16,185,129,0.12)" : t.type === "err" ? "rgba(239,68,68,0.12)" : "var(--bg3)",
            borderColor: t.type === "ok" ? "var(--green)" : t.type === "err" ? "var(--red)" : "var(--border2)",
            color: t.type === "ok" ? "var(--green)" : t.type === "err" ? "var(--red)" : "var(--text)",
          }}>
            {t.msg}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ textAlign: "center", padding: "0.6rem", borderTop: "1px solid var(--border)", fontSize: "0.72rem", color: "var(--text3)", flexShrink: 0 }}>
        <a href="/privacy" target="_blank" rel="noopener noreferrer"
          style={{ color: "var(--text3)", textDecoration: "none", marginRight: "0.6rem" }}>
          Privacy Policy
        </a>
        · © 2026 DropFlow
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}