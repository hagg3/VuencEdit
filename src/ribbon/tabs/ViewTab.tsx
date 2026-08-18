/**
 * VIEW — changes what you see, never the world data.
 *
 * The z-slice / cutaway-cap slider is the drag-time *display* value only; the (expensive) commit
 * flows on pointer-up. It lives here rather than in App so a drag re-renders one tab — an
 * improvement on the old convention, where it re-rendered the whole ribbon.
 */
import { useMemo, useState } from "react";
import { solveLayout, type GroupMetrics } from "../layout";
import { useRibbon } from "../context";
import { TextureGroup } from "../PaletteGroup";
import {
  Badge, Caption, Check, Col, CommandButton, Group, GroupDivider, Row, SliderRow, SmallButton,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H } from "../tokens";

const SPECS: GroupMetrics[] = [
  { id: "mapview", widths: { full: 228, medium: 150, compact: 44 }, minTier: "medium", priority: 0 },
  { id: "render", widths: { full: 170, medium: 128, compact: 44 }, minTier: "compact", priority: 2 },
  { id: "zoom", widths: { full: 216, medium: 148, compact: 44 }, minTier: "compact", priority: 3 },
  { id: "layout", widths: { full: 258, medium: 166, compact: 44 }, minTier: "compact", priority: 1 },
  { id: "template", widths: { full: 158, medium: 120, compact: 44 }, minTier: "compact", priority: 4 },
  { id: "textures", widths: { full: 158, medium: 120, compact: 44 }, minTier: "compact", priority: 5 },
];

