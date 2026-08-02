// Shared plumbing for the canvas-imperative viewport panes (MapCanvas, SliceViewport):
// pan/zoom math, canvas-to-container sizing, async-fetch staleness guards, and pixel-patch
// decoding. Pure functions only — both callers manage their own refs/draw loops, so a shared
// hook would just relocate state without removing duplication. See CLAUDE.md M4.

import { decodeU8 } from "./codec";
import type { PixelPatchRaw } from "./types";

export interface ViewTransform { x: number; y: number; scale: number; }

/** Blocks per chunk edge (both X and Y) — every chunk is a 16×16 column of blocks. */
export const CHUNK_SIZE_BLOCKS = 16;

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

/** Decodes a base64 pixel patch and blits it onto a 2D context at (dx, dy). */
export function putPatchPixels(ctx: CanvasRenderingContext2D, raw: PixelPatchRaw, dx = 0, dy = 0): void {
  const pixels = decodeU8(raw.pixels);
  const img = new ImageData(new Uint8ClampedArray(pixels), raw.width, raw.height);
  ctx.putImageData(img, dx, dy);
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
