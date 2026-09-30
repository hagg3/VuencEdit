import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { MODAL_TEXT } from "./designTokens";
import { fmtBytes } from "./formatBytes";
import { formatHistogram, approxPercentile, perfCounters, resetPerfCounters, RELOAD_REASONS } from "./perfCounters";
import type { GpuInfo, PerfSnapshot } from "./FlyView3D";
import type { WorldMeta } from "./types";
import Dialog, { DialogButton } from "./ui/Dialog";

/**
 * `Help ▸ Diagnostics…` — ROADMAP-EDIT Stage 9.5. The plain-text report a confused user pastes
 * into a bug report, per `TEST WORLDS/windows-3d-lag-report-2026-09-14.md` §0: the shipped build
 * had no readout at all for RSS, page faults, GPU identity, or fetch/frame latency, so a report
 * like "it lags and I get a white screen" could not be triaged past guessing. Read that doc and
 * its design companion (`TEST WORLDS/diagnostics-panel-plan-2026-09-14.md`) before changing what
 * this collects — in particular the privacy rule (basenames and sizes, never full paths) and the
 * "sampled on demand, never on a timer" rule (a diagnostic must never itself be a perf problem).
 */

interface MemStatsJson {
  os: string;
  arch: string;
  process: { workingSetBytes: number; peakWorkingSetBytes: number; pageFaultCount: number };
  system: { totalBytes: number; availableBytes: number };
  platform: {
    memoryPressureLevel: number;
    swapUsedBytes: number;
    swapTotalBytes: number;
    commitUsedBytes: number;
    commitLimitBytes: number;
    onAcPower: boolean | null;
    batteryPercent: number | null;
    batterySaver: boolean | null;
  };
  worldLoaded: boolean;
  worldBytes: number;
  chunkSize: number;
  numBands: number;
  wChunks: number;
  hChunks: number;
  worldVersion: number;
  undoBytes: number;
  redoBytes: number;
  undoGroups: number;
  redoGroups: number;
  undoBudget: number;
  clipboardBytes: number;
  selectionMaskBytes: number;
  overviewBytes: number;
  overviewGranularity: number;
  overviewServed: number;
  overviewScanned: number;
  overviewBudget: number;
  peaks: {
    editPreimageBytes: PeakPair;
    editDeltaBytes: PeakPair;
    sculptScratchBytes: PeakPair;
    previewScanBytes: PeakPair;
    clipboardOpBytes: PeakPair;
    autosaveBytes: PeakPair;
    autosaveMs: PeakPair;
    autosaveCompactions: number;
    saveKind: string;
    saveBytes: PeakPair;
    saveMs: PeakPair;
  };
}

/** Stage 18.0 counter: most recent occurrence and session high-water mark. */
interface PeakPair { last: number; max: number }

interface Props {
  onClose: () => void;
  appVersion: string;
  /** Full path to the loaded world's source file, or null. Only its **basename** ever reaches the
   *  report — a full path leaks a Windows username (see the design doc's privacy note). */
  sourcePath: string | null;
  world: WorldMeta | null;
  templatePath: string | null;
  texturePackPath: string | null;
  prefabDirectory: string | null;
  showPerfHud: boolean;
  memoryBudget: string;
  /** Where the 3D view lives: the main pane (swapped) or its floating window. */
  viewHost: "main" | "window";
  /** Reads the 3D pane's own already-live WebGL context — never allocates one. Returns null if the
   *  pane has never mounted (e.g. the 3D window never opened this whole session). */
  getGpuInfo: () => GpuInfo | null;
  getPerfSnapshot: () => PerfSnapshot | null;
}

/** basename only, by design — see the module doc's privacy note. Handles both path separators
 *  since a Windows path never appears in a report generated on macOS/Linux dev machines either. */
