/**
 * The opt-in compact command-bar ribbon (UI redesign r3, Stage 14.10) — a 32px icon-only command
 * row over a 28px settings row, in place of the labelled ~96px body. Never the default
 * (`AppSettings.ribbonCompact`, off). Chosen by `Ribbon.tsx` alongside the eight per-tab bodies —
 * see `ribbonHeight(collapsed, compact)` in that file for the height this drives.
 *
 * Both rows are built from the **same registry** the labelled ribbon reads (`commandBarGroups`/
 * `optionsBarGroups` in `./compactRibbon.ts`), so the two renderers can't drift on which commands
 * exist, what they're called, or whether they're enabled/armed — only *how densely* they're drawn.
 * The one thing the registry can't describe generically is a `kind:"setting"` command's actual
 * widget (a slider bound to a specific `RibbonProps` field): `SettingWidget` below is a small,
 * hand-written switch over the 17 current setting ids, each reusing the exact control (same min/
 * max/step/labels) its full-ribbon tab already renders. `compactRibbon.test.ts` is the drift guard
 * — it fails if a `kind:"setting"` command is added to the registry without a case here.
 */
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ExtrudeAxis } from "../types";
// M1: shared floor/ceiling with FlyView3D's own in-pane slider, the ribbon 3D tab and Settings —
// see CLAUDE.md "Undo grouping, feedback, and discoverability" (M1). Importing straight from
// FlyView3D (not re-declaring) is what keeps this control's range from silently drifting off theirs.
import { MAX_RENDER_DISTANCE, RD_MIN } from "../FlyView3D";
import { useRibbon, useRibbonProps } from "./context";
import { CmdIcon, CmdSetting } from "./Cmd";
import type { CommandId } from "../commands/meta";
import type { RibbonProps } from "./props";
import { commandBarGroups, optionsBarGroups, type CompactBucket } from "./compactSpecs";
import {
  Caption, FieldLabel, GroupDivider, NumField, Popover, PopupCloseProvider, RangeSlider, Row, Segmented, Select, SliderRow,
} from "./primitives";
import { Icon } from "./icons";
import {
  ACCENT, BORDER, CMD_BAR_H, FONT, OPT_BAR_H, RIBBON_TRAIL_RESERVE, SPACE, SURFACE, TEXT_LABEL, TEXT_META, btnActive, btnBase,
} from "./tokens";

const POS_AXES: { id: ExtrudeAxis; label: string; title: string }[] = [
  { id: "z+", label: "↑Z+", title: "Repeat upward" },
  { id: "x+", label: "→X+", title: "Repeat east" },
  { id: "y+", label: "↓Y+", title: "Repeat south" },
];
const NEG_AXES: { id: ExtrudeAxis; label: string; title: string }[] = [
  { id: "z-", label: "↓Z−", title: "Repeat downward" },
  { id: "x-", label: "←X−", title: "Repeat west" },
  { id: "y-", label: "↑Y−", title: "Repeat north" },
];

const microLabel = {
  fontSize: FONT.micro, color: TEXT_LABEL, textTransform: "uppercase" as const,
  letterSpacing: ".06em", marginRight: 4, fontWeight: 600, userSelect: "none" as const, whiteSpace: "nowrap" as const,
};

