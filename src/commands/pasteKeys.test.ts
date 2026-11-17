import { describe, expect, it } from "vitest";
import { resolvePasteKey } from "./pasteKeys";
import { PASTE_SHADOWS } from "./keys";
import { meta } from "./meta";

const ev = (key: string, shiftKey = false) => ({ key, code: "", shiftKey, metaKey: false, ctrlKey: false, altKey: false });
const paste = { tool: "paste", hasClipboard: true, typing: false };

describe("paste-mode key resolver (D12)", () => {
  it("maps R / ⇧R / X / Y to the right commands in paste mode", () => {
    expect(resolvePasteKey(ev("r"), paste, true)).toBe("home.clipboard.rotate");
    expect(resolvePasteKey(ev("R", true), paste, true)).toBe("home.clipboard.rotateCcw");
    expect(resolvePasteKey(ev("x"), paste, true)).toBe("home.clipboard.flipX");
    expect(resolvePasteKey(ev("y"), paste, true)).toBe("home.clipboard.flipY");
  });
  it("does nothing outside paste mode, without a clipboard, or while typing", () => {
    for (const k of ["r", "x", "y"]) {
      expect(resolvePasteKey(ev(k), { ...paste, tool: "rect" }, true)).toBeNull();
      expect(resolvePasteKey(ev(k), { ...paste, hasClipboard: false }, true)).toBeNull();
      expect(resolvePasteKey(ev(k), { ...paste, typing: true }, true)).toBeNull();
    }
  });
  it("ignores other keys and modified chords (⌘X stays Cut)", () => {
    expect(resolvePasteKey(ev("s"), paste, true)).toBeNull();
    expect(resolvePasteKey({ ...ev("x"), metaKey: true }, paste, true)).toBeNull();
    expect(resolvePasteKey({ ...ev("r"), altKey: true }, paste, true)).toBeNull();
  });
  it("every chord is paste-scoped; only R shadows a global key", () => {
    for (const id of ["home.clipboard.rotate", "home.clipboard.rotateCcw", "home.clipboard.flipX", "home.clipboard.flipY"] as const) {
      const keys = meta(id).keys ?? [];
      expect(keys.length, id).toBeGreaterThan(0);
      for (const c of keys) expect(c.scope, id).toBe("paste");
    }
    expect(PASTE_SHADOWS).toEqual(["|key:r"]);
  });
});
