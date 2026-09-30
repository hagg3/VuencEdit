import { describe, it, expect } from "vitest";
import { WIN_IDS, defaultWins, winLimits } from "./windowGeometry";
import {
  EMPTY_STORE, MAX_WORLDS, copyForSaveAs, migrateStore, normalizePath, parseStore, pickLayout,
  recordLayout, sanitizeLayout, worldIdentity, type LayoutStore, type WorldLayout,
} from "./windowStorage";

const DEF = defaultWins({ w: 1200, h: 700 }, { view3dOpen: true, toolsOpen: true, toolsCollapsed: false });
const layout = (swapped = false, dx = 8): WorldLayout => ({
  swapped, wins: { ...DEF, tools: { ...DEF.tools, dx } }, workAtSave: { w: 1200, h: 700 },
});
const ID = worldIdentity({ width_chunks: 10, height_chunks: 12, abs_min_x: 3, abs_min_y: 4 }, "legacy64z");

describe("pickLayout", () => {
  it("hits on path first", () => {
    let s: LayoutStore = EMPTY_STORE;
    s = recordLayout(s, "/w/a.eden", ID, layout(true), 1);
    s = recordLayout(s, "/w/b.eden", "other", layout(false), 2);
    expect(pickLayout(s, "/w/a.eden", "nope")).toMatchObject({ source: "path", layout: { swapped: true } });
  });
  it("falls back to the header identity when the path misses", () => {
    const s = recordLayout(EMPTY_STORE, "/w/a.eden", ID, layout(true), 1);
    expect(pickLayout(s, "/Downloads/a copy.eden", ID)).toMatchObject({ source: "identity", layout: { swapped: true } });
  });
  it("inherits the most recently left layout when both miss", () => {
    let s = recordLayout(EMPTY_STORE, "/w/a.eden", ID, layout(false, 11), 1);
    s = recordLayout(s, "/w/b.eden", "B", layout(true, 22), 2);
    const got = pickLayout(s, "/w/new.eden", "new");
    expect(got.source).toBe("last");
    expect(got.layout?.wins.tools.dx).toBe(22);
  });
  it("returns null (use defaults) on a fresh install", () => {
    expect(pickLayout(EMPTY_STORE, "/w/a.eden", ID)).toEqual({ layout: null, source: "default" });
  });
});

describe("recordLayout", () => {
  it("replaces a path match instead of duplicating it", () => {
    let s = recordLayout(EMPTY_STORE, "/a", ID, layout(false), 1);
    s = recordLayout(s, "/a", ID, layout(true), 2);
    expect(s.worlds).toHaveLength(1);
    expect(s.worlds[0].layout.swapped).toBe(true);
  });
  it("evicts the least recently used past MAX_WORLDS", () => {
    let s = EMPTY_STORE;
    for (let i = 0; i <= MAX_WORLDS; i++) s = recordLayout(s, `/w/${i}`, `id${i}`, layout(), i);
    expect(s.worlds).toHaveLength(MAX_WORLDS);
    expect(s.worlds.find(e => e.path === "/w/0")).toBeUndefined();
    expect(s.worlds.find(e => e.path === `/w/${MAX_WORLDS}`)).toBeDefined();
  });
});

describe("copyForSaveAs", () => {
  it("gives the new path the old path's layout", () => {
    const s = copyForSaveAs(recordLayout(EMPTY_STORE, "/a.eden", ID, layout(true), 1), "/a.eden", "/b.eden", ID, 2);
    expect(pickLayout(s, "/b.eden", "x")).toMatchObject({ source: "path", layout: { swapped: true } });
  });
  it("is a no-op when nothing is recorded for the world", () => {
    expect(copyForSaveAs(EMPTY_STORE, "/a", "/b", ID, 1)).toBe(EMPTY_STORE);
  });
});

describe("normalizePath", () => {
  it("case-folds and unifies separators on Windows only", () => {
    expect(normalizePath("C:/Worlds/My.eden", true)).toBe("c:\\worlds\\my.eden");
    expect(normalizePath("/Users/X/My.eden", false)).toBe("/Users/X/My.eden");
    expect(normalizePath(null, true)).toBeNull();
  });
});

describe("parseStore / sanitize", () => {
  it("round-trips through JSON", () => {
    const s = recordLayout(EMPTY_STORE, "/a", ID, layout(true, 30), 5);
    const back = parseStore(JSON.stringify(s), DEF);
    expect(back).toEqual(s);
  });
  it("turns corrupt JSON into an empty store instead of throwing", () => {
    expect(parseStore("{not json", DEF)).toEqual(EMPTY_STORE);
    expect(parseStore("42", DEF)).toEqual(EMPTY_STORE);
    expect(parseStore(null, DEF)).toEqual(EMPTY_STORE);
  });
  it("replaces NaN/negative numbers with defaults and drops unknown ids", () => {
    const l = sanitizeLayout({ swapped: true, wins: { tools: { w: -5, h: "x", dx: NaN, open: false }, bogus: {} } }, DEF)!;
    expect(l.wins.tools.w).toBe(DEF.tools.w);
    expect(l.wins.tools.h).toBe(DEF.tools.h);
    expect(l.wins.tools.dx).toBe(DEF.tools.dx);
    expect(l.wins.tools.open).toBe(false);
    expect(Object.keys(l.wins).sort()).toEqual([...WIN_IDS].sort());
  });
  it("discards a store from an unknown version (migration stub)", () => {
    expect(migrateStore({ v: 99 })).toBeNull();
    expect(parseStore(JSON.stringify({ v: 99, last: layout(), worlds: [] }), DEF)).toEqual(EMPTY_STORE);
  });
});

