/**
 * 3D — contextual on the fly-through pane. Mode ownership is the organizing idea: everything to
 * the right of the Mode group is contextual on which mode is armed.
 *
 * The mode slot keeps a fixed `minWidth` so Camera/Lighting/Textures never slide sideways as the
 * slot switches between Flood Fill / Palette / Sculpt.
 */
import { useMemo, useState } from "react";
import { solveLayout, type GroupMetrics } from "../layout";
import { useRibbon } from "../context";
import PaletteGroup, { TextureGroup } from "../PaletteGroup";
import { SCULPT_ALL, SCULPT_MORE, SCULPT_PRIMARY } from "../sculptTools";
import {
  Badge, Caption, Col, CommandButton, FieldLabel, Group, GroupDivider, IconButton, NumField, Row,
  SliderRow, SmallButton,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H, ROW_GAP, SMALL_H, TEXT_ARMED, TEXT_DIM } from "../tokens";
// M1: shared with FlyView3D's own in-pane slider and SettingsModal — the ribbon slider used to allow
// 1–16, below the pane's own 2–32 floor/ceiling, so a value set in Settings got silently clamped down
// the next time this slider was touched.
import { MAX_RENDER_DISTANCE, RD_MIN } from "../../FlyView3D";

const AMBER = ACCENT.warm;
/** Everything spatial about the pane itself — camera, distance, the 3D-only modes. */
const SPATIAL = ACCENT.violet;
// Wide enough for the *widest* slot occupant (Sculpt: a 2×8 tool grid plus three sliders), so
// Camera/Lighting/Textures never slide sideways when the mode changes. Flood Fill and the Build
// palette are both narrower and simply sit left-aligned inside it.
const MODE_SLOT_MIN = 416;

const SPECS: GroupMetrics[] = [
  { id: "mode", widths: { full: 320, medium: 178, compact: 44 }, minTier: "medium", priority: 0 },
  { id: "slot", widths: { full: MODE_SLOT_MIN, medium: MODE_SLOT_MIN, compact: MODE_SLOT_MIN }, minTier: "full", priority: 1 },
  { id: "camera", widths: { full: 208, medium: 150, compact: 44 }, minTier: "compact", priority: 3 },
  { id: "lighting", widths: { full: 290, medium: 190, compact: 44 }, minTier: "compact", priority: 2 },
  { id: "textures", widths: { full: 158, medium: 120, compact: 44 }, minTier: "compact", priority: 4 },
];

const MODES: { id: "off" | "select" | "build" | "sculpt" | "floodfill"; label: string; icon: "camera" | "select" | "build" | "sculpt" | "floodfill"; accent: string; title: string }[] = [
  // Accents name the *family the mode hands you*, not the mode: Build and Flood Fill write blocks
  // (draw), Sculpt reshapes terrain (warm), Camera and Select only move you around (spatial).
  { id: "off", label: "Camera", icon: "camera", accent: SPATIAL, title: "Camera only — click/drag orbits or flies" },
  { id: "select", label: "Select", icon: "select", accent: SPATIAL, title: "Click two blocks to define a 3D selection box" },
  { id: "build", label: "Build", icon: "build", accent: ACCENT.primary, title: "Left-click breaks the block you're aiming at; right-click places the armed block against that face" },
  { id: "sculpt", label: "Sculpt", icon: "sculpt", accent: AMBER, title: "Press and hold left to sculpt the terrain under the crosshair" },
  { id: "floodfill", label: "Flood Fill", icon: "floodfill", accent: ACCENT.primary, title: "Click a block face to flood the connected air across and down with the armed block" },
];

