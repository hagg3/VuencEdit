// Shared IPC-shape types, mirroring their Rust counterparts (see CLAUDE.md IPC
// Architecture / Color System). Previously each consumer re-declared these locally,
// which is exactly the kind of drift that bit the color tables before C6 — declare
// once here and import everywhere instead.

import { asI16, asU16, asU32, decodeEnvelope, splitBody, type IpcBinary } from "./codec";

// ---- World metadata (Rust `WorldMeta`, returned by load_world) ----

export interface WorldMeta {
  name: string;
  width_chunks: number;
  height_chunks: number;
  max_z: number;
  was_compressed: boolean;
  spawn_px: number | null;
  spawn_py: number | null;
  center_px: number | null;
  center_py: number | null;
  abs_min_x: number;
  abs_min_y: number;
  sky: number;
  /** Header `version` field — distinguishes `NewFormat256z` (256z, not version 5/6 — the 2026
   *  game update) from `NewDawn256z` (256z, version 5 or 6) without a second IPC round trip. */
  version: number;
  /** True when this world's signs came from a `signs_<file>.eden.dat` sidecar rather than from the
   *  inline post-directory trailer. Nothing in VuencEdit writes a sidecar, so those signs do not
   *  survive Save As / Upload / a compressed save — App warns once on load. */
  signs_from_sidecar: boolean;
}

export interface RecentWorld { path: string; name: string; timestamp: number; }

/** Mirrors CLAUDE.md's "File Format" table's three classes. The one thing every format-labeled
 *  UI spot (status bar, world pill, Properties) must agree on, so it lives in one place rather
 *  than three copies of "max_z === 255 && version is/isn't 5 or 6" that could silently drift. */
export type WorldFormatClass = "legacy64z" | "newDawn256z" | "newFormat256z";

/** `newFormat256z` = 256z but `version` isn't the New Dawn 5/6 you'd expect — the 2026 game
 *  update's variant (16 new block types, signs stored differently), predating the version bump it
 *  should have gotten. Labeled distinctly from "New Dawn 256z" since players associate "New Dawn"
 *  with the pre-2026 format specifically. */
export function classifyWorldFormat(meta: { max_z: number; version: number }): WorldFormatClass {
  if (meta.max_z !== 255) return "legacy64z";
  if (meta.version === 5 || meta.version === 6) return "newDawn256z";
  return "newFormat256z";
}

// ---- Pixel patches (partial re-renders returned by edit/render commands) ----

/** A decoded pixel patch. `lod` is world blocks per pixel (audit H6): 1 for every edit patch and
 *  every full-resolution render, >1 only for zoomed-out map tiles, which must be drawn upscaled by
 *  that factor. `pixels` is a view over the IPC response bytes, not a copy. */
export interface PixelPatch { x: number; y: number; width: number; height: number; lod: number; pixels: Uint8Array; }

type PixelPatchHeader = { x: number; y: number; width: number; height: number; lod: number };

/** Decode a `PixelPatch`-returning command's binary response (audit H2). */
export function decodePixelPatch(buf: IpcBinary): PixelPatch {
  const { header, body } = decodeEnvelope<PixelPatchHeader>(buf);
  return { ...header, pixels: body };
}

/** Returned by every editing command (see CLAUDE.md Edit flow). */
export interface EditResult {
  patch: PixelPatch;
  /** Audit C2: the patch would have been larger than the backend's ceiling, so it carries the
   *  changed rect (`patch.x/y` + `patch.width/height × patch.lod` blocks) and **no pixels** —
   *  re-fetch that region instead of blitting it. */
  invalidate: boolean;
  undo_depth: number; redo_depth: number; operation: string;
  /** Audit C1 step 3: this edit's undo delta exceeded the whole undo budget, so it was dropped and
   *  the rest of the history with it. The edit itself applied; nothing is undoable. */
  undo_dropped: boolean;
  /** Non-fatal advisory toasts — e.g. dense doors/flowers packed into this edit's footprint, a block
   *  family suspected of a fixed client-side capacity (see the ComBlock crash writeup). The edit
   *  already applied; this is informational only. Empty for undo/redo. */
  warnings: string[];
}

type EditResultHeader = {
  patch: PixelPatchHeader; invalidate: boolean;
  undo_depth: number; redo_depth: number; operation: string; undo_dropped: boolean;
  warnings: string[];
};

export function decodeEditResult(buf: IpcBinary): EditResult {
  const { header, body } = decodeEnvelope<EditResultHeader>(buf);
  return {
    patch: { ...header.patch, pixels: body },
    invalidate: header.invalidate,
    undo_depth: header.undo_depth,
    redo_depth: header.redo_depth,
    operation: header.operation,
    undo_dropped: header.undo_dropped,
    warnings: header.warnings,
  };
}

