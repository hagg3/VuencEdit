/**
 * UI sound engine (UI redesign r3, Stage 14.12). WebAudio-synthesised, zero assets. One
 * `AudioContext`, created lazily on the first cue actually fired (always inside a user gesture —
 * a menu click, a keyboard shortcut, a completed drag — so WKWebView/WebView2 autoplay policies are
 * satisfied without ever needing a dedicated "enable audio" click). See CLAUDE.md §"UI Shell" for
 * the cue-call-site rules this module exists to enforce: fire on completions only, never on hover
 * or at pointer/stamp rate.
 *
 * Settings are a module-level store rather than React state — cues fire from plain event handlers
 * all over the app, not from rendered components, so there is nothing to subscribe to. `configure()`
 * is the one write path; App.tsx calls it from an effect mirroring `uiSounds`/`uiSoundPack`/
 * `uiSoundVolume` (the same "individual `useState(() => loadSettings()...)`" pattern every other
 * setting in App.tsx already uses — see `applySettings`).
 */
import { HOLD_MAX_GAIN, SOUND_PACKS, type CueId, type PackId, type Voice } from "./packs";

export interface SfxSettings {
  enabled: boolean;
  pack: PackId;
  volume: number;
}

let settings: SfxSettings = { enabled: true, pack: "classic", volume: 0.8 };

let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

/** Bumped every time an `AudioContext` is actually constructed. Test/debug-only — a GUI check
 *  ("off ⇒ no AudioContext created") has something concrete to assert against without reaching
 *  into module internals. Never read by production code paths. */
export const debugCounters = { contextsCreated: 0 };

type AudioContextCtor = typeof AudioContext;

function getContext(): AudioContext {
  if (!ctx) {
    const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) throw new Error("WebAudio unavailable");
    ctx = new Ctor();
    debugCounters.contextsCreated++;
    const n = Math.max(1, Math.floor(ctx.sampleRate * 0.3));
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Schedule one voice on the context clock at `st`; returns its source so a caller that may need to
 *  cancel it before it plays (the hold loop) can. `maxPeak` optionally caps the voice's gain. */
function emitVoice(a: AudioContext, voice: Voice, st: number, volume: number, maxPeak = Infinity): AudioScheduledSourceNode {
  const g = a.createGain();
  const peak = Math.min(voice.g, maxPeak) * volume;
  const attack = voice.a ?? Math.min(0.004, voice.d / 4);
  // Exponential ramps can't target exactly 0 (WebAudio throws) — the 0.0001/0.0002 floors mirror
  // the source mock's engine and are inaudible in practice, including at volume 0.
  g.gain.setValueAtTime(0.0001, st);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), st + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, st + voice.d);
  g.connect(a.destination);
  let src: AudioScheduledSourceNode;
  if (voice.w === "noise") {
    const bufSrc = a.createBufferSource();
    bufSrc.buffer = noiseBuf;
    const filt = a.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = voice.bp ?? 2000;
    filt.Q.value = voice.q ?? 1;
    bufSrc.connect(filt);
    filt.connect(g);
    src = bufSrc;
  } else {
    const osc = a.createOscillator();
    osc.type = voice.w;
    osc.frequency.setValueAtTime(voice.f, st);
    if (voice.f2) osc.frequency.exponentialRampToValueAtTime(voice.f2, st + voice.d);
    osc.connect(g);
    src = osc;
  }
  src.start(st);
  src.stop(st + voice.d + 0.02);
  return src;
}

function synth(pack: PackId, cue: CueId, volume: number) {
  const voices = SOUND_PACKS[pack]?.cues[cue];
  if (!voices || voices.length === 0) return;
  const a = getContext();
  const t0 = a.currentTime + 0.005;
  for (const voice of voices) emitVoice(a, voice, t0 + voice.t, volume);
}

/** Per-cue minimum interval (ms) — a belt-and-braces guard against an accidental pointer/stamp-rate
 *  call site slipping past code review; every legitimate call site fires far below this rate.
 *  Tracked **per cue id**, not globally — two different cues completing within the same 60ms
 *  (e.g. a "drag" immediately followed by a "menu" from an unrelated gesture) are unrelated events
 *  and must not silently steal each other's sound. */
const MIN_INTERVAL_MS = 60;
/** Cues that legitimately repeat faster than `MIN_INTERVAL_MS` (a held PgUp / wheel-scrub nudging a
 *  paste's Z offset), each with its own floor. */
const CUE_INTERVAL_MS: Partial<Record<CueId, number>> = { nudge: 40 };
const lastFireAt: Partial<Record<CueId, number>> = {};

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Updates the live settings store. Called from App.tsx whenever `uiSounds`/`uiSoundPack`/
 *  `uiSoundVolume` change (mirrors the settings-modal "apply on Save" pattern already used by every
 *  other App-level setting). */
export function configure(next: SfxSettings) {
  settings = next;
}

/** Fire a UI cue for a completed, user-initiated action. No-ops (and never touches `AudioContext`)
 *  while sound is off, the pack is `"none"`, or this same cue fired within the last
 *  `MIN_INTERVAL_MS` — so a disabled install truly creates zero `AudioContext`s. */
export function play(cue: CueId) {
  if (!settings.enabled || settings.pack === "none") return;
  const t = now();
  const last = lastFireAt[cue] ?? -Infinity;
  if (t - last < (CUE_INTERVAL_MS[cue] ?? MIN_INTERVAL_MS)) return;
  lastFireAt[cue] = t;
  synth(settings.pack, cue, settings.volume);
}

