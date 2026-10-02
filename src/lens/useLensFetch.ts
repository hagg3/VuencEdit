/**
 * The Lens's fetch loop (Stage 20.4), shared by both modes: a throttle in front of the pure
 * `lensScheduler.ts` (one request in flight, latest wins, a failed key stays parked). The callers
 * own the I/O: `useLensRender` (paste, 66 ms: hover churn) and `useSelectionLens` (selection,
 * 150 ms: edits and selection commits).
 *
 * `key` identifies one exact set of inputs; `null` disables the hook (nothing in flight, idle
 * result). `fetch` is read from the render that produced `key`, through a ref, so a throttled fire
 * always runs the latest closure.
 */
import { useEffect, useRef, useState } from "react";
import { reduceLensScheduler, type LensSchedulerState } from "./lensScheduler";

export interface LensFetchState<T> {
  data: T | null;
  loading: boolean;
  /** Set on the most recent failure, cleared on the next success. The last good data is dropped,
   *  not kept stale behind the message. */
  error: string | null;
}

/** Shared so a disabled hook returns the same object every render. */
const IDLE: LensFetchState<never> = { data: null, loading: false, error: null };
const IDLE_SCHEDULER: LensSchedulerState = { inFlight: null, pending: null, failedKey: null };

export function useLensFetch<T>(key: string | null, fetch: () => Promise<T>, throttleMs: number): LensFetchState<T> {
  const [state, setState] = useState<LensFetchState<T>>({ data: null, loading: false, error: null });
  const schedulerRef = useRef<LensSchedulerState>(IDLE_SCHEDULER);
  const pendingRef = useRef<{ key: string; fetch: () => Promise<T> } | null>(null);
  const lastFireAtRef = useRef(0);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0); // discards a resolved fetch superseded by a later reset/disable
  const aliveRef = useRef(true); // false only between a real unmount and nothing (StrictMode re-mounts)

  async function startFetch(key: string, run: () => Promise<T>) {
    const seq = ++seqRef.current;
    setState(s => ({ ...s, loading: true }));
    try {
      const data = await run();
      if (seqRef.current !== seq || !aliveRef.current) return; // superseded, or unmounted
      setState({ data, loading: false, error: null });
      applyEvent({ type: "success", key });
    } catch (e) {
      if (seqRef.current !== seq || !aliveRef.current) return;
      setState({ data: null, loading: false, error: e instanceof Error ? e.message : String(e) });
      applyEvent({ type: "failure", key });
    }
  }

  function applyEvent(event: { type: "request" | "success" | "failure"; key: string }) {
    const { state: next, fire } = reduceLensScheduler(schedulerRef.current, event);
    schedulerRef.current = next;
    if (fire == null) return;
    const snap = pendingRef.current;
    if (snap && snap.key === fire) void startFetch(fire, snap.fetch);
  }

  useEffect(() => {
    if (key == null) {
      // No setState: the render-time fallback below reports idle, so disabling never itself costs a
      // render. This only tears down bookkeeping so a re-enable starts clean.
      seqRef.current++; // orphan any in-flight fetch
      schedulerRef.current = IDLE_SCHEDULER;
      pendingRef.current = null;
      if (throttleTimerRef.current) { clearTimeout(throttleTimerRef.current); throttleTimerRef.current = null; }
      return;
    }
    pendingRef.current = { key, fetch };
    const request = () => {
      lastFireAtRef.current = Date.now();
      const snap = pendingRef.current;
      if (snap) applyEvent({ type: "request", key: snap.key });
    };
    const elapsed = Date.now() - lastFireAtRef.current;
    if (elapsed >= throttleMs) {
      if (throttleTimerRef.current) { clearTimeout(throttleTimerRef.current); throttleTimerRef.current = null; }
      request();
    } else if (!throttleTimerRef.current) {
      throttleTimerRef.current = setTimeout(() => { throttleTimerRef.current = null; request(); }, throttleMs - elapsed);
    }
    // `key` names every input `fetch` reads; `fetch` itself is captured into `pendingRef` here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Unmount: stop a straggling throttle timer and drop any in-flight fetch's result. Liveness is a
  // flag set by the effect (not a `seqRef` bump in the cleanup): StrictMode runs this cleanup right
  // after the first mount, and bumping `seqRef` there orphaned the first fetch of a hook that mounts
  // with a live key, leaving the scheduler's `inFlight` set forever (selection lens: blank image).
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (throttleTimerRef.current) { clearTimeout(throttleTimerRef.current); throttleTimerRef.current = null; }
    };
  }, []);

  return key == null ? IDLE : state;
}

