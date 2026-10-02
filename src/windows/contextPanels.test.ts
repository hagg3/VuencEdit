import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONTEXT_PANELS, contextDefault, contextIds, contextPanelShown, isContextPanel, resizeDirsFor, stackOffsets,
} from "./contextPanels";
import { TITLE_H, WM, defaultWins, type WinId, type WinState } from "./windowGeometry";
import { EMPTY_STORE, parseStore, pickLayout, recordLayout, worldIdentity, type WorldLayout } from "./windowStorage";
import ContextPanel from "./ContextPanel";
import { COMMAND_IDS } from "../commands/meta";

const WORK = { w: 1200, h: 700 };
const DEF = defaultWins(WORK, { view3dOpen: false, toolsOpen: true, toolsCollapsed: false });

// `tools`/`hotbar` stand in as extra context panels for the stacking tests (registry insertion order
// = stacking order: the real four, then tools, hotbar).
function registerFakes() {
  CONTEXT_PANELS.tools = { userToggle: false, resize: "x", cue: true };
  CONTEXT_PANELS.hotbar = { userToggle: false, resize: "none", cue: true };
}
afterEach(() => { delete CONTEXT_PANELS.tools; delete CONTEXT_PANELS.hotbar; });

const panel = (h = 80, extra: Partial<WinState> = {}): WinState => ({ ...contextDefault({ w: 200, h }), ...extra });
const wins = (over: Partial<Record<WinId, WinState>>): Record<WinId, WinState> => ({ ...DEF, ...over });

describe("registry", () => {
  it("the lens is the first context panel, then the three 16.6 mode panels; the other windows aren't", () => {
    expect(contextIds()).toEqual(["lens", "cutaway", "brushshape", "buildslot"]);
    for (const id of contextIds()) expect(isContextPanel(id)).toBe(true);
    for (const id of ["tools", "view3d", "hotbar"] as const) expect(isContextPanel(id)).toBe(false);
  });
  it("only the lens is a user toggle; the mode panels follow their mode and have no ⌥ shortcut", () => {
    for (const id of ["cutaway", "brushshape", "buildslot"] as const) {
      expect(CONTEXT_PANELS[id]!.userToggle).toBe(false);
      expect(CONTEXT_PANELS[id]!.resize).toBe("none");
      const cmd = COMMAND_IDS.find(c => c === `view.windows.${id}`);
      expect(cmd).toBeUndefined();
    }
  });
  it("no context panel is in View ▸ Windows except a userToggle one (the lens)", () => {
    for (const id of contextIds()) {
      const listed = COMMAND_IDS.some(c => c === `view.windows.${id}`);
      expect(listed).toBe(CONTEXT_PANELS[id]!.userToggle);
    }
  });
  it("resize axes map to edges", () => {
    expect(resizeDirsFor("both")).toHaveLength(8);
    expect([...resizeDirsFor("x")].sort()).toEqual(["e", "w"]);
    expect([...resizeDirsFor("y")].sort()).toEqual(["n", "s"]);
    expect(resizeDirsFor("none")).toEqual([]);
  });
});

describe("contextPanelShown (the when-predicate gate)", () => {
  it("an ordinary panel follows its mode alone — its stored open bit is ignored", () => {
    registerFakes();
    expect(contextPanelShown("tools", { when: true, worldLoaded: true, open: false })).toBe(true);
    expect(contextPanelShown("tools", { when: false, worldLoaded: true, open: true })).toBe(false);
  });
  it("the lens also needs its session enabled flag", () => {
    expect(contextPanelShown("lens", { when: true, worldLoaded: true, open: true })).toBe(true);
    expect(contextPanelShown("lens", { when: true, worldLoaded: true, open: false })).toBe(false);
    expect(contextPanelShown("lens", { when: false, worldLoaded: true, open: true })).toBe(false);
  });
  it("`enabled` overrides the stored open bit for a userToggle panel only (20.4)", () => {
    registerFakes();
    expect(contextPanelShown("lens", { when: true, worldLoaded: true, open: false, enabled: true })).toBe(true);
    expect(contextPanelShown("lens", { when: true, worldLoaded: true, open: true, enabled: false })).toBe(false);
    expect(contextPanelShown("lens", { when: false, worldLoaded: true, open: true, enabled: true })).toBe(false);
    expect(contextPanelShown("lens", { when: true, worldLoaded: false, open: true, enabled: true })).toBe(false);
    expect(contextPanelShown("tools", { when: true, worldLoaded: true, open: true, enabled: false })).toBe(true);
  });
  it("never shows with no world loaded, whatever the mode says", () => {
    registerFakes();
    for (const id of contextIds())
      for (const when of [true, false])
        for (const open of [true, false])
          expect(contextPanelShown(id, { when, worldLoaded: false, open })).toBe(false);
  });
  it("a window that isn't a context panel is never shown through this gate", () => {
    expect(contextPanelShown("view3d", { when: true, worldLoaded: true, open: true })).toBe(false);
  });
});

