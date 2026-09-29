import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BRUSH_SHAPE_TOOLS, BUILD_SLOT_EXIT, CUTAWAY_EXIT, brushShapeSize, brushShapeWhen, buildSlotSize, buildSlotWhen, cutawayWhen,
} from "./panelModes";
import { CONTEXT_PANELS, contextPanelShown, stackOffsets } from "./contextPanels";
import {
  PANEL_SIZES, TITLE_H, TOOLS_DEFAULT, WM, defaultWins, rectOf, setContentSize, winLimits,
  type Rect, type WinId,
} from "./windowGeometry";
import { BrushShapePanel, BuildSlotPanel, CutawayPanel } from "./modePanels";
import { SCULPT_ALL } from "../ribbon/sculptTools";
import { commandPath } from "../commands/paths";
import { meta } from "../commands/meta";

const WORK = { w: 1200, h: 700 };
const DEF = defaultWins(WORK, { view3dOpen: false, toolsOpen: true, toolsCollapsed: false });
const PANELS = ["cutaway", "brushshape", "buildslot"] as const;
afterEach(() => { for (const id of PANELS) setContentSize(id, null); });

describe("when predicates", () => {
  it("cutaway panel: only in the sliced view modes; ✕ returns to Top-down", () => {
    expect(cutawayWhen("cutaway")).toBe(true);
    expect(cutawayWhen("zslice")).toBe(true);
    expect(cutawayWhen("topdown")).toBe(false);
    expect(CUTAWAY_EXIT).toBe("topdown");
  });
  it("brush shape panel: exactly Noise / Slope / Rock / Carve", () => {
    expect([...BRUSH_SHAPE_TOOLS].sort()).toEqual(["carve", "noise", "rock", "slope"]);
    for (const t of BRUSH_SHAPE_TOOLS) expect(brushShapeWhen(t)).toBe(true);
    for (const t of SCULPT_ALL.map(x => x.id)) expect(brushShapeWhen(t)).toBe(BRUSH_SHAPE_TOOLS.includes(t));
    expect(brushShapeWhen("pan")).toBe(false);
  });
  it("build slot panel: flood-fill or sculpt, and only with the 3D view live; ✕ returns to Build", () => {
    for (const m of ["floodfill", "sculpt"] as const) {
      expect(buildSlotWhen(m, true)).toBe(true);
      expect(buildSlotWhen(m, false)).toBe(false);
    }
    for (const m of ["off", "select", "build"] as const) expect(buildSlotWhen(m, true)).toBe(false);
    expect(BUILD_SLOT_EXIT).toBe("build");
  });
  it("no panel ever shows without a world", () => {
    for (const id of PANELS)
      expect(contextPanelShown(id, { when: true, worldLoaded: false, open: true })).toBe(false);
  });
});

describe("content sizing", () => {
  it("each mode picks a variant size that is inside the panel's static range", () => {
    for (const id of PANELS) {
      const { min, max } = winLimits(id, WORK);
      for (const v of Object.values(PANEL_SIZES[id])) {
        expect(v.w).toBeGreaterThanOrEqual(min.w); expect(v.w).toBeLessThanOrEqual(max.w);
        expect(v.h).toBeGreaterThanOrEqual(min.h); expect(v.h).toBeLessThanOrEqual(max.h);
      }
    }
  });
  it("the volumetric shape panel is the widest and tallest; Rock and Carve share it", () => {
    expect(brushShapeSize("rock")).toEqual(brushShapeSize("carve"));
    expect(brushShapeSize("rock").w).toBeGreaterThan(brushShapeSize("noise").w);
    expect(brushShapeSize("rock").h).toBeGreaterThan(brushShapeSize("slope").h);
    expect(buildSlotSize("sculpt").h).toBeGreaterThan(buildSlotSize("floodfill").h);
  });
  it("a registered content size pins min = max, whatever size was stored", () => {
    setContentSize("brushshape", brushShapeSize("noise"));
    const lim = winLimits("brushshape", WORK);
    expect(lim.min).toEqual(lim.max);
    const r = rectOf({ ...DEF.brushshape, w: 900, h: 900 }, WORK, lim);
    expect({ w: r.w, h: r.h }).toEqual(brushShapeSize("noise"));
    setContentSize("brushshape", null);
    expect(winLimits("brushshape", WORK).min).not.toEqual(winLimits("brushshape", WORK).max);
  });
  it("every variant fits the 900×… minimum window's work area with room to spare", () => {
    for (const id of PANELS) for (const v of Object.values(PANEL_SIZES[id])) {
      expect(v.w).toBeLessThan(600); expect(v.h).toBeLessThan(200);
    }
  });
});

