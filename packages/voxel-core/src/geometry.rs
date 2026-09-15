//! Live 3D geometry pipeline: per-chunk face-culled/greedy-meshed mesh generation, directional
//! face-shading, optional night-lighting + sun-shadow previews, and voxel picking (DDA raycast).
//! This is what a fly-through pane's chunk streaming (`get_chunk_geometry`), the ortho/slab
//! viewports and block picking all depend on — it is *not* an export module despite the filename it
//! used to have (`export.rs`); static-format export (OBJ/JSON/VOX) was removed and now lives in the
//! sibling `EdenToMC` project, which ported `obj_geometry_region`'s predecessor logic on its own
//! terms rather than depending on this file.
//!
//! **Everything here is generic over [`VoxelView`]** (plan PR-C): the app owns the world type, the
//! `#[tauri::command]` wrappers and the IPC envelope; this module owns the meshing. The only
//! whole-world facts it needs beyond block addressing arrive in a [`ViewMeta`].
use crate::colors::{block_color, transparent_alpha, BI_NOTSOLID, BI_RAMPORSIDE, BLOCK_INFO};
use crate::blocks::{fluid_base, fluid_level};
use crate::mask::SelectionMask;
use crate::texture::{self, TexturePack};
use crate::view::{scan_z_ceiling, world_max_z, ViewMeta, VoxelView};
#[cfg(test)]
use crate::view::get_block_at;
use rustc_hash::FxHashMap;
use std::cell::Cell;
#[cfg(test)]
use std::collections::HashSet;

/// Single-entry memo for the chunk lookup that dominates [`get_block_at`].
///
/// The geometry loops walk voxel by voxel, and each voxel also probes its six neighbours — so
/// consecutive queries nearly always land in the same 16×16 chunk column, and the hash lookup is
/// pure overhead. Caching the *resolved* result (including "no such chunk", which sparse worlds hit
/// constantly) collapses that to one compare on the common path.
///
/// Uses `Cell` rather than `&mut` so the `&`-capturing lighting/shadow closures can share one
/// cache. That makes it `!Sync`: it is for single-threaded scans only — do not hand it to rayon.
pub struct ChunkCache<'w, V: VoxelView> {
    world: &'w V,
    last: Cell<Option<(i32, i32, Option<&'w [u8]>)>>,
}

impl<'w, V: VoxelView> ChunkCache<'w, V> {
    pub fn new(world: &'w V) -> Self {
        Self { world, last: Cell::new(None) }
    }

    /// Identical in result to `get_block_at(self.world, wx, wy, wz)`.
    #[inline]
    pub fn get(&self, wx: i32, wy: i32, wz: i32) -> (u8, u8) {
        let w: &'w V = self.world;
        if wz < 0 || wz as usize >= w.num_bands() * 16 { return (0, 0); }
        let (mnx, mny) = w.chunk_origin();
        let cx = wx.div_euclid(16) + mnx;
        let cy = wy.div_euclid(16) + mny;
        let slot = match self.last.get() {
            Some((lcx, lcy, r)) if lcx == cx && lcy == cy => r,
            _ => {
                let r = w.chunk_bytes(cx, cy);
                self.last.set(Some((cx, cy, r)));
                r
            }
        };
        let Some(chunk) = slot else { return (0, 0) };
        let lx = wx.rem_euclid(16) as usize;
        let ly = wy.rem_euclid(16) as usize;
        let bi = (wz as usize / 16) * 8192 + lx * 256 + ly * 16 + (wz as usize % 16);
        let pi = bi + 4096;
        if pi < chunk.len() {
            return (chunk[bi], chunk[pi]);
        }
        (0, 0)
    }
}

/// True if this block fully occludes an adjacent face (not air, not notsolid, not ramp/wedge).
pub fn obj_occludes(bt: u8) -> bool {
    let idx = bt as usize;
    idx != 0 && idx < BLOCK_INFO.len() && (BLOCK_INFO[idx] & (BI_NOTSOLID | BI_RAMPORSIDE)) == 0
}


/// The nine vertex buffers one region's mesh becomes, ready for the app to frame into its binary
/// IPC envelope. Deliberately **not** `Serialize` — an app opts a payload into raw-`Response`
/// framing by implementing `tauri::ipc::IpcResponse` on its own newtype over this, and a stray
/// `Serialize` would let tauri's blanket impl silently revert it to base64-in-JSON.
pub struct ObjGeometryResult {
    pub positions: Vec<u8>, // LE f32 triplets (x,y,z) per vertex
    pub colors: Vec<u8>,    // LE f32 triplets (r,g,b 0..1) per vertex
    pub uvs: Vec<u8>,       // LE f32 pairs (u,v) per vertex; empty when no texture pack loaded
    pub vertex_count: u32,
    // Blocks with `transparent_alpha()` (water/fence/glass/new-flower) — mirrors the game's
    // second ATLAS2 vertex buffer, kept separate so the frontend can render them with their own
    // `transparent:true` material instead of blending into the opaque draw call.
    pub positions_t: Vec<u8>,
    pub colors_t: Vec<u8>,  // LE f32 quadruplets (r,g,b,a 0..1) per vertex
    pub uvs_t: Vec<u8>,
    pub vertex_count_t: u32,
    // Emissive stream (RGB, like the opaque one) — populated only in `flat` (GPU-shadow) mode and
    // only with `LAMP_BLOCK_TYPE` faces. Lamps must render fullbright in GPU mode: the flat opaque
    // stream is shaded by Three.js's lit material + ambient, which would darken lamps like any other
    // block, so the frontend draws these faces with an unlit `MeshBasicMaterial` instead. Empty (0)
    // whenever `!flat` — `get_chunk_geometry` passes `flat: false` unless the GPU-shadow path is on,
    // so the default is a `LightMode::default()`-equivalent render with lamp faces staying in the
    // opaque stream.
    pub positions_e: Vec<u8>,
    pub colors_e: Vec<u8>,
    pub uvs_e: Vec<u8>,
    pub vertex_count_e: u32,
}

impl ObjGeometryResult {
    /// The all-empty result: an out-of-grid or entirely unpopulated chunk.
    pub fn empty() -> Self {
        ObjGeometryResult {
            positions: Vec::new(), colors: Vec::new(), uvs: Vec::new(), vertex_count: 0,
            positions_t: Vec::new(), colors_t: Vec::new(), uvs_t: Vec::new(), vertex_count_t: 0,
            positions_e: Vec::new(), colors_e: Vec::new(), uvs_e: Vec::new(), vertex_count_e: 0,
        }
    }

    /// The nine buffers in the order they are concatenated into the IPC body. `uvs*` are empty
    /// when no texture pack is loaded, and `colors_t` is 4 floats per vertex where the others are
    /// 3 or 2 — so the app cannot re-derive these sizes from the vertex counts and must ship the
    /// lengths in the header.
    pub fn buffers(&self) -> [&[u8]; 9] {
        [
            &self.positions, &self.colors, &self.uvs,
            &self.positions_t, &self.colors_t, &self.uvs_t,
            &self.positions_e, &self.colors_e, &self.uvs_e,
        ]
    }

    /// Total wire bytes this result will occupy on the JS side (the nine buffers, exclusive of the
    /// envelope header). The frontend's geometry budget and its dev memory HUD count the same
    /// number — a GPU VBO is the size of the buffer it was uploaded from — so this is the honest
    /// per-chunk memory cost, unlike the vertex counts (which ignore UV/RGBA stream width).
    pub fn wire_bytes(&self) -> usize {
        self.positions.len() + self.colors.len() + self.uvs.len()
            + self.positions_t.len() + self.colors_t.len() + self.uvs_t.len()
            + self.positions_e.len() + self.colors_e.len() + self.uvs_e.len()
    }
}

/// Which of the game's two shipped lighting behaviours a lamp's falloff follows. The original
/// (64z-era) client used a tight, steep-falloff pool (~4 tile effective radius); "New Dawn"
/// (256z) widened it to a much broader, gradual pool (~14 tiles). Both are real, previously-shipped
/// behaviours — not an editor invention — so the profile is a first-class parameter threaded through
/// `LightMode` rather than a single hardcoded curve.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LightingProfile {
    Legacy,
    Modern,
}

impl Default for LightingProfile {
    fn default() -> Self { LightingProfile::Legacy }
}

impl LightingProfile {
    /// The lamp radius (blocks) this profile snaps to when the user hasn't overridden it.
    pub fn default_radius(self) -> f32 {
        match self {
            LightingProfile::Legacy => LEGACY_LAMP_RADIUS,
            LightingProfile::Modern => MODERN_LAMP_RADIUS,
        }
    }

    /// Per-lamp intensity contribution at `dist` blocks for a pool of `radius` blocks, in `[0,1]`.
    /// Legacy: quadratic falloff — stays bright near the lamp then drops off abruptly, matching the
    /// small, sharp-edged pools of the original 64z client. Modern: linear falloff — the same shape
    /// New Dawn's much larger radius already reads as "gradual" (its per-tile slope is `1/radius`,
    /// shallower simply because radius is ~3.5x larger), so it keeps the existing curve.
    fn falloff(self, dist: f32, radius: f32) -> f32 {
        let t = (1.0 - dist / radius).max(0.0);
        match self {
            LightingProfile::Legacy => t * t,
            LightingProfile::Modern => t,
        }
    }
}

/// Night-lighting/shadow preview toggles for `obj_geometry_region`. Both default off, reproducing
/// a flat fully-lit render exactly (`LightMode::default()`) — only `FlyView3D`'s chunk streaming
/// (via `get_chunk_geometry`) opts in.
#[derive(Clone, Copy, Default)]
pub struct LightMode {
    pub night: bool,
    pub shadows: bool,
    /// Simulated sun position, 0=sunrise, 0.5=noon, 1=sunset (see `sun_direction`). Inert whenever
    /// `shadows` is false; `f32::default()` = 0.0 keeps `LightMode::default()` unaffected.
    pub sun_t: f32,
    /// Emit **flat, unshaded** vertex colours (raw `block_color`, no per-face SH_* shading) for the
    /// opt-in GPU-shadow path: Three.js then does the directional shading + shadow map from real
    /// vertex normals, so baking any shading here would double up. Face *kind* (top/bottom/side, for
    /// texture selection) is still derived from the SH_* constant — only the brightness multiply is
    /// skipped. Mutually exclusive with `night`/`shadows` in practice (the frontend clears them).
    pub flat: bool,
    /// User-tunable lamp light radius (blocks). `<= 0.0` (the `Default`) falls back to
    /// `profile.default_radius()`, so `LightMode::default()` output stays byte-for-byte the flat
    /// fully-lit render. Only `get_chunk_geometry` (FlyView3D) passes a live value.
    pub lamp_radius: f32,
    /// Which falloff curve/default-radius pairing to use (see `LightingProfile`). Independent of
    /// `lamp_radius` — the profile picks the *shape* of the pool; the radius slider can still
    /// override the profile's default distance without changing which curve is used.
    pub profile: LightingProfile,
}

impl LightMode {
    /// Resolve the frontend's raw toggles into the mode the mesher actually runs with.
    ///
    /// GPU-shadow mode emits flat colours (Three.js lights it), so it **overrides** the baked
    /// night/shadow toggles, which would otherwise double-shade. The returned `lamp_radius` is
    /// always concrete (clamped, or the profile's default), because the caller also needs it as the
    /// gather radius for the lamp index — and the two must not be allowed to disagree.
    pub fn resolve(
        night: bool, shadows: bool, sun_t: f32,
        gpu: bool, lamp_radius: Option<f32>, profile: LightingProfile,
    ) -> Self {
        LightMode {
            night: night && !gpu,
            shadows: shadows && !gpu,
            sun_t: sun_t.clamp(0.0, 1.0),
            flat: gpu,
            lamp_radius: lamp_radius.unwrap_or_else(|| profile.default_radius()).clamp(1.0, 64.0),
            profile,
        }
    }
}

pub const LAMP_BLOCK_TYPE: u8 = 72; // TYPE_LIGHTBOX
const LEGACY_LAMP_RADIUS: f32 = 4.0;
const MODERN_LAMP_RADIUS: f32 = 14.0;
const NIGHT_AMBIENT: f32 = 0.35;
const SHADOW_RAY_STEPS: i32 = 24; // unit steps marched toward the sun per voxel

/// Baked-night per-voxel light is snapped to steps of `1/MERGE_LIGHT_STEPS` before anything reads it.
///
/// Lamp falloff is a continuous function of distance, so without this every lit voxel gets its own
/// `f32` triple, every face lands in its own merge group, and greedy meshing degenerates to 1×1 quads
/// on exactly the chunks that already produce the biggest payloads (audit 2026-08-26 Finding 7).
/// Measured on a lamp-lit 16×16 interior: night geometry was **6×–118× the day payload**; snapping to
/// this grid brings it back to ~1.2×–4× (see "Phase 5.3 results" in `TEST WORLDS/fixplan-3d-2026-08-26.md`).
///
/// ⚠️ **Quantize once, at the source.** The value stored in `FaceRec::lm` must be the value that is
/// *rendered*, or merged faces would render as the group head's light while unmerged neighbours
/// (ramps, wedges, partial-height fluid faces) kept their raw value and seamed against them. So this
/// is applied to `lm` itself in the voxel loop, not to the merge key — which keeps `FaceRec`'s
/// "faces merge only when they render bit-identically" contract exactly as written.
///
/// Only baked-night light is snapped. The day path (`[1,1,1]`) and shadows-only (two-tone
/// `SUN_LIT`/`SUN_SHADOW`) are already constant-valued and merge perfectly on their own, so leaving
/// them alone keeps their output byte-for-byte what it was.
const MERGE_LIGHT_STEPS: f32 = 32.0;

