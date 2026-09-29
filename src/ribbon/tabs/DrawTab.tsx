/**
 * DRAW — place blocks by hand in 2D. Sculpt's 16 tools and four parameter groups moved out to
 * their own tab, which is what brought this one back under MS's seven-group ceiling.
 */
import { useMemo, useState } from "react";
import { BLOCK_DEFS, NEW_FORMAT_BLOCKS } from "../../blockDefs";
import type { Tool } from "../../MapCanvas";
import { contentTier } from "../layout";
import { tabMetrics, specWidth, solveRow } from "../specs";
import { useRibbon } from "../context";
import BlockButton from "../BlockButton";
import { Cmd, CmdDropdown, CmdMenuItem, CmdSetting, CmdSmall, CmdSplit } from "../Cmd";
import type { CommandId } from "../../commands/meta";
import {
  Caption, Col, FieldLabel, Group, GroupDivider, Row, Segmented, Select, SliderRow,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H, ROW_GAP, SMALL_H } from "../tokens";

const SPECS = tabMetrics("draw");
const W = (g: string) => specWidth("draw", g);

/** Mask dropdown options — static, so built once at module load rather than per render. */
const MASK_BLOCK_OPTIONS = [
  { id: "", label: "any" },
  ...BLOCK_DEFS.map(b => ({ id: String(b.type), label: b.name })),
  ...NEW_FORMAT_BLOCKS.map(b => ({ id: String(b.type), label: b.name })),
];
const MASK_PAINT_OPTIONS = [
  { id: "", label: "any" },
  { id: "0", label: "none" },
  ...Array.from({ length: 54 }, (_, i) => ({ id: String(i + 1), label: `#${i + 1}` })),
];

/** The Shape split button's family, face-first order. */
const SHAPES: { tool: Tool; id: CommandId }[] = [
  { tool: "rect", id: "draw.tools.rect" },
  { tool: "ellipse", id: "draw.tools.ellipse" },
  { tool: "polygon", id: "draw.tools.polygon" },
];

