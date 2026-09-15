/**
 * Latency histograms + counters backing the Diagnostics panel (ROADMAP-EDIT Stage 9.4).
 *
 * **Fixed log-ish buckets, never a per-event log** — a ring buffer of individual timings is the
 * thing that turns a diagnostic into a leak (`TEST WORLDS/diagnostics-panel-plan-2026-09-14.md`
 * §1d). Every counter here is a plain integer increment on a call site that already measures time
 * (`performance.now()` around an existing `invoke`, or the frame loop's own `dt`), gated on
 * {@link perfCounters}.enabled so a diagnostic that is off costs one boolean read, not the
 * increment. Reset only ever zeroes; nothing here retains history beyond the 12 buckets.
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
export function formatHistogram(hist: Uint32Array): string {
  return HISTOGRAM_BUCKET_MS
    .map((b, i) => `${b === Infinity ? ">=1024ms" : "<" + b + "ms"}=${hist[i]}`)
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

export interface PerfCounters {
  /** Master gate — mirrors `AppSettings.showPerfHud`. Every recorder below no-ops when false. */
  enabled: boolean;
  geometryFetchMs: Uint32Array;
  tileFetchMs: Uint32Array;
  frameMs: Uint32Array;
  chunkFetchesIssued: number;
  chunkFetchesDroppedStale: number;
  chunkFetchesErrored: number;
  contextLosses: number;
  budgetLimitedTransitions: number;
  longOpCount: number;
}

function freshCounters(): PerfCounters {
  return {
    enabled: false,
    geometryFetchMs: newHistogram(),
    tileFetchMs: newHistogram(),
    frameMs: newHistogram(),
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

/** Reset every histogram/counter to zero without touching `enabled`. Not currently wired to any
 *  UI action (the Diagnostics panel reports session-lifetime totals) — kept for a future "reset"
 *  button and for tests that want a clean slate. */
export function resetPerfCounters(): void {
  Object.assign(perfCounters, freshCounters(), { enabled: perfCounters.enabled });
}
