//! The overview raster (ROADMAP-EDIT 18.15, `TEST WORLDS/overview-raster-plan-2026-09-30.md`):
//! zoomed-out map tiles served from a small per-chunk summary instead of the world's pages.
//!
//! **The problem.** A zoomed-out tile at LOD `L` samples one column every `L` blocks, and every
//! sample walks that column down from the chunk's band ceiling. On a multi-GB 256z world a
//! fit-to-window view therefore pulls roughly every chunk's terrain pages into the process — and
//! after the Windows working-set trimmer drops them, the next zoom-out faults them straight back.
//!
//! **The raster.** For every chunk, the scan result ([`Sample`]) of the columns on a `G`-block grid
//! (`lx, ly ∈ {0, G, 2G, …}`), `G ∈ {2, 4, 8, 16}`. Tile origins and edit patches are aligned to the
//! LOD grid, so a LOD-`L` sample lands on that grid whenever `L` is a multiple of `G` — including
//! relief's neighbour samples at `px − L`. `G` is the finest granularity whose raster fits the
//! memory preset's byte budget, chosen when the raster is built.
//!
//! **Exactness, by construction.** A cell is filled only from `WorldRow::sample` — the very scan
//! the world render runs — at the moment a render first needs it, and any sample the raster can't
//! answer (off the `G` grid, no chunk) is passed straight to that same scan. So a raster render is
//! byte-identical to a world render as long as no cell outlives the bytes it was computed from.
//! That is the invalidation contract: `LoadedWorld::invalidate_derived` clears a chunk's cells
//! together with its `top_band_hint`, at the same two choke points (see `mark_dirty_chunks`).
//!
//! **What it stores is scan output, not colour.** The blend with the current colour tables and sky
//! still runs at render time, so a sky edit or colour-table change needs no invalidation. The
//! cutaway cap changes what a scan sees, so a capped render never uses the raster.

use crate::LoadedWorld;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use voxel_core::render::{Sample, SampleRow, SampleSource, WorldRow};

/// Bytes per stored cell: `top_bt, top_paint, under_bt, under_paint, top_z`.
const CELL_BYTES: usize = 5;

/// The granularities tried, finest first. 2 is the finest worth keeping (LOD 1 is the full
/// heightmap, and at scale ≥ 1 only a few hundred chunks are on screen anyway).
const GRANULARITIES: [u32; 4] = [2, 4, 8, 16];

/// Above this many grid cells the raster isn't built — the same guard as `TopBandHints::MAX_CELLS`
/// against a world whose two far-flung chunks declare a huge, empty grid.
const MAX_GRID_CELLS: usize = 4 << 20;

/// Slot-table sentinel for "no chunk at this grid cell".
const NO_SLOT: u32 = u32::MAX;

/// Default budget before the frontend's memory preset arrives (Balanced).
pub(crate) const DEFAULT_OVERVIEW_BUDGET: usize = 32 << 20;
pub(crate) const MIN_OVERVIEW_BUDGET: usize = 4 << 20;
pub(crate) const MAX_OVERVIEW_BUDGET: usize = 256 << 20;

/// `u64` words one chunk's cells occupy at granularity `g`.
fn words_per_chunk(g: u32) -> usize {
    let n = (16 / g) as usize;
    (n * n * CELL_BYTES).div_ceil(8)
}

/// Heap bytes a raster at granularity `g` costs: the slot table, one validity mask per chunk, and
/// the cells.
pub(crate) fn raster_bytes(g: u32, chunks: usize, grid_cells: usize) -> usize {
    grid_cells * 4 + chunks * 8 * (1 + words_per_chunk(g))
}

/// The finest granularity whose raster fits `budget`, or `None` when even `G = 16` doesn't.
pub(crate) fn choose_granularity(chunks: usize, grid_cells: usize, budget: usize) -> Option<u32> {
    GRANULARITIES.into_iter().find(|&g| raster_bytes(g, chunks, grid_cells) <= budget)
}

pub(crate) struct OverviewRaster {
    /// Granularity in blocks: cells sit at chunk-local `lx, ly ∈ {0, g, 2g, …}`.
    g: u32,
    /// Cells per chunk side, `16 / g`.
    n: u32,
    /// Words per chunk.
    wpc: usize,
    min_x: i32,
    min_y: i32,
    w: u32,
    h: u32,
    /// Grid index (`iy * w + ix`) → slot, `NO_SLOT` where the world has no chunk. Slots are
    /// assigned in grid order, which is what the persisted form relies on.
    slot: Box<[u32]>,
    /// Per slot: bit `ci` set ⇔ cell `ci` holds the scan of the current bytes. At most 64 cells
    /// per chunk (`g = 2`), so one word covers them all.
    valid: Box<[AtomicU64]>,
    /// Per slot: `wpc` words holding `n²` packed 5-byte cells, cell `ci` at byte `ci * 5`.
    /// A cell's bytes are zero until it is filled, so a writer can `fetch_or` them in — two rows
    /// filling the same cell OR in identical bytes, and different cells never share a byte.
    words: Box<[AtomicU64]>,
    /// Lifetime counters: samples served from the raster, and samples that had to scan the world
    /// (and filled a cell). For the `[PAGES]` line and the tests.
    hits: AtomicU64,
    misses: AtomicU64,
    /// Set when a cell is filled or dropped; cleared when a persisted snapshot is taken. What lets
    /// a close skip rewriting a `.vxr` that already says everything the raster knows.
    changed: AtomicBool,
}

impl OverviewRaster {
    /// Build an empty raster for `world` at the finest granularity `budget` allows. `None` when the
    /// world can't have one (too many bands for a `u8` `top_z`, a degenerate grid, or a budget too
    /// small for even `G = 16`).
    pub(crate) fn build(world: &LoadedWorld, budget: usize) -> Option<Self> {
        if world.num_bands > 16 { return None; }
        let (w, h) = (world.w_chunks, world.h_chunks);
        let grid = (w as usize).checked_mul(h as usize)?;
        if grid == 0 || grid > MAX_GRID_CELLS { return None; }
        let g = choose_granularity(world.chunk_map.len(), grid, budget)?;
        Some(Self::with_granularity(world, g))
    }

    /// Build at an explicit granularity — `build` after the budget choice, and the tests.
    pub(crate) fn with_granularity(world: &LoadedWorld, g: u32) -> Self {
        let (w, h, min_x, min_y) = (world.w_chunks, world.h_chunks, world.min_x, world.min_y);
        let mut slot = vec![NO_SLOT; w as usize * h as usize].into_boxed_slice();
        let mut present: Vec<usize> = world.chunk_map.keys()
            .filter_map(|&(cx, cy)| grid_index(min_x, min_y, w, h, cx, cy))
            .collect();
        present.sort_unstable();
        for (s, &i) in present.iter().enumerate() { slot[i] = s as u32; }
        let wpc = words_per_chunk(g);
        OverviewRaster {
            g, n: 16 / g, wpc, min_x, min_y, w, h, slot,
            valid: (0..present.len()).map(|_| AtomicU64::new(0)).collect(),
            words: (0..present.len() * wpc).map(|_| AtomicU64::new(0)).collect(),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            changed: AtomicBool::new(false),
        }
    }

