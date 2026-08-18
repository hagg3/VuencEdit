/**
 * DRAW — place blocks by hand in 2D. Sculpt's 16 tools and four parameter groups moved out to
 * their own tab, which is what brought this one back under MS's seven-group ceiling.
 */
import { useMemo, useState } from "react";
import { BLOCK_DEFS, NEW_FORMAT_BLOCKS } from "../../blockDefs";
import type { Tool } from "../../MapCanvas";
import { solveLayout, type GroupMetrics } from "../layout";
import { useRibbon } from "../context";
import PaletteGroup from "../PaletteGroup";
import {
  Caption, Col, CommandButton, DropdownButton, FieldLabel, Group, GroupDivider, MenuItem, Row,
  Segmented, SliderRow, SmallButton, SplitButton,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H, ROW_GAP, SMALL_H, TEXT, fieldStyle } from "../tokens";
import type { IconName } from "../icons";

const SPECS: GroupMetrics[] = [
  { id: "tools", widths: { full: 330, medium: 180, compact: 44 }, minTier: "medium", priority: 0 },
  { id: "brush", widths: { full: 214, medium: 150, compact: 44 }, minTier: "compact", priority: 2 },
  { id: "options", widths: { full: 150, medium: 118, compact: 44 }, minTier: "compact", priority: 3 },
  { id: "palette", widths: { full: 264, medium: 168, compact: 44 }, minTier: "medium", priority: 1 },
  { id: "mask", widths: { full: 190, medium: 120, compact: 44 }, minTier: "compact", priority: 4 },
];

const SHAPES: { id: Tool; label: string; icon: IconName; key: string; title: string }[] = [
  { id: "rect", label: "Rect", icon: "rect", key: "R", title: "Rectangle — drag to draw" },
  { id: "ellipse", label: "Ellipse", icon: "ellipse", key: "E", title: "Ellipse — drag to draw" },
  { id: "polygon", label: "Polygon", icon: "polygon", key: "G", title: "Polygon — click vertices, Escape cancels" },
];

