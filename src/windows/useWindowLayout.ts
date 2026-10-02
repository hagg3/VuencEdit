/**
 * The floating-window store (UI redesign r3, Stage 14.3). A small module-level store read through
 * `useSyncExternalStore` — no new dependency, and nothing here lives in App state, so a window drag
 * never re-renders App: `FloatingWindow` writes the frame's style directly per pointermove and only
 * calls `setWin` on pointer-up (the "no App re-render at pointer rate" invariant).
 *
 * Persistence is per world (`windowStorage.ts`): `loadWorld` picks a layout on open; every *commit*
 * (drop, resize end, open/close/collapse, swap, reset) schedules one debounced write. Work-area
 * changes are not commits — the rendered rect is derived from the stored anchor (`rectOf`), so
 * there is nothing to write when the sidebar opens.
 */
import { useSyncExternalStore } from "react";
import {
  WIN_IDS, defaultWins, setCollapsed, toggleEnlarged, winLimits,
  type DefaultOpts, type Size, type WinId, type WinState,
} from "./windowGeometry";
import {
  copyForSaveAs, pickLayout, readStore, recordLayout, writeStore, type LayoutSource,
} from "./windowStorage";

export interface WindowLayoutState {
  swapped: boolean;
  wins: Record<WinId, WinState>;
  /** Back-to-front. A window's z-index inside the layer is its index + 1. */
  order: WinId[];
  /** The work area's current size (measured by `WindowLayer`). */
  work: Size;
  /** A window drag/resize is live — `WindowLayer` shows its drag shield. */
  dragging: boolean;
  snap: boolean;
  /** The 3D view is the main pane and is walking (fly/look): windows go click-through so a hidden
   *  or frozen look-mode cursor can never land a click or hover on a window floating over it. */
  passThrough: boolean;
  /** Context panels currently rendered (Stage 16.5), for `contextPanels.stackOffsets`. Not persisted —
   *  it's derived from mode state every session. Registered by `ContextPanel`. */
  activeContext: WinId[];
  /** The Lens's selection-mode flag (20.4, plan D1): session-only like the paste flag
   *  (`wins.lens.open`), never stored. */
  lensSelOn: boolean;
}

const FALLBACK_WORK: Size = { w: 1200, h: 700 };
let defaultOpts: DefaultOpts = { view3dOpen: false, toolsOpen: true, toolsCollapsed: false };

let state: WindowLayoutState = {
  swapped: false,
  wins: defaultWins(FALLBACK_WORK, defaultOpts),
  order: [...WIN_IDS],
  work: FALLBACK_WORK,
  dragging: false,
  snap: true,
  passThrough: false,
  activeContext: [],
  lensSelOn: true,
};
/** Has `loadWorld` run with a real work-area size? Defaults sized before that are provisional. */
let worldKey: { path: string | null; identity: string } | null = null;
let pendingDefaults = false;

/** The paste lens's "enabled" flag (Stage 16.1) — session-only: on at launch, flipped by
 *  `openWin`/`closeWin("lens")`, never read from storage. Mirrored into `wins.lens.open` (which the
 *  lens's render gate and the ribbon's armed state already read) by `withLensFlag`, so it survives a
 *  world switch even though each world's stored layout says nothing about it. */
let lensEnabled = true;
function withLensFlag(wins: Record<WinId, WinState>): Record<WinId, WinState> {
  return wins.lens.open === lensEnabled ? wins : { ...wins, lens: { ...wins.lens, open: lensEnabled } };
}

const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
function set(next: Partial<WindowLayoutState>) {
  state = { ...state, ...next };
  emit();
}

export function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function getWindowState(): WindowLayoutState { return state; }

export function useWindowLayout(): WindowLayoutState {
  return useSyncExternalStore(subscribe, getWindowState, getWindowState);
}

// ── Persistence ───────────────────────────────────────────────────────────────

const PERSIST_MS = 500;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistNow() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (!worldKey) return;
  const defaults = defaultWins(state.work, defaultOpts);
  const store = readStore(defaults);
  writeStore(recordLayout(store, worldKey.path, worldKey.identity, {
    swapped: state.swapped, wins: state.wins, workAtSave: state.work,
  }, Date.now()));
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_MS);
}

