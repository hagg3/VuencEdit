/**
 * Trackpad and mouse-wheel input for the 2D panes (34.7): the map (`MapCanvas`) and the Lens
 * (`lens/LensView`). The 3D pane keeps its own wheel (fly speed / orbit zoom).
 *
 * The aim is the macOS convention on every machine with a real trackpad, Windows precision
 * touchpads included: **two-finger scroll pans, pinch zooms under the fingers, and ⌘/Ctrl-scroll
 * zooms**. A notched mouse wheel keeps zooming, as before. The `wheelMode` setting
 * (Settings ▸ Editor) overrides the automatic choice for devices the heuristic misreads.
 *
 * How the inputs arrive:
 * - **Two-finger scroll** is a stream of `wheel` events, momentum included. A trackpad sends small
 *   or fractional deltas and often both axes; a notched wheel sends `wheelDeltaY` in multiples of
 *   120 with `deltaX = 0` (WebKit and Chromium both keep that legacy field). `wheelEvidence` reads
 *   one event; `nextDevice` makes the call once per gesture (events closer than `GESTURE_GAP_MS`) so
 *   a gesture never switches device halfway, except that a "mouse" gesture that moves sideways is
 *   corrected to a trackpad.
 * - **Pinch** arrives as a `wheel` event with `ctrlKey` set (Chromium/WebView2 always, encoding the
 *   step as `deltaY = −100·ln(scale)`, so `PINCH_GAIN = 0.01` follows the fingers 1:1). WebKit may
 *   instead send `gesturestart/change/end` with a cumulative `scale`. `attachWheelGestures` handles
 *   both and drops Ctrl-wheel while a WebKit gesture is live so one pinch never zooms twice.
 *   On Windows, pinch only reaches the page because `enable_touchpad_pinch` (lib.rs) turns
 *   WebView2's pinch back on; `installPinchGuard` then stops it page-zooming the rest of the UI.
 *
 * The pure parts (`wheelEvidence`, `nextDevice`, `wheelAction`) are unit-tested in `wheel.test.ts`.
 */

export type WheelMode = "auto" | "pan" | "zoom";
export type WheelDevice = "trackpad" | "mouse";

/** Zoom per unit of pinch `deltaY`: `scale × e^(−deltaY · PINCH_GAIN)`. 1:1 with the fingers. */
export const PINCH_GAIN = 0.01;
/** Zoom per unit of ⌘/Ctrl-free trackpad *scroll* that zooms ("Always zooms", or ⌘-scroll on a Mac).
 *  Scroll deltas are much larger than pinch deltas, so this is gentler: a 300 px swipe ≈ 2.9×. */
export const SCROLL_ZOOM_GAIN = 0.0035;
/** Per-event zoom clamp for trackpad input (a momentum flick can deliver one huge delta). */
const TRACKPAD_STEP_MAX = 2;
/** One mouse-wheel notch, in CSS px (Chromium; WebKit sends less, the zoom scales with it). */
export const MOUSE_NOTCH_PX = 100;
/** Wheel events closer than this belong to one gesture (trackpad momentum included). */
export const GESTURE_GAP_MS = 300;
/** `deltaMode` line → CSS px (the CSS default line height Chromium and WebKit both assume). */
const LINE_PX = 16;

/** The `WheelEvent` fields this module reads, so the logic is testable without a DOM. */
export interface WheelSample {
  deltaX: number;
  deltaY: number;
  /** 0 pixel · 1 line · 2 page. WebKit and WebView2 always send 0; honoured anyway. */
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** Non-standard, but present in WebKit and Chromium: the legacy ±120-per-notch value. */
  wheelDeltaY?: number;
}

/** What one wheel event says about the device: "mouse"/"trackpad" are firm, "unsure" isn't. */
export type WheelEvidence = "mouse" | "trackpad" | "unsure";

