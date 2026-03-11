"use client";

export default function StatsBar({ stats }: { stats: { pending: number; approved: number; published: number; rejected: number } }) {
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  return (
    <div className="stats-bar">
      <div className="stat"><span className="stat-num">{total}</span><span className="stat-label">Total</span></div>
      <div className="divider" />
      <div className="stat"><span className="stat-num pending">{stats.pending}</span><span className="stat-label">En cola</span></div>
      <div className="divider" />
      <div className="stat"><span className="stat-num approved">{stats.approved}</span><span className="stat-label">Aprobados</span></div>
      <div className="divider" />
      <div className="stat"><span className="stat-num published">{stats.published}</span><span className="stat-label">Publicados</span></div>
      <style jsx>{`
        .stats-bar { display: flex; align-items: center; gap: 1.5rem; background: #0d0d14; border: 1px solid #1e2235; border-radius: 12px; padding: 1rem 1.5rem; margin-bottom: 1.5rem; }
        .stat { display: flex; flex-direction: column; align-items: center; gap: 0.2rem; }
        .stat-num { font-size: 1.5rem; font-weight: 800; color: #e2e8f0; line-height: 1; }
        .stat-num.pending { color: #f59e0b; }
        .stat-num.approved { color: #10b981; }
        .stat-num.published { color: #60a5fa; }
        .stat-label { font-size: 0.7rem; color: #4a5568; text-transform: uppercase; letter-spacing: 0.05em; }
        .divider { width: 1px; height: 30px; background: #1e2235; }
      `}</style>
    </div>
  );
}