export default function ThreeDTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveLayout(SPECS, bodyWidth), [bodyWidth]);
  const big = tier.mode === "full" ? "full" : "medium";

  // Drag-time display values (see ViewTab's note) — a slider drag re-renders only this tab.
  const [sunDisplay, setSunDisplay] = useState(p.sunT);
  const [prevSun, setPrevSun] = useState(p.sunT);
  if (prevSun !== p.sunT) { setPrevSun(p.sunT); setSunDisplay(p.sunT); }
  const [lampDisplay, setLampDisplay] = useState(p.lampRadius);
  const [prevLamp, setPrevLamp] = useState(p.lampRadius);
  if (prevLamp !== p.lampRadius) { setPrevLamp(p.lampRadius); setLampDisplay(p.lampRadius); }
  const [flyDisplay, setFlyDisplay] = useState(p.flySpeed);
  const [prevFly, setPrevFly] = useState(p.flySpeed);
  if (prevFly !== p.flySpeed) { setPrevFly(p.flySpeed); setFlyDisplay(p.flySpeed); }
  const [distDisplay, setDistDisplay] = useState(p.renderDistance);
  const [prevDist, setPrevDist] = useState(p.renderDistance);
  if (prevDist !== p.renderDistance) { setPrevDist(p.renderDistance); setDistDisplay(p.renderDistance); }

  const sunActive = p.shadows3d || p.gpuShadows;
  const armedSculpt = SCULPT_ALL.find(t => t.id === p.tool);

  return (
    <>
      {/* ── Mode ──────────────────────────────────────────────────────────── */}
      <Group id="mode" label="Mode" tier={tier.mode} declaredWidth={320} icon="camera">
        {MODES.map(m => (
          <CommandButton key={m.id} tier={big} icon={m.icon} label={m.label} title={m.title} accent={m.accent}
            onClick={() => p.setMode3d(m.id)} active={p.mode3d === m.id} />
        ))}
      </Group>
      <GroupDivider />

      {/* ── Mode slot — fixed width so its neighbours never shift ─────────── */}
      <div style={{ display: "flex", alignItems: "stretch", minWidth: MODE_SLOT_MIN }}>
        {p.mode3d === "floodfill" ? (
          <Group id="slot" label={<>Flood Fill <Badge /></>} tier="full" icon="floodfill">
            <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
              <SliderRow label="Limit" min={50} max={10000} step={50} accent={ACCENT.primary} width={110} labelWidth={34}
                value={p.floodFillLimit} onChange={p.setFloodFillLimit}
                title="Maximum air cells filled per click" />
              <Row style={{ height: SMALL_H }}>
                <FieldLabel width={34}>Exact</FieldLabel>
                <NumField min={1} max={200000} value={p.floodFillLimit} onChange={p.setFloodFillLimit}
                  ariaLabel="Flood fill limit" width={64} />
              </Row>
              <Caption>Fills with the armed Palette block</Caption>
            </Col>
          </Group>
        ) : p.mode3d === "sculpt" ? (
          <Group id="slot" label={<>Sculpt brush <Badge /></>} tier="full" icon="sculpt">
            <Col style={{ height: GROUP_CONTENT_H, justifyContent: "space-between" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, auto)", gap: ROW_GAP }}>
                {[...SCULPT_PRIMARY, ...SCULPT_MORE].map(t => (
                  <IconButton key={t.id} icon={t.icon} label={t.label} title={t.title} accent={AMBER}
                    onClick={() => p.setTool(t.id)} active={p.tool === t.id} />
                ))}
              </div>
              <Caption tone={armedSculpt ? TEXT_ARMED : TEXT_DIM}>{armedSculpt ? armedSculpt.label : "pick a tool"}</Caption>
            </Col>
            <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
              <SliderRow label={p.tool === "terrace" ? "Step" : "Strength"} min={1} max={8} accent={AMBER}
                value={p.sculptStrength} onChange={p.setSculptStrength} />
              <SliderRow label="Radius" min={1} max={32} accent={AMBER}
                value={p.sculptRadius} onChange={p.setSculptRadius} title="Brush radius in blocks" />
              <SliderRow label="Softness" min={0} max={100} step={5} accent={AMBER}
                value={Math.round(p.sculptSoftness * 100)} onChange={v => p.setSculptSoftness(v / 100)}
                format={v => `${v}%`} />
            </Col>
          </Group>
        ) : (
          <PaletteGroup
            variant="full" pickerKind="build-3d" label="Build Block"
            dim={p.mode3d !== "build"} dimNote="(Build mode only)"
            extraRow={
              <SmallButton icon="autoOrient" full accent={ACCENT.primary} active={p.autoOrient3d}
                label={p.autoOrient3d ? "Auto-orient ✓" : "Auto-orient"}
                title="Auto-orient ramps, wedges and doors to your facing when placing. Off = they keep the orientation picked here."
                onClick={() => p.setAutoOrient3d(!p.autoOrient3d)} />
            } />
        )}
      </div>
      <GroupDivider />

      {/* ── Camera — per-session view controls, previously Settings-only ──── */}
      <Group id="camera" label="Camera" tier={tier.camera} declaredWidth={208} icon="camera">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SliderRow label="Fly speed" min={2} max={60} accent={SPATIAL} labelWidth={54}
            value={flyDisplay} onChange={setFlyDisplay} onCommit={p.commitFlySpeed}
            title="Movement speed in fly/look mode, in blocks per second" />
          <SliderRow label="Distance" min={RD_MIN} max={MAX_RENDER_DISTANCE} accent={SPATIAL} labelWidth={54}
            value={distDisplay} onChange={setDistDisplay} onCommit={p.commitRenderDistance}
            title="Chunk render distance. Cost rises quadratically — this is the main 3D performance dial." />
          <Caption>Applies to the fly-through pane</Caption>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Lighting ──────────────────────────────────────────────────────── */}
      <Group id="lighting" label="Lighting" tier={tier.lighting} declaredWidth={290} icon="night">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="night" full accent={AMBER} active={p.nightLighting}
            label="Night Lighting" badge={<Badge tone="perf" style={{ marginLeft: "auto" }} />}
            title="Lamp point-lighting for the 3D pane. Performance-intensive: rebuilds all loaded chunk geometry with a per-voxel lamp pass (in GPU mode, forward-lights up to 16 point lights instead)."
            onClick={() => p.setNightLighting(!p.nightLighting)} />
          <SmallButton icon="shadows" full accent={AMBER} active={p.shadows3d && !p.gpuShadows} disabled={p.gpuShadows}
            label="Baked Shadows" badge={<Badge tone="perf" style={{ marginLeft: "auto" }} />}
            title={p.gpuShadows
              ? "Overridden by GPU Shadows"
              : "Baked sun shadows. Performance-intensive: a per-voxel sun raymarch runs on every chunk rebuild, and moving the Sun slider reloads every loaded chunk."}
            onClick={() => p.setShadows3d(!p.shadows3d)} />
          <SmallButton icon="gpuShadows" full accent={SPATIAL} active={p.gpuShadows}
            label="GPU Shadows" badge={<Badge tone="perf" style={{ marginLeft: "auto" }} />}
            title="Real GPU shadow map (lit material + directional sun). Performance-intensive: a 2048–4096² shadow map renders every frame and every mesh casts/receives; cost rises sharply with render distance. Overrides the baked previews; the Sun slider is then free."
            onClick={() => p.setGpuShadows(!p.gpuShadows)} />
        </Col>
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SliderRow label="Sun" min={0} max={1} step={0.01} accent={p.gpuShadows ? SPATIAL : AMBER}
            labelWidth={32} width={68} disabled={!sunActive}
            value={sunDisplay} onChange={setSunDisplay} onCommit={p.commitSunT}
            format={v => `${Math.round(v * 100)}%`}
            title={sunActive ? "Sun angle: 0 = sunrise, 0.5 = noon, 1 = sunset" : "Turn on Shadows or GPU Shadows — the sun angle only affects shadowed lighting"} />
          <SliderRow label="Lamp R" min={2} max={32} accent={AMBER} labelWidth={44} width={68}
            disabled={!p.nightLighting}
            value={lampDisplay} onChange={setLampDisplay} onCommit={p.commitLampRadius}
            title={p.nightLighting ? "Lamp light radius, in blocks" : "Turn on Night Lighting — lamps only cast light at night"} />
          <Row style={{ height: SMALL_H, opacity: p.nightLighting ? 1 : 0.35, pointerEvents: p.nightLighting ? "auto" : "none" }}>
            <SmallButton label="Legacy" accent={AMBER} active={p.lightingProfile === "legacy"}
              onClick={() => p.commitLightingProfile("legacy")}
              title="Legacy falloff: ~4-tile radius, steep. Switching snaps Lamp R to this profile's default." />
            <SmallButton label="New Dawn" accent={AMBER} active={p.lightingProfile === "modern"}
              onClick={() => p.commitLightingProfile("modern")}
              title="Modern/New Dawn falloff: ~14-tile radius, gradual. Switching snaps Lamp R to this profile's default." />
          </Row>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Textures — the same component the View tab renders ────────────── */}
      <TextureGroup tier={tier.textures} declaredWidth={158} />
    </>
  );
}
