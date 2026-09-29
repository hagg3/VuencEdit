import { describe, it, expect } from "vitest";
import {
  HOTBAR_MAX_SLOT, HOTBAR_MIN_SLOT, MIN_SIZE, RESIZE_DIRS, SNAP, TITLE_H, WM, defaultWins,
  effectiveHeight, hotbarGrid, moveBy, rectOf,
  resizeRect, setCollapsed, snapMove, stateFromRect, toggleEnlarged, toolsGridCols,
  type Rect, type Size, type WinState,
} from "./windowGeometry";

const WORK: Size = { w: 1200, h: 700 };
const MIN = MIN_SIZE.view3d;

function win(over: Partial<WinState> = {}): WinState {
  return { open: true, collapsed: false, w: 400, h: 256, anchor: { h: "l", v: "t" }, dx: 100, dy: 100, ...over };
}

/** Seeded PRNG (mulberry32) — the property tests must be reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inside(r: Rect, work: Size, collapsed = false) {
  const eh = collapsed ? TITLE_H : r.h;
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= work.w && r.y + eh <= work.h;
}

describe("snapMove", () => {
  it("snaps to each edge and the centre line within SNAP px", () => {
    expect(snapMove(WM + SNAP, 300, 200, 100, WORK).x).toBe(WM);
    expect(snapMove(WORK.w - WM - 200 - SNAP, 300, 200, 100, WORK).x).toBe(WORK.w - WM - 200);
    expect(snapMove((WORK.w - 200) / 2 + 5, 300, 200, 100, WORK).x).toBe(500);
    expect(snapMove(300, WM + 3, 200, 100, WORK).y).toBe(WM);
    expect(snapMove(300, WORK.h - WM - 100 + 4, 200, 100, WORK).y).toBe(WORK.h - WM - 100);
  });
  it("leaves a position alone outside SNAP px, and when snapping is off", () => {
    expect(snapMove(WM + SNAP + 1, 300, 200, 100, WORK).x).toBe(WM + SNAP + 1);
    expect(snapMove(WM + 3, 300, 200, 100, WORK, false).x).toBe(WM + 3);
  });
  it("clamps fully inside in all four directions", () => {
    expect(snapMove(-500, 300, 200, 100, WORK)).toEqual({ x: 0, y: 300 });
    expect(snapMove(5000, 300, 200, 100, WORK).x).toBe(WORK.w - 200);
    expect(snapMove(300, -50, 200, 100, WORK).y).toBe(0);
    expect(snapMove(300, 5000, 200, 100, WORK).y).toBe(WORK.h - 100);
  });
  it("uses the effective (collapsed) height for the bottom clamp", () => {
    expect(snapMove(300, 5000, 200, TITLE_H, WORK).y).toBe(WORK.h - TITLE_H);
  });
});

describe("resizeRect", () => {
  const start: Rect = { x: 300, y: 200, w: 400, h: 300 };
  it("grows e/s from the fixed origin and keeps the opposite edge for w/n", () => {
    expect(resizeRect(start, "se", 50, 40, WORK, MIN)).toEqual({ x: 300, y: 200, w: 450, h: 340 });
    const nw = resizeRect(start, "nw", -50, -40, WORK, MIN);
    expect(nw.x + nw.w).toBe(700);
    expect(nw.y + nw.h).toBe(500);
    expect(nw).toEqual({ x: 250, y: 160, w: 450, h: 340 });
  });
  it("handles all 8 directions and never goes below the minimum", () => {
    for (const d of RESIZE_DIRS) {
      const r = resizeRect(start, d, d.includes("w") ? 1000 : -1000, d.includes("n") ? 1000 : -1000, WORK, MIN);
      if (d.includes("e") || d.includes("w")) expect(r.w).toBe(MIN.w);
      if (d.includes("n") || d.includes("s")) expect(r.h).toBe(MIN.h);
      expect(inside(r, WORK)).toBe(true);
    }
  });
  it("never grows past the work area and snaps each moving edge to its margin", () => {
    const big = resizeRect(start, "se", 5000, 5000, WORK, MIN);
    expect(big.x + big.w).toBe(WORK.w);
    expect(big.y + big.h).toBe(WORK.h);
    const snapped = resizeRect(start, "e", WORK.w - WM - 700 - 5, 0, WORK, MIN);
    expect(snapped.x + snapped.w).toBe(WORK.w - WM);
    const snappedW = resizeRect(start, "w", -(300 - WM) + 6, 0, WORK, MIN);
    expect(snappedW.x).toBe(WM);
  });
});

describe("anchors", () => {
  it("round-trips: drop → anchor → reflow at a new size keeps the edge distance", () => {
    const s0 = win();
    const dropped: Rect = { x: WORK.w - WM - 400, y: WORK.h - WM - 256, w: 400, h: 256 };
    const s = stateFromRect(s0, dropped, WORK);
    expect(s.anchor).toEqual({ h: "r", v: "b" });
    const small: Size = { w: 900, h: 500 };
    const r = rectOf(s, small, MIN);
    expect(small.w - (r.x + r.w)).toBe(WM);
    expect(small.h - (r.y + r.h)).toBe(WM);
  });
  it("uses the half of the work area when not snapped, and c only from the centre snap", () => {
    expect(stateFromRect(win(), { x: 100, y: 100, w: 200, h: 200 }, WORK).anchor).toEqual({ h: "l", v: "t" });
    expect(stateFromRect(win(), { x: 800, y: 400, w: 200, h: 200 }, WORK).anchor).toEqual({ h: "r", v: "b" });
    const c = stateFromRect(win(), { x: 450, y: 100, w: 300, h: 200 }, WORK);
    expect(c.anchor.h).toBe("c");
    expect(rectOf(c, { w: 800, h: 700 }, MIN).x).toBe(250);
  });
  it("is idempotent: reflowing a reflowed state changes nothing", () => {
    const next = rng(7);
    for (let i = 0; i < 200; i++) {
      const s = win({ w: 240 + next() * 600, h: 150 + next() * 400, dx: next() * 400, dy: next() * 300,
        anchor: { h: (["l", "c", "r"] as const)[Math.floor(next() * 3)], v: next() < 0.5 ? "t" : "b" } });
      const A: Size = { w: 600 + Math.floor(next() * 1400), h: 400 + Math.floor(next() * 800) };
      const once = stateFromRect(s, rectOf(s, A, MIN), A);
      const twice = stateFromRect(once, rectOf(once, A, MIN), A);
      expect(rectOf(twice, A, MIN)).toEqual(rectOf(once, A, MIN));
    }
  });
  it("never produces a rect outside the work area (property, 500 iterations)", () => {
    const next = rng(42);
    for (let i = 0; i < 500; i++) {
      const collapsed = next() < 0.2;
      const s = win({
        collapsed, w: 50 + next() * 2000, h: 50 + next() * 1500, dx: -500 + next() * 3000, dy: -500 + next() * 2000,
        anchor: { h: (["l", "c", "r"] as const)[Math.floor(next() * 3)], v: next() < 0.5 ? "t" : "b" },
      });
      const A: Size = { w: 300 + Math.floor(next() * 2500), h: 200 + Math.floor(next() * 1400) };
      expect(inside(rectOf(s, A, MIN), A, collapsed)).toBe(true);
    }
  });
});

describe("shrink to fit", () => {
  it("shrinks a window when the work area shrinks below it, and gives the size back later", () => {
    const s = win({ w: 1000, h: 600 });
    const small = rectOf(s, { w: 700, h: 400 }, MIN);
    expect(small.w).toBe(700 - 2 * WM);
    expect(small.h).toBe(400 - 2 * WM);
    expect(rectOf(s, WORK, MIN).w).toBe(1000);
  });
  it("pins at (0,0) at its minimum when the work area is smaller than the minimum", () => {
    const r = rectOf(win(), { w: 100, h: 80 }, MIN);
    expect(r).toEqual({ x: 0, y: 0, w: MIN.w, h: MIN.h });
  });
});

describe("collapse", () => {
  it("collapsing keeps the title bar in place; the collapsed height is TITLE_H", () => {
    const s = win({ anchor: { h: "l", v: "t" }, dy: 300 });
    const c = setCollapsed(s, true, WORK, MIN);
    expect(effectiveHeight(c)).toBe(TITLE_H);
    expect(rectOf(c, WORK, MIN).y).toBe(rectOf(s, WORK, MIN).y);
  });
  it("expanding a window collapsed near the bottom pushes it up so its body fits", () => {
    const s = win({ collapsed: true, h: 300, anchor: { h: "l", v: "t" }, dy: WORK.h - TITLE_H - 2 });
    const e = setCollapsed(s, false, WORK, MIN);
    const r = rectOf(e, WORK, MIN);
    expect(r.y + r.h).toBeLessThanOrEqual(WORK.h);
    expect(r.h).toBe(300);
  });
});

describe("enlarge / restore", () => {
  it("toggles to 55 % of the work-area width, bottom-right, and back", () => {
    const s = win();
    const big = toggleEnlarged(s, WORK);
    const r = rectOf(big, WORK, MIN);
    expect(r.w).toBe(Math.round(WORK.w * 0.55));
    expect(WORK.w - (r.x + r.w)).toBe(WM);
    const back = toggleEnlarged(big, WORK);
    expect(rectOf(back, WORK, MIN)).toEqual(rectOf(s, WORK, MIN));
    expect(back.restore ?? null).toBeNull();
  });
});

describe("moveBy (keyboard nudge)", () => {
  it("moves and clamps, re-deriving the anchor", () => {
    const s = win({ dx: 100, dy: 100 });
    expect(rectOf(moveBy(s, 32, 0, WORK, MIN, false), WORK, MIN).x).toBe(132);
    expect(rectOf(moveBy(s, -5000, 0, WORK, MIN, false), WORK, MIN).x).toBe(0);
  });
});

describe("defaultWins", () => {
  it("puts Tools top-left and the 3D window bottom-right at 34 % width", () => {
    const d = defaultWins(WORK, { view3dOpen: true, toolsOpen: true, toolsCollapsed: false });
    const t = rectOf(d.tools, WORK, MIN_SIZE.tools);
    expect([t.x, t.y]).toEqual([WM, WM]);
    const v = rectOf(d.view3d, WORK, MIN_SIZE.view3d);
    expect(v.w).toBe(Math.round(WORK.w * 0.34));
    expect(WORK.w - (v.x + v.w)).toBe(WM);
    expect(WORK.h - (v.y + v.h)).toBe(WM);
    expect(d.hotbar.open).toBe(true);
    expect(d.lens.open).toBe(true); // session-only "enabled" flag, on by default (16.1)
  });
});

describe("toolsGridCols", () => {
  it("is 2×3 at the default size, 6×1 when wide, a column when tall and thin", () => {
    expect(toolsGridCols(64, 90)).toBe(2);
    expect(toolsGridCols(200, 36)).toBe(6);
    expect(toolsGridCols(40, 200)).toBe(1);
    expect(toolsGridCols(100, 64)).toBe(3);
  });
  it("picks the least-overflowing layout when nothing fits", () => {
    expect(toolsGridCols(10, 10)).toBe(2);
  });
});

describe("hotbarGrid", () => {
  it("is one row when wide, clamped to the max slot size", () => {
    expect(hotbarGrid(1000, 100)).toEqual({ cols: 11, size: HOTBAR_MAX_SLOT });
  });
  it("wraps to two rows when roughly square", () => {
    expect(hotbarGrid(300, 150)).toEqual({ cols: 6, size: 45 });
  });
  it("is a single column when tall and thin", () => {
    expect(hotbarGrid(80, 600)).toEqual({ cols: 1, size: 50 });
  });
  it("clamps to the minimum slot size when the body is tiny", () => {
    const g = hotbarGrid(20, 20);
    expect(g.size).toBe(HOTBAR_MIN_SLOT);
  });
  it("clamps to the maximum slot size when the body is huge", () => {
    const g = hotbarGrid(5000, 5000);
    expect(g.size).toBe(HOTBAR_MAX_SLOT);
  });
});

// ── Stage 16.2: per-window limits ─────────────────────────────────────────────────────────────

import { TOOL_CELL, TOOL_GAP, TOOL_PAD, TOOL_COUNT, HOTBAR_GAP, HOTBAR_PAD, HOTBAR_SLOTS, hotbarDims, toolsDims, winLimits, WIN_IDS, type WinId } from "./windowGeometry";

/** Does `toolsGridCols` pick a column count whose grid fits a (w × h) *window*'s body? */
function toolsFits(w: number, h: number): boolean {
  const bw = w, bh = h - TITLE_H;
  const c = toolsGridCols(bw, bh);
  const d = toolsDims(c);
  return d.w <= bw && d.h <= bh;
}
function hotbarFits(w: number, h: number): boolean {
  const bw = w, bh = h - TITLE_H;
  const { cols, size } = hotbarGrid(bw, bh);
  const d = hotbarDims(cols, size);
  return d.w <= bw && d.h <= bh;
}

