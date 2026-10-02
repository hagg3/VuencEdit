/**
 * The Lens (Stage 20.4, `TEST WORLDS/lens-window-plan-2026-10-01.md`; paste mode from UI redesign r3,
 * Stage 14.9). One floating context panel with two bodies:
 *
 * - **Paste mode** (a paste is armed): front + side elevations of the paste at the ghost, with the Z
 *   nudge built in. Backend: `render_paste_lens`.
 * - **Selection mode** (a selection exists, no paste armed): front + side elevations of the selection
 *   (or its Top view) with the z band's edge handles, zoom/pan, draw-on-elevation, the map-cursor
 *   column and the extrude bands. Backend: `render_selection_lens`. This replaced the Inspector's
 *   Elevation and Front view sections.
 *
 * **Visibility** (`lens/lensMode.ts`): a paste wins while armed. Each mode has its own session-only
 * flag (`wins.lens.open` for paste, `lensSelOn` for selections, both on at launch and never stored);
 * ✕ and ⌥P turn off the flag of the mode that is showing (App's `onToggleLensWindow`).
 *
 * **Attach/follow** (paste mode only). While following, the window's `left`/`top` are written straight
 * to its element on rAF (like `FloatingWindow`'s own drag path), never through React state at pointer
 * rate (19.2). When the ghost pauses (150 ms), goes away, or the lens unmounts, the final position is
 * committed with `useWindowLayout.ts`'s `followLensPosition` (a store update that *skips persistence*),
 * so `rectOf` and stacking agree with what's on screen. The render origin keeps its own ≤15 Hz
 * throttle. Dragging the title bar in paste mode (`onMoved` with `kind === "move"`) detaches; a resize
 * doesn't; 🔗 re-attaches. Selection mode never follows: it sits at the stored rect, the same one.
 */
import { sfx } from "../sound/sfx";
import { useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WinButton } from "./FloatingWindow";
import ContextPanel from "./ContextPanel";
import { rectOf, winLimits } from "./windowGeometry";
import { followLensPosition, getWindowState, setLensAttached, useWindowLayout } from "./useWindowLayout";
import { attachPosition, bodyAspectLayout } from "../lens/lensPlacement";
import { useLensRender, type LensPasteMode } from "../lens/useLensRender";
import { useLensFetch } from "../lens/useLensFetch";
import { lensMode } from "../lens/lensMode";
import { frameRows } from "../lens/lensViewMath";
import LensView, { createLensLink, pasteLensImage, type LensLink, type LensViewHandle, type LensViewImage } from "../lens/LensView";
import type { GhostInfo, MapCanvasRef, Tool } from "../MapCanvas";
import {
  decodeSelectionLens, type ClipboardInfo, type PasteLensResult, type SelectionInfo,
  type SelectionLensImage, type SelectionLensResult,
} from "../types";
import { ACCENT, FONT, SHIFT, SPACE, TEXT_META } from "../ribbon/tokens";
import { IconButton, Segmented } from "../ribbon/primitives";
import { MAP } from "../theme/theme";

/** Throttle for the render-input origin state this component feeds `useLensRender` (≤15 Hz while
 *  hovering, per the sub-plan). Attach-follow *position* is not throttled: it is a direct style write
 *  on rAF (19.2). */
const GHOST_THROTTLE_MS = 66;
/** Following "stops" after this long without a ghost event; the final position is then committed to
 *  the layout store. */
const FOLLOW_IDLE_MS = 150;
/** Terrain-only context columns either side of the paste footprint (sub-plan §2.1 default). */
const LENS_CONTEXT = 2;
/** Context columns either side of a selection (the old elevation panel's default, plan D6). */
const SEL_CONTEXT = 7;
/** Longest image side asked of the backend (the 20.3 default). Zooming doesn't refetch. */
const SEL_MAX_PX = 512;
/** Selection-mode fetch throttle: its inputs are edits and selection commits, not hover (§2.2). */
const SEL_THROTTLE_MS = 150;
/** Below this rendered body width the legend/hint hide (mock `@container (max-width: 330px)`). */
const COMPACT_BELOW = 330;

export interface ElevationPoint { x: number; y: number; z: number }

export interface LensWindowProps {
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
  /** ✕: turns off the showing mode's flag (App's ⌥P handler, `lensMode.lensToggle`). */
  onExit: () => void;
  // ── Selection mode (§2.1) ──
  selection: SelectionInfo | null;
  /** App's raw z range, not `selection.z_*` (which trails `describe_selection`'s debounce). */
  zMin: number;
  zMax: number;
  onZRangeChange: (zMin: number, zMax: number) => void;
  /** Identity only: a new mask object refetches. */
  selectionMask: object | null;
  extrude: { axis: string; count: number } | null;
  drawActive: boolean;
  /** One finished draw stroke: one `paint_blocks` call, one undo step. */
  onDrawElevation: (points: ElevationPoint[]) => void;
  maxZ: number;
}