    #[inline]
    pub(crate) fn granularity(&self) -> u32 { self.g }

    /// Heap bytes held (what `raster_bytes` predicted).
    pub(crate) fn heap_bytes(&self) -> usize {
        self.slot.len() * 4 + self.valid.len() * 8 + self.words.len() * 8
    }

    /// `(served, scanned)` sample counts since the raster was built.
    pub(crate) fn counters(&self) -> (u64, u64) {
        (self.hits.load(Ordering::Relaxed), self.misses.load(Ordering::Relaxed))
    }

    /// Can a render at `lod` be served by this raster? Every LOD-`lod` sample of an aligned render
    /// lands on the `g` grid iff `lod` is a multiple of `g`.
    #[inline]
    pub(crate) fn serves(&self, lod: u32) -> bool {
        let lod = lod.clamp(1, voxel_core::render::MAX_LOD);
        lod >= self.g && lod % self.g == 0
    }

    #[inline]
    fn slot_of(&self, cx: i32, cy: i32) -> Option<usize> {
        let i = grid_index(self.min_x, self.min_y, self.w, self.h, cx, cy)?;
        match self.slot[i] { NO_SLOT => None, s => Some(s as usize) }
    }

    /// Drop every cell of chunk `(cx, cy)`. Called with the world's write access held (edits run on
    /// a `take()`n world or under the write guard), so no render can be reading or filling it.
    pub(crate) fn invalidate(&self, cx: i32, cy: i32) {
        let Some(s) = self.slot_of(cx, cy) else { return };
        if self.valid[s].swap(0, Ordering::Relaxed) == 0 { return; } // nothing was filled
        self.mark_changed();
        for word in &self.words[s * self.wpc..(s + 1) * self.wpc] { word.store(0, Ordering::Relaxed); }
    }

    /// How many of chunk `(cx, cy)`'s cells are filled. Test helper.
    #[cfg(test)]
    pub(crate) fn filled_cells(&self, cx: i32, cy: i32) -> u32 {
        self.slot_of(cx, cy).map_or(0, |s| self.valid[s].load(Ordering::Relaxed).count_ones())
    }

    #[inline]
    fn get(&self, s: usize, ci: usize) -> Option<Sample> {
        if self.valid[s].load(Ordering::Acquire) >> ci & 1 == 0 { return None; }
        let base = s * self.wpc;
        let b = ci * CELL_BYTES;
        let (w0, sh) = (b / 8, (b % 8) * 8);
        // The cell's 5 bytes span at most two words; read both into one 128-bit lane.
        let lo = self.words[base + w0].load(Ordering::Relaxed) as u128;
        let hi = if sh > 24 { self.words[base + w0 + 1].load(Ordering::Relaxed) as u128 } else { 0 };
        let v = ((hi << 64) | lo) >> sh;
        let byte = |k: u32| (v >> (8 * k)) as u8;
        let top_bt = byte(0);
        Some((top_bt, byte(1), byte(2), byte(3), if top_bt == 0 { -1 } else { byte(4) as i32 }))
    }

    #[inline]
    fn put(&self, s: usize, ci: usize, (top_bt, top_paint, under_bt, under_paint, top_z): Sample) {
        let base = s * self.wpc;
        let b = ci * CELL_BYTES;
        let (w0, sh) = (b / 8, (b % 8) * 8);
        // `top_z` fits a u8: `num_bands ≤ 16` (checked in `build`), and it is −1 only when
        // `top_bt == 0`, which `get` restores.
        let cell = u64::from_le_bytes([top_bt, top_paint, under_bt, under_paint, top_z.max(0) as u8, 0, 0, 0]) as u128;
        let v = cell << sh;
        self.words[base + w0].fetch_or(v as u64, Ordering::Relaxed);
        if sh > 24 { self.words[base + w0 + 1].fetch_or((v >> 64) as u64, Ordering::Relaxed); }
        // Release: a reader that sees the bit (Acquire) sees the bytes.
        self.valid[s].fetch_or(1 << ci, Ordering::Release);
        self.mark_changed();
    }

    /// Load first so the rayon rows filling cells don't all keep writing one shared cache line.
    #[inline]
    fn mark_changed(&self) {
        if !self.changed.load(Ordering::Relaxed) { self.changed.store(true, Ordering::Relaxed); }
    }
}

#[inline]
fn grid_index(min_x: i32, min_y: i32, w: u32, h: u32, cx: i32, cy: i32) -> Option<usize> {
    let ix = cx.checked_sub(min_x)?;
    let iy = cy.checked_sub(min_y)?;
    if ix < 0 || iy < 0 || ix as u32 >= w || iy as u32 >= h { return None; }
    Some(iy as usize * w as usize + ix as usize)
}

/// The raster as a [`SampleSource`]: cells it holds are served without touching the world; the
/// rest go through the world's own scan (and fill a cell when they land on the grid).
pub(crate) struct RasterSource<'a> {
    raster: &'a OverviewRaster,
    world: &'a LoadedWorld,
}

impl<'a> RasterSource<'a> {
    pub(crate) fn new(raster: &'a OverviewRaster, world: &'a LoadedWorld) -> Self {
        RasterSource { raster, world }
    }
}

impl SampleSource for RasterSource<'_> {
    type Row<'r> = RasterRow<'r> where Self: 'r;
    fn row(&self, py: u32) -> RasterRow<'_> {
        let r = self.raster;
        let ly = py % 16;
        RasterRow {
            raster: r,
            // No cap: a capped render never reaches the raster (`render_pixels_patch_styled`).
            world: WorldRow::new(self.world, py, None),
            min_x: self.world.min_x,
            cy: (py / 16) as i32 + self.world.min_y,
            cell_row: (ly % r.g == 0).then_some(ly / r.g),
            last_cx: i32::MIN,
            slot: None,
            hits: 0,
            misses: 0,
        }
    }
}

pub(crate) struct RasterRow<'a> {
    raster: &'a OverviewRaster,
    /// The ground truth — used for every sample the raster can't answer, and to fill cells.
    world: WorldRow<'a, LoadedWorld>,
    min_x: i32,
    cy: i32,
    /// `ly / g` when this row lies on the grid, else `None` (every sample then scans).
    cell_row: Option<u32>,
    last_cx: i32,
    slot: Option<usize>,
    hits: u64,
    misses: u64,
}

impl SampleRow for RasterRow<'_> {
    #[inline]
    fn sample(&mut self, px: u32) -> Sample {
        let r = self.raster;
        let lx = px % 16;
        let Some(cr) = self.cell_row else { return self.world.sample(px) };
        if lx % r.g != 0 { return self.world.sample(px); }
        let cx = (px / 16) as i32 + self.min_x;
        if cx != self.last_cx {
            self.last_cx = cx;
            self.slot = r.slot_of(cx, self.cy);
        }
        // No chunk here: the world scan answers an empty sample after one hash probe (memoised per
        // chunk), and touches no page.
        let Some(s) = self.slot else { return self.world.sample(px) };
        let ci = (cr * r.n + lx / r.g) as usize;
        if let Some(v) = r.get(s, ci) {
            self.hits += 1;
            return v;
        }
        let v = self.world.sample(px);
        r.put(s, ci, v);
        self.misses += 1;
        v
    }
}

