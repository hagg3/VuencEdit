/**
 * Latency histograms + counters backing the Diagnostics panel (ROADMAP-EDIT Stage 9.4).
 *
 * **Fixed log-ish buckets, never a per-event log** — a ring buffer of individual timings is the
 * thing that turns a diagnostic into a leak (`TEST WORLDS/diagnostics-panel-plan-2026-09-14.md`
 * §1d). Every counter here is a plain integer increment on a call site that already measures time
 * (`performance.now()` around an existing `invoke`, or the frame loop's own `dt`), gated on
 * {@link perfCounters}.enabled so a diagnostic that is off costs one boolean read, not the
 * increment. As of Stage 17.1 sampling is **always on** (`enabled` defaults true and no longer follows
 * the HUD toggle): the cost is a few integer increments per frame, and a report taken after the
 * fact is worthless if it needed the switch pre-armed. Reset only ever zeroes; nothing here retains history beyond the 12 buckets.
 */

/** Bucket upper bounds in ms — `<1, <2, <4, ..., <1024, >=1024`, 12 buckets total. */
export const HISTOGRAM_BUCKET_MS: readonly number[] =
  [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, Infinity];

export function newHistogram(): Uint32Array {
  return new Uint32Array(HISTOGRAM_BUCKET_MS.length);
}

/** Which bucket a duration falls in. Exported (not just used internally) so it has its own test —
 *  the bucketing is the one piece of this file worth pinning independent of any component. */
export function bucketIndexForMs(ms: number): number {
  for (let i = 0; i < HISTOGRAM_BUCKET_MS.length; i++) {
    if (ms < HISTOGRAM_BUCKET_MS[i]) return i;
  }
  return HISTOGRAM_BUCKET_MS.length - 1;
}

/** Render a histogram as one compact line for the plain-text diagnostics report. */
export function formatHistogram(hist: Uint32Array, withFps = false): string {
  // `withFps` (frame/interval histograms): a `<Nms` bucket means >1000/N fps, so print that next to
  // the edge — the log-2 edges don't line up with 60/30 Hz vsync steps, and this saves the reader
  // doing the division. The top bucket is spelled "≥1024ms", never "Infinity".
  return HISTOGRAM_BUCKET_MS
    .map((b, i) => {
      const label = b === Infinity ? ">=1024ms" : "<" + b + "ms" + (withFps ? `(>${Math.round(1000 / b)}fps)` : "");
      return `${label}=${hist[i]}`;
    })
    .join(" ");
}

/** Rough percentile off the bucket boundaries — good enough for "is this disk-bound or not" at a
 *  glance; not a substitute for the full histogram, which the report also includes verbatim. */
export function approxPercentile(hist: Uint32Array, p: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const target = total * p;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= target) return HISTOGRAM_BUCKET_MS[i];
  }
  return HISTOGRAM_BUCKET_MS[hist.length - 1];
}

/** Why a whole-disc `reloadAllChunks` ran (17.1), so a restream storm can be attributed. */
export const RELOAD_REASONS = ["tex", "light", "gpuShadows", "cap", "resume", "band", "restore"] as const;
export type ReloadReason = typeof RELOAD_REASONS[number];

export interface PerfCounters {
  /** Master gate. Defaults **true** (17.1) — only tests turn it off. */
  enabled: boolean;
  geometryFetchMs: Uint32Array;
  tileFetchMs: Uint32Array;
  /** 3D frame *interval*, continuous frames only (9.7): idle gaps before an `invalidate()` are not frames. */
  frameMs: Uint32Array;
  /** CPU ms inside `renderer.render()` — separates draw-submission cost from the interval. */
  renderMs: Uint32Array;
  /** Page-level rAF interval (App's FpsCounter loop) — high with a busy thread, ~33 ms when throttled. */
  rafMs: Uint32Array;
  /** Drift of a 250 ms timer: high = busy main thread, low with slow rAF = throttled. */
  lagMs: Uint32Array;
  /** `MapCanvas.draw()` duration. */
  mapDrawMs: Uint32Array;
  reloads: Record<ReloadReason, number>;
  flyRenders: number;
  appRenders: number;
  editsApplied: number;
  mapDraws: number;
  sceneFrames: number;
  /** Last frame / running max draw calls and visible meshes (`renderer.info`). */
  drawCallsLast: number; drawCallsMax: number;
  visibleMeshesLast: number; visibleMeshesMax: number;
  /** Visible cached tiles by LOD as of the last `MapCanvas.draw()`, keyed by LOD. */
  tilesByLod: Record<number, number>;
  /** `performance.now()` at module load and at the last reset — for uptime / time-since-reset. */
  startedAt: number;
  resetAt: number;
  chunkFetchesIssued: number;
  chunkFetchesDroppedStale: number;
  chunkFetchesErrored: number;
  contextLosses: number;
  budgetLimitedTransitions: number;
  longOpCount: number;
}

