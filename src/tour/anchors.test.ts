import { describe, it, expect } from "vitest";
import { TOUR_ANCHORS, TOUR_STEPS } from "./steps";

/** Every non-test `.ts`/`.tsx` under src/ concatenated (the `ui/dialogs.test.ts` glob idiom) — the
 *  attributes a selector names must be set somewhere in it, or the step silently falls back to a
 *  centred card. */
const SRC = Object.values(
  import.meta.glob<string>(["../**/*.tsx", "../**/*.ts", "!../**/*.test.ts"], { query: "?raw", import: "default", eager: true }),
).join("\n");

describe("tour anchors", () => {
  it("every data-tour / data-group / aria-label a selector names exists in the source", () => {
    for (const [name, sel] of Object.entries(TOUR_ANCHORS)) {
      const tour = sel.match(/data-tour="([^"]+)"/)?.[1];
      // `dataTour="x"` (FloatingWindow prop) and `data-tour="x"` (raw attribute) are both owners.
      if (tour) expect(SRC.includes(`data-tour="${tour}"`) || SRC.includes(`dataTour="${tour}"`), `${name}: data-tour ${tour}`).toBe(true);
      const group = sel.match(/data-group="([^"]+)"/)?.[1];
      if (group) expect(SRC.includes(`id="${group}"`) || SRC.includes(`g("${group}"`), `${name}: group ${group}`).toBe(true);
      const aria = sel.match(/aria-label="([^"]+)"/)?.[1];
      if (aria) expect(SRC.includes(`aria-label="${aria}"`) || SRC.includes(`aria-label={"${aria}"}`), `${name}: aria-label ${aria}`).toBe(true);
    }
  });

  it("steps only target registered anchors (no stray inline selectors)", () => {
    const known = new Set<string>(Object.values(TOUR_ANCHORS));
    for (const step of TOUR_STEPS) {
      for (const sel of [step.target, ...(step.secondaryTargets ?? [])]) {
        if (sel) expect(known.has(sel), `${step.id}: ${sel}`).toBe(true);
      }
    }
  });

  it("step ids are unique", () => {
    const ids = TOUR_STEPS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
