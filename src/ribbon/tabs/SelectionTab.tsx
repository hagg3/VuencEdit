/**
 * SELECTION — contextual on `rawBounds`. Owns the selection object itself.
 *
 * Fill and Gradient merged into one group (both are "write blocks across the selection") and the
 * Fluid toolkit moved to Insert, which brings this tab from eight groups back to six.
 */
import { useMemo, useState } from "react";
import { blockDisplayName, resolveColor } from "../../blockDefs";
import type { ExtrudeAxis } from "../../types";
import { solveLayout, type GroupMetrics } from "../layout";
import { useRibbon } from "../context";
import {
  Caption, Check, Col, CommandButton, FieldLabel, Group, GroupDivider, IconButton, NumField,
  RangeSlider, Row, Segmented, SmallButton, Swatch,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H, SMALL_H, btnActive, btnBase } from "../tokens";
import { Icon } from "../icons";

const SPECS: GroupMetrics[] = [
  { id: "modify", widths: { full: 232, medium: 150, compact: 44 }, minTier: "compact", priority: 1 },
  { id: "zrange", widths: { full: 190, medium: 150, compact: 44 }, minTier: "medium", priority: 2 },
  { id: "move", widths: { full: 210, medium: 150, compact: 44 }, minTier: "compact", priority: 3 },
  { id: "fill", widths: { full: 330, medium: 220, compact: 44 }, minTier: "medium", priority: 0 },
  { id: "replace", widths: { full: 218, medium: 150, compact: 44 }, minTier: "compact", priority: 4 },
  { id: "extrude", widths: { full: 244, medium: 160, compact: 44 }, minTier: "compact", priority: 5 },
];

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
  const { p, bodyWidth, pickerKind, togglePicker } = useRibbon();
  const tier = useMemo(() => solveLayout(SPECS, bodyWidth), [bodyWidth]);
  const [extrudeIgnoreAir, setExtrudeIgnoreAir] = useState(false);

  const sel = p.selection;
  const maxZ = p.world?.max_z ?? 63;
  const zLo = Math.min(p.zMin, p.zMax);
  const zHi = Math.max(p.zMin, p.zMax);

  return (
    <>
      {/* ── Modify ────────────────────────────────────────────────────────── */}
      <Group id="modify" label="Modify" tier={tier.modify} declaredWidth={232} icon="select">
        <CommandButton tier={tier.modify === "full" ? "full" : "medium"} icon="grow" label="Grow"
          title="Grow the selection by one block on every side"
          onClick={() => p.setRawBounds(b => b ? { x1: b.x1 - 1, y1: b.y1 - 1, x2: b.x2 + 1, y2: b.y2 + 1 } : null)} />
        <CommandButton tier={tier.modify === "full" ? "full" : "medium"} icon="shrink" label="Shrink"
          title="Shrink the selection by one block on every side"
          onClick={() => p.setRawBounds(b => b ? { x1: Math.min(b.x1 + 1, b.x2), y1: Math.min(b.y1 + 1, b.y2), x2: Math.max(b.x2 - 1, b.x1), y2: Math.max(b.y2 - 1, b.y1) } : null)} />
        <CommandButton tier={tier.modify === "full" ? "full" : "medium"} icon="clear" label="Clear" tone="danger"
          title="Deselect (Esc)" onClick={() => p.setRawBounds(null)} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="selectAll" label="Select All" full title="Select the whole world (⌘A)" onClick={p.onSelectAll} />
          <SmallButton icon="copy" label="Copy" full title="Copy the selection (⌘C)" onClick={p.copySelection} />
          <SmallButton icon="cut" label="Cut" full title="Copy the selection, then clear it" onClick={p.cutSelection} />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Z Range ───────────────────────────────────────────────────────── */}
      <Group id="zrange" label={`Z Range · ${zHi - zLo + 1} levels`} tier={tier.zrange} declaredWidth={190} icon="zslice">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <RangeSlider lo={p.zMin} hi={p.zMax} min={0} max={maxZ} accent={ACCENT.green}
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
          <Caption>Every edit is clipped to this band</Caption>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Move ──────────────────────────────────────────────────────────── */}
      <Group id="move" label="Move" tier={tier.move} declaredWidth={210} icon="move">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Segmented ariaLabel="Move mode" accent={ACCENT.green} value={p.moveWithContents ? "both" : "box"}
            onChange={v => p.setMoveWithContents(() => v === "both")}
            options={[
              { id: "box", label: "Box only", title: "Dragging or nudging moves just the selection rectangle" },
              { id: "both", label: "Box + blocks", title: "Dragging or nudging also moves the blocks inside it" },
            ]} />
          <Row style={{ height: SMALL_H, justifyContent: "center" }}>
            <IconButton icon="left" label="Nudge left" title="Nudge the selection one block left (←)" onClick={() => p.onNudgeSelection(-1, 0)} />
            <IconButton icon="up" label="Nudge up" title="Nudge the selection one block up (↑)" onClick={() => p.onNudgeSelection(0, -1)} />
            <IconButton icon="down" label="Nudge down" title="Nudge the selection one block down (↓)" onClick={() => p.onNudgeSelection(0, 1)} />
            <IconButton icon="right" label="Nudge right" title="Nudge the selection one block right (→)" onClick={() => p.onNudgeSelection(1, 0)} />
          </Row>
          <Caption>{p.moveWithContents ? "Blocks travel with the box" : "Box moves, blocks stay"}</Caption>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Fill (merged with Gradient) ───────────────────────────────────── */}
      <Group id="fill" label="Fill / Gradient" tier={tier.fill} declaredWidth={330} icon="fill">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <BlockChip label="Write" blockType={p.fillBlockType} paint={p.fillPaint}
            open={pickerKind === "block-fill"} onClick={e => togglePicker(e, "block-fill")}
            title="The block Fill writes — and Gradient's starting colour. To replace only certain blocks, set the filter in Replace →" />
          <BlockChip label="Fade to" blockType={p.gradientToBlock} paint={p.gradientToPaint}
            open={pickerKind === "gradient-to"} onClick={e => togglePicker(e, "gradient-to")}
            title="Gradient's ending colour — ignored by Fill" />
          <Row style={{ height: SMALL_H }}>
            <Segmented ariaLabel="Gradient axis" label="Axis" accent={ACCENT.primary} value={p.gradientAxis} onChange={p.setGradientAxis}
              options={[
                { id: "x", label: "X", title: "Blend across (E–W) — visible top-down" },
                { id: "y", label: "Y", title: "Blend across (N–S) — visible top-down" },
                { id: "z", label: "Z", title: "Blend by height — visible in side/3D views" },
              ]} />
            <SmallButton label="+Air" accent={ACCENT.primary} active={p.gradientIncludeAir}
              onClick={() => p.setGradientIncludeAir(!p.gradientIncludeAir)}
              title="Also write into empty (air) cells, not just existing blocks" />
          </Row>
        </Col>
        <CommandButton tier={tier.fill === "full" ? "full" : "medium"} icon="fill" label="Fill" accent={ACCENT.primary}
          disabled={!p.rawBounds} title="Fill the selection with the Write block, respecting the Replace filter"
          onClick={p.fillSelection} />
        <CommandButton tier={tier.fill === "full" ? "full" : "medium"} icon="gradient" label="Gradient" accent={ACCENT.primary}
          disabled={!p.rawBounds} title="Dither-blend Write → Fade to across the selection along the chosen axis"
          onClick={p.applyGradientFill} />
      </Group>
      <GroupDivider />

      {/* ── Replace ───────────────────────────────────────────────────────── */}
      <Group id="replace" label="Replace" tier={tier.replace} declaredWidth={218} icon="replace">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <button className="rbn-btn" type="button" onClick={e => togglePicker(e, "filter")}
            title="Filter — only these existing blocks get touched by Fill (← Write) and Delete. Leave as 'any block' to affect everything"
            aria-label="Filter: which blocks Fill and Delete touch" data-active={pickerKind === "filter" ? "true" : undefined}
            style={btnBase({
              height: SMALL_H, display: "flex", alignItems: "center", gap: 5, padding: "0 7px", width: "100%",
              ...(pickerKind === "filter" ? btnActive() : null),
            })}>
            <Icon name="filter" size={14} tone="default" />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {p.filterBlockType === null ? "any block" : blockDisplayName(p.filterBlockType)}
              {p.filterPaint !== null ? ` #${p.filterPaint}` : ""}
              {p.filterInvert ? " (inv)" : ""}
            </span>
            <Icon name="split" size={11} tone="inherit" style={{ marginLeft: "auto" }} />
          </button>
          <Row style={{ height: SMALL_H }}>
            <SmallButton icon="invert" label="Invert" accent={ACCENT.green} active={p.filterInvert}
              title="Act on everything EXCEPT the filter" onClick={() => p.setFilterInvert(!p.filterInvert)} />
            <SmallButton icon="clear" label="Clear" title="Clear the match filter"
              onClick={() => { p.setFilterBlockType(null); p.setFilterPaint(null); p.setFilterInvert(false); }} />
          </Row>
        </Col>
        <CommandButton tier={tier.replace === "full" ? "full" : "medium"} icon="delete" tone="danger"
          label={p.filterBlockType !== null ? (p.filterInvert ? "Del. except" : "Del. filtered") : "Delete all"}
          disabled={!p.rawBounds}
          title="Delete blocks in the selection, respecting the match filter"
          onClick={p.deleteBlocks} />
      </Group>
      <GroupDivider />

      {/* ── Extrude ───────────────────────────────────────────────────────── */}
      <Group id="extrude" label="Extrude" tier={tier.extrude} declaredWidth={244} icon="extrude">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          {/* Two `Segmented` rows rather than a hand-rolled 3×2 button grid — one radio group per
              sign, since the axis and its direction are two separate choices to the eye. */}
          <Segmented ariaLabel="Extrude axis, positive" accent={ACCENT.green} value={p.extrudeAxis}
            onChange={p.setExtrudeAxis} options={POS_AXES} />
          <Segmented ariaLabel="Extrude axis, negative" accent={ACCENT.green} value={p.extrudeAxis}
            onChange={p.setExtrudeAxis} options={NEG_AXES} />
          <Row style={{ height: SMALL_H }}>
            <FieldLabel>Copies</FieldLabel>
            <NumField min={0} max={20} value={p.extrudeCount} title="0 = preview off"
              onChange={p.setExtrudeCount} ariaLabel="Extrude copies" width={40} />
            <Check checked={extrudeIgnoreAir} onChange={setExtrudeIgnoreAir} label="skip air"
              title="Leave existing blocks where the source cell is air" />
          </Row>
        </Col>
        <CommandButton tier={tier.extrude === "full" ? "full" : "medium"} icon="extrude" accent={ACCENT.green}
          label={`Extrude ${p.extrudeAxis}`} disabled={!sel || p.extrudeCount === 0}
          title={!sel ? "Make a selection first"
            : p.extrudeCount === 0 ? "Set the number of copies above 0"
              : `Repeat the selection ${p.extrudeCount}× along ${p.extrudeAxis}`}
          onClick={() => p.onExtrude(extrudeIgnoreAir)} />
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
