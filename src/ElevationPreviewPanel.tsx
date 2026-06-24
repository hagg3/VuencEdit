import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SelectionInfo } from "./App";

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
  /** World X of current brush hover position — draws a vertical band highlight. */
  brushHoverX?: number | null;
  /** World Y of current brush hover position — draws a horizontal band highlight. */
  brushHoverY?: number | null;
  /** Called when user drags the z_min or z_max edge handle to resize the selection's z range. */
  onZRangeChange?: (zMin: number, zMax: number) => void;
}

const CONTEXT_BLOCKS = 7;
const LABEL_H = 14;
const INIT_W  = 240;
const INIT_H  = 240;
const MIN_W   = 140;
const MIN_H   = 120;
const MAX_W   = 800;
const MAX_H   = 700;

// Layout tracks the rendered position of the image for hit-testing and overlays.
// ox/oy are absolute canvas coordinates; scale is pixels-per-block (zoom applied).
interface Layout { ox: number; oy: number; scale: number; }

function elevCanvasToWorld(
  cx: number, cy: number,
  layout: Layout,
  view: "front" | "side",
  sel: { x1: number; y1: number; x2: number; y2: number },
  maxZ: number,
): { x: number; y: number; z: number } | null {
  const { ox, oy, scale } = layout;
  const imgCol = Math.floor((cx - ox) / scale);
  const imgRow = Math.floor((cy - oy) / scale);
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

// Draws one elevation section onto the canvas at yStart.
// zoom/pan are applied on top of the fit-to-section base scale.
function drawSection(
  ctx: CanvasRenderingContext2D,
  data: PreviewData | null,
  clipData: PreviewData | null,
  view: "front" | "side",
  layoutRef: { current: Layout },
  yStart: number,
  sectionH: number,
  sectionW: number,
  sel: SelectionInfo,
  maxZ: number,
  extrudeCount: number,
  extrudeAxis: string,
  isPastePreview: boolean,
  zoom: number,
  pan: { x: number; y: number },
) {
  const availH = sectionH - LABEL_H;

  // Clip to this section so zoomed image can't bleed into the other half
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, yStart, sectionW, availH);
  ctx.clip();

  ctx.fillStyle = "#080f1e";
  ctx.fillRect(0, yStart, sectionW, availH);

  let scale = 1, dw = 0, dh = 0, ox = 0, oy = yStart;

  if (data && data.width > 0 && data.height > 0) {
    const off = document.createElement("canvas");
    off.width  = data.width;
    off.height = data.height;
    const offCtx = off.getContext("2d")!;
    const img = offCtx.createImageData(data.width, data.height);
    img.data.set(data.pixels);
    offCtx.putImageData(img, 0, 0);

    const baseScale = Math.min(sectionW / data.width, availH / data.height);
    scale = baseScale * zoom;
    dw = Math.round(data.width  * scale);
    dh = Math.round(data.height * scale);
    ox = Math.round((sectionW - dw) / 2) + pan.x;
    const innerOy = Math.round((availH - dh) / 2) + pan.y;
    oy = yStart + innerOy;
    layoutRef.current = { ox, oy, scale };

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, ox, oy, dw, dh);

    // Z-band highlight
    const hTop = oy + (maxZ - sel.z_max) * scale;
    const hH   = Math.max(1, (sel.z_max - sel.z_min + 1) * scale);
    if (isPastePreview) {
      if (clipData) {
        const clipOff = document.createElement("canvas");
        clipOff.width  = clipData.width;
        clipOff.height = clipData.height;
        const clipOffCtx = clipOff.getContext("2d")!;
        const clipImg = clipOffCtx.createImageData(clipData.width, clipData.height);
        clipImg.data.set(clipData.pixels);
        clipOffCtx.putImageData(clipImg, 0, 0);
        const selAxisSize = view === "front" ? sel.width : sel.height;
        const ctxCols = (data.width - selAxisSize) / 2;
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(clipOff, ox + ctxCols * scale, hTop, selAxisSize * scale, hH);
        ctx.restore();
      } else {
        ctx.fillStyle = "rgba(34, 197, 94, 0.15)";
        ctx.fillRect(ox, hTop, dw, hH);
      }
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "rgba(74, 222, 128, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ox + 0.75, hTop + 0.75, dw - 1.5, hH - 1.5);
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = "rgba(59, 130, 246, 0.22)";
      ctx.fillRect(ox, hTop, dw, hH);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "rgba(147, 197, 253, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ox + 0.75, hTop + 0.75, dw - 1.5, hH - 1.5);
      ctx.setLineDash([]);
    }

    // Z-axis extrude ghost bands
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
        ctx.fillStyle = `rgba(34, 197, 94, ${0.22 - 0.05 * (k - 1)})`;
        ctx.fillRect(ox, ghostTop, dw, ghostH);
        ctx.strokeRect(ox + 0.75, ghostTop + 0.75, dw - 1.5, Math.max(1, ghostH - 1.5));
        drewAny = true;
      }
      ctx.setLineDash([]);
      if (!drewAny) {
        const boundaryY = dir > 0 ? oy : oy + dh;
        ctx.strokeStyle = "rgba(74, 222, 128, 0.4)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(ox, boundaryY);
        ctx.lineTo(ox + dw, boundaryY);
        ctx.stroke();
        ctx.setLineDash([]);
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

  ctx.restore(); // release clip

  // Label bar (outside clip so it always renders at section bottom)
  const labelY = yStart + sectionH - LABEL_H;
  const viewLabel = view === "front" ? "Front X-Z" : "Side Y-Z";
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(0, labelY, sectionW, LABEL_H);
  ctx.fillStyle = "#7dd3fc";
  ctx.font = "7px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(
    `${viewLabel}  ±${CONTEXT_BLOCKS}ctx  ·  ${isPastePreview ? "paste" : "sel"} z${sel.z_min}–${sel.z_max} / 0–${maxZ}`,
    3, labelY + LABEL_H / 2,
  );
}