impl Drop for RasterRow<'_> {
    fn drop(&mut self) {
        if self.hits > 0 { self.raster.hits.fetch_add(self.hits, Ordering::Relaxed); }
        if self.misses > 0 { self.raster.misses.fetch_add(self.misses, Ordering::Relaxed); }
    }
}

// ── Persistence (18.15 phase 2) ──────────────────────────────────────────────────────────────
//
// A relaunch of an unchanged world should never re-read its pages just to draw the fit view. The
// raster is saved to `<app_data>/overview/<fnv(canonical path)>.vxr` whenever it provably describes
// the file on disk — after a save (seq-gated, nothing dirty), or on close/world switch when nothing
// is dirty and the file is still the one we last loaded or wrote — and preloaded by `load_world`
// when every key field still matches. A mismatched, corrupt or truncated file is deleted and never
// fails a load; it is a cache.
//
// Layout (little-endian):
//   "VXR1" · format u32 · len u64 · mtime_ns u64 · file_id (u64, u64)
//   num_bands u32 · min_x i32 · min_y i32 · w u32 · h u32 · chunks u32 · g u32
//   path_len u32 · path bytes (the source, for the startup sweep)
//   payload_len u64 · crc32(payload) u32 · payload = deflate(entries)
//   entries: count u32, then per filled chunk: slot u32 · valid mask u64 · wpc × word u64

use crate::FileIdentity;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAGIC: &[u8; 4] = b"VXR1";
/// ⚠️ Bump on **any** change to what a cell means — `voxel_core::render`'s column scan semantics,
/// the cell layout here, or slot assignment. A stale format would render the old meaning silently.
const FORMAT: u32 = 1;
/// The whole store is kept under this (oldest `.vxr` by mtime evicted first).
const STORE_CAP_BYTES: u64 = 256 << 20;

static STORE_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Serialises writers, so two quick saves can't interleave their temp+rename of the same entry.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Set the store directory once at startup and sweep it in the background: entries whose source
/// file is gone, leftover temps, and anything over the size cap.
pub(crate) fn init_store(dir: PathBuf) {
    if STORE_DIR.set(dir.clone()).is_ok() {
        std::thread::spawn(move || sweep_store(&dir));
    }
}

pub(crate) fn store_dir() -> Option<&'static Path> { STORE_DIR.get().map(PathBuf::as_path) }

/// FNV-1a 64 — stable across builds and platforms, unlike `std`'s hasher, so an entry's name
/// survives an app update.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3))
}

fn entry_path(dir: &Path, source: &Path) -> PathBuf {
    let canon = std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    dir.join(format!("{:016x}.vxr", fnv1a(canon.to_string_lossy().as_bytes())))
}

/// Everything that must match for a stored raster to describe this world: the file (identity) and
/// the raster's shape (grid, chunk count, granularity).
#[derive(Debug, PartialEq, Eq)]
struct Key {
    len: u64,
    mtime_ns: u64,
    file_id: (u64, u64),
    num_bands: u32,
    min_x: i32,
    min_y: i32,
    w: u32,
    h: u32,
    chunks: u32,
    g: u32,
}

impl Key {
    fn of(world: &LoadedWorld, r: &OverviewRaster, id: &FileIdentity) -> Self {
        Key {
            len: id.len, mtime_ns: id.mtime_ns, file_id: id.file_id,
            num_bands: world.num_bands as u32,
            min_x: r.min_x, min_y: r.min_y, w: r.w, h: r.h,
            chunks: r.valid.len() as u32, g: r.g,
        }
    }
}

/// A raster copied out of the world (under whatever guard the caller holds), ready to be deflated
/// and written with no guard held.
pub(crate) struct PersistJob {
    key: Key,
    source: PathBuf,
    /// The raw (pre-deflate) entries section.
    raw: Vec<u8>,
}

impl PersistJob {
    /// Copy out every filled chunk. `None` when nothing is filled, or — unless `force` — when
    /// nothing changed since the last snapshot (a close after a save, or after a preload nothing
    /// added to). A save passes `force`: the file's identity changed, so the old entry is stale.
    pub(crate) fn capture(world: &LoadedWorld, id: &FileIdentity, force: bool) -> Option<Self> {
        let r = world.overview()?;
        if !r.changed.swap(false, Ordering::Relaxed) && !force { return None; }
        let mut raw = Vec::with_capacity(4 + 64 * 1024);
        raw.extend_from_slice(&0u32.to_le_bytes());
        let mut count = 0u32;
        for (s, v) in r.valid.iter().enumerate() {
            let m = v.load(Ordering::Acquire);
            if m == 0 { continue; }
            raw.extend_from_slice(&(s as u32).to_le_bytes());
            raw.extend_from_slice(&m.to_le_bytes());
            for w in &r.words[s * r.wpc..(s + 1) * r.wpc] {
                raw.extend_from_slice(&w.load(Ordering::Relaxed).to_le_bytes());
            }
            count += 1;
        }
        if count == 0 { return None; }
        raw[..4].copy_from_slice(&count.to_le_bytes());
        Some(PersistJob { key: Key::of(world, r, id), source: id.path.clone(), raw })
    }

    /// Deflate and write (temp + rename), then trim the store to its cap. Best effort.
    pub(crate) fn write(self, dir: &Path) -> Result<PathBuf, String> {
        let mut enc = flate2::write::DeflateEncoder::new(Vec::with_capacity(self.raw.len() / 4), flate2::Compression::fast());
        enc.write_all(&self.raw).map_err(|e| e.to_string())?;
        let payload = enc.finish().map_err(|e| e.to_string())?;
        let k = &self.key;
        let path_bytes = self.source.to_string_lossy().into_owned().into_bytes();
        let mut out = Vec::with_capacity(payload.len() + 128 + path_bytes.len());
        out.extend_from_slice(MAGIC);
        for v in [FORMAT] { out.extend_from_slice(&v.to_le_bytes()); }
        for v in [k.len, k.mtime_ns, k.file_id.0, k.file_id.1] { out.extend_from_slice(&v.to_le_bytes()); }
        out.extend_from_slice(&k.num_bands.to_le_bytes());
        out.extend_from_slice(&k.min_x.to_le_bytes());
        out.extend_from_slice(&k.min_y.to_le_bytes());
        for v in [k.w, k.h, k.chunks, k.g, path_bytes.len() as u32] { out.extend_from_slice(&v.to_le_bytes()); }
        out.extend_from_slice(&path_bytes);
        out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        out.extend_from_slice(&crc32fast::hash(&payload).to_le_bytes());
        out.extend_from_slice(&payload);

        let _g = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let dest = entry_path(dir, &self.source);
        let tmp = dest.with_extension("vxr.tmp");
        std::fs::write(&tmp, &out).and_then(|_| std::fs::rename(&tmp, &dest)).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
        crate::timing_log!("[OVERVIEW] persisted {} B for {:?}", out.len(), self.source);
        trim_store(dir, STORE_CAP_BYTES);
        Ok(dest)
    }

