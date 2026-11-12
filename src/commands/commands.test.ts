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
  ALL_SCOPES, chordKey, chordToAccelerator, firstAccelerator, formatChord, keyLabel, matchChord, primaryModDown, scopesOverlap, type Chord, type KeyLike,
} from "./keys";
import {
  MENU_BAR, MENU_BAR_EXCLUDED, MENU_SAFE_KINDS, SPLASH_SAFE, TEXT_FORWARD, isCheckItem, menuCommandForKey, menuCommandIds,
} from "./menuBar";
import { ECHO_MS, decideMenuAction, menuItemState, shouldDropMenuEcho } from "./menuRouting";
import type { CommandBinding } from "./types";
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
      } else if (!("bar" in p)) {
        expect(id.startsWith("app."), id).toBe(true);
      }
    }
  });

  it("every tab-path command is rendered in a tab, or marked paletteOnly", () => {
    const files = import.meta.glob(["../ribbon/tabs/*.tsx", "../ribbon/*.ts", "../ribbon/*.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const src = Object.values(files).join("\n");
    const missing = COMMAND_IDS.filter(id => {
      if (meta(id).paletteOnly || !placements(id).some(isTabPath)) return false;
      if (id.startsWith("sculpt.tools.")) return false; // rendered from SCULPT_ALL (`sculpt.tools.${tool}`), not by literal id
      return !src.includes(`"${id}"`);
    });
    expect(missing, "declare a tab path but no tab renders them: render them or set paletteOnly").toEqual([]);
  });

  it("labels are unique within a group", () => {
    const seen = new Map<string, CommandId>();
    for (const id of COMMAND_IDS) {
      const p = meta(id).path;
      const key = `${isTabPath(p) ? `${p.tab}.${p.group}` : "menu" in p ? p.menu : `bar.${p.bar}`}|${meta(id).label.toLowerCase()}`;
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

  it("only ⌘K and ⌘Q are dispatched by the registry (⌘Q through the macOS menu bar)", () => {
    const registry = COMMAND_IDS.filter(id => meta(id).handledBy === "registry");
    expect([...registry].sort()).toEqual(["app.commandSearch", "app.quit"]);
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

describe("macOS menu bar (34.1)", () => {
  const ids = menuCommandIds();
  const ev = (o: Partial<KeyLike>): KeyLike => ({ key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

  it("every menu id exists, appears once, and has a kind a menu item can show", () => {
    expect(new Set(ids).size, "an id appears twice").toBe(ids.length);
    for (const id of ids) {
      expect(COMMAND_META[id], id).toBeDefined();
      expect(MENU_SAFE_KINDS as readonly string[], `${id} kind`).toContain(meta(id).kind);
    }
  });

  it("every application-menu command is in the bar or explicitly excluded with a reason", () => {
    for (const id of COMMAND_IDS) {
      const p = meta(id).path;
      if (!("menu" in p) || p.menu !== "app") continue;
      const inBar = ids.includes(id);
      const excluded = id in MENU_BAR_EXCLUDED;
      expect(inBar || excluded, `${id} is neither in menuBar.ts nor MENU_BAR_EXCLUDED`).toBe(true);
      expect(inBar && excluded, `${id} is both in the bar and excluded`).toBe(false);
    }
    for (const [id, why] of Object.entries(MENU_BAR_EXCLUDED)) expect(why, id).toBeTruthy();
  });

  it("no two items share an accelerator", () => {
    const seen = new Map<string, string>();
    for (const id of ids) {
      const a = firstAccelerator(meta(id).keys);
      if (!a) continue;
      expect(seen.get(a), `${a}: ${id} vs ${seen.get(a)}`).toBeUndefined();
      seen.set(a, id);
    }
  });

  it("only `mod` chords become accelerators, and they stay stable (muda's parser accepts these literals)", () => {
    for (const id of COMMAND_IDS) {
      for (const c of meta(id).keys ?? []) {
        const a = chordToAccelerator(c);
        if (!c.mod) expect(a, `${id} bare/⌥ chord must not be an accelerator`).toBeNull();
        else expect(a, id).not.toBeNull();
      }
    }
    expect(Object.fromEntries(ids.map(id => [id, firstAccelerator(meta(id).keys)]).filter(([, a]) => a))).toEqual({
      "app.settings": "CmdOrCtrl+,",
      "app.quit": "CmdOrCtrl+Q",
      "app.new": "CmdOrCtrl+N",
      "app.open": "CmdOrCtrl+O",
      "app.close": "CmdOrCtrl+W",
      "app.save": "CmdOrCtrl+S",
      "app.saveAs": "CmdOrCtrl+Shift+S",
      "app.undo": "CmdOrCtrl+Z",
      "app.redo": "CmdOrCtrl+Shift+Z",
      "home.clipboard.cut": "CmdOrCtrl+X",
      "home.clipboard.copy": "CmdOrCtrl+C",
      "home.clipboard.paste": "CmdOrCtrl+V",
      "selection.modify.selectAll": "CmdOrCtrl+A",
      "home.selection.clear": "CmdOrCtrl+D",
      "app.goto": "CmdOrCtrl+G",
      "app.commandSearch": "CmdOrCtrl+K",
      "view.zoom.fit": "CmdOrCtrl+0",
      "view.zoom.selection": "CmdOrCtrl+Shift+0",
      "view.zoom.in": "CmdOrCtrl+=",
      "view.zoom.out": "CmdOrCtrl+-",
    });
    expect(chordToAccelerator({ key: "s", scope: "global" })).toBeNull();
    expect(chordToAccelerator({ code: "Digit3", alt: true, scope: "global" })).toBeNull();
    expect(chordToAccelerator({ key: "t", mod: true, alt: true, scope: "global" })).toBe("CmdOrCtrl+Alt+T");
  });

  it("toggles become check items except the ones whose label already carries the state", () => {
    expect(isCheckItem("view.mapview.cutaway")).toBe(true);
    expect(isCheckItem("view.windows.lens")).toBe(true);
    expect(isCheckItem("app.collapseRibbon")).toBe(false);
    expect(isCheckItem("view.zoom.fit")).toBe(false);
  });

  it("the splash-safe set and the text-forwarded Edit items are all in the bar", () => {
    for (const id of [...SPLASH_SAFE, ...Object.keys(TEXT_FORWARD) as CommandId[]]) expect(ids, id).toContain(id);
    for (const m of MENU_BAR) expect(m.items.length, m.title).toBeGreaterThan(0);
  });

  it("a key the legacy handler runs maps to its menu command; ⌘Q (no JS handler) never does", () => {
    expect(menuCommandForKey(ev({ key: "s", metaKey: true }), true)).toBe("app.save");
    expect(menuCommandForKey(ev({ key: "S", metaKey: true, shiftKey: true }), true)).toBe("app.saveAs");
    expect(menuCommandForKey(ev({ key: "z", metaKey: true }), true)).toBe("app.undo");
    expect(menuCommandForKey(ev({ key: "q", metaKey: true }), true)).toBeNull();
    expect(menuCommandForKey(ev({ key: "k", metaKey: true }), true)).toBeNull(); // ⌘K stamps itself in Ribbon
    expect(menuCommandForKey(ev({ key: "s", ctrlKey: true }), true)).toBeNull();
    expect(menuCommandForKey(ev({ key: "s", metaKey: true }), false)).toBeNull();
  });

  it("⌘Q is hidden from Help and the palette off-Mac", () => {
    expect(meta("app.quit").macOnly).toBe(true);
  });
});

describe("macOS menu bar: routing", () => {
  const open = { blocked: "none", hasWorld: true } as const;
  const ok: Pick<CommandBinding, "enabled"> = { enabled: true };

  it("text fields: the six Edit items go to the native responder, even inside a modal", () => {
    for (const [id, action] of Object.entries(TEXT_FORWARD) as [CommandId, string][]) {
      expect(decideMenuAction(id, true, open, ok)).toEqual({ kind: "forward", action });
      expect(decideMenuAction(id, true, { blocked: "modal", hasWorld: true }, ok)).toEqual({ kind: "forward", action });
      expect(decideMenuAction(id, true, { blocked: "none", hasWorld: false }, undefined)).toEqual({ kind: "forward", action });
    }
  });

  it("⌘D in a text field does not clear the map selection (the keydown handler leaves it to the field)", () => {
    expect(decideMenuAction("home.selection.clear", true, open, ok)).toEqual({ kind: "drop" });
    expect(decideMenuAction("home.selection.clear", false, open, ok)).toEqual({ kind: "run" });
  });

  it("a modal, a load or Help drops everything except Quit (and Help's own toggle)", () => {
    for (const blocked of ["modal", "loading"] as const) {
      expect(decideMenuAction("app.save", false, { blocked, hasWorld: true }, ok)).toEqual({ kind: "drop" });
      expect(decideMenuAction("app.quit", false, { blocked, hasWorld: true }, ok)).toEqual({ kind: "run" });
    }
    const help = { blocked: "help", hasWorld: true } as const;
    expect(decideMenuAction("app.save", false, help, ok)).toEqual({ kind: "drop" });
    expect(decideMenuAction("app.help", false, help, ok)).toEqual({ kind: "run" });
  });

  it("no world: only the splash-safe set runs", () => {
    const none = { blocked: "none", hasWorld: false } as const;
    expect(decideMenuAction("app.new", false, none, ok)).toEqual({ kind: "run" });
    expect(decideMenuAction("app.save", false, none, ok)).toEqual({ kind: "drop" });
    expect(decideMenuAction("app.help", false, none, ok)).toEqual({ kind: "drop" });
  });

  it("a disabled binding explains itself instead of running; a missing one is dropped", () => {
    expect(decideMenuAction("app.undo", false, open, { enabled: "Nothing to undo" })).toEqual({ kind: "notice", text: "Nothing to undo" });
    expect(decideMenuAction("app.save", false, open, undefined)).toEqual({ kind: "drop" });
  });

  it("item state: greyed behind a modal, but the text-capable Edit items and Quit stay live", () => {
    const b = (o: Partial<CommandBinding> = {}): CommandBinding => ({ run: () => {}, enabled: true, ...o });
    const modal = { blocked: "modal", hasWorld: true } as const;
    expect(menuItemState("app.save", open, b()).enabled).toBe(true);
    expect(menuItemState("app.save", modal, b()).enabled).toBe(false);
    expect(menuItemState("app.undo", open, b({ enabled: "Nothing to undo" })).enabled).toBe(true); // a field's own Undo
    expect(menuItemState("app.undo", modal, b()).enabled).toBe(true);
    expect(menuItemState("app.quit", modal, b()).enabled).toBe(true);
    expect(menuItemState("app.save", open, b({ enabled: "Saving…" })).enabled).toBe(false);
    expect(menuItemState("app.help", { blocked: "help", hasWorld: true }, b()).enabled).toBe(true);
    // splash: only the safe set, and only with a binding
    expect(menuItemState("app.new", { blocked: "none", hasWorld: false }, b()).enabled).toBe(true);
    expect(menuItemState("app.save", { blocked: "none", hasWorld: false }, undefined).enabled).toBe(false);
  });

  it("item state: checks follow `armed`; a labelOverride replaces the text", () => {
    const g = open;
    expect(menuItemState("view.mapview.cutaway", g, { run: () => {}, enabled: true, armed: true }).checked).toBe(true);
    expect(menuItemState("view.mapview.cutaway", g, undefined).checked).toBe(false);
    expect(menuItemState("view.zoom.fit", g, { run: () => {}, enabled: true }).checked).toBeNull();
    expect(menuItemState("app.collapseRibbon", g, { run: () => {}, enabled: true, labelOverride: "Expand Ribbon" }).text).toBe("Expand Ribbon");
    expect(menuItemState("app.save", g, undefined).text).toBe("Save");
  });

  it("echo dedupe: the same id inside 250 ms is dropped, another id or a later press is not", () => {
    const last = { id: "app.undo", t: 1000 };
    expect(shouldDropMenuEcho(last, "app.undo", 1100)).toBe(true);
    expect(shouldDropMenuEcho(last, "app.undo", 1000 + ECHO_MS)).toBe(false);
    expect(shouldDropMenuEcho(last, "app.redo", 1100)).toBe(false);
    expect(shouldDropMenuEcho(null, "app.undo", 1100)).toBe(false);
    // key repeat: a held ⌘Z comes in as separate presses ≥ 250 ms apart or via one path only — never both
    expect(shouldDropMenuEcho(last, "app.undo", 900)).toBe(false);
  });
});

describe("34.10 Mac modifier correctness", () => {
  const ev = (metaKey: boolean, ctrlKey: boolean) => ({ metaKey, ctrlKey });
  it("primaryModDown requires the platform's modifier with the other up", () => {
    expect(primaryModDown(ev(true, false), true)).toBe(true);
    expect(primaryModDown(ev(false, true), true)).toBe(false);
    expect(primaryModDown(ev(true, true), true)).toBe(false);
    expect(primaryModDown(ev(false, true), false)).toBe(true);
    expect(primaryModDown(ev(true, false), false)).toBe(false);
    expect(primaryModDown(ev(true, true), false)).toBe(false);
  });
  it("Control/Meta glyphs follow the platform", () => {
    expect(keyLabel({ key: "Control", scope: "stroke" }, true)).toBe("⌃");
    expect(keyLabel({ key: "Control", scope: "stroke" }, false)).toBe("Ctrl");
    expect(keyLabel({ key: "Meta", scope: "stroke" }, true)).toBe("⌘");
  });
});
