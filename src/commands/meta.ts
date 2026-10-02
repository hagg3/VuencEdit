/**
 * The command registry's static half (UI redesign r3, 14.6): every command the ribbon, the
 * application menu and the keyboard expose — label, icon, family hue, ribbon path, shortcut, kind.
 * Pure data (type-only imports), so the drift tests and Help load it in node.
 *
 * **The three-way lock** (commands sub-plan §4): `CommandId` is `keyof` this object;
 * `bind.ts` must `satisfies Record<CommandId, CommandBinding>`; ribbon tabs may only render a
 * command through `ribbon/Cmd.tsx` (lint). Add a command here, bind it, render it with `<Cmd id>`.
 *
 * ⚠️ `handledBy: "legacy-keydown"` means the chord is implemented in App's global keydown handler,
 * not dispatched by the registry — it's listed here so Help and the collision test see it. Moving
 * those onto registry dispatch is a ROADMAP Stage 6 follow-up. Only ⌘K is registry-dispatched.
 */
import type { IconName } from "../ribbon/icons";
import type { RibbonTab } from "../ribbon/props";
import type { Tool } from "../MapCanvas";
import type { Chord } from "./keys";
import type { WinId } from "../windows/windowGeometry";

export type CommandFamily = "primary" | "warm" | "selection" | "clipboard" | "violet" | "danger";

/**
 * - `action` runs once. `tool` arms a map tool (`tool` names it). `toggle` flips/chooses a state
 *   (armed = on). `picker` opens the block/paint picker. `menu` opens a dropdown (⌘K reveals it).
 * - `setting` is a slider/field/segment: ⌘K never "runs" it — ↵ and Tab both reveal and focus.
 */
export type CommandKind = "action" | "tool" | "toggle" | "setting" | "picker" | "menu";

export type CommandPath =
  | { tab: RibbonTab; group: string }
  /** A context panel (Stage 16.6) — the control lives in a mode-driven floating panel, not a ribbon
   *  group. Only ever an `also` placement (the command's `path` stays on a tab); ⌘K reveal flashes
   *  the panel while it is showing. */
  | { panel: WinId }
  | { menu: "app" | "topbar" | "keyboard" };

/** Help's shortcut-table sections, in display order. */
export const HELP_SECTIONS = [
  "Navigation", "Tools", "Sculpt", "Blocks", "Editing", "Paste mode", "3D pane", "Layout & windows", "File", "General",
] as const;
export type HelpSection = typeof HELP_SECTIONS[number];

export interface CommandMeta {
  /** The ⌘K / Help name — specific enough to read without the ribbon around it. */
  label: string;
  /** The ribbon's own (shorter) label, where the group already supplies context ("Grow" in
   *  Home › Selection is "Grow Selection" in ⌘K). */
  short?: string;
  icon?: IconName;
  family?: CommandFamily;
  /** Static tooltip. A binding's disabled reason replaces it while disabled. */
  title?: string;
  path: CommandPath;
  /** Other groups that render this same command (Copy on Home *and* Selection). ⌘K shows `path`;
   *  reveal prefers a placement on the tab that's already active. */
  also?: readonly CommandPath[];
  kind: CommandKind;
  keys?: readonly Chord[];
  handledBy?: "registry" | "legacy-keydown";
  /** For `kind: "tool"`: the MapCanvas `Tool` it arms (checked against `TOOL_LABELS`). */
  tool?: Tool;
  /** Search synonyms. */
  keywords?: readonly string[];
  /** Help row. Commands with `keys` but no `help` still show, under their tab's label. */
  help?: { section: HelpSection; text?: string };
}

const L = "legacy-keydown" as const;
const k = (key: string, scope: Chord["scope"] = "global", extra?: Partial<Chord>): Chord => ({ key, scope, ...extra });
const mod = (key: string, extra?: Partial<Chord>): Chord => ({ key, mod: true, scope: "global", ...extra });
const alt = (code: string): Chord => ({ code, alt: true, scope: "global" });

const home = (group: string) => ({ tab: "home", group }) as const;
const draw = (group: string) => ({ tab: "draw", group }) as const;
const sculpt = (group: string) => ({ tab: "sculpt", group }) as const;
const insert = (group: string) => ({ tab: "insert", group }) as const;
const view = (group: string) => ({ tab: "view", group }) as const;
const d3 = (group: string) => ({ tab: "3d", group }) as const;
const sel = (group: string) => ({ tab: "selection", group }) as const;
const panel = (id: WinId) => ({ panel: id }) as const;
const clip = (group: string) => ({ tab: "paste", group }) as const;
const APP = { menu: "app" } as const;
const TOPBAR = { menu: "topbar" } as const;

/** Sculpt tool metas — one per tool, sharing a shape. Titles match `ribbon/sculptTools.ts`. */
const sculptTool = (tool: Tool, label: string, icon: IconName, title: string): CommandMeta => ({
  label, icon, family: "warm", title, path: sculpt("tools"), also: [panel("buildslot")], kind: "tool", tool, keywords: ["sculpt"],
});

