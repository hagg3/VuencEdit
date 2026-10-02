import { describe, expect, it } from "vitest";
import { decodeGeometry, decodePasteLensPair, decodeSelectionLens } from "./types";

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

describe("decodePasteLensPair", () => {
  it("round-trips a hand-built render_paste_lens envelope", () => {
    const width = 6, height = 4;
    const pixels = new Uint8Array(4 * width * height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = i % 256;
    const sidePixels = new Uint8Array(4 * 3 * height).fill(77);
    const front = {
      width, height, lod: 2,
      col_lo: 10, z_lo: 40, z_hi: 43,
      footprint_lo: 12, footprint_hi: 20,
      ghost_z_min: 41, ghost_z_max: 43,
      buried: 5, cleared: 0, floating_cols: 1,
      approx: false,
    };
    const side = { ...front, width: 3, lod: 1, col_lo: 7, footprint_lo: 8, footprint_hi: 9 };
    const header = { front, side, lens: [pixels.length, sidePixels.length] };
    const buf = buildEnvelope(header, new Uint8Array([...pixels, ...sidePixels]));
    const { front: r, side: s } = decodePasteLensPair(buf);
    expect(s).toMatchObject({ width: 3, height, lod: 1, colLo: 7, footprintLo: 8, footprintHi: 9, zLo: 40, zHi: 43, buried: 5 });
    expect(s.pixels).toEqual(sidePixels);

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
    const view = {
      width: 1, height: 1, lod: 1,
      col_lo: 0, z_lo: 0, z_hi: 0,
      footprint_lo: 0, footprint_hi: 0,
      ghost_z_min: null, ghost_z_max: null,
      buried: 0, cleared: 0, floating_cols: 0,
      approx: true,
    };
    const buf = buildEnvelope({ front: view, side: view, lens: [4, 4] }, new Uint8Array(8));
    const r = decodePasteLensPair(buf).side;
    expect(r.ghostZMin).toBeNull();
    expect(r.ghostZMax).toBeNull();
    expect(r.approx).toBe(true);
  });
});

describe("decodeSelectionLens", () => {
  const img = (w: number, h: number, seed: number) => new Uint8Array(4 * w * h).map((_, i) => (i * seed) % 256);

  it("splits a front + side envelope by `lens` and maps each view by kind", () => {
    const front = img(5, 64, 3), side = img(7, 64, 5);
    const header = {
      views: [
        { kind: "front", width: 5, height: 64, lod: 2, col_lo: -3, row_lo: null, footprint_lo: 1, footprint_hi: 6 },
        { kind: "side", width: 7, height: 64, lod: 1, col_lo: 4, row_lo: null, footprint_lo: 7, footprint_hi: 10 },
      ],
      lens: [front.length, side.length],
      z_lo: 0, z_hi: 63, terrain_z_hi: 41,
    };
    const body = new Uint8Array([...front, ...side]);
    const r = decodeSelectionLens(buildEnvelope(header, body));
    expect(r.top).toBeNull();
    expect([r.zLo, r.zHi, r.terrainZHi]).toEqual([0, 63, 41]);
    expect(r.front).toMatchObject({ width: 5, height: 64, lod: 2, colLo: -3, rowLo: null, footprintLo: 1, footprintHi: 6 });
    expect(r.side).toMatchObject({ width: 7, lod: 1, colLo: 4, footprintLo: 7, footprintHi: 10 });
    expect(r.front!.pixels).toEqual(front);
    expect(r.side!.pixels).toEqual(side);
  });

  it("decodes the top-only flavour", () => {
    const top = img(3, 2, 7);
    const header = {
      views: [{ kind: "top", width: 3, height: 2, lod: 4, col_lo: 8, row_lo: 12, footprint_lo: 10, footprint_hi: 17 }],
      lens: [top.length], z_lo: 20, z_hi: 30, terrain_z_hi: null,
    };
    const r = decodeSelectionLens(buildEnvelope(header, top));
    expect(r.front).toBeNull();
    expect(r.side).toBeNull();
    expect(r.terrainZHi).toBeNull();
    expect(r.top).toMatchObject({ width: 3, height: 2, lod: 4, colLo: 8, rowLo: 12 });
    expect(r.top!.pixels).toEqual(top);
  });
});

describe("decodeGeometry (format 2, ROADMAP-EDIT 18.14)", () => {
  // One opaque quad (4 vertices, 6 Uint16 indices padded to 12 bytes) with UVs; an empty transparent
  // stream; an emissive triangle with Uint32 indices. Section order per stream: pos, col, uv, idx.
  const le16 = (xs: number[]) => { const b = new Uint8Array(xs.length * 2); const d = new DataView(b.buffer); xs.forEach((x, i) => d.setInt16(i * 2, x, true)); return b; };
  const le32 = (xs: number[]) => { const b = new Uint8Array(xs.length * 4); const d = new DataView(b.buffer); xs.forEach((x, i) => d.setUint32(i * 4, x, true)); return b; };
  const pad4 = (b: Uint8Array) => { const out = new Uint8Array(Math.ceil(b.length / 4) * 4); out.set(b); return out; };
  const opPos = le16([0, 0, 0, 0, 16, 0, 0, 0, 16, 0, 16, 0, 0, 0, 16, 0]);
  const opCol = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
  const opUv = le16([0, 4, 2, 4, 2, 3, 0, 3]);
  const opIdx = pad4(le16([0, 1, 3, 1, 2, 3]));
  const emPos = le16([32, 64, 0, 0, 48, 64, 0, 0, 40, 72, 0, 0]);
  const emCol = new Uint8Array(12).fill(200);
  const emIdx = le32([0, 1, 2]);
  const parts = [opPos, opCol, opUv, opIdx, emPos, emCol, emIdx];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0; for (const p of parts) { body.set(p, off); off += p.length; }
  const header = {
    format: 2, origin: [32, 0, 48], pos_scale: 1 / 16, atlas_rows: 9,
    streams: [
      { vertex_count: 4, index_count: 6, index_u32: false, lens: [opPos.length, opCol.length, opUv.length, opIdx.length] },
      { vertex_count: 0, index_count: 0, index_u32: false, lens: [0, 0, 0, 0] },
      { vertex_count: 3, index_count: 3, index_u32: true, lens: [emPos.length, emCol.length, 0, emIdx.length] },
    ],
  };

  it("slices every section into typed views and cuts the index padding", () => {
    const g = decodeGeometry(buildEnvelope(header, body));
    expect(g.origin).toEqual([32, 0, 48]);
    expect(g.posScale).toBe(1 / 16);
    expect(g.atlasRows).toBe(9);
    const [op, tr, em] = g.streams;
    expect(op.positions).toBeInstanceOf(Int16Array);
    expect(Array.from(op.positions)).toEqual([0, 0, 0, 0, 16, 0, 0, 0, 16, 0, 16, 0, 0, 0, 16, 0]);
    expect(Array.from(op.colors.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(op.uvs)).toEqual([0, 4, 2, 4, 2, 3, 0, 3]);
    expect(op.indices).toBeInstanceOf(Uint16Array);
    expect(Array.from(op.indices)).toEqual([0, 1, 3, 1, 2, 3]); // not the 7th, padding, index
    expect(op.bytes).toBe(opPos.length + opCol.length + opUv.length + opIdx.length);
    expect(tr.vertexCount).toBe(0);
    expect(tr.bytes).toBe(0);
    expect(em.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(em.indices)).toEqual([0, 1, 2]);
    expect(em.uvs.length).toBe(0);
  });

  it("views in place (no copy) when the body is aligned", () => {
    const buf = buildEnvelope(header, body);
    const g = decodeGeometry(buf);
    expect(g.streams[0].positions.buffer).toBe(buf);
    expect(g.streams[2].indices.buffer).toBe(buf);
  });

  it("rejects a v1 (format-less) header", () => {
    expect(() => decodeGeometry(buildEnvelope({ vertex_count: 0, lens: [] }, new Uint8Array(0)))).toThrow(/format/);
  });
});
