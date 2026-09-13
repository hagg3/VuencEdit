//! A bare in-memory [`VoxelView`] for this crate's own tests.
//!
//! The apps each have a richer world type (a parsed `.eden` mmap, a network delta mirror); the
//! logic in this crate only ever needs the three things `VoxelView` names, so its tests build the
//! smallest thing that provides them. Byte layout inside a chunk is the real one, so a test can
//! poke `bytes` at a hand-computed offset exactly as the app's tests do.

use crate::view::{ViewMeta, VoxelView, VoxelViewMut};
use rustc_hash::FxHashMap;

pub struct TestWorld {
    pub bytes: Vec<u8>,
    pub chunks: FxHashMap<(i32, i32), usize>,
    pub chunk_size: usize,
    pub num_bands: usize,
    pub min_x: i32,
    pub min_y: i32,
    pub w_chunks: u32,
    pub h_chunks: u32,
    pub sky: u8,
    /// Overrides `VoxelView::top_band_hint` when set — the only way to hand the scan sites a
    /// deliberately wrong ceiling, which is what the hint-contract tests need (a too-high hint must
    /// be invisible; a too-low one must be *visible*, so nobody later "tightens" the contract).
    pub top_band_hint: Option<usize>,
}

impl TestWorld {
    /// A fully-populated `w_chunks × h_chunks` world of `num_bands` bands, origin (0, 0), all air.
    /// `TestWorld::new(1, 1, 4)` is the 32 768-byte single-chunk 64z world both apps' tests use.
    pub fn new(w_chunks: u32, h_chunks: u32, num_bands: usize) -> Self {
        let chunk_size = num_bands * 8192;
        let mut chunks = FxHashMap::default();
        let mut off = 0usize;
        for cx in 0..w_chunks as i32 {
            for cy in 0..h_chunks as i32 {
                chunks.insert((cx, cy), off);
                off += chunk_size;
            }
        }
        TestWorld {
            bytes: vec![0u8; off],
            chunks,
            chunk_size,
            num_bands,
            min_x: 0,
            min_y: 0,
            w_chunks,
            h_chunks,
            sky: 0,
            top_band_hint: None,
        }
    }

    pub fn meta(&self) -> ViewMeta {
        ViewMeta { w_chunks: self.w_chunks, h_chunks: self.h_chunks, sky: self.sky }
    }

    /// Forget chunk `(cx, cy)` — the sparse case every renderer treats as air.
    pub fn drop_chunk(&mut self, cx: i32, cy: i32) {
        self.chunks.remove(&(cx, cy));
    }
}

impl VoxelView for TestWorld {
    fn num_bands(&self) -> usize { self.num_bands }
    fn chunk_origin(&self) -> (i32, i32) { (self.min_x, self.min_y) }
    fn chunk_bytes(&self, cx: i32, cy: i32) -> Option<&[u8]> {
        let &addr = self.chunks.get(&(cx, cy))?;
        Some(&self.bytes[addr..addr + self.chunk_size])
    }
    fn top_band_hint(&self, cx: i32, cy: i32) -> usize {
        let _ = (cx, cy);
        self.top_band_hint.unwrap_or_else(|| self.num_bands.saturating_sub(1))
    }
}

impl VoxelViewMut for TestWorld {
    fn chunk_bytes_mut(&mut self, cx: i32, cy: i32) -> Option<&mut [u8]> {
        let &addr = self.chunks.get(&(cx, cy))?;
        Some(&mut self.bytes[addr..addr + self.chunk_size])
    }
}
