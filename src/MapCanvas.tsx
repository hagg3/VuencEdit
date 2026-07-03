import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { invoke } from "@tauri-apps/api/core";
import { brushFootprint, bresenhamLine, linePixels, polygonPixels, rectPixels, ellipsePixels, type WP, type BrushShape, type FillMode } from "./drawTools";
import { type WorldMeta, type PixelPatch, type PixelPatchRaw } from "./types";
import { zoomAtPoint, resizeCanvasToContainer, makeSeqGuard, putPatchPixels } from "./viewportUtils";

export type { PixelPatch } from "./types";

export type Tool = "pan" | "select" | "wand" | "paste" | "pen" | "brush" | "spray" | "line" | "rect" | "ellipse" | "polygon" | "smooth" | "noise" | "flatten" | "erode" | "thermal" | "hydro" | "stamp" | "grab" | "raise" | "lower" | "fill" | "eyedropper";

/** Sculpt tools that paint a swept disc footprint (everything except the drag-controlled "grab"). */
const SCULPT_STROKE_TOOLS: readonly Tool[] = ["smooth", "noise", "flatten", "erode", "thermal", "hydro", "stamp", "raise", "lower"];
const isSculptStroke = (t: Tool): boolean => SCULPT_STROKE_TOOLS.includes(t);

export interface DrawConfig {
  brushSize: number;
  brushShape: BrushShape;
  fillMode: FillMode;
  sculptRadius: number;
  sculptAccumulate: boolean;
  sprayDensity: number;      // 0..1 — fraction of footprint cells placed per spray stamp
  strokeStabilizer: boolean; // low-pass the freehand pointer path (Photoshop-style)
}

/** World pixels per tile side. Each tile is fetched independently via IPC. */
const TILE = 512;

/** Number of extra tile rows/cols to prefetch beyond the visible viewport edge. */
const TILE_BUFFER = 1;

/** Maximum simultaneous in-flight tile fetches. Prevents IPC channel saturation. */
const MAX_CONCURRENT = 4;

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
  | { kind: "moveSel"; origin: SelectionBounds; start: WorldPoint; dx: number; dy: number; ghost: HTMLCanvasElement | null }
  | { kind: "draw-stroke"; pts: Set<string>; lastWX: number; lastWY: number; startWX: number; startWY: number }
  | { kind: "sculpt-grab"; pts: Set<string>; cx: number; cy: number; downClientY: number; delta: number }
  | { kind: "draw-shape"; tool: "rect" | "ellipse" | "line"; start: WP; end: WP }
  | { kind: "cam3d-drag" }
  | null;

const EDGE_HIT_PX = 6;

/** Draw-stroke tools that freehand-stamp a footprint along the pointer path. */
const FREEHAND_TOOLS: readonly Tool[] = ["pen", "brush", "spray"];
const isFreehand = (t: Tool): boolean => FREEHAND_TOOLS.includes(t);
/** Two-click drag shapes committed on pointer-up. */
const isShapeTool = (t: Tool): boolean => t === "line" || t === "rect" || t === "ellipse";

/** Keep each cell with probability `density` (spray/scatter). */
const sprayFilter = (cells: WP[], density: number): WP[] =>
  density >= 1 ? cells : cells.filter(() => Math.random() < density);

/** Footprint stamped at `p` for a freehand/sculpt tool given the current config. */
function stampFootprint(p: WP, tool: Tool, cfg: DrawConfig | undefined): WP[] {
  if (!cfg) return [p];
  if (isSculptStroke(tool)) return brushFootprint(p, cfg.sculptRadius * 2 + 1, "circ");
  if (tool === "pen") return [p];
  const fp = brushFootprint(p, cfg.brushSize, cfg.brushShape);
  return tool === "spray" ? sprayFilter(fp, cfg.sprayDensity) : fp;
}

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

