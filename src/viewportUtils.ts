// Shared plumbing for the canvas-imperative viewport panes (MapCanvas, SliceViewport):
// pan/zoom math, canvas-to-container sizing, async-fetch staleness guards, and pixel-patch
// decoding. Pure functions only — both callers manage their own refs/draw loops, so a shared
// hook would just relocate state without removing duplication. See CLAUDE.md M4.

import { decodeU8 } from "./codec";
import type { PixelPatchRaw } from "./types";

export interface ViewTransform { x: number; y: number; scale: number; }

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
  const f = deltaY < 0 ? opts.factor : 1 / opts.factor;
  const newScale = Math.max(opts.min, Math.min(opts.max, view.scale * f));
  return {
    scale: newScale,
    x: localX - (localX - view.x) * (newScale / view.scale),
    y: localY - (localY - view.y) * (newScale / view.scale),
  };
}

/**
 * Sizes a canvas's backing store to match its laid-out CSS box (not the window), so it works
 * both full-screen and inside a quad-view grid cell. Returns whether the size actually changed.
 */
export function resizeCanvasToContainer(canvas: HTMLCanvasElement): boolean {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
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
