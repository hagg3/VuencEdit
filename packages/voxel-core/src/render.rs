//! The 2D raster renderers: top-down map, axis slices/slabs, the axonometric view, and the
//! orthographic front/side/top projections the selection previews use.
//!
//! **Everything here is generic over [`VoxelView`] + a [`ViewMeta`]** (plan PR-C). Each app keeps
//! its own `#[tauri::command]` wrappers and its own IPC payload type; what they share is these
//! loops, which are where all the per-pixel cost and all the band-addressing subtlety live.
//!
//! ⚠️ A chunk slice's length is its *real* span (see [`VoxelView::chunk_bytes`]), so every read here
//! bounds on `chunk.len()`. That is what stops a short-span chunk's tail — which belongs to the
//! *next* chunk — from being rendered as this one's terrain.

use crate::colors::{block_color, transparent_alpha};
use crate::mask::SelectionMask;
use crate::view::{scan_band_ceiling, scan_z_ceiling, surface_z, world_max_z, ViewMeta, VoxelView};
use rayon::prelude::*;

/// The "no block here" colour every slice/ortho renderer fills with. The top-down map instead
/// leaves untouched pixels fully transparent, so the frontend can composite tiles over each other.
const VOID: [u8; 4] = [20, 20, 35, 255];

/// A rendered RGBA rectangle, row-major, `(y, x)` order.
///
/// `x`/`y` are its world-space origin — for the vertical slabs that means (horizontal world axis,
/// world Z), not (world X, world Y). Deliberately **not** `Serialize`: an app frames it into its own
/// binary IPC payload type, and a stray `Serialize` would let tauri's blanket impl silently revert
/// that payload to base64-in-JSON.
pub struct Raster {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// World blocks per output pixel (audit H6). 1 = full resolution; >1 means the raster was
    /// point-sampled every `lod`-th block on both axes, so it covers `width*lod × height*lod`
    /// world blocks starting at (x, y) and must be drawn upscaled by `lod`.
    pub lod: u32,
    pub pixels: Vec<u8>,
}

impl Raster {
    /// The 1×1 placeholder the renderers return for a degenerate request.
    fn dot(rgba: [u8; 4]) -> Self {
        Raster { x: 0, y: 0, width: 1, height: 1, lod: 1, pixels: rgba.to_vec() }
    }
}

/// Largest level-of-detail step any render will honour. A tile is always ~`TILE` output pixels
/// regardless of zoom, so the frontend grows the tile's *world* footprint by `lod` rather than
/// shrinking the tile; this cap bounds that footprint (and the clamp keeps a bad IPC arg from
/// producing a one-pixel raster covering the whole world).
pub const MAX_LOD: u32 = 32;

/// Re-render just the sub-rectangle [px1,px2] × [py1,py2] of the top-down map.
/// Bounds are clamped to [0, world_W-1] × [0, world_H-1].
///
/// `cap` is the cutaway ceiling: blocks above it are treated as absent, so the map draws whatever is
/// directly under the cap plane (cave roofs vanish, floors show). `None` = normal render.
pub fn pixels_patch(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    px1: i32, py1: i32, px2: i32, py2: i32, cap: Option<i32>,
) -> Raster {
    pixels_patch_lod(world, meta, px1, py1, px2, py2, cap, 1)
}

/// [`pixels_patch`] with a level-of-detail step (audit H6): only every `lod`-th block on each axis is
/// scanned, so the output is `lod²` times smaller and `lod²` times cheaper. Nearest-neighbour point
/// sampling, which matches the frontend's `imageSmoothingEnabled = false` upscale — at zoomed-out
/// scales the discarded columns were never visible anyway.
#[allow(clippy::too_many_arguments)]
pub fn pixels_patch_lod(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    px1: i32, py1: i32, px2: i32, py2: i32, cap: Option<i32>, lod: u32,
) -> Raster {
    pixels_patch_lod_from(&WorldSource::new(world, cap), meta, px1, py1, px2, py2, lod)
}

/// [`pixels_patch_lod`] over any [`SampleSource`] — the one plain top-down render loop. The
/// world path is `WorldSource`; an app can hand in a cache (VuencEdit's overview raster, 18.15)
/// and get byte-identical output as long as it returns what `WorldSource` would.
#[allow(clippy::too_many_arguments)]
pub fn pixels_patch_lod_from(
    src: &impl SampleSource, meta: ViewMeta,
    px1: i32, py1: i32, px2: i32, py2: i32, lod: u32,
) -> Raster {
    let lod = lod.clamp(1, MAX_LOD);
    let world_w = meta.width();
    let world_h = meta.height();
    let x1 = px1.clamp(0, world_w - 1) as u32;
    let y1 = py1.clamp(0, world_h - 1) as u32;
    let x2 = px2.clamp(0, world_w - 1) as u32;
    let y2 = py2.clamp(0, world_h - 1) as u32;
    let width  = (x2 - x1) / lod + 1;
    let height = (y2 - y1) / lod + 1;
    let mut pixels = vec![0u8; (width * height * 4) as usize];

    // One row per rayon task — rows are disjoint slices of `pixels`, and each pixel is an
    // independent O(1) lookup into `world`, so this is embarrassingly parallel.
    pixels.par_chunks_mut((width * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let mut cursor = src.row(y1 + row as u32 * lod);
        for ox in 0..width {
            let (top_bt, top_paint, under_bt, under_paint, _) = cursor.sample(x1 + ox * lod);
            if top_bt == 0 { continue; }
            let [r, g, b] = blend_top_over_under(top_bt, top_paint, under_bt, under_paint, meta.sky);
            let off = (ox * 4) as usize;
            row_pixels[off] = r; row_pixels[off + 1] = g; row_pixels[off + 2] = b; row_pixels[off + 3] = 255;
        }
    });
    Raster { x: x1, y: y1, width, height, lod, pixels }
}

/// One top-down sample, the result of [`scan_column`]: `(top_bt, top_paint, under_bt, under_paint,
/// top_z)`. `top_bt == 0` is an empty column (or no chunk), and `top_z` is then `-1`.
pub type Sample = (u8, u8, u8, u8, i32);

/// The sample of an empty column or a missing chunk.
pub const EMPTY_SAMPLE: Sample = (0, 0, 0, 0, -1);

/// Where the top-down map's per-column scan results come from. The renders ([`pixels_patch_lod_from`],
/// [`pixels_patch_styled_from`]) own the rect, the LOD grid, the blend, relief shading and the output
/// layout; a source only answers "what does the column at world pixel `(px, py)` hold".
///
/// [`WorldSource`] is the ground truth. Any other source must return **exactly** what it would for
/// the same world, or the map drifts from the world it claims to show.
pub trait SampleSource: Sync {
    type Row<'a>: SampleRow where Self: 'a;
    /// A cursor over world-pixel row `py` (0-based, inside the world). Creating one must not touch
    /// the world — a render builds one per output row.
    fn row(&self, py: u32) -> Self::Row<'_>;
}

/// A cursor along one row of a [`SampleSource`]. Renders call `sample` with non-decreasing `px`,
/// which lets a source memoise per-chunk lookups across a run of samples.
pub trait SampleRow {
    /// The sample at world pixel `(px, py)`, `px` inside the world.
    fn sample(&mut self, px: u32) -> Sample;
}

/// The world itself as a [`SampleSource`]: chunk lookup, band ceiling, column scan — what every
/// top-down render did inline before 18.15. `cap` is the cutaway ceiling (see [`pixels_patch`]).
pub struct WorldSource<'w, V> {
    world: &'w V,
    cap: Option<i32>,
}

impl<'w, V: VoxelView> WorldSource<'w, V> {
    pub fn new(world: &'w V, cap: Option<i32>) -> Self { WorldSource { world, cap } }
}

impl<V: VoxelView + Sync> SampleSource for WorldSource<'_, V> {
    type Row<'a> = WorldRow<'a, V> where Self: 'a;
    #[inline]
    fn row(&self, py: u32) -> WorldRow<'_, V> { WorldRow::new(self.world, py, self.cap) }
}

/// A [`WorldSource`] row cursor. Public so an app-side cache can fall back to — and fill itself
/// from — exactly the scan the world path runs.
pub struct WorldRow<'w, V> {
    world: &'w V,
    cap: Option<i32>,
    min_x: i32,
    cy: i32,
    ly: usize,
    // The chunk lookup is a hash probe; at lod 1 `cx` only changes every 16 pixels, so memoize
    // it across the run instead of calling it for every sample (audit M3 (1)) — ~16× fewer
    // lookups on a wide patch. At lod ≥ 16 every sample lands in a new chunk and the memo
    // simply never hits, which costs one integer compare.
    last_cx: i32,
    chunk: Option<&'w [u8]>,
    // The chunk's top-occupied-band ceiling (`VoxelView::top_band_hint`), fetched alongside the
    // chunk and memoized with it — this loop is *the* reason the hint exists (it is the highest
    // page-touch-rate scan in the program), and probing it per sample rather than per chunk
    // would give back much of what it saves.
    hi_band: usize,
}

impl<'w, V: VoxelView> WorldRow<'w, V> {
    #[inline]
    pub fn new(world: &'w V, py: u32, cap: Option<i32>) -> Self {
        let (min_x, min_y) = world.chunk_origin();
        WorldRow {
            world, cap, min_x,
            cy: (py / 16) as i32 + min_y,
            ly: (py % 16) as usize,
            last_cx: i32::MIN,
            chunk: None,
            hi_band: world.num_bands(),
        }
    }
}

impl<V: VoxelView> SampleRow for WorldRow<'_, V> {
    #[inline(always)]
    fn sample(&mut self, px: u32) -> Sample {
        let cx = (px / 16) as i32 + self.min_x;
        if cx != self.last_cx {
            self.last_cx = cx;
            self.chunk = self.world.chunk_bytes(cx, self.cy);
            self.hi_band = scan_band_ceiling(self.world, cx, self.cy);
        }
        let Some(chunk) = self.chunk else { return EMPTY_SAMPLE };
        scan_column(chunk, (px % 16) as usize, self.ly, self.hi_band, self.cap)
    }
}

/// The column scan every top-down sample runs: walk down from the chunk's band ceiling to the topmost
/// block at or under `cap`, and — only when that top is transparent — one block further for the
/// composite. Returns `(top_bt, top_paint, under_bt, under_paint, top_z)`; `top_bt == 0` is an empty
/// column (`top_z` is then -1). Shared by the plain and relief renders so both see the same surface.
#[inline(always)]
fn scan_column(chunk: &[u8], lx: usize, ly: usize, hi_band: usize, cap: Option<i32>) -> Sample {
    let mut top_bt = 0u8; let mut top_paint = 0u8;
    let mut under_bt = 0u8; let mut under_paint = 0u8;
    let mut top_z = -1i32;
    'outer: for band in (0..hi_band).rev() {
        if let Some(c) = cap {
            if (band * 16) as i32 > c { continue; }
        }
        for z in (0..16usize).rev() {
            if let Some(c) = cap {
                if (band * 16 + z) as i32 > c { continue; }
            }
            let bi = band * 8192 + lx * 256 + ly * 16 + z;
            let pi = bi + 4096;
            if pi >= chunk.len() { continue; }
            let bt = chunk[bi];
            if bt == 0 { continue; }
            if top_bt == 0 {
                top_bt = bt; top_paint = chunk[pi]; top_z = (band * 16 + z) as i32;
                if transparent_alpha(bt).is_none() { break 'outer; }
            } else {
                under_bt = bt; under_paint = chunk[pi];
                break 'outer;
            }
        }
    }
    (top_bt, top_paint, under_bt, under_paint, top_z)
}

/// How the top-down map is drawn, beyond the rectangle and LOD: the cutaway ceiling and relief
/// shading. Backend view state in the app (`view_cap_z` / `view_relief`), bundled so the edit-patch
/// paths carry one value rather than growing a parameter per style knob.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MapStyle {
    /// Cutaway ceiling — see [`pixels_patch`].
    pub cap: Option<i32>,
    /// Hillshade strength in percent of the default (100 = [`RELIEF_BASE`]). `None`/`Some(0)` = off.
    pub relief: Option<u8>,
}

impl MapStyle {
    pub fn capped(cap: Option<i32>) -> Self { MapStyle { cap, relief: None } }
    /// Relief strength if shading is actually on.
    pub fn relief_on(&self) -> Option<u8> { self.relief.filter(|&r| r > 0) }
}

/// Relief slope gain at strength 100: brightness change per block of height difference (per `lod`).
pub const RELIEF_BASE: f32 = 0.08;
/// Brightness clamp for relief shading, so cliffs darken/brighten without going to black/white.
const RELIEF_MIN: f32 = 0.6;
const RELIEF_MAX: f32 = 1.35;

/// [`pixels_patch_lod`] with a [`MapStyle`]. With relief off this *is* `pixels_patch_lod` — the branch
/// is taken once, outside every loop, so the plain map stays byte-identical (tested).
#[allow(clippy::too_many_arguments)]
pub fn pixels_patch_styled(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    px1: i32, py1: i32, px2: i32, py2: i32, style: MapStyle, lod: u32,
) -> Raster {
    pixels_patch_styled_from(&WorldSource::new(world, style.cap), meta, px1, py1, px2, py2, style.relief, lod)
}

/// [`pixels_patch_styled`] over any [`SampleSource`]. The source already carries the cutaway cap
/// (it decides what a column scan sees), so only the relief strength is passed here.
#[allow(clippy::too_many_arguments)]
pub fn pixels_patch_styled_from(
    src: &impl SampleSource, meta: ViewMeta,
    px1: i32, py1: i32, px2: i32, py2: i32, relief: Option<u8>, lod: u32,
) -> Raster {
    match relief.filter(|&r| r > 0) {
        None => pixels_patch_lod_from(src, meta, px1, py1, px2, py2, lod),
        Some(strength) => pixels_patch_relief(src, meta, px1, py1, px2, py2, lod, strength),
    }
}