describe("winLimits", () => {
  const WORKS: Size[] = [{ w: 1200, h: 700 }, { w: 900, h: 500 }, { w: 2200, h: 1300 }];

  it("min ≤ max on every window in every work area, and MIN_SIZE is the min half", () => {
    for (const work of WORKS) {
      for (const id of WIN_IDS) {
        const { min, max } = winLimits(id, work);
        expect(min.w, id).toBeLessThanOrEqual(max.w);
        expect(min.h, id).toBeLessThanOrEqual(max.h);
        expect(MIN_SIZE[id]).toEqual(min);
      }
    }
  });

  it("Tools: min is the tightest reflow (a 6×1 row's height, a 1×6 column's width); max is the widest/tallest natural reflow", () => {
    const { min, max } = winLimits("tools", WORK);
    expect(min).toEqual({ w: 64, h: TITLE_H + TOOL_CELL + 2 * TOOL_PAD });
    expect(max.w).toBe(TOOL_COUNT * TOOL_CELL + (TOOL_COUNT - 1) * TOOL_GAP + 2 * TOOL_PAD);
    expect(max.h).toBe(TITLE_H + TOOL_COUNT * TOOL_CELL + (TOOL_COUNT - 1) * TOOL_GAP + 2 * TOOL_PAD);
  });

  it("Hotbar: min fits the smallest slots (24 px), max is the natural size at the 72 px slot cap", () => {
    const { min, max } = winLimits("hotbar", WORK);
    expect(min.h).toBe(TITLE_H + HOTBAR_MIN_SLOT + 2 * HOTBAR_PAD);
    expect(max.w).toBe(HOTBAR_SLOTS * HOTBAR_MAX_SLOT + (HOTBAR_SLOTS - 1) * HOTBAR_GAP + 2 * HOTBAR_PAD);
  });

  it("3D view and lens may grow to the work area", () => {
    for (const work of WORKS) {
      expect(winLimits("view3d", work).max).toEqual(work);
      expect(winLimits("lens", work).max).toEqual(work);
    }
  });

  it("rectOf clamps an oversized or undersized stored size into [min, max]", () => {
    for (const id of ["tools", "hotbar"] as WinId[]) {
      const lim = winLimits(id, WORK);
      const big = rectOf(win({ w: 5000, h: 5000 }), WORK, lim);
      expect(big.w).toBeLessThanOrEqual(lim.max.w);
      expect(big.h).toBeLessThanOrEqual(lim.max.h);
      const tiny = rectOf(win({ w: 1, h: 1 }), WORK, lim);
      expect(tiny.w).toBeGreaterThanOrEqual(lim.min.w);
      expect(tiny.h).toBeGreaterThanOrEqual(lim.min.h);
    }
  });

  it("rectOf grows a stored Tools/Hotbar size that clips every reflow until one fits", () => {
    // 64 × 56 is inside [min, max] on each axis but too small for any reflow — a pre-16.2 minimum.
    const t = rectOf(win({ w: 64, h: 56 }), WORK, winLimits("tools", WORK));
    expect(toolsFits(t.w, t.h)).toBe(true);
    const h = rectOf(win({ w: 70, h: 64 }), WORK, winLimits("hotbar", WORK));
    expect(hotbarFits(h.w, h.h)).toBe(true);
  });
});

