/**
 * The command registry's dynamic half (14.6): what each command *does* right now — its handler,
 * whether it can run (and why not), whether it's armed. Handlers were **moved** here out of the
 * ribbon tabs' JSX, not copied; a tab renders `<Cmd id>` and gets all of this through context.
 *
 * `satisfies Record<CommandId, CommandBinding>` at the bottom is one leg of the three-way lock: an
 * id in `meta.ts` without a binding here, or a binding for an id that no longer exists, is a
 * TypeScript error.
 */
import type { RibbonProps, RibbonTab } from "../ribbon/props";
import type { Tool } from "../MapCanvas";
import type { PickerKind } from "../ribbon/context";
import type { CommandId } from "./meta";
import type { CommandBinding } from "./types";

/** Ribbon-shell state that used to live inside a single tab and that a binding needs. */
export interface RibbonUiState {
  extrudeIgnoreAir: boolean; setExtrudeIgnoreAir: (v: boolean) => void;
  plantingTrees: boolean; setPlantingTrees: (v: boolean) => void;
}

export interface CommandCtx {
  p: RibbonProps;
  setActiveTab: (t: RibbonTab) => void;
  armTransientTool: (next: Tool, escapeTo: Tool) => void;
  /** Open (or close, if it's showing) the shared picker anchored on command `id`'s ribbon control. */
  togglePickerFor: (kind: PickerKind, id: CommandId) => void;
  pickerKind: PickerKind | null;
  openPalette: () => void;
  ui: RibbonUiState;
}

const NO_SEL = "Make a selection first";
const NO_CLIP = "Copy or cut something first";

const on = (v: boolean): true | string => (v ? true : "Not available right now");