/// Relief (hillshade) render — light from the north-west, the cartographic convention. Each sample
/// is brightened or darkened by how much higher it sits than its **west and north** neighbours:
/// `f = clamp(1 + s·((h − h_w) + (h − h_n)) / lod)`, `s = RELIEF_BASE · strength / 100`. Dividing by
/// `lod` keeps a slope's look the same at every zoom level.
///
/// Neighbours are the adjacent *samples* (`px − lod`, `py − lod`), so the patch needs a one-sample
/// **apron** row above and column to the left. Where the neighbour is off the world or an empty
/// column, the sample's own height stands in (slope 0, unshaded). A transparent top (water, glass)
/// contributes its own z, so a lake surface is flat and unshaded.
///
/// ⚠️ Because a sample reads its W/N neighbours, an edit changes the shading of the samples **east
/// and south** of it — callers that re-render an edited rect must grow it by `lod` on x2/y2 (the
/// app's `edit_patch_capped` does). And a tile only matches its neighbour at the seam if both are
/// aligned to the same `lod` grid, which the tiler and the edit patch both guarantee.
#[allow(clippy::too_many_arguments)]
fn pixels_patch_relief(
    src: &impl SampleSource, meta: ViewMeta,
    px1: i32, py1: i32, px2: i32, py2: i32, lod: u32, strength: u8,
) -> Raster {
    let lod = lod.clamp(1, MAX_LOD);
    let world_w = meta.width();
    let world_h = meta.height();
    let x1 = px1.clamp(0, world_w - 1) as u32;
    let y1 = py1.clamp(0, world_h - 1) as u32;
    let x2 = px2.clamp(0, world_w - 1) as u32;
    let y2 = py2.clamp(0, world_h - 1) as u32;
    let width  = (x2 - x1) / lod + 1;
    let height = (y2 - y1) / lod + 1;
    // Grid = output samples plus the apron: grid (r, c) is world sample (x1 + (c−1)·lod, y1 + (r−1)·lod).
    let (gw, gh) = (width + 1, height + 1);
    const NO_H: i16 = -1;
    let mut heights = vec![NO_H; (gw * gh) as usize];
    let mut colors = vec![0u8; (gw * gh * 4) as usize];

    // Pass 1 — the ordinary scan over grid rows, keeping each sample's top z alongside its colour.
    colors.par_chunks_mut((gw * 4) as usize).zip(heights.par_chunks_mut(gw as usize)).enumerate()
        .for_each(|(r, (row_rgba, row_h))| {
            let py = y1 as i64 + (r as i64 - 1) * lod as i64;
            if py < 0 { return; } // apron row above the world's top edge
            let mut cursor = src.row(py as u32);
            for c in 0..gw {
                let px = x1 as i64 + (c as i64 - 1) * lod as i64;
                if px < 0 { continue; } // apron column left of the world's west edge
                let (top_bt, top_paint, under_bt, under_paint, top_z) = cursor.sample(px as u32);
                if top_bt == 0 { continue; }
                row_h[c as usize] = top_z as i16;
                let [cr, cg, cb] = blend_top_over_under(top_bt, top_paint, under_bt, under_paint, meta.sky);
                let o = c as usize * 4;
                row_rgba[o] = cr; row_rgba[o + 1] = cg; row_rgba[o + 2] = cb; row_rgba[o + 3] = 255;
            }
        });

    // Pass 2 — shade each output sample from its grid neighbours.
    let s = RELIEF_BASE * strength as f32 / 100.0 / lod as f32;
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    pixels.par_chunks_mut((width * 4) as usize).enumerate().for_each(|(row, out)| {
        let r = row + 1;
        for ox in 0..width as usize {
            let c = ox + 1;
            let gi = r * gw as usize + c;
            if colors[gi * 4 + 3] == 0 { continue; } // empty column — stays transparent
            let h = heights[gi];
            let hw = match heights[gi - 1] { NO_H => h, v => v };
            let hn = match heights[gi - gw as usize] { NO_H => h, v => v };
            let slope = (h - hw) as f32 + (h - hn) as f32;
            let o = ox * 4;
            if slope == 0.0 {
                out[o..o + 4].copy_from_slice(&colors[gi * 4..gi * 4 + 4]);
                continue;
            }
            let f = (1.0 + s * slope).clamp(RELIEF_MIN, RELIEF_MAX);
            for k in 0..3 {
                out[o + k] = (colors[gi * 4 + k] as f32 * f).round().min(255.0) as u8;
            }
            out[o + 3] = 255;
        }
    });
    Raster { x: x1, y: y1, width, height, lod, pixels }
}

/// Composite the topmost block over whatever the ray found beneath it. A transparent top (water,
/// glass, fence, flower) blends with its `alpha`; anything else is opaque and the under-block is
/// only ever populated when the top was transparent, so this collapses to `c1` for solid terrain.
#[inline]
pub fn blend_top_over_under(top_bt: u8, top_paint: u8, under_bt: u8, under_paint: u8, sky: u8) -> [u8; 3] {
    let c1 = block_color(top_bt, top_paint, sky);
    if under_bt == 0 { return c1; }
    let Some(alpha) = transparent_alpha(top_bt) else { return c1 };
    let c2 = block_color(under_bt, under_paint, sky);
    [
        (c1[0] as f32 * alpha + c2[0] as f32 * (1.0 - alpha)) as u8,
        (c1[1] as f32 * alpha + c2[1] as f32 * (1.0 - alpha)) as u8,
        (c1[2] as f32 * alpha + c2[2] as f32 * (1.0 - alpha)) as u8,
    ]
}

/// Re-render a sub-rectangle of a z-slice cross-section.
pub fn zslice_patch(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    z: i32, px1: i32, py1: i32, px2: i32, py2: i32,
) -> Raster {
    zslice_patch_lod(world, meta, z, px1, py1, px2, py2, 1)
}

/// [`zslice_patch`] with a level-of-detail step — see [`pixels_patch_lod`]. The z-slice view is tiled
/// by the same tile cache the top-down map uses, so it takes the same `lod` its tiles do.
#[allow(clippy::too_many_arguments)]
pub fn zslice_patch_lod(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    z: i32, px1: i32, py1: i32, px2: i32, py2: i32, lod: u32,
) -> Raster {
    let lod = lod.clamp(1, MAX_LOD);
    let (min_x, min_y) = world.chunk_origin();
    let world_w = meta.width();
    let world_h = meta.height();
    let x1 = px1.clamp(0, world_w - 1) as u32;
    let y1 = py1.clamp(0, world_h - 1) as u32;
    let x2 = px2.clamp(0, world_w - 1) as u32;
    let y2 = py2.clamp(0, world_h - 1) as u32;
    let width  = (x2 - x1) / lod + 1;
    let height = (y2 - y1) / lod + 1;
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    let band = (z as usize) / 16;
    let lz   = (z as usize) % 16;

    pixels.par_chunks_mut((width * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let py = y1 + row as u32 * lod;
        let cy = (py / 16) as i32 + min_y;
        let ly = (py % 16) as usize;
        // Memoize the chunk lookup across the run the same way as `pixels_patch_lod`
        // (audit M3 (1)) — at lod 1 `cx` only changes every 16 pixels.
        let mut last_cx = i32::MIN;
        let mut chunk: Option<&[u8]> = None;
        for ox in 0..width {
            let px = x1 + ox * lod;
            let cx = (px / 16) as i32 + min_x;
            if cx != last_cx {
                last_cx = cx;
                chunk = world.chunk_bytes(cx, cy);
            }
            let Some(chunk) = chunk else { continue };
            let lx = (px % 16) as usize;
            let bi = band * 8192 + lx * 256 + ly * 16 + lz;
            let pi = bi + 4096;
            if pi >= chunk.len() { continue; }
            let bt = chunk[bi];
            if bt == 0 { continue; }
            let [r, g, b] = block_color(bt, chunk[pi], meta.sky);
            let off = (ox * 4) as usize;
            row_pixels[off]     = r;
            row_pixels[off + 1] = g;
            row_pixels[off + 2] = b;
            row_pixels[off + 3] = 255;
        }
    });
    Raster { x: x1, y: y1, width, height, lod, pixels }
}

/// Front slab (constant world-Y plane). Horizontal axis = world X, vertical axis = world Z.
/// One O(1) voxel read per pixel — the X/Z analog of [`zslice_patch`], fully tileable.
/// Image row 0 = top = highest Z (`pz2`); `row = pz2 - z`. The returned `Raster.x` is the horizontal
/// world-X start and `.y` is the vertical world-Z start (`pz1`).
pub fn yslice_patch(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    sy: i32, px1: i32, pz1: i32, px2: i32, pz2: i32,
) -> Raster {
    let (min_x, min_y) = world.chunk_origin();
    let world_w = meta.width();
    let world_h = meta.height();
    let max_z   = world_max_z(world);
    if sy < 0 || sy >= world_h {
        return Raster::dot(VOID);
    }
    let x1 = px1.clamp(0, world_w - 1);
    let x2 = px2.clamp(0, world_w - 1);
    let z1 = pz1.clamp(0, max_z);
    let z2 = pz2.clamp(0, max_z);
    let width  = (x2 - x1 + 1) as u32;
    let height = (z2 - z1 + 1) as u32;
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    let cy = sy.div_euclid(16) + min_y;
    let ly = sy.rem_euclid(16) as usize;
    // Row-parallel (audit R2-2): one rayon task per output row (constant world-Z), writing that
    // row's contiguous slice of `pixels` directly — no per-column `Vec` and no post-hoc splat. The
    // chunk lookup + band ceiling are memoized across each row's horizontal scan exactly as
    // `pixels_patch_lod` memoizes them (`cx` only changes every 16 columns).
    pixels.par_chunks_mut((width * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let z = z2 - row as i32;
        let mut last_cx = i32::MIN;
        let mut chunk: Option<&[u8]> = None;
        let mut z_top = i32::MIN;
        for (ox, out) in row_pixels.chunks_exact_mut(4).enumerate() {
            let px = x1 + ox as i32;
            let cx = px.div_euclid(16) + min_x;
            if cx != last_cx {
                last_cx = cx;
                chunk = world.chunk_bytes(cx, cy);
                // Everything above the hint's ceiling is air, which would take the `bt == 0`
                // branch below anyway — so stopping here is output-identical and saves paging in
                // whole bands of a 256z chunk for a caller that always asks for the full
                // 0..=max_z column.
                z_top = z2.min(scan_z_ceiling(world, cx, cy));
            }
            if z > z_top { continue; }
            let Some(chunk) = chunk else { continue };
            let lx = px.rem_euclid(16) as usize;
            let band = (z as usize) / 16;
            let lz   = (z as usize) % 16;
            let bi = band * 8192 + lx * 256 + ly * 16 + lz;
            let pi = bi + 4096;
            if pi >= chunk.len() { continue; }
            let bt = chunk[bi];
            if bt == 0 { continue; }
            let [r, g, b] = block_color(bt, chunk[pi], meta.sky);
            out.copy_from_slice(&[r, g, b, 255]);
        }
    });
    Raster { x: x1 as u32, y: z1 as u32, width, height, lod: 1, pixels }
}

/// Side slab (constant world-X plane). Horizontal axis = world Y, vertical axis = world Z.
/// One O(1) voxel read per pixel. Image row 0 = top = highest Z (`pz2`); `row = pz2 - z`.
/// Returned `Raster.x` is the horizontal world-Y start and `.y` is the vertical world-Z start.
pub fn xslice_patch(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    sx: i32, py1: i32, pz1: i32, py2: i32, pz2: i32,
) -> Raster {
    let (min_x, min_y) = world.chunk_origin();
    let world_w = meta.width();
    let world_h = meta.height();
    let max_z   = world_max_z(world);
    if sx < 0 || sx >= world_w {
        return Raster::dot(VOID);
    }
    let y1 = py1.clamp(0, world_h - 1);
    let y2 = py2.clamp(0, world_h - 1);
    let z1 = pz1.clamp(0, max_z);
    let z2 = pz2.clamp(0, max_z);
    let width  = (y2 - y1 + 1) as u32;
    let height = (z2 - z1 + 1) as u32;
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    let cx = sx.div_euclid(16) + min_x;
    let lx = sx.rem_euclid(16) as usize;
    // Row-parallel (audit R2-2) — same transposition as `yslice_patch`, memoizing the chunk lookup
    // + band ceiling across each row's horizontal (world-Y) scan since `cy` changes every 16 cols.
    pixels.par_chunks_mut((width * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let z = z2 - row as i32;
        let mut last_cy = i32::MIN;
        let mut chunk: Option<&[u8]> = None;
        let mut z_top = i32::MIN;
        for (oy, out) in row_pixels.chunks_exact_mut(4).enumerate() {
            let py = y1 + oy as i32;
            let cy = py.div_euclid(16) + min_y;
            if cy != last_cy {
                last_cy = cy;
                chunk = world.chunk_bytes(cx, cy);
                // Same band ceiling as `yslice_patch` — see the note there.
                z_top = z2.min(scan_z_ceiling(world, cx, cy));
            }
            if z > z_top { continue; }
            let Some(chunk) = chunk else { continue };
            let ly = py.rem_euclid(16) as usize;
            let band = (z as usize) / 16;
            let lz   = (z as usize) % 16;
            let bi = band * 8192 + lx * 256 + ly * 16 + lz;
            let pi = bi + 4096;
            if pi >= chunk.len() { continue; }
            let bt = chunk[bi];
            if bt == 0 { continue; }
            let [r, g, b] = block_color(bt, chunk[pi], meta.sky);
            out.copy_from_slice(&[r, g, b, 255]);
        }
    });
    Raster { x: y1 as u32, y: z1 as u32, width, height, lod: 1, pixels }
}

/// Axonometric top-down render for the visible region.
///
/// For each output pixel (px, py), rays descend from max_z. At depth dz = max_z - z, the sample
/// point drifts: `sample_px = px + ski*0.5*dz`, `sample_py = py - ski*dz`. This creates a south-east
/// viewing angle with depth-derived parallax (`ski = 0` is flat top-down). `dir`: 0=SE 1=SW 2=NE 3=NW.
#[allow(clippy::too_many_arguments)]
pub fn axo_region(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    x1: i32, y1: i32, x2: i32, y2: i32, ski: f32, dir: u8,
) -> Raster {
    axo_region_bounded(world, meta, x1, y1, x2, y2, ski, dir, 1, None)
}

/// Smallest power-of-two `lod` that keeps a `w × h` region's long side within `max_side` pixels.
pub fn axo_lod_for(w: u32, h: u32, max_side: u32) -> u32 {
    let long = w.max(h).max(1);
    let mut lod = 1u32;
    while long.div_ceil(lod) > max_side.max(1) { lod *= 2; }
    lod
}

