// In-memory search progress — keyed by userId to prevent cross-user state leakage
export interface SearchProgress {
  active:    boolean;
  keyword:   string;
  reviewed:  number;
  passed:    number;
  published: number;
  failed:    number;
  keywords:  { done: number; total: number };  // auto-search keyword loop counter
  phase2:    { reviewed: number; total: number }; // candidates being deep-evaluated
  skipReasons: {
    price:     number;
    banned:    number;
    country:   number;
    sales:     number;
    duplicate: number;
    condition: number;
  };
  lastSkipReason: string;
}

const EMPTY_SKIPS = { price: 0, banned: 0, country: 0, sales: 0, duplicate: 0, condition: 0 };

const EMPTY_PROGRESS = (): SearchProgress => ({
  active: false, keyword: "", reviewed: 0,
  passed: 0, published: 0, failed: 0,
  keywords: { done: 0, total: 0 },
  phase2:   { reviewed: 0, total: 0 },
  skipReasons: { ...EMPTY_SKIPS },
  lastSkipReason: "",
});

// Per-user progress map — prevents user A's search from overwriting user B's
const _progressMap = new Map<string, SearchProgress>();

export function getSearchProgress(userId: string) {
  return { ...(_progressMap.get(userId) ?? EMPTY_PROGRESS()) };
}

export function resetProgress(userId: string, totalKeywords: number) {
  _progressMap.set(userId, {
    active: true, keyword: "", reviewed: 0, passed: 0, published: 0, failed: 0,
    keywords: { done: 0, total: totalKeywords },
    phase2:   { reviewed: 0, total: 0 },
    skipReasons: { ...EMPTY_SKIPS },
    lastSkipReason: "",
  });
}

export function updateProgress(userId: string, patch: Partial<SearchProgress>) {
  const current = _progressMap.get(userId) ?? EMPTY_PROGRESS();
  _progressMap.set(userId, { ...current, ...patch });
}

export function skipProgress(userId: string, reason: keyof typeof EMPTY_SKIPS, detail?: string) {
  const current = _progressMap.get(userId) ?? EMPTY_PROGRESS();
  current.skipReasons[reason]++;
  if (detail) current.lastSkipReason = detail;
  _progressMap.set(userId, current);
}

export function endProgress(userId: string) {
  const current = _progressMap.get(userId) ?? EMPTY_PROGRESS();
  _progressMap.set(userId, { ...current, active: false });
}