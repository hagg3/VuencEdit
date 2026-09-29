/**
 * The command registry's drift guards (commands sub-plan §4.3). Together with `bind.ts`'s
 * `satisfies Record<CommandId, …>` and the tab lint, these are what make "the ribbon and ⌘K can't
 * drift" a build failure rather than a hope.
 */
import { describe, expect, it } from "vitest";
import { COMMAND_IDS, COMMAND_META, GESTURES, HELP_SECTIONS, meta, type CommandId, type CommandPath } from "./meta";
import { TAB_SPECS } from "../ribbon/specs";
import { TOOL_LABELS } from "../MapCanvas";
import {
  ALL_SCOPES, chordKey, formatChord, matchChord, scopesOverlap, type Chord, type KeyLike,
} from "./keys";
import { pushMru, rank, scoreEntry } from "./search";
import type { RibbonTab } from "../ribbon/props";

const placements = (id: CommandId): CommandPath[] => [meta(id).path, ...(meta(id).also ?? [])];
const isTabPath = (p: CommandPath): p is { tab: RibbonTab; group: string } => "tab" in p;

describe("command registry: paths", () => {
  it("every ribbon path names a real tab and group", () => {
    for (const id of COMMAND_IDS) {
      for (const p of placements(id)) {
        if (!isTabPath(p)) continue;
        const tab = TAB_SPECS[p.tab];
        expect(tab, `${id}: tab ${p.tab}`).toBeDefined();
        expect(tab.groups.some(g => g.id === p.group), `${id}: group ${p.tab}.${p.group}`).toBe(true);
      }
    }
  });

  it("every group has a command, or is explicitly optionsOnly", () => {
    for (const [tab, spec] of Object.entries(TAB_SPECS)) {
      for (const g of spec.groups) {
        if (g.optionsOnly) continue;
        const has = COMMAND_IDS.some(id => placements(id).some(p => isTabPath(p) && p.tab === tab && p.group === g.id));
        expect(has, `${tab}.${g.id} has no command`).toBe(true);
      }
    }
  });

  it("ids follow the path they're filed under", () => {
    for (const id of COMMAND_IDS) {
      const p = meta(id).path;
      if (isTabPath(p)) {
        const prefix = p.tab === "paste" ? "paste" : p.tab;
        expect(id.startsWith(`${prefix}.${p.group}.`), id).toBe(true);
      } else {
        expect(id.startsWith("app."), id).toBe(true);
      }
    }
  });

  it("labels are unique within a group", () => {
    const seen = new Map<string, CommandId>();
    for (const id of COMMAND_IDS) {
      const p = meta(id).path;
      const key = `${isTabPath(p) ? `${p.tab}.${p.group}` : "menu" in p ? p.menu : "panel"}|${meta(id).label.toLowerCase()}`;
      expect(seen.get(key), `${id} duplicates ${seen.get(key)}`).toBeUndefined();
      seen.set(key, id);
    }
  });
});

describe("command registry: tools and text", () => {
  it("every tool command arms a real Tool, and the tools it arms are distinct", () => {
    const armed = new Map<string, CommandId>();
    for (const id of COMMAND_IDS) {
      const m = meta(id);
      if (m.kind !== "tool") { expect(m.tool, `${id} has a tool but isn't kind:"tool"`).toBeUndefined(); continue; }
      expect(m.tool, `${id} is kind:"tool" without a tool`).toBeDefined();
      expect(TOOL_LABELS[m.tool!], `${id}: ${m.tool}`).toBeDefined();
      expect(armed.get(m.tool!), `${id} and ${armed.get(m.tool!)} arm the same tool`).toBeUndefined();
      armed.set(m.tool!, id);
    }
  });

  it("no platform-branded strings in any label, title or keyword", () => {
    const bad = /mac\s?os|platinum/i;
    for (const id of COMMAND_IDS) {
      const m = meta(id);
      for (const s of [m.label, m.title ?? "", ...(m.keywords ?? [])]) expect(bad.test(s), `${id}: ${s}`).toBe(false);
    }
  });

  it("help rows name known sections", () => {
    for (const id of COMMAND_IDS) {
      const h = meta(id).help;
      if (h) expect(HELP_SECTIONS).toContain(h.section);
    }
    for (const g of GESTURES) expect(HELP_SECTIONS).toContain(g.section);
  });

  it("only ⌘K is dispatched by the registry this phase", () => {
    const registry = COMMAND_IDS.filter(id => meta(id).handledBy === "registry");
    expect(registry).toEqual(["app.commandSearch"]);
    for (const id of COMMAND_IDS) {
      if (meta(id).keys?.length) expect(meta(id).handledBy, `${id} has keys but no handler`).toBeDefined();
    }
  });
});

