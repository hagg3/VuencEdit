/**
 * The layer every floating window lives in (UI redesign r3, Stage 14.3). Absolutely positioned over
 * the **work area** — the box between the ribbon (+ Quick Actions bar) and the status bar, left of
 * the docked sidebar — with `overflow: hidden` and its own stacking context (`z-index: 20`), so no
 * window can escape it or overlap the ribbon, sidebar or status bar.
 *
 * ⚠️ The layer itself is `pointer-events: none` (it covers the map); each window frame is `auto`,
 * and so is the drag shield, which only exists while a window drag/resize is live.
 *
 * It measures itself and feeds the size to the store; every window's rendered rect is then derived
 * from its stored anchor for that size (`rectOf`), so the sidebar opening/resizing, the ribbon
 * collapsing, the Quick Actions bar toggling and an OS window resize all reflow every
 * window with no per-cause code.
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { setWork, useWindowLayout } from "./useWindowLayout";

/** Window chrome (proposal.css §"Floating windows"), through theme vars. Opaque surfaces only —
 *  no `backdrop-filter` (WebView2 pays for it per frame over a live WebGL canvas). */
export const WINDOWS_CSS = `
.vx-win { display: flex; flex-direction: column; min-width: 0; pointer-events: auto;
  background: var(--vx-surface-chrome); border-radius: 6px;
  box-shadow: var(--vx-pop-shadow), 0 0 0 1px var(--vx-border-outline), inset 0 1px 0 var(--vx-border-bevel); }
.vx-win[data-moving] { box-shadow: 0 18px 44px rgba(0,0,0,.62), 0 0 0 1px var(--vx-border-outline), 0 0 0 2px rgba(0,164,173,.35); }
.vx-win-h { height: 22px; flex-shrink: 0; display: flex; align-items: center; gap: 6px; padding: 0 3px 0 7px;
  cursor: grab; white-space: nowrap; overflow: hidden; user-select: none; touch-action: none;
  background: var(--vx-surface-body); background-image: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,0));
  box-shadow: inset 0 -1px 0 var(--vx-border-outline), inset 0 1px 0 var(--vx-border-bevel); border-radius: 6px 6px 0 0; }
.vx-win[data-moving] .vx-win-h { cursor: grabbing; }
.vx-win[data-collapsed] .vx-win-h { border-radius: 6px; box-shadow: inset 0 1px 0 var(--vx-border-bevel); }
.vx-win-t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.vx-win-m { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.vx-win-b { flex: 1; min-height: 0; position: relative; display: flex; overflow: hidden; border-radius: 0 0 6px 6px; }
.vx-winbtn { width: 18px; height: 18px; flex-shrink: 0; padding: 0; border: none; cursor: pointer; display: flex;
  align-items: center; justify-content: center; background: transparent; color: var(--vx-text-secondary); }
.vx-winbtn:hover:not(:disabled) { background: var(--vx-lift-bg); box-shadow: var(--vx-lift-shadow); color: var(--vx-text-primary); }
.vx-winbtn:active:not(:disabled) { background: rgba(0,0,0,.25); }
.vx-winbtn[aria-pressed="true"] { background: var(--vx-cur-bg); box-shadow: var(--vx-cur-shadow); color: var(--vx-cur-icon); }
.vx-winbtn:disabled { opacity: .4; cursor: default; }
/* Resize: every edge and corner is live; the SE corner always shows a grip, the others on hover. */
.vx-win-rs { position: absolute; z-index: 3; touch-action: none; }
.vx-rs-n, .vx-rs-s { left: 12px; right: 12px; height: 7px; cursor: ns-resize; } .vx-rs-n { top: -3px; } .vx-rs-s { bottom: -3px; }
.vx-rs-e, .vx-rs-w { top: 12px; bottom: 12px; width: 7px; cursor: ew-resize; } .vx-rs-e { right: -3px; } .vx-rs-w { left: -3px; }
.vx-rs-nw, .vx-rs-ne, .vx-rs-sw, .vx-rs-se { width: 16px; height: 16px; }
.vx-rs-nw { left: -4px; top: -4px; cursor: nwse-resize; } .vx-rs-se { right: -4px; bottom: -4px; cursor: nwse-resize; }
.vx-rs-ne { right: -4px; top: -4px; cursor: nesw-resize; } .vx-rs-sw { left: -4px; bottom: -4px; cursor: nesw-resize; }
.vx-rs-se::after { content: ""; position: absolute; right: 6px; bottom: 6px; width: 9px; height: 9px; pointer-events: none;
  filter: drop-shadow(0 0 1px rgba(0,0,0,.9));
  background: linear-gradient(135deg, transparent 0 42%, rgba(255,255,255,.6) 42% 52%, transparent 52% 66%, rgba(255,255,255,.6) 66% 76%, transparent 76%); }
.vx-rs-nw::after, .vx-rs-ne::after, .vx-rs-sw::after { content: ""; position: absolute; width: 7px; height: 7px; opacity: 0;
  pointer-events: none; border: 0 solid rgba(255,255,255,.55); }
.vx-rs-nw::after { left: 5px; top: 5px; border-left-width: 2px; border-top-width: 2px; }
.vx-rs-ne::after { right: 5px; top: 5px; border-right-width: 2px; border-top-width: 2px; }
.vx-rs-sw::after { left: 5px; bottom: 5px; border-left-width: 2px; border-bottom-width: 2px; }
.vx-win:hover .vx-win-rs::after { opacity: 1; }
.vx-winshield { position: absolute; inset: 0; pointer-events: auto; z-index: 10000; }
/* Walking in the 3D main pane: windows stay visible but let the pointer through (see passThrough). */
.vx-winlayer[data-passthrough] .vx-win { pointer-events: none; opacity: .72; }
`;

export default function WindowLayer({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { dragging, passThrough } = useWindowLayout();

  // Layout effect so the very first paint already uses the real work area, not the store's guess.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWork({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className="vx-winlayer" data-passthrough={passThrough ? "" : undefined} style={{
      position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 20,
    }}>
      <style>{WINDOWS_CSS}</style>
      {children}
      {dragging && <div className="vx-winshield" />}
    </div>
  );
}
