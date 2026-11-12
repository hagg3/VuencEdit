/**
 * Minimise · Maximise/Restore · Close for frameless windows — Windows always, and macOS while
 * Settings ▸ Experiments "Preview Windows title-bar controls" is on (see `windowChrome.ts`).
 *
 * Drawn as the top bar's own button material (`btnBase`), as three separate buttons shaped like the
 * ribbon-collapse button beside them (Close a little wider). The glyphs follow the
 * Windows Aero (Vista/7) caption set — and Photoshop CS6's dark take on it: a low bar, a box with
 * a heavy title-bar top edge, a bold X — filled with a soft top-lit gradient and set off by a dark
 * halo. Close is wider with a faint red cast that gains a soft red glow on hover — the Windows convention
 * for the one destructive control in the title bar.
 *
 * Glyphs are laid out on the *device*-pixel grid (`useDevicePixelRatio`): every edge is a rounded
 * device-pixel coordinate and line weights are whole device pixels, so they stay crisp at 100 %,
 * the fractional Windows scales (125/150/175 %) and 2×, instead of a 1 px CSS stroke smearing
 * across two physical pixels.
 *
 * Close goes through `getCurrentWindow().close()`, i.e. the same `onCloseRequested` path as the OS
 * close button, so App's unsaved-changes guard still runs.
 *
 * Used both in the ribbon's `TopBar` and on the splash screen (top-right corner of the window),
 * so its hover CSS is self-contained rather than scoped under `.eden-ribbon`.
 */
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BTN_RADIUS, DANGER, GRAD_HOVER, SHADOW_HOVER, TEXT, TEXT_DIM, TOPBAR_BTN_H, btnBase, lighten } from "./tokens";
import { RAMP, rgba } from "../theme/theme";

const W_BTN = 26;   // same width as the ribbon-collapse button beside it
const W_CLOSE = 36;

/** Aero's dark glyph halo: a tight soft outline plus a 1 px drop, so the light glyph reads as
 *  embossed on the button face (CS6 did the same on its dark caption buttons). */
const GLYPH_HALO =
  `drop-shadow(0 0 0.75px ${rgba(RAMP.black, 0.7)}) drop-shadow(0 1px 0 ${rgba(RAMP.black, 0.45)})`;

const HOVER_CSS = `
.vx-winbtn { transition: background .09s, box-shadow .09s, color .09s; }
.vx-winbtn:hover { background: ${GRAD_HOVER} !important; box-shadow: ${SHADOW_HOVER} !important; color: ${TEXT} !important; }
.vx-winbtn[data-close="true"]:hover {
  background: linear-gradient(${rgba(DANGER, 0.42)}, ${rgba(DANGER, 0.3)}), ${GRAD_HOVER} !important;
  box-shadow: ${SHADOW_HOVER}, 0 0 8px ${rgba(DANGER, 0.38)}, inset 0 0 0 1px ${rgba(DANGER, 0.45)} !important;
  color: ${lighten(DANGER, 0.5)} !important;
}
`;

export default function WindowControls({ style }: { style?: CSSProperties }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => { win.isMaximized().then(m => { if (alive) setMaximized(m); }).catch(() => {}); };
    sync();
    const un = win.onResized(sync);
    return () => { alive = false; un.then(f => f()); };
  }, []);

  const win = () => getCurrentWindow();
  return (
    <div role="group" aria-label="Window controls" style={{ display: "flex", gap: 3, flexShrink: 0, alignSelf: "center", ...style }}>
      <style>{HOVER_CSS}</style>
      <WinBtn label="Minimise" onClick={() => win().minimize()}>
        {g => <MinGlyph g={g} />}
      </WinBtn>
      <WinBtn label={maximized ? "Restore" : "Maximise"} onClick={() => win().toggleMaximize()}>
        {g => (maximized ? <RestoreGlyph g={g} /> : <MaxGlyph g={g} />)}
      </WinBtn>
      <WinBtn label="Close" close onClick={() => win().close()}>
        {g => <CloseGlyph g={g} />}
      </WinBtn>
    </div>
  );
}

/** `window.devicePixelRatio`, live: re-reads when the window moves to another monitor or the
 *  OS/browser zoom changes (a `resolution` media query only matches the ratio it was built for). */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const on = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [dpr]);
  return dpr;
}

/** Glyph design box, in CSS px at 100 %. */
const GLYPH_W = 10;
const GLYPH_H = 9;

/** Maps the 100 % design grid onto device pixels. `p` rounds a coordinate; `t` is a line weight
 *  that never drops below its 100 % pixel count (so 125 % doesn't thin a 2 px edge to 1). */
type Grid = { s: number; p: (n: number) => number; t: (n: number) => number; fill: string };

