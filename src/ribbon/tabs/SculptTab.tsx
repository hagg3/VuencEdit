/**
 * SCULPT — reshape terrain. Split out of Draw: 16 tools plus Brush/Falloff/Noise/Slope/Rock
 * parameter groups had pushed that tab to 8+ groups, and sculpting is a distinct system anyway
 * (heightmap + volumetric SDF, its own float session, its own undo grouping).
 */
import { useMemo, useState } from "react";
import type { Tool } from "../../MapCanvas";
import { contentTier } from "../layout";
import { tabMetrics, specWidth, solveRow } from "../specs";
import { useRibbon } from "../context";
import BlockButton from "../BlockButton";
import { Cmd, CmdDropdown, CmdMenuItem, CmdSetting, CmdSplit } from "../Cmd";
import type { CommandId } from "../../commands/meta";
import { SCULPT_MORE, SCULPT_PRIMARY, SCULPT_IS_VOLUMETRIC, SCULPT_USES_PALETTE, SCULPT_IS_EXPERIMENTAL } from "../sculptTools";
import {
  Badge, Col, Group, GroupDivider, Row, Segmented, SliderRow,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H } from "../tokens";

/** Sculpt is the `warm` tool family — one hue for all 16 tools and every parameter they own. */
const AMBER = ACCENT.warm;

// Noise/Slope/Rock/Carve's shape parameters are the Brush shape context panel now (Stage 16.6,
// `windows/modePanels.tsx`), so this tab's solver input is static.
const SPECS = tabMetrics("sculpt");
const W = (g: string) => specWidth("sculpt", g);

/** Every sculpt tool's registry id is `sculpt.tools.<tool>` (meta.ts, one per tool). */
const cmdOf = (t: Tool) => `sculpt.tools.${t}` as CommandId;

export default function SculptTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveRow(SPECS, bodyWidth), [bodyWidth]);
  const big = contentTier(tier.tools);
  const volumetric = SCULPT_IS_VOLUMETRIC(p.tool);

  // Face of the "More tools" split button: the last one of the 12 secondary tools actually used,
  // so the button is a real one-click repeat rather than a menu you must open every time (mirrors
  // the Draw tab's Shape split button).
  const [lastMore, setLastMore] = useState<Tool>(SCULPT_MORE[0].id);
  if (SCULPT_MORE.some(t => t.id === p.tool) && p.tool !== lastMore) setLastMore(p.tool);
  const moreArmed = SCULPT_MORE.some(t => t.id === p.tool);

  return (
    <>
      {/* ── Tools ─────────────────────────────────────────────────────────── */}
      <Group id="tools" label="Sculpt tools" tier={tier.tools} declaredWidth={W("tools")} icon="sculpt">
        {SCULPT_PRIMARY.map(t => <Cmd key={t.id} id={cmdOf(t.id)} tier={big} />)}
        {big === "full" ? (
          <CmdSplit id={cmdOf(lastMore)} active={moreArmed} menuTitle="More sculpt tools"
            menu={() => (
              <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: 6, minWidth: 170 }}>
                {SCULPT_MORE.map(t => (
                  <CmdMenuItem key={t.id} id={cmdOf(t.id)} after={SCULPT_IS_EXPERIMENTAL(t.id) ? <Badge /> : undefined} />
                ))}
              </div>
            )} />
        ) : (
          <CmdDropdown id={cmdOf(lastMore)} active={moreArmed}
            menu={() => SCULPT_MORE.map(t => <CmdMenuItem key={t.id} id={cmdOf(t.id)} />)} />
        )}
      </Group>
      <GroupDivider />

      {/* ── Brush ─────────────────────────────────────────────────────────── */}
      <Group id="brush" label="Brush" tier={tier.brush} declaredWidth={W("brush")} icon="brush"
        dim={volumetric} dimNote={volumetric ? "(radius only)" : undefined}>
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSetting id="sculpt.brush.strength"><SliderRow label={p.tool === "terrace" ? "Step" : "Strength"} min={1} max={8} accent={AMBER}
            value={p.sculptStrength} onChange={p.setSculptStrength}
            title={p.tool === "terrace" ? "Terrace step height, in blocks" : "How far each stamp moves the terrain"} /></CmdSetting>
          <CmdSetting id="sculpt.brush.radius"><SliderRow label="Radius" min={1} max={32} accent={AMBER}
            value={p.sculptRadius} onChange={p.setSculptRadius}
            title="Brush radius in blocks ([ and ])" /></CmdSetting>
          <CmdSetting id="sculpt.brush.softness"><SliderRow label="Softness" min={0} max={100} step={5} accent={AMBER}
            value={Math.round(p.sculptSoftness * 100)} onChange={v => p.setSculptSoftness(v / 100)}
            format={v => `${v}%`}
            title="Edge softness: 0 is a hard edge, 100 a soft dome" /></CmdSetting>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Falloff ───────────────────────────────────────────────────────── */}
      <Group id="falloff" label="Falloff" tier={tier.falloff} declaredWidth={W("falloff")} icon="smooth">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSetting id="sculpt.falloff.profile"><Segmented ariaLabel="Falloff profile" label="Profile" value={p.sculptProfile} accent={AMBER}
            onChange={p.setSculptProfile}
            options={[
              { id: "smooth", label: "Smooth", title: "Cosine dome (default)" },
              { id: "linear", label: "Linear", title: "Straight cone" },
              { id: "sphere", label: "Sphere", title: "Spherical cap, wide centre" },
              { id: "sharp", label: "Sharp", title: "Nearly flat-topped, hard rim" },
            ]} /></CmdSetting>
          <Row>
            <Cmd id="sculpt.falloff.live" tier="medium" check />
            <Cmd id="sculpt.falloff.clip" tier="medium" check />
          </Row>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Block — only Rock and Retexture consume the fill block ────────── */}
      <BlockButton cmd="sculpt.block.pick" tier={tier.block} declaredWidth={W("block")}
        dim={!SCULPT_USES_PALETTE(p.tool)} dimNote="(Rock/Retexture only)" />
    </>
  );
}
