//! The lamp spatial index.
//!
//! Night lighting lights up Lamp blocks ([`LAMP_BLOCK_TYPE`], 72). Finding the lamps near a chunk
//! used to be an O((16+2r)³) voxel scan per chunk-geometry request, which is why the lamp radius was
//! a hard-coded constant. This chunk-keyed index gathers lamps by iterating actual lamp positions in
//! the handful of chunks within reach, so the radius can be a user slider (and it's the shared
//! foundation an experimental GPU night point-light path needs too).
//!
//! **Everything here is generic over [`VoxelView`]** and the index is *interior-mutable*: an app can
//! scan and memoise while holding only a **read** guard on its world state. Correctness comes from
//! the caller holding that guard continuously across scan *and* install — every mutating path takes
//! the write guard, so no edit can slip in between and leave a freshly scanned chunk describing a
//! world that no longer exists.

use crate::colors::block_color;
use crate::geometry::LAMP_BLOCK_TYPE;
use crate::view::{get_block_at, scan_band_ceiling, ViewMeta, VoxelView};
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use std::sync::Mutex;

/// Map from chunk coord to the lamp positions (world-local block coords) inside that chunk.
pub type LampMap = FxHashMap<(i32, i32), FxHashSet<[i32; 3]>>;

/// Decode a chunk-relative byte offset into `(lx, ly, z)`, or `None` if it addresses a *paint*
/// byte rather than a block byte. Inverse of `band*8192 + lx*256 + ly*16 + lz`; the paint half of
/// each 8192-byte band sits at `+4096`, so only the low half carries block types.
#[inline]
fn decode_block_offset(off: usize) -> Option<(usize, usize, usize)> {
    let rem = off % 8192;
    if rem >= 4096 { return None; } // paint half-band
    Some((rem / 256, (rem % 256) / 16, (off / 8192) * 16 + rem % 16))
}

/// Scan one populated chunk's voxels for Lamp blocks, returning their world-local block coords.
///
/// Walks each band's 4096-byte *block* half **linearly** (audit H3): the old form probed
/// `band*8192 + lx*256 + ly*16 + lz` with `z` innermost, which jumps 8192 bytes every 16 steps — the
/// worst possible order for a 131 KB chunk. Scanning the contiguous half-band with `position` lets
/// the search vectorise, halves the bytes touched (the paint halves are skipped outright rather than
/// skipped-by-indexing), and reads the mapping sequentially so a cold chunk costs one streaming
/// page-in instead of a strided walk over every page.
pub fn scan_chunk_lamps(world: &impl VoxelView, cx: i32, cy: i32) -> Vec<[i32; 3]> {
    let Some(chunk) = world.chunk_bytes(cx, cy) else { return Vec::new() };
    let (min_x, min_y) = world.chunk_origin();
    let base_x = (cx - min_x) * 16;
    let base_y = (cy - min_y) * 16;
    let mut out = Vec::new();
    // Bands above the chunk's top-occupied-band hint hold no blocks at all, so they can hold no
    // lamps either — capping here is free and cannot change the result (`VoxelView::top_band_hint`).
    for band in 0..scan_band_ceiling(world, cx, cy) {
        let lo = band * 8192;
        if lo >= chunk.len() { break; }
        let hi = (lo + 4096).min(chunk.len());
        let half = &chunk[lo..hi];
        let mut i = 0usize;
        while let Some(rel) = half[i..].iter().position(|&b| b == LAMP_BLOCK_TYPE) {
            let rem = i + rel;
            out.push([
                base_x + (rem / 256) as i32,
                base_y + ((rem % 256) / 16) as i32,
                (band * 16 + rem % 16) as i32,
            ]);
            i = rem + 1;
            if i >= half.len() { break; }
        }
    }
    out
}