function freshCounters(): PerfCounters {
  return {
    enabled: true,
    geometryFetchMs: newHistogram(),
    tileFetchMs: newHistogram(),
    frameMs: newHistogram(),
    renderMs: newHistogram(),
    rafMs: newHistogram(),
    lagMs: newHistogram(),
    mapDrawMs: newHistogram(),
    reloads: { tex: 0, light: 0, gpuShadows: 0, cap: 0, resume: 0, band: 0, restore: 0 },
    flyRenders: 0, appRenders: 0, editsApplied: 0, mapDraws: 0, sceneFrames: 0,
    drawCallsLast: 0, drawCallsMax: 0, visibleMeshesLast: 0, visibleMeshesMax: 0,
    tilesByLod: {},
    startedAt: performance.now(),
    resetAt: performance.now(),
    chunkFetchesIssued: 0,
    chunkFetchesDroppedStale: 0,
    chunkFetchesErrored: 0,
    contextLosses: 0,
    budgetLimitedTransitions: 0,
    longOpCount: 0,
  };
}

/** One module-level instance — counters are process-wide (the Diagnostics panel reports the whole
 *  session), not per-component-instance. */
export const perfCounters: PerfCounters = freshCounters();

/** Bump a plain counter (no-op when sampling is off). */
export function bumpPerf(k: "flyRenders" | "appRenders" | "editsApplied" | "mapDraws" | "sceneFrames"): void {
  if (perfCounters.enabled) perfCounters[k]++;
}
export function recordReload(reason: ReloadReason): void {
  if (perfCounters.enabled) perfCounters.reloads[reason]++;
}
/** Last-frame and running-max render stats. */
export function recordRenderStats(drawCalls: number, visibleMeshes: number): void {
  if (!perfCounters.enabled) return;
  perfCounters.drawCallsLast = drawCalls;
  if (drawCalls > perfCounters.drawCallsMax) perfCounters.drawCallsMax = drawCalls;
  perfCounters.visibleMeshesLast = visibleMeshes;
  if (visibleMeshes > perfCounters.visibleMeshesMax) perfCounters.visibleMeshesMax = visibleMeshes;
}

export function recordGeometryFetchMs(ms: number): void {
  if (!perfCounters.enabled) return;
  perfCounters.geometryFetchMs[bucketIndexForMs(ms)]++;
}
export function recordTileFetchMs(ms: number): void {
  if (!perfCounters.enabled) return;
  perfCounters.tileFetchMs[bucketIndexForMs(ms)]++;
}
export function recordFrameMs(ms: number): void {
  if (!perfCounters.enabled) return;
  perfCounters.frameMs[bucketIndexForMs(ms)]++;
}

export function recordRenderMs(ms: number): void {
  if (!perfCounters.enabled) return;
  perfCounters.renderMs[bucketIndexForMs(ms)]++;
}
export function recordRafMs(ms: number): void {
  if (!perfCounters.enabled) return;
  perfCounters.rafMs[bucketIndexForMs(ms)]++;
}
export function recordLagMs(ms: number): void {
  if (!perfCounters.enabled) return;
  perfCounters.lagMs[bucketIndexForMs(ms)]++;
}
export function recordMapDrawMs(ms: number): void {
  if (!perfCounters.enabled) return;
  perfCounters.mapDrawMs[bucketIndexForMs(ms)]++;
}

/** Zero every histogram/counter (Diagnostics ▸ Reset counters, so the user can bracket the onset of
 *  a slowdown) without touching `enabled` or the session start time. */
export function resetPerfCounters(): void {
  const { enabled, startedAt } = perfCounters;
  Object.assign(perfCounters, freshCounters(), { enabled, startedAt });
}
