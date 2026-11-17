import { describe, expect, it } from "vitest";
import { isMacCtrlMenuPress } from "./macCtrlClick";

describe("isMacCtrlMenuPress", () => {
  it("suppresses Ctrl+left on Mac only", () => {
    expect(isMacCtrlMenuPress({ button: 0, ctrlKey: true }, true)).toBe(true);
    expect(isMacCtrlMenuPress({ button: 0, ctrlKey: true }, false)).toBe(false);
  });
  it("leaves plain, ⌘ and other-button presses alone", () => {
    expect(isMacCtrlMenuPress({ button: 0, ctrlKey: false }, true)).toBe(false);
    expect(isMacCtrlMenuPress({ button: 2, ctrlKey: true }, true)).toBe(false);
  });
});
