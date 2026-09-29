import { describe, it, expect } from "vitest";
import { minRowWidth, rowWidth, solveLayout, TIER_ORDER, tierIndex, type GroupMetrics, type Tier } from "./layout";
import {
  CMD_BAR_H, COMPACT_BODY_HEIGHT, GROUP_CONTENT_H, GROUP_LABEL_H, GROUP_PAD_BOTTOM, GROUP_PAD_TOP,
  LARGE_H, OPT_BAR_H, RIBBON_BODY_HEIGHT, RIBBON_HEIGHT_COLLAPSED, ROW_GAP, SMALL_H, TOP_BAR_HEIGHT,
} from "./tokens";

/** Three equal groups, priority ascending so `c` demotes first, then `b`, then `a`. */
function trio(minTier: GroupMetrics["minTier"] = "popup"): GroupMetrics[] {
  const w = { full: 100, medium: 60, popup: 30 };
  return [
    { id: "a", widths: w, minTier, priority: 0 },
    { id: "b", widths: w, minTier, priority: 1 },
    { id: "c", widths: w, minTier, priority: 2 },
  ];
}

describe("solveLayout", () => {
  it("leaves everything at full when the row already fits", () => {
    expect(solveLayout(trio(), 300)).toEqual({ a: "full", b: "full", c: "full" });
    expect(solveLayout(trio(), 10_000)).toEqual({ a: "full", b: "full", c: "full" });
  });

  it("demotes in priority order, highest priority first", () => {
    // 300 → 260 needs one demotion: the highest-priority group (c).
    expect(solveLayout(trio(), 260)).toEqual({ a: "full", b: "full", c: "medium" });
    // Two demotions: c, then b.
    expect(solveLayout(trio(), 220)).toEqual({ a: "full", b: "medium", c: "medium" });
    // Three: c, b, a — all at medium (180).
    expect(solveLayout(trio(), 180)).toEqual({ a: "medium", b: "medium", c: "medium" });
  });

  it("keeps demoting past medium into compact, still by priority", () => {
    // 180 → 150 needs c to go compact (60+60+30).
    expect(solveLayout(trio(), 150)).toEqual({ a: "medium", b: "medium", c: "popup" });
    expect(solveLayout(trio(), 90)).toEqual({ a: "popup", b: "popup", c: "popup" });
  });

  it("is monotonic — a narrower window never widens a group", () => {
    const groups = trio();
    let prev = solveLayout(groups, 400);
    for (let w = 390; w >= 0; w -= 10) {
      const next = solveLayout(groups, w);
      for (const g of groups) {
        const order = ["full", "medium", "popup"];
        expect(order.indexOf(next[g.id])).toBeGreaterThanOrEqual(order.indexOf(prev[g.id]));
      }
      prev = next;
    }
  });

  it("respects minTier while the rest of the row can absorb the overflow", () => {
    const groups: GroupMetrics[] = [
      { id: "pinned", widths: { full: 100, medium: 60, popup: 30 }, minTier: "full", priority: 9 },
      { id: "other", widths: { full: 100, medium: 60, popup: 30 }, minTier: "popup", priority: 0 },
    ];
    // `pinned` has the highest priority but its floor is full, so `other` absorbs everything.
    expect(solveLayout(groups, 130)).toEqual({ pinned: "full", other: "popup" });
  });

  it("last resort (15.4): collapses floored groups to popup rather than overflow", () => {
    const groups: GroupMetrics[] = [
      { id: "pinned", widths: { full: 100, medium: 60, popup: 30 }, minTier: "full", priority: 9 },
      { id: "other", widths: { full: 100, medium: 60, popup: 30 }, minTier: "popup", priority: 0 },
    ];
    // No longer "stays full and the caller scrolls": the ribbon is overflowX: hidden now.
    expect(solveLayout(groups, 129)).toEqual({ pinned: "popup", other: "popup" });
    expect(solveLayout(groups, 10)).toEqual({ pinned: "popup", other: "popup" });
  });

  it("last resort goes by priority, ignoring minTier, one group at a time", () => {
    const w = { full: 100, medium: 100, popup: 20 };
    const groups: GroupMetrics[] = [
      { id: "a", widths: w, minTier: "full", priority: 0 },
      { id: "b", widths: w, minTier: "medium", priority: 2 },
      { id: "c", widths: w, minTier: "full", priority: 1 },
    ];
    expect(solveLayout(groups, 300)).toEqual({ a: "full", b: "full", c: "full" });
    expect(solveLayout(groups, 299)).toEqual({ a: "full", b: "popup", c: "full" });
    expect(solveLayout(groups, 219)).toEqual({ a: "full", b: "popup", c: "popup" });
    expect(solveLayout(groups, 139)).toEqual({ a: "popup", b: "popup", c: "popup" });
  });

  it("collapses contextual (conditional) groups only after every other group", () => {
    const w = { full: 100, medium: 100, popup: 20 };
    const groups: GroupMetrics[] = [
      { id: "mode", widths: w, minTier: "medium", priority: 0 },
      { id: "slot", widths: w, minTier: "full", priority: 9, conditional: true },
      { id: "cam", widths: w, minTier: "popup", priority: 4 },
    ];
    // cam (graceful), then mode — the lowest-priority *non-contextual* group — before the slot.
    expect(solveLayout(groups, 220)).toEqual({ mode: "full", slot: "full", cam: "popup" });
    expect(solveLayout(groups, 219)).toEqual({ mode: "popup", slot: "full", cam: "popup" });
    expect(solveLayout(groups, 139)).toEqual({ mode: "popup", slot: "popup", cam: "popup" });
  });

  it("never collapses a group whose popup form is no narrower than what it shows", () => {
    const groups: GroupMetrics[] = [
      { id: "tiny", widths: { full: 40, medium: 40, popup: 74 }, minTier: "full", priority: 9 },
      { id: "big", widths: { full: 300, medium: 300, popup: 74 }, minTier: "full", priority: 0 },
    ];
    expect(solveLayout(groups, 200)).toEqual({ tiny: "full", big: "popup" });
    expect(minRowWidth(groups)).toBe(40 + 74);
  });

  it("respects a medium floor", () => {
    const groups: GroupMetrics[] = [
      { id: "palette", widths: { full: 200, medium: 120, popup: 30 }, minTier: "medium", priority: 5 },
      { id: "tail", widths: { full: 100, medium: 60, popup: 30 }, minTier: "popup", priority: 1 },
    ];
    expect(solveLayout(groups, 150)).toEqual({ palette: "medium", tail: "popup" });
  });

  it("handles degenerate inputs", () => {
    expect(solveLayout([], 500)).toEqual({});
    expect(solveLayout(trio(), 0)).toEqual({ a: "popup", b: "popup", c: "popup" });
    const one: GroupMetrics[] = [{ id: "solo", widths: { full: 90, medium: 50, popup: 24 }, minTier: "popup", priority: 0 }];
    expect(solveLayout(one, 100)).toEqual({ solo: "full" });
    expect(solveLayout(one, 60)).toEqual({ solo: "medium" });
    expect(solveLayout(one, 5)).toEqual({ solo: "popup" });
  });

  it("skips a medium tier that is no narrower than full", () => {
    // `wide` measures wider at medium than at full (14.7's harvest found real groups like this):
    // demoting it into medium would grow the row, so it goes straight to compact.
    const groups: GroupMetrics[] = [
      { id: "a", widths: { full: 100, medium: 60, popup: 30 }, minTier: "popup", priority: 0 },
      { id: "wide", widths: { full: 100, medium: 130, popup: 40 }, minTier: "popup", priority: 1 },
    ];
    expect(solveLayout(groups, 190)).toEqual({ a: "full", wide: "popup" });
    // With a medium floor it can't shrink at all, so the other group takes the demotion.
    groups[1].minTier = "medium";
    expect(solveLayout(groups, 190)).toEqual({ a: "medium", wide: "full" });
  });

  it("breaks priority ties by declaration order, deterministically", () => {
    const w = { full: 100, medium: 60, popup: 30 };
    const groups: GroupMetrics[] = [
      { id: "first", widths: w, minTier: "popup", priority: 3 },
      { id: "second", widths: w, minTier: "popup", priority: 3 },
    ];
    expect(solveLayout(groups, 160)).toEqual({ first: "medium", second: "full" });
    expect(solveLayout(groups, 160)).toEqual(solveLayout(groups, 160));
  });
});