describe("default placement", () => {
  it("panels start top-left, clear of the Tools window's default column", () => {
    for (const id of PANELS) {
      const s = DEF[id];
      expect(s.anchor).toEqual({ h: "l", v: "t" });
      expect(s.dx).toBeGreaterThanOrEqual(WM + TOOLS_DEFAULT.w);
      expect(s.dy).toBe(WM);
    }
  });
  it("all three active at once stack downward without overlapping, inside the work area", () => {
    for (const id of PANELS) setContentSize(id, (Object.values(PANEL_SIZES[id]) as { w: number; h: number }[]).slice(-1)[0]);
    const active: WinId[] = [...PANELS];
    const off = stackOffsets(active, DEF, WORK);
    const rects: Rect[] = active.map(id => {
      const r = rectOf(DEF[id], WORK, winLimits(id, WORK));
      return { ...r, y: r.y + (off[id] ?? 0) };
    });
    for (let i = 0; i < rects.length; i++) {
      expect(rects[i].y + rects[i].h).toBeLessThanOrEqual(WORK.h);
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    }
    expect(TITLE_H).toBeGreaterThan(0);
  });
  it("are registered as ordinary (non-userToggle) panels after the lens", () => {
    expect(Object.keys(CONTEXT_PANELS)).toEqual(["lens", "cutaway", "brushshape", "buildslot"]);
  });
});

describe("panel components (render gate + ✕)", () => {
  const noop = () => {};
  const cut = (viewMode: "topdown" | "zslice" | "cutaway", worldLoaded = true) => renderToStaticMarkup(createElement(CutawayPanel, {
    worldLoaded, maxZ: 63, viewMode, setViewMode: noop, zSliceZ: 32, commitZSlice: noop, followSurface: false, setFollowSurface: noop,
  }));
  it("cutaway panel: hidden in Top-down or with no world; ✕ present; Follow-surface only for Z-slice", () => {
    expect(cut("topdown")).toBe("");
    expect(cut("cutaway", false)).toBe("");
    const c = cut("cutaway");
    expect(c).toContain('data-win="cutaway"');
    expect(c).toContain('aria-label="Close Cutaway · Cap Z"');
    expect(c).not.toContain("Follow surface");
    expect(cut("zslice")).toContain("Follow surface");
  });
  const shape = (tool: string) => renderToStaticMarkup(createElement(BrushShapePanel, {
    worldLoaded: true, tool: tool as never,
    noiseMode: "hills", setNoiseMode: noop, noiseFeatureSize: 20, setNoiseFeatureSize: noop,
    slopeGradeX: 0, setSlopeGradeX: noop, slopeGradeY: 0, setSlopeGradeY: noop,
    rockNoisiness: 0.4, setRockNoisiness: noop, rockNoiseRadius: 12, setRockNoiseRadius: noop,
    rockSmoothing: 1, setRockSmoothing: noop, rockMeld: 1, setRockMeld: noop, rockFlatten: 0.5, setRockFlatten: noop,
    rockSink: 0.3, setRockSink: noop, rockDrape: 0.7, setRockDrape: noop, rockStrata: 0.5, setRockStrata: noop,
  }));
  it("brush shape panel: shows for the four tools and never has a ✕ (Q3)", () => {
    expect(shape("raise")).toBe("");
    for (const t of BRUSH_SHAPE_TOOLS) {
      const h = shape(t);
      expect(h).toContain('data-win="brushshape"');
      expect(h).not.toContain("Close ");
    }
    expect(shape("carve")).toContain("Carve shape");
  });
  const slot = (mode3d: "off" | "floodfill" | "sculpt", pane3dLive = true) => renderToStaticMarkup(createElement(BuildSlotPanel, {
    worldLoaded: true, pane3dLive, mode3d, setMode3d: noop, tool: "raise", setTool: noop,
    floodFillLimit: 1000, setFloodFillLimit: noop,
    sculptStrength: 3, setSculptStrength: noop, sculptRadius: 8, setSculptRadius: noop, sculptSoftness: 0.5, setSculptSoftness: noop,
  }));
  it("build slot panel: only in flood-fill / sculpt with 3D live; ✕ present; sculpt marks its commands for ⌘K", () => {
    expect(slot("off")).toBe("");
    expect(slot("floodfill", false)).toBe("");
    expect(slot("floodfill")).toContain('aria-label="Close Flood Fill"');
    const s = slot("sculpt");
    expect(s).toContain('data-cmd="sculpt.brush.radius"');
    expect(s).toContain('data-cmd="sculpt.tools.rock"');
  });
});

describe("⌘K placement", () => {
  it("the sculpt tools and brush sliders have a Build panel placement, and their ⌘K path stays on the Sculpt tab", () => {
    for (const id of ["sculpt.tools.raise", "sculpt.brush.radius"] as const) {
      expect(meta(id).also).toContainEqual({ panel: "buildslot" });
      expect(commandPath(id)).toBe("Sculpt › " + (id.includes("tools") ? "Sculpt tools" : "Brush"));
    }
  });
});
