/**
 * Fixed dialog frame sizes (UI redesign r3, Stage 14.17, `Dialog`'s size classes). The frame is
 * derived from the size class and the viewport alone — **never from content** — which is the
 * structural fix for "Settings visibly grows and shrinks when you switch tabs" (the plan's item 2).
 *
 * `md`/`lg` are fixed-width *and* fixed-height — the body scrolls, the frame never resizes. `sm` is
 * fixed-width, content-height (single-purpose confirmations have no tabs to jump between, so there
 * is nothing that could make the frame move under the user).
 *
 * Pure, no DOM — unit-tested in `dialogSize.test.ts` the same way `ribbon/layout.ts` is.
 */

export type DialogSize = "sm" | "md" | "lg";

export const DIALOG_SIZES: Record<DialogSize, { w: number; h?: number }> = {
  sm: { w: 440 },
  md: { w: 760, h: 540 },
  lg: { w: 920, h: 600 },
};

/** Clamp margin on each axis — the frame never touches the viewport edge. */
const CLAMP_MARGIN = 48;

export interface DialogFrame {
  w: number;
  /** Absent for `sm` — its height follows its content, not a nominal class size. */
  h?: number;
}

/** `min(nominal, viewport − 48)` on each axis independently. Clamps down, never grows past nominal. */
export function dialogFrame(size: DialogSize, vw: number, vh: number): DialogFrame {
  const nominal = DIALOG_SIZES[size];
  const w = Math.max(0, Math.min(nominal.w, vw - CLAMP_MARGIN));
  if (nominal.h == null) return { w };
  const h = Math.max(0, Math.min(nominal.h, vh - CLAMP_MARGIN));
  return { w, h };
}