/// Build the full lamp index by scanning the given populated chunks (sparse worlds store just
/// edited chunks, so this is bounded by the actual world size, not the whole grid). The caller
/// supplies the chunk list because `VoxelView` deliberately doesn't enumerate chunks.
///
/// Parallel over chunks — they are independent `&impl VoxelView` reads, and nothing in the closure
/// touches app state, so the "no re-locking inside a rayon closure" rule holds.
///
/// Production always builds lazily and per-chunk via [`LampIndex::lamps_in_region`] (§4 of the
/// 2026-08 memory-efficiency pass) — this whole-world scan is the parity oracle and the backing for
/// [`LampIndex::build_now`].
pub fn build_lamp_index(world: &(impl VoxelView + Sync), chunks: &[(i32, i32)]) -> LampMap {
    chunks
        .par_iter()
        .filter_map(|&(cx, cy)| {
            let lamps = scan_chunk_lamps(world, cx, cy);
            if lamps.is_empty() { None } else { Some(((cx, cy), lamps.into_iter().collect())) }
        })
        .collect::<Vec<_>>()
        .into_iter()
        .collect()
}

/// Interior state behind [`LampIndex`]: the lamp buckets built so far, plus which chunks have been
/// scanned. A `scanned` set rather than an `Unscanned/Scanned(Vec)` enum per chunk, because the
/// delta application already deletes empty buckets to keep `lamps` small (§4) — an enum would force
/// a permanent `Scanned(vec![])` entry per lamp-free chunk, which on a sparse world is most of them.
#[derive(Default)]
struct LampIndexState {
    lamps: LampMap,
    scanned: FxHashSet<(i32, i32)>,
    /// The most recent chunk box (`cx_lo, cx_hi, cy_lo, cy_hi`) that `lamps_in_region` confirmed
    /// every cell of as scanned. A containment check against this skips the per-call 121-cell
    /// `todo` sweep on the hot path — chunk-geometry re-fetches (stationary camera, the 25-chunk
    /// edit-sync halo) and adjacent streaming steps all probe heavily overlapping neighbourhoods.
    /// Chunks only ever go unscanned→scanned (delta application prunes `lamps`, never `scanned`;
    /// only `clear()` resets it, which drops `full_box` with it), so a box once fully scanned stays
    /// fully scanned and this needs no invalidation.
    full_box: Option<(i32, i32, i32, i32)>,
}

/// Lazily, *per-chunk* built, interior-mutable lamp spatial index (§4 of the 2026-08
/// memory-efficiency pass — replaced a whole-world `build_lamp_index` scan on the first night-lit
/// request, which forced ~half the mmap resident in one burst).
///
/// The `Mutex` is what lets scanning happen while its caller holds only a **read** guard on the
/// app's world state (audit C1 step 2 + H3): tile fetches, cursor reads and other chunk-geometry
/// requests keep running concurrently instead of queueing behind a write lock.
#[derive(Default)]
pub struct LampIndex(Mutex<LampIndexState>);

