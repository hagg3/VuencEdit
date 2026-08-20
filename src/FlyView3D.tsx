import { decodeGeometry, type VoxelGeometry } from "./types";
import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { AtlasData } from "./texturePack";
import { isTypingTarget, chunkToWorld, worldToChunk, gridDivisions } from "./viewportUtils";
import type { WorldMeta } from "./types";
import { chromeButton, glassMenuPanel } from "./designTokens";
import { skyFogColor, rampFamilyBase, wedgeFamilyBase, rampDirIndex, orientBlockToFacing } from "./blockDefs";
import { maskPrismPositions, type OutlinePt, type MaskRect } from "./maskUtils";

// Fog distance scales with the render distance slider (chunk radius × 16 blocks/chunk) so terrain
// fades out at the edge of what's actually streamed in, instead of a fixed distance that either
// clips well inside the loaded radius (short) or never fades (long, at high render distance).
const fogDistances = (radiusChunks: number) => {
  const far = Math.max(20, chunkToWorld(radiusChunks) * 0.9);
  const near = far * 0.3;
  return { near, far };
};

// Patch a MeshDepthMaterial (used as a mesh's customDepthMaterial in the shadow pass) so the
// transparent stream casts *patterned* shadows in GPU mode: discard shadow-pass fragments whose
// vertex alpha is below 0.75. The transparent stream carries RGBA vertex colours (water .50,
// glass .50, flower .25, fence .90), so this passes light straight through water/glass/flower (no
// shadow, as before) while fence casts. A textured variant additionally sets `map` + `alphaTest`
// (below) so the fence weave tile's own transparent texels punch a lattice into its shadow.
// Three.js converts the injected `attribute`/`varying` GLSL1 keywords to GLSL3 in/out for WebGL2.
const patchDepthAlpha = (m: THREE.MeshDepthMaterial) => {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 color;\nvarying float vDepthAlpha;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvDepthAlpha = color.a;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vDepthAlpha;")
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif ( vDepthAlpha < 0.75 ) discard;");
  };
};

