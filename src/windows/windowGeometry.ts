/**
 * Floating-window geometry (UI redesign r3, Stage 14.3). **Pure** — no React, no DOM — so every
 * rule below is unit-tested in node (`windowGeometry.test.ts`, the `ribbon/layout.test.ts` idiom).
 * Behaviour reference: `TEST WORLDS/design-exploration-2026-09/js/mock.js` (`clampWin`,
 * `defaultWins`, the resize arithmetic, `collapseWin`).
 *
 * Coordinates are **work-area-local** px: (0,0) is the work area's top-left, i.e. the box between
 * the ribbon (+ Quick Actions bar) and the status bar, left of the docked sidebar.
 *
 * The persistence and reflow model is **anchor + offsets**. A window records which horizontal edge
 * (`l`/`c`/`r`) and vertical edge (`t`/`b`) it belongs to, and its distance from them. The rendered
 * rect is *derived* from that for whatever the work area currently is (`rectOf`), then shrunk to fit
 * and clamped. So a 3D window parked bottom-right stays bottom-right when the sidebar opens, a Tools
 * window parked top-left stays top-left when the ribbon collapses, and — because shrinking/clamping
 * is display-only — a window squeezed by a small work area gets its remembered size back when the
 * work area grows again. `rectOf` is a pure function of (state, work area), which is what makes the
 * reflow idempotent by construction.
 */

export type WinId = "tools" | "view3d" | "hotbar" | "lens" | "cutaway" | "brushshape" | "buildslot";
export const WIN_IDS: readonly WinId[] = ["tools", "view3d", "hotbar", "lens", "cutaway", "brushshape", "buildslot"];

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export type HAnchor = "l" | "c" | "r";
export type VAnchor = "t" | "b";
export interface Anchor { h: HAnchor; v: VAnchor }

/** The stored (persisted) state of one window. `x`/`y` are deliberately absent — see file header. */
export interface WinState {
  open: boolean;
  collapsed: boolean;
  /** Remembered expanded size (the rendered size may be smaller if the work area is). */
  w: number;
  h: number;
  anchor: Anchor;
  /** Offset from the anchored horizontal edge (for `c`: from the centred position, signed). */
  dx: number;
  /** Offset from the anchored vertical edge, measured to the window's *effective* edge. */
  dy: number;
  /** Set while enlarged (⤢): the geometry to return to on restore. */
  restore?: { w: number; h: number; anchor: Anchor; dx: number; dy: number } | null;
  /** Lens only (Stage 14.9): following the paste ghost. While true, `dx`/`dy` are recomputed live
   *  from the ghost's screen position on every follow tick rather than read as a stored position —
   *  see `followLensPosition` in `useWindowLayout.ts`. Dragging the title bar clears it. */
  attached?: boolean;
  /** Context panels only (Stage 16.5): the user dragged/resized/nudged it, so it keeps its stored
   *  position instead of stacking below the other active panels (`contextPanels.stackOffsets`). */
  placed?: boolean;
}

/** Margin windows snap to at the work-area edges. */
export const WM = 8;
/** Magnetic snap distance. */
export const SNAP = 12;
/** Title-bar height — also a collapsed (window-shaded) window's whole height. */
export const TITLE_H = 22;

/** Tools-window grid metrics — the ribbon's `SMALL_H` icon buttons, never scaled. */
export const TOOL_CELL = 26;
export const TOOL_GAP = 2;
export const TOOL_PAD = 4;
export const TOOL_COUNT = 6;

/** Hotbar grid metrics (mock `layoutHotbar`): ▣ + 10 slots, clamp 24–72px, 4px gap, 5px body inset. */
export const HOTBAR_SLOTS = 11;
export const HOTBAR_GAP = 4;
export const HOTBAR_PAD = 5;
export const HOTBAR_MIN_SLOT = 24;
export const HOTBAR_MAX_SLOT = 72;

/** Narrowest a Tools/Hotbar window gets: the title icon + collapse + ✕ still fit. */
const TOOLS_MIN_W = 64;
const HOTBAR_MIN_W = 70;

/** One Tools reflow's *body* size for `c` columns — the single source `toolsGridCols` (which picks
 *  a column count for a live body) and `winLimits` (which sizes the window from the reflows) share. */