export default function ViewTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveLayout(SPECS, bodyWidth), [bodyWidth]);

  // Drag-time slider value, re-synced whenever App changes the committed one out of band
  // (world load reset, follow-surface, Settings apply) — React's derived-state pattern, no effect.
  const [zDisplay, setZDisplay] = useState(p.zSliceZ);
  const [prevZ, setPrevZ] = useState(p.zSliceZ);
  if (prevZ !== p.zSliceZ) { setPrevZ(p.zSliceZ); setZDisplay(p.zSliceZ); }

  const big = tier.mapview === "full" ? "full" : "medium";
  const sliced = p.viewMode === "zslice" || p.viewMode === "cutaway";

  return (
    <>
      {/* ── Map View ──────────────────────────────────────────────────────── */}
      <Group id="mapview" label="Map View" tier={tier.mapview} declaredWidth={228} icon="topdown">
        <CommandButton tier={big} icon="topdown" label="Top-down" title="Normal top-down map — the highest block in every column"
          onClick={() => p.setViewMode("topdown")} active={p.viewMode === "topdown"} />
        <CommandButton tier={big} icon="zslice" label="Z-Slice" title="Show one horizontal layer at a time"
          onClick={() => p.setViewMode("zslice")} active={p.viewMode === "zslice"} />
        <CommandButton tier={big} icon="cutaway" label="Cutaway" accent={ACCENT.primary}
          title="Cutaway — hide everything above the cap Z. Drawing, terrain paste and the cursor readout all target the exposed surface below it, so underground work behaves like surface work."
          onClick={() => p.setViewMode("cutaway")} active={p.viewMode === "cutaway"} />
      </Group>
      <GroupDivider />

      {/* ── Render ────────────────────────────────────────────────────────── */}
      <Group id="render" label="Render" tier={tier.render} declaredWidth={170} icon="tiled">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Row>
            <SmallButton icon="tiled" label="Tiled" active={p.renderMode === "tiled"} onClick={() => p.setRenderMode("tiled")}
              title="Streamed 512px tiles — the default, best on big worlds" />
            <SmallButton icon="fullmap" label="Full" accent={ACCENT.primary} active={p.renderMode === "full"} onClick={() => p.setRenderMode("full")}
              title="One offscreen canvas for the whole map — smoothest panning, heaviest memory" />
            <SmallButton icon="axo" label="Axo" accent={ACCENT.primary} active={p.renderMode === "axo"} onClick={() => p.setRenderMode("axo")}
              title="Axonometric projection — a fake-3D overview" />
          </Row>
          {p.renderMode === "axo" ? (
            <SliderRow label="Depth" min={0} max={0.5} step={0.02} accent={ACCENT.primary} labelWidth={36}
              value={p.axoSkew} onChange={p.setAxoSkew} format={v => v.toFixed(2)}
              title="How far the axonometric projection leans" />
          ) : (
            <Caption>{p.renderMode === "tiled" ? "Streaming 512px tiles" : "Whole map in one canvas"}</Caption>
          )}
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Zoom ──────────────────────────────────────────────────────────── */}
      <Group id="zoom" label="Zoom" tier={tier.zoom} declaredWidth={216} icon="fit">
        <CommandButton tier={tier.zoom === "full" ? "full" : "medium"}
          icon="fit" label="Fit Map" title="Fit the whole world in the viewport (Home)" onClick={p.onFitMap} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="zoomSel" label="To Selection" full disabled={!p.rawBounds}
            title={p.rawBounds ? "Zoom to the selection (⌘⇧0)" : "Make a selection first"}
            onClick={p.onZoomToSelection} />
          <SmallButton icon="zoomIn" label="Zoom In" full title="Zoom in (⌘+)" onClick={p.onZoomIn} />
          <SmallButton icon="zoomOut" label="Zoom Out" full title="Zoom out (⌘−)" onClick={p.onZoomOut} />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Layout ────────────────────────────────────────────────────────── */}
      <Group id="layout" label="Layout" tier={tier.layout} declaredWidth={258} icon="quad">
        <CommandButton tier={tier.layout === "full" ? "full" : "medium"}
          icon="quad" label="Quad View" accent={ACCENT.violet} active={p.showSlicePanels}
          title="Hammer-style four-pane editor: Top + Front + Side + 3D (experimental)"
          onClick={() => p.setShowSlicePanels(!p.showSlicePanels)} />
        {/* M4: used to require Quad View first (disabled + a "turn that on first" tooltip) — the 3D
            pane's most-cited discoverability problem was two nested toggles to find it. Turning it on
            now implies Quad View too, so one click reaches the pane; turning it back off leaves Quad
            View as-is (Top/Front/Side may still be in use). */}
        <CommandButton tier={tier.layout === "full" ? "full" : "medium"}
          icon="pane3d" label="3D Pane" accent={ACCENT.violet} active={p.enable3dPane}
          title="Fly-through 3D pane in the fourth quad cell (experimental) — turns on Quad View too if it isn't already"
          onClick={() => {
            const next = !p.enable3dPane;
            if (next && !p.showSlicePanels) p.setShowSlicePanels(true);
            p.setEnable3dPane(next);
          }} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="sidebar" label={p.sidebarOpen ? "Sidebar ✓" : "Sidebar"} full active={p.sidebarOpen}
            title="Docked right sidebar: Inspector / Prefabs / Elevation / History"
            onClick={p.onToggleSidebar} />
          <SmallButton icon="quickActions" label={p.showQuickActions ? "Quick bar ✓" : "Quick bar"} full active={p.showQuickActions}
            title="Floating Quick Actions pill under the ribbon"
            onClick={p.onToggleQuickActions} />
          <SmallButton icon="signs" label={p.showSigns ? "Signs ✓" : "Signs"} full
            active={p.showSigns && p.hasSigns} disabled={!p.hasSigns}
            title={p.hasSigns
              ? "Show a marker on the map at each sign's position. Signs are listed, with their text, in the sidebar's Inspector tab — click one to jump to it."
              : "This world has no signs. Signs are written by the game; VuencEdit reads and shows them but can't place them."}
            onClick={() => p.setShowSigns(!p.showSigns)} />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Template ──────────────────────────────────────────────────────── */}
      <Group id="template" label={<>Template <Badge /></>} tier={tier.template} declaredWidth={158} icon="template">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="template" full
            label={p.templateLoaded ? "Change Template…" : "Load Template…"}
            title="Eden.eden is the pre-generated 180×180-chunk template bundled with the game. Loading it enables the surface overlay and Insert ▸ Expand."
            onClick={p.openTemplateFile}
            badge={p.templateLoaded ? <Badge tone="ok" style={{ marginLeft: "auto" }} /> : undefined} />
          {p.templateLoaded && (
            <SmallButton icon="fullmap" full label={p.showTemplateOverlay ? "Overlay ✓" : "Show Overlay"}
              active={p.showTemplateOverlay} accent={ACCENT.primary}
              title="Draw the template's surface under your world at 35% opacity (top-down view only)"
              onClick={() => p.setShowTemplateOverlay(!p.showTemplateOverlay)} />
          )}
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Textures — one shared component, mirrored on the 3D tab ───────── */}
      <TextureGroup tier={tier.textures} declaredWidth={158} />

      {/* ── Contextual tail: one slider, two meanings ─────────────────────── */}
      {sliced && (<>
        <GroupDivider />
        <Group id="zlevel" label={p.viewMode === "cutaway" ? "Cap Z" : "Z-Slice Level"} tier="full" icon="zslice">
          <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
            <SliderRow
              label={p.viewMode === "cutaway" ? "Cap" : "Level"} min={0} max={p.world?.max_z ?? 63}
              accent={ACCENT.primary} width={128} labelWidth={34}
              value={zDisplay} onChange={setZDisplay} onCommit={p.commitZSlice}
              title={p.viewMode === "cutaway" ? "Everything above this height is hidden" : "Which horizontal layer to show"} />
            {p.viewMode === "zslice" ? (
              <Check checked={p.followSurface} onChange={p.setFollowSurface} label="Follow surface"
                title="Keep the slice level pinned to the surface under the cursor" />
            ) : (
              <Caption>Everything above is hidden</Caption>
            )}
          </Col>
        </Group>
      </>)}
    </>
  );
}