export const COMMAND_META = {
  // ── Application menu + top bar ────────────────────────────────────────────────────────────
  "app.new": { label: "New World…", icon: "new", path: APP, kind: "action", keys: [mod("n")], handledBy: L, help: { section: "File", text: "New world" } },
  "app.open": { label: "Open…", icon: "open", path: APP, kind: "action", keys: [mod("o")], handledBy: L, help: { section: "File", text: "Open world" } },
  "app.download": { label: "Download from Server…", icon: "download", path: APP, kind: "action", keywords: ["browse", "server", "world browser"] },
  "app.save": { label: "Save", icon: "save", path: APP, kind: "action", keys: [mod("s")], handledBy: L, help: { section: "File" } },
  "app.saveAs": { label: "Save As…", icon: "saveAs", path: APP, kind: "action", keys: [mod("s", { shift: true })], handledBy: L, help: { section: "File" } },
  "app.exportPng": { label: "Export PNG…", icon: "export", path: APP, kind: "action", keywords: ["image", "screenshot"] },
  "app.upload": { label: "Upload to Server…", icon: "upload", path: APP, kind: "action", keywords: ["share", "publish"] },
  "app.properties": { label: "World Properties", icon: "properties", path: APP, kind: "action", keywords: ["info", "details"] },
  "app.settings": { label: "Settings…", icon: "settings", path: APP, kind: "action", keys: [mod(",")], handledBy: L, keywords: ["preferences", "options"], help: { section: "File" } },
  "app.help": { label: "Help", icon: "help", path: APP, kind: "action", keys: [k("?")], handledBy: L, keywords: ["shortcuts", "keys"], help: { section: "General", text: "Toggle the help panel" } },
  "app.sounds": { label: "Sound Settings…", icon: "settings", path: APP, kind: "action", keywords: ["sound pack", "audio", "volume", "mute", "cues"] },
  "app.tour": { label: "Guided Tour", icon: "help", path: APP, kind: "action", keywords: ["onboarding", "tutorial", "tour"] },
  "app.diagnostics": { label: "Diagnostics…", icon: "properties", path: APP, kind: "action", keywords: ["performance", "debug", "report"] },
  "app.about": { label: "About VuencEdit", icon: "about", path: APP, kind: "action" },
  "app.close": { label: "Close World", icon: "close", path: APP, kind: "action", keys: [mod("w")], handledBy: L, help: { section: "File" } },
  "app.undo": { label: "Undo", icon: "undo", path: TOPBAR, kind: "action", keys: [mod("z")], handledBy: L, help: { section: "Editing" } },
  "app.redo": { label: "Redo", icon: "redo", path: TOPBAR, kind: "action", keys: [mod("z", { shift: true }), mod("y")], handledBy: L, help: { section: "Editing" } },
  "app.commandSearch": { label: "Search Commands", icon: "search", path: TOPBAR, kind: "action", keys: [mod("k")], handledBy: "registry", keywords: ["palette", "find"], help: { section: "General", text: "Search commands (↵ runs, Tab shows it in the ribbon)" } },
  "app.collapseRibbon": { label: "Collapse / Expand Ribbon", icon: "collapse", path: TOPBAR, kind: "toggle", keywords: ["minimize", "hide ribbon"] },
  "app.compactRibbon": { label: "Compact Ribbon (Command Bar)", icon: "collapse", path: TOPBAR, kind: "toggle", keywords: ["icon ribbon", "command bar", "labels", "compact"] },

  // ── Home ───────────────────────────────────────────────────────────────────────────────────
  "home.clipboard.paste": { label: "Paste", icon: "paste", family: "clipboard", title: "Click the map to place the clipboard", path: home("clipboard"), also: [clip("place"), sel("modify")], kind: "tool", tool: "paste", keys: [mod("v")], handledBy: L, help: { section: "Editing", text: "Arm paste" } },
  "home.clipboard.copy": { label: "Copy", icon: "copy", family: "clipboard", title: "Copy the selection", path: home("clipboard"), also: [sel("modify")], kind: "action", keys: [mod("c")], handledBy: L, help: { section: "Editing", text: "Copy selection" } },
  "home.clipboard.cut": { label: "Cut", icon: "cut", family: "clipboard", title: "Copy the selection, then clear it (one undo step)", path: home("clipboard"), also: [sel("modify")], kind: "action" },
  "home.clipboard.rotate": { label: "Rotate", icon: "rotate", family: "clipboard", title: "Rotate the clipboard 90° clockwise", path: home("clipboard"), also: [clip("transform")], kind: "action" },
  "home.clipboard.flipX": { label: "Flip X", icon: "flipX", family: "clipboard", title: "Mirror the clipboard across X", path: home("clipboard"), also: [clip("transform")], kind: "action", keywords: ["mirror"] },
  "home.clipboard.flipY": { label: "Flip Y", icon: "flipY", family: "clipboard", title: "Mirror the clipboard across Y", path: home("clipboard"), also: [clip("transform")], kind: "action", keywords: ["mirror"] },
  "home.clipboard.mode": { short: "Mode", label: "Paste Mode", icon: "pasteMode", family: "clipboard", title: "Paste mode and options", path: home("clipboard"), kind: "menu" },
  "home.clipboard.modeSingle": { short: "Single", label: "Paste: Single (1×)", icon: "paste", family: "clipboard", title: "One copy per click", path: home("clipboard"), kind: "toggle" },
  "home.clipboard.modeScatter": { short: "Scatter", label: "Paste: Scatter", icon: "sparkle", family: "clipboard", title: "Distribute N copies inside the selection", path: home("clipboard"), kind: "toggle" },
  "home.clipboard.modeArray": { short: "Array", label: "Paste: Array", icon: "quad", family: "clipboard", title: "Grid of copies with fixed spacing", path: home("clipboard"), kind: "toggle" },
  "home.clipboard.skipAir": { short: "Skip air", label: "Skip Air Blocks", icon: "clear", family: "clipboard", title: "Leave existing blocks where the clipboard holds air", path: home("clipboard"), also: [clip("options")], kind: "toggle", keywords: ["no air", "ignore air"] },
  "home.clipboard.repeat": { short: "Repeat", label: "Repeat on Each Click", icon: "pasteMode", family: "clipboard", title: "Stay in paste mode after placing", path: home("clipboard"), also: [clip("options")], kind: "toggle", keywords: ["persist"] },
  "home.clipboard.followTerrain": { short: "Follow terrain", label: "Follow Terrain", icon: "topdown", family: "clipboard", title: "Place each column on the local surface instead of a fixed Z", path: home("clipboard"), also: [clip("options")], kind: "toggle", keywords: ["terrain paste"] },

  "home.navigation.pan": { label: "Pan", icon: "pan", title: "Pan the map (Space, or middle-drag anywhere)", path: home("navigation"), kind: "tool", tool: "pan", keywords: ["hand", "move view"] },
  "home.navigation.select": { label: "Select", icon: "select", family: "selection", title: "Rectangular selection", path: home("navigation"), kind: "tool", tool: "select", keys: [k("s")], handledBy: L, keywords: ["marquee", "rectangle"], help: { section: "Tools" } },
  "home.navigation.wand": { short: "Wand", label: "Magic Wand", icon: "wand", family: "selection", title: "Select connected matching blocks", path: home("navigation"), kind: "tool", tool: "wand", keys: [k("w")], handledBy: L, help: { section: "Tools", text: "Magic Wand: select connected matching surface blocks" } },
  "home.navigation.lasso": { label: "Lasso", icon: "lasso", family: "selection", title: "Drag a freeform selection", path: home("navigation"), kind: "tool", tool: "lasso", keys: [k("k")], handledBy: L, keywords: ["freeform"], help: { section: "Tools", text: "Lasso: drag a freeform selection" } },
  "home.navigation.polyselect": { label: "Polygon Select", icon: "polyselect", family: "selection", title: "Click points, close to select the shape", path: home("navigation"), kind: "tool", tool: "polyselect", keys: [k("j")], handledBy: L, help: { section: "Tools", text: "Polygon Select: click points to build a selection" } },
  "home.navigation.wandMatch": { label: "Wand: Match Colour", icon: "filter", family: "selection", title: "The wand also matches paint colour", path: home("navigation"), kind: "toggle", keywords: ["paint"] },

  "home.selection.delete": { short: "Delete", label: "Delete", icon: "delete", family: "danger", title: "Fill the selection with air (respects the Replace filter)", path: home("selection"), also: [sel("replace")], kind: "action", keys: [k("Delete", "select"), k("Backspace", "select")], handledBy: L, keywords: ["erase", "clear blocks"], help: { section: "Editing", text: "Fill the selection with air (Select tool only)" } },
  "home.selection.fill": { short: "Fill", label: "Fill Selection", icon: "fill", family: "primary", title: "Fill the selection with the active block (respects the Replace filter)", path: home("selection"), also: [sel("fill")], kind: "action", keywords: ["flood"] },
  "home.selection.grow": { short: "Grow", label: "Grow Selection", icon: "grow", family: "selection", title: "Grow the selection by one block on every side", path: home("selection"), also: [sel("modify")], kind: "action", keywords: ["expand"] },
  "home.selection.shrink": { short: "Shrink", label: "Shrink Selection", icon: "shrink", family: "selection", title: "Shrink the selection by one block on every side", path: home("selection"), also: [sel("modify")], kind: "action", keywords: ["contract"] },
  "home.selection.clear": { short: "Clear", label: "Deselect", icon: "clear", family: "danger", title: "Clear the selection", path: home("selection"), also: [sel("modify")], kind: "action", keys: [mod("d")], handledBy: L, keywords: ["clear selection", "select none"], help: { section: "Editing" } },

  "home.block.pick": { short: "Block", label: "Block…", icon: "block", title: "Choose the active block and paint", path: home("block"), kind: "picker", keywords: ["palette", "colour", "paint", "material"] },

  "home.setpoint.home": { short: "Home", label: "Set Home Point", icon: "home", title: "Move the respawn point to the centre of the selection", path: home("setpoint"), kind: "action", keywords: ["spawn", "respawn"] },
  "home.setpoint.start": { short: "Start", label: "Set Start Point", icon: "start", title: "Move the player start position to the centre of the selection", path: home("setpoint"), kind: "action", keywords: ["player", "position"] },

  // ── Draw ───────────────────────────────────────────────────────────────────────────────────
  "draw.tools.pen": { label: "Pen", icon: "pen", family: "primary", title: "Freehand, one block wide", path: draw("tools"), kind: "tool", tool: "pen", keys: [k("p")], handledBy: L, keywords: ["pencil", "draw"], help: { section: "Tools" } },
  "draw.tools.brush": { label: "Brush", icon: "brush", family: "primary", title: "Freehand at brush size", path: draw("tools"), kind: "tool", tool: "brush", keys: [k("b")], handledBy: L, help: { section: "Tools" } },
  "draw.tools.line": { label: "Line", icon: "line", family: "primary", title: "Drag from start to end", path: draw("tools"), kind: "tool", tool: "line", keys: [k("l")], handledBy: L, help: { section: "Tools" } },
  "draw.tools.rect": { short: "Rect", label: "Rectangle", icon: "rect", family: "primary", title: "Drag to draw a rectangle", path: draw("tools"), kind: "tool", tool: "rect", keys: [k("r")], handledBy: L, keywords: ["square", "box", "shape"], help: { section: "Tools" } },
  "draw.tools.ellipse": { label: "Ellipse", icon: "ellipse", family: "primary", title: "Drag to draw an ellipse", path: draw("tools"), kind: "tool", tool: "ellipse", keys: [k("e")], handledBy: L, keywords: ["circle", "shape"], help: { section: "Tools" } },
  "draw.tools.polygon": { label: "Polygon", icon: "polygon", family: "primary", title: "Click points. Esc cancels.", path: draw("tools"), kind: "tool", tool: "polygon", keys: [k("g")], handledBy: L, keywords: ["shape"], help: { section: "Tools", text: "Polygon: click points, then click the first point or double-click to close" } },
  "draw.tools.spray": { label: "Spray", icon: "spray", family: "primary", title: "Scatter blocks. Hold to build up.", path: draw("tools"), kind: "tool", tool: "spray", keywords: ["airbrush", "scatter"] },
  "draw.tools.fill": { short: "Fill", label: "Fill Bucket", icon: "bucket", family: "primary", title: "Fill connected matching blocks", path: draw("tools"), kind: "tool", tool: "fill", keys: [k("f")], handledBy: L, keywords: ["flood", "paint bucket"], help: { section: "Tools" } },
  "draw.tools.eyedropper": { label: "Eyedropper", icon: "eyedropper", family: "primary", title: "Sample a block from the map", path: draw("tools"), also: [home("navigation")], kind: "tool", tool: "eyedropper", keys: [k("i")], handledBy: L, keywords: ["pick", "sample", "pipette"], help: { section: "Tools", text: "Eyedropper: pick the block under the cursor" } },
  "draw.brush.stabilize": { short: "Stabilize", label: "Stroke Stabilizer", icon: "smooth", family: "primary", title: "Smooth out hand jitter. The brush trails the cursor slightly.", path: draw("brush"), kind: "toggle", keywords: ["smoothing", "jitter"] },
  "draw.brush.size": { label: "Brush Size", icon: "brush", family: "primary", path: draw("brush"), kind: "setting", keywords: ["density"] },
  "draw.brush.shape": { label: "Brush Shape", icon: "ellipse", family: "primary", path: draw("brush"), kind: "setting", keywords: ["square", "round"] },
  "draw.options.filled": { label: "Shape Fill", icon: "rect", family: "primary", path: draw("options"), kind: "setting", keywords: ["outline", "hollow", "filled"] },
  "draw.options.height": { label: "Draw Height", icon: "raise", family: "primary", path: draw("options"), kind: "setting", keywords: ["stack", "above", "surface"] },
  "draw.mask.toggle": { short: "Mask", label: "Draw Mask", icon: "filter", family: "primary", title: "Only draw over blocks that match the mask", path: draw("mask"), kind: "toggle", keywords: ["filter", "restrict"] },
  "draw.block.pick": { short: "Block", label: "Draw Block…", icon: "block", title: "Choose the active block and paint", path: draw("block"), kind: "picker", keywords: ["palette", "colour"] },

  // ── Sculpt ─────────────────────────────────────────────────────────────────────────────────
  "sculpt.tools.raise": sculptTool("raise", "Raise", "raise", "Drag to raise terrain"),
  "sculpt.tools.lower": sculptTool("lower", "Lower", "lower", "Drag to dig down"),
  "sculpt.tools.rock": sculptTool("rock", "Rock", "rock", "Place a rock mass fused into the terrain (Radius sets size)"),
  "sculpt.tools.carve": sculptTool("carve", "Carve", "carve", "Cut a rounded hollow into exposed terrain (Radius sets size)"),
  "sculpt.tools.smooth": sculptTool("smooth", "Smooth", "smooth", "Average neighbouring heights"),
  "sculpt.tools.flatten": sculptTool("flatten", "Flatten", "flatten", "Level terrain to the height you click"),
  "sculpt.tools.slope": sculptTool("slope", "Slope", "slope", "Flatten to a tilted plane (Slope X/Y in the Brush shape panel)"),
  "sculpt.tools.noise": sculptTool("noise", "Noise", "noise", "Add hills or mountains"),
  "sculpt.tools.erode": sculptTool("erode", "Erode", "erode", "Lower each column toward its lowest neighbour"),
  "sculpt.tools.thermal": sculptTool("thermal", "Thermal", "thermal", "Slide steep slopes into scree"),
  "sculpt.tools.hydro": sculptTool("hydro", "Hydro", "hydro", "Water erosion that carves channels"),
  "sculpt.tools.terrace": sculptTool("terrace", "Terrace", "terrace", "Cut terrain into steps of Strength blocks"),
  "sculpt.tools.sharpen": sculptTool("sharpen", "Sharpen", "sharpen", "Crisp up terrain (opposite of Smooth)"),
  "sculpt.tools.smear": sculptTool("smear", "Smear", "smear", "Drag to pull terrain along with the brush"),
  "sculpt.tools.grab": sculptTool("grab", "Grab", "grab", "Press and drag up or down to pull terrain"),
  "sculpt.tools.stamp": sculptTool("stamp", "Retexture", "stamp", "Repaint the surface by slope"),
  "sculpt.brush.strength": { label: "Sculpt Strength", icon: "sculpt", family: "warm", path: sculpt("brush"), also: [panel("buildslot")], kind: "setting" },
  "sculpt.brush.radius": { label: "Sculpt Radius", icon: "sculpt", family: "warm", path: sculpt("brush"), also: [panel("buildslot")], kind: "setting", keywords: ["size"] },
  "sculpt.brush.softness": { label: "Sculpt Softness", icon: "sculpt", family: "warm", path: sculpt("brush"), also: [panel("buildslot")], kind: "setting", keywords: ["falloff"] },
  "sculpt.brush.radiusDown": { label: "Sculpt Radius −1", icon: "shrink", family: "warm", path: sculpt("brush"), kind: "action", keys: [k("[", "sculpt")], handledBy: L, help: { section: "Sculpt", text: "Brush radius down (while a sculpt tool is armed)" } },
  "sculpt.brush.radiusUp": { label: "Sculpt Radius +1", icon: "grow", family: "warm", path: sculpt("brush"), kind: "action", keys: [k("]", "sculpt")], handledBy: L, help: { section: "Sculpt", text: "Brush radius up" } },
  "sculpt.brush.strengthDown": { label: "Sculpt Strength −1", icon: "lower", family: "warm", path: sculpt("brush"), kind: "action", keys: [k("[", "sculpt", { shift: true })], handledBy: L, help: { section: "Sculpt", text: "Strength down" } },
  "sculpt.brush.strengthUp": { label: "Sculpt Strength +1", icon: "raise", family: "warm", path: sculpt("brush"), kind: "action", keys: [k("]", "sculpt", { shift: true })], handledBy: L, help: { section: "Sculpt", text: "Strength up" } },
  "sculpt.falloff.profile": { label: "Falloff Profile", icon: "smooth", family: "warm", path: sculpt("falloff"), kind: "setting" },
  "sculpt.falloff.live": { short: "Live brush", label: "Live Brush", icon: "sparkle", family: "warm", title: "Shape terrain as you drag. Off: apply the stroke on release.", path: sculpt("falloff"), kind: "toggle", keywords: ["airbrush", "accumulate"] },
  "sculpt.falloff.clip": { short: "In selection", label: "Sculpt in Selection", icon: "select", family: "warm", title: "Only sculpt inside the selection", path: sculpt("falloff"), kind: "toggle", keywords: ["clip", "constrain"] },
  "sculpt.block.pick": { short: "Block", label: "Sculpt Block…", icon: "block", title: "Block for Rock and Retexture", path: sculpt("block"), kind: "picker" },

  // ── Insert ─────────────────────────────────────────────────────────────────────────────────
  "insert.prefab.load": { short: "Load", label: "Load Prefab…", icon: "prefab", title: "Load a .epfab prefab into the clipboard, ready to paste", path: insert("prefab"), kind: "action", keywords: ["epfab", "import"] },
  "insert.prefab.library": { short: "Library", label: "Prefab Library", icon: "prefabLibrary", title: "Browse saved prefabs in the docked sidebar", path: insert("prefab"), kind: "toggle", keywords: ["gallery"] },
  "insert.prefab.save": { short: "Save…", label: "Save Prefab…", icon: "savePrefab", family: "clipboard", title: "Save the clipboard to your prefab library", path: insert("prefab"), also: [clip("prefab")], kind: "action", keywords: ["epfab"] },
  "insert.prefab.saveAs": { short: "Save As…", label: "Save Prefab As…", icon: "save", family: "clipboard", title: "Save the clipboard to a file", path: insert("prefab"), also: [clip("prefab")], kind: "action", keywords: ["epfab"] },
  "insert.nature.treeNormal": { short: "Normal", label: "Trees: Normal", family: "primary", title: "Deciduous: trunk + dome canopy", path: insert("nature"), kind: "toggle" },
  "insert.nature.treeTerrain": { short: "Terrain", label: "Trees: Terrain", family: "primary", title: "Tall terrain tree: ragged wide canopy", path: insert("nature"), kind: "toggle" },
  "insert.nature.treePine": { short: "Pine", label: "Trees: Pine", family: "primary", title: "Conical pine: narrow 5×5 canopy", path: insert("nature"), kind: "toggle" },
  "insert.nature.treeTallPine": { short: "T. Pine", label: "Trees: Tall Pine", family: "primary", title: "Tall conical pine: wide 7×7 canopy", path: insert("nature"), kind: "toggle" },
  "insert.nature.density": { label: "Tree Density", icon: "trees", family: "primary", path: insert("nature"), kind: "setting" },
  "insert.nature.grassOnly": { short: "Grass only", label: "Trees on Grass Only", family: "primary", title: "Only plant on grass columns", path: insert("nature"), kind: "toggle", keywords: ["smart placement"] },
  "insert.nature.plant": { short: "Plant", label: "Plant Trees", icon: "trees", family: "primary", path: insert("nature"), kind: "action", keywords: ["forest", "generate"] },
  "insert.fluids.fluid": { label: "Fluid Type", icon: "water", family: "primary", path: insert("fluids"), kind: "setting", keywords: ["water", "lava"] },
  "insert.fluids.resume": { short: "Resume partials", label: "Resume Partial Fluids", family: "primary", title: "Also grow flow from partial (¾, ½, ¼) fluid blocks", path: insert("fluids"), kind: "toggle" },
  "insert.fluids.simulate": { short: "Simulate", label: "Simulate Flow", icon: "simulate", family: "primary", title: "Grow flow from every full source block already inside the selection", path: insert("fluids"), kind: "action", keywords: ["water", "lava", "flow"] },
  "insert.fluids.poolFill": { label: "Pool Fill", icon: "poolFill", family: "primary", title: "Click a floor cell in the selection to fill the basin to the target Z", path: insert("fluids"), kind: "tool", tool: "poolfill", keywords: ["water", "basin", "lake"] },
  "insert.fluids.wavyMode": { label: "Wavy Mode", family: "primary", path: insert("fluids"), kind: "toggle", keywords: ["fill dry", "existing"] },
  "insert.fluids.wavy": { short: "Wavy", label: "Wavy Surface", icon: "wavy", family: "primary", title: "Stamp a procedural ¾/½/¼ ripple pattern across the selection", path: insert("fluids"), kind: "action", keywords: ["ripple", "water"] },
  "insert.extent.materialize": { label: "Materialize", icon: "materialize", family: "warm", title: "Turn empty chunk space (holes, or past the map edge) into flat terrain", path: insert("extent"), kind: "tool", tool: "materialize", keywords: ["chunks", "grow world"] },
  "insert.extent.materializeConfirm": { short: "Materialize…", label: "Materialize Selection…", family: "warm", path: insert("extent"), kind: "action" },
  "insert.extent.expand": { short: "Expand", label: "Expand from Template…", icon: "expandWorld", path: insert("extent"), kind: "action", keywords: ["eden.eden", "grow world"] },

  // ── View ───────────────────────────────────────────────────────────────────────────────────
  "view.mapview.topdown": { short: "Top-down", label: "Top-down View", icon: "topdown", title: "Show the top block of every column", path: view("mapview"), kind: "toggle" },
  "view.mapview.zslice": { short: "Z-Slice", label: "Z-Slice View", icon: "zslice", title: "Show one horizontal layer at a time", path: view("mapview"), kind: "toggle", keywords: ["layer"] },
  "view.mapview.cutaway": { short: "Cutaway", label: "Cutaway View", icon: "cutaway", family: "primary", title: "Hide everything above the cap Z. Tools work on the exposed surface.", path: view("mapview"), kind: "toggle", keywords: ["cave", "interior", "cap"] },
  "view.render.tiled": { short: "Tiled", label: "Render: Tiled", icon: "tiled", title: "Streamed map tiles (default)", path: view("render"), kind: "toggle" },
  "view.render.relief": { short: "Relief", label: "Render: Relief", icon: "axo", family: "primary", title: "Shade slopes so hills and cliffs stand out", path: view("render"), kind: "toggle", keywords: ["axo", "isometric", "relief", "hillshade", "shading", "terrain"] },
  "view.zoom.fit": { short: "Fit", label: "Fit Map", icon: "fit", title: "Fit the whole world in the viewport", path: view("zoom"), kind: "action", keys: [mod("0"), k("Home")], handledBy: L, help: { section: "Navigation", text: "Fit map to window" } },
  "view.zoom.selection": { short: "Selection", label: "Zoom to Selection", icon: "zoomSel", path: view("zoom"), kind: "action", keys: [mod("0", { shift: true })], handledBy: L, help: { section: "Navigation" } },
  "view.zoom.in": { short: "In", label: "Zoom In", icon: "zoomIn", path: view("zoom"), kind: "action", keys: [mod("=")], handledBy: L, help: { section: "Navigation", text: "Zoom in (viewport centre)" } },
  "view.zoom.out": { short: "Out", label: "Zoom Out", icon: "zoomOut", path: view("zoom"), kind: "action", keys: [mod("-")], handledBy: L, help: { section: "Navigation", text: "Zoom out (viewport centre)" } },
  "view.layout.swap": { short: "Swap", label: "Swap Map ⇄ 3D", icon: "swap", family: "violet", title: "Make the 3D view the main pane and put the map in the window", path: view("layout"), kind: "action", keys: [{ key: "Tab", scope: "work-area" }], handledBy: L, help: { section: "Layout & windows", text: "Swap map ⇄ 3D (only while focus is on the map, the 3D view or a window title bar)" } },
  "view.layout.reset": { short: "Reset", label: "Reset Windows", icon: "resetWindows", title: "Move every floating window back to its default place", path: view("layout"), kind: "action" },
  "view.windows.view3d": { short: "3D", label: "3D View Window", icon: "pane3d", family: "violet", title: "Fly-through 3D view (experimental)", path: view("windows"), kind: "toggle", keys: [alt("Digit3")], handledBy: L, keywords: ["3d", "fly"], help: { section: "Layout & windows", text: "Show / hide the 3D view window" } },
  "view.windows.tools": { short: "Tools", label: "Tools Window", icon: "toolbar", title: "Quick access to the Pan, Select and Draw tools", path: view("windows"), kind: "toggle", keys: [alt("KeyT")], handledBy: L, help: { section: "Layout & windows", text: "Show / hide the Tools window" } },
  "view.windows.hotbar": { short: "Hotbar", label: "Hotbar Window", icon: "block", title: "Pinned (1–5) and recent (6–0) blocks", path: view("windows"), kind: "toggle", keys: [alt("KeyH")], handledBy: L, keywords: ["palette", "swatches", "recent blocks"], help: { section: "Layout & windows", text: "Show / hide the Hotbar window" } },
  "view.windows.lens": { short: "Lens", label: "Lens Window", icon: "paste", family: "clipboard", title: "Front, side and top views of the selection or paste", path: view("windows"), kind: "toggle", keys: [alt("KeyP")], handledBy: L, keywords: ["paste", "selection", "elevation", "z range", "buried", "z offset"], help: { section: "Layout & windows", text: "Show / hide the Lens (front, side and top views; appears when you select or paste)" } },
  "view.windows.sidebar": { label: "Sidebar", icon: "sidebar", title: "Docked right sidebar: Inspector / Prefabs / History", path: view("windows"), kind: "toggle", keywords: ["inspector", "history", "panel"] },
  "view.windows.signs": { short: "Signs", label: "Sign Markers", icon: "signs", title: "Show a marker on the map at each sign's position", path: view("windows"), kind: "toggle" },
  "view.template.load": { short: "Load…", label: "Load Template…", icon: "template", title: "Load the game's Eden.eden for the overlay and Insert ▸ Expand", path: view("template"), kind: "action", keywords: ["eden.eden"] },
  "view.template.overlay": { short: "Overlay", label: "Template Overlay", icon: "fullmap", family: "primary", title: "Show the template's terrain under your world (top-down view only)", path: view("template"), kind: "toggle" },
  "view.textures.load": { short: "Load…", label: "Load Texture Pack…", icon: "textures", title: "Load block textures from a ZIP of PNGs or an atlas image (experimental)", path: view("textures"), kind: "action", keywords: ["atlas"] },
  "view.textures.unload": { short: "Unload", label: "Unload Texture Pack", icon: "close", title: "Go back to flat block colours", path: view("textures"), kind: "action" },

  // ── 3D (contextual) ────────────────────────────────────────────────────────────────────────
  "3d.mode.camera": { short: "Camera", label: "3D: Camera Mode", icon: "camera", family: "violet", title: "Move the camera only", path: d3("mode"), kind: "toggle", keywords: ["orbit"] },
  "3d.mode.select": { short: "Select", label: "3D: Select Mode", icon: "select", family: "violet", title: "Click two blocks to define a 3D selection box", path: d3("mode"), kind: "toggle" },
  "3d.mode.build": { short: "Build", label: "3D: Build Mode", icon: "build", family: "primary", title: "Left-click breaks a block, right-click places one", path: d3("mode"), kind: "toggle", keywords: ["place", "break", "minecraft"] },
  "3d.mode.sculpt": { short: "Sculpt", label: "3D: Sculpt Mode", icon: "sculpt", family: "warm", title: "Hold left to sculpt under the crosshair", path: d3("mode"), kind: "toggle" },
  "3d.mode.floodfill": { short: "Flood Fill", label: "3D: Flood Fill Mode", icon: "floodfill", family: "primary", title: "Click a block face to fill the connected air", path: d3("mode"), kind: "toggle" },
  "3d.mode.autoOrient": { short: "Auto-orient", label: "3D: Auto-orient Blocks", icon: "autoOrient", family: "primary", title: "Turn ramps, wedges and doors to face you when placed", path: d3("mode"), kind: "toggle" },
  // Renamed from `3d.slot.block` in 16.6 (the contextual `slot` group became the Build slot panel).
  "3d.block.pick": { short: "Block", label: "3D Build Block…", icon: "block", title: "Block for Build and Flood Fill", path: d3("block"), kind: "picker" },
  "3d.camera.hud": { short: "HUD", label: "3D: HUD", icon: "fps", family: "violet", title: "Show the 3D view's overlays and crosshair", path: d3("camera"), kind: "toggle", keywords: ["overlay", "compass", "legend", "hide ui"] },
  "3d.camera.grid": { short: "Grid", label: "3D: Floor Grid", icon: "tiled", family: "violet", title: "Show the 3D pane's floor grid", path: d3("camera"), kind: "toggle", keywords: ["floor", "guides"] },
  "3d.camera.flySpeed": { label: "Fly Speed", icon: "flySpeed", family: "violet", path: d3("camera"), kind: "setting" },
  "3d.camera.distance": { label: "Render Distance", icon: "renderDistance", family: "violet", path: d3("camera"), kind: "setting", keywords: ["view distance", "chunks"] },
  "3d.lighting.night": { short: "Night", label: "Night Lighting", icon: "night", family: "warm", title: "Light the 3D view with lamps. Slow: rebuilds every loaded chunk.", path: d3("lighting"), kind: "toggle", keywords: ["lamps"] },
  "3d.lighting.shadows": { short: "Shadows", label: "Baked Shadows", icon: "shadows", family: "warm", title: "Baked sun shadows. Slow: rebuilds chunks, and the Sun slider reloads them.", path: d3("lighting"), kind: "toggle" },
  "3d.lighting.gpuShadows": { short: "GPU", label: "GPU Shadows", icon: "gpuShadows", family: "violet", title: "Real-time GPU shadows. Slow at high render distance. Replaces baked shadows.", path: d3("lighting"), kind: "toggle" },
  "3d.lighting.legacy": { short: "Legacy", label: "Lamp Falloff: Legacy", family: "warm", title: "Short, steep lamp light (~4 blocks). Resets Lamp R.", path: d3("lighting"), kind: "toggle" },
  "3d.lighting.modern": { short: "New Dawn", label: "Lamp Falloff: New Dawn", family: "warm", title: "Long, gradual lamp light (~14 blocks). Resets Lamp R.", path: d3("lighting"), kind: "toggle" },

  // ── Selection (contextual) ─────────────────────────────────────────────────────────────────
  "selection.modify.selectAll": { label: "Select All", icon: "selectAll", family: "selection", title: "Select the whole world", path: sel("modify"), kind: "action", keys: [mod("a")], handledBy: L, help: { section: "Editing", text: "Select whole world" } },
  "selection.zrange.range": { label: "Selection Z Range", icon: "zslice", family: "selection", path: sel("zrange"), kind: "setting", keywords: ["height", "min", "max"] },
  "selection.move.mode": { label: "Selection Move Mode", icon: "move", family: "selection", path: sel("move"), kind: "setting", keywords: ["box", "blocks"] },
  "selection.move.left": { label: "Nudge Selection Left", icon: "left", family: "selection", path: sel("move"), kind: "action", keys: [k("ArrowLeft", "select")], handledBy: L, help: { section: "Editing", text: "Nudge the selection left one block (Select tool only)" } },
  "selection.move.up": { label: "Nudge Selection Up", icon: "up", family: "selection", path: sel("move"), kind: "action", keys: [k("ArrowUp", "select")], handledBy: L, help: { section: "Editing", text: "Nudge the selection up one block (Select tool only)" } },
  "selection.move.down": { label: "Nudge Selection Down", icon: "down", family: "selection", path: sel("move"), kind: "action", keys: [k("ArrowDown", "select")], handledBy: L, help: { section: "Editing", text: "Nudge the selection down one block (Select tool only)" } },
  "selection.move.right": { label: "Nudge Selection Right", icon: "right", family: "selection", path: sel("move"), kind: "action", keys: [k("ArrowRight", "select")], handledBy: L, help: { section: "Editing", text: "Nudge the selection right one block (Select tool only)" } },
  "selection.fill.write": { label: "Fill: Write Block…", icon: "block", title: "Block for Fill, and the start of Gradient", path: sel("fill"), kind: "picker" },
  "selection.fill.fade": { label: "Gradient: Fade-to Block…", icon: "gradient", title: "End block for Gradient", path: sel("fill"), kind: "picker" },
  "selection.fill.axis": { label: "Gradient Axis", icon: "gradient", family: "primary", path: sel("fill"), kind: "setting" },
  "selection.fill.includeAir": { short: "+Air", label: "Gradient: Include Air", family: "primary", title: "Also fill air cells", path: sel("fill"), kind: "toggle" },
  "selection.fill.gradient": { short: "Gradient", label: "Gradient Fill", icon: "gradient", family: "primary", title: "Blend the Fill block into the Fade block across the selection", path: sel("fill"), kind: "action", keywords: ["blend", "dither"] },
  "selection.replace.filter": { label: "Replace Filter…", icon: "filter", title: "Fill and Delete only touch these blocks", path: sel("replace"), kind: "picker", keywords: ["match", "only"] },
  "selection.replace.invert": { short: "Invert", label: "Invert Filter", icon: "invert", family: "selection", title: "Act on everything except the filter", path: sel("replace"), kind: "toggle" },
  "selection.replace.clear": { short: "Clear", label: "Clear Filter", icon: "clear", title: "Clear the match filter", path: sel("replace"), kind: "action" },
  "selection.extrude.axis": { label: "Extrude Axis", icon: "extrude", family: "selection", path: sel("extrude"), kind: "setting" },
  "selection.extrude.skipAir": { label: "Extrude: Skip Air", family: "selection", title: "Leave existing blocks where the source cell is air", path: sel("extrude"), kind: "toggle" },
  "selection.extrude.run": { label: "Extrude", icon: "extrude", family: "selection", path: sel("extrude"), kind: "action", keywords: ["repeat", "array", "stack"] },

  // ── Clipboard (contextual) ─────────────────────────────────────────────────────────────────
  "paste.place.confirm": { short: "Confirm", label: "Confirm Paste", icon: "paste", family: "clipboard", path: clip("place"), kind: "action", keywords: ["stamp", "place"] },
  "paste.place.unlock": { short: "Unlock", label: "Unlock Paste Position", icon: "clear", title: "Release the locked position and pick again", path: clip("place"), kind: "action" },
  "paste.place.offset": { label: "Paste Z Offset", icon: "zslice", family: "clipboard", path: clip("place"), kind: "setting", keywords: ["elevation", "height"] },
  "paste.place.raise": { label: "Raise Paste 1", icon: "raise", family: "clipboard", path: clip("place"), kind: "action", keys: [k("PageUp", "paste")], handledBy: L, help: { section: "Paste mode", text: "Raise paste Z offset (⇧ = +5)" } },
  "paste.place.lower": { label: "Lower Paste 1", icon: "lower", family: "clipboard", path: clip("place"), kind: "action", keys: [k("PageDown", "paste")], handledBy: L, help: { section: "Paste mode", text: "Lower paste Z offset (⇧ = −5)" } },
  "paste.place.repeatStep": { label: "Repeat Last Paste Step", icon: "pasteMode", family: "clipboard", path: clip("place"), kind: "action", keys: [k(".", "paste")], handledBy: L, help: { section: "Paste mode", text: "Repeat paste one step in the same direction" } },
  "paste.mode.pattern": { label: "Paste Pattern", icon: "pasteMode", family: "clipboard", path: clip("mode"), kind: "setting", keywords: ["scatter", "array", "grid", "repeat"] },
  "paste.options.above": { label: "Terrain Paste: Above Surface", family: "clipboard", path: clip("options"), kind: "toggle" },
} as const satisfies Record<string, CommandMeta>;

