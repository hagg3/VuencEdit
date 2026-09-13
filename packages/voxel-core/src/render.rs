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
use crate::view::{scan_band_ceiling, scan_z_ceiling, world_max_z, ViewMeta, VoxelView};
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
    let lod = lod.clamp(1, MAX_LOD);
    let (min_x, min_y) = world.chunk_origin();
    let num_bands = world.num_bands();
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
        let py = y1 + row as u32 * lod;
        let cy = (py / 16) as i32 + min_y;
        let ly = (py % 16) as usize;
        // The chunk lookup is a hash probe; at lod 1 `cx` only changes every 16 pixels, so memoize
        // it across the run instead of calling it for every sample (audit M3 (1)) — ~16× fewer
        // lookups on a wide patch. At lod ≥ 16 every sample lands in a new chunk and the memo
        // simply never hits, which costs one integer compare.
        let mut last_cx = i32::MIN;
        let mut chunk: Option<&[u8]> = None;
        // The chunk's top-occupied-band ceiling (`VoxelView::top_band_hint`), fetched alongside the
        // chunk and memoized with it — this loop is *the* reason the hint exists (it is the highest
        // page-touch-rate scan in the program), and probing it per sample rather than per chunk
        // would give back much of what it saves.
        let mut hi_band = num_bands;
        for ox in 0..width {
            let px = x1 + ox * lod;
            let cx = (px / 16) as i32 + min_x;
            if cx != last_cx {
                last_cx = cx;
                chunk = world.chunk_bytes(cx, cy);
                hi_band = scan_band_ceiling(world, cx, cy);
            }
            let Some(chunk) = chunk else { continue };
            let lx = (px % 16) as usize;
            let mut top_bt = 0u8; let mut top_paint = 0u8;
            let mut under_bt = 0u8; let mut under_paint = 0u8;
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
                        top_bt = bt; top_paint = chunk[pi];
                        if transparent_alpha(bt).is_none() { break 'outer; }
                    } else {
                        under_bt = bt; under_paint = chunk[pi];
                        break 'outer;
                    }
                }
            }
            if top_bt == 0 { continue; }
            let [r, g, b] = blend_top_over_under(top_bt, top_paint, under_bt, under_paint, meta.sky);
            let off = (ox * 4) as usize;
            row_pixels[off] = r; row_pixels[off + 1] = g; row_pixels[off + 2] = b; row_pixels[off + 3] = 255;
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
    // Each world-X column writes a strided set of bytes across the row-major image, so instead
    // of chunking `pixels` directly we compute one (row, rgba) list per column in parallel and
    // splat them into `pixels` afterward (cheap — only non-void hits produce entries).
    let hits: Vec<Vec<(u32, [u8; 4])>> = (x1..=x2).into_par_iter().map(|px| {
        let mut col = Vec::new();
        let cx = px.div_euclid(16) + min_x;
        let lx = px.rem_euclid(16) as usize;
        let Some(chunk) = world.chunk_bytes(cx, cy) else { return col };
        // Everything above the hint's ceiling is air, which would take the `bt == 0` branch below
        // anyway — so stopping here is output-identical and saves paging in whole bands of a
        // 256z chunk for a caller that always asks for the full 0..=max_z column.
        let z_top = z2.min(scan_z_ceiling(world, cx, cy));
        for z in z1..=z_top {
            let band = (z as usize) / 16;
            let lz   = (z as usize) % 16;
            let bi = band * 8192 + lx * 256 + ly * 16 + lz;
            let pi = bi + 4096;
            if pi >= chunk.len() { continue; }
            let bt = chunk[bi];
            if bt == 0 { continue; }
            let [r, g, b] = block_color(bt, chunk[pi], meta.sky);
            let row = (z2 - z) as u32;
            col.push((row, [r, g, b, 255]));
        }
        col
    }).collect();
    for (i, col) in hits.into_iter().enumerate() {
        let px_off = i as u32;
        for (row, rgba) in col {
            let off = ((row * width + px_off) * 4) as usize;
            pixels[off..off + 4].copy_from_slice(&rgba);
        }
    }
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
    // Same per-column-parallel / sequential-splat approach as `yslice_patch`.
    let hits: Vec<Vec<(u32, [u8; 4])>> = (y1..=y2).into_par_iter().map(|py| {
        let mut col = Vec::new();
        let cy = py.div_euclid(16) + min_y;
        let ly = py.rem_euclid(16) as usize;
        let Some(chunk) = world.chunk_bytes(cx, cy) else { return col };
        // Same band ceiling as `yslice_patch` — see the note there.
        let z_top = z2.min(scan_z_ceiling(world, cx, cy));
        for z in z1..=z_top {
            let band = (z as usize) / 16;
            let lz   = (z as usize) % 16;
            let bi = band * 8192 + lx * 256 + ly * 16 + lz;
            let pi = bi + 4096;
            if pi >= chunk.len() { continue; }
            let bt = chunk[bi];
            if bt == 0 { continue; }
            let [r, g, b] = block_color(bt, chunk[pi], meta.sky);
            let row = (z2 - z) as u32;
            col.push((row, [r, g, b, 255]));
        }
        col
    }).collect();
    for (i, col) in hits.into_iter().enumerate() {
        let py_off = i as u32;
        for (row, rgba) in col {
            let off = ((row * width + py_off) * 4) as usize;
            pixels[off..off + 4].copy_from_slice(&rgba);
        }
    }
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
    let (min_x, min_y) = world.chunk_origin();
    let world_w = meta.width();
    let world_h = meta.height();
    let ox1 = x1.clamp(0, world_w - 1) as u32;
    let oy1 = y1.clamp(0, world_h - 1) as u32;
    let ox2 = x2.clamp(0, world_w - 1) as u32;
    let oy2 = y2.clamp(0, world_h - 1) as u32;
    let width  = ox2 - ox1 + 1;
    let height = oy2 - oy1 + 1;
    let max_z = world_max_z(world) as f32;
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
        let py = oy1 + row as u32;
        for px in ox1..=ox2 {
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
            let off = ((px - ox1) * 4) as usize;
            row_pixels[off] = r; row_pixels[off + 1] = g; row_pixels[off + 2] = b; row_pixels[off + 3] = 255;
        }
    });
    Raster { x: ox1, y: oy1, width, height, lod: 1, pixels }
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
    world: &impl VoxelView, meta: ViewMeta,
    x1: i32, x2: i32, y1: i32, y2: i32, z_min: i32, z_max: i32,
    b_lo: usize,
    mask: Option<&SelectionMask>,
) -> (u32, u32, Vec<u8>) {
    let (min_x, min_y) = world.chunk_origin();
    let pw = (x2 - x1 + 1) as u32;
    let ph = (z_max - z_min + 1) as u32;
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    for x in x1..=x2 {
        let cx     = x / 16 + min_x;
        let lx_256 = (x & 15) as usize * 256;     // lx * 256, constant for this X column
        let col    = (x - x1) as usize;
        for z in z_min..=z_max {
            let band  = (z as usize) / 16;
            let lz    = (z as usize) & 15;
            let z_off = (band - b_lo) * 8192 + lz; // offset into band-scoped clone
            let row   = (z_max - z) as usize;
            let out   = (row * pw as usize + col) * 4;
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
                                    pixels[out]     = r;
                                    pixels[out + 1] = g;
                                    pixels[out + 2] = b;
                                    pixels[out + 3] = 255;
                                    break 'y_scan;
                                }
                            }
                            y += 1;
                        }
                    }
                }
            }
        }
    }
    (pw, ph, pixels)
}

