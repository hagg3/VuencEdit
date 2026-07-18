import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { brushFootprint, rectPixels, ellipsePixels, type BrushShape, type WP } from "./drawTools";
import { chromeButton, chromeButtonAccent, recessedWell } from "./designTokens";
import type { PixelPatchRaw } from "./types";
import { zoomAtPoint, resizeCanvasToContainer, makeSeqGuard, putPatchPixels, beginFrame, cssWidth, cssHeight, isTypingTarget } from "./viewportUtils";

// Front slab = constant world-Y plane (horizontal axis = X, vertical = Z; row 0 = highest Z).
// Side slab  = constant world-X plane (horizontal axis = Y, vertical = Z; row 0 = highest Z).
// Top slab   = constant world-Z plane (horizontal axis = X, vertical = Y; row 0 = Y 0, no flip).
// Backed by render_yslice_patch / render_xslice_patch / render_zslice_patch (lib.rs).
export type SliceAxis = "front" | "side" | "top";

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
  /** Full 3D selection bounds. When set on front/side viewports, enables ortho projection mode
   *  (auto-enabled; shows solid facade of selection instead of a depth slab). */
  selFull?: { xLo: number; yLo: number; xHi: number; yHi: number; zLo: number; zHi: number } | null;
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
  /** Cutaway cap Z (null = not in cutaway). Front/side slabs draw a line at it and dim everything
   *  above, so the plane the top-down map is cutting at is visible in elevation too. Overlay only —
   *  the slab pixels themselves are unchanged (you can still see, and paint, what's above). */
  viewCapZ?: number | null;
  /** Select tool active: left-drag draws a marquee that creates a new selection. */
  selectMode?: boolean;
  /** Commit a marquee selection. hLo/hHi = horizontal world axis (X front / Y side); zLo/zHi = Z. */
  onSelect?: (hLo: number, hHi: number, zLo: number, zHi: number) => void;
  /** Surface a one-off explanation to the user (App shows it as a toast). Used when ortho mode
   *  auto-enables and quietly takes painting away. */
  onNotice?: (msg: string) => void;
}

