import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { invoke } from "@tauri-apps/api/core";
import { brushFootprint, bresenhamLine, linePixels, polygonPixels, rectPixels, ellipsePixels, type WP, type BrushShape, type FillMode } from "./drawTools";
import { type WorldMeta, type PixelPatch, decodePixelPatch } from "./types";
import { zoomAtPoint, resizeCanvasToContainer, makeSeqGuard, putPatchPixels, beginFrame, cssWidth, cssHeight, isTypingTarget, chunkToWorld, worldToChunk, CHUNK_SIZE_BLOCKS } from "./viewportUtils";
import { maskOutline, type OutlinePt } from "./maskUtils";

export type { PixelPatch } from "./types";

export type Tool = "pan" | "select" | "wand" | "lasso" | "polyselect" | "paste" | "pen" | "brush" | "spray" | "line" | "rect" | "ellipse" | "polygon" | "smooth" | "noise" | "flatten" | "erode" | "thermal" | "hydro" | "stamp" | "grab" | "raise" | "lower" | "terrace" | "sharpen" | "slope" | "smear" | "rock" | "carve" | "fill" | "eyedropper" | "poolfill" | "materialize";

/** Ceiling on chunks per materialize operation — mirrors `MAX_MATERIALIZE_CHUNKS` in lib.rs. Used
 *  both to bound the materialize-select tool's loosened drag clamp and by the confirm-dialog copy. */
export const MAX_MATERIALIZE_CHUNKS = 16_384;

/**
 * Display name per tool — the single source of truth for the status bar and any other caption.
 * A `Record<Tool, …>` (not a ternary chain) so adding a Tool is a compile error until it's named.
 */
export const TOOL_LABELS: Record<Tool, string> = {
  pan: "Pan", select: "Select", wand: "Wand", lasso: "Lasso", polyselect: "Polygon Select", paste: "Paste",
  pen: "Pen", brush: "Brush", spray: "Spray", line: "Line",
  rect: "Rect", ellipse: "Ellipse", polygon: "Polygon",
  smooth: "Smooth", noise: "Noise", flatten: "Flatten", erode: "Erode",
  thermal: "Thermal", hydro: "Hydro Erode", stamp: "Retexture", grab: "Grab",
  raise: "Raise", lower: "Lower", terrace: "Terrace", sharpen: "Sharpen",
  slope: "Slope", smear: "Smear", rock: "Rock", carve: "Carve", fill: "Fill", eyedropper: "Eyedropper",
  poolfill: "Pool Fill", materialize: "Materialize",
};

/**
 * One-line "how do I use this" caption per tool, shown in the status bar (App.tsx). Only tools whose
 * core gesture isn't obvious from clicking around get an entry — Pen and Brush don't need telling.
 * Lives next to TOOL_LABELS so a new Tool's hint is written where its name is.
 */
export const TOOL_HINTS: Partial<Record<Tool, string>> = {
  polygon: "Click to add points · click the first point (or double-click) to close · Esc cancels",
  lasso: "Drag to trace a freeform selection · release to close · Esc cancels",
  polyselect: "Click to add points · click the first point (or double-click) to close · Esc cancels",
  grab: "Press on the terrain and drag up / down to raise or lower it",
  wand: "Click a block to flood-select everything matching it on the surface",
  eyedropper: "Click a block to make it the active block",
  line: "Drag from one point to another",
  rect: "Drag to size the rectangle",
  ellipse: "Drag to size the ellipse",
  flatten: "The first block you press on sets the height everything else is levelled to",
  slope: "The first block you press on anchors the tilted plane (set Slope X/Y in the Falloff group)",
  smear: "Drag across terrain to pull height along with the brush, like wet paint",
  poolfill: "Click an empty (air) floor cell inside the selection to bucket-fill the basin",
  materialize: "Drag to select ungenerated chunk space — holes inside the map or growth beyond its edge — then Materialize to write it as real terrain",
  rock: "Click to place a rock mass fused into the terrain — ignores Strength/Softness, tune it in the Rock group",
  carve: "Click to cut a filleted depression into the terrain — ignores Strength/Softness, tune it in the Rock group",
};

/**
 * Idle cursor per tool. Most drawing/sculpt tools share "crosshair" (precision matters more than
 * a distinct glyph there), but a few have a genuinely different gesture and get their own cursor:
 * pan grabs the map, paste stamps a copy, wand/eyedropper pick a specific block, grab drags
 * vertically. Selection-edge/move-hover cursors are still computed live in draw() (they depend on
 * where over the selection the pointer is, not just the armed tool).
 */
export const TOOL_CURSOR: Record<Tool, string> = {
  pan: "grab", paste: "copy", wand: "cell", lasso: "crosshair", polyselect: "crosshair", eyedropper: "cell", grab: "ns-resize",
  select: "crosshair", pen: "crosshair", brush: "crosshair", spray: "crosshair",
  line: "crosshair", rect: "crosshair", ellipse: "crosshair", polygon: "crosshair",
  smooth: "crosshair", noise: "crosshair", flatten: "crosshair", erode: "crosshair",
  thermal: "crosshair", hydro: "crosshair", stamp: "crosshair",
  raise: "crosshair", lower: "crosshair", terrace: "crosshair", sharpen: "crosshair",
  slope: "crosshair", smear: "crosshair", rock: "crosshair", carve: "crosshair", fill: "crosshair", poolfill: "cell",
  materialize: "crosshair",
};

/** Sculpt tools that paint a swept disc footprint (everything except the drag-controlled "grab"). */
const SCULPT_STROKE_TOOLS: readonly Tool[] = ["smooth", "noise", "flatten", "erode", "thermal", "hydro", "stamp", "raise", "lower", "terrace", "sharpen", "slope", "smear", "rock", "carve"];
const isSculptStroke = (t: Tool): boolean => SCULPT_STROKE_TOOLS.includes(t);

export interface DrawConfig {
  brushSize: number;
  brushShape: BrushShape;
  fillMode: FillMode;
  sculptRadius: number;
  sculptSoftness: number;    // 0 = hard edge, 1 = full radial dome — mirrors the Rust falloff
  sculptProfile: "smooth" | "linear" | "sphere" | "sharp";
  sculptAccumulate: boolean;
  sprayDensity: number;      // 0..1 — fraction of footprint cells placed per spray stamp
  strokeStabilizer: boolean; // low-pass the freehand pointer path (Photoshop-style)
}

/** Mirrors `falloff_dome` in lib.rs — same four profile curves on normalised depth `t` (0=rim, 1=core). */
function falloffDome(t: number, profile: DrawConfig["sculptProfile"]): number {
  t = Math.max(0, Math.min(1, t));
  switch (profile) {
    case "linear": return t;
    case "sphere": return Math.sqrt(t * (2 - t));
    case "sharp":  return t * t;
    default:       return t * t * (3 - 2 * t); // "smooth"
  }
}

/** Per-cell brush weight at radial distance `d` from the stamp centre — mirrors the Rust per-stamp
 *  falloff so the cursor preview matches what a stamp will actually do. */
function sculptWeightAt(d: number, radius: number, softness: number, profile: DrawConfig["sculptProfile"]): number {
  if (softness <= 0) return 1;
  const dome = falloffDome(1 - d / Math.max(1, radius), profile);
  return Math.max(0, Math.min(1, (1 - softness) + dome * softness));
}

/** Output pixels per tile side. A tile always renders TILE×TILE pixels; at LOD `n` it *covers*
 *  `TILE * n` world blocks per side, so the visible tile count stays roughly constant at any zoom
 *  instead of exploding when the whole world is on screen (audit H6). */
const TILE = 512;

/** Number of extra tile rows/cols to prefetch beyond the visible viewport edge. */
const TILE_BUFFER = 1;

/** Maximum simultaneous in-flight tile fetches. Prevents IPC channel saturation. */
const MAX_CONCURRENT = 4;

/** Coarsest level of detail the backend will honour — must match `MAX_LOD` in lib.rs. */
const MAX_LOD = 32;

/** Floor for the tile caches' bounded LRU, in tiles (a full tile is TILE² RGBA ≈ 1 MB). Retaining
 *  more than the visible window is the point: pan-back and zoom-back hit the cache instead of
 *  re-fetching tiles that were discarded a frame earlier. `ensureTiles` raises the live limit to
 *  `2 × the visible window` when that's larger (a 4K viewport can need ~100 tiles on its own, and
 *  a limit below the visible count would evict tiles the very frame they're fetched). */
const TILE_CACHE_LIMIT = 96;
const TEMPLATE_CACHE_LIMIT = 48;

/** Bytes per cached tile canvas (RGBA, TILE×TILE). */
const TILE_BYTES = TILE * TILE * 4;

/** Default combined tile+template cache budget — the "Balanced" memory-budget preset (§6). Split
 *  ⅔ base / ⅓ template below, matching the historical 96/48-tile ratio. */
const DEFAULT_TILE_BUDGET_BYTES = 256 * 1024 * 1024;

/** World blocks per rendered pixel for a given zoom: the largest power of two that still maps a
 *  rendered pixel to at most one screen pixel, so LOD never *upscales* (which would look blurrier
 *  than today). scale ≥ 1 → 1 (untouched full-resolution behaviour); scale 0.5 → 2; 0.1 → 8. */
function lodForScale(scale: number): number {
  if (!(scale > 0) || scale >= 1) return 1;
  const lod = 2 ** Math.floor(Math.log2(1 / scale));
  return Math.max(1, Math.min(MAX_LOD, lod));
}

/** Tile cache key. LOD is part of the key so levels coexist in the cache and a zoom change reuses
 *  whatever it already has (and can draw a coarser level underneath while the new one streams in). */
function tileKey(lod: number, tx: number, ty: number): string { return `${lod},${tx},${ty}`; }

/** Inverse of `tileKey` — also yields the tile's world-space origin (`wx`,`wy`) and side span. */
function parseTileKey(key: string): { lod: number; tx: number; ty: number; wx: number; wy: number; span: number } {
  const [lod, tx, ty] = key.split(",").map(Number);
  const span = TILE * lod;
  return { lod, tx, ty, wx: tx * span, wy: ty * span, span };
}

/** Move `key` to the most-recently-used end of an insertion-ordered Map (JS Maps iterate in
 *  insertion order, so delete+set is the whole LRU bookkeeping). No-op if absent. */
function touchTile(cache: Map<string, HTMLCanvasElement>, key: string): void {
  const v = cache.get(key);
  if (v !== undefined) { cache.delete(key); cache.set(key, v); }
}

/** Zero a canvas's backing store before dropping it — setting `width`/`height` releases the pixel
 *  buffer immediately instead of waiting on GC, which otherwise leaves the 1 MiB/tile backing
 *  store resident until whenever the collector gets to it (§2 of the 2026-08 memory-efficiency
 *  pass — a bounded cache count is not a bounded *retained-heap* guarantee without this). */
function freeTileCanvas(c: HTMLCanvasElement): void {
  c.width = 0;
  c.height = 0;
}

/** Drop least-recently-used entries until the cache is within `limit`, freeing each evicted
 *  canvas's backing store immediately (see `freeTileCanvas`). */
function evictTiles(cache: Map<string, HTMLCanvasElement>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const c = cache.get(oldest.value);
    if (c) freeTileCanvas(c);
    cache.delete(oldest.value);
  }
}

/** Wholesale-clear a tile cache, freeing every canvas's backing store first (see `freeTileCanvas`). */
function clearTiles(cache: Map<string, HTMLCanvasElement>): void {
  for (const c of cache.values()) freeTileCanvas(c);
  cache.clear();
}

/** Bound on `materializeOccupancyRef` (§2): one entry per queried chunk, cleared only on world
 *  change — panning the materialize-select overlay across a huge world could otherwise grow it
 *  without limit. Insertion-order eviction, same idiom as the tile caches. */
