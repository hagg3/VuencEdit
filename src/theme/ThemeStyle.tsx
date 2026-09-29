import { THEME_CSS } from "./cssVars";

/**
 * Injects the theme's custom properties + app-wide rules once. Mounted in `main.tsx` *above*
 * `<App/>`, so it covers both of App's returns (the editor and the splash — the reason
 * `SPLASH_CSS` has to exist is that the ribbon, and with it `RIBBON_CSS`, isn't mounted before a
 * world loads) as well as anything an `ErrorBoundary` falls back to.
 */
export default function ThemeStyle() {
  return <style>{THEME_CSS}</style>;
}
