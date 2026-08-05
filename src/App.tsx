import { encodeU8 } from "./codec";
import { polygonPixels } from "./drawTools";
import {
  type WorldMeta,
  decodeEditResult, decodePreviewData, decodeSelectionMask,
  type SelectionInfo, type ClipboardInfo, type ExtrudeAxis, type AutosaveInfo,
} from "./types";
import { useRecentWorlds, timeAgo } from "./useRecentWorlds";
import { useState, useCallback, useEffect, useRef, useMemo, useImperativeHandle, forwardRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MapCanvas, { KEY_ZOOM_STEP, TOOL_LABELS, TOOL_HINTS, type Tool, type SelectionBounds, type MapCanvasRef, type MaterializeSelectionBounds } from "./MapCanvas";
import MaterializeModal from "./MaterializeModal";
import Sidebar, { type SidebarTab } from "./Sidebar";
import SliceViewport from "./SliceViewport";
import FlyView3D, { type FlyView3DRef, type Overlay3D, type Interact3D } from "./FlyView3D";
import ErrorBoundary from "./ErrorBoundary";
import HelpModal from "./HelpModal";
import AboutModal from "./AboutModal";
import WorldBrowserModal from "./WorldBrowserModal";
import UploadModal from "./UploadModal";
import VmfExportModal, { type VmfExportBounds } from "./VmfExportModal";
import NewWorldModal from "./NewWorldModal";
import SchematicImportModal, { type SchematicInfo, type MappingEntry } from "./SchematicImportModal";
import Ribbon, { RIBBON_HEIGHT_COLLAPSED, TAB_BAR_HEIGHT, DEFAULT_BODY_HEIGHT, EDEN_TEAL, EDEN_TEAL_READABLE, type RibbonTab, type MapViewMode } from "./Ribbon";
import QuickActionsBar from "./QuickActionsBar";
import SettingsModal, { loadSettings, saveSettings, type AppSettings } from "./SettingsModal";
import WorldInfoModal from "./WorldInfoModal";
import RecoveryModal from "./RecoveryModal";
import { resolvePrefabDir } from "./PrefabLibraryPanel";
import Modal from "./Modal";
import { glassPanel, chromeButton, accentRing, expBadge } from "./designTokens";
import { decodeAtlas, tintedSwatch, type AtlasData, clearSwatchCache } from "./texturePack";
import { blockDisplayName, resolveColor, applyBlockTables, orientBlockToFacing, type BlockTables } from "./blockDefs";
import { isTypingTarget, chunkToWorld } from "./viewportUtils";
import { decomposeMask, maskOutline } from "./maskUtils";
import appIcon from "./assets/app-icon.png";
import "./App.css";

// Quad-view divider positions (column/row split fractions), persisted so a layout the user tuned
// survives reloads. Clamped to 0.15–0.85 so no cell can be dragged to nothing.
const STATUS_BAR_HEIGHT = 20; // px reserved at the bottom of the window for statusBarEl

// Toasts (see pushToast). Errors linger ~3× longer than status blips — they carry a message the
// user may need to read, not just an acknowledgement of something they just did.
type ToastKind = "info" | "error";
type Toast = { id: number; text: string; kind: ToastKind };
const INFO_TOAST_MS = 2500;
const ERROR_TOAST_MS = 8000;
const MAX_TOASTS = 4;
const QUAD_SPLITS_KEY = "eden_quad_splits";
const clampSplit = (v: number) => Math.min(0.85, Math.max(0.15, v));

// Hotbar persistence. Stored as a fixed-length array of `{type,paint}|null` so a pinned slot keeps
// its index across restarts; unknown/garbage entries decode to null rather than throwing.
const HOTBAR_PINNED_KEY = "eden_hotbar_pinned";
const HOTBAR_RECENT_KEY = "eden_hotbar_recent";
type HotbarSlot = { type: number; paint: number } | null;
function loadHotbar(key: string, len: number): HotbarSlot[] {
  const out: HotbarSlot[] = Array(len).fill(null);
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return out;
    for (let i = 0; i < Math.min(len, parsed.length); i++) {
      const b = parsed[i];
      if (b && Number.isFinite(b.type) && Number.isFinite(b.paint)) out[i] = { type: b.type, paint: b.paint };
    }
  } catch { /* corrupt entry → empty hotbar */ }
  return out;
}
function saveHotbar(key: string, slots: readonly HotbarSlot[]) {
  try { localStorage.setItem(key, JSON.stringify(slots)); } catch { /* quota / private mode */ }
}
function loadQuadSplits(): { col: number; row: number } {
  try {
    const p = JSON.parse(localStorage.getItem(QUAD_SPLITS_KEY) ?? "{}");
    return { col: clampSplit(Number(p.col) || 0.5), row: clampSplit(Number(p.row) || 0.5) };
  } catch { return { col: 0.5, row: 0.5 }; }
}
function saveQuadSplits(col: number, row: number) {
  localStorage.setItem(QUAD_SPLITS_KEY, JSON.stringify({ col, row }));
}

function SplashLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href="#"
      onClick={(e) => { e.preventDefault(); openUrl(href); }}
      style={{ color: "#83786c", textDecoration: "underline" }}
    >
      {children}
    </a>
  );
}

// ── component ────────────────────────────────────────────────────────────────

// Self-contained FPS meter: owns its rAF loop and 1 Hz state update so the
// per-second re-render stays inside this leaf instead of cascading from App.
function FpsCounter() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0; let last = performance.now();
    let rafId: number;
    const tick = (now: number) => {
      frames++;
      if (now - last >= 1000) { setFps(Math.round(frames * 1000 / (now - last))); frames = 0; last = now; }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);
  return <>{fps} fps</>;
}

type CursorBlockInfo = { z: number; bt: number; paint: number };
type CursorHudHandle = {
  set: (wx: number, wy: number, block: CursorBlockInfo | null) => void;
  setPos: (wx: number, wy: number) => void;
};

// Self-contained status-bar cursor readout: owns its own state so the ~12×/s throttled mouse-move
// tick re-renders only this leaf instead of App (and everything App renders — Ribbon, panels, …).
// Same pattern as FpsCounter/CoordHud (FlyView3D.tsx).
const CursorHud = forwardRef<CursorHudHandle>((_props, ref) => {
  const [pos, setPos] = useState<{ wx: number; wy: number } | null>(null);
  const [block, setBlock] = useState<CursorBlockInfo | null>(null);
  useImperativeHandle(ref, () => ({
    set: (wx, wy, blk) => { setPos({ wx, wy }); setBlock(blk); },
    // Position-only update — used when the cursor moves within the same block cell so the X/Y
    // readout stays live without re-invoking get_cursor_block for an answer that can't have changed.
    setPos: (wx, wy) => { setPos({ wx, wy }); },
  }), []);
  return (
    <>
      <div style={{ padding: "0 10px", borderRight: "1px solid #322d28", minWidth: 100, whiteSpace: "nowrap" }}>
        {pos
          ? <>X <span style={{ color: "#83786c" }}>{Math.round(pos.wx)}</span>{"  "}Y <span style={{ color: "#83786c" }}>{Math.round(pos.wy)}</span></>
          : <span style={{ color: "#312c28" }}>X — Y —</span>
        }
      </div>
      {block && (
        <div style={{ padding: "0 10px", borderRight: "1px solid #322d28", whiteSpace: "nowrap" }}>
          Z <span style={{ color: "#83786c" }}>{block.z}</span>
          {"  "}<span style={{ color: "#61584f" }}>{blockDisplayName(block.bt)}{block.paint > 0 ? <span style={{ color: "#4b443d" }}> #{block.paint}</span> : null}</span>
        </div>
      )}
    </>
  );
});

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
        <div style={{ padding: "0 10px", borderRight: "1px solid #322d28", color: EDEN_TEAL_READABLE, whiteSpace: "nowrap" }}>
          Sel <span style={{ color: EDEN_TEAL_READABLE }}>
            {Math.round(drag.x2 - drag.x1) + 1}×{Math.round(drag.y2 - drag.y1) + 1}
          </span>
          {" · Z "}<span style={{ color: "#70665b" }}>{zMin}–{zMax}</span>
        </div>
      );
    }
    if (selection) {
      return (
        <div style={{ padding: "0 10px", borderRight: "1px solid #322d28", color: "#70665b", whiteSpace: "nowrap" }}>
          Sel <span style={{ color: "#83786c" }}>{selection.width}×{selection.height}</span>
          {selection.masked && selection.cell_count != null && (
            <span style={{ color: "#a855f7", marginLeft: 5 }} title="Shaped selection — edits affect only the wand/lasso footprint, not the whole box">
              ◆ shaped ({selection.cell_count.toLocaleString()} cells)
            </span>
          )}
          {" · Z "}<span style={{ color: "#70665b" }}>{selection.z_min}–{selection.z_max}</span>
        </div>
      );
    }
    return null;
  }
);

