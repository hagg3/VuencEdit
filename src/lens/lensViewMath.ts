/**
 * Coordinate math for `LensView` (Stage 20.4, `lens-window-plan-2026-10-01.md` §3.1). **Pure**, tested
 * in node (`lensViewMath.test.ts`). Everything the old `ElevationPreviewPanel` did inline to map
 * between canvas pixels and world cells lives here, in **block units**: `Layout.scale` is canvas px
 * per world block, so a LOD-sampled image (`colLod` world columns per image column) still maps a
 * cursor to the exact block under it.
 *
 * An image's rows are world Z for an elevation (row 0 = `row0`, the top; Z falls going down) or
 * world Y for the Top tab (`rowDown`: Y rises going down).
 */

export interface ImageGeom {
  /** Image size in pixels. */
  width: number;
  height: number;
  /** World column of image column 0, and world columns per image column (the LOD). */
  colLo: number;
  colLod: number;
  /** World row of image row 0, and world rows per image row (1 for an elevation). */
  row0: number;
  rowLod: number;
  /** False: an elevation (rows are Z, top = `row0`). True: the Top tab (rows are Y, increasing). */
  rowDown: boolean;
}

/** Where block (`colLo`, `row0`)'s top-left corner sits on the canvas, and px per block. */
export interface Layout { ox: number; oy: number; scale: number }
export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Wheel zoom per notch (as the old panel). */
export const ZOOM_STEP = 1.18;
/** Hit zone around a z band edge, in canvas px. */
export const Z_EDGE_HIT = 5;
/** Rows of headroom above the terrain / zMax in the initial framing (plan §2.3). */
export const FRAME_MARGIN = 8;

export function blocksW(g: ImageGeom): number { return g.width * g.colLod; }
export function blocksH(g: ImageGeom): number { return g.height * g.rowLod; }

/** Blocks from the image's top edge down to `row`'s top edge. */
function rowOffset(g: ImageGeom, row: number): number {
  return g.rowDown ? row - g.row0 : g.row0 - row;
}

/** Canvas position of a cell's top-left corner. */
export function cellToCanvas(g: ImageGeom, L: Layout, col: number, row: number): Pt {
  return { x: L.ox + (col - g.colLo) * L.scale, y: L.oy + rowOffset(g, row) * L.scale };
}

/** The world cell under a canvas point (not bounds-checked; see `cellInImage`). */
export function canvasToCell(g: ImageGeom, L: Layout, cx: number, cy: number): { col: number; row: number } {
  const c = Math.floor((cx - L.ox) / L.scale);
  const r = Math.floor((cy - L.oy) / L.scale);
  return { col: g.colLo + c, row: g.rowDown ? g.row0 + r : g.row0 - r };
}

export function cellInImage(g: ImageGeom, cell: { col: number; row: number }): boolean {
  const c = cell.col - g.colLo, r = rowOffset(g, cell.row);
  return c >= 0 && c < blocksW(g) && r >= 0 && r < blocksH(g);
}

/**
 * The initial vertical framing of an elevation (plan §2.3): from the image's bottom row up to a little
 * above the highest terrain or the selection's top, whichever is higher, so a 256z world doesn't open
 * on 200 rows of sky. `zLo`/`zHi` are the image's own bottom/top rows.
 */
export function frameRows(zLo: number, zHi: number, terrainZHi: number | null, zMax: number): { lo: number; hi: number } {
  const top = Math.max(terrainZHi ?? zMax, zMax) + FRAME_MARGIN;
  return { lo: zLo, hi: Math.max(zLo, Math.min(zHi, top)) };
}

/**
 * Fit the image (or, for an elevation with a `frame`, the framed rows of it) into `avail`, centred.
 * Rows outside the frame run off the canvas until the user pans or zooms out of it.
 */
export function fitLayout(g: ImageGeom, avail: Box, frame?: { lo: number; hi: number } | null): Layout {
  const bw = Math.max(1, blocksW(g));
  const rows = frame ? Math.max(1, frame.hi - frame.lo + 1) : Math.max(1, blocksH(g));
  const scale = Math.max(0.05, Math.min(avail.w / bw, Math.max(1, avail.h) / rows));
  const top = frame ? rowOffset(g, frame.hi) : 0;
  return {
    ox: avail.x + Math.max(0, (avail.w - bw * scale) / 2),
    oy: avail.y + Math.max(0, (avail.h - rows * scale) / 2) - top * scale,
    scale,
  };
}

/** Zoom and pan on top of a fit. Pan is in canvas px. */
export function layoutFor(fit: Layout, zoom: number, pan: Pt): Layout {
  return { ox: fit.ox + pan.x, oy: fit.oy + pan.y, scale: fit.scale * zoom };
}

/** New zoom + pan so the point under `p` stays put. Clamped to 1×–8×; back at 1× the pan resets. */
export function zoomAbout(fit: Layout, zoom: number, pan: Pt, p: Pt, nextZoom: number): { zoom: number; pan: Pt } {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
  if (z === MIN_ZOOM) return { zoom: z, pan: { x: 0, y: 0 } };
  const L = layoutFor(fit, zoom, pan);
  const ux = (p.x - L.ox) / L.scale, uy = (p.y - L.oy) / L.scale;
  const s = fit.scale * z;
  return { zoom: z, pan: { x: p.x - ux * s - fit.ox, y: p.y - uy * s - fit.oy } };
}

