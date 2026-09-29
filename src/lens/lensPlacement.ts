/**
 * Pure geometry for the paste lens's attach-to-ghost placement (UI redesign r3, Stage 14.9).
 * No React, no DOM — same idiom as `windows/windowGeometry.ts`, unit-tested in node
 * (`lensPlacement.test.ts`). Behaviour reference: `TEST WORLDS/design-exploration-2026-09/js/mock.js`
 * `placeLens`.
 *
 * Coordinates are **work-area-local** px, the same space `windowGeometry.ts`'s `WinState`/`rectOf`
 * use — the caller (`PasteLensWindow.tsx`) is responsible for converting the ghost's screen
 * (viewport) rect into this space by subtracting the work area's own `getBoundingClientRect()`
 * origin before calling `attachPosition`.
 */

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }

/** Gap between the ghost's right edge and the lens when it sits to the right (mock: 16). */
export const LENS_GAP = 16;
/** The lens's top edge sits this far above the ghost's top edge (mock: `gy - 26`). */
export const LENS_TOP_OFFSET = 26;

/**
 * Where the attached lens sits beside the ghost: to the right of it, flipped to the left when the
 * right side would run past the work area, `y` a little above the ghost's top edge — then **fully**
 * clamped inside the work area (a deliberate strengthening of the mock's lower-bound-only clamp: a
 * ghost that has scrolled off-screen must never carry the lens off-screen with it — "clamps to the
 * nearest edge, never disappears").
 */
export function attachPosition(ghost: Rect, size: Size, work: Size): { x: number; y: number } {
  const maxX = Math.max(0, work.w - size.w);
  const maxY = Math.max(0, work.h - size.h);
  let x = ghost.x + ghost.w + LENS_GAP;
  if (x + size.w > work.w) x = ghost.x - size.w - LENS_GAP;
  const y = ghost.y - LENS_TOP_OFFSET;
  return {
    x: Math.round(Math.max(0, Math.min(maxX, x))),
    y: Math.round(Math.max(0, Math.min(maxY, y))),
  };
}

/**
 * Side-by-side (front | side) when the body is wider than it is tall, stacked (front over side)
 * otherwise — decided from a live `ResizeObserver` measurement of the body, not a CSS container
 * query (the windows framework already has one measurement mechanism; a second would just be a
 * second thing that can disagree with it). A square body ties to "stacked": the two panels are each
 * roughly as tall as a Z column typically runs, so a stacked square gives each one more headroom
 * than a side-by-side square would.
 */
export function bodyAspectLayout(w: number, h: number): "row" | "col" {
  return w > h ? "row" : "col";
}
