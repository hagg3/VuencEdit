import { describe, expect, it } from "vitest";
import {
  bresenhamLine,
  brushFootprint,
  ellipsePixels,
  linePixels,
  penFootprint,
  polygonPixels,
  rectPixels,
  type WP,
} from "./drawTools";

function sortPts(pts: WP[]): WP[] {
  return [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
}

describe("penFootprint", () => {
  it("returns exactly the input point", () => {
    expect(penFootprint({ x: 3, y: -2 })).toEqual([{ x: 3, y: -2 }]);
  });
});

describe("brushFootprint", () => {
  it("size<=1 degenerates to a single point", () => {
    expect(brushFootprint({ x: 5, y: 5 }, 1, "sq")).toEqual([{ x: 5, y: 5 }]);
    expect(brushFootprint({ x: 5, y: 5 }, 0, "sq")).toEqual([{ x: 5, y: 5 }]);
  });

  it("square brush covers a full (size x size)-ish block centered on p", () => {
    const pts = brushFootprint({ x: 0, y: 0 }, 3, "sq");
    // half = floor(3/2) = 1 -> dx,dy in [-1,1] => 3x3 = 9 points
    expect(pts).toHaveLength(9);
    const sorted = sortPts(pts);
    expect(sorted[0]).toEqual({ x: -1, y: -1 });
    expect(sorted[sorted.length - 1]).toEqual({ x: 1, y: 1 });
  });

  it("circle brush excludes corners beyond radius", () => {
    const sq = brushFootprint({ x: 0, y: 0 }, 5, "sq");
    const circ = brushFootprint({ x: 0, y: 0 }, 5, "circ");
    expect(circ.length).toBeLessThan(sq.length);
    // corner (2,2) should be excluded from the circle but present in the square
    expect(sq.some(p => p.x === 2 && p.y === 2)).toBe(true);
    expect(circ.some(p => p.x === 2 && p.y === 2)).toBe(false);
    // center is always included
    expect(circ.some(p => p.x === 0 && p.y === 0)).toBe(true);
  });

  it("is centered on p regardless of translation", () => {
    const origin = brushFootprint({ x: 0, y: 0 }, 5, "circ");
    const shifted = brushFootprint({ x: 10, y: -4 }, 5, "circ");
    expect(shifted).toEqual(origin.map(p => ({ x: p.x + 10, y: p.y - 4 })));
  });
});

describe("bresenhamLine", () => {
  it("single point when a === b", () => {
    expect(bresenhamLine({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([{ x: 2, y: 2 }]);
  });

  it("produces a contiguous horizontal line", () => {
    const pts = bresenhamLine({ x: 0, y: 0 }, { x: 4, y: 0 });
    expect(pts).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 },
    ]);
  });

  it("produces a contiguous vertical line", () => {
    const pts = bresenhamLine({ x: 0, y: 0 }, { x: 0, y: 3 });
    expect(pts).toEqual([
      { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 },
    ]);
  });

  it("perfect diagonal steps one cell in each axis every step", () => {
    const pts = bresenhamLine({ x: 0, y: 0 }, { x: 3, y: 3 });
    expect(pts).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 },
    ]);
  });

  it("is symmetric: reversing endpoints reverses the path", () => {
    const fwd = bresenhamLine({ x: 1, y: 5 }, { x: 8, y: -2 });
    const rev = bresenhamLine({ x: 8, y: -2 }, { x: 1, y: 5 });
    expect(rev).toEqual([...fwd].reverse());
  });

  it("has no gaps: consecutive points differ by at most 1 in each axis", () => {
    const pts = bresenhamLine({ x: -3, y: 7 }, { x: 9, y: -5 });
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i].x - pts[i - 1].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(pts[i].y - pts[i - 1].y)).toBeLessThanOrEqual(1);
    }
  });
});

describe("rectPixels", () => {
  it("fill mode covers the full bounding box", () => {
    const pts = rectPixels({ x: 0, y: 0 }, { x: 2, y: 1 }, "fill");
    expect(pts).toHaveLength(3 * 2);
  });

  it("outline mode covers only the perimeter", () => {
    const pts = rectPixels({ x: 0, y: 0 }, { x: 3, y: 2 }, "outline");
    // 4x3 box, perimeter = 2*4 + 2*3 - 4 corners double counted = 10
    expect(pts).toHaveLength(10);
    expect(pts.some(p => p.x === 1 && p.y === 1)).toBe(false); // interior excluded
  });

  it("normalizes reversed corners", () => {
    const a = rectPixels({ x: 5, y: 5 }, { x: 0, y: 0 }, "fill");
    const b = rectPixels({ x: 0, y: 0 }, { x: 5, y: 5 }, "fill");
    expect(sortPts(a)).toEqual(sortPts(b));
  });

  it("single-point rect", () => {
    expect(rectPixels({ x: 1, y: 1 }, { x: 1, y: 1 }, "fill")).toEqual([{ x: 1, y: 1 }]);
  });
});