export function bindCommands(c: CommandCtx): Record<CommandId, CommandBinding> {
  const { p } = c;
  const hasSel = !!p.rawBounds;
  const hasClip = !!p.clipboard;
  const sel = hasSel ? true : NO_SEL;
  const clip = hasClip ? true : NO_CLIP;
  const tool = (t: Tool, enabled: true | string = true): CommandBinding =>
    ({ run: () => p.setTool(t), armed: p.tool === t, enabled });
  const flip = (v: boolean, set: (v: boolean) => void, enabled: true | string = true): CommandBinding =>
    ({ run: () => set(!v), armed: v, enabled });
  const choose = <T,>(cur: T, v: T, set: (v: T) => void, enabled: true | string = true): CommandBinding =>
    ({ run: () => set(v), armed: cur === v, enabled });
  const act = (run: () => void, enabled: true | string = true): CommandBinding => ({ run, enabled });
  /** Settings/menus: ⌘K reveals them; `run` is never called but must exist. */
  const reveal: CommandBinding = { run: () => {}, enabled: true };
  const grow = (d: number) => () => p.setRawBounds(b => {
    if (!b) return null;
    if (d > 0) return { x1: b.x1 - 1, y1: b.y1 - 1, x2: b.x2 + 1, y2: b.y2 + 1 };
    return { x1: Math.min(b.x1 + 1, b.x2), y1: Math.min(b.y1 + 1, b.y2), x2: Math.max(b.x2 - 1, b.x1), y2: Math.max(b.y2 - 1, b.y1) };
  });
  const toggleTree = (id: string): CommandBinding => ({
    armed: p.treeTypes.includes(id), enabled: true,
    run: () => p.setTreeTypes(
      p.treeTypes.includes(id)
        ? p.treeTypes.length > 1 ? p.treeTypes.filter(x => x !== id) : p.treeTypes
        : [...p.treeTypes, id],
    ),
  });
  const picker = (kind: PickerKind, id: CommandId, enabled: true | string = true): CommandBinding =>
    ({ run: () => c.togglePickerFor(kind, id), armed: c.pickerKind === kind, enabled });
  const setPoint = (label: string, pos: { px: number; py: number } | null, field: string) =>
    `Move the ${label} (header "${field}"${pos ? `, now ${Math.round(pos.px)}, ${Math.round(pos.py)}` : ", unset"}) to the centre of the selection`;

  return {
    // ── Application menu + top bar ───────────────────────────────────────────────────────────
    "app.new": act(() => p.setShowNewWorld(true)),
    "app.open": act(() => p.openFile()),
    "app.download": act(() => p.setShowWorldBrowser(true)),
    "app.save": act(() => { if (p.sourcePath) p.saveWorld(p.sourcePath); else p.saveWorldAs(); }, p.saving ? "Saving…" : true),
    "app.saveAs": act(() => p.saveWorldAs(), p.saving ? "Saving…" : true),
    "app.exportPng": act(() => p.exportPng(), p.longOpKind ? "Another long operation is running" : true),
    "app.upload": act(() => p.setShowUploadModal(true)),
    "app.properties": act(() => p.onShowWorldInfo()),
    "app.settings": act(() => p.setShowSettings(true)),
    "app.help": act(() => p.setShowHelp(true)),
    "app.sounds": act(() => p.openSettingsTab("sounds")),
    "app.tour": act(() => p.startTour()),
    "app.diagnostics": act(() => p.setShowDiagnostics(true)),
    "app.about": act(() => p.setShowAbout(true)),
    "app.close": act(() => p.closeWorld()),
    "app.undo": act(() => p.handleUndo(), p.undoDepth > 0 ? true : "Nothing to undo"),
    "app.redo": act(() => p.handleRedo(), p.redoDepth > 0 ? true : "Nothing to redo"),
    "app.commandSearch": act(c.openPalette),
    "app.collapseRibbon": { run: () => p.onCollapse(!p.collapsed), armed: p.collapsed, enabled: true, labelOverride: p.collapsed ? "Expand Ribbon" : "Collapse Ribbon" },
    "app.compactRibbon": { run: () => p.onToggleCompact(!p.compact), armed: p.compact, enabled: true, labelOverride: p.compact ? "Full Ribbon (Labels)" : "Compact Ribbon (Command Bar)" },

    // ── Home ─────────────────────────────────────────────────────────────────────────────────
    "home.clipboard.paste": tool("paste", clip),
    "home.clipboard.copy": act(() => p.copySelection(), sel),
    "home.clipboard.cut": act(() => p.cutSelection(), sel),
    "home.clipboard.rotate": act(() => p.rotateClipboard(), clip),
    "home.clipboard.flipX": act(() => p.mirrorClipboardX(), clip),
    "home.clipboard.flipY": act(() => p.mirrorClipboardY(), clip),
    "home.clipboard.mode": { ...reveal, enabled: clip },
    "home.clipboard.modeSingle": choose(p.pasteMode, "normal", p.setPasteMode),
    "home.clipboard.modeScatter": choose(p.pasteMode, "scatter", p.setPasteMode, hasSel ? true : "Scatter needs a selection to place copies into"),
    "home.clipboard.modeArray": choose(p.pasteMode, "array", p.setPasteMode),
    "home.clipboard.skipAir": flip(p.pasteIgnoreAir, p.setPasteIgnoreAir),
    "home.clipboard.repeat": flip(p.persistPaste, p.setPersistPaste),
    "home.clipboard.followTerrain": flip(p.pasteTerrain, p.setPasteTerrain),

    "home.navigation.pan": tool("pan"),
    "home.navigation.select": tool("select"),
    "home.navigation.wand": tool("wand"),
    "home.navigation.lasso": tool("lasso"),
    "home.navigation.polyselect": tool("polyselect"),
    "home.navigation.wandMatch": {
      ...flip(p.wandMatchPaint, p.setWandMatchPaint),
      labelOverride: p.wandMatchPaint ? "Match: type + colour" : "Match: type only",
    },

    "home.selection.delete": {
      ...act(() => p.deleteBlocks(), sel),
      labelOverride: p.filterBlockType !== null ? (p.filterInvert ? "Delete Except Filter" : "Delete Filtered") : undefined,
    },
    "home.selection.fill": act(() => p.fillSelection(), sel),
    "home.selection.grow": act(grow(1), sel),
    "home.selection.shrink": act(grow(-1), sel),
    "home.selection.clear": act(() => p.setRawBounds(null), sel),

    "home.block.pick": picker("block-draw", "home.block.pick"),

    "home.setpoint.home": { ...act(() => p.onSetSpawnAtSelection(), p.selection ? true : NO_SEL), titleOverride: setPoint("respawn point", p.spawnPos, "home") },
    "home.setpoint.start": { ...act(() => p.onSetPlayerPosAtSelection(), p.selection ? true : NO_SEL), titleOverride: setPoint("last-walked player position", p.playerPos, "pos") },

    // ── Draw ─────────────────────────────────────────────────────────────────────────────────
    "draw.tools.pen": tool("pen"),
    "draw.tools.brush": tool("brush"),
    "draw.tools.line": tool("line"),
    "draw.tools.rect": tool("rect"),
    "draw.tools.ellipse": tool("ellipse"),
    "draw.tools.polygon": tool("polygon"),
    "draw.tools.spray": tool("spray"),
    "draw.tools.fill": tool("fill"),
    "draw.tools.eyedropper": { run: () => c.armTransientTool("eyedropper", "pen"), armed: p.tool === "eyedropper", enabled: true },
    "draw.brush.stabilize": flip(p.strokeStabilizer, p.setStrokeStabilizer,
      p.tool === "pen" || p.tool === "brush" || p.tool === "spray" ? true : "Applies to Pen, Brush and Spray"),
    "draw.brush.size": reveal,
    "draw.brush.shape": reveal,
    "draw.options.filled": reveal,
    "draw.options.height": reveal,
    "draw.mask.toggle": flip(p.maskEnabled, p.setMaskEnabled),
    "draw.block.pick": picker("block-draw", "draw.block.pick"),

    // ── Sculpt ───────────────────────────────────────────────────────────────────────────────
    "sculpt.tools.raise": tool("raise"),
    "sculpt.tools.lower": tool("lower"),
    "sculpt.tools.rock": tool("rock"),
    "sculpt.tools.carve": tool("carve"),
    "sculpt.tools.smooth": tool("smooth"),
    "sculpt.tools.flatten": tool("flatten"),
    "sculpt.tools.slope": tool("slope"),
    "sculpt.tools.noise": tool("noise"),
    "sculpt.tools.erode": tool("erode"),
    "sculpt.tools.thermal": tool("thermal"),
    "sculpt.tools.hydro": tool("hydro"),
    "sculpt.tools.terrace": tool("terrace"),
    "sculpt.tools.sharpen": tool("sharpen"),
    "sculpt.tools.smear": tool("smear"),
    "sculpt.tools.grab": tool("grab"),
    "sculpt.tools.stamp": tool("stamp"),
    "sculpt.brush.strength": reveal,
    "sculpt.brush.radius": reveal,
    "sculpt.brush.softness": reveal,
    "sculpt.brush.radiusDown": act(() => p.setSculptRadius(Math.max(1, p.sculptRadius - 1))),
    "sculpt.brush.radiusUp": act(() => p.setSculptRadius(Math.min(32, p.sculptRadius + 1))),
    "sculpt.brush.strengthDown": act(() => p.setSculptStrength(Math.max(1, p.sculptStrength - 1))),
    "sculpt.brush.strengthUp": act(() => p.setSculptStrength(Math.min(8, p.sculptStrength + 1))),
    "sculpt.falloff.profile": reveal,
    "sculpt.falloff.live": {
      ...flip(p.sculptAccumulate, p.setSculptAccumulate),
      titleOverride: p.sculptAccumulate
        ? "Live brush ON — terrain deforms as you drag, stamps build up on dwell (airbrush). Escape reverts the whole stroke."
        : "Live brush OFF — legacy one-shot: the swept stroke commits as a single uniform shape on release.",
    },
    "sculpt.falloff.clip": flip(p.sculptClipToSelection, p.setSculptClipToSelection),
    "sculpt.block.pick": picker("block-draw", "sculpt.block.pick"),

    // ── Insert ───────────────────────────────────────────────────────────────────────────────
    "insert.prefab.load": act(() => p.loadPrefab()),
    "insert.prefab.library": { run: () => p.onTogglePrefabLibrary(), armed: p.showPrefabLibrary, enabled: true },
    "insert.prefab.save": act(() => p.onSavePrefab(), clip),
    "insert.prefab.saveAs": act(() => p.onSavePrefabAs(), clip),
    "insert.nature.treeNormal": toggleTree("normal"),
    "insert.nature.treeTerrain": toggleTree("terrain"),
    "insert.nature.treePine": toggleTree("pine"),
    "insert.nature.treeTallPine": toggleTree("tall_pine"),
    "insert.nature.density": reveal,
    "insert.nature.grassOnly": flip(p.smartPlacement, p.setSmartPlacement),
    "insert.nature.plant": {
      enabled: c.ui.plantingTrees ? "Planting…" : p.selection ? true : NO_SEL,
      labelOverride: c.ui.plantingTrees ? "Planting…" : undefined,
      titleOverride: `Plant trees across the selection at ${p.treeDensity}% density`,
      run: () => {
        c.ui.setPlantingTrees(true);
        Promise.resolve(p.onGenerateTrees(p.treeTypes, Math.pow(p.treeDensity / 100, 2) * 0.20, p.leafPaints, p.smartPlacement))
          .finally(() => c.ui.setPlantingTrees(false));
      },
    },
    "insert.fluids.fluid": reveal,
    "insert.fluids.resume": flip(p.fluidIncludeExisting, p.setFluidIncludeExisting),
    "insert.fluids.simulate": act(() => p.onSimulateFlow(), p.selection ? true : NO_SEL),
    "insert.fluids.poolFill": {
      run: () => c.armTransientTool("poolfill", "select"), armed: p.tool === "poolfill",
      enabled: p.selection ? true : NO_SEL, labelOverride: p.tool === "poolfill" ? "Click a floor…" : undefined,
    },
    "insert.fluids.wavyMode": {
      run: () => p.setWavyMode(p.wavyMode === "existing" ? "fill" : "existing"), enabled: true,
      labelOverride: p.wavyMode === "existing" ? "Existing" : "Fill dry",
      titleOverride: p.wavyMode === "existing"
        ? "Re-skin columns that already have this fluid on top"
        : "Also flood dry columns one block above the terrain",
    },
    "insert.fluids.wavy": act(() => p.onGenerateWavySurface(), p.selection ? true : NO_SEL),
    "insert.extent.materialize": tool("materialize"),
    "insert.extent.materializeConfirm": {
      run: () => p.onOpenMaterializeModal(),
      enabled: p.tool !== "materialize"
        ? "Click Materialize first, then drag a selection on the map"
        : p.materializeSelection ? true : "Drag a selection in the map first",
      titleOverride: "Turn the selected chunk space into real terrain",
    },
    "insert.extent.expand": act(() => { p.setShowExpandModal(true); p.setExpandResult(null); },
      p.templateLoaded ? true : "Load the Eden.eden template first (View ▸ Template)"),

    // ── View ─────────────────────────────────────────────────────────────────────────────────
    "view.mapview.topdown": choose(p.viewMode, "topdown", p.setViewMode),
    "view.mapview.zslice": choose(p.viewMode, "zslice", p.setViewMode),
    "view.mapview.cutaway": choose(p.viewMode, "cutaway", p.setViewMode),
    // Tiled is the only render mode now — always armed, nothing to switch.
    "view.render.tiled": { run: () => {}, armed: true, enabled: true },
    "view.render.relief": { run: () => p.setReliefShading(!p.reliefShading), armed: p.reliefShading, enabled: true },
    "view.zoom.fit": act(() => p.onFitMap()),
    "view.zoom.selection": act(() => p.onZoomToSelection(), sel),
    "view.zoom.in": act(() => p.onZoomIn()),
    "view.zoom.out": act(() => p.onZoomOut()),
    "view.layout.swap": { run: () => p.onSwapViews(), armed: p.swapped, enabled: true },
    "view.layout.reset": act(() => p.onResetWindows()),
    "view.windows.view3d": {
      run: () => p.onToggle3dWindow(), armed: p.view3dWindowOpen, enabled: true,
      labelOverride: p.swapped ? "Map" : undefined,
      titleOverride: p.swapped ? "The map window (the 3D view is the main pane)" : undefined,
    },
    "view.windows.tools": { run: () => p.onToggleToolsWindow(), armed: p.toolsWindowOpen, enabled: true },
    "view.windows.hotbar": { run: () => p.onToggleHotbarWindow(), armed: p.hotbarWindowOpen, enabled: true },
    "view.windows.lens": { run: () => p.onToggleLensWindow(), armed: p.lensWindowOpen, enabled: true },
    "view.windows.sidebar": { run: () => p.onToggleSidebar(), armed: p.sidebarOpen, enabled: true },
    "view.windows.signs": {
      run: () => p.setShowSigns(!p.showSigns), armed: p.showSigns && p.hasSigns,
      enabled: p.hasSigns ? true : "This world has no signs. Signs are written by the game; VuencEdit reads and shows them but can't place them.",
    },
    "view.template.load": { ...act(() => p.openTemplateFile()), labelOverride: p.templateLoaded ? "Change Template…" : undefined, shortOverride: p.templateLoaded ? "Change…" : undefined },
    "view.template.overlay": {
      ...flip(p.showTemplateOverlay, p.setShowTemplateOverlay, p.templateLoaded ? true : "Load the template first"),
      labelOverride: p.showTemplateOverlay ? "Overlay" : undefined,
    },
    "view.textures.load": { ...act(() => p.openTexturePackFile()), labelOverride: p.texturePackLoaded ? "Change Texture Pack…" : undefined, shortOverride: p.texturePackLoaded ? "Change…" : undefined },
    "view.textures.unload": { ...act(() => p.unloadTexturePack(), on(p.texturePackLoaded)) },

    // ── 3D ───────────────────────────────────────────────────────────────────────────────────
    "3d.mode.camera": choose(p.mode3d, "off", p.setMode3d),
    "3d.mode.select": choose(p.mode3d, "select", p.setMode3d),
    "3d.mode.build": choose(p.mode3d, "build", p.setMode3d),
    "3d.mode.sculpt": choose(p.mode3d, "sculpt", p.setMode3d),
    "3d.mode.floodfill": choose(p.mode3d, "floodfill", p.setMode3d),
    "3d.mode.autoOrient": flip(p.autoOrient3d, p.setAutoOrient3d),
    "3d.camera.hud": flip(p.show3dHud, p.setShow3dHud),
    "3d.camera.grid": flip(p.show3dGrid, p.setShow3dGrid),
    "3d.block.pick": picker("build-3d", "3d.block.pick"),
    "3d.camera.flySpeed": reveal,
    "3d.camera.distance": reveal,
    "3d.lighting.night": flip(p.nightLighting, p.setNightLighting),
    "3d.lighting.shadows": { ...flip(p.shadows3d, p.setShadows3d, p.gpuShadows ? "Overridden by GPU Shadows" : true), armed: p.shadows3d && !p.gpuShadows },
    "3d.lighting.gpuShadows": flip(p.gpuShadows, p.setGpuShadows),
    "3d.lighting.legacy": choose(p.lightingProfile, "legacy", p.commitLightingProfile, p.nightLighting ? true : "Turn on Night Lighting first"),
    "3d.lighting.modern": choose(p.lightingProfile, "modern", p.commitLightingProfile, p.nightLighting ? true : "Turn on Night Lighting first"),

    // ── Selection ────────────────────────────────────────────────────────────────────────────
    "selection.modify.selectAll": act(() => p.onSelectAll()),
    "selection.zrange.range": reveal,
    "selection.move.mode": reveal,
    "selection.move.left": act(() => p.onNudgeSelection(-1, 0), sel),
    "selection.move.up": act(() => p.onNudgeSelection(0, -1), sel),
    "selection.move.down": act(() => p.onNudgeSelection(0, 1), sel),
    "selection.move.right": act(() => p.onNudgeSelection(1, 0), sel),
    "selection.fill.write": picker("block-fill", "selection.fill.write"),
    "selection.fill.fade": picker("gradient-to", "selection.fill.fade"),
    "selection.fill.axis": reveal,
    "selection.fill.includeAir": flip(p.gradientIncludeAir, p.setGradientIncludeAir),
    "selection.fill.gradient": act(() => p.applyGradientFill(), sel),
    "selection.replace.filter": picker("filter", "selection.replace.filter"),
    "selection.replace.invert": flip(p.filterInvert, p.setFilterInvert),
    "selection.replace.clear": act(() => { p.setFilterBlockType(null); p.setFilterPaint(null); p.setFilterInvert(false); }),
    "selection.extrude.axis": reveal,
    "selection.extrude.skipAir": flip(c.ui.extrudeIgnoreAir, c.ui.setExtrudeIgnoreAir),
    "selection.extrude.run": {
      run: () => p.onExtrude(c.ui.extrudeIgnoreAir),
      enabled: !p.selection ? NO_SEL : p.extrudeCount === 0 ? "Set the number of copies above 0" : true,
      labelOverride: `Extrude ${p.extrudeAxis}`,
      titleOverride: `Repeat the selection ${p.extrudeCount}× along ${p.extrudeAxis}`,
    },

    // ── Clipboard ────────────────────────────────────────────────────────────────────────────
    "paste.place.confirm": {
      run: () => { const pos = p.lockedPastePos; if (pos) { p.pasteAt(pos); p.setLockedPastePos(null); } },
      enabled: p.lockedPastePos ? true : "Click the map once to lock a position first",
      titleOverride: "Place the clipboard at the locked position",
    },
    "paste.place.unlock": act(() => p.setLockedPastePos(null), p.lockedPastePos ? true : "No position is locked"),
    "paste.place.offset": reveal,
    "paste.place.raise": act(() => p.setPasteElevationOffset(p.pasteElevationOffset + 1), clip),
    "paste.place.lower": act(() => p.setPasteElevationOffset(p.pasteElevationOffset - 1), clip),
    "paste.place.repeatStep": act(() => {}, "Press . on the map while pasting"),
    "paste.mode.pattern": reveal,
    "paste.options.above": {
      ...flip(p.pasteTerrainAbove, p.setPasteTerrainAbove, p.pasteTerrain ? true : "Turn on Follow terrain first"),
      labelOverride: p.pasteTerrainAbove ? "Above" : "At surf",
      titleOverride: p.pasteTerrainAbove ? "Sit one block above each column's surface" : "Replace each column's surface block",
    },
  } satisfies Record<CommandId, CommandBinding>;
}
