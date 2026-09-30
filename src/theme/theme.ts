/**
 * The one theme module (UI redesign r3, Stage 14.1). Every colour, surface and material token the
 * app draws with is declared here once; `cssVars.ts` serves them as `--vx-…` custom properties and
 * `ribbon/tokens.ts` / `designTokens.ts` re-export them under their historical names.
 *
 * ⚠️ **No React import, no DOM.** `contrast.test.ts` and `cssVars.test.ts` load this file in plain
 * node — the same reason `ribbon/layout.ts` is pure.
 *
 * Two layers (round-2 DECISIONS #1):
 *   1. `RAMP` — palette A's hexes, verbatim from `TEST WORLDS/design-exploration-2026-09/js/data.js`
 *      (`P.A`, the `#proposal` page's palette). Nothing outside this file should need a raw hex.
 *   2. Semantic roles (`SURFACE_ROLES`, `TEXT_ROLES`, `ACCENTS`, `MAP`, …) that name what a colour is
 *      *for*. Call sites use roles; a palette change is then an edit here and nowhere else.
 *
 * Canvas code can't read CSS variables through `fillStyle`, so anything drawn into a `<canvas>`
 * (the map overlays, slab viewports, elevation previews) imports the hex constants from here
 * directly — never a `var(--vx-…)` string, which a 2D context would silently ignore.
 */

// ── Primitive ramp (palette A) ────────────────────────────────────────────────

export const RAMP = {
  // Neutral slate surfaces, darkest first.
  mapBg: "#10141b",
  bg0: "#16191d",
  chrome: "#1b2128",
  body0: "#2b333c", body1: "#242b33",
  raised0: "#39434e", raised1: "#2c343d",
  hover0: "#414c58", hover1: "#323b45",
  press0: "#262d35", press1: "#2f3841",
  pop0: "#2f3841", pop1: "#262d35",
  // Warm second surface — modals only (the official second material, not a leftover).
  modal0: "#221d19", modal1: "#181411",
  mbtn0: "#40372f", mbtn1: "#2e2722",
  // Chrome text ramp — every step passes AA on every panel surface (contrast.test.ts).
  text: "#e3e8ec", dim: "#b3bdc5", label: "#a2acb5", meta: "#9da7b0", disabled: "#69737c",
  // Modal text ramp (warm).
  mtext: "#efeae5", mdim: "#c9beb3", mlabel: "#ad9f92",
  // Family hues.
  teal: "#00a4ad", amber: "#d98a2b", azure: "#4b8fe8", green: "#3fa85c", violet: "#7c6bd6",
  red: "#c2504f",
  focus: "#eef2f5",
  // Icon + state tones (ribbon icons, danger labels, armed captions).
  iconTone: "#c3ccd2", iconDanger: "#d97570", iconAccent: "#e2a44c",
  textDanger: "#e39c99", textArmed: "#8cd6db",
  // Badge text tones (exp/ok), and the modal-side badge hues (designTokens expBadge/perfBadge).
  badgeExp: "#e0a95a", badgeOk: "#7fc994", badgeExpModal: "#f59e0b", badgePerfModal: "#f87171",
  /** Legacy readable teal (modal accents, spinners). Removed by Stage 14.15. */
  tealReadable: "#00dde9",
  // Map overlay hues. The two family hues were chosen to match what the map already drew, so
  // these values are unchanged from the pre-theme literals in MapCanvas.
  mapSelection: "#3b82f6", mapClipboard: "#22c55e", mapBuried: "#ef4444", mapCleared: "#f59e0b",
  mapAir: "#94a3b8", mapCamera: "#fde68a",
  white: "#ffffff", black: "#000000",
} as const;

// ── Colour maths (pure) ───────────────────────────────────────────────────────

export type RGB = readonly [number, number, number];

/** `#rgb` / `#rrggbb` → [r,g,b]. Throws on garbage — every input here is a literal we own. */
export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) throw new Error(`theme: not a hex colour: ${hex}`);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** `color-mix(in srgb, a <t*100>%, b)` computed ahead of time — so no recipe depends on the
 *  rendering engine's `color-mix` support (WKWebView and WebView2 both have it; one less variable). */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex([x[0] * t + y[0] * (1 - t), x[1] * t + y[1] * (1 - t), x[2] * t + y[2] * (1 - t)]);
}

/** `rgba(r,g,b,a)` from a hex — for canvas `fillStyle`s and translucent tints. */
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Alpha-composite `fg` (with alpha `a`) over an opaque `bg`. */
export function composite(fg: string, a: number, bg: string): string {
  return mix(fg, bg, a);
}

/** WCAG 2.1 relative luminance. */
export function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.1 contrast ratio, 1…21. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The AA bar for normal-size text. Everything in the chrome is < 18 px, so this is the only bar. */
export const AA = 4.5;

