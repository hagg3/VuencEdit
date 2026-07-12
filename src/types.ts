// Shared IPC-shape types, mirroring their Rust counterparts (see CLAUDE.md IPC
// Architecture / Color System). Previously each consumer re-declared these locally,
// which is exactly the kind of drift that bit the color tables before C6 — declare
// once here and import everywhere instead.

import { decodeU8 } from "./codec";

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

/** Raw IPC shape — pixels still base64. Decode via `decodePixelPatch` before use. */
export interface PixelPatchRaw { x: number; y: number; width: number; height: number; pixels: string; }

export interface PixelPatch { x: number; y: number; width: number; height: number; pixels: Uint8Array; }

export function decodePixelPatch(raw: PixelPatchRaw): PixelPatch {
  return { x: raw.x, y: raw.y, width: raw.width, height: raw.height, pixels: decodeU8(raw.pixels) };
}

/** Returned by every editing command (see CLAUDE.md Edit flow). */
export interface EditResultRaw { patch: PixelPatchRaw; undo_depth: number; redo_depth: number; operation: string; }

// ---- Preview images (elevation panel, selection ortho/axo, clipboard preview) ----

export interface PreviewDataRaw { width: number; height: number; pixels: string; }

export interface PreviewData { width: number; height: number; pixels: Uint8Array; }

export function decodePreviewData(raw: PreviewDataRaw): PreviewData {
  return { width: raw.width, height: raw.height, pixels: decodeU8(raw.pixels) };
}

// ---- Selection / clipboard ----

export interface SelectionInfo {
  x1: number; y1: number; x2: number; y2: number;
  z_min: number; z_max: number;
  width: number; height: number; depth: number;
}

export interface ClipboardInfo {
  width: number;
  height: number;
  depth: number;
  z_anchor: number;
}

export type ExtrudeAxis = "z+" | "z-" | "x+" | "x-" | "y+" | "y-";
export type TreeType = "normal" | "terrain" | "pine" | "tall_pine";

export interface AutosaveInfo {
  world_name: string;
  source_path: string | null;
  timestamp: number; // unix seconds
}
