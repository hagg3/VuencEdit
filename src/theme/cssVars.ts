/**
 * Serves the theme as CSS custom properties (`--vx-…`), plus the handful of app-wide rules that
 * need a real stylesheet (focus ring, body colours, the "current row" pseudo-class recipes).
 *
 * Inline-style recipes (`btnBase`, `currentRow`, …) return `var(--vx-…)` references built with
 * `v()`. ⚠️ A `var()` naming a property that was never emitted fails **silently** to `unset` —
 * a transparent button, no error anywhere — so `v()` is typed against `VARS`' keys and
 * `cssVars.test.ts` additionally scans every recipe's output for stray names.
 *
 * Pure (no React, no DOM): node vitest loads it.
 */
import {
  ACCENTS, BORDER_ROLES, DANGER_HEX, FOCUS_HEX, MATERIAL, MODAL_TEXT_ROLES, MOTION, SCROLLBAR_ROLE, SURFACE_ROLES, TEXT_ROLES,
  armedRecipe, type AccentName,
} from "./theme";

function build() {
  const out: Record<string, string> = {};
  for (const [k, r] of Object.entries(SURFACE_ROLES)) out[`surface-${k}`] = r.css;
  for (const [k, c] of Object.entries(BORDER_ROLES)) out[`border-${k}`] = c;
  for (const [k, c] of Object.entries(SCROLLBAR_ROLE)) out[`scrollbar-${k}`] = c;
  for (const [k, c] of Object.entries(TEXT_ROLES)) out[`text-${k}`] = c;
  for (const [k, c] of Object.entries(MODAL_TEXT_ROLES)) out[`modal-text-${k}`] = c;
  for (const [k, c] of Object.entries(ACCENTS)) {
    out[`accent-${k}`] = c;
    const a = armedRecipe(c);
    out[`armed-${k}-bg`] = a.bg;
    out[`armed-${k}-shadow`] = a.shadow;
    out[`armed-${k}-text`] = a.text;
  }
  out["danger"] = DANGER_HEX;
  out["focus"] = FOCUS_HEX;
  out["mat-base-shadow"] = MATERIAL.base.shadow;
  out["mat-text-shadow"] = MATERIAL.base.textShadow;
  out["mat-hover-shadow"] = MATERIAL.hover.shadow;
  out["mat-pressed-shadow"] = MATERIAL.pressed.shadow;
  out["cur-bg"] = MATERIAL.current.bg;
  out["cur-shadow"] = MATERIAL.current.shadow;
  out["cur-icon"] = MATERIAL.current.icon;
  out["lift-bg"] = MATERIAL.lift.bg;
  out["lift-shadow"] = MATERIAL.lift.shadow;
  out["pop-shadow"] = MATERIAL.popShadow;
  return out;
}

/** Every emitted custom property, without the `--vx-` prefix. */
export const VARS: Readonly<Record<string, string>> = build();

type SurfaceVar = `surface-${keyof typeof SURFACE_ROLES}`;
type BorderVar = `border-${keyof typeof BORDER_ROLES}`;
type ScrollbarVar = `scrollbar-${keyof typeof SCROLLBAR_ROLE}`;
type TextVar = `text-${keyof typeof TEXT_ROLES}`;
type ModalTextVar = `modal-text-${keyof typeof MODAL_TEXT_ROLES}`;
type AccentVar = `accent-${AccentName}` | `armed-${AccentName}-${"bg" | "shadow" | "text"}`;
export type VarName =
  | SurfaceVar | BorderVar | ScrollbarVar | TextVar | ModalTextVar | AccentVar
  | "danger" | "focus"
  | "mat-base-shadow" | "mat-text-shadow" | "mat-hover-shadow" | "mat-pressed-shadow"
  | "cur-bg" | "cur-shadow" | "cur-icon" | "lift-bg" | "lift-shadow" | "pop-shadow";

