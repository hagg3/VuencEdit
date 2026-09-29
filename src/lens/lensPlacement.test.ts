import { describe, expect, it } from "vitest";
import { attachPosition, bodyAspectLayout, LENS_GAP, LENS_TOP_OFFSET } from "./lensPlacement";

const WORK = { w: 800, h: 600 };
const SIZE = { w: 300, h: 196 };

describe("attachPosition", () => {
  it("sits to the right of the ghost by LENS_GAP, above its top edge by LENS_TOP_OFFSET", () => {
    const ghost = { x: 100, y: 100, w: 40, h: 40 };
    const p = attachPosition(ghost, SIZE, WORK);
    expect(p.x).toBe(ghost.x + ghost.w + LENS_GAP);
    expect(p.y).toBe(ghost.y - LENS_TOP_OFFSET);
  });

  it("flips to the left of the ghost when the right side would run past the work area", () => {
    const ghost = { x: WORK.w - 60, y: 100, w: 40, h: 40 };
    const p = attachPosition(ghost, SIZE, WORK);
    expect(p.x).toBe(ghost.x - SIZE.w - LENS_GAP);
    expect(p.x + SIZE.w).toBeLessThanOrEqual(WORK.w);
  });

  it("clamps fully inside the work area when the ghost is off the top-left", () => {
    const ghost = { x: -500, y: -500, w: 40, h: 40 };
    const p = attachPosition(ghost, SIZE, WORK);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.x + SIZE.w).toBeLessThanOrEqual(WORK.w);
    expect(p.y + SIZE.h).toBeLessThanOrEqual(WORK.h);
  });

  it("clamps fully inside the work area when the ghost is off the bottom-right", () => {
    const ghost = { x: WORK.w + 500, y: WORK.h + 500, w: 40, h: 40 };
    const p = attachPosition(ghost, SIZE, WORK);
    expect(p.x + SIZE.w).toBeLessThanOrEqual(WORK.w);
    expect(p.y + SIZE.h).toBeLessThanOrEqual(WORK.h);
  });

  it("clamps when the ghost is only partially off-screen", () => {
    const ghost = { x: WORK.w - 10, y: 50, w: 40, h: 40 };
    const p = attachPosition(ghost, SIZE, WORK);
    expect(p.x + SIZE.w).toBeLessThanOrEqual(WORK.w);
    expect(p.x).toBeGreaterThanOrEqual(0);
  });

  it("never places the lens outside the work area over a grid of ghost/size/work combinations", () => {
    for (const work of [{ w: 800, h: 600 }, { w: 300, h: 200 }, { w: 1600, h: 900 }]) {
      for (const size of [{ w: 220, h: 150 }, { w: 300, h: 196 }, { w: 500, h: 400 }]) {
        for (let gx = -200; gx <= work.w + 200; gx += 100) {
          for (let gy = -200; gy <= work.h + 200; gy += 100) {
            const p = attachPosition({ x: gx, y: gy, w: 32, h: 32 }, size, work);
            const w = Math.min(size.w, work.w);
            const h = Math.min(size.h, work.h);
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.x + w).toBeLessThanOrEqual(work.w + 0.001);
            expect(p.y + h).toBeLessThanOrEqual(work.h + 0.001);
          }
        }
      }
    }
  });
});

describe("bodyAspectLayout", () => {
  it("is row (side-by-side) when wider than tall", () => {
    expect(bodyAspectLayout(400, 200)).toBe("row");
  });
  it("is col (stacked) when taller than wide", () => {
    expect(bodyAspectLayout(200, 400)).toBe("col");
  });
  it("is col (stacked) on a tie", () => {
    expect(bodyAspectLayout(300, 300)).toBe("col");
  });
});