function gridFor(dpr: number, fill: string): Grid {
  return {
    s: dpr,
    p: n => Math.round(n * dpr),
    t: n => Math.max(n, Math.round(n * dpr)),
    fill,
  };
}

/** A device-pixel box frame with independent top / side weights, as one even-odd path. */
function framePath(g: Grid, x: number, y: number, w: number, h: number, top: number, side: number): string {
  const x0 = g.p(x), y0 = g.p(y), x1 = g.p(x + w), y1 = g.p(y + h);
  const ts = g.t(side), tt = g.t(top);
  return `M${x0} ${y0}H${x1}V${y1}H${x0}Z M${x0 + ts} ${y0 + tt}V${y1 - ts}H${x1 - ts}V${y0 + tt}Z`;
}

/** Minimise: a low, heavy bar sitting on the glyph's baseline. */
function MinGlyph({ g }: { g: Grid }) {
  const h = g.t(2), x0 = g.p(1), x1 = g.p(9), y1 = g.p(GLYPH_H);
  return <rect x={x0} y={y1 - h} width={x1 - x0} height={h} fill={g.fill} />;
}

/** Maximise: a window outline whose top edge is a thick title bar. */
function MaxGlyph({ g }: { g: Grid }) {
  return <path d={framePath(g, 0.5, 0, 9, 9, 2, 1)} fill={g.fill} fillRule="evenodd" />;
}

/** Restore: two of those windows, the back one peeking out up and to the right. */
function RestoreGlyph({ g }: { g: Grid }) {
  const id = useId();
  const fx = g.p(0), fy = g.p(3), fw = g.p(7), fh = g.p(GLYPH_H) - fy;
  return (
    <>
      <mask id={id} maskUnits="userSpaceOnUse">
        <rect x={0} y={0} width={g.p(GLYPH_W)} height={g.p(GLYPH_H)} fill="white" />
        <rect x={fx} y={fy} width={fw} height={fh} fill="black" />
      </mask>
      <path d={framePath(g, 3, 0, 7, 6, 2, 1)} fill={g.fill} fillRule="evenodd" mask={`url(#${CSS.escape(id)})`} />
      <path d={`M${fx} ${fy}h${fw}v${fh}h${-fw}Z M${fx + g.t(1)} ${fy + g.t(2)}V${fy + fh - g.t(1)}H${fx + fw - g.t(1)}V${fy + g.t(2)}Z`}
        fill={g.fill} fillRule="evenodd" />
    </>
  );
}

/** Close: Aero's bold X — two ~2 px diagonals, antialiased (a diagonal can't be pixel-snapped). */
function CloseGlyph({ g }: { g: Grid }) {
  const x0 = g.p(1), x1 = g.p(9), y0 = g.p(0.5), y1 = g.p(GLYPH_H - 0.5);
  return (
    <path d={`M${x0} ${y0}L${x1} ${y1}M${x1} ${y0}L${x0} ${y1}`}
      stroke={g.fill} strokeWidth={1.9 * g.s} strokeLinecap="butt" fill="none"
      style={{ shapeRendering: "geometricPrecision" }} />
  );
}

function WinBtn({ label, onClick, children, close }: {
  label: string; onClick: () => void; children: (g: Grid) => ReactNode; close?: boolean;
}) {
  const r = BTN_RADIUS;
  const dpr = useDevicePixelRatio();
  const gradId = useId();
  const g = gridFor(dpr, `url(#${CSS.escape(gradId)})`);
  const vw = g.p(GLYPH_W), vh = g.p(GLYPH_H);
  return (
    <button
      className="vx-winbtn" type="button" title={label} aria-label={label} data-close={close || undefined}
      onClick={onClick}
      style={btnBase({
        width: close ? W_CLOSE : W_BTN, height: TOPBAR_BTN_H, padding: 0, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: r,
        color: close ? lighten(DANGER, 0.5) : TEXT_DIM,
        // Close carries a faint red cast at rest, layered over the shared button face.
        ...(close ? { background: `linear-gradient(${rgba(DANGER, 0.2)}, ${rgba(DANGER, 0.1)}), ${btnBase().background}` } : null),
      })}
    >
      {/* Sized in device pixels, displayed at their CSS size: 1 viewBox unit = 1 physical pixel. */}
      <svg width={vw / dpr} height={vh / dpr} viewBox={`0 0 ${vw} ${vh}`} aria-hidden="true"
        style={{ display: "block", overflow: "visible", shapeRendering: "crispEdges", filter: GLYPH_HALO }}>
        <defs>
          {/* Aero's glyph face: brightest at the top, settling ~25 % darker at the foot. */}
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" />
            <stop offset="1" stopColor="currentColor" stopOpacity={0.74} />
          </linearGradient>
        </defs>
        {children(g)}
      </svg>
    </button>
  );
}
