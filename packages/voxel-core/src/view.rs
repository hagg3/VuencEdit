//! The `VoxelView` abstraction and the block-addressing primitives built on it.
//!
//! Eden's block storage is the same in both apps: a world is a grid of 16×16 chunks, each holding
//! `num_bands` bands of 16 z-levels, addressed as
//!
//! ```text
//! block byte:  band*8192 + lx*256 + ly*16 + lz
//! paint byte:  that + 4096
//! ```
//!
//! Everything a reader needs is therefore the band count, the chunk-coordinate origin, and "give
//! me the bytes chunk (cx, cy) owns" — which is exactly what `VoxelView` names. That indirection
//! is what lets an app layer a private writable `ChunkScratch` over a live mmapped world, and
//! what lets a differently-backed world hand itself to the same helpers.
//!
//! ⚠️ A chunk slice's length is its *real* span, which is not always the nominal chunk size — an
//! intra-chunk index is in bounds iff it is `< slice.len()`, never `< chunk_size`. Every helper
//! here bounds-checks that way and returns a benign default rather than panicking, because these
//! indices come from world files and network frames.

pub trait VoxelView {
    fn num_bands(&self) -> usize;
    /// The world's chunk-coordinate origin (`min_x`, `min_y`).
    fn chunk_origin(&self) -> (i32, i32);
    /// The bytes chunk `(cx, cy)` owns — length is the chunk's *real* span (see `chunk_span`),
    /// so an intra-chunk index is in bounds iff it is `< slice.len()`.
    fn chunk_bytes(&self, cx: i32, cy: i32) -> Option<&[u8]>;

    /// An **upper bound** on the index of the topmost band of chunk `(cx, cy)` that holds any
    /// non-air block. A top-down scan may start here instead of at `num_bands() - 1`.
    ///
    /// ⚠️ **The contract is one-directional.** Returning too *high* a value is always correct and
    /// merely slower — it is what the default does. Returning too *low* silently reports real
    /// terrain as air to every renderer, to `surface_z`, and therefore to paint, terrain-paste,
    /// sculpt and flood fill: a wrong hint is not a crash, it is quiet data loss. Never "tighten"
    /// this into an exact value that a writer could leave stale.
    ///
    /// **Why it exists:** a 256z chunk is 16 bands, and each band's 4096-byte *block* half is
    /// exactly one page. A top-down column scan on a world whose terrain tops out around z ≈ 64-96
    /// touches ~10 pages of pure air before it reaches anything, per column, on every visit — which
    /// is how panning a multi-GB world drags essentially the whole mapping into the process
    /// working set and keeps re-warming it. With a hint, those pages are touched once per chunk
    /// (to compute it) and then go cold and stay cold.
    ///
    /// The default — "no hint" — is what keeps every implementor correct with zero changes.
    fn top_band_hint(&self, cx: i32, cy: i32) -> usize {
        let _ = (cx, cy);
        self.num_bands().saturating_sub(1)
    }
}

/// The exclusive band ceiling a top-down scan should use: `min(top_band_hint + 1, num_bands)`.
///
/// Written as an exclusive bound because every scan site here is a `for band in (0..N).rev()`, and
/// intersecting with `num_bands()` keeps a degenerate 0-band view producing the empty range it
/// always did.
#[inline]
pub fn scan_band_ceiling(world: &impl VoxelView, cx: i32, cy: i32) -> usize {
    world.top_band_hint(cx, cy).saturating_add(1).min(world.num_bands())
}

/// The highest z a top-down scan of chunk `(cx, cy)` need consider, from the same hint.
/// `-1` when the hint says the chunk has no bands at all.
#[inline]
pub fn scan_z_ceiling(world: &impl VoxelView, cx: i32, cy: i32) -> i32 {
    scan_band_ceiling(world, cx, cy) as i32 * 16 - 1
}

pub trait VoxelViewMut: VoxelView {
    /// Writable twin of `chunk_bytes`. `None` means "this view does not own that chunk" and the
    /// write is dropped — same contract `set_block_abs` has always had for a missing chunk.
    fn chunk_bytes_mut(&mut self, cx: i32, cy: i32) -> Option<&mut [u8]>;
}

/// The handful of *whole-world* facts the renderers need that `VoxelView` deliberately doesn't
/// name, because they are properties of the world rather than of block addressing: how far the
/// chunk grid extends (every renderer clamps its rect to it) and which sky palette `block_color`
/// should resolve grass against.
///
/// ⚠️ Named `ViewMeta`, not `WorldMeta` — the latter is already taken by VuencEdit's IPC struct.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViewMeta {
    /// World width in chunks; the renderers' pixel-space width is `w_chunks * 16`.
    pub w_chunks: u32,
    /// World height in chunks; the renderers' pixel-space height is `h_chunks * 16`.
    pub h_chunks: u32,
    /// Sky-colour index, passed straight through to `block_color` (only grass reads it).
    pub sky: u8,
}