const Z_EDGE_HIT = 5; // pixels proximity to trigger z-resize handle

export default function ElevationPreviewPanel({
  selection: sel, maxZ,
  extrudeCount = 0, extrudeAxis = "z+",
  isPastePreview = false, editEpoch = 0,
  drawActive = false, onDrawElevation,
  brushHoverX = null, brushHoverY = null,
  onZRangeChange,
}: Props) {
  const [frontData,     setFrontData]     = useState<PreviewData | null>(null);
  const [sideData,      setSideData]      = useState<PreviewData | null>(null);
  const [clipFrontData, setClipFrontData] = useState<PreviewData | null>(null);
  const [clipSideData,  setClipSideData]  = useState<PreviewData | null>(null);
  const [canvasW, setCanvasW] = useState(INIT_W);
  const [canvasH, setCanvasH] = useState(INIT_H);
  const [showContext, setShowContext] = useState(true);

  // Zoom/pan live in refs so event handlers always see current values.
  // viewTick increments trigger the canvas draw effect.
  const zoomRef      = useRef(1.0);
  const panFrontRef  = useRef({ x: 0, y: 0 });
  const panSideRef   = useRef({ x: 0, y: 0 });
  const [viewTick, setViewTick] = useState(0);
  const [zoom, setZoom] = useState(1.0); // mirrored for display only
  const triggerRedraw = () => setViewTick(t => t + 1);

  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const frontLayoutRef  = useRef<Layout>({ ox: 0, oy: 0, scale: 1 });
  const sideLayoutRef   = useRef<Layout>({ ox: 0, oy: 0, scale: 1 });
  const drawViewRef     = useRef<"front" | "side">("front");
  const drawStrokeRef   = useRef<{ x: number; y: number; z: number }[]>([]);
  const resizeDragRef   = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
  const viewDragRef     = useRef<{ section: "front"|"side"; startX: number; startY: number; startPanX: number; startPanY: number } | null>(null);
  const zResizeDragRef  = useRef<{ edge: "z_max" | "z_min"; startY: number; startZ: number; scale: number } | null>(null);
  const [canvasCursor, setCanvasCursor] = useState<string>("default");

  // Fetch front view
  useEffect(() => {
    const timer = setTimeout(() => {
      invoke<PreviewDataRaw>("render_full_height_view", {
        x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2,
        view: "front", contextBlocks: showContext ? CONTEXT_BLOCKS : 0,
      })
        .then(raw => setFrontData({ ...raw, pixels: decodePixels(raw.pixels) }))
        .catch(() => setFrontData(null));
    }, 150);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.x1, sel.y1, sel.x2, sel.y2, showContext, editEpoch]);

  // Fetch side view
  useEffect(() => {
    const timer = setTimeout(() => {
      invoke<PreviewDataRaw>("render_full_height_view", {
        x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2,
        view: "side", contextBlocks: showContext ? CONTEXT_BLOCKS : 0,
      })
        .then(raw => setSideData({ ...raw, pixels: decodePixels(raw.pixels) }))
        .catch(() => setSideData(null));
    }, 150);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.x1, sel.y1, sel.x2, sel.y2, showContext, editEpoch]);

  // Fetch clipboard elevation ghosts
  useEffect(() => {
    if (!isPastePreview) { setClipFrontData(null); return; }
    invoke<PreviewDataRaw>("render_clipboard_elevation_preview", { view: "front" })
      .then(raw => setClipFrontData({ ...raw, pixels: decodePixels(raw.pixels) }))
      .catch(() => setClipFrontData(null));
  }, [isPastePreview]);

  useEffect(() => {
    if (!isPastePreview) { setClipSideData(null); return; }
    invoke<PreviewDataRaw>("render_clipboard_elevation_preview", { view: "side" })
      .then(raw => setClipSideData({ ...raw, pixels: decodePixels(raw.pixels) }))
      .catch(() => setClipSideData(null));
  }, [isPastePreview]);

  // Draw both sections on single canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#080f1e";
    ctx.fillRect(0, 0, canvasW, canvasH);

    const topH = Math.floor(canvasH / 2);
    const botH = canvasH - topH;
    const z = zoomRef.current;

    drawSection(ctx, frontData, clipFrontData, "front", frontLayoutRef, 0, topH, canvasW, sel, maxZ, extrudeCount, extrudeAxis, isPastePreview, z, panFrontRef.current);
    drawSection(ctx, sideData, clipSideData, "side", sideLayoutRef, topH, botH, canvasW, sel, maxZ, extrudeCount, extrudeAxis, isPastePreview, z, panSideRef.current);

    // Brush hover bands
    if (brushHoverX !== null) {
      const fl = frontLayoutRef.current;
      const cx = Math.round((brushHoverX - sel.x1) * fl.scale + fl.ox);
      if (cx >= 0 && cx <= canvasW) {
        ctx.fillStyle = "rgba(251,146,60,0.25)";
        ctx.fillRect(cx, 0, Math.max(1, fl.scale), topH);
      }
    }
    if (brushHoverY !== null) {
      const sl = sideLayoutRef.current;
      const cy = Math.round((brushHoverY - sel.y1) * sl.scale + sl.ox);
      if (cy >= 0 && cy <= canvasW) {
        ctx.fillStyle = "rgba(251,146,60,0.25)";
        ctx.fillRect(cy, topH, Math.max(1, sl.scale), botH);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontData, sideData, clipFrontData, clipSideData, sel.z_min, sel.z_max, sel.width, sel.height, maxZ, canvasW, canvasH, extrudeCount, extrudeAxis, isPastePreview, brushHoverX, brushHoverY, viewTick]);

  function resetZoomPan() {
    zoomRef.current = 1.0;
    panFrontRef.current = { x: 0, y: 0 };
    panSideRef.current  = { x: 0, y: 0 };
    setZoom(1.0);
    triggerRedraw();
  }

  // Returns which z edge (if any) the canvas y is close to, based on which section is active.
  function hitZEdge(cy: number): { edge: "z_max" | "z_min"; scale: number } | null {
    if (!onZRangeChange) return null;
    const topH = Math.floor(canvasH / 2);
    const layout = cy < topH ? frontLayoutRef.current : sideLayoutRef.current;
    const { oy, scale } = layout;
    const zMaxY = oy + (maxZ - sel.z_max) * scale;
    const zMinY = oy + (maxZ - sel.z_min + 1) * scale;
    if (Math.abs(cy - zMaxY) <= Z_EDGE_HIT) return { edge: "z_max", scale };
    if (Math.abs(cy - zMinY) <= Z_EDGE_HIT) return { edge: "z_min", scale };
    return null;
  }

  return (
    <div style={{
      position: "absolute",
      bottom: 16, right: 12,
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
      {/* Resize handle */}
      <div
        style={{
          position: "absolute", top: 2, left: 2,
          width: 14, height: 14, cursor: "nwse-resize",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#475569", fontSize: 9, lineHeight: 1, borderRadius: 2,
        }}
        onPointerDown={(e) => {
          resizeDragRef.current = { startX: e.clientX, startY: e.clientY, startW: canvasW, startH: canvasH };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          e.preventDefault();
        }}
        onPointerMove={(e) => {
          const drag = resizeDragRef.current;
          if (!drag) return;
          const dx = drag.startX - e.clientX;
          const dy = drag.startY - e.clientY;
          setCanvasW(Math.max(MIN_W, Math.min(MAX_W, drag.startW + dx)));
          setCanvasH(Math.max(MIN_H, Math.min(MAX_H, drag.startH + dy)));
        }}
        onPointerUp={() => { resizeDragRef.current = null; }}
      >◤</div>

      <div style={{ display: "flex", alignItems: "center", paddingLeft: 14 }}>
        <span style={{ color: "#93c5fd", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>ELEVATION VIEW</span>
        {zoom !== 1.0 && (
          <button
            onClick={resetZoomPan}
            style={{
              marginLeft: 6, padding: "1px 5px", fontSize: 9, cursor: "pointer",
              background: "rgba(99,102,241,0.2)", border: "1px solid #6366f1",
              color: "#a5b4fc", borderRadius: 3,
            }}
            title="Reset zoom and pan"
          >{zoom.toFixed(1)}× ✕</button>
        )}
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
          display: "block", width: canvasW, height: canvasH,
          borderRadius: 4, border: "1px solid #1a2744",
          cursor: canvasCursor !== "default" ? canvasCursor : drawActive ? "crosshair" : zoom > 1 ? "grab" : "default",
        }}
        title={`Elevation view — front (top) + side (bottom), ±${CONTEXT_BLOCKS} context blocks, z${sel.z_min}–${sel.z_max} highlighted. Scroll to zoom, drag to pan.`}
        onWheel={(e) => {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
          const oldZoom = zoomRef.current;
          const newZoom = Math.max(1, Math.min(8, oldZoom * factor));
          if (newZoom === oldZoom) return;

          // Scale pan proportionally so the center stays fixed while zooming.
          // Users can drag to reposition after zooming in.
          const ratio = newZoom / oldZoom;
          panFrontRef.current = { x: panFrontRef.current.x * ratio, y: panFrontRef.current.y * ratio };
          panSideRef.current  = { x: panSideRef.current.x  * ratio, y: panSideRef.current.y  * ratio };
          if (newZoom === 1) {
            panFrontRef.current = { x: 0, y: 0 };
            panSideRef.current  = { x: 0, y: 0 };
          }
          zoomRef.current = newZoom;
          setZoom(newZoom);
          triggerRedraw();
        }}
        onPointerDown={(e) => {
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
          const cy = e.clientY - rect.top;
          // Z-edge resize takes priority over draw/pan
          const zHit = hitZEdge(cy);
          if (zHit) {
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            const startZ = zHit.edge === "z_max" ? sel.z_max : sel.z_min;
            zResizeDragRef.current = { edge: zHit.edge, startY: cy, startZ, scale: zHit.scale };
            return;
          }
          if (drawActive && onDrawElevation) {
            const topH = Math.floor(canvasH / 2);
            const view = cy < topH ? "front" : "side";
            const layout = view === "front" ? frontLayoutRef.current : sideLayoutRef.current;
            const data = view === "front" ? frontData : sideData;
            if (!data) return;
            drawViewRef.current = view;
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            drawStrokeRef.current = [];
            const pos = elevCanvasToWorld(e.clientX - rect.left, cy, layout, view, sel, maxZ);
            if (pos) drawStrokeRef.current.push(pos);
          } else {
            // Pan mode
            const topH = Math.floor(canvasH / 2);
            const section = cy < topH ? "front" : "side";
            const panRef = section === "front" ? panFrontRef : panSideRef;
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            viewDragRef.current = {
              section,
              startX: e.clientX, startY: e.clientY,
              startPanX: panRef.current.x, startPanY: panRef.current.y,
            };
          }
        }}
        onPointerMove={(e) => {
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
          const cy = e.clientY - rect.top;
          // Z-resize drag
          if (zResizeDragRef.current) {
            const { edge, startY, startZ, scale } = zResizeDragRef.current;
            const dz = Math.round((startY - cy) / scale);
            const newZ = Math.max(0, Math.min(maxZ, startZ + dz));
            if (edge === "z_max") {
              onZRangeChange?.(Math.min(sel.z_min, newZ), newZ);
            } else {
              onZRangeChange?.(newZ, Math.max(sel.z_max, newZ));
            }
            return;
          }
          // Update cursor for z-edge proximity
          if (e.buttons === 0) {
            const zHit = hitZEdge(cy);
            setCanvasCursor(zHit ? "ns-resize" : "default");
          }
          if (drawActive && onDrawElevation) {
            if (e.buttons === 0) return;
            const view = drawViewRef.current;
            const layout = view === "front" ? frontLayoutRef.current : sideLayoutRef.current;
            const data = view === "front" ? frontData : sideData;
            if (!data) return;
            const pos = elevCanvasToWorld(e.clientX - rect.left, cy, layout, view, sel, maxZ);
            if (pos) {
              const last = drawStrokeRef.current[drawStrokeRef.current.length - 1];
              if (!last || last.x !== pos.x || last.y !== pos.y || last.z !== pos.z)
                drawStrokeRef.current.push(pos);
            }
          } else {
            const drag = viewDragRef.current;
            if (!drag || e.buttons === 0) return;
            const panRef = drag.section === "front" ? panFrontRef : panSideRef;
            panRef.current = {
              x: drag.startPanX + (e.clientX - drag.startX),
              y: drag.startPanY + (e.clientY - drag.startY),
            };
            triggerRedraw();
          }
        }}
        onPointerUp={(e) => {
          if (zResizeDragRef.current) {
            zResizeDragRef.current = null;
            return;
          }
          if (drawActive && onDrawElevation) {
            for (const p of drawStrokeRef.current) onDrawElevation(p.x, p.y, p.z);
            drawStrokeRef.current = [];
          } else {
            viewDragRef.current = null;
          }
          void e;
        }}
        onPointerLeave={() => setCanvasCursor("default")}
      />
    </div>
  );
}