    /// `write` on a background thread (production); the tests call `write` directly.
    pub(crate) fn spawn_write(self, dir: &'static Path) {
        std::thread::spawn(move || {
            if let Err(e) = self.write(dir) { crate::timing_log!("[OVERVIEW] persist failed: {e}"); }
        });
    }
}

/// A parsed `.vxr` header.
struct Header {
    key: Key,
    source: PathBuf,
    payload_len: u64,
    crc: u32,
}

fn read_header(r: &mut impl Read) -> Option<Header> {
    fn u32_(r: &mut impl Read) -> Option<u32> { let mut b = [0; 4]; r.read_exact(&mut b).ok()?; Some(u32::from_le_bytes(b)) }
    fn u64_(r: &mut impl Read) -> Option<u64> { let mut b = [0; 8]; r.read_exact(&mut b).ok()?; Some(u64::from_le_bytes(b)) }
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).ok()?;
    if &magic != MAGIC || u32_(r)? != FORMAT { return None; }
    let (len, mtime_ns, f0, f1) = (u64_(r)?, u64_(r)?, u64_(r)?, u64_(r)?);
    let num_bands = u32_(r)?;
    let (min_x, min_y) = (u32_(r)? as i32, u32_(r)? as i32);
    let (w, h, chunks, g, path_len) = (u32_(r)?, u32_(r)?, u32_(r)?, u32_(r)?, u32_(r)?);
    if path_len > 64 * 1024 { return None; }
    let mut p = vec![0u8; path_len as usize];
    r.read_exact(&mut p).ok()?;
    let (payload_len, crc) = (u64_(r)?, u32_(r)?);
    Some(Header {
        key: Key { len, mtime_ns, file_id: (f0, f1), num_bands, min_x, min_y, w, h, chunks, g },
        source: PathBuf::from(String::from_utf8(p).ok()?),
        payload_len, crc,
    })
}

/// The preload in `load_world`: build `world`'s raster at the granularity `budget` picks and fill it
/// from the stored entry, if that entry describes exactly this file. `None` (and the entry deleted,
/// if there was one) on any mismatch or damage — the raster is then built lazily as usual.
pub(crate) fn preload(world: &LoadedWorld, id: &FileIdentity, budget: usize, dir: &Path) -> Option<OverviewRaster> {
    let path = entry_path(dir, &id.path);
    let file = std::fs::File::open(&path).ok()?;
    let loaded = (|| {
        let r = OverviewRaster::build(world, budget)?;
        let mut rd = std::io::BufReader::new(file);
        let h = read_header(&mut rd)?;
        if h.key != Key::of(world, &r, id) { return None; }
        // At most every chunk filled: bounds both the read and the inflate.
        let entry = 4 + 8 + r.wpc * 8;
        let max_raw = 4 + r.valid.len() * entry;
        if h.payload_len > max_raw as u64 + 1024 { return None; }
        let mut payload = vec![0u8; h.payload_len as usize];
        rd.read_exact(&mut payload).ok()?;
        if crc32fast::hash(&payload) != h.crc { return None; }
        let mut raw = Vec::new();
        flate2::read::DeflateDecoder::new(&payload[..]).take(max_raw as u64 + 1).read_to_end(&mut raw).ok()?;
        if raw.len() < 4 { return None; }
        let count = u32::from_le_bytes(raw[..4].try_into().ok()?) as usize;
        if raw.len() != 4 + count * entry { return None; }
        let cells = (r.n * r.n) as usize;
        let all = if cells == 64 { u64::MAX } else { (1u64 << cells) - 1 };
        let mut last: Option<usize> = None;
        let mut bytes = vec![0u8; r.wpc * 8];
        for e in raw[4..].chunks_exact(entry) {
            let s = u32::from_le_bytes(e[..4].try_into().ok()?) as usize;
            let mask = u64::from_le_bytes(e[4..12].try_into().ok()?);
            if s >= r.valid.len() || last.is_some_and(|l| s <= l) || mask == 0 || mask & !all != 0 { return None; }
            last = Some(s);
            // Keep only the filled cells' bytes: an unfilled cell must read as zero, or a later
            // `put` would OR its scan into leftover bytes.
            bytes.fill(0);
            for ci in (0..cells).filter(|ci| mask >> ci & 1 == 1) {
                let b = 12 + ci * CELL_BYTES;
                bytes[ci * CELL_BYTES..(ci + 1) * CELL_BYTES].copy_from_slice(&e[b..b + CELL_BYTES]);
            }
            for (k, dst) in r.words[s * r.wpc..(s + 1) * r.wpc].iter().enumerate() {
                dst.store(u64::from_le_bytes(bytes[k * 8..k * 8 + 8].try_into().ok()?), Ordering::Relaxed);
            }
            r.valid[s].store(mask, Ordering::Release);
        }
        Some((r, count))
    })();
    match loaded {
        Some((r, count)) => {
            crate::timing_log!("[OVERVIEW] preloaded {count} chunks at g={} from {:?}", r.g, path);
            Some(r)
        }
        None => {
            crate::timing_log!("[OVERVIEW] ignoring stale or damaged {:?}", path);
            let _ = std::fs::remove_file(&path);
            None
        }
    }
}

/// Drop entries whose source file no longer exists, unreadable entries and leftover temps, then
/// trim to the cap. Runs once, in the background, at startup.
fn sweep_store(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        match p.extension().and_then(|x| x.to_str()) {
            Some("tmp") => { let _ = std::fs::remove_file(&p); }
            Some("vxr") => {
                let keep = std::fs::File::open(&p).ok()
                    .and_then(|f| read_header(&mut std::io::BufReader::new(f)))
                    .is_some_and(|h| h.source.exists());
                if !keep { let _ = std::fs::remove_file(&p); }
            }
            _ => {}
        }
    }
    trim_store(dir, STORE_CAP_BYTES);
}

