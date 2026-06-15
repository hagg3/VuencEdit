import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { invoke } from "@tauri-apps/api/core";

export type Tool = "pan" | "select" | "paste";

/** World pixels per tile side. Each tile is fetched independently via IPC. */
const TILE = 512;

/** Number of extra tile rows/cols to prefetch beyond the visible viewport edge. */
const TILE_BUFFER = 1;

/** Maximum simultaneous in-flight tile fetches. Prevents IPC channel saturation. */
const MAX_CONCURRENT = 4;

export interface PixelPatch {
  x: number; y: number;
  width: number; height: number;
  pixels: Uint8Array;
}

interface PixelPatchRaw { x: number; y: number; width: number; height: number; pixels: string; }

export interface MapCanvasRef {
  /** Write top-down pixel patch directly into the affected tiles/canvas (top-down mode edit). */
  applyPatch: (patch: PixelPatch) => void;
  /** Invalidate tiles overlapping (x1,y1)-(x2,y2) and re-fetch them (z-slice mode edit). */
  refetchRegion: (x1: number, y1: number, x2: number, y2: number) => void;
  /** Zoom-to-fit: scale + center the view so the entire world fits in the viewport. */
  resetView: () => void;
}

interface WorldPoint { x: number; y: number }

type DragOp =
  | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number }
  | { kind: "select"; start: WorldPoint; end: WorldPoint }
  | null;

export interface SelectionBounds {
  x1: number; y1: number; x2: number; y2: number;
}

interface WorldData {
  name: string;
  width_chunks: number;
  height_chunks: number;
}

interface Props {
  world: WorldData;
  worldEpoch: number;
  tool: Tool;
  viewMode: "topdown" | "zslice";
  zSliceZ: number;
  committedSelection: SelectionBounds | null;
  onSelectionChange: (bounds: SelectionBounds | null) => void;
  pastePreview: { width: number; height: number } | null;
  onPasteAt: (pos: { x: number; y: number }) => void;
  /** "tiled": fetch map in 512px tiles (low RAM). "full": single canvas load (instant pan/zoom). */
  renderMode: "tiled" | "full";
}

