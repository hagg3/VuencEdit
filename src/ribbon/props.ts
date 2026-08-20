/**
 * The ribbon's public interface. Lives in its own module (rather than in `Ribbon.tsx`) so the tab
 * modules and `context.tsx` can import the type without a cycle back through the shell; `Ribbon.tsx`
 * re-exports everything here, so App's `import … from "./Ribbon"` is unchanged.
 */
import type { Tool, SelectionBounds, MaterializeSelectionBounds } from "../MapCanvas";
import type { SelectionInfo, ClipboardInfo, ExtrudeAxis, WorldMeta, RecentWorld } from "../types";

export type RibbonTab =
  | "home" | "draw" | "sculpt" | "insert" | "view"
  | "3d" | "selection" | "paste";

/** Top-down map view modes. "cutaway" renders (and targets edits) as if the world ended at the
 *  cap Z — the way to work on caves/interiors without the roof in the way. */
export type MapViewMode = "topdown" | "zslice" | "cutaway";

export interface RibbonProps {
  world: WorldMeta | null;
  appVersion: string;
  // World rename (now hosted by the top bar's world pill)
  renamingWorld: boolean; renameInput: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  setRenamingWorld: (v: boolean) => void;
  setRenameInput: (v: string) => void;
  onRenameBlur: (trimmed: string) => void;
  // Tool
  tool: Tool; setTool: (t: Tool) => void;
  isDrawTool: boolean; isSculptTool: boolean;
  wandMatchPaint: boolean; setWandMatchPaint: (v: boolean) => void;
  // Materialize (ungenerated chunk space → real flat terrain)
  materializeSelection: MaterializeSelectionBounds | null;
  onOpenMaterializeModal: () => void;
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
  rockNoisiness: number; setRockNoisiness: (v: number) => void;
  rockNoiseRadius: number; setRockNoiseRadius: (v: number) => void;
  rockSmoothing: number; setRockSmoothing: (v: number) => void;
  rockMeld: number; setRockMeld: (v: number) => void;
  rockFlatten: number; setRockFlatten: (v: number) => void;
  rockSink: number; setRockSink: (v: number) => void;
  rockDrape: number; setRockDrape: (v: number) => void;
  rockStrata: number; setRockStrata: (v: number) => void;
  prevToolRef: React.RefObject<Tool>;
  fillBlockType: number; fillPaint: number;
  setFillBlockType: (v: number) => void; setFillPaint: (v: number) => void;
  // Hotbar
  pinnedBlocks: ({ type: number; paint: number } | null)[];
  recentBlocks: { type: number; paint: number }[];
  hotbarHover: string | null;
  setPinnedBlocks: React.Dispatch<React.SetStateAction<({ type: number; paint: number } | null)[]>>;
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
  // Committed slice level; the drag-time display value is tab-local state (synced from this), so
  // dragging the slider re-renders only that tab. Same for sunT/lampRadius/flySpeed/renderDistance.
  zSliceZ: number; commitZSlice: (v: number) => void;
  followSurface: boolean; setFollowSurface: (v: boolean) => void;
  renderMode: "tiled" | "full" | "axo"; setRenderMode: (v: "tiled" | "full" | "axo") => void;
  axoSkew: number; setAxoSkew: (v: number) => void;
  showSlicePanels: boolean; setShowSlicePanels: (v: boolean) => void;
  enable3dPane: boolean; setEnable3dPane: (v: boolean) => void;
  // View ▸ Zoom — all three already existed on MapCanvas's ref but were keyboard-only.
  onFitMap: () => void;
  onZoomToSelection: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  // View ▸ Layout — persisted state previously reachable only through Settings.
  sidebarOpen: boolean; onToggleSidebar: () => void;
  showQuickActions: boolean; onToggleQuickActions: () => void;
  leftToolbarOpen: boolean; onToggleLeftToolbar: () => void;
  // 3D fly-view interaction (the contextual "3D" tab). Decoupled from the map's Draw/Select tools.
  mode3d: "off" | "select" | "build" | "sculpt" | "floodfill"; setMode3d: (v: "off" | "select" | "build" | "sculpt" | "floodfill") => void;
  /** Auto-orient directional blocks (ramps/wedges/doors) to the player's facing when placing in 3D build. */
  autoOrient3d: boolean; setAutoOrient3d: (v: boolean) => void;
  floodFillLimit: number; setFloodFillLimit: (v: number) => void;
  nightLighting: boolean; setNightLighting: (v: boolean) => void;
  shadows3d: boolean; setShadows3d: (v: boolean) => void;
  gpuShadows: boolean; setGpuShadows: (v: boolean) => void;
  sunT: number; commitSunT: (v: number) => void;
  lampRadius: number; commitLampRadius: (v: number) => void;
  /** Legacy (~4-tile, steep) vs Modern/"New Dawn" (~14-tile, gradual) lamp falloff. Separate from the
   *  Lamp R slider — switching profile snaps the radius to that profile's default. */
  lightingProfile: "legacy" | "modern"; commitLightingProfile: (v: "legacy" | "modern") => void;
  // 3D ▸ Camera — per-session view controls that used to live only in Settings.
  flySpeed: number; commitFlySpeed: (v: number) => void;
  renderDistance: number; commitRenderDistance: (v: number) => void;
  // Template
  templateLoaded: boolean; templatePath: string | null;
  showTemplateOverlay: boolean; setShowTemplateOverlay: (v: boolean) => void;
  /** Sign markers on the 2D map. Re-arms to ON for every world opened (App.applyLoadedWorld);
   *  `hasSigns` is false for the overwhelming majority of worlds, which grey the toggle out. */
  showSigns: boolean; setShowSigns: (v: boolean) => void; hasSigns: boolean;
  openTemplateFile: () => void;
  // Texture pack
  texturePackLoaded: boolean; texturePackPath: string | null;
  texturePack?: import("../texturePack").AtlasData | null;
  openTexturePackFile: () => void;
  unloadTexturePack: () => void;
  // Set Point — two distinct header fields: `home` (respawn) and `pos` (last-walked).
  spawnPos: { px: number; py: number } | null;
  playerPos: { px: number; py: number } | null;
  onSetSpawnAtSelection: () => void;
  onSetPlayerPosAtSelection: () => void;
  onShowWorldInfo: () => void;
  // Selection
  selection: SelectionInfo | null;
  rawBounds: SelectionBounds | null;
  setRawBounds: React.Dispatch<React.SetStateAction<SelectionBounds | null>>;
  copySelection: () => void; cutSelection: () => void;
  deleteBlocks: () => void; fillSelection: () => void;
  onSelectAll: () => void;
  onNudgeSelection: (dx: number, dy: number) => void;
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
  // Fluid Flow Toolkit
  fluidBase: 20 | 23; setFluidBase: (b: 20 | 23) => void;
  fluidIncludeExisting: boolean; setFluidIncludeExisting: (v: boolean) => void;
  onSimulateFlow: () => void;
  poolFillTargetZ: number; setPoolFillTargetZ: (z: number) => void;
  wavyWavelength: number; setWavyWavelength: (v: number) => void;
  wavyAmplitude: number; setWavyAmplitude: (v: number) => void;
  wavyMode: "existing" | "fill"; setWavyMode: (v: "existing" | "fill") => void;
  onGenerateWavySurface: () => void;
  // File ops
  sourcePath: string | null; saving: boolean;
  /** `kind` of the long operation currently running (audit C6/M14), or null. One field for what
   *  used to be three booleans; `"png" | "obj" | "json" | "vox" | "save"`. */
  longOpKind: string | null;
  saveCompressed: boolean; setSaveCompressed: (v: boolean) => void;
  backupCompressed: boolean; setBackupCompressed: (v: boolean) => void;
  recentWorlds: RecentWorld[];
  openFile: () => void; openFileAt: (path: string) => void;
  saveWorld: (path: string) => void; saveWorldAs: () => void;
  exportPng: () => void; exportObj: () => void; exportJson: () => void; exportVmf: () => void;
  enableExperimentalExport: boolean;
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
  /** Opens the onboarding coach-mark tour (`src/tour/`) — the application menu's Help pane and
   *  `HelpModal` both offer a "replay" entry point through this. */
  startTour: () => void;
  // Collapse
  collapsed: boolean; onCollapse: (v: boolean) => void;
  /** Called once on mount with a setter for the active tab, so outside chrome (the Quick Actions
   *  bar's "More…") can switch tabs without lifting `activeTab` out of the Ribbon. */
  registerTabSetter?: (fn: (t: RibbonTab) => void) => void;
}
