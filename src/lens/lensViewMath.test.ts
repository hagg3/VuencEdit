import { describe, expect, it } from "vitest";
import {
  bandRect, canvasToCell, cellInImage, cellToCanvas, dragZ, extrudeOverlay, fitLayout, footprintEdges,
  frameRows, hoverColumn, layoutFor, rulerSteps, zAtEdge, zEdgeHit, zEdges, zoomAbout,
  type ImageGeom, type Layout,
} from "./lensViewMath";

/** An elevation of a 64z world: 100 columns from world X 93, rows z 63 (top) … 0. */
const elev = (over: Partial<ImageGeom> = {}): ImageGeom => ({
  width: 100, height: 64, colLo: 93, colLod: 1, row0: 63, rowLod: 1, rowDown: false, ...over,
});

describe("cellToCanvas ∘ canvasToCell", () => {
  for (const lod of [1, 4]) {
    for (const zoom of [1, 3, 8]) {
      it(`round-trips at zoom ${zoom}, LOD ${lod}`, () => {
        const g = elev({ width: 100 / lod, colLod: lod });
        const fit = fitLayout(g, { x: 24, y: 0, w: 300, h: 128 });
        const L = layoutFor(fit, zoom, { x: -13, y: 7 });
        for (const [col, row] of [[93, 63], [100, 0], [150, 31], [192, 12]]) {
          const p = cellToCanvas(g, L, col, row);
          // Sample the middle of the cell: its top-left corner is exactly on a boundary.
          expect(canvasToCell(g, L, p.x + L.scale / 2, p.y + L.scale / 2)).toEqual({ col, row });
        }
      });
    }
  }

  it("top view rows run down in Y", () => {
    const g: ImageGeom = { width: 10, height: 10, colLo: 5, colLod: 2, row0: 40, rowLod: 2, rowDown: true };
    const L: Layout = { ox: 0, oy: 0, scale: 3 };
    expect(cellToCanvas(g, L, 5, 40)).toEqual({ x: 0, y: 0 });
    expect(cellToCanvas(g, L, 7, 43)).toEqual({ x: 6, y: 9 });
    expect(canvasToCell(g, L, 7, 10)).toEqual({ col: 7, row: 43 });
    expect(cellInImage(g, { col: 24, row: 59 })).toBe(true);
    expect(cellInImage(g, { col: 25, row: 59 })).toBe(false);
  });
});

/**
 * Golden numbers from the old `ElevationPreviewPanel.drawSection` at zoom 1, pan 0, LOD 1: a
 * 300 × 128 section over a 100-column, 64-row image gives `scale = min(300/100, 128/64) = 2`,
 * `dw = 200`, `ox = round((300 − 200)/2) = 50`, `oy = 0`.
 */