/// Side view: Y=horizontal, Z=vertical; scans X left-to-right, stops at first non-air block.
#[allow(clippy::too_many_arguments)]
pub fn view_side(
    world: &impl VoxelView, meta: ViewMeta,
    x1: i32, x2: i32, y1: i32, y2: i32, z_min: i32, z_max: i32,
    b_lo: usize,
    mask: Option<&SelectionMask>,
) -> (u32, u32, Vec<u8>) {
    let (min_x, min_y) = world.chunk_origin();
    let pw = (y2 - y1 + 1) as u32;
    let ph = (z_max - z_min + 1) as u32;
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    for y in y1..=y2 {
        let cy    = y / 16 + min_y;
        let ly_16 = (y & 15) as usize * 16;        // ly * 16, constant for this Y column
        let col   = (y - y1) as usize;
        for z in z_min..=z_max {
            let band  = (z as usize) / 16;
            let lz    = (z as usize) & 15;
            let z_off = (band - b_lo) * 8192 + lz; // offset into band-scoped clone
            let row   = (z_max - z) as usize;
            let out   = (row * pw as usize + col) * 4;
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
                                    pixels[out]     = r;
                                    pixels[out + 1] = g;
                                    pixels[out + 2] = b;
                                    pixels[out + 3] = 255;
                                    break 'x_scan;
                                }
                            }
                            x += 1;
                        }
                    }
                }
            }
        }
    }
    (pw, ph, pixels)
}

