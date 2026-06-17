import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SelectionInfo } from "./App";

type ElevView = "front" | "side";

interface PreviewDataRaw {
  width: number;
  height: number;
  pixels: string; // base64 RGBA
}

interface PreviewData {
  width: number;
  height: number;
  pixels: Uint8Array;
}

function decodePixels(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

interface Props {
  selection: SelectionInfo;
  maxZ: number;
  extrudeCount?: number;
  extrudeAxis?: string;
  isPastePreview?: boolean;
  editEpoch?: number;
  drawActive?: boolean;
  onDrawElevation?: (x: number, y: number, z: number) => void;
}

const CONTEXT_BLOCKS = 7;
const LABEL_H = 16;

function elevCanvasToWorld(
  cx: number, cy: number,
  layout: { ox: number; oy: number; scale: number },
  view: "front" | "side",
  sel: { x1: number; y1: number; x2: number; y2: number },
  maxZ: number,
): { x: number; y: number; z: number } | null {
  const { ox, oy, scale } = layout;
  const imgCol = Math.floor((cx - ox) / scale);
  const imgRow = Math.floor((cy - oy) / scale);
  // Image column 0 = sel.x1 - CONTEXT_BLOCKS (front) or sel.y1 - CONTEXT_BLOCKS (side).
  // Image row 0 = z=maxZ (top), row height-1 = z=0 (bottom).
  const worldZ = maxZ - imgRow;
  if (worldZ < 0 || worldZ > maxZ) return null;
  if (view === "front") {
    const worldX = sel.x1 - CONTEXT_BLOCKS + imgCol;
    if (worldX < sel.x1 || worldX > sel.x2) return null;
    return { x: worldX, y: sel.y1, z: worldZ };
  } else {
    const worldY = sel.y1 - CONTEXT_BLOCKS + imgCol;
    if (worldY < sel.y1 || worldY > sel.y2) return null;
    return { x: sel.x1, y: worldY, z: worldZ };
  }
}
const INIT_W  = 240;
const INIT_H  = 180;
const MIN_W   = 140;
const MIN_H   = 100;
const MAX_W   = 800;
const MAX_H   = 600;

export default function ElevationPreviewPanel({ selection: sel, maxZ, extrudeCount = 0, extrudeAxis = "z+", isPastePreview = false, editEpoch = 0, drawActive = false, onDrawElevation }: Props) {
  const [view, setView]               = useState<ElevView>("front");
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [clipElevData, setClipElevData] = useState<PreviewData | null>(null);
  const [canvasW, setCanvasW]         = useState(INIT_W);
  const [canvasH, setCanvasH]         = useState(INIT_H);
  const [showContext, setShowContext]  = useState(true);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const resizeDragRef = useRef<{
    startX: number; startY: number; startW: number; startH: number;
  } | null>(null);
  // Stores rendered image geometry for pointer-to-world coordinate conversion.
  const layoutRef = useRef({ ox: 0, oy: 0, scale: 1 });
  // Accumulates draw stroke positions while pointer is held down.
  const drawStrokeRef = useRef<{ x: number; y: number; z: number }[]>([]);

  // Fetch full-height terrain view whenever XY footprint, view tab, context, or edit changes.
  useEffect(() => {
    const timer = setTimeout(() => {
      invoke<PreviewDataRaw>("render_full_height_view", {
        x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2,
        view,
        contextBlocks: showContext ? CONTEXT_BLOCKS : 0,
      })
        .then((raw) => setPreviewData({ ...raw, pixels: decodePixels(raw.pixels) }))
        .catch(() => setPreviewData(null));
    }, 150);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.x1, sel.y1, sel.x2, sel.y2, view, showContext, editEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch clipboard elevation ghost when in paste preview mode.
  useEffect(() => {
    if (!isPastePreview) { setClipElevData(null); return; }
    invoke<PreviewDataRaw>("render_clipboard_elevation_preview", { view })
      .then((raw) => setClipElevData({ ...raw, pixels: decodePixels(raw.pixels) }))
      .catch(() => setClipElevData(null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPastePreview, view]);

  // Redraw canvas when image data, z-range, or canvas size changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#080f1e";
    ctx.fillRect(0, 0, canvasW, canvasH);

    const availH = canvasH - LABEL_H;
    let scale = 1, dw = 0, dh = 0, ox = 0, oy = 0;

    if (previewData && previewData.width > 0 && previewData.height > 0) {
      const off = document.createElement("canvas");
      off.width  = previewData.width;
      off.height = previewData.height;
      const offCtx = off.getContext("2d")!;
      const img = offCtx.createImageData(previewData.width, previewData.height);
      img.data.set(previewData.pixels);
      offCtx.putImageData(img, 0, 0);

      scale = Math.min(canvasW / previewData.width, availH / previewData.height);
      dw = Math.round(previewData.width  * scale);
      dh = Math.round(previewData.height * scale);
      ox = Math.round((canvasW - dw) / 2);
      oy = Math.round((availH  - dh) / 2);
      layoutRef.current = { ox, oy, scale };

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, ox, oy, dw, dh);

      // Z-band: green for paste destination, blue for selection.
      const hTop = oy + (maxZ - sel.z_max) * scale;
      const hH   = Math.max(1, (sel.z_max - sel.z_min + 1) * scale);
      if (isPastePreview) {
        if (clipElevData) {
          // Draw clipboard ghost at paste z position (transparent air pixels show terrain).
          const clipOff = document.createElement("canvas");
          clipOff.width  = clipElevData.width;
          clipOff.height = clipElevData.height;
          const clipOffCtx = clipOff.getContext("2d")!;
          const clipImg = clipOffCtx.createImageData(clipElevData.width, clipElevData.height);
          clipImg.data.set(clipElevData.pixels);
          clipOffCtx.putImageData(clipImg, 0, 0);
          // Horizontal: the selection content starts after context columns in the image.
          const selAxisSize = view === "front" ? sel.width : sel.height;
          const ctxCols = (previewData.width - selAxisSize) / 2;
          ctx.save();
          ctx.globalAlpha = 0.55;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(clipOff, ox + ctxCols * scale, hTop, selAxisSize * scale, hH);
          ctx.restore();
        } else {
          // Loading — placeholder tint
          ctx.fillStyle = "rgba(34, 197, 94, 0.15)";
          ctx.fillRect(ox, hTop, dw, hH);
        }
        // Dashed green border around paste zone (no fill on top of ghost)
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(74, 222, 128, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ox + 0.75, hTop + 0.75, dw - 1.5, hH - 1.5);
        ctx.setLineDash([]);
      } else {
        // Selection mode: blue fill + dashed stroke
        ctx.fillStyle = "rgba(59, 130, 246, 0.22)";
        ctx.fillRect(ox, hTop, dw, hH);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(147, 197, 253, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ox + 0.75, hTop + 0.75, dw - 1.5, hH - 1.5);
        ctx.setLineDash([]);
      }

      // Ghost bands: preview of where extrude copies will land (z-axis only).
      if (extrudeCount > 0 && (extrudeAxis === "z+" || extrudeAxis === "z-")) {
        const depth = sel.z_max - sel.z_min + 1;
        const dir   = extrudeAxis === "z+" ? 1 : -1;
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(74, 222, 128, 0.85)";
        ctx.lineWidth = 1.5;
        let drewAny = false;
        for (let k = 1; k <= extrudeCount; k++) {
          const copyZMin = sel.z_min + dir * k * depth;
          const copyZMax = sel.z_max + dir * k * depth;
          if (copyZMax < 0 || copyZMin > maxZ) break;
          const clampedMax = Math.min(copyZMax, maxZ);
          const clampedMin = Math.max(copyZMin, 0);
          const ghostTop = oy + (maxZ - clampedMax) * scale;
          const ghostH   = Math.max(2, (clampedMax - clampedMin + 1) * scale);
          // Fill: first copy brightest (22%), fade for subsequent
          ctx.fillStyle = `rgba(34, 197, 94, ${0.22 - 0.05 * (k - 1)})`;
          ctx.fillRect(ox, ghostTop, dw, ghostH);
          ctx.strokeRect(ox + 0.75, ghostTop + 0.75, dw - 1.5, Math.max(1, ghostH - 1.5));
          drewAny = true;
        }
        ctx.setLineDash([]);
        // When all copies land out of bounds, draw a faint boundary caret so
        // the user knows the panel is working (copies just don't fit in world).
        if (!drewAny) {
          const boundaryY = dir > 0
            ? oy                      // top of image = z=maxZ
            : oy + dh;                // bottom of image = z=0
          ctx.strokeStyle = "rgba(74, 222, 128, 0.4)";
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 4]);
          ctx.beginPath();
          ctx.moveTo(ox, boundaryY);
          ctx.lineTo(ox + dw, boundaryY);
          ctx.stroke();
          ctx.setLineDash([]);
          // Small label
          ctx.fillStyle = "rgba(74, 222, 128, 0.5)";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = dir > 0 ? "bottom" : "top";
          ctx.fillText(`z${dir > 0 ? "+" : "-"} OOB`, ox + dw / 2, boundaryY + (dir > 0 ? -2 : 2));
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
        }
      }
    }

    // Label bar
    const viewLabel = view === "front" ? "Full Front X-Z" : "Full Side Y-Z";
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, canvasH - LABEL_H, canvasW, LABEL_H);
    ctx.fillStyle = "#7dd3fc";
    ctx.font = "7px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const bandLabel = isPastePreview ? "paste" : "sel";
    ctx.fillText(
      `${viewLabel}  ±${CONTEXT_BLOCKS}ctx  ·  ${bandLabel} z${sel.z_min}–${sel.z_max} / 0–${maxZ}`,
      3, canvasH - LABEL_H / 2,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewData, clipElevData, view, sel.z_min, sel.z_max, sel.width, sel.height, maxZ, canvasW, canvasH, extrudeCount, extrudeAxis, isPastePreview]);

  const tabBtn = (v: ElevView): React.CSSProperties => ({
    flex: 1, padding: "2px 0", fontSize: 11, cursor: "pointer",
    background: view === v ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${view === v ? "#3b82f6" : "#334155"}`,
    color: view === v ? "#93c5fd" : "#64748b",
    borderRadius: 3,
  });

  return (
    <div style={{
      position: "absolute",
      bottom: 16,
      right: 12,
      background: "rgba(5,12,26,0.85)",
      border: "1px solid #1e40af",
      borderRadius: 7,
      padding: "8px 10px",
      fontSize: 12,
      color: "#e2e8f0",
      width: canvasW,
      display: "flex",
      flexDirection: "column",
      gap: 6,
      userSelect: "none",
    }}>

      {/* Resize handle at top-left corner — drag to enlarge or shrink the panel */}
      <div
        style={{
          position: "absolute",
          top: 2, left: 2,
          width: 14, height: 14,
          cursor: "nwse-resize",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#475569",
          fontSize: 9,
          lineHeight: 1,
          borderRadius: 2,
        }}
        onPointerDown={(e) => {
          resizeDragRef.current = {
            startX: e.clientX, startY: e.clientY,
            startW: canvasW, startH: canvasH,
          };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          e.preventDefault();
        }}
        onPointerMove={(e) => {
          const drag = resizeDragRef.current;
          if (!drag) return;
          // Dragging left/up expands the panel (anchored bottom-right).
          const dx = drag.startX - e.clientX;
          const dy = drag.startY - e.clientY;
          setCanvasW(Math.max(MIN_W, Math.min(MAX_W, drag.startW + dx)));
          setCanvasH(Math.max(MIN_H, Math.min(MAX_H, drag.startH + dy)));
        }}
        onPointerUp={() => { resizeDragRef.current = null; }}
      >
        ◤
      </div>

      <div style={{ color: "#93c5fd", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em", paddingLeft: 14 }}>
        ELEVATION VIEW
      </div>
      <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
        {(["front", "side"] as ElevView[]).map((v) => (
          <button key={v} style={tabBtn(v)} onClick={() => setView(v)}>
            {v.charAt(0).toUpperCase() + v.slice(1)}
          </button>
        ))}
        <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={showContext}
            onChange={e => setShowContext(e.target.checked)}
            style={{ accentColor: "#3b82f6" }}
          />
          <span style={{ color: "#64748b", fontSize: 10, whiteSpace: "nowrap" }}>±ctx</span>
        </label>
      </div>
      <canvas
        ref={canvasRef}
        width={canvasW}
        height={canvasH}
        style={{
          display: "block", width: canvasW, height: canvasH, borderRadius: 4,
          border: "1px solid #1a2744",
          cursor: drawActive ? "crosshair" : "default",
        }}
        title={`${view} view — full height 0..${maxZ}, highlighted: z${sel.z_min}–${sel.z_max}, ±${CONTEXT_BLOCKS} context blocks at 50% opacity`}
        onPointerDown={drawActive && onDrawElevation ? (e) => {
          if (!previewData) return;
          (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
          drawStrokeRef.current = [];
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
          const pos = elevCanvasToWorld(e.clientX - rect.left, e.clientY - rect.top, layoutRef.current, view, sel, maxZ);
          if (pos) drawStrokeRef.current.push(pos);
        } : undefined}
        onPointerMove={drawActive && onDrawElevation ? (e) => {
          if (e.buttons === 0 || !previewData) return;
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
          const pos = elevCanvasToWorld(e.clientX - rect.left, e.clientY - rect.top, layoutRef.current, view, sel, maxZ);
          if (pos) {
            const last = drawStrokeRef.current[drawStrokeRef.current.length - 1];
            if (!last || last.x !== pos.x || last.y !== pos.y || last.z !== pos.z)
              drawStrokeRef.current.push(pos);
          }
        } : undefined}
        onPointerUp={drawActive && onDrawElevation ? () => {
          for (const p of drawStrokeRef.current) onDrawElevation(p.x, p.y, p.z);
          drawStrokeRef.current = [];
        } : undefined}
      />
    </div>
  );
}
