/**
 * INSERT — generate or bring content into the world.
 *
 * Prefab and Import Schematic moved off the File menu (inserting a `.schematic` puts content in
 * the world; it isn't a file operation on *your* world), Materialize moved off Home, and the
 * Fluid toolkit moved off Selection — it is selection-scoped *generation*, structurally identical
 * to Trees, which already lived here.
 */
import { useMemo, useState } from "react";
import { solveLayout, type GroupMetrics } from "../layout";
import { useRibbon } from "../context";
import {
  Badge, Caption, Col, CommandButton, FieldLabel, Group, GroupDivider, NumField, Row, Segmented,
  SliderRow, SmallButton, Swatch,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H, SMALL_H, SPACE } from "../tokens";

const SPECS: GroupMetrics[] = [
  { id: "prefab", widths: { full: 230, medium: 156, compact: 44 }, minTier: "compact", priority: 1 },
  { id: "import", widths: { full: 116, medium: 116, compact: 44 }, minTier: "medium", priority: 2 },
  { id: "nature", widths: { full: 338, medium: 240, compact: 44 }, minTier: "compact", priority: 0 },
  { id: "fluids", widths: { full: 372, medium: 250, compact: 44 }, minTier: "compact", priority: 3 },
  { id: "extent", widths: { full: 150, medium: 132, compact: 44 }, minTier: "medium", priority: 4 },
];

const LEAF_COLORS: [number, string, string][] = [
  [0, "#1eb428", "Natural (unpainted)"],
  [4, "#aaffbf", "Light green"],
  [13, "#55ff7f", "Medium light green"],
  [22, "#00ff3f", "Green"],
  [31, "#00bf2f", "Medium dark green"],
  [40, "#007f1f", "Dark green"],
  [49, "#003f0f", "Very dark green"],
  [19, "#ff0000", "Red"],
  [20, "#ffbf00", "Orange"],
  [21, "#f2ff00", "Yellow"],
];

const TREE_TYPES: [string, string, string][] = [
  ["normal", "Normal", "Deciduous: trunk + dome canopy"],
  ["terrain", "Terrain", "Tall terrain tree: ragged wide canopy"],
  ["pine", "Pine", "Conical pine: narrow 5×5 canopy"],
  ["tall_pine", "T. Pine", "Tall conical pine: wide 7×7 canopy"],
];

