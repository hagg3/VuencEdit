/**
 * Every ribbon tab's label, group ids, group labels and declared widths — moved out of the tab
 * `.tsx` files (UI redesign r3, 14.6) so the command registry's paths, the ⌘K reveal, 14.7's width
 * harvester and 14.10's compact ribbon all read one table. Pure data: node-importable.
 *
 * ⚠️ A group's `widths.full` must equal the `declaredWidth` its tab passes to `<Group>` — the
 * tabs read it from here (`specWidth`) instead of repeating the number.
 */
import { solveLayout, type GroupMetrics, type Tier } from "./layout";
import type { RibbonTab } from "./props";
import { BLOCK_POPUP_GROUP_W, GROUP_DIVIDER_W, POPUP_GROUP_W, RIBBON_TRAIL_RESERVE } from "./tokens";

export interface GroupSpec extends GroupMetrics {
  /** The group's label as the ribbon shows it (⌘K paths use this). */
  label: string;
  // `conditional` (inherited from `GroupMetrics`) is a solver capability no spec uses any more:
  // the contextual tails (Z-slice level, sculpt tool options, 3D build slot) became context panels
  // in Stage 16.6, so every tab's solver input is static.
  /** A group with no commands of its own (a preview canvas, a strip of sliders): exempt from the
   *  "every group has ≥ 1 command" test. */
  optionsOnly?: boolean;
}

export interface TabSpec {
  label: string;
  /** Contextual tabs only exist in some states (selection, clipboard, 3D view). */
  contextual?: boolean;
  groups: GroupSpec[];
}

/** `widths.popup` is never an argument: the popup form is fixed-width by construction
 *  (`POPUP_GROUP_W`; the Block button's own narrow form is `BLOCK_POPUP_GROUP_W`). */
const g = (
  id: string, label: string, full: number, medium: number, minTier: GroupMetrics["minTier"], priority: number,
  extra: Partial<GroupSpec> = {},
): GroupSpec => ({
  id, label, minTier, priority,
  widths: { full, medium, popup: id === "block" ? BLOCK_POPUP_GROUP_W : POPUP_GROUP_W },
  ...extra,
});

