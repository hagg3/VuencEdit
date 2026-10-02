import { encodeU8 } from "./codec";
import { polygonPixels } from "./drawTools";
import {
  type WorldMeta,
  decodeEditResult, decodePreviewData, decodeSelectionMask,
  type SelectionInfo, type ClipboardInfo, type ExtrudeAxis, type AutosaveInfo, type SignInfo,
  classifyWorldFormat,
} from "./types";
import { useRecentWorlds, timeAgo } from "./useRecentWorlds";
import { useState, useCallback, useEffect, useRef, useMemo, useImperativeHandle, forwardRef, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import ConfirmHost, { confirmDialog, useConfirmOpen } from "./ui/confirm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MapCanvas, { KEY_ZOOM_STEP, TOOL_LABELS, TOOL_HINTS, TOOL_ICON, TOOL_FAMILY, type Tool, type ToolFamily, type SelectionBounds, type MapCanvasRef, type MaterializeSelectionBounds } from "./MapCanvas";
import MaterializeModal from "./MaterializeModal";
import Sidebar, { type SidebarTab } from "./Sidebar";
import ToolsWindow from "./windows/ToolsWindow";
import HotbarWindow from "./windows/HotbarWindow";
import { BrushShapePanel, BuildSlotPanel, CutawayPanel } from "./windows/modePanels";
import LensWindow from "./windows/LensWindow";
import { lensArmed, lensToggle } from "./lens/lensMode";
import WindowLayer from "./windows/WindowLayer";
import View3DWindow from "./windows/View3DWindow";
import { createHostNode, InPortal, OutPortal } from "./windows/Reparentable";
import { computePane3dLive, computePlacement } from "./windows/layoutState";
import { useHotbar } from "./hotbar/useHotbar";
import { PickerProvider, usePickerHost } from "./picker/PickerHost";
import {
  closeWorld as closeWindowWorld, collapseWin, getWindowState, loadWorld as loadWindowLayout,
  openWin, resetWindows, saveAs as saveWindowLayoutAs, setDefaultOpts as setWindowDefaultOpts,
  setLensFlags, setPassThrough as setWindowPassThrough, setSnap as setWindowSnap, setSwapped,
  subscribe as subscribeWindows, toggleWin,
} from "./windows/useWindowLayout";
import { normalizePath, worldIdentity } from "./windows/windowStorage";
import FlyView3D, { type Sky3dPrefs, type FlyView3DRef, type Overlay3D, type Interact3D, type GpuInfo, RD_MIN } from "./FlyView3D";
import { bumpPerf, recordRafMs, recordLagMs } from "./perfCounters";
import ErrorBoundary from "./ErrorBoundary";
import HelpModal from "./HelpModal";
import DiagnosticsModal from "./DiagnosticsModal";
import TourOverlay from "./tour/TourOverlay";
import DoneOutline, { type DoneRect } from "./ui/DoneOutline";
import { ContextMenu, type ContextMenuItem } from "./ui/ContextMenu";
import { COMMAND_META } from "./commands/meta";
import { formatChord } from "./commands/keys";
import { useMotionPref } from "./theme/motion";
import { TOUR_STEPS, TOUR_VERSION, type TourCtx } from "./tour/steps";
import AboutModal from "./AboutModal";
import WorldBrowserModal from "./WorldBrowserModal";
import UploadModal from "./UploadModal";
import NewWorldModal from "./NewWorldModal";
import Ribbon, { ribbonHeight, EDEN_TEAL, type RibbonTab, type MapViewMode } from "./Ribbon";
import QuickActionsBar, { QUICK_ACTIONS_BAR_H } from "./QuickActionsBar";
import SettingsModal, { loadSettings, saveSettings, MEMORY_PRESETS, DEFAULTS as SETTINGS_DEFAULTS, deviceAwareDefaultMemoryBudget, type AppSettings, type SettingsTab } from "./SettingsModal";
import WorldInfoModal from "./WorldInfoModal";
import RecoveryModal from "./RecoveryModal";
import { resolvePrefabDir } from "./PrefabLibraryPanel";
import { MODAL_TEXT, recessedWell } from "./designTokens";
import { Icon, type IconName } from "./ribbon/icons";
import {
  SURFACE, BORDER, TEXT, TEXT_DIM, TEXT_LABEL, TEXT_META, TEXT_DANGER, HAIRLINE, TOPBAR_BG,
  ACCENT, FONT, ICON, IS_MAC, RADIUS, SPACE, FOCUS_RING, GRAD_HOVER, GRAD_PRESSED, hexToRgbTriplet,
  btnBase,
} from "./ribbon/tokens";
import { ACCENTS, RAMP, armedRecipe } from "./theme/theme";
import { v } from "./theme/cssVars";
import Dialog, { DialogButton } from "./ui/Dialog";
import { decodeAtlas, tintedSwatch, type AtlasData, clearSwatchCache } from "./texturePack";
import { blockDisplayName, applyBlockTables, orientBlockToFacing, resolveColor, type BlockTables } from "./blockDefs";
import { Segmented, Swatch } from "./ribbon/primitives";
import { isTypingTarget, chunkToWorld } from "./viewportUtils";
import { decomposeMask, maskOutline } from "./maskUtils";
import { sfx } from "./sound/sfx";
import appIcon from "./assets/app-icon.png";
import "./App.css";

/**
 * One long-running backend operation (audit C6/M14). The backend's `long-op` event carries the
 * full shape on the opening event and only the changed fields afterwards; the listener merges
 * them, so `label` and `cancellable` are set for the whole run.
 *
 * `kind` identifies the operation (`"png" | "obj" | "json" | "vox" | "save"`) and is what the
 * overlay keys its copy off; `total` is in whatever unit that operation counts (rows, bytes,
 * permille), so only `pct` is meaningful across all of them.
 */
type LongOpState = {
  id: number;
  kind: string;
  label?: string;
  phase?: string;
  done?: number;
  total?: number;
  pct?: number;
  cancellable?: boolean;
};

/** The error string a cancelled long operation returns — mirrors `LONG_OP_CANCELLED` in lib.rs. */
const LONG_OP_CANCELLED = "Cancelled";

const STATUS_BAR_HEIGHT = 22; // px reserved at the bottom of the window for statusBarEl (14.7: type T.A's 22px minimum)
/** Relief shading strength sent to `set_view_relief` — percent of the backend's `RELIEF_BASE`.
 *  Fixed until the GUI pass decides whether a strength slider earns its ribbon width (13.2). */
const RELIEF_STRENGTH = 100;

// Toasts (see pushToast). Errors linger ~3× longer than status blips — they carry a message the
// user may need to read, not just an acknowledgement of something they just did.
/** The raised-button recipe for plain buttons outside the ribbon (the ribbon's error fallback). */
const btnBaseInline = btnBase();
/** Case-folded path keys for per-world window layouts (NTFS paths are case-insensitive). */
const IS_WINDOWS = typeof navigator !== "undefined" && /Win/.test(navigator.platform);
// Floating-window first-run defaults (UI redesign r3, open question 2): a fresh install opens the
// 3D window unless the device looks low-end — the 3D view is the heaviest viewport, and ROADMAP
// Stages 10/11 are about exactly that on weak Windows machines. Upgraded installs never reach this:
// the v18 settings migration seeds their inherited layout from their old toggles.
setWindowDefaultOpts({
  view3dOpen: deviceAwareDefaultMemoryBudget() !== "low",
  toolsOpen: true,
  toolsCollapsed: false,
});
setWindowSnap(loadSettings().snapWindows);

/** The window-store facts App's render actually depends on, as one primitive — so App re-renders
 *  when the 3D window opens/closes/collapses or the views swap, and *not* on every work-area
 *  measurement, drag start/end or click-to-front (those only re-render the windows themselves).
 *  Indices: 0 swapped, 1 view3d.open, 2 view3d.collapsed, 3 tools.open, 4 hotbar.open,
 *  5 hotbar.collapsed (the last two feed `hotbarWindowOpen`/`showHotbarOverlay`, Stage 14.5),
 *  6 lens.open, 7 lensSelOn (the Lens's two session flags, 20.4: they feed `lensWindowOpen`'s
 *  armed state, with `tool`/`clipboard`/`selection`, which already re-render App on every change). */
/** Send a memory preset's backend-side budgets to Rust: the undo stacks' byte ceiling and the
 *  overview raster's (18.15). Fire-and-forget — both commands clamp, and a failure only means the
 *  backend keeps its Balanced defaults. */
function pushBackendBudgets(preset: AppSettings["memoryBudget"]): void {
  const p = MEMORY_PRESETS[preset];
  invoke("set_undo_budget", { bytes: p.undoBudgetBytes }).catch(() => {});
  invoke("set_overview_budget", { bytes: p.overviewBudgetBytes }).catch(() => {});
}

function windowLayoutKey(): string {
  const s = getWindowState();
  return `${+s.swapped}${+s.wins.view3d.open}${+s.wins.view3d.collapsed}${+s.wins.tools.open}` +
    `${+s.wins.hotbar.open}${+s.wins.hotbar.collapsed}${+s.wins.lens.open}${+s.lensSelOn}`;
}

/** `fresh`: the world was just created by New World — its window layout inherits `last`, never a
 *  same-dims older world matched by identity (16.3). */
type WorldOpenOpts = { skipRecent?: boolean; fresh?: boolean };
type ToastKind = "info" | "error";
type Toast = { id: number; text: string; kind: ToastKind };
const INFO_TOAST_MS = 2500;
const ERROR_TOAST_MS = 8000;
const MAX_TOASTS = 4;
/** Default top of the selection z range (64 layers). Keeps 256z worlds from selecting 4× the voxels by default. */
const DEFAULT_SEL_Z_MAX = 63;
/** Stable empty array for the sign-marker prop — a fresh `[]` each render would churn MapCanvas's
 *  prop-mirroring effects on every App re-render (cursor ticks, FPS, …). */
const NO_SIGNS: SignInfo[] = [];
/** Zoom (px per world block) the map is taken to when focusing a sign from the Inspector — enough
 *  to read the sign's immediate surroundings, not so close that you lose the neighbourhood. */
const SIGN_FOCUS_SCALE = 8;
// Hotbar state/persistence moved to `useHotbar()` (Stage 14.5, `src/hotbar/useHotbar.ts`) —
// verbatim, same localStorage keys, no fork.
// ── splash / launcher chrome ─────────────────────────────────────────────────
// The launcher is styled from `ribbon/tokens` rather than the old warm-brown palette, so the
// pre-world screen and the editor read as one app. Hover/pressed/focus live in a CSS block
// (injected once by the splash branch) because inline styles can't express pseudo-classes —
// the same reason `RIBBON_CSS` exists; this is the splash's own copy since the ribbon shell,
// which injects that one, isn't mounted before a world is loaded.

/** Size cap on the centred launcher card. Below this the card shrinks to the window (the Tauri
 *  window's own minimum is 900×400, tauri.conf.json). */
const SPLASH_MAX_W = 900;
const SPLASH_MAX_H = 550;
/** Fixed width of the launcher's command column. */
const SPLASH_NAV_W = 280;
/** Recent worlds shown before the "More…" disclosure (`MAX_RECENT` is 8, useRecentWorlds.ts). */
const SPLASH_RECENT_COLLAPSED = 5;

const SPLASH_CSS = `
.spl-row {
  display: flex; align-items: center; gap: ${SPACE.lg}px;
  width: 100%; height: 34px; padding: 0 ${SPACE.lg}px;
  background: transparent; border: none; border-radius: ${RADIUS.md}px;
  color: ${TEXT}; font-size: ${FONT.tab}px; text-align: left;
  cursor: pointer; outline: none; user-select: none;
}
.spl-row:hover:not([aria-disabled="true"]) {
  background: ${GRAD_HOVER};
  box-shadow: inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 rgba(255,255,255,.14);
}
.spl-row:active:not([aria-disabled="true"]) {
  background: ${GRAD_PRESSED};
  box-shadow: inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 2px rgba(0,0,0,.45);
}
.spl-row:focus-visible { box-shadow: inset 0 0 0 2px ${FOCUS_RING}; }
.spl-row[aria-disabled="true"] { opacity: .4; cursor: default; }

.spl-recent {
  display: flex; align-items: center; gap: ${SPACE.lg}px;
  width: 100%; padding: ${SPACE.md}px ${SPACE.lg}px;
  background: ${SURFACE.raised}; border: none; border-radius: ${RADIUS.md}px;
  box-shadow: inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel};
  color: ${TEXT}; text-align: left; cursor: pointer; outline: none;
}
.spl-recent:hover:not([aria-disabled="true"]) { background: ${GRAD_HOVER}; }
.spl-recent:active:not([aria-disabled="true"]) { background: ${GRAD_PRESSED}; }
.spl-recent:focus-visible { box-shadow: inset 0 0 0 2px ${FOCUS_RING}; }
.spl-recent[aria-disabled="true"] { opacity: .45; cursor: default; }
`;

/** Uppercase section caption over a hairline — "CREATE / OPEN", "RECENT WORLDS". */
function SplashCaption({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: FONT.label, fontWeight: 600, letterSpacing: "0.08em",
      color: TEXT_LABEL, textTransform: "uppercase",
      padding: `0 ${SPACE.lg}px ${SPACE.md}px`,
      borderBottom: `1px solid ${BORDER.hairline}`,
      marginBottom: SPACE.lg, flexShrink: 0,
    }}>
      {children}
    </div>
  );
}

/**
 * One command row in the left column. Disabled rows stay mounted and inert via `aria-disabled` +
 * `tabIndex={-1}` (the `btnDisabled` convention) rather than the `disabled` attribute, which would
 * also swallow the focus ring.
 */
function SplashCommand({ icon, label, onClick, disabled }: {
  icon: IconName; label: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      className="spl-row"
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={() => { if (!disabled) onClick(); }}
    >
      <Icon name={icon} size={ICON.lg} strokeWidth={1.5} />
      <span>{label}</span>
    </button>
  );
}

/** Plain MAJOR.MINOR.PATCH comparison — matches the `bump-version.sh` format (no pre-release tags),
 *  so nothing fancier than dotted-integer comparison is needed. Missing/non-numeric segments count
 *  as 0, so "1.1" > "1.0.9" behaves sanely even though this project never actually publishes that. */
function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split(".").map(n => parseInt(n, 10) || 0);
  const b = current.split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

function SplashLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href="#"
      onClick={(e) => { e.preventDefault(); openUrl(href); }}
      style={{ color: TEXT_LABEL, textDecoration: "underline" }}
    >
      {children}
    </a>
  );
}

// ── component ────────────────────────────────────────────────────────────────

// Self-contained FPS meter: owns its rAF loop and 1 Hz state update so the
// per-second re-render stays inside this leaf instead of cascading from App.
/**
 * The single modal overlay every long-running operation shares (audit C6/M14) — PNG/OBJ/JSON/VOX
 * export, full save and compressed save, plus the world-load spinner when `op` is null.
 *
 * It replaced four hand-rolled overlays that between them offered six different levels of feedback
 * (a percentage bar, an indeterminate shimmer, two static "Exporting X…" labels) and no Cancel at
 * all. Everything here comes from the backend's `long-op` stream, so adding progress to a new
 * operation is a `LongOps::begin` call and nothing on this side.
 *
 * Styled from `ribbon/tokens` rather than the warm-brown glass it used to use, per H10's
 * "finish the migration" direction.
 */
