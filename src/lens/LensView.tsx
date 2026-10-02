/**
 * The Lens's image viewer (Stage 20.4, `lens-window-plan-2026-10-01.md` §3): one canvas showing one
 * view (an elevation or the Top tab) with its Z ruler and overlays. Used by both Lens modes. Paste
 * mode is fit-only, with the ghost-bottom line. Selection mode adds zoom/pan, the z band and its edge
 * handles, draw-on-elevation, the map-cursor column, extrude bands and the footprint edges.
 *
 * **Imperative.** Everything that changes at pointer rate (pan, zoom, hover, a z-edge drag, a draw
 * stroke, the map cursor) lives in refs and repaints on rAF. React only re-renders this component
 * when its props change (a new image, a committed z range). The coordinate math is `lensViewMath.ts`.
 *
 * Front and side share one zoom and the live z of a drag through a `LensLink`, so dragging an edge
 * in one view moves the band in the other on the same frame.
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  bandRect, blocksH, blocksW, canvasToCell, cellToCanvas, dragZ, extrudeOverlay, fitLayout,
  footprintEdges, hoverColumn, layoutFor, rulerSteps, zAtEdge, zEdgeHit, zEdges, zoomAbout,
  ZOOM_STEP, type ImageGeom, type Layout, type Pt,
} from "./lensViewMath";
import { beginFrame, resizeCanvasToContainer } from "../viewportUtils";
import { ACCENT, FONT, TEXT_META } from "../ribbon/tokens";
import { MAP, RAMP, rgba } from "../theme/theme";

export interface LensViewImage extends ImageGeom {
  /** RGBA, row-major, `width × height`. A view over the IPC response (audit H2), never copied. */
  pixels: Uint8Array;
}

// ── Shared zoom + live z between the views of one Lens ───────────────────────────────────────

export type LensLinkEvent =
  | { type: "zoom"; prev: number; next: number; from: object | null }
  | { type: "z" };

export interface LensLink {
  zoom: number;
  /** The z range while an edge is being dragged (in any view), else null: the views draw this
   *  instead of their `zMin`/`zMax` props, which only catch up at ≤ 15 Hz. */
  liveZ: { zMin: number; zMax: number } | null;
  setZoom(next: number, from: object | null): void;
  setLiveZ(z: { zMin: number; zMax: number } | null): void;
  subscribe(fn: (e: LensLinkEvent) => void): () => void;
}