impl ViewMeta {
    /// World width in blocks.
    #[inline]
    pub fn width(&self) -> i32 { (self.w_chunks * 16) as i32 }
    /// World height in blocks.
    #[inline]
    pub fn height(&self) -> i32 { (self.h_chunks * 16) as i32 }
}

/// Read `(block_type, paint)` at absolute world coords in one lookup — `(0, 0)` out of bounds or
/// for a missing chunk. The pair form of [`read_block_abs`] + [`read_paint_abs`], which is what
/// every geometry loop wants (it needs both, and halving the chunk resolutions matters there).
#[inline]
pub fn get_block_at(world: &impl VoxelView, wx: i32, wy: i32, wz: i32) -> (u8, u8) {
    if wz < 0 || wz as usize >= world.num_bands() * 16 { return (0, 0); }
    let (mnx, mny) = world.chunk_origin();
    let cx = wx.div_euclid(16) + mnx;
    let cy = wy.div_euclid(16) + mny;
    if let Some(chunk) = world.chunk_bytes(cx, cy) {
        let lx = wx.rem_euclid(16) as usize;
        let ly = wy.rem_euclid(16) as usize;
        let bi = (wz as usize / 16) * 8192 + lx * 256 + ly * 16 + wz as usize % 16;
        let pi = bi + 4096;
        if pi < chunk.len() { return (chunk[bi], chunk[pi]); }
    }
    (0, 0)
}

pub fn world_max_z(world: &impl VoxelView) -> i32 {
    (world.num_bands() * 16 - 1) as i32
}

/// Returns the z of the topmost non-air block at pixel position (px, py),
/// or None if the column has no chunk or is entirely air.
pub fn surface_z(world: &impl VoxelView, px: i32, py: i32) -> Option<i32> {
    surface_z_capped(world, px, py, None)
}

/// `surface_z` with a cutaway ceiling: the topmost non-air block at or below `cap`. With `cap`
/// set, "the surface" becomes the floor of whatever cavity the cap plane cuts into, which is what
/// makes drawing / terrain-paste / the cursor readout work underground exactly as they do on top.
pub fn surface_z_capped(world: &impl VoxelView, px: i32, py: i32, cap: Option<i32>) -> Option<i32> {
    if px < 0 || py < 0 { return None; }
    let (mnx, mny) = world.chunk_origin();
    let cx = px / 16 + mnx;
    let cy = py / 16 + mny;
    let chunk = world.chunk_bytes(cx, cy)?;
    let lx = (px % 16) as usize;
    let ly = (py % 16) as usize;
    // Start at the chunk's top-occupied-band hint rather than the top of the world — see
    // `VoxelView::top_band_hint`. Everything above it is air by contract, so the only thing this
    // skips is reads that would have returned 0 (and the cold pages holding them).
    for band in (0..scan_band_ceiling(world, cx, cy)).rev() {
        if let Some(c) = cap {
            if (band * 16) as i32 > c { continue; }
        }
        for lz in (0..16usize).rev() {
            if let Some(c) = cap {
                if (band * 16 + lz) as i32 > c { continue; }
            }
            let bi = band * 8192 + lx * 256 + ly * 16 + lz;
            if bi >= chunk.len() { continue; }
            if chunk[bi] != 0 {
                return Some((band * 16 + lz) as i32);
            }
        }
    }
    None
}

/// Write one block at absolute world pixel coordinates using the correct band formula.
/// Out-of-bounds writes (missing chunk, z > max) are silently dropped.
#[inline]
pub fn set_block_abs(world: &mut impl VoxelViewMut, wx: i32, wy: i32, wz: i32, bt: u8, paint: u8) {
    if wz < 0 || wz as usize >= world.num_bands() * 16 { return; }
    let (mnx, mny) = world.chunk_origin();
    let cx = wx.div_euclid(16) + mnx;
    let cy = wy.div_euclid(16) + mny;
    let lx   = wx.rem_euclid(16) as usize;
    let ly   = wy.rem_euclid(16) as usize;
    let band = wz as usize / 16;
    let lz   = wz as usize % 16;
    if let Some(chunk) = world.chunk_bytes_mut(cx, cy) {
        let bi = band * 8192 + lx * 256 + ly * 16 + lz;
        let pi = bi + 4096;
        if pi < chunk.len() {
            chunk[bi] = bt;
            chunk[pi] = paint;
        }
    }
}