// ── Semantic roles ────────────────────────────────────────────────────────────

/**
 * A surface is described for two consumers: CSS (`css`, what gets painted) and the contrast test
 * (`stops`, the opaque colours text can actually land on — a gradient is tested at *each* stop,
 * worst case wins; a translucent surface is composited over the `over` role first).
 */
export interface SurfaceRole {
  css: string;
  stops: readonly string[];
  /** Translucent surfaces: the role this one is painted over (a `SURFACE_ROLES` key), and its alpha. */
  over?: string;
  alpha?: number;
}

const grad = (a: string, b: string) => `linear-gradient(180deg, ${a} 0%, ${b} 100%)`;

export const SURFACE_ROLES: {
  readonly [K in "bg0" | "chrome" | "topbar" | "body" | "raised" | "hover" | "pressed" | "popover" | "well" | "modal" | "modalRaised" | "modalNav"]: SurfaceRole
} = {
  bg0: { css: RAMP.bg0, stops: [RAMP.bg0] },
  chrome: { css: RAMP.chrome, stops: [RAMP.chrome] },
  topbar: { css: RAMP.chrome, stops: [RAMP.chrome] },
  body: { css: grad(RAMP.body0, RAMP.body1), stops: [RAMP.body0, RAMP.body1] },
  raised: { css: grad(RAMP.raised0, RAMP.raised1), stops: [RAMP.raised0, RAMP.raised1] },
  hover: { css: grad(RAMP.hover0, RAMP.hover1), stops: [RAMP.hover0, RAMP.hover1] },
  pressed: { css: grad(RAMP.press0, RAMP.press1), stops: [RAMP.press0, RAMP.press1] },
  popover: { css: grad(RAMP.pop0, RAMP.pop1), stops: [RAMP.pop0, RAMP.pop1] },
  well: { css: "rgba(0,0,0,.30)", stops: [RAMP.black], over: "body", alpha: 0.30 },
  modal: { css: grad(RAMP.modal0, RAMP.modal1), stops: [RAMP.modal0, RAMP.modal1] },
  modalRaised: { css: grad(RAMP.mbtn0, RAMP.mbtn1), stops: [RAMP.mbtn0, RAMP.mbtn1] },
  /** `DialogNav`'s side column (Stage 14.17) — a recessed strip of the modal surface, not a third
   *  material. */
  modalNav: { css: "rgba(0,0,0,.18)", stops: [RAMP.black], over: "modal", alpha: 0.18 },
};
export type SurfaceName = keyof typeof SURFACE_ROLES;

export const BORDER_ROLES = {
  outline: "rgba(0,0,0,.55)",
  bevel: "rgba(255,255,255,.10)",
  hairline: "rgba(255,255,255,.08)",
  etchDark: "rgba(0,0,0,.35)",
  etchLight: "rgba(255,255,255,.05)",
  modalHairline: "rgba(255,240,225,.09)",
} as const;

export const TEXT_ROLES = {
  primary: RAMP.text,
  secondary: RAMP.dim,
  label: RAMP.label,
  /** Content that is quiet but still *content* — a world name, a timestamp, a version, an empty
   *  state. It used to borrow `disabled`, which failed AA; `meta` passes on every panel surface. */
  meta: RAMP.meta,
  /** Only for controls that genuinely can't be used. Exempt from the AA gate (WCAG 1.4.3). */
  disabled: RAMP.disabled,
} as const;
export type TextRole = keyof typeof TEXT_ROLES;

export const MODAL_TEXT_ROLES = {
  primary: RAMP.mtext,
  secondary: RAMP.mdim,
  label: RAMP.mlabel,
} as const;

/**
 * The five sanctioned tool-family hues. **An accent names the tool *family*, not the command** —
 * most buttons on a tab sharing one hue is the system working. Selection is blue and clipboard is
 * green (they used to share green on buttons while the Selection *tab* glowed warm).
 */
export const ACCENTS = {
  primary: RAMP.teal,
  warm: RAMP.amber,
  selection: RAMP.azure,
  clipboard: RAMP.green,
  violet: RAMP.violet,
} as const;
export type AccentName = keyof typeof ACCENTS;

/**
 * Scrollbar thumb/track/hover (Stage 15.1). Track reuses the "well" recessed tone; thumb/hover
 * are the primary accent (teal) at 35%/60% alpha — same hue, not a ramp, since `tealReadable` is
 * being retired elsewhere in this stage.
 */
/** 3D pane sky/fog defaults (Stage 15.8) — the dome's original gradient (horizon #c5d5eb → zenith
 *  #347ee3) and Minecraft-clear-sky fog blue. Canvas/WebGL code, so hexes (not CSS vars); lives here so
 *  `AppSettings` defaults and `FlyView3D` share one source. */
