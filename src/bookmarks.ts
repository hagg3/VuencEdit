/**
 * Per-world bookmarks for the World tab's Places section (ROADMAP-EDIT 24.2). One localStorage
 * entry per world, keyed by the case-folded path (`normalizePath`), so a world reopened through a
 * differently-cased Windows path finds its bookmarks. Pure functions + a tiny storage shim so
 * `bookmarks.test.ts` can pin the behaviour without React.
 */
export interface Bookmark { id: string; name: string; x: number; y: number }

const KEY_PREFIX = "eden_bookmarks:";
export const MAX_BOOKMARKS = 50;

export const bookmarkKey = (normPath: string) => KEY_PREFIX + normPath;

export function parseBookmarks(raw: string | null): Bookmark[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((b): b is Bookmark =>
      b && typeof b.id === "string" && typeof b.name === "string"
      && Number.isFinite(b.x) && Number.isFinite(b.y));
  } catch { return []; }
}

export function loadBookmarks(normPath: string | null): Bookmark[] {
  if (!normPath) return [];
  try { return parseBookmarks(localStorage.getItem(bookmarkKey(normPath))); } catch { return []; }
}

export function saveBookmarks(normPath: string | null, list: Bookmark[]) {
  if (!normPath) return;
  try {
    if (list.length === 0) localStorage.removeItem(bookmarkKey(normPath));
    else localStorage.setItem(bookmarkKey(normPath), JSON.stringify(list));
  } catch { /* storage full or unavailable: bookmarks are a convenience */ }
}

export function addBookmark(list: Bookmark[], x: number, y: number): Bookmark[] {
  if (list.length >= MAX_BOOKMARKS) return list;
  const n = list.length + 1;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return [...list, { id, name: `Bookmark ${n}`, x: Math.round(x), y: Math.round(y) }];
}

export function renameBookmark(list: Bookmark[], id: string, name: string): Bookmark[] {
  const trimmed = name.trim();
  if (!trimmed) return list;
  return list.map(b => (b.id === id ? { ...b, name: trimmed.slice(0, 40) } : b));
}

export const deleteBookmark = (list: Bookmark[], id: string): Bookmark[] => list.filter(b => b.id !== id);
