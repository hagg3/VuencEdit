import { describe, it, expect } from "vitest";

/**
 * Guards the "Selection and cursors" convention: chrome text is
 * unselectable via the root rule in App.css (copyable values opt in with `.vx-selectable`), and
 * controls use the arrow cursor (pointer is for real hyperlinks, which get it from the UA's `<a href>`
 * default). So neither `cursor: pointer` nor any `user-select` may appear in src/ .ts/.tsx (CSS-in-TS included).
 */
// Vite glob scan (the dialogs.test.ts idiom; the project has no @types/node). .css is not scanned:
// vitest blanks CSS modules even with ?raw, and App.css (the one stylesheet) owns the root rule.
const files = import.meta.glob<string>(
  ["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"],
  { query: "?raw", import: "default", eager: true },
);

/** file (relative to src/) -> exact number of allowed matches. */
const USER_SELECT_ALLOW: Record<string, number> = {};
const POINTER_ALLOW: Record<string, number> = {};

function count(re: RegExp, allow: Record<string, number>) {
  const found: Record<string, number> = {};
  for (const [f, text] of Object.entries(files)) {
    const n = (text.match(re) ?? []).length;
    if (n) found[f.replace(/^\.\//, "")] = n;
  }
  return { found, allow };
}

describe("chrome conventions", () => {
  it("glob sanity check", () => { expect(Object.keys(files).length).toBeGreaterThan(50); });
  it("user-select / userSelect only in App.css (never in .ts/.tsx)", () => {
    const { found, allow } = count(/user-select|userSelect/gi, USER_SELECT_ALLOW);
    expect(found).toEqual(allow);
  });
  it("no cursor: pointer (hand is for real <a href> links only)", () => {
    const { found, allow } = count(/cursor:\s*"?pointer/g, POINTER_ALLOW);
    expect(found).toEqual(allow);
  });
});
