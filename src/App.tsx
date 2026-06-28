import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import MapCanvas, { type Tool, type SelectionBounds, type PixelPatch, type MapCanvasRef } from "./MapCanvas";
import SelectionInspector from "./SelectionInspector";
import ElevationPreviewPanel from "./ElevationPreviewPanel";
import SliceViewport from "./SliceViewport";
import FlyView3D, { type FlyView3DRef, type Overlay3D } from "./FlyView3D";
import ErrorBoundary from "./ErrorBoundary";
import HelpModal from "./HelpModal";
import AboutModal from "./AboutModal";
import WorldBrowserModal from "./WorldBrowserModal";
import UploadModal from "./UploadModal";
import NewWorldModal from "./NewWorldModal";
import SchematicImportModal, { type SchematicInfo, type MappingEntry } from "./SchematicImportModal";
import Ribbon, { RIBBON_HEIGHT_COLLAPSED, TAB_BAR_HEIGHT, DEFAULT_BODY_HEIGHT } from "./Ribbon";
import SettingsModal, { loadSettings, saveSettings } from "./SettingsModal";
import WorldInfoModal from "./WorldInfoModal";
import { decodeAtlas, type AtlasData, type TexturePackRaw, clearSwatchCache } from "./texturePack";
import { blockDisplayName } from "./blockDefs";
import appIcon from "./assets/app-icon.png";
import "./App.css";

function SplashLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href="#"
      onClick={(e) => { e.preventDefault(); openUrl(href); }}
      style={{ color: "#64748b", textDecoration: "underline" }}
    >
      {children}
    </a>
  );
}

// World metadata — pixels are never stored in JS; tiles are fetched on demand.
interface WorldData {
  name: string;
  width_chunks: number;
  height_chunks: number;
  max_z: number;
  was_compressed: boolean;
  spawn_px: number | null;
  spawn_py: number | null;
  center_px: number | null;
  center_py: number | null;
  abs_min_x: number;
  abs_min_y: number;
}

// Raw IPC shapes (pixels still base64) — used only at invoke() callsites before decoding.
interface PixelPatchRaw { x: number; y: number; width: number; height: number; pixels: string; }
interface EditResultRaw { patch: PixelPatchRaw; undo_depth: number; redo_depth: number; }
interface PreviewDataRaw { width: number; height: number; pixels: string; }