/** Canvas y of the z band's two edges: the top of `zMax`'s row and the bottom of `zMin`'s. */
export function zEdges(g: ImageGeom, L: Layout, zMin: number, zMax: number): { max: number; min: number } {
  return { max: L.oy + rowOffset(g, zMax) * L.scale, min: L.oy + (rowOffset(g, zMin) + 1) * L.scale };
}

/** Which z band edge a canvas y is on, if any: the nearer of the two within `hit` px (top on a tie). */
export function zEdgeHit(g: ImageGeom, L: Layout, cy: number, zMin: number, zMax: number, hit = Z_EDGE_HIT): "max" | "min" | null {
  const e = zEdges(g, L, zMin, zMax);
  const dMax = Math.abs(cy - e.max), dMin = Math.abs(cy - e.min);
  if (dMax > hit && dMin > hit) return null;
  return dMax <= dMin ? "max" : "min";
}

/** The z an edge dragged to canvas y lands on: the row boundary nearest `cy`. */
export function zAtEdge(g: ImageGeom, L: Layout, cy: number, edge: "max" | "min"): number {
  const b = Math.round((cy - L.oy) / L.scale); // row boundary, in blocks from the image top
  return edge === "max" ? g.row0 - b : g.row0 - b + 1;
}

/** A z-edge drag's result: clamped to `0..maxZ`, and dragging one edge past the other pushes it. The
 *  start values are what gets pushed, so dragging back undoes the push. */
export function dragZ(edge: "max" | "min", z: number, start: { zMin: number; zMax: number }, maxZ: number): { zMin: number; zMax: number } {
  const v = Math.max(0, Math.min(maxZ, z));
  return edge === "max"
    ? { zMin: Math.min(start.zMin, v), zMax: v }
    : { zMin: v, zMax: Math.max(start.zMax, v) };
}

/** The z band highlight: the image's full width, rows `zLo..zHi`. */
export function bandRect(g: ImageGeom, L: Layout, zLo: number, zHi: number): Box {
  const y = L.oy + rowOffset(g, zHi) * L.scale;
  return { x: L.ox, y, w: blocksW(g) * L.scale, h: Math.max(1, (zHi - zLo + 1) * L.scale) };
}

export interface ExtrudeOverlay {
  bands: (Box & { alpha: number })[];
  /** Every copy would be out of the world: draw a marker on this edge instead. */
  oob: { y: number; dir: 1 | -1 } | null;
}

/** The z± extrude ghost bands (the old `drawSection`'s, as they were): `count` copies of the band
 *  stacked up (`z+`) or down (`z-`), clamped to the world, fading by 0.05 per copy. */
export function extrudeOverlay(
  g: ImageGeom, L: Layout, zMin: number, zMax: number, count: number, dir: 1 | -1, maxZ: number,
): ExtrudeOverlay {
  const depth = zMax - zMin + 1;
  const bands: ExtrudeOverlay["bands"] = [];
  for (let k = 1; k <= count; k++) {
    const lo = zMin + dir * k * depth, hi = zMax + dir * k * depth;
    if (hi < 0 || lo > maxZ) break;
    const cHi = Math.min(hi, maxZ), cLo = Math.max(lo, 0);
    bands.push({
      x: L.ox, y: L.oy + rowOffset(g, cHi) * L.scale,
      w: blocksW(g) * L.scale, h: Math.max(2, (cHi - cLo + 1) * L.scale),
      alpha: 0.22 - 0.05 * (k - 1),
    });
  }
  if (bands.length > 0 || count <= 0) return { bands, oob: null };
  return { bands, oob: { y: dir > 0 ? L.oy : L.oy + blocksH(g) * L.scale, dir } };
}

/** The band for a map-cursor column: the image column holding it (`colLod` blocks wide), or null
 *  when it's outside the image. Context columns count. */
export function hoverColumn(g: ImageGeom, L: Layout, worldCol: number): { x: number; w: number } | null {
  const i = Math.floor((worldCol - g.colLo) / g.colLod);
  if (i < 0 || i >= g.width) return null;
  return { x: L.ox + i * g.colLod * L.scale, w: g.colLod * L.scale };
}

/** Canvas x of the selection footprint's two edges (`lo`'s left edge, `hi`'s right edge). */
export function footprintEdges(g: ImageGeom, L: Layout, lo: number, hi: number): [number, number] {
  return [L.ox + (lo - g.colLo) * L.scale, L.ox + (hi + 1 - g.colLo) * L.scale];
}

/** Z ruler spacing for a px-per-row scale: labels every 16 (ticks every 8) normally, every 8 when
 *  zoomed in far, sparser when the rows are too tight to read. */
export function rulerSteps(scale: number): { label: number; tick: number } {
  const label = 8 * scale >= 56 ? 8 : [16, 32, 64].find(s => s * scale >= 12) ?? 128;
  return { label, tick: label / 2 };
}
