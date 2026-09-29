import { describe, it, expect } from "vitest";
import { resolveMotion } from "./motion";

describe("resolveMotion", () => {
  it("an explicit override always wins over the OS", () => {
    expect(resolveMotion(false, "full")).toBe("full");
    expect(resolveMotion(true, "full")).toBe("full");
    expect(resolveMotion(false, "reduced")).toBe("reduced");
    expect(resolveMotion(true, "reduced")).toBe("reduced");
  });

  it("'system' defers to the OS's prefers-reduced-motion", () => {
    expect(resolveMotion(false, "system")).toBe("full");
    expect(resolveMotion(true, "system")).toBe("reduced");
  });

  it("the full system × setting matrix", () => {
    const matrix: [boolean, "system" | "reduced" | "full", "full" | "reduced"][] = [
      [false, "system", "full"],
      [true, "system", "reduced"],
      [false, "reduced", "reduced"],
      [true, "reduced", "reduced"],
      [false, "full", "full"],
      [true, "full", "full"],
    ];
    for (const [systemReduced, setting, expected] of matrix) {
      expect(resolveMotion(systemReduced, setting)).toBe(expected);
    }
  });
});
