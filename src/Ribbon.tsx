import { decodeU8 } from "./codec";
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { Tool, SelectionBounds } from "./MapCanvas";
import type { SelectionInfo, ClipboardInfo, ExtrudeAxis, WorldMeta, RecentWorld } from "./types";
import BlockPaintPicker from "./BlockPaintPicker";
import NumberField from "./NumberField";
import { timeAgo } from "./useRecentWorlds";
import { BLOCK_DEFS, resolveColor, blockDisplayName } from "./blockDefs";
import { tintedSwatch } from "./texturePack";
import appIcon from "./assets/app-icon.png";
import { EDEN_TEAL, EDEN_TEAL_READABLE, recessedWell, accentRing, expBadge, perfBadge, wipBadge } from "./designTokens";
export { EDEN_TEAL, EDEN_TEAL_READABLE } from "./designTokens";

export const RIBBON_HEIGHT_COLLAPSED = 32;
export const TAB_BAR_HEIGHT = 32;
export const DEFAULT_BODY_HEIGHT = 96;

export type RibbonTab = "home" | "draw" | "insert" | "view" | "selection" | "paste" | "3d";

/** Top-down map view modes. "cutaway" renders (and targets edits) as if the world ended at the
 *  cap Z — the way to work on caves/interiors without the roof in the way. */
export type MapViewMode = "topdown" | "zslice" | "cutaway";

export interface RibbonProps {
  world: WorldMeta | null;
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
  sprayDensity: number; setSprayDensity: (v: number) => void;
  strokeStabilizer: boolean; setStrokeStabilizer: (v: boolean) => void;
  sculptStrength: number; setSculptStrength: (v: number) => void;
  sculptRadius: number; setSculptRadius: (v: number) => void;
  sculptSoftness: number; setSculptSoftness: (v: number) => void;
  sculptProfile: "smooth" | "linear" | "sphere" | "sharp"; setSculptProfile: (v: "smooth" | "linear" | "sphere" | "sharp") => void;
  sculptAccumulate: boolean; setSculptAccumulate: (v: boolean) => void;
  sculptClipToSelection: boolean; setSculptClipToSelection: (v: boolean) => void;
  noiseMode: "hills" | "mountains"; setNoiseMode: (v: "hills" | "mountains") => void;
  noiseFeatureSize: number; setNoiseFeatureSize: (v: number) => void;
  slopeGradeX: number; setSlopeGradeX: (v: number) => void;
  slopeGradeY: number; setSlopeGradeY: (v: number) => void;
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
  viewMode: MapViewMode; setViewMode: (v: MapViewMode) => void;
  zSliceZ: number; zSliceDisplay: number;
  setZSliceDisplay: (v: number) => void; commitZSlice: (v: number) => void;
  followSurface: boolean; setFollowSurface: (v: boolean) => void;
  renderMode: "tiled" | "full" | "axo"; setRenderMode: (v: "tiled" | "full" | "axo") => void;
  axoSkew: number; setAxoSkew: (v: number) => void;
  showSlicePanels: boolean; setShowSlicePanels: (v: boolean) => void;
  enable3dPane: boolean; setEnable3dPane: (v: boolean) => void;
  // 3D fly-view interaction (the contextual "3D" tab). Decoupled from the map's Draw/Select tools.
  mode3d: "off" | "select" | "build" | "sculpt"; setMode3d: (v: "off" | "select" | "build" | "sculpt") => void;
  build3dBlock: number; build3dPaint: number;
  setBuild3dBlock: (v: number) => void; setBuild3dPaint: (v: number) => void;
  nightLighting: boolean; setNightLighting: (v: boolean) => void;
  shadows3d: boolean; setShadows3d: (v: boolean) => void;
  gpuShadows: boolean; setGpuShadows: (v: boolean) => void;
  sunTDisplay: number; setSunTDisplay: (v: number) => void; commitSunT: (v: number) => void;
  lampRadiusDisplay: number; setLampRadiusDisplay: (v: number) => void; commitLampRadius: (v: number) => void;
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
  onShowWorldInfo: () => void;
  // Selection
  selection: SelectionInfo | null;
  rawBounds: SelectionBounds | null;
  setRawBounds: React.Dispatch<React.SetStateAction<SelectionBounds | null>>;
  copySelection: () => void; deleteBlocks: () => void; fillSelection: () => void;
  // Gradient fill
  gradientToBlock: number; setGradientToBlock: (v: number) => void;
  gradientToPaint: number; setGradientToPaint: (v: number) => void;
  gradientAxis: "x" | "y" | "z"; setGradientAxis: (v: "x" | "y" | "z") => void;
  gradientIncludeAir: boolean; setGradientIncludeAir: (v: boolean) => void;
  applyGradientFill: () => void;
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
  onSavePrefabAs: () => void;
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
  showPrefabLibrary: boolean; onTogglePrefabLibrary: () => void;
  moveWithContents: boolean; setMoveWithContents: (fn: (v: boolean) => boolean) => void;
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
  /** Called once on mount with a setter for the active tab, so outside chrome (the Quick Actions
   *  bar's "More…") can switch tabs without lifting `activeTab` out of the Ribbon. */
  registerTabSetter?: (fn: (t: RibbonTab) => void) => void;
}


// ── shared styles ──────────────────────────────────────────────────────────────
// Dense adaptation of the "X Design System" glass/chrome language: gradient
// chrome buttons, 1px insets (X uses 2px — halved here for compact controls),
// engraved captions, recessed wells. Radii/sizes/fonts are left exactly as
// they were — X's own 9-12px radii and 17px control scale don't fit this
// toolbar's density, so only color/gradient/shadow recipes are adopted.

const rb: React.CSSProperties = {
  background: "linear-gradient(180deg, rgb(46,58,82) 0%, rgb(26,34,52) 100%)",
  border: "none", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.5), 0 .5px .5px rgba(255,255,255,.15)",
  color: "#dad6d2", padding: "2px 8px", borderRadius: 3, cursor: "pointer",
  fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap", outline: "none",
};
const rbDim: React.CSSProperties = {
  ...rb, color: "#83786c",
  background: "linear-gradient(180deg, rgb(30,38,54) 0%, rgb(20,26,38) 100%)",
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,.5), 0 .5px .5px rgba(255,255,255,.06)",
};
function accentRgb(accent: string): string {
  return accent === "#3b82f6" ? "59,130,246"
    : accent === "#f59e0b" ? "245,158,11"
    : accent === "#a78bfa" ? "167,139,250"
    : accent === "#4ade80" ? "74,222,128"
    : accent === "#facc15" ? "250,204,21"
    : "34,197,94";
}
const rbActive = (accent = "#3b82f6"): React.CSSProperties => {
  const rgb = accentRgb(accent);
  const textColor = accent === "#3b82f6" ? "#93c5fd"
    : accent === "#f59e0b" ? "#fcd34d"
    : accent === "#a78bfa" ? "#c4b5fd"
    : accent === "#facc15" ? "#fde047"
    : "#86efac";
  return {
    ...rb,
    background: `linear-gradient(180deg, rgba(${rgb},0.30) 0%, rgba(${rgb},0.12) 100%)`,
    boxShadow: `inset 0 0 0 1px ${accent}, 0 .5px .5px rgba(255,255,255,.2)`,
    color: textColor,
  };
};
const rbGroup: React.CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3,
  padding: "5px 10px 4px", position: "relative", minWidth: 0, flexShrink: 0,
};
const rbGroupLabel: React.CSSProperties = {
  fontSize: 9, color: "#61584f", letterSpacing: "0.07em", fontWeight: 700,
  textTransform: "uppercase", userSelect: "none", marginTop: "auto",
  paddingTop: 3, textAlign: "center", alignSelf: "stretch",
  borderTop: "1px solid #37322d", textShadow: "0 -1px 0 rgba(0,0,0,.5)",
};
const rbDivider: React.CSSProperties = {
  width: 1, background: "#403b35", alignSelf: "stretch", margin: "4px 2px",
  boxShadow: "1px 0 0 rgba(255,255,255,0.03)",
};

// The fourteen sculpt tools, rendered as a compact 5-col icon grid (3 rows). Module-scope so both
// the Draw tab's Sculpt group and the 3D tab's sculptGroup() share one source of truth.
const SCULPT_ALL_TOOLS: { id: Tool; icon: string; short: string; name: string }[] = [
  { id: "raise",   icon: "▲", short: "Raise",     name: "Raise — drag to pull up" },
  { id: "lower",   icon: "▼", short: "Lower",     name: "Lower — drag to dig down" },
  { id: "grab",    icon: "✥", short: "Grab",      name: "Grab — drag up/down to pull terrain" },
  { id: "smooth",  icon: "〰", short: "Smooth",    name: "Smooth — average heights" },
  { id: "flatten", icon: "▬", short: "Flatten",   name: "Flatten — level to click height" },
  { id: "slope",   icon: "◺", short: "Slope",     name: "Slope — flatten to a tilted plane (set Slope X/Y in Falloff)" },
  { id: "smear",   icon: "➜", short: "Smear",     name: "Smear — drag to pull height along with the brush" },
  { id: "terrace", icon: "☰", short: "Terrace",   name: "Terrace — quantize height into Strength-block steps" },
  { id: "sharpen", icon: "◆", short: "Sharpen",   name: "Sharpen — crisps terrain, the inverse of Smooth" },
  { id: "noise",   icon: "⛰", short: "Noise",     name: "Noise — coherent hills/mountains" },
  { id: "erode",   icon: "◣", short: "Erode",     name: "Erode — drop toward lowest neighbour" },
  { id: "thermal", icon: "♨", short: "Thermal",   name: "Thermal — talus-angle erosion" },
  { id: "hydro",   icon: "≈", short: "Hydro",     name: "Hydro — droplet hydraulic erosion" },
  { id: "stamp",   icon: "▦", short: "Retexture", name: "Retexture — repaint surface by slope" },
];
const zInp: React.CSSProperties = {
  width: 46, background: "rgba(0,0,0,0.35)", border: "none",
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4), inset 0 2px 3px rgba(0,0,0,.35)",
  color: "#ebe9e7", borderRadius: 3, padding: "1px 4px", fontSize: 11,
  textAlign: "center", outline: "none",
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
  type: "block-draw" | "block-fill" | "filter" | "gradient-to" | "build-3d";
  top: number; left: number;
}

