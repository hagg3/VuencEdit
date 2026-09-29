/**
 * Ribbon geometry + the chrome's colour/recipe exports. Every colour here is re-exported from the
 * one theme module (`src/theme/theme.ts`, Stage 14.1) — this file keeps its historical export
 * names so ~25 importers didn't have to change, but it no longer owns a single hex.
 *
 * Density target: **Office 2007–2010**, not a touch toolbar. Every number below is chosen so a
 * group's three rows of small buttons, or one large button, fill exactly `GROUP_CONTENT_H` — the
 * group label strip is then laid out *after* a fixed-height content box, which is what structurally
 * guarantees the label can never be pushed out of the ribbon and clipped.
 *
 *   RIBBON_BODY_HEIGHT = GROUP_PAD_TOP + GROUP_CONTENT_H + GROUP_LABEL_H + GROUP_PAD_BOTTOM
 */
import type { CSSProperties } from "react";
import { ACCENTS, DANGER_HEX, FOCUS_HEX, RAMP, TAB, TEXT_ROLES, armedRecipe } from "../theme/theme";
import { accentFamily, v } from "../theme/cssVars";

// ── Geometry ──────────────────────────────────────────────────────────────────

/** Top bar: menu button · undo/redo · tabs · world pill · help · collapse, all in one row. */
export const TOP_BAR_HEIGHT = 34;
/** Fixed — the drag-resize handle is gone (see the plan's §8 deletions). Density D.F (Stage 14.7):
 *  96 = `GROUP_PAD_TOP` 3 + `GROUP_CONTENT_H` 76 + `GROUP_LABEL_H` 15 + `GROUP_PAD_BOTTOM` 2. */
export const RIBBON_BODY_HEIGHT = 96;
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
/** Option/Alt — the floating-window toggles (⌥3/⌥T/⌥Q, Stage 14.4). */
export const ALT = IS_MAC ? "⌥" : "Alt+";
/** Delete/Backspace — both are bound, but the glyph a user recognises differs by platform. */
export const DEL = IS_MAC ? "⌫" : "Del";

export const GROUP_PAD_TOP = 3;
export const GROUP_PAD_BOTTOM = 2;
/** The exact height of a group's control area. 3 × SMALL_H + 2 × ROW_GAP === LARGE_H === this. */
export const GROUP_CONTENT_H = 76;
/** Label strip: 1px hairline + 1px breathing room + 13px line. */
export const GROUP_LABEL_H = 15;

export const LARGE_H = 76;
export const SMALL_H = 24;
export const ROW_GAP = 2;
export const COL_GAP = 2;
export const GROUP_PAD_X = 7;

// ── Popup tier + row overhead (Stage 15.4) ─────────────────────────────────────
//
// A `popup`-tier group is a fixed-width box by construction (its label wraps/clamps inside the
// button instead of widening it), so its `TAB_SPECS` width is a derived constant, never a harvest.

/** The popup group button's own width — fits "Navigation" on one 11px line. */
export const POPUP_BTN_W = 60;
/** Declared `widths.popup` of every ordinary group: the button plus the group shell's padding. */
export const POPUP_GROUP_W = POPUP_BTN_W + 2 * GROUP_PAD_X;
/** The Block button's popup form (MS: a single-button group never becomes a popup icon — it just
 *  narrows): swatch + caret, one click to the picker as before. */
export const BLOCK_NARROW_W = 44;
export const BLOCK_POPUP_GROUP_W = BLOCK_NARROW_W + 2 * GROUP_PAD_X;
/** `GroupDivider`'s footprint: a 1px line with 1px margin either side. */
export const GROUP_DIVIDER_W = 3;
/** Kept clear at the row's right end for the absolutely-positioned Compact/Labels toggle, so the
 *  last group's label is never drawn under it. */
export const RIBBON_TRAIL_RESERVE = 64;

/** Width of a split / "more" rail. One constant — `SplitButton` used 16 and `PaletteGroup` 15,
 *  which is exactly the kind of 1px mismatch that made the two read as different controls. */
export const RAIL_W = 15;
/** Top-bar control height (Undo/Redo/world pill/Help/collapse). Was an undeclared literal `23`. */
export const TOPBAR_BTN_H = 24;

