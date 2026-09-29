/**
 * VIEW — changes what you see, never the world data.
 *
 * The z-slice / cutaway-cap slider is no longer a ribbon group (Stage 16.6): it's the Cutaway /
 * Z-slice context panel (`windows/modePanels.tsx`), so this tab's solver input is static.
 */
import { useMemo } from "react";
import { contentTier } from "../layout";
import { tabMetrics, specWidth, solveRow } from "../specs";
import { useRibbon } from "../context";
import { TextureGroup } from "../PaletteGroup";
import { Cmd, CmdSmall } from "../Cmd";
import { Badge, Col, Group, GroupDivider } from "../primitives";
import { GROUP_CONTENT_H } from "../tokens";

const SPECS = tabMetrics("view");
const W = (g: string) => specWidth("view", g);

export default function ViewTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveRow(SPECS, bodyWidth), [bodyWidth]);

  const big = contentTier(tier.mapview);

  return (
    <>
      {/* ── Map View ──────────────────────────────────────────────────────── */}
      <Group id="mapview" label="Map View" tier={tier.mapview} declaredWidth={W("mapview")} icon="topdown">
        <Cmd id="view.mapview.topdown" tier={big} />
        <Cmd id="view.mapview.zslice" tier={big} />
        <Cmd id="view.mapview.cutaway" tier={big} />
      </Group>
      <GroupDivider />

      {/* ── Render ────────────────────────────────────────────────────────── */}
      {/* Relief (13.2) is a shading toggle layered on Tiled, not a render mode. */}
      <Group id="render" label="Render" tier={tier.render} declaredWidth={W("render")} icon="tiled">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="view.render.tiled" full />
          <CmdSmall id="view.render.relief" full />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Zoom ──────────────────────────────────────────────────────────── */}
      <Group id="zoom" label="Zoom" tier={tier.zoom} declaredWidth={W("zoom")} icon="fit">
        <Cmd id="view.zoom.fit" tier={contentTier(tier.zoom)} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="view.zoom.selection" full iconOnly />
          <CmdSmall id="view.zoom.in" full iconOnly />
          <CmdSmall id="view.zoom.out" full iconOnly />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Layout (Stage 14.4) ───────────────────────────────────────────── */}
      <Group id="layout" label="Layout" tier={tier.layout} declaredWidth={W("layout")} icon="windows">
        <Cmd id="view.layout.swap" tier={contentTier(tier.layout)} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="view.layout.reset" full />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Windows (Stage 14.4, +lens 14.9) ─────────────────────────────── */}
      <Group id="windows" label="Windows" tier={tier.windows} declaredWidth={W("windows")} icon="windows">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="view.windows.view3d" full check icon={p.swapped ? "topdown" : "pane3d"} />
          <CmdSmall id="view.windows.hotbar" full check />
          <CmdSmall id="view.windows.lens" full check />
        </Col>
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="view.windows.tools" full check />
          <CmdSmall id="view.windows.signs" full check />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Template ──────────────────────────────────────────────────────── */}
      <Group id="template" label={<>Template <Badge /></>} name="Template" tier={tier.template} declaredWidth={W("template")} icon="template">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="view.template.load" full
            badge={p.templateLoaded ? <Badge tone="ok" style={{ marginLeft: "auto" }} /> : undefined} />
          {p.templateLoaded && <CmdSmall id="view.template.overlay" full check />}
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Textures — one shared component, mirrored on the 3D tab ───────── */}
      <TextureGroup tier={tier.textures} declaredWidth={W("textures")} />
    </>
  );
}