export default function CompactRibbon({ onOpenSearch }: { onOpenSearch: () => void }) {
  const { activeTab } = useRibbon();
  const cmdGroups = commandBarGroups(activeTab);
  const optGroups = optionsBarGroups(activeTab);
  // A group id claimed by the command bar owns `data-group` there; the settings row for the same
  // group (e.g. Draw's "brush", which mixes a toggle with two sliders) doesn't repeat it, so a
  // tour/⌘K selector for that id can't resolve to two different elements.
  const cmdGroupIds = new Set(cmdGroups.map(b => b.group));

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", minWidth: 0 }}>
      <div style={{
        height: CMD_BAR_H, display: "flex", alignItems: "center", gap: 2, padding: `0 ${SPACE.md}px`,
        boxShadow: `inset 0 -1px 0 ${BORDER.hairline}`, overflow: "hidden", minWidth: 0,
      }}>
        <OverflowRow key={`cmd-${activeTab}`} gap={2} label="More commands"
          items={cmdGroups.map(b => ({ key: b.group, node: <BarGroup bucket={b} /> }))} />
        <span style={{ minWidth: SPACE.md }} />
        <button
          // Chrome, not a registry command — mirrors `TopBar`'s own un-wrapped search chip (which
          // sits outside `#ribbon-tabpanel` and so never trips the dev-only unmarked-button check;
          // this one is inside it, so it needs the explicit exemption).
          data-no-cmd
          type="button" className="rbn-btn" onClick={onOpenSearch} title="Search every command (⌘K)"
          style={btnBase({
            display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 8px",
            minWidth: 220, background: SURFACE.well, color: TEXT_META, flexShrink: 0,
          })}
        >
          <Icon name="search" size={13} />
          <span style={{ flex: 1, textAlign: "left" }}>Run a command…</span>
          <span style={{ fontSize: FONT.micro, color: TEXT_LABEL }}>⌘K</span>
        </button>
      </div>
      <div style={{
        // Right padding keeps the row (and its More button) clear of the Labels/Compact toggle.
        height: OPT_BAR_H, display: "flex", alignItems: "center", gap: 12, padding: `0 ${RIBBON_TRAIL_RESERVE}px 0 ${SPACE.lg}px`,
        background: SURFACE.topbar, overflow: "hidden", minWidth: 0,
      }}>
        {optGroups.length === 0 ? (
          <span style={{ color: TEXT_META, fontSize: FONT.label }}>No options for this tab</span>
        ) : (
          <OverflowRow key={`opt-${activeTab}`} gap={12} label="More options"
            items={optGroups.map((b, i) => ({
              key: b.group,
              node: (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
                  data-group={cmdGroupIds.has(b.group) ? undefined : b.group}
                >
                  {i > 0 && <span aria-hidden="true" style={{ width: 1, height: 16, background: BORDER.hairline, flexShrink: 0 }} />}
                  <span style={{ ...microLabel, marginRight: 6 }}>{b.label}</span>
                  {b.ids.map(id => <CmdSetting key={id} id={id}><SettingWidget id={id} /></CmdSetting>)}
                </div>
              ),
            }))} />
        )}
      </div>
    </div>
  );
}

/** Width of the overflow » button (`OverflowRow`), reserved whenever anything overflows. */
const OVERFLOW_BTN_W = 58;

/**
 * A toolbar row that never scrolls (Stage 15.4): whatever doesn't fit moves, whole group by whole
 * group from the end, behind a trailing "More" button — MS: "toolbars scale using an overflow
 * button". Unlike the labelled ribbon there are no declared widths here, so this one *measures*:
 * every item's width is cached the last time it was on screen, and an item never measured yet
 * forces one render of everything (inside a layout effect, so before paint) to learn it. Keyed on
 * the tab by the caller, so the cache and the fit count start fresh per tab.
 */