function decodePixels(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

type TileJob = { key: string; x1: number; y1: number; x2: number; y2: number };

const MapCanvas = forwardRef<MapCanvasRef, Props>(function MapCanvas(
  { world, worldEpoch, tool, viewMode, zSliceZ,
    committedSelection, onSelectionChange, pastePreview, onPasteAt,
    renderMode }: Props,
  ref,
) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const viewRef    = useRef({ x: 0, y: 0, scale: 2 });

  // Tile state (used in "tiled" mode)
  const tileCacheRef  = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const pendingRef    = useRef<Set<string>>(new Set());
  // Incremented whenever mode/z/world/renderMode changes — lets in-flight fetches detect staleness
  const tileEpochRef  = useRef(0);

  // Concurrency-capped fetch queue (tiled mode)
  const activeRef  = useRef(0);
  const queueRef   = useRef<TileJob[]>([]);
  const drainRef   = useRef<() => void>(() => {});

  // Full-canvas state (used in "full" mode)
  const renderModeRef     = useRef(renderMode);
  const fullCanvasRef     = useRef<HTMLCanvasElement | null>(null);
  // null = not loading; 0–1 = loading in progress (drives progress bar)
  const fullProgressRef   = useRef<number | null>(null);

  const dragRef = useRef<DragOp>(null);

  // Stable refs for values read inside callbacks (avoids re-registering handlers)
  const toolRef         = useRef<Tool>(tool);
  const viewModeRef     = useRef(viewMode);
  const zSliceZRef      = useRef(zSliceZ);
  const committedSelRef = useRef<SelectionBounds | null>(committedSelection);
  const pastePreviewRef = useRef(pastePreview);
  const pasteHoverRef   = useRef<WorldPoint | null>(null);
  const cursorPosRef    = useRef<WorldPoint | null>(null);
  const onSelChangeRef  = useRef(onSelectionChange);
  const onPasteAtRef    = useRef(onPasteAt);

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { onSelChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  useEffect(() => { onPasteAtRef.current   = onPasteAt; }, [onPasteAt]);

  const mapW = world.width_chunks * 16;
  const mapH = world.height_chunks * 16;
  // Refs so draw/ensureTiles (stable callbacks with [] deps) can read current dimensions
  const mapWRef = useRef(mapW);
  const mapHRef = useRef(mapH);
  useEffect(() => { mapWRef.current = mapW; mapHRef.current = mapH; }, [mapW, mapH]);

  const screenToWorld = useCallback((sx: number, sy: number): WorldPoint => {
    const { x, y, scale } = viewRef.current;
    return {
      x: Math.max(0, Math.min(mapW - 1, Math.floor((sx - x) / scale))),
      y: Math.max(0, Math.min(mapH - 1, Math.floor((sy - y) / scale))),
    };
  }, [mapW, mapH]);

  // ── draw ──────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const { x: vx, y: vy, scale } = viewRef.current;

    ctx.fillStyle = "#14141e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(vx, vy);
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = false;

    if (renderModeRef.current === "full") {
      const fc = fullCanvasRef.current;
      if (fc) ctx.drawImage(fc, 0, 0);
    } else {
      for (const [key, tile] of tileCacheRef.current) {
        const comma = key.indexOf(",");
        const tx = parseInt(key.slice(0, comma));
        const ty = parseInt(key.slice(comma + 1));
        ctx.drawImage(tile, tx * TILE, ty * TILE);
      }
    }

    ctx.restore();

    // Progress bar while full-map is loading (screen coords, outside world transform)
    const loadProgress = fullProgressRef.current;
    if (renderModeRef.current === "full" && loadProgress !== null) {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      ctx.font = "13px monospace";
      ctx.fillStyle = "#94a3b8";
      ctx.textAlign = "center";
      ctx.fillText("Loading full map…", cx, cy - 12);
      ctx.textAlign = "left";
      const barW = Math.min(300, canvas.width * 0.5);
      const barH = 6;
      const barX = cx - barW / 2;
      const barY = cy + 2;
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.roundRect(barX, barY, barW, barH, 3);
      ctx.fill();
      if (loadProgress > 0) {
        ctx.fillStyle = "#d97706";
        ctx.beginPath();
        ctx.roundRect(barX, barY, barW * loadProgress, barH, 3);
        ctx.fill();
      }
    }

    // Selection overlay
    const drag = dragRef.current;
    let wx1 = 0, wy1 = 0, wx2 = 0, wy2 = 0, hasSel = false;
    if (drag?.kind === "select") {
      wx1 = Math.min(drag.start.x, drag.end.x); wy1 = Math.min(drag.start.y, drag.end.y);
      wx2 = Math.max(drag.start.x, drag.end.x); wy2 = Math.max(drag.start.y, drag.end.y);
      hasSel = true;
    } else if (committedSelRef.current) {
      ({ x1: wx1, y1: wy1, x2: wx2, y2: wy2 } = committedSelRef.current);
      hasSel = true;
    }
    if (hasSel) {
      const rx = Math.round(wx1 * scale + vx);
      const ry = Math.round(wy1 * scale + vy);
      const rw = Math.round((wx2 - wx1 + 1) * scale);
      const rh = Math.round((wy2 - wy1 + 1) * scale);
      ctx.fillStyle   = "rgba(59, 130, 246, 0.18)";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth   = 2;
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
      ctx.strokeStyle = "rgba(59, 130, 246, 1)";
      ctx.lineWidth   = 1;
      ctx.strokeRect(rx + 2.5, ry + 2.5, rw - 5, rh - 5);
    }

    // Paste ghost box
    if (toolRef.current === "paste" && pastePreviewRef.current && pasteHoverRef.current) {
      const hw = pasteHoverRef.current;
      const { width: pw, height: ph } = pastePreviewRef.current;
      const gx = Math.round(hw.x * scale + vx);
      const gy = Math.round(hw.y * scale + vy);
      const gw = Math.round(pw * scale);
      const gh = Math.round(ph * scale);
      ctx.fillStyle   = "rgba(34, 197, 94, 0.15)";
      ctx.fillRect(gx, gy, gw, gh);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth   = 2;
      ctx.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);
      ctx.strokeStyle = "rgba(34, 197, 94, 1)";
      ctx.lineWidth   = 1;
      ctx.strokeRect(gx + 2.5, gy + 2.5, gw - 5, gh - 5);
    }

    // Cursor coords + zoom level — bottom-right, screen coords
    {
      const pos = cursorPosRef.current;
      const zoomPct = Math.round(scale * 100);
      const label = pos
        ? `X ${pos.x}  Y ${pos.y}  ·  ${zoomPct}%`
        : `${zoomPct}%`;
      ctx.font = "12px monospace";
      ctx.fillStyle = "rgba(100,116,139,0.85)";
      ctx.textAlign = "right";
      ctx.fillText(label, canvas.width - 12, canvas.height - 12);
      ctx.textAlign = "left";
    }
  }, []);

  // ── loadTile ──────────────────────────────────────────────────────────────

  const loadTile = useCallback(async (
    key: string, x1: number, y1: number, x2: number, y2: number,
  ) => {
    const myEpoch = tileEpochRef.current;
    pendingRef.current.add(key);
    try {
      let raw: PixelPatchRaw;
      if (viewModeRef.current === "zslice") {
        raw = await invoke<PixelPatchRaw>("render_zslice_patch", {
          z: zSliceZRef.current, x1, y1, x2, y2,
        });
      } else {
        raw = await invoke<PixelPatchRaw>("fetch_tile", { x1, y1, x2, y2 });
      }
      if (tileEpochRef.current !== myEpoch) return;
      const pixels = decodePixels(raw.pixels);
      const tc  = document.createElement("canvas");
      tc.width  = raw.width;
      tc.height = raw.height;
      const tctx = tc.getContext("2d")!;
      const img   = tctx.createImageData(raw.width, raw.height);
      img.data.set(pixels);
      tctx.putImageData(img, 0, 0);
      tileCacheRef.current.set(key, tc);
      draw();
    } catch {
      // world not loaded or tile out of range — leave absent from cache
    } finally {
      pendingRef.current.delete(key);
      activeRef.current--;
      drainRef.current();
    }
  }, [draw]);

  // ── drain ─────────────────────────────────────────────────────────────────

  const drain = useCallback(() => {
    const q = queueRef.current;
    while (activeRef.current < MAX_CONCURRENT && q.length > 0) {
      const job = q.shift()!;
      if (tileCacheRef.current.has(job.key) || pendingRef.current.has(job.key)) continue;
      activeRef.current++;
      loadTile(job.key, job.x1, job.y1, job.x2, job.y2);
    }
  }, [loadTile]);

  useEffect(() => { drainRef.current = drain; }, [drain]);

  // ── loadFullCanvas ────────────────────────────────────────────────────────
  // Fetches the entire world as a single canvas, loading in horizontal strips
  // so each IPC response is small (no main-thread freeze) and the map fills
  // in progressively. Only used in "full" render mode.

  const loadFullCanvas = useCallback(async () => {
    const myEpoch = tileEpochRef.current;
    const mW = mapWRef.current;
    const mH = mapHRef.current;

    fullProgressRef.current = 0; // show bar immediately (synchronous before first await)
    const fc = document.createElement("canvas");
    fc.width  = mW;
    fc.height = mH;
    const fctx = fc.getContext("2d")!;
    fullCanvasRef.current = fc;
    draw(); // dark canvas + bar at 0%

    const STRIP_H = 128;
    try {
      for (let y = 0; y < mH; y += STRIP_H) {
        if (tileEpochRef.current !== myEpoch) return;
        const y2 = Math.min(mH - 1, y + STRIP_H - 1);
        let raw: PixelPatchRaw;
        if (viewModeRef.current === "zslice") {
          raw = await invoke<PixelPatchRaw>("render_zslice_patch", {
            z: zSliceZRef.current, x1: 0, y1: y, x2: mW - 1, y2,
          });
        } else {
          raw = await invoke<PixelPatchRaw>("fetch_tile", { x1: 0, y1: y, x2: mW - 1, y2 });
        }
        if (tileEpochRef.current !== myEpoch) return;
        const pixels = decodePixels(raw.pixels);
        const img = fctx.createImageData(raw.width, raw.height);
        img.data.set(pixels);
        fctx.putImageData(img, 0, y);
        fullProgressRef.current = Math.min(1, (y + STRIP_H) / mH);
        draw();
      }
    } catch {
      // world not loaded
    } finally {
      fullProgressRef.current = null; // hide bar when done or cancelled
      draw();
    }
  }, [draw]);

  // ── ensureTiles ───────────────────────────────────────────────────────────
  // In "tiled" mode: computes needed tiles, evicts stale ones, queues missing fetches.
  // In "full" mode: triggers a full-canvas load if not already cached, then redraws.

  const ensureTiles = useCallback(() => {
    if (renderModeRef.current === "full") {
      if (!fullCanvasRef.current) loadFullCanvas();
      draw();
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x: vx, y: vy, scale } = viewRef.current;
    const mW = mapWRef.current;
    const mH = mapHRef.current;

    const tx0 = Math.max(0, Math.floor(Math.max(0, -vx) / scale / TILE) - TILE_BUFFER);
    const ty0 = Math.max(0, Math.floor(Math.max(0, -vy) / scale / TILE) - TILE_BUFFER);
    const tx1 = Math.min(
      Math.ceil(mW / TILE),
      Math.ceil((canvas.width - vx) / scale / TILE) + TILE_BUFFER,
    );
    const ty1 = Math.min(
      Math.ceil(mH / TILE),
      Math.ceil((canvas.height - vy) / scale / TILE) + TILE_BUFFER,
    );

    const needed = new Set<string>();
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        needed.add(`${tx},${ty}`);
      }
    }

    for (const key of tileCacheRef.current.keys()) {
      if (!needed.has(key)) tileCacheRef.current.delete(key);
    }

    draw();

    const jobs: TileJob[] = [];
    for (const key of needed) {
      if (tileCacheRef.current.has(key) || pendingRef.current.has(key)) continue;
      const comma = key.indexOf(",");
      const tx = parseInt(key.slice(0, comma));
      const ty = parseInt(key.slice(comma + 1));
      jobs.push({
        key,
        x1: tx * TILE,
        y1: ty * TILE,
        x2: Math.min(mW - 1, (tx + 1) * TILE - 1),
        y2: Math.min(mH - 1, (ty + 1) * TILE - 1),
      });
    }
    const cxW = (canvas.width  / 2 - vx) / scale;
    const cyW = (canvas.height / 2 - vy) / scale;
    jobs.sort((a, b) => {
      const da = (a.x1 + TILE / 2 - cxW) ** 2 + (a.y1 + TILE / 2 - cyW) ** 2;
      const db = (b.x1 + TILE / 2 - cxW) ** 2 + (b.y1 + TILE / 2 - cyW) ** 2;
      return da - db;
    });
    queueRef.current = jobs;
    drain();
  }, [draw, drain, loadFullCanvas]);

  // ── Exposed API ───────────────────────────────────────────────────────────

  useImperativeHandle(ref, () => ({
    applyPatch(patch: PixelPatch) {
      if (renderModeRef.current === "full") {
        const fc = fullCanvasRef.current;
        if (!fc) return;
        const fctx = fc.getContext("2d")!;
        const img = fctx.createImageData(patch.width, patch.height);
        img.data.set(patch.pixels);
        fctx.putImageData(img, patch.x, patch.y);
        draw();
        return;
      }
      for (const [key, tc] of tileCacheRef.current) {
        const comma = key.indexOf(",");
        const txPx  = parseInt(key.slice(0, comma)) * TILE;
        const tyPx  = parseInt(key.slice(comma + 1)) * TILE;
        const ix0 = Math.max(patch.x, txPx);
        const iy0 = Math.max(patch.y, tyPx);
        const ix1 = Math.min(patch.x + patch.width,  txPx + tc.width);
        const iy1 = Math.min(patch.y + patch.height, tyPx + tc.height);
        if (ix0 >= ix1 || iy0 >= iy1) continue;
        const iw  = ix1 - ix0;
        const ih  = iy1 - iy0;
        const ctx = tc.getContext("2d")!;
        const sub = ctx.createImageData(iw, ih);
        for (let row = 0; row < ih; row++) {
          const si = ((iy0 - patch.y + row) * patch.width + (ix0 - patch.x)) * 4;
          sub.data.set(patch.pixels.subarray(si, si + iw * 4), row * iw * 4);
        }
        ctx.putImageData(sub, ix0 - txPx, iy0 - tyPx);
      }
      draw();
    },
    refetchRegion(x1: number, y1: number, x2: number, y2: number) {
      if (renderModeRef.current === "full") {
        fullCanvasRef.current = null;
        loadFullCanvas();
        return;
      }
      for (const [key] of tileCacheRef.current) {
        const comma = key.indexOf(",");
        const txPx  = parseInt(key.slice(0, comma)) * TILE;
        const tyPx  = parseInt(key.slice(comma + 1)) * TILE;
        if (txPx < x2 && txPx + TILE > x1 && tyPx < y2 && tyPx + TILE > y1) {
          tileCacheRef.current.delete(key);
        }
      }
      ensureTiles();
    },
    resetView() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const mW = mapWRef.current;
      const mH = mapHRef.current;
      const scale = Math.min(canvas.width / mW, canvas.height / mH) * 0.9;
      viewRef.current = {
        scale,
        x: (canvas.width  - mW * scale) / 2,
        y: (canvas.height - mH * scale) / 2,
      };
      ensureTiles();
    },
  }), [draw, ensureTiles, loadFullCanvas]);

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    committedSelRef.current = committedSelection;
    draw();
  });
  useEffect(() => {
    pastePreviewRef.current = pastePreview;
    if (!pastePreview) pasteHoverRef.current = null;
    draw();
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    viewRef.current = {
      x: (canvas.width  - mapW * 2) / 2,
      y: (canvas.height - mapH * 2) / 2,
      scale: 2,
    };
    dragRef.current = null;
    onSelChangeRef.current(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldEpoch]);

  // Invalidate everything when view mode, z-level, or world changes
  useEffect(() => {
    viewModeRef.current = viewMode;
    zSliceZRef.current  = zSliceZ;
    tileEpochRef.current++;
    tileCacheRef.current.clear();
    pendingRef.current.clear();
    queueRef.current = [];
    fullCanvasRef.current = null;
    ensureTiles();
  }, [viewMode, zSliceZ, worldEpoch, ensureTiles]);

  // Invalidate everything when render mode changes
  useEffect(() => {
    renderModeRef.current = renderMode;
    tileEpochRef.current++;
    tileCacheRef.current.clear();
    pendingRef.current.clear();
    queueRef.current = [];
    fullCanvasRef.current = null;
    ensureTiles();
  }, [renderMode, ensureTiles]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      ensureTiles();
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [ensureTiles]);

  // ── Pointer / wheel handlers ──────────────────────────────────────────────

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    if (e.button === 1) {
      e.preventDefault();
      if (dragRef.current === null) {
        dragRef.current = {
          kind: "pan",
          startX: e.clientX, startY: e.clientY,
          viewX: viewRef.current.x, viewY: viewRef.current.y,
        };
      }
      return;
    }
    if (toolRef.current === "select") {
      const wp = screenToWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "select", start: wp, end: wp };
      draw();
    } else if (toolRef.current === "paste") {
      // paste fires on pointer-up
    } else {
      dragRef.current = {
        kind: "pan",
        startX: e.clientX, startY: e.clientY,
        viewX: viewRef.current.x, viewY: viewRef.current.y,
      };
    }
  }, [draw, screenToWorld]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const wp = screenToWorld(e.clientX, e.clientY);
    cursorPosRef.current = wp;
    const drag = dragRef.current;
    if (drag?.kind === "pan") {
      viewRef.current.x = drag.viewX + e.clientX - drag.startX;
      viewRef.current.y = drag.viewY + e.clientY - drag.startY;
      ensureTiles(); // includes draw()
    } else {
      if (drag?.kind === "select") drag.end = wp;
      else if (toolRef.current === "paste") pasteHoverRef.current = wp;
      draw();
    }
  }, [draw, ensureTiles, screenToWorld]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag?.kind === "pan") {
      dragRef.current = null;
      return;
    }
    if (drag?.kind === "select") {
      const end = screenToWorld(e.clientX, e.clientY);
      dragRef.current = null;
      onSelChangeRef.current({
        x1: Math.min(drag.start.x, end.x),
        y1: Math.min(drag.start.y, end.y),
        x2: Math.max(drag.start.x, end.x),
        y2: Math.max(drag.start.y, end.y),
      });
      draw();
      return;
    }
    if (toolRef.current === "paste") {
      onPasteAtRef.current(screenToWorld(e.clientX, e.clientY));
    }
  }, [draw, screenToWorld]);

  const onPointerLeave = useCallback(() => {
    cursorPosRef.current = null;
    draw();
  }, [draw]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const { x, y, scale } = viewRef.current;
    const factor   = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(32, Math.max(0.25, scale * factor));
    viewRef.current = {
      scale: newScale,
      x: e.clientX - (e.clientX - x) * (newScale / scale),
      y: e.clientY - (e.clientY - y) * (newScale / scale),
    };
    ensureTiles(); // in full mode: just draw(); in tiled mode: loads new tiles
  }, [ensureTiles]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block", cursor: tool === "pan" ? "grab" : "crosshair" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onWheel={onWheel}
    />
  );
});

export default MapCanvas;
