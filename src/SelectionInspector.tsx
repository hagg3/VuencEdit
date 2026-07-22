import { decodeU8 } from "./codec";
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SelectionInfo, ClipboardInfo, PreviewDataRaw, PreviewData } from "./types";
import { EDEN_TEAL_READABLE } from "./designTokens";
import ElevationPreviewPanel from "./ElevationPreviewPanel";

type PreviewView = "front" | "side" | "top" | "axo";

interface Props {
  /** Sidebar tab is always mounted, unlike the old floating panel which only mounted while a
   *  selection existed — null renders the empty state instead. */
  selection: SelectionInfo | null;
  clipboard: ClipboardInfo | null;
  quadMode: boolean;

  // Elevation view — folded in from the old standalone Elevation tab.
  elevationSelection: SelectionInfo | null;
  elevationWidth: number;
  maxZ: number;
  extrudeCount: number;
  extrudeAxis: string;
  isPastePreview: boolean;
  editEpoch: number;
  drawActive: boolean;
  onDrawElevation: (x: number, y: number, z: number) => void;
  onZRangeChange?: (zMin: number, zMax: number) => void;
}

const CW = 190;
const CH = 120;
const LABEL_H = 16;
const CLIP_PREV_W = 140;
const CLIP_PREV_H = 140;

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 12,
  color: "#ebe9e7",
  userSelect: "none",
};

/** Selection info — moved here from the Selection ribbon tab's "Info" group: dimensions,
 *  X/Y bounds, block count, and (if shaped) the mask cell count. */
