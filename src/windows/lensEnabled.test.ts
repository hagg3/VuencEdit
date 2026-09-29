import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The store is module-level state, so each test imports a fresh copy against a fresh fake
 *  localStorage (vitest here is node-environment). */
let mem: Map<string, string>;
beforeEach(() => {
  mem = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  });
  vi.resetModules();
});
afterEach(() => { vi.unstubAllGlobals(); });

const load = () => import("./useWindowLayout");

describe("paste lens session flag (Stage 16.1)", () => {
  it("is enabled on a fresh launch", async () => {
    const m = await load();
    m.loadWorld("/w/a.eden", "id-a");
    expect(m.getWindowState().wins.lens.open).toBe(true);
  });

  it("closing it persists nothing about enabled — the next launch starts enabled again", async () => {
    const m = await load();
    m.loadWorld("/w/a.eden", "id-a");
    m.closeWin("lens");
    expect(m.getWindowState().wins.lens.open).toBe(false);
    m.closeWorld(); // flushes the debounced write
    const stored = JSON.parse(mem.get("vuencedit_window_layouts")!);
    expect(stored.worlds[0].layout.wins.lens.open).toBe(true);
    expect(stored.last.wins.lens.open).toBe(true);

    vi.resetModules(); // "relaunch" — same localStorage, fresh module state
    const m2 = await load();
    m2.loadWorld("/w/a.eden", "id-a");
    expect(m2.getWindowState().wins.lens.open).toBe(true);
  });

  it("stays off across a world switch within the session, and turns back on with openWin", async () => {
    const m = await load();
    m.loadWorld("/w/a.eden", "id-a");
    m.closeWin("lens");
    m.loadWorld("/w/b.eden", "id-b"); // New World / Open — a different stored layout applies
    expect(m.getWindowState().wins.lens.open).toBe(false);
    m.openWin("lens");
    m.loadWorld("/w/a.eden", "id-a");
    expect(m.getWindowState().wins.lens.open).toBe(true);
  });

  it("keeps the lens geometry persisted per world", async () => {
    const m = await load();
    m.loadWorld("/w/a.eden", "id-a");
    const w = m.getWindowState().wins.lens;
    m.setWin("lens", { ...w, dx: 123, dy: 45 });
    m.closeWorld();
    vi.resetModules();
    const m2 = await load();
    m2.loadWorld("/w/a.eden", "id-a");
    expect(m2.getWindowState().wins.lens).toMatchObject({ dx: 123, dy: 45, open: true });
  });
});
