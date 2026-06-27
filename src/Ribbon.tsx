import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { Tool, SelectionBounds } from "./MapCanvas";
import type { SelectionInfo, ClipboardInfo, ExtrudeAxis } from "./App";
import BlockPaintPicker from "./BlockPaintPicker";
import { BLOCK_DEFS, resolveColor, blockDisplayName } from "./blockDefs";
import { tintedSwatch } from "./texturePack";
import appIcon from "./assets/app-icon.png";

export const RIBBON_HEIGHT_COLLAPSED = 32;
export const TAB_BAR_HEIGHT = 32;
export const DEFAULT_BODY_HEIGHT = 96;

interface RecentWorld { path: string; name: string; timestamp: number; }
interface WorldData { name: string; width_chunks: number; height_chunks: number; max_z: number; }

export type RibbonTab = "home" | "draw" | "insert" | "view" | "selection" | "paste";

export interface RibbonProps {
  world: WorldData | null;
  appVersion: string;
  // World rename
  renamingWorld: boolean; renameInput: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  setRenamingWorld: (v: boolean) => void;
  setRenameInput: (v: string) => void;
  onRenameBlur: (trimmed: string) => void;
  // Tool
  tool: Tool; setTool: (t: Tool) => void;
  isDrawTool: boolean; isSculptTool: boolean;
  wandMatchPaint: boolean; setWandMatchPaint: (v: boolean) => void;
  // Undo/Redo
  undoDepth: number; redoDepth: number;
  handleUndo: () => void; handleRedo: () => void;
  // Draw
  brushSize: number; setBrushSize: (v: number) => void;
  brushShape: "sq" | "circ"; setBrushShape: (v: "sq" | "circ") => void;
  drawFilled: boolean; setDrawFilled: (v: boolean) => void;
  drawAbove: boolean; setDrawAbove: (v: boolean) => void;
  sculptStrength: number; setSculptStrength: (v: number) => void;
  prevToolRef: React.RefObject<Tool>;
  fillBlockType: number; fillPaint: number;
  setFillBlockType: (v: number) => void; setFillPaint: (v: number) => void;
  // Hotbar
  pinnedBlocks: ({type: number; paint: number} | null)[];
  recentBlocks: {type: number; paint: number}[];
  hotbarHover: string | null;
  setPinnedBlocks: React.Dispatch<React.SetStateAction<({type: number; paint: number} | null)[]>>;
  setHotbarHover: (v: string | null) => void;
  // Mask
  maskEnabled: boolean; setMaskEnabled: (v: boolean) => void;
  maskBlockType: number | null; setMaskBlockType: (v: number | null) => void;
  maskPaint: number | null; setMaskPaint: (v: number | null) => void;
  // Z-range
  zMin: number; zMax: number;
  handleZMin: (v: string) => void; handleZMax: (v: string) => void;
  // View
  viewMode: "topdown" | "zslice"; setViewMode: (v: "topdown" | "zslice") => void;
  zSliceZ: number; zSliceDisplay: number;
  setZSliceDisplay: (v: number) => void; commitZSlice: (v: number) => void;
  followSurface: boolean; setFollowSurface: (v: boolean) => void;
  renderMode: "tiled" | "full" | "axo"; setRenderMode: (v: "tiled" | "full" | "axo") => void;
  axoSkew: number; setAxoSkew: (v: number) => void;
  showSlicePanels: boolean; setShowSlicePanels: (v: boolean) => void;
  enable3dPane: boolean; setEnable3dPane: (v: boolean) => void;
  onFitMap: () => void;
  // Template
  templateLoaded: boolean; templatePath: string | null;
  showTemplateOverlay: boolean; setShowTemplateOverlay: (v: boolean) => void;
  openTemplateFile: () => void;
  // Texture pack
  texturePackLoaded: boolean; texturePackPath: string | null;
  texturePack?: import("./texturePack").AtlasData | null;
  openTexturePackFile: () => void;
  unloadTexturePack: () => void;
  // Spawn
  spawnPos: { px: number; py: number } | null;
  onSetSpawnAtSelection: () => void;
  // Selection
  selection: SelectionInfo | null;
  rawBounds: SelectionBounds | null;
  setRawBounds: React.Dispatch<React.SetStateAction<SelectionBounds | null>>;
  copySelection: () => void; deleteBlocks: () => void; fillSelection: () => void;
  // Filter
  filterBlockType: number | null; filterPaint: number | null; filterInvert: boolean;
  setFilterBlockType: (v: number | null) => void;
  setFilterPaint: (v: number | null) => void;
  setFilterInvert: (v: boolean) => void;
  // Paste / Clipboard
  clipboard: ClipboardInfo | null;
  pasteElevationOffset: number; setPasteElevationOffset: (v: number) => void;
  pasteIgnoreAir: boolean; setPasteIgnoreAir: (v: boolean) => void;
  pasteTerrain: boolean; setPasteTerrain: (v: boolean) => void;
  pasteTerrainAbove: boolean; setPasteTerrainAbove: (v: boolean) => void;
  persistPaste: boolean; setPersistPaste: (v: boolean) => void;
  lockedPastePos: { x: number; y: number } | null;
  setLockedPastePos: (v: { x: number; y: number } | null) => void;
  pasteMode: "normal" | "scatter" | "array"; setPasteMode: (v: "normal" | "scatter" | "array") => void;
  scatterCount: number; setScatterCount: (v: number) => void;
  arrayCols: number; setArrayCols: (v: number) => void;
  arrayRows: number; setArrayRows: (v: number) => void;
  arraySpacingX: number; setArraySpacingX: (v: number) => void;
  arraySpacingY: number; setArraySpacingY: (v: number) => void;
  rotateClipboard: () => void; mirrorClipboardX: () => void; mirrorClipboardY: () => void;
  pasteAt: (pos: { x: number; y: number }) => void;
  onSavePrefab: () => void;
  // Extrude
  extrudeCount: number; setExtrudeCount: (n: number) => void;
  extrudeAxis: ExtrudeAxis; setExtrudeAxis: (a: ExtrudeAxis) => void;
  extrudeOpen: boolean; setExtrudeOpen: (v: boolean) => void;
  onExtrude: (ignoreAir: boolean) => void;
  // Trees
  treeTypes: string[]; setTreeTypes: (v: string[]) => void;
  treeDensity: number; setTreeDensity: (v: number) => void;
  leafPaints: number[]; setLeafPaints: (v: number[]) => void;
  smartPlacement: boolean; setSmartPlacement: (v: boolean) => void;
  onGenerateTrees: (treeTypes: string[], density: number, leafPaints: number[], smartPlacement: boolean) => void;
  // File ops
  sourcePath: string | null; saving: boolean;
  exporting: boolean; exportingObj: boolean; exportingJson: boolean;
  saveCompressed: boolean; setSaveCompressed: (v: boolean) => void;
  recentWorlds: RecentWorld[];
  openFile: () => void; openFileAt: (path: string) => void;
  saveWorld: (path: string) => void; saveWorldAs: () => void;
  exportPng: () => void; exportObj: () => void; exportJson: () => void;
  loadPrefab: () => void; importSchematic: () => void;
  setShowNewWorld: (v: boolean) => void; setShowWorldBrowser: (v: boolean) => void;
  setShowUploadModal: (v: boolean) => void;
  setShowExpandModal: (v: boolean) => void; setExpandResult: (v: null) => void;
  closeWorld: () => void;
  // Help/About/Settings
  setShowHelp: (v: boolean) => void;
  setShowAbout: (v: boolean) => void;
  setShowSettings: (v: boolean) => void;
  // Resize
  ribbonBodyHeight: number;
  onBodyHeightChange: (h: number) => void;
  // Collapse
  collapsed: boolean; onCollapse: (v: boolean) => void;
}

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

// ── shared styles ──────────────────────────────────────────────────────────────

const rb: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)", border: "1px solid #2a3448",
  color: "#cbd5e1", padding: "2px 8px", borderRadius: 3, cursor: "pointer",
  fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap", outline: "none",
};
const rbDim: React.CSSProperties = {
  ...rb, color: "#64748b", borderColor: "#334155", background: "rgba(255,255,255,0.03)",
};
const rbActive = (accent = "#3b82f6"): React.CSSProperties => {
  const rgb = accent === "#3b82f6" ? "59,130,246"
    : accent === "#f59e0b" ? "245,158,11"
    : accent === "#a78bfa" ? "167,139,250"
    : accent === "#4ade80" ? "74,222,128"
    : "34,197,94";
  const textColor = accent === "#3b82f6" ? "#93c5fd"
    : accent === "#f59e0b" ? "#fcd34d"
    : accent === "#a78bfa" ? "#c4b5fd"
    : "#86efac";
  return { ...rb, background: `rgba(${rgb},0.18)`, borderColor: accent, color: textColor };
};
const rbGroup: React.CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3,
  padding: "5px 10px 4px", position: "relative", minWidth: 0, flexShrink: 0,
};
const rbGroupLabel: React.CSSProperties = {
  fontSize: 9, color: "#475569", letterSpacing: "0.07em", fontWeight: 700,
  textTransform: "uppercase", userSelect: "none", marginTop: "auto",
  paddingTop: 3, textAlign: "center", alignSelf: "stretch",
  borderTop: "1px solid #1a2d4a",
};
const rbDivider: React.CSSProperties = {
  width: 1, background: "#233452", alignSelf: "stretch", margin: "4px 2px",
  boxShadow: "1px 0 0 rgba(255,255,255,0.03)",
};
const zInp: React.CSSProperties = {
  width: 46, background: "rgba(0,0,0,0.4)", border: "1px solid #2a3448",
  color: "#e2e8f0", borderRadius: 3, padding: "1px 4px", fontSize: 11,
  textAlign: "center", outline: "none",
};
const expBadge: React.CSSProperties = {
  fontSize: 8, color: "#f59e0b", background: "rgba(245,158,11,0.12)",
  border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px",
};

