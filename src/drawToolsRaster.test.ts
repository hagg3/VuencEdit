import { describe, expect, it } from "vitest";
import {
  cellKey, cellKeyX, cellKeyY, ellipseFillRuns, ellipsePixels, linePixels, polygonMask, polygonPixels,
  rectPixels, rectRects, type WP,
} from "./drawTools";
import * as old from "./drawTools.legacy";

const same = (a: WP[], b: WP[]) => expect(a).toEqual(b); // identical cells AND order

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function randPoly(r: () => number, n: number, span: number): WP[] {
  return Array.from({ length: n }, () => ({ x: Math.floor(r() * span), y: Math.floor(r() * span) }));
}

describe("cell keys", () => {
  it("round-trip including negatives", () => {
    for (const [x, y] of [[0, 0], [5, -3], [-7, 12], [1000000, 999999], [-1000, -1000], [3, 0]]) {
      const k = cellKey(x, y);
      expect([cellKeyX(k), cellKeyY(k)]).toEqual([x, y]);
    }
  });
});

describe("polygonPixels matches legacy", () => {
  it("random polygons, fill and outline", () => {
    const r = rng(7);
    for (let i = 0; i < 60; i++) {
      const verts = randPoly(r, 1 + Math.floor(r() * 8), 40);
      for (const mode of ["fill", "outline"] as const) same(polygonPixels(verts, mode), old.polygonPixels(verts, mode));
    }
  });
  it("degenerate inputs", () => {
    same(polygonPixels([], "fill"), old.polygonPixels([], "fill"));
    const seg = [{ x: 0, y: 0 }, { x: 5, y: 3 }];
    same(polygonPixels(seg, "fill"), old.polygonPixels(seg, "fill"));
  });
});

describe("polygonMask matches legacy bitset", () => {
  function legacyMask(verts: WP[]) {
    const filled = old.polygonPixels(verts, "fill");
    if (filled.length === 0) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of filled) {
      if (p.x < x1) x1 = p.x; if (p.x > x2) x2 = p.x;
      if (p.y < y1) y1 = p.y; if (p.y > y2) y2 = p.y;
    }
    x1 = Math.max(0, x1); y1 = Math.max(0, y1);
    const width = x2 - x1 + 1, height = y2 - y1 + 1;
    const bits = new Uint8Array(Math.ceil((width * height) / 8));
    for (const p of filled) {
      if (p.x < x1 || p.x > x2 || p.y < y1 || p.y > y2) continue;
      const i = (p.y - y1) * width + (p.x - x1);
      bits[i >> 3] |= 1 << (i & 7);
    }
    return { x1, y1, x2, y2, bits };
  }
  it("random polygons incl. ones poking below zero", () => {
    const r = rng(99);
    for (let i = 0; i < 80; i++) {
      const verts = randPoly(r, 1 + Math.floor(r() * 9), 50).map(p => ({ x: p.x - (i % 3 === 0 ? 10 : 0), y: p.y - (i % 4 === 0 ? 10 : 0) }));
      expect(polygonMask(verts)).toEqual(legacyMask(verts));
    }
  });
  it("empty is null", () => expect(polygonMask([])).toBeNull());
});

describe("shape ghost helpers", () => {
  const cells = (rects: [number, number, number, number][]) => {
    const s = new Set<number>();
    for (const [x, y, w, h] of rects) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) s.add(cellKey(x + i, y + j));
    return s;
  };
  const keys = (pts: WP[]) => new Set(pts.map(p => cellKey(p.x, p.y)));
  it("rectRects covers exactly rectPixels", () => {
    const r = rng(3);
    for (let i = 0; i < 80; i++) {
      const a = { x: Math.floor(r() * 12), y: Math.floor(r() * 12) }, b = { x: Math.floor(r() * 12), y: Math.floor(r() * 12) };
      for (const mode of ["fill", "outline"] as const) {
        const rs = rectRects(a, b, mode);
        const total = rs.reduce((n, q) => n + q[2] * q[3], 0);
        const want = keys(rectPixels(a, b, mode));
        expect(cells(rs)).toEqual(want);
        expect(total).toBe(want.size); // no overlap
      }
    }
  });
  it("ellipseFillRuns covers exactly ellipsePixels fill", () => {
    const r = rng(5);
    for (let i = 0; i < 80; i++) {
      const a = { x: Math.floor(r() * 20), y: Math.floor(r() * 20) }, b = { x: Math.floor(r() * 20), y: Math.floor(r() * 20) };
      const got = new Set<number>();
      for (const [y, xa, xb] of ellipseFillRuns(a, b)) for (let x = xa; x <= xb; x++) got.add(cellKey(x, y));
      expect(got).toEqual(keys(old.ellipsePixels(a, b, "fill")));
    }
  });
  it("ellipsePixels and linePixels match legacy", () => {
    const r = rng(11);
    for (let i = 0; i < 40; i++) {
      const a = { x: Math.floor(r() * 20), y: Math.floor(r() * 20) }, b = { x: Math.floor(r() * 20), y: Math.floor(r() * 20) };
      for (const mode of ["fill", "outline"] as const) same(ellipsePixels(a, b, mode), old.ellipsePixels(a, b, mode));
      same(linePixels(a, b, 3, "circ"), old.linePixels(a, b, 3, "circ"));
    }
  });
});
