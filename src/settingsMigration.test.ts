import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Settings v18 (UI redesign r3, Stage 14.3/14.4, open question 1): every install moves to the map +
 * floating windows layout, the old quad-era toggles seed the inherited window layout, and a one-time
 * notice is armed. Exercised through the real `loadSettings()` with an in-memory localStorage.
 */
class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

let mem: MemStorage;
beforeEach(() => {
  mem = new MemStorage();
  vi.stubGlobal("localStorage", mem);
  vi.stubGlobal("navigator", { hardwareConcurrency: 8, deviceMemory: 8, platform: "MacIntel" });
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
});

async function load(blob: Record<string, unknown> | null, extra: Record<string, string> = {}) {
  if (blob) mem.setItem("eden_settings", JSON.stringify(blob));
  for (const [k, v] of Object.entries(extra)) mem.setItem(k, v);
  vi.resetModules();
  const mod = await import("./SettingsModal");
  return mod.loadSettings();
}

function lastLayout() {
  const raw = mem.getItem("vuencedit_window_layouts");
  return raw ? JSON.parse(raw).last : null;
}

describe("settings v18 migration", () => {
  it("moves a pre-v18 install to the windows layout (no Quad notice — Quad no longer exists)", async () => {
    const s = await load({ settingsVersion: 17, defaultQuadView: true, default3dPane: false, leftToolbarOpen: true, memoryBudget: "high" });
    expect(s).not.toHaveProperty("workLayout");
    expect(s.pendingQuadRetiredNotice).toBe(false);
    expect(s.settingsVersion).toBe(24); // now-current version — this test only cares about v18's own effects
    const stored = JSON.parse(mem.getItem("eden_settings")!);
    expect(stored).not.toHaveProperty("defaultQuadView");
    expect(stored).not.toHaveProperty("default3dPane");
    expect(stored).not.toHaveProperty("leftToolbarOpen");
    expect(lastLayout().wins.view3d.open).toBe(false);
    expect(lastLayout().wins.tools.open).toBe(true);
  });

  it("a map-only user (quad off) lands in the same place", async () => {
    await load({ settingsVersion: 17, defaultQuadView: false, default3dPane: false });
    expect(lastLayout().wins.view3d.open).toBe(false);
  });

  it("a 3D-on user gets the 3D window open", async () => {
    await load({ settingsVersion: 17, defaultQuadView: true, default3dPane: true });
    expect(lastLayout().wins.view3d.open).toBe(true);
  });

  it("carries the old tool rail's hidden/collapsed state into the Tools window", async () => {
    await load({ settingsVersion: 17, leftToolbarOpen: false }, { left_toolbar_collapsed: "1" });
    expect(lastLayout().wins.tools.open).toBe(false);
    expect(lastLayout().wins.tools.collapsed).toBe(true);
    expect(mem.getItem("left_toolbar_collapsed")).toBeNull();
  });

  it("never overwrites a layout the user already has", async () => {
    mem.setItem("vuencedit_window_layouts", JSON.stringify({ v: 1, last: { swapped: true, wins: {}, workAtSave: { w: 1, h: 1 } }, worlds: [] }));
    await load({ settingsVersion: 17, default3dPane: true });
    expect(lastLayout().swapped).toBe(true);
  });

  it("a fresh install never runs the migration: no seeded layout", async () => {
    const s = await load(null);
    expect(s).not.toHaveProperty("workLayout");
    expect(lastLayout()).toBeNull();
  });

  it("is a no-op for the v18 seed once already at v18 (a stale quad blob is handled by v23)", async () => {
    await load({ settingsVersion: 18, pendingLayoutNotice: false });
    expect(lastLayout()).toBeNull();
  });
});

/**
 * Settings v19 (UI redesign r3, Stage 14.12): UI sound cues. Purely additive — `migrate()` forces
 * no value, and it's the `{...DEFAULTS, ...parsed}` merge supplying `uiSounds: true` to an existing
 * install (which lacks the key entirely) that *is* the "on by default" decision.
 */
describe("settings v19 migration (UI sounds)", () => {
  it("an existing install gets sound on, Classic pack, 0.8 volume, with no explicit migrate() write", async () => {
    const s = await load({ settingsVersion: 18 });
    expect(s.uiSounds).toBe(true);
    expect(s.uiSoundPack).toBe("classic");
    expect(s.uiSoundVolume).toBe(0.8);
    expect(s.settingsVersion).toBe(24); // now-current version — this test only cares about v19's own effects
  });

  it("a user who already turned sound off before this version keeps that choice", async () => {
    const s = await load({ settingsVersion: 18, uiSounds: false, uiSoundPack: "glass", uiSoundVolume: 0.3 });
    expect(s.uiSounds).toBe(false);
    expect(s.uiSoundPack).toBe("glass");
    expect(s.uiSoundVolume).toBe(0.3);
  });

  it("a fresh install also gets sound on by default", async () => {
    const s = await load(null);
    expect(s.uiSounds).toBe(true);
    expect(s.uiSoundPack).toBe("classic");
  });

  it("is a no-op once already at v19 (still bumps to the now-current version)", async () => {
    const s = await load({ settingsVersion: 19, uiSounds: false });
    expect(s.uiSounds).toBe(false);
    expect(s.settingsVersion).toBe(24); // v19 < v23, so migrate() still runs — just none of *this* block's fields
  });
});