/// Top view: X=horizontal, Y=vertical; scans Z from z_max down to z_min.
/// One chunk lookup per (x,y) pair, amortized over the full z-depth scan.
#[allow(clippy::too_many_arguments)]
pub fn view_top(
    world: &impl VoxelView, meta: ViewMeta,
    x1: i32, x2: i32, y1: i32, y2: i32, z_min: i32, z_max: i32,
    b_lo: usize,
    mask: Option<&SelectionMask>,
) -> (u32, u32, Vec<u8>) {
    let (min_x, min_y) = world.chunk_origin();
    let pw = (x2 - x1 + 1) as u32;
    let ph = (y2 - y1 + 1) as u32;
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    for x in x1..=x2 {
        let cx     = x / 16 + min_x;
        let lx_256 = (x & 15) as usize * 256;
        let col    = (x - x1) as usize;
        for y in y1..=y2 {
            let cy   = y / 16 + min_y;
            let row  = (y - y1) as usize;
            let out  = (row * pw as usize + col) * 4;
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
                            pixels[out]     = r;
                            pixels[out + 1] = g;
                            pixels[out + 2] = b;
                            pixels[out + 3] = 255;
                            break;
                        }
                    }
                }
            }
        }
    }
    (pw, ph, pixels)
}

/// Front view with `ctx` context columns on each side at 50% alpha. `b_lo` is always 0 here — the
/// caller clones whole chunks rather than a band range, because the view spans the full height.
#[allow(clippy::too_many_arguments)]
pub fn view_front_ctx(
    world: &impl VoxelView, meta: ViewMeta,
    sel_x1: i32, sel_x2: i32, y1: i32, y2: i32,
    z_max: i32, ctx: i32,
) -> (u32, u32, Vec<u8>) {
    let (min_x, min_y) = world.chunk_origin();
    let rx1 = sel_x1 - ctx;
    let rx2 = sel_x2 + ctx;
    let pw = (rx2 - rx1 + 1) as u32;
    let ph = (z_max + 1) as u32;
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    for x in rx1..=rx2 {
        // div_euclid handles negative x (context left of world origin).
        // x & 15 == x.rem_euclid(16) for all i32 (two's-complement property).
        let cx     = x.div_euclid(16) + min_x;
        let lx_256 = (x & 15) as usize * 256;
        let col    = (x - rx1) as usize;
        for z in 0..=z_max {
            let band  = (z as usize) / 16;
            let lz    = (z as usize) & 15;
            let z_off = band * 8192 + lz; // b_lo=0 always
            let row   = (z_max - z) as usize;
            let out   = (row * pw as usize + col) * 4;
            let mut y = y1;
            'y_scan: while y <= y2 {
                let cy          = y / 16 + min_y;
                let chunk_y_end = (y | 15).min(y2);
                match world.chunk_bytes(cx, cy) {
                    None => { y = chunk_y_end + 1; }
                    Some(chunk) => {
                        let base = z_off + lx_256;
                        while y <= chunk_y_end {
                            let bi = base + (y & 15) as usize * 16;
                            let pi = bi + 4096;
                            if pi < chunk.len() {
                                let bt = chunk[bi];
                                if bt != 0 {
                                    let [r, g, b] = block_color(bt, chunk[pi], meta.sky);
                                    pixels[out]     = r;
                                    pixels[out + 1] = g;
                                    pixels[out + 2] = b;
                                    break 'y_scan;
                                }
                            }
                            y += 1;
                        }
                    }
                }
            }
        }
    }
    dim_context_columns(&mut pixels, pw, ph, (sel_x1 - rx1) as usize, (sel_x2 + 1 - rx1) as usize);
    (pw, ph, pixels)
}