impl LampIndex {
    fn guard(&self) -> std::sync::MutexGuard<'_, LampIndexState> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Gather lamps within reach of a pixel-space region, scanning any chunk in that neighbourhood
    /// not already seen and memoising the result before delegating to the pure [`lamps_in_region`]
    /// gather. `&self` keeps this usable under a world **read** guard.
    pub fn lamps_in_region(
        &self, world: &(impl VoxelView + Sync), sx1: i32, sy1: i32, sx2: i32, sy2: i32, radius: f32,
    ) -> Vec<[i32; 3]> {
        let (cx_lo, cx_hi, cy_lo, cy_hi) = region_chunk_box(world, sx1, sy1, sx2, sy2, radius);
        let mut st = self.guard();

        // Fast path: this box is contained in one we already verified fully scanned. Skips the
        // 121-cell `todo` sweep and the rayon fan-out entirely — the `lamps` map is kept current by
        // the delta application, so the pure gather below is all that's needed.
        let contained = st.full_box.is_some_and(|(fx_lo, fx_hi, fy_lo, fy_hi)| {
            cx_lo >= fx_lo && cx_hi <= fx_hi && cy_lo >= fy_lo && cy_hi <= fy_hi
        });
        if !contained {
            let LampIndexState { lamps, scanned, full_box } = &mut *st;
            let todo: Vec<(i32, i32)> = (cx_lo..=cx_hi)
                .flat_map(|cx| (cy_lo..=cy_hi).map(move |cy| (cx, cy)))
                .filter(|coord| !scanned.contains(coord))
                .collect();
            if !todo.is_empty() {
                // Same shape as `build_lamp_index`: independent `&impl VoxelView` reads, nothing in
                // the closure touches app state, so the "no re-locking inside a rayon closure" rule
                // holds even though the caller is under a read guard here.
                let scans: Vec<((i32, i32), Vec<[i32; 3]>)> = todo
                    .par_iter()
                    .map(|&(cx, cy)| ((cx, cy), scan_chunk_lamps(world, cx, cy)))
                    .collect();
                for (key, v) in scans {
                    if !v.is_empty() { lamps.insert(key, v.into_iter().collect()); }
                    scanned.insert(key);
                }
            }
            // Every cell of this box is now scanned. Grow `full_box` to the bounding union when it
            // shares one axis' full extent with the old box and overlaps/touches on the other — the
            // sweep case, where the union is provably covered (both boxes fully scanned, same size,
            // adjacent along one axis). Otherwise just replace.
            let this = (cx_lo, cx_hi, cy_lo, cy_hi);
            *full_box = Some(match *full_box {
                Some((fx_lo, fx_hi, fy_lo, fy_hi))
                    if fy_lo == cy_lo && fy_hi == cy_hi && cx_lo <= fx_hi + 1 && fx_lo <= cx_hi + 1 =>
                {
                    (fx_lo.min(cx_lo), fx_hi.max(cx_hi), cy_lo, cy_hi)
                }
                Some((fx_lo, fx_hi, fy_lo, fy_hi))
                    if fx_lo == cx_lo && fx_hi == cx_hi && cy_lo <= fy_hi + 1 && fy_lo <= cy_hi + 1 =>
                {
                    (cx_lo, cx_hi, fy_lo.min(cy_lo), fy_hi.max(cy_hi))
                }
                _ => this,
            });
        }
        lamps_in_region(&st.lamps, world, sx1, sy1, sx2, sy2, radius)
    }

    /// Drop the index (world load/close). Rebuilt on-demand for the new world.
    pub fn clear(&self) {
        *self.guard() = LampIndexState::default();
    }

    /// The buckets built so far. A diagnostic/parity hook — production never needs it. (Public
    /// rather than `#[cfg(test)]` because the apps' own test suites are separate compilations.)
    pub fn snapshot(&self) -> LampMap {
        self.guard().lamps.clone()
    }

    /// Force a full rebuild over `chunks`, marking each of them scanned. Test/diagnostic only —
    /// production always builds lazily, per-chunk, via [`LampIndex::lamps_in_region`].
    pub fn build_now(&self, world: &(impl VoxelView + Sync), chunks: &[(i32, i32)]) {
        let mut st = self.guard();
        st.lamps = build_lamp_index(world, chunks);
        st.scanned = chunks.iter().copied().collect();
    }

    /// Open a batch of delta applications under a single lock acquisition. See [`LampDeltaBatch`].
    pub fn delta_batch(&self) -> LampDeltaBatch<'_> {
        LampDeltaBatch { st: self.guard() }
    }
}

/// Bring the index in line with one edit, using the undo delta that edit just produced (audit H3):
/// the delta holds each changed byte's **previous** value, and `world` already holds the new one, so
/// the lamp set changes at exactly the offsets the delta lists. This replaces a full 65,536-probe
/// rescan of every affected chunk with O(bytes actually changed) — a large fill used to re-scan
/// thousands of whole chunks per edit once the index existed.
///
/// The app's undo delta is its own type, so it drives this batch chunk by chunk rather than handing
/// the whole thing over; the batch holds the lock for the duration so one edit is still one
/// acquisition.
///
/// ⚠️ A chunk that hasn't been scanned yet is skipped outright, *before* touching its delta —
/// applying one to an unscanned chunk would `entry().or_default()` a bucket holding only this edit's
/// lamps and wrongly mark the chunk fully known. Skipping it is correct because `world` must already
/// hold post-edit bytes when this runs, so the eventual on-demand scan re-derives it from truth.
pub struct LampDeltaBatch<'a> {
    st: std::sync::MutexGuard<'a, LampIndexState>,
}

