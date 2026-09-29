/**
 * Cross-tab `TAB_SPECS` invariants (UI redesign r4, Stages 15.3 + 15.4) — pure data, node-importable, no
 * DOM (same convention as `layout.test.ts`/`compactSpecs.test.ts`).
 */
import { describe, expect, it } from "vitest";
import conf from "../../src-tauri/tauri.conf.json";
import { minRowWidth, rowWidth } from "./layout";
import type { RibbonTab } from "./props";
import { rowAvailable, solveRow, TAB_SPECS, tabMetrics } from "./specs";
import { BLOCK_POPUP_GROUP_W, POPUP_GROUP_W } from "./tokens";

describe("specs: block group parity", () => {
  // Home/Draw/3D's Block button is the bare `<BlockButton cmd=… tier={tier.block}
  // declaredWidth={W("block")} />` call with no `dim`/`dimNote`/label override, so their spec
  // entries must be pixel-identical. Sculpt's Block button *does* pass `dim`/`dimNote`
  // ("Rock/Retexture only") — an extra caption row that genuinely widens it (160 vs 134) — so it
  // isn't part of the strict width match, only the invariants that hold regardless of that extra
  // row (id, label, minTier).
  const UNDIMMED_TABS = ["home", "draw", "3d"] as const;
  const ALL_FOUR_TABS = ["home", "draw", "sculpt", "3d"] as const;

  it("Home/Draw/3D declare the identical `block` group spec (width, minTier, label)", () => {
    const blocks = UNDIMMED_TABS.map(tab => {
      const g = TAB_SPECS[tab].groups.find(gr => gr.id === "block");
      expect(g, `${tab}: no block group`).toBeDefined();
      return g!;
    });
    const [first, ...rest] = blocks;
    for (const b of rest) {
      expect(b.widths).toEqual(first.widths);
      expect(b.minTier).toBe(first.minTier);
      expect(b.label).toBe(first.label);
    }
  });

  it("all four tabs' `block` group shares an id, a label and a minTier", () => {
    for (const tab of ALL_FOUR_TABS) {
      const g = TAB_SPECS[tab].groups.find(gr => gr.id === "block");
      expect(g, `${tab}: no block group`).toBeDefined();
      expect(g!.label).toBe("Block");
      expect(g!.minTier).toBe("popup");
      // Fixed-width by construction everywhere (14.5) — full and medium never differ within a tab.
      expect(g!.widths.full).toBe(g!.widths.medium);
    }
  });
});

describe("specs: the ribbon never scrolls (Stage 15.4)", () => {
  // The window can't be narrower than tauri.conf.json's minWidth, and the ribbon body spans it.
  const MIN_WINDOW_W: number = conf.app.windows[0].minWidth;
  const TABS = Object.keys(TAB_SPECS) as RibbonTab[];
  /** Every group, conditional ones included — the widest a tab's row can ever be asked to hold. */
  const everything = (tab: RibbonTab) => tabMetrics(tab, TAB_SPECS[tab].groups.map(gr => gr.id));

  it("reads a sane minimum window width", () => {
    expect(MIN_WINDOW_W).toBeGreaterThanOrEqual(600);
  });

  it("popup widths are the fixed popup-button box, never a per-group number", () => {
    for (const tab of TABS) {
      for (const gr of TAB_SPECS[tab].groups) {
        expect(gr.widths.popup, `${tab}.${gr.id}`).toBe(gr.id === "block" ? BLOCK_POPUP_GROUP_W : POPUP_GROUP_W);
      }
    }
  });

  it("every tab, with all its contextual groups showing, fits the minimum window fully collapsed", () => {
    for (const tab of TABS) {
      const groups = everything(tab);
      expect(minRowWidth(groups), tab).toBeLessThanOrEqual(rowAvailable(groups.length, MIN_WINDOW_W));
    }
  });

  it("every tab's solved row fits its available width from the minimum window up", () => {
    for (const tab of TABS) {
      const variants = [tabMetrics(tab), everything(tab)];
      for (const groups of variants) {
        for (let w = MIN_WINDOW_W; w <= 2560; w += 20) {
          const tiers = solveRow(groups, w);
          expect(rowWidth(groups, tiers), `${tab} @ ${w}px`).toBeLessThanOrEqual(rowAvailable(groups.length, w));
        }
      }
    }
  });

  it("nothing collapses to a popup at the default 1440px window", () => {
    // tauri.conf.json's default size — the layout most users see first. (Declared widths, so this
    // is only as true as specs.ts; the width re-harvest debt applies.)
    for (const tab of TABS) {
      const tiers = solveRow(tabMetrics(tab), conf.app.windows[0].width);
      for (const [id, t] of Object.entries(tiers)) {
        if (TAB_SPECS[tab].groups.find(gr => gr.id === id)!.minTier === "popup") continue;
        expect(t, `${tab}.${id}`).not.toBe("popup");
      }
    }
  });
});