/// Snap a light triple onto the `MERGE_LIGHT_STEPS` grid. `1.0` and `0.0` are exact grid points, so
/// fullbright (lamp blocks) and unlit stay exact.
#[inline]
fn quantize_light(lm: [f32; 3]) -> [f32; 3] {
    lm.map(|c| (c * MERGE_LIGHT_STEPS).round() / MERGE_LIGHT_STEPS)
}

/// The largest light value worth distinguishing on a face whose directional shade is `sh`.
///
/// A face's rendered brightness is `(sh * lm).min(1.0)` (`lit_rgb!`), so once `lm` is past `1/sh`
/// the face is fully bright and every larger value renders *identically*. Night light clamps at 1.5
/// and overlapping lamps routinely saturate an interior, so without this cap the merge key
/// distinguishes faces the renderer cannot — a pure loss.
///
/// Clamping `lm` to this cap is **exactly lossless**, not approximately: for `lm < cap` it is the
/// identity, and for `lm >= cap` the emitted `sh * cap` is `>= 1.0` and clamps to the same `1.0` the
/// unclamped value would have. The `to_bits() + 1` nudge is what guarantees the `>= 1.0` half in f32
/// — `sh * (1.0 / sh)` is allowed to land one ULP low. Pinned by `test_merge_light_cap_is_lossless`.
#[inline]
fn merge_light_cap(sh: f32) -> f32 {
    let c = 1.0 / sh;
    if sh * c < 1.0 { f32::from_bits(c.to_bits() + 1) } else { c }
}

#[derive(serde::Serialize)]
pub struct LightConstants {
    pub lamp_light_radius: f32,
    pub legacy_lamp_radius: f32,
    pub modern_lamp_radius: f32,
    pub shadow_ray_steps: i32,
}

/// Exposes the legacy/modern default lamp radii + `SHADOW_RAY_STEPS` to the frontend so the edit-sync
/// reload radius (FlyView3D: a placed lamp/block can affect neighboring chunks up to these distances
/// away when night lighting or shadows are on) can't silently drift out of sync with the Rust
/// constants. `lamp_light_radius` is kept as an alias of `legacy_lamp_radius` for callers that haven't
/// been updated to the per-profile fields yet.
pub fn light_constants() -> LightConstants {
    LightConstants {
        lamp_light_radius: LEGACY_LAMP_RADIUS,
        legacy_lamp_radius: LEGACY_LAMP_RADIUS,
        modern_lamp_radius: MODERN_LAMP_RADIUS,
        shadow_ray_steps: SHADOW_RAY_STEPS,
    }
}
const SUN_SHADOW: f32 = 0.55; // hard shadow multiplier — stays well above black even combined
                               // with the darkest per-face shade constant (SH_W=0.447)
const SUN_LIT: f32 = 1.0;

/// Unit vector pointing from a voxel toward the simulated sun. `sun_t` sweeps a half-arc
/// (sunrise -> noon -> sunset): elevation eases 15°..80°..15° via `sin(pi*t)`, azimuth sweeps
/// 0..pi (east->west) linearly. There's no night-side sun (no sky dome/moon-shadow concept here —
/// "night" is a separate ambient toggle), so this deliberately never goes sub-horizon.
fn sun_direction(sun_t: f32) -> [f32; 3] {
    let az = std::f32::consts::PI * sun_t;
    let el = 15.0f32.to_radians() + (std::f32::consts::PI * sun_t).sin() * 65.0f32.to_radians();
    [el.cos() * az.cos(), el.cos() * az.sin(), el.sin()]
}

/// 3D DDA (Amanatides–Woo) — marches a ray from `(ox,oy,oz)` in direction `dir` (need not be
/// normalized) up to `max_dist` world units, visiting every voxel the ray actually crosses. This is
/// what makes it safe for a shallow ray: stepping by a fixed unit-length offset each iteration (the
/// old approach) advances less than 1 unit along any single axis for a diagonal direction, so
/// `floor()` can jump clean over a one-block-thick occluder (a fence post, a wall seen edge-on, a
/// thin horizontal slab) between two samples. A DDA can't skip a voxel boundary — it steps exactly
/// to the next one on whichever axis is nearest. `hit(x,y,z)` is called for each visited voxel in
/// order; marching stops and returns that voxel's coords on the first `true`, or `None` if the ray
/// exhausts `max_dist` unhit. Doesn't test the origin voxel itself — marching starts at its first
/// exit boundary, matching the old code's "step before testing" behaviour.
fn dda_march(ox: f32, oy: f32, oz: f32, dir: [f32; 3], max_dist: f32, mut hit: impl FnMut(i32, i32, i32) -> bool) -> Option<(i32, i32, i32)> {
    let [dx, dy, dz] = dir;
    let (mut x, mut y, mut z) = (ox.floor() as i32, oy.floor() as i32, oz.floor() as i32);
    let step = |d: f32| -> i32 { if d > 0.0 { 1 } else if d < 0.0 { -1 } else { 0 } };
    let (sx, sy, sz) = (step(dx), step(dy), step(dz));
    let t_delta = |d: f32| -> f32 { if d != 0.0 { (1.0 / d).abs() } else { f32::INFINITY } };
    let (tdx, tdy, tdz) = (t_delta(dx), t_delta(dy), t_delta(dz));
    // Parametric distance from the origin to the first voxel boundary crossed on each axis.
    let boundary = |p: f32, s: i32| -> f32 {
        if s > 0 { p.floor() + 1.0 - p } else if s < 0 { p - p.floor() } else { f32::INFINITY }
    };
    let mut tmx = if sx != 0 { boundary(ox, sx) * tdx } else { f32::INFINITY };
    let mut tmy = if sy != 0 { boundary(oy, sy) * tdy } else { f32::INFINITY };
    let mut tmz = if sz != 0 { boundary(oz, sz) * tdz } else { f32::INFINITY };
    let mut t = 0.0f32;
    while t < max_dist {
        if tmx < tmy && tmx < tmz {
            x += sx; t = tmx; tmx += tdx;
        } else if tmy < tmz {
            y += sy; t = tmy; tmy += tdy;
        } else {
            z += sz; t = tmz; tmz += tdz;
        }
        if hit(x, y, z) { return Some((x, y, z)); }
    }
    None
}

/// The voxel a ray hit, plus the face it entered through as a unit normal in Eden coords
/// (`nx/ny/nz`). `hit + normal` is the empty voxel adjacent to that face — i.e. where a block
/// placed against it goes.
#[derive(serde::Serialize)]
pub struct PickResult {
    pub x: i32, pub y: i32, pub z: i32,
    pub block_type: u8,
    pub paint: u8,
    pub nx: i32, pub ny: i32, pub nz: i32,
}

/// Maximum ray length for `pick_block`, in blocks. Clamps a bad/hostile `max_dist` so a single
/// pick can't march the whole world.
const PICK_MAX_DIST: f32 = 512.0;

/// Casts a ray through the voxel grid and returns the first non-air block it enters, or `None`.
///
/// Origin and direction are in **Eden** coords (X east, Y south, Z up) — the caller owns the
/// Three.js↔Eden transform, so this stays a pure world-space query usable by any viewport.
///
/// Ramps and wedges (24..=55) pick as full cubes: the ray hits them at their voxel bounds, not at
/// their true sloped surface. Eden's own placement does roughly this, and the alternative (exact
/// prism/pyramid intersection per block type) buys very little for a picker whose result snaps to a
/// voxel anyway. Non-solid blocks (water, glass, fence, flowers) are hits too — you can break and
/// build against them, which matches what the block under the crosshair looks like.
/// Lock-free core of the app's `pick_block` command, so it can be tested against a bare world.
pub fn pick_block_in(
    world: &impl VoxelView,
    ox: f32, oy: f32, oz: f32,
    dx: f32, dy: f32, dz: f32,
    max_dist: f32,
) -> Result<Option<PickResult>, String> {
    let len = (dx * dx + dy * dy + dz * dz).sqrt();
    if !len.is_finite() || len < 1e-6 {
        return Err("pick_block: degenerate ray direction".into());
    }
    if !ox.is_finite() || !oy.is_finite() || !oz.is_finite() {
        return Err("pick_block: non-finite ray origin".into());
    }
    let dir = [dx / len, dy / len, dz / len];
    let dist = max_dist.clamp(0.0, PICK_MAX_DIST);

    // One `ChunkCache` for the whole march: the DDA walks voxel by voxel and long runs stay in the
    // same 16×16 column, so the per-step `chunk_range` hash lookup is almost always redundant. Worst
    // case is a ray fired into open sky — the full ~890 steps with no early-out — which is also the
    // common case for a hover pick aimed at the horizon. `ChunkCache` is `!Sync`; this march is
    // single-threaded, so do not rayon-ize it.
    let cache = ChunkCache::new(world);

    // `dda_march` never tests the origin voxel, so the voxel preceding the first visited one is the
    // origin voxel itself — seeding `prev` with it makes the entry normal correct even for a hit on
    // the very first step.
    let mut prev = (ox.floor() as i32, oy.floor() as i32, oz.floor() as i32);
    let mut found: Option<(i32, i32, i32)> = None;
    let hit = dda_march(ox, oy, oz, dir, dist, |vx, vy, vz| {
        if cache.get(vx, vy, vz).0 != 0 {
            found = Some((vx, vy, vz));
            true
        } else {
            prev = (vx, vy, vz);
            false
        }
    });
    let Some((x, y, z)) = hit.and(found) else { return Ok(None) };
    let (bt, paint) = cache.get(x, y, z);
    Ok(Some(PickResult {
        x, y, z,
        block_type: bt,
        paint,
        nx: prev.0 - x, ny: prev.1 - y, nz: prev.2 - z,
    }))
}

/// One plain-cube face, deferred out of the voxel pass so coplanar neighbours can be greedily merged
/// into a single large quad before any vertex exists (Stage 5 of the 3D-pane crash fix).
///
/// `dir` also fixes the face's plane and its two in-plane axes, so `slice`/`u`/`v` are enough to
/// rebuild the world-space rectangle — see `MERGE_DIRS` and the emission loop at the end of
/// `obj_geometry_region`:
///
/// | `dir` | face | plane | `slice` | `u` | `v` |
/// |---|---|---|---|---|---|
/// | 0 | top    | `z = slice+1` | `wz` | `wx` | `wy` |
/// | 1 | bottom | `z = slice`   | `wz` | `wx` | `wy` |
/// | 2 | south (+Y) | `y = slice+1` | `wy` | `wx` | `wz` |
/// | 3 | north (−Y) | `y = slice`   | `wy` | `wx` | `wz` |
/// | 4 | east (+X)  | `x = slice+1` | `wx` | `wy` | `wz` |
/// | 5 | west (−X)  | `x = slice`   | `wx` | `wy` | `wz` |
///
/// **Field order is the merge key and it is load-bearing**: `derive(Ord)` sorts lexicographically by
/// declaration order, so sorting the whole face list groups everything that may merge — same
/// direction, same plane, same block, same light — into one contiguous run ordered (v, u), which is
/// exactly the scan order the greedy rectangle pass wants. `lm` is stored as raw bits because two
/// faces may only merge when they render *bit-identically*; that is what keeps per-block lamp light
/// and sun shadows intact through the merge instead of averaging them across a big quad.
///
/// Two things widen what counts as "identical" in baked-night mode, where a continuous lamp falloff
/// would otherwise give every lit voxel its own group (audit 2026-08-26 Finding 7):
/// `MERGE_LIGHT_STEPS` snaps the light itself onto a fixed grid at the point it is computed (so the
/// stored bits stay exactly the rendered value, for merged and unmerged faces alike), and
/// `merge_light_cap` clamps the key at the brightness where this face direction's shade already
/// saturates — losslessly, since everything past it renders the same white.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct FaceRec {
    dir: u8,
    slice: i32,
    bt: u8,
    paint: u8,
    lm: [u32; 3],
    v: i32,
    u: i32,
}

