import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MAX_GAIN, SOUND_PACKS, CUE_IDS } from "./packs";

/** Minimal WebAudio + `window` fakes — vitest here is node-environment. Every node records the calls
 *  the engine makes so a test can assert a hold's source was actually `stop()`ped. */
class FakeParam {
  value = 0;
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  cancelScheduledValues() { return this; }
}
const sources: { stop: ReturnType<typeof vi.fn>; loop?: boolean }[] = [];
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  type = "";
  loop = false;
  buffer: unknown = null;
  stop = vi.fn();
  start = vi.fn();
  connect() { return this; }
}
/** The fake audio clock, shared so a test can advance it. */
const clock = { t: 0 };
class FakeAudioContext {
  get currentTime() { return clock.t; }
  sampleRate = 8000;
  state = "running";
  destination = {};
  resume() { return Promise.resolve(); }
  createBuffer(_c: number, n: number) { return { getChannelData: () => new Float32Array(n) }; }
  createGain() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createOscillator() { const n = new FakeNode(); sources.push(n); return n; }
  createBufferSource() { const n = new FakeNode(); sources.push(n); return n; }
}

/** A tiny EventTarget standing in for `window`, capture flag ignored (dispatch reaches everything). */
class FakeWindow {
  AudioContext = FakeAudioContext;
  private handlers = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(t: string, h: (e: unknown) => void) {
    if (!this.handlers.has(t)) this.handlers.set(t, new Set());
    this.handlers.get(t)!.add(h);
  }
  removeEventListener() {}
  dispatch(t: string, e: unknown = {}) { for (const h of this.handlers.get(t) ?? []) h(e); }
}

let win: FakeWindow;
beforeEach(() => {
  win = new FakeWindow();
  vi.stubGlobal("window", win);
  vi.useFakeTimers();
  sources.length = 0;
  clock.t = 0;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

/** The window-level guard installs once per module load, on whichever `window` exists at the first
 *  hold — so every test gets a freshly imported `sfx` bound to its own `FakeWindow`. */
async function fresh() {
  vi.resetModules();
  const m = await import("./sfx");
  m.configure({ enabled: true, pack: "classic", volume: 0.8 });
  return m;
}

describe("sfx.hold end paths", () => {
  const paths: [string, () => void][] = [
    ["pointerup", () => win.dispatch("pointerup")],
    ["pointercancel", () => win.dispatch("pointercancel")],
    ["lostpointercapture", () => win.dispatch("lostpointercapture")],
    ["window blur", () => win.dispatch("blur")],
    ["tab hidden", () => win.dispatch("visibilitychange")],
    ["Escape", () => win.dispatch("keydown", { key: "Escape" })],
  ];
  for (const [name, fire] of paths) {
    it(`is stopped by ${name}`, async () => {
      const m = await fresh();
      const h = m.hold();
      expect(m._activeHoldCount()).toBe(1);
      fire();
      expect(m._activeHoldCount()).toBe(0);
      const n = sources.length;
      h.stop(); // idempotent
      expect(sources.length).toBe(n);
    });
  }

  it("a non-Escape key does not stop a hold", async () => {
    const m = await fresh();
    m.hold();
    win.dispatch("keydown", { key: "a" });
    expect(m._activeHoldCount()).toBe(1);
  });

  it("explicit stop() (unmount path) ends it", async () => {
    const m = await fresh();
    m.hold().stop();
    expect(m._activeHoldCount()).toBe(0);
  });

  it("stops every concurrent hold at once", async () => {
    const m = await fresh();
    m.hold(); m.hold();
    win.dispatch("blur");
    expect(m._activeHoldCount()).toBe(0);
  });

  it("is silent (and creates no AudioContext) when sounds are off or the pack is \"none\"", async () => {
    const m = await fresh();
    m.configure({ enabled: false, pack: "classic", volume: 0.8 });
    m.hold();
    m.configure({ enabled: true, pack: "none", volume: 0.8 });
    m.hold();
    expect(m._activeHoldCount()).toBe(0);
    expect(m.debugCounters.contextsCreated).toBe(0);
  });
});

describe("sfx.hold tick loop", () => {
  it("keeps scheduling ticks while held, then schedules nothing and cancels the queued ones on stop()", async () => {
    const m = await fresh();
    const h = m.hold();
    const first = sources.length;
    expect(first).toBeGreaterThan(0);
    // Advance the audio clock and the refill timer: more ticks get queued ahead of it.
    for (let i = 0; i < 12; i++) { clock.t += 0.025; vi.advanceTimersByTime(25); }
    const held = sources.length;
    expect(held).toBeGreaterThan(first);
    // Every voice calls stop() once for its own end; one still queued ahead of the clock also gets a
    // cancelling stop() on release, so some source has two.
    expect(sources.every(s => s.stop.mock.calls.length === 1)).toBe(true);
    h.stop();
    expect(sources.some(s => s.stop.mock.calls.length >= 2)).toBe(true);
    // No more scheduling afterwards, however long the clock runs.
    for (let i = 0; i < 12; i++) { clock.t += 0.025; vi.advanceTimersByTime(25); }
    expect(sources.length).toBe(held);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("previewHold ticks for its duration even with sounds off, then stops by itself", async () => {
    const m = await fresh();
    m.configure({ enabled: false, pack: "classic", volume: 0.8 });
    m.previewHold("mech", 0.8, 500);
    expect(m._activeHoldCount()).toBe(1);
    vi.advanceTimersByTime(600);
    expect(m._activeHoldCount()).toBe(0);
  });
});

describe("hold + nudge data", () => {
  it("every audible pack defines a tick voice at or under −12 dB of the loudest one-shot", () => {
    for (const pack of Object.values(SOUND_PACKS)) {
      if (pack.id === "none") { expect(pack.hold).toBeUndefined(); continue; }
      expect(pack.hold, `${pack.id} has no hold voice`).toBeTruthy();
      expect(pack.hold!.period, pack.id).toBeGreaterThanOrEqual(90);
      expect(pack.hold!.period, pack.id).toBeLessThanOrEqual(140);
      for (const vc of pack.hold!.voices) {
        expect(vc.g, pack.id).toBeLessThanOrEqual(HOLD_MAX_GAIN);
        expect(vc.t + vc.d, `${pack.id} tick must be short`).toBeLessThanOrEqual(0.04);
      }
    }
    const loudest = Math.max(...Object.values(SOUND_PACKS).flatMap(p =>
      CUE_IDS.flatMap(c => (p.cues[c] ?? []).map(v => v.g))));
    expect(HOLD_MAX_GAIN).toBeLessThanOrEqual(loudest * 10 ** (-12 / 20) + 1e-9);
  });

  it("nudge is throttled to one per 40 ms, not the generic 60 ms", async () => {
    const m = await fresh();
    let t = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    m.play("nudge"); expect(sources.length).toBeGreaterThan(0);
    const n = sources.length;
    t += 20; m.play("nudge"); expect(sources.length).toBe(n);      // inside 40 ms
    t += 25; m.play("nudge"); expect(sources.length).toBeGreaterThan(n); // 45 ms after the first
    vi.restoreAllMocks();
  });
});