/// Evict the least recently written `.vxr` entries until the store fits `cap` bytes.
fn trim_store(dir: &Path, cap: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "vxr"))
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            Some((md.modified().unwrap_or(std::time::UNIX_EPOCH), md.len(), e.path()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    let mut total = 0u64;
    for (_, len, p) in files {
        total += len;
        if total > cap { let _ = std::fs::remove_file(&p); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::ws_with;
    use crate::{
        parse_world_inner, render_pixels_patch_styled, with_edit, undo_edit_inner, redo_edit_inner,
        paste_clipboard_at, sculpt_terrain_inner, WorldState, AppState, DiskImage, FileIdentity,
        read_ws, save_world_progress, record_full_write, overview_job_after_save,
        overview_persist_candidate,
    };
    use memmap2::MmapMut;
    use std::sync::OnceLock;
    use voxel_core::render::{self, MapStyle};
    use voxel_core::view::set_block_abs;

    const HEADER: usize = 4096;

    /// A `w × h`-chunk world of `chunk_size` chunks with `missing` left out of the directory, all air.
    fn grid_bytes(w: i32, h: i32, chunk_size: usize, version: i32, missing: &[(i32, i32)]) -> Vec<u8> {
        let coords: Vec<(i32, i32)> = (0..h).flat_map(|cy| (0..w).map(move |cx| (cx, cy)))
            .filter(|c| !missing.contains(c)).collect();
        let dir_off = HEADER + coords.len() * chunk_size;
        let mut b = vec![0u8; dir_off + coords.len() * 16];
        b[32..40].copy_from_slice(&(dir_off as u64).to_le_bytes());
        b[40..48].copy_from_slice(b"Overview");
        b[92..96].copy_from_slice(&version.to_le_bytes());
        for (i, &(cx, cy)) in coords.iter().enumerate() {
            let e = dir_off + i * 16;
            b[e..e + 4].copy_from_slice(&cx.to_le_bytes());
            b[e + 4..e + 8].copy_from_slice(&cy.to_le_bytes());
            b[e + 8..e + 16].copy_from_slice(&((HEADER + i * chunk_size) as u64).to_le_bytes());
        }
        b
    }

    fn hash(x: i32, y: i32, salt: u32) -> u32 {
        let mut v = (x as u32).wrapping_mul(0x9E37_79B1) ^ (y as u32).wrapping_mul(0x85EB_CA77) ^ salt;
        v ^= v >> 15; v = v.wrapping_mul(0x2C1B_3C6D); v ^= v >> 12; v = v.wrapping_mul(0x297A_2D39); v ^ (v >> 15)
    }

    /// Varied terrain through the real writer: empty columns, overhangs over an air gap, and
    /// translucent tops (water, glass, flower, fence) so the `under` half of a sample matters.
    fn paint_terrain(world: &mut LoadedWorld, salt: u32) {
        let max_z = world.num_bands as i32 * 16 - 1;
        let (bw, bh) = (world.w_chunks as i32 * 16, world.h_chunks as i32 * 16);
        for x in 0..bw { for y in 0..bh {
            let r = hash(x, y, salt);
            if r % 13 == 0 { continue; }
            let h = 1 + ((x / 3 + y / 5) as u32 * 7 + r % 9) as i32 % (max_z - 12);
            for z in 0..=h { set_block_abs(world, x, y, z, 1 + (r >> 4) as u8 % 8, (r >> 8) as u8 % 5); }
            let top = match r % 7 { 0 => Some(20), 1 => Some(58), 2 => Some(73), 3 => Some(21), _ => None };
            if let Some(t) = top { set_block_abs(world, x, y, h + 1, t, (r >> 12) as u8 % 4); }
            if r % 9 == 0 { set_block_abs(world, x, y, (h + 6).min(max_z), 3, 1); }
        }}
    }

    fn world_from(bytes: Vec<u8>, salt: u32) -> LoadedWorld {
        let mut m = MmapMut::map_anon(bytes.len()).expect("anon mmap");
        m.copy_from_slice(&bytes);
        let mut w = parse_world_inner(m).expect("parse");
        paint_terrain(&mut w, salt);
        w
    }

    fn install(w: &mut LoadedWorld, g: u32) {
        let r = OverviewRaster::with_granularity(w, g);
        w.overview = OnceLock::from(Some(r));
    }

    /// The ground truth: the world render, never the raster.
    fn truth(w: &LoadedWorld, (x1, y1, x2, y2): (i32, i32, i32, i32), style: MapStyle, lod: u32) -> render::Raster {
        render::pixels_patch_styled(w, w.meta(), x1, y1, x2, y2, style, lod)
    }

    fn assert_same(w: &LoadedWorld, rect: (i32, i32, i32, i32), style: MapStyle, lod: u32, what: &str) {
        let t = truth(w, rect, style, lod);
        let got = render_pixels_patch_styled(w, rect.0, rect.1, rect.2, rect.3, style, lod);
        assert_eq!((got.x, got.y, got.width, got.height, got.lod), (t.x, t.y, t.width, t.height, t.lod), "{what}: frame");
        assert!(got.pixels == t.pixels, "{what}: pixels differ");
    }

    fn rects(w: &LoadedWorld, lod: i32) -> Vec<(i32, i32, i32, i32)> {
        let (bw, bh) = (w.w_chunks as i32 * 16, w.h_chunks as i32 * 16);
        let mid = |v: i32| v / 2 / lod * lod;
        vec![
            (0, 0, bw - 1, bh - 1),                                  // the whole world (fit view)
            (-3 * lod, -3 * lod, 5 * lod, 5 * lod),                  // off the NW edge
            (mid(bw), mid(bh), bw + 100, bh + 100),                  // past the SE edge
            (mid(bw), 0, mid(bw) + 7 * lod, 9 * lod),                // an aligned interior tile
            (5, 3, bw - 2, bh - 7),                                  // unaligned: must fall back
            (bw - 1, bh - 1, bw - 1, bh - 1),                        // one corner sample
        ]
    }

    fn check_equivalence(w: &mut LoadedWorld, what: &str) {
        for g in GRANULARITIES {
            install(w, g);
            for lod in [1u32, 2, 3, 4, 6, 8, 16, 32] {
                for relief in [None, Some(60u8), Some(200)] {
                    let style = MapStyle { cap: None, relief };
                    for rect in rects(w, lod as i32) {
                        // Twice: the first pass fills cells from the world, the second serves them.
                        for pass in 0..2 {
                            assert_same(w, rect, style, lod, &format!("{what} g={g} lod={lod} relief={relief:?} rect={rect:?} pass={pass}"));
                        }
                    }
                }
            }
            let (hits, misses) = w.overview().unwrap().counters();
            assert!(misses > 0 && hits > 0, "{what} g={g}: the raster was actually filled ({misses}) and read ({hits})");
            assert_cells_match_world(w, what);
        }
    }

    /// Every filled cell equals the world scan of its column. Stronger than comparing renders: relief
    /// only reads height *differences*, so a uniformly wrong `top_z` would render identically.
    fn assert_cells_match_world(w: &LoadedWorld, what: &str) {
        let r = w.overview().unwrap();
        let mut checked = 0;
        for &(cx, cy) in w.chunk_map.keys() {
            let s = r.slot_of(cx, cy).expect("every chunk has a slot");
            for ci in 0..(r.n * r.n) as usize {
                let Some(cell) = r.get(s, ci) else { continue };
                let (lx, ly) = ((ci as u32 % r.n) * r.g, (ci as u32 / r.n) * r.g);
                let px = (cx - w.min_x) as u32 * 16 + lx;
                let py = (cy - w.min_y) as u32 * 16 + ly;
                assert_eq!(cell, WorldRow::new(w, py, None).sample(px), "{what}: cell ({px},{py}) g={}", r.g);
                checked += 1;
            }
        }
        assert!(checked > 0, "{what}: no filled cells to check");
    }

    /// 18.15 test 1 — the core guard: a raster render is byte-identical to the world render, for
    /// every granularity × LOD (on and off its grid) × relief strength × edge/interior/unaligned
    /// rect, on 64z and 256z worlds with a missing chunk, and on a short-span chunk.
    #[test]
    fn test_overview_raster_matches_the_world_render() {
        let mut w64 = world_from(grid_bytes(5, 4, 32768, 0, &[(2, 1)]), 1);
        assert_eq!(w64.num_bands, 4);
        check_equivalence(&mut w64, "64z");

        let mut w256 = world_from(grid_bytes(4, 3, 131072, 5, &[(1, 2)]), 2);
        assert_eq!(w256.num_bands, 16);
        check_equivalence(&mut w256, "256z");

        // Short span: chunk (0,0) owns only 107 072 B, so its top bands belong to (1,0).
        let mut short = grid_bytes(2, 1, 131072, 5, &[]);
        let dir_off = HEADER + 2 * 131072;
        short[dir_off + 16 + 8..dir_off + 16 + 16].copy_from_slice(&((HEADER + 107_072) as u64).to_le_bytes());
        let mut ws = world_from(short, 3);
        assert_eq!(ws.span_of(0, 0), 107_072);
        check_equivalence(&mut ws, "short span");
    }

    /// Test 5 — a capped render never reads the raster (it would show the uncapped surface).
    #[test]
    fn test_overview_raster_is_bypassed_by_the_cutaway_cap() {
        let mut w = world_from(grid_bytes(3, 3, 32768, 0, &[]), 4);
        install(&mut w, 2);
        let rect = (0, 0, 47, 47);
        let capped = MapStyle { cap: Some(20), relief: None };
        assert_same(&w, rect, capped, 2, "capped");
        assert_eq!(w.overview().unwrap().counters(), (0, 0), "a capped render must not touch the raster");
        // LOD below the granularity: the world path, raster untouched.
        install(&mut w, 4);
        assert_same(&w, rect, MapStyle::default(), 2, "lod < g");
        assert_eq!(w.overview().unwrap().counters(), (0, 0), "lod < g must not touch the raster");
    }

    /// Test 4 — adaptive `G` picks the finest granularity under the budget; the plan's worked
    /// numbers, and `heap_bytes` agrees with the prediction.
    #[test]
    fn test_overview_granularity_follows_the_budget() {
        const MB: usize = 1 << 20;
        assert_eq!(choose_granularity(26_000, 26_400, 32 * MB), Some(2), "(W) field world");
        assert_eq!(choose_granularity(26_000, 26_400, 16 * MB), Some(2));
        assert_eq!(choose_granularity(90_000, 90_000, 32 * MB), Some(2), "90 k chunks, Balanced");
        assert_eq!(choose_granularity(90_000, 90_000, 16 * MB), Some(4), "90 k chunks, Low");
        assert_eq!(choose_granularity(238_000, 238_128, 32 * MB), Some(4), "the largest grid seen");
        assert_eq!(choose_granularity(238_000, 238_128, 64 * MB), Some(4));
        assert_eq!(choose_granularity(1_000, 1_000, 1_000), None, "nothing fits");
        // Right at a threshold: exactly the G=2 size fits, one byte less falls to G=4.
        let exact = raster_bytes(2, 1234, 1500);
        assert_eq!(choose_granularity(1234, 1500, exact), Some(2));
        assert_eq!(choose_granularity(1234, 1500, exact - 1), Some(4));

        let w = world_from(grid_bytes(5, 4, 32768, 0, &[(2, 1)]), 5);
        for g in GRANULARITIES {
            let r = OverviewRaster::with_granularity(&w, g);
            assert_eq!(r.heap_bytes(), raster_bytes(g, 19, 20), "g={g}");
        }
        let built = OverviewRaster::build(&w, raster_bytes(4, 19, 20)).expect("fits at g=4");
        assert_eq!(built.granularity(), 4);
    }

    /// A world render of `rect` at `lod` must equal what the (raster-backed) app render gives.
    fn assert_ws_matches(ws: &WorldState, lod: u32, what: &str) {
        let w = ws.world.as_ref().unwrap();
        let (bw, bh) = (w.w_chunks as i32 * 16, w.h_chunks as i32 * 16);
        assert_same(w, (0, 0, bw - 1, bh - 1), ws.map_style(), lod, what);
    }

    /// The edit's own patch (rendered at `view_lod` through the raster) matches a world render.
    fn assert_patch_fresh(ws: &WorldState, r: &crate::EditResult, what: &str) {
        assert!(!r.invalidate, "{what}: small patch expected");
        let p = &r.patch;
        let w = ws.world.as_ref().unwrap();
        let x2 = p.x as i32 + (p.width as i32 - 1) * p.lod as i32;
        let y2 = p.y as i32 + (p.height as i32 - 1) * p.lod as i32;
        let t = truth(w, (p.x as i32, p.y as i32, x2, y2), ws.map_style(), p.lod);
        assert!(t.pixels == p.pixels, "{what}: the edit patch was drawn from stale cells");
    }

    /// Test 2 — invalidation. Fill the raster, then change column tops through every edit path
    /// (an edit, undo, redo, a sculpt, a paste, and a rolled-back failed edit); after each, both the
    /// edit's own patch and a full re-render must equal a world render.
    #[test]
    fn test_overview_raster_follows_every_edit_path() {
        for relief in [None, Some(100u8)] {
            let mut ws = ws_with(crate::tests::make_bumpy_world_grid(3, 8, |x, y| 20 + (x + y) % 9));
            ws.view_lod = 2;
            ws.view_relief = relief;
            { let w = ws.world.as_mut().unwrap(); install(w, 2); }
            assert_ws_matches(&ws, 2, "fill");
            assert_ws_matches(&ws, 4, "fill lod 4");
            let tag = |s: &str| format!("{s} (relief {relief:?})");

            // Raise one on-grid column two bands, and put a translucent top on another.
            let r = with_edit(&mut ws, "paint", (4, 6, 5, 6), |w| {
                set_block_abs(w, 4, 6, 50, 8, 0);
                set_block_abs(w, 5, 6, 40, 20, 0);
                Ok(())
            }).expect("edit");
            assert_patch_fresh(&ws, &r, &tag("edit"));
            assert_ws_matches(&ws, 2, &tag("after edit"));
            assert_ws_matches(&ws, 4, &tag("after edit lod 4"));

            let r = undo_edit_inner(&mut ws).expect("undo");
            assert_patch_fresh(&ws, &r, &tag("undo"));
            assert_ws_matches(&ws, 2, &tag("after undo"));

            let r = redo_edit_inner(&mut ws).expect("redo");
            assert_patch_fresh(&ws, &r, &tag("redo"));
            assert_ws_matches(&ws, 2, &tag("after redo"));

            let r = sculpt_terrain_inner(
                &mut ws, None, "raise".into(), 6, 0, None, None, None, None,
                Some(0.3), Some("smooth".into()), None, None, None, Some(24), Some(24), Some(6), None, None,
                None, None, None, None, None, None, None,
            ).expect("sculpt");
            assert_patch_fresh(&ws, &r, &tag("sculpt"));
            assert_ws_matches(&ws, 2, &tag("after sculpt"));

            let (cw, ch, cd) = (5, 4, 3);
            let cbt = vec![58u8; (cw * ch * cd) as usize];
            let cpt = vec![2u8; (cw * ch * cd) as usize];
            let r = with_edit(&mut ws, "paste", (30, 10, 34, 13), |w| {
                paste_clipboard_at(w, 30, 10, &cbt, &cpt, cw, ch, cd, 45, 0, false, 63, None);
                Ok(())
            }).expect("paste");
            assert_patch_fresh(&ws, &r, &tag("paste"));
            assert_ws_matches(&ws, 2, &tag("after paste"));

            // A failed edit rolls back — the cells it may have made stale must go too. Render
            // between the write and the rollback isn't possible (the world is taken), so what this
            // pins is that the rollback leaves the raster agreeing with the restored bytes.
            assert_ws_matches(&ws, 2, &tag("before rollback"));
            let e = with_edit(&mut ws, "fail", (8, 8, 8, 8), |w| {
                set_block_abs(w, 8, 8, 60, 8, 0);
                Err("nope".into())
            });
            assert!(e.is_err());
            assert_ws_matches(&ws, 2, &tag("after rollback"));
        }
    }

    /// Test 3 — `invalidate_derived` clears both caches, so the raster can never drift from the
    /// hint's discipline.
    #[test]
    fn test_invalidate_derived_clears_hint_and_raster() {
        let mut w = world_from(grid_bytes(2, 2, 32768, 0, &[]), 6);
        install(&mut w, 2);
        let _ = truth(&w, (0, 0, 31, 31), MapStyle::default(), 1); // warm the hints
        let _ = render_pixels_patch_styled(&w, 0, 0, 31, 31, MapStyle::default(), 2); // fill the raster
        let r = w.overview().unwrap();
        assert_eq!(r.filled_cells(1, 1), 64, "every g=2 cell of a chunk the LOD-2 render covered");
        assert!(w.top_bands.peek(1, 1).is_some());
        w.invalidate_derived(&[(1, 1)]);
        let r = w.overview().unwrap();
        assert_eq!(r.filled_cells(1, 1), 0, "raster cells cleared");
        assert_eq!(w.top_bands.peek(1, 1), None, "hint cleared");
        assert_eq!(r.filled_cells(0, 0), 64, "a neighbour is untouched");
        // And the next render refills exactly.
        assert_same(&w, (0, 0, 31, 31), MapStyle::default(), 2, "refill");
    }

    /// Test 7 — concurrency: rayon rows (and several renders at once) filling the same chunks'
    /// words produce exactly the single-threaded bytes, 50 times over from a cold raster.
    #[test]
    fn test_overview_raster_fills_race_free() {
        let mut w = world_from(grid_bytes(6, 6, 32768, 0, &[(3, 3)]), 7);
        let rect = (0, 0, 95, 95);
        let want_plain = truth(&w, rect, MapStyle::default(), 2).pixels;
        let relief = MapStyle { cap: None, relief: Some(100) };
        let want_relief = truth(&w, rect, relief, 2).pixels;
        for _ in 0..50 {
            install(&mut w, 2);
            let wr = &w;
            std::thread::scope(|s| {
                let hs: Vec<_> = (0..4).map(|i| s.spawn(move || {
                    let st = if i % 2 == 0 { MapStyle::default() } else { relief };
                    render_pixels_patch_styled(wr, rect.0, rect.1, rect.2, rect.3, st, 2).pixels
                })).collect();
                for (i, h) in hs.into_iter().enumerate() {
                    let got = h.join().unwrap();
                    assert!(got == if i % 2 == 0 { &want_plain } else { &want_relief }[..], "thread {i}");
                }
            });
            // And the filled raster now serves the same bytes.
            assert!(render_pixels_patch_styled(&w, rect.0, rect.1, rect.2, rect.3, MapStyle::default(), 2).pixels == want_plain);
        }
    }

    // ── Persistence (phase 2, plan §4 test 6) ────────────────────────────────────────────────

    fn scratch_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vuencedit_overview_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A 64z world on disk at `dir/world.eden`, loaded into a state whose `disk_image` is that file,
    /// with the raster built at `budget` and filled by one LOD-2 fit render.
    fn saved_world(dir: &Path, budget: usize) -> (AppState, PathBuf) {
        let dest = dir.join("world.eden");
        let mut w = world_from(grid_bytes(4, 4, 32768, 0, &[(3, 0)]), 11);
        std::fs::write(&dest, &w.bytes[..]).unwrap();
        let md = std::fs::metadata(&dest).unwrap();
        w.overview = OnceLock::new();
        let mut ws = WorldState::new();
        ws.world = Some(w);
        ws.disk_image = Some(DiskImage::from_metadata(&dest, &md, false));
        ws.overview_budget = budget;
        {
            let w = ws.world.as_ref().unwrap();
            w.ensure_overview(budget).expect("raster");
            let _ = render_pixels_patch_styled(w, 0, 0, 63, 63, MapStyle::default(), 2);
        }
        (AppState::new(ws), dest)
    }

    /// Save the state's world to `dest` the way `save_world`'s full path does, returning the seq.
    fn full_save(state: &AppState, dest: &Path) -> u64 {
        let seq = read_ws(state).dirty.seq;
        save_world_progress(read_ws(state).world.as_ref().unwrap(), dest.to_str().unwrap(), false, None, None).expect("save");
        record_full_write(state, dest, false, seq).expect("record");
        seq
    }

    fn reload(dest: &Path) -> (LoadedWorld, FileIdentity) {
        let bytes = std::fs::read(dest).unwrap();
        let mut m = MmapMut::map_anon(bytes.len()).unwrap();
        m.copy_from_slice(&bytes);
        let w = parse_world_inner(m).unwrap();
        (w, FileIdentity::of(dest, &std::fs::metadata(dest).unwrap()))
    }

    /// Save → reload: the raster preloads, and the first zoom-out is served without scanning a single
    /// column (misses = 0) — and is still exactly the world render.
    #[test]
    fn test_overview_persists_across_save_and_reload() {
        let dir = scratch_dir("reload");
        let store = dir.join("store");
        let budget = DEFAULT_OVERVIEW_BUDGET;
        let (state, dest) = saved_world(&dir, budget);
        // An edit, so the save is a real one and the raster has an invalidated-then-refilled chunk.
        {
            let mut ws = state.write().unwrap();
            with_edit(&mut ws, "paint", (20, 20, 20, 20), |w| { set_block_abs(w, 20, 20, 60, 8, 0); Ok(()) }).unwrap();
            let w = ws.world.as_ref().unwrap();
            let _ = render_pixels_patch_styled(w, 0, 0, 63, 63, MapStyle::default(), 2);
        }
        let seq = full_save(&state, &dest);
        let job = overview_job_after_save(&state, &dest, seq).expect("a clean save persists");
        let entry = job.write(&store).expect("write");
        assert!(entry.exists());

        let (mut w2, id) = reload(&dest);
        let r = preload(&w2, &id, budget, &store).expect("the entry matches the saved file");
        assert_eq!(r.g, 2);
        w2.overview = OnceLock::from(Some(r));
        for relief in [None, Some(100)] {
            assert_same(&w2, (0, 0, 63, 63), MapStyle { cap: None, relief }, 2, "preloaded");
        }
        let (hits, misses) = w2.overview().unwrap().counters();
        assert!(hits > 0);
        assert_eq!(misses, 0, "a preloaded raster answers the whole fit view without touching the world");
        assert_cells_match_world(&w2, "preloaded");

        // A close with nothing new learned doesn't rewrite; one that learned something (LOD-2 cells
        // are all there, so nothing new at LOD 2 — force a refill by invalidating) does.
        let id2 = id.clone();
        assert!(PersistJob::capture(&w2, &id2, false).is_none(), "nothing changed since the preload");
        w2.invalidate_derived(&[(1, 1)]);
        let _ = render_pixels_patch_styled(&w2, 0, 0, 63, 63, MapStyle::default(), 2);
        assert!(PersistJob::capture(&w2, &id2, false).is_some(), "a refill is worth persisting");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file changed behind our back (length/mtime/id) — the entry is ignored and deleted, and the
    /// load itself is unaffected. Same for a different budget's granularity, a truncated entry, and a
    /// flipped payload byte.
    #[test]
    fn test_overview_stale_or_damaged_entries_are_dropped() {
        let dir = scratch_dir("stale");
        let store = dir.join("store");
        let budget = DEFAULT_OVERVIEW_BUDGET;
        let (state, dest) = saved_world(&dir, budget);
        let seq = full_save(&state, &dest);
        let write = || overview_job_after_save(&state, &dest, seq).expect("job").write(&store).expect("write");

        // External modification.
        let entry = write();
        let mut bytes = std::fs::read(&dest).unwrap();
        bytes.push(0);
        std::fs::write(&dest, &bytes).unwrap();
        let (w, id) = reload(&dest);
        assert!(preload(&w, &id, budget, &store).is_none(), "a modified file must not preload");
        assert!(!entry.exists(), "and its stale entry is deleted");
        bytes.pop();
        std::fs::write(&dest, &bytes).unwrap();

        // The file is back to the saved bytes but its identity (mtime/id) moved on: rewrite under the
        // new identity so the remaining cases start from a matching entry.
        let md = std::fs::metadata(&dest).unwrap();
        state.write().unwrap().disk_image = Some(DiskImage::from_metadata(&dest, &md, false));
        let (w, id) = reload(&dest);
        let entry = write();
        assert!(preload(&w, &id, budget, &store).is_some(), "sanity: a matching entry preloads");

        // A budget that picks another granularity.
        let entry2 = write();
        let just_under_g2 = raster_bytes(2, w.chunk_map.len(), 16) - 1;
        assert_eq!(choose_granularity(w.chunk_map.len(), 16, just_under_g2), Some(4));
        assert!(preload(&w, &id, just_under_g2, &store).is_none(), "g mismatch is ignored");
        assert!(!entry2.exists());

        // Truncated.
        let entry = { let _ = entry; write() };
        let full = std::fs::read(&entry).unwrap();
        std::fs::write(&entry, &full[..full.len() - 7]).unwrap();
        assert!(preload(&w, &id, budget, &store).is_none(), "truncated");
        assert!(!entry.exists());

        // One payload byte flipped (the CRC catches it).
        let entry = write();
        let mut full = std::fs::read(&entry).unwrap();
        let n = full.len();
        full[n - 3] ^= 0x5a;
        std::fs::write(&entry, &full).unwrap();
        assert!(preload(&w, &id, budget, &store).is_none(), "corrupt");
        assert!(!entry.exists());

        // Garbage.
        std::fs::write(entry_path(&store, &dest), b"not a raster").unwrap();
        assert!(preload(&w, &id, budget, &store).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Nothing is persisted that doesn't describe the file: a dirty world at close, a save whose seq
    /// moved before the snapshot, and a compressed save.
    #[test]
    fn test_overview_is_not_persisted_when_the_file_differs() {
        let dir = scratch_dir("gates");
        let (state, dest) = saved_world(&dir, DEFAULT_OVERVIEW_BUDGET);
        assert!(overview_persist_candidate(&read_ws(&state)).is_some(), "clean: a close may persist");

        let seq = full_save(&state, &dest);
        {
            let mut ws = state.write().unwrap();
            with_edit(&mut ws, "paint", (5, 5, 5, 5), |w| { set_block_abs(w, 5, 5, 60, 8, 0); Ok(()) }).unwrap();
        }
        assert!(overview_job_after_save(&state, &dest, seq).is_none(), "an edit landed after the save captured");
        assert!(overview_persist_candidate(&read_ws(&state)).is_none(), "dirty: a close must not persist");

        let seq = full_save(&state, &dest);
        assert!(overview_job_after_save(&state, &dest, seq).is_some(), "clean again after a save");
        assert!(overview_job_after_save(&state, &dir.join("elsewhere.eden"), seq).is_none(),
            "only under the path the disk image names");
        if let Some(d) = state.write().unwrap().disk_image.as_mut() { d.compressed = true; }
        assert!(overview_job_after_save(&state, &dest, seq).is_none(), "a zip has no identity to key on");
        assert!(overview_persist_candidate(&read_ws(&state)).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The store stays under its cap, newest kept; the startup sweep drops entries for missing files.
    #[test]
    fn test_overview_store_hygiene() {
        let dir = scratch_dir("hygiene");
        let store = dir.join("store");
        let (state, dest) = saved_world(&dir, DEFAULT_OVERVIEW_BUDGET);
        let seq = full_save(&state, &dest);
        let entry = overview_job_after_save(&state, &dest, seq).unwrap().write(&store).unwrap();
        let size = std::fs::metadata(&entry).unwrap().len();
        // Two older fillers; a cap of one entry keeps only the newest.
        for (i, age) in [(1, 3600u64), (2, 7200)] {
            let p = store.join(format!("{i:016x}.vxr"));
            std::fs::write(&p, vec![0u8; size as usize]).unwrap();
            let t = std::time::SystemTime::now() - std::time::Duration::from_secs(age);
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        }
        std::fs::write(store.join("x.vxr.tmp"), b"torn").unwrap();
        trim_store(&store, size);
        assert!(entry.exists(), "the newest entry survives the cap");
        assert!(!store.join(format!("{:016x}.vxr", 1)).exists() && !store.join(format!("{:016x}.vxr", 2)).exists());

        sweep_store(&store);
        assert!(entry.exists(), "its source still exists");
        assert!(!store.join("x.vxr.tmp").exists(), "temps are swept");
        std::fs::remove_file(&dest).unwrap();
        sweep_store(&store);
        assert!(!entry.exists(), "the source is gone, so is its entry");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