/// Side view with `ctx` context columns on each side at 50% alpha. `b_lo` is always 0 — see
/// [`view_front_ctx`].
#[allow(clippy::too_many_arguments)]
pub fn view_side_ctx(
    world: &impl VoxelView, meta: ViewMeta,
    x1: i32, x2: i32, sel_y1: i32, sel_y2: i32,
    z_max: i32, ctx: i32,
) -> (u32, u32, Vec<u8>) {
    let (min_x, min_y) = world.chunk_origin();
    let ry1 = sel_y1 - ctx;
    let ry2 = sel_y2 + ctx;
    let pw = (ry2 - ry1 + 1) as u32;
    let ph = (z_max + 1) as u32;
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    for y in ry1..=ry2 {
        let cy    = y.div_euclid(16) + min_y;
        let ly_16 = (y & 15) as usize * 16;
        let col   = (y - ry1) as usize;
        for z in 0..=z_max {
            let band  = (z as usize) / 16;
            let lz    = (z as usize) & 15;
            let z_off = band * 8192 + lz;
            let row   = (z_max - z) as usize;
            let out   = (row * pw as usize + col) * 4;
            let mut x = x1;
            'x_scan: while x <= x2 {
                let cx          = x / 16 + min_x;
                let chunk_x_end = (x | 15).min(x2);
                match world.chunk_bytes(cx, cy) {
                    None => { x = chunk_x_end + 1; }
                    Some(chunk) => {
                        let base = z_off + ly_16;
                        while x <= chunk_x_end {
                            let bi = base + (x & 15) as usize * 256;
                            let pi = bi + 4096;
                            if pi < chunk.len() {
                                let bt = chunk[bi];
                                if bt != 0 {
                                    let [r, g, b] = block_color(bt, chunk[pi], meta.sky);
                                    pixels[out]     = r;
                                    pixels[out + 1] = g;
                                    pixels[out + 2] = b;
                                    break 'x_scan;
                                }
                            }
                            x += 1;
                        }
                    }
                }
            }
        }
    }
    dim_context_columns(&mut pixels, pw, ph, (sel_y1 - ry1) as usize, (sel_y2 + 1 - ry1) as usize);
    (pw, ph, pixels)
}

/// Post-process: drop the columns outside `[left_ctx, right_ctx)` to 50% opacity, so the selection
/// reads against its surroundings without the surroundings competing with it.
fn dim_context_columns(pixels: &mut [u8], pw: u32, ph: u32, left_ctx: usize, right_ctx: usize) {
    for col in (0..left_ctx).chain(right_ctx..(pw as usize)) {
        for row in 0..(ph as usize) {
            pixels[(row * pw as usize + col) * 4 + 3] = 128;
        }
    }
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
}
