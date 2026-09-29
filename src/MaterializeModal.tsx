import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type { WorldMeta } from "./types";
import type { MaterializeSelectionBounds } from "./MapCanvas";
import { MAX_MATERIALIZE_CHUNKS } from "./MapCanvas";
import { MODAL_TEXT } from "./designTokens";
import { ACCENTS, DANGER_HEX, RAMP, armedRecipe, mix } from "./theme/theme";
import { SliderRow } from "./ribbon/primitives";
import Dialog, { DialogButton } from "./ui/Dialog";

// Lightened tints for text sitting directly on the warm modal surface (mechanical hex-literal
// migration, Stage 14.15) — plain accent/danger hex fails AA there; these clear it with margin.
const RED_LIGHT = mix(RAMP.white, DANGER_HEX, 0.5);
const GREEN_TEXT = armedRecipe(ACCENTS.clipboard).text;

interface Props {
  world: WorldMeta;
  bounds: MaterializeSelectionBounds;
  onClose: () => void;
  /** Called once the write succeeds and the modal is ready for App to swap the session onto the
   *  new file (the locked-in "auto-reload after write" decision). */
  onMaterialized: (path: string) => void | Promise<void>;
}

interface MaterializeResult { chunksAdded: number; totalChunks: number }

/**
 * Confirm-first, non-undoable materialize flow. Modeled on the existing Expand-from-Template
 * modal (App.tsx), but as its own component since it also owns the flat-terrain depth inputs and
 * a stronger warning (this replaces the open session, not just bakes chunks into the current one).
 */