/// Face-culled cube/ramp/wedge geometry for an arbitrary world box, encoded as LE f32 position +
/// colour triplets (Three.js Y-up coords). The core of `get_chunk_geometry` (world-scale fly-through
/// chunk streaming) — the shaped-selection `mask` param below is now exercised only by tests (it was
/// also used by the removed `get_obj_geometry` 64³ selection-preview command; kept, unused by any
/// live caller, because the mask-aware behaviour it gates is still covered by
/// `test_obj_geometry_respects_mask`).
///
/// Plain cube faces are **greedily meshed**: instead of six quads per voxel, coplanar adjacent faces
/// that render identically fuse into one large quad, which is what keeps a 256z world's chunk
/// payload (and the GPU buffers it becomes) proportional to the terrain's *surface complexity*
/// rather than its voxel count. Ramps, wedges and partial-height fluid faces stay per-block — they
/// are not unit squares, so there is nothing to tile. See `FaceRec`.
#[allow(clippy::too_many_arguments)]
pub fn obj_geometry_region(world: &impl VoxelView, meta: ViewMeta, pack: Option<&TexturePack>, sx1: i32, sy1: i32, sx2: i32, sy2: i32, sz1: i32, sz2: i32, lamps: &[([i32; 3], [f32; 3])], mode: LightMode, mask: Option<&SelectionMask>) -> ObjGeometryResult {
    // Every block read below goes through the chunk-address memo. Single-threaded by construction
    // (see ChunkCache) — this function is not parallelised.
    let cache = ChunkCache::new(world);
    // Shaped selection: an unmasked column reads as air here, so both emission and occlusion see
    // the hole through the single block-getter — side faces at hole edges emit correctly without a
    // separate emission-loop gate. `None` (the only value `get_chunk_geometry`'s FlyView3D streaming
    // ever passes) is a no-op. Exercised directly by tests, since the mask-resolving caller
    // (`active_mask`) it used to sit behind — the removed `get_obj_geometry` 64³ selection-preview
    // command — no longer exists.
    let gb = |wx: i32, wy: i32, wz: i32| {
        if mask.is_some_and(|m| !m.contains(wx, wy)) { return (0u8, 0u8); }
        cache.get(wx, wy, wz)
    };

    // Face-culling neighbour getter — `gb` clipped to the emitted z range. A block just *outside*
    // `[sz1, sz2]` is not part of this render, so it must not occlude the face it touches: without
    // this, clipping the range (FlyView3D's camera band / cutaway cap, or any sub-column selection
    // preview) culls the top face of the topmost emitted block and the bottom face of the lowest,
    // producing a see-through roof/floor at the cut plane. Only the vertical lookups can leave the
    // range — laterals share `wz`, so `gbz == gb` for them — but every neighbour read in the
    // emission loop goes through it so a future lookup can't reintroduce the hole.
    //
    // Deliberately NOT used by `shadow_at`: the sun raymarch reads the *real* world, so a clipped
    // render keeps the shadows it would have had unclipped (a ray escaping the band must still be
    // blocked by the terrain above it).
    let gbz = |wx: i32, wy: i32, wz: i32| -> (u8, u8) {
        if wz < sz1 || wz > sz2 { return (0u8, 0u8); }
        gb(wx, wy, wz)
    };

    // Emitted directly as LE bytes (audit I-1) rather than as `Vec<f32>` converted afterwards —
    // that used to cost a doubling-realloc `Vec<f32>` *and* a `flat_map().collect()` pass per
    // stream, ~3× the wire payload in transient allocator traffic per chunk. `push_f32!` is the one
    // place a float becomes bytes.
    let mut pos_f: Vec<u8> = Vec::new();
    let mut col_f: Vec<u8> = Vec::new();
    let mut uv_f:  Vec<u8> = Vec::new();
    // Transparent stream (water/glass/fence/new-flower) — same layout except colors are RGBA.
    let mut pos_ft: Vec<u8> = Vec::new();
    let mut col_ft: Vec<u8> = Vec::new();
    let mut uv_ft:  Vec<u8> = Vec::new();
    // Emissive stream (lamp blocks in flat/GPU mode) — RGB, drawn unlit by the frontend so lamps
    // stay fullbright. Only populated when `mode.flat`.
    let mut pos_ef: Vec<u8> = Vec::new();
    let mut col_ef: Vec<u8> = Vec::new();
    let mut uv_ef:  Vec<u8> = Vec::new();

    // Push one f32 as LE bytes — the sole float→byte conversion site the macros below funnel
    // through, so the wire format (`to_le_bytes`, explicit and endianness-correct) can't drift.
    macro_rules! push_f32 {
        ($buf:expr, $v:expr) => { $buf.extend_from_slice(&($v as f32).to_le_bytes()); };
    }

    // Deferred plain-cube faces, merged and emitted after the voxel pass (see `FaceRec`). A record is
    // ~28 B where the six vertices it stands for cost ≥ 144 B, so collecting first is cheaper in peak
    // memory than emitting first — before merging removes any of them.
    let mut faces: Vec<FaceRec> = Vec::new();

    // Lamp positions + light colour within reach of this region are supplied by the caller (only
    // populated when night preview is on — day-lit/no-lamp regions pass an empty slice). The caller
    // (`get_chunk_geometry`) gathers them from the chunk-keyed lamp spatial index rather than scanning
    // the voxel volume, so the lamp radius can be a user slider without the scan going cubic in radius.
    // Colour is the lamp block's own paint via the same `block_color` lookup normal painted blocks use
    // (Lighting.mm `addlight` is passed `colorTable[getColorc(x,z,y)]` — the lamp's paint index into
    // the shared paint table, not a dedicated lamp-colour table).
    let lamp_radius = if mode.lamp_radius > 0.0 { mode.lamp_radius } else { mode.profile.default_radius() };

    let sun_dir = sun_direction(mode.sun_t);

    // Per-block, per-channel light: Eden's `calcLight` adds each nearby lamp's `colorTable[paint]`
    // (scaled by linear falloff) onto the ambient base independently per R/G/B channel (Terrain.mm
    // `calcLight`/`addlight` keep a `Vector8 lightarray` — one accumulator per channel, not a single
    // scalar), then clamps to [0, 1.5]. Keeping the channels separate is what makes a red lamp cast
    // red light instead of just a brighter grey. Evaluated once per voxel (not per vertex) — a
    // per-block approximation of the game's per-voxel lightarray grid. Lamp blocks themselves render
    // fullbright, matching the game.
    let light_at = |wx: i32, wy: i32, wz: i32, bt: u8| -> [f32; 3] {
        if !mode.night || bt == LAMP_BLOCK_TYPE { return [1.0, 1.0, 1.0]; }
        let mut l = [NIGHT_AMBIENT; 3];
        for (&[lx, ly, lz], &color) in lamps.iter().map(|(p, c)| (p, c)) {
            let dx = (wx - lx) as f32;
            let dy = (wy - ly) as f32;
            let dz = (wz - lz) as f32;
            let dist = (dx * dx + dy * dy + dz * dz).sqrt();
            if dist < lamp_radius {
                let contrib = mode.profile.falloff(dist, lamp_radius);
                l[0] += contrib * color[0];
                l[1] += contrib * color[1];
                l[2] += contrib * color[2];
            }
        }
        [l[0].clamp(0.0, 1.5), l[1].clamp(0.0, 1.5), l[2].clamp(0.0, 1.5)]
    };

    // Directional sun-raycast shadow: march a 3D DDA toward the sun (see `sun_direction`) for
    // SHADOW_RAY_STEPS world units; if any voxel the ray actually crosses is solid/occluding, the
    // origin voxel is in shadow. Hard two-tone (SUN_LIT/SUN_SHADOW) — no soft falloff. `sun_dir` is
    // constant for the whole region, so it's computed once above rather than per voxel.
    let shadow_at = |wx: i32, wy: i32, wz: i32| -> f32 {
        if !mode.shadows { return 1.0; }
        let hit = dda_march(
            wx as f32 + 0.5, wy as f32 + 0.5, wz as f32 + 0.5,
            sun_dir, SHADOW_RAY_STEPS as f32,
            |vx, vy, vz| obj_occludes(gb(vx, vy, vz).0),
        );
        if hit.is_some() { SUN_SHADOW } else { SUN_LIT }
    };

    // Directional face-shading baked into vertex colours — replaces normal-based lighting.
    // Magnitudes match the game's own fixed per-face shading table (cubeColors[] in
    // Geometry.c: {216,140,191,114,153,255} normalized); there's no real directional sun to
    // align to, just this fixed fake-AO pattern, so only the six magnitudes matter here.
    const SH_TOP: f32 = 1.00;
    const SH_BOT: f32 = 0.60;
    const SH_E:   f32 = 0.847; // east  (+X)
    const SH_W:   f32 = 0.447; // west  (-X)
    const SH_S:   f32 = 0.549; // south (+Y)
    const SH_N:   f32 = 0.749; // north (-Y)

    // Per-`FaceRec::dir` saturation cap for the greedy-merge light key — see `merge_light_cap` and
    // the `FaceRec` doc comment. Indexed by `dir` (0 top, 1 bottom, 2 south, 3 north, 4 east, 5 west),
    // which is why the order here has to match `MERGE_DIRS`/the emission `match` at the end.
    let light_cap: [f32; 6] = [SH_TOP, SH_BOT, SH_S, SH_N, SH_E, SH_W].map(merge_light_cap);

    // Detect face kind from shade constant so per-face textures work without touching every call site.
    // SH_TOP → top face (2), SH_BOT → bottom face (1), anything else → side face (0).
    // Wedge diagonal blended shades ((SH_N+SH_W)*0.5 etc.) are not equal to SH_TOP/SH_BOT → side.
    macro_rules! face_kind {
        ($sh:expr) => {{
            let s: f32 = $sh;
            if s == SH_TOP { 2u8 } else if s == SH_BOT { 1u8 } else { 0u8 }
        }};
    }

    // Push UV coords for a quad (6 verts: ABD, BCD) covering atlas row with v in [v0,v1], into a
    // caller-chosen buffer (opaque `uv_f` or transparent `uv_ft`).
    //
    // `$nu` is how many block-sized tiles the quad spans along its U axis — 1 for every per-block
    // quad, and the merged width for a greedy-meshed face (see `FaceRec` below). U therefore runs
    // 0..$nu instead of 0..1, which needs `wrapS = RepeatWrapping` on the atlas texture; the atlas is
    // exactly one tile wide (`texturepack.rs`: `atlas_w = TILE`), so repeating in U re-tiles the same
    // column and never bleeds into a neighbouring row. **V has no such freedom** — the atlas is a
    // vertical strip and V selects the row, so tiling it would walk into the next block's texture.
    // That is why greedy merging only grows along V when no pack is loaded.
    macro_rules! push_quad_uv {
        ($buf:expr, $v0:expr, $v1:expr, $nu:expr) => {{
            let nu: f32 = $nu;
            for f in [0.0, $v0,  nu, $v0,  0.0, $v1,
                      nu, $v0,   nu, $v1,  0.0, $v1] { push_f32!($buf, f); }
        }};
    }
    // Push UV coords for a triangle covering the same atlas row.
    macro_rules! push_tri_uv {
        ($buf:expr, $v0:expr, $v1:expr) => {
            for f in [0.0, $v0,  1.0, $v0,  0.5, $v1] { push_f32!($buf, f); }
        };
    }

    // Per-channel colour after light + face shading, capped so light can brighten a shaded face back
    // up to its flat paint colour but never past it — mirrors TerrainChunk.mm's
    // `if(color>paint[coord]*255) color=paint[coord]*255` (light recovers full colour, it doesn't
    // blow it out).
    // Flat (GPU-shadow) mode skips the per-face SH_* shading and lamp/shadow multiplier entirely —
    // Three.js supplies all lighting downstream. `$sh` is still passed to `face_kind!` in the macros
    // for texture selection; only the brightness multiply here is neutralised.
    let flat = mode.flat;
    macro_rules! lit_rgb {
        ($rgb2:expr, $sh:expr, $lm:expr) => {{
            let rgb2 = $rgb2;
            let sh: f32 = if flat { 1.0 } else { $sh };
            let lm: [f32; 3] = if flat { [1.0, 1.0, 1.0] } else { $lm };
            [
                rgb2[0] as f32 / 255.0 * (sh * lm[0]).min(1.0),
                rgb2[1] as f32 / 255.0 * (sh * lm[1]).min(1.0),
                rgb2[2] as f32 / 255.0 * (sh * lm[2]).min(1.0),
            ]
        }};
    }

    macro_rules! push_tri {
        ($verts:expr, $rgb:expr, $sh:expr, $lm:expr, $btype:expr, $bpaint:expr) => {{
            let fk = face_kind!($sh);
            let (rgb2, row_opt) = if let Some(p) = pack {
                texture::face_color_and_row(p, $btype, $bpaint, fk, $rgb)
            } else { ($rgb, None) };
            let [r,g,b] = lit_rgb!(rgb2, $sh, $lm);
            if flat && $btype == LAMP_BLOCK_TYPE {
                for (x,y,z) in $verts { push_f32!(pos_ef, x); push_f32!(pos_ef, y); push_f32!(pos_ef, z); push_f32!(col_ef, r); push_f32!(col_ef, g); push_f32!(col_ef, b); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_tri_uv!(uv_ef, v1, v0);
                }
            } else if let Some(alpha) = transparent_alpha($btype) {
                for (x,y,z) in $verts { push_f32!(pos_ft, x); push_f32!(pos_ft, y); push_f32!(pos_ft, z); push_f32!(col_ft, r); push_f32!(col_ft, g); push_f32!(col_ft, b); push_f32!(col_ft, alpha); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_tri_uv!(uv_ft, v1, v0);
                }
            } else {
                for (x,y,z) in $verts { push_f32!(pos_f, x); push_f32!(pos_f, y); push_f32!(pos_f, z); push_f32!(col_f, r); push_f32!(col_f, g); push_f32!(col_f, b); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_tri_uv!(uv_f, v1, v0); // swap: $v0 arg → floor vertex, $v1 arg → apex; tile reads top→bottom
                }
            }
        }};
    }
    // Tiled quad: `$nu` block-tiles along U (1 for a per-block face, the merged width for a
    // greedy-meshed one). `push_quad!` below is the 1-tile wrapper every ramp/wedge/partial-fluid
    // call site uses.
    macro_rules! push_quad_t {
        ($a:expr,$b:expr,$c:expr,$d:expr,$rgb:expr,$sh:expr,$lm:expr,$btype:expr,$bpaint:expr,$nu:expr) => {{
            let fk = face_kind!($sh);
            let (rgb2, row_opt) = if let Some(p) = pack {
                texture::face_color_and_row(p, $btype, $bpaint, fk, $rgb)
            } else { ($rgb, None) };
            let [r,g,b_] = lit_rgb!(rgb2, $sh, $lm);
            if flat && $btype == LAMP_BLOCK_TYPE {
                for (x,y,z) in [$a,$b,$d, $b,$c,$d] { push_f32!(pos_ef, x); push_f32!(pos_ef, y); push_f32!(pos_ef, z); push_f32!(col_ef, r); push_f32!(col_ef, g); push_f32!(col_ef, b_); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_quad_uv!(uv_ef, v1, v0, $nu);
                }
            } else if let Some(alpha) = transparent_alpha($btype) {
                for (x,y,z) in [$a,$b,$d, $b,$c,$d] { push_f32!(pos_ft, x); push_f32!(pos_ft, y); push_f32!(pos_ft, z); push_f32!(col_ft, r); push_f32!(col_ft, g); push_f32!(col_ft, b_); push_f32!(col_ft, alpha); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_quad_uv!(uv_ft, v1, v0, $nu);
                }
            } else {
                for (x,y,z) in [$a,$b,$d, $b,$c,$d] { push_f32!(pos_f, x); push_f32!(pos_f, y); push_f32!(pos_f, z); push_f32!(col_f, r); push_f32!(col_f, g); push_f32!(col_f, b_); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_quad_uv!(uv_f, v1, v0, $nu); // swap: $v0 arg → A/B vertices, $v1 arg → C/D vertices; tile reads top→bottom
                }
            }
        }};
    }
    macro_rules! push_quad {
        ($a:expr,$b:expr,$c:expr,$d:expr,$rgb:expr,$sh:expr,$lm:expr,$btype:expr,$bpaint:expr) => {
            push_quad_t!($a,$b,$c,$d,$rgb,$sh,$lm,$btype,$bpaint, 1.0)
        };
    }

    // Emission ceiling from the per-chunk top-occupied-band hint (`VoxelView::top_band_hint`),
    // taken as the max over every chunk this region touches — in the live path that is one chunk,
    // since `chunk_geometry` calls this with a single 16×16 footprint. Everything between this and
    // `sz2` is air by contract, so skipping it changes nothing and saves a 16×16 scan per empty
    // band (the whole cost a tall, mostly-empty 256z chunk pays before a single vertex exists).
    //
    // ⚠️ Deliberately does NOT narrow `gbz`, which keeps clipping at the caller's `sz2`: the
    // face-culling contract ("a block outside [sz1, sz2] must not occlude the face it touches") is
    // about the *requested* band, and narrowing it here would be a second, invisible cut plane.
    // Since everything skipped is air, both getters agree anyway — this just keeps them provably
    // independent.
    let ez2 = {
        let (mnx, mny) = world.chunk_origin();
        let mut top = i32::MIN;
        for cy in sy1.div_euclid(16) + mny..=sy2.div_euclid(16) + mny {
            for cx in sx1.div_euclid(16) + mnx..=sx2.div_euclid(16) + mnx {
                top = top.max(scan_z_ceiling(world, cx, cy));
            }
        }
        sz2.min(top)
    };

    for wz in sz1..=ez2 {
        for wy in sy1..=sy2 {
            for wx in sx1..=sx2 {
                let (bt, paint) = gb(wx, wy, wz);
                if bt == 0 { continue; }

                // A face is invisible if the neighbor fully occludes it, OR the neighbor is the same
                // block type as this voxel — two adjacent water/glass/fence blocks (all BI_NOTSOLID,
                // so `obj_occludes` alone says false) share a face that's never actually visible from
                // either side, but without this they both still emit it. For a deep water column this
                // is the difference between ~6 quads/block and 0 for every interior block.
                let face_hidden = |nbt: u8| obj_occludes(nbt) || nbt == bt;

                let is_ramp_or_wedge = matches!(bt, 24..=55);
                // Ramp/wedge branches below do their own neighbor lookups (their diagonal face is
                // unconditional, so there's no early-out for them); only plain cubes reuse these.
                let (n_top, n_bot, n_s, n_n, n_e, n_w) = if is_ramp_or_wedge {
                    (0, 0, 0, 0, 0, 0)
                } else {
                    (
                        gbz(wx, wy, wz + 1).0,
                        gbz(wx, wy, wz - 1).0,
                        gbz(wx, wy + 1, wz).0,
                        gbz(wx, wy - 1, wz).0,
                        gbz(wx + 1, wy, wz).0,
                        gbz(wx - 1, wy, wz).0,
                    )
                };
                // Cheap early-out: a plain cube with every face hidden emits nothing, so skip the
                // lamp/shadow lighting below entirely — that's the expensive part (O(lamps) per voxel
                // plus a 24-step shadow raymarch), today paid by every voxel even when nothing is drawn.
                if !is_ramp_or_wedge
                    && face_hidden(n_top) && face_hidden(n_bot)
                    && face_hidden(n_s) && face_hidden(n_n)
                    && face_hidden(n_e) && face_hidden(n_w)
                {
                    continue;
                }

                let rgb = block_color(bt, paint, meta.sky);
                let base_lm = light_at(wx, wy, wz, bt);
                let shadow = shadow_at(wx, wy, wz);
                let lm = [base_lm[0] * shadow, base_lm[1] * shadow, base_lm[2] * shadow];
                // Baked-night light varies continuously with distance-to-lamp; snap it so that
                // near-identical neighbours can fuse in the greedy mesh pass. See MERGE_LIGHT_STEPS.
                let lm = if mode.night { quantize_light(lm) } else { lm };
                let (x0,x1f) = (wx as f32, wx as f32+1.0);
                let (y0,y1f) = (wy as f32, wy as f32+1.0);
                let (z0,z1f) = (wz as f32, wz as f32+1.0);
                // Eden (X east, Y south, Z up) → Three.js Y-up: (ex, ez, ey).
                // Eden north = Three.js −Z so the camera faces −Z (north) and east (+X) is on the right.
                let o = |ex:f32,ey:f32,ez:f32| -> (f32,f32,f32) { (ex,ez,ey) };

                if matches!(bt, 24..=39) {
                    let dir = (bt-24)%4;
                    let ss = obj_occludes(gbz(wx,wy+1,wz).0);
                    let sn = obj_occludes(gbz(wx,wy-1,wz).0);
                    let se = obj_occludes(gbz(wx+1,wy,wz).0);
                    let sw = obj_occludes(gbz(wx-1,wy,wz).0);
                    if !obj_occludes(gbz(wx,wy,wz-1).0) {
                        push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y0,z0),o(x0,y0,z0),rgb,SH_BOT,lm,bt,paint);
                    }
                    match dir {
                        0 => {
                            if !ss { push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_S,lm,bt,paint); }
                            if !sw { push_tri!([o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f)],rgb,SH_W,lm,bt,paint); }
                            if !se { push_tri!([o(x1f,y1f,z0),o(x1f,y0,z0),o(x1f,y1f,z1f)],rgb,SH_E,lm,bt,paint); }
                            push_quad!(o(x0,y0,z0),o(x1f,y0,z0),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_TOP,lm,bt,paint);
                        }
                        1 => {
                            if !sw { push_quad!(o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_W,lm,bt,paint); }
                            if !ss { push_tri!([o(x0,y1f,z0),o(x1f,y1f,z0),o(x0,y1f,z1f)],rgb,SH_S,lm,bt,paint); }
                            if !sn { push_tri!([o(x1f,y0,z0),o(x0,y0,z0),o(x0,y0,z1f)],rgb,SH_N,lm,bt,paint); }
                            push_quad!(o(x1f,y0,z0),o(x1f,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_TOP,lm,bt,paint);
                        }
                        2 => {
                            if !sn { push_quad!(o(x1f,y0,z0),o(x0,y0,z0),o(x0,y0,z1f),o(x1f,y0,z1f),rgb,SH_N,lm,bt,paint); }
                            if !se { push_tri!([o(x1f,y0,z0),o(x1f,y1f,z0),o(x1f,y0,z1f)],rgb,SH_E,lm,bt,paint); }
                            if !sw { push_tri!([o(x0,y1f,z0),o(x0,y0,z0),o(x0,y0,z1f)],rgb,SH_W,lm,bt,paint); }
                            push_quad!(o(x1f,y1f,z0),o(x0,y1f,z0),o(x0,y0,z1f),o(x1f,y0,z1f),rgb,SH_TOP,lm,bt,paint);
                        }
                        _ => {
                            if !se { push_quad!(o(x1f,y1f,z0),o(x1f,y0,z0),o(x1f,y0,z1f),o(x1f,y1f,z1f),rgb,SH_E,lm,bt,paint); }
                            if !sn { push_tri!([o(x1f,y0,z0),o(x0,y0,z0),o(x1f,y0,z1f)],rgb,SH_N,lm,bt,paint); }
                            if !ss { push_tri!([o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f)],rgb,SH_S,lm,bt,paint); }
                            push_quad!(o(x0,y1f,z0),o(x0,y0,z0),o(x1f,y0,z1f),o(x1f,y1f,z1f),rgb,SH_TOP,lm,bt,paint);
                        }
                    }
                } else if matches!(bt, 40..=55) {
                    // Wedges are vertical triangular prisms: full Z height, triangle footprint in XY.
                    // Each wedge occupies the diagonal half of the block named by its direction —
                    // SE fills the NE-SE-SW triangle (cuts off the NW corner), etc.
                    // Two rectangular faces at the named sides + one diagonal 45° rectangular face.
                    let dir = (bt-40)%4;
                    let ss = obj_occludes(gbz(wx,wy+1,wz).0);
                    let sn = obj_occludes(gbz(wx,wy-1,wz).0);
                    let se = obj_occludes(gbz(wx+1,wy,wz).0);
                    let sw = obj_occludes(gbz(wx-1,wy,wz).0);
                    let s_top = obj_occludes(gbz(wx,wy,wz+1).0);
                    let s_bot = obj_occludes(gbz(wx,wy,wz-1).0);
                    match dir {
                        0 => { // SE: triangle NE(x1f,y0)-SE(x1f,y1f)-SW(x0,y1f). Diagonal NE↔SW faces NW.
                            if !s_bot { push_tri!([o(x1f,y0,z0),o(x1f,y1f,z0),o(x0,y1f,z0)],rgb,SH_BOT,lm,bt,paint); }
                            if !s_top { push_tri!([o(x1f,y0,z1f),o(x0,y1f,z1f),o(x1f,y1f,z1f)],rgb,SH_TOP,lm,bt,paint); }
                            if !se { push_quad!(o(x1f,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x1f,y0,z1f),rgb,SH_E,lm,bt,paint); }
                            if !ss { push_quad!(o(x1f,y1f,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x1f,y1f,z1f),rgb,SH_S,lm,bt,paint); }
                            push_quad!(o(x1f,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x1f,y0,z1f),rgb,(SH_N+SH_W)*0.5,lm,bt,paint);
                        }
                        1 => { // SW: triangle NW(x0,y0)-SW(x0,y1f)-SE(x1f,y1f). Diagonal NW↔SE faces NE.
                            if !s_bot { push_tri!([o(x0,y0,z0),o(x0,y1f,z0),o(x1f,y1f,z0)],rgb,SH_BOT,lm,bt,paint); }
                            if !s_top { push_tri!([o(x0,y0,z1f),o(x1f,y1f,z1f),o(x0,y1f,z1f)],rgb,SH_TOP,lm,bt,paint); }
                            if !sw { push_quad!(o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_W,lm,bt,paint); }
                            if !ss { push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_S,lm,bt,paint); }
                            push_quad!(o(x0,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y0,z1f),rgb,(SH_N+SH_E)*0.5,lm,bt,paint);
                        }
                        2 => { // NW: triangle NE(x1f,y0)-NW(x0,y0)-SW(x0,y1f). Diagonal NE↔SW faces SE.
                            if !s_bot { push_tri!([o(x1f,y0,z0),o(x0,y0,z0),o(x0,y1f,z0)],rgb,SH_BOT,lm,bt,paint); }
                            if !s_top { push_tri!([o(x1f,y0,z1f),o(x0,y1f,z1f),o(x0,y0,z1f)],rgb,SH_TOP,lm,bt,paint); }
                            if !sn { push_quad!(o(x1f,y0,z0),o(x0,y0,z0),o(x0,y0,z1f),o(x1f,y0,z1f),rgb,SH_N,lm,bt,paint); }
                            if !sw { push_quad!(o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_W,lm,bt,paint); }
                            push_quad!(o(x1f,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x1f,y0,z1f),rgb,(SH_S+SH_E)*0.5,lm,bt,paint);
                        }
                        _ => { // NE: triangle NW(x0,y0)-NE(x1f,y0)-SE(x1f,y1f). Diagonal NW↔SE faces SW.
                            if !s_bot { push_tri!([o(x0,y0,z0),o(x1f,y0,z0),o(x1f,y1f,z0)],rgb,SH_BOT,lm,bt,paint); }
                            if !s_top { push_tri!([o(x0,y0,z1f),o(x1f,y1f,z1f),o(x1f,y0,z1f)],rgb,SH_TOP,lm,bt,paint); }
                            if !sn { push_quad!(o(x0,y0,z0),o(x1f,y0,z0),o(x1f,y0,z1f),o(x0,y0,z1f),rgb,SH_N,lm,bt,paint); }
                            if !se { push_quad!(o(x1f,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x1f,y0,z1f),rgb,SH_E,lm,bt,paint); }
                            push_quad!(o(x0,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y0,z1f),rgb,(SH_S+SH_W)*0.5,lm,bt,paint);
                        }
                    }
                } else {
                    // Cube with face culling. Non-fluids reuse the occludes-or-same-type rule; fluids
                    // get extra care so a mass of *mixed-level* water (e.g. Simulate Flow output) no
                    // longer emits stacked interior quads that z-fight through the translucent material:
                    //  • a lateral face against a same-base fluid is culled up to that neighbour's
                    //    surface height, leaving only the exposed step sliver (or nothing when covered);
                    //  • a cell with fluid directly above is "submerged" — it renders full height with
                    //    no top face, exactly like an interior block of a pool.
                    // Partial fluids (¾/½/¼, levels 3/2/1) that ARE the surface still sit at a level/4
                    // top (the wavy-water look, mirroring TerrainChunk.mm). Non-fluids: ztop == z1f,
                    // base_fluid None, so the branch collapses to plain occludes-or-same-type culling.
                    let base_fluid = fluid_base(bt);
                    let fl = fluid_level(bt);
                    let submerged = base_fluid.is_some_and(|bf| fluid_base(n_top) == Some(bf));
                    let ztop = if fl > 0 && fl < 4 && !submerged { z0 + fl as f32 / 4.0 } else { z1f };
                    // Block directly above each lateral neighbour — only fluids need it (to tell a
                    // submerged neighbour, which reaches full height, from a partial surface one).
                    let (nab_s, nab_n, nab_e, nab_w) = if base_fluid.is_some() {
                        (gbz(wx, wy + 1, wz + 1).0, gbz(wx, wy - 1, wz + 1).0,
                         gbz(wx + 1, wy, wz + 1).0, gbz(wx - 1, wy, wz + 1).0)
                    } else { (0, 0, 0, 0) };

                    // Surface height of a same-base fluid neighbour, in this cell's z units — how far up
                    // it occludes the shared face. A submerged neighbour (fluid above it) reaches z1f.
                    let neigh_surf = |ncell: u8, nabove: u8| -> f32 {
                        match fluid_level(ncell) {
                            0 => z0,
                            4 => z1f,
                            nfl => if fluid_base(nabove) == fluid_base(ncell) { z1f } else { z0 + nfl as f32 / 4.0 },
                        }
                    };
                    // (hidden?, face-bottom-z) for a lateral neighbour block `ncell` with `nabove` on top.
                    let lat = |ncell: u8, nabove: u8| -> (bool, f32) {
                        if obj_occludes(ncell) || ncell == bt { return (true, z0); }
                        if let Some(bf) = base_fluid {
                            if fluid_base(ncell) == Some(bf) {
                                let s = neigh_surf(ncell, nabove);
                                return (s >= ztop, s.min(ztop));
                            }
                        }
                        (false, z0)
                    };

                    // Greedy-merge bookkeeping. A face only defers to the merge pass when it covers its
                    // whole unit cell — i.e. it is a real 1×1 square that can tile with its neighbours.
                    // Partial-height fluid faces (a ¾/½/¼ surface, or a lateral sliver stepping down to
                    // a shallower neighbour) are not squares, so they emit immediately and unmerged,
                    // exactly as before. `key_lm` is the light the merge key compares — and, because
                    // the merge pass rebuilds the emitted colour from it, also the light the merged
                    // quad renders with. Two adjustments, both of which only ever make more faces
                    // compare equal:
                    //   • flat (GPU-shadow) mode: `lit_rgb!` discards `lm` entirely, so folding the
                    //     key to a constant lets a GPU-shadow render merge across lamp light it was
                    //     never going to bake.
                    //   • otherwise: clamp to this direction's saturation cap, which is exactly
                    //     lossless (see `merge_light_cap`) — `lm` above `1/sh` renders identically.
                    // The other half of the night-mode merge story, snapping `lm` to the
                    // `MERGE_LIGHT_STEPS` grid, happens once per voxel where `lm` is computed, so
                    // that unmerged faces (ramps, wedges, partial fluids) can't seam against merged
                    // neighbours. See `MERGE_LIGHT_STEPS`.
                    let full_top = ztop == z1f;
                    let mut defer = |dir: u8, slice: i32, u: i32, v: i32| {
                        let key_lm = if flat { [1.0f32, 1.0, 1.0] } else {
                            let cap = light_cap[dir as usize];
                            [lm[0].min(cap), lm[1].min(cap), lm[2].min(cap)]
                        };
                        let key_lm = [key_lm[0].to_bits(), key_lm[1].to_bits(), key_lm[2].to_bits()];
                        faces.push(FaceRec { dir, slice, bt, paint, lm: key_lm, v, u });
                    };

                    let top_hidden = obj_occludes(n_top) || n_top == bt
                        || base_fluid.is_some_and(|bf| fluid_base(n_top) == Some(bf));
                    if !top_hidden {
                        if full_top { defer(0, wz, wx, wy); }
                        else { push_quad!(o(x0,y0,ztop),o(x1f,y0,ztop),o(x1f,y1f,ztop),o(x0,y1f,ztop),rgb,SH_TOP,lm,bt,paint); }
                    }
                    let bot_hidden = obj_occludes(n_bot) || n_bot == bt
                        || base_fluid.is_some_and(|bf| fluid_base(n_bot) == Some(bf));
                    if !bot_hidden {
                        // The bottom face always sits at z0 and always spans the full cell.
                        defer(1, wz, wx, wy);
                    }
                    // A lateral face spans [zb, ztop]; it fills its cell only when that is the whole
                    // block. `zb != z0` means a fluid neighbour occluded the lower part of it.
                    let (h_s, zb_s) = lat(n_s, nab_s);
                    if !h_s {
                        if full_top && zb_s == z0 { defer(2, wy, wx, wz); }
                        else { push_quad!(o(x0,y1f,zb_s),o(x1f,y1f,zb_s),o(x1f,y1f,ztop),o(x0,y1f,ztop),rgb,SH_S,lm,bt,paint); }
                    }
                    let (h_n, zb_n) = lat(n_n, nab_n);
                    if !h_n {
                        if full_top && zb_n == z0 { defer(3, wy, wx, wz); }
                        else { push_quad!(o(x1f,y0,zb_n),o(x0,y0,zb_n),o(x0,y0,ztop),o(x1f,y0,ztop),rgb,SH_N,lm,bt,paint); }
                    }
                    let (h_e, zb_e) = lat(n_e, nab_e);
                    if !h_e {
                        if full_top && zb_e == z0 { defer(4, wx, wy, wz); }
                        else { push_quad!(o(x1f,y1f,zb_e),o(x1f,y0,zb_e),o(x1f,y0,ztop),o(x1f,y1f,ztop),rgb,SH_E,lm,bt,paint); }
                    }
                    let (h_w, zb_w) = lat(n_w, nab_w);
                    if !h_w {
                        if full_top && zb_w == z0 { defer(5, wx, wy, wz); }
                        else { push_quad!(o(x0,y0,zb_w),o(x0,y1f,zb_w),o(x0,y1f,ztop),o(x0,y0,ztop),rgb,SH_W,lm,bt,paint); }
                    }
                }
            }
        }
    }

    // ---- Greedy mesh pass ---------------------------------------------------------------------
    // Sorting collects the deferred faces into contiguous runs of "same direction, same plane, same
    // block, same light" — everything that may legally fuse — with each run already ordered (v, u),
    // which is the row-major scan order the rectangle sweep wants. It is also what makes the output
    // deterministic, which several tests lean on (a z-clipped render must be byte-identical to a
    // render of the equivalently truncated world).
    faces.sort_unstable();
    // Capacity hint (audit I-1): every deferred face becomes at most one quad (6 verts, merging only
    // ever reduces that count), so reserving for the fully-unmerged case up front avoids the opaque
    // stream's doubling reallocs on any chunk with real terrain — the common case merging shrinks.
    if !faces.is_empty() {
        let max_verts = faces.len() * 6;
        pos_f.reserve(max_verts * 12);
        col_f.reserve(max_verts * 12);
        if pack.is_some() { uv_f.reserve(max_verts * 8); }
    }
    // The second in-plane axis may only grow when no texture pack is loaded: U tiles by repeating a
    // one-tile-wide atlas, but V *selects the row*, so growing it would run into the next block's
    // texture. See `push_quad_uv!`. Untextured (the default) gets the full 2D merge.
    let grow_v = pack.is_none();
    // Eden (X east, Y south, Z up) → Three.js Y-up, same mapping the voxel pass uses.
    let o = |ex: f32, ey: f32, ez: f32| -> (f32, f32, f32) { (ex, ez, ey) };
    // Reused across groups so a world of single-face groups (every block differently lit, e.g. sun
    // shadows on) doesn't pay an allocation per group.
    let mut idx: FxHashMap<(i32, i32), usize> = FxHashMap::default();
    let mut used: Vec<bool> = Vec::new();
    let mut gi = 0usize;
    while gi < faces.len() {
        let head = faces[gi];
        let mut gj = gi + 1;
        while gj < faces.len()
            && faces[gj].dir == head.dir && faces[gj].slice == head.slice
            && faces[gj].bt == head.bt && faces[gj].paint == head.paint && faces[gj].lm == head.lm
        { gj += 1; }
        let group = &faces[gi..gj];
        gi = gj;

        let rgb = block_color(head.bt, head.paint, meta.sky);
        let lm = [f32::from_bits(head.lm[0]), f32::from_bits(head.lm[1]), f32::from_bits(head.lm[2])];

        idx.clear();
        used.clear();
        used.resize(group.len(), false);
        if group.len() > 1 {
            idx.extend(group.iter().enumerate().map(|(k, f)| ((f.v, f.u), k)));
        }

        for k in 0..group.len() {
            if used[k] { continue; }
            let (u0, v0) = (group[k].u, group[k].v);
            let mut w = 1i32;
            let mut h = 1i32;
            if group.len() > 1 {
                // Widen along u through unconsumed cells, then grow the whole run along v while every
                // cell of the next row is present and unconsumed. Scanning in (v, u) order guarantees
                // `k` is the rectangle's origin corner, so this covers the group exactly once.
                let free = |uu: i32, vv: i32| idx.get(&(vv, uu)).is_some_and(|&m| !used[m]);
                while free(u0 + w, v0) { w += 1; }
                if grow_v {
                    while (0..w).all(|du| free(u0 + du, v0 + h)) { h += 1; }
                }
                for dv in 0..h {
                    for du in 0..w {
                        if let Some(&m) = idx.get(&(v0 + dv, u0 + du)) { used[m] = true; }
                    }
                }
            } else {
                used[k] = true;
            }

            // Rebuild the world-space rectangle from (slice, u, v, w, h) — see the table on `FaceRec`.
            let (f0, f1) = (u0 as f32, (u0 + w) as f32);
            let (g0, g1) = (v0 as f32, (v0 + h) as f32);
            let s0 = head.slice as f32;
            let s1 = s0 + 1.0;
            let (bt, paint) = (head.bt, head.paint);
            let nu = w as f32;
            match head.dir {
                0 => push_quad_t!(o(f0,g0,s1),o(f1,g0,s1),o(f1,g1,s1),o(f0,g1,s1),rgb,SH_TOP,lm,bt,paint,nu),
                1 => push_quad_t!(o(f0,g1,s0),o(f1,g1,s0),o(f1,g0,s0),o(f0,g0,s0),rgb,SH_BOT,lm,bt,paint,nu),
                2 => push_quad_t!(o(f0,s1,g0),o(f1,s1,g0),o(f1,s1,g1),o(f0,s1,g1),rgb,SH_S,lm,bt,paint,nu),
                3 => push_quad_t!(o(f1,s0,g0),o(f0,s0,g0),o(f0,s0,g1),o(f1,s0,g1),rgb,SH_N,lm,bt,paint,nu),
                4 => push_quad_t!(o(s1,f1,g0),o(s1,f0,g0),o(s1,f0,g1),o(s1,f1,g1),rgb,SH_E,lm,bt,paint,nu),
                _ => push_quad_t!(o(s0,f0,g0),o(s0,f1,g0),o(s0,f1,g1),o(s0,f0,g1),rgb,SH_W,lm,bt,paint,nu),
            }
        }
    }

    // Already LE-byte buffers (audit I-1) — one vertex is 3 floats = 12 bytes, no conversion pass.
    let vertex_count = (pos_f.len() / 12) as u32;
    let (positions, colors, uvs) = (pos_f, col_f, uv_f);

    let vertex_count_t = (pos_ft.len() / 12) as u32;
    let (positions_t, colors_t, uvs_t) = (pos_ft, col_ft, uv_ft);

    let vertex_count_e = (pos_ef.len() / 12) as u32;
    let (positions_e, colors_e, uvs_e) = (pos_ef, col_ef, uv_ef);

    ObjGeometryResult {
        positions, colors, uvs, vertex_count,
        positions_t, colors_t, uvs_t, vertex_count_t,
        positions_e, colors_e, uvs_e, vertex_count_e,
    }
}

