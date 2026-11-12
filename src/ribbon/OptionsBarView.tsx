/**
 * The contextual options bar (Stage 34.2, plan `options-bar-plan-2026-11-12.md`): one 30 px row
 * docked under the ribbon that never hides, scrolls or changes height. A **left context** (paste >
 * 3D flood fill > sculpt > draw > selection > a dim hint) shows the armed tool's settings; a pinned
 * **right zone** carries Cap Z / the slice level whenever Cutaway or Z-slice is on. What doesn't fit
 * folds into a trailing More ▾ popover (`fitBar`, declared widths — `optionsBar.ts`).
 *
 * Renders inside `Ribbon.tsx`'s providers, so commands go through `ribbon/Cmd.tsx` (lint-enforced
 * for this file): ⌘K, Help and the ribbon read one registry. Non-button controls are marked with
 * `CmdSetting` so ⌘K's reveal can flash them. Replaces `QuickActionsBar` and the Cutaway, Brush
 * shape and Build slot windows.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CommandId } from "../commands/meta";
import { TOOL_HINTS, TOOL_LABELS } from "../MapCanvas";
import { sfx } from "../sound/sfx";
import { useRibbon } from "./context";
import { CmdDropdown, CmdIcon, CmdMenuItem, CmdSetting, CmdSmall } from "./Cmd";
import BarPopover, { BarCol } from "./BarPopover";
import {
  BAR_PAD, DEFAULT_IDLE_HINT, IDLE_HINTS, ROCK_INLINE, barContext, fitBar, leftItems, sculptVariant, zoneShown,
  type BarContext,
} from "./optionsBar";
import { Caption, Check, FieldLabel, NumField, Row, Segmented, SliderRow } from "./primitives";
import { SCULPT_ALL, SCULPT_IGNORES_SOFTNESS, SCULPT_IGNORES_STRENGTH, SCULPT_TOOL_IDS } from "./sculptTools";
import type { RibbonProps } from "./props";
import { ACCENT, BORDER, FONT, OPTIONS_BAR_H, SPACE, SURFACE, TEXT_DIM, TEXT_LABEL } from "./tokens";

const AMBER = ACCENT.warm;
const TAG_HUE: Record<BarContext, string> = {
  paste: ACCENT.clipboard, flood: ACCENT.primary, sculpt: AMBER, draw: ACCENT.primary, selection: ACCENT.selection, idle: TEXT_LABEL,
};
const TAG_TEXT: Partial<Record<BarContext, string>> = { paste: "Paste", flood: "Flood", draw: "Draw", selection: "Selection" };

const tagStyle = (hue: string): CSSProperties => ({
  fontSize: FONT.micro, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
  color: hue, marginRight: 2, userSelect: "none", whiteSpace: "nowrap", flexShrink: 0,
});

/** Slider recipes (ranges, steps, formats and titles are copied from the retired panels / the Sculpt tab). */
type Num = (v: number) => string;
const f2: Num = v => v.toFixed(2);
const f1: Num = v => v.toFixed(1);
const pct: Num = v => `${v}%`;