export default function MaterializeModal({ world, bounds, onClose, onMaterialized }: Props) {
  const { cx1, cy1, cx2, cy2 } = bounds;
  const nChunks = (cx2 - cx1 + 1) * (cy2 - cy1 + 1);
  // `bounds` is in absolute chunk coords (see MaterializeSelectionBounds), so the current bbox it's
  // compared against is [abs_min, abs_min + size), not [0, size).
  const beyond = cx1 < world.abs_min_x || cy1 < world.abs_min_y
    || cx2 >= world.abs_min_x + world.width_chunks
    || cy2 >= world.abs_min_y + world.height_chunks;
  const tooLarge = nChunks > MAX_MATERIALIZE_CHUNKS;

  // The reloaded world's bbox is the union of the old one and this selection — a *span*, not a
  // count, so a thin selection reaching far away costs almost no write time but can multiply the
  // map's nominal dimensions (which every 2D view, tile fetch and elevation scan is sized by).
  // MAX_MATERIALIZE_CHUNKS caps the area written and says nothing about this, so show it up front.
  const newWChunks = Math.max(world.abs_min_x + world.width_chunks, cx2 + 1) - Math.min(world.abs_min_x, cx1);
  const newHChunks = Math.max(world.abs_min_y + world.height_chunks, cy2 + 1) - Math.min(world.abs_min_y, cy1);
  const growsBbox = newWChunks > world.width_chunks || newHChunks > world.height_chunks;
  // 4× the old area is well past "grew a bit at the edge" and into "this is now mostly empty space".
  const bboxBlowup = newWChunks * newHChunks > 4 * world.width_chunks * world.height_chunks;

  // Matched to the flat terrain the game itself generates, so materialized chunks sit flush with
  // the pre-existing ones instead of 12 blocks below them. Measured off a real world's chunk data:
  // bedrock z0, stone z1–15, dirt z16–31, grass z32 — i.e. stone 15, dirt 16, surface z32.
  // (New World ▸ Flat still defaults to 15/4 = surface z20; that's a standalone world, not one
  // being extended, so it isn't required to match — see the handoff doc's follow-ups.)
  const [stoneDepth, setStoneDepth] = useState(15);
  const [dirtDepth, setDirtDepth] = useState(16);
  const surfaceZ = 1 + stoneDepth + dirtDepth;
  const depthTooLarge = surfaceZ > world.max_z;

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<MaterializeResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<number>("materialize_progress", (e) => setProgress(e.payload));
    return () => { unlisten.then(f => f()); };
  }, []);

  async function run() {
    const defaultName = world.name ? `${world.name}_materialized.eden` : "world_materialized.eden";
    const outPath = await save({ filters: [{ name: "Eden World", extensions: ["eden"] }], defaultPath: defaultName });
    if (!outPath) return;
    setRunning(true);
    setProgress(0);
    setErrorMsg(null);
    const coords: [number, number][] = [];
    for (let cy = cy1; cy <= cy2; cy++) {
      for (let cx = cx1; cx <= cx2; cx++) coords.push([cx, cy]);
    }
    try {
      const res = await invoke<{ chunks_added: number; total_chunks: number }>("materialize_flat_chunks", {
        outputPath: outPath, coords, stoneDepth, dirtDepth,
      });
      setResult({ chunksAdded: res.chunks_added, totalChunks: res.total_chunks });
      await onMaterialized(outPath);
    } catch (e) {
      if (String(e) !== "Cancelled") setErrorMsg(String(e));
    } finally {
      setRunning(false);
      setProgress(100);
    }
  }

  function cancel() {
    invoke("cancel_materialize").catch(() => {});
  }

  const footer = running ? (
    <DialogButton onClick={cancel}>Cancel</DialogButton>
  ) : (
    <>
      <DialogButton onClick={onClose}>Cancel</DialogButton>
      <DialogButton variant="primary" onClick={run} disabled={tooLarge || depthTooLarge}>
        Choose Output File &amp; Materialize
      </DialogButton>
    </>
  );

  return (
    <Dialog size="sm" icon="materialize" title="Materialize Chunk Space" onClose={onClose} busy={running} footer={footer}>
      {!running && result === null && (
        <>
          <div style={{ fontSize: 12, color: MODAL_TEXT.secondary, marginBottom: 14, lineHeight: 1.5 }}>
            Writes {nChunks.toLocaleString()} ungenerated chunk{nChunks === 1 ? "" : "s"} as real flat
            terrain{beyond ? " (this selection extends beyond the current map edge)" : ""}, to a
            <strong style={{ color: MODAL_TEXT.primary }}> new output file</strong>. This is non-undoable and
            cannot edit the currently open world in place.
          </div>
          <div style={{
            fontSize: 12, color: RED_LIGHT, background: "rgba(220,38,38,0.12)",
            border: "1px solid rgba(220,38,38,0.35)", borderRadius: 6, padding: "8px 10px", marginBottom: 16, lineHeight: 1.5,
          }}>
            Completing this will <strong>replace the currently open world</strong> with the new file —
            save any unsaved work first. Write time scales with the world size and the number of
            chunks selected, so this may take a while on a large selection.
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
            <SliderRow label="Stone depth" min={0} max={Math.max(1, world.max_z - 6)} value={stoneDepth}
              onChange={setStoneDepth} width={260} labelWidth={80} />
            <SliderRow label="Dirt depth" min={0} max={Math.max(1, world.max_z - 6)} value={dirtDepth}
              onChange={setDirtDepth} width={260} labelWidth={80} />
            {/* The layers are only meaningful relative to the terrain being extended, and the
                mismatch is invisible from the top-down map — it only shows up in the 3D view or
                a slab once the world has already been rewritten. Surfacing the resulting z here
                makes it checkable against a neighbouring column beforehand. */}
            {!depthTooLarge && (
              <div style={{ fontSize: 11, color: MODAL_TEXT.label, lineHeight: 1.5 }}>
                Bedrock z0
                {stoneDepth > 0 && ` · stone z1–${stoneDepth}`}
                {dirtDepth > 0 && ` · dirt z${1 + stoneDepth}–${surfaceZ - 1}`}
                {" · grass surface at "}
                <span style={{ color: MODAL_TEXT.secondary }}>z{surfaceZ}</span>
                {stoneDepth === 15 && dirtDepth === 16 && " — matches the game's own flat terrain"}
              </div>
            )}
          </div>

          {tooLarge && (
            <div style={{ fontSize: 12, color: RED_LIGHT, marginBottom: 12 }}>
              Selection too large: {nChunks.toLocaleString()} chunks exceeds the{" "}
              {MAX_MATERIALIZE_CHUNKS.toLocaleString()}-chunk limit for one materialize operation.
              Narrow the selection and try again.
            </div>
          )}
          {depthTooLarge && (
            <div style={{ fontSize: 12, color: RED_LIGHT, marginBottom: 12 }}>
              Layer depths too large: surface would be at z={surfaceZ} but this world's max z is {world.max_z}.
            </div>
          )}
          {growsBbox && !tooLarge && (
            <div style={{
              fontSize: 12, marginBottom: 12, lineHeight: 1.5,
              color: bboxBlowup ? RED_LIGHT : MODAL_TEXT.secondary,
              ...(bboxBlowup ? {
                background: "rgba(220,38,38,0.12)", border: "1px solid rgba(220,38,38,0.35)",
                borderRadius: 6, padding: "8px 10px",
              } : {}),
            }}>
              Map grows from {world.width_chunks}×{world.height_chunks} to {newWChunks}×{newHChunks} chunks
              ({(newWChunks * 16).toLocaleString()}×{(newHChunks * 16).toLocaleString()} blocks).
              {bboxBlowup && " That's mostly empty space — the 2D map will zoom right out and tiles" +
                " will load slowly. Consider a selection closer to the existing map."}
            </div>
          )}
        </>
      )}

      {running && (
        <>
          <div style={{ fontSize: 12, color: MODAL_TEXT.secondary, marginBottom: 12 }}>
            Writing chunks… {progress}%
          </div>
          <div style={{ background: RAMP.mbtn1, borderRadius: 4, height: 8, overflow: "hidden" }}>
            <div style={{ height: "100%", background: ACCENTS.warm, borderRadius: 4, width: `${progress}%`, transition: "width 0.2s" }} />
          </div>
        </>
      )}

      {errorMsg && !running && (
        <div style={{ fontSize: 12, color: RED_LIGHT, marginTop: 8 }}>{errorMsg}</div>
      )}

      {result !== null && !running && (
        <div style={{ fontSize: 13, color: GREEN_TEXT, marginTop: 12 }}>
          Done — {result.chunksAdded.toLocaleString()} chunks added ({result.totalChunks.toLocaleString()} total).
          Reloading…
        </div>
      )}
    </Dialog>
  );
}
