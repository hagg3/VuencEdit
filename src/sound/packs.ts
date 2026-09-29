/**
 * UI sound data — six WebAudio-synthesised packs, ported from the design exploration's
 * `js/sound.js` (see `TEST WORLDS/design-exploration-2026-09/js/sound.js`), with pack ids/labels
 * kept as-is: they are already the neutral names that file's own history moved to (an earlier,
 * differently-branded pack name was retired there — see that directory's planning notes; per UI
 * redesign r3 §1 "Sounds", no such branded reference may ship here in code, comments or UI, so it
 * is deliberately not spelled out again in this file). Pure data: no `AudioContext`, no side
 * effects, safe to import from tests. Labels only — no per-pack descriptions ship.
 */

export type Waveform = "sine" | "triangle" | "square" | "noise";

/** One oscillator/noise voice within a cue. `t`/`d` are seconds relative to the cue's own start. */
export interface Voice {
  /** Oscillator waveform, or `"noise"` for the shared filtered-noise buffer (`f`/`f2` unused then). */
  w: Waveform;
  /** Base frequency (Hz). Ignored for `"noise"` voices (kept `0` there, matching the source data). */
  f: number;
  /** Optional exponential frequency sweep target (Hz), reached by `t + d`. */
  f2?: number;
  /** Start offset within the cue (s). */
  t: number;
  /** Duration (s). */
  d: number;
  /** Peak gain (0–1, pre-volume/pre-master-gain). */
  g: number;
  /** Bandpass filter centre frequency (Hz) — `"noise"` voices only; default 2000 if omitted. */
  bp?: number;
  /** Bandpass filter Q — `"noise"` voices only; default 1 if omitted. */
  q?: number;
  /** Attack time (s) to the voice's peak gain; default `min(0.004, d/4)` if omitted. */
  a?: number;
}

function v(w: Waveform, f: number, t: number, d: number, g: number, extra?: Partial<Voice>): Voice {
  return { w, f, t, d, g, ...extra };
}

/** Every cue a pack must define (or the pack is `"none"`, which defines zero). Adding a cue here
 *  means adding it to all six data packs below — `sfx.test.ts` enforces that no pack silently
 *  ships a gap. */
export const CUE_IDS = [
  "tab", "menu", "copy", "paste", "rotate", "save", "stroke", "undo", "drag", "drop", "error", "nudge",
] as const;
export type CueId = (typeof CUE_IDS)[number];

/** Human-readable label for each cue, used only by the (currently unshipped) per-cue byte-budget
 *  table the source mock carried — kept here as the one place a call site could look one up. */
export const CUE_LABELS: Record<CueId, string> = {
  tab: "Tab open", menu: "Menu open", copy: "Copy", paste: "Paste", rotate: "Rotate",
  save: "Save", stroke: "Sculpt stroke end", undo: "Undo", drag: "Drag start (marquee)",
  drop: "Drag release", error: "Error", nudge: "Paste Z-offset step",
};

/** A quiet looped voice that plays for as long as a gesture is held (window move/resize, selection
 *  drag, paste-ghost drag). Not a one-shot, so exempt from the 250 ms cue ceiling — but its gain is
 *  capped 12 dB under the loudest one-shot peak (`HOLD_MAX_GAIN`; `sfx.test.ts` enforces it). */
export interface HoldVoice {
  w: Waveform;
  /** Oscillator frequency (Hz); ignored for `"noise"`. */
  f: number;
  /** Bandpass centre (Hz) / Q for `"noise"` loops. */
  bp?: number;
  q?: number;
  /** Steady-state peak gain (0–1, pre-volume). */
  g: number;
}
/** −12 dB relative to the loudest one-shot peak (0.12) — the ceiling for any `HoldVoice.g`. */
export const HOLD_MAX_GAIN = 0.12 * 0.25;

export type PackId = "tick" | "soft" | "mech" | "glass" | "chip" | "classic" | "none";

export interface SoundPack {
  id: PackId;
  /** Display name only — no description ships (§1 "Sounds" decision). */
  label: string;
  /** Empty for `"none"`; every other pack defines the full `CUE_IDS` set. */
  cues: Partial<Record<CueId, Voice[]>>;
  /** The looped hold voice; `"none"` (and any pack that omits it) plays no hold. */
  hold?: HoldVoice;
}

