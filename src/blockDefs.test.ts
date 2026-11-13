import { describe, expect, it } from "vitest";
import { blockDisplayName, isNewFormatBlock, NEW_FORMAT_BLOCKS, resolveColor, searchBlocks } from "./blockDefs";

// Phase 3 (256z-format plan): new-format blocks 112–127 must no longer hit the generic
// "Type N" / [128,128,128] fallbacks that every other unhandled ID falls through to.

describe("isNewFormatBlock", () => {
  it("is true for exactly 112..=127", () => {
    expect(isNewFormatBlock(111)).toBe(false);
    expect(isNewFormatBlock(112)).toBe(true);
    expect(isNewFormatBlock(127)).toBe(true);
    expect(isNewFormatBlock(128)).toBe(false);
  });
});

describe("blockDisplayName", () => {
  it("names new-format blocks distinctly instead of the generic Type N fallback", () => {
    expect(blockDisplayName(112)).toBe("Ore Sand");
    expect(blockDisplayName(112)).not.toBe("Type 112");
  });
});

describe("resolveColor", () => {
  it("returns the declared new-format colour, not the generic grey fallback", () => {
    expect(resolveColor(112, 0)).not.toEqual([128, 128, 128]);
    expect(resolveColor(112, 0)).toEqual([133, 67, 58]); // Ore Sand
  });

  it("every NEW_FORMAT_BLOCKS entry resolves to its declared colour unpainted", () => {
    for (const b of NEW_FORMAT_BLOCKS) {
      expect(resolveColor(b.type, 0)).toEqual(b.color);
    }
  });
});

describe("searchBlocks", () => {
  it("is empty for a blank query", () => {
    expect(searchBlocks("  ")).toEqual([]);
  });
  it("matches case-insensitively by display name", () => {
    const r = searchBlocks("LAMP");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every(b => b.name.toLowerCase().includes("lamp"))).toBe(true);
  });
  it("gates wedges and new-format blocks", () => {
    expect(searchBlocks("wedge").length).toBe(0);
    expect(searchBlocks("wedge", { includeWedges: true }).length).toBeGreaterThan(0);
    expect(searchBlocks("ore sand").length).toBe(0);
    expect(searchBlocks("ore sand", { includeNewFormat: true })[0].type).toBe(112);
  });
});