describe("parity with the old elevation panel", () => {
  const g = elev();
  const L = fitLayout(g, { x: 0, y: 0, w: 300, h: 128 });

  it("fits like the old panel", () => {
    expect(L).toEqual({ ox: 50, oy: 0, scale: 2 });
  });

  it("z band: hTop = oy + (maxZ − z_max)·scale, hH = (z_max − z_min + 1)·scale", () => {
    expect(bandRect(g, L, 10, 19)).toEqual({ x: 50, y: 88, w: 200, h: 20 });
    expect(bandRect(g, layoutFor(L, 1, { x: 0, y: 0 }), 5, 5)).toMatchObject({ y: 116, h: 2 });
  });

  it("grips sit at the band's top and bottom edges", () => {
    expect(zEdges(g, L, 10, 19)).toEqual({ max: 88, min: 108 });
  });

  it("z+ extrude: one band per copy, alpha 0.22 − 0.05·(k − 1)", () => {
    const o = extrudeOverlay(g, L, 10, 19, 2, 1, 63);
    expect(o.oob).toBeNull();
    expect(o.bands.map(b => [b.x, b.y, b.w, b.h])).toEqual([[50, 68, 200, 20], [50, 48, 200, 20]]);
    expect(o.bands[0].alpha).toBeCloseTo(0.22);
    expect(o.bands[1].alpha).toBeCloseTo(0.17);
  });

  it("a copy partly above the world is clamped; ghostH ≥ 2", () => {
    const o = extrudeOverlay(g, L, 50, 59, 1, 1, 63);
    expect(o.bands.map(b => [b.y, b.h])).toEqual([[0, 8]]);
  });

  it("every copy out of the world → the OOB marker on that edge", () => {
    expect(extrudeOverlay(g, L, 50, 63, 1, 1, 63)).toEqual({ bands: [], oob: { y: 0, dir: 1 } });
    expect(extrudeOverlay(g, L, 0, 5, 1, -1, 63)).toEqual({ bands: [], oob: { y: 128, dir: -1 } });
  });

  it("z- extrude stacks downward", () => {
    const o = extrudeOverlay(g, L, 20, 29, 1, -1, 63);
    expect(o.bands.map(b => [b.y, b.h])).toEqual([[(63 - 19) * 2, 20]]);
  });
});

describe("zEdgeHit", () => {
  const g = elev();
  const L: Layout = { ox: 0, oy: 0, scale: 2 };
  // zMax 19 → top edge at y 88; zMin 10 → bottom edge at y 108.
  it("respects the 5 px zone", () => {
    expect(zEdgeHit(g, L, 83, 10, 19)).toBe("max");
    expect(zEdgeHit(g, L, 82.9, 10, 19)).toBeNull();
    expect(zEdgeHit(g, L, 113, 10, 19)).toBe("min");
    expect(zEdgeHit(g, L, 98, 10, 19)).toBeNull();
  });

  it("picks the nearer edge when both are in range", () => {
    // One-row band: edges at 88 (zMax 19) and 90 (zMin 19).
    expect(zEdgeHit(g, L, 88.5, 19, 19)).toBe("max");
    expect(zEdgeHit(g, L, 89.5, 19, 19)).toBe("min");
    expect(zEdgeHit(g, L, 89, 19, 19)).toBe("max"); // tie → top
  });
});

describe("z-edge drag", () => {
  const g = elev();
  const L: Layout = { ox: 0, oy: 0, scale: 2 };
  it("zAtEdge inverts zEdges", () => {
    const e = zEdges(g, L, 10, 19);
    expect(zAtEdge(g, L, e.max, "max")).toBe(19);
    expect(zAtEdge(g, L, e.min, "min")).toBe(10);
    expect(zAtEdge(g, L, e.max - 4.2, "max")).toBe(21);
  });

  it("clamps and pushes the other edge from its start value", () => {
    const start = { zMin: 10, zMax: 19 };
    expect(dragZ("max", 5, start, 63)).toEqual({ zMin: 5, zMax: 5 });
    expect(dragZ("max", 15, start, 63)).toEqual({ zMin: 10, zMax: 15 }); // dragged back: zMin restored
    expect(dragZ("min", 30, start, 63)).toEqual({ zMin: 30, zMax: 30 });
    expect(dragZ("max", 99, start, 63)).toEqual({ zMin: 10, zMax: 63 });
    expect(dragZ("min", -4, start, 63)).toEqual({ zMin: 0, zMax: 19 });
  });
});