export default function Ribbon(p: RibbonProps) {
  const [activeTab, setActiveTab] = useState<RibbonTab>("home");
  const activeTabRef = useRef<RibbonTab>("home");
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  const registerTabSetter = p.registerTabSetter;
  useEffect(() => { registerTabSetter?.(setActiveTab); }, [registerTabSetter]);

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

  // Track which toggles have ever been activated, to show a "was-active" off border
  const toggledOnce = useRef(new Set<string>());
  function toggleStyle(id: string, active: boolean, accent?: string): React.CSSProperties {
    if (active) { toggledOnce.current.add(id); return rbActive(accent); }
    if (toggledOnce.current.has(id)) return { ...rb, ...accentRing("rgba(255,255,255,0.38)"), color: "#afa69d" };
    return rb;
  }

  // Clipboard axo preview
  const [clipAxoPixels, setClipAxoPixels] = useState<{width:number;height:number;pixels:Uint8Array}|null>(null);
  const clipAxoCanvasRef = useRef<HTMLCanvasElement>(null);

  // World rename. Escape sets `renameCancelled` so the blur it triggers doesn't commit the edit —
  // previously "cancelling" relied on the unmount racing the blur handler, and if blur won, the
  // rename went through anyway. `renameHint` surfaces the character filter (the input silently
  // dropped anything outside [A-Za-z0-9' ], so typed dashes/underscores just vanished).
  const renameCancelledRef = useRef(false);
  const [renameHint, setRenameHint] = useState(false);
  const RENAME_ALLOWED = /[A-Za-z0-9' ]/;

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
    const drawTools = ["pen","brush","spray","line","rect","ellipse","polygon","smooth","noise","flatten","erode","thermal","hydro","stamp","grab","raise","lower","terrace","sharpen","slope","smear","fill"];
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

  // The contextual 3D tab only exists while the fly-view is showing; if it vanishes while active,
  // fall back to the View tab so the ribbon body isn't blank.
  useEffect(() => {
    if (!(p.showSlicePanels && p.enable3dPane) && activeTabRef.current === "3d") setActiveTab("view");
  }, [p.showSlicePanels, p.enable3dPane]);

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
      .then(raw => setClipAxoPixels({ width: raw.width, height: raw.height, pixels: decodeU8(raw.pixels) }))
      .catch(() => setClipAxoPixels(null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.clipboard]);

  // Draw clipboard top-down preview onto canvas
  useEffect(() => {
    const canvas = clipAxoCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#151311";
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

  /** CSS `background` for a block+paint chip: the texture-pack tile when a pack is loaded,
   *  otherwise the flat block colour (same fallback the pickers use). */
  const swatchBg = (bt: number, paint: number): string => {
    const url = p.texturePack ? tintedSwatch(bt, paint, p.texturePack) : null;
    if (url) return `url(${url}) center/cover`;
    const [r, g, b] = resolveColor(bt, paint);
    return `rgb(${r},${g},${b})`;
  };

  // ── tab style ──────────────────────────────────────────────────────────────

  const tabStyle = (id: RibbonTab, accent = "#3b82f6"): React.CSSProperties => {
    const isActive = activeTab === id;
    const textColor = accent === "#f59e0b" ? (isActive ? "#fcd34d" : "#c4963c")
      : accent === "#22c55e" ? (isActive ? "#86efac" : "#4ade80")
      : (isActive ? "#ebe9e7" : "#83786c");
    const rgb = accentRgb(accent);
    return {
      background: isActive
        ? `linear-gradient(180deg, rgba(${rgb},0.30) 0%, rgba(${rgb},0.09) 45%, rgb(24,20,17) 100%)`
        : "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
      border: "none",
      borderTop: `1px solid ${isActive ? accent : "transparent"}`,
      borderBottom: `2px solid ${isActive ? "#3a352f" : "transparent"}`,
      boxShadow: isActive ? "inset 0 1px 0 rgba(255,255,255,.12)" : "none",
      borderRadius: "5px 5px 0 0",
      color: textColor,
      cursor: "pointer", padding: "0 13px",
      height: isActive ? TAB_BAR_HEIGHT : TAB_BAR_HEIGHT - 5,
      alignSelf: "flex-end",
      fontSize: 12, fontWeight: isActive ? 600 : 400, whiteSpace: "nowrap",
      userSelect: "none", outline: "none",
      position: "relative", zIndex: isActive ? 2 : 1,
      marginTop: 0, marginLeft: 1, marginRight: 1,
      marginBottom: isActive ? -2 : 0,
    };
  };

  const mi: React.CSSProperties = {
    display: "block", width: "100%", textAlign: "left", background: "none",
    border: "none", color: "#ebe9e7", padding: "5px 14px", fontSize: 12, cursor: "pointer",
  };
  const miHover = (e: React.MouseEvent<HTMLButtonElement>) => { (e.currentTarget.style.background = `rgba(${EDEN_TEAL},0.18)`); };
  const miLeave = (e: React.MouseEvent<HTMLButtonElement>) => { (e.currentTarget.style.background = ""); };
  const miShortcut: React.CSSProperties = { fontSize: 10, color: "#61584f", marginLeft: "auto", paddingLeft: 12 };

  const dropStyle: React.CSSProperties = {
    position: "absolute", top: "calc(100% + 2px)", left: 0, zIndex: 500,
    background: "linear-gradient(180deg, rgba(34,29,25,.95) 0%, rgba(20,17,14,.95) 100%)",
    backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 6, padding: "4px 0", minWidth: 180,
    boxShadow: "0 10px 28px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,.06)",
  };

  // ── tab content renderers ──────────────────────────────────────────────────

  function renderHomeTab() {
    const hasSelection = !!p.rawBounds;
    const hasClipboard = !!p.clipboard;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>

        <div style={{ ...rbGroup, minWidth: 130 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {p.renamingWorld ? (
              <>
                <input
                  ref={p.renameInputRef}
                  value={p.renameInput}
                  title="Letters, numbers, spaces and apostrophes — max 32 characters"
                  onChange={e => {
                    const raw = e.target.value;
                    const clean = raw.split("").filter(c => RENAME_ALLOWED.test(c)).join("").slice(0, 32);
                    setRenameHint(clean !== raw);
                    p.setRenameInput(clean);
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      renameCancelledRef.current = true; // consumed by onBlur below
                      setRenameHint(false);
                      p.setRenamingWorld(false);
                    }
                  }}
                  onBlur={() => {
                    setRenameHint(false);
                    if (renameCancelledRef.current) { renameCancelledRef.current = false; return; }
                    p.onRenameBlur(p.renameInput.trim());
                  }}
                  style={{ background: "rgba(255,255,255,0.08)", border: "1px solid #3b82f6", borderRadius: 3, color: "#ebe9e7", fontSize: 12, fontWeight: 700, padding: "1px 5px", outline: "none", width: 120 }}
                  autoFocus
                />
                {renameHint && (
                  <span style={{ color: "#f59e0b", fontSize: 9, lineHeight: 1.2, maxWidth: 120 }}>
                    letters, numbers, spaces, ’ only
                  </span>
                )}
              </>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div onClick={() => { p.setRenameInput(p.world?.name ?? ""); p.setRenamingWorld(true); }}
                  style={{ color: "#ebe9e7", fontWeight: 700, fontSize: 12, cursor: "text", borderBottom: "1px dashed rgba(255,255,255,0.15)", paddingBottom: 1, userSelect: "none", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title="Click to rename world">
                  {p.world?.name ?? "—"}
                </div>
                {p.world && (
                  <button onClick={p.onShowWorldInfo}
                    style={{ background: "none", border: "none", padding: "0 2px", cursor: "pointer", color: "#61584f", fontSize: 12, lineHeight: 1, display: "flex", alignItems: "center" }}
                    title="World info">ⓘ</button>
                )}
              </div>
            )}
            <div style={{ color: "#61584f", fontSize: 10 }}>{p.world ? `${p.world.width_chunks}×${p.world.height_chunks} chunks` : ""}</div>
            <div
              title={p.world?.max_z === 255
                ? "New Dawn (256z) format — worlds up to 256 blocks tall"
                : p.world?.max_z === 63 ? "Legacy (64z) format — worlds up to 64 blocks tall" : undefined}
              style={{ fontSize: 10, color: p.world?.max_z === 255 ? "#a78bfa" : "#61584f" }}
            >
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

        {/* Navigate — tool shortcuts */}
        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => p.setTool("pan")} style={p.tool === "pan" ? rbActive() : rb} title="Pan (Space)">
              <span style={{ display: "flex", alignItems: "center", gap: 3 }}><PanCursorIcon />Pan</span>
            </button>
            <button onClick={() => p.setTool("select")} style={p.tool === "select" ? rbActive() : rb} title="Select (S)">⬚ Select</button>
            <button onClick={() => p.setTool("wand")} style={p.tool === "wand" ? rbActive("#a78bfa") : rb} title="Magic Wand (W)">⁂ Wand</button>
            <button onClick={() => p.setTool("lasso")} style={p.tool === "lasso" ? rbActive("#a855f7") : rb} title="Lasso — drag a freeform selection (K)">◌ Lasso</button>
          </div>
          {p.tool === "wand" && (
            <button onClick={() => p.setWandMatchPaint(!p.wandMatchPaint)} style={p.wandMatchPaint ? rbActive("#a855f7") : rb}>
              {p.wandMatchPaint ? "Type + Colour" : "Type only"}
            </button>
          )}
          <div style={rbGroupLabel}>Navigate</div>
        </div>
        <div style={rbDivider} />

        {/* Selection quick actions — grayed when no selection */}
        <div style={{ ...rbGroup, opacity: hasSelection ? 1 : 0.38, pointerEvents: hasSelection ? "auto" : "none" }}>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={p.copySelection} style={rb}>Copy</button>
            <button onClick={p.deleteBlocks} style={{ ...rb, ...accentRing("#ef4444"), color: "#fca5a5" }} title="Fill with air">Delete</button>
            <button onClick={p.fillSelection} style={{ ...rb, ...accentRing("#f59e0b"), color: "#fcd34d" }}>Fill</button>
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => p.setRawBounds(b => b ? { x1: b.x1-1, y1: b.y1-1, x2: b.x2+1, y2: b.y2+1 } : null)} style={rb}>Grow</button>
            <button onClick={() => p.setRawBounds(b => b ? { x1: Math.min(b.x1+1,b.x2), y1: Math.min(b.y1+1,b.y2), x2: Math.max(b.x2-1,b.x1), y2: Math.max(b.y2-1,b.y1) } : null)} style={rb}>Shrink</button>
            <button onClick={() => p.setRawBounds(null)} style={rb}>Clear</button>
          </div>
          <div style={rbGroupLabel}>Selection {!hasSelection && <span style={{ color: "#f59e0b", opacity: 0.7 }}>(none)</span>}</div>
        </div>
        <div style={rbDivider} />

        {/* Clipboard quick actions — grayed when no clipboard */}
        <div style={{ ...rbGroup, opacity: hasClipboard ? 1 : 0.38, pointerEvents: hasClipboard ? "auto" : "none" }}>
          <button onClick={() => p.setTool("paste")}
            style={p.tool === "paste" ? rbActive("#22c55e") : { ...rb, ...accentRing("#22c55e"), color: "#86efac" }}>
            ▣ Paste Mode
          </button>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={p.rotateClipboard} style={rb}>↻ Rotate</button>
            <button onClick={p.mirrorClipboardX} style={rb}>↔ Flip X</button>
            <button onClick={p.mirrorClipboardY} style={rb}>↕ Flip Y</button>
          </div>
          <div style={rbGroupLabel}>Clipboard {!hasClipboard && <span style={{ color: "#61584f", opacity: 0.7 }}>(empty)</span>}</div>
        </div>
        <div style={rbDivider} />

        <div style={rbGroup}>
          <div style={{ color: "#83786c", fontSize: 10 }}>
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
    const drawTools = ["pen","brush","spray","line","rect","ellipse","polygon"] as const;
    const drawToolIcons: Record<string,string> = { pen:"✏", brush:"⬟", spray:"❉", line:"╱", rect:"□", ellipse:"○", polygon:"⬠" };
    const drawToolNames: Record<string,string> = { pen:"Pen", brush:"Brush", spray:"Spray", line:"Line", rect:"Rect", ellipse:"Ellipse", polygon:"Polygon" };
    const drawToolKeys: Record<string,string> = { pen:"P", brush:"B", spray:"", line:"L", rect:"R", ellipse:"E", polygon:"G" };
    // All sculpt tools rendered uniformly as a compact icon grid (5 cols × 3 rows). Shared with the
    // 3D tab's sculptGroup() via the module-scope SCULPT_ALL_TOOLS.
    const sculptAllTools = SCULPT_ALL_TOOLS;
    const activeSculptTool = sculptAllTools.find(t => t.id === p.tool);
    const kbdBadge: React.CSSProperties = {
      fontSize: 8, fontFamily: "ui-monospace,'SF Mono',monospace", color: "#61584f",
      background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: 2, padding: "0 2px", lineHeight: "12px", marginLeft: 3, flexShrink: 0,
    };
    const isActive = (b: {type:number;paint:number}) => b.type === p.fillBlockType && b.paint === p.fillPaint;
    const activeSwatchUrl = p.texturePack ? tintedSwatch(p.fillBlockType, p.fillPaint, p.texturePack) : null;
    // Defined before the JSX so the prevToolRef mutation doesn't trip react-hooks/immutability
    // (mutating a value read earlier in JSX is disallowed).
    const armEyedropper = () => { p.prevToolRef.current = p.tool === "eyedropper" ? "pen" : p.tool as Tool; p.setTool("eyedropper"); };
    const slotBase: React.CSSProperties = {
      width: 24, height: 24, borderRadius: 3, cursor: "pointer", flexShrink: 0,
      position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
    };
    const cornerBadge: React.CSSProperties = {
      position: "absolute", top: 0, right: 0, width: 10, height: 10,
      borderRadius: "0 3px 0 3px", background: "rgba(0,0,0,0.75)", display: "flex",
      alignItems: "center", justifyContent: "center", fontSize: 8, color: "#ebe9e7", zIndex: 1,
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
        <div style={{ ...rbGroup, minWidth: 150 }}>
          {/* Compact icon buttons (name + key in tooltip) so all 7 draw tools fit one row. */}
          <div style={{ display: "flex", gap: 2 }}>
            {drawTools.map(t => (
              <button key={t} onClick={() => p.setTool(t)}
                title={`${drawToolNames[t]}${drawToolKeys[t] ? ` (${drawToolKeys[t]})` : ""}`}
                style={{ ...(p.tool === t ? rbActive("#f472b6") : rb), padding: "2px 7px", fontSize: 13, lineHeight: "18px" }}>
                {drawToolIcons[t]}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => p.setTool("fill")} title="Fill Bucket — flood fill (F)"
              style={{ ...(p.tool === "fill" ? rbActive("#34d399") : rb), display: "flex", alignItems: "center" }}>
              🪣 Fill<span style={kbdBadge}>F</span>
            </button>
            <button onClick={armEyedropper}
              title="Eyedropper — sample a block from the map (I)"
              style={{ ...(p.tool === "eyedropper" ? {...rbActive("#67e8f9"), ...accentRing("#67e8f9"), color:"#a5f3fc"} : rb), display: "flex", alignItems: "center" }}>
              💉 Pick<span style={kbdBadge}>I</span>
            </button>
          </div>
          {/* Active-tool caption — mirrors the sculpt group so the icons aren't ambiguous. */}
          <div style={{ fontSize: 10, color: "#f9a8d4", textAlign: "center", alignSelf: "stretch",
                        fontWeight: 600, minHeight: 13 }}>
            {drawToolNames[p.tool] ?? (p.tool === "fill" ? "Fill" : p.tool === "eyedropper" ? "Pick" : "")}
          </div>
          <div style={rbGroupLabel}>Tools</div>
        </div>
        <div style={rbDivider} />

        {/* Palette — active block + quick gallery; Browse opens the full picker flyout.
            Placed here (only fixed-width Tools to its left) so it never shifts as
            contextual option groups appear/disappear to its right. */}
        <div style={rbGroup}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            {/* Active block — large swatch, opens the full picker */}
            <button onClick={(e) => togglePicker(e, "block-draw")}
              title="Active block — click to browse all blocks & paints"
              style={{ ...rb, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "4px 6px", background: openPicker?.type === "block-draw" ? "rgba(255,255,255,0.1)" : rb.background }}>
              <div style={{ width: 38, height: 38, borderRadius: 3, flexShrink: 0, border: "1px solid rgba(255,255,255,0.22)", background: activeSwatchUrl ? `url(${activeSwatchUrl}) center/cover` : `rgb(${swatchColor[0]},${swatchColor[1]},${swatchColor[2]})`, imageRendering: activeSwatchUrl ? "pixelated" : undefined }} />
              <span style={{ fontSize: 10, maxWidth: 68, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#dad6d2" }}>
                {blockDisplayName(p.fillBlockType)}{p.fillPaint > 0 ? ` #${p.fillPaint}` : ""}
              </span>
            </button>
            {/* Quick gallery: pinned + recent, plus Browse-all button */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 3,
                background: "rgba(255,255,255,0.03)", border: "1px solid #312c28",
                borderRadius: 4, padding: "3px 4px",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
              }}>
            <span style={{ color: "#4b443d", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em", userSelect: "none" }}>PINNED</span>
            {p.pinnedBlocks.map((b, i) => {
              const key = `pinned-${i}`;
              const hovered = p.hotbarHover === key;
              const active = b ? isActive(b) : false;
              const [r, g, bl] = b ? resolveColor(b.type, b.paint) : [30, 40, 60];
              const swUrl = b && p.texturePack ? tintedSwatch(b.type, b.paint, p.texturePack) : null;
              return (
                <div key={i} style={{ ...slotBase, width: 26, height: 26, background: b ? `rgb(${r},${g},${bl})` : "rgba(255,255,255,0.03)", backgroundImage: swUrl ? `url(${swUrl})` : undefined, backgroundSize: "cover", border: active ? "2px solid #fff" : b ? "1px solid rgba(255,255,255,0.18)" : "1px dashed #4b443d", outline: active ? "1px solid #a78bfa" : "none", outlineOffset: 1 }}
                  title={b ? `${blockDisplayName(b.type)}${b.paint > 0 ? ` p${b.paint}` : ""} · key ${i+1}` : `Empty pin slot ${i+1}`}
                  onClick={() => b && (p.setFillBlockType(b.type), p.setFillPaint(b.paint))}
                  onMouseEnter={() => p.setHotbarHover(key)} onMouseLeave={() => p.setHotbarHover(null)}>
                  <span style={{ position:"absolute",top:0,left:2,fontSize:6,color:"rgba(255,255,255,0.35)",lineHeight:1,pointerEvents:"none",userSelect:"none" }}>{i+1}</span>
                  {b && letterOverlay(b.type)}
                  {hovered && b && <div style={cornerBadge} onClick={e => { e.stopPropagation(); p.setPinnedBlocks(prev => { const n=[...prev]; n[i]=null; return n; }); p.setHotbarHover(null); }} title="Unpin">×</div>}
                </div>
              );
            })}
            <div style={{ width: 1, background: "#312c28", alignSelf: "stretch", margin: "0 2px" }} />
            <span style={{ color: "#4b443d", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em", userSelect: "none" }}>RECENT</span>
            {p.recentBlocks.length === 0
              ? <span style={{ color: "#312c28", fontSize: 10, fontStyle: "italic" }}>none</span>
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
              <button onClick={(e) => togglePicker(e, "block-draw")}
                title="Browse all blocks & paints"
                style={{ ...rb, display: "flex", gap: 4, alignItems: "center", justifyContent: "center", padding: "2px 8px", background: openPicker?.type === "block-draw" ? "rgba(255,255,255,0.1)" : rb.background }}>
                Browse all blocks<span style={{ color: "#61584f", fontSize: 9 }}>▾</span>
              </button>
            </div>
          </div>
          <div style={rbGroupLabel}>Palette</div>
        </div>
        <div style={rbDivider} />

        {/* Shape & Mode — contextual; kept to the RIGHT of Palette so Palette never shifts */}
        {(p.tool === "brush" || (!p.isSculptTool && p.tool !== "fill" && p.tool !== "eyedropper")) && (<>
          <div style={rbGroup}>
            {(p.tool === "brush" || p.tool === "spray" || p.tool === "line") && (
              <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                {([1,3,5,7,9] as const).map(s => (
                  <button key={s} onClick={() => p.setBrushSize(s)}
                    style={p.brushSize === s ? rbActive("#f472b6") : { ...rb, padding: "2px 6px" }}>{s}</button>
                ))}
                <div style={{ width: 4 }} />
                <button onClick={() => p.setBrushShape("sq")} title="Square brush" style={p.brushShape === "sq" ? rbActive("#f472b6") : rb}>■</button>
                <button onClick={() => p.setBrushShape("circ")} title="Round brush" style={p.brushShape === "circ" ? rbActive("#f472b6") : rb}>●</button>
              </div>
            )}
            {p.tool === "spray" && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "#83786c", fontSize: 10, minWidth: 46 }}>Density</span>
                <input type="range" min={5} max={100} step={5} value={Math.round(p.sprayDensity * 100)}
                  onChange={e => p.setSprayDensity(Number(e.target.value) / 100)}
                  title="Fraction of the brush footprint sprayed per stamp (hold to build up)"
                  style={{ width: 72, accentColor: "#f472b6", cursor: "pointer" }} />
                <span style={{ color: "#f9a8d4", fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 24 }}>{Math.round(p.sprayDensity * 100)}%</span>
              </div>
            )}
            <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
              <button onClick={() => p.setDrawFilled(true)} style={p.drawFilled ? rbActive("#f472b6") : rb}>Fill</button>
              <button onClick={() => p.setDrawFilled(false)} style={!p.drawFilled ? rbActive("#f472b6") : rb}>Hollow</button>
              <div style={{ width: 6 }} />
              <button onClick={() => p.setDrawAbove(false)} style={!p.drawAbove ? rbActive("#f472b6") : rb}>Surface</button>
              <button onClick={() => p.setDrawAbove(true)} style={p.drawAbove ? rbActive("#fcd34d") : rb}>+1 Above</button>
              {(p.tool === "pen" || p.tool === "brush" || p.tool === "spray") && (<>
                <div style={{ width: 6 }} />
                <button onClick={() => p.setStrokeStabilizer(!p.strokeStabilizer)}
                  title="Stabilizer — smooths out hand jitter on freehand strokes (pen/brush/spray). The brush trails slightly behind the cursor while drawing — that lag is the smoothing, not lag/lag-spike."
                  style={p.strokeStabilizer ? rbActive("#f472b6") : rb}>{p.strokeStabilizer ? "Stabilize ✓" : "Stabilize"}</button>
              </>)}
            </div>
            <div style={rbGroupLabel}>Shape &amp; Mode</div>
          </div>
          <div style={rbDivider} />
        </>)}

        {/* Sculpt tools — compact icon grid (5 cols × 3 rows), fitting the group's ≤3-row budget */}
        <div style={rbGroup}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, auto)", gap: 3 }}>
            {sculptAllTools.map(t => (
              <button key={t.id} onClick={() => p.setTool(t.id)} title={t.name}
                style={{ ...(p.tool === t.id ? rbActive("#fb923c") : rb), padding: "2px 7px", fontSize: 13, lineHeight: "18px" }}>
                {t.icon}
              </button>
            ))}
          </div>
          {/* Active-tool caption — the icons alone are ambiguous, so name the armed tool. */}
          <div style={{ fontSize: 10, color: activeSculptTool ? "#fdba74" : "#61584f", textAlign: "center",
                        alignSelf: "stretch", fontWeight: 600, minHeight: 13, letterSpacing: "0.02em" }}>
            {activeSculptTool ? activeSculptTool.short : "pick a tool"}
          </div>
          <div style={rbGroupLabel}>Sculpt <span style={expBadge({ marginLeft: 2 })}>exp</span></div>
        </div>
        <div style={rbDivider} />

        {/* Sculpt brush parameters — strength / radius / softness + falloff profile */}
        <div style={rbGroup}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "#83786c", fontSize: 10, minWidth: 46 }}>{p.tool === "terrace" ? "Step" : "Strength"}</span>
            <input type="range" min={1} max={8} step={1} value={p.sculptStrength}
              onChange={e => p.setSculptStrength(Number(e.target.value))}
              title={p.tool === "terrace" ? "Terrace step height, in blocks" : undefined}
              style={{ width: 72, accentColor: "#fb923c", cursor: "pointer" }} />
            <span style={{ color: "#fdba74", fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 10 }}>{p.sculptStrength}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "#83786c", fontSize: 10, minWidth: 46 }}>Radius</span>
            <input type="range" min={1} max={32} step={1} value={p.sculptRadius}
              onChange={e => p.setSculptRadius(Number(e.target.value))}
              title="Brush radius in blocks"
              style={{ width: 72, accentColor: "#fb923c", cursor: "pointer" }} />
            <span style={{ color: "#fdba74", fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 14 }}>{p.sculptRadius}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "#83786c", fontSize: 10, minWidth: 46 }}>Softness</span>
            <input type="range" min={0} max={100} step={5} value={Math.round(p.sculptSoftness * 100)}
              onChange={e => p.setSculptSoftness(Number(e.target.value) / 100)}
              title="Radial falloff — 0 = hard edges, 100 = full dome (soft rim)"
              style={{ width: 72, accentColor: "#fb923c", cursor: "pointer" }} />
            <span style={{ color: "#fdba74", fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 24 }}>{Math.round(p.sculptSoftness * 100)}%</span>
          </div>
          <div style={rbGroupLabel}>Brush</div>
        </div>
        <div style={rbDivider} />

        {/* Falloff profile + hold-to-build + selection mask */}
        <div style={rbGroup}>
          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ color: "#83786c", fontSize: 10 }}>Profile</span>
            {(["smooth","linear","sphere","sharp"] as const).map(pr => (
              <button key={pr} onClick={() => p.setSculptProfile(pr)} title={`${pr} falloff curve`}
                style={p.sculptProfile === pr ? rbActive("#fb923c") : { ...rb, padding: "2px 6px", textTransform: "capitalize" }}>
                {pr}
              </button>
            ))}
          </div>
          <button onClick={() => p.setSculptAccumulate(!p.sculptAccumulate)}
            title={p.sculptAccumulate
              ? "Live brush ON — terrain deforms live as you drag; stamps build up on dwell (airbrush). Esc reverts the whole stroke."
              : "Live brush OFF — legacy one-shot: the swept stroke commits as a single uniform shape on release."}
            style={p.sculptAccumulate ? rbActive("#fb923c") : rb}>
            {p.sculptAccumulate ? "Live brush ✓" : "Live brush"}
          </button>
          <button onClick={() => p.setSculptClipToSelection(!p.sculptClipToSelection)}
            title="Constrain sculpt strokes to the active selection"
            style={p.sculptClipToSelection ? rbActive("#fb923c") : rb}>
            {p.sculptClipToSelection ? "In selection ✓" : "In selection"}
          </button>
          <div style={rbGroupLabel}>Falloff</div>
        </div>
        <div style={rbDivider} />

        {/* Noise shape — only meaningful for the Noise tool */}
        {p.tool === "noise" && (<>
        <div style={rbGroup}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => p.setNoiseMode("hills")} style={p.noiseMode === "hills" ? rbActive("#fb923c") : { ...rb, padding: "2px 8px" }}>Hills</button>
            <button onClick={() => p.setNoiseMode("mountains")} style={p.noiseMode === "mountains" ? rbActive("#fb923c") : { ...rb, padding: "2px 8px" }}>Mtns</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "#83786c", fontSize: 10, minWidth: 30 }}>Size</span>
            <input type="range" min={6} max={80} step={2} value={p.noiseFeatureSize}
              onChange={e => p.setNoiseFeatureSize(Number(e.target.value))}
              style={{ width: 72, accentColor: "#fb923c", cursor: "pointer" }} />
            <span style={{ color: "#fdba74", fontSize: 10, fontVariantNumeric: "tabular-nums", minWidth: 14 }}>{p.noiseFeatureSize}</span>
          </div>
          <div style={rbGroupLabel}>Noise</div>
        </div>
        <div style={rbDivider} />
        </>)}

        {/* Slope tilt — only meaningful for the Slope tool. Percent grade (rise per 100 blocks
            of run) along each axis; the anchor is still the first block you press on. */}
        {p.tool === "slope" && (<>
        <div style={rbGroup}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "#83786c", fontSize: 10, minWidth: 30 }}>Slope X</span>
            <input type="range" min={-100} max={100} step={5} value={p.slopeGradeX}
              onChange={e => p.setSlopeGradeX(Number(e.target.value))}
              title="Tilt along X — rise in blocks per 100 blocks of run"
              style={{ width: 72, accentColor: "#fb923c", cursor: "pointer" }} />
            <span style={{ color: "#fdba74", fontSize: 10, fontVariantNumeric: "tabular-nums", minWidth: 24 }}>{p.slopeGradeX}%</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "#83786c", fontSize: 10, minWidth: 30 }}>Slope Y</span>
            <input type="range" min={-100} max={100} step={5} value={p.slopeGradeY}
              onChange={e => p.setSlopeGradeY(Number(e.target.value))}
              title="Tilt along Y — rise in blocks per 100 blocks of run"
              style={{ width: 72, accentColor: "#fb923c", cursor: "pointer" }} />
            <span style={{ color: "#fdba74", fontSize: 10, fontVariantNumeric: "tabular-nums", minWidth: 24 }}>{p.slopeGradeY}%</span>
          </div>
          <div style={rbGroupLabel}>Slope</div>
        </div>
        <div style={rbDivider} />
        </>)}

        <div style={rbGroup}>
          <button onClick={() => p.setMaskEnabled(!p.maskEnabled)} style={p.maskEnabled ? rbActive("#a78bfa") : rb}>
            {p.maskEnabled ? "Mask ✓" : "Mask"}
          </button>
          {p.maskEnabled && (
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#83786c", fontSize: 10 }}>Type</span>
              <select value={p.maskBlockType ?? ""} onChange={e => p.setMaskBlockType(e.target.value === "" ? null : Number(e.target.value))}
                style={{ ...recessedWell, background: "#312c28", color: "#ebe9e7", borderRadius: 3, fontSize: 10, padding: "1px 2px" }}>
                <option value="">any</option>
                {BLOCK_DEFS.map(b => <option key={b.type} value={b.type}>{b.name}</option>)}
              </select>
              <span style={{ color: "#83786c", fontSize: 10 }}>Paint</span>
              <select value={p.maskPaint ?? ""} onChange={e => p.setMaskPaint(e.target.value === "" ? null : Number(e.target.value))}
                style={{ ...recessedWell, background: "#312c28", color: "#ebe9e7", borderRadius: 3, fontSize: 10, padding: "1px 2px" }}>
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
          <button onClick={p.onTogglePrefabLibrary} style={p.showPrefabLibrary ? rbActive() : rb}>📚 Prefab Library</button>
          <div style={rbGroupLabel}>Prefab</div>
        </div>
        <div style={rbDivider} />
        <div style={rbGroup}>
          <button onClick={p.importSchematic} style={{ ...rb, display: "flex", alignItems: "center", gap: 4 }}>
            Import Schematic… <span style={expBadge()}>exp</span>
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
                      outline: on ? "1px solid #4ade80" : "1px solid #4b443d",
                      boxSizing: "border-box",
                    }} />
                );
              })}
            </div>
            {/* Density */}
            <span style={{ color: "#83786c", fontSize: 10 }}>D:</span>
            <input type="range" min={1} max={100} value={p.treeDensity}
              onChange={e => p.setTreeDensity(parseInt(e.target.value))}
              style={{ width: 50, accentColor: "#4ade80" }} />
            <span style={{ color: "#86efac", fontSize: 10, fontVariantNumeric: "tabular-nums", minWidth: 24 }}>{p.treeDensity}%</span>
            {/* Smart placement */}
            <label style={{ display: "flex", alignItems: "center", gap: 2, cursor: "pointer" }}>
              <input type="checkbox" checked={p.smartPlacement} onChange={e => p.setSmartPlacement(e.target.checked)} style={{ accentColor: "#4ade80" }} />
              <span style={{ color: "#83786c", fontSize: 10, whiteSpace: "nowrap" }}>Grass only</span>
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
                ...(p.selection ? { ...accentRing("#4ade80"), color: "#86efac" } : {}),
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
            <button onClick={() => p.setViewMode("cutaway")}
              title="Cutaway — hide everything above the cap Z. Drawing, terrain paste and the cursor readout all target the exposed surface below it, so underground work behaves like surface work."
              style={p.viewMode === "cutaway" ? rbActive("#a78bfa") : rb}>◪ Cutaway</button>
          </div>
          <button onClick={p.onFitMap} style={rb}>⊡ Fit Map</button>
          <div style={rbGroupLabel}>Map View</div>
        </div>
        {/* One slider, two meanings: the z-slice level, or the cutaway ceiling. */}
        {(p.viewMode === "zslice" || p.viewMode === "cutaway") && (<>
          <div style={rbDivider} />
          <div style={rbGroup}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="range" min={0} max={p.world?.max_z ?? 63} value={p.zSliceDisplay}
                aria-label={p.viewMode === "cutaway" ? "Cutaway cap Z" : "Z-slice level"}
                onChange={e => p.setZSliceDisplay(Number(e.target.value))}
                onPointerUp={e => p.commitZSlice(Number((e.target as HTMLInputElement).value))}
                onKeyUp={e => p.commitZSlice(Number((e.target as HTMLInputElement).value))}
                style={{ width: 120, accentColor: p.viewMode === "cutaway" ? "#a78bfa" : "#3b82f6", cursor: "pointer" }} />
              <span style={{ color: p.viewMode === "cutaway" ? "#ddd6fe" : "#7dd3fc", fontVariantNumeric: "tabular-nums", fontSize: 12, minWidth: 22 }}>{p.zSliceDisplay}</span>
            </div>
            {p.viewMode === "zslice" ? (
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                <input type="checkbox" checked={p.followSurface} onChange={e => p.setFollowSurface(e.target.checked)} style={{ accentColor: "#3b82f6" }} />
                <span style={{ color: "#83786c", fontSize: 10 }}>Follow surface</span>
              </label>
            ) : (
              <span style={{ color: "#83786c", fontSize: 10 }}>Everything above is hidden</span>
            )}
            <div style={rbGroupLabel}>{p.viewMode === "cutaway" ? "Cap Z" : "Z-Slice Level"}</div>
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
              <span style={{ color: "#afa69d", fontSize: 10 }}>Depth</span>
              <input type="range" min={0} max={0.5} step={0.02} value={p.axoSkew}
                onChange={e => p.setAxoSkew(parseFloat(e.target.value))}
                style={{ width: 80, accentColor: "#10b981" }} />
              <span style={{ color: "#afa69d", fontSize: 10, minWidth: 26, textAlign: "right" }}>{p.axoSkew.toFixed(2)}</span>
            </div>
          )}
          <div style={rbGroupLabel}>Render</div>
        </div>
        <div style={rbDivider} />
        <div style={rbGroup}>
          <button onClick={() => p.setShowSlicePanels(!p.showSlicePanels)}
            style={{ ...rb, display: "flex", gap: 4, alignItems: "center", ...(p.showSlicePanels ? { background: "rgba(168,85,247,0.18)", ...accentRing("#a855f7"), color: "#d8b4fe" } : {}) }}>
            ◫ Quad View <span style={expBadge()}>exp</span>
          </button>
          {p.showSlicePanels && (
            <button onClick={() => p.setEnable3dPane(!p.enable3dPane)}
              style={{ ...rb, display: "flex", gap: 4, alignItems: "center", ...(p.enable3dPane ? { background: "rgba(245,158,11,0.18)", ...accentRing("#f59e0b"), color: "#fcd34d" } : {}) }}>
              3D Pane <span style={expBadge()}>exp</span>
            </button>
          )}
          <div style={rbGroupLabel}>Layout</div>
        </div>
        {/* Lighting controls moved to the contextual 3D tab (shown when the fly-view is enabled). */}
        <>
          <div style={rbDivider} />
          <div style={rbGroup}>
            <button onClick={p.openTemplateFile} style={{ ...rb, display: "flex", gap: 4, alignItems: "center" }}>
              {p.templateLoaded ? "Change Template…" : "Load Eden Template…"} <span style={expBadge()}>exp</span>
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
        </>
        <div style={rbDivider} />
        {textureGroup()}
      </div>
    );
  }

  // Texture-pack load/unload group — shared by the View tab and the 3D tab.
  function textureGroup() {
    return (
      <div style={rbGroup}>
        <button onClick={p.openTexturePackFile} style={{ ...rb, display: "flex", gap: 4, alignItems: "center" }}>
          {p.texturePackLoaded ? "Change Pack…" : "Load Texture Pack…"}
          <span style={expBadge()}>exp</span>
          {p.texturePackLoaded && <span style={{ color: "#4ade80", fontSize: 10 }}>✓</span>}
        </button>
        {p.texturePackLoaded && (
          <button onClick={p.unloadTexturePack} style={rb}>Unload Pack</button>
        )}
        <div style={rbGroupLabel}>Textures</div>
      </div>
    );
  }

  // Night/shadow/GPU-shadow lighting group + sun slider — lives in the 3D tab.
  function lightingGroup() {
    const sunActive = p.shadows3d || p.gpuShadows;
    return (
      <div style={rbGroup}>
        <button onClick={() => p.setNightLighting(!p.nightLighting)}
          title="Lamp point-lighting for the 3D pane. Performance-intensive: rebuilds all loaded chunk geometry with a per-voxel lamp pass (in GPU mode, forward-lights up to 16 point lights instead)."
          style={p.nightLighting ? rbActive("#facc15") : rb}>
          Night Lighting <span style={expBadge()}>exp</span> <span style={perfBadge()}>⚡</span>
        </button>
        <button onClick={() => p.setShadows3d(!p.shadows3d)}
          disabled={p.gpuShadows}
          title={p.gpuShadows ? "Overridden by GPU Shadows" : "Baked sun shadows. Performance-intensive: a per-voxel sun raymarch runs on every chunk rebuild, and moving the Sun slider reloads all loaded chunks."}
          style={p.shadows3d && !p.gpuShadows ? rbActive("#facc15") : { ...rb, opacity: p.gpuShadows ? 0.4 : 1 }}>
          Shadows <span style={expBadge()}>exp</span> <span style={perfBadge()}>⚡</span>
        </button>
        <button onClick={() => p.setGpuShadows(!p.gpuShadows)}
          title="Real GPU shadow map (lit material + directional sun). Performance-intensive: a 2048–4096² shadow map is rendered every frame and every mesh casts/receives; cost rises sharply with render distance. Overrides the baked Night/Shadows previews; the Sun slider is free (no reload)."
          style={p.gpuShadows ? rbActive("#38bdf8") : rb}>
          GPU Shadows <span style={expBadge()}>exp</span> <span style={perfBadge()}>⚡</span>
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 4, opacity: sunActive ? 1 : 0.4 }}
          title={sunActive ? "Sun angle: 0 = sunrise, 0.5 = noon, 1 = sunset" : "Turn on Shadows or GPU Shadows — the sun angle only affects shadowed lighting"}>
          <span style={{ color: "#afa69d", fontSize: 10 }}>Sun</span>
          <input type="range" min={0} max={1} step={0.01} value={p.sunTDisplay}
            disabled={!sunActive}
            onChange={e => p.setSunTDisplay(parseFloat(e.target.value))}
            onPointerUp={e => p.commitSunT(parseFloat((e.target as HTMLInputElement).value))}
            onKeyUp={e => p.commitSunT(parseFloat((e.target as HTMLInputElement).value))}
            style={{ width: 80, accentColor: p.gpuShadows ? "#38bdf8" : "#facc15", cursor: sunActive ? "pointer" : "default" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, opacity: p.nightLighting ? 1 : 0.4 }}
          title={p.nightLighting ? "Lamp light radius, in blocks" : "Turn on Night Lighting — lamps only cast light at night"}>
          <span style={{ color: "#afa69d", fontSize: 10 }}>Lamp&nbsp;R {Math.round(p.lampRadiusDisplay)}</span>
          <input type="range" min={2} max={32} step={1} value={p.lampRadiusDisplay}
            disabled={!p.nightLighting}
            onChange={e => p.setLampRadiusDisplay(parseFloat(e.target.value))}
            onPointerUp={e => p.commitLampRadius(parseFloat((e.target as HTMLInputElement).value))}
            onKeyUp={e => p.commitLampRadius(parseFloat((e.target as HTMLInputElement).value))}
            style={{ width: 72, accentColor: "#facc15", cursor: p.nightLighting ? "pointer" : "default" }} />
        </div>
        <div style={rbGroupLabel}>Lighting</div>
      </div>
    );
  }

  // Sculpt tool picker + brush params — shared renderer used by the 3D tab (SCULPT mode). Same shape
  // as the Draw tab's Sculpt + Brush groups, reusing the module-scope SCULPT_ALL_TOOLS and the shared
  // sculpt state so 2D and 3D sculpting are one brush. Amber (#fb923c) matches the Draw-tab affordance.
  function sculptGroup() {
    const activeSculptTool = SCULPT_ALL_TOOLS.find(t => t.id === p.tool);
    return (
      <>
        <div style={rbGroup}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, auto)", gap: 3 }}>
            {SCULPT_ALL_TOOLS.map(t => (
              <button key={t.id} onClick={() => p.setTool(t.id)} title={t.name}
                style={{ ...(p.tool === t.id ? rbActive("#fb923c") : rb), padding: "2px 7px", fontSize: 13, lineHeight: "18px" }}>
                {t.icon}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: activeSculptTool ? "#fdba74" : "#61584f", textAlign: "center",
                        alignSelf: "stretch", fontWeight: 600, minHeight: 13, letterSpacing: "0.02em" }}>
            {activeSculptTool ? activeSculptTool.short : "pick a tool"}
          </div>
          <div style={rbGroupLabel}>Sculpt <span style={expBadge({ marginLeft: 2 })}>exp</span></div>
        </div>
        <div style={rbDivider} />
        <div style={rbGroup}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "#83786c", fontSize: 10, minWidth: 46 }}>{p.tool === "terrace" ? "Step" : "Strength"}</span>
            <input type="range" min={1} max={8} step={1} value={p.sculptStrength}
              onChange={e => p.setSculptStrength(Number(e.target.value))}
              style={{ width: 72, accentColor: "#fb923c", cursor: "pointer" }} />
            <span style={{ color: "#fdba74", fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 10 }}>{p.sculptStrength}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "#83786c", fontSize: 10, minWidth: 46 }}>Radius</span>
            <input type="range" min={1} max={32} step={1} value={p.sculptRadius}
              onChange={e => p.setSculptRadius(Number(e.target.value))}
              title="Brush radius in blocks"
              style={{ width: 72, accentColor: "#fb923c", cursor: "pointer" }} />
            <span style={{ color: "#fdba74", fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 14 }}>{p.sculptRadius}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "#83786c", fontSize: 10, minWidth: 46 }}>Softness</span>
            <input type="range" min={0} max={100} step={5} value={Math.round(p.sculptSoftness * 100)}
              onChange={e => p.setSculptSoftness(Number(e.target.value) / 100)}
              title="Radial falloff — 0 = hard edges, 100 = full dome (soft rim)"
              style={{ width: 72, accentColor: "#fb923c", cursor: "pointer" }} />
            <span style={{ color: "#fdba74", fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 24 }}>{Math.round(p.sculptSoftness * 100)}%</span>
          </div>
          <div style={rbGroupLabel}>Brush</div>
        </div>
      </>
    );
  }

  // Contextual "3D" tab — building + lighting + textures for the fly-through pane. Only rendered
  // while the fly-view is showing (quad view + 3D pane enabled).
  function renderThreeDTab() {
    const modeBtn = (m: "off" | "select" | "build" | "sculpt", label: string, accent: string) => (
      <button onClick={() => p.setMode3d(m)} style={p.mode3d === m ? rbActive(accent) : rb}
        title={m === "off" ? "Camera only — click/drag orbits or flies" :
               m === "select" ? "Click two blocks to define a 3D selection box" :
               m === "build" ? "Left-click breaks the block you're aiming at; right-click places the build block against that face" :
               "Press and hold left to sculpt terrain under the cursor/crosshair"}>
        {label}
      </button>
    );
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {modeBtn("off", "◎ Camera", "#afa69d")}
            {modeBtn("select", "▣ Select", "#60a5fa")}
            {modeBtn("build", "✏ Build", "#22c55e")}
            {modeBtn("sculpt", "⛰ Sculpt", "#fb923c")}
          </div>
          <div style={rbGroupLabel}>3D Mode</div>
        </div>
        <div style={rbDivider} />
        {p.mode3d === "sculpt" ? (
          // Sculpt mode: the shared sculpt tool picker + brush params (same as the Draw tab). Replaces
          // the Build Block group, which is irrelevant while sculpting.
          sculptGroup()
        ) : (
          /* Compact swatch button → anchored popover (same machinery as the gradient-to picker).
             The inline picker overflowed the 96 px ribbon body. Dimmed unless in build mode. */
          <div style={{ ...rbGroup, opacity: p.mode3d === "build" ? 1 : 0.5 }}>
            <button onClick={(e) => togglePicker(e, "build-3d")}
              title="Block placed by right-click in 3D build mode"
              style={{ ...rb, display: "flex", gap: 6, alignItems: "center", background: openPicker?.type === "build-3d" ? "rgba(255,255,255,0.1)" : rb.background }}>
              <span style={{
                width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                boxShadow: "inset 0 0 0 1px rgba(0,0,0,.5)",
                background: swatchBg(p.build3dBlock, p.build3dPaint),
                imageRendering: p.texturePack ? "pixelated" : undefined,
              }} />
              <span style={{ maxWidth: 84, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
                {blockDisplayName(p.build3dBlock)}{p.build3dPaint > 0 ? ` #${p.build3dPaint}` : ""}
              </span>
              <span style={{ color: "#61584f", fontSize: 9 }}>▾</span>
            </button>
            <div style={rbGroupLabel}>Build Block</div>
          </div>
        )}
        <div style={rbDivider} />
        {lightingGroup()}
        <div style={rbDivider} />
        {textureGroup()}
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
    const trackGrad = `linear-gradient(to right, #4b443d 0%, #4b443d ${lo}%, #3b82f6 ${lo}%, #3b82f6 ${hi}%, #4b443d ${hi}%, #4b443d 100%)`;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        {sel && (<>
          <div style={rbGroup}>
            <div style={{ display: "flex", gap: 4, fontVariantNumeric: "tabular-nums" }}>
              {[["W", sel.width], ["H", sel.height], ["D", sel.depth]].map(([l, v]) => (
                <div key={l as string} style={{ textAlign: "center", background: "rgba(255,255,255,0.04)", borderRadius: 3, padding: "2px 6px", minWidth: 30 }}>
                  <div style={{ color: "#83786c", fontSize: 8 }}>{l}</div>
                  <div style={{ color: l === "D" ? "#7dd3fc" : "#ebe9e7", fontSize: 12, fontWeight: 700 }}>{v}</div>
                </div>
              ))}
            </div>
            <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 10, color: "#61584f", lineHeight: 1.3 }}>
              <div>X {sel.x1}–{sel.x2}  Y {sel.y1}–{sel.y2}</div>
              <div style={{ color: "#4b443d" }}>{sel.width * sel.height * sel.depth} blocks</div>
            </div>
            <div style={rbGroupLabel}>Info</div>
          </div>
          <div style={rbDivider} />
        </>)}

        <div style={rbGroup}>
          <button
            onClick={() => p.setMoveWithContents(v => !v)}
            title="When on, dragging/arrow-nudging the selection also moves its blocks. When off (default), only the selection box moves."
            style={p.moveWithContents ? rbActive("#f59e0b") : rb}
          >
            {p.moveWithContents ? "🧱 Move: Box + Contents" : "⬚ Move: Box Only"}
          </button>
          <div style={rbGroupLabel}>Nudge/Drag</div>
        </div>
        <div style={rbDivider} />

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
          {/* Min on left, Max on right — matches slider low→high left→right */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#afa69d", fontSize: 10, minWidth: 22 }}>Min</span>
              <input type="number" min={0} max={maxZ} value={p.zMin}
                onChange={e => p.handleZMin(e.target.value)} style={zInp} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#60a5fa", fontSize: 10, minWidth: 22 }}>Max</span>
              <input type="number" min={0} max={maxZ} value={p.zMax}
                onChange={e => p.handleZMax(e.target.value)} style={zInp} />
            </div>
          </div>
          <div style={rbGroupLabel}>Z Range · {zHi - zLo + 1} levels</div>
        </div>
        <div style={rbDivider} />

        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={p.copySelection} style={{ ...rb, ...accentRing("#7dd3fc"), color: "#bfdbfe" }}>Copy</button>
            <button onClick={p.deleteBlocks} style={{ ...rb, ...accentRing("#ef4444"), color: "#fca5a5" }} title="Fill selection with air">Delete</button>
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
            <span style={{ color:"#61584f",fontSize:9 }}>▾</span>
          </button>
          <button onClick={p.fillSelection} disabled={!p.rawBounds}
            title={p.rawBounds ? "Fill the selection with the active block" : "Make a selection first"}
            style={{ ...rb, opacity: p.rawBounds ? 1 : 0.35, cursor: p.rawBounds ? "pointer" : "not-allowed", ...accentRing("#f59e0b"), color: "#fcd34d" }}>
            Fill Selection
          </button>
          <div style={rbGroupLabel}>Fill</div>
        </div>
        <div style={rbDivider} />

        {/* Gradient — blend the Fill block → a second block across an axis (dithered) */}
        <div style={rbGroup}>
          <button onClick={(e) => togglePicker(e, "gradient-to")}
            title="Gradient target block (fades from the Fill block into this one)"
            style={{ ...rb, display: "flex", gap: 5, alignItems: "center", background: openPicker?.type === "gradient-to" ? "rgba(255,255,255,0.1)" : rb.background }}>
            <span style={{ color: "#83786c", fontSize: 10 }}>→</span>
            <span style={{ maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
              {blockDisplayName(p.gradientToBlock)}{p.gradientToPaint > 0 ? ` #${p.gradientToPaint}` : ""}
            </span>
            <span style={{ color:"#61584f",fontSize:9 }}>▾</span>
          </button>
          <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
            <span style={{ color: "#83786c", fontSize: 10, minWidth: 26 }}>Axis</span>
            {([["x","→ across (E–W)"],["y","↓ across (N–S)"],["z","↕ by height"]] as const).map(([a, tip]) => (
              <button key={a} onClick={() => p.setGradientAxis(a)} title={`Gradient ${tip}${a === "z" ? " — visible in side/3D views" : " — visible top-down"}`}
                style={p.gradientAxis === a ? rbActive("#f59e0b") : { ...rb, padding: "2px 7px", textTransform: "uppercase" }}>{a}</button>
            ))}
            <button onClick={() => p.setGradientIncludeAir(!p.gradientIncludeAir)}
              title="Also fill empty (air) cells, not just existing blocks"
              style={p.gradientIncludeAir ? rbActive("#f59e0b") : { ...rb, padding: "2px 6px" }}>+Air</button>
          </div>
          <button onClick={p.applyGradientFill} disabled={!p.rawBounds}
            title={p.rawBounds ? "Blend the active block into the target block across the selection" : "Make a selection first"}
            style={{ ...rb, opacity: p.rawBounds ? 1 : 0.35, cursor: p.rawBounds ? "pointer" : "not-allowed", ...accentRing("#f59e0b"), color: "#fcd34d" }}>
            Gradient Fill
          </button>
          <div style={rbGroupLabel}>Gradient</div>
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
            <span style={{ color:"#61584f",fontSize:9 }}>▾</span>
          </button>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => p.setFilterInvert(!p.filterInvert)} style={p.filterInvert ? rbActive("#a78bfa") : rb}>Invert</button>
            <button onClick={() => { p.setFilterBlockType(null); p.setFilterPaint(null); p.setFilterInvert(false); }} style={rb}>Clear</button>
          </div>
          <button onClick={p.deleteBlocks} disabled={!p.rawBounds}
            title={p.rawBounds ? "Delete blocks in the selection (respects the replace filter)" : "Make a selection first"}
            style={{ ...rb, opacity: p.rawBounds ? 1 : 0.35, cursor: p.rawBounds ? "pointer" : "not-allowed", ...accentRing("#ef4444"), color: "#fca5a5" }}>
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
            <span style={{ color: "#61584f", fontSize: 10 }}>×</span>
            <NumberField min={0} max={20} value={p.extrudeCount} title="0 = preview off"
              onChange={p.setExtrudeCount} aria-label="Extrude copies"
              style={{ ...zInp, width: 36 }} />
            <label style={{ display: "flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
              <input type="checkbox" checked={extrudeIgnoreAir} onChange={e => setExtrudeIgnoreAir(e.target.checked)} style={{ accentColor: "#3b82f6" }} />
              <span style={{ color: "#83786c", fontSize: 10 }}>skip air</span>
            </label>
            {/* Count defaults to 0, so this button starts disabled — say so, or it reads as broken. */}
            <button onClick={() => p.onExtrude(extrudeIgnoreAir)} disabled={!sel || p.extrudeCount === 0}
              title={!sel ? "Make a selection first"
                : p.extrudeCount === 0 ? "Set the number of copies above 0"
                : `Repeat the selection ${p.extrudeCount}× along ${p.extrudeAxis}`}
              style={{ ...rb, opacity: (sel && p.extrudeCount > 0) ? 1 : 0.35, ...accentRing("#3b82f6"), color: "#93c5fd", fontWeight: 600 }}>
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
            style={{ display: "block", width: 140, height: 140, borderRadius: 3, border: "1px solid #342f2a", background: "#151311", imageRendering: "pixelated" }} />
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
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={p.onSavePrefab} style={{ ...rb, ...accentRing("#4ade80"), color: "#86efac", fontSize: 10 }}>Save Prefab…</button>
            <button onClick={p.onSavePrefabAs} title="Save to any folder (native dialog)" style={{ ...rb, ...accentRing("#4ade80"), color: "#86efac", fontSize: 10 }}>As…</button>
          </div>
          <div style={rbGroupLabel}>Clipboard</div>
        </div>
        <div style={rbDivider} />

        {/* Paste actions */}
        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 2 }}>
            {p.lockedPastePos && (
              <button onClick={() => { const pos = p.lockedPastePos!; p.pasteAt(pos); p.setLockedPastePos(null); }}
                style={{ ...rb, ...accentRing("#22c55e"), color: "#86efac" }}>Confirm</button>
            )}
            {p.lockedPastePos && <button onClick={() => p.setLockedPastePos(null)} style={rb}>Unlock</button>}
            <button onClick={() => p.setTool("pan")} style={rb}>Cancel</button>
          </div>
          <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
            <button onClick={() => p.setPasteIgnoreAir(!p.pasteIgnoreAir)} style={toggleStyle("pasteNoAir", p.pasteIgnoreAir, "#34d399")} title="Skip air blocks">No Air</button>
            <button onClick={() => p.setPersistPaste(!p.persistPaste)} style={toggleStyle("pasteRepeat", p.persistPaste, "#34d399")} title="Repeat on each click">Repeat</button>
            <button onClick={() => p.setPasteTerrain(!p.pasteTerrain)} style={toggleStyle("pasteTerrain", p.pasteTerrain, "#f59e0b")}>Terrain</button>
            {p.pasteTerrain && <button onClick={() => p.setPasteTerrainAbove(!p.pasteTerrainAbove)} style={toggleStyle("pasteTerrainAbove", p.pasteTerrainAbove, "#fb923c")}>{p.pasteTerrainAbove ? "Above" : "At surf"}</button>}
            <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#83786c", fontSize: 10 }}>Z</span>
              <NumberField value={p.pasteElevationOffset} onChange={p.setPasteElevationOffset} aria-label="Paste elevation offset" style={{ ...zInp, width: 44 }} />
            </span>
          </div>
          <div style={rbGroupLabel}>Place</div>
        </div>
        <div style={rbDivider} />

        {/* Transform */}
        <div style={rbGroup}>
          <button onClick={p.rotateClipboard} style={{ ...rb, ...accentRing("#a78bfa"), color: "#ddd6fe" }}>↻ Rotate 90°</button>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={p.mirrorClipboardX} style={{ ...rb, ...accentRing("#a78bfa"), color: "#ddd6fe" }}>↔ Flip X</button>
            <button onClick={p.mirrorClipboardY} style={{ ...rb, ...accentRing("#a78bfa"), color: "#ddd6fe" }}>↕ Flip Y</button>
          </div>
          <div style={rbGroupLabel}>Transform</div>
        </div>
        <div style={rbDivider} />

        {/* Paste mode */}
        <div style={rbGroup}>
          <div style={{ display: "flex", gap: 2 }}>
            {(["normal","scatter","array"] as const).map(m => {
              // Scatter distributes N copies *inside a selection rectangle* — with no selection it
              // has nowhere to place, and clicking the map would silently do nothing.
              const needsSel = m === "scatter" && !p.rawBounds;
              return (
                <button
                  key={m}
                  onClick={() => p.setPasteMode(m)}
                  disabled={needsSel}
                  title={needsSel ? "Scatter needs a selection to place copies into — select a region first" : undefined}
                  style={p.pasteMode === m
                    ? rbActive("#7dd3fc")
                    : { ...rb, opacity: needsSel ? 0.4 : 1, cursor: needsSel ? "not-allowed" : "pointer" }}
                >
                  {m === "normal" ? "1×" : m === "scatter" ? "Scatter" : "Array"}
                </button>
              );
            })}
          </div>
          {p.pasteMode === "scatter" && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#83786c", fontSize: 10 }}>Count</span>
              <NumberField min={1} max={100} value={p.scatterCount}
                onChange={p.setScatterCount} aria-label="Scatter count"
                style={{ ...zInp, width: 44 }} />
            </div>
          )}
          {p.pasteMode === "array" && (
            <div style={{ display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap", maxWidth: 200 }}>
              <span style={{ color:"#83786c",fontSize:10 }}>Cols</span>
              <NumberField min={1} max={20} value={p.arrayCols} onChange={p.setArrayCols} aria-label="Array columns" style={{ ...zInp, width: 38 }} />
              <span style={{ color:"#83786c",fontSize:10 }}>Rows</span>
              <NumberField min={1} max={20} value={p.arrayRows} onChange={p.setArrayRows} aria-label="Array rows" style={{ ...zInp, width: 38 }} />
              <span style={{ color:"#83786c",fontSize:10 }}>SpX</span>
              <NumberField min={0} value={p.arraySpacingX} onChange={p.setArraySpacingX} aria-label="Array X spacing" style={{ ...zInp, width: 38 }} />
              <span style={{ color:"#83786c",fontSize:10 }}>SpY</span>
              <NumberField min={0} value={p.arraySpacingY} onChange={p.setArraySpacingY} aria-label="Array Y spacing" style={{ ...zInp, width: 38 }} />
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
    <div className="eden-ribbon" style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
      background: `radial-gradient(320px 60px at 50% 0%, rgba(${EDEN_TEAL},.22) 0%, rgba(0,0,0,0) 100%), #100f0d`,
      borderBottom: "1px solid #322d28",
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
        .zr-thumb::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none; pointer-events: all; width: 10px; height: 10px;
          border-radius: 50%; cursor: pointer; margin-top: -3px;
          background: linear-gradient(180deg, rgb(235,226,220) 0%, rgb(175,161,150) 100%);
          box-shadow: inset 0 0 0 1px rgba(0,0,0,.5), 0 1px 1px rgba(0,0,0,.4);
        }
        .zr-thumb::-webkit-slider-runnable-track { height: 4px; }
        .eden-ribbon button:focus-visible, .eden-ribbon select:focus-visible, .eden-ribbon input:focus-visible {
          outline: 1px solid ${EDEN_TEAL_READABLE}; outline-offset: 1px;
        }
      `}</style>
      {/* Tab row */}
      <div style={{ height: TAB_BAR_HEIGHT, display: "flex", alignItems: "flex-end" }}>

        {/* App button — subtle violet tint (distinct from File amber) */}
        <div ref={appMenuRef} style={{ position: "relative", flexShrink: 0, alignSelf: "stretch" }}>
          <button
            onClick={() => { setAppMenuOpen(v => !v); setFileMenuOpen(false); }}
            style={{
              height: "100%", border: "none", cursor: "pointer", padding: "0 10px 0 8px",
              background: appMenuOpen
                ? "linear-gradient(180deg, rgba(139,92,246,0.34) 0%, rgba(139,92,246,0.10) 100%)"
                : "linear-gradient(180deg, rgba(139,92,246,0.16) 0%, rgba(139,92,246,0.04) 100%)",
              display: "flex", alignItems: "center", gap: 6,
              boxShadow: `inset -1px 0 0 rgba(139,92,246,${appMenuOpen ? 0.35 : 0.18}), 0 .5px .5px rgba(255,255,255,.12)`,
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
              <button style={mi} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setAppMenuOpen(false); p.setShowHelp(true); }}>? Help <span style={wipBadge({ fontSize: 9, padding: "0 4px", marginLeft: 4, verticalAlign: "middle" })}>WIP</span></button>
              <button style={mi} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setAppMenuOpen(false); p.setShowAbout(true); }}>ℹ About VuencEdit</button>
              <div style={{ height: 1, background: "#312c28", margin: "3px 0" }} />
              <button style={{ ...mi, color: "#f87171" }} onMouseEnter={miHover} onMouseLeave={miLeave} onClick={() => { setAppMenuOpen(false); p.closeWorld(); }}>✕ Close World</button>
            </div>
          )}
        </div>

        {/* File ▾ — amber tinted */}
        <div ref={fileMenuRef} style={{ position: "relative", flexShrink: 0, alignSelf: "stretch" }}>
          <button
            onClick={() => { setFileMenuOpen(v => !v); setAppMenuOpen(false); setShowRecentSub(false); setShowExportSub(false); }}
            style={{
              height: "100%", border: "none", cursor: "pointer", padding: "0 12px", outline: "none",
              background: fileMenuOpen
                ? "linear-gradient(180deg, rgba(245,158,11,0.30) 0%, rgba(245,158,11,0.08) 100%)"
                : "linear-gradient(180deg, rgba(245,158,11,0.14) 0%, rgba(245,158,11,0.03) 100%)",
              color: fileMenuOpen ? "#fcd34d" : "#c4963c",
              fontSize: 12, fontWeight: 600,
              borderBottom: `2px solid ${fileMenuOpen ? "#f59e0b" : "rgba(245,158,11,0.35)"}`,
              boxShadow: `inset -1px 0 0 rgba(245,158,11,${fileMenuOpen ? 0.3 : 0.15}), 0 .5px .5px rgba(255,255,255,.12)`,
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
                <div style={{ background: "#0c0b0a", borderTop: "1px solid #312c28", borderBottom: "1px solid #312c28", margin: "2px 0" }}>
                  {p.recentWorlds.length === 0 ? <div style={{ ...mi, color: "#61584f", cursor: "default" }}>No recent worlds</div>
                    : p.recentWorlds.map(r => (
                      <button key={r.path} style={{ ...mi, paddingLeft: 20, paddingTop: 5, paddingBottom: 5 }}
                        onMouseEnter={miHover} onMouseLeave={miLeave}
                        onClick={() => { setFileMenuOpen(false); setShowRecentSub(false); p.openFileAt(r.path); }} title={r.path}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 210 }}>{r.name}</div>
                        <div style={{ fontSize: 10, color: "#83786c" }}>{timeAgo(r.timestamp)}</div>
                      </button>
                    ))}
                </div>
              )}
              <div style={{ height: 1, background: "#312c28", margin: "3px 0" }} />
              <button style={{ ...mi, display: "flex", justifyContent: "space-between", opacity: (!p.sourcePath || p.saving) ? 0.35 : 1, cursor: (!p.sourcePath || p.saving) ? "not-allowed" : "pointer" }}
                title={!p.sourcePath ? "This world has never been saved to a file — use Save As…" : undefined}
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
                <span style={{ color: p.saveCompressed ? "#fcd34d" : "#afa69d" }}>Compressed</span>
              </label>
              <div style={{ height: 1, background: "#312c28", margin: "3px 0" }} />
              <button style={{ ...mi, display: "flex", justifyContent: "space-between" }} onMouseEnter={miHover} onMouseLeave={miLeave}
                onClick={() => setShowExportSub(v => !v)}>
                <span>Export</span><span style={{ fontSize: 10 }}>{showExportSub ? "▴" : "▾"}</span>
              </button>
              {showExportSub && (
                <div style={{ background: "#0c0b0a", borderTop: "1px solid #312c28", borderBottom: "1px solid #312c28", margin: "2px 0" }}>
                  <button style={{ ...mi, paddingLeft: 20 }} onMouseEnter={miHover} onMouseLeave={miLeave}
                    onClick={() => { if (p.exporting) return; setFileMenuOpen(false); setShowExportSub(false); p.exportPng(); }}>
                    {p.exporting ? "Exporting…" : "Export PNG"}
                  </button>
                  {p.world && (
                    <button style={{ ...mi, paddingLeft: 20, display: "flex", alignItems: "center", gap: 4 }} onMouseEnter={miHover} onMouseLeave={miLeave}
                      onClick={() => { if (p.exportingObj) return; setFileMenuOpen(false); setShowExportSub(false); p.exportObj(); }}>
                      {p.exportingObj ? "Exporting…" : "Export OBJ…"} <span style={expBadge()}>exp</span>
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
                Import Schematic… <span style={expBadge()}>exp</span>
              </button>}
              <div style={{ height: 1, background: "#312c28", margin: "3px 0" }} />
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
        <div style={{ width: 1, background: "#322d28", margin: "5px 6px", alignSelf: "stretch" }} />

        {/* QAT — Pan, Select, Undo, Redo (between File▾ and tabs for easy reach) */}
        {(["pan","select"] as const).map(t => (
          <button key={t} title={t === "pan" ? "Pan (Space)" : "Select (S)"} onClick={() => p.setTool(t)}
            style={{
              height: TAB_BAR_HEIGHT - 5, alignSelf: "flex-end",
              border: "none", cursor: "pointer", padding: "0 7px",
              background: p.tool === t
                ? "linear-gradient(180deg, rgba(59,130,246,0.32) 0%, rgba(59,130,246,0.08) 100%)"
                : "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
              color: p.tool === t ? "#93c5fd" : "#83786c",
              display: "flex", alignItems: "center", gap: 4, fontSize: 11,
              fontWeight: p.tool === t ? 600 : 400, outline: "none",
              borderRadius: "4px 4px 0 0",
              borderTop: `1px solid ${p.tool === t ? "rgba(59,130,246,0.7)" : "transparent"}`,
              boxShadow: p.tool === t ? "inset 0 1px 0 rgba(255,255,255,.1)" : "none",
              marginLeft: 1, marginRight: 1, marginBottom: 0,
            }}>
            {t === "pan" ? <><PanCursorIcon /><span>Pan</span></> : <><span style={{ fontSize: 13 }}>⬚</span><span>Sel</span></>}
          </button>
        ))}

        <div style={{ width: 1, background: "#322d28", margin: "6px 3px 4px", alignSelf: "stretch" }} />

        <button title={`Undo (⌘Z) · ${p.undoDepth} available`}
          onClick={p.handleUndo} disabled={p.undoDepth === 0}
          onMouseEnter={e => { if (p.undoDepth > 0) e.currentTarget.style.background = `rgba(${EDEN_TEAL},0.16)`; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          style={{
            height: TAB_BAR_HEIGHT - 5, alignSelf: "flex-end",
            border: "none", cursor: p.undoDepth === 0 ? "not-allowed" : "pointer",
            padding: "0 6px", background: "transparent", outline: "none",
            borderRadius: 4,
            color: p.undoDepth === 0 ? "#4b443d" : "#83786c",
            display: "flex", alignItems: "center", gap: 2, fontSize: 13,
            marginLeft: 1, marginRight: 1, marginBottom: 3,
            transition: "background .1s",
          }}>
          <span>↩</span>
          {p.undoDepth > 0 && <span style={{ fontSize: 9, fontVariantNumeric: "tabular-nums", color: "#61584f", minWidth: 10 }}>{p.undoDepth}</span>}
        </button>
        <button title={`Redo (⌘⇧Z) · ${p.redoDepth} available`}
          onClick={p.handleRedo} disabled={p.redoDepth === 0}
          onMouseEnter={e => { if (p.redoDepth > 0) e.currentTarget.style.background = `rgba(${EDEN_TEAL},0.16)`; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          style={{
            height: TAB_BAR_HEIGHT - 5, alignSelf: "flex-end",
            border: "none", cursor: p.redoDepth === 0 ? "not-allowed" : "pointer",
            padding: "0 6px", background: "transparent", outline: "none",
            borderRadius: 4,
            color: p.redoDepth === 0 ? "#4b443d" : "#83786c",
            display: "flex", alignItems: "center", gap: 2, fontSize: 13,
            marginLeft: 1, marginRight: 1, marginBottom: 3,
            transition: "background .1s",
          }}>
          <span>↪</span>
          {p.redoDepth > 0 && <span style={{ fontSize: 9, fontVariantNumeric: "tabular-nums", color: "#61584f", minWidth: 10 }}>{p.redoDepth}</span>}
        </button>

        <div style={{ width: 1, background: "#322d28", margin: "6px 4px 4px", alignSelf: "stretch" }} />

        {/* Permanent tabs */}
        {(["home","draw","insert","view"] as RibbonTab[]).map(id => (
          <button key={id} style={tabStyle(id)} onClick={() => setActiveTab(id)}>
            {id === "home" ? "Home" : id === "draw" ? "Draw" : id === "insert" ? "Insert" : "View"}
          </button>
        ))}

        {/* Context group — 3D (only while the fly-through pane is showing) */}
        {p.showSlicePanels && p.enable3dPane && (<>
          <div style={{ width: 1, background: "#292622", margin: "6px 2px 4px", alignSelf: "stretch" }} />
          <button style={tabStyle("3d","#38bdf8")} onClick={() => setActiveTab("3d")}
            title="3D fly-view: building, lighting, and textures">◈ 3D</button>
          <div style={{ width: 1, background: "#292622", margin: "6px 2px 4px", alignSelf: "stretch" }} />
        </>)}

        {/* Context group — Selection (merged: selection + fill/replace) */}
        {p.rawBounds && (<>
          <div style={{ width: 1, background: "#3d2a00", margin: "6px 2px 4px", alignSelf: "stretch" }} />
          <div key={selFlash} style={{
            display: "flex", alignItems: "flex-end", position: "relative",
            animation: selFlash > 0 ? "ctxPulse 0.45s ease-out" : "none",
          }}>
            <button style={tabStyle("selection","#f59e0b")} onClick={() => setActiveTab("selection")}>◈ Selection</button>
          </div>
          <div style={{ width: 1, background: "#3d2a00", margin: "6px 2px 4px", alignSelf: "stretch" }} />
        </>)}

        {/* Context group — Clipboard */}
        {p.clipboard && (<>
          <div style={{ width: 1, background: "#0d3020", margin: "6px 2px 4px", alignSelf: "stretch" }} />
          <div key={clipFlash} style={{
            display: "flex", alignItems: "flex-end", position: "relative",
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
          <div style={{ width: 1, background: "#0d3020", margin: "6px 2px 4px", alignSelf: "stretch" }} />
        </>)}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Help button */}
        <div style={{ width: 1, background: "#322d28", margin: "5px 4px 5px 6px", alignSelf: "stretch" }} />
        <button
          onClick={() => p.setShowHelp(true)}
          title="Help & shortcuts (?)"
          onMouseEnter={e => { e.currentTarget.style.background = `rgba(${EDEN_TEAL},0.16)`; e.currentTarget.style.color = EDEN_TEAL_READABLE; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#61584f"; }}
          style={{ width: 24, height: 22, borderRadius: 4, border: "none", background: "transparent", color: "#61584f", cursor: "pointer", outline: "none", display: "flex", alignItems: "center", justifyContent: "center", alignSelf: "center", fontSize: 12, transition: "background .1s, color .1s" }}>
          ?
        </button>
        {/* Collapse toggle */}
        <div style={{ width: 1, background: "#322d28", margin: "5px 4px 5px 6px", alignSelf: "stretch" }} />
        <button
          onClick={() => p.onCollapse(!p.collapsed)}
          title={p.collapsed ? "Expand ribbon" : "Collapse ribbon"}
          onMouseEnter={e => { e.currentTarget.style.background = `rgba(${EDEN_TEAL},0.16)`; e.currentTarget.style.color = EDEN_TEAL_READABLE; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#61584f"; }}
          style={{ width: 28, height: 22, borderRadius: 4, border: "none", background: "transparent", color: "#61584f", cursor: "pointer", outline: "none", display: "flex", alignItems: "center", justifyContent: "center", alignSelf: "center", transition: "background .1s, color .1s" }}>
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
          : activeTab === "3d" ? "rgba(56,189,248,0.5)"
          : "#37322d";
        const scrollBtnStyle: React.CSSProperties = {
          position: "absolute", top: 0, bottom: 0, width: 20, zIndex: 10,
          border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, color: "#afa69d",
        };
        return (
          <div style={{ position: "relative", height: bodyHeight, borderTop: `2px solid ${bodyAccent}` }}>
            {canScrollLeft && (
              <button onClick={() => ribbonScroll(-1)} style={{ ...scrollBtnStyle, left: 0, background: "linear-gradient(to right, #2e2a25 60%, transparent)" }}>◄</button>
            )}
            <div
              ref={ribbonBodyRef}
              // The ribbon body scrolls horizontally, but a trackpad/mouse wheel produces deltaY —
              // so without this, scrolling over an overflowing ribbon did nothing unless you knew
              // to hold Shift. Map vertical wheel to horizontal scroll, as tab strips normally do.
              onWheel={(e) => {
                const el = e.currentTarget;
                if (el.scrollWidth <= el.clientWidth) return;
                if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // genuine horizontal gesture
                el.scrollLeft += e.deltaY;
              }}
              style={{
              height: "100%",
              background: "linear-gradient(to bottom, #2e2a25, #091526)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,.06), inset 0 0 24px rgba(0,0,0,.35)",
              display: "flex", alignItems: "stretch",
              overflowX: "auto", overflowY: "hidden",
              scrollbarWidth: "none",
            }}>
              {activeTab === "home"      && renderHomeTab()}
              {activeTab === "draw"      && renderDrawTab()}
              {activeTab === "insert"    && renderInsertTab()}
              {activeTab === "view"      && renderViewTab()}
              {activeTab === "3d"        && renderThreeDTab()}
              {activeTab === "selection" && renderSelectionTab()}
              {activeTab === "paste"     && renderClipboardTab()}
            </div>
            {canScrollRight && (
              <button onClick={() => ribbonScroll(1)} style={{ ...scrollBtnStyle, right: 0, background: "linear-gradient(to left, #2e2a25 60%, transparent)" }}>►</button>
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
            background: "rgba(49,44,40,0.6)",
            transition: "background 0.15s",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(59,130,246,0.5)")}
          onMouseLeave={e => (e.currentTarget.style.background = "rgba(49,44,40,0.6)")}
        />
      )}

      {/* Block/filter picker portal — renders outside overflow:hidden */}
      {openPicker && createPortal(
        <div ref={pickerPortalRef} style={{
          position: "fixed", top: openPicker.top, left: openPicker.left,
          zIndex: 9999, background: "#1e1b18", border: "1px solid #4b443d",
          borderRadius: 6, padding: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.8)",
        }}>
          {(openPicker.type === "block-draw" || openPicker.type === "block-fill") ? (
            <BlockPaintPicker mode="fill" blockType={p.fillBlockType} paint={p.fillPaint}
              onBlockTypeChange={bt => { if (bt !== null) p.setFillBlockType(bt); }}
              onPaintChange={paint => p.setFillPaint(paint ?? 0)}
              onFill={p.fillSelection} selectionExists={!!p.rawBounds}
              texturePack={p.texturePack} />
          ) : openPicker.type === "build-3d" ? (
            <BlockPaintPicker mode="fill" blockType={p.build3dBlock} paint={p.build3dPaint}
              onBlockTypeChange={bt => { if (bt !== null) p.setBuild3dBlock(bt); }}
              onPaintChange={paint => p.setBuild3dPaint(paint ?? 0)}
              texturePack={p.texturePack} />
          ) : openPicker.type === "gradient-to" ? (
            <BlockPaintPicker mode="fill" blockType={p.gradientToBlock} paint={p.gradientToPaint}
              onBlockTypeChange={bt => { if (bt !== null) p.setGradientToBlock(bt); }}
              onPaintChange={paint => p.setGradientToPaint(paint ?? 0)}
              onFill={p.applyGradientFill} selectionExists={!!p.rawBounds}
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
