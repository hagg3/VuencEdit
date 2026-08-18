import { describe, expect, it } from "vitest";
import { gridDivisions, slabFetchWindow, tileWindowFits } from "./viewportUtils";

describe("slabFetchWindow", () => {
  it("planeW === 0 returns a degenerate zero window", () => {
    expect(slabFetchWindow({ planeW: 0, selRange: null, winOrigin: 0, maxWin: 2048 })).toEqual({ lo: 0, hi: 0 });
    expect(slabFetchWindow({ planeW: 0, selRange: { lo: 5, hi: 10 }, winOrigin: 0, maxWin: 2048 })).toEqual({ lo: 0, hi: 0 });
  });

  it("free-scroll path: window is maxWin-wide, clamped to the plane, anchored at winOrigin", () => {
    const { lo, hi } = slabFetchWindow({ planeW: 10000, selRange: null, winOrigin: 500, maxWin: 2048 });
    expect(lo).toBe(500);
    expect(hi).toBe(500 + 2048 - 1);
  });

  it("free-scroll path: winOrigin clamped so the window never runs past the plane", () => {
    const { lo, hi } = slabFetchWindow({ planeW: 10000, selRange: null, winOrigin: 9000, maxWin: 2048 });
    expect(hi).toBe(9999);
    expect(lo).toBe(9999 - 2048 + 1);
  });

  it("free-scroll path: plane narrower than maxWin covers the whole plane", () => {
    const { lo, hi } = slabFetchWindow({ planeW: 500, selRange: null, winOrigin: 0, maxWin: 2048 });
    expect(lo).toBe(0);
    expect(hi).toBe(499);
  });

  it("selection-scoped: small selection gets 50% context each side", () => {
    const { lo, hi } = slabFetchWindow({ planeW: 10000, selRange: { lo: 100, hi: 109 }, winOrigin: 0, maxWin: 2048 });
    // span = 10, ctx = round(10*0.5) = 5
    expect(lo).toBe(95);
    expect(hi).toBe(114);
  });

  it("selection-scoped: hi < lo in the input is normalized (min/max)", () => {
    const { lo, hi } = slabFetchWindow({ planeW: 10000, selRange: { lo: 109, hi: 100 }, winOrigin: 0, maxWin: 2048 });
    expect(lo).toBe(95);
    expect(hi).toBe(114);
  });

  it("selection-scoped: selection past planeW is clamped into range", () => {
    const { lo, hi } = slabFetchWindow({ planeW: 1000, selRange: { lo: 950, hi: 2000 }, winOrigin: 0, maxWin: 2048 });
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(999);
    expect(hi).toBeGreaterThanOrEqual(lo);
  });

  it("selection-scoped: whole-map selection is centred and capped at maxWin", () => {
    const planeW = 7216;
    const { lo, hi } = slabFetchWindow({ planeW, selRange: { lo: 0, hi: planeW - 1 }, winOrigin: 0, maxWin: 2048 });
    expect(hi - lo + 1).toBeLessThanOrEqual(2048);
    expect(hi - lo + 1).toBe(2048);
    // centred on the selection midpoint (planeW/2), not pinned to either edge
    const mid = (lo + hi) / 2;
    expect(Math.abs(mid - (planeW - 1) / 2)).toBeLessThan(2);
  });

  it("selection-scoped: oversized selection near the high edge is capped and stays fully in range", () => {
    const planeW = 5000;
    const { lo, hi } = slabFetchWindow({ planeW, selRange: { lo: 3000, hi: 4999 }, winOrigin: 0, maxWin: 2048 });
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(planeW - 1);
    expect(hi - lo + 1).toBe(2048);
  });

  it("always returns hi >= lo", () => {
    for (const planeW of [0, 1, 5, 2048, 10000]) {
      for (const selRange of [null, { lo: 0, hi: 0 }, { lo: -5, hi: 3 }, { lo: 0, hi: planeW }]) {
        const { lo, hi } = slabFetchWindow({ planeW, selRange, winOrigin: 0, maxWin: 2048 });
        expect(hi).toBeGreaterThanOrEqual(lo);
      }
    }
  });
});

// Phase 6 (256z-format plan): defense-in-depth caps so a corrupt world (quarry.eden's pre-fix
// billions-scale chunk dimensions) degrades to "warn and stop" instead of OOM/RangeError, even
// after Phase 1's coordinate gate closes the known cause.

describe("gridDivisions", () => {
  it("passes a normal world's chunk count through untouched", () => {
    expect(gridDivisions(451, 528)).toBe(528);
    expect(gridDivisions(1, 1)).toBe(1);
  });

  it("caps at 2048 for a huge/corrupt dimension", () => {
    expect(gridDivisions(1_953_719_669, 1)).toBe(2048);
  });

  it("non-finite input falls back to 1", () => {
    expect(gridDivisions(NaN, 5)).toBe(1);
    expect(gridDivisions(Infinity, 5)).toBe(1);
    expect(gridDivisions(NaN, NaN)).toBe(1);
  });

  it("never returns less than 1", () => {
    expect(gridDivisions(0, 0)).toBe(1);
    expect(gridDivisions(-5, -5)).toBe(1);
  });
});

describe("tileWindowFits", () => {
  it("a real-world tile window (single-digit tile counts) fits", () => {
    expect(tileWindowFits(0, 0, 6, 7)).toBe(true); // 7×8 = 56 tiles
  });

  it("exactly at the 4096 cap fits; one over does not", () => {
    expect(tileWindowFits(0, 0, 63, 63)).toBe(true); // 64×64 = 4096
    expect(tileWindowFits(0, 0, 63, 64)).toBe(false); // 64×65 = 4160
  });

  it("a corrupt/huge window (quarry.eden's pre-fix scale) does not fit", () => {
    expect(tileWindowFits(0, 0, 1_000_000, 1_000_000)).toBe(false);
  });

  it("degenerate/inverted ranges do not fit", () => {
    expect(tileWindowFits(5, 5, 4, 10)).toBe(false); // tx1 < tx0
    expect(tileWindowFits(5, 5, 5, 4)).toBe(false); // ty1 < ty0
  });

  it("non-finite input does not fit", () => {
    expect(tileWindowFits(0, 0, NaN, 10)).toBe(false);
    expect(tileWindowFits(0, 0, Infinity, 10)).toBe(false);
  });
});