function OverflowRow({ items, gap, label }: { items: { key: string; node: ReactNode }[]; gap: number; label: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chevRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [fit, setFit] = useState(items.length);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTick(t => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    for (const el of box.querySelectorAll<HTMLElement>(":scope > [data-row-item]")) {
      widths.current.set(el.dataset.rowItem!, el.offsetWidth);
    }
    let next = items.length;
    if (items.every(it => widths.current.has(it.key))) {
      const w = (it: { key: string }) => widths.current.get(it.key)!;
      // Space for items + the chevron, whether or not the chevron is showing right now.
      const room = box.clientWidth + (fit < items.length ? (chevRef.current?.offsetWidth ?? 0) + gap : 0);
      const all = items.reduce((sum, it, i) => sum + w(it) + (i ? gap : 0), 0);
      if (all > room) {
        let used = OVERFLOW_BTN_W + gap;
        next = 0;
        for (const it of items) {
          if (used + w(it) + (next ? gap : 0) > room) break;
          used += w(it) + (next ? gap : 0);
          next++;
        }
      }
    }
    if (next !== fit) setFit(next);
    if (next >= items.length && open) setOpen(false);
  }, [items, fit, open, gap, tick]);

  const hidden = items.slice(fit);
  return (
    <>
      <div ref={boxRef} style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap, overflow: "hidden" }}>
        {items.slice(0, fit).map(it => (
          <div key={it.key} data-row-item={it.key} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>{it.node}</div>
        ))}
      </div>
      {hidden.length > 0 && (
        <div ref={chevRef} style={{ display: "flex", flexShrink: 0 }}>
          <button
            // Chrome, not a command; `data-overflow-chevron` lists the groups behind it so ⌘K's
            // reveal (`[data-overflow-chevron~="group"]`) knows which button to open.
            data-no-cmd data-overflow-chevron={hidden.map(it => it.key).join(" ")}
            type="button" className="rbn-btn" title={`${label} (${hidden.length})`} aria-label={label}
            aria-haspopup="dialog" aria-expanded={open} data-active={open ? "true" : undefined}
            onClick={() => setOpen(v => !v)}
            style={btnBase({
              display: "flex", alignItems: "center", justifyContent: "center", gap: 3, height: 24,
              width: OVERFLOW_BTN_W, padding: 0, fontSize: FONT.label, color: TEXT_LABEL,
              ...(open ? btnActive() : null),
            })}
          >
            More <Icon name="split" size={12} tone="inherit" />
          </button>
          {open && (
            <Popover anchorRef={chevRef} onClose={close} role="dialog" ariaLabel={label} align="right" autoFocus>
              <PopupCloseProvider value={close}>
                <div style={overflowPanel}>
                  {hidden.map(it => <div key={it.key} style={{ display: "flex", alignItems: "center" }}>{it.node}</div>)}
                </div>
              </PopupCloseProvider>
            </Popover>
          )}
        </div>
      )}
    </>
  );
}

const overflowPanel: CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "flex-start", gap: SPACE.md, padding: SPACE.md,
};

function BarGroup({ bucket }: { bucket: CompactBucket }) {
  return (
    <>
      <div data-group={bucket.group} style={{ display: "flex", alignItems: "center", gap: 1, padding: "0 4px", flexShrink: 0 }}>
        <span style={microLabel}>{bucket.label}</span>
        {bucket.ids.map(id => <CmdIcon key={id} id={id} />)}
      </div>
      <GroupDivider />
    </>
  );
}

/** The 17 `kind:"setting"` widgets, reusing the exact control (range/labels/format) the labelled
 *  tab that owns each one already renders. Kept as a switch (not a lookup table of components) so
 *  `compactRibbon.test.ts` can assert `SETTING_WIDGET_IDS` — declared right here — covers every
 *  `kind:"setting"` id the registry has. */
export const SETTING_WIDGET_IDS: readonly CommandId[] = [
  "draw.brush.size", "draw.brush.shape", "draw.options.filled", "draw.options.height",
  "sculpt.brush.strength", "sculpt.brush.radius", "sculpt.brush.softness", "sculpt.falloff.profile",
  "insert.nature.density", "insert.fluids.fluid",
  "3d.camera.flySpeed", "3d.camera.distance",
  "selection.zrange.range", "selection.move.mode", "selection.fill.axis", "selection.extrude.axis",
  "paste.place.offset", "paste.mode.pattern",
];