// ---- Preview images (elevation panel, selection ortho/axo, clipboard preview) ----

export interface PreviewData { width: number; height: number; pixels: Uint8Array; }

/** Decode a `PreviewData`/`PreviewImage`-returning command's binary response (audit H2). */
export function decodePreviewData(buf: IpcBinary): PreviewData {
  const { header, body } = decodeEnvelope<{ width: number; height: number }>(buf);
  return { width: header.width, height: header.height, pixels: body };
}

// ---- Voxel geometry (get_chunk_geometry, format 2) ----

/** One stream of a compact (v2, ROADMAP-EDIT 18.14) chunk mesh: typed views over the IPC response,
 *  ready to hand straight to `THREE.BufferAttribute`. */
export interface GeometryStream {
  /** `Int16 × 4` per vertex — fixed-point x, y, z (three-space) plus a 0 pad (D3D/ANGLE has no
   *  3×16-bit vertex format). Place the mesh at `origin`, scaled by `posScale`. */
  positions: Int16Array;
  /** `Uint8 × 4` per vertex, normalised RGBA (alpha 255 outside the transparent stream). */
  colors: Uint8Array;
  /** `Uint16 × 2` per vertex, integer: U in half-tiles, V = atlas row. Empty without a texture pack;
   *  with one, the atlas texture's `repeat = (0.5, 1 / atlasRows)` maps them exactly. */
  uvs: Uint16Array;
  /** Triangle indices (`Uint32` once a stream reaches 65 535 vertices), already cut to `indexCount`. */
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  /** Wire bytes behind this stream (all four sections) — FlyView3D's geometry budget counts these:
   *  a GPU buffer is exactly the size of the array it was uploaded from. */
  bytes: number;
}

/** Decoded `get_chunk_geometry` (format 2) result. */
export interface VoxelGeometry {
  /** Three-space position of the mesh (the chunk's corner). */
  origin: [number, number, number];
  /** Scale that turns the fixed-point positions into blocks (1/16). */
  posScale: number;
  /** Atlas height in tiles; 0 = no texture pack. */
  atlasRows: number;
  /** Opaque, transparent (water/glass/fence/new-flower), emissive (lamp faces, GPU mode only). */
  streams: [GeometryStream, GeometryStream, GeometryStream];
}

type GeometryStreamHeader = {
  vertex_count: number; index_count: number; index_u32: boolean;
  /** Byte lengths of positions, colours, uvs, indices (each a multiple of 4). */
  lens: [number, number, number, number];
};
type VoxelGeometryHeader = {
  format: number;
  origin: [number, number, number]; pos_scale: number; atlas_rows: number;
  streams: [GeometryStreamHeader, GeometryStreamHeader, GeometryStreamHeader];
};

export function decodeGeometry(buf: IpcBinary): VoxelGeometry {
  const { header, body } = decodeEnvelope<VoxelGeometryHeader>(buf);
  if (header.format !== 2) throw new Error(`Unexpected geometry format ${header.format}`);
  const sections = splitBody(body, header.streams.flatMap((s) => s.lens));
  const stream = (i: number): GeometryStream => {
    const h = header.streams[i];
    const [p, c, u, x] = sections.slice(i * 4, i * 4 + 4);
    return {
      positions: asI16(p),
      colors: c,
      uvs: asU16(u),
      indices: h.index_u32 ? asU32(x, h.index_count) : asU16(x, h.index_count),
      vertexCount: h.vertex_count,
      bytes: h.lens[0] + h.lens[1] + h.lens[2] + h.lens[3],
    };
  };
  return {
    origin: header.origin, posScale: header.pos_scale, atlasRows: header.atlas_rows,
    streams: [stream(0), stream(1), stream(2)],
  };
}

// ---- Selection / clipboard ----

export interface SelectionInfo {
  x1: number; y1: number; x2: number; y2: number;
  z_min: number; z_max: number;
  width: number; height: number; depth: number;
  /** Popcount of the shaped mask when one matches this rect exactly; null for a plain box selection. */
  cell_count: number | null;
  masked: boolean;
}

/** Decoded `get_selection_mask` result — null when the selection is a plain rectangle. */
export interface SelectionMaskInfo {
  x1: number; y1: number; x2: number; y2: number;
  bits: Uint8Array;
}