export default function OptionsBar() {
  const { p } = useRibbon();
  const maxZ = p.world?.max_z ?? 63;
  const ctx = barContext({
    tool: p.tool, hasSelection: !!p.rawBounds, hasClipboard: !!p.clipboard, pane3dLive: p.pane3dLive, mode3d: p.mode3d,
  });
  const items = useMemo(() => leftItems(ctx, { tool: p.tool, hasClipboard: !!p.clipboard }), [ctx, p.tool, p.clipboard]);

  // Row width, from a ResizeObserver (as the ribbon body does for `bodyWidth`).
  const rowRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => Math.max(0, window.innerWidth - p.barRightInset));
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => { const w = entries[0]?.contentRect.width; if (w) setWidth(Math.round(w + BAR_PAD)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = fitBar(items, p.viewMode, maxZ, width);

  // Dev tripwire: the row is `overflow: hidden`, so an under-declared width would clip silently.
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (import.meta.env.DEV && el && el.scrollWidth > el.clientWidth + 1) {
      console.warn(`[options bar] ${ctx} overflows by ${el.scrollWidth - el.clientWidth}px at ${width}px — a declared width in ribbon/optionsBar.ts is too small`);
    }
  });

  const end = fit.shown.filter(i => i.end);
  const body = fit.shown.filter(i => !i.end);
  const item = (key: string) => <BarItemView key={key} ctx={ctx} k={key} p={p} />;

  return (
    <div className="eden-ribbon" data-options-bar data-tour="options-bar" style={{
      position: "fixed", top: p.barTop, left: 0, right: p.barRightInset, zIndex: 60,
      height: OPTIONS_BAR_H, boxSizing: "border-box",
      background: SURFACE.body, borderBottom: `1px solid ${BORDER.hairline}`,
      boxShadow: `inset 0 1px 0 ${BORDER.bevel}`, userSelect: "none",
    }}>
      <div ref={rowRef} className="rbn-body" style={{
        display: "flex", alignItems: "center", gap: SPACE.sm, height: "100%", padding: `3px ${BAR_PAD / 2}px`,
        overflow: "hidden", whiteSpace: "nowrap",
      }}>
        {body.map(i => item(i.key))}
        {fit.folded.length > 0 && (
          <BarPopover kind="more" label="More" title="More options" icon="more" iconOnly>
            <BarCol>{fit.folded.map(i => item(i.key))}</BarCol>
          </BarPopover>
        )}
        {end.length > 0 && <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", flexShrink: 0 }}>{end.map(i => item(i.key))}</span>}
        {fit.zone !== "off" && zoneShown(p.viewMode) && (
          <LevelZone p={p} compact={fit.zone === "compact"} maxZ={maxZ} pushRight={end.length === 0} />
        )}
      </div>
    </div>
  );
}

// ── Left-context items ───────────────────────────────────────────────────────────────────────

function BarItemView({ ctx, k, p }: { ctx: BarContext; k: string; p: RibbonProps }): ReactNode {
  if (k === "tag") return <span style={tagStyle(TAG_HUE[ctx])}>{TAG_TEXT[ctx]}</span>;
  switch (ctx) {
    case "paste": return pasteItem(k, p);
    case "flood": return floodItem(k, p);
    case "sculpt": return sculptItem(k, p);
    case "draw": return drawItem(k, p);
    case "selection": return selectionItem(k, p);
    case "idle": return idleItem(k, p);
  }
}

function pasteItem(k: string, p: RibbonProps): ReactNode {
  const nudge = (id: CommandId) => (
    // The cue the old bar's steppers played (documented in 09-frontend): played from the placement,
    // not the binding — ⌘K already plays its own cue.
    <span style={{ display: "contents" }} onClick={() => sfx.play("nudge")}><CmdIcon id={id} /></span>
  );
  switch (k) {
    case "confirm": return <CmdSmall id="paste.place.confirm" />;
    case "unlock": return <CmdSmall id="paste.place.unlock" />;
    case "lower": return nudge("paste.place.lower");
    case "raise": return nudge("paste.place.raise");
    case "offset": return (
      <CmdSetting id="paste.place.offset">
        <NumField value={p.pasteElevationOffset} onChange={p.setPasteElevationOffset} min={-255} max={255} width={46}
          ariaLabel="Paste elevation offset" title="Vertical offset applied to the paste, in blocks" />
      </CmdSetting>
    );
    case "rotate": return <CmdIcon id="home.clipboard.rotate" />;
    case "flipX": return <CmdIcon id="home.clipboard.flipX" />;
    case "flipY": return <CmdIcon id="home.clipboard.flipY" />;
    case "skipAir": return <CmdSmall id="home.clipboard.skipAir" check />;
    case "repeat": return <CmdSmall id="home.clipboard.repeat" check />;
    case "discard": return <CmdSmall id="home.clipboard.discard" />;
  }
  return null;
}

function floodItem(k: string, p: RibbonProps): ReactNode {
  switch (k) {
    case "limit": return (
      <CmdSetting id="3d.mode.floodLimit">
        <SliderRow label="Limit" min={50} max={10000} step={50} accent={ACCENT.primary} width={160} labelWidth={34}
          value={p.floodFillLimit} onChange={p.setFloodFillLimit} title="Maximum air cells filled per click" />
      </CmdSetting>
    );
    case "exact": return (
      <Row style={{ height: 24 }}>
        <FieldLabel>Exact</FieldLabel>
        <NumField min={1} max={200000} value={p.floodFillLimit} onChange={p.setFloodFillLimit} ariaLabel="Flood fill limit" width={64} />
      </Row>
    );
    case "caption": return <span style={{ color: TEXT_DIM, fontSize: FONT.label }}>Fills with the armed block</span>;
  }
  return null;
}

