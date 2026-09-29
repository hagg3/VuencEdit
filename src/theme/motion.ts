/**
 * The one motion-preference resolver in the app (UI redesign r3, Stage 14.13). Two inputs feed it:
 * the OS's `prefers-reduced-motion` media query, and an explicit `AppSettings.motion` override
 * ("system" defers to the OS; "reduced"/"full" force it regardless). The result is written to
 * `document.documentElement.dataset.motion` as a side effect — the single thing CSS reads:
 * `:root[data-motion="full"] .x { … }` rules are how an animation opts in, and the *absence* of
 * `data-motion="full"` (i.e. it's unset, or `"reduced"`) means static. No CSS ever needs its own
 * media query.
 *
 * ⚠️ **This is a JS gate, not a `@media (prefers-reduced-motion)` block, and that is load-bearing.**
 * `DOCUMENTATION/09-frontend.md`'s "Onboarding tour" section records a real WKWebView freeze caused
 * by exactly that pattern — a `@media (prefers-reduced-motion: reduce) { animation: none !important }`
 * rule inside an injected `<style>` block froze the whole app on a real device with Reduce Motion
 * on, for reasons never fully chased down (the leading suspect is a WKWebView-specific interaction
 * between `@media`, an injected `<style>`, and `!important`). The tour worked around it by deciding
 * the animation class in JS instead of CSS; this module is the same idea generalised to the rest of
 * the app, so every other motion-gated recipe (Popover enter, the contextual-tab fade, the
 * completion outline, and the tour's own pulse) shares one resolver instead of five copies of the
 * workaround.
 *
 * `resolveMotion` is deliberately pure (no DOM) so it's unit-testable in this repo's node-only
 * vitest setup — see `motion.test.ts`, the `ribbon/layout.test.ts` idiom.
 */
import { useEffect, useState } from "react";
import type { AppSettings } from "../SettingsModal";

export type EffectiveMotion = "full" | "reduced";

/** Pure: system × setting → effective state. An explicit setting always wins over the OS. */
export function resolveMotion(systemReduced: boolean, setting: AppSettings["motion"]): EffectiveMotion {
  if (setting === "full") return "full";
  if (setting === "reduced") return "reduced";
  return systemReduced ? "reduced" : "full";
}

function systemPrefersReducedMotion(): boolean {
  try { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; }
  catch { return false; }
}

/**
 * Resolves the effective motion state for `setting` (the live `AppSettings.motion` value — pass
 * `loadSettings().motion` or a mirrored `useState`, per the app's usual settings-mirroring idiom)
 * and mirrors it onto `<html data-motion>`. Re-resolves live if the OS setting changes underneath
 * the app (a `change` listener on the media query — some platforms let you flip Reduce Motion
 * without restarting the app) or if `setting` itself changes (a Settings ▸ General edit). Called
 * from more than one component is fine and idempotent — every caller derives the same value from
 * the same OS query, so the last write always agrees with the others.
 */
export function useMotionPref(setting: AppSettings["motion"]): EffectiveMotion {
  const [systemReduced, setSystemReduced] = useState(systemPrefersReducedMotion);

  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try { mq = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { mq = null; }
    if (!mq) return;
    // WKWebView and WebView2 both support the modern `change` event — no legacy addListener fallback.
    const onChange = () => setSystemReduced(mq!.matches);
    mq.addEventListener("change", onChange);
    return () => mq!.removeEventListener("change", onChange);
  }, []);

  const effective = resolveMotion(systemReduced, setting);

  useEffect(() => {
    document.documentElement.dataset.motion = effective;
  }, [effective]);

  return effective;
}
