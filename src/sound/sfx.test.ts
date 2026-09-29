import { describe, it, expect } from "vitest";
import { CUE_IDS, SOUND_PACKS, cueDuration, type PackId } from "./packs";

const NAMING_BAN = /platinum|mac\s?os/i;

describe("sound pack data", () => {
  it("every cue of every pack ends at or under 250ms", () => {
    for (const packId of Object.keys(SOUND_PACKS) as PackId[]) {
      for (const cue of CUE_IDS) {
        const ms = cueDuration(packId, cue) * 1000;
        expect(ms, `${packId}.${cue} = ${ms}ms`).toBeLessThanOrEqual(250);
      }
    }
  });

  it("every pack defines the full cue set, or is \"none\" (silent)", () => {
    for (const pack of Object.values(SOUND_PACKS)) {
      const defined = Object.keys(pack.cues);
      if (pack.id === "none") {
        expect(defined.length).toBe(0);
        continue;
      }
      for (const cue of CUE_IDS) {
        expect(pack.cues[cue], `${pack.id} is missing cue "${cue}"`).toBeTruthy();
        expect(pack.cues[cue]!.length, `${pack.id}.${cue} has no voices`).toBeGreaterThan(0);
      }
    }
  });

  it("no pack id or label matches the banned naming pattern", () => {
    for (const pack of Object.values(SOUND_PACKS)) {
      expect(pack.id).not.toMatch(NAMING_BAN);
      expect(pack.label).not.toMatch(NAMING_BAN);
    }
  });
});

/** Repo-wide guard over the *shipped* source, not just the data file: a stray comment, a leftover
 *  branch name, a debug string — anywhere under `src/sound/**` — would be just as much a shipped
 *  reference as the pack table itself. Uses Vite's `import.meta.glob`, not `node:fs` — this app's
 *  tsconfig carries no node types (same idiom as `src/theme/cssVars.test.ts`'s repo-wide var scan).
 *  ⚠️ Test files themselves are excluded from the glob — this file and its neighbours necessarily
 *  *mention* the banned pattern (in the regex literal and in this very comment) in order to test
 *  for it; that is not a shipped reference. */
describe("no banned naming anywhere under src/sound (excluding test files)", () => {
  it("grep-style scan finds no /platinum|mac ?os/i match", () => {
    const files = import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.ts"], {
      query: "?raw", import: "default", eager: true,
    });
    expect(Object.keys(files).length).toBeGreaterThan(0); // guards against the scan silently finding nothing
    const offenders: string[] = [];
    for (const [f, text] of Object.entries(files)) {
      if (NAMING_BAN.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