function drawItem(k: string, p: RibbonProps): ReactNode {
  switch (k) {
    case "hint": return <span style={{ color: TEXT_DIM, fontSize: FONT.label }}>{TOOL_HINTS[p.tool] ?? ""}</span>;
    case "density": return (
      <CmdSetting id="draw.brush.size">
        <SliderRow label="Density" min={5} max={100} step={5} accent={ACCENT.primary} labelWidth={44}
          value={Math.round(p.sprayDensity * 100)} onChange={v => p.setSprayDensity(v / 100)} format={pct}
          title="Fraction of the brush footprint sprayed per stamp (hold to build up)" />
      </CmdSetting>
    );
    case "size": return (
      <CmdSetting id="draw.brush.size">
        <Segmented ariaLabel="Brush size" label="Size" accent={ACCENT.primary}
          value={String(p.brushSize)} onChange={v => p.setBrushSize(Number(v))}
          options={[1, 3, 5, 7, 9].map(n => ({ id: String(n), label: String(n), title: `${n}-block brush` }))} />
      </CmdSetting>
    );
    case "shape": return (
      <CmdSetting id="draw.brush.shape">
        <Segmented ariaLabel="Brush shape" accent={ACCENT.primary} value={p.brushShape} onChange={p.setBrushShape}
          options={[
            { id: "sq", label: "", icon: "rect", title: "Square brush" },
            { id: "circ", label: "", icon: "ellipse", title: "Round brush" },
          ]} />
      </CmdSetting>
    );
    case "filled": return (
      <CmdSetting id="draw.options.filled">
        <Segmented ariaLabel="Shape fill" accent={ACCENT.primary} value={p.drawFilled ? "filled" : "hollow"}
          onChange={v => p.setDrawFilled(v === "filled")}
          options={[
            { id: "filled", label: "Filled", title: "Shapes are solid" },
            { id: "hollow", label: "Hollow", title: "Shapes are outlines only" },
          ]} />
      </CmdSetting>
    );
    case "height": return (
      <CmdSetting id="draw.options.height">
        <Segmented ariaLabel="Draw height" accent={ACCENT.primary} value={p.drawAbove ? "above" : "surface"}
          onChange={v => p.setDrawAbove(v === "above")}
          options={[
            { id: "surface", label: "Surface", title: "Replace the topmost block of each column" },
            { id: "above", label: "+1 Above", title: "Stack one block above each column's surface" },
          ]} />
      </CmdSetting>
    );
  }
  return null;
}

function selectionItem(k: string, p: RibbonProps): ReactNode {
  switch (k) {
    case "copy": return <CmdSmall id="home.clipboard.copy" />;
    case "cut": return <CmdSmall id="home.clipboard.cut" />;
    case "fill": return <CmdSmall id="home.selection.fill" />;
    case "delete": return <CmdSmall id="home.selection.delete" />;
    // `short` is still "Clear"; 32.4's terminology pass drops it and this override with it.
    case "clear": return <CmdSmall id="home.selection.clear" label="Deselect" />;
    case "paste": return <CmdSmall id="home.clipboard.paste" />;
  }
  void p;
  return null;
}

function idleItem(k: string, p: RibbonProps): ReactNode {
  if (k === "paste") return <CmdSmall id="home.clipboard.paste" />;
  if (k !== "hint") return null;
  const hint = TOOL_HINTS[p.tool] ?? IDLE_HINTS[p.tool] ?? DEFAULT_IDLE_HINT;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: SPACE.md, minWidth: 0, fontSize: FONT.label }}>
      <span style={tagStyle(TEXT_LABEL)}>{TOOL_LABELS[p.tool] ?? p.tool}</span>
      <span style={{ color: TEXT_DIM, overflow: "hidden", textOverflow: "ellipsis" }}>{hint}</span>
    </span>
  );
}

// ── Sculpt ───────────────────────────────────────────────────────────────────────────────────