export function toolsDims(c: number): Size {
  const rows = Math.ceil(TOOL_COUNT / c);
  return { w: c * TOOL_CELL + (c - 1) * TOOL_GAP + 2 * TOOL_PAD, h: rows * TOOL_CELL + (rows - 1) * TOOL_GAP + 2 * TOOL_PAD };
}
const TOOLS_COLS = [1, 2, 3, 6] as const;

/** One Hotbar reflow's body size for `c` columns of `size`-px slots. */
export function hotbarDims(c: number, size: number): Size {
  const rows = Math.ceil(HOTBAR_SLOTS / c);
  return { w: c * size + (c - 1) * HOTBAR_GAP + 2 * HOTBAR_PAD, h: rows * size + (rows - 1) * HOTBAR_GAP + 2 * HOTBAR_PAD };
}
const HOTBAR_COLS = Array.from({ length: HOTBAR_SLOTS }, (_, i) => i + 1);

/** Window sizes (body + title bar) at which *some* reflow fits with no clipping. */
const toolsOptions = (): Size[] => TOOLS_COLS.map(c => {
  const d = toolsDims(c);
  return { w: Math.max(TOOLS_MIN_W, d.w), h: d.h + TITLE_H };
});
const hotbarOptions = (size: number): Size[] => HOTBAR_COLS.map(c => {
  const d = hotbarDims(c, size);
  return { w: Math.max(HOTBAR_MIN_W, d.w), h: d.h + TITLE_H };
});

/** Is a (w × h) window big enough for one of `options`? If not, grow it by the least total px to
 *  reach the nearest one (growth on the deficient axes only — never shrinks). */
function growToOption(options: Size[], w: number, h: number): Size {
  let best = { w, h }, bestCost = Infinity;
  for (const o of options) {
    const dw = Math.max(0, o.w - w), dh = Math.max(0, o.h - h);
    if (dw + dh < bestCost) { bestCost = dw + dh; best = { w: w + dw, h: h + dh }; }
  }
  return best;
}

/**
 * Per-window size limits (Stage 16.2). `min`/`max` are per-axis; `fit` (Tools, Hotbar) additionally
 * grows a size that is inside the box but too small for *any* of the content's reflows — a plain
 * rectangle can't say "wide-and-short or narrow-and-tall, but never small-and-small". Content-sized
 * windows have a tight `max` (the natural size of the widest reflow, so there's no comically large
 * padding); the viewport-like windows (3D view, lens) may grow to the work area.
 */
export interface WinLimits {
  min: Size;
  max: Size;
  fit?: (w: number, h: number) => Size;
}

const minOf = (o: Size[]): Size => ({ w: Math.min(...o.map(s => s.w)), h: Math.min(...o.map(s => s.h)) });
const maxOf = (o: Size[]): Size => ({ w: Math.max(...o.map(s => s.w)), h: Math.max(...o.map(s => s.h)) });

/**
 * The three mode-driven context panels (Stage 16.6) are **content-sized**, and two of them have
 * content that changes with the mode (the brush-shape panel is one row taller for Rock than for
 * Noise; the build-slot panel is taller for Sculpt than Flood Fill). `PANEL_SIZES` lists each
 * variant's size (title bar + 8 px body padding + `SMALL_H` rows), the panel components pick one
 * and register it with `setContentSize`, and `winLimits` then pins min = max = that size. Until a
 * panel has registered (storage sanitising on load, tests) the limits are the range across its
 * variants, so a stored size can be clamped without knowing which variant will show.
 */
export const PANEL_SIZES = {
  cutaway: { level: { w: 290, h: 90 } },
  brushshape: { noise: { w: 290, h: 90 }, slope: { w: 290, h: 106 }, volumetric: { w: 480, h: 168 } },
  buildslot: { floodfill: { w: 290, h: 106 }, sculpt: { w: 290, h: 172 } },
} as const;

type ContextPanelId = "cutaway" | "brushshape" | "buildslot";
const panelRange = (id: ContextPanelId): { min: Size; max: Size } => {
  const v: Size[] = Object.values(PANEL_SIZES[id]);
  return { min: minOf(v), max: maxOf(v) };
};