const MATERIALIZE_OCCUPANCY_LIMIT = 65536;

/** Drop oldest entries from a JS `Map` (insertion order) until it's within `limit`. */
function evictOldestEntries<K, V>(cache: Map<K, V>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Zoom bounds, shared by the wheel handler and the keyboard zoom (zoomBy/zoomToBox). */
const MIN_SCALE = 0.25;
const MAX_SCALE = 32;

/** Scale at which the whole `mW × mH` map fits inside a `cw × ch` viewport, with a small margin. */
function fitScale(cw: number, ch: number, mW: number, mH: number, margin = 0.9): number {
  return Math.min(MAX_SCALE, Math.min(cw / Math.max(1, mW), ch / Math.max(1, mH)) * margin);
}

/** Effective lower zoom bound: `MIN_SCALE`, but never *above* the scale that fits the whole world.
 *  Clamping up to a flat 0.25 is what made "fit the map" silently stop fitting on a world whose
 *  bbox needs a smaller scale than that — it centred on the bbox's geometric middle at a zoom far
 *  too tight to ever include the terrain, i.e. a blank map with no obvious way back out. */
function minScaleFor(cw: number, ch: number, mW: number, mH: number): number {
  return Math.min(MIN_SCALE, fitScale(cw, ch, mW, mH));
}

/** Floor for the *initial* on-load view scale — see the worldEpoch effect below. Keeps a world with
 *  a huge nominal bbox from defaulting to a whole-map view that loads every visible tile at once. */
const DEFAULT_LOAD_MIN_SCALE = 0.5;
/** Per-step zoom factor for ⌘+ / ⌘− (coarser than the wheel's 1.1, which fires many times a drag). */
export const KEY_ZOOM_STEP = 1.25;

export interface MapCanvasRef {
  /** Write top-down pixel patch directly into the affected tiles/canvas (top-down mode edit). */
  applyPatch: (patch: PixelPatch) => void;
  /** Invalidate tiles overlapping (x1,y1)-(x2,y2) and re-fetch them (z-slice mode edit). */
  refetchRegion: (x1: number, y1: number, x2: number, y2: number) => void;
  /** Zoom-to-fit: scale + center the view so the entire world fits in the viewport. */
  resetView: () => void;
  /** Zoom by a multiplicative factor about the viewport centre (keyboard zoom: ⌘+ / ⌘−). */
  zoomBy: (factor: number) => void;
  /** Scale + centre the view on a world-space box, with a little margin (⌘⇧Z… "zoom to selection"). */
  zoomToBox: (x1: number, y1: number, x2: number, y2: number) => void;
  /** Recentre the view on a world-space point, keeping the current zoom level ("Center Map on 3D Camera"). */
  centerOn: (wx: number, wy: number) => void;
}

interface WorldPoint { x: number; y: number }

type DragOp =
  | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number }
  | { kind: "select"; start: WorldPoint; end: WorldPoint }
  | { kind: "resizeEdge"; edge: ResizeEdge; live: SelectionBounds }
  | { kind: "moveSel"; origin: SelectionBounds; start: WorldPoint; dx: number; dy: number; ghost: HTMLCanvasElement | null }
  | { kind: "draw-stroke"; pts: Set<string>; lastWX: number; lastWY: number; startWX: number; startWY: number; live?: boolean }
  | { kind: "sculpt-grab"; pts: Set<string>; cx: number; cy: number; downClientY: number; delta: number }
  | { kind: "draw-shape"; tool: "rect" | "ellipse" | "line"; start: WP; end: WP }
  | { kind: "lasso"; pts: WP[] }
  | { kind: "cam3d-drag" }
  | { kind: "materialize-select"; start: WorldPoint; end: WorldPoint }
  | null;

const EDGE_HIT_PX = 6;

/** CSS cursor for a resize edge/corner hit-test result. */
function resizeCursor(edge: ResizeEdge): string {
  if (edge === "x1y1" || edge === "x2y2") return "nwse-resize";
  if (edge === "x1y2" || edge === "x2y1") return "nesw-resize";
  return edge === "x1" || edge === "x2" ? "ew-resize" : "ns-resize";
}
// Always-drawn resize grips on the selection edges (see the selection overlay in draw()). Sized to
// read as a grabbable handle at a glance — a thinner bar was technically visible but still easy to
// miss, which defeats the point of drawing it at rest at all.
const GRIP_LEN = 20;
const GRIP_W   = 6;

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

type ResizeEdge = "x1" | "x2" | "y1" | "y2" | "x1y1" | "x1y2" | "x2y1" | "x2y2";

function hitTestEdge(
  sx: number, sy: number,
  sel: SelectionBounds,
  view: { x: number; y: number; scale: number },
): ResizeEdge | null {
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
  // Corners take priority over plain edges — near a corner should resize both axes at once.
  if (nearL && nearT) return "x1y1";
  if (nearL && nearB) return "x1y2";
  if (nearR && nearT) return "x2y1";
  if (nearR && nearB) return "x2y2";
  if (nearL && inY) return "x1";
  if (nearR && inY) return "x2";
  if (nearT && inX) return "y1";
  if (nearB && inX) return "y2";
  return null;
}

export interface SelectionBounds {
  x1: number; y1: number; x2: number; y2: number;
}

/** Chunk-coordinate rect selected by the materialize tool, in **absolute** chunk coordinates — the
 *  same space the backend's `chunk_map` is keyed by (a real Eden world sits near 4050,4150), NOT
 *  local 0-based chunk indices. It may extend outside the current bbox, i.e. below `abs_min_x/y` or
 *  past `abs_min_x + width_chunks` (that's the whole point: it addresses ungenerated space). */
export interface MaterializeSelectionBounds {
  cx1: number; cy1: number; cx2: number; cy2: number;
}

interface Props {
  world: WorldMeta;
  worldEpoch: number;
  tool: Tool;
  viewMode: "topdown" | "zslice";
  zSliceZ: number;
  /** Cutaway cap currently applied in the backend, or null. Not used for drawing — `fetch_tile`
   *  already renders capped — it's purely a cache-invalidation key: when it changes, every tile
   *  must be refetched. App only advances it once `set_view_cap` has resolved. */
  viewCapZ?: number | null;
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
  /** Called when a draw stroke or shape is committed with the list of world positions, the z override (null = surface), the pointer-down anchor column (sculpt tools), (grab tool) the drag-controlled vertical delta in blocks, a group id coalescing one stroke's stamps into one undo entry, and (smear tool) the per-tick drag delta in blocks to pull height from. */
  onDrawStroke?: (pts: [number, number][], zOverride: number | null, anchor?: [number, number], grabDelta?: number, groupId?: number, smear?: [number, number]) => void | Promise<void>;
  /** Live-brush sculpt (Row 6): a batch of stamp centres for one flush, the stamp radius, the stroke's
   *  group id, and the anchor column captured at pointer-down (used by flatten/slope). Fired repeatedly
   *  during a live stroke; the backend applies the centres sequentially into one grouped undo entry. */
  onSculptStroke?: (stampCenters: [number, number][], stampRadius: number, groupId: number, anchor: [number, number]) => void | Promise<void>;
  /** Escape mid-stroke: revert the whole live sculpt stroke. MapCanvas awaits any in-flight flush first,
   *  then calls this exactly once so App's undo path (with its depth/toast plumbing) stays authoritative. */
  onCancelStroke?: () => void | Promise<void>;
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
  /** Called when a lasso drag is released, with the ordered world-space path. */
  onLassoSelect?: (pts: [number, number][]) => void;
  /** Called when a click-vertex polygon selection is closed, with the ordered world-space path. */
  onPolySelect?: (pts: [number, number][]) => void;
  /** Active shaped-selection footprint (wand/lasso), decoded from get_selection_mask. When its bbox
   *  matches the committed selection exactly, the selection overlay fills only the set cells instead
   *  of the whole box. */
  selectionMask?: { x1: number; y1: number; x2: number; y2: number; bits: Uint8Array } | null;
  /** Spawn/home position in editor pixel coords — drawn as a marker on the map. */
  spawnPos?: { px: number; py: number } | null;
  /** Creature list from get_creatures() — drawn as coloured dots when non-empty. */
  creatures?: { type_id: number; color: number; x: number; y: number }[];
  /** Elevation offset applied to paste (shown as label above ghost rect). */
  pasteElevationOffset?: number;
  /** Called when eyedropper tool clicks a world coordinate. */
  onEyedropper?: (wx: number, wy: number) => void;
  /** Called when the Pool Fill tool clicks a world coordinate (the basin floor cell). */
  onPoolFillPick?: (wx: number, wy: number) => void;
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
  /** Committed materialize-select rect (chunk coordinates), or null. Mirrors `committedSelection`. */
  committedMaterializeSelection?: MaterializeSelectionBounds | null;
  /** Called when a materialize-select drag commits (or is cleared) with the chunk-coordinate rect. */
  onMaterializeSelectionChange?: (bounds: MaterializeSelectionBounds | null) => void;
  /** Total byte budget for the tile + template tile caches combined (memory-budget preset, §2/§6
   *  of the 2026-08 memory-efficiency pass). Split ⅔ base / ⅓ template, matching the historical
   *  96/48-tile ratio. Defaults to the "Balanced" preset. */
  tileBudgetBytes?: number;
}

type TileJob = { key: string; lod: number; x1: number; y1: number; x2: number; y2: number };

