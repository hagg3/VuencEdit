/**
 * Pure data for the opt-in compact command-bar ribbon (UI redesign r3, Stage 14.10; commands
 * sub-plan §7's "compact ribbon" note): which registry commands land in a tab's command bar (icon
 * row) vs its options bar (settings row). Kept out of `CompactRibbon.tsx` so it's testable in this
 * repo's node-only vitest (no jsdom) and so the drift guard below — every `kind:"setting"` command
 * must have a compact widget — can run without touching React at all.
 *
 * A command belongs to tab `T`'s group `G` in compact mode under the same rule the full ribbon's
 * tabs already follow by hand: its own `path`, or any of its `also` placements, names
 * `{tab: T, group: G}` — e.g. Home's Copy/Cut also render on Selection's Modify group
 * (`also: [sel("modify")]`). Reusing `path`/`also` (rather than a second hand-maintained placement
 * table) is what keeps this renderer from drifting against the full ribbon and ⌘K.
 */
import { COMMAND_IDS, meta, type CommandId, type CommandPath } from "../commands/meta";
import { TAB_SPECS } from "./specs";
import type { RibbonTab } from "./props";

export interface CompactBucket {
  /** The `TAB_SPECS` group id — also used as the DOM `data-group` (tour anchors resolve the same
   *  selectors regardless of ribbon mode). */
  group: string;
  label: string;
  ids: CommandId[];
}

function placements(id: CommandId): CommandPath[] {
  const m = meta(id);
  return m.also ? [m.path, ...m.also] : [m.path];
}

function inGroup(id: CommandId, tab: RibbonTab, group: string): boolean {
  return placements(id).some(p => "tab" in p && p.tab === tab && p.group === group);
}

function bucket(tab: RibbonTab, include: (id: CommandId) => boolean): CompactBucket[] {
  const out: CompactBucket[] = [];
  for (const g of TAB_SPECS[tab].groups) {
    const ids = COMMAND_IDS.filter(id => include(id) && inGroup(id, tab, g.id));
    if (ids.length) out.push({ group: g.id, label: g.label, ids });
  }
  return out;
}

/** Icon row: every runnable/armable command for `tab`, grouped by its `TAB_SPECS` group.
 *  `kind:"setting"` (options bar) and `kind:"menu"` (its members already render individually as
 *  their own toggles, e.g. Paste Mode's Single/Scatter/Array) are excluded. */
export function commandBarGroups(tab: RibbonTab): CompactBucket[] {
  return bucket(tab, id => meta(id).kind !== "setting" && meta(id).kind !== "menu");
}

/** Settings row: every `kind:"setting"` command for `tab`, grouped the same way. */
export function optionsBarGroups(tab: RibbonTab): CompactBucket[] {
  return bucket(tab, id => meta(id).kind === "setting");
}

/** Every `kind:"setting"` command in the whole registry, tab-independent — the set
 *  `CompactRibbon.tsx`'s widget switch must cover. `compactRibbon.test.ts` checks
 *  `SETTING_WIDGET_IDS` (declared next to the switch) against this. */
export const SETTING_COMMAND_IDS: readonly CommandId[] = COMMAND_IDS.filter(id => meta(id).kind === "setting");
