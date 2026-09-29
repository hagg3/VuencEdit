/** Absolute bound on one press-and-hold gesture (3D build sweep, 3D sculpt hold-timer). If the
 *  webview never delivers the release (pointerup lost to an OS gesture, capture stolen by a host
 *  move), the gesture ends here rather than running forever. Pure so it's unit-testable — the
 *  scene closure in `FlyView3D.tsx` can't be imported under vitest's node environment. */
export const GESTURE_MAX_MS = 20_000;

/** True once a gesture that began at `startT` has outlived `maxMs` at `now` (both `performance.now()`). */
export const gestureTimedOut = (startT: number, now: number, maxMs: number = GESTURE_MAX_MS): boolean =>
  now - startT > maxMs;
