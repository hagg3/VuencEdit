import { describe, it, expect } from "vitest";
import { THEME_CSS, VARS, accentFamily, v } from "./cssVars";
import { ACCENTS } from "./theme";
import {
  BORDER, SURFACE, btnActive, btnBase, btnHover, btnPressed, currentRow, fieldStyle, liftRow,
} from "../ribbon/tokens";

/**
 * A `var(--vx-x)` naming a property that was never emitted resolves to `unset` — a transparent
 * button, silently. Every recipe's output and every source file's literal `var(--vx-…)` must name
 * an emitted property.
 */
const VAR_RE = /var\(--vx-([A-Za-z0-9-]+)\)/g;

function namesIn(text: string): string[] {
  return [...text.matchAll(VAR_RE)].map(m => m[1]);
}

function expectEmitted(where: string, text: string) {
  for (const n of namesIn(text)) expect(VARS, `${where} references --vx-${n}`).toHaveProperty(n);
}

describe("theme CSS variables", () => {
  it("emits every property into THEME_CSS", () => {
    for (const k of Object.keys(VARS)) expect(THEME_CSS).toContain(`--vx-${k}:`);
  });

  it("every recipe references only emitted properties", () => {
    const outputs: Record<string, unknown> = {
      SURFACE, BORDER, fieldStyle,
      btnBase: btnBase(), btnHover: btnHover(), btnPressed: btnPressed(),
      currentRow: currentRow(), liftRow: liftRow(),
      ...Object.fromEntries(Object.entries(ACCENTS).map(([k, h]) => [`btnActive.${k}`, btnActive(h)])),
      btnActiveOther: btnActive("#f59e0b"),
    };
    for (const [k, o] of Object.entries(outputs)) expectEmitted(k, JSON.stringify(o));
    expectEmitted("THEME_CSS", THEME_CSS);
  });

  it("a family accent resolves to its vars; any other hex is computed inline", () => {
    expect(accentFamily(ACCENTS.selection)).toBe("selection");
    expect(btnActive(ACCENTS.selection).background).toBe(v("armed-selection-bg"));
    expect(accentFamily("#f59e0b")).toBeNull();
    expect(String(btnActive("#f59e0b").background)).toMatch(/^linear-gradient/);
  });

  it("no source file references an unemitted --vx- property", () => {
    // Vite's glob, not node:fs — the app's tsconfig carries no node types.
    const files = import.meta.glob<string>(["../**/*.{ts,tsx,css}", "!../**/*.test.ts"], {
      query: "?raw", import: "default", eager: true,
    });
    expect(Object.keys(files).length).toBeGreaterThan(50);
    for (const [f, text] of Object.entries(files)) expectEmitted(f, text);
  });
});