describe("frameRows (plan §2.3)", () => {
  it("64z: terrain + margin, clamped to the image top", () => {
    expect(frameRows(0, 63, 30, 20)).toEqual({ lo: 0, hi: 38 });
    expect(frameRows(0, 63, 60, 20)).toEqual({ lo: 0, hi: 63 });
  });

  it("256z: low terrain doesn't open on the sky", () => {
    expect(frameRows(0, 255, 70, 64)).toEqual({ lo: 0, hi: 78 });
    expect(frameRows(0, 255, 200, 64)).toEqual({ lo: 0, hi: 208 });
  });

  it("a selection above the terrain is framed too; an empty raster frames on zMax", () => {
    expect(frameRows(0, 255, 40, 120)).toEqual({ lo: 0, hi: 128 });
    expect(frameRows(0, 255, null, 12)).toEqual({ lo: 0, hi: 20 });
  });

  it("fitLayout puts the frame's top row at the top of the box", () => {
    const g = elev({ height: 256, row0: 255 });
    const frame = frameRows(0, 255, 70, 64); // rows 0..78 → 79 rows
    const L = fitLayout(g, { x: 0, y: 0, w: 1000, h: 158 }, frame);
    expect(L.scale).toBe(2);
    expect(cellToCanvas(g, L, 93, 78).y).toBeCloseTo(0);
    expect(cellToCanvas(g, L, 93, 0).y + L.scale).toBeCloseTo(158);
  });
});

describe("zoomAbout", () => {
  const g = elev();
  const fit = fitLayout(g, { x: 0, y: 0, w: 300, h: 128 });
  it("keeps the cursor's cell fixed", () => {
    const p = { x: 133.3, y: 71.7 };
    let zoom = 1, pan = { x: 0, y: 0 };
    const before = canvasToCell(g, layoutFor(fit, zoom, pan), p.x, p.y);
    for (const next of [1.18, 2.5, 8]) {
      ({ zoom, pan } = zoomAbout(fit, zoom, pan, p, next));
      const L = layoutFor(fit, zoom, pan);
      expect(canvasToCell(g, L, p.x, p.y)).toEqual(before);
    }
  });

  it("clamps to 1–8 and resets the pan at 1×", () => {
    expect(zoomAbout(fit, 7, { x: 3, y: 3 }, { x: 0, y: 0 }, 20).zoom).toBe(8);
    expect(zoomAbout(fit, 1.1, { x: 30, y: -9 }, { x: 0, y: 0 }, 0.5)).toEqual({ zoom: 1, pan: { x: 0, y: 0 } });
  });
});

describe("hoverColumn", () => {
  const L: Layout = { ox: 10, oy: 0, scale: 2 };
  it("accounts for the context offset (the old panel's dead-code bug)", () => {
    // Selection starts at x1 = 100 with 7 context columns, so the image starts at 93.
    const g = elev({ colLo: 93 });
    expect(hoverColumn(g, L, 100)).toEqual({ x: 10 + 7 * 2, w: 2 });
    expect(hoverColumn(g, L, 93)).toEqual({ x: 10, w: 2 }); // context columns count
    expect(hoverColumn(g, L, 92)).toBeNull();
    expect(hoverColumn(g, L, 193)).toBeNull();
  });

  it("is lod columns wide at LOD > 1, snapped to the image column", () => {
    const g = elev({ colLo: 93, width: 25, colLod: 4 });
    expect(hoverColumn(g, L, 99)).toEqual({ x: 10 + 4 * 2, w: 8 });
    expect(hoverColumn(g, L, 96)).toEqual({ x: 10, w: 8 });
    expect(hoverColumn(g, L, 193)).toBeNull();
  });
});

describe("footprintEdges", () => {
  it("brackets the selection columns", () => {
    expect(footprintEdges(elev({ colLo: 93 }), { ox: 0, oy: 0, scale: 2 }, 100, 109)).toEqual([14, 34]);
  });
});

describe("rulerSteps", () => {
  it("labels every 16 at ordinary scales, 8 when zoomed far in, sparser when cramped", () => {
    expect(rulerSteps(2)).toEqual({ label: 16, tick: 8 });
    expect(rulerSteps(6)).toEqual({ label: 16, tick: 8 });
    expect(rulerSteps(8)).toEqual({ label: 8, tick: 4 });
    expect(rulerSteps(0.5)).toEqual({ label: 32, tick: 16 });
  });
});