/// Read block type at absolute world coords (0 if out of bounds or missing chunk).
pub fn read_block_abs(world: &impl VoxelView, wx: i32, wy: i32, wz: i32) -> u8 {
    if wz < 0 || wz as usize >= world.num_bands() * 16 { return 0; }
    let (mnx, mny) = world.chunk_origin();
    let cx = wx.div_euclid(16) + mnx;
    let cy = wy.div_euclid(16) + mny;
    if let Some(chunk) = world.chunk_bytes(cx, cy) {
        let lx = wx.rem_euclid(16) as usize;
        let ly = wy.rem_euclid(16) as usize;
        let bi = (wz as usize / 16) * 8192 + lx * 256 + ly * 16 + wz as usize % 16;
        if bi < chunk.len() { return chunk[bi]; }
    }
    0
}

/// Read paint byte at absolute world coords (0 if out of bounds or missing chunk).
pub fn read_paint_abs(world: &impl VoxelView, wx: i32, wy: i32, wz: i32) -> u8 {
    if wz < 0 || wz as usize >= world.num_bands() * 16 { return 0; }
    let (mnx, mny) = world.chunk_origin();
    let cx = wx.div_euclid(16) + mnx;
    let cy = wy.div_euclid(16) + mny;
    if let Some(chunk) = world.chunk_bytes(cx, cy) {
        let lx = wx.rem_euclid(16) as usize;
        let ly = wy.rem_euclid(16) as usize;
        let bi = (wz as usize / 16) * 8192 + lx * 256 + ly * 16 + wz as usize % 16;
        let pi = bi + 4096;
        if pi < chunk.len() { return chunk[pi]; }
    }
    0
}

#[cfg(test)]
mod hint_tests {
    //! The [`VoxelView::top_band_hint`] contract, which is one-directional by design: a hint that
    //! is too *high* must be invisible, and a hint that is too *low* must visibly break things.
    //! The second half is asserted deliberately — it is what stops a future reader from
    //! "tightening" the hint into an exact value that a writer could then leave stale.

    use super::*;
    use crate::lamps::scan_chunk_lamps;
    use crate::render;
    use crate::testworld::TestWorld;

    fn blk(lx: usize, ly: usize, z: i32) -> usize {
        (z / 16) as usize * 8192 + lx * 256 + ly * 16 + (z % 16) as usize
    }

    /// A 16-band world whose only terrain is a grass slab at z = 40 (band 2) plus one lamp at
    /// z = 41 — i.e. exactly the shape the hint is for: 13 empty bands above the interesting ones.
    fn world_16b() -> TestWorld {
        let mut w = TestWorld::new(1, 1, 16);
        for lx in 0..16 { for ly in 0..16 { w.bytes[blk(lx, ly, 40)] = 8; } }
        w.bytes[blk(3, 3, 41)] = crate::geometry::LAMP_BLOCK_TYPE;
        w
    }

    /// A view that does **not** override the method, so it exercises the trait's own default.
    /// Every implementor outside this crate (`ChunkScratch`, an app's network-backed world) is in
    /// exactly this position, and must keep working with no changes at all.
    struct Bare(TestWorld);
    impl VoxelView for Bare {
        fn num_bands(&self) -> usize { self.0.num_bands() }
        fn chunk_origin(&self) -> (i32, i32) { self.0.chunk_origin() }
        fn chunk_bytes(&self, cx: i32, cy: i32) -> Option<&[u8]> { self.0.chunk_bytes(cx, cy) }
    }

    #[test]
    fn default_hint_is_the_top_band() {
        let bare = Bare(world_16b());
        assert_eq!(bare.top_band_hint(0, 0), 15);
        assert_eq!(scan_band_ceiling(&bare, 0, 0), 16);
        assert_eq!(scan_z_ceiling(&bare, 0, 0), 255);
    }

    #[test]
    fn an_exact_or_too_high_hint_changes_nothing() {
        let bare = Bare(world_16b());
        let meta = bare.0.meta();
        let reference = render::pixels_patch(&bare, meta, 0, 0, 15, 15, None).pixels;
        let ref_surface: Vec<Option<i32>> =
            (0..16).map(|x| surface_z(&bare, x, x)).collect();
        let ref_lamps = scan_chunk_lamps(&bare, 0, 0);

        // 2 is exact (the slab is band 2, the lamp band 2); 15 is "no hint"; 7 is loose but valid.
        for hint in [2usize, 7, 15] {
            let mut w = world_16b();
            w.top_band_hint = Some(hint);
            assert_eq!(render::pixels_patch(&w, meta, 0, 0, 15, 15, None).pixels, reference,
                "map render must be byte-identical at hint {hint}");
            let got: Vec<Option<i32>> = (0..16).map(|x| surface_z(&w, x, x)).collect();
            assert_eq!(got, ref_surface, "surface_z must be identical at hint {hint}");
            assert_eq!(scan_chunk_lamps(&w, 0, 0), ref_lamps, "lamp scan identical at hint {hint}");
        }
    }