/// `axo_region` with its cost bounded (Stage 13.3): the Inspector previews a selection in a
/// ~200 px panel, so a full-resolution raycast over a select-all world is wasted work.
///
/// * `lod` — world blocks per output pixel (point-sampled, like the tile LODs); the raster covers
///   `width*lod × height*lod` blocks from `(x, y)`, and `lod = 1` is `axo_region` exactly.
/// * `z_top` — where every ray starts, so a shallow selection doesn't pay for the empty air above
///   it (clamped to the world's height; `None` = the world's top). It is also the plane the
///   parallax is anchored to: with `ski > 0` a lower ceiling shifts the picture, and `ski = 0`
///   is unaffected.
#[allow(clippy::too_many_arguments)]
pub fn axo_region_bounded(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    x1: i32, y1: i32, x2: i32, y2: i32, ski: f32, dir: u8,
    lod: u32, z_top: Option<i32>,
) -> Raster {
    let lod = lod.max(1);
    let (min_x, min_y) = world.chunk_origin();
    let world_w = meta.width();
    let world_h = meta.height();
    let ox1 = x1.clamp(0, world_w - 1) as u32;
    let oy1 = y1.clamp(0, world_h - 1) as u32;
    let ox2 = x2.clamp(0, world_w - 1) as u32;
    let oy2 = y2.clamp(0, world_h - 1) as u32;
    let width  = (ox2 - ox1) / lod + 1;
    let height = (oy2 - oy1) / lod + 1;
    let max_z = z_top.unwrap_or(i32::MAX).clamp(0, world_max_z(world)) as f32;
    let mut pixels = vec![30u8; (width * height * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p[3] = 255; }
    let (sx_sgn, sy_sgn): (f32, f32) = match dir {
        1 => (-1.0, -1.0), // SW
        2 => ( 1.0,  1.0), // NE
        3 => (-1.0,  1.0), // NW
        _ => ( 1.0, -1.0), // SE (default)
    };

    // Each row is a disjoint slice of `pixels` and each pixel does its own independent
    // (comparatively expensive, up-to-max_z) raycast, so this parallelizes well per row.
    pixels.par_chunks_mut((width * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let py = oy1 + row as u32 * lod;
        for col in 0..width {
            let px = ox1 + col * lod;
            let mut top_bt = 0u8; let mut top_paint = 0u8;
            let mut under_bt = 0u8; let mut under_paint = 0u8;

            // The ray's parallax drift moves it between chunks only every few steps, so memoize the
            // chunk lookup *and* its top-occupied-band ceiling together (`VoxelView::top_band_hint`)
            // instead of re-probing both 256 times per pixel.
            let mut memo_c = (i32::MIN, i32::MIN);
            let mut memo: Option<(&[u8], usize)> = None;
            'zray: for dz in 0..=(max_z as i32) {
                let wz = (max_z as i32) - dz;
                let sx = (px as f32 + sx_sgn * ski * 0.5 * dz as f32).round() as i32;
                let sy = (py as f32 + sy_sgn * ski * dz as f32).round() as i32;
                if sx < 0 || sx >= world_w || sy < 0 || sy >= world_h { continue; }
                let cx = (sx / 16) + min_x;
                let cy = (sy / 16) + min_y;
                let lx = (sx % 16) as usize;
                let ly = (sy % 16) as usize;
                if (cx, cy) != memo_c {
                    memo_c = (cx, cy);
                    memo = world.chunk_bytes(cx, cy).map(|c| (c, scan_band_ceiling(world, cx, cy)));
                }
                let Some((chunk, hi_band)) = memo else { continue };
                let band = wz as usize / 16;
                // Above the hint is air by contract — skip without touching the band's page.
                if band >= hi_band { continue; }
                let lz   = wz as usize % 16;
                let bi = band * 8192 + lx * 256 + ly * 16 + lz;
                let pi = bi + 4096;
                if pi >= chunk.len() { continue; }
                let bt = chunk[bi];
                if bt == 0 { continue; }
                if top_bt == 0 {
                    top_bt = bt; top_paint = chunk[pi];
                    if transparent_alpha(bt).is_none() { break 'zray; }
                } else {
                    under_bt = bt; under_paint = chunk[pi];
                    break 'zray;
                }
            }

            if top_bt == 0 { continue; }
            let [r, g, b] = blend_top_over_under(top_bt, top_paint, under_bt, under_paint, meta.sky);
            let off = (col * 4) as usize;
            row_pixels[off] = r; row_pixels[off + 1] = g; row_pixels[off + 2] = b; row_pixels[off + 3] = 255;
        }
    });
    Raster { x: ox1, y: oy1, width, height, lod, pixels }
}

// ── Orthographic selection previews ───────────────────────────────────────────
//
// These three take a **scan buffer**, never a live mmapped world: the callers clone the relevant
// chunks into a full-span local world first, with short spans zero-padded, so the loops can index a
// band-scoped chunk without knowing about spans at all. `b_lo` is the index of the lowest band in
// that clone — the whole reason a scan-buffer chunk is not addressed like a real one.

/// Front view: X=horizontal, Z=vertical; scans Y front-to-back, stops at first non-air block.
/// Z=z_max maps to row 0 (top), Z=z_min maps to row (ph-1) (bottom).
///
/// Chunk lookups are amortized over 16-block chunk rows: one lookup per chunk row rather than one
/// per block, reducing them from O(W×D×H) to O(W×D×H/16).
#[allow(clippy::too_many_arguments)]
pub fn view_front(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    x1: i32, x2: i32, y1: i32, y2: i32, z_min: i32, z_max: i32,
    b_lo: usize,
    mask: Option<&SelectionMask>,
) -> (u32, u32, Vec<u8>) {
    let (min_x, min_y) = world.chunk_origin();
    let pw = (x2 - x1 + 1) as u32;
    let ph = (z_max - z_min + 1) as u32;
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    // Row-parallel (audit R2-4): one rayon task per output row (constant Z), same transposition
    // R2-2 applies to the slab renderers. Per-(x,z) chunk-lookup count is unchanged — only the loop
    // nesting swapped, so this is output-identical.
    pixels.par_chunks_mut((pw * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let z     = z_max - row as i32;
        let band  = (z as usize) / 16;
        let lz    = (z as usize) & 15;
        let z_off = (band - b_lo) * 8192 + lz; // offset into band-scoped clone
        for x in x1..=x2 {
            let cx     = x / 16 + min_x;
            let lx_256 = (x & 15) as usize * 256;     // lx * 256, constant for this X column
            let out    = (x - x1) as usize * 4;
            // Scan Y in 16-block chunk rows — one chunk lookup per row instead of per block
            let mut y = y1;
            'y_scan: while y <= y2 {
                let cy          = y / 16 + min_y;
                let chunk_y_end = (y | 15).min(y2);    // last y index in same chunk row
                match world.chunk_bytes(cx, cy) {
                    None => { y = chunk_y_end + 1; }   // chunk absent, skip row
                    Some(chunk) => {
                        let base = z_off + lx_256;     // constant for this chunk×x×z
                        while y <= chunk_y_end {
                            // Shaped selection: an unmasked (x,y) column is see-through, so a
                            // masked block on a chunk row behind it shows correctly.
                            if mask.is_some_and(|m| !m.contains(x, y)) { y += 1; continue; }
                            let bi = base + (y & 15) as usize * 16;
                            let pi = bi + 4096;
                            if pi < chunk.len() {
                                let bt = chunk[bi];
                                if bt != 0 {
                                    let [r, g, b] = block_color(bt, chunk[pi], meta.sky);
                                    row_pixels[out]     = r;
                                    row_pixels[out + 1] = g;
                                    row_pixels[out + 2] = b;
                                    row_pixels[out + 3] = 255;
                                    break 'y_scan;
                                }
                            }
                            y += 1;
                        }
                    }
                }
            }
        }
    });
    (pw, ph, pixels)
}

/// Side view: Y=horizontal, Z=vertical; scans X left-to-right, stops at first non-air block.
#[allow(clippy::too_many_arguments)]
pub fn view_side(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    x1: i32, x2: i32, y1: i32, y2: i32, z_min: i32, z_max: i32,
    b_lo: usize,
    mask: Option<&SelectionMask>,
) -> (u32, u32, Vec<u8>) {
    let (min_x, min_y) = world.chunk_origin();
    let pw = (y2 - y1 + 1) as u32;
    let ph = (z_max - z_min + 1) as u32;
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    // Row-parallel (audit R2-4) — same transposition as `view_front`.
    pixels.par_chunks_mut((pw * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let z     = z_max - row as i32;
        let band  = (z as usize) / 16;
        let lz    = (z as usize) & 15;
        let z_off = (band - b_lo) * 8192 + lz; // offset into band-scoped clone
        for y in y1..=y2 {
            let cy    = y / 16 + min_y;
            let ly_16 = (y & 15) as usize * 16;        // ly * 16, constant for this Y column
            let out   = (y - y1) as usize * 4;
            let mut x = x1;
            'x_scan: while x <= x2 {
                let cx          = x / 16 + min_x;
                let chunk_x_end = (x | 15).min(x2);
                match world.chunk_bytes(cx, cy) {
                    None => { x = chunk_x_end + 1; }
                    Some(chunk) => {
                        let base = z_off + ly_16;      // constant for this chunk×y×z
                        while x <= chunk_x_end {
                            // Shaped selection: an unmasked (x,y) column is see-through so a
                            // masked block behind it along X shows correctly.
                            if mask.is_some_and(|m| !m.contains(x, y)) { x += 1; continue; }
                            let bi = base + (x & 15) as usize * 256;
                            let pi = bi + 4096;
                            if pi < chunk.len() {
                                let bt = chunk[bi];
                                if bt != 0 {
                                    let [r, g, b] = block_color(bt, chunk[pi], meta.sky);
                                    row_pixels[out]     = r;
                                    row_pixels[out + 1] = g;
                                    row_pixels[out + 2] = b;
                                    row_pixels[out + 3] = 255;
                                    break 'x_scan;
                                }
                            }
                            x += 1;
                        }
                    }
                }
            }
        }
    });
    (pw, ph, pixels)
}

/// Top view: X=horizontal, Y=vertical; scans Z from z_max down to z_min.
/// One chunk lookup per (x,y) pair, amortized over the full z-depth scan.
#[allow(clippy::too_many_arguments)]
pub fn view_top(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    x1: i32, x2: i32, y1: i32, y2: i32, z_min: i32, z_max: i32,
    b_lo: usize,
    mask: Option<&SelectionMask>,
) -> (u32, u32, Vec<u8>) {
    let (min_x, min_y) = world.chunk_origin();
    let pw = (x2 - x1 + 1) as u32;
    let ph = (y2 - y1 + 1) as u32;
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    // Row-parallel (audit R2-4): one rayon task per output row (constant Y). Loop nesting swapped
    // from column-outer/row-inner to row-outer/column-inner — the same (x,y) chunk-lookup count,
    // just reordered for parallelism.
    pixels.par_chunks_mut((pw * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let y  = y1 + row as i32;
        let cy = y / 16 + min_y;
        for x in x1..=x2 {
            let cx     = x / 16 + min_x;
            let lx_256 = (x & 15) as usize * 256;
            let out    = (x - x1) as usize * 4;
            // Shaped selection: an unmasked (x,y) column isn't part of the selection, so it stays
            // VOID — the top view shows the actual footprint, not the enclosing bbox.
            if mask.is_some_and(|m| !m.contains(x, y)) { continue; }
            if let Some(chunk) = world.chunk_bytes(cx, cy) {
                let base = lx_256 + (y & 15) as usize * 16;     // constant for this x,y
                for z in (z_min..=z_max).rev() {
                    let bi = base + (z as usize / 16 - b_lo) * 8192 + (z as usize & 15);
                    let pi = bi + 4096;
                    if pi < chunk.len() {
                        let bt = chunk[bi];
                        if bt != 0 {
                            let [r, g, b] = block_color(bt, chunk[pi], meta.sky);
                            row_pixels[out]     = r;
                            row_pixels[out + 1] = g;
                            row_pixels[out + 2] = b;
                            row_pixels[out + 3] = 255;
                            break;
                        }
                    }
                }
            }
        }
    });
    (pw, ph, pixels)
}

// ── Paste lens (UI redesign r3, stage 14.8) ─────────────────────────────────────────────────────
//
// A front or side elevation of an *armed* paste: the clipboard ghost drawn at the Z it would land
// at, over the terrain it would land in, with the cells where the two collide marked. It needs its
// own render because "buried" is a 3-D intersection along the projection ray — the ghost's first
// solid and the terrain's first solid can both be present at a pixel without ever sharing a cell,
// so no composite of the two existing silhouettes can derive it (paste-lens sub-plan §1).

/// Overlay colours. They mirror the frontend theme's `MAP.clipboard`/`MAP.buried`/`MAP.cleared`
/// (`apps/vuencedit/src/theme/theme.ts`) — the crate can't import the theme, and the lens image is
/// drawn straight onto a canvas, so the values are duplicated here on purpose. Keep them in step.
/// `BURIED`/`CLEARED` are *tints* laid over the block's own colour (see [`lens_clash_px`]), no longer
/// flat fills; the legend swatches in `PasteLensWindow.tsx` draw the same hatch.
pub const LENS_CLIPBOARD_RGB: [u8; 3] = [0x22, 0xc5, 0x5e];
pub const LENS_BURIED_RGB: [u8; 3] = [0xef, 0x44, 0x44];
pub const LENS_CLEARED_RGB: [u8; 3] = [0xf5, 0x9e, 0x0b];

/// Clash pixels keep the block's own colour underneath and lay the state tint over it: a **diagonal
/// hatch** (tint at [`LENS_HATCH_PCT`] on every [`LENS_HATCH_PERIOD`]th diagonal) over a light wash
/// (tint at [`LENS_WASH_PCT`]), so what's being pasted stays readable through the warning.
pub const LENS_HATCH_PERIOD: i64 = 4;
pub const LENS_HATCH_PCT: u32 = 70;
pub const LENS_WASH_PCT: u32 = 25;

/// Is `phase` (an anti-diagonal coordinate, `col + z` or `col + row`) on a hatch stripe?
#[inline]
pub fn lens_hatch(phase: i64) -> bool { phase.rem_euclid(LENS_HATCH_PERIOD) == 0 }

/// A clash pixel: `base` (the block underneath) with `tint` laid over it, at hatch or wash strength.
pub fn lens_clash_px(base: [u8; 3], tint: [u8; 3], hatch: bool) -> [u8; 4] {
    let t = if hatch { LENS_HATCH_PCT } else { LENS_WASH_PCT };
    let mix = |b: u8, c: u8| ((b as u32 * (100 - t) + c as u32 * t + 50) / 100) as u8;
    [mix(base[0], tint[0]), mix(base[1], tint[1]), mix(base[2], tint[2]), 255]
}

/// A ghost-solid block's lens colour: its own colour mixed 35 % toward clipboard green.
fn lens_ghost_rgb(bt: u8, paint: u8, sky: u8) -> [u8; 3] {
    let [r, g, b] = block_color(bt, paint, sky);
    let mix = |c: u8, t: u8| ((c as u32 * 65 + t as u32 * 35 + 50) / 100) as u8;
    [mix(r, LENS_CLIPBOARD_RGB[0]), mix(g, LENS_CLIPBOARD_RGB[1]), mix(b, LENS_CLIPBOARD_RGB[2])]
}

