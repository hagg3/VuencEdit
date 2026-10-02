/**
 * SELECTION — contextual on `rawBounds`. Owns the selection object itself.
 *
 * Fill and Gradient merged into one group (both are "write blocks across the selection") and the
 * Fluid toolkit moved to Insert, which brings this tab from eight groups back to six.
 */
import { useMemo } from "react";
import { blockDisplayName, resolveColor } from "../../blockDefs";
import type { ExtrudeAxis } from "../../types";
import { contentTier } from "../layout";
import { tabMetrics, specWidth, solveRow } from "../specs";
import { useRibbon } from "../context";
import { Cmd, CmdIcon, CmdSetting, CmdSmall, useBinding } from "../Cmd";
import {
  Check, Col, FieldLabel, Group, GroupDivider, NumField, RangeSlider, Row, Segmented, Swatch,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H, SMALL_H, btnActive, btnBase } from "../tokens";
import { Icon } from "../icons";

const SPECS = tabMetrics("selection");
const W = (g: string) => specWidth("selection", g);

const POS_AXES: { id: ExtrudeAxis; label: string; title: string }[] = [
  { id: "z+", label: "↑Z+", title: "Repeat upward" },
  { id: "x+", label: "→X+", title: "Repeat east" },
  { id: "y+", label: "↓Y+", title: "Repeat south" },
];
const NEG_AXES: { id: ExtrudeAxis; label: string; title: string }[] = [
  { id: "z-", label: "↓Z−", title: "Repeat downward" },
  { id: "x-", label: "←X−", title: "Repeat west" },
  { id: "y-", label: "↑Y−", title: "Repeat north" },
];