export default function DrawTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveRow(SPECS, bodyWidth), [bodyWidth]);
  const big = contentTier(tier.tools);

  // Face of the Shape split button: the last shape actually used, so the button is a real command
  // rather than a menu you must open twice. Derived from the armed tool (render-phase sync, no
  // effect), so it follows a shape armed from anywhere — keyboard, ⌘K, the Tools window.
  const [lastShape, setLastShape] = useState<Tool>("rect");
  if (SHAPES.some(s => s.tool === p.tool) && p.tool !== lastShape) setLastShape(p.tool);
  const shape = SHAPES.find(s => s.tool === lastShape)!;
  const shapeArmed = SHAPES.some(s => s.tool === p.tool);

  const isSpray = p.tool === "spray";
  const sizeApplies = p.tool === "brush" || p.tool === "spray" || p.tool === "line";
  const shapeApplies = !p.isSculptTool && p.tool !== "fill" && p.tool !== "eyedropper";

  return (
    <>
      {/* ── Tools ─────────────────────────────────────────────────────────── */}
      <Group id="tools" label="Tools" tier={tier.tools} declaredWidth={W("tools")} icon="pen">
        <Cmd id="draw.tools.pen" tier={big} />
        <Cmd id="draw.tools.brush" tier={big} />
        <Cmd id="draw.tools.line" tier={big} />
        {big === "full" ? (
          <CmdSplit id={shape.id} active={shapeArmed} menuTitle="Choose a shape tool"
            menu={() => (
              <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP, padding: 6, minWidth: 150 }}>
                {SHAPES.map(s => <CmdMenuItem key={s.id} id={s.id} />)}
              </div>
            )} />
        ) : (
          <CmdDropdown id={shape.id} active={shapeArmed}
            menu={() => SHAPES.map(s => <CmdMenuItem key={s.id} id={s.id} />)} />
        )}
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="draw.tools.spray" full />
          <CmdSmall id="draw.tools.fill" full />
          <CmdSmall id="draw.tools.eyedropper" full label="Pick" />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Brush ─────────────────────────────────────────────────────────── */}
      <Group id="brush" label="Brush" tier={tier.brush} declaredWidth={W("brush")} icon="brush">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          {/* audit H7: `inert` (not just opacity/pointerEvents) keeps a dimmed row out of the tab order. */}
          <CmdSetting id="draw.brush.size"><div style={{ ...(sizeApplies ? null : { opacity: 0.35, pointerEvents: "none" as const }) }} inert={!sizeApplies || undefined}>
            {isSpray ? (
              <SliderRow label="Density" min={5} max={100} step={5} accent={ACCENT.primary}
                value={Math.round(p.sprayDensity * 100)} onChange={v => p.setSprayDensity(v / 100)}
                format={v => `${v}%`} labelWidth={44}
                title="Fraction of the brush footprint sprayed per stamp (hold to build up)" />
            ) : (
              <Segmented ariaLabel="Brush size" label="Size" accent={ACCENT.primary}
                value={String(p.brushSize)} onChange={v => p.setBrushSize(Number(v))}
                options={[1, 3, 5, 7, 9].map(n => ({ id: String(n), label: String(n), title: `${n}-block brush` }))} />
            )}
          </div></CmdSetting>
          <CmdSetting id="draw.brush.shape"><div style={{ ...(shapeApplies ? null : { opacity: 0.35, pointerEvents: "none" as const }) }} inert={!shapeApplies || undefined}>
            <Segmented ariaLabel="Brush shape" label="Shape" accent={ACCENT.primary}
              value={p.brushShape} onChange={p.setBrushShape}
              options={[
                { id: "sq", label: "", icon: "rect", title: "Square brush" },
                { id: "circ", label: "", icon: "ellipse", title: "Round brush" },
              ]} />
          </div></CmdSetting>
          <CmdSmall id="draw.brush.stabilize" full check />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Options ───────────────────────────────────────────────────────── */}
      <Group id="options" label="Options" tier={tier.options} declaredWidth={W("options")} icon="settings">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSetting id="draw.options.filled"><Segmented ariaLabel="Shape fill" value={p.drawFilled ? "filled" : "hollow"} accent={ACCENT.primary}
            onChange={v => p.setDrawFilled(v === "filled")}
            options={[
              { id: "filled", label: "Filled", title: "Shapes are solid" },
              { id: "hollow", label: "Hollow", title: "Shapes are outlines only" },
            ]} /></CmdSetting>
          <CmdSetting id="draw.options.height"><Segmented ariaLabel="Draw height" value={p.drawAbove ? "above" : "surface"} accent={ACCENT.primary}
            onChange={v => p.setDrawAbove(v === "above")}
            options={[
              { id: "surface", label: "Surface", title: "Replace the topmost block of each column" },
              { id: "above", label: "+1 Above", title: "Stack one block above each column's surface" },
            ]} /></CmdSetting>
          <Caption>{p.drawAbove ? "Stacking above the surface" : "Replacing the surface block"}</Caption>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Block ─────────────────────────────────────────────────────────── */}
      <BlockButton cmd="draw.block.pick" tier={tier.block} declaredWidth={W("block")} />
      <GroupDivider />

      {/* ── Mask ──────────────────────────────────────────────────────────── */}
      <Group id="mask" label="Mask" tier={tier.mask} declaredWidth={W("mask")} icon="filter">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="draw.mask.toggle" full check />
          <Row style={{ opacity: p.maskEnabled ? 1 : 0.35, pointerEvents: p.maskEnabled ? "auto" : "none", height: SMALL_H }} inert={!p.maskEnabled || undefined}>
            <FieldLabel width={30}>Type</FieldLabel>
            <Select<string> ariaLabel="Mask block type" width={104}
              value={p.maskBlockType == null ? "" : String(p.maskBlockType)}
              onChange={id => p.setMaskBlockType(id === "" ? null : Number(id))}
              options={MASK_BLOCK_OPTIONS} />
          </Row>
          <Row style={{ opacity: p.maskEnabled ? 1 : 0.35, pointerEvents: p.maskEnabled ? "auto" : "none", height: SMALL_H }} inert={!p.maskEnabled || undefined}>
            <FieldLabel width={30}>Paint</FieldLabel>
            <Select<string> ariaLabel="Mask paint" width={104}
              value={p.maskPaint == null ? "" : String(p.maskPaint)}
              onChange={id => p.setMaskPaint(id === "" ? null : Number(id))}
              options={MASK_PAINT_OPTIONS} />
          </Row>
        </Col>
      </Group>
    </>
  );
}