/**
 * Settings v20 (UI redesign r3, Stage 14.10): the opt-in compact command-bar ribbon. Purely
 * additive — `migrate()` forces no value, and it's the `{...DEFAULTS, ...parsed}` merge supplying
 * `ribbonCompact: false` to an existing install (which lacks the key entirely) that *is* the
 * "never the default" decision.
 */
describe("settings v20 migration (compact ribbon)", () => {
  it("an existing install gets ribbonCompact: false, with no explicit migrate() write", async () => {
    const s = await load({ settingsVersion: 19 });
    expect(s.ribbonCompact).toBe(false);
    expect(s.settingsVersion).toBe(24); // now-current version — this test only cares about v20's own effects
  });

  it("a user who already turned it on before this version keeps that choice", async () => {
    const s = await load({ settingsVersion: 19, ribbonCompact: true });
    expect(s.ribbonCompact).toBe(true);
  });

  it("a fresh install defaults to the labelled ribbon (compact off)", async () => {
    const s = await load(null);
    expect(s.ribbonCompact).toBe(false);
  });

  it("is a no-op once already at v20 (still bumps to the now-current version)", async () => {
    const s = await load({ settingsVersion: 20, ribbonCompact: true });
    expect(s.ribbonCompact).toBe(true);
    expect(s.settingsVersion).toBe(24); // v20 < v23, so migrate() still runs — just none of *this* block's fields
  });
});

/**
 * Settings v21 (UI redesign r3, Stage 14.13): the motion preference. Purely additive —
 * `migrate()` forces no value, and it's the `{...DEFAULTS, ...parsed}` merge supplying
 * `motion: "system"` to an existing install (which lacks the key entirely) that *is* the "keeps
 * following the OS's Reduce Motion setting" decision.
 */
describe("settings v21 migration (motion)", () => {
  it("an existing install gets motion: \"system\", with no explicit migrate() write", async () => {
    const s = await load({ settingsVersion: 20 });
    expect(s.motion).toBe("system");
    expect(s.settingsVersion).toBe(24); // now-current version — this test only cares about v21's own effects
  });

  it("a user who already forced full or reduced motion before this version keeps that choice", async () => {
    const s = await load({ settingsVersion: 20, motion: "reduced" });
    expect(s.motion).toBe("reduced");
  });

  it("a fresh install defaults to system", async () => {
    const s = await load(null);
    expect(s.motion).toBe("system");
  });

  it("is a no-op once already at v21 (still bumps to the now-current version)", async () => {
    const s = await load({ settingsVersion: 21, motion: "full" });
    expect(s.motion).toBe("full");
    expect(s.settingsVersion).toBe(24); // v21 < v23, so migrate() still runs — just none of *this* block's fields
  });
});

/**
 * Settings v22 (UI polish r4, Stage 15.2): the Quick Actions bar can no longer be hidden, so
 * `showQuickActions` is deleted from the stored blob entirely (v12 → v13's `delete` precedent),
 * not just defaulted.
 */
describe("settings v22 migration (quick actions bar removed)", () => {
  it("strips a stored showQuickActions key from an existing install", async () => {
    const s = await load({ settingsVersion: 21, showQuickActions: false });
    expect(s).not.toHaveProperty("showQuickActions");
    expect(s.settingsVersion).toBe(24);
    const stored = JSON.parse(mem.getItem("eden_settings")!);
    expect(stored).not.toHaveProperty("showQuickActions");
  });

  it("a fresh install never has the key either", async () => {
    const s = await load(null);
    expect(s).not.toHaveProperty("showQuickActions");
  });

  it("is a no-op once already at v22", async () => {
    const s = await load({ settingsVersion: 23 });
    expect(s).not.toHaveProperty("showQuickActions");
    expect(s.settingsVersion).toBe(24);
  });
});

/**
 * Settings v23 (UI polish r4, Stage 16.4): Quad (legacy) was retired. `workLayout`, `quad3dEnabled`
 * and `pendingLayoutNotice` are deleted; a user who was on Quad gets the 3D window open and a
 * one-shot notice flag (App turns it into a toast).
 */
