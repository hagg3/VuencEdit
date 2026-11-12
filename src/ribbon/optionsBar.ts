/**
 * The contextual options bar's rules (Stage 34.2, plan `options-bar-plan-2026-11-12.md`). **Pure**:
 * which left context shows (`barContext`), what each one holds with its *declared* width, the
 * pinned Cap Z zone, and the solver that folds what doesn't fit into a trailing "More" popover
 * (`fitBar`). `OptionsBar.tsx` is the React side; everything here is unit-tested in node.
 *
 * ⚠️ Widths are **declared, not measured** — the same rule as `ribbon/specs.ts`. An over-declared
 * item folds into More too early; an under-declared one trips `OptionsBar`'s dev overflow warning
 * (the row is `overflow: hidden`, never scrolls, never changes height). Re-measure and fix the
 * declaration here after changing an item's content.
 */
import type { Tool } from "../MapCanvas";
import type { MapViewMode, RibbonProps } from "./props";
import { SCULPT_TOOL_IDS } from "./sculptTools";

export type Mode3d = RibbonProps["mode3d"];

/** The bar's six left contexts, in priority order (R1: the tool wins over a selection). */
export const BAR_CONTEXTS = ["paste", "flood", "sculpt", "draw", "selection", "idle"] as const;
export type BarContext = typeof BAR_CONTEXTS[number];

/** 2D draw tools that own the `draw` context. */
export const DRAW_TOOLS: readonly Tool[] = ["pen", "brush", "spray", "line", "rect", "ellipse", "polygon", "fill", "eyedropper"];

export interface BarState {
  tool: Tool;
  hasSelection: boolean;
  hasClipboard: boolean;
  /** The 3D view is actually on screen. `mode3d` is reset to "off" whenever it isn't, but a stale
   *  value must never drive the bar (the old `buildSlotWhen` rule). */
  pane3dLive: boolean;
  mode3d: Mode3d;
}

const isSculpt = (t: Tool) => SCULPT_TOOL_IDS.includes(t);

/** First match wins: paste > 3D flood fill > sculpt > draw > selection > idle. */
export function barContext(s: BarState): BarContext {
  if (s.tool === "paste" && s.hasClipboard) return "paste";
  if (s.pane3dLive && s.mode3d === "floodfill") return "flood";
  if (isSculpt(s.tool) || (s.pane3dLive && s.mode3d === "sculpt")) return "sculpt";
  if (DRAW_TOOLS.includes(s.tool)) return "draw";
  if (s.hasSelection) return "selection";
  return "idle";
}

/** Is the pinned Cap Z / Level zone showing? (R5: whenever Cutaway or Z-slice is on.) */
export const zoneShown = (viewMode: MapViewMode): boolean => viewMode === "cutaway" || viewMode === "zslice";

// ── Sculpt variants (§3.2) ───────────────────────────────────────────────────────────────────

export type SculptVariant = "plain" | "noise" | "slope" | "volumetric";
export const sculptVariant = (t: Tool): SculptVariant =>
  t === "noise" ? "noise" : t === "slope" ? "slope" : t === "rock" || t === "carve" ? "volumetric" : "plain";

/** Rock / Carve's three inline sliders (R3). Nobody named them; these are the ones that change the
 *  look most. All eight live in the Shape popover. */
export const ROCK_INLINE = ["rockNoisiness", "rockNoiseRadius", "rockFlatten"] as const;

// ── Draw items (§3.3) — shared with `DrawTab`, so the tab and the bar can't disagree ───────────

export const drawSizeApplies = (t: Tool): boolean => t === "brush" || t === "spray" || t === "line";
export const drawShapeApplies = (t: Tool): boolean => !isSculpt(t) && t !== "fill" && t !== "eyedropper";
export const drawFilledApplies = (t: Tool): boolean => t === "rect" || t === "ellipse" || t === "polygon";
export const drawHeightApplies = (t: Tool): boolean => DRAW_TOOLS.includes(t) && t !== "fill" && t !== "eyedropper";

// ── Items and their declared widths ──────────────────────────────────────────────────────────

/** One thing in a left context. `w` is the declared width **including the gap after it**. */
export interface BarItem {
  key: string;
  w: number;
  /** Never folds into More. */
  must?: boolean;
  /** Pushed to the row's right end (the paste context's Discard). */
  end?: true;
  /** The command id this item renders (checked against the registry by the test), if it is one. */
  cmd?: string;
}

/** Declared widths, px. Buttons: icon 14 + label ≈ 6.4/char + 14 padding + 4 gap. Sliders: label +
 *  the 96 px minimum track `SliderRow` enforces + its value field + gaps. */