export function decodeSelectionMask(buf: IpcBinary): SelectionMaskInfo | null {
  const { header, body } = decodeEnvelope<{ x1: number; y1: number; x2: number; y2: number } | null>(buf);
  return header === null ? null : { ...header, bits: body };
}

// ---- Paste lens (UI redesign r3, Stage 14.9 — `render_paste_lens`) ----

/**
 * One decoded front/side elevation from `render_paste_lens`. `pixels` is RGBA, row-major, already
 * coloured server-side (terrain / ghost tinted toward clipboard green / buried red / cleared amber
 * hatch — see the backend's `voxel_core::render::paste_lens` doc comment) — the frontend only blits
 * it and draws the Z ruler + ghost-bottom line on top; it does no compositing of its own.
 *
 * `lod` is world columns per output-image column (Z rows are always 1:1, per `PixelPatch`'s LOD
 * convention elsewhere in this file). `colLo` is the world coordinate (X for front, Y for side) of
 * image column 0; `zLo`/`zHi` are the world Z of the image's last/first row. `ghostZMin`/`ghostZMax`
 * are null when every clipboard column is skipped (nothing would be pasted — e.g. every column
 * fell outside a shaped clipboard's mask, or terrain mode found no surface anywhere).
 */
export interface PasteLensResult {
  width: number; height: number; lod: number;
  colLo: number; zLo: number; zHi: number;
  footprintLo: number; footprintHi: number;
  ghostZMin: number | null; ghostZMax: number | null;
  /** Cell counts over the whole clipboard volume (not pixels) — see `approx`. */
  buried: number; cleared: number; floatingCols: number;
  /** The three counts above were estimated from a strided sample (a huge clipboard) — show "≈". */
  approx: boolean;
  pixels: Uint8Array;
}

type PasteLensHeader = {
  width: number; height: number; lod: number;
  col_lo: number; z_lo: number; z_hi: number;
  footprint_lo: number; footprint_hi: number;
  ghost_z_min: number | null; ghost_z_max: number | null;
  buried: number; cleared: number; floating_cols: number;
  approx: boolean;
};

/** Decode a `render_paste_lens` binary response (audit H2 framing — see codec.ts). */
export function decodePasteLens(buf: IpcBinary): PasteLensResult {
  const { header: h, body } = decodeEnvelope<PasteLensHeader>(buf);
  return {
    width: h.width, height: h.height, lod: h.lod,
    colLo: h.col_lo, zLo: h.z_lo, zHi: h.z_hi,
    footprintLo: h.footprint_lo, footprintHi: h.footprint_hi,
    ghostZMin: h.ghost_z_min, ghostZMax: h.ghost_z_max,
    buried: h.buried, cleared: h.cleared, floatingCols: h.floating_cols,
    approx: h.approx,
    pixels: body,
  };
}

export interface ClipboardInfo {
  width: number;
  height: number;
  depth: number;
  z_anchor: number;
  /** True when the clipboard carries a non-rectangular footprint (paste skips unmasked columns). */
  masked: boolean;
}

export type ExtrudeAxis = "z+" | "z-" | "x+" | "x-" | "y+" | "y-";
export type TreeType = "normal" | "terrain" | "pine" | "tall_pine";

// ---- Signs (256z-format plan, Phase 4) ----

/** Decoded `get_signs` result. `x`/`y` are already editor-local (min_x/min_y offset applied on
 *  the Rust side); `z` is an absolute height. `facing` is a strong-but-unproven hypothesis (a 0–3
 *  quadrant, see CLAUDE.md's "File Format" section) — shown as a raw number, not decoded further. */
export interface SignInfo {
  x: number;
  y: number;
  z: number;
  facing: number;
  text: string;
}

export interface AutosaveInfo {
  world_name: string;
  source_path: string | null;
  timestamp: number; // unix seconds
  /** 0 = legacy single-file autosave (open via `get_autosave_path` + `load_world`); 1 = journaled
   *  base+journal sidecars; 2 = journal + `base` naming its base image (18.9). 1–2 recover via
   *  `load_autosave`. */
  format: number;
  /** Journal's own base id, 16 bytes — only meaningful when `format >= 1`. */
  base_id: number[];
  /** Format 2: the image the journal replays onto — the user's world file (`source`) or a private
   *  copy in the app data dir (`clone`). Absent for formats 0–1. */
  base?: { kind: "clone" } | { kind: "source"; path: string; len: number; mtime_ns: number; file_id: [number, number] } | null;
  /** Format 2: whether that base can still be used. `changed`/`missing` only happen for a `source`
   *  base (the file was saved/edited since, or moved/deleted/offline). */
  base_status?: "ok" | "changed" | "missing" | null;
}
