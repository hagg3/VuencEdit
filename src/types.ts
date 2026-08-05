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
}

export interface RecentWorld { path: string; name: string; timestamp: number; }

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
}

type VoxelGeometryHeader = {
  vertex_count: number; vertex_count_t: number; vertex_count_e: number;
  /** Byte length of each of the nine buffers, in body order (see `ObjGeometryResult` in export.rs). */
  lens: number[];
};

export function decodeGeometry(buf: IpcBinary): VoxelGeometry {
  const { header, body } = decodeEnvelope<VoxelGeometryHeader>(buf);
  const [p, c, u, pt, ct, ut, pe, ce, ue] = splitBody(body, header.lens).map(asF32);
  return {
    positions: p, colors: c, uvs: u, vertex_count: header.vertex_count,
    positions_t: pt, colors_t: ct, uvs_t: ut, vertex_count_t: header.vertex_count_t,
    positions_e: pe, colors_e: ce, uvs_e: ue, vertex_count_e: header.vertex_count_e,
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