/** The live content size each mounted context panel registered (see `PANEL_SIZES`). Module state,
 *  written during the panel's render — idempotent, so StrictMode's double render is harmless. */
const contentSizes: Partial<Record<WinId, Size>> = {};
export function setContentSize(id: WinId, size: Size | null): void {
  if (size) contentSizes[id] = size; else delete contentSizes[id];
}

export function winLimits(id: WinId, work: Size): WinLimits {
  switch (id) {
    case "cutaway": case "brushshape": case "buildslot": {
      const live = contentSizes[id];
      return live ? { min: live, max: live } : panelRange(id);
    }
    case "tools": {
      const o = toolsOptions();
      return { min: minOf(o), max: maxOf(o), fit: (w, h) => growToOption(o, w, h) };
    }
    case "hotbar": {
      const lo = hotbarOptions(HOTBAR_MIN_SLOT);
      return { min: minOf(lo), max: maxOf(hotbarOptions(HOTBAR_MAX_SLOT)), fit: (w, h) => growToOption(lo, w, h) };
    }
    case "view3d": return { min: { w: 240, h: 150 }, max: work };
    case "lens": return { min: { w: 220, h: 150 }, max: work };
  }
}

/** Smallest legal size per window (the `min` half of `winLimits`; static for every window). */
export const MIN_SIZE: Record<WinId, Size> = {
  tools: winLimits("tools", { w: 0, h: 0 }).min,
  view3d: winLimits("view3d", { w: 0, h: 0 }).min,
  hotbar: winLimits("hotbar", { w: 0, h: 0 }).min,
  lens: winLimits("lens", { w: 0, h: 0 }).min,
  cutaway: winLimits("cutaway", { w: 0, h: 0 }).min,
  brushshape: winLimits("brushshape", { w: 0, h: 0 }).min,
  buildslot: winLimits("buildslot", { w: 0, h: 0 }).min,
};

/** Where a caller has only a minimum (tests, pre-16.2 call sites), the max is unbounded. */
type LimitsArg = Size | WinLimits;
function asLimits(l: LimitsArg): WinLimits {
  return "min" in l ? l : { min: l, max: { w: Infinity, h: Infinity } };
}

export function effectiveHeight(s: Pick<WinState, "collapsed" | "h">): number {
  return s.collapsed ? TITLE_H : s.h;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The rendered rect for a window in a work area: size shrunk to fit (never below the minimum),
 * position derived from the anchor, then clamped fully inside. If the work area is smaller than the
 * window's minimum (only reachable below the app's 900 px `minWidth`), the window pins at (0,0) at
 * its minimum and the layer's `overflow:hidden` clips it.
 */
export function rectOf(s: WinState, work: Size, limits: LimitsArg): Rect {
  const { min, max, fit } = asLimits(limits);
  let w = Math.round(clamp(s.w, min.w, Math.max(min.w, Math.min(max.w, work.w - 2 * WM))));
  let fullH = Math.round(clamp(s.h, min.h, Math.max(min.h, Math.min(max.h, work.h - 2 * WM))));
  if (fit) {
    // A stored size that clips every reflow (a pre-16.2 layout, or a work area that just shrank)
    // grows to the nearest one that doesn't — display-only, like the shrink above.
    const f = fit(w, fullH);
    w = Math.min(f.w, Math.max(min.w, work.w - 2 * WM));
    fullH = Math.min(f.h, Math.max(min.h, work.h - 2 * WM));
  }
  const eh = s.collapsed ? TITLE_H : fullH;
  let x = s.anchor.h === "l" ? s.dx : s.anchor.h === "r" ? work.w - s.dx - w : (work.w - w) / 2 + s.dx;
  let y = s.anchor.v === "t" ? s.dy : work.h - s.dy - eh;
  x = clamp(x, 0, Math.max(0, work.w - w));
  y = clamp(y, 0, Math.max(0, work.h - eh));
  return { x: Math.round(x), y: Math.round(y), w, h: fullH };
}

/**
 * Stored state for a window now displayed at `rect` (e.g. on drop). The anchor is the edge/centre
 * the rect is snapped to, if any; otherwise the half of the work area its centre is in (`c` only
 * ever comes from the centre snap).
 */
