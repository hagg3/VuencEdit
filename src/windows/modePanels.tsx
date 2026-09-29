/**
 * The three mode-driven context panels that replaced contextual ribbon groups (Stage 16.6, on the
 * 16.5 framework): **Cutaway / Z-slice level** (was View's `zlevel`), **Brush shape** (was Sculpt's
 * `toolopts`) and **Build slot** (was 3D's `slot`). Each renders through `<ContextPanel>`, so it
 * exists exactly while its mode holds and a world is loaded; the `when`/✕/size rules live in
 * `panelModes.ts`.
 *
 * They render in App's `WindowLayer`, *outside* the ribbon's providers, so they use primitives
 * directly (as `ToolsWindow` does) and mark their controls with `CmdSetting`, which needs no
 * binding context — ⌘K's reveal finds them by `data-cmd` (Ribbon's `reveal`).
 */
import { useState } from "react";
import type { CommandId } from "../commands/meta";
import type { RibbonProps } from "../ribbon/props";
import { CmdSetting } from "../ribbon/Cmd";
import {
  Caption, Check, FieldLabel, IconButton, NumField, Row, Segmented, SliderRow,
} from "../ribbon/primitives";
import { SCULPT_ALL } from "../ribbon/sculptTools";
import { ACCENT, ROW_GAP, SMALL_H, SPACE } from "../ribbon/tokens";
import ContextPanel from "./ContextPanel";
import {
  BUILD_SLOT_EXIT, CUTAWAY_EXIT, brushShapeSize, brushShapeWhen, buildSlotSize, buildSlotWhen, cutawayWhen,
} from "./panelModes";
import { PANEL_SIZES } from "./windowGeometry";

const AMBER = ACCENT.warm;
/** Body padding + row gap shared by all three panels — `PANEL_SIZES` is derived from these. */
const BODY = { flexDirection: "column", padding: SPACE.lg, gap: ROW_GAP, justifyContent: "flex-start" } as const;
/** A comfortable slider track: wide enough that a Windows mouse can place single steps. */
const TRACK = 150;

// ── Cutaway / Z-slice level ─────────────────────────────────────────────────────────────────

export type CutawayPanelProps = Pick<RibbonProps, "viewMode" | "setViewMode" | "zSliceZ" | "commitZSlice" | "followSurface" | "setFollowSurface"> & {
  worldLoaded: boolean; maxZ: number;
};

export function CutawayPanel(p: CutawayPanelProps) {
  const cutaway = p.viewMode === "cutaway";
  // Drag-time value, re-synced whenever App changes the committed one out of band (world load
  // reset, follow-surface) — the derived-state pattern the ribbon slider used.
  const [zDisplay, setZDisplay] = useState(p.zSliceZ);
  const [prevZ, setPrevZ] = useState(p.zSliceZ);
  if (prevZ !== p.zSliceZ) { setPrevZ(p.zSliceZ); setZDisplay(p.zSliceZ); }
  return (
    <ContextPanel
      id="cutaway" when={cutawayWhen(p.viewMode)} worldLoaded={p.worldLoaded}
      onExit={() => p.setViewMode(CUTAWAY_EXIT)}
      contentSize={PANEL_SIZES.cutaway.level}
      title={cutaway ? "Cutaway · Cap Z" : "Z-slice · Level"} icon="zslice"
      dataTour="cutaway-panel" bodyStyle={BODY}
    >
      <SliderRow
        label={cutaway ? "Cap" : "Level"} min={0} max={p.maxZ}
        accent={ACCENT.primary} width={180} labelWidth={34}
        value={zDisplay} onChange={setZDisplay} onCommit={p.commitZSlice}
        title={cutaway ? "Everything above this height is hidden" : "Which horizontal layer to show"} />
      {cutaway ? (
        <Caption>Everything above is hidden</Caption>
      ) : (
        <Check checked={p.followSurface} onChange={p.setFollowSurface} label="Follow surface"
          title="Keep the slice level pinned to the surface under the cursor" />
      )}
    </ContextPanel>
  );
}

// ── Brush shape (Noise / Slope / Rock / Carve) ──────────────────────────────────────────────

export type BrushShapePanelProps = Pick<RibbonProps,
  "tool" | "noiseMode" | "setNoiseMode" | "noiseFeatureSize" | "setNoiseFeatureSize"
  | "slopeGradeX" | "setSlopeGradeX" | "slopeGradeY" | "setSlopeGradeY"
  | "rockNoisiness" | "setRockNoisiness" | "rockNoiseRadius" | "setRockNoiseRadius"
  | "rockSmoothing" | "setRockSmoothing" | "rockMeld" | "setRockMeld" | "rockFlatten" | "setRockFlatten"
  | "rockSink" | "setRockSink" | "rockDrape" | "setRockDrape" | "rockStrata" | "setRockStrata"
