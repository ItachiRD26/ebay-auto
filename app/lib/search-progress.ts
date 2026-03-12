// In-memory search progress — shared across the search route
export interface SearchProgress {
  active:    boolean;
  keyword:   string;
  reviewed:  number;
  passed:    number;
  published: number;
  failed:    number;
  keywords:  { done: number; total: number };
}

let progress: SearchProgress = {
  active: false, keyword: "", reviewed: 0,
  passed: 0, published: 0, failed: 0,
  keywords: { done: 0, total: 0 },
};

export function getSearchProgress() { return { ...progress }; }
export function resetProgress(totalKeywords: number) {
  progress = { active: true, keyword: "", reviewed: 0, passed: 0, published: 0, failed: 0, keywords: { done: 0, total: totalKeywords } };
}
export function updateProgress(patch: Partial<SearchProgress>) {
  progress = { ...progress, ...patch };
}
export function endProgress() {
  progress = { ...progress, active: false };
}