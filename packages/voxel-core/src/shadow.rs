//! Baked top-face shadows: a port of Emod's `Classes/Shadow.{h,cpp}` (the *nearest-caster-above*
//! kernel, 2026-10-23). Plan: `TEST WORLDS/baked-shadows-plan-2026-10-29.md`; **Emod wins on any
//! disagreement**.
//!
//! The shade of a top face comes from the covering columns above it, read straight from voxels when
//! a mesh is built ([`ShadeGather`]). Nothing is cached across meshes and nothing is derived state,
//! so there is nothing to invalidate; a mesh can only be stale if a *neighbour* chunk changed and
//! was not re-meshed, which is the edit-sync's business (plan §4).
//!
//! Everything that decides a shade is integer, so it is identical on every target. Only the final
//! `f32` light ([`lit_top`]) is float.
//!
//! Axes here are the editor's: x east, y south, **z up**. Emod's are x, z horizontal, y up, so
//! Emod's `(x, z, y)` is our `(x, y, z)`.

use crate::geometry::ChunkCache;
use crate::view::{scan_z_ceiling, VoxelView};

/// Which baked top-face shading a mesh gets. `Off` is a flat render, byte-identical to a build that
/// has never heard of shadows.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShadowMode {
    #[default]
    Off,
    /// One shade per top face (the 3×3 of columns around it).
    Classic,
    /// One shade per top-face *corner* (the 2×2 of columns meeting there), blended across the face.
    Smooth,
}

/// A covering column counts fully when its nearest caster is `1..=SHADOW_REACH_FULL` blocks above the
/// face, fades linearly to nothing at [`SHADOW_REACH_END`], and is ignored beyond.
pub const SHADOW_REACH_FULL: i32 = 8;
pub const SHADOW_REACH_END: i32 = 24;

/// Block ids that do **not** cast, from Emod's `blockinfo` rule (`Classes/Globals.cpp`, ids in
/// `Classes/Constants.h`): air; cloud (19), weave (21) and glass (58) by id; every `IS_LIQUID`
/// (water 20, 59–61, lava 23, 62–64); every `IS_OBJECT` (doors 66–70, golden cube 71, flower 73,
/// portals 75–79). Everything else casts: leaves, trunk, ice, vines, every ramp and side, the
/// lightbox (72), the BT* disguises (BTGLASS 90 and BTWATER 107 are solid TNT), block 12 (the 1.x
/// flower block is `IS_GRASS`, not `IS_OBJECT`) and all of 112–127.
///
/// ⚠️ **Not `obj_occludes`.** That is the face-culling rule and differs: ramps and vines cast but
/// don't occlude.
const NON_CASTERS: [u8; 24] = [
    0, 19, 20, 21, 23, 58, 59, 60, 61, 62, 63, 64, 66, 67, 68, 69, 70, 71, 73, 75, 76, 77, 78, 79,
];

const fn caster_table() -> [bool; 128] {
    let mut t = [true; 128];
    let mut i = 0;
    while i < NON_CASTERS.len() {
        t[NON_CASTERS[i] as usize] = false;
        i += 1;
    }
    t
}

/// Does block id `bt` cast a shadow? Indexed by id; ids past 127 don't exist and don't cast.
pub const SHADOW_CASTER: [bool; 128] = caster_table();

#[inline]
pub fn is_caster(bt: u8) -> bool {
    SHADOW_CASTER.get(bt as usize).copied().unwrap_or(false)
}

/// Weight (sixteenths) of one covering column whose nearest caster is `gap` blocks above the face
/// (`0` = none within reach). Emod's `shadow_weight`.
#[inline]
pub fn weight(gap: u8) -> u32 {
    let gap = gap as i32;
    if gap <= 0 { 0 }
    else if gap <= SHADOW_REACH_FULL { 16 }
    else if gap < SHADOW_REACH_END { (SHADOW_REACH_END - gap) as u32 }
    else { 0 }
}