function sculptItem(k: string, p: RibbonProps): ReactNode {
  const armed = SCULPT_ALL.find(t => t.id === p.tool);
  const live = SCULPT_TOOL_IDS.includes(p.tool);
  const variant = sculptVariant(p.tool);
  switch (k) {
    case "tool": return (
      // The tool dropdown replaces the Build slot's 16-icon grid (R8): the same one brush (state +
      // backend command) as the Sculpt tab.
      <CmdDropdown id={`sculpt.tools.${armed?.id ?? "raise"}` as CommandId} label={armed?.label ?? "Pick a tool"}
        icon={armed?.icon ?? "sculpt"} active={false}
        menu={() => SCULPT_ALL.map(t => <CmdMenuItem key={t.id} id={`sculpt.tools.${t.id}` as CommandId} />)} />
    );
    case "strength": return (
      <CmdSetting id="sculpt.brush.strength">
        <SliderRow label={p.tool === "terrace" ? "Step" : "Strength"} min={1} max={8} accent={AMBER} labelWidth={40}
          disabled={!live || SCULPT_IGNORES_STRENGTH(p.tool)} value={p.sculptStrength} onChange={p.setSculptStrength} />
      </CmdSetting>
    );
    case "radius": return (
      <CmdSetting id="sculpt.brush.radius">
        <SliderRow label="Radius" min={1} max={32} accent={AMBER} labelWidth={40} disabled={!live}
          value={p.sculptRadius} onChange={p.setSculptRadius} title="Brush radius in blocks" />
      </CmdSetting>
    );
    case "softness": return (
      <CmdSetting id="sculpt.brush.softness">
        <SliderRow label="Softness" min={0} max={100} step={5} accent={AMBER} labelWidth={40}
          disabled={!live || SCULPT_IGNORES_SOFTNESS(p.tool)} value={Math.round(p.sculptSoftness * 100)}
          onChange={v => p.setSculptSoftness(v / 100)} format={pct} />
      </CmdSetting>
    );
    case "noiseMode": return (
      <Segmented ariaLabel="Noise mode" value={p.noiseMode} onChange={p.setNoiseMode} accent={AMBER}
        options={[
          { id: "hills", label: "Hills", title: "Gentle rolling terrain" },
          { id: "mountains", label: "Mountains", title: "Ridged, high-relief terrain" },
        ]} />
    );
    case "noiseFeatureSize": return (
      <SliderRow label="Size" min={6} max={80} step={2} accent={AMBER} labelWidth={30}
        value={p.noiseFeatureSize} onChange={p.setNoiseFeatureSize} title="Noise feature size in blocks. Larger gives broader landforms." />
    );
    case "slopeGradeX": return (
      <SliderRow label="Slope X" min={-100} max={100} step={5} accent={AMBER} labelWidth={40}
        value={p.slopeGradeX} onChange={p.setSlopeGradeX} format={pct} title="Tilt along X, in blocks per 100 blocks. Anchor is the block you press on." />
    );
    case "slopeGradeY": return (
      <SliderRow label="Slope Y" min={-100} max={100} step={5} accent={AMBER} labelWidth={40}
        value={p.slopeGradeY} onChange={p.setSlopeGradeY} format={pct} title="Tilt along Y, in blocks per 100 blocks. Anchor is the block you press on." />
    );
    case "rockNoisiness": return volumetricSlider("rockNoisiness", p);
    case "rockNoiseRadius": return volumetricSlider("rockNoiseRadius", p);
    case "rockFlatten": return volumetricSlider("rockFlatten", p);
    case "shape": return variant === "volumetric" ? (
      <CmdSetting id="sculpt.shape.more">
        <BarPopover kind="shape" label="Shape" title="All eight shape sliders" icon="rock" accent={AMBER}>
          <ShapeSliders p={p} />
        </BarPopover>
      </CmdSetting>
    ) : null;
  }
  return null;
}

type RockKey = typeof ROCK_INLINE[number];

/** The three inline Rock / Carve sliders — the same controls as the popover's, just fewer. */
function volumetricSlider(key: RockKey, p: RibbonProps): ReactNode {
  switch (key) {
    case "rockNoisiness": return (
      <SliderRow label="Noisiness" min={0} max={1} step={0.05} accent={AMBER} labelWidth={46} value={p.rockNoisiness}
        onChange={p.setRockNoisiness} format={f2} title="Surface roughness. 0 is smooth, 1 is chaotic." />
    );
    case "rockNoiseRadius": return (
      <SliderRow label="Noise size" min={2} max={40} accent={AMBER} labelWidth={50} value={p.rockNoiseRadius}
        onChange={p.setRockNoiseRadius} title="Size of the surface bumps in blocks" />
    );
    case "rockFlatten": return (
      <SliderRow label="Flatten" min={0.2} max={1.2} step={0.05} accent={AMBER} labelWidth={40} value={p.rockFlatten}
        onChange={p.setRockFlatten} format={f2} title="Height-to-width ratio. Lower is flatter." />
    );
  }
}