export default function DrawTab() {
  const { p, bodyWidth, armTransientTool } = useRibbon();
  const tier = useMemo(() => solveLayout(SPECS, bodyWidth), [bodyWidth]);
  const big = tier.tools === "full" ? "full" : "medium";

  // Face of the Shape split button: the last shape actually used, so the button is a real command
  // rather than a menu you must open twice.
  const [lastShape, setLastShape] = useState<Tool>("rect");
  const shape = SHAPES.find(s => s.id === p.tool) ?? SHAPES.find(s => s.id === lastShape)!;
  const armShape = (t: Tool) => { setLastShape(t); p.setTool(t); };

  const isSpray = p.tool === "spray";
  const sizeApplies = p.tool === "brush" || p.tool === "spray" || p.tool === "line";
  const shapeApplies = !p.isSculptTool && p.tool !== "fill" && p.tool !== "eyedropper";
  const stabilizerApplies = p.tool === "pen" || p.tool === "brush" || p.tool === "spray";

  return (
    <>
      {/* ── Tools ─────────────────────────────────────────────────────────── */}
      <Group id="tools" label="Tools" tier={tier.tools} declaredWidth={330} icon="pen">
        <CommandButton tier={big} icon="pen" label="Pen" accent={ACCENT.primary} title="Pen — freehand, one block wide (P)"
          onClick={() => p.setTool("pen")} active={p.tool === "pen"} />
        <CommandButton tier={big} icon="brush" label="Brush" accent={ACCENT.primary} title="Brush — freehand with a sized footprint (B)"
          onClick={() => p.setTool("brush")} active={p.tool === "brush"} />
        <CommandButton tier={big} icon="line" label="Line" accent={ACCENT.primary} title="Line — drag from start to end (L)"
          onClick={() => p.setTool("line")} active={p.tool === "line"} />
        {tier.tools === "full" ? (
          <SplitButton
            icon={shape.icon} label={shape.label} accent={ACCENT.primary}
            title={`${shape.title} (${shape.key})`}
            menuTitle="Choose a shape tool"
            onClick={() => armShape(shape.id)}
            active={SHAPES.some(s => s.id === p.tool)}
            menu={() => (
              <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP, padding: 6, minWidth: 150 }}>
                {SHAPES.map(s => (
                  <MenuItem key={s.id} icon={s.icon} label={s.label} title={s.title} shortcut={s.key}
                    active={p.tool === s.id} onClick={() => armShape(s.id)} />
                ))}
              </div>
            )}
          />
        ) : (
          <DropdownButton icon={shape.icon} label={shape.label} title={shape.title} accent={ACCENT.primary}
            active={SHAPES.some(s => s.id === p.tool)}
            menu={() => SHAPES.map(s => (
              <MenuItem key={s.id} icon={s.icon} label={s.label} title={s.title} shortcut={s.key}
                active={p.tool === s.id} onClick={() => armShape(s.id)} />
            ))} />
        )}
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="spray" label="Spray" full accent={ACCENT.primary} title="Spray — scattered stamps, hold to build up"
            onClick={() => p.setTool("spray")} active={p.tool === "spray"} />
          <SmallButton icon="bucket" label="Fill" full accent={ACCENT.primary} title="Fill Bucket — flood fill matching blocks (F)"
            onClick={() => p.setTool("fill")} active={p.tool === "fill"} />
          <SmallButton icon="eyedropper" label="Pick" full accent={ACCENT.primary} title="Eyedropper — sample a block from the map (I)"
            onClick={() => armTransientTool("eyedropper", "pen")} active={p.tool === "eyedropper"} />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Brush ─────────────────────────────────────────────────────────── */}
      <Group id="brush" label="Brush" tier={tier.brush} declaredWidth={214} icon="brush">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <div style={{ ...(sizeApplies ? null : { opacity: 0.35, pointerEvents: "none" as const }) }}>
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
          </div>
          <div style={{ ...(shapeApplies ? null : { opacity: 0.35, pointerEvents: "none" as const }) }}>
            <Segmented ariaLabel="Brush shape" label="Shape" accent={ACCENT.primary}
              value={p.brushShape} onChange={p.setBrushShape}
              options={[
                { id: "sq", label: "", icon: "rect", title: "Square brush" },
                { id: "circ", label: "", icon: "ellipse", title: "Round brush" },
              ]} />
          </div>
          <SmallButton icon="smooth" label={p.strokeStabilizer ? "Stabilize ✓" : "Stabilize"} full accent={ACCENT.primary}
            active={p.strokeStabilizer} disabled={!stabilizerApplies}
            title="Stabilizer — low-passes hand jitter on freehand strokes. The brush trails slightly behind the cursor while drawing; that lag is the smoothing, not a stall."
            onClick={() => p.setStrokeStabilizer(!p.strokeStabilizer)} />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Options ───────────────────────────────────────────────────────── */}
      <Group id="options" label="Options" tier={tier.options} declaredWidth={150} icon="settings">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Segmented ariaLabel="Shape fill" value={p.drawFilled ? "filled" : "hollow"} accent={ACCENT.primary}
            onChange={v => p.setDrawFilled(v === "filled")}
            options={[
              { id: "filled", label: "Filled", title: "Shapes are solid" },
              { id: "hollow", label: "Hollow", title: "Shapes are outlines only" },
            ]} />
          <Segmented ariaLabel="Draw height" value={p.drawAbove ? "above" : "surface"} accent={ACCENT.primary}
            onChange={v => p.setDrawAbove(v === "above")}
            options={[
              { id: "surface", label: "Surface", title: "Replace the topmost block of each column" },
              { id: "above", label: "+1 Above", title: "Stack one block above each column's surface" },
            ]} />
          <Caption>{p.drawAbove ? "Stacking above the surface" : "Replacing the surface block"}</Caption>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Palette ───────────────────────────────────────────────────────── */}
      <PaletteGroup variant={tier.palette === "full" ? "full" : "compact"} pickerKind="block-draw"
        tier={tier.palette} declaredWidth={264} />
      <GroupDivider />

      {/* ── Mask ──────────────────────────────────────────────────────────── */}
      <Group id="mask" label="Mask" tier={tier.mask} declaredWidth={190} icon="filter">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="filter" label={p.maskEnabled ? "Mask ✓" : "Mask"} full accent={ACCENT.primary}
            active={p.maskEnabled} onClick={() => p.setMaskEnabled(!p.maskEnabled)}
            title="Restrict every stroke to blocks matching the type/paint below — draw only over stone, only over grass, etc." />
          <Row style={{ opacity: p.maskEnabled ? 1 : 0.35, pointerEvents: p.maskEnabled ? "auto" : "none", height: SMALL_H }}>
            <FieldLabel width={30}>Type</FieldLabel>
            <select aria-label="Mask block type" value={p.maskBlockType ?? ""}
              onChange={e => p.setMaskBlockType(e.target.value === "" ? null : Number(e.target.value))}
              style={{ ...fieldStyle, width: 104, textAlign: "left", color: TEXT }}>
              <option value="">any</option>
              {BLOCK_DEFS.map(b => <option key={b.type} value={b.type}>{b.name}</option>)}
              {NEW_FORMAT_BLOCKS.map(b => <option key={b.type} value={b.type}>{b.name}</option>)}
            </select>
          </Row>
          <Row style={{ opacity: p.maskEnabled ? 1 : 0.35, pointerEvents: p.maskEnabled ? "auto" : "none", height: SMALL_H }}>
            <FieldLabel width={30}>Paint</FieldLabel>
            <select aria-label="Mask paint" value={p.maskPaint ?? ""}
              onChange={e => p.setMaskPaint(e.target.value === "" ? null : Number(e.target.value))}
              style={{ ...fieldStyle, width: 104, textAlign: "left", color: TEXT }}>
              <option value="">any</option>
              <option value="0">none</option>
              {Array.from({ length: 54 }, (_, i) => i + 1).map(n => <option key={n} value={n}>#{n}</option>)}
            </select>
          </Row>
        </Col>
      </Group>
    </>
  );
}
