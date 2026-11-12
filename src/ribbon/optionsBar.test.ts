/**
 * The options bar's pure rules (34.2): which context shows, the per-tool item lists, and the
 * declared-width fit — the `specs.test.ts` analogue (widths are declared, not measured).
 */
import { describe, expect, it } from "vitest";
import type { Tool } from "../MapCanvas";
import { COMMAND_IDS, COMMAND_META, type BarId, type CommandId } from "../commands/meta";
import {
  BAR_CONTEXTS, BAR_PAD, DRAW_TOOLS, W, barContext, drawFilledApplies, drawHeightApplies, drawShapeApplies,
  drawSizeApplies, fitBar, leftItems, sculptVariant, zoneShown, zoneWidth, type BarContext, type BarState,
} from "./optionsBar";
import { SCULPT_ALL, SCULPT_TOOL_IDS } from "./sculptTools";
import type { MapViewMode } from "./props";

const base: BarState = { tool: "pan", hasSelection: false, hasClipboard: false, pane3dLive: false, mode3d: "off" };
const ctx = (o: Partial<BarState>): BarContext => barContext({ ...base, ...o });

describe("barContext (§3.1)", () => {
  it("resolves each context from its own state", () => {
    expect(ctx({ tool: "paste", hasClipboard: true })).toBe("paste");
    expect(ctx({ pane3dLive: true, mode3d: "floodfill" })).toBe("flood");
    expect(ctx({ tool: "raise" })).toBe("sculpt");
    expect(ctx({ pane3dLive: true, mode3d: "sculpt" })).toBe("sculpt");
    expect(ctx({ tool: "pen" })).toBe("draw");
    expect(ctx({ hasSelection: true })).toBe("selection");
    expect(ctx({})).toBe("idle");
  });
  it("every sculpt tool is `sculpt` and every draw tool is `draw`", () => {
    for (const t of SCULPT_TOOL_IDS) expect(ctx({ tool: t }), t).toBe("sculpt");
    for (const t of DRAW_TOOLS) expect(ctx({ tool: t }), t).toBe("draw");
  });
  it("paste beats everything, but only with a clipboard", () => {
    expect(ctx({ tool: "paste", hasClipboard: true, hasSelection: true, pane3dLive: true, mode3d: "floodfill" })).toBe("paste");
    expect(ctx({ tool: "paste", hasClipboard: false })).toBe("idle");
    expect(ctx({ tool: "paste", hasClipboard: false, hasSelection: true })).toBe("selection");
  });
  it("R1: an armed sculpt / draw tool beats a selection", () => {
    expect(ctx({ tool: "raise", hasSelection: true })).toBe("sculpt");
    expect(ctx({ tool: "pen", hasSelection: true })).toBe("draw");
  });
  it("Pan or a selection tool with a selection → selection; with nothing → idle", () => {
    for (const t of ["pan", "select", "wand", "lasso", "polyselect"] as Tool[]) {
      expect(ctx({ tool: t, hasSelection: true }), t).toBe("selection");
      expect(ctx({ tool: t }), t).toBe("idle");
    }
  });
  it("a stale 3D mode must not drive the bar: it needs pane3dLive", () => {
    expect(ctx({ mode3d: "sculpt", pane3dLive: false })).toBe("idle");
    expect(ctx({ mode3d: "floodfill", pane3dLive: false })).toBe("idle");
    expect(ctx({ mode3d: "floodfill", pane3dLive: false, tool: "pen" })).toBe("draw");
  });
  it("flood outranks sculpt / draw (§3.1's known cost)", () => {
    expect(ctx({ pane3dLive: true, mode3d: "floodfill", tool: "raise" })).toBe("flood");
    expect(ctx({ pane3dLive: true, mode3d: "floodfill", tool: "pen" })).toBe("flood");
  });
  it("the Cap Z zone follows the view mode alone", () => {
    expect(zoneShown("topdown")).toBe(false);
    expect(zoneShown("cutaway")).toBe(true);
    expect(zoneShown("zslice")).toBe(true);
  });
});

