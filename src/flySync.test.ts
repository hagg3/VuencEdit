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
