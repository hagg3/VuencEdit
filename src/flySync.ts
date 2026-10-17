// Pure helpers for the 3D pane's edit-sync and z-band streaming decisions (Stage 23.1 / 23.2).
// Kept out of FlyView3D.tsx so the rules are unit-testable without a WebGL scene.
import { worldToChunk, CHUNK_SIZE_BLOCKS } from "./viewportUtils";

export interface EditRect { x: number; y: number; w: number; h: number }
export type ChunkXY = [number, number];

/**
 * Chunks an edit rect must reload.
 *  - `core`: every chunk the rect overlaps (reload immediately).
 *  - `halo`: extra chunks, reloaded on the trailing debounce. With `reachBlocks === 0` (no lamp light /
 *    shadows) this is only the *face-culling* neighbours: the edge-adjacent chunk on a side where the
 *    rect actually touches that chunk edge (no diagonals, nothing for an interior edit). With
 *    lighting/shadow reach it is the full square ring `ceil(reach/16)` chunks wide, since light and
 *    shadow travel diagonally too.
 */
export function editReloadPlan(r: EditRect, reachBlocks: number): { core: ChunkXY[]; halo: ChunkXY[] } {
  const x1 = r.x + Math.max(0, r.w - 1), y1 = r.y + Math.max(0, r.h - 1);
  const cx0 = worldToChunk(r.x), cy0 = worldToChunk(r.y);
  const cx1 = worldToChunk(x1), cy1 = worldToChunk(y1);
  const core: ChunkXY[] = [], halo: ChunkXY[] = [];
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) core.push([cx, cy]);
  if (reachBlocks > 0) {
    const pad = Math.max(1, Math.ceil(reachBlocks / CHUNK_SIZE_BLOCKS));
    for (let cy = cy0 - pad; cy <= cy1 + pad; cy++)
      for (let cx = cx0 - pad; cx <= cx1 + pad; cx++) {
        if (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1) continue;
        halo.push([cx, cy]);
      }
    return { core, halo };
  }
  const last = CHUNK_SIZE_BLOCKS - 1;
  const mod = (v: number) => ((v % CHUNK_SIZE_BLOCKS) + CHUNK_SIZE_BLOCKS) % CHUNK_SIZE_BLOCKS;
  if (mod(r.x) === 0) for (let cy = cy0; cy <= cy1; cy++) halo.push([cx0 - 1, cy]);
  if (mod(x1) === last) for (let cy = cy0; cy <= cy1; cy++) halo.push([cx1 + 1, cy]);
  if (mod(r.y) === 0) for (let cx = cx0; cx <= cx1; cx++) halo.push([cx, cy0 - 1]);
  if (mod(y1) === last) for (let cx = cx0; cx <= cx1; cx++) halo.push([cx, cy1 + 1]);
  return { core, halo };
}

/** Whether an edit-sync reload should be issued for a chunk: only one that holds (or is fetching)
 *  geometry. A non-resident chunk is fetched fresh by the sweep when it comes into range, so a forced
 *  fetch would only load chunks nobody asked for (out of range, or evicted by the budget). */
export function shouldReloadChunk(resident: boolean, inflight: boolean): boolean {
  return resident || inflight;
}

/** Ceiling of a z band as a number: `null` (no clip) is the tallest. */
export function bandRank(b: number | null): number {
  return b === null ? Infinity : b;
}

/** A mesh built under `built` covers everything a fetch under `wanted` would show iff it scanned at
 *  least as high. Lowering the band therefore keeps every mesh; only a raise invalidates. */
export function bandCovers(built: number | null | undefined, wanted: number | null): boolean {
  if (built === undefined) return false;
  return bandRank(built) >= bandRank(wanted);
}

/** Resident keys whose mesh no longer covers `wanted`, nearest to the camera chunk first. */
export function staleBandKeys(
  built: ReadonlyMap<string, number | null>, wanted: number | null, ccx: number, ccy: number,
): string[] {
  const out: { k: string; d2: number }[] = [];
  for (const [k, b] of built) {
    if (bandCovers(b, wanted)) continue;
    const [x, y] = k.split(",").map(Number);
    out.push({ k, d2: (x - ccx) ** 2 + (y - ccy) ** 2 });
  }
  out.sort((a, b) => a.d2 - b.d2);
  return out.map((e) => e.k);
}