const MapCanvas = forwardRef<MapCanvasRef, Props>(function MapCanvas(
  { world, worldEpoch, tool, viewMode, zSliceZ, viewCapZ = null,
    committedSelection, onSelectionChange, pastePreview, clipboardPreviewPixels, onPasteAt,
    renderMode, axoSkew = 0.2, lockedPastePos = null,
    drawConfig, onDrawStroke, onSculptStroke, onCancelStroke, drawZOverride = null,
    extrudePreview = null, lastPasteDelta = null, onCursorMove, onMagicWand, onLassoSelect, onPolySelect, selectionMask = null,
    spawnPos = null, creatures = [],
    pasteElevationOffset = 0, onEyedropper, onPoolFillPick, sliceLines = null,
    cameraPos3d = null, onSetCamera3d,
    showTemplateOverlay = false, onMapContextMenu, onSelectDragUpdate, onMoveSelection, moveWithContents = false,
    committedMaterializeSelection = null, onMaterializeSelectionChange,
    tileBudgetBytes = DEFAULT_TILE_BUDGET_BYTES }: Props,
  ref,
) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const viewRef    = useRef({ x: 0, y: 0, scale: 2 });
  const clipboardImgRef = useRef<HTMLCanvasElement | null>(null);

  // Tile state (used in "tiled" mode)
  const tileCacheRef  = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const templateTileCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const pendingRef    = useRef<Set<string>>(new Set());
  // Live LRU caps, recomputed by ensureTiles from the current visible tile count (see TILE_CACHE_LIMIT).
  const tileLimitRef  = useRef(TILE_CACHE_LIMIT);
  const templateLimitRef = useRef(TEMPLATE_CACHE_LIMIT);
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
  // Set true whenever a gesture's pointerdown actually landed on this canvas. Guards the
  // paste-on-pointerup branch below: without it, a gesture that started on other chrome (e.g. a
  // slider) and was released by dragging over the canvas would fire an accidental paste, since a
  // native pointerup with no capture set targets whatever's under the cursor at release.
  const pointerDownOnCanvasRef = useRef(false);
  // Hold-to-build: interval id while a sculpt stroke re-stamps the cursor; flag = a tick fired
  // (so pointer-up skips the final one-shot stroke to avoid a double application).
  const accumTimerRef = useRef<number | null>(null);
  const accumFiredRef = useRef(false);
  const accumBusyRef = useRef(false); // a tick's async edit is still in flight — skip overlaps
  // Live-brush sculpt (Row 6): stamp centres queued since the last flush, the last centre we emitted
  // (spacing origin), the fractional distance carried between pointer-move segments, the anchor column
  // captured at pointer-down (flatten/slope), and the cancel/settle plumbing for Escape mid-stroke.
  const pendingStampsRef = useRef<[number, number][]>([]);
  const lastStampPosRef = useRef<WP | null>(null);
  const stampDistAccumRef = useRef(0);
  const strokeAnchorRef = useRef<[number, number]>([0, 0]);
  const strokeCancelledRef = useRef(false);
  const sculptFlushPromiseRef = useRef<Promise<void> | null>(null);
  // Smear: forced-timer sculpt tool with no swept-path meaning of its own — each tick needs the
  // drag delta *since the previous tick*, not since stroke-start, so it advects continuously
  // rather than jumping the full drag distance in one commit.
  const smearLastPosRef = useRef<WP | null>(null);
  // Polygon tool: click-accumulated vertices (committed on click-near-start / double-click).
  const polyVertsRef = useRef<WP[]>([]);
  // Stroke stabilizer: fractional low-passed pointer position that the freehand stamp follows.
  const smoothPosRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => () => { if (accumTimerRef.current !== null) clearInterval(accumTimerRef.current); }, []);
  useEffect(() => () => { if (materializeFetchTimerRef.current !== null) window.clearTimeout(materializeFetchTimerRef.current); }, []);

  // Stable refs for values read inside callbacks (avoids re-registering handlers)
  const toolRef         = useRef<Tool>(tool);
  const viewModeRef     = useRef(viewMode);
  const zSliceZRef      = useRef(zSliceZ);
  const committedSelRef = useRef<SelectionBounds | null>(committedSelection);
  const selectionMaskRef = useRef(selectionMask);
  // Offscreen w×h bitmap (violet where a cell is set) + traced contour loops, cached by mask identity
  // so draw() just blits the fill and strokes the outline instead of recomputing them each frame.
  const maskCanvasCacheRef = useRef<{ mask: typeof selectionMask; canvas: HTMLCanvasElement; outline: OutlinePt[][] } | null>(null);
  // Which selection edge the cursor is currently over — lights up that edge's grip in draw().
  const hoverEdgeRef = useRef<ResizeEdge | null>(null);
  // Cursor is over the 3D camera dot — brightens its grab-ring and shows the drag caption.
  const camHoverRef = useRef(false);
  const pastePreviewRef = useRef(pastePreview);
  const pasteHoverRef   = useRef<WorldPoint | null>(null);
  const cursorPosRef    = useRef<WorldPoint | null>(null);
  const onSelChangeRef    = useRef(onSelectionChange);
  const onPasteAtRef      = useRef(onPasteAt);
  const lockedPastePosRef = useRef(lockedPastePos);
  const drawConfigRef     = useRef(drawConfig);
  const onDrawStrokeRef   = useRef(onDrawStroke);
  const onSculptStrokeRef = useRef(onSculptStroke);
  const onCancelStrokeRef = useRef(onCancelStroke);
  const drawZOverrideRef  = useRef(drawZOverride);
  const extrudePreviewRef = useRef(extrudePreview);
  const lastPasteDeltaRef = useRef(lastPasteDelta);
  const onCursorMoveRef   = useRef(onCursorMove);
  const onMapContextMenuRef = useRef(onMapContextMenu);
  const onMagicWandRef      = useRef(onMagicWand);
  const onLassoSelectRef    = useRef(onLassoSelect);
  const onPolySelectRef     = useRef(onPolySelect);
  const spawnPosRef         = useRef(spawnPos);
  const creaturesRef        = useRef(creatures);
  const sliceLinesRef       = useRef(sliceLines);
  const pasteElevOffsetRef  = useRef(pasteElevationOffset);
  const onEyedropperRef     = useRef(onEyedropper);
  const onPoolFillPickRef   = useRef(onPoolFillPick);
  const cameraPos3dRef      = useRef(cameraPos3d ?? null);
  const onSetCamera3dRef    = useRef(onSetCamera3d);
  const onSelectDragUpdateRef = useRef(onSelectDragUpdate);
  const onMoveSelectionRef = useRef(onMoveSelection);
  const moveWithContentsRef = useRef(moveWithContents);
  const committedMaterializeSelRef = useRef<MaterializeSelectionBounds | null>(committedMaterializeSelection);
  const onMaterializeSelectionChangeRef = useRef(onMaterializeSelectionChange);
  // "cx,cy" → occupied, populated by chunk_occupancy queries scoped to the active/committed
  // materialize-select rect (not the whole viewport — see the plan's scope note in draw()).
  const materializeOccupancyRef = useRef<Map<string, boolean>>(new Map());
  const materializeFetchTimerRef = useRef<number | null>(null);
  // Monotonic per-stroke id: bumped once at every stroke/gesture start (draw-stroke, sculpt-grab)
  // and threaded through every onDrawStroke call of that stroke (timer ticks + the final commit) so
  // grouped sculpt stamps coalesce into a single undo unit. See lib.rs's grouped-undo contract.
  const strokeIdRef = useRef(0);

  // Live-brush sculpt flush (Row 6): drain the queued stamp centres into a single batched
  // `onSculptStroke` call. Flush discipline is the proven `accumBusyRef` one — exactly one call in
  // flight; each carries every centre queued since the last flush, so a slow backend self-throttles
  // into fewer, bigger batches rather than a queue backlog. A stroke cancelled by Escape drops any
  // pending stamps and never re-drains. Held in a ref so it can self-reschedule from its own `finally`.
  const flushSculptRef = useRef<(strokeId: number) => void>(() => {});
  flushSculptRef.current = (strokeId: number) => {
    if (accumBusyRef.current || strokeCancelledRef.current) return;
    const cfg = drawConfigRef.current;
    const send = onSculptStrokeRef.current;
    if (!cfg || !send) return;
    const batch = pendingStampsRef.current;
    if (batch.length === 0) return;
    pendingStampsRef.current = [];
    accumBusyRef.current = true;
    accumFiredRef.current = true;
    const p = Promise.resolve(send(batch, cfg.sculptRadius, strokeId, strokeAnchorRef.current))
      .finally(() => {
        accumBusyRef.current = false;
        sculptFlushPromiseRef.current = null;
        // Drain anything queued while this call was in flight (unless the stroke was cancelled).
        if (!strokeCancelledRef.current && pendingStampsRef.current.length > 0) {
          flushSculptRef.current(strokeId);
        }
      });
    sculptFlushPromiseRef.current = p;
  };

  useEffect(() => {
    toolRef.current = tool;
    // Abandon any in-flight draw/sculpt/shape gesture when the active tool changes mid-drag
    // (Escape → pan, or a tool hotkey). Otherwise pointer-up would still commit the stroke under
    // the NEW tool — e.g. a cancelled sculpt stroke getting stamped as paint blocks by the pen/paint
    // branch of handleDrawStroke, which reads the current tool. No draw() call here (it isn't
    // declared yet); a tool change re-renders MapCanvas and the no-deps draw effect below repaints.
    const d = dragRef.current;
    if (d && (d.kind === "draw-stroke" || d.kind === "sculpt-grab" || d.kind === "draw-shape" || d.kind === "lasso")) {
      dragRef.current = null;
      if (accumTimerRef.current !== null) { clearInterval(accumTimerRef.current); accumTimerRef.current = null; }
      accumFiredRef.current = false;
      accumBusyRef.current = false;
      // A live sculpt stroke abandoned by a tool swap: block any queued flush and drop pending stamps.
      // The already-committed stamps stay (the stroke is simply ended early, like releasing the mouse).
      strokeCancelledRef.current = true;
      pendingStampsRef.current = [];
    }
    // Leaving the polygon/polyselect tool abandons an unclosed polygon.
    if (tool !== "polygon" && tool !== "polyselect") polyVertsRef.current = [];
  }, [tool]);
  useEffect(() => { onSelChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  useEffect(() => { onPasteAtRef.current   = onPasteAt; }, [onPasteAt]);
  useEffect(() => { lockedPastePosRef.current = lockedPastePos; }, [lockedPastePos]);
  useEffect(() => { drawConfigRef.current = drawConfig; }, [drawConfig]);
  useEffect(() => { onDrawStrokeRef.current = onDrawStroke; }, [onDrawStroke]);
  useEffect(() => { onSculptStrokeRef.current = onSculptStroke; }, [onSculptStroke]);
  useEffect(() => { onCancelStrokeRef.current = onCancelStroke; }, [onCancelStroke]);
  useEffect(() => { drawZOverrideRef.current = drawZOverride; }, [drawZOverride]);
  useEffect(() => { extrudePreviewRef.current = extrudePreview; }, [extrudePreview]);
  useEffect(() => { lastPasteDeltaRef.current = lastPasteDelta; }, [lastPasteDelta]);
  useEffect(() => { onCursorMoveRef.current = onCursorMove; }, [onCursorMove]);
  useEffect(() => { onMapContextMenuRef.current = onMapContextMenu; }, [onMapContextMenu]);
  useEffect(() => { onMagicWandRef.current     = onMagicWand;         }, [onMagicWand]);
  useEffect(() => { onLassoSelectRef.current   = onLassoSelect;       }, [onLassoSelect]);
  useEffect(() => { onPolySelectRef.current    = onPolySelect;        }, [onPolySelect]);
  useEffect(() => { selectionMaskRef.current   = selectionMask;       }, [selectionMask]);
  useEffect(() => { spawnPosRef.current        = spawnPos;            }, [spawnPos]);
  useEffect(() => { creaturesRef.current       = creatures;           }, [creatures]);
  useEffect(() => { sliceLinesRef.current      = sliceLines;           }, [sliceLines]);
  useEffect(() => { pasteElevOffsetRef.current = pasteElevationOffset; }, [pasteElevationOffset]);
  useEffect(() => { onEyedropperRef.current    = onEyedropper;        }, [onEyedropper]);
  useEffect(() => { onPoolFillPickRef.current  = onPoolFillPick;      }, [onPoolFillPick]);
  useEffect(() => { cameraPos3dRef.current     = cameraPos3d ?? null; }, [cameraPos3d]);
  useEffect(() => { onSetCamera3dRef.current   = onSetCamera3d;       }, [onSetCamera3d]);
  useEffect(() => { onSelectDragUpdateRef.current = onSelectDragUpdate; }, [onSelectDragUpdate]);
  useEffect(() => { onMoveSelectionRef.current = onMoveSelection; }, [onMoveSelection]);
  useEffect(() => { moveWithContentsRef.current = moveWithContents; }, [moveWithContents]);
  useEffect(() => { committedMaterializeSelRef.current = committedMaterializeSelection; }, [committedMaterializeSelection]);
  useEffect(() => { onMaterializeSelectionChangeRef.current = onMaterializeSelectionChange; }, [onMaterializeSelectionChange]);
  const showTemplateOverlayRef = useRef(showTemplateOverlay);
  // Keep ref in sync; cache clear + redraw happen in the post-draw effect below
  useEffect(() => { showTemplateOverlayRef.current = showTemplateOverlay; }, [showTemplateOverlay]);

  const mapW = chunkToWorld(world.width_chunks);
  const mapH = chunkToWorld(world.height_chunks);
  // Refs so draw/ensureTiles (stable callbacks with [] deps) can read current dimensions
  const mapWRef = useRef(mapW);
  const mapHRef = useRef(mapH);
  useEffect(() => { mapWRef.current = mapW; mapHRef.current = mapH; }, [mapW, mapH]);

  // Absolute chunk coordinate of world pixel (0,0). Every chunk index `worldToChunk()` derives from
  // a world-pixel coordinate is *local* — relative to the world's bbox origin — but the backend's
  // `chunk_map` (and therefore `chunk_occupancy` / `materialize_flat_chunks`) is keyed by absolute
  // chunk coordinates, which on a real Eden world sit around (4050, 4150), not (0, 0). Mixing the
  // two silently addresses a completely different region: it makes every occupancy probe report
  // "ungenerated", and makes materialize write its chunks thousands of chunks away from the world,
  // ballooning the reloaded world's bbox to ~4000×4200 chunks (blank 2D map + tile-fetch crawl).
  // `MaterializeSelectionBounds` is therefore defined in ABSOLUTE chunk coords, converted here.
  const absCx0Ref = useRef(world.abs_min_x);
  const absCy0Ref = useRef(world.abs_min_y);
  useEffect(() => {
    absCx0Ref.current = world.abs_min_x;
    absCy0Ref.current = world.abs_min_y;
  }, [world.abs_min_x, world.abs_min_y]);

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

  // Loosened clamp used only by the materialize-select tool — every other tool keeps the hard
  // [0, mapW-1] clamp above so it can never address negative/beyond-bounds coordinates. The margin
  // here is generous but bounded (independent of MAX_MATERIALIZE_CHUNKS, which caps the *area* the
  // user can actually commit — this just stops a stray drag from producing pathological coordinates).
  const MATERIALIZE_MARGIN_CHUNKS = 512;
  const screenToWorldLoose = useCallback((sx: number, sy: number): WorldPoint => {
    const { x, y, scale } = viewRef.current;
    const l = toLocal(sx, sy);
    const margin = MATERIALIZE_MARGIN_CHUNKS * CHUNK_SIZE_BLOCKS;
    return {
      x: Math.max(-margin, Math.min(mapW - 1 + margin, Math.floor((l.x - x) / scale))),
      y: Math.max(-margin, Math.min(mapH - 1 + margin, Math.floor((l.y - y) / scale))),
    };
  }, [mapW, mapH, toLocal]);


  // ── draw ──────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const { x: vx, y: vy, scale } = viewRef.current;

    // Base HiDPI transform: the backing store is dpr× the CSS box, so everything below draws in
    // CSS pixels against `cw`/`ch` (never canvas.width/height, which are device pixels).
    const { w: cw, h: ch } = beginFrame(ctx, canvas);

    ctx.fillStyle = "#1e1814";
    ctx.fillRect(0, 0, cw, ch);

    ctx.save();
    ctx.translate(vx, vy);
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = false;

    if (renderModeRef.current === "full" || renderModeRef.current === "axo") {
      const fc = fullCanvasRef.current;
      if (fc) ctx.drawImage(fc, 0, 0);
    } else {
      // The cache holds several LOD levels at once (audit H6), so a zoom change has something to
      // show immediately: draw the coarser levels first and let finer ones paint over them, with
      // the level this view actually wants (`curLod`) last. Off-screen tiles are skipped — the
      // cache is an LRU bounded well past the visible window, not the visible set.
      const curLod = lodForScale(scale);
      const visX1 = -vx / scale, visY1 = -vy / scale;
      const visX2 = (cw - vx) / scale, visY2 = (ch - vy) / scale;
      const drawLayer = (cache: Map<string, HTMLCanvasElement>) => {
        const entries: { tile: HTMLCanvasElement; wx: number; wy: number; lod: number; order: number }[] = [];
        for (const [key, tile] of cache) {
          const { lod, wx, wy } = parseTileKey(key);
          const w = tile.width * lod, h = tile.height * lod;
          if (wx >= visX2 || wy >= visY2 || wx + w <= visX1 || wy + h <= visY1) continue;
          entries.push({ tile, wx, wy, lod, order: lod === curLod ? Infinity : -lod });
        }
        entries.sort((a, b) => a.order - b.order);
        for (const e of entries) {
          ctx.drawImage(e.tile, e.wx, e.wy, e.tile.width * e.lod, e.tile.height * e.lod);
        }
      };
      // Draw template layer first at 35% opacity. User tile's transparent pixels (no chunk)
      // let the template show through; opaque user pixels naturally cover it.
      if (showTemplateOverlayRef.current && templateTileCacheRef.current.size > 0) {
        ctx.globalAlpha = 0.35;
        drawLayer(templateTileCacheRef.current);
        ctx.globalAlpha = 1.0;
      }
      drawLayer(tileCacheRef.current);
    }

    ctx.restore();

    // Progress bar while full-map or axo is loading (screen coords, outside world transform)
    const loadProgress = fullProgressRef.current;
    if ((renderModeRef.current === "full" || renderModeRef.current === "axo") && loadProgress !== null) {
      const cx = cw / 2;
      const cy = ch / 2;
      ctx.font = "13px monospace";
      ctx.fillStyle = "#afa69d";
      ctx.textAlign = "center";
      ctx.fillText("Loading full map…", cx, cy - 12);
      ctx.textAlign = "left";
      const barW = Math.min(300, cw * 0.5);
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
      // Shaped selection (wand/lasso): fill only the mask's set cells instead of the whole box, but
      // only while idle — the mask's bbox is frozen to the rect it was built for, so mid-drag states
      // (marquee/resize/move) would show a stale, misaligned footprint.
      const mask = !drag ? selectionMaskRef.current : null;
      const maskMatches = mask && mask.x1 === wx1 && mask.y1 === wy1 && mask.x2 === wx2 && mask.y2 === wy2;
      if (maskMatches && mask) {
        let cached = maskCanvasCacheRef.current;
        if (!cached || cached.mask !== mask) {
          const mw = mask.x2 - mask.x1 + 1, mh = mask.y2 - mask.y1 + 1;
          const off = document.createElement("canvas");
          off.width = mw; off.height = mh;
          const octx = off.getContext("2d")!;
          const img = octx.createImageData(mw, mh);
          for (let i = 0; i < mw * mh; i++) {
            const set = (mask.bits[i >> 3] >> (i & 7)) & 1;
            if (set) {
              img.data[i * 4] = 168; img.data[i * 4 + 1] = 85; img.data[i * 4 + 2] = 247; img.data[i * 4 + 3] = 110;
            }
          }
          octx.putImageData(img, 0, 0);
          cached = { mask, canvas: off, outline: maskOutline(mask) };
          maskCanvasCacheRef.current = cached;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cached.canvas, rx, ry, rw, rh);
        ctx.imageSmoothingEnabled = true;
        // Stroke the shape's actual contour (grid-corner loops → screen space) instead of the bbox
        // rectangle, so the outline hugs the wand/lasso footprint. Same white-underlay + blue idiom.
        const strokeOutline = (color: string, width: number) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          for (const loop of cached.outline) {
            for (let i = 0; i < loop.length; i++) {
              const sx = loop[i].x * scale + vx;
              const sy = loop[i].y * scale + vy;
              if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
            }
            ctx.closePath();
          }
          ctx.stroke();
        };
        strokeOutline("rgba(255, 255, 255, 0.9)", 2);
        strokeOutline("rgba(59, 130, 246, 1)", 1);
      } else {
        ctx.fillStyle   = "rgba(59, 130, 246, 0.18)";
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth   = 2;
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
        ctx.strokeStyle = "rgba(59, 130, 246, 1)";
        ctx.lineWidth   = 1;
        ctx.strokeRect(rx + 2.5, ry + 2.5, rw - 5, rh - 5);
      }

      // Resize grips. These used to exist only as a 6px hover hit-zone and a cursor change, so a
      // resizable selection looked exactly like a fixed one — nobody discovered the gesture. Drawn
      // always (dim), lit up on hover. Suppressed while dragging: the drag itself is the feedback,
      // and a marquee-in-progress has no edges to grab yet.
      const grip = dragRef.current?.kind === "select" ? null : hoverEdgeRef.current;
      const showGrips = !dragRef.current || dragRef.current.kind === "resizeEdge";
      if (showGrips && rw > 3 * GRIP_LEN && rh > 3 * GRIP_LEN) {
        const mx = rx + rw / 2, my = ry + rh / 2;
        const bars: [("x1"|"x2"|"y1"|"y2"), number, number, number, number][] = [
          ["x1", rx - GRIP_W / 2,  my - GRIP_LEN / 2, GRIP_W,   GRIP_LEN],
          ["x2", rx + rw - GRIP_W / 2, my - GRIP_LEN / 2, GRIP_W, GRIP_LEN],
          ["y1", mx - GRIP_LEN / 2, ry - GRIP_W / 2,  GRIP_LEN, GRIP_W],
          ["y2", mx - GRIP_LEN / 2, ry + rh - GRIP_W / 2, GRIP_LEN, GRIP_W],
        ];
        for (const [edge, gx, gy, gw, gh] of bars) {
          const on = grip === edge;
          // Dark drop-shadow behind the bar so it reads against sand/snow/cloud as well as grass —
          // a plain white bar disappeared on light terrain, which was half of why these were still
          // hard to spot even after they were drawn at rest.
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(gx - 1, gy - 1, gw + 2, gh + 2);
          ctx.fillStyle   = on ? "#ffffff" : "rgba(255,255,255,0.85)";
          ctx.strokeStyle = on ? "#60a5fa" : "rgba(37,99,235,0.95)";
          ctx.lineWidth   = 1;
          ctx.fillRect(gx, gy, gw, gh);
          ctx.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);
        }
        // Corner grips: a small square centred exactly on each corner, resizing both axes at once.
        const CS = 9;
        const corners: [ResizeEdge, number, number][] = [
          ["x1y1", rx, ry],
          ["x2y1", rx + rw, ry],
          ["x1y2", rx, ry + rh],
          ["x2y2", rx + rw, ry + rh],
        ];
        for (const [edge, cx, cy] of corners) {
          const on = grip === edge;
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(cx - CS / 2 - 1, cy - CS / 2 - 1, CS + 2, CS + 2);
          ctx.fillStyle   = on ? "#ffffff" : "rgba(255,255,255,0.85)";
          ctx.strokeStyle = on ? "#60a5fa" : "rgba(37,99,235,0.95)";
          ctx.lineWidth   = 1;
          ctx.fillRect(cx - CS / 2, cy - CS / 2, CS, CS);
          ctx.strokeRect(cx - CS / 2 + 0.5, cy - CS / 2 + 0.5, CS - 1, CS - 1);
        }
      }
    }

    // Materialize-select overlay: distinguishes occupied chunks (unshaded), in-bounds holes (amber
    // ghost fill, same tone family as the template overlay), and beyond-current-bbox growth space
    // (lighter dashed tint — trivially always unoccupied, no chunk_occupancy round trip needed for it).
    {
      const mdrag = dragRef.current;
      // Absolute chunk coords throughout (see absCx0Ref) — converted back to local for pixel math.
      const acx0 = absCx0Ref.current, acy0 = absCy0Ref.current;
      let mcx1 = 0, mcy1 = 0, mcx2 = 0, mcy2 = 0, hasMat = false;
      if (mdrag?.kind === "materialize-select") {
        mcx1 = worldToChunk(Math.min(mdrag.start.x, mdrag.end.x)) + acx0;
        mcy1 = worldToChunk(Math.min(mdrag.start.y, mdrag.end.y)) + acy0;
        mcx2 = worldToChunk(Math.max(mdrag.start.x, mdrag.end.x)) + acx0;
        mcy2 = worldToChunk(Math.max(mdrag.start.y, mdrag.end.y)) + acy0;
        hasMat = true;
      } else if (!mdrag && committedMaterializeSelRef.current) {
        ({ cx1: mcx1, cy1: mcy1, cx2: mcx2, cy2: mcy2 } = committedMaterializeSelRef.current);
        hasMat = true;
      }
      if (hasMat) {
        const nChunksM = (mcx2 - mcx1 + 1) * (mcy2 - mcy1 + 1);
        // From the refs, not `world.*` — draw() is a []-dep callback, so a captured `world` would
        // still be the world that was loaded when this canvas first mounted.
        const wChunks = worldToChunk(mapWRef.current), hChunks = worldToChunk(mapHRef.current);
        // Per-chunk tint is capped separately from MAX_MATERIALIZE_CHUNKS — it's a draw-cost guard
        // (one fillRect per chunk cell), not a correctness one; a selection past this still commits
        // fine, it just shows only the outline until narrowed.
        if (nChunksM <= 4096) {
          for (let cy = mcy1; cy <= mcy2; cy++) {
            for (let cx = mcx1; cx <= mcx2; cx++) {
              const lcx = cx - acx0, lcy = cy - acy0;
              const beyond = lcx < 0 || lcy < 0 || lcx >= wChunks || lcy >= hChunks;
              const wx = chunkToWorld(lcx), wy = chunkToWorld(lcy);
              const rx = Math.round(wx * scale + vx), ry = Math.round(wy * scale + vy);
              const rw = Math.round(CHUNK_SIZE_BLOCKS * scale), rh = Math.round(CHUNK_SIZE_BLOCKS * scale);
              if (beyond) {
                ctx.fillStyle = "rgba(96, 165, 250, 0.12)";
                ctx.fillRect(rx, ry, rw, rh);
                ctx.save();
                ctx.setLineDash([4, 3]);
                ctx.strokeStyle = "rgba(96, 165, 250, 0.5)";
                ctx.lineWidth = 1;
                ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
                ctx.restore();
              } else if (materializeOccupancyRef.current.get(`${cx},${cy}`) === false) {
                ctx.fillStyle = "rgba(217, 119, 6, 0.30)";
                ctx.fillRect(rx, ry, rw, rh);
              }
            }
          }
        }
        const rx = Math.round(chunkToWorld(mcx1 - acx0) * scale + vx);
        const ry = Math.round(chunkToWorld(mcy1 - acy0) * scale + vy);
        const rw = Math.round(chunkToWorld(mcx2 - mcx1 + 1) * scale);
        const rh = Math.round(chunkToWorld(mcy2 - mcy1 + 1) * scale);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 2;
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
        ctx.strokeStyle = "rgba(217, 119, 6, 1)";
        ctx.lineWidth = 1;
        ctx.strokeRect(rx + 2.5, ry + 2.5, rw - 5, rh - 5);
      }
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
        // The dot is draggable (it teleports the 3D camera), but nothing said so — the only cue was
        // a cursor change *after* you'd already hovered it. A dashed grab-ring at rest, plus a
        // caption once hovered.
        if (onSetCamera3dRef.current) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = camHoverRef.current ? "rgba(52,211,153,0.95)" : "rgba(52,211,153,0.45)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cpx, cpy, 12, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          if (camHoverRef.current) {
            ctx.font = "10px monospace";
            ctx.textBaseline = "middle";
            const label = "drag to move the 3D camera";
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.fillRect(cpx + 15, cpy - 8, tw + 8, 16);
            ctx.fillStyle = "#6ee7b7";
            ctx.fillText(label, cpx + 19, cpy + 0.5);
          }
        }
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
          ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, ch); ctx.stroke();
        }
        if (sl.y != null) {
          const sy = Math.round((sl.y + 0.5) * scale + vy) + 0.5;
          ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(cw, sy); ctx.stroke();
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
      if (drag?.kind === "draw-stroke" && !drag.live) {
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
        ctx.fillStyle = drag.delta > 0 ? "#fbbf24" : drag.delta < 0 ? "#60a5fa" : "#afa69d";
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
      } else if (drag?.kind === "lasso" && drag.pts.length > 0) {
        // Lasso-in-progress: freehand path traced so far, closed back to the start with a rubber band.
        const toS = (p: WP) => ({ x: Math.round(p.x * scale + vx) + gs / 2, y: Math.round(p.y * scale + vy) + gs / 2 });
        ctx.strokeStyle = "rgba(168,85,247,0.9)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const s0 = toS(drag.pts[0]);
        ctx.moveTo(s0.x, s0.y);
        for (let i = 1; i < drag.pts.length; i++) { const s = toS(drag.pts[i]); ctx.lineTo(s.x, s.y); }
        ctx.lineTo(s0.x, s0.y);
        ctx.stroke();
      } else if ((drawTool === "polygon" || drawTool === "polyselect") && polyVertsRef.current.length > 0) {
        // Polygon-in-progress: vertices + edges + rubber-band to cursor. Polyselect uses the same
        // violet as lasso/wand to read as a selection gesture, not a draw one.
        const verts = polyVertsRef.current;
        const toS = (p: WP) => ({ x: Math.round(p.x * scale + vx) + gs / 2, y: Math.round(p.y * scale + vy) + gs / 2 });
        ctx.strokeStyle = drawTool === "polyselect" ? "rgba(168,85,247,0.9)" : "rgba(56,189,248,0.9)";
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
      } else if ((!drag || (drag.kind === "draw-stroke" && drag.live)) && (isFreehand(drawTool) || drawTool === "grab" || isSculptStroke(drawTool) || drawTool === "fill") && cfg) {
        // Cursor preview when hovering (not dragging), and during a live sculpt stroke (the swept
        // ghost is suppressed there — the patch round-trip is the real feedback, this is just the brush).
        const pos = cursorPosRef.current;
        if (pos) {
          const isSculpt = drawTool === "grab" || isSculptStroke(drawTool);
          if (isSculpt) {
            // Falloff-aware brush preview: per-cell alpha from the same dome math the backend
            // applies per stamp, so the ghost actually predicts what a click will do — replaces
            // the old flat-orange-disc (CLAUDE.md's audit flagged this as no-feedback-at-all).
            const { sculptRadius: radius, sculptSoftness: softness, sculptProfile: profile } = cfg;
            const ringX = pos.x * scale + vx + gs / 2, ringY = pos.y * scale + vy + gs / 2;
            if (gs < 2) {
              // Too zoomed out for per-cell alpha to read — draw rings only: outer radius, and
              // (when soft) an inner full-strength ring at the flat-weight-1 core.
              const ring = (r: number, alpha: number) => {
                ctx.strokeStyle = `rgba(251,146,60,${alpha})`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(ringX, ringY, r * scale, 0, Math.PI * 2);
                ctx.stroke();
              };
              ring(radius, 0.85);
              if (softness > 0) ring(radius * (1 - softness), 0.45);
            } else {
              const pts = brushFootprint(pos, radius * 2 + 1, "circ");
              for (const p of pts) {
                const d = Math.hypot(p.x - pos.x, p.y - pos.y);
                const w = sculptWeightAt(d, radius, softness, profile);
                ctx.fillStyle = `rgba(251,146,60,${(0.55 * w).toFixed(3)})`;
                paintPt(p.x, p.y);
              }
              ctx.strokeStyle = "rgba(251,146,60,0.85)";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.arc(ringX, ringY, radius * scale, 0, Math.PI * 2);
              ctx.stroke();
            }
          } else {
            const pts = (drawTool === "pen" || drawTool === "fill")
              ? [pos]
              : brushFootprint(pos, cfg.brushSize, cfg.brushShape);
            ctx.fillStyle = drawTool === "fill" ? "rgba(52,211,153,0.55)" : "rgba(56,189,248,0.4)";
            for (const p of pts) paintPt(p.x, p.y);
          }
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
      ctx.fillStyle = "rgba(131,120,108,0.85)";
      ctx.textAlign = "right";
      ctx.fillText(label, cw - 12, ch - 12);
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

  // Debounced chunk_occupancy fetch behind the materialize-select overlay — merges results into
  // materializeOccupancyRef and redraws. Never rejects a later result as "stale": each response only
  // ever writes the keys it queried, so out-of-order completions can't corrupt the cache.
  const fetchMaterializeOccupancy = useCallback((cx1: number, cy1: number, cx2: number, cy2: number) => {
    invoke<number[]>("chunk_occupancy", { x1: cx1, y1: cy1, x2: cx2, y2: cy2 })
      .then((flags) => {
        const w = cx2 - cx1 + 1;
        for (let cy = cy1; cy <= cy2; cy++) {
          for (let cx = cx1; cx <= cx2; cx++) {
            materializeOccupancyRef.current.set(`${cx},${cy}`, flags[(cy - cy1) * w + (cx - cx1)] === 1);
          }
        }
        evictOldestEntries(materializeOccupancyRef.current, MATERIALIZE_OCCUPANCY_LIMIT);
        scheduleDraw();
      })
      .catch(() => {});
  }, [scheduleDraw]);
  const scheduleMaterializeOccupancyFetch = useCallback((cx1: number, cy1: number, cx2: number, cy2: number) => {
    if (materializeFetchTimerRef.current !== null) window.clearTimeout(materializeFetchTimerRef.current);
    materializeFetchTimerRef.current = window.setTimeout(() => {
      materializeFetchTimerRef.current = null;
      fetchMaterializeOccupancy(cx1, cy1, cx2, cy2);
    }, 120);
  }, [fetchMaterializeOccupancy]);

  // ── loadTile ──────────────────────────────────────────────────────────────

  const loadTile = useCallback(async (
    key: string, lod: number, x1: number, y1: number, x2: number, y2: number,
  ) => {
    const myEpoch = tileEpoch.current.peek();
    pendingRef.current.add(key);
    try {
      const tilePromise = viewModeRef.current === "zslice"
        ? invoke<ArrayBuffer>("render_zslice_patch", { z: zSliceZRef.current, x1, y1, x2, y2, lod })
        : invoke<ArrayBuffer>("fetch_tile", { x1, y1, x2, y2, lod });

      // Fire the template overlay fetch concurrently with the base tile rather than after it.
      const wantTemplate = showTemplateOverlayRef.current && viewModeRef.current !== "zslice" && !templateTileCacheRef.current.has(key);
      const templatePromise = wantTemplate
        ? invoke<ArrayBuffer>("fetch_template_tile", { x1, y1, x2, y2, lod }).catch(() => null)
        : Promise.resolve(null);

      const [rawBuf, trawBuf] = await Promise.all([tilePromise, templatePromise]);
      if (tileEpoch.current.isStale(myEpoch)) return;
      const raw = decodePixelPatch(rawBuf);
      const traw = trawBuf ? decodePixelPatch(trawBuf) : null;
      const tc  = document.createElement("canvas");
      tc.width  = raw.width;
      tc.height = raw.height;
      putPatchPixels(tc.getContext("2d")!, raw);
      tileCacheRef.current.set(key, tc);
      evictTiles(tileCacheRef.current, tileLimitRef.current);

      if (traw) {
        const ttc = document.createElement("canvas");
        ttc.width = traw.width; ttc.height = traw.height;
        putPatchPixels(ttc.getContext("2d")!, traw);
        templateTileCacheRef.current.set(key, ttc);
        evictTiles(templateTileCacheRef.current, templateLimitRef.current);
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
    clearTiles(templateTileCacheRef.current);
    if (showTemplateOverlay) {
      tileEpoch.current.next();
      clearTiles(tileCacheRef.current);
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
      loadTile(job.key, job.lod, job.x1, job.y1, job.x2, job.y2);
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
        let buf: ArrayBuffer;
        if (viewModeRef.current === "zslice") {
          buf = await invoke<ArrayBuffer>("render_zslice_patch", {
            z: zSliceZRef.current, x1: 0, y1: y, x2: mW - 1, y2,
          });
        } else if (renderModeRef.current === "axo") {
          buf = await invoke<ArrayBuffer>("render_axo_region", {
            x1: 0, y1: y, x2: mW - 1, y2, ski: axoSkewRef.current,
          });
        } else {
          buf = await invoke<ArrayBuffer>("fetch_tile", { x1: 0, y1: y, x2: mW - 1, y2 });
        }
        const raw = decodePixelPatch(buf);
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

    // One tile spans `span` world blocks and always renders TILE×TILE pixels (audit H6), so the
    // window below stays ~the same tile count no matter how far out the view is zoomed.
    const lod = lodForScale(scale);
    const span = TILE * lod;

    const tx0 = Math.max(0, Math.floor(Math.max(0, -vx) / scale / span) - TILE_BUFFER);
    const ty0 = Math.max(0, Math.floor(Math.max(0, -vy) / scale / span) - TILE_BUFFER);
    const tx1 = Math.min(
      Math.ceil(mW / span),
      Math.ceil((cssWidth(canvas) - vx) / scale / span) + TILE_BUFFER,
    );
    const ty1 = Math.min(
      Math.ceil(mH / span),
      Math.ceil((cssHeight(canvas) - vy) / scale / span) + TILE_BUFFER,
    );

    const needed = new Set<string>();
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        needed.add(tileKey(lod, tx, ty));
      }
    }

    // Bounded LRU rather than "prune to exactly the visible window": mark what's needed now as
    // most-recently-used, then trim from the other end. Panning back and forth (or zooming back to
    // a level just left) now hits the cache instead of re-fetching what was discarded a frame ago.
    for (const key of needed) {
      touchTile(tileCacheRef.current, key);
      touchTile(templateTileCacheRef.current, key);
    }
    // Never below the visible window (a limit under `needed.size` would evict tiles the very frame
    // they're fetched), but also never above what the byte budget allows — §2 of the 2026-08
    // memory-efficiency pass: the old floor-only expression had no ceiling, so a 4K viewport at low
    // zoom (all LOD levels sharing one bucket) could grow unbounded.
    const baseByteCap = Math.floor((tileBudgetBytes * 2 / 3) / TILE_BYTES);
    const templateByteCap = Math.floor((tileBudgetBytes * 1 / 3) / TILE_BYTES);
    tileLimitRef.current = Math.min(Math.max(TILE_CACHE_LIMIT, needed.size * 2), Math.max(needed.size, baseByteCap));
    templateLimitRef.current = Math.min(Math.max(TEMPLATE_CACHE_LIMIT, needed.size * 2), Math.max(needed.size, templateByteCap));
    evictTiles(tileCacheRef.current, tileLimitRef.current);
    evictTiles(templateTileCacheRef.current, templateLimitRef.current);

    draw();

    const jobs: TileJob[] = [];
    for (const key of needed) {
      if (tileCacheRef.current.has(key) || pendingRef.current.has(key)) continue;
      const { tx, ty } = parseTileKey(key);
      jobs.push({
        key,
        lod,
        x1: tx * span,
        y1: ty * span,
        x2: Math.min(mW - 1, (tx + 1) * span - 1),
        y2: Math.min(mH - 1, (ty + 1) * span - 1),
      });
    }
    const cxW = (cssWidth(canvas)  / 2 - vx) / scale;
    const cyW = (cssHeight(canvas) / 2 - vy) / scale;
    jobs.sort((a, b) => {
      const da = (a.x1 + span / 2 - cxW) ** 2 + (a.y1 + span / 2 - cyW) ** 2;
      const db = (b.x1 + span / 2 - cxW) ** 2 + (b.y1 + span / 2 - cyW) ** 2;
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
      // Edit patches are always full-resolution (lod 1). LOD tiles can't take a 1:1 putImageData,
      // so they get the patch drawn through a nearest-neighbour downscale instead — visually the
      // same sampling the backend would do at that level, and it keeps the coarse levels live
      // during an edit rather than blanking them until a refetch lands.
      let patchCanvas: HTMLCanvasElement | null = null;
      for (const [key, tc] of tileCacheRef.current) {
        const { lod, wx, wy, span } = parseTileKey(key);
        if (wx >= patch.x + patch.width || wy >= patch.y + patch.height ||
            wx + span <= patch.x || wy + span <= patch.y) continue;
        const ctx = tc.getContext("2d")!;
        if (lod === 1) {
          const ix0 = Math.max(patch.x, wx);
          const iy0 = Math.max(patch.y, wy);
          const ix1 = Math.min(patch.x + patch.width,  wx + tc.width);
          const iy1 = Math.min(patch.y + patch.height, wy + tc.height);
          if (ix0 >= ix1 || iy0 >= iy1) continue;
          const iw  = ix1 - ix0;
          const ih  = iy1 - iy0;
          const sub = ctx.createImageData(iw, ih);
          for (let row = 0; row < ih; row++) {
            const si = ((iy0 - patch.y + row) * patch.width + (ix0 - patch.x)) * 4;
            sub.data.set(patch.pixels.subarray(si, si + iw * 4), row * iw * 4);
          }
          ctx.putImageData(sub, ix0 - wx, iy0 - wy);
        } else {
          if (!patchCanvas) {
            patchCanvas = document.createElement("canvas");
            patchCanvas.width = patch.width;
            patchCanvas.height = patch.height;
            const pimg = patchCanvas.getContext("2d")!.createImageData(patch.width, patch.height);
            pimg.data.set(patch.pixels);
            patchCanvas.getContext("2d")!.putImageData(pimg, 0, 0);
          }
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(
            patchCanvas,
            (patch.x - wx) / lod, (patch.y - wy) / lod,
            patch.width / lod, patch.height / lod,
          );
        }
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
        const { wx, wy, span } = parseTileKey(key);
        if (wx < x2 && wx + span > x1 && wy < y2 && wy + span > y1) {
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
      const cw = cssWidth(canvas), ch = cssHeight(canvas);
      const scale = fitScale(cw, ch, mW, mH);
      viewRef.current = {
        scale,
        x: (cw - mW * scale) / 2,
        y: (ch - mH * scale) / 2,
      };
      ensureTiles();
    },
    zoomBy(factor: number) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Same anchored-zoom math as the wheel handler, anchored at the viewport centre rather than
      // the cursor (a keyboard zoom has no cursor to zoom toward).
      const cw = cssWidth(canvas), ch = cssHeight(canvas);
      const v = viewRef.current;
      const next = Math.max(minScaleFor(cw, ch, mapWRef.current, mapHRef.current),
                            Math.min(MAX_SCALE, v.scale * factor));
      if (next === v.scale) return;
      viewRef.current = {
        scale: next,
        x: cw / 2 - (cw / 2 - v.x) * (next / v.scale),
        y: ch / 2 - (ch / 2 - v.y) * (next / v.scale),
      };
      ensureTiles();
    },
    zoomToBox(x1: number, y1: number, x2: number, y2: number) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const bw = Math.max(1, x2 - x1 + 1);
      const bh = Math.max(1, y2 - y1 + 1);
      const cw = cssWidth(canvas), ch = cssHeight(canvas);
      const scale = Math.max(minScaleFor(cw, ch, mapWRef.current, mapHRef.current),
                             fitScale(cw, ch, bw, bh, 0.85));
      viewRef.current = {
        scale,
        x: cw / 2 - (x1 + bw / 2) * scale,
        y: ch / 2 - (y1 + bh / 2) * scale,
      };
      ensureTiles();
    },
    centerOn(wx: number, wy: number) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Recenter only — keep the current zoom level, unlike zoomToBox/resetView.
      const cw = cssWidth(canvas), ch = cssHeight(canvas);
      const v = viewRef.current;
      viewRef.current = { scale: v.scale, x: cw / 2 - wx * v.scale, y: ch / 2 - wy * v.scale };
      ensureTiles();
    },
  }), [draw, ensureTiles, loadFullCanvas]);

  // ── Effects ───────────────────────────────────────────────────────────────

  // Deliberately dep-less: these mirror props into refs the imperative draw path reads, and must
  // re-run whenever App re-renders us for *any* reason (a prop the draw reads may have changed
  // without being listed). They go through scheduleDraw, not draw — a synchronous draw here would
  // repaint the whole canvas once per React render, bypassing the rAF coalescing every other hot
  // path in this file uses (App re-renders on cursor/camera ticks that don't change the map).
  useEffect(() => {
    committedSelRef.current = committedSelection;
    scheduleDraw();
  });
  useEffect(() => {
    pastePreviewRef.current = pastePreview;
    if (!pastePreview) pasteHoverRef.current = null;
    scheduleDraw();
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
    const cw = cssWidth(canvas), ch = cssHeight(canvas);
    // Fit-to-bbox (same formula as the imperative resetView()), not a fixed scale=2 — a world whose
    // nominal bbox is much bigger than its populated area (every real Eden world with thin explored
    // strips, and now also any materialize-tool selection that reaches beyond the old bounds) would
    // otherwise center the view on empty space at a zoom level far too tight to ever land on terrain.
    // But raw fitScale() has no floor, so a *huge* world (nominal bbox spanning thousands of chunks)
    // fits at a tiny scale that shows the whole map and forces every visible tile to load at once —
    // the lag-on-load regression this clamp fixes. DEFAULT_LOAD_MIN_SCALE keeps the initial view from
    // zooming out past a sane tile budget; explicit Home/Fit still goes through the real fitScale via
    // the imperative resetView() below, so a user who *wants* the full map is never blocked from it.
    const scale = Math.min(2, Math.max(fitScale(cw, ch, mapW, mapH), DEFAULT_LOAD_MIN_SCALE));
    viewRef.current = {
      x: (cw - mapW * scale) / 2,
      y: (ch - mapH * scale) / 2,
      scale,
    };
    dragRef.current = null;
    // Occupancy is per-world: the same absolute chunk coord is occupied in one world and a hole in
    // the next, so carrying the cache across a load would mis-tint the overlay.
    materializeOccupancyRef.current.clear();
    onSelChangeRef.current(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldEpoch]);

  // Invalidate everything when view mode, z-level, cutaway cap, or world changes
  useEffect(() => {
    viewModeRef.current = viewMode;
    zSliceZRef.current  = zSliceZ;
    tileEpoch.current.next();
    clearTiles(tileCacheRef.current);
    clearTiles(templateTileCacheRef.current);
    pendingRef.current.clear();
    queueRef.current = [];
    fullCanvasRef.current = null;
    ensureTiles();
  }, [viewMode, zSliceZ, viewCapZ, worldEpoch, ensureTiles]);

  // Invalidate everything when render mode changes
  useEffect(() => {
    renderModeRef.current = renderMode;
    tileEpoch.current.next();
    clearTiles(tileCacheRef.current);
    clearTiles(templateTileCacheRef.current);
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

  /**
   * Terrain pixels under a selection, at 1 px per block, for the "Move: Box + Contents" drag
   * ghost. Read from the offscreen tile/full-map sources — NOT the composited canvas, which
   * already has the blue selection fill and its outlines painted on top from the previous frame;
   * snapshotting that baked the overlay into the dragged preview and read as a rendering glitch.
   * Axo is a skewed projection with no 1:1 world mapping, so it gets outline-only dragging.
   */
  const snapshotSelectionPixels = useCallback((sel: SelectionBounds): HTMLCanvasElement | null => {
    const w = sel.x2 - sel.x1 + 1;
    const h = sel.y2 - sel.y1 + 1;
    if (w <= 0 || h <= 0 || renderModeRef.current === "axo") return null;
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const octx = off.getContext("2d");
    if (!octx) return null;
    octx.imageSmoothingEnabled = false;
    if (renderModeRef.current === "full") {
      const fc = fullCanvasRef.current;
      if (!fc) return null;
      octx.drawImage(fc, sel.x1, sel.y1, w, h, 0, 0, w, h);
    } else {
      // Coarser levels first so a finer tile covering the same ground wins (audit H6).
      const tiles = [...tileCacheRef.current].map(([key, tile]) => ({ tile, ...parseTileKey(key) }));
      tiles.sort((a, b) => b.lod - a.lod);
      for (const t of tiles) {
        octx.drawImage(t.tile, t.wx - sel.x1, t.wy - sel.y1, t.tile.width * t.lod, t.tile.height * t.lod);
      }
    }
    // Shaped selection: punch the ghost down to the mask so holes reveal the map beneath during a
    // move-drag. Build a fresh binary-alpha stencil (not the violet overlay cache) and keep only
    // masked pixels via destination-in. Only when the mask's bbox exactly matches this selection.
    const mask = selectionMaskRef.current;
    if (mask && mask.x1 === sel.x1 && mask.y1 === sel.y1 && mask.x2 === sel.x2 && mask.y2 === sel.y2) {
      const stencil = document.createElement("canvas");
      stencil.width = w; stencil.height = h;
      const sctx = stencil.getContext("2d");
      if (sctx) {
        const img = sctx.createImageData(w, h);
        for (let i = 0; i < w * h; i++) {
          if ((mask.bits[i >> 3] >> (i & 7)) & 1) img.data[i * 4 + 3] = 255; // opaque where selected
        }
        sctx.putImageData(img, 0, 0);
        octx.globalCompositeOperation = "destination-in";
        octx.drawImage(stencil, 0, 0);
        octx.globalCompositeOperation = "source-over";
      }
    }
    return off;
  }, []);

  // ── Pointer / wheel handlers ──────────────────────────────────────────────

  // Close the polygon-in-progress: for the draw tool, fill/outline its interior and commit as one
  // stroke; for polyselect, hand the raw vertex path to the caller (mirrors lasso's onLassoSelect,
  // which does its own polygonPixels(..., "fill") + set_selection_mask).
  const commitPolygon = useCallback(() => {
    const verts = polyVertsRef.current;
    polyVertsRef.current = [];
    if (toolRef.current === "polyselect") {
      if (verts.length >= 3) onPolySelectRef.current?.(verts.map(p => [p.x, p.y]));
    } else if (verts.length >= 2 && onDrawStrokeRef.current) {
      const mode: FillMode = drawConfigRef.current?.fillMode ?? "fill";
      const pts = polygonPixels(verts, mode);
      strokeIdRef.current++; // one polygon fill = one undo group
      if (pts.length > 0) onDrawStrokeRef.current(pts.map(p => [p.x, p.y]), drawZOverrideRef.current, undefined, undefined, strokeIdRef.current);
    }
    draw();
  }, [draw]);

  // Escape cancels an in-progress polygon, or an in-progress drag (marquee select, rect/ellipse/
  // line shape, selection move, selection edge resize) before it reaches App's global Escape
  // handler. Gated on !typing for the same reason App's Escape is: Escape in the world-name field
  // is "revert my edit", not "throw away the gesture I'm halfway through".
  useEffect(() => {
    const CANCELLABLE_DRAGS: Exclude<DragOp, null>["kind"][] = ["select", "draw-shape", "moveSel", "resizeEdge", "sculpt-grab", "lasso", "materialize-select"];
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isTypingTarget(e.target)) return;
      if (polyVertsRef.current.length > 0) {
        e.stopPropagation();
        polyVertsRef.current = [];
        draw();
        return;
      }
      const drag = dragRef.current;
      // Live-brush sculpt: cancel = stop stamping, drop pending, and undo the whole grouped stroke.
      // Set the cancel flag first (blocks any queued flush), then wait for the in-flight flush to
      // settle before firing exactly one undo — otherwise a late flush would land after the undo.
      if (drag?.kind === "draw-stroke" && drag.live) {
        e.stopPropagation();
        strokeCancelledRef.current = true;
        pendingStampsRef.current = [];
        if (accumTimerRef.current !== null) { clearInterval(accumTimerRef.current); accumTimerRef.current = null; }
        dragRef.current = null;
        const fired = accumFiredRef.current;
        accumFiredRef.current = false;
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = TOOL_CURSOR[toolRef.current];
        draw();
        if (fired) {
          const inflight = sculptFlushPromiseRef.current;
          Promise.resolve(inflight).finally(() => { onCancelStrokeRef.current?.(); });
        }
        return;
      }
      if (drag && CANCELLABLE_DRAGS.includes(drag.kind)) {
        e.stopPropagation();
        dragRef.current = null;
        if (drag.kind === "select" || drag.kind === "moveSel") onSelectDragUpdateRef.current?.(null);
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = TOOL_CURSOR[toolRef.current];
        draw();
        return;
      }
      // No active drag: Escape on the materialize tool clears a committed selection, mirroring the
      // step-back cascade for every other armed/gated mode.
      if (!drag && toolRef.current === "materialize" && committedMaterializeSelRef.current) {
        e.stopPropagation();
        onMaterializeSelectionChangeRef.current?.(null);
        draw();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [draw]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Refresh the cached rect at the start of each gesture (toLocal reads it for the duration).
    rectRef.current = (e.target as HTMLCanvasElement).getBoundingClientRect();
    pointerDownOnCanvasRef.current = true;
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
    if (toolRef.current === "lasso") {
      const wp = screenToWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "lasso", pts: [wp] };
      draw();
      return;
    }
    if (toolRef.current === "eyedropper") {
      const wp = screenToWorld(e.clientX, e.clientY);
      onEyedropperRef.current?.(wp.x, wp.y);
      return;
    }
    if (toolRef.current === "poolfill") {
      const wp = screenToWorld(e.clientX, e.clientY);
      onPoolFillPickRef.current?.(wp.x, wp.y);
      return;
    }
    if (toolRef.current === "materialize") {
      const wp = screenToWorldLoose(e.clientX, e.clientY);
      dragRef.current = { kind: "materialize-select", start: wp, end: wp };
      draw();
      return;
    }
    if (toolRef.current === "select") {
      const sel = committedSelRef.current;
      if (sel !== null) {
        const lp = toLocal(e.clientX, e.clientY);
        const edge = hitTestEdge(lp.x, lp.y, sel, viewRef.current);
        if (edge !== null) {
          const cur = resizeCursor(edge);
          (e.target as HTMLCanvasElement).style.cursor = cur;
          dragRef.current = { kind: "resizeEdge", edge, live: { ...sel } };
          draw();
          return;
        }
        const wpIn = screenToWorld(e.clientX, e.clientY);
        // Shaped selection: a click on a hole in the traced footprint is outside the shape, so it
        // starts a fresh marquee (consistent with clicking outside the box) rather than a move.
        const mask = selectionMaskRef.current;
        let inHole = false;
        if (mask && mask.x1 === sel.x1 && mask.y1 === sel.y1 && mask.x2 === sel.x2 && mask.y2 === sel.y2) {
          const bi = (wpIn.y - mask.y1) * (mask.x2 - mask.x1 + 1) + (wpIn.x - mask.x1);
          inHole = !((mask.bits[bi >> 3] >> (bi & 7)) & 1);
        }
        if (!inHole && wpIn.x >= sel.x1 && wpIn.x <= sel.x2 && wpIn.y >= sel.y1 && wpIn.y <= sel.y2) {
          // Click-drag inside the committed selection (not on a resize edge) moves it with
          // its contents (E2) instead of starting a new marquee.
          (e.target as HTMLCanvasElement).style.cursor = "move";
          const ghost = moveWithContentsRef.current ? snapshotSelectionPixels(sel) : null;
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
      strokeIdRef.current++; // grab is a single-commit stroke, but still its own undo group
      dragRef.current = { kind: "sculpt-grab", pts, cx: wp.x, cy: wp.y, downClientY: e.clientY, delta: 0 };
      draw();
    } else if (toolRef.current === "polygon" || toolRef.current === "polyselect") {
      // Polygon (draw/select): each click adds a vertex; click near the first vertex (or
      // double-click) closes and commits. No drag state — vertices persist in polyVertsRef across
      // clicks. commitPolygon() branches on the active tool for what "commit" means.
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
      strokeIdRef.current++; // new stroke → new undo group (shared by every stamp of this stroke)
      const strokeId = strokeIdRef.current;
      smoothPosRef.current = { x: wp.x, y: wp.y }; // stabilizer origin
      // Live-brush sculpt (Row 6): the primary model when Live brush is ON — every sculpt tool except
      // smear (which keeps its own per-tick advect path). OFF = legacy one-shot swept commit.
      const liveSculpt = isSculpt && cfg?.sculptAccumulate === true && toolRef.current !== "smear";
      const footprint = liveSculpt ? [] : stampFootprint(wp, toolRef.current, cfg);
      const pts = new Set<string>(footprint.map(p => `${p.x},${p.y}`));
      dragRef.current = { kind: "draw-stroke", pts, lastWX: wp.x, lastWY: wp.y, startWX: wp.x, startWY: wp.y, live: liveSculpt };
      accumFiredRef.current = false;
      accumBusyRef.current = false;
      if (accumTimerRef.current !== null) { clearInterval(accumTimerRef.current); accumTimerRef.current = null; }
      if (liveSculpt) {
        // Stamp on pointer-down, emit more by spacing on pointer-move, re-stamp in place on dwell —
        // the standard brush-engine model. Centres batch through flushSculptRef (one call in flight).
        pendingStampsRef.current = [];
        stampDistAccumRef.current = 0;
        lastStampPosRef.current = { x: wp.x, y: wp.y };
        strokeAnchorRef.current = [wp.x, wp.y]; // flatten/slope converge toward this plane
        strokeCancelledRef.current = false;
        sculptFlushPromiseRef.current = null;
        pendingStampsRef.current.push([wp.x, wp.y]);
        flushSculptRef.current(strokeId);
        // Dwell timer: while the cursor sits on the last stamped cell, keep re-stamping it (airbrush).
        accumTimerRef.current = window.setInterval(() => {
          if (strokeCancelledRef.current) return;
          const cur = cursorPosRef.current;
          const lastS = lastStampPosRef.current;
          if (!cur || !lastS || cur.x !== lastS.x || cur.y !== lastS.y) return;
          pendingStampsRef.current.push([cur.x, cur.y]);
          flushSculptRef.current(strokeId);
        }, 140);
      } else {
        // Legacy hold-to-build / spray / smear timer. Sculpt with Live brush OFF is a one-shot swept
        // commit (no timer); Spray and Smear force a per-tick timer regardless (each tick its own edit).
        const wantTimer = toolRef.current === "spray" || toolRef.current === "smear";
        if (wantTimer) {
          const anchor: [number, number] = [wp.x, wp.y];
          const timerTool = toolRef.current;
          smearLastPosRef.current = timerTool === "smear" ? { x: wp.x, y: wp.y } : null;
          accumTimerRef.current = window.setInterval(() => {
            const cur = cursorPosRef.current;
            const c = drawConfigRef.current;
            if (!cur || !c || !onDrawStrokeRef.current || accumBusyRef.current) return;
            let smear: [number, number] | undefined;
            if (timerTool === "smear") {
              const last = smearLastPosRef.current;
              if (!last) return;
              const dx = Math.round(cur.x - last.x), dy = Math.round(cur.y - last.y);
              if (dx === 0 && dy === 0) return; // no movement this tick — nothing to smear
              smearLastPosRef.current = { x: cur.x, y: cur.y };
              smear = [dx, dy];
            }
            const fp = stampFootprint(cur, timerTool, c);
            if (fp.length === 0) return;
            accumFiredRef.current = true;
            accumBusyRef.current = true;
            Promise.resolve(onDrawStrokeRef.current(fp.map(p => [p.x, p.y]), drawZOverrideRef.current, anchor, undefined, strokeId, smear))
              .finally(() => { accumBusyRef.current = false; });
          }, 140);
        }
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
      strokeIdRef.current++; // one shape = one undo group
      dragRef.current = { kind: "draw-shape", tool: toolRef.current as "rect" | "ellipse" | "line", start: wp, end: wp };
      draw();
    } else {
      dragRef.current = {
        kind: "pan",
        startX: e.clientX, startY: e.clientY,
        viewX: viewRef.current.x, viewY: viewRef.current.y,
      };
    }
  }, [draw, screenToWorld, screenToWorldLoose]);

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
        const over = dx * dx + dy * dy <= 144;
        if (over !== camHoverRef.current) { camHoverRef.current = over; scheduleDraw(); }
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = over ? "move" : "";
      }
    }
    if (drag?.kind === "pan") {
      viewRef.current.x = drag.viewX + e.clientX - drag.startX;
      viewRef.current.y = drag.viewY + e.clientY - drag.startY;
      scheduleEnsureTiles(); // includes draw(); rAF-coalesced, see scheduleEnsureTiles
    } else {
      if (drag?.kind === "resizeEdge") {
        const e2 = drag.edge;
        if (e2 === "x1" || e2 === "x1y1" || e2 === "x1y2") drag.live.x1 = Math.min(wp.x, drag.live.x2);
        if (e2 === "x2" || e2 === "x2y1" || e2 === "x2y2") drag.live.x2 = Math.max(wp.x, drag.live.x1);
        if (e2 === "y1" || e2 === "x1y1" || e2 === "x2y1") drag.live.y1 = Math.min(wp.y, drag.live.y2);
        if (e2 === "y2" || e2 === "x1y2" || e2 === "x2y2") drag.live.y2 = Math.max(wp.y, drag.live.y1);
      } else if (drag?.kind === "sculpt-grab") {
        // Up-drag raises, down-drag lowers. 1 block per ~6 screen px, scaled by zoom.
        const pxPerBlock = Math.max(3, viewRef.current.scale * 0.9);
        drag.delta = Math.round((drag.downClientY - e.clientY) / pxPerBlock);
      } else if (drag?.kind === "draw-stroke" && drag.live) {
        // Live-brush sculpt: emit a stamp centre every `spacing` cells of travel along the path,
        // then batch-flush. The dwell timer handles a stationary cursor; this handles the drag.
        const cfg = drawConfigRef.current;
        if (strokeCancelledRef.current) return;
        const spacing = Math.max(1, Math.round((cfg?.sculptRadius ?? 4) * 0.5));
        // Stabilizer low-passes the centre path (audit §I asked to extend it to sculpt strokes).
        let target = wp;
        if (cfg?.strokeStabilizer && smoothPosRef.current) {
          const s = smoothPosRef.current;
          s.x += (wp.x - s.x) * 0.35;
          s.y += (wp.y - s.y) * 0.35;
          target = { x: Math.round(s.x), y: Math.round(s.y) };
        }
        // Walk from the *previous cursor* (not the last stamp) so incremental travel is counted once;
        // `stampDistAccumRef` carries the sub-spacing remainder between moves, and we subtract spacing
        // per emit (rather than zeroing) to keep stamps evenly spaced across move boundaries.
        const from = { x: drag.lastWX, y: drag.lastWY };
        const line = bresenhamLine(from, target);
        let acc = stampDistAccumRef.current;
        let prev = from;
        let emitted = false;
        for (const lp of line) {
          acc += Math.hypot(lp.x - prev.x, lp.y - prev.y);
          prev = lp;
          if (acc >= spacing) {
            pendingStampsRef.current.push([lp.x, lp.y]);
            lastStampPosRef.current = { x: lp.x, y: lp.y };
            acc -= spacing;
            emitted = true;
          }
        }
        stampDistAccumRef.current = acc;
        drag.lastWX = target.x;
        drag.lastWY = target.y;
        if (emitted) flushSculptRef.current(strokeIdRef.current);
        scheduleDraw();
        return;
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
      } else if (drag?.kind === "lasso") {
        // Append the next point only once the cursor has moved into a new integer cell — freehand
        // drags fire many pointermoves per cell, and polygonPixels only needs the distinct path.
        const last = drag.pts[drag.pts.length - 1];
        if (!last || Math.round(last.x) !== Math.round(wp.x) || Math.round(last.y) !== Math.round(wp.y)) {
          drag.pts.push(wp);
        }
      } else if (drag?.kind === "moveSel") {
        const mdx = Math.round(wp.x - drag.start.x);
        const mdy = Math.round(wp.y - drag.start.y);
        // Shift = axis-lock to whichever direction dominates, the convention in every creative tool.
        if (e.shiftKey) {
          const horizontal = Math.abs(mdx) >= Math.abs(mdy);
          drag.dx = horizontal ? mdx : 0;
          drag.dy = horizontal ? 0 : mdy;
        } else {
          drag.dx = mdx;
          drag.dy = mdy;
        }
      } else if (drag?.kind === "materialize-select") {
        const wpLoose = screenToWorldLoose(e.clientX, e.clientY);
        drag.end = wpLoose;
        // Absolute chunk coords — chunk_occupancy queries the backend's chunk_map directly.
        const cx1 = worldToChunk(Math.min(drag.start.x, wpLoose.x)) + absCx0Ref.current;
        const cy1 = worldToChunk(Math.min(drag.start.y, wpLoose.y)) + absCy0Ref.current;
        const cx2 = worldToChunk(Math.max(drag.start.x, wpLoose.x)) + absCx0Ref.current;
        const cy2 = worldToChunk(Math.max(drag.start.y, wpLoose.y)) + absCy0Ref.current;
        if ((cx2 - cx1 + 1) * (cy2 - cy1 + 1) <= MAX_MATERIALIZE_CHUNKS) {
          scheduleMaterializeOccupancyFetch(cx1, cy1, cx2, cy2);
        }
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
            if (edge !== hoverEdgeRef.current) { hoverEdgeRef.current = edge; scheduleDraw(); }
            canvas.style.cursor = edge !== null ? resizeCursor(edge) : "crosshair";
          } else {
            if (hoverEdgeRef.current) { hoverEdgeRef.current = null; scheduleDraw(); }
            canvas.style.cursor = "crosshair";
          }
        }
      }
      scheduleDraw();
    }
  }, [scheduleDraw, scheduleEnsureTiles, screenToWorld, screenToWorldLoose, scheduleMaterializeOccupancyFetch]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    // This pointerup ends the current gesture chain either way — capture whether it started on
    // the canvas for the paste check below, then reset for the next gesture.
    const startedOnCanvas = pointerDownOnCanvasRef.current;
    pointerDownOnCanvasRef.current = false;
    if (drag?.kind === "pan") {
      dragRef.current = null;
      return;
    }
    if (drag?.kind === "materialize-select") {
      const end = screenToWorldLoose(e.clientX, e.clientY);
      dragRef.current = null;
      if (drag.start.x === end.x && drag.start.y === end.y) {
        onMaterializeSelectionChangeRef.current?.(null);
      } else {
        // Absolute chunk coords — see absCx0Ref; these go straight to the backend commands.
        const cx1 = worldToChunk(Math.min(drag.start.x, end.x)) + absCx0Ref.current;
        const cy1 = worldToChunk(Math.min(drag.start.y, end.y)) + absCy0Ref.current;
        const cx2 = worldToChunk(Math.max(drag.start.x, end.x)) + absCx0Ref.current;
        const cy2 = worldToChunk(Math.max(drag.start.y, end.y)) + absCy0Ref.current;
        onMaterializeSelectionChangeRef.current?.({ cx1, cy1, cx2, cy2 });
        if ((cx2 - cx1 + 1) * (cy2 - cy1 + 1) <= MAX_MATERIALIZE_CHUNKS) {
          fetchMaterializeOccupancy(cx1, cy1, cx2, cy2);
        }
      }
      draw();
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
      if (canvas) canvas.style.cursor = TOOL_CURSOR[toolRef.current];
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
      // A bare click (drag never left the starting cell) shouldn't commit a 1x1 selection —
      // deselect instead, so it doesn't yank the ribbon to the Selection tab.
      if (drag.start.x === end.x && drag.start.y === end.y) {
        onSelChangeRef.current(null);
      } else {
        onSelChangeRef.current({
          x1: Math.min(drag.start.x, end.x),
          y1: Math.min(drag.start.y, end.y),
          x2: Math.max(drag.start.x, end.x),
          y2: Math.max(drag.start.y, end.y),
        });
      }
      draw();
      return;
    }
    if (drag?.kind === "moveSel") {
      dragRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = TOOL_CURSOR[toolRef.current];
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
        onDrawStrokeRef.current(pts, drawZOverrideRef.current, [drag.cx, drag.cy], drag.delta, strokeIdRef.current);
      }
      return;
    }
    if (drag?.kind === "draw-stroke" && drag.live) {
      // Live-brush sculpt: emit a final stamp at the release point (spacing may have left a gap),
      // flush the remainder, and end the stroke. The dwell timer stops here.
      dragRef.current = null;
      if (accumTimerRef.current !== null) { clearInterval(accumTimerRef.current); accumTimerRef.current = null; }
      accumFiredRef.current = false;
      if (!strokeCancelledRef.current) {
        const end = screenToWorld(e.clientX, e.clientY);
        const lastS = lastStampPosRef.current;
        if (!lastS || end.x !== lastS.x || end.y !== lastS.y) {
          pendingStampsRef.current.push([end.x, end.y]);
          lastStampPosRef.current = { x: end.x, y: end.y };
        }
        flushSculptRef.current(strokeIdRef.current);
      }
      draw();
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
        onDrawStrokeRef.current(pts, drawZOverrideRef.current, [drag.startWX, drag.startWY], undefined, strokeIdRef.current);
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
          onDrawStrokeRef.current(pts.map(p => [p.x, p.y]), drawZOverrideRef.current, undefined, undefined, strokeIdRef.current);
        }
      }
      return;
    }
    if (drag?.kind === "lasso") {
      dragRef.current = null;
      draw();
      if (drag.pts.length >= 3) {
        onLassoSelectRef.current?.(drag.pts.map(p => [p.x, p.y]));
      }
      return;
    }
    if (toolRef.current === "paste" && startedOnCanvas) {
      onPasteAtRef.current(screenToWorld(e.clientX, e.clientY));
    }
  }, [draw, screenToWorld, screenToWorldLoose, fetchMaterializeOccupancy]);

  const onPointerLeave = useCallback(() => {
    cursorPosRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = TOOL_CURSOR[toolRef.current];
    draw();
  }, [draw]);

  // Native (non-passive) wheel listener so preventDefault actually suppresses the WKWebView's
  // page-scroll / pinch-zoom. React's synthetic onWheel is registered passively (React 17+), so
  // e.preventDefault() there is a silent no-op — the zoom still worked but trackpad pinch could
  // zoom the whole webview underneath it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const lp = toLocal(e.clientX, e.clientY);
      // Lower bound follows the fit scale so a world too big for MIN_SCALE can still be zoomed
      // back out to its full extent instead of getting stuck mid-way (see minScaleFor).
      const min = minScaleFor(cssWidth(canvas), cssHeight(canvas), mapWRef.current, mapHRef.current);
      viewRef.current = zoomAtPoint(viewRef.current, lp.x, lp.y, e.deltaY, { min, max: MAX_SCALE, factor: 1.1 });
      scheduleEnsureTiles(); // rAF-coalesced; loads new tiles in tiled mode, just draws in full mode
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [scheduleEnsureTiles, toLocal]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block", width: "100%", height: "100%", cursor: TOOL_CURSOR[tool] }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={() => { if (toolRef.current === "polygon" || toolRef.current === "polyselect") commitPolygon(); }}
      onContextMenu={e => {
        e.preventDefault();
        const wp = screenToWorld(e.clientX, e.clientY);
        onMapContextMenuRef.current?.(wp.x, wp.y, e.clientX, e.clientY);
      }}
    />
  );
});

export default MapCanvas;