/// Face-culled geometry for a single chunk (16×16 XY × a z band). For the 3D fly-through pane, which
/// streams meshes per chunk near the camera.
///
/// `z_min`/`z_max` (Stage 3 of the 3D-pane crash fix) clip the emitted band; omitted = the full
/// `0..=world_max_z` column, i.e. the pre-Stage-3 behaviour. The frontend sends a camera-relative
/// band so a 256z world doesn't cost 4× a 64z one per chunk; the **cutaway cap is applied here**,
/// not by the caller — `view_cap_z` is backend state (see `set_view_cap`), so composing it server-
/// side keeps the one source of truth. Both only ever *narrow* the range, so they compose by `min`.
/// The frontend still has to invalidate its chunk cache when the cap changes (it does — `viewCapZ`
/// is a `reloadAllChunks()` trigger in FlyView3D), which is why the band itself stays an explicit
/// parameter rather than being derived here too.
///
/// The app keeps only the lock/state/instrumentation shell around this: it resolves the world, the
/// texture pack, the cutaway cap and the lamp gather (see [`crate::lamps`]) and hands them in.
#[allow(clippy::too_many_arguments)]
pub fn chunk_geometry(
    world: &impl VoxelView,
    meta: ViewMeta,
    pack: Option<&TexturePack>,
    lamps: &[([i32; 3], [f32; 3])],
    cx: i32, cy: i32,
    mode: LightMode,
    z_min: Option<i32>, z_max: Option<i32>,
    cap: Option<i32>,
) -> ObjGeometryResult {
    // Defensive: only serve chunks inside the world's chunk grid. Out-of-range indices already scan
    // to all-air (empty geometry), but bailing early avoids the wasted 16×16×Z probe and documents
    // the frontend contract (local 0-based chunk indices).
    if cx < 0 || cy < 0 || cx as u32 >= meta.w_chunks || cy as u32 >= meta.h_chunks {
        return ObjGeometryResult::empty();
    }
    // Early-out on an unpopulated chunk. Eden only saves edited chunks, so on sparse worlds most
    // chunks streamed by the fly-through pane's radius sweep are entirely unwritten — without this
    // check they'd still pay the full 16×16×maxZ scan (~460K get_block_at lookups) just to discover
    // every voxel is air. This is the single biggest win available for fly-mode hitching on sparse
    // worlds; it does not affect worlds with contiguous chunk coverage (a hit on the first try).
    let (min_x, min_y) = world.chunk_origin();
    if world.chunk_bytes(cx + min_x, cy + min_y).is_none() {
        return ObjGeometryResult::empty();
    }
    let sx1 = cx * 16;
    let sy1 = cy * 16;
    let (sz1, sz2) = emitted_band(world, z_min, z_max, cap);
    // Fly-through streaming stays unmasked.
    obj_geometry_region(world, meta, pack, sx1, sy1, sx1 + 15, sy1 + 15, sz1, sz2, lamps, mode, None)
}