// Inline SVG cursor for Pan button
function PanCursorIcon() {
  return (
    <svg width="12" height="13" viewBox="0 0 12 13" fill="none" style={{ display: "block", flexShrink: 0 }}>
      <path d="M1 1L1.5 11.5L4.5 8.5L6.5 12L8 11L6 7.5L10 6.5L1 1Z" fill="currentColor" stroke="currentColor" strokeWidth="0.4" strokeLinejoin="round"/>
    </svg>
  );
}

function ClipboardIcon() {
  return (
    <svg width="12" height="13" viewBox="0 0 12 13" fill="none" style={{ display: "block", flexShrink: 0 }}>
      <rect x="1.5" y="3" width="9" height="9.5" rx="1.2" stroke="currentColor" strokeWidth="1.1" fill="none"/>
      <rect x="3.5" y="1" width="5" height="3" rx="0.8" stroke="currentColor" strokeWidth="1" fill="none"/>
      <line x1="3.5" y1="6.5" x2="8.5" y2="6.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <line x1="3.5" y1="8.5" x2="7" y2="8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  );
}

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg width="10" height="7" viewBox="0 0 10 7" fill="none" style={{ display: "block", transition: "transform 0.15s", transform: up ? "none" : "rotate(180deg)" }}>
      <path d="M1 5.5L5 1.5L9 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// Leaf colors for trees
const LEAF_COLORS: [number, string, string][] = [
  [0,  "#1eb428", "Natural (unpainted)"],
  [4,  "#aaffbf", "Light green"],
  [13, "#55ff7f", "Medium light green"],
  [22, "#00ff3f", "Green"],
  [31, "#00bf2f", "Medium dark green"],
  [40, "#007f1f", "Dark green"],
  [49, "#003f0f", "Very dark green"],
  [19, "#ff0000", "Red"],
  [20, "#ffbf00", "Orange"],
  [21, "#f2ff00", "Yellow"],
];

// ── Picker portal ──────────────────────────────────────────────────────────────