impl LampDeltaBatch<'_> {
    /// A sparse delta: `(chunk_relative_offset, previous_byte)` pairs.
    pub fn sparse(&mut self, world: &impl VoxelView, cx: i32, cy: i32, pairs: &[(u32, u8)]) {
        let key = (cx, cy);
        if !self.st.scanned.contains(&key) { return; }
        let Some(chunk) = world.chunk_bytes(cx, cy) else { return };
        let (base_x, base_y) = chunk_base(world, cx, cy);
        let index = &mut self.st.lamps;
        for &(off, prev) in pairs {
            let off = off as usize;
            // Paint bytes can't hold a block type, so they can't create or destroy a lamp.
            if off % 8192 >= 4096 { continue; }
            if off >= chunk.len() { continue; }
            visit(index, key, base_x, base_y, off, prev, chunk[off]);
        }
    }

    /// A dense delta: `pre` is the pre-edit bytes starting at chunk-relative `start_off`.
    ///
    /// Walks the *block* half of each band the span covers as a pair of slices, so the paint halves
    /// are skipped as whole ranges (not re-tested per byte) and the pre/post comparison stays a
    /// straight zip with no per-byte bounds check.
    pub fn dense(&mut self, world: &impl VoxelView, cx: i32, cy: i32, start_off: u32, pre: &[u8]) {
        let key = (cx, cy);
        if !self.st.scanned.contains(&key) { return; }
        let Some(chunk) = world.chunk_bytes(cx, cy) else { return };
        let (base_x, base_y) = chunk_base(world, cx, cy);
        let index = &mut self.st.lamps;
        let start = start_off as usize;
        let end = (start + pre.len()).min(chunk.len());
        let mut band = start / 8192;
        while band * 8192 < end {
            let lo = (band * 8192).max(start);
            let hi = (band * 8192 + 4096).min(end);
            band += 1;
            if hi <= lo { continue; }
            let before = &pre[lo - start..hi - start];
            let after = &chunk[lo..hi];
            for (j, (&p, &q)) in before.iter().zip(after).enumerate() {
                if p != q { visit(index, key, base_x, base_y, lo + j, p, q); }
            }
        }
    }
}

/// One changed byte. Only a transition into or out of `LAMP_BLOCK_TYPE` moves the index.
#[inline]
fn visit(
    index: &mut LampMap, key: (i32, i32), base_x: i32, base_y: i32,
    off: usize, prev: u8, now: u8,
) {
    let is_lamp = now == LAMP_BLOCK_TYPE;
    if (prev == LAMP_BLOCK_TYPE) == is_lamp { return; }
    let Some((lx, ly, z)) = decode_block_offset(off) else { return };
    let pos = [base_x + lx as i32, base_y + ly as i32, z as i32];
    if is_lamp {
        index.entry(key).or_default().insert(pos);
    } else if let Some(bucket) = index.get_mut(&key) {
        bucket.remove(&pos);
        if bucket.is_empty() { index.remove(&key); }
    }
}

/// A chunk's world-local block-coordinate origin.
#[inline]
fn chunk_base(world: &impl VoxelView, cx: i32, cy: i32) -> (i32, i32) {
    let (min_x, min_y) = world.chunk_origin();
    ((cx - min_x) * 16, (cy - min_y) * 16)
}

/// The chunk box a region's lamp gather needs: chunks overlapping `[sx1..=sx2] × [sy1..=sy2]`
/// expanded by `ceil(radius/16)` chunks (plus a safety chunk). Shared by the scanning path
/// ([`LampIndex::lamps_in_region`]) and the pure gather below so they can't compute different
/// neighbourhoods.
pub fn region_chunk_box(
    world: &impl VoxelView, sx1: i32, sy1: i32, sx2: i32, sy2: i32, radius: f32,
) -> (i32, i32, i32, i32) {
    let r = radius.ceil() as i32;
    let cr = r.div_euclid(16) + 1;
    let (min_x, min_y) = world.chunk_origin();
    let cx_lo = sx1.div_euclid(16) + min_x - cr;
    let cx_hi = sx2.div_euclid(16) + min_x + cr;
    let cy_lo = sy1.div_euclid(16) + min_y - cr;
    let cy_hi = sy2.div_euclid(16) + min_y + cr;
    (cx_lo, cx_hi, cy_lo, cy_hi)
}

