import { describe, expect, it } from "vitest";
import { gridDivisions, tileWindowFits, shouldPasteOnPointerUp, shouldBlurAfterClick } from "./viewportUtils";

// Phase 6 (256z-format plan): defense-in-depth caps so a corrupt world (quarry.eden's pre-fix
// billions-scale chunk dimensions) degrades to "warn and stop" instead of OOM/RangeError, even
// after Phase 1's coordinate gate closes the known cause.

describe("gridDivisions", () => {
  it("passes a normal world's chunk count through untouched", () => {
    expect(gridDivisions(451, 528)).toBe(528);
    expect(gridDivisions(1, 1)).toBe(1);
  });

  it("caps at 2048 for a huge/corrupt dimension", () => {
    expect(gridDivisions(1_953_719_669, 1)).toBe(2048);
  });

  it("non-finite input falls back to 1", () => {
    expect(gridDivisions(NaN, 5)).toBe(1);
    expect(gridDivisions(Infinity, 5)).toBe(1);
    expect(gridDivisions(NaN, NaN)).toBe(1);
  });

  it("never returns less than 1", () => {
    expect(gridDivisions(0, 0)).toBe(1);
    expect(gridDivisions(-5, -5)).toBe(1);
  });
});

describe("tileWindowFits", () => {
  it("a real-world tile window (single-digit tile counts) fits", () => {
    expect(tileWindowFits(0, 0, 6, 7)).toBe(true); // 7×8 = 56 tiles
  });

  it("exactly at the 4096 cap fits; one over does not", () => {
    expect(tileWindowFits(0, 0, 63, 63)).toBe(true); // 64×64 = 4096
    expect(tileWindowFits(0, 0, 63, 64)).toBe(false); // 64×65 = 4160
  });

  it("a corrupt/huge window (quarry.eden's pre-fix scale) does not fit", () => {
    expect(tileWindowFits(0, 0, 1_000_000, 1_000_000)).toBe(false);
  });

  it("degenerate/inverted ranges do not fit", () => {
    expect(tileWindowFits(5, 5, 4, 10)).toBe(false); // tx1 < tx0
    expect(tileWindowFits(5, 5, 5, 4)).toBe(false); // ty1 < ty0
  });

  it("non-finite input does not fit", () => {
    expect(tileWindowFits(0, 0, NaN, 10)).toBe(false);
    expect(tileWindowFits(0, 0, Infinity, 10)).toBe(false);
  });
});

describe("shouldPasteOnPointerUp (21.12)", () => {
  it("pastes only on primary release that started on canvas", () => {
    expect(shouldPasteOnPointerUp("paste", true, 0)).toBe(true);
    expect(shouldPasteOnPointerUp("paste", true, 2)).toBe(false);
    expect(shouldPasteOnPointerUp("paste", true, 1)).toBe(false);
    expect(shouldPasteOnPointerUp("paste", false, 0)).toBe(false);
    expect(shouldPasteOnPointerUp("select", true, 0)).toBe(false);
  });
});

describe("shouldBlurAfterClick (U9)", () => {
  const fake = (btn: unknown) => ({ closest: (sel: string) => (sel === "button" ? btn : null) }) as unknown as Element;
  const plain = { closest: () => null };
  it("blurs pointer clicks on plain buttons only", () => {
    expect(shouldBlurAfterClick(1, fake(plain))).toBe(true);
    expect(shouldBlurAfterClick(0, fake(plain))).toBe(false);
    expect(shouldBlurAfterClick(1, fake(null))).toBe(false);
    expect(shouldBlurAfterClick(1, fake({ closest: () => ({}) }))).toBe(false);
    expect(shouldBlurAfterClick(1, null)).toBe(false);
  });
});