/// The gap tables for a rectangle of columns and a band of heights, plus a ring of 1 column all
/// round, so every top face in the rectangle can read the 3×3 around it.
///
/// Per column and height it stores the gap (`1..SHADOW_REACH_END`) up to the nearest caster above,
/// or `0` for none within reach. Memory is `(w+2)·(d+2)·h` bytes (≤ 83 KiB for a chunk at 256z) and
/// is freed with the mesh.
pub struct ShadeGather {
    z1: i32,
    h: usize,
    /// Column count along y, ring included.
    d: usize,
    /// Rectangle width/depth (no ring), to bounds-check lookups.
    w_in: i32,
    d_in: i32,
    gaps: Vec<u8>,
}

impl ShadeGather {
    /// Gather the rectangle `x0..=x1, y0..=y1` (world coordinates) for heights `z1..=z2`.
    ///
    /// Reads the **real world** through `cache`: blocks above `z2` (a cutaway cap, the camera band)
    /// still cast, so a mesh's shade never depends on its band. A ring column outside the world
    /// reads as air. `world_top` is the highest z that exists.
    ///
    /// The scan starts at `min(z2 + 23, world_top)`: a caster 24 or more above can't reach a face.
    /// Each column also starts no higher than **its own chunk's** `top_band_hint` ceiling (27.4b —
    /// everything above it is air by contract). ⚠️ For a ring column that is the **neighbour's**
    /// hint, never the mesh's own: a tall tree in the next chunk has to cast, and a hint that is
    /// too low would hide it, the same correctness trap CLAUDE.md warns about.
    pub fn build<V: VoxelView>(cache: &ChunkCache<V>, x0: i32, y0: i32, x1: i32, y1: i32, z1: i32, z2: i32, world_top: i32) -> Self {
        let z1 = z1.max(0);
        let (w_in, d_in) = ((x1 - x0 + 1).max(0), (y1 - y0 + 1).max(0));
        let h = if z2 >= z1 { (z2 - z1 + 1) as usize } else { 0 };
        let (w, d) = ((w_in + 2) as usize, (d_in + 2) as usize);
        let mut g = ShadeGather { z1, h, d, w_in, d_in, gaps: vec![0u8; if h == 0 { 0 } else { w * d * h }] };
        if h == 0 { return g; }
        let scan_top = (z2 + SHADOW_REACH_END - 1).min(world_top);
        let world = cache.world();
        let (mnx, mny) = world.chunk_origin();
        // The box spans a few chunks at most: remember the last column's chunk (its bytes and its
        // hint ceiling) so each is looked up once per run of columns, not per voxel.
        let mut last: Option<((i32, i32), Option<&[u8]>, i32)> = None;
        for dx in 0..w {
            for dy in 0..d {
                let (wx, wy) = (x0 - 1 + dx as i32, y0 - 1 + dy as i32);
                let key = (wx.div_euclid(16) + mnx, wy.div_euclid(16) + mny);
                let (chunk, ceil) = match last {
                    Some((k, c, h)) if k == key => (c, h),
                    _ => {
                        let (c, h) = (world.chunk_bytes(key.0, key.1), scan_z_ceiling(world, key.0, key.1));
                        last = Some((key, c, h));
                        (c, h)
                    }
                };
                // A ring column outside the world reads as air: nothing casts, gaps stay 0.
                let Some(chunk) = chunk else { continue };
                let col = &mut g.gaps[(dx * d + dy) * h..][..h];
                let base = wx.rem_euclid(16) as usize * 256 + wy.rem_euclid(16) as usize * 16;
                let mut nearest = i32::MIN;
                let mut z = scan_top.min(ceil);
                while z >= z1 {
                    if z <= z2 && nearest != i32::MIN {
                        let gap = nearest - z;
                        if gap < SHADOW_REACH_END { col[(z - z1) as usize] = gap as u8; }
                    }
                    // Same addressing and same "past the chunk's real span is air" rule as
                    // `ChunkCache::get` (the paint byte 4096 on must exist too).
                    let bi = (z as usize / 16) * 8192 + base + (z as usize % 16);
                    if bi + 4096 < chunk.len() && is_caster(chunk[bi]) { nearest = z; }
                    z -= 1;
                }
            }
        }
        g
    }