interface PickerState {
  type: "block-draw" | "block-fill" | "filter";
  top: number; left: number;
}

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export default function Ribbon(p: RibbonProps) {
  const [activeTab, setActiveTab] = useState<RibbonTab>("home");
  const activeTabRef = useRef<RibbonTab>("home");
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // Dropdown menus
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [showRecentSub, setShowRecentSub] = useState(false);
  const [showExportSub, setShowExportSub] = useState(false);
  const appMenuRef = useRef<HTMLDivElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);

  // Unified picker portal state
  const [openPicker, setOpenPicker] = useState<PickerState | null>(null);
  const pickerPortalRef = useRef<HTMLDivElement>(null);

  // Ribbon body scroll arrows
  const ribbonBodyRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  function updateScrollArrows() {
    const el = ribbonBodyRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }

  function ribbonScroll(dir: -1 | 1) {
    const el = ribbonBodyRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * 120, behavior: "smooth" });
    setTimeout(updateScrollArrows, 200);
  }

  useEffect(() => {
    const el = ribbonBodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateScrollArrows);
    ro.observe(el);
    el.addEventListener("scroll", updateScrollArrows, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", updateScrollArrows); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Context-tab flash keys (incremented on each appearance → remount → CSS animation retriggers)
  const [selFlash, setSelFlash] = useState(0);
  const [clipFlash, setClipFlash] = useState(0);

  // Local state
  const [extrudeIgnoreAir, setExtrudeIgnoreAir] = useState(false);
  const [treeGenerating, setTreeGenerating] = useState(false);

  // Clipboard axo preview
  const [clipAxoPixels, setClipAxoPixels] = useState<{width:number;height:number;pixels:Uint8Array}|null>(null);
  const clipAxoCanvasRef = useRef<HTMLCanvasElement>(null);

  // Resize drag
  const resizeDragRef = useRef<{startY:number;startH:number}|null>(null);

  // Close menus + picker on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (appMenuRef.current && !appMenuRef.current.contains(e.target as Node)) setAppMenuOpen(false);
      if (fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node)) {
        setFileMenuOpen(false); setShowRecentSub(false); setShowExportSub(false);
      }
      if (openPicker && pickerPortalRef.current && !pickerPortalRef.current.contains(e.target as Node)) {
        setOpenPicker(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openPicker]);

  // Picker toggle helpers
  function togglePicker(e: React.MouseEvent, type: PickerState["type"]) {
    if (openPicker?.type === type) { setOpenPicker(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    setOpenPicker({ type, top: rect.bottom + 4, left: rect.left });
  }

  // Auto-tab: draw tool → Draw tab
  const prevToolRef2 = useRef<Tool | null>(null);
  useEffect(() => {
    const drawTools = ["pen","brush","rect","ellipse","smooth","noise","flatten","erode","fill"];
    const wasDrawTool = drawTools.includes(prevToolRef2.current ?? "");
    const isNowDraw = drawTools.includes(p.tool);
    if (isNowDraw && !wasDrawTool) setActiveTab("draw");
    prevToolRef2.current = p.tool;
  }, [p.tool]);

  // Auto-tab: selection appears → Selection tab; cleared → Home
  const prevRawBounds = useRef<SelectionBounds | null>(null);
  useEffect(() => {
    if (p.rawBounds && !prevRawBounds.current) {
      setSelFlash(n => n + 1);
      setActiveTab("selection");
    } else if (!p.rawBounds && prevRawBounds.current) {
      if (activeTabRef.current === "selection") setActiveTab("home");
    }
    prevRawBounds.current = p.rawBounds;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.rawBounds]);

  // Auto-tab: clipboard cleared → go home if we were on paste tab; flash on appear
  const prevClipboard = useRef<ClipboardInfo | null>(null);
  useEffect(() => {
    if (p.clipboard && !prevClipboard.current) {
      setClipFlash(n => n + 1);
    } else if (!p.clipboard && prevClipboard.current && activeTabRef.current === "paste") {
      setActiveTab("home");
    }
    prevClipboard.current = p.clipboard;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.clipboard]);

  // Sync extrudeOpen with selection tab (merged selection tab covers both selection + fill/replace)
  useEffect(() => {
    p.setExtrudeOpen(activeTab === "selection");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Fetch clipboard top-down preview
  const CLIP_PREV_W = 140;
  const CLIP_PREV_H = 140;
  useEffect(() => {
    if (!p.clipboard) { setClipAxoPixels(null); return; }
    invoke<{width:number;height:number;pixels:string}>("render_clipboard_preview")
      .then(raw => setClipAxoPixels({ width: raw.width, height: raw.height, pixels: decodeB64(raw.pixels) }))
      .catch(() => setClipAxoPixels(null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.clipboard]);

  // Draw clipboard top-down preview onto canvas
  useEffect(() => {
    const canvas = clipAxoCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#080f1e";
    ctx.fillRect(0, 0, CLIP_PREV_W, CLIP_PREV_H);
    if (clipAxoPixels && clipAxoPixels.width > 0 && clipAxoPixels.height > 0) {
      const off = document.createElement("canvas");
      off.width = clipAxoPixels.width;
      off.height = clipAxoPixels.height;
      const offCtx = off.getContext("2d")!;
      const img = offCtx.createImageData(clipAxoPixels.width, clipAxoPixels.height);
      img.data.set(clipAxoPixels.pixels);
      offCtx.putImageData(img, 0, 0);
      const scale = Math.min(CLIP_PREV_W / clipAxoPixels.width, CLIP_PREV_H / clipAxoPixels.height);
      const dw = Math.round(clipAxoPixels.width * scale);
      const dh = Math.round(clipAxoPixels.height * scale);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, Math.round((CLIP_PREV_W-dw)/2), Math.round((CLIP_PREV_H-dh)/2), dw, dh);
    }
  }, [clipAxoPixels]);

  // Resize drag handlers
  function onResizeDragStart(e: React.MouseEvent) {
    resizeDragRef.current = { startY: e.clientY, startH: p.ribbonBodyHeight };
    const onMove = (ev: MouseEvent) => {
      if (!resizeDragRef.current) return;
      const delta = ev.clientY - resizeDragRef.current.startY;
      p.onBodyHeightChange(resizeDragRef.current.startH + delta);
    };
    const onUp = () => {
      resizeDragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  }

  const swatchColor = resolveColor(p.fillBlockType, p.fillPaint);

  // ── tab style ──────────────────────────────────────────────────────────────

  const tabStyle = (id: RibbonTab, accent = "#3b82f6"): React.CSSProperties => {
    const isActive = activeTab === id;
    const textColor = accent === "#f59e0b" ? (isActive ? "#fcd34d" : "#c4963c")
      : accent === "#22c55e" ? (isActive ? "#86efac" : "#4ade80")
      : (isActive ? "#e2e8f0" : "#64748b");
    return {
      background: isActive ? "#0f2244" : "transparent",
      border: "none",
      borderBottom: isActive ? `2px solid #0f2244` : `2px solid transparent`,
      borderTop: isActive ? `2px solid ${accent}` : "2px solid transparent",
      color: textColor,
      cursor: "pointer", padding: "0 13px", height: "100%",
      fontSize: 12, fontWeight: isActive ? 600 : 400, whiteSpace: "nowrap",
      userSelect: "none", outline: "none",
      position: "relative", zIndex: isActive ? 2 : 1,
      marginBottom: isActive ? -2 : 0,
    };
  };

  const mi: React.CSSProperties = {
    display: "block", width: "100%", textAlign: "left", background: "none",
    border: "none", color: "#e2e8f0", padding: "5px 14px", fontSize: 12, cursor: "pointer",
  };
  const miHover = (e: React.MouseEvent<HTMLButtonElement>) => { (e.currentTarget.style.background = "#1e293b"); };
  const miLeave = (e: React.MouseEvent<HTMLButtonElement>) => { (e.currentTarget.style.background = ""); };
  const miShortcut: React.CSSProperties = { fontSize: 10, color: "#475569", marginLeft: "auto", paddingLeft: 12 };

  const dropStyle: React.CSSProperties = {
    position: "absolute", top: "calc(100% + 2px)", left: 0, zIndex: 500,
    background: "#0d1829", border: "1px solid #1e40af",
    borderRadius: 6, padding: "4px 0", minWidth: 180,
    boxShadow: "0 8px 24px rgba(0,0,0,0.7)",
  };

  // ── tab content renderers ──────────────────────────────────────────────────

  function renderHomeTab() {
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>

        <div style={{ ...rbGroup, minWidth: 130 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {p.renamingWorld ? (
              <input
                ref={p.renameInputRef}
                value={p.renameInput}
                onChange={e => p.setRenameInput(e.target.value.split("").filter(c => /[A-Za-z0-9' ]/.test(c)).join("").slice(0, 32))}
                onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") p.setRenamingWorld(false); }}
                onBlur={() => p.onRenameBlur(p.renameInput.trim())}
                style={{ background: "rgba(255,255,255,0.08)", border: "1px solid #3b82f6", borderRadius: 3, color: "#e2e8f0", fontSize: 12, fontWeight: 700, padding: "1px 5px", outline: "none", width: 120 }}
                autoFocus
              />
            ) : (
              <div onClick={() => { p.setRenameInput(p.world?.name ?? ""); p.setRenamingWorld(true); }}
                style={{ color: "#e2e8f0", fontWeight: 700, fontSize: 12, cursor: "text", borderBottom: "1px dashed rgba(255,255,255,0.15)", paddingBottom: 1, userSelect: "none", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title="Click to rename world">
                {p.world?.name ?? "—"}
              </div>
            )}
            <div style={{ color: "#475569", fontSize: 10 }}>{p.world ? `${p.world.width_chunks}×${p.world.height_chunks} chunks` : ""}</div>
            <div style={{ fontSize: 10, color: p.world?.max_z === 255 ? "#a78bfa" : "#475569" }}>
              {p.world?.max_z === 63 ? "Legacy 64z" : p.world?.max_z === 255 ? "New Dawn 256z" : ""}
            </div>
          </div>
          <div style={rbGroupLabel}>World</div>
        </div>
        <div style={rbDivider} />

        <div style={rbGroup}>
          <button onClick={() => p.setShowNewWorld(true)} style={rb}>✏ New World…</button>
          <button onClick={() => p.setShowWorldBrowser(true)} style={rb}>🌐 Browse Online…</button>
          <div style={rbGroupLabel}>Create</div>
        </div>
        <div style={rbDivider} />

        {p.tool === "wand" && (<>
          <div style={rbGroup}>
            <div style={{ color: "#a78bfa", fontSize: 11 }}>Click to flood-select</div>
            <button onClick={() => p.setWandMatchPaint(!p.wandMatchPaint)} style={p.wandMatchPaint ? rbActive("#a855f7") : rb}>
              {p.wandMatchPaint ? "Type + Colour" : "Type only"}
            </button>
            <div style={rbGroupLabel}>Wand</div>
          </div>
          <div style={rbDivider} />
        </>)}

        <div style={rbGroup}>
          <div style={{ color: "#64748b", fontSize: 10 }}>
            {p.spawnPos ? `(${Math.round(p.spawnPos.px)}, ${Math.round(p.spawnPos.py)})` : "unset"}
          </div>
          <button onClick={p.onSetSpawnAtSelection} disabled={!p.selection}
            style={{ ...rb, opacity: p.selection ? 1 : 0.35, cursor: p.selection ? "pointer" : "not-allowed" }}
            title={p.selection ? "Set spawn at selection centre" : "Make a selection first"}>
            ⌂ Set Spawn
          </button>
          <div style={rbGroupLabel}>Spawn</div>
        </div>
      </div>
    );
  }

  function renderDrawTab() {
    const drawTools = ["pen","brush","rect","ellipse"] as const;
    const sculptTools = ["smooth","noise","flatten","erode"] as const;
    const drawToolIcons: Record<string,string> = { pen:"✏", brush:"⬟", rect:"□", ellipse:"○" };
    const drawToolNames: Record<string,string> = { pen:"Pen", brush:"Brush", rect:"Rect", ellipse:"Ellipse" };
    const drawToolKeys: Record<string,string> = { pen:"P", brush:"B", rect:"R", ellipse:"E" };
    const sculptToolIcons: Record<string,string> = { smooth:"〰", noise:"⛰", flatten:"▬", erode:"~" };
    const sculptToolNames: Record<string,string> = { smooth:"Smooth", noise:"Noise", flatten:"Flatten", erode:"Erode" };
    const kbdBadge: React.CSSProperties = {
      fontSize: 8, fontFamily: "ui-monospace,'SF Mono',monospace", color: "#475569",
      background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: 2, padding: "0 2px", lineHeight: "12px", marginLeft: 3, flexShrink: 0,
    };
    const isActive = (b: {type:number;paint:number}) => b.type === p.fillBlockType && b.paint === p.fillPaint;
    const slotBase: React.CSSProperties = {
      width: 24, height: 24, borderRadius: 3, cursor: "pointer", flexShrink: 0,
      position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
    };
    const cornerBadge: React.CSSProperties = {
      position: "absolute", top: 0, right: 0, width: 10, height: 10,
      borderRadius: "0 3px 0 3px", background: "rgba(0,0,0,0.75)", display: "flex",
      alignItems: "center", justifyContent: "center", fontSize: 8, color: "#e2e8f0", zIndex: 1,
    };
    const letterOverlay = (bt: number) => {
      const l = blockDisplayName(bt)[0]?.toUpperCase() ?? "";
      return l ? <span style={{ position:"absolute",bottom:1,left:2,fontSize:7,fontWeight:700,color:"rgba(255,255,255,0.7)",textShadow:"0 0 2px rgba(0,0,0,0.9)",pointerEvents:"none",userSelect:"none" }}>{l}</span> : null;
    };
    function pinToSlot(b: {type:number;paint:number}) {
      p.setPinnedBlocks(prev => {
        const n = [...prev];
        const i = n.findIndex(s => s === null);
        if (i !== -1) { n[i] = b; return n; }
        n[4] = b; return n;
      });
    }
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <div style={{ ...rbGroup, minWidth: 180 }}>
          <div style={{ display: "flex", gap: 2, flexWrap: "wrap", maxWidth: 220 }}>
            <button onClick={() => { p.prevToolRef.current = p.tool === "eyedropper" ? "pen" : p.tool as Tool; p.setTool("eyedropper"); }}
              title="Eyedropper (I)" style={p.tool === "eyedropper" ? {...rbActive("#67e8f9"), borderColor:"#67e8f9", color:"#a5f3fc"} : rb}>💉</button>
            {drawTools.map(t => (
              <button key={t} onClick={() => p.setTool(t)} title={drawToolNames[t]}
                style={{ ...(p.tool === t ? rbActive("#f472b6") : rb), display: "flex", alignItems: "center" }}>
                {drawToolIcons[t]} {drawToolNames[t]}<span style={kbdBadge}>{drawToolKeys[t]}</span>
              </button>
            ))}
            <button onClick={() => p.setTool("fill")} title="Fill Bucket (F)"
              style={{ ...(p.tool === "fill" ? rbActive("#34d399") : rb), display: "flex", alignItems: "center" }}>
              🪣 Fill<span style={kbdBadge}>F</span>
            </button>
          </div>
          <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
            <span style={{ color: "#475569", fontSize: 10 }}>Sculpt</span>
            <span style={expBadge}>exp</span>
            {sculptTools.map(t => (
              <button key={t} onClick={() => p.setTool(t)} title={sculptToolNames[t]} style={p.tool === t ? rbActive("#fb923c") : rb}>
                {sculptToolIcons[t]}
              </button>
            ))}
          </div>
          <div style={rbGroupLabel}>Tool</div>
        </div>
        <div style={rbDivider} />

        {p.tool === "brush" && (<>
          <div style={rbGroup}>
            <div style={{ display: "flex", gap: 2 }}>
              {([1,3,5,7,9] as const).map(s => (
                <button key={s} onClick={() => p.setBrushSize(s)}
                  style={p.brushSize === s ? rbActive("#f472b6") : { ...rb, padding: "2px 6px" }}>{s}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              <button onClick={() => p.setBrushShape("sq")} style={p.brushShape === "sq" ? rbActive("#f472b6") : rb}>■ Sq</button>
              <button onClick={() => p.setBrushShape("circ")} style={p.brushShape === "circ" ? rbActive("#f472b6") : rb}>● Circ</button>
            </div>
            <div style={rbGroupLabel}>Brush</div>
          </div>
          <div style={rbDivider} />
        </>)}

        {!p.isSculptTool && p.tool !== "fill" && p.tool !== "eyedropper" && (<>
          <div style={rbGroup}>
            <div style={{ display: "flex", gap: 2 }}>
              <button onClick={() => p.setDrawFilled(true)} style={p.drawFilled ? rbActive("#f472b6") : rb}>Fill</button>
              <button onClick={() => p.setDrawFilled(false)} style={!p.drawFilled ? rbActive("#f472b6") : rb}>Hollow</button>
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              <button onClick={() => p.setDrawAbove(false)} style={!p.drawAbove ? rbActive("#f472b6") : rb}>Surface</button>
              <button onClick={() => p.setDrawAbove(true)} style={p.drawAbove ? rbActive("#fcd34d") : rb}>+1 Above</button>
            </div>
            <div style={rbGroupLabel}>Mode</div>
          </div>
          <div style={rbDivider} />
        </>)}

        {/* Block picker — uses portal to escape overflow clipping */}
        <div style={rbGroup}>
          <button onClick={(e) => togglePicker(e, "block-draw")}
            style={{ ...rb, display: "flex", gap: 5, alignItems: "center", padding: "3px 8px", background: openPicker?.type === "block-draw" ? "rgba(255,255,255,0.1)" : rb.background }}
            title="Click to change draw block">
            <div style={{ width: 16, height: 16, borderRadius: 2, flexShrink: 0, border: "1px solid rgba(255,255,255,0.2)", background: `rgb(${swatchColor[0]},${swatchColor[1]},${swatchColor[2]})` }} />
            <span style={{ fontSize: 11, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {blockDisplayName(p.fillBlockType)}{p.fillPaint > 0 ? ` #${p.fillPaint}` : ""}
            </span>
            <span style={{ color: "#475569", fontSize: 9 }}>▾</span>
          </button>
          <div style={rbGroupLabel}>Block</div>
        </div>
        <div style={rbDivider} />

        {/* Hotbar — gallery style */}
        <div style={rbGroup}>
          <div style={{
            display: "flex", alignItems: "center", gap: 3,
            background: "rgba(255,255,255,0.03)", border: "1px solid #1e293b",
            borderRadius: 4, padding: "3px 4px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}>
            <span style={{ color: "#334155", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em", userSelect: "none" }}>PINNED</span>
            {p.pinnedBlocks.map((b, i) => {
              const key = `pinned-${i}`;
              const hovered = p.hotbarHover === key;
              const active = b ? isActive(b) : false;
              const [r, g, bl] = b ? resolveColor(b.type, b.paint) : [30, 40, 60];
              const swUrl = b && p.texturePack ? tintedSwatch(b.type, b.paint, p.texturePack) : null;
              return (
                <div key={i} style={{ ...slotBase, width: 26, height: 26, background: b ? `rgb(${r},${g},${bl})` : "rgba(255,255,255,0.03)", backgroundImage: swUrl ? `url(${swUrl})` : undefined, backgroundSize: "cover", border: active ? "2px solid #fff" : b ? "1px solid rgba(255,255,255,0.18)" : "1px dashed #334155", outline: active ? "1px solid #a78bfa" : "none", outlineOffset: 1 }}
                  title={b ? `${blockDisplayName(b.type)}${b.paint > 0 ? ` p${b.paint}` : ""} · key ${i+1}` : `Empty pin slot ${i+1}`}
                  onClick={() => b && (p.setFillBlockType(b.type), p.setFillPaint(b.paint))}
                  onMouseEnter={() => p.setHotbarHover(key)} onMouseLeave={() => p.setHotbarHover(null)}>
                  <span style={{ position:"absolute",top:0,left:2,fontSize:6,color:"rgba(255,255,255,0.35)",lineHeight:1,pointerEvents:"none",userSelect:"none" }}>{i+1}</span>
                  {b && letterOverlay(b.type)}
                  {hovered && b && <div style={cornerBadge} onClick={e => { e.stopPropagation(); p.setPinnedBlocks(prev => { const n=[...prev]; n[i]=null; return n; }); p.setHotbarHover(null); }} title="Unpin">×</div>}
                </div>
              );
            })}
            <div style={{ width: 1, background: "#1e293b", alignSelf: "stretch", margin: "0 2px" }} />
            <span style={{ color: "#334155", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em", userSelect: "none" }}>RECENT</span>
            {p.recentBlocks.length === 0
              ? <span style={{ color: "#1e293b", fontSize: 10, fontStyle: "italic" }}>none</span>
              : p.recentBlocks.map((b, i) => {
                const key = `recent-${i}`;
                const hovered = p.hotbarHover === key;
                const active = isActive(b);
                const [r, g, bl] = resolveColor(b.type, b.paint);
                const alreadyPinned = p.pinnedBlocks.some(pb => pb && pb.type === b.type && pb.paint === b.paint);
                const swUrl2 = p.texturePack ? tintedSwatch(b.type, b.paint, p.texturePack) : null;
                return (
                  <div key={i} style={{ ...slotBase, width: 26, height: 26, background: `rgb(${r},${g},${bl})`, backgroundImage: swUrl2 ? `url(${swUrl2})` : undefined, backgroundSize: "cover", border: active ? "2px solid #fff" : "1px solid rgba(255,255,255,0.18)", outline: active ? "1px solid #f472b6" : "none", outlineOffset: 1, opacity: alreadyPinned ? 0.5 : 1 }}
                    title={`${blockDisplayName(b.type)}${b.paint > 0 ? ` p${b.paint}` : ""} · key ${i+6}`}
                    onClick={() => { p.setFillBlockType(b.type); p.setFillPaint(b.paint); }}
                    onMouseEnter={() => p.setHotbarHover(key)} onMouseLeave={() => p.setHotbarHover(null)}>
                    <span style={{ position:"absolute",top:0,left:2,fontSize:6,color:"rgba(255,255,255,0.35)",lineHeight:1,pointerEvents:"none",userSelect:"none" }}>{i+6}</span>
                    {letterOverlay(b.type)}
                    {hovered && !alreadyPinned && <div style={cornerBadge} onClick={e => { e.stopPropagation(); pinToSlot(b); p.setHotbarHover(null); }} title="Pin">↑</div>}
                  </div>
                );
              })
            }
          </div>
          <div style={rbGroupLabel}>Hotbar</div>
        </div>
        <div style={rbDivider} />

        <div style={rbGroup}>
          <button onClick={() => p.setMaskEnabled(!p.maskEnabled)} style={p.maskEnabled ? rbActive("#a78bfa") : rb}>
            {p.maskEnabled ? "Mask ✓" : "Mask"}
          </button>
          {p.maskEnabled && (
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#64748b", fontSize: 10 }}>Type</span>
              <select value={p.maskBlockType ?? ""} onChange={e => p.setMaskBlockType(e.target.value === "" ? null : Number(e.target.value))}
                style={{ background: "#1e293b", border: "1px solid #475569", color: "#e2e8f0", borderRadius: 3, fontSize: 10, padding: "1px 2px" }}>
                <option value="">any</option>
                {BLOCK_DEFS.map(b => <option key={b.type} value={b.type}>{b.name}</option>)}
              </select>
              <span style={{ color: "#64748b", fontSize: 10 }}>Paint</span>
              <select value={p.maskPaint ?? ""} onChange={e => p.setMaskPaint(e.target.value === "" ? null : Number(e.target.value))}
                style={{ background: "#1e293b", border: "1px solid #475569", color: "#e2e8f0", borderRadius: 3, fontSize: 10, padding: "1px 2px" }}>
                <option value="">any</option>
                <option value="0">none</option>
                {Array.from({length:54},(_,i)=>i+1).map(p2 => <option key={p2} value={p2}>#{p2}</option>)}
              </select>
            </div>
          )}
          <div style={rbGroupLabel}>Mask</div>
        </div>
      </div>
    );
  }

  function renderInsertTab() {
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <div style={rbGroup}>
          <button onClick={p.loadPrefab} style={rb}>📦 Load Prefab (.epfab)…</button>
          <div style={rbGroupLabel}>Prefab</div>
        </div>
        <div style={rbDivider} />
        <div style={rbGroup}>
          <button onClick={p.importSchematic} style={{ ...rb, display: "flex", alignItems: "center", gap: 4 }}>
            Import Schematic… <span style={expBadge}>exp</span>
          </button>
          <div style={rbGroupLabel}>Import</div>
        </div>
        <div style={rbDivider} />

        {/* Trees — compact 2-row layout */}
        <div style={{ ...rbGroup, minWidth: 340 }}>
          {/* Row 1: type buttons */}
          <div style={{ display: "flex", gap: 2 }}>
            {([
              ["normal",    "Normal",  "Deciduous: trunk + dome canopy"],
              ["terrain",   "Terrain", "Tall terrain tree: ragged wide canopy"],
              ["pine",      "Pine",    "Conical pine: narrow 5×5 canopy"],
              ["tall_pine", "T. Pine", "Tall conical pine: wide 7×7 canopy"],
            ] as [string, string, string][]).map(([t, label, tip]) => (
              <button key={t} title={tip}
                onClick={() => p.setTreeTypes(
                  p.treeTypes.includes(t)
                    ? p.treeTypes.length > 1 ? p.treeTypes.filter(x => x !== t) : p.treeTypes
                    : [...p.treeTypes, t]
                )}
                style={p.treeTypes.includes(t) ? rbActive("#4ade80") : rbDim}>
                {label}
              </button>
            ))}
          </div>
          {/* Row 2: leaf colors + density + smart + plant */}
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {/* Color swatches single row */}
            <div style={{ display: "flex", gap: 2 }}>
              {LEAF_COLORS.map(([paint, hex, name]) => {
                const on = p.leafPaints.includes(paint);
                return (
                  <div key={paint} title={name}
                    onClick={() => p.setLeafPaints(
                      p.leafPaints.includes(paint)
                        ? p.leafPaints.length > 1 ? p.leafPaints.filter(pp => pp !== paint) : p.leafPaints
                        : [...p.leafPaints, paint]
                    )}
                    style={{
                      width: 13, height: 13, borderRadius: 2, background: hex, cursor: "pointer",
                      border: `2px solid ${on ? "#ffffff" : "transparent"}`,
                      outline: on ? "1px solid #4ade80" : "1px solid #334155",
                      boxSizing: "border-box",
                    }} />
                );
              })}
            </div>
            {/* Density */}
            <span style={{ color: "#64748b", fontSize: 10 }}>D:</span>
            <input type="range" min={1} max={100} value={p.treeDensity}
              onChange={e => p.setTreeDensity(parseInt(e.target.value))}
              style={{ width: 50, accentColor: "#4ade80" }} />
            <span style={{ color: "#86efac", fontSize: 10, fontVariantNumeric: "tabular-nums", minWidth: 24 }}>{p.treeDensity}%</span>
            {/* Smart placement */}
            <label style={{ display: "flex", alignItems: "center", gap: 2, cursor: "pointer" }}>
              <input type="checkbox" checked={p.smartPlacement} onChange={e => p.setSmartPlacement(e.target.checked)} style={{ accentColor: "#4ade80" }} />
              <span style={{ color: "#64748b", fontSize: 10, whiteSpace: "nowrap" }}>Grass only</span>
            </label>
            {/* Plant button */}
            <button
              disabled={treeGenerating || !p.selection}
              onClick={async () => {
                setTreeGenerating(true);
                try { await p.onGenerateTrees(p.treeTypes, Math.pow(p.treeDensity / 100, 2) * 0.20, p.leafPaints, p.smartPlacement); }
                finally { setTreeGenerating(false); }
              }}
              style={{
                ...rb,
                opacity: p.selection ? 1 : 0.4,
                cursor: p.selection ? "pointer" : "not-allowed",
                ...(p.selection ? { borderColor: "#4ade80", color: "#86efac" } : {}),
              }}
              title={p.selection ? `Plant trees at ${p.treeDensity}% density` : "Make a selection first"}>
              {treeGenerating ? "Generating…" : "🌲 Plant Trees"}
            </button>
          </div>
          <div style={rbGroupLabel}>
            Trees {!p.selection && <span style={{ color: "#f59e0b", opacity: 0.7 }}>(no selection)</span>}
          </div>
        </div>
      </div>
    );
  }

  function renderViewTab() {
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => p.setViewMode("topdown")} style={p.viewMode === "topdown" ? rbActive() : rb}>⊞ Top-down</button>
            <button onClick={() => p.setViewMode("zslice")} style={p.viewMode === "zslice" ? rbActive() : rb}>Z-Slice</button>
          </div>
          <button onClick={p.onFitMap} style={rb}>⊡ Fit Map</button>
          <div style={rbGroupLabel}>Map View</div>
        </div>
        {p.viewMode === "zslice" && (<>
          <div style={rbDivider} />
          <div style={rbGroup}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="range" min={0} max={p.world?.max_z ?? 63} value={p.zSliceDisplay}
                onChange={e => p.setZSliceDisplay(Number(e.target.value))}
                onPointerUp={e => p.commitZSlice(Number((e.target as HTMLInputElement).value))}
                onKeyUp={e => p.commitZSlice(Number((e.target as HTMLInputElement).value))}
                style={{ width: 120, accentColor: "#3b82f6", cursor: "pointer" }} />
              <span style={{ color: "#7dd3fc", fontVariantNumeric: "tabular-nums", fontSize: 12, minWidth: 22 }}>{p.zSliceDisplay}</span>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="checkbox" checked={p.followSurface} onChange={e => p.setFollowSurface(e.target.checked)} style={{ accentColor: "#3b82f6" }} />
              <span style={{ color: "#64748b", fontSize: 10 }}>Follow surface</span>
            </label>
            <div style={rbGroupLabel}>Z-Slice Level</div>
          </div>
        </>)}
        <div style={rbDivider} />
        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 2 }}>
            {(["tiled","full","axo"] as const).map(m => (
              <button key={m} onClick={() => p.setRenderMode(m)}
                style={p.renderMode === m ? rbActive(m === "tiled" ? "#3b82f6" : m === "full" ? "#d97706" : "#10b981") : rb}>
                {m === "tiled" ? "⊞ Tiled" : m === "full" ? "Full" : "Axo"}
              </button>
            ))}
          </div>
          {p.renderMode === "axo" && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#94a3b8", fontSize: 10 }}>Depth</span>
              <input type="range" min={0} max={0.5} step={0.02} value={p.axoSkew}
                onChange={e => p.setAxoSkew(parseFloat(e.target.value))}
                style={{ width: 80, accentColor: "#10b981" }} />
              <span style={{ color: "#94a3b8", fontSize: 10, minWidth: 26, textAlign: "right" }}>{p.axoSkew.toFixed(2)}</span>
            </div>
          )}
          <div style={rbGroupLabel}>Render</div>
        </div>
        <div style={rbDivider} />
        <div style={rbGroup}>
          <button onClick={() => p.setShowSlicePanels(!p.showSlicePanels)}
            style={{ ...rb, display: "flex", gap: 4, alignItems: "center", ...(p.showSlicePanels ? { background: "rgba(168,85,247,0.18)", borderColor: "#a855f7", color: "#d8b4fe" } : {}) }}>
            ◫ Quad View <span style={expBadge}>exp</span>
          </button>
          {p.showSlicePanels && (
            <button onClick={() => p.setEnable3dPane(!p.enable3dPane)}
              style={{ ...rb, display: "flex", gap: 4, alignItems: "center", ...(p.enable3dPane ? { background: "rgba(245,158,11,0.18)", borderColor: "#f59e0b", color: "#fcd34d" } : {}) }}>
              3D Pane <span style={expBadge}>exp</span>
            </button>
          )}
          <div style={rbGroupLabel}>Layout</div>
        </div>
        {(p.templateLoaded || true) && (<>
          <div style={rbDivider} />
          <div style={rbGroup}>
            <button onClick={p.openTemplateFile} style={{ ...rb, display: "flex", gap: 4, alignItems: "center" }}>
              {p.templateLoaded ? "Change Template…" : "Load Eden Template…"} <span style={expBadge}>exp</span>
              {p.templateLoaded && <span style={{ color: "#4ade80", fontSize: 10 }}>✓</span>}
            </button>
            {p.templateLoaded && (
              <button onClick={() => p.setShowTemplateOverlay(!p.showTemplateOverlay)}
                style={p.showTemplateOverlay ? rbActive("#4ade80") : rb}>
                {p.showTemplateOverlay ? "Overlay ✓" : "Show Overlay"}
              </button>
            )}
            <div style={rbGroupLabel}>Template</div>
          </div>
        </>)}
        <div style={rbDivider} />
        <div style={rbGroup}>
          <button onClick={p.openTexturePackFile} style={{ ...rb, display: "flex", gap: 4, alignItems: "center" }}>
            {p.texturePackLoaded ? "Change Pack…" : "Load Texture Pack…"}
            <span style={expBadge}>exp</span>
            {p.texturePackLoaded && <span style={{ color: "#4ade80", fontSize: 10 }}>✓</span>}
          </button>
          {p.texturePackLoaded && (
            <button onClick={p.unloadTexturePack} style={rb}>Unload Pack</button>
          )}
          <div style={rbGroupLabel}>Textures</div>
        </div>
      </div>
    );
  }

  function renderSelectionTab() {
    const sel = p.selection;
    const maxZ = p.world?.max_z ?? 63;
    const zLo = Math.min(p.zMin, p.zMax);
    const zHi = Math.max(p.zMin, p.zMax);
    const lo = (zLo / maxZ) * 100;
    const hi = (zHi / maxZ) * 100;
    const trackGrad = `linear-gradient(to right, #334155 0%, #334155 ${lo}%, #3b82f6 ${lo}%, #3b82f6 ${hi}%, #334155 ${hi}%, #334155 100%)`;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        {sel && (<>
          <div style={rbGroup}>
            <div style={{ display: "flex", gap: 4, fontVariantNumeric: "tabular-nums" }}>
              {[["W", sel.width], ["H", sel.height], ["D", sel.depth]].map(([l, v]) => (
                <div key={l as string} style={{ textAlign: "center", background: "rgba(255,255,255,0.04)", borderRadius: 3, padding: "2px 6px", minWidth: 30 }}>
                  <div style={{ color: "#64748b", fontSize: 8 }}>{l}</div>
                  <div style={{ color: l === "D" ? "#7dd3fc" : "#e2e8f0", fontSize: 12, fontWeight: 700 }}>{v}</div>
                </div>
              ))}
            </div>
            <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 10, color: "#475569", lineHeight: 1.3 }}>
              <div>X {sel.x1}–{sel.x2}  Y {sel.y1}–{sel.y2}</div>
              <div style={{ color: "#334155" }}>{sel.width * sel.height * sel.depth} blocks</div>
            </div>
            <div style={rbGroupLabel}>Info</div>
          </div>
          <div style={rbDivider} />
        </>)}

        {/* Z Range — dual-thumb slider */}
        <div style={rbGroup}>
          {/* Visual track */}
          <div style={{ position: "relative", width: 120, height: 16, flexShrink: 0 }}>
            <div style={{
              position: "absolute", top: 6, left: 4, right: 4, height: 4,
              borderRadius: 2, background: trackGrad, pointerEvents: "none",
            }} />
            <input type="range" className="zr-thumb" min={0} max={maxZ} value={p.zMin}
              onChange={e => p.handleZMin(e.target.value)}
              style={{ position: "absolute", width: "100%", height: "100%", margin: 0, opacity: 0.001, cursor: "pointer" }} />
            <input type="range" className="zr-thumb" min={0} max={maxZ} value={p.zMax}
              onChange={e => p.handleZMax(e.target.value)}
              style={{ position: "absolute", width: "100%", height: "100%", margin: 0, opacity: 0.001, cursor: "pointer" }} />
            {/* Thumb indicators */}
            <div style={{
              position: "absolute", top: 2, left: `calc(${lo}% - 5px)`, width: 10, height: 10,
              borderRadius: "50%", background: "#60a5fa", border: "1px solid #93c5fd", pointerEvents: "none",
            }} />
            <div style={{
              position: "absolute", top: 2, left: `calc(${hi}% - 5px)`, width: 10, height: 10,
              borderRadius: "50%", background: "#2563eb", border: "1px solid #60a5fa", pointerEvents: "none",
            }} />
          </div>
          {/* Max on top, Min below */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#60a5fa", fontSize: 10, minWidth: 22 }}>Max</span>
              <input type="number" min={0} max={maxZ} value={p.zMax}
                onChange={e => p.handleZMax(e.target.value)} style={zInp} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#94a3b8", fontSize: 10, minWidth: 22 }}>Min</span>
              <input type="number" min={0} max={maxZ} value={p.zMin}
                onChange={e => p.handleZMin(e.target.value)} style={zInp} />
            </div>
          </div>
          <div style={rbGroupLabel}>Z Range · {zHi - zLo + 1} levels</div>
        </div>
        <div style={rbDivider} />

        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={p.copySelection} style={{ ...rb, borderColor: "#7dd3fc", color: "#bfdbfe" }}>Copy</button>
            <button onClick={p.deleteBlocks} style={{ ...rb, borderColor: "#ef4444", color: "#fca5a5" }} title="Fill selection with air">Delete</button>
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => p.setRawBounds(b => b ? {x1:b.x1-1,y1:b.y1-1,x2:b.x2+1,y2:b.y2+1} : null)} style={rb} title="Grow by 1">Grow</button>
            <button onClick={() => p.setRawBounds(b => b ? {x1:Math.min(b.x1+1,b.x2),y1:Math.min(b.y1+1,b.y2),x2:Math.max(b.x2-1,b.x1),y2:Math.max(b.y2-1,b.y1)} : null)} style={rb} title="Shrink by 1">Shrink</button>
            <button onClick={() => p.setRawBounds(null)} style={rb}>Clear</button>
          </div>
          <div style={rbGroupLabel}>Edit</div>
        </div>
        <div style={rbDivider} />

        {/* Fill */}
        <div style={rbGroup}>
          <button onClick={(e) => togglePicker(e, "block-fill")}
            style={{ ...rb, display: "flex", gap: 5, alignItems: "center", background: openPicker?.type === "block-fill" ? "rgba(255,255,255,0.1)" : rb.background }}>
            <div style={{ width: 14, height: 14, borderRadius: 2, border: "1px solid rgba(255,255,255,0.2)", background: `rgb(${swatchColor[0]},${swatchColor[1]},${swatchColor[2]})`, flexShrink: 0 }} />
            <span style={{ maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
              {blockDisplayName(p.fillBlockType)}{p.fillPaint > 0 ? ` #${p.fillPaint}` : ""}
            </span>
            <span style={{ color:"#475569",fontSize:9 }}>▾</span>
          </button>
          <button onClick={p.fillSelection} disabled={!p.rawBounds}
            style={{ ...rb, opacity: p.rawBounds ? 1 : 0.35, cursor: p.rawBounds ? "pointer" : "not-allowed", borderColor: "#f59e0b", color: "#fcd34d" }}>
            Fill Selection
          </button>
          <div style={rbGroupLabel}>Fill</div>
        </div>
        <div style={rbDivider} />

        {/* Replace filter */}
        <div style={rbGroup}>
          <button onClick={(e) => togglePicker(e, "filter")}
            style={{ ...rb, display: "flex", gap: 5, alignItems: "center", background: openPicker?.type === "filter" ? "rgba(255,255,255,0.1)" : rb.background }}>
            <span style={{ fontSize: 11 }}>
              {p.filterBlockType === null ? "any block" : blockDisplayName(p.filterBlockType)}
              {p.filterPaint !== null ? ` #${p.filterPaint}` : ""}
              {p.filterInvert ? " (inv)" : ""}
            </span>
            <span style={{ color:"#475569",fontSize:9 }}>▾</span>
          </button>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => p.setFilterInvert(!p.filterInvert)} style={p.filterInvert ? rbActive("#a78bfa") : rb}>Invert</button>
            <button onClick={() => { p.setFilterBlockType(null); p.setFilterPaint(null); p.setFilterInvert(false); }} style={rb}>Clear</button>
          </div>
          <button onClick={p.deleteBlocks} disabled={!p.rawBounds}
            style={{ ...rb, opacity: p.rawBounds ? 1 : 0.35, cursor: p.rawBounds ? "pointer" : "not-allowed", borderColor: "#ef4444", color: "#fca5a5" }}>
            {p.filterBlockType !== null ? (p.filterInvert ? "Delete except filter" : "Delete filtered") : "Delete all"}
          </button>
          <div style={rbGroupLabel}>Replace</div>
        </div>
        <div style={rbDivider} />

        {/* Extrude */}
        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 2 }}>
            {([
              ["z+", "↑Z+"], ["z-", "↓Z−"],
              ["x+", "→X+"], ["x-", "←X−"],
              ["y+", "↓Y+"], ["y-", "↑Y−"],
            ] as [ExtrudeAxis, string][]).map(([ax, label]) => (
              <button key={ax} onClick={() => p.setExtrudeAxis(ax)}
                style={p.extrudeAxis === ax ? rbActive() : { ...rbDim, padding: "2px 5px", fontSize: 10 }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ color: "#475569", fontSize: 10 }}>×</span>
            <input type="number" min={0} max={20} value={p.extrudeCount} title="0 = preview off"
              onChange={e => p.setExtrudeCount(Math.max(0, Math.min(20, parseInt(e.target.value, 10) || 0)))}
              style={{ ...zInp, width: 36 }} />
            <label style={{ display: "flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
              <input type="checkbox" checked={extrudeIgnoreAir} onChange={e => setExtrudeIgnoreAir(e.target.checked)} style={{ accentColor: "#3b82f6" }} />
              <span style={{ color: "#64748b", fontSize: 10 }}>skip air</span>
            </label>
            <button onClick={() => p.onExtrude(extrudeIgnoreAir)} disabled={!sel || p.extrudeCount === 0}
              style={{ ...rb, opacity: (sel && p.extrudeCount > 0) ? 1 : 0.35, borderColor: "#3b82f6", color: "#93c5fd", fontWeight: 600 }}>
              Extrude {p.extrudeAxis}
            </button>
          </div>
          <div style={rbGroupLabel}>Extrude</div>
        </div>
      </div>
    );
  }

  function renderClipboardTab() {
    const cb = p.clipboard;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>

        {/* Top-down preview canvas */}
        <div style={rbGroup}>
          <canvas ref={clipAxoCanvasRef} width={140} height={140}
            style={{ display: "block", width: 140, height: 140, borderRadius: 3, border: "1px solid #1a2744", background: "#080f1e", imageRendering: "pixelated" }} />
          <div style={rbGroupLabel}>Top-Down Preview</div>
        </div>
        <div style={rbDivider} />

        {/* Clipboard info */}
        <div style={rbGroup}>
          {cb && (<>
            <div style={{ color: "#86efac", fontVariantNumeric: "tabular-nums", fontSize: 11, fontWeight: 700 }}>
              {cb.width}×{cb.height}×{cb.depth}
            </div>
            <div style={{ color: "#4ade80", fontSize: 10 }}>z{cb.z_anchor}–{cb.z_anchor + cb.depth - 1}</div>
          </>)}
          {p.lockedPastePos ? (
            <div style={{ color: "#fbbf24", fontWeight: 700, fontSize: 11 }}>LOCKED X{p.lockedPastePos.x}, Y{p.lockedPastePos.y}</div>
          ) : (
            <div style={{ color: "#4ade80", fontSize: 11 }}>Click map to place</div>
          )}
          <button onClick={p.onSavePrefab} style={{ ...rb, borderColor: "#4ade80", color: "#86efac", fontSize: 10 }}>Save Prefab…</button>
          <div style={rbGroupLabel}>Clipboard</div>
        </div>
        <div style={rbDivider} />

        {/* Paste actions */}
        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 2 }}>
            {p.lockedPastePos && (
              <button onClick={() => { const pos = p.lockedPastePos!; p.pasteAt(pos); p.setLockedPastePos(null); }}
                style={{ ...rb, borderColor: "#22c55e", color: "#86efac" }}>Confirm</button>
            )}
            {p.lockedPastePos && <button onClick={() => p.setLockedPastePos(null)} style={rb}>Unlock</button>}
            <button onClick={() => p.setTool("pan")} style={rb}>Cancel</button>
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => p.setPasteIgnoreAir(!p.pasteIgnoreAir)} style={p.pasteIgnoreAir ? rbActive("#34d399") : rb} title="Skip air blocks">No Air</button>
            <button onClick={() => p.setPersistPaste(!p.persistPaste)} style={p.persistPaste ? rbActive("#34d399") : rb} title="Repeat on each click">Repeat</button>
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => p.setPasteTerrain(!p.pasteTerrain)} style={p.pasteTerrain ? rbActive("#f59e0b") : rb}>Terrain</button>
            {p.pasteTerrain && <button onClick={() => p.setPasteTerrainAbove(!p.pasteTerrainAbove)} style={p.pasteTerrainAbove ? rbActive("#fb923c") : rb}>{p.pasteTerrainAbove ? "Above" : "At surf"}</button>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ color: "#64748b", fontSize: 10 }}>Z offset</span>
            <input type="number" value={p.pasteElevationOffset} onChange={e => p.setPasteElevationOffset(Number(e.target.value))} style={{ ...zInp, width: 44 }} />
          </div>
          <div style={rbGroupLabel}>Place</div>
        </div>
        <div style={rbDivider} />

        {/* Transform */}
        <div style={rbGroup}>
          <button onClick={p.rotateClipboard} style={{ ...rb, borderColor: "#a78bfa", color: "#ddd6fe" }}>↻ Rotate 90°</button>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={p.mirrorClipboardX} style={{ ...rb, borderColor: "#a78bfa", color: "#ddd6fe" }}>↔ Flip X</button>
            <button onClick={p.mirrorClipboardY} style={{ ...rb, borderColor: "#a78bfa", color: "#ddd6fe" }}>↕ Flip Y</button>
          </div>
          <div style={rbGroupLabel}>Transform</div>
        </div>
        <div style={rbDivider} />

        {/* Paste mode */}
        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 2 }}>
            {(["normal","scatter","array"] as const).map(m => (
              <button key={m} onClick={() => p.setPasteMode(m)} style={p.pasteMode === m ? rbActive("#7dd3fc") : rb}>
                {m === "normal" ? "1×" : m === "scatter" ? "Scatter" : "Array"}
              </button>
            ))}
          </div>
          {p.pasteMode === "scatter" && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#64748b", fontSize: 10 }}>Count</span>
              <input type="number" min={1} max={100} value={p.scatterCount}
                onChange={e => p.setScatterCount(Math.max(1, parseInt(e.target.value,10)||1))}
                style={{ ...zInp, width: 44 }} />
            </div>
          )}
          {p.pasteMode === "array" && (
            <div style={{ display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap", maxWidth: 200 }}>
              <span style={{ color:"#64748b",fontSize:10 }}>Cols</span>
              <input type="number" min={1} max={20} value={p.arrayCols} onChange={e => p.setArrayCols(Math.max(1,parseInt(e.target.value,10)||1))} style={{ ...zInp, width: 38 }} />
              <span style={{ color:"#64748b",fontSize:10 }}>Rows</span>
              <input type="number" min={1} max={20} value={p.arrayRows} onChange={e => p.setArrayRows(Math.max(1,parseInt(e.target.value,10)||1))} style={{ ...zInp, width: 38 }} />
              <span style={{ color:"#64748b",fontSize:10 }}>SpX</span>
              <input type="number" min={0} value={p.arraySpacingX} onChange={e => p.setArraySpacingX(Math.max(0,parseInt(e.target.value,10)||0))} style={{ ...zInp, width: 38 }} />
              <span style={{ color:"#64748b",fontSize:10 }}>SpY</span>
              <input type="number" min={0} value={p.arraySpacingY} onChange={e => p.setArraySpacingY(Math.max(0,parseInt(e.target.value,10)||0))} style={{ ...zInp, width: 38 }} />
            </div>
          )}
          <div style={rbGroupLabel}>Mode</div>
        </div>
      </div>
    );
  }

  // ── main render ────────────────────────────────────────────────────────────

  const bodyHeight = p.ribbonBodyHeight;

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
      background: "#060c18", borderBottom: "1px solid #1a2540",
      boxShadow: "0 2px 12px rgba(0,0,0,0.6)",
      userSelect: "none",
    }}>
      <style>{`
        @keyframes ctxPulse {
          0%   { box-shadow: 0 0 0 0 rgba(245,158,11,0.6); }
          60%  { box-shadow: 0 0 0 6px rgba(245,158,11,0); }
          100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
        }
        .zr-thumb { -webkit-appearance: none; appearance: none; background: transparent; pointer-events: none; }
        .zr-thumb::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; pointer-events: all; width: 10px; height: 10px; border-radius: 50%; background: transparent; cursor: pointer; margin-top: -3px; }
        .zr-thumb::-webkit-slider-runnable-track { height: 4px; }
      `}</style>
      {/* Tab row */}
      <div style={{ height: TAB_BAR_HEIGHT, display: "flex", alignItems: "stretch" }}>

        {/* App button — subtle violet tint (distinct from File amber) */}
        <div ref={appMenuRef} style={{ position: "relative", flexShrink: 0 }}>
          <button
            onClick={() => { setAppMenuOpen(v => !v); setFileMenuOpen(false); }}
            style={{
              height: TAB_BAR_HEIGHT, border: "none", cursor: "pointer", padding: "0 10px 0 8px",
              background: appMenuOpen ? "rgba(139,92,246,0.28)" : "rgba(139,92,246,0.13)",
              display: "flex", alignItems: "center", gap: 6,
              borderRight: "1px solid rgba(139,92,246,0.22)",
              borderBottom: `2px solid ${appMenuOpen ? "#8b5cf6" : "rgba(139,92,246,0.3)"}`,
              outline: "none",
            }}
            title="Application menu">
            <img src={appIcon} alt="" style={{ width: 20, height: 20, borderRadius: 3, imageRendering: "pixelated", flexShrink: 0 }} />
            <span style={{ fontSize: 13, lineHeight: 1, letterSpacing: -0.3, whiteSpace: "nowrap" }}>
              <span style={{ fontWeight: 800, color: "#ffffff" }}>Vuenc</span>
              <span style={{ fontWeight: 400, color: appMenuOpen ? "#c4b5fd" : "#a78bfa" }}>Edit</span>
            </span>
          </button>
          {appMenuOpen && (
            <div style={{ ...dropStyle, left: 0, minWidth: 170 }}>
              <button style={mi} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setAppMenuOpen(false); p.setShowSettings(true); }}>⚙ Settings…</button>
              <button style={mi} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setAppMenuOpen(false); p.setShowHelp(true); }}>? Help <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 4px", marginLeft: 4, verticalAlign: "middle", lineHeight: "14px" }}>WIP</span></button>
              <button style={mi} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setAppMenuOpen(false); p.setShowAbout(true); }}>ℹ About VuencEdit</button>
              <div style={{ height: 1, background: "#1e293b", margin: "3px 0" }} />
              <button style={{ ...mi, color: "#f87171" }} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setAppMenuOpen(false); p.closeWorld(); }}>✕ Close World</button>
            </div>
          )}
        </div>

        {/* File ▾ — amber tinted */}
        <div ref={fileMenuRef} style={{ position: "relative", flexShrink: 0 }}>
          <button
            onClick={() => { setFileMenuOpen(v => !v); setAppMenuOpen(false); setShowRecentSub(false); setShowExportSub(false); }}
            style={{
              height: TAB_BAR_HEIGHT, border: "none", cursor: "pointer", padding: "0 12px", outline: "none",
              background: fileMenuOpen ? "rgba(245,158,11,0.18)" : "rgba(245,158,11,0.07)",
              color: fileMenuOpen ? "#fcd34d" : "#c4963c",
              fontSize: 12, fontWeight: 600,
              borderBottom: `2px solid ${fileMenuOpen ? "#f59e0b" : "rgba(245,158,11,0.35)"}`,
              borderRight: "1px solid rgba(245,158,11,0.15)",
            }}>
            File {fileMenuOpen ? "▴" : "▾"}
          </button>
          {fileMenuOpen && (
            <div style={{ ...dropStyle, minWidth: 220 }}>
              <button style={{ ...mi, display: "flex", justifyContent: "space-between" }} onMouseEnter={miHover} onMouseLeave={miLeave}
                onClick={() => { setFileMenuOpen(false); p.setShowNewWorld(true); }}>
                New World… <span style={miShortcut}>⌘N</span>
              </button>
              <button style={{ ...mi, display: "flex", justifyContent: "space-between" }} onMouseEnter={miHover} onMouseLeave={miLeave}
                onClick={() => { setFileMenuOpen(false); p.openFile(); }}>
                Open… <span style={miShortcut}>⌘O</span>
              </button>
              <button style={{ ...mi, display: "flex", justifyContent: "space-between" }} onMouseEnter={miHover} onMouseLeave={miLeave}
                onClick={() => setShowRecentSub(v => !v)}>
                <span>Open Recent</span><span style={{ fontSize: 10 }}>{showRecentSub ? "▴" : "▾"}</span>
              </button>
              {showRecentSub && (
                <div style={{ background: "#07090f", borderTop: "1px solid #1e293b", borderBottom: "1px solid #1e293b", margin: "2px 0" }}>
                  {p.recentWorlds.length === 0 ? <div style={{ ...mi, color: "#475569", cursor: "default" }}>No recent worlds</div>
                    : p.recentWorlds.map(r => (
                      <button key={r.path} style={{ ...mi, paddingLeft: 20, paddingTop: 5, paddingBottom: 5 }}
                        onMouseEnter={miHover} onMouseLeave={miLeave}
                        onClick={() => { setFileMenuOpen(false); setShowRecentSub(false); p.openFileAt(r.path); }} title={r.path}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 210 }}>{r.name}</div>
                        <div style={{ fontSize: 10, color: "#64748b" }}>{timeAgo(r.timestamp)}</div>
                      </button>
                    ))}
                </div>
              )}
              <div style={{ height: 1, background: "#1e293b", margin: "3px 0" }} />
              <button style={{ ...mi, display: "flex", justifyContent: "space-between", opacity: (!p.sourcePath || p.saving) ? 0.35 : 1, cursor: (!p.sourcePath || p.saving) ? "not-allowed" : "pointer" }}
                onMouseEnter={miHover} onMouseLeave={miLeave}
                onClick={() => { if (!p.sourcePath || p.saving) return; setFileMenuOpen(false); p.saveWorld(p.sourcePath); }}>
                {p.saving ? "Saving…" : "Save"} <span style={miShortcut}>⌘S</span>
              </button>
              <button style={{ ...mi, display: "flex", justifyContent: "space-between", opacity: p.saving ? 0.35 : 1 }} onMouseEnter={miHover} onMouseLeave={miLeave}
                onClick={() => { if (p.saving) return; setFileMenuOpen(false); p.saveWorldAs(); }}>
                Save As… <span style={miShortcut}>⌘⇧S</span>
              </button>
              <label style={{ ...mi, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={p.saveCompressed} onChange={e => p.setSaveCompressed(e.target.checked)} style={{ accentColor: "#f59e0b" }} />
                <span style={{ color: p.saveCompressed ? "#fcd34d" : "#94a3b8" }}>Compressed</span>
              </label>
              <div style={{ height: 1, background: "#1e293b", margin: "3px 0" }} />
              <button style={{ ...mi, display: "flex", justifyContent: "space-between" }} onMouseEnter={miHover} onMouseLeave={miLeave}
                onClick={() => setShowExportSub(v => !v)}>
                <span>Export</span><span style={{ fontSize: 10 }}>{showExportSub ? "▴" : "▾"}</span>
              </button>
              {showExportSub && (
                <div style={{ background: "#07090f", borderTop: "1px solid #1e293b", borderBottom: "1px solid #1e293b", margin: "2px 0" }}>
                  <button style={{ ...mi, paddingLeft: 20 }} onMouseEnter={miHover} onMouseLeave={miLeave}
                    onClick={() => { if (p.exporting) return; setFileMenuOpen(false); setShowExportSub(false); p.exportPng(); }}>
                    {p.exporting ? "Exporting…" : "Export PNG"}
                  </button>
                  {p.world && (
                    <button style={{ ...mi, paddingLeft: 20, display: "flex", alignItems: "center", gap: 4 }} onMouseEnter={miHover} onMouseLeave={miLeave}
                      onClick={() => { if (p.exportingObj) return; setFileMenuOpen(false); setShowExportSub(false); p.exportObj(); }}>
                      {p.exportingObj ? "Exporting…" : "Export OBJ…"} <span style={expBadge}>exp</span>
                    </button>
                  )}
                  {p.world && (
                    <button style={{ ...mi, paddingLeft: 20 }} onMouseEnter={miHover} onMouseLeave={miLeave}
                      onClick={() => { if (p.exportingJson) return; setFileMenuOpen(false); setShowExportSub(false); p.exportJson(); }}>
                      {p.exportingJson ? "Exporting…" : "Export JSON…"}
                    </button>
                  )}
                </div>
              )}
              {p.world && <button style={mi} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setFileMenuOpen(false); p.loadPrefab(); }}>Load Prefab</button>}
              {p.world && <button style={{ ...mi, display: "flex", alignItems: "center", gap: 4 }} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setFileMenuOpen(false); p.importSchematic(); }}>
                Import Schematic… <span style={expBadge}>exp</span>
              </button>}
              <div style={{ height: 1, background: "#1e293b", margin: "3px 0" }} />
              {p.world && p.templateLoaded && (
                <button style={mi} onMouseEnter={miHover} onMouseLeave={miLeave}
                  onClick={() => { setFileMenuOpen(false); p.setShowExpandModal(true); p.setExpandResult(null); }}>Expand from Template…</button>
              )}
              <button style={mi} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setFileMenuOpen(false); p.setShowWorldBrowser(true); }}>Browse Worlds…</button>
              {p.world && <button style={mi} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setFileMenuOpen(false); p.setShowUploadModal(true); }}>Upload to Server…</button>}
            </div>
          )}
        </div>

        {/* Separator after File */}
        <div style={{ width: 1, background: "#1a2540", margin: "5px 6px", alignSelf: "stretch" }} />

        {/* Permanent tabs */}
        {(["home","draw","insert","view"] as RibbonTab[]).map(id => (
          <button key={id} style={tabStyle(id)} onClick={() => setActiveTab(id)}>
            {id === "home" ? "Home" : id === "draw" ? "Draw" : id === "insert" ? "Insert" : "View"}
          </button>
        ))}

        {/* Context group — Selection (merged: selection + fill/replace) */}
        {p.rawBounds && (<>
          <div style={{ width: 1, background: "#3d2a00", margin: "5px 2px", alignSelf: "stretch" }} />
          <div key={selFlash} style={{
            display: "flex", alignItems: "stretch", position: "relative",
            background: "rgba(245,158,11,0.07)",
            borderLeft: "1px solid rgba(245,158,11,0.15)",
            borderRight: "1px solid rgba(245,158,11,0.15)",
            animation: selFlash > 0 ? "ctxPulse 0.45s ease-out" : "none",
          }}>
            {/* Label strip — hidden when the tab is active (would be obstructed by tab highlight) */}
            {activeTab !== "selection" && (
              <div style={{
                position: "absolute", top: 0, left: 0, right: 0, height: 9,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(245,158,11,0.22)",
                borderBottom: "1px solid rgba(245,158,11,0.3)",
                pointerEvents: "none",
              }}>
                <span style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", lineHeight: 1, color: "#d97706" }}>Selection</span>
              </div>
            )}
            <button style={tabStyle("selection","#f59e0b")} onClick={() => setActiveTab("selection")}>◈ Selection</button>
          </div>
          <div style={{ width: 1, background: "#3d2a00", margin: "5px 2px", alignSelf: "stretch" }} />
        </>)}

        {/* Context group — Clipboard (no label strip — single-button group) */}
        {p.clipboard && (<>
          <div style={{ width: 1, background: "#0d3020", margin: "5px 2px", alignSelf: "stretch" }} />
          <div key={clipFlash} style={{
            display: "flex", alignItems: "stretch", position: "relative",
            background: "rgba(34,197,94,0.06)",
            borderLeft: "1px solid rgba(34,197,94,0.14)",
            borderRight: "1px solid rgba(34,197,94,0.14)",
            animation: clipFlash > 0 ? "ctxPulse 0.45s ease-out" : "none",
          }}>
            <button
              style={tabStyle("paste","#22c55e")}
              onClick={() => { setActiveTab("paste"); p.setTool("paste"); }}
              title="Clipboard — click to enter paste mode">
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <ClipboardIcon />
                Clipboard
              </span>
            </button>
          </div>
          <div style={{ width: 1, background: "#0d3020", margin: "5px 2px", alignSelf: "stretch" }} />
        </>)}

        {/* Spacer pushes QAT to the right */}
        <div style={{ flex: 1 }} />

        {/* QAT — right-aligned: Pan, Select, Undo, Redo */}
        <div style={{ width: 1, background: "#1a2540", margin: "5px 4px", alignSelf: "stretch" }} />

        <button title="Pan tool (Space)" onClick={() => p.setTool("pan")}
          style={{
            height: TAB_BAR_HEIGHT, border: "none", cursor: "pointer", padding: "0 8px",
            background: p.tool === "pan" ? "rgba(59,130,246,0.15)" : "transparent",
            color: p.tool === "pan" ? "#93c5fd" : "#64748b",
            display: "flex", alignItems: "center", gap: 4, fontSize: 11,
            fontWeight: p.tool === "pan" ? 600 : 400, outline: "none",
          }}>
          <PanCursorIcon />
          <span>PAN</span>
        </button>

        <button title="Select tool (S)" onClick={() => p.setTool("select")}
          style={{
            height: TAB_BAR_HEIGHT, border: "none", cursor: "pointer", padding: "0 8px",
            background: p.tool === "select" ? "rgba(59,130,246,0.15)" : "transparent",
            color: p.tool === "select" ? "#93c5fd" : "#64748b",
            display: "flex", alignItems: "center", gap: 4, fontSize: 11,
            fontWeight: p.tool === "select" ? 600 : 400, outline: "none",
          }}>
          <span style={{ fontSize: 13 }}>⬚</span>
          <span>SELECT</span>
        </button>

        <div style={{ width: 1, background: "#1a2540", margin: "5px 3px", alignSelf: "stretch" }} />

        <button
          title={`Undo (⌘Z) · ${p.undoDepth} available`}
          style={{
            height: TAB_BAR_HEIGHT, border: "none", cursor: p.undoDepth === 0 ? "not-allowed" : "pointer",
            padding: "0 7px", background: "transparent", outline: "none",
            color: p.undoDepth === 0 ? "#334155" : "#64748b",
            display: "flex", alignItems: "center", gap: 2, fontSize: 13,
          }}
          onClick={p.handleUndo} disabled={p.undoDepth === 0}>
          <span>↩</span>
          {p.undoDepth > 0 && <span style={{ fontSize: 9, fontVariantNumeric: "tabular-nums", color: "#475569", minWidth: 10 }}>{p.undoDepth}</span>}
        </button>

        <button
          title={`Redo (⌘⇧Z) · ${p.redoDepth} available`}
          style={{
            height: TAB_BAR_HEIGHT, border: "none", cursor: p.redoDepth === 0 ? "not-allowed" : "pointer",
            padding: "0 7px", background: "transparent", outline: "none",
            color: p.redoDepth === 0 ? "#334155" : "#64748b",
            display: "flex", alignItems: "center", gap: 2, fontSize: 13,
          }}
          onClick={p.handleRedo} disabled={p.redoDepth === 0}>
          <span>↪</span>
          {p.redoDepth > 0 && <span style={{ fontSize: 9, fontVariantNumeric: "tabular-nums", color: "#475569", minWidth: 10 }}>{p.redoDepth}</span>}
        </button>

        {/* Collapse toggle */}
        <div style={{ width: 1, background: "#1a2540", margin: "5px 4px 5px 6px", alignSelf: "stretch" }} />
        <button
          onClick={() => p.onCollapse(!p.collapsed)}
          title={p.collapsed ? "Expand ribbon" : "Collapse ribbon"}
          style={{ width: 28, height: TAB_BAR_HEIGHT, border: "none", background: "transparent", color: "#475569", cursor: "pointer", outline: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <ChevronIcon up={!p.collapsed} />
        </button>
      </div>

      {/* Ribbon body */}
      {!p.collapsed && (() => {
        const bodyAccent = activeTab === "selection" ? "#b45309"
          : activeTab === "paste" ? "#15803d"
          : activeTab === "draw" ? "rgba(244,114,182,0.6)"
          : activeTab === "view" ? "rgba(59,130,246,0.4)"
          : activeTab === "insert" ? "rgba(74,222,128,0.4)"
          : "#1a2d4a";
        const scrollBtnStyle: React.CSSProperties = {
          position: "absolute", top: 0, bottom: 0, width: 20, zIndex: 10,
          border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, color: "#94a3b8",
        };
        return (
          <div style={{ position: "relative", height: bodyHeight, borderTop: `2px solid ${bodyAccent}` }}>
            {canScrollLeft && (
              <button onClick={() => ribbonScroll(-1)} style={{ ...scrollBtnStyle, left: 0, background: "linear-gradient(to right, #0f2244 60%, transparent)" }}>◄</button>
            )}
            <div ref={ribbonBodyRef} style={{
              height: "100%",
              background: "linear-gradient(to bottom, #0f2244, #091526)",
              display: "flex", alignItems: "stretch",
              overflowX: "auto", overflowY: "hidden",
              scrollbarWidth: "none",
            }}>
              {activeTab === "home"      && renderHomeTab()}
              {activeTab === "draw"      && renderDrawTab()}
              {activeTab === "insert"    && renderInsertTab()}
              {activeTab === "view"      && renderViewTab()}
              {activeTab === "selection" && renderSelectionTab()}
              {activeTab === "paste"     && renderClipboardTab()}
            </div>
            {canScrollRight && (
              <button onClick={() => ribbonScroll(1)} style={{ ...scrollBtnStyle, right: 0, background: "linear-gradient(to left, #0f2244 60%, transparent)" }}>►</button>
            )}
          </div>
        );
      })()}

      {/* Resize handle */}
      {!p.collapsed && (
        <div
          onMouseDown={onResizeDragStart}
          title="Drag to resize ribbon"
          style={{
            height: 4, cursor: "ns-resize",
            background: "rgba(30,41,59,0.6)",
            transition: "background 0.15s",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(59,130,246,0.5)")}
          onMouseLeave={e => (e.currentTarget.style.background = "rgba(30,41,59,0.6)")}
        />
      )}

      {/* Block/filter picker portal — renders outside overflow:hidden */}
      {openPicker && createPortal(
        <div ref={pickerPortalRef} style={{
          position: "fixed", top: openPicker.top, left: openPicker.left,
          zIndex: 9999, background: "#0d1829", border: "1px solid #334155",
          borderRadius: 6, padding: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.8)",
        }}>
          {(openPicker.type === "block-draw" || openPicker.type === "block-fill") ? (
            <BlockPaintPicker mode="fill" blockType={p.fillBlockType} paint={p.fillPaint}
              onBlockTypeChange={bt => { if (bt !== null) p.setFillBlockType(bt); }}
              onPaintChange={paint => p.setFillPaint(paint ?? 0)}
              onFill={p.fillSelection} selectionExists={!!p.rawBounds}
              texturePack={p.texturePack} />
          ) : (
            <BlockPaintPicker mode="filter" blockType={p.filterBlockType} paint={p.filterPaint}
              onBlockTypeChange={p.setFilterBlockType} onPaintChange={p.setFilterPaint}
              texturePack={p.texturePack} />
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