// Stage 15.4: the ribbon is `overflowX: hidden`, so "fits" is a correctness property, not a nicety.
describe("solveLayout properties (randomised, seeded)", () => {
  /** mulberry32 — deterministic, so a failure reproduces. */
  function rng(seed: number) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randomRow(r: () => number): GroupMetrics[] {
    const n = 1 + Math.floor(r() * 8);
    return Array.from({ length: n }, (_, i) => {
      const full = 40 + Math.floor(r() * 400);
      // Medium is sometimes *wider* than full (real groups do this — 14.7's harvest).
      const medium = Math.max(30, Math.round(full * (0.5 + r() * 0.7)));
      const popup = r() < 0.9 ? 74 : 58;
      const minTier = TIER_ORDER[Math.floor(r() * 3)];
      return { id: `g${i}`, widths: { full, medium, popup }, minTier, priority: Math.floor(r() * 6), conditional: r() < 0.15 };
    });
  }
  const ORDER: Tier[] = TIER_ORDER;

  it("always fits for any width ≥ the popup-everything minimum", () => {
    const r = rng(15_4);
    for (let trial = 0; trial < 400; trial++) {
      const groups = randomRow(r);
      const min = minRowWidth(groups);
      for (const avail of [min, min + 1, min + 37, min + 250, min * 2, 5000]) {
        expect(rowWidth(groups, solveLayout(groups, avail))).toBeLessThanOrEqual(avail);
      }
    }
  });

  it("is monotonic in width — a narrower row never widens any group", () => {
    const r = rng(42);
    for (let trial = 0; trial < 150; trial++) {
      const groups = randomRow(r);
      let prev = solveLayout(groups, 4000);
      for (let w = 3990; w >= 0; w -= 10) {
        const next = solveLayout(groups, w);
        for (const g of groups) expect(tierIndex(next[g.id])).toBeGreaterThanOrEqual(tierIndex(prev[g.id]));
        prev = next;
      }
    }
  });

  it("doesn't collapse past a group's floor while the graceful pass alone would fit", () => {
    const r = rng(7);
    for (let trial = 0; trial < 300; trial++) {
      const groups = randomRow(r);
      // The graceful floor state: each group at the narrowest tier its minTier allows.
      const floorW = groups.reduce((s, g) =>
        s + Math.min(...ORDER.slice(0, tierIndex(g.minTier) + 1).map(t => g.widths[t])), 0);
      const t = solveLayout(groups, floorW);
      for (const g of groups) expect(tierIndex(t[g.id])).toBeLessThanOrEqual(tierIndex(g.minTier));
    }
  });
});