// Sanity: every id in the switch below is one the list above claims, and vice versa is asserted by
// `compactRibbon.test.ts` against the registry (a listed-but-unhandled id would just fall through
// to `null` here with no compile error, which is exactly what the test exists to catch).
function SettingWidget({ id }: { id: CommandId }): ReactNode {
  const p = useRibbonProps();
  switch (id) {
    case "draw.brush.size": return <DrawBrushSize p={p} />;
    // ⚠️ Unlike the full Draw tab, this doesn't dim itself when the armed tool doesn't use a shape
    // (`shapeApplies` there) — a deliberate compact-mode simplification, see the implementation report.
    case "draw.brush.shape":
      return (
        <Segmented ariaLabel="Brush shape" accent={ACCENT.primary} value={p.brushShape} onChange={p.setBrushShape}
          options={[
            { id: "sq", label: "", icon: "rect", title: "Square brush" },
            { id: "circ", label: "", icon: "ellipse", title: "Round brush" },
          ]} />
      );
    case "draw.options.filled":
      return (
        <Segmented ariaLabel="Shape fill" accent={ACCENT.primary} value={p.drawFilled ? "filled" : "hollow"}
          onChange={v => p.setDrawFilled(v === "filled")}
          options={[
            { id: "filled", label: "Filled", title: "Shapes are solid" },
            { id: "hollow", label: "Hollow", title: "Shapes are outlines only" },
          ]} />
      );
    case "draw.options.height":
      return (
        <Segmented ariaLabel="Draw height" accent={ACCENT.primary} value={p.drawAbove ? "above" : "surface"}
          onChange={v => p.setDrawAbove(v === "above")}
          options={[
            { id: "surface", label: "Surface", title: "Replace the topmost block of each column" },
            { id: "above", label: "+1 Above", title: "Stack one block above each column's surface" },
          ]} />
      );
    case "sculpt.brush.strength":
      return (
        <SliderRow label={p.tool === "terrace" ? "Step" : "Strength"} min={1} max={8} accent={ACCENT.warm}
          value={p.sculptStrength} onChange={p.setSculptStrength}
          title={p.tool === "terrace" ? "Terrace step height, in blocks" : "How far each stamp moves the terrain"} />
      );
    case "sculpt.brush.radius":
      return (
        <SliderRow label="Radius" min={1} max={32} accent={ACCENT.warm}
          value={p.sculptRadius} onChange={p.setSculptRadius} title="Brush radius in blocks ([ and ])" />
      );
    case "sculpt.brush.softness":
      return (
        <SliderRow label="Softness" min={0} max={100} step={5} accent={ACCENT.warm}
          value={Math.round(p.sculptSoftness * 100)} onChange={v => p.setSculptSoftness(v / 100)}
          format={v => `${v}%`} title="Radial falloff — 0 = hard edges, 100 = full dome (soft rim)" />
      );
    case "sculpt.falloff.profile":
      return (
        <Select ariaLabel="Falloff profile" value={p.sculptProfile} onChange={p.setSculptProfile} width={104}
          options={[
            { id: "smooth", label: "Smooth", title: "Cosine dome — the default" },
            { id: "linear", label: "Linear", title: "Straight cone" },
            { id: "sphere", label: "Sphere", title: "Spherical cap — fat centre" },
            { id: "sharp", label: "Sharp", title: "Nearly flat-topped, hard rim" },
          ]} />
      );
    case "insert.nature.density":
      return (
        <SliderRow label="Density" min={1} max={100} accent={ACCENT.primary} labelWidth={44} width={70}
          value={p.treeDensity} onChange={p.setTreeDensity} format={v => `${v}%`}
          title="Chance a given column gets a tree" />
      );
    case "insert.fluids.fluid":
      return (
        <Segmented ariaLabel="Fluid" accent={ACCENT.primary} value={String(p.fluidBase)}
          onChange={v => p.setFluidBase(Number(v) as 20 | 23)}
          options={[
            { id: "20", label: "Water", icon: "water", title: "Work with water (block 20)" },
            { id: "23", label: "Lava", icon: "lava", title: "Work with lava (block 23)" },
          ]} />
      );
    case "3d.camera.flySpeed": return <FlySpeedSetting />;
    case "3d.camera.distance": return <RenderDistanceSetting />;
    case "selection.zrange.range": return <ZRangeSetting p={p} />;
    case "selection.move.mode":
      return (
        <Segmented ariaLabel="Move mode" accent={ACCENT.selection} value={p.moveWithContents ? "both" : "box"}
          onChange={v => p.setMoveWithContents(() => v === "both")}
          options={[
            { id: "box", label: "Box only", title: "Dragging or nudging moves just the selection rectangle" },
            { id: "both", label: "Box + blocks", title: "Dragging or nudging also moves the blocks inside it" },
          ]} />
      );
    case "selection.fill.axis":
      return (
        <Segmented ariaLabel="Gradient axis" accent={ACCENT.primary} value={p.gradientAxis} onChange={p.setGradientAxis}
          options={[
            { id: "x", label: "X", title: "Blend across (E–W) — visible top-down" },
            { id: "y", label: "Y", title: "Blend across (N–S) — visible top-down" },
            { id: "z", label: "Z", title: "Blend by height — visible in side/3D views" },
          ]} />
      );
    case "selection.extrude.axis":
      return (
        <Row gap={4}>
          <Segmented ariaLabel="Extrude axis, positive" accent={ACCENT.selection} value={p.extrudeAxis}
            onChange={p.setExtrudeAxis} options={POS_AXES} />
          <Segmented ariaLabel="Extrude axis, negative" accent={ACCENT.selection} value={p.extrudeAxis}
            onChange={p.setExtrudeAxis} options={NEG_AXES} />
        </Row>
      );
    case "paste.place.offset":
      return (
        <Row gap={4}>
          <FieldLabel width={44}>Z offset</FieldLabel>
          <NumField value={p.pasteElevationOffset} onChange={p.setPasteElevationOffset} ariaLabel="Paste elevation offset" width={46} />
        </Row>
      );
    case "paste.mode.pattern":
      return (
        <Segmented ariaLabel="Paste mode" accent={ACCENT.clipboard} value={p.pasteMode} onChange={p.setPasteMode}
          options={[
            { id: "normal", label: "1×", title: "One copy per click" },
            { id: "scatter", label: "Scatter", title: "Distribute N copies inside the selection" },
            { id: "array", label: "Array", title: "Grid of copies with fixed spacing" },
          ]} />
      );
    default:
      return null;
  }
}

