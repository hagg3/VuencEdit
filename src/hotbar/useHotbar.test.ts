/**
 * `loadHotbar`/`saveHotbar` round-trip — moved verbatim out of `App.tsx` (Stage 14.5). Node vitest
 * has no `localStorage` global, so these tests shim one in (the plan's "in-memory localStorage
 * shim" idiom) rather than pull in jsdom for one pair of pure-ish functions.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { loadHotbar, saveHotbar } from "./useHotbar";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, value); }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage();
});

describe("loadHotbar", () => {
  it("returns an all-null array of the requested length when nothing is stored", () => {
    expect(loadHotbar("k", 5)).toEqual([null, null, null, null, null]);
  });
  it("round-trips through saveHotbar", () => {
    const slots = [{ type: 2, paint: 0 }, null, { type: 20, paint: 5 }, null, null];
    saveHotbar("k", slots);
    expect(loadHotbar("k", 5)).toEqual(slots);
  });
  it("pads a shorter stored array with null up to `len`", () => {
    saveHotbar("k", [{ type: 2, paint: 0 }]);
    expect(loadHotbar("k", 3)).toEqual([{ type: 2, paint: 0 }, null, null]);
  });
  it("truncates a longer stored array to `len`", () => {
    saveHotbar("k", [{ type: 1, paint: 0 }, { type: 2, paint: 0 }, { type: 3, paint: 0 }]);
    expect(loadHotbar("k", 2)).toEqual([{ type: 1, paint: 0 }, { type: 2, paint: 0 }]);
  });
  it("decodes a garbage entry to null instead of throwing", () => {
    localStorage.setItem("k", JSON.stringify([{ type: "not a number", paint: 0 }, 42, null]));
    expect(loadHotbar("k", 3)).toEqual([null, null, null]);
  });
  it("decodes corrupt JSON to an all-null array instead of throwing", () => {
    localStorage.setItem("k", "{not json");
    expect(loadHotbar("k", 2)).toEqual([null, null]);
  });
  it("decodes a non-array value to an all-null array", () => {
    localStorage.setItem("k", JSON.stringify({ foo: "bar" }));
    expect(loadHotbar("k", 2)).toEqual([null, null]);
  });
});
