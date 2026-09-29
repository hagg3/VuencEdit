import { describe, it, expect } from "vitest";
import {
  AA, ACCENTS, CONTRAST_PAIRS, MATERIAL, MODAL_TEXT_ROLES, SURFACE_ROLES, TEXT_ROLES,
  armedRecipe, composite, contrastRatio, type SurfaceName,
} from "./theme";

/**
 * The palette's accessibility gate (Stage 14.1). WCAG 2.1 contrast for every text role against
 * every surface it is *allowed* on (`CONTRAST_PAIRS`, declared next to the tokens so the design
 * rule and the test can't drift), ≥ 4.5:1. `disabled` is exempt (WCAG 1.4.3 inactive components).
 *
 * Gradients are tested at each stop (worst case wins); translucent surfaces are alpha-composited
 * over their declared parent first — `well` is rgba(0,0,0,.3) painted over `body`, and is tested
 * over each of `body`'s stops.
 */

/** Every opaque colour a surface can present under text. */
function opaqueStops(name: SurfaceName): string[] {
  const r = SURFACE_ROLES[name];
  if (r.over == null) return [...r.stops];
  const parent = opaqueStops(r.over as SurfaceName);
  return r.stops.flatMap(s => parent.map(p => composite(s, r.alpha ?? 1, p)));
}

function worst(text: string, stops: string[]): { ratio: number; stop: string } {
  let w = { ratio: Infinity, stop: "" };
  for (const s of stops) {
    const r = contrastRatio(text, s);
    if (r < w.ratio) w = { ratio: r, stop: s };
  }
  return w;
}

describe("theme contrast (WCAG AA, 4.5:1)", () => {
  for (const pair of CONTRAST_PAIRS) {
    const ramp: Record<string, string> = pair.ramp === "modal" ? MODAL_TEXT_ROLES : TEXT_ROLES;
    for (const surface of pair.surfaces) {
      for (const role of pair.texts) {
        it(`${pair.ramp} text.${role} on surface.${surface}`, () => {
          const w = worst(ramp[role], opaqueStops(surface));
          expect(w.ratio, `${ramp[role]} on ${w.stop} = ${w.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA);
        });
      }
    }
  }

  it("covers every non-disabled text role on at least one surface", () => {
    const covered = new Set(CONTRAST_PAIRS.filter(p => p.ramp === "chrome").flatMap(p => p.texts));
    for (const role of Object.keys(TEXT_ROLES)) {
      if (role === "disabled") continue;
      expect(covered.has(role), `text.${role} is never tested`).toBe(true);
    }
  });

  it("meta passes where disabled used to be used for content (status bar, splash)", () => {
    for (const s of ["topbar", "body", "bg0"] as SurfaceName[]) {
      expect(worst(TEXT_ROLES.meta, opaqueStops(s)).ratio).toBeGreaterThanOrEqual(AA);
    }
  });

  // Open question 7, answered "lighten the text": the armed label must clear AA against the part of
  // the armed gradient a label actually sits on (the stops at ≥ 50 %; the 0 % stop is the top-edge
  // highlight of the bevel). `armedRecipe` lifts the text per family until it does.
  for (const [name, hex] of Object.entries(ACCENTS)) {
    it(`armed label, family ${name}`, () => {
      const r = armedRecipe(hex);
      const w = worst(r.text, [...r.labelStops]);
      expect(w.ratio, `${r.text} on ${w.stop} = ${w.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA);
    });
  }

  it("armed label clears AA for an arbitrary non-family accent too", () => {
    for (const hex of ["#f59e0b", "#22c55e", "#ef4444", "#38bdf8"]) {
      const r = armedRecipe(hex);
      expect(worst(r.text, [...r.labelStops]).ratio).toBeGreaterThanOrEqual(AA);
    }
  });

  // Stage 14.2: the pushed-in current row composited over the surfaces rows live on.
  for (const s of ["popover", "body", "modal"] as SurfaceName[]) {
    it(`current-row text on cur-bg over surface.${s}`, () => {
      const stops = opaqueStops(s).map(p => composite("#000000", MATERIAL.current.alpha, p));
      const text = s === "modal" ? MODAL_TEXT_ROLES.primary : TEXT_ROLES.primary;
      expect(worst(text, stops).ratio).toBeGreaterThanOrEqual(AA);
      expect(worst(MATERIAL.current.icon, stops).ratio).toBeGreaterThanOrEqual(AA);
    });
  }
});