export default function LensWindow(p: LensWindowProps) {
  const layout = useWindowLayout();
  const ws = layout.wins.lens;
  const attached = ws.attached ?? true;
  const armed = p.tool === "paste" && !!p.clipboard;
  const mode = lensMode({ pasteArmed: armed, hasSelection: p.selection != null, pasteOn: ws.open, selOn: layout.lensSelOn });

  // ── Ghost subscription → render origin (throttled state) + attach-follow (throttled, unpersisted
  //    store write) ──────────────────────────────────────────────────────────────────────────────
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const pendingGhostRef = useRef<GhostInfo | null>(null);
  const throttleRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; lastAt: number }>({ timer: null, lastAt: 0 });
  // Live mirrors for `applyGhost`, which can run from a `setTimeout` well after the render that
  // scheduled it — mirrored in an effect (not written during render) so a mid-throttle-window
  // detach/close is never missed.
  const attachedRef = useRef(attached);
  const followingRef = useRef(mode === "paste");
  useEffect(() => { attachedRef.current = attached; followingRef.current = mode === "paste"; }, [attached, mode]);

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
    if (!g || !attachedRef.current || !followingRef.current) { commitFollow(); return; }
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
  const enabled = mode === "paste" && !ws.collapsed && !scatterOrArray && origin != null;

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

  const sel = p.selection;
  return (
    // The first context panel (16.5), and the one `userToggle` exception: shown while its mode holds
    // *and* that mode's session flag is on. ✕ turns the flag off rather than leaving the mode
    // (disarming the paste would lose the ghost; clearing the selection isn't what closing a preview
    // means).
    <ContextPanel
      id="lens"
      when={mode != null}
      enabled={mode === "selection" ? layout.lensSelOn : ws.open}
      worldLoaded={p.worldLoaded}
      onExit={p.onExit}
      title="Lens"
      icon={mode === "selection" ? "select" : "paste"}
      meta={mode === "paste"
        ? (p.clipboard ? <>anchor z {p.clipboard.z_anchor}</> : null)
        : sel ? <>{sel.width}×{sel.height} · z {p.zMin}–{p.zMax}</> : null}
      dataTour="lens"
      buttons={mode === "paste" ? (
        <WinButton
          icon={attached ? "link" : "linkOff"}
          label={!p.mapVisible
            ? "No ghost to follow while the 3D view is the main pane"
            : attached ? "Following the paste. Drag the title bar to detach." : "Re-attach to the paste ghost"}
          active={attached}
          disabled={!p.mapVisible}
          cue="tab"
          onClick={() => setLensAttached(!attached)}
        />
      ) : undefined}
      onMoved={kind => { if (kind === "move" && mode === "paste") setLensAttached(false); }}
      bodyStyle={{ flexDirection: "column", padding: 0 }}
    >
      {mode === "paste" ? (
        <LensBody
          pasteElevationOffset={p.pasteElevationOffset}
          onNudge={nudge}
          note={note}
          front={render.front}
          side={render.side}
        />
      ) : sel ? (
        <SelectionBody {...p} selection={sel} active={!ws.collapsed} />
      ) : null}
    </ContextPanel>
  );
}

/** Row (front | side) or column by the body's aspect, and whether it's too narrow for the legend.
 *  Measured with a `ResizeObserver`; only a change of either bit re-renders. */
function useBodyShape() {
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
  return { bodyRef, wide, compact };
}

interface LensBodyProps {
  pasteElevationOffset: number;
  onNudge: (d: number) => void;
  note: string | null;
  front: PasteLensResult | null;
  side: PasteLensResult | null;
}