export const W = {
  label: 44, labelSel: 74,
  icon: 28,            // IconButton (24) + gap
  slider: 176,         // 40 label + 96 track + 30 value + gaps
  sliderWide: 224,     // Flood limit: 34 label + 160 track + 56 value
  numField: 54,
  segSize: 134,        // 1/3/5/7/9
  segShape: 66,
  segFill: 118, segHeight: 150,
  segNoise: 130,
  toolMenu: 96,
  more: 34,
} as const;

const btn = (label: string, extra = 0) => Math.round(14 + label.length * 6.4 + 14 + 4 + extra);

/** The left context's items, in order. Pure data: widths and `must` flags only. */
export function leftItems(ctx: BarContext, o: { tool: Tool; hasClipboard: boolean }): BarItem[] {
  const pasteTrail: BarItem[] = o.hasClipboard ? [{ key: "paste", w: btn("Paste"), cmd: "home.clipboard.paste" }] : [];
  switch (ctx) {
    case "paste":
      return [
        { key: "tag", w: W.label, must: true },
        { key: "confirm", w: btn("Confirm"), must: true, cmd: "paste.place.confirm" },
        { key: "unlock", w: btn("Unlock"), cmd: "paste.place.unlock" },
        { key: "lower", w: W.icon, must: true, cmd: "paste.place.lower" },
        { key: "offset", w: W.numField, must: true, cmd: "paste.place.offset" },
        { key: "raise", w: W.icon, must: true, cmd: "paste.place.raise" },
        { key: "rotate", w: W.icon, cmd: "home.clipboard.rotate" },
        { key: "flipX", w: W.icon, cmd: "home.clipboard.flipX" },
        { key: "flipY", w: W.icon, cmd: "home.clipboard.flipY" },
        { key: "skipAir", w: btn("Skip air ✓"), cmd: "home.clipboard.skipAir" },
        { key: "repeat", w: btn("Repeat ✓"), cmd: "home.clipboard.repeat" },
        { key: "discard", w: btn("Discard clipboard"), end: true, cmd: "home.clipboard.discard" },
      ];
    case "flood":
      return [
        { key: "tag", w: W.label, must: true },
        { key: "limit", w: W.sliderWide, must: true, cmd: "3d.mode.floodLimit" },
        { key: "exact", w: W.numField + 40 },
        { key: "caption", w: 170 },
      ];
    case "sculpt": {
      const v = sculptVariant(o.tool);
      const head: BarItem[] = [{ key: "tool", w: W.toolMenu, must: true }];
      const strength: BarItem = { key: "strength", w: W.slider, cmd: "sculpt.brush.strength" };
      const radius: BarItem = { key: "radius", w: W.slider, must: true, cmd: "sculpt.brush.radius" };
      const softness: BarItem = { key: "softness", w: W.slider, cmd: "sculpt.brush.softness" };
      if (v === "volumetric") {
        return [...head, radius,
          { key: "rockNoisiness", w: W.slider }, { key: "rockNoiseRadius", w: W.slider }, { key: "rockFlatten", w: W.slider },
          { key: "shape", w: btn("Shape") + 14, must: true, cmd: "sculpt.shape.more" }];
      }
      const tail: BarItem[] =
        v === "noise" ? [{ key: "noiseMode", w: W.segNoise }, { key: "noiseFeatureSize", w: W.slider }]
          : v === "slope" ? [{ key: "slopeGradeX", w: W.slider }, { key: "slopeGradeY", w: W.slider }]
            : [];
      return [...head, strength, radius, softness, ...tail];
    }
    case "draw": {
      const t = o.tool;
      const items: BarItem[] = [{ key: "tag", w: W.label, must: true }];
      if (t === "fill" || t === "eyedropper") return [...items, { key: "hint", w: 260, must: true }];
      if (drawSizeApplies(t)) items.push(t === "spray"
        ? { key: "density", w: W.slider, must: true, cmd: "draw.brush.size" }
        : { key: "size", w: W.segSize, must: true, cmd: "draw.brush.size" });
      if (drawShapeApplies(t)) items.push({ key: "shape", w: W.segShape, cmd: "draw.brush.shape" });
      if (drawFilledApplies(t)) items.push({ key: "filled", w: W.segFill, cmd: "draw.options.filled" });
      if (drawHeightApplies(t)) items.push({ key: "height", w: W.segHeight, cmd: "draw.options.height" });
      return items;
    }
    case "selection":
      return [
        { key: "tag", w: W.labelSel, must: true },
        { key: "copy", w: btn("Copy"), must: true, cmd: "home.clipboard.copy" },
        { key: "cut", w: btn("Cut"), cmd: "home.clipboard.cut" },
        { key: "fill", w: btn("Fill"), cmd: "home.selection.fill" },
        { key: "delete", w: btn("Delete"), cmd: "home.selection.delete" },
        { key: "clear", w: btn("Deselect"), cmd: "home.selection.clear" },
        ...pasteTrail,
      ];
    case "idle":
      return [
        { key: "hint", w: 180, must: true },
        ...pasteTrail,
      ];
  }
}

