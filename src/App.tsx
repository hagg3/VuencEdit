import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import MapCanvas, { type Tool, type SelectionBounds, type PixelPatch, type MapCanvasRef } from "./MapCanvas";
import { BLOCK_DEFS, PAINT_COLORS, resolveColor, blockDisplayName } from "./blockDefs";
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
import BlockPaintPicker from "./BlockPaintPicker";
import SettingsModal, { loadSettings, saveSettings } from "./SettingsModal";
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

// ── shared styles ────────────────────────────────────────────────────────────

const overlayBtn: React.CSSProperties = {
  background: "rgba(0,0,0,0.6)",
  border: "1px solid #475569",
  color: "#e2e8f0",
  padding: "5px 13px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
  lineHeight: "20px",
};

const overlayBtnActive: React.CSSProperties = {
  ...overlayBtn,
  background: "rgba(59,130,246,0.5)",
  borderColor: "#3b82f6",
};

const menuItem: React.CSSProperties = {
  display: "block", width: "100%", textAlign: "left",
  background: "none", border: "none", color: "#e2e8f0",
  padding: "6px 14px", fontSize: 13, cursor: "pointer",
  lineHeight: "18px",
};

const menuDivider: React.CSSProperties = {
  height: 1, background: "#1e293b", margin: "3px 0",
};