    /// The gap at gather column `(cx, cy)` (ring-inclusive: `0` is the ring column at `x0 − 1`).
    #[inline]
    fn gap(&self, cx: i32, cy: i32, z: i32) -> u8 {
        self.gaps[(cx as usize * self.d + cy as usize) * self.h + (z - self.z1) as usize]
    }

    /// `lx`/`ly` are the block's column relative to the rectangle's min corner; `z` must be in the
    /// gathered band. Out of range → unshaded.
    #[inline]
    fn in_range(&self, lx: i32, ly: i32, z: i32) -> bool {
        lx >= 0 && ly >= 0 && lx < self.w_in && ly < self.d_in && z >= self.z1 && ((z - self.z1) as usize) < self.h
    }

    /// Classic: the shade (`155..=255`, `255` = unshaded) of the top face of the block at
    /// `(lx, ly, z)`: `255 − (100·S)/144` over the 3×3 columns centred on it. With every gap ≤ 8
    /// this is exactly Eden 1.x's `255 − 100·count/9`.
    #[inline]
    pub fn classic(&self, lx: i32, ly: i32, z: i32) -> u8 {
        if !self.in_range(lx, ly, z) { return 255; }
        let mut s = 0;
        for dx in 0..3 {
            for dy in 0..3 { s += weight(self.gap(lx + dx, ly + dy, z)); }
        }
        (255 - (100 * s) / 144) as u8
    }

    /// Smooth: the shade (`155..=255`) at each top-face corner, indexed `vx * 2 + vy` with
    /// `vx` 0 = west (x), 1 = east and `vy` 0 = north (y), 1 = south. Corner `k` sums the 2×2
    /// columns meeting there: `255 − (100·S_k)/64`. `None` = every corner unshaded.
    ///
    /// Emod's `shadow_corners`: nine weights computed once, four 2×2 windows summed from them.
    #[inline]
    pub fn corners(&self, lx: i32, ly: i32, z: i32) -> Option<[u8; 4]> {
        if !self.in_range(lx, ly, z) { return None; }
        let mut wt = [[0u32; 3]; 3];
        for (dx, row) in wt.iter_mut().enumerate() {
            for (dy, c) in row.iter_mut().enumerate() { *c = weight(self.gap(lx + dx as i32, ly + dy as i32, z)); }
        }
        let mut out = [255u8; 4];
        let mut any = 0;
        for (k, o) in out.iter_mut().enumerate() {
            let (vx, vy) = (k >> 1, k & 1);
            let s = wt[vx][vy] + wt[vx + 1][vy] + wt[vx][vy + 1] + wt[vx + 1][vy + 1];
            *o = (255 - (100 * s) / 64) as u8;
            any |= s;
        }
        (any != 0).then_some(out)
    }
}