describe("sculptVariant / draw predicates (§3.2, §3.3)", () => {
  it("maps all 15 sculpt tools", () => {
    expect(SCULPT_ALL).toHaveLength(15);
    for (const t of SCULPT_ALL) {
      const want = t.id === "noise" ? "noise" : t.id === "slope" ? "slope" : t.id === "rock" || t.id === "carve" ? "volumetric" : "plain";
      expect(sculptVariant(t.id), t.id).toBe(want);
    }
  });
  it("draw: size for brush / line, density for spray, shape wherever it applies", () => {
    const row = (t: Tool) => [drawSizeApplies(t), drawShapeApplies(t), drawFilledApplies(t), drawHeightApplies(t)];
    expect(row("pen")).toEqual([false, true, false, true]);
    expect(row("brush")).toEqual([true, true, false, true]);
    expect(row("spray")).toEqual([true, true, false, true]);
    expect(row("line")).toEqual([true, true, false, true]);
    for (const t of ["rect", "ellipse", "polygon"] as Tool[]) expect(row(t), t).toEqual([false, true, true, true]);
    for (const t of ["fill", "eyedropper"] as Tool[]) expect(row(t), t).toEqual([false, false, false, false]);
  });
  it("the draw item lists omit what doesn't apply", () => {
    const keys = (t: Tool) => leftItems("draw", { tool: t, hasClipboard: false }).map(i => i.key);
    expect(keys("pen")).toEqual(["tag", "shape", "height"]);
    expect(keys("spray")).toEqual(["tag", "density", "shape", "height"]);
    expect(keys("rect")).toEqual(["tag", "shape", "filled", "height"]);
    expect(keys("fill")).toEqual(["tag", "hint"]);
  });
  it("Rock / Carve show three inline sliders + Shape; Radius is a `must`", () => {
    const items = leftItems("sculpt", { tool: "rock", hasClipboard: false });
    expect(items.map(i => i.key)).toEqual(["tool", "radius", "rockNoisiness", "rockNoiseRadius", "rockFlatten", "shape"]);
    expect(items.find(i => i.key === "radius")!.must).toBe(true);
  });
});

/** Every left context in every state it can show (one tool per variant), × every zone state. */
const CASES: { name: string; ctx: BarContext; tool: Tool; hasClipboard: boolean }[] = [
  { name: "paste", ctx: "paste", tool: "paste", hasClipboard: true },
  { name: "flood", ctx: "flood", tool: "pan", hasClipboard: false },
  ...(["raise", "noise", "slope", "rock"] as Tool[]).map(t => ({ name: `sculpt/${t}`, ctx: "sculpt" as const, tool: t, hasClipboard: false })),
  ...(["pen", "brush", "spray", "rect", "fill"] as Tool[]).map(t => ({ name: `draw/${t}`, ctx: "draw" as const, tool: t, hasClipboard: false })),
  { name: "selection", ctx: "selection", tool: "select", hasClipboard: true },
  { name: "selection (no clip)", ctx: "selection", tool: "select", hasClipboard: false },
  { name: "idle", ctx: "idle", tool: "pan", hasClipboard: true },
];
const MODES: MapViewMode[] = ["topdown", "cutaway", "zslice"];

