import { describe, it, expect } from "vitest";

/**
 * The modal-migration drift guard (UI redesign r3, Stage 14.17 — plan §5). Every `src/*Modal.tsx`
 * file must stop importing the retired hand-rolled chrome (`glassPanel`/`glassTab`/`chromeButton`/
 * `chromeButtonAccent`) and render the shared `Dialog` primitive instead. Lands in D0 with an
 * allowlist of the dialogs D1–D4 haven't migrated yet; the allowlist shrinks to empty by D4.
 *
 * Grep-style file-content scan, the `sound/sfx.test.ts` idiom: Vite's `import.meta.glob`, not
 * `node:fs` (this app's tsconfig carries no node types).
 */

/** `src/Modal.tsx` itself is the primitive `Dialog` wraps — it can't render `<Dialog>` without
 *  being circular, and it never imported the banned chrome to begin with. */
const BASE_MODAL = "/Modal.tsx";

/** No rows left un-migrated — kept as an empty set so a future new dialog has somewhere to land
 *  temporarily rather than needing this file's shape rediscovered. */
const NOT_YET_MIGRATED = new Set<string>([]);

const BANNED_IMPORT = /\b(glassPanel|glassTab|chromeButtonAccent|chromeButton)\b/;

describe("modal dialogs migrated onto the shared Dialog chrome", () => {
  const files = import.meta.glob<string>(["../*Modal.tsx"], { query: "?raw", import: "default", eager: true });
  const entries = Object.entries(files).map(([f, text]) => [f.replace(/^\.\.\/?src/, "").replace(/^\.\./, ""), text] as const);

  it("found the expected modal files (glob sanity check)", () => {
    expect(entries.length).toBeGreaterThanOrEqual(10);
  });

  for (const [path, text] of entries) {
    const name = `/${path.split("/").pop()}`;
    if (NOT_YET_MIGRATED.has(name)) continue; // D1–D4's rows, not this one's — allowlisted for now

    it(`${name} does not import the retired glassPanel/glassTab/chromeButton chrome`, () => {
      const offenders = (text.match(new RegExp(BANNED_IMPORT, "g")) ?? []).filter(m =>
        // Only count real imports — the plan/comment text mentioning these names by name (e.g. this
        // very test file's own doc comment, or a migration note in a just-converted file) isn't one.
        new RegExp(`import\\s*\\{[^}]*\\b${m}\\b[^}]*\\}\\s*from`).test(text),
      );
      expect(offenders, `${name} still imports: ${offenders.join(", ")}`).toEqual([]);
    });

    if (name === BASE_MODAL) continue;

    it(`${name} renders <Dialog`, () => {
      expect(text, `${name} does not render <Dialog`).toMatch(/<Dialog\b/);
    });
  }
});

/**
 * Yes/no questions go through `ui/confirm.tsx`'s in-app `confirmDialog`, never the OS-native
 * `ask`/`message`/`confirm` from `@tauri-apps/plugin-dialog` (or `window.confirm`/`alert`), which
 * look like nothing else in the app. The native file pickers (`open`/`save`) stay — users expect
 * the OS file browser there.
 */
describe("no OS-native message boxes", () => {
  const files = import.meta.glob<string>(["../**/*.tsx", "../**/*.ts", "!../**/*.test.ts"], { query: "?raw", import: "default", eager: true });
  const NATIVE_DIALOG = /import\s*\{[^}]*\b(ask|message|confirm)\b[^}]*\}\s*from\s*["']@tauri-apps\/plugin-dialog["']/;
  const WINDOW_BOX = /\bwindow\.(confirm|alert|prompt)\s*\(/;
  it("scans a plausible number of source files", () => {
    expect(Object.keys(files).length).toBeGreaterThan(50);
  });
  for (const [f, text] of Object.entries(files)) {
    it(`${f} uses confirmDialog, not a native box`, () => {
      expect(NATIVE_DIALOG.test(text)).toBe(false);
      expect(WINDOW_BOX.test(text)).toBe(false);
    });
  }
});