> & { worldLoaded: boolean };

const TITLES: Record<string, string> = { noise: "Noise", slope: "Slope", rock: "Rock shape", carve: "Carve shape" };
const ICONS = { noise: "noise", slope: "slope", rock: "rock", carve: "rock" } as const;

export function BrushShapePanel(p: BrushShapePanelProps) {
  const t = p.tool;
  const volumetric = t === "rock" || t === "carve";
  const shape = brushShapeWhen(t);
  return (
    // No `onExit`: a sculpt tool has no natural "off", so the panel just follows the tool (Q3).
    <ContextPanel
      id="brushshape" when={shape} worldLoaded={p.worldLoaded}
      contentSize={shape ? brushShapeSize(t) : undefined}
      title={TITLES[t] ?? "Brush shape"} icon={ICONS[t as keyof typeof ICONS] ?? "sculpt"}
      meta={volumetric ? "ignores Strength / Softness" : null}
      dataTour="brush-shape-panel"
      bodyStyle={volumetric ? { ...BODY, flexDirection: "row", gap: SPACE.lg * 2 } : BODY}
    >
      {t === "noise" && (<>
        <Segmented ariaLabel="Noise mode" value={p.noiseMode} onChange={p.setNoiseMode} accent={AMBER}
          options={[
            { id: "hills", label: "Hills", title: "Gentle rolling terrain" },
            { id: "mountains", label: "Mountains", title: "Ridged, high-relief terrain" },
          ]} />
        <SliderRow label="Feature size" min={6} max={80} step={2} accent={AMBER} labelWidth={64} width={TRACK}
          value={p.noiseFeatureSize} onChange={p.setNoiseFeatureSize}
          title="Wavelength of the noise, in blocks — larger = broader landforms" />
      </>)}

      {t === "slope" && (<>
        <SliderRow label="Slope X" min={-100} max={100} step={5} accent={AMBER} labelWidth={48} width={TRACK}
          value={p.slopeGradeX} onChange={p.setSlopeGradeX} format={v => `${v}%`}
          title="Tilt along X — rise in blocks per 100 blocks of run" />
        <SliderRow label="Slope Y" min={-100} max={100} step={5} accent={AMBER} labelWidth={48} width={TRACK}
          value={p.slopeGradeY} onChange={p.setSlopeGradeY} format={v => `${v}%`}
          title="Tilt along Y — rise in blocks per 100 blocks of run" />
        <Caption>Anchor is the block you press on</Caption>
      </>)}

      {volumetric && (<>
        <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
          <SliderRow label="Noisiness" min={0} max={1} step={0.05} accent={AMBER} labelWidth={56} width={110}
            value={p.rockNoisiness} onChange={p.setRockNoisiness} format={v => v.toFixed(2)}
            title="Displacement amplitude of the surface noise, as a fraction of the fillet radius — 0 = clean squashed ellipsoid, 1 = chaotic but still connected" />
          <SliderRow label="Noise size" min={2} max={40} accent={AMBER} labelWidth={56} width={110}
            value={p.rockNoiseRadius} onChange={p.setRockNoiseRadius}
            title="Feature scale of the surface noise, in world blocks — larger = blobbier, smaller = jagged" />
          <SliderRow label="Smoothing" min={0} max={5} step={0.25} accent={AMBER} labelWidth={56} width={110}
            value={p.rockSmoothing} onChange={p.setRockSmoothing} format={v => v.toFixed(2)}
            title="Cohesion blur — turns granular noise into fewer, larger forms" />
          <SliderRow label="Blend" min={0} max={3} step={0.1} accent={AMBER} labelWidth={56} width={110}
            value={p.rockMeld} onChange={p.setRockMeld} format={v => v.toFixed(1)}
            title={t === "carve"
              ? "Fillet radius where the cut rolls over into the surrounding terrain — no sharp rim"
              : "Fillet radius where the rock flares into the surrounding terrain — no hard seam"} />
          <SliderRow label="Flatten" min={0.2} max={1.2} step={0.05} accent={AMBER} labelWidth={56} width={110}
            value={p.rockFlatten} onChange={p.setRockFlatten} format={v => v.toFixed(2)}
            title="Vertical/horizontal ratio of the base shape — lower = squashed, never a sphere" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
          <SliderRow label="Sink" min={0} max={1} step={0.05} accent={AMBER} labelWidth={56} width={110}
            value={p.rockSink} onChange={p.setRockSink} format={v => v.toFixed(2)}
            title="Fraction of the shape's vertical half-extent buried below the anchor surface" />
          <SliderRow label="Drape" min={0} max={1} step={0.05} accent={AMBER} labelWidth={56} width={110}
            value={p.rockDrape} onChange={p.setRockDrape} format={v => v.toFixed(2)}
            title="How strongly the base follows local terrain height — 0 = one flat anchor height, 1 = fully terrain-conformal" />
          <SliderRow label="Strata" min={0} max={2} step={0.1} accent={AMBER} labelWidth={56} width={110}
            value={p.rockStrata} onChange={p.setRockStrata} format={v => v.toFixed(1)}
            title="Horizontal sedimentary-bedding ledges — 0 = none" />
          <Caption>Radius sets the mass size</Caption>
        </div>
      </>)}
    </ContextPanel>
  );
}