export function stateFromRect(prev: WinState, rect: Rect, work: Size, snapped?: Partial<Anchor>): WinState {
  const eh = prev.collapsed ? TITLE_H : rect.h;
  const h: HAnchor = snapped?.h ?? snappedH(rect, work) ?? (rect.x + rect.w / 2 < work.w / 2 ? "l" : "r");
  const v: VAnchor = snapped?.v ?? snappedV(rect, eh, work) ?? (rect.y + eh / 2 < work.h / 2 ? "t" : "b");
  const dx = h === "l" ? rect.x : h === "r" ? work.w - rect.x - rect.w : rect.x - (work.w - rect.w) / 2;
  const dy = v === "t" ? rect.y : work.h - rect.y - eh;
  return { ...prev, w: rect.w, h: rect.h, anchor: { h, v }, dx: Math.round(dx), dy: Math.round(dy), restore: null };
}

function snappedH(r: Rect, work: Size): HAnchor | null {
  if (Math.abs(r.x - WM) < 0.5) return "l";
  if (Math.abs(r.x + r.w - (work.w - WM)) < 0.5) return "r";
  if (Math.abs(r.x - (work.w - r.w) / 2) < 0.5) return "c";
  return null;
}
function snappedV(r: Rect, eh: number, work: Size): VAnchor | null {
  if (Math.abs(r.y - WM) < 0.5) return "t";
  if (Math.abs(r.y + eh - (work.h - WM)) < 0.5) return "b";
  return null;
}

/**
 * A move: snap x to the left/right margins and the centre line, y to the top/bottom margins (each
 * within `SNAP` px), then clamp fully inside the work area. `eh` = the window's effective height.
 */
export function snapMove(x: number, y: number, w: number, eh: number, work: Size, snap = true): { x: number; y: number } {
  if (snap) {
    const xs = [WM, work.w - WM - w, (work.w - w) / 2];
    const ys = [WM, work.h - WM - eh];
    let bx = x, bd = SNAP + 1;
    for (const c of xs) { const d = Math.abs(x - c); if (d <= SNAP && d < bd) { bx = c; bd = d; } }
    let by = y, byd = SNAP + 1;
    for (const c of ys) { const d = Math.abs(y - c); if (d <= SNAP && d < byd) { by = c; byd = d; } }
    x = bx; y = by;
  }
  return {
    x: Math.round(clamp(x, 0, Math.max(0, work.w - w))),
    y: Math.round(clamp(y, 0, Math.max(0, work.h - eh))),
  };
}

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const RESIZE_DIRS: readonly ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/**
 * An 8-way resize from `start` by a pointer delta. `e`/`s` grow from the fixed origin, `w`/`n`
 * keep the opposite edge fixed; every moving edge snaps to its work-area margin and is stopped at
 * the work area and at the window's minimum size.
 */
export function resizeRect(start: Rect, dir: ResizeDir, ddx: number, ddy: number, work: Size, limits: LimitsArg, snap = true): Rect {
  const { min, max, fit } = asLimits(limits);
  let l = start.x, t = start.y, r = start.x + start.w, b = start.y + start.h;
  const snapTo = (v: number, target: number) => (snap && Math.abs(v - target) <= SNAP ? target : v);
  if (dir.includes("e")) r = clamp(snapTo(r + ddx, work.w - WM), l + min.w, Math.max(l + min.w, Math.min(work.w, l + max.w)));
  if (dir.includes("w")) l = clamp(snapTo(l + ddx, WM), Math.max(Math.min(0, r - min.w), r - max.w), r - min.w);
  if (dir.includes("s")) b = clamp(snapTo(b + ddy, work.h - WM), t + min.h, Math.max(t + min.h, Math.min(work.h, t + max.h)));
  if (dir.includes("n")) t = clamp(snapTo(t + ddy, WM), Math.max(Math.min(0, b - min.h), b - max.h), b - min.h);
  if (fit) {
    // Content-sized windows: a size inside [min, max] that still clips every reflow grows toward
    // the nearest one that fits, on the axis being dragged (or the far edge for a one-axis drag).
    const f = fit(r - l, b - t);
    if (f.w > r - l) { if (dir.includes("w")) l = r - f.w; else r = l + f.w; }
    if (f.h > b - t) { if (dir.includes("n")) t = b - f.h; else b = t + f.h; }
    // Growth may have run off the work area: slide back in rather than shrink below the fit.
    if (r > work.w) { l -= r - work.w; r = work.w; }
    if (l < 0) { r -= l; l = 0; }
    if (b > work.h) { t -= b - work.h; b = work.h; }
    if (t < 0) { b -= t; t = 0; }
  }
  return { x: Math.round(l), y: Math.round(t), w: Math.round(r - l), h: Math.round(b - t) };
}

