import { describe, expect, it } from "vitest";
import { doubleClickFires, dragRegion, parseDoubleClickAction, stripMouseDown, type WindowChrome } from "./windowChrome";

const chrome: WindowChrome = { dragRegion: true, customControls: false, leftClearance: 0 };

describe("dragRegion", () => {
  it("keeps the Tauri attribute on Windows", () => {
    expect(dragRegion(chrome, false)).toEqual({ "data-tauri-drag-region": true });
  });
  it("returns handlers, not the attribute, on a Mac", () => {
    const p = dragRegion(chrome, true);
    expect(p["data-tauri-drag-region"]).toBeUndefined();
    expect(typeof p.onMouseDown).toBe("function");
    expect(typeof p.onMouseUp).toBe("function");
  });
  it("is empty when the chrome has no drag region", () => {
    expect(dragRegion({ ...chrome, dragRegion: false }, true)).toEqual({});
  });
});

describe("title double-click decision", () => {
  const el = {};
  it("maps the action, defaulting to zoom", () => {
    expect(parseDoubleClickAction("minimize")).toBe("minimize");
    expect(parseDoubleClickAction("none")).toBe("none");
    expect(parseDoubleClickAction("zoom")).toBe("zoom");
    expect(parseDoubleClickAction(undefined)).toBe("zoom");
  });
  it("mousedown: drag on single click of the strip itself only", () => {
    expect(stripMouseDown({ button: 0, detail: 1, target: el, currentTarget: el })).toBe("drag");
    expect(stripMouseDown({ button: 0, detail: 2, target: el, currentTarget: el })).toBe("arm-double");
    expect(stripMouseDown({ button: 0, detail: 1, target: {}, currentTarget: el })).toBe("ignore");
    expect(stripMouseDown({ button: 2, detail: 1, target: el, currentTarget: el })).toBe("ignore");
  });
  it("mouseup fires only when the pointer has not moved", () => {
    const up = { button: 0, detail: 2, clientX: 5, clientY: 6, target: el, currentTarget: el };
    expect(doubleClickFires(up, { x: 5, y: 6 })).toBe(true);
    expect(doubleClickFires(up, { x: 9, y: 6 })).toBe(false);
    expect(doubleClickFires(up, null)).toBe(false);
  });
});