/// Gather lamp positions (local block coords) within reach of a pixel-space region — every lamp
/// that could light a voxel in `[sx1..=sx2] × [sy1..=sy2]` given `radius`. Collects from the chunks
/// overlapping the region expanded by `ceil(radius/16)` chunks, then filters to the exact expanded
/// box so the result matches the old inline voxel scan exactly (parity). Pure gather — the free
/// function tests key on, and what [`LampIndex::lamps_in_region`] delegates to once its on-demand
/// chunks are scanned.
pub fn lamps_in_region(
    index: &LampMap,
    world: &impl VoxelView,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    radius: f32,
) -> Vec<[i32; 3]> {
    let r = radius.ceil() as i32;
    let (cx_lo, cx_hi, cy_lo, cy_hi) = region_chunk_box(world, sx1, sy1, sx2, sy2, radius);
    let mut out = Vec::new();
    for cx in cx_lo..=cx_hi {
        for cy in cy_lo..=cy_hi {
            if let Some(v) = index.get(&(cx, cy)) {
                out.extend(v.iter().copied());
            }
        }
    }
    // Filter to the exact expanded xy box (z spans the full column for chunk geometry, so no z
    // filter is needed) — makes this a drop-in match for the old `(sx1-r ..= sx2+r)` voxel scan.
    out.retain(|p| p[0] >= sx1 - r && p[0] <= sx2 + r && p[1] >= sy1 - r && p[1] <= sy2 + r);
    out
}

/// The lamp gather `chunk_geometry`'s baked-night path wants: positions plus each lamp's own light
/// colour, resolved through the shared paint table (Lighting.mm `addlight` is passed
/// `colorTable[getColorc(x,z,y)]` — the lamp's paint index into the shared paint table, not a
/// dedicated lamp-colour table). O(nearby lamps), not an O((16+2r)³) voxel scan.
pub fn lamps_with_color(
    index: &LampIndex,
    world: &(impl VoxelView + Sync),
    meta: ViewMeta,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    radius: f32,
) -> Vec<([i32; 3], [f32; 3])> {
    index
        .lamps_in_region(world, sx1, sy1, sx2, sy2, radius)
        .into_iter()
        .map(|p| {
            let (_, paint) = get_block_at(world, p[0], p[1], p[2]);
            let rgb = block_color(LAMP_BLOCK_TYPE, paint, meta.sky);
            (p, [rgb[0] as f32 / 255.0, rgb[1] as f32 / 255.0, rgb[2] as f32 / 255.0])
        })
        .collect()
}

/// One lamp light for the experimental GPU night path (real `THREE.PointLight`s). Position is in
/// world-local block coords (voxel centre); the frontend maps Eden(x,y,z)→THREE(x,z,y). Colour is
/// the lamp's own paint, normalized 0..1.
#[derive(serde::Serialize)]
pub struct LampLight {
    pub x: f32, pub y: f32, pub z: f32,
    pub r: f32, pub g: f32, pub b: f32,
}

/// Server-side cap on [`lamps_near`] — the frontend pool is smaller still, but bounding here keeps
/// the IPC payload tiny even on a lamp-dense world.
const SERVER_CAP: usize = 64;

