/**
 * Ribbon-specific visual tokens, extending `src/designTokens.ts` (which stays the app-wide
 * glass/chrome language — this file only adds the ribbon's own geometry + palette).
 *
 * Density target: **Office 2007–2010**, not a touch toolbar. Every number below is chosen so a
 * group's three rows of small buttons, or one large button, fill exactly `GROUP_CONTENT_H` — the
 * group label strip is then laid out *after* a fixed-height content box, which is what structurally
 * guarantees the label can never be pushed out of the ribbon and clipped.
 *
 *   RIBBON_BODY_HEIGHT = GROUP_PAD_TOP + GROUP_CONTENT_H + GROUP_LABEL_H + GROUP_PAD_BOTTOM
 */
import type { CSSProperties } from "react";

// ── Geometry ──────────────────────────────────────────────────────────────────

/** Top bar: menu button · undo/redo · tabs · world pill · help · collapse, all in one row. */
export const TOP_BAR_HEIGHT = 34;
/** Fixed — the drag-resize handle is gone (see the plan's §8 deletions). */
export const RIBBON_BODY_HEIGHT = 104;
/** Collapsed ribbon = the top bar alone. */
export const RIBBON_HEIGHT_COLLAPSED = TOP_BAR_HEIGHT;

/**
 * macOS only: `tauri.conf.json`'s `titleBarStyle: "Overlay"` removes the native title bar and
 * floats the traffic lights over our own content at `trafficLightPosition` (12,11) — so the top
 * bar itself doubles as the window's title bar there. Windows/Linux keep the OS-drawn title bar
 * untouched (`titleBarStyle`/`hiddenTitle`/`trafficLightPosition` are no-ops off macOS), so this
 * flag must gate every bit of matching frontend behaviour (drag region + left clearance) or those
 * platforms would grow an unwanted draggable strip inside the ribbon.
 */
export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
/** Clears the traffic-light cluster (starts at x=12, ~52px wide) plus a little breathing room. */
export const MAC_TRAFFIC_LIGHT_CLEARANCE = 72;

/**
 * Platform-aware modifier glyphs for shortcut labels (audit H9) — every tooltip/menu/help
 * accelerator should read from these instead of hardcoding ⌘/⇧, which is wrong on Windows/Linux
 * (the keydown handler in App.tsx already accepts `ctrlKey` there; only the *display* was Mac-only).
 */
export const MOD = IS_MAC ? "⌘" : "Ctrl+";
export const SHIFT = IS_MAC ? "⇧" : "Shift+";
/** Delete/Backspace — both are bound, but the glyph a user recognises differs by platform. */
export const DEL = IS_MAC ? "⌫" : "Del";

export const GROUP_PAD_TOP = 4;
export const GROUP_PAD_BOTTOM = 2;
/** The exact height of a group's control area. 3 × SMALL_H + 2 × ROW_GAP === LARGE_H === this. */
export const GROUP_CONTENT_H = 82;
/** Label strip: 1px hairline + 2px breathing room + 13px line. */
export const GROUP_LABEL_H = 16;

export const LARGE_H = 82;
export const SMALL_H = 26;
export const ROW_GAP = 2;
export const COL_GAP = 2;
export const GROUP_PAD_X = 7;

/** Width of a split / "more" rail. One constant — `SplitButton` used 16 and `PaletteGroup` 15,
 *  which is exactly the kind of 1px mismatch that made the two read as different controls. */
export const RAIL_W = 15;
/** Top-bar control height (Undo/Redo/world pill/Help/collapse). Was an undeclared literal `23`. */
export const TOPBAR_BTN_H = 24;
/** The palette's one-row compact control. Was the undeclared expression `SMALL_H + 8`. */
export const PALETTE_COMPACT_H = 34;

// Compile-time-ish sanity: keeps the two ways of deriving the body height from drifting.
if (GROUP_PAD_TOP + GROUP_CONTENT_H + GROUP_LABEL_H + GROUP_PAD_BOTTOM !== RIBBON_BODY_HEIGHT) {
  throw new Error("ribbon/tokens: body height does not equal pad + content + label");
}

// ── Scales (Phase 1) ──────────────────────────────────────────────────────────

export const RADIUS = { sm: 2, md: 3, lg: 5 } as const;
export const FONT = { micro: 9, label: 10, body: 11, tab: 12 } as const;
export const ICON = { xs: 12, sm: 14, lg: 24 } as const;
export const SPACE = { xs: 2, sm: 4, md: 6, lg: 8 } as const;

// ── Surface + border roles (neutral blue-grey, no teal wash) ──────────────────

export const SURFACE = {
  topbar: "#1b2128",
  body: "linear-gradient(180deg, #2b333c 0%, #242b33 100%)",
  raised: "linear-gradient(180deg, #39434e 0%, #2c343d 100%)",
  popover: "linear-gradient(180deg, #2f3841 0%, #262d35 100%)",
  well: "rgba(0,0,0,.30)",
} as const;

export const BORDER = {
  outline: "rgba(0,0,0,.55)",
  bevel: "rgba(255,255,255,.10)",
  hairline: "rgba(255,255,255,.08)",
  etchDark: "rgba(0,0,0,.35)",
  etchLight: "rgba(255,255,255,.05)",
} as const;

// ── Colour ────────────────────────────────────────────────────────────────────

export const TOPBAR_BG = SURFACE.topbar;
/** Neutral vertical blue-grey gradient — the teal wash to the right has been removed. */
export const BODY_BG = SURFACE.body;