export const TAB_SPECS: Record<RibbonTab, TabSpec> = {
  home: {
    label: "Home",
    groups: [
      g("clipboard", "Clipboard", 224, 234, "popup", 0),
      g("navigation", "Navigation", 197, 223, "popup", 1),
      g("selection", "Selection", 195, 205, "popup", 2),
      // Block button (14.5): fixed width by construction, so full = medium.
      g("block", "Block", 134, 134, "popup", 3),
      g("setpoint", "Set Point", 138, 104, "full", 4),
    ],
  },
  draw: {
    label: "Draw",
    groups: [
      g("tools", "Tools", 319, 340, "medium", 0),
      g("brush", "Brush", 151, 151, "popup", 2),
      g("options", "Options", 166, 166, "popup", 3, { optionsOnly: true }),
      g("block", "Block", 134, 134, "popup", 1),
      g("mask", "Mask", 150, 150, "popup", 4),
    ],
  },
  sculpt: {
    label: "Sculpt",
    groups: [
      g("tools", "Sculpt tools", 310, 373, "medium", 0),
      g("brush", "Brush", 196, 196, "medium", 1),
      g("falloff", "Falloff", 264, 264, "popup", 2),
      g("block", "Block", 160, 160, "popup", 3),
    ],
  },
  insert: {
    label: "Insert",
    groups: [
      g("prefab", "Prefab", 213, 239, "popup", 1),
      g("nature", "Nature", 338, 346, "popup", 0),
      g("fluids", "Fluids", 446, 446, "popup", 3),
      g("extent", "World Extent", 185, 185, "medium", 4),
    ],
  },
  view: {
    label: "View",
    // Stage 15.4 re-measured render/zoom/layout/windows (+ 3D's mode/lighting) in headless Chromium
    // on macOS — the 15.2/15.3 shrink had left them 25–107px over-declared. Render is two stacked
    // small buttons, narrower than a popup would save, so it's pinned full (MS: don't pop up a
    // two-command group); the last-resort pass can still take it.
    groups: [
      g("mapview", "Map View", 201, 263, "medium", 0),
      g("render", "Render", 79, 79, "full", 3),
      g("zoom", "Zoom", 98, 91, "popup", 4),
      g("layout", "Layout", 135, 150, "popup", 1),
      // layout (16.4: Swap + Reset only, Quad gone) and windows (Tools/Signs share one column)
      // were re-measured in headless Chromium/macOS at 16.4/16.6; layout's medium is a
      // safe over-estimate (wider than full, so the solver skips it straight to popup).
      g("windows", "Windows", 178, 178, "popup", 2),
      g("template", "Template", 89, 89, "popup", 5),
      g("textures", "Textures", 111, 111, "popup", 6),
    ],
  },
  "3d": {
    label: "3D",
    contextual: true,
    groups: [
      g("mode", "Mode", 302, 461, "medium", 0),
      // Block (15.3): always visible, same BlockButton props/spec as Home/Draw/Sculpt — see
      // specs.test.ts's cross-tab parity check.
      g("block", "Block", 134, 134, "popup", 1),
      // camera/lighting re-measured headless (16.6) — camera's 15.8 estimate (259) was 13px short.
      g("camera", "Camera", 272, 272, "popup", 4, { optionsOnly: true }),
      g("lighting", "Lighting", 298, 298, "popup", 3),
    ],
  },
  selection: {
    label: "Selection",
    contextual: true,
    groups: [
      g("modify", "Modify", 268, 300, "popup", 1),
      g("zrange", "Z Range", 192, 192, "medium", 2, { optionsOnly: true }),
      g("move", "Move", 164, 164, "popup", 3),
      g("fill", "Fill / Gradient", 266, 281, "medium", 0),
      g("replace", "Replace", 211, 232, "popup", 4),
      g("extrude", "Extrude", 224, 245, "popup", 5),
    ],
  },
  paste: {
    label: "Clipboard",
    contextual: true,
    groups: [
      g("preview", "Preview", 142, 142, "medium", 4, { optionsOnly: true }),
      // The "Click map to place"/"Locked X,Y" caption column was dropped (2026-09-28 UI feedback —
      // it duplicated the status bar's own paste hint and wasted width). These widths are the
      // pre-removal figure and are now an over-declaration (safe — see the "windows" group comment
      // above); re-harvest with window.__harvestRibbonWidths() to tighten it.
      g("place", "Place", 317, 328, "medium", 0),
      g("transform", "Transform", 135, 151, "popup", 1),
      g("options", "Options", 157, 157, "popup", 2),
      g("mode", "Mode", 144, 144, "popup", 3, { optionsOnly: true }),
      g("prefab", "Prefab", 141, 141, "popup", 5),
    ],
  },
};

/** The solver input for a tab: its groups minus any conditional ones not currently rendered. */
export function tabMetrics(tab: RibbonTab, include: readonly string[] = []): GroupMetrics[] {
  return TAB_SPECS[tab].groups.filter(gr => !gr.conditional || include.includes(gr.id));
}

/**
 * Solve a tab's row against the measured body width. The dividers between groups and the
 * Compact/Labels toggle's corner are real pixels the group widths don't include, so they come off
 * `bodyWidth` first — without that, a row the solver calls "fits" overflowed by a few px.
 * Every tab must render one `GroupDivider` between each pair of solved groups (and none at the ends).
 */
export function solveRow(groups: GroupMetrics[], bodyWidth: number): Record<string, Tier> {
  return solveLayout(groups, rowAvailable(groups.length, bodyWidth));
}

/** The width left for `n` groups' own boxes out of `bodyWidth`. */
export function rowAvailable(n: number, bodyWidth: number): number {
  return bodyWidth - RIBBON_TRAIL_RESERVE - GROUP_DIVIDER_W * Math.max(0, n - 1);
}

/** `declaredWidth` for a group — always `widths.full`, so the two can't drift. */
export function specWidth(tab: RibbonTab, group: string): number {
  const gr = TAB_SPECS[tab].groups.find(x => x.id === group);
  if (!gr) throw new Error(`ribbon/specs: no group ${tab}.${group}`);
  return gr.widths.full;
}

/** "Home › Selection" — the path ⌘K shows. */
export function groupPath(tab: RibbonTab, group: string): string {
  const t = TAB_SPECS[tab];
  const gr = t.groups.find(x => x.id === group);
  return `${t.label} › ${gr?.label ?? group}`;
}