export const SOUND_PACKS: Record<PackId, SoundPack> = {
  tick: {
    id: "tick", label: "Tick",
    cues: {
      tab: [v("noise", 0, 0, .012, .10, { bp: 3200, q: 3 })],
      menu: [v("sine", 1250, 0, .018, .05)],
      copy: [v("sine", 880, 0, .03, .06)],
      paste: [v("sine", 660, 0, .035, .06, { f2: 880 })],
      rotate: [v("noise", 0, 0, .01, .08, { bp: 2600, q: 4 }), v("noise", 0, .05, .01, .08, { bp: 3000, q: 4 })],
      save: [v("sine", 523, 0, .06, .05), v("sine", 784, .045, .08, .05)],
      stroke: [v("noise", 0, 0, .025, .09, { bp: 900, q: 1.5 })],
      undo: [v("sine", 720, 0, .04, .05, { f2: 520 })],
      drag: [v("noise", 0, 0, .05, .06, { bp: 700, q: .8, a: .025 })],
      drop: [v("noise", 0, 0, .012, .09, { bp: 2400, q: 3 }), v("sine", 150, 0, .05, .06, { f2: 95 })],
      error: [v("triangle", 220, 0, .09, .07)],
      nudge: [v("sine", 1500, 0, .012, .04)],
    },
    hold: { w: "noise", f: 0, bp: 3000, q: 4, g: .012 },
  },
  soft: {
    id: "soft", label: "Soft",
    cues: {
      tab: [v("sine", 990, 0, .04, .045)],
      menu: [v("sine", 740, 0, .05, .04, { f2: 880 })],
      copy: [v("sine", 880, 0, .05, .05), v("sine", 1320, .035, .05, .03)],
      paste: [v("sine", 660, 0, .06, .05), v("sine", 990, .04, .06, .035)],
      rotate: [v("sine", 600, 0, .07, .045, { f2: 900 })],
      save: [v("sine", 523, 0, .09, .05), v("sine", 659, .06, .09, .045), v("sine", 784, .12, .12, .04)],
      stroke: [v("sine", 440, 0, .08, .05, { f2: 330 })],
      undo: [v("sine", 880, 0, .07, .045, { f2: 587 })],
      drag: [v("sine", 330, 0, .07, .035, { f2: 440, a: .03 })],
      drop: [v("sine", 440, 0, .08, .04, { f2: 294 })],
      error: [v("sine", 311, 0, .12, .06), v("sine", 293, .08, .14, .05)],
      nudge: [v("sine", 700, 0, .03, .035)],
    },
    hold: { w: "sine", f: 220, g: .012 },
  },
  mech: {
    id: "mech", label: "Mechanical",
    cues: {
      tab: [v("noise", 0, 0, .015, .12, { bp: 2400, q: 2 })],
      menu: [v("noise", 0, 0, .02, .1, { bp: 1800, q: 2 })],
      copy: [v("noise", 0, 0, .012, .12, { bp: 4000, q: 3 }), v("noise", 0, .03, .012, .1, { bp: 4400, q: 3 })],
      paste: [v("noise", 0, 0, .03, .12, { bp: 1400, q: 1.2 })],
      rotate: [
        v("noise", 0, 0, .01, .1, { bp: 3000, q: 5 }),
        v("noise", 0, .035, .01, .1, { bp: 3400, q: 5 }),
        v("noise", 0, .07, .01, .1, { bp: 3800, q: 5 }),
      ],
      save: [v("noise", 0, 0, .04, .12, { bp: 700, q: 1 }), v("noise", 0, .05, .012, .1, { bp: 3500, q: 3 })],
      stroke: [v("noise", 0, 0, .05, .1, { bp: 500, q: .8 })],
      undo: [v("noise", 0, 0, .02, .1, { bp: 1200, q: 2 })],
      drag: [v("noise", 0, 0, .06, .09, { bp: 1100, q: .7, a: .02 })],
      drop: [v("noise", 0, 0, .03, .12, { bp: 500, q: 1 }), v("noise", 0, .012, .01, .1, { bp: 3200, q: 3 })],
      error: [v("square", 110, 0, .06, .04)],
      nudge: [v("noise", 0, 0, .01, .09, { bp: 2000, q: 3 })],
    },
    hold: { w: "noise", f: 0, bp: 700, q: 1.2, g: .025 },
  },
  glass: {
    id: "glass", label: "Glass",
    cues: {
      tab: [v("sine", 1320, 0, .09, .03), v("sine", 3643, 0, .05, .01)],
      menu: [v("sine", 1046, 0, .1, .03), v("sine", 2887, 0, .06, .01)],
      copy: [v("sine", 1175, 0, .12, .035), v("sine", 3243, 0, .07, .012)],
      paste: [v("sine", 988, 0, .12, .035), v("sine", 1480, .05, .14, .03)],
      rotate: [v("sine", 880, 0, .1, .03, { f2: 1175 }), v("sine", 2429, 0, .06, .01)],
      save: [v("sine", 784, 0, .16, .035), v("sine", 1175, .07, .18, .03), v("sine", 3243, .07, .1, .008)],
      stroke: [v("sine", 660, 0, .14, .03), v("sine", 1822, 0, .08, .01)],
      undo: [v("sine", 1046, 0, .1, .03, { f2: 784 })],
      drag: [v("sine", 880, 0, .12, .02, { f2: 1320, a: .04 }), v("sine", 2429, 0, .08, .006, { a: .04 })],
      drop: [v("sine", 660, 0, .16, .03), v("sine", 1822, 0, .09, .01)],
      // Source mock's second voice was t=.09/d=.2 (290ms total) — over the 250ms cue ceiling this
      // pass enforces (§1 "Sounds"); shortened its tail to .16 (250ms total) rather than dropping it.
      error: [v("sine", 392, 0, .2, .04), v("sine", 370, .09, .16, .035)],
      nudge: [v("sine", 1568, 0, .05, .02)],
    },
    hold: { w: "sine", f: 1320, g: .008 },
  },
  chip: {
    id: "chip", label: "Chiptune",
    cues: {
      tab: [v("square", 1046, 0, .03, .025)],
      menu: [v("square", 784, 0, .03, .025), v("square", 1046, .03, .03, .025)],
      copy: [v("square", 1318, 0, .03, .025), v("square", 1568, .03, .04, .025)],
      paste: [v("square", 784, 0, .03, .025), v("square", 988, .03, .03, .025), v("square", 1318, .06, .05, .025)],
      rotate: [
        v("square", 988, 0, .025, .022),
        v("square", 1175, .025, .025, .022),
        v("square", 988, .05, .025, .022),
      ],
      save: [
        v("square", 523, 0, .05, .025), v("square", 659, .05, .05, .025),
        v("square", 784, .1, .05, .025), v("square", 1046, .15, .08, .025),
      ],
      stroke: [v("triangle", 330, 0, .06, .06, { f2: 220 })],
      undo: [v("square", 988, 0, .03, .022), v("square", 740, .03, .05, .022)],
      drag: [v("square", 392, 0, .03, .02), v("square", 523, .03, .03, .02)],
      drop: [v("square", 523, 0, .03, .022), v("square", 392, .03, .05, .022)],
      error: [v("square", 196, 0, .08, .03), v("square", 147, .08, .1, .03)],
      nudge: [v("square", 1175, 0, .02, .018)],
    },
    hold: { w: "triangle", f: 165, g: .02 },
  },
  classic: {
    id: "classic", label: "Classic",
    cues: {
      tab: [v("noise", 0, 0, .014, .1, { bp: 1900, q: 2.2 })],
      menu: [v("noise", 0, 0, .05, .06, { bp: 1500, q: .9, a: .02 })],
      copy: [v("noise", 0, 0, .012, .1, { bp: 2800, q: 3 }), v("sine", 1175, .015, .03, .025)],
      paste: [v("noise", 0, 0, .02, .1, { bp: 900, q: 1.5 }), v("sine", 180, 0, .05, .05, { f2: 120 })],
      rotate: [
        v("noise", 0, 0, .06, .07, { bp: 1300, q: 1.2, a: .025 }),
        v("noise", 0, .06, .012, .09, { bp: 2600, q: 3 }),
      ],
      save: [
        v("noise", 0, 0, .015, .1, { bp: 2200, q: 2.5 }),
        v("sine", 523, .02, .07, .03), v("sine", 784, .07, .1, .025),
      ],
      stroke: [v("noise", 0, 0, .04, .09, { bp: 600, q: .9 })],
      undo: [v("noise", 0, 0, .04, .07, { bp: 1200, q: 1, a: .02 })],
      drag: [
        v("noise", 0, 0, .085, .11, { bp: 850, q: .6, a: .035 }),
        v("noise", 0, 0, .012, .05, { bp: 3000, q: 3 }),
      ],
      drop: [v("sine", 130, 0, .07, .09, { f2: 70 }), v("noise", 0, 0, .025, .11, { bp: 420, q: .8 })],
      error: [v("square", 147, 0, .09, .03), v("square", 139, .1, .12, .03)],
      nudge: [v("noise", 0, 0, .012, .08, { bp: 1700, q: 2.5 })],
    },
    hold: { w: "noise", f: 0, bp: 550, q: .8, g: .028 },
  },
  none: { id: "none", label: "Off", cues: {} },
};

/** Order matches the source mock's pack list; `Select` renders these directly (names only). */
export const SOUND_PACK_OPTIONS: { id: PackId; label: string }[] =
  (["tick", "soft", "mech", "glass", "chip", "classic", "none"] as const).map(id => ({
    id, label: SOUND_PACKS[id].label,
  }));

/** Total duration of a cue (s) — `max(t + d)` over its voices, `0` if the pack/cue is undefined. */
export function cueDuration(pack: PackId, cue: CueId): number {
  const voices = SOUND_PACKS[pack]?.cues[cue];
  if (!voices || voices.length === 0) return 0;
  return Math.max(...voices.map(voice => voice.t + voice.d));
}
