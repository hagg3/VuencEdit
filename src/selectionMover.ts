// Serialised "move selection contents" queue shared by the arrow-key nudge and the 3D gizmo.
//
// Held arrow keys fire faster than a move round-trip, so extra requests while one is in flight
// are coalesced into one pending delta and applied against the *current* selection once the
// in-flight move finishes. The bounds must be committed synchronously (`commit` writes the
// refs) before the loop reads them again: a React effect only refreshes them after commit,
// which does not happen inside an async continuation, so the next batch would move the old box.

export interface MoveBounds { x1: number; y1: number; x2: number; y2: number }
export interface MoveState { bounds: MoveBounds; zMin: number; zMax: number }
export interface MoveDelta { dx: number; dy: number; dz: number }

export function createSelectionMover(opts: {
  /** Live selection, or null when there is none. */
  read: () => MoveState | null;
  /** Run the backend move for `state` shifted by `d`. Throws on failure. */
  move: (state: MoveState, d: MoveDelta) => Promise<void>;
  /** Record the post-move selection. Must update the refs synchronously. */
  commit: (next: MoveState) => void;
  onError: (e: unknown) => void;
}): (d: MoveDelta) => Promise<void> {
  let busy = false;
  let pending: MoveDelta | null = null;
  return async (d0) => {
    if (busy) {
      pending = {
        dx: (pending?.dx ?? 0) + d0.dx,
        dy: (pending?.dy ?? 0) + d0.dy,
        dz: (pending?.dz ?? 0) + d0.dz,
      };
      return;
    }
    busy = true;
    try {
      let d = d0;
      for (;;) {
        const cur = opts.read();
        if (!cur) break;
        try {
          await opts.move(cur, d);
          const b = cur.bounds;
          opts.commit({
            bounds: { x1: b.x1 + d.dx, y1: b.y1 + d.dy, x2: b.x2 + d.dx, y2: b.y2 + d.dy },
            zMin: cur.zMin + d.dz,
            zMax: cur.zMax + d.dz,
          });
        } catch (e) {
          opts.onError(e);
        }
        if (!pending) break;
        d = pending;
        pending = null;
      }
    } finally {
      busy = false;
      pending = null;
    }
  };
}
