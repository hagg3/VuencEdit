/**
 * One floating window's chrome and interaction model (UI redesign r3, Stage 14.3) — shared by every
 * tenant (Tools, 3D view, Hotbar; Paste lens later). 22 px title bar to move, 8-way resize with a
 * visible SE grip, magnetic snap, click-to-front, ✕ hides, window-shade collapse (button or
 * double-click), and never clipped by or pushed past the work area. Float only, no docking.
 *
 * ⚠️ Pointer-rate work never touches React state: a drag/resize writes the frame's `style`
 * directly (rAF-coalesced) and commits to the store once, on pointer-up. `setPointerCapture` on the
 * handle + `WindowLayer`'s drag shield keep the map/3D canvases from seeing hover or pointer events
 * mid-drag, and keep a drag that leaves the Tauri window tracking (WKWebView and WebView2 alike).
 *
 * ⚠️ Click-to-front is a **native capture-phase** listener on the frame, not a React prop: a
 * viewport rendered into a window through a portal bubbles its React events to *its* React parent
 * (App), never to this component (see `Reparentable.tsx`).
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "../ribbon/icons";
import { FONT, ICON, RADIUS, TEXT, TEXT_META } from "../ribbon/tokens";
import {
  RESIZE_DIRS, TITLE_H, effectiveHeight, rectOf, resizeRect, snapMove, stateFromRect, winLimits,
  type Rect, type ResizeDir, type WinId, type WinState,
} from "./windowGeometry";
import {
  closeWin, collapseWin, getWindowState, setDragging, setWin, toFront, useWindowLayout,
} from "./useWindowLayout";
import { isContextPanel } from "./contextPanels";
import { sfx, type HoldHandle } from "../sound/sfx";

/** Pointer travel before a press on the title bar becomes a move — so clicks and double-clicks
 *  never drag. */
const DRAG_THRESHOLD = 3;
/** Below this width even the title icon hides, so collapse + ✕ always fit (the 64 px Tools window). */
const ICON_MIN_W = 76;

export interface FloatingWindowProps {
  id: WinId;
  title: string;
  icon: IconName;
  meta?: ReactNode;
  /** Extra title-bar buttons, before collapse/close. Use `WinButton`. */
  buttons?: ReactNode;
  children?: ReactNode;
  bodyStyle?: CSSProperties;
  dataTour?: string;
  /** Below this rendered width the title text hides (icon, buttons stay). */
  hideTitleBelow?: number;
  /** Close override (default: hide the window). */
  onClose?: () => void;
  /** Called after a drag/resize commits — e.g. the map's cached client rect is now stale. `kind`
   *  lets a tenant tell the two apart (the paste lens detaches on a move, not on a resize). */
  onMoved?: (kind: "move" | "resize") => void;
  /** Context panels (16.5): display-only vertical shift from `stackOffsets`. Gestures start from the
   *  shifted rect, so a drag picks the panel up where the user sees it. */
  offsetY?: number;
  /** Edges that resize (default all eight). Context panels restrict this (`resizeDirsFor`). */
  resizeDirs?: readonly ResizeDir[];
  /** False = no ✕ (a context panel that just follows its mode — plan Q3). */
  closable?: boolean;
}

interface Gesture {
  kind: "move" | "resize";
  dir: ResizeDir | null;
  pointerId: number;
  sx: number; sy: number;
  start: Rect;
  cur: Rect;
  started: boolean;
  el: HTMLElement;
}

