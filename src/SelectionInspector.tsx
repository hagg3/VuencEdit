import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SelectionInfo, ClipboardInfo } from "./App";

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

export default function SelectionInspector({ selection: sel, clipboard }: Props) {
  const [view, setView] = useState<PreviewView>("front");
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
          </div>
        </>
      )}

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
    </div>
  );
}