function decodePixels(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export interface SelectionInfo {
  x1: number; y1: number; x2: number; y2: number;
  z_min: number; z_max: number;
  width: number; height: number; depth: number;
}

export interface ClipboardInfo {
  width: number;
  height: number;
  depth: number;
  z_anchor: number;
}

export type ExtrudeAxis = "z+" | "z-" | "x+" | "x-" | "y+" | "y-";
export type TreeType = "normal" | "terrain" | "pine" | "tall_pine";

const RECENT_WORLDS_KEY = "eden_recent_worlds";
const MAX_RECENT = 8;

interface RecentWorld { path: string; name: string; timestamp: number; }

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  if (d < 31) return `${Math.floor(d / 7)}w ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── component ────────────────────────────────────────────────────────────────

function App() {
  const [world, setWorld] = useState<WorldData | null>(null);
  // Monotonically increments only on full world load; triggers view+selection reset in MapCanvas.
  const [worldEpoch, setWorldEpoch] = useState(0);
  const mapCanvasRef = useRef<MapCanvasRef>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportingObj, setExportingObj] = useState(false);
  const [exportingJson, setExportingJson] = useState(false);
  const [exportingVox, setExportingVox] = useState(false);
  const [voxProgress, setVoxProgress] = useState<{ phase: string; pct: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveCompressed, setSaveCompressed] = useState(() => loadSettings().defaultSaveCompressed);
  const [recentWorlds, setRecentWorlds] = useState<RecentWorld[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_WORLDS_KEY) ?? "[]"); }
    catch { return []; }
  });
  const [ribbonCollapsed, setRibbonCollapsed] = useState(() => {
    try { return localStorage.getItem("ribbon_collapsed") === "true"; } catch { return false; }
  });
  const [ribbonBodyHeight, setRibbonBodyHeight] = useState(() => {
    try { return parseInt(localStorage.getItem("ribbon_body_height") ?? String(DEFAULT_BODY_HEIGHT), 10) || DEFAULT_BODY_HEIGHT; } catch { return DEFAULT_BODY_HEIGHT; }
  });
  const effectiveRibbonHeight = ribbonCollapsed ? RIBBON_HEIGHT_COLLAPSED : TAB_BAR_HEIGHT + ribbonBodyHeight + 4;
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);

  // Status bar: cursor world position and FPS
  const [cursorPos, setCursorPos] = useState<{wx:number;wy:number}|null>(null);
  const [cursorBlock, setCursorBlock] = useState<{z:number;bt:number;paint:number}|null>(null);
  const [ctxMenu, setCtxMenu] = useState<{wx:number;wy:number;x:number;y:number}|null>(null);
  const cursorPosThrottleRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0; let last = performance.now();
    let rafId: number;
    const tick = (now: number) => {
      frames++;
      if (now - last >= 1000) { setFps(Math.round(frames * 1000 / (now - last))); frames = 0; last = now; }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);
  const [tool, setTool] = useState<Tool>("pan");
  const prevToolRef = useRef<Tool>("pan");
  const [wandMatchPaint, setWandMatchPaint] = useState(true);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<"tiled" | "full" | "axo">("tiled");
  const [axoSkew, setAxoSkew] = useState(0.2);
  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showWorldInfo, setShowWorldInfo] = useState(false);
  const [appVersion, setAppVersion] = useState("…");
  useEffect(() => { getVersion().then(setAppVersion); }, []);
  const [showSlicePanels, setShowSlicePanels] = useState(() => loadSettings().defaultQuadView);
  // 3D fly-through pane (4th quad cell) — off by default; it's the most expensive pane, so the user
  // opts in. `exp` (experimental, perf-heavy on large worlds).
  const [enable3dPane, setEnable3dPane] = useState(() => loadSettings().default3dPane);
  const flyActiveRef = useRef(false); // true while FlyView3D fly mode is active — blocks global shortcuts
  const flyView3dRef = useRef<FlyView3DRef>(null);
  const [cam3dPos, setCam3dPos] = useState<{ x: number; y: number } | null>(null);
  const [sliceFrontY, setSliceFrontY] = useState(0); // front slab depth (world Y)
  const [sliceSideX, setSliceSideX] = useState(0);   // side slab depth (world X)
  const [showWorldBrowser, setShowWorldBrowser] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showNewWorld, setShowNewWorld] = useState(false);
  const [schematicInfo, setSchematicInfo] = useState<SchematicInfo | null>(null);
  const [schematicPath, setSchematicPath] = useState<string | null>(null);
  const [schematicApplying, setSchematicApplying] = useState(false);
  const [spawnPos, setSpawnPos] = useState<{ px: number; py: number } | null>(null);
  const cursorWorldRef = useRef<{ wx: number; wy: number }>({ wx: 0, wy: 0 });

  // Template overlay state
  const [templateLoaded, setTemplateLoaded] = useState(false);
  const [templatePath, setTemplatePath] = useState<string | null>(() =>
    loadSettings().templatePath
  );
  const [showTemplateOverlay, setShowTemplateOverlay] = useState(false);
  const [showExpandModal, setShowExpandModal] = useState(false);
  const [expandFullExtent, setExpandFullExtent] = useState(true);
  const [expandInProgress, setExpandInProgress] = useState(false);
  const [expandProgress, setExpandProgress] = useState(0);
  const [expandResult, setExpandResult] = useState<{ chunksAdded: number; totalChunks: number } | null>(null);

  // Texture pack state
  const [texturePackPath, setTexturePackPath] = useState<string | null>(() => loadSettings().texturePackPath);
  const [texturePackInfo, setTexturePackInfo] = useState<AtlasData | null>(null);
  const [texEpoch, setTexEpoch] = useState(0);

  const [renamingWorld, setRenamingWorld] = useState(false);
  const [renameInput, setRenameInput] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [clipboard, setClipboard] = useState<ClipboardInfo | null>(null);
  const [pasteElevationOffset, setPasteElevationOffset] = useState(0);
  const [pasteIgnoreAir, setPasteIgnoreAir] = useState(false);
  const [persistPaste, setPersistPaste] = useState(false);
  const [pasteTerrain, setPasteTerrain] = useState(false);
  const [pasteTerrainAbove, setPasteTerrainAbove] = useState(true);
  const [lockedPastePos, setLockedPastePos] = useState<{ x: number; y: number } | null>(null);
  const lockedPastePosRef = useRef<{ x: number; y: number } | null>(null);
  const [editEpoch, setEditEpoch] = useState(0);
  // World bounds of the most recent edit (top-down X/Y) — lets slabs skip refetch if untouched.
  const [lastEditBounds, setLastEditBounds] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const [extrudeCount, setExtrudeCount] = useState(0);
  const [extrudeAxis, setExtrudeAxis]   = useState<ExtrudeAxis>("z+");
  const [extrudeOpen, setExtrudeOpen]   = useState(false);

  const [brushSize,    setBrushSize]    = useState(3);
  const [brushShape,   setBrushShape]   = useState<"sq" | "circ">("sq");
  const [drawFilled,   setDrawFilled]   = useState(true);
  const [drawAbove,    setDrawAbove]    = useState(false);

  // Sculpt tools
  const [sculptStrength, setSculptStrength] = useState(2);
  const sculptSeedRef = useRef(Math.floor(Math.random() * 0xFFFFFFFF));

  // Mask
  const [maskEnabled,   setMaskEnabled]   = useState(false);
  const [maskBlockType, setMaskBlockType] = useState<number | null>(null);
  const [maskPaint,     setMaskPaint]     = useState<number | null>(null);

  // Hotbar: 5 pinned + 5 recent block+paint combos
  const [pinnedBlocks, setPinnedBlocks] = useState<({type: number; paint: number} | null)[]>(Array(5).fill(null));
  const [recentBlocks, setRecentBlocks] = useState<{type: number; paint: number}[]>([]);
  const [hotbarHover, setHotbarHover] = useState<string | null>(null);


  // Paste mode: normal | scatter | array
  const [pasteMode, setPasteMode] = useState<"normal" | "scatter" | "array">("normal");
  const [scatterCount, setScatterCount] = useState(5);
  const [arrayCols, setArrayCols] = useState(3);
  const [arrayRows, setArrayRows] = useState(3);
  const [arraySpacingX, setArraySpacingX] = useState(0);
  const [arraySpacingY, setArraySpacingY] = useState(0);

  const [clipboardPreviewPixels, setClipboardPreviewPixels] = useState<{ width: number; height: number; pixels: Uint8Array } | null>(null);

  // Tree generation state (lifted from SelectionInspector so Ribbon can render the tree UI)
  const [treeTypes, setTreeTypes] = useState<string[]>(["normal"]);
  const [treeDensity, setTreeDensity] = useState(20);
  const [leafPaints, setLeafPaints] = useState<number[]>([0, 22, 31, 40]);
  const [smartPlacement, setSmartPlacement] = useState(true);

  // Repeat-paste trail: track last paste position + step vector for path preview and `.` shortcut.
  const [lastPasteDelta, setLastPasteDelta] = useState<{ dx: number; dy: number } | null>(null);
  const lastPastePosRef   = useRef<{ x: number; y: number } | null>(null);
  const lastPasteDeltaRef = useRef<{ dx: number; dy: number } | null>(null);

  // Creature viewer (Phase 6) — UI + state hidden pending testing; Rust get_creatures command is implemented

  // Z-slice follow-surface mode
  const [followSurface, setFollowSurface] = useState(false);
  const followSurfaceRef = useRef(false);
  const cursorMoveThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { followSurfaceRef.current = followSurface; }, [followSurface]);

  const appToolRef = useRef<Tool>("pan");
  useEffect(() => { appToolRef.current = tool; }, [tool]);
  useEffect(() => { lockedPastePosRef.current = lockedPastePos; }, [lockedPastePos]);
  useEffect(() => { if (tool !== "paste") setLockedPastePos(null); }, [tool]);
  useEffect(() => { /* elevation panel always visible in normal mode */ }, [lockedPastePos]);

  // Clear paste trail when clipboard changes or we leave paste mode.
  useEffect(() => {
    setLastPasteDelta(null);
    lastPasteDeltaRef.current = null;
    lastPastePosRef.current   = null;
  }, [clipboard]);
  useEffect(() => {
    if (tool !== "paste") {
      setLastPasteDelta(null);
      lastPasteDeltaRef.current = null;
      lastPastePosRef.current   = null;
    }
  }, [tool]);

  // Monotonically increasing counter; incremented at the START of every openFile().
  // Async invokes that captured a prior epoch discard their result on resolution.
  const loadEpochRef = useRef(0);

  const [viewMode, setViewMode] = useState<"topdown" | "zslice">("topdown");
  // zSliceZ is the committed level passed to MapCanvas (triggers tile refetch).
  // zSliceDisplay is the slider's visual value while the user is dragging.
  const [zSliceZ, setZSliceZ] = useState(32);
  const [zSliceDisplay, setZSliceDisplay] = useState(32);

  const viewModeRef = useRef<"topdown" | "zslice">("topdown");
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);

  // Dismiss context menu on any outside click.
  // Delay registration to avoid macOS right-click pointerdown firing after contextmenu.
  useEffect(() => {
    if (!ctxMenu) return;
    let handler: (() => void) | null = null;
    const timer = setTimeout(() => {
      handler = () => setCtxMenu(null);
      document.addEventListener("mousedown", handler);
    }, 80);
    return () => {
      clearTimeout(timer);
      if (handler) document.removeEventListener("mousedown", handler);
    };
  }, [ctxMenu]);
  const renderModeRef = useRef<"tiled" | "full" | "axo">("tiled");
  useEffect(() => { renderModeRef.current = renderMode; }, [renderMode]);
  const zSliceZRef = useRef(32);
  useEffect(() => { zSliceZRef.current = zSliceZ; }, [zSliceZ]);

  const [fillBlockType, setFillBlockType] = useState(2);
  const [fillPaint, setFillPaint] = useState(0);

  const [filterBlockType, setFilterBlockType] = useState<number | null>(null);
  const [filterPaint, setFilterPaint] = useState<number | null>(null);
  const [filterInvert, setFilterInvert] = useState(false);

  const [rawBounds, setRawBounds] = useState<SelectionBounds | null>(null);
  const [zMin, setZMin] = useState(0);
  const [zMax, setZMax] = useState(63);

  const [selection, setSelection] = useState<SelectionInfo | null>(null);

  // 3D wireframe overlays for the fly-through pane: selection (blue), extrude copies (amber), paste (green).
  const overlays3d = useMemo<Overlay3D[] | null>(() => {
    if (!showSlicePanels || !enable3dPane) return null;
    const ovs: Overlay3D[] = [];
    if (rawBounds) {
      const { x1, y1, x2, y2 } = rawBounds;
      ovs.push({ min: [x1, zMin, y1], max: [x2 + 1, zMax + 1, y2 + 1], color: 0x3b82f6 });
      if (extrudeOpen && extrudeCount > 0) {
        const w = x2 - x1 + 1, h = y2 - y1 + 1, d = zMax - zMin + 1;
        for (let i = 1; i <= extrudeCount; i++) {
          let ox = 0, oy = 0, oz = 0;
          if (extrudeAxis === "x+") ox = w * i;
          else if (extrudeAxis === "x-") ox = -w * i;
          else if (extrudeAxis === "y+") oy = h * i;
          else if (extrudeAxis === "y-") oy = -h * i;
          else if (extrudeAxis === "z+") oz = d * i;
          else if (extrudeAxis === "z-") oz = -d * i;
          ovs.push({
            min: [x1 + ox, zMin + oz, y1 + oy],
            max: [x2 + ox + 1, zMax + oz + 1, y2 + oy + 1],
            color: 0xf59e0b,
          });
        }
      }
    }
    if (lockedPastePos && clipboard) {
      const px = lockedPastePos.x, py = lockedPastePos.y;
      const pz = clipboard.z_anchor + pasteElevationOffset;
      ovs.push({
        min: [px, pz, py],
        max: [px + clipboard.width, pz + clipboard.depth, py + clipboard.height],
        color: 0x22c55e,
      });
    }
    return ovs.length > 0 ? ovs : null;
  }, [showSlicePanels, enable3dPane, rawBounds, zMin, zMax, extrudeOpen, extrudeAxis, extrudeCount, lockedPastePos, clipboard, pasteElevationOffset]);

  // When a selection is made, snap the Front/Side slice planes to its centre so the slabs show the
  // selection by default (mirrors what the elevation preview shows). Only fires on selection change,
  // so the user can still scrub freely afterwards.
  useEffect(() => {
    if (!rawBounds) return;
    setSliceFrontY(Math.round((rawBounds.y1 + rawBounds.y2) / 2));
    setSliceSideX(Math.round((rawBounds.x1 + rawBounds.x2) / 2));
  }, [rawBounds]);

  // Snap slab depths to the paste footprint when a paste is locked in (so the ghost shows in context).
  useEffect(() => {
    if (!lockedPastePos || !clipboard) return;
    setSliceFrontY(Math.round(lockedPastePos.y + clipboard.height / 2));
    setSliceSideX(Math.round(lockedPastePos.x + clipboard.width / 2));
  }, [lockedPastePos, clipboard]);

  useEffect(() => {
    if (!rawBounds) {
      setSelection(null);
      return;
    }
    const timer = setTimeout(() => {
      invoke<SelectionInfo>("describe_selection", { ...rawBounds, zMin, zMax })
        .then(setSelection)
        .catch((e) => setError(String(e)));
    }, 80);
    return () => clearTimeout(timer);
  }, [rawBounds, zMin, zMax]);

  // Fetch top-down clipboard preview whenever clipboard changes.
  useEffect(() => {
    if (!clipboard) { setClipboardPreviewPixels(null); return; }
    invoke<PreviewDataRaw>("render_clipboard_preview")
      .then(raw => setClipboardPreviewPixels({ ...raw, pixels: decodePixels(raw.pixels) }))
      .catch(() => setClipboardPreviewPixels(null));
  }, [clipboard]);

  // ── Edit helpers ──────────────────────────────────────────────────────────

  async function handleGenerateTrees(treeTypes: string[], density: number, leafPaints: number[], smartPlacement: boolean) {
    if (!selection) return;
    try {
      const result = await invoke<EditResultRaw>("generate_trees", {
        x1: selection.x1, y1: selection.y1, x2: selection.x2, y2: selection.y2,
        treeTypes, density, leafPaints, smartPlacement,
      });
      await applyEditResult(result);
    } catch (e) { setError(String(e)); }
  }

  async function handleExtrude(ignoreAir: boolean) {
    if (!selection) return;
    try {
      const result = await invoke<EditResultRaw>("extrude_selection", {
        x1: selection.x1, y1: selection.y1, x2: selection.x2, y2: selection.y2,
        zMin: selection.z_min, zMax: selection.z_max,
        axis: extrudeAxis, count: extrudeCount, ignoreAir,
      });
      await applyEditResult(result);
    } catch (e) { setError(String(e)); }
  }

  async function applyEditResult(raw: EditResultRaw) {
    if (viewModeRef.current === "topdown") {
      if (renderModeRef.current === "axo") {
        // Axo projection: flat patch positions don't match axo pixel positions, force full re-render
        const w = world;
        if (w) mapCanvasRef.current?.refetchRegion(0, 0, w.width_chunks * 16, w.height_chunks * 16);
      } else {
        const patch: PixelPatch = { ...raw.patch, pixels: decodePixels(raw.patch.pixels) };
        mapCanvasRef.current?.applyPatch(patch);
      }
    } else {
      // z-slice: invalidate and re-fetch the affected tile region
      mapCanvasRef.current?.refetchRegion(
        raw.patch.x, raw.patch.y,
        raw.patch.x + raw.patch.width,
        raw.patch.y + raw.patch.height,
      );
    }
    // Broadcast the edit's world bounds so slice slabs can skip refetching when their depth plane
    // wasn't touched. (Patch carries top-down X/Y extent; z always overlaps the full-height slabs.)
    setLastEditBounds({ x: raw.patch.x, y: raw.patch.y, w: raw.patch.width, h: raw.patch.height });
    setUndoDepth(raw.undo_depth);
    setRedoDepth(raw.redo_depth);
    setEditEpoch(e => e + 1);
  }

  function addRecentWorld(path: string, name: string) {
    setRecentWorlds(prev => {
      const next = [{ path, name, timestamp: Date.now() }, ...prev.filter(r => r.path !== path)].slice(0, MAX_RECENT);
      try { localStorage.setItem(RECENT_WORLDS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  async function openFile() {
    const selected = await open({
      filters: [{ name: "Eden World", extensions: ["eden", "zip"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;
    const myEpoch = ++loadEpochRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<WorldData>("load_world", { path: selected });
      if (loadEpochRef.current !== myEpoch) return;
      setWorld(data);
      setWorldEpoch((e) => e + 1);
      setSourcePath(selected);
      setRawBounds(null);
      setZMin(0);
      setZMax(data.max_z);
      setTool("pan");
      setUndoDepth(0);
      setRedoDepth(0);
      setViewMode("topdown");
      setZSliceZ(32);
      setZSliceDisplay(32);
      setClipboard(null);
      setSaveCompressed(data.was_compressed);
      setSpawnPos(data.spawn_px != null && data.spawn_py != null ? { px: data.spawn_px, py: data.spawn_py } : null);
      addRecentWorld(selected, data.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function openFileAt(path: string) {
    const myEpoch = ++loadEpochRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<WorldData>("load_world", { path });
      if (loadEpochRef.current !== myEpoch) return;
      setWorld(data);
      setWorldEpoch((e) => e + 1);
      setSourcePath(path);
      setRawBounds(null);
      setZMin(0);
      setZMax(data.max_z);
      setTool("pan");
      setUndoDepth(0);
      setRedoDepth(0);
      setViewMode("topdown");
      setZSliceZ(32);
      setZSliceDisplay(32);
      setClipboard(null);
      setSaveCompressed(data.was_compressed);
      setSpawnPos(data.spawn_px != null && data.spawn_py != null ? { px: data.spawn_px, py: data.spawn_py } : null);
      addRecentWorld(path, data.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function exportPng() {
    if (!world) return;
    const suffix = viewMode === "zslice" ? `_z${zSliceZ}` : "";
    const savePath = await save({
      filters: [{ name: "PNG Image", extensions: ["png"] }],
      defaultPath: `${world.name}${suffix}.png`,
    });
    if (!savePath) return;
    setExporting(true);
    setExportProgress(0);
    const useTemplate = showTemplateOverlay && templateLoaded && viewMode !== "zslice";
    try {
      const w = world.width_chunks * 16;
      const h = world.height_chunks * 16;
      const STRIP_H = 128;
      const buf = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y += STRIP_H) {
        const y2 = Math.min(y + STRIP_H - 1, h - 1);
        const raw = viewMode === "zslice"
          ? await invoke<PixelPatchRaw>("render_zslice_patch", { z: zSliceZ, x1: 0, y1: y, x2: w - 1, y2 })
          : await invoke<PixelPatchRaw>("fetch_tile", { x1: 0, y1: y, x2: w - 1, y2 });
        const pixels = decodePixels(raw.pixels);
        if (useTemplate) {
          const traw = await invoke<PixelPatchRaw>("fetch_template_tile", { x1: 0, y1: y, x2: w - 1, y2 });
          const tpixels = decodePixels(traw.pixels);
          // Composite: where user pixel is transparent (alpha=0), use template at full opacity
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] === 0 && tpixels[i + 3] === 255) {
              pixels[i]     = tpixels[i];
              pixels[i + 1] = tpixels[i + 1];
              pixels[i + 2] = tpixels[i + 2];
              pixels[i + 3] = 255;
            }
          }
        }
        buf.set(pixels, y * w * 4);
        setExportProgress((y2 + 1) / h);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      const img = ctx.createImageData(w, h);
      img.data.set(buf);
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
      );
      const pngBytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < pngBytes.length; i += chunkSize) {
        binary += String.fromCharCode(...pngBytes.subarray(i, i + chunkSize));
      }
      await invoke("save_png", { path: savePath, data: btoa(binary) });
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  }

  async function exportObj() {
    if (!world) return;
    const defaultName = selection ? `${world.name}_selection.obj` : `${world.name}.obj`;
    const savePath = await save({
      filters: [{ name: "Wavefront OBJ", extensions: ["obj"] }],
      defaultPath: defaultName,
    });
    if (!savePath) return;
    const x1 = selection ? selection.x1 : 0;
    const y1 = selection ? selection.y1 : 0;
    const x2 = selection ? selection.x2 : world.width_chunks * 16 - 1;
    const y2 = selection ? selection.y2 : world.height_chunks * 16 - 1;
    const zMin = selection ? selection.z_min : 0;
    const zMax = selection ? selection.z_max : world.max_z;
    setExportingObj(true);
    try {
      await invoke("export_obj", { path: savePath, x1, y1, x2, y2, zMin, zMax });
    } catch (e) {
      setError(String(e));
    } finally {
      setExportingObj(false);
    }
  }

  async function exportJson() {
    if (!world) return;
    const defaultName = selection ? `${world.name}_selection.json.gz` : `${world.name}.json.gz`;
    const savePath = await save({
      filters: [{ name: "Gzipped JSON", extensions: ["json.gz", "gz"] }],
      defaultPath: defaultName,
    });
    if (!savePath) return;
    const x1 = selection ? selection.x1 : 0;
    const y1 = selection ? selection.y1 : 0;
    const x2 = selection ? selection.x2 : world.width_chunks * 16 - 1;
    const y2 = selection ? selection.y2 : world.height_chunks * 16 - 1;
    const zMin = selection ? selection.z_min : 0;
    const zMax = selection ? selection.z_max : world.max_z;
    setExportingJson(true);
    try {
      await invoke("export_json", { path: savePath, x1, y1, x2, y2, zMin, zMax });
    } catch (e) {
      setError(String(e));
    } finally {
      setExportingJson(false);
    }
  }

  // VOX export hidden pending better test coverage — prefixed to silence TS unused warning
  const _exportVox = async () => {
    if (!world) return;
    const defaultName = selection ? `${world.name}_selection.vox` : `${world.name}.vox`;
    const savePath = await save({
      filters: [{ name: "MagicaVoxel VOX", extensions: ["vox"] }],
      defaultPath: defaultName,
    });
    if (!savePath) return;
    const x1 = selection ? selection.x1 : 0;
    const y1 = selection ? selection.y1 : 0;
    const x2 = selection ? selection.x2 : world.width_chunks * 16 - 1;
    const y2 = selection ? selection.y2 : world.height_chunks * 16 - 1;
    const zMin = selection ? selection.z_min : 0;
    const zMax = selection ? selection.z_max : world.max_z;
    setExportingVox(true);
    setVoxProgress({ phase: "Starting…", pct: 0 });
    try {
      await invoke("export_vox", { path: savePath, x1, y1, x2, y2, zMin, zMax });
    } catch (e) {
      setError(String(e));
    } finally {
      setExportingVox(false);
      setVoxProgress(null);
    }
  }; void _exportVox;

  function commitZSlice(z: number) {
    setZSliceZ(z);
    setZSliceDisplay(z);
  }

  async function copySelection() {
    if (!rawBounds) return;
    try {
      const info = await invoke<ClipboardInfo>("copy_selection", { ...rawBounds, zMin, zMax });
      setClipboard(info);
      setTool("paste");
    } catch (e) {
      setError(String(e));
    }
  }

  async function rotateClipboard() {
    try {
      const info = await invoke<ClipboardInfo>("rotate_clipboard");
      setClipboard(info);
    } catch (e) {
      setError(String(e));
    }
  }

  async function mirrorClipboardX() {
    try {
      const info = await invoke<ClipboardInfo>("mirror_clipboard_x");
      setClipboard(info);
    } catch (e) {
      setError(String(e));
    }
  }

  async function mirrorClipboardY() {
    try {
      const info = await invoke<ClipboardInfo>("mirror_clipboard_y");
      setClipboard(info);
    } catch (e) {
      setError(String(e));
    }
  }

  async function pasteAt(pos: { x: number; y: number }) {
    try {
      const result = pasteTerrain
        ? await invoke<EditResultRaw>("paste_terrain", {
            pasteX: pos.x, pasteY: pos.y,
            elevationOffset: pasteElevationOffset,
            ignoreAir: pasteIgnoreAir,
            aboveSurface: pasteTerrainAbove,
          })
        : await invoke<EditResultRaw>("paste_at", {
            pasteX: pos.x, pasteY: pos.y,
            elevationOffset: pasteElevationOffset,
            ignoreAir: pasteIgnoreAir,
          });
      // Track last paste direction for repeat-paste trail and `.` shortcut.
      const prev = lastPastePosRef.current;
      if (prev) {
        const delta = { dx: pos.x - prev.x, dy: pos.y - prev.y };
        lastPasteDeltaRef.current = delta;
        setLastPasteDelta(delta);
      }
      lastPastePosRef.current = pos;
      if (!persistPaste) setTool("pan");
      await applyEditResult(result);
    } catch (e) {
      setError(String(e));
    }
  }

  // Stable ref so keyboard handler can always call the latest pasteAt closure.
  const pasteAtRef = useRef(pasteAt);
  useEffect(() => { pasteAtRef.current = pasteAt; });

  function handlePasteClick(pos: { x: number; y: number }) {
    if (pasteMode === "scatter") {
      handleScatterPaste(pos);
      return;
    }
    if (pasteMode === "array") {
      handleArrayPaste(pos);
      return;
    }
    if (persistPaste) {
      pasteAt(pos);
    } else if (lockedPastePos) {
      pasteAt(lockedPastePos);
      setLockedPastePos(null);
    } else {
      setLockedPastePos(pos);
    }
  }

  function trackRecentBlock(type: number, paint: number) {
    setRecentBlocks(prev => {
      const filtered = prev.filter(b => !(b.type === type && b.paint === paint));
      return [{ type, paint }, ...filtered].slice(0, 5);
    });
  }

  async function handleEyedropper(wx: number, wy: number) {
    try {
      const result = await invoke<{ block_type: number; paint: number }>("pick_block_surface", { wx, wy });
      if (result.block_type !== 0) {
        setFillBlockType(result.block_type);
        setFillPaint(result.paint);
        trackRecentBlock(result.block_type, result.paint);
      }
    } catch (e) {
      setError(String(e));
    }
    // One-shot: return to previous draw tool
    const prev = prevToolRef.current;
    setTool(prev === "eyedropper" ? "pen" : prev);
  }

  async function handleDrawStroke(pts: [number, number][], zOverride: number | null) {
    const t = appToolRef.current;
    try {
      if (t === "smooth" || t === "noise" || t === "flatten" || t === "erode") {
        const points = pts.map(([x, y]) => ({ x, y }));
        const seed = t === "noise" ? sculptSeedRef.current : 0;
        if (t === "noise") sculptSeedRef.current = ((sculptSeedRef.current * 1664525 + 1013904223) >>> 0);
        const result = await invoke<EditResultRaw>("sculpt_terrain", {
          points, mode: t, strength: sculptStrength, seed,
          blockType: fillBlockType || null,
          paint: fillPaint || null,
        });
        await applyEditResult(result);
      } else if (t === "fill") {
        if (pts.length === 0) return;
        const [x, y] = pts[0];
        const result = await invoke<EditResultRaw>("fill_surface", {
          wx: x, wy: y, newType: fillBlockType, newPaint: fillBlockType === 0 ? 0 : fillPaint, maxFill: 50000,
        });
        await applyEditResult(result);
        trackRecentBlock(fillBlockType, fillPaint);
      } else {
        const blocks = pts.map(([x, y]) => ({ x, y, z: zOverride }));
        const zOffset = drawAbove && zOverride === null ? 1 : 0;
        const result = await invoke<EditResultRaw>("paint_blocks", {
          blocks, blockType: fillBlockType, paint: fillBlockType === 0 ? 0 : fillPaint, zOffset,
          maskType: maskEnabled ? maskBlockType : null,
          maskPaint: maskEnabled ? maskPaint : null,
        });
        await applyEditResult(result);
        trackRecentBlock(fillBlockType, fillPaint);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  function handleCursorMove(wx: number, wy: number) {
    cursorWorldRef.current = { wx, wy };
    if (cursorPosThrottleRef.current === null) {
      cursorPosThrottleRef.current = setTimeout(() => {
        cursorPosThrottleRef.current = null;
        const { wx: cx, wy: cy } = cursorWorldRef.current!;
        setCursorPos({ wx: cx, wy: cy });
        invoke<[number,number,number] | null>("get_cursor_block", { wx: Math.floor(cx), wy: Math.floor(cy) })
          .then(r => setCursorBlock(r ? { z: r[0], bt: r[1], paint: r[2] } : null))
          .catch(() => {});
      }, 80);
    }
    if (!followSurfaceRef.current || viewModeRef.current !== "zslice") return;
    if (cursorMoveThrottleRef.current !== null) return;
    cursorMoveThrottleRef.current = setTimeout(() => {
      cursorMoveThrottleRef.current = null;
      invoke<number | null>("get_surface_z", { x: wx, y: wy })
        .then(z => { if (z !== null && followSurfaceRef.current) { setZSliceZ(z); setZSliceDisplay(z); } })
        .catch(() => {});
    }, 50);
  }


  async function handleMagicWand(wx: number, wy: number) {
    try {
      const rect = await invoke<{ x1: number; y1: number; x2: number; y2: number } | null>("magic_wand_select", {
        wx, wy, matchPaint: wandMatchPaint,
      });
      if (rect) setRawBounds(rect);
    } catch (e) { setError(String(e)); }
  }

  async function handleScatterPaste(_pos: { x: number; y: number }) {
    if (!rawBounds) return;
    try {
      const result = await invoke<EditResultRaw>("scatter_paste", {
        x1: rawBounds.x1, y1: rawBounds.y1, x2: rawBounds.x2, y2: rawBounds.y2,
        count: scatterCount, seed: Math.floor(Math.random() * 0xFFFFFFFF),
        elevationOffset: pasteElevationOffset, ignoreAir: pasteIgnoreAir,
      });
      await applyEditResult(result);
    } catch (e) { setError(String(e)); }
  }

  async function handleArrayPaste(pos: { x: number; y: number }) {
    try {
      const result = await invoke<EditResultRaw>("array_paste", {
        originX: pos.x, originY: pos.y,
        cols: arrayCols, rows: arrayRows,
        spacingX: arraySpacingX, spacingY: arraySpacingY,
        elevationOffset: pasteElevationOffset, ignoreAir: pasteIgnoreAir,
      });
      await applyEditResult(result);
      if (!persistPaste) setTool("pan");
    } catch (e) { setError(String(e)); }
  }

  async function handleDrawElevation(x: number, y: number, z: number) {
    try {
      const result = await invoke<EditResultRaw>("paint_blocks", {
        blocks: [{ x, y, z }], blockType: fillBlockType, paint: fillPaint,
      });
      await applyEditResult(result);
    } catch (e) {
      setError(String(e));
    }
  }

  // Batch paint at exact world cells (one undo entry). Used by the slice viewports.
  async function handleSlicePaint(cells: { x: number; y: number; z: number }[]) {
    if (!cells.length) return;
    try {
      const result = await invoke<EditResultRaw>("paint_blocks", {
        blocks: cells, blockType: fillBlockType, paint: fillBlockType === 0 ? 0 : fillPaint,
      });
      await applyEditResult(result);
      trackRecentBlock(fillBlockType, fillPaint);
    } catch (e) {
      setError(String(e));
    }
  }

  const handleUndo = useCallback(async () => {
    try {
      const result = await invoke<EditResultRaw>("undo_edit");
      await applyEditResult(result);
    } catch { /* stack empty — ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRedo = useCallback(async () => {
    try {
      const result = await invoke<EditResultRaw>("redo_edit");
      await applyEditResult(result);
    } catch { /* stack empty — ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // While the 3D fly camera is active, it owns all keyboard input — don't fire editor shortcuts.
      if (flyActiveRef.current) return;
      const tag = (e.target as HTMLElement).tagName;
      // ? always toggles help (skip when typing in an input)
      if (e.key === "?" && tag !== "INPUT" && tag !== "TEXTAREA" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowHelp(h => !h);
        return;
      }
      // When help is open, Escape closes it and all other shortcuts are blocked
      if (showHelp) {
        if (e.key === "Escape") { e.preventDefault(); setShowHelp(false); }
        return;
      }
      if (!world) return;
      if (e.key === "Escape") {
        if (lockedPastePosRef.current) {
          e.preventDefault();
          setLockedPastePos(null);
          return;
        }
        const t = appToolRef.current;
        if (t === "paste" || t === "wand" || t === "pen" || t === "brush" || t === "rect" || t === "ellipse" ||
            t === "smooth" || t === "noise" || t === "flatten" || t === "erode" || t === "fill") {
          e.preventDefault();
          setTool("pan");
        } else {
          e.preventDefault();
          setRawBounds(null);
        }
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        mapCanvasRef.current?.resetView();
        return;
      }
      // Draw tool shortcuts (only when not typing in an input)
      if (tag !== "INPUT" && tag !== "TEXTAREA" && !e.metaKey && !e.ctrlKey) {
        if (e.key === "p" || e.key === "P") { e.preventDefault(); setTool("pen"); return; }
        if (e.key === "b" || e.key === "B") { e.preventDefault(); setTool("brush"); return; }
        if (e.key === "r" || e.key === "R") { e.preventDefault(); setTool("rect"); return; }
        if (e.key === "e" || e.key === "E") { e.preventDefault(); setTool("ellipse"); return; }
        if (e.key === "f" || e.key === "F") { e.preventDefault(); setTool("fill"); return; }
        if (e.key === "w" || e.key === "W") { e.preventDefault(); setTool("wand"); return; }
        if (e.key === "i" || e.key === "I") {
          e.preventDefault();
          prevToolRef.current = appToolRef.current === "eyedropper" ? "pen" : appToolRef.current;
          setTool("eyedropper");
          return;
        }
        // Number keys 1-5 = pinned hotbar slots; 6-0 = recent hotbar slots
        if (["1","2","3","4","5"].includes(e.key)) {
          const idx = parseInt(e.key) - 1;
          e.preventDefault();
          setPinnedBlocks(prev => {
            const b = prev[idx];
            if (b) { setFillBlockType(b.type); setFillPaint(b.paint); }
            return prev;
          });
          return;
        }
        if (["6","7","8","9","0"].includes(e.key)) {
          const idx = e.key === "0" ? 4 : parseInt(e.key) - 6;
          e.preventDefault();
          setRecentBlocks(prev => {
            const b = prev[idx];
            if (b) { setFillBlockType(b.type); setFillPaint(b.paint); }
            return prev;
          });
          return;
        }
        // `.` = repeat last paste one step further in the same direction
        if (e.key === "." && appToolRef.current === "paste") {
          const pos   = lastPastePosRef.current;
          const delta = lastPasteDeltaRef.current;
          if (pos && delta) {
            e.preventDefault();
            pasteAtRef.current({ x: pos.x + delta.dx, y: pos.y + delta.dy });
          }
          return;
        }
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); handleRedo(); }
      if (e.key === "c") { e.preventDefault(); copySelection(); }
      if (e.key === "v") {
        e.preventDefault();
        if (clipboard) setTool("paste");
      }
      if (e.key === "s") {
        e.preventDefault();
        if (sourcePath) saveWorld(sourcePath);
        else saveWorldAs();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [world, showHelp, handleUndo, handleRedo, clipboard, sourcePath, copySelection, saveWorld, saveWorldAs]);

  // Menu close effects handled inside Ribbon component

  // Template overlay helpers
  async function loadTexturePackFile(path: string) {
    try {
      const raw = await invoke<TexturePackRaw>("load_texture_pack", { path });
      const atlas = decodeAtlas(raw);
      clearSwatchCache();
      setTexturePackInfo(atlas);
      setTexturePackPath(path);
      setTexEpoch(e => e + 1);
      saveSettings({ texturePackPath: path });
    } catch (e) { setError(String(e)); }
  }

  async function openTexturePackFile() {
    const selected = await open({ filters: [{ name: "Texture Pack", extensions: ["zip"] }] });
    if (!selected || Array.isArray(selected)) return;
    await loadTexturePackFile(selected);
  }

  function unloadTexturePack() {
    invoke("unload_texture_pack").catch(() => {});
    clearSwatchCache();
    setTexturePackInfo(null);
    setTexturePackPath(null);
    setTexEpoch(e => e + 1);
    saveSettings({ texturePackPath: null });
  }

  // Auto-load texture pack from settings on startup
  useEffect(() => {
    if (texturePackPath) loadTexturePackFile(texturePackPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTemplateFile(path: string) {
    try {
      await invoke<number>("load_eden_template", { path });
      setTemplateLoaded(true);
      setTemplatePath(path);
      setShowTemplateOverlay(true);
      saveSettings({ templatePath: path });
    } catch (e) { setError(String(e)); }
  }

  async function openTemplateFile() {
    const selected = await open({ filters: [{ name: "Eden World", extensions: ["eden"] }] });
    if (!selected || Array.isArray(selected)) return;
    await loadTemplateFile(selected);
  }

  // Expand progress event listener
  useEffect(() => {
    const unlisten = listen<number>("expand_progress", (e) => {
      setExpandProgress(e.payload);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  // VOX export progress event listener
  useEffect(() => {
    const unlisten = listen<{ phase: string; pct: number }>("vox-progress", (e) => {
      setVoxProgress(e.payload);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  async function runExpand() {
    const outPath = await save({ filters: [{ name: "Eden World", extensions: ["eden"] }], defaultPath: "world_expanded.eden" });
    if (!outPath) return;
    setExpandInProgress(true);
    setExpandProgress(0);
    setExpandResult(null);
    try {
      const res = await invoke<{ chunks_added: number; total_chunks: number }>("expand_world_from_template", {
        outputPath: outPath,
        fullExtent: expandFullExtent,
      });
      setExpandResult({ chunksAdded: res.chunks_added, totalChunks: res.total_chunks });
    } catch (e) {
      setError(String(e));
    } finally {
      setExpandInProgress(false);
      setExpandProgress(100);
    }
  }

const handleSelectionChange = useCallback((bounds: SelectionBounds | null) => {
    setRawBounds(bounds);
  }, []);

  async function saveWorld(path: string) {
    setSaving(true);
    setError(null);
    try {
      await invoke("save_world", { path, compressed: saveCompressed });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveWorldAs() {
    const chosen = await save({
      filters: [{ name: "Eden World", extensions: ["eden", "zip"] }],
      defaultPath: sourcePath ?? undefined,
    });
    if (!chosen) return;
    await saveWorld(chosen);
    setSourcePath(chosen);
  }

  async function savePrefab() {
    const path = await save({
      filters: [{ name: "Eden Prefab", extensions: ["epfab"] }],
      defaultPath: `${world?.name ?? "prefab"}.epfab`,
    });
    if (!path) return;
    await invoke("save_prefab", { path }).catch((e) => setError(String(e)));
  }

  async function loadPrefab() {
    const path = await open({
      filters: [{ name: "Eden Prefab", extensions: ["epfab"] }],
      multiple: false,
    });
    if (!path || typeof path !== "string") return;
    const info = await invoke<ClipboardInfo>("load_prefab", { path })
      .catch((e: unknown) => { setError(String(e)); return null; });
    if (!info) return;
    setClipboard(info);
    setTool("paste");
  }

  async function importSchematic() {
    const path = await open({
      filters: [{ name: "Minecraft Schematic / Sponge / Litematica", extensions: ["schematic", "schem", "litematic"] }],
      multiple: false,
    });
    if (!path || typeof path !== "string") return;
    const info = await invoke<SchematicInfo>("import_schematic_info", { path })
      .catch((e: unknown) => { setError(String(e)); return null; });
    if (!info) return;
    setSchematicPath(path);
    setSchematicInfo(info);
  }

  async function applySchematic(mapping: MappingEntry[]) {
    if (!schematicPath) return;
    setSchematicApplying(true);
    try {
      const info = await invoke<ClipboardInfo>("import_schematic_apply", {
        path: schematicPath, mapping,
      });
      setClipboard(info);
      setTool("paste");
      setSchematicInfo(null);
      setSchematicPath(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSchematicApplying(false);
    }
  }

  async function deleteBlocks() {
    if (!rawBounds) return;
    try {
      const result = filterBlockType !== null
        ? await invoke<EditResultRaw>("replace_blocks", {
            ...rawBounds, zMin, zMax,
            newBlockType: 0, newPaint: 0,
            filterBlockType, filterPaint, filterInvert,
          })
        : await invoke<EditResultRaw>("delete_blocks", { ...rawBounds, zMin, zMax });
      await applyEditResult(result);
    } catch (e) {
      setError(String(e));
    }
  }

  async function fillSelection() {
    if (!rawBounds) return;
    try {
      const result = await invoke<EditResultRaw>("replace_blocks", {
        ...rawBounds, zMin, zMax,
        newBlockType: fillBlockType,
        newPaint: fillBlockType === 0 ? 0 : fillPaint,
        filterBlockType,
        filterPaint,
        filterInvert,
      });
      await applyEditResult(result);
    } catch (e) {
      setError(String(e));
    }
  }

  function handleZMin(raw: string) {
    const v = Math.max(0, Math.min(world?.max_z ?? 63, parseInt(raw, 10) || 0));
    setZMin(Math.min(v, zMax));
  }

  function handleZMax(raw: string) {
    const v = Math.max(0, Math.min(world?.max_z ?? 63, parseInt(raw, 10) || 0));
    setZMax(Math.max(v, zMin));
  }

  function closeWorld() {
    setWorld(null);
    setSourcePath(null);
    setRawBounds(null);
    setClipboard(null);
    setUndoDepth(0);
    setRedoDepth(0);
    setTool("pan");
    setSpawnPos(null);
    setTemplateLoaded(false);
    setShowTemplateOverlay(false);
  }

  async function setSpawnAtSelection() {
    if (!selection) return;
    const cx = Math.round((selection.x1 + selection.x2) / 2);
    const cy = Math.round((selection.y1 + selection.y2) / 2);
    try {
      await invoke("set_spawn_pos", { px: cx, py: cy });
      setSpawnPos({ px: cx, py: cy });
    } catch (e) { setError(String(e)); }
  }

  async function onRenameBlur(trimmed: string) {
    if (trimmed && world && trimmed !== world.name) {
      try {
        await invoke("rename_world", { name: trimmed });
        setWorld(w => w ? { ...w, name: trimmed } : null);
      } catch (e) { setError(String(e)); }
    }
    setRenamingWorld(false);
  }

  const pastePreviewSelection: SelectionInfo | null =
    lockedPastePos && clipboard
      ? {
          x1: lockedPastePos.x,
          y1: lockedPastePos.y,
          x2: lockedPastePos.x + clipboard.width - 1,
          y2: lockedPastePos.y + clipboard.height - 1,
          z_min: clipboard.z_anchor + pasteElevationOffset,
          z_max: clipboard.z_anchor + pasteElevationOffset + clipboard.depth - 1,
          width: clipboard.width,
          height: clipboard.height,
          depth: clipboard.depth,
        }
      : null;

  const isSculptTool = tool === "smooth" || tool === "noise" || tool === "flatten" || tool === "erode";
  const isDrawTool = tool === "pen" || tool === "brush" || tool === "rect" || tool === "ellipse" || isSculptTool || tool === "fill";

  const mapPaneEl = world ? (
    <MapCanvas
      ref={mapCanvasRef}
      world={world}
      worldEpoch={worldEpoch}
      tool={tool}
      viewMode={viewMode}
      zSliceZ={zSliceZ}
      committedSelection={rawBounds}
      onSelectionChange={handleSelectionChange}
      pastePreview={clipboard && tool === "paste"
        ? { width: clipboard.width, height: clipboard.height }
        : null}
      clipboardPreviewPixels={tool === "paste" ? clipboardPreviewPixels : null}
      onPasteAt={handlePasteClick}
      lockedPastePos={lockedPastePos}
      renderMode={renderMode}
      axoSkew={axoSkew}
      sliceLines={showSlicePanels ? { x: sliceSideX, y: sliceFrontY } : null}
      drawConfig={{ brushSize, brushShape, fillMode: drawFilled ? "fill" : "outline" }}
      onDrawStroke={handleDrawStroke}
      drawZOverride={viewMode === "zslice" ? zSliceZ : null}
      extrudePreview={
        extrudeOpen && extrudeCount > 0 && rawBounds && (extrudeAxis.startsWith("x") || extrudeAxis.startsWith("y"))
          ? { axis: extrudeAxis, count: extrudeCount }
          : null
      }
      lastPasteDelta={lastPasteDelta}
      onCursorMove={handleCursorMove}
      onMagicWand={handleMagicWand}
      spawnPos={spawnPos}
      creatures={[]}
      pasteElevationOffset={pasteElevationOffset}
      onEyedropper={handleEyedropper}
      cameraPos3d={showSlicePanels && enable3dPane ? cam3dPos : null}
      onSetCamera3d={showSlicePanels && enable3dPane ? (wx, wy) => flyView3dRef.current?.teleport(wx, wy) : undefined}
      showTemplateOverlay={showTemplateOverlay && templateLoaded}
      onMapContextMenu={(wx, wy, x, y) => setCtxMenu({ wx, wy, x, y })}
    />
  ) : null;

  // Status bar element — computed outside JSX so TypeScript narrows `world` properly
  const statusBarEl = world ? (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, height: 20, zIndex: 150,
      background: "linear-gradient(to bottom, #081020, #060c18)",
      borderTop: "1px solid #1a2540",
      display: "flex", alignItems: "center",
      fontSize: 10, color: "#475569", userSelect: "none",
      fontVariantNumeric: "tabular-nums",
    }}>
      <div style={{ padding: "0 10px", borderRight: "1px solid #1a2540", whiteSpace: "nowrap", color: "#4b6280" }}>
        {tool === "brush" ? `Brush ${brushSize}px` : tool === "pen" ? "Pen" : tool === "rect" ? "Rect" : tool === "ellipse" ? "Ellipse" : tool === "fill" ? "Fill" : tool === "eyedropper" ? "Eyedropper" : tool === "wand" ? "Wand" : tool === "paste" ? (pasteMode !== "normal" ? `Paste (${pasteMode})` : "Paste") : tool === "select" ? "Select" : tool === "smooth" ? "Smooth" : tool === "noise" ? "Noise" : tool === "flatten" ? "Flatten" : tool === "erode" ? "Erode" : "Pan"}
      </div>
      <div style={{ padding: "0 10px", borderRight: "1px solid #1a2540", color: "#334155", whiteSpace: "nowrap" }}>
        {world.name}
      </div>
      <div style={{ padding: "0 10px", borderRight: "1px solid #1a2540", whiteSpace: "nowrap" }}>
        {world.width_chunks * 16}×{world.height_chunks * 16}
        <span style={{ color: world.max_z === 255 ? "#6d28d9" : "#1e3a5f", marginLeft: 6 }}>
          {world.max_z === 255 ? "256z" : "64z"}
        </span>
      </div>
      <div style={{ padding: "0 10px", borderRight: "1px solid #1a2540", minWidth: 100, whiteSpace: "nowrap" }}>
        {cursorPos
          ? <>X <span style={{ color: "#64748b" }}>{Math.round(cursorPos.wx)}</span>{"  "}Y <span style={{ color: "#64748b" }}>{Math.round(cursorPos.wy)}</span></>
          : <span style={{ color: "#1e293b" }}>X — Y —</span>
        }
      </div>
      {cursorBlock && (
        <div style={{ padding: "0 10px", borderRight: "1px solid #1a2540", whiteSpace: "nowrap" }}>
          Z <span style={{ color: "#64748b" }}>{cursorBlock.z}</span>
          {"  "}<span style={{ color: "#475569" }}>{blockDisplayName(cursorBlock.bt)}{cursorBlock.paint > 0 ? <span style={{ color: "#334155" }}> #{cursorBlock.paint}</span> : null}</span>
        </div>
      )}
      {selection && (
        <div style={{ padding: "0 10px", borderRight: "1px solid #1a2540", color: "#4b6280", whiteSpace: "nowrap" }}>
          Sel <span style={{ color: "#64748b" }}>{selection.width}×{selection.height}</span>
          {" · Z "}<span style={{ color: "#4b6280" }}>{selection.z_min}–{selection.z_max}</span>
        </div>
      )}
      <div style={{ padding: "0 10px", borderRight: "1px solid #1a2540", whiteSpace: "nowrap" }}>
        ↩ <span style={{ color: "#334155" }}>{undoDepth}</span>
        {"  "}↪ <span style={{ color: "#334155" }}>{redoDepth}</span>
      </div>
      {filterBlockType !== null && (
        <div style={{ padding: "0 8px", borderRight: "1px solid #1a2540", whiteSpace: "nowrap",
          color: "#f59e0b", background: "rgba(245,158,11,0.07)" }}>
          Filter: {blockDisplayName(filterBlockType)}{filterPaint !== null ? ` #${filterPaint}` : ""}{filterInvert ? " (inv)" : ""}
        </div>
      )}
      {maskEnabled && maskBlockType !== null && (
        <div style={{ padding: "0 8px", borderRight: "1px solid #1a2540", whiteSpace: "nowrap",
          color: "#a78bfa", background: "rgba(167,139,250,0.07)" }}>
          Mask: {blockDisplayName(maskBlockType)}{maskPaint !== null ? ` #${maskPaint}` : ""}
        </div>
      )}
      <div style={{ flex: 1 }} />
      <div style={{ padding: "0 10px", borderLeft: "1px solid #1a2540", color: "#2d4060", whiteSpace: "nowrap" }}>
        {fps} fps
      </div>
    </div>
  ) : null;

  if (world) {
    const sliceDrawTool = (["pen","brush","rect","ellipse"] as const).find(t => t === tool);
    // Active region shown on the slabs: the paste footprint (preview) or the current selection.
    const sliceIsPaste = pastePreviewSelection != null;
    const sliceSel = pastePreviewSelection
      ?? (rawBounds ? { x1: rawBounds.x1, y1: rawBounds.y1, x2: rawBounds.x2, y2: rawBounds.y2, z_min: zMin, z_max: zMax } : null);
    const sliceSelZ = sliceSel ? { min: sliceSel.z_min, max: sliceSel.z_max } : null;
    const sliceExtrudeCount = sliceIsPaste ? 0 : (extrudeOpen && extrudeCount > 0 ? extrudeCount : 0);
    const sliceZResize = sliceIsPaste ? undefined : (a: number, b: number) => { setZMin(a); setZMax(b); };
    const sliceHResizeFront = sliceIsPaste ? undefined : (lo: number, hi: number) => setRawBounds(rb => rb ? { ...rb, x1: lo, x2: hi } : rb);
    const sliceHResizeSide = sliceIsPaste ? undefined : (lo: number, hi: number) => setRawBounds(rb => rb ? { ...rb, y1: lo, y2: hi } : rb);
    // Marquee-select on a slab: front sets X+Z (Y kept, or pinned to the slab's depth for a fresh
    // selection); side sets Y+Z (X kept / pinned). The orthogonal extent is then adjustable via the
    // other slab's divider or the top-down map.
    const sliceSelectMode = !sliceIsPaste && tool === "select";
    const sliceSelectFront = sliceSelectMode
      ? (xLo: number, xHi: number, zLo: number, zHi: number) => {
          setRawBounds(rb => rb ? { ...rb, x1: xLo, x2: xHi } : { x1: xLo, y1: sliceFrontY, x2: xHi, y2: sliceFrontY });
          setZMin(zLo); setZMax(zHi);
        }
      : undefined;
    const sliceSelectSide = sliceSelectMode
      ? (yLo: number, yHi: number, zLo: number, zHi: number) => {
          setRawBounds(rb => rb ? { ...rb, y1: yLo, y2: yHi } : { x1: sliceSideX, y1: yLo, x2: sliceSideX, y2: yHi });
          setZMin(zLo); setZMax(zHi);
        }
      : undefined;
    const sliceCommon = {
      world,
      editEpoch,
      lastEdit: lastEditBounds,
      brush: { size: tool === "brush" ? brushSize : 1, shape: brushShape },
      tool: sliceDrawTool,
      fill: drawFilled,
      onPaint: sliceDrawTool ? handleSlicePaint : undefined,
      selZ: sliceSelZ,
      extrudeCount: sliceExtrudeCount,
      extrudeAxis,
      isPaste: sliceIsPaste,
      onZRangeChange: sliceZResize,
      selectMode: sliceSelectMode,
    };
    return (
      <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
        {showSlicePanels ? (
          // Quad view: the real top-down map (top-left) + Front / Side slices + 3D placeholder.
          // Top strip is left clear for the floating menu/toolbar chrome.
          <div style={{
            position: "absolute", inset: 0, paddingTop: effectiveRibbonHeight,
            display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr",
            gap: 2, background: "#0a0f1e",
          }}>
            <div style={{ position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden", outline: "1px solid #1e293b" }}>
              {mapPaneEl}
            </div>
            <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden", outline: "1px solid #1e293b" }}>
              <ErrorBoundary label="Front view">
                <SliceViewport {...sliceCommon} axis="front"
                  depth={sliceFrontY} onDepthChange={setSliceFrontY}
                  crossH={sliceSideX} crossV={zSliceZ}
                  selRange={sliceSel ? { lo: sliceSel.x1, hi: sliceSel.x2 } : null}
                  selFull={!sliceIsPaste && sliceSel ? { xLo: sliceSel.x1, yLo: sliceSel.y1, xHi: sliceSel.x2, yHi: sliceSel.y2, zLo: sliceSel.z_min, zHi: sliceSel.z_max } : null}
                  onHRangeChange={sliceHResizeFront} onSelect={sliceSelectFront} />
              </ErrorBoundary>
            </div>
            <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden", outline: "1px solid #1e293b" }}>
              <ErrorBoundary label="Side view">
                <SliceViewport {...sliceCommon} axis="side"
                  depth={sliceSideX} onDepthChange={setSliceSideX}
                  crossH={sliceFrontY} crossV={zSliceZ}
                  selRange={sliceSel ? { lo: sliceSel.y1, hi: sliceSel.y2 } : null}
                  selFull={!sliceIsPaste && sliceSel ? { xLo: sliceSel.x1, yLo: sliceSel.y1, xHi: sliceSel.x2, yHi: sliceSel.y2, zLo: sliceSel.z_min, zHi: sliceSel.z_max } : null}
                  onHRangeChange={sliceHResizeSide} onSelect={sliceSelectSide} />
              </ErrorBoundary>
            </div>
            <div style={{ position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden", outline: "1px solid #1e293b" }}>
              {enable3dPane ? (
                <>
                  <ErrorBoundary label="3D view">
                    <FlyView3D
                      ref={flyView3dRef}
                      world={world}
                      // Spawn the camera over real geometry: prefer the world's home/spawn point,
                      // else the centroid of populated chunks (robust for sparse worlds whose
                      // bounding-box centre is empty). Both are local block coords.
                      spawnAt={
                        spawnPos ? { x: spawnPos.px, y: spawnPos.py }
                          : (world.center_px != null && world.center_py != null
                            ? { x: world.center_px, y: world.center_py } : undefined)
                      }
                      editEpoch={editEpoch}
                      lastEdit={lastEditBounds}
                      onFlyModeChange={(a) => { flyActiveRef.current = a; }}
                      onCameraMove={(wx, wy) => setCam3dPos({ x: wx, y: wy })}
                      overlays3d={overlays3d}
                      texturePack={texturePackInfo}
                      texEpoch={texEpoch}
                    />
                  </ErrorBoundary>
                  <button
                    onClick={() => setEnable3dPane(false)}
                    title="Disable the 3D pane (saves performance)"
                    style={{
                      position: "absolute", top: 36, right: 6, zIndex: 2,
                      background: "rgba(15,23,42,0.85)", color: "#94a3b8", border: "1px solid #334155",
                      borderRadius: 4, padding: "1px 7px", fontSize: 11, cursor: "pointer",
                    }}
                  >✕ 3D</button>
                </>
              ) : (
                // Off by default — the 3D pane is the heaviest viewport. Opt in here.
                <div style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  gap: 10, width: "100%", height: "100%", background: "#0a0f1e", color: "#64748b",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, letterSpacing: "0.04em" }}>
                    3D FLY-THROUGH
                    <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>exp</span>
                  </div>
                  <button
                    onClick={() => setEnable3dPane(true)}
                    style={{
                      background: "#1e293b", color: "#cbd5e1", border: "1px solid #475569",
                      borderRadius: 6, padding: "6px 14px", fontSize: 12, cursor: "pointer",
                    }}
                  >Enable 3D view</button>
                  <div style={{ fontSize: 10, color: "#475569", maxWidth: 220, textAlign: "center" }}>
                    Off by default to save performance. Streams chunk geometry around the camera.
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : mapPaneEl}


        <Ribbon
          world={world}
          appVersion={appVersion}
          renamingWorld={renamingWorld}
          renameInput={renameInput}
          renameInputRef={renameInputRef}
          setRenamingWorld={setRenamingWorld}
          setRenameInput={setRenameInput}
          onRenameBlur={onRenameBlur}
          tool={tool}
          setTool={setTool}
          isDrawTool={isDrawTool}
          isSculptTool={isSculptTool}
          wandMatchPaint={wandMatchPaint}
          setWandMatchPaint={setWandMatchPaint}
          undoDepth={undoDepth}
          redoDepth={redoDepth}
          handleUndo={handleUndo}
          handleRedo={handleRedo}
          brushSize={brushSize}
          setBrushSize={setBrushSize}
          brushShape={brushShape}
          setBrushShape={setBrushShape}
          drawFilled={drawFilled}
          setDrawFilled={setDrawFilled}
          drawAbove={drawAbove}
          setDrawAbove={setDrawAbove}
          sculptStrength={sculptStrength}
          setSculptStrength={setSculptStrength}
          prevToolRef={prevToolRef}
          fillBlockType={fillBlockType}
          fillPaint={fillPaint}
          setFillBlockType={setFillBlockType}
          setFillPaint={setFillPaint}
          pinnedBlocks={pinnedBlocks}
          recentBlocks={recentBlocks}
          hotbarHover={hotbarHover}
          setPinnedBlocks={setPinnedBlocks}
          setHotbarHover={setHotbarHover}
          maskEnabled={maskEnabled}
          setMaskEnabled={setMaskEnabled}
          maskBlockType={maskBlockType}
          setMaskBlockType={setMaskBlockType}
          maskPaint={maskPaint}
          setMaskPaint={setMaskPaint}
          zMin={zMin}
          zMax={zMax}
          handleZMin={handleZMin}
          handleZMax={handleZMax}
          viewMode={viewMode}
          setViewMode={setViewMode}
          zSliceZ={zSliceZ}
          zSliceDisplay={zSliceDisplay}
          setZSliceDisplay={setZSliceDisplay}
          commitZSlice={commitZSlice}
          followSurface={followSurface}
          setFollowSurface={setFollowSurface}
          renderMode={renderMode}
          setRenderMode={setRenderMode}
          axoSkew={axoSkew}
          setAxoSkew={setAxoSkew}
          showSlicePanels={showSlicePanels}
          setShowSlicePanels={setShowSlicePanels}
          enable3dPane={enable3dPane}
          setEnable3dPane={setEnable3dPane}
          onFitMap={() => mapCanvasRef.current?.resetView()}
          templateLoaded={templateLoaded}
          templatePath={templatePath}
          showTemplateOverlay={showTemplateOverlay}
          setShowTemplateOverlay={setShowTemplateOverlay}
          openTemplateFile={openTemplateFile}
          texturePackLoaded={texturePackInfo !== null}
          texturePackPath={texturePackPath}
          texturePack={texturePackInfo}
          openTexturePackFile={openTexturePackFile}
          unloadTexturePack={unloadTexturePack}
          spawnPos={spawnPos}
          onSetSpawnAtSelection={setSpawnAtSelection}
          onShowWorldInfo={() => setShowWorldInfo(true)}
          selection={selection}
          rawBounds={rawBounds}
          setRawBounds={setRawBounds}
          copySelection={copySelection}
          deleteBlocks={deleteBlocks}
          fillSelection={fillSelection}
          filterBlockType={filterBlockType}
          filterPaint={filterPaint}
          filterInvert={filterInvert}
          setFilterBlockType={setFilterBlockType}
          setFilterPaint={setFilterPaint}
          setFilterInvert={setFilterInvert}
          clipboard={clipboard}
          pasteElevationOffset={pasteElevationOffset}
          setPasteElevationOffset={setPasteElevationOffset}
          pasteIgnoreAir={pasteIgnoreAir}
          setPasteIgnoreAir={setPasteIgnoreAir}
          pasteTerrain={pasteTerrain}
          setPasteTerrain={setPasteTerrain}
          pasteTerrainAbove={pasteTerrainAbove}
          setPasteTerrainAbove={setPasteTerrainAbove}
          persistPaste={persistPaste}
          setPersistPaste={setPersistPaste}
          lockedPastePos={lockedPastePos}
          setLockedPastePos={setLockedPastePos}
          pasteMode={pasteMode}
          setPasteMode={setPasteMode}
          scatterCount={scatterCount}
          setScatterCount={setScatterCount}
          arrayCols={arrayCols}
          setArrayCols={setArrayCols}
          arrayRows={arrayRows}
          setArrayRows={setArrayRows}
          arraySpacingX={arraySpacingX}
          setArraySpacingX={setArraySpacingX}
          arraySpacingY={arraySpacingY}
          setArraySpacingY={setArraySpacingY}
          rotateClipboard={rotateClipboard}
          mirrorClipboardX={mirrorClipboardX}
          mirrorClipboardY={mirrorClipboardY}
          pasteAt={pasteAt}
          sourcePath={sourcePath}
          saving={saving}
          exporting={exporting}
          exportingObj={exportingObj}
          exportingJson={exportingJson}
          saveCompressed={saveCompressed}
          setSaveCompressed={setSaveCompressed}
          recentWorlds={recentWorlds}
          openFile={openFile}
          openFileAt={openFileAt}
          saveWorld={saveWorld}
          saveWorldAs={saveWorldAs}
          exportPng={exportPng}
          exportObj={exportObj}
          exportJson={exportJson}
          loadPrefab={loadPrefab}
          importSchematic={importSchematic}
          setShowNewWorld={setShowNewWorld}
          setShowWorldBrowser={setShowWorldBrowser}
          setShowUploadModal={setShowUploadModal}
          setShowExpandModal={setShowExpandModal}
          setExpandResult={setExpandResult}
          closeWorld={closeWorld}
          setShowHelp={setShowHelp}
          setShowAbout={setShowAbout}
          setShowSettings={setShowSettings}
          onSavePrefab={savePrefab}
          extrudeCount={extrudeCount}
          setExtrudeCount={setExtrudeCount}
          extrudeAxis={extrudeAxis}
          setExtrudeAxis={setExtrudeAxis}
          extrudeOpen={extrudeOpen}
          setExtrudeOpen={setExtrudeOpen}
          onExtrude={handleExtrude}
          treeTypes={treeTypes}
          setTreeTypes={setTreeTypes}
          treeDensity={treeDensity}
          setTreeDensity={setTreeDensity}
          leafPaints={leafPaints}
          setLeafPaints={setLeafPaints}
          smartPlacement={smartPlacement}
          setSmartPlacement={setSmartPlacement}
          onGenerateTrees={handleGenerateTrees}
          collapsed={ribbonCollapsed}
          onCollapse={(v) => { setRibbonCollapsed(v); try { localStorage.setItem("ribbon_collapsed", String(v)); } catch {} }}
          ribbonBodyHeight={ribbonBodyHeight}
          onBodyHeightChange={(h) => {
            const clamped = Math.max(60, Math.min(240, h));
            setRibbonBodyHeight(clamped);
            try { localStorage.setItem("ribbon_body_height", String(clamped)); } catch {}
          }}
        />

        {/* Right panel: Selection Inspector (ortho view only) */}
        {selection && (
          <SelectionInspector
            selection={selection}
            clipboard={clipboard}
            quadMode={showSlicePanels}
            topPx={effectiveRibbonHeight + (showSlicePanels ? 40 : 4)}
          />
        )}

        {/* Bottom-right panel: full-height elevation view — opt-in; redundant in quad view (the slabs
            now carry its overlays), so it's suppressed while quad view is open. */}
        {!showSlicePanels && (pastePreviewSelection || selection) && (
          <ElevationPreviewPanel
            selection={pastePreviewSelection ?? selection!}
            maxZ={world.max_z}
            extrudeCount={pastePreviewSelection ? 0 : (extrudeOpen && extrudeCount > 0 ? extrudeCount : 0)}
            extrudeAxis={extrudeAxis}
            isPastePreview={pastePreviewSelection !== null}
            editEpoch={editEpoch}
            drawActive={["pen","brush","rect","ellipse"].includes(tool)}
            onDrawElevation={handleDrawElevation}
            onZRangeChange={pastePreviewSelection ? undefined : (zMin, zMax) => { setZMin(zMin); setZMax(zMax); }}
          />
        )}

        {(exporting || exportingObj || exportingJson || loading) && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.45)", zIndex: 200, pointerEvents: "none",
          }}>
            <div style={{
              background: "rgba(15,23,42,0.95)", border: "1px solid #334155",
              borderRadius: 10, padding: "20px 32px", minWidth: 220, textAlign: "center",
            }}>
              {exporting ? (
                <>
                  <div style={{ color: "#e2e8f0", fontSize: 14, marginBottom: 12 }}>
                    Exporting PNG… {exportProgress !== null ? `${Math.round(exportProgress * 100)}%` : ""}
                  </div>
                  <div style={{ background: "#1e293b", borderRadius: 4, height: 6, overflow: "hidden" }}>
                    <div style={{
                      background: "#f59e0b", height: "100%", borderRadius: 4,
                      width: `${Math.round((exportProgress ?? 0) * 100)}%`,
                      transition: "width 0.1s ease",
                    }} />
                  </div>
                </>
              ) : exportingObj ? (
                <div style={{ color: "#e2e8f0", fontSize: 14 }}>Exporting OBJ…</div>
              ) : exportingJson ? (
                <div style={{ color: "#e2e8f0", fontSize: 14 }}>Exporting JSON…</div>
              ) : exportingVox ? (
                <>
                  <div style={{ color: "#e2e8f0", fontSize: 14, marginBottom: 8 }}>
                    Exporting VOX… {voxProgress ? `${voxProgress.pct}%` : ""}
                  </div>
                  {voxProgress && (
                    <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 8 }}>
                      {voxProgress.phase}
                    </div>
                  )}
                  <div style={{ background: "#1e293b", borderRadius: 4, height: 6, overflow: "hidden" }}>
                    <div style={{
                      background: "#f59e0b", height: "100%", borderRadius: 4,
                      width: `${voxProgress?.pct ?? 0}%`,
                      transition: "width 0.15s ease",
                    }} />
                  </div>
                </>
              ) : (
                <div style={{ color: "#e2e8f0", fontSize: 14 }}>Loading world…</div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div style={{
            position: "absolute", bottom: 16, right: 12,
            background: "rgba(0,0,0,0.7)", color: "#f87171",
            padding: "6px 12px", borderRadius: 6, fontSize: 13, maxWidth: 360,
          }}>
            {error}
          </div>
        )}

        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
        {showAbout && <AboutModal version={appVersion} onClose={() => setShowAbout(false)} />}
        {showWorldInfo && <WorldInfoModal onClose={() => setShowWorldInfo(false)} />}
        {showSettings && (
          <SettingsModal
            onClose={() => setShowSettings(false)}
            onSave={(s) => {
              setSaveCompressed(s.defaultSaveCompressed);
              if (s.templatePath !== templatePath) setTemplatePath(s.templatePath);
              if (s.texturePackPath !== texturePackPath) {
                if (s.texturePackPath) loadTexturePackFile(s.texturePackPath);
                else unloadTexturePack();
              }
            }}
          />
        )}

        {showWorldBrowser && (
          <WorldBrowserModal
            onClose={() => setShowWorldBrowser(false)}
            onOpenWorld={(path) => { setShowWorldBrowser(false); openFileAt(path); }}
          />
        )}
        {showUploadModal && (
          <UploadModal
            sourcePath={sourcePath}
            onClose={() => setShowUploadModal(false)}
          />
        )}
        {showNewWorld && (
          <NewWorldModal
            onClose={() => setShowNewWorld(false)}
            onCreated={(path) => { setShowNewWorld(false); openFileAt(path); }}
          />
        )}
        {schematicInfo && schematicPath && (
          <SchematicImportModal
            info={schematicInfo}
            path={schematicPath}
            applying={schematicApplying}
            onApply={(mapping) => applySchematic(mapping)}
            onCancel={() => { setSchematicInfo(null); setSchematicPath(null); }}
          />
        )}

        {/* Sky Editor and Creature Viewer panels — implemented, hidden pending testing */}

        {/* Expand from Template modal */}
        {showExpandModal && (
          <div style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex",
            alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}>
            <div style={{
              background: "#0d1829", border: "1px solid #1e40af", borderRadius: 10,
              padding: "24px 28px", minWidth: 360, maxWidth: 440,
              boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
            }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#e2e8f0", marginBottom: 12 }}>
                Expand from Template
              </div>
              {!expandInProgress && expandResult === null && (
                <>
                  <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16, lineHeight: 1.5 }}>
                    Fills missing chunks from Eden.eden into a new world file. Your edits are preserved.
                    Output can be ~1 GB for the full template.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", color: "#e2e8f0", fontSize: 13 }}>
                      <input
                        type="radio" name="extentMode" checked={expandFullExtent}
                        onChange={() => setExpandFullExtent(true)}
                        style={{ accentColor: "#3b82f6" }}
                      />
                      Full world (180×180 chunks, ~1 GB)
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", color: "#e2e8f0", fontSize: 13 }}>
                      <input
                        type="radio" name="extentMode" checked={!expandFullExtent}
                        onChange={() => setExpandFullExtent(false)}
                        style={{ accentColor: "#3b82f6" }}
                      />
                      Within current world bounds only
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => setShowExpandModal(false)} style={{
                      padding: "6px 14px", borderRadius: 6, border: "1px solid #334155",
                      background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 13,
                    }}>
                      Cancel
                    </button>
                    <button onClick={runExpand} style={{
                      padding: "6px 14px", borderRadius: 6, border: "none",
                      background: "#1d4ed8", color: "#e2e8f0", cursor: "pointer", fontSize: 13,
                    }}>
                      Choose Output File & Expand
                    </button>
                  </div>
                </>
              )}
              {expandInProgress && (
                <>
                  <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>
                    Writing chunks… {expandProgress}%
                  </div>
                  <div style={{ background: "#1e293b", borderRadius: 4, height: 8, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", background: "#3b82f6", borderRadius: 4,
                      width: `${expandProgress}%`, transition: "width 0.2s",
                    }} />
                  </div>
                </>
              )}
              {expandResult !== null && !expandInProgress && (
                <>
                  <div style={{ fontSize: 13, color: "#86efac", marginBottom: 16 }}>
                    Done — {expandResult.chunksAdded.toLocaleString()} chunks added
                    ({expandResult.totalChunks.toLocaleString()} total).
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => setShowExpandModal(false)} style={{
                      padding: "6px 14px", borderRadius: 6, border: "1px solid #334155",
                      background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 13,
                    }}>
                      Close
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Map right-click context menu */}
        {ctxMenu && (() => {
          const close = () => setCtxMenu(null);
          const ic = (ch: string) => <span style={{ display: "inline-block", width: 18, textAlign: "center", color: "#64748b", flexShrink: 0 }}>{ch}</span>;
          const noIc = () => <span style={{ display: "inline-block", width: 18, flexShrink: 0 }} />;
          const miBtnStyle: React.CSSProperties = {
            display: "flex", alignItems: "center", gap: 0,
            width: "100%", textAlign: "left", background: "none", border: "none",
            color: "#e2e8f0", padding: "5px 12px 5px 8px", fontSize: 12, cursor: "pointer",
            whiteSpace: "nowrap",
          };
          const miHov = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "#1e293b"; };
          const miLve = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = ""; };
          const div = <div style={{ height: 1, background: "#1e293b", margin: "3px 0" }} />;
          const menuY = Math.min(ctxMenu.y, window.innerHeight - 260);
          return (
            <div
              style={{
                position: "fixed", top: menuY, left: ctxMenu.x, zIndex: 9000,
                background: "#0d1829", border: "1px solid #1e40af",
                borderRadius: 6, padding: "4px 0", minWidth: 210,
                boxShadow: "0 8px 24px rgba(0,0,0,0.7)",
              }}
              onMouseDown={e => e.stopPropagation()}
              onContextMenu={e => e.preventDefault()}
            >
              <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); invoke<[number,number]>("set_spawn_pos", { px: Math.round(ctxMenu.wx), py: Math.round(ctxMenu.wy) }).then(([px, py]) => setSpawnPos({ px, py })).catch(() => {}); }}>
                {ic("⌂")} Set Spawn Here
              </button>
              {div}
              {rawBounds && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); copySelection(); }}>
                {ic("⊡")} Copy
              </button>}
              {clipboard && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); setLockedPastePos({ x: Math.round(ctxMenu.wx), y: Math.round(ctxMenu.wy) }); setTool("paste"); }}>
                {ic("⊞")} Paste Here
              </button>}
              {rawBounds && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); fillSelection(); }}>
                {noIc()} Fill Selection
              </button>}
              {rawBounds && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); deleteBlocks(); }}>
                {noIc()} Delete Blocks
              </button>}
              {rawBounds && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); setRawBounds(null); }}>
                {ic("✕")} Clear Selection
              </button>}
              {showSlicePanels && enable3dPane && <>{div}
                <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                  onClick={() => { close(); flyView3dRef.current?.teleport(ctxMenu.wx, ctxMenu.wy); }}>
                  {noIc()} Teleport 3D Camera Here
                </button>
              </>}
              {div}
              <button style={{ ...miBtnStyle, color: tool === "select" ? "#93c5fd" : "#e2e8f0" }} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); setTool("select"); }}>
                {noIc()} Select Tool
              </button>
              <button style={{ ...miBtnStyle, color: tool === "pen" ? "#f9a8d4" : "#e2e8f0" }} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); setTool("pen"); }}>
                {noIc()} Pen Tool
              </button>
              <button style={{ ...miBtnStyle, color: tool === "pan" ? "#93c5fd" : "#e2e8f0" }} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); setTool("pan"); }}>
                {noIc()} Pan Tool
              </button>
            </div>
          );
        })()}

        {/* Status bar */}
        {statusBarEl}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0f1117" }}>
      {/* Left panel */}
      <div style={{
        width: 560, minWidth: 400, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", padding: "48px 56px",
        gap: 0, background: "#13161f",
      }}>
        {/* App icon */}
        <img
          src={appIcon}
          alt="VuencEdit"
          style={{ width: 120, height: 120, borderRadius: 24, marginBottom: 20, imageRendering: "pixelated" }}
        />
        {/* Title */}
        <div style={{ fontSize: 36, letterSpacing: -0.5, lineHeight: 1 }}>
          <span style={{ fontWeight: 800, color: "#ffffff" }}>Vuenc</span>
          <span style={{ fontWeight: 400, color: "#cbd5e1" }}>Edit</span>
        </div>
        <div style={{ fontSize: 13, color: "#4b5568", marginBottom: 28, marginTop: 6 }}>v{appVersion}</div>

        {/* Action buttons */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 480 }}>
          {/* New World */}
          <button
            onClick={() => setShowNewWorld(true)}
            disabled={loading}
            style={{
              display: "flex", alignItems: "center", gap: 16,
              background: "#1a3a2e", border: "1px solid #2d5a44",
              borderRadius: 10, padding: "14px 20px",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1, textAlign: "left", width: "100%",
            }}
          >
            <span style={{ fontSize: 28, lineHeight: 1 }}>✏️</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>New World</div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2 }}>Create a new world file</div>
            </div>
          </button>

          {/* Open World */}
          <button
            onClick={openFile}
            disabled={loading}
            style={{
              display: "flex", alignItems: "center", gap: 16,
              background: "#1e2330", border: "1px solid #2d3448",
              borderRadius: 10, padding: "14px 20px",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1, textAlign: "left", width: "100%",
            }}
          >
            <span style={{ fontSize: 28, lineHeight: 1 }}>🗂️</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>
                {loading ? "Loading…" : "Open World"}
              </div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2 }}>Open a local world file</div>
            </div>
          </button>

          {/* Browse Worlds */}
          <button
            onClick={() => setShowWorldBrowser(true)}
            disabled={loading}
            style={{
              display: "flex", alignItems: "center", gap: 16,
              background: "#1e2330", border: "1px solid #2d3448",
              borderRadius: 10, padding: "14px 20px",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1, textAlign: "left", width: "100%",
            }}
          >
            <span style={{ fontSize: 28, lineHeight: 1 }}>🔍</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>Browse Worlds</div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2 }}>Browse shared worlds</div>
            </div>
          </button>

          {/* Settings */}
          <button
            onClick={() => setShowSettings(true)}
            style={{
              display: "flex", alignItems: "center", gap: 14,
              background: "none", border: "1px solid #1e2333",
              borderRadius: 8, padding: "9px 16px",
              cursor: "pointer", textAlign: "left", width: "100%",
              color: "#64748b",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#2d3448"; (e.currentTarget as HTMLElement).style.color = "#94a3b8"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#1e2333"; (e.currentTarget as HTMLElement).style.color = "#64748b"; }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>⚙</span>
            <span style={{ fontSize: 13 }}>Settings</span>
          </button>
        </div>

        {error && (
          <p style={{ color: "#f87171", fontSize: 13, maxWidth: 420, textAlign: "center", marginTop: 16 }}>
            {error}
          </p>
        )}

        {/* Attribution footer */}
        <div style={{
          marginTop: "auto", paddingTop: 20, borderTop: "1px solid #1e2333",
          fontSize: 11, color: "#4b5568", lineHeight: 1.6, textAlign: "center",
          width: "100%", maxWidth: 480,
        }}>
          <p style={{ margin: "0 0 4px" }}>
            Based on{" "}
            <SplashLink href="https://github.com/jldeiro/EdenWorldManipulator2.0">Eden World Manipulator</SplashLink>
            {" "}and{" "}
            <SplashLink href="https://github.com/bLUUBfACE/EdenWorldManipulator">Vuenctools</SplashLink>.
            Docs by{" "}
            <SplashLink href="https://mrob.com/pub/vidgames/eden-file-format.html">Robert Munafo</SplashLink>.
          </p>
          <p style={{ margin: "0 0 8px" }}>
            Eden World Builder by Ari Ronen (open source 2018). Support:{" "}
            <SplashLink href="https://discord.com/invite/rjYXwBC">Discord</SplashLink>.
          </p>
          <button
            onClick={() => setShowAbout(true)}
            style={{
              background: "none", border: "none", color: "#4b5568",
              fontSize: 11, cursor: "pointer", padding: 0, textDecoration: "underline",
            }}
            onMouseEnter={e => (e.currentTarget.style.color = "#64748b")}
            onMouseLeave={e => (e.currentTarget.style.color = "#4b5568")}
          >
            About VuencEdit…
          </button>
        </div>
      </div>

      {showAbout && <AboutModal version={appVersion} onClose={() => setShowAbout(false)} />}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSave={(s) => {
            setShowSlicePanels(s.defaultQuadView);
            setEnable3dPane(s.default3dPane);
            setSaveCompressed(s.defaultSaveCompressed);
            if (s.templatePath !== templatePath) setTemplatePath(s.templatePath);
            if (s.texturePackPath !== texturePackPath) {
              if (s.texturePackPath) loadTexturePackFile(s.texturePackPath);
              else unloadTexturePack();
            }
          }}
        />
      )}

      {/* Right panel — recent worlds */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#181c27", overflow: "hidden" }}>
        <div style={{ padding: "20px 24px 10px", borderBottom: "1px solid #1e2333" }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: "#4b5568", textTransform: "uppercase" }}>
            Recent Worlds
          </span>
        </div>
        {recentWorlds.length === 0 ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#4b5568", fontSize: 15 }}>No Recent Worlds</span>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: "auto" }}>
            {recentWorlds.map((r, i) => (
              <button
                key={r.path}
                onClick={() => { if (!loading) openFileAt(r.path); }}
                disabled={loading}
                style={{
                  display: "flex", alignItems: "center", gap: 14,
                  width: "100%", textAlign: "left", background: "none",
                  border: "none", borderBottom: i < recentWorlds.length - 1 ? "1px solid #1e2333" : "none",
                  padding: "14px 24px", cursor: loading ? "not-allowed" : "pointer",
                  opacity: loading ? 0.5 : 1,
                }}
                onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLElement).style.background = "#1e2333"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "none"; }}
                title={r.path}
              >
                <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>🌍</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.name}
                  </div>
                  <div style={{ fontSize: 11, color: "#4b5568", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" }}>
                    {r.path}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: "#475569", flexShrink: 0 }}>{timeAgo(r.timestamp)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {showWorldBrowser && (
        <WorldBrowserModal
          onClose={() => setShowWorldBrowser(false)}
          onOpenWorld={(path) => { setShowWorldBrowser(false); openFileAt(path); }}
        />
      )}
      {showNewWorld && (
        <NewWorldModal
          onClose={() => setShowNewWorld(false)}
          onCreated={(path) => { setShowNewWorld(false); openFileAt(path); }}
        />
      )}
    </div>
  );
}

export default App;
