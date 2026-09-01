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
    for band in (0..world.num_bands()).rev() {
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