/// Tallest Z window the lens will render. A 256z world is exactly this tall, so today it only
/// matters for a hypothetical taller format; the window is re-centred on the ghost if it's exceeded.
const LENS_MAX_ROWS: i32 = 256;
/// Blocks of margin above/below the ghost ∪ terrain-top range.
const LENS_Z_MARGIN: i32 = 4;
/// Above this many clipboard cells the stats pass strides dx/dy and reports `approx`.
const LENS_EXACT_CELLS: u64 = 16 * 1024 * 1024;

/// The clipboard as the lens reads it. `types`/`paints` are the clipboard's dense arrays, indexed
/// `dz*h*w + dy*w + dx`. `base[dy*w + dx]` is the world Z the column's `dz = 0` cell lands at, or
/// [`LENS_SKIP`] for a column the paste won't write (outside a shaped footprint, or — in terrain
/// mode — a column with no surface). The app computes `base` with the **same helper its paste
/// command uses**, which is the whole guarantee that the lens and the paste agree.
pub struct ClipRef<'a> {
    pub w: usize,
    pub h: usize,
    pub d: usize,
    pub types: &'a [u8],
    pub paints: &'a [u8],
    pub base: &'a [i32],
}

/// `base` sentinel: this column is not pasted.
pub const LENS_SKIP: i32 = i32::MIN;

/// Which elevation. **Front** looks north: image columns are world X, the ray runs +Y. **Side**
/// looks east: image columns are world Y, the ray runs +X. Same axes as the selection lens and the
/// clipboard silhouette the app tests it against, so they never disagree on handedness.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LensView { Front, Side }

/// Everything the lens header reports beyond the raster's own dimensions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LensStats {
    /// World coordinate (X for front, Y for side) of image column 0.
    pub col_lo: i32,
    /// World coordinates of the footprint's first/last column along the image axis.
    pub footprint_lo: i32,
    pub footprint_hi: i32,
    /// World Z of the bottom (last) and top (first) image rows.
    pub z_lo: i32,
    pub z_hi: i32,
    /// Z extent of the ghost over non-skipped columns, before clamping to the world. `None` when
    /// every column is skipped (nothing would be pasted).
    pub ghost_z_min: Option<i32>,
    pub ghost_z_max: Option<i32>,
    /// Clipboard-solid cells that land on world-occupied cells (the paste overwrites terrain).
    pub buried: u64,
    /// Clipboard-air cells that land on world-occupied cells while "Skip air" is off (the paste
    /// deletes terrain). Always 0 with `ignore_air`.
    pub cleared: u64,
    /// Pasted columns whose lowest written solid cell would have air directly beneath it.
    pub floating_cols: u64,
    /// The three counts above were estimated from a strided sample (huge clipboards).
    pub approx: bool,
}

/// Render the paste lens. See the section comment above and `LensStats` for the outputs.
///
/// - `x`, `y`: the paste origin — the top-left the paste commands take.
/// - `context`: terrain-only columns drawn at 50 % either side of the footprint.
/// - `ignore_air`: the paste's "Skip air". Off ⇒ the box's air cells delete terrain (*cleared*).
/// - `max_px`: widest image before column LOD kicks in. Only columns are sampled — Z rows are
///   always 1:1 (at most [`LENS_MAX_ROWS`]), and the depth ray is always walked in full, because
///   a sampled ray would miss collisions.
///
/// Pixel classes, highest priority first: **buried** (red hatch + wash over the ghost block's colour)
/// — some cell along the ray is both ghost-solid and world-occupied; **cleared** (amber hatch + wash
/// over the ghost block, or the terrain being deleted where there is none; only with `ignore_air`
/// off) — some cell is box-air over world-occupied; **ghost** — the first
/// ghost-solid block's colour mixed 35 % toward clipboard green; **terrain** — the first
/// world-occupied block's colour (50 % alpha in context columns); else transparent. "Occupied" is
/// any non-air block, fluids included: the paste overwrites water just as it overwrites stone.
///
/// Terrain is drawn **uncapped** even in cutaway — a cutaway hides a roof, it doesn't remove it,
/// and a paste under a hidden overhang is still buried. (The terrain-mode *bases* use the capped
/// surface, because that's what the paste itself uses; that's the caller's job.)
#[allow(clippy::too_many_arguments)]
pub fn paste_lens(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    x: i32, y: i32, clip: &ClipRef,
    view: LensView, context: i32, ignore_air: bool, max_px: u32,
) -> (Raster, LensStats) {
    let (w, h, d) = (clip.w, clip.h, clip.d);
    let max_z = world_max_z(world);
    let context = context.max(0);

    // ── Z window ─────────────────────────────────────────────────────────────────────────────
    let mut ghost_min = i32::MAX;
    let mut ghost_max = i32::MIN;
    for &b in clip.base.iter().filter(|&&b| b != LENS_SKIP) {
        ghost_min = ghost_min.min(b);
        ghost_max = ghost_max.max(b.saturating_add(d as i32 - 1));
    }
    let has_ghost = ghost_min <= ghost_max;
    let mut terr_min = i32::MAX;
    let mut terr_max = i32::MIN;
    for dy in 0..h {
        for dx in 0..w {
            // `surface_z` already starts at the chunk's `top_band_hint`, so this touches no air pages.
            if let Some(s) = surface_z(world, x + dx as i32, y + dy as i32) {
                terr_min = terr_min.min(s);
                terr_max = terr_max.max(s);
            }
        }
    }
    let (lo, hi) = match (has_ghost, terr_min <= terr_max) {
        (true, true) => (ghost_min.min(terr_min), ghost_max.max(terr_max)),
        (true, false) => (ghost_min, ghost_max),
        (false, true) => (terr_min, terr_max),
        (false, false) => (0, 15.min(max_z)),
    };
    let mut z_lo = lo.saturating_sub(LENS_Z_MARGIN).clamp(0, max_z);
    let mut z_hi = hi.saturating_add(LENS_Z_MARGIN).clamp(0, max_z);
    if z_hi < z_lo { std::mem::swap(&mut z_lo, &mut z_hi); }
    if z_hi - z_lo + 1 > LENS_MAX_ROWS {
        let mid = if has_ghost { ghost_min / 2 + ghost_max / 2 } else { (z_lo + z_hi) / 2 };
        z_lo = (mid - LENS_MAX_ROWS / 2).clamp(0, (max_z - LENS_MAX_ROWS + 1).max(0));
        z_hi = (z_lo + LENS_MAX_ROWS - 1).min(max_z);
    }
    let rows = (z_hi - z_lo + 1) as usize;

    // ── Columns ──────────────────────────────────────────────────────────────────────────────
    // Image axis = world X (front) / Y (side); ray axis = the other one.
    let (fp_lo, fp_len, ray_lo, ray_len) = match view {
        LensView::Front => (x, w, y, h),
        LensView::Side => (y, h, x, w),
    };
    let LensFrame { col_lo, lod, out_w } = lens_frame(fp_lo, fp_len, context, max_px);

    let (world_w, world_h) = (meta.width(), meta.height());
    let column = |wx: i32, wy: i32| lens_column(world, world_w, world_h, wx, wy);
    let read = lens_read;

    // One rayon task per output column: each walks its whole ray once, keeping per-row state, so a
    // chunk is resolved once per (column, ray step) rather than once per pixel.
    let columns: Vec<Vec<u8>> = (0..out_w).into_par_iter().map(|ox| {
        let cw = col_lo + (ox * lod) as i32;
        let fc = cw - fp_lo; // footprint column index, valid iff 0 ≤ fc < fp_len
        let in_fp = fc >= 0 && (fc as usize) < fp_len;
        let mut terr: Vec<(u8, u8)> = vec![(0, 0); rows];
        let mut ghost: Vec<(u8, u8)> = vec![(0, 0); rows];
        let mut buried = vec![false; rows];
        let mut cleared = vec![false; rows];
        for k in 0..ray_len {
            let (wx, wy, dx, dy) = match view {
                LensView::Front => (cw, ray_lo + k as i32, fc, k as i32),
                LensView::Side => (ray_lo + k as i32, cw, k as i32, fc),
            };
            let col = column(wx, wy);
            let base = if in_fp { clip.base[dy as usize * w + dx as usize] } else { LENS_SKIP };
            for (row, z) in (z_lo..=z_hi).rev().enumerate() {
                let (wbt, wpaint) = read(col, z);
                if terr[row].0 == 0 && wbt != 0 { terr[row] = (wbt, wpaint); }
                if base == LENS_SKIP { continue; }
                let dz = z as i64 - base as i64;
                if dz < 0 || dz >= d as i64 { continue; }
                let idx = dz as usize * h * w + dy as usize * w + dx as usize;
                let cbt = clip.types[idx];
                if cbt != 0 {
                    if ghost[row].0 == 0 { ghost[row] = (cbt, clip.paints[idx]); }
                    if wbt != 0 { buried[row] = true; }
                } else if !ignore_air && wbt != 0 {
                    cleared[row] = true;
                }
            }
        }
        let mut out = vec![0u8; rows * 4];
        for row in 0..rows {
            let px = &mut out[row * 4..row * 4 + 4];
            if buried[row] || cleared[row] {
                // Hatch phase is anchored to the world (column + z), so the stripes sit still on the
                // terrain as the ghost moves, and LOD-n stays a point sample of LOD 1 (at a coarse
                // LOD the stripes just coarsen; that only happens for very wide pastes).
                let phase = cw as i64 + (z_hi - row as i32) as i64;
                let base = if ghost[row].0 != 0 {
                    lens_ghost_rgb(ghost[row].0, ghost[row].1, meta.sky)
                } else {
                    block_color(terr[row].0, terr[row].1, meta.sky) // cleared: the terrain being deleted
                };
                let tint = if buried[row] { LENS_BURIED_RGB } else { LENS_CLEARED_RGB };
                px.copy_from_slice(&lens_clash_px(base, tint, lens_hatch(phase)));
            } else if ghost[row].0 != 0 {
                let [r, g, b] = lens_ghost_rgb(ghost[row].0, ghost[row].1, meta.sky);
                px.copy_from_slice(&[r, g, b, 255]);
            } else if terr[row].0 != 0 {
                let [r, g, b] = block_color(terr[row].0, terr[row].1, meta.sky);
                px.copy_from_slice(&[r, g, b, if in_fp { 255 } else { LENS_CONTEXT_ALPHA }]);
            }
        }
        out
    }).collect();
    let pixels = lens_assemble(&columns, rows);

    // ── Stats: exact cell counts over the whole volume (strided for huge clipboards) ─────────
    let cells = (w * h) as u64 * d as u64;
    let stride = if cells <= LENS_EXACT_CELLS { 1 } else {
        lod.max(((cells as f64 / LENS_EXACT_CELLS as f64).sqrt().ceil()) as usize)
    };
    let (buried, cleared, floating) = (0..h).step_by(stride).collect::<Vec<_>>().into_par_iter().map(|dy| {
        let (mut b, mut c, mut f) = (0u64, 0u64, 0u64);
        for dx in (0..w).step_by(stride) {
            let base = clip.base[dy * w + dx];
            if base == LENS_SKIP { continue; }
            let col = column(x + dx as i32, y + dy as i32);
            let mut lowest: Option<i32> = None;
            for dz in 0..d {
                let z = base.saturating_add(dz as i32);
                if z < 0 || z > max_z { continue; } // the paste never writes out-of-range Z
                let idx = dz * h * w + dy * w + dx;
                let wbt = read(col, z).0;
                if clip.types[idx] != 0 {
                    if lowest.is_none() { lowest = Some(z); }
                    if wbt != 0 { b += 1; }
                } else if !ignore_air && wbt != 0 {
                    c += 1;
                }
            }
            // Floating: the lowest written solid has air under it *after* the paste. Inside the box
            // that cell is clipboard air (it's the lowest solid), which the paste writes unless Skip
            // air is on; below the box it's whatever the world has.
            if let Some(z) = lowest {
                if z > 0 {
                    let below_in_box = z > base;
                    let air_below = if below_in_box && !ignore_air { true } else { read(col, z - 1).0 == 0 };
                    if air_below { f += 1; }
                }
            }
        }
        (b, c, f)
    }).reduce(|| (0, 0, 0), |a, b| (a.0 + b.0, a.1 + b.1, a.2 + b.2));
    let scale = (stride * stride) as u64;

    let raster = Raster { x: 0, y: z_lo as u32, width: out_w as u32, height: rows as u32, lod: lod as u32, pixels };
    let stats = LensStats {
        col_lo,
        footprint_lo: fp_lo,
        footprint_hi: fp_lo + fp_len as i32 - 1,
        z_lo, z_hi,
        ghost_z_min: has_ghost.then_some(ghost_min),
        ghost_z_max: has_ghost.then_some(ghost_max),
        buried: buried * scale,
        cleared: cleared * scale,
        floating_cols: floating * scale,
        approx: stride > 1,
    };
    (raster, stats)
}

// ── Selection lens (Stage 20.3) ─────────────────────────────────────────────────────────────────
//
// The no-clipboard sibling of `paste_lens`: front/side elevations of a selection footprint plus
// context columns, full height. Its own function rather than an empty `ClipRef` because the Z
// window, the meaning of the mask, and the stats all differ (plan: `TEST WORLDS/
// lens-selection-mode-plan-2026-10-01.md` §1). The column frame and assembly are shared.

/// A selection as the lens reads it: the bbox, its Z range, and the shaped mask if one applies
/// (the caller resolves it fail-safe, as every mask-aware command does).
pub struct SelRef<'a> {
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
    pub z_min: i32,
    pub z_max: i32,
    pub mask: Option<&'a SelectionMask>,
}

impl SelRef<'_> {
    #[inline]
    fn contains(&self, x: i32, y: i32) -> bool {
        match self.mask {
            Some(m) => m.contains(x, y),
            None => x >= self.x1 && x <= self.x2 && y >= self.y1 && y <= self.y2,
        }
    }
}

/// Everything the selection lens header reports beyond the raster's own dimensions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelLensStats {
    /// World coordinate (X for front, Y for side) of image column 0.
    pub col_lo: i32,
    /// The selection's first/last column along the image axis.
    pub footprint_lo: i32,
    pub footprint_hi: i32,
    /// World Z of the bottom (last) and top (first) image rows.
    pub z_lo: i32,
    pub z_hi: i32,
    /// Highest Z with any block on the raster, context included — lets the window open framed on
    /// the terrain instead of on 256 rows of sky. `None` when the raster is empty.
    pub terrain_z_hi: Option<i32>,
}

