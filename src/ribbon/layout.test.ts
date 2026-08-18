import { describe, it, expect } from "vitest";
import { solveLayout, type GroupMetrics } from "./layout";

/** Three equal groups, priority ascending so `c` demotes first, then `b`, then `a`. */
function trio(minTier: GroupMetrics["minTier"] = "compact"): GroupMetrics[] {
  const w = { full: 100, medium: 60, compact: 30 };
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
    expect(solveLayout(trio(), 150)).toEqual({ a: "medium", b: "medium", c: "compact" });
    expect(solveLayout(trio(), 90)).toEqual({ a: "compact", b: "compact", c: "compact" });
  });

  it("is monotonic — a narrower window never widens a group", () => {
    const groups = trio();
    let prev = solveLayout(groups, 400);
    for (let w = 390; w >= 0; w -= 10) {
      const next = solveLayout(groups, w);
      for (const g of groups) {
        const order = ["full", "medium", "compact"];
        expect(order.indexOf(next[g.id])).toBeGreaterThanOrEqual(order.indexOf(prev[g.id]));
      }
      prev = next;
    }
  });

  it("respects minTier — a full-only group never shrinks", () => {
    const groups: GroupMetrics[] = [
      { id: "pinned", widths: { full: 100, medium: 60, compact: 30 }, minTier: "full", priority: 9 },
      { id: "other", widths: { full: 100, medium: 60, compact: 30 }, minTier: "compact", priority: 0 },
    ];
    // `pinned` has the highest priority but cannot demote, so `other` absorbs everything.
    expect(solveLayout(groups, 130)).toEqual({ pinned: "full", other: "compact" });
    // Even far below the minimum it stays full — the caller falls back to scrolling.
    expect(solveLayout(groups, 10)).toEqual({ pinned: "full", other: "compact" });
  });

  it("respects a medium floor", () => {
    const groups: GroupMetrics[] = [
      { id: "palette", widths: { full: 200, medium: 120, compact: 30 }, minTier: "medium", priority: 5 },
      { id: "tail", widths: { full: 100, medium: 60, compact: 30 }, minTier: "compact", priority: 1 },
    ];
    expect(solveLayout(groups, 150)).toEqual({ palette: "medium", tail: "compact" });
  });

  it("handles degenerate inputs", () => {
    expect(solveLayout([], 500)).toEqual({});
    expect(solveLayout(trio(), 0)).toEqual({ a: "compact", b: "compact", c: "compact" });
    const one: GroupMetrics[] = [{ id: "solo", widths: { full: 90, medium: 50, compact: 24 }, minTier: "compact", priority: 0 }];
    expect(solveLayout(one, 100)).toEqual({ solo: "full" });
    expect(solveLayout(one, 60)).toEqual({ solo: "medium" });
    expect(solveLayout(one, 5)).toEqual({ solo: "compact" });
  });

  it("breaks priority ties by declaration order, deterministically", () => {
    const w = { full: 100, medium: 60, compact: 30 };
    const groups: GroupMetrics[] = [
      { id: "first", widths: w, minTier: "compact", priority: 3 },
      { id: "second", widths: w, minTier: "compact", priority: 3 },
    ];
    expect(solveLayout(groups, 160)).toEqual({ first: "medium", second: "full" });
    expect(solveLayout(groups, 160)).toEqual(solveLayout(groups, 160));
  });
});