/** Commit = change + persist (debounced). */
function commit(next: Partial<WindowLayoutState>) {
  set(next);
  schedulePersist();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/** First-run defaults (Open question 2: the 3D window opens on a fresh install unless the device
 *  looks low-end). Set once at startup, before any world loads. */
export function setDefaultOpts(o: DefaultOpts) { defaultOpts = o; }
export function setSnap(on: boolean) { if (state.snap !== on) set({ snap: on }); }

/**
 * A world was opened: pick its layout (path → identity → last → defaults). Flushes any pending
 * write for the previous world first so it isn't recorded under the new key.
 */
export function loadWorld(path: string | null, identity: string, fresh = false): LayoutSource {
  if (persistTimer) persistNow();
  worldKey = { path, identity };
  const defaults = defaultWins(state.work, defaultOpts);
  const { layout, source } = pickLayout(readStore(defaults), path, identity, fresh);
  pendingDefaults = layout == null && state.work === FALLBACK_WORK;
  set({ swapped: layout?.swapped ?? false, wins: withLensFlag(layout?.wins ?? defaults), dragging: false });
  return source;
}

/** The world was closed: flush, and stop recording. */
export function closeWorld() {
  if (persistTimer) persistNow();
  worldKey = null;
}

/** Save As: the new path inherits this world's layout, and becomes the key from now on. */
export function saveAs(newPath: string) {
  if (!worldKey) return;
  persistNow();
  writeStore(copyForSaveAs(readStore(defaultWins(state.work, defaultOpts)), worldKey.path, newPath, worldKey.identity, Date.now()));
  worldKey = { ...worldKey, path: newPath };
}

/** `WindowLayer` measured the work area. Not a commit (see file header). */
export function setWork(work: Size) {
  if (work.w <= 0 || work.h <= 0) return;
  if (work.w === state.work.w && work.h === state.work.h) return;
  // Defaults computed before the first real measurement were sized for a guessed work area;
  // re-derive them once, so the 3D window's 34 % width is of the real one.
  if (pendingDefaults) {
    pendingDefaults = false;
    set({ work, wins: withLensFlag(defaultWins(work, defaultOpts)) });
    return;
  }
  set({ work });
}

export function setDragging(on: boolean) { if (state.dragging !== on) set({ dragging: on }); }
export function setPassThrough(on: boolean) { if (state.passThrough !== on) set({ passThrough: on }); }

/** A context panel appeared/disappeared (16.5). Not a commit — see `activeContext`. */
export function setContextActive(id: WinId, on: boolean) {
  const has = state.activeContext.includes(id);
  if (has === on) return;
  set({ activeContext: on ? [...state.activeContext, id] : state.activeContext.filter(x => x !== id) });
}

// ── Window actions ────────────────────────────────────────────────────────────

export function setWin(id: WinId, s: WinState) {
  commit({ wins: { ...state.wins, [id]: s } });
}

export function toFront(id: WinId) {
  if (state.order[state.order.length - 1] === id) return;
  set({ order: [...state.order.filter(x => x !== id), id] });
}

export function openWin(id: WinId) {
  const w = state.wins[id];
  if (w.open) { toFront(id); return; }
  if (id === "lens") lensEnabled = true;
  commit({ wins: { ...state.wins, [id]: { ...w, open: true } }, order: [...state.order.filter(x => x !== id), id] });
}

export function closeWin(id: WinId) {
  const w = state.wins[id];
  if (!w.open) return;
  if (id === "lens") lensEnabled = false;
  commit({ wins: { ...state.wins, [id]: { ...w, open: false } } });
}

export function toggleWin(id: WinId) {
  if (state.wins[id].open) closeWin(id); else openWin(id);
}

export function collapseWin(id: WinId, collapsed?: boolean) {
  const w = state.wins[id];
  const next = setCollapsed(w, collapsed ?? !w.collapsed, state.work, winLimits(id, state.work));
  if (next !== w) setWin(id, next);
}

export function enlargeWin(id: WinId) {
  setWin(id, toggleEnlarged(state.wins[id], state.work));
}

export function setSwapped(swapped: boolean) {
  if (state.swapped === swapped) return;
  // Swapping with the window closed would leave nothing showing the other viewport — open it.
  const v = state.wins.view3d;
  const wins = swapped && (!v.open || v.collapsed)
    ? { ...state.wins, view3d: { ...v, open: true, collapsed: false } }
    : state.wins;
  commit({ swapped, wins });
}

/** View ▸ Layout ▸ Reset windows: factory positions/sizes, keeping which windows are open. */
export function resetWindows() {
  const d = defaultWins(state.work, defaultOpts);
  const wins = {} as Record<WinId, WinState>;
  for (const id of WIN_IDS) wins[id] = { ...d[id], open: state.wins[id].open, collapsed: false };
  commit({ wins, swapped: false });
}

/** The Lens's two session flags at once (⌥P / ✕ / Settings, `lensMode.lensToggle`). The paste flag
 *  is `wins.lens.open` (a commit, for the geometry's sake; `open` itself is never stored), the
 *  selection flag is `lensSelOn` (store-only). */
export function setLensFlags(f: { pasteOn?: boolean; selOn?: boolean }) {
  if (f.pasteOn != null) { if (f.pasteOn) openWin("lens"); else closeWin("lens"); }
  if (f.selOn != null && f.selOn !== state.lensSelOn) set({ lensSelOn: f.selOn });
}

// ── Paste lens attach/follow (Stage 14.9) ────────────────────────────────────────────────────
//
// "Attached" is a real, persisted part of the lens's `WinState` (the 🔗 button's state must
// survive a world reopen), so it goes through `setWin`/`commit` like any other window change.
// *Following* the ghost while attached is not: it can fire many times a second while the mouse
// moves over the map, and unlike a drag it never represents something the user should get back on
// the next launch — the position is always re-derived from the live ghost the moment a paste is
// next armed. Recomputing it through `commit` would restart the 500ms persistence debounce on every
// tick (so a continuous hover could defer the write indefinitely) and would write a meaningless
// "position" to `localStorage` that the very next attach recomputes anyway. `set()` (no persist) is
// the right primitive — the same reason `toFront`/`setDragging` don't persist either.

/** The 🔗 button: explicit attach/detach. A real commit — see the file section header. */
export function setLensAttached(attached: boolean) {
  const w = state.wins.lens;
  if (w.attached === attached) return;
  setWin("lens", { ...w, attached });
}

/**
 * Follow tick: reposition the lens at `pos` (work-area-local px, already placed by
 * `lensPlacement.ts`) without touching persistence. A no-op unless the lens is open *and*
 * currently attached — a caller mid-flight from a throttle/rAF callback can't always tell that the
 * window closed or was detached since the tick was scheduled, so the guard lives here rather than
 * at every call site.
 */
export function followLensPosition(pos: { x: number; y: number }) {
  const w = state.wins.lens;
  if (!w.open || !w.attached) return;
  if (w.anchor.h === "l" && w.anchor.v === "t" && w.dx === pos.x && w.dy === pos.y) return;
  set({ wins: { ...state.wins, lens: { ...w, anchor: { h: "l", v: "t" }, dx: pos.x, dy: pos.y } } });
}