export default function FloatingWindow({
  id, title, icon, meta, buttons, children, bodyStyle, dataTour, hideTitleBelow = 90, onClose, onMoved,
  offsetY = 0, resizeDirs = RESIZE_DIRS, closable = true,
}: FloatingWindowProps) {
  const layout = useWindowLayout();
  const ws = layout.wins[id];
  const frameRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const rafRef = useRef<number | null>(null);
  // Hold-while-dragging loop (Stage 15.7) for move *and* resize. Also ended by `sfx.hold`'s
  // window-level guard (pointerup/cancel/lostpointercapture/blur/Esc), so `endGesture` and the
  // unmount cleanup are belt-and-braces.
  const holdRef = useRef<HoldHandle | null>(null);
  useEffect(() => () => { holdRef.current?.stop(); holdRef.current = null; }, []);
  const onMovedRef = useRef(onMoved);
  useEffect(() => { onMovedRef.current = onMoved; }, [onMoved]);

  // Click anywhere in the window → front. Native + capture: see the file header.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const down = () => toFront(id);
    el.addEventListener("pointerdown", down, true);
    return () => el.removeEventListener("pointerdown", down, true);
  }, [id, ws.open]);

  // A window blur (alt-tab mid-drag) ends the gesture, committing what's there.
  useEffect(() => {
    const blur = () => { if (gestureRef.current) endGesture(); };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
    // endGesture only reads refs + the store snapshot
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ws.open) return null;
  const rect = shown(rectOf(ws, layout.work, winLimits(id, layout.work)));
  const eh = effectiveHeight({ collapsed: ws.collapsed, h: rect.h });
  const z = layout.order.indexOf(id) + 1;

  /** The rect as displayed — the stored geometry plus any context-panel stack offset. */
  function shown(r: Rect): Rect {
    return offsetY ? { ...r, y: r.y + offsetY } : r;
  }

  /** Commit a user-positioned state. A context panel the user moved or resized is pinned there
   *  (`placed`) and stops stacking. */
  function commitRect(r: Rect) {
    const s = getWindowState();
    const next: WinState = stateFromRect(s.wins[id], r, s.work);
    setWin(id, isContextPanel(id) ? { ...next, placed: true } : next);
  }

  function paint(r: Rect) {
    const el = frameRef.current;
    if (!el) return;
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
    if (!ws.collapsed) el.style.height = `${r.h}px`;
  }

  function beginGesture(e: React.PointerEvent<HTMLElement>, kind: Gesture["kind"], dir: ResizeDir | null) {
    if (e.button !== 0) return;
    if (kind === "move" && (e.target as HTMLElement).closest("button")) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    // Measure the live rect, not the render-time one — they only differ if a previous gesture's
    // commit hasn't rendered yet, and then the live one is what the user sees.
    const s = getWindowState();
    const r = shown(rectOf(s.wins[id], s.work, winLimits(id, s.work)));
    gestureRef.current = { kind, dir, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, start: r, cur: r, started: kind === "resize", el };
    if (kind === "resize") startVisuals();
    // Deliberately no preventDefault(): that would suppress the compatibility mousedown, which is
    // what open Popovers listen to for outside-click dismissal. Text selection is already off
    // (`user-select: none` on the handles) and the drag shield covers everything else.
  }

  function startVisuals() {
    setDragging(true);
    const el = frameRef.current;
    if (el) el.dataset.moving = "";
  }

  function onGestureMove(e: React.PointerEvent<HTMLElement>) {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (!g.started) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.started = true;
      startVisuals();
      // Window "picked up" — mirrors the marquee's `drag` cue. Move only (matches this cue's
      // "window being picked up" framing from the source mock); resize isn't cued.
      if (g.kind === "move") sfx.play("drag");
    }
    if (!holdRef.current) holdRef.current = sfx.hold();
    const s = getWindowState();
    if (g.kind === "move") {
      const p = snapMove(g.start.x + dx, g.start.y + dy, g.start.w, eh, s.work, s.snap);
      g.cur = { ...g.start, ...p };
    } else {
      g.cur = resizeRect(g.start, g.dir!, dx, dy, s.work, winLimits(id, s.work), s.snap);
    }
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (gestureRef.current) paint(gestureRef.current.cur);
      });
    }
  }

  function endGesture() {
    const g = gestureRef.current;
    gestureRef.current = null;
    holdRef.current?.stop();
    holdRef.current = null;
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (!g) return;
    try { if (g.el.hasPointerCapture(g.pointerId)) g.el.releasePointerCapture(g.pointerId); } catch { /* already gone */ }
    const el = frameRef.current;
    if (el) delete el.dataset.moving;
    setDragging(false);
    if (!g.started) return;
    if (g.kind === "move") sfx.play("drop"); // window "set down" — the drag cue's counterpart
    commitRect(g.cur);
    onMovedRef.current?.(g.kind === "move" ? "move" : "resize");
  }

  function onTitleKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // a title-bar button has focus
    const step = e.shiftKey ? 32 : 8;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const a = arrows[e.key];
    let handled = true;
    if (a && e.altKey) {
      // ⌥Arrows resize from the SE corner.
      if (!ws.collapsed) {
        const s = getWindowState();
        const lim = winLimits(id, s.work);
        commitRect(resizeRect(shown(rectOf(s.wins[id], s.work, lim)), "se", a[0] / (e.shiftKey ? 4 : 1), a[1] / (e.shiftKey ? 4 : 1), s.work, lim, false));
      }
    } else if (a) {
      // A nudge moves the window as displayed (same arithmetic as the store's `moveBy`).
      const s = getWindowState();
      const r = shown(rectOf(s.wins[id], s.work, winLimits(id, s.work)));
      commitRect({ ...r, ...snapMove(r.x + a[0], r.y + a[1], r.w, effectiveHeight({ collapsed: ws.collapsed, h: r.h }), s.work, s.snap) });
    } else if (e.key === "Enter") {
      collapseWin(id);
    } else if (e.key === "Escape" || e.key === "Delete" || e.key === "Backspace") {
      // Esc never closes a window — it is the app's step-back key. It hands focus back to the map.
      (document.activeElement as HTMLElement | null)?.blur();
      document.querySelector<HTMLElement>('[data-viewport-host="map"] canvas')?.focus({ preventScroll: true });
    } else {
      handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  const narrow = rect.w < hideTitleBelow;

  return (
    <div
      ref={frameRef}
      className="vx-win"
      role="dialog" aria-modal="false" aria-label={title}
      data-win={id}
      data-tour={dataTour}
      data-collapsed={ws.collapsed ? "" : undefined}
      style={{
        position: "absolute", left: rect.x, top: rect.y, width: rect.w,
        height: ws.collapsed ? TITLE_H : rect.h, zIndex: z,
      }}
    >
      <div
        className="vx-win-h"
        data-win-title=""
        tabIndex={0}
        aria-expanded={!ws.collapsed}
        title={`${title} — drag to move · double-click to ${ws.collapsed ? "expand" : "collapse"} · arrows move, ⌥arrows resize`}
        onPointerDown={e => beginGesture(e, "move", null)}
        onPointerMove={onGestureMove}
        onPointerUp={endGesture}
        onLostPointerCapture={() => { if (gestureRef.current?.kind === "move") endGesture(); }}
        onDoubleClick={e => { if (!(e.target as HTMLElement).closest("button")) collapseWin(id); }}
        onKeyDown={onTitleKey}
      >
        {rect.w >= ICON_MIN_W && <span style={{ display: "flex", flexShrink: 0 }}><Icon name={icon} size={ICON.xs} tone="default" /></span>}
        {!narrow && <span className="vx-win-t" style={{ color: TEXT, fontSize: FONT.label }}>{title}</span>}
        {!narrow && meta != null && <span className="vx-win-m" style={{ color: TEXT_META, fontSize: FONT.label }}>{meta}</span>}
        <span style={{ flex: 1, minWidth: 0 }} />
        {!ws.collapsed && buttons}
        <WinButton icon={ws.collapsed ? "expandBar" : "collapse"} label={ws.collapsed ? `Expand ${title}` : `Collapse ${title}`}
          onClick={() => collapseWin(id)} />
        {closable && <WinButton icon="close" label={isContextPanel(id) ? `Close ${title}` : `Hide ${title}`} onClick={onClose ?? (() => closeWin(id))} />}
      </div>
      {!ws.collapsed && (
        <>
          <div className="vx-win-b" style={bodyStyle}>{children}</div>
          {resizeDirs.map(d => (
            <div
              key={d} className={`vx-win-rs vx-rs-${d}`} aria-hidden="true"
              onPointerDown={e => beginGesture(e, "resize", d)}
              onPointerMove={onGestureMove}
              onPointerUp={endGesture}
              onLostPointerCapture={() => { if (gestureRef.current?.kind === "resize") endGesture(); }}
            />
          ))}
        </>
      )}
    </div>
  );
}

/** A title-bar button: 18 px, icon-only, stops the press from starting a drag. */
export function WinButton({ icon, label, onClick, active, disabled }: {
  icon: IconName; label: string; onClick: () => void; active?: boolean; disabled?: boolean;
}) {
  return (
    <button
      type="button" className="vx-winbtn" title={label} aria-label={label} aria-pressed={active}
      disabled={disabled}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onClick(); }}
      style={{ borderRadius: RADIUS.sm }}
    >
      <Icon name={icon} size={ICON.xs} tone="inherit" />
    </button>
  );
}
