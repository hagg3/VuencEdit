/**
 * The paste lens (UI redesign r3, Stage 14.9) — front + side elevations of the armed paste at the
 * ghost's position, with Z controls built in. Built on the 14.3 framework (`FloatingWindow`), like
 * `ToolsWindow`/`HotbarWindow`/`View3DWindow`. Sub-plan: `TEST WORLDS/ui-redesign-r3-paste-lens-
 * plan-2026-09-26.md` §5. Backend: `render_paste_lens` (14.8, already landed).
 *
 * **Visibility** (mirrors the mock's `st.paste && st.win.lens.open` gate): mounted at all only
 * while a paste is armed (`tool === "paste"` and a clipboard exists) *and* the lens is enabled —
 * not merely collapsed-away. "Enabled" (`wins.lens.open`) is a **session-only** flag that starts on
 * at every launch and is never restored from storage (Stage 16.1; see `windowStorage.sessionizeContext`),
 * so arming a paste auto-pops the lens with no setup. Re-enabling it with nothing armed
 * (⌥P / View ▸ Windows) is handled by the caller (`App.tsx`'s `onToggleLensWindow`, which shows a
 * one-time status toast) — this component only ever renders once something is actually pasteable.
 * The Z arrows are the Quick Actions bar's own `IconButton`, so both surfaces match.
 *
 * **Attach/follow.** While following, the window's `left`/`top` are written straight to its element
 * on rAF (like `FloatingWindow`'s own drag path), never through React state at pointer rate (19.2;
 * it used to go through a 66 ms-throttled store update per tick). When the ghost pauses (150 ms),
 * goes away, or the lens unmounts, the final position is committed with `useWindowLayout.ts`'s
 * `followLensPosition` (a store update that *skips persistence*), so `rectOf` and stacking agree
 * with what's on screen. The render origin keeps its own ≤15 Hz throttle. Dragging the title bar
 * (`onMoved` with `kind === "move"`) detaches; a resize doesn't; 🔗 re-attaches.
 */
import { sfx } from "../sound/sfx";
import { useEffect, useRef, useState, type RefObject } from "react";
import { WinButton } from "./FloatingWindow";
import ContextPanel from "./ContextPanel";
import { rectOf, winLimits } from "./windowGeometry";
import { closeWin, followLensPosition, getWindowState, setLensAttached, useWindowLayout } from "./useWindowLayout";
import { attachPosition, bodyAspectLayout } from "../lens/lensPlacement";
import { useLensRender, type LensPasteMode } from "../lens/useLensRender";
import type { GhostInfo, MapCanvasRef, Tool } from "../MapCanvas";
import type { ClipboardInfo, PasteLensResult } from "../types";
import { beginFrame, resizeCanvasToContainer } from "../viewportUtils";
import { ACCENT, FONT, SHIFT, SPACE, TEXT_META } from "../ribbon/tokens";
import { IconButton } from "../ribbon/primitives";
import { MAP, RAMP } from "../theme/theme";

/** Throttle for the render-input origin state this component feeds `useLensRender` (≤15 Hz while
 *  hovering, per the sub-plan). Attach-follow *position* is not throttled: it is a direct style write
 *  on rAF (19.2). */
const GHOST_THROTTLE_MS = 66;
/** Following "stops" after this long without a ghost event; the final position is then committed to
 *  the layout store. */
const FOLLOW_IDLE_MS = 150;
/** Terrain-only context columns either side of the footprint (sub-plan §2.1 default). */
const LENS_CONTEXT = 2;
/** Below this rendered body width the legend/hint hide (mock `@container (max-width: 330px)`). */
const COMPACT_BELOW = 330;