const zInput: React.CSSProperties = {
  width: 54,
  background: "rgba(0,0,0,0.5)",
  border: "1px solid #475569",
  color: "#e2e8f0",
  borderRadius: 4,
  padding: "2px 5px",
  fontSize: 13,
  textAlign: "center",
  outline: "none",
};

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
  const [saving, setSaving] = useState(false);
  const [saveCompressed, setSaveCompressed] = useState(() => loadSettings().defaultSaveCompressed);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [showRecentSubmenu, setShowRecentSubmenu] = useState(false);
  const [recentWorlds, setRecentWorlds] = useState<RecentWorld[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_WORLDS_KEY) ?? "[]"); }
    catch { return []; }
  });
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const [tool, setTool] = useState<Tool>("pan");
  const prevToolRef = useRef<Tool>("pan");
  const [wandMatchPaint, setWandMatchPaint] = useState(true);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<"tiled" | "full" | "axo">("tiled");
  const [axoSkew, setAxoSkew] = useState(0.2);
  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const helpMenuRef = useRef<HTMLDivElement>(null);
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

  const [extrudeCount, setExtrudeCount] = useState(2);
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

  // Bottom-left panel collapse state
  const [fillPickerOpen, setFillPickerOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);

  // Hotbar: 5 pinned + 5 recent block+paint combos
  const [pinnedBlocks, setPinnedBlocks] = useState<({type: number; paint: number} | null)[]>(Array(5).fill(null));
  const [recentBlocks, setRecentBlocks] = useState<{type: number; paint: number}[]>([]);
  const [hotbarHover, setHotbarHover] = useState<string | null>(null);


  // Paste mode: normal | scatter | array
  const [pasteMode, setPasteMode] = useState<"normal" | "scatter" | "array">("normal");
  const [advancedPasteOpen, setAdvancedPasteOpen] = useState(false);
  const [scatterCount, setScatterCount] = useState(5);
  const [arrayCols, setArrayCols] = useState(3);
  const [arrayRows, setArrayRows] = useState(3);
  const [arraySpacingX, setArraySpacingX] = useState(0);
  const [arraySpacingY, setArraySpacingY] = useState(0);

  const [clipboardPreviewPixels, setClipboardPreviewPixels] = useState<{ width: number; height: number; pixels: Uint8Array } | null>(null);

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
      if (extrudeOpen) {
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
      setZMax(Math.min(63, data.max_z));
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
      setZMax(Math.min(63, data.max_z));
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

  function commitZSlice(z: number) {
    setZSliceZ(z);
    setZSliceDisplay(z);
  }

  async function copySelection() {
    if (!rawBounds) return;
    try {
      const info = await invoke<ClipboardInfo>("copy_selection", { ...rawBounds, zMin, zMax });
      setClipboard(info);
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

  // Close menus when clicking outside them.
  useEffect(() => {
    if (!fileMenuOpen) { setShowRecentSubmenu(false); return; }
    function handleOutside(e: MouseEvent) {
      if (fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node)) {
        setFileMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [fileMenuOpen]);

  useEffect(() => {
    if (!viewMenuOpen) return;
    function handleOutside(e: MouseEvent) {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) {
        setViewMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [viewMenuOpen]);

  useEffect(() => {
    if (!helpMenuOpen) return;
    function handleOutside(e: MouseEvent) {
      if (helpMenuRef.current && !helpMenuRef.current.contains(e.target as Node)) {
        setHelpMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [helpMenuOpen]);

  // Template overlay helpers
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
      filters: [{ name: "Minecraft Schematic / Litematica", extensions: ["schematic", "litematic"] }],
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

  type DrawToolKey = "pen" | "brush" | "rect" | "ellipse";
  type SculptToolKey = "smooth" | "noise" | "flatten" | "erode";
  const drawToolIcons: Record<DrawToolKey, string> = { pen: "✏", brush: "⬟", rect: "□", ellipse: "○" };
  const drawToolNames: Record<DrawToolKey, string> = { pen: "Pen", brush: "Brush", rect: "Rect", ellipse: "Ellipse" };
  const sculptToolIcons: Record<SculptToolKey, string> = { smooth: "〰", noise: "⛰", flatten: "▬", erode: "~" };
  const sculptToolNames: Record<SculptToolKey, string> = { smooth: "Smooth", noise: "Noise", flatten: "Flatten", erode: "Erode" };
  const isSculptTool = tool === "smooth" || tool === "noise" || tool === "flatten" || tool === "erode";
  const isDrawTool = tool === "pen" || tool === "brush" || tool === "rect" || tool === "ellipse" || isSculptTool || tool === "fill";
  const swatchColor = resolveColor(fillBlockType, fillPaint);

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
        extrudeOpen && rawBounds && (extrudeAxis.startsWith("x") || extrudeAxis.startsWith("y"))
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
    />
  ) : null;

  if (world) {
    const sliceDrawTool = (["pen","brush","rect","ellipse"] as const).find(t => t === tool);
    // Active region shown on the slabs: the paste footprint (preview) or the current selection.
    const sliceIsPaste = pastePreviewSelection != null;
    const sliceSel = pastePreviewSelection
      ?? (rawBounds ? { x1: rawBounds.x1, y1: rawBounds.y1, x2: rawBounds.x2, y2: rawBounds.y2, z_min: zMin, z_max: zMax } : null);
    const sliceSelZ = sliceSel ? { min: sliceSel.z_min, max: sliceSel.z_max } : null;
    const sliceExtrudeCount = sliceIsPaste ? 0 : (extrudeOpen ? extrudeCount : 0);
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
            position: "absolute", inset: 0, paddingTop: 50,
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
                    />
                  </ErrorBoundary>
                  <button
                    onClick={() => setEnable3dPane(false)}
                    title="Disable the 3D pane (saves performance)"
                    style={{
                      position: "absolute", top: 4, right: 6, zIndex: 2,
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

        {/* Top-left: world info + inline rename */}
        <div style={{
          position: "absolute", top: 12, left: 12,
          background: "rgba(0,0,0,0.6)", padding: "5px 12px",
          borderRadius: 6, fontSize: 13, userSelect: "none",
          display: "flex", alignItems: "center", gap: 0,
        }}>
          {renamingWorld ? (
            <input
              ref={renameInputRef}
              value={renameInput}
              onChange={e => {
                // Filter to allowed chars: A-Za-z0-9, space, and apostrophe, max 32
                const filtered = e.target.value
                  .split("").filter(c => /[A-Za-z0-9' ]/.test(c)).join("")
                  .slice(0, 32);
                setRenameInput(filtered);
              }}
              onKeyDown={async e => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setRenamingWorld(false);
                }
              }}
              onBlur={async () => {
                const trimmed = renameInput.trim();
                if (trimmed && trimmed !== world.name) {
                  try {
                    await invoke("rename_world", { name: trimmed });
                    setWorld(w => w ? { ...w, name: trimmed } : null);
                  } catch (e) { setError(String(e)); }
                }
                setRenamingWorld(false);
              }}
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "1px solid #3b82f6",
                borderRadius: 4,
                color: "#e2e8f0",
                fontSize: 13,
                fontWeight: 700,
                padding: "0 5px",
                outline: "none",
                width: `${Math.max(80, renameInput.length * 8 + 20)}px`,
              }}
              autoFocus
            />
          ) : (
            <strong
              onClick={() => { setRenameInput(world.name); setRenamingWorld(true); }}
              style={{
                cursor: "text",
                pointerEvents: "auto",
                borderBottom: "1px dashed rgba(255,255,255,0.2)",
              }}
              title="Click to rename world"
            >
              {world.name}
            </strong>
          )}
          <span style={{ marginLeft: 10, color: "#94a3b8", pointerEvents: "none" }}>
            {world.width_chunks}×{world.height_chunks} chunks
          </span>
          {viewMode === "zslice" && (
            <span style={{ marginLeft: 10, color: "#7dd3fc", pointerEvents: "none" }}>z={zSliceZ}</span>
          )}
          <span style={{
            marginLeft: 10, fontSize: 11, pointerEvents: "none",
            color: world.max_z === 255 ? "#a78bfa" : "#64748b",
          }}>
            {world.max_z === 63 ? "Legacy format"
              : world.max_z === 255 ? "New Dawn format"
              : "Unknown format"}
          </span>
        </div>

        {/* Top-center: tool buttons + z-slice slider */}
        <div style={{
          position: "absolute", top: 12,
          left: "50%", transform: "translateX(-50%)",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
        }}>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => setTool("pan")} style={tool === "pan" ? overlayBtnActive : overlayBtn}>Pan</button>
            <button onClick={() => setTool("select")} style={tool === "select" ? overlayBtnActive : overlayBtn}>⬚ Select</button>
            <button onClick={() => setTool("wand")} title="Magic Wand — click to flood-select matching surface blocks (W)" style={tool === "wand" ? { ...overlayBtnActive, borderColor: "#a78bfa", color: "#c4b5fd" } : overlayBtn}>
              Wand
            </button>
            <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
            <button
              onClick={() => { if (!isDrawTool) setTool("pen"); }}
              style={isDrawTool
                ? { ...overlayBtnActive, borderColor: isSculptTool ? "#fb923c" : tool === "fill" ? "#34d399" : "#f472b6", color: isSculptTool ? "#fdba74" : tool === "fill" ? "#6ee7b7" : "#fbcfe8" }
                : overlayBtn}
              title="Drawing tools (P/B/R/E/F)"
            >
              {isSculptTool ? `${sculptToolIcons[tool as SculptToolKey]} ${sculptToolNames[tool as SculptToolKey]}`
                : tool === "fill" ? "Fill"
                : isDrawTool ? `${drawToolIcons[tool as DrawToolKey]} ${drawToolNames[tool as DrawToolKey]}`
                : "Draw"}
              {isDrawTool && !isSculptTool && tool !== "fill" && (
                <span style={{
                  marginLeft: 4, fontSize: 10, fontWeight: 700,
                  color: drawAbove ? "#fcd34d" : "#6ee7b7",
                  background: drawAbove ? "rgba(252,211,77,0.15)" : "rgba(110,231,183,0.12)",
                  border: `1px solid ${drawAbove ? "rgba(252,211,77,0.4)" : "rgba(110,231,183,0.35)"}`,
                  borderRadius: 3, padding: "0 3px", lineHeight: "14px",
                }}>{drawAbove ? "+1" : "surf"}</span>
              )}
            </button>

            <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
            <button
              onClick={handleUndo} disabled={undoDepth === 0}
              style={{ ...overlayBtn, opacity: undoDepth === 0 ? 0.4 : 1, cursor: undoDepth === 0 ? "not-allowed" : "pointer" }}
              title="Undo (Cmd+Z)"
            >↩ Undo</button>
            <button
              onClick={handleRedo} disabled={redoDepth === 0}
              style={{ ...overlayBtn, opacity: redoDepth === 0 ? 0.4 : 1, cursor: redoDepth === 0 ? "not-allowed" : "pointer" }}
              title="Redo (Cmd+Shift+Z)"
            >↪ Redo</button>
          </div>

          {/* Draw toolbar — visible when a draw tool or eyedropper is active */}
          {(isDrawTool || tool === "eyedropper") && (
            <div style={{
              display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap",
              background: "rgba(0,0,0,0.6)", padding: "4px 10px",
              borderRadius: 6, border: "1px solid #831843",
            }}>
              {/* Pick */}
              <button
                onClick={() => { prevToolRef.current = tool === "eyedropper" ? "pen" : tool; setTool("eyedropper"); }}
                title="Eyedropper — click any block to pick its type and paint (I)"
                style={{ ...(tool === "eyedropper" ? { ...overlayBtnActive, borderColor: "#67e8f9", color: "#a5f3fc" } : overlayBtn) }}
              >
                {tool === "eyedropper" ? "💉 Pick" : "💉"}
              </button>
              <div style={{ width: 1, background: "#334155", margin: "0 2px", alignSelf: "stretch" }} />
              {/* Draw tools */}
              {(["pen", "brush", "rect", "ellipse"] as const).map(t => (
                <button key={t} onClick={() => setTool(t)} title={drawToolNames[t]} style={{
                  ...overlayBtn, fontSize: 12,
                  borderColor: tool === t ? "#f472b6" : "#334155",
                  color: tool === t ? "#fbcfe8" : "#94a3b8",
                  background: tool === t ? "rgba(244,114,182,0.1)" : "rgba(0,0,0,0.4)",
                }}>
                  {tool === t ? `${drawToolIcons[t]} ${drawToolNames[t]}` : drawToolIcons[t]}
                </button>
              ))}
              {/* Fill bucket */}
              <button onClick={() => setTool("fill")} title="Fill Bucket (F)" style={{
                ...overlayBtn, fontSize: 12,
                borderColor: tool === "fill" ? "#34d399" : "#334155",
                color: tool === "fill" ? "#6ee7b7" : "#94a3b8",
                background: tool === "fill" ? "rgba(52,211,153,0.1)" : "rgba(0,0,0,0.4)",
              }}>
                {tool === "fill" ? "🪣 Fill" : "🪣"}
              </button>
              <div style={{ width: 1, background: "#334155", margin: "0 2px", alignSelf: "stretch" }} />
              {/* Sculpt tools */}
              <span style={{ color: "#475569", fontSize: 10, marginRight: 2 }}>Sculpt</span>
              <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px", marginRight: 2 }}>exp</span>
              {(["smooth", "noise", "flatten", "erode"] as const).map(t => (
                <button key={t} onClick={() => setTool(t)} title={sculptToolNames[t]} style={{
                  ...overlayBtn, fontSize: 12,
                  borderColor: tool === t ? "#fb923c" : "#334155",
                  color: tool === t ? "#fdba74" : "#94a3b8",
                  background: tool === t ? "rgba(251,146,60,0.1)" : "rgba(0,0,0,0.4)",
                }}>
                  {tool === t ? `${sculptToolIcons[t]} ${sculptToolNames[t]}` : sculptToolIcons[t]}
                </button>
              ))}
              {/* Context options */}
              {(tool === "brush") && (<>
                <div style={{ width: 1, background: "#334155", margin: "0 2px", alignSelf: "stretch" }} />
                <span style={{ color: "#64748b", fontSize: 11 }}>Size</span>
                {([1, 3, 5, 7, 9] as const).map(s => (
                  <button key={s} onClick={() => setBrushSize(s)} style={{
                    ...overlayBtn, padding: "1px 6px", fontSize: 11,
                    borderColor: brushSize === s ? "#f472b6" : "#334155",
                    color: brushSize === s ? "#fbcfe8" : "#94a3b8",
                  }}>{s}</button>
                ))}
                <div style={{ width: 1, background: "#334155", margin: "0 2px", alignSelf: "stretch" }} />
                <button onClick={() => setBrushShape("sq")} style={{
                  ...overlayBtn, padding: "1px 8px", fontSize: 11,
                  borderColor: brushShape === "sq" ? "#f472b6" : "#334155",
                  color: brushShape === "sq" ? "#fbcfe8" : "#94a3b8",
                }}>■ Sq</button>
                <button onClick={() => setBrushShape("circ")} style={{
                  ...overlayBtn, padding: "1px 8px", fontSize: 11,
                  borderColor: brushShape === "circ" ? "#f472b6" : "#334155",
                  color: brushShape === "circ" ? "#fbcfe8" : "#94a3b8",
                }}>● Circ</button>
              </>)}
              {isSculptTool && (<>
                <div style={{ width: 1, background: "#334155", margin: "0 2px", alignSelf: "stretch" }} />
                <span style={{ color: "#64748b", fontSize: 11 }}>Size</span>
                {([1, 3, 5, 7, 9] as const).map(s => (
                  <button key={s} onClick={() => setBrushSize(s)} style={{
                    ...overlayBtn, padding: "1px 6px", fontSize: 11,
                    borderColor: brushSize === s ? "#fb923c" : "#334155",
                    color: brushSize === s ? "#fdba74" : "#94a3b8",
                  }}>{s}</button>
                ))}
                <div style={{ width: 1, background: "#334155", margin: "0 2px", alignSelf: "stretch" }} />
                <span style={{ color: "#64748b", fontSize: 11 }}>Str</span>
                {([1, 2, 3, 4, 5] as const).map(s => (
                  <button key={s} onClick={() => setSculptStrength(s)} style={{
                    ...overlayBtn, padding: "1px 6px", fontSize: 11,
                    borderColor: sculptStrength === s ? "#fb923c" : "#334155",
                    color: sculptStrength === s ? "#fdba74" : "#94a3b8",
                  }}>{s}</button>
                ))}
              </>)}
              {(tool === "rect" || tool === "ellipse") && (<>
                <div style={{ width: 1, background: "#334155", margin: "0 2px", alignSelf: "stretch" }} />
                <button onClick={() => setDrawFilled(true)} style={{
                  ...overlayBtn, padding: "1px 8px", fontSize: 11,
                  borderColor: drawFilled ? "#f472b6" : "#334155",
                  color: drawFilled ? "#fbcfe8" : "#94a3b8",
                }}>Fill</button>
                <button onClick={() => setDrawFilled(false)} style={{
                  ...overlayBtn, padding: "1px 8px", fontSize: 11,
                  borderColor: !drawFilled ? "#f472b6" : "#334155",
                  color: !drawFilled ? "#fbcfe8" : "#94a3b8",
                }}>Hollow</button>
              </>)}
              {!isSculptTool && tool !== "fill" && tool !== "eyedropper" && (<>
                <div style={{ width: 1, background: "#334155", margin: "0 2px", alignSelf: "stretch" }} />
                <button onClick={() => setDrawAbove(false)} style={{
                  ...overlayBtn, padding: "1px 8px", fontSize: 11,
                  borderColor: !drawAbove ? "#f472b6" : "#334155",
                  color: !drawAbove ? "#fbcfe8" : "#94a3b8",
                }}>Surface</button>
                <button onClick={() => setDrawAbove(true)} style={{
                  ...overlayBtn, padding: "1px 8px", fontSize: 11,
                  borderColor: drawAbove ? "#f472b6" : "#334155",
                  color: drawAbove ? "#fbcfe8" : "#94a3b8",
                }}>+1 Above</button>
              </>)}
              {/* Drawing with swatch */}
              {isDrawTool && (<>
                <div style={{ width: 1, background: "#334155", margin: "0 2px", alignSelf: "stretch" }} />
                <div style={{
                  width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                  background: `rgb(${swatchColor[0]},${swatchColor[1]},${swatchColor[2]})`,
                  border: "1px solid rgba(255,255,255,0.2)",
                }} />
                <span style={{ color: "#94a3b8", fontSize: 11 }}>
                  {blockDisplayName(fillBlockType)}{fillPaint > 0 ? ` / paint ${fillPaint}` : ""}
                </span>
              </>)}
            </div>
          )}

          {/* Z-slice height slider — visible only in Z-slice mode */}
          {viewMode === "zslice" && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              background: "rgba(0,0,0,0.6)", padding: "4px 12px",
              borderRadius: 6, border: "1px solid #1e40af",
            }}>
              <span style={{ color: "#94a3b8", fontSize: 12 }}>Height</span>
              <input
                type="range" min={0} max={world.max_z} value={zSliceDisplay}
                onChange={(e) => setZSliceDisplay(Number(e.target.value))}
                onPointerUp={(e) => commitZSlice(Number((e.target as HTMLInputElement).value))}
                onKeyUp={(e) => commitZSlice(Number((e.target as HTMLInputElement).value))}
                style={{ width: 140, accentColor: "#3b82f6", cursor: "pointer" }}
                title={`Z level (0 = bedrock, ${world.max_z} = sky)`}
              />
              <span style={{ color: "#7dd3fc", fontSize: 13, fontVariantNumeric: "tabular-nums", minWidth: 28, textAlign: "right" }}>
                {zSliceDisplay}
              </span>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", marginLeft: 4 }}>
                <input
                  type="checkbox"
                  checked={followSurface}
                  onChange={e => setFollowSurface(e.target.checked)}
                  style={{ accentColor: "#3b82f6" }}
                />
                <span style={{ color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>surface</span>
              </label>
            </div>
          )}

          {/* Hotbar — visible when a draw tool is active */}
          {isDrawTool && (() => {
            const isActive = (b: {type: number; paint: number}) => b.type === fillBlockType && b.paint === fillPaint;
            const slotBase: React.CSSProperties = {
              width: 26, height: 26, borderRadius: 3, cursor: "pointer", flexShrink: 0,
              position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
            };
            // Small corner badge — pin (↑) for recent, unpin (×) for pinned
            const cornerBadge: React.CSSProperties = {
              position: "absolute", top: 0, right: 0,
              width: 11, height: 11, borderRadius: "0 3px 0 3px",
              background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 9, color: "#e2e8f0", lineHeight: 1, zIndex: 1,
            };
            // Block letter overlay (bottom-left, always visible)
            const letterOverlay = (bt: number): React.ReactNode => {
              const letter = blockDisplayName(bt)[0]?.toUpperCase() ?? "";
              if (!letter) return null;
              return (
                <span style={{
                  position: "absolute", bottom: 1, left: 2,
                  fontSize: 8, fontWeight: 700, lineHeight: 1,
                  color: "rgba(255,255,255,0.7)", textShadow: "0 0 2px rgba(0,0,0,0.9)",
                  pointerEvents: "none", userSelect: "none",
                }}>{letter}</span>
              );
            };
            function pinToSlot(b: {type: number; paint: number}) {
              setPinnedBlocks(prev => {
                const next = [...prev];
                const emptyIdx = next.findIndex(s => s === null);
                if (emptyIdx !== -1) { next[emptyIdx] = b; return next; }
                next[4] = b; return next; // replace last if full
              });
            }
            const slotKeys = ["1","2","3","4","5","6","7","8","9","0"];
            return (
              <div style={{
                display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                background: "rgba(13,24,41,0.88)", border: "1px solid #1e293b",
                borderRadius: 6, padding: "4px 8px",
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "#334155", fontSize: 9, letterSpacing: "0.07em", fontWeight: 700, userSelect: "none" }}>PINNED</span>
                {pinnedBlocks.map((b, i) => {
                  const key = `pinned-${i}`;
                  const hovered = hotbarHover === key;
                  const active = b && isActive(b);
                  const [r, g, bl] = b ? resolveColor(b.type, b.paint) : [40, 50, 70];
                  return (
                    <div key={i} style={{
                      ...slotBase,
                      background: b ? `rgb(${r},${g},${bl})` : "rgba(255,255,255,0.03)",
                      border: active ? "2px solid #fff" : b ? "1px solid rgba(255,255,255,0.18)" : "1px dashed #334155",
                      outline: active ? "1px solid #a78bfa" : "none",
                      outlineOffset: 1,
                    }}
                      title={b ? `${blockDisplayName(b.type)}${b.paint > 0 ? ` paint ${b.paint}` : ""} · key ${slotKeys[i]} (click to select)` : `Empty slot ${slotKeys[i]} — pin a recent block here`}
                      onClick={() => b && (setFillBlockType(b.type), setFillPaint(b.paint))}
                      onMouseEnter={() => setHotbarHover(key)}
                      onMouseLeave={() => setHotbarHover(null)}
                    >
                      {/* Slot key number */}
                      <span style={{
                        position: "absolute", top: 0, left: 2,
                        fontSize: 7, color: "rgba(255,255,255,0.4)", lineHeight: 1,
                        pointerEvents: "none", userSelect: "none",
                      }}>{slotKeys[i]}</span>
                      {b && letterOverlay(b.type)}
                      {/* Unpin badge — only on hover */}
                      {hovered && b && (
                        <div style={cornerBadge}
                          onClick={e => { e.stopPropagation(); setPinnedBlocks(prev => { const n = [...prev]; n[i] = null; return n; }); setHotbarHover(null); }}
                          title="Unpin">×</div>
                      )}
                    </div>
                  );
                })}
                <div style={{ width: 1, background: "#1e293b", height: 18, margin: "0 1px" }} />
                <span style={{ color: "#334155", fontSize: 9, letterSpacing: "0.07em", fontWeight: 700, userSelect: "none" }}>RECENT</span>
                {recentBlocks.length === 0
                  ? <span style={{ color: "#1e293b", fontSize: 10, fontStyle: "italic" }}>none yet</span>
                  : recentBlocks.map((b, i) => {
                    const key = `recent-${i}`;
                    const hovered = hotbarHover === key;
                    const active = isActive(b);
                    const [r, g, bl] = resolveColor(b.type, b.paint);
                    const alreadyPinned = pinnedBlocks.some(p => p && p.type === b.type && p.paint === b.paint);
                    return (
                      <div key={i} style={{
                        ...slotBase,
                        background: `rgb(${r},${g},${bl})`,
                        border: active ? "2px solid #fff" : "1px solid rgba(255,255,255,0.18)",
                        outline: active ? "1px solid #f472b6" : "none",
                        outlineOffset: 1,
                        opacity: alreadyPinned ? 0.5 : 1,
                      }}
                        title={`${blockDisplayName(b.type)}${b.paint > 0 ? ` paint ${b.paint}` : ""} · key ${slotKeys[i + 5]} (click to select${alreadyPinned ? ", already pinned" : ""})`}
                        onClick={() => { setFillBlockType(b.type); setFillPaint(b.paint); }}
                        onMouseEnter={() => setHotbarHover(key)}
                        onMouseLeave={() => setHotbarHover(null)}
                      >
                        <span style={{
                          position: "absolute", top: 0, left: 2,
                          fontSize: 7, color: "rgba(255,255,255,0.4)", lineHeight: 1,
                          pointerEvents: "none", userSelect: "none",
                        }}>{slotKeys[i + 5]}</span>
                        {letterOverlay(b.type)}
                        {/* Pin badge — only on hover when not already pinned */}
                        {hovered && !alreadyPinned && (
                          <div style={cornerBadge}
                            onClick={e => { e.stopPropagation(); pinToSlot(b); setHotbarHover(null); }}
                            title="Pin to pinned slots">↑</div>
                        )}
                      </div>
                    );
                  })
                }
              </div>{/* end slots row */}
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.03em", userSelect: "none" }}>
                {blockDisplayName(fillBlockType)}{fillPaint > 0 ? ` · paint #${fillPaint}` : ""}
              </div>
            </div>
            );
          })()}
        </div>

        {/* Top-right: View menu + File menu + Help */}
        <div style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 6 }}>

          {/* View ▾ dropdown */}
          <div ref={viewMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => { setFileMenuOpen(false); setViewMenuOpen(v => !v); }}
              style={{
                ...overlayBtn,
                borderColor: viewMenuOpen ? "#3b82f6" : undefined,
                color: viewMenuOpen ? "#93c5fd" : undefined,
              }}
              title="View options"
            >
              View {viewMenuOpen ? "▴" : "▾"}
            </button>
            {viewMenuOpen && (
              <div style={{
                position: "absolute", top: "calc(100% + 6px)", right: 0,
                background: "#0d1829", border: "1px solid #1e40af",
                borderRadius: 7, padding: "4px 0", minWidth: 200,
                boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 200,
              }}>
                {/* View mode */}
                <div style={{ ...menuItem, color: "#475569", fontSize: 11, cursor: "default", paddingBottom: 2 }}>
                  MAP VIEW
                </div>
                <button
                  onClick={() => { setViewMenuOpen(false); setViewMode("topdown"); }}
                  style={menuItem}
                >
                  <span style={{ display: "inline-block", width: 16, color: "#3b82f6" }}>{viewMode === "topdown" ? "●" : ""}</span>
                  Top-down
                </button>
                <button
                  onClick={() => { setViewMenuOpen(false); setViewMode("zslice"); }}
                  style={menuItem}
                >
                  <span style={{ display: "inline-block", width: 16, color: "#3b82f6" }}>{viewMode === "zslice" ? "●" : ""}</span>
                  Z-slice
                  {viewMode === "zslice" && <span style={{ marginLeft: 8, color: "#7dd3fc", fontSize: 11 }}>z={zSliceZ}</span>}
                </button>
                <div style={menuDivider} />
                {/* Navigation */}
                <button
                  onClick={() => { setViewMenuOpen(false); mapCanvasRef.current?.resetView(); }}
                  style={{ ...menuItem, display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span><span style={{ display: "inline-block", width: 16 }} />Fit Map</span>
                  <span style={{ color: "#475569", fontSize: 11 }}>Home</span>
                </button>
                <div style={menuDivider} />
                {/* Spawn */}
                <div style={{ ...menuItem, color: "#475569", fontSize: 11, cursor: "default", paddingBottom: 2 }}>
                  SPAWN POINT{spawnPos ? ` (${Math.round(spawnPos.px)}, ${Math.round(spawnPos.py)})` : " (unset)"}
                </div>
                <button
                  disabled={!selection}
                  onClick={async () => {
                    if (!selection) return;
                    const cx = Math.round((selection.x1 + selection.x2) / 2);
                    const cy = Math.round((selection.y1 + selection.y2) / 2);
                    setViewMenuOpen(false);
                    try {
                      await invoke("set_spawn_pos", { px: cx, py: cy });
                      setSpawnPos({ px: cx, py: cy });
                    } catch (e) { setError(String(e)); }
                  }}
                  style={{ ...menuItem, opacity: selection ? 1 : 0.35, cursor: selection ? "pointer" : "not-allowed" }}
                >
                  <span style={{ display: "inline-block", width: 16 }}>⌂</span>
                  Set Spawn at Selection Centre
                </button>
                <div style={menuDivider} />
                {/* Render mode */}
                <div style={{ ...menuItem, color: "#475569", fontSize: 11, cursor: "default", paddingBottom: 2 }}>
                  RENDER MODE
                </div>
                <button
                  onClick={() => { setViewMenuOpen(false); setRenderMode("tiled"); }}
                  style={menuItem}
                >
                  <span style={{ display: "inline-block", width: 16, color: "#3b82f6" }}>{renderMode === "tiled" ? "●" : ""}</span>
                  ⊞ Tiled
                  <span style={{ marginLeft: 8, color: "#475569", fontSize: 11 }}>low RAM</span>
                </button>
                <button
                  onClick={() => { setViewMenuOpen(false); setRenderMode("full"); }}
                  style={menuItem}
                >
                  <span style={{ display: "inline-block", width: 16, color: "#d97706" }}>{renderMode === "full" ? "●" : ""}</span>
                  <span style={{ color: renderMode === "full" ? "#fde68a" : undefined }}>Full Map</span>
                  <span style={{ marginLeft: 8, color: "#475569", fontSize: 11 }}>fast pan</span>
                </button>
                <button
                  onClick={() => { setViewMenuOpen(false); setRenderMode("axo"); }}
                  style={menuItem}
                >
                  <span style={{ display: "inline-block", width: 16, color: "#10b981" }}>{renderMode === "axo" ? "●" : ""}</span>
                  <span style={{ color: renderMode === "axo" ? "#6ee7b7" : undefined }}>Axo View</span>
                  <span style={{ marginLeft: 8, color: "#475569", fontSize: 11 }}>3D depth</span>
                </button>
                {renderMode === "axo" && (
                  <div style={{ padding: "6px 12px 4px", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>Depth</span>
                    <input
                      type="range" min={0} max={0.5} step={0.02}
                      value={axoSkew}
                      onChange={e => setAxoSkew(parseFloat(e.target.value))}
                      style={{ flex: 1, accentColor: "#10b981", cursor: "pointer" }}
                    />
                    <span style={{ color: "#94a3b8", fontSize: 11, width: 28, textAlign: "right" }}>
                      {axoSkew.toFixed(2)}
                    </span>
                  </div>
                )}
                <div style={{ height: 1, background: "#1e293b", margin: "4px 0" }} />
                <div style={{ padding: "4px 12px 2px", color: "#64748b", fontSize: 10, letterSpacing: 1, fontWeight: 600 }}>
                  VIEWPORTS
                </div>
                <button
                  onClick={() => { setViewMenuOpen(false); setShowSlicePanels(v => !v); }}
                  style={menuItem}
                >
                  <span style={{ display: "inline-block", width: 16, color: "#a855f7" }}>{showSlicePanels ? "●" : ""}</span>
                  <span style={{ color: showSlicePanels ? "#d8b4fe" : undefined }}>◫ Quad view (Top / Front / Side / 3D)</span>
                  <span style={{ marginLeft: 6, fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>exp</span>
                </button>
                {/* Sky Editor and Creature Viewer implemented but hidden pending testing */}
                <div style={menuDivider} />
                <div style={{ ...menuItem, color: "#475569", fontSize: 11, cursor: "default", paddingBottom: 2 }}>
                  TEMPLATE OVERLAY
                </div>
                <button
                  onClick={() => { setViewMenuOpen(false); openTemplateFile(); }}
                  style={menuItem}
                  title={templatePath ? `Loaded: ${templatePath}` : "Load Eden.eden to enable template overlay"}
                >
                  <span style={{ display: "inline-block", width: 16 }}>⊕</span>
                  {templateLoaded ? "Change Template…" : "Load Eden Template…"}
                  <span style={{ marginLeft: 6, fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>exp</span>
                  {templateLoaded && <span style={{ marginLeft: 4, color: "#4ade80", fontSize: 10 }}>✓</span>}
                </button>
                {templateLoaded && (
                  <button
                    onClick={() => { setViewMenuOpen(false); setShowTemplateOverlay(v => !v); }}
                    style={menuItem}
                  >
                    <span style={{ display: "inline-block", width: 16, color: "#4ade80" }}>{showTemplateOverlay ? "●" : ""}</span>
                    <span style={{ color: showTemplateOverlay ? "#86efac" : undefined }}>Template Overlay</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* File ▾ dropdown */}
          <div ref={fileMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => { setViewMenuOpen(false); setFileMenuOpen(v => !v); }}
              style={{
                ...overlayBtn,
                borderColor: fileMenuOpen ? "#3b82f6" : (saving || exporting || exportingObj ? "#475569" : undefined),
                color: fileMenuOpen ? "#93c5fd" : undefined,
              }}
              title="File operations"
            >
              File {fileMenuOpen ? "▴" : "▾"}
            </button>
            {fileMenuOpen && (
              <div style={{
                position: "absolute", top: "calc(100% + 6px)", right: 0,
                background: "#0d1829", border: "1px solid #1e40af",
                borderRadius: 7, padding: "4px 0", minWidth: 170,
                boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 200,
              }}>
                {/* New / Open */}
                <button onClick={() => { setFileMenuOpen(false); setShowNewWorld(true); }} style={menuItem}>
                  New World…
                </button>
                <button onClick={() => { setFileMenuOpen(false); openFile(); }} style={menuItem}>
                  Open…
                </button>
                <button
                  onClick={() => setShowRecentSubmenu(v => !v)}
                  style={{ ...menuItem, display: "flex", justifyContent: "space-between", alignItems: "center", color: recentWorlds.length === 0 ? "#475569" : "#e2e8f0" }}
                >
                  <span>Open Recent</span>
                  <span style={{ fontSize: 10 }}>{showRecentSubmenu ? "▴" : "▾"}</span>
                </button>
                {showRecentSubmenu && (
                  <div style={{ background: "#07090f", borderTop: "1px solid #1e293b", borderBottom: "1px solid #1e293b", margin: "2px 0" }}>
                    {recentWorlds.length === 0 ? (
                      <div style={{ ...menuItem, color: "#475569", cursor: "default" }}>No recent worlds</div>
                    ) : recentWorlds.map(r => (
                      <button
                        key={r.path}
                        onClick={() => { setFileMenuOpen(false); setShowRecentSubmenu(false); openFileAt(r.path); }}
                        style={{ ...menuItem, paddingLeft: 20, paddingTop: 5, paddingBottom: 5 }}
                        title={r.path}
                      >
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 210 }}>{r.name}</div>
                        <div style={{ fontSize: 11, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 210 }}>{timeAgo(r.timestamp)}</div>
                      </button>
                    ))}
                  </div>
                )}
                <div style={menuDivider} />
                {/* Save (only when a file is open) */}
                <button
                  onClick={() => { if (!sourcePath || saving) return; setFileMenuOpen(false); saveWorld(sourcePath); }}
                  style={{ ...menuItem, opacity: (!sourcePath || saving) ? 0.35 : 1, cursor: (!sourcePath || saving) ? "not-allowed" : "pointer" }}
                  title={sourcePath ? `Overwrite ${sourcePath}` : "No file open"}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => { if (saving) return; setFileMenuOpen(false); saveWorldAs(); }}
                  style={{ ...menuItem, opacity: saving ? 0.35 : 1, cursor: saving ? "not-allowed" : "pointer" }}
                >
                  Save As…
                </button>
                {/* Compressed toggle inline in menu */}
                <div style={menuDivider} />
                <label style={{ ...menuItem, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={saveCompressed}
                    onChange={e => setSaveCompressed(e.target.checked)}
                    style={{ accentColor: "#f59e0b", width: 13, height: 13 }}
                  />
                  <span style={{ color: saveCompressed ? "#fcd34d" : "#94a3b8" }}>
                    Compressed
                  </span>
                </label>
                <div style={menuDivider} />
                {/* Export + prefab */}
                <button
                  onClick={() => { if (exporting) return; setFileMenuOpen(false); exportPng(); }}
                  style={{ ...menuItem, opacity: exporting ? 0.35 : 1, cursor: exporting ? "not-allowed" : "pointer" }}
                >
                  {exporting ? "Exporting…" : "Export PNG"}
                </button>
                {world && (
                  <button
                    onClick={() => { if (exportingObj) return; setFileMenuOpen(false); exportObj(); }}
                    style={{ ...menuItem, opacity: exportingObj ? 0.35 : 1, cursor: exportingObj ? "not-allowed" : "pointer" }}
                    title={selection ? "Export selection as 3D model" : "Export entire world as 3D model"}
                  >
                    {exportingObj ? "Exporting…" : `Export OBJ…${selection ? " (selection)" : ""}`}
                    {!exportingObj && <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px", marginLeft: 4 }}>exp</span>}
                  </button>
                )}
                {world && (
                  <button onClick={() => { setFileMenuOpen(false); loadPrefab(); }} style={menuItem}>
                    Load Prefab
                  </button>
                )}
                {world && (
                  <button onClick={() => { setFileMenuOpen(false); importSchematic(); }} style={{ ...menuItem, display: "flex", alignItems: "center", gap: 4 }}>
                    Import Schematic…
                    <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>exp</span>
                  </button>
                )}
                <div style={menuDivider} />
                {world && templateLoaded && (
                  <button
                    onClick={() => { setFileMenuOpen(false); setShowExpandModal(true); setExpandResult(null); }}
                    style={menuItem}
                    title="Bake Eden.eden template chunks into a new world file"
                  >
                    Expand from Template…
                  </button>
                )}
                <div style={menuDivider} />
                <button onClick={() => { setFileMenuOpen(false); setShowWorldBrowser(true); }} style={menuItem}>
                  Browse Worlds…
                </button>
                {world && (
                  <button onClick={() => { setFileMenuOpen(false); setShowUploadModal(true); }} style={menuItem}>
                    Upload to Server…
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Help dropdown */}
          <div ref={helpMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => setHelpMenuOpen(o => !o)}
              style={helpMenuOpen ? { ...overlayBtn, background: "rgba(59,130,246,0.35)", borderColor: "#3b82f6" } : overlayBtn}
            >
              Help {helpMenuOpen ? "▴" : "▾"}
            </button>
            {helpMenuOpen && (
              <div style={{
                position: "absolute", top: "calc(100% + 4px)", right: 0,
                background: "#1a1f2e", border: "1px solid #2d3448",
                borderRadius: 8, minWidth: 180, zIndex: 200,
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                overflow: "hidden",
              }}>
                <button
                  onClick={() => { setHelpMenuOpen(false); setShowSettings(true); }}
                  style={{ ...menuItem, width: "100%", textAlign: "left" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#232a3d")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  Settings…
                </button>
                <div style={menuDivider} />
                <button
                  onClick={() => { setHelpMenuOpen(false); setShowHelp(true); }}
                  style={{ ...menuItem, width: "100%", textAlign: "left" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#232a3d")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  Keyboard Shortcuts <span style={{ color: "#4b5568", marginLeft: 8 }}>?</span>
                </button>
                <button
                  onClick={() => { setHelpMenuOpen(false); setShowAbout(true); }}
                  style={{ ...menuItem, width: "100%", textAlign: "left" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#232a3d")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  About VuencEdit
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Bottom-left: z-range + selection info + fill picker */}
        <div style={{
          position: "absolute", bottom: 16, left: 12,
          background: "rgba(0,0,0,0.72)", padding: "6px 12px",
          borderRadius: 6, fontSize: 13,
          display: "flex", flexDirection: "column", gap: 6,
          border: `1px solid ${tool === "paste" ? (lockedPastePos ? "#f59e0b" : "#22c55e") : isDrawTool ? "#831843" : selection ? "#3b82f6" : "#334155"}`,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "calc(100vh - 140px)",
          overflowY: "auto",
        }}>

          {/* Paste mode banner */}
          {tool === "paste" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {lockedPastePos ? (
                <>
                  <span style={{ color: "#fbbf24", fontWeight: 700, fontSize: 12, letterSpacing: "0.05em" }}>
                    PASTE — LOCKED
                  </span>
                  <span style={{ color: "#92400e", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                    X{lockedPastePos.x}, Y{lockedPastePos.y}
                  </span>
                  <span style={{ color: "#6b7280", fontSize: 11 }}>· Esc to unlock ·</span>
                </>
              ) : (
                <>
                  <span style={{ color: "#4ade80", fontWeight: 700, fontSize: 12, letterSpacing: "0.05em" }}>
                    PASTE MODE
                  </span>
                  <span style={{ color: "#6b7280", fontSize: 12 }}>
                    click map to place · Esc to cancel
                  </span>
                </>
              )}
              {clipboard && (
                <span style={{ color: "#86efac", fontSize: 11 }}>
                  {clipboard.width}×{clipboard.height}×{clipboard.depth}, z{clipboard.z_anchor + pasteElevationOffset}–{clipboard.z_anchor + pasteElevationOffset + clipboard.depth - 1}
                </span>
              )}
              <span style={{ color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>Z offset</span>
              <input
                type="number"
                value={pasteElevationOffset}
                onChange={(e) => setPasteElevationOffset(Number(e.target.value))}
                style={{ ...zInput, width: 48 }}
                title="Vertical offset applied at paste time (does not change clipboard)"
              />
              {lockedPastePos && (
                <>
                  <button
                    onClick={() => { const p = lockedPastePos; pasteAt(p); setLockedPastePos(null); }}
                    style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#22c55e", color: "#86efac" }}
                    title="Confirm paste at locked position"
                  >
                    Confirm Paste
                  </button>
                  <button
                    onClick={() => setLockedPastePos(null)}
                    style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12 }}
                    title="Unlock position — return to hover mode"
                  >
                    Unlock
                  </button>
                </>
              )}
              <button
                onClick={() => setPasteIgnoreAir((v) => !v)}
                style={{
                  ...overlayBtn, padding: "2px 10px", fontSize: 12,
                  borderColor: pasteIgnoreAir ? "#34d399" : "#475569",
                  color: pasteIgnoreAir ? "#6ee7b7" : "#94a3b8",
                }}
                title={pasteIgnoreAir ? "Air blocks in clipboard are skipped (click to disable)" : "Air blocks in clipboard overwrite destination (click to enable no-air mode)"}
              >
                {pasteIgnoreAir ? "No air ✓" : "No air"}
              </button>
              <button
                onClick={rotateClipboard}
                style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#a78bfa", color: "#ddd6fe" }}
                title="Rotate clipboard 90° clockwise"
              >
                Rotate 90°
              </button>
              <button
                onClick={mirrorClipboardX}
                style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#a78bfa", color: "#ddd6fe" }}
                title="Mirror clipboard left↔right (flip on X axis)"
              >
                ↔ Flip X
              </button>
              <button
                onClick={mirrorClipboardY}
                style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#a78bfa", color: "#ddd6fe" }}
                title="Mirror clipboard top↔bottom (flip on Y axis)"
              >
                ↕ Flip Y
              </button>
              <button
                onClick={() => setPersistPaste((v) => !v)}
                style={{
                  ...overlayBtn, padding: "2px 10px", fontSize: 12,
                  borderColor: persistPaste ? "#34d399" : "#475569",
                  color: persistPaste ? "#6ee7b7" : "#94a3b8",
                }}
                title={persistPaste ? "Paste mode stays active after each placement (click to disable)" : "Stay in paste mode after each placement"}
              >
                {persistPaste ? "Repeat ✓" : "Repeat"}
              </button>
              <button
                onClick={() => setPasteTerrain((v) => !v)}
                style={{
                  ...overlayBtn, padding: "2px 10px", fontSize: 12,
                  borderColor: pasteTerrain ? "#f59e0b" : "#475569",
                  color: pasteTerrain ? "#fcd34d" : "#94a3b8",
                }}
                title={pasteTerrain ? "Terrain mode: each column aligns to the surface (click to disable)" : "Enable terrain mode: align paste per column to surface height"}
              >
                {pasteTerrain ? "Terrain ✓" : "Terrain"}
              </button>
              {pasteTerrain && (
                <button
                  onClick={() => setPasteTerrainAbove((v) => !v)}
                  style={{
                    ...overlayBtn, padding: "2px 10px", fontSize: 12,
                    borderColor: pasteTerrainAbove ? "#fb923c" : "#475569",
                    color: pasteTerrainAbove ? "#fdba74" : "#94a3b8",
                  }}
                  title={pasteTerrainAbove ? "Bottom clipboard layer sits one block above the surface (click to place at surface level)" : "Bottom clipboard layer sits at the surface block (click to place above surface)"}
                >
                  {pasteTerrainAbove ? "Above ✓" : "At surface"}
                </button>
              )}
              {/* Advanced paste options (scatter / array) — collapsed by default */}
              <button
                onClick={() => setAdvancedPasteOpen(v => !v)}
                style={{
                  ...overlayBtn, padding: "2px 8px", fontSize: 11,
                  borderColor: advancedPasteOpen || pasteMode !== "normal" ? "#7dd3fc" : "#334155",
                  color: advancedPasteOpen || pasteMode !== "normal" ? "#bfdbfe" : "#64748b",
                  background: advancedPasteOpen ? "rgba(125,211,252,0.1)" : "rgba(0,0,0,0.3)",
                }}
                title="Scatter and array paste modes"
              >
                {pasteMode !== "normal" ? `▼ ${pasteMode}` : `▶ Advanced`}
              </button>
              {advancedPasteOpen && (<>
                <div style={{ display: "flex", alignItems: "center", gap: 2, borderLeft: "1px solid #334155", paddingLeft: 6, marginLeft: 2 }}>
                  {(["normal", "scatter", "array"] as const).map(m => (
                    <button key={m} onClick={() => setPasteMode(m)} style={{
                      ...overlayBtn, padding: "2px 8px", fontSize: 11,
                      borderColor: pasteMode === m ? "#7dd3fc" : "#334155",
                      color: pasteMode === m ? "#bfdbfe" : "#64748b",
                      background: pasteMode === m ? "rgba(125,211,252,0.1)" : "rgba(0,0,0,0.3)",
                    }}>
                      {m === "normal" ? "1×" : m === "scatter" ? "Scatter" : "Array"}
                    </button>
                  ))}
                </div>
                {pasteMode === "scatter" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ color: "#64748b", fontSize: 11 }}>Count</span>
                    <input type="number" min={1} max={100} value={scatterCount}
                      onChange={e => setScatterCount(Math.max(1, parseInt(e.target.value,10)||1))}
                      style={{ ...zInput, width: 44 }} />
                    <span style={{ color: "#475569", fontSize: 11 }}>within selection</span>
                  </div>
                )}
                {pasteMode === "array" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                    <span style={{ color: "#64748b", fontSize: 11 }}>Cols</span>
                    <input type="number" min={1} max={20} value={arrayCols}
                      onChange={e => setArrayCols(Math.max(1, parseInt(e.target.value,10)||1))}
                      style={{ ...zInput, width: 40 }} />
                    <span style={{ color: "#64748b", fontSize: 11 }}>Rows</span>
                    <input type="number" min={1} max={20} value={arrayRows}
                      onChange={e => setArrayRows(Math.max(1, parseInt(e.target.value,10)||1))}
                      style={{ ...zInput, width: 40 }} />
                    <span style={{ color: "#64748b", fontSize: 11 }}>SpX</span>
                    <input type="number" min={0} value={arraySpacingX}
                      onChange={e => setArraySpacingX(Math.max(0, parseInt(e.target.value,10)||0))}
                      style={{ ...zInput, width: 40 }} title="Horizontal spacing (0 = auto)" />
                    <span style={{ color: "#64748b", fontSize: 11 }}>SpY</span>
                    <input type="number" min={0} value={arraySpacingY}
                      onChange={e => setArraySpacingY(Math.max(0, parseInt(e.target.value,10)||0))}
                      style={{ ...zInput, width: 40 }} title="Vertical spacing (0 = auto)" />
                  </div>
                )}
              </>)}
              <button
                onClick={() => setTool("pan")}
                style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12 }}
              >
                Cancel
              </button>
            </div>
          )}

          {/* Row 1: z-range + selection info + clipboard actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ color: "#94a3b8", whiteSpace: "nowrap" }}>Height</span>
            <input
              type="number" min={0} max={world.max_z} value={zMin}
              onChange={(e) => handleZMin(e.target.value)}
              style={zInput}
              title="Minimum Z (0 = bedrock level)"
            />
            <span style={{ color: "#475569" }}>–</span>
            <input
              type="number" min={0} max={world.max_z} value={zMax}
              onChange={(e) => handleZMax(e.target.value)}
              style={zInput}
              title={`Maximum Z (${world.max_z} = sky)`}
            />
            {selection && (
              <>
                <span style={{ color: "#334155", margin: "0 2px" }}>│</span>
                <span style={{ color: "#93c5fd", whiteSpace: "nowrap" }}>Selection</span>
                <span style={{ color: "#e2e8f0", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  ({selection.x1}, {selection.y1}) → ({selection.x2}, {selection.y2})
                  &nbsp;·&nbsp;
                  <strong>{selection.width} × {selection.height} × {selection.depth}</strong>
                </span>
                <button
                  onClick={copySelection}
                  style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#7dd3fc", color: "#bfdbfe" }}
                  title={`Copy selection to clipboard (${selection.width}×${selection.height}×${selection.depth} blocks)`}
                >
                  Copy
                </button>
                <button
                  onClick={deleteBlocks}
                  style={{
                    ...overlayBtn, padding: "2px 10px", fontSize: 12,
                    borderColor: filterBlockType !== null
                      ? (filterInvert ? "#a78bfa" : "#f97316")
                      : "#ef4444",
                    color: filterBlockType !== null
                      ? (filterInvert ? "#ddd6fe" : "#fca5a5")
                      : "#fca5a5",
                  }}
                  title={filterBlockType !== null
                    ? (filterInvert
                        ? `Delete all blocks EXCEPT ${blockDisplayName(filterBlockType)} in selection`
                        : `Delete only ${blockDisplayName(filterBlockType)} blocks in selection`)
                    : "Set all blocks in selection to Air"}
                >
                  Delete{filterBlockType !== null ? (filterInvert ? "!*" : "*") : ""}
                </button>
                {/* Grow / Shrink selection */}
                <button
                  onClick={() => setRawBounds(b => b ? { x1: b.x1 - 1, y1: b.y1 - 1, x2: b.x2 + 1, y2: b.y2 + 1 } : null)}
                  style={{ ...overlayBtn, padding: "2px 8px", fontSize: 12 }}
                  title="Grow selection by 1 block on each side"
                >+1</button>
                <button
                  onClick={() => setRawBounds(b => b ? { x1: Math.min(b.x1 + 1, b.x2), y1: Math.min(b.y1 + 1, b.y2), x2: Math.max(b.x2 - 1, b.x1), y2: Math.max(b.y2 - 1, b.y1) } : null)}
                  style={{ ...overlayBtn, padding: "2px 8px", fontSize: 12 }}
                  title="Shrink selection by 1 block on each side"
                >-1</button>
                <button
                  onClick={() => setRawBounds(null)}
                  style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12 }}
                >
                  Clear
                </button>
              </>
            )}
            {/* Magic Wand hint + paint toggle */}
            {tool === "wand" && (
              <span style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
                <span style={{ color: "#a78bfa", fontSize: 11 }}>· Click to flood-select</span>
                <button
                  onClick={() => setWandMatchPaint(v => !v)}
                  title={wandMatchPaint ? "Matching block type + paint colour — click to ignore paint" : "Matching block type only — click to also match paint colour"}
                  style={{
                    background: wandMatchPaint ? "rgba(167,139,250,0.15)" : "rgba(100,116,139,0.15)",
                    border: `1px solid ${wandMatchPaint ? "#a78bfa" : "#475569"}`,
                    color: wandMatchPaint ? "#c4b5fd" : "#94a3b8",
                    borderRadius: 4, padding: "1px 7px", fontSize: 11, cursor: "pointer",
                  }}
                >
                  {wandMatchPaint ? "Type + Colour" : "Type only"}
                </button>
              </span>
            )}
          </div>

          {/* Clipboard status + Paste button (always visible when clipboard has data) */}
          {clipboard && tool !== "paste" && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              paddingTop: 4, borderTop: "1px solid #1e293b",
            }}>
              <span style={{ color: "#64748b", fontSize: 11 }}>Clipboard:</span>
              <span style={{ color: "#94a3b8", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                {clipboard.width}×{clipboard.height}×{clipboard.depth} blocks, z{clipboard.z_anchor + pasteElevationOffset}–{clipboard.z_anchor + pasteElevationOffset + clipboard.depth - 1}
              </span>
              <span style={{ color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>Z offset</span>
              <input
                type="number"
                value={pasteElevationOffset}
                onChange={(e) => setPasteElevationOffset(Number(e.target.value))}
                style={{ ...zInput, width: 48 }}
                title="Vertical offset applied at paste time"
              />
              <button
                onClick={() => setPasteIgnoreAir((v) => !v)}
                style={{
                  ...overlayBtn, padding: "2px 10px", fontSize: 12,
                  borderColor: pasteIgnoreAir ? "#34d399" : "#475569",
                  color: pasteIgnoreAir ? "#6ee7b7" : "#94a3b8",
                }}
                title={pasteIgnoreAir ? "Air blocks in clipboard are skipped (click to disable)" : "Air blocks in clipboard overwrite destination (click to enable no-air mode)"}
              >
                {pasteIgnoreAir ? "No air ✓" : "No air"}
              </button>
              <button
                onClick={rotateClipboard}
                style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#a78bfa", color: "#ddd6fe" }}
                title="Rotate clipboard 90° clockwise"
              >
                Rotate 90°
              </button>
              <button
                onClick={mirrorClipboardX}
                style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#a78bfa", color: "#ddd6fe" }}
                title="Mirror clipboard left↔right (flip on X axis)"
              >
                ↔ Flip X
              </button>
              <button
                onClick={mirrorClipboardY}
                style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#a78bfa", color: "#ddd6fe" }}
                title="Mirror clipboard top↔bottom (flip on Y axis)"
              >
                ↕ Flip Y
              </button>
              <button
                onClick={() => setPasteTerrain((v) => !v)}
                style={{
                  ...overlayBtn, padding: "2px 10px", fontSize: 12,
                  borderColor: pasteTerrain ? "#f59e0b" : "#475569",
                  color: pasteTerrain ? "#fcd34d" : "#94a3b8",
                }}
                title={pasteTerrain ? "Terrain mode active: each column aligns to surface height (click to disable)" : "Enable terrain mode: align paste per column to surface height"}
              >
                {pasteTerrain ? "Terrain ✓" : "Terrain"}
              </button>
              {pasteTerrain && (
                <button
                  onClick={() => setPasteTerrainAbove((v) => !v)}
                  style={{
                    ...overlayBtn, padding: "2px 10px", fontSize: 12,
                    borderColor: pasteTerrainAbove ? "#fb923c" : "#475569",
                    color: pasteTerrainAbove ? "#fdba74" : "#94a3b8",
                  }}
                  title={pasteTerrainAbove ? "Bottom layer sits one block above surface (click to place at surface level)" : "Bottom layer sits at the surface block (click to place above surface)"}
                >
                  {pasteTerrainAbove ? "Above ✓" : "At surface"}
                </button>
              )}
              <button
                onClick={() => setTool("paste")}
                style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#22c55e", color: "#86efac" }}
                title="Enter paste mode — click map to place clipboard"
              >
                Paste
              </button>
              <label
                style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", userSelect: "none" }}
                title="Stay in paste mode after each placement so you can paste multiple times"
              >
                <input
                  type="checkbox"
                  checked={persistPaste}
                  onChange={(e) => setPersistPaste(e.target.checked)}
                  style={{ accentColor: "#22c55e", cursor: "pointer" }}
                />
                <span style={{ color: persistPaste ? "#6ee7b7" : "#94a3b8", fontSize: 11 }}>Repeat</span>
              </label>
            </div>
          )}

          {/* Row 2: block + paint picker — shown when selection exists or a draw tool is active */}
          {(selection || isDrawTool) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 4, borderTop: "1px solid #1e293b" }}>

              {/* Collapsible header */}
              <div
                onClick={() => setFillPickerOpen(v => !v)}
                style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}
              >
                <span style={{ color: "#475569", fontSize: 9 }}>{fillPickerOpen ? "▼" : "▶"}</span>
                <span style={{ color: isDrawTool ? "#f9a8d4" : "#64748b", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>
                  {isDrawTool ? "DRAW WITH" : "FILL / REPLACE"}
                </span>
                {!fillPickerOpen && (
                  <span style={{ color: "#64748b", fontSize: 11, marginLeft: 2 }}>
                    — {blockDisplayName(fillBlockType)}{fillPaint > 0 ? ` #${fillPaint}` : ""}
                  </span>
                )}
              </div>

              {/* Pickers row */}
              {fillPickerOpen && (
                <BlockPaintPicker
                  mode="fill"
                  blockType={fillBlockType}
                  paint={fillPaint}
                  onBlockTypeChange={(bt) => { if (bt !== null) setFillBlockType(bt); }}
                  onPaintChange={(p) => setFillPaint(p ?? 0)}
                  onFill={fillSelection}
                  selectionExists={!!selection}
                />
              )}

{/* Mask system — only visible when a draw tool is active */}
              {isDrawTool && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 4, borderTop: "1px solid #1e293b" }}>
                  <button
                    onClick={() => setMaskEnabled(v => !v)}
                    style={{
                      ...overlayBtn, padding: "1px 8px", fontSize: 11,
                      borderColor: maskEnabled ? "#a78bfa" : "#334155",
                      color: maskEnabled ? "#ddd6fe" : "#64748b",
                    }}
                    title="Mask: only paint on blocks matching the mask type/paint"
                  >
                    {maskEnabled ? "Mask ✓" : "Mask"}
                  </button>
                  {maskEnabled && (
                    <>
                      <span style={{ color: "#64748b", fontSize: 11 }}>Type:</span>
                      <select
                        value={maskBlockType ?? ""}
                        onChange={e => setMaskBlockType(e.target.value === "" ? null : Number(e.target.value))}
                        style={{ background: "#1e293b", border: "1px solid #475569", color: "#e2e8f0", borderRadius: 4, fontSize: 11, padding: "1px 3px" }}
                      >
                        <option value="">any</option>
                        {BLOCK_DEFS.map(b => <option key={b.type} value={b.type}>{b.name}</option>)}
                      </select>
                      <span style={{ color: "#64748b", fontSize: 11 }}>Paint:</span>
                      <select
                        value={maskPaint ?? ""}
                        onChange={e => setMaskPaint(e.target.value === "" ? null : Number(e.target.value))}
                        style={{ background: "#1e293b", border: "1px solid #475569", color: "#e2e8f0", borderRadius: 4, fontSize: 11, padding: "1px 3px" }}
                      >
                        <option value="">any</option>
                        <option value="0">none</option>
                        {Array.from({ length: 54 }, (_, i) => i + 1).map(p => <option key={p} value={p}>#{p}</option>)}
                      </select>
                    </>
                  )}
                </div>
              )}

              {/* Row 3: Replace only — filter for selective replace (selection required) */}
              {selection && <div style={{ borderTop: "1px solid #1e293b", paddingTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>

                {/* Collapsible replace header */}
                <div
                  onClick={() => setReplaceOpen(v => !v)}
                  style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}
                >
                  <span style={{ color: "#475569", fontSize: 9 }}>{replaceOpen ? "▼" : "▶"}</span>
                  <span style={{ color: "#64748b", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>REPLACE FILTER</span>
                  {!replaceOpen && (filterBlockType !== null || filterPaint !== null) && (
                    <span style={{ color: "#64748b", fontSize: 11, marginLeft: 2 }}>
                      — {filterBlockType !== null ? blockDisplayName(filterBlockType) : "any"}{filterPaint !== null ? ` #${filterPaint}` : ""}
                      {filterInvert ? " (inv)" : ""}
                    </span>
                  )}
                </div>

                {replaceOpen && <><div style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  <span style={{ color: "#64748b" }}>{filterInvert ? "Replace except:" : "Replace only:"}</span>
                  {filterBlockType === null ? (
                    <span style={{ color: "#475569" }}>any block</span>
                  ) : (
                    <span style={{ color: "#e2e8f0", fontWeight: 600 }}>
                      {blockDisplayName(filterBlockType)}
                    </span>
                  )}
                  <span style={{ color: "#1e293b" }}>·</span>
                  {filterPaint === null ? (
                    <span style={{ color: "#475569" }}>any paint</span>
                  ) : filterPaint === 0 ? (
                    <span style={{ color: "#475569" }}>no paint</span>
                  ) : (
                    <>
                      <span style={{ color: "#e2e8f0" }}>paint #{filterPaint}</span>
                      <span style={{
                        display: "inline-block", width: 10, height: 10, borderRadius: 2,
                        background: `rgb(${PAINT_COLORS[filterPaint - 1][0]},${PAINT_COLORS[filterPaint - 1][1]},${PAINT_COLORS[filterPaint - 1][2]})`,
                        border: "1px solid #475569", verticalAlign: "middle", flexShrink: 0,
                      }} />
                    </>
                  )}
                  {(filterBlockType !== null || filterPaint !== null) && (
                    <button
                      onClick={() => setFilterInvert((v) => !v)}
                      style={{
                        ...overlayBtn, padding: "1px 8px", fontSize: 11,
                        borderColor: filterInvert ? "#a78bfa" : "#475569",
                        color: filterInvert ? "#ddd6fe" : "#94a3b8",
                      }}
                      title={filterInvert
                        ? "Inverted: affects all blocks EXCEPT the filter match (click to restore normal mode)"
                        : "Normal: affects only blocks matching the filter (click to invert)"}
                    >
                      {filterInvert ? "Inverted ✓" : "Invert"}
                    </button>
                  )}
                </div>

                {/* Filter pickers row */}
                <BlockPaintPicker
                  mode="filter"
                  blockType={filterBlockType}
                  paint={filterPaint}
                  onBlockTypeChange={setFilterBlockType}
                  onPaintChange={setFilterPaint}
                />
                </>}{/* end replace expand */}
              </div>}{/* end replace-only section */}

            </div>
          )}
        </div>

        {/* Right panel: Selection Inspector */}
        {selection && (
          <SelectionInspector
            selection={selection}
            clipboard={clipboard}
            quadMode={showSlicePanels}
            extrudeCount={extrudeCount}
            onExtrudeCountChange={setExtrudeCount}
            extrudeAxis={extrudeAxis}
            onExtrudeAxisChange={setExtrudeAxis}
            onExtrude={handleExtrude}
            extrudeOpen={extrudeOpen}
            onExtrudeOpenChange={setExtrudeOpen}
            onSavePrefab={savePrefab}
            onGenerateTrees={handleGenerateTrees}
            topPx={showSlicePanels ? 92 : undefined}
          />
        )}

        {/* Bottom-right panel: full-height elevation view — opt-in; redundant in quad view (the slabs
            now carry its overlays), so it's suppressed while quad view is open. */}
        {!showSlicePanels && (pastePreviewSelection || selection) && (
          <ElevationPreviewPanel
            selection={pastePreviewSelection ?? selection!}
            maxZ={world.max_z}
            extrudeCount={pastePreviewSelection ? 0 : (extrudeOpen ? extrudeCount : 0)}
            extrudeAxis={extrudeAxis}
            isPastePreview={pastePreviewSelection !== null}
            editEpoch={editEpoch}
            drawActive={["pen","brush","rect","ellipse"].includes(tool)}
            onDrawElevation={handleDrawElevation}
            onZRangeChange={pastePreviewSelection ? undefined : (zMin, zMax) => { setZMin(zMin); setZMax(zMax); }}
          />
        )}

        {(exporting || exportingObj || loading) && (
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
        {showSettings && (
          <SettingsModal
            onClose={() => setShowSettings(false)}
            onSave={(s) => {
              setSaveCompressed(s.defaultSaveCompressed);
              if (s.templatePath !== templatePath) setTemplatePath(s.templatePath);
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
