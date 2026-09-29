/**
 * The settings v18 migration's hook into window storage (Stage 14.4): seed `last` — the layout a
 * world with no record of its own inherits — from the old quad-era toggles, so an upgraded install
 * opens its next world with the 3D window and Tools window the way it had the 3D pane and left tool
 * rail. Only if nothing is stored yet; never overwrites a layout the user has already arranged.
 *
 * Kept out of `useWindowLayout.ts` so `SettingsModal`'s `migrate()` doesn't import the store (and
 * React) just to write one blob. The work-area size is an estimate (no editor is mounted during
 * migration); only the 3D window's default width depends on it, and anchors keep it bottom-right.
 */
import { defaultWins, type DefaultOpts } from "./windowGeometry";
import { STORAGE_VERSION, readStore, writeStore, type WorldLayout } from "./windowStorage";

export function seedLastLayout(o: DefaultOpts): void {
  try {
    const work = {
      w: Math.max(600, (typeof window !== "undefined" ? window.innerWidth : 1440) - 260),
      h: Math.max(400, (typeof window !== "undefined" ? window.innerHeight : 900) - 190),
    };
    const wins = defaultWins(work, o);
    const store = readStore(wins);
    if (store.last) return;
    writeStore({ ...store, v: STORAGE_VERSION, last: { swapped: false, wins, workAtSave: work } });
  } catch { /* storage unavailable — the defaults path still works */ }
}

/**
 * The settings v23 migration's hook (Stage 16.4, Quad retired): a Quad user's 3D pane becomes the 3D
 * *window*, so make sure it's open. With no stored layout this is just `seedLastLayout`; with one
 * (a Quad user who also used the windows layout, or the v18 seed), the 3D window's `open` bit is
 * forced on in `last` and in every per-world record, since any of them may be what their next world
 * inherits. Geometry is untouched. Idempotent and failure-swallowing like `seedLastLayout`.
 */
export function openView3dEverywhere(o: DefaultOpts): void {
  try {
    const work = {
      w: Math.max(600, (typeof window !== "undefined" ? window.innerWidth : 1440) - 260),
      h: Math.max(400, (typeof window !== "undefined" ? window.innerHeight : 900) - 190),
    };
    const wins = defaultWins(work, { ...o, view3dOpen: true });
    const store = readStore(wins);
    const open = (l: WorldLayout): WorldLayout =>
      l.wins.view3d.open ? l : { ...l, wins: { ...l.wins, view3d: { ...l.wins.view3d, open: true } } };
    writeStore({
      ...store,
      v: STORAGE_VERSION,
      last: store.last ? open(store.last) : { swapped: false, wins, workAtSave: work },
      worlds: store.worlds.map(e => ({ ...e, layout: open(e.layout) })),
    });
  } catch { /* storage unavailable — the defaults path still works */ }
}
