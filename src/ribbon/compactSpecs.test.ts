import { describe, expect, it } from "vitest";
import { COMMAND_IDS, meta } from "../commands/meta";
import { TAB_SPECS } from "./specs";
import type { RibbonTab } from "./props";
import { commandBarGroups, optionsBarGroups, SETTING_COMMAND_IDS } from "./compactSpecs";
import { SETTING_WIDGET_IDS } from "./CompactRibbon";

const TABS = Object.keys(TAB_SPECS) as RibbonTab[];

describe("compactRibbon bucketing", () => {
  it("every command bar bucket's ids actually belong to that tab/group (path or also)", () => {
    for (const tab of TABS) {
      for (const b of commandBarGroups(tab)) {
        for (const id of b.ids) {
          const m = meta(id);
          const places = [m.path, ...(m.also ?? [])];
          expect(places.some(p => "tab" in p && p.tab === tab && p.group === b.group)).toBe(true);
        }
      }
    }
  });

  it("command bar buckets never contain a `setting` or `menu` command", () => {
    for (const tab of TABS) {
      for (const b of commandBarGroups(tab)) {
        for (const id of b.ids) {
          expect(meta(id).kind).not.toBe("setting");
          expect(meta(id).kind).not.toBe("menu");
        }
      }
    }
  });

  it("options bar buckets contain only `setting` commands", () => {
    for (const tab of TABS) {
      for (const b of optionsBarGroups(tab)) {
        for (const id of b.ids) expect(meta(id).kind).toBe("setting");
      }
    }
  });

  it("every tab (that has any commands at all) has at least one command-bar icon", () => {
    for (const tab of TABS) {
      const anyCommand = COMMAND_IDS.some(id => {
        const m = meta(id);
        return "tab" in m.path && m.path.tab === tab && m.kind !== "setting" && m.kind !== "menu";
      });
      if (!anyCommand) continue; // a tab whose whole surface is settings would legitimately have none
      expect(commandBarGroups(tab).length).toBeGreaterThan(0);
    }
  });

  // The drift guard the module doc promises: `CompactRibbon.tsx`'s widget switch is a hand-written
  // list (`SETTING_WIDGET_IDS`) rather than a lookup table, precisely so it stays reviewable — this
  // is what catches a `kind:"setting"` command added to the registry without a matching case there.
  it("every kind:\"setting\" command in the registry has a compact widget", () => {
    const declared = new Set(SETTING_WIDGET_IDS);
    const missing = SETTING_COMMAND_IDS.filter(id => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it("SETTING_WIDGET_IDS doesn't list an id that isn't actually kind:\"setting\"", () => {
    const stale = SETTING_WIDGET_IDS.filter(id => meta(id).kind !== "setting");
    expect(stale).toEqual([]);
  });
});