function LensBody({ pasteElevationOffset, onNudge, note, front, side }: LensBodyProps) {
  const { bodyRef, wide, compact } = useBodyShape();

  // Stats are computed over the whole clipboard volume, not per view — front and side report the
  // same numbers (see `render_paste_lens_inner`), so either is authoritative for the footer.
  const stats = front ?? side;
  const offLabel = pasteElevationOffset === 0 ? "z+0" : pasteElevationOffset > 0 ? `z+${pasteElevationOffset}` : `z${pasteElevationOffset}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0, gap: SPACE.sm, padding: SPACE.sm }}>
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden" }}>
        <IconButton icon="down" label="Lower paste" title={`Lower the paste (PgDn, ${SHIFT} for 5)`} onClick={() => onNudge(-1)} />
        <span style={{
          minWidth: 34, textAlign: "center", fontFamily: "monospace", fontWeight: 700,
          fontSize: FONT.body, color: ACCENT.clipboard,
        }}>{offLabel}</span>
        <IconButton icon="up" label="Raise paste" title={`Raise the paste (PgUp, ${SHIFT} for 5)`} onClick={() => onNudge(1)} />
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
            <LensView label="Front · looking north" image={pasteLensImage(front)} ruler ghostZMin={front?.ghostZMin} />
            <LensView label="Side · looking east" image={pasteLensImage(side)} ruler ghostZMin={side?.ghostZMin} />
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

/** `hatch`: the diagonal-stripe-over-wash look clash cells have in the lens image (19.3). `faint`:
 *  the 50 % alpha context columns have in the selection lens. */
function Swatch({ hex, hatch, faint }: { hex: string; hatch?: boolean; faint?: boolean }) {
  const background = hatch ? `repeating-linear-gradient(135deg, ${hex} 0 2px, ${hex}59 2px 4px)` : faint ? `${hex}80` : hex;
  return <span style={{ width: 8, height: 8, borderRadius: 2, background, display: "inline-block" }} />;
}

// ── Selection mode ───────────────────────────────────────────────────────────────────────────

type SelTab = "elev" | "top";
/** The chosen tab, remembered for the session (module-level, not persisted). */
let lastSelTab: SelTab = "elev";

/** A fetched selection lens and the rect it was rendered for (images can trail the selection). */
interface SelFetch { result: SelectionLensResult; rectKey: string }

const SEL_TABS: { id: SelTab; label: string; title: string }[] = [
  { id: "elev", label: "Elevation", title: "Front and side views of the selection" },
  { id: "top", label: "Top", title: "Looking down on the selection's z range" },
];

function elevImage(img: SelectionLensImage | null, zHi: number): LensViewImage | null {
  if (!img) return null;
  return { width: img.width, height: img.height, colLo: img.colLo, colLod: img.lod, row0: zHi, rowLod: 1, rowDown: false, pixels: img.pixels };
}

function topImage(img: SelectionLensImage | null): LensViewImage | null {
  if (!img) return null;
  return { width: img.width, height: img.height, colLo: img.colLo, colLod: img.lod, row0: img.rowLo ?? 0, rowLod: img.lod, rowDown: true, pixels: img.pixels };
}

function SelectionBody(p: LensWindowProps & { selection: SelectionInfo; active: boolean }) {
  const sel = p.selection;
  const { bodyRef, wide, compact } = useBodyShape();
  const [tab, setTabState] = useState<SelTab>(lastSelTab);
  const setTab = (t: SelTab) => { lastSelTab = t; setTabState(t); };
  const [link] = useState<LensLink>(createLensLink);
  const frontRef = useRef<LensViewHandle>(null);
  const sideRef = useRef<LensViewHandle>(null);

  // A new mask object is a new shape over the same rect: refetch (the "adjust state on prop change"
  // idiom, as `clipEpochState` above).
  const [maskEpochState, setMaskEpochState] = useState({ mask: p.selectionMask, epoch: 0 });
  if (maskEpochState.mask !== p.selectionMask) {
    setMaskEpochState({ mask: p.selectionMask, epoch: maskEpochState.epoch + 1 });
  }

  // ── Fetch (§2.2): elevations don't depend on z, so a z drag never refetches them. Top does. ──
  const rectKey = `${sel.x1}|${sel.y1}|${sel.x2}|${sel.y2}`;
  const isTop = tab === "top";
  const key = p.active
    ? [rectKey, maskEpochState.epoch, p.editEpoch, p.maxZ, isTop ? `top|${p.zMin}|${p.zMax}` : "elev"].join("|")
    : null;
  const fetchLens = async (): Promise<SelFetch> => {
    const buf = await invoke<ArrayBuffer>("render_selection_lens", {
      x1: sel.x1, y1: sel.y1, x2: sel.x2, y2: sel.y2, zMin: p.zMin, zMax: p.zMax,
      context: SEL_CONTEXT, maxPx: SEL_MAX_PX, top: isTop,
    });
    return { result: decodeSelectionLens(buf), rectKey };
  };
  const fetched = useLensFetch(key, fetchLens, SEL_THROTTLE_MS);
  const data = fetched.data;
  const elev = data && data.result.front ? data : null;
  const top = data && data.result.top ? data : null;

  // ── Framing (§2.3): latched per selection rect from its first elevation, so an edit or a z
  //    change never yanks the view. ──
  const [frameState, setFrameState] = useState<{ rectKey: string; frame: { lo: number; hi: number } } | null>(null);
  if (elev && elev.rectKey === rectKey && frameState?.rectKey !== rectKey) {
    const r = elev.result;
    setFrameState({ rectKey, frame: frameRows(r.zLo, r.zHi, r.terrainZHi, p.zMax) });
  }
  const frame = elev && frameState?.rectKey === elev.rectKey ? frameState.frame : null;

  // A new rect starts at 1× (its frame is new too).
  useEffect(() => { link.setZoom(1, null); }, [link, rectKey]);

  // Map cursor → each elevation's hover column. A ref fan-out: App isn't involved.
  useEffect(() => {
    const mc = p.mapCanvasRef.current;
    if (!mc) return;
    return mc.subscribeCursor(c => {
      frontRef.current?.setHover(c ? c.x : null);
      sideRef.current?.setHover(c ? c.y : null);
    });
    // The map's imperative API is stable for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.mapCanvasRef.current]);

  const extrude = p.extrude && (p.extrude.axis === "z+" || p.extrude.axis === "z-")
    ? { count: p.extrude.count, dir: (p.extrude.axis === "z+" ? 1 : -1) as 1 | -1 }
    : null;
  // Front paints on the selection's near face `y = y1`, side on `x = x1` (the face the ray enters).
  const strokeFront = (cells: { col: number; row: number }[]) =>
    p.onDrawElevation(cells.map(c => ({ x: c.col, y: sel.y1, z: c.row })));
  const strokeSide = (cells: { col: number; row: number }[]) =>
    p.onDrawElevation(cells.map(c => ({ x: sel.x1, y: c.col, z: c.row })));

  const hint = "Scroll to zoom, drag to pan, double-click to reset.";
  const elevView = (which: "front" | "side") => {
    const img = elev?.result[which] ?? null;
    return (
      <LensView
        ref={which === "front" ? frontRef : sideRef}
        label={which === "front" ? "Front · looking north" : "Side · looking east"}
        image={elevImage(img, elev?.result.zHi ?? 0)}
        ruler
        title={`${hint} Drag the band's edges to change the z range.${p.drawActive ? " Draw to paint on the selection's face." : ""}`}
        sel={{
          link, zMin: p.zMin, zMax: p.zMax, maxZ: p.maxZ, frame,
          footprint: img ? { lo: img.footprintLo, hi: img.footprintHi } : which === "front" ? { lo: sel.x1, hi: sel.x2 } : { lo: sel.y1, hi: sel.y2 },
          extrude,
          onZRange: p.onZRangeChange,
          drawActive: p.drawActive,
          onStroke: which === "front" ? strokeFront : strokeSide,
        }}
      />
    );
  };

  const note = fetched.error ? `Couldn't render: ${fetched.error}` : null;
  const topImg = top?.result.top ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0, gap: SPACE.sm, padding: SPACE.sm }}>
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden" }}>
        <Segmented ariaLabel="Lens view" value={tab} options={SEL_TABS} onChange={setTab} />
        <span style={{ fontFamily: "monospace", fontSize: FONT.micro, color: TEXT_META }}>z {p.zMin}–{p.zMax}</span>
        <ZoomBadge link={link} />
        <span style={{ flex: 1, minWidth: 0 }} />
        {!compact && (
          <span style={{ display: "flex", alignItems: "center", gap: SPACE.xs, fontSize: FONT.micro, color: TEXT_META }}>
            <Swatch hex={MAP.air} /> selected
            <Swatch hex={MAP.air} faint /> context
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
        ) : isTop ? (
          <LensView
            label={`Top · z ${p.zMin}–${p.zMax}`}
            image={topImage(topImg)}
            ruler={false}
            title={hint}
            sel={{
              link, zMin: p.zMin, zMax: p.zMax, maxZ: p.maxZ, frame: null,
              footprint: { lo: sel.x1, hi: sel.x2 }, footprintRows: { lo: sel.y1, hi: sel.y2 },
              extrude: null, drawActive: false,
            }}
          />
        ) : (
          <>
            {elevView("front")}
            {elevView("side")}
          </>
        )}
      </div>
    </div>
  );
}

/** `1.0×` + reset, shown only while zoomed. The number is written straight to the DOM per wheel
 *  notch; React only re-renders when the zoom crosses 1×. */
function ZoomBadge({ link }: { link: LensLink }) {
  const [zoomed, setZoomed] = useState(link.zoom > 1);
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => link.subscribe(e => {
    if (e.type !== "zoom") return;
    if (textRef.current) textRef.current.textContent = `${e.next.toFixed(1)}×`;
    setZoomed(e.next > 1);
  }), [link]);
  if (!zoomed) return null;
  return (
    <button
      type="button"
      onClick={() => link.setZoom(1, null)}
      title="Reset zoom and pan"
      style={{
        padding: "1px 5px", fontSize: FONT.micro, cursor: "pointer", borderRadius: 3,
        background: "transparent", border: `1px solid ${ACCENT.violet}`, color: ACCENT.violet,
      }}
    ><span ref={textRef}>{link.zoom.toFixed(1)}×</span> ✕</button>
  );
}