export type CommandId = keyof typeof COMMAND_META;

export const COMMAND_IDS = Object.keys(COMMAND_META) as CommandId[];

/** Widened view for code that iterates (the `as const` literal types are too narrow to index generically). */
export function meta(id: CommandId): CommandMeta {
  return COMMAND_META[id] as CommandMeta;
}

/**
 * Keyboard and mouse gestures that aren't commands (nothing to "run"), listed so Help shows them
 * and the collision test sees their chords.
 */
export interface Gesture {
  text: string;
  section: HelpSection;
  keys?: readonly Chord[];
  /** Display instead of keycaps ("Scroll", "Middle drag"). */
  gesture?: string;
}

export const GESTURES: readonly Gesture[] = [
  { section: "Navigation", gesture: "Scroll", text: "Zoom in / out (toward cursor)" },
  { section: "Navigation", gesture: "Middle drag", text: "Pan" },
  { section: "Tools", keys: [{ key: " ", hold: true, scope: "global" }], text: "Hold to pan" },
  { section: "Sculpt", keys: [{ key: "Control", hold: true, scope: "stroke" }], text: "Invert: swap Raise and Lower for this stroke" },
  { section: "Sculpt", keys: [{ key: "Shift", hold: true, scope: "stroke" }], text: "Smooth while held (any sculpt tool except Grab)" },
  { section: "Blocks", keys: ["1", "2", "3", "4", "5"].map(key => ({ key, scope: "global" as const })), text: "Pinned hotbar slots (also in 3D Build mode)" },
  { section: "Blocks", keys: ["6", "7", "8", "9", "0"].map(key => ({ key, scope: "global" as const })), text: "Recent hotbar slots (also in 3D Build mode)" },
  { section: "Editing", keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].map(key => ({ key, shift: true, scope: "select" as const })), text: "Nudge the selection 10 blocks (Select tool only)" },
  { section: "Editing", gesture: "Drag inside selection", text: "Move it (hold ⇧ to lock to one axis)" },
  { section: "Paste mode", gesture: "Click", text: "Lock paste position (ghost turns amber)" },
  { section: "Paste mode", gesture: "Click again / Confirm", text: "Stamp paste" },
  { section: "Paste mode", keys: [{ key: "PageUp", shift: true, scope: "paste" }, { key: "PageDown", shift: true, scope: "paste" }], text: "Raise / lower the paste Z offset by 5" },
  { section: "3D pane", keys: [{ key: "z", scope: "3d" }], text: "Cycle camera: orbit → mouselook → fly" },
  { section: "3D pane", keys: ["w", "a", "s", "d", " "].map(key => ({ key, scope: "walk" as const })), text: "Move while walking (Shift to boost, wheel for speed)" },
  { section: "3D pane", gesture: "Left-click", text: "Build mode: break the block you're aiming at" },
  { section: "3D pane", gesture: "Right-click", text: "Build mode: place the build block against that face" },
  { section: "3D pane", gesture: "Hold left", text: "Sculpt mode: sculpt terrain under the cursor/crosshair" },
  { section: "Layout & windows", gesture: "Title bar", text: "Drag to move · double-click to collapse · arrows move (⇧ ×4), ⌥arrows resize, Enter collapses, Esc returns to the map" },
  { section: "General", keys: [{ key: "Escape", scope: "global" }], text: "Step back: context menu → paste lock → tool → selection" },
];
