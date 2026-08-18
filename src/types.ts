// Shared IPC-shape types, mirroring their Rust counterparts (see CLAUDE.md IPC
// Architecture / Color System). Previously each consumer re-declared these locally,
// which is exactly the kind of drift that bit the color tables before C6 — declare
// once here and import everywhere instead.

import { asF32, decodeEnvelope, splitBody, type IpcBinary } from "./codec";

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
export interface EditResult { patch: PixelPatch; undo_depth: number; redo_depth: number; operation: string; }

type EditResultHeader = { patch: PixelPatchHeader; undo_depth: number; redo_depth: number; operation: string };

export function decodeEditResult(buf: IpcBinary): EditResult {
  const { header, body } = decodeEnvelope<EditResultHeader>(buf);
  return {
    patch: { ...header.patch, pixels: body },
    undo_depth: header.undo_depth,
    redo_depth: header.redo_depth,
    operation: header.operation,
  };
}

// ---- Preview images (elevation panel, selection ortho/axo, clipboard preview) ----

export interface PreviewData { width: number; height: number; pixels: Uint8Array; }

/** Decode a `PreviewData`/`PreviewImage`-returning command's binary response (audit H2). */
export function decodePreviewData(buf: IpcBinary): PreviewData {
  const { header, body } = decodeEnvelope<{ width: number; height: number }>(buf);
  return { width: header.width, height: header.height, pixels: body };
}

// ---- Voxel geometry (get_chunk_geometry / get_obj_geometry) ----

/** Decoded geometry: three vertex streams (opaque / transparent / emissive), each already a
 *  `Float32Array` view over the IPC response — ready to hand straight to `THREE.BufferAttribute`. */
export interface VoxelGeometry {
  positions: Float32Array; colors: Float32Array; uvs: Float32Array; vertex_count: number;
  /** Transparent stream (water/glass/fence/new-flower) — colors are RGBA (itemSize 4), not RGB. */
  positions_t: Float32Array; colors_t: Float32Array; uvs_t: Float32Array; vertex_count_t: number;
  /** Emissive stream — lamp-block faces, RGB. Populated only in GPU (flat) mode. */
  positions_e: Float32Array; colors_e: Float32Array; uvs_e: Float32Array; vertex_count_e: number;
  /** Wire bytes behind each stream (position + color + uv), straight from the envelope's own `lens`
   *  header. FlyView3D's geometry budget counts these rather than vertices: a GPU VBO is exactly the
   *  size of the buffer it was uploaded from, whereas a vertex costs 24–36 B depending on which
   *  stream it lands in and whether a texture pack is loaded. */
  bytes: number; bytes_t: number; bytes_e: number;
}

type VoxelGeometryHeader = {
  vertex_count: number; vertex_count_t: number; vertex_count_e: number;
  /** Byte length of each of the nine buffers, in body order (see `ObjGeometryResult` in export.rs). */
  lens: number[];
};

export function decodeGeometry(buf: IpcBinary): VoxelGeometry {
  const { header, body } = decodeEnvelope<VoxelGeometryHeader>(buf);
  const [p, c, u, pt, ct, ut, pe, ce, ue] = splitBody(body, header.lens).map(asF32);
  const L = header.lens;
  return {
    positions: p, colors: c, uvs: u, vertex_count: header.vertex_count,
    positions_t: pt, colors_t: ct, uvs_t: ut, vertex_count_t: header.vertex_count_t,
    positions_e: pe, colors_e: ce, uvs_e: ue, vertex_count_e: header.vertex_count_e,
    bytes: L[0] + L[1] + L[2], bytes_t: L[3] + L[4] + L[5], bytes_e: L[6] + L[7] + L[8],
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
   *  base+journal sidecars, recovered via `load_autosave` instead. */
  format: number;
  /** Journal's own base id, 16 bytes — only meaningful when `format === 1`. */
  base_id: number[];
}
