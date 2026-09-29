/**
 * Fetches the paste lens's front + side elevations from `render_paste_lens` (UI redesign r3, Stage
 * 14.9). Policy (one request in flight / latest wins / a failed key stays parked) lives in the pure,
 * separately-tested `lensScheduler.ts` — this hook is just the I/O and the throttle around it.
 *
 * **Hover-driven origin churn is coalesced to ≤15 Hz** before it ever reaches the scheduler:
 * `MapCanvas`'s ghost subscription can fire far faster than that while the mouse moves over the map
 * (CLAUDE.md §"Copy/Paste System"). The same throttle covers every other input too (elevation
 * offset, mode flags, clipboard identity, `editEpoch`) — none of those change anywhere near 15 Hz in
 * practice, so a single throttle keeps this simple rather than special-casing origin changes.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { decodePasteLens, type PasteLensResult } from "../types";
import { reduceLensScheduler, type LensSchedulerState } from "./lensScheduler";

export type LensPasteMode = "normal" | "terrain";

export interface LensRenderInputs {
  /** Paste origin (top-left), in world coordinates — the same one `paste_at`/`paste_terrain` take. */
  origin: { x: number; y: number };
  elevationOffset: number;
  mode: LensPasteMode;
  ignoreAir: boolean;
  aboveSurface: boolean;
  /** Bumped by the caller whenever the clipboard's *content* changes (rotate/mirror/copy/new copy)
   *  — dimensions alone don't always change (mirror), so this can't be derived from width/height. */
  clipboardEpoch: number;
  editEpoch: number;
  context?: number;
  maxPx?: number;
}

export interface LensRenderState {
  front: PasteLensResult | null;
  side: PasteLensResult | null;
  loading: boolean;
  /** Set on the most recent failure; cleared on the next successful render. Shown as an inline
   *  message in the lens body instead of the elevations (the last-good images are dropped, not kept
   *  stale behind the message — nothing here promises they still match the current inputs). */
  error: string | null;
}

const IDLE: LensRenderState = { front: null, side: null, loading: false, error: null };
const IDLE_SCHEDULER: LensSchedulerState = { inFlight: null, pending: null, failedKey: null };
/** Hover-driven origin churn (and everything else) coalesces to this period — see the file header. */
const THROTTLE_MS = 66;

function keyOf(i: LensRenderInputs): string {
  return [
    i.origin.x, i.origin.y, i.elevationOffset, i.mode, i.ignoreAir ? 1 : 0, i.aboveSurface ? 1 : 0,
    i.clipboardEpoch, i.editEpoch, i.context ?? 2, i.maxPx ?? 512,
  ].join("|");
}

/**
 * `enabled` gates the whole hook (collapsed/closed lens, no paste armed, scatter/array mode — none
 * of those have a single footprint to render): while false, no request is ever in flight and the
 * result resets to idle, matching "no render requests while the lens isn't showing anything".
 */
export function useLensRender(inputs: LensRenderInputs, enabled: boolean): LensRenderState {
  const [state, setState] = useState<LensRenderState>(IDLE);
  const schedulerRef = useRef<LensSchedulerState>(IDLE_SCHEDULER);
  const pendingRef = useRef<LensRenderInputs | null>(null);
  const lastFireAtRef = useRef(0);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0); // discards a resolved fetch superseded by a later reset/disable

  async function startFetch(key: string, snap: LensRenderInputs) {
    const seq = ++seqRef.current;
    setState(s => ({ ...s, loading: true }));
    const params = {
      x: snap.origin.x, y: snap.origin.y,
      elevationOffset: snap.elevationOffset, mode: snap.mode,
      aboveSurface: snap.aboveSurface, ignoreAir: snap.ignoreAir,
      context: snap.context ?? 2, maxPx: snap.maxPx ?? 512,
    };
    try {
      const [frontBuf, sideBuf] = await Promise.all([
        invoke<ArrayBuffer>("render_paste_lens", { ...params, view: "front" }),
        invoke<ArrayBuffer>("render_paste_lens", { ...params, view: "side" }),
      ]);
      if (seqRef.current !== seq) return; // superseded by a disable/reset while in flight
      setState({ front: decodePasteLens(frontBuf), side: decodePasteLens(sideBuf), loading: false, error: null });
      applyEvent({ type: "success", key });
    } catch (e) {
      if (seqRef.current !== seq) return;
      const message = e instanceof Error ? e.message : String(e);
      setState({ front: null, side: null, loading: false, error: message });
      applyEvent({ type: "failure", key });
    }
  }

  function applyEvent(event: { type: "request" | "success" | "failure"; key: string }) {
    const { state: next, fire } = reduceLensScheduler(schedulerRef.current, event);
    schedulerRef.current = next;
    if (fire == null) return;
    const snap = pendingRef.current;
    if (snap && keyOf(snap) === fire) void startFetch(fire, snap);
  }

  const key = enabled ? keyOf(inputs) : null;

  useEffect(() => {
    if (key == null) {
      // No setState here — `key == null` is handled entirely by the render-time fallback below,
      // so disabling never itself triggers a render; this effect only tears down bookkeeping so a
      // later re-enable starts clean.
      seqRef.current++; // orphan any in-flight fetch
      schedulerRef.current = IDLE_SCHEDULER;
      pendingRef.current = null;
      if (throttleTimerRef.current) { clearTimeout(throttleTimerRef.current); throttleTimerRef.current = null; }
      return;
    }
    pendingRef.current = inputs;
    const request = () => {
      lastFireAtRef.current = Date.now();
      const snap = pendingRef.current;
      if (!snap) return;
      applyEvent({ type: "request", key: keyOf(snap) });
    };
    const elapsed = Date.now() - lastFireAtRef.current;
    if (elapsed >= THROTTLE_MS) {
      if (throttleTimerRef.current) { clearTimeout(throttleTimerRef.current); throttleTimerRef.current = null; }
      request();
    } else if (!throttleTimerRef.current) {
      throttleTimerRef.current = setTimeout(() => { throttleTimerRef.current = null; request(); }, THROTTLE_MS - elapsed);
    }
    // `key` is derived from every field `keyOf` reads (plus `enabled`); `inputs` itself is read
    // through `pendingRef` so the throttled call always sees the latest snapshot, not a stale one
    // captured when the timer was scheduled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Unmount: stop a straggling throttle timer and orphan any in-flight fetch's result.
  useEffect(() => () => {
    seqRef.current++;
    if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
  }, []);

  // `key == null` (disabled / nothing to render) always reports idle, regardless of whatever
  // `state` was left holding from before — see the effect above.
  return key == null ? IDLE : state;
}
