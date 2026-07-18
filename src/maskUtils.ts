// Shared helpers for the non-rectangular selection mask (wand/lasso footprint). Pure functions.
//
// The mask is a bbox (x1..x2, y1..y2 inclusive, absolute world coords) plus a row-major bitset,
// bit `(y-y1)*width + (x-x1)` set = that column is selected. This mirrors the backend
// `SelectionMask` (lib.rs) exactly, so the same bit index works on both sides.

export interface MaskShape {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  bits: Uint8Array;
}

/** Rectangle covering columns `x0..=x1b`, `y0..=y1b` (inclusive, absolute world coords). */
export interface MaskRect {
  x0: number;
  y0: number;
  x1: number; // inclusive max X
  y1: number; // inclusive max Y
}

function bitSet(bits: Uint8Array, i: number): boolean {
  return (bits[i >> 3] & (1 << (i & 7))) !== 0;
}

/** A point on the world grid *lattice* (cell corner, not cell centre). See {@link maskOutline}. */
export interface OutlinePt {
  x: number;
  y: number;
}

/**
 * Trace the boundary of a mask footprint into a set of closed rectilinear loops.
 *
 * Coordinates are **grid-corner** coordinates, not cell indices: a selected cell `(x, y)` occupies
 * the unit square whose corners are `(x, y)`, `(x+1, y)`, `(x+1, y+1)`, `(x, y+1)`. So a single set
 * cell at world `(4, 4)` returns one loop `[(4,4),(5,4),(5,5),(4,5)]`. Consumers scale these the same
 * way they place the selection box (2D: `corner * scale + viewOffset`; 3D: straight into Three coords),
 * which is why the loops carry the `+1` far edge rather than inclusive-max cell indices.
 *
 * Method: every cell edge that borders an *unset* neighbour (or the world outside the bbox) is a
 * boundary edge. Each set cell emits its four edges wound clockwise in screen space (y-down), so the
 * shared edge between two set cells appears once in each direction and cancels — only true boundary
 * edges survive. The survivors are stitched head-to-tail into closed loops (an Euler walk: every
 * boundary vertex has equal in/out degree, so a walk from any vertex returns to it). Outer loops come
 * out clockwise, holes counter-clockwise.
 *
 * Collinear runs are merged, so a straight span of N cells contributes two endpoints, not N. Returns
 * one loop per connected boundary component (multiple when the shape has holes or disjoint islands).
 */
export function maskOutline(mask: MaskShape): OutlinePt[][] {
  const isSet = (cx: number, cy: number): boolean => {
    if (cx < mask.x1 || cx > mask.x2 || cy < mask.y1 || cy > mask.y2) return false;
    const w = mask.x2 - mask.x1 + 1;
    return bitSet(mask.bits, (cy - mask.y1) * w + (cx - mask.x1));
  };

  // Directed boundary edges keyed by start vertex → list of end vertices (a multimap handles the
  // rare pinch vertex where two diagonally-touching islands share a corner).
  const key = (x: number, y: number) => `${x},${y}`;
  const edges = new Map<string, OutlinePt[]>();
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const k = key(ax, ay);
    const arr = edges.get(k);
    if (arr) arr.push({ x: bx, y: by });
    else edges.set(k, [{ x: bx, y: by }]);
  };

  for (let cy = mask.y1; cy <= mask.y2; cy++) {
    for (let cx = mask.x1; cx <= mask.x2; cx++) {
      if (!isSet(cx, cy)) continue;
      // Clockwise (y-down): top → right → bottom → left. Emit only the sides facing empty space.
      if (!isSet(cx, cy - 1)) addEdge(cx, cy, cx + 1, cy);           // top
      if (!isSet(cx + 1, cy)) addEdge(cx + 1, cy, cx + 1, cy + 1);   // right
      if (!isSet(cx, cy + 1)) addEdge(cx + 1, cy + 1, cx, cy + 1);   // bottom
      if (!isSet(cx - 1, cy)) addEdge(cx, cy + 1, cx, cy);           // left
    }
  }

  const loops: OutlinePt[][] = [];
  for (const startKey of edges.keys()) {
    // A key can seed several loops if it's a pinch vertex; drain it fully.
    while ((edges.get(startKey)?.length ?? 0) > 0) {
      const loop: OutlinePt[] = [];
      let curKey = startKey;
      // Follow edges until we arrive back at the start vertex.
      for (;;) {
        const outs = edges.get(curKey);
        if (!outs || outs.length === 0) break; // defensive: shouldn't happen for a closed boundary
        const next = outs.pop()!;
        const [cx, cy] = curKey.split(",").map(Number);
        loop.push({ x: cx, y: cy });
        curKey = key(next.x, next.y);
        if (curKey === startKey) break;
      }
      if (loop.length >= 3) loops.push(simplifyCollinear(loop));
    }
  }
  return loops;
}

