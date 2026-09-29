import { describe, expect, it } from "vitest";
import { decodePasteLens } from "./types";

// Mirrors `ipc_envelope`'s framing (lib.rs) — same idiom as `codec.test.ts`'s `buildEnvelope`.
function buildEnvelope(header: unknown, body: Uint8Array): ArrayBuffer {
  let hdr = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - ((4 + hdr.length) % 4)) % 4;
  if (pad > 0) hdr = new Uint8Array([...hdr, ...new Uint8Array(pad).fill(0x20)]);
  const out = new Uint8Array(4 + hdr.length + body.length);
  new DataView(out.buffer).setUint32(0, hdr.length, true);
  out.set(hdr, 4);
  out.set(body, 4 + hdr.length);
  return out.buffer;
}

describe("decodePasteLens", () => {
  it("round-trips a hand-built render_paste_lens envelope", () => {
    const width = 6, height = 4;
    const pixels = new Uint8Array(4 * width * height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = i % 256;
    const header = {
      width, height, lod: 2,
      col_lo: 10, z_lo: 40, z_hi: 43,
      footprint_lo: 12, footprint_hi: 20,
      ghost_z_min: 41, ghost_z_max: 43,
      buried: 5, cleared: 0, floating_cols: 1,
      approx: false,
    };
    const buf = buildEnvelope(header, pixels);
    const r = decodePasteLens(buf);

    expect(r.width).toBe(width);
    expect(r.height).toBe(height);
    expect(r.lod).toBe(2);
    expect(r.colLo).toBe(10);
    expect(r.zLo).toBe(40);
    expect(r.zHi).toBe(43);
    expect(r.footprintLo).toBe(12);
    expect(r.footprintHi).toBe(20);
    expect(r.ghostZMin).toBe(41);
    expect(r.ghostZMax).toBe(43);
    expect(r.buried).toBe(5);
    expect(r.cleared).toBe(0);
    expect(r.floatingCols).toBe(1);
    expect(r.approx).toBe(false);
    expect(r.pixels).toEqual(pixels);
  });

  it("carries null ghostZMin/ghostZMax through when every column is skipped", () => {
    const header = {
      width: 1, height: 1, lod: 1,
      col_lo: 0, z_lo: 0, z_hi: 0,
      footprint_lo: 0, footprint_hi: 0,
      ghost_z_min: null, ghost_z_max: null,
      buried: 0, cleared: 0, floating_cols: 0,
      approx: true,
    };
    const buf = buildEnvelope(header, new Uint8Array(4));
    const r = decodePasteLens(buf);
    expect(r.ghostZMin).toBeNull();
    expect(r.ghostZMax).toBeNull();
    expect(r.approx).toBe(true);
  });
});
