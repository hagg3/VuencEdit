/**
 * ⌘K ranking (14.6). Pure: the palette passes in the searchable entries and the MRU list.
 *
 * Every query token must match somewhere (AND). Per token, the best of: label prefix (4) > prefix of
 * a later word in the label (3) > label substring (2) = keyword prefix (2) > path substring (1).
 * Ties go to the most recently used, then the shorter label, then alphabetical — so "fill" lists
 * "Fill" before "Fill Bucket" before "Pool Fill".
 */

export interface SearchEntry<Id extends string = string> {
  id: Id;
  label: string;
  /** "Home › Selection" — matched at the lowest weight. */
  path: string;
  keywords?: readonly string[];
}

function tokenScore(token: string, e: SearchEntry): number {
  const label = e.label.toLowerCase();
  if (label.startsWith(token)) return 4;
  if (label.split(/[\s/·()+-]+/).some(w => w.startsWith(token))) return 3;
  if (label.includes(token)) return 2;
  if (e.keywords?.some(k => k.toLowerCase().startsWith(token))) return 2;
  if (e.path.toLowerCase().includes(token)) return 1;
  return 0;
}

/** Score an entry against a query; 0 = no match. */
export function scoreEntry(query: string, e: SearchEntry): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const t of tokens) {
    const s = tokenScore(t, e);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

/** Ranked ids for `query` (empty query → empty; the palette shows MRU + starters instead). */
export function rank<Id extends string>(query: string, entries: readonly SearchEntry<Id>[], mru: readonly Id[] = []): Id[] {
  const mruPos = new Map(mru.map((id, i) => [id, i]));
  const scored: { e: SearchEntry<Id>; s: number }[] = [];
  for (const e of entries) {
    const s = scoreEntry(query, e);
    if (s > 0) scored.push({ e, s });
  }
  scored.sort((a, b) =>
    b.s - a.s
    || (mruPos.get(a.e.id) ?? Infinity) - (mruPos.get(b.e.id) ?? Infinity)
    || a.e.label.length - b.e.label.length
    || a.e.label.localeCompare(b.e.label));
  return scored.map(x => x.e.id);
}

/** Most-recent-first, de-duplicated, capped. */
export function pushMru<Id extends string>(mru: readonly Id[], id: Id, cap = 8): Id[] {
  return [id, ...mru.filter(x => x !== id)].slice(0, cap);
}
