/**
 * 3D — contextual on the fly-through pane. Mode ownership is the organizing idea: everything to
 * the right of the Mode group is contextual on which mode is armed.
 *
 * Block (15.3) is a normal always-on group, pixel-identical to Home/Draw/Sculpt's (see
 * `specs.test.ts`). Flood Fill's limit and the 3D Sculpt brush used to be a contextual `slot` group
 * here; since Stage 16.6 they're the Build slot context panel (`windows/modePanels.tsx`), so this
 * tab's solver input is static.
 */
import { useMemo, useState } from "react";
import { contentTier } from "../layout";
import { tabMetrics, specWidth, solveRow } from "../specs";
import { useRibbon } from "../context";
import BlockButton from "../BlockButton";
import { Cmd, CmdSetting, CmdSmall } from "../Cmd";
import type { CommandId } from "../../commands/meta";
import {
  Badge, Col, Group, GroupDivider, Row, SliderRow,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H, SMALL_H } from "../tokens";
// M1: shared with FlyView3D's own in-pane slider and SettingsModal — the ribbon slider used to allow
// 1–16, below the pane's own 2–32 floor/ceiling, so a value set in Settings got silently clamped down
// the next time this slider was touched.
import { MAX_RENDER_DISTANCE, RD_MIN } from "../../FlyView3D";

const AMBER = ACCENT.warm;
/** Everything spatial about the pane itself — camera, distance, the 3D-only modes. */
const SPATIAL = ACCENT.violet;

const SPECS = tabMetrics("3d");
const W = (g: string) => specWidth("3d", g);

/** Mode buttons, in order. Accents come from the registry: the family the mode hands you —
 *  Build and Flood Fill write blocks (draw), Sculpt reshapes terrain (warm), Camera and Select
 *  only move you around (violet). */
const MODES: CommandId[] = ["3d.mode.camera", "3d.mode.select", "3d.mode.build", "3d.mode.sculpt", "3d.mode.floodfill"];

export default function ThreeDTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveRow(SPECS, bodyWidth), [bodyWidth]);
  const big = contentTier(tier.mode);

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

  return (
    <>
      {/* ── Mode ──────────────────────────────────────────────────────────── */}
      <Group id="mode" label="Mode" tier={tier.mode} declaredWidth={W("mode")} icon="camera">
        {MODES.map(id => <Cmd key={id} id={id} tier={big} />)}
      </Group>
      <GroupDivider />

      {/* ── Block (15.3) — always on, identical to Home/Draw/Sculpt's ─────── */}
      <BlockButton cmd="3d.block.pick" tier={tier.block} declaredWidth={W("block")} />
      <GroupDivider />

      {/* ── Camera — per-session view controls, previously Settings-only ──── */}
      <Group id="camera" label="Camera" tier={tier.camera} declaredWidth={W("camera")} icon="camera">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSetting id="3d.camera.flySpeed"><SliderRow label="Fly speed" min={0.1} max={3} step={0.1} accent={SPATIAL} labelWidth={54}
            value={flyDisplay} onChange={setFlyDisplay} onCommit={p.commitFlySpeed}
            title="Movement speed in fly/look mode, in blocks per second" /></CmdSetting>
          <CmdSetting id="3d.camera.distance"><SliderRow label="Distance" min={RD_MIN} max={MAX_RENDER_DISTANCE} accent={SPATIAL} labelWidth={54}
            value={distDisplay} onChange={setDistDisplay} onCommit={p.commitRenderDistance}
            title="Render distance in chunks. The biggest 3D performance cost." /></CmdSetting>
        </Col>
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="3d.camera.hud" full />
          <CmdSmall id="3d.camera.grid" full />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Lighting ──────────────────────────────────────────────────────── */}
      <Group id="lighting" label="Lighting" tier={tier.lighting} declaredWidth={W("lighting")} icon="night">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="3d.lighting.night" full badge={<Badge tone="perf" style={{ marginLeft: "auto" }} />} />
          <CmdSmall id="3d.lighting.shadows" full badge={<Badge tone="perf" style={{ marginLeft: "auto" }} />} />
          <CmdSmall id="3d.lighting.gpuShadows" full badge={<Badge tone="perf" style={{ marginLeft: "auto" }} />} />
        </Col>
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SliderRow label="Sun" min={0} max={1} step={0.01} accent={p.gpuShadows ? SPATIAL : AMBER}
            labelWidth={32} width={68} disabled={!sunActive}
            value={sunDisplay} onChange={setSunDisplay} onCommit={p.commitSunT}
            format={v => `${Math.round(v * 100)}%`}
            title={sunActive ? "Sun angle: 0 = sunrise, 0.5 = noon, 1 = sunset" : "Turn on Shadows or GPU Shadows to use the sun angle"} />
          <SliderRow label="Lamp R" min={2} max={32} accent={AMBER} labelWidth={44} width={68}
            disabled={!p.nightLighting}
            value={lampDisplay} onChange={setLampDisplay} onCommit={p.commitLampRadius}
            title={p.nightLighting ? "Lamp light radius, in blocks" : "Turn on Night Lighting to use the lamp radius"} />
          <Row style={{ height: SMALL_H, opacity: p.nightLighting ? 1 : 0.35, pointerEvents: p.nightLighting ? "auto" : "none" }}>
            <CmdSmall id="3d.lighting.legacy" />
            <CmdSmall id="3d.lighting.modern" />
          </Row>
        </Col>
      </Group>
    </>
  );
}