export function wheelEvidence(e: WheelSample): WheelEvidence {
  if (e.deltaMode !== 0) return "mouse";
  // A wheel has one axis; Shift+wheel is the only way it moves sideways (WebKit rewrites it to deltaX).
  if (e.deltaX !== 0 && !e.shiftKey) return "trackpad";
  const w = e.wheelDeltaY;
  if (w != null && w !== 0 && w % 120 === 0) return "mouse";
  return "unsure";
}

/** Per-gesture device state, owned by each pane's listener. */
export interface DeviceState { device: WheelDevice; lastTime: number }

export function initialDeviceState(): DeviceState {
  return { device: "mouse", lastTime: -Infinity };
}

/**
 * The device for this event. A new gesture (gap > `GESTURE_GAP_MS`) is decided by its first event:
 * a notch-shaped event says mouse, anything else trackpad (a gesture starts with small, un-notched
 * deltas). Within a gesture only one correction is allowed: mouse → trackpad on a firm sign of a
 * trackpad (sideways movement). Never trackpad → mouse: momentum tails can look like anything.
 */
export function nextDevice(prev: DeviceState, e: WheelSample, time: number): DeviceState {
  const ev = wheelEvidence(e);
  if (time - prev.lastTime > GESTURE_GAP_MS) {
    return { device: ev === "mouse" ? "mouse" : "trackpad", lastTime: time };
  }
  const device = prev.device === "mouse" && ev === "trackpad" ? "trackpad" : prev.device;
  return { device, lastTime: time };
}

export type WheelAction =
  /** Add `dx`/`dy` (CSS px) to the view offset: content follows the fingers. */
  | { kind: "pan"; dx: number; dy: number }
  /** Multiply the scale by `factor`, anchored under the pointer. */
  | { kind: "zoom"; factor: number };

/** CSS-px deltas, honouring `deltaMode`. `pageH` is the viewport height for page mode. */
export function deltaPx(e: WheelSample, pageH: number): { x: number; y: number } {
  const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? pageH : 1;
  return { x: e.deltaX * k, y: e.deltaY * k };
}

/**
 * What a wheel event does to a 2D pane.
 *
 * Zooms when: Ctrl is held (a pinch, or Ctrl+wheel, Windows's zoom chord), ⌘ is held on a Mac,
 * the mode is "zoom", or the mode is "auto" and the device is a mouse. Otherwise pans.
 * `mouseNotchFactor` is the pane's zoom per mouse notch (1.1 on the map, the Lens's `ZOOM_STEP`).
 */
