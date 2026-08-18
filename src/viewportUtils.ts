// Shared plumbing for the canvas-imperative viewport panes (MapCanvas, SliceViewport):
// pan/zoom math, canvas-to-container sizing, async-fetch staleness guards, and pixel-patch
// decoding. Pure functions only — both callers manage their own refs/draw loops, so a shared
// hook would just relocate state without removing duplication. See CLAUDE.md M4.


export interface ViewTransform { x: number; y: number; scale: number; }

/** Blocks per chunk edge (both X and Y) — every chunk is a 16×16 column of blocks. */
export const CHUNK_SIZE_BLOCKS = 16;

/**
 * Fetch window along a slab's horizontal world axis (`SliceViewport`'s front/side panes).
 * Two modes, chosen by whether `selRange` is set:
 *  - Selection-scoped: the window covers the selection + 50% context each side, capped at `maxWin`
 *    and re-centred on the selection's midpoint when the natural span would exceed it (so a huge
 *    selection still gets a bounded, centred fetch instead of either an unbounded one or a window
 *    pinned to one edge).
 *  - Free-scroll: a `maxWin`-wide window clamped to `[0, planeW - freeWinW]`, anchored at `winOrigin`.
 * Always returns `hi >= lo` inside `[0, planeW - 1]` (or `{lo:0,hi:0}` when `planeW <= 0`).
 */
export function slabFetchWindow(args: {
  planeW: number;
  selRange: { lo: number; hi: number } | null;
  winOrigin: number;
  maxWin: number;
}): { lo: number; hi: number } {
  const { planeW, selRange, winOrigin, maxWin } = args;
  if (planeW <= 0) return { lo: 0, hi: 0 };
  const pMax = planeW - 1;
  if (selRange) {
    const lo0 = Math.max(0, Math.min(pMax, Math.min(selRange.lo, selRange.hi)));
    const hi0 = Math.max(0, Math.min(pMax, Math.max(selRange.lo, selRange.hi)));
    const ctxCols = Math.max(1, Math.round((hi0 - lo0 + 1) * 0.5));
    let lo = Math.max(0, lo0 - ctxCols);
    let hi = Math.min(pMax, hi0 + ctxCols);
    if (hi - lo + 1 > maxWin) {
      const mid = Math.round((lo0 + hi0) / 2);
      hi = Math.min(pMax, mid + Math.floor(maxWin / 2));
      lo = Math.max(0, hi - maxWin + 1);
      hi = Math.min(pMax, lo + maxWin - 1);
    }
    return { lo, hi: Math.max(lo, hi) };
  }
  const freeWinW = Math.min(planeW, maxWin);
  const lo = Math.max(0, Math.min(planeW - freeWinW, winOrigin));
  const hi = lo + freeWinW - 1;
  return { lo, hi };
}

/** World-block coordinate → the chunk coordinate that contains it. */
export function worldToChunk(wCoord: number): number {
  return Math.floor(wCoord / CHUNK_SIZE_BLOCKS);
}

/** Chunk coordinate → the world-block coordinate of its origin corner. */
export function chunkToWorld(cCoord: number): number {
  return cCoord * CHUNK_SIZE_BLOCKS;
}

/**
 * Zoom a pan/zoom view transform around a local (canvas-space) point — the "zoom toward
 * cursor" formula shared by MapCanvas's and SliceViewport's wheel handlers.
 */
export function zoomAtPoint(
  view: ViewTransform,
  localX: number,
  localY: number,
  deltaY: number,
  opts: { min: number; max: number; factor: number },
): ViewTransform {
  // Scale the zoom step by wheel delta magnitude — a fast wheel flick or big trackpad swipe should
  // zoom further per event than a slow single notch, instead of the old fixed step regardless of
  // deltaY. `factor` is calibrated as the zoom multiplier at a typical one-notch deltaY (~100),
  // clamped so one event can't blow past a reasonable range (fast flicks, big trackpad deltas).
  const k = Math.log(opts.factor) / 100;
  const rawF = Math.exp(-deltaY * k);
  const f = Math.max(1 / (opts.factor * 3), Math.min(opts.factor * 3, rawF));
  const newScale = Math.max(opts.min, Math.min(opts.max, view.scale * f));
  return {
    scale: newScale,
    x: localX - (localX - view.x) * (newScale / view.scale),
    y: localY - (localY - view.y) * (newScale / view.scale),
  };
}

/**
 * HiDPI: the backing store of every 2D pane is sized `cssPx × dpr` so lines, selection outlines
 * and in-canvas text are crisp on Retina instead of being drawn at 1× and upscaled. Capped at 2
 * for the same reason FlyView3D caps its own DPR — past that, the fill cost grows quadratically
 * for no visible gain.
 *
 * Drawing code stays in CSS pixels: `beginFrame()` installs the dpr scale as the base transform,
 * and `cssWidth`/`cssHeight` give the CSS-px size of the canvas (never read `canvas.width`
 * directly for layout math — that's device pixels).
 */
export const MAX_CANVAS_DPR = 2;

/** dpr the canvas's backing store was actually sized with (may lag window.devicePixelRatio
 *  by one resize when a window is dragged between displays — `resizeCanvasToContainer` fixes it up). */
const canvasDprs = new WeakMap<HTMLCanvasElement, number>();

function targetDpr(): number {
  return Math.min(Math.max(1, window.devicePixelRatio || 1), MAX_CANVAS_DPR);
}

export function canvasDpr(canvas: HTMLCanvasElement): number {
  return canvasDprs.get(canvas) ?? 1;
}

