import { describe, expect, it } from "vitest";
import { INITIAL_LENS_SCHEDULER_STATE, reduceLensScheduler, type LensSchedulerState } from "./lensScheduler";

function apply(state: LensSchedulerState, events: Array<{ type: "request" | "success" | "failure"; key: string }>) {
  const fired: string[] = [];
  let s = state;
  for (const e of events) {
    const r = reduceLensScheduler(s, e);
    s = r.state;
    if (r.fire != null) fired.push(r.fire);
  }
  return { state: s, fired };
}

describe("reduceLensScheduler", () => {
  it("fires the first request immediately when nothing is in flight", () => {
    const r = reduceLensScheduler(INITIAL_LENS_SCHEDULER_STATE, { type: "request", key: "a" });
    expect(r.fire).toBe("a");
    expect(r.state.inFlight).toBe("a");
  });

  it("a burst of requests while one is in flight collapses to at most one more fetch", () => {
    const { fired } = apply(INITIAL_LENS_SCHEDULER_STATE, [
      { type: "request", key: "a" },
      { type: "request", key: "b" },
      { type: "request", key: "c" },
      { type: "request", key: "d" },
      { type: "success", key: "a" },
    ]);
    // "a" fired immediately; the burst (b, c, d) coalesces into one more fetch of the latest ("d").
    expect(fired).toEqual(["a", "d"]);
  });

  it("re-requesting the same in-flight key does not fire again or touch pending", () => {
    const r1 = reduceLensScheduler(INITIAL_LENS_SCHEDULER_STATE, { type: "request", key: "a" });
    const r2 = reduceLensScheduler(r1.state, { type: "request", key: "a" });
    expect(r2.fire).toBeNull();
    expect(r2.state.pending).toBeNull();
  });

  it("failure parks the key: requesting it again while nothing is in flight does not fire", () => {
    const r1 = reduceLensScheduler(INITIAL_LENS_SCHEDULER_STATE, { type: "request", key: "a" });
    const r2 = reduceLensScheduler(r1.state, { type: "failure", key: "a" });
    expect(r2.state.failedKey).toBe("a");
    const r3 = reduceLensScheduler(r2.state, { type: "request", key: "a" });
    expect(r3.fire).toBeNull();
  });

  it("a new (different) key after a failure fires normally", () => {
    const r1 = reduceLensScheduler(INITIAL_LENS_SCHEDULER_STATE, { type: "request", key: "a" });
    const r2 = reduceLensScheduler(r1.state, { type: "failure", key: "a" });
    const r3 = reduceLensScheduler(r2.state, { type: "request", key: "b" });
    expect(r3.fire).toBe("b");
  });

  it("a pending key equal to the key that just failed is dropped, not retried immediately", () => {
    // Can't reach "pending === the key about to fail" through `request` events alone (requesting
    // the in-flight key again is a no-op, per the test above) — construct the state directly to
    // exercise the guard itself.
    const r = reduceLensScheduler({ inFlight: "x", pending: "x", failedKey: null }, { type: "failure", key: "x" });
    expect(r.fire).toBeNull();
    expect(r.state.pending).toBeNull();
    expect(r.state.failedKey).toBe("x");
  });

  it("success with no pending key returns to idle", () => {
    const r1 = reduceLensScheduler(INITIAL_LENS_SCHEDULER_STATE, { type: "request", key: "a" });
    const r2 = reduceLensScheduler(r1.state, { type: "success", key: "a" });
    expect(r2.state).toEqual(INITIAL_LENS_SCHEDULER_STATE);
    expect(r2.fire).toBeNull();
  });

  it("a failed key does not block a distinct pending key already queued behind it", () => {
    const s0 = { inFlight: "a", pending: "b", failedKey: null } as LensSchedulerState;
    const r = reduceLensScheduler(s0, { type: "failure", key: "a" });
    expect(r.fire).toBe("b");
    expect(r.state.inFlight).toBe("b");
  });
});
