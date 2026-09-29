import { describe, it, expect } from "vitest";
import { DIALOG_SIZES, dialogFrame, type DialogSize } from "./dialogSize";

const SIZES: DialogSize[] = ["sm", "md", "lg"];

describe("dialogFrame", () => {
  it("returns the nominal size at a large viewport", () => {
    for (const s of SIZES) {
      const f = dialogFrame(s, 1920, 1080);
      expect(f.w).toBe(DIALOG_SIZES[s].w);
      expect(f.h).toBe(DIALOG_SIZES[s].h);
    }
  });

  it("md/lg have a fixed nominal height, sm has none", () => {
    expect(DIALOG_SIZES.sm.h).toBeUndefined();
    expect(DIALOG_SIZES.md.h).toBe(540);
    expect(DIALOG_SIZES.lg.h).toBe(600);
    expect(dialogFrame("sm", 1920, 1080).h).toBeUndefined();
    expect(dialogFrame("md", 1920, 1080).h).toBe(540);
    expect(dialogFrame("lg", 1920, 1080).h).toBe(600);
  });

  it("never exceeds the nominal size on either axis, at any viewport", () => {
    for (const s of SIZES) {
      for (const [vw, vh] of [[200, 200], [900, 600], [2000, 2000], [0, 0]] as const) {
        const f = dialogFrame(s, vw, vh);
        expect(f.w).toBeLessThanOrEqual(DIALOG_SIZES[s].w);
        if (f.h != null) expect(f.h).toBeLessThanOrEqual(DIALOG_SIZES[s].h!);
      }
    }
  });

  it("clamps to viewport − 48 on each axis independently when the viewport is small", () => {
    const f = dialogFrame("lg", 500, 400);
    expect(f.w).toBe(500 - 48);
    expect(f.h).toBe(400 - 48);
  });

  it("clamps width and height independently — a narrow-but-tall viewport only clamps width", () => {
    const f = dialogFrame("md", 500, 1200);
    expect(f.w).toBe(500 - 48);
    expect(f.h).toBe(DIALOG_SIZES.md.h);
  });

  it("never goes negative at a viewport smaller than the clamp margin", () => {
    const f = dialogFrame("lg", 20, 20);
    expect(f.w).toBe(0);
    expect(f.h).toBe(0);
  });

  it("the app's 900px minimum width still fits lg (852px, well within 900)", () => {
    const f = dialogFrame("lg", 900, 900);
    expect(f.w).toBe(852);
    expect(f.w).toBeLessThan(900);
  });
});