const rgbToHex = (c: readonly [number, number, number]) =>
  "#" + c.map(v => Math.round(THREE.MathUtils.clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

// A sensible light-blue default for the 3D pane's sky/fog color — Minecraft's clear-sky blue,
// used until the user picks a custom color or reverts to the world's own (often muddy) sky paint.
const DEFAULT_SKY_COLOR = "#8cbeff";

/** A lamp light for the experimental GPU night path — Eden local block coords (voxel centre) + colour 0..1. */
interface LampLight { x: number; y: number; z: number; r: number; g: number; b: number }
/** Which shipped lamp-lighting behaviour is active — mirrors Rust `LightingProfile` (export.rs). */
export type LightingProfile = "legacy" | "modern";
/** Cap on live GPU-night point lights. MeshLambertMaterial forward-lights each one in-shader, so this
 *  is the experimental perf ceiling; the nearest N lamps to the camera are assigned. */
const MAX_NIGHT_LIGHTS = 16;
/** Max world-unit radius the GPU shadow map covers around the camera. Beyond this, terrain doesn't
 *  self-shadow — trades distant shadows (mostly fog-hidden) for texel density on near ones. */
const SHADOW_MAX_REACH = 320;
// World-scale 3D fly-through viewport — the 4th quad-view pane.
//
// Coordinate mapping: Eden (X east, Y south, Z up) → Three.js (x = wx, y = wz, z = wy).
// Eden north = Three.js −Z; camera starts south of the world looking north (−Z), so Eden east
// (+X) appears on the right — matching the top-down map orientation.
//
// Two camera modes (Hammer-style):
//  • Orbit (default) — drag to orbit, scroll zoom.
//  • Fly — press Z to toggle. Pointer-locks for mouse-look; WASD moves in the view plane,
//    Space/Ctrl (or E/Q) move world-up/down, Shift = speed boost. Esc / Z exits.
//
// Geometry streams per chunk within a radius of the camera; chunks outside the radius are disposed.
// Edits refetch only the chunks overlapping the last edit's bounds.

interface EditBounds { x: number; y: number; w: number; h: number }

const LOAD_RADIUS = 5;   // chunks loaded around the camera (in chunk units)
// M1: exported so every render-distance slider (this pane's own, the ribbon 3D tab, Settings) shares
// one floor/ceiling — they used to disagree (1–16 / 2–32 / 2–32), so the ribbon slider could push
// `loadRadius` to 1 (below this pane's own floor, breaking `radiusToPos`) and couldn't reach 17–32,
// silently clamping a value Settings had just set the next time it was touched.
export const MAX_RENDER_DISTANCE = 32; // slider ceiling (chunk radius)
export const RD_MIN = 2;               // slider floor (chunk radius)
// The slider maps 1:1 to chunk radius (step = 1 chunk). The old quadratic remap gave the low range
// more pixels but made the top half jump several chunks per pixel (e.g. 16→20 in one nudge), which
// read as "dodgy". A plain linear integer domain is fully predictable — one notch = one chunk.
// rad/px at sensitivity multiplier 1. Raised from the old hardcoded 0.0025 (look mode) — that base
// felt too slow by default; the Settings sliders scale from here (0.25x-4x range).
const LOOK_SENS_BASE = 0.006;
const DRAG_SENS_BASE = 0.0025;
const RENDER_DISTANCE_WARN_THRESHOLD = 16; // above this, chunk count grows enough to warn
const FLY3D_LEGEND_SEEN_KEY = "eden_3dpane_legend_seen"; // M4: auto-open the legend once, ever
// Piecewise slider-position ↔ chunk-radius mapping: positions 0…14 map 1:1 to chunks RD_MIN(2)…16
// (the range where frame rate is cheap to buy), then two slider positions per chunk from 17…32 (the
// range where frame rate falls off a cliff) — so the same physical drag distance buys half as much
// render distance past 16. The stored/persisted value stays in chunks; only the <input> position uses
// this domain, so `RENDER_DISTANCE_WARN_THRESHOLD` and everything else that reads `loadRadius` is
// unaffected.
function radiusToPos(r: number): number {
  if (r <= 16) return r - RD_MIN;
  return 15 + (r - 17) * 2;
}
function posToRadius(pos: number): number {
  if (pos <= 14) return RD_MIN + pos;
  return Math.min(MAX_RENDER_DISTANCE, 17 + Math.floor((pos - 15) / 2));
}
const STREAM_MS = 150;   // throttle for the load/dispose sweep
const MAX_DPR = 1.5;     // cap device-pixel-ratio — Retina (2×) quadruples fragment load for ~no gain

// ---- Camera z band (3D-pane crash fix, Stage 3) -------------------------------------------------
// A 256z chunk is a 16×16×256 scan — 4× a 64z one — and that 4× is paid per chunk, per fetch, on
// the Rust side before a single vertex exists. The band caps the *ceiling* of what each chunk
// fetch scans at `camera z + Z_BAND_ABOVE`, so the mostly-empty air a New Dawn world stacks above
// the terrain is never walked. `get_chunk_geometry` intersects it with the cutaway cap
// (`view_cap_z`) server-side; both only narrow, so they compose.
//
// ⚠️ Deliberately one-sided (up only) rather than the symmetric ±96 band the plan sketched. A band
// with a *floor* hides terrain below the camera, and "fly up to survey the map" is a routine editor
// gesture — the whole landscape would vanish. Clipping above the camera has a bounded failure mode
// instead (a ceiling more than Z_BAND_ABOVE overhead pops in as you climb toward it), and it is
// where all the empty air actually is. The see-through-roof trap the cut plane would otherwise
// create is handled in Rust (`gbz` in obj_geometry_region — the cap face emits).
const Z_BAND_ABOVE = 96;
// Quantize the ceiling so vertical travel doesn't invalidate the whole resident set continuously —
// the band only moves once per this many blocks climbed, and each move costs a full restream.
const Z_BAND_STEP = 64;
// Hard cap on resident chunk-geometry *bytes* (opaque + transparent + emissive streams) regardless
// of render distance. At MAX_RENDER_DISTANCE=32 a fully-loaded disc is ~3200 chunks — with no cap
// that's unbounded GPU memory (a dense 256z chunk can emit tens of MB on its own). Once resident
// geometry crosses this, the streaming queue stops pulling new chunks until eviction (moving the
// camera) frees headroom.
//
// Counted in bytes, not vertices (3D-pane crash fix, Stage 1): a vertex is 24–36 B depending on
// which stream it lands in and whether a texture pack is loaded, so a vertex cap is a 1.5× fuzzy
// byte cap — and it says nothing about world height, where the 256z crashes actually came from.
// Bytes are what the GPU and the JS heap both charge for, and the number comes straight off the
// envelope header (`VoxelGeometry.bytes*`) rather than being re-derived.
const GEOMETRY_BUDGET_BYTES = 512 << 20;

export interface FlyView3DRef {
  /** Move the camera to a world XY position (keeps current height). */
  teleport: (wx: number, wy: number) => void;
}

/** A voxel hit returned by the Rust `pick_block` command. Coords/normal are Eden world coords. */
export interface PickResult {
  x: number; y: number; z: number;
  block_type: number;
  paint: number;
  nx: number; ny: number; nz: number;
}

/** A 3D selection box in Eden world coords — the shape App's `rawBounds`+`zMin`/`zMax` reduce to.
 *  Drives the Select-mode transform gizmo (see "3D selection gizmo" below). */
export interface SelectionBounds3D {
  x1: number; y1: number; x2: number; y2: number; zMin: number; zMax: number;
}

/** What a click in the 3D pane does. Derived from App's active tool, not owned by this pane. */
export type Interact3D = "none" | "select" | "build" | "sculpt" | "floodfill";

/// In-pane VIEW/SELECT/BUILD/SCULPT segmented pill — a quiet mirror of the Ribbon 3D tab's mode
/// picker (both write App's mode3d). Segmented, not a cycle: a stray click must never land on the
/// terrain-editing BUILD/SCULPT modes. VIEW = "none" (camera only); BUILD amber and SCULPT amber
/// to flag the armed edit modes; neither has a bare-key binding (click-only power features).
const INTERACT_SEGMENTS: { mode: Interact3D; label: string; accent: string; title: string }[] = [
  { mode: "none", label: "VIEW", accent: "#afa69d", title: "View only — clicks don't edit" },
  { mode: "select", label: "SELECT", accent: "#3b82f6", title: "Select mode — click two voxels to make a 3D selection" },
  { mode: "floodfill", label: "FILL", accent: "#38bdf8", title: "Flood Fill — click a block face to fill connected air across and down with the armed block" },
  { mode: "build", label: "BUILD", accent: "#f59e0b", title: "Build mode — left-click breaks, right-click places the armed block" },
  { mode: "sculpt", label: "SCULPT", accent: "#fb923c", title: "Sculpt mode — press and hold left to sculpt terrain under the cursor" },
];

/// Display names for the ten sculpt tools, for the in-pane armed-hint readout. (The ribbon owns the
/// canonical picker; this is just a label so the pane doesn't show a bare tool id.)
const SCULPT_TOOL_LABELS: Record<string, string> = {
  raise: "Raise", lower: "Lower", grab: "Grab", smooth: "Smooth", flatten: "Flatten",
  noise: "Noise", erode: "Erode", thermal: "Thermal", hydro: "Hydro", stamp: "Retexture",
  terrace: "Terrace", sharpen: "Sharpen", slope: "Slope", smear: "Smear", rock: "Rock", carve: "Carve",
};
/// Amber sculpt-brush colour (matches the Ribbon sculpt affordances / 2D sculpt ghost).
const SCULPT_BRUSH_HEX = 0xfb923c;
/// 3D sculpt hold-timer cadence (ms) — mirrors MapCanvas's 140 ms airbrush/spray timer.
const SCULPT_TICK_MS = 140;
/// Grab tool: screen px of vertical drag per block of displacement (matches the 2D sculpt-grab ratio).
const SCULPT_GRAB_PX_PER_BLOCK = 6;

/** How far a pick ray reaches, in blocks. Rust clamps to PICK_MAX_DIST regardless. */

/// The three camera modes.
///   orbit — OrbitControls; drag to rotate around a target, cursor visible. (inspection)
///   fly   — WASD move + hold-drag to look, cursor visible. Never grabs pointer lock, so it works
///           even in webviews that refuse it — this is the reliable walk-around mode.
///   look  — WASD move + free mouselook, cursor hidden (Minecraft-style). Requests pointer lock;
///           if the webview refuses it, degrades to cursor-hidden relative-motion look.
/// Both `fly` and `look` are "walking" modes and share the WASD/pitch/yaw controller.
type CamMode = "orbit" | "fly" | "look";
/// Z and the pill button both advance through this cycle. Ordered so the first Z press from orbit
/// lands in `look` (the headline mouselook mode the user reaches for), then `fly`, then back.
const CAM_MODE_CYCLE: Record<CamMode, CamMode> = { orbit: "look", look: "fly", fly: "orbit" };
const CAM_MODE_LABEL: Record<CamMode, string> = { orbit: "3D", look: "LOOK", fly: "FLY" };

/// Tint strength of an overlay box's interior. High enough to shade the enclosed blocks, low
/// enough to still read their colour through it.
const OVERLAY_FILL_OPACITY = 0.14;
/// Opacity of the see-through edge pass. Kept well under 1 so an occluded edge still reads as
/// occluded rather than floating in front of the terrain.
const OVERLAY_XRAY_OPACITY = 0.3;

/**
 * Wrap {@link maskPrismPositions} (the pure vertex math) into Three geometry for a shaped-selection
 * prism — see {@link Overlay3D.shape}. Walls hug the true footprint boundary (no internal faces to
 * double-blend) and the edge lines come straight from the contour, so the unindexed fill soup never
 * leaks internal diagonals into the wireframe.
 */
function buildMaskPrismGeometry(
  loops: OutlinePt[][], caps: MaskRect[], zBottom: number, zTop: number,
): { fill: THREE.BufferGeometry; edges: THREE.BufferGeometry } {
  const pos = maskPrismPositions(loops, caps, zBottom, zTop);
  const fill = new THREE.BufferGeometry();
  fill.setAttribute("position", new THREE.Float32BufferAttribute(pos.fill, 3));
  fill.computeVertexNormals();
  const edges = new THREE.BufferGeometry();
  edges.setAttribute("position", new THREE.Float32BufferAttribute(pos.edges, 3));
  return { fill, edges };
}

/** What the Build sub-toolbar's "shape" toggle does to a click (B1/B2). "single" is today's plain
 *  click-to-break/click-to-place; "line"/"box" arm a start cell on the first click and commit a
 *  batched run of cells (one `with_edit` call, one undo step) on the second; "fill" is a one-click
 *  paint-bucket confined to the clicked face's plane (backend flood-fill, see `fill_connected_face`). */
type BuildShape = "single" | "line" | "box" | "fill";
/** Safety cap on a box-shape's cell count (mirrors magic_wand_select's 50k BFS cap) — a careless
 *  two corners at world-scale apart would otherwise try to paint millions of blocks in one IPC call. */
const MAX_BUILD_SHAPE_CELLS = 50_000;

/** 3D Bresenham — the voxel run between two Eden cells (inclusive both ends). */
function bresenham3D(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): [number, number, number][] {
  const pts: [number, number, number][] = [];
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), dz = Math.abs(z1 - z0);
  const xs = x1 > x0 ? 1 : -1, ys = y1 > y0 ? 1 : -1, zs = z1 > z0 ? 1 : -1;
  let x = x0, y = y0, z = z0;
  if (dx >= dy && dx >= dz) {
    let p1 = 2 * dy - dx, p2 = 2 * dz - dx;
    for (let i = 0; i <= dx; i++) {
      pts.push([x, y, z]);
      if (p1 >= 0) { y += ys; p1 -= 2 * dx; }
      if (p2 >= 0) { z += zs; p2 -= 2 * dx; }
      p1 += 2 * dy; p2 += 2 * dz; x += xs;
    }
  } else if (dy >= dx && dy >= dz) {
    let p1 = 2 * dx - dy, p2 = 2 * dz - dy;
    for (let i = 0; i <= dy; i++) {
      pts.push([x, y, z]);
      if (p1 >= 0) { x += xs; p1 -= 2 * dy; }
      if (p2 >= 0) { z += zs; p2 -= 2 * dy; }
      p1 += 2 * dx; p2 += 2 * dz; y += ys;
    }
  } else {
    let p1 = 2 * dy - dz, p2 = 2 * dx - dz;
    for (let i = 0; i <= dz; i++) {
      pts.push([x, y, z]);
      if (p1 >= 0) { y += ys; p1 -= 2 * dz; }
      if (p2 >= 0) { x += xs; p2 -= 2 * dz; }
      p1 += 2 * dy; p2 += 2 * dx; z += zs;
    }
  }
  return pts;
}

/** Every cell in the inclusive 3D box between two Eden corners, or null if it would exceed the
 *  MAX_BUILD_SHAPE_CELLS safety cap (caller drops the gesture rather than truncating silently into a
 *  half-built box). */
function boxCells(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): [number, number, number][] | null {
  const xlo = Math.min(x0, x1), xhi = Math.max(x0, x1);
  const ylo = Math.min(y0, y1), yhi = Math.max(y0, y1);
  const zlo = Math.min(z0, z1), zhi = Math.max(z0, z1);
  const count = (xhi - xlo + 1) * (yhi - ylo + 1) * (zhi - zlo + 1);
  if (count > MAX_BUILD_SHAPE_CELLS) return null;
  const pts: [number, number, number][] = [];
  for (let x = xlo; x <= xhi; x++)
    for (let y = ylo; y <= yhi; y++)
      for (let z = zlo; z <= zhi; z++)
        pts.push([x, y, z]);
  return pts;
}

/** B3 ramp/wedge placement preview: local unit-cell corner points (0..1, Three coords — x=Eden x,
 *  y=up=Eden z, z=Eden y) for a ramp's sloped-top triangular prism, per the orientation convention
 *  documented (and verified against `emit_wedge`/`emit_ramp`) in blockDefs.ts: `dir` 0=S/1=W/2=N/3=E
 *  is the HIGH edge — full height there, tapering to zero at the opposite edge. Returns the 6 prism
 *  corners as [cap-at-low-extrusion-end (A,B,C), cap-at-high-extrusion-end (D,E,F)] — B/E are the
 *  low-height right-angle corners of each triangular end cap.
 */
function rampPrismCorners(dir: 0 | 1 | 2 | 3): THREE.Vector3[] {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  switch (dir) {
    case 0: return [V(0, 0, 0), V(0, 0, 1), V(0, 1, 1), V(1, 0, 0), V(1, 0, 1), V(1, 1, 1)]; // S: high at z=1
    case 2: return [V(0, 0, 1), V(0, 0, 0), V(0, 1, 0), V(1, 0, 1), V(1, 0, 0), V(1, 1, 0)]; // N: high at z=0
    case 1: return [V(1, 0, 0), V(0, 0, 0), V(0, 1, 0), V(1, 0, 1), V(0, 0, 1), V(0, 1, 1)]; // W: high at x=0
    default: return [V(0, 0, 0), V(1, 0, 0), V(1, 1, 0), V(0, 0, 1), V(1, 0, 1), V(1, 1, 1)]; // E: high at x=1
  }
}

/** B3 wedge placement preview: local unit-cell footprint triangle (in the x,z plane), extruded
 *  through the full height (y 0..1) — a wedge is a constant-cross-section triangular prism, unlike
 *  a ramp's height taper. `dir` 0=SE/1=SW/2=NW/3=NE names the solid right-angle corner (verified
 *  against `emit_wedge`, see blockDefs.ts's `orientBlockToFacing` doc comment). Returns [P1,P2,P3]
 *  at y=0 — P1 is the right-angle corner. */
function wedgeFootprintCorners(dir: 0 | 1 | 2 | 3): [THREE.Vector2, THREE.Vector2, THREE.Vector2] {
  const V = (x: number, z: number) => new THREE.Vector2(x, z);
  switch (dir) {
    case 0: return [V(1, 1), V(0, 1), V(1, 0)]; // SE: right angle at (x=1,z=1)
    case 1: return [V(0, 1), V(1, 1), V(0, 0)]; // SW
    case 2: return [V(0, 0), V(1, 0), V(0, 1)]; // NW
    default: return [V(1, 0), V(0, 0), V(1, 1)]; // NE
  }
}

/** Builds the 9-edge (18-point) wireframe of a ramp or wedge prism in local unit-cell space, for a
 *  THREE.LineSegments' position attribute. */
function prismWireframePoints(kind: "ramp" | "wedge", dir: 0 | 1 | 2 | 3): Float32Array {
  let a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, e: THREE.Vector3, f: THREE.Vector3;
  if (kind === "ramp") {
    [a, b, c, d, e, f] = rampPrismCorners(dir);
  } else {
    const [p1, p2, p3] = wedgeFootprintCorners(dir);
    a = new THREE.Vector3(p1.x, 0, p1.y); b = new THREE.Vector3(p2.x, 0, p2.y); c = new THREE.Vector3(p3.x, 0, p3.y);
    d = new THREE.Vector3(p1.x, 1, p1.y); e = new THREE.Vector3(p2.x, 1, p2.y); f = new THREE.Vector3(p3.x, 1, p3.y);
  }
  const edges: [THREE.Vector3, THREE.Vector3][] = [
    [a, b], [b, c], [c, a], // cap 1
    [d, e], [e, f], [f, d], // cap 2
    [a, d], [b, e], [c, f], // connecting
  ];
  const out = new Float32Array(edges.length * 6);
  edges.forEach(([p, q], i) => {
    out.set([p.x, p.y, p.z, q.x, q.y, q.z], i * 6);
  });
  return out;
}

/** Reach for *informational* picks — hover in select mode, the eyedropper, flood-fill seeds. Build
 *  mode uses the separate, user-configurable `buildReach` prop instead (H5): a 250-block pick is a
 *  useful readout, but a 250-block *edit* lands where the 1-block outline is already sub-pixel. */
const PICK_DIST = 256;
/** Hover-highlight repick cadence. ~30Hz — one ~1ms IPC round-trip per tick is well inside budget. */
const PICK_HOVER_MS = 33;
/** M2: a click reuses the hover pick that drove the outline instead of re-picking, as long as it's
 *  fresher than this and the cursor hasn't moved. A few ticks' worth of slack past PICK_HOVER_MS. */
const HOVER_PICK_REUSE_MS = 100;
/** A pointerdown/up pair inside this many px and ms is a click, not a look-drag or an orbit drag. */
const CLICK_SLOP_PX = 4;
const CLICK_SLOP_MS = 250;
/** Held break/place: delay before the first repeat (must exceed CLICK_SLOP_MS so a quick click never
 *  races the repeat timer), then the steady repeat interval. Mirrors the sculpt hold-timer's cadence.
 *  Since H4 this interval is only the *stationary airbrush* fallback — a real sweep is driven by
 *  pointermove, so it stamps at pointer rate rather than every BUILD_REPEAT_MS. */
const BUILD_REPEAT_DELAY_MS = 300;
const BUILD_REPEAT_MS = 220;
/** Hard watchdog on one build gesture. Replaces C1's BUILD_REPEAT_IDLE_TICKS, which parked the hold
 *  after 3 no-op ticks — correct for the old "stationary hold marches a tower" model, but it would
 *  now kill a sweep that merely paused. The IPC-spin half of that fix is covered better by the
 *  aim-change gate in `buildRepeatTick` (an unchanged aim doesn't even issue a pick); this bounds the
 *  remaining case, a hold whose pointerup the webview never delivers at all. */
const BUILD_GESTURE_MAX_MS = 20_000;
/** Trailing debounce on the *lighting halo* half of an edit's chunk reload (C3 steps 2–3). Long
 *  enough that a build sweep — whose stamps arrive far faster than this — pays the halo exactly once,
 *  on release, instead of once per placed block. Short enough that a single click's lit/shadowed seam
 *  settles before you notice it. */
const HALO_FLUSH_MS = 350;

/** A wireframe box overlay in Eden world coordinates (Three.js coords are derived internally). */
export interface Overlay3D {
  /** Three.js min corner: [eden_x, eden_z, eden_y] */
  min: [number, number, number];
  /** Three.js max corner: [eden_x, eden_z, eden_y] */
  max: [number, number, number];
  color: number;
  /** Which parts to draw. Default "full" = translucent fill + wireframe edges (single-box overlays). */
  style?: "full" | "fill" | "edges";
  /** When set, the overlay is an extruded prism of this XY footprint (grid-corner contour `loops`,
   *  solid `caps` rects for the top/bottom faces) between Eden z `zBottom`..`zTop`, instead of the
   *  min/max box. This is how a shaped wand/lasso selection renders: one seam-free prism whose walls
   *  sit only on the true boundary, so there are no internal coincident faces to double-blend.
   *  `min`/`max` are ignored while `shape` is set (kept for the bbox fallback). */
  shape?: { loops: OutlinePt[][]; caps: MaskRect[]; zBottom: number; zTop: number };
}

type HudData = { x: number; y: number; z: number; heading: string; boost: "sprint" | "crawl" | null; angleDeg: number };
interface CoordHudRef { set: (d: HudData | null) => void }

/// Axis compass (D2) — a passive dial tracking camera yaw. The ring (N/E/S/W) rotates opposite the
/// camera's heading so the fixed centre arrow (always "up" on screen = the camera's forward) reads
/// against it, like a minimap compass. Kept inside the same leaf/set() as the coord readout so a
/// turning camera doesn't cost a second imperative channel or a second re-render source.
const CompassDial = ({ angleDeg }: { angleDeg: number }) => {
  const pt = (deg: number, label: string, dim: boolean) => {
    const rad = (deg * Math.PI) / 180;
    const r = 8;
    return (
      <span key={label} style={{
        position: "absolute", left: `calc(50% + ${Math.sin(rad) * r}px)`, top: `calc(50% - ${Math.cos(rad) * r}px)`,
        transform: "translate(-50%,-50%)", fontSize: 7, fontWeight: dim ? 400 : 700,
        color: dim ? "#61584f" : "#dad6d2",
      }}>{label}</span>
    );
  };
  return (
    <div title="Camera heading" style={{
      position: "relative", width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
      background: "rgba(0,0,0,0.25)", border: "1px solid rgba(131,120,108,0.35)",
    }}>
      <div style={{ position: "absolute", inset: 0, transform: `rotate(${-angleDeg}deg)` }}>
        {pt(0, "N", false)}
        {pt(90, "E", true)}
        {pt(180, "S", true)}
        {pt(270, "W", true)}
      </div>
      {/* Fixed forward arrow — doesn't rotate; represents "up on screen = where the camera looks". */}
      <span style={{
        position: "absolute", left: "50%", top: 2, transform: "translateX(-50%)",
        fontSize: 8, color: "#34d399", lineHeight: 1,
      }}>▲</span>
    </div>
  );
};

/// Self-contained leaf for the camera-coords readout. The render loop pushes into it imperatively
/// (~10 Hz) so a moving camera re-renders only this <div>, not the whole 3D pane. Same pattern as
/// App's FpsCounter. Also carries the live SPRINT/CRAWL badge and the compass angle — both change far
/// too often to route through App-visible React state.
const CoordHud = forwardRef<CoordHudRef>(function CoordHud(_props, ref) {
  const [hud, setHud] = useState<HudData | null>(null);
  useImperativeHandle(ref, () => ({ set: setHud }), []);
  if (!hud) return null;
  return (
    <div style={{
      position: "absolute", bottom: 6, left: 6, zIndex: 1, pointerEvents: "none",
      padding: "2px 7px", borderRadius: 4, fontSize: 9, fontVariantNumeric: "tabular-nums",
      background: "rgba(31,28,26,0.7)", border: "1px solid rgba(131,120,108,0.3)", color: "#afa69d",
      display: "flex", alignItems: "center", gap: 6,
    }}>
      <CompassDial angleDeg={hud.angleDeg} />
      <span>X {hud.x} · Y {hud.y} · Z {hud.z} · {hud.heading}</span>
      {hud.boost && (
        <span style={{
          padding: "0 4px", borderRadius: 3, fontWeight: 700, letterSpacing: "0.04em",
          color: hud.boost === "sprint" ? "#34d399" : "#60a5fa",
          background: hud.boost === "sprint" ? "rgba(52,211,153,0.15)" : "rgba(96,165,250,0.15)",
        }}>{hud.boost === "sprint" ? "SPRINT" : "CRAWL"}</span>
      )}
    </div>
  );
});

/** Dev-only geometry-memory readout (3D-pane crash fix, Stage 0). Everything here is measured, not
 *  modelled: `gpu`/`js` come from the envelope's own `lens` header, so "did the Stage 1 upload-release
 *  actually land" is directly visible as `js` staying near zero while `gpu` climbs to the budget. */
type GeomMemData = {
  chunks: number; gpu: number; js: number; inflight: number; peak: number; maxChunk: number; budget: number;
};
interface GeomMemHudRef { set: (d: GeomMemData) => void }

const MB = (b: number) => `${(b / (1 << 20)).toFixed(b >= (100 << 20) ? 0 : 1)}M`;

const GeomMemHud = forwardRef<GeomMemHudRef>(function GeomMemHud(_props, ref) {
  const [d, setD] = useState<GeomMemData | null>(null);
  useImperativeHandle(ref, () => ({ set: setD }), []);
  if (!d) return null;
  const frac = d.budget > 0 ? (d.gpu + d.inflight) / d.budget : 0;
  return (
    <div
      title="Dev build only — resident 3D chunk geometry. gpu = uploaded VBO bytes, js = wire buffers still on the JS heap (should stay near 0 once uploads land), fly = in-flight fetch reservations."
      style={{
        position: "absolute", bottom: 6, right: 6, zIndex: 1, pointerEvents: "none",
        padding: "2px 7px", borderRadius: 4, fontSize: 9, fontVariantNumeric: "tabular-nums",
        background: "rgba(31,28,26,0.7)", border: "1px solid rgba(131,120,108,0.3)",
        color: frac > 0.9 ? "#ef4444" : "#83786c", lineHeight: 1.5,
      }}>
      <div>{d.chunks} chunks · gpu {MB(d.gpu)} / {MB(d.budget)} · js {MB(d.js)} · fly {MB(d.inflight)}</div>
      <div>peak {MB(d.peak)} · max chunk {MB(d.maxChunk)}</div>
    </div>
  );
});

const FlyView3D = forwardRef<FlyView3DRef, {
  world: WorldMeta; editEpoch?: number; lastEdit?: EditBounds | null;
  /** Initial camera target in Eden local block coords (x = east, y = south). Spawns the camera
   *  over real geometry; falls back to the world centre when null/undefined. */
  spawnAt?: { x: number; y: number } | null;
  /** Increments once per world load (distinct from spawnAt changing for other reasons, like the
   *  user setting a spawn point mid-session). The re-centre effect keys off this — not spawnAt's
   *  coordinates — so setting a spawn point or clearing it while flying doesn't yank the camera. */
  worldLoadToken?: number;
  onFlyModeChange?: (active: boolean) => void;
  onCameraMove?: (wx: number, wy: number) => void;
  overlays3d?: Overlay3D[] | null;
  /** Decoded atlas data from a loaded texture pack, or null when none loaded. */
  texturePack?: AtlasData | null;
  /** Increments whenever the texture pack changes (loaded/unloaded/toggled). */
  texEpoch?: number;
  /** Distance fog fading terrain to the sky color, matching the game's look. Default true. */
  fogEnabled?: boolean;
  /** Night lighting preview — dims ambient, lights up Lamp blocks within reach. Default false. */
  nightLighting?: boolean;
  /** Directional sun-raycast shadow preview. Default false. */
  shadows3d?: boolean;
  /** Simulated sun position driving the shadow direction: 0=sunrise, 0.5=noon, 1=sunset. Default 0.5. */
  sunT?: number;
  /** Lamp light radius (blocks) for night lighting. Default 4 (the "legacy" profile's default radius). */
  lampRadius?: number;
  /** Which shipped lighting behaviour the falloff curve follows — "legacy" (tight ~4-tile pool,
   * steep falloff) or "modern" ("New Dawn", ~14-tile pool, gradual falloff). Default "legacy". */
  lightingProfile?: LightingProfile;
  /** Increments whenever nightLighting/shadows3d/sunT changes, forcing a chunk-mesh reload. */
  lightEpoch?: number;
  /** Persisted render-distance (chunk radius) to seed the R slider from. Default LOAD_RADIUS. */
  initialRenderDistance?: number;
  /** Persisted fly-speed multiplier to seed from. Default 1. */
  initialFlySpeed?: number;
  /** Fired (debounced by the parent) when the user changes render distance, so it can be persisted. */
  onRenderDistanceChange?: (n: number) => void;
  /** Fired when the user changes fly speed (wheel), so it can be persisted. */
  onFlySpeedChange?: (n: number) => void;
  /** Mouse-look sensitivity multiplier in grabbed-cursor LOOK mode. Default 1. */
  lookSensitivity?: number;
  /** Mouse-look sensitivity multiplier for fly-mode drag-to-look. Default 1. */
  dragSensitivity?: number;
  /** Flips pitch direction (mouse up = look down) in both look and drag-to-look. Default false. */
  invertY?: boolean;
  /** True while any App-level modal dialog is open — the fly-mode "Z" toggle and WASD movement keys
   *  are suppressed so typing in a modal's text field never engages the fly camera. */
  anyModalOpen?: boolean;
  /** What a click does in this pane. "select" → onPickSelect; "build" → onPickBreak/onPickPlace. */
  interact3d?: Interact3D;
  /** Left click in "select" mode: the voxel under the cursor. App owns the two-click state machine. */
  onPickSelect?: (x: number, y: number, z: number) => void;
  /** Left click in "floodfill" mode: the picked block face + its normal. App flood-fills the
   *  connected air cell against that face (`hit + normal`) as the start cell. */
  onPickFloodFill?: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => void;
  /** Left click in "build" mode: the voxel to clear. `group` (H1) ties every break/place stamp
   *  of one gesture (a sweep, or a single click) to the same backend undo group, so a 2-second
   *  drag collapses to one undo entry instead of one per stamp. */
  onPickBreak?: (x: number, y: number, z: number, group?: number) => void;
  /** Right click in "build" mode: the empty voxel against the picked face, where a block goes.
   *  `yaw` is the player's horizontal look direction in Eden coords (atan2(dx, dy), 0 = South),
   *  so App can auto-orient directional blocks to face the player. `group`: see onPickBreak. */
  onPickPlace?: (x: number, y: number, z: number, yaw: number, group?: number) => void;
  /** Fires once when a build gesture (single click or sweep) ends with at least one stamp — the
   *  cue for App to show one summary toast instead of one per stamp (H1). */
  onBuildGestureEnd?: (mode: "break" | "place", count: number) => void;
  /** Middle click in "build" mode: pick the block/paint under the cursor as the new armed block
   *  (mirrors the 2D eyedropper). Not offered in "select"/"sculpt" — keeps scope to build mode. */
  onPickEyedrop?: (blockType: number, paint: number) => void;
  /** Build shape ≠ "single" (B1): commits a batched break/place run — the whole line/box in one
   *  `with_edit` call, one undo step. */
  onPickBreakBatch?: (cells: [number, number, number][]) => void;
  onPickPlaceBatch?: (cells: [number, number, number][], yaw: number) => void;
  /** Build shape "fill" (B2): a one-click face-fill bucket. `(x,y,z)` is the clicked wall's solid
   *  seed block, `(nx,ny,nz)` its face normal — the backend flood-fills the coplanar same-type run
   *  behind that face and re-skins ("place") or clears ("break") it in one `with_edit` call. */
  onPickFillFace?: (x: number, y: number, z: number, nx: number, ny: number, nz: number, mode: "break" | "place", yaw?: number) => void;
  /** Current 3D selection box (Eden coords), or null/undefined. Auto-shows the Select-mode transform
   *  gizmo (centre move-cube + 3 axis-move arrows + 3 plane-resize squares + 6 face-resize handles)
   *  whenever `interact3d==="select"` and this is non-null. */
  selectionBounds3d?: SelectionBounds3D | null;
  /** Commits a gizmo face-resize, or an arrow-move while the pane's Region⇄Blocks toggle is set to
   *  Region: the whole selection region moved/resized with no backend edit (App just writes
   *  rawBounds/zMin/zMax, mirroring the existing box-only arrow-nudge path). */
  onGizmoRegionChange?: (b: SelectionBounds3D) => void;
  /** Commits a gizmo arrow-move while the toggle is set to Blocks: relocates the selection's contents
   *  via the undoable `move_selection` backend command (App applies the EditResult and shifts
   *  rawBounds/zMin/zMax by the same delta). Resize (face handles) is always region-only. */
  onGizmoMoveBlocks?: (dx: number, dy: number, dz: number) => void;
  /** Shared "move box + contents" toggle (App state, mirrored from the Selection ribbon tab). When
   *  true a gizmo arrow-move relocates the selection's blocks (undoable); when false it moves the
   *  region only. The in-pane ⇄ pill flips this same state, so 2D and 3D stay in lock-step. */
  moveWithContents?: boolean;
  setMoveWithContents?: (fn: (v: boolean) => boolean) => void;
  /** Data-URL swatch of the armed fill block, shown in the corner while building. */
  armedSwatch?: string | null;
  /** Human-readable name of the armed fill block, shown next to the swatch. */
  armedLabel?: string;
  /** Raw armed block type id (unoriented) — drives the B3 ramp/wedge placement preview, which needs
   *  the numeric id (not just the display swatch/label) to detect ramp/wedge families and resolve
   *  their oriented variant the same way `handlePick3dPlace` will. */
  armedBlockType?: number;
  /** Whether auto-orient is on (mirrors App's `autoOrient3d` setting) — the placement preview shows
   *  the oriented shape auto-orient would place, or the raw armed variant verbatim when off. */
  autoOrient3d?: boolean;
  /** Max distance (blocks) a build-mode break/place may reach (H5, `AppSettings.buildReach`).
   *  Build-mode *hover* picks at the same distance, so the placement outline simply doesn't appear
   *  past the cap and a click there does nothing — the refusal is visible, not silent. Select mode,
   *  the eyedropper and flood-fill deliberately keep the full `PICK_DIST`. Default 64. */
  buildReach?: number;
  /** In-pane hotbar overlay data (build mode only), 10 slots: index 0-4 pinned (null = empty pin
   *  slot, digit key 1-5), index 5-9 recent (digit key 6-0). Precomputed by App so this component
   *  doesn't need its own resolveColor/tintedSwatch import. */
  hotbarSlots?: ({ type: number; paint: number; css: string; label: string } | null)[];
  /** Currently-armed block+paint, to ring-highlight the matching hotbar slot. */
  activeBlock?: { type: number; paint: number };
  /** Click a hotbar slot to arm it (mirrors the Ribbon hotbar / digit keys). */
  onHotbarSelect?: (type: number, paint: number) => void;
  /** Sets what a click does in this pane (the in-pane VIEW/SELECT/BUILD/SCULPT pill). Mirrors the
   *  Ribbon 3D tab's mode picker — both write App's mode3d, so they stay in sync. */
  onSetInteract3d?: (m: Interact3D) => void;
  /** Active sculpt tool id (App's shared `tool` — one of the ten sculpt names) while in sculpt mode.
   *  Used to branch grab vs the timer-stamp path and to label the armed-hint readout. */
  sculptTool?: string;
  /** Live sculpt brush radius (blocks). Drives both the per-stamp radius and the brush-disc cursor
   *  size; read fresh per stamp so a mid-stroke `[`/`]` resize takes effect immediately. */
  sculptRadius?: number;
  /** Live sculpt strength — shown in the armed-hint readout only. */
  sculptStrength?: number;
  /** Fires one sculpt stamp at a picked surface column. App reads the rest of the brush params
   *  (mode/strength/softness/profile/noise) from its own shared sculpt state and applies `use_cap:false`. */
  onSculptStamp3d?: (opts: {
    stampCx: number; stampCy: number; stampRadius: number; groupId: number;
    anchor?: [number, number]; grabDelta?: number; smear?: [number, number];
  }) => void | Promise<void>;
  /** Opt-in real GPU shadow map: switches chunk meshes to a lit material + a directional sun with a
   *  shadow map, and fetches flat (unshaded) geometry. Overrides the baked night/shadow preview.
   *  Makes sunT free (moving the sun just repositions the light — no chunk reload). Default false. */
  gpuShadows?: boolean;
  /** Hard cap on resident chunk-geometry bytes (all three streams, plus the payloads of in-flight
   *  fetches) — memory-budget preset (§6 of the 2026-08 memory-efficiency pass, retuned to bytes by
   *  the 3D-pane crash fix). Default `GEOMETRY_BUDGET_BYTES` (512 MB, "Balanced").
   *  Note this only *pauses streaming* once crossed (see the `budgetLimited` gate below) — it never
   *  evicts, so a stationary camera at a lower preset simply plateaus at a smaller resident set. */
  geometryBudgetBytes?: number;
  /** Non-fatal warning channel (WebGL context loss/restore). Same idiom as `SliceViewport.onNotice`:
   *  the pane's only other escape hatch is *throwing*, which the ErrorBoundary turns into a full-pane
   *  replacement — wrong for a condition the pane recovers from on its own. */
  onNotice?: (msg: string) => void;
  /** Cutaway ceiling (App's `viewCapZ`), or null for none. Purely a cache-invalidation key here —
   *  the cap itself is backend state (`WorldState.view_cap_z`) and `get_chunk_geometry` applies it
   *  to the emitted z band on its own. Changing it reloads every resident chunk. */
  viewCapZ?: number | null;
  /** Suspended = mounted but not visible (3D pane switched off, or quad view left). Parks the rAF
   *  loop and the streaming sweep and drops every resident chunk mesh, so a hidden pane costs
   *  essentially nothing — but keeps its WebGL context, which is the point: repeatedly creating and
   *  destroying contexts is what walks WKWebView into its live-context ceiling (Stage 4). */
  suspended?: boolean;
}>(function FlyView3D({
  world, editEpoch = 0, lastEdit = null, spawnAt = null, worldLoadToken = 0, onFlyModeChange, onCameraMove, overlays3d = null,
  texturePack = null, texEpoch = 0, fogEnabled = true,
  nightLighting = false, shadows3d = false, sunT = 0.5, lampRadius = 4, lightingProfile = "legacy", lightEpoch = 0,
  initialRenderDistance, initialFlySpeed, onRenderDistanceChange, onFlySpeedChange, anyModalOpen = false,
  lookSensitivity = 1, dragSensitivity = 1, invertY = false,
  interact3d = "none", onPickSelect, onPickFloodFill, onPickBreak, onPickPlace, onBuildGestureEnd, onPickEyedrop, armedSwatch = null, armedLabel = "",
  onPickBreakBatch, onPickPlaceBatch, onPickFillFace,
  armedBlockType = 0, autoOrient3d = true, buildReach = 64,
  selectionBounds3d = null, onGizmoRegionChange, onGizmoMoveBlocks,
  moveWithContents = false, setMoveWithContents,
  hotbarSlots, activeBlock, onHotbarSelect,
  onSetInteract3d,
  sculptTool = "raise", sculptRadius = 6, sculptStrength = 2, onSculptStamp3d,
  gpuShadows = false,
  geometryBudgetBytes = GEOMETRY_BUDGET_BYTES,
  onNotice,
  viewCapZ = null,
  suspended = false,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [camMode, setCamMode] = useState<CamMode>("orbit");
  const camModeRef = useRef<CamMode>("orbit");
  // True in any walking mode (fly or look) — gates WASD, the crosshair, wheel-speed, and picking,
  // all of which behave identically in both. `camModeRef` is only consulted where the two differ
  // (pointer lock + cursor hiding). Kept as a boolean ref to avoid churning every gate site.
  const flyModeRef = useRef(false);
  const hoverRef = useRef(false);      // pointer over this pane — gates the Z fly-toggle
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Set by the scene effect; lets the pill button and Z key advance the camera mode.
  const cycleModeRef = useRef<(() => void) | null>(null);
  const speedMultRef = useRef(initialFlySpeed ?? 1);   // wheel-adjustable fly-speed multiplier
  const [flySpeed, setFlySpeed] = useState(initialFlySpeed ?? 1);
  const [loadRadius, setLoadRadius] = useState(initialRenderDistance ?? LOAD_RADIUS);
  const loadRadiusRef = useRef(initialRenderDistance ?? LOAD_RADIUS);
  const [distanceWarnOpen, setDistanceWarnOpen] = useState(false);
  // Controls legend popover (D1) — a discoverable, always-available reminder for every pane binding,
  // including the ones with no on-canvas affordance (Alt-crawl, Esc drag-cancel precedence, etc.).
  // M4: the pane itself is easy to miss (two nested toggles, now one — see ViewTab) and once open its
  // control reference lived only behind a 14px "?". Auto-open it the first time this component ever
  // mounts (it mounts once and is suspended/resumed thereafter, never remounted — see the module doc
  // on "suspend-don't-unmount" — so "first mount" is exactly "first time the pane is used").
  const [legendOpen, setLegendOpen] = useState(() => {
    try { return localStorage.getItem(FLY3D_LEGEND_SEEN_KEY) !== "true"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(FLY3D_LEGEND_SEEN_KEY, "true"); } catch { /* quota / private mode */ }
  }, []);
  const [loadingCount, setLoadingCount] = useState(0);
  const setLoadingCountRef = useRef(setLoadingCount);
  const [budgetLimited, setBudgetLimited] = useState(false);
  const setBudgetLimitedRef = useRef(setBudgetLimited);

  const onRenderDistanceChangeRef = useRef(onRenderDistanceChange);
  onRenderDistanceChangeRef.current = onRenderDistanceChange;
  const onFlySpeedChangeRef = useRef(onFlySpeedChange);
  onFlySpeedChangeRef.current = onFlySpeedChange;
  // Read fresh inside the long-lived scene-setup effect's pump() closure below, mirroring the two
  // refs above — a mid-session Settings preset change takes effect on the next pump without
  // needing this deep effect's own dependency array to grow.
  const geometryBudgetRef = useRef(geometryBudgetBytes);
  geometryBudgetRef.current = geometryBudgetBytes;
  // Non-fatal notice channel, mirrored into a ref so the big scene effect's dep array stays stable
  // (SliceViewport's idiom). The context-loss handlers below are its only callers today.
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  // Read once at the end of scene init: the scene effect re-runs on a world change, which builds a
  // fresh (unsuspended) closure while the `suspended` prop may already be true — and the prop-driven
  // effect below won't fire, because the prop itself didn't change.
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  // Dev-only geometry-memory readout (3D-pane crash fix, Stage 0). Fed imperatively like CoordHud so
  // the ~7 Hz updates re-render one leaf <div>, not the whole pane.
  const memHudRef = useRef<GeomMemHudRef | null>(null);

  // initialRenderDistance/initialFlySpeed only seed useState's initial value — they don't otherwise
  // propagate, so a Settings reload/reset that changes the persisted value out from under this pane
  // (Settings modal Save/Reset) would silently desync the slider from what's actually persisted.
  // Harmless to also fire on mount/on the pane's own onChange round-trip: it sets the same value
  // that's already current, which React no-ops.
  useEffect(() => {
    if (initialRenderDistance == null) return;
    loadRadiusRef.current = initialRenderDistance;
    setLoadRadius(initialRenderDistance);
  }, [initialRenderDistance]);
  useEffect(() => {
    if (initialFlySpeed == null) return;
    speedMultRef.current = initialFlySpeed;
    setFlySpeed(initialFlySpeed);
  }, [initialFlySpeed]);

  // Camera position/heading HUD (Eden coords), refreshed at the ~10fps broadcast cadence.
  const hudRef = useRef<CoordHudRef | null>(null);

  // C3 steps 2–3: the deferred lighting-halo half of the edit-sync reload rect. Keys are `"cx,cy"`,
  // accumulated across every edit inside one HALO_FLUSH_MS window (i.e. one build sweep) and flushed
  // together. See the edit-sync effect below for why the core chunks are *not* deferred.
  const haloKeysRef = useRef<Set<string>>(new Set());
  const haloTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (haloTimerRef.current) clearTimeout(haloTimerRef.current); }, []);

  // Lamp/shadow reach, fetched once from Rust so the edit-sync reload radius below can't drift out
  // of sync with export.rs's LAMP_LIGHT_RADIUS/SHADOW_RAY_STEPS constants. Seeded with those same
  // values as a fallback in case the fetch hasn't landed yet (a stale/undersized radius for one
  // frame is harmless — the next edit reloads correctly once the fetch resolves).
  const lightConstantsRef = useRef({ lampLightRadius: 4.0, shadowRayScan: 24 });
  useEffect(() => {
    let cancelled = false;
    invoke<{ lamp_light_radius: number; shadow_ray_steps: number }>("get_light_constants")
      .then((c) => {
        if (cancelled) return;
        lightConstantsRef.current = { lampLightRadius: c.lamp_light_radius, shadowRayScan: c.shadow_ray_steps };
      })
      .catch(() => { /* fall back to the seeded defaults */ });
    return () => { cancelled = true; };
  }, []);

  const mapW = chunkToWorld(world.width_chunks);
  const mapH = chunkToWorld(world.height_chunks);
  const maxZ = world.max_z;

  const onFlyModeChangeRef = useRef(onFlyModeChange);
  onFlyModeChangeRef.current = onFlyModeChange;
  const onCameraMoveRef = useRef(onCameraMove);
  onCameraMoveRef.current = onCameraMove;
  const anyModalOpenRef = useRef(anyModalOpen);
  anyModalOpenRef.current = anyModalOpen;

  // Read via refs (like the picking props below) so a Settings change applies live without
  // tearing down/remounting the scene effect.
  const lookSensitivityRef = useRef(lookSensitivity);
  lookSensitivityRef.current = lookSensitivity;
  const dragSensitivityRef = useRef(dragSensitivity);
  dragSensitivityRef.current = dragSensitivity;
  const invertYRef = useRef(invertY);
  invertYRef.current = invertY;

  // Picking props read through refs: the scene effect subscribes once and must see the live values
  // without tearing down the renderer every time the user switches tool or fill block.
  const interact3dRef = useRef(interact3d);
  interact3dRef.current = interact3d;
  const onPickSelectRef = useRef(onPickSelect);
  onPickSelectRef.current = onPickSelect;
  const onPickFloodFillRef = useRef(onPickFloodFill);
  onPickFloodFillRef.current = onPickFloodFill;
  const onPickBreakRef = useRef(onPickBreak);
  onPickBreakRef.current = onPickBreak;
  const onPickPlaceRef = useRef(onPickPlace);
  onPickPlaceRef.current = onPickPlace;
  const onBuildGestureEndRef = useRef(onBuildGestureEnd);
  onBuildGestureEndRef.current = onBuildGestureEnd;
  const onPickEyedropRef = useRef(onPickEyedrop);
  onPickEyedropRef.current = onPickEyedrop;
  const onPickBreakBatchRef = useRef(onPickBreakBatch);
  onPickBreakBatchRef.current = onPickBreakBatch;
  const onPickPlaceBatchRef = useRef(onPickPlaceBatch);
  onPickPlaceBatchRef.current = onPickPlaceBatch;
  const onPickFillFaceRef = useRef(onPickFillFace);
  onPickFillFaceRef.current = onPickFillFace;
  const armedBlockTypeRef = useRef(armedBlockType);
  armedBlockTypeRef.current = armedBlockType;
  const autoOrient3dRef = useRef(autoOrient3d);
  autoOrient3dRef.current = autoOrient3d;
  // Clamped to the picker's own hard ceiling: a reach past PICK_DIST could never resolve anyway, and
  // a non-positive one would make build mode silently inert with no way to tell from the UI.
  const buildReachRef = useRef(buildReach);
  buildReachRef.current = Math.max(1, Math.min(PICK_DIST, buildReach));

  // Build shape toggle (B1) — pane-local (no App state needed; a shape gesture reduces to the same
  // batched place/break callbacks either way). Toggle-only, no keyboard modifier (stays clash-free
  // per the shortcut audit — Alt/Ctrl/Shift are all already spoken for in this pane).
  const [buildShape, setBuildShape] = useState<BuildShape>("single");
  const buildShapeRef = useRef(buildShape);
  buildShapeRef.current = buildShape;
  // Whether a line/box gesture's start cell is currently armed — read by the build-mode hint text.
  // Low-frequency (flips twice per gesture), so a plain setState re-render here is fine.
  const [buildShapeArmed, setBuildShapeArmed] = useState(false);

  // Gizmo props/state read through refs by the scene closure (see "3D selection gizmo" below).
  const selectionBounds3dRef = useRef(selectionBounds3d);
  selectionBounds3dRef.current = selectionBounds3d;
  const onGizmoRegionChangeRef = useRef(onGizmoRegionChange);
  onGizmoRegionChangeRef.current = onGizmoRegionChange;
  const onGizmoMoveBlocksRef = useRef(onGizmoMoveBlocks);
  onGizmoMoveBlocksRef.current = onGizmoMoveBlocks;
  // Region⇄Blocks toggle for gizmo arrow-moves is the SHARED App `moveWithContents` state (also
  // driven by the Selection ribbon tab's Move: Box/Contents pill) — mirrored into a ref so the scene
  // closure reads it live. `moveWithContents === true` ⇒ arrow-move relocates blocks (undoable).
  const moveWithContentsRef = useRef(moveWithContents);
  moveWithContentsRef.current = moveWithContents;
  // Sculpt props read through refs by the scene closure (live values without a scene teardown).
  const sculptToolRef = useRef(sculptTool);
  sculptToolRef.current = sculptTool;
  const sculptRadiusRef = useRef(sculptRadius);
  sculptRadiusRef.current = sculptRadius;
  const onSculptStamp3dRef = useRef(onSculptStamp3d);
  onSculptStamp3dRef.current = onSculptStamp3d;

  // Grab tool's live vertical-drag displacement, shown in the armed-hint readout. null when no grab
  // drag is active. Set imperatively from the scene closure's pointer handlers.
  const [grabReadout, setGrabReadout] = useState<number | null>(null);

  const overlays3dRef = useRef(overlays3d);
  useEffect(() => { overlays3dRef.current = overlays3d; }, [overlays3d]);

  // Read via ref so the spawn target can update (new world) without tearing down the scene.
  const spawnAtRef = useRef(spawnAt);
  spawnAtRef.current = spawnAt;

  // Floor grid visibility (D3) — pane-local, default on. World-bounds box + axes stay on regardless;
  // the grid is the noisiest of the three at a glance, so it's the one worth an opt-out.
  const [gridVisible, setGridVisible] = useState(true);
  const gridVisibleRef = useRef(gridVisible);
  gridVisibleRef.current = gridVisible;

  // In-pane fog on/off override (null = follow the fogEnabled prop / Settings default). Lets the user
  // flip fog without opening Settings; the Settings default still applies on load.
  const [fogOverride, setFogOverride] = useState<boolean | null>(null);
  const effectiveFogEnabled = fogOverride ?? fogEnabled;
  const fogEnabledRef = useRef(effectiveFogEnabled);
  fogEnabledRef.current = effectiveFogEnabled;

  // Night lighting / shadow preview toggles — read via refs by startFetch (defined once per world
  // mount), same pattern as fogEnabledRef.
  const nightLightingRef = useRef(nightLighting);
  nightLightingRef.current = nightLighting;
  const shadows3dRef = useRef(shadows3d);
  shadows3dRef.current = shadows3d;
  const sunTRef = useRef(sunT);
  sunTRef.current = sunT;
  const lampRadiusRef = useRef(lampRadius);
  lampRadiusRef.current = lampRadius;
  const lightingProfileRef = useRef(lightingProfile);
  lightingProfileRef.current = lightingProfile;
  const gpuShadowsRef = useRef(gpuShadows);
  gpuShadowsRef.current = gpuShadows;

  // Fog model: soft = exponential (FogExp2, hazier / more fog-like); hard = linear (the default).
  const [fogSoft, setFogSoft] = useState(false);
  const fogSoftRef = useRef(fogSoft);
  fogSoftRef.current = fogSoft;

  // Antialiasing toggle — off by default (supersampling has a real GPU cost). Independent of pane
  // maximize state; the renderer's own `antialias` flag can't be toggled live (would need a full
  // context recreate), so this bumps DPR to 2 for supersample-style smoothing instead.
  const [antialias, setAntialias] = useState(false);

  // Editor-only fog/sky color override — never written back to world.sky (the file's saved sky
  // color table). Defaults to a Minecraft-like light blue rather than the world's own (often muddy)
  // sky paint; the ↺ button reverts to the world's actual sky color on request.
  const [fogColorOverride, setFogColorOverride] = useState<string | null>(DEFAULT_SKY_COLOR);
  // Night lighting darkens the fog/clear color toward the same ambient level baked into block
  // colors server-side, so distant terrain doesn't fade into a bright daytime sky while lit dim.
  const effectiveFogColor = (): readonly [number, number, number] => {
    const [r, g, b] = fogColorOverride ? hexToRgb(fogColorOverride) : skyFogColor(world.sky);
    return nightLighting ? [r * 0.35, g * 0.35, b * 0.35] : [r, g, b];
  };
  const fogColorRef = useRef(effectiveFogColor());
  fogColorRef.current = effectiveFogColor();

  // Texture pack refs — updated by a dedicated effect, read by startFetch inside the scene closure.
  const texMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  // Textured variant for the transparent stream (water/glass/fence) — same atlas, `transparent: true`
  // so both the block's own alpha (transparent_alpha, baked into vertex colour) and the atlas tile's
  // own PNG alpha (e.g. a glass cutout) composite correctly.
  const texMatTRef = useRef<THREE.MeshBasicMaterial | null>(null);
  // Lit (Lambert) textured variants, used only in GPU-shadow mode (built alongside the Basic ones).
  const texMatLRef = useRef<THREE.MeshLambertMaterial | null>(null);
  const texMatLTRef = useRef<THREE.MeshLambertMaterial | null>(null);
  // Textured custom depth material for the transparent stream's patterned shadow (fence weave). Built
  // in the texture effect (needs the atlas); the untextured fallback lives in the scene closure.
  const depthMatTexRef = useRef<THREE.MeshDepthMaterial | null>(null);
  const atlasTexRef = useRef<THREE.DataTexture | null>(null);

  // Stable refs so the effect can be re-run only on world change, while edit-sync and fly-mode
  // toggles flow through refs without tearing down the scene.
  const sceneApi = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    reloadChunk: (cx: number, cy: number) => void;
    reloadAllChunks: () => void;
    resetCamera: () => void;
    teleport: (wx: number, wy: number) => void;
    setOverlays: (ovs: Overlay3D[] | null) => void;
    setFog: (enabled: boolean, color: readonly [number, number, number]) => void;
    setMaxDpr: (max: number) => void;
    setGridVisible: (v: boolean) => void;
    setGpuShadows: (on: boolean) => void;
    /** Park/resume the pane while it's mounted but hidden (Stage 4). Suspending disposes every
     *  resident chunk mesh; resuming re-measures the canvas and restreams from the camera. */
    setSuspended: (on: boolean) => void;
    /** Re-apply scene light state for the current (gpuShadows, nightLighting) combo — no chunk reload. */
    updateGpuLighting: () => void;
    /** Re-query lamp point lights around the camera (GPU night only). */
    refreshNightLights: () => void;
    refresh: () => void;
    /** H3: re-pick and redraw the placement/select outline immediately, bypassing the hover throttle —
     *  called after every edit so the box never shows a stale pre-edit target. */
    refreshHighlight: () => void;
    clearHighlight: () => void;
    /** Cancel any live sculpt hold-timer/grab stroke and hide the brush-disc cursor. */
    clearSculpt: () => void;
    /** Enable/disable OrbitControls' LEFT mouse action (disabled while sculpt or build owns left-drag). */
    setOrbitLeftEnabled: (enabled: boolean) => void;
    /** Hand RIGHT-drag to build mode's place-sweep and move camera orbit onto MIDDLE-drag (H4).
     *  Call *after* `setOrbitLeftEnabled` — it also resets the Alt-held override. */
    setOrbitBuildMode: (on: boolean) => void;
    /** Cancel a live line/box build-shape gesture (armed start cell, no commit). */
    clearBuildShape: () => void;
    /** Show/hide + (re)lay out the Select-mode transform gizmo. No-op while a drag is in progress
     *  (the live preview box owns the visual until release). */
    setGizmoSelection: (mode: Interact3D, b: SelectionBounds3D | null) => void;
  } | null>(null);

  useImperativeHandle(ref, () => ({
    teleport: (wx, wy) => sceneApi.current?.teleport(wx, wy),
  }), []);

  // Dispose + (re)build the texture-pack materials from `pack` (or leave them disposed if null).
  // Shared by two triggers: the texture-pack-identity effect below, and the world-dimensions reinit
  // effect — the latter's cleanup disposes these same refs as part of a full scene teardown (see its
  // comment), but doesn't re-run the texture-pack effect (its dependency, `texturePack`, hasn't
  // changed identity), so without this second call site new chunks after a resize/reload would
  // permanently bake in the untextured fallback material until the user reloaded the pack.
  const rebuildTextureMaterials = (pack: AtlasData | null) => {
    if (atlasTexRef.current) { atlasTexRef.current.dispose(); atlasTexRef.current = null; }
    if (texMatRef.current) { texMatRef.current.dispose(); texMatRef.current = null; }
    if (texMatTRef.current) { texMatTRef.current.dispose(); texMatTRef.current = null; }
    if (texMatLRef.current) { texMatLRef.current.dispose(); texMatLRef.current = null; }
    if (texMatLTRef.current) { texMatLTRef.current.dispose(); texMatLTRef.current = null; }
    if (depthMatTexRef.current) { depthMatTexRef.current.dispose(); depthMatTexRef.current = null; }
    if (pack) {
      const { rgba, tile, rows } = pack;
      const tex = new THREE.DataTexture(
        new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        tile, tile * rows,
        THREE.RGBAFormat,
      );
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      // Greedy meshing (Stage 5) emits merged quads whose U runs 0..N, one unit per block tiled, so
      // U must repeat. The atlas is exactly one tile wide and N tiles tall (`texturepack.rs`), so
      // repeating in U re-tiles the same column and can never bleed into a neighbouring block's row.
      // V is left clamped on purpose — it *selects* the row, which is why the Rust side refuses to
      // merge along V whenever a pack is loaded.
      tex.wrapS = THREE.RepeatWrapping;
      tex.flipY = false;
      tex.needsUpdate = true;
      atlasTexRef.current = tex;
      texMatRef.current = new THREE.MeshBasicMaterial({
        map: tex, vertexColors: true, side: THREE.DoubleSide,
      });
      // Shares the same atlas texture as the opaque material; `transparent: true` lets the tile's
      // own PNG alpha (e.g. a glass cutout) and the block's per-vertex alpha both composite.
      texMatTRef.current = new THREE.MeshBasicMaterial({
        map: tex, vertexColors: true, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      });
      // Lit (Lambert) variants for GPU-shadow mode, sharing the same atlas texture. `flatShading` so
      // no CPU normal pass is needed (see matL above).
      texMatLRef.current = new THREE.MeshLambertMaterial({
        map: tex, vertexColors: true, side: THREE.DoubleSide, flatShading: true,
      });
      texMatLTRef.current = new THREE.MeshLambertMaterial({
        map: tex, vertexColors: true, side: THREE.DoubleSide, transparent: true, depthWrite: false, flatShading: true,
      });
      // Textured depth variant for the transparent stream's shadow: `alphaTest` on the atlas tile so a
      // fence weave's transparent texels punch a lattice into the shadow; the vertex-alpha discard
      // (patchDepthAlpha) still keeps water/glass/flower from casting at all.
      const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5 });
      patchDepthAlpha(dm);
      depthMatTexRef.current = dm;
    }
  };

  // True once this component is going away for good, as opposed to the scene effect merely re-running
  // (world resize, StrictMode's double-mount, HMR). React runs a component's effect cleanups in
  // effect-definition order, so declaring this *above* the scene effect guarantees the flag is set
  // before the scene cleanup below reads it — which is what lets that cleanup release the WebGL
  // context on a real unmount without breaking the reuse case. Reset in the effect body so a
  // StrictMode remount starts clean.
  const unmountingRef = useRef(false);
  useEffect(() => {
    unmountingRef.current = false;
    return () => { unmountingRef.current = true; };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let renderer: THREE.WebGLRenderer;
    try {
      // antialias:false — at DPR ≤1.5 in a small quad-view cell, MSAA's fragment cost outweighs the
      // marginal edge quality. Disabling it buys steady-state fps headroom next to 3 other panes.
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    } catch (e) {
      // Genuine WebGL-unavailable (driver/webview without a usable context). Surface a clear
      // message to the error boundary instead of a cryptic THREE internal stack.
      throw new Error(`WebGL unavailable in this environment. (${(e as Error)?.message ?? e})`);
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));

    // Guard the remainder of init: if anything throws after the context exists, release it before
    // rethrowing. React skips an effect's cleanup when the effect body throws, so without this a
    // failed init would leak a live WebGL context on every mount/retry.
    try {

    // Render-on-demand: only draw when something actually changed (camera moved, chunks streamed,
    // resize) or while actively flying. Avoids burning the GPU at 60fps next to 3 other quad-view panes.
    // `invalidate` schedules a single rAF frame; `frame` reschedules itself only while fly/damping
    // need continuous updates. `frame` is a hoisted function declaration so `invalidate` can safely
    // reference it before the definition site.
    let dirty = false;
    let rafPending = false;
    // Declared here (not at the render-loop block below) because `invalidate` writes `raf` and is
    // called synchronously by the first `resize()` during init — referencing it later would hit the
    // temporal dead zone and throw "cannot access uninitialized variable", blanking the pane.
    let raf = 0;
    // Stage 4: mounted-but-hidden. Declared here (not next to `contextLost` below) because
    // `invalidate` closes over it and runs during init. See `setSuspended` for what it parks.
    let suspendedNow = false;
    const invalidate = () => {
      dirty = true;
      if (suspendedNow) return; // nothing to paint into — the pane isn't on screen
      if (rafPending) return;
      rafPending = true;
      raf = requestAnimationFrame(frame);
    };

    const scene = new THREE.Scene();
    // No scene lights — directional shading is baked into vertex colours by the Rust geometry pass
    // (obj_geometry_region SH_TOP/BOT/E/W/N/S constants).  MeshBasicMaterial renders vertex colours
    // directly with no normal calculations, eliminating the computeVertexNormals CPU spike and the
    // normal attribute buffer (~⅓ of geometry RAM).

    // ---- Gradient sky dome ----
    // A large inverted sphere painted with a fixed vertical gradient (#c5d5eb horizon → #347ee3
    // zenith) that follows the camera, so the background reads as sky rather than a flat wall — and
    // stays visible when fog is off. `fog:false` keeps the dome itself unfogged. The gradient is
    // independent of the fog/sky color, which only drives the renderer clear color and terrain fog.
    const skyUniforms = {
      topColor: { value: new THREE.Color(0x347ee3) },
      bottomColor: { value: new THREE.Color(0xc5d5eb) },
      offset: { value: 0.0 },
      exponent: { value: 0.7 },
    };
    const skyMat = new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPos;
        void main() {
          float h = normalize(vWorldPos - cameraPosition).y;
          float t = pow(clamp((h + offset), 0.0, 1.0), exponent);
          gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
        }`,
    });
    const skyDome = new THREE.Mesh(new THREE.SphereGeometry(4000, 24, 12), skyMat);
    skyDome.renderOrder = -1; // draw first, behind everything
    scene.add(skyDome);

    // Fog fades distant terrain to the sky color, matching the game's fog. The renderer's clear color
    // is set to match so empty sky beyond geometry blends seamlessly with the fog (the sky dome itself
    // keeps its own fixed gradient regardless). Soft = exponential (FogExp2, hazier); hard = linear.
    // Camera far plane stays at 100000 (untouched) — fog gives the faded look without capping
    // visibility/editing range.
    const setFog = (enabled: boolean, color: readonly [number, number, number]) => {
      const hex = (color[0] << 16) | (color[1] << 8) | color[2];
      renderer.setClearColor(hex);
      if (enabled) {
        const { near, far } = fogDistances(loadRadiusRef.current);
        scene.fog = fogSoftRef.current
          ? new THREE.FogExp2(hex, 2.2 / far)
          : new THREE.Fog(hex, near, far);
      } else {
        scene.fog = null;
      }
      invalidate();
    };
    setFog(fogEnabledRef.current, fogColorRef.current);

    const setMaxDpr = (max: number) => {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, max));
      resize();
    };

    const cx = mapW / 2, cy = mapH / 2;
    // Camera spawn target — over real geometry when provided (sparse worlds), else world centre.
    const spawnXY = () => {
      const s = spawnAtRef.current;
      return s ? { x: s.x, y: s.y } : { x: cx, y: cy };
    };

    const grid = new THREE.GridHelper(Math.max(mapW, mapH), gridDivisions(world.width_chunks, world.height_chunks));
    grid.position.set(cx, 0, cy);
    grid.visible = gridVisibleRef.current;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(24));

    // World occupies Three.js (0,0,0) → (mapW, maxZ, mapH). Eden north = Three.js −Z.
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(mapW, maxZ, mapH));
    scene.add(new THREE.Box3Helper(box, new THREE.Color(0x1e3a5f)));

    const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 100000);
    // Start south of the spawn target looking north (−Z). Cameras looking in −Z have Eden east
    // (+X) on the right, matching the top-down map.
    {
      const s = spawnXY();
      camera.position.set(s.x, maxZ + 60, s.y + 110);
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    // Snapshot the controls' original button actions so a mode that owns a drag can disable the
    // camera's claim on it (setting an entry to null makes OrbitControls' onMouseDown fall through to
    // STATE.NONE — verified in three's source) and restore *exactly* these values on leaving, rather
    // than hardcoding THREE.MOUSE.ROTATE/PAN/DOLLY.
    const origLeftButton = controls.mouseButtons.LEFT;
    const origRightButton = controls.mouseButtons.RIGHT;
    const origMiddleButton = controls.mouseButtons.MIDDLE;
    const setOrbitLeftEnabled = (enabled: boolean) => {
      controls.mouseButtons.LEFT = enabled ? origLeftButton : null;
    };
    // Build mode (H4) owns BOTH drags: left sweeps break, right sweeps place. Taking RIGHT away from
    // OrbitControls is also what makes C2 (a right-drag pan ending in a stray placed block)
    // structurally impossible rather than merely slop-guarded. The camera keeps a full set of
    // gestures anyway: MIDDLE-drag becomes ROTATE (its DOLLY duty is fully covered by the wheel), and
    // holding Alt hands LEFT/RIGHT back for one drag (see `syncBuildAltOrbit`). Middle *click* stays
    // the eyedropper — `onPickUp`'s isClick slop test already separates a click from a drag.
    let buildOwnsDrag = false;
    let altHeld = false;
    const syncBuildAltOrbit = () => {
      if (!buildOwnsDrag) return;
      controls.mouseButtons.LEFT = altHeld ? origLeftButton : null;
      controls.mouseButtons.RIGHT = altHeld ? origRightButton : null;
    };
    const setOrbitBuildMode = (on: boolean) => {
      buildOwnsDrag = on;
      altHeld = false;
      controls.mouseButtons.RIGHT = on ? null : origRightButton;
      controls.mouseButtons.MIDDLE = on ? THREE.MOUSE.ROTATE : origMiddleButton;
    };
    // Alt is tracked from raw key events rather than read off the pointer event, because
    // OrbitControls reads `mouseButtons` inside its *own* pointerdown handler — whose ordering
    // against ours isn't guaranteed. Keeping the mapping in sync while the key is merely held means
    // it is already correct whenever that handler runs.
    const onAltKey = (e: KeyboardEvent) => {
      if (e.altKey === altHeld) return;
      altHeld = e.altKey;
      syncBuildAltOrbit();
    };
    // Alt+Tab / focus loss never delivers the keyup, which would strand the camera owning left-drag.
    const onAltBlur = () => { if (altHeld) { altHeld = false; syncBuildAltOrbit(); } };
    window.addEventListener("keydown", onAltKey);
    window.addEventListener("keyup", onAltKey);
    window.addEventListener("blur", onAltBlur);
    // Seed the ownership from the live mode. This effect re-runs on a world-size change, building a
    // fresh OrbitControls with its stock mapping, while `interact3d` may already be "sculpt"/"build" —
    // and the mode effect below won't re-fire, because its dependency didn't change.
    setOrbitLeftEnabled(interact3dRef.current !== "sculpt" && interact3dRef.current !== "build");
    setOrbitBuildMode(interact3dRef.current === "build");
    {
      const s = spawnXY();
      controls.target.set(s.x, Math.min(maxZ, 28), s.y);
    }

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      invalidate();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Unlit material — vertex colours carry baked directional shading from Rust.
    // DoubleSide kept: the face winding was designed for the old coordinate convention and is not
    // uniformly outward-facing yet, so FrontSide would drop some faces.
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    // Transparent stream material (water/glass/fence/new-flower). `transparent: true` lets the
    // per-vertex alpha (baked from `transparent_alpha()` server-side) blend; `depthWrite: false`
    // avoids one translucent face occluding another behind it via the depth buffer (standard
    // practice for alpha-blended geometry — mirrors the game keeping ATLAS2 blocks in a separate
    // pass from the opaque ATLAS1 buffer).
    const matT = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, depthWrite: false });

    // ---- Opt-in GPU shadow map (H5) ---------------------------------------------------------
    // When gpuShadows is on, chunk meshes use a LIT material (Lambert) and the scene gets an ambient
    // + directional (sun) light with a shadow map; geometry is fetched flat (gpu:true → Rust bakes no
    // SH_* shading), so Three.js owns all shading. The payoff: moving the sun (sunT) is free — it just
    // repositions the light, no chunk reload, unlike the baked raymarch which rebuilt every mesh.
    // vertexColors still carries the block/paint colour; Lambert multiplies it by the computed light.
    // `flatShading: true` derives flat per-face normals in-shader from the position derivatives, so we
    // don't run `computeVertexNormals()` on the CPU per chunk (its single biggest GPU-mode load cost)
    // nor carry a normal attribute. Voxel faces are exactly the flat-shading case, so this is visually
    // identical to per-vertex normals on this non-indexed geometry.
    const matL = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true });
    const matLT = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, depthWrite: false, flatShading: true });

    // Untextured custom depth material for the transparent stream's shadow pass (see patchDepthAlpha):
    // fence casts, water/glass/flower don't. Without a texture pack the fence shadow is solid (no
    // weave) — still an improvement over the previous no-shadow-at-all. The textured variant with the
    // weave lattice is built in the texture effect (depthMatTexRef).
    const depthMatT = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patchDepthAlpha(depthMatT);

    // Rebuild the texture-pack materials for this fresh scene. This effect's own cleanup disposes
    // texMatRef/atlasTexRef/etc. as part of a full scene teardown (see below), but the separate
    // `[texturePack]` effect that normally (re)builds them won't re-fire here — `texturePack`'s
    // object identity hasn't changed, only the world's dimensions have — so without this call every
    // chunk mesh built by the fresh scene would permanently bake in the untextured fallback material
    // (`hasUV && texMatRef.current ? texMatRef.current : mat`, decided once at mesh-build time).
    rebuildTextureMaterials(texturePack);

    const ambient = new THREE.AmbientLight(0xffffff, 0); // intensities set by applyGpuLighting()
    const sun = new THREE.DirectionalLight(0xffffff, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0006;           // pull the depth test back a hair to kill shadow acne on flats
    sun.shadow.normalBias = 0.6;         // and along steep faces (voxels have large flat facets)
    sun.shadow.radius = 3;               // PCFSoft blur kernel — softer shadow edges than the default 1
    {
      const sc = sun.shadow.camera as THREE.OrthographicCamera;
      sc.near = 1; sc.far = 6000;        // wide range; the ortho box (left/right/top/bottom) tracks the camera
    }
    scene.add(ambient, sun, sun.target);
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Sun disc — a bright billboarded sprite placed up-sun, just inside the sky dome, so the light
    // has a visible source. Occluded by terrain (drawn with depth test); `fog:false` keeps it crisp.
    // Only shown in GPU-shadow mode (the mode with a real directional sun). Its colour warms toward
    // orange at low sun (sunrise/sunset), matching the sun light tint.
    const sunDiscMat = new THREE.SpriteMaterial({ color: 0xfff2c0, fog: false, transparent: true, depthWrite: false });
    const sunDisc = new THREE.Sprite(sunDiscMat);
    sunDisc.scale.setScalar(260);
    sunDisc.renderOrder = 1;
    sunDisc.visible = false;
    scene.add(sunDisc);
    const sunColorScratch = new THREE.Color();
    const WHITE = new THREE.Color(0xffffff);

    // Experimental GPU night lighting: a fixed pool of point lights placed at the nearest lamp blocks
    // (queried from the Rust lamp index via get_lamps_near). Only active when GPU shadows + night are
    // both on; the Lambert chunk material forward-lights each one. Off (invisible, zero intensity)
    // otherwise so the pool never costs anything in day/GPU-shadow mode.
    const nightLights: THREE.PointLight[] = [];
    for (let i = 0; i < MAX_NIGHT_LIGHTS; i++) {
      const pl = new THREE.PointLight(0xffffff, 0, 0);
      pl.visible = false;
      scene.add(pl);
      nightLights.push(pl);
    }

    // Unit vector pointing toward the sun in THREE space, from sunT. Mirrors Rust's `sun_direction`
    // (elevation eases 15°..80°..15° via sin(pi·t); azimuth 0..pi east→west), mapped Eden(x,y,z)→
    // THREE(x,z,y). Used to place the directional light; sunT changes are then just a light move.
    const sunDirThree = (t: number, out: THREE.Vector3) => {
      const az = Math.PI * t;
      const el = (15 * Math.PI) / 180 + Math.sin(Math.PI * t) * ((65 * Math.PI) / 180);
      return out.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
    };
    const sunDirScratch = new THREE.Vector3();

    // Apply the scene's light state for the current (gpuShadows, nightLighting) combo. Meshes are
    // rebuilt by reloadAllChunks() separately (material + normals + castShadow differ per mode).
    //  • GPU + night → GPU night: dim ambient/sun, sun disc off, point-light pool drives the lamps.
    //  • GPU alone    → day sun: bright ambient + directional sun + shadow map + sun disc.
    //  • no GPU       → baked mode: scene lights off (shading is in vertex colours).
    const applyGpuLighting = () => {
      const gpu = gpuShadowsRef.current;
      const night = nightLightingRef.current;
      const gpuNight = gpu && night;
      renderer.shadowMap.enabled = gpu;
      if (gpuNight) {
        ambient.intensity = 0.18; sun.intensity = 0.25; sunDisc.visible = false;
      } else if (gpu) {
        ambient.intensity = 1.5; sun.intensity = 2.0; sunDisc.visible = true;
      } else {
        ambient.intensity = 0; sun.intensity = 0; sunDisc.visible = false;
      }
      if (!gpuNight) {
        for (const pl of nightLights) { pl.visible = false; pl.intensity = 0; }
      } else {
        lastNightQueryPos.set(1e9, 0, 0); // force a re-query on the next frame/trigger
        updateNightLights();
      }
      invalidate();
    };

    // Query the nearest lamp blocks around the camera and assign them to the point-light pool. Runs
    // only in GPU-night mode; throttled by camera movement (from frame()) and fired on enable/edit.
    let nightQueryPending = false;
    const lastNightQueryPos = new THREE.Vector3(1e9, 0, 0);
    const updateNightLights = () => {
      if (nightQueryPending) return;
      if (!(gpuShadowsRef.current && nightLightingRef.current)) return;
      nightQueryPending = true;
      lastNightQueryPos.copy(camera.position);
      // Eden coords: THREE(x,y,z) → Eden(x, z, y). Query a generous radius so lamps just off-screen
      // still light the near terrain; the pool caps how many actually render.
      const ex = camera.position.x, ey = camera.position.z, ez = camera.position.y;
      const queryR = Math.max(48, chunkToWorld(loadRadiusRef.current));
      invoke<LampLight[]>("get_lamps_near", { x: ex, y: ey, z: ez, radius: queryR })
        .then((lamps) => {
          if (disposed) return;
          // Read the slider/profile values here (not before the await) so a mid-flight drag or
          // profile switch isn't stale.
          const lampR = lampRadiusRef.current;
          // `decay` picks which of the two shipped falloff shapes this matches (mirrors the CPU/baked
          // `LightingProfile::falloff` in export.rs): legacy's small, steep-edged pool reads closest to
          // Three's decay=2 (inverse-square); modern's much broader, gradual New Dawn pool reads closer
          // to decay=1. `distance` is the hard cutoff — set it well beyond the nominal lamp radius so
          // the falloff curve isn't clipped right at the edge (a distance==lampR cutoff with 2/d
          // brightness was the "only lit at point-blank range" bug). `intensity` is solved so the
          // brightness AT distance lampR reads ~K regardless of radius or decay (intensity/d^decay = K
          // at d=lampR), so the slider grows reach, not just brightness.
          const K = 0.4;
          const decay = lightingProfileRef.current === "modern" ? 1 : 2;
          const intensity = decay === 2 ? lampR * lampR * K : lampR * K;
          for (let i = 0; i < MAX_NIGHT_LIGHTS; i++) {
            const pl = nightLights[i];
            const l = lamps[i];
            if (l) {
              pl.position.set(l.x, l.z, l.y); // Eden → THREE
              pl.color.setRGB(l.r, l.g, l.b);
              pl.distance = lampR * 4;
              pl.decay = decay;
              pl.intensity = intensity;
              pl.visible = true;
            } else {
              pl.visible = false;
              pl.intensity = 0;
            }
          }
          invalidate();
        })
        .catch(() => { /* no world / no lamps */ })
        .finally(() => { nightQueryPending = false; });
    };
    applyGpuLighting();

    // Pick the chunk-mesh material for the current mode. GPU mode → Lambert (textured if a pack row
    // exists); baked mode → the unlit Basic materials.
    const pickMat = (transparent: boolean, hasUV: boolean): THREE.Material => {
      if (gpuShadowsRef.current) {
        if (transparent) return (hasUV && texMatLTRef.current) ? texMatLTRef.current : matLT;
        return (hasUV && texMatLRef.current) ? texMatLRef.current : matL;
      }
      if (transparent) return (hasUV && texMatTRef.current) ? texMatTRef.current : matT;
      return (hasUV && texMatRef.current) ? texMatRef.current : mat;
    };

    // ---- Per-chunk mesh cache ----
    const meshes = new Map<string, THREE.Mesh>();
    const meshesT = new Map<string, THREE.Mesh>();
    // Emissive stream — lamp-block faces in GPU mode, drawn unlit so lamps stay fullbright. Empty in
    // baked mode (Rust routes lamp faces into the opaque stream then).
    const meshesE = new Map<string, THREE.Mesh>();
    const inflight = new Set<string>();
    const key = (cx: number, cy: number) => `${cx},${cy}`;

    // Marks a chunk "fetched" when its geometry came back entirely air/transparent, so the sweep
    // doesn't keep refetching it. A plain key set — not a shared sentinel mesh, which would need
    // `.dispose()`d every time an empty chunk is evicted despite never being added to the scene.
    const emptyChunks = new Set<string>();
    // L1: `meshesT` belongs here for symmetry with residentKeys() below. Not live today (a chunk
    // with zero opaque verts always also lands in `emptyChunks`), but that's a property of one
    // branch in startFetch, not an invariant — a transparent-only mesh installed without it would
    // otherwise be refetched forever by the sweep.
    const isResident = (k: string) => meshes.has(k) || meshesT.has(k) || meshesE.has(k) || emptyChunks.has(k);
    /** Every key this cache is holding anything for — the eviction/teardown iteration set. */
    const residentKeys = () => new Set([...meshes.keys(), ...meshesT.keys(), ...meshesE.keys(), ...emptyChunks]);

    // ---- Resident-geometry accounting (3D-pane crash fix, Stages 0–1) ----
    // Running totals, in bytes, rather than a re-sum over every mesh on each pump():
    //   residentBytes  — GPU VBO bytes for installed meshes (each mesh's own wire payload).
    //   jsBytes        — wire buffers still pinned on the JS heap. Every attribute array is a *view*
    //                    over the one IPC envelope for its chunk (zero-copy, from the H2 pass), so a
    //                    single surviving view pins all nine buffers. The `onUpload` release below
    //                    drops them once the GPU has the data, which is what halves resident memory.
    //   inflightBytes  — reserved estimate per in-flight fetch, so up to `maxConcurrent()` dense
    //                    chunks landing at once can't overshoot the budget (the old gate tested
    //                    resident-only, *before* starting a fetch).
    let residentBytes = 0;
    let jsBytes = 0;
    let inflightBytes = 0;
    let peakBytes = 0;
    let maxChunkBytes = 0;
    let budgetLimited = false;
    // Per-fetch reservation, recorded at start so a mid-flight estimate change can't desync the
    // running total. Seeded at 2 MB and tracked as an EWMA of observed payloads — a fresh session on
    // a dense 256z world converges within the first few chunks.
    let chunkEstimateBytes = 2 << 20;
    const reserved = new Map<string, number>();

    // Drop the CPU-side copy of each attribute once the GPU has it. Chunk meshes are never raycast
    // (picking is the Rust-side DDA `pick_block`; the only THREE.Raycaster here tests gizmoHandles)
    // and nothing ever sets `needsUpdate` on them, so `array` has no reader after upload —
    // `computeBoundingSphere()` has already run at install time, so frustum culling keeps working off
    // the cached sphere. ⚠️ This makes the geometry unrecoverable after a GPU context loss: three
    // re-uploads from `attribute.array`. The `webglcontextrestored` handler below therefore *must*
    // call reloadAllChunks() — the two changes are load-bearing on each other.
    const releaseOnUpload = (mesh: THREE.Mesh) => {
      for (const attr of Object.values(mesh.geometry.attributes)) {
        if (!(attr instanceof THREE.BufferAttribute)) continue;
        const bytes = attr.array.byteLength;
        attr.onUpload(function (this: THREE.BufferAttribute) {
          if (this.array === null) return;
          jsBytes -= bytes;
          mesh.userData.jsBytes = (mesh.userData.jsBytes as number) - bytes;
          (this as unknown as { array: ArrayLike<number> | null }).array = null;
        });
      }
    };

    /** Install a chunk mesh: scene + cache + byte accounting + the upload-release hook. */
    const addChunkMesh = (map: Map<string, THREE.Mesh>, k: string, mesh: THREE.Mesh, bytes: number) => {
      mesh.userData.geomBytes = bytes;
      mesh.userData.jsBytes = bytes;
      residentBytes += bytes;
      jsBytes += bytes;
      releaseOnUpload(mesh);
      scene.add(mesh);
      map.set(k, mesh);
    };

    const dropChunkMesh = (map: Map<string, THREE.Mesh>, k: string) => {
      const m = map.get(k);
      if (!m) return;
      residentBytes -= (m.userData.geomBytes as number) ?? 0;
      jsBytes -= (m.userData.jsBytes as number) ?? 0;
      scene.remove(m);
      m.geometry.dispose();
      map.delete(k);
    };

    const disposeMesh = (k: string) => {
      dropChunkMesh(meshes, k);
      dropChunkMesh(meshesT, k);
      dropChunkMesh(meshesE, k);
      emptyChunks.delete(k);
      invalidate();
    };

    // Push the dev memory readout. Called wherever the totals move; the HUD is its own leaf, so this
    // costs one small re-render and nothing else. No-ops entirely in a production build.
    const pushMemHud = import.meta.env.DEV
      ? () => {
          const total = residentBytes + jsBytes + inflightBytes;
          if (total > peakBytes) peakBytes = total;
          memHudRef.current?.set({
            chunks: meshes.size + emptyChunks.size,
            gpu: residentBytes, js: jsBytes, inflight: inflightBytes,
            peak: peakBytes, maxChunk: maxChunkBytes, budget: geometryBudgetRef.current,
          });
        }
      : () => {};

    // Bounded-concurrency fetch queue. The streaming sweep can need ~100 chunks; firing them all at
    // once floods the IPC bridge and the world mutex (each get_chunk_geometry locks it), tanking fps.
    // We keep a bounded number of requests in flight, pulling nearest-to-camera first.
    // Concurrency is throttled while flying: each fetch locks the world mutex and its callback builds a
    // BufferGeometry + uploads to the GPU on the main thread. Four of those landing in one frame causes
    // a visible hitch as you fly into new terrain, so we drop to 2 in-flight while the camera is moving
    // (smoother stream-in) and use the full 4 when idle/orbiting (faster fill, hitches don't matter).
    const MAX_CONCURRENT_IDLE = 4;
    const MAX_CONCURRENT_FLY = 2;
    const maxConcurrent = () => (flyModeRef.current ? MAX_CONCURRENT_FLY : MAX_CONCURRENT_IDLE);
    let active = 0;
    let queue: { cx: number; cy: number }[] = [];
    // Last camera chunk streamSweep actually swept from — lets a stationary camera's interval
    // tick early-out instead of redoing the O((2r+1)²) disc scan + Set-union + string-split dispose
    // pass 6.7×/second for nothing (audit M6). Reset to an impossible value so the very first sweep
    // (and any forced sweep via reloadChunk/reloadAllChunks/camera-move) always runs in full.
    let lastSweepCcx = Number.NaN, lastSweepCcy = Number.NaN;

    // ---- Camera z band (Stage 3) ----
    // Ceiling of the z range each chunk fetch scans, quantized so it only moves in Z_BAND_STEP jumps.
    // `null` = no clip: on a world short enough that the band already covers it (every 64z world, and
    // a 256z one whenever the camera is high), we omit the parameter entirely so the request is
    // byte-for-byte the pre-Stage-3 one. The cutaway cap is NOT folded in here — the backend applies
    // `view_cap_z` itself; this pane only has to invalidate when it changes (see the viewCapZ effect).
    const zBandTop = (): number | null => {
      const top = Math.ceil((camera.position.y + Z_BAND_ABOVE) / Z_BAND_STEP) * Z_BAND_STEP;
      return top >= maxZ ? null : top;
    };
    // Band the resident meshes were actually built with. `undefined` = never computed, so the first
    // sweep always installs one (a legitimate value of `null` must not read as "unchanged").
    let zBand: number | null | undefined = undefined;

    // Monotonic generation counter + per-key stale set: a fetch that resolves after its chunk was
    // force-reloaded (edit) or the whole cache was invalidated (texture/lighting toggle) must not
    // install its result — it may predate the change it's racing against. `fetchGen` invalidates
    // every in-flight fetch at once (reloadAllChunks); `staleKeys` invalidates one specific in-flight
    // fetch (reloadChunk) without bumping the generation for everything else.
    let fetchGen = 0;
    const staleKeys = new Set<string>();
    // Keys allowed to refetch *while still resident* — the edit-sync reload path (C3 step 1). It used
    // to dispose the mesh up front, which is what made every placed block punch a visible hole in the
    // terrain for a full round-trip; the replacement is installed atomically by the disposeMesh(k)
    // already in startFetch's .then(), so the old geometry can simply stay up until it arrives.
    const forceKeys = new Set<string>();
    /** Residency gate shared by pump() and startFetch, so neither can skip a forced reload. */
    const wantsFetch = (k: string) => !inflight.has(k) && (!isResident(k) || forceKeys.has(k));

    const startFetch = (cxk: number, cyk: number) => {
      const k = key(cxk, cyk);
      if (!wantsFetch(k)) return;
      forceKeys.delete(k); // consumed — this fetch IS the forced one
      inflight.add(k);
      active++;
      // Reserve this fetch's estimated payload against the budget for as long as it's in flight.
      // Without it, pump()'s gate tests only what's already resident and up to `maxConcurrent()`
      // dense chunks can land past the cap together.
      reserved.set(k, chunkEstimateBytes);
      inflightBytes += chunkEstimateBytes;
      setLoadingCountRef.current(inflight.size);
      const gen = fetchGen;
      // zMax = the camera band's ceiling (Stage 3); zMin stays 0 — see Z_BAND_ABOVE on why the band
      // is one-sided. `undefined` means "no clip" and is what a 64z world always sends.
      invoke<ArrayBuffer>("get_chunk_geometry", { cx: cxk, cy: cyk, night: nightLightingRef.current, shadows: shadows3dRef.current, sunT: sunTRef.current, gpu: gpuShadowsRef.current, lampRadius: lampRadiusRef.current, lightingProfile: lightingProfileRef.current, zMax: zBand ?? undefined })
        .then((buf) => {
          if (disposed) return;
          const g: VoxelGeometry = decodeGeometry(buf);
          // Feed the in-flight estimator from every landed payload, including the stale ones below —
          // a dropped result still measured a real chunk of this world.
          const payload = g.bytes + g.bytes_t + g.bytes_e;
          if (payload > maxChunkBytes) maxChunkBytes = payload;
          chunkEstimateBytes = Math.round(chunkEstimateBytes * 0.8 + payload * 0.2);
          if (gen !== fetchGen || staleKeys.has(k)) return; // stale — dropped; finally{} requeues if needed
          disposeMesh(k); // replace any existing mesh (reload path)
          if (g.vertex_count > 0) {
            const geom = new THREE.BufferGeometry();
            geom.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
            geom.setAttribute("color", new THREE.BufferAttribute(g.colors, 3));
            // Add UV attribute when the pack is loaded (uvs is a non-empty float stream).
            const hasUVs = g.uvs && g.uvs.length > 0;
            if (hasUVs) {
              geom.setAttribute("uv", new THREE.BufferAttribute(g.uvs, 2));
            }
            // No CPU normals: baked mode is unlit (shading is in the vertex colours), and GPU mode's
            // Lambert materials use `flatShading` (normals derived in-shader). Voxel faces are exactly
            // the flat-shading case, so this is visually identical to per-vertex normals here.
            geom.computeBoundingSphere(); // cheap frustum-cull test per frame
            const mesh = new THREE.Mesh(geom, pickMat(false, !!hasUVs));
            mesh.castShadow = mesh.receiveShadow = gpuShadowsRef.current;
            addChunkMesh(meshes, k, mesh, g.bytes);
          } else {
            // Marks the chunk "fetched" even when it's air (or all-transparent, e.g. an all-water
            // chunk went entirely into meshesT) — `isResident(k)` is what stops it from being refetched.
            emptyChunks.add(k);
          }
          if (g.vertex_count_t > 0) {
            const geomT = new THREE.BufferGeometry();
            geomT.setAttribute("position", new THREE.BufferAttribute(g.positions_t, 3));
            // RGBA (itemSize 4) — Three.js reads a 4-component color attribute as vertex alpha too.
            geomT.setAttribute("color", new THREE.BufferAttribute(g.colors_t, 4));
            const hasUVsT = g.uvs_t && g.uvs_t.length > 0;
            if (hasUVsT) {
              geomT.setAttribute("uv", new THREE.BufferAttribute(g.uvs_t, 2));
            }
            geomT.computeBoundingSphere();
            const meshT = new THREE.Mesh(geomT, pickMat(true, !!hasUVsT));
            // Transparent blocks receive shadows, and in GPU mode also cast *patterned* ones via a
            // customDepthMaterial (patchDepthAlpha): water/glass/flower discard in the shadow pass so
            // light passes straight through (no shadow, as before), while fence casts — its weave tile
            // punches a lattice when a texture pack is loaded (textured depth variant), else a solid
            // fence shadow. A plain opaque castShadow would wrongly shadow-block glass and water.
            meshT.receiveShadow = gpuShadowsRef.current;
            meshT.castShadow = gpuShadowsRef.current;
            meshT.customDepthMaterial = (hasUVsT && depthMatTexRef.current) ? depthMatTexRef.current : depthMatT;
            addChunkMesh(meshesT, k, meshT, g.bytes_t);
          }
          // Emissive stream (lamp faces, GPU mode only). Drawn with the UNLIT Basic material so lamps
          // stay fullbright under the scene's dim night ambient — matching the baked path and the game.
          // castShadow (lamps are solid); receiveShadow off (fullbright anyway). No normals needed
          // (Basic is unlit; the shadow depth pass doesn't consume them meaningfully here).
          if (g.vertex_count_e > 0) {
            const geomE = new THREE.BufferGeometry();
            geomE.setAttribute("position", new THREE.BufferAttribute(g.positions_e, 3));
            geomE.setAttribute("color", new THREE.BufferAttribute(g.colors_e, 3));
            const hasUVsE = g.uvs_e && g.uvs_e.length > 0;
            if (hasUVsE) {
              geomE.setAttribute("uv", new THREE.BufferAttribute(g.uvs_e, 2));
            }
            geomE.computeBoundingSphere();
            const emissiveMat = (hasUVsE && texMatRef.current) ? texMatRef.current : mat;
            const meshE = new THREE.Mesh(geomE, emissiveMat);
            meshE.castShadow = true;
            meshE.receiveShadow = false;
            addChunkMesh(meshesE, k, meshE, g.bytes_e);
          }
          invalidate();
        })
        .catch(() => { /* no world / out of range */ })
        .finally(() => {
          inflight.delete(k);
          active--;
          inflightBytes -= reserved.get(k) ?? 0;
          reserved.delete(k);
          const wasStale = staleKeys.delete(k);
          if (disposed) return;
          if (wasStale) queue.unshift({ cx: cxk, cy: cyk }); // requeue immediately — its result was dropped
          pump();
          setLoadingCountRef.current(inflight.size);
          pushMemHud();
        });
    };

    const pump = () => {
      // H6: once resident geometry crosses the byte budget, stop pulling new chunks — the queue
      // stays populated and resumes once eviction (moving the camera) frees headroom. Only calls
      // setState on an actual transition so this doesn't re-render every pump() (called on every
      // fetch completion). In-flight reservations count too, so a burst of concurrent fetches on a
      // dense 256z world can't land collectively past the cap.
      const overBudget = residentBytes + inflightBytes >= geometryBudgetRef.current;
      if (overBudget !== budgetLimited) {
        budgetLimited = overBudget;
        setBudgetLimitedRef.current(overBudget);
      }
      if (overBudget) return;
      while (active < maxConcurrent() && queue.length) {
        // Re-test per iteration: each startFetch below adds its own reservation, so filling the
        // concurrency slots in one go could otherwise reserve past the cap in a single pump().
        if (residentBytes + inflightBytes >= geometryBudgetRef.current) break;
        const it = queue.shift()!;
        if (!wantsFetch(key(it.cx, it.cy))) continue;
        startFetch(it.cx, it.cy);
      }
      pushMemHud();
    };

    // Camera-window streaming: keep chunks within LOAD_RADIUS of the camera's XY footprint.
    // `force` skips the early-out below — needed by callers that just disposed meshes without
    // moving the camera (reloadAllChunks) or that intentionally want a sweep even though the
    // camera hasn't visibly moved yet (resetCamera/teleport fire this before their tween ticks).
    const streamSweep = (force = false) => {
      const ccx = worldToChunk(camera.position.x);
      const ccy = worldToChunk(camera.position.z); // Three.js Z = Eden Y
      // Vertical travel moves the z band (Stage 3). Every resident mesh was built against the old
      // ceiling, so they're all wrong at once — same invalidation reloadAllChunks() does, inlined
      // here rather than calling it because it re-enters streamSweep. Checked *before* the
      // stationary-camera early-out, which only compares chunk XY and would otherwise miss a purely
      // vertical climb. Quantization (Z_BAND_STEP) is what keeps this rare.
      const nextBand = zBandTop();
      const bandMoved = nextBand !== zBand;
      if (bandMoved) {
        zBand = nextBand;
        fetchGen++;
        queue = [];
        forceKeys.clear();
        for (const k of residentKeys()) disposeMesh(k);
      }
      // A stationary camera with nothing queued has nothing new to do — skip the O((2r+1)²) disc
      // scan and the Set-union + string-split dispose pass below, which otherwise runs unconditionally
      // 6.7×/second (STREAM_MS) for the entire time the 3D pane is open, moving or not (audit M6).
      if (!force && !bandMoved && ccx === lastSweepCcx && ccy === lastSweepCcy && queue.length === 0) {
        return;
      }
      lastSweepCcx = ccx; lastSweepCcy = ccy;
      // Rebuild the work queue each sweep (nearest-first) so the camera's current position drives
      // priority and chunks that fell out of range stop being requested.
      const r = loadRadiusRef.current;
      const needed: { cx: number; cy: number; d2: number }[] = [];
      for (let cy = ccy - r; cy <= ccy + r; cy++) {
        if (cy < 0 || cy >= world.height_chunks) continue;
        for (let cx2 = ccx - r; cx2 <= ccx + r; cx2++) {
          if (cx2 < 0 || cx2 >= world.width_chunks) continue;
          const dx = cx2 - ccx, dy = cy - ccy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r * r) continue;
          if (isResident(key(cx2, cy)) || inflight.has(key(cx2, cy))) continue;
          needed.push({ cx: cx2, cy, d2 });
        }
      }
      needed.sort((a, b) => a.d2 - b.d2);
      queue = needed;
      pump();
      // Dispose far chunks (keep a small hysteresis margin). Euclidean, matching the loading disc
      // above (d2 <= r*r) — a Chebyshev/square test here would let chunks up to ~1.41r+2.8 away
      // survive (the corners of the square), roughly doubling the resident set at large r.
      const dropSq = (r + 2) * (r + 2);
      // Union of all four residency maps. `meshes ∪ emptyChunks` alone happens to cover every key
      // today — a chunk with zero opaque verts is always added to `emptyChunks` — but that is a
      // property of one branch in startFetch, not an invariant anything enforces. A future change
      // that installs a transparent-only or emissive-only mesh without touching `emptyChunks` would
      // silently make those chunks unevictable, which is exactly the leak this budget exists to stop.
      for (const k of residentKeys()) {
        const [kx, ky] = k.split(",").map(Number);
        const dx = kx - ccx, dy = ky - ccy;
        if (dx * dx + dy * dy > dropSq) {
          disposeMesh(k);
        }
      }
      pushMemHud();
    };

    // Forced reload (edit-sync): drop the cached mesh and re-queue it at the front for immediate
    // fetch. If a fetch for this chunk is already in flight, its (possibly pre-edit) result must not
    // land — mark it stale so the .finally{} in startFetch drops it and requeues instead.
    const reloadChunk = (cxk: number, cyk: number) => {
      const k = key(cxk, cyk);
      // Set on both paths: the requeue in startFetch's finally{} runs while the *old* mesh is still
      // resident now that the dispose is no longer eager, so without the force flag the requeued
      // fetch would be skipped as "already resident" and the chunk would keep pre-edit geometry.
      forceKeys.add(k);
      if (inflight.has(k)) {
        staleKeys.add(k);
        return; // requeued by startFetch's finally{} once the stale fetch resolves
      }
      // …unless the pane is already at its geometry budget: pump() refuses to start anything while
      // the old mesh still counts against it, so keeping it resident would strand *pre-edit*
      // geometry indefinitely. There the eager dispose is still right — it frees the headroom the
      // refetch needs, at the cost of the visible hole this change otherwise removes.
      if (residentBytes + inflightBytes >= geometryBudgetRef.current) disposeMesh(k);
      queue.unshift({ cx: cxk, cy: cyk });
      pump();
    };

    // Reload all chunks — called when the texture pack or night/shadow lighting changes so meshes
    // are rebuilt with the new material/lighting. Bumps `fetchGen` so any fetch already in flight
    // (issued under the old pack/lighting) is dropped by startFetch instead of installing stale
    // geometry; it naturally gets re-requested by the next streamSweep tick once its inflight entry
    // clears (no explicit unshift needed here — everything is about to be re-swept anyway).
    const reloadAllChunks = () => {
      fetchGen++;
      queue = [];
      forceKeys.clear();
      for (const k of residentKeys()) disposeMesh(k);
      streamSweep(true); // meshes were just disposed with the camera unmoved — must not early-out
    };

    // ---- Fly controller ----
    const keys = new Set<string>();
    const euler = new THREE.Euler(0, 0, 0, "YXZ");
    let pitch = 0, yaw = 0;

    // Look state. Free-look via pointer lock when it engages; otherwise drag-to-look (hold the mouse
    // button and move) — pointer lock can be silently refused in the webview, so we never depend on it.
    let lookDrag = false;
    let lastMx = 0, lastMy = 0;
    // The OS cursor recentring on grab fires one large synthetic movementX/Y delta — without this
    // flag that first event whips the view around instead of doing nothing.
    let lookJustEngaged = false;

    // Grab/release the OS cursor for look mode via the Tauri window (see set_cursor_lock in lib.rs).
    // Fire-and-forget; swallow errors (e.g. no window focus) — the CSS `cursor:none` still applies.
    const setNativeCursorLock = (locked: boolean) => { void invoke("set_cursor_lock", { locked }).catch(() => {}); };

    // Single transition function for every camera-mode change (Z key, pill button, Esc, reset).
    const applyMode = (next: CamMode) => {
      const prev = camModeRef.current;
      if (next === prev) return;
      const wasWalking = prev !== "orbit";
      const nowWalking = next !== "orbit";

      // Seed yaw/pitch from the live look direction the first time we leave orbit, so the view
      // doesn't jump when mouselook/fly takes over.
      if (!wasWalking && nowWalking) {
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        yaw = Math.atan2(-dir.x, -dir.z);
        pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
        controls.enabled = false;
        // Belt-and-suspenders alongside `enabled = false`: right-drag must never pan the camera
        // while walking (fly/look) — a right-drag-pan felt during mouselook was reported as a bug,
        // even though `enabled = false` alone should already block OrbitControls' own pointer
        // handling. Restored on the way back to orbit below, reflecting whatever build/alt state
        // is live then rather than blindly resetting it.
        controls.mouseButtons.RIGHT = null;
      }

      // Look mode grabs the OS cursor (frozen + hidden app-wide) until it exits; the other modes
      // release it. Delta events keep flowing on macOS so mouselook still steers (see set_cursor_lock).
      if (next === "look") { setNativeCursorLock(true); lookJustEngaged = true; }
      else if (prev === "look") setNativeCursorLock(false);

      if (!nowWalking) {
        // OrbitControls re-aims at `controls.target` the moment it re-enables, and that target is
        // still wherever it was left before flying — usually far behind the camera now, producing a
        // hard snap. Re-sync it to a point ahead of the camera's current facing first.
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        controls.target.copy(camera.position).addScaledVector(dir, 10);
        controls.enabled = true;
        // Restore RIGHT to whatever the live build/alt state says it should be, rather than
        // blindly reinstating `origRightButton` — build mode may still own the drag.
        controls.mouseButtons.RIGHT = buildOwnsDrag ? (altHeld ? origRightButton : null) : origRightButton;
        lookDrag = false;
        keys.clear(); // drop held movement keys so the camera doesn't drift after exit
      }

      camModeRef.current = next;
      setCamMode(next);
      flyModeRef.current = nowWalking;
      if (wasWalking !== nowWalking) onFlyModeChangeRef.current?.(nowWalking);

      // CRITICAL: wake the render loop. The pane renders on demand and the loop only self-sustains
      // once a frame is executing (frame() sets keepGoing while walking). Without this, entering a
      // walking mode from an idle scene leaves WASD/look silently dead until an unrelated event fires.
      if (nowWalking) invalidate();
    };
    const cycleMode = () => applyMode(CAM_MODE_CYCLE[camModeRef.current]);
    cycleModeRef.current = cycleMode;

    const onMouseMove = (e: MouseEvent) => {
      if (!flyModeRef.current) return;
      let dx: number, dy: number, s: number;
      if (camModeRef.current === "look") {
        // Look mode: free mouselook from relative mouse motion. The OS cursor is grabbed, so the
        // cursor is frozen but delta events keep arriving. The grab's first event carries a large
        // synthetic recentring delta (OS cursor warp) — swallow exactly that one.
        if (lookJustEngaged) { lookJustEngaged = false; return; }
        dx = e.movementX; dy = e.movementY;
        s = LOOK_SENS_BASE * lookSensitivityRef.current;
      } else if (lookDrag) {
        // Fly mode: look only while a button is held.
        dx = e.clientX - lastMx; dy = e.clientY - lastMy;
        lastMx = e.clientX; lastMy = e.clientY;
        s = DRAG_SENS_BASE * dragSensitivityRef.current;
      } else return;
      yaw -= dx * s;
      pitch -= (invertYRef.current ? -dy : dy) * s;
      pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    };
    document.addEventListener("mousemove", onMouseMove);

    // Drag-to-look: press on the canvas in *fly* mode to look (look mode uses the grabbed cursor's
    // continuous motion instead). Left button only (button 0) — capturing button 2 is unreliable in
    // macOS WKWebView (see CLAUDE.md's MapCanvas note) and conflicts with right-click-to-place.
    const onCanvasDown = (e: PointerEvent) => {
      // Sculpt mode claims the left button in every camera mode (including fly), so drag-to-look is
      // unavailable while sculpt is armed — the user has look mode + WASD instead. (Documented in the
      // pane's fly-mode hint text.) This is the deliberate tradeoff the sculpt plan accepts.
      if (camModeRef.current !== "fly" || e.button !== 0 || interact3dRef.current === "sculpt") return;
      lookDrag = true; lastMx = e.clientX; lastMy = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onCanvasUp = () => { lookDrag = false; };
    canvas.addEventListener("pointerdown", onCanvasDown);
    canvas.addEventListener("pointerup", onCanvasUp);

    // ---- Voxel picking (select / build) ------------------------------------------------------
    //
    // The ray is cast in Rust (`pick_block`, a voxel DDA over the world bytes), not with
    // THREE.Raycaster: the raycaster would test every triangle of every loaded chunk mesh — millions
    // at a large render distance — whereas the DDA visits ~50 voxels and needs no resident geometry
    // (it can even pick a chunk the streamer hasn't loaded yet).
    //
    // Three.js (x, y, z) ↔ Eden (x = east, y = south, z = up) is the sign-free permutation
    // (ex, ez, ey) that `obj_geometry_region` emits with. Direction transforms identically to
    // position since the map is a pure axis swap. (Note: export.rs's `ov()` — the OBJ *file* writer —
    // negates Y; that mapping does not apply here.)
    const threeToEden = (v: THREE.Vector3) => ({ x: v.x, y: v.z, z: v.y });

    const rayFwd = new THREE.Vector3();
    const rayNdc = new THREE.Vector3();
    /** Ray for the current cursor: the crosshair while flying, else the pointer position. */
    const cursorRay = (clientX: number, clientY: number) => {
      const o = threeToEden(camera.position);
      if (flyModeRef.current) {
        camera.getWorldDirection(rayFwd);
      } else {
        const r = canvas.getBoundingClientRect();
        rayNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1, 0.5);
        rayNdc.unproject(camera);
        rayFwd.copy(rayNdc).sub(camera.position).normalize();
      }
      const d = threeToEden(rayFwd);
      return { ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z };
    };

    // Player's horizontal look direction (Eden yaw, atan2(dx, dy), 0 = South) for auto-orienting
    // placed blocks. Uses the pick ray's horizontal component so it works in both orbit (pointer
    // ray) and look (camera-forward) modes; when the ray is near-vertical (looking straight
    // down/up, no meaningful heading) it falls back to the camera-forward horizontal.
    const placeYaw = (clientX: number, clientY: number): number => {
      const r = cursorRay(clientX, clientY);
      let dx = r.dx, dy = r.dy;
      if (Math.hypot(dx, dy) < 1e-3) {
        camera.getWorldDirection(rayFwd);
        dx = rayFwd.x; dy = rayFwd.z; // Eden (dx, dy) = Three (x, z)
      }
      return Math.atan2(dx, dy);
    };

    /** `maxDist` defaults to the informational reach; build-mode call sites pass `buildReach()`
     *  instead (H5) so a click can never edit further than the outline could show. */
    const pick = async (clientX: number, clientY: number, maxDist: number = PICK_DIST): Promise<PickResult | null> => {
      const r = cursorRay(clientX, clientY);
      try {
        return await invoke<PickResult | null>("pick_block", { ...r, maxDist });
      } catch {
        return null; // no world loaded, or a degenerate ray — treat as a miss
      }
    };
    /** The reach every build-mode pick uses — hover *and* click, so what the outline shows is exactly
     *  what a click can act on. Past it the pick misses, the outline hides, and the click no-ops. */
    const buildReachDist = () => buildReachRef.current;

    // Hover highlight: reused wireframe cubes moved to the picked voxel. Allocated once —
    // rebuilding an EdgesGeometry per pointermove would churn GPU buffers at 30Hz.
    //
    // Build mode has *two* click targets, so it draws two boxes: left-click breaks the block being
    // aimed at (white), right-click places against that face, in the neighbouring cell (green).
    // A single box can only ever preview one of them, which reads as "the click didn't do what the
    // outline said". Select mode uses the primary box alone, on the hit voxel.
    const hlGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    const hlMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 });
    const highlight = new THREE.LineSegments(hlGeom, hlMat);
    highlight.renderOrder = 999;
    highlight.visible = false;
    scene.add(highlight);

    // The break target (build mode only) — dimmer than the placement box so the two read as
    // primary/secondary rather than two equal boxes.
    const hlBreakMat = new THREE.LineBasicMaterial({ color: 0xf8fafc, depthTest: false, transparent: true, opacity: 0.55 });
    const breakHighlight = new THREE.LineSegments(hlGeom, hlBreakMat);
    breakHighlight.renderOrder = 999;
    breakHighlight.visible = false;
    scene.add(breakHighlight);

    // B3 ramp/wedge placement preview — 8 static wireframes (4 ramp dirs + 4 wedge dirs) built once;
    // one shared LineSegments swaps `.geometry` onto whichever is needed per hover tick (cheap, no
    // rebuild) instead of the plain cube, whenever the armed block resolves (after auto-orient, if
    // on) to a ramp/wedge. Shares `hlMat` with the cube highlight — never shown at the same time, so
    // the one shared green/blue color state is never ambiguous.
    const rampPreviewGeoms = ([0, 1, 2, 3] as const).map((d) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(prismWireframePoints("ramp", d), 3));
      return g;
    });
    const wedgePreviewGeoms = ([0, 1, 2, 3] as const).map((d) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(prismWireframePoints("wedge", d), 3));
      return g;
    });
    const placeShapeHighlight = new THREE.LineSegments(rampPreviewGeoms[0], hlMat);
    placeShapeHighlight.renderOrder = 999;
    placeShapeHighlight.visible = false;
    scene.add(placeShapeHighlight);

    // ---- Sculpt brush-disc cursor ----------------------------------------------------------------
    // A flat amber disc laid on top of the hover-picked surface column, sized to the sculpt radius.
    // NOT routed through the box-overlay system (that's corner-keyed min/max) — a dedicated object.
    // Built once (unit radius 1) and repositioned/rescaled per repick, following the same three-pass
    // convention as the overlay boxes: translucent fill body + solid edge ring + dim x-ray ring.
    // Accepted MVP limitation: a flat disc clips into steep slopes (terrain-draped decal deferred).
    const brushGroup = new THREE.Group();
    brushGroup.renderOrder = 999;
    brushGroup.visible = false;
    const brushFillGeom = new THREE.CircleGeometry(1, 48);
    brushFillGeom.rotateX(-Math.PI / 2); // lay flat in the XZ plane (disc normal = +Y, world-up)
    const brushFillMat = new THREE.MeshBasicMaterial({
      color: SCULPT_BRUSH_HEX, transparent: true, opacity: OVERLAY_FILL_OPACITY,
      depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    brushGroup.add(new THREE.Mesh(brushFillGeom, brushFillMat));
    // Edge ring — a closed line loop of unit-radius points in the same XZ plane.
    const ringPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    const brushRingGeom = new THREE.BufferGeometry().setFromPoints(ringPts);
    const brushRingMat = new THREE.LineBasicMaterial({
      color: SCULPT_BRUSH_HEX, transparent: true, opacity: 1, fog: false, toneMapped: false,
    });
    brushGroup.add(new THREE.Line(brushRingGeom, brushRingMat));
    const brushRingXrayMat = new THREE.LineBasicMaterial({
      color: SCULPT_BRUSH_HEX, transparent: true, opacity: OVERLAY_XRAY_OPACITY,
      depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    });
    brushGroup.add(new THREE.Line(brushRingGeom, brushRingXrayMat));
    scene.add(brushGroup);

    // Position the brush disc on the top face of the picked column (Eden voxel top = Three-Y z+1),
    // nudged up slightly to avoid z-fighting with the terrain mesh, and scale it to the radius.
    const placeBrush = (p: PickResult | null) => {
      const want = !!p && interact3dRef.current === "sculpt";
      if (!want) {
        if (brushGroup.visible) { brushGroup.visible = false; invalidate(); }
        return;
      }
      const r = Math.max(0.5, sculptRadiusRef.current);
      brushGroup.position.set(p!.x + 0.5, p!.z + 1.03, p!.y + 0.5); // voxel-centre XZ, top-face Y
      brushGroup.scale.set(r, 1, r);
      brushGroup.visible = true;
      invalidate();
    };

    // ---- Sculpt stroke controller (press-and-hold, not click-based) -------------------------------
    // Unlike build/select's isClick/CLICK_SLOP model, a sculpt stroke is a held gesture: on left-down
    // we start a timer that re-picks the surface and fires a stamp each tick (skip-if-busy, mirroring
    // MapCanvas's 140 ms airbrush), and fire one final stamp on release. Grab is special-cased with no
    // timer (vertical drag sets a displacement, single commit on release), matching the 2D sculpt-grab.
    let sculptGroupSeq = Math.floor(Date.now()); // per-stroke group ids; seeded high so 2D's small
    //                                              strokeIdRef ids never collide with these.
    let sculptTimer: number | null = null;
    let sculptBusy = false;   // a stamp's async edit is in flight — skip overlapping ticks
    let sculptActive = false; // a hold-timer stroke is live
    let sculptGroupId = 0;
    let sculptAnchor: [number, number] | null = null; // stroke-start column (flatten/stamp read it)
    // Smear: like the 2D timer, each tick needs the drag delta *since the previous tick* — the
    // hit column from the previous pick, not the stroke-start anchor.
    let sculptSmearLastPos: [number, number] | null = null;
    // Grab state (no timer).
    let sculptGrab = false;
    let sculptGrabPick: PickResult | null = null;
    let sculptGrabGroup = 0;
    let sculptGrabDownY = 0;
    let sculptGrabDelta = 0;

    const cancelSculptStroke = () => {
      if (sculptTimer !== null) { clearInterval(sculptTimer); sculptTimer = null; }
      sculptActive = false;
      sculptBusy = false;
      sculptAnchor = null;
      sculptSmearLastPos = null;
      sculptGrab = false;
      sculptGrabPick = null;
      sculptGrabDelta = 0;
      setGrabReadout(null);
    };

    // The Eden voxel a right-click (place) acts on, given the picked block. Build mode places
    // against the hit face, so the target is the empty neighbour `hit + normal` — that's what the
    // green box previews and what a right-click fills. Select mode acts on the hit voxel itself.
    const clickTarget = (p: PickResult) =>
      interact3dRef.current === "build"
        ? { x: p.x + p.nx, y: p.y + p.ny, z: p.z + p.nz }
        : { x: p.x, y: p.y, z: p.z };

    // Eden voxel (x,y,z) spans [x,x+1); its centre in Three coords is (x+.5, z+.5, y+.5).
    const placeBox = (box: THREE.LineSegments, x: number, y: number, z: number) =>
      box.position.set(x + 0.5, z + 0.5, y + 0.5);

    const setHighlight = (p: PickResult | null, yaw: number = 0) => {
      const want = !!p && interact3dRef.current !== "none";
      if (!want) {
        if (highlight.visible || breakHighlight.visible || placeShapeHighlight.visible) {
          highlight.visible = false;
          breakHighlight.visible = false;
          placeShapeHighlight.visible = false;
          invalidate();
        }
        return;
      }
      const build = interact3dRef.current === "build";
      const t = clickTarget(p!);
      // Green = placement (build), blue = select — matches the overlay box colours. Shared by the
      // cube and the ramp/wedge shape preview below (never shown at the same time).
      hlMat.color.setHex(build ? 0x22c55e : 0x60a5fa);

      // B3: preview the oriented ramp/wedge shape that would actually be placed here — auto-orient's
      // resolved variant when on, the armed block verbatim when off — instead of a plain cube.
      let shapeGeom: THREE.BufferGeometry | null = null;
      if (build) {
        const previewType = autoOrient3dRef.current
          ? orientBlockToFacing(armedBlockTypeRef.current, yaw)
          : armedBlockTypeRef.current;
        if (rampFamilyBase(previewType) !== null) shapeGeom = rampPreviewGeoms[rampDirIndex(previewType)];
        else if (wedgeFamilyBase(previewType) !== null) shapeGeom = wedgePreviewGeoms[rampDirIndex(previewType)];
      }
      if (shapeGeom) {
        placeShapeHighlight.geometry = shapeGeom;
        placeShapeHighlight.position.set(t.x, t.z, t.y); // cell origin — prism verts already span 0..1
        placeShapeHighlight.visible = true;
        highlight.visible = false;
      } else {
        placeBox(highlight, t.x, t.y, t.z);
        highlight.visible = true;
        placeShapeHighlight.visible = false;
      }
      if (build) placeBox(breakHighlight, p!.x, p!.y, p!.z);
      breakHighlight.visible = build;
      invalidate();
    };

    // Latest cursor position, so the highlight can follow the crosshair while flying (where the
    // pointer is locked and never moves) as well as the pointer while orbiting.
    let cursorX = 0, cursorY = 0;
    let lastPickT = 0;
    let pickInflight = false;
    // M2: the hover pick refreshHighlight just ran drove the outline the user was looking at when
    // they clicked — reusing it for the click itself removes a redundant `pick_block` round trip from
    // every click's latency and guarantees "what the outline showed is what the click did". Only valid
    // when the cursor hasn't moved since that pick and it's still fresh; a stale/mismatched cache falls
    // back to a real pick, so this is purely a latency win, never a correctness risk.
    let lastHoverPick: PickResult | null = null;
    let lastHoverCx = NaN, lastHoverCy = NaN, lastHoverT = 0;
    const pickOrHover = async (cx: number, cy: number, maxDist: number): Promise<PickResult | null> => {
      if (cx === lastHoverCx && cy === lastHoverCy && performance.now() - lastHoverT < HOVER_PICK_REUSE_MS) {
        return lastHoverPick;
      }
      return pick(cx, cy, maxDist);
    };
    const refreshHighlight = async () => {
      const mode = interact3dRef.current;
      // In fly mode the crosshair is the cursor and the pointer may be locked (no pointerenter/leave,
      // no meaningful clientX/Y), so hover isn't a precondition there.
      if (mode === "none" || !(flyModeRef.current || hoverRef.current)) { setHighlight(null); placeBrush(null); return; }
      // Freeze the brush disc at the grab column while a grab drag is in progress (the pointer is
      // moving vertically to set the displacement, not to re-aim).
      if (mode === "sculpt" && sculptGrab) return;
      const now = performance.now();
      if (pickInflight || now - lastPickT < PICK_HOVER_MS) return;
      lastPickT = now;
      pickInflight = true;
      try {
        // Build hovers at the *build* reach (H5), so the green box vanishing past the cap IS the
        // out-of-range feedback — and the outline can never promise an edit the click would refuse.
        const p = await pick(cursorX, cursorY, mode === "build" ? buildReachDist() : PICK_DIST);
        // M2: cache this pick so an imminent click at the same cursor position can reuse it instead of
        // re-picking. Cached even for sculpt mode's hover (harmless — build/select/floodfill are the
        // only readers) and even on a miss (`p === null`), since a fresh pick would miss too.
        lastHoverPick = p; lastHoverCx = cursorX; lastHoverCy = cursorY; lastHoverT = now;
        // Sculpt shows the amber brush disc; select/build show the wireframe box. Never both.
        if (mode === "sculpt") { placeBrush(p); setHighlight(null); }
        else { setHighlight(p, placeYaw(cursorX, cursorY)); placeBrush(null); }
      } finally {
        pickInflight = false;
      }
    };

    // Click vs drag. Left-drag is look (fly, pointer-lock refused) or orbit-rotate, so a click only
    // counts if the pointer barely moved and the press was short. This keeps build/select working in
    // the drag-to-look fallback, which matters because pointer lock is exactly what webviews refuse.
    let downX = 0, downY = 0, downT = 0, downBtn = -1;

    // ---- Build gesture: Minecraft-style drag-sweep (H4) -------------------------------------------
    //
    // A build gesture is "a button held in build mode". Two things drive stamps out of it:
    //   • **pointermove** — the sweep. Every move re-picks and stamps the newly-aimed cell, so
    //     dragging across a wall lays a line of blocks along it. This is the gesture the pane used to
    //     lack entirely: pre-H4, drifting past CLICK_SLOP_PX *cancelled* the hold, because
    //     OrbitControls owned left-drag and had to be allowed to take over. Build mode now owns both
    //     drags (`setOrbitBuildMode`), so there is nothing left to yield to and the slop-kill is gone.
    //   • **the interval** — the stationary airbrush fallback, unchanged in cadence. It matters in
    //     fly/look mode, where the pointer never moves but WASD/mouselook still re-aims the crosshair.
    //
    // A short press with neither still resolves through the click-gated onPickUp/onPickContext below;
    // BUILD_REPEAT_DELAY_MS > CLICK_SLOP_MS keeps the interval out of that window, and
    // `buildRepeatFired` keeps a move-driven stamp from being doubled by the click path.
    let buildRepeatDelayTimer: number | null = null;
    let buildRepeatTimer: number | null = null;
    let buildRepeatButton = -1; // 0 = break (left), 2 = place (right)
    let buildRepeatStartT = 0;  // gesture start, for the BUILD_GESTURE_MAX_MS watchdog
    // H1: one undo group per gesture (single click or sweep) — mirrors `sculptGroupSeq`, sharing its
    // seed/counter so ids from the two families never collide. Set fresh in onPickDown's arm branch,
    // which runs for every build press regardless of whether it turns into a sweep or resolves as a
    // plain click, so both paths below can tag their `paint_blocks` calls with the same id.
    let buildGestureGroup = 0;
    // Every cell this gesture has already edited — NOT just the previous one. Each place/break
    // changes the world, so the next pick along the same ray returns a *new* cell one step nearer
    // (place) or further (break) than the last: a "previous cell only" dedupe therefore let a
    // stationary hold march a tower into the camera's face / tunnel through terrain at ~4.5
    // blocks/sec. A swept path never revisits a cell, so a whole-gesture set costs a sweep nothing
    // while degenerating a stationary hold to exactly one block.
    const buildRepeatCells = new Set<string>();
    // H4's placement-plane lock: the plane this gesture's FIRST stamp acted on, as
    // `"nx,ny,nz@offset"` — the face *orientation* plus the acted cell's coordinate along that
    // normal's axis. Every later stamp must land on the same plane.
    //
    // The offset half is what makes this work, and orientation alone would not: sweeping a flat field
    // from above, the ray dips into the hole you just made and hits the next block down through its
    // (newly exposed) *top* face — same normal, one layer deeper. Locking the coordinate too is what
    // keeps a break-sweep peeling exactly one surface layer and a place-sweep laying exactly one, so
    // neither can tunnel down or build back toward the camera; locking the normal is what keeps
    // either from wrapping around a corner onto the adjoining face.
    let buildRepeatPlane: string | null = null;
    /** `"nx,ny,nz@offset"` for a stamp: the face normal plus the acted cell's coordinate along it. */
    const planeKey = (nx: number, ny: number, nz: number, cx: number, cy: number, cz: number) =>
      `${nx},${ny},${nz}@${nx !== 0 ? cx : ny !== 0 ? cy : cz}`;
    let buildRepeatFired = false; // guards onPickUp/onPickContext from double-editing after a stamp
    // Re-entrancy: the tick is async and awaits a pick round-trip that can exceed BUILD_REPEAT_MS on
    // a large world, so bare setInterval ticks would stack and fire together. Same discipline as the
    // sculpt hold-timer below: busy is set *before* the await so two ticks can't both slip past.
    // Under H4 it does double duty as the sweep's rate limiter: pointermove fires at 60–120 Hz, and
    // this is what collapses that to exactly one pick+edit in flight at a time.
    let buildRepeatBusy = false;
    // Bumped by every stopBuildRepeat(): a tick already parked on `await pick(...)` when the button
    // is released must not land its edit afterwards (one extra block after you let go).
    let buildRepeatGen = 0;
    // Aim the last tick actually picked from — cursor position plus the camera's own pose, since in
    // fly/look mode the pointer is frozen and the camera is the only thing that re-aims. An unchanged
    // aim can't resolve to a new cell, so the tick returns *before* issuing a pick: that, not C1's
    // tick counter, is what stops a stationary hold from spinning IPC (and the mutex behind it).
    let aimCx = NaN, aimCy = NaN;
    const aimPos = new THREE.Vector3(NaN, NaN, NaN);
    const aimQuat = new THREE.Quaternion(NaN, NaN, NaN, NaN);
    const aimChanged = () =>
      cursorX !== aimCx || cursorY !== aimCy ||
      !aimPos.equals(camera.position) || !aimQuat.equals(camera.quaternion);
    const recordAim = () => {
      aimCx = cursorX; aimCy = cursorY;
      aimPos.copy(camera.position); aimQuat.copy(camera.quaternion);
    };

    const buildActive = () => interact3dRef.current === "build";
    const stopBuildRepeat = () => {
      if (buildRepeatDelayTimer !== null) { clearTimeout(buildRepeatDelayTimer); buildRepeatDelayTimer = null; }
      if (buildRepeatTimer !== null) { clearInterval(buildRepeatTimer); buildRepeatTimer = null; }
      buildRepeatGen++;
      buildRepeatButton = -1;
      buildRepeatBusy = false;
      buildRepeatPlane = null;
      buildRepeatCells.clear();
      aimCx = NaN; aimCy = NaN; // next gesture must re-pick even from an identical pose
    };

    // H1: the true "a gesture just ended" signal, wrapping `stopBuildRepeat`. Only a *sweep* (one or
    // more ticks fired via pointermove/the airbrush interval) has anything to summarize here — a plain
    // click never arms the repeat far enough to accumulate a cell, and reports its own one-block
    // gesture directly at its call site (see onPickUp/onPickContext below) since by the time a handler
    // reaches that point `stopBuildRepeat`/this has already run and cleared `buildRepeatCells`.
    const endBuildGesture = () => {
      if (buildRepeatButton >= 0 && buildRepeatCells.size > 0) {
        onBuildGestureEndRef.current?.(buildRepeatButton === 0 ? "break" : "place", buildRepeatCells.size);
      }
      stopBuildRepeat();
    };

    // One stamp attempt for the live gesture: re-pick the current aim (pointer while orbiting,
    // crosshair while flying) and break/place the resolved cell if it's new and on this gesture's
    // locked plane. Called from pointermove (the sweep) and from the interval (the airbrush).
    const buildRepeatTick = async () => {
      if (buildRepeatBusy || buildRepeatButton < 0) return;
      if (!buildActive()) { endBuildGesture(); return; }
      // Absolute bound on one gesture: if the webview never delivers the pointerup (the failure this
      // whole handler family is defensive about), the hold ends here rather than living forever.
      if (performance.now() - buildRepeatStartT > BUILD_GESTURE_MAX_MS) { endBuildGesture(); return; }
      if (!aimChanged()) return; // nothing has moved — a pick would return the same cell
      recordAim();
      const gen = buildRepeatGen;
      const button = buildRepeatButton;
      buildRepeatBusy = true;
      try {
        const hit = await pick(cursorX, cursorY, buildReachDist());
        // Released (or mode-switched / suspended) while the pick was in flight — the gesture this
        // tick belonged to is over, so dispatching now would edit a block the user never asked for.
        if (disposed || gen !== buildRepeatGen || !hit) return;
        // The cell this stamp would act on: the hit voxel for break, the empty neighbour for place.
        let tx: number, ty: number, tz: number;
        if (button === 0) {
          tx = hit.x; ty = hit.y; tz = hit.z;
        } else if (button === 2) {
          const t = clickTarget(hit);
          const c = threeToEden(camera.position);
          if (Math.floor(c.x) === t.x && Math.floor(c.y) === t.y && Math.floor(c.z) === t.z) return;
          tx = t.x; ty = t.y; tz = t.z;
        } else {
          return;
        }
        const plane = planeKey(hit.nx, hit.ny, hit.nz, tx, ty, tz);
        if (buildRepeatPlane !== null && plane !== buildRepeatPlane) return; // off this gesture's plane
        const cell = `${tx},${ty},${tz}`;
        if (buildRepeatCells.has(cell)) return;
        buildRepeatCells.add(cell);
        buildRepeatPlane ??= plane; // first stamp of the gesture fixes the plane
        buildRepeatFired = true;
        if (button === 0) onPickBreakRef.current?.(tx, ty, tz, buildGestureGroup);
        else onPickPlaceRef.current?.(tx, ty, tz, placeYaw(cursorX, cursorY), buildGestureGroup);
      } finally {
        buildRepeatBusy = false;
        // Trailing edge. Every pointermove that arrived while this pick was in flight was dropped by
        // the busy guard, so the end of a fast flick would otherwise never be stamped — and the click
        // path can't cover it either (buildRepeatFired suppresses it). Deliberately gated on the
        // *cursor* having moved, not the camera: a camera-only re-aim (fly/look mode) stays on the
        // interval's cadence rather than picking as fast as IPC allows.
        if (!disposed && buildRepeatButton >= 0 && (cursorX !== aimCx || cursorY !== aimCy)) {
          void buildRepeatTick();
        }
      }
    };

    // ---- Build shape: line / box (B1) --------------------------------------------------------------
    // A dedicated amber wireframe box marks the armed start cell — reuses hlGeom (unit cube edges,
    // already built above) with its own material so it doesn't fight the hover highlight's colour.
    const shapeAnchorMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false, transparent: true, opacity: 0.85 });
    const shapeAnchorBox = new THREE.LineSegments(hlGeom, shapeAnchorMat);
    shapeAnchorBox.renderOrder = 999;
    shapeAnchorBox.visible = false;
    scene.add(shapeAnchorBox);

    let buildShapeAnchor: { x: number; y: number; z: number; kind: "break" | "place" } | null = null;
    const clearBuildShapeAnchor = () => {
      const wasArmed = buildShapeAnchor !== null;
      buildShapeAnchor = null;
      shapeAnchorBox.visible = false;
      if (wasArmed) setBuildShapeArmed(false);
      invalidate();
    };
    // First click on a shape gesture arms the start cell; the second (of the same kind) commits the
    // whole run in one batched callback. A click of the OTHER kind (e.g. right-place after a
    // left-break was armed) restarts the gesture at the new point instead of erroring.
    const handleBuildShapeClick = (x: number, y: number, z: number, kind: "break" | "place", yaw: number) => {
      if (!buildShapeAnchor || buildShapeAnchor.kind !== kind) {
        buildShapeAnchor = { x, y, z, kind };
        placeBox(shapeAnchorBox, x, y, z);
        shapeAnchorBox.visible = true;
        setBuildShapeArmed(true);
        invalidate();
        return;
      }
      const a = buildShapeAnchor;
      const cells = buildShapeRef.current === "line"
        ? bresenham3D(a.x, a.y, a.z, x, y, z)
        : boxCells(a.x, a.y, a.z, x, y, z);
      clearBuildShapeAnchor();
      if (!cells) return; // over the safety cap — dropped, matching magic_wand_select's own cap behaviour
      if (kind === "break") onPickBreakBatchRef.current?.(cells);
      else onPickPlaceBatchRef.current?.(cells, yaw);
    };

    const onPickDown = (e: PointerEvent) => {
      // Idempotent re-arm: a missed release (pointerup off-canvas, pointercancel, focus loss) would
      // otherwise leave the previous hold-repeat interval running forever while this one starts a
      // second, compounding into runaway break/place. Always clear any stale timer before arming —
      // and if that stale gesture had already stamped something, summarize it now rather than losing
      // its toast entirely (H1).
      endBuildGesture();
      // Unconditional (M3). Resetting it inside the build/single branch below left a left-hold's
      // `true` standing, so the next right-click after e.g. switching build shape was silently
      // swallowed. (Since H4 both onPickUp and onPickContext consume it, one per gesture — but only
      // whichever handler this gesture's button reaches, so a per-gesture reset is still what clears
      // the other one's leftover.)
      buildRepeatFired = false;
      downX = e.clientX; downY = e.clientY; downT = performance.now(); downBtn = e.button;
      // Suppress the browser's middle-click autoscroll icon; only relevant in build mode (eyedropper).
      if (e.button === 1 && buildActive()) e.preventDefault();
      // Break (left) is reliable in WKWebView; place (right) is attempted the same way but the
      // guaranteed fallback is the `contextmenu` handler below (button-2 pointer events are
      // unreliable there — see its comment). Hold-to-repeat only applies to plain single-voxel
      // building — a line/box gesture is a deliberate two-click arm+commit, not a hold.
      // Alt hands both drags back to the camera for this gesture (see setOrbitBuildMode) — arming a
      // build sweep under it would edit the world while the user is orbiting.
      if ((e.button === 0 || e.button === 2) && !e.altKey && buildActive() && buildShapeRef.current === "single") {
        canvas.setPointerCapture(e.pointerId); // guarantees pointerup lands here, even released off-canvas
        buildRepeatButton = e.button;
        buildRepeatStartT = performance.now();
        buildGestureGroup = ++sculptGroupSeq; // H1: one undo group for every stamp this gesture makes
        // The sweep is live from here: pointermove drives it (H4). The timer below only adds the
        // stationary-airbrush tick, and stays delayed past CLICK_SLOP_MS so a quick click resolves
        // through the click path instead of racing it.
        buildRepeatDelayTimer = window.setTimeout(() => {
          buildRepeatDelayTimer = null;
          void buildRepeatTick();
          buildRepeatTimer = window.setInterval(() => { void buildRepeatTick(); }, BUILD_REPEAT_MS);
        }, BUILD_REPEAT_DELAY_MS);
      }
    };
    // Fallback arm for the right-button *hold*, mirroring `contextmenu`'s existing role as the
    // guaranteed fallback for a right-*click*: button-2 `pointerdown` is the specific event macOS
    // WKWebView is unreliable about delivering (see the comment above), and unlike a click there is
    // no later event that can stand in for a dropped one — a held sweep needs to have armed at
    // press-time to have anything to drive it. Legacy `mousedown` is dispatched through a different
    // WebKit code path than PointerEvents and does not share that gap, so it is the second, redundant
    // trigger for exactly the same arm sequence `onPickDown` already runs. Ordinarily `pointerdown`
    // fires first and arms `buildRepeatButton`, so this is a no-op almost every time; it only matters
    // the (previously silent) times WKWebView drops the pointer event and left/place kept "just
    // panning" the camera via mouselook — the actually-reported bug — with nothing left to arm it.
    const onPickMouseDownFallback = (e: MouseEvent) => {
      if (e.button !== 2 || buildRepeatButton === 2) return; // already armed by pointerdown — no-op
      endBuildGesture();
      buildRepeatFired = false;
      downX = e.clientX; downY = e.clientY; downT = performance.now(); downBtn = e.button;
      if (e.altKey || !buildActive() || buildShapeRef.current !== "single") return;
      // No `setPointerCapture` here — MouseEvent carries no `pointerId`. A release off-canvas is
      // still covered by the existing safety nets (BUILD_GESTURE_MAX_MS, `onBlur`, the re-arm at the
      // top of the next `onPickDown`/this fallback).
      buildRepeatButton = e.button;
      buildRepeatStartT = performance.now();
      buildGestureGroup = ++sculptGroupSeq;
      buildRepeatDelayTimer = window.setTimeout(() => {
        buildRepeatDelayTimer = null;
        void buildRepeatTick();
        buildRepeatTimer = window.setInterval(() => { void buildRepeatTick(); }, BUILD_REPEAT_MS);
      }, BUILD_REPEAT_DELAY_MS);
    };
    // Fallback disarm for the right-button *release*, mirroring `onPickMouseDownFallback`'s role for
    // the press: button-2 `pointerup` is exactly as unreliable in WKWebView as its pointerdown
    // counterpart (same root cause), but unlike pointerdown there's no later click-shaped event to
    // stand in for a dropped one here — `contextmenu`'s own firing time is itself platform-ambiguous
    // (see its comment: press-time on some platforms, release-time on others), so its handler
    // deliberately only disarms the stale/drag case and can't be trusted to disarm a plain quick
    // click too. When pointerup is dropped on a platform where contextmenu fires at release, that left
    // buildRepeatButton armed with its delay timer/interval still ticking after the physical button
    // was already up — 300ms (BUILD_REPEAT_DELAY_MS) later the first tick's `aimChanged` NaN-seeded
    // "always true on gesture start" behavior (see its comment) fired a phantom stamp at wherever the
    // cursor was aimed by then, i.e. the "have to click really fast or it silently places two blocks"
    // bug: a deliberate second click within that 300ms window re-armed and re-cancelled before the
    // phantom could fire, but any slower cadence let it land. Legacy `mouseup` is dispatched through a
    // separate WebKit code path and does not share the gap, so it's the second, redundant trigger for
    // exactly the disarm `onPickUp` already runs — a no-op almost every time, mattering only when
    // WKWebView drops the pointer event.
    const onPickMouseUpFallback = (e: MouseEvent) => {
      if (e.button !== 2 || buildRepeatButton !== 2) return;
      endBuildGesture();
    };
    // Safety net for a missed pointerup (webview-issued pointercancel, e.g. from an OS gesture or
    // focus loss mid-press) — without this the repeat interval above would run forever.
    const onPickCancel = () => endBuildGesture();
    // Split out of isClick so `contextmenu` — a MouseEvent, with no reliable `button` of its own in
    // WKWebView — can apply the same slop test against the press it belongs to (C2).
    const withinClickSlop = (cx: number, cy: number) =>
      performance.now() - downT < CLICK_SLOP_MS &&
      Math.abs(cx - downX) <= CLICK_SLOP_PX &&
      Math.abs(cy - downY) <= CLICK_SLOP_PX;
    const isClick = (e: PointerEvent) => e.button === downBtn && withinClickSlop(e.clientX, e.clientY);

    // Left-click. Select mode → pick a selection corner. Build mode → BREAK the picked block.
    // Sculpt mode's left button is a press-and-hold gesture owned by the sculpt controller, so this
    // click handler must NOT fall through to break — an explicit build-only guard replaces the old
    // "not select ⇒ build" assumption now that "sculpt" is a fourth mode.
    const onPickUp = async (e: PointerEvent) => {
      if ((e.button === 0 || e.button === 2) && buildRepeatButton === e.button) endBuildGesture();
      // A click that started on a gizmo handle (see "3D selection gizmo" below) must never also
      // fall through to select mode's two-click corner-pick, even when the press barely moved.
      if (gizmoConsumedClick) { gizmoConsumedClick = false; return; }
      if (interact3dRef.current === "none" || !isClick(e)) return;
      // Middle click in build mode: eyedropper (pick block+paint under the cursor). Build-only —
      // select/sculpt don't offer it, matching the plan's scope cut.
      if (e.button === 1) {
        if (!buildActive()) return;
        const hit = await pick(e.clientX, e.clientY);
        if (hit) onPickEyedropRef.current?.(hit.block_type, hit.paint);
        return;
      }
      if (e.button !== 0) return;
      if (interact3dRef.current === "select") {
        const hit = await pickOrHover(e.clientX, e.clientY, PICK_DIST);
        if (hit) onPickSelectRef.current?.(hit.x, hit.y, hit.z);
        return;
      }
      if (interact3dRef.current === "floodfill") {
        const hit = await pickOrHover(e.clientX, e.clientY, PICK_DIST);
        if (hit) onPickFloodFillRef.current?.(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz);
        return;
      }
      if (!buildActive()) return; // sculpt (or anything else): never breaks
      // A sweep stamp already ran for this press (H4: pointermove drives stamping from the moment the
      // button goes down, so even a press that stays inside the click slop can have edited once).
      // Without this the click path would break a *second* cell on release.
      if (buildRepeatFired) { buildRepeatFired = false; return; }
      // M2: refreshHighlight's hover pick drove the green/blue box the user was looking at when they
      // clicked — reuse it instead of a redundant round trip, so the click can never disagree with it.
      const hit = await pickOrHover(e.clientX, e.clientY, buildReachDist());
      if (!hit) return;
      if (buildShapeRef.current === "fill") {
        onPickFillFaceRef.current?.(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, "break");
        return;
      }
      if (buildShapeRef.current !== "single") {
        handleBuildShapeClick(hit.x, hit.y, hit.z, "break", 0);
        return;
      }
      // A plain click that never reached buildRepeatTick — exactly one block, so summarize it here
      // directly rather than through endBuildGesture (which already ran above with an empty cell set).
      onPickBreakRef.current?.(hit.x, hit.y, hit.z, buildGestureGroup);
      onBuildGestureEndRef.current?.("break", 1);
    };

    // Right-click → PLACE at the highlighted cell (the previewed hit+normal), so what a click does
    // matches what the highlight showed. Refuses to place inside the camera's own voxel (you'd entomb
    // yourself with no obvious way out). Bound to `contextmenu`, NOT button-2 pointer events: button 2
    // is unreliable in macOS WKWebView (MapCanvas hit the same — see its context-menu note).
    // preventDefault also suppresses the OS/webview menu over the 3D pane. `contextmenu` fires after
    // pointerup, so if the held-repeat timer above already placed at least once this gesture, this is
    // swallowed instead of placing a second block.
    const onPickContext = async (e: MouseEvent) => {
      e.preventDefault();
      // Disarm here too (C1 §3). This handler exists precisely because button-2 *pointer* events are
      // unreliable in WKWebView — but the only disarm used to live in onPickUp, gated on
      // `buildRepeatButton === e.button`. A dropped button-2 pointerup therefore left the place
      // interval running until some later pointerdown happened to hit the re-arm above: the single
      // most likely mechanism behind "one click gets stuck placing blocks".
      //
      // Gated on the press being *out* of the click-slop window, because platforms disagree on when
      // `contextmenu` fires: on the ones that fire it at press time an unconditional stop here would
      // cancel every right-hold before its first repeat tick. Out-of-slop means the press is either
      // released (a real pan/drag) or long past the point a pointerup should have arrived — both
      // cases where the repeat has no business still running. A stationary hold whose pointerup is
      // dropped outright is covered structurally instead: the whole-gesture cell set makes it a
      // no-op after one cell, the aim-change gate stops it issuing picks, and BUILD_GESTURE_MAX_MS
      // ends it outright. H4 does *not* make this conditional gating moot — the platform disagreement
      // it works around is about when `contextmenu` fires, which a new input model doesn't change.
      const wasRepeating = buildRepeatButton === 2;
      const stale = !withinClickSlop(e.clientX, e.clientY);
      if (wasRepeating && stale) endBuildGesture();
      if (!buildActive()) return;
      // Alt+right-drag is the camera's pan gesture in build mode (see setOrbitBuildMode) — never a place.
      if (e.altKey) return;
      if (buildRepeatFired) { buildRepeatFired = false; return; }
      // C2: OrbitControls used to bind RIGHT to PAN, so a right-drag to slide the camera ended in a
      // `contextmenu` — with no slop test this placed a block wherever the drag happened to end. H4
      // takes RIGHT away from OrbitControls in build mode, which makes that specific path impossible;
      // the test stays because right-drag is now a place-*sweep*, and a sweep's stamps come from the
      // tick — a release far from the press must not add one more at the release point.
      // Only enforced when we actually saw the matching button-2 pointerdown (or the repeat armed
      // from it): if the webview dropped that event we have no evidence of a drag, and refusing
      // would break placing outright on exactly the platform this fallback path exists for.
      if ((downBtn === 2 || wasRepeating) && stale) return;
      // M2: see the matching comment in onPickUp.
      const hit = await pickOrHover(e.clientX, e.clientY, buildReachDist());
      if (!hit) return;
      // Fill re-skins the clicked wall in place (the seed IS the solid hit cell) — no offset-into-
      // empty-neighbour math and no camera-occupancy guard (the seed being solid already rules out
      // the camera standing inside it).
      if (buildShapeRef.current === "fill") {
        onPickFillFaceRef.current?.(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, "place", placeYaw(e.clientX, e.clientY));
        return;
      }
      const t = clickTarget(hit); // build → placement cell
      const c = threeToEden(camera.position);
      if (Math.floor(c.x) === t.x && Math.floor(c.y) === t.y && Math.floor(c.z) === t.z) return;
      const yaw = placeYaw(e.clientX, e.clientY);
      if (buildShapeRef.current !== "single") {
        handleBuildShapeClick(t.x, t.y, t.z, "place", yaw);
        return;
      }
      // Plain click, never reached buildRepeatTick — one block, summarized directly (see onPickUp).
      onPickPlaceRef.current?.(t.x, t.y, t.z, yaw, buildGestureGroup);
      onBuildGestureEndRef.current?.("place", 1);
    };

    const onPickMove = (e: PointerEvent) => {
      cursorX = e.clientX; cursorY = e.clientY;
      // H4's sweep: while a build button is held, every move is a stamp attempt. `buildRepeatBusy`
      // collapses the 60–120 Hz move stream to one pick+edit in flight, and `buildRepeatCells` /
      // the plane lock decide whether the newly-aimed cell actually gets edited.
      if (buildRepeatButton >= 0) void buildRepeatTick();
      void refreshHighlight();
    };
    // Pointer lock can synthesize a pointerleave; while flying the crosshair still has a target.
    const onPickLeave = () => { if (!flyModeRef.current) { setHighlight(null); placeBrush(null); } };

    // Fire one sculpt stamp at a picked column through App's dispatch (which reads the rest of the
    // brush params and applies use_cap:false). Radius is read fresh here so a mid-stroke [ / ] resize
    // takes effect on the very next stamp.
    const emitStamp = (hit: PickResult, groupId: number, anchor: [number, number] | null, grabDelta?: number, smear?: [number, number]) =>
      Promise.resolve(onSculptStamp3dRef.current?.({
        stampCx: hit.x, stampCy: hit.y, stampRadius: sculptRadiusRef.current,
        groupId, anchor: anchor ?? undefined, grabDelta, smear,
      }));

    const onSculptDown = async (e: PointerEvent) => {
      if (e.button !== 0 || interact3dRef.current !== "sculpt") return;
      canvas.setPointerCapture(e.pointerId);
      const groupId = ++sculptGroupSeq;
      if (sculptToolRef.current === "grab") {
        // Grab: capture the fixed column + start Y; vertical drag sets the displacement; single
        // commit on release. No timer (matches the 2D sculpt-grab DragOp).
        const hit = await pick(e.clientX, e.clientY);
        if (disposed || interact3dRef.current !== "sculpt") return;
        if (!hit) return;
        sculptGrab = true;
        sculptGrabPick = hit;
        sculptGrabGroup = groupId;
        sculptGrabDownY = e.clientY;
        sculptGrabDelta = 0;
        setGrabReadout(0);
        return;
      }
      sculptActive = true;
      sculptBusy = false;
      sculptGroupId = groupId;
      // Anchor = stroke-start column, fixed for the whole stroke (flatten/stamp read it; harmless for
      // the others). Captured once here so it never drifts to the live cursor on later ticks.
      const first = await pick(e.clientX, e.clientY);
      if (disposed || !sculptActive) return;
      sculptAnchor = first ? [first.x, first.y] : null;
      sculptSmearLastPos = sculptToolRef.current === "smear" && first ? [first.x, first.y] : null;
      // Hold-timer: re-pick + stamp each tick. Busy is set *before* the async pick so two ticks can't
      // both slip past the guard during the pick's await window.
      sculptTimer = window.setInterval(() => {
        if (!sculptActive || sculptBusy) return;
        sculptBusy = true;
        (async () => {
          const hit = await pick(cursorX, cursorY); // crosshair while flying, pointer otherwise
          if (disposed || !sculptActive || !hit) return;
          let smear: [number, number] | undefined;
          if (sculptToolRef.current === "smear") {
            const last = sculptSmearLastPos;
            if (!last) return;
            const dx = hit.x - last[0], dy = hit.y - last[1];
            if (dx === 0 && dy === 0) return; // no movement this tick — nothing to smear
            sculptSmearLastPos = [hit.x, hit.y];
            smear = [dx, dy];
          }
          await emitStamp(hit, sculptGroupId, sculptAnchor, undefined, smear);
        })().finally(() => { sculptBusy = false; });
      }, SCULPT_TICK_MS);
    };

    const onSculptMove = (e: PointerEvent) => {
      // Only grab needs a dedicated move handler; the brush-disc hover repick rides onPickMove →
      // refreshHighlight (which also keeps cursorX/cursorY fresh for the hold-timer picks).
      if (!sculptGrab) return;
      // Up-drag raises, down-drag lowers, ~1 block per SCULPT_GRAB_PX_PER_BLOCK px (2D grab ratio).
      sculptGrabDelta = Math.round((sculptGrabDownY - e.clientY) / SCULPT_GRAB_PX_PER_BLOCK);
      setGrabReadout(sculptGrabDelta);
    };

    const onSculptUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (sculptGrab) {
        const hit = sculptGrabPick, delta = sculptGrabDelta, gid = sculptGrabGroup;
        sculptGrab = false; sculptGrabPick = null; sculptGrabDelta = 0;
        setGrabReadout(null);
        if (hit && delta !== 0) void emitStamp(hit, gid, [hit.x, hit.y], delta);
        return;
      }
      if (!sculptActive) return;
      sculptActive = false;
      if (sculptTimer !== null) { clearInterval(sculptTimer); sculptTimer = null; }
      const gid = sculptGroupId, anchor = sculptAnchor;
      sculptBusy = false;
      sculptAnchor = null;
      sculptSmearLastPos = null;
      // Final stamp at the exact release position — captures the release even if the last timer tick
      // was stale (or the stroke was too short for any tick to fire). Skipped when nothing was hit.
      // (For Smear specifically this final stamp carries no drag delta and is a safe no-op — same
      // as the 2D quick-click fallback — since there's no "last tick position" left to diff against.)
      void (async () => {
        const hit = await pick(e.clientX, e.clientY);
        if (disposed || !hit) return;
        await emitStamp(hit, gid, anchor);
      })();
    };

    canvas.addEventListener("pointerdown", onSculptDown);
    canvas.addEventListener("pointermove", onSculptMove);
    canvas.addEventListener("pointerup", onSculptUp);

    canvas.addEventListener("pointerdown", onPickDown);
    canvas.addEventListener("mousedown", onPickMouseDownFallback);
    canvas.addEventListener("mouseup", onPickMouseUpFallback);
    canvas.addEventListener("pointerup", onPickUp);
    canvas.addEventListener("pointercancel", onPickCancel);
    canvas.addEventListener("pointermove", onPickMove);
    canvas.addEventListener("pointerleave", onPickLeave);
    canvas.addEventListener("contextmenu", onPickContext);

    // In fly mode the wheel adjusts move speed (orbit zoom is disabled then anyway).
    const onWheel = (e: WheelEvent) => {
      if (!flyModeRef.current) return;
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      speedMultRef.current = THREE.MathUtils.clamp(speedMultRef.current * f, 0.1, 12);
      const rounded = Math.round(speedMultRef.current * 10) / 10;
      setFlySpeed(rounded);
      onFlySpeedChangeRef.current?.(rounded);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // Hover tracking gates the Z fly-toggle to this pane. Bound to the wrapper, not the canvas: the
    // HUD overlays (sliders, toggles, the fly pill) sit on top of the canvas, so moving onto one of
    // them fired pointerleave and cleared hoverRef — after which Z no longer entered fly mode. These
    // events don't bubble and ignore child transitions, so the wrapper sees one enter and one leave.
    const onEnter = () => { hoverRef.current = true; };
    const onLeave = () => { hoverRef.current = false; };
    wrap.addEventListener("pointerenter", onEnter);
    wrap.addEventListener("pointerleave", onLeave);

    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore while a modal dialog owns the keyboard, or while focus is in a text-entry field (world
      // name, prefab name/search, …) — App's own shortcut handler guards on both of these, but this
      // listener is a separate `window` subscription that didn't, so typing "z" in a text field with
      // the pointer resting over the 3D pane used to toggle fly mode out from under the user.
      //
      // "Text entry" deliberately excludes range/checkbox/button inputs. Testing `tagName === "INPUT"`
      // also matched this pane's own render-distance and fly-speed sliders, which keep focus after a
      // drag — so once you touched a slider, Z was dead for the rest of the session and only a world
      // reload (remounting the pane) brought it back.
      if (anyModalOpenRef.current || isTypingTarget(e.target)) return;
      // Hidden pane (Stage 4): this is a `window` subscription and survives suspension, so without
      // this it would keep eating W/A/S/D and Z for an invisible viewport.
      if (suspendedNow) return;
      // Escape cancels a live sculpt hold/grab stroke, or a live gizmo drag, in ANY camera mode (the
      // fly-mode Escape below only fires while walking). Doesn't return — App's own Escape handling
      // still runs, mirroring the sculpt-cancel precedence already established here.
      if (e.key === "Escape") { cancelSculptStroke(); cancelGizmoDrag(); clearBuildShapeAnchor(); }
      if (e.key.toLowerCase() === "z" && !e.repeat && !e.metaKey && !e.ctrlKey) {
        // Z cycles camera mode (orbit → look → fly → orbit). Advancing *into* a walking mode from
        // orbit requires the pointer to be over this pane (so Z while working in another quad-view
        // pane is ignored); once walking, Z keeps cycling regardless of hover.
        if (flyModeRef.current || hoverRef.current) { cycleMode(); e.preventDefault(); }
        return;
      }
      // Esc leaves any walking mode back to orbit (releasing the OS cursor grab if look mode held it).
      if (flyModeRef.current && e.key === "Escape") { applyMode("orbit"); e.preventDefault(); return; }
      if (!flyModeRef.current) return;
      keys.add(e.key.toLowerCase());
      // Swallow movement keys so they don't trigger app shortcuts.
      if (["w", "a", "s", "d", "e", "q", " ", "control", "shift", "alt"].includes(e.key.toLowerCase())) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.key.toLowerCase()); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Losing window focus (alt-tab, devtools) can swallow the keyup for a held direction key, leaving
    // it stuck in the set so the camera drifts indefinitely. Clear on blur. Also drop out of look
    // mode — a persistent OS cursor grab would otherwise freeze the cursor in whatever app we tab to.
    const onBlur = () => { keys.clear(); lookDrag = false; cancelSculptStroke(); endBuildGesture(); cancelGizmoDrag(); clearBuildShapeAnchor(); if (camModeRef.current === "look") applyMode("orbit"); };
    window.addEventListener("blur", onBlur);

    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    const WORLD_UP = new THREE.Vector3(0, 1, 0);

    // Reused per-frame for frustum culling of loaded chunk meshes.
    const frustum = new THREE.Frustum();
    const viewProj = new THREE.Matrix4();

    let prev = performance.now();
    let disposed = false;
    // Set between `webglcontextlost` and `webglcontextrestored`. While true there is no usable GL
    // context: frame() must not call renderer.render() (it would spew INVALID_OPERATION every rAF and
    // leave the pane black with nothing thrown for the ErrorBoundary to catch), and streaming is
    // parked so we don't accumulate geometry nobody can upload.
    let contextLost = false;
    let lastEmitT = 0;
    let lastMemHudT = 0;
    let lastEmitExternalT = 0;
    let lastEmitEX = NaN, lastEmitEY = NaN;

    // ---- Smooth camera transitions (C2) ------------------------------------------------------------
    // Tweens a programmatic camera jump (teleport, reset) instead of snapping — only while orbiting;
    // WASD/look already own the camera continuously while flying, so a jump there stays instant (a
    // tween would just fight the live movement). Eased ease-out-cubic over TWEEN_MS.
    const TWEEN_MS = 250;
    let camTween: { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; t0: number } | null = null;
    const startCamTween = (toPos: THREE.Vector3, toTarget: THREE.Vector3) => {
      if (flyModeRef.current) {
        camera.position.copy(toPos);
        controls.target.copy(toTarget);
        controls.update();
        return;
      }
      camTween = { fromPos: camera.position.clone(), toPos: toPos.clone(), fromTarget: controls.target.clone(), toTarget: toTarget.clone(), t0: performance.now() };
      invalidate();
    };

    // Orbit-controls "change" wakes the loop whenever the user drags/zooms; damping keeps it alive
    // until inertia settles (controls.update() returns false), then it goes fully idle.
    controls.addEventListener("change", invalidate);
    // streamSweep runs on its own interval — independent of render cadence. Held in a mutable slot
    // rather than a const because the context-loss handler below parks it and the restore handler
    // starts it again.
    let sweepInterval = setInterval(streamSweep, STREAM_MS);

    // ---- WebGL context loss / restore -------------------------------------------------------------
    // A driver can drop the context under memory pressure — the very condition the geometry budget
    // above exists to avoid, so this is the safety net for when it isn't enough. Without a
    // `preventDefault()` on the loss event the context is *never* restorable and the pane is dead for
    // the rest of the session, with nothing thrown for the ErrorBoundary to catch.
    const onContextLost = (e: Event) => {
      e.preventDefault();
      contextLost = true;
      cancelAnimationFrame(raf);
      rafPending = false;
      clearInterval(sweepInterval);
      onNoticeRef.current?.("3D view: the graphics context was lost (usually memory pressure). Recovering — lower the Memory budget preset or the render distance if it keeps happening.");
    };
    const onContextRestored = () => {
      contextLost = false;
      // three re-initialises its own GL state and re-uploads textures from their source images, but
      // it re-uploads *geometry* from `attribute.array` — which the upload-release above set to null.
      // Every resident chunk is therefore unrecoverable and must be refetched; reloadAllChunks()
      // disposes them and bumps fetchGen so any fetch issued pre-loss is dropped rather than
      // installed. This is the dependency Stage 1's release deliberately takes on.
      if (atlasTexRef.current) atlasTexRef.current.needsUpdate = true;
      // A pane suspended while its context was lost stays parked — `setSuspended(false)` restarts
      // the sweep and refetches. Restarting it here would stream geometry into a hidden pane.
      if (suspendedNow) return;
      sweepInterval = setInterval(streamSweep, STREAM_MS);
      reloadAllChunks();
      invalidate();
      onNoticeRef.current?.("3D view: graphics context restored — reloading terrain.");
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    // ---- Suspend / resume (Stage 4) ---------------------------------------------------------------
    // App keeps this pane mounted when it's switched off or the user leaves quad view, so the WebGL
    // context isn't destroyed and recreated on every toggle (WKWebView has a low ceiling on live
    // contexts, and churning them is a plausible contributor to the crash). Suspension is what makes
    // that free: no rAF, no streaming interval, and — the part that matters for memory — the whole
    // resident chunk set is disposed, so a hidden pane holds a bare context and nothing else.
    const setSuspended = (on: boolean) => {
      if (on === suspendedNow) return;
      suspendedNow = on;
      if (on) {
        // Drop every live gesture first. Fly/look mode in particular holds the *OS cursor grab* — a
        // pane that goes invisible while walking would leave the cursor captured with nothing on
        // screen to release it. applyMode("orbit") is the one exit that also releases the grab.
        cancelSculptStroke();
        cancelGizmoDrag();
        clearBuildShapeAnchor();
        // …including a held break/place. Without this, hiding the pane mid-hold left the repeat
        // interval editing the world against an invisible viewport; it only self-healed because
        // App forces mode3d="off" one effect later. Summarize first (H1) — the pane going invisible
        // is a legitimate gesture end, not a discard.
        endBuildGesture();
        applyMode("orbit");
        keys.clear();
        cancelAnimationFrame(raf);
        rafPending = false;
        clearInterval(sweepInterval);
        // Drop resident geometry and invalidate whatever is in flight (fetchGen), so nothing lands
        // into a pane nobody is looking at. `zBand = undefined` forces the next sweep to recompute
        // and refetch from scratch rather than trusting a band nothing is resident under any more.
        fetchGen++;
        queue = [];
        forceKeys.clear();
        for (const k of residentKeys()) disposeMesh(k);
        zBand = undefined;
        pushMemHud();
      } else if (!contextLost) {
        // The canvas was `display:none`, so its ResizeObserver reported 0 and `resize()` clamped the
        // renderer to 1×1. Re-measure before the first frame or the pane comes back stretched.
        resize();
        sweepInterval = setInterval(streamSweep, STREAM_MS);
        streamSweep(true); // meshes were disposed with the camera unmoved — must not early-out
        invalidate();
      }
    };

    // Kick off: first chunk load + first render.
    streamSweep();
    invalidate();

    // Hoisted function declaration so `invalidate` (defined above) can reference `frame` safely.
    function frame() {
      rafPending = false;
      if (disposed || contextLost || suspendedNow) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;

      const wasDirty = dirty;
      dirty = false;

      let keepGoing = false;

      if (camTween) {
        const t = Math.min(1, (now - camTween.t0) / TWEEN_MS);
        const e = 1 - (1 - t) ** 3; // ease-out cubic
        camera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
        controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, e);
        if (t >= 1) camTween = null; else keepGoing = true;
      }

      if (flyModeRef.current) {
        euler.set(pitch, yaw, 0);
        camera.quaternion.setFromEuler(euler);
        camera.getWorldDirection(fwd);
        right.crossVectors(fwd, WORLD_UP).normalize();
        // Sprint (Shift, existing) / Crawl (Alt, precision movement) — Alt is free in this pane (Ctrl
        // is already down-move, Shift is sprint), so it's the clash-free choice for a slow/precise
        // mode. Shift takes priority if both are somehow held.
        const boost = keys.has("shift") ? 3.5 : keys.has("alt") ? 0.25 : 1;
        const speed = Math.max(12, maxZ * 0.6) * boost * speedMultRef.current * dt;
        const move = new THREE.Vector3();
        if (keys.has("w")) move.add(fwd);
        if (keys.has("s")) move.sub(fwd);
        if (keys.has("d")) move.add(right);
        if (keys.has("a")) move.sub(right);
        if (keys.has(" ") || keys.has("e")) move.add(WORLD_UP);
        if (keys.has("control") || keys.has("q")) move.sub(WORLD_UP);
        if (move.lengthSq() > 0) camera.position.addScaledVector(move.normalize(), speed);
        keepGoing = true; // actively flying — look/move may change every frame
      } else {
        if (controls.update()) keepGoing = true; // orbit damping still settling
      }

      // Sky dome follows the camera so it reads as infinitely far.
      skyDome.position.copy(camera.position);

      // GPU-shadow sun follows the camera: the directional light sits up-sun of the camera and its
      // ortho shadow box is sized to the loaded radius, so shadows cover what's on screen and move
      // with the viewer. sunT only changes the direction here — free, no chunk reload.
      if (gpuShadowsRef.current) {
        const t = sunTRef.current;
        sunDirThree(t, sunDirScratch);
        const reach = Math.max(64, chunkToWorld(loadRadiusRef.current)); // world units of loaded terrain
        sun.target.position.copy(camera.position);
        sun.position.copy(camera.position).addScaledVector(sunDirScratch, reach * 1.5);
        const sc = sun.shadow.camera as THREE.OrthographicCamera;
        // Clamp the shadow-box half-extent so texel density (mapSize / 2·half) doesn't collapse at
        // high render distance. Covering the full loaded radius with one map makes near shadows
        // blocky; distant shadows are barely visible through fog anyway, so cap the self-shadowing
        // radius and let a bigger map keep the near ones crisp.
        const half = Math.min(reach, SHADOW_MAX_REACH) * 1.1;
        const wantMapSize = loadRadiusRef.current > 16 ? 4096 : 2048;
        if (sun.shadow.mapSize.x !== wantMapSize) {
          sun.shadow.mapSize.set(wantMapSize, wantMapSize);
          sun.shadow.map?.dispose();
          sun.shadow.map = null; // force three.js to reallocate the shadow map at the new size
        }
        if (sc.right !== half) {
          sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
          sc.far = reach * 4;
          sc.updateProjectionMatrix();
        }
        // Warm the sun toward orange as it nears the horizon (sunrise/sunset). `sin(pi·t)` is 1 at
        // noon, →0 at the ends; `warmth` is the complement. Tints both the light and the disc.
        const warmth = 1 - Math.sin(Math.PI * t);
        sunColorScratch.setRGB(1, 1 - 0.3 * warmth, 1 - 0.62 * warmth);
        sun.color.copy(sunColorScratch);
        sunDiscMat.color.copy(sunColorScratch).lerp(WHITE, 0.3);
        // Tint the ambient fill toward the warm sun colour at low sun so the whole scene reads
        // sunrise/sunset instead of a warm sun over cold-white fill. Subtle (max 35% lerp); at noon
        // warmth→0 so ambient stays neutral white. Cheap per-frame colour lerp.
        ambient.color.copy(WHITE).lerp(sunColorScratch, warmth * 0.35);
        // Disc sits just inside the sky dome (radius 4000), following the camera along the sun dir.
        sunDisc.position.copy(camera.position).addScaledVector(sunDirScratch, 3600);

        // GPU night: re-query the nearest lamps once the camera has moved a few blocks. frame() only
        // runs while something is animating, so an idle camera never polls — no permanent render loop.
        if (nightLightingRef.current && camera.position.distanceToSquared(lastNightQueryPos) > 16) {
          updateNightLights();
        }
      }

      // While flying, the crosshair's target changes as the camera moves — with the pointer locked
      // there's no pointermove to drive it, so repick from the loop. Self-throttled to PICK_HOVER_MS.
      if (flyModeRef.current && interact3dRef.current !== "none") void refreshHighlight();

      // Throttled HUD update (~10fps) — a self-contained re-render of this pane only, cheap.
      if (now - lastEmitT >= 100) {
        const ex = camera.position.x, ey = camera.position.z; // Three.js Z = Eden Y
        // Compass heading from the camera's forward direction (Eden north = Three.js −Z).
        camera.getWorldDirection(fwd);
        const ang = Math.atan2(fwd.x, -fwd.z); // 0 = north(−Z), +x = east
        const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
        const heading = dirs[(Math.round(ang / (Math.PI / 4)) + 8) % 8];
        const boost: "sprint" | "crawl" | null = keys.has("shift") ? "sprint" : keys.has("alt") ? "crawl" : null;
        // Pushed straight into the leaf HUD's own state — a setState here would re-render the whole
        // pane (and everything its render creates) ~10× a second while the camera moves.
        hudRef.current?.set({
          x: Math.round(ex), y: Math.round(ey), z: Math.round(camera.position.y), heading, boost,
          angleDeg: (ang * 180) / Math.PI,
        });
        lastEmitT = now;
      }
      // Throttled camera-position broadcast to the parent (~3fps) so the top-down map can draw the
      // camera dot. Deliberately slower than the HUD above: this bubbles into App-level state
      // (setCam3dPos), which re-renders MapCanvas/Ribbon/SelectionInspector/FlyView3D itself on every
      // update — a coarse map-dot position doesn't need 10Hz for that cost.
      if (now - lastEmitExternalT >= 300) {
        const ex = camera.position.x, ey = camera.position.z;
        if (ex !== lastEmitEX || ey !== lastEmitEY) {
          lastEmitEX = ex; lastEmitEY = ey;
          onCameraMoveRef.current?.(ex, ey);
        }
        lastEmitExternalT = now;
      }

      if (wasDirty || keepGoing) {
        // Frustum-cull loaded meshes: streaming keeps a radius disc resident, but only the chunks in
        // view need to draw. Toggles .visible only — disposal still happens by radius in streamSweep.
        camera.updateMatrixWorld();
        viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(viewProj);
        for (const m of meshes.values()) {
          if (!m.geometry.boundingSphere) continue;
          m.visible = frustum.intersectsObject(m);
        }
        for (const m of meshesT.values()) {
          if (!m.geometry.boundingSphere) continue;
          m.visible = frustum.intersectsObject(m);
        }
        for (const m of meshesE.values()) {
          if (!m.geometry.boundingSphere) continue;
          m.visible = frustum.intersectsObject(m);
        }
        renderer.render(scene, camera);
        // Post-render, because the upload-release callbacks fire *inside* render() — this is the only
        // point where the JS-heap total reflects what actually got freed. Dev-only and self-throttled
        // (`pushMemHud` is an empty function in a production build).
        if (now - lastMemHudT >= 250) { lastMemHudT = now; pushMemHud(); }
      }

      // Reschedule if fly/damping need more frames, or if invalidate() fired during this frame.
      // Guarded on !rafPending: controls.update() above can synchronously dispatch "change" →
      // invalidate(), which already scheduled a callback for next tick — scheduling a second one
      // here would double the in-flight callback count every tick until damping settles.
      if ((keepGoing || dirty) && !rafPending) {
        rafPending = true;
        raf = requestAnimationFrame(frame);
      }
    }

    const resetCamera = () => {
      if (flyModeRef.current) applyMode("orbit");
      const s = spawnXY();
      startCamTween(
        new THREE.Vector3(s.x, maxZ + 60, s.y + 110),
        new THREE.Vector3(s.x, Math.min(maxZ, 28), s.y),
      );
      streamSweep(true); // re-prioritise chunk streaming around the new viewpoint (tween hasn't ticked yet)
      invalidate();
    };

    // Teleport camera to an Eden world XY position, keeping the current height.
    // Force an immediate chunk sweep so old far-away chunks are cleared right away.
    const teleport = (wx: number, wy: number) => {
      const toPos = camera.position.clone(); toPos.x = wx; toPos.z = wy; // Three.js Z = Eden Y
      const toTarget = controls.target.clone(); toTarget.x = wx; toTarget.z = wy;
      startCamTween(toPos, toTarget);
      streamSweep(true); // immediate sweep without waiting for the next interval tick (tween hasn't ticked yet)
      invalidate();
    };

    // ---- Overlay boxes (selection / paste / extrude ghosts) ----
    //
    // A bare Box3Helper is a 1px depth-tested wireframe: it disappears behind terrain, has no
    // interior, and its hue washes out against a lit voxel field. Each overlay is instead a group
    // of three passes:
    //   1. a translucent tinted body, depth-tested, so the enclosed blocks read as shaded;
    //   2. solid edges where the box is unoccluded;
    //   3. dimmer "x-ray" edges with depthTest off, so the box is still legible through terrain
    //      while the opacity difference still communicates what's in front of what.
    const overlayObjs: THREE.Object3D[] = [];
    const overlayDisposables: { dispose: () => void }[] = [];

    const clearOverlays = () => {
      for (const o of overlayObjs) scene.remove(o);
      for (const d of overlayDisposables) d.dispose();
      overlayObjs.length = 0;
      overlayDisposables.length = 0;
    };

    const setOverlays = (ovs: Overlay3D[] | null) => {
      clearOverlays();
      if (!ovs) { invalidate(); return; }
      for (const ov of ovs) {
        const style = ov.style ?? "full";
        const group = new THREE.Group();

        // A shaped selection is one extruded prism (absolute coords, group at origin); everything
        // else is the centred box overlay (group positioned at the box centre).
        let fillGeom: THREE.BufferGeometry;
        let edgeGeom: THREE.BufferGeometry;
        if (ov.shape) {
          const built = buildMaskPrismGeometry(ov.shape.loops, ov.shape.caps, ov.shape.zBottom, ov.shape.zTop);
          fillGeom = built.fill;
          edgeGeom = built.edges;
          overlayDisposables.push(fillGeom, edgeGeom);
        } else {
          const min = new THREE.Vector3(...ov.min);
          const max = new THREE.Vector3(...ov.max);
          const size = new THREE.Vector3().subVectors(max, min);
          group.position.copy(min).addScaledVector(size, 0.5);
          const boxGeom = new THREE.BoxGeometry(size.x, size.y, size.z);
          fillGeom = boxGeom;
          edgeGeom = new THREE.EdgesGeometry(boxGeom);
          overlayDisposables.push(boxGeom, edgeGeom);
        }

        if (style !== "edges") {
          const fillMat = new THREE.MeshBasicMaterial({
            color: ov.color, transparent: true, opacity: OVERLAY_FILL_OPACITY,
            depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
          });
          const fill = new THREE.Mesh(fillGeom, fillMat);
          fill.renderOrder = 997;
          group.add(fill);
          overlayDisposables.push(fillMat);
        }

        if (style !== "fill") {
          const edgeMat = new THREE.LineBasicMaterial({
            color: ov.color, transparent: true, opacity: 1, fog: false, toneMapped: false,
          });
          const edges = new THREE.LineSegments(edgeGeom, edgeMat);
          edges.renderOrder = 998;
          group.add(edges);

          const xrayMat = new THREE.LineBasicMaterial({
            color: ov.color, transparent: true, opacity: OVERLAY_XRAY_OPACITY,
            depthTest: false, depthWrite: false, fog: false, toneMapped: false,
          });
          const xray = new THREE.LineSegments(edgeGeom, xrayMat);
          xray.renderOrder = 999;
          group.add(xray);
          overlayDisposables.push(edgeMat, xrayMat); // edgeGeom already tracked above
        }

        scene.add(group);
        overlayObjs.push(group);
      }
      invalidate();
    };

    // Apply any overlays that were already set before scene init (e.g. selection exists at world-load).
    setOverlays(overlays3dRef.current);

    // ---- 3D selection gizmo (Select mode transform handles) ---------------------------------------
    // Hand-rolled, not THREE's TransformControls: its scale gizmo is center-symmetric (can't extend a
    // single face) and its snap/aesthetic model fights the voxel grid + this file's raw-Three picking
    // conventions. Auto-shown whenever interact3d==="select" and a selection exists (setGizmoSelection,
    // driven by an effect on [interact3d, selectionBounds3d]).
    //
    // Axiom-style transform gizmo:
    //  • a light-gray CENTER cube — grab it to slide the whole box on the ground plane (Eden x,y);
    //  • 3 shaft+cone ARROWS (R=x, G=up, B=Eden-y) stemming from the center — single-axis whole-box move;
    //  • 3 flat PLANE squares between the arrow pairs — move the whole box on that plane (2 axes at once);
    //  • 6 small face handles — resize a single face along its axis.
    // Resize (face handles) is always region-only (never touches blocks). Center/arrow/plane MOVE honours
    // the shared Region⇄Blocks toggle (moveWithContents): region-only, or relocate contents via move_selection.
    // (No rotation rings — selection rotation has no backend yet.)
    //
    // Drag math: on pointerdown, build a drag plane. For a 1-axis handle (arrow/face) the plane contains
    // the dragged axis, oriented to face the camera as closely as possible (normal = the camera→handle
    // vector's component perpendicular to the axis); the ray∩plane projected onto the axis gives a
    // well-conditioned 1D drag regardless of view angle. For a 2-axis handle (center/plane) the plane is
    // fixed by the handle's normal axis through the box center, and the ray∩plane projects onto both
    // in-plane axes. Deltas round to whole voxels.
    const GIZMO_HANDLE_SIZE = 0.9;
    // The inner move gizmo (centre cube + arrows + plane squares) is a FIXED size at the box centre —
    // the arrows don't stretch to the selection's faces (only the 6 face-resize handles sit on faces).
    const GIZMO_ARROW_REACH = 5.5;       // cone-tip distance from centre (fixed, world units)
    const GIZMO_CONE_H = 1.4;            // arrow cone height (world units)
    const GIZMO_SHAFT_R = 0.14;          // arrow shaft cylinder radius
    const GIZMO_PLANE_OFF = 2.2;         // plane-square offset from centre along each in-plane axis
    const GIZMO_PLANE_SZ = 1.5;          // plane-square edge length
    const GIZMO_CENTER_SIZE = 1.5;       // centre move-cube edge length
    const GIZMO_FACE_COLOR = 0xfbbf24;
    const GIZMO_CENTER_COLOR = 0xd4d0c8; // light gray, like Axiom's centre cube
    const GIZMO_ARROW_COLORS: Record<"x" | "y" | "z", number> = { x: 0xef4444, y: 0x22c55e, z: 0x60a5fa };

    type GizmoAxis = "x" | "y" | "z";
    // kind: face=single-face resize · arrow=single-axis move · plane=2-axis resize · center=ground move.
    // role (arrows only) distinguishes the cone tip from the scaling shaft in layout.
    // planeNormal/planeA/planeB (planes only): the plane's normal axis + its two spanning/resize axes.
    interface GizmoHandleMeta {
      kind: "face" | "arrow" | "plane" | "center";
      axis: GizmoAxis; sign: 1 | -1; role?: "cone" | "shaft";
      planeNormal?: GizmoAxis; planeA?: GizmoAxis; planeB?: GizmoAxis;
    }
    const axisVec3 = (axis: GizmoAxis) =>
      axis === "x" ? new THREE.Vector3(1, 0, 0) : axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    // ConeGeometry/CylinderGeometry both point +Y by default — rotate to point outward along `axis`.
    const orientToAxis = (m: THREE.Object3D, axis: GizmoAxis) => {
      if (axis === "x") m.rotation.set(0, 0, -Math.PI / 2);
      else if (axis === "z") m.rotation.set(Math.PI / 2, 0, 0);
      else m.rotation.set(0, 0, 0);
    };

    const gizmoGroup = new THREE.Group();
    gizmoGroup.visible = false;
    gizmoGroup.renderOrder = 1000;
    scene.add(gizmoGroup);
    const gizmoHandles: THREE.Mesh[] = [];
    const gizmoHandleMeta = new Map<THREE.Mesh, GizmoHandleMeta>();
    const gizmoDisposables: { dispose: () => void }[] = [];

    const addHandle = (m: THREE.Mesh, meta: GizmoHandleMeta) => {
      m.renderOrder = 1000;
      gizmoHandleMeta.set(m, meta);
      gizmoHandles.push(m);
      gizmoGroup.add(m);
    };
    // Shared MeshBasicMaterial per axis colour (arrows/planes reuse them).
    const gizmoAxisMat: Record<GizmoAxis, THREE.MeshBasicMaterial> = {
      x: new THREE.MeshBasicMaterial({ color: GIZMO_ARROW_COLORS.x, depthTest: false, transparent: true, opacity: 0.95, fog: false, toneMapped: false }),
      y: new THREE.MeshBasicMaterial({ color: GIZMO_ARROW_COLORS.y, depthTest: false, transparent: true, opacity: 0.95, fog: false, toneMapped: false }),
      z: new THREE.MeshBasicMaterial({ color: GIZMO_ARROW_COLORS.z, depthTest: false, transparent: true, opacity: 0.95, fog: false, toneMapped: false }),
    };
    gizmoDisposables.push(gizmoAxisMat.x, gizmoAxisMat.y, gizmoAxisMat.z);

    // 6 single-face resize handles (small boxes at each face centre).
    const gizmoFaceGeom = new THREE.BoxGeometry(GIZMO_HANDLE_SIZE, GIZMO_HANDLE_SIZE, GIZMO_HANDLE_SIZE);
    const gizmoFaceMat = new THREE.MeshBasicMaterial({
      color: GIZMO_FACE_COLOR, depthTest: false, transparent: true, opacity: 0.95, fog: false, toneMapped: false,
    });
    gizmoDisposables.push(gizmoFaceGeom, gizmoFaceMat);
    const faceAxes: { axis: GizmoAxis; sign: 1 | -1 }[] = [
      { axis: "x", sign: -1 }, { axis: "x", sign: 1 },
      { axis: "y", sign: -1 }, { axis: "y", sign: 1 },
      { axis: "z", sign: -1 }, { axis: "z", sign: 1 },
    ];
    for (const fa of faceAxes) addHandle(new THREE.Mesh(gizmoFaceGeom, gizmoFaceMat), { kind: "face", axis: fa.axis, sign: fa.sign });

    // 3 arrows = cone tip + scaling shaft, both stemming from the centre cube.
    const gizmoConeGeom = new THREE.ConeGeometry(0.5, GIZMO_CONE_H, 14);
    const gizmoShaftGeom = new THREE.CylinderGeometry(GIZMO_SHAFT_R, GIZMO_SHAFT_R, 1, 10); // unit height; scaled in layout
    gizmoDisposables.push(gizmoConeGeom, gizmoShaftGeom);
    for (const axis of ["x", "y", "z"] as GizmoAxis[]) {
      addHandle(new THREE.Mesh(gizmoConeGeom, gizmoAxisMat[axis]), { kind: "arrow", axis, sign: 1, role: "cone" });
      addHandle(new THREE.Mesh(gizmoShaftGeom, gizmoAxisMat[axis]), { kind: "arrow", axis, sign: 1, role: "shaft" });
    }

    // 3 plane-resize squares (flat, coloured by the plane's normal axis).
    const gizmoPlaneGeom = new THREE.PlaneGeometry(GIZMO_PLANE_SZ, GIZMO_PLANE_SZ);
    gizmoDisposables.push(gizmoPlaneGeom);
    const planeDefs: { normal: GizmoAxis; a: GizmoAxis; b: GizmoAxis }[] = [
      { normal: "y", a: "x", b: "z" }, // ground plane (green): moves in x + Eden-y
      { normal: "x", a: "y", b: "z" }, // side plane (red): moves in up + Eden-y
      { normal: "z", a: "x", b: "y" }, // side plane (blue): moves in x + up
    ];
    for (const pd of planeDefs) {
      const mat = new THREE.MeshBasicMaterial({
        color: GIZMO_ARROW_COLORS[pd.normal], depthTest: false, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, fog: false, toneMapped: false,
      });
      gizmoDisposables.push(mat);
      addHandle(new THREE.Mesh(gizmoPlaneGeom, mat), { kind: "plane", axis: pd.normal, sign: 1, planeNormal: pd.normal, planeA: pd.a, planeB: pd.b });
    }

    // Centre move-cube (light gray) — grab to slide the whole box on the ground plane.
    const gizmoCenterGeom = new THREE.BoxGeometry(GIZMO_CENTER_SIZE, GIZMO_CENTER_SIZE, GIZMO_CENTER_SIZE);
    const gizmoCenterMat = new THREE.MeshBasicMaterial({
      color: GIZMO_CENTER_COLOR, depthTest: false, transparent: true, opacity: 0.92, fog: false, toneMapped: false,
    });
    gizmoDisposables.push(gizmoCenterGeom, gizmoCenterMat);
    addHandle(new THREE.Mesh(gizmoCenterGeom, gizmoCenterMat), { kind: "center", axis: "y", sign: 1 });

    // Live drag preview: a unit box transformed per-frame (position/scale), not rebuilt — a resize
    // drag can fire this every pointermove and rebuilding BoxGeometry that often would churn GPU
    // buffers for no reason. Same three-pass convention as the overlay boxes (fill + edges + x-ray).
    const gizmoPreviewGroup = new THREE.Group();
    gizmoPreviewGroup.visible = false;
    gizmoPreviewGroup.renderOrder = 997;
    scene.add(gizmoPreviewGroup);
    const unitBoxGeom = new THREE.BoxGeometry(1, 1, 1);
    const unitEdgesGeom = new THREE.EdgesGeometry(unitBoxGeom);
    gizmoDisposables.push(unitBoxGeom, unitEdgesGeom);
    const gizmoPreviewFillMat = new THREE.MeshBasicMaterial({
      color: GIZMO_FACE_COLOR, transparent: true, opacity: OVERLAY_FILL_OPACITY,
      depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    const gizmoPreviewEdgeMat = new THREE.LineBasicMaterial({ color: GIZMO_FACE_COLOR, transparent: true, opacity: 1, fog: false, toneMapped: false });
    const gizmoPreviewXrayMat = new THREE.LineBasicMaterial({
      color: GIZMO_FACE_COLOR, transparent: true, opacity: OVERLAY_XRAY_OPACITY,
      depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    });
    gizmoDisposables.push(gizmoPreviewFillMat, gizmoPreviewEdgeMat, gizmoPreviewXrayMat);
    gizmoPreviewGroup.add(new THREE.Mesh(unitBoxGeom, gizmoPreviewFillMat));
    gizmoPreviewGroup.add(new THREE.LineSegments(unitEdgesGeom, gizmoPreviewEdgeMat));
    gizmoPreviewGroup.add(new THREE.LineSegments(unitEdgesGeom, gizmoPreviewXrayMat));

    const gizmoBoxMinMax = (b: SelectionBounds3D) => ({
      min: new THREE.Vector3(b.x1, b.zMin, b.y1),
      max: new THREE.Vector3(b.x2 + 1, b.zMax + 1, b.y2 + 1),
    });
    const setGizmoPreviewBox = (b: SelectionBounds3D) => {
      const { min, max } = gizmoBoxMinMax(b);
      const size = new THREE.Vector3().subVectors(max, min);
      gizmoPreviewGroup.position.copy(min).addScaledVector(size, 0.5);
      gizmoPreviewGroup.scale.copy(size);
    };
    // Position every handle on the current (idle) selection box.
    const layoutGizmoHandles = (b: SelectionBounds3D) => {
      const { min, max } = gizmoBoxMinMax(b);
      const center = min.clone().add(max).multiplyScalar(0.5);
      const half = max.clone().sub(min).multiplyScalar(0.5);
      const halfOf = (axis: GizmoAxis) => (axis === "x" ? half.x : axis === "y" ? half.y : half.z);
      for (const m of gizmoHandles) {
        const meta = gizmoHandleMeta.get(m)!;
        const axisVec = axisVec3(meta.axis);
        m.scale.set(1, 1, 1);
        if (meta.kind === "face") {
          m.position.copy(center).addScaledVector(axisVec, halfOf(meta.axis) * meta.sign);
          m.rotation.set(0, 0, 0);
        } else if (meta.kind === "arrow") {
          const tip = GIZMO_ARROW_REACH; // fixed cone-tip distance from centre (doesn't scale with the box)
          if (meta.role === "shaft") {
            const shaftLen = Math.max(0.1, tip - GIZMO_CONE_H * 0.5);
            m.position.copy(center).addScaledVector(axisVec, shaftLen * 0.5);
            m.scale.set(1, shaftLen, 1); // unit-height cylinder → world length
          } else {
            m.position.copy(center).addScaledVector(axisVec, tip);
          }
          orientToAxis(m, meta.axis);
        } else if (meta.kind === "plane") {
          m.position.copy(center)
            .addScaledVector(axisVec3(meta.planeA!), GIZMO_PLANE_OFF)
            .addScaledVector(axisVec3(meta.planeB!), GIZMO_PLANE_OFF);
          // PlaneGeometry's normal is +Z by default; rotate so it lies in the plane whose normal is planeNormal.
          if (meta.planeNormal === "y") m.rotation.set(-Math.PI / 2, 0, 0);
          else if (meta.planeNormal === "x") m.rotation.set(0, Math.PI / 2, 0);
          else m.rotation.set(0, 0, 0);
        } else { // center
          m.position.copy(center);
          m.rotation.set(0, 0, 0);
        }
      }
    };

    const gizmoRaycaster = new THREE.Raycaster();
    const gizmoNdc = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect();
      return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    };
    const pickGizmoHandle = (clientX: number, clientY: number): THREE.Mesh | null => {
      if (!gizmoGroup.visible) return null;
      gizmoRaycaster.setFromCamera(gizmoNdc(clientX, clientY), camera);
      const hits = gizmoRaycaster.intersectObjects(gizmoHandles, false);
      return hits.length > 0 ? (hits[0].object as THREE.Mesh) : null;
    };

    let gizmoDragging = false;
    let gizmoDragHandle: GizmoHandleMeta | null = null;
    let gizmoDragStartBounds: SelectionBounds3D | null = null;
    let gizmoDragControlsWasEnabled = true;
    const gizmoDragPlane = new THREE.Plane();
    const gizmoDragAxisVec = new THREE.Vector3();
    let gizmoDragAnchorProj = 0;
    // 2-axis (center/plane) drag state: two in-plane axes + their intersection-reference projections.
    let gizmoDrag2d = false;
    const gizmoDrag2dAxisA = new THREE.Vector3();
    const gizmoDrag2dAxisB = new THREE.Vector3();
    let gizmoDrag2dAxes: [GizmoAxis, GizmoAxis] = ["x", "z"];
    let gizmoDrag2dRefA = 0;
    let gizmoDrag2dRefB = 0;
    // Set on a handle-hit pointerdown; consumed (and cleared) by onPickUp so the same click never
    // also completes a two-click corner-pick, even when the press barely moved.
    let gizmoConsumedClick = false;

    const cancelGizmoDrag = () => {
      if (!gizmoDragging) return;
      gizmoDragging = false;
      gizmoDragHandle = null;
      gizmoDragStartBounds = null;
      gizmoDrag2d = false;
      gizmoPreviewGroup.visible = false;
      controls.enabled = gizmoDragControlsWasEnabled;
      invalidate();
    };

    const onGizmoPointerDown = (e: PointerEvent) => {
      if (interact3dRef.current !== "select" || e.button !== 0) return;
      const hitMesh = pickGizmoHandle(e.clientX, e.clientY);
      if (!hitMesh) return;
      const bounds = selectionBounds3dRef.current;
      if (!bounds) return;
      const meta = gizmoHandleMeta.get(hitMesh)!;
      gizmoConsumedClick = true;
      gizmoDragging = true;
      gizmoDragHandle = meta;
      gizmoDragStartBounds = { ...bounds };
      gizmoDragControlsWasEnabled = controls.enabled;
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);

      gizmoDrag2d = meta.kind === "center" || meta.kind === "plane";
      if (gizmoDrag2d) {
        // Fixed drag plane (normal = the handle's normal axis) through the box centre; project the
        // ray∩plane onto both in-plane axes, referenced to the pointerdown intersection so both
        // deltas start at 0. Center = ground plane (normal up); plane square = its own normal axis.
        const normalAxis: GizmoAxis = meta.kind === "center" ? "y" : meta.planeNormal!;
        gizmoDrag2dAxes = meta.kind === "center" ? ["x", "z"] : [meta.planeA!, meta.planeB!];
        gizmoDrag2dAxisA.copy(axisVec3(gizmoDrag2dAxes[0]));
        gizmoDrag2dAxisB.copy(axisVec3(gizmoDrag2dAxes[1]));
        const { min, max } = gizmoBoxMinMax(bounds);
        const boxCenter = min.clone().add(max).multiplyScalar(0.5);
        gizmoDragPlane.setFromNormalAndCoplanarPoint(axisVec3(normalAxis), boxCenter);
        gizmoRaycaster.setFromCamera(gizmoNdc(e.clientX, e.clientY), camera);
        const pt = new THREE.Vector3();
        if (gizmoRaycaster.ray.intersectPlane(gizmoDragPlane, pt)) {
          gizmoDrag2dRefA = pt.dot(gizmoDrag2dAxisA);
          gizmoDrag2dRefB = pt.dot(gizmoDrag2dAxisB);
        } else { gizmoDrag2dRefA = boxCenter.dot(gizmoDrag2dAxisA); gizmoDrag2dRefB = boxCenter.dot(gizmoDrag2dAxisB); }
      } else {
        const axisVec = axisVec3(meta.axis);
        gizmoDragAxisVec.copy(axisVec);
        const anchor = hitMesh.position.clone();
        const camToHandle = anchor.clone().sub(camera.position).normalize();
        let normal = camToHandle.clone().sub(axisVec.clone().multiplyScalar(camToHandle.dot(axisVec)));
        if (normal.lengthSq() < 1e-6) {
          // Looking nearly straight down the axis — that plane choice degenerates. Fall back to a
          // plane containing the axis and world-up (or world-right when the axis IS world-up).
          normal = meta.axis === "y" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
          normal.sub(axisVec.clone().multiplyScalar(normal.dot(axisVec)));
        }
        normal.normalize();
        gizmoDragPlane.setFromNormalAndCoplanarPoint(normal, anchor);
        gizmoDragAnchorProj = anchor.dot(axisVec);
      }

      setGizmoPreviewBox(bounds);
      gizmoPreviewGroup.visible = true;
      invalidate();
    };

    // Translate the whole box along `axis` by `delta` voxels, clamped to world bounds.
    const moveWholeAxis = (next: SelectionBounds3D, start: SelectionBounds3D, axis: GizmoAxis, delta: number) => {
      if (axis === "x") { const d = THREE.MathUtils.clamp(delta, -start.x1, (mapW - 1) - start.x2); next.x1 = start.x1 + d; next.x2 = start.x2 + d; }
      else if (axis === "y") { const d = THREE.MathUtils.clamp(delta, -start.zMin, maxZ - start.zMax); next.zMin = start.zMin + d; next.zMax = start.zMax + d; }
      else { const d = THREE.MathUtils.clamp(delta, -start.y1, (mapH - 1) - start.y2); next.y1 = start.y1 + d; next.y2 = start.y2 + d; }
    };

    const gizmoIntersectPt = new THREE.Vector3();
    const onGizmoPointerMove = (e: PointerEvent) => {
      if (!gizmoDragging || !gizmoDragHandle || !gizmoDragStartBounds) return;
      gizmoRaycaster.setFromCamera(gizmoNdc(e.clientX, e.clientY), camera);
      if (!gizmoRaycaster.ray.intersectPlane(gizmoDragPlane, gizmoIntersectPt)) return;
      const start = gizmoDragStartBounds;
      const meta = gizmoDragHandle;

      if (gizmoDrag2d) {
        // Both center-cube and plane-square handles TRANSLATE the whole box on their plane (the outer
        // face cubes own resizing). Center = ground plane; each plane square = its own plane (incl.
        // the two vertical ones), giving 2-axis moves the single arrows can't.
        const dA = Math.round(gizmoIntersectPt.dot(gizmoDrag2dAxisA) - gizmoDrag2dRefA);
        const dB = Math.round(gizmoIntersectPt.dot(gizmoDrag2dAxisB) - gizmoDrag2dRefB);
        const next: SelectionBounds3D = { ...start };
        moveWholeAxis(next, start, gizmoDrag2dAxes[0], dA);
        moveWholeAxis(next, start, gizmoDrag2dAxes[1], dB);
        setGizmoPreviewBox(next);
        invalidate();
        return;
      }

      const delta = Math.round(gizmoIntersectPt.dot(gizmoDragAxisVec) - gizmoDragAnchorProj);
      const next: SelectionBounds3D = { ...start };
      if (meta.kind === "face") {
        if (meta.axis === "x") {
          if (meta.sign === -1) next.x1 = THREE.MathUtils.clamp(start.x1 + delta, 0, start.x2);
          else next.x2 = THREE.MathUtils.clamp(start.x2 + delta, start.x1, mapW - 1);
        } else if (meta.axis === "y") {
          if (meta.sign === -1) next.zMin = THREE.MathUtils.clamp(start.zMin + delta, 0, start.zMax);
          else next.zMax = THREE.MathUtils.clamp(start.zMax + delta, start.zMin, maxZ);
        } else {
          if (meta.sign === -1) next.y1 = THREE.MathUtils.clamp(start.y1 + delta, 0, start.y2);
          else next.y2 = THREE.MathUtils.clamp(start.y2 + delta, start.y1, mapH - 1);
        }
      } else if (meta.axis === "x") {
        const dx = THREE.MathUtils.clamp(delta, -start.x1, (mapW - 1) - start.x2);
        next.x1 = start.x1 + dx; next.x2 = start.x2 + dx;
      } else if (meta.axis === "y") {
        const dz = THREE.MathUtils.clamp(delta, -start.zMin, maxZ - start.zMax);
        next.zMin = start.zMin + dz; next.zMax = start.zMax + dz;
      } else {
        const dy = THREE.MathUtils.clamp(delta, -start.y1, (mapH - 1) - start.y2);
        next.y1 = start.y1 + dy; next.y2 = start.y2 + dy;
      }
      setGizmoPreviewBox(next);
      invalidate();
    };

    const onGizmoPointerUp = (e: PointerEvent) => {
      if (!gizmoDragging || !gizmoDragHandle || !gizmoDragStartBounds || e.button !== 0) return;
      const meta = gizmoDragHandle;
      const start = gizmoDragStartBounds;
      // Recover the committed bounds from the preview group's current transform — it was updated in
      // lockstep with `next` on every pointermove, so this stays in perfect agreement with what was
      // last shown, without redoing the per-axis clamp math here.
      const size = gizmoPreviewGroup.scale;
      const min = gizmoPreviewGroup.position.clone().addScaledVector(size, -0.5);
      const next: SelectionBounds3D = {
        x1: Math.round(min.x), zMin: Math.round(min.y), y1: Math.round(min.z),
        x2: Math.round(min.x + size.x) - 1, zMax: Math.round(min.y + size.y) - 1, y2: Math.round(min.z + size.z) - 1,
      };
      gizmoDragging = false;
      gizmoDragHandle = null;
      gizmoDragStartBounds = null;
      gizmoDrag2d = false;
      gizmoPreviewGroup.visible = false;
      controls.enabled = gizmoDragControlsWasEnabled;
      if (interact3dRef.current === "select") layoutGizmoHandles(next);
      invalidate();
      // Resize (face handles) is always region-only. Move (arrow/center/plane) honours the shared
      // Region⇄Blocks toggle: region-only, or relocate the contents via move_selection.
      const isResize = meta.kind === "face";
      if (isResize || !moveWithContentsRef.current) {
        onGizmoRegionChangeRef.current?.(next);
      } else {
        const dx = next.x1 - start.x1, dy = next.y1 - start.y1, dz = next.zMin - start.zMin;
        if (dx !== 0 || dy !== 0 || dz !== 0) onGizmoMoveBlocksRef.current?.(dx, dy, dz);
      }
    };

    canvas.addEventListener("pointerdown", onGizmoPointerDown);
    canvas.addEventListener("pointermove", onGizmoPointerMove);
    canvas.addEventListener("pointerup", onGizmoPointerUp);
    canvas.addEventListener("pointercancel", cancelGizmoDrag);

    sceneApi.current = {
      scene, camera, reloadChunk, reloadAllChunks, resetCamera, teleport, setOverlays, setFog, setMaxDpr,
      setGridVisible: (v) => { grid.visible = v; invalidate(); },
      // Flip the scene lighting, then rebuild every chunk mesh (material + normals + flat-vs-baked
      // geometry all differ between modes).
      setGpuShadows: () => { applyGpuLighting(); reloadAllChunks(); },
      setSuspended,
      updateGpuLighting: () => applyGpuLighting(),
      refreshNightLights: () => updateNightLights(),
      refresh: () => invalidate(),
      // H3: force a fresh pick past the hover throttle, so the outline can be told to catch up right
      // after an edit lands instead of waiting for the pointer to move.
      refreshHighlight: () => { lastPickT = 0; void refreshHighlight(); },
      clearHighlight: () => { setHighlight(null); endBuildGesture(); },
      clearSculpt: () => { cancelSculptStroke(); placeBrush(null); },
      clearBuildShape: () => clearBuildShapeAnchor(),
      setOrbitLeftEnabled,
      setOrbitBuildMode,
      setGizmoSelection: (mode, b) => {
        if (gizmoDragging) return; // don't fight a live drag — it owns the visual until release
        if (mode === "select" && b) { gizmoGroup.visible = true; layoutGizmoHandles(b); }
        else gizmoGroup.visible = false;
        invalidate();
      },
    };

    // Apply initial gizmo state — a selection may already exist when the pane mounts (quad view /
    // 3D pane toggled on with a selection already committed from the 2D map).
    sceneApi.current.setGizmoSelection(interact3dRef.current, selectionBounds3dRef.current ?? null);
    // Same for suspension: a world change rebuilds this closure while the pane may already be hidden.
    if (suspendedRef.current) setSuspended(true);

    return () => {
      disposed = true;
      // If the pane unmounts while in a walking mode (e.g. closing the 3D pane or quad view via a
      // click), notify the parent — otherwise its flyActiveRef never clears and every editor keyboard
      // shortcut stays disabled for the rest of the session. Also release any OS cursor grab so it's
      // never left frozen app-wide.
      if (flyModeRef.current) {
        flyModeRef.current = false;
        if (camModeRef.current === "look") setNativeCursorLock(false);
        onFlyModeChangeRef.current?.(false);
      }
      cancelSculptStroke();
      stopBuildRepeat();
      cancelAnimationFrame(raf);
      clearInterval(sweepInterval);
      controls.removeEventListener("change", invalidate);
      ro.disconnect();
      document.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("wheel", onWheel);
      wrap.removeEventListener("pointerenter", onEnter);
      wrap.removeEventListener("pointerleave", onLeave);
      cycleModeRef.current = null;
      canvas.removeEventListener("pointerdown", onCanvasDown);
      canvas.removeEventListener("pointerup", onCanvasUp);
      canvas.removeEventListener("pointerdown", onSculptDown);
      canvas.removeEventListener("pointermove", onSculptMove);
      canvas.removeEventListener("pointerup", onSculptUp);
      canvas.removeEventListener("pointerdown", onPickDown);
      canvas.removeEventListener("mousedown", onPickMouseDownFallback);
      canvas.removeEventListener("mouseup", onPickMouseUpFallback);
      canvas.removeEventListener("pointerup", onPickUp);
      canvas.removeEventListener("pointercancel", onPickCancel);
      canvas.removeEventListener("pointermove", onPickMove);
      canvas.removeEventListener("pointerleave", onPickLeave);
      canvas.removeEventListener("contextmenu", onPickContext);
      canvas.removeEventListener("pointerdown", onGizmoPointerDown);
      canvas.removeEventListener("pointermove", onGizmoPointerMove);
      canvas.removeEventListener("pointerup", onGizmoPointerUp);
      canvas.removeEventListener("pointercancel", cancelGizmoDrag);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onAltKey);
      window.removeEventListener("keyup", onAltKey);
      window.removeEventListener("blur", onAltBlur);
      // Before the forceContextLoss() below — that fires a webglcontextlost event we must not handle.
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      for (const k of residentKeys()) disposeMesh(k);
      clearOverlays();
      scene.remove(highlight);
      scene.remove(breakHighlight);
      scene.remove(placeShapeHighlight);
      scene.remove(brushGroup);
      scene.remove(shapeAnchorBox);
      scene.remove(gizmoGroup);
      scene.remove(gizmoPreviewGroup);
      for (const d of gizmoDisposables) d.dispose();
      for (const g of rampPreviewGeoms) g.dispose();
      for (const g of wedgePreviewGeoms) g.dispose();
      hlGeom.dispose();
      hlMat.dispose();
      hlBreakMat.dispose();
      shapeAnchorMat.dispose();
      brushFillGeom.dispose();
      brushFillMat.dispose();
      brushRingGeom.dispose();
      brushRingMat.dispose();
      brushRingXrayMat.dispose();
      mat.dispose();
      matT.dispose();
      matL.dispose();
      matLT.dispose();
      depthMatT.dispose();
      sunDiscMat.dispose();
      sun.shadow.map?.dispose();
      skyDome.geometry.dispose();
      skyMat.dispose();
      if (texMatRef.current) { texMatRef.current.dispose(); texMatRef.current = null; }
      if (texMatTRef.current) { texMatTRef.current.dispose(); texMatTRef.current = null; }
      if (texMatLRef.current) { texMatLRef.current.dispose(); texMatLRef.current = null; }
      if (texMatLTRef.current) { texMatLTRef.current.dispose(); texMatLTRef.current = null; }
      if (depthMatTexRef.current) { depthMatTexRef.current.dispose(); depthMatTexRef.current = null; }
      if (atlasTexRef.current) { atlasTexRef.current.dispose(); atlasTexRef.current = null; }
      controls.dispose();
      // dispose() always; forceContextLoss() ONLY on a true unmount.
      //
      // The distinction matters because the renderer binds to the fixed <canvas> ref, and a canvas
      // can own just one WebGL context for its lifetime. When this effect merely *re-runs* (world
      // resize, StrictMode's double-mount, HMR) the same canvas is reused, and a dead context left
      // behind would be handed straight back to the next `new WebGLRenderer`, which then crashes in
      // getShaderPrecisionFormat — hence the long-standing "never forceContextLoss here" rule.
      //
      // On a real unmount React discards the canvas, so nothing can reuse the context and releasing
      // it explicitly is both safe and necessary: WKWebView holds a low ceiling on simultaneously
      // live contexts, and toggling the 3D pane / quad view repeatedly used to strand one per
      // teardown until the GC eventually collected the canvas. `unmountingRef` (set by the
      // definition-order-earlier effect above) is the signal; the deferred `isConnected` re-check is
      // the belt-and-braces guard, since React's StrictMode remount looks identical from in here at
      // cleanup time but leaves the canvas attached to the document.
      renderer.dispose();
      if (unmountingRef.current) {
        setTimeout(() => {
          if (canvas.isConnected) return; // it was a remount after all — the new renderer owns this context
          try { renderer.forceContextLoss(); } catch { /* context already gone */ }
        }, 0);
      }
      scene.clear();
      sceneApi.current = null;
    };
    } catch (e) {
      // Init failed after the context was created — free GPU resources before rethrowing. dispose()
      // only (not forceContextLoss): the context stays bound to the fixed canvas and is reused by
      // the next mount/retry on that same canvas.
      try { renderer.dispose(); } catch { /* ignore */ }
      sceneApi.current = null;
      throw e;
    }
  // Re-init only when world dimensions change (new world loaded). `texturePack` is deliberately
  // omitted — it's read once at setup time to seed rebuildTextureMaterials(), not reactively; a pack
  // change alone is handled by the separate, much cheaper `[texturePack]` effect below, which doesn't
  // tear down the whole scene.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapW, mapH, maxZ, world.width_chunks, world.height_chunks]);

  // Overlay sync: push updated wireframe boxes to the scene.
  useEffect(() => {
    sceneApi.current?.setOverlays(overlays3d ?? null);
  }, [overlays3d]);

  // Mode-change bookkeeping (keyed on interact3d, so it re-runs every time the user cycles in/out of
  // sculpt via the pill or the ribbon, not just once):
  //  • leaving a box mode (select/build) strands a highlight box → clear it;
  //  • leaving sculpt strands the brush disc and could leave a live hold/grab stroke → clear both;
  //  • sculpt owns the orbit LEFT button (so left-drag sculpts instead of orbiting) → toggle it.
  useEffect(() => {
    const api = sceneApi.current;
    if (!api) return;
    if (interact3d !== "select" && interact3d !== "build" && interact3d !== "floodfill") api.clearHighlight();
    if (interact3d !== "sculpt") api.clearSculpt();
    if (interact3d !== "build") api.clearBuildShape();
    // Sculpt and build both own left-drag (sculpt strokes / H4 break-sweeps); build additionally
    // takes RIGHT (place-sweep) and moves camera orbit onto MIDDLE. Order matters: setOrbitBuildMode
    // resets the Alt override, so it must run after setOrbitLeftEnabled.
    api.setOrbitLeftEnabled(interact3d !== "sculpt" && interact3d !== "build");
    api.setOrbitBuildMode(interact3d === "build");
  }, [interact3d]);

  // Gizmo sync: show/hide + relay out the Select-mode transform handles whenever the mode or the
  // selection box changes (resize/move commits update selectionBounds3d, which lands here too).
  useEffect(() => {
    sceneApi.current?.setGizmoSelection(interact3d, selectionBounds3d ?? null);
  }, [interact3d, selectionBounds3d]);

  // Fog toggle / model / sky-color sync — avoids a full scene teardown/rebuild.
  useEffect(() => {
    sceneApi.current?.setFog(effectiveFogEnabled, effectiveFogColor());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveFogColor is derived inline, not stable
  }, [effectiveFogEnabled, fogSoft, world.sky, fogColorOverride, nightLighting]);

  // Antialiasing toggle: bump the pixel ratio (supersampling gives AA-like smoothing without
  // recreating the renderer, which can't toggle `antialias` live).
  useEffect(() => {
    sceneApi.current?.setMaxDpr(antialias ? 2 : MAX_DPR);
  }, [antialias]);

  // Floor grid visibility toggle (D3).
  useEffect(() => {
    sceneApi.current?.setGridVisible(gridVisible);
  }, [gridVisible]);

  // Re-centre over the spawn target on a new world load. The init effect only re-runs on world-size
  // change, so a new world of identical dimensions would otherwise keep the old viewpoint. Keyed on
  // `worldLoadToken` (bumped once per load) rather than spawnAt's coordinates — spawnAt also changes
  // when the user sets/clears a spawn point mid-session (H1: that must not yank the camera / kick
  // fly mode out, since resetCamera() calls applyMode("orbit")). spawnAtRef (kept current unconditionally
  // above) still supplies the actual coordinates resetCamera() reads.
  useEffect(() => {
    sceneApi.current?.resetCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldLoadToken]);

  // Edit sync: reload chunk meshes overlapping the last edit's top-down bounds. When night lighting
  // or shadows are on, a placed lamp (LAMP_LIGHT_RADIUS) or a new occluder (SHADOW_RAY_STEPS, the
  // shadow raymarch distance) can visibly affect blocks in the *next* chunk over — reloading only the
  // chunk(s) the edit's own bounds touch would leave a lit/shadowed seam at that boundary until the
  // camera flies away and back. The rect is therefore expanded by that reach, converted to whole
  // chunks — but the two halves are **not** reloaded on the same schedule (C3 steps 2–3):
  //
  //   • **core** (the edit's own chunks, usually 1) — immediately. This is the block you just placed
  //     appearing, so it can never be deferred.
  //   • **halo** (everything the reach adds on top) — accumulated and flushed on a trailing
  //     HALO_FLUSH_MS debounce. With baked shadows on, `shadowRayScan = 24` makes the padded rect
  //     5×5 = 25 chunks; paying that per *placed block* is the storm that made building on a large
  //     world feel broken. A build sweep stamps far faster than the debounce, so it now pays the halo
  //     once, after release — which is the "coalesce per gesture" outcome without any gesture
  //     plumbing between the scene closure and this effect: the edit rate *is* the gesture signal.
  //     A lone click pays it 350 ms later; the seam it fixes was never visible sooner than that.
  //
  // Both halves go through the same `reloadChunk` (and so the same forceKeys/staleKeys discipline),
  // which since C3 step 1 keeps the old mesh up until the replacement lands — no blanking hole.
  useEffect(() => {
    const api = sceneApi.current;
    if (!api || !lastEdit) return;
    // Lamp reach uses the live slider value (not the const) so a wider lamp radius reloads the wider
    // seam; shadow reach stays the raymarch constant.
    const reach = Math.max(
      nightLighting ? lampRadiusRef.current : 0,
      shadows3d ? lightConstantsRef.current.shadowRayScan : 0,
    );
    const chunkPad = Math.ceil(reach / 16);
    const cx0 = worldToChunk(lastEdit.x);
    const cy0 = worldToChunk(lastEdit.y);
    const cx1 = worldToChunk(lastEdit.x + Math.max(0, lastEdit.w - 1));
    const cy1 = worldToChunk(lastEdit.y + Math.max(0, lastEdit.h - 1));
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++)
        api.reloadChunk(cx, cy);
    if (chunkPad > 0) {
      const halo = haloKeysRef.current;
      for (let cy = cy0 - chunkPad; cy <= cy1 + chunkPad; cy++)
        for (let cx = cx0 - chunkPad; cx <= cx1 + chunkPad; cx++) {
          if (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1) continue; // core — already reloaded
          halo.add(`${cx},${cy}`);
        }
      if (haloTimerRef.current) clearTimeout(haloTimerRef.current);
      haloTimerRef.current = setTimeout(() => {
        haloTimerRef.current = null;
        const keys = haloKeysRef.current;
        haloKeysRef.current = new Set();
        const a = sceneApi.current;
        // A suspended pane disposed every mesh and emptied its queue; re-queueing into it would
        // start fetches nobody is looking at. Its resume path restreams from scratch anyway.
        if (!a || suspendedRef.current) return;
        for (const k of keys) {
          const [cx, cy] = k.split(",").map(Number);
          a.reloadChunk(cx, cy);
        }
      }, HALO_FLUSH_MS);
    }
    // GPU night: a placed/broken lamp changes the point-light set — re-query around the camera.
    if (gpuShadowsRef.current && nightLighting) api.refreshNightLights();
    // H3: the outline is a promise ("this is where the next click goes") — after any edit (this pane's
    // own build clicks included) it must catch up immediately rather than waiting for the pointer to
    // twitch, which in orbit mode with a stationary cursor otherwise never happens on its own.
    api.refreshHighlight();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editEpoch]);

  // Auto-close the render-distance warning popover once distance drops back under the threshold
  // (the icon itself disappears in that case, so this just tidies internal state).
  useEffect(() => {
    if (loadRadius <= RENDER_DISTANCE_WARN_THRESHOLD) setDistanceWarnOpen(false);
  }, [loadRadius]);

  // Escape dismisses the warning popover — it had no keyboard dismissal at all before.
  useEffect(() => {
    if (!distanceWarnOpen) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setDistanceWarnOpen(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [distanceWarnOpen]);

  // Escape dismisses the controls legend (D1) the same way.
  useEffect(() => {
    if (!legendOpen) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setLegendOpen(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [legendOpen]);

  // Texture pack sync: rebuild the DataTexture + material when the pack changes.
  useEffect(() => {
    rebuildTextureMaterials(texturePack);
  }, [texturePack]);

  // Reload all chunk meshes when the texture epoch changes (pack loaded / unloaded / toggled).
  useEffect(() => {
    sceneApi.current?.reloadAllChunks();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texEpoch]);

  // Cutaway cap changed: `get_chunk_geometry` folds `view_cap_z` into the emitted z band on the Rust
  // side, so every resident mesh was built against the old cap and has to be rebuilt. Same idiom as
  // the texture-epoch reload above. Skipped on mount (the first render's cap is whatever the world
  // loaded with, and the initial sweep already fetches under it).
  const capMountedRef = useRef(false);
  useEffect(() => {
    if (!capMountedRef.current) { capMountedRef.current = true; return; }
    sceneApi.current?.reloadAllChunks();
  }, [viewCapZ]);

  // Suspend/resume (Stage 4). App keeps this component mounted across the 3D-pane and quad-view
  // toggles instead of unmounting it, so the WebGL context survives; `suspended` is what makes a
  // hidden pane free.
  useEffect(() => {
    sceneApi.current?.setSuspended(suspended);
  }, [suspended]);

  // Reload all chunk meshes when the night-lighting/shadow preview toggles change — but NOT in
  // GPU-shadow mode, where geometry is flat and independent of night/shadows/sunT. That's what makes
  // sunT free there: the per-frame sun-follow moves the light; no reload is needed.
  useEffect(() => {
    if (!gpuShadowsRef.current) { sceneApi.current?.reloadAllChunks(); return; }
    // GPU mode: geometry is flat regardless of night/shadows/sunT, so no chunk reload. Re-apply the
    // scene light state (a night toggle or lamp-radius change flips the point-light pool) then repaint.
    sceneApi.current?.updateGpuLighting();
    sceneApi.current?.refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightEpoch]);

  // Flip GPU-shadow mode: swap scene lighting + rebuild meshes (material/normals/flat geometry differ).
  useEffect(() => {
    sceneApi.current?.setGpuShadows(gpuShadows);
  }, [gpuShadows]);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "100%", background: "#0a0f1e" }}>
      {/* Mode hint — pill badge style (A5) */}
      <div style={{
        position: "absolute", top: 6, left: 6, zIndex: 1, pointerEvents: "none",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        {/* Clickable mirror of the Z key — click to cycle orbit → look → fly. A discoverable way
            into mouselook, and a way back when Z is being swallowed by whatever holds focus. */}
        <button
          type="button"
          title={`Camera: ${camMode === "look" ? "mouselook" : camMode === "fly" ? "fly" : "orbit"} — click or press Z to cycle`}
          onClick={(e) => { e.currentTarget.blur(); cycleModeRef.current?.(); }}
          style={{
            padding: "2px 7px", borderRadius: 10, fontSize: 10, fontWeight: 600, letterSpacing: "0.05em",
            background: camMode !== "orbit" ? "rgba(52,211,153,0.18)" : "rgba(131,120,108,0.18)",
            border: `1px solid ${camMode !== "orbit" ? "rgba(52,211,153,0.45)" : "rgba(131,120,108,0.35)"}`,
            color: camMode !== "orbit" ? "#34d399" : "#afa69d",
            pointerEvents: "auto", cursor: "pointer",
          }}
        >
          {CAM_MODE_LABEL[camMode]}
        </button>
        {camMode === "look" ? (
          <span style={{ fontSize: 9, color: "#6ee7b7", pointerEvents: "none", lineHeight: 1.6 }}>
            WASD move · Space/E up · Ctrl/Q down · Shift boost<br />
            mouse look (free) · scroll speed · Z or Esc exit
          </span>
        ) : camMode === "fly" ? (
          <span style={{ fontSize: 9, color: "#6ee7b7", pointerEvents: "none", lineHeight: 1.6 }}>
            WASD move · Space/E up · Ctrl/Q down · Shift boost<br />
            {interact3d === "sculpt"
              ? "left = sculpt (drag-look off) · Z→look to move+aim · scroll speed"
              : "drag look · scroll speed · Z or Esc exit"}
          </span>
        ) : (
          <span style={{ fontSize: 9, color: "#61584f", pointerEvents: "none" }}>
            drag to orbit · scroll zoom · Z cycles mouselook → fly → orbit
          </span>
        )}
        {/* Speed indicator (A6) */}
        {camMode !== "orbit" && (
          <span style={{
            padding: "1px 5px", borderRadius: 4, fontSize: 9, fontWeight: 700,
            background: "rgba(52,211,153,0.12)", border: "1px solid rgba(52,211,153,0.3)",
            color: "#34d399",
          }}>
            {flySpeed.toFixed(1)}×
          </span>
        )}
        {loadingCount > 0 && (
          <span style={{
            padding: "1px 5px", borderRadius: 4, fontSize: 9,
            background: "rgba(131,120,108,0.12)", border: "1px solid rgba(131,120,108,0.25)",
            color: "#83786c",
          }}>
            loading {loadingCount}…
          </span>
        )}
        {budgetLimited && (
          <span
            title={`Resident chunk geometry hit the ${(geometryBudgetBytes / (1 << 20)).toFixed(0)} MB budget — streaming is paused until you fly away from some of it to free headroom. Raise it in Settings → Memory budget.`}
            style={{
              padding: "1px 5px", borderRadius: 4, fontSize: 9,
              background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)",
              color: "#ef4444",
            }}
          >
            render distance limited by memory
          </span>
        )}
        {/* Controls legend (D1) — the authoritative, always-available reference for every pane
            binding, including the ones with no on-canvas affordance. */}
        <div style={{ position: "relative", display: "flex", pointerEvents: "auto" }}>
          <button
            type="button"
            onClick={() => setLegendOpen(o => !o)}
            title="Controls legend"
            aria-label="Show 3D pane controls legend"
            aria-expanded={legendOpen}
            aria-controls="fly3d-controls-legend"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              // M4: the circle stays visually small (11px glyph well) but the hit target is a standard
              // ~24px tap size, via a transparent padding ring — a 14px circle was sub-touch-target and
              // fussy to hit with a mouse too.
              width: 24, height: 24, borderRadius: "50%", border: "1px solid rgba(131,120,108,0.4)",
              background: legendOpen ? "rgba(131,120,108,0.3)" : "rgba(131,120,108,0.12)",
              color: "#afa69d", fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0, lineHeight: 1,
            }}
          >?</button>
          {legendOpen && (
            <div
              id="fly3d-controls-legend"
              role="dialog"
              aria-label="3D pane controls legend"
              style={{
                ...glassMenuPanel,
                position: "absolute", top: 28, left: 0, zIndex: 10,
                width: 300, maxHeight: 420, overflowY: "auto",
                padding: 10, fontSize: 10, lineHeight: 1.5, color: "#dad6d2", fontWeight: 400,
              }}>
              {/* Explicit close affordance — Esc dismisses this too, but a popup with no visible way
                  to close it reads as stuck, especially since it can auto-open on first pane use with
                  no click required to open it in the first place. */}
              <button
                type="button"
                onClick={() => setLegendOpen(false)}
                title="Close"
                aria-label="Close controls legend"
                style={{
                  position: "absolute", top: 6, right: 6, width: 18, height: 18,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  borderRadius: "50%", border: "1px solid rgba(131,120,108,0.4)",
                  background: "rgba(131,120,108,0.12)", color: "#afa69d",
                  fontSize: 11, lineHeight: 1, cursor: "pointer", padding: 0,
                }}
              >×</button>
              <div style={{ fontWeight: 700, color: "#fff", marginBottom: 4, paddingRight: 20 }}>Camera</div>
              <div>Z / click pill — cycle Orbit → Look → Fly → Orbit</div>
              <div>Orbit — drag to rotate, scroll to zoom</div>
              <div>Look / Fly — WASD move · Space/E up · Ctrl/Q down</div>
              <div>Shift — sprint (3.5×) · Alt — crawl / precision (0.25×)</div>
              <div>Look — free mouselook · Fly — drag to look</div>
              <div>Scroll — adjust fly speed · Esc — exit to Orbit</div>
              <div style={{ fontWeight: 700, color: "#fff", margin: "6px 0 4px" }}>Select mode</div>
              <div>Click 2 corners (no gizmo hit) — make/replace a 3D selection</div>
              <div>Drag the gray center cube — slide the whole box on the ground</div>
              <div>Drag a colored arrow — move the box along that axis</div>
              <div>Drag a colored plane square — move the box on that plane (2 axes)</div>
              <div>Drag a small face box — resize that one side (region only)</div>
              <div>⇄ Region/Blocks toggle — a MOVE edits the region only, or relocates its
                blocks (undoable) — resize is always region-only</div>
              <div>Esc mid-drag — cancel the gizmo drag, no change committed</div>
              <div style={{ fontWeight: 700, color: "#fff", margin: "6px 0 4px" }}>Build mode</div>
              <div>Left drag — sweep break · Right drag — sweep place</div>
              <div>A sweep sticks to the face you started on and never revisits a cell</div>
              <div>Click without dragging — exactly one block</div>
              <div>Camera: middle drag orbits · Alt+left orbits · Alt+right pans · scroll zooms</div>
              <div>Middle click (no drag) — eyedropper (pick block+paint)</div>
              <div>Reach {Math.round(buildReach)} blocks — no outline means out of range (Settings ▸ 3D)</div>
              <div>1–5 / 6–0 — hotbar pinned/recent slots (works while flying)</div>
              <div style={{ fontWeight: 700, color: "#fff", margin: "6px 0 4px" }}>Sculpt mode</div>
              <div>Left press+hold — sculpt under the cursor (Grab: vertical drag)</div>
              <div>[ / ] — brush radius · Shift+[ / Shift+] — strength</div>
              <div>Esc — cancel the in-progress stroke</div>
            </div>
          )}
        </div>
      </div>
      {/* Camera reset button (A4) — faded to stay out of the way of the viewport, full opacity on hover
          so the render-distance number and fog swatch are still legible when you look at this row. */}
      <div
        style={{ position: "absolute", top: 6, right: 6, zIndex: 1, display: "flex", alignItems: "center", gap: 6, opacity: 0.5, transition: "opacity .12s" }}
        onMouseEnter={e => { e.currentTarget.style.opacity = "1"; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = "0.5"; }}
      >
        {/* Render distance slider */}
        <div style={chromeButton({
          display: "flex", alignItems: "center", gap: 4,
          padding: "2px 6px", cursor: "default",
        })}>
          <span style={{ fontSize: 9, color: "#83786c", userSelect: "none" }} aria-hidden="true">R</span>
          <input
            type="range" min={0} max={radiusToPos(MAX_RENDER_DISTANCE)} step={1} value={radiusToPos(loadRadius)}
            onChange={e => {
              const v = posToRadius(Number(e.target.value));
              loadRadiusRef.current = v;
              setLoadRadius(v);
              onRenderDistanceChangeRef.current?.(v);
              // Fog distance derives from render distance — refresh it live as the slider moves.
              sceneApi.current?.setFog(fogEnabledRef.current, fogColorRef.current);
            }}
            title={`Render distance: ${loadRadius} chunks`}
            aria-label={`Render distance: ${loadRadius} chunks`}
            style={{ width: 150, cursor: "pointer", accentColor: "#83786c" }}
          />
          <span style={{ fontSize: 9, color: "#afa69d", minWidth: 14, textAlign: "right", userSelect: "none" }} aria-hidden="true">{loadRadius}</span>
          {loadRadius > RENDER_DISTANCE_WARN_THRESHOLD && (
            <div style={{ position: "relative", display: "flex" }}>
              <button
                onClick={() => setDistanceWarnOpen(o => !o)}
                title={`High render distance (${loadRadius} chunks) can hurt performance — click for details`}
                aria-label={`High render distance warning: ${loadRadius} chunks — click for details`}
                aria-expanded={distanceWarnOpen}
                aria-controls="fly3d-distance-warning"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 13, height: 13, borderRadius: "50%", border: "none", padding: 0,
                  background: "rgba(239,68,68,0.18)", color: "#ef4444", fontSize: 9, fontWeight: 700,
                  cursor: "pointer", lineHeight: 1,
                }}
              >!</button>
              {distanceWarnOpen && (
                <div
                  id="fly3d-distance-warning"
                  role="tooltip"
                  style={{
                    ...glassMenuPanel,
                    position: "absolute", top: 18, right: 0, zIndex: 10,
                    width: 200, padding: 8, fontSize: 10, lineHeight: 1.4,
                    color: "#dad6d2", fontWeight: 400,
                  }}>
                  High render distance ({loadRadius} chunks) streams and keeps far more chunk geometry
                  in memory and on the GPU, which can drop frame rate — especially while flying. Lower
                  it if you notice stutter.
                </div>
              )}
            </div>
          )}
        </div>
        {/* Fog/sky color override — editor viewer preference only, never written to world.sky */}
        <div style={chromeButton({
          display: "flex", alignItems: "center", gap: 4,
          padding: "2px 6px", cursor: "default",
        })}>
          {/* Fog on/off — local override of the Settings default, doesn't touch world.sky */}
          <button
            onClick={() => setFogOverride(!effectiveFogEnabled)}
            title={effectiveFogEnabled ? "Fog on — click to disable" : "Fog off — click to enable"}
            aria-label={effectiveFogEnabled ? "Fog on — click to disable" : "Fog off — click to enable"}
            style={chromeButton({
              padding: "1px 5px", fontSize: 9,
              color: effectiveFogEnabled ? "#afa69d" : "#61584f",
            })}
          >Fog {effectiveFogEnabled ? "✓" : "✗"}</button>
          {/* Fog model — soft (exponential haze) vs hard (linear cut) */}
          {effectiveFogEnabled && (
            <button
              onClick={() => setFogSoft(s => !s)}
              title={fogSoft ? "Soft fog (exponential) — click for hard/linear" : "Hard fog (linear) — click for soft/exponential"}
              aria-label={fogSoft ? "Soft exponential fog — click to switch to hard linear fog" : "Hard linear fog — click to switch to soft exponential fog"}
              style={chromeButton({ padding: "1px 5px", fontSize: 9, color: "#afa69d" })}
            >{fogSoft ? "∿" : "│"}</button>
          )}
          <input
            type="color"
            value={rgbToHex(effectiveFogColor())}
            onChange={e => setFogColorOverride(e.target.value)}
            title="Fog / sky color (editor view only — not saved to the world file)"
            aria-label="Fog and sky color (editor view only — not saved to the world file)"
            style={{ width: 20, height: 16, padding: 0, border: "none", background: "none", cursor: "pointer" }}
          />
          {fogColorOverride && (
            <button
              onClick={() => setFogColorOverride(null)}
              title="Reset to world sky color"
              aria-label="Reset fog color to the world's own sky color"
              style={chromeButton({ padding: "1px 5px", fontSize: 9, color: "#afa69d" })}
            >↺</button>
          )}
        </div>
        <button
          onClick={() => setAntialias(a => !a)}
          title={antialias ? "Antialiasing on — click to disable" : "Antialiasing off — click to enable (higher GPU cost)"}
          aria-label={antialias ? "Antialiasing on — click to disable" : "Antialiasing off — click to enable (higher GPU cost)"}
          style={chromeButton({ padding: "2px 7px", fontSize: 10, color: antialias ? "#afa69d" : "#61584f" })}
        >AA {antialias ? "✓" : "✗"}</button>
        <button
          onClick={() => setGridVisible(v => !v)}
          title={gridVisible ? "Floor grid on — click to hide" : "Floor grid off — click to show"}
          aria-label={gridVisible ? "Floor grid on — click to hide" : "Floor grid off — click to show"}
          style={chromeButton({ padding: "2px 7px", fontSize: 10, color: gridVisible ? "#afa69d" : "#61584f" })}
        >Grid {gridVisible ? "✓" : "✗"}</button>
        <button
          onClick={() => sceneApi.current?.resetCamera()}
          title="Reset camera to world overview"
          aria-label="Reset camera to world overview"
          style={chromeButton({ padding: "2px 7px", fontSize: 10, color: "#afa69d" })}
        >⌂ Reset</button>
      </div>
      {camMode !== "orbit" && (
        // Centre crosshair — the aim point for movement and for 3D picking in both walking modes.
        <div style={{
          position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          zIndex: 1, pointerEvents: "none", color: "rgba(52,211,153,0.8)",
          fontSize: 16, fontWeight: 400, lineHeight: 1,
        }}>+</div>
      )}
      {/* Camera position / heading HUD (Eden coords) */}
      <CoordHud ref={hudRef} />
      {/* Resident-geometry readout — dev builds only (tree-shaken out of a production bundle by the
          constant `import.meta.env.DEV`, and the scene effect's pushMemHud() is a no-op there too). */}
      {import.meta.env.DEV && <GeomMemHud ref={memHudRef} />}
      {/* In-pane hotbar (bottom-centre, build mode only) — 5 pinned + 5 recent, mirrors the Ribbon
          hotbar and the 1-5/6-0 digit keys so the active slot never needs a glance back at the Ribbon. */}
      {interact3d === "build" && hotbarSlots && hotbarSlots.length > 0 && (
        <div style={{
          position: "absolute", bottom: 6, left: "50%", transform: "translateX(-50%)", zIndex: 1,
          display: "flex", gap: 3, pointerEvents: "auto",
          background: "rgba(31,28,26,0.7)", border: "1px solid rgba(131,120,108,0.3)", borderRadius: 6, padding: 3,
        }}>
          {hotbarSlots.map((b, i) => {
            const active = !!b && !!activeBlock && b.type === activeBlock.type && b.paint === activeBlock.paint;
            const digit = i < 5 ? String(i + 1) : String((i + 1) % 10);
            return (
              <div
                key={i}
                title={b ? `${b.label}${b.paint > 0 ? ` p${b.paint}` : ""} · key ${digit}` : `Empty pin slot ${digit}`}
                onClick={() => b && onHotbarSelect?.(b.type, b.paint)}
                style={{
                  width: 22, height: 22, borderRadius: 3, cursor: b ? "pointer" : "default", flexShrink: 0,
                  position: "relative", background: b ? b.css : "rgba(255,255,255,0.03)",
                  border: active ? "2px solid #fff" : b ? "1px solid rgba(255,255,255,0.18)" : "1px dashed #4b443d",
                  outline: active ? `1px solid ${i < 5 ? "#a78bfa" : "#f472b6"}` : "none", outlineOffset: 1,
                }}
              >
                <span style={{ position: "absolute", top: 0, left: 2, fontSize: 6, color: "rgba(255,255,255,0.35)", lineHeight: 1, pointerEvents: "none", userSelect: "none" }}>{digit}</span>
              </div>
            );
          })}
        </div>
      )}
      {/* In-pane interaction pill + armed-block hint (bottom-right). The VIEW/SELECT/BUILD pill is a
          quiet mirror of the Ribbon 3D tab's mode picker (both write mode3d); the hint below shows
          what a click will do without glancing back at the Ribbon. Container is pointer-transparent
          so only the pill buttons capture clicks — the canvas stays interactive around them. */}
      <div style={{
        position: "absolute", bottom: 6, right: 6, zIndex: 1, pointerEvents: "none",
        display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4,
      }}>
        <div style={{
          display: "flex", gap: 2, pointerEvents: "auto",
          background: "rgba(31,28,26,0.7)", border: "1px solid rgba(131,120,108,0.3)", borderRadius: 6, padding: 2,
        }}>
          {INTERACT_SEGMENTS.map((seg) => {
            const active = interact3d === seg.mode;
            return (
              <button
                key={seg.mode}
                type="button"
                title={seg.title}
                aria-pressed={active}
                onClick={(e) => { e.currentTarget.blur(); onSetInteract3d?.(seg.mode); }}
                style={{
                  padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: "0.05em",
                  cursor: "pointer",
                  background: active ? `${seg.accent}2b` : "transparent",
                  border: `1px solid ${active ? seg.accent + "80" : "transparent"}`,
                  color: active ? seg.accent : "#83786c",
                }}
              >{seg.label}</button>
            );
          })}
        </div>
        {/* Build shape toggle (B1) — Single is today's plain click; Line/Box arm a start cell on the
            first click and commit the whole run on the second (Esc cancels the armed anchor). */}
        {interact3d === "build" && (
          <div style={{
            display: "flex", gap: 2, pointerEvents: "auto",
            background: "rgba(31,28,26,0.7)", border: "1px solid rgba(131,120,108,0.3)", borderRadius: 6, padding: 2,
          }}>
            {(["single", "line", "box", "fill"] as BuildShape[]).map((s) => {
              const active = buildShape === s;
              const title = s === "single" ? "Single voxel — plain click to break/place"
                : s === "fill" ? "Fill bucket — click a wall face to flood-fill the connected same-type run (L clears it, R re-skins it)"
                : `${s === "line" ? "Line" : "Box"} — click a start cell, then click the end cell to commit the whole run`;
              const label = s === "single" ? "◽" : s === "line" ? "Line" : s === "box" ? "Box" : "Fill";
              return (
                <button
                  key={s}
                  type="button"
                  title={title}
                  aria-pressed={active}
                  onClick={(e) => { e.currentTarget.blur(); setBuildShape(s); }}
                  style={{
                    padding: "2px 7px", borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: "0.03em",
                    cursor: "pointer",
                    background: active ? "rgba(245,158,11,0.2)" : "transparent",
                    border: `1px solid ${active ? "rgba(245,158,11,0.5)" : "transparent"}`,
                    color: active ? "#f59e0b" : "#83786c",
                  }}
                >{label}</button>
              );
            })}
          </div>
        )}
        {/* Gizmo Region⇄Blocks toggle — only meaningful while the transform gizmo is showing (Select
            mode with a selection). Resize (face handles) is always region-only; this only decides
            what an axis-move ARROW does. */}
        {interact3d === "select" && selectionBounds3d && (
          <button
            type="button"
            onClick={(e) => { e.currentTarget.blur(); setMoveWithContents?.(v => !v); }}
            title={!moveWithContents
              ? "Gizmo arrows move the selection region only (2D/slab views follow). Click to switch to moving its blocks (undoable). Same toggle as the Selection tab's Move: Box/Contents."
              : "Gizmo arrows relocate the selection's blocks (undoable move_selection). Click to switch to moving the region only. Same toggle as the Selection tab's Move: Box/Contents."}
            style={{
              padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: "0.03em",
              pointerEvents: "auto", cursor: "pointer",
              background: moveWithContents ? "rgba(251,191,36,0.18)" : "rgba(131,120,108,0.18)",
              border: `1px solid ${moveWithContents ? "rgba(251,191,36,0.5)" : "rgba(131,120,108,0.35)"}`,
              color: moveWithContents ? "#fbbf24" : "#83786c",
            }}
          >⇄ {moveWithContents ? "Blocks" : "Region"}</button>
        )}
        {interact3d !== "none" && (
          <div style={{
            display: "flex", alignItems: "center", gap: 6, pointerEvents: "none",
            padding: "3px 7px", borderRadius: 4, fontSize: 9,
            background: "rgba(31,28,26,0.7)", border: "1px solid rgba(131,120,108,0.3)",
            color: interact3d === "sculpt" ? "#fdba74" : "#afa69d",
          }}>
            {interact3d === "build" && armedSwatch && (
              <img src={armedSwatch} alt="" width={14} height={14} style={{ imageRendering: "pixelated", borderRadius: 2 }} />
            )}
            <span>
              {interact3d === "select"
                ? "click 2 corners to select"
                : interact3d === "sculpt"
                  ? `${SCULPT_TOOL_LABELS[sculptTool] ?? "Sculpt"} · r${sculptRadius}${
                      grabReadout != null
                        ? ` · Δ${grabReadout > 0 ? "+" : ""}${grabReadout}`
                        : ` · str${sculptStrength}`}`
                  : buildShape === "fill"
                    ? `click a wall — L clear · R fill${armedLabel ? ` ${armedLabel}` : ""}`
                    : buildShape !== "single"
                      ? `${buildShapeArmed ? "click end cell to commit" : `click start cell (${buildShape})`}${armedLabel ? ` · ${armedLabel}` : ""}`
                      : `L drag break · R drag place${armedLabel ? ` ${armedLabel}` : ""}`}
            </span>
          </div>
        )}
      </div>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={camMode === "look"
          ? "3D mouselook view. WASD to move, Space or E up, Control or Q down, Shift to boost, move the mouse to look, scroll to change speed, Z or Escape to exit."
          : camMode === "fly"
            ? "3D fly-through view. WASD to move, Space or E up, Control or Q down, Shift to boost, drag to look, scroll to change speed, Z or Escape to exit."
            : "3D orbit view of the world. Drag to orbit, scroll to zoom, Z to enter mouselook."}
        style={{
          display: "block", width: "100%", height: "100%", touchAction: "none",
          cursor: camMode === "look" ? "none" : camMode === "fly" ? "move" : "grab",
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
});

export default FlyView3D;