export function wheelAction(
  e: WheelSample, device: WheelDevice, mode: WheelMode, mac: boolean,
  opts: { pageH: number; mouseNotchFactor: number },
): WheelAction {
  const d = deltaPx(e, opts.pageH);
  const zoom = e.ctrlKey || (mac && e.metaKey) || mode === "zoom" || (mode === "auto" && device === "mouse");
  if (zoom) {
    if (device === "trackpad") {
      const gain = e.ctrlKey ? PINCH_GAIN : SCROLL_ZOOM_GAIN;
      const f = Math.exp(-d.y * gain);
      return { kind: "zoom", factor: clamp(f, 1 / TRACKPAD_STEP_MAX, TRACKPAD_STEP_MAX) };
    }
    // Mouse: the pre-34.7 map formula — `mouseNotchFactor` per notch, a fast flick zooms further,
    // clamped to three notches per event.
    const n = opts.mouseNotchFactor;
    const f = Math.exp(-d.y * Math.log(n) / MOUSE_NOTCH_PX);
    return { kind: "zoom", factor: clamp(f, 1 / (n * 3), n * 3) };
  }
  // Shift+wheel pans sideways. WebKit already moved it to deltaX; Chromium on Windows hasn't.
  if (e.shiftKey && d.x === 0) return { kind: "pan", dx: -d.y, dy: 0 };
  return { kind: "pan", dx: -d.x, dy: -d.y };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Live preference ─────────────────────────────────────────────────────────────────────────────
//
// An input-device preference read at event time by every 2D pane, so it lives here rather than
// being threaded through each window's props. App writes it from `AppSettings.wheelMode`.

let liveMode: WheelMode = "auto";

export function setWheelMode(mode: WheelMode): void {
  liveMode = mode === "pan" || mode === "zoom" ? mode : "auto";
}

export function getWheelMode(): WheelMode {
  return liveMode;
}

// ── DOM wiring ──────────────────────────────────────────────────────────────────────────────────

/** WebKit's non-standard pinch event (macOS Safari / WKWebView). */
interface GestureLike extends UIEvent { scale: number; clientX: number; clientY: number }

export interface WheelGestureHandlers {
  /** Pan by CSS px. */
  pan(dx: number, dy: number): void;
  /** Zoom by `factor`, anchored at the client point. */
  zoom(factor: number, clientX: number, clientY: number): void;
  /** Zoom per mouse notch for this pane. */
  mouseNotchFactor: number;
  /** Return false to let the event through untouched (e.g. the Lens with nothing to show). */
  enabled?(): boolean;
}

/**
 * Wire wheel + pinch input to `el`. Returns a detach function. The listeners are non-passive so
 * `preventDefault` really stops the webview scrolling or page-zooming underneath (React's synthetic
 * `onWheel` is passive).
 */
export function attachWheelGestures(el: HTMLElement, mac: boolean, h: WheelGestureHandlers): () => void {
  let state = initialDeviceState();
  // Cumulative scale of a live WebKit pinch, or null when none is in progress.
  let gestureScale: number | null = null;

  const onWheel = (e: WheelEvent) => {
    if (h.enabled && !h.enabled()) return;
    e.preventDefault();
    if (gestureScale != null && e.ctrlKey) return; // the gesture events below carry this pinch
    const sample = e as WheelEvent & { wheelDeltaY?: number };
    state = nextDevice(state, sample, e.timeStamp);
    const a = wheelAction(sample, state.device, liveMode, mac, {
      pageH: el.clientHeight || 800,
      mouseNotchFactor: h.mouseNotchFactor,
    });
    if (a.kind === "pan") { if (a.dx !== 0 || a.dy !== 0) h.pan(a.dx, a.dy); }
    else if (a.factor !== 1) h.zoom(a.factor, e.clientX, e.clientY);
  };

  const onGestureStart = (e: Event) => {
    if (h.enabled && !h.enabled()) return;
    e.preventDefault();
    gestureScale = (e as GestureLike).scale || 1;
  };
  const onGestureChange = (e: Event) => {
    if (gestureScale == null) return;
    e.preventDefault();
    const g = e as GestureLike;
    const next = g.scale || 1;
    const factor = next / gestureScale;
    gestureScale = next;
    if (factor !== 1 && Number.isFinite(factor)) h.zoom(clamp(factor, 1 / TRACKPAD_STEP_MAX, TRACKPAD_STEP_MAX), g.clientX, g.clientY);
  };
  const onGestureEnd = (e: Event) => {
    if (gestureScale == null) return;
    e.preventDefault();
    gestureScale = null;
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("gesturestart", onGestureStart, { passive: false });
  el.addEventListener("gesturechange", onGestureChange, { passive: false });
  el.addEventListener("gestureend", onGestureEnd, { passive: false });
  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("gesturestart", onGestureStart);
    el.removeEventListener("gesturechange", onGestureChange);
    el.removeEventListener("gestureend", onGestureEnd);
  };
}

/**
 * Windows only: with WebView2 pinch re-enabled (`enable_touchpad_pinch`), a pinch anywhere the
 * panes don't claim it would page-zoom the whole UI. Cancel every Ctrl-wheel that reaches the
 * window; the panes' own listeners run first (target phase) and still see it. Not needed on a Mac:
 * WKWebView has magnification off. Idempotent.
 */
let pinchGuardInstalled = false;
export function installPinchGuard(): void {
  if (pinchGuardInstalled || typeof window === "undefined") return;
  pinchGuardInstalled = true;
  window.addEventListener("wheel", e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
}