export function createLensLink(): LensLink {
  const subs = new Set<(e: LensLinkEvent) => void>();
  const link: LensLink = {
    zoom: 1,
    liveZ: null,
    setZoom(next, from) {
      const prev = link.zoom;
      if (prev === next) return;
      link.zoom = next;
      for (const fn of subs) fn({ type: "zoom", prev, next, from });
    },
    setLiveZ(z) {
      link.liveZ = z;
      for (const fn of subs) fn({ type: "z" });
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
  return link;
}

// ── Props ────────────────────────────────────────────────────────────────────────────────────

/** Selection mode's interactive layer. Absent = paste mode (fit-only, no gestures). */
export interface LensViewSelection {
  link: LensLink;
  zMin: number;
  zMax: number;
  maxZ: number;
  /** Elevations: the rows to fit on open (`frameRows`). Reframes when this changes by value. Grows
   *  (and stays grown) when the top edge is dragged above it. Null = fit the whole image. */
  frame: { lo: number; hi: number } | null;
  /** The selection along the image's columns (and, on the Top tab, its rows). */
  footprint: { lo: number; hi: number };
  footprintRows?: { lo: number; hi: number };
  /** z± extrude bands (elevations only). */
  extrude: { count: number; dir: 1 | -1 } | null;
  /** Edge-handle drags. Called at ≤ 15 Hz while dragging (only when the value changes), once more on
   *  release, and with the start values on Esc. Omit for no handles (the Top tab). */
  onZRange?: (zMin: number, zMax: number) => void;
  drawActive: boolean;
  /** A finished draw stroke: the cells (`col`, `row` = z) in drawing order, inside the footprint. */
  onStroke?: (cells: { col: number; row: number }[]) => void;
}

export interface LensViewProps {
  label: string;
  image: LensViewImage | null;
  /** Draw the Z ruler gutter (elevations). */
  ruler: boolean;
  /** Paste mode: the ghost's bottom z, drawn as a dashed line under it. */
  ghostZMin?: number | null;
  sel?: LensViewSelection;
  title?: string;
}

export interface LensViewHandle {
  /** The map cursor's world column along this view's axis, or null. Repaints on rAF. */
  setHover(col: number | null): void;
}

/** Left gutter reserved for the ruler. */
const RULER_W = 24;
/** App z-range updates while an edge is dragged: ≤ 15 Hz (the 19.2 idiom). */
const Z_COMMIT_MS = 66;

type Gesture =
  | { kind: "z"; edge: "max" | "min"; pointerId: number; grab: number; start: { zMin: number; zMax: number } }
  | { kind: "draw"; pointerId: number; cells: { col: number; row: number }[]; seen: Set<string> }
  | { kind: "pan"; pointerId: number; sx: number; sy: number; start: Pt };

const LensView = forwardRef<LensViewHandle, LensViewProps>(function LensView(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const panRef = useRef<Pt>({ x: 0, y: 0 });
  const hoverColRef = useRef<number | null>(null);
  const hoverEdgeRef = useRef<"max" | "min" | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  /** The Esc listener added for the live gesture (a stable identity, so it's the one removed). */
  const keyListenerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  /** The top of the frame after a drag grew it, and the frame it grew from. */
  const grownRef = useRef<{ base: { lo: number; hi: number } | null; hi: number | null }>({ base: null, hi: null });
  const lastLayoutRef = useRef<{ fit: Layout; L: Layout; avail: { x: number; y: number; w: number; h: number } } | null>(null);
  const zCommitRef = useRef<{ sent: string; at: number; timer: ReturnType<typeof setTimeout> | null; next: { zMin: number; zMax: number } | null }>(
    { sent: "", at: 0, timer: null, next: null });

  function requestDraw() {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => { rafRef.current = null; draw(); });
  }

  useImperativeHandle(ref, () => ({
    setHover(col) {
      if (hoverColRef.current === col) return;
      hoverColRef.current = col;
      requestDraw();
    },
    // `requestDraw` reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // Props → ref (read by the rAF draw and the pointer handlers) + a repaint.
  useLayoutEffect(() => {
    const prev = propsRef.current;
    propsRef.current = props;
    // Keyed on the pixel buffer, not the image object: callers build `LensViewImage`s inline.
    if (prev.image?.pixels !== props.image?.pixels || !offRef.current) offRef.current = buildOffscreen(props.image);
    const f = props.sel?.frame ?? null;
    const g = grownRef.current;
    if (!sameFrame(g.base, f)) grownRef.current = { base: f, hi: null };
    requestDraw();
  });

  // Identity token for "this view" in zoom events.
  const [self] = useState<object>(() => ({}));

  // Shared zoom / live z from the other view(s).
  const link = props.sel?.link ?? null;
  useEffect(() => {
    if (!link) return;
    return link.subscribe(e => {
      if (e.type === "zoom" && e.from !== self) {
        const last = lastLayoutRef.current;
        if (last && e.next !== 1) {
          const c = { x: last.avail.x + last.avail.w / 2, y: last.avail.y + last.avail.h / 2 };
          panRef.current = zoomAbout(last.fit, e.prev, panRef.current, c, e.next).pan;
        } else panRef.current = { x: 0, y: 0 };
      }
      requestDraw();
    });
    // `requestDraw` reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, self]);
  // Repaint on resize (a row ⇄ column swap changes the box without changing any prop).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => { if (resizeCanvasToContainer(canvas)) draw(); });
    ro.observe(canvas);
    return () => ro.disconnect();
    // `draw` reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nulled, not just cancelled: StrictMode remounts with the same refs, and a stale id would make
  // `requestDraw` think a frame is still pending forever.
  useEffect(() => () => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (keyListenerRef.current) { window.removeEventListener("keydown", keyListenerRef.current, true); keyListenerRef.current = null; }
    const zc = zCommitRef.current;
    if (zc.timer) { clearTimeout(zc.timer); zc.timer = null; }
  }, []);

  // ── Geometry ─────────────────────────────────────────────────────────────────────────────

  function effectiveFrame(): { lo: number; hi: number } | null {
    const f = propsRef.current.sel?.frame ?? null;
    if (!f) return null;
    const grown = grownRef.current.hi;
    return grown != null && grown > f.hi ? { lo: f.lo, hi: grown } : f;
  }

  function layout(cw: number, ch: number, g: ImageGeom) {
    const p = propsRef.current;
    const gutter = p.ruler ? RULER_W : 0;
    const avail = { x: gutter, y: 0, w: Math.max(1, cw - gutter), h: Math.max(1, ch) };
    const fit = fitLayout(g, avail, effectiveFrame());
    const zoom = p.sel ? p.sel.link.zoom : 1;
    const L = p.sel ? layoutFor(fit, zoom, panRef.current) : fit;
    lastLayoutRef.current = { fit, L, avail };
    return { fit, L, avail };
  }

  /** The z range to draw: a drag's live value, else the props. */
  function shownZ(): { zMin: number; zMax: number } | null {
    const s = propsRef.current.sel;
    if (!s) return null;
    return s.link.liveZ ?? { zMin: s.zMin, zMax: s.zMax };
  }

  // ── Paint ────────────────────────────────────────────────────────────────────────────────

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    resizeCanvasToContainer(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w: cw, h: ch } = beginFrame(ctx, canvas);
    const p = propsRef.current;
    const g = p.image;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = RAMP.mapBg;
    ctx.fillRect(0, 0, cw, ch);
    if (!g || g.width <= 0 || g.height <= 0 || cw <= 1 || ch <= 1) { lastLayoutRef.current = null; return; }
    const { L, avail } = layout(cw, ch, g);
    const dw = blocksW(g) * L.scale, dh = blocksH(g) * L.scale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(avail.x, avail.y, avail.w, avail.h);
    ctx.clip();
    const off = offRef.current;
    if (off) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, g.width, g.height, L.ox, L.oy, dw, dh);
    }
    if (p.sel) drawSelectionOverlays(ctx, g, L, avail, p.sel);
    if (p.ghostZMin != null) {
      // Dashed line at the ghost's bottom: the lowest row any pasted cell can land on.
      const y = cellToCanvas(g, L, g.colLo, p.ghostZMin).y + L.scale;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = ACCENT.clipboard;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L.ox, y);
      ctx.lineTo(L.ox + dw, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    if (p.ruler) drawRuler(ctx, g, L, ch);
  }

  function drawSelectionOverlays(
    ctx: CanvasRenderingContext2D, g: ImageGeom, L: Layout,
    avail: { x: number; y: number; w: number; h: number }, s: LensViewSelection,
  ) {
    const dh = blocksH(g) * L.scale;
    const z = shownZ()!;

    // Footprint: the selection's edges against the context columns (a rectangle on the Top tab).
    const [fx0, fx1] = footprintEdges(g, L, s.footprint.lo, s.footprint.hi);
    ctx.strokeStyle = rgba(MAP.selection, 0.85);
    ctx.lineWidth = 1;
    if (g.rowDown && s.footprintRows) {
      const y0 = cellToCanvas(g, L, g.colLo, s.footprintRows.lo).y;
      const y1 = cellToCanvas(g, L, g.colLo, s.footprintRows.hi).y + L.scale;
      ctx.strokeRect(fx0 + 0.5, y0 + 0.5, fx1 - fx0 - 1, y1 - y0 - 1);
    } else if (!g.rowDown) {
      for (const x of [fx0, fx1]) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, L.oy);
        ctx.lineTo(Math.round(x) + 0.5, L.oy + dh);
        ctx.stroke();
      }
    }

    // Map-cursor column, any tool.
    const hc = hoverColRef.current;
    if (hc != null) {
      const band = hoverColumn(g, L, hc);
      if (band) {
        ctx.fillStyle = rgba(MAP.lensHover, 0.28);
        ctx.fillRect(band.x, L.oy, Math.max(1, band.w), dh);
      }
    }

    if (g.rowDown) return; // the Top tab is already clipped to the z range: no band, no handles

    // z± extrude ghost bands.
    if (s.extrude && s.extrude.count > 0) {
      const o = extrudeOverlay(g, L, z.zMin, z.zMax, s.extrude.count, s.extrude.dir, s.maxZ);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = MAP.lensExtrude;
      ctx.lineWidth = 1.5;
      for (const b of o.bands) {
        ctx.fillStyle = rgba(MAP.clipboard, b.alpha);
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeRect(b.x + 0.75, b.y + 0.75, b.w - 1.5, Math.max(1, b.h - 1.5));
      }
      ctx.setLineDash([]);
      if (o.oob) {
        const x0 = L.ox, x1 = L.ox + blocksW(g) * L.scale;
        ctx.strokeStyle = rgba(MAP.lensExtrude, 0.4);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(x0, o.oob.y);
        ctx.lineTo(x1, o.oob.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = rgba(MAP.lensExtrude, 0.6);
        ctx.font = "8px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = o.oob.dir > 0 ? "top" : "bottom";
        ctx.fillText(`z${o.oob.dir > 0 ? "+" : "-"} OOB`, (x0 + x1) / 2, o.oob.y + (o.oob.dir > 0 ? 2 : -2));
      }
    }

    // The z band.
    const band = bandRect(g, L, z.zMin, z.zMax);
    ctx.fillStyle = rgba(MAP.selection, 0.22);
    ctx.fillRect(band.x, band.y, band.w, band.h);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = MAP.lensBand;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(band.x + 0.75, band.y + 0.75, band.w - 1.5, Math.max(1, band.h - 1.5));
    ctx.setLineDash([]);

    // Draw stroke preview: the cells so far, outlined.
    const gs = gestureRef.current;
    if (gs?.kind === "draw" && gs.cells.length > 0) {
      ctx.strokeStyle = RAMP.text;
      ctx.lineWidth = 1;
      for (const c of gs.cells) {
        const q = cellToCanvas(g, L, c.col, c.row);
        ctx.strokeRect(q.x + 0.5, q.y + 0.5, Math.max(1, L.scale - 1), Math.max(1, L.scale - 1));
      }
    }

    // Edge grips: dim at rest, bright (with the edge's z) when hovered or dragged.
    if (s.onZRange) {
      const e = zEdges(g, L, z.zMin, z.zMax);
      const active = gs?.kind === "z" ? gs.edge : hoverEdgeRef.current;
      const gx = avail.x + avail.w / 2;
      for (const edge of ["max", "min"] as const) {
        const gy = e[edge];
        if (gy < avail.y - 4 || gy > avail.y + avail.h + 4) continue;
        const on = active === edge;
        ctx.fillStyle = on ? RAMP.text : rgba(RAMP.dim, 0.45);
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.arc(gx + i * 7, gy, on ? 2.5 : 2, 0, Math.PI * 2);
          ctx.fill();
        }
        if (on) {
          ctx.fillStyle = RAMP.text;
          ctx.font = "9px monospace";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(`z ${edge === "max" ? z.zMax : z.zMin}`, gx + 14, gy);
        }
      }
    }
  }

  function drawRuler(ctx: CanvasRenderingContext2D, g: ImageGeom, L: Layout, ch: number) {
    // Rows run from `row0` (top) down to `row0 − height + 1`.
    const zTop = g.row0, zBot = g.row0 - g.height + 1;
    const { label, tick } = rulerSteps(L.scale);
    ctx.font = "9px monospace";
    ctx.fillStyle = TEXT_META;
    ctx.strokeStyle = RAMP.dim;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (let z = Math.ceil(zBot / tick) * tick; z <= zTop; z += tick) {
      const y = cellToCanvas(g, L, g.colLo, z).y;
      if (y < -4 || y > ch + 4) continue;
      ctx.beginPath();
      ctx.moveTo(RULER_W - 5, y);
      ctx.lineTo(RULER_W - 1, y);
      ctx.stroke();
      if (z % label === 0) ctx.fillText(String(z), RULER_W - 7, y);
    }
  }

  // ── Gestures (selection mode) ────────────────────────────────────────────────────────────

  function local(e: { clientX: number; clientY: number }): Pt {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function pushZ(v: { zMin: number; zMax: number }, final: boolean) {
    const s = propsRef.current.sel;
    if (!s?.onZRange) return;
    const zc = zCommitRef.current;
    const send = (x: { zMin: number; zMax: number }) => {
      zc.at = Date.now();
      zc.next = null;
      const key = `${x.zMin}|${x.zMax}`;
      if (key === zc.sent) return;
      zc.sent = key;
      propsRef.current.sel?.onZRange?.(x.zMin, x.zMax);
    };
    if (final) {
      if (zc.timer) { clearTimeout(zc.timer); zc.timer = null; }
      send(v);
      return;
    }
    const elapsed = Date.now() - zc.at;
    if (elapsed >= Z_COMMIT_MS) {
      if (zc.timer) { clearTimeout(zc.timer); zc.timer = null; }
      send(v);
    } else {
      zc.next = v;
      if (!zc.timer) zc.timer = setTimeout(() => { zc.timer = null; if (zc.next) send(zc.next); }, Z_COMMIT_MS - elapsed);
    }
  }

  function strokeCell(g: ImageGeom, L: Layout, p: Pt, s: LensViewSelection, gs: Extract<Gesture, { kind: "draw" }>) {
    const c = canvasToCell(g, L, p.x, p.y);
    if (c.col < s.footprint.lo || c.col > s.footprint.hi || c.row < 0 || c.row > s.maxZ) return;
    const k = `${c.col}|${c.row}`;
    if (gs.seen.has(k)) return;
    gs.seen.add(k);
    gs.cells.push(c);
    requestDraw();
  }

  /** Esc mid-gesture: a z drag reverts to its start, a stroke is dropped. Capture phase, so App's own
   *  Esc (clear the selection) never sees it. */
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    const gs = gestureRef.current;
    if (!gs) return;
    e.preventDefault();
    e.stopPropagation();
    if (gs.kind === "z") pushZ(gs.start, true);
    endGesture();
  }

  function endGesture() {
    const gs = gestureRef.current;
    gestureRef.current = null;
    if (keyListenerRef.current) {
      window.removeEventListener("keydown", keyListenerRef.current, true);
      keyListenerRef.current = null;
    }
    const canvas = canvasRef.current;
    if (gs && canvas?.hasPointerCapture(gs.pointerId)) canvas.releasePointerCapture(gs.pointerId);
    if (gs?.kind === "z") propsRef.current.sel?.link.setLiveZ(null);
    requestDraw();
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    const s = propsRef.current.sel, g = propsRef.current.image, last = lastLayoutRef.current;
    if (!s || !g || !last || e.button !== 0 || gestureRef.current) return;
    const p = local(e);
    const L = last.L;
    const canvas = e.currentTarget;
    const zNow = shownZ()!;
    const edge = s.onZRange && !g.rowDown ? zEdgeHit(g, L, p.y, zNow.zMin, zNow.zMax) : null;
    if (edge) {
      const ey = zEdges(g, L, zNow.zMin, zNow.zMax)[edge];
      gestureRef.current = { kind: "z", edge, pointerId: e.pointerId, grab: (p.y - ey) / L.scale, start: { ...zNow } };
      zCommitRef.current.sent = `${zNow.zMin}|${zNow.zMax}`;
    } else if (s.drawActive && s.onStroke && !g.rowDown) {
      const gs: Gesture = { kind: "draw", pointerId: e.pointerId, cells: [], seen: new Set() };
      gestureRef.current = gs;
      strokeCell(g, L, p, s, gs);
    } else {
      gestureRef.current = { kind: "pan", pointerId: e.pointerId, sx: p.x, sy: p.y, start: { ...panRef.current } };
      canvas.style.cursor = "grabbing";
    }
    canvas.setPointerCapture(e.pointerId);
    keyListenerRef.current = onKeyDown;
    window.addEventListener("keydown", onKeyDown, true);
    e.preventDefault();
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const s = propsRef.current.sel, g = propsRef.current.image, last = lastLayoutRef.current;
    if (!s || !g || !last) return;
    const p = local(e);
    const gs = gestureRef.current;
    if (!gs) {
      // Hover: the edge under the cursor brightens; the cursor says what a press would do.
      const z = shownZ()!;
      const edge = s.onZRange && !g.rowDown ? zEdgeHit(g, last.L, p.y, z.zMin, z.zMax) : null;
      if (edge !== hoverEdgeRef.current) { hoverEdgeRef.current = edge; requestDraw(); }
      e.currentTarget.style.cursor = edge ? "ns-resize" : s.drawActive && !g.rowDown ? "crosshair" : "grab";
      return;
    }
    if (gs.pointerId !== e.pointerId) return;
    if (gs.kind === "pan") {
      panRef.current = { x: gs.start.x + p.x - gs.sx, y: gs.start.y + p.y - gs.sy };
      requestDraw();
    } else if (gs.kind === "draw") {
      strokeCell(g, last.L, p, s, gs);
    } else {
      const z = zAtEdge(g, last.L, p.y - gs.grab * last.L.scale, gs.edge);
      const v = dragZ(gs.edge, z, gs.start, s.maxZ);
      // Dragging the top above the frame grows the frame to keep it in view (plan §2.3).
      const f = s.frame;
      if (f && gs.edge === "max" && v.zMax > (grownRef.current.hi ?? f.hi)) grownRef.current.hi = v.zMax;
      const cur = s.link.liveZ;
      if (!cur || cur.zMin !== v.zMin || cur.zMax !== v.zMax) {
        s.link.setLiveZ(v);
        pushZ(v, false);
      }
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    const gs = gestureRef.current;
    if (!gs || gs.pointerId !== e.pointerId) return;
    const s = propsRef.current.sel;
    if (gs.kind === "z") {
      const v = s?.link.liveZ;
      if (v) pushZ(v, true);
    } else if (gs.kind === "draw") {
      if (gs.cells.length > 0) s?.onStroke?.(gs.cells);
    }
    endGesture();
    e.currentTarget.style.cursor = "";
  }

  /** The OS took the pointer: keep a z drag where it got to, drop a stroke. */
  function onPointerCancel(e: ReactPointerEvent<HTMLCanvasElement>) {
    const gs = gestureRef.current;
    if (!gs || gs.pointerId !== e.pointerId) return;
    const v = gs.kind === "z" ? propsRef.current.sel?.link.liveZ : null;
    if (v) pushZ(v, true);
    endGesture();
  }

  function onPointerLeave() {
    if (gestureRef.current) return;
    if (hoverEdgeRef.current) { hoverEdgeRef.current = null; requestDraw(); }
  }

  function onDoubleClick() {
    const s = propsRef.current.sel;
    if (!s || gestureRef.current) return;
    panRef.current = { x: 0, y: 0 };
    s.link.setZoom(1, null);
    requestDraw();
  }

  // Wheel zoom about the cursor. A native non-passive listener: React's wheel handler can't
  // preventDefault the page scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const s = propsRef.current.sel, last = lastLayoutRef.current;
      if (!s || !last) return;
      e.preventDefault();
      const prev = s.link.zoom;
      const want = e.deltaY < 0 ? prev * ZOOM_STEP : prev / ZOOM_STEP;
      const r = zoomAbout(last.fit, prev, panRef.current, local(e), want);
      if (r.zoom === prev) return;
      panRef.current = r.pan;
      s.link.setZoom(r.zoom, self);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // Reads refs and the stable `self` token only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const interactive = props.sel != null;
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: FONT.micro, color: TEXT_META, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{props.label}</span>
      <canvas
        ref={canvasRef}
        title={props.title}
        style={{
          flex: 1, minHeight: 0, width: "100%", borderRadius: 3, boxShadow: `inset 0 0 0 1px ${RAMP.text}22`,
          touchAction: interactive ? "none" : undefined,
        }}
        onPointerDown={interactive ? onPointerDown : undefined}
        onPointerMove={interactive ? onPointerMove : undefined}
        onPointerUp={interactive ? onPointerUp : undefined}
        onPointerCancel={interactive ? onPointerCancel : undefined}
        onPointerLeave={interactive ? onPointerLeave : undefined}
        onDoubleClick={interactive ? onDoubleClick : undefined}
      />
    </div>
  );
});

export default LensView;

function sameFrame(a: { lo: number; hi: number } | null, b: { lo: number; hi: number } | null): boolean {
  return a === b || (a != null && b != null && a.lo === b.lo && a.hi === b.hi);
}

/** The image as a canvas, so it can be scaled with nearest-neighbour sampling. `pixels` is
 *  reinterpreted, not copied (the `putPatchPixels` idiom). */
function buildOffscreen(img: LensViewImage | null): HTMLCanvasElement | null {
  if (!img || img.width <= 0 || img.height <= 0) return null;
  const off = document.createElement("canvas");
  off.width = img.width;
  off.height = img.height;
  const ctx = off.getContext("2d");
  if (!ctx) return null;
  const clamped = new Uint8ClampedArray(img.pixels.buffer, img.pixels.byteOffset, img.pixels.byteLength);
  ctx.putImageData(new ImageData(clamped, img.width, img.height), 0, 0);
  return off;
}

/** A paste-lens view as a `LensViewImage`: rows are Z from `zHi` down, `lod` X/Y columns per pixel. */
export function pasteLensImage(d: { width: number; height: number; lod: number; colLo: number; zHi: number; pixels: Uint8Array } | null): LensViewImage | null {
  if (!d) return null;
  return { width: d.width, height: d.height, colLo: d.colLo, colLod: d.lod, row0: d.zHi, rowLod: 1, rowDown: false, pixels: d.pixels };
}