// Compile-time-ish sanity: keeps the two ways of deriving the body height from drifting.
if (GROUP_PAD_TOP + GROUP_CONTENT_H + GROUP_LABEL_H + GROUP_PAD_BOTTOM !== RIBBON_BODY_HEIGHT) {
  throw new Error("ribbon/tokens: body height does not equal pad + content + label");
}
// Row arithmetic (Stage 14.7's density D.F): three small-button rows + the two gaps between them
// must exactly fill the content box, or a group needing three rows silently doesn't fit.
if (3 * SMALL_H + 2 * ROW_GAP !== LARGE_H || LARGE_H !== GROUP_CONTENT_H) {
  throw new Error("ribbon/tokens: 3×SMALL_H + 2×ROW_GAP must equal LARGE_H must equal GROUP_CONTENT_H");
}

/**
 * Compact command-bar ribbon (UI redesign r3, Stage 14.10, opt-in — never the default). Mirrors
 * the design mock's `--cmd-h`/`--opt-h`: a 32px icon-only command row over a 28px options row,
 * replacing the labelled body's fixed `RIBBON_BODY_HEIGHT` (96) with a much shorter one. See
 * `ribbon/CompactRibbon.tsx` and `ribbonHeight(collapsed, compact)` below.
 */
export const CMD_BAR_H = 32;
export const OPT_BAR_H = 28;
export const COMPACT_BODY_HEIGHT = CMD_BAR_H + OPT_BAR_H;

// ── Scales (Phase 1; type T.A as of Stage 14.7) ────────────────────────────────

export const RADIUS = { sm: 2, md: 3, lg: 5 } as const;
export const FONT = { micro: 10, label: 11, body: 12, tab: 13 } as const;
export const ICON = { xs: 12, sm: 14, lg: 24 } as const;
export const SPACE = { xs: 2, sm: 4, md: 6, lg: 8 } as const;

// ── Surface + border roles ────────────────────────────────────────────────────
//
// Since Stage 14.1 these are `var(--vx-…)` references into the one theme module (`src/theme/`),
// injected as CSS custom properties by `ThemeStyle`. They are CSS-only: never hand one to a canvas
// `fillStyle` (a 2D context can't resolve a var) — canvas code imports hexes from `theme/theme.ts`.

export const SURFACE = {
  topbar: v("surface-topbar"),
  body: v("surface-body"),
  raised: v("surface-raised"),
  hover: v("surface-hover"),
  pressed: v("surface-pressed"),
  popover: v("surface-popover"),
  well: v("surface-well"),
} as const;

export const BORDER = {
  outline: v("border-outline"),
  bevel: v("border-bevel"),
  hairline: v("border-hairline"),
  etchDark: v("border-etchDark"),
  etchLight: v("border-etchLight"),
} as const;

// ── Colour ────────────────────────────────────────────────────────────────────
//
// Text and accent constants stay **hex** (not vars): canvases, `hexToRgbTriplet` and `lighten`
// all consume them. They come from the theme's roles, so there is still exactly one source.

export const TOPBAR_BG = SURFACE.topbar;
export const BODY_BG = SURFACE.body;

export const TEXT = TEXT_ROLES.primary;
export const TEXT_DIM = TEXT_ROLES.secondary;
export const TEXT_LABEL = TEXT_ROLES.label;
/** Quiet *content* (world name in the status bar, versions, timestamps, empty states). Passes AA
 *  on every panel surface. Use this, not `TEXT_DISABLED`, for anything a user is meant to read. */
export const TEXT_META = TEXT_ROLES.meta;
/** Only for controls that can't be used right now (exempt from AA). */
export const TEXT_DISABLED = TEXT_ROLES.disabled;
/** Neutral at rest — accent colour appears only on active/focus states. */
export const ICON_TONE = RAMP.iconTone;
export const ICON_DANGER = RAMP.iconDanger;
export const ICON_ACCENT = RAMP.iconAccent;
/** Danger label text on an untinted button — the readable end of DANGER. */
export const TEXT_DANGER = RAMP.textDanger;

export const HAIRLINE = BORDER.hairline;
export const DIVIDER = BORDER.hairline;

/** The five sanctioned tool-family accent hues. An accent names the tool *family*, not the command. */
export const ACCENT = {
  primary: ACCENTS.primary,
  warm: ACCENTS.warm,
  selection: ACCENTS.selection,
  clipboard: ACCENTS.clipboard,
  violet: ACCENTS.violet,
} as const;
export const DANGER = DANGER_HEX;

/** The one "this is armed" text tone for captions naming the armed tool. */
export const TEXT_ARMED = RAMP.textArmed;
/** Ring on a *selected* swatch. Deliberately not `FOCUS_RING` — selected ≠ focused. */
export const ARMED_RING = ACCENT.primary;

/** Active tab (gloss-lite): merges into the body's top surface stop. */
export const TAB_ACTIVE_TOP = TAB.activeTop;
export const TAB_ACTIVE_BOT = RAMP.body0;

