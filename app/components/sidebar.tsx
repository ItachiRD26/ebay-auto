"use client";

import { Store } from "@/types";

type TabType = "pending" | "approved" | "published" | "rejected" | "failed";

interface SidebarProps {
  stores: Store[];
  selectedStoreId: string;
  setSelectedStoreId: (id: string) => void;
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  showSellers: boolean;
  setShowSellers: (v: boolean | ((s: boolean) => boolean)) => void;
  stats: Record<TabType, number>;
  onRateLimits: () => void;
  onStoreModal: () => void;
  onFilters: () => void;
  onKeywords: () => void;
  onPolicies: () => void;
  onSignOut: () => void;
}

const QUEUE_TABS: { key: TabType; icon: string; label: string; color: string }[] = [
  { key: "pending",   icon: "🔍", label: "Pending",   color: "var(--amber)" },
  { key: "approved",  icon: "✅", label: "Approved",  color: "var(--green)" },
  { key: "published", icon: "🚀", label: "Published", color: "var(--blue)"  },
  { key: "rejected",  icon: "❌", label: "Rejected",  color: "var(--red)"   },
  { key: "failed",    icon: "⚠️", label: "Failed",    color: "var(--text2)" },
];

function SidebarLabel({ text }: { text: string }) {
  return (
    <div style={{ padding: "0.25rem 0.75rem", fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.07em",
      textTransform: "uppercase", color: "var(--text3)", marginTop: "0.25rem" }}>
      {text}
    </div>
  );
}

function SidebarDivider() {
  return <div style={{ height: 1, background: "var(--border)", margin: "0.4rem 0" }} />;
}

function SidebarItem({ icon, label, badge, active, onClick }: {
  icon: string; label: string; badge?: number; active?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: "0.6rem",
      padding: "0.45rem 0.75rem", width: "100%", textAlign: "left",
      background: active ? "rgba(59,130,246,0.12)" : "transparent",
      border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer",
      color: active ? "var(--blue)" : "var(--text2)", fontSize: "0.83rem", fontWeight: active ? 600 : 400,
    }}>
      <span style={{ fontSize: "0.95rem", width: 20, textAlign: "center" }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span style={{ background: "var(--blue)", color: "#fff", borderRadius: 99,
          padding: "0.05rem 0.45rem", fontSize: "0.68rem", fontWeight: 700 }}>{badge}</span>
      )}
    </button>
  );
}

export default function Sidebar({
  stores, selectedStoreId, setSelectedStoreId,
  activeTab, setActiveTab, showSellers, setShowSellers,
  stats, onRateLimits, onStoreModal, onFilters, onKeywords, onPolicies, onSignOut
}: SidebarProps) {
  return (
    <nav style={{
      width: 200, flexShrink: 0, background: "var(--bg2)",
      borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column",
      padding: "0.75rem 0.5rem", gap: "0.15rem", overflowY: "auto",
    }}>
      {/* Logo */}
      <div style={{ padding: "0.25rem 0.75rem 0.75rem", fontWeight: 800, fontSize: "1.1rem",
        letterSpacing: "-0.03em", color: "var(--text)" }}>
        DropFlow
      </div>

      {/* Store selector */}
      {stores.length > 0 && (
        <div style={{ padding: "0 0.5rem 0.5rem" }}>
          <select
            value={selectedStoreId}
            onChange={e => setSelectedStoreId(e.target.value)}
            style={{ width: "100%", padding: "0.35rem 0.5rem", background: "var(--bg3)",
              border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)",
              color: "var(--text)", fontSize: "0.78rem", cursor: "pointer" }}
          >
            {stores.map(s => (
              <option key={s.id} value={s.id}>
                {s.connected ? "🟢" : "🔴"} {s.name || s.id}
              </option>
            ))}
          </select>
        </div>
      )}

      <SidebarDivider />

      {/* Search sources */}
      <SidebarLabel text="Discovery" />
      <SidebarItem icon="🛍" label="eBay Search" active={!showSellers && activeTab === "pending"} onClick={() => { setActiveTab("pending"); setShowSellers(false); }} />
      <SidebarItem icon="🇨🇳" label="1688" onClick={() => { setShowSellers(false); setActiveTab("pending"); }} />

      <SidebarDivider />

      {/* Queue */}
      <SidebarLabel text="Queue" />
      {QUEUE_TABS.map(tab => (
        <SidebarItem
          key={tab.key}
          icon={tab.icon}
          label={tab.label}
          badge={stats[tab.key]}
          active={activeTab === tab.key && !showSellers}
          onClick={() => { setActiveTab(tab.key); setShowSellers(false); }}
        />
      ))}

      <SidebarDivider />

      {/* Tools */}
      <SidebarLabel text="Herramientas" />
      <SidebarItem icon="🏪" label="Vendedores CN" active={showSellers} onClick={() => setShowSellers(s => !s)} />
      <SidebarItem icon="📊" label="Rate Limits" onClick={onRateLimits} />

      <SidebarDivider />

      {/* Settings */}
      <SidebarLabel text="Configuración" />
      <SidebarItem icon="🏬" label="My Stores"    onClick={onStoreModal} />
      <SidebarItem icon="⚙"  label="Filters"      onClick={onFilters}    />
      <SidebarItem icon="🔑" label="Keywords"     onClick={onKeywords}   />
      <SidebarItem icon="📋" label="eBay Policies" onClick={onPolicies}  />

      <div style={{ flex: 1 }} />
      <SidebarDivider />
      <SidebarItem icon="→" label="Sign Out" onClick={onSignOut} />
    </nav>
  );
}