// Stage 14.7 (density D.F): the two ways of deriving the ribbon's fixed geometry — the body-height
// sum and the three-small-rows-fill-one-large-button row arithmetic — must never drift apart.
// `ribbon/tokens.ts` already throws at import time if either fails; this test is the automated
// coverage the plan's §5.7 asks for, independent of that throw (so a change to the throw's own
// condition can't silently stop guarding the numbers).
describe("ribbon geometry invariants", () => {
  it("the body height equals pad + content + label", () => {
    expect(GROUP_PAD_TOP + GROUP_CONTENT_H + GROUP_LABEL_H + GROUP_PAD_BOTTOM).toBe(RIBBON_BODY_HEIGHT);
  });

  it("three small rows plus their gaps equal one large button equal the content box", () => {
    expect(3 * SMALL_H + 2 * ROW_GAP).toBe(LARGE_H);
    expect(LARGE_H).toBe(GROUP_CONTENT_H);
  });

  it("matches density D.F's numbers exactly (plan §1 Decisions)", () => {
    expect({ RIBBON_BODY_HEIGHT, GROUP_PAD_TOP, GROUP_CONTENT_H, GROUP_LABEL_H, GROUP_PAD_BOTTOM, SMALL_H, LARGE_H, ROW_GAP })
      .toEqual({ RIBBON_BODY_HEIGHT: 96, GROUP_PAD_TOP: 3, GROUP_CONTENT_H: 76, GROUP_LABEL_H: 15, GROUP_PAD_BOTTOM: 2, SMALL_H: 24, LARGE_H: 76, ROW_GAP: 2 });
  });
});

// Stage 14.10: `ribbonHeight(collapsed, compact)` (`Ribbon.tsx`) is a two-line function over these
// same constants — reimplemented here (rather than importing the component, which would drag in
// the whole ribbon shell's dependency tree) so the table it produces is still covered.
function ribbonHeightTable(collapsed: boolean, compact: boolean): number {
  if (collapsed) return RIBBON_HEIGHT_COLLAPSED;
  return TOP_BAR_HEIGHT + (compact ? COMPACT_BODY_HEIGHT : RIBBON_BODY_HEIGHT);
}

describe("compact ribbon geometry (Stage 14.10)", () => {
  it("the command bar + options bar rows sum to the compact body height", () => {
    expect(CMD_BAR_H + OPT_BAR_H).toBe(COMPACT_BODY_HEIGHT);
  });

  it("ribbonHeight table: collapsed always wins, compact is shorter than labelled, never negative", () => {
    expect(ribbonHeightTable(true, false)).toBe(RIBBON_HEIGHT_COLLAPSED);
    expect(ribbonHeightTable(true, true)).toBe(RIBBON_HEIGHT_COLLAPSED);
    expect(ribbonHeightTable(false, false)).toBe(TOP_BAR_HEIGHT + RIBBON_BODY_HEIGHT);
    expect(ribbonHeightTable(false, true)).toBe(TOP_BAR_HEIGHT + COMPACT_BODY_HEIGHT);
    expect(ribbonHeightTable(false, true)).toBeLessThan(ribbonHeightTable(false, false));
    expect(ribbonHeightTable(false, true)).toBeGreaterThan(RIBBON_HEIGHT_COLLAPSED);
  });
});
