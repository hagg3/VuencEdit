/**
 * ⌘K reveal of a command inside a collapsed (`popup`) group or the compact ribbon's overflow
 * popover (Stage 15.4). Node-only — `runReveal` takes its DOM lookups as arguments.
 */
import { describe, expect, it } from "vitest";
import { panelToReveal, runReveal, type RevealOpener } from "./reveal";

/** A fake frame queue: `flush()` runs queued callbacks until none are left. */
function frames() {
  const q: (() => void)[] = [];
  return {
    nextFrame: (cb: () => void) => { q.push(cb); },
    flush() { let n = 0; while (q.length && n++ < 100) q.shift()!(); return n; },
  };
}

/** A popup opener whose click renders `id` into `rendered` (like a group popover mounting). */
function popup(rendered: Set<string>, ids: string[], expanded = false) {
  const o: RevealOpener & { clicks: number } = {
    expanded, clicks: 0,
    click() {
      o.clicks++;
      o.expanded = !o.expanded;
      for (const id of ids) {
        if (o.expanded) rendered.add(id);
        else rendered.delete(id);
      }
    },
  };
  return o;
}

describe("runReveal", () => {
  it("finds a control that is already on screen without clicking anything", () => {
    const f = frames();
    const opener = popup(new Set(), []);
    const found: string[] = [];
    runReveal({ find: () => "el", openers: () => [opener], nextFrame: f.nextFrame, onFound: el => found.push(el) });
    f.flush();
    expect(found).toEqual(["el"]);
    expect(opener.clicks).toBe(0);
  });

  it("opens the popup group holding the command, then flashes the control inside it", () => {
    const f = frames();
    const rendered = new Set<string>();
    const group = popup(rendered, ["cmd"]);
    const found: string[] = [];
    runReveal({
      find: () => (rendered.has("cmd") ? "cmd" : null),
      openers: () => [group], nextFrame: f.nextFrame, onFound: el => found.push(el),
    });
    f.flush();
    expect(group.clicks).toBe(1);
    expect(found).toEqual(["cmd"]);
  });

  it("never clicks an opener whose popover is already open (that would close it)", () => {
    const f = frames();
    const group = popup(new Set(), [], true);
    let found = false;
    runReveal({ find: () => null, openers: () => [group], nextFrame: f.nextFrame, onFound: () => { found = true; } });
    f.flush();
    expect(group.clicks).toBe(0);
    expect(found).toBe(false);
  });

  it("falls through to the next opener (compact-ribbon overflow) when the first doesn't exist", () => {
    const f = frames();
    const rendered = new Set<string>();
    const overflow = popup(rendered, ["cmd"]);
    const found: string[] = [];
    runReveal({
      find: () => (rendered.has("cmd") ? "cmd" : null),
      openers: () => [null, overflow], nextFrame: f.nextFrame, onFound: el => found.push(el),
    });
    f.flush();
    expect(overflow.clicks).toBe(1);
    expect(found).toEqual(["cmd"]);
  });

  it("tries each opener once, then gives up after maxTries frames", () => {
    const f = frames();
    const a = popup(new Set(), []);
    const b = popup(new Set(), []);
    let found = false;
    runReveal({ find: () => null, openers: () => [a, b], nextFrame: f.nextFrame, onFound: () => { found = true; }, maxTries: 6 });
    expect(f.flush()).toBe(6);
    expect([a.clicks, b.clicks]).toEqual([1, 1]);
    expect(found).toBe(false);
  });

  it("waits for a tab that is still mounting (opener appears on a later frame)", () => {
    const f = frames();
    const rendered = new Set<string>();
    const group = popup(rendered, ["cmd"]);
    let frame = 0;
    const found: string[] = [];
    runReveal({
      find: () => (rendered.has("cmd") ? "cmd" : null),
      openers: () => [++frame < 3 ? null : group], nextFrame: f.nextFrame, onFound: el => found.push(el),
    });
    f.flush();
    expect(group.clicks).toBe(1);
    expect(found).toEqual(["cmd"]);
  });
});

describe("panelToReveal (Stage 16.6 — controls that live in a context panel)", () => {
  const places = [{ tab: "sculpt", group: "brush" }, { panel: "buildslot" }] as const;
  it("flashes the panel when it is on screen and the active tab has no control of its own", () => {
    expect(panelToReveal(places, "view", ["buildslot"])).toBe("buildslot");
    expect(panelToReveal(places, "3d", ["cutaway", "buildslot"])).toBe("buildslot");
  });
  it("the active tab's own control wins", () => {
    expect(panelToReveal(places, "sculpt", ["buildslot"])).toBeNull();
  });
  it("falls back to the tab path when the panel isn't showing", () => {
    expect(panelToReveal(places, "view", [])).toBeNull();
    expect(panelToReveal(places, "view", ["cutaway"])).toBeNull();
  });
  it("a command with no panel placement never reveals into one", () => {
    expect(panelToReveal([{ tab: "home", group: "clipboard" }], "view", ["buildslot"])).toBeNull();
  });
});
