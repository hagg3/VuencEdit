import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { invoke } from "@tauri-apps/api/core";
import { brushFootprint, bresenhamLine, rectPixels, ellipsePixels, type WP, type BrushShape, type FillMode } from "./drawTools";

export type Tool = "pan" | "select" | "wand" | "paste" | "pen" | "brush" | "rect" | "ellipse" | "smooth" | "noise" | "flatten" | "erode" | "fill" | "eyedropper";

export interface DrawConfig {
  brushSize: number;
  brushShape: BrushShape;
  fillMode: FillMode;
}

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
  | { kind: "resizeEdge"; edge: "x1" | "x2" | "y1" | "y2"; live: SelectionBounds }
  | { kind: "draw-stroke"; pts: Set<string>; lastWX: number; lastWY: number }
  | { kind: "draw-shape"; tool: "rect" | "ellipse"; start: WP; end: WP }
  | { kind: "cam3d-drag" }
  | null;

const EDGE_HIT_PX = 6;

function hitTestEdge(
  sx: number, sy: number,
  sel: SelectionBounds,
  view: { x: number; y: number; scale: number },
): "x1" | "x2" | "y1" | "y2" | null {
  const { x: vx, y: vy, scale } = view;
  const rx = Math.round(sel.x1 * scale + vx);
  const ry = Math.round(sel.y1 * scale + vy);
  const rw = Math.round((sel.x2 - sel.x1 + 1) * scale);
  const rh = Math.round((sel.y2 - sel.y1 + 1) * scale);
  const H  = EDGE_HIT_PX;
  const nearL = Math.abs(sx - rx)        <= H;
  const nearR = Math.abs(sx - (rx + rw)) <= H;
  const nearT = Math.abs(sy - ry)        <= H;
  const nearB = Math.abs(sy - (ry + rh)) <= H;
  const inX   = sx >= rx - H && sx <= rx + rw + H;
  const inY   = sy >= ry - H && sy <= ry + rh + H;
  if (nearL && inY) return "x1";
  if (nearR && inY) return "x2";
  if (nearT && inX) return "y1";
  if (nearB && inX) return "y2";
  return null;
}

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
  clipboardPreviewPixels: { width: number; height: number; pixels: Uint8Array } | null;
  onPasteAt: (pos: { x: number; y: number }) => void;
  /** "tiled": fetch map in 512px tiles (low RAM). "full": single canvas (instant pan/zoom). "axo": axonometric 3D view. */
  renderMode: "tiled" | "full" | "axo";
  /** Axonometric skew (depth) factor — only used when renderMode="axo". */
  axoSkew?: number;
  /** When set, the paste ghost box is fixed here (amber) instead of following the cursor (green). */
  lockedPastePos?: { x: number; y: number } | null;
  /** Draw tool configuration — only read when tool is pen/brush/rect/ellipse. */
  drawConfig?: DrawConfig;
  /** Called when a draw stroke or shape is committed with the list of world positions and the z override (null = surface). */
  onDrawStroke?: (pts: [number, number][], zOverride: number | null) => void;
  /** Current z-slice level — used as z override when drawing in z-slice mode. */
  drawZOverride?: number | null;
  /** When set, draws ghost copies of the selection on X or Y axis before the user commits. */
  extrudePreview?: { axis: string; count: number } | null;
  /** Last paste step vector — used to draw a look-ahead trail of repeat-paste positions. */
  lastPasteDelta?: { dx: number; dy: number } | null;
  /** Called on every pointer-move with current world coords — used for follow-surface z-slice. */
  onCursorMove?: (wx: number, wy: number) => void;
  /** Called when the wand tool clicks a world coordinate. */
  onMagicWand?: (wx: number, wy: number) => void;
  /** Spawn/home position in editor pixel coords — drawn as a marker on the map. */
  spawnPos?: { px: number; py: number } | null;
  /** Creature list from get_creatures() — drawn as coloured dots when non-empty. */
  creatures?: { type_id: number; color: number; x: number; y: number }[];
  /** Elevation offset applied to paste (shown as label above ghost rect). */
  pasteElevationOffset?: number;
  /** Called when eyedropper tool clicks a world coordinate. */
  onEyedropper?: (wx: number, wy: number) => void;
  /** Slice-viewport cut lines: vertical at world X, horizontal at world Y (the slab depths). */
  sliceLines?: { x: number | null; y: number | null } | null;
  /** 3D fly-camera world XY position — drawn as a teal dot on the map. */
  cameraPos3d?: { x: number; y: number } | null;
  /** Called when the user clicks or drags the 3D camera icon to move it. */
  onSetCamera3d?: (wx: number, wy: number) => void;
  /** When true, fetches and draws the Eden.eden template terrain at 35% opacity behind user chunks. */
  showTemplateOverlay?: boolean;
  /** Right-click context menu callback — receives world coords + screen coords. */
  onMapContextMenu?: (wx: number, wy: number, screenX: number, screenY: number) => void;
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
    committedSelection, onSelectionChange, pastePreview, clipboardPreviewPixels, onPasteAt,
    renderMode, axoSkew = 0.2, lockedPastePos = null,
    drawConfig, onDrawStroke, drawZOverride = null,
    extrudePreview = null, lastPasteDelta = null, onCursorMove, onMagicWand,
    spawnPos = null, creatures = [],
    pasteElevationOffset = 0, onEyedropper, sliceLines = null,
    cameraPos3d = null, onSetCamera3d,
    showTemplateOverlay = false, onMapContextMenu }: Props,
  ref,
) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const viewRef    = useRef({ x: 0, y: 0, scale: 2 });
  const clipboardImgRef = useRef<HTMLCanvasElement | null>(null);

  // Tile state (used in "tiled" mode)
  const tileCacheRef  = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const templateTileCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const pendingRef    = useRef<Set<string>>(new Set());
  // Incremented whenever mode/z/world/renderMode changes — lets in-flight fetches detect staleness
  const tileEpochRef  = useRef(0);

  // Concurrency-capped fetch queue (tiled mode)
  const activeRef  = useRef(0);
  const queueRef   = useRef<TileJob[]>([]);
  const drainRef      = useRef<() => void>(() => {});
  const ensureTilesRef = useRef<() => void>(() => {});

  // Full-canvas state (used in "full" and "axo" modes)
  const renderModeRef     = useRef(renderMode);
  const axoSkewRef        = useRef(axoSkew);
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
  const onSelChangeRef    = useRef(onSelectionChange);
  const onPasteAtRef      = useRef(onPasteAt);
  const lockedPastePosRef = useRef(lockedPastePos);
  const drawConfigRef     = useRef(drawConfig);
  const onDrawStrokeRef   = useRef(onDrawStroke);
  const drawZOverrideRef  = useRef(drawZOverride);
  const extrudePreviewRef = useRef(extrudePreview);
  const lastPasteDeltaRef = useRef(lastPasteDelta);
  const onCursorMoveRef   = useRef(onCursorMove);
  const onMapContextMenuRef = useRef(onMapContextMenu);
  const onMagicWandRef      = useRef(onMagicWand);
  const spawnPosRef         = useRef(spawnPos);
  const creaturesRef        = useRef(creatures);
  const sliceLinesRef       = useRef(sliceLines);
  const pasteElevOffsetRef  = useRef(pasteElevationOffset);
  const onEyedropperRef     = useRef(onEyedropper);
  const cameraPos3dRef      = useRef(cameraPos3d ?? null);
  const onSetCamera3dRef    = useRef(onSetCamera3d);

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { onSelChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  useEffect(() => { onPasteAtRef.current   = onPasteAt; }, [onPasteAt]);
  useEffect(() => { lockedPastePosRef.current = lockedPastePos; }, [lockedPastePos]);
  useEffect(() => { drawConfigRef.current = drawConfig; }, [drawConfig]);
  useEffect(() => { onDrawStrokeRef.current = onDrawStroke; }, [onDrawStroke]);
  useEffect(() => { drawZOverrideRef.current = drawZOverride; }, [drawZOverride]);
  useEffect(() => { extrudePreviewRef.current = extrudePreview; }, [extrudePreview]);
  useEffect(() => { lastPasteDeltaRef.current = lastPasteDelta; }, [lastPasteDelta]);
  useEffect(() => { onCursorMoveRef.current = onCursorMove; }, [onCursorMove]);
  useEffect(() => { onMapContextMenuRef.current = onMapContextMenu; }, [onMapContextMenu]);
  useEffect(() => { onMagicWandRef.current     = onMagicWand;         }, [onMagicWand]);
  useEffect(() => { spawnPosRef.current        = spawnPos;            }, [spawnPos]);
  useEffect(() => { creaturesRef.current       = creatures;           }, [creatures]);
  useEffect(() => { sliceLinesRef.current      = sliceLines;           }, [sliceLines]);
  useEffect(() => { pasteElevOffsetRef.current = pasteElevationOffset; }, [pasteElevationOffset]);
  useEffect(() => { onEyedropperRef.current    = onEyedropper;        }, [onEyedropper]);
  useEffect(() => { cameraPos3dRef.current     = cameraPos3d ?? null; }, [cameraPos3d]);
  useEffect(() => { onSetCamera3dRef.current   = onSetCamera3d;       }, [onSetCamera3d]);
  const showTemplateOverlayRef = useRef(showTemplateOverlay);
  // Keep ref in sync; cache clear + redraw happen in the post-draw effect below
  useEffect(() => { showTemplateOverlayRef.current = showTemplateOverlay; }, [showTemplateOverlay]);

  const mapW = world.width_chunks * 16;
  const mapH = world.height_chunks * 16;
  // Refs so draw/ensureTiles (stable callbacks with [] deps) can read current dimensions
  const mapWRef = useRef(mapW);
  const mapHRef = useRef(mapH);
  useEffect(() => { mapWRef.current = mapW; mapHRef.current = mapH; }, [mapW, mapH]);

  // Convert clientX/clientY (viewport coords) to canvas-local coords. The canvas is no longer
  // guaranteed to fill the window at origin (0,0) — in quad/multi-viewport mode it lives in a
  // grid cell — so we subtract its bounding-rect offset.
  const toLocal = useCallback((cx: number, cy: number): { x: number; y: number } => {
    const r = canvasRef.current?.getBoundingClientRect();
    return { x: cx - (r?.left ?? 0), y: cy - (r?.top ?? 0) };
  }, []);

  const screenToWorld = useCallback((sx: number, sy: number): WorldPoint => {
    const { x, y, scale } = viewRef.current;
    const l = toLocal(sx, sy);
    return {
      x: Math.max(0, Math.min(mapW - 1, Math.floor((l.x - x) / scale))),
      y: Math.max(0, Math.min(mapH - 1, Math.floor((l.y - y) / scale))),
    };
  }, [mapW, mapH, toLocal]);

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

    if (renderModeRef.current === "full" || renderModeRef.current === "axo") {
      const fc = fullCanvasRef.current;
      if (fc) ctx.drawImage(fc, 0, 0);
    } else {
      // Draw template layer first at 35% opacity. User tile's transparent pixels (no chunk)
      // let the template show through; opaque user pixels naturally cover it.
      if (showTemplateOverlayRef.current && templateTileCacheRef.current.size > 0) {
        ctx.globalAlpha = 0.35;
        for (const [key, tile] of templateTileCacheRef.current) {
          const comma = key.indexOf(",");
          const tx = parseInt(key.slice(0, comma));
          const ty = parseInt(key.slice(comma + 1));
          ctx.drawImage(tile, tx * TILE, ty * TILE);
        }
        ctx.globalAlpha = 1.0;
      }
      for (const [key, tile] of tileCacheRef.current) {
        const comma = key.indexOf(",");
        const tx = parseInt(key.slice(0, comma));
        const ty = parseInt(key.slice(comma + 1));
        ctx.drawImage(tile, tx * TILE, ty * TILE);
      }
    }

    ctx.restore();

    // Progress bar while full-map or axo is loading (screen coords, outside world transform)
    const loadProgress = fullProgressRef.current;
    if ((renderModeRef.current === "full" || renderModeRef.current === "axo") && loadProgress !== null) {
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
    } else if (drag?.kind === "resizeEdge") {
      ({ x1: wx1, y1: wy1, x2: wx2, y2: wy2 } = drag.live);
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

    // X/Y extrude ghost — dashed sky-blue copies of the selection along X or Y
    {
      const ep = extrudePreviewRef.current;
      const sel = committedSelRef.current;
      if (ep && sel && (ep.axis.startsWith("x") || ep.axis.startsWith("y"))) {
        const selW = sel.x2 - sel.x1 + 1;
        const selH = sel.y2 - sel.y1 + 1;
        const dx = ep.axis === "x+" ? selW : ep.axis === "x-" ? -selW : 0;
        const dy = ep.axis === "y+" ? selH : ep.axis === "y-" ? -selH : 0;
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        for (let k = 1; k <= ep.count; k++) {
          const ox = sel.x1 + dx * k;
          const oy = sel.y1 + dy * k;
          const rx = Math.round(ox * scale + vx);
          const ry = Math.round(oy * scale + vy);
          const rw = Math.round(selW * scale);
          const rh = Math.round(selH * scale);
          const alpha = Math.max(0.08, 0.35 - k * 0.05);
          ctx.fillStyle = `rgba(56,189,248,${alpha})`;
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeStyle = `rgba(56,189,248,${Math.min(1, alpha * 3)})`;
          ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
        }
        ctx.restore();
      }
    }

    // Spawn marker — teal pin at the home position
    {
      const sp = spawnPosRef.current;
      if (sp) {
        const sx = Math.round(sp.px * scale + vx);
        const sy = Math.round(sp.py * scale + vy);
        const r  = Math.max(4, Math.min(10, scale * 1.5));
        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle   = "rgba(20,184,166,0.85)";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth   = 1.5;
        ctx.stroke();
        if (scale >= 3) {
          ctx.fillStyle  = "#fff";
          ctx.font       = `bold ${Math.round(r * 1.1)}px sans-serif`;
          ctx.textAlign  = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("⌂", sx, sy + 0.5);
          ctx.textAlign    = "left";
          ctx.textBaseline = "alphabetic";
        }
        ctx.restore();
      }
    }

    // 3D fly-camera position marker — teal dot with dark outline for contrast on any terrain colour
    {
      const cp = cameraPos3dRef.current;
      if (cp) {
        const cpx = cp.x * scale + vx;
        const cpy = cp.y * scale + vy;
        ctx.save();
        // Dark halo so the marker reads on grass, sand, snow, etc.
        ctx.beginPath();
        ctx.arc(cpx, cpy, 9, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fill();
        // Teal fill disc
        ctx.beginPath();
        ctx.arc(cpx, cpy, 7, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(52,211,153,0.35)";
        ctx.fill();
        // Bright teal ring
        ctx.strokeStyle = "#34d399";
        ctx.lineWidth = 2;
        ctx.stroke();
        // Bright centre dot
        ctx.beginPath();
        ctx.arc(cpx, cpy, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.restore();
      }
    }

    // Slice cut-lines — where the front (world Y) / side (world X) slabs cut the map
    {
      const sl = sliceLinesRef.current;
      if (sl) {
        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(168,85,247,0.8)";
        if (sl.x != null) {
          const sx = Math.round((sl.x + 0.5) * scale + vx) + 0.5;
          ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height); ctx.stroke();
        }
        if (sl.y != null) {
          const sy = Math.round((sl.y + 0.5) * scale + vy) + 0.5;
          ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke();
        }
        ctx.restore();
      }
    }

    // Creature markers — coloured dots at each creature's world position
    {
      const clist = creaturesRef.current;
      if (clist.length > 0) {
        // Per-type colours from creatureColor[NUM_CREATURES+1][3] (Globals.mm)
        const typeColors = ["#4646ff","#73ce4a","#ff46ff","#ff46ff","#ffa500","#eb1414","#eb1414"];
        const r2 = Math.max(3, Math.min(8, scale * 1.2));
        for (const c of clist) {
          const cx2 = Math.round(c.x * scale + vx);
          const cy2 = Math.round(c.y * scale + vy);
          const baseCol = typeColors[c.type_id] ?? "#ffffff";
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx2, cy2, r2, 0, Math.PI * 2);
          ctx.fillStyle = baseCol;
          ctx.globalAlpha = 0.85;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // Paste ghost box — amber when XY is locked, green when hovering
    if (toolRef.current === "paste" && pastePreviewRef.current) {
      const locked = lockedPastePosRef.current;
      const ghostPos = locked ?? pasteHoverRef.current;
      if (ghostPos) {
        const { width: pw, height: ph } = pastePreviewRef.current;
        const gx = Math.round(ghostPos.x * scale + vx);
        const gy = Math.round(ghostPos.y * scale + vy);
        const gw = Math.round(pw * scale);
        const gh = Math.round(ph * scale);
        if (clipboardImgRef.current) {
          ctx.save();
          ctx.globalAlpha = 0.5;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(clipboardImgRef.current, gx, gy, gw, gh);
          ctx.restore();
        }
        if (locked) {
          ctx.fillStyle   = "rgba(251, 191, 36, 0.12)";
          ctx.fillRect(gx, gy, gw, gh);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
          ctx.lineWidth   = 2;
          ctx.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);
          ctx.strokeStyle = "rgba(251, 191, 36, 1)";
          ctx.lineWidth   = 1;
          ctx.strokeRect(gx + 2.5, gy + 2.5, gw - 5, gh - 5);
        } else {
          ctx.fillStyle   = "rgba(34, 197, 94, 0.12)";
          ctx.fillRect(gx, gy, gw, gh);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
          ctx.lineWidth   = 2;
          ctx.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);
          ctx.strokeStyle = "rgba(34, 197, 94, 1)";
          ctx.lineWidth   = 1;
          ctx.strokeRect(gx + 2.5, gy + 2.5, gw - 5, gh - 5);
        }
        // Z-offset label above the ghost rect
        const off = pasteElevOffsetRef.current;
        const label = off === 0 ? "z+0" : off > 0 ? `z+${off}` : `z${off}`;
        const labelColor = locked ? "rgba(251,191,36,1)" : "rgba(34,197,94,1)";
        ctx.save();
        ctx.font = "bold 11px monospace";
        ctx.textAlign = "center";
        const tw = ctx.measureText(label).width + 6;
        const lx = gx + gw / 2;
        const ly = gy - 6;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(lx - tw / 2, ly - 11, tw, 13);
        ctx.fillStyle = labelColor;
        ctx.fillText(label, lx, ly);
        ctx.restore();
      }
    }

    // Repeat-paste trail: 3 faded ghost copies in the last-paste direction
    {
      const delta = lastPasteDeltaRef.current;
      if (toolRef.current === "paste" && pastePreviewRef.current && delta) {
        const ghostPos = lockedPastePosRef.current ?? pasteHoverRef.current;
        if (ghostPos) {
          const { width: pw, height: ph } = pastePreviewRef.current;
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          for (let k = 1; k <= 3; k++) {
            const alpha = Math.max(0.04, 0.16 - k * 0.04);
            const gx = Math.round((ghostPos.x + delta.dx * k) * scale + vx);
            const gy = Math.round((ghostPos.y + delta.dy * k) * scale + vy);
            const gw = Math.round(pw * scale);
            const gh = Math.round(ph * scale);
            ctx.fillStyle   = `rgba(34, 197, 94, ${alpha})`;
            ctx.fillRect(gx, gy, gw, gh);
            ctx.strokeStyle = `rgba(34, 197, 94, ${Math.min(1, alpha * 3)})`;
            ctx.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);
          }
          ctx.restore();
        }
      }
    }

    // Draw tool ghost overlay
    {
      const drawTool = toolRef.current;
      const cfg = drawConfigRef.current;
      const gs = Math.max(1, Math.round(scale));
      const paintPt = (wx: number, wy: number) => {
        ctx.fillRect(Math.round(wx * scale + vx), Math.round(wy * scale + vy), gs, gs);
      };
      if (drag?.kind === "draw-stroke") {
        ctx.fillStyle = "rgba(56,189,248,0.55)";
        for (const key of drag.pts) {
          const ci = key.indexOf(",");
          paintPt(parseInt(key.slice(0, ci)), parseInt(key.slice(ci + 1)));
        }
      } else if (drag?.kind === "draw-shape" && cfg) {
        const pts = drag.tool === "rect"
          ? rectPixels(drag.start, drag.end, cfg.fillMode)
          : ellipsePixels(drag.start, drag.end, cfg.fillMode);
        ctx.fillStyle = "rgba(56,189,248,0.55)";
        for (const p of pts) paintPt(p.x, p.y);
        // Outline the bounding box
        ctx.strokeStyle = "rgba(56,189,248,0.9)";
        ctx.lineWidth = 1;
        const bx1 = Math.min(drag.start.x, drag.end.x), by1 = Math.min(drag.start.y, drag.end.y);
        const bx2 = Math.max(drag.start.x, drag.end.x), by2 = Math.max(drag.start.y, drag.end.y);
        ctx.strokeRect(Math.round(bx1 * scale + vx) + 0.5, Math.round(by1 * scale + vy) + 0.5,
          Math.round((bx2 - bx1 + 1) * scale), Math.round((by2 - by1 + 1) * scale));
      } else if (!drag && (drawTool === "pen" || drawTool === "brush" || drawTool === "smooth" || drawTool === "noise" || drawTool === "flatten" || drawTool === "erode" || drawTool === "fill") && cfg) {
        // Cursor preview when hovering (not dragging)
        const pos = cursorPosRef.current;
        if (pos) {
          const isSculpt = drawTool === "smooth" || drawTool === "noise" || drawTool === "flatten" || drawTool === "erode";
          const pts = (drawTool === "pen" || drawTool === "fill")
            ? [pos]
            : brushFootprint(pos, cfg.brushSize, isSculpt ? "circ" : cfg.brushShape);
          ctx.fillStyle = isSculpt ? "rgba(251,146,60,0.45)" : drawTool === "fill" ? "rgba(52,211,153,0.55)" : "rgba(56,189,248,0.4)";
          for (const p of pts) paintPt(p.x, p.y);
        }
      }
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

      // Also fetch template tile for overlay if enabled and in topdown mode
      if (showTemplateOverlayRef.current && viewModeRef.current !== "zslice" && !templateTileCacheRef.current.has(key)) {
        try {
          const traw = await invoke<PixelPatchRaw>("fetch_template_tile", { x1, y1, x2, y2 });
          if (tileEpochRef.current === myEpoch) {
            const tpixels = decodePixels(traw.pixels);
            const ttc = document.createElement("canvas");
            ttc.width = traw.width; ttc.height = traw.height;
            const ttctx = ttc.getContext("2d")!;
            const timg = ttctx.createImageData(traw.width, traw.height);
            timg.data.set(tpixels);
            ttctx.putImageData(timg, 0, 0);
            templateTileCacheRef.current.set(key, ttc);
          }
        } catch { /* template fetch failure is non-fatal */ }
      }

      draw();
    } catch {
      // world not loaded or tile out of range — leave absent from cache
    } finally {
      pendingRef.current.delete(key);
      activeRef.current--;
      drainRef.current();
    }
  }, [draw]);

  // When overlay is toggled, invalidate tile cache so loadTile re-runs and fetches template tiles too
  useEffect(() => {
    templateTileCacheRef.current.clear();
    if (showTemplateOverlay) {
      tileEpochRef.current++;
      tileCacheRef.current.clear();
      pendingRef.current.clear();
      queueRef.current = [];
      ensureTilesRef.current();
    } else {
      draw();
    }
  }, [showTemplateOverlay, draw]);

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
        } else if (renderModeRef.current === "axo") {
          raw = await invoke<PixelPatchRaw>("render_axo_region", {
            x1: 0, y1: y, x2: mW - 1, y2, ski: axoSkewRef.current,
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
    if (renderModeRef.current === "full" || renderModeRef.current === "axo") {
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
    for (const key of templateTileCacheRef.current.keys()) {
      if (!needed.has(key)) templateTileCacheRef.current.delete(key);
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
  ensureTilesRef.current = ensureTiles;

  // ── Exposed API ───────────────────────────────────────────────────────────

  useImperativeHandle(ref, () => ({
    applyPatch(patch: PixelPatch) {
      if (renderModeRef.current === "axo") {
        // Axo: coordinate shift means flat patches land at wrong positions — force full reload
        fullCanvasRef.current = null;
        loadFullCanvas();
        return;
      }
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
      if (renderModeRef.current === "full" || renderModeRef.current === "axo") {
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
    if (!clipboardPreviewPixels) { clipboardImgRef.current = null; return; }
    const c = document.createElement("canvas");
    c.width  = clipboardPreviewPixels.width;
    c.height = clipboardPreviewPixels.height;
    const offCtx = c.getContext("2d")!;
    const img = offCtx.createImageData(c.width, c.height);
    img.data.set(clipboardPreviewPixels.pixels);
    offCtx.putImageData(img, 0, 0);
    clipboardImgRef.current = c;
  }, [clipboardPreviewPixels]);

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
    templateTileCacheRef.current.clear();
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
    templateTileCacheRef.current.clear();
    pendingRef.current.clear();
    queueRef.current = [];
    fullCanvasRef.current = null;
    ensureTiles();
  }, [renderMode, ensureTiles]);

  // Re-render axo canvas when skew slider changes
  useEffect(() => {
    axoSkewRef.current = axoSkew;
    if (renderModeRef.current !== "axo") return;
    tileEpochRef.current++;
    fullCanvasRef.current = null;
    ensureTiles();
  }, [axoSkew, ensureTiles]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Size the backing store to the canvas's own laid-out box (CSS 100%/100% of its parent),
    // not the window — so the canvas works both full-screen and inside a quad-view grid cell.
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ensureTiles();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [ensureTiles]);

  // ── Pointer / wheel handlers ──────────────────────────────────────────────

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === 1) {
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
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
    if (e.button === 2) return;
    if (e.button !== 0) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    // Camera icon: clicking near the teal dot starts a drag to teleport the 3D camera.
    {
      const cp = cameraPos3dRef.current;
      if (cp && onSetCamera3dRef.current) {
        const lp = toLocal(e.clientX, e.clientY);
        const { x: vx2, y: vy2, scale: s2 } = viewRef.current;
        const iconX = cp.x * s2 + vx2, iconY = cp.y * s2 + vy2;
        const dx = lp.x - iconX, dy = lp.y - iconY;
        if (dx * dx + dy * dy <= 144) { // 12px hit radius
          dragRef.current = { kind: "cam3d-drag" };
          draw();
          return;
        }
      }
    }
    if (toolRef.current === "wand") {
      const wp = screenToWorld(e.clientX, e.clientY);
      onMagicWandRef.current?.(wp.x, wp.y);
      return;
    }
    if (toolRef.current === "eyedropper") {
      const wp = screenToWorld(e.clientX, e.clientY);
      onEyedropperRef.current?.(wp.x, wp.y);
      return;
    }
    if (toolRef.current === "select") {
      const sel = committedSelRef.current;
      if (sel !== null) {
        const lp = toLocal(e.clientX, e.clientY);
        const edge = hitTestEdge(lp.x, lp.y, sel, viewRef.current);
        if (edge !== null) {
          const cur = edge === "x1" || edge === "x2" ? "ew-resize" : "ns-resize";
          (e.target as HTMLCanvasElement).style.cursor = cur;
          dragRef.current = { kind: "resizeEdge", edge, live: { ...sel } };
          draw();
          return;
        }
      }
      const wp = screenToWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "select", start: wp, end: wp };
      draw();
    } else if (toolRef.current === "paste") {
      // paste fires on pointer-up
    } else if (toolRef.current === "pen" || toolRef.current === "brush" || toolRef.current === "smooth" || toolRef.current === "noise" || toolRef.current === "flatten" || toolRef.current === "erode") {
      const wp = screenToWorld(e.clientX, e.clientY);
      const cfg = drawConfigRef.current;
      const isSculpt = toolRef.current === "smooth" || toolRef.current === "noise" || toolRef.current === "flatten" || toolRef.current === "erode";
      const footprint = (toolRef.current === "pen" || !cfg)
        ? [wp]
        : brushFootprint(wp, cfg.brushSize, isSculpt ? "circ" : cfg.brushShape);
      const pts = new Set<string>(footprint.map(p => `${p.x},${p.y}`));
      dragRef.current = { kind: "draw-stroke", pts, lastWX: wp.x, lastWY: wp.y };
      draw();
    } else if (toolRef.current === "fill") {
      // Fill fires on pointer-up; nothing to drag. Start a minimal stroke so pointer-up fires it.
      const wp = screenToWorld(e.clientX, e.clientY);
      const pts = new Set<string>([`${wp.x},${wp.y}`]);
      dragRef.current = { kind: "draw-stroke", pts, lastWX: wp.x, lastWY: wp.y };
      draw();
    } else if (toolRef.current === "rect" || toolRef.current === "ellipse") {
      const wp = screenToWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "draw-shape", tool: toolRef.current, start: wp, end: wp };
      draw();
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
    onCursorMoveRef.current?.(wp.x, wp.y);
    const drag = dragRef.current;
    // Cursor: show "move" when hovering the 3D camera icon with no active drag.
    if (!drag && onSetCamera3dRef.current) {
      const cp = cameraPos3dRef.current;
      if (cp) {
        const lp = toLocal(e.clientX, e.clientY);
        const { x: vx2, y: vy2, scale: s2 } = viewRef.current;
        const iconX = cp.x * s2 + vx2, iconY = cp.y * s2 + vy2;
        const dx = lp.x - iconX, dy = lp.y - iconY;
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = (dx * dx + dy * dy <= 144) ? "move" : "";
      }
    }
    if (drag?.kind === "pan") {
      viewRef.current.x = drag.viewX + e.clientX - drag.startX;
      viewRef.current.y = drag.viewY + e.clientY - drag.startY;
      ensureTiles(); // includes draw()
    } else {
      if (drag?.kind === "resizeEdge") {
        switch (drag.edge) {
          case "x1": drag.live.x1 = Math.min(wp.x, drag.live.x2); break;
          case "x2": drag.live.x2 = Math.max(wp.x, drag.live.x1); break;
          case "y1": drag.live.y1 = Math.min(wp.y, drag.live.y2); break;
          case "y2": drag.live.y2 = Math.max(wp.y, drag.live.y1); break;
        }
      } else if (drag?.kind === "draw-stroke") {
        const cfg = drawConfigRef.current;
        const isSculpt = toolRef.current === "smooth" || toolRef.current === "noise" || toolRef.current === "flatten" || toolRef.current === "erode";
        const line = bresenhamLine({ x: drag.lastWX, y: drag.lastWY }, wp);
        for (const lp of line) {
          const footprint = (toolRef.current === "pen" || toolRef.current === "fill" || !cfg)
            ? [lp]
            : brushFootprint(lp, cfg.brushSize, isSculpt ? "circ" : cfg.brushShape);
          for (const p of footprint) drag.pts.add(`${p.x},${p.y}`);
        }
        drag.lastWX = wp.x;
        drag.lastWY = wp.y;
      } else if (drag?.kind === "draw-shape") {
        drag.end = wp;
      } else if (drag?.kind === "select") {
        drag.end = wp;
      } else if (drag?.kind === "cam3d-drag") {
        onSetCamera3dRef.current?.(wp.x, wp.y);
      } else if (toolRef.current === "paste") {
        pasteHoverRef.current = wp;
      } else if (toolRef.current === "select") {
        // Hover cursor: show resize cursors near selection edges when idle
        const canvas = canvasRef.current;
        if (canvas) {
          const sel = committedSelRef.current;
          if (sel !== null) {
            const lp = toLocal(e.clientX, e.clientY);
            const edge = hitTestEdge(lp.x, lp.y, sel, viewRef.current);
            if (edge === "x1" || edge === "x2") canvas.style.cursor = "ew-resize";
            else if (edge === "y1" || edge === "y2") canvas.style.cursor = "ns-resize";
            else canvas.style.cursor = "crosshair";
          } else {
            canvas.style.cursor = "crosshair";
          }
        }
      }
      draw();
    }
  }, [draw, ensureTiles, screenToWorld]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag?.kind === "pan") {
      dragRef.current = null;
      return;
    }
    if (drag?.kind === "cam3d-drag") {
      dragRef.current = null;
      const wp2 = screenToWorld(e.clientX, e.clientY);
      onSetCamera3dRef.current?.(wp2.x, wp2.y);
      draw();
      return;
    }
    if (drag?.kind === "resizeEdge") {
      dragRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "crosshair";
      // Only commit if the selection wasn't cancelled by Escape mid-drag
      if (committedSelRef.current !== null) {
        onSelChangeRef.current({ ...drag.live });
      }
      draw();
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
    if (drag?.kind === "draw-stroke") {
      dragRef.current = null;
      draw();
      if (drag.pts.size > 0 && onDrawStrokeRef.current) {
        const pts = Array.from(drag.pts).map(k => {
          const ci = k.indexOf(",");
          return [parseInt(k.slice(0, ci)), parseInt(k.slice(ci + 1))] as [number, number];
        });
        onDrawStrokeRef.current(pts, drawZOverrideRef.current);
      }
      return;
    }
    if (drag?.kind === "draw-shape") {
      const end = screenToWorld(e.clientX, e.clientY);
      dragRef.current = null;
      draw();
      const cfg = drawConfigRef.current;
      if (onDrawStrokeRef.current && cfg) {
        const pts = drag.tool === "rect"
          ? rectPixels(drag.start, end, cfg.fillMode)
          : ellipsePixels(drag.start, end, cfg.fillMode);
        if (pts.length > 0) {
          onDrawStrokeRef.current(pts.map(p => [p.x, p.y]), drawZOverrideRef.current);
        }
      }
      return;
    }
    if (toolRef.current === "paste") {
      onPasteAtRef.current(screenToWorld(e.clientX, e.clientY));
    }
  }, [draw, screenToWorld]);

  const onPointerLeave = useCallback(() => {
    cursorPosRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = toolRef.current === "pan" ? "grab" : "crosshair";
    draw();
  }, [draw]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const { x, y, scale } = viewRef.current;
    const factor   = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(32, Math.max(0.25, scale * factor));
    const lp = toLocal(e.clientX, e.clientY);
    viewRef.current = {
      scale: newScale,
      x: lp.x - (lp.x - x) * (newScale / scale),
      y: lp.y - (lp.y - y) * (newScale / scale),
    };
    ensureTiles(); // in full mode: just draw(); in tiled mode: loads new tiles
  }, [ensureTiles, toLocal]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block", width: "100%", height: "100%", cursor: tool === "pan" ? "grab" : tool === "eyedropper" ? "cell" : "crosshair" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onWheel={onWheel}
      onContextMenu={e => {
        e.preventDefault();
        const wp = screenToWorld(e.clientX, e.clientY);
        onMapContextMenuRef.current?.(wp.x, wp.y, e.clientX, e.clientY);
      }}
    />
  );
});

export default MapCanvas;
