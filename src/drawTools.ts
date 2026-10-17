export interface WP { x: number; y: number }
export type BrushShape = "sq" | "circ";
export type FillMode = "fill" | "outline";

// Numeric cell keys (audit M8): `x * 2^32 + y` is unique for |y| < 2^31 and exact in a double for
// |x| < 2^20, far beyond any world coordinate. Replaces `"x,y"` string keys (and their per-cell
// `parseInt` on the way back out). `Set` insertion order is unchanged, so iteration order is too.
const KEY_STRIDE = 4294967296;
export function cellKey(x: number, y: number): number { return x * KEY_STRIDE + y; }
export function cellKeyX(k: number): number { return Math.floor((k + 2147483648) / KEY_STRIDE); }
export function cellKeyY(k: number): number { return k - cellKeyX(k) * KEY_STRIDE; }

export function penFootprint(p: WP): WP[] {
  return [{ x: p.x, y: p.y }];
}

export function brushFootprint(p: WP, size: number, shape: BrushShape): WP[] {
  if (size <= 1) return penFootprint(p);
  const half = Math.floor(size / 2);
  const r2 = (size / 2) * (size / 2);
  const pts: WP[] = [];
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      if (shape === "circ" && dx * dx + dy * dy > r2) continue;
      pts.push({ x: p.x + dx, y: p.y + dy });
    }
  }
  return pts;
}

export function bresenhamLine(a: WP, b: WP): WP[] {
  const pts: WP[] = [];
  let { x, y } = a;
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
  let err = dx - dy;
  while (true) {
    pts.push({ x, y });
    if (x === b.x && y === b.y) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 <  dx) { err += dx; y += sy; }
  }
  return pts;
}

/** A straight line from a→b, thickened by stamping the brush footprint along it. */
export function linePixels(a: WP, b: WP, size: number, shape: BrushShape): WP[] {
  const centre = bresenhamLine(a, b);
  if (size <= 1) return centre;
  const seen = new Set<number>();
  const pts: WP[] = [];
  for (const c of centre) {
    for (const p of brushFootprint(c, size, shape)) {
      const k = cellKey(p.x, p.y);
      if (!seen.has(k)) { seen.add(k); pts.push(p); }
    }
  }
  return pts;
}

/** Edge pixels of the closed vertex loop, plus (fill, >= 3 verts) one `[xa, xb]` run per scanline
 *  span. Runs are inclusive and may overlap the edge pixels — callers dedupe or OR into a bitset. */
function polygonEdgeAndRuns(verts: WP[], fill: boolean): { edge: WP[]; runs: { y: number; xa: number; xb: number }[] } {
  const edge: WP[] = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    for (const p of bresenhamLine(a, b)) edge.push(p);
  }
  const runs: { y: number; xa: number; xb: number }[] = [];
  if (!fill || verts.length < 3) return { edge, runs };
  // Scanline fill: for each row, find polygon-edge crossings and fill between pairs.
  let minY = Infinity, maxY = -Infinity;
  for (const v of verts) { minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
    const xs: number[] = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const y1 = a.y, y2 = b.y;
      // Half-open edge test avoids double-counting shared vertices.
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(a.x + ((y - y1) / (y2 - y1)) * (b.x - a.x));
      }
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.ceil(xs[i]), xb = Math.floor(xs[i + 1]);
      if (xa <= xb) runs.push({ y, xa, xb });
    }
  }
  return { edge, runs };
}

/** Filled or outlined polygon from an ordered vertex list (auto-closed). */
export function polygonPixels(verts: WP[], mode: FillMode): WP[] {
  if (verts.length === 0) return [];
  if (verts.length === 1) return [{ x: verts[0].x, y: verts[0].y }];
  const { edge, runs } = polygonEdgeAndRuns(verts, mode !== "outline");
  if (runs.length === 0) return dedup(edge);
  const seen = new Set<number>();
  const pts: WP[] = [];
  for (const p of edge) {
    const k = cellKey(p.x, p.y);
    if (!seen.has(k)) { seen.add(k); pts.push(p); }
  }
  for (const r of runs) {
    for (let x = r.xa; x <= r.xb; x++) {
      const k = cellKey(x, r.y);
      if (!seen.has(k)) { seen.add(k); pts.push({ x, y: r.y }); }
    }
  }
  return pts;
}

/**
 * The filled polygon straight into a row-major selection bitset — no per-cell objects (audit M7).
 * Same cells as `polygonPixels(verts, "fill")`, with the bbox's min corner clamped to 0 (negative
 * world coords don't exist) exactly as the old caller did. Bit `(y-y1)*width + (x-x1)`. Returns
 * null when the polygon has no cells.
 */
export function polygonMask(verts: WP[]): { x1: number; y1: number; x2: number; y2: number; bits: Uint8Array } | null {
  if (verts.length === 0) return null;
  let edge: WP[], runs: { y: number; xa: number; xb: number }[];
  if (verts.length === 1) { edge = [{ x: verts[0].x, y: verts[0].y }]; runs = []; }
  else ({ edge, runs } = polygonEdgeAndRuns(verts, true));
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of edge) {
    if (p.x < x1) x1 = p.x; if (p.x > x2) x2 = p.x;
    if (p.y < y1) y1 = p.y; if (p.y > y2) y2 = p.y;
  }
  for (const r of runs) {
    if (r.xa < x1) x1 = r.xa; if (r.xb > x2) x2 = r.xb;
    if (r.y < y1) y1 = r.y; if (r.y > y2) y2 = r.y;
  }
  x1 = Math.max(0, x1); y1 = Math.max(0, y1);
  const width = x2 - x1 + 1, height = y2 - y1 + 1;
  const bits = new Uint8Array(Math.ceil((width * height) / 8));
  const set = (x: number, y: number) => {
    if (x < x1 || x > x2 || y < y1 || y > y2) return;
    const i = (y - y1) * width + (x - x1);
    bits[i >> 3] |= 1 << (i & 7);
  };
  for (const p of edge) set(p.x, p.y);
  for (const r of runs) {
    for (let x = Math.max(r.xa, x1); x <= r.xb; x++) set(x, r.y);
  }
  return { x1, y1, x2, y2, bits };
}