describe("fitBar (the specs.test.ts analogue — declared widths)", () => {
  it("the bar's contexts are exactly the six", () => {
    expect([...new Set(CASES.map(c => c.ctx))].sort()).toEqual([...BAR_CONTEXTS].sort());
  });

  /** The `must` items that may be demoted to More at the 480 px extreme (widest sidebar on a 900 px
   *  window), by case. Anything not listed here must show. Cap Z on is what squeezes them out. */
  const DEMOTED_AT_480: Record<string, string[]> = {
    "sculpt/rock": ["shape"], // Radius + Shape ▾ + the compact zone: Shape ▾ moves into More ▾ (it is reachable there)
  };

  for (const c of CASES) for (const mode of MODES) {
    it(`${c.name} · ${mode}: at 480 px the row fits, and only the named must items are demoted`, () => {
      const items = leftItems(c.ctx, c);
      const fit = fitBar(items, mode, 255, 480);
      expect(fit.total, `${c.name} · ${mode}`).toBeLessThanOrEqual(480);
      const demoted = fit.folded.filter(i => i.must).map(i => i.key);
      expect(demoted, `${c.name} · ${mode}`).toEqual(mode === "topdown" ? [] : DEMOTED_AT_480[c.name] ?? []);
      expect(fit.shown[0]).toBe(items[0]); // the tool dropdown / tag always stays
      // every item is shown or folded, exactly once
      expect([...fit.shown, ...fit.folded].map(i => i.key).sort()).toEqual(items.map(i => i.key).sort());
    });

    it(`${c.name} · ${mode}: at 900 px the row fits and every must item shows`, () => {
      const items = leftItems(c.ctx, c);
      const fit = fitBar(items, mode, 255, 900);
      expect(fit.total).toBeLessThanOrEqual(900);
      expect(fit.folded.filter(i => i.must)).toEqual([]);
    });
  }

  it("at 900 px with the zone off, nothing folds except the contexts named here", () => {
    const FOLDS_AT_900 = new Set(["sculpt/noise", "sculpt/slope"]); // 4 sliders + a segmented set: wider than the window by design
    for (const c of CASES) {
      const fit = fitBar(leftItems(c.ctx, c), "topdown", 255, 900);
      if (!FOLDS_AT_900.has(c.name)) expect(fit.folded.map(i => i.key), c.name).toEqual([]);
    }
  });

  it("at 640 px (default sidebar) with the zone off, nothing folds except the contexts named here", () => {
    const FOLDS_AT_640 = new Set(["paste", "sculpt/noise", "sculpt/slope", "sculpt/rock"]);
    for (const c of CASES) {
      const fit = fitBar(leftItems(c.ctx, c), "topdown", 255, 640);
      if (!FOLDS_AT_640.has(c.name)) expect(fit.folded.map(i => i.key), c.name).toEqual([]);
    }
  });

  it("uses the compact zone only when the must items can't sit beside the full one", () => {
    const items = leftItems("sculpt", { tool: "raise", hasClipboard: false });
    expect(fitBar(items, "cutaway", 63, 1400).zone).toBe("full");
    expect(fitBar(items, "cutaway", 63, 480).zone).toBe("compact");
    expect(fitBar(items, "topdown", 63, 480).zone).toBe("off");
  });

  it("folds in order: once an item misses, everything after it folds too", () => {
    const items = leftItems("sculpt", { tool: "noise", hasClipboard: false });
    const fit = fitBar(items, "topdown", 63, 640);
    const names = items.filter(i => !i.must).map(i => i.key);
    const shown = fit.shown.filter(i => !i.must).map(i => i.key);
    expect(names.slice(0, shown.length)).toEqual(shown);
  });

  it("declared zone widths: compact is narrower than full, and 256z (longer track) is wider than 64z", () => {
    expect(zoneWidth("compact", "cutaway", 63)).toBeLessThan(zoneWidth("full", "cutaway", 63));
    expect(zoneWidth("full", "cutaway", 255)).toBeGreaterThan(zoneWidth("full", "cutaway", 63));
    expect(zoneWidth("full", "zslice", 63)).toBeGreaterThan(zoneWidth("full", "cutaway", 63));
    expect(zoneWidth("off", "cutaway", 63)).toBe(0);
    expect(BAR_PAD).toBeGreaterThan(0);
    expect(W.more).toBeGreaterThan(0);
  });
});

describe("registry", () => {
  const ids = (c: { ctx: BarContext; tool: Tool; hasClipboard: boolean }) => leftItems(c.ctx, c).flatMap(i => (i.cmd ? [i.cmd] : []));
  it("every command id an item list names exists in COMMAND_META", () => {
    for (const c of CASES) for (const id of ids(c)) expect(COMMAND_IDS as readonly string[], `${c.name}: ${id}`).toContain(id);
  });
  it("every `{ bar }` path names a real bar id", () => {
    const real: BarId[] = ["paste", "flood", "sculpt", "draw", "selection", "idle", "zlevel"];
    for (const id of COMMAND_IDS) {
      const m = COMMAND_META[id as CommandId];
      for (const p of [m.path, ...(("also" in m && m.also) || [])]) if ("bar" in p) expect(real, `${id}`).toContain(p.bar);
    }
  });
  it("bar-only commands are reachable from some context", () => {
    const shown = new Set(CASES.flatMap(ids));
    for (const id of COMMAND_IDS) {
      const m = COMMAND_META[id as CommandId];
      if ("bar" in m.path && m.path.bar !== "zlevel") expect(shown.has(id), id).toBe(true);
    }
  });
});