export default function InsertTab() {
  const { p, bodyWidth, armTransientTool } = useRibbon();
  const tier = useMemo(() => solveLayout(SPECS, bodyWidth), [bodyWidth]);
  const [generating, setGenerating] = useState(false);
  const sel = p.selection;

  return (
    <>
      {/* ── Prefab ────────────────────────────────────────────────────────── */}
      <Group id="prefab" label="Prefab" tier={tier.prefab} declaredWidth={230} icon="prefab">
        <CommandButton tier={tier.prefab === "full" ? "full" : "medium"}
          icon="prefab" label="Load" title="Load a .epfab prefab into the clipboard, ready to paste"
          onClick={p.loadPrefab} />
        <CommandButton tier={tier.prefab === "full" ? "full" : "medium"}
          icon="prefabLibrary" label="Library" title="Browse saved prefabs in the docked sidebar"
          onClick={p.onTogglePrefabLibrary} active={p.showPrefabLibrary} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="savePrefab" label="Save Prefab…" full disabled={!p.clipboard}
            title={p.clipboard ? "Save the clipboard as a prefab in your prefab folder" : "Copy or cut something first"}
            onClick={p.onSavePrefab} />
          <SmallButton icon="save" label="Save As…" full disabled={!p.clipboard}
            title={p.clipboard ? "Save the clipboard to any folder (native dialog)" : "Copy or cut something first"}
            onClick={p.onSavePrefabAs} />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Import ────────────────────────────────────────────────────────── */}
      <Group id="import" label={<>Import <Badge /></>} tier={tier.import} declaredWidth={116} icon="importFile">
        <CommandButton tier={tier.import === "full" ? "full" : "medium"}
          icon="importFile" label="Schematic"
          title="Import a Minecraft .schematic / .litematic into the clipboard (experimental) — MC X→Eden X, MC Z→Eden Y, MC Y→Eden Z"
          onClick={p.importSchematic} />
      </Group>
      <GroupDivider />

      {/* ── Nature ────────────────────────────────────────────────────────── */}
      <Group id="nature" label="Nature" tier={tier.nature} declaredWidth={338} icon="trees"
        dim={!sel} dimNote="(no selection)">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Row style={{ height: SMALL_H }}>
            {TREE_TYPES.map(([id, label, tip]) => (
              <SmallButton key={id} label={label} title={tip} accent={ACCENT.green}
                active={p.treeTypes.includes(id)}
                onClick={() => p.setTreeTypes(
                  p.treeTypes.includes(id)
                    ? p.treeTypes.length > 1 ? p.treeTypes.filter(x => x !== id) : p.treeTypes
                    : [...p.treeTypes, id],
                )} />
            ))}
          </Row>
          <Row gap={SPACE.sm} style={{ height: SMALL_H }}>
            <FieldLabel width={30}>Leaf</FieldLabel>
            {LEAF_COLORS.map(([paint, hex, name]) => {
              const on = p.leafPaints.includes(paint);
              return (
                <div key={paint} role="checkbox" aria-checked={on} aria-label={name} tabIndex={0} title={name}
                  onClick={() => p.setLeafPaints(
                    on ? p.leafPaints.length > 1 ? p.leafPaints.filter(x => x !== paint) : p.leafPaints
                      : [...p.leafPaints, paint],
                  )}
                  style={{ display: "flex", cursor: "pointer", flexShrink: 0 }}>
                  <Swatch color={hex} selected={on} />
                </div>
              );
            })}
          </Row>
          <Row style={{ height: SMALL_H }}>
            <SliderRow label="Density" min={1} max={100} accent={ACCENT.green} labelWidth={44} width={70}
              value={p.treeDensity} onChange={p.setTreeDensity} format={v => `${v}%`}
              title="Chance a given column gets a tree" />
            <SmallButton label={p.smartPlacement ? "Grass only ✓" : "Grass only"} accent={ACCENT.green}
              active={p.smartPlacement} onClick={() => p.setSmartPlacement(!p.smartPlacement)}
              title="Only plant on grass columns" />
          </Row>
        </Col>
        <CommandButton tier={tier.nature === "full" ? "full" : "medium"}
          icon="trees" label={generating ? "Planting…" : "Plant Trees"} accent={ACCENT.green}
          disabled={generating || !sel}
          title={sel ? `Plant trees across the selection at ${p.treeDensity}% density` : "Make a selection first"}
          onClick={async () => {
            setGenerating(true);
            try { await p.onGenerateTrees(p.treeTypes, Math.pow(p.treeDensity / 100, 2) * 0.20, p.leafPaints, p.smartPlacement); }
            finally { setGenerating(false); }
          }} />
      </Group>
      <GroupDivider />

      {/* ── Fluids ────────────────────────────────────────────────────────── */}
      <Group id="fluids" label={<>Fluids <Badge /></>} tier={tier.fluids} declaredWidth={372} icon="water"
        dim={!sel} dimNote="(no selection)">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Row style={{ height: SMALL_H }}>
            <Segmented ariaLabel="Fluid" value={String(p.fluidBase)} accent={ACCENT.primary}
              onChange={v => p.setFluidBase(Number(v) as 20 | 23)}
              options={[
                { id: "20", label: "Water", icon: "water", title: "Work with water (block 20)" },
                { id: "23", label: "Lava", icon: "lava", title: "Work with lava (block 23)" },
              ]} />
            <SmallButton label={p.fluidIncludeExisting ? "Resume partials ✓" : "Resume partials"} accent={ACCENT.primary}
              active={p.fluidIncludeExisting} onClick={() => p.setFluidIncludeExisting(!p.fluidIncludeExisting)}
              title="Also grow flow from existing ¾/½/¼ fluid, not just full source blocks" />
          </Row>
          <Row style={{ height: SMALL_H }}>
            <SmallButton icon="simulate" label="Simulate Flow" accent={ACCENT.primary} onClick={p.onSimulateFlow}
              title="Grow flow from every full source block already inside the selection" />
            <SmallButton icon="poolFill" label={p.tool === "poolfill" ? "Click a floor…" : "Pool Fill"} accent={ACCENT.primary}
              active={p.tool === "poolfill"}
              onClick={() => armTransientTool("poolfill", "select")}
              title="Click a floor cell in the selection to bucket-fill the basin up to the target Z" />
            <FieldLabel>to Z</FieldLabel>
            <NumField min={0} max={p.world?.max_z ?? 63} value={p.poolFillTargetZ}
              onChange={p.setPoolFillTargetZ} ariaLabel="Pool fill target Z" width={40} />
          </Row>
          <Row style={{ height: SMALL_H }}>
            <SmallButton label={p.wavyMode === "existing" ? "Existing" : "Fill dry"} accent={ACCENT.primary}
              onClick={() => p.setWavyMode(p.wavyMode === "existing" ? "fill" : "existing")}
              title={p.wavyMode === "existing"
                ? "Re-skin columns that already have this fluid on top"
                : "Also flood dry columns one block above the terrain"} />
            <SliderRow label="λ" min={2} max={32} accent={ACCENT.primary} labelWidth={10} width={44}
              value={p.wavyWavelength} onChange={p.setWavyWavelength} title="Ripple wavelength, in blocks" />
            <SliderRow label="amp" min={0} max={100} accent={ACCENT.primary} labelWidth={22} width={44}
              value={Math.round(p.wavyAmplitude * 100)} onChange={v => p.setWavyAmplitude(v / 100)}
              format={v => `${v}%`} title="Ripple amplitude" />
            <SmallButton icon="wavy" label="Wavy Surface" accent={ACCENT.primary} onClick={p.onGenerateWavySurface}
              title="Stamp a procedural ¾/½/¼ ripple pattern across the selection" />
          </Row>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── World Extent ──────────────────────────────────────────────────── */}
      <Group id="extent" label="World Extent" tier={tier.extent} declaredWidth={150} icon="materialize">
        <Col style={{ height: GROUP_CONTENT_H, justifyContent: "space-between" }}>
          <Row>
            {/* Always `tier="medium"` (SmallButton, SMALL_H tall), never the group's own `full`
                tier — this group's content structurally needs two rows (the button row here +
                the confirm button below), but `CommandButton`'s `full` tier renders a `LargeButton`
                whose height alone (LARGE_H) equals the *entire* GROUP_CONTENT_H. At `full` tier
                this used to swallow the whole group height in one row, silently clipping the
                confirm button beneath it — the exact bug report: "I can't see a way to confirm
                Materialize." `tier.extent` still legitimately varies the *group's* declared width
                via `SPECS`; only the buttons' own height tier is pinned here. */}
            <CommandButton tier="medium"
              icon="materialize" label="Materialize" accent={ACCENT.warm} active={p.tool === "materialize"}
              onClick={() => p.setTool("materialize")}
              title="Materialize — drag to select ungenerated chunk space (holes, or growth past the map edge), then turn it into real flat terrain" />
            <CommandButton tier="medium"
              icon="expandWorld" label="Expand" disabled={!p.templateLoaded}
              onClick={() => { p.setShowExpandModal(true); p.setExpandResult(null); }}
              title={p.templateLoaded
                ? "Bake chunks from the loaded Eden.eden template into this world, growing its extent"
                : "Load the Eden.eden template first (View ▸ Template)"} />
          </Row>
          {/* Always visible, not just once the Materialize tool is armed — a confirm button that
              only appears conditionally reads as "there's no way to confirm this" (a real bug
              report: it was mistaken for the unrelated, also-often-disabled Expand button next to
              it). Disabled + a tooltip that walks through the two-step flow is clearer than
              vanishing entirely. */}
          <SmallButton label="Materialize…" full accent={ACCENT.warm}
            disabled={p.tool !== "materialize" || !p.materializeSelection}
            onClick={p.onOpenMaterializeModal}
            title={
              p.tool !== "materialize"
                ? "Click Materialize above first, then drag a selection on the map"
                : p.materializeSelection
                  ? "Turn the selected chunk space into real terrain"
                  : "Drag a selection in the map first"
            } />
          <Caption>Neither is undoable</Caption>
        </Col>
      </Group>
    </>
  );
}