// ── The pinned Cap Z / Level zone (§3.4) ─────────────────────────────────────────────────────

export type ZoneForm = "off" | "full" | "compact";
/** Declared zone widths. `full` carries a slider whose track is 96–160 px (`SliderRow`'s own floor),
 *  so it depends on the world's height; `compact` is steppers + field + ✕ only. Follow surface
 *  (Z-slice only) adds a labelled toggle at `full` and is absent at `compact`. */
export function zoneWidth(form: ZoneForm, viewMode: MapViewMode, maxZ: number): number {
  if (form === "off") return 0;
  const follow = viewMode === "zslice";
  // Compact has no Follow surface (⌘K still reaches it): at the 480 px extreme every px counts.
  if (form === "compact") return 140;
  const track = Math.max(96, Math.min(160, maxZ));
  return 38 + 28 + (track + 40) + 28 + 28 + 8 + (follow ? 112 : 0);
}

// ── Fitting (§4.3) ───────────────────────────────────────────────────────────────────────────

/** Row padding (8 px each side) the items live inside. */
export const BAR_PAD = 16;

export interface BarFit {
  shown: BarItem[];
  folded: BarItem[];
  zone: ZoneForm;
  /** Declared total of everything the row renders (shown + More + zone + padding). */
  total: number;
}

/**
 * Pick what shows. 1) reserve the zone at `full`; if the left `must` items wouldn't fit beside it,
 * use `compact`. 2) If every item fits, done. Otherwise reserve the More button and add the
 * non-`must` items in order while they fit; the rest (and everything after the first miss, so the
 * order stays contiguous) folds. `must` items show unless even they can't fit with the compact zone
 * (see the last-resort loop) — that only happens at the 480 px extreme.
 */
export function fitBar(items: readonly BarItem[], viewMode: MapViewMode, maxZ: number, width: number): BarFit {
  const avail = width - BAR_PAD;
  const mustW = items.reduce((n, i) => n + (i.must ? i.w : 0), 0);
  const allW = items.reduce((n, i) => n + i.w, 0);
  let zone: ZoneForm = zoneShown(viewMode) ? "full" : "off";
  // The More button counts against the zone too (when there is anything that could fold), so the
  // total can never exceed the width just because folding turned out to be needed.
  const moreReserve = items.some(i => !i.must) ? W.more : 0;
  if (zone === "full" && mustW + moreReserve + zoneWidth("full", viewMode, maxZ) > avail) zone = "compact";
  const zoneW = zoneWidth(zone, viewMode, maxZ);

  if (allW + zoneW <= avail) return { shown: [...items], folded: [], zone, total: BAR_PAD + allW + zoneW };

  let used = mustW + zoneW + W.more;
  const shown: BarItem[] = [];
  const folded: BarItem[] = [];
  let missed = false;
  for (const i of items) {
    if (i.must) { shown.push(i); continue; }
    if (!missed && used + i.w <= avail) { used += i.w; shown.push(i); } else { missed = true; folded.push(i); }
  }
  // Last resort (the 480 px extreme: widest sidebar on a 900 px window, Cap Z on, a wide context):
  // even the `must` items plus the compact zone don't fit. Never clip — demote `must` items from the
  // end, keeping the first (the tool dropdown / the tag) so the row still says what it is.
  while (BAR_PAD + used > width) {
    let idx = -1;
    for (let j = shown.length - 1; j > 0; j--) if (shown[j].must) { idx = j; break; }
    if (idx < 0) break;
    const [d] = shown.splice(idx, 1);
    used -= d.w;
    folded.unshift(d);
  }
  return { shown, folded, zone, total: BAR_PAD + used };
}

// ── Copy ─────────────────────────────────────────────────────────────────────────────────────

/** The idle context's dim hint: the armed tool's own (`TOOL_HINTS`) wins, else these. */
export const IDLE_HINTS: Partial<Record<Tool, string>> = {
  pan: "Drag to move the map. Scroll to zoom.",
  select: "Drag on the map to select an area.",
  wand: "Click a block to select every matching block it touches.",
  lasso: "Drag a freehand outline to select.",
  polyselect: "Click corners to outline a selection; click the first one to close it.",
  paste: "Copy or cut something to paste it.",
};
export const DEFAULT_IDLE_HINT = "Pick a tool to see its settings here.";