export function basenameOnly(p: string | null | undefined): string {
  if (!p) return "(none)";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function line(label: string, value: string | number | boolean): string {
  return `${label}: ${value}`;
}

function buildReport(a: {
  appVersion: string;
  sourcePath: string | null;
  world: WorldMeta | null;
  templatePath: string | null;
  texturePackPath: string | null;
  prefabDirectory: string | null;
  showPerfHud: boolean;
  memoryBudget: string;
  viewHost: "main" | "window";
  mem: MemStatsJson | null;
  gpu: GpuInfo | null;
  perf: PerfSnapshot | null;
}): string {
  const { appVersion, sourcePath, world, templatePath, texturePackPath, prefabDirectory,
    showPerfHud, memoryBudget, viewHost, mem, gpu, perf } = a;
  const out: string[] = [];
  out.push(`VuencEdit diagnostics ${appVersion} ${new Date().toISOString()}`);
  out.push(line("Build", `${import.meta.env.DEV ? "dev" : "release"} ${typeof __GIT_HASH__ !== "undefined" ? __GIT_HASH__ : "unknown"}`));
  const now = performance.now();
  out.push(line("Session uptime", fmtDuration(now - perfCounters.startedAt)));
  out.push(line("Counters sampled for", `${fmtDuration(now - perfCounters.resetAt)} (since start or last reset)`));
  out.push("");

  out.push("[Environment]");
  out.push(line("OS", mem ? `${mem.os} (${mem.arch})` : "unknown"));
  out.push(line("User agent", navigator.userAgent));
  out.push(line("Hardware concurrency", navigator.hardwareConcurrency ?? "unknown"));
  // deviceMemory is Chromium-only (undefined on WKWebView) — report that distinction rather than 0.
  const devMem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  out.push(line("Device memory (approx, Chromium only)", devMem != null ? `${devMem} GB` : "unavailable"));
  out.push(line("Device pixel ratio", window.devicePixelRatio));
  out.push(line("Window size", `${window.innerWidth}x${window.innerHeight}`));
  if (mem) {
    out.push(line("System RAM total", fmtBytes(mem.system.totalBytes)));
    out.push(line("System RAM available", mem.system.availableBytes > 0 ? fmtBytes(mem.system.availableBytes) : "unknown"));
  }
  if (mem) {
    const p = mem.platform;
    if (mem.os === "macos") {
      const level = { 1: "normal", 2: "warn", 4: "critical" }[p.memoryPressureLevel as 1 | 2 | 4];
      out.push(line("Memory pressure", level ?? "unknown"));
      out.push(line("Swap used / total", p.swapTotalBytes > 0 ? `${fmtBytes(p.swapUsedBytes)} / ${fmtBytes(p.swapTotalBytes)}` : "unknown"));
    }
    if (mem.os === "windows") {
      out.push(line("Commit used / limit", p.commitLimitBytes > 0 ? `${fmtBytes(p.commitUsedBytes)} / ${fmtBytes(p.commitLimitBytes)}` : "unknown"));
      out.push(line("Power", p.onAcPower == null ? "unknown" : p.onAcPower ? "AC" : "battery"));
      out.push(line("Battery", p.batteryPercent != null ? `${p.batteryPercent}%` : "none / unknown"));
      out.push(line("Battery Saver", p.batterySaver == null ? "unknown" : p.batterySaver ? "ON" : "off"));
    }
  }
  out.push(line("GPU vendor", gpu?.vendor ?? "unknown (3D pane never opened this session)"));
  out.push(line("GPU renderer", gpu?.renderer ?? "unknown (3D pane never opened this session)"));
  out.push(line("Software rendering", gpu ? String(gpu.softwareRendering) : "unknown"));
  out.push("");

  out.push("[Process memory]");
  if (mem) {
    out.push(line("Working set / RSS", fmtBytes(mem.process.workingSetBytes)));
    out.push(line("Peak working set", fmtBytes(mem.process.peakWorkingSetBytes)));
    out.push(line("Page faults (cumulative)", mem.process.pageFaultCount));
  } else {
    out.push("(unavailable — mem_stats did not respond)");
  }
  out.push("");

  out.push("[World]");
  out.push(line("Loaded", mem?.worldLoaded ? "yes" : "no"));
  if (mem?.worldLoaded) {
    out.push(line("File (name only)", basenameOnly(sourcePath)));
    out.push(line("Size", fmtBytes(mem.worldBytes)));
    out.push(line("Chunk size / bands", `${mem.chunkSize} B / ${mem.numBands}`));
    out.push(line("Dimensions", `${mem.wChunks} x ${mem.hChunks} chunks`));
    out.push(line("Header version", mem.worldVersion));
    if (world) out.push(line("Max Z", world.max_z));
    out.push(line("Undo bytes / groups", `${fmtBytes(mem.undoBytes)} / ${mem.undoGroups}`));
    out.push(line("Redo bytes / groups", `${fmtBytes(mem.redoBytes)} / ${mem.redoGroups}`));
    out.push(line("Undo budget", fmtBytes(mem.undoBudget)));
    out.push(line("Overview raster", mem.overviewGranularity > 0
      ? `${fmtBytes(mem.overviewBytes)} at g=${mem.overviewGranularity} (budget ${fmtBytes(mem.overviewBudget)}), ${mem.overviewServed.toLocaleString("en-US")} samples served / ${mem.overviewScanned.toLocaleString("en-US")} scanned`
      : `not built (budget ${fmtBytes(mem.overviewBudget)})`));
    // Stage 18.0 peak counters — `last / max` since launch. They attribute a working-set spike to
    // an operation, which the process peak above cannot.
    const pk = mem.peaks;
    const pair = (p: PeakPair, f: (n: number) => string) => `${f(p.last)} / ${f(p.max)}`;
    const ms = (n: number) => `${n} ms`;
    out.push("");
    out.push("[Peak counters (last / max)]");
    out.push(line("Clipboard / selection mask (live)", `${fmtBytes(mem.clipboardBytes)} / ${fmtBytes(mem.selectionMaskBytes)}`));
    out.push(line("Clipboard op transient", pair(pk.clipboardOpBytes, fmtBytes)));
    out.push(line("Edit pre-image", pair(pk.editPreimageBytes, fmtBytes)));
    out.push(line("Edit undo delta kept", pair(pk.editDeltaBytes, fmtBytes)));
    out.push(line("Sculpt scratch per flush", pair(pk.sculptScratchBytes, fmtBytes)));
    out.push(line("Preview scan buffer", pair(pk.previewScanBytes, fmtBytes)));
    out.push(line("Autosave tick bytes / ms", `${pair(pk.autosaveBytes, fmtBytes)} / ${pair(pk.autosaveMs, ms)}`));
    out.push(line("Autosave compactions", pk.autosaveCompactions));
    out.push(line("Last save kind / bytes / ms", `${pk.saveKind} / ${pair(pk.saveBytes, fmtBytes)} / ${pair(pk.saveMs, ms)}`));
  }
  out.push(line("Memory preset", memoryBudget));
  out.push(line("Template loaded", templatePath ? "set" : "not set"));
  out.push(line("Texture pack loaded", texturePackPath ? "set" : "not set"));
  out.push(line("Prefab directory", prefabDirectory ? "set (custom)" : "not set (default)"));
  out.push("");

  out.push("[3D pane]");
  out.push(line("Performance HUD enabled", showPerfHud));
  if (perf) {
    out.push(line("Resident chunks (meshes + empty markers)", perf.chunks));
    out.push(line("Resident geometry (installed in scene)", fmtBytes(perf.residentBytes)));
    out.push(line("Resident geometry (JS-side arrays not yet released)", fmtBytes(perf.jsBytes)));
    out.push(line("In-flight fetch reservation", fmtBytes(perf.inflightBytes)));
    out.push(line("Peak (resident + JS + in-flight; may double-count until upload release)", fmtBytes(perf.peakBytes)));
    out.push(line("Largest single chunk seen", fmtBytes(perf.maxChunkBytes)));
    out.push(line("Geometry budget (in force)", fmtBytes(perf.budgetBytes)));
    if (perf.budgetBytes !== perf.configuredBudgetBytes) {
      // Stage 10.1: the streaming gates are running under a halved budget because of a recovered
      // context loss, so the preset alone would misexplain what the pane is doing.
      out.push(line("Geometry budget (configured)", `${fmtBytes(perf.configuredBudgetBytes)} — reduced by context-loss back-off`));
    }
    out.push(line("Render distance (chunks)", perf.loadRadius));
    out.push(line("Camera Z band ceiling", perf.zBand ?? "none (whole world height)"));
    out.push(line("Context losses recovered", perf.contextLossCount));
    out.push(line("3D pane disabled by back-off", perf.contextDisabled));
    const st = perf.state;
    out.push(line("3D host", `${viewHost} (canvas ${st.canvasPx} px, suspended: ${st.suspended})`));
    out.push(line("Camera / interact mode", `${st.camMode} / ${st.interact3d}`));
    out.push(line("Lighting", `night ${st.night}, baked shadows ${st.shadows}, GPU shadows ${st.gpuShadows}, profile ${st.lightingProfile}`));
    out.push(line("Cutaway cap", st.cutaway ?? "off"));
    out.push(line("Texture pack applied", st.texturePack));
  } else {
    out.push("(the 3D pane has never mounted this session)");
  }
  const usedJsHeap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  out.push(line("JS heap in use (Chromium only)", usedJsHeap != null ? fmtBytes(usedJsHeap) : "unavailable"));
  out.push("");

  out.push("[Latency histograms]");
  out.push("(Always sampled. Buckets are cumulative since start or the last Reset counters. Frame/interval buckets show the fps they imply.)");
  out.push(`get_chunk_geometry round-trip: ${formatHistogram(perfCounters.geometryFetchMs)}`);
  const gp50 = approxPercentile(perfCounters.geometryFetchMs, 0.5);
  const gp95 = approxPercentile(perfCounters.geometryFetchMs, 0.95);
  out.push(line("  approx p50 / p95", `${gp50 ?? "n/a"} ms / ${gp95 ?? "n/a"} ms`));
  out.push(`fetch_tile round-trip: ${formatHistogram(perfCounters.tileFetchMs)}`);
  const tp50 = approxPercentile(perfCounters.tileFetchMs, 0.5);
  const tp95 = approxPercentile(perfCounters.tileFetchMs, 0.95);
  out.push(line("  approx p50 / p95", `${tp50 ?? "n/a"} ms / ${tp95 ?? "n/a"} ms`));
  out.push(`3D frame interval (continuous frames only): ${formatHistogram(perfCounters.frameMs, true)}`);
  out.push(`3D renderer.render() CPU cost: ${formatHistogram(perfCounters.renderMs)}`);
  out.push(`Page rAF interval: ${formatHistogram(perfCounters.rafMs, true)}`);
  out.push(`Event-loop lag (250 ms timer drift): ${formatHistogram(perfCounters.lagMs)}`);
  out.push(`MapCanvas.draw() tile blit: ${formatHistogram(perfCounters.mapDrawMs)}`);
  out.push("");

  out.push("[Counters]");
  out.push(line("Chunk fetches issued", perfCounters.chunkFetchesIssued));
  out.push(line("Chunk fetches dropped (stale)", perfCounters.chunkFetchesDroppedStale));
  out.push(line("Chunk fetches errored", perfCounters.chunkFetchesErrored));
  out.push(line("WebGL context losses", perfCounters.contextLosses));
  out.push(line("Geometry-budget-limited transitions", perfCounters.budgetLimitedTransitions));
  out.push(line("reloadAllChunks by reason", RELOAD_REASONS.map(r => `${r}=${perfCounters.reloads[r]}`).join(" ")));
  out.push(line("Draw calls (last / max)", `${perfCounters.drawCallsLast} / ${perfCounters.drawCallsMax}`));
  out.push(line("Visible meshes (last / max)", `${perfCounters.visibleMeshesLast} / ${perfCounters.visibleMeshesMax}`));
  out.push(line("3D scene frames", perfCounters.sceneFrames));
  out.push(line("FlyView3D React renders", perfCounters.flyRenders));
  out.push(line("App React renders", perfCounters.appRenders));
  out.push(line("Edits applied", perfCounters.editsApplied));
  out.push(line("MapCanvas.draw() calls", perfCounters.mapDraws));
  const lods = Object.entries(perfCounters.tilesByLod).map(([l, n]) => `LOD${l}=${n}`).join(" ");
  out.push(line("Visible map tiles by LOD (last draw)", lods || "none"));

  return out.join("\n");
}

export default function DiagnosticsModal(props: Props) {
  const { onClose, getGpuInfo, getPerfSnapshot } = props;
  const [mem, setMem] = useState<MemStatsJson | null>(null);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [saveState, setSaveState] = useState<"idle" | "saved" | "failed">("idle");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(() => {
    invoke<MemStatsJson>("mem_stats").then(setMem).catch(() => setMem(null));
    setGpu(getGpuInfo());
    setPerf(getPerfSnapshot());
    setCopyState("idle");
    setSaveState("idle");
  }, [getGpuInfo, getPerfSnapshot]);

  // Environment (§1a) is captured once at first open, per the plan — everything else refreshes.
  useEffect(() => { refresh(); }, [refresh]);

  const report = useMemo(() => buildReport({ ...props, mem, gpu, perf }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mem, gpu, perf, props.appVersion, props.sourcePath, props.world, props.showPerfHud, props.memoryBudget, props.viewHost]);

  const doReset = () => { resetPerfCounters(); refresh(); };

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopyState("copied");
    } catch {
      // Clipboard access can be refused depending on the webview's secure-context handling —
      // fall back silently to select-all on the textarea so Ctrl+C still works.
      textareaRef.current?.focus();
      textareaRef.current?.select();
      setCopyState("failed");
    }
  };

  const doSaveAs = async () => {
    try {
      const path = await save({
        defaultPath: "vuencedit-diagnostics.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!path) return;
      await invoke("write_text_file", { path, contents: report });
      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  };

  return (
    <Dialog
      size="md" icon="fps" title="Diagnostics" onClose={onClose}
      footer={
        <>
          <DialogButton onClick={doCopy}>
            {copyState === "copied" ? "Copied!" : copyState === "failed" ? "Select below (Ctrl/⌘+C)" : "Copy to clipboard"}
          </DialogButton>
          <DialogButton variant="primary" onClick={onClose}>Close</DialogButton>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 8 }}>
        <div style={{ fontSize: 12, color: MODAL_TEXT.secondary, lineHeight: 1.5 }}>
          A plain-text snapshot of this session's memory/GPU/latency numbers — paste it into a bug
          report. Nothing here is sent anywhere automatically. World paths are reported as
          filenames only, never full paths; no world contents are included.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <DialogButton onClick={refresh}>Refresh</DialogButton>
          <DialogButton onClick={doReset}>Reset counters</DialogButton>
          <DialogButton onClick={doSaveAs}>
            {saveState === "saved" ? "Saved!" : saveState === "failed" ? "Save failed" : "Save as .txt…"}
          </DialogButton>
        </div>
        <textarea
          ref={textareaRef}
          readOnly
          value={report}
          style={{
            flex: 1, minHeight: 0,
            fontFamily: "ui-monospace, 'SF Mono', monospace", fontSize: 11.5, lineHeight: 1.5,
            background: "rgba(0,0,0,0.25)", color: MODAL_TEXT.primary,
            border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: 10,
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>
    </Dialog>
  );
}
