/**
 * SCULPT — reshape terrain. Split out of Draw: 16 tools plus Brush/Falloff/Noise/Slope/Rock
 * parameter groups had pushed that tab to 8+ groups, and sculpting is a distinct system anyway
 * (heightmap + volumetric SDF, its own float session, its own undo grouping).
 */
import { useMemo, useState } from "react";
import type { Tool } from "../../MapCanvas";
import { solveLayout, type GroupMetrics } from "../layout";
import { useRibbon } from "../context";
import PaletteGroup from "../PaletteGroup";
import { SCULPT_MORE, SCULPT_PRIMARY, SCULPT_IS_VOLUMETRIC, SCULPT_USES_PALETTE } from "../sculptTools";
import {
  Badge, Caption, Col, CommandButton, DropdownButton, Group, GroupDivider, MenuItem, Row, Segmented, SliderRow, SplitButton,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H } from "../tokens";

/** Sculpt is the `warm` tool family — one hue for all 16 tools and every parameter they own. */
const AMBER = ACCENT.warm;

const SPECS: GroupMetrics[] = [
  { id: "tools", widths: { full: 306, medium: 200, compact: 44 }, minTier: "medium", priority: 0 },
  { id: "brush", widths: { full: 190, medium: 150, compact: 44 }, minTier: "medium", priority: 1 },
  { id: "falloff", widths: { full: 244, medium: 160, compact: 44 }, minTier: "compact", priority: 2 },
  { id: "palette", widths: { full: 148, medium: 148, compact: 44 }, minTier: "medium", priority: 3 },
  { id: "toolopts", widths: { full: 434, medium: 300, compact: 44 }, minTier: "compact", priority: 4 },
];