describe("shortcut collisions", () => {
  it("scope overlap is symmetric and reflexive", () => {
    for (const a of ALL_SCOPES) {
      expect(scopesOverlap(a, a)).toBe(true);
      for (const b of ALL_SCOPES) expect(scopesOverlap(a, b), `${a}/${b}`).toBe(scopesOverlap(b, a));
    }
  });

  it("no two commands or gestures share a chord in overlapping scopes", () => {
    const all: { who: string; c: Chord }[] = [
      ...COMMAND_IDS.flatMap(id => (meta(id).keys ?? []).map(c => ({ who: id, c }))),
      ...GESTURES.flatMap(g => (g.keys ?? []).map(c => ({ who: `gesture: ${g.text}`, c }))),
    ];
    const clashes: string[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        if (a.who === b.who) continue;
        if (chordKey(a.c) === chordKey(b.c) && scopesOverlap(a.c.scope, b.c.scope)) {
          clashes.push(`${formatChord(a.c, true)}: ${a.who} [${a.c.scope}] vs ${b.who} [${b.c.scope}]`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it("the ⌥ window toggles don't collide with the bare hotbar digits", () => {
    // ⌥3 and 3 share a physical key; the alt bit is what keeps them apart.
    const alt3 = meta("view.windows.view3d").keys![0];
    expect(chordKey(alt3)).not.toBe(chordKey({ key: "3", scope: "global" }));
  });
});

describe("keys", () => {
  const ev = (o: Partial<KeyLike>): KeyLike => ({ key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

  it("formats per platform", () => {
    const saveAs: Chord = { key: "s", mod: true, shift: true, scope: "global" };
    expect(formatChord(saveAs, true)).toBe("⌘⇧S");
    expect(formatChord(saveAs, false)).toBe("Ctrl+Shift+S");
    expect(formatChord({ code: "Digit3", alt: true, scope: "global" }, true)).toBe("⌥3");
    expect(formatChord({ code: "Digit3", alt: true, scope: "global" }, false)).toBe("Alt+3");
    expect(formatChord({ key: " ", hold: true, scope: "global" }, true)).toBe("Hold Space");
    expect(formatChord({ key: "-", mod: true, scope: "global" }, false)).toBe("Ctrl+Minus");
  });

  it("matches ⌘ on macOS and Ctrl elsewhere, never both", () => {
    const k: Chord = { key: "k", mod: true, scope: "global" };
    expect(matchChord(ev({ key: "k", metaKey: true }), k, true)).toBe(true);
    expect(matchChord(ev({ key: "k", ctrlKey: true }), k, true)).toBe(false);
    expect(matchChord(ev({ key: "k", ctrlKey: true }), k, false)).toBe(true);
    expect(matchChord(ev({ key: "K", ctrlKey: true, shiftKey: true }), k, false)).toBe(false);
  });

  it("matches ⌥ chords by code, and rejects Windows AltGr", () => {
    const c: Chord = { code: "Digit3", alt: true, scope: "global" };
    expect(matchChord(ev({ key: "£", code: "Digit3", altKey: true }), c, true)).toBe(true);
    expect(matchChord(ev({ key: "3", code: "Digit3", altKey: true }), c, false)).toBe(true);
    // AltGr+3 on a German layout arrives as Ctrl+Alt with key "³".
    expect(matchChord(ev({ key: "³", code: "Digit3", altKey: true, ctrlKey: true }), c, false)).toBe(false);
  });
});

describe("search", () => {
  const entries = COMMAND_IDS.map(id => ({ id, label: meta(id).label, path: "", keywords: meta(id).keywords }));

  it("prefix beats substring beats keyword", () => {
    const r = rank("fill", entries);
    expect(r[0]).toBe("draw.tools.fill");
    expect(r.indexOf("home.selection.fill")).toBeLessThan(r.indexOf("insert.fluids.poolFill"));
  });

  it("every token must match (AND)", () => {
    expect(scoreEntry("zoom selection", { id: "x", label: "Zoom to Selection", path: "" })).toBeGreaterThan(0);
    expect(scoreEntry("zoom banana", { id: "x", label: "Zoom to Selection", path: "" })).toBe(0);
  });

  it("finds the mock's example queries", () => {
    expect(rank("rock", entries)[0]).toBe("sculpt.tools.rock");
    expect(rank("swap", entries)[0]).toBe("view.layout.swap");
  });

  it("MRU breaks ties", () => {
    const two = [{ id: "a", label: "Flip X", path: "" }, { id: "b", label: "Flip Y", path: "" }];
    expect(rank("flip", two, [])).toEqual(["a", "b"]);
    expect(rank("flip", two, ["b"])).toEqual(["b", "a"]);
    expect(pushMru(["a", "b", "c"], "c", 2)).toEqual(["c", "a"]);
  });

  it("the registry has a sane size", () => {
    expect(Object.keys(COMMAND_META).length).toBeGreaterThan(120);
  });
});