/**
 * Flat vertex positions for a shaped-selection **prism**: the mask footprint (contour `loops` +
 * solid `caps` rects) extruded between Eden z `zBottom`..`zTop`. Pure geometry — no Three.js — so it
 * can be unit-tested; the caller wraps `fill`/`edges` into `BufferGeometry` position attributes.
 *
 * Every triple is a Three-space vertex `[eden_x, eden_z (height), eden_y]`, matching the box overlays.
 * `fill` is a triangle soup (2 tris per quad): one wall quad per contour segment (extruded top↔bottom)
 * plus a top and bottom cap quad per rect. Walls sit only on the true boundary, so there are no
 * internal partitions to double-blend; caps tile the footprint without overlap and are coplanar.
 * `edges` is a line-segment list: the top rim, the bottom rim, and a vertical post at each corner.
 */
export function maskPrismPositions(
  loops: OutlinePt[][], caps: MaskRect[], zBottom: number, zTop: number,
): { fill: number[]; edges: number[] } {
  const fill: number[] = [];
  const quad = (
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
  ) => { fill.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz); };

  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      quad(a.x, zBottom, a.y, b.x, zBottom, b.y, b.x, zTop, b.y, a.x, zTop, a.y);
    }
  }
  for (const r of caps) {
    const x0 = r.x0, y0 = r.y0, x1 = r.x1 + 1, y1 = r.y1 + 1;
    quad(x0, zTop, y0, x1, zTop, y0, x1, zTop, y1, x0, zTop, y1);             // top cap
    quad(x0, zBottom, y0, x0, zBottom, y1, x1, zBottom, y1, x1, zBottom, y0); // bottom cap
  }

  const edges: number[] = [];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      edges.push(a.x, zTop, a.y, b.x, zTop, b.y);           // top rim
      edges.push(a.x, zBottom, a.y, b.x, zBottom, b.y);     // bottom rim
      edges.push(a.x, zBottom, a.y, a.x, zTop, a.y);        // vertical corner post
    }
  }
  return { fill, edges };
}

/** Drop vertices that lie on a straight run (a corner span of N same-direction edges → its 2 ends). */
function simplifyCollinear(loop: OutlinePt[]): OutlinePt[] {
  const n = loop.length;
  if (n < 3) return loop;
  const out: OutlinePt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const cur = loop[i];
    const next = loop[(i + 1) % n];
    // Keep the vertex only if the incoming and outgoing directions differ (a real corner).
    const collinear = (cur.x - prev.x) * (next.y - cur.y) === (cur.y - prev.y) * (next.x - cur.x);
    if (!collinear) out.push(cur);
  }
  return out.length >= 3 ? out : loop;
}

/**
 * Greedy maximal-rectangle decomposition of a mask footprint into a small set of solid rectangles.
 *
 * For each not-yet-covered set cell, grow a rectangle right as far as the row stays set, then grow
 * that width-span down as far as every row below is fully set — a cheap, deterministic O(cells)
 * pass that merges large solid regions (a filled lake becomes one rect) while still resolving
 * ragged edges into a handful of slabs.
 *
 * Returns `null` when the footprint fragments past `maxRects` (a checkerboard / hatched mask),
 * signalling the caller to fall back to a single bbox overlay rather than flooding the scene with
 * hundreds of tiny boxes.
 */
export function decomposeMask(mask: MaskShape, maxRects = 64): MaskRect[] | null {
  const w = mask.x2 - mask.x1 + 1;
  const h = mask.y2 - mask.y1 + 1;
  if (w <= 0 || h <= 0) return null;
  const covered = new Uint8Array(w * h);
  const rects: MaskRect[] = [];

  for (let ry = 0; ry < h; ry++) {
    for (let rx = 0; rx < w; rx++) {
      const idx = ry * w + rx;
      if (covered[idx] || !bitSet(mask.bits, idx)) continue;

      // Grow right along this row.
      let rw = 1;
      while (rx + rw < w) {
        const j = ry * w + rx + rw;
        if (covered[j] || !bitSet(mask.bits, j)) break;
        rw++;
      }

      // Grow down while every column in [rx, rx+rw) stays set and uncovered.
      let rh = 1;
      grow: while (ry + rh < h) {
        for (let cx = rx; cx < rx + rw; cx++) {
          const j = (ry + rh) * w + cx;
          if (covered[j] || !bitSet(mask.bits, j)) break grow;
        }
        rh++;
      }

      for (let yy = ry; yy < ry + rh; yy++) {
        for (let xx = rx; xx < rx + rw; xx++) covered[yy * w + xx] = 1;
      }

      rects.push({
        x0: mask.x1 + rx,
        y0: mask.y1 + ry,
        x1: mask.x1 + rx + rw - 1,
        y1: mask.y1 + ry + rh - 1,
      });
      if (rects.length > maxRects) return null; // too fragmented → caller uses the bbox fallback
    }
  }

  return rects.length > 0 ? rects : null;
}
