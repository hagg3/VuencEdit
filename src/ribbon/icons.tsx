/**
 * The ribbon's icon layer — a thin map over `lucide-react`.
 *
 * ⚠️ Per-icon **named imports only**. A namespace import (`import * as Lucide`) pulls all ~1500
 * icons into the bundle; the named form tree-shakes to just the ones listed here.
 *
 * Everything the ribbon draws goes through `<Icon name=… />` so a command's glyph is decided in
 * exactly one place — the old code had three inline SVGs plus literal emoji scattered across
 * 2400 lines, and the same command had different glyphs on different tabs.
 */
import {
  Anvil, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Blend, Blocks, Box, Brush, Camera,
  ChevronDown, ChevronUp, ChevronsUpDown, Circle, CircleHelp, ClipboardPaste,
  Copy, CopyPlus, Crosshair, Cuboid, Download, Droplet, Droplets, Expand, Feather, FileInput,
  FileOutput, FilePlus, Filter, Flag, Flame, FlipHorizontal2, FlipVertical2, FolderOpen, Frame,
  Globe2, Grid2x2, Grid3x3, Hammer, Hand, History, House, Image, Info, Lasso, LayoutGrid, Layers,
  Layers2, LibraryBig, Map, Maximize, Minimize2, Minus, Moon, Mountain, Move,
  MoveHorizontal, Package, PaintBucket, PanelLeft, PanelRight, Pencil, Pentagon, Pickaxe, Pipette, Repeat,
  Replace, RotateCw, Rows3, Save, SaveAll, Scissors, Settings, Shuffle, Slash, Snowflake,
  Signpost, Sparkles, SprayCan, Square, SquareDashed, SquareSplitVertical, Stamp, Sun, Target,
  TrendingUp, Trash2, TreePine, Triangle, Undo2, Redo2, Upload, Wand2, Waves, Wind, X, ZoomIn,
  ZoomOut, Zap,
} from "lucide-react";
import type { CSSProperties } from "react";
import { ICON, ICON_TONE, ICON_DANGER, ICON_ACCENT } from "./tokens";

const MAP = {
  // Clipboard
  paste: ClipboardPaste, copy: Copy, cut: Scissors, rotate: RotateCw,
  flipX: FlipHorizontal2, flipY: FlipVertical2, pasteMode: Repeat,
  // Navigation / selection tools
  pan: Hand, select: SquareDashed, wand: Wand2, lasso: Lasso, polyselect: Pentagon,
  eyedropper: Pipette, selectAll: Frame,
  grow: Expand, shrink: Minimize2, clear: X, invert: Shuffle, move: Move,
  // Destructive / fill
  delete: Trash2, fill: PaintBucket, gradient: Blend, replace: Replace, extrude: CopyPlus,
  // Palette
  block: Blocks, palette: Grid2x2,
  // Set point
  home: House, start: Flag,
  // Draw tools
  pen: Pencil, brush: Brush, spray: SprayCan, line: Slash, rect: Square, ellipse: Circle,
  polygon: Pentagon, bucket: PaintBucket,
  // Sculpt tools
  raise: ArrowUp, lower: ArrowDown, smooth: Waves, flatten: Minus, slope: TrendingUp,
  noise: Mountain, erode: Wind, thermal: Flame, hydro: Droplets, stamp: Stamp,
  grab: Move, terrace: Rows3, sharpen: Triangle, smear: MoveHorizontal, rock: Anvil,
  carve: Pickaxe, sculpt: Mountain,
  // Insert
  prefab: Package, prefabLibrary: LibraryBig, savePrefab: Save, importFile: FileInput,
  trees: TreePine, water: Droplet, lava: Flame, materialize: Grid3x3, expandWorld: Layers2,
  // View
  topdown: Map, zslice: Layers, cutaway: SquareSplitVertical, tiled: Grid3x3, fullmap: Image,
  axo: Box, fit: Maximize, zoomIn: ZoomIn, zoomOut: ZoomOut, zoomSel: Crosshair,
  quad: LayoutGrid, pane3d: Cuboid, sidebar: PanelRight, toolbar: PanelLeft, quickActions: Rows3, signs: Signpost,
  template: Map, textures: Image,
  // 3D
  camera: Camera, build: Hammer, floodfill: Droplets, night: Moon, shadows: Sun,
  gpuShadows: Zap, autoOrient: RotateCw, flySpeed: Feather,
  renderDistance: Target,
  // Fluids
  simulate: Waves, poolFill: Droplet, wavy: Waves,
  // App menu / top bar
  undo: Undo2, redo: Redo2, help: CircleHelp, collapse: ChevronUp, expandBar: ChevronDown,
  more: ChevronsUpDown, split: ChevronDown,
  new: FilePlus, open: FolderOpen, download: Download, save: Save, saveAs: SaveAll,
  export: FileOutput, upload: Upload, properties: Info, settings: Settings, about: Info,
  close: X, history: History, filter: Filter, sparkle: Sparkles, snow: Snowflake,
  left: ArrowLeft, right: ArrowRight, up: ArrowUp, down: ArrowDown,
  // Splash / launcher
  world: Globe2,
} as const;

export type IconName = keyof typeof MAP;
export type IconTone = "default" | "accent" | "danger" | "inherit";

const TONE: Record<IconTone, string | undefined> = {
  default: ICON_TONE,
  accent: ICON_ACCENT,
  danger: ICON_DANGER,
  inherit: undefined,
};

/**
 * Sizes come from the `ICON` scale (`xs` 12 / `sm` 14 / `lg` 24) — the pre-Phase-2 code drew from
 * six magic numbers (11/12/13/14/15/26) with no constant behind any of them.
 */
export function Icon({
  name, size = ICON.sm, tone = "default", strokeWidth = 1.75, style,
}: { name: IconName; size?: number; tone?: IconTone; strokeWidth?: number; style?: CSSProperties }) {
  const C = MAP[name];
  return (
    <C
      size={size}
      strokeWidth={strokeWidth}
      color={TONE[tone] ?? "currentColor"}
      style={{ flexShrink: 0, display: "block", ...style }}
      aria-hidden="true"
    />
  );
}
