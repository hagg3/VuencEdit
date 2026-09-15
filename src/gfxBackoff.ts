/**
 * WebGL context-loss back-off (Stage 10.1, hypothesis H2).
 *
 * The 3D pane's restore path used to re-stream *the same disc, at the same render distance, under
 * the same geometry budget that had just exhausted the GPU* — so a memory-driven context loss
 * deterministically reproduced the condition that caused it. Chromium counts losses per GPU
 * process; after a few it kills the process, and after a few of those it disables hardware
 * acceleration permanently, which is a clean mechanism for a user reporting the crash happening
 * "again" and for software rendering (H1) becoming true as a *consequence*.
 *
 * The arithmetic lives here, away from `FlyView3D.tsx`, purely so it is unit-testable: vitest in
 * this app is node-environment and `*.test.ts`-only, so nothing that imports three.js/React can be
 * covered (same reason `maskUtils.ts` and `ribbon/layout.ts` are their own modules).
 *
 * ⚠️ The back-off changes *what* the pane reloads after a restore, never *whether* it reloads.
 * `releaseOnUpload` nulls every chunk attribute's CPU copy on upload, so geometry is unrecoverable
 * after a loss and `onContextRestored` **must** still call `reloadAllChunks()` — the two are
 * load-bearing on each other (see CLAUDE.md, "Resident-memory + context-loss handling").
 */

/** Losses to recover from before the pane gives up and disables itself for the session. */
export const MAX_CONTEXT_LOSSES = 3;

/** Floor the halved geometry budget can never go below. Below roughly this, a single dense 256z
 *  chunk plus one in-flight reservation would be enough to peg the gate, which is a stall rather
 *  than a degradation. */
export const BACKOFF_MIN_BUDGET_BYTES = 64 << 20;

/**
 * Effective geometry budget after `losses` recovered context losses: the configured budget halved
 * once per loss.
 *
 * Floored at `BACKOFF_MIN_BUDGET_BYTES` — but never *above* the configured budget, so a user who
 * has deliberately picked a preset smaller than the floor keeps their own (smaller) number rather
 * than having the back-off raise it.
 */
export function backoffBudget(budgetBytes: number, losses: number): number {
  const floor = Math.min(budgetBytes, BACKOFF_MIN_BUDGET_BYTES);
  if (losses <= 0) return budgetBytes;
  return Math.max(floor, Math.floor(budgetBytes / 2 ** losses));
}

/**
 * Render distance (chunk radius) to fall back to after one context loss.
 *
 * Resident geometry scales with the *area* of the loaded disc (∝ r²), so dividing the radius by
 * √2 is the radius-space equivalent of `backoffBudget`'s halving — the two degrade in step instead
 * of one of them doing all the work. Never below `rdMin` (the pane's own slider floor: going under
 * it breaks `radiusToPos`'s quadratic remap).
 */
export function backoffRadius(radius: number, rdMin: number): number {
  return Math.max(rdMin, Math.floor(radius / Math.SQRT2));
}
