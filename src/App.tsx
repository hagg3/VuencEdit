import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import MapCanvas, { type Tool, type SelectionBounds, type PixelPatch, type MapCanvasRef } from "./MapCanvas";
import { BLOCK_DEFS, PAINT_COLORS, resolveColor, RAMP_FAMILIES, RAMP_DIRS, rampFamilyBase, rampDirIndex, blockDisplayName } from "./blockDefs";
import SelectionInspector from "./SelectionInspector";
import ElevationPreviewPanel from "./ElevationPreviewPanel";
import HelpModal from "./HelpModal";
import WorldBrowserModal from "./WorldBrowserModal";
import UploadModal from "./UploadModal";
import "./App.css";

// World metadata — pixels are never stored in JS; tiles are fetched on demand.
interface WorldData {
  name: string;
  width_chunks: number;
  height_chunks: number;
  max_z: number;
  was_compressed: boolean;
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
  const [saving, setSaving] = useState(false);
  const [saveCompressed, setSaveCompressed] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const [drawMenuOpen, setDrawMenuOpen] = useState(false);
  const drawMenuRef = useRef<HTMLDivElement>(null);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const [tool, setTool] = useState<Tool>("pan");
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<"tiled" | "full" | "axo">("tiled");
  const [axoSkew, setAxoSkew] = useState(0.2);
  const [showHelp, setShowHelp] = useState(false);
  const [showElevationPanel, setShowElevationPanel] = useState(false);
  const [showWorldBrowser, setShowWorldBrowser] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);

  const [clipboard, setClipboard] = useState<ClipboardInfo | null>(null);
  const [pasteElevationOffset, setPasteElevationOffset] = useState(0);
  const [pasteIgnoreAir, setPasteIgnoreAir] = useState(false);
  const [persistPaste, setPersistPaste] = useState(false);
  const [pasteTerrain, setPasteTerrain] = useState(false);
  const [pasteTerrainAbove, setPasteTerrainAbove] = useState(true);
  const [lockedPastePos, setLockedPastePos] = useState<{ x: number; y: number } | null>(null);
  const lockedPastePosRef = useRef<{ x: number; y: number } | null>(null);
  const [editEpoch, setEditEpoch] = useState(0);

  const [extrudeCount, setExtrudeCount] = useState(2);
  const [extrudeAxis, setExtrudeAxis]   = useState<ExtrudeAxis>("z+");
  const [extrudeOpen, setExtrudeOpen]   = useState(true);

  const [brushSize,  setBrushSize]  = useState(3);
  const [brushShape, setBrushShape] = useState<"sq" | "circ">("sq");
  const [drawFilled, setDrawFilled] = useState(true);

  const [clipboardPreviewPixels, setClipboardPreviewPixels] = useState<{ width: number; height: number; pixels: Uint8Array } | null>(null);

  const appToolRef = useRef<Tool>("pan");
  useEffect(() => { appToolRef.current = tool; }, [tool]);
  useEffect(() => { lockedPastePosRef.current = lockedPastePos; }, [lockedPastePos]);
  useEffect(() => { if (tool !== "paste") setLockedPastePos(null); }, [tool]);
  useEffect(() => { if (lockedPastePos) setShowElevationPanel(true); }, [lockedPastePos]);

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

  async function handleGenerateTrees(treeType: TreeType, density: number) {
    if (!selection) return;
    try {
      const result = await invoke<EditResultRaw>("generate_trees", {
        x1: selection.x1, y1: selection.y1, x2: selection.x2, y2: selection.y2,
        treeType, density,
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
    setUndoDepth(raw.undo_depth);
    setRedoDepth(raw.redo_depth);
    setEditEpoch(e => e + 1);
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
    try {
      const w = world.width_chunks * 16;
      const h = world.height_chunks * 16;
      // Fetch the full-world pixel buffer from Rust for export.
      // This is the one place we allow a full-world pixel allocation in JS.
      const raw = viewMode === "zslice"
        ? await invoke<PixelPatchRaw>("render_zslice_patch", { z: zSliceZ, x1: 0, y1: 0, x2: w - 1, y2: h - 1 })
        : await invoke<PixelPatchRaw>("fetch_tile", { x1: 0, y1: 0, x2: w - 1, y2: h - 1 });
      const pixels = decodePixels(raw.pixels);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      const img = ctx.createImageData(w, h);
      img.data.set(pixels);
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
      if (!persistPaste) setTool("pan");
      await applyEditResult(result);
    } catch (e) {
      setError(String(e));
    }
  }

  function handlePasteClick(pos: { x: number; y: number }) {
    if (persistPaste) {
      pasteAt(pos);
    } else if (lockedPastePos) {
      pasteAt(lockedPastePos);
      setLockedPastePos(null);
    } else {
      setLockedPastePos(pos);
    }
  }

  async function handleDrawStroke(pts: [number, number][], zOverride: number | null) {
    try {
      const blocks = pts.map(([x, y]) => ({ x, y, z: zOverride }));
      const result = await invoke<EditResultRaw>("paint_blocks", {
        blocks, blockType: fillBlockType, paint: fillPaint,
      });
      await applyEditResult(result);
    } catch (e) {
      setError(String(e));
    }
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
        if (t === "paste" || t === "pen" || t === "brush" || t === "rect" || t === "ellipse") {
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
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); handleRedo(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [world, showHelp, handleUndo, handleRedo]);

  // Close menus when clicking outside them.
  useEffect(() => {
    if (!fileMenuOpen) return;
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
    if (!drawMenuOpen) return;
    function handleOutside(e: MouseEvent) {
      if (drawMenuRef.current && !drawMenuRef.current.contains(e.target as Node)) {
        setDrawMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [drawMenuOpen]);

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
  const drawToolIcons: Record<DrawToolKey, string> = { pen: "✏", brush: "⬟", rect: "□", ellipse: "○" };
  const drawToolNames: Record<DrawToolKey, string> = { pen: "Pen", brush: "Brush", rect: "Rect", ellipse: "Ellipse" };
  const isDrawTool = tool === "pen" || tool === "brush" || tool === "rect" || tool === "ellipse";
  const swatchColor = resolveColor(fillBlockType, fillPaint);

  if (world) {
    return (
      <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
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
          drawConfig={{ brushSize, brushShape, fillMode: drawFilled ? "fill" : "outline" }}
          onDrawStroke={handleDrawStroke}
          drawZOverride={viewMode === "zslice" ? zSliceZ : null}
        />

        {/* Top-left: world info */}
        <div style={{
          position: "absolute", top: 12, left: 12,
          background: "rgba(0,0,0,0.6)", padding: "5px 12px",
          borderRadius: 6, fontSize: 13, pointerEvents: "none", userSelect: "none",
        }}>
          <strong>{world.name}</strong>
          <span style={{ marginLeft: 10, color: "#94a3b8" }}>
            {world.width_chunks}×{world.height_chunks} chunks
          </span>
          {viewMode === "zslice" && (
            <span style={{ marginLeft: 10, color: "#7dd3fc" }}>z={zSliceZ}</span>
          )}
          <span style={{
            marginLeft: 10, fontSize: 11,
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
            <button onClick={() => setTool("select")} style={tool === "select" ? overlayBtnActive : overlayBtn}>Select</button>
            <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
            <div ref={drawMenuRef} style={{ position: "relative" }}>
              <button
                onClick={() => setDrawMenuOpen(v => !v)}
                style={isDrawTool
                  ? { ...overlayBtnActive, borderColor: "#f472b6", color: "#fbcfe8" }
                  : drawMenuOpen
                    ? { ...overlayBtn, borderColor: "#f472b6", color: "#fbcfe8" }
                    : overlayBtn}
                title="Drawing tools (P/B/R/E)"
              >
                {isDrawTool ? `${drawToolIcons[tool as DrawToolKey]} ${drawToolNames[tool as DrawToolKey]}` : "Draw"} {drawMenuOpen ? "▴" : "▾"}
              </button>
              {drawMenuOpen && (
                <div style={{
                  position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
                  background: "#0d1829", border: "1px solid #831843",
                  borderRadius: 7, padding: "8px", minWidth: 190,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 200,
                }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 4 }}>
                    {(["pen", "brush", "rect", "ellipse"] as const).map(t => (
                      <button key={t} onClick={() => setTool(t)} style={{
                        ...overlayBtn, fontSize: 12, padding: "5px 8px", textAlign: "center",
                        borderColor: tool === t ? "#f472b6" : "#334155",
                        color: tool === t ? "#fbcfe8" : "#94a3b8",
                        background: tool === t ? "rgba(244,114,182,0.1)" : "rgba(0,0,0,0.4)",
                      }}>
                        {drawToolIcons[t]} {drawToolNames[t]}
                        <span style={{ color: "#475569", fontSize: 10, marginLeft: 3 }}>({t[0].toUpperCase()})</span>
                      </button>
                    ))}
                  </div>
                  {isDrawTool && (
                    <div style={{ borderTop: "1px solid #1e293b", paddingTop: 8 }}>
                      {tool === "brush" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ color: "#64748b", fontSize: 11, minWidth: 36 }}>Size</span>
                            {([1, 3, 5, 7, 9] as const).map(s => (
                              <button key={s} onClick={() => setBrushSize(s)} style={{
                                ...overlayBtn, padding: "1px 6px", fontSize: 11,
                                borderColor: brushSize === s ? "#f472b6" : "#334155",
                                color: brushSize === s ? "#fbcfe8" : "#94a3b8",
                              }}>{s}</button>
                            ))}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ color: "#64748b", fontSize: 11, minWidth: 36 }}>Shape</span>
                            <button onClick={() => setBrushShape("sq")} style={{
                              ...overlayBtn, padding: "1px 8px", fontSize: 11,
                              borderColor: brushShape === "sq" ? "#f472b6" : "#334155",
                              color: brushShape === "sq" ? "#fbcfe8" : "#94a3b8",
                            }}>■ Square</button>
                            <button onClick={() => setBrushShape("circ")} style={{
                              ...overlayBtn, padding: "1px 8px", fontSize: 11,
                              borderColor: brushShape === "circ" ? "#f472b6" : "#334155",
                              color: brushShape === "circ" ? "#fbcfe8" : "#94a3b8",
                            }}>● Circle</button>
                          </div>
                        </div>
                      )}
                      {(tool === "rect" || tool === "ellipse") && (
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ color: "#64748b", fontSize: 11, minWidth: 36 }}>Mode</span>
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
                        </div>
                      )}
                    </div>
                  )}
                  <div style={{ borderTop: "1px solid #1e293b", marginTop: 8, paddingTop: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ color: "#475569", fontSize: 10 }}>DRAWING WITH</span>
                      <div style={{
                        width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                        background: `rgb(${swatchColor[0]},${swatchColor[1]},${swatchColor[2]})`,
                        border: "1px solid rgba(255,255,255,0.2)",
                      }} />
                      <span style={{ color: "#94a3b8", fontSize: 11 }}>
                        {blockDisplayName(fillBlockType)}{fillPaint > 0 ? ` / paint ${fillPaint}` : ""}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
            <button
              onClick={handleUndo} disabled={undoDepth === 0}
              style={{ ...overlayBtn, opacity: undoDepth === 0 ? 0.4 : 1, cursor: undoDepth === 0 ? "not-allowed" : "pointer" }}
              title="Undo (Cmd+Z)"
            >Undo</button>
            <button
              onClick={handleRedo} disabled={redoDepth === 0}
              style={{ ...overlayBtn, opacity: redoDepth === 0 ? 0.4 : 1, cursor: redoDepth === 0 ? "not-allowed" : "pointer" }}
              title="Redo (Cmd+Shift+Z)"
            >Redo</button>
          </div>

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
            </div>
          )}
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
                {/* Render mode */}
                <div style={{ ...menuItem, color: "#475569", fontSize: 11, cursor: "default", paddingBottom: 2 }}>
                  RENDER MODE
                </div>
                <button
                  onClick={() => { setViewMenuOpen(false); setRenderMode("tiled"); }}
                  style={menuItem}
                >
                  <span style={{ display: "inline-block", width: 16, color: "#3b82f6" }}>{renderMode === "tiled" ? "●" : ""}</span>
                  Tiled
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
              </div>
            )}
          </div>

          {/* File ▾ dropdown */}
          <div ref={fileMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => { setViewMenuOpen(false); setFileMenuOpen(v => !v); }}
              style={{
                ...overlayBtn,
                borderColor: fileMenuOpen ? "#3b82f6" : (saving || exporting ? "#475569" : undefined),
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
                {/* Open */}
                <button onClick={() => { setFileMenuOpen(false); openFile(); }} style={menuItem}>
                  Open…
                </button>
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
                  <button onClick={() => { setFileMenuOpen(false); loadPrefab(); }} style={menuItem}>
                    Load Prefab
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

          {/* Help */}
          <button
            onClick={() => setShowHelp(h => !h)}
            style={showHelp ? { ...overlayBtn, background: "rgba(59,130,246,0.35)", borderColor: "#3b82f6" } : overlayBtn}
            title="Keyboard shortcuts (?)"
          >
            ?
          </button>
        </div>

        {/* Bottom-left: z-range + selection info + fill picker */}
        <div style={{
          position: "absolute", bottom: 16, left: 12,
          background: "rgba(0,0,0,0.72)", padding: "6px 12px",
          borderRadius: 6, fontSize: 13,
          display: "flex", flexDirection: "column", gap: 6,
          border: `1px solid ${tool === "paste" ? (lockedPastePos ? "#f59e0b" : "#22c55e") : isDrawTool ? "#831843" : selection ? "#3b82f6" : "#334155"}`,
          maxWidth: "calc(100vw - 24px)",
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
                Flip X
              </button>
              <button
                onClick={mirrorClipboardY}
                style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#a78bfa", color: "#ddd6fe" }}
                title="Mirror clipboard top↔bottom (flip on Y axis)"
              >
                Flip Y
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
                <button
                  onClick={() => setRawBounds(null)}
                  style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12 }}
                >
                  Clear
                </button>
              </>
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
                Flip X
              </button>
              <button
                onClick={mirrorClipboardY}
                style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#a78bfa", color: "#ddd6fe" }}
                title="Mirror clipboard top↔bottom (flip on Y axis)"
              >
                Flip Y
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

              {/* Text summary: selected block name + paint */}
              <div style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                <span style={{ color: isDrawTool ? "#f9a8d4" : "#64748b" }}>{isDrawTool ? "Draw with:" : "Fill with:"}</span>
                <span style={{ color: "#e2e8f0", fontWeight: 600 }}>
                  {blockDisplayName(fillBlockType)}
                </span>
                <span style={{ color: "#1e293b" }}>·</span>
                <span style={{ color: "#64748b" }}>Paint:</span>
                {fillPaint === 0 ? (
                  <span style={{ color: "#475569" }}>none</span>
                ) : (
                  <>
                    <span style={{ color: "#e2e8f0" }}>#{fillPaint}</span>
                    <span style={{
                      display: "inline-block", width: 10, height: 10, borderRadius: 2,
                      background: `rgb(${PAINT_COLORS[fillPaint - 1][0]},${PAINT_COLORS[fillPaint - 1][1]},${PAINT_COLORS[fillPaint - 1][2]})`,
                      border: "1px solid #475569", verticalAlign: "middle", flexShrink: 0,
                    }} />
                  </>
                )}
              </div>

              {/* Pickers row */}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>

              {/* Block type 7×5 grid */}
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ color: "#64748b", fontSize: 11 }}>Block</span>
                <div
                  title="Air — erase blocks in the selection"
                  onClick={() => setFillBlockType(0)}
                  style={{
                    fontSize: 10, textAlign: "center", cursor: "pointer",
                    padding: "1px 0", borderRadius: 2, userSelect: "none",
                    border: fillBlockType === 0 ? "1px solid #3b82f6" : "1px solid #334155",
                    background: fillBlockType === 0 ? "rgba(59,130,246,0.25)" : "rgba(0,0,0,0.3)",
                    color: fillBlockType === 0 ? "#93c5fd" : "#475569",
                  }}
                >
                  Air
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 18px)", gap: 2 }}>
                  {BLOCK_DEFS.map((b) => {
                    const selected = fillBlockType === b.type ||
                      (rampFamilyBase(fillBlockType) !== null &&
                       rampFamilyBase(fillBlockType) === rampFamilyBase(b.type));
                    return (
                      <div
                        key={b.type}
                        title={`${b.name} (type ${b.type})`}
                        onClick={() => setFillBlockType(b.type)}
                        style={{
                          width: 18, height: 18,
                          background: `rgb(${b.color[0]},${b.color[1]},${b.color[2]})`,
                          borderRadius: 2, cursor: "pointer",
                          boxSizing: "border-box",
                          border: selected ? "2px solid #fff" : "2px solid rgba(255,255,255,0.08)",
                          outline: selected ? "1px solid #3b82f6" : "none",
                          outlineOffset: 1,
                        }}
                      />
                    );
                  })}
                </div>
                {/* Orientation selector — only shown when a ramp family is selected */}
                {rampFamilyBase(fillBlockType) !== null && (() => {
                  const base = rampFamilyBase(fillBlockType)!;
                  const family = RAMP_FAMILIES.find((f) => f.base === base);
                  return (
                    <div style={{ display: "flex", alignItems: "center", gap: 3, marginTop: 1 }}>
                      <span style={{ color: "#64748b", fontSize: 9, minWidth: 20 }}>Dir</span>
                      {RAMP_DIRS.map((dir, i) => {
                        const active = rampDirIndex(fillBlockType) === i;
                        return (
                          <button
                            key={dir}
                            onClick={() => setFillBlockType(base + i)}
                            style={{
                              width: 22, padding: "1px 0", fontSize: 10, cursor: "pointer",
                              background: active ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
                              border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
                              color: active ? "#93c5fd" : "#64748b",
                              borderRadius: 3,
                            }}
                            title={`${family?.name} facing ${["South", "West", "North", "East"][i]}`}
                          >
                            {dir}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              <div style={{ width: 1, background: "#1e293b", alignSelf: "stretch" }} />

              {/* Paint picker: no-paint + 9×6 color grid */}
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ color: "#64748b", fontSize: 11 }}>Paint</span>
                <div style={{ display: "flex", gap: 3 }}>
                  {/* No-paint swatch */}
                  <div
                    title="No paint (use block default color)"
                    onClick={() => setFillPaint(0)}
                    style={{
                      width: 18, height: 18, flexShrink: 0,
                      background: "transparent",
                      borderRadius: 2, cursor: "pointer",
                      boxSizing: "border-box",
                      border: fillPaint === 0 ? "2px solid #fff" : "2px solid #334155",
                      outline: fillPaint === 0 ? "1px solid #3b82f6" : "none",
                      outlineOffset: 1,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "#475569", fontSize: 11, lineHeight: 1,
                    }}
                  >
                    ✕
                  </div>
                  {/* 9-per-row grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(9, 18px)", gap: 2 }}>
                    {PAINT_COLORS.map(([r, g, b], i) => (
                      <div
                        key={i}
                        title={`Paint color ${i + 1}`}
                        onClick={() => setFillPaint(i + 1)}
                        style={{
                          width: 18, height: 18,
                          background: `rgb(${r},${g},${b})`,
                          borderRadius: 2, cursor: "pointer",
                          boxSizing: "border-box",
                          border: fillPaint === i + 1
                            ? "2px solid #fff"
                            : "2px solid rgba(255,255,255,0.08)",
                          outline: fillPaint === i + 1 ? "1px solid #3b82f6" : "none",
                          outlineOffset: 1,
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ width: 1, background: "#1e293b", alignSelf: "stretch" }} />

              {/* Preview + Fill button */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4, justifyContent: "flex-end", alignSelf: "flex-end" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div
                    title="Preview: selected block + paint"
                    style={{
                      width: 22, height: 22, borderRadius: 3, flexShrink: 0,
                      background: (() => {
                        const [r, g, b] = resolveColor(fillBlockType, fillPaint);
                        return `rgb(${r},${g},${b})`;
                      })(),
                      border: "1px solid #475569",
                    }}
                  />
                  {selection && (
                    <button
                      onClick={fillSelection}
                      style={{ ...overlayBtn, padding: "2px 10px", fontSize: 12, borderColor: "#22c55e", color: "#86efac", whiteSpace: "nowrap" }}
                      title="Fill every block in the selection with the chosen type and paint"
                    >
                      Fill Selection
                    </button>
                  )}
                </div>
              </div>

              </div>{/* end pickers row */}

              {/* Row 3: Replace only — filter for selective replace (selection required) */}
              {selection && <div style={{ borderTop: "1px solid #1e293b", paddingTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>

                {/* Summary label for filter */}
                <div style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
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
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, overflowX: "auto" }}>

                  {/* Filter block picker */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, flexShrink: 0 }}>
                    <span style={{ color: "#64748b", fontSize: 11 }}>Block</span>
                    {/* "Any block" toggle */}
                    <div
                      onClick={() => setFilterBlockType(null)}
                      style={{
                        fontSize: 10, textAlign: "center", cursor: "pointer",
                        padding: "1px 0", borderRadius: 2, userSelect: "none",
                        border: filterBlockType === null ? "1px solid #3b82f6" : "1px solid #334155",
                        background: filterBlockType === null ? "rgba(59,130,246,0.25)" : "rgba(255,255,255,0.04)",
                        color: filterBlockType === null ? "#93c5fd" : "#475569",
                      }}
                    >
                      Any
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 18px)", gap: 2 }}>
                      {BLOCK_DEFS.map((b) => {
                        const selected = filterBlockType === b.type ||
                          (filterBlockType !== null &&
                           rampFamilyBase(filterBlockType) !== null &&
                           rampFamilyBase(filterBlockType) === rampFamilyBase(b.type));
                        return (
                        <div
                          key={b.type}
                          title={`${b.name} (type ${b.type})`}
                          onClick={() => setFilterBlockType(b.type)}
                          style={{
                            width: 18, height: 18,
                            background: `rgb(${b.color[0]},${b.color[1]},${b.color[2]})`,
                            borderRadius: 2, cursor: "pointer",
                            boxSizing: "border-box",
                            border: selected ? "2px solid #fff" : "2px solid rgba(255,255,255,0.08)",
                            outline: selected ? "1px solid #3b82f6" : "none",
                            outlineOffset: 1,
                          }}
                        />
                        );
                      })}
                    </div>
                    {/* Orientation selector — only shown when a ramp family is the active filter */}
                    {filterBlockType !== null && rampFamilyBase(filterBlockType) !== null && (() => {
                      const base = rampFamilyBase(filterBlockType)!;
                      const family = RAMP_FAMILIES.find((f) => f.base === base);
                      return (
                        <div style={{ display: "flex", alignItems: "center", gap: 3, marginTop: 1 }}>
                          <span style={{ color: "#64748b", fontSize: 9, minWidth: 20 }}>Dir</span>
                          {RAMP_DIRS.map((dir, i) => {
                            const active = rampDirIndex(filterBlockType) === i;
                            return (
                              <button
                                key={dir}
                                onClick={() => setFilterBlockType(base + i)}
                                style={{
                                  width: 22, padding: "1px 0", fontSize: 10, cursor: "pointer",
                                  background: active ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
                                  border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
                                  color: active ? "#93c5fd" : "#64748b",
                                  borderRadius: 3,
                                }}
                                title={`${family?.name} facing ${["South", "West", "North", "East"][i]}`}
                              >
                                {dir}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>

                  <div style={{ width: 1, background: "#1e293b", alignSelf: "stretch", flexShrink: 0 }} />

                  {/* Filter paint picker */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, flexShrink: 0 }}>
                    <span style={{ color: "#64748b", fontSize: 11 }}>Paint</span>
                    <div style={{ display: "flex", gap: 3 }}>
                      {/* "Any paint" toggle */}
                      <div
                        title="Any paint (no paint filter)"
                        onClick={() => setFilterPaint(null)}
                        style={{
                          width: 18, height: 18, flexShrink: 0,
                          borderRadius: 2, cursor: "pointer",
                          boxSizing: "border-box",
                          border: filterPaint === null ? "2px solid #fff" : "2px solid #334155",
                          outline: filterPaint === null ? "1px solid #3b82f6" : "none",
                          outlineOffset: 1,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          background: filterPaint === null ? "rgba(59,130,246,0.25)" : "rgba(255,255,255,0.04)",
                          color: filterPaint === null ? "#93c5fd" : "#475569",
                          fontSize: 9, lineHeight: 1, userSelect: "none",
                        }}
                      >
                        Any
                      </div>
                      {/* No-paint swatch */}
                      <div
                        title="No paint (unpainted blocks only)"
                        onClick={() => setFilterPaint(0)}
                        style={{
                          width: 18, height: 18, flexShrink: 0,
                          background: "transparent",
                          borderRadius: 2, cursor: "pointer",
                          boxSizing: "border-box",
                          border: filterPaint === 0 ? "2px solid #fff" : "2px solid #334155",
                          outline: filterPaint === 0 ? "1px solid #3b82f6" : "none",
                          outlineOffset: 1,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          color: "#475569", fontSize: 11, lineHeight: 1,
                        }}
                      >
                        ✕
                      </div>
                      {/* 9-per-row paint grid */}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(9, 18px)", gap: 2 }}>
                        {PAINT_COLORS.map(([r, g, b], i) => (
                          <div
                            key={i}
                            title={`Paint color ${i + 1}`}
                            onClick={() => setFilterPaint(i + 1)}
                            style={{
                              width: 18, height: 18,
                              background: `rgb(${r},${g},${b})`,
                              borderRadius: 2, cursor: "pointer",
                              boxSizing: "border-box",
                              border: filterPaint === i + 1
                                ? "2px solid #fff"
                                : "2px solid rgba(255,255,255,0.08)",
                              outline: filterPaint === i + 1 ? "1px solid #3b82f6" : "none",
                              outlineOffset: 1,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                </div>{/* end filter pickers row */}
              </div>}{/* end replace-only section */}

            </div>
          )}
        </div>

        {/* Right panel: Selection Inspector */}
        {selection && (
          <SelectionInspector
            selection={selection}
            clipboard={clipboard}
            elevationPanelOpen={showElevationPanel}
            onToggleElevationPanel={() => setShowElevationPanel(v => !v)}
            extrudeCount={extrudeCount}
            onExtrudeCountChange={setExtrudeCount}
            extrudeAxis={extrudeAxis}
            onExtrudeAxisChange={setExtrudeAxis}
            onExtrude={handleExtrude}
            extrudeOpen={extrudeOpen}
            onExtrudeOpenChange={setExtrudeOpen}
            onSavePrefab={savePrefab}
            onGenerateTrees={handleGenerateTrees}
          />
        )}

        {/* Bottom-right panel: full-height elevation view — opt-in, off by default */}
        {(pastePreviewSelection || selection) && showElevationPanel && (
          <ElevationPreviewPanel
            selection={pastePreviewSelection ?? selection!}
            maxZ={world.max_z}
            extrudeCount={pastePreviewSelection ? 0 : (extrudeOpen ? extrudeCount : 0)}
            extrudeAxis={extrudeAxis}
            isPastePreview={pastePreviewSelection !== null}
            editEpoch={editEpoch}
            drawActive={["pen","brush","rect","ellipse"].includes(tool)}
            onDrawElevation={handleDrawElevation}
          />
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
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", height: "100vh", gap: 16,
    }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: "#e2e8f0", margin: 0 }}>
        Eden World Editor
      </h1>
      <p style={{ color: "#94a3b8", margin: 0, fontSize: 14 }}>
        Load a .eden save file to view the map
      </p>
      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={openFile} disabled={loading}
          style={{
            background: "#334155", border: "1px solid #475569", color: "#e2e8f0",
            padding: "10px 24px", borderRadius: 8,
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: 15, fontWeight: 600, opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? "Loading…" : "Open Local File"}
        </button>
        <button
          onClick={() => setShowWorldBrowser(true)} disabled={loading}
          style={{
            background: "#3b82f6", border: "none", color: "#fff",
            padding: "10px 24px", borderRadius: 8,
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: 15, fontWeight: 600, opacity: loading ? 0.6 : 1,
          }}
        >
          Browse Worlds
        </button>
      </div>
      {error && (
        <p style={{ color: "#f87171", fontSize: 13, maxWidth: 400, textAlign: "center" }}>
          {error}
        </p>
      )}
      {showWorldBrowser && (
        <WorldBrowserModal
          onClose={() => setShowWorldBrowser(false)}
          onOpenWorld={(path) => { setShowWorldBrowser(false); openFileAt(path); }}
        />
      )}
    </div>
  );
}

export default App;
