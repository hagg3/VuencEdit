import { describe, expect, it } from "vitest";
import { filterSigns, selectionVolume, signDistance, sortSigns } from "./worldNav";
import type { SelectionInfo, SignInfo } from "./types";

const sel = (o: Partial<SelectionInfo>): SelectionInfo => ({
  x1: 0, y1: 0, x2: 9, y2: 9, z_min: 0, z_max: 3,
  width: 10, height: 10, depth: 4, cell_count: null, masked: false, ...o,
});

const sign = (text: string, x: number, y: number, z = 10): SignInfo => ({ i: 0, text, x, y, z, a: 3, b: 2, c: 0 });

describe("selectionVolume (audit I-A1)", () => {
  it("is the box volume for a plain selection", () => {
    expect(selectionVolume(sel({}))).toBe(400);
  });
  it("is mask cells × depth for a shaped selection, not the bounding box", () => {
    expect(selectionVolume(sel({ masked: true, cell_count: 25 }))).toBe(100);
  });
  it("falls back to the box if a masked selection has no cell count", () => {
    expect(selectionVolume(sel({ masked: true, cell_count: null }))).toBe(400);
  });
});

describe("filterSigns", () => {
  const signs = [sign("Old\nMill", 0, 0), sign("Welcome to SPAWN", 5, 5), sign("", 9, 9)];

  it("keeps every sign for an empty or blank query, as a copy", () => {
    const out = filterSigns(signs, "  ");
    expect(out).toEqual(signs);
    expect(out).not.toBe(signs);
  });
  it("is case-insensitive and treats sign line breaks as spaces", () => {
    expect(filterSigns(signs, "old mill").map((s) => s.x)).toEqual([0]);
    expect(filterSigns(signs, "spawn").map((s) => s.x)).toEqual([5]);
  });
  it("needs every term, in any order", () => {
    expect(filterSigns(signs, "spawn welcome").map((s) => s.x)).toEqual([5]);
    expect(filterSigns(signs, "spawn mill")).toEqual([]);
  });
});

describe("sortSigns", () => {
  const centre = { x: 100, y: 100 };
  const far = sign("alpha", 0, 0);
  const near = sign("zulu", 101, 100);
  const mid = sign("mike", 110, 110);
  const blank = sign("", 100, 100);

  it("nearest-first measures XY distance only", () => {
    expect(signDistance(sign("", 103, 104, 200), centre)).toBe(5);
    expect(sortSigns([far, mid, near], "nearest", centre)).toEqual([near, mid, far]);
  });
  it("breaks distance ties by text", () => {
    const a = sign("a", 90, 100), b = sign("b", 110, 100);
    expect(sortSigns([b, a], "nearest", centre)).toEqual([a, b]);
  });
  it("text order is alphabetical with empty signs last", () => {
    expect(sortSigns([blank, near, far, mid], "text", centre)).toEqual([far, mid, near, blank]);
  });
  it("never mutates its input", () => {
    const input = [far, near];
    sortSigns(input, "nearest", centre);
    expect(input).toEqual([far, near]);
  });
});
