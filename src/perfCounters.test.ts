import { describe, it, expect } from "vitest";
import {
  HISTOGRAM_BUCKET_MS, bucketIndexForMs, newHistogram, formatHistogram, approxPercentile,
} from "./perfCounters";

describe("bucketIndexForMs", () => {
  it("places a value into the first bucket whose upper bound it is strictly under", () => {
    expect(bucketIndexForMs(0)).toBe(0);
    expect(bucketIndexForMs(0.5)).toBe(0);
    expect(bucketIndexForMs(1)).toBe(1); // not < 1, falls into the <2 bucket
    expect(bucketIndexForMs(1.9)).toBe(1);
    expect(bucketIndexForMs(2)).toBe(2);
  });

  it("puts everything at or above the last finite bound into the final (>=1024) bucket", () => {
    expect(bucketIndexForMs(1024)).toBe(HISTOGRAM_BUCKET_MS.length - 1);
    expect(bucketIndexForMs(999_999)).toBe(HISTOGRAM_BUCKET_MS.length - 1);
  });

  it("never returns an out-of-range index for a negative or NaN input", () => {
    expect(bucketIndexForMs(-5)).toBe(0);
  });
});

describe("newHistogram / formatHistogram", () => {
  it("starts at all zeros and formats one entry per bucket", () => {
    const h = newHistogram();
    expect(h.length).toBe(HISTOGRAM_BUCKET_MS.length);
    expect(Array.from(h).every((n) => n === 0)).toBe(true);
    const s = formatHistogram(h);
    expect(s.split(" ").length).toBe(HISTOGRAM_BUCKET_MS.length);
    expect(s).toContain(">=1024ms=0");
  });
});

describe("approxPercentile", () => {
  it("returns null for an empty histogram", () => {
    expect(approxPercentile(newHistogram(), 0.5)).toBeNull();
  });

  it("finds the bucket boundary containing the target rank", () => {
    const h = newHistogram();
    h[bucketIndexForMs(0.5)] = 90; // <1ms
    h[bucketIndexForMs(2000)] = 10; // >=1024ms
    expect(approxPercentile(h, 0.5)).toBe(1); // p50 sits inside the <1ms bucket
    expect(approxPercentile(h, 0.95)).toBe(Infinity); // p95 spills into the tail bucket
  });
});
