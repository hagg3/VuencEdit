// Shared "X Design System" chrome recipes — dense adaptation (see Ribbon.tsx
// header comment). Buttons/panels/menus across modals reuse these so the
// whole app reads as one consistent glass/gradient chrome language.
import type { CSSProperties } from "react";

export const EDEN_TEAL = "0,164,173";
export const EDEN_TEAL_READABLE = "#00dde9";

// Dialog/panel backdrop — dims + very slightly blurs the app behind a modal.
export const glassBackdrop: CSSProperties = {
  position: "fixed", inset: 0, zIndex: 1000,
  background: "rgba(4,7,12,0.6)",
  backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)",
  display: "flex", alignItems: "center", justifyContent: "center",
};

// Glass panel chrome for modal bodies — gradient fill, bright top hairline,
// deep inner vignette, teal-tinted outer glow ring.
export function glassPanel(extra?: CSSProperties): CSSProperties {
  return {
    background: "linear-gradient(180deg, rgb(24,30,42) 0%, rgb(15,19,27) 100%)",
    boxShadow: `inset 0 1px 0 rgba(255,255,255,.06), inset 0 0 30px rgba(0,0,0,.35), 0 20px 50px rgba(0,0,0,.5), 0 0 0 1px rgba(${EDEN_TEAL},.12)`,
    borderRadius: 10,
    ...extra,
  };
}

// Neutral gradient chrome button (matches Ribbon's `rb`).
export function chromeButton(extra?: CSSProperties): CSSProperties {
  return {
    background: "linear-gradient(180deg, rgb(46,58,82) 0%, rgb(26,34,52) 100%)",
    border: "none",
    boxShadow: "inset 0 0 0 1px rgba(0,0,0,.5), 0 .5px .5px rgba(255,255,255,.15)",
    color: "#cbd5e1", borderRadius: 6, cursor: "pointer", outline: "none",
    ...extra,
  };
}

// Accent-tinted "primary" chrome button — pass an accent hex + its rgb triplet.
export function chromeButtonAccent(rgb: string, accent: string, extra?: CSSProperties): CSSProperties {
  return {
    background: `linear-gradient(180deg, rgba(${rgb},0.32) 0%, rgba(${rgb},0.10) 100%)`,
    border: "none",
    boxShadow: `inset 0 0 0 1px ${accent}, 0 .5px .5px rgba(255,255,255,.2)`,
    borderRadius: 6, cursor: "pointer", outline: "none",
    ...extra,
  };
}

// Recessed "well" chrome for text inputs / selects.
export const recessedWell: CSSProperties = {
  background: "rgba(0,0,0,0.35)", border: "none",
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4), inset 0 2px 3px rgba(0,0,0,.35)",
};

// Glass dropdown/context-menu panel (matches Ribbon's `dropStyle`).
export const glassMenuPanel: CSSProperties = {
  background: "linear-gradient(180deg, rgba(20,30,48,.95) 0%, rgba(10,16,28,.95) 100%)",
  backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
  border: "1px solid rgba(255,255,255,.12)",
  borderRadius: 6,
  boxShadow: `0 10px 28px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,.06), 0 0 0 1px rgba(${EDEN_TEAL},.15)`,
};

export function menuHoverOn(e: React.MouseEvent<HTMLElement>) { e.currentTarget.style.background = `rgba(${EDEN_TEAL},0.18)`; }
export function menuHoverOff(e: React.MouseEvent<HTMLElement>) { e.currentTarget.style.background = ""; }

// Tab strip for modal-internal tabs (New World, Help, etc.) — same idiom as
// the ribbon's top-level tabs: gradient fill + accent framing the top corners.
export function glassTab(active: boolean, accent = `rgb(${EDEN_TEAL})`, accentRgb = EDEN_TEAL): CSSProperties {
  return {
    background: active
      ? `linear-gradient(180deg, rgba(${accentRgb},0.30) 0%, rgba(${accentRgb},0.09) 45%, rgb(15,19,27) 100%)`
      : "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
    border: "none",
    borderTop: `1px solid ${active ? accent : "transparent"}`,
    borderLeft: `1px solid ${active ? `rgba(${accentRgb},0.7)` : "transparent"}`,
    borderRight: `1px solid ${active ? `rgba(${accentRgb},0.7)` : "transparent"}`,
    boxShadow: active
      ? `inset 0 1px 0 rgba(255,255,255,.12), inset -1px 0 0 rgba(${accentRgb},.25), inset 1px 0 0 rgba(${accentRgb},.25)`
      : "none",
    cursor: "pointer", outline: "none",
  };
}

// Shared teal-tinted loading spinner style — pairs with the `eden-spin`
// keyframe in App.css. Render as `<div style={spinnerStyle(20)} />` for any
// inline/overlay loading state instead of ad-hoc divs.
export function spinnerStyle(size = 20, extra?: CSSProperties): CSSProperties {
  return {
    width: size, height: size,
    border: "2px solid rgba(255,255,255,0.08)",
    borderTopColor: EDEN_TEAL_READABLE,
    borderRadius: "50%",
    animation: "eden-spin 0.7s linear infinite",
    ...extra,
  };
}