describe("resize property tests (16.2)", () => {
  const WORK2: Size = { w: 1200, h: 700 };

  it.each(WIN_IDS as WinId[])("%s: any resize sequence stays inside [min, max] and the work area", id => {
    const rand = rng(1234 + id.length);
    const lim = winLimits(id, WORK2);
    for (let trial = 0; trial < 60; trial++) {
      let r = rectOf(win({
        w: lim.min.w + rand() * 400, h: lim.min.h + rand() * 300,
        anchor: { h: "l", v: "t" }, dx: rand() * 600, dy: rand() * 300,
      }), WORK2, lim);
      for (let step = 0; step < 25; step++) {
        const dir = RESIZE_DIRS[Math.floor(rand() * RESIZE_DIRS.length)];
        r = resizeRect(r, dir, (rand() - 0.5) * 900, (rand() - 0.5) * 700, WORK2, lim, rand() < 0.5);
        expect(r.w, `${id} ${dir} w`).toBeGreaterThanOrEqual(lim.min.w);
        expect(r.h, `${id} ${dir} h`).toBeGreaterThanOrEqual(lim.min.h);
        expect(r.w, `${id} ${dir} w`).toBeLessThanOrEqual(lim.max.w);
        expect(r.h, `${id} ${dir} h`).toBeLessThanOrEqual(lim.max.h);
        expect(inside(r, WORK2), `${id} ${dir} ${JSON.stringify(r)}`).toBe(true);
      }
    }
  });

  it("Tools and Hotbar never end a resize clipped (some reflow always fits)", () => {
    const rand = rng(99);
    for (const [id, fits] of [["tools", toolsFits], ["hotbar", hotbarFits]] as const) {
      const lim = winLimits(id, WORK2);
      let r = rectOf(win({ w: lim.max.w, h: lim.max.h, dx: 100, dy: 100 }), WORK2, lim);
      for (let step = 0; step < 400; step++) {
        const dir = RESIZE_DIRS[Math.floor(rand() * RESIZE_DIRS.length)];
        r = resizeRect(r, dir, (rand() - 0.5) * 500, (rand() - 0.5) * 400, WORK2, lim, false);
        expect(fits(r.w, r.h), `${id} ${dir} → ${r.w}×${r.h}`).toBe(true);
      }
    }
  });

  it("a Tools drag toward a too-small size grows to the nearest reflow instead of clipping", () => {
    const lim = winLimits("tools", WORK2);
    const start: Rect = { x: 300, y: 200, w: 90, h: 84 }; // a 3×2 reflow
    const r = resizeRect(start, "se", -26, -30, WORK2, lim, false); // shrink → 64 × 54, clips everything
    expect(toolsFits(r.w, r.h)).toBe(true);
    expect(r.x).toBe(300);
    expect(r.y).toBe(200); // grew on the dragged edge, the fixed origin didn't move
  });
});