/** CSS-pixel width of a canvas sized by `resizeCanvasToContainer`. */
export function cssWidth(canvas: HTMLCanvasElement): number {
  return canvas.width / canvasDpr(canvas);
}

/** CSS-pixel height of a canvas sized by `resizeCanvasToContainer`. */
export function cssHeight(canvas: HTMLCanvasElement): number {
  return canvas.height / canvasDpr(canvas);
}

/**
 * Resets a context to the base HiDPI transform and returns the canvas's CSS-pixel size. Call once
 * at the top of `draw()`; everything after it draws in CSS pixels as before.
 */
export function beginFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
): { w: number; h: number } {
  const dpr = canvasDpr(canvas);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: canvas.width / dpr, h: canvas.height / dpr };
}

/**
 * Sizes a canvas's backing store to match its laid-out CSS box (not the window), so it works
 * both full-screen and inside a quad-view grid cell, scaled by the device pixel ratio. Returns
 * whether the size actually changed. The element's CSS box is left to the layout (100%/flex) —
 * only the backing store is touched.
 */
export function resizeCanvasToContainer(canvas: HTMLCanvasElement): boolean {
  const r = canvas.getBoundingClientRect();
  const dpr = targetDpr();
  const w = Math.max(1, Math.round(Math.floor(r.width) * dpr));
  const h = Math.max(1, Math.round(Math.floor(r.height) * dpr));
  if (canvas.width !== w || canvas.height !== h || canvasDprs.get(canvas) !== dpr) {
    canvas.width = w;
    canvas.height = h;
    canvasDprs.set(canvas, dpr);
    return true;
  }
  return false;
}

/**
 * A monotonically-increasing sequence number for discarding stale async results (view/edit
 * races). Two usage shapes, both supported:
 *  - "increment-on-start": `const seq = guard.next(); ...await...; if (guard.isStale(seq)) return;`
 *    (each new fetch supersedes any earlier one of the same kind)
 *  - "peek-then-invalidate": `const seq = guard.peek(); ...await...; if (guard.isStale(seq)) return;`
 *    with `guard.next()` called elsewhere at cache-invalidation points (a shared epoch that
 *    several concurrent fetches can be validated against).
 */
export function makeSeqGuard() {
  let current = 0;
  return {
    peek: () => current,
    next: () => ++current,
    isStale: (seq: number) => seq !== current,
  };
}

/** Blits a decoded pixel buffer onto a 2D context at (dx, dy). `pixels` is a view over the raw IPC
 *  response bytes (audit H2); re-viewing it as `Uint8ClampedArray` keeps it a view, so the whole
 *  path from the webview's response buffer to `putImageData` is copy-free. */
export function putPatchPixels(
  ctx: CanvasRenderingContext2D,
  patch: { width: number; height: number; pixels: Uint8Array },
  dx = 0, dy = 0,
): void {
  const clamped = new Uint8ClampedArray(patch.pixels.buffer, patch.pixels.byteOffset, patch.pixels.byteLength);
  ctx.putImageData(new ImageData(clamped, patch.width, patch.height), dx, dy);
}

// ── Frontend robustness guards (256z-format plan, Phase 6 — defense in depth) ─────────────────
// Both caps below exist so a corrupt/garbage world (the `quarry.eden` bug's exact failure mode —
// bogus directory rows producing billions-scale chunk dimensions) degrades to "warn and stop"
// instead of an OOM/RangeError crash, even after Phase 1's coordinate gate closes the known cause.
// Sized so no real world changes behaviour — the biggest real world is ~451×528 chunks.

/** Divisions for `FlyView3D`'s ground-plane `THREE.GridHelper`, capped so a bogus/huge chunk
 *  dimension (e.g. quarry.eden's pre-fix 1.95e9) can't make Three.js build a two-array grid with
 *  billions of elements. `wChunks`/`hChunks` are chunk-grid dimensions, not block counts. */
export function gridDivisions(wChunks: number, hChunks: number): number {
  const n = Math.max(wChunks, hChunks);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2048, Math.max(1, Math.round(n)));
}

/** True if the tile window `[tx0,tx1] × [ty0,ty1]` (inclusive tile-grid coordinates) is small
 *  enough to enumerate and fetch. Guards `MapCanvas`'s tile-fetch loop against the same failure
 *  mode as `gridDivisions`: a corrupt world's fit-scale can otherwise enumerate millions of tile
 *  keys and build a matching `jobs` array before anything renders. Real worlds need ~42–56 tiles
 *  on a 4K viewport, so 4096 is roughly 40× headroom. */
export function tileWindowFits(tx0: number, ty0: number, tx1: number, ty1: number): boolean {
  if (![tx0, ty0, tx1, ty1].every(Number.isFinite)) return false;
  const nx = tx1 - tx0 + 1;
  const ny = ty1 - ty0 + 1;
  if (nx <= 0 || ny <= 0) return false;
  return nx * ny <= 4096;
}

// ── keyboard-target guard ─────────────────────────────────────────────────────
// A bare-key shortcut (P/B/S/Space/Escape/…) must not fire while the user is typing. Testing
// `tagName === "INPUT"` alone is wrong: it also matches the range/checkbox controls in the Ribbon
// and the 3D pane, which keep focus after a drag — touch a slider and every bare-key shortcut goes
// dead until something else is clicked. Only *text-entry* targets suppress shortcuts.
const NON_TEXT_INPUT_TYPES = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"]);
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "TEXTAREA" || el?.isContentEditable === true ||
    (tag === "INPUT" && !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type));
}
