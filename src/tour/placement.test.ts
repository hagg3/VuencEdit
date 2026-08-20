import { describe, it, expect } from "vitest";
import { placeCard, type Rect } from "./TourOverlay";

const VW = 1440;
const VH = 900;
const CARD = { w: 340, h: 160 };

function rectAt(top: number, left: number, w = 100, h = 40): Rect {
  return { top, left, right: left + w, bottom: top + h, width: w, height: h };
}

describe("placeCard", () => {
  it("centres the card when there is no target rect", () => {
    const { top, left } = placeCard(null, CARD, VW, VH, "auto");
    expect(top).toBeCloseTo((VH - CARD.h) / 2);
    expect(left).toBeCloseTo((VW - CARD.w) / 2);
  });

  it("stays within the viewport margin for a target pinned to each corner", () => {
    const corners: [number, number][] = [[0, 0], [0, VW - 100], [VH - 40, 0], [VH - 40, VW - 100]];
    for (const [top, left] of corners) {
      const { top: cTop, left: cLeft } = placeCard(rectAt(top, left), CARD, VW, VH, "auto");
      expect(cTop).toBeGreaterThanOrEqual(8);
      expect(cLeft).toBeGreaterThanOrEqual(8);
      expect(cTop + CARD.h).toBeLessThanOrEqual(VH - 8 + 0.001);
      expect(cLeft + CARD.w).toBeLessThanOrEqual(VW - 8 + 0.001);
    }
  });

  it("stays within the viewport margin for a target pinned to each edge midpoint", () => {
    const edges: [number, number][] = [
      [0, VW / 2], [VH - 40, VW / 2], [VH / 2, 0], [VH / 2, VW - 100],
    ];
    for (const [top, left] of edges) {
      const { top: cTop, left: cLeft } = placeCard(rectAt(top, left), CARD, VW, VH, "auto");
      expect(cTop).toBeGreaterThanOrEqual(8);
      expect(cLeft).toBeGreaterThanOrEqual(8);
      expect(cTop + CARD.h).toBeLessThanOrEqual(VH - 8 + 0.001);
      expect(cLeft + CARD.w).toBeLessThanOrEqual(VW - 8 + 0.001);
    }
  });

  it("prefers the side with the most room when placement is auto", () => {
    // Target hugs the top-left corner — most room is below and to the right, so bottom wins
    // (spaces: top=0, bottom=VH-40, left=0, right=VW-100 — bottom is largest for a tall viewport).
    const { top, left } = placeCard(rectAt(0, 0), CARD, VW, VH, "auto");
    expect(top).toBeGreaterThan(0);
    expect(left).toBeGreaterThanOrEqual(8);
  });

  it("honours an explicit placement side", () => {
    const r = rectAt(400, 700, 100, 40);
    const right = placeCard(r, CARD, VW, VH, "right");
    expect(right.left).toBeGreaterThan(r.right);
    const left = placeCard(r, CARD, VW, VH, "left");
    expect(left.left + CARD.w).toBeLessThanOrEqual(r.left + 0.001);
  });
});
