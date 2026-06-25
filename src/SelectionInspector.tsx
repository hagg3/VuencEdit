import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SelectionInfo, ClipboardInfo, ExtrudeAxis } from "./App";
import ThreeDPreview from "./ThreeDPreview";

type PreviewView = "front" | "side" | "top" | "axo";

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
  quadMode: boolean;
  extrudeCount: number;
  onExtrudeCountChange: (n: number) => void;
  extrudeAxis: ExtrudeAxis;
  onExtrudeAxisChange: (a: ExtrudeAxis) => void;
  onExtrude: (ignoreAir: boolean) => void;
  extrudeOpen: boolean;
  onExtrudeOpenChange: (v: boolean) => void;
  onSavePrefab: () => void;
  onGenerateTrees: (treeTypes: string[], density: number, leafPaints: number[], smartPlacement: boolean) => void;
  /** Override the panel's top offset (px). In quad view it's pushed down to clear the front pane header. */
  topPx?: number;
}

const CW = 190;
const CH = 120;
const LABEL_H = 16; // bottom strip reserved for the debug overlay label

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

export default function SelectionInspector({ selection: sel, clipboard, quadMode, extrudeCount, onExtrudeCountChange, extrudeAxis, onExtrudeAxisChange, onExtrude, extrudeOpen, onExtrudeOpenChange, onSavePrefab, onGenerateTrees, topPx }: Props) {
  const [view, setView] = useState<PreviewView>("front");
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [extrudeIgnoreAir, setExtrudeIgnoreAir] = useState(false);
  const [orthoOpen, setOrthoOpen] = useState(!quadMode);
  const [axoSki, setAxoSki] = useState(0.2);
  const [axoDir, setAxoDir] = useState(0); // 0=SE 1=SW 2=NE 3=NW
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [treeGenOpen, setTreeGenOpen] = useState(false);
  const [open3d, setOpen3d] = useState(false);
  const [treeTypes, setTreeTypes] = useState<string[]>(["normal"]);
  const [treeDensity, setTreeDensity] = useState(20); // percent 1–100
  const [leafPaints, setLeafPaints] = useState<number[]>([0, 22, 31, 40]);
  const [treeGenerating, setTreeGenerating] = useState(false);
  const [smartPlacement, setSmartPlacement] = useState(true);

  const chunksX = Math.floor(sel.x2 / 16) - Math.floor(sel.x1 / 16) + 1;
  const chunksY = Math.floor(sel.y2 / 16) - Math.floor(sel.y1 / 16) + 1;
  const chunkCount = chunksX * chunksY;
  const volume = sel.width * sel.height * sel.depth;

  // Fetch orthographic preview (front/side/top). Skips axo view — handled below.
  useEffect(() => {
    if (view === "axo") return;
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

  // Fetch axo preview — clipboard contents if available, else selection footprint.
  useEffect(() => {
    if (view !== "axo") return;
    const timer = setTimeout(() => {
      const p = clipboard
        ? invoke<PreviewDataRaw>("render_axo_clipboard", { ski: axoSki, dir: axoDir })
        : invoke<PreviewDataRaw>("render_axo_region", { x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2, ski: axoSki, dir: axoDir });
      p.then((raw) => setPreviewData({ width: raw.width, height: raw.height, pixels: decodePixels(raw.pixels) }))
       .catch(() => setPreviewData(null));
    }, 150);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.x1, sel.y1, sel.x2, sel.y2, clipboard?.width, clipboard?.height, clipboard?.depth, view, axoSki, axoDir]);

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
    const axoDirLabel = ["SE", "SW", "NE", "NW"][axoDir] ?? "SE";
    const viewLabel = view === "front" ? "Front X-Z" : view === "side" ? "Side Y-Z" : view === "axo" ? `Axo ${axoDirLabel} d=${axoSki.toFixed(2)}` : "Top X-Y";
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
  }, [previewData, view, sel.x1, sel.y1, sel.x2, sel.y2, sel.z_min, sel.z_max, axoDir, axoSki]);

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
    <div style={topPx != null ? { ...panelStyle, top: topPx } : panelStyle}>

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
          {/* Compact axis selector — click to select direction */}
          <div style={{ display: "flex", gap: 3 }}>
            {([
              ["z+", "↑Z+"], ["z-", "↓Z−"],
              ["x+", "→X+"], ["x-", "←X−"],
              ["y+", "↓Y+"], ["y-", "↑Y−"],
            ] as [ExtrudeAxis, string][]).map(([ax, label]) => (
              <button
                key={ax}
                onClick={() => onExtrudeAxisChange(ax)}
                style={{
                  flex: 1, padding: "2px 0", fontSize: 9, cursor: "pointer",
                  background: extrudeAxis === ax ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${extrudeAxis === ax ? "#3b82f6" : "#334155"}`,
                  color: extrudeAxis === ax ? "#93c5fd" : "#64748b",
                  borderRadius: 3,
                }}
                title={`Extrude in ${ax} direction`}
              >{label}</button>
            ))}
          </div>
          {/* Count stepper + skip air + execute — all in one row */}
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "#475569", fontSize: 10 }}>×</span>
            <input
              type="number" min={1} max={20} value={extrudeCount}
              onChange={e => onExtrudeCountChange(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)))}
              style={{
                width: 38, padding: "1px 4px", fontSize: 11, textAlign: "center",
                background: "#1e293b", color: "#cbd5e1",
                border: "1px solid #334155", borderRadius: 3,
              }}
              title="Number of copies"
            />
            <label style={{ display: "flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={extrudeIgnoreAir}
                onChange={e => setExtrudeIgnoreAir(e.target.checked)}
                style={{ accentColor: "#3b82f6" }}
              />
              <span style={{ color: "#64748b", fontSize: 10, whiteSpace: "nowrap" }}>skip air</span>
            </label>
            <button
              onClick={() => onExtrude(extrudeIgnoreAir)}
              style={{
                flex: 1, padding: "2px 0", fontSize: 11, cursor: "pointer",
                background: "rgba(59,130,246,0.25)",
                border: "1px solid #3b82f6",
                color: "#93c5fd",
                borderRadius: 3, fontWeight: 600,
              }}
              title={`Copy selection ${extrudeCount}× in ${extrudeAxis} direction`}
            >Extrude {extrudeAxis}</button>
          </div>
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
          {/* Tree type buttons — multi-select */}
          <div style={{ display: "flex", gap: 3 }}>
            {([
              ["normal",    "Normal",    "Deciduous: trunk + dome canopy (3–8 block trunk, 4 leaf layers)"],
              ["terrain",   "Terrain",   "Tall terrain tree: ragged wide canopy (6–11 block height)"],
              ["pine",      "Pine",      "Conical pine: narrow 5×5 canopy, 2-block trunk"],
              ["tall_pine", "Tall Pine", "Tall conical pine: wide 7×7 base canopy, 2-block trunk"],
            ] as [string, string, string][]).map(([t, label, tip]) => {
              const active = treeTypes.includes(t);
              return (
                <button
                  key={t}
                  onClick={() => setTreeTypes(prev =>
                    prev.includes(t)
                      ? prev.length > 1 ? prev.filter(x => x !== t) : prev
                      : [...prev, t]
                  )}
                  style={{
                    flex: 1, padding: "2px 0", fontSize: 10, cursor: "pointer",
                    background: active ? "rgba(74,222,128,0.25)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${active ? "#4ade80" : "#334155"}`,
                    color: active ? "#86efac" : "#64748b",
                    borderRadius: 3,
                  }}
                  title={tip}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {/* Leaf color palette */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ color: "#64748b", fontSize: 10 }}>Leaf colors</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
              {([
                [0,  "#1eb428", "Natural (unpainted)"],
                [4,  "#aaffbf", "Light green"],
                [13, "#55ff7f", "Medium light green"],
                [22, "#00ff3f", "Green"],
                [31, "#00bf2f", "Medium dark green"],
                [40, "#007f1f", "Dark green"],
                [49, "#003f0f", "Very dark green"],
                [50, "#003f3f", "Very dark cyan"],
                [19, "#ff0000", "Red"],
                [20, "#ffbf00", "Orange"],
                [21, "#f2ff00", "Yellow"],
              ] as [number, string, string][]).map(([paint, hex, label]) => {
                const on = leafPaints.includes(paint);
                return (
                  <div
                    key={paint}
                    onClick={() => setLeafPaints(prev =>
                      prev.includes(paint)
                        ? prev.length > 1 ? prev.filter(p => p !== paint) : prev
                        : [...prev, paint]
                    )}
                    title={label}
                    style={{
                      width: 16, height: 16, borderRadius: 2,
                      background: hex,
                      border: `2px solid ${on ? "#ffffff" : "transparent"}`,
                      cursor: "pointer",
                      boxSizing: "border-box",
                      outline: on ? "1px solid #4ade80" : "1px solid #334155",
                    }}
                  />
                );
              })}
            </div>
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
              title="Tree density (higher = more trees)"
            />
            <span style={{ color: "#86efac", fontVariantNumeric: "tabular-nums", fontSize: 11, minWidth: 28, textAlign: "right" }}>
              {treeDensity}%
            </span>
          </div>
          {/* Smart placement toggle */}
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={smartPlacement}
              onChange={e => setSmartPlacement(e.target.checked)}
              style={{ accentColor: "#4ade80", cursor: "pointer" }}
            />
            <span style={{ color: "#94a3b8", fontSize: 10 }}>Grass/dirt only</span>
          </label>
          {/* Generate button */}
          <button
            disabled={treeGenerating}
            onClick={async () => {
              setTreeGenerating(true);
              try { await onGenerateTrees(treeTypes, Math.pow(treeDensity / 100, 2) * 0.20, leafPaints, smartPlacement); }
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
            title={`Scatter trees at ${treeDensity}% density across the selection`}
          >
            {treeGenerating ? "Generating…" : `Plant Trees (${treeDensity}%)`}
          </button>
        </>)}
      </div>

      <div style={{ borderTop: "1px solid #1a2744" }} />

      {/* 3D VIEW — collapsible, off by default */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div
          onClick={() => setOpen3d(v => !v)}
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}
        >
          <span style={{ color: "#475569", fontSize: 9 }}>{open3d ? "▼" : "▶"}</span>
          <span style={{ color: "#f472b6", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>3D VIEW</span>
          <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>exp</span>
        </div>
        {open3d && <ThreeDPreview selection={sel} />}
      </div>

      <div style={{ borderTop: "1px solid #1a2744" }} />

      {/* Orthographic preview — collapsible; collapsed by default in quad mode */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div
          onClick={() => setOrthoOpen(v => !v)}
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}
        >
          <span style={{ color: "#475569", fontSize: 9 }}>{orthoOpen ? "▼" : "▶"}</span>
          <span style={{ color: "#94a3b8", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>ORTHO VIEW</span>
        </div>
        {orthoOpen && (<>
          {/* Preview view tabs */}
          <div style={{ display: "flex", gap: 3 }}>
            {(["front", "side", "top", "axo"] as PreviewView[]).map((v) => (
              <button key={v} style={tabBtn(v)} onClick={() => setView(v)}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>

          {/* Axo controls — direction + depth, only when axo tab active */}
          {view === "axo" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 3 }}>
                {([["SE", 0], ["SW", 1], ["NE", 2], ["NW", 3]] as [string, number][]).map(([label, d]) => (
                  <button
                    key={d}
                    onClick={() => setAxoDir(d)}
                    style={{
                      flex: 1, padding: "2px 0", fontSize: 10, cursor: "pointer",
                      background: axoDir === d ? "rgba(168,85,247,0.25)" : "rgba(255,255,255,0.04)",
                      border: `1px solid ${axoDir === d ? "#a855f7" : "#334155"}`,
                      color: axoDir === d ? "#d8b4fe" : "#64748b",
                      borderRadius: 3,
                    }}
                  >{label}</button>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "#64748b", fontSize: 10, whiteSpace: "nowrap" }}>Depth</span>
                <input
                  type="range" min={0.05} max={0.5} step={0.01} value={axoSki}
                  onChange={e => setAxoSki(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: "#a855f7" }}
                />
                <span style={{ color: "#d8b4fe", fontSize: 10, minWidth: 28, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {axoSki.toFixed(2)}
                </span>
              </div>
            </div>
          )}

          {/* Orthographic preview canvas */}
          <canvas
            ref={canvasRef}
            width={CW}
            height={CH}
            style={{ display: "block", width: CW, height: CH, borderRadius: 4, border: "1px solid #1a2744" }}
            title={`${view} view — actual block colors`}
          />
        </>)}
      </div>
    </div>
  );
}