interface Props {
  world: WorldMeta;
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
  /** Called when a draw stroke or shape is committed with the list of world positions, the z override (null = surface), the pointer-down anchor column (sculpt tools), and (grab tool) the drag-controlled vertical delta in blocks. */
  onDrawStroke?: (pts: [number, number][], zOverride: number | null, anchor?: [number, number], grabDelta?: number) => void | Promise<void>;
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
  /** Called on every pointer-move during a select-tool drag with the live (unnormalized) rect; null when the drag ends/cancels. Used for a live W×H status bar readout. */
  onSelectDragUpdate?: (rect: { x1: number; y1: number; x2: number; y2: number } | null) => void;
  /** Called when the user drags inside the committed selection (not on a resize edge) and releases with a nonzero offset — moves the selection and its contents as one gesture (E2). */
  onMoveSelection?: (dx: number, dy: number) => void;
  /** When true, a drag-move captures a snapshot of the selection's current pixels and shows it as a semi-transparent ghost following the drag (content will actually move on drop). When false, only the outline is dragged (E2 "Move: Box Only" default). */
  moveWithContents?: boolean;
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
    showTemplateOverlay = false, onMapContextMenu, onSelectDragUpdate, onMoveSelection, moveWithContents = false }: Props,
  ref,
) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const viewRef    = useRef({ x: 0, y: 0, scale: 2 });
  const clipboardImgRef = useRef<HTMLCanvasElement | null>(null);

  // Tile state (used in "tiled" mode)
  const tileCacheRef  = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const templateTileCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const pendingRef    = useRef<Set<string>>(new Set());
  // Bumped whenever mode/z/world/renderMode changes — lets in-flight fetches detect staleness
  const tileEpoch = useRef(makeSeqGuard());

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
  // Hold-to-build: interval id while a sculpt stroke re-stamps the cursor; flag = a tick fired
  // (so pointer-up skips the final one-shot stroke to avoid a double application).
  const accumTimerRef = useRef<number | null>(null);
  const accumFiredRef = useRef(false);
  const accumBusyRef = useRef(false); // a tick's async edit is still in flight — skip overlaps
  // Polygon tool: click-accumulated vertices (committed on click-near-start / double-click).
  const polyVertsRef = useRef<WP[]>([]);
  // Stroke stabilizer: fractional low-passed pointer position that the freehand stamp follows.
  const smoothPosRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => () => { if (accumTimerRef.current !== null) clearInterval(accumTimerRef.current); }, []);

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
  const onSelectDragUpdateRef = useRef(onSelectDragUpdate);
  const onMoveSelectionRef = useRef(onMoveSelection);
  const moveWithContentsRef = useRef(moveWithContents);

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
  useEffect(() => { onSelectDragUpdateRef.current = onSelectDragUpdate; }, [onSelectDragUpdate]);
  useEffect(() => { onMoveSelectionRef.current = onMoveSelection; }, [onMoveSelection]);
  useEffect(() => { moveWithContentsRef.current = moveWithContents; }, [moveWithContents]);
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
  // Cached rect avoids a layout read on every pointermove (getBoundingClientRect forces reflow);
  // refreshed on resize (ResizeObserver) and at the start of each pointer gesture.
  const rectRef = useRef<DOMRect | null>(null);
  const toLocal = useCallback((cx: number, cy: number): { x: number; y: number } => {
    const r = rectRef.current ?? canvasRef.current?.getBoundingClientRect() ?? null;
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
    } else if (drag?.kind === "moveSel") {
      wx1 = drag.origin.x1 + drag.dx; wy1 = drag.origin.y1 + drag.dy;
      wx2 = drag.origin.x2 + drag.dx; wy2 = drag.origin.y2 + drag.dy;
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
      if (drag?.kind === "moveSel" && drag.ghost) {
        ctx.globalAlpha = 0.8;
        ctx.drawImage(drag.ghost, rx, ry, rw, rh);
        ctx.globalAlpha = 1;
      }
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
        // Out-of-bounds warning
        const oob = ghostPos.x < 0 || ghostPos.y < 0 ||
          ghostPos.x + pw > mapWRef.current || ghostPos.y + ph > mapHRef.current;
        if (oob) {
          const warnLabel = "Out of bounds";
          ctx.save();
          ctx.font = "bold 10px monospace";
          ctx.textAlign = "center";
          const wtw = ctx.measureText(warnLabel).width + 8;
          ctx.fillStyle = "rgba(0,0,0,0.75)";
          ctx.fillRect(lx - wtw / 2, ly - 26, wtw, 13);
          ctx.fillStyle = "rgba(239,68,68,1)";
          ctx.fillText(warnLabel, lx, ly - 14);
          ctx.restore();
        }
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
      } else if (drag?.kind === "sculpt-grab") {
        // Fixed disc footprint tinted amber; a floating ±N label shows the pull amount.
        ctx.fillStyle = "rgba(251,146,60,0.5)";
        for (const key of drag.pts) {
          const ci = key.indexOf(",");
          paintPt(parseInt(key.slice(0, ci)), parseInt(key.slice(ci + 1)));
        }
        const lx = Math.round(drag.cx * scale + vx);
        const ly = Math.round(drag.cy * scale + vy);
        ctx.font = "bold 13px monospace";
        ctx.fillStyle = drag.delta > 0 ? "#fbbf24" : drag.delta < 0 ? "#60a5fa" : "#94a3b8";
        ctx.textAlign = "center";
        ctx.fillText(`${drag.delta > 0 ? "+" : ""}${drag.delta}`, lx, ly - 8);
        ctx.textAlign = "left";
      } else if (drag?.kind === "draw-shape" && cfg) {
        const pts = drag.tool === "rect" ? rectPixels(drag.start, drag.end, cfg.fillMode)
          : drag.tool === "line" ? linePixels(drag.start, drag.end, cfg.brushSize, cfg.brushShape)
          : ellipsePixels(drag.start, drag.end, cfg.fillMode);
        ctx.fillStyle = "rgba(56,189,248,0.55)";
        for (const p of pts) paintPt(p.x, p.y);
        if (drag.tool !== "line") {
          // Outline the bounding box (line has no meaningful box)
          ctx.strokeStyle = "rgba(56,189,248,0.9)";
          ctx.lineWidth = 1;
          const bx1 = Math.min(drag.start.x, drag.end.x), by1 = Math.min(drag.start.y, drag.end.y);
          const bx2 = Math.max(drag.start.x, drag.end.x), by2 = Math.max(drag.start.y, drag.end.y);
          ctx.strokeRect(Math.round(bx1 * scale + vx) + 0.5, Math.round(by1 * scale + vy) + 0.5,
            Math.round((bx2 - bx1 + 1) * scale), Math.round((by2 - by1 + 1) * scale));
        }
      } else if (drawTool === "polygon" && polyVertsRef.current.length > 0) {
        // Polygon-in-progress: vertices + edges + rubber-band to cursor.
        const verts = polyVertsRef.current;
        const toS = (p: WP) => ({ x: Math.round(p.x * scale + vx) + gs / 2, y: Math.round(p.y * scale + vy) + gs / 2 });
        ctx.strokeStyle = "rgba(56,189,248,0.9)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const s0 = toS(verts[0]);
        ctx.moveTo(s0.x, s0.y);
        for (let i = 1; i < verts.length; i++) { const s = toS(verts[i]); ctx.lineTo(s.x, s.y); }
        const cur = cursorPosRef.current;
        if (cur) { const sc = toS(cur); ctx.lineTo(sc.x, sc.y); }
        ctx.stroke();
        // Vertex dots; the first is highlighted (click it to close).
        for (let i = 0; i < verts.length; i++) {
          const s = toS(verts[i]);
          ctx.fillStyle = i === 0 ? "#22c55e" : "#38bdf8";
          ctx.beginPath(); ctx.arc(s.x, s.y, i === 0 ? 4 : 3, 0, Math.PI * 2); ctx.fill();
        }
      } else if (!drag && (isFreehand(drawTool) || drawTool === "grab" || isSculptStroke(drawTool) || drawTool === "fill") && cfg) {
        // Cursor preview when hovering (not dragging)
        const pos = cursorPosRef.current;
        if (pos) {
          const isSculpt = drawTool === "grab" || isSculptStroke(drawTool);
          const pts = isSculpt
            ? brushFootprint(pos, cfg.sculptRadius * 2 + 1, "circ")
            : (drawTool === "pen" || drawTool === "fill")
              ? [pos]
              : brushFootprint(pos, cfg.brushSize, cfg.brushShape);
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

  // rAF-coalesced draw: pointermove/wheel fire far faster than the display refresh rate, so a
  // synchronous draw() per event does redundant canvas work. scheduleDraw collapses any number
  // of calls within a frame into one (FlyView3D's dirty+rAF pattern).
  const drawRafPendingRef = useRef(false);
  const scheduleDraw = useCallback(() => {
    if (drawRafPendingRef.current) return;
    drawRafPendingRef.current = true;
    requestAnimationFrame(() => {
      drawRafPendingRef.current = false;
      draw();
    });
  }, [draw]);

  // ── loadTile ──────────────────────────────────────────────────────────────

  const loadTile = useCallback(async (
    key: string, x1: number, y1: number, x2: number, y2: number,
  ) => {
    const myEpoch = tileEpoch.current.peek();
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
      if (tileEpoch.current.isStale(myEpoch)) return;
      const tc  = document.createElement("canvas");
      tc.width  = raw.width;
      tc.height = raw.height;
      putPatchPixels(tc.getContext("2d")!, raw);
      tileCacheRef.current.set(key, tc);

      // Also fetch template tile for overlay if enabled and in topdown mode
      if (showTemplateOverlayRef.current && viewModeRef.current !== "zslice" && !templateTileCacheRef.current.has(key)) {
        try {
          const traw = await invoke<PixelPatchRaw>("fetch_template_tile", { x1, y1, x2, y2 });
          if (!tileEpoch.current.isStale(myEpoch)) {
            const ttc = document.createElement("canvas");
            ttc.width = traw.width; ttc.height = traw.height;
            putPatchPixels(ttc.getContext("2d")!, traw);
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
      tileEpoch.current.next();
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
    const myEpoch = tileEpoch.current.peek();
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
        if (tileEpoch.current.isStale(myEpoch)) return;
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
        if (tileEpoch.current.isStale(myEpoch)) return;
        putPatchPixels(fctx, raw, 0, y);
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

  // rAF-coalesced ensureTiles for the pan-drag hot path — panning fires pointermove far faster
  // than the display refresh rate, and ensureTiles recomputes the tile window + does Set churn
  // on top of draw(), so this matters more there than a bare scheduleDraw.
  const ensureRafPendingRef = useRef(false);
  const scheduleEnsureTiles = useCallback(() => {
    if (ensureRafPendingRef.current) return;
    ensureRafPendingRef.current = true;
    requestAnimationFrame(() => {
      ensureRafPendingRef.current = false;
      ensureTiles();
    });
  }, [ensureTiles]);

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
    tileEpoch.current.next();
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
    tileEpoch.current.next();
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
    tileEpoch.current.next();
    fullCanvasRef.current = null;
    ensureTiles();
  }, [axoSkew, ensureTiles]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Size the backing store to the canvas's own laid-out box (CSS 100%/100% of its parent),
    // not the window — so the canvas works both full-screen and inside a quad-view grid cell.
    const resize = () => {
      resizeCanvasToContainer(canvas);
      rectRef.current = canvas.getBoundingClientRect();
      ensureTiles();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [ensureTiles]);

  // ── Pointer / wheel handlers ──────────────────────────────────────────────

  // Close the polygon-in-progress: fill/outline its interior and commit as one stroke.
  const commitPolygon = useCallback(() => {
    const verts = polyVertsRef.current;
    polyVertsRef.current = [];
    if (verts.length >= 2 && onDrawStrokeRef.current) {
      const mode: FillMode = drawConfigRef.current?.fillMode ?? "fill";
      const pts = polygonPixels(verts, mode);
      if (pts.length > 0) onDrawStrokeRef.current(pts.map(p => [p.x, p.y]), drawZOverrideRef.current);
    }
    draw();
  }, [draw]);

  // Escape cancels an in-progress polygon (before it reaches App's global Escape handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && polyVertsRef.current.length > 0) {
        e.stopPropagation();
        polyVertsRef.current = [];
        draw();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [draw]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Refresh the cached rect at the start of each gesture (toLocal reads it for the duration).
    rectRef.current = (e.target as HTMLCanvasElement).getBoundingClientRect();
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
        const wpIn = screenToWorld(e.clientX, e.clientY);
        if (wpIn.x >= sel.x1 && wpIn.x <= sel.x2 && wpIn.y >= sel.y1 && wpIn.y <= sel.y2) {
          // Click-drag inside the committed selection (not on a resize edge) moves it with
          // its contents (E2) instead of starting a new marquee.
          (e.target as HTMLCanvasElement).style.cursor = "move";
          let ghost: HTMLCanvasElement | null = null;
          if (moveWithContentsRef.current) {
            // Snapshot the selection's current on-screen pixels before any drag overlay is
            // drawn, so it can be shown as a moving preview of what will actually relocate.
            const src = canvasRef.current;
            const { x: vx0, y: vy0, scale: s0 } = viewRef.current;
            const rx = Math.round(sel.x1 * s0 + vx0);
            const ry = Math.round(sel.y1 * s0 + vy0);
            const rw = Math.round((sel.x2 - sel.x1 + 1) * s0);
            const rh = Math.round((sel.y2 - sel.y1 + 1) * s0);
            if (src && rw > 0 && rh > 0) {
              const off = document.createElement("canvas");
              off.width = rw; off.height = rh;
              off.getContext("2d")?.drawImage(src, rx, ry, rw, rh, 0, 0, rw, rh);
              ghost = off;
            }
          }
          dragRef.current = { kind: "moveSel", origin: { ...sel }, start: wpIn, dx: 0, dy: 0, ghost };
          draw();
          return;
        }
      }
      const wp = screenToWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "select", start: wp, end: wp };
      onSelectDragUpdateRef.current?.({ x1: wp.x, y1: wp.y, x2: wp.x, y2: wp.y });
      draw();
    } else if (toolRef.current === "paste") {
      // paste fires on pointer-up
    } else if (toolRef.current === "grab") {
      // Grab: fixed disc footprint at the down point; vertical drag sets the displacement.
      const wp = screenToWorld(e.clientX, e.clientY);
      const cfg = drawConfigRef.current;
      const disc = cfg ? brushFootprint(wp, cfg.sculptRadius * 2 + 1, "circ") : [wp];
      const pts = new Set<string>(disc.map(p => `${p.x},${p.y}`));
      dragRef.current = { kind: "sculpt-grab", pts, cx: wp.x, cy: wp.y, downClientY: e.clientY, delta: 0 };
      draw();
    } else if (toolRef.current === "polygon") {
      // Polygon/lasso: each click adds a vertex; click near the first vertex (or double-click)
      // closes and fills. No drag state — vertices persist in polyVertsRef across clicks.
      const wp = screenToWorld(e.clientX, e.clientY);
      const verts = polyVertsRef.current;
      if (verts.length >= 3) {
        const { x: vx0, y: vy0, scale: s0 } = viewRef.current;
        const lp = toLocal(e.clientX, e.clientY);
        const sx = verts[0].x * s0 + vx0, sy = verts[0].y * s0 + vy0;
        if ((lp.x - sx) ** 2 + (lp.y - sy) ** 2 <= 100) { // within ~10 px of start → close
          commitPolygon();
          return;
        }
      }
      verts.push(wp);
      draw();
    } else if (isFreehand(toolRef.current) || isSculptStroke(toolRef.current)) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const cfg = drawConfigRef.current;
      const isSculpt = isSculptStroke(toolRef.current);
      smoothPosRef.current = { x: wp.x, y: wp.y }; // stabilizer origin
      const footprint = stampFootprint(wp, toolRef.current, cfg);
      const pts = new Set<string>(footprint.map(p => `${p.x},${p.y}`));
      dragRef.current = { kind: "draw-stroke", pts, lastWX: wp.x, lastWY: wp.y, startWX: wp.x, startWY: wp.y };
      // Hold-to-build / spray: re-stamp the current cursor footprint on a timer. Each tick is
      // its own edit (own undo step), like an airbrush.
      accumFiredRef.current = false;
      accumBusyRef.current = false;
      if (accumTimerRef.current !== null) { clearInterval(accumTimerRef.current); accumTimerRef.current = null; }
      const wantTimer = toolRef.current === "spray"
        || (isSculpt && cfg?.sculptAccumulate && toolRef.current !== "flatten");
      if (wantTimer) {
        const anchor: [number, number] = [wp.x, wp.y];
        const timerTool = toolRef.current;
        accumTimerRef.current = window.setInterval(() => {
          const cur = cursorPosRef.current;
          const c = drawConfigRef.current;
          if (!cur || !c || !onDrawStrokeRef.current || accumBusyRef.current) return;
          const fp = stampFootprint(cur, timerTool, c);
          if (fp.length === 0) return;
          accumFiredRef.current = true;
          accumBusyRef.current = true;
          Promise.resolve(onDrawStrokeRef.current(fp.map(p => [p.x, p.y]), drawZOverrideRef.current, anchor))
            .finally(() => { accumBusyRef.current = false; });
        }, 140);
      }
      draw();
    } else if (toolRef.current === "fill") {
      // Fill fires on pointer-up; nothing to drag. Start a minimal stroke so pointer-up fires it.
      const wp = screenToWorld(e.clientX, e.clientY);
      const pts = new Set<string>([`${wp.x},${wp.y}`]);
      dragRef.current = { kind: "draw-stroke", pts, lastWX: wp.x, lastWY: wp.y, startWX: wp.x, startWY: wp.y };
      draw();
    } else if (isShapeTool(toolRef.current)) {
      const wp = screenToWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "draw-shape", tool: toolRef.current as "rect" | "ellipse" | "line", start: wp, end: wp };
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
      scheduleEnsureTiles(); // includes draw(); rAF-coalesced, see scheduleEnsureTiles
    } else {
      if (drag?.kind === "resizeEdge") {
        switch (drag.edge) {
          case "x1": drag.live.x1 = Math.min(wp.x, drag.live.x2); break;
          case "x2": drag.live.x2 = Math.max(wp.x, drag.live.x1); break;
          case "y1": drag.live.y1 = Math.min(wp.y, drag.live.y2); break;
          case "y2": drag.live.y2 = Math.max(wp.y, drag.live.y1); break;
        }
      } else if (drag?.kind === "sculpt-grab") {
        // Up-drag raises, down-drag lowers. 1 block per ~6 screen px, scaled by zoom.
        const pxPerBlock = Math.max(3, viewRef.current.scale * 0.9);
        drag.delta = Math.round((drag.downClientY - e.clientY) / pxPerBlock);
      } else if (drag?.kind === "draw-stroke") {
        const cfg = drawConfigRef.current;
        // While a hold-to-build / spray timer is running, don't grow the swept set (the timer
        // stamps the cursor instead); just track position for the ghost.
        if (accumTimerRef.current !== null) { drag.lastWX = wp.x; drag.lastWY = wp.y; scheduleDraw(); return; }
        // Stroke stabilizer: the stamp follows a low-passed position that lags the cursor,
        // filtering out hand jitter. Higher lag = smoother. Freehand tools only.
        let target = wp;
        if (cfg?.strokeStabilizer && isFreehand(toolRef.current) && smoothPosRef.current) {
          const s = smoothPosRef.current;
          s.x += (wp.x - s.x) * 0.35;
          s.y += (wp.y - s.y) * 0.35;
          target = { x: Math.round(s.x), y: Math.round(s.y) };
        }
        const line = bresenhamLine({ x: drag.lastWX, y: drag.lastWY }, target);
        for (const lp of line) {
          const footprint = toolRef.current === "fill" ? [lp] : stampFootprint(lp, toolRef.current, cfg);
          for (const p of footprint) drag.pts.add(`${p.x},${p.y}`);
        }
        drag.lastWX = target.x;
        drag.lastWY = target.y;
      } else if (drag?.kind === "draw-shape") {
        drag.end = wp;
      } else if (drag?.kind === "select") {
        drag.end = wp;
        onSelectDragUpdateRef.current?.({
          x1: Math.min(drag.start.x, wp.x), y1: Math.min(drag.start.y, wp.y),
          x2: Math.max(drag.start.x, wp.x), y2: Math.max(drag.start.y, wp.y),
        });
      } else if (drag?.kind === "moveSel") {
        drag.dx = Math.round(wp.x - drag.start.x);
        drag.dy = Math.round(wp.y - drag.start.y);
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
      scheduleDraw();
    }
  }, [scheduleDraw, scheduleEnsureTiles, screenToWorld]);

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
      onSelectDragUpdateRef.current?.(null);
      onSelChangeRef.current({
        x1: Math.min(drag.start.x, end.x),
        y1: Math.min(drag.start.y, end.y),
        x2: Math.max(drag.start.x, end.x),
        y2: Math.max(drag.start.y, end.y),
      });
      draw();
      return;
    }
    if (drag?.kind === "moveSel") {
      dragRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "crosshair";
      if (drag.dx !== 0 || drag.dy !== 0) {
        onMoveSelectionRef.current?.(drag.dx, drag.dy);
      }
      draw();
      return;
    }
    if (drag?.kind === "sculpt-grab") {
      dragRef.current = null;
      draw();
      if (drag.delta !== 0 && onDrawStrokeRef.current) {
        const pts = Array.from(drag.pts).map(k => {
          const ci = k.indexOf(",");
          return [parseInt(k.slice(0, ci)), parseInt(k.slice(ci + 1))] as [number, number];
        });
        onDrawStrokeRef.current(pts, drawZOverrideRef.current, [drag.cx, drag.cy], drag.delta);
      }
      return;
    }
    if (drag?.kind === "draw-stroke") {
      dragRef.current = null;
      // End any hold-to-build timer. If it fired at least once, the ticks already applied
      // the edits — don't also fire the accumulated one-shot stroke.
      const fired = accumFiredRef.current;
      if (accumTimerRef.current !== null) { clearInterval(accumTimerRef.current); accumTimerRef.current = null; }
      accumFiredRef.current = false;
      // Stabilizer flush: the stamp lagged the cursor, so extend the stroke to the release
      // point so it reaches where the user let go.
      const cfg = drawConfigRef.current;
      if (!fired && cfg?.strokeStabilizer && isFreehand(toolRef.current)) {
        const end = screenToWorld(e.clientX, e.clientY);
        for (const lp of bresenhamLine({ x: drag.lastWX, y: drag.lastWY }, end)) {
          for (const p of stampFootprint(lp, toolRef.current, cfg)) drag.pts.add(`${p.x},${p.y}`);
        }
      }
      draw();
      if (!fired && drag.pts.size > 0 && onDrawStrokeRef.current) {
        const pts = Array.from(drag.pts).map(k => {
          const ci = k.indexOf(",");
          return [parseInt(k.slice(0, ci)), parseInt(k.slice(ci + 1))] as [number, number];
        });
        onDrawStrokeRef.current(pts, drawZOverrideRef.current, [drag.startWX, drag.startWY]);
      }
      return;
    }
    if (drag?.kind === "draw-shape") {
      const end = screenToWorld(e.clientX, e.clientY);
      dragRef.current = null;
      draw();
      const cfg = drawConfigRef.current;
      if (onDrawStrokeRef.current && cfg) {
        const pts = drag.tool === "rect" ? rectPixels(drag.start, end, cfg.fillMode)
          : drag.tool === "line" ? linePixels(drag.start, end, cfg.brushSize, cfg.brushShape)
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
    const lp = toLocal(e.clientX, e.clientY);
    viewRef.current = zoomAtPoint(viewRef.current, lp.x, lp.y, e.deltaY, { min: 0.25, max: 32, factor: 1.1 });
    scheduleEnsureTiles(); // in full mode: just draw(); in tiled mode: loads new tiles; rAF-coalesced
  }, [scheduleEnsureTiles, toLocal]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block", width: "100%", height: "100%", cursor: tool === "pan" ? "grab" : tool === "eyedropper" ? "cell" : "crosshair" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={() => { if (toolRef.current === "polygon") commitPolygon(); }}
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
