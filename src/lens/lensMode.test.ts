import { describe, expect, it } from "vitest";
import { lensArmed, lensMode, lensToggle, type LensModeInput } from "./lensMode";

const base: LensModeInput = { pasteArmed: false, hasSelection: false, pasteOn: true, selOn: true };

describe("lensMode (plan D2)", () => {
  it.each([
    // pasteArmed, hasSelection, pasteOn, selOn → mode
    [true, false, true, true, "paste"],
    [true, true, true, false, "paste"],
    [true, true, true, true, "paste"],
    [true, true, false, true, null], // turned off for pasting: no fallback to the selection
    [true, false, false, false, null],
    [false, true, false, true, "selection"],
    [false, true, true, true, "selection"],
    [false, true, true, false, null],
    [false, false, true, true, null],
    [false, false, false, false, null],
  ] as const)("armed=%s sel=%s pasteOn=%s selOn=%s → %s", (pasteArmed, hasSelection, pasteOn, selOn, mode) => {
    expect(lensMode({ pasteArmed, hasSelection, pasteOn, selOn })).toBe(mode);
  });
});

describe("lensToggle (⌥P / ✕, plan D1)", () => {
  it("flips only the paste flag while the paste lens shows", () => {
    expect(lensToggle({ ...base, pasteArmed: true, hasSelection: true })).toEqual({ pasteOn: false, selOn: true, announce: false });
  });

  it("flips only the selection flag while the selection lens shows", () => {
    expect(lensToggle({ ...base, hasSelection: true })).toEqual({ pasteOn: true, selOn: false, announce: false });
  });

  it("with no mode, turns both on if either is off", () => {
    expect(lensToggle({ ...base, pasteOn: false })).toEqual({ pasteOn: true, selOn: true, announce: true });
    expect(lensToggle({ ...base, selOn: false })).toEqual({ pasteOn: true, selOn: true, announce: true });
    expect(lensToggle({ ...base, pasteOn: false, selOn: false })).toEqual({ pasteOn: true, selOn: true, announce: true });
  });

  it("with no mode and both on, turns both off", () => {
    expect(lensToggle(base)).toEqual({ pasteOn: false, selOn: false, announce: false });
  });

  it("a paste armed with its flag off brings the paste lens back, without the toast", () => {
    const r = lensToggle({ ...base, pasteArmed: true, pasteOn: false });
    expect(r).toEqual({ pasteOn: true, selOn: true, announce: false });
    expect(lensMode({ ...base, pasteArmed: true, ...r })).toBe("paste");
  });

  it("a selection with its flag off brings the selection lens back", () => {
    const r = lensToggle({ ...base, hasSelection: true, selOn: false });
    expect(r.announce).toBe(false);
    expect(lensMode({ ...base, hasSelection: true, ...r })).toBe("selection");
  });
});

describe("lensArmed", () => {
  it("is the showing mode's flag, else both flags", () => {
    expect(lensArmed({ ...base, hasSelection: true, pasteOn: false })).toBe(true);
    expect(lensArmed({ ...base, pasteArmed: true, selOn: false })).toBe(true);
    expect(lensArmed({ ...base, pasteArmed: true, pasteOn: false })).toBe(false);
    expect(lensArmed(base)).toBe(true);
    expect(lensArmed({ ...base, selOn: false })).toBe(false);
  });
});