/// The selection lens's Z window: the whole world height when it fits in [`LENS_MAX_ROWS`] (every
/// format today), so a z-handle drag never runs off the image. A taller format centres the window
/// on the selection, or on `z_max` (the handle people drag most) when the selection is taller still.
fn sel_lens_z_window(max_z: i32, z_min: i32, z_max: i32) -> (i32, i32) {
    if max_z < LENS_MAX_ROWS { return (0, max_z); }
    let mid = if z_max - z_min < LENS_MAX_ROWS { z_min / 2 + z_max / 2 } else { z_max };
    let z_lo = (mid - LENS_MAX_ROWS / 2).clamp(0, max_z - LENS_MAX_ROWS + 1);
    (z_lo, z_lo + LENS_MAX_ROWS - 1)
}

/// Render the selection lens: a front (looking north: columns = X, ray +Y over `y1..=y2`) or side
/// (looking east: columns = Y, ray +X over `x1..=x2`) elevation of `sel`, with `context` columns
/// either side. Same axes and column LOD as [`paste_lens`]; rows are 1:1 and the ray is never
/// strided (a strided ray would miss the first hit).
///
/// Per pixel: the first block along the ray whose `(x, y)` is in the selection (the mask if any,
/// else the bbox), at full alpha; failing that, the first block at all, at 50 % (context columns,
/// and in-bbox rays that only cross unmasked cells: the mask is see-through). Else transparent.
/// Full height, not clipped to `z_min..z_max` (the z band is the caller's overlay), and uncapped
/// in cutaway, for the same reason as the paste lens.
///
/// Cost: the ray is walked one chunk segment (16 cells) at a time. Rows above every remaining
/// segment's `scan_z_ceiling` can't gain a hit, so the walk stops once each row under that
/// ceiling has its answer; on ordinary terrain that's a few segments in.
pub fn selection_lens(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    sel: &SelRef, view: LensView, context: i32, max_px: u32,
) -> (Raster, SelLensStats) {
    let max_z = world_max_z(world);
    let (z_lo, z_hi) = sel_lens_z_window(max_z, sel.z_min, sel.z_max);
    let rows = (z_hi - z_lo + 1) as usize;

    let (fp_lo, fp_hi, ray_lo, ray_hi) = match view {
        LensView::Front => (sel.x1, sel.x2, sel.y1, sel.y2),
        LensView::Side => (sel.y1, sel.y2, sel.x1, sel.x2),
    };
    let fp_len = (fp_hi - fp_lo + 1).max(1) as usize;
    let LensFrame { col_lo, lod, out_w } = lens_frame(fp_lo, fp_len, context, max_px);
    let (world_w, world_h) = (meta.width(), meta.height());
    let (min_x, min_y) = world.chunk_origin();

    // Ray segments: [start, end] runs that share one chunk along the ray.
    let mut segs: Vec<(i32, i32)> = Vec::new();
    let mut s = ray_lo;
    while s <= ray_hi {
        let e = (s.div_euclid(16) * 16 + 15).min(ray_hi);
        segs.push((s, e));
        s = e + 1;
    }

    let columns: Vec<(Vec<u8>, Option<i32>)> = (0..out_w).into_par_iter().map(|ox| {
        let cw = col_lo + (ox * lod) as i32;
        let in_bbox = cw >= fp_lo && cw <= fp_hi;
        let cell = |r: i32| match view { LensView::Front => (cw, r), LensView::Side => (r, cw) };
        let in_world = |(wx, wy): (i32, i32)| wx >= 0 && wy >= 0 && wx < world_w && wy < world_h;

        // Suffix max of the segments' ceilings: rows above `reach[i]` can't gain a hit from
        // segment `i` on. Only `top_band_hint` is consulted here, never a page.
        let mut reach = vec![-1i32; segs.len() + 1];
        for (i, &(a, _)) in segs.iter().enumerate().rev() {
            let (wx, wy) = cell(a);
            let ceil = if in_world((wx, wy)) {
                scan_z_ceiling(world, wx / 16 + min_x, wy / 16 + min_y).min(z_hi)
            } else { -1 };
            reach[i] = reach[i + 1].max(ceil);
        }

        let mut sel_hit: Vec<(u8, u8)> = vec![(0, 0); rows];
        let mut any_hit: Vec<(u8, u8)> = vec![(0, 0); rows];
        // The rows still waiting for the hit that decides their pixel (a sel hit in a bbox column,
        // any hit in a context column, where no cell can be in the selection), highest Z first.
        // Each cell only visits these, so a row costs nothing once answered.
        let mut open: Vec<i32> = (z_lo..=reach[0]).rev().collect();

        for (i, &(a, b)) in segs.iter().enumerate() {
            // Rows above every remaining segment's ceiling can never be answered: drop them.
            let r = reach[i];
            let above = open.iter().take_while(|&&z| z > r).count();
            open.drain(..above);
            if open.is_empty() { break; }
            let (wx, wy) = cell(a);
            if !in_world((wx, wy)) { continue; }
            let (cx, cy) = (wx / 16 + min_x, wy / 16 + min_y);
            let Some(chunk) = world.chunk_bytes(cx, cy) else { continue };
            let ceil = scan_z_ceiling(world, cx, cy);
            for k in a..=b {
                let (wx, wy) = cell(k);
                let in_sel = in_bbox && sel.contains(wx, wy);
                let col: LensCol = Some((chunk, (wx % 16) as usize * 256 + (wy % 16) as usize * 16, ceil));
                open.retain(|&z| {
                    if z > ceil { return true; }
                    let hit = lens_read(col, z);
                    if hit.0 == 0 { return true; }
                    let row = (z_hi - z) as usize;
                    if any_hit[row].0 == 0 { any_hit[row] = hit; }
                    if in_sel { sel_hit[row] = hit; }
                    !(in_sel || !in_bbox)
                });
                if open.is_empty() { break; }
            }
        }

        let mut out = vec![0u8; rows * 4];
        let mut top = None;
        for row in 0..rows {
            let (hit, a) = if sel_hit[row].0 != 0 { (sel_hit[row], 255) }
                else if any_hit[row].0 != 0 { (any_hit[row], LENS_CONTEXT_ALPHA) }
                else { continue };
            top.get_or_insert(z_hi - row as i32);
            let [r, g, b] = block_color(hit.0, hit.1, meta.sky);
            out[row * 4..row * 4 + 4].copy_from_slice(&[r, g, b, a]);
        }
        (out, top)
    }).collect();

    let terrain_z_hi = columns.iter().filter_map(|c| c.1).max();
    let strips: Vec<Vec<u8>> = columns.into_iter().map(|c| c.0).collect();
    let pixels = lens_assemble(&strips, rows);
    let raster = Raster { x: 0, y: z_lo as u32, width: out_w as u32, height: rows as u32, lod: lod as u32, pixels };
    let stats = SelLensStats { col_lo, footprint_lo: fp_lo, footprint_hi: fp_hi, z_lo, z_hi, terrain_z_hi };
    (raster, stats)
}

/// Top-down view of the selection's z range (20.5): what you'd see looking straight down at
/// `sel.z_min..=sel.z_max`, over the bbox plus `context` columns on every side. Returns
/// `(raster, col_lo, row_lo)`: image pixel `(ox, oy)` is world column
/// `(col_lo + ox·lod, row_lo + oy·lod)` — point sampling, the same H6 contract as
/// [`pixels_patch_lod`]. One LOD serves both axes (`ceil(max(ncols, nrows) / max_px)`, clamped to
/// `1..=MAX_LOD`), so pixels stay square. `Raster.x`/`y` are 0; the origin is the returned pair.
///
/// Per pixel: the first non-air block scanning down from `min(z_max, scan ceiling)` to `z_min`,
/// at full alpha when `(x, y)` is in the selection (the mask if any, else the bbox), at 50 %
/// otherwise (context columns and masked-out in-bbox columns: the mask is see-through, as in
/// [`selection_lens`]). No hit, off-world, or no chunk: transparent (not `VOID`).
///
/// Cost: at most `max_px²` sampled columns, each one chunk resolution plus ≤ `z_max − z_min + 1`
/// (≤ 256) reads with early exit; a column whose chunk top is under `z_min` is free (the ceiling
/// skip never touches a page). Selection-mode only and on demand (the caller's `top` flag), so
/// it's never in the idle path.
pub fn selection_top(
    world: &(impl VoxelView + Sync), meta: ViewMeta,
    sel: &SelRef, context: i32, max_px: u32,
) -> (Raster, i32, i32) {
    let ctx = context.max(0);
    let (col_lo, row_lo) = (sel.x1 - ctx, sel.y1 - ctx);
    let ncols = ((sel.x2 - sel.x1 + 1).max(1) + 2 * ctx) as usize;
    let nrows = ((sel.y2 - sel.y1 + 1).max(1) + 2 * ctx) as usize;
    let lod = ncols.max(nrows).div_ceil(max_px.max(1) as usize).clamp(1, MAX_LOD as usize);
    let (w, h) = ((ncols - 1) / lod + 1, (nrows - 1) / lod + 1);
    let (world_w, world_h) = (meta.width(), meta.height());

    let mut pixels = vec![0u8; w * h * 4];
    pixels.par_chunks_mut(w * 4).enumerate().for_each(|(oy, row)| {
        let wy = row_lo + (oy * lod) as i32;
        for (ox, px) in row.chunks_exact_mut(4).enumerate() {
            let wx = col_lo + (ox * lod) as i32;
            let col = lens_column(world, world_w, world_h, wx, wy);
            let Some((_, _, ceil)) = col else { continue };
            for z in (sel.z_min..=sel.z_max.min(ceil)).rev() {
                let (bt, paint) = lens_read(col, z);
                if bt == 0 { continue; }
                let [r, g, b] = block_color(bt, paint, meta.sky);
                let a = if sel.contains(wx, wy) { 255 } else { LENS_CONTEXT_ALPHA };
                px.copy_from_slice(&[r, g, b, a]);
                break;
            }
        }
    });
    (Raster { x: 0, y: 0, width: w as u32, height: h as u32, lod: lod as u32, pixels }, col_lo, row_lo)
}

/// One world column as the lens reads it: the chunk's bytes, the column's intra-chunk offset, and
/// the chunk's scan ceiling (`top_band_hint`, so reads above it are air without touching the page).
type LensCol<'a> = Option<(&'a [u8], usize, i32)>;

fn lens_column<V: VoxelView>(world: &V, world_w: i32, world_h: i32, wx: i32, wy: i32) -> LensCol<'_> {
    if wx < 0 || wy < 0 || wx >= world_w || wy >= world_h { return None; }
    let (min_x, min_y) = world.chunk_origin();
    let (cx, cy) = (wx / 16 + min_x, wy / 16 + min_y);
    let chunk = world.chunk_bytes(cx, cy)?;
    let col_off = (wx % 16) as usize * 256 + (wy % 16) as usize * 16;
    Some((chunk, col_off, scan_z_ceiling(world, cx, cy)))
}

#[inline]
fn lens_read(c: LensCol<'_>, z: i32) -> (u8, u8) {
    let Some((chunk, col_off, ceil)) = c else { return (0, 0) };
    if z < 0 || z > ceil { return (0, 0); }
    let bi = (z as usize / 16) * 8192 + col_off + (z as usize % 16);
    if bi + 4096 < chunk.len() { (chunk[bi], chunk[bi + 4096]) } else { (0, 0) }
}

/// Alpha of a context (outside-the-footprint) pixel in both lenses.
const LENS_CONTEXT_ALPHA: u8 = 128;

/// The image-column frame both lenses share: image column `ox` is world column `col_lo + ox·lod`
/// (point sampling, phase `col_lo`), `out_w = ceil(ncols / lod) ≤ max_px`.
struct LensFrame { col_lo: i32, lod: usize, out_w: usize }

fn lens_frame(fp_lo: i32, fp_len: usize, context: i32, max_px: u32) -> LensFrame {
    let ncols = fp_len + 2 * context.max(0) as usize;
    let lod = ncols.div_ceil(max_px.max(1) as usize).clamp(1, MAX_LOD as usize);
    LensFrame { col_lo: fp_lo - context.max(0), lod, out_w: (ncols - 1) / lod + 1 }
}