describe("settings v23 migration (Quad retired)", () => {
  it("a quad user: dead keys stripped, notice armed, 3D window open in the seeded layout", async () => {
    const s = await load({ settingsVersion: 22, workLayout: "quad", quad3dEnabled: false, pendingLayoutNotice: false });
    expect(s).not.toHaveProperty("workLayout");
    expect(s).not.toHaveProperty("quad3dEnabled");
    expect(s).not.toHaveProperty("pendingLayoutNotice");
    expect(s.pendingQuadRetiredNotice).toBe(true);
    expect(s.settingsVersion).toBe(24);
    const stored = JSON.parse(mem.getItem("eden_settings")!);
    expect(stored).not.toHaveProperty("workLayout");
    expect(stored.pendingQuadRetiredNotice).toBe(true);
    expect(lastLayout().wins.view3d.open).toBe(true);
  });

  it("a quad user with an existing layout: the 3D window is forced open in last and every world; geometry kept", async () => {
    const closed = { open: false, collapsed: false, w: 400, h: 300, anchor: { h: "r", v: "b" }, dx: 7, dy: 9 };
    const wins = { view3d: closed };
    const layout = { swapped: true, wins, workAtSave: { w: 1, h: 1 } };
    mem.setItem("vuencedit_window_layouts", JSON.stringify({
      v: 1, last: layout, worlds: [{ path: "/a.eden", identity: "dims:1x1|min:0,0|fmt:x", layout, used: 1 }],
    }));
    await load({ settingsVersion: 21, workLayout: "quad" });
    const store = JSON.parse(mem.getItem("vuencedit_window_layouts")!);
    expect(store.last.swapped).toBe(true);
    expect(store.last.wins.view3d).toMatchObject({ open: true, w: 400, h: 300, dx: 7, dy: 9 });
    expect(store.worlds[0].layout.wins.view3d.open).toBe(true);
  });

  it("a windows user (v18–v22): dead keys stripped, no notice, layout untouched", async () => {
    const s = await load({ settingsVersion: 21, workLayout: "windows", quad3dEnabled: true, pendingLayoutNotice: true });
    expect(s).not.toHaveProperty("workLayout");
    expect(s).not.toHaveProperty("quad3dEnabled");
    expect(s).not.toHaveProperty("pendingLayoutNotice");
    expect(s.pendingQuadRetiredNotice).toBe(false);
    expect(lastLayout()).toBeNull();
  });

  it("a fresh install has none of the dead keys and no notice", async () => {
    const s = await load(null);
    expect(s).not.toHaveProperty("workLayout");
    expect(s).not.toHaveProperty("quad3dEnabled");
    expect(s).not.toHaveProperty("pendingLayoutNotice");
    expect(s.pendingQuadRetiredNotice).toBe(false);
  });

  it("is a no-op once already at v23 (a stored notice flag is left for App to consume)", async () => {
    const s = await load({ settingsVersion: 23, pendingQuadRetiredNotice: true });
    expect(s.pendingQuadRetiredNotice).toBe(true);
    expect(lastLayout()).toBeNull();
  });
});

/**
 * Stage 15.8: the 3D look prefs (sky gradient, fog colour/model, HUD + grid) were added without a
 * version bump — the `{...DEFAULTS, ...parsed}` merge supplies them, and must reproduce the look the
 * pane always had.
 */
describe("3D look prefs (Stage 15.8, additive)", () => {
  it("an existing install gets the original gradient, fog blue, hard fog, HUD and grid on", async () => {
    const s = await load({ settingsVersion: 23 });
    expect(s.sky3dZenith).toBe("#347ee3");
    expect(s.sky3dHorizon).toBe("#c5d5eb");
    expect(s.fog3dColor).toBe("#8cbeff");
    expect(s.fog3dSoft).toBe(false);
    expect(s.show3dHud).toBe(true);
    expect(s.show3dGrid).toBe(true);
  });

  it("a stored custom value survives the merge, including an explicit null fog colour", async () => {
    const s = await load({ settingsVersion: 23, sky3dZenith: "#112233", fog3dColor: null, show3dHud: false });
    expect(s.sky3dZenith).toBe("#112233");
    expect(s.fog3dColor).toBeNull();
    expect(s.show3dHud).toBe(false);
  });
});

/** Settings v24 (Stage 19.1): relief shading defaults off; installs that stored the old default are forced off once. */
describe("settings v24 migration (relief off by default)", () => {
  it("forces a stored reliefShading:true off when migrating from v23", async () => {
    const s = await load({ settingsVersion: 23, reliefShading: true });
    expect(s.reliefShading).toBe(false);
  });
  it("a fresh install starts with relief off", async () => {
    const s = await load(null);
    expect(s.reliefShading).toBe(false);
  });
  it("keeps an explicit opt-in made after v24", async () => {
    const s = await load({ settingsVersion: 24, reliefShading: true });
    expect(s.reliefShading).toBe(true);
  });
});