function LongOpOverlay({ op, onCancel }: { op: LongOpState | null; onCancel: () => void }) {
  const pct = op?.pct ?? null;
  const label = op?.label ?? "Loading world…";
  return (
    <div style={{
      position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.45)", zIndex: 200,
      // Only a cancellable operation needs to receive clicks; everything else stays click-through
      // inert exactly as the old overlay was.
      pointerEvents: op?.cancellable ? "auto" : "none",
    }}>
      <div style={{
        background: SURFACE.popover, border: `1px solid ${BORDER.outline}`,
        borderRadius: RADIUS.lg, padding: "18px 24px", minWidth: 260, textAlign: "center",
        boxShadow: "0 8px 28px rgba(0,0,0,.45)",
      }}>
        <div style={{ color: TEXT, fontSize: FONT.tab, marginBottom: SPACE.md }}>
          {label}{pct !== null ? ` ${pct}%` : "…"}
        </div>
        {op?.phase && (
          <div style={{ color: TEXT_DIM, fontSize: FONT.body, marginBottom: SPACE.md }}>{op.phase}</div>
        )}
        <div style={{
          background: SURFACE.well, borderRadius: RADIUS.sm, height: 6,
          overflow: "hidden", position: "relative",
        }}>
          {pct !== null ? (
            <div style={{
              background: ACCENT.primary, height: "100%", borderRadius: RADIUS.sm,
              width: `${pct}%`, transition: "width 0.12s ease",
            }} />
          ) : (
            <div style={{
              position: "absolute", inset: 0, width: "30%",
              background: `linear-gradient(90deg, transparent, ${ACCENT.primary}, transparent)`,
              animation: "eden-shimmer 1.1s ease-in-out infinite",
            }} />
          )}
        </div>
        {op?.cancellable && (
          <button
            onClick={onCancel}
            style={{
              marginTop: SPACE.lg + 2, background: "transparent",
              border: `1px solid ${BORDER.bevel}`, borderRadius: RADIUS.md,
              color: TEXT_DIM, fontSize: FONT.body, padding: "4px 14px", cursor: "pointer",
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One status-bar segment: an optional leading `ICON.xs` glyph + content, a right hairline divider,
 * fixed to the bar's full height (Stage 14.11 — segments + icons). Shared by the plain App-level
 * segments below and by the imperatively-fed leaves (`CursorHud`/`SelStatusHud`) so both read as
 * one system; the leaves keep owning their own state (see each one's comment) — this component
 * only supplies the shell. `onClick` (15.6) makes the whole segment a click target (Zoom → Fit,
 * Unsaved-changes → Save, the active-block swatch → the picker) without every caller re-deriving
 * the same button-reset styling.
 */
function StatusSeg({
  icon, iconColor, color, title, divider = true, style, children, onClick,
}: {
  icon?: IconName; iconColor?: string; color?: string; title?: string; divider?: boolean;
  style?: React.CSSProperties; children: React.ReactNode; onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div title={title} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}
      style={{
      display: "flex", alignItems: "center", gap: 5, padding: "0 10px", height: "100%",
      borderRight: divider ? `1px solid ${HAIRLINE}` : undefined,
      whiteSpace: "nowrap", color, cursor: onClick ? "pointer" : undefined, ...style,
    }}>
      {icon && <Icon name={icon} size={ICON.xs} tone="inherit" style={{ color: iconColor ?? TEXT_LABEL, flexShrink: 0 }} />}
      {children}
    </div>
  );
}

function FpsCounter() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0; let last = performance.now();
    let rafId: number;
    let prevRaf = last;
    // Event-loop lag probe (17.1): drift of a 250 ms timer. A busy main thread shows high lag; a
    // throttled page (thermal/Low Power) shows ~33 ms rAF intervals with low lag.
    let expect = last + 250;
    const lagTimer = setInterval(() => { const t = performance.now(); recordLagMs(Math.max(0, t - expect)); expect = t + 250; }, 250);
    const tick = (now: number) => {
      recordRafMs(now - prevRaf); prevRaf = now;
      frames++;
      if (now - last >= 1000) { setFps(Math.round(frames * 1000 / (now - last))); frames = 0; last = now; }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(rafId); clearInterval(lagTimer); };
  }, []);
  return <>{fps} fps</>;
}

type CursorBlockInfo = { z: number; bt: number; paint: number };
type CursorHudHandle = {
  setPos: (wx: number, wy: number) => void;
};

// Self-contained status-bar cursor readout: owns its own state so the ~12×/s throttled mouse-move
// tick re-renders only this leaf instead of App (and everything App renders — Ribbon, panels, …).
// Same pattern as FpsCounter/CoordHud (FlyView3D.tsx). Stage 14.11 added the leading icons; Stage
// 15.6 split the Z + block-name half out into `CursorZHud` (its own leaf, rendered elsewhere in the
// bar) so a long block name's width change can no longer shift this X/Y segment — both leaves are
// fed from the same `handleCursorMove` call site. The imperative-leaf contract is unchanged either
// way — no cursor state moved into App.
const CursorHud = forwardRef<CursorHudHandle>((_props, ref) => {
  const [pos, setPos] = useState<{ wx: number; wy: number } | null>(null);
  useImperativeHandle(ref, () => ({
    setPos: (wx, wy) => { setPos({ wx, wy }); },
  }), []);
  return (
    <StatusSeg icon="zoomSel" style={{ minWidth: 116 }}>
      {pos
        ? <>X <span style={{ color: TEXT_DIM }}>{Math.round(pos.wx)}</span>{"  "}Y <span style={{ color: TEXT_DIM }}>{Math.round(pos.wy)}</span></>
        : <span style={{ color: TEXT_META }}>X — Y —</span>
      }
    </StatusSeg>
  );
});

type CursorZHudHandle = { set: (block: CursorBlockInfo | null) => void };

// Status-bar Z + block-name readout (Stage 15.6) — split off CursorHud so the block name's width
// changes no longer shift the X/Y segment to its left. Fed imperatively from the same
// `handleCursorMove` call site as CursorHud, so the same ~12×/s tick re-renders only this leaf.
// Rendered as the LAST left-aligned segment, right before the flex spacer — `flexShrink: 1` +
// the inner span's ellipsis keep a long block name from pushing the FPS readout off the right edge.
const CursorZHud = forwardRef<CursorZHudHandle>((_props, ref) => {
  const [block, setBlock] = useState<CursorBlockInfo | null>(null);
  useImperativeHandle(ref, () => ({
    set: (blk) => { setBlock(blk); },
  }), []);
  if (!block) return null;
  return (
    <StatusSeg icon="zslice" style={{ minWidth: 0, flexShrink: 1 }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
        Z <span style={{ color: TEXT_DIM }}>{block.z}</span>
        {"  "}<span style={{ color: TEXT_LABEL }}>{blockDisplayName(block.bt)}{block.paint > 0 ? <span style={{ color: TEXT_META }}> #{block.paint}</span> : null}</span>
      </span>
    </StatusSeg>
  );
});

// Zoom badge (Stage 15.6): `MapCanvas`'s zoom is purely imperative (`viewRef.current.scale`, no
// React state), so this leaf subscribes to it via `MapCanvasRef.subscribeZoom` — same ref-fan-out
// pattern as the Lens's ghost subscription, and the same "own state, no App re-render" leaf
// contract as CursorHud/SelStatusHud. Click = Fit (mirrors ⌘0 / `view.zoom.fit`'s `resetView()`).
function ZoomStatusSeg({ mapCanvasRef }: { mapCanvasRef: React.RefObject<MapCanvasRef | null> }) {
  const [scalePct, setScalePct] = useState<number | null>(null);
  useEffect(() => {
    const mc = mapCanvasRef.current;
    if (!mc) return;
    const unsub = mc.subscribeZoom(scale => setScalePct(Math.round(scale * 100)));
    return unsub;
    // `mapCanvasRef.current.subscribeZoom` is an imperative ref API stable for the map's whole
    // lifetime, same as LensWindow's subscribeGhost effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapCanvasRef.current]);
  return (
    <StatusSeg icon="fit" style={{ flexShrink: 0 }} title="Zoom. Click to fit the map (⌘0)"
      onClick={() => mapCanvasRef.current?.resetView()}>
      {scalePct !== null ? `${scalePct}%` : "—"}
    </StatusSeg>
  );
}

// Active-block swatch (Stage 15.6): the fill/draw slot App already threads into `PickerProvider`
// and `BlockButton` (Home's own Block button). Must be its own component instance rendered inside
// `statusBarEl` — `usePickerHost()` throws outside a `<PickerProvider>` descendant, and `App`'s own
// function body is an *ancestor* of `PickerProvider`, not a descendant (see PickerHost.tsx's doc
// comment). `togglePicker` reads `e.currentTarget` synchronously inside this onClick, never inside
// a setState updater — the StrictMode rule that doc comment calls out.
function ActiveBlockStatusSeg({
  fillBlockType, fillPaint, texturePack,
}: { fillBlockType: number; fillPaint: number; texturePack: AtlasData | null }) {
  const { togglePicker } = usePickerHost();
  const swatchUrl = texturePack ? tintedSwatch(fillBlockType, fillPaint, texturePack) : null;
  const [r, g, b] = resolveColor(fillBlockType, fillPaint);
  const name = `${blockDisplayName(fillBlockType)}${fillPaint > 0 ? ` #${fillPaint}` : ""}`;
  return (
    <StatusSeg divider={false} style={{ flexShrink: 0 }}
      title={`Active block: ${name}. Click to choose a block and paint.`}
      onClick={e => togglePicker(e, "block-draw")}>
      <Swatch color={`rgb(${r},${g},${b})`} url={swatchUrl} size={12} />
      <span style={{ maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
    </StatusSeg>
  );
}

type SelStatusHudHandle = { setDrag: (rect: SelectionBounds | null) => void };

// Status-bar selection readout. While a marquee drag is in progress it owns the live dimensions in
// its own state (fed imperatively via setDrag), so the pointer-move-rate updates re-render only this
// leaf instead of App (and everything App renders). When no drag is active it falls back to the
// committed selection passed as a prop (which changes only on commit — infrequent). Same leaf pattern
// as CursorHud/FpsCounter.
const SelStatusHud = forwardRef<SelStatusHudHandle, { selection: SelectionInfo | null; zMin: number; zMax: number }>(
  ({ selection, zMin, zMax }, ref) => {
    const [drag, setDrag] = useState<SelectionBounds | null>(null);
    useImperativeHandle(ref, () => ({ setDrag: (r) => setDrag(r) }), []);
    if (drag) {
      return (
        <StatusSeg icon="select" iconColor={ACCENT.selection} color={ACCENT.selection}>
          Sel <span style={{ color: ACCENT.selection }}>
            {Math.round(drag.x2 - drag.x1) + 1}×{Math.round(drag.y2 - drag.y1) + 1}
          </span>
          {" · Z "}<span style={{ color: TEXT_LABEL }}>{zMin}–{zMax}</span>
        </StatusSeg>
      );
    }
    if (selection) {
      return (
        <StatusSeg icon="select" color={TEXT_LABEL}>
          Sel <span style={{ color: TEXT_DIM }}>{selection.width}×{selection.height}</span>
          {selection.masked && selection.cell_count != null && (
            <span style={{ color: ACCENT.violet, marginLeft: 5 }} title="Shaped selection: edits only affect the selected shape">
              ◆ shaped ({selection.cell_count.toLocaleString()} cells)
            </span>
          )}
          {" · Z "}<span style={{ color: TEXT_LABEL }}>{selection.z_min}–{selection.z_max}</span>
        </StatusSeg>
      );
    }
    return null;
  }
);

function App() {
  bumpPerf("appRenders");
  const [world, setWorld] = useState<WorldMeta | null>(null);
  // Live mirror of `world` for []-memoized callbacks (undo/redo → applyEditResult).
  const worldRef = useRef<WorldMeta | null>(null);
  useEffect(() => { worldRef.current = world; }, [world]);
  // Monotonically increments only on full world load; triggers view+selection reset in MapCanvas.
  const [worldEpoch, setWorldEpoch] = useState(0);
  const mapCanvasRef = useRef<MapCanvasRef>(null);
  // Inspector ▸ SIGNS row click: centre the 2D map on the sign and zoom in far enough to read its
  // surroundings, without ever zooming back out from a closer view (see MapCanvasRef.focusOn).
  const focusOnSign = useCallback((s: SignInfo) => {
    mapCanvasRef.current?.focusOn(s.x, s.y, SIGN_FOCUS_SCALE);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /// Audit C6/M14 — one piece of state for every long-running backend operation (PNG/OBJ/JSON/VOX
  /// export, full save, compressed save), fed by the shared `long-op` event. Replaces the six
  /// booleans and two bespoke progress shapes these used to need, and the four hand-rolled
  /// overlays that read them.
  const [longOp, setLongOp] = useState<LongOpState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveCompressed, setSaveCompressed] = useState(() => loadSettings().defaultSaveCompressed);
  const [backupCompressed, setBackupCompressed] = useState(() => loadSettings().backupCompressed);
  const { recentWorlds, addRecentWorld } = useRecentWorlds();
  /** Splash "More…" disclosure — collapsed shows SPLASH_RECENT_COLLAPSED of the MAX_RECENT entries. */
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [ribbonCollapsed, setRibbonCollapsed] = useState(() => {
    try { return localStorage.getItem("ribbon_collapsed") === "true"; } catch { return false; }
  });
  // Opt-in compact command-bar ribbon (UI redesign r3, Stage 14.10) — never the default. Same
  // "individual useState(() => loadSettings()...)" pattern as every other setting; unlike
  // `ribbonCollapsed` (a raw localStorage key, per-session UI state) this is a real `AppSettings`
  // field, so it also flows through `applySettings`.
  const [ribbonCompact, setRibbonCompact] = useState(() => loadSettings().ribbonCompact);
  // The ribbon body is a fixed height now (the drag-resize handle is gone, collapse remains), so
  // this is derived rather than stored. Everything downstream — the
  // sidebar's `topPx`, the Quick Actions bar's `top` — reads it.
  const effectiveRibbonHeight = ribbonHeight(ribbonCollapsed, ribbonCompact);
  // Drop the retired `ribbon_body_height` key on first run so it doesn't linger forever.
  useEffect(() => { try { localStorage.removeItem("ribbon_body_height"); } catch { /* ignore */ } }, []);
  const [checkForUpdatesOnLaunch, setCheckForUpdatesOnLaunch] = useState(() => loadSettings().checkForUpdatesOnLaunch);
  // UI sound cues (Stage 14.12) — same "individual useState(() => loadSettings()...)" pattern as
  // every other setting above; `sfx` itself is a module-level store (cues fire from plain event
  // handlers all over the app, not from rendered components), so this effect is the one sync point.
  const [uiSounds, setUiSounds] = useState(() => loadSettings().uiSounds);
  const [uiSoundPack, setUiSoundPack] = useState(() => loadSettings().uiSoundPack);
  const [uiSoundVolume, setUiSoundVolume] = useState(() => loadSettings().uiSoundVolume);
  useEffect(() => {
    sfx.configure({ enabled: uiSounds, pack: uiSoundPack, volume: uiSoundVolume });
  }, [uiSounds, uiSoundPack, uiSoundVolume]);
  // Motion preference (Stage 14.13) — same mirroring idiom as every other setting above.
  // `useMotionPref` resolves it against the OS's prefers-reduced-motion and writes the result onto
  // `<html data-motion>`, which is the one thing every motion-gated CSS rule in the app reads.
  const [motion, setMotion] = useState<AppSettings["motion"]>(() => loadSettings().motion);
  useMotionPref(motion);
  // Docked right sidebar (Inspector/Prefabs/History) — see Sidebar.tsx. Width persists via
  // the same debounced-localStorage pattern as other drag-driven values (see saveSettingsDebounced).
  const [sidebarOpen, setSidebarOpen] = useState(() => loadSettings().sidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSettings().sidebarWidth);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(() => loadSettings().sidebarTab);
  const sidebarInsetPx = sidebarOpen ? sidebarWidth : 0;
  // Set once by the Ribbon on mount (see its `registerTabSetter` prop) so the Quick Actions bar's
  // "More…" can jump to the Selection tab without lifting the Ribbon's tab state into App.
  const ribbonTabSetterRef = useRef<((t: RibbonTab) => void) | null>(null);
  const registerRibbonTabSetter = useCallback((fn: (t: RibbonTab) => void) => { ribbonTabSetterRef.current = fn; }, []);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);

  // Onboarding coach-mark tour (src/tour/) — auto-fires once per TOUR_VERSION on the first world
  // that loads, replayable any time via Help/AppMenu. See CLAUDE.md's "Onboarding Tour" note.
  const [tourOpen, setTourOpen] = useState(false);
  const tourCheckedRef = useRef(false);
  const startTour = useCallback(() => setTourOpen(true), []);
  const tourCtx = useMemo<TourCtx>(() => ({
    setRibbonTab: (t) => ribbonTabSetterRef.current?.(t),
    setRibbonCollapsed,
    setSidebarOpen,
    setSidebarTab,
    openToolsWindow: () => { openWin("tools"); collapseWin("tools", false); },
    openHotbarWindow: () => { openWin("hotbar"); collapseWin("hotbar", false); },
  }), []);

  // Status bar: cursor world position and FPS. cursorHudRef feeds the leaf CursorHud component
  // directly (see its definition) so the throttled mouse-move tick doesn't re-render all of App.
  const cursorHudRef = useRef<CursorHudHandle>(null);
  // Z + block-name half of the same readout, split into its own leaf (Stage 15.6) — fed from the
  // same handleCursorMove call site as cursorHudRef, see CursorZHud's definition.
  const cursorZHudRef = useRef<CursorZHudHandle>(null);
  const [ctxMenu, setCtxMenu] = useState<{wx:number;wy:number;x:number;y:number}|null>(null);
  const cursorPosThrottleRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const lastCursorCellRef = useRef<{ cx: number; cy: number } | null>(null);
  const [tool, setTool] = useState<Tool>("pan");
  // Live mirror for callbacks captured once (e.g. `windowKeysRef`'s ⌥P → `onToggleLensWindow`)
  // that need the current tool without being re-created every render.
  const toolRef = useRef<Tool>(tool);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  const prevToolRef = useRef<Tool>("pan");
  const [materializeSelection, setMaterializeSelection] = useState<MaterializeSelectionBounds | null>(null);
  const [showMaterializeModal, setShowMaterializeModal] = useState(false);
  // Tool to re-arm when the Space hold-to-pan key is released (null = not holding).
  const spaceReturnToolRef = useRef<Tool | null>(null);
  const [wandMatchPaint, setWandMatchPaint] = useState(true);
  // E2: off by default — dragging/nudging the selection moves only the box, not its blocks.
  const [moveWithContents, setMoveWithContents] = useState(false);
  const moveWithContentsRef = useRef(false);
  useEffect(() => { moveWithContentsRef.current = moveWithContents; }, [moveWithContents]);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const sourcePathRef = useRef<string | null>(null);
  useEffect(() => { sourcePathRef.current = sourcePath; }, [sourcePath]);
  const [recoveryInfo, setRecoveryInfo] = useState<AutosaveInfo | null>(null);
  const [recovering, setRecovering] = useState(false);
  const lastAutosavedEpochRef = useRef(-1);
  // Consecutive `autosave_world` failures across both call sites below (periodic tick + on-quit).
  // A single failure is usually transient (disk momentarily busy); reported via `reportError` only
  // once it's happened twice in a row, since a failed journal append means that tick's changes
  // aren't recoverable and the user should know before it becomes a pattern. Reset to 0 on success.
  const autosaveFailureCountRef = useRef(0);
  // Last "path|compressed" combo we've already warned about for a compressed-flag/extension
  // mismatch on plain Save — avoids re-toasting on every ⌘S while the mismatch is unresolved.
  const lastExtWarnRef = useRef<string | null>(null);

  // Toasts: transient popups, stacked bottom-centre above the status bar. Two kinds —
  // "info" (status summaries after named edit/undo/redo operations, E5) and "error" (every async
  // failure). Errors used to be a single persistent bottom-right banner that overlapped the status
  // bar, silently overwrote its predecessor, and looked identical whether it came from the user's
  // own action or a background autosave tick. As toasts they stack, are red, and auto-dismiss —
  // slower than info toasts, and hovering one holds it open so a long message can be read.
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: number) => {
    const t = toastTimersRef.current.get(id);
    if (t) { clearTimeout(t); toastTimersRef.current.delete(id); }
    setToasts((list) => list.filter((x) => x.id !== id));
    // A manually-dismissed toast should be able to reappear if the same text fires again soon —
    // otherwise dedupe would silently swallow a legitimate repeat the user already closed.
    if (lastToastRef.current?.id === id) lastToastRef.current = null;
  }, []);

  const armToastTimer = useCallback((id: number, ms: number) => {
    const prev = toastTimersRef.current.get(id);
    if (prev) clearTimeout(prev);
    toastTimersRef.current.set(id, setTimeout(() => dismissToast(id), ms));
  }, [dismissToast]);

  // L2: the same text within a short window refreshes the existing toast's timer instead of pushing a
  // duplicate underneath it. Blunts H1's per-stamp toast spam even where the group id doesn't reach here.
  const lastToastRef = useRef<{ text: string; kind: ToastKind; id: number; at: number } | null>(null);
  const TOAST_DEDUPE_MS = 1500;

  const pushToast = useCallback((text: string, kind: ToastKind) => {
    const now = Date.now();
    // Info toasts are one-line status summaries — a fixed 2.5s is fine for "Filled 40 blocks" but
    // cuts off mid-read for a longer one. Scale mildly with length past a baseline, capped so a
    // very long message doesn't linger forever (error toasts already stay parked on hover).
    const ms = kind === "error" ? ERROR_TOAST_MS
      : Math.min(INFO_TOAST_MS * 2.4, INFO_TOAST_MS + Math.max(0, text.length - 30) * 35);
    const last = lastToastRef.current;
    if (last && last.text === text && last.kind === kind && now - last.at < TOAST_DEDUPE_MS) {
      lastToastRef.current = { ...last, at: now };
      armToastTimer(last.id, ms);
      return last.id;
    }
    const id = ++toastIdRef.current;
    // Cap the stack — a failing background tick could otherwise queue toasts indefinitely.
    setToasts((list) => [...list.slice(-(MAX_TOASTS - 1)), { id, text, kind }]);
    armToastTimer(id, ms);
    lastToastRef.current = { text, kind, id, at: now };
    // Piggy-backs this function's own dedupe above — a repeat of the same error within
    // TOAST_DEDUPE_MS refreshes the existing toast's timer and returns before here, so it doesn't
    // re-fire the cue either.
    if (kind === "error") sfx.play("error");
    return id;
  }, [armToastTimer]);

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); };
  }, []);

  const showToast = useCallback((text: string) => { pushToast(text, "info"); }, [pushToast]);

  /**
   * Report an async failure. Shows a red toast, and records the message in `error` — which the
   * splash/launcher screen (the `!world` branch, where there is no toast layer) renders inline.
   * Every `catch` in App goes through this; don't call `setError` directly.
   */
  const reportError = useCallback((e: unknown) => {
    const msg = String(e);
    setError(msg);
    pushToast(msg, "error");
  }, [pushToast]);

  /**
   * `reportError`, except that a user-requested cancel is not an error (audit C6/M14). Every
   * cancellable long operation returns the literal string `"Cancelled"` when the user hits Cancel;
   * raising a red toast for something they just asked for would be noise.
   */
  const reportExportError = useCallback((e: unknown) => {
    if (String(e).includes(LONG_OP_CANCELLED)) return;
    reportError(e);
  }, [reportError]);

  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Tab Settings opens on — reset to General on every plain open, set by ⌘K "Sound Settings…".
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const openSettingsTab = useCallback((t: SettingsTab) => { setSettingsTab(t); setShowSettings(true); }, []);
  const [showWorldInfo, setShowWorldInfo] = useState(false);
  const [prefabNameModal, setPrefabNameModal] = useState(false);
  const [prefabNameInput, setPrefabNameInput] = useState("");
  const [prefabSaving, setPrefabSaving] = useState(false);
  const [prefabOverwrite, setPrefabOverwrite] = useState(false); // armed after an existing-name warning
  const [prefabRefreshToken, setPrefabRefreshToken] = useState(0);
  const [appVersion, setAppVersion] = useState("…");
  useEffect(() => { getVersion().then(setAppVersion); }, []);
  // Splash-screen update check (github.com/hagg3/VuencEdit/releases). Runs once per launch when the
  // toggle is on; silent-fail on any error (offline, rate-limited, malformed response) — no toast, no
  // banner. Dismissing the banner is session-only by design (no persisted "seen this version" flag),
  // so it reappears on every subsequent launch until the user updates or turns the toggle off.
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion: string; releaseUrl: string } | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => {
    if (!checkForUpdatesOnLaunch) return;
    let cancelled = false;
    (async () => {
      try {
        const current = await getVersion();
        const info = await invoke<{ latestVersion: string; releaseUrl: string }>("check_for_update");
        if (!cancelled && isNewerVersion(info.latestVersion, current)) setUpdateInfo(info);
      } catch {
        // Silent-fail — see comment above.
      }
    })();
    return () => { cancelled = true; };
  }, [checkForUpdatesOnLaunch]);
  // Fetch canonical block/paint colour tables from Rust once at startup so TS
  // swatch tints match the map/3D render exactly (C6 — ends dual-maintenance drift).
  useEffect(() => {
    invoke<BlockTables>("get_block_tables")
      .then((t) => { applyBlockTables(t); clearSwatchCache(); })
      .catch(() => {}); // fallback tables in blockDefs.ts keep the picker usable
  }, []);
  const winKey = useSyncExternalStore(subscribeWindows, windowLayoutKey, windowLayoutKey);
  const layoutInputs = {
    swapped: winKey[0] === "1",
    view3dOpen: winKey[1] === "1",
    view3dCollapsed: winKey[2] === "1",
  };
  // Suppress FlyView3D's in-pane build hotbar overlay while the floating Hotbar window is open and
  // expanded (Stage 14.5) — no duplicate hotbar on screen.
  const showHotbarOverlay = !(winKey[4] === "1" && winKey[5] !== "1");
  // The ONE definition of "the 3D view is on screen" (layoutState.ts): overlays, the mode reset, the
  // context menu's camera commands, … all read it.
  const pane3dLive = computePane3dLive(layoutInputs);
  const placement = computePlacement(layoutInputs);
  const swapped = layoutInputs.swapped;
  // Map and FlyView3D are each rendered ONCE into a detached host node and *moved* between the main
  // pane and the 3D window (windows/Reparentable.tsx) — so neither ever remounts, and the 3D
  // canvas's WebGL context survives every swap.
  const [mapHost] = useState(() => createHostNode("map"));
  const [flyHost] = useState(() => createHostNode("fly"));
  // Latch: has the 3D pane been live at least once this session? Once true, FlyView3D stays
  // *mounted* (in `flyHost`, placed or detached) and is suspended rather than torn down — Stage 4 of
  // the 3D-pane crash fix. Destroying and recreating a WebGL context per toggle walks WKWebView
  // toward its live-context ceiling; a suspended pane disposes all its geometry and parks its loops,
  // so keeping it costs a bare context. Never reset — a world close unmounts the whole editor branch.
  // A ref rather than state: it's a monotone latch that only ever flips during a render that's
  // already happening (the one where the pane turns on), so it never needs to schedule one.
  const mounted3dRef = useRef(false);
  if (pane3dLive) mounted3dRef.current = true;
  const mounted3d = mounted3dRef.current;
  // Moving a viewport's host node drops a pointer lock and leaves the map's cached client rect
  // stale, so a swap leaves mouselook first and re-measures after.
  const swapViews = useCallback(() => {
    flyView3dRef.current?.exitLook();
    setSwapped(!getWindowState().swapped);
    requestAnimationFrame(() => mapCanvasRef.current?.invalidateRect());
  }, []);
  // View ▸ Windows ▸ Lens / ⌥P / the Lens's ✕ (20.4, `lens/lensMode.ts`): flips the flag of the
  // mode that's showing; with nothing showing, turns both flags on (or both off). Turning it on with
  // nothing to show gets an explanatory toast instead of silently doing nothing visible.
  const onToggleLensWindow = useCallback(() => {
    const s = getWindowState();
    const r = lensToggle({
      pasteArmed: toolRef.current === "paste" && !!clipboardRef.current,
      hasSelection: rawBoundsRef.current != null,
      pasteOn: s.wins.lens.open, selOn: s.lensSelOn,
    });
    setLensFlags(r);
    if (r.announce) pushToast("Lens on. It appears when you select or paste.", "info");
  }, [pushToast]);
  // Key → action for the ⌥ window shortcuts, read by the keydown handler. Every action goes through
  // refs / stable callbacks, so the table itself never needs re-pointing.
  const windowKeysRef = useRef<Record<string, () => void>>({
    Digit3: () => toggleWin("view3d"),
    KeyT: () => toggleWin("tools"),
    KeyH: () => toggleWin("hotbar"),
    KeyP: () => onToggleLensWindow(),
  });
  const swapViewsRef = useRef(swapViews);
  // Mouselook in the 3D view while it is the *main* pane: floating windows go click-through, so the
  // hidden/frozen look-mode cursor can't land clicks or hover on a window floating over the 3D
  // view. And any move of a viewport host leaves look mode first — belt and
  // braces over swapViews, since ⌥3, a window's ✕/collapse and a world's restored
  // layout can move the 3D canvas too, and moving a grabbed/pointer-locked canvas is how the
  // cursor ends up frozen.
  // Only *mouselook* makes windows click-through: it grabs and hides the cursor. Fly mode leaves the
  // cursor free, and making windows click-through there sent map clicks to the 3D view and faded
  // every window to 72 % over the sky (the "blue tint, no map" report, 2026-09-27).
  const [looking3d, setLooking3d] = useState(false);
  useEffect(() => { setWindowPassThrough(looking3d && placement.main === "fly"); }, [looking3d, placement.main]);
  // A press on the map while the 3D camera is flying drops the camera back to orbit, so the map gets
  // the click *and* the keyboard (fly mode holds WASD and suspends the editor's shortcuts). Native
  // capture listener on the host node: the map may sit in a window, and React events follow the
  // React tree rather than the DOM (see Reparentable.tsx).
  useEffect(() => {
    const onDown = () => { if (flyActiveRef.current) flyView3dRef.current?.exitWalk(); };
    mapHost.addEventListener("pointerdown", onDown, true);
    return () => mapHost.removeEventListener("pointerdown", onDown, true);
  }, [mapHost]);
  useEffect(() => { flyView3dRef.current?.exitLook(); }, [placement.main, placement.window]);
  const [fogEnabled, setFogEnabled] = useState(() => loadSettings().enableFog);
  // Night lighting / shadow previews + the GPU shadow map for FlyView3D (see CLAUDE.md). `lightEpoch`
  // bumps whenever the baked ones change, driving a chunk-mesh reload (same mechanism as texEpoch).
  // These are the perf-heavy 3D lighting modes (⚡ badged in the Ribbon): deliberately **session-only,
  // always off at startup** (not seeded from persisted settings) and reset off on every world load/
  // close via `resetHeavyLighting()` — a heavy GPU mode must never silently persist across worlds.
  const [nightLighting, setNightLighting] = useState(false);
  const [shadows3d, setShadows3d] = useState(false);
  // Opt-in real GPU shadow map (H5) — replaces the baked night/shadow preview with a lit material +
  // directional sun + shadow map in FlyView3D. Independent of nightLighting/shadows3d; when on it
  // overrides them. Doesn't drive lightEpoch reloads: FlyView3D rebuilds meshes off the prop change.
  const [gpuShadows, setGpuShadows] = useState(false);
  // resetHeavyLighting() is a plain function called from load/close paths that don't re-run on every
  // render — it reads the live values through refs rather than a stale closure.
  const nightLightingRef = useRef(false); nightLightingRef.current = nightLighting;
  const shadows3dRef     = useRef(false); shadows3dRef.current     = shadows3d;
  const gpuShadowsRef    = useRef(false); gpuShadowsRef.current    = gpuShadows;
  // Committed sun angle. The drag-time display value lives in the Ribbon (see its zSliceDisplay/
  // sunTDisplay/lampRadiusDisplay local state) so a slider drag re-renders only the Ribbon subtree;
  // only the committed value here triggers the (expensive) chunk reload / lightEpoch bump.
  const [sunT, setSunT] = useState(() => loadSettings().sunT);
  // Lamp light radius (blocks) for night lighting. Same committed-only pattern as sunT.
  const [lampRadius, setLampRadius] = useState(() => loadSettings().lampRadius);
  // Legacy vs Modern/New Dawn lamp falloff (see FlyView3D's LightingProfile / export.rs's
  // LightingProfile). Independent of lampRadius — the profile picks the falloff curve *and* the
  // radius a switch snaps to; the slider can still override the radius afterward.
  const [lightingProfile, setLightingProfile] = useState<"legacy" | "modern">(() => loadSettings().lightingProfile);
  const [lightEpoch, setLightEpoch] = useState(0);
  useEffect(() => { setLightEpoch(e => e + 1); }, [nightLighting, shadows3d, sunT, lampRadius, lightingProfile]);
  // Force the perf-heavy 3D lighting modes off — called on every world load/close so none of them
  // carry over to a different world (they're Ribbon-only session toggles, never persisted).
  // Turning these off on every world load/close is deliberate (they're perf-heavy and must never
  // silently carry into a new world), but doing it silently reads as the toggle being broken —
  // say so, and only when one was actually on.
  function resetHeavyLighting() {
    if (nightLightingRef.current || shadows3dRef.current || gpuShadowsRef.current) {
      showToast("3D lighting was turned off for the new world. Turn it on in the 3D tab.");
    }
    setNightLighting(false);
    setShadows3d(false);
    setGpuShadows(false);
  }
  function commitSunT(t: number) {
    setSunT(t);
    saveSettings({ sunT: t });
  }
  function commitLampRadius(r: number) {
    setLampRadius(r);
    saveSettings({ lampRadius: r });
  }
  // Switching profile snaps the radius to that profile's default (spec'd behavior) — the user can
  // still drag Lamp R afterward to override it, same as picking a fresh baseline.
  const LEGACY_LAMP_RADIUS = 4;
  const MODERN_LAMP_RADIUS = 14;
  function commitLightingProfile(profile: "legacy" | "modern") {
    setLightingProfile(profile);
    const r = profile === "modern" ? MODERN_LAMP_RADIUS : LEGACY_LAMP_RADIUS;
    setLampRadius(r);
    saveSettings({ lightingProfile: profile, lampRadius: r });
  }
  // Persisted 3D fly-view render distance + fly speed (seed FlyView3D; written back as the user adjusts).
  const [renderDistance, setRenderDistance] = useState(() => loadSettings().renderDistance);
  const [flySpeed, setFlySpeed] = useState(() => loadSettings().flySpeed);
  // Persisted mouse-look tuning — only editable from Settings (no in-pane slider), so these only
  // need to flow one direction: seed on load, reapply on Settings Save/Reset.
  const [lookSensitivity, setLookSensitivity] = useState(() => loadSettings().lookSensitivity);
  const [dragSensitivity, setDragSensitivity] = useState(() => loadSettings().dragSensitivity);
  const [invertY, setInvertY] = useState(() => loadSettings().invertY);
  const [autosaveIntervalMin, setAutosaveIntervalMin] = useState(() => loadSettings().autosaveIntervalMin);
  const [autoOrient3d, setAutoOrient3d] = useState(() => loadSettings().autoOrient3d);
  // 3D pane look prefs (Stage 15.8): sky gradient, fog colour/model, HUD + floor-grid visibility.
  // Editor-only viewer settings, persisted as flat AppSettings keys; the pane edits them in place
  // (its `…` menu) via `onSky3dChange`, the ribbon's 3D ▸ Camera toggles via `setShow3dHud/Grid`.
  const [sky3d, setSky3d] = useState<Sky3dPrefs>(() => {
    const s = loadSettings();
    return { zenith: s.sky3dZenith, horizon: s.sky3dHorizon, fogColor: s.fog3dColor, fogSoft: s.fog3dSoft };
  });
  const [show3dHud, setShow3dHud] = useState(() => loadSettings().show3dHud);
  const [show3dGrid, setShow3dGrid] = useState(() => loadSettings().show3dGrid);
  const [floodFillLimit, setFloodFillLimit] = useState(() => loadSettings().floodFillLimit);
  const [buildReach, setBuildReach] = useState(() => loadSettings().buildReach);
  // Memory-budget preset (§6 of the 2026-08 memory-efficiency pass) — the undo and overview-raster
  // budgets reach Rust (`pushBackendBudgets` below); tile/vertex budgets stay frontend-side as
  // MapCanvas/FlyView3D props.
  const [memoryBudget, setMemoryBudget] = useState<AppSettings["memoryBudget"]>(() => loadSettings().memoryBudget);
  // 3D perf HUD toggle (ROADMAP-EDIT Stage 9.3/9.4). Only the overlay follows it: since 17.1 the
  // histogram/counter recorders sample always (see perfCounters.ts).
  const [showPerfHud, setShowPerfHud] = useState(() => loadSettings().showPerfHud);
  // Push the backend budgets once at startup (Rust's WorldState default is already "balanced", but a
  // saved Low/High preset must apply before the user's first edit or zoom-out, not just after their
  // next Save).
  useEffect(() => {
    pushBackendBudgets(memoryBudget);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Debounces the localStorage write only (state stays live so the slider/HUD track immediately) —
  // dragging the render-distance slider fires an onChange per pixel, and saveSettings() does a full
  // loadSettings() (JSON.parse) + JSON.stringify round-trip; without this a drag gesture does dozens
  // of synchronous localStorage round-trips for a value that only needs to persist once released.
  const saveSettingsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function saveSettingsDebounced(patch: Partial<AppSettings>) {
    if (saveSettingsDebounceRef.current) clearTimeout(saveSettingsDebounceRef.current);
    saveSettingsDebounceRef.current = setTimeout(() => saveSettings(patch), 250);
  }
  // Stage 15.8 — 3D look prefs. `changeSky3d` takes a partial patch (a colour swatch drag fires
  // per-frame, so persistence rides the same 250 ms debounce as the other drag-driven settings; a
  // multi-key patch — "match fog", ↺ reset — lands as one write).
  const changeSky3d = useCallback((patch: Partial<Sky3dPrefs>) => {
    setSky3d(cur => ({ ...cur, ...patch }));
    const out: Partial<AppSettings> = {};
    if (patch.zenith !== undefined) out.sky3dZenith = patch.zenith;
    if (patch.horizon !== undefined) out.sky3dHorizon = patch.horizon;
    if ("fogColor" in patch) out.fog3dColor = patch.fogColor ?? null;
    if (patch.fogSoft !== undefined) out.fog3dSoft = patch.fogSoft;
    saveSettingsDebounced(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saveSettingsDebounced only touches a ref
  }, []);
  const commitShow3dHud = useCallback((v: boolean) => { setShow3dHud(v); saveSettings({ show3dHud: v }); }, []);
  const commitShow3dGrid = useCallback((v: boolean) => { setShow3dGrid(v); saveSettings({ show3dGrid: v }); }, []);
  // Stage 10.3 — FlyView3D's one-time software-renderer verdict. Runs at most once per install
  // (gated on `potatoProfileApplied`, not a session flag, so it survives a relaunch): if render
  // distance and memory preset are still both at their stock defaults, lower them to the "potato
  // profile" (RD_MIN, Low) and say so; otherwise the user already made an explicit choice and this
  // only shows the notice — it must be a default, not a clamp (migrate()'s own contract).
  const handleSoftwareRenderingDetected = useCallback((info: GpuInfo) => {
    const s = loadSettings();
    if (s.potatoProfileApplied) return;
    const untouched = s.renderDistance === SETTINGS_DEFAULTS.renderDistance && s.memoryBudget === SETTINGS_DEFAULTS.memoryBudget;
    if (untouched) {
      const next: AppSettings = { ...s, renderDistance: RD_MIN, memoryBudget: "low", potatoProfileApplied: true };
      applySettings(next);
      saveSettings(next);
      showToast(`Software rendering detected (${info.renderer}). 3D render distance and memory use were lowered. You can raise them in Settings ▸ 3D View, but 3D will be slow.`);
    } else {
      saveSettings({ potatoProfileApplied: true });
      showToast(`Software rendering detected (${info.renderer}), so 3D will be slow. Lower the render distance or memory budget in Settings.`);
    }
  }, [showToast]);

  // Shared SettingsModal onSave handler — splash screen and in-editor Settings modals both need
  // the full set of setters applied identically (they drifted once when only one site was updated).
  function applySettings(s: AppSettings) {
    setWindowSnap(s.snapWindows);
    setSaveCompressed(s.defaultSaveCompressed);
    setBackupCompressed(s.backupCompressed);
    setFogEnabled(s.enableFog);
    setRibbonCompact(s.ribbonCompact);
    setCheckForUpdatesOnLaunch(s.checkForUpdatesOnLaunch);
    setUiSounds(s.uiSounds);
    setUiSoundPack(s.uiSoundPack);
    setUiSoundVolume(s.uiSoundVolume);
    setMotion(s.motion);
    setSunT(s.sunT);
    setLampRadius(s.lampRadius);
    setLightingProfile(s.lightingProfile);
    setRenderDistance(s.renderDistance);
    setFlySpeed(s.flySpeed);
    setLookSensitivity(s.lookSensitivity);
    setDragSensitivity(s.dragSensitivity);
    setInvertY(s.invertY);
    setAutosaveIntervalMin(s.autosaveIntervalMin);
    setAutoOrient3d(s.autoOrient3d);
    setSky3d({ zenith: s.sky3dZenith, horizon: s.sky3dHorizon, fogColor: s.fog3dColor, fogSoft: s.fog3dSoft });
    setShow3dHud(s.show3dHud);
    setShow3dGrid(s.show3dGrid);
    setFloodFillLimit(s.floodFillLimit);
    setBuildReach(s.buildReach);
    setMemoryBudget(s.memoryBudget);
    setShowPerfHud(s.showPerfHud);
    pushBackendBudgets(s.memoryBudget);
    if (s.templatePath !== templatePath) setTemplatePath(s.templatePath);
    if (s.texturePackPath !== texturePackPath) {
      if (s.texturePackPath) loadTexturePackFile(s.texturePackPath);
      else unloadTexturePack();
    }
  }
  const flyActiveRef = useRef(false); // true while FlyView3D fly mode is active — blocks global shortcuts
  const flyView3dRef = useRef<FlyView3DRef>(null);

  // Stage 10.2: the 3D camera's world position streams at ~3.3Hz while the camera moves. It used
  // to be React state (`setCam3dPos`), which re-rendered the entire editor tree — Ribbon's ~190
  // prop bag, MapCanvas, Sidebar, FlyView3D's own overlay JSX — on every tick, precisely while the
  // user is trying to move the camera. It's now a plain ref: MapCanvas.setCameraDot() updates the
  // on-map dot imperatively (see MapCanvas.tsx), and `hasCam3dPos` is a rarely-changing boolean
  // (flips false→true once) purely to gate the "Centre Map on 3D Camera" context-menu item.
  const cam3dPosRef = useRef<{ x: number; y: number } | null>(null);
  const [hasCam3dPos, setHasCam3dPos] = useState(false);
  const [showWorldBrowser, setShowWorldBrowser] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showNewWorld, setShowNewWorld] = useState(false);
  const [spawnPos, setSpawnPos] = useState<{ px: number; py: number } | null>(null);
  // `pos` (header bytes 4–15) — the last-walked player position, a *different* field from `home`
  // (16–27). Home ▸ Set Point writes one each; see `set_player_pos` / `set_spawn_pos` in lib.rs.
  const [playerPos, setPlayerPos] = useState<{ px: number; py: number } | null>(null);
  // Signs (256z-format plan, Phase 4) — fetched once per world load, read-only. Empty for the
  // overwhelming majority of worlds, which have none.
  const [signs, setSigns] = useState<SignInfo[]>([]);
  // Sign markers on the 2D map. Deliberately session state, not an AppSettings key: it re-arms to
  // ON for every world opened (see applyLoadedWorld) so signs are never silently missing on a
  // world you've just opened, while still being switchable off for a session (View ▸ Layout).
  const [showSigns, setShowSigns] = useState(true);
  const cursorWorldRef = useRef<{ wx: number; wy: number }>({ wx: 0, wy: 0 });

  // Template overlay state
  const [templateLoaded, setTemplateLoaded] = useState(false);
  const [templatePath, setTemplatePath] = useState<string | null>(() =>
    loadSettings().templatePath
  );
  const [showTemplateOverlay, setShowTemplateOverlay] = useState(false);
  const [showExpandModal, setShowExpandModal] = useState(false);
  const [expandFullExtent, setExpandFullExtent] = useState(true);
  const [expandInProgress, setExpandInProgress] = useState(false);
  const [expandProgress, setExpandProgress] = useState(0);
  const [expandResult, setExpandResult] = useState<{ chunksAdded: number; totalChunks: number } | null>(null);

  // Texture pack state
  const [texturePackPath, setTexturePackPath] = useState<string | null>(() => loadSettings().texturePackPath);
  const [texturePackInfo, setTexturePackInfo] = useState<AtlasData | null>(null);
  const [texEpoch, setTexEpoch] = useState(0);

  const [renamingWorld, setRenamingWorld] = useState(false);
  const [renameInput, setRenameInput] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [clipboard, setClipboard] = useState<ClipboardInfo | null>(null);
  const clipboardRef = useRef<ClipboardInfo | null>(null);
  useEffect(() => { clipboardRef.current = clipboard; }, [clipboard]);
  const [pasteElevationOffset, setPasteElevationOffset] = useState(0);
  const [pasteIgnoreAir, setPasteIgnoreAir] = useState(false);
  const [persistPaste, setPersistPaste] = useState(false);
  const [pasteTerrain, setPasteTerrain] = useState(false);
  const [pasteTerrainAbove, setPasteTerrainAbove] = useState(true);
  const [lockedPastePos, setLockedPastePos] = useState<{ x: number; y: number } | null>(null);
  const lockedPastePosRef = useRef<{ x: number; y: number } | null>(null);
  const [editEpoch, setEditEpoch] = useState(0);
  const editEpochRef = useRef(0);
  useEffect(() => {
    editEpochRef.current = editEpoch;
    // An edit can repaint the block under a stationary cursor — invalidate the cached cell so the
    // next mouse-move tick re-queries get_cursor_block instead of trusting the stale "same cell"
    // skip in handleCursorMove.
    lastCursorCellRef.current = null;
  }, [editEpoch]);
  // editEpoch value at the last load or manual Save. The world is "dirty" (has unsaved edits) when
  // the live editEpoch has moved past it. Autosave deliberately does NOT update this — an autosave
  // is a crash-safety copy, not a save to the user's file, so it must not suppress the close prompt.
  const savedEpochRef = useRef(0);
  const isDirty = useCallback(() => editEpochRef.current !== savedEpochRef.current, []);
  // Last time anything actually landed on disk — a manual Save or a periodic/quit autosave (Stage
  // 15.6's status-bar "Saved"/"Edited" segment). Purely a display timestamp, not part of the dirty
  // check above (which stays keyed off editEpoch vs. savedEpochRef, autosave included or not).
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // World bounds of the most recent edit (top-down X/Y) — FlyView3D's edit-sync reads it.
  const [lastEditBounds, setLastEditBounds] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // Completion outline (Stage 14.13) — a fresh object (and incrementing `key`) per user-initiated
  // edit, so `DoneOutline`'s effect restarts even when back-to-back edits touch the same rect.
  const doneOutlineKeyRef = useRef(0);
  const [doneRect, setDoneRect] = useState<DoneRect | null>(null);
  // Selection-commit flash (Stage 19.6): accent-toned, for marquee and magic-wand commits only
  // (not ⌘A, which would flash the whole world's edge).
  const flashSelection = useCallback((r: { x1: number; y1: number; x2: number; y2: number }) => {
    doneOutlineKeyRef.current += 1;
    setDoneRect({ key: doneOutlineKeyRef.current, tone: "select", x: r.x1, y: r.y1, w: r.x2 - r.x1 + 1, h: r.y2 - r.y1 + 1 });
  }, []);

  const [extrudeCount, setExtrudeCount] = useState(0);
  const [extrudeAxis, setExtrudeAxis]   = useState<ExtrudeAxis>("z+");
  const [extrudeOpen, setExtrudeOpen]   = useState(false);

  const [brushSize,    setBrushSize]    = useState(3);
  const [brushShape,   setBrushShape]   = useState<"sq" | "circ">("sq");
  const [drawFilled,   setDrawFilled]   = useState(true);
  const [drawAbove,    setDrawAbove]    = useState(false);
  const [sprayDensity, setSprayDensity] = useState(0.35); // spray/scatter fraction of footprint
  const [strokeStabilizer, setStrokeStabilizer] = useState(false); // low-pass freehand path
  // Gradient fill (Selection tab): blend the current fill block → a second block across an axis
  const [gradientToBlock, setGradientToBlock] = useState(2); // stone
  const [gradientToPaint, setGradientToPaint] = useState(0);
  const [gradientAxis, setGradientAxis] = useState<"x" | "y" | "z">("y");
  const [gradientIncludeAir, setGradientIncludeAir] = useState(false);

  // Sculpt tools
  const [sculptStrength, setSculptStrength] = useState(2);
  const [sculptRadius, setSculptRadius] = useState(6); // brush radius in blocks (dedicated; not draw brush size)
  const [sculptSoftness, setSculptSoftness] = useState(0.6); // 0 = hard edges, 1 = full radial dome
  const [sculptProfile, setSculptProfile] = useState<"smooth" | "linear" | "sphere" | "sharp">("smooth");
  const [sculptAccumulate, setSculptAccumulate] = useState(true); // Live brush (Row 6): live batched stamps, default ON
  const [sculptClipToSelection, setSculptClipToSelection] = useState(false); // constrain strokes to selection
  const [noiseMode, setNoiseMode] = useState<"hills" | "mountains">("hills");
  const [noiseFeatureSize, setNoiseFeatureSize] = useState(24); // blocks per feature; freq = 1/size
  // Slope tool: plane tilt as a percent grade (rise per 100 blocks of run) along each axis; sent
  // to the backend as a fraction (value/100 = rise per block).
  const [slopeGradeX, setSlopeGradeX] = useState(20);
  const [slopeGradeY, setSlopeGradeY] = useState(0);
  // Rock/Carve tools (volumetric): ignore Strength/Softness (see RockParams in lib.rs). Defaults
  // mirror the backend's own `RockParams::default()`. Shared by both tools — same field, one fuses
  // rock into the terrain, the other cuts it away.
  const [rockNoisiness, setRockNoisiness] = useState(0.4);
  const [rockNoiseRadius, setRockNoiseRadius] = useState(12);
  const [rockSmoothing, setRockSmoothing] = useState(1);
  const [rockMeld, setRockMeld] = useState(1); // fillet radius ("Blend")
  const [rockFlatten, setRockFlatten] = useState(0.55);
  const [rockSink, setRockSink] = useState(0.35);
  const [rockDrape, setRockDrape] = useState(0.75);
  const [rockStrata, setRockStrata] = useState(0.5);
  const sculptSeedRef = useRef(Math.floor(Math.random() * 0xFFFFFFFF));
  // Live modifier state for sculpt strokes (Ctrl/⌘ = invert raise↔lower, Shift = temporary Smooth).
  // Read fresh per stamp inside applySculpt (not captured at stroke-start) so a modifier change
  // mid-hold takes effect on the very next stamp, matching the bracket-key radius/strength resize.
  const sculptModRef = useRef({ ctrl: false, shift: false });

  // Mask
  const [maskEnabled,   setMaskEnabled]   = useState(false);
  const [maskBlockType, setMaskBlockType] = useState<number | null>(null);
  const [maskPaint,     setMaskPaint]     = useState<number | null>(null);

  // Hotbar: 5 pinned + 5 recent block+paint combos (both persisted — pinning a favourite and
  // losing it on restart was a beta complaint). Extracted to `useHotbar()` (Stage 14.5) so the
  // floating Hotbar window and this component share one source of truth without a fork.
  const hotbar = useHotbar(texturePackInfo);
  const { pinnedBlocksRef, recentBlocksRef, hotbar3dSlots, trackRecentBlock } = hotbar;


  // Paste mode: normal | scatter | array
  const [pasteMode, setPasteMode] = useState<"normal" | "scatter" | "array">("normal");
  const [scatterCount, setScatterCount] = useState(5);
  const [arrayCols, setArrayCols] = useState(3);
  const [arrayRows, setArrayRows] = useState(3);
  const [arraySpacingX, setArraySpacingX] = useState(0);
  const [arraySpacingY, setArraySpacingY] = useState(0);

  const [clipboardPreviewPixels, setClipboardPreviewPixels] = useState<{ width: number; height: number; pixels: Uint8Array } | null>(null);

  // Tree generation state (lifted from SelectionInspector so Ribbon can render the tree UI)
  const [treeTypes, setTreeTypes] = useState<string[]>(["normal"]);
  const [treeDensity, setTreeDensity] = useState(20);
  const [leafPaints, setLeafPaints] = useState<number[]>([0, 22, 31, 40]);
  const [smartPlacement, setSmartPlacement] = useState(true);

  // Fluid Flow Toolkit state (Ribbon's Selection tab "Fluids" group)
  const [fluidBase, setFluidBase] = useState<20 | 23>(20); // 20 water, 23 lava
  const [fluidIncludeExisting, setFluidIncludeExisting] = useState(false);
  const [poolFillTargetZ, setPoolFillTargetZ] = useState(32);
  const [wavyWavelength, setWavyWavelength] = useState(8);
  const [wavyAmplitude, setWavyAmplitude] = useState(0.8);
  const [wavyMode, setWavyMode] = useState<"existing" | "fill">("existing");

  // Repeat-paste trail: track last paste position + step vector for path preview and `.` shortcut.
  const [lastPasteDelta, setLastPasteDelta] = useState<{ dx: number; dy: number } | null>(null);
  const lastPastePosRef   = useRef<{ x: number; y: number } | null>(null);
  const lastPasteDeltaRef = useRef<{ dx: number; dy: number } | null>(null);

  // Creature viewer (Phase 6) — UI + state hidden pending testing; Rust get_creatures command is implemented

  // Z-slice follow-surface mode
  const [followSurface, setFollowSurface] = useState(false);
  const followSurfaceRef = useRef(false);
  const cursorMoveThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { followSurfaceRef.current = followSurface; }, [followSurface]);

  const appToolRef = useRef<Tool>("pan");
  useEffect(() => { appToolRef.current = tool; }, [tool]);
  useEffect(() => { lockedPastePosRef.current = lockedPastePos; }, [lockedPastePos]);
  useEffect(() => { if (tool !== "paste") setLockedPastePos(null); }, [tool]);

  // Clear paste trail when clipboard changes or we leave paste mode.
  useEffect(() => {
    setLastPasteDelta(null);
    lastPasteDeltaRef.current = null;
    lastPastePosRef.current   = null;
  }, [clipboard]);
  useEffect(() => {
    if (tool !== "paste") {
      setLastPasteDelta(null);
      lastPasteDeltaRef.current = null;
      lastPastePosRef.current   = null;
    }
  }, [tool]);

  // Monotonically increasing counter; incremented at the START of every openFile().
  // Async invokes that captured a prior epoch discard their result on resolution.
  const loadEpochRef = useRef(0);

  const [viewMode, setViewMode] = useState<MapViewMode>("topdown");
  // zSliceZ is the committed level passed to MapCanvas (triggers tile refetch). In cutaway mode the
  // same value is the cap Z — one slider, two meanings (see the Ribbon's View tab). The slider's
  // drag-time visual value is Ribbon-local (zSliceDisplay there), synced from this committed value.
  const [zSliceZ, setZSliceZ] = useState(32);

  const viewModeRef = useRef<MapViewMode>("topdown");
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);

  // The cutaway cap *as the backend currently has it* (`set_view_cap`), not as the UI wants it.
  // The distinction matters: MapCanvas is a child, so its cache-invalidation effect would run
  // before ours and refetch tiles under the old cap. Setting this only after the invoke resolves
  // makes it a safe refetch trigger — the backend is guaranteed to already be capped.
  const [viewCapZ, setViewCapZ] = useState<number | null>(null);

  // Relief shading (Stage 13.2). `reliefShading` is the user's preference (persisted); `viewRelief`
  // is what the backend currently has (`set_view_relief`), advanced only once the invoke resolves —
  // the same "backend-mirrored refetch key" idiom as `viewCapZ` just below, and for the same reason.
  // The backend keeps the value across world loads, so this only has to fire when the toggle flips.
  const [reliefShading, setReliefShadingState] = useState(() => loadSettings().reliefShading);
  const setReliefShading = useCallback((on: boolean) => {
    setReliefShadingState(on);
    saveSettings({ reliefShading: on });
  }, []);
  const [viewRelief, setViewRelief] = useState<number | null>(null);
  useEffect(() => {
    const want = reliefShading ? RELIEF_STRENGTH : null;
    let cancelled = false;
    invoke("set_view_relief", { strength: want })
      .then(() => { if (!cancelled) setViewRelief(want); })
      .catch(reportError);
    return () => { cancelled = true; };
  }, [reliefShading, reportError]);

  useEffect(() => {
    if (!world) { setViewCapZ(null); return; }
    const want = viewMode === "cutaway" ? zSliceZ : null;
    let cancelled = false;
    invoke("set_view_cap", { cap: want })
      .then(() => {
        if (cancelled) return;
        setViewCapZ(want);
        // The cutaway ceiling is also a selection ceiling — otherwise copy/fill/extrude would
        // silently reach into the roof the user just hid.
        if (want !== null) setZMax(z => Math.min(z, want));
      })
      .catch(reportError);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, viewMode, zSliceZ]);

  // Read by the global Escape handler, which is registered once with `[]`-ish deps.
  // The menu's own viewport-clamping and outside-click dismissal used to be hand-rolled here (a
  // measure-after-mount clamp effect + an 80ms-delayed dismiss listener); both are now `Popover`'s
  // job via `ContextMenu` (Stage 14.14) — see `src/ui/ContextMenu.tsx` and `Popover`'s
  // `dismissDelayMs` prop.
  const ctxMenuRef = useRef<typeof ctxMenu>(null);
  useEffect(() => { ctxMenuRef.current = ctxMenu; }, [ctxMenu]);

  const zSliceZRef = useRef(32);
  useEffect(() => { zSliceZRef.current = zSliceZ; }, [zSliceZ]);

  const [fillBlockType, setFillBlockType] = useState(2);
  const [fillPaint, setFillPaint] = useState(0);

  const [filterBlockType, setFilterBlockType] = useState<number | null>(null);
  const [filterPaint, setFilterPaint] = useState<number | null>(null);
  const [filterInvert, setFilterInvert] = useState(false);

  const [rawBounds, setRawBounds] = useState<SelectionBounds | null>(null);
  const rawBoundsRef = useRef<SelectionBounds | null>(null);
  useEffect(() => { rawBoundsRef.current = rawBounds; }, [rawBounds]);
  // Non-rectangular selection (magic wand / lasso). The mask itself lives on the Rust WorldState;
  // the frontend only needs to (a) know one is active for UI, and (b) drop it the instant the
  // selection is reshaped by anything other than the wand/lasso. `selectionMaskRectRef` records the
  // exact rect the backend mask applies to; a single effect below clears the mask whenever the
  // committed rect diverges from it, which covers every setRawBounds site (marquee, edge-resize,
  // move, select-all, 3D two-click, clear) without touching each one. The Rust side ALSO re-checks
  // the rect on every edit, so a missed clear degrades to rect-only, never to a corrupt edit.
  const [hasSelectionMask, setHasSelectionMask] = useState(false);
  const selectionMaskRectRef = useRef<SelectionBounds | null>(null);
  // Canvas overlay data source (Phase E): bbox + decoded bitset for the active shaped selection.
  const [selectionMaskOverlay, setSelectionMaskOverlay] = useState<{ x1: number; y1: number; x2: number; y2: number; bits: Uint8Array } | null>(null);
  // Live marquee dims while dragging a new selection (before commit/describe_selection round-trip).
  // `dragSelectRect` state now feeds ONLY the 3D wireframe overlay (`overlays3d`), which is inert
  // unless the 3D view is live — so we skip the App re-render entirely when it isn't,
  // and rAF-throttle it when it is. The status-bar dimensions readout is fed imperatively into the
  // SelStatusHud leaf instead (no App re-render per pointer-move). See handleSelectDragUpdate below.
  const [dragSelectRect, setDragSelectRect] = useState<SelectionBounds | null>(null);
  const selStatusHudRef = useRef<SelStatusHudHandle>(null);
  const marqueeRafRef = useRef<number | null>(null);
  const marqueePendingRef = useRef<SelectionBounds | null>(null);
  const handleSelectDragUpdate = (rect: SelectionBounds | null) => {
    selStatusHudRef.current?.setDrag(rect);
    if (rect === null) {
      marqueePendingRef.current = null;
      if (marqueeRafRef.current != null) { cancelAnimationFrame(marqueeRafRef.current); marqueeRafRef.current = null; }
      setDragSelectRect(prev => (prev === null ? prev : null));
      return;
    }
    // dragSelectRect only drives the live 3D wireframe box; nothing else consumes it.
    if (!pane3dLive) return;
    marqueePendingRef.current = rect;
    if (marqueeRafRef.current == null) {
      marqueeRafRef.current = requestAnimationFrame(() => {
        marqueeRafRef.current = null;
        setDragSelectRect(marqueePendingRef.current);
      });
    }
  };
  const [zMin, setZMin] = useState(0);
  const [zMax, setZMax] = useState(63);
  const zMinRef = useRef(0);
  const zMaxRef = useRef(63);
  useEffect(() => { zMinRef.current = zMin; }, [zMin]);
  useEffect(() => { zMaxRef.current = zMax; }, [zMax]);
  // The Lens's z-edge drags (20.4): already throttled to ≤ 15 Hz by `LensView`.
  const onLensZRange = useCallback((lo: number, hi: number) => { setZMin(lo); setZMax(hi); }, []);
  // On 256z worlds a tall selection makes every preview/mask/render pass ~4× heavier, so the
  // default z range is 0–63 and a range taller than that doesn't outlive its selection: once the
  // selection is cleared, snap back. (Non-null selections are never touched, so editing a tall one
  // is unaffected.)
  useEffect(() => {
    if (rawBounds === null && zMax > DEFAULT_SEL_Z_MAX) {
      setZMin(0);
      setZMax(DEFAULT_SEL_Z_MAX);
    }
  }, [rawBounds, zMax]);

  const [selection, setSelection] = useState<SelectionInfo | null>(null);

  // First corner of a two-click 3D selection, or null. Mirrors MapCanvas's two-click paste flow:
  // the first click arms an amber ghost, the second commits, Escape cancels.
  const [pick3dFirst, setPick3dFirst] = useState<{ x: number; y: number; z: number } | null>(null);
  const pick3dFirstRef = useRef<typeof pick3dFirst>(null);
  useEffect(() => { pick3dFirstRef.current = pick3dFirst; }, [pick3dFirst]);

  // 3D fly-view interaction, fully decoupled from the Draw/Select editor tools: the contextual "3D"
  // ribbon tab owns this. "off" = camera only; "select" = two-click box select; "build" = place
  // (left-click) / break (right-click). Build mode's armed block is the same fillBlockType/fillPaint
  // as the 2D map (and the shared hotbar), so switching between 2D and 3D building carries no state.
  const [mode3d, setMode3d] = useState<"off" | "select" | "build" | "sculpt" | "floodfill">("off");

  // The committed selection box, reduced to the shape the 3D pane's transform gizmo wants. Kept as
  // its own small memo (not derived from `overlays3d`, which also carries paste/extrude ghosts and
  // recomputes on a much wider dep list) so the gizmo-sync effect in FlyView3D only re-fires on an
  // actual bounds change.
  const selection3d = useMemo(
    () => (rawBounds ? { x1: rawBounds.x1, y1: rawBounds.y1, x2: rawBounds.x2, y2: rawBounds.y2, zMin, zMax } : null),
    [rawBounds, zMin, zMax],
  );

  // 3D wireframe overlays for the fly-through pane: selection (blue), extrude copies (amber), paste (green).
  const overlays3d = useMemo<Overlay3D[] | null>(() => {
    if (!pane3dLive) return null;
    const ovs: Overlay3D[] = [];
    if (pick3dFirst) {
      const { x, y, z } = pick3dFirst;
      ovs.push({ min: [x, z, y], max: [x + 1, z + 1, y + 1], color: 0xf59e0b });
    }
    // While a marquee select is in progress, `dragSelectRect` updates every pointer-move but
    // `rawBounds` only commits on release — prefer the live rect so the blue 3D box tracks the drag
    // in real time instead of snapping into place at the end. (Only the wireframe box follows live;
    // the committed `rawBounds` is what every other consumer keys off.)
    const selRect = dragSelectRect ?? rawBounds;
    if (selRect) {
      const { x1, y1, x2, y2 } = selRect;
      // Shaped selection: if a wand/lasso mask is committed for exactly this rect, render its
      // footprint as one extruded prism — walls traced along the true boundary (no internal faces to
      // double-blend) with coplanar top/bottom caps from the decomposed rects — instead of a solid
      // box. A highly fragmented mask (decomposeMask → null) or a stale/absent mask falls back to the
      // plain full bbox overlay.
      const mo = selectionMaskOverlay;
      const maskMatches = !dragSelectRect && mo && mo.x1 === x1 && mo.y1 === y1 && mo.x2 === x2 && mo.y2 === y2;
      const caps = maskMatches && mo ? decomposeMask(mo) : null;
      if (caps && mo) {
        ovs.push({
          min: [x1, zMin, y1], max: [x2 + 1, zMax + 1, y2 + 1], color: 0x3b82f6, style: "full",
          shape: { loops: maskOutline(mo), caps, zBottom: zMin, zTop: zMax + 1 },
        });
      } else {
        ovs.push({ min: [x1, zMin, y1], max: [x2 + 1, zMax + 1, y2 + 1], color: 0x3b82f6 });
      }
      if (!dragSelectRect && extrudeOpen && extrudeCount > 0) {
        const w = x2 - x1 + 1, h = y2 - y1 + 1, d = zMax - zMin + 1;
        for (let i = 1; i <= extrudeCount; i++) {
          let ox = 0, oy = 0, oz = 0;
          if (extrudeAxis === "x+") ox = w * i;
          else if (extrudeAxis === "x-") ox = -w * i;
          else if (extrudeAxis === "y+") oy = h * i;
          else if (extrudeAxis === "y-") oy = -h * i;
          else if (extrudeAxis === "z+") oz = d * i;
          else if (extrudeAxis === "z-") oz = -d * i;
          ovs.push({
            min: [x1 + ox, zMin + oz, y1 + oy],
            max: [x2 + ox + 1, zMax + oz + 1, y2 + oy + 1],
            color: 0xf59e0b,
          });
        }
      }
    }
    if (lockedPastePos && clipboard) {
      const px = lockedPastePos.x, py = lockedPastePos.y;
      const pz = clipboard.z_anchor + pasteElevationOffset;
      ovs.push({
        min: [px, pz, py],
        max: [px + clipboard.width, pz + clipboard.depth, py + clipboard.height],
        color: 0x22c55e,
      });
    }
    return ovs.length > 0 ? ovs : null;
  }, [pane3dLive, rawBounds, dragSelectRect, zMin, zMax, extrudeOpen, extrudeAxis, extrudeCount, lockedPastePos, clipboard, pasteElevationOffset, pick3dFirst, selectionMaskOverlay]);

  useEffect(() => {
    if (!rawBounds) {
      setSelection(null);
      return;
    }
    const timer = setTimeout(() => {
      invoke<SelectionInfo>("describe_selection", { ...rawBounds, zMin, zMax })
        .then(setSelection)
        .catch((e) => reportError(e));
    }, 80);
    return () => clearTimeout(timer);
  }, [rawBounds, zMin, zMax, reportError]);

  // Single choke point for dropping the backend selection mask: whenever the committed rect no
  // longer equals the rect the mask was built for (any reshape, move, or clear), the wand/lasso
  // shape is stale — drop it so edits go back to plain rect behaviour. The wand/lasso handlers set
  // `selectionMaskRectRef` to their rect before this runs, so their own commit doesn't self-clear.
  useEffect(() => {
    const mr = selectionMaskRectRef.current;
    if (!mr) return; // no mask active → nothing to guard
    const rb = rawBounds;
    const stillMatches = rb && rb.x1 === mr.x1 && rb.y1 === mr.y1 && rb.x2 === mr.x2 && rb.y2 === mr.y2;
    if (!stillMatches) {
      selectionMaskRectRef.current = null;
      setHasSelectionMask(false);
      invoke("clear_selection_mask").catch((e) => reportError(e));
    }
  }, [rawBounds, reportError]);

  // Canvas overlay data for the shaped selection (wand/lasso). Refetched whenever the mask flips on,
  // and whenever the committed rect changes while a mask is active — the move path shifts the mask's
  // bbox server-side without changing its bits, so the bbox alone can drift out from under a stale
  // fetch otherwise.
  useEffect(() => {
    if (!hasSelectionMask || !rawBounds) { setSelectionMaskOverlay(null); return; }
    invoke<ArrayBuffer>("get_selection_mask")
      .then(buf => setSelectionMaskOverlay(decodeSelectionMask(buf)))
      .catch(() => setSelectionMaskOverlay(null));
  }, [hasSelectionMask, rawBounds]);

  // Fetch top-down clipboard preview whenever clipboard changes.
  // Row 18.3: this is the ONE owner of the clipboard preview. It is LOD-bounded (≤512 px long
  // side) and shared by the Clipboard ribbon tab, the Inspector and the map ghost.
  useEffect(() => {
    if (!clipboard) { setClipboardPreviewPixels(null); return; }
    let stale = false;
    invoke<ArrayBuffer>("render_clipboard_preview", { maxSide: 512 })
      .then(buf => { if (!stale) setClipboardPreviewPixels(decodePreviewData(buf)); })
      .catch(() => { if (!stale) setClipboardPreviewPixels(null); });
    return () => { stale = true; };
  }, [clipboard]);

  // ── Edit helpers ──────────────────────────────────────────────────────────

  async function handleGenerateTrees(treeTypes: string[], density: number, leafPaints: number[], smartPlacement: boolean) {
    if (!selection) return;
    try {
      const result = await invoke<ArrayBuffer>("generate_trees", {
        x1: selection.x1, y1: selection.y1, x2: selection.x2, y2: selection.y2,
        treeTypes, density, leafPaints, smartPlacement,
      });
      await applyEditResult(result);
    } catch (e) { reportError(e); }
  }

  async function handleExtrude(ignoreAir: boolean) {
    if (!selection) return;
    try {
      const result = await invoke<ArrayBuffer>("extrude_selection", {
        x1: selection.x1, y1: selection.y1, x2: selection.x2, y2: selection.y2,
        zMin: selection.z_min, zMax: selection.z_max,
        axis: extrudeAxis, count: extrudeCount, ignoreAir,
      });
      await applyEditResult(result);
    } catch (e) { reportError(e); }
  }

  // ── Fluid Flow Toolkit ────────────────────────────────────────────────────

  async function handleSimulateFlow() {
    if (!selection) return;
    try {
      const result = await invoke<ArrayBuffer>("simulate_flow", {
        x1: selection.x1, y1: selection.y1, x2: selection.x2, y2: selection.y2,
        zMin: selection.z_min, zMax: selection.z_max,
        includeExistingSources: fluidIncludeExisting, base: fluidBase,
      });
      await applyEditResult(result);
    } catch (e) { reportError(e); }
  }

  /** Pool Fill's armed click ("poolfill" tool) — the click picks the basin floor cell; the current
   *  Z-slice level supplies its Z (2D top-down clicks can't carry a Z of their own), and the current
   *  selection bounds the flood so a leak can't run away across the whole world. */
  async function handlePoolFillPick(wx: number, wy: number) {
    const prev = prevToolRef.current;
    setTool(prev === "poolfill" ? "select" : prev);
    if (!selection) { reportError("Make a selection around the basin first."); return; }
    try {
      const result = await invoke<ArrayBuffer>("pool_fill", {
        x1: selection.x1, y1: selection.y1, x2: selection.x2, y2: selection.y2,
        clickX: wx, clickY: wy, clickZ: zSliceZRef.current,
        targetZ: poolFillTargetZ, base: fluidBase, paint: 0,
      });
      await applyEditResult(result);
    } catch (e) { reportError(e); }
  }

  async function handleGenerateWavySurface() {
    if (!selection) return;
    try {
      const result = await invoke<ArrayBuffer>("generate_wavy_surface", {
        x1: selection.x1, y1: selection.y1, x2: selection.x2, y2: selection.y2,
        base: fluidBase, paint: 0,
        wavelength: wavyWavelength, amplitude: wavyAmplitude, mode: wavyMode,
      });
      await applyEditResult(result);
    } catch (e) { reportError(e); }
  }

  const applyEditResult = useCallback(async (
    buf: ArrayBuffer, kind: "edit" | "undo" | "redo" = "edit", opts?: { silent?: boolean },
  ) => {
    const raw = decodeEditResult(buf);
    // The patch is sampled at `patch.lod` (audit M3), so its *world* footprint is its pixel
    // dimensions times that step — every consumer below that speaks world coordinates uses these.
    const editW = raw.patch.width * raw.patch.lod;
    const editH = raw.patch.height * raw.patch.lod;
    // Audit C2: an oversized patch arrives as a rect with no pixels — re-fetch that region through
    // the tile pipeline (bounded by the viewport) instead of blitting a world-sized image, which is
    // exactly what the z-slice branch below has always done.
    if (viewModeRef.current === "zslice" || raw.invalidate) {
      // z-slice has always re-fetched rather than blitted; an invalidated patch joins it.
      mapCanvasRef.current?.refetchRegion(raw.patch.x, raw.patch.y, raw.patch.x + editW, raw.patch.y + editH);
    } else {
      mapCanvasRef.current?.applyPatch(raw.patch);
    }
    // Broadcast the edit's world bounds (top-down X/Y extent) for FlyView3D's edit-sync.
    setLastEditBounds({ x: raw.patch.x, y: raw.patch.y, w: editW, h: editH });
    // Completion outline (Stage 14.13) — user-initiated edits only, never undo/redo (a flood of
    // undo/redo flashes would be noise, not feedback on something the user just did).
    if (kind === "edit") {
      doneOutlineKeyRef.current += 1;
      setDoneRect({ key: doneOutlineKeyRef.current, x: raw.patch.x, y: raw.patch.y, w: editW, h: editH });
    }
    setUndoDepth(raw.undo_depth);
    setRedoDepth(raw.redo_depth);
    setEditEpoch(e => e + 1);
    bumpPerf("editsApplied");
    // H1: a grouped build stamp (part of a gesture) suppresses its own toast — the gesture emits one
    // summary toast on release instead (see handleBuildGestureEnd).
    if (raw.operation && !opts?.silent) {
      const prefix = kind === "undo" ? "Undid: " : kind === "redo" ? "Redid: " : "";
      showToast(prefix + raw.operation);
    }
    // Audit C1 step 3: the edit applied, but its undo delta didn't fit the memory budget, so the
    // history was dropped rather than parked in RAM for the session. Never silent — this is the
    // one case where ⌘Z won't get the user's work back.
    if (raw.undo_dropped) {
      pushToast("This edit was too large to undo, so undo history was cleared. " +
                "Raise the memory budget in Settings ▸ General to keep it.", "error");
    }
    // Risky-block density warnings (dense doors/flowers packed into one footprint — see
    // RISKY_BLOCK_GROUPS in lib.rs). Advisory only, shown regardless of `silent` since it's a safety
    // signal rather than a routine operation label.
    for (const w of raw.warnings) pushToast(w, "error");
  }, [showToast, pushToast]);

  async function openFile() {
    const selected = await open({
      filters: [{ name: "Eden World", extensions: ["eden", "zip"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;
    await openFileAt(selected);
  }

  // Core "swap the session onto this world file" logic, shared by the normal Open flow and the
  // materialize-tool auto-reload — the latter skips openFileAt's isDirty confirm because the
  // materialize modal's own confirm step already warns "save your work first" before the write.
  // Shared by every path that swaps in a freshly-loaded world (normal open, and autosave recovery
  // in the base+journal format, which doesn't go through `load_world` at all) — everything the
  // returned `WorldMeta` needs applied to React state, minus the actual IPC call and its loading/
  // error chrome, which differ enough between callers (a synchronous fetch vs. a recovery flow with
  // its own dirty-forcing) to stay separate.
  function applyLoadedWorld(data: WorldMeta, path: string | null, opts?: WorldOpenOpts) {
    // Per-world floating-window layout: path → header identity → the last layout left anywhere. A
    // just-created world skips the identity step (see `pickLayout`'s `fresh`).
    loadWindowLayout(normalizePath(path, IS_WINDOWS), worldIdentity(data, classifyWorldFormat(data)), opts?.fresh);
    // One-shot notice for a user migrated off the retired Quad layout (settings v23, Stage 16.4).
    if (loadSettings().pendingQuadRetiredNotice) {
      saveSettings({ pendingQuadRetiredNotice: false });
      showToast("The 3D view is now a window.");
    }
    setWorld(data);
    setWorldEpoch((e) => e + 1);
    setSourcePath(path);
    setRawBounds(null);
    setMaterializeSelection(null);
    setZMin(0);
    setZMax(Math.min(data.max_z, DEFAULT_SEL_Z_MAX));
    setTool("pan");
    setUndoDepth(0);
    setRedoDepth(0);
    setViewMode("topdown");
    setZSliceZ(32);
    setClipboard(null);
    resetHeavyLighting();
    setSaveCompressed(data.was_compressed);
    setSpawnPos(data.spawn_px != null && data.spawn_py != null ? { px: data.spawn_px, py: data.spawn_py } : null);
    invoke<[number, number] | null>("get_player_pos")
      .then(pos => setPlayerPos(pos ? { px: pos[0], py: pos[1] } : null))
      .catch(() => setPlayerPos(null));
    setShowSigns(true); // markers default back on for every newly opened world
    invoke<SignInfo[]>("get_signs")
      .then(setSigns)
      .catch(() => setSigns([]));
    // Sidecar signs are read-only *and* untravelled: nothing in VuencEdit writes a sidecar, so a
    // Save As / Upload / compressed save of this world silently drops them. Warn once, on load,
    // rather than at save time — by then the user has already chosen a destination.
    if (data.signs_from_sidecar) {
      pushToast(
        "This world's signs are in a separate signs_….eden.dat file. "
        + "VuencEdit can't write it, so Save As, Upload and compressed saves drop the signs. "
        + "Keep that file next to the world.",
        "error",
      );
    }
    if (path && !opts?.skipRecent) addRecentWorld(path, data.name);
    lastAutosavedEpochRef.current = editEpochRef.current;
    savedEpochRef.current = editEpochRef.current;
  }

  async function swapToWorldFile(path: string, opts?: WorldOpenOpts) {
    const myEpoch = ++loadEpochRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<WorldMeta>("load_world", { path });
      if (loadEpochRef.current !== myEpoch) return;
      applyLoadedWorld(data, path, opts);
    } catch (e) {
      reportError(e);
    } finally {
      setLoading(false);
    }
  }

  async function openFileAt(path: string, opts?: WorldOpenOpts) {
    if (world && isDirty()) {
      const ok = await confirmDialog("You have unsaved changes. Open a new world and discard them?", {
        title: "Unsaved changes", kind: "danger", okLabel: "Discard changes",
      });
      if (!ok) return;
    }
    await swapToWorldFile(path, opts);
  }

  async function exportPng() {
    if (!world) return;
    const suffix = viewMode === "zslice" ? `_z${zSliceZ}` : viewMode === "cutaway" ? `_cut${zSliceZ}` : "";
    const savePath = await save({
      filters: [{ name: "PNG Image", extensions: ["png"] }],
      defaultPath: `${world.name}${suffix}.png`,
    });
    if (!savePath) return;
    try {
      // Render + PNG-encode entirely in Rust. The old path built the full RGBA buffer, a binary
      // string, and a base64 string in the JS heap (≈4× the map size) before this IPC hop.
      await invoke("export_png", {
        path: savePath,
        // Cutaway exports as a top-down render; Rust applies the cap it already holds, so the PNG
        // matches what's on screen.
        view: viewMode === "zslice" ? "zslice" : "topdown",
        z: zSliceZ,
        useTemplate: showTemplateOverlay && templateLoaded && viewMode === "topdown",
      });
    } catch (e) {
      reportExportError(e);
    }
  }

  function commitZSlice(z: number) {
    setZSliceZ(z);
  }

  const copySelection = useCallback(async () => {
    if (!rawBounds) return;
    try {
      const info = await invoke<ClipboardInfo>("copy_selection", { ...rawBounds, zMin, zMax });
      setClipboard(info);
      setTool("paste");
      sfx.play("copy");
    } catch (e) {
      reportError(e);
    }
  }, [rawBounds, zMin, zMax, reportError]);

  // Move the current selection (and its contents) by (dx, dy) in one gesture — arrow-key
  // nudge (E2). Reads live selection/z-range via refs so this stays []-stable for the
  // keydown effect's dep array (mirrors the appToolRef pattern used elsewhere in this file).
  // Guards nudgeSelection's backend path against overlapping calls: arrow-key repeat (or a
  // fast double-tap) can fire a second call before the first's invoke() resolves. Since each
  // call independently reads-clears-writes the *current* world state, a second call reading
  // stale bounds would find the source already emptied by the first and overwrite the moved
  // content with air. Extra calls while one is in flight are coalesced into a single pending
  // delta and applied (against the now-current bounds) once the in-flight call finishes.
  const nudgeBusyRef = useRef(false);
  const nudgePendingRef = useRef<{ dx: number; dy: number } | null>(null);

  const nudgeSelectionContents = useCallback(async (dx0: number, dy0: number) => {
    if (nudgeBusyRef.current) {
      const pending = nudgePendingRef.current;
      nudgePendingRef.current = { dx: (pending?.dx ?? 0) + dx0, dy: (pending?.dy ?? 0) + dy0 };
      return;
    }
    nudgeBusyRef.current = true;
    // Drain any deltas that arrive (via the branch above) while a move is in flight, applying
    // each against the then-current bounds — a loop instead of recursive self-calls so this
    // stays a single stable closure (recursive useCallback self-reference defeats memoization).
    let dx = dx0, dy = dy0;
    for (;;) {
      const bounds = rawBoundsRef.current;
      if (!bounds) break;
      try {
        const result = await invoke<ArrayBuffer>("move_selection", {
          ...bounds, zMin: zMinRef.current, zMax: zMaxRef.current, dx, dy, dz: 0,
        });
        await applyEditResult(result);
        const moved = { x1: bounds.x1 + dx, y1: bounds.y1 + dy, x2: bounds.x2 + dx, y2: bounds.y2 + dy };
        // Shape-preserving move: move_selection shifted the backend mask's bbox by (dx,dy) when one
        // was active. Track it here (before setRawBounds fires the clear-on-reshape effect) so the
        // shifted mask survives; if no mask is active the ref is null and this is a no-op.
        if (selectionMaskRectRef.current) selectionMaskRectRef.current = moved;
        setRawBounds(moved);
      } catch (e) {
        reportError(e);
      }
      const pending = nudgePendingRef.current;
      if (!pending) break;
      nudgePendingRef.current = null;
      dx = pending.dx; dy = pending.dy;
    }
    nudgeBusyRef.current = false;
  }, [applyEditResult, reportError]);

  // Entry point for both arrow-key nudge and drag-to-move: moves just the selection box by
  // default (E2 — off by default per user feedback), or the box + its blocks when the
  // "Move: Box + Contents" toggle (Selection tab) is on.
  const nudgeSelection = useCallback((dx: number, dy: number) => {
    if (!moveWithContentsRef.current) {
      const bounds = rawBoundsRef.current;
      const w = worldRef.current;
      if (!bounds || !w) return;
      // Box-only move (no backend call, unlike the moveWithContents path below) — clamp to world
      // bounds so repeated arrow-nudges can't push the selection off the map entirely.
      const mapMaxX = chunkToWorld(w.width_chunks) - 1, mapMaxY = chunkToWorld(w.height_chunks) - 1;
      const clampDx = Math.max(-bounds.x1, Math.min(mapMaxX - bounds.x2, dx));
      const clampDy = Math.max(-bounds.y1, Math.min(mapMaxY - bounds.y2, dy));
      setRawBounds({
        x1: bounds.x1 + clampDx, y1: bounds.y1 + clampDy,
        x2: bounds.x2 + clampDx, y2: bounds.y2 + clampDy,
      });
      return;
    }
    nudgeSelectionContents(dx, dy);
  }, [nudgeSelectionContents]);

  /** 3D gizmo face-resize, or an arrow-move while its Region⇄Blocks toggle is set to Region: the
   *  selection box itself changed, no backend edit — same as any other region-only bounds commit. */
  const handleGizmoRegionChange = useCallback((b: { x1: number; y1: number; x2: number; y2: number; zMin: number; zMax: number }) => {
    setRawBounds({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 });
    setZMin(b.zMin);
    setZMax(b.zMax);
  }, []);

  /** 3D gizmo arrow-move while its toggle is set to Blocks: relocate the selection's contents via the
   *  undoable `move_selection` backend command, then shift rawBounds/zMin/zMax by the same delta —
   *  mirrors `nudgeSelectionContents` above (including the shape-preserving mask-rect bookkeeping),
   *  generalized to a 3-axis delta since the gizmo's Z arrow can move a selection up/down too. */
  const handleGizmoMoveBlocks = useCallback(async (dx: number, dy: number, dz: number) => {
    const bounds = rawBoundsRef.current;
    if (!bounds) return;
    try {
      const result = await invoke<ArrayBuffer>("move_selection", {
        ...bounds, zMin: zMinRef.current, zMax: zMaxRef.current, dx, dy, dz,
      });
      await applyEditResult(result);
      const moved = { x1: bounds.x1 + dx, y1: bounds.y1 + dy, x2: bounds.x2 + dx, y2: bounds.y2 + dy };
      if (selectionMaskRectRef.current) selectionMaskRectRef.current = moved;
      setRawBounds(moved);
      setZMin(z => z + dz);
      setZMax(z => z + dz);
    } catch (e) {
      reportError(e);
    }
  }, [applyEditResult, reportError]);

  async function rotateClipboard() {
    try {
      const info = await invoke<ClipboardInfo>("rotate_clipboard");
      setClipboard(info);
      sfx.play("rotate");
    } catch (e) {
      reportError(e);
    }
  }

  async function mirrorClipboardX() {
    try {
      const info = await invoke<ClipboardInfo>("mirror_clipboard_x");
      setClipboard(info);
      sfx.play("rotate");
    } catch (e) {
      reportError(e);
    }
  }

  async function mirrorClipboardY() {
    try {
      const info = await invoke<ClipboardInfo>("mirror_clipboard_y");
      setClipboard(info);
      sfx.play("rotate");
    } catch (e) {
      reportError(e);
    }
  }

  async function pasteAt(pos: { x: number; y: number }) {
    try {
      const result = pasteTerrain
        ? await invoke<ArrayBuffer>("paste_terrain", {
            pasteX: pos.x, pasteY: pos.y,
            elevationOffset: pasteElevationOffset,
            ignoreAir: pasteIgnoreAir,
            aboveSurface: pasteTerrainAbove,
          })
        : await invoke<ArrayBuffer>("paste_at", {
            pasteX: pos.x, pasteY: pos.y,
            elevationOffset: pasteElevationOffset,
            ignoreAir: pasteIgnoreAir,
          });
      // Track last paste direction for repeat-paste trail and `.` shortcut.
      const prev = lastPastePosRef.current;
      if (prev) {
        const delta = { dx: pos.x - prev.x, dy: pos.y - prev.y };
        lastPasteDeltaRef.current = delta;
        setLastPasteDelta(delta);
      }
      lastPastePosRef.current = pos;
      if (!persistPaste) setTool("pan");
      await applyEditResult(result);
      sfx.play("paste");
    } catch (e) {
      reportError(e);
    }
  }

  // Stable ref so keyboard handler can always call the latest pasteAt closure.
  const pasteAtRef = useRef(pasteAt);
  useEffect(() => { pasteAtRef.current = pasteAt; });

  function handlePasteClick(pos: { x: number; y: number }) {
    if (pasteMode === "scatter") {
      handleScatterPaste(pos);
      return;
    }
    if (pasteMode === "array") {
      handleArrayPaste(pos);
      return;
    }
    if (persistPaste) {
      pasteAt(pos);
    } else if (lockedPastePos) {
      pasteAt(lockedPastePos);
      setLockedPastePos(null);
    } else {
      setLockedPastePos(pos);
    }
  }

  // trackRecentBlock now comes from useHotbar() (destructured above).

  async function handleEyedropper(wx: number, wy: number) {
    try {
      const result = await invoke<{ block_type: number; paint: number }>("pick_block_surface", { wx, wy });
      if (result.block_type !== 0) {
        setFillBlockType(result.block_type);
        setFillPaint(result.paint);
        trackRecentBlock(result.block_type, result.paint);
      }
    } catch (e) {
      reportError(e);
    }
    // One-shot: return to previous draw tool
    const prev = prevToolRef.current;
    setTool(prev === "eyedropper" ? "pen" : prev);
  }

  // Single sculpt dispatch shared by the 2D map (explicit `points`) and the 3D pane (backend-generated
  // disc via `stampCx/cy/radius`). Every param `sculpt_terrain` accepts flows through here; the 2D
  // path is a pure extraction of the old inline call (behaviour byte-for-byte unchanged: it always
  // ships `points`, leaves the stamp/useCap fields null → the backend takes exactly the old branch).
  async function applySculpt(opts: {
    points?: { x: number; y: number }[];
    stampCx?: number; stampCy?: number; stampRadius?: number;
    stampCenters?: [number, number][];
    anchor?: [number, number];
    grabDelta?: number;
    groupId?: number;
    tool?: Tool;
    useCap?: boolean;
    smear?: [number, number];
  }) {
    let t = opts.tool ?? appToolRef.current;
    // Ctrl/⌘-invert and Shift-temporary-smooth, read fresh per stamp (not captured at stroke-start)
    // so a modifier change mid-hold applies to the very next stamp. Grab is excluded: it's a
    // fixed-column vertical-drag gesture with no footprint/points, and forcing it into "smooth"
    // would silently discard grab_delta rather than doing anything sensible.
    if (t !== "grab") {
      const mods = sculptModRef.current;
      if (mods.shift) t = "smooth";
      else if (mods.ctrl) {
        if (t === "raise") t = "lower";
        else if (t === "lower") t = "raise";
      }
    }
    // sculptClipToSelection: for the 2D points path, filter the swept cells; for the 3D stamp path
    // (no explicit points) the equivalent is to drop the stamp entirely when its centre is outside
    // the selection. Both are frontend-only, mirroring the pre-refactor behaviour.
    let points = opts.points;
    if (points) {
      if (sculptClipToSelection && rawBounds) {
        const { x1, y1, x2, y2 } = rawBounds;
        points = points.filter(p => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2);
        if (points.length === 0) return;
      }
    } else if (opts.stampCx != null && opts.stampCy != null) {
      if (sculptClipToSelection && rawBounds) {
        const { x1, y1, x2, y2 } = rawBounds;
        if (opts.stampCx < x1 || opts.stampCx > x2 || opts.stampCy < y1 || opts.stampCy > y2) return;
      }
    }
    const seed = (t === "noise" || t === "hydro") ? sculptSeedRef.current : 0;
    if (t === "noise" || t === "hydro") sculptSeedRef.current = ((sculptSeedRef.current * 1664525 + 1013904223) >>> 0);
    try {
      const result = await invoke<ArrayBuffer>("sculpt_terrain", {
        points: points ?? null,
        stampCx: opts.stampCx ?? null,
        stampCy: opts.stampCy ?? null,
        stampRadius: opts.stampRadius ?? null,
        mode: t, strength: sculptStrength, seed,
        blockType: fillBlockType || null,
        paint: fillPaint || null,
        freq: 1 / Math.max(4, noiseFeatureSize),
        noiseMode,
        softness: sculptSoftness,
        profile: sculptProfile,
        grabDelta: opts.grabDelta ?? null,
        anchorX: opts.anchor ? opts.anchor[0] : null,
        anchorY: opts.anchor ? opts.anchor[1] : null,
        groupId: opts.groupId ?? null,
        useCap: opts.useCap ?? null, // null → backend default (true); 3D passes false
        slopeDx: slopeGradeX / 100, slopeDy: slopeGradeY / 100,
        smearDx: opts.smear ? opts.smear[0] : null,
        smearDy: opts.smear ? opts.smear[1] : null,
        // Row 6: server-side selection clip (per-cell mask) — sent alongside the legacy point/
        // centre filter above; the backend weight-0's cells outside the rect. `stampCenters`/
        // `strengthF` are the live-batch hooks (frontend controller not wired yet — Step 3).
        clipRect: (sculptClipToSelection && rawBounds)
          ? [rawBounds.x1, rawBounds.y1, rawBounds.x2, rawBounds.y2]
          : null,
        // Row 6 live brush: batched stamp centres for this flush. The backend applies them
        // sequentially into one grouped-undo entry and returns a single union patch. When present,
        // the legacy points/centre path is unused — per-cell clip comes from `clipRect` above.
        stampCenters: opts.stampCenters ?? null,
        strengthF: null,
        rock: (t === "rock" || t === "carve") ? {
          noisiness: rockNoisiness, noiseRadius: rockNoiseRadius, smoothing: rockSmoothing,
          meld: rockMeld, flatten: rockFlatten, sink: rockSink, drape: rockDrape, strata: rockStrata,
        } : null,
      });
      await applyEditResult(result);
    } catch (e) { reportError(e); }
  }

  /** One 3D sculpt stamp (from FlyView3D). Backend generates the disc; the 3D view is not cut by the
   *  2D cutaway cap, so use_cap:false. Tool/strength/softness/etc come from the shared sculpt state. */
  async function handleSculptStamp3d(opts: {
    stampCx: number; stampCy: number; stampRadius: number; groupId: number;
    anchor?: [number, number]; grabDelta?: number; smear?: [number, number];
  }) {
    await applySculpt({
      stampCx: opts.stampCx, stampCy: opts.stampCy, stampRadius: opts.stampRadius,
      anchor: opts.anchor, grabDelta: opts.grabDelta, groupId: opts.groupId, smear: opts.smear,
      tool: appToolRef.current, useCap: false,
    });
  }

  /** Live-brush sculpt (Row 6): one flush of a 2D stroke — a batch of stamp centres sharing the
   *  stroke's group id. Delegates to the shared applySculpt funnel (Ctrl-invert/Shift-smooth + clip). */
  async function handleSculptStroke(stampCenters: [number, number][], stampRadius: number, groupId: number, anchor: [number, number]) {
    await applySculpt({ stampCenters, stampRadius, anchor, groupId, tool: appToolRef.current });
  }

  async function handleDrawStroke(pts: [number, number][], zOverride: number | null, anchor?: [number, number], grabDelta?: number, groupId?: number, smear?: [number, number]) {
    const t = appToolRef.current;
    try {
      if (t === "smooth" || t === "noise" || t === "flatten" || t === "erode" || t === "thermal" || t === "hydro" || t === "stamp" || t === "grab" || t === "raise" || t === "lower"
          || t === "terrace" || t === "sharpen" || t === "slope" || t === "smear" || t === "rock" || t === "carve") {
        await applySculpt({
          points: pts.map(([x, y]) => ({ x, y })),
          anchor, grabDelta, groupId, smear, tool: t,
        });
      } else if (t === "fill") {
        if (pts.length === 0) return;
        const [x, y] = pts[0];
        const result = await invoke<ArrayBuffer>("fill_surface", {
          wx: x, wy: y, newType: fillBlockType, newPaint: fillBlockType === 0 ? 0 : fillPaint, maxFill: 50000,
        });
        await applyEditResult(result);
        trackRecentBlock(fillBlockType, fillPaint);
      } else {
        const blocks = pts.map(([x, y]) => ({ x, y, z: zOverride }));
        const zOffset = drawAbove && zOverride === null ? 1 : 0;
        const result = await invoke<ArrayBuffer>("paint_blocks", {
          blocks, blockType: fillBlockType, paint: fillBlockType === 0 ? 0 : fillPaint, zOffset,
          maskType: maskEnabled ? maskBlockType : null,
          maskPaint: maskEnabled ? maskPaint : null,
        });
        await applyEditResult(result);
        trackRecentBlock(fillBlockType, fillPaint);
      }
    } catch (e) {
      reportError(e);
    }
  }

  function handleCursorMove(wx: number, wy: number) {
    cursorWorldRef.current = { wx, wy };
    if (cursorPosThrottleRef.current === null) {
      cursorPosThrottleRef.current = setTimeout(() => {
        cursorPosThrottleRef.current = null;
        const { wx: cx, wy: cy } = cursorWorldRef.current!;
        const cellX = Math.floor(cx), cellY = Math.floor(cy);
        const last = lastCursorCellRef.current;
        if (last && last.cx === cellX && last.cy === cellY) {
          // Cursor moved within the same block cell — the X/Y readout still needs the fractional
          // position, but skip the invoke: block/paint under an unchanged cell can't have changed.
          cursorHudRef.current?.setPos(cx, cy);
          return;
        }
        lastCursorCellRef.current = { cx: cellX, cy: cellY };
        invoke<[number,number,number] | null>("get_cursor_block", { wx: cellX, wy: cellY })
          .then(r => {
            cursorHudRef.current?.setPos(cx, cy);
            cursorZHudRef.current?.set(r ? { z: r[0], bt: r[1], paint: r[2] } : null);
          })
          .catch(() => {
            cursorHudRef.current?.setPos(cx, cy);
            cursorZHudRef.current?.set(null);
          });
      }, 80);
    }
    if (!followSurfaceRef.current || viewModeRef.current !== "zslice") return;
    if (cursorMoveThrottleRef.current !== null) return;
    cursorMoveThrottleRef.current = setTimeout(() => {
      cursorMoveThrottleRef.current = null;
      invoke<number | null>("get_surface_z", { x: wx, y: wy })
        .then(z => { if (z !== null && followSurfaceRef.current) { setZSliceZ(z); } })
        .catch(() => {});
    }, 50);
  }


  async function handleMagicWand(wx: number, wy: number) {
    try {
      const rect = await invoke<{ x1: number; y1: number; x2: number; y2: number } | null>("magic_wand_select", {
        wx, wy, matchPaint: wandMatchPaint,
      });
      if (rect) {
        // magic_wand_select stored the shaped footprint as the backend mask, keyed to this exact
        // rect. Record it BEFORE committing rawBounds so the mask-clearing effect sees a match and
        // leaves it in place; a later reshape of this selection will then clear it.
        selectionMaskRectRef.current = rect;
        setHasSelectionMask(true);
        setRawBounds(rect);
        flashSelection(rect);
      }
    } catch (e) { reportError(e); }
  }

  // Shared by lasso (freehand drag) and polyselect (click-vertex polygon) — both reduce to an
  // ordered world-space path that this fills and installs as the backend selection mask.
  async function applyPolygonSelection(pathPts: [number, number][]) {
    try {
      const verts = pathPts.map(([x, y]) => ({ x, y }));
      const filled = polygonPixels(verts, "fill");
      if (filled.length === 0) return;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const p of filled) {
        if (p.x < x1) x1 = p.x; if (p.x > x2) x2 = p.x;
        if (p.y < y1) y1 = p.y; if (p.y > y2) y2 = p.y;
      }
      x1 = Math.max(0, x1); y1 = Math.max(0, y1);
      const width = x2 - x1 + 1, height = y2 - y1 + 1;
      // Row-major bitset over the bbox, bit (y-y1)*width + (x-x1) — must match set_selection_mask's
      // expected layout on the Rust side exactly (it validates byte length against width*height).
      const bits = new Uint8Array(Math.ceil((width * height) / 8));
      for (const p of filled) {
        if (p.x < x1 || p.x > x2 || p.y < y1 || p.y > y2) continue;
        const bitIdx = (p.y - y1) * width + (p.x - x1);
        bits[bitIdx >> 3] |= 1 << (bitIdx & 7);
      }
      await invoke("set_selection_mask", { x1, y1, x2, y2, bitsB64: encodeU8(bits) });
      const rect = { x1, y1, x2, y2 };
      selectionMaskRectRef.current = rect;
      setHasSelectionMask(true);
      setRawBounds(rect);
    } catch (e) { reportError(e); }
  }

  async function handleLassoSelect(pathPts: [number, number][]) {
    await applyPolygonSelection(pathPts);
  }

  async function handlePolySelect(pathPts: [number, number][]) {
    await applyPolygonSelection(pathPts);
  }

  async function handleScatterPaste(_pos: { x: number; y: number }) {
    // The selection rect *is* scatter's placement region. Reachable with no selection if the user
    // armed scatter and then cleared it, so say so instead of eating the click.
    if (!rawBounds) {
      showToast("Scatter needs a selection to place copies into");
      return;
    }
    try {
      const result = await invoke<ArrayBuffer>("scatter_paste", {
        x1: rawBounds.x1, y1: rawBounds.y1, x2: rawBounds.x2, y2: rawBounds.y2,
        count: scatterCount, seed: Math.floor(Math.random() * 0xFFFFFFFF),
        elevationOffset: pasteElevationOffset, ignoreAir: pasteIgnoreAir,
      });
      await applyEditResult(result);
      sfx.play("paste");
    } catch (e) { reportError(e); }
  }

  async function handleArrayPaste(pos: { x: number; y: number }) {
    try {
      const result = await invoke<ArrayBuffer>("array_paste", {
        originX: pos.x, originY: pos.y,
        cols: arrayCols, rows: arrayRows,
        spacingX: arraySpacingX, spacingY: arraySpacingY,
        elevationOffset: pasteElevationOffset, ignoreAir: pasteIgnoreAir,
      });
      await applyEditResult(result);
      sfx.play("paste");
      if (!persistPaste) setTool("pan");
    } catch (e) { reportError(e); }
  }

  /** A Lens draw stroke (20.4): every cell in one `paint_blocks` call, so one undo step. */
  async function handleDrawElevation(blocks: { x: number; y: number; z: number }[]) {
    if (blocks.length === 0) return;
    try {
      const result = await invoke<ArrayBuffer>("paint_blocks", {
        blocks, blockType: fillBlockType, paint: fillPaint, zOffset: 0,
      });
      await applyEditResult(result);
    } catch (e) {
      reportError(e);
    }
  }

  // ---- 3D pane picking -----------------------------------------------------------------------
  // Driven by the 3D ribbon tab's own mode (mode3d), independent of the map's Draw/Select tools.
  const interact3d: Interact3D =
    mode3d === "build" ? "build" : mode3d === "select" ? "select" : mode3d === "sculpt" ? "sculpt"
    : mode3d === "floodfill" ? "floodfill" : "none";

  // Leaving select mode abandons a half-finished two-click selection — otherwise the lone armed
  // corner would silently complete a selection on the first click after switching back.
  useEffect(() => { if (interact3d !== "select") setPick3dFirst(null); }, [interact3d]);

  // Entering 3D sculpt mode with a non-sculpt tool armed (e.g. pan) would leave the pane's sculpt
  // controller reading a nonsense tool. Default to Raise. Reuses the shared `tool` union/state — 3D
  // sculpting has no separate tool state — so this also arms the 2D sculpt tool, by design.
  useEffect(() => {
    if (mode3d !== "sculpt") return;
    const t = appToolRef.current;
    const isSculpt = t === "smooth" || t === "noise" || t === "flatten" || t === "erode" ||
      t === "thermal" || t === "hydro" || t === "stamp" || t === "grab" || t === "raise" || t === "lower" ||
      t === "terrace" || t === "sharpen" || t === "slope" || t === "smear" || t === "rock" || t === "carve";
    if (!isSculpt) setTool("raise");
  }, [mode3d]);

  // Reset the 3D pane's mode to camera-only whenever it isn't on screen, so a stale build/select
  // mode doesn't linger when it comes back.
  useEffect(() => { if (!pane3dLive) setMode3d("off"); }, [pane3dLive]);

  /** Two-click 3D selection. Two picked voxels reduce to the existing rawBounds + zMin/zMax pair —
   *  which is already a full 3D box — so every selection consumer (copy/fill/extrude/prefab/slabs)
   *  works with no further changes. */
  function handlePick3dSelect(x: number, y: number, z: number) {
    const first = pick3dFirstRef.current;
    if (!first) { setPick3dFirst({ x, y, z }); return; }
    setRawBounds({
      x1: Math.min(first.x, x), y1: Math.min(first.y, y),
      x2: Math.max(first.x, x), y2: Math.max(first.y, y),
    });
    setZMin(Math.min(first.z, z));
    setZMax(Math.max(first.z, z));
    setPick3dFirst(null);
    // Surface the Selection tab so the just-made 3D selection's stats/actions are immediately in reach.
    // The Ribbon's own auto-tab effect only fires on a null→non-null rawBounds transition, so it misses
    // the common case of refining an already-existing selection from the 3D pane — push it explicitly.
    ribbonTabSetterRef.current?.("selection");
  }

  /** Flood Fill from the 3D pane: the picked voxel is a solid face; the air cell against the clicked
   *  face (`hit + normal`) is the start cell. Spreads through air only, across and down (never up),
   *  bounded by `floodFillLimit`. No selection or target Z needed — the Limit is the only safety
   *  bound. One `flood_fill_3d` → `with_edit` call, so it's one undo. */
  async function handlePick3dFloodFill(x: number, y: number, z: number, nx: number, ny: number, nz: number) {
    const ax = x + nx, ay = y + ny, az = z + nz; // air cell against the clicked face = start cell
    try {
      const result = await invoke<ArrayBuffer>("flood_fill_3d", {
        startX: ax, startY: ay, startZ: az,
        blockType: fillBlockType, paint: fillPaint, limit: floodFillLimit,
      });
      await applyEditResult(result);
      trackRecentBlock(fillBlockType, fillPaint);
    } catch (e) { reportError(e); }
  }

  /** Break: clear the picked voxel. Goes through paint_blocks → with_edit, so undo/redo and the
   *  chunk-mesh edit sync come for free. Same for place, below.
   *  `group` (H1): FlyView3D's build gesture id. Every stamp of one gesture shares it, so the backend
   *  coalesces them into a single undo entry (`with_edit_grouped`) — and the per-stamp toast here is
   *  suppressed in favour of one summary toast on release (see handleBuildGestureEnd). */
  async function handlePick3dBreak(x: number, y: number, z: number, group?: number) {
    try {
      const result = await invoke<ArrayBuffer>("paint_blocks", { blocks: [{ x, y, z }], blockType: 0, paint: 0, zOffset: 0, group });
      await applyEditResult(result, "edit", { silent: group !== undefined });
    } catch (e) { reportError(e); }
  }

  /** Place the armed block (shared with the 2D fill block/hotbar) in the empty voxel against the
   *  picked face. `yaw` is the player's Eden look direction at click time; with Auto-orient on it
   *  rotates directional blocks (ramps/wedges/doors) to face the player. `group`: see handlePick3dBreak. */
  async function handlePick3dPlace(x: number, y: number, z: number, yaw: number, group?: number) {
    if (fillBlockType === 0) return; // "Air" as the armed block would be a no-op place
    const blockType = autoOrient3d ? orientBlockToFacing(fillBlockType, yaw) : fillBlockType;
    try {
      const result = await invoke<ArrayBuffer>("paint_blocks", {
        blocks: [{ x, y, z }], blockType, paint: fillPaint, zOffset: 0, group,
      });
      await applyEditResult(result, "edit", { silent: group !== undefined });
      trackRecentBlock(fillBlockType, fillPaint);
    } catch (e) { reportError(e); }
  }

  /** H1: one build gesture (a plain click or a multi-stamp sweep) just ended with ≥1 stamp — replaces
   *  every suppressed per-stamp toast with one summary. Fired by FlyView3D's `onBuildGestureEnd`. */
  const handleBuildGestureEnd = useCallback((mode: "break" | "place", count: number) => {
    const verb = mode === "break" ? "Broke" : "Placed";
    showToast(`${verb} ${count} block${count === 1 ? "" : "s"}`);
  }, [showToast]);

  /** B1 build-shape (line/box) commit: the whole run in one `with_edit` call, one undo step. Mirrors
   *  handlePick3dBreak/Place above, generalized to a cell list. */
  async function handlePick3dBreakBatch(cells: [number, number, number][]) {
    if (cells.length === 0) return;
    try {
      const result = await invoke<ArrayBuffer>("paint_blocks", {
        blocks: cells.map(([x, y, z]) => ({ x, y, z })), blockType: 0, paint: 0, zOffset: 0,
      });
      await applyEditResult(result);
    } catch (e) { reportError(e); }
  }
  async function handlePick3dPlaceBatch(cells: [number, number, number][], yaw: number) {
    if (cells.length === 0 || fillBlockType === 0) return;
    const blockType = autoOrient3d ? orientBlockToFacing(fillBlockType, yaw) : fillBlockType;
    try {
      const result = await invoke<ArrayBuffer>("paint_blocks", {
        blocks: cells.map(([x, y, z]) => ({ x, y, z })), blockType, paint: fillPaint, zOffset: 0,
      });
      await applyEditResult(result);
      trackRecentBlock(fillBlockType, fillPaint);
    } catch (e) { reportError(e); }
  }

  /** B2 face-fill bucket: flood-fills the coplanar same-type run behind a clicked wall face, then
   *  either clears it ("break") or re-skins it with the armed block ("place") — one `with_edit`
   *  call either way, so undo/redo come for free. `wandMatchPaint` (2D magic wand's own setting) is
   *  reused rather than adding a second paint-match toggle just for this pane. */
  async function handlePick3dFillFace(
    x: number, y: number, z: number, nx: number, ny: number, nz: number,
    mode: "break" | "place", yaw?: number,
  ) {
    if (mode === "place" && fillBlockType === 0) return; // Air armed = no-op, matches other place handlers
    const blockType = mode === "break" ? 0 : (autoOrient3d && yaw != null ? orientBlockToFacing(fillBlockType, yaw) : fillBlockType);
    const paint = mode === "break" ? 0 : fillPaint;
    try {
      const result = await invoke<ArrayBuffer>("fill_connected_face", {
        x, y, z, nx, ny, nz, matchPaint: wandMatchPaint, blockType, paint,
      });
      await applyEditResult(result);
      if (mode === "place") trackRecentBlock(fillBlockType, fillPaint);
    } catch (e) { reportError(e); }
  }

  /** Middle-click in the 3D pane's build mode: mirrors the 2D eyedropper. Picks the exact block
   *  (orientation included) — auto-orient re-derives a fresh facing on the next placement unless
   *  the user has toggled it off, in which case the picked orientation is placed verbatim. */
  function handlePick3dEyedrop(blockType: number, paint: number) {
    if (blockType === 0) return;
    setFillBlockType(blockType);
    setFillPaint(paint);
    trackRecentBlock(blockType, paint);
    showToast(`Picked ${blockDisplayName(blockType)}`);
  }

  const handleUndo = useCallback(async () => {
    try {
      const result = await invoke<ArrayBuffer>("undo_edit");
      await applyEditResult(result, "undo");
      sfx.play("undo");
    } catch (e) {
      if (e !== "Nothing to undo") reportError(e);
    }
  }, [applyEditResult, reportError]);

  const handleRedo = useCallback(async () => {
    try {
      const result = await invoke<ArrayBuffer>("redo_edit");
      await applyEditResult(result, "redo");
      sfx.play("undo");
    } catch (e) {
      if (e !== "Nothing to redo") reportError(e);
    }
  }, [applyEditResult, reportError]);

  // Returns whether the save actually landed — callers that update other state on the assumption
  // the file now exists at `path` (Save As's `setSourcePath`) must check this instead of assuming
  // success just because the promise resolved; this function swallows its own errors (toast +
  // `reportError`) rather than rethrowing, so `await`ing it alone can't distinguish success from
  // failure. Without the check, a failed Save As still pointed `sourcePath` at a file that was
  // never written, which made a later Upload fail with "Cannot read world: No such file or
  // directory" — the state believed a save had happened when it hadn't.
  const saveWorld = useCallback(async (path: string): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      // save_world writes raw bytes or a zip purely based on `compressed` — it doesn't look at
      // the path's extension. Loading detects the real format by magic bytes either way, so this
      // never corrupts anything, but a saveCompressed toggle can leave a zip sitting in a
      // ".eden"-named file (or vice versa), which the game and other non-magic-byte-aware tools
      // won't necessarily open. Warn once per mismatched path/flag combo on a plain Save; Save As
      // (below) fixes the extension outright since the user is choosing a fresh path anyway.
      const dot = path.lastIndexOf(".");
      const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
      const expectedExt = saveCompressed ? "zip" : "eden";
      if ((ext === "eden" || ext === "zip") && ext !== expectedExt) {
        const warnKey = `${path}|${saveCompressed}`;
        if (lastExtWarnRef.current !== warnKey) {
          lastExtWarnRef.current = warnKey;
          showToast(`Saved ${saveCompressed ? "compressed" : "uncompressed"} data in a “.${ext}” file. Other tools may not open it.`);
        }
      }
      // save_world also re-bases the autosave onto the file it just wrote (18.9), which replaces the
      // old sidecars — no discard_autosave here any more.
      await invoke("save_world", { path, compressed: saveCompressed, backupCompressed });
      lastAutosavedEpochRef.current = editEpochRef.current;
      savedEpochRef.current = editEpochRef.current;
      setLastSavedAt(Date.now()); // status-bar "Saved" timestamp (Stage 15.6)
      sfx.play("save"); // the one place saveWorld resolves true — every caller inherits this cue
      return true;
    } catch (e) {
      reportError(e);
      return false;
    } finally {
      setSaving(false);
    }
  }, [saveCompressed, showToast, reportError]);

  const saveWorldAs = useCallback(async () => {
    const chosen = await save({
      filters: [{ name: "Eden World", extensions: ["eden", "zip"] }],
      defaultPath: sourcePath ?? undefined,
    });
    if (!chosen) return;
    // Save As is a fresh path choice — silently correct the extension to match the compressed
    // flag rather than warn, since there's no existing file identity to preserve.
    const dot = chosen.lastIndexOf(".");
    const ext = dot >= 0 ? chosen.slice(dot + 1).toLowerCase() : "";
    const expectedExt = saveCompressed ? "zip" : "eden";
    const finalPath = (ext === "eden" || ext === "zip") && ext !== expectedExt
      ? `${chosen.slice(0, dot)}.${expectedExt}`
      : chosen;
    // The native Save dialog only confirmed overwrite for `chosen` — if extension correction
    // above rewrote the path, `finalPath` names a different file the user never confirmed.
    if (finalPath !== chosen && await invoke<boolean>("prefab_exists", { path: finalPath })) {
      const ok = await confirmDialog(
        `${finalPath.slice(finalPath.lastIndexOf("/") + 1)} already exists. Overwrite it?`,
        { title: "Confirm overwrite", kind: "danger", okLabel: "Overwrite" },
      );
      if (!ok) return;
    }
    const ok = await saveWorld(finalPath);
    if (ok) {
      setSourcePath(finalPath);
      saveWindowLayoutAs(normalizePath(finalPath, IS_WINDOWS)!); // the copy inherits the window layout
    }
  }, [sourcePath, saveWorld, saveCompressed]);

  // Upload sends `sourcePath` — the file on disk, not the in-memory world — so unsaved edits
  // would silently upload a stale version. Gate opening the modal on the same `isDirty()` check
  // the close/quit/open-new-world guards use, offering a Save first.
  const requestShowUploadModal = useCallback(async (v: boolean) => {
    if (!v) { setShowUploadModal(false); return; }
    if (isDirty()) {
      const ok = await confirmDialog(
        "You have unsaved changes. Uploading now would send the last saved version, not your current edits. Save first?",
        { title: "Unsaved changes", icon: "save", okLabel: "Save", cancelLabel: "Cancel" },
      );
      if (!ok) return;
      if (sourcePath) {
        const saved = await saveWorld(sourcePath);
        if (!saved) return;
      } else {
        await saveWorldAs();
        if (isDirty()) return; // Save As was cancelled or failed
      }
    }
    setShowUploadModal(true);
  }, [isDirty, sourcePath, saveWorld, saveWorldAs]);

  // Timer-based autosave: every `autosaveIntervalMin` minutes (Settings → Editor; default 3), if a
  // world is loaded and has unsaved edits (editEpoch moved since the last autosave/save), snapshot
  // it to a sidecar file so a crash doesn't lose everything since the last manual save. Does not
  // touch sourcePath or the undo stack — purely a safety-net copy on disk. 0 disables it.
  useEffect(() => {
    if (!world || autosaveIntervalMin <= 0) return;
    const AUTOSAVE_MS = autosaveIntervalMin * 60 * 1000;
    const id = setInterval(() => {
      if (editEpochRef.current === lastAutosavedEpochRef.current) return;
      const epoch = editEpochRef.current;
      invoke<boolean>("autosave_world", { sourcePath: sourcePathRef.current })
        .then((ran) => {
          if (!ran) return; // skipped: a save was running (18.9). The next interval retries.
          lastAutosavedEpochRef.current = epoch;
          autosaveFailureCountRef.current = 0;
          setLastSavedAt(Date.now()); // status-bar "Saved" timestamp (Stage 15.6)
        })
        .catch((e) => {
          autosaveFailureCountRef.current += 1;
          console.warn("Autosave failed:", e);
          if (autosaveFailureCountRef.current >= 2) reportError(e);
        });
    }, AUTOSAVE_MS);
    return () => clearInterval(id);
    // sourcePath deliberately excluded — read via sourcePathRef so a Save As mid-interval doesn't
    // reset the timer and delay the next autosave tick indefinitely.
  }, [world, autosaveIntervalMin, reportError]);

  // Startup check: was there a pending autosave from a session that never cleanly saved?
  useEffect(() => {
    invoke<AutosaveInfo | null>("get_autosave_info")
      .then((info) => { if (info) setRecoveryInfo(info); })
      .catch(() => {});
  }, []);

  // Warn before the OS window closes (title-bar close button / ⌘Q) if there are unsaved edits.
  // preventDefault holds the window open until the user confirms, then destroy() closes it for real.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (event) => {
      if (!isDirty()) return; // clean — let the close proceed
      event.preventDefault();
      // Best-effort autosave before the confirm prompt: the periodic timer never gets to fire on
      // quit (the window closes before its next tick), so without this a "Quit and discard" decline
      // followed by a crash mid-relaunch could lose everything since the last periodic tick instead
      // of just what changed since this attempt.
      if (editEpochRef.current !== lastAutosavedEpochRef.current) {
        const epoch = editEpochRef.current;
        try {
          const ran = await invoke<boolean>("autosave_world", { sourcePath: sourcePathRef.current });
          if (ran) lastAutosavedEpochRef.current = epoch;
          autosaveFailureCountRef.current = 0;
        } catch (e) {
          autosaveFailureCountRef.current += 1;
          console.warn("Autosave-on-quit failed:", e);
          if (autosaveFailureCountRef.current >= 2) reportError(e);
        }
      }
      const ok = await confirmDialog("You have unsaved changes. Quit and discard them?", {
        title: "Unsaved changes", kind: "danger", okLabel: "Quit without saving",
      });
      if (ok) win.destroy();
    });
    return () => { unlisten.then((f) => f()); };
  }, [isDirty, reportError]);

  async function recoverAutosave() {
    if (!recoveryInfo) return;
    setRecovering(true);
    try {
      if (recoveryInfo.format >= 1) {
        // Base+journal recovery doesn't go through load_world at all — the sidecars aren't a
        // loadable file on their own, so this resolves and replays them directly.
        const data = await invoke<WorldMeta>("load_autosave");
        applyLoadedWorld(data, recoveryInfo.source_path ?? null, { skipRecent: true });
      } else {
        const autosavePath = await invoke<string>("get_autosave_path");
        await openFileAt(autosavePath, { skipRecent: true });
        setSourcePath(recoveryInfo.source_path ?? null);
      }
      // The recovery path above marks the freshly-loaded autosave "clean" (savedEpochRef = current
      // edit epoch), but the in-memory world differs from the file at sourcePath — nothing has
      // actually been saved there yet. Force dirty so the close/quit prompt guards this until a
      // real Save succeeds. Deliberately do NOT discard the autosave sidecar here (unlike the
      // decline path below): the periodic autosave timer won't refire until the next edit
      // (lastAutosavedEpochRef already matches), so a crash right after recovery — before any edit
      // or manual save — would otherwise leave nothing to recover. The sidecar is only discarded
      // once a real Save succeeds (saveWorld/saveWorldAs) or the user later declines a fresh
      // recovery prompt.
      savedEpochRef.current = -1;
      setRecoveryInfo(null);
    } catch (e) {
      reportError(e);
    } finally {
      setRecovering(false);
    }
  }

  // The autosave builds on a world file that was saved or changed after it (18.9 `base_status`
  // "changed"): it can never be applied, so drop it and open the file itself.
  async function openRecoveryBase() {
    const path = recoveryInfo?.base?.kind === "source" ? recoveryInfo.base.path : recoveryInfo?.source_path;
    try { await invoke("discard_autosave"); } catch { /* best effort */ }
    setRecoveryInfo(null);
    if (path) await openFileAt(path);
  }

  // Destroys the autosave sidecar. Only reachable from RecoveryModal's explicit
  // Discard → confirm; Esc/backdrop go to dismissRecovery instead (C1).
  async function discardRecovery() {
    try { await invoke("discard_autosave"); } catch { /* best effort */ }
    setRecoveryInfo(null);
  }

  // Closes the prompt without touching the sidecar — it's re-offered on next launch.
  function dismissRecovery() {
    setRecoveryInfo(null);
  }

  // Any dialog-style modal open? (HelpModal is excluded — it has its own key handling below.)
  // When one is up it owns the keyboard, so editor shortcuts must not fire underneath it.
  const confirmOpen = useConfirmOpen();
  const anyModalOpen =
    showAbout || showSettings || showWorldInfo || showWorldBrowser || showUploadModal ||
    showNewWorld || showExpandModal || !!recoveryInfo || prefabNameModal ||
    tourOpen || confirmOpen;
  const anyModalOpenRef = useRef(false);
  useEffect(() => { anyModalOpenRef.current = anyModalOpen; }, [anyModalOpen]);

  // Auto-trigger the onboarding tour the first time a world becomes loaded (new/open/download/
  // recent/recovery — this effect runs after the editor branch has mounted regardless of which
  // path got us here, so it doesn't need a change to `applyLoadedWorld`'s call sites). Gated on a
  // versioned settings flag: `tourVersion < TOUR_VERSION` covers both a fresh install (0 < N) and
  // a re-onboard after `bump-version.sh` raises TOUR_VERSION. Written at *open* time, not
  // completion — a user who immediately skips has still been offered it once.
  useEffect(() => {
    if (!world || tourCheckedRef.current || anyModalOpen) return;
    tourCheckedRef.current = true;
    if (loadSettings().tourVersion < TOUR_VERSION) {
      saveSettings({ tourVersion: TOUR_VERSION });
      setTourOpen(true);
    }
  }, [world, anyModalOpen]);

  // Live Ctrl/⌘-invert and Shift-temporary-smooth modifier tracking for sculpt strokes (read by
  // applySculpt on every stamp — see sculptModRef's declaration). Tracks the modifier keys' own
  // press/release directly rather than deriving from a specific shortcut's keydown, so it stays
  // correct even when no other shortcut fires; resets on blur since a modifier released while the
  // window is unfocused (e.g. alt-tabbing mid-stroke) never reaches a keyup here otherwise.
  useEffect(() => {
    const track = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") sculptModRef.current.ctrl = e.type === "keydown";
      if (e.key === "Shift") sculptModRef.current.shift = e.type === "keydown";
    };
    const onBlur = () => { sculptModRef.current = { ctrl: false, shift: false }; };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // WebView2 (Windows/Linux) ships with its browser accelerator keys on by default and Tauri
      // 2.11 doesn't expose a switch to turn them off — so any Ctrl combo this handler doesn't
      // preventDefault falls through to the Chromium shell: Ctrl+R/F5 reload the webview (dropping
      // all frontend state while the backend still holds the world and its undo stack), Ctrl+F opens
      // find, Ctrl+P prints, Ctrl+G/F3 find-next. WKWebView on macOS has no such accelerators, so this
      // is Windows/Linux-only. Devtools (Ctrl+Shift+I/F12) are deliberately left alone.
      if (!IS_MAC && (e.ctrlKey || ["F3", "F5"].includes(e.key)) && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === "r" || k === "f" || k === "p" || k === "g" || e.key === "F3" || e.key === "F5") {
          e.preventDefault();
        }
      }
      // Floating-window toggles (UI redesign r3, Stages 14.4/14.5): ⌥3 3D view, ⌥T Tools, ⌥H
      // Hotbar, ⌥P Lens. Matched on `e.code` — ⌥3 on macOS types "£" in `e.key`. `!ctrlKey` keeps Windows
      // **AltGr** (= Ctrl+Alt) from ever firing them on EU layouts (AltGr+3 types "³"). Checked
      // ahead of the hotbar digits (Alt+3 is not "slot 3") and of the fly-camera gate below: the
      // fly controller doesn't use ⌥+key, and a bare Alt press still reaches FlyView3D's own
      // listener because this only acts on a real key code.
      if (world && e.altKey && !e.ctrlKey && !e.metaKey && !isTypingTarget(e.target) && !anyModalOpenRef.current && !showHelp) {
        const act = windowKeysRef.current[e.code];
        if (act) { e.preventDefault(); act(); return; }
      }
      // Hotbar digits (1-5 pinned, 6-0 recent) work even while the 3D fly camera is active — WASD/
      // space/ctrl/shift are the only keys the fly controller actually needs, so digits jump ahead
      // of the fly-camera gate below and arm a block for 3D build mode without leaving the pane.
      if (world && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && !anyModalOpenRef.current && !showHelp) {
        if (["1","2","3","4","5"].includes(e.key)) {
          const idx = parseInt(e.key) - 1;
          e.preventDefault();
          const b = pinnedBlocksRef.current[idx];
          if (b) { setFillBlockType(b.type); setFillPaint(b.paint); }
          return;
        }
        if (["6","7","8","9","0"].includes(e.key)) {
          const idx = e.key === "0" ? 4 : parseInt(e.key) - 6;
          e.preventDefault();
          const b = recentBlocksRef.current[idx];
          if (b) { setFillBlockType(b.type); setFillPaint(b.paint); }
          return;
        }
      }
      // While the 3D fly camera is active, it owns unmodified keys (WASD/space/ctrl/shift) for
      // movement — don't fire editor shortcuts for those. But the fly controller never consumes
      // Cmd-combos, so let ⌘Z/⌘S/etc. through instead of leaving them dead until the pane exits.
      // On Windows/Linux the accelerator modifier is Ctrl, not Cmd — Ctrl is also FlyView3D's
      // descend key, so a bare `e.ctrlKey` check would let every combo through while still sinking
      // the camera downward for the length of the keypress. Bare Control (no other key yet) must
      // still fall through to the fly controller.
      if (flyActiveRef.current && !e.metaKey && !(e.ctrlKey && e.key !== "Control")) return;
      // A modal dialog is open — let it own the keyboard (its own Escape/Enter handling applies).
      if (anyModalOpenRef.current) return;
      const typing = isTypingTarget(e.target);
      // Tab swaps map ⇄ 3D (Stage 14.4) — but Tab is also keyboard focus traversal (the Popover/
      // Segmented keyboard model depends on it), so it swaps ONLY when focus is on the page body,
      // one of the two viewport canvases, or a floating window's title bar; anywhere else it stays
      // native. Never while walking (the fly gate above already returned).
      if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && world && !showHelp) {
        const a = document.activeElement as HTMLElement | null;
        const onViewport = !a || a === document.body
          || (a.tagName === "CANVAS" && !!a.closest("[data-viewport-host]"))
          || a.hasAttribute("data-win-title");
        if (onViewport) { e.preventDefault(); swapViewsRef.current(); return; }
      }
      // ? always toggles help (skip when typing in an input)
      if (e.key === "?" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowHelp(h => !h);
        return;
      }
      // When help is open, Escape closes it and all other shortcuts are blocked
      if (showHelp) {
        if (e.key === "Escape") { e.preventDefault(); setShowHelp(false); }
        return;
      }
      if (!world) return;
      if (e.key === "Escape" && !typing) {
        // The context menu is the frontmost transient surface — it steps back first, before
        // paste locks / 3D picks / the tool itself.
        if (ctxMenuRef.current) {
          e.preventDefault();
          setCtxMenu(null);
          return;
        }
        if (lockedPastePosRef.current) {
          e.preventDefault();
          setLockedPastePos(null);
          return;
        }
        // Abandon a half-finished two-click 3D selection before falling through to the tool/selection
        // step-back below — same "Escape steps back one stage" idiom as the paste flow above.
        if (pick3dFirstRef.current) {
          e.preventDefault();
          setPick3dFirst(null);
          return;
        }
        const t = appToolRef.current;
        if (t === "paste" || t === "wand" || t === "lasso" || t === "polyselect" || t === "pen" || t === "brush" || t === "spray" || t === "line" || t === "rect" || t === "ellipse" || t === "polygon" ||
            t === "smooth" || t === "noise" || t === "flatten" || t === "erode" || t === "thermal" ||
            t === "hydro" || t === "stamp" || t === "grab" || t === "raise" || t === "lower" ||
            t === "terrace" || t === "sharpen" || t === "slope" || t === "smear" || t === "rock" || t === "carve" || t === "fill" || t === "eyedropper" || t === "poolfill") {
          e.preventDefault();
          setTool("pan");
        } else {
          e.preventDefault();
          setRawBounds(null);
        }
        return;
      }
      if (e.key === "Home" && !typing) {
        e.preventDefault();
        mapCanvasRef.current?.resetView();
        return;
      }
      // Draw tool shortcuts (only when not typing in an input)
      if (!typing && !e.metaKey && !e.ctrlKey) {
        // Space = hold-to-pan (the Ribbon has advertised it in a tooltip since the toolbar rewrite,
        // but it was never wired). The armed tool is restored on keyup; `e.repeat` guards against
        // auto-repeat overwriting spaceReturnToolRef with "pan" itself.
        if (e.key === " " && !e.repeat) {
          // Space is also how you activate a focused button/checkbox/link with the keyboard —
          // swallowing it here would make those controls keyboard-dead. Text-like inputs are
          // already excluded above via `typing`; a focused range slider (tag INPUT, type "range")
          // isn't "typing" and should still hold-to-pan, so this only excludes the tags/types where
          // Space has its own native activation behavior.
          const target = e.target as HTMLElement | null;
          const tag = target?.tagName;
          if (tag === "BUTTON" || tag === "SELECT" || tag === "A") return;
          if (tag === "INPUT" && (target as HTMLInputElement).type !== "range") return;
          e.preventDefault();
          if (appToolRef.current !== "pan") {
            spaceReturnToolRef.current = appToolRef.current;
            setTool("pan");
          }
          return;
        }
        if (e.key === "s" || e.key === "S") { e.preventDefault(); setTool("select"); return; }
        if (e.key === "p" || e.key === "P") { e.preventDefault(); setTool("pen"); return; }
        if (e.key === "b" || e.key === "B") { e.preventDefault(); setTool("brush"); return; }
        if (e.key === "l" || e.key === "L") { e.preventDefault(); setTool("line"); return; }
        if (e.key === "r" || e.key === "R") { e.preventDefault(); setTool("rect"); return; }
        if (e.key === "e" || e.key === "E") { e.preventDefault(); setTool("ellipse"); return; }
        if (e.key === "g" || e.key === "G") { e.preventDefault(); setTool("polygon"); return; }
        if (e.key === "f" || e.key === "F") { e.preventDefault(); setTool("fill"); return; }
        if (e.key === "w" || e.key === "W") { e.preventDefault(); setTool("wand"); return; }
        if (e.key === "k" || e.key === "K") { e.preventDefault(); setTool("lasso"); return; }
        if (e.key === "j" || e.key === "J") { e.preventDefault(); setTool("polyselect"); return; }
        // Delete/Backspace clears the current selection (audit H9) — advertised in tooltips
        // (Home's Delete button, the Quick Actions bar) since before there was ever a binding.
        if ((e.key === "Delete" || e.key === "Backspace") && appToolRef.current === "select" && rawBoundsRef.current) {
          e.preventDefault();
          void deleteBlocksRef.current();
          return;
        }
        if (e.key === "i" || e.key === "I") {
          e.preventDefault();
          prevToolRef.current = appToolRef.current === "eyedropper" ? "pen" : appToolRef.current;
          setTool("eyedropper");
          return;
        }
        // Hotbar digits (1-5/6-0) are now handled unconditionally near the top of onKeyDown, above
        // the fly-camera gate, so they work in 3D build mode too — see the comment there.
        // `.` = repeat last paste one step further in the same direction
        if (e.key === "." && appToolRef.current === "paste") {
          const pos   = lastPastePosRef.current;
          const delta = lastPasteDeltaRef.current;
          if (pos && delta) {
            e.preventDefault();
            pasteAtRef.current({ x: pos.x + delta.dx, y: pos.y + delta.dy });
          }
          return;
        }
        // PgUp/PgDn raise/lower the armed paste; Shift = ±5. The ghost's z±N label follows live,
        // which is the whole point — the offset used to be a number buried in the Selection tab.
        if ((e.key === "PageUp" || e.key === "PageDown") && appToolRef.current === "paste" && clipboardRef.current) {
          e.preventDefault();
          const step = (e.shiftKey ? 5 : 1) * (e.key === "PageUp" ? 1 : -1);
          setPasteElevationOffset(o => o + step);
          sfx.play("nudge");
          return;
        }
        // Arrow keys nudge the selection (and its contents) by 1 block; Shift = 10.
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
            && appToolRef.current === "select" && rawBoundsRef.current) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
          nudgeSelection(dx, dy);
          return;
        }
        // Sculpt radius/strength: `[`/`]` resize the brush, Shift+`[`/`]` adjusts strength instead.
        // Brackets avoid every wheel conflict (wheel is zoom on the map, fly-speed in the 3D pane).
        const st = appToolRef.current;
        const isSculptToolKey = st === "smooth" || st === "noise" || st === "flatten" || st === "erode" ||
          st === "thermal" || st === "hydro" || st === "stamp" || st === "grab" || st === "raise" || st === "lower" ||
          st === "terrace" || st === "sharpen" || st === "slope" || st === "smear" || st === "rock" || st === "carve";
        // Shift+[ / Shift+] arrive as "{" / "}" on US-style layouts — matching only "[" / "]" meant
        // the strength half of this shortcut never fired there.
        const bracket = e.key === "[" || e.key === "{" ? -1 : e.key === "]" || e.key === "}" ? 1 : 0;
        if (isSculptToolKey && bracket !== 0) {
          e.preventDefault();
          const dir = bracket;
          if (e.shiftKey) setSculptStrength(s => Math.max(1, Math.min(8, s + dir)));
          else setSculptRadius(r => Math.max(1, Math.min(32, r + dir)));
          return;
        }
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      // Normalize case: with Shift (⌘⇧Z) or Caps Lock, e.key is uppercase ("Z"), so a bare
      // === "z" comparison silently misses. This was why ⌘⇧Z redo never fired.
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); handleRedo(); }
      if (k === "c") { e.preventDefault(); copySelection(); }
      if (k === "v") {
        e.preventDefault();
        if (clipboardRef.current) setTool("paste");
      }
      // ⌘⇧S = Save As (the File menu has always shown this accelerator). Without the shiftKey test
      // it silently performed a plain Save over the current file.
      if (k === "s") {
        e.preventDefault();
        if (e.shiftKey || !sourcePathRef.current) saveWorldAs();
        else saveWorld(sourcePathRef.current);
      }
      if (k === "n") { e.preventDefault(); setShowNewWorld(true); }
      if (k === "o") { e.preventDefault(); void openFileRef.current(); }
      // Selection conventions every creative tool shares.
      if (k === "a") {
        e.preventDefault();
        setRawBounds({ x1: 0, y1: 0, x2: chunkToWorld(world.width_chunks) - 1, y2: chunkToWorld(world.height_chunks) - 1 });
      }
      if (k === "d") { e.preventDefault(); setRawBounds(null); }
      // Zoom: ⌘0 fit map, ⌘+/⌘− step, ⌘⇧0 zoom to selection. (⌘= is the unshifted "+" key.)
      if (k === "0" && e.shiftKey) {
        e.preventDefault();
        const rb = rawBoundsRef.current;
        if (rb) mapCanvasRef.current?.zoomToBox(rb.x1, rb.y1, rb.x2, rb.y2);
      } else if (k === "0") {
        e.preventDefault();
        mapCanvasRef.current?.resetView();
      }
      if (k === "=" || k === "+") { e.preventDefault(); mapCanvasRef.current?.zoomBy(KEY_ZOOM_STEP); }
      if (k === "-" || k === "_") { e.preventDefault(); mapCanvasRef.current?.zoomBy(1 / KEY_ZOOM_STEP); }
      // macOS conventions: ⌘, opens Settings, ⌘W closes the world (both guarded like their menu items).
      if (k === ",") { e.preventDefault(); setShowSettings(true); }
      if (k === "w") { e.preventDefault(); void closeWorldRef.current(); }
    };
    // Space is hold-to-pan: releasing it restores whatever tool was armed. `blur` releases the hold
    // too — otherwise alt-tabbing mid-hold swallows the keyup and strands the user in Pan.
    const releaseSpacePan = () => {
      const back = spaceReturnToolRef.current;
      if (!back) return;
      spaceReturnToolRef.current = null;
      setTool(back);
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === " ") releaseSpacePan(); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseSpacePan);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseSpacePan);
    };
    // clipboard/sourcePath/rawBounds deliberately excluded — read via clipboardRef/sourcePathRef/
    // rawBoundsRef so this handler doesn't re-register on every selection or clipboard change (L2).
  }, [world, showHelp, handleUndo, handleRedo, copySelection, saveWorld, saveWorldAs, nudgeSelection]);

  // Menu close effects handled inside Ribbon component

  // Template overlay helpers
  async function loadTexturePackFile(path: string) {
    try {
      const atlas = decodeAtlas(await invoke<ArrayBuffer>("load_texture_pack", { path }));
      clearSwatchCache();
      setTexturePackInfo(atlas);
      setTexturePackPath(path);
      setTexEpoch(e => e + 1);
      saveSettings({ texturePackPath: path });
    } catch (e) { reportError(e); }
  }

  async function openTexturePackFile() {
    const selected = await open({
      filters: [
        { name: "Texture Pack or Atlas", extensions: ["zip", "png", "jpg", "jpeg", "bmp"] },
        { name: "Zip Pack", extensions: ["zip"] },
        { name: "Atlas Image", extensions: ["png", "jpg", "jpeg", "bmp"] },
      ],
    });
    if (!selected || Array.isArray(selected)) return;
    await loadTexturePackFile(selected);
  }

  function unloadTexturePack() {
    invoke("unload_texture_pack").catch(e => reportError(e));
    clearSwatchCache();
    setTexturePackInfo(null);
    setTexturePackPath(null);
    setTexEpoch(e => e + 1);
    saveSettings({ texturePackPath: null });
  }

  // Auto-load texture pack from settings on startup
  useEffect(() => {
    if (texturePackPath) loadTexturePackFile(texturePackPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTemplateFile(path: string) {
    try {
      await invoke<number>("load_eden_template", { path });
      setTemplateLoaded(true);
      setTemplatePath(path);
      setShowTemplateOverlay(true);
      saveSettings({ templatePath: path });
    } catch (e) { reportError(e); }
  }

  async function openTemplateFile() {
    const selected = await open({ filters: [{ name: "Eden World", extensions: ["eden"] }] });
    if (!selected || Array.isArray(selected)) return;
    await loadTemplateFile(selected);
  }

  // Expand progress event listener
  useEffect(() => {
    const unlisten = listen<number>("expand_progress", (e) => {
      setExpandProgress(e.payload);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  // Shared long-operation progress (audit C6/M14). The backend emits one `long-op` stream for
  // every long command: a `begin` event carrying `label`/`cancellable`, throttled progress events
  // carrying only what changed, and a final `finished` event. Later events are merged onto the
  // begin event rather than replacing it, so `label` and `cancellable` survive; a `finished` for
  // an id we're no longer showing is ignored, so a late event can't blank the current operation.
  useEffect(() => {
    const unlisten = listen<LongOpState & { finished?: boolean }>("long-op", (e) => {
      const p = e.payload;
      setLongOp((prev) => {
        if (p.finished) return prev && prev.id === p.id ? null : prev;
        if (prev && prev.id === p.id) return { ...prev, ...p };
        return p;
      });
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  const cancelLongOp = useCallback(() => {
    if (longOp) void invoke("cancel_long_op", { id: longOp.id });
  }, [longOp]);

  async function runExpand() {
    const outPath = await save({ filters: [{ name: "Eden World", extensions: ["eden"] }], defaultPath: "world_expanded.eden" });
    if (!outPath) return;
    setExpandInProgress(true);
    setExpandProgress(0);
    setExpandResult(null);
    try {
      const res = await invoke<{ chunks_added: number; total_chunks: number }>("expand_world_from_template", {
        outputPath: outPath,
        fullExtent: expandFullExtent,
      });
      setExpandResult({ chunksAdded: res.chunks_added, totalChunks: res.total_chunks });
    } catch (e) {
      if (String(e) !== "Cancelled") reportError(e);
    } finally {
      setExpandInProgress(false);
      setExpandProgress(100);
    }
  }

  function cancelExpand() {
    invoke("cancel_expand").catch(() => {});
  }

const handleSelectionChange = useCallback((bounds: SelectionBounds | null) => {
    setRawBounds(bounds);
  }, []);

  const handleMaterializeSelectionChange = useCallback((bounds: MaterializeSelectionBounds | null) => {
    setMaterializeSelection(bounds);
  }, []);

  // Default "Save Prefab" opens an in-app name modal that writes into the prefab library folder —
  // deliberately avoiding the native NSSavePanel, which hangs ~30s on macOS Sonoma (ViewBridge
  // XPC stall). "Save As…" (below) still offers the native picker for saving to any folder.
  function openPrefabNameModal() {
    if (!clipboard) { reportError("Copy a selection first, then save it as a prefab."); return; }
    setPrefabNameInput(world?.name?.trim() || "prefab");
    setPrefabOverwrite(false);
    setPrefabNameModal(true);
  }

  async function confirmSavePrefab() {
    const name = prefabNameInput.trim();
    if (!name || prefabSaving) return;
    setPrefabSaving(true);
    try {
      const dir = await resolvePrefabDir();
      if (!dir) throw new Error("Could not resolve the prefab library folder");
      const safe = name.replace(/[/\\]/g, "_").replace(/\.epfab$/i, "");
      const path = `${dir}/${safe}.epfab`;
      // First attempt: warn (don't save) if a prefab with this name already exists. A second click
      // (prefabOverwrite armed) confirms the overwrite. Editing the name re-arms the guard.
      if (!prefabOverwrite && await invoke<boolean>("prefab_exists", { path })) {
        setPrefabOverwrite(true);
        return;
      }
      const warnings = await invoke<string[]>("save_prefab", { path });
      setPrefabRefreshToken((t) => t + 1);
      setPrefabNameModal(false);
      showToast(`Saved prefab “${safe}”`);
      for (const w of warnings) pushToast(w, "error");
    } catch (e) {
      reportError(e);
    } finally {
      setPrefabSaving(false);
    }
  }

  // Native "save anywhere" fallback. Kept for users who want prefabs outside the library folder.
  async function savePrefabAs() {
    if (!clipboard) { reportError("Copy a selection first, then save it as a prefab."); return; }
    const path = await save({
      filters: [{ name: "Eden Prefab", extensions: ["epfab"] }],
      defaultPath: `${world?.name ?? "prefab"}.epfab`,
    });
    if (!path) return;
    await invoke<string[]>("save_prefab", { path })
      .then((warnings) => {
        setPrefabRefreshToken((t) => t + 1);
        for (const w of warnings) pushToast(w, "error");
      })
      .catch((e) => reportError(e));
  }

  async function loadPrefab() {
    const path = await open({
      filters: [{ name: "Eden Prefab", extensions: ["epfab"] }],
      multiple: false,
    });
    if (!path || typeof path !== "string") return;
    const info = await invoke<ClipboardInfo>("load_prefab", { path })
      .catch((e: unknown) => { reportError(e); return null; });
    if (!info) return;
    setClipboard(info);
    setTool("paste");
  }

  async function deleteBlocks() {
    if (!rawBounds) return;
    try {
      const result = filterBlockType !== null
        ? await invoke<ArrayBuffer>("replace_blocks", {
            ...rawBounds, zMin, zMax,
            newBlockType: 0, newPaint: 0,
            filterBlockType, filterPaint, filterInvert,
          })
        : await invoke<ArrayBuffer>("delete_blocks", { ...rawBounds, zMin, zMax });
      await applyEditResult(result);
    } catch (e) {
      reportError(e);
    }
  }

  // Stable ref so the keyboard handler (which reads rawBounds via rawBoundsRef, not state) can
  // always call the latest deleteBlocks closure without re-registering on every selection change.
  const deleteBlocksRef = useRef(deleteBlocks);
  useEffect(() => { deleteBlocksRef.current = deleteBlocks; });

  /**
   * Cut = copy, then clear. Composed here rather than added as a Rust command because
   * `copy_selection` is read-only and pushes no undo entry, so the pair already yields **one**
   * undo step — a dedicated command would buy nothing but a nicer toast label.
   */
  async function cutSelection() {
    if (!rawBounds) return;
    await copySelection();
    await deleteBlocks();
  }

  async function fillSelection() {
    if (!rawBounds) return;
    try {
      const result = await invoke<ArrayBuffer>("replace_blocks", {
        ...rawBounds, zMin, zMax,
        newBlockType: fillBlockType,
        newPaint: fillBlockType === 0 ? 0 : fillPaint,
        filterBlockType,
        filterPaint,
        filterInvert,
      });
      await applyEditResult(result);
    } catch (e) {
      reportError(e);
    }
  }

  async function applyGradientFill() {
    if (!rawBounds) return;
    try {
      const result = await invoke<ArrayBuffer>("gradient_fill", {
        ...rawBounds, zMin, zMax,
        bt1: fillBlockType, paint1: fillBlockType === 0 ? 0 : fillPaint,
        bt2: gradientToBlock, paint2: gradientToBlock === 0 ? 0 : gradientToPaint,
        axis: gradientAxis, includeAir: gradientIncludeAir,
      });
      await applyEditResult(result);
    } catch (e) {
      reportError(e);
    }
  }

  function handleZMin(raw: string) {
    const v = Math.max(0, Math.min(world?.max_z ?? 63, parseInt(raw, 10) || 0));
    setZMin(Math.min(v, zMax));
  }

  function handleZMax(raw: string) {
    const v = Math.max(0, Math.min(world?.max_z ?? 63, parseInt(raw, 10) || 0));
    setZMax(Math.max(v, zMin));
  }

  // ⌘W reaches closeWorld through this ref: it's a plain (non-memoized) function, so depending on
  // it directly would re-register the global keydown listener on every render.
  const closeWorldRef = useRef<() => void | Promise<void>>(() => {});
  closeWorldRef.current = closeWorld;

  const openFileAtRef = useRef(openFileAt);
  openFileAtRef.current = openFileAt;

  // Drag-and-drop a .eden/.zip world file onto the window — many users try this first. Tauri's
  // native drag-drop (dragDropEnabled, on by default) replaces the browser's own HTML5 drag events,
  // so this goes through onDragDropEvent rather than a React onDrop handler. Reuses openFileAt's
  // existing unsaved-changes guard — same funnel as Recent Worlds / World Browser / File▾ Open.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const path = event.payload.paths.find((p) => /\.(eden|zip)$/i.test(p));
      if (!path) {
        showToast("Drop a .eden or .zip world file to open it.");
        return;
      }
      void openFileAtRef.current(path);
    });
    return () => { unlisten.then((f) => f()); };
  }, [showToast]);
  // Same for ⌘O → openFile (also a plain function declaration).
  const openFileRef = useRef<() => void | Promise<void>>(() => {});
  openFileRef.current = openFile;

  async function closeWorld() {
    if (isDirty()) {
      const ok = await confirmDialog("You have unsaved changes. Close this world and discard them?", {
        title: "Unsaved changes", kind: "danger", okLabel: "Discard changes",
      });
      if (!ok) return;
    }
    closeWindowWorld();                         // flush this world's window layout
    invoke("close_world").catch(() => {});      // release backend mmap / undo stack / staged temp
    invoke("discard_autosave").catch(() => {}); // discarded on purpose — nothing to recover
    // Reconcile the dirty-tracking refs to the now-closed world — otherwise a dirty close (just
    // confirmed above) leaves savedEpochRef stale, and the very next onCloseRequested/openFileAt
    // guard re-asks to discard changes that no longer exist (the world they belonged to is gone).
    savedEpochRef.current = editEpochRef.current;
    lastAutosavedEpochRef.current = editEpochRef.current;
    setWorld(null);
    setSourcePath(null);
    setRawBounds(null);
    setMaterializeSelection(null);
    setClipboard(null);
    setUndoDepth(0);
    setRedoDepth(0);
    setTool("pan");
    setSpawnPos(null);
    setPlayerPos(null);
    setSigns([]);
    setTemplateLoaded(false);
    setShowTemplateOverlay(false);
    resetHeavyLighting();
  }

  async function setSpawnAtSelection() {
    if (!selection) return;
    const cx = Math.round((selection.x1 + selection.x2) / 2);
    const cy = Math.round((selection.y1 + selection.y2) / 2);
    try {
      await invoke("set_spawn_pos", { px: cx, py: cy });
      setSpawnPos({ px: cx, py: cy });
      // set_spawn_pos writes into the mmapped header outside with_edit (no undo entry), so it
      // doesn't otherwise bump editEpoch — without this, the change is silently lost if the user
      // closes without saving (the unsaved-changes prompt only fires when dirty).
      setEditEpoch(e => e + 1);
    } catch (e) { reportError(e); }
  }

  /** Home ▸ Set Point ▸ Start. Mirrors `setSpawnAtSelection`, including its `editEpoch` bump —
   *  `set_player_pos` writes the header outside `with_edit`, so nothing else marks the session
   *  dirty and the change would vanish on close. */
  async function setPlayerPosAtSelection() {
    if (!selection) return;
    const cx = Math.round((selection.x1 + selection.x2) / 2);
    const cy = Math.round((selection.y1 + selection.y2) / 2);
    try {
      await invoke("set_player_pos", { px: cx, py: cy });
      setPlayerPos({ px: cx, py: cy });
      setEditEpoch(e => e + 1);
    } catch (e) { reportError(e); }
  }

  async function onRenameBlur(trimmed: string) {
    if (trimmed && world && trimmed !== world.name) {
      try {
        await invoke("rename_world", { name: trimmed });
        setWorld(w => w ? { ...w, name: trimmed } : null);
        setEditEpoch(e => e + 1); // header write outside with_edit — see setSpawnAtSelection
      } catch (e) { reportError(e); }
    }
    setRenamingWorld(false);
  }

  // View ▸ Windows ▸ Lens's armed state (20.4): the showing mode's flag, or both flags.
  const lensWindowArmed = lensArmed({
    pasteArmed: tool === "paste" && !!clipboard, hasSelection: selection != null,
    pasteOn: winKey[6] === "1", selOn: winKey[7] === "1",
  });

  const isSculptTool = tool === "smooth" || tool === "noise" || tool === "flatten" || tool === "erode" || tool === "thermal" || tool === "hydro" || tool === "stamp" || tool === "grab" || tool === "raise" || tool === "lower" || tool === "terrace" || tool === "sharpen" || tool === "slope" || tool === "smear" || tool === "rock" || tool === "carve";
  const isDrawTool = tool === "pen" || tool === "brush" || tool === "spray" || tool === "line" || tool === "rect" || tool === "ellipse" || tool === "polygon" || isSculptTool || tool === "fill";

  const mapPaneEl = world ? (
    <MapCanvas
      ref={mapCanvasRef}
      world={world}
      worldEpoch={worldEpoch}
      tool={tool}
      // Cutaway *is* the top-down view, just capped — the cap lives in the backend and reaches
      // MapCanvas only as `viewCapZ`, a refetch key (see the set_view_cap effect).
      viewMode={viewMode === "cutaway" ? "topdown" : viewMode}
      zSliceZ={zSliceZ}
      viewCapZ={viewCapZ}
      viewRelief={viewRelief}
      committedSelection={rawBounds}
      onSelectionChange={handleSelectionChange}
      pastePreview={clipboard && tool === "paste"
        ? { width: clipboard.width, height: clipboard.height }
        : null}
      clipboardPreviewPixels={tool === "paste" ? clipboardPreviewPixels : null}
      onPasteAt={handlePasteClick}
      lockedPastePos={lockedPastePos}
      tileBudgetBytes={MEMORY_PRESETS[memoryBudget].tileBudgetBytes}
      drawConfig={{ brushSize, brushShape, fillMode: drawFilled ? "fill" : "outline", sculptRadius, sculptSoftness, sculptProfile, sculptAccumulate, sprayDensity, strokeStabilizer }}
      onDrawStroke={handleDrawStroke}
      onSculptStroke={handleSculptStroke}
      onCancelStroke={handleUndo}
      drawZOverride={viewMode === "zslice" ? zSliceZ : null}
      extrudePreview={
        extrudeOpen && extrudeCount > 0 && rawBounds && (extrudeAxis.startsWith("x") || extrudeAxis.startsWith("y"))
          ? { axis: extrudeAxis, count: extrudeCount }
          : null
      }
      lastPasteDelta={lastPasteDelta}
      onCursorMove={handleCursorMove}
      onMagicWand={handleMagicWand}
      onLassoSelect={handleLassoSelect}
      onPolySelect={handlePolySelect}
      selectionMask={selectionMaskOverlay}
      spawnPos={spawnPos}
      playerPos={playerPos}
      creatures={[]}
      signs={showSigns ? signs : NO_SIGNS}
      pasteElevationOffset={pasteElevationOffset}
      onEyedropper={handleEyedropper}
      onPoolFillPick={handlePoolFillPick}
      // No longer prop-driven per move (Stage 10.2) — MapCanvas.setCameraDot() is called
      // imperatively from onCameraMove below. This only seeds the dot on (re)mount.
      onSetCamera3d={pane3dLive ? (wx, wy) => flyView3dRef.current?.teleport(wx, wy) : undefined}
      // Off in cutaway: the template is a surface map, so overlaying it under a cutaway would put
      // roof-level terrain behind the cave interior you're trying to see.
      showTemplateOverlay={showTemplateOverlay && templateLoaded && viewMode === "topdown"}
      onMapContextMenu={(wx, wy, x, y) => { sfx.play("menu"); setCtxMenu({ wx, wy, x, y }); }}
      onSelectDragUpdate={handleSelectDragUpdate}
      onSelectionCommitted={flashSelection}
      onMoveSelection={nudgeSelection}
      moveWithContents={moveWithContents}
      committedMaterializeSelection={materializeSelection}
      onMaterializeSelectionChange={handleMaterializeSelectionChange}
    />
  ) : null;

  // Status bar element — computed outside JSX so TypeScript narrows `world` properly
  // Tool-family hue (Stage 14.11 — "tool chip (family hue)"): resolves MapCanvas's family key to
  // an actual accent hex, the one place a colour source is needed for it (MapCanvas itself stays
  // colour-agnostic, see TOOL_FAMILY's doc comment).
  const toolAccentHex: Record<ToolFamily, string> = {
    primary: ACCENT.primary, warm: ACCENT.warm, selection: ACCENT.selection, clipboard: ACCENT.clipboard,
  };
  const toolAccent = toolAccentHex[TOOL_FAMILY[tool]];
  // Unsaved-changes segment (Stage 15.6): same "read the ref at render time, driven by the
  // reactive editEpoch dependency" idiom `isDirty()` uses imperatively elsewhere — this only needs
  // to re-evaluate when editEpoch itself changes, which already re-renders App.
  const dirty = editEpoch !== savedEpochRef.current;

  const statusBarEl = world ? (
    <div data-tour="status-bar" style={{
      position: "fixed", bottom: 0, left: 0, right: 0, height: STATUS_BAR_HEIGHT, zIndex: 150,
      background: TOPBAR_BG,
      borderTop: `1px solid ${HAIRLINE}`,
      boxShadow: "inset 0 1px 0 rgba(255,255,255,.05)",
      display: "flex", alignItems: "center", overflow: "hidden",
      fontSize: 10, color: TEXT_LABEL, userSelect: "none",
      fontVariantNumeric: "tabular-nums",
    }}>
      {/* Tool chip — coloured by the armed tool's family hue (teal draw/generic, warm sculpt, blue
          selection, green clipboard), matching the ribbon's own family accents. */}
      <StatusSeg icon={TOOL_ICON[tool]} iconColor={toolAccent} color={toolAccent} style={{ minWidth: 0, flexShrink: 0 }}>
        {tool === "brush" ? `Brush ${brushSize}px`
          : tool === "paste" && pasteMode !== "normal" ? `Paste (${pasteMode})`
          : TOOL_LABELS[tool]}
      </StatusSeg>
      {/* World name — priority-first in the overflow order (CLAUDE.md §5.11 risk note): every
          segment after this one may shrink or ellipsize at 900px, this one never does. */}
      {/* flexShrink:0 — never yields width; the lowest-priority segments (tool/selection hint
          text, filter/mask chips) are the ones with flexShrink:1 + minWidth:0, so they're what
          gives way first at 900px. The inner span's own ellipsis is the last-resort safety net
          for a pathologically long world name, not the normal overflow path. */}
      <StatusSeg icon="world" color={TEXT_META} style={{ flexShrink: 0, maxWidth: 220 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {world.name}
        </span>
      </StatusSeg>
      <StatusSeg icon="tiled" style={{ flexShrink: 0 }}>
        {chunkToWorld(world.width_chunks)}×{chunkToWorld(world.height_chunks)}
        <span
          title={
            classifyWorldFormat(world) === "legacy64z" ? "Legacy (64z) format: worlds up to 64 blocks tall"
            : classifyWorldFormat(world) === "newDawn256z" ? "New Dawn (256z) format: worlds up to 256 blocks tall"
            : "NewFormat256z: a 256z format from a 2026 game update"
          }
          style={{ color: world.max_z === 255 ? ACCENT.violet : TEXT_META, marginLeft: 6 }}
        >
          {world.max_z === 255 ? "256z" : "64z"}
        </span>
      </StatusSeg>
      {/* Zoom — next to world size (Stage 15.6). Click = Fit, same as ⌘0/view.zoom.fit. */}
      <ZoomStatusSeg mapCanvasRef={mapCanvasRef} />
      {/* Unsaved changes (Stage 15.6): dot + Saved/Edited, plus the last autosave/save time once one
          has happened this session. Click = Save (same path ⌘S uses: Save if there's a source path
          on disk already, Save As otherwise). */}
      <StatusSeg
        color={dirty ? ACCENT.warm : TEXT_META}
        title={dirty ? "Unsaved changes. Click to save." : "All changes saved"}
        onClick={() => { if (sourcePath) saveWorld(sourcePath); else saveWorldAs(); }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
          background: dirty ? ACCENT.warm : TEXT_META,
        }} />
        {dirty ? "Edited" : "Saved"}
        {lastSavedAt !== null && (
          <span style={{ color: TEXT_META }}>
            {new Date(lastSavedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </StatusSeg>
      {/* Cap Z / slice Z (Stage 15.6) — only while cutaway/z-slice is active. Same label ternary and
          accent (ACCENT.primary) as the Cutaway / Z-slice context panel's slider (windows/modePanels.tsx). */}
      {(viewMode === "cutaway" || viewMode === "zslice") && (
        <StatusSeg icon="zslice" iconColor={ACCENT.primary} color={ACCENT.primary}>
          {viewMode === "cutaway" ? "Cap Z" : "Z-Slice Level"}{" "}
          <span style={{ fontWeight: 700 }}>{zSliceZ}</span>
        </StatusSeg>
      )}
      <CursorHud ref={cursorHudRef} />
      <SelStatusHud ref={selStatusHudRef} selection={selection} zMin={zMin} zMax={zMax} />
      {/* Paste Z — only while the paste tool is armed (§5.11): the elevation offset a click will
          stamp at, independent of the "locked/unlocked" hint segment below it. */}
      {tool === "paste" && clipboard && (
        <StatusSeg icon="paste" iconColor={ACCENT.clipboard} color={ACCENT.clipboard}>
          Z <span style={{ color: ACCENT.clipboard, fontWeight: 700 }}>
            {pasteElevationOffset > 0 ? `+${pasteElevationOffset}` : pasteElevationOffset}
          </span>
        </StatusSeg>
      )}
      {tool === "materialize" && materializeSelection && (() => {
        const { cx1, cy1, cx2, cy2 } = materializeSelection;
        const nChunks = (cx2 - cx1 + 1) * (cy2 - cy1 + 1);
        return (
          <StatusSeg icon="materialize" iconColor={ACCENT.warm} color={ACCENT.warm}>
            {nChunks.toLocaleString()} chunk{nChunks === 1 ? "" : "s"} selected
          </StatusSeg>
        );
      })()}
      <StatusSeg icon="history">
        ↩ <span style={{ color: TEXT_META }}>{undoDepth}</span>
        {"  "}↪ <span style={{ color: TEXT_META }}>{redoDepth}</span>
      </StatusSeg>
      {/* The filter's only other Clear button lives in the Selection tab, which disappears with the
          selection — deselect and the filter (which still gates deletes) became unclearable. */}
      {filterBlockType !== null && (
        <StatusSeg icon="filter" iconColor={ACCENT.warm}
          style={{ padding: "0 4px 0 8px", gap: 4, minWidth: 0, flexShrink: 1,
            color: ACCENT.warm, background: `rgba(${hexToRgbTriplet(ACCENT.warm)},0.10)` }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            Filter: {blockDisplayName(filterBlockType)}{filterPaint !== null ? ` #${filterPaint}` : ""}{filterInvert ? " (inv)" : ""}
          </span>
          <button
            onClick={() => { setFilterBlockType(null); setFilterPaint(null); setFilterInvert(false); }}
            title="Clear the replace filter"
            aria-label="Clear replace filter"
            style={{ background: "none", border: "none", cursor: "pointer", color: ACCENT.warm,
              minWidth: 18, minHeight: 18, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, lineHeight: 1, opacity: 0.75 }}
            onMouseEnter={e => { e.currentTarget.style.opacity = "1"; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = "0.75"; }}
          >✕</button>
        </StatusSeg>
      )}
      {maskEnabled && maskBlockType !== null && (
        <StatusSeg color={ACCENT.violet} style={{ padding: "0 8px", minWidth: 0, flexShrink: 1, background: `rgba(${hexToRgbTriplet(ACCENT.violet)},0.10)` }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            Mask: {blockDisplayName(maskBlockType)}{maskPaint !== null ? ` #${maskPaint}` : ""}
          </span>
        </StatusSeg>
      )}
      {/* Two-click paste is otherwise signalled only by the ghost turning green → amber, which is
          easy to miss — this is the "why did nothing paste?" moment. */}
      {tool === "paste" && (
        <StatusSeg style={{ padding: "0 8px", minWidth: 0, flexShrink: 1,
          color: lockedPastePos ? ACCENT.warm : ACCENT.clipboard,
          background: `rgba(${hexToRgbTriplet(lockedPastePos ? ACCENT.warm : ACCENT.clipboard)},0.10)` }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            {lockedPastePos
              ? "Position locked. Click again to place, Esc to unlock."
              : "Click the map to lock the paste position"}
          </span>
        </StatusSeg>
      )}
      {/* Same idea, extended to the other gestures with no on-screen affordance: the polygon's
          close-the-loop click, Grab's vertical drag, and the fact that a selection can be dragged
          and resized at all. These two hints are the lowest-priority segments in the bar — the
          first to shrink away at 900px (§5.11's overflow risk note: "world name first"). */}
      {tool !== "paste" && TOOL_HINTS[tool] && (
        <StatusSeg color={TEXT_DIM} style={{ padding: "0 8px", minWidth: 0, flexShrink: 1 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{TOOL_HINTS[tool]}</span>
        </StatusSeg>
      )}
      {tool === "select" && rawBounds && (
        <StatusSeg color={TEXT_DIM} style={{ padding: "0 8px", minWidth: 0, flexShrink: 1 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            Drag an edge grip to resize · drag inside to move {moveWithContents ? "the blocks" : "the box only"} · arrows nudge
          </span>
        </StatusSeg>
      )}
      {/* Z + block-name (Stage 15.6) — split off CursorHud's X/Y segment above so the block name's
          width doesn't shift anything to its left. Last left-aligned segment before the spacer. */}
      <CursorZHud ref={cursorZHudRef} />
      {/* Active block swatch (Stage 15.6) — the hotbar's current fill/draw slot; click opens the
          same picker Home's Block button does. */}
      <ActiveBlockStatusSeg fillBlockType={fillBlockType} fillPaint={fillPaint} texturePack={texturePackInfo} />
      <div style={{ flex: 1, minWidth: 0 }} />
      <StatusSeg icon="fps" iconColor={ACCENT.primary} color={ACCENT.primary}
        divider={false} style={{ borderLeft: `1px solid ${HAIRLINE}`, opacity: 0.6, flexShrink: 0 }}>
        <FpsCounter />
      </StatusSeg>
    </div>
  ) : null;

  if (world) {
    return (
      <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      {/* App-level picker host (Stage 14.5) — wraps Ribbon (which forwards it into its own
          context) and the floating-window layer (the Hotbar window's ▣ slot), so both can open the
          same shared block/paint picker portal. */}
      <PickerProvider
        world={world}
        texturePack={texturePackInfo}
        rawBounds={rawBounds}
        fillBlockType={fillBlockType} fillPaint={fillPaint}
        setFillBlockType={setFillBlockType} setFillPaint={setFillPaint}
        fillSelection={fillSelection}
        gradientToBlock={gradientToBlock} gradientToPaint={gradientToPaint}
        setGradientToBlock={setGradientToBlock} setGradientToPaint={setGradientToPaint}
        applyGradientFill={applyGradientFill}
        filterBlockType={filterBlockType} filterPaint={filterPaint}
        setFilterBlockType={setFilterBlockType} setFilterPaint={setFilterPaint}
      >
        {/* ── Work area (UI redesign r3, Stage 14.4) ─────────────────────────────
            The box between the ribbon (+ Quick Actions bar) and the status bar, left of the docked
            sidebar. It holds the main viewport plus the floating window layer on top. The map no longer draws under the ribbon and status bar, so "Fit"
            fits the part of the map you can actually see. */}
        <div data-work-area="" style={{
          position: "absolute", top: effectiveRibbonHeight + QUICK_ACTIONS_BAR_H,
          left: 0, right: sidebarInsetPx, bottom: STATUS_BAR_HEIGHT,
        }}>
          {/* The main pane shows the map, or the 3D view when swapped (⇄ / Tab). */}
          <div data-tour="map" style={{ position: "absolute", inset: 0 }}>
            <OutPortal node={placement.main === "fly" ? flyHost : mapHost} />
          </div>
          <WindowLayer>
            <ToolsWindow tool={tool} setTool={setTool} />
            <HotbarWindow
              hotbar={hotbar}
              fillBlockType={fillBlockType}
              fillPaint={fillPaint}
              setFillBlockType={setFillBlockType}
              setFillPaint={setFillPaint}
              texturePack={texturePackInfo}
            />
            <LensWindow
              tool={tool}
              clipboard={clipboard}
              pasteMode={pasteMode}
              pasteTerrain={pasteTerrain}
              pasteIgnoreAir={pasteIgnoreAir}
              pasteTerrainAbove={pasteTerrainAbove}
              pasteElevationOffset={pasteElevationOffset}
              setPasteElevationOffset={setPasteElevationOffset}
              editEpoch={editEpoch}
              mapCanvasRef={mapCanvasRef}
              mapVisible={placement.main !== "fly"}
              worldLoaded={world != null}
              onExit={onToggleLensWindow}
              selection={selection}
              zMin={zMin}
              zMax={zMax}
              onZRangeChange={onLensZRange}
              selectionMask={selectionMaskOverlay}
              extrude={extrudeOpen && extrudeCount > 0 ? { axis: extrudeAxis, count: extrudeCount } : null}
              drawActive={["pen", "brush", "rect", "ellipse"].includes(tool)}
              onDrawElevation={handleDrawElevation}
              maxZ={world.max_z}
            />
            {/* Mode-driven context panels (16.6) — in registry (= stacking) order. Each exists only while
                its mode holds; see windows/panelModes.ts and modePanels.tsx. */}
            <CutawayPanel
              worldLoaded={world != null} maxZ={world.max_z}
              viewMode={viewMode} setViewMode={setViewMode}
              zSliceZ={zSliceZ} commitZSlice={commitZSlice}
              followSurface={followSurface} setFollowSurface={setFollowSurface}
            />
            <BrushShapePanel
              worldLoaded={world != null} tool={tool}
              noiseMode={noiseMode} setNoiseMode={setNoiseMode}
              noiseFeatureSize={noiseFeatureSize} setNoiseFeatureSize={setNoiseFeatureSize}
              slopeGradeX={slopeGradeX} setSlopeGradeX={setSlopeGradeX}
              slopeGradeY={slopeGradeY} setSlopeGradeY={setSlopeGradeY}
              rockNoisiness={rockNoisiness} setRockNoisiness={setRockNoisiness}
              rockNoiseRadius={rockNoiseRadius} setRockNoiseRadius={setRockNoiseRadius}
              rockSmoothing={rockSmoothing} setRockSmoothing={setRockSmoothing}
              rockMeld={rockMeld} setRockMeld={setRockMeld}
              rockFlatten={rockFlatten} setRockFlatten={setRockFlatten}
              rockSink={rockSink} setRockSink={setRockSink}
              rockDrape={rockDrape} setRockDrape={setRockDrape}
              rockStrata={rockStrata} setRockStrata={setRockStrata}
            />
            <BuildSlotPanel
              worldLoaded={world != null} pane3dLive={pane3dLive}
              mode3d={mode3d} setMode3d={setMode3d}
              tool={tool} setTool={setTool}
              floodFillLimit={floodFillLimit}
              setFloodFillLimit={(v) => { setFloodFillLimit(v); saveSettingsDebounced({ floodFillLimit: v }); }}
              sculptStrength={sculptStrength} setSculptStrength={setSculptStrength}
              sculptRadius={sculptRadius} setSculptRadius={setSculptRadius}
              sculptSoftness={sculptSoftness} setSculptSoftness={setSculptSoftness}
            />
            <View3DWindow
              swapped={swapped}
              node={placement.window === "fly" ? flyHost : placement.window === "map" ? mapHost : null}
              onSwap={swapViews}
              onMoved={() => mapCanvasRef.current?.invalidateRect()}
            />
          </WindowLayer>
        </div>
        {/* The two viewports, rendered exactly once each into their detached host nodes. */}
        <InPortal node={mapHost}>{mapPaneEl}</InPortal>
        {/* FlyView3D is mounted from the first time the 3D view is live and never unmounted again
            (Stage 4 of the 3D-pane crash fix): when it has nowhere to be shown its host is simply
            detached and it's `suspended`. Creating and destroying a WebGL context on every toggle
            walks WKWebView toward its live-context ceiling; a suspended pane costs a bare context. */}
        {mounted3d && (
          <InPortal node={flyHost}>
            <ErrorBoundary label="3D view">
            <FlyView3D
              ref={flyView3dRef}
              world={world}
              // Spawn the camera over real geometry: prefer the world's home/spawn point,
              // else the centroid of populated chunks (robust for sparse worlds whose
              // bounding-box centre is empty). Both are local block coords.
              spawnAt={
                spawnPos ? { x: spawnPos.px, y: spawnPos.py }
                  : (world.center_px != null && world.center_py != null
                    ? { x: world.center_px, y: world.center_py } : undefined)
              }
              worldLoadToken={worldEpoch}
              geometryBudgetBytes={MEMORY_PRESETS[memoryBudget].geometryBudgetBytes}
              // Non-fatal warnings (WebGL context lost/restored) — a toast, not the
              // ErrorBoundary: the pane recovers on its own from both.
              onNotice={showToast}
              onSoftwareRenderingDetected={handleSoftwareRenderingDetected}
              // Cache-invalidation key only — the cap itself is backend state and
              // `get_chunk_geometry` folds it into the streamed z band (Cutaway phase 2).
              viewCapZ={viewCapZ}
              suspended={!pane3dLive}
              anyModalOpen={anyModalOpen}
              editEpoch={editEpoch}
              lastEdit={lastEditBounds}
              onFlyModeChange={(a) => { flyActiveRef.current = a; }}
              onLookChange={setLooking3d}
              onCameraMove={(wx, wy, yaw, hfov) => {
                cam3dPosRef.current = { x: wx, y: wy };
                mapCanvasRef.current?.setCameraDot(wx, wy, yaw, hfov);
                if (!hasCam3dPos) setHasCam3dPos(true);
              }}
              overlays3d={overlays3d}
              texturePack={texturePackInfo}
              texEpoch={texEpoch}
              fogEnabled={fogEnabled}
              nightLighting={nightLighting}
              shadows3d={shadows3d}
              sunT={sunT}
              lampRadius={lampRadius}
              lightingProfile={lightingProfile}
              gpuShadows={gpuShadows}
              lightEpoch={lightEpoch}
              initialRenderDistance={renderDistance}
              initialFlySpeed={flySpeed}
              onRenderDistanceChange={(n) => { setRenderDistance(n); saveSettingsDebounced({ renderDistance: n }); }}
              onFlySpeedChange={(n) => { setFlySpeed(n); saveSettingsDebounced({ flySpeed: n }); }}
              lookSensitivity={lookSensitivity}
              dragSensitivity={dragSensitivity}
              invertY={invertY}
              interact3d={interact3d}
              onSetInteract3d={(m) => setMode3d(m === "none" ? "off" : m)}
              onPickSelect={handlePick3dSelect}
              onPickFloodFill={handlePick3dFloodFill}
              onPickBreak={handlePick3dBreak}
              onPickPlace={handlePick3dPlace}
              onBuildGestureEnd={handleBuildGestureEnd}
              onPickEyedrop={handlePick3dEyedrop}
              onPickBreakBatch={handlePick3dBreakBatch}
              onPickPlaceBatch={handlePick3dPlaceBatch}
              onPickFillFace={handlePick3dFillFace}
              selectionBounds3d={selection3d}
              onGizmoRegionChange={handleGizmoRegionChange}
              onGizmoMoveBlocks={handleGizmoMoveBlocks}
              moveWithContents={moveWithContents}
              setMoveWithContents={setMoveWithContents}
              sculptTool={tool}
              sculptRadius={sculptRadius}
              sculptStrength={sculptStrength}
              onSculptStamp3d={handleSculptStamp3d}
              armedSwatch={texturePackInfo ? tintedSwatch(fillBlockType, fillPaint, texturePackInfo) : null}
              armedLabel={blockDisplayName(fillBlockType)}
              armedBlockType={fillBlockType}
              autoOrient3d={autoOrient3d}
              onSetAutoOrient3d={(v) => { setAutoOrient3d(v); saveSettingsDebounced({ autoOrient3d: v }); }}
              sky3d={sky3d}
              onSky3dChange={changeSky3d}
              showHud={show3dHud}
              showGrid={show3dGrid}
              onSetShowGrid={commitShow3dGrid}
              buildReach={buildReach}
              hotbarSlots={hotbar3dSlots}
              showHotbarOverlay={showHotbarOverlay}
              activeBlock={{ type: fillBlockType, paint: fillPaint }}
              showPerfHud={showPerfHud}
              onHotbarSelect={(type, paint) => { setFillBlockType(type); setFillPaint(paint); }}
            />
            </ErrorBoundary>
          </InPortal>
        )}


        {/* A crash anywhere in the ribbon (incl. the portal-mounted block picker, which still
            unwinds through this boundary since a portal stays in the React ownership tree) used
            to vanish into `fallback={() => null}` — no message, no Retry, nothing for the user to
            report. This compact one-line fallback fits the ribbon's own fixed height instead of
            the ErrorBoundary's default full-pane box, and actually surfaces what broke. */}
        <ErrorBoundary label="Ribbon" fallback={(error, retry) => (
          <div style={{
            height: "100%", display: "flex", alignItems: "center", gap: 10, padding: "0 14px",
            background: RAMP.chrome, color: RAMP.dim, fontSize: 12, overflow: "hidden",
          }}>
            <span style={{ color: RAMP.textDanger, fontWeight: 600, flexShrink: 0 }}>Ribbon failed to render</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: RAMP.meta }}>
              {error.message || String(error)}
            </span>
            <button type="button" className="rbn-btn" onClick={retry}
              style={{ ...btnBaseInline, marginLeft: "auto", flexShrink: 0, padding: "0 10px", height: 24 }}>Retry</button>
          </div>
        )}>
        <Ribbon
          world={world}
          appVersion={appVersion}
          renamingWorld={renamingWorld}
          renameInput={renameInput}
          renameInputRef={renameInputRef}
          setRenamingWorld={setRenamingWorld}
          setRenameInput={setRenameInput}
          onRenameBlur={onRenameBlur}
          tool={tool}
          setTool={setTool}
          isDrawTool={isDrawTool}
          isSculptTool={isSculptTool}
          wandMatchPaint={wandMatchPaint}
          setWandMatchPaint={setWandMatchPaint}
          materializeSelection={materializeSelection}
          onOpenMaterializeModal={() => setShowMaterializeModal(true)}
          undoDepth={undoDepth}
          redoDepth={redoDepth}
          handleUndo={handleUndo}
          handleRedo={handleRedo}
          brushSize={brushSize}
          setBrushSize={setBrushSize}
          brushShape={brushShape}
          setBrushShape={setBrushShape}
          drawFilled={drawFilled}
          setDrawFilled={setDrawFilled}
          drawAbove={drawAbove}
          setDrawAbove={setDrawAbove}
          sprayDensity={sprayDensity}
          setSprayDensity={setSprayDensity}
          strokeStabilizer={strokeStabilizer}
          setStrokeStabilizer={setStrokeStabilizer}
          sculptStrength={sculptStrength}
          setSculptStrength={setSculptStrength}
          sculptRadius={sculptRadius}
          setSculptRadius={setSculptRadius}
          sculptSoftness={sculptSoftness}
          setSculptSoftness={setSculptSoftness}
          sculptProfile={sculptProfile}
          setSculptProfile={setSculptProfile}
          sculptAccumulate={sculptAccumulate}
          setSculptAccumulate={setSculptAccumulate}
          sculptClipToSelection={sculptClipToSelection}
          setSculptClipToSelection={setSculptClipToSelection}
          noiseMode={noiseMode}
          setNoiseMode={setNoiseMode}
          noiseFeatureSize={noiseFeatureSize}
          setNoiseFeatureSize={setNoiseFeatureSize}
          slopeGradeX={slopeGradeX}
          setSlopeGradeX={setSlopeGradeX}
          slopeGradeY={slopeGradeY}
          setSlopeGradeY={setSlopeGradeY}
          rockNoisiness={rockNoisiness}
          setRockNoisiness={setRockNoisiness}
          rockNoiseRadius={rockNoiseRadius}
          setRockNoiseRadius={setRockNoiseRadius}
          rockSmoothing={rockSmoothing}
          setRockSmoothing={setRockSmoothing}
          rockMeld={rockMeld}
          setRockMeld={setRockMeld}
          rockFlatten={rockFlatten}
          setRockFlatten={setRockFlatten}
          rockSink={rockSink}
          setRockSink={setRockSink}
          rockDrape={rockDrape}
          setRockDrape={setRockDrape}
          rockStrata={rockStrata}
          setRockStrata={setRockStrata}
          prevToolRef={prevToolRef}
          fillBlockType={fillBlockType}
          fillPaint={fillPaint}
          setFillBlockType={setFillBlockType}
          setFillPaint={setFillPaint}
          maskEnabled={maskEnabled}
          setMaskEnabled={setMaskEnabled}
          maskBlockType={maskBlockType}
          setMaskBlockType={setMaskBlockType}
          maskPaint={maskPaint}
          setMaskPaint={setMaskPaint}
          zMin={zMin}
          zMax={zMax}
          handleZMin={handleZMin}
          handleZMax={handleZMax}
          viewMode={viewMode}
          setViewMode={setViewMode}
          zSliceZ={zSliceZ}
          commitZSlice={commitZSlice}
          followSurface={followSurface}
          setFollowSurface={setFollowSurface}
          reliefShading={reliefShading}
          setReliefShading={setReliefShading}
          pane3dLive={pane3dLive}
          swapped={swapped}
          onSwapViews={swapViews}
          view3dWindowOpen={layoutInputs.view3dOpen}
          onToggle3dWindow={() => toggleWin("view3d")}
          toolsWindowOpen={winKey[3] === "1"}
          onToggleToolsWindow={() => toggleWin("tools")}
          hotbarWindowOpen={winKey[4] === "1"}
          onToggleHotbarWindow={() => toggleWin("hotbar")}
          lensWindowOpen={lensWindowArmed}
          onToggleLensWindow={onToggleLensWindow}
          onResetWindows={resetWindows}
          mode3d={mode3d}
          setMode3d={setMode3d}
          autoOrient3d={autoOrient3d}
          setAutoOrient3d={(v) => { setAutoOrient3d(v); saveSettingsDebounced({ autoOrient3d: v }); }}
          show3dHud={show3dHud} setShow3dHud={commitShow3dHud}
          show3dGrid={show3dGrid} setShow3dGrid={commitShow3dGrid}
          floodFillLimit={floodFillLimit}
          setFloodFillLimit={(v) => { setFloodFillLimit(v); saveSettingsDebounced({ floodFillLimit: v }); }}
          nightLighting={nightLighting}
          setNightLighting={setNightLighting}
          shadows3d={shadows3d}
          setShadows3d={setShadows3d}
          gpuShadows={gpuShadows}
          setGpuShadows={setGpuShadows}
          sunT={sunT}
          commitSunT={commitSunT}
          lampRadius={lampRadius}
          commitLampRadius={commitLampRadius}
          lightingProfile={lightingProfile}
          commitLightingProfile={commitLightingProfile}
          onFitMap={() => mapCanvasRef.current?.resetView()}
          // View ▸ Zoom. All three already existed on MapCanvas's ref but were keyboard-only.
          onZoomToSelection={() => { const rb = rawBoundsRef.current; if (rb) mapCanvasRef.current?.zoomToBox(rb.x1, rb.y1, rb.x2, rb.y2); }}
          onZoomIn={() => mapCanvasRef.current?.zoomBy(KEY_ZOOM_STEP)}
          onZoomOut={() => mapCanvasRef.current?.zoomBy(1 / KEY_ZOOM_STEP)}
          // View ▸ Layout. Persisted state that used to be reachable only through Settings.
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => { setSidebarOpen(v => { saveSettings({ sidebarOpen: !v }); return !v; }); }}
          // 3D ▸ Camera. Display/commit split: the tab holds the drag value, App gets the commit.
          flySpeed={flySpeed}
          commitFlySpeed={(n) => { setFlySpeed(n); saveSettingsDebounced({ flySpeed: n }); }}
          renderDistance={renderDistance}
          commitRenderDistance={(n) => { setRenderDistance(n); saveSettingsDebounced({ renderDistance: n }); }}
          templateLoaded={templateLoaded}
          templatePath={templatePath}
          showTemplateOverlay={showTemplateOverlay}
          setShowTemplateOverlay={setShowTemplateOverlay}
          showSigns={showSigns}
          setShowSigns={setShowSigns}
          hasSigns={signs.length > 0}
          openTemplateFile={openTemplateFile}
          texturePackLoaded={texturePackInfo !== null}
          texturePackPath={texturePackPath}
          texturePack={texturePackInfo}
          openTexturePackFile={openTexturePackFile}
          unloadTexturePack={unloadTexturePack}
          spawnPos={spawnPos}
          playerPos={playerPos}
          onSetSpawnAtSelection={setSpawnAtSelection}
          onSetPlayerPosAtSelection={setPlayerPosAtSelection}
          onShowWorldInfo={() => setShowWorldInfo(true)}
          selection={selection}
          rawBounds={rawBounds}
          setRawBounds={setRawBounds}
          copySelection={copySelection}
          cutSelection={cutSelection}
          deleteBlocks={deleteBlocks}
          fillSelection={fillSelection}
          onSelectAll={() => world && setRawBounds({ x1: 0, y1: 0, x2: chunkToWorld(world.width_chunks) - 1, y2: chunkToWorld(world.height_chunks) - 1 })}
          gradientToBlock={gradientToBlock}
          setGradientToBlock={setGradientToBlock}
          gradientToPaint={gradientToPaint}
          setGradientToPaint={setGradientToPaint}
          gradientAxis={gradientAxis}
          setGradientAxis={setGradientAxis}
          gradientIncludeAir={gradientIncludeAir}
          setGradientIncludeAir={setGradientIncludeAir}
          applyGradientFill={applyGradientFill}
          filterBlockType={filterBlockType}
          filterPaint={filterPaint}
          filterInvert={filterInvert}
          setFilterBlockType={setFilterBlockType}
          setFilterPaint={setFilterPaint}
          setFilterInvert={setFilterInvert}
          clipboard={clipboard}
          clipboardPreview={clipboardPreviewPixels}
          pasteElevationOffset={pasteElevationOffset}
          setPasteElevationOffset={setPasteElevationOffset}
          pasteIgnoreAir={pasteIgnoreAir}
          setPasteIgnoreAir={setPasteIgnoreAir}
          pasteTerrain={pasteTerrain}
          setPasteTerrain={setPasteTerrain}
          pasteTerrainAbove={pasteTerrainAbove}
          setPasteTerrainAbove={setPasteTerrainAbove}
          persistPaste={persistPaste}
          setPersistPaste={setPersistPaste}
          lockedPastePos={lockedPastePos}
          setLockedPastePos={setLockedPastePos}
          pasteMode={pasteMode}
          setPasteMode={setPasteMode}
          scatterCount={scatterCount}
          setScatterCount={setScatterCount}
          arrayCols={arrayCols}
          setArrayCols={setArrayCols}
          arrayRows={arrayRows}
          setArrayRows={setArrayRows}
          arraySpacingX={arraySpacingX}
          setArraySpacingX={setArraySpacingX}
          arraySpacingY={arraySpacingY}
          setArraySpacingY={setArraySpacingY}
          rotateClipboard={rotateClipboard}
          mirrorClipboardX={mirrorClipboardX}
          mirrorClipboardY={mirrorClipboardY}
          pasteAt={pasteAt}
          sourcePath={sourcePath}
          saving={saving}
          longOpKind={longOp?.kind ?? null}
          saveCompressed={saveCompressed}
          setSaveCompressed={setSaveCompressed}
          backupCompressed={backupCompressed}
          setBackupCompressed={(v) => { setBackupCompressed(v); saveSettings({ backupCompressed: v }); }}
          recentWorlds={recentWorlds}
          openFile={openFile}
          openFileAt={openFileAt}
          saveWorld={saveWorld}
          saveWorldAs={saveWorldAs}
          exportPng={exportPng}
          loadPrefab={loadPrefab}
          showPrefabLibrary={sidebarOpen && sidebarTab === "prefabs"}
          onTogglePrefabLibrary={() => {
            if (sidebarOpen && sidebarTab === "prefabs") {
              setSidebarOpen(false);
              saveSettings({ sidebarOpen: false });
            } else {
              setSidebarOpen(true);
              setSidebarTab("prefabs");
              saveSettings({ sidebarOpen: true, sidebarTab: "prefabs" });
            }
          }}
          moveWithContents={moveWithContents}
          setMoveWithContents={setMoveWithContents}
          onNudgeSelection={nudgeSelection}
          setShowNewWorld={setShowNewWorld}
          setShowWorldBrowser={setShowWorldBrowser}
          setShowUploadModal={requestShowUploadModal}
          setShowExpandModal={setShowExpandModal}
          setExpandResult={setExpandResult}
          closeWorld={closeWorld}
          setShowHelp={setShowHelp}
          setShowAbout={setShowAbout}
          setShowSettings={setShowSettings}
          openSettingsTab={openSettingsTab}
          onNotice={showToast}
          setShowDiagnostics={setShowDiagnostics}
          startTour={startTour}
          onSavePrefab={openPrefabNameModal}
          onSavePrefabAs={savePrefabAs}
          extrudeCount={extrudeCount}
          setExtrudeCount={setExtrudeCount}
          extrudeAxis={extrudeAxis}
          setExtrudeAxis={setExtrudeAxis}
          extrudeOpen={extrudeOpen}
          setExtrudeOpen={setExtrudeOpen}
          onExtrude={handleExtrude}
          treeTypes={treeTypes}
          setTreeTypes={setTreeTypes}
          treeDensity={treeDensity}
          setTreeDensity={setTreeDensity}
          leafPaints={leafPaints}
          setLeafPaints={setLeafPaints}
          smartPlacement={smartPlacement}
          setSmartPlacement={setSmartPlacement}
          onGenerateTrees={handleGenerateTrees}
          fluidBase={fluidBase}
          setFluidBase={setFluidBase}
          fluidIncludeExisting={fluidIncludeExisting}
          setFluidIncludeExisting={setFluidIncludeExisting}
          onSimulateFlow={handleSimulateFlow}
          poolFillTargetZ={poolFillTargetZ}
          setPoolFillTargetZ={setPoolFillTargetZ}
          wavyWavelength={wavyWavelength}
          setWavyWavelength={setWavyWavelength}
          wavyAmplitude={wavyAmplitude}
          setWavyAmplitude={setWavyAmplitude}
          wavyMode={wavyMode}
          setWavyMode={setWavyMode}
          onGenerateWavySurface={handleGenerateWavySurface}
          collapsed={ribbonCollapsed}
          registerTabSetter={registerRibbonTabSetter}
          onCollapse={(v) => { setRibbonCollapsed(v); try { localStorage.setItem("ribbon_collapsed", String(v)); } catch {} }}
          compact={ribbonCompact}
          onToggleCompact={(v) => { setRibbonCompact(v); saveSettings({ ribbonCompact: v }); }}
        />
        </ErrorBoundary>


        {/* Docked right sidebar: Inspector / Prefabs / History tabs — see Sidebar.tsx. */}
        <Sidebar
          open={sidebarOpen}
          onOpenChange={(v) => { setSidebarOpen(v); saveSettings({ sidebarOpen: v }); }}
          width={sidebarWidth}
          onWidthChange={(w) => { setSidebarWidth(w); saveSettingsDebounced({ sidebarWidth: w }); }}
          tab={sidebarTab}
          onTabChange={(t) => { if (t !== sidebarTab) sfx.play("tab"); setSidebarTab(t); saveSettings({ sidebarTab: t }); }}
          topPx={effectiveRibbonHeight}
          bottomPx={STATUS_BAR_HEIGHT}
          selection={selection}
          clipboard={clipboard}
          clipboardPreview={clipboardPreviewPixels}
          onArmPaste={(info) => { setClipboard(info); setTool("paste"); }}
          onSavePrefabAs={savePrefabAs}
          prefabRefreshToken={prefabRefreshToken}
          editEpoch={editEpoch}
          worldEpoch={worldEpoch}
          signs={signs}
          onSignClick={focusOnSign}
        />

        {prefabNameModal && (
          <Dialog
            size="sm"
            icon="savePrefab"
            title="Save Prefab"
            onClose={() => setPrefabNameModal(false)}
            busy={prefabSaving}
            footer={
              <>
                <DialogButton
                  onClick={() => { setPrefabNameModal(false); savePrefabAs(); }}
                  style={{ marginRight: "auto" }}
                >
                  Save As…
                </DialogButton>
                <DialogButton onClick={() => setPrefabNameModal(false)}>Cancel</DialogButton>
                <DialogButton
                  variant="primary"
                  onClick={confirmSavePrefab}
                  disabled={!prefabNameInput.trim() || prefabSaving}
                >
                  {prefabSaving ? "Saving…" : prefabOverwrite ? "Overwrite" : "Save"}
                </DialogButton>
              </>
            }
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: MODAL_TEXT.secondary }}>
              Name
              <input
                autoFocus
                value={prefabNameInput}
                onChange={(e) => { setPrefabNameInput(e.target.value); setPrefabOverwrite(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") confirmSavePrefab(); }}
                style={{
                  ...recessedWell, background: v("surface-modalRaised"), borderRadius: 6,
                  color: MODAL_TEXT.primary, padding: "7px 9px", fontSize: 13, outline: "none",
                }}
              />
            </label>
            {prefabOverwrite ? (
              <div style={{ fontSize: 11, color: armedRecipe(ACCENTS.warm).text, marginTop: 10 }}>
                A prefab with this name already exists. Click Overwrite to replace it.
              </div>
            ) : (
              <div style={{ fontSize: 11, color: MODAL_TEXT.label, marginTop: 10 }}>
                Saves to your prefab library and appears in the gallery.
              </div>
            )}
          </Dialog>
        )}

        {(longOp || loading) && (
          <LongOpOverlay op={longOp} onCancel={cancelLongOp} />
        )}

        {showHelp && <HelpModal onClose={() => setShowHelp(false)} onStartTour={startTour} />}
        {showDiagnostics && (
          <DiagnosticsModal
            onClose={() => setShowDiagnostics(false)}
            appVersion={appVersion}
            sourcePath={sourcePath}
            world={world}
            templatePath={templatePath}
            texturePackPath={texturePackPath}
            prefabDirectory={loadSettings().prefabDirectory}
            showPerfHud={showPerfHud}
            memoryBudget={memoryBudget}
            viewHost={swapped ? "main" : "window"}
            getGpuInfo={() => flyView3dRef.current?.getGpuInfo() ?? null}
            getPerfSnapshot={() => flyView3dRef.current?.getPerfSnapshot() ?? null}
          />
        )}
        {tourOpen && (
          <TourOverlay steps={TOUR_STEPS} ctx={tourCtx} onClose={() => setTourOpen(false)} />
        )}
        {showAbout && (
          <AboutModal version={appVersion} onClose={() => setShowAbout(false)}
            onOpenDiagnostics={() => { setShowAbout(false); setShowDiagnostics(true); }} />
        )}
        {showWorldInfo && <WorldInfoModal onClose={() => setShowWorldInfo(false)} />}
        {recoveryInfo && (
          <RecoveryModal info={recoveryInfo} recovering={recovering} onRecover={recoverAutosave} onDiscard={discardRecovery} onDismiss={dismissRecovery} onOpenBase={openRecoveryBase} />
        )}
        {showSettings && (
          <SettingsModal
            onClose={() => { setShowSettings(false); setSettingsTab("general"); }}
            onSave={applySettings}
            onResetWindows={resetWindows}
            lensFlags={{ pasteOn: winKey[6] === "1", selOn: winKey[7] === "1" }}
            onLensFlags={setLensFlags}
            initialTab={settingsTab}
          />
        )}

        {showWorldBrowser && (
          <WorldBrowserModal
            onClose={() => setShowWorldBrowser(false)}
            onOpenWorld={(path) => { setShowWorldBrowser(false); openFileAt(path); }}
          />
        )}
        {showUploadModal && (
          <UploadModal
            sourcePath={sourcePath}
            onClose={() => setShowUploadModal(false)}
          />
        )}
        {showNewWorld && (
          <NewWorldModal
            onClose={() => setShowNewWorld(false)}
            onCreated={(path) => { setShowNewWorld(false); openFileAt(path, { fresh: true }); }}
          />
        )}
        <ConfirmHost />

        {/* Sky Editor and Creature Viewer panels — implemented, hidden pending testing */}

        {/* Materialize ungenerated chunk space modal */}
        {showMaterializeModal && world && materializeSelection && (
          <MaterializeModal
            world={world}
            bounds={materializeSelection}
            onClose={() => setShowMaterializeModal(false)}
            onMaterialized={async (path) => {
              await swapToWorldFile(path, { skipRecent: true });
              setMaterializeSelection(null);
              setShowMaterializeModal(false);
            }}
          />
        )}

        {/* Expand from Template — on the shared Dialog chrome (it was the last hand-rolled
            pre-r3 dialog: warm-glass literals, blue buttons, native radios). */}
        {showExpandModal && (
          <Dialog
            size="sm" icon="template" title="Expand from Template"
            onClose={() => setShowExpandModal(false)} busy={expandInProgress}
            footer={expandInProgress ? (
              <DialogButton onClick={cancelExpand}>Cancel</DialogButton>
            ) : expandResult !== null ? (
              <DialogButton onClick={() => setShowExpandModal(false)}>Close</DialogButton>
            ) : (<>
              <DialogButton onClick={() => setShowExpandModal(false)}>Cancel</DialogButton>
              <DialogButton variant="primary" onClick={runExpand}>Choose Output File &amp; Expand</DialogButton>
            </>)}
          >
            {!expandInProgress && expandResult === null && (
              <>
                <div style={{ fontSize: 12, color: MODAL_TEXT.secondary, marginBottom: 16, lineHeight: 1.5 }}>
                  Fills missing chunks from Eden.eden into a new file (up to ~1 GB). Your edits are kept.
                </div>
                <Segmented
                  ariaLabel="Expand extent"
                  value={expandFullExtent ? "full" : "bounds"}
                  onChange={v => setExpandFullExtent(v === "full")}
                  options={[
                    { id: "full", label: "Full world", title: "All 180×180 template chunks (~1 GB)" },
                    { id: "bounds", label: "Current bounds", title: "Only fill gaps within the world's current extent" },
                  ]}
                />
                <div style={{ fontSize: 11, color: MODAL_TEXT.label, marginTop: 8 }}>
                  {expandFullExtent ? "180×180 chunks, ~1 GB." : "Only the gaps inside the world's current extent."}
                </div>
              </>
            )}
            {expandInProgress && (
              <>
                <div style={{ fontSize: 12, color: MODAL_TEXT.secondary, marginBottom: 12 }}>
                  Writing chunks… {expandProgress}%
                </div>
                <div style={{ background: RAMP.mbtn1, borderRadius: 4, height: 8, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: ACCENTS.warm, borderRadius: 4, width: `${expandProgress}%`, transition: "width 0.2s" }} />
                </div>
              </>
            )}
            {expandResult !== null && !expandInProgress && (
              <div style={{ fontSize: 13, color: armedRecipe(ACCENTS.clipboard).text }}>
                Done. {expandResult.chunksAdded.toLocaleString()} chunks added
                ({expandResult.totalChunks.toLocaleString()} total).
              </div>
            )}
          </Dialog>
        )}

        {/* Map right-click context menu — a data-driven item list rendered through the generic,
            Popover-backed `ContextMenu` (Stage 14.14); see src/ui/ContextMenu.tsx. Shortcut hints
            are pulled from the command registry where a menu action has a real registered id;
            actions with no registry entry (Paste Here locks a position before arming paste, the
            3D-camera items) just omit the hint rather than inventing one. */}
        {ctxMenu && (() => {
          const items: ContextMenuItem[] = [];
          items.push({
            id: "spawn", label: "Set Home Point Here", icon: "home",
            onClick: () => { invoke<[number,number]>("set_spawn_pos", { px: Math.round(ctxMenu.wx), py: Math.round(ctxMenu.wy) }).then(([px, py]) => { setSpawnPos({ px, py }); setEditEpoch(e => e + 1); }).catch(e => reportError(e)); },
          });
          if (rawBounds) items.push({
            id: "copy", label: "Copy", icon: "copy", separatorBefore: true,
            shortcut: formatChord(COMMAND_META["home.clipboard.copy"].keys[0]),
            onClick: () => copySelection(),
          });
          if (clipboard) items.push({
            id: "pasteHere", label: "Paste Here", icon: "paste",
            onClick: () => { setLockedPastePos({ x: Math.round(ctxMenu.wx), y: Math.round(ctxMenu.wy) }); setTool("paste"); },
          });
          if (rawBounds) items.push({
            id: "fill", label: "Fill Selection", icon: "fill",
            onClick: () => fillSelection(),
          });
          if (rawBounds) items.push({
            id: "delete", label: "Delete Blocks", icon: "delete",
            shortcut: formatChord(COMMAND_META["home.selection.delete"].keys[0]),
            onClick: () => deleteBlocks(),
          });
          if (rawBounds) items.push({
            id: "clear", label: "Clear Selection", icon: "clear",
            shortcut: formatChord(COMMAND_META["home.selection.clear"].keys[0]),
            onClick: () => setRawBounds(null),
          });
          if (pane3dLive) {
            items.push({
              id: "teleport3d", label: "Teleport 3D Camera Here", separatorBefore: true,
              onClick: () => flyView3dRef.current?.teleport(ctxMenu.wx, ctxMenu.wy),
            });
            if (hasCam3dPos) items.push({
              id: "centerOn3d", label: "Centre Map on 3D Camera",
              onClick: () => { const cp = cam3dPosRef.current; if (cp) mapCanvasRef.current?.centerOn(cp.x, cp.y); },
            });
          }
          items.push({
            id: "toolSelect", label: "Select Tool", icon: "select", separatorBefore: true,
            active: tool === "select",
            shortcut: formatChord(COMMAND_META["home.navigation.select"].keys[0]),
            onClick: () => setTool("select"),
          });
          items.push({
            id: "toolPen", label: "Pen Tool", icon: "pen", active: tool === "pen",
            shortcut: formatChord(COMMAND_META["draw.tools.pen"].keys[0]),
            onClick: () => setTool("pen"),
          });
          items.push({
            id: "toolPan", label: "Pan Tool", icon: "pan", active: tool === "pan",
            onClick: () => setTool("pan"),
          });
          return <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={items} onClose={() => setCtxMenu(null)} />;
        })()}

        {/* Quick Actions — docked flush under the ribbon, always mounted with every control visible
            (dimmed when inactive) rather than appearing/disappearing with the selection/clipboard.
            ⚠️ Must stay inside the `world` branch: App has a second return for the splash screen,
            where this would never render. */}
        <QuickActionsBar
          top={effectiveRibbonHeight}
          rightInset={sidebarInsetPx}
          rawBounds={rawBounds}
          clipboard={clipboard}
          onCopy={copySelection}
          onCut={cutSelection}
          onFill={fillSelection}
          onDelete={() => deleteBlocks()}
          onDeselect={() => setRawBounds(null)}
          onPaste={() => setTool("paste")}
          pasteLocked={lockedPastePos != null && !persistPaste}
          onConfirmPaste={() => {
            if (lockedPastePos) { pasteAt(lockedPastePos); setLockedPastePos(null); }
          }}
          pasteElevationOffset={pasteElevationOffset}
          setPasteElevationOffset={setPasteElevationOffset}
          onRotate={rotateClipboard}
          onMirrorX={mirrorClipboardX}
          onMirrorY={mirrorClipboardY}
          onClearPaste={() => {
            setClipboard(null);
            setLockedPastePos(null);
            setPasteElevationOffset(0);
            setTool(t => (t === "paste" ? "pan" : t));
          }}
        />

        <DoneOutline rect={doneRect} mapCanvasRef={mapCanvasRef} />

        {/* Status bar */}
        {statusBarEl}

        {/* Toast stack — sits clear of the status bar (STATUS_BAR_HEIGHT), newest at the bottom. */}
        {toasts.length > 0 && (
          <div style={{
            position: "fixed", bottom: STATUS_BAR_HEIGHT + 10, left: "50%", transform: "translateX(-50%)",
            zIndex: 200, display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
          }}>
            {toasts.map((t) => {
              const isErr = t.kind === "error";
              return (
                <div
                  key={t.id}
                  // Errors are dismissable and hold open while hovered so a long message can be
                  // read; info toasts are pure status blips and stay click-through.
                  onMouseEnter={isErr ? () => {
                    const timer = toastTimersRef.current.get(t.id);
                    if (timer) { clearTimeout(timer); toastTimersRef.current.delete(t.id); }
                  } : undefined}
                  onMouseLeave={isErr ? () => armToastTimer(t.id, ERROR_TOAST_MS) : undefined}
                  style={{
                    padding: "8px 16px", borderRadius: 6,
                    background: isErr
                      ? "linear-gradient(180deg, rgb(58,28,26) 0%, rgb(38,19,17) 100%)"
                      : SURFACE.popover, // slate like every other popover — was the pre-r3 warm glass
                    boxShadow: `inset 0 1px 0 rgba(255,255,255,.06), 0 8px 20px rgba(0,0,0,.4), 0 0 0 1px ${isErr ? "rgba(248,113,113,.45)" : `rgba(${EDEN_TEAL},.25)`}`,
                    color: isErr ? RAMP.textDanger : RAMP.text,
                    fontSize: 12, maxWidth: 460,
                    whiteSpace: isErr ? "normal" : "nowrap",
                    pointerEvents: isErr ? "auto" : "none",
                    display: "flex", alignItems: "flex-start", gap: 8,
                    animation: "eden-toast-in .15s ease-out",
                  }}
                >
                  <span style={{ flex: 1 }}>{t.text}</span>
                  {isErr && (
                    <button
                      onClick={() => dismissToast(t.id)}
                      title="Dismiss"
                      aria-label="Dismiss error"
                      style={{
                        background: "none", border: "none", color: RAMP.textDanger, cursor: "pointer",
                        fontSize: 14, lineHeight: 1, padding: 0, opacity: 0.7,
                        minWidth: 24, minHeight: 24, display: "flex", alignItems: "center", justifyContent: "center",
                        marginTop: -4, marginRight: -6, marginBottom: -4,
                      }}
                    >✕</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </PickerProvider>
      </div>
    );
  }

  const visibleRecent = showAllRecent ? recentWorlds : recentWorlds.slice(0, SPLASH_RECENT_COLLAPSED);

  return (
    <div
      {...(IS_MAC ? { "data-tauri-drag-region": true } : null)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "100vh", minWidth: 0, padding: SPACE.lg * 2, boxSizing: "border-box",
        background: `radial-gradient(700px 260px at 50% 0%, rgba(${hexToRgbTriplet(ACCENT.primary)},.10) 0%, rgba(0,0,0,0) 100%), ${RAMP.bg0}`,
      }}
    >
      <style>{SPLASH_CSS}</style>

      {/* The launcher is a centred, size-capped card rather than a full-bleed screen: at the
          window's 1440×900 default the dense layout would otherwise strand most of its width
          empty. It still shrinks to fit windows smaller than the cap. */}
      <div style={{
        display: "flex", flexDirection: "column", minWidth: 0,
        width: "100%", height: "100%", maxWidth: SPLASH_MAX_W, maxHeight: SPLASH_MAX_H,
        borderRadius: RADIUS.lg, overflow: "hidden", background: SURFACE.body,
        boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}, 0 12px 40px rgba(0,0,0,.45)`,
      }}>

      {/* Title strip — icon + wordmark + version, replacing the old 120px icon / 36px title stack.
          Also the splash's stand-in title bar on macOS (see the outer div's drag region above) —
          marked separately since the outer region only covers its own direct background, not the
          card's children. */}
      <div
        {...(IS_MAC ? { "data-tauri-drag-region": true } : null)}
        style={{
          height: 48, flexShrink: 0, display: "flex", alignItems: "center", gap: SPACE.lg,
          padding: `0 ${SPACE.lg * 2}px`, background: SURFACE.topbar,
          boxShadow: `inset 0 -1px 0 ${BORDER.hairline}`,
        }}
      >
        <img
          src={appIcon}
          alt=""
          style={{
            width: 28, height: 28, borderRadius: RADIUS.lg, imageRendering: "pixelated",
            boxShadow: `inset 0 0 0 1px ${BORDER.bevel}, 0 1px 3px rgba(0,0,0,.5)`,
          }}
        />
        <div style={{ fontSize: 20, letterSpacing: -0.3, lineHeight: 1 }}>
          <span style={{ fontWeight: 800, color: RAMP.white }}>Vuenc</span>
          <span style={{ fontWeight: 400, color: ACCENT.primary }}>Edit</span>
        </div>
        <div style={{ marginLeft: "auto", fontSize: FONT.body, color: TEXT_META }}>v{appVersion}</div>
      </div>

      {updateInfo && !updateDismissed && (
        <div style={{
          flexShrink: 0, display: "flex", alignItems: "center", gap: SPACE.md,
          padding: `${SPACE.sm}px ${SPACE.lg * 2}px`,
          background: `rgba(${hexToRgbTriplet(ACCENT.primary)},.14)`,
          boxShadow: `inset 0 -1px 0 ${BORDER.hairline}`,
          fontSize: FONT.body,
        }}>
          <span style={{ color: TEXT }}>
            VuencEdit {updateInfo.latestVersion} is available (you have {appVersion}).
          </span>
          <SplashLink href={updateInfo.releaseUrl}>View release</SplashLink>
          <button
            className="rb"
            onClick={() => setUpdateDismissed(true)}
            style={{
              marginLeft: "auto", background: "transparent", border: "none", cursor: "pointer",
              color: TEXT_DIM, fontSize: FONT.body, padding: `${SPACE.xs}px ${SPACE.sm}px`,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Left column — commands */}
        <div style={{
          width: SPLASH_NAV_W, flexShrink: 0, display: "flex", flexDirection: "column",
          padding: `${SPACE.lg * 2}px ${SPACE.md}px ${SPACE.lg}px`,
          boxShadow: `inset -1px 0 0 ${BORDER.hairline}`,
        }}>
          <SplashCaption>Create / Open</SplashCaption>

          <SplashCommand icon="new" label="New World" onClick={() => setShowNewWorld(true)} disabled={loading} />
          <SplashCommand icon="open" label={loading ? "Loading…" : "Open World…"} onClick={openFile} disabled={loading} />
          <SplashCommand icon="download" label="Browse Worlds…" onClick={() => setShowWorldBrowser(true)} disabled={loading} />

          <div style={{ height: 1, background: BORDER.hairline, margin: `${SPACE.md}px ${SPACE.lg}px` }} />

          <SplashCommand icon="settings" label="Settings…" onClick={() => setShowSettings(true)} />
          <SplashCommand icon="about" label="About VuencEdit…" onClick={() => setShowAbout(true)} />

          {error && (
            <p style={{
              color: TEXT_DANGER, fontSize: FONT.body, lineHeight: 1.5,
              margin: `${SPACE.lg}px ${SPACE.lg}px 0`,
            }}>
              {error}
            </p>
          )}

          {/* Attribution — credit obligation, kept but condensed to two micro lines. */}
          <div style={{
            margin: `auto ${SPACE.lg}px 0`, paddingTop: SPACE.lg,
            borderTop: `1px solid ${BORDER.hairline}`, fontSize: FONT.label, color: TEXT_META, lineHeight: 1.6,
          }}>
            <p style={{ margin: "0 0 2px" }}>
              Based on{" "}
              <SplashLink href="https://github.com/jldeiro/EdenWorldManipulator2.0">Eden World Manipulator</SplashLink>
              {" "}and{" "}
              <SplashLink href="https://github.com/bLUUBfACE/EdenWorldManipulator">Vuenctools</SplashLink>.
              Docs by{" "}
              <SplashLink href="https://mrob.com/pub/vidgames/eden-file-format.html">Robert Munafo</SplashLink>.
            </p>
            <p style={{ margin: 0 }}>
              Eden World Builder by Ari Ronen (open source 2018). Support:{" "}
              <SplashLink href="https://discord.com/invite/rjYXwBC">Discord</SplashLink>.
            </p>
          </div>
        </div>

        {/* Right column — recent worlds */}
        <div style={{
          flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
          padding: `${SPACE.lg * 2}px ${SPACE.lg * 2}px ${SPACE.lg}px`,
          background: "rgba(0,0,0,.16)",
        }}>
          <SplashCaption>Recent Worlds</SplashCaption>

          {recentWorlds.length === 0 ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: TEXT_META, fontSize: FONT.tab }}>No recent worlds</span>
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: SPACE.xs }}>
              {visibleRecent.map((r) => (
                <button
                  key={r.path}
                  className="spl-recent"
                  aria-disabled={loading || undefined}
                  tabIndex={loading ? -1 : 0}
                  onClick={() => { if (!loading) openFileAt(r.path); }}
                  title={r.path}
                >
                  <Icon name="world" size={ICON.lg} strokeWidth={1.5} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: FONT.tab, fontWeight: 600, color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name}
                    </div>
                    {/* `direction: rtl` ellipsizes the *front* of the path, keeping the filename visible. */}
                    <div style={{ fontSize: FONT.label, color: TEXT_DIM, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" }}>
                      {r.path}
                    </div>
                  </div>
                  <span style={{ fontSize: FONT.label, color: TEXT_META, flexShrink: 0 }}>{timeAgo(r.timestamp)}</span>
                </button>
              ))}

              {recentWorlds.length > SPLASH_RECENT_COLLAPSED && (
                <button
                  className="spl-row"
                  style={{ color: TEXT_DIM, flexShrink: 0 }}
                  onClick={() => setShowAllRecent(v => !v)}
                >
                  <Icon name={showAllRecent ? "collapse" : "expandBar"} size={ICON.sm} />
                  <span>{showAllRecent ? "Less…" : "More…"}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      </div>

      {showAbout && <AboutModal version={appVersion} onClose={() => setShowAbout(false)} />}
      {recoveryInfo && (
        <RecoveryModal info={recoveryInfo} recovering={recovering} onRecover={recoverAutosave} onDiscard={discardRecovery} onDismiss={dismissRecovery} onOpenBase={openRecoveryBase} />
      )}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSave={applySettings}
        />
      )}

      {showWorldBrowser && (
        <WorldBrowserModal
          onClose={() => setShowWorldBrowser(false)}
          onOpenWorld={(path) => { setShowWorldBrowser(false); openFileAt(path); }}
        />
      )}
      {showNewWorld && (
        <NewWorldModal
          onClose={() => setShowNewWorld(false)}
          onCreated={(path) => { setShowNewWorld(false); openFileAt(path, { fresh: true }); }}
        />
      )}
      <ConfirmHost />
    </div>
  );
}

export default App;