    /// Same, for the 3D mesher and the axonometric renderer — the two other scan sites that adopted
    /// the hint.
    #[test]
    fn a_too_high_hint_changes_nothing_for_geometry_or_axo() {
        let bare = Bare(world_16b());
        let meta = bare.0.meta();
        let mode = crate::geometry::LightMode::default();
        let ref_geom = crate::geometry::obj_geometry_region(
            &bare, meta, None, 0, 0, 15, 15, 0, 255, &[], mode, None);
        let ref_axo = render::axo_region(&bare, meta, 0, 0, 15, 15, 0.2, 0).pixels;

        for hint in [2usize, 9, 15] {
            let mut w = world_16b();
            w.top_band_hint = Some(hint);
            let g = crate::geometry::obj_geometry_region(
                &w, meta, None, 0, 0, 15, 15, 0, 255, &[], mode, None);
            assert_eq!(g.positions, ref_geom.positions, "geometry identical at hint {hint}");
            assert_eq!(g.colors, ref_geom.colors, "geometry colours identical at hint {hint}");
            assert_eq!(render::axo_region(&w, meta, 0, 0, 15, 15, 0.2, 0).pixels, ref_axo,
                "axo identical at hint {hint}");
        }
    }

    /// Same, for the front/side slab renderers (R2-1). Their only caller always asks for the full
    /// `0..=max_z` column, so the hint is the only thing keeping a slab fetch from touching every
    /// band of every chunk on the plane.
    #[test]
    fn a_too_high_hint_changes_nothing_for_the_slabs() {
        let bare = Bare(world_16b());
        let meta = bare.0.meta();
        let ref_y = render::yslice_patch(&bare, meta, 3, 0, 0, 15, 255).pixels;
        let ref_x = render::xslice_patch(&bare, meta, 3, 0, 0, 15, 255).pixels;

        for hint in [2usize, 9, 15] {
            let mut w = world_16b();
            w.top_band_hint = Some(hint);
            assert_eq!(render::yslice_patch(&w, meta, 3, 0, 0, 15, 255).pixels, ref_y,
                "front slab identical at hint {hint}");
            assert_eq!(render::xslice_patch(&w, meta, 3, 0, 0, 15, 255).pixels, ref_x,
                "side slab identical at hint {hint}");
        }
    }

    /// The failure direction for the slabs, for the same reason as
    /// [`a_too_low_hint_silently_hides_terrain`]: the ceiling is an upper bound, not an exact value.
    #[test]
    fn a_too_low_hint_hides_terrain_from_the_slabs() {
        let bare = Bare(world_16b());
        let meta = bare.0.meta();
        let ref_y = render::yslice_patch(&bare, meta, 3, 0, 0, 15, 255).pixels;
        let ref_x = render::xslice_patch(&bare, meta, 3, 0, 0, 15, 255).pixels;

        let mut w = world_16b();
        w.top_band_hint = Some(1); // the slab lives in band 2
        assert_ne!(render::yslice_patch(&w, meta, 3, 0, 0, 15, 255).pixels, ref_y,
            "a too-low hint must be observable in the front slab");
        assert_ne!(render::xslice_patch(&w, meta, 3, 0, 0, 15, 255).pixels, ref_x,
            "a too-low hint must be observable in the side slab");
    }

    /// ⚠️ Documents the *failure* direction on purpose: a hint below the real top band makes the
    /// renderers and `surface_z` report real terrain as air. Nothing should ever produce one, and
    /// the app's invalidation hook (`mark_dirty_chunks`) exists precisely to keep it from happening
    /// after an edit raises terrain.
    #[test]
    fn a_too_low_hint_silently_hides_terrain() {
        let bare = Bare(world_16b());
        let meta = bare.0.meta();
        let reference = render::pixels_patch(&bare, meta, 0, 0, 15, 15, None).pixels;

        let mut w = world_16b();
        w.top_band_hint = Some(1); // the slab lives in band 2
        assert_ne!(render::pixels_patch(&w, meta, 0, 0, 15, 15, None).pixels, reference,
            "a too-low hint must be observable — the contract is an UPPER bound, not an exact value");
        assert_eq!(surface_z(&w, 3, 3), None, "the slab is now invisible to surface_z");
        assert!(scan_chunk_lamps(&w, 0, 0).is_empty(), "and the lamp above it is gone too");
    }
}
