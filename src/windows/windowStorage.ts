/**
 * Per-world window-layout persistence (UI redesign r3, Stage 14.3, windows sub-plan §6). Pure:
 * every function takes and returns plain data; the one `localStorage` touch is in `readStore` /
 * `writeStore`, and both swallow failures (a corrupt blob must never throw — same rule as
 * `loadHotbar`).
 *
 * One raw localStorage key, **not** an `AppSettings` field: it is an unbounded map, like the
 * `HOTBAR_*` and `ribbon_collapsed` keys.
 *
 * Key for "this world": the **normalised source path** first (what users think of as the world;
 * case-folded on Windows), then a **header identity** fallback for a moved/renamed/downloaded/
 * recovered copy. The identity is `dims + abs_min + format` — not the world name (renameable from
 * the pill) and not the directory offset (changes on save). `WorldMeta` carries no seed, so the
 * chunk-origin offset `abs_min_x/y` stands in for it: it is fixed at creation and survives saves.
 * A collision only means "a similar world's window layout", which is harmless.
 *
 * First open of a world with neither match inherits `last` — the layout the user most recently
 * left in *any* world — so a preferred arrangement carries over; with no `last` either (fresh
 * install), the caller uses `defaultWins`. A per-world record is only created once the user
 * changes something in that world.
 */
import { WIN_IDS, winLimits, type Anchor, type WinId, type WinState } from "./windowGeometry";
import { contextIds } from "./contextPanels";

export const STORAGE_KEY = "vuencedit_window_layouts";
export const STORAGE_VERSION = 1;
export const MAX_WORLDS = 64;

export interface WorldLayout {
  /** 3D is the main pane and the map is in the window. */
  swapped: boolean;
  wins: Record<WinId, WinState>;
  /** Work-area size when saved — diagnostics / a future proportional mode only. */
  workAtSave: { w: number; h: number };
}

export interface LayoutEntry { path: string | null; identity: string; layout: WorldLayout; used: number }

export interface LayoutStore {
  v: number;
  last: WorldLayout | null;
  worlds: LayoutEntry[];
}

export const EMPTY_STORE: LayoutStore = { v: STORAGE_VERSION, last: null, worlds: [] };

