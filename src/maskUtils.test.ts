import { describe, expect, it } from "vitest";
import { decomposeMask, maskOutline, maskPrismPositions, type MaskShape, type OutlinePt } from "./maskUtils";

/** Build a MaskShape covering cells in [x1..x2]×[y1..y2] where `pred(x,y)` holds. */
function maskFrom(
  x1: number, y1: number, x2: number, y2: number,
  pred: (x: number, y: number) => boolean,
): MaskShape {
  const w = x2 - x1 + 1;
  const h = y2 - y1 + 1;
  const bits = new Uint8Array(Math.ceil((w * h) / 8));
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      if (pred(x, y)) {
        const i = (y - y1) * w + (x - x1);
        bits[i >> 3] |= 1 << (i & 7);
      }
    }
  }
  return { x1, y1, x2, y2, bits };
}

const canon = (a: OutlinePt, b: OutlinePt): string => {
  const ka = `${a.x},${a.y}`, kb = `${b.x},${b.y}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

/** Expand every loop's (possibly merged) segments into a multiset of unit boundary edges. */
function loopUnitEdges(loops: OutlinePt[][]): string[] {
  const out: string[] = [];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
      let cx = a.x, cy = a.y;
      while (cx !== b.x || cy !== b.y) {
        out.push(canon({ x: cx, y: cy }, { x: cx + dx, y: cy + dy }));
        cx += dx; cy += dy;
      }
    }
  }
  return out;
}

/** Brute-force set of unit edges bordering a set cell and an empty (or out-of-bounds) neighbour. */
function expectedUnitEdges(mask: MaskShape): Set<string> {
  const w = mask.x2 - mask.x1 + 1;
  const on = (x: number, y: number) => {
    if (x < mask.x1 || x > mask.x2 || y < mask.y1 || y > mask.y2) return false;
    const i = (y - mask.y1) * w + (x - mask.x1);
    return (mask.bits[i >> 3] & (1 << (i & 7))) !== 0;
  };
  const s = new Set<string>();
  for (let y = mask.y1; y <= mask.y2; y++) {
    for (let x = mask.x1; x <= mask.x2; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) s.add(canon({ x, y }, { x: x + 1, y }));
      if (!on(x + 1, y)) s.add(canon({ x: x + 1, y }, { x: x + 1, y: y + 1 }));
      if (!on(x, y + 1)) s.add(canon({ x, y: y + 1 }, { x: x + 1, y: y + 1 }));
      if (!on(x - 1, y)) s.add(canon({ x, y }, { x, y: y + 1 }));
    }
  }
  return s;
}

/** The loops must partition exactly the boundary edges — each once, none extra, none missing. */
function assertPartitionsBoundary(mask: MaskShape, loops: OutlinePt[][]) {
  const got = loopUnitEdges(loops);
  const expected = expectedUnitEdges(mask);
  expect(got.length).toBe(expected.size); // no duplicated / doubled-back edges
  expect(new Set(got)).toEqual(expected);
}

describe("maskOutline", () => {
  it("single cell → one square loop of 4 corners", () => {
    const m = maskFrom(4, 4, 4, 4, () => true);
    const loops = maskOutline(m);
    expect(loops.length).toBe(1);
    expect(loops[0].length).toBe(4);
    assertPartitionsBoundary(m, loops);
  });

  it("solid 3×3 block → one loop simplified to 4 corners", () => {
    const m = maskFrom(0, 0, 2, 2, () => true);
    const loops = maskOutline(m);
    expect(loops.length).toBe(1);
    expect(loops[0].length).toBe(4); // collinear runs merged
    assertPartitionsBoundary(m, loops);
  });

  it("L-shape → one loop with 6 corners", () => {
    // 2×2 box minus the top-right cell.
    const m = maskFrom(0, 0, 1, 1, (x, y) => !(x === 1 && y === 0));
    const loops = maskOutline(m);
    expect(loops.length).toBe(1);
    expect(loops[0].length).toBe(6);
    assertPartitionsBoundary(m, loops);
  });

  it("donut (hole in the middle) → outer + inner loop", () => {
    const m = maskFrom(0, 0, 2, 2, (x, y) => !(x === 1 && y === 1));
    const loops = maskOutline(m);
    expect(loops.length).toBe(2);
    expect(loops.map((l) => l.length).sort()).toEqual([4, 4]); // outer square + hole square
    assertPartitionsBoundary(m, loops);
  });

  it("two disjoint islands → two loops", () => {
    const m = maskFrom(0, 0, 3, 0, (x) => x === 0 || x === 3);
    const loops = maskOutline(m);
    expect(loops.length).toBe(2);
    assertPartitionsBoundary(m, loops);
  });

  it("diagonal pinch (corner-touching cells) still partitions every boundary edge", () => {
    const m = maskFrom(0, 0, 1, 1, (x, y) => x === y);
    const loops = maskOutline(m);
    assertPartitionsBoundary(m, loops); // robust to how the pinch vertex is split
  });

  it("empty mask → no loops", () => {
    const m = maskFrom(0, 0, 3, 3, () => false);
    expect(maskOutline(m)).toEqual([]);
  });

  it("corners are grid-lattice coords with the +1 far edge", () => {
    const loops = maskOutline(maskFrom(4, 4, 4, 4, () => true));
    const xs = loops[0].map((p) => p.x).sort();
    const ys = loops[0].map((p) => p.y).sort();
    expect(xs).toEqual([4, 4, 5, 5]);
    expect(ys).toEqual([4, 4, 5, 5]);
  });
});

describe("maskPrismPositions", () => {
  it("emits wall quads per contour segment plus top/bottom caps per rect, in [x, z, y] space", () => {
    const m = maskFrom(0, 0, 0, 0, () => true); // single cell → 4-corner loop, 1 cap rect
    const loops = maskOutline(m);
    const caps = decomposeMask(m)!;
    expect(caps.length).toBe(1);
    const { fill, edges } = maskPrismPositions(loops, caps, 2, 5);

    // fill = (4 wall quads + 2 cap quads) × 6 verts × 3 floats.
    expect(fill.length).toBe((4 + 2) * 6 * 3);
    // edges = 4 segments × (top + bottom + post) × 2 verts × 3 floats.
    expect(edges.length).toBe(4 * 3 * 2 * 3);

    // Height axis (index 1) only ever takes zBottom or zTop.
    for (let i = 1; i < fill.length; i += 3) expect([2, 5]).toContain(fill[i]);
    // Footprint stays within the cell's grid-corner extent (0..1 on both plan axes).
    for (let i = 0; i < fill.length; i += 3) {
      expect(fill[i]).toBeGreaterThanOrEqual(0);     // x
      expect(fill[i]).toBeLessThanOrEqual(1);
      expect(fill[i + 2]).toBeGreaterThanOrEqual(0); // y
      expect(fill[i + 2]).toBeLessThanOrEqual(1);
    }
  });

  it("wall count tracks the total contour length, not the bbox", () => {
    // L-shape: 6-corner outer loop → 6 wall quads; caps = decomposeMask rects.
    const m = maskFrom(0, 0, 1, 1, (x, y) => !(x === 1 && y === 0));
    const loops = maskOutline(m);
    const caps = decomposeMask(m)!;
    const { fill } = maskPrismPositions(loops, caps, 0, 1);
    const wallQuads = loops.reduce((n, l) => n + l.length, 0);
    expect(fill.length).toBe((wallQuads + caps.length * 2) * 6 * 3);
  });
});

// Guard that the existing decomposeMask export is unaffected by the new tracer code.
describe("decomposeMask (unchanged)", () => {
  it("merges a solid block into a single rect", () => {
    const rects = decomposeMask(maskFrom(0, 0, 2, 2, () => true));
    expect(rects).toEqual([{ x0: 0, y0: 0, x1: 2, y1: 2 }]);
  });
});