/**
 * Window-shade collapse/expand. Collapsing keeps the title bar where it is. Expanding keeps it too,
 * *unless* the body would then run past the bottom edge — the window is pushed up so it fits (a
 * window collapsed near the bottom must not expand off-screen).
 */
export function setCollapsed(s: WinState, collapsed: boolean, work: Size, min: LimitsArg): WinState {
  if (s.collapsed === collapsed) return s;
  const r = rectOf(s, work, min);
  const next: WinState = { ...s, collapsed };
  const eh = collapsed ? TITLE_H : r.h;
  const y = clamp(r.y, 0, Math.max(0, work.h - eh));
  return stateFromRect(next, { ...r, y }, work, { h: s.anchor.h });
}

/** Enlarge ⤢ ↔ restore: 55 % of the work-area width (× 0.64 aspect), bottom-right. */
export function toggleEnlarged(s: WinState, work: Size): WinState {
  if (s.restore) {
    const { restore, ...rest } = s;
    return { ...rest, ...restore, restore: null };
  }
  const w = Math.round(work.w * 0.55);
  const h = Math.round(w * 0.64);
  return {
    ...s, collapsed: false, w, h, anchor: { h: "r", v: "b" }, dx: WM, dy: WM,
    restore: { w: s.w, h: s.h, anchor: s.anchor, dx: s.dx, dy: s.dy },
  };
}

/** Moves a window fully into view (keyboard nudge / after a size change) and re-derives its anchor. */
export function moveBy(s: WinState, ddx: number, ddy: number, work: Size, min: LimitsArg, snap: boolean): WinState {
  const r = rectOf(s, work, min);
  const p = snapMove(r.x + ddx, r.y + ddy, r.w, effectiveHeight({ collapsed: s.collapsed, h: r.h }), work, snap);
  return stateFromRect(s, { ...r, ...p }, work);
}

export interface DefaultOpts {
  view3dOpen: boolean;
  toolsOpen: boolean;
  toolsCollapsed: boolean;
}

/** Tools window's default size: the 2×3 grid of `SMALL_H` buttons plus padding. */
export const TOOLS_DEFAULT: Size = {
  w: 64,
  h: TITLE_H + 3 * TOOL_CELL + 2 * TOOL_GAP + TOOL_PAD * 2,
};

/**
 * First-run layout (mock `defaultWins`): Tools top-left, 3D bottom-right at 34 % of the work-area
 * width × 0.64 aspect, Hotbar open bottom-centre (Stage 14.5 — placing blocks is core, not opt-in
 * like the 3D pane/Tools). The paste lens is enabled by default (16.1) but only renders while a paste is armed.
 */
export function defaultWins(work: Size, o: DefaultOpts): Record<WinId, WinState> {
  const w3 = Math.max(MIN_SIZE.view3d.w, Math.round(work.w * 0.34));
  const h3 = Math.max(MIN_SIZE.view3d.h, Math.round(w3 * 0.64));
  return {
    tools: {
      open: o.toolsOpen, collapsed: o.toolsCollapsed, ...TOOLS_DEFAULT,
      anchor: { h: "l", v: "t" }, dx: WM, dy: WM,
    },
    view3d: { open: o.view3dOpen, collapsed: false, w: w3, h: h3, anchor: { h: "r", v: "b" }, dx: WM, dy: WM },
    // Open by default (14.5) — placing blocks is core, not opt-in like the 3D pane/Tools. Bottom
    // centre; the anchor+offset model has no "centred in the space left of a sibling window" concept
    // (that's mock `defaultWins`' exact `hotbar.x`), so this is a deliberate simplification.
    hotbar: { open: true, collapsed: false, w: 480, h: 64, anchor: { h: "c", v: "b" }, dx: 0, dy: WM },
    // "Open" = enabled (16.1): a session-only flag that starts on every launch (see
    // `windowStorage.sessionizeContext`). It only ever *renders* while a paste is armed, so being on
    // costs nothing until then. `attached: true` so it snaps straight to the ghost instead of
    // sitting at this placeholder corner.
    lens: { open: true, collapsed: false, w: 300, h: 196, anchor: { h: "l", v: "b" }, dx: WM, dy: WM, attached: true },
    // Mode-driven context panels (16.6): top-left under the ribbon like every context panel, but
    // shifted right of the Tools window's default column so a fresh layout doesn't stack them on it.
    cutaway: panelDefault(PANEL_SIZES.cutaway.level),
    brushshape: panelDefault(PANEL_SIZES.brushshape.volumetric),
    buildslot: panelDefault(PANEL_SIZES.buildslot.sculpt),
  };
}

