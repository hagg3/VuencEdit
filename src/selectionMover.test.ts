import { describe, it, expect } from "vitest";
import { createSelectionMover, type MoveState } from "./selectionMover";

describe("createSelectionMover", () => {
  it("applies queued nudges against the already-moved box", async () => {
    let state: MoveState | null = { bounds: { x1: 10, y1: 0, x2: 19, y2: 0 }, zMin: 0, zMax: 5 };
    const seen: number[] = [];
    const resolvers: (() => void)[] = [];
    const run = createSelectionMover({
      read: () => state,
      move: (s) => new Promise<void>((r) => { seen.push(s.bounds.x1); resolvers.push(r); }),
      commit: (n) => { state = n; },
      onError: (e) => { throw e; },
    });
    const first = run({ dx: 1, dy: 0, dz: 0 });
    void run({ dx: 1, dy: 0, dz: 0 });
    void run({ dx: 1, dy: 0, dz: 0 });
    resolvers[0]();
    await new Promise((r) => setTimeout(r, 0));
    resolvers[1]();
    await first;
    expect(seen).toEqual([10, 11]); // second batch (dx=2) starts from the moved box
    expect(state!.bounds).toEqual({ x1: 13, y1: 0, x2: 22, y2: 0 });
  });

  it("shifts z with dz and recovers after an error", async () => {
    let state: MoveState | null = { bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, zMin: 2, zMax: 4 };
    const errs: unknown[] = [];
    let fail = true;
    const run = createSelectionMover({
      read: () => state,
      move: async () => { if (fail) { fail = false; throw new Error("x"); } },
      commit: (n) => { state = n; },
      onError: (e) => errs.push(e),
    });
    await run({ dx: 0, dy: 0, dz: 1 });
    expect(errs).toHaveLength(1);
    expect(state!.zMin).toBe(2);
    await run({ dx: 0, dy: 0, dz: 1 });
    expect(state!.zMin).toBe(3);
    expect(state!.zMax).toBe(5);
  });
});