export default function SliceViewport({ world, axis, editEpoch, lastEdit, onPaint, brush, tool, fill, depth, onDepthChange, crossH, crossV, selRange, selZ, selFull, extrudeCount = 0, extrudeAxis = "z+", isPaste = false, onZRangeChange, onHRangeChange, viewCapZ = null, selectMode = false, onSelect, onNotice }: Props) {
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

  // Depth slider display/commit split (same idiom as App's zSliceDisplay/commitZSlice): every
  // committed depth re-renders the whole plane over IPC, so scrubbing on raw `onChange` fired a
  // full strip-tiled refetch per drag pixel. The slider tracks `dragDepth` while held and commits
  // once on release; `null` means "not dragging — show the committed depth".
  const [dragDepth, setDragDepth] = useState<number | null>(null);
  const dragDepthRef = useRef<number | null>(null);
  const shownDepth = dragDepth ?? curDepth;
  const previewDepth = useCallback((d: number) => {
    const c = Math.max(0, Math.min(depthMax, d));
    dragDepthRef.current = c;
    setDragDepth(c);
  }, [depthMax]);
  const commitDragDepth = useCallback(() => {
    const d = dragDepthRef.current;
    dragDepthRef.current = null;
    setDragDepth(null);
    if (d !== null) setDepth(d);
  }, [setDepth]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const slabRef = useRef<HTMLCanvasElement | null>(null); // offscreen slab canvas
  const orthoSlabRef = useRef<HTMLCanvasElement | null>(null); // offscreen ortho canvas (selection only)
  const clipRef = useRef<HTMLCanvasElement | null>(null);  // offscreen clipboard ghost (paste preview)
  const edgeHoverRef = useRef<string | null>(null);  // "z-max"|"z-min"|"h-lo"|"h-hi" or null
  const [loading, setLoading] = useState(false);
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

  // ── Ortho mode ───────────────────────────────────────────────────────────────
  // Only available for front/side viewports when a selection is active (selFull set).
  // Auto-enabled when a selection first appears; auto-clears on deselect.
  const [orthoMode, setOrthoMode] = useState(false);
  const orthoModeRef = useRef(false);
  orthoModeRef.current = orthoMode;
  // Kept in a ref so the auto-enable effect doesn't re-run (and re-toast) when App re-renders with
  // a fresh callback identity.
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  // draw() reads the paint handler through a ref so a new callback identity from App doesn't
  // rebuild the whole draw closure.
  const onPaintRef = useRef(onPaint);
  onPaintRef.current = onPaint;
  // Keep a ref so stable callbacks (draw, doOrthoFetch) can read the latest selFull without
  // it appearing in their dep arrays (which would cause spurious fetch cascades).
  const selFullRef = useRef(selFull);
  selFullRef.current = selFull;

  // Stable key representing selFull bounds — used as an effect dep to retrigger on selection change
  // without creating a new object reference on every render.
  const selFullKey = selFull
    ? `${selFull.xLo},${selFull.yLo},${selFull.xHi},${selFull.yHi},${selFull.zLo},${selFull.zHi}`
    : null;

  // Track whether selFull was previously present so we only auto-enable on first appearance.
  const hadSelFullRef = useRef(false);
  const hasSelFull = selFull != null && axis !== "top";

  useEffect(() => {
    if (!hasSelFull) {
      setOrthoMode(false);
      orthoSlabRef.current = null; // free memory immediately
      hadSelFullRef.current = false;
      force(n => n + 1);
    } else if (!hadSelFullRef.current) {
      hadSelFullRef.current = true;
      setOrthoMode(true);
      if (onPaint) onNoticeRef.current?.("Ortho view turned on — the front/side panes now show the selection's facade, and painting in them is off. Toggle ORTHO off in the pane header to paint again.");
    }
  }, [hasSelFull, onPaint]);

  // Reset the free-scroll window when switching axis. (Re-fitting is handled when the fetched slab's
  // dimensions actually change — see the fetch handler below — so zoom is preserved on depth/edit refetch.)
  useEffect(() => { setWinOrigin(0); }, [axis]);

  // ── fetch the current horizontal window of the slab for the current depth ──
  // Fetched in horizontal strips so wide windows render progressively and don't block the UI on a
  // single multi-megabyte IPC blob. A sequence token discards stale responses (view/edit races).
  const STRIP = 256;
  const fetchSeq = useRef(makeSeqGuard());
  const doFetch = useCallback(() => {
    if (orthoModeRef.current) return; // ortho mode handles its own fetch
    const seq = fetchSeq.current.next();
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
    let pending = 0;
    const done = () => { if (--pending === 0 && !fetchSeq.current.isStale(seq)) setLoading(false); };
    setLoading(true);
    for (let s = h0; s <= h1; s += STRIP) {
      pending++;
      const e = Math.min(h1, s + STRIP - 1);
      const args = axis === "front"
        ? { y: curDepth, x1: s, z1: 0, x2: e, z2: maxZ }
        : axis === "side"
        ? { x: curDepth, y1: s, z1: 0, y2: e, z2: maxZ }
        : { z: curDepth, x1: s, y1: 0, x2: e, y2: vMax };
      const dx = s - h0;
      invoke<PixelPatchRaw>(cmd, args)
        .then((raw) => {
          if (fetchSeq.current.isStale(seq)) { done(); return; } // superseded
          putPatchPixels(sctx, raw, dx, 0);
          force((n) => n + 1);
          done();
        })
        .catch(() => done());
    }
    if (pending === 0) setLoading(false);
  }, [axis, curDepth, fetchLo, fetchHi, vMax, maxZ]);

  // Fetch the ortho projection of the current selection via render_selection_view.
  const orthoFetchSeq = useRef(makeSeqGuard());
  const doOrthoFetch = useCallback(() => {
    const sf = selFullRef.current;
    if (!sf || axis === "top") return;
    const seq = orthoFetchSeq.current.next();
    fetchSeq.current.next(); // cancel any in-flight slab strip fetches
    setLoading(true);
    invoke<PixelPatchRaw>("render_selection_view", {
      x1: sf.xLo, y1: sf.yLo, x2: sf.xHi, y2: sf.yHi,
      zMin: sf.zLo, zMax: sf.zHi,
      view: axis === "front" ? "front" : "side",
    }).then((raw) => {
      if (orthoFetchSeq.current.isStale(seq)) { setLoading(false); return; }
      let c = orthoSlabRef.current;
      if (!c) { c = document.createElement("canvas"); orthoSlabRef.current = c; }
      if (c.width !== raw.width || c.height !== raw.height) {
        fittedRef.current = false;
        c.width = raw.width; c.height = raw.height;
      }
      putPatchPixels(c.getContext("2d")!, raw);
      setLoading(false);
      force(n => n + 1);
    }).catch(() => setLoading(false));
  }, [axis]); // selFull read via ref to avoid dep-cascade

  // View-driven refetch (axis / depth / selection range / window scroll).
  useEffect(() => { doFetch(); }, [doFetch]);

  // Ortho fetch: runs when ortho mode is on and the selection changes.
  useEffect(() => {
    if (orthoMode && selFullKey && axis !== "top") doOrthoFetch();
  }, [orthoMode, selFullKey, doOrthoFetch, axis]);

  // Edit-driven refetch — only when the edit's bounds intersect this slab's depth plane.
  const lastEpochRef = useRef(editEpoch);
  useEffect(() => {
    if (editEpoch === lastEpochRef.current) return;
    lastEpochRef.current = editEpoch;
    if (orthoModeRef.current && selFullRef.current && axis !== "top") {
      if (lastEdit) {
        const sf = selFullRef.current;
        const overlapX = lastEdit.x < sf.xHi + 1 && lastEdit.x + lastEdit.w > sf.xLo;
        const overlapY = lastEdit.y < sf.yHi + 1 && lastEdit.y + lastEdit.h > sf.yLo;
        if (!overlapX || !overlapY) return;
      }
      doOrthoFetch();
      return;
    }
    if (lastEdit) {
      const touched = axis === "front" ? (curDepth >= lastEdit.y && curDepth < lastEdit.y + lastEdit.h)
                    : axis === "side"  ? (curDepth >= lastEdit.x && curDepth < lastEdit.x + lastEdit.w)
                    : true; // top: patch has no z extent → always refetch
      if (!touched) return;
    }
    doFetch();
  }, [editEpoch, lastEdit, axis, curDepth, doFetch, doOrthoFetch]);

  // Clipboard elevation ghost for paste preview (front/side image matching this slab's axis).
  useEffect(() => {
    if (!isPaste || axis === "top") { clipRef.current = null; force((n) => n + 1); return; }
    let cancelled = false;
    invoke<PixelPatchRaw>("render_clipboard_elevation_preview", { view: axis })
      .then((raw) => {
        if (cancelled) return;
        const c = document.createElement("canvas");
        c.width = raw.width; c.height = raw.height;
        putPatchPixels(c.getContext("2d")!, raw);
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
    const centerWorld = (cssWidth(canvas) / 2 - x) / scale + winOriginRef.current;
    const desired = Math.max(0, Math.min(planeW - freeWinW, Math.round(centerWorld - freeWinW / 2)));
    if (desired !== winOriginRef.current && Math.abs(desired - winOriginRef.current) >= 16) {
      // shift view.x so the same world column stays under the cursor after the origin moves
      viewRef.current.x += (winOriginRef.current - desired) * scale;
      setWinOrigin(desired);
    }
  }, [planeW, freeWinW, selScoped]);

  // ── paint the visible canvas from the offscreen slab ──────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    // Base HiDPI transform — everything below is in CSS pixels (`cw`/`ch`), never canvas.width.
    const { w: cw, h: ch } = beginFrame(ctx, canvas);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0a0f1e";
    ctx.fillRect(0, 0, cw, ch);

    // Choose which offscreen canvas to display.
    const isOrtho = orthoModeRef.current && orthoSlabRef.current != null && axis !== "top";
    const slab = isOrtho ? orthoSlabRef.current! : slabRef.current;
    if (!slab) return;

    // In ortho mode, the image covers exactly selFull's horizontal extent; in slab mode it covers
    // the fetch window. Both crosshair and overlay coords are computed relative to the active origin.
    const sf = selFullRef.current;
    const activeWinOrigin = isOrtho && sf
      ? (axis === "front" ? sf.xLo : sf.yLo)
      : winOriginRef.current;
    // Row ↔ Z mapping differs: slab uses maxZ−row; ortho uses selFull.zHi−row.
    const activeVToRow = isOrtho && sf
      ? (v: number) => sf.zHi - v
      : vToRow;

    const { x, y, scale } = viewRef.current;
    ctx.drawImage(slab, 0, 0, slab.width, slab.height, x, y, slab.width * scale, slab.height * scale);

    // Selection-scoped: gray out the context columns flanking the selection + draw divider lines.
    // Skipped in ortho mode — the image IS the selection, no context cols to gray.
    // effSel reflects an in-progress horizontal edge drag (preview) before it's committed.
    const effSel = isOrtho ? null : (hPreviewRef.current ?? selRange);
    if (effSel) {
      const a = effSel.lo - winOriginRef.current;       // slab col of selection start
      const b = effSel.hi - winOriginRef.current + 1;   // slab col just past selection end
      const slabBottom = y + slab.height * scale;
      ctx.fillStyle = "rgba(24,15,8,0.6)";
      if (a > 0) ctx.fillRect(x, y, a * scale, slab.height * scale);                       // left context
      if (b < slab.width) ctx.fillRect(x + b * scale, y, (slab.width - b) * scale, slab.height * scale); // right context
      ctx.strokeStyle = "rgba(175,166,157,0.65)";
      ctx.lineWidth = 1;
      for (const c of [a, b]) {
        if (c <= 0 || c >= slab.width) continue;
        const lx = x + c * scale;
        ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(lx, slabBottom); ctx.stroke();
      }
    }

    // Selection / paste z-band box (front/side only — vertical axis is Z). Ported from the
    // elevation panel: blue band for a selection, green band + clipboard ghost during paste.
    // Skipped in ortho mode — the image already shows the full Z extent of the selection.
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
    // In ortho mode, coords are relative to the selection's horizontal/vertical origin.
    ctx.lineWidth = 1;
    const crossCol = crossH != null ? crossH - activeWinOrigin : null;
    if (crossCol != null && crossCol >= 0 && crossCol < slab.width) {
      const sx = x + (crossCol + 0.5) * scale;
      ctx.strokeStyle = "rgba(168,85,247,0.7)";
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, ch); ctx.stroke();
    }
    if (crossV != null) {
      const row = activeVToRow(crossV); // image row for that vertical-axis world coord
      if (row >= 0 && row < slab.height) {
        const sy = y + (row + 0.5) * scale;
        ctx.strokeStyle = "rgba(56,189,248,0.7)";
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(cw, sy); ctx.stroke();
      }
    }

    // Cutaway cap: dim everything above the cap plane + draw the plane itself. Front/side only —
    // the top viewport's vertical axis is Y, not Z, so a Z cap has no line to draw there.
    if (viewCapZ != null && axis !== "top") {
      const capRow = activeVToRow(viewCapZ);          // row holding the cap block itself
      const capY = y + (capRow + 1) * scale;          // screen y of the plane just above it
      if (capY > 0) {
        ctx.fillStyle = "rgba(10,8,20,0.45)";
        ctx.fillRect(0, 0, cw, Math.min(capY, ch));   // hidden-by-cutaway region
        ctx.save();
        ctx.strokeStyle = "rgba(167,139,250,0.9)";
        ctx.setLineDash([5, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, capY + 0.5); ctx.lineTo(cw, capY + 0.5); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = "rgba(221,214,254,0.9)";
        ctx.font = "9px monospace";
        ctx.fillText(`cap z${viewCapZ}`, 4, Math.max(9, capY - 3));
      }
    }

    // Live rect/ellipse drag ghost and marquee are slab-mode only (painting disabled in ortho).
    if (!isOrtho) {
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

      // Resize grips on the z-band edges and the selection dividers. Drawn *always* (dim), lit up
      // with a hint caption on hover — previously they only existed inside a 5px hover hit-zone, so
      // there was nothing on screen to suggest these edges could be dragged at all.
      const eh = edgeHoverRef.current;
      if (slab) {
        const dots = (gx: number, gy: number, vertical: boolean, on: boolean) => {
          ctx.fillStyle = on ? "rgba(226,222,217,0.95)" : "rgba(175,166,157,0.42)";
          for (let i = -1; i <= 1; i++) {
            ctx.beginPath();
            ctx.arc(vertical ? gx : gx + i * 8, vertical ? gy + i * 8 : gy, on ? 3 : 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        };
        const hint = (text: string, hx: number, hy: number, baseline: CanvasTextBaseline) => {
          ctx.fillStyle = "rgba(175,166,157,0.7)";
          ctx.font = "9px monospace";
          ctx.textBaseline = baseline;
          ctx.fillText(text, hx, hy);
          ctx.textBaseline = "middle";
        };
        // Z-band top/bottom edges.
        if (onZRangeChange && selZ && axis !== "top") {
          for (const which of ["z-max", "z-min"] as const) {
            const ez = which === "z-max" ? selZ.max : selZ.min;
            const ey = which === "z-max" ? y + (maxZ - ez) * scale : y + (maxZ - ez + 1) * scale;
            if (ey < -8 || ey > ch + 8) continue;
            const on = eh === which;
            dots(cw / 2, ey, false, on);
            if (on) hint("drag to resize Z", cw / 2 + 16, ey, "middle");
          }
        }
        // Selection left/right dividers.
        if (onHRangeChange && selRange && axis !== "top") {
          for (const which of ["h-lo", "h-hi"] as const) {
            const hw = which === "h-lo" ? selRange.lo : selRange.hi + 1;
            const ex = x + (hw - winOriginRef.current) * scale;
            if (ex < -8 || ex > cw + 8) continue;
            const on = eh === which;
            dots(ex, ch / 2, true, on);
            if (on) hint(`drag to resize ${axis === "side" ? "Y" : "X"}`, ex + 6, ch / 2 + 12, "top");
          }
        }
      }
    }

    // Slab-mode gesture caption. Painting straight into an elevation slab, and marquee-selecting a
    // plane, are both completely invisible affordances — the pane looks like a read-only preview.
    if (!isOrtho && (onPaintRef.current || selectMode)) {
      const label = onPaintRef.current
        ? "drag to paint · alt / middle-drag to pan"
        : "drag to select · alt / middle-drag to pan";
      ctx.font = "9px monospace";
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      const tw = ctx.measureText(label).width;
      ctx.fillRect(4, ch - 17, tw + 8, 14);
      ctx.fillStyle = "rgba(175,166,157,0.8)";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 8, ch - 10);
    }

    // Ortho mode hint. Ortho auto-enables the moment a selection appears, and it silently turns
    // painting off — a 9px 60%-alpha caption was not enough of a reason for "why can't I paint?".
    // Drawn as an amber pill in the corner, matching the ORTHO toggle it points at.
    if (isOrtho) {
      const label = "ORTHO view — painting off · toggle ORTHO off to paint";
      ctx.font = "10px monospace";
      const tw = ctx.measureText(label).width;
      const px = 6, py = ch - 20, pw = tw + 12, phh = 16;
      ctx.fillStyle = "rgba(245,158,11,0.16)";
      ctx.fillRect(px, py, pw, phh);
      ctx.strokeStyle = "rgba(245,158,11,0.5)";
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, phh - 1);
      ctx.fillStyle = "#fcd34d";
      ctx.textBaseline = "middle";
      ctx.fillText(label, px + 6, py + phh / 2 + 0.5);
    }
  }, [crossH, crossV, axis, maxZ, selRange, selZ, extrudeCount, extrudeAxis, isPaste, viewCapZ, selectMode, onZRangeChange, onHRangeChange]);

  // Fit the whole slab into the canvas (contain) and center it.
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    const slab = (orthoModeRef.current && orthoSlabRef.current) ? orthoSlabRef.current : slabRef.current;
    if (!canvas || !slab) return;
    const cw = cssWidth(canvas), ch = cssHeight(canvas);
    const s = Math.max(0.25, Math.min(32, Math.min(cw / slab.width, ch / slab.height)));
    viewRef.current = {
      scale: s,
      x: (cw - slab.width * s) / 2,
      y: (ch - slab.height * s) / 2,
    };
    draw();
  }, [draw]);

  // Auto-fit once the first slab + sized canvas are ready; redraw every render after.
  useEffect(() => {
    const activeSlab = (orthoModeRef.current && orthoSlabRef.current) ? orthoSlabRef.current : slabRef.current;
    if (!fittedRef.current && canvasRef.current && activeSlab && canvasRef.current.width > 1) {
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
      resizeCanvasToContainer(canvas);
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
    // In ortho mode only panning is allowed — painting, edge-resize, and marquee are disabled.
    if (orthoMode) {
      const v = viewRef.current;
      dragRef.current = { sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }

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
    // Edge drags and marquee only active in slab mode.
    if (!orthoMode) {
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
    }

    // Hover cursor feedback + grip cue state for the resize edges when idle (z = ns, x/y = ew).
    if (e.buttons === 0 && canvasRef.current) {
      if (orthoMode) {
        canvasRef.current.style.cursor = "grab";
      } else {
        const zEdge = hitZEdge(localY(e.clientY));
        const hEdge = !zEdge ? hitHEdge(localX(e.clientX)) : null;
        const c = zEdge ? "ns-resize" : hEdge ? "ew-resize" : (onPaint || selectMode ? "crosshair" : "grab");
        canvasRef.current.style.cursor = c;
        const newHover: string | null = zEdge ? `z-${zEdge}` : hEdge ? `h-${hEdge}` : null;
        if (newHover !== edgeHoverRef.current) {
          edgeHoverRef.current = newHover;
          draw();
        }
      }
    }

    if (!orthoMode && marqueeRef.current) {
      const cell = screenToCell(e.clientX, e.clientY);
      if (cell) { marqueeRef.current.end = { x: cell.col, y: cell.row }; draw(); }
      return;
    }
    const d = dragRef.current;
    if (d) {
      viewRef.current.x = d.vx + (e.clientX - d.sx);
      viewRef.current.y = d.vy + (e.clientY - d.sy);
      draw();
    } else if (!orthoMode && shapeRef.current) {
      const cell = screenToCell(e.clientX, e.clientY);
      if (cell) { shapeRef.current.end = { x: cell.col, y: cell.row }; draw(); }
    } else if (!orthoMode && strokeRef.current) {
      addFootprint(e.clientX, e.clientY);
    }
  };
  const onPointerUp = () => {
    if (!orthoMode) {
      if (zDragRef.current) { zDragRef.current = null; return; }
      if (hDragRef.current) {
        const p = hPreviewRef.current;
        hDragRef.current = null; hPreviewRef.current = null;
        if (p && onHRangeChange) onHRangeChange(p.lo, p.hi);
        draw();
        return;
      }
    }
    if (dragRef.current) { dragRef.current = null; if (!orthoMode) maybeMoveWindow(); return; }
    if (!orthoMode) {
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
    }
  };
  // Escape cancels an in-progress drag (z-band edge, H divider, marquee select, paint shape/stroke)
  // — mirrors MapCanvas's polygon/drag Escape handling. Gated on !typing so Escape in a text field
  // elsewhere in the app isn't swallowed here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isTypingTarget(e.target)) return;
      if (zDragRef.current || hDragRef.current || marqueeRef.current || shapeRef.current || strokeRef.current) {
        e.stopPropagation();
        zDragRef.current = null;
        hDragRef.current = null; hPreviewRef.current = null;
        marqueeRef.current = null;
        shapeRef.current = null;
        strokeRef.current = null;
        draw();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [draw]);

  // Native (non-passive) wheel listener so preventDefault suppresses the webview's page-scroll /
  // pinch-zoom (React's synthetic onWheel is passive, so its preventDefault is a no-op).
  // NB: do NOT refetch on zoom — the slab is cached offscreen and just redrawn at the new scale.
  // The fetch window only moves on pan-end (heavy IPC).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      viewRef.current = zoomAtPoint(viewRef.current, mx, my, e.deltaY, { min: 0.25, max: 32, factor: 1.15 });
      draw();
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [draw]);

  const label = axis === "front" ? `Front  (Y=${shownDepth})` : axis === "side" ? `Side  (X=${shownDepth})` : `Top  (Z=${shownDepth})`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0a0f1e", color: "#dad6d2", userSelect: "none", WebkitUserSelect: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", fontSize: 11, borderBottom: "1px solid #312c28" }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <input
          type="range" min={0} max={depthMax} value={shownDepth}
          onChange={(e) => previewDepth(parseInt(e.target.value, 10))}
          onPointerUp={commitDragDepth}
          onKeyUp={commitDragDepth}
          onBlur={commitDragDepth}
          style={{ flex: 1 }}
          title={orthoMode ? "Depth slider moves the crosshair in ortho mode" : undefined}
        />
        <input
          type="number" min={0} max={depthMax} value={shownDepth}
          onChange={(e) => previewDepth(parseInt(e.target.value, 10) || 0)}
          onBlur={commitDragDepth}
          onKeyDown={(e) => { if (e.key === "Enter") commitDragDepth(); }}
          style={{ ...recessedWell, width: 56, background: "#312c28", color: "#dad6d2", borderRadius: 4 }}
        />
        {selFull && axis !== "top" && (
          <button
            onClick={() => setOrthoMode(m => !m)}
            title={orthoMode ? "Ortho view is ON — showing the selection's facade. Toggle off for the slab view, where you can paint." : "Slab view — click to turn ortho view on (shows the selection's facade; painting is off)"}
            style={orthoMode
              ? chromeButtonAccent("99,102,241", "#818cf8", {
                  color: "#a5b4fc", padding: "1px 7px",
                  fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", flexShrink: 0,
                })
              : chromeButton({
                  color: "#83786c", padding: "1px 7px",
                  fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", flexShrink: 0,
                })}
          >
            ORTHO
          </button>
        )}
        <button
          onClick={fit}
          title="Fit slab to view"
          style={chromeButton({ color: "#dad6d2", padding: "1px 6px" })}
        >⊡</button>
      </div>
      {loading && (
        <div style={{ height: 2, background: "#f59e0b", flexShrink: 0 }} />
      )}
      <canvas
        ref={canvasRef}
        style={{ flex: 1, width: "100%", cursor: orthoMode ? "grab" : (onPaint || selectMode ? "crosshair" : "grab"), touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { if (edgeHoverRef.current !== null) { edgeHoverRef.current = null; draw(); } }}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
