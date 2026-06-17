import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SelectionInfo, ClipboardInfo, ExtrudeAxis, TreeType } from "./App";

type PreviewView = "front" | "side" | "top";

interface PreviewData {
  width: number;
  height: number;
  pixels: Uint8Array;
}

interface PreviewDataRaw {
  width: number;
  height: number;
  pixels: string; // base64
}

function decodePixels(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

interface Props {
  selection: SelectionInfo;
  clipboard: ClipboardInfo | null;
  elevationPanelOpen: boolean;
  onToggleElevationPanel: () => void;
  extrudeCount: number;
  onExtrudeCountChange: (n: number) => void;
  extrudeAxis: ExtrudeAxis;
  onExtrudeAxisChange: (a: ExtrudeAxis) => void;
  onExtrude: (ignoreAir: boolean) => void;
  extrudeOpen: boolean;
  onExtrudeOpenChange: (v: boolean) => void;
  onSavePrefab: () => void;
  onGenerateTrees: (treeType: TreeType, density: number) => void;
}

const CW = 190;
const CH = 120;
const LABEL_H = 16; // bottom strip reserved for the debug overlay label

const zInput: React.CSSProperties = {
  width: 54,
  background: "rgba(0,0,0,0.5)",
  border: "1px solid #475569",
  color: "#e2e8f0",
  borderRadius: 4,
  padding: "2px 5px",
  fontSize: 13,
  textAlign: "center",
  outline: "none",
};

// ── component ────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 60,
  right: 12,
  background: "rgba(5,12,26,0.85)",
  border: "1px solid #1e40af",
  borderRadius: 7,
  padding: "8px 10px",
  fontSize: 12,
  color: "#e2e8f0",
  width: 210,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  userSelect: "none",
};

