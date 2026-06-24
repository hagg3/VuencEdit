import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { brushFootprint, rectPixels, ellipsePixels, type BrushShape, type WP } from "./drawTools";

// Front slab = constant world-Y plane (horizontal axis = X, vertical = Z; row 0 = highest Z).
// Side slab  = constant world-X plane (horizontal axis = Y, vertical = Z; row 0 = highest Z).
// Top slab   = constant world-Z plane (horizontal axis = X, vertical = Y; row 0 = Y 0, no flip).
// Backed by render_yslice_patch / render_xslice_patch / render_zslice_patch (lib.rs).
export type SliceAxis = "front" | "side" | "top";

interface PixelPatchRaw { x: number; y: number; width: number; height: number; pixels: string; }

function decodePixels(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

interface Props {
  world: { width_chunks: number; height_chunks: number; max_z: number };
  axis: SliceAxis;
  /** Bumped by the parent after any edit so the slab refetches. */
  editEpoch?: number;
  /** World bounds (top-down X/Y) of the most recent edit. The slab refetches on an edit only if its
   *  depth plane falls inside these bounds — drawing elsewhere on the map won't trigger a refetch. */
  lastEdit?: { x: number; y: number; w: number; h: number } | null;
  /** Optional paint handler. Receives a batch of absolute world cells = one undo entry. */
  onPaint?: (cells: { x: number; y: number; z: number }[]) => void;
  /** Brush footprint applied at each painted cell (pen/brush tools). */
  brush?: { size: number; shape: BrushShape };
  /** Active draw tool — selects stroke (pen/brush) vs drag-shape (rect/ellipse) behaviour. */
  tool?: "pen" | "brush" | "rect" | "ellipse";
  /** Fill vs outline for rect/ellipse. */
  fill?: boolean;
  /** External depth control (the shared 3D crosshair). If omitted, depth is local. */
  depth?: number;
  onDepthChange?: (d: number) => void;
  /** Crosshair: vertical line at horizontal-axis world coord `crossH`; horizontal line at
   *  vertical-axis world coord `crossV` (Z for front/side, Y for top). */
  crossH?: number | null;
  crossV?: number | null;
  /** Selection extent along the slab's horizontal world axis (X for front, Y for side). When set,
   *  the slab fetches only this range + 50% context each side (grayed), with divider lines — far
   *  cheaper on large worlds than scanning the whole plane. */
  selRange?: { lo: number; hi: number } | null;
  /** Selection's Z range — draws the highlighted z-band box (ported from the elevation panel). */
  selZ?: { min: number; max: number } | null;
  /** Z-axis extrude preview: ghost bands above/below the selection. */
  extrudeCount?: number;
  extrudeAxis?: string;
  /** Paste-preview mode: band turns green and a clipboard elevation ghost is overlaid. */
  isPaste?: boolean;
  /** Drag the z-band's top/bottom edge to resize the selection's z range. */
  onZRangeChange?: (zMin: number, zMax: number) => void;
  /** Drag the selection's left/right divider to resize its horizontal range (X for front, Y for side).
   *  lo/hi are world coords along the slab's horizontal axis. */
  onHRangeChange?: (lo: number, hi: number) => void;
  /** Select tool active: left-drag draws a marquee that creates a new selection. */
  selectMode?: boolean;
  /** Commit a marquee selection. hLo/hHi = horizontal world axis (X front / Y side); zLo/zHi = Z. */
  onSelect?: (hLo: number, hHi: number, zLo: number, zHi: number) => void;
}

export default function SliceViewport({ world, axis, editEpoch, lastEdit, onPaint, brush, tool, fill, depth, onDepthChange, crossH, crossV, selRange, selZ, extrudeCount = 0, extrudeAxis = "z+", isPaste = false, onZRangeChange, onHRangeChange, selectMode = false, onSelect }: Props) {
  const worldW = world.width_chunks * 16;
  const worldH = world.height_chunks * 16;
  const maxZ = world.max_z;

  // Horizontal axis world extent: X for front/top, Y for side. Vertical axis: Z (front/side, flipped
  // so high Z is on top) or Y (top, no flip). `depth` = the fixed perpendicular coordinate.
  const planeW = axis === "side" ? worldH : worldW;
  const vMax = axis === "top" ? worldH - 1 : maxZ;          // max value of the vertical world axis
  const depthMax = axis === "front" ? worldH - 1 : axis === "side" ? worldW - 1 : maxZ;
  const rowToV = (row: number) => (axis === "top" ? row : maxZ - row);
  const vToRow = (v: number) => (axis === "top" ? v : maxZ - v);

  // Fetch window along the horizontal world axis. Two modes:
  //  • Selection-scoped (selRange set): fetch exactly the selection + 50% context each side. Cheap
  //    on huge worlds and fixed (no pan-scroll → no jumpiness).
  //  • Free (no selection): a bounded window that scrolls as the user pans.
  const MAX_WIN = 2048;
  const freeWinW = Math.min(planeW, MAX_WIN);
  const [winOrigin, setWinOrigin] = useState(0);
  const winOriginRef = useRef(0);

  const selScoped = selRange != null;
  const ctxCols = selRange ? Math.max(1, Math.round((selRange.hi - selRange.lo + 1) * 0.5)) : 0;
  const fetchLo = selRange
    ? Math.max(0, selRange.lo - ctxCols)
    : Math.max(0, Math.min(planeW - freeWinW, winOrigin));
  const fetchHi = selRange
    ? Math.min(planeW - 1, selRange.hi + ctxCols)
    : fetchLo + freeWinW - 1;
  winOriginRef.current = fetchLo; // cellToWorld / crosshair are relative to the fetched origin

  const [localDepth, setLocalDepth] = useState(Math.floor(depthMax / 2));
  const curDepth = depth ?? localDepth;
  const setDepth = useCallback((d: number) => {
    const c = Math.max(0, Math.min(depthMax, d));
    if (onDepthChange) onDepthChange(c); else setLocalDepth(c);
  }, [depthMax, onDepthChange]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const slabRef = useRef<HTMLCanvasElement | null>(null); // offscreen, planeW × (maxZ+1)
  const clipRef = useRef<HTMLCanvasElement | null>(null);  // offscreen clipboard ghost (paste preview)
  const viewRef = useRef({ x: 0, y: 0, scale: 2 });
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const zDragRef = useRef<{ edge: "min" | "max"; startY: number; startZ: number; scale: number } | null>(null);
  // Horizontal (X/Y) edge resize: previewed live in hPreviewRef, committed (→ refetch) on release.
  const hDragRef = useRef<{ edge: "lo" | "hi" } | null>(null);
  const hPreviewRef = useRef<{ lo: number; hi: number } | null>(null);
  const fittedRef = useRef(false);
  // In-progress rect/ellipse drag in slab-cell space (col,row) — drives the live ghost.
  const shapeRef = useRef<{ start: WP; end: WP } | null>(null);
  // In-progress marquee-select drag in slab-cell space (col,row) — drives the blue selection ghost.
  const marqueeRef = useRef<{ start: WP; end: WP } | null>(null);
  // Mirror of tool/fill props so the stable `draw` callback reads current values.
  const shapeToolRef = useRef(tool);
  const fillRef = useRef(fill);
  shapeToolRef.current = tool;
  fillRef.current = fill;
  const [, force] = useState(0);

  // Reset the free-scroll window when switching axis. (Re-fitting is handled when the fetched slab's
  // dimensions actually change — see the fetch handler below — so zoom is preserved on depth/edit refetch.)
  useEffect(() => { setWinOrigin(0); }, [axis]);

  // ── fetch the current horizontal window of the slab for the current depth ──
  // Fetched in horizontal strips so wide windows render progressively and don't block the UI on a
  // single multi-megabyte IPC blob. A sequence token discards stale responses (view/edit races).
  const STRIP = 256;
  const fetchSeqRef = useRef(0);
  const doFetch = useCallback(() => {
    const seq = ++fetchSeqRef.current;
    const h0 = fetchLo, h1 = fetchHi;
    const totalW = h1 - h0 + 1;
    const height = (axis === "top" ? vMax : maxZ) + 1;
    let slab = slabRef.current;
    if (!slab) { slab = document.createElement("canvas"); slabRef.current = slab; }
    // Resizing clears the canvas; do it once up front. Re-fit only when the footprint changes
    // (axis switch / new range / first load), not on same-size refetches (depth scrub, edits).
    if (slab.width !== totalW || slab.height !== height) {
      fittedRef.current = false;
      slab.width = totalW; slab.height = height;
    }
    const sctx = slab.getContext("2d")!;
    // front: render_yslice_patch(y,x1,z1,x2,z2); side: render_xslice_patch(x,y1,z1,y2,z2);
    // top: render_zslice_patch(z,x1,y1,x2,y2)
    const cmd = axis === "front" ? "render_yslice_patch" : axis === "side" ? "render_xslice_patch" : "render_zslice_patch";
    for (let s = h0; s <= h1; s += STRIP) {
      const e = Math.min(h1, s + STRIP - 1);
      const args = axis === "front"
        ? { y: curDepth, x1: s, z1: 0, x2: e, z2: maxZ }
        : axis === "side"
        ? { x: curDepth, y1: s, z1: 0, y2: e, z2: maxZ }
        : { z: curDepth, x1: s, y1: 0, x2: e, y2: vMax };
      const dx = s - h0;
      invoke<PixelPatchRaw>(cmd, args)
        .then((raw) => {
          if (seq !== fetchSeqRef.current) return; // superseded
          const px = decodePixels(raw.pixels);
          sctx.putImageData(new ImageData(new Uint8ClampedArray(px), raw.width, raw.height), dx, 0);
          force((n) => n + 1);
        })
        .catch(() => { /* no world / out of range */ });
    }
  }, [axis, curDepth, fetchLo, fetchHi, vMax, maxZ]);

  // View-driven refetch (axis / depth / selection range / window scroll).
  useEffect(() => { doFetch(); }, [doFetch]);

  // Edit-driven refetch — only when the edit's bounds intersect this slab's depth plane.
  const lastEpochRef = useRef(editEpoch);
  useEffect(() => {
    if (editEpoch === lastEpochRef.current) return;
    lastEpochRef.current = editEpoch;
    if (lastEdit) {
      const touched = axis === "front" ? (curDepth >= lastEdit.y && curDepth < lastEdit.y + lastEdit.h)
                    : axis === "side"  ? (curDepth >= lastEdit.x && curDepth < lastEdit.x + lastEdit.w)
                    : true; // top: patch has no z extent → always refetch
      if (!touched) return;
    }
    doFetch();
  }, [editEpoch, lastEdit, axis, curDepth, doFetch]);

  // Clipboard elevation ghost for paste preview (front/side image matching this slab's axis).
  useEffect(() => {
    if (!isPaste || axis === "top") { clipRef.current = null; force((n) => n + 1); return; }
    let cancelled = false;
    invoke<PixelPatchRaw>("render_clipboard_elevation_preview", { view: axis })
      .then((raw) => {
        if (cancelled) return;
        const px = decodePixels(raw.pixels);
        const c = document.createElement("canvas");
        c.width = raw.width; c.height = raw.height;
        c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(px), raw.width, raw.height), 0, 0);
        clipRef.current = c;
        force((n) => n + 1);
      })
      .catch(() => { clipRef.current = null; });
    return () => { cancelled = true; };
  }, [isPaste, axis, editEpoch]);

  // Scroll the fetch window to follow the view; keeps world coords visually anchored.
  // No-op when selection-scoped (the window is pinned to the selection) or the whole plane is loaded.
  const maybeMoveWindow = useCallback(() => {
    if (selScoped || freeWinW >= planeW) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const { x, scale } = viewRef.current;
    const centerWorld = (canvas.width / 2 - x) / scale + winOriginRef.current;
    const desired = Math.max(0, Math.min(planeW - freeWinW, Math.round(centerWorld - freeWinW / 2)));
    if (desired !== winOriginRef.current && Math.abs(desired - winOriginRef.current) >= 16) {
      // shift view.x so the same world column stays under the cursor after the origin moves
      viewRef.current.x += (winOriginRef.current - desired) * scale;
      setWinOrigin(desired);
    }
  }, [planeW, freeWinW, selScoped]);

  // ── paint the visible canvas from the offscreen slab ──────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current, slab = slabRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0a0f1e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!slab) return;
    const { x, y, scale } = viewRef.current;
    ctx.drawImage(slab, 0, 0, slab.width, slab.height, x, y, slab.width * scale, slab.height * scale);

    // Selection-scoped: gray out the context columns flanking the selection + draw divider lines.
    // effSel reflects an in-progress horizontal edge drag (preview) before it's committed.
    const effSel = hPreviewRef.current ?? selRange;
    if (effSel) {
      const a = effSel.lo - winOriginRef.current;       // slab col of selection start
      const b = effSel.hi - winOriginRef.current + 1;   // slab col just past selection end
      const slabBottom = y + slab.height * scale;
      ctx.fillStyle = "rgba(8,12,24,0.6)";
      if (a > 0) ctx.fillRect(x, y, a * scale, slab.height * scale);                       // left context
      if (b < slab.width) ctx.fillRect(x + b * scale, y, (slab.width - b) * scale, slab.height * scale); // right context
      ctx.strokeStyle = "rgba(148,163,184,0.65)";
      ctx.lineWidth = 1;
      for (const c of [a, b]) {
        if (c <= 0 || c >= slab.width) continue;
        const lx = x + c * scale;
        ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(lx, slabBottom); ctx.stroke();
      }
    }

    // Selection / paste z-band box (front/side only — vertical axis is Z). Ported from the
    // elevation panel: blue band for a selection, green band + clipboard ghost during paste.
    if (effSel && selZ && axis !== "top") {
      const a = effSel.lo - winOriginRef.current;
      const b = effSel.hi - winOriginRef.current + 1;
      const bandX = x + a * scale;
      const bandW = (b - a) * scale;
      const zTop = y + (maxZ - selZ.max) * scale;
      const bandH = Math.max(1, (selZ.max - selZ.min + 1) * scale);

      if (isPaste && clipRef.current) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(clipRef.current, bandX, zTop, bandW, bandH);
        ctx.restore();
      } else {
        ctx.fillStyle = isPaste ? "rgba(34,197,94,0.15)" : "rgba(59,130,246,0.22)";
        ctx.fillRect(bandX, zTop, bandW, bandH);
      }
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isPaste ? "rgba(74,222,128,0.9)" : "rgba(147,197,253,0.9)";
      ctx.strokeRect(bandX + 0.75, zTop + 0.75, bandW - 1.5, bandH - 1.5);
      ctx.setLineDash([]);

      // Z-axis extrude ghost bands.
      if (extrudeCount > 0 && (extrudeAxis === "z+" || extrudeAxis === "z-")) {
        const depthZ = selZ.max - selZ.min + 1;
        const dir = extrudeAxis === "z+" ? 1 : -1;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(74,222,128,0.85)";
        for (let k = 1; k <= extrudeCount; k++) {
          const cMin = selZ.min + dir * k * depthZ;
          const cMax = selZ.max + dir * k * depthZ;
          if (cMax < 0 || cMin > maxZ) break;
          const gMax = Math.min(cMax, maxZ), gMin = Math.max(cMin, 0);
          const gTop = y + (maxZ - gMax) * scale;
          const gH = Math.max(2, (gMax - gMin + 1) * scale);
          ctx.fillStyle = `rgba(34,197,94,${Math.max(0.05, 0.22 - 0.05 * (k - 1))})`;
          ctx.fillRect(bandX, gTop, bandW, gH);
          ctx.strokeRect(bandX + 0.75, gTop + 0.75, bandW - 1.5, Math.max(1, gH - 1.5));
        }
        ctx.setLineDash([]);
      }
    }

    // Crosshair: vertical line = where the perpendicular slab cuts (horizontal world coord);
    // horizontal line = the z-slice level. Both in slab-pixel space → screen.
    ctx.lineWidth = 1;
    const crossCol = crossH != null ? crossH - winOriginRef.current : null;
    if (crossCol != null && crossCol >= 0 && crossCol < slab.width) {
      const sx = x + (crossCol + 0.5) * scale;
      ctx.strokeStyle = "rgba(168,85,247,0.7)";
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height); ctx.stroke();
    }
    if (crossV != null) {
      const row = vToRow(crossV); // image row for that vertical-axis world coord
      if (row >= 0 && row < slab.height) {
        const sy = y + (row + 0.5) * scale;
        ctx.strokeStyle = "rgba(56,189,248,0.7)";
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke();
      }
    }

    // Live rect/ellipse drag ghost (sky-blue cells, like MapCanvas).
    const sh = shapeRef.current;
    if (sh) {
      ctx.fillStyle = "rgba(56,189,248,0.45)";
      const cells = shapeToolRef.current === "ellipse"
        ? ellipsePixels(sh.start, sh.end, fillRef.current ? "fill" : "outline")
        : rectPixels(sh.start, sh.end, fillRef.current ? "fill" : "outline");
      for (const p of cells) {
        if (p.x < 0 || p.x >= slab.width || p.y < 0 || p.y >= slab.height) continue;
        ctx.fillRect(x + p.x * scale, y + p.y * scale, Math.ceil(scale), Math.ceil(scale));
      }
    }

    // Live marquee-select ghost (blue box, like MapCanvas selection).
    const mq = marqueeRef.current;
    if (mq) {
      const c0 = Math.min(mq.start.x, mq.end.x), c1 = Math.max(mq.start.x, mq.end.x) + 1;
      const r0 = Math.min(mq.start.y, mq.end.y), r1 = Math.max(mq.start.y, mq.end.y) + 1;
      const bx = x + c0 * scale, by = y + r0 * scale;
      const bw = (c1 - c0) * scale, bh = (r1 - r0) * scale;
      ctx.fillStyle = "rgba(59,130,246,0.18)";
      ctx.fillRect(bx, by, bw, bh);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(147,197,253,0.95)";
      ctx.strokeRect(bx + 0.75, by + 0.75, bw - 1.5, bh - 1.5);
      ctx.setLineDash([]);
    }
  }, [crossH, crossV, axis, maxZ, selRange, selZ, extrudeCount, extrudeAxis, isPaste]);

  // Fit the whole slab into the canvas (contain) and center it.
  const fit = useCallback(() => {
    const canvas = canvasRef.current, slab = slabRef.current;
    if (!canvas || !slab) return;
    const s = Math.max(0.25, Math.min(32, Math.min(canvas.width / slab.width, canvas.height / slab.height)));
    viewRef.current = {
      scale: s,
      x: (canvas.width - slab.width * s) / 2,
      y: (canvas.height - slab.height * s) / 2,
    };
    draw();
  }, [draw]);

  // Auto-fit once the first slab + sized canvas are ready; redraw every render after.
  useEffect(() => {
    if (!fittedRef.current && canvasRef.current && slabRef.current && canvasRef.current.width > 1) {
      fittedRef.current = true;
      fit();
    } else {
      draw();
    }
  });

  // resize canvas to its container
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width));
      canvas.height = Math.max(1, Math.floor(r.height));
      draw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  // screen → slab pixel (col=horizontal world axis, row=image row). null if outside the slab.
  const screenToCell = (sx: number, sy: number): { col: number; row: number } | null => {
    const canvas = canvasRef.current, slab = slabRef.current;
    if (!canvas || !slab) return null;
    const r = canvas.getBoundingClientRect();
    const { x, y, scale } = viewRef.current;
    const col = Math.floor((sx - r.left - x) / scale);
    const row = Math.floor((sy - r.top - y) / scale);
    if (col < 0 || row < 0 || col >= slab.width || row >= slab.height) return null;
    return { col, row };
  };

  // Accumulates the cells of an in-progress paint stroke (deduped) → one undo entry on release.
  const strokeRef = useRef<Map<string, { x: number; y: number; z: number }> | null>(null);

  // Convert a slab cell (col,row) to an absolute world cell, or null if out of bounds.
  // Slab col is relative to the current fetch-window origin.
  const cellToWorld = (p: WP): { x: number; y: number; z: number } | null => {
    const h = p.x + winOriginRef.current;
    const v = rowToV(p.y);
    if (h < 0 || h >= planeW || v < 0 || v > vMax) return null;
    if (axis === "front") return { x: h, y: curDepth, z: v };
    if (axis === "side")  return { x: curDepth, y: h, z: v };
    return { x: h, y: v, z: curDepth }; // top
  };

  const isShapeTool = tool === "rect" || tool === "ellipse";

  // Z-band edge hit-test (canvas-local Y) for the z-resize handles. Front/side only.
  const Z_EDGE_HIT = 5;
  const localY = (clientY: number) => clientY - (canvasRef.current?.getBoundingClientRect().top ?? 0);
  const localX = (clientX: number) => clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0);
  const hitZEdge = (ly: number): "min" | "max" | null => {
    if (!onZRangeChange || !selZ || axis === "top") return null;
    const { y, scale } = viewRef.current;
    const zMaxY = y + (maxZ - selZ.max) * scale;
    const zMinY = y + (maxZ - selZ.min + 1) * scale;
    if (Math.abs(ly - zMaxY) <= Z_EDGE_HIT) return "max";
    if (Math.abs(ly - zMinY) <= Z_EDGE_HIT) return "min";
    return null;
  };
  // Selection left/right divider hit-test (canvas-local X).
  const hitHEdge = (lx: number): "lo" | "hi" | null => {
    if (!onHRangeChange || !selRange) return null;
    const { x, scale } = viewRef.current;
    const loX = x + (selRange.lo - winOriginRef.current) * scale;
    const hiX = x + (selRange.hi - winOriginRef.current + 1) * scale;
    if (Math.abs(lx - loX) <= Z_EDGE_HIT) return "lo";
    if (Math.abs(lx - hiX) <= Z_EDGE_HIT) return "hi";
    return null;
  };
  // World horizontal coord under a canvas-local X.
  const localXToWorld = (lx: number) => Math.floor((lx - viewRef.current.x) / viewRef.current.scale) + winOriginRef.current;

  const addFootprint = (sx: number, sy: number) => {
    const cell = screenToCell(sx, sy);
    if (!cell || !strokeRef.current) return;
    for (const p of brushFootprint({ x: cell.col, y: cell.row }, brush?.size ?? 1, brush?.shape ?? "sq")) {
      const w = cellToWorld(p);
      if (w) strokeRef.current.set(`${w.x},${w.y},${w.z}`, w);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const leftBtn = e.button === 0 && !e.altKey;
    const zEdge = leftBtn ? hitZEdge(localY(e.clientY)) : null;
    const hEdge = leftBtn && !zEdge ? hitHEdge(localX(e.clientX)) : null;
    if (e.button === 1 || e.button === 2 || e.altKey) {
      const v = viewRef.current;
      dragRef.current = { sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
      (e.target as Element).setPointerCapture(e.pointerId);
    } else if (zEdge && selZ) {
      // Z-resize takes priority over draw/pan.
      zDragRef.current = { edge: zEdge, startY: localY(e.clientY), startZ: zEdge === "max" ? selZ.max : selZ.min, scale: viewRef.current.scale };
      (e.target as Element).setPointerCapture(e.pointerId);
    } else if (hEdge && selRange) {
      // Horizontal (X/Y) edge resize — preview only; commit on release.
      hDragRef.current = { edge: hEdge };
      hPreviewRef.current = { lo: selRange.lo, hi: selRange.hi };
      (e.target as Element).setPointerCapture(e.pointerId);
    } else if (selectMode && onSelect) {
      // Marquee a new selection on this plane.
      const cell = screenToCell(e.clientX, e.clientY);
      if (cell) {
        marqueeRef.current = { start: { x: cell.col, y: cell.row }, end: { x: cell.col, y: cell.row } };
        (e.target as Element).setPointerCapture(e.pointerId);
        draw();
      } else {
        // Clicked outside the slab → pan instead.
        const v = viewRef.current;
        dragRef.current = { sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
        (e.target as Element).setPointerCapture(e.pointerId);
      }
    } else if (onPaint && isShapeTool) {
      const cell = screenToCell(e.clientX, e.clientY);
      if (cell) {
        shapeRef.current = { start: { x: cell.col, y: cell.row }, end: { x: cell.col, y: cell.row } };
        (e.target as Element).setPointerCapture(e.pointerId);
        draw();
      }
    } else if (onPaint) {
      strokeRef.current = new Map();
      addFootprint(e.clientX, e.clientY);
      (e.target as Element).setPointerCapture(e.pointerId);
    } else {
      // No draw tool active → left-drag pans (matches MapCanvas).
      const v = viewRef.current;
      dragRef.current = { sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
      (e.target as Element).setPointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const zd = zDragRef.current;
    if (zd && onZRangeChange && selZ) {
      const dz = Math.round((zd.startY - localY(e.clientY)) / zd.scale);
      const nz = Math.max(0, Math.min(maxZ, zd.startZ + dz));
      if (zd.edge === "max") onZRangeChange(Math.min(selZ.min, nz), nz);
      else onZRangeChange(nz, Math.max(selZ.max, nz));
      return;
    }
    const hd = hDragRef.current;
    if (hd && hPreviewRef.current && selRange) {
      const w = Math.max(0, Math.min(planeW - 1, localXToWorld(localX(e.clientX))));
      hPreviewRef.current = hd.edge === "lo"
        ? { lo: Math.min(w, selRange.hi), hi: selRange.hi }
        : { lo: selRange.lo, hi: Math.max(w, selRange.lo) };
      draw();
      return;
    }
    // Hover cursor feedback for the resize edges when idle (z = ns, x/y = ew).
    if (e.buttons === 0 && canvasRef.current) {
      const c = hitZEdge(localY(e.clientY)) ? "ns-resize" : hitHEdge(localX(e.clientX)) ? "ew-resize" : (onPaint || selectMode ? "crosshair" : "grab");
      canvasRef.current.style.cursor = c;
    }
    if (marqueeRef.current) {
      const cell = screenToCell(e.clientX, e.clientY);
      if (cell) { marqueeRef.current.end = { x: cell.col, y: cell.row }; draw(); }
      return;
    }
    const d = dragRef.current;
    if (d) {
      viewRef.current.x = d.vx + (e.clientX - d.sx);
      viewRef.current.y = d.vy + (e.clientY - d.sy);
      draw();
    } else if (shapeRef.current) {
      const cell = screenToCell(e.clientX, e.clientY);
      if (cell) { shapeRef.current.end = { x: cell.col, y: cell.row }; draw(); }
    } else if (strokeRef.current) {
      addFootprint(e.clientX, e.clientY);
    }
  };
  const onPointerUp = () => {
    if (zDragRef.current) { zDragRef.current = null; return; }
    if (hDragRef.current) {
      const p = hPreviewRef.current;
      hDragRef.current = null; hPreviewRef.current = null;
      if (p && onHRangeChange) onHRangeChange(p.lo, p.hi);
      draw();
      return;
    }
    if (dragRef.current) { dragRef.current = null; maybeMoveWindow(); return; }
    if (marqueeRef.current) {
      const m = marqueeRef.current;
      marqueeRef.current = null;
      const c0 = Math.min(m.start.x, m.end.x), c1 = Math.max(m.start.x, m.end.x);
      const r0 = Math.min(m.start.y, m.end.y), r1 = Math.max(m.start.y, m.end.y);
      const hLo = Math.max(0, Math.min(planeW - 1, c0 + winOriginRef.current));
      const hHi = Math.max(0, Math.min(planeW - 1, c1 + winOriginRef.current));
      const v0 = rowToV(r0), v1 = rowToV(r1);
      const vLo = Math.max(0, Math.min(vMax, Math.min(v0, v1)));
      const vHi = Math.max(0, Math.min(vMax, Math.max(v0, v1)));
      draw();
      if (onSelect) onSelect(hLo, hHi, vLo, vHi);
      return;
    }
    if (shapeRef.current) {
      const { start, end } = shapeRef.current;
      shapeRef.current = null;
      const mode = fill ? "fill" : "outline";
      const plane = tool === "ellipse" ? ellipsePixels(start, end, mode) : rectPixels(start, end, mode);
      const cells = plane.map(cellToWorld).filter((c): c is { x: number; y: number; z: number } => c != null);
      draw();
      if (cells.length && onPaint) onPaint(cells);
    } else if (strokeRef.current) {
      const cells = [...strokeRef.current.values()];
      strokeRef.current = null;
      if (cells.length && onPaint) onPaint(cells);
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const v = viewRef.current;
    const r = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const ns = Math.max(0.25, Math.min(32, v.scale * factor));
    v.x = mx - (mx - v.x) * (ns / v.scale);
    v.y = my - (my - v.y) * (ns / v.scale);
    v.scale = ns;
    draw();
    // NB: do NOT refetch on zoom — the slab is already cached offscreen and just
    // redrawn at the new scale. The fetch window only moves on pan-end (heavy IPC).
  };

  const label = axis === "front" ? `Front  (Y=${curDepth})` : axis === "side" ? `Side  (X=${curDepth})` : `Top  (Z=${curDepth})`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0a0f1e", color: "#cbd5e1", userSelect: "none", WebkitUserSelect: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", fontSize: 11, borderBottom: "1px solid #1e293b" }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <input
          type="range" min={0} max={depthMax} value={curDepth}
          onChange={(e) => setDepth(parseInt(e.target.value, 10))}
          style={{ flex: 1 }}
        />
        <input
          type="number" min={0} max={depthMax} value={curDepth}
          onChange={(e) => setDepth(parseInt(e.target.value, 10) || 0)}
          style={{ width: 56, background: "#1e293b", color: "#cbd5e1", border: "1px solid #334155", borderRadius: 4 }}
        />
        <button
          onClick={fit}
          title="Fit slab to view"
          style={{ background: "#1e293b", color: "#cbd5e1", border: "1px solid #334155", borderRadius: 4, padding: "1px 6px", cursor: "pointer" }}
        >⊡</button>
      </div>
      <canvas
        ref={canvasRef}
        style={{ flex: 1, width: "100%", cursor: onPaint || selectMode ? "crosshair" : "grab", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
