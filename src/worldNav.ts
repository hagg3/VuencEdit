/**
 * Pure helpers behind the sidebar's World tab (ROADMAP-EDIT 24.1, `audit/00-inspector-sidebar.md`
 * Option A). Nothing here touches React or IPC, so `worldNav.test.ts` pins the behaviour.
 *
 * Coordinates are editor block coordinates: the space `get_records`, `spawnPos`/`playerPos`,
 * `MapCanvasRef.viewCenter()` and `FlyView3DRef.teleport` all share (the backend subtracts the
 * chunk origin before any of them reach the frontend).
 */
import type { SelectionInfo, SignInfo } from "./types";

/** Blocks a selection edits. A shaped selection's mask cells times its depth, never the bounding
 *  box: a lasso over a quarter of its rect is a quarter of the box (audit I-A1, the old
 *  `width * height * depth` readout). `cell_count` is null for a plain box. */
export function selectionVolume(sel: SelectionInfo): number {
  const area = sel.masked && sel.cell_count != null ? sel.cell_count : sel.width * sel.height;
  return area * sel.depth;
}

export type SignSort = "nearest" | "text";

/** Sign text folded for search: case-insensitive, and the line breaks a sign wraps on count as
 *  ordinary spaces, so "old mill" finds a sign written as "OLD\nMILL". */
function foldText(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Signs whose text contains every whitespace-separated term of `query`, in any order. An empty
 *  query keeps them all. The input array is never mutated. */
export function filterSigns(signs: readonly SignInfo[], query: string): SignInfo[] {
  const terms = foldText(query).split(" ").filter(Boolean);
  if (terms.length === 0) return signs.slice();
  return signs.filter((s) => {
    const t = foldText(s.text);
    return terms.every((term) => t.includes(term));
  });
}

/** Horizontal (XY) distance in blocks. Height is left out on purpose: "nearest" means nearest on
 *  the map the user is looking at. */
export function signDistance(s: SignInfo, centre: { x: number; y: number }): number {
  return Math.hypot(s.x - centre.x, s.y - centre.y);
}

/** Empty signs sort after written ones in text order, since "(empty)" isn't something to look up. */
function compareText(a: SignInfo, b: SignInfo): number {
  const ea = a.text.trim() === "", eb = b.text.trim() === "";
  if (ea !== eb) return ea ? 1 : -1;
  return foldText(a.text).localeCompare(foldText(b.text));
}

/** A sorted copy. `nearest` orders by distance from `centre` (ties by text, so the order is
 *  stable across re-renders); `text` is alphabetical (ties by distance). */
export function sortSigns(signs: readonly SignInfo[], mode: SignSort, centre: { x: number; y: number }): SignInfo[] {
  const keyed = signs.map((s) => ({ s, d: signDistance(s, centre) }));
  keyed.sort(mode === "nearest"
    ? (a, b) => (a.d - b.d) || compareText(a.s, b.s)
    : (a, b) => compareText(a.s, b.s) || (a.d - b.d));
  return keyed.map((k) => k.s);
}