function DrawBrushSize({ p }: { p: RibbonProps }) {
  const isSpray = p.tool === "spray";
  return isSpray ? (
    <SliderRow label="Density" min={5} max={100} step={5} accent={ACCENT.primary}
      value={Math.round(p.sprayDensity * 100)} onChange={v => p.setSprayDensity(v / 100)}
      format={v => `${v}%`} labelWidth={44} title="Fraction of the brush footprint sprayed per stamp (hold to build up)" />
  ) : (
    <Segmented ariaLabel="Brush size" accent={ACCENT.primary} value={String(p.brushSize)} onChange={v => p.setBrushSize(Number(v))}
      options={[1, 3, 5, 7, 9].map(n => ({ id: String(n), label: String(n), title: `${n}-block brush` }))} />
  );
}

/** The same drag-time display/commit split `ThreeDTab` uses (App.tsx patterns: a committed slider
 *  prop gets a tab-local display value synced from it, so a drag re-renders only this control). */
function FlySpeedSetting() {
  const p = useRibbonProps();
  const [display, setDisplay] = useState(p.flySpeed);
  const [prev, setPrev] = useState(p.flySpeed);
  if (prev !== p.flySpeed) { setPrev(p.flySpeed); setDisplay(p.flySpeed); }
  return (
    <SliderRow label="Fly speed" min={0.1} max={3} step={0.1} accent={ACCENT.violet} labelWidth={54}
      value={display} onChange={setDisplay} onCommit={p.commitFlySpeed}
      title="Movement speed in fly/look mode, in blocks per second" />
  );
}

function RenderDistanceSetting() {
  const p = useRibbonProps();
  const [display, setDisplay] = useState(p.renderDistance);
  const [prev, setPrev] = useState(p.renderDistance);
  if (prev !== p.renderDistance) { setPrev(p.renderDistance); setDisplay(p.renderDistance); }
  return (
    <SliderRow label="Distance" min={RD_MIN} max={MAX_RENDER_DISTANCE} accent={ACCENT.violet} labelWidth={54}
      value={display} onChange={setDisplay} onCommit={p.commitRenderDistance}
      title="Chunk render distance. Cost rises quadratically — this is the main 3D performance dial." />
  );
}

function ZRangeSetting({ p }: { p: RibbonProps }) {
  const maxZ = p.world?.max_z ?? 63;
  return (
    <Row gap={6}>
      <RangeSlider lo={p.zMin} hi={p.zMax} min={0} max={maxZ} accent={ACCENT.selection}
        onLo={p.handleZMin} onHi={p.handleZMax} ariaLabelLo="Z minimum" ariaLabelHi="Z maximum" width={110} />
      <NumField min={0} max={maxZ} value={p.zMin} ariaLabel="Z Min" onChange={n => p.handleZMin(String(n))} width={40} />
      <Caption>–</Caption>
      <NumField min={0} max={maxZ} value={p.zMax} ariaLabel="Z Max" onChange={n => p.handleZMax(String(n))} width={40} />
    </Row>
  );
}