/** Handle for a running hold loop. `stop()` is idempotent. */
export interface HoldHandle {
  stop(): void;
}

const activeHolds = new Set<HoldHandle>();
const NOOP_HOLD: HoldHandle = { stop() {} };
/** How far ahead of the audio clock ticks are scheduled, and how often the schedule is topped up.
 *  Ticks ride the `AudioContext` clock, not `setInterval`, whose timing jitters. */
const HOLD_LOOKAHEAD_S = 0.1;
const HOLD_REFILL_MS = 25;
/** ±fraction applied to each tick's period. */
const HOLD_JITTER = 0.03;

/** Every event that must end a held gesture, whatever the call site forgot to do. Installed once,
 *  on the first real hold, on `window` in the capture phase so a `stopPropagation()` deeper in the
 *  tree can't swallow it. Escape is included for the cancel-by-key paths (selection drag, paste
 *  ghost); `blur`/`visibilitychange` cover alt-tabbing mid-drag, when no pointer-up ever arrives. */
const HOLD_END_EVENTS = ["pointerup", "pointercancel", "lostpointercapture", "blur", "visibilitychange"] as const;
let holdGuardInstalled = false;

function stopAllHolds() {
  for (const h of [...activeHolds]) h.stop();
}

function installHoldGuard() {
  if (holdGuardInstalled || typeof window === "undefined") return;
  holdGuardInstalled = true;
  for (const ev of HOLD_END_EVENTS) window.addEventListener(ev, stopAllHolds, true);
  window.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Escape") stopAllHolds(); }, true);
}

/** The tick loop itself, for `pack` at `volume`. Shared by `hold()` and `previewHold()`. */
function startHold(pack: PackId, volume: number): HoldHandle {
  const voice = SOUND_PACKS[pack]?.hold;
  if (!voice) return NOOP_HOLD;
  const a = getContext();
  installHoldGuard();
  let next = a.currentTime + 0.01;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Sources scheduled but possibly not yet started, so `stop()` can cancel the lookahead window.
  let pending: { src: AudioScheduledSourceNode; at: number }[] = [];
  const pump = () => {
    timer = null;
    if (stopped) return;
    const now = a.currentTime;
    pending = pending.filter(p => p.at > now);
    while (next < now + HOLD_LOOKAHEAD_S) {
      for (const vc of voice.voices) {
        pending.push({ src: emitVoice(a, vc, next + vc.t, volume, HOLD_MAX_GAIN), at: next + vc.t });
      }
      next += (voice.period / 1000) * (1 + (Math.random() * 2 - 1) * HOLD_JITTER);
    }
    timer = setTimeout(pump, HOLD_REFILL_MS);
  };
  pump();
  const handle: HoldHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      activeHolds.delete(handle);
      if (timer !== null) { clearTimeout(timer); timer = null; }
      // A tick already sounding rings out (it's ≤ ~30 ms); ones still queued ahead are cancelled.
      const now = a.currentTime;
      for (const p of pending) if (p.at > now) { try { p.src.stop(); } catch { /* already stopped */ } }
      pending = [];
    },
  };
  activeHolds.add(handle);
  return handle;
}

/** Begin a quiet tick loop for a gesture that is *still held* (window move/resize, selection
 *  drag, paste-ghost drag). Call once the pointer has moved past the drag threshold; call `stop()`
 *  on release (the last tick rings out). A global guard (`HOLD_END_EVENTS` + Escape) stops every
 *  live hold too, so a missed end path can never leave it ticking. No-ops (no `AudioContext`)
 *  while sound is off or the pack has no hold voice. */
export function hold(): HoldHandle {
  if (!settings.enabled || settings.pack === "none") return NOOP_HOLD;
  return startHold(settings.pack, settings.volume);
}

/** Settings ▸ Sounds' "Hold" audition: ticks for about a second with the given pack, bypassing the
 *  enabled gate like `preview` does. Stops itself, and the global hold guard stops it early too. */
export function previewHold(pack: PackId, volume: number, ms = 1000) {
  const h = startHold(pack, volume);
  if (h !== NOOP_HOLD) setTimeout(() => h.stop(), ms);
}

/** Test/debug-only: number of hold loops currently running. */
export function _activeHoldCount(): number {
  return activeHolds.size;
}

/** Settings ▸ Sounds' "choosing a pack plays a sample" audition. Deliberately bypasses the enabled
 *  gate and the min-interval throttle — matching the source mock's `force` parameter, "these play
 *  even with sounds off, because this is an audition" — but still honours the requested pack/volume
 *  (volume 0 previews silent, and picking "Off" plays nothing since that pack has no cues). */
export function preview(cue: CueId, pack: PackId, volume: number) {
  synth(pack, cue, volume);
}

/** Test-only: restores the module to its just-imported state (fresh settings, dropped context,
 *  zeroed counters). Vitest here is node-environment and never actually constructs an
 *  `AudioContext`, but this keeps the module usable by a future DOM-environment test file without
 *  cross-test leakage. */
export function _resetForTests() {
  settings = { enabled: true, pack: "classic", volume: 0.8 };
  ctx = null;
  noiseBuf = null;
  for (const k of Object.keys(lastFireAt)) delete lastFireAt[k as CueId];
  activeHolds.clear();
  debugCounters.contextsCreated = 0;
}

export const sfx = { play, hold, preview, previewHold, configure, debugCounters };