describe("paste lens enabled flag is session-only (16.1)", () => {
  it("the shipped default is enabled", () => {
    expect(DEF.lens.open).toBe(true);
  });
  it("recordLayout never persists a disabled lens", () => {
    const off: WorldLayout = { ...layout(), wins: { ...DEF, lens: { ...DEF.lens, open: false, dx: 40 } } };
    const s = recordLayout(EMPTY_STORE, "/a", ID, off, 1);
    expect(s.worlds[0].layout.wins.lens.open).toBe(true);
    expect(s.last?.wins.lens.open).toBe(true);
    expect(s.worlds[0].layout.wins.lens.dx).toBe(40); // geometry still persists
  });
  it("sanitizeLayout ignores a stored open:false (pre-16.1 default) but keeps geometry", () => {
    const raw = { swapped: false, wins: { lens: { ...DEF.lens, open: false, dx: 77, collapsed: true } }, workAtSave: { w: 1, h: 1 } };
    const got = sanitizeLayout(raw, DEF)!;
    expect(got.wins.lens.open).toBe(true);
    expect(got.wins.lens.dx).toBe(77);
    expect(got.wins.lens.collapsed).toBe(true);
  });
});

describe("stored sizes are clamped to the window limits on load (16.2)", () => {
  it("pulls an oversize lens down to its ~2x cap (19.8) and an oversize hotbar to the 44 px slot cap", () => {
    const raw = {
      swapped: false, workAtSave: { w: 1, h: 1 },
      wins: { lens: { ...DEF.lens, w: 1800, h: 1100 }, hotbar: { ...DEF.hotbar, w: 2000, h: 300 } },
    };
    const got = sanitizeLayout(raw, DEF)!;
    expect(got.wins.lens.w).toBe(640);
    expect(got.wins.lens.h).toBe(420);
    expect(got.wins.hotbar.w).toBe(winLimits("hotbar", { w: 0, h: 0 }).max.w);
  });
  it("pulls a wild Tools/Hotbar size into [min, max] but keeps position", () => {
    const raw = {
      swapped: false, workAtSave: { w: 1, h: 1 },
      wins: {
        tools: { ...DEF.tools, w: 900, h: 900, dx: 33 },
        hotbar: { ...DEF.hotbar, w: 1, h: 1 },
      },
    };
    const got = sanitizeLayout(raw, DEF)!;
    const t = winLimits("tools", { w: 0, h: 0 }), h = winLimits("hotbar", { w: 0, h: 0 });
    expect(got.wins.tools.w).toBe(t.max.w);
    expect(got.wins.tools.h).toBe(t.max.h);
    expect(got.wins.tools.dx).toBe(33);
    expect(got.wins.hotbar.w).toBe(h.min.w);
    expect(got.wins.hotbar.h).toBe(h.min.h);
  });
});

describe("3D view open/closed survives a relaunch and New World (16.3)", () => {
  const with3d = (open: boolean): WorldLayout => ({
    swapped: false, wins: { ...DEF, view3d: { ...DEF.view3d, open } }, workAtSave: { w: 1200, h: 700 },
  });
  // A relaunch = the store round-tripped through its serialized form, then a world opened cold.
  const relaunch = (s: LayoutStore) => parseStore(JSON.stringify(s), DEF);

  for (const open of [false, true]) {
    it(`a relaunch into a never-seen world inherits view3d.open=${open} from last`, () => {
      let s = recordLayout(EMPTY_STORE, "/w/a.eden", ID, with3d(!open), 1);
      s = recordLayout(s, "/w/b.eden", "B", with3d(open), 2); // the world the user left last
      const got = pickLayout(relaunch(s), "/w/c.eden", "C");
      expect(got.source).toBe("last");
      expect(got.layout?.wins.view3d.open).toBe(open);
    });
    it(`a relaunch into the same world restores its own view3d.open=${open}`, () => {
      const s = recordLayout(EMPTY_STORE, "/w/a.eden", ID, with3d(open), 1);
      expect(pickLayout(relaunch(s), "/w/a.eden", ID).layout?.wins.view3d.open).toBe(open);
    });
  }

  it("a fresh New World skips a same-dims identity match and inherits last", () => {
    // World A shares the new world's dims (every default-size Flat world does) and had 3D closed;
    // the user then left world B with 3D open.
    let s = recordLayout(EMPTY_STORE, "/w/a.eden", ID, with3d(false), 1);
    s = recordLayout(s, "/w/b.eden", "B", with3d(true), 2);
    expect(pickLayout(s, "/w/new.eden", ID).source).toBe("identity"); // the old trap
    const got = pickLayout(relaunch(s), "/w/new.eden", ID, true);
    expect(got.source).toBe("last");
    expect(got.layout?.wins.view3d.open).toBe(true);
  });
  it("fresh still honours an exact path hit (New World overwrote an existing file)", () => {
    const s = recordLayout(EMPTY_STORE, "/w/a.eden", ID, with3d(false), 1);
    expect(pickLayout(s, "/w/a.eden", ID, true).source).toBe("path");
  });
});