/** Case-fold on Windows (drive letters and NTFS are case-insensitive); unify separators there too. */
export function normalizePath(path: string | null | undefined, windows: boolean): string | null {
  if (!path) return null;
  return windows ? path.replace(/\//g, "\\").toLowerCase() : path;
}

export function worldIdentity(meta: {
  width_chunks: number; height_chunks: number; abs_min_x: number; abs_min_y: number;
}, format: string): string {
  return `dims:${meta.width_chunks}x${meta.height_chunks}|min:${meta.abs_min_x},${meta.abs_min_y}|fmt:${format}`;
}

export type LayoutSource = "path" | "identity" | "last" | "default";

/** Which stored layout applies to a world being opened. `null` layout = use `defaultWins`. */
/** `fresh` = a world New World just generated. Its identity (dims/origin/format) is shared by every
 *  other world of the same preset, so an identity hit would be an unrelated older world's layout —
 *  the 3D view reopening closed because some other flat world once had it closed. It skips straight
 *  to `last`, which is what "the layout the user most recently left" means for a brand-new world. */
export function pickLayout(store: LayoutStore, path: string | null, identity: string, fresh = false): { layout: WorldLayout | null; source: LayoutSource } {
  if (path) {
    const hit = store.worlds.find(e => e.path === path);
    if (hit) return { layout: hit.layout, source: "path" };
  }
  const byId = fresh ? undefined : store.worlds.find(e => e.identity === identity);
  if (byId) return { layout: byId.layout, source: "identity" };
  if (store.last) return { layout: store.last, source: "last" };
  return { layout: null, source: "default" };
}

/**
 * Record a layout for a world (called on commit events: drop, resize end, open/close/collapse,
 * swap). Replaces a path match, else an identity match with no path of its own; LRU-evicts past
 * `MAX_WORLDS` by oldest `used`. Always also becomes `last`.
 */
export function recordLayout(store: LayoutStore, path: string | null, identity: string, layout: WorldLayout, now: number): LayoutStore {
  const worlds = store.worlds.filter(e =>
    path ? e.path !== path : !(e.path === null && e.identity === identity));
  layout = { ...layout, wins: sessionizeContext(layout.wins) };
  worlds.push({ path, identity, layout, used: now });
  worlds.sort((a, b) => b.used - a.used);
  return { v: STORAGE_VERSION, last: layout, worlds: worlds.slice(0, MAX_WORLDS) };
}

/** Save As: the new path inherits the old path's layout (the identity is unchanged). */
export function copyForSaveAs(store: LayoutStore, oldPath: string | null, newPath: string, identity: string, now: number): LayoutStore {
  const src = (oldPath && store.worlds.find(e => e.path === oldPath))
    ?? store.worlds.find(e => e.identity === identity);
  if (!src) return store;
  const worlds = store.worlds.filter(e => e.path !== newPath);
  worlds.push({ path: newPath, identity, layout: src.layout, used: now });
  worlds.sort((a, b) => b.used - a.used);
  return { ...store, worlds: worlds.slice(0, MAX_WORLDS) };
}

// ── Validation ────────────────────────────────────────────────────────────────

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function sanitizeAnchor(a: unknown): Anchor | null {
  if (!a || typeof a !== "object") return null;
  const { h, v } = a as Record<string, unknown>;
  if ((h === "l" || h === "c" || h === "r") && (v === "t" || v === "b")) return { h, v };
  return null;
}

/** One window: NaN / negative / missing fields fall back to `fallback`'s. */
function sanitizeWin(raw: unknown, fallback: WinState): WinState {
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const pos = (v: unknown, d: number) => (num(v) && v >= 0 ? v : d);
  const off = (v: unknown, d: number) => (num(v) ? v : d);
  const restore = r.restore && typeof r.restore === "object" ? (() => {
    const q = r.restore as Record<string, unknown>;
    const a = sanitizeAnchor(q.anchor);
    return a && num(q.w) && num(q.h) && num(q.dx) && num(q.dy)
      ? { w: q.w, h: q.h, anchor: a, dx: q.dx, dy: q.dy } : null;
  })() : null;
  return {
    open: typeof r.open === "boolean" ? r.open : fallback.open,
    collapsed: typeof r.collapsed === "boolean" ? r.collapsed : fallback.collapsed,
    w: pos(r.w, fallback.w) || fallback.w,
    h: pos(r.h, fallback.h) || fallback.h,
    anchor: sanitizeAnchor(r.anchor) ?? fallback.anchor,
    dx: off(r.dx, fallback.dx),
    dy: off(r.dy, fallback.dy),
    ...(restore ? { restore } : null),
    // Lens only; harmless (and dropped by `rectOf`, which never reads it) on every other window.
    ...(typeof r.attached === "boolean" ? { attached: r.attached } : fallback.attached !== undefined ? { attached: fallback.attached } : null),
    // Context panels only (16.5) — see `WinState.placed`.
    ...(r.placed === true ? { placed: true } : null),
  };
}

/**
 * A context panel's stored `open` is meaningless (Stage 16.5): the ordinary ones render purely from
 * their mode, and the paste lens's "enabled" flag is **session-only** (16.1) — on at every launch,
 * never restored from storage. Geometry/collapsed/attached/placed stay persisted per world. So
 * `open` is normalised to `true` on both read and write, which also keeps pre-16.1 blobs (where
 * `false` was the lens default, and a persisted "off" would otherwise silently disable it forever)
 * from turning the lens off.
 */
export function sessionizeContext(wins: Record<WinId, WinState>): Record<WinId, WinState> {
  let out = wins;
  for (const id of contextIds()) {
    if (!out[id].open) out = { ...out, [id]: { ...out[id], open: true } };
  }
  return out;
}

/**
 * Stage 16.2: a stored size that violates the window's limits is clamped on load. Only the static
 * half can be applied here — the work area isn't known yet (so 3D/lens keep their work-area `max`,
 * enforced at render by `rectOf`); Tools/Hotbar's content-sized `max` is static, so a wild stored
 * size (a pre-16.2 layout) is pulled in before anything renders it.
 */
function clampStoredSize(id: WinId, w: WinState): WinState {
  const { min, max } = winLimits(id, { w: Infinity, h: Infinity });
  const cw = Math.max(min.w, Math.min(max.w, w.w)), ch = Math.max(min.h, Math.min(max.h, w.h));
  return cw === w.w && ch === w.h ? w : { ...w, w: cw, h: ch };
}

/** A stored layout, with every window validated against `defaults`; unknown ids dropped. */
export function sanitizeLayout(raw: unknown, defaults: Record<WinId, WinState>): WorldLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const winsRaw = (r.wins && typeof r.wins === "object" ? r.wins : {}) as Record<string, unknown>;
  const wins = {} as Record<WinId, WinState>;
  for (const id of WIN_IDS) wins[id] = clampStoredSize(id, sanitizeWin(winsRaw[id], defaults[id]));
  const was = (r.workAtSave ?? {}) as Record<string, unknown>;
  return {
    swapped: r.swapped === true,
    wins: sessionizeContext(wins),
    workAtSave: { w: num(was.w) ? was.w : 0, h: num(was.h) ? was.h : 0 },
  };
}

/** Future format changes land here. v1 is the only version so far — anything else is discarded. */
export function migrateStore(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.v === STORAGE_VERSION) return raw;
  return null;
}

/** Parse a stored blob. Corrupt / wrong-version input → an empty store, never a throw. */
export function parseStore(text: string | null, defaults: Record<WinId, WinState>): LayoutStore {
  if (!text) return EMPTY_STORE;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return EMPTY_STORE;
    const m = migrateStore(parsed as Record<string, unknown>);
    if (!m) return EMPTY_STORE;
    const worlds: LayoutEntry[] = [];
    for (const e of Array.isArray(m.worlds) ? m.worlds : []) {
      if (!e || typeof e !== "object") continue;
      const layout = sanitizeLayout((e as Record<string, unknown>).layout, defaults);
      const identity = (e as Record<string, unknown>).identity;
      const path = (e as Record<string, unknown>).path;
      const used = (e as Record<string, unknown>).used;
      if (!layout || typeof identity !== "string") continue;
      worlds.push({ path: typeof path === "string" ? path : null, identity, layout, used: num(used) ? used : 0 });
    }
    return { v: STORAGE_VERSION, last: sanitizeLayout(m.last, defaults), worlds };
  } catch {
    return EMPTY_STORE;
  }
}

export function readStore(defaults: Record<WinId, WinState>): LayoutStore {
  try { return parseStore(localStorage.getItem(STORAGE_KEY), defaults); } catch { return EMPTY_STORE; }
}

export function writeStore(store: LayoutStore): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* quota / private mode */ }
}
