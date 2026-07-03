export interface WP { x: number; y: number }
export type BrushShape = "sq" | "circ";
export type FillMode = "fill" | "outline";

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
  const seen = new Set<string>();
  const pts: WP[] = [];
  for (const c of centre) {
    for (const p of brushFootprint(c, size, shape)) {
      const k = `${p.x},${p.y}`;
      if (!seen.has(k)) { seen.add(k); pts.push(p); }
    }
  }
  return pts;
}

/** Filled or outlined polygon from an ordered vertex list (auto-closed). */
export function polygonPixels(verts: WP[], mode: FillMode): WP[] {
  if (verts.length === 0) return [];
  if (verts.length === 1) return [{ x: verts[0].x, y: verts[0].y }];
  // Edge pixels (closed loop) via bresenham between consecutive vertices.
  const edge: WP[] = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    for (const p of bresenhamLine(a, b)) edge.push(p);
  }
  if (mode === "outline" || verts.length < 3) return dedup(edge);
  // Scanline fill: for each row, find polygon-edge crossings and fill between pairs.
  let minY = Infinity, maxY = -Infinity;
  for (const v of verts) { minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
  const pts: WP[] = [...edge];
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
      for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) pts.push({ x, y });
    }
  }
  return dedup(pts);
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
  const pts: WP[] = [];
  for (const [y, { minX, maxX }] of rows) {
    for (let x = minX; x <= maxX; x++) pts.push({ x, y });
  }
  return dedup(pts);
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
  const seen = new Set<string>();
  return pts.filter(p => {
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