/// The lamp blocks within `radius` blocks of a point, nearest-first and capped, for the GPU night
/// path. Reads the index (built lazily), so this is O(nearby lamps) rather than a voxel scan.
pub fn lamps_near(
    index: &LampIndex,
    world: &(impl VoxelView + Sync),
    meta: ViewMeta,
    x: f32, y: f32, z: f32, radius: f32,
) -> Vec<LampLight> {
    let radius = radius.clamp(1.0, 512.0);
    let sx = x.floor() as i32;
    let sy = y.floor() as i32;
    let mut lamps: Vec<(f32, LampLight)> = index
        .lamps_in_region(world, sx, sy, sx, sy, radius)
        .into_iter()
        .filter_map(|p| {
            let dx = p[0] as f32 + 0.5 - x;
            let dy = p[1] as f32 + 0.5 - y;
            let dz = p[2] as f32 + 0.5 - z;
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 > radius * radius { return None; }
            let (_, paint) = get_block_at(world, p[0], p[1], p[2]);
            let rgb = block_color(LAMP_BLOCK_TYPE, paint, meta.sky);
            Some((d2, LampLight {
                x: p[0] as f32 + 0.5, y: p[1] as f32 + 0.5, z: p[2] as f32 + 0.5,
                r: rgb[0] as f32 / 255.0, g: rgb[1] as f32 / 255.0, b: rgb[2] as f32 / 255.0,
            }))
        })
        .collect();
    lamps.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    lamps.truncate(SERVER_CAP);
    lamps.into_iter().map(|(_, l)| l).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testworld::TestWorld;

    fn blk(lx: usize, ly: usize, z: i32) -> usize {
        (z / 16) as usize * 8192 + lx * 256 + ly * 16 + (z % 16) as usize
    }

    fn sorted(v: &FxHashSet<[i32; 3]>) -> Vec<[i32; 3]> {
        let mut out: Vec<_> = v.iter().copied().collect();
        out.sort();
        out
    }

    /// The batch is the app's undo delta expressed generically; a sparse and a dense description of
    /// the *same* edit must move the index identically.
    #[test]
    fn sparse_and_dense_deltas_agree() {
        let mut world = TestWorld::new(1, 1, 4);
        world.bytes[blk(4, 6, 5)] = LAMP_BLOCK_TYPE;

        let sparse_idx = LampIndex::default();
        sparse_idx.build_now(&world, &[(0, 0)]);
        let dense_idx = LampIndex::default();
        dense_idx.build_now(&world, &[(0, 0)]);
        assert_eq!(sorted(&sparse_idx.snapshot()[&(0, 0)]), vec![[4, 6, 5]]);

        // The edit: remove that lamp, add one elsewhere. `pre` is the pre-edit band 0.
        let pre: Vec<u8> = world.bytes[0..8192].to_vec();
        world.bytes[blk(4, 6, 5)] = 0;
        world.bytes[blk(1, 2, 3)] = LAMP_BLOCK_TYPE;

        sparse_idx.delta_batch().sparse(
            &world, 0, 0,
            &[(blk(4, 6, 5) as u32, LAMP_BLOCK_TYPE), (blk(1, 2, 3) as u32, 0)],
        );
        dense_idx.delta_batch().dense(&world, 0, 0, 0, &pre);

        assert_eq!(sorted(&sparse_idx.snapshot()[&(0, 0)]), vec![[1, 2, 3]]);
        assert_eq!(sparse_idx.snapshot()[&(0, 0)], dense_idx.snapshot()[&(0, 0)]);
    }

    /// §4's corruption guard: a delta into a chunk the index has never scanned must be dropped, not
    /// fabricated into a bucket claiming the chunk is fully known.
    #[test]
    fn delta_into_an_unscanned_chunk_is_dropped() {
        let mut world = TestWorld::new(1, 1, 4);
        world.bytes[blk(1, 2, 3)] = LAMP_BLOCK_TYPE;
        let index = LampIndex::default();
        index.delta_batch().sparse(&world, 0, 0, &[(blk(1, 2, 3) as u32, 0)]);
        assert!(index.snapshot().is_empty(), "unscanned chunk must not gain a bucket");
        // …and the next real query still finds the lamp, because it re-derives from the world.
        assert_eq!(index.lamps_in_region(&world, 0, 0, 15, 15, 1.0), vec![[1, 2, 3]]);
    }

    /// A paint byte holding 72 is colour 72, not a lamp.
    #[test]
    fn paint_bytes_never_become_lamps() {
        let mut world = TestWorld::new(1, 1, 4);
        let index = LampIndex::default();
        index.build_now(&world, &[(0, 0)]);
        world.bytes[blk(1, 2, 3) + 4096] = LAMP_BLOCK_TYPE;
        index.delta_batch().sparse(&world, 0, 0, &[((blk(1, 2, 3) + 4096) as u32, 0)]);
        assert!(index.snapshot().is_empty());
    }
}
