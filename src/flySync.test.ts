import { describe, it, expect } from "vitest";
import { editReloadPlan, shouldReloadChunk, bandCovers, staleBandKeys } from "./flySync";

const s = (a: [number, number][]) => a.map((c) => c.join(",")).sort();

describe("editReloadPlan", () => {
  it("interior single-block edit with no reach reloads only its chunk", () => {
    const p = editReloadPlan({ x: 21, y: 21, w: 1, h: 1 }, 0);
    expect(s(p.core)).toEqual(["1,1"]);
    expect(p.halo).toEqual([]);
  });
  it("edge edit adds only the face neighbour, never diagonals", () => {
    const p = editReloadPlan({ x: 16, y: 20, w: 1, h: 1 }, 0);
    expect(s(p.halo)).toEqual(["0,1"]);
    const c = editReloadPlan({ x: 31, y: 31, w: 1, h: 1 }, 0);
    expect(s(c.halo)).toEqual(["1,2", "2,1"]);
  });
  it("multi-chunk rect gets halo only on its outer edges", () => {
    const p = editReloadPlan({ x: 16, y: 16, w: 32, h: 16 }, 0);
    expect(s(p.core)).toEqual(["1,1", "2,1"]);
    expect(s(p.halo)).toEqual(["0,1", "1,0", "1,2", "2,0", "2,2", "3,1"]);
  });
  it("with reach, full square ring", () => {
    const p = editReloadPlan({ x: 24, y: 24, w: 1, h: 1 }, 24);
    expect(p.core).toHaveLength(1);
    expect(p.halo).toHaveLength(24); // 5x5 minus core
  });

  // 27.4b: baked shadows reach 1 block sideways, diagonals included (a caster shades the 3×3 columns
  // around it), so the ring is "edge or corner" instead of 23.1's "edge only".
  describe("with baked shadows", () => {
    it("interior edit has no halo", () => {
      expect(editReloadPlan({ x: 21, y: 21, w: 1, h: 1 }, 0, true).halo).toEqual([]);
    });
    it("an edit one block in from the edge stays inside its chunk", () => {
      expect(editReloadPlan({ x: 17, y: 20, w: 1, h: 1 }, 0, true).halo).toEqual([]);
      expect(editReloadPlan({ x: 30, y: 20, w: 1, h: 1 }, 0, true).halo).toEqual([]);
    });
    it("edge edit adds the one neighbour", () => {
      expect(s(editReloadPlan({ x: 16, y: 20, w: 1, h: 1 }, 0, true).halo)).toEqual(["0,1"]);
    });
    it("corner edit adds both edges and the diagonal", () => {
      expect(s(editReloadPlan({ x: 31, y: 31, w: 1, h: 1 }, 0, true).halo)).toEqual(["1,2", "2,1", "2,2"]);
      expect(s(editReloadPlan({ x: 16, y: 16, w: 1, h: 1 }, 0, true).halo)).toEqual(["0,0", "0,1", "1,0"]);
    });
    it("multi-chunk rect gets its four corners too", () => {
      const p = editReloadPlan({ x: 16, y: 16, w: 32, h: 16 }, 0, true);
      expect(s(p.halo)).toEqual(["0,0", "0,1", "0,2", "1,0", "1,2", "2,0", "2,2", "3,0", "3,1", "3,2"]);
    });
    it("the stale-shadow gate's canopy (chunk (1,0), touching the seam) reloads chunk (0,0)", () => {
      // Mirrors `shadow_canopy_across_seam_remeshes_neighbour` in src-tauri lib.rs: leaves at x 16..18.
      const p = editReloadPlan({ x: 16, y: 6, w: 3, h: 3 }, 0, true);
      expect(s(p.core)).toEqual(["1,0"]);
      expect(s(p.halo)).toContain("0,0");
    });
  });
});

describe("shouldReloadChunk", () => {
  it("skips chunks that are neither resident nor in flight", () => {
    expect(shouldReloadChunk(false, false)).toBe(false);
    expect(shouldReloadChunk(true, false)).toBe(true);
    expect(shouldReloadChunk(false, true)).toBe(true);
  });
});

describe("z band coverage", () => {
  it("lowering keeps, raising invalidates, null is tallest", () => {
    expect(bandCovers(192, 128)).toBe(true);
    expect(bandCovers(128, 192)).toBe(false);
    expect(bandCovers(null, 192)).toBe(true);
    expect(bandCovers(192, null)).toBe(false);
    expect(bandCovers(undefined, 64)).toBe(false);
  });
  it("staleBandKeys is nearest-first and skips covered meshes", () => {
    const built = new Map<string, number | null>([["5,5", 128], ["1,0", 128], ["0,0", 256], ["2,2", 128]]);
    expect(staleBandKeys(built, 192, 0, 0)).toEqual(["1,0", "2,2", "5,5"]);
  });
});