/// A shaded top face's light (Emod `shadow_lightTops`): the shade scales **only the sky term**.
///
/// * `shade == 255` keeps `unshaded` exactly.
/// * Night: `sky = ambient · s`, then `+ lamp_add` per channel, clamped to `[0, 1.5]`, so lamps
///   still light a shaded floor. Do **not** compute this as `unshaded · s`, which would dim the
///   lamp light too.
/// * Day: `sky = s`, capped at 1.0, so a shaded face next to a lightbox never outshines an
///   unshaded one.
///
/// `sky` is its own statement so nothing fuses the multiply into the add.
pub fn lit_top(shade: u8, unshaded: [f32; 3], night: bool, ambient: f32, lamp_add: [f32; 3]) -> [f32; 3] {
    if shade >= 255 { return unshaded; }
    let s = shade as f32 / 255.0;
    let sky = if night { ambient * s } else { s };
    lamp_add.map(|add| {
        let v = (sky + add).clamp(0.0, 1.5);
        if night { v } else { v.min(1.0) }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testworld::TestWorld;

    /// A gather over a 1×1 rectangle at height 0 with the 3×3 ring's gaps set directly
    /// (`g[dx][dy]`, ring-inclusive).
    fn grid(g: [[u8; 3]; 3]) -> ShadeGather {
        let mut gaps = vec![0u8; 9];
        for dx in 0..3 { for dy in 0..3 { gaps[dx * 3 + dy] = g[dx][dy]; } }
        ShadeGather { z1: 0, h: 1, d: 3, w_in: 1, d_in: 1, gaps }
    }

    #[test]
    fn weight_table() {
        let got: Vec<u32> = [0u8, 1, 8, 9, 16, 23, 24, 30].map(weight).to_vec();
        assert_eq!(got, [0, 16, 16, 15, 8, 1, 0, 0]);
    }

    /// The table is Emod's rule spelled out (Globals.cpp `blockinfo`, Constants.h `TYPE_*`): not air,
    /// cloud/weave/glass, any liquid, any object; everything else casts.
    #[test]
    fn caster_table_is_emods_rule() {
        let mut want = [true; 128];
        want[0] = false;
        for id in [19, 21, 58] { want[id] = false; }          // cloud, weave, glass
        for id in [20, 59, 60, 61, 23, 62, 63, 64] { want[id] = false; } // IS_LIQUID
        for id in [66, 67, 68, 69, 70, 71, 73, 75, 76, 77, 78, 79] { want[id] = false; } // IS_OBJECT
        assert_eq!(SHADOW_CASTER, want);
        for id in [1, 10, 11, 12, 22, 72, 90, 107, 112, 127] { assert!(is_caster(id), "{id} casts"); }
        for id in [0, 19, 20, 58, 66, 73, 79, 128, 255] { assert!(!is_caster(id), "{id} doesn't cast"); }
    }

    #[test]
    fn classic_matches_the_1x_count_formula() {
        let want = [255u8, 244, 233, 222, 211, 200, 189, 178, 167, 155];
        for (count, &w) in want.iter().enumerate() {
            let mut g = [[0u8; 3]; 3];
            for i in 0..count { g[i / 3][i % 3] = 1 + (i as u8 % 8); } // any gap 1..=8 weighs the same
            assert_eq!(grid(g).classic(0, 0, 0), w, "{count} covering columns");
        }
    }

    #[test]
    fn classic_mixed_gaps() {
        // 4 columns at gap 1 (4·16) + 2 at gap 12 (2·12) → S = 88 → 255 − 61.
        let g = grid([[1, 1, 12], [1, 1, 12], [0, 0, 0]]);
        assert_eq!(g.classic(0, 0, 0), 194);
    }

    #[test]
    fn smooth_shades_only_the_corners_that_touch_the_caster() {
        // A caster in the NE neighbour (x + 1, y − 1) touches only the NE corner (vx 1, vy 0).
        let g = grid([[0, 0, 0], [0, 0, 0], [1, 0, 0]]);
        assert_eq!(g.corners(0, 0, 0), Some([255, 255, 230, 255]));
        // A full canopy: every corner at the 2×2 maximum.
        assert_eq!(grid([[1; 3]; 3]).corners(0, 0, 0), Some([155; 4]));
        assert_eq!(grid([[0; 3]; 3]).corners(0, 0, 0), None);
    }

    fn at(z: usize, lx: usize, ly: usize) -> usize { (z / 16) * 8192 + lx * 256 + ly * 16 + z % 16 }

    fn gather(w: &TestWorld, z1: i32, z2: i32) -> ShadeGather {
        let cache = ChunkCache::new(w);
        ShadeGather::build(&cache, 0, 0, 15, 15, z1, z2, (w.num_bands * 16 - 1) as i32)
    }

    /// Nearest caster, not topmost: a floor under a ceiling at +3 reads gap 3 even with a roof at
    /// +20 above that; a cave ceiling at +30 is out of reach.
    #[test]
    fn nearest_caster_wins_over_topmost() {
        let mut w = TestWorld::new(1, 1, 4);
        for lx in 4..7 { for ly in 4..7 {
            w.bytes[at(13, lx, ly)] = 1; // ceiling, 3 above the floor block at z 10
            w.bytes[at(30, lx, ly)] = 1; // roof, 20 above the ceiling
        }}
        let g = gather(&w, 0, 40);
        assert_eq!(g.gap(5 + 1, 5 + 1, 10), 3);
        assert_eq!(g.classic(5, 5, 10), 155);
        // Lower blocks see the same ceiling, farther away.
        assert_eq!(g.gap(5 + 1, 5 + 1, 8), 5);
        assert_eq!(g.gap(5 + 1, 5 + 1, 6), 7);
        // A lone cave ceiling 30 above is no shade at all.
        let mut w = TestWorld::new(1, 1, 4);
        for lx in 4..7 { for ly in 4..7 { w.bytes[at(40, lx, ly)] = 1; } }
        assert_eq!(gather(&w, 0, 40).classic(5, 5, 10), 255);
    }

    #[test]
    fn glass_and_water_pass_light_leaves_do_not() {
        for (bt, shade) in [(58u8, 255u8), (20, 255), (59, 255), (66, 255), (2, 155)] {
            let mut w = TestWorld::new(1, 1, 4);
            for lx in 4..7 { for ly in 4..7 { w.bytes[at(14, lx, ly)] = bt; } }
            assert_eq!(gather(&w, 0, 20).classic(5, 5, 10), shade, "block {bt}");
        }
    }

    /// The ring is read from the neighbouring chunk, and a band that excludes the caster doesn't
    /// change a face's shade.
    #[test]
    fn ring_reads_the_neighbour_chunk_and_ignores_the_band() {
        let mut w = TestWorld::new(2, 1, 4);
        let base = w.chunks[&(1, 0)];
        for lx in 0..3 { for ly in 4..7 { w.bytes[base + at(14, lx, ly)] = 1; } }
        let cache = ChunkCache::new(&w);
        let full = ShadeGather::build(&cache, 0, 0, 15, 15, 0, 63, 63);
        // The block at x 15, y 5 sees the canopy's x 16 column only: 3 of its 9 columns, gap 4.
        assert_eq!(full.classic(15, 5, 10), 255u32 as u8 - (100u32 * 48 / 144) as u8);
        // Meshing only z 8..=11 (the canopy at 14 is above the band) gives the same shade.
        let banded = ShadeGather::build(&cache, 0, 0, 15, 15, 8, 11, 63);
        assert_eq!(banded.classic(15, 5, 10), full.classic(15, 5, 10));
        assert_eq!(banded.classic(14, 5, 10), 255);
    }

    /// The gather reads chunk slices directly (27.4b perf); it must agree with a naive reference that
    /// goes through `ChunkCache::get` voxel by voxel, ring and world edge included.
    #[test]
    fn gather_matches_a_naive_reference() {
        let mut w = TestWorld::new(3, 3, 4);
        let mut seed = 0x2545_f491_u32;
        let mut rnd = || { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; seed };
        for (_, &base) in w.chunks.clone().iter() {
            for _ in 0..600 {
                let (lx, ly, z) = (rnd() % 16, rnd() % 16, rnd() % 64);
                let bt = [1u8, 2, 20, 58, 73, 0][(rnd() % 6) as usize];
                w.bytes[base + at(z as usize, lx as usize, ly as usize)] = bt;
            }
        }
        w.drop_chunk(2, 2); // a hole: its columns read as air
        let cache = ChunkCache::new(&w);
        for (bx, by) in [(0, 0), (16, 16), (32, 0), (16, 32)] {
            let g = ShadeGather::build(&cache, bx, by, bx + 15, by + 15, 5, 40, 63);
            for lx in 0..16 { for ly in 0..16 { for z in 5..=40 {
                let mut s = 0;
                for dx in -1..=1 { for dy in -1..=1 {
                    let near = (z + 1..(z + SHADOW_REACH_END).min(64)).find(|&zz| is_caster(cache.get(bx + lx + dx, by + ly + dy, zz).0));
                    s += near.map_or(0, |n| weight((n - z) as u8));
                }}
                assert_eq!(g.classic(lx, ly, z), (255 - (100 * s) / 144) as u8, "box ({bx},{by}) col ({lx},{ly}) z {z}");
            }}}
        }
    }

    /// 27.4b's scan bound: each gather column starts at **its own** chunk's `top_band_hint`. A
    /// low floor chunk next to a tall tree must still be shaded by the tree (the ring column uses
    /// the neighbour's hint, not the mesh's), and exact hints change nothing.
    #[test]
    fn scan_bound_uses_each_columns_own_chunk_hint() {
        let mut w = TestWorld::new(2, 1, 4);
        let base = w.chunks[&(1, 0)];
        // A canopy at z 20 (band 1) in chunk (1,0), against the seam; chunk (0,0) only holds band 0.
        for lx in 0..3 { for ly in 4..7 { w.bytes[base + at(20, lx, ly)] = 2; } }
        let unhinted = ShadeGather::build(&ChunkCache::new(&w), 0, 0, 15, 15, 0, 15, 63).classic(15, 5, 10);
        assert!(unhinted < 255, "the canopy shades the seam column");
        w.chunk_hints.insert((0, 0), 0);
        w.chunk_hints.insert((1, 0), 1);
        let hinted = ShadeGather::build(&ChunkCache::new(&w), 0, 0, 15, 15, 0, 15, 63).classic(15, 5, 10);
        assert_eq!(hinted, unhinted, "exact per-chunk hints must not change the shade");
        // The trap, pinned: had the ring column used the mesh's own (band 0) hint, the canopy would
        // vanish. A too-low hint on the neighbour itself does hide it — the hint contract's
        // one-directional rule, made visible so nobody "tightens" the bound to the mesh's hint.
        w.chunk_hints.insert((1, 0), 0);
        let too_low = ShadeGather::build(&ChunkCache::new(&w), 0, 0, 15, 15, 0, 15, 63).classic(15, 5, 10);
        assert_eq!(too_low, 255);
    }

    #[test]
    fn lit_top_day_and_night() {
        let one = [1.0f32; 3];
        assert_eq!(lit_top(255, one, false, 0.35, [0.0; 3]), one);
        let day = lit_top(155, one, false, 0.35, [0.0; 3]);
        assert!(day.iter().all(|&c| (c - 155.0 / 255.0).abs() < 1e-6 && c <= 1.0));
        // Night: sky is scaled, the lamp add is not.
        let far = lit_top(155, [0.35; 3], true, 0.35, [0.0; 3]);
        let near = lit_top(155, [0.9; 3], true, 0.35, [0.55, 0.3, 0.1]);
        let unshaded_near = [0.9f32; 3];
        for c in 0..3 {
            assert!(near[c] > far[c], "lamp still lights a shaded floor");
            assert!(near[c] <= unshaded_near[c] + 1e-6, "…but never past the unshaded floor");
        }
        assert!((far[0] - 0.35 * 155.0 / 255.0).abs() < 1e-6);
        assert!((near[0] - (0.35 * 155.0 / 255.0 + 0.55)).abs() < 1e-6);
    }
}
