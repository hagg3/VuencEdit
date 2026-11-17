import { describe, it, expect } from "vitest";
import notice from "../NOTICE.md?raw";

/**
 * Keeps NOTICE.md's licence split honest. VuencEdit's own files are MIT as well as GPL, but a file
 * that ports Eden's source is GPL v3 only, so it must be listed in NOTICE.md section 1a. Any file
 * whose comments cite Eden's sources (the `*.mm` files, `Constants.h`, Emod's `Classes/`, the
 * TerrainGen ports, `la-map.c`, or the EWM reference) has to appear there.
 *
 * Paths in NOTICE.md use the public repo's layout (app at the root, `packages/` beside it). The
 * private monorepo keeps `packages/` two levels up, so both globs are tried; only one matches.
 */
const app = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "../src-tauri/src/**/*.rs", "!../src-tauri/src/tests/**"], { query: "?raw", import: "default", eager: true });
const pkgMono = import.meta.glob<string>(
  ["../../../packages/*/src/**/*.rs", "!../../../packages/*/src/**/tests/**"], { query: "?raw", import: "default", eager: true });
const pkgFlat = import.meta.glob<string>(
  ["../packages/*/src/**/*.rs", "!../packages/*/src/**/tests/**"], { query: "?raw", import: "default", eager: true });

/** Glob key -> path as NOTICE.md writes it. */
function publicPath(key: string): string {
  return key.replace(/^\.\.\/\.\.\/\.\.\/packages\//, "packages/")
    .replace(/^\.\.\/packages\//, "packages/")
    .replace(/^\.\.\/src-tauri\//, "src-tauri/")
    .replace(/^\.\//, "src/");
}

const EDEN_SOURCE = /\.mm\b|Constants\.h\b|Classes\/|TerrainGen|la-map|Tree\.cs|in reference\b|WorldSource/;

describe("licence notice", () => {
  const files = { ...app, ...pkgMono, ...pkgFlat };
  const listed = new Set([...notice.matchAll(/^- `([^`]+)`$/gm)].map(m => m[1]));

  it("glob sanity check", () => {
    expect(Object.keys(app).some(k => k.endsWith("lib.rs"))).toBe(true);
    expect(Object.keys(pkgMono).length + Object.keys(pkgFlat).length).toBeGreaterThan(10);
  });

  it("every file citing Eden's source is listed as GPL-only in NOTICE.md", () => {
    const cites = Object.entries(files).filter(([, t]) => EDEN_SOURCE.test(t)).map(([k]) => publicPath(k)).sort();
    expect(cites.filter(p => !listed.has(p))).toEqual([]);
  });

  it("every file NOTICE.md lists still exists", () => {
    const all = new Set(Object.keys(files).map(publicPath));
    expect([...listed].filter(p => !all.has(p))).toEqual([]);
  });
});
