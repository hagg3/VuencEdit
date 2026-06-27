import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SelectionInfo, ClipboardInfo } from "./App";

type PreviewView = "front" | "side" | "top" | "axo";

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

interface PreviewData {
  width: number;
  height: number;
  pixels: Uint8Array;
}

interface Props {
  selection: SelectionInfo;
  clipboard: ClipboardInfo | null;
  quadMode: boolean;
  /** Override the panel's top offset (px). */
  topPx?: number;
}

const CW = 190;
const CH = 120;
const LABEL_H = 16;

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 108,
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

export default function SelectionInspector({ selection: sel, clipboard, quadMode, topPx }: Props) {
  const [view, setView] = useState<PreviewView>("front");
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [orthoOpen, setOrthoOpen] = useState(!quadMode);
  const [axoSki, setAxoSki] = useState(0.2);
  const [axoDir, setAxoDir] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Fetch orthographic preview (front/side/top).
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

  // Render preview onto canvas.
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
      const availH = CH - LABEL_H;
      const scale = Math.min(CW / previewData.width, availH / previewData.height);
      const dw = Math.round(previewData.width * scale);
      const dh = Math.round(previewData.height * scale);
      const ox = Math.round((CW - dw) / 2);
      const oy = Math.round((availH - dh) / 2);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, ox, oy, dw, dh);
    }

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
      3, CH - LABEL_H / 2,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewData, view, sel.x1, sel.y1, sel.x2, sel.y2, sel.z_min, sel.z_max, axoDir, axoSki]);

  const tabBtn = (v: PreviewView): React.CSSProperties => ({
    flex: 1, padding: "2px 0", fontSize: 11, cursor: "pointer",
    background: view === v ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${view === v ? "#3b82f6" : "#334155"}`,
    color: view === v ? "#93c5fd" : "#64748b",
    borderRadius: 3,
  });

  return (
    <div style={topPx != null ? { ...panelStyle, top: topPx } : panelStyle}>
      {/* Collapsible ortho view */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div
          onClick={() => setOrthoOpen(v => !v)}
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}
        >
          <span style={{ color: "#475569", fontSize: 9 }}>{orthoOpen ? "▼" : "▶"}</span>
          <span style={{ color: "#94a3b8", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>ORTHO VIEW</span>
        </div>
        {orthoOpen && (<>
          <div style={{ display: "flex", gap: 3 }}>
            {(["front", "side", "top", "axo"] as PreviewView[]).map((v) => (
              <button key={v} style={tabBtn(v)} onClick={() => setView(v)}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          {view === "axo" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 3 }}>
                {([["SE", 0], ["SW", 1], ["NE", 2], ["NW", 3]] as [string, number][]).map(([label, d]) => (
                  <button key={d} onClick={() => setAxoDir(d)}
                    style={{
                      flex: 1, padding: "2px 0", fontSize: 10, cursor: "pointer",
                      background: axoDir === d ? "rgba(168,85,247,0.25)" : "rgba(255,255,255,0.04)",
                      border: `1px solid ${axoDir === d ? "#a855f7" : "#334155"}`,
                      color: axoDir === d ? "#d8b4fe" : "#64748b", borderRadius: 3,
                    }}
                  >{label}</button>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "#64748b", fontSize: 10, whiteSpace: "nowrap" }}>Depth</span>
                <input type="range" min={0.05} max={0.5} step={0.01} value={axoSki}
                  onChange={e => setAxoSki(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: "#a855f7" }} />
                <span style={{ color: "#d8b4fe", fontSize: 10, minWidth: 28, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {axoSki.toFixed(2)}
                </span>
              </div>
            </div>
          )}
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