// ── 3D build slot (Flood Fill limit / 3D Sculpt brush) ─────────────────────────────────────

export type BuildSlotPanelProps = Pick<RibbonProps,
  "mode3d" | "setMode3d" | "pane3dLive" | "tool" | "setTool" | "floodFillLimit" | "setFloodFillLimit"
  | "sculptStrength" | "setSculptStrength" | "sculptRadius" | "setSculptRadius" | "sculptSoftness" | "setSculptSoftness"
> & { worldLoaded: boolean };

export function BuildSlotPanel(p: BuildSlotPanelProps) {
  const sculpt = p.mode3d === "sculpt";
  const armed = SCULPT_ALL.find(t => t.id === p.tool);
  return (
    <ContextPanel
      id="buildslot" when={buildSlotWhen(p.mode3d, p.pane3dLive)} worldLoaded={p.worldLoaded}
      onExit={() => p.setMode3d(BUILD_SLOT_EXIT)}
      contentSize={buildSlotSize(p.mode3d)}
      title={sculpt ? "3D Sculpt brush" : "Flood Fill"} icon={sculpt ? "sculpt" : "floodfill"}
      meta={sculpt ? armed?.label ?? "pick a tool" : null}
      dataTour="build-slot-panel" bodyStyle={BODY}
    >
      {sculpt ? (<>
        {/* 16 tools in two rows of eight — the same one brush (state + backend command) as the Sculpt tab. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, auto)", gap: ROW_GAP, justifyContent: "start", marginBottom: SPACE.sm }}>
          {SCULPT_ALL.map(t => (
            <CmdSetting key={t.id} id={`sculpt.tools.${t.id}` as CommandId}>
              <IconButton icon={t.icon} label={t.label} title={t.title} active={p.tool === t.id}
                accent={AMBER} onClick={() => p.setTool(t.id)} />
            </CmdSetting>
          ))}
        </div>
        <CmdSetting id="sculpt.brush.strength"><SliderRow label={p.tool === "terrace" ? "Step" : "Strength"} min={1} max={8} accent={AMBER}
          labelWidth={56} width={TRACK} value={p.sculptStrength} onChange={p.setSculptStrength} /></CmdSetting>
        <CmdSetting id="sculpt.brush.radius"><SliderRow label="Radius" min={1} max={32} accent={AMBER}
          labelWidth={56} width={TRACK} value={p.sculptRadius} onChange={p.setSculptRadius} title="Brush radius in blocks" /></CmdSetting>
        <CmdSetting id="sculpt.brush.softness"><SliderRow label="Softness" min={0} max={100} step={5} accent={AMBER}
          labelWidth={56} width={TRACK} value={Math.round(p.sculptSoftness * 100)} onChange={v => p.setSculptSoftness(v / 100)}
          format={v => `${v}%`} /></CmdSetting>
      </>) : (<>
        <SliderRow label="Limit" min={50} max={10000} step={50} accent={ACCENT.primary} width={TRACK} labelWidth={34}
          value={p.floodFillLimit} onChange={p.setFloodFillLimit}
          title="Maximum air cells filled per click" />
        <Row style={{ height: SMALL_H }}>
          <FieldLabel width={34}>Exact</FieldLabel>
          <NumField min={1} max={200000} value={p.floodFillLimit} onChange={p.setFloodFillLimit}
            ariaLabel="Flood fill limit" width={64} />
        </Row>
        <Caption>Fills with the armed Palette block</Caption>
      </>)}
    </ContextPanel>
  );
}
