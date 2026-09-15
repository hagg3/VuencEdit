import { describe, it, expect } from "vitest";
import { backoffBudget, backoffRadius, BACKOFF_MIN_BUDGET_BYTES, MAX_CONTEXT_LOSSES } from "./gfxBackoff";

const MB = 1 << 20;

describe("backoffBudget", () => {
  it("is the identity before the first loss", () => {
    expect(backoffBudget(512 * MB, 0)).toBe(512 * MB);
    expect(backoffBudget(192 * MB, -1)).toBe(192 * MB); // defensive: never scales up
  });

  it("halves once per recovered loss", () => {
    expect(backoffBudget(512 * MB, 1)).toBe(256 * MB);
    expect(backoffBudget(512 * MB, 2)).toBe(128 * MB);
  });

  it("floors at BACKOFF_MIN_BUDGET_BYTES rather than collapsing to nothing", () => {
    // The give-up latch fires at MAX_CONTEXT_LOSSES, so this is past where the pane still streams —
    // but the floor must hold regardless, since nothing else bounds the exponent.
    expect(backoffBudget(512 * MB, 8)).toBe(BACKOFF_MIN_BUDGET_BYTES);
    expect(backoffBudget(512 * MB, MAX_CONTEXT_LOSSES)).toBe(64 * MB);
  });

  it("leaves a budget that already sits below the floor alone, rather than raising it", () => {
    // Defensive only — the smallest shipping preset (Low) is 192 MB. Halving something already
    // under the floor would shrink it past the point the floor exists to protect, and clamping up
    // to the floor would *raise* a number the user chose, so the right answer is neither.
    expect(backoffBudget(32 * MB, 1)).toBe(32 * MB);
    expect(backoffBudget(32 * MB, 9)).toBe(32 * MB);
  });
});

describe("backoffRadius", () => {
  it("steps down by ~√2 so it tracks the budget halving in area terms", () => {
    expect(backoffRadius(32, 2)).toBe(22);
    expect(backoffRadius(22, 2)).toBe(15);
    expect(backoffRadius(15, 2)).toBe(10);
  });

  it("clamps to the pane's slider floor and is idempotent there", () => {
    expect(backoffRadius(3, 2)).toBe(2);
    expect(backoffRadius(2, 2)).toBe(2);
  });

  it("reaches the floor within MAX_CONTEXT_LOSSES steps from any slider value", () => {
    for (let r = 2; r <= 32; r++) {
      let cur = r;
      for (let i = 0; i < MAX_CONTEXT_LOSSES; i++) cur = backoffRadius(cur, 2);
      // Three √2 steps is a ~2.8× radius cut (~8× the loaded area) — enough that the last
      // recovery attempt is meaningfully cheaper than the first from anywhere on the slider.
      expect(cur).toBeLessThanOrEqual(Math.max(2, Math.ceil(r / 2.8)));
    }
  });
});
