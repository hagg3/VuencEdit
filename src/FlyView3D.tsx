import { decodeF32 } from "./codec";
import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { AtlasData } from "./texturePack";
import { isTypingTarget } from "./viewportUtils";
import type { WorldMeta } from "./types";
import { chromeButton, glassMenuPanel } from "./designTokens";
import { skyFogColor } from "./blockDefs";
import { maskPrismPositions, type OutlinePt, type MaskRect } from "./maskUtils";

// Fog distance scales with the render distance slider (chunk radius × 16 blocks/chunk) so terrain
// fades out at the edge of what's actually streamed in, instead of a fixed distance that either
// clips well inside the loaded radius (short) or never fades (long, at high render distance).
const fogDistances = (radiusChunks: number) => {
  const far = Math.max(20, radiusChunks * 16 * 0.9);
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

interface ChunkGeom {
  positions: string; colors: string; uvs: string; vertex_count: number;
  // Transparent stream (water/glass/fence/new-flower) — colors are RGBA (itemSize 4), not RGB.
  positions_t: string; colors_t: string; uvs_t: string; vertex_count_t: number;
  // Emissive stream — lamp-block faces, RGB. Populated only in GPU (flat) mode; drawn unlit so lamps
  // stay fullbright under the lit Lambert material. Empty otherwise.
  positions_e: string; colors_e: string; uvs_e: string; vertex_count_e: number;
}
/** A lamp light for the experimental GPU night path — Eden local block coords (voxel centre) + colour 0..1. */
interface LampLight { x: number; y: number; z: number; r: number; g: number; b: number }
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
const MAX_RENDER_DISTANCE = 32; // slider ceiling (chunk radius)
// rad/px at sensitivity multiplier 1. Raised from the old hardcoded 0.0025 (look mode) — that base
// felt too slow by default; the Settings sliders scale from here (0.25x-4x range).
const LOOK_SENS_BASE = 0.006;
const DRAG_SENS_BASE = 0.0025;
const RENDER_DISTANCE_WARN_THRESHOLD = 16; // above this, chunk count grows enough to warn
const STREAM_MS = 150;   // throttle for the load/dispose sweep
const MAX_DPR = 1.5;     // cap device-pixel-ratio — Retina (2×) quadruples fragment load for ~no gain
// Hard cap on resident vertex count (opaque + transparent streams combined) regardless of render
// distance. At MAX_RENDER_DISTANCE=32 a fully-loaded disc is ~3200 chunks — with no cap that's
// unbounded GPU memory (a dense world can be 10K+ verts/chunk). Once resident geometry crosses this,
// the streaming queue stops pulling new chunks until eviction (moving the camera) frees headroom.
const VERTEX_BUDGET = 30_000_000;

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

/** What a click in the 3D pane does. Derived from App's active tool, not owned by this pane. */
export type Interact3D = "none" | "select" | "build" | "sculpt";

/// In-pane VIEW/SELECT/BUILD/SCULPT segmented pill — a quiet mirror of the Ribbon 3D tab's mode
/// picker (both write App's mode3d). Segmented, not a cycle: a stray click must never land on the
/// terrain-editing BUILD/SCULPT modes. VIEW = "none" (camera only); BUILD amber and SCULPT amber
/// to flag the armed edit modes; neither has a bare-key binding (click-only power features).
const INTERACT_SEGMENTS: { mode: Interact3D; label: string; accent: string; title: string }[] = [
  { mode: "none", label: "VIEW", accent: "#afa69d", title: "View only — clicks don't edit" },
  { mode: "select", label: "SELECT", accent: "#3b82f6", title: "Select mode — click two voxels to make a 3D selection" },
  { mode: "build", label: "BUILD", accent: "#f59e0b", title: "Build mode — left-click breaks, right-click places the armed block" },
  { mode: "sculpt", label: "SCULPT", accent: "#fb923c", title: "Sculpt mode — press and hold left to sculpt terrain under the cursor" },
];

/// Display names for the ten sculpt tools, for the in-pane armed-hint readout. (The ribbon owns the
/// canonical picker; this is just a label so the pane doesn't show a bare tool id.)
const SCULPT_TOOL_LABELS: Record<string, string> = {
  raise: "Raise", lower: "Lower", grab: "Grab", smooth: "Smooth", flatten: "Flatten",
  noise: "Noise", erode: "Erode", thermal: "Thermal", hydro: "Hydro", stamp: "Retexture",
  terrace: "Terrace", sharpen: "Sharpen", slope: "Slope", smear: "Smear",
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

const PICK_DIST = 256;
/** Hover-highlight repick cadence. ~30Hz — one ~1ms IPC round-trip per tick is well inside budget. */
const PICK_HOVER_MS = 33;
/** A pointerdown/up pair inside this many px and ms is a click, not a look-drag or an orbit drag. */
const CLICK_SLOP_PX = 4;
const CLICK_SLOP_MS = 250;
/** Held break/place: delay before the first repeat (must exceed CLICK_SLOP_MS so a quick click never
 *  races the repeat timer), then the steady repeat interval. Mirrors the sculpt hold-timer's cadence. */
const BUILD_REPEAT_DELAY_MS = 300;
const BUILD_REPEAT_MS = 220;

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

type HudData = { x: number; y: number; z: number; heading: string };
interface CoordHudRef { set: (d: HudData | null) => void }

/// Self-contained leaf for the camera-coords readout. The render loop pushes into it imperatively
/// (~10 Hz) so a moving camera re-renders only this <div>, not the whole 3D pane. Same pattern as
/// App's FpsCounter.
const CoordHud = forwardRef<CoordHudRef>(function CoordHud(_props, ref) {
  const [hud, setHud] = useState<HudData | null>(null);
  useImperativeHandle(ref, () => ({ set: setHud }), []);
  if (!hud) return null;
  return (
    <div style={{
      position: "absolute", bottom: 6, left: 6, zIndex: 1, pointerEvents: "none",
      padding: "2px 7px", borderRadius: 4, fontSize: 9, fontVariantNumeric: "tabular-nums",
      background: "rgba(31,28,26,0.7)", border: "1px solid rgba(131,120,108,0.3)", color: "#afa69d",
    }}>
      X {hud.x} · Y {hud.y} · Z {hud.z} · {hud.heading}
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
  /** Lamp light radius (blocks) for night lighting. Default 5 (the legacy LAMP_LIGHT_RADIUS constant). */
  lampRadius?: number;
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
  /** Left click in "build" mode: the voxel to clear. */
  onPickBreak?: (x: number, y: number, z: number) => void;
  /** Right click in "build" mode: the empty voxel against the picked face, where a block goes.
   *  `yaw` is the player's horizontal look direction in Eden coords (atan2(dx, dy), 0 = South),
   *  so App can auto-orient directional blocks to face the player. */
  onPickPlace?: (x: number, y: number, z: number, yaw: number) => void;
  /** Middle click in "build" mode: pick the block/paint under the cursor as the new armed block
   *  (mirrors the 2D eyedropper). Not offered in "select"/"sculpt" — keeps scope to build mode. */
  onPickEyedrop?: (blockType: number, paint: number) => void;
  /** Data-URL swatch of the armed fill block, shown in the corner while building. */
  armedSwatch?: string | null;
  /** Human-readable name of the armed fill block, shown next to the swatch. */
  armedLabel?: string;
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
}>(function FlyView3D({
  world, editEpoch = 0, lastEdit = null, spawnAt = null, worldLoadToken = 0, onFlyModeChange, onCameraMove, overlays3d = null,
  texturePack = null, texEpoch = 0, fogEnabled = true,
  nightLighting = false, shadows3d = false, sunT = 0.5, lampRadius = 5, lightEpoch = 0,
  initialRenderDistance, initialFlySpeed, onRenderDistanceChange, onFlySpeedChange, anyModalOpen = false,
  lookSensitivity = 1, dragSensitivity = 1, invertY = false,
  interact3d = "none", onPickSelect, onPickBreak, onPickPlace, onPickEyedrop, armedSwatch = null, armedLabel = "",
  hotbarSlots, activeBlock, onHotbarSelect,
  onSetInteract3d,
  sculptTool = "raise", sculptRadius = 6, sculptStrength = 2, onSculptStamp3d,
  gpuShadows = false,
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
  const [loadingCount, setLoadingCount] = useState(0);
  const setLoadingCountRef = useRef(setLoadingCount);
  const [budgetLimited, setBudgetLimited] = useState(false);
  const setBudgetLimitedRef = useRef(setBudgetLimited);

  const onRenderDistanceChangeRef = useRef(onRenderDistanceChange);
  onRenderDistanceChangeRef.current = onRenderDistanceChange;
  const onFlySpeedChangeRef = useRef(onFlySpeedChange);
  onFlySpeedChangeRef.current = onFlySpeedChange;

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

  // Lamp/shadow reach, fetched once from Rust so the edit-sync reload radius below can't drift out
  // of sync with export.rs's LAMP_LIGHT_RADIUS/SHADOW_RAY_STEPS constants. Seeded with those same
  // values as a fallback in case the fetch hasn't landed yet (a stale/undersized radius for one
  // frame is harmless — the next edit reloads correctly once the fetch resolves).
  const lightConstantsRef = useRef({ lampLightRadius: 5.0, shadowRayScan: 24 });
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

  const mapW = world.width_chunks * 16;
  const mapH = world.height_chunks * 16;
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
  const onPickBreakRef = useRef(onPickBreak);
  onPickBreakRef.current = onPickBreak;
  const onPickPlaceRef = useRef(onPickPlace);
  onPickPlaceRef.current = onPickPlace;
  const onPickEyedropRef = useRef(onPickEyedrop);
  onPickEyedropRef.current = onPickEyedrop;

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
  const gpuShadowsRef = useRef(gpuShadows);
  gpuShadowsRef.current = gpuShadows;

  // Fog model: soft = exponential (FogExp2, hazier / more fog-like, the default); hard = linear.
  const [fogSoft, setFogSoft] = useState(true);
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
    setGpuShadows: (on: boolean) => void;
    /** Re-apply scene light state for the current (gpuShadows, nightLighting) combo — no chunk reload. */
    updateGpuLighting: () => void;
    /** Re-query lamp point lights around the camera (GPU night only). */
    refreshNightLights: () => void;
    refresh: () => void;
    clearHighlight: () => void;
    /** Cancel any live sculpt hold-timer/grab stroke and hide the brush-disc cursor. */
    clearSculpt: () => void;
    /** Enable/disable OrbitControls' LEFT mouse action (disabled while sculpt mode owns left-drag). */
    setOrbitLeftEnabled: (enabled: boolean) => void;
  } | null>(null);

  useImperativeHandle(ref, () => ({
    teleport: (wx, wy) => sceneApi.current?.teleport(wx, wy),
  }), []);

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
    const invalidate = () => {
      dirty = true;
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

    const grid = new THREE.GridHelper(Math.max(mapW, mapH), Math.max(world.width_chunks, world.height_chunks));
    grid.position.set(cx, 0, cy);
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
    // Snapshot the controls' original LEFT-button action so sculpt mode can disable left-drag orbit
    // (setting it to null makes OrbitControls' onMouseDown fall through to STATE.NONE — verified in
    // three's source) and restore *exactly* this value on leaving sculpt, rather than hardcoding
    // THREE.MOUSE.ROTATE. Middle/right buttons keep orbiting/panning throughout.
    const origLeftButton = controls.mouseButtons.LEFT;
    const setOrbitLeftEnabled = (enabled: boolean) => {
      controls.mouseButtons.LEFT = enabled ? origLeftButton : null;
    };
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
      const queryR = Math.max(48, loadRadiusRef.current * 16);
      invoke<LampLight[]>("get_lamps_near", { x: ex, y: ey, z: ez, radius: queryR })
        .then((lamps) => {
          if (disposed) return;
          // Read the slider value here (not before the await) so a mid-flight drag isn't stale.
          const lampR = lampRadiusRef.current;
          // Physical falloff (decay=2, inverse-square). `distance` is the hard cutoff — set it well
          // beyond the nominal lamp radius so the falloff curve isn't clipped right at the edge
          // (a distance==lampR cutoff with 2/d brightness was the "only lit at point-blank range"
          // bug). intensity = lampR²·K makes the brightness AT distance lampR read ~K regardless of
          // the radius (intensity/d² = K at d=lampR), so the slider grows reach, not just brightness.
          const K = 0.4;
          for (let i = 0; i < MAX_NIGHT_LIGHTS; i++) {
            const pl = nightLights[i];
            const l = lamps[i];
            if (l) {
              pl.position.set(l.x, l.z, l.y); // Eden → THREE
              pl.color.setRGB(l.r, l.g, l.b);
              pl.distance = lampR * 4;
              pl.decay = 2;
              pl.intensity = lampR * lampR * K;
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
    const isResident = (k: string) => meshes.has(k) || meshesE.has(k) || emptyChunks.has(k);

    // Running total of resident vertices (opaque + transparent streams) — cheaper than summing over
    // all meshes on every pump() call, and drives the H6 vertex budget below.
    let residentVerts = 0;
    let budgetLimited = false;

    const disposeMesh = (k: string) => {
      const m = meshes.get(k);
      if (m) {
        residentVerts -= m.geometry.attributes.position?.count ?? 0;
        scene.remove(m);
        m.geometry.dispose();
        meshes.delete(k);
      }
      const mt = meshesT.get(k);
      if (mt) {
        residentVerts -= mt.geometry.attributes.position?.count ?? 0;
        scene.remove(mt);
        mt.geometry.dispose();
        meshesT.delete(k);
      }
      const me = meshesE.get(k);
      if (me) {
        residentVerts -= me.geometry.attributes.position?.count ?? 0;
        scene.remove(me);
        me.geometry.dispose();
        meshesE.delete(k);
      }
      emptyChunks.delete(k);
      invalidate();
    };

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

    // Monotonic generation counter + per-key stale set: a fetch that resolves after its chunk was
    // force-reloaded (edit) or the whole cache was invalidated (texture/lighting toggle) must not
    // install its result — it may predate the change it's racing against. `fetchGen` invalidates
    // every in-flight fetch at once (reloadAllChunks); `staleKeys` invalidates one specific in-flight
    // fetch (reloadChunk) without bumping the generation for everything else.
    let fetchGen = 0;
    const staleKeys = new Set<string>();

    const startFetch = (cxk: number, cyk: number) => {
      const k = key(cxk, cyk);
      if (inflight.has(k) || isResident(k)) return;
      inflight.add(k);
      active++;
      setLoadingCountRef.current(inflight.size);
      const gen = fetchGen;
      invoke<ChunkGeom>("get_chunk_geometry", { cx: cxk, cy: cyk, night: nightLightingRef.current, shadows: shadows3dRef.current, sunT: sunTRef.current, gpu: gpuShadowsRef.current, lampRadius: lampRadiusRef.current })
        .then((g) => {
          if (disposed) return;
          if (gen !== fetchGen || staleKeys.has(k)) return; // stale — dropped; finally{} requeues if needed
          disposeMesh(k); // replace any existing mesh (reload path)
          if (g.vertex_count > 0) {
            const geom = new THREE.BufferGeometry();
            geom.setAttribute("position", new THREE.BufferAttribute(decodeF32(g.positions), 3));
            geom.setAttribute("color", new THREE.BufferAttribute(decodeF32(g.colors), 3));
            // Add UV attribute when the pack is loaded (uvs is non-empty base64 string).
            const hasUVs = g.uvs && g.uvs.length > 0;
            if (hasUVs) {
              geom.setAttribute("uv", new THREE.BufferAttribute(decodeF32(g.uvs), 2));
            }
            // No CPU normals: baked mode is unlit (shading is in the vertex colours), and GPU mode's
            // Lambert materials use `flatShading` (normals derived in-shader). Voxel faces are exactly
            // the flat-shading case, so this is visually identical to per-vertex normals here.
            geom.computeBoundingSphere(); // cheap frustum-cull test per frame
            const mesh = new THREE.Mesh(geom, pickMat(false, !!hasUVs));
            mesh.castShadow = mesh.receiveShadow = gpuShadowsRef.current;
            scene.add(mesh);
            meshes.set(k, mesh);
            residentVerts += g.vertex_count;
          } else {
            // Marks the chunk "fetched" even when it's air (or all-transparent, e.g. an all-water
            // chunk went entirely into meshesT) — `isResident(k)` is what stops it from being refetched.
            emptyChunks.add(k);
          }
          if (g.vertex_count_t > 0) {
            const geomT = new THREE.BufferGeometry();
            geomT.setAttribute("position", new THREE.BufferAttribute(decodeF32(g.positions_t), 3));
            // RGBA (itemSize 4) — Three.js reads a 4-component color attribute as vertex alpha too.
            geomT.setAttribute("color", new THREE.BufferAttribute(decodeF32(g.colors_t), 4));
            const hasUVsT = g.uvs_t && g.uvs_t.length > 0;
            if (hasUVsT) {
              geomT.setAttribute("uv", new THREE.BufferAttribute(decodeF32(g.uvs_t), 2));
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
            scene.add(meshT);
            meshesT.set(k, meshT);
            residentVerts += g.vertex_count_t;
          }
          // Emissive stream (lamp faces, GPU mode only). Drawn with the UNLIT Basic material so lamps
          // stay fullbright under the scene's dim night ambient — matching the baked path and the game.
          // castShadow (lamps are solid); receiveShadow off (fullbright anyway). No normals needed
          // (Basic is unlit; the shadow depth pass doesn't consume them meaningfully here).
          if (g.vertex_count_e > 0) {
            const geomE = new THREE.BufferGeometry();
            geomE.setAttribute("position", new THREE.BufferAttribute(decodeF32(g.positions_e), 3));
            geomE.setAttribute("color", new THREE.BufferAttribute(decodeF32(g.colors_e), 3));
            const hasUVsE = g.uvs_e && g.uvs_e.length > 0;
            if (hasUVsE) {
              geomE.setAttribute("uv", new THREE.BufferAttribute(decodeF32(g.uvs_e), 2));
            }
            geomE.computeBoundingSphere();
            const emissiveMat = (hasUVsE && texMatRef.current) ? texMatRef.current : mat;
            const meshE = new THREE.Mesh(geomE, emissiveMat);
            meshE.castShadow = true;
            meshE.receiveShadow = false;
            scene.add(meshE);
            meshesE.set(k, meshE);
            residentVerts += g.vertex_count_e;
          }
          invalidate();
        })
        .catch(() => { /* no world / out of range */ })
        .finally(() => {
          inflight.delete(k);
          active--;
          const wasStale = staleKeys.delete(k);
          if (disposed) return;
          if (wasStale) queue.unshift({ cx: cxk, cy: cyk }); // requeue immediately — its result was dropped
          pump();
          setLoadingCountRef.current(inflight.size);
        });
    };

    const pump = () => {
      // H6: once resident geometry crosses the vertex budget, stop pulling new chunks — the queue
      // stays populated and resumes once eviction (moving the camera) frees headroom. Only calls
      // setState on an actual transition so this doesn't re-render every pump() (called on every
      // fetch completion).
      const overBudget = residentVerts >= VERTEX_BUDGET;
      if (overBudget !== budgetLimited) {
        budgetLimited = overBudget;
        setBudgetLimitedRef.current(overBudget);
      }
      if (overBudget) return;
      while (active < maxConcurrent() && queue.length) {
        const it = queue.shift()!;
        const k = key(it.cx, it.cy);
        if (inflight.has(k) || isResident(k)) continue;
        startFetch(it.cx, it.cy);
      }
    };

    // Camera-window streaming: keep chunks within LOAD_RADIUS of the camera's XY footprint.
    const streamSweep = () => {
      const ccx = Math.floor(camera.position.x / 16);
      const ccy = Math.floor(camera.position.z / 16); // Three.js Z = Eden Y
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
      for (const k of new Set([...meshes.keys(), ...emptyChunks])) {
        const [kx, ky] = k.split(",").map(Number);
        const dx = kx - ccx, dy = ky - ccy;
        if (dx * dx + dy * dy > dropSq) {
          disposeMesh(k);
        }
      }
    };

    // Forced reload (edit-sync): drop the cached mesh and re-queue it at the front for immediate
    // fetch. If a fetch for this chunk is already in flight, its (possibly pre-edit) result must not
    // land — mark it stale so the .finally{} in startFetch drops it and requeues instead.
    const reloadChunk = (cxk: number, cyk: number) => {
      const k = key(cxk, cyk);
      if (inflight.has(k)) {
        staleKeys.add(k);
        return; // requeued by startFetch's finally{} once the stale fetch resolves
      }
      disposeMesh(k);
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
      for (const k of new Set([...meshes.keys(), ...emptyChunks])) disposeMesh(k);
      streamSweep();
    };

    // ---- Fly controller ----
    const keys = new Set<string>();
    const euler = new THREE.Euler(0, 0, 0, "YXZ");
    let pitch = 0, yaw = 0;

    // Look state. Free-look via pointer lock when it engages; otherwise drag-to-look (hold the mouse
    // button and move) — pointer lock can be silently refused in the webview, so we never depend on it.
    let lookDrag = false;
    let lastMx = 0, lastMy = 0;

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
      }

      // Look mode grabs the OS cursor (frozen + hidden app-wide) until it exits; the other modes
      // release it. Delta events keep flowing on macOS so mouselook still steers (see set_cursor_lock).
      if (next === "look") setNativeCursorLock(true);
      else if (prev === "look") setNativeCursorLock(false);

      if (!nowWalking) {
        controls.enabled = true;
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
        // cursor is frozen but delta events keep arriving.
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

    const pick = async (clientX: number, clientY: number): Promise<PickResult | null> => {
      const r = cursorRay(clientX, clientY);
      try {
        return await invoke<PickResult | null>("pick_block", { ...r, maxDist: PICK_DIST });
      } catch {
        return null; // no world loaded, or a degenerate ray — treat as a miss
      }
    };

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

    const setHighlight = (p: PickResult | null) => {
      const want = !!p && interact3dRef.current !== "none";
      if (!want) {
        if (highlight.visible || breakHighlight.visible) {
          highlight.visible = false;
          breakHighlight.visible = false;
          invalidate();
        }
        return;
      }
      const build = interact3dRef.current === "build";
      const t = clickTarget(p!);
      placeBox(highlight, t.x, t.y, t.z);
      // Green = placement (build), blue = select — matches the overlay box colours.
      hlMat.color.setHex(build ? 0x22c55e : 0x60a5fa);
      highlight.visible = true;
      if (build) placeBox(breakHighlight, p!.x, p!.y, p!.z);
      breakHighlight.visible = build;
      invalidate();
    };

    // Latest cursor position, so the highlight can follow the crosshair while flying (where the
    // pointer is locked and never moves) as well as the pointer while orbiting.
    let cursorX = 0, cursorY = 0;
    let lastPickT = 0;
    let pickInflight = false;
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
        const p = await pick(cursorX, cursorY);
        // Sculpt shows the amber brush disc; select/build show the wireframe box. Never both.
        if (mode === "sculpt") { placeBrush(p); setHighlight(null); }
        else { setHighlight(p); placeBrush(null); }
      } finally {
        pickInflight = false;
      }
    };

    // Click vs drag. Left-drag is look (fly, pointer-lock refused) or orbit-rotate, so a click only
    // counts if the pointer barely moved and the press was short. This keeps build/select working in
    // the drag-to-look fallback, which matters because pointer lock is exactly what webviews refuse.
    let downX = 0, downY = 0, downT = 0, downBtn = -1;

    // Hold-to-repeat break/place (build mode only). A short press still resolves through the
    // click-gated onPickUp/onPickContext below; BUILD_REPEAT_DELAY_MS is chosen > CLICK_SLOP_MS so
    // the two paths never both fire for the same gesture (by the time the repeat delay elapses, a
    // quick click's own pointerup has already missed the click-slop time window).
    let buildRepeatDelayTimer: number | null = null;
    let buildRepeatTimer: number | null = null;
    let buildRepeatButton = -1; // 0 = break (left), 2 = place (right)
    let buildRepeatLastCell: string | null = null; // skip no-op repeats of the same voxel this hold
    let buildRepeatFired = false; // guards onPickContext from double-placing after a held repeat

    const stopBuildRepeat = () => {
      if (buildRepeatDelayTimer !== null) { clearTimeout(buildRepeatDelayTimer); buildRepeatDelayTimer = null; }
      if (buildRepeatTimer !== null) { clearInterval(buildRepeatTimer); buildRepeatTimer = null; }
      buildRepeatButton = -1;
      buildRepeatLastCell = null;
    };

    // Each repeat tick re-picks the live crosshair (frozen while flying, live cursor while orbiting)
    // and cancels itself the moment the pointer has drifted past click-slop since mouse-down — that's
    // the signal a drag became an orbit-rotate instead of a held break/place, so we back off and let
    // OrbitControls own the gesture.
    const buildRepeatTick = async () => {
      if (interact3dRef.current !== "build") { stopBuildRepeat(); return; }
      if (Math.abs(cursorX - downX) > CLICK_SLOP_PX || Math.abs(cursorY - downY) > CLICK_SLOP_PX) { stopBuildRepeat(); return; }
      const hit = await pick(cursorX, cursorY);
      if (disposed || !hit) return;
      if (buildRepeatButton === 0) {
        const key = `${hit.x},${hit.y},${hit.z}`;
        if (key === buildRepeatLastCell) return;
        buildRepeatLastCell = key;
        buildRepeatFired = true;
        onPickBreakRef.current?.(hit.x, hit.y, hit.z);
      } else if (buildRepeatButton === 2) {
        const t = clickTarget(hit);
        const c = threeToEden(camera.position);
        if (Math.floor(c.x) === t.x && Math.floor(c.y) === t.y && Math.floor(c.z) === t.z) return;
        const key = `${t.x},${t.y},${t.z}`;
        if (key === buildRepeatLastCell) return;
        buildRepeatLastCell = key;
        buildRepeatFired = true;
        onPickPlaceRef.current?.(t.x, t.y, t.z, placeYaw(cursorX, cursorY));
      }
    };

    const onPickDown = (e: PointerEvent) => {
      downX = e.clientX; downY = e.clientY; downT = performance.now(); downBtn = e.button;
      // Suppress the browser's middle-click autoscroll icon; only relevant in build mode (eyedropper).
      if (e.button === 1 && interact3dRef.current === "build") e.preventDefault();
      // Break (left) is reliable in WKWebView; place (right) is attempted the same way but the
      // guaranteed fallback is the `contextmenu` handler below (button-2 pointer events are
      // unreliable there — see its comment).
      if ((e.button === 0 || e.button === 2) && interact3dRef.current === "build") {
        buildRepeatButton = e.button;
        buildRepeatLastCell = null;
        buildRepeatFired = false;
        buildRepeatDelayTimer = window.setTimeout(() => {
          buildRepeatDelayTimer = null;
          void buildRepeatTick();
          buildRepeatTimer = window.setInterval(() => { void buildRepeatTick(); }, BUILD_REPEAT_MS);
        }, BUILD_REPEAT_DELAY_MS);
      }
    };
    const isClick = (e: PointerEvent) =>
      e.button === downBtn &&
      performance.now() - downT < CLICK_SLOP_MS &&
      Math.abs(e.clientX - downX) <= CLICK_SLOP_PX &&
      Math.abs(e.clientY - downY) <= CLICK_SLOP_PX;

    // Left-click. Select mode → pick a selection corner. Build mode → BREAK the picked block.
    // Sculpt mode's left button is a press-and-hold gesture owned by the sculpt controller, so this
    // click handler must NOT fall through to break — an explicit build-only guard replaces the old
    // "not select ⇒ build" assumption now that "sculpt" is a fourth mode.
    const onPickUp = async (e: PointerEvent) => {
      if ((e.button === 0 || e.button === 2) && buildRepeatButton === e.button) stopBuildRepeat();
      if (interact3dRef.current === "none" || !isClick(e)) return;
      // Middle click in build mode: eyedropper (pick block+paint under the cursor). Build-only —
      // select/sculpt don't offer it, matching the plan's scope cut.
      if (e.button === 1) {
        if (interact3dRef.current !== "build") return;
        const hit = await pick(e.clientX, e.clientY);
        if (hit) onPickEyedropRef.current?.(hit.block_type, hit.paint);
        return;
      }
      if (e.button !== 0) return;
      if (interact3dRef.current === "select") {
        const hit = await pick(e.clientX, e.clientY);
        if (hit) onPickSelectRef.current?.(hit.x, hit.y, hit.z);
        return;
      }
      if (interact3dRef.current !== "build") return; // sculpt (or anything else): never breaks
      const hit = await pick(e.clientX, e.clientY);
      if (hit) onPickBreakRef.current?.(hit.x, hit.y, hit.z);
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
      if (interact3dRef.current !== "build") return;
      if (buildRepeatFired) { buildRepeatFired = false; return; }
      const hit = await pick(e.clientX, e.clientY);
      if (!hit) return;
      const t = clickTarget(hit); // build → placement cell
      const c = threeToEden(camera.position);
      if (Math.floor(c.x) === t.x && Math.floor(c.y) === t.y && Math.floor(c.z) === t.z) return;
      onPickPlaceRef.current?.(t.x, t.y, t.z, placeYaw(e.clientX, e.clientY));
    };

    const onPickMove = (e: PointerEvent) => {
      cursorX = e.clientX; cursorY = e.clientY;
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
    canvas.addEventListener("pointerup", onPickUp);
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
      // Escape cancels a live sculpt hold/grab stroke in ANY camera mode (the fly-mode Escape below
      // only fires while walking). Doesn't return — App's own Escape handling still runs.
      if (e.key === "Escape") cancelSculptStroke();
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
      if (["w", "a", "s", "d", "e", "q", " ", "control", "shift"].includes(e.key.toLowerCase())) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.key.toLowerCase()); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Losing window focus (alt-tab, devtools) can swallow the keyup for a held direction key, leaving
    // it stuck in the set so the camera drifts indefinitely. Clear on blur. Also drop out of look
    // mode — a persistent OS cursor grab would otherwise freeze the cursor in whatever app we tab to.
    const onBlur = () => { keys.clear(); lookDrag = false; cancelSculptStroke(); stopBuildRepeat(); if (camModeRef.current === "look") applyMode("orbit"); };
    window.addEventListener("blur", onBlur);

    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    const WORLD_UP = new THREE.Vector3(0, 1, 0);

    // Reused per-frame for frustum culling of loaded chunk meshes.
    const frustum = new THREE.Frustum();
    const viewProj = new THREE.Matrix4();

    let prev = performance.now();
    let disposed = false;
    let lastEmitT = 0;
    let lastEmitExternalT = 0;
    let lastEmitEX = NaN, lastEmitEY = NaN;

    // Orbit-controls "change" wakes the loop whenever the user drags/zooms; damping keeps it alive
    // until inertia settles (controls.update() returns false), then it goes fully idle.
    controls.addEventListener("change", invalidate);
    // streamSweep runs on its own interval — independent of render cadence.
    const sweepInterval = setInterval(streamSweep, STREAM_MS);

    // Kick off: first chunk load + first render.
    streamSweep();
    invalidate();

    // Hoisted function declaration so `invalidate` (defined above) can reference `frame` safely.
    function frame() {
      rafPending = false;
      if (disposed) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;

      const wasDirty = dirty;
      dirty = false;

      let keepGoing = false;

      if (flyModeRef.current) {
        euler.set(pitch, yaw, 0);
        camera.quaternion.setFromEuler(euler);
        camera.getWorldDirection(fwd);
        right.crossVectors(fwd, WORLD_UP).normalize();
        const boost = keys.has("shift") ? 3.5 : 1;
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
        const reach = Math.max(64, loadRadiusRef.current * 16); // world units of loaded terrain
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
        // Pushed straight into the leaf HUD's own state — a setState here would re-render the whole
        // pane (and everything its render creates) ~10× a second while the camera moves.
        hudRef.current?.set({ x: Math.round(ex), y: Math.round(ey), z: Math.round(camera.position.y), heading });
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
      camera.position.set(s.x, maxZ + 60, s.y + 110);
      controls.target.set(s.x, Math.min(maxZ, 28), s.y);
      controls.update();
      streamSweep(); // re-prioritise chunk streaming around the new viewpoint
      invalidate();
    };

    // Teleport camera to an Eden world XY position, keeping the current height.
    // Force an immediate chunk sweep so old far-away chunks are cleared right away.
    const teleport = (wx: number, wy: number) => {
      camera.position.x = wx;
      camera.position.z = wy; // Three.js Z = Eden Y
      controls.target.x = wx;
      controls.target.z = wy;
      controls.update();
      streamSweep(); // immediate sweep without waiting for the next interval tick
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

    sceneApi.current = {
      scene, camera, reloadChunk, reloadAllChunks, resetCamera, teleport, setOverlays, setFog, setMaxDpr,
      // Flip the scene lighting, then rebuild every chunk mesh (material + normals + flat-vs-baked
      // geometry all differ between modes).
      setGpuShadows: () => { applyGpuLighting(); reloadAllChunks(); },
      updateGpuLighting: () => applyGpuLighting(),
      refreshNightLights: () => updateNightLights(),
      refresh: () => invalidate(),
      clearHighlight: () => { setHighlight(null); stopBuildRepeat(); },
      clearSculpt: () => { cancelSculptStroke(); placeBrush(null); },
      setOrbitLeftEnabled,
    };

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
      canvas.removeEventListener("pointerup", onPickUp);
      canvas.removeEventListener("pointermove", onPickMove);
      canvas.removeEventListener("pointerleave", onPickLeave);
      canvas.removeEventListener("contextmenu", onPickContext);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      for (const k of new Set([...meshes.keys(), ...meshesT.keys(), ...meshesE.keys()])) disposeMesh(k);
      clearOverlays();
      scene.remove(highlight);
      scene.remove(breakHighlight);
      scene.remove(brushGroup);
      hlGeom.dispose();
      hlMat.dispose();
      hlBreakMat.dispose();
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
      // dispose() only — do NOT forceContextLoss() here. The renderer binds to the fixed <canvas>
      // ref, and a canvas can own just one WebGL context for its lifetime. Losing it would leave a
      // dead context that the next init on the same canvas (React StrictMode's double-mount, HMR)
      // would reuse — `new WebGLRenderer` then crashes in getShaderPrecisionFormat. dispose() frees
      // GPU resources while leaving the context healthy for reuse. (Mirrors ThreeDPreview.)
      renderer.dispose();
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
  // Re-init only when world dimensions change (new world loaded).
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
    if (interact3d !== "select" && interact3d !== "build") api.clearHighlight();
    if (interact3d !== "sculpt") api.clearSculpt();
    api.setOrbitLeftEnabled(interact3d !== "sculpt");
  }, [interact3d]);

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
  // camera flies away and back. Expand the reload rect by that reach, converted to whole chunks.
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
    const cx0 = Math.floor(lastEdit.x / 16) - chunkPad;
    const cy0 = Math.floor(lastEdit.y / 16) - chunkPad;
    const cx1 = Math.floor((lastEdit.x + Math.max(0, lastEdit.w - 1)) / 16) + chunkPad;
    const cy1 = Math.floor((lastEdit.y + Math.max(0, lastEdit.h - 1)) / 16) + chunkPad;
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++)
        api.reloadChunk(cx, cy);
    // GPU night: a placed/broken lamp changes the point-light set — re-query around the camera.
    if (gpuShadowsRef.current && nightLighting) api.refreshNightLights();
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

  // Texture pack sync: rebuild the DataTexture + material when the pack changes.
  useEffect(() => {
    if (atlasTexRef.current) { atlasTexRef.current.dispose(); atlasTexRef.current = null; }
    if (texMatRef.current) { texMatRef.current.dispose(); texMatRef.current = null; }
    if (texMatTRef.current) { texMatTRef.current.dispose(); texMatTRef.current = null; }
    if (texMatLRef.current) { texMatLRef.current.dispose(); texMatLRef.current = null; }
    if (texMatLTRef.current) { texMatLTRef.current.dispose(); texMatLTRef.current = null; }
    if (depthMatTexRef.current) { depthMatTexRef.current.dispose(); depthMatTexRef.current = null; }
    if (texturePack) {
      const { rgba, tile, rows } = texturePack;
      const tex = new THREE.DataTexture(
        new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        tile, tile * rows,
        THREE.RGBAFormat,
      );
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
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
  }, [texturePack]);

  // Reload all chunk meshes when the texture epoch changes (pack loaded / unloaded / toggled).
  useEffect(() => {
    sceneApi.current?.reloadAllChunks();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texEpoch]);

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
            title={`Resident chunk geometry hit the ${(VERTEX_BUDGET / 1e6).toFixed(0)}M vertex budget — streaming is paused until you fly away from some of it to free headroom.`}
            style={{
              padding: "1px 5px", borderRadius: 4, fontSize: 9,
              background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)",
              color: "#ef4444",
            }}
          >
            render distance limited by memory
          </span>
        )}
      </div>
      {/* Camera reset button (A4) */}
      <div style={{ position: "absolute", top: 6, right: 6, zIndex: 1, display: "flex", alignItems: "center", gap: 6 }}>
        {/* Render distance slider */}
        <div style={chromeButton({
          display: "flex", alignItems: "center", gap: 4,
          padding: "2px 6px", cursor: "default",
        })}>
          <span style={{ fontSize: 9, color: "#83786c", userSelect: "none" }} aria-hidden="true">R</span>
          <input
            type="range" min={2} max={MAX_RENDER_DISTANCE} step={1} value={loadRadius}
            onChange={e => {
              const v = Number(e.target.value);
              loadRadiusRef.current = v;
              setLoadRadius(v);
              onRenderDistanceChangeRef.current?.(v);
              // Fog distance derives from render distance — refresh it live as the slider moves.
              sceneApi.current?.setFog(fogEnabledRef.current, fogColorRef.current);
            }}
            title={`Render distance: ${loadRadius} chunks`}
            aria-label={`Render distance: ${loadRadius} chunks`}
            style={{ width: 60, cursor: "pointer", accentColor: "#83786c" }}
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
                  : `L break · R place${armedLabel ? ` ${armedLabel}` : ""}`}
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
