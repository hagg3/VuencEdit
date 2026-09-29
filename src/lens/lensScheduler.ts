/**
 * Pure request scheduler for the paste lens (UI redesign r3, Stage 14.9) — "one request in flight,
 * latest wins" (CLAUDE.md §"Terrain Sculpt" `accumBusyRef` idiom) plus a parked-failed-key latch
 * (the `SliceViewport` `failedKeyRef` lesson: a persistently failing request must not re-fire in a
 * tight loop). Extracted as a reducer so the policy is unit-testable without timers, `invoke`, or a
 * DOM — `useLensRender.ts` is the only caller, and owns all the I/O.
 *
 * A "key" is an opaque string identifying one exact set of render inputs (ghost origin, elevation
 * offset, paste mode, clipboard identity, …) — see `keyOf` in `useLensRender.ts`. This module never
 * looks inside one.
 */

export interface LensSchedulerState {
  /** The key currently being fetched, or null. */
  inFlight: string | null;
  /** The most recent key requested while something was already in flight — replaces on every new
   *  request, so a burst collapses to at most one more fetch after the in-flight one resolves. */
  pending: string | null;
  /** A key whose fetch just failed. Requesting it again is a no-op until a *different* key arrives
   *  (or the failure is superseded by a later success — see `success`). */
  failedKey: string | null;
}

export const INITIAL_LENS_SCHEDULER_STATE: LensSchedulerState = { inFlight: null, pending: null, failedKey: null };

export type LensSchedulerEvent =
  | { type: "request"; key: string }
  | { type: "success"; key: string }
  | { type: "failure"; key: string };

export interface LensSchedulerResult {
  state: LensSchedulerState;
  /** A key the caller must start fetching right now, or null if nothing changed. */
  fire: string | null;
}

/**
 * - `request`: a new set of inputs arrived. Parked (no fire) if it's the key that just failed;
 *   fired immediately if nothing is in flight; otherwise coalesced into `pending` (replacing any
 *   earlier pending key — only the latest survives a burst).
 * - `success` / `failure`: the in-flight fetch settled. If a different key is `pending`, it fires
 *   next; a `pending` key equal to the key that just failed is dropped rather than immediately
 *   retried (it will fire the next time a `request` event names a distinct key).
 */
export function reduceLensScheduler(state: LensSchedulerState, event: LensSchedulerEvent): LensSchedulerResult {
  if (event.type === "request") {
    if (event.key === state.failedKey) return { state, fire: null };
    if (state.inFlight == null) return { state: { ...state, inFlight: event.key, pending: null }, fire: event.key };
    if (event.key === state.inFlight) return { state, fire: null };
    return { state: { ...state, pending: event.key }, fire: null };
  }
  const failedKey = event.type === "failure" ? event.key : state.failedKey;
  const { pending } = state;
  if (pending != null && pending !== failedKey) {
    return { state: { inFlight: pending, pending: null, failedKey }, fire: pending };
  }
  return { state: { inFlight: null, pending: null, failedKey }, fire: null };
}