export function rectPixels(a: WP, b: WP, mode: FillMode): WP[] {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  const pts: WP[] = [];
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      if (mode === "fill" || x === x1 || x === x2 || y === y1 || y === y2) {
        pts.push({ x, y });
      }
    }
  }
  return pts;
}

/** Rect as inclusive cell rectangles `[x, y, w, h]` — a ghost paints these with `fillRect` instead
 *  of one call per cell. Union equals `rectPixels(a, b, mode)`; outline strips never overlap. */
export function rectRects(a: WP, b: WP, mode: FillMode): [number, number, number, number][] {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  const w = x2 - x1 + 1, h = y2 - y1 + 1;
  if (mode === "fill" || w <= 2 || h <= 2) return [[x1, y1, w, h]];
  return [
    [x1, y1, w, 1],          // top row
    [x1, y2, w, 1],          // bottom row
    [x1, y1 + 1, 1, h - 2],  // left column, between the rows
    [x2, y1 + 1, 1, h - 2],  // right column
  ];
}

/** Filled ellipse as per-row runs `[y, xa, xb]` (inclusive) with no per-cell objects. Same cells as
 *  `ellipsePixels(a, b, "fill")` as a set. */
export function ellipseFillRuns(a: WP, b: WP): [number, number, number][] {
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
  if (rx === 0 && ry === 0) return [[Math.round(cy), Math.round(cx), Math.round(cx)]];
  const rows = new Map<number, { minX: number; maxX: number }>();
  for (const p of midpointEllipse(cx, cy, rx, ry)) {
    const r = rows.get(p.y);
    if (!r) rows.set(p.y, { minX: p.x, maxX: p.x });
    else { if (p.x < r.minX) r.minX = p.x; if (p.x > r.maxX) r.maxX = p.x; }
  }
  const out: [number, number, number][] = [];
  for (const [y, { minX, maxX }] of rows) out.push([y, minX, maxX]);
  return out;
}

export function ellipsePixels(a: WP, b: WP, mode: FillMode): WP[] {
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
  if (rx === 0 && ry === 0) return [{ x: Math.round(cx), y: Math.round(cy) }];
  const boundary = midpointEllipse(cx, cy, rx, ry);
  if (mode === "outline") return dedup(boundary);
  // Fill: scanline fill from boundary
  const rows = new Map<number, { minX: number; maxX: number }>();
  for (const p of boundary) {
    const r = rows.get(p.y);
    if (!r) rows.set(p.y, { minX: p.x, maxX: p.x });
    else { r.minX = Math.min(r.minX, p.x); r.maxX = Math.max(r.maxX, p.x); }
  }
  // Rows are unique per y and runs don't overlap, so no dedup pass is needed.
  const pts: WP[] = [];
  for (const [y, { minX, maxX }] of rows) {
    for (let x = minX; x <= maxX; x++) pts.push({ x, y });
  }
  return pts;
}

function midpointEllipse(cx: number, cy: number, rx: number, ry: number): WP[] {
  const pts: WP[] = [];
  if (rx === 0) {
    for (let dy = -Math.round(ry); dy <= Math.round(ry); dy++) pts.push({ x: Math.round(cx), y: Math.round(cy + dy) });
    return pts;
  }
  if (ry === 0) {
    for (let dx = -Math.round(rx); dx <= Math.round(rx); dx++) pts.push({ x: Math.round(cx + dx), y: Math.round(cy) });
    return pts;
  }
  const rx2 = rx * rx, ry2 = ry * ry;
  let x = 0, y = Math.round(ry);
  const plot = (dx: number, dy: number) => {
    pts.push({ x: Math.round(cx + dx), y: Math.round(cy + dy) });
    pts.push({ x: Math.round(cx - dx), y: Math.round(cy + dy) });
    pts.push({ x: Math.round(cx + dx), y: Math.round(cy - dy) });
    pts.push({ x: Math.round(cx - dx), y: Math.round(cy - dy) });
  };
  // Region 1
  let p1 = ry2 - rx2 * ry + 0.25 * rx2;
  while (2 * ry2 * x < 2 * rx2 * y) {
    plot(x, y);
    x++;
    if (p1 < 0) { p1 += 2 * ry2 * x + ry2; }
    else { y--; p1 += 2 * ry2 * x - 2 * rx2 * y + ry2; }
  }
  // Region 2
  let p2 = ry2 * (x + 0.5) * (x + 0.5) + rx2 * (y - 1) * (y - 1) - rx2 * ry2;
  while (y >= 0) {
    plot(x, y);
    y--;
    if (p2 > 0) { p2 += rx2 - 2 * rx2 * y; }
    else { x++; p2 += 2 * ry2 * x - 2 * rx2 * y + rx2; }
  }
  return pts;
}

function dedup(pts: WP[]): WP[] {
  const seen = new Set<number>();
  return pts.filter(p => {
    const k = cellKey(p.x, p.y);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