describe("linePixels", () => {
  it("size 1 equals the bare bresenham line", () => {
    const a = { x: 0, y: 0 }, b = { x: 5, y: 2 };
    expect(linePixels(a, b, 1, "sq")).toEqual(bresenhamLine(a, b));
  });

  it("thickened line is a superset of the centreline and has no duplicates", () => {
    const a = { x: 0, y: 0 }, b = { x: 8, y: 3 };
    const thick = linePixels(a, b, 3, "circ");
    const keys = new Set(thick.map(p => `${p.x},${p.y}`));
    expect(keys.size).toBe(thick.length); // deduped
    for (const c of bresenhamLine(a, b)) expect(keys.has(`${c.x},${c.y}`)).toBe(true);
    expect(thick.length).toBeGreaterThan(bresenhamLine(a, b).length);
  });
});

describe("polygonPixels", () => {
  it("outline of a square is its perimeter only (no interior)", () => {
    const verts = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const pts = polygonPixels(verts, "outline");
    const keys = new Set(pts.map(p => `${p.x},${p.y}`));
    expect(keys.has("2,2")).toBe(false);       // interior excluded
    expect(keys.has("0,0")).toBe(true);         // corner present
    expect(keys.size).toBe(pts.length);         // deduped
  });

  it("filled square covers the whole 5×5 area", () => {
    const verts = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const keys = new Set(polygonPixels(verts, "fill").map(p => `${p.x},${p.y}`));
    for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) expect(keys.has(`${x},${y}`)).toBe(true);
    expect(keys.size).toBe(25);
  });

  it("filled triangle includes interior but excludes points outside", () => {
    const tri = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }];
    const keys = new Set(polygonPixels(tri, "fill").map(p => `${p.x},${p.y}`));
    expect(keys.has("1,1")).toBe(true);   // inside
    expect(keys.has("3,3")).toBe(false);  // outside the hypotenuse
  });

  it("degenerate cases: empty, single, and two-vertex", () => {
    expect(polygonPixels([], "fill")).toEqual([]);
    expect(polygonPixels([{ x: 2, y: 3 }], "fill")).toEqual([{ x: 2, y: 3 }]);
    // Two vertices → a line (no area to fill).
    const seg = polygonPixels([{ x: 0, y: 0 }, { x: 3, y: 0 }], "fill");
    expect(new Set(seg.map(p => `${p.x},${p.y}`)).size).toBe(4);
  });
});

describe("ellipsePixels", () => {
  it("degenerates to a single point when a === b", () => {
    expect(ellipsePixels({ x: 4, y: 4 }, { x: 4, y: 4 }, "fill")).toEqual([{ x: 4, y: 4 }]);
  });

  it("fill mode has no duplicate points", () => {
    const pts = ellipsePixels({ x: 0, y: 0 }, { x: 10, y: 6 }, "fill");
    const keys = new Set(pts.map(p => `${p.x},${p.y}`));
    expect(keys.size).toBe(pts.length);
  });

  it("outline mode has no duplicate points", () => {
    const pts = ellipsePixels({ x: 0, y: 0 }, { x: 10, y: 6 }, "outline");
    const keys = new Set(pts.map(p => `${p.x},${p.y}`));
    expect(keys.size).toBe(pts.length);
  });

  it("fill mode is a superset of outline mode", () => {
    const outline = new Set(
      ellipsePixels({ x: 0, y: 0 }, { x: 10, y: 6 }, "outline").map(p => `${p.x},${p.y}`),
    );
    const fillSet = new Set(
      ellipsePixels({ x: 0, y: 0 }, { x: 10, y: 6 }, "fill").map(p => `${p.x},${p.y}`),
    );
    for (const k of outline) expect(fillSet.has(k)).toBe(true);
  });

  it("is symmetric about its center for both axes", () => {
    const pts = ellipsePixels({ x: 0, y: 0 }, { x: 8, y: 4 }, "fill");
    const cx = 4, cy = 2;
    const set = new Set(pts.map(p => `${p.x},${p.y}`));
    for (const p of pts) {
      expect(set.has(`${2 * cx - p.x},${p.y}`)).toBe(true);
      expect(set.has(`${p.x},${2 * cy - p.y}`)).toBe(true);
    }
  });

  it("degenerate rx=0 produces a vertical line", () => {
    const pts = ellipsePixels({ x: 5, y: 0 }, { x: 5, y: 6 }, "outline");
    expect(pts.every(p => p.x === 5)).toBe(true);
    expect(pts.length).toBe(7); // y from 0..6 inclusive
  });

  it("degenerate ry=0 produces a horizontal line", () => {
    const pts = ellipsePixels({ x: 0, y: 3 }, { x: 6, y: 3 }, "outline");
    expect(pts.every(p => p.y === 3)).toBe(true);
    expect(pts.length).toBe(7);
  });
});