/// Transpose per-column RGBA strips (each `rows × 4` bytes, top row first) into a row-major raster.
fn lens_assemble(columns: &[Vec<u8>], rows: usize) -> Vec<u8> {
    let out_w = columns.len();
    let mut pixels = vec![0u8; out_w * rows * 4];
    for (ox, col) in columns.iter().enumerate() {
        for row in 0..rows {
            let o = (row * out_w + ox) * 4;
            pixels[o..o + 4].copy_from_slice(&col[row * 4..row * 4 + 4]);
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testworld::TestWorld;

    fn blk(lx: usize, ly: usize, z: i32) -> usize {
        (z / 16) as usize * 8192 + lx * 256 + ly * 16 + (z % 16) as usize
    }

    fn px(r: &Raster, x: u32, y: u32) -> [u8; 4] {
        let o = ((y * r.width + x) * 4) as usize;
        [r.pixels[o], r.pixels[o + 1], r.pixels[o + 2], r.pixels[o + 3]]
    }

    /// The LOD contract (audit H6): pixel `(ox, oy)` of a LOD-`n` raster is *exactly* the block at
    /// `(x1 + ox*n, y1 + oy*n)` — point sampling, not averaging. A phase shift here would put every
    /// coarse tile half a step out of alignment with the fine ones drawn over it.
    #[test]
    fn lod_render_point_samples_the_full_render() {
        let mut world = TestWorld::new(1, 1, 4);
        for x in 0..16 { for y in 0..16 { world.bytes[blk(x, y, 0)] = 2 + ((x + y) % 3) as u8; } }
        let meta = world.meta();

        let full = pixels_patch_lod(&world, meta, 0, 0, 15, 15, None, 1);
        let lod4 = pixels_patch_lod(&world, meta, 0, 0, 15, 15, None, 4);
        assert_eq!((lod4.width, lod4.height), (4, 4));
        for oy in 0..4 {
            for ox in 0..4 {
                assert_eq!(px(&lod4, ox, oy), px(&full, ox * 4, oy * 4), "lod4 ({ox},{oy})");
            }
        }
    }

    // ── Relief shading (Stage 13.2) ────────────────────────────────────────────────────────────

    /// Put a solid column of `bt` from z0 up to `top` at world (x, y), any chunk.
    fn column(world: &mut TestWorld, x: usize, y: usize, top: i32, bt: u8) {
        let base = world.chunks[&((x / 16) as i32, (y / 16) as i32)];
        for z in 0..=top { world.bytes[base + blk(x % 16, y % 16, z)] = bt; }
    }

    /// Deterministic bumpy terrain over the whole world: heights 2..=40, three block types.
    fn bumpy(w_chunks: u32, h_chunks: u32) -> TestWorld {
        let mut world = TestWorld::new(w_chunks, h_chunks, 4);
        for x in 0..(w_chunks * 16) as usize {
            for y in 0..(h_chunks * 16) as usize {
                let h = 2 + ((x * 7 + y * 13 + (x * y) % 11) % 39) as i32;
                column(&mut world, x, y, h, 2 + ((x + y) % 3) as u8);
            }
        }
        world
    }

    const ON: MapStyle = MapStyle { cap: None, relief: Some(100) };

    /// Relief off must be the pre-13.2 renderer, byte for byte — at every LOD, with and without a
    /// cutaway cap, and for both spellings of "off".
    #[test]
    fn relief_off_is_byte_identical_to_the_plain_render() {
        let world = bumpy(2, 2);
        let meta = world.meta();
        for lod in [1, 2, 4, 8] {
            for cap in [None, Some(20)] {
                let plain = pixels_patch_lod(&world, meta, 0, 0, 31, 31, cap, lod).pixels;
                for relief in [None, Some(0)] {
                    let styled = pixels_patch_styled(&world, meta, 0, 0, 31, 31, MapStyle { cap, relief }, lod);
                    assert_eq!(styled.pixels, plain, "lod {lod} cap {cap:?} relief {relief:?}");
                }
            }
        }
    }

    /// Flat ground has no slope, so shading changes nothing — including a flat lake surface.
    #[test]
    fn flat_terrain_and_flat_water_are_unshaded() {
        let mut world = TestWorld::new(1, 1, 4);
        for x in 0..16 { for y in 0..16 { column(&mut world, x, y, 10, if x < 8 { 2 } else { 3 }); } }
        // A lake: water (bt 20, transparent) one block above the ground, at a constant z.
        for x in 4..12 { for y in 4..12 { world.bytes[blk(x, y, 11)] = 20; } }
        let meta = world.meta();
        let plain = pixels_patch_lod(&world, meta, 0, 0, 15, 15, None, 1);
        let shaded = pixels_patch_styled(&world, meta, 0, 0, 15, 15, ON, 1);
        // The lake's edge *is* a 1-block step (z11 water beside z10 ground), so compare the interior.
        for y in 5..12 { for x in 5..12 { assert_eq!(px(&shaded, x, y), px(&plain, x, y), "({x},{y})"); } }
        for y in 0..4 { for x in 1..16 { assert_eq!(px(&shaded, x, y), px(&plain, x, y), "({x},{y})"); } }
    }

    /// Light from the NW: a sample higher than its west/north neighbours is brighter, lower is darker.
    #[test]
    fn slopes_facing_north_west_are_lit() {
        let mut world = TestWorld::new(1, 1, 4);
        for x in 0..16 { for y in 0..16 { column(&mut world, x, y, 10, 2); } }
        for y in 0..16 { column(&mut world, 8, y, 14, 2); } // a ridge along x = 8
        let meta = world.meta();
        let plain = pixels_patch_lod(&world, meta, 0, 0, 15, 15, None, 1);
        let shaded = pixels_patch_styled(&world, meta, 0, 0, 15, 15, ON, 1);
        let lum = |p: [u8; 4]| p[0] as u32 + p[1] as u32 + p[2] as u32;
        assert!(lum(px(&shaded, 8, 5)) > lum(px(&plain, 8, 5)), "ridge's west face is lit");
        assert!(lum(px(&shaded, 9, 5)) < lum(px(&plain, 9, 5)), "the drop east of it is in shade");
        assert_eq!(px(&shaded, 3, 5), px(&plain, 3, 5), "flat ground away from the ridge");
    }

    /// Tiles (and edit patches) are separate renders of lod-aligned rects; each must read the same
    /// neighbour heights at its edge as one big render would, or the map shows seams.
    #[test]
    fn relief_tiles_have_no_seams() {
        let world = bumpy(4, 4); // 64 × 64
        let meta = world.meta();
        for lod in [1, 2, 4, 8] {
            let whole = pixels_patch_styled(&world, meta, 0, 0, 63, 63, ON, lod);
            for (tx, ty) in [(0, 0), (32, 0), (0, 32), (32, 32), (16, 48)] {
                let tile = pixels_patch_styled(&world, meta, tx, ty, tx + 15, ty + 15, ON, lod);
                for oy in 0..tile.height {
                    for ox in 0..tile.width {
                        let (wx, wy) = (tx as u32 / lod + ox, ty as u32 / lod + oy);
                        assert_eq!(px(&tile, ox, oy), px(&whole, wx, wy), "lod {lod} tile ({tx},{ty}) px ({ox},{oy})");
                    }
                }
            }
        }
    }

    /// Off the world's edge, and next to an empty (air) column, the neighbour height falls back to
    /// the sample's own — unshaded, never a cliff into nothing.
    #[test]
    fn world_edges_and_empty_neighbours_are_unshaded() {
        let mut world = TestWorld::new(1, 1, 4);
        for x in 1..16 { for y in 1..16 { column(&mut world, x, y, 30, 2); } } // row/col 0 are air
        let meta = world.meta();
        let plain = pixels_patch_lod(&world, meta, 0, 0, 15, 15, None, 1);
        let shaded = pixels_patch_styled(&world, meta, 0, 0, 15, 15, ON, 1);
        assert_eq!(shaded.pixels, plain.pixels);
    }

    /// A missing chunk is air, not a panic and not another chunk's terrain — the sparse-world case
    /// every renderer hits constantly.
    #[test]
    fn a_missing_chunk_renders_as_empty() {
        let mut world = TestWorld::new(2, 1, 4);
        for y in 0..16 { world.bytes[blk(0, y, 0)] = 2; }
        world.drop_chunk(1, 0);
        let meta = world.meta();

        let map = pixels_patch(&world, meta, 0, 0, 31, 15, None);
        assert_eq!(px(&map, 0, 0)[3], 255, "populated chunk drew");
        assert_eq!(px(&map, 16, 0), [0, 0, 0, 0], "dropped chunk left untouched");

        let slice = zslice_patch(&world, meta, 0, 0, 0, 31, 15);
        assert_eq!(px(&slice, 16, 0), VOID, "dropped chunk stays void in the z-slice");
    }

    /// The cutaway cap makes the map draw what sits *under* the cut plane, which is the whole point
    /// of the mode — a roof above the cap must not be what you see.
    #[test]
    fn the_cutaway_cap_hides_blocks_above_it() {
        let mut world = TestWorld::new(1, 1, 4);
        world.bytes[blk(3, 5, 0)] = 2;  // stone floor
        world.bytes[blk(3, 5, 8)] = 13; // brick roof
        let meta = world.meta();

        let uncapped = pixels_patch(&world, meta, 3, 5, 3, 5, None);
        let capped = pixels_patch(&world, meta, 3, 5, 3, 5, Some(4));
        assert_eq!(px(&uncapped, 0, 0)[..3], crate::colors::block_color(13, 0, 0)[..], "roof on top");
        assert_eq!(px(&capped, 0, 0)[..3], crate::colors::block_color(2, 0, 0)[..], "cap reveals the floor");
    }

    /// The two vertical slabs are transposes of each other over the same column, and both put the
    /// highest Z on image row 0.
    #[test]
    fn the_vertical_slabs_put_high_z_on_row_zero() {
        let mut world = TestWorld::new(1, 1, 4);
        world.bytes[blk(3, 5, 0)] = 2;
        world.bytes[blk(3, 5, 3)] = 13;
        let meta = world.meta();

        let front = yslice_patch(&world, meta, 5, 3, 0, 3, 3); // x=3 only, z 0..=3
        assert_eq!(front.height, 4);
        assert_eq!(px(&front, 0, 0)[..3], crate::colors::block_color(13, 0, 0)[..], "row 0 is z=3");
        assert_eq!(px(&front, 0, 3)[..3], crate::colors::block_color(2, 0, 0)[..], "last row is z=0");

        let side = xslice_patch(&world, meta, 3, 5, 0, 5, 3); // y=5 only, z 0..=3
        assert_eq!(px(&side, 0, 0)[..3], px(&front, 0, 0)[..3]);
        assert_eq!(px(&side, 0, 3)[..3], px(&front, 0, 3)[..3]);
    }

    /// A shaped selection punches a real hole in the ortho views: the top view leaves the unmasked
    /// column void, and the front view sees *through* it to whatever is behind.
    #[test]
    fn the_ortho_views_honour_a_shaped_mask() {
        let mut world = TestWorld::new(1, 1, 4);
        world.bytes[blk(3, 5, 0)] = 2;  // front column (lower y)
        world.bytes[blk(3, 6, 0)] = 13; // column behind it
        let meta = world.meta();
        // bbox (3,5)-(3,6); bit 0 = (3,5) clear, bit 1 = (3,6) set.
        let mask = SelectionMask { x1: 3, y1: 5, x2: 3, y2: 6, bits: vec![0b10] };

        let (_, _, top) = view_top(&world, meta, 3, 3, 5, 6, 0, 0, 0, Some(&mask));
        assert_eq!(&top[0..4], &VOID, "masked-out column stays void in the top view");
        assert_eq!(&top[4..7], &crate::colors::block_color(13, 0, 0)[..]);

        let (_, _, front) = view_front(&world, meta, 3, 3, 5, 6, 0, 0, 0, Some(&mask));
        assert_eq!(&front[0..3], &crate::colors::block_color(13, 0, 0)[..],
            "front view sees through the hole to the block behind");
    }

    /// `ski = 0` collapses the axonometric projection to a plain top-down render — the property
    /// that makes the parallax math checkable at all.
    #[test]
    fn axo_with_no_skew_matches_the_top_down_map() {
        let mut world = TestWorld::new(1, 1, 4);
        for x in 0..16 { for y in 0..16 { world.bytes[blk(x, y, (x % 4) as i32)] = 2 + (y % 5) as u8; } }
        let meta = world.meta();
        let flat = axo_region(&world, meta, 0, 0, 15, 15, 0.0, 0);
        let top = pixels_patch(&world, meta, 0, 0, 15, 15, None);
        // The axo render's background is opaque grey where the map leaves transparent; every drawn
        // pixel must agree.
        for i in (0..top.pixels.len()).step_by(4) {
            if top.pixels[i + 3] == 255 {
                assert_eq!(flat.pixels[i..i + 4], top.pixels[i..i + 4], "pixel {}", i / 4);
            }
        }
    }

    /// Stage 13.3: `lod = 1, z_top = None` is `axo_region` byte-for-byte; a coarser LOD is exactly
    /// the fine render point-sampled every `lod`-th pixel; a `z_top` at or above the terrain changes
    /// nothing, while one below it cuts the terrain off.
    #[test]
    fn bounded_axo_is_the_full_render_sampled_down() {
        let mut world = TestWorld::new(1, 1, 4);
        for x in 0..16 { for y in 0..16 { world.bytes[blk(x, y, (x % 4 + y % 3) as i32)] = 2 + ((x + y) % 5) as u8; } }
        let meta = world.meta();
        let full = axo_region(&world, meta, 0, 0, 15, 15, 0.2, 0);
        assert_eq!(axo_region_bounded(&world, meta, 0, 0, 15, 15, 0.2, 0, 1, None).pixels, full.pixels);

        let coarse = axo_region_bounded(&world, meta, 0, 0, 15, 15, 0.2, 0, 4, None);
        assert_eq!((coarse.width, coarse.height, coarse.lod), (4, 4, 4));
        for row in 0..4usize { for col in 0..4usize {
            let fi = ((row * 4) * 16 + col * 4) * 4;
            let ci = (row * 4 + col) * 4;
            assert_eq!(coarse.pixels[ci..ci + 4], full.pixels[fi..fi + 4], "({col},{row})");
        } }

        // Terrain tops out below z=16, so with no parallax any ceiling ≥ 16 is a no-op…
        let flat = axo_region(&world, meta, 0, 0, 15, 15, 0.0, 0);
        assert_eq!(axo_region_bounded(&world, meta, 0, 0, 15, 15, 0.0, 0, 1, Some(20)).pixels, flat.pixels);
        // …a ceiling of 0 sees only the z=0 layer…
        assert_ne!(axo_region_bounded(&world, meta, 0, 0, 15, 15, 0.0, 0, 1, Some(0)).pixels, flat.pixels);
        // …and with parallax the ceiling is the plane the picture is anchored to, so it shifts.
        assert_ne!(axo_region_bounded(&world, meta, 0, 0, 15, 15, 0.2, 0, 1, Some(20)).pixels, full.pixels);
    }

    #[test]
    fn axo_lod_keeps_the_long_side_in_bounds() {
        assert_eq!(axo_lod_for(200, 100, 512), 1);
        assert_eq!(axo_lod_for(512, 512, 512), 1);
        assert_eq!(axo_lod_for(513, 10, 512), 2);
        assert_eq!(axo_lod_for(7216, 8448, 512), 32); // 8448/16 = 528 > 512
        assert!(8448u32.div_ceil(32) <= 512);
    }

    // ── paste lens ────────────────────────────────────────────────────────────────────────────

    /// Tiny deterministic PRNG so the oracle tests need no dev-dependency.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }
        fn below(&mut self, n: u32) -> u32 { self.next() % n }
    }

    struct Clip { w: usize, h: usize, d: usize, types: Vec<u8>, paints: Vec<u8>, base: Vec<i32> }
    impl Clip {
        fn r(&self) -> ClipRef<'_> {
            ClipRef { w: self.w, h: self.h, d: self.d, types: &self.types, paints: &self.paints, base: &self.base }
        }
    }

    fn set(world: &mut TestWorld, x: i32, y: i32, z: i32, bt: u8) {
        crate::view::set_block_abs(world, x, y, z, bt, 0);
    }

    /// Random hilly terrain over a 2×2-chunk 64z world, heights 5..=24, a few blocks of other types.
    fn random_terrain(rng: &mut Lcg) -> TestWorld {
        let mut world = TestWorld::new(2, 2, 4);
        for x in 0..32 {
            for y in 0..32 {
                let top = 5 + rng.below(20) as i32;
                for z in 0..=top { set(&mut world, x, y, z, if z == top { 8 } else { 2 }); }
                if rng.below(5) == 0 { set(&mut world, x, y, top + 3, 13); } // a floating block
            }
        }
        world
    }

    fn random_clip(rng: &mut Lcg, w: usize, h: usize, d: usize, skip_every: u32) -> Clip {
        let n = w * h * d;
        let types = (0..n).map(|_| if rng.below(3) == 0 { 0 } else { 13 + rng.below(4) as u8 }).collect();
        let paints = (0..n).map(|_| rng.below(5) as u8).collect();
        let base = (0..w * h).map(|_| {
            if skip_every > 0 && rng.below(skip_every) == 0 { LENS_SKIP } else { 8 + rng.below(14) as i32 }
        }).collect();
        Clip { w, h, d, types, paints, base }
    }

    /// The oracle: a straight triple loop over the clipboard volume, no chunk tricks, no ray walk.
    /// Returns (buried, cleared, per-cell buried set in world coords).
    fn oracle(world: &TestWorld, x: i32, y: i32, c: &Clip, ignore_air: bool)
        -> (u64, u64, std::collections::HashSet<(i32, i32, i32)>)
    {
        let max_z = world_max_z(world);
        let (mut b, mut cl) = (0, 0);
        let mut cells = std::collections::HashSet::new();
        for dz in 0..c.d { for dy in 0..c.h { for dx in 0..c.w {
            let base = c.base[dy * c.w + dx];
            if base == LENS_SKIP { continue; }
            let z = base + dz as i32;
            if z < 0 || z > max_z { continue; }
            let (wx, wy) = (x + dx as i32, y + dy as i32);
            let occupied = crate::view::read_block_abs(world, wx, wy, z) != 0;
            if c.types[dz * c.h * c.w + dy * c.w + dx] != 0 {
                if occupied { b += 1; cells.insert((wx, wy, z)); }
            } else if !ignore_air && occupied { cl += 1; }
        }}}
        (b, cl, cells)
    }

    #[test]
    fn paste_lens_buried_matches_brute_force() {
        let (mut total_buried, mut total_cleared) = (0, 0);
        for seed in 0..6u64 {
            let mut rng = Lcg(seed * 7919 + 1);
            let world = random_terrain(&mut rng);
            let clip = random_clip(&mut rng, 12, 9, 7, 6);
            let (x, y) = (5 + rng.below(8) as i32, 3 + rng.below(8) as i32);
            for ignore_air in [true, false] {
                let (ob, oc, cells) = oracle(&world, x, y, &clip, ignore_air);
                total_buried += ob; total_cleared += oc;
                for view in [LensView::Front, LensView::Side] {
                    let (r, st) = paste_lens(&world, world.meta(), x, y, &clip.r(), view, 3, ignore_air, 512);
                    assert!(!st.approx);
                    assert_eq!(st.buried, ob, "seed {seed} {view:?} ignore_air={ignore_air}: buried");
                    assert_eq!(st.cleared, oc, "seed {seed} {view:?} ignore_air={ignore_air}: cleared");
                    // Every image pixel is a buried-tint pixel iff the oracle has a buried cell on that
                    // pixel's ray, and then it is exactly the hatch/wash over the first ghost block.
                    for ox in 0..r.width {
                        let cw = st.col_lo + ox as i32;
                        for row in 0..r.height {
                            let z = st.z_hi - row as i32;
                            let expect = cells.iter().any(|&(wx, wy, wz)| wz == z && match view {
                                LensView::Front => wx == cw,
                                LensView::Side => wy == cw,
                            });
                            let p = px(&r, ox, row);
                            if !expect { continue; }
                            // First ghost-solid block along the ray at this z, nearest first.
                            let (fp_lo, ray_len) = match view {
                                LensView::Front => (x, clip.h),
                                LensView::Side => (y, clip.w),
                            };
                            let fc = (cw - fp_lo) as usize;
                            let first = (0..ray_len).find_map(|k| {
                                let (dx, dy) = match view { LensView::Front => (fc, k), LensView::Side => (k, fc) };
                                let b = clip.base[dy * clip.w + dx];
                                let dz = z as i64 - b as i64;
                                if b == LENS_SKIP || dz < 0 || dz >= clip.d as i64 { return None; }
                                let i = dz as usize * clip.h * clip.w + dy * clip.w + dx;
                                (clip.types[i] != 0).then_some((clip.types[i], clip.paints[i]))
                            });
                            let (bt, paint) = first.expect("a buried pixel has a ghost block");
                            let want = lens_clash_px(lens_ghost_rgb(bt, paint, world.meta().sky), LENS_BURIED_RGB, lens_hatch(cw as i64 + z as i64));
                            assert_eq!(p, want, "seed {seed} {view:?} pixel ({ox},{row}) z={z}");
                        }
                    }
                }
            }
        }
        assert!(total_buried > 50 && total_cleared > 50, "fixture must actually collide ({total_buried}, {total_cleared})");
    }

    #[test]
    fn lens_clash_px_keeps_block_and_tint() {
        let base = [100, 120, 140];
        let hatch = lens_clash_px(base, LENS_BURIED_RGB, true);
        let wash = lens_clash_px(base, LENS_BURIED_RGB, false);
        assert_eq!((hatch[3], wash[3]), (255, 255));
        // Both carry the tint (red up) and the block (blue still well above the tint's 0x44)...
        for p in [hatch, wash] {
            assert!(p[0] > base[0] && p[2] > LENS_BURIED_RGB[2]);
        }
        // ...the stripe leans further to the tint than the wash does, and neither is flat red.
        assert!(hatch[0] > wash[0]);
        assert_ne!(hatch[..3], LENS_BURIED_RGB[..]);
        // Stripes repeat on a fixed diagonal period, including for negative phases.
        assert!(lens_hatch(0) && lens_hatch(LENS_HATCH_PERIOD) && lens_hatch(-LENS_HATCH_PERIOD));
        assert!(!lens_hatch(1) && !lens_hatch(-1));
    }

    /// On a world mirrored across x = y, with a clipboard and bases mirrored the same way and the
    /// paste origin on the diagonal, the side elevation must be the front elevation exactly.
    #[test]
    fn paste_lens_side_is_transpose_of_front() {
        let mut rng = Lcg(42);
        let mut world = TestWorld::new(2, 2, 4);
        for x in 0..32 { for y in 0..=x {
            let top = 4 + rng.below(12) as i32;
            for z in 0..=top { set(&mut world, x, y, z, 2); set(&mut world, y, x, z, 2); }
        }}
        let n = 6;
        let mut clip = random_clip(&mut rng, n, n, 5, 0);
        for dz in 0..5 { for dy in 0..n { for dx in 0..dy {
            let (a, b) = (dz * n * n + dy * n + dx, dz * n * n + dx * n + dy);
            clip.types[b] = clip.types[a]; clip.paints[b] = clip.paints[a];
        }}}
        for dy in 0..n { for dx in 0..dy { clip.base[dx * n + dy] = clip.base[dy * n + dx]; } }
        for ignore_air in [true, false] {
            let (f, fs) = paste_lens(&world, world.meta(), 9, 9, &clip.r(), LensView::Front, 2, ignore_air, 512);
            let (s, ss) = paste_lens(&world, world.meta(), 9, 9, &clip.r(), LensView::Side, 2, ignore_air, 512);
            assert_eq!(fs, ss);
            assert_eq!((f.width, f.height), (s.width, s.height));
            assert_eq!(f.pixels, s.pixels, "ignore_air={ignore_air}");
        }
    }

    /// The Z window is the ghost ∪ terrain-top range ± 4, clamped to the world on both ends.
    #[test]
    fn paste_lens_z_window_clamps() {
        for bands in [4usize, 16] {
            let max_z = (bands * 16 - 1) as i32;
            let mut world = TestWorld::new(1, 1, bands);
            for x in 0..16 { for y in 0..16 { set(&mut world, x, y, 0, 1); } }
            let one = |base: i32| Clip { w: 1, h: 1, d: 3, types: vec![2, 2, 2], paints: vec![0; 3], base: vec![base] };

            // Ghost on the floor: z_lo clamps to 0 and the bedrock under it is buried.
            let (r, st) = paste_lens(&world, world.meta(), 4, 4, &one(0).r(), LensView::Front, 0, true, 512);
            assert_eq!((st.z_lo, st.z_hi), (0, 2 + 4), "{bands} bands, floor");
            assert_eq!(r.height, 7);
            assert_eq!(st.buried, 1);

            // Ghost poking out of the top: z_hi clamps to max_z, and the out-of-range cell isn't counted.
            let (_, st) = paste_lens(&world, world.meta(), 4, 4, &one(max_z - 1).r(), LensView::Front, 0, true, 512);
            assert_eq!(st.z_hi, max_z, "{bands} bands, ceiling");
            assert_eq!(st.z_lo, 0, "terrain top (0) pulls the window down");
            assert_eq!(st.ghost_z_max, Some(max_z + 1), "ghost range is reported unclamped");
            assert_eq!(st.floating_cols, 1, "lowest written cell hangs over air");
        }
    }

    /// Column LOD is point sampling with phase `col_lo`: LOD-n column `ox` is LOD-1 column `ox*n`.
    #[test]
    fn paste_lens_lod_point_samples() {
        let mut rng = Lcg(7);
        let world = random_terrain(&mut rng);
        let clip = random_clip(&mut rng, 20, 4, 6, 0);
        let (full, _) = paste_lens(&world, world.meta(), 4, 6, &clip.r(), LensView::Front, 4, true, 512);
        assert_eq!((full.width, full.lod), (28, 1));
        let (coarse, st) = paste_lens(&world, world.meta(), 4, 6, &clip.r(), LensView::Front, 4, true, 10);
        assert_eq!((coarse.width, coarse.lod), (10, 3));
        assert_eq!(st.col_lo, 0);
        for ox in 0..coarse.width {
            for row in 0..coarse.height {
                assert_eq!(px(&coarse, ox, row), px(&full, ox * 3, row), "({ox},{row})");
            }
        }
    }

    /// A skipped column (outside a shaped footprint, or no surface in terrain mode) draws no ghost
    /// and counts nothing — it would not be pasted.
    #[test]
    fn paste_lens_respects_skip_columns() {
        let world = TestWorld::new(1, 1, 4); // all air
        let clip = Clip { w: 3, h: 1, d: 2, types: vec![5; 6], paints: vec![0; 6], base: vec![10, LENS_SKIP, 10] };
        let (r, st) = paste_lens(&world, world.meta(), 2, 2, &clip.r(), LensView::Front, 0, false, 512);
        assert_eq!(r.width, 3);
        for row in 0..r.height {
            let z = st.z_hi - row as i32;
            let ghost_here = (10..=11).contains(&z);
            assert_eq!(px(&r, 0, row)[3] == 255, ghost_here, "column 0 z={z}");
            assert_eq!(px(&r, 1, row)[3], 0, "skipped column stays empty at z={z}");
            assert_eq!(px(&r, 2, row)[3] == 255, ghost_here, "column 2 z={z}");
        }
        assert_eq!((st.buried, st.cleared, st.floating_cols), (0, 0, 2));

        // Every column skipped: nothing to paste, no ghost range.
        let none = Clip { base: vec![LENS_SKIP; 3], ..clip };
        let (_, st) = paste_lens(&world, world.meta(), 2, 2, &none.r(), LensView::Side, 0, false, 512);
        assert_eq!((st.ghost_z_min, st.ghost_z_max), (None, None));
    }

    // ── selection lens ────────────────────────────────────────────────────────────────────────

    fn random_mask(rng: &mut Lcg, x1: i32, y1: i32, x2: i32, y2: i32) -> SelectionMask {
        let n = ((x2 - x1 + 1) * (y2 - y1 + 1)) as usize;
        SelectionMask { x1, y1, x2, y2, bits: (0..n.div_ceil(8)).map(|_| rng.next() as u8).collect() }
    }

    /// §2.1 literally: per pixel, walk the ray cell by cell; the first block in the selection wins
    /// at 255, else the first block at all at 128, else transparent.
    fn sel_lens_oracle(world: &TestWorld, sel: &SelRef, view: LensView, cw: i32, z: i32) -> [u8; 4] {
        let (fp_lo, fp_hi, ray) = match view {
            LensView::Front => (sel.x1, sel.x2, sel.y1..=sel.y2),
            LensView::Side => (sel.y1, sel.y2, sel.x1..=sel.x2),
        };
        let mut any = None;
        for k in ray {
            let (wx, wy) = match view { LensView::Front => (cw, k), LensView::Side => (k, cw) };
            let (bt, paint) = crate::view::get_block_at(world, wx, wy, z);
            if wx < 0 || wy < 0 || wx >= world.meta().width() || wy >= world.meta().height() || bt == 0 { continue; }
            let in_sel = (fp_lo..=fp_hi).contains(&cw) && sel.contains(wx, wy);
            if in_sel {
                let [r, g, b] = block_color(bt, paint, world.meta().sky);
                return [r, g, b, 255];
            }
            any.get_or_insert((bt, paint));
        }
        match any {
            Some((bt, paint)) => { let [r, g, b] = block_color(bt, paint, world.meta().sky); [r, g, b, 128] }
            None => [0; 4],
        }
    }

    #[test]
    fn selection_lens_matches_brute_force() {
        for seed in 0..6u64 {
            let mut rng = Lcg(seed * 104729 + 3);
            let world = random_terrain(&mut rng);
            let (x1, y1) = (rng.below(12) as i32, rng.below(12) as i32);
            let (x2, y2) = (x1 + 3 + rng.below(14) as i32, y1 + 3 + rng.below(14) as i32);
            let mask = random_mask(&mut rng, x1, y1, x2, y2);
            for m in [None, Some(&mask)] {
                let sel = SelRef { x1, y1, x2, y2, z_min: 6, z_max: 14, mask: m };
                for view in [LensView::Front, LensView::Side] {
                    let (r, st) = selection_lens(&world, world.meta(), &sel, view, 5, 512);
                    assert_eq!((r.lod, st.z_lo, st.z_hi, r.height), (1, 0, 63, 64));
                    let mut top = None;
                    for ox in 0..r.width {
                        let cw = st.col_lo + ox as i32;
                        for row in 0..r.height {
                            let z = st.z_hi - row as i32;
                            let want = sel_lens_oracle(&world, &sel, view, cw, z);
                            if want[3] != 0 { top = top.max(Some(z)); }
                            assert_eq!(px(&r, ox, row), want, "seed {seed} mask={} {view:?} ({ox},{row}) z={z}", m.is_some());
                        }
                    }
                    assert_eq!(st.terrain_z_hi, top);
                }
            }
        }
    }

    /// Mirrored world, square selection on the diagonal, symmetric mask: side == front exactly.
    #[test]
    fn selection_lens_side_is_transpose_of_front() {
        let mut rng = Lcg(43);
        let mut world = TestWorld::new(2, 2, 4);
        for x in 0..32 { for y in 0..=x {
            let top = 4 + rng.below(20) as i32;
            for z in 0..=top { set(&mut world, x, y, z, 2 + (z % 3) as u8); set(&mut world, y, x, z, 2 + (z % 3) as u8); }
        }}
        let n = 12;
        let mut mask = random_mask(&mut rng, 8, 8, 8 + n - 1, 8 + n - 1);
        for a in 0..n { for b in 0..a {
            let on = mask.contains(8 + a, 8 + b);
            let i = (a * n + b) as usize; // bit of (x = 8+b, y = 8+a)
            mask.bits[i >> 3] = (mask.bits[i >> 3] & !(1 << (i & 7))) | ((on as u8) << (i & 7));
        }}
        for m in [None, Some(&mask)] {
            let sel = SelRef { x1: 8, y1: 8, x2: 8 + n - 1, y2: 8 + n - 1, z_min: 0, z_max: 10, mask: m };
            let (f, fs) = selection_lens(&world, world.meta(), &sel, LensView::Front, 3, 512);
            let (s, ss) = selection_lens(&world, world.meta(), &sel, LensView::Side, 3, 512);
            assert_eq!(fs, ss);
            assert_eq!(f.pixels, s.pixels, "mask={}", m.is_some());
        }
    }

    /// Column LOD is point sampling with phase `col_lo`: LOD-n column `ox` is LOD-1 column `ox*n`.
    #[test]
    fn selection_lens_lod_point_samples() {
        let mut rng = Lcg(8);
        let world = random_terrain(&mut rng);
        let mask = random_mask(&mut rng, 4, 3, 23, 20);
        let sel = SelRef { x1: 4, y1: 3, x2: 23, y2: 20, z_min: 0, z_max: 63, mask: Some(&mask) };
        let (full, _) = selection_lens(&world, world.meta(), &sel, LensView::Front, 4, 512);
        assert_eq!((full.width, full.lod), (28, 1));
        let (coarse, st) = selection_lens(&world, world.meta(), &sel, LensView::Front, 4, 10);
        assert_eq!((coarse.width, coarse.lod, st.col_lo), (10, 3, 0));
        for ox in 0..coarse.width { for row in 0..coarse.height {
            assert_eq!(px(&coarse, ox, row), px(&full, ox * 3, row), "({ox},{row})");
        }}
    }

    /// An unmasked tall column in front of a masked short one: the short one is the sel hit where it
    /// exists, and the tall one only shows (at 128) above it, where nothing masked is behind.
    #[test]
    fn selection_lens_mask_is_see_through() {
        let mut world = TestWorld::new(1, 1, 4);
        for z in 0..=10 { set(&mut world, 3, 5, z, 13); } // front, unmasked
        for z in 0..=3 { set(&mut world, 3, 6, z, 2); }   // behind, masked
        let mask = SelectionMask { x1: 3, y1: 5, x2: 3, y2: 6, bits: vec![0b10] };
        let sel = SelRef { x1: 3, y1: 5, x2: 3, y2: 6, z_min: 0, z_max: 63, mask: Some(&mask) };
        let (r, st) = selection_lens(&world, world.meta(), &sel, LensView::Front, 0, 512);
        let [sr, sg, sb] = block_color(2, 0, 0);
        let [tr, tg, tb] = block_color(13, 0, 0);
        for z in 0..=12 {
            let want = match z { 0..=3 => [sr, sg, sb, 255], 4..=10 => [tr, tg, tb, 128], _ => [0; 4] };
            assert_eq!(px(&r, 0, (st.z_hi - z) as u32), want, "z={z}");
        }
        assert_eq!(st.terrain_z_hi, Some(10));
        // Without the mask the tall front column is in the selection and wins outright.
        let bbox = SelRef { mask: None, ..sel };
        let (r, _) = selection_lens(&world, world.meta(), &bbox, LensView::Front, 0, 512);
        assert_eq!(px(&r, 0, (st.z_hi - 2) as u32), [tr, tg, tb, 255]);
    }

    /// At LOD 1, context 0 the in-selection pixels are exactly `view_top`'s (RGB, alpha 255); where
    /// `view_top` leaves VOID (a masked-out column, or no hit) the lens is the 128-alpha hit or
    /// transparent. With context, every pixel outside the footprint is 128 or transparent.
    #[test]
    fn selection_top_matches_view_top() {
        for seed in 0..6u64 {
            let mut rng = Lcg(seed * 7919 + 11);
            let world = random_terrain(&mut rng);
            let (x1, y1) = (rng.below(12) as i32, rng.below(12) as i32);
            let (x2, y2) = (x1 + 3 + rng.below(14) as i32, y1 + 3 + rng.below(14) as i32);
            let mask = random_mask(&mut rng, x1, y1, x2, y2);
            let (z_min, z_max) = (6, 14);
            for m in [None, Some(&mask)] {
                let sel = SelRef { x1, y1, x2, y2, z_min, z_max, mask: m };
                let (r, col_lo, row_lo) = selection_top(&world, world.meta(), &sel, 0, 512);
                assert_eq!((r.lod, col_lo, row_lo), (1, x1, y1));
                assert_eq!((r.width as i32, r.height as i32), (x2 - x1 + 1, y2 - y1 + 1));
                let (_, _, vt) = view_top(&world, world.meta(), x1, x2, y1, y2, z_min, z_max, 0, m);
                // The unmasked-bbox view_top is the oracle for the 128-alpha see-through hits too.
                let (_, _, full) = view_top(&world, world.meta(), x1, x2, y1, y2, z_min, z_max, 0, None);
                for oy in 0..r.height { for ox in 0..r.width {
                    let (wx, wy) = (x1 + ox as i32, y1 + oy as i32);
                    let i = ((oy * r.width + ox) * 4) as usize;
                    let want_full = &full[i..i + 4];
                    let got = px(&r, ox, oy);
                    let in_sel = m.is_none_or(|mk| mk.contains(wx, wy));
                    if in_sel {
                        assert_eq!(&vt[i..i + 4], want_full);
                        let want = if want_full == VOID { [0; 4] } else { want_full.to_vec().try_into().unwrap() };
                        assert_eq!(got, want, "seed {seed} in-sel ({wx},{wy})");
                    } else if want_full == VOID {
                        assert_eq!(got, [0; 4], "seed {seed} masked-out miss ({wx},{wy})");
                    } else {
                        assert_eq!(got, [want_full[0], want_full[1], want_full[2], LENS_CONTEXT_ALPHA], "seed {seed} masked-out ({wx},{wy})");
                    }
                }}

                // Context ring: same colours, half alpha outside the footprint.
                let (c, clo, rlo) = selection_top(&world, world.meta(), &sel, 3, 512);
                assert_eq!((c.width as i32, c.height as i32, clo, rlo), (x2 - x1 + 7, y2 - y1 + 7, x1 - 3, y1 - 3));
                for oy in 0..c.height { for ox in 0..c.width {
                    let (wx, wy) = (clo + ox as i32, rlo + oy as i32);
                    let p = px(&c, ox, oy);
                    let inside = m.is_none_or(|mk| mk.contains(wx, wy)) && wx >= x1 && wx <= x2 && wy >= y1 && wy <= y2;
                    if inside { assert!(p[3] == 255 || p[3] == 0, "({wx},{wy})"); }
                    else { assert!(p[3] == LENS_CONTEXT_ALPHA || p[3] == 0, "context ({wx},{wy}) alpha {}", p[3]); }
                }}
            }
        }
    }

    /// LOD is point sampling with phase `(col_lo, row_lo)` on both axes, one LOD for both.
    #[test]
    fn selection_top_lod_point_samples() {
        let mut rng = Lcg(21);
        let world = random_terrain(&mut rng);
        let mask = random_mask(&mut rng, 4, 3, 23, 20);
        let sel = SelRef { x1: 4, y1: 3, x2: 23, y2: 20, z_min: 0, z_max: 63, mask: Some(&mask) };
        let (full, _, _) = selection_top(&world, world.meta(), &sel, 4, 512);
        assert_eq!((full.width, full.height, full.lod), (28, 26, 1));
        let (coarse, clo, rlo) = selection_top(&world, world.meta(), &sel, 4, 10);
        // 28 columns / 10 px → LOD 3; (28-1)/3+1 = 10 wide, (26-1)/3+1 = 9 tall.
        assert_eq!((coarse.width, coarse.height, coarse.lod, clo, rlo), (10, 9, 3, 0, -1));
        for oy in 0..coarse.height { for ox in 0..coarse.width {
            assert_eq!(px(&coarse, ox, oy), px(&full, ox * 3, oy * 3), "({ox},{oy})");
        }}
    }

    /// The scan is clipped to `z_min..=z_max`: a block above `z_max` is not seen, the one under it is;
    /// nothing in range is transparent (not VOID).
    #[test]
    fn selection_top_clips_to_z_range() {
        let mut world = TestWorld::new(1, 1, 4);
        set(&mut world, 3, 3, 5, 2);
        set(&mut world, 3, 3, 12, 13); // above z_max
        set(&mut world, 4, 3, 2, 2);   // below z_min
        let sel = SelRef { x1: 3, y1: 3, x2: 4, y2: 3, z_min: 4, z_max: 10, mask: None };
        let (r, _, _) = selection_top(&world, world.meta(), &sel, 0, 512);
        let [sr, sg, sb] = block_color(2, 0, 0);
        assert_eq!(px(&r, 0, 0), [sr, sg, sb, 255], "z=5 under z_max wins over z=12");
        assert_eq!(px(&r, 1, 0), [0; 4], "z=2 is below z_min");
    }

    /// 256z: the raster is the whole world height, so a selection near the top is on it.
    #[test]
    fn selection_lens_256z_full_height() {
        let mut world = TestWorld::new(1, 1, 16);
        for x in 0..16 { for y in 0..16 { set(&mut world, x, y, 0, 1); } }
        set(&mut world, 5, 5, 240, 13);
        let sel = SelRef { x1: 2, y1: 2, x2: 9, y2: 9, z_min: 200, z_max: 255, mask: None };
        let (r, st) = selection_lens(&world, world.meta(), &sel, LensView::Front, 2, 512);
        assert_eq!((st.z_lo, st.z_hi, r.height), (0, 255, 256));
        assert_eq!(px(&r, 5 - st.col_lo as u32, (255 - 240) as u32)[3], 255);
        assert_eq!(st.terrain_z_hi, Some(240));
        // A format taller than LENS_MAX_ROWS centres on the selection, or on z_max if it's taller.
        assert_eq!(sel_lens_z_window(255, 200, 255), (0, 255));
        assert_eq!(sel_lens_z_window(511, 300, 340), (192, 447));
        assert_eq!(sel_lens_z_window(511, 0, 300), (172, 427), "taller than the window: centre on z_max");
        assert_eq!(sel_lens_z_window(511, 0, 511), (256, 511));
    }

    /// 20.3 §6 CPU measurement on a synthetic 4096² 256z world: 16 shared chunk templates (terrain
    /// at z 60–120, every third with an overhang at z 180 so rays stay live past the first chunk).
    /// Shared templates keep it cache-warm, so this is the CPU cost, not the page-fault cost.
    /// `cargo test -p voxel-core bench_selection_lens -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_selection_lens_256z() {
        struct Tiled { templates: Vec<Vec<u8>>, top: Vec<usize> }
        impl VoxelView for Tiled {
            fn num_bands(&self) -> usize { 16 }
            fn chunk_origin(&self) -> (i32, i32) { (0, 0) }
            fn chunk_bytes(&self, cx: i32, cy: i32) -> Option<&[u8]> {
                Some(&self.templates[((cx * 7 + cy * 13) & 15) as usize])
            }
            fn top_band_hint(&self, cx: i32, cy: i32) -> usize { self.top[((cx * 7 + cy * 13) & 15) as usize] }
        }
        let mut rng = Lcg(5);
        let (mut templates, mut top) = (Vec::new(), Vec::new());
        for t in 0..16 {
            let mut c = vec![0u8; 16 * 8192];
            let mut hi = 0;
            for lx in 0..16 { for ly in 0..16 {
                let h = 60 + rng.below(61) as i32;
                for z in 0..=h { c[blk(lx, ly, z)] = if z == h { 8 } else { 2 }; }
                hi = hi.max(h);
                if t % 3 == 0 && lx > 4 && lx < 11 { c[blk(lx, ly, 180)] = 13; hi = hi.max(180); }
            }}
            templates.push(c);
            top.push(hi as usize / 16);
        }
        let world = Tiled { templates, top };
        let meta = ViewMeta { w_chunks: 256, h_chunks: 256, sky: 0 };
        for side in [512, 2048, 4096] {
            let x1 = (4096 - side) / 2;
            let sel = SelRef { x1, y1: x1, x2: x1 + side - 1, y2: x1 + side - 1, z_min: 0, z_max: 255, mask: None };
            let time = |f: &dyn Fn()| (0..3).map(|_| { let t = std::time::Instant::now(); f(); t.elapsed().as_secs_f64() * 1000.0 })
                .fold(f64::MAX, f64::min);
            let fs = time(&|| { rayon::join(
                || selection_lens(&world, meta, &sel, LensView::Front, 2, 512),
                || selection_lens(&world, meta, &sel, LensView::Side, 2, 512)); });
            let tp = time(&|| { selection_top(&world, meta, &sel, 2, 512); });
            eprintln!("[bench] 256z {side}²: front+side {fs:.1} ms, top {tp:.1} ms");
        }
    }

    /// The one-directional hint contract: too high is invisible, too low shows air above it.
    #[test]
    fn selection_lens_respects_top_band_hint() {
        let mut world = TestWorld::new(1, 1, 4);
        for z in 0..=20 { set(&mut world, 4, 4, z, 2); }
        let sel = SelRef { x1: 4, y1: 4, x2: 4, y2: 4, z_min: 0, z_max: 63, mask: None };
        let (exact, _) = selection_lens(&world, world.meta(), &sel, LensView::Side, 0, 512);
        world.top_band_hint = Some(9);
        let (high, _) = selection_lens(&world, world.meta(), &sel, LensView::Side, 0, 512);
        assert_eq!(high.pixels, exact.pixels, "a too-high hint is merely slower");
        world.top_band_hint = Some(0);
        let (low, st) = selection_lens(&world, world.meta(), &sel, LensView::Side, 0, 512);
        assert_eq!(px(&low, 0, (63 - 20) as u32)[3], 0, "z=20 is above a band-0 hint: air");
        assert_eq!(px(&low, 0, (63 - 15) as u32)[3], 255, "z=15 is under it");
        assert_eq!(st.terrain_z_hi, Some(15));
    }
}