/** All eight Rock / Carve sliders, in the two columns the retired Brush shape window had. */
function ShapeSliders({ p }: { p: RibbonProps }) {
  const carve = p.tool === "carve";
  const S = (label: string, min: number, max: number, step: number, value: number, onChange: (v: number) => void, format: Num | undefined, title: string) => (
    <SliderRow label={label} min={min} max={max} step={step} accent={AMBER} labelWidth={56} width={110}
      value={value} onChange={onChange} format={format} title={title} />
  );
  return (<>
    <BarCol>
      {S("Noisiness", 0, 1, 0.05, p.rockNoisiness, p.setRockNoisiness, f2, "Surface roughness. 0 is smooth, 1 is chaotic.")}
      {S("Noise size", 2, 40, 1, p.rockNoiseRadius, p.setRockNoiseRadius, undefined, "Size of the surface bumps in blocks")}
      {S("Smoothing", 0, 5, 0.25, p.rockSmoothing, p.setRockSmoothing, f2, "Cohesion blur: turns granular noise into fewer, larger forms")}
      {S("Blend", 0, 3, 0.1, p.rockMeld, p.setRockMeld, f1, carve ? "Rounding where the cut meets the terrain" : "Rounding where the rock meets the terrain")}
      {S("Flatten", 0.2, 1.2, 0.05, p.rockFlatten, p.setRockFlatten, f2, "Height-to-width ratio. Lower is flatter.")}
    </BarCol>
    <BarCol>
      {S("Sink", 0, 1, 0.05, p.rockSink, p.setRockSink, f2, "Fraction of the shape's vertical half-extent buried below the anchor surface")}
      {S("Drape", 0, 1, 0.05, p.rockDrape, p.setRockDrape, f2, "How closely the base follows the terrain. 0 is flat, 1 follows it fully.")}
      {S("Strata", 0, 2, 0.1, p.rockStrata, p.setRockStrata, f1, "Horizontal ledges. 0 is none.")}
      <Caption>Radius sets the mass size</Caption>
    </BarCol>
  </>);
}

// ── Pinned right zone: Cap Z / slice level ───────────────────────────────────────────────────

function LevelZone({ p, compact, maxZ, pushRight }: { p: RibbonProps; compact: boolean; maxZ: number; pushRight: boolean }) {
  const cutaway = p.viewMode === "cutaway";
  // Drag-time value, re-synced whenever App changes the committed one out of band (world load
  // reset, follow-surface) — the derived-state pattern the retired Cutaway panel used.
  const [zDisplay, setZDisplay] = useState(p.zSliceZ);
  const [prevZ, setPrevZ] = useState(p.zSliceZ);
  if (prevZ !== p.zSliceZ) { setPrevZ(p.zSliceZ); setZDisplay(p.zSliceZ); }
  const title = cutaway ? "Everything above this height is hidden" : "Which horizontal layer to show";
  return (
    <div data-bar-zone style={{
      display: "flex", alignItems: "center", gap: SPACE.sm, flexShrink: 0,
      marginLeft: pushRight ? "auto" : undefined, paddingLeft: SPACE.lg, borderLeft: `1px solid ${BORDER.hairline}`,
    }}>
      {!compact && <span style={tagStyle(ACCENT.primary)}>{cutaway ? "Cap Z" : "Level"}</span>}
      <CmdIcon id="view.mapview.levelDown" />
      <CmdSetting id="view.mapview.level">
        {compact ? (
          <NumField value={p.zSliceZ} onChange={v => p.commitZSlice(Math.max(0, Math.min(maxZ, v)))} min={0} max={maxZ} width={46}
            ariaLabel={cutaway ? "Cap Z" : "Slice level"} title={title} />
        ) : (
          <SliderRow label="" labelWidth={0} min={0} max={maxZ} accent={ACCENT.primary} width={96}
            value={zDisplay} onChange={setZDisplay} onCommit={p.commitZSlice} title={title} />
        )}
      </CmdSetting>
      <CmdIcon id="view.mapview.levelUp" />
      {p.viewMode === "zslice" && (compact
        ? <CmdIcon id="view.mapview.followSurface" />
        : <CmdSetting id="view.mapview.followSurface">
          <Check checked={p.followSurface} onChange={p.setFollowSurface} label="Follow surface"
            title="Keep the slice level pinned to the surface under the cursor" />
        </CmdSetting>)}
      <CmdIcon id="view.mapview.topdown" icon="close" label="Back to Top-down" active={false} />
    </div>
  );
}
