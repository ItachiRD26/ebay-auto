// In-memory search progress — shared across the search route
export interface SearchProgress {
  active:    boolean;
  keyword:   string;
  reviewed:  number;
  passed:    number;
  published: number;
  failed:    number;
  keywords:  { done: number; total: number };
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

let progress: SearchProgress = {
  active: false, keyword: "", reviewed: 0,
  passed: 0, published: 0, failed: 0,
  keywords: { done: 0, total: 0 },
  skipReasons: { ...EMPTY_SKIPS },
  lastSkipReason: "",
};

export function getSearchProgress() { return { ...progress }; }

export function resetProgress(totalKeywords: number) {
  progress = {
    active: true, keyword: "", reviewed: 0, passed: 0, published: 0, failed: 0,
    keywords: { done: 0, total: totalKeywords },
    skipReasons: { ...EMPTY_SKIPS },
    lastSkipReason: "",
  };
}

export function updateProgress(patch: Partial<SearchProgress>) {
  progress = { ...progress, ...patch };
}

export function skipProgress(reason: keyof typeof EMPTY_SKIPS, detail?: string) {
  progress.skipReasons[reason]++;
  if (detail) progress.lastSkipReason = detail;
}

export function endProgress() {
  progress = { ...progress, active: false };
}