function App() {
  const [world, setWorld] = useState<WorldMeta | null>(null);
  // Live mirror of `world` for []-memoized callbacks (undo/redo → applyEditResult).
  const worldRef = useRef<WorldMeta | null>(null);
  useEffect(() => { worldRef.current = world; }, [world]);
  // Monotonically increments only on full world load; triggers view+selection reset in MapCanvas.
  const [worldEpoch, setWorldEpoch] = useState(0);
  const mapCanvasRef = useRef<MapCanvasRef>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportingObj, setExportingObj] = useState(false);
  const [exportingJson, setExportingJson] = useState(false);
  const [exportingVox, setExportingVox] = useState(false);
  const [voxProgress, setVoxProgress] = useState<{ phase: string; pct: number } | null>(null);
  const [vmfExportBounds, setVmfExportBounds] = useState<VmfExportBounds | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveCompressed, setSaveCompressed] = useState(() => loadSettings().defaultSaveCompressed);
  const { recentWorlds, addRecentWorld } = useRecentWorlds();
  const [ribbonCollapsed, setRibbonCollapsed] = useState(() => {
    try { return localStorage.getItem("ribbon_collapsed") === "true"; } catch { return false; }
  });
  const [ribbonBodyHeight, setRibbonBodyHeight] = useState(() => {
    try { return parseInt(localStorage.getItem("ribbon_body_height") ?? String(DEFAULT_BODY_HEIGHT), 10) || DEFAULT_BODY_HEIGHT; } catch { return DEFAULT_BODY_HEIGHT; }
  });
  const effectiveRibbonHeight = ribbonCollapsed ? RIBBON_HEIGHT_COLLAPSED : TAB_BAR_HEIGHT + ribbonBodyHeight + 4;
  const [showQuickActions, setShowQuickActions] = useState(() => loadSettings().showQuickActions);
  // Docked right sidebar (Inspector/Prefabs/Elevation/History) — see Sidebar.tsx. Width persists via
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

  // Status bar: cursor world position and FPS. cursorHudRef feeds the leaf CursorHud component
  // directly (see its definition) so the throttled mouse-move tick doesn't re-render all of App.
  const cursorHudRef = useRef<CursorHudHandle>(null);
  const [ctxMenu, setCtxMenu] = useState<{wx:number;wy:number;x:number;y:number}|null>(null);
  const cursorPosThrottleRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const lastCursorCellRef = useRef<{ cx: number; cy: number } | null>(null);
  const [tool, setTool] = useState<Tool>("pan");
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
  }, []);

  const armToastTimer = useCallback((id: number, ms: number) => {
    const prev = toastTimersRef.current.get(id);
    if (prev) clearTimeout(prev);
    toastTimersRef.current.set(id, setTimeout(() => dismissToast(id), ms));
  }, [dismissToast]);

  const pushToast = useCallback((text: string, kind: ToastKind) => {
    const id = ++toastIdRef.current;
    // Cap the stack — a failing background tick could otherwise queue toasts indefinitely.
    setToasts((list) => [...list.slice(-(MAX_TOASTS - 1)), { id, text, kind }]);
    // Info toasts are one-line status summaries — a fixed 2.5s is fine for "Filled 40 blocks" but
    // cuts off mid-read for a longer one. Scale mildly with length past a baseline, capped so a
    // very long message doesn't linger forever (error toasts already stay parked on hover).
    const ms = kind === "error" ? ERROR_TOAST_MS
      : Math.min(INFO_TOAST_MS * 2.4, INFO_TOAST_MS + Math.max(0, text.length - 30) * 35);
    armToastTimer(id, ms);
    return id;
  }, [armToastTimer]);

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); };
  }, []);

  const showToast = useCallback((text: string) => { pushToast(text, "info"); }, [pushToast]);
  // Both slabs auto-enable ortho on the same selection, and it'd fire again on every later
  // selection — one explanation per session is enough.
  const sliceNoticeShownRef = useRef(false);
  const sliceNotice = useCallback((text: string) => {
    if (sliceNoticeShownRef.current) return;
    sliceNoticeShownRef.current = true;
    showToast(text);
  }, [showToast]);

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

  const [renderMode, setRenderMode] = useState<"tiled" | "full" | "axo">("tiled");
  const [axoSkew, setAxoSkew] = useState(0.2);
  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showWorldInfo, setShowWorldInfo] = useState(false);
  const [prefabNameModal, setPrefabNameModal] = useState(false);
  const [prefabNameInput, setPrefabNameInput] = useState("");
  const [prefabSaving, setPrefabSaving] = useState(false);
  const [prefabOverwrite, setPrefabOverwrite] = useState(false); // armed after an existing-name warning
  const [prefabRefreshToken, setPrefabRefreshToken] = useState(0);
  const [appVersion, setAppVersion] = useState("…");
  useEffect(() => { getVersion().then(setAppVersion); }, []);
  // Fetch canonical block/paint colour tables from Rust once at startup so TS
  // swatch tints match the map/3D render exactly (C6 — ends dual-maintenance drift).
  useEffect(() => {
    invoke<BlockTables>("get_block_tables")
      .then((t) => { applyBlockTables(t); clearSwatchCache(); })
      .catch(() => {}); // fallback tables in blockDefs.ts keep the picker usable
  }, []);
  const [showSlicePanels, setShowSlicePanels] = useState(() => loadSettings().defaultQuadView);
  // 3D fly-through pane (4th quad cell) — off by default; it's the most expensive pane, so the user
  // opts in. `exp` (experimental, perf-heavy on large worlds).
  const [enable3dPane, setEnable3dPane] = useState(() => loadSettings().default3dPane);
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
      showToast("3D lighting (Night / Shadows / GPU Shadows) turned off for the new world — re-enable it in the 3D tab");
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
  const [floodFillLimit, setFloodFillLimit] = useState(() => loadSettings().floodFillLimit);
  const [enableExperimentalExport, setEnableExperimentalExport] = useState(() => loadSettings().enableExperimentalExport);
  // Debounces the localStorage write only (state stays live so the slider/HUD track immediately) —
  // dragging the render-distance slider fires an onChange per pixel, and saveSettings() does a full
  // loadSettings() (JSON.parse) + JSON.stringify round-trip; without this a drag gesture does dozens
  // of synchronous localStorage round-trips for a value that only needs to persist once released.
  const saveSettingsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function saveSettingsDebounced(patch: Partial<AppSettings>) {
    if (saveSettingsDebounceRef.current) clearTimeout(saveSettingsDebounceRef.current);
    saveSettingsDebounceRef.current = setTimeout(() => saveSettings(patch), 250);
  }
  // Shared SettingsModal onSave handler — splash screen and in-editor Settings modals both need
  // the full set of setters applied identically (they drifted once when only one site was updated).
  function applySettings(s: AppSettings) {
    setShowSlicePanels(s.defaultQuadView);
    setEnable3dPane(s.default3dPane);
    setSaveCompressed(s.defaultSaveCompressed);
    setFogEnabled(s.enableFog);
    setShowQuickActions(s.showQuickActions);
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
    setFloodFillLimit(s.floodFillLimit);
    setEnableExperimentalExport(s.enableExperimentalExport);
    if (s.templatePath !== templatePath) setTemplatePath(s.templatePath);
    if (s.texturePackPath !== texturePackPath) {
      if (s.texturePackPath) loadTexturePackFile(s.texturePackPath);
      else unloadTexturePack();
    }
  }
  // Quad-view split fractions (0.15–0.85) + which pane is maximized (session-only). Splits persisted.
  const [quadColSplit, setQuadColSplit] = useState(() => loadQuadSplits().col);
  const [quadRowSplit, setQuadRowSplit] = useState(() => loadQuadSplits().row);
  const [maximizedPane, setMaximizedPane] = useState<"map" | "front" | "side" | "3d" | null>(null);
  const [hoverSplit, setHoverSplit] = useState<"col" | "row" | "both" | null>(null);
  const quadGridRef = useRef<HTMLDivElement>(null);
  const quadDragRef = useRef<null | "col" | "row" | "both">(null);
  const flyActiveRef = useRef(false); // true while FlyView3D fly mode is active — blocks global shortcuts
  const flyView3dRef = useRef<FlyView3DRef>(null);

  // Quad-view splitter drag: a vertical bar moves the column split, a horizontal bar the row split,
  // and the centre knob moves both. Fraction is derived from the pointer position within the grid
  // rect; committed to localStorage on release. Mirrors the Ribbon/SliceViewport drag idiom.
  const beginQuadDrag = (kind: "col" | "row" | "both") => (e: React.PointerEvent) => {
    e.preventDefault();
    quadDragRef.current = kind;
    let latestCol = quadColSplit, latestRow = quadRowSplit;
    const move = (ev: PointerEvent) => {
      const g = quadGridRef.current;
      if (!g) return;
      const r = g.getBoundingClientRect();
      if (kind === "col" || kind === "both") { latestCol = clampSplit((ev.clientX - r.left) / r.width); setQuadColSplit(latestCol); }
      if (kind === "row" || kind === "both") { latestRow = clampSplit((ev.clientY - r.top) / r.height); setQuadRowSplit(latestRow); }
    };
    const up = () => {
      quadDragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveQuadSplits(latestCol, latestRow);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [cam3dPos, setCam3dPos] = useState<{ x: number; y: number } | null>(null);
  const [sliceFrontY, setSliceFrontY] = useState(0); // front slab depth (world Y)
  const [sliceSideX, setSliceSideX] = useState(0);   // side slab depth (world X)
  const [showWorldBrowser, setShowWorldBrowser] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showNewWorld, setShowNewWorld] = useState(false);
  const [schematicInfo, setSchematicInfo] = useState<SchematicInfo | null>(null);
  const [schematicPath, setSchematicPath] = useState<string | null>(null);
  const [schematicApplying, setSchematicApplying] = useState(false);
  const [spawnPos, setSpawnPos] = useState<{ px: number; py: number } | null>(null);
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
  // World bounds of the most recent edit (top-down X/Y) — lets slabs skip refetch if untouched.
  const [lastEditBounds, setLastEditBounds] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

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
  // losing it on restart was a beta complaint).
  const [pinnedBlocks, setPinnedBlocks] = useState<({type: number; paint: number} | null)[]>(() => loadHotbar(HOTBAR_PINNED_KEY, 5));
  const [recentBlocks, setRecentBlocks] = useState<{type: number; paint: number}[]>(
    () => loadHotbar(HOTBAR_RECENT_KEY, 5).filter((b): b is { type: number; paint: number } => b !== null));
  useEffect(() => { saveHotbar(HOTBAR_PINNED_KEY, pinnedBlocks); }, [pinnedBlocks]);
  useEffect(() => { saveHotbar(HOTBAR_RECENT_KEY, recentBlocks); }, [recentBlocks]);
  const pinnedBlocksRef = useRef(pinnedBlocks);
  useEffect(() => { pinnedBlocksRef.current = pinnedBlocks; }, [pinnedBlocks]);
  const recentBlocksRef = useRef(recentBlocks);
  useEffect(() => { recentBlocksRef.current = recentBlocks; }, [recentBlocks]);
  const [hotbarHover, setHotbarHover] = useState<string | null>(null);

  /** 10-slot hotbar data for the 3D pane's in-build overlay (5 pinned + 5 recent, matching the
   *  digit-key ordering) — same block+paint source as the Ribbon hotbar, precomputed into a plain
   *  {type,paint,css,label} shape so FlyView3D doesn't need its own resolveColor/tintedSwatch import. */
  const hotbar3dSlots = useMemo(() => {
    const swatchCss = (type: number, paint: number): string => {
      const url = texturePackInfo ? tintedSwatch(type, paint, texturePackInfo) : null;
      if (url) return `url(${url}) center/cover`;
      const [r, g, b] = resolveColor(type, paint);
      return `rgb(${r},${g},${b})`;
    };
    const pinned = pinnedBlocks.map(b => b ? { type: b.type, paint: b.paint, css: swatchCss(b.type, b.paint), label: blockDisplayName(b.type) } : null);
    const recent = recentBlocks.map(b => ({ type: b.type, paint: b.paint, css: swatchCss(b.type, b.paint), label: blockDisplayName(b.type) }));
    return [...pinned, ...recent.slice(0, 5)];
  }, [pinnedBlocks, recentBlocks, texturePackInfo]);


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
  useEffect(() => { /* elevation panel always visible in normal mode */ }, [lockedPastePos]);

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
  const ctxMenuRef = useRef<typeof ctxMenu>(null);
  useEffect(() => { ctxMenuRef.current = ctxMenu; }, [ctxMenu]);

  // Clamp the context menu into the window after mount — item count is conditional (Copy/Paste
  // only show with a selection/clipboard), so a hard-coded height estimate drifts. Measures the
  // rendered menu and nudges it back on-screen; re-runs (harmlessly, converging to a no-op) after
  // the nudge since it changes ctxMenu itself.
  const ctxMenuElRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const el = ctxMenuElRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = r.right > window.innerWidth ? Math.max(0, window.innerWidth - r.width - 4) : ctxMenu.x;
    const ny = r.bottom > window.innerHeight ? Math.max(0, window.innerHeight - r.height - 4) : ctxMenu.y;
    if (nx !== ctxMenu.x || ny !== ctxMenu.y) setCtxMenu(m => m && { ...m, x: nx, y: ny });
  }, [ctxMenu]);

  // Dismiss context menu on any outside click.
  // Delay registration to avoid macOS right-click pointerdown firing after contextmenu.
  useEffect(() => {
    if (!ctxMenu) return;
    let handler: (() => void) | null = null;
    const timer = setTimeout(() => {
      handler = () => setCtxMenu(null);
      document.addEventListener("mousedown", handler);
    }, 80);
    return () => {
      clearTimeout(timer);
      if (handler) document.removeEventListener("mousedown", handler);
    };
  }, [ctxMenu]);
  const renderModeRef = useRef<"tiled" | "full" | "axo">("tiled");
  useEffect(() => { renderModeRef.current = renderMode; }, [renderMode]);
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
  // unless the quad + 3D pane are both up — so we skip the App re-render entirely when they're not,
  // and rAF-throttle it when they are. The status-bar dimensions readout is fed imperatively into the
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
    if (!showSlicePanels || !enable3dPane) return;
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
    if (!showSlicePanels || !enable3dPane) return null;
    const ovs: Overlay3D[] = [];
    if (pick3dFirst) {
      const { x, y, z } = pick3dFirst;
      ovs.push({ min: [x, z, y], max: [x + 1, z + 1, y + 1], color: 0xf59e0b });
    }
    // While a marquee select is in progress, `dragSelectRect` updates every pointer-move but
    // `rawBounds` only commits on release — prefer the live rect so the blue 3D box tracks the drag
    // in real time instead of snapping into place at the end. (Only the wireframe box follows live;
    // the slab viewports still key off committed `rawBounds`, since they re-fetch pixels per change.)
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
  }, [showSlicePanels, enable3dPane, rawBounds, dragSelectRect, zMin, zMax, extrudeOpen, extrudeAxis, extrudeCount, lockedPastePos, clipboard, pasteElevationOffset, pick3dFirst, selectionMaskOverlay]);

  // When a selection is made, snap the Front/Side slice planes to its centre so the slabs show the
  // selection by default (mirrors what the elevation preview shows). Only fires on selection change,
  // so the user can still scrub freely afterwards.
  useEffect(() => {
    if (!rawBounds) return;
    setSliceFrontY(Math.round((rawBounds.y1 + rawBounds.y2) / 2));
    setSliceSideX(Math.round((rawBounds.x1 + rawBounds.x2) / 2));
  }, [rawBounds]);

  // Snap slab depths to the paste footprint when a paste is locked in (so the ghost shows in context).
  useEffect(() => {
    if (!lockedPastePos || !clipboard) return;
    setSliceFrontY(Math.round(lockedPastePos.y + clipboard.height / 2));
    setSliceSideX(Math.round(lockedPastePos.x + clipboard.width / 2));
  }, [lockedPastePos, clipboard]);

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
  useEffect(() => {
    if (!clipboard) { setClipboardPreviewPixels(null); return; }
    invoke<ArrayBuffer>("render_clipboard_preview")
      .then(buf => setClipboardPreviewPixels(decodePreviewData(buf)))
      .catch(() => setClipboardPreviewPixels(null));
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

  const applyEditResult = useCallback(async (buf: ArrayBuffer, kind: "edit" | "undo" | "redo" = "edit") => {
    const raw = decodeEditResult(buf);
    // Cutaway is a top-down render — the patch Rust returns is already capped, so it applies directly.
    if (viewModeRef.current !== "zslice") {
      if (renderModeRef.current === "axo") {
        // Axo projection: flat patch positions don't match axo pixel positions, force full re-render.
        // Read via ref: this runs from []-memoized undo/redo callbacks where `world` is stale.
        const w = worldRef.current;
        if (w) mapCanvasRef.current?.refetchRegion(0, 0, chunkToWorld(w.width_chunks), chunkToWorld(w.height_chunks));
      } else {
        mapCanvasRef.current?.applyPatch(raw.patch);
      }
    } else {
      // z-slice: invalidate and re-fetch the affected tile region
      mapCanvasRef.current?.refetchRegion(
        raw.patch.x, raw.patch.y,
        raw.patch.x + raw.patch.width,
        raw.patch.y + raw.patch.height,
      );
    }
    // Broadcast the edit's world bounds so slice slabs can skip refetching when their depth plane
    // wasn't touched. (Patch carries top-down X/Y extent; z always overlaps the full-height slabs.)
    setLastEditBounds({ x: raw.patch.x, y: raw.patch.y, w: raw.patch.width, h: raw.patch.height });
    setUndoDepth(raw.undo_depth);
    setRedoDepth(raw.redo_depth);
    setEditEpoch(e => e + 1);
    if (raw.operation) {
      const prefix = kind === "undo" ? "Undid: " : kind === "redo" ? "Redid: " : "";
      showToast(prefix + raw.operation);
    }
  }, [showToast]);

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
  function applyLoadedWorld(data: WorldMeta, path: string | null, opts?: { skipRecent?: boolean }) {
    setWorld(data);
    setWorldEpoch((e) => e + 1);
    setSourcePath(path);
    setRawBounds(null);
    setMaterializeSelection(null);
    setZMin(0);
    setZMax(data.max_z);
    setTool("pan");
    setUndoDepth(0);
    setRedoDepth(0);
    setViewMode("topdown");
    setZSliceZ(32);
    setClipboard(null);
    resetHeavyLighting();
    setSaveCompressed(data.was_compressed);
    setSpawnPos(data.spawn_px != null && data.spawn_py != null ? { px: data.spawn_px, py: data.spawn_py } : null);
    if (path && !opts?.skipRecent) addRecentWorld(path, data.name);
    lastAutosavedEpochRef.current = editEpochRef.current;
    savedEpochRef.current = editEpochRef.current;
  }

  async function swapToWorldFile(path: string, opts?: { skipRecent?: boolean }) {
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

  async function openFileAt(path: string, opts?: { skipRecent?: boolean }) {
    if (world && isDirty()) {
      const ok = await ask("You have unsaved changes. Open a new world and discard them?", {
        title: "Unsaved changes", kind: "warning",
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
    setExporting(true);
    setExportProgress(null); // indeterminate — Rust renders + encodes the whole map in one call
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
      reportError(e);
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  }

  async function exportObj() {
    if (!world) return;
    const defaultName = selection ? `${world.name}_selection.obj` : `${world.name}.obj`;
    const savePath = await save({
      filters: [{ name: "Wavefront OBJ", extensions: ["obj"] }],
      defaultPath: defaultName,
    });
    if (!savePath) return;
    const x1 = selection ? selection.x1 : 0;
    const y1 = selection ? selection.y1 : 0;
    const x2 = selection ? selection.x2 : chunkToWorld(world.width_chunks) - 1;
    const y2 = selection ? selection.y2 : chunkToWorld(world.height_chunks) - 1;
    const zMin = selection ? selection.z_min : 0;
    const zMax = selection ? selection.z_max : world.max_z;
    setExportingObj(true);
    try {
      await invoke("export_obj", { path: savePath, x1, y1, x2, y2, zMin, zMax });
    } catch (e) {
      reportError(e);
    } finally {
      setExportingObj(false);
    }
  }

  async function exportJson() {
    if (!world) return;
    const defaultName = selection ? `${world.name}_selection.json.gz` : `${world.name}.json.gz`;
    const savePath = await save({
      filters: [{ name: "Gzipped JSON", extensions: ["json.gz", "gz"] }],
      defaultPath: defaultName,
    });
    if (!savePath) return;
    const x1 = selection ? selection.x1 : 0;
    const y1 = selection ? selection.y1 : 0;
    const x2 = selection ? selection.x2 : chunkToWorld(world.width_chunks) - 1;
    const y2 = selection ? selection.y2 : chunkToWorld(world.height_chunks) - 1;
    const zMin = selection ? selection.z_min : 0;
    const zMax = selection ? selection.z_max : world.max_z;
    setExportingJson(true);
    try {
      await invoke("export_json", { path: savePath, x1, y1, x2, y2, zMin, zMax });
    } catch (e) {
      reportError(e);
    } finally {
      setExportingJson(false);
    }
  }

  // VMF export is selection-scale only (Source caps a map at 8,192 brushes; whole-world export
  // is a footgun, not a feature) — opening the modal without a selection would just let the user
  // hit the brush-count guard after already filling out options, so the guard fires up front.
  function exportVmf() {
    if (!world) return;
    if (!selection) {
      showToast("Select a region first — VMF export works on a selection, not the whole world");
      return;
    }
    setVmfExportBounds({
      x1: selection.x1, y1: selection.y1, x2: selection.x2, y2: selection.y2,
      zMin: selection.z_min, zMax: selection.z_max,
    });
  }

  // VOX export hidden pending better test coverage — prefixed to silence TS unused warning
  const _exportVox = async () => {
    if (!world) return;
    const defaultName = selection ? `${world.name}_selection.vox` : `${world.name}.vox`;
    const savePath = await save({
      filters: [{ name: "MagicaVoxel VOX", extensions: ["vox"] }],
      defaultPath: defaultName,
    });
    if (!savePath) return;
    const x1 = selection ? selection.x1 : 0;
    const y1 = selection ? selection.y1 : 0;
    const x2 = selection ? selection.x2 : chunkToWorld(world.width_chunks) - 1;
    const y2 = selection ? selection.y2 : chunkToWorld(world.height_chunks) - 1;
    const zMin = selection ? selection.z_min : 0;
    const zMax = selection ? selection.z_max : world.max_z;
    setExportingVox(true);
    setVoxProgress({ phase: "Starting…", pct: 0 });
    try {
      await invoke("export_vox", { path: savePath, x1, y1, x2, y2, zMin, zMax });
    } catch (e) {
      reportError(e);
    } finally {
      setExportingVox(false);
      setVoxProgress(null);
    }
  }; void _exportVox;

  function commitZSlice(z: number) {
    setZSliceZ(z);
  }

  const copySelection = useCallback(async () => {
    if (!rawBounds) return;
    try {
      const info = await invoke<ClipboardInfo>("copy_selection", { ...rawBounds, zMin, zMax });
      setClipboard(info);
      setTool("paste");
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
    } catch (e) {
      reportError(e);
    }
  }

  async function mirrorClipboardX() {
    try {
      const info = await invoke<ClipboardInfo>("mirror_clipboard_x");
      setClipboard(info);
    } catch (e) {
      reportError(e);
    }
  }

  async function mirrorClipboardY() {
    try {
      const info = await invoke<ClipboardInfo>("mirror_clipboard_y");
      setClipboard(info);
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

  function trackRecentBlock(type: number, paint: number) {
    setRecentBlocks(prev => {
      const filtered = prev.filter(b => !(b.type === type && b.paint === paint));
      return [{ type, paint }, ...filtered].slice(0, 5);
    });
  }

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
          .then(r => cursorHudRef.current?.set(cx, cy, r ? { z: r[0], bt: r[1], paint: r[2] } : null))
          .catch(() => cursorHudRef.current?.set(cx, cy, null));
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
      }
    } catch (e) { reportError(e); }
  }

  async function handleLassoSelect(pathPts: [number, number][]) {
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
      if (!persistPaste) setTool("pan");
    } catch (e) { reportError(e); }
  }

  async function handleDrawElevation(x: number, y: number, z: number) {
    try {
      const result = await invoke<ArrayBuffer>("paint_blocks", {
        blocks: [{ x, y, z }], blockType: fillBlockType, paint: fillPaint, zOffset: 0,
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

  // The 3D pane only exists in quad view with the 3D pane enabled; reset its mode to camera-only when
  // it's not showing, so a stale build/select mode doesn't linger when the pane comes back.
  useEffect(() => { if (!(showSlicePanels && enable3dPane)) setMode3d("off"); }, [showSlicePanels, enable3dPane]);

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
   *  chunk-mesh edit sync come for free. Same for place, below. */
  async function handlePick3dBreak(x: number, y: number, z: number) {
    try {
      const result = await invoke<ArrayBuffer>("paint_blocks", { blocks: [{ x, y, z }], blockType: 0, paint: 0, zOffset: 0 });
      await applyEditResult(result);
    } catch (e) { reportError(e); }
  }

  /** Place the armed block (shared with the 2D fill block/hotbar) in the empty voxel against the
   *  picked face. `yaw` is the player's Eden look direction at click time; with Auto-orient on it
   *  rotates directional blocks (ramps/wedges/doors) to face the player. */
  async function handlePick3dPlace(x: number, y: number, z: number, yaw: number) {
    if (fillBlockType === 0) return; // "Air" as the armed block would be a no-op place
    const blockType = autoOrient3d ? orientBlockToFacing(fillBlockType, yaw) : fillBlockType;
    try {
      const result = await invoke<ArrayBuffer>("paint_blocks", {
        blocks: [{ x, y, z }], blockType, paint: fillPaint, zOffset: 0,
      });
      await applyEditResult(result);
      trackRecentBlock(fillBlockType, fillPaint);
    } catch (e) { reportError(e); }
  }

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

  // Batch paint at exact world cells (one undo entry). Used by the slice viewports.
  async function handleSlicePaint(cells: { x: number; y: number; z: number }[]) {
    if (!cells.length) return;
    try {
      const result = await invoke<ArrayBuffer>("paint_blocks", {
        blocks: cells, blockType: fillBlockType, paint: fillBlockType === 0 ? 0 : fillPaint, zOffset: 0,
      });
      await applyEditResult(result);
      trackRecentBlock(fillBlockType, fillPaint);
    } catch (e) {
      reportError(e);
    }
  }

  const handleUndo = useCallback(async () => {
    try {
      const result = await invoke<ArrayBuffer>("undo_edit");
      await applyEditResult(result, "undo");
    } catch (e) {
      if (e !== "Nothing to undo") reportError(e);
    }
  }, [applyEditResult, reportError]);

  const handleRedo = useCallback(async () => {
    try {
      const result = await invoke<ArrayBuffer>("redo_edit");
      await applyEditResult(result, "redo");
    } catch (e) {
      if (e !== "Nothing to redo") reportError(e);
    }
  }, [applyEditResult, reportError]);

  const saveWorld = useCallback(async (path: string) => {
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
          showToast(`Saved ${saveCompressed ? "compressed" : "uncompressed"} data into a “.${ext}” file — other tools may not recognize it`);
        }
      }
      await invoke("save_world", { path, compressed: saveCompressed, backupCompressed: loadSettings().backupCompressed });
      // A real save makes any pending autosave sidecar redundant — nothing left to recover.
      lastAutosavedEpochRef.current = editEpochRef.current;
      savedEpochRef.current = editEpochRef.current;
      invoke("discard_autosave").catch(() => {});
    } catch (e) {
      reportError(e);
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
      const ok = await ask(
        `${finalPath.slice(finalPath.lastIndexOf("/") + 1)} already exists. Overwrite it?`,
        { title: "Confirm overwrite", kind: "warning" },
      );
      if (!ok) return;
    }
    await saveWorld(finalPath);
    setSourcePath(finalPath);
  }, [sourcePath, saveWorld, saveCompressed]);

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
      invoke("autosave_world", { sourcePath: sourcePathRef.current })
        .then(() => {
          lastAutosavedEpochRef.current = epoch;
          autosaveFailureCountRef.current = 0;
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
          await invoke("autosave_world", { sourcePath: sourcePathRef.current });
          lastAutosavedEpochRef.current = epoch;
          autosaveFailureCountRef.current = 0;
        } catch (e) {
          autosaveFailureCountRef.current += 1;
          console.warn("Autosave-on-quit failed:", e);
          if (autosaveFailureCountRef.current >= 2) reportError(e);
        }
      }
      const ok = await ask("You have unsaved changes. Quit and discard them?", {
        title: "Unsaved changes", kind: "warning",
      });
      if (ok) win.destroy();
    });
    return () => { unlisten.then((f) => f()); };
  }, [isDirty, reportError]);

  async function recoverAutosave() {
    if (!recoveryInfo) return;
    setRecovering(true);
    try {
      if (recoveryInfo.format === 1) {
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
  const anyModalOpen =
    showAbout || showSettings || showWorldInfo || showWorldBrowser || showUploadModal ||
    showNewWorld || !!schematicInfo || showExpandModal || !!recoveryInfo || prefabNameModal ||
    !!vmfExportBounds;
  const anyModalOpenRef = useRef(false);
  useEffect(() => { anyModalOpenRef.current = anyModalOpen; }, [anyModalOpen]);

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
      // Hotbar digits (1-5 pinned, 6-0 recent) work even while the 3D fly camera is active — WASD/
      // space/ctrl/shift are the only keys the fly controller actually needs, so digits jump ahead
      // of the fly-camera gate below and arm a block for 3D build mode without leaving the pane.
      if (world && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey && !anyModalOpenRef.current && !showHelp) {
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
      if (flyActiveRef.current && !e.metaKey) return;
      // A modal dialog is open — let it own the keyboard (its own Escape/Enter handling applies).
      if (anyModalOpenRef.current) return;
      const typing = isTypingTarget(e.target);
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
        if (t === "paste" || t === "wand" || t === "lasso" || t === "pen" || t === "brush" || t === "spray" || t === "line" || t === "rect" || t === "ellipse" || t === "polygon" ||
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
        if (isSculptToolKey && (e.key === "[" || e.key === "]")) {
          e.preventDefault();
          const dir = e.key === "]" ? 1 : -1;
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

  // VOX export progress event listener
  useEffect(() => {
    const unlisten = listen<{ phase: string; pct: number }>("vox-progress", (e) => {
      setVoxProgress(e.payload);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

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
      await invoke("save_prefab", { path });
      setPrefabRefreshToken((t) => t + 1);
      setPrefabNameModal(false);
      showToast(`Saved prefab “${safe}”`);
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
    await invoke("save_prefab", { path })
      .then(() => setPrefabRefreshToken((t) => t + 1))
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

  async function importSchematic() {
    const path = await open({
      filters: [{ name: "Minecraft Schematic / Sponge / Litematica", extensions: ["schematic", "schem", "litematic"] }],
      multiple: false,
    });
    if (!path || typeof path !== "string") return;
    const info = await invoke<SchematicInfo>("import_schematic_info", { path })
      .catch((e: unknown) => { reportError(e); return null; });
    if (!info) return;
    setSchematicPath(path);
    setSchematicInfo(info);
  }

  async function applySchematic(mapping: MappingEntry[]) {
    if (!schematicPath) return;
    setSchematicApplying(true);
    try {
      const info = await invoke<ClipboardInfo>("import_schematic_apply", {
        path: schematicPath, mapping,
      });
      setClipboard(info);
      setTool("paste");
      setSchematicInfo(null);
      setSchematicPath(null);
    } catch (e) {
      reportError(e);
    } finally {
      setSchematicApplying(false);
    }
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
      const ok = await ask("You have unsaved changes. Close this world and discard them?", {
        title: "Unsaved changes", kind: "warning",
      });
      if (!ok) return;
    }
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

  const pastePreviewSelection: SelectionInfo | null =
    lockedPastePos && clipboard
      ? {
          x1: lockedPastePos.x,
          y1: lockedPastePos.y,
          x2: lockedPastePos.x + clipboard.width - 1,
          y2: lockedPastePos.y + clipboard.height - 1,
          z_min: clipboard.z_anchor + pasteElevationOffset,
          z_max: clipboard.z_anchor + pasteElevationOffset + clipboard.depth - 1,
          width: clipboard.width,
          height: clipboard.height,
          depth: clipboard.depth,
          cell_count: null,
          masked: false,
        }
      : null;

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
      committedSelection={rawBounds}
      onSelectionChange={handleSelectionChange}
      pastePreview={clipboard && tool === "paste"
        ? { width: clipboard.width, height: clipboard.height }
        : null}
      clipboardPreviewPixels={tool === "paste" ? clipboardPreviewPixels : null}
      onPasteAt={handlePasteClick}
      lockedPastePos={lockedPastePos}
      renderMode={renderMode}
      axoSkew={axoSkew}
      sliceLines={showSlicePanels ? { x: sliceSideX, y: sliceFrontY } : null}
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
      selectionMask={selectionMaskOverlay}
      spawnPos={spawnPos}
      creatures={[]}
      pasteElevationOffset={pasteElevationOffset}
      onEyedropper={handleEyedropper}
      onPoolFillPick={handlePoolFillPick}
      cameraPos3d={showSlicePanels && enable3dPane ? cam3dPos : null}
      onSetCamera3d={showSlicePanels && enable3dPane ? (wx, wy) => flyView3dRef.current?.teleport(wx, wy) : undefined}
      // Off in cutaway: the template is a surface map, so overlaying it under a cutaway would put
      // roof-level terrain behind the cave interior you're trying to see.
      showTemplateOverlay={showTemplateOverlay && templateLoaded && viewMode === "topdown"}
      onMapContextMenu={(wx, wy, x, y) => setCtxMenu({ wx, wy, x, y })}
      onSelectDragUpdate={handleSelectDragUpdate}
      onMoveSelection={nudgeSelection}
      moveWithContents={moveWithContents}
      committedMaterializeSelection={materializeSelection}
      onMaterializeSelectionChange={handleMaterializeSelectionChange}
    />
  ) : null;

  // Status bar element — computed outside JSX so TypeScript narrows `world` properly
  const statusBarEl = world ? (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, height: STATUS_BAR_HEIGHT, zIndex: 150,
      background: "linear-gradient(to bottom, #201208, #100f0d)",
      borderTop: "1px solid #322d28",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,.05)",
      display: "flex", alignItems: "center",
      fontSize: 10, color: "#61584f", userSelect: "none",
      fontVariantNumeric: "tabular-nums",
    }}>
      <div style={{ padding: "0 10px", borderRight: "1px solid #322d28", whiteSpace: "nowrap", color: "#70665b" }}>
        {tool === "brush" ? `Brush ${brushSize}px`
          : tool === "paste" && pasteMode !== "normal" ? `Paste (${pasteMode})`
          : TOOL_LABELS[tool]}
      </div>
      <div style={{ padding: "0 10px", borderRight: "1px solid #322d28", color: "#4b443d", whiteSpace: "nowrap" }}>
        {world.name}
      </div>
      <div style={{ padding: "0 10px", borderRight: "1px solid #322d28", whiteSpace: "nowrap" }}>
        {chunkToWorld(world.width_chunks)}×{chunkToWorld(world.height_chunks)}
        <span
          title={world.max_z === 255
            ? "New Dawn (256z) format — worlds up to 256 blocks tall"
            : "Legacy (64z) format — worlds up to 64 blocks tall"}
          style={{ color: world.max_z === 255 ? "#6d28d9" : "#453f38", marginLeft: 6 }}
        >
          {world.max_z === 255 ? "256z" : "64z"}
        </span>
      </div>
      <CursorHud ref={cursorHudRef} />
      <SelStatusHud ref={selStatusHudRef} selection={selection} zMin={zMin} zMax={zMax} />
      {tool === "materialize" && materializeSelection && (() => {
        const { cx1, cy1, cx2, cy2 } = materializeSelection;
        const nChunks = (cx2 - cx1 + 1) * (cy2 - cy1 + 1);
        return (
          <div style={{ padding: "0 10px", borderRight: "1px solid #322d28", color: "#d97706", whiteSpace: "nowrap" }}>
            ▦ {nChunks.toLocaleString()} chunk{nChunks === 1 ? "" : "s"} selected
          </div>
        );
      })()}
      <div style={{ padding: "0 10px", borderRight: "1px solid #322d28", whiteSpace: "nowrap" }}>
        ↩ <span style={{ color: "#4b443d" }}>{undoDepth}</span>
        {"  "}↪ <span style={{ color: "#4b443d" }}>{redoDepth}</span>
      </div>
      {/* The filter's only other Clear button lives in the Selection tab, which disappears with the
          selection — deselect and the filter (which still gates deletes) became unclearable. */}
      {filterBlockType !== null && (
        <div style={{ padding: "0 4px 0 8px", borderRight: "1px solid #322d28", whiteSpace: "nowrap",
          display: "flex", alignItems: "center", gap: 4,
          color: "#f59e0b", background: "rgba(245,158,11,0.07)" }}>
          <span>Filter: {blockDisplayName(filterBlockType)}{filterPaint !== null ? ` #${filterPaint}` : ""}{filterInvert ? " (inv)" : ""}</span>
          <button
            onClick={() => { setFilterBlockType(null); setFilterPaint(null); setFilterInvert(false); }}
            title="Clear the replace filter"
            aria-label="Clear replace filter"
            style={{ background: "none", border: "none", cursor: "pointer", color: "#f59e0b",
              minWidth: 18, minHeight: 18, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, lineHeight: 1, opacity: 0.75 }}
            onMouseEnter={e => { e.currentTarget.style.opacity = "1"; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = "0.75"; }}
          >✕</button>
        </div>
      )}
      {maskEnabled && maskBlockType !== null && (
        <div style={{ padding: "0 8px", borderRight: "1px solid #322d28", whiteSpace: "nowrap",
          color: "#a78bfa", background: "rgba(167,139,250,0.07)" }}>
          Mask: {blockDisplayName(maskBlockType)}{maskPaint !== null ? ` #${maskPaint}` : ""}
        </div>
      )}
      {/* Two-click paste is otherwise signalled only by the ghost turning green → amber, which is
          easy to miss — this is the "why did nothing paste?" moment. */}
      {tool === "paste" && (
        <div style={{ padding: "0 8px", borderRight: "1px solid #322d28", whiteSpace: "nowrap",
          color: lockedPastePos ? "#fcd34d" : "#86efac",
          background: lockedPastePos ? "rgba(245,158,11,0.07)" : "rgba(34,197,94,0.06)" }}>
          {lockedPastePos
            ? "Position locked — click again to stamp, Esc to unlock"
            : "Click the map to lock the paste position"}
        </div>
      )}
      {/* Same idea, extended to the other gestures with no on-screen affordance: the polygon's
          close-the-loop click, Grab's vertical drag, and the fact that a selection can be dragged
          and resized at all. */}
      {tool !== "paste" && TOOL_HINTS[tool] && (
        <div style={{ padding: "0 8px", borderRight: "1px solid #322d28", whiteSpace: "nowrap", color: "#83786c" }}>
          {TOOL_HINTS[tool]}
        </div>
      )}
      {tool === "select" && rawBounds && (
        <div style={{ padding: "0 8px", borderRight: "1px solid #322d28", whiteSpace: "nowrap", color: "#83786c" }}>
          Drag an edge grip to resize · drag inside to move {moveWithContents ? "the blocks" : "the box only"} · arrows nudge
        </div>
      )}
      <div style={{ flex: 1 }} />
      <div style={{ padding: "0 10px", borderLeft: "1px solid #322d28", color: EDEN_TEAL_READABLE, opacity: 0.6, whiteSpace: "nowrap" }}>
        <FpsCounter />
      </div>
    </div>
  ) : null;

  if (world) {
    const sliceDrawTool = (["pen","brush","rect","ellipse"] as const).find(t => t === tool);
    // Active region shown on the slabs: the paste footprint (preview) or the current selection.
    const sliceIsPaste = pastePreviewSelection != null;
    const sliceSel = pastePreviewSelection
      ?? (rawBounds ? { x1: rawBounds.x1, y1: rawBounds.y1, x2: rawBounds.x2, y2: rawBounds.y2, z_min: zMin, z_max: zMax } : null);
    const sliceSelZ = sliceSel ? { min: sliceSel.z_min, max: sliceSel.z_max } : null;
    const sliceExtrudeCount = sliceIsPaste ? 0 : (extrudeOpen && extrudeCount > 0 ? extrudeCount : 0);
    const sliceZResize = sliceIsPaste ? undefined : (a: number, b: number) => { setZMin(a); setZMax(b); };
    const sliceHResizeFront = sliceIsPaste ? undefined : (lo: number, hi: number) => setRawBounds(rb => rb ? { ...rb, x1: lo, x2: hi } : rb);
    const sliceHResizeSide = sliceIsPaste ? undefined : (lo: number, hi: number) => setRawBounds(rb => rb ? { ...rb, y1: lo, y2: hi } : rb);
    // Marquee-select on a slab: front sets X+Z (Y kept, or pinned to the slab's depth for a fresh
    // selection); side sets Y+Z (X kept / pinned). The orthogonal extent is then adjustable via the
    // other slab's divider or the top-down map.
    const sliceSelectMode = !sliceIsPaste && tool === "select";
    const sliceSelectFront = sliceSelectMode
      ? (xLo: number, xHi: number, zLo: number, zHi: number) => {
          setRawBounds(rb => rb ? { ...rb, x1: xLo, x2: xHi } : { x1: xLo, y1: sliceFrontY, x2: xHi, y2: sliceFrontY });
          setZMin(zLo); setZMax(zHi);
        }
      : undefined;
    const sliceSelectSide = sliceSelectMode
      ? (yLo: number, yHi: number, zLo: number, zHi: number) => {
          setRawBounds(rb => rb ? { ...rb, y1: yLo, y2: yHi } : { x1: sliceSideX, y1: yLo, x2: sliceSideX, y2: yHi });
          setZMin(zLo); setZMax(zHi);
        }
      : undefined;
    const sliceCommon = {
      world,
      editEpoch,
      lastEdit: lastEditBounds,
      brush: { size: tool === "brush" ? brushSize : 1, shape: brushShape },
      tool: sliceDrawTool,
      fill: drawFilled,
      onPaint: sliceDrawTool ? handleSlicePaint : undefined,
      selZ: sliceSelZ,
      extrudeCount: sliceExtrudeCount,
      extrudeAxis,
      isPaste: sliceIsPaste,
      onNotice: sliceNotice,
      onZRangeChange: sliceZResize,
      viewCapZ,
      selectMode: sliceSelectMode,
    };
    // Quad-view grid templates. Normally fraction-driven from the split sliders; when a pane is
    // maximized, collapse the other row/column to 0fr so the chosen quadrant fills the area (all four
    // cells stay mounted, so FlyView3D's WebGL context and the slice panes are not torn down).
    const qCol0Max = maximizedPane === "map" || maximizedPane === "side";
    const qCol1Max = maximizedPane === "front" || maximizedPane === "3d";
    const qRow0Max = maximizedPane === "map" || maximizedPane === "front";
    const qRow1Max = maximizedPane === "side" || maximizedPane === "3d";
    const quadCols = maximizedPane ? `${qCol0Max ? 1 : 0}fr ${qCol1Max ? 1 : 0}fr` : `${quadColSplit}fr ${1 - quadColSplit}fr`;
    const quadRows = maximizedPane ? `${qRow0Max ? 1 : 0}fr ${qRow1Max ? 1 : 0}fr` : `${quadRowSplit}fr ${1 - quadRowSplit}fr`;
    // Per-cell maximize/restore button (bottom-right corner, clear of FlyView3D's own chrome).
    const maxBtn = (pane: "map" | "front" | "side" | "3d") => (
      <button
        onClick={() => setMaximizedPane(m => (m === pane ? null : pane))}
        title={maximizedPane === pane ? "Restore quad view" : "Maximize this pane"}
        style={{
          position: "absolute", bottom: 6, right: 6, zIndex: 3,
          background: "rgba(31,28,26,0.85)", color: "#afa69d", border: "1px solid #4b443d",
          borderRadius: 4, padding: "1px 6px", fontSize: 12, lineHeight: 1.2, cursor: "pointer",
        }}
      >{maximizedPane === pane ? "⤡" : "⤢"}</button>
    );
    return (
      <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
        {showSlicePanels ? (
          // Quad view: the real top-down map (top-left) + Front / Side slices + 3D placeholder.
          // Top strip is left clear for the floating menu/toolbar chrome.
          <div ref={quadGridRef} style={{
            position: "absolute", top: effectiveRibbonHeight, left: 0, right: sidebarInsetPx, bottom: STATUS_BAR_HEIGHT,
            display: "grid", gridTemplateColumns: quadCols, gridTemplateRows: quadRows,
            gap: 2, background: "#0a0f1e",
          }}>
            <div style={{ position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden", outline: "1px solid #312c28" }}>
              {mapPaneEl}
              {maxBtn("map")}
            </div>
            <div style={{ position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden", outline: "1px solid #312c28" }}>
              <ErrorBoundary label="Front view">
                <SliceViewport {...sliceCommon} axis="front"
                  depth={sliceFrontY} onDepthChange={setSliceFrontY}
                  crossH={sliceSideX} crossV={zSliceZ}
                  selRange={sliceSel ? { lo: sliceSel.x1, hi: sliceSel.x2 } : null}
                  selFull={!sliceIsPaste && sliceSel ? { xLo: sliceSel.x1, yLo: sliceSel.y1, xHi: sliceSel.x2, yHi: sliceSel.y2, zLo: sliceSel.z_min, zHi: sliceSel.z_max } : null}
                  onHRangeChange={sliceHResizeFront} onSelect={sliceSelectFront} />
              </ErrorBoundary>
              {maxBtn("front")}
            </div>
            <div style={{ position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden", outline: "1px solid #312c28" }}>
              <ErrorBoundary label="Side view">
                <SliceViewport {...sliceCommon} axis="side"
                  depth={sliceSideX} onDepthChange={setSliceSideX}
                  crossH={sliceFrontY} crossV={zSliceZ}
                  selRange={sliceSel ? { lo: sliceSel.y1, hi: sliceSel.y2 } : null}
                  selFull={!sliceIsPaste && sliceSel ? { xLo: sliceSel.x1, yLo: sliceSel.y1, xHi: sliceSel.x2, yHi: sliceSel.y2, zLo: sliceSel.z_min, zHi: sliceSel.z_max } : null}
                  onHRangeChange={sliceHResizeSide} onSelect={sliceSelectSide} />
              </ErrorBoundary>
              {maxBtn("side")}
            </div>
            <div style={{ position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden", outline: "1px solid #312c28" }}>
              {enable3dPane ? (
                <>
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
                      anyModalOpen={anyModalOpen}
                      editEpoch={editEpoch}
                      lastEdit={lastEditBounds}
                      onFlyModeChange={(a) => { flyActiveRef.current = a; }}
                      onCameraMove={(wx, wy) => setCam3dPos({ x: wx, y: wy })}
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
                      hotbarSlots={hotbar3dSlots}
                      activeBlock={{ type: fillBlockType, paint: fillPaint }}
                      onHotbarSelect={(type, paint) => { setFillBlockType(type); setFillPaint(paint); }}
                    />
                  </ErrorBoundary>
                  <button
                    onClick={() => setEnable3dPane(false)}
                    title="Disable the 3D pane (saves performance)"
                    style={{
                      position: "absolute", top: 36, right: 6, zIndex: 2,
                      background: "rgba(31,28,26,0.85)", color: "#afa69d", border: "1px solid #4b443d",
                      borderRadius: 4, padding: "1px 7px", fontSize: 11, cursor: "pointer",
                    }}
                  >✕ 3D</button>
                </>
              ) : (
                // Off by default — the 3D pane is the heaviest viewport. Opt in here.
                <div style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  gap: 10, width: "100%", height: "100%", background: "#0a0f1e", color: "#83786c",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, letterSpacing: "0.04em" }}>
                    3D FLY-THROUGH
                    <span style={expBadge({ fontSize: 9 })}>exp</span>
                  </div>
                  <button
                    onClick={() => setEnable3dPane(true)}
                    style={{
                      background: "#312c28", color: "#dad6d2", border: "1px solid #61584f",
                      borderRadius: 6, padding: "6px 14px", fontSize: 12, cursor: "pointer",
                    }}
                  >Enable 3D view</button>
                  <div style={{ fontSize: 10, color: "#61584f", maxWidth: 220, textAlign: "center" }}>
                    Off by default to save performance. Streams chunk geometry around the camera.
                  </div>
                </div>
              )}
              {maxBtn("3d")}
            </div>

            {/* Draggable splitters — hidden while a pane is maximized. A vertical bar moves the
                column split, a horizontal bar the row split, and the centre knob moves both. */}
            {!maximizedPane && (
              <>
                <div
                  onPointerDown={beginQuadDrag("col")}
                  onMouseEnter={() => setHoverSplit("col")}
                  onMouseLeave={() => setHoverSplit(s => s === "col" ? null : s)}
                  title="Drag to resize columns"
                  style={{
                    position: "absolute", top: 0, bottom: 0, left: `${quadColSplit * 100}%`,
                    width: 8, marginLeft: -4, cursor: "col-resize", zIndex: 4,
                    display: "flex", justifyContent: "center",
                  }}
                >
                  <div style={{ width: 1, height: "100%", background: hoverSplit === "col" ? "rgba(230,224,216,0.55)" : "rgba(230,224,216,0.18)" }} />
                </div>
                <div
                  onPointerDown={beginQuadDrag("row")}
                  onMouseEnter={() => setHoverSplit("row")}
                  onMouseLeave={() => setHoverSplit(s => s === "row" ? null : s)}
                  title="Drag to resize rows"
                  style={{
                    position: "absolute", left: 0, right: 0, top: `${quadRowSplit * 100}%`,
                    height: 8, marginTop: -4, cursor: "row-resize", zIndex: 4,
                    display: "flex", alignItems: "center",
                  }}
                >
                  <div style={{ height: 1, width: "100%", background: hoverSplit === "row" ? "rgba(230,224,216,0.55)" : "rgba(230,224,216,0.18)" }} />
                </div>
                <div
                  onPointerDown={beginQuadDrag("both")}
                  onMouseEnter={() => setHoverSplit("both")}
                  onMouseLeave={() => setHoverSplit(s => s === "both" ? null : s)}
                  title="Drag to resize all panes"
                  style={{
                    position: "absolute", left: `${quadColSplit * 100}%`, top: `${quadRowSplit * 100}%`,
                    width: 14, height: 14, marginLeft: -7, marginTop: -7, cursor: "move", zIndex: 5,
                    borderRadius: 3, background: hoverSplit === "both" ? "rgba(73,66,60,0.95)" : "rgba(49,44,40,0.9)",
                    border: "1px solid #61584f",
                  }}
                />
              </>
            )}
          </div>
        ) : (
          // Non-quad mode: reserve the sidebar's width so the canvas paints in the remaining
          // region instead of under it. MapCanvas's ResizeObserver watches the canvas element
          // itself, so shrinking this wrapper's width is a resize, not a rewrite (see Sidebar.tsx
          // / CLAUDE.md's docked-sidebar layout note).
          <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, right: sidebarInsetPx }}>
            {mapPaneEl}
          </div>
        )}


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
          pinnedBlocks={pinnedBlocks}
          recentBlocks={recentBlocks}
          hotbarHover={hotbarHover}
          setPinnedBlocks={setPinnedBlocks}
          setHotbarHover={setHotbarHover}
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
          renderMode={renderMode}
          setRenderMode={setRenderMode}
          axoSkew={axoSkew}
          setAxoSkew={setAxoSkew}
          showSlicePanels={showSlicePanels}
          setShowSlicePanels={setShowSlicePanels}
          enable3dPane={enable3dPane}
          setEnable3dPane={setEnable3dPane}
          mode3d={mode3d}
          setMode3d={setMode3d}
          autoOrient3d={autoOrient3d}
          setAutoOrient3d={(v) => { setAutoOrient3d(v); saveSettingsDebounced({ autoOrient3d: v }); }}
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
          templateLoaded={templateLoaded}
          templatePath={templatePath}
          showTemplateOverlay={showTemplateOverlay}
          setShowTemplateOverlay={setShowTemplateOverlay}
          openTemplateFile={openTemplateFile}
          texturePackLoaded={texturePackInfo !== null}
          texturePackPath={texturePackPath}
          texturePack={texturePackInfo}
          openTexturePackFile={openTexturePackFile}
          unloadTexturePack={unloadTexturePack}
          spawnPos={spawnPos}
          onSetSpawnAtSelection={setSpawnAtSelection}
          onShowWorldInfo={() => setShowWorldInfo(true)}
          selection={selection}
          rawBounds={rawBounds}
          setRawBounds={setRawBounds}
          copySelection={copySelection}
          deleteBlocks={deleteBlocks}
          fillSelection={fillSelection}
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
          exporting={exporting}
          exportingObj={exportingObj}
          exportingJson={exportingJson}
          saveCompressed={saveCompressed}
          setSaveCompressed={setSaveCompressed}
          recentWorlds={recentWorlds}
          openFile={openFile}
          openFileAt={openFileAt}
          saveWorld={saveWorld}
          saveWorldAs={saveWorldAs}
          exportPng={exportPng}
          exportObj={exportObj}
          exportJson={exportJson}
          exportVmf={exportVmf}
          enableExperimentalExport={enableExperimentalExport}
          loadPrefab={loadPrefab}
          importSchematic={importSchematic}
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
          setShowNewWorld={setShowNewWorld}
          setShowWorldBrowser={setShowWorldBrowser}
          setShowUploadModal={setShowUploadModal}
          setShowExpandModal={setShowExpandModal}
          setExpandResult={setExpandResult}
          closeWorld={closeWorld}
          setShowHelp={setShowHelp}
          setShowAbout={setShowAbout}
          setShowSettings={setShowSettings}
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
          ribbonBodyHeight={ribbonBodyHeight}
          onBodyHeightChange={(h) => {
            const clamped = Math.max(60, Math.min(240, h));
            setRibbonBodyHeight(clamped);
            try { localStorage.setItem("ribbon_body_height", String(clamped)); } catch {}
          }}
        />


        {/* Docked right sidebar: Inspector / Prefabs / Elevation / History tabs — see Sidebar.tsx. */}
        <Sidebar
          open={sidebarOpen}
          onOpenChange={(v) => { setSidebarOpen(v); saveSettings({ sidebarOpen: v }); }}
          width={sidebarWidth}
          onWidthChange={(w) => { setSidebarWidth(w); saveSettingsDebounced({ sidebarWidth: w }); }}
          tab={sidebarTab}
          onTabChange={(t) => { setSidebarTab(t); saveSettings({ sidebarTab: t }); }}
          topPx={effectiveRibbonHeight}
          bottomPx={STATUS_BAR_HEIGHT}
          selection={selection}
          clipboard={clipboard}
          quadMode={showSlicePanels}
          onArmPaste={(info) => { setClipboard(info); setTool("paste"); }}
          onSavePrefabAs={savePrefabAs}
          prefabRefreshToken={prefabRefreshToken}
          elevationSelection={pastePreviewSelection ?? selection}
          maxZ={world.max_z}
          extrudeCount={pastePreviewSelection ? 0 : (extrudeOpen && extrudeCount > 0 ? extrudeCount : 0)}
          extrudeAxis={extrudeAxis}
          isPastePreview={pastePreviewSelection !== null}
          editEpoch={editEpoch}
          drawActive={["pen","brush","rect","ellipse"].includes(tool)}
          onDrawElevation={handleDrawElevation}
          onZRangeChange={pastePreviewSelection ? undefined : (zMin, zMax) => { setZMin(zMin); setZMax(zMax); }}
          worldEpoch={worldEpoch}
        />

        {prefabNameModal && (
          <Modal
            onClose={() => { if (!prefabSaving) setPrefabNameModal(false); }}
            label="Save prefab"
            zIndex={200}
            closeOnEsc={!prefabSaving}
            closeOnBackdrop={!prefabSaving}
          >
            <div style={glassPanel({ padding: 20, width: 360, display: "flex", flexDirection: "column", gap: 14, color: "#ebe9e7" })}>
              <div style={{ fontWeight: 700, color: EDEN_TEAL_READABLE, fontSize: 14 }}>Save Prefab</div>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "#afa69d" }}>
                Name
                <input
                  autoFocus
                  value={prefabNameInput}
                  onChange={(e) => { setPrefabNameInput(e.target.value); setPrefabOverwrite(false); }}
                  onKeyDown={(e) => { if (e.key === "Enter") confirmSavePrefab(); }}
                  style={{
                    background: "rgba(0,0,0,0.5)", border: "1px solid #4b443d", borderRadius: 5,
                    color: "#ebe9e7", padding: "7px 9px", fontSize: 13, outline: "none",
                  }}
                />
              </label>
              {prefabOverwrite ? (
                <div style={{ fontSize: 11, color: "#fbbf24" }}>
                  A prefab with this name already exists. Click Overwrite to replace it.
                </div>
              ) : (
                <div style={{ fontSize: 11, color: "#83786c" }}>
                  Saves to your prefab library and appears in the gallery.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                <button
                  onClick={() => { setPrefabNameModal(false); savePrefabAs(); }}
                  style={chromeButton({ padding: "6px 12px", fontSize: 12 })}
                >
                  Save As…
                </button>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => setPrefabNameModal(false)}
                  style={chromeButton({ padding: "6px 12px", fontSize: 12 })}
                >
                  Cancel
                </button>
                <button
                  onClick={confirmSavePrefab}
                  disabled={!prefabNameInput.trim() || prefabSaving}
                  style={chromeButton({
                    padding: "6px 14px", fontSize: 12,
                    ...accentRing(prefabOverwrite ? "#fbbf24" : "#4ade80"),
                    color: prefabOverwrite ? "#fcd34d" : "#86efac",
                    opacity: !prefabNameInput.trim() || prefabSaving ? 0.5 : 1,
                  })}
                >
                  {prefabSaving ? "Saving…" : prefabOverwrite ? "Overwrite" : "Save"}
                </button>
              </div>
            </div>
          </Modal>
        )}

        {(exporting || exportingObj || exportingJson || exportingVox || loading) && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.45)", zIndex: 200, pointerEvents: "none",
          }}>
            <div style={{
              background: "rgba(31,28,26,0.95)", border: "1px solid #4b443d",
              borderRadius: 10, padding: "20px 32px", minWidth: 220, textAlign: "center",
            }}>
              {exporting ? (
                <>
                  <div style={{ color: "#ebe9e7", fontSize: 14, marginBottom: 12 }}>
                    Exporting PNG… {exportProgress !== null ? `${Math.round(exportProgress * 100)}%` : ""}
                  </div>
                  <div style={{ background: "#312c28", borderRadius: 4, height: 6, overflow: "hidden", position: "relative" }}>
                    {exportProgress !== null ? (
                      <div style={{
                        background: "#f59e0b", height: "100%", borderRadius: 4,
                        width: `${Math.round(exportProgress * 100)}%`,
                        transition: "width 0.1s ease",
                      }} />
                    ) : (
                      <div style={{
                        position: "absolute", inset: 0, width: "30%",
                        background: "linear-gradient(90deg, transparent, #f59e0b, transparent)",
                        animation: "eden-shimmer 1.1s ease-in-out infinite",
                      }} />
                    )}
                  </div>
                </>
              ) : exportingObj ? (
                <div style={{ color: "#ebe9e7", fontSize: 14 }}>Exporting OBJ…</div>
              ) : exportingJson ? (
                <div style={{ color: "#ebe9e7", fontSize: 14 }}>Exporting JSON…</div>
              ) : exportingVox ? (
                <>
                  <div style={{ color: "#ebe9e7", fontSize: 14, marginBottom: 8 }}>
                    Exporting VOX… {voxProgress ? `${voxProgress.pct}%` : ""}
                  </div>
                  {voxProgress && (
                    <div style={{ color: "#afa69d", fontSize: 12, marginBottom: 8 }}>
                      {voxProgress.phase}
                    </div>
                  )}
                  <div style={{ background: "#312c28", borderRadius: 4, height: 6, overflow: "hidden" }}>
                    <div style={{
                      background: "#f59e0b", height: "100%", borderRadius: 4,
                      width: `${voxProgress?.pct ?? 0}%`,
                      transition: "width 0.15s ease",
                    }} />
                  </div>
                </>
              ) : (
                <div style={{ color: "#ebe9e7", fontSize: 14 }}>Loading world…</div>
              )}
            </div>
          </div>
        )}

        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
        {showAbout && <AboutModal version={appVersion} onClose={() => setShowAbout(false)} />}
        {showWorldInfo && <WorldInfoModal onClose={() => setShowWorldInfo(false)} />}
        {recoveryInfo && (
          <RecoveryModal info={recoveryInfo} recovering={recovering} onRecover={recoverAutosave} onDiscard={discardRecovery} onDismiss={dismissRecovery} />
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
        {showUploadModal && (
          <UploadModal
            sourcePath={sourcePath}
            onClose={() => setShowUploadModal(false)}
          />
        )}
        {vmfExportBounds && world && (
          <VmfExportModal
            worldName={world.name}
            bounds={vmfExportBounds}
            onClose={() => setVmfExportBounds(null)}
          />
        )}
        {showNewWorld && (
          <NewWorldModal
            onClose={() => setShowNewWorld(false)}
            onCreated={(path) => { setShowNewWorld(false); openFileAt(path); }}
          />
        )}
        {schematicInfo && schematicPath && (
          <SchematicImportModal
            info={schematicInfo}
            path={schematicPath}
            applying={schematicApplying}
            onApply={(mapping) => applySchematic(mapping)}
            onCancel={() => { setSchematicInfo(null); setSchematicPath(null); }}
          />
        )}

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

        {/* Expand from Template modal */}
        {showExpandModal && (
          <Modal
            onClose={() => setShowExpandModal(false)}
            zIndex={1000}
            labelledBy="expand-title"
            closeOnBackdrop={false}
            closeOnEsc={!expandInProgress}
            backdropStyle={{ background: "rgba(0,0,0,0.7)" }}
          >
            <div style={{
              background: "#1e1b18", border: "1px solid #71665c", borderRadius: 10,
              padding: "24px 28px", minWidth: 360, maxWidth: 440,
              boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
            }}>
              <div id="expand-title" style={{ fontSize: 15, fontWeight: 600, color: "#ebe9e7", marginBottom: 12 }}>
                Expand from Template
              </div>
              {!expandInProgress && expandResult === null && (
                <>
                  <div style={{ fontSize: 12, color: "#afa69d", marginBottom: 16, lineHeight: 1.5 }}>
                    Fills missing chunks from Eden.eden into a new world file. Your edits are preserved.
                    Output can be ~1 GB for the full template.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", color: "#ebe9e7", fontSize: 13 }}>
                      <input
                        type="radio" name="extentMode" checked={expandFullExtent}
                        onChange={() => setExpandFullExtent(true)}
                        style={{ accentColor: "#3b82f6" }}
                      />
                      Full world (180×180 chunks, ~1 GB)
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", color: "#ebe9e7", fontSize: 13 }}>
                      <input
                        type="radio" name="extentMode" checked={!expandFullExtent}
                        onChange={() => setExpandFullExtent(false)}
                        style={{ accentColor: "#3b82f6" }}
                      />
                      Within current world bounds only
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => setShowExpandModal(false)} style={{
                      padding: "6px 14px", borderRadius: 6, border: "1px solid #4b443d",
                      background: "transparent", color: "#afa69d", cursor: "pointer", fontSize: 13,
                    }}>
                      Cancel
                    </button>
                    <button onClick={runExpand} style={{
                      padding: "6px 14px", borderRadius: 6, border: "none",
                      background: "#1d4ed8", color: "#ebe9e7", cursor: "pointer", fontSize: 13,
                    }}>
                      Choose Output File & Expand
                    </button>
                  </div>
                </>
              )}
              {expandInProgress && (
                <>
                  <div style={{ fontSize: 12, color: "#afa69d", marginBottom: 12 }}>
                    Writing chunks… {expandProgress}%
                  </div>
                  <div style={{ background: "#312c28", borderRadius: 4, height: 8, overflow: "hidden", marginBottom: 12 }}>
                    <div style={{
                      height: "100%", background: "#3b82f6", borderRadius: 4,
                      width: `${expandProgress}%`, transition: "width 0.2s",
                    }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button onClick={cancelExpand} style={{
                      padding: "6px 14px", borderRadius: 6, border: "1px solid #4b443d",
                      background: "transparent", color: "#afa69d", cursor: "pointer", fontSize: 13,
                    }}>
                      Cancel
                    </button>
                  </div>
                </>
              )}
              {expandResult !== null && !expandInProgress && (
                <>
                  <div style={{ fontSize: 13, color: "#86efac", marginBottom: 16 }}>
                    Done — {expandResult.chunksAdded.toLocaleString()} chunks added
                    ({expandResult.totalChunks.toLocaleString()} total).
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => setShowExpandModal(false)} style={{
                      padding: "6px 14px", borderRadius: 6, border: "1px solid #4b443d",
                      background: "transparent", color: "#afa69d", cursor: "pointer", fontSize: 13,
                    }}>
                      Close
                    </button>
                  </div>
                </>
              )}
            </div>
          </Modal>
        )}

        {/* Map right-click context menu */}
        {ctxMenu && (() => {
          const close = () => setCtxMenu(null);
          const ic = (ch: string) => <span style={{ display: "inline-block", width: 18, textAlign: "center", color: "#83786c", flexShrink: 0 }}>{ch}</span>;
          const noIc = () => <span style={{ display: "inline-block", width: 18, flexShrink: 0 }} />;
          const miBtnStyle: React.CSSProperties = {
            display: "flex", alignItems: "center", gap: 0,
            width: "100%", textAlign: "left", background: "none", border: "none",
            color: "#ebe9e7", padding: "5px 12px 5px 8px", fontSize: 12, cursor: "pointer",
            whiteSpace: "nowrap",
          };
          const miHov = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = `rgba(${EDEN_TEAL},0.18)`; };
          const miLve = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = ""; };
          const div = <div style={{ height: 1, background: "#312c28", margin: "3px 0" }} />;
          return (
            <div
              ref={ctxMenuElRef}
              style={{
                position: "fixed", top: ctxMenu.y, left: ctxMenu.x, zIndex: 9000, minWidth: 210,
                padding: "4px 0",
                background: "linear-gradient(180deg, rgba(34,29,25,.95) 0%, rgba(20,17,14,.95) 100%)",
                backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
                border: "1px solid rgba(255,255,255,.12)",
                borderRadius: 6,
                boxShadow: `0 10px 28px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,.06), 0 0 0 1px rgba(${EDEN_TEAL},.15)`,
              }}
              onMouseDown={e => e.stopPropagation()}
              onContextMenu={e => e.preventDefault()}
            >
              <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); invoke<[number,number]>("set_spawn_pos", { px: Math.round(ctxMenu.wx), py: Math.round(ctxMenu.wy) }).then(([px, py]) => { setSpawnPos({ px, py }); setEditEpoch(e => e + 1); }).catch(e => reportError(e)); }}>
                {ic("⌂")} Set Spawn Here
              </button>
              {div}
              {rawBounds && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); copySelection(); }}>
                {ic("⊡")} Copy
              </button>}
              {clipboard && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); setLockedPastePos({ x: Math.round(ctxMenu.wx), y: Math.round(ctxMenu.wy) }); setTool("paste"); }}>
                {ic("⊞")} Paste Here
              </button>}
              {rawBounds && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); fillSelection(); }}>
                {noIc()} Fill Selection
              </button>}
              {rawBounds && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); deleteBlocks(); }}>
                {noIc()} Delete Blocks
              </button>}
              {rawBounds && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); setRawBounds(null); }}>
                {ic("✕")} Clear Selection
              </button>}
              {showSlicePanels && enable3dPane && <>{div}
                <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                  onClick={() => { close(); flyView3dRef.current?.teleport(ctxMenu.wx, ctxMenu.wy); }}>
                  {noIc()} Teleport 3D Camera Here
                </button>
                {cam3dPos && <button style={miBtnStyle} onMouseEnter={miHov} onMouseLeave={miLve}
                  onClick={() => { close(); mapCanvasRef.current?.centerOn(cam3dPos.x, cam3dPos.y); }}>
                  {noIc()} Center Map on 3D Camera
                </button>}
              </>}
              {div}
              <button style={{ ...miBtnStyle, color: tool === "select" ? "#93c5fd" : "#ebe9e7" }} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); setTool("select"); }}>
                {noIc()} Select Tool
              </button>
              <button style={{ ...miBtnStyle, color: tool === "pen" ? "#f9a8d4" : "#ebe9e7" }} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); setTool("pen"); }}>
                {noIc()} Pen Tool
              </button>
              <button style={{ ...miBtnStyle, color: tool === "pan" ? "#93c5fd" : "#ebe9e7" }} onMouseEnter={miHov} onMouseLeave={miLve}
                onClick={() => { close(); setTool("pan"); }}>
                {noIc()} Pan Tool
              </button>
            </div>
          );
        })()}

        {/* Quick Actions — floating bar under the ribbon. ⚠️ Must stay inside the `world` branch:
            App has a second return for the splash screen, where this would never render. */}
        {showQuickActions && (
          <QuickActionsBar
            top={effectiveRibbonHeight + 8}
            rightInset={sidebarInsetPx}
            rawBounds={rawBounds}
            clipboard={clipboard}
            onCopy={copySelection}
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
            onMore={() => ribbonTabSetterRef.current?.("selection")}
          />
        )}

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
                      : "linear-gradient(180deg, rgb(36,33,30) 0%, rgb(23,21,19) 100%)",
                    boxShadow: `inset 0 1px 0 rgba(255,255,255,.06), 0 8px 20px rgba(0,0,0,.4), 0 0 0 1px ${isErr ? "rgba(248,113,113,.45)" : `rgba(${EDEN_TEAL},.25)`}`,
                    color: isErr ? "#fca5a5" : "#ebe9e7",
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
                        background: "none", border: "none", color: "#fca5a5", cursor: "pointer",
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
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", height: "100vh",
      background: `radial-gradient(600px 240px at 50% 0%, rgba(${EDEN_TEAL},.16) 0%, rgba(0,0,0,0) 100%), #130f0c`,
    }}>
      {/* Left panel */}
      <div style={{
        width: 560, minWidth: 400, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", padding: "48px 56px",
        gap: 0, background: "linear-gradient(180deg, rgb(36,33,30) 0%, rgb(24,20,17) 100%)",
        boxShadow: "inset -1px 0 0 rgba(255,255,255,.05), inset 0 0 40px rgba(0,0,0,.35)",
      }}>
        {/* App icon */}
        <img
          src={appIcon}
          alt="VuencEdit"
          style={{
            width: 120, height: 120, borderRadius: 24, marginBottom: 20, imageRendering: "pixelated",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12), 0 8px 24px rgba(0,0,0,.5)",
          }}
        />
        {/* Title */}
        <div style={{ fontSize: 36, letterSpacing: -0.5, lineHeight: 1 }}>
          <span style={{ fontWeight: 800, color: "#ffffff", textShadow: "0 -1px 0 rgba(0,0,0,.5)" }}>Vuenc</span>
          <span style={{ fontWeight: 400, color: EDEN_TEAL_READABLE, textShadow: "0 -1px 0 rgba(0,0,0,.5)" }}>Edit</span>
        </div>
        <div style={{ fontSize: 13, color: "#625a51", marginBottom: 28, marginTop: 6 }}>v{appVersion}</div>

        {/* Action buttons */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 480 }}>
          {/* New World */}
          <button
            onClick={() => setShowNewWorld(true)}
            disabled={loading}
            style={{
              display: "flex", alignItems: "center", gap: 16,
              background: "linear-gradient(180deg, rgba(74,222,128,0.22) 0%, rgba(74,222,128,0.06) 100%)",
              border: "none", boxShadow: "inset 0 0 0 1px rgba(74,222,128,.4), 0 .5px .5px rgba(255,255,255,.12)",
              borderRadius: 10, padding: "14px 20px",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1, textAlign: "left", width: "100%",
            }}
          >
            <span style={{ fontSize: 28, lineHeight: 1 }}>✏️</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#ebe9e7" }}>New World</div>
              <div style={{ fontSize: 13, color: "#afa69d", marginTop: 2 }}>Create a new world file</div>
            </div>
          </button>

          {/* Open World */}
          <button
            onClick={openFile}
            disabled={loading}
            style={{
              display: "flex", alignItems: "center", gap: 16,
              background: "linear-gradient(180deg, rgb(46,58,82) 0%, rgb(26,34,52) 100%)",
              border: "none", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.5), 0 .5px .5px rgba(255,255,255,.15)",
              borderRadius: 10, padding: "14px 20px",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1, textAlign: "left", width: "100%",
            }}
          >
            <span style={{ fontSize: 28, lineHeight: 1 }}>🗂️</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#ebe9e7" }}>
                {loading ? "Loading…" : "Open World"}
              </div>
              <div style={{ fontSize: 13, color: "#afa69d", marginTop: 2 }}>Open a local world file</div>
            </div>
          </button>

          {/* Browse Worlds */}
          <button
            onClick={() => setShowWorldBrowser(true)}
            disabled={loading}
            style={{
              display: "flex", alignItems: "center", gap: 16,
              background: "linear-gradient(180deg, rgb(46,58,82) 0%, rgb(26,34,52) 100%)",
              border: "none", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.5), 0 .5px .5px rgba(255,255,255,.15)",
              borderRadius: 10, padding: "14px 20px",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1, textAlign: "left", width: "100%",
            }}
          >
            <span style={{ fontSize: 28, lineHeight: 1 }}>🔍</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#ebe9e7" }}>Browse Worlds</div>
              <div style={{ fontSize: 13, color: "#afa69d", marginTop: 2 }}>Browse shared worlds</div>
            </div>
          </button>

          {/* Settings */}
          <button
            onClick={() => setShowSettings(true)}
            style={{
              display: "flex", alignItems: "center", gap: 14,
              background: "none", border: "none",
              boxShadow: "inset 0 0 0 1px #2d2824",
              borderRadius: 8, padding: "9px 16px",
              cursor: "pointer", textAlign: "left", width: "100%",
              color: "#83786c", transition: "box-shadow .1s, color .1s",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = `inset 0 0 0 1px rgba(${EDEN_TEAL},.5)`; (e.currentTarget as HTMLElement).style.color = EDEN_TEAL_READABLE; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = "inset 0 0 0 1px #2d2824"; (e.currentTarget as HTMLElement).style.color = "#83786c"; }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>⚙</span>
            <span style={{ fontSize: 13 }}>Settings</span>
          </button>
        </div>

        {error && (
          <p style={{ color: "#f87171", fontSize: 13, maxWidth: 420, textAlign: "center", marginTop: 16 }}>
            {error}
          </p>
        )}

        {/* Attribution footer */}
        <div style={{
          marginTop: "auto", paddingTop: 20, borderTop: "1px solid #2d2824",
          fontSize: 11, color: "#625a51", lineHeight: 1.6, textAlign: "center",
          width: "100%", maxWidth: 480,
        }}>
          <p style={{ margin: "0 0 4px" }}>
            Based on{" "}
            <SplashLink href="https://github.com/jldeiro/EdenWorldManipulator2.0">Eden World Manipulator</SplashLink>
            {" "}and{" "}
            <SplashLink href="https://github.com/bLUUBfACE/EdenWorldManipulator">Vuenctools</SplashLink>.
            Docs by{" "}
            <SplashLink href="https://mrob.com/pub/vidgames/eden-file-format.html">Robert Munafo</SplashLink>.
          </p>
          <p style={{ margin: "0 0 8px" }}>
            Eden World Builder by Ari Ronen (open source 2018). Support:{" "}
            <SplashLink href="https://discord.com/invite/rjYXwBC">Discord</SplashLink>.
          </p>
          <button
            onClick={() => setShowAbout(true)}
            style={{
              background: "none", border: "none", color: "#625a51",
              fontSize: 11, cursor: "pointer", padding: 0, textDecoration: "underline",
            }}
            onMouseEnter={e => (e.currentTarget.style.color = EDEN_TEAL_READABLE)}
            onMouseLeave={e => (e.currentTarget.style.color = "#625a51")}
          >
            About VuencEdit…
          </button>
        </div>
      </div>

      {showAbout && <AboutModal version={appVersion} onClose={() => setShowAbout(false)} />}
      {recoveryInfo && (
        <RecoveryModal info={recoveryInfo} recovering={recovering} onRecover={recoverAutosave} onDiscard={discardRecovery} onDismiss={dismissRecovery} />
      )}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSave={applySettings}
        />
      )}

      {/* Right panel — recent worlds */}
      <div style={{
        flex: 1, display: "flex", flexDirection: "column", overflow: "hidden",
        background: "linear-gradient(180deg, rgb(34,29,25) 0%, rgb(24,20,17) 100%)",
      }}>
        <div style={{ padding: "20px 24px 10px", borderBottom: "1px solid #2d2824", boxShadow: "inset 0 1px 0 rgba(255,255,255,.04)" }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: "#625a51", textTransform: "uppercase" }}>
            Recent Worlds
          </span>
        </div>
        {recentWorlds.length === 0 ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#625a51", fontSize: 15 }}>No Recent Worlds</span>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: "auto" }}>
            {recentWorlds.map((r, i) => (
              <button
                key={r.path}
                onClick={() => { if (!loading) openFileAt(r.path); }}
                disabled={loading}
                style={{
                  display: "flex", alignItems: "center", gap: 14,
                  width: "100%", textAlign: "left", background: "none",
                  border: "none", borderBottom: i < recentWorlds.length - 1 ? "1px solid #2d2824" : "none",
                  padding: "14px 24px", cursor: loading ? "not-allowed" : "pointer",
                  opacity: loading ? 0.5 : 1,
                }}
                onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLElement).style.background = `rgba(${EDEN_TEAL},0.10)`; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "none"; }}
                title={r.path}
              >
                <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>🌍</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#ebe9e7", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.name}
                  </div>
                  <div style={{ fontSize: 11, color: "#625a51", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" }}>
                    {r.path}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: "#61584f", flexShrink: 0 }}>{timeAgo(r.timestamp)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {showWorldBrowser && (
        <WorldBrowserModal
          onClose={() => setShowWorldBrowser(false)}
          onOpenWorld={(path) => { setShowWorldBrowser(false); openFileAt(path); }}
        />
      )}
      {showNewWorld && (
        <NewWorldModal
          onClose={() => setShowNewWorld(false)}
          onCreated={(path) => { setShowNewWorld(false); openFileAt(path); }}
        />
      )}
    </div>
  );
}

export default App;
