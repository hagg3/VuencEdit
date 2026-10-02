/**
 * Fetches the paste lens's front + side elevations from `render_paste_lens` (UI redesign r3, Stage
 * 14.9). The paste wrapper over `useLensFetch` (20.4), which owns the throttle and the pure
 * `lensScheduler.ts` policy (one request in flight / latest wins / a failed key stays parked).
 *
 * **Hover-driven origin churn is coalesced to ≤15 Hz** before it ever reaches the scheduler:
 * `MapCanvas`'s ghost subscription can fire far faster than that while the mouse moves over the map
 * (CLAUDE.md §"Copy/Paste System"). The same throttle covers every other input too (elevation
 * offset, mode flags, clipboard identity, `editEpoch`) — none of those change anywhere near 15 Hz in
 * practice, so a single throttle keeps this simple rather than special-casing origin changes.
 */
import { invoke } from "@tauri-apps/api/core";
import { decodePasteLensPair, type PasteLensResult } from "../types";
import { useLensFetch } from "./useLensFetch";

export type LensPasteMode = "normal" | "terrain";

export interface LensRenderInputs {
  /** Paste origin (top-left), in world coordinates — the same one `paste_at`/`paste_terrain` take. */
  origin: { x: number; y: number };
  elevationOffset: number;
  mode: LensPasteMode;
  ignoreAir: boolean;
  aboveSurface: boolean;
  /** Bumped by the caller whenever the clipboard's *content* changes (rotate/mirror/copy/new copy)
   *  — dimensions alone don't always change (mirror), so this can't be derived from width/height. */
  clipboardEpoch: number;
  editEpoch: number;
  context?: number;
  maxPx?: number;
}

export interface LensRenderState {
  front: PasteLensResult | null;
  side: PasteLensResult | null;
  loading: boolean;
  /** Set on the most recent failure; cleared on the next successful render. Shown as an inline
   *  message in the lens body instead of the elevations. */
  error: string | null;
}

/** Hover-driven origin churn (and everything else) coalesces to this period — see the file header. */
const THROTTLE_MS = 66;

function keyOf(i: LensRenderInputs): string {
  return [
    i.origin.x, i.origin.y, i.elevationOffset, i.mode, i.ignoreAir ? 1 : 0, i.aboveSurface ? 1 : 0,
    i.clipboardEpoch, i.editEpoch, i.context ?? 2, i.maxPx ?? 512,
  ].join("|");
}

/**
 * `enabled` gates the whole hook (collapsed/closed lens, no paste armed, scatter/array mode — none
 * of those have a single footprint to render): while false, no request is ever in flight and the
 * result resets to idle, matching "no render requests while the lens isn't showing anything".
 */
export function useLensRender(inputs: LensRenderInputs, enabled: boolean): LensRenderState {
  const fetch = async () => {
    // One call returns both views (20.3): the backend computes the paste bases once.
    const buf = await invoke<ArrayBuffer>("render_paste_lens", {
      x: inputs.origin.x, y: inputs.origin.y,
      elevationOffset: inputs.elevationOffset, mode: inputs.mode,
      aboveSurface: inputs.aboveSurface, ignoreAir: inputs.ignoreAir,
      context: inputs.context ?? 2, maxPx: inputs.maxPx ?? 512,
    });
    return decodePasteLensPair(buf);
  };
  const r = useLensFetch(enabled ? keyOf(inputs) : null, fetch, THROTTLE_MS);
  return { front: r.data?.front ?? null, side: r.data?.side ?? null, loading: r.loading, error: r.error };
}
