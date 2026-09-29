import { describe, it, expect } from "vitest";
import { gestureTimedOut, GESTURE_MAX_MS } from "./gestureWatchdog";

describe("gestureTimedOut", () => {
  it("is false within the bound, inclusive of the boundary", () => {
    expect(gestureTimedOut(1000, 1000)).toBe(false);
    expect(gestureTimedOut(1000, 1000 + GESTURE_MAX_MS)).toBe(false);
  });
  it("is true once past the bound", () => {
    expect(gestureTimedOut(1000, 1000 + GESTURE_MAX_MS + 1)).toBe(true);
  });
  it("honours an explicit max", () => {
    expect(gestureTimedOut(0, 501, 500)).toBe(true);
    expect(gestureTimedOut(0, 500, 500)).toBe(false);
  });
});