export const TEXT = "#dfe4e8";
export const TEXT_DIM = "#a3adb6";
export const TEXT_LABEL = "#8b959e";
export const TEXT_DISABLED = "#606a73";
/** Neutral at rest — cyan now appears only on active/focus states. */
export const ICON_TONE = "#c3ccd2";
export const ICON_DANGER = "#d97570";
export const ICON_ACCENT = "#e2a44c";
/** Danger label text on an untinted button — the readable end of DANGER. */
export const TEXT_DANGER = "#e39c99";

export const HAIRLINE = BORDER.hairline;
export const DIVIDER = BORDER.hairline;

/** The 4 sanctioned tool-family accent hues (collapsed from 18 hardcoded colours). */
export const ACCENT = {
  primary: "#00a4ad",
  warm: "#d98a2b",
  green: "#3fa85c",
  violet: "#7c6bd6",
} as const;
export const DANGER = "#c2504f";

/** The one "this is armed" text tone. Replaces three per-tab inline Caption colours
 *  (`#fdba74`, `#fbbf24`, plain TEXT), which made "armed" look like three different states. */
export const TEXT_ARMED = "#8cd6db";
/** Ring on a *selected* swatch. Deliberately not `FOCUS_RING` — selected ≠ focused. */
export const ARMED_RING = ACCENT.primary;

/** Active tab: merges into the body's top surface stop with a 1px outline + inner bevel,
 *  rather than floating as a bright pill. */
export const TAB_ACTIVE_TOP = "#39434e";
/** Exactly `SURFACE.body`'s top stop, so the selected tab runs seamlessly into the body below it. */
export const TAB_ACTIVE_BOT = "#2b333c";

/** Contextual tab accents, mapped onto the one 4-hue ACCENT palette (3D moves off sky-blue,
 *  which was near-indistinguishable from the primary accent). */
export const CTX_ACCENT: Record<string, string> = {
  "3d": ACCENT.violet,
  selection: ACCENT.warm,
  clipboard: ACCENT.green,
};

// ── Button recipes ────────────────────────────────────────────────────────────

export const BTN_RADIUS = RADIUS.md;

/** Focus ring — visually distinct from the armed/active ring so focused ≠ armed. */
export const FOCUS_RING = "#5b9fd6";

export function btnBase(extra?: CSSProperties): CSSProperties {
  return {
    background: SURFACE.raised,
    boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}`,
    border: "none",
    borderRadius: BTN_RADIUS,
    color: TEXT,
    cursor: "pointer",
    outline: "none",
    fontSize: FONT.body,
    whiteSpace: "nowrap",
    userSelect: "none",
    ...extra,
  };
}

/** The raw gradients behind `btnHover`/`btnPressed`, exported because CSS-*string* call sites
 *  (a `<style>` block needing real `:hover`/`:active` pseudo-classes, e.g. the splash screen)
 *  can't consume a `CSSProperties` object — without these they'd fork into copied literals. */
export const GRAD_HOVER = "linear-gradient(180deg, #414c58 0%, #323b45 100%)";
export const GRAD_PRESSED = "linear-gradient(180deg, #262d35 0%, #2f3841 100%)";

export function btnHover(extra?: CSSProperties): CSSProperties {
  return {
    background: GRAD_HOVER,
    boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 rgba(255,255,255,.14)`,
    ...extra,
  };
}

/** Pressed state — inverted gradient + inner shadow, no transform (would break grid alignment). */
export function btnPressed(extra?: CSSProperties): CSSProperties {
  return {
    background: GRAD_PRESSED,
    boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 2px rgba(0,0,0,.45)`,
    ...extra,
  };
}

/** Armed/active state. Defaults to the primary accent; pass an accent for tool-family colour
 *  coding. Tinted and outlined — deliberately not glowing. */
export function btnActive(accent: string = ACCENT.primary, extra?: CSSProperties): CSSProperties {
  const rgb = hexToRgbTriplet(accent);
  return {
    background: `linear-gradient(180deg, rgba(${rgb},.38), rgba(${rgb},.20))`,
    boxShadow: `inset 0 0 0 1px rgba(${rgb},.85), inset 0 1px 0 rgba(255,255,255,.10)`,
    color: lighten(accent),
    ...extra,
  };
}

/** Disabled: dim + inert, never unmounted, so neighbouring groups don't shift. Always pair with
 *  `aria-disabled` + `tabIndex={-1}` (a `pointerEvents:none` button stays focusable otherwise).
 *  Single recipe — kills the QatButton .5-opacity one-off variant. */
export const btnDisabled: CSSProperties = { opacity: 0.4, pointerEvents: "none" };

/** Recessed well for numeric fields inside the ribbon. */
export const fieldStyle: CSSProperties = {
  background: SURFACE.well,
  border: "none",
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,.45), inset 0 2px 3px rgba(0,0,0,.35)",
  color: TEXT,
  borderRadius: RADIUS.md,
  padding: "1px 4px",
  fontSize: FONT.body,
  textAlign: "center",
  outline: "none",
};

// ── Colour helpers ────────────────────────────────────────────────────────────

/**
 * Real hex parser. Replaces the old `accentRgb()` in Ribbon.tsx, a 6-entry lookup table that
 * silently returned green for any colour not in it — so a new accent looked "almost right"
 * and nobody noticed.
 */
export function hexToRgbTriplet(hex: string): string {
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return "0,164,173"; // Eden teal fallback
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/** Lift an accent toward white for use as label text on a tinted fill. */
export function lighten(hex: string, amount = 0.55): string {
  const [r, g, b] = hexToRgbTriplet(hex).split(",").map(Number);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}
