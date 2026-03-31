/**
 * Search state persistence.
 * Uses localStorage (instant, survives page close) as primary storage.
 * Key: `dropflow_search_{userId}` — one saved state per user.
 */

export interface SavedSearchState {
  userId:       string;
  storeId:      string;
  keywordIndex: number;   // position in the keywords array to resume from
  keyword:      string;   // keyword name at that position (for display)
  total:        number;   // total number of keywords
  savedAt:      number;   // timestamp
}

const key = (userId: string) => `dropflow_search_${userId}`;

export function saveSearchState(state: SavedSearchState): void {
  try {
    localStorage.setItem(key(state.userId), JSON.stringify(state));
  } catch {}
}

export function loadSearchState(userId: string): SavedSearchState | null {
  try {
    const raw = localStorage.getItem(key(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSearchState;
    // Discard states older than 7 days
    if (Date.now() - parsed.savedAt > 7 * 24 * 60 * 60 * 1000) {
      clearSearchState(userId);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSearchState(userId: string): void {
  try {
    localStorage.removeItem(key(userId));
  } catch {}
}