/// The z band [`chunk_geometry`] will emit: the caller's camera band ∩ the cutaway `cap` ∩ the
/// world's real z range.
///
/// Clamped (not rejected) so a nonsensical band degrades to a smaller render, never an error
/// mid-stream; an inverted or fully out-of-range band collapses to `sz1 > sz2`, and the emission
/// loop then emits nothing — the same empty result an all-air chunk gives. Public so an app's
/// instrumentation can report the band that was actually rendered rather than the one requested.
pub fn emitted_band(
    world: &impl VoxelView, z_min: Option<i32>, z_max: Option<i32>, cap: Option<i32>,
) -> (i32, i32) {
    let max_z = world_max_z(world);
    let cap = cap.unwrap_or(max_z);
    (
        z_min.unwrap_or(0).clamp(0, max_z),
        z_max.unwrap_or(max_z).min(cap).clamp(0, max_z),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testworld::TestWorld;

    /// Minimal single-chunk 64z world — the same 32 768-byte, 4-band shape both apps' tests use.
    fn make_test_world() -> TestWorld {
        TestWorld::new(1, 1, 4)
    }

    /// Byte index of block `(lx, ly, z)`'s *type* in `make_test_world`'s single chunk; `+ 4096` for
    /// its paint byte.
    fn block(lx: usize, ly: usize, z: i32) -> usize {
        (z / 16) as usize * 8192 + lx * 256 + ly * 16 + (z % 16) as usize
    }

    /// Old-style voxel scan for lamps within `radius` of a region — the pre-index reference the
    /// production path used to run inline. Kept in the test module both to build the lamp slice
    /// `obj_geometry_region` now expects and as the parity baseline for the index-based gather
    /// (`crate::lamps::lamps_in_region`).
    fn scan_lamps(world: &TestWorld, sx1: i32, sy1: i32, sx2: i32, sy2: i32, sz1: i32, sz2: i32, radius: f32) -> Vec<([i32; 3], [f32; 3])> {
        let cache = ChunkCache::new(world);
        let r = radius.ceil() as i32;
        let mut found = Vec::new();
        for wz in (sz1 - r).max(0)..=(sz2 + r) {
            for wy in (sy1 - r)..=(sy2 + r) {
                for wx in (sx1 - r)..=(sx2 + r) {
                    let (bt, paint) = cache.get(wx, wy, wz);
                    if bt == LAMP_BLOCK_TYPE {
                        let rgb = block_color(bt, paint, world.sky);
                        found.push(([wx, wy, wz], [rgb[0] as f32 / 255.0, rgb[1] as f32 / 255.0, rgb[2] as f32 / 255.0]));
                    }
                }
            }
        }
        found
    }

    /// A block's side-face color (any face other than top/bottom) under a given `LightMode`,
    /// found by matching the shading multiplier used for side faces (SH_S etc, all < 1.0 and != SH_BOT).
    fn side_face_color(world: &TestWorld, x: i32, y: i32, z: i32, z2: i32, mode: LightMode) -> [f32; 3] {
        let radius = if mode.lamp_radius > 0.0 { mode.lamp_radius } else { mode.profile.default_radius() };
        let lamps = if mode.night { scan_lamps(world, x, y, x, y, z, z2, radius) } else { Vec::new() };
        let g = obj_geometry_region(world, world.meta(), None, x, y, x, y, z, z2, &lamps, mode, None);
        let floats: Vec<f32> = g.colors.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        // Plain-cube push order (see the `else` branch in obj_geometry_region): top, bottom, south,
        // north, east, west quads, 6 vertices × 3 floats each. South is the 3rd quad (index 2).
        let quad_floats = 6 * 3;
        let south_start = 2 * quad_floats;
        [floats[south_start], floats[south_start + 1], floats[south_start + 2]]
    }

    #[test]
    fn night_lighting_dims_and_lamps_dont_darken_faster_than_ambient() {
        let mut world = make_test_world();
        // Probe stone column at (3,5,0..1); lamp block directly above at z=3 (distance 3 < radius 5).
        world.bytes[block(3, 5, 0)] = 2; // Stone
        world.bytes[block(3, 5, 3)] = LAMP_BLOCK_TYPE;

        let day = side_face_color(&world, 3, 5, 0, 0, LightMode::default());
        let night = side_face_color(&world, 3, 5, 0, 0, LightMode { night: true, shadows: false, sun_t: 0.0, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy });

        for c in 0..3 {
            assert!(night[c] < day[c], "night lighting should dim an unlit block relative to full daylight");
            assert!(night[c] > 0.0, "ambient + lamp contribution should keep the block above pure black");
        }
    }

    #[test]
    fn lamp_light_is_tinted_by_the_lamp_paint_not_a_separate_colour_table() {
        let mut world = make_test_world();
        let paint = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz + 4096
        };
        world.bytes[block(3, 5, 0)] = 2; // Stone probe
        world.bytes[block(3, 5, 3)] = LAMP_BLOCK_TYPE;
        world.bytes[paint(3, 5, 3)] = 1; // PAINT_RGB[1] = [255,170,170] — red-dominant

        let night = side_face_color(&world, 3, 5, 0, 0, LightMode { night: true, shadows: false, sun_t: 0.0, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy });

        // A red-dominant lamp should tint the probe's lit colour red-dominant too: the red channel
        // should gain more (relative to its unlit value) than green/blue. Checked via the raw ratio
        // rather than absolute values since face shading differs per channel only through `lm`.
        assert!(night[0] > night[1] && night[0] > night[2],
            "red-painted lamp should cast red-dominant light, got {night:?}");
    }

    #[test]
    fn flat_mode_routes_lamp_faces_to_the_emissive_stream() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 0)] = LAMP_BLOCK_TYPE; // isolated lamp in air → all 6 faces emit

        // Non-flat (baked default): lamp faces stay in the opaque stream; the emissive stream is
        // untouched, matching a plain flat fully-lit render (`LightMode::default()`).
        let baked = obj_geometry_region(&world, world.meta(), None, 3, 5, 3, 5, 0, 0, &[], LightMode::default(), None);
        assert_eq!(baked.vertex_count_e, 0, "default (non-flat) mode must not populate the emissive stream");
        assert!(baked.vertex_count > 0, "lamp faces belong to the opaque stream in non-flat mode");
        assert_eq!(baked.vertex_count_t, 0, "a lamp is opaque — nothing in the transparent stream");

        // Flat (GPU) mode: the same lamp faces move to the emissive stream; the opaque stream is empty.
        let flat = obj_geometry_region(&world, world.meta(), None, 3, 5, 3, 5, 0, 0, &[], LightMode { flat: true, ..Default::default() }, None);
        assert!(flat.vertex_count_e > 0, "flat mode must route lamp faces into the emissive stream");
        assert_eq!(flat.vertex_count, 0, "no non-lamp opaque faces expected for an isolated lamp");
        assert_eq!(flat.vertex_count_e, baked.vertex_count, "same lamp geometry, just a different stream");
    }

    /// Shaped-selection 3D preview: an unmasked column reads as air through the single block-getter,
    /// so it contributes no geometry, and the masked neighbour's face toward the hole now emits
    /// (the hole is treated as air for occlusion too). `None` renders the full box.
    #[test]
    fn test_obj_geometry_respects_mask() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 0)] = 2; // stone
        world.bytes[block(4, 5, 0)] = 2; // stone (adjacent in +x)

        // Full box (no mask): both cubes present; the shared face between them is culled.
        let full = obj_geometry_region(&world, world.meta(), None, 3, 5, 4, 5, 0, 0, &[], LightMode::default(), None);

        // Mask over bbox (3,5)-(4,5), only column (3,5) set.
        let mask = SelectionMask { x1: 3, y1: 5, x2: 4, y2: 5, bits: vec![0b01] };
        let masked = obj_geometry_region(&world, world.meta(), None, 3, 5, 4, 5, 0, 0, &[], LightMode::default(), Some(&mask));

        assert!(masked.vertex_count > 0, "masked cell still emits geometry");
        // NB: vertex *counts* can't tell these apart any more — greedy meshing fuses the two cubes'
        // coplanar faces, so the 2×1 slab and the lone cube both come out as six quads. Compare the
        // geometry itself: the masked render must not reach past the surviving column at x=4.
        assert_ne!(masked.positions, full.positions, "the unmasked cube is gone");
        let max_x = masked.positions.chunks_exact(4).step_by(3)
            .map(|v| f32::from_le_bytes([v[0], v[1], v[2], v[3]]))
            .fold(f32::NEG_INFINITY, f32::max);
        assert_eq!(max_x, 4.0, "no vertex from the masked-out cube (which would reach x=5)");

        // Masking the neighbour exposes the +x face that was culled while it was solid: the surviving
        // cube renders exactly like a genuinely isolated one. Build that reference from a world whose
        // only solid block is (3,5,0), so its +x neighbour really is air.
        let mut lone_world = make_test_world();
        lone_world.bytes[block(3, 5, 0)] = 2;
        let isolated = obj_geometry_region(&lone_world, lone_world.meta(), None, 3, 5, 3, 5, 0, 0, &[], LightMode::default(), None);
        assert_eq!(masked.vertex_count, isolated.vertex_count, "hole-facing side face emits (full cube)");
        assert_eq!(masked.positions, isolated.positions, "and is byte-identical to a genuinely lone cube");
    }

    /// Stage 3 (fly-view camera z band / cutaway phase 2): a z-clipped render must behave as if the
    /// world *ended* at the cut planes. The trap this pins is the see-through roof — face culling
    /// reads the real world through `gb`, so the block just above `sz2` would otherwise occlude the
    /// top face of the topmost emitted block, leaving a hole you can look straight through into the
    /// interior. Same in reverse at `sz1` for the floor.
    ///
    /// Reference: the identical column rendered *unclipped* in a world where the out-of-band blocks
    /// genuinely don't exist. Byte-identical output is the invariant — a clipped render is exactly a
    /// render of the truncated world.
    #[test]
    fn test_obj_geometry_z_clip_emits_cap_faces() {
        // Tall column z=0..=5 at (3,5), rendered clipped to the middle slab z=2..=4.
        let mut tall = make_test_world();
        for z in 0..=5 { tall.bytes[block(3, 5, z)] = 2; }
        let clipped = obj_geometry_region(&tall, tall.meta(), None, 3, 5, 3, 5, 2, 4, &[], LightMode::default(), None);

        // Same three blocks, but z=1 and z=5 really are air — rendered over the whole world column so
        // no clipping is in play at all.
        let mut short = make_test_world();
        for z in 2..=4 { short.bytes[block(3, 5, z)] = 2; }
        let reference = obj_geometry_region(&short, short.meta(), None, 3, 5, 3, 5, 0, world_max_z(&short), &[], LightMode::default(), None);

        // 4 side faces (each greedy-merged into one 3-tall quad down the column) + the two cap faces
        // = 6 quads = 36 verts. Spelled out so a regression that silently drops the caps (24) or
        // double-emits fails loudly, not just "differs".
        assert_eq!(clipped.vertex_count, 6 * 6, "clipped slab emits 4 merged sides plus both cap faces");
        assert_eq!(clipped.vertex_count, reference.vertex_count);
        assert_eq!(clipped.positions, reference.positions, "a clipped render == a render of the truncated world");
        assert_eq!(clipped.colors, reference.colors);

        // Nothing escapes the band. THREE coords are (ex, ez, ey), so index 1 is Eden z; a block at
        // z spans [z, z+1].
        for v in clipped.positions.chunks_exact(4).skip(1).step_by(3) {
            let y = f32::from_le_bytes([v[0], v[1], v[2], v[3]]);
            assert!((2.0..=5.0).contains(&y), "vertex at z={y} outside the clipped band 2..=4");
        }
    }

    /// Degenerate bands emit nothing rather than erroring or wrapping: a band entirely above the
    /// terrain, and an inverted one (which `get_chunk_geometry`'s clamp can produce when the cutaway
    /// cap sits below the camera band). `for wz in sz1..=sz2` is empty when sz1 > sz2.
    #[test]
    fn test_obj_geometry_z_clip_degenerate_bands() {
        let mut world = make_test_world();
        for z in 0..=5 { world.bytes[block(3, 5, z)] = 2; }

        let above = obj_geometry_region(&world, world.meta(), None, 3, 5, 3, 5, 40, 48, &[], LightMode::default(), None);
        assert_eq!(above.vertex_count, 0, "band above the terrain emits nothing");
        let inverted = obj_geometry_region(&world, world.meta(), None, 3, 5, 3, 5, 4, 2, &[], LightMode::default(), None);
        assert_eq!(inverted.vertex_count, 0, "inverted band emits nothing");
    }

    // ---- Greedy meshing (Stage 5 of the 3D-pane crash fix) --------------------------------------


    /// The emitted opaque quads as `[(three_x, three_y, three_z); 6]` vertex tuples. Positions are
    /// non-indexed, 6 verts per quad, so the stream chunks exactly.
    fn quads(res: &ObjGeometryResult) -> Vec<[(f32, f32, f32); 6]> {
        let f: Vec<f32> = res.positions.chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        f.chunks_exact(18).map(|q| {
            let v = |i: usize| (q[i * 3], q[i * 3 + 1], q[i * 3 + 2]);
            [v(0), v(1), v(2), v(3), v(4), v(5)]
        }).collect()
    }

    /// As `quads`, but over the transparent stream (water/glass/fence/flower).
    fn quads_t(res: &ObjGeometryResult) -> Vec<[(f32, f32, f32); 6]> {
        let f: Vec<f32> = res.positions_t.chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        f.chunks_exact(18).map(|q| {
            let v = |i: usize| (q[i * 3], q[i * 3 + 1], q[i * 3 + 2]);
            [v(0), v(1), v(2), v(3), v(4), v(5)]
        }).collect()
    }

    /// Quads lying entirely in the horizontal plane `three_y == y` — i.e. the top faces of blocks at
    /// `z = y - 1` (bottom faces of the same blocks sit at `three_y == z`).
    fn quads_in_plane_y(res: &ObjGeometryResult, y: f32) -> Vec<[(f32, f32, f32); 6]> {
        quads(res).into_iter().filter(|q| q.iter().all(|v| v.1 == y)).collect()
    }

    /// The unit cells a set of horizontal quads covers, as `(x, eden_y)` integer pairs — panics on any
    /// cell covered twice, which is what makes "the merge tiles the footprint exactly" checkable.
    fn covered_cells(qs: &[[(f32, f32, f32); 6]]) -> HashSet<(i32, i32)> {
        let mut cells = HashSet::new();
        for q in qs {
            // THREE (ex, ez, ey): index 0 is Eden x, index 2 is Eden y.
            let x0 = q.iter().map(|v| v.0).fold(f32::INFINITY, f32::min) as i32;
            let x1 = q.iter().map(|v| v.0).fold(f32::NEG_INFINITY, f32::max) as i32;
            let y0 = q.iter().map(|v| v.2).fold(f32::INFINITY, f32::min) as i32;
            let y1 = q.iter().map(|v| v.2).fold(f32::NEG_INFINITY, f32::max) as i32;
            for x in x0..x1 {
                for y in y0..y1 {
                    assert!(cells.insert((x, y)), "cell ({x},{y}) covered by two merged quads");
                }
            }
        }
        cells
    }

    /// The headline win: a flat slab's whole exposed surface collapses to one quad per face
    /// direction, independent of how many blocks it is made of. 4×4×1 stone = 16 top + 16 bottom +
    /// 16 side faces unmerged (48 quads); merged it is 6.
    #[test]
    fn test_greedy_merge_flat_slab_collapses_to_one_quad_per_face() {
        let mut world = make_test_world();
        for x in 3..=6 { for y in 5..=8 { world.bytes[block(x, y, 0)] = 2; } }
        let g = obj_geometry_region(&world, world.meta(), None, 3, 5, 6, 8, 0, 0, &[], LightMode::default(), None);
        assert_eq!(g.vertex_count, 6 * 6, "top + bottom + four merged sides");

        // The single top quad really spans the whole 4×4 footprint, rather than six quads happening
        // to add up to the right count.
        let top = quads_in_plane_y(&g, 1.0);
        assert_eq!(top.len(), 1);
        assert_eq!(covered_cells(&top).len(), 16);
        assert_eq!(top[0].iter().map(|v| v.0).fold(f32::NEG_INFINITY, f32::max), 7.0, "x spans 3..7");
        assert_eq!(top[0].iter().map(|v| v.2).fold(f32::NEG_INFINITY, f32::max), 9.0, "eden y spans 5..9");
    }

    /// A non-rectangular footprint must be tiled *exactly* — every cell covered once, none twice, and
    /// nothing outside the shape. This is the property that makes the merge safe in general; the
    /// quad count is incidental (an L is two maximal rectangles).
    #[test]
    fn test_greedy_merge_tiles_an_l_shape_exactly() {
        let mut world = make_test_world();
        let shape = [(3, 5), (4, 5), (5, 5), (3, 6), (3, 7)];
        for &(x, y) in &shape { world.bytes[block(x, y, 0)] = 2; }
        let g = obj_geometry_region(&world, world.meta(), None, 3, 5, 5, 7, 0, 0, &[], LightMode::default(), None);

        let top = quads_in_plane_y(&g, 1.0);
        let cells = covered_cells(&top);
        let want: HashSet<(i32, i32)> = shape.iter().map(|&(x, y)| (x as i32, y as i32)).collect();
        assert_eq!(cells, want, "merged top faces cover the L and nothing else");
        assert_eq!(top.len(), 2, "an L is two maximal rectangles");
    }

    /// Faces only fuse when they render identically. A checkerboard of two block types shares no
    /// edge between same-typed cells, so nothing merges — the guard against a merge keyed on
    /// position alone, which would smear one material over its neighbour.
    #[test]
    fn test_greedy_merge_splits_on_block_type() {
        let mut world = make_test_world();
        for x in 3..=6 { for y in 5..=8 {
            world.bytes[block(x, y, 0)] = if (x + y) % 2 == 0 { 2 } else { 3 }; // stone / dirt
        } }
        let g = obj_geometry_region(&world, world.meta(), None, 3, 5, 6, 8, 0, 0, &[], LightMode::default(), None);
        let top = quads_in_plane_y(&g, 1.0);
        assert_eq!(top.len(), 16, "no two same-type cells are edge-adjacent, so no top face merges");
        assert_eq!(covered_cells(&top).len(), 16);
    }

    /// …and only when they are lit identically — where "identically" means *after* the light has been
    /// snapped onto the `MERGE_LIGHT_STEPS` grid (Phase 5.3). Four stone cells in a row under one
    /// lamp: the two nearest it differ by less than one light step and therefore fuse, while the two
    /// further out each fall a step and stay separate, so lamp falloff is still visible as distinct
    /// quads rather than flattened into one average.
    #[test]
    fn test_greedy_merge_splits_on_per_block_light() {
        let mut world = make_test_world();
        for x in 3..=6 { world.bytes[block(x, 5, 0)] = 2; }
        world.bytes[block(3, 5, 3)] = LAMP_BLOCK_TYPE;

        let day = obj_geometry_region(&world, world.meta(), None, 3, 5, 6, 5, 0, 0, &[], LightMode::default(), None);
        assert_eq!(quads_in_plane_y(&day, 1.0).len(), 1, "unlit: identical colour, one merged quad");

        let night_mode = LightMode { night: true, shadows: false, sun_t: 0.0, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy };
        let lamps = scan_lamps(&world, 3, 5, 6, 5, 0, 0, night_mode.profile.default_radius());
        let night = obj_geometry_region(&world, world.meta(), None, 3, 5, 6, 5, 0, 0, &lamps, night_mode, None);
        let top = quads_in_plane_y(&night, 1.0);
        assert_eq!(covered_cells(&top).len(), 4, "the four top faces are still tiled exactly once each");
        assert_eq!(top.len(), 3, "sub-step light difference fuses x=3..5; x=5 and x=6 each step down");

        // Specifically: the fused quad is the two cells nearest the lamp, not some other pairing.
        let spans: Vec<(i32, i32)> = top.iter().map(|q| {
            let x0 = q.iter().map(|v| v.0).fold(f32::INFINITY, f32::min) as i32;
            let x1 = q.iter().map(|v| v.0).fold(f32::NEG_INFINITY, f32::max) as i32;
            (x0, x1)
        }).collect();
        assert!(spans.contains(&(3, 5)), "the two cells nearest the lamp merge into one 2-wide quad: {spans:?}");
    }

    /// `merge_light_cap` is the *lossless* half of the Phase 5.3 merge-key work: past `1/sh` a face is
    /// already fully bright, so clamping the key there cannot change a single emitted colour bit. This
    /// sweeps the whole night light range (`light_at` clamps at 1.5) against every face shade.
    #[test]
    fn test_merge_light_cap_is_lossless() {
        for sh in [1.00f32, 0.60, 0.847, 0.447, 0.549, 0.749] {
            let cap = merge_light_cap(sh);
            assert!(sh * cap >= 1.0, "cap must actually saturate: sh={sh} cap={cap} -> {}", sh * cap);
            for i in 0..=15_000 {
                let lm = i as f32 / 10_000.0;
                let before = (sh * lm).min(1.0);
                let after = (sh * lm.min(cap)).min(1.0);
                assert_eq!(before.to_bits(), after.to_bits(), "sh={sh} lm={lm}: {before} != {after}");
            }
        }
    }

    /// …and it earns its keep: two cells whose raw light differs by *more* than a quantization step
    /// still merge on their top faces, because both are past the top face's saturation point and
    /// render the same white. Their south faces (a dimmer shade, so a higher saturation point) are
    /// below it and stay two quads — which is what shows the top-face merge came from the cap rather
    /// than from the light being equal.
    #[test]
    fn test_greedy_merge_fuses_saturated_faces_only() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 0)] = 2;
        world.bytes[block(4, 5, 0)] = 2;
        // Two white-painted lamps placed asymmetrically over the pair, bright enough that both cells
        // saturate a top face (light > 1.0) while still differing well past one MERGE_LIGHT_STEPS step.
        for x in [3usize, 5] {
            world.bytes[block(x, 5, 2)] = LAMP_BLOCK_TYPE;
            world.bytes[block(x, 5, 2) + 4096] = 9; // PAINT_RGB[9] = white → equal light in all channels
        }

        let mode = LightMode { night: true, shadows: false, sun_t: 0.0, flat: false, lamp_radius: 6.0, profile: LightingProfile::Modern };
        let lamps = scan_lamps(&world, 3, 5, 4, 5, 0, 0, mode.lamp_radius);
        let g = obj_geometry_region(&world, world.meta(), None, 3, 5, 4, 5, 0, 0, &lamps, mode, None);

        let top = quads_in_plane_y(&g, 1.0);
        assert_eq!(top.len(), 1, "both top faces render fully bright → one merged quad");
        assert_eq!(covered_cells(&top).len(), 2);

        // South (+Y) faces lie in the Eden-y = 6 plane → THREE z == 6.
        let south: Vec<_> = quads(&g).into_iter().filter(|q| q.iter().all(|v| v.2 == 6.0)).collect();
        assert_eq!(south.len(), 2, "the dimmer south shade is not saturated → the two cells stay apart");
    }

    /// Texture packs constrain the merge to one axis. The atlas is a vertical strip of per-block rows,
    /// so U can tile (it repeats the same one-tile-wide column) but V *selects the row* — growing V
    /// would run a merged quad into the next block's texture. A 3×3 wall therefore merges into three
    /// 3-wide rows with a pack loaded, and into a single quad without one, and every emitted V stays
    /// inside one atlas row either way.
    #[test]
    fn test_greedy_merge_with_texture_pack_tiles_u_only() {
        let mut world = make_test_world();
        for x in 3..=5 { for z in 0..=2 { world.bytes[block(x, 5, z)] = 2; } }

        let pack = TexturePack {
            tile: 1,
            atlas_rgba: vec![255u8; 3 * 4], // tile 1×1 RGBA × 3 rows; only `atlas_rows` is read here
            atlas_rows: 3, // row 0 sentinel + 1 colour row + 1 grayscale row
            gray_row_offset: 1,
            name_to_row: [("stone".to_string(), 1u32)].into_iter().collect(),
        };

        // South (+Y) faces lie in the Eden-y = 6 plane → THREE z == 6.
        let south = |res: &ObjGeometryResult| -> Vec<[(f32, f32, f32); 6]> {
            quads(res).into_iter().filter(|q| q.iter().all(|v| v.2 == 6.0)).collect()
        };

        let bare = obj_geometry_region(&world, world.meta(), None, 3, 5, 5, 5, 0, 2, &[], LightMode::default(), None);
        assert_eq!(south(&bare).len(), 1, "untextured: the 3×3 wall face is one quad");

        let textured = obj_geometry_region(&world, world.meta(), Some(&pack), 3, 5, 5, 5, 0, 2, &[], LightMode::default(), None);
        assert_eq!(south(&textured).len(), 3, "textured: 3-wide rows, never merged vertically");

        // U tiles up to the merged width; V never leaves the single row it started in.
        let uv: Vec<f32> = textured.uvs.chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        assert!(!uv.is_empty(), "a loaded pack must emit UVs");
        let us: Vec<f32> = uv.iter().step_by(2).copied().collect();
        let vs: Vec<f32> = uv.iter().skip(1).step_by(2).copied().collect();
        assert_eq!(us.iter().cloned().fold(f32::NEG_INFINITY, f32::max), 3.0, "U tiles across the merged width");
        let vmin = vs.iter().cloned().fold(f32::INFINITY, f32::min);
        let vmax = vs.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let row_h = 1.0 / pack.atlas_rows as f32;
        assert!((vmax - vmin - row_h).abs() < 1e-6, "V spans exactly one atlas row ({vmin}..{vmax})");
    }

    /// Ramps and wedges are not unit squares, so they never enter the merge pass — and a plain-cube
    /// run must not merge *through* one as if the cell were empty or flat. A row of stone cubes with a
    /// stone ramp in the middle therefore yields two separate merged top quads (left of the ramp and
    /// right of it), covering exactly the cube cells and skipping the ramp's.
    #[test]
    fn test_greedy_merge_leaves_ramps_unmerged_and_splits_the_run_around_them() {
        let mut world = make_test_world();
        for x in 3..=7 { world.bytes[block(x, 5, 0)] = 2; } // stone row
        world.bytes[block(5, 5, 0)] = 24; // Stone Ramp (south) in the middle

        let g = obj_geometry_region(&world, world.meta(), None, 3, 5, 7, 5, 0, 0, &[], LightMode::default(), None);
        let top = quads_in_plane_y(&g, 1.0);
        // The ramp's own top is a sloped quad, not in the z=1 plane, so only the cubes' tops appear.
        assert_eq!(top.len(), 2, "the ramp splits the cube run into two merged quads");
        assert_eq!(
            covered_cells(&top),
            [(3, 5), (4, 5), (6, 5), (7, 5)].into_iter().collect::<HashSet<_>>(),
            "merged tops cover the cube cells and never the ramp's",
        );
    }

    /// Fluids: a face defers to the merge pass only when it fills its unit cell. Full-height water
    /// merges normally (and lands in the *transparent* stream, not the opaque one); a ½-height surface
    /// sits at z+0.5, so its top faces are not unit squares and must emit one per block, unmerged —
    /// merging them would be harmless here but the same gate protects the stepped-sliver lateral faces
    /// a mixed-level pool produces.
    #[test]
    fn test_greedy_merge_full_fluid_merges_partial_fluid_does_not() {
        let mut full = make_test_world();
        for x in 3..=6 { full.bytes[block(x, 5, 0)] = 20; } // Water, level 4
        let g = obj_geometry_region(&full, full.meta(), None, 3, 5, 6, 5, 0, 0, &[], LightMode::default(), None);
        assert_eq!(g.vertex_count, 0, "water is transparent — nothing in the opaque stream");
        let top: Vec<_> = quads_t(&g).into_iter().filter(|q| q.iter().all(|v| v.1 == 1.0)).collect();
        assert_eq!(top.len(), 1, "full-height water tops merge into one quad");
        assert_eq!(covered_cells(&top).len(), 4);

        let mut half = make_test_world();
        for x in 3..=6 { half.bytes[block(x, 5, 0)] = 60; } // Water ½, level 2
        let g = obj_geometry_region(&half, half.meta(), None, 3, 5, 6, 5, 0, 0, &[], LightMode::default(), None);
        let top: Vec<_> = quads_t(&g).into_iter().filter(|q| q.iter().all(|v| v.1 == 0.5)).collect();
        assert_eq!(top.len(), 4, "a ½-height surface is not a unit square — one quad per block");
        assert_eq!(covered_cells(&top).len(), 4);
    }

    #[test]
    fn shadows_darken_a_block_directly_under_an_overhang_at_high_noon() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 0)] = 2; // probe
        for z in 1..=10 { world.bytes[block(3, 5, z)] = 2; } // solid overhang directly above

        let unshadowed = side_face_color(&world, 3, 5, 0, 0, LightMode::default());
        // sun_t=0.5 -> near-overhead (elevation ~80deg), closest analogue to the old vertical scan.
        let shadowed = side_face_color(&world, 3, 5, 0, 0, LightMode { night: false, shadows: true, sun_t: 0.5, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy });

        for c in 0..3 {
            assert!(shadowed[c] < unshadowed[c], "a block under a solid overhang should be darker at high noon");
            assert!(shadowed[c] > 0.0, "shadowed colour must have a floor above pure black");
        }
    }

    #[test]
    fn low_sun_angle_does_not_darken_a_block_with_no_lateral_occluders() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 0)] = 2; // isolated probe, nothing else around

        let unshadowed = side_face_color(&world, 3, 5, 0, 0, LightMode::default());
        // sun_t=0.0 -> sunrise, low angle, nothing along the ray to occlude it.
        let lit_at_sunrise = side_face_color(&world, 3, 5, 0, 0, LightMode { night: false, shadows: true, sun_t: 0.0, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy });

        assert_eq!(lit_at_sunrise, unshadowed, "an isolated block with no occluders along the ray should stay fully lit");
    }

    #[test]
    fn shadowed_colour_is_never_pure_black() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 0)] = 2;
        for z in 1..=10 { world.bytes[block(3, 5, z)] = 2; }

        let shadowed = side_face_color(&world, 3, 5, 0, 0, LightMode { night: false, shadows: true, sun_t: 0.5, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy });
        for c in 0..3 {
            assert!(shadowed[c] > 0.05, "shadowed voxel colour must stay well above pure black, got {shadowed:?}");
        }
    }

    #[test]
    fn sun_direction_is_overhead_at_noon_and_low_angle_at_sunrise_sunset() {
        let noon = sun_direction(0.5);
        assert!(noon[2] > 0.9, "sun should be nearly straight up at t=0.5, got {noon:?}");
        let sunrise = sun_direction(0.0);
        assert!(sunrise[2] < 0.3, "sun should be low-angle at t=0.0, got {sunrise:?}");
        let sunset = sun_direction(1.0);
        assert!(sunset[2] < 0.3, "sun should be low-angle at t=1.0, got {sunset:?}");
    }


    /// The index-based lamp gather (`lamps_in_region`) must return exactly the same lamp positions
    /// as the old inline voxel scan for a given radius, and a larger radius must never drop lamps
    /// the smaller one found (it can only widen the box).
    #[test]
    fn lamps_in_region_matches_full_scan_and_radius_only_widens() {
        let mut world = make_test_world();
        // Two lamps in the single chunk, plus a decoy stone block that must not be picked up.
        world.bytes[block(2, 3, 4)] = LAMP_BLOCK_TYPE;
        world.bytes[block(10, 12, 20)] = LAMP_BLOCK_TYPE;
        world.bytes[block(6, 6, 6)] = 2; // stone decoy

        let index = crate::lamps::build_lamp_index(&world, &[(0, 0)]);
        // build_lamp_index buckets by absolute chunk coord (0,0 here).
        assert_eq!(index.get(&(0, 0)).map(|v| v.len()), Some(2), "both lamps land in chunk (0,0)");

        let region = (0, 0, 15, 15);
        for &radius in &[1.0f32, 5.0, 12.0, 40.0] {
            let mut from_index = crate::lamps::lamps_in_region(&index, &world, region.0, region.1, region.2, region.3, radius);
            let mut from_scan: Vec<[i32; 3]> = scan_lamps(&world, region.0, region.1, region.2, region.3, 0, world_max_z(&world), radius)
                .into_iter().map(|(p, _)| p).collect();
            from_index.sort();
            from_scan.sort();
            assert_eq!(from_index, from_scan, "index gather must match the old voxel scan at radius {radius}");
        }
    }

    /// Regression: `obj_geometry_region` night output with index-gathered lamps must be byte-identical
    /// to the old scan-gathered lamps at the legacy radius 5 (the refactor is a pure speedup).
    #[test]
    fn night_geometry_unchanged_between_index_and_scan_gather() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 0)] = 2; // stone probe
        world.bytes[block(3, 5, 3)] = LAMP_BLOCK_TYPE;
        world.bytes[block(3, 5, 3) + 4096] = 1; // red-ish paint on the lamp

        let mode = LightMode { night: true, shadows: false, sun_t: 0.0, flat: false, lamp_radius: 5.0, profile: LightingProfile::Legacy };

        // Old path: scan the region for lamps.
        let scan = scan_lamps(&world, 0, 0, 15, 15, 0, world_max_z(&world), 5.0);
        let g_scan = obj_geometry_region(&world, world.meta(), None, 0, 0, 15, 15, 0, world_max_z(&world), &scan, mode, None);

        // New path: gather from the index and resolve colours exactly as get_chunk_geometry does.
        let index = crate::lamps::build_lamp_index(&world, &[(0, 0)]);
        let idx_lamps: Vec<([i32; 3], [f32; 3])> = crate::lamps::lamps_in_region(&index, &world, 0, 0, 15, 15, 5.0)
            .into_iter().map(|p| {
                let (_, paint) = get_block_at(&world, p[0], p[1], p[2]);
                let rgb = block_color(LAMP_BLOCK_TYPE, paint, world.sky);
                (p, [rgb[0] as f32 / 255.0, rgb[1] as f32 / 255.0, rgb[2] as f32 / 255.0])
            }).collect();
        let g_idx = obj_geometry_region(&world, world.meta(), None, 0, 0, 15, 15, 0, world_max_z(&world), &idx_lamps, mode, None);

        assert_eq!(g_scan.colors, g_idx.colors, "night vertex colours must be identical (index vs scan gather)");
        assert_eq!(g_scan.positions, g_idx.positions, "geometry positions must be identical");
    }

    /// The memo must be a pure speedup: same answer as the uncached reader for every probe,
    /// including out-of-bounds Z, negative coords, and columns with no chunk at all (the case a
    /// naive "cache the address" memo gets wrong by not caching the *absence* of a chunk).
    #[test]
    fn chunk_cache_agrees_with_the_uncached_block_reader() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 2)] = 2;
        world.bytes[block(3, 5, 2) + 4096] = 7; // a paint byte, so we compare both halves of the tuple
        world.bytes[block(0, 0, 0)] = 1;
        world.bytes[block(15, 15, 17)] = 4; // crosses into the second band

        let cache = ChunkCache::new(&world);
        // Deliberately interleave in-chunk and out-of-chunk probes so a stale memo would show up.
        for wz in [-1, 0, 2, 17, 63, 64, 9999] {
            for wy in [-17, -1, 0, 5, 15, 16, 33] {
                for wx in [-17, -1, 0, 3, 15, 16, 33] {
                    assert_eq!(
                        cache.get(wx, wy, wz),
                        get_block_at(&world, wx, wy, wz),
                        "mismatch at ({wx},{wy},{wz})"
                    );
                }
            }
        }
    }

    #[test]
    fn pick_block_hits_the_first_solid_voxel_and_reports_the_entry_face() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 2)] = 2; // Stone

        // Ray from above, straight down: enters through the top face (+Z normal).
        let hit = pick_block_in(&world, 3.5, 5.5, 9.0, 0.0, 0.0, -1.0, 32.0).unwrap().expect("expected a hit");
        assert_eq!((hit.x, hit.y, hit.z), (3, 5, 2));
        assert_eq!(hit.block_type, 2);
        assert_eq!((hit.nx, hit.ny, hit.nz), (0, 0, 1), "downward ray must enter the top face");

        // Ray from the west, heading east: enters through the -X face.
        let hit = pick_block_in(&world, 0.5, 5.5, 2.5, 1.0, 0.0, 0.0, 32.0).unwrap().expect("expected a hit");
        assert_eq!((hit.x, hit.y, hit.z), (3, 5, 2));
        assert_eq!((hit.nx, hit.ny, hit.nz), (-1, 0, 0), "eastward ray must enter the west face");

        // `hit + normal` is the empty voxel a placed block would occupy.
        assert_eq!(get_block_at(&world, hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz).0, 0);
    }

    #[test]
    fn pick_block_misses_return_none_and_respect_max_dist() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 2)] = 2;

        // Parallel ray that never crosses the block.
        assert!(pick_block_in(&world, 0.5, 0.5, 8.5, 1.0, 0.0, 0.0, 32.0).unwrap().is_none());
        // Aimed correctly but stopped short: the block is ~6 units below the origin.
        assert!(pick_block_in(&world, 3.5, 5.5, 9.0, 0.0, 0.0, -1.0, 2.0).unwrap().is_none());
        // Same ray, enough distance.
        assert!(pick_block_in(&world, 3.5, 5.5, 9.0, 0.0, 0.0, -1.0, 32.0).unwrap().is_some());
    }

    #[test]
    fn pick_block_hits_a_voxel_the_origin_is_already_touching() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 2)] = 2;
        // Origin sits in the air voxel directly above; the very first DDA step lands on the block,
        // so `prev` must still resolve to the origin voxel rather than an uninitialised one.
        let hit = pick_block_in(&world, 3.5, 5.5, 3.01, 0.0, 0.0, -1.0, 4.0).unwrap().expect("expected a hit");
        assert_eq!((hit.x, hit.y, hit.z), (3, 5, 2));
        assert_eq!((hit.nx, hit.ny, hit.nz), (0, 0, 1));
    }

    #[test]
    fn pick_block_rejects_a_degenerate_ray_direction() {
        let world = make_test_world();
        assert!(pick_block_in(&world, 3.5, 5.5, 9.0, 0.0, 0.0, 0.0, 32.0).is_err());
    }

    #[test]
    fn pick_block_hits_non_solid_blocks_like_water_and_glass() {
        let mut world = make_test_world();
        world.bytes[block(3, 5, 2)] = 20; // Water — BI_NOTSOLID, so `obj_occludes` is false for it
        let hit = pick_block_in(&world, 3.5, 5.5, 9.0, 0.0, 0.0, -1.0, 32.0).unwrap().expect("water is pickable");
        assert_eq!(hit.block_type, 20);
    }

}