/** Contextual tab accents. Selection is blue now (it glowed warm while its buttons were green). */
export const CTX_ACCENT: Record<string, string> = {
  "3d": ACCENT.violet,
  selection: ACCENT.selection,
  clipboard: ACCENT.clipboard,
};

// ── Button recipes (gloss-lite, Stage 14.2) ───────────────────────────────────

export const BTN_RADIUS = RADIUS.md;

/** Focus ring — one near-white ring app-wide (drawn by the theme stylesheet's `:focus-visible`
 *  rule). Visually distinct from the armed ring, so focused ≠ armed. */
export const FOCUS_RING = FOCUS_HEX;

export function btnBase(extra?: CSSProperties): CSSProperties {
  return {
    background: SURFACE.raised,
    boxShadow: v("mat-base-shadow"),
    textShadow: v("mat-text-shadow"),
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

/** The raw fills behind `btnHover`/`btnPressed`, exported because CSS-*string* call sites
 *  (a `<style>` block needing real `:hover`/`:active` pseudo-classes, e.g. the splash screen)
 *  can't consume a `CSSProperties` object — without these they'd fork into copied literals. */
export const GRAD_HOVER = SURFACE.hover;
export const GRAD_PRESSED = SURFACE.pressed;
export const SHADOW_HOVER = v("mat-hover-shadow");
export const SHADOW_PRESSED = v("mat-pressed-shadow");

export function btnHover(extra?: CSSProperties): CSSProperties {
  return { background: GRAD_HOVER, boxShadow: SHADOW_HOVER, ...extra };
}

/** Pressed state — inverted gradient + inner shadow, no transform (would break grid alignment). */
export function btnPressed(extra?: CSSProperties): CSSProperties {
  return { background: GRAD_PRESSED, boxShadow: SHADOW_PRESSED, ...extra };
}

/**
 * Armed/active state, gloss-lite: an accent-lit face with a soft glow. Keeps its old
 * `accent: string` signature; a family hue resolves to that family's emitted CSS vars, any other
 * hex to the same recipe computed in TS (`armedRecipe` — no `color-mix` dependency either way).
 * The label colour is lifted per family until it clears AA (`contrast.test.ts`).
 */
export function btnActive(accent: string = ACCENT.primary, extra?: CSSProperties): CSSProperties {
  const fam = accentFamily(accent);
  if (fam) {
    return {
      background: v(`armed-${fam}-bg`),
      boxShadow: v(`armed-${fam}-shadow`),
      color: v(`armed-${fam}-text`),
      textShadow: "0 1px 0 rgba(0,0,0,.35)",
      ...extra,
    };
  }
  const r = armedRecipe(accent);
  return { background: r.bg, boxShadow: r.shadow, color: r.text, textShadow: "0 1px 0 rgba(0,0,0,.35)", ...extra };
}

/** Disabled: dim + inert, never unmounted, so neighbouring groups don't shift. Always pair with
 *  `aria-disabled` + `tabIndex={-1}` (a `pointerEvents:none` button stays focusable otherwise). */
export const btnDisabled: CSSProperties = { opacity: 0.4, pointerEvents: "none" };

/**
 * "Current item" = **pushed in** (Stage 14.2): the one recipe for the current row of every list or
 * strip — app-menu command column, sidebar tabs, Settings tabs, History's current entry, a
 * dropdown's current option, the selected hotbar slot. A darker well with an inner top shadow and a
 * light lip below, as if the row were a key held down. **No accent strips or underlines.**
 *
 * Prefer the `vx-row` class + `data-cur` attribute (theme stylesheet) where the row also needs a
 * hover lift — inline styles can't express `:hover`. These objects are for the rare static case.
 */
export function currentRow(extra?: CSSProperties): CSSProperties {
  return { background: v("cur-bg"), boxShadow: v("cur-shadow"), color: TEXT, ...extra };
}
/** Hover on a list row — a faint raised lip, the opposite of `currentRow`. */
export function liftRow(extra?: CSSProperties): CSSProperties {
  return { background: v("lift-bg"), boxShadow: v("lift-shadow"), ...extra };
}
/** Icon tint for an icon inside a current row. */
export const CUR_ICON = v("cur-icon");

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
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return hexToRgbTriplet(ACCENTS.primary); // Eden teal fallback
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/** Lift an accent toward white for use as label text on a tinted fill. */
export function lighten(hex: string, amount = 0.55): string {
  const [r, g, b] = hexToRgbTriplet(hex).split(",").map(Number);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}