function SelectionInfoBlock({ sel }: { sel: SelectionInfo }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
      <div style={{ display: "flex", gap: 4, fontVariantNumeric: "tabular-nums" }}>
        {[["W", sel.width], ["H", sel.height], ["D", sel.depth]].map(([l, v]) => (
          <div key={l as string} style={{ textAlign: "center", background: "rgba(255,255,255,0.04)", borderRadius: 3, padding: "2px 6px", minWidth: 30 }}>
            <div style={{ color: "#83786c", fontSize: 8 }}>{l}</div>
            <div style={{ color: l === "D" ? "#7dd3fc" : "#ebe9e7", fontSize: 12, fontWeight: 700 }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 10, color: "#83786c", lineHeight: 1.3 }}>
        <div>X {sel.x1}–{sel.x2}  Y {sel.y1}–{sel.y2}</div>
        <div style={{ color: "#61584f" }}>
          {sel.width * sel.height * sel.depth} blocks
          {sel.masked && sel.cell_count != null ? ` — ◆ shaped (${sel.cell_count} cells)` : ""}
        </div>
      </div>
    </div>
  );
}

/** Clipboard info + top-down preview — mirrored here from the Clipboard ribbon tab (kept there too). */
function ClipboardInfoBlock({ clipboard }: { clipboard: ClipboardInfo }) {
  const [pixels, setPixels] = useState<{ width: number; height: number; pixels: Uint8Array } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    invoke<{ width: number; height: number; pixels: string }>("render_clipboard_preview")
      .then((raw) => setPixels({ width: raw.width, height: raw.height, pixels: decodeU8(raw.pixels) }))
      .catch(() => setPixels(null));
  }, [clipboard]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#151311";
    ctx.fillRect(0, 0, CLIP_PREV_W, CLIP_PREV_H);
    if (pixels && pixels.width > 0 && pixels.height > 0) {
      const off = document.createElement("canvas");
      off.width = pixels.width;
      off.height = pixels.height;
      const offCtx = off.getContext("2d")!;
      const img = offCtx.createImageData(pixels.width, pixels.height);
      img.data.set(pixels.pixels);
      offCtx.putImageData(img, 0, 0);
      const scale = Math.min(CLIP_PREV_W / pixels.width, CLIP_PREV_H / pixels.height);
      const dw = Math.round(pixels.width * scale);
      const dh = Math.round(pixels.height * scale);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, Math.round((CLIP_PREV_W - dw) / 2), Math.round((CLIP_PREV_H - dh) / 2), dw, dh);
    }
  }, [pixels]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ color: "#afa69d", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>CLIPBOARD</div>
      <div style={{ fontSize: 11 }}>
        <span style={{ color: "#86efac", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
          {clipboard.width}×{clipboard.height}×{clipboard.depth}
        </span>
        <span style={{ color: "#4ade80", fontSize: 10, marginLeft: 6 }}>
          z{clipboard.z_anchor}–{clipboard.z_anchor + clipboard.depth - 1}
        </span>
        {clipboard.masked && <span style={{ color: "#4ade80", fontSize: 10, marginLeft: 6 }}>◆ shaped</span>}
      </div>
      <canvas
        ref={canvasRef}
        width={CLIP_PREV_W}
        height={CLIP_PREV_H}
        style={{ display: "block", width: CLIP_PREV_W, height: CLIP_PREV_H, borderRadius: 4, border: "none", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4)" }}
        title="Clipboard top-down preview"
      />
    </div>
  );
}

export default function SelectionInspector({
  selection: sel, clipboard, quadMode,
  elevationSelection, elevationWidth, maxZ, extrudeCount, extrudeAxis, isPastePreview,
  editEpoch, drawActive, onDrawElevation, onZRangeChange,
}: Props) {
  void quadMode;
  const [view, setView] = useState<PreviewView>("front");
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  // Ortho view is always auto-expanded now (previously collapsed by default in quad mode).
  const [orthoOpen, setOrthoOpen] = useState(true);
  const [elevationOpen, setElevationOpen] = useState(true);
  const [axoSki, setAxoSki] = useState(0.2);
  const [axoDir, setAxoDir] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Fetch orthographic preview (front/side/top).
  useEffect(() => {
    if (!sel || view === "axo") return;
    const timer = setTimeout(() => {
      invoke<PreviewDataRaw>("render_selection_view", {
        x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2,
        zMin: sel.z_min, zMax: sel.z_max,
        view,
      })
        .then((raw) => setPreviewData({ ...raw, pixels: decodeU8(raw.pixels) }))
        .catch(() => setPreviewData(null));
    }, 150);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.x1, sel?.y1, sel?.x2, sel?.y2, sel?.z_min, sel?.z_max, view]);

  // Fetch axo preview — clipboard contents if available, else selection footprint.
  useEffect(() => {
    if (!sel || view !== "axo") return;
    const timer = setTimeout(() => {
      const p = clipboard
        ? invoke<PreviewDataRaw>("render_axo_clipboard", { ski: axoSki, dir: axoDir })
        : invoke<PreviewDataRaw>("render_axo_region", { x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2, ski: axoSki, dir: axoDir });
      p.then((raw) => setPreviewData({ width: raw.width, height: raw.height, pixels: decodeU8(raw.pixels) }))
       .catch(() => setPreviewData(null));
    }, 150);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.x1, sel?.y1, sel?.x2, sel?.y2, clipboard?.width, clipboard?.height, clipboard?.depth, view, axoSki, axoDir]);

  // Render preview onto canvas.
  useEffect(() => {
    if (!sel) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#151311";
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
  }, [previewData, view, sel?.x1, sel?.y1, sel?.x2, sel?.y2, sel?.z_min, sel?.z_max, axoDir, axoSki]);

  const tabBtn = (v: PreviewView): React.CSSProperties => ({
    flex: 1, padding: "2px 0", fontSize: 11, cursor: "pointer", border: "none",
    background: view === v
      ? "linear-gradient(180deg, rgba(0,164,173,0.35) 0%, rgba(0,164,173,0.10) 100%)"
      : "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
    boxShadow: view === v
      ? `inset 0 0 0 1px ${EDEN_TEAL_READABLE}, 0 .5px .5px rgba(255,255,255,.15)`
      : "inset 0 0 0 1px rgba(0,0,0,.5)",
    color: view === v ? EDEN_TEAL_READABLE : "#83786c",
    borderRadius: 3,
  });

  if (!sel) {
    return (
      <div style={panelStyle}>
        <div style={{ color: "#61584f", fontSize: 11, textAlign: "center", padding: "16px 4px" }}>
          No selection. Drag on the map (Select tool) or use the Wand/Lasso to inspect a region here.
        </div>
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      <SelectionInfoBlock sel={sel} />
      {/* Collapsible ortho view */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div
          onClick={() => setOrthoOpen(v => !v)}
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}
        >
          <span style={{ color: "#61584f", fontSize: 9 }}>{orthoOpen ? "▼" : "▶"}</span>
          <span style={{ color: "#afa69d", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>ORTHO VIEW</span>
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
                      flex: 1, padding: "2px 0", fontSize: 10, cursor: "pointer", border: "none",
                      background: axoDir === d
                        ? "linear-gradient(180deg, rgba(168,85,247,0.35) 0%, rgba(168,85,247,0.10) 100%)"
                        : "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
                      boxShadow: axoDir === d ? "inset 0 0 0 1px #a855f7, 0 .5px .5px rgba(255,255,255,.15)" : "inset 0 0 0 1px rgba(0,0,0,.5)",
                      color: axoDir === d ? "#d8b4fe" : "#83786c", borderRadius: 3,
                    }}
                  >{label}</button>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "#83786c", fontSize: 10, whiteSpace: "nowrap" }}>Depth</span>
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
            style={{ display: "block", width: CW, height: CH, borderRadius: 4, border: "none", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4)" }}
            title={`${view} view — actual block colors`}
          />
        </>)}
      </div>

      {/* Collapsible elevation view — folded in from the old standalone Elevation tab. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div
          onClick={() => setElevationOpen(v => !v)}
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}
        >
          <span style={{ color: "#61584f", fontSize: 9 }}>{elevationOpen ? "▼" : "▶"}</span>
          <span style={{ color: "#afa69d", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>ELEVATION VIEW</span>
        </div>
        {elevationOpen && (
          elevationSelection ? (
            <ElevationPreviewPanel
              selection={elevationSelection}
              maxZ={maxZ}
              width={elevationWidth}
              extrudeCount={extrudeCount}
              extrudeAxis={extrudeAxis}
              isPastePreview={isPastePreview}
              editEpoch={editEpoch}
              drawActive={drawActive}
              onDrawElevation={onDrawElevation}
              onZRangeChange={onZRangeChange}
            />
          ) : (
            <div style={{ color: "#61584f", fontSize: 11, textAlign: "center", padding: "8px 4px" }}>
              No selection. Make a selection to see its front/side elevation.
            </div>
          )
        )}
      </div>

      {clipboard && <ClipboardInfoBlock clipboard={clipboard} />}
    </div>
  );
}
