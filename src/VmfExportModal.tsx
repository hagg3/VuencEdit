import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { EDEN_TEAL, EDEN_TEAL_READABLE, glassPanel, chromeButton, chromeButtonAccent } from "./designTokens";
import Modal from "./Modal";

export interface VmfExportBounds {
  x1: number; y1: number; x2: number; y2: number;
  zMin: number; zMax: number;
}

interface VmfExportResult {
  brush_count: number;
  side_count: number;
  material_count: number;
}

interface Props {
  worldName: string;
  bounds: VmfExportBounds;
  onClose: () => void;
}

// Mirrors vmf_export.rs's preset lineage — 40 is the backend default.
const UNIT_PRESETS = [32, 40, 48, 64];

type TextureMode = "dev" | "flat";

const btn: React.CSSProperties = chromeButton({ padding: "5px 13px", fontSize: 13 });
const presetBtn: React.CSSProperties = { padding: "4px 10px", fontSize: 12 };

export default function VmfExportModal({ worldName, bounds, onClose }: Props) {
  const [unitsPerBlock, setUnitsPerBlock] = useState(40);
  const [autoShell, setAutoShell] = useState(false);
  const [textureMode, setTextureMode] = useState<TextureMode>("dev");
  const [mergeAcrossMaterials, setMergeAcrossMaterials] = useState(false);
  const [estimate, setEstimate] = useState<VmfExportResult | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runEstimate = useCallback(async (upb: number, shell: boolean, mode: TextureMode, mergeAcross: boolean) => {
    setEstimating(true);
    setEstimateError(null);
    try {
      const r = await invoke<VmfExportResult>("estimate_vmf", {
        x1: bounds.x1, y1: bounds.y1, x2: bounds.x2, y2: bounds.y2,
        zMin: bounds.zMin, zMax: bounds.zMax,
        unitsPerBlock: upb,
        autoShell: shell,
        textureMode: mode,
        mergeAcrossMaterials: mergeAcross,
      });
      setEstimate(r);
    } catch (e) {
      setEstimate(null);
      setEstimateError(String(e));
    } finally {
      setEstimating(false);
    }
  }, [bounds]);

  useEffect(() => {
    runEstimate(unitsPerBlock, autoShell, textureMode, mergeAcrossMaterials);
  }, [runEstimate, unitsPerBlock, autoShell, textureMode, mergeAcrossMaterials]);

  async function doExport() {
    const defaultName = `${worldName}_selection.vmf`;
    const savePath = await save({
      filters: [{ name: "Source Engine VMF", extensions: ["vmf"] }],
      defaultPath: defaultName,
    });
    if (!savePath) return;
    setExporting(true);
    setResult(null);
    setError(null);
    try {
      const r = await invoke<VmfExportResult>("export_vmf", {
        path: savePath,
        x1: bounds.x1, y1: bounds.y1, x2: bounds.x2, y2: bounds.y2,
        zMin: bounds.zMin, zMax: bounds.zMax,
        unitsPerBlock,
        autoShell,
        textureMode,
        mergeAcrossMaterials,
      });
      setResult(
        `Exported ${r.brush_count} brush${r.brush_count === 1 ? "" : "es"}` +
        (textureMode === "dev"
          ? ` using the dev texture — should load in Hammer with no setup.`
          : `, ${r.material_count} material${r.material_count === 1 ? "" : "s"} — ` +
            `materials sidecar written alongside the .vmf.`),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  const canExport = !exporting && !estimating && estimate !== null;

  return (
    // Blocked mid-export — dismissing wouldn't cancel the write, it would just hide it.
    <Modal onClose={onClose} zIndex={1000} label="Export VMF (Hammer)"
      closeOnEsc={!exporting} closeOnBackdrop={!exporting}
      backdropStyle={{ background: "rgba(0,0,0,0.75)" }}>
      <div
        style={glassPanel({
          padding: "18px 24px 20px", width: 420, maxWidth: "95vw",
          display: "flex", flexDirection: "column", gap: 14, color: "#ebe9e7",
        })}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Export VMF (Hammer)</span>
          <button
            onClick={onClose}
            disabled={exporting}
            title={exporting ? "An export is in progress" : "Close"}
            aria-label="Close"
            onMouseEnter={e => (e.currentTarget.style.color = EDEN_TEAL_READABLE)}
            onMouseLeave={e => (e.currentTarget.style.color = "#61584f")}
            style={{ background: "none", border: "none", color: "#61584f", fontSize: 20, cursor: exporting ? "not-allowed" : "pointer", opacity: exporting ? 0.4 : 1, lineHeight: 1, transition: "color .1s" }}
          >×</button>
        </div>

        <span style={{ fontSize: 12, color: "#83786c", lineHeight: 1.5 }}>
          Exports the current selection as editable Hammer brushwork. Dev textures resolve
          in-game with zero setup; flat color ships a placeholder materials sidecar to copy into
          your mod. Whole-world export isn't supported — Source caps a map at 8,192 brushes.
        </span>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "#61584f", textTransform: "uppercase", letterSpacing: "0.06em" }}>Texture Mode</span>
          <div style={{ display: "flex", gap: 8 }}>
            {([["dev", "Dev textures"], ["flat", "Flat color"]] as [TextureMode, string][]).map(([mode, label]) => (
              <button
                key={mode}
                disabled={exporting}
                onClick={() => setTextureMode(mode)}
                style={mode === textureMode
                  ? chromeButtonAccent(EDEN_TEAL, `rgb(${EDEN_TEAL})`, { color: EDEN_TEAL_READABLE, ...presetBtn })
                  : { ...btn, ...presetBtn }}
              >
                {label}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 10, color: "#83786c" }}>
            {textureMode === "dev"
              ? "Dev (default): every face uses Source's built-in measure texture — always resolves, no files to copy."
              : "Flat color: writes a per-block-type materials sidecar (needs copying into your mod's content tree)."}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "#61584f", textTransform: "uppercase", letterSpacing: "0.06em" }}>Units per Block</span>
          <div style={{ display: "flex", gap: 8 }}>
            {UNIT_PRESETS.map(u => (
              <button
                key={u}
                disabled={exporting}
                onClick={() => setUnitsPerBlock(u)}
                style={u === unitsPerBlock
                  ? chromeButtonAccent(EDEN_TEAL, `rgb(${EDEN_TEAL})`, { color: EDEN_TEAL_READABLE, ...presetBtn })
                  : { ...btn, ...presetBtn }}
              >
                {u}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 10, color: "#83786c" }}>
            40 (default) makes a 2-block Eden player ≈ the 72-unit Source player hull.
          </span>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#afa69d", cursor: exporting ? "not-allowed" : "pointer" }}>
          <input
            type="checkbox"
            checked={autoShell}
            disabled={exporting}
            onChange={e => setAutoShell(e.currentTarget.checked)}
          />
          Add skybox shell (hollow box + light + spawn — compiles standalone)
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#afa69d", cursor: exporting ? "not-allowed" : "pointer" }}>
            <input
              type="checkbox"
              checked={mergeAcrossMaterials}
              disabled={exporting}
              onChange={e => setMergeAcrossMaterials(e.currentTarget.checked)}
            />
            Merge adjacent blocks (ignore block type)
          </label>
          <span style={{ fontSize: 10, color: "#83786c", paddingLeft: 24 }}>
            Fuses adjacent cells into maximal boxes regardless of type — ideal for greyboxing a
            tiled/checkerboard floor, at the cost of losing the tiling pattern.
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: "#61584f", textTransform: "uppercase", letterSpacing: "0.06em" }}>Estimate</span>
          {estimating ? (
            <span style={{ color: "#afa69d", fontSize: 13 }}>Counting brushes…</span>
          ) : estimateError ? (
            <span style={{ color: "#f87171", fontSize: 13 }}>{estimateError}</span>
          ) : estimate ? (
            <span style={{ color: "#afa69d", fontSize: 13 }}>
              {estimate.brush_count} brush{estimate.brush_count === 1 ? "" : "es"},{" "}
              {estimate.side_count} sides, {estimate.material_count} material{estimate.material_count === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            onClick={doExport}
            disabled={!canExport}
            style={canExport
              ? chromeButtonAccent(EDEN_TEAL, `rgb(${EDEN_TEAL})`, { color: EDEN_TEAL_READABLE, padding: "5px 13px", fontSize: 13 })
              : { ...btn, opacity: 0.4, cursor: "not-allowed" }}
          >
            {exporting ? "Exporting…" : "Export…"}
          </button>

          {result && (
            <div style={{
              background: "rgba(34,197,94,0.1)",
              border: "1px solid #166534",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 13,
              color: "#86efac",
            }}>
              {result}
            </div>
          )}

          {error && (
            <span style={{ color: "#f87171", fontSize: 13 }}>{error}</span>
          )}
        </div>
      </div>
    </Modal>
  );
}