export default function SelectionInspector({ selection: sel, clipboard, elevationPanelOpen, onToggleElevationPanel, extrudeCount, onExtrudeCountChange, extrudeAxis, onExtrudeAxisChange, onExtrude, extrudeOpen, onExtrudeOpenChange, onSavePrefab, onGenerateTrees }: Props) {
  const [view, setView] = useState<PreviewView>("front");
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [extrudeIgnoreAir, setExtrudeIgnoreAir] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [treeGenOpen, setTreeGenOpen] = useState(false);
  const [treeType, setTreeType] = useState<TreeType>("normal");
  const [treeDensity, setTreeDensity] = useState(20); // percent 1–100
  const [treeGenerating, setTreeGenerating] = useState(false);

  const chunksX = Math.floor(sel.x2 / 16) - Math.floor(sel.x1 / 16) + 1;
  const chunksY = Math.floor(sel.y2 / 16) - Math.floor(sel.y1 / 16) + 1;
  const chunkCount = chunksX * chunksY;
  const volume = sel.width * sel.height * sel.depth;

  // Fetch preview pixels from Rust whenever selection bounds or view tab changes.
  // Debounced at 150ms — render_selection_view scans blocks and is expensive for
  // large/tall selections; the debounce prevents it firing on every z-input keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      invoke<PreviewDataRaw>("render_selection_view", {
        x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2,
        zMin: sel.z_min, zMax: sel.z_max,
        view,
      })
        .then((raw) => setPreviewData({ ...raw, pixels: decodePixels(raw.pixels) }))
        .catch(() => setPreviewData(null));
    }, 150);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.x1, sel.y1, sel.x2, sel.y2, sel.z_min, sel.z_max, view]);

  // Render preview data (or clear) onto canvas; also re-renders when sel changes
  // so the overlay label stays current even before new pixels arrive.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#080f1e";
    ctx.fillRect(0, 0, CW, CH);

    if (previewData && previewData.width > 0 && previewData.height > 0) {
      const off = document.createElement("canvas");
      off.width = previewData.width;
      off.height = previewData.height;
      const offCtx = off.getContext("2d")!;
      const img = offCtx.createImageData(previewData.width, previewData.height);
      img.data.set(previewData.pixels);
      offCtx.putImageData(img, 0, 0);

      // Uniform scale so actual block proportions are preserved:
      // a thin Z range looks thin, a tall tower looks tall.
      const availH = CH - LABEL_H;
      const scale = Math.min(CW / previewData.width, availH / previewData.height);
      const dw = Math.round(previewData.width * scale);
      const dh = Math.round(previewData.height * scale);
      const ox = Math.round((CW - dw) / 2);
      const oy = Math.round((availH - dh) / 2);

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, ox, oy, dw, dh);
    }

    // Debug overlay: always rendered with current sel values
    const viewLabel = view === "front" ? "Front X-Z" : view === "side" ? "Side Y-Z" : "Top X-Y";
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, CH - LABEL_H, CW, LABEL_H);
    ctx.fillStyle = "#7dd3fc";
    ctx.font = "7px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `${viewLabel}  z${sel.z_min}–${sel.z_max}  x${sel.x1}–${sel.x2}  y${sel.y1}–${sel.y2}`,
      3,
      CH - LABEL_H / 2,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewData, view, sel.x1, sel.y1, sel.x2, sel.y2, sel.z_min, sel.z_max]);

  const dimBox: React.CSSProperties = {
    flex: 1, textAlign: "center",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 3, padding: "3px 0",
  };

  const tabBtn = (v: PreviewView): React.CSSProperties => ({
    flex: 1, padding: "2px 0", fontSize: 11, cursor: "pointer",
    background: view === v ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${view === v ? "#3b82f6" : "#334155"}`,
    color: view === v ? "#93c5fd" : "#64748b",
    borderRadius: 3,
  });

  const row: React.CSSProperties = {
    display: "flex", justifyContent: "space-between", alignItems: "center",
  };

  return (
    <div style={panelStyle}>

      {/* Header */}
      <div style={{ color: "#93c5fd", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>
        SELECTION
      </div>

      {/* Dimension boxes: W / H / D */}
      <div style={{ display: "flex", gap: 5 }}>
        {[
          { label: "W (X)", val: sel.width, accent: false },
          { label: "H (Y)", val: sel.height, accent: false },
          { label: "D (Z)", val: sel.depth, accent: true },
        ].map(({ label, val, accent }) => (
          <div key={label} style={dimBox}>
            <div style={{ color: "#64748b", fontSize: 9, lineHeight: "16px" }}>{label}</div>
            <div style={{
              color: accent ? "#7dd3fc" : "#e2e8f0",
              fontVariantNumeric: "tabular-nums", fontSize: 14, fontWeight: 700, lineHeight: "18px",
            }}>
              {val}
            </div>
          </div>
        ))}
      </div>

      {/* Coordinate ranges */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {[
          { axis: "X", lo: sel.x1, hi: sel.x2, color: "#e2e8f0" },
          { axis: "Y", lo: sel.y1, hi: sel.y2, color: "#e2e8f0" },
          { axis: "Z", lo: sel.z_min, hi: sel.z_max, color: "#7dd3fc" },
        ].map(({ axis, lo, hi, color }) => (
          <div key={axis} style={row}>
            <span style={{ color: "#64748b", minWidth: 12 }}>{axis}</span>
            <span style={{ color, fontVariantNumeric: "tabular-nums" }}>{lo} – {hi}</span>
          </div>
        ))}
      </div>

      <div style={{ borderTop: "1px solid #1a2744" }} />

      {/* Volume + chunks */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={row}>
          <span style={{ color: "#64748b" }}>Volume</span>
          <span style={{ color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>
            {volume.toLocaleString()} blocks
          </span>
        </div>
        <div style={row}>
          <span style={{ color: "#64748b" }}>Chunks</span>
          <span style={{ color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>
            {chunksX}×{chunksY} = {chunkCount}
          </span>
        </div>
      </div>

      {/* Clipboard info */}
      {clipboard && (
        <>
          <div style={{ borderTop: "1px solid #1a2744" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ color: "#4ade80", fontWeight: 700, fontSize: 10, letterSpacing: "0.06em" }}>
              CLIPBOARD
            </div>
            <div style={row}>
              <span style={{ color: "#64748b" }}>Size</span>
              <span style={{ color: "#86efac", fontVariantNumeric: "tabular-nums" }}>
                {clipboard.width}×{clipboard.height}×{clipboard.depth}
              </span>
            </div>
            <div style={row}>
              <span style={{ color: "#64748b" }}>Z range</span>
              <span style={{ color: "#86efac", fontVariantNumeric: "tabular-nums" }}>
                {clipboard.z_anchor} – {clipboard.z_anchor + clipboard.depth - 1}
              </span>
            </div>
            <button
              onClick={onSavePrefab}
              style={{
                marginTop: 2, padding: "2px 0", fontSize: 11, cursor: "pointer",
                background: "rgba(74,222,128,0.12)",
                border: "1px solid #4ade80",
                color: "#86efac",
                borderRadius: 3,
              }}
              title="Save clipboard contents as a reusable .epfab prefab file"
            >
              Save Prefab…
            </button>
          </div>
        </>
      )}

      <div style={{ borderTop: "1px solid #1a2744" }} />

      {/* Extrude — repeat the selection N times along an axis */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {/* Collapsible header */}
        <div
          onClick={() => onExtrudeOpenChange(!extrudeOpen)}
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}
        >
          <span style={{ color: "#475569", fontSize: 9 }}>{extrudeOpen ? "▼" : "▶"}</span>
          <span style={{ color: "#93c5fd", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>EXTRUDE</span>
        </div>
        {extrudeOpen && (<>
          {/* Axis selector — 3 pairs */}
          <div style={{ display: "flex", gap: 3 }}>
            {([
              ["z+", "↑ Z+"], ["z-", "↓ Z−"],
              ["x+", "→ X+"], ["x-", "← X−"],
              ["y+", "↓ Y+"], ["y-", "↑ Y−"],
            ] as [ExtrudeAxis, string][]).map(([ax, label]) => (
              <button
                key={ax}
                onClick={() => onExtrudeAxisChange(ax)}
                style={{
                  flex: 1, padding: "2px 0", fontSize: 10, cursor: "pointer",
                  background: extrudeAxis === ax ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${extrudeAxis === ax ? "#3b82f6" : "#334155"}`,
                  color: extrudeAxis === ax ? "#93c5fd" : "#64748b",
                  borderRadius: 3,
                }}
                title={`Extrude in ${ax} direction`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Count + ignore-air row */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>Copies</span>
            <input
              type="number"
              min={1} max={20}
              value={extrudeCount}
              onChange={e => onExtrudeCountChange(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
              style={{ ...zInput, width: 44 }}
              title="Number of copies to make (not counting the original)"
            />
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", marginLeft: "auto" }}>
              <input
                type="checkbox"
                checked={extrudeIgnoreAir}
                onChange={e => setExtrudeIgnoreAir(e.target.checked)}
                style={{ accentColor: "#3b82f6" }}
              />
              <span style={{ color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>skip air</span>
            </label>
          </div>
          {/* Execute button */}
          <button
            onClick={() => onExtrude(extrudeIgnoreAir)}
            style={{
              padding: "3px 0", fontSize: 11, cursor: "pointer",
              background: "rgba(59,130,246,0.25)",
              border: "1px solid #3b82f6",
              color: "#93c5fd",
              borderRadius: 3,
              fontWeight: 600,
            }}
            title={`Copy selection ${extrudeCount}× in ${extrudeAxis} direction`}
          >
            Extrude ×{extrudeCount} {extrudeAxis}
          </button>
        </>)}
      </div>

      <div style={{ borderTop: "1px solid #1a2744" }} />

      {/* Trees — scatter trees across the selection's terrain surface */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div
          onClick={() => setTreeGenOpen(v => !v)}
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}
        >
          <span style={{ color: "#475569", fontSize: 9 }}>{treeGenOpen ? "▼" : "▶"}</span>
          <span style={{ color: "#4ade80", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>TREES</span>
        </div>
        {treeGenOpen && (<>
          {/* Tree type buttons */}
          <div style={{ display: "flex", gap: 3 }}>
            {([
              ["normal",    "Normal"],
              ["terrain",   "Terrain"],
              ["pine",      "Pine"],
              ["tall_pine", "Tall Pine"],
            ] as [TreeType, string][]).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTreeType(t)}
                style={{
                  flex: 1, padding: "2px 0", fontSize: 10, cursor: "pointer",
                  background: treeType === t ? "rgba(74,222,128,0.25)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${treeType === t ? "#4ade80" : "#334155"}`,
                  color: treeType === t ? "#86efac" : "#64748b",
                  borderRadius: 3,
                }}
                title={
                  t === "normal"    ? "Deciduous tree: trunk + dome canopy (3–8 block trunk, 4 leaf layers)" :
                  t === "terrain"   ? "Tall terrain tree: ragged wide canopy (6–11 block height)" :
                  t === "pine"      ? "Conical pine: narrow 5×5 canopy, 2-block trunk" :
                                      "Tall conical pine: wide 7×7 base canopy, 2-block trunk"
                }
              >
                {label}
              </button>
            ))}
          </div>
          {/* Density */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>Density</span>
            <input
              type="range"
              min={1} max={100} step={1}
              value={treeDensity}
              onChange={e => setTreeDensity(parseInt(e.target.value))}
              style={{ flex: 1, accentColor: "#4ade80" }}
              title={`Plant a tree in roughly ${treeDensity}% of columns`}
            />
            <span style={{ color: "#86efac", fontVariantNumeric: "tabular-nums", fontSize: 11, minWidth: 28, textAlign: "right" }}>
              {treeDensity}%
            </span>
          </div>
          {/* Generate button */}
          <button
            disabled={treeGenerating}
            onClick={async () => {
              setTreeGenerating(true);
              try { await onGenerateTrees(treeType, treeDensity / 100); }
              finally { setTreeGenerating(false); }
            }}
            style={{
              padding: "3px 0", fontSize: 11, cursor: treeGenerating ? "default" : "pointer",
              background: treeGenerating ? "rgba(74,222,128,0.08)" : "rgba(74,222,128,0.2)",
              border: "1px solid #4ade80",
              color: treeGenerating ? "#475569" : "#86efac",
              borderRadius: 3,
              fontWeight: 600,
            }}
            title={`Scatter ${treeType.replace("_", " ")} trees at ${treeDensity}% density across the selection`}
          >
            {treeGenerating ? "Generating…" : `Plant Trees (${treeDensity}%)`}
          </button>
        </>)}
      </div>

      <div style={{ borderTop: "1px solid #1a2744" }} />

      {/* Preview view tabs */}
      <div style={{ display: "flex", gap: 3 }}>
        {(["front", "side", "top"] as PreviewView[]).map((v) => (
          <button key={v} style={tabBtn(v)} onClick={() => setView(v)}>
            {v.charAt(0).toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>

      {/* Orthographic preview canvas */}
      <canvas
        ref={canvasRef}
        width={CW}
        height={CH}
        style={{ display: "block", width: CW, height: CH, borderRadius: 4, border: "1px solid #1a2744" }}
        title={`${view} view — actual block colors`}
      />

      {/* Elevation view toggle — off by default; expensive on large 256z worlds */}
      <button
        onClick={onToggleElevationPanel}
        style={{
          padding: "2px 0", fontSize: 11, cursor: "pointer",
          background: elevationPanelOpen ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
          border: `1px solid ${elevationPanelOpen ? "#3b82f6" : "#334155"}`,
          color: elevationPanelOpen ? "#93c5fd" : "#64748b",
          borderRadius: 3,
        }}
        title="Show full-height front/side elevation view below. Disable on large 256-layer worlds if panning feels sluggish."
      >
        {elevationPanelOpen ? "Elevation view ✓" : "Elevation view"}
      </button>
    </div>
  );
}
