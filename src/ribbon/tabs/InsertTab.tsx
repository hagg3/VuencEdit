/**
 * INSERT — generate or bring content into the world.
 *
 * Prefab moved off the File menu (loading a prefab puts content in the world; it isn't a file
 * operation on *your* world), Materialize moved off Home, and the Fluid toolkit moved off
 * Selection — it is selection-scoped *generation*, structurally identical to Trees, which already
 * lived here. Groups: Prefab, Nature, Fluids, World Extent. (Schematic import — the former Import
 * group — was removed along with the rest of VuencEdit's format-conversion features; see
 * `~/EdenToMC`.)
 */
import { useMemo } from "react";
import { contentTier } from "../layout";
import { tabMetrics, specWidth, solveRow } from "../specs";
import { useRibbon } from "../context";
import { Cmd, CmdSetting, CmdSmall } from "../Cmd";
import type { CommandId } from "../../commands/meta";
import {
  Badge, Caption, Col, FieldLabel, Group, GroupDivider, NumField, Row, Segmented, SliderRow, Swatch,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H, SMALL_H, SPACE } from "../tokens";

const SPECS = tabMetrics("insert");
const W = (g: string) => specWidth("insert", g);

// Game paint colours (Hud.mm's palette) — colour *data*, not chrome, so exempt from the raw-hex rule.
/* eslint-disable no-restricted-syntax */
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
/* eslint-enable no-restricted-syntax */

const TREE_TYPES: CommandId[] = [
  "insert.nature.treeNormal", "insert.nature.treeTerrain", "insert.nature.treePine", "insert.nature.treeTallPine",
];

export default function InsertTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveRow(SPECS, bodyWidth), [bodyWidth]);
  const sel = p.selection;

  return (
    <>
      {/* ── Prefab ────────────────────────────────────────────────────────── */}
      <Group id="prefab" label="Prefab" tier={tier.prefab} declaredWidth={W("prefab")} icon="prefab">
        <Cmd id="insert.prefab.load" tier={contentTier(tier.prefab)} />
        <Cmd id="insert.prefab.library" tier={contentTier(tier.prefab)} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="insert.prefab.save" full />
          <CmdSmall id="insert.prefab.saveAs" full />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Nature ────────────────────────────────────────────────────────── */}
      <Group id="nature" label="Nature" tier={tier.nature} declaredWidth={W("nature")} icon="trees"
        dim={!sel} dimNote="(no selection)">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Row style={{ height: SMALL_H }}>
            {TREE_TYPES.map(id => <CmdSmall key={id} id={id} />)}
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
            <CmdSetting id="insert.nature.density">
              <SliderRow label="Density" min={1} max={100} accent={ACCENT.primary} labelWidth={44} width={70}
                value={p.treeDensity} onChange={p.setTreeDensity} format={v => `${v}%`}
                title="Chance a given column gets a tree" />
            </CmdSetting>
            <CmdSmall id="insert.nature.grassOnly" check />
          </Row>
        </Col>
        <Cmd id="insert.nature.plant" tier={contentTier(tier.nature)} />
      </Group>
      <GroupDivider />

      {/* ── Fluids ────────────────────────────────────────────────────────── */}
      <Group id="fluids" label={<>Fluids <Badge /></>} name="Fluids" tier={tier.fluids} declaredWidth={W("fluids")} icon="water"
        dim={!sel} dimNote="(no selection)">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Row style={{ height: SMALL_H }}>
            <CmdSetting id="insert.fluids.fluid"><Segmented ariaLabel="Fluid" value={String(p.fluidBase)} accent={ACCENT.primary}
              onChange={v => p.setFluidBase(Number(v) as 20 | 23)}
              options={[
                { id: "20", label: "Water", icon: "water", title: "Work with water (block 20)" },
                { id: "23", label: "Lava", icon: "lava", title: "Work with lava (block 23)" },
              ]} /></CmdSetting>
            <CmdSmall id="insert.fluids.resume" check />
          </Row>
          <Row style={{ height: SMALL_H }}>
            <CmdSmall id="insert.fluids.simulate" />
            <CmdSmall id="insert.fluids.poolFill" />
            <FieldLabel>to Z</FieldLabel>
            <NumField min={0} max={p.world?.max_z ?? 63} value={p.poolFillTargetZ}
              onChange={p.setPoolFillTargetZ} ariaLabel="Pool fill target Z" width={40} />
          </Row>
          <Row style={{ height: SMALL_H }}>
            <CmdSmall id="insert.fluids.wavyMode" />
            <SliderRow label="λ" min={2} max={32} accent={ACCENT.primary} labelWidth={10} width={44}
              value={p.wavyWavelength} onChange={p.setWavyWavelength} title="Ripple wavelength, in blocks" />
            <SliderRow label="amp" min={0} max={100} accent={ACCENT.primary} labelWidth={22} width={44}
              value={Math.round(p.wavyAmplitude * 100)} onChange={v => p.setWavyAmplitude(v / 100)}
              format={v => `${v}%`} title="Ripple amplitude" />
            <CmdSmall id="insert.fluids.wavy" />
          </Row>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── World Extent ──────────────────────────────────────────────────── */}
      <Group id="extent" label="World Extent" tier={tier.extent} declaredWidth={W("extent")} icon="materialize">
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
            <Cmd id="insert.extent.materialize" tier="medium" />
            <Cmd id="insert.extent.expand" tier="medium" />
          </Row>
          {/* Always visible, not just once the Materialize tool is armed — a confirm button that
              only appears conditionally reads as "there's no way to confirm this" (a real bug
              report: it was mistaken for the unrelated, also-often-disabled Expand button next to
              it). Disabled + a tooltip that walks through the two-step flow is clearer than
              vanishing entirely. */}
          <CmdSmall id="insert.extent.materializeConfirm" full />
          <Caption>Neither is undoable</Caption>
        </Col>
      </Group>
    </>
  );
}