export const SKY_3D = { zenith: "#347ee3", horizon: "#c5d5eb", fog: "#8cbeff" } as const;

export const SCROLLBAR_ROLE = {
  track: SURFACE_ROLES.well.css,
  thumb: rgba(ACCENTS.primary, 0.35),
  thumbHover: rgba(ACCENTS.primary, 0.60),
} as const;

export const DANGER_HEX = RAMP.red;
/** One near-white focus ring for the whole app, modals included. ≠ the armed ring on purpose. */
export const FOCUS_HEX = RAMP.focus;

/** Map/canvas overlay colours (hex, never vars — see the file header). */
export const MAP = {
  selection: RAMP.mapSelection,
  clipboard: RAMP.mapClipboard,
  buried: RAMP.mapBuried,
  cleared: RAMP.mapCleared,
  air: RAMP.mapAir,
  camera: RAMP.mapCamera,
} as const;

/**
 * Which text roles are *allowed* on which surfaces — the design rule the contrast test enforces.
 * Panels carry every text role; control faces (a raised button in any state) carry only the
 * labels a button actually uses (`primary`, and `secondary` for de-emphasised button text). Labels
 * and meta text never sit on a button face, and palette A doesn't try to make them pass there.
 */
export const CONTRAST_PAIRS: ReadonlyArray<{ surfaces: readonly SurfaceName[]; texts: readonly string[]; ramp: "chrome" | "modal" }> = [
  { ramp: "chrome", surfaces: ["bg0", "chrome", "topbar", "body", "popover", "well"], texts: ["primary", "secondary", "label", "meta"] },
  { ramp: "chrome", surfaces: ["raised", "hover", "pressed"], texts: ["primary", "secondary"] },
  { ramp: "modal", surfaces: ["modal", "modalRaised"], texts: ["primary", "secondary", "label"] },
  { ramp: "modal", surfaces: ["modalNav"], texts: ["primary", "secondary", "label"] },
];

// ── Material: gloss-lite + the "current item" recipe (Stage 14.2) ─────────────

/**
 * `.gloss-lite` (EXTRA_MATERIALS.BL): Unified Bevel's Aero recipe with the gloss turned down — a
 * 1 px top highlight at ~.13 alpha, no hard 48/52 split, a soft armed glow. Bevel and gloss go on
 * **controls and wells only**, never on panel backgrounds, text or the map.
 */
export const MATERIAL = {
  base: {
    shadow: `inset 0 0 0 1px ${BORDER_ROLES.outline}, inset 0 1px 0 rgba(255,255,255,.13)`,
    textShadow: "0 1px 0 rgba(0,0,0,.3)",
  },
  hover: {
    shadow: "inset 0 0 0 1px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.2), 0 0 5px rgba(140,190,255,.1)",
  },
  pressed: {
    shadow: `inset 0 0 0 1px ${BORDER_ROLES.outline}, inset 0 2px 4px rgba(0,0,0,.55)`,
  },
  /** Current item = pushed in: a darker well, an inner top shadow and a 1 px light lip below. */
  current: {
    bg: "linear-gradient(180deg, rgba(0,0,0,.36) 0%, rgba(0,0,0,.24) 100%)",
    /** The darkest stop's alpha, for compositing in the contrast test. */
    alpha: 0.36,
    shadow: "inset 0 1px 2px rgba(0,0,0,.6), inset 0 0 0 1px rgba(0,0,0,.5), 0 1px 0 rgba(255,255,255,.07)",
    icon: mix(RAMP.teal, RAMP.white, 0.5),
  },
  /** Hover on a list row = the opposite of current: a faint raised lip. Never confusable. */
  lift: {
    bg: "rgba(255,255,255,.055)",
    shadow: "inset 0 1px 0 rgba(255,255,255,.07), inset 0 0 0 1px rgba(0,0,0,.18)",
  },
  popShadow: "0 12px 30px rgba(0,0,0,.6), 0 0 0 1px rgba(0,0,0,.6)",
} as const;

// ── Motion (Stage 14.13 — profile MO.B) ────────────────────────────────────────

/**
 * Motion profile B: short, transform/opacity-only chrome transitions plus one longer completion
 * flash. Durations are the plan's (§5.13) ceilings — ≤180ms chrome, ≤400ms completion — picked a
 * touch under each so nothing risks tripping the invariant on a slow frame. Easing is asymmetric on
 * purpose: `easeEnter` decelerates into rest (a popover/tab "arriving"), `easeExit` accelerates away
 * (the completion outline's fade-out reads as a quick dismissal, not a lingering glow) — the same
 * enter/exit split most platform motion systems (Material, Fluent) use, chosen so opens don't feel
 * bouncy and closes don't feel sluggish. Consumed only from `:root[data-motion="full"] .x {…}`
 * rules (`src/theme/motion.ts`) — never from a `@media (prefers-reduced-motion)` block; see that
 * file's header for why.
 */