/** Default stored state for a context panel (`contextPanels.ts` re-exports this as `contextDefault`):
 *  top-left of the work area, content-sized. */
export function contextDefault(size: Size): WinState {
  return { open: true, collapsed: false, w: size.w, h: size.h, anchor: { h: "l", v: "t" }, dx: WM, dy: WM };
}
const panelDefault = (size: Size): WinState => ({ ...contextDefault(size), dx: WM + TOOLS_DEFAULT.w + WM });

/**
 * Tools-window reflow (like the mock's `layoutHotbar`, but the buttons never scale — they are the
 * ribbon's `IconButton`s). Picks the column count in {1,2,3,6} whose grid fits the body and whose
 * shape is closest to it; if none fits, the one that overflows least. Default body → 2×3.
 */
export function toolsGridCols(bodyW: number, bodyH: number): number {
  const opts: number[] = [...TOOLS_COLS];
  const dims = toolsDims;
  const fits = opts.filter(c => { const d = dims(c); return d.w <= bodyW && d.h <= bodyH; });
  if (fits.length) {
    const bodyAspect = Math.log(Math.max(1, bodyW) / Math.max(1, bodyH));
    return fits.reduce((best, c) => {
      const a = (x: number) => { const d = dims(x); return Math.abs(Math.log(d.w / d.h) - bodyAspect); };
      return a(c) < a(best) ? c : best;
    });
  }
  return opts.reduce((best, c) => {
    const over = (x: number) => { const d = dims(x); return Math.max(0, d.w - bodyW) + Math.max(0, d.h - bodyH); };
    return over(c) < over(best) ? c : best;
  });
}

/**
 * Hotbar-window reflow (mock `layoutHotbar`): picks the column count `c` in `1..=11` that
 * maximises slot size for the body's live dimensions, clamped to `HOTBAR_MIN_SLOT..HOTBAR_MAX_SLOT`
 * — so a wide window is one row, a squarer one two rows, a tall thin one a column. Pure; the
 * component just feeds it the body's measured `clientWidth`/`clientHeight`.
 */
export function hotbarGrid(bodyW: number, bodyH: number): { cols: number; size: number } {
  const n = HOTBAR_SLOTS;
  const w = bodyW - 2 * HOTBAR_PAD;
  const h = bodyH - 2 * HOTBAR_PAD;
  // Prefer a column count whose slots reach HOTBAR_MIN_SLOT — one that doesn't would be clamped up
  // to the minimum and overflow the body (clipped slots). Only if none does (a window too small for
  // any reflow; `winLimits` keeps real windows out of that state) fall back to the least-bad one.
  const pick = (ok: (size: number) => boolean) => {
    let best = { size: 0, cols: 0 };
    for (let c = 1; c <= n; c++) {
      const rows = Math.ceil(n / c);
      const size = Math.min((w - (c - 1) * HOTBAR_GAP) / c, (h - (rows - 1) * HOTBAR_GAP) / rows);
      if (ok(size) && size > best.size + 0.5) best = { size, cols: c };
    }
    return best;
  };
  let best = pick(s => s >= HOTBAR_MIN_SLOT);
  if (best.cols === 0) best = pick(() => true);
  if (best.cols === 0) best = { size: 0, cols: n };
  return { cols: best.cols, size: Math.max(HOTBAR_MIN_SLOT, Math.min(HOTBAR_MAX_SLOT, Math.floor(best.size))) };
}