export interface PasteLensWindowProps {
  tool: Tool;
  clipboard: ClipboardInfo | null;
  pasteMode: "normal" | "scatter" | "array";
  pasteTerrain: boolean;
  pasteIgnoreAir: boolean;
  pasteTerrainAbove: boolean;
  pasteElevationOffset: number;
  setPasteElevationOffset: (v: number) => void;
  editEpoch: number;
  mapCanvasRef: RefObject<MapCanvasRef | null>;
  /** False while the 3D view is the main pane (`placement.main === "fly"`) — there's no ghost on
   *  screen to attach to there, so 🔗 is disabled and the lens just floats at its stored rect. */
  mapVisible: boolean;
  worldLoaded: boolean;
}

export default function PasteLensWindow(p: PasteLensWindowProps) {
  const layout = useWindowLayout();
  const ws = layout.wins.lens;
  const attached = ws.attached ?? true;
  const armed = p.tool === "paste" && !!p.clipboard;

  // ── Ghost subscription → render origin (throttled state) + attach-follow (throttled, unpersisted
  //    store write) ──────────────────────────────────────────────────────────────────────────────
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const pendingGhostRef = useRef<GhostInfo | null>(null);
  const throttleRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; lastAt: number }>({ timer: null, lastAt: 0 });
  // Live mirrors for `applyGhost`, which can run from a `setTimeout` well after the render that
  // scheduled it — mirrored in an effect (not written during render) so a mid-throttle-window
  // detach/close is never missed.
  const attachedRef = useRef(attached);
  const openRef = useRef(ws.open);
  useEffect(() => { attachedRef.current = attached; openRef.current = ws.open; }, [attached, ws.open]);

  // Attach-follow runs at pointer rate and writes the window's style directly (rAF-coalesced), per the
  // floating-window rule: never touch React state on pointer-rate work. The store only learns the
  // final position once following pauses (`commitFollow`), so `rectOf`, snapping and stacking stay
  // correct for whatever reads the store next. `offY` is the context-panel stack offset FloatingWindow
  // adds on top of the stored y; it's measured from the live element at the start of each follow run.
  const followRef = useRef<{
    raf: number | null; idle: ReturnType<typeof setTimeout> | null;
    pos: { x: number; y: number } | null; dirty: boolean; offY: number;
  }>({ raf: null, idle: null, pos: null, dirty: false, offY: 0 });

  function commitFollow() {
    const f = followRef.current;
    if (f.idle) { clearTimeout(f.idle); f.idle = null; }
    if (f.raf != null) { cancelAnimationFrame(f.raf); f.raf = null; }
    if (!f.dirty) return;
    f.dirty = false;
    if (f.pos) followLensPosition(f.pos);
  }

  function followGhost(g: GhostInfo | null) {
    if (!g || !attachedRef.current || !openRef.current) { commitFollow(); return; }
    // Work-area-local = ghost's screen rect minus the window layer's own screen origin — the layer
    // fills the same box `rectOf` positions every window inside (`WindowLayer.tsx`'s `.vx-winlayer`).
    const layer = document.querySelector<HTMLElement>(".vx-winlayer");
    const el = document.querySelector<HTMLElement>('[data-win="lens"]');
    if (!layer || !el) return;
    const layerRect = layer.getBoundingClientRect();
    const s = getWindowState();
    const rendered = rectOf(s.wins.lens, s.work, winLimits("lens", s.work));
    const f = followRef.current;
    if (!f.dirty) f.offY = (parseFloat(el.style.top) || rendered.y) - rendered.y;
    const localGhost = {
      x: g.screen.left - layerRect.left, y: g.screen.top - layerRect.top,
      w: g.screen.width, h: g.screen.height,
    };
    f.pos = attachPosition(localGhost, { w: rendered.w, h: rendered.h }, s.work);
    f.dirty = true;
    if (f.raf == null) {
      f.raf = requestAnimationFrame(() => {
        f.raf = null;
        if (!f.pos) return;
        el.style.left = `${f.pos.x}px`;
        el.style.top = `${f.pos.y + f.offY}px`;
      });
    }
    if (f.idle) clearTimeout(f.idle);
    f.idle = setTimeout(commitFollow, FOLLOW_IDLE_MS);
  }

  // The render origin only needs the throttled rate (it drives backend renders).
  function applyGhost(g: GhostInfo | null) {
    setOrigin(g ? { x: g.x, y: g.y } : null);
  }

  function scheduleGhost(g: GhostInfo | null) {
    followGhost(g); // every event: the position write is cheap and coalesced to rAF
    pendingGhostRef.current = g;
    const st = throttleRef.current;
    const elapsed = Date.now() - st.lastAt;
    const flush = () => { st.lastAt = Date.now(); st.timer = null; applyGhost(pendingGhostRef.current); };
    if (elapsed >= GHOST_THROTTLE_MS) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      flush();
    } else if (!st.timer) {
      st.timer = setTimeout(flush, GHOST_THROTTLE_MS - elapsed);
    }
  }

  useEffect(() => {
    const mc = p.mapCanvasRef.current;
    if (!mc) return;
    const unsub = mc.subscribeGhost(scheduleGhost);
    const st = throttleRef.current; // captured once — `st` is the same mutable object throughout
    return () => {
      unsub();
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      commitFollow();
    };
    // `mc.subscribeGhost` is an imperative ref API stable for the map's whole lifetime; `scheduleGhost`
    // closes over refs only, never a stale value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.mapCanvasRef.current]);

  // ── Render inputs ────────────────────────────────────────────────────────────────────────────
  // Bumps whenever the clipboard's *content* changes (rotate/mirror/copy/new copy) — dimensions
  // alone don't always change (mirror), so this can't be derived from width/height. React's
  // "adjusting state when a prop changes" pattern (setState during render, guarded by an identity
  // comparison) rather than an effect — this is the officially-sanctioned way to derive state from
  // a prop change without the extra commit an effect-based bump costs, and it doesn't touch a ref
  // during render either.
  const [clipEpochState, setClipEpochState] = useState({ clip: p.clipboard, epoch: 0 });
  if (clipEpochState.clip !== p.clipboard) {
    setClipEpochState({ clip: p.clipboard, epoch: clipEpochState.epoch + 1 });
  }
  const clipboardEpoch = clipEpochState.epoch;

  const scatterOrArray = p.pasteMode !== "normal";
  const enabled = armed && ws.open && !ws.collapsed && !scatterOrArray && origin != null;

  const render = useLensRender(
    {
      origin: origin ?? { x: 0, y: 0 },
      elevationOffset: p.pasteElevationOffset,
      mode: (p.pasteTerrain ? "terrain" : "normal") as LensPasteMode,
      ignoreAir: p.pasteIgnoreAir,
      aboveSurface: p.pasteTerrainAbove,
      clipboardEpoch,
      editEpoch: p.editEpoch,
      context: LENS_CONTEXT,
    },
    enabled,
  );

  const nudge = (d: number) => { p.setPasteElevationOffset(p.pasteElevationOffset + d); sfx.play("nudge"); };

  let note: string | null = null;
  if (scatterOrArray) note = "Not available for scatter / array paste";
  else if (!p.mapVisible) note = "Switch the map back to the main pane to preview the paste";
  else if (origin == null) note = "Hover the map to preview the paste";
  else if (render.error) note = `Couldn't render: ${render.error}`;

  return (
    // The first context panel (16.5): shown while a paste is armed *and* the session "enabled" flag
    // is on (`userToggle`). ✕ turns that flag off for the session, as before — the lens is the one
    // context panel whose ✕ doesn't leave the mode (disarming the paste would lose the ghost).
    <ContextPanel
      id="lens"
      when={armed}
      worldLoaded={p.worldLoaded}
      onExit={() => closeWin("lens")}
      title="Paste · Z"
      icon="paste"
      meta={p.clipboard ? <>anchor z {p.clipboard.z_anchor}</> : null}
      dataTour="paste-lens"
      buttons={
        <WinButton
          icon={attached ? "link" : "linkOff"}
          label={!p.mapVisible
            ? "No ghost to follow while the 3D view is the main pane"
            : attached ? "Following the ghost — drag the title bar to detach" : "Re-attach to the paste ghost"}
          active={attached}
          disabled={!p.mapVisible}
          cue="tab"
          onClick={() => setLensAttached(!attached)}
        />
      }
      onMoved={kind => { if (kind === "move") setLensAttached(false); }}
      bodyStyle={{ flexDirection: "column", padding: 0 }}
    >
      <LensBody
        pasteElevationOffset={p.pasteElevationOffset}
        onNudge={nudge}
        note={note}
        front={render.front}
        side={render.side}
      />
    </ContextPanel>
  );
}

interface LensBodyProps {
  pasteElevationOffset: number;
  onNudge: (d: number) => void;
  note: string | null;
  front: PasteLensResult | null;
  side: PasteLensResult | null;
}

function LensBody({ pasteElevationOffset, onNudge, note, front, side }: LensBodyProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth, h = el.clientHeight;
      setWide(bodyAspectLayout(w, h) === "row");
      setCompact(w < COMPACT_BELOW);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Stats are computed over the whole clipboard volume, not per view — front and side report the
  // same numbers (see `render_paste_lens_inner`), so either is authoritative for the footer.
  const stats = front ?? side;
  const offLabel = pasteElevationOffset === 0 ? "z+0" : pasteElevationOffset > 0 ? `z+${pasteElevationOffset}` : `z${pasteElevationOffset}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0, gap: SPACE.sm, padding: SPACE.sm }}>
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden" }}>
        <IconButton icon="down" label="Lower paste" title={`Lower the paste (PgDn — ${SHIFT} for ±5)`} onClick={() => onNudge(-1)} />
        <span style={{
          minWidth: 34, textAlign: "center", fontFamily: "monospace", fontWeight: 700,
          fontSize: FONT.body, color: ACCENT.clipboard,
        }}>{offLabel}</span>
        <IconButton icon="up" label="Raise paste" title={`Raise the paste (PgUp — ${SHIFT} for ±5)`} onClick={() => onNudge(1)} />
        {!compact && <span style={{ color: TEXT_META, fontSize: FONT.micro }}>PgUp / PgDn · ⇧ ±5</span>}
        <span style={{ flex: 1, minWidth: 0 }} />
        {!compact && (
          <span style={{ display: "flex", alignItems: "center", gap: SPACE.xs, fontSize: FONT.micro, color: TEXT_META }}>
            <Swatch hex={MAP.air} /> air
            <Swatch hex={MAP.buried} hatch /> buried
          </span>
        )}
      </div>

      <div ref={bodyRef} style={{
        flex: 1, minHeight: 0, minWidth: 0,
        display: "flex", flexDirection: wide ? "row" : "column", gap: SPACE.sm,
      }}>
        {note ? (
          <div style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
            textAlign: "center", padding: SPACE.lg, color: TEXT_META, fontSize: FONT.label,
          }}>{note}</div>
        ) : (
          <>
            <LensPanel label="Front · looking north" data={front} />
            <LensPanel label="Side · looking east" data={side} />
          </>
        )}
      </div>

      {stats && !note && (
        <div style={{
          flexShrink: 0, fontSize: FONT.micro,
          color: stats.buried > 0 ? MAP.buried : stats.floatingCols > 0 ? MAP.cleared : TEXT_META,
        }}>
          {stats.approx ? "≈ " : ""}{stats.buried} buried
          {stats.floatingCols > 0 ? ` · ${stats.approx ? "≈ " : ""}${stats.floatingCols} floating column${stats.floatingCols === 1 ? "" : "s"}` : ""}
        </div>
      )}
    </div>
  );
}

/** `hatch`: the diagonal-stripe-over-wash look clash cells have in the lens image (19.3). */
function Swatch({ hex, hatch }: { hex: string; hatch?: boolean }) {
  const background = hatch ? `repeating-linear-gradient(135deg, ${hex} 0 2px, ${hex}59 2px 4px)` : hex;
  return <span style={{ width: 8, height: 8, borderRadius: 2, background, display: "inline-block" }} />;
}

function LensPanel({ label, data }: { label: string; data: PasteLensResult | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    resizeCanvasToContainer(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h } = beginFrame(ctx, canvas);
    drawLens(ctx, w, h, data);
  }, [data]);

  // Also redraw on resize — resizeCanvasToContainer only changes the backing store when the CSS
  // box actually changed size, so a ResizeObserver-driven container swap (row ⇄ col) needs its own
  // trigger the `data`-keyed effect above won't see.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      if (!resizeCanvasToContainer(canvas)) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { w, h } = beginFrame(ctx, canvas);
      drawLens(ctx, w, h, data);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: FONT.micro, color: TEXT_META, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      <canvas ref={canvasRef} style={{ flex: 1, minHeight: 0, width: "100%", borderRadius: 3, boxShadow: `inset 0 0 0 1px ${RAMP.text}22` }} />
    </div>
  );
}

/** World Z the ruler labels every 16 blocks, tick marks every 8. */
const RULER_TICK = 8;
const RULER_LABEL = 16;
/** Left gutter reserved for the ruler. */
const RULER_W = 24;

function drawLens(ctx: CanvasRenderingContext2D, cw: number, ch: number, data: PasteLensResult | null) {
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = RAMP.mapBg;
  ctx.fillRect(0, 0, cw, ch);
  if (!data || data.width <= 0 || data.height <= 0 || cw <= 1 || ch <= 1) return;

  const availW = Math.max(1, cw - RULER_W);
  const availH = Math.max(1, ch);
  const scale = Math.max(0.05, Math.min(availW / data.width, availH / data.height));
  const dw = data.width * scale, dh = data.height * scale;
  const ox = RULER_W + Math.max(0, (availW - dw) / 2);
  const oy = Math.max(0, (availH - dh) / 2);

  // `data.pixels` is a view over the IPC response bytes (audit H2) — reinterpret without copying,
  // same idiom as `putPatchPixels`, then draw through an offscreen canvas so it can be scaled with
  // nearest-neighbour sampling (`imageSmoothingEnabled = false`).
  const off = document.createElement("canvas");
  off.width = data.width;
  off.height = data.height;
  const offCtx = off.getContext("2d");
  if (!offCtx) return;
  const clamped = new Uint8ClampedArray(data.pixels.buffer, data.pixels.byteOffset, data.pixels.byteLength);
  offCtx.putImageData(new ImageData(clamped, data.width, data.height), 0, 0);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, data.width, data.height, ox, oy, dw, dh);

  // Z ruler: row 0 is world Z = data.zHi (top), row height-1 is data.zLo (bottom) — see
  // `PasteLensResult`'s doc comment.
  ctx.font = "9px monospace";
  ctx.fillStyle = TEXT_META;
  ctx.strokeStyle = RAMP.dim;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  const zTop = data.zHi, zBot = data.zLo;
  const firstTick = Math.ceil(zBot / RULER_TICK) * RULER_TICK;
  for (let z = firstTick; z <= zTop; z += RULER_TICK) {
    const y = oy + (zTop - z) * scale;
    ctx.beginPath();
    ctx.moveTo(RULER_W - 5, y);
    ctx.lineTo(RULER_W - 1, y);
    ctx.stroke();
    if (z % RULER_LABEL === 0) ctx.fillText(String(z), RULER_W - 7, y);
  }

  // Dashed line at the ghost's bottom — the lowest row any pasted cell can land on.
  if (data.ghostZMin != null) {
    const y = oy + (zTop - data.ghostZMin + 1) * scale;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = ACCENT.clipboard;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox, y);
    ctx.lineTo(ox + dw, y);
    ctx.stroke();
    ctx.restore();
  }
}
