// Modal chrome recipes. Since UI redesign r3 (Stage 14.1) these are re-backed by the theme module
// (`src/theme/`): the warm modal glass is **the official second surface** (`surface.modal`, with
// its own AA text ramp `modalText.*`), not a leftover. The app menu moved off it onto the slate
// popover material. Every dialog now renders through `src/ui/Dialog.tsx`, which owns the actual
// panel/button chrome (`glassPanel`/`chromeButton`/`chromeButtonAccent`/`glassTab`/`glassMenuPanel`
// and `EDEN_TEAL_READABLE` were retired with Stage 14.17's last caller) — this file is down to the
// backdrop scrim, the modal text ramp, and small stateless recipes (badges, the spinner, the well
// input chrome, the accent-ring helper) that `Dialog`-based bodies still reach for directly.
import type { CSSProperties } from "react";
import { ACCENTS, MODAL_TEXT_ROLES, RAMP, mix } from "./theme/theme";

/** Modal text ramp (warm). Every step passes AA on both modal surfaces (contrast.test.ts). */
export const MODAL_TEXT = MODAL_TEXT_ROLES;

export const EDEN_TEAL = "0,164,173";

/** Lightened teal tint (same recipe as `AboutPanel.tsx`'s `TEAL_LIGHT`, replacing the retired
 *  `EDEN_TEAL_READABLE` — UI redesign r3, Stage 14.17 cleanup) for the loading spinner, which
 *  renders on both the warm modal surface and the slate popover material. */
const TEAL_LIGHT = mix(RAMP.white, ACCENTS.primary, 0.5);

// Dialog/panel backdrop — dims + very slightly blurs the app behind a modal.
export const glassBackdrop: CSSProperties = {
  position: "fixed", inset: 0, zIndex: 1000,
  background: "rgba(12,7,4,0.6)",
  backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)",
  display: "flex", alignItems: "center", justifyContent: "center",
};

/**
 * Accent hairline for a `chromeButton`. ⚠️ Chrome buttons set `border: none` and draw their
 * outline as an inset box-shadow, so a `borderColor: "#f59e0b"` override spread over one is
 * *inert* — it styles a border that isn't there. Spread this instead:
 *   `{ ...rb, ...accentRing("#f59e0b"), color: "#fcd34d" }`
 */
export function accentRing(accent: string, extra?: CSSProperties): CSSProperties {
  return {
    boxShadow: `inset 0 0 0 1px ${accent}, 0 .5px .5px rgba(255,255,255,.2)`,
    ...extra,
  };
}

// Recessed "well" chrome for text inputs / selects.
export const recessedWell: CSSProperties = {
  background: "rgba(0,0,0,0.35)", border: "none",
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4), inset 0 2px 3px rgba(0,0,0,.35)",
};

export function menuHoverOn(e: React.MouseEvent<HTMLElement>) { e.currentTarget.style.background = "rgba(255,255,255,.07)"; }
export function menuHoverOff(e: React.MouseEvent<HTMLElement>) { e.currentTarget.style.background = ""; }

// Experimental-feature badge ("exp") — amber. One shared style so every "exp" tag
// across the app (Ribbon, New World, World Browser, app menu) renders identically.
export function expBadge(extra?: CSSProperties): CSSProperties {
  return {
    fontSize: 8, color: RAMP.badgeExpModal, background: "rgba(245,158,11,0.12)",
    border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px",
    ...extra,
  };
}

// Perf-heavy feature badge ("⚡") — red-tinted, distinct from `expBadge` so a GPU/CPU-costly
// toggle (night lighting, shadows) reads differently from a merely-experimental one.
export function perfBadge(extra?: CSSProperties): CSSProperties {
  return {
    fontSize: 8, color: RAMP.badgePerfModal, background: "rgba(248,113,113,0.12)",
    border: "1px solid rgba(248,113,113,0.35)", borderRadius: 3, padding: "0 3px", lineHeight: "14px",
    ...extra,
  };
}

// Work-in-progress badge ("WIP") — same amber family as `expBadge` (WIP is a variant of
// "not finished", not a different concept) but its own label so the two aren't conflated.
export function wipBadge(extra?: CSSProperties): CSSProperties {
  return expBadge(extra);
}

// Shared teal-tinted loading spinner style — pairs with the `eden-spin`
// keyframe in App.css. Render as `<div style={spinnerStyle(20)} />` for any
// inline/overlay loading state instead of ad-hoc divs.
export function spinnerStyle(size = 20, extra?: CSSProperties): CSSProperties {
  return {
    width: size, height: size,
    border: "2px solid rgba(255,255,255,0.08)",
    borderTopColor: TEAL_LIGHT,
    borderRadius: "50%",
    animation: "eden-spin 0.7s linear infinite",
    ...extra,
  };
}