export default function SelectionTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveRow(SPECS, bodyWidth), [bodyWidth]);
  const write = useBinding("selection.fill.write");
  const fade = useBinding("selection.fill.fade");
  const filter = useBinding("selection.replace.filter");
  const skipAir = useBinding("selection.extrude.skipAir");

  const maxZ = p.world?.max_z ?? 63;
  const zLo = Math.min(p.zMin, p.zMax);
  const zHi = Math.max(p.zMin, p.zMax);

  return (
    <>
      {/* ── Modify ────────────────────────────────────────────────────────── */}
      <Group id="modify" label="Modify" tier={tier.modify} declaredWidth={W("modify")} icon="select">
        <Cmd id="home.selection.grow" tier={contentTier(tier.modify)} />
        <Cmd id="home.selection.shrink" tier={contentTier(tier.modify)} />
        <Cmd id="home.selection.clear" tier={contentTier(tier.modify)} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="home.clipboard.copy" full iconOnly />
          <CmdSmall id="home.clipboard.cut" full iconOnly />
          <CmdSmall id="home.clipboard.paste" full iconOnly />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Z Range ───────────────────────────────────────────────────────── */}
      <Group id="zrange" label={`Z Range · ${zHi - zLo + 1} levels`} name="Z Range" tier={tier.zrange} declaredWidth={W("zrange")} icon="zslice">
        <CmdSetting id="selection.zrange.range"><Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <RangeSlider lo={p.zMin} hi={p.zMax} min={0} max={maxZ} accent={ACCENT.selection}
            onLo={p.handleZMin} onHi={p.handleZMax}
            ariaLabelLo="Z minimum" ariaLabelHi="Z maximum" />
          <Row style={{ height: SMALL_H }}>
            <FieldLabel width={22}>Min</FieldLabel>
            <NumField min={0} max={maxZ} value={p.zMin} ariaLabel="Z Min"
              onChange={n => p.handleZMin(String(n))} width={46} />
            <FieldLabel width={24} align="right">Max</FieldLabel>
            <NumField min={0} max={maxZ} value={p.zMax} ariaLabel="Z Max"
              onChange={n => p.handleZMax(String(n))} width={46} />
          </Row>
        </Col></CmdSetting>
      </Group>
      <GroupDivider />

      {/* ── Move ──────────────────────────────────────────────────────────── */}
      <Group id="move" label="Move" tier={tier.move} declaredWidth={W("move")} icon="move">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSetting id="selection.move.mode"><Segmented ariaLabel="Move mode" accent={ACCENT.selection} value={p.moveWithContents ? "both" : "box"}
            onChange={v => p.setMoveWithContents(() => v === "both")}
            options={[
              { id: "box", label: "Box", title: "Dragging or nudging moves just the selection rectangle" },
              { id: "both", label: "Blocks", title: "Dragging or nudging also moves the blocks inside it" },
            ]} /></CmdSetting>
          <Row style={{ height: SMALL_H, justifyContent: "center" }}>
            <CmdIcon id="selection.move.left" />
            <CmdIcon id="selection.move.up" />
            <CmdIcon id="selection.move.down" />
            <CmdIcon id="selection.move.right" />
          </Row>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Fill (merged with Gradient) ───────────────────────────────────── */}
      <Group id="fill" label="Fill / Gradient" tier={tier.fill} declaredWidth={W("fill")} icon="fill">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSetting id="selection.fill.write">
            <BlockChip label="Write" blockType={p.fillBlockType} paint={p.fillPaint}
              open={!!write.armed} onClick={write.run}
              title="Block for Fill, and the start of Gradient" />
          </CmdSetting>
          <CmdSetting id="selection.fill.fade">
            <BlockChip label="Fade" blockType={p.gradientToBlock} paint={p.gradientToPaint}
              open={!!fade.armed} onClick={fade.run}
              title="End block for Gradient" />
          </CmdSetting>
          <Row style={{ height: SMALL_H }}>
            <CmdSetting id="selection.fill.axis"><Segmented ariaLabel="Gradient axis" label="Axis" accent={ACCENT.primary} value={p.gradientAxis} onChange={p.setGradientAxis}
              options={[
                { id: "x", label: "X", title: "East–west (seen from above)" },
                { id: "y", label: "Y", title: "North–south (seen from above)" },
                { id: "z", label: "Z", title: "By height (seen from the side and in 3D)" },
              ]} /></CmdSetting>
            <CmdSmall id="selection.fill.includeAir" />
          </Row>
        </Col>
        <Cmd id="home.selection.fill" tier={contentTier(tier.fill)} />
        <Cmd id="selection.fill.gradient" tier={contentTier(tier.fill)} />
      </Group>
      <GroupDivider />

      {/* ── Replace ───────────────────────────────────────────────────────── */}
      <Group id="replace" label="Replace" tier={tier.replace} declaredWidth={W("replace")} icon="replace">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSetting id="selection.replace.filter"><button className="rbn-btn" type="button" onClick={filter.run}
            title="Fill and Delete only touch these blocks"
            aria-label="Filter: which blocks Fill and Delete touch" data-active={filter.armed ? "true" : undefined}
            style={btnBase({
              height: SMALL_H, display: "flex", alignItems: "center", gap: 5, padding: "0 7px", width: "100%",
              ...(filter.armed ? btnActive() : null),
            })}>
            <Icon name="filter" size={14} tone="default" />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {p.filterBlockType === null ? "any block" : blockDisplayName(p.filterBlockType)}
              {p.filterPaint !== null ? ` #${p.filterPaint}` : ""}
              {p.filterInvert ? " (inv)" : ""}
            </span>
            <Icon name="split" size={11} tone="inherit" style={{ marginLeft: "auto" }} />
          </button></CmdSetting>
          <Row style={{ height: SMALL_H }}>
            <CmdSmall id="selection.replace.invert" />
            <CmdSmall id="selection.replace.clear" />
          </Row>
        </Col>
        <Cmd id="home.selection.delete" tier={contentTier(tier.replace)}
          label={p.filterBlockType !== null ? (p.filterInvert ? "Del. except" : "Del. filtered") : "Delete all"} />
      </Group>
      <GroupDivider />

      {/* ── Extrude ───────────────────────────────────────────────────────── */}
      <Group id="extrude" label="Extrude" tier={tier.extrude} declaredWidth={W("extrude")} icon="extrude">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSetting id="selection.extrude.axis">
          {/* Two `Segmented` rows rather than a hand-rolled 3×2 button grid — one radio group per
              sign, since the axis and its direction are two separate choices to the eye. */}
          <Segmented ariaLabel="Extrude axis, positive" accent={ACCENT.selection} value={p.extrudeAxis}
            onChange={p.setExtrudeAxis} options={POS_AXES} />
          <Segmented ariaLabel="Extrude axis, negative" accent={ACCENT.selection} value={p.extrudeAxis}
            onChange={p.setExtrudeAxis} options={NEG_AXES} />
          </CmdSetting>
          <Row style={{ height: SMALL_H }}>
            <FieldLabel>Copies</FieldLabel>
            <NumField min={0} max={20} value={p.extrudeCount} title="0 = preview off"
              onChange={p.setExtrudeCount} ariaLabel="Extrude copies" width={40} />
            <CmdSetting id="selection.extrude.skipAir">
              <Check checked={!!skipAir.armed} onChange={skipAir.run} label="Skip air"
                title="Leave existing blocks where the source cell is air" />
            </CmdSetting>
          </Row>
        </Col>
        <Cmd id="selection.extrude.run" tier={contentTier(tier.extrude)} />
      </Group>
    </>
  );
}

/** A one-row block swatch + name that opens the shared picker portal. */
function BlockChip({
  label, blockType, paint, open, onClick, title,
}: {
  label: string; blockType: number; paint: number; open: boolean; title: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const [r, g, b] = resolveColor(blockType, paint);
  return (
    <button className="rbn-btn" type="button" onClick={onClick} title={title}
      aria-label={`${label} block`} data-active={open ? "true" : undefined}
      style={btnBase({
        height: SMALL_H, display: "flex", alignItems: "center", gap: 5, padding: "0 7px", width: "100%",
        ...(open ? btnActive() : null),
      })}>
      <FieldLabel width={28}>{label}</FieldLabel>
      <Swatch color={`rgb(${r},${g},${b})`} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {blockDisplayName(blockType)}{paint > 0 ? ` #${paint}` : ""}
      </span>
      <Icon name="split" size={11} tone="inherit" style={{ marginLeft: "auto" }} />
    </button>
  );
}