describe("stackOffsets", () => {
  it("a lone panel isn't moved", () => {
    registerFakes();
    expect(stackOffsets(["tools"], wins({ tools: panel() }), WORK)).toEqual({});
  });
  it("panels at their default slot stack downward in registry order", () => {
    registerFakes();
    const w = wins({ tools: panel(80), hotbar: panel(60) });
    expect(stackOffsets(["hotbar", "tools"], w, WORK)).toEqual({ hotbar: 80 + WM });
  });
  it("a collapsed panel above only claims its title bar", () => {
    registerFakes();
    const w = wins({ tools: panel(80, { collapsed: true }), hotbar: panel(60) });
    expect(stackOffsets(["tools", "hotbar"], w, WORK)).toEqual({ hotbar: TITLE_H + WM });
  });
  it("a placed panel keeps its position but still claims its space", () => {
    registerFakes();
    const pinned = wins({ tools: panel(80), hotbar: panel(60, { placed: true }) });
    expect(stackOffsets(["tools", "hotbar"], pinned, WORK)).toEqual({});
    // The lens (first in order) parked top-left pushes an unplaced panel below it.
    const lensTopLeft = { ...DEF.lens, attached: false, placed: true, anchor: { h: "l", v: "t" } as const, dx: WM, dy: WM };
    expect(stackOffsets(["lens", "tools"], wins({ lens: lensTopLeft, tools: panel(80) }), WORK))
      .toEqual({ tools: lensTopLeft.h + WM });
  });
  it("an attached lens (following the ghost) never stacks", () => {
    const w = wins({ lens: { ...DEF.lens, attached: true } });
    expect(stackOffsets(["lens"], w, WORK)).toEqual({});
  });
  it("stays inside the work area when the stack runs out of room", () => {
    registerFakes();
    const small = { w: 1200, h: 150 };
    const off = stackOffsets(["tools", "hotbar"], wins({ tools: panel(100), hotbar: panel(100) }), small);
    expect(WM + (off.hotbar ?? 0) + 100).toBeLessThanOrEqual(small.h);
  });
});

describe("persistence", () => {
  it("geometry, collapsed and placed persist per world; open does not", () => {
    registerFakes();
    const moved = panel(80, { collapsed: true, placed: true, dx: 140, dy: 60, open: false });
    const layout: WorldLayout = { swapped: false, wins: wins({ tools: moved }), workAtSave: WORK };
    const id = worldIdentity({ width_chunks: 4, height_chunks: 4, abs_min_x: 0, abs_min_y: 0 }, "legacy64z");
    const stored = parseStore(JSON.stringify(recordLayout(EMPTY_STORE, "/w/a.eden", id, layout, 1)), DEF);
    const got = pickLayout(stored, "/w/a.eden", id).layout!.wins.tools;
    expect(got).toMatchObject({ collapsed: true, placed: true, dx: 140, dy: 60, open: true });
  });
});

describe("ContextPanel render (✕ → onExit)", () => {
  const html = (props: { when: boolean; worldLoaded?: boolean; onExit?: () => void }) => renderToStaticMarkup(
    createElement(ContextPanel, { id: "lens", title: "Paste · Z", icon: "paste", worldLoaded: true, ...props }),
  );
  it("renders nothing while the predicate is false or no world is loaded", () => {
    expect(html({ when: false, onExit: () => {} })).toBe("");
    expect(html({ when: true, worldLoaded: false, onExit: () => {} })).toBe("");
  });
  it("has a ✕ exactly when it has an onExit", () => {
    expect(html({ when: true, onExit: () => {} })).toContain('aria-label="Close Paste · Z"');
    const bare = html({ when: true });
    expect(bare).toContain('data-win="lens"');
    expect(bare).not.toContain("Close Paste");
  });
});