/** `var(--vx-<name>)`. Typed, so a misspelt role is a compile error rather than a clear button. */
export function v(name: VarName): string {
  return `var(--vx-${name})`;
}

/** Which family (if any) a hex is — lets `btnActive(hex)` return var references for families. */
export function accentFamily(hex: string): AccentName | null {
  const h = hex.toLowerCase();
  for (const [k, c] of Object.entries(ACCENTS)) if (c.toLowerCase() === h) return k as AccentName;
  return null;
}

/**
 * The app-wide stylesheet, injected once by `ThemeStyle` above `<App/>` (so the splash, which
 * mounts without the ribbon, gets it too).
 *
 * ⚠️ The focus rule is `!important` on purpose: nearly every control sets an *inline*
 * `outline: none` (the recipes' reset), and an inline style beats any selector that isn't
 * `!important`. Before this, the ribbon's own `:focus-visible` rule was losing to exactly that.
 * `:focus-visible` still never matches a mouse click on a button, so this draws nothing for mouse
 * users. Opt out with `data-no-focus-ring` (a field that draws its own focus, e.g. ⌘K's input).
 */
export const THEME_CSS = `
:root {
${Object.entries(VARS).map(([k, val]) => `  --vx-${k}: ${val};`).join("\n")}
}
body { background: var(--vx-surface-bg0); color: var(--vx-text-primary); }
:focus-visible:not([data-no-focus-ring]) {
  outline: 2px solid var(--vx-focus) !important;
  outline-offset: 1px;
}
/* NumberField rocker: replaces the OS spin buttons with a stacked ▲▼ pair no taller than macOS's
   (two 9px halves inside a 20px field). Quiet at rest, lit on hover/press. */
.vx-numfield input::-webkit-inner-spin-button,
.vx-numfield input::-webkit-outer-spin-button { -webkit-appearance: none; appearance: none; margin: 0; }
.vx-numfield input { -moz-appearance: textfield; appearance: textfield; }
.vx-rocker {
  position: absolute; top: 50%; right: 2px; width: 11px; height: 18px; margin-top: -9px;
  display: flex; flex-direction: column; gap: 0;
}
.vx-rocker button {
  all: unset; box-sizing: border-box; flex: 1 1 0; min-height: 0; display: flex; align-items: center;
  justify-content: center; color: var(--vx-text-meta); cursor: default; border-radius: 2px;
}
.vx-rocker button:hover:not(:disabled) { background: var(--vx-surface-hover); color: var(--vx-text-primary); }
.vx-rocker button:active:not(:disabled) { background: var(--vx-surface-pressed); }
.vx-numfield[data-disabled] .vx-rocker { opacity: .4; }
/* List rows (Stage 14.2): current = pushed in, hover = a faint lift. Never both. */
.vx-row { border-radius: 4px; }
.vx-row:not([data-cur]):not([aria-disabled="true"]):hover {
  background: var(--vx-lift-bg) !important;
  box-shadow: var(--vx-lift-shadow) !important;
}
.vx-row[data-cur] { background: var(--vx-cur-bg) !important; box-shadow: var(--vx-cur-shadow) !important; }
.vx-row[data-cur] .vx-ico { color: var(--vx-cur-icon); }
/* Completion outline (Stage 14.13, src/ui/DoneOutline.tsx): a 400ms-max flash around a just-edited
   world-rect. Transform/opacity only, gated on data-motion="full" (src/theme/motion.ts) — under
   "reduced" the div still appears and disappears (its own JS timeout unmounts it either way), it
   just doesn't animate the transition. No @media (prefers-reduced-motion) block — see that file's
   header for why one is never added here. */
:root[data-motion="full"] .vx-done-outline {
  animation: vxDoneOutline ${MOTION.doneMs}ms ${MOTION.easeExit} both;
}
@keyframes vxDoneOutline {
  0%   { opacity: 0; transform: scale(0.97); }
  12%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1); }
}
`;