export const MOTION = {
  /** Chrome transitions — popover enter, contextual-tab fade. ≤180ms per the plan. */
  chromeMs: 150,
  /** The completion outline. ≤400ms per the plan. */
  doneMs: 350,
  /** The selection-commit flash (19.6): lighter and shorter than an edit's. */
  selectMs: 240,
  easeEnter: "cubic-bezier(0.16, 1, 0.3, 1)",
  easeExit: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

/** The armed (active) face of a control, precomputed per accent. */
export interface ArmedRecipe {
  bg: string;
  shadow: string;
  text: string;
  /** Opaque stops at ≥ 50 % of the gradient — where a label actually sits. Tested for AA. */
  labelStops: readonly string[];
}

/**
 * The lightest the armed label text is allowed to start at, as a fraction toward white. Open
 * question 7 was answered "lighten the text, don't darken the gradient", so `armedText` keeps
 * lifting from here until the label clears AA with a small margin — per family, not globally, so
 * a hue that already passes keeps as much of its colour as it can.
 */
const ARMED_TEXT_MIN_LIGHTEN = 0.55;
const ARMED_TEXT_TARGET = AA + 0.1;

function armedText(accent: string, stops: readonly string[]): string {
  for (let t = ARMED_TEXT_MIN_LIGHTEN; t < 1; t += 0.05) {
    const c = mix(RAMP.white, accent, t);
    if (stops.every(s => contrastRatio(c, s) >= ARMED_TEXT_TARGET)) return c;
  }
  return RAMP.white;
}

const armedCache = new Map<string, ArmedRecipe>();

/** gloss-lite's armed state for any accent hex (families are memoised, and emitted as CSS vars). */
export function armedRecipe(accent: string): ArmedRecipe {
  const hit = armedCache.get(accent);
  if (hit) return hit;
  // Mock weights (proposal.css `.gloss-lite .b[data-armed]`): 52/58/56 % accent. A very light
  // non-family accent (a bright amber or sky) can leave even white text under AA; for those only,
  // the accent's share is stepped down — the one case where the gradient darkens instead of the
  // text lightening, because the text has nowhere lighter to go. Every family passes at k = 1.
  let r: ArmedRecipe | null = null;
  for (let k = 1; k > 0.3 && !r; k -= 0.1) {
    const s0 = mix(accent, "#5a6570", 0.52 * k);
    const s1 = mix(accent, "#333b44", 0.58 * k);
    const s2 = mix(accent, "#283038", 0.56 * k);
    const labelStops = [s1, s2];
    const text = armedText(accent, labelStops);
    if (labelStops.every(st => contrastRatio(text, st) >= AA) || k <= 0.4) {
      r = {
        bg: `linear-gradient(180deg, ${s0} 0%, ${s1} 55%, ${s2} 100%)`,
        shadow: `inset 0 0 0 1px ${mix(accent, RAMP.black, 0.35)}, inset 0 1px 0 rgba(255,255,255,.26), 0 0 5px ${rgba(accent, 0.22)}`,
        text,
        labelStops,
      };
    }
  }
  armedCache.set(accent, r!);
  return r!;
}

/** Tab-strip gradients (gloss-lite). `ctx` = a contextual tab tinted by its family hue. */
export const TAB = {
  active: `linear-gradient(180deg, #444e5a 0%, #37404a 55%, ${RAMP.body0} 100%)`,
  activeTop: "#444e5a",
  activeShadow: `inset 0 0 0 1px ${BORDER_ROLES.outline}, inset 0 1px 0 rgba(255,255,255,.16)`,
  ctxIdle: (accent: string) => `linear-gradient(180deg, ${rgba(accent, 0.2)}, transparent)`,
  ctxActive: (accent: string) =>
    `linear-gradient(180deg, ${mix(accent, "#444e5a", 0.42)} 0%, ${mix(accent, "#313942", 0.24)} 60%, ${RAMP.body0} 100%)`,
} as const;

/** The brand/File button (Office 2010's File tab), gloss-lite. */
export const BRAND = {
  // A touch darker than the mock's recipe, with a steeper fall-off (user feedback 2026-09-26: the
  // lighter version read as too bright next to the slate chrome).
  bg: `linear-gradient(180deg, ${mix(RAMP.teal, RAMP.white, 0.88)} 0%, ${mix(RAMP.teal, RAMP.black, 0.84)} 48%, ${mix(RAMP.teal, RAMP.black, 0.58)} 100%)`,
  shadow: (open: boolean) =>
    `inset 0 0 0 1px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.3), 0 0 ${open ? 10 : 6}px ${rgba(RAMP.teal, open ? 0.5 : 0.32)}`,
} as const;
