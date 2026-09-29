import { describe, it, expect } from "vitest";
import { computePane3dLive, computePlacement, type LayoutInputs } from "./layoutState";

const base: LayoutInputs = { swapped: false, view3dOpen: true, view3dCollapsed: false };

describe("pane3dLive truth table", () => {
  const bools = [false, true];
  for (const swapped of bools) for (const open of bools) for (const collapsed of bools) {
    it(`swapped=${swapped} open=${open} collapsed=${collapsed}`, () => {
      const i = { swapped, view3dOpen: open, view3dCollapsed: collapsed };
      expect(computePane3dLive(i)).toBe(swapped || (open && !collapsed));
    });
  }
});

describe("placement", () => {
  it("map main, 3D in the window", () => {
    expect(computePlacement(base)).toEqual({ main: "map", window: "fly" });
  });
  it("swapped: 3D main, map in the window", () => {
    expect(computePlacement({ ...base, swapped: true })).toEqual({ main: "fly", window: "map" });
  });
  it("a closed or collapsed window renders no body", () => {
    expect(computePlacement({ ...base, view3dOpen: false }).window).toBeNull();
    expect(computePlacement({ ...base, view3dCollapsed: true }).window).toBeNull();
    expect(computePlacement({ ...base, swapped: true, view3dCollapsed: true })).toEqual({ main: "fly", window: null });
  });
  it("the 3D view is placed somewhere exactly when it is live", () => {
    for (const swapped of [false, true])
      for (const view3dOpen of [false, true]) for (const view3dCollapsed of [false, true]) {
        const i = { swapped, view3dOpen, view3dCollapsed };
        const p = computePlacement(i);
        expect(p.main === "fly" || p.window === "fly").toBe(computePane3dLive(i));
      }
  });
});
