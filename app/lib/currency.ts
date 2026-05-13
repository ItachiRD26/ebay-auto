// ─── Exchange rate helper — cached 1 hour ─────────────────────────────────────
let _cache: { rate: number; from: string; to: string; fetchedAt: number } | null = null;

export async function getExchangeRate(from: string, to: string): Promise<number> {
  if (_cache && _cache.from === from && _cache.to === to && Date.now() - _cache.fetchedAt < 3600_000)
    return _cache.rate;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { rates: Record<string, number> };
    const rate = data.rates[to];
    if (!rate) throw new Error(`No rate for ${to}`);
    _cache = { rate, from, to, fetchedAt: Date.now() };
    console.log(`[currency] ${from}→${to}: ${rate}`);
    return rate;
  } catch {
    return from === "CNY" && to === "USD" ? 0.138 : 1;
  }
}