export default function SculptTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveLayout(SPECS, bodyWidth), [bodyWidth]);
  const big = tier.tools === "full" ? "full" : "medium";
  const volumetric = SCULPT_IS_VOLUMETRIC(p.tool);

  // Face of the "More tools" split button: the last one of the 12 secondary tools actually used,
  // so the button is a real one-click repeat rather than a menu you must open every time (mirrors
  // the Draw tab's Shape split button).
  const [lastMore, setLastMore] = useState<Tool>(SCULPT_MORE[0].id);
  const more = SCULPT_MORE.find(t => t.id === p.tool) ?? SCULPT_MORE.find(t => t.id === lastMore)!;
  const armMore = (t: Tool) => { setLastMore(t); p.setTool(t); };

  return (
    <>
      {/* ── Tools ─────────────────────────────────────────────────────────── */}
      <Group id="tools" label={<>Sculpt tools <Badge /></>} tier={tier.tools} declaredWidth={306} icon="sculpt">
        {SCULPT_PRIMARY.map(t => (
          <CommandButton key={t.id} tier={big} icon={t.icon} label={t.label} title={t.title} accent={AMBER}
            onClick={() => p.setTool(t.id)} active={p.tool === t.id} />
        ))}
        {tier.tools === "full" ? (
          <SplitButton
            icon={more.icon} label={more.label} accent={AMBER}
            title={`${more.title} (More tools)`}
            menuTitle="More sculpt tools"
            onClick={() => armMore(more.id)}
            active={SCULPT_MORE.some(t => t.id === p.tool)}
            menu={() => (
              <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: 6, minWidth: 170 }}>
                {SCULPT_MORE.map(t => (
                  <MenuItem key={t.id} icon={t.icon} label={t.label} title={t.title}
                    active={p.tool === t.id} onClick={() => armMore(t.id)} />
                ))}
              </div>
            )}
          />
        ) : (
          <DropdownButton icon={more.icon} label={more.label} title={`${more.title} (More tools)`} accent={AMBER}
            active={SCULPT_MORE.some(t => t.id === p.tool)}
            menu={() => SCULPT_MORE.map(t => (
              <MenuItem key={t.id} icon={t.icon} label={t.label} title={t.title}
                active={p.tool === t.id} onClick={() => armMore(t.id)} />
            ))} />
        )}
      </Group>
      <GroupDivider />

      {/* ── Brush ─────────────────────────────────────────────────────────── */}
      <Group id="brush" label="Brush" tier={tier.brush} declaredWidth={190} icon="brush"
        dim={volumetric} dimNote={volumetric ? "(radius only)" : undefined}>
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SliderRow label={p.tool === "terrace" ? "Step" : "Strength"} min={1} max={8} accent={AMBER}
            value={p.sculptStrength} onChange={p.setSculptStrength}
            title={p.tool === "terrace" ? "Terrace step height, in blocks" : "How far each stamp moves the terrain"} />
          <SliderRow label="Radius" min={1} max={32} accent={AMBER}
            value={p.sculptRadius} onChange={p.setSculptRadius}
            title="Brush radius in blocks ([ and ])" />
          <SliderRow label="Softness" min={0} max={100} step={5} accent={AMBER}
            value={Math.round(p.sculptSoftness * 100)} onChange={v => p.setSculptSoftness(v / 100)}
            format={v => `${v}%`}
            title="Radial falloff — 0 = hard edges, 100 = full dome (soft rim)" />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Falloff ───────────────────────────────────────────────────────── */}
      <Group id="falloff" label="Falloff" tier={tier.falloff} declaredWidth={244} icon="smooth">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Segmented ariaLabel="Falloff profile" label="Profile" value={p.sculptProfile} accent={AMBER}
            onChange={p.setSculptProfile}
            options={[
              { id: "smooth", label: "Smooth", title: "Cosine dome — the default" },
              { id: "linear", label: "Linear", title: "Straight cone" },
              { id: "sphere", label: "Sphere", title: "Spherical cap — fat centre" },
              { id: "sharp", label: "Sharp", title: "Nearly flat-topped, hard rim" },
            ]} />
          <Row>
            <CommandButton tier="medium" icon="sparkle" label={p.sculptAccumulate ? "Live brush ✓" : "Live brush"}
              accent={AMBER} active={p.sculptAccumulate} onClick={() => p.setSculptAccumulate(!p.sculptAccumulate)}
              title={p.sculptAccumulate
                ? "Live brush ON — terrain deforms as you drag, stamps build up on dwell (airbrush). Escape reverts the whole stroke."
                : "Live brush OFF — legacy one-shot: the swept stroke commits as a single uniform shape on release."} />
            <CommandButton tier="medium" icon="select" label={p.sculptClipToSelection ? "In selection ✓" : "In selection"}
              accent={AMBER} active={p.sculptClipToSelection} onClick={() => p.setSculptClipToSelection(!p.sculptClipToSelection)}
              title="Constrain sculpt strokes to the active selection rectangle" />
          </Row>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Palette — only Rock and Retexture consume the fill block ──────── */}
      <PaletteGroup variant="compact" pickerKind="block-draw" tier={tier.palette} declaredWidth={148}
        dim={!SCULPT_USES_PALETTE(p.tool)} dimNote="(Rock/Retexture only)" />

      {/* ── Tool Options — contextual tail, so the stable groups never shift ─ */}
      {p.tool === "noise" && (<>
        <GroupDivider />
        <Group id="toolopts" label="Noise" tier="full" icon="noise">
          <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
            <Segmented ariaLabel="Noise mode" value={p.noiseMode} onChange={p.setNoiseMode} accent={AMBER}
              options={[
                { id: "hills", label: "Hills", title: "Gentle rolling terrain" },
                { id: "mountains", label: "Mountains", title: "Ridged, high-relief terrain" },
              ]} />
            <SliderRow label="Feature size" min={6} max={80} step={2} accent={AMBER} labelWidth={64}
              value={p.noiseFeatureSize} onChange={p.setNoiseFeatureSize}
              title="Wavelength of the noise, in blocks — larger = broader landforms" />
          </Col>
        </Group>
      </>)}

      {p.tool === "slope" && (<>
        <GroupDivider />
        <Group id="toolopts" label="Slope" tier="full" icon="slope">
          <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
            <SliderRow label="Slope X" min={-100} max={100} step={5} accent={AMBER} labelWidth={48}
              value={p.slopeGradeX} onChange={p.setSlopeGradeX} format={v => `${v}%`}
              title="Tilt along X — rise in blocks per 100 blocks of run" />
            <SliderRow label="Slope Y" min={-100} max={100} step={5} accent={AMBER} labelWidth={48}
              value={p.slopeGradeY} onChange={p.setSlopeGradeY} format={v => `${v}%`}
              title="Tilt along Y — rise in blocks per 100 blocks of run" />
            <Caption>Anchor is the block you press on</Caption>
          </Col>
        </Group>
      </>)}

      {volumetric && (<>
        <GroupDivider />
        {/* Eight parameters in three columns of three — the fixed content box is exactly three
            26px rows tall, so a two-column layout would spill the group label out of the ribbon. */}
        <Group id="toolopts" label={`${p.tool === "carve" ? "Carve" : "Rock"} shape — ignores Strength/Softness`}
          tier={tier.toolopts} declaredWidth={434} icon="rock">
          <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
            <SliderRow label="Noisiness" min={0} max={1} step={0.05} accent={AMBER} labelWidth={56} width={62}
              value={p.rockNoisiness} onChange={p.setRockNoisiness} format={v => v.toFixed(2)}
              title="Displacement amplitude of the surface noise, as a fraction of the fillet radius — 0 = clean squashed ellipsoid, 1 = chaotic but still connected" />
            <SliderRow label="Noise size" min={2} max={40} accent={AMBER} labelWidth={56} width={62}
              value={p.rockNoiseRadius} onChange={p.setRockNoiseRadius}
              title="Feature scale of the surface noise, in world blocks — larger = blobbier, smaller = jagged" />
            <SliderRow label="Smoothing" min={0} max={5} step={0.25} accent={AMBER} labelWidth={56} width={62}
              value={p.rockSmoothing} onChange={p.setRockSmoothing} format={v => v.toFixed(2)}
              title="Cohesion blur — turns granular noise into fewer, larger forms" />
          </Col>
          <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
            <SliderRow label="Blend" min={0} max={3} step={0.1} accent={AMBER} labelWidth={46} width={62}
              value={p.rockMeld} onChange={p.setRockMeld} format={v => v.toFixed(1)}
              title={p.tool === "carve"
                ? "Fillet radius where the cut rolls over into the surrounding terrain — no sharp rim"
                : "Fillet radius where the rock flares into the surrounding terrain — no hard seam"} />
            <SliderRow label="Flatten" min={0.2} max={1.2} step={0.05} accent={AMBER} labelWidth={46} width={62}
              value={p.rockFlatten} onChange={p.setRockFlatten} format={v => v.toFixed(2)}
              title="Vertical/horizontal ratio of the base shape — lower = squashed, never a sphere" />
            <SliderRow label="Sink" min={0} max={1} step={0.05} accent={AMBER} labelWidth={46} width={62}
              value={p.rockSink} onChange={p.setRockSink} format={v => v.toFixed(2)}
              title="Fraction of the shape's vertical half-extent buried below the anchor surface" />
          </Col>
          <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
            <SliderRow label="Drape" min={0} max={1} step={0.05} accent={AMBER} labelWidth={44} width={62}
              value={p.rockDrape} onChange={p.setRockDrape} format={v => v.toFixed(2)}
              title="How strongly the base follows local terrain height — 0 = one flat anchor height, 1 = fully terrain-conformal" />
            <SliderRow label="Strata" min={0} max={2} step={0.1} accent={AMBER} labelWidth={44} width={62}
              value={p.rockStrata} onChange={p.setRockStrata} format={v => v.toFixed(1)}
              title="Horizontal sedimentary-bedding ledges — 0 = none" />
            <Caption>Radius sets the mass size</Caption>
          </Col>
        </Group>
      </>)}
    </>
  );
}
