//! Stage 18 M-1: deterministic peak-allocation measurements (`cargo test`, no display).
//!
//! A test-build-only `#[global_allocator]` that tracks *this thread's* current and peak live bytes,
//! so the parallel test runner can't contaminate a measurement (a process-wide counter would). The
//! measured operations are single-threaded; anything they hand to another thread would escape the
//! count, so don't point this at `rayon` work.
//!
//! `measure(f)` returns the peak bytes live *above the level at entry* while `f` ran — the
//! transient the operation needs beyond what already existed. Each test asserts a regression cap
//! at today's behaviour and prints the ratio (`cargo test -p eden-world-editor alloc_probe --
//! --nocapture`); the Stage 18 row that fixes an operation tightens its cap.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static CUR: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
}

struct Counting;

#[inline]
fn add(n: i64) {
    // `try_with`: the allocator is also called during thread teardown, when TLS is gone.
    let _ = CUR.try_with(|c| {
        let v = c.get() + n;
        c.set(v);
        let _ = PEAK.try_with(|p| if v > p.get() { p.set(v) });
    });
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() { add(l.size() as i64); }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(l) };
        if !p.is_null() { add(l.size() as i64); }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        add(-(l.size() as i64));
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, new) };
        if !q.is_null() { add(new as i64 - l.size() as i64); }
        q
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// Peak bytes live above the level at entry while `f` ran, on this thread.
fn measure<R>(f: impl FnOnce() -> R) -> (R, u64) {
    let base = CUR.with(|c| c.get());
    PEAK.with(|p| p.set(base));
    let r = f();
    let peak = PEAK.with(|p| p.get());
    (r, (peak - base).max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Clipboard, mirror_clipboard_x_inner, mirror_clipboard_y_inner,
                render_clipboard_preview_inner, rotate_clipboard_inner};

    /// 256 × 200 × 64 = 3.3 M voxels → a 6.5 MB clipboard (blocks + paints). Non-square so a
    /// rotate that forgot to swap width/height would index out of bounds.
    fn clipboard() -> Clipboard {
        let (w, h, d) = (256usize, 200usize, 64usize);
        let vol = w * h * d;
        Clipboard {
            width: w as i32, height: h as i32, depth: d as i32, z_anchor: 0,
            block_types: (0..vol).map(|i| (i % 7) as u8).collect(),
            paints: vec![3u8; vol],
            mask: None, origin: None
        }
    }

    fn report(name: &str, cb_bytes: u64, extra: u64) {
        eprintln!("[alloc_probe] {name:<28} clipboard {cb_bytes} B  transient {extra} B  ({:.2}x)",
            extra as f64 / cb_bytes as f64);
    }

    /// V-L4's 2.1 GB peak was rotate/mirror each building a full second clipboard copy. 18.6 made
    /// rotate go through one z-slice of scratch per array and mirror swap in place, so the caps are
    /// one slice (rotate) and ≈0 (mirror) — a regression to a full copy trips them by ~100×.
    #[test]
    fn alloc_probe_rotate_clipboard_transient() {
        let mut cb = clipboard();
        let cb_bytes = (cb.block_types.len() + cb.paints.len()) as u64;
        let (_, extra) = measure(|| rotate_clipboard_inner(&mut cb));
        report("rotate_clipboard", cb_bytes, extra);
        let slice_bytes = 2 * 256 * 200u64; // types + paints for one z-slice
        assert!(extra <= slice_bytes + 64 * 1024, "rotate now needs {extra} B, more than one z-slice ({slice_bytes} B)");
    }

    #[test]
    fn alloc_probe_mirror_clipboard_transient() {
        let mut cb = clipboard();
        let cb_bytes = (cb.block_types.len() + cb.paints.len()) as u64;
        let (_, ex) = measure(|| mirror_clipboard_x_inner(&mut cb));
        let (_, ey) = measure(|| mirror_clipboard_y_inner(&mut cb));
        report("mirror_clipboard_x", cb_bytes, ex);
        report("mirror_clipboard_y", cb_bytes, ey);
        assert!(ex <= 64 * 1024 && ey <= 64 * 1024,
            "mirror is no longer in place (clipboard {cb_bytes} B): x {ex}, y {ey}");
    }

    /// 18.3's contract: a preview costs ≤ max_side² columns whatever the clipboard size.
    #[test]
    fn alloc_probe_clipboard_preview_is_lod_bounded() {
        let cb = clipboard();
        let cb_bytes = (cb.block_types.len() + cb.paints.len()) as u64;
        let (p, extra) = measure(|| render_clipboard_preview_inner(&cb, 0, Some(64)));
        report("clipboard_preview(64)", cb_bytes, extra);
        assert!(p.width <= 64 && p.height <= 64);
        assert!(extra <= 64 * 64 * 4 + 64 * 1024, "a 64 px preview allocated {extra} B");
    }

    // ── M-1 whole-world edit probes (RAM-1) → 18.12 guards ─────────────────────────────────
    //
    // Each runs an edit over the *entire* world through `with_edit_inner` and reports peak transient
    // vs the world size, the old rect-sized pre-image (every band of every chunk), the bands the
    // edit actually changed, and the undo entry it kept. Before 18.12 the transient was the rect
    // pre-image (1.03x world for ONE changed block); the copy-on-write `EditView` captures only
    // written bands, so these now assert transient = O(changed bands).
    // The counting allocator is per-thread and blind to `mmap`, so these under-count rayon work and
    // anonymous maps (the preview scan buffer is one — read `PEAKS.preview_scan` for that).

    use crate::tests::{make_bumpy_world_grid, ws_with};
    use crate::{EditView, WorldState, generate_trees_inner, generate_wavy_surface_inner, with_edit_inner};

    /// 32 × 32 chunks = 512 × 512 columns, 64z, 32 MiB, every column solid to z=20.
    fn big_world() -> (WorldState, u64) {
        let bytes = make_bumpy_world_grid(32, 8, |_, _| 20);
        let n = bytes.len() as u64;
        (ws_with(bytes), n)
    }

    /// Bytes of the distinct bands the newest undo entry changed (a `Full` range counts every band
    /// it spans) — the floor any pre-image must pay.
    fn changed_band_bytes(ws: &WorldState) -> u64 {
        let mut scratch = Vec::new();
        let Some(e) = ws.undo_stack.back() else { return 0 };
        e.chunks.iter().map(|s| {
            let mut bands = std::collections::BTreeSet::new();
            if let Some(p) = s.delta.sparse_pairs() {
                for &(off, _) in p.iter() { bands.insert(off as usize / 8192); }
            } else if let Some((st, d)) = s.delta.full_bytes(&mut scratch) {
                let st = st as usize;
                if !d.is_empty() { bands.extend(st / 8192..=(st + d.len() - 1) / 8192); }
            }
            bands.len() as u64 * 8192
        }).sum()
    }

    /// (transient, changed-band bytes, kept undo bytes, world bytes) for `edit` over the whole map.
    fn whole_world_edit(name: &str, edit: impl FnOnce(&mut EditView)) -> (u64, u64, u64, u64) {
        let (mut ws, world_bytes) = big_world();
        let rect = (0, 0, 511, 511);
        let rect_preimage = {
            let w = ws.world.as_ref().unwrap();
            w.chunk_map.len() as u64 * w.chunk_size as u64
        };
        let (r, extra) = measure(|| with_edit_inner(&mut ws, name, rect, None, |w| { edit(w); Ok(()) }));
        r.expect("edit ok");
        let kept = ws.undo_bytes as u64;
        let changed = changed_band_bytes(&ws);
        eprintln!("[alloc_probe] {name:<26} world {world_bytes} B  old rect pre-image {rect_preimage} B  \
            changed bands {changed} B  transient {extra} B ({:.2}x world, {:.2}x changed)  kept undo {kept} B",
            extra as f64 / world_bytes as f64, extra as f64 / changed.max(1) as f64);
        (extra, changed, kept, world_bytes)
    }

    /// Transient cap for a CoW edit: the captured bands, plus the delta built from them (at most a
    /// second copy), plus slack for the returned patch — a whole-world rect renders a ~1 MiB patch
    /// here, which is sized by the rect by design (it's what the map repaints), not by the change.
    fn cow_cap(changed: u64, world: u64) -> u64 { 3 * changed + world / 16 }

    #[test]
    fn alloc_probe_whole_world_trees() {
        let (extra, changed, kept, world) = whole_world_edit("trees(2%)", |w| {
            generate_trees_inner(w, 0, 0, 511, 511, &["normal".to_string()], 0.02, &[], 7, true, None);
        });
        assert!(kept > 0, "the edit must have changed something");
        assert!(extra <= cow_cap(changed, world), "trees transient {extra} B exceeds 3x changed bands {changed} B + slack ({world} B world)");
    }

    #[test]
    fn alloc_probe_whole_world_wavy() {
        let (extra, changed, kept, world) = whole_world_edit("wavy water", |w| {
            generate_wavy_surface_inner(w, 0, 0, 511, 511, 63, 20, 0, 24.0, 0.5, 3, "fill", None);
        });
        assert!(kept > 0, "the edit must have changed something");
        assert!(extra <= cow_cap(changed, world), "wavy transient {extra} B exceeds 3x changed bands {changed} B + slack ({world} B world)");
    }

    /// The RAM-1 pathology in one number: a rect over the whole world, an edit that changes ONE
    /// block. Before 18.12 the transient was the whole 32 MiB rect pre-image (1.03x world) for a
    /// 48 B undo entry; now it's one 8 KiB band plus the patch.
    #[test]
    fn alloc_probe_whole_world_single_block() {
        let (extra, changed, kept, world) = whole_world_edit("one block in a whole rect", |w| {
            voxel_core::view::set_block_abs(w, 100, 100, 30, 5, 0);
        });
        assert!(kept > 0 && kept < 4096, "one block should keep a tiny undo entry, kept {kept}");
        assert_eq!(changed, 8192, "one block = one band");
        assert!(extra <= cow_cap(changed, world), "single-block transient {extra} B exceeds one band + slack ({world} B world)");
        assert!(extra < world / 16, "single-block transient {extra} B must be nowhere near the world ({world} B)");
    }

    /// The harness itself: a known allocation must be seen, and freeing it must not lower the peak.
    #[test]
    fn alloc_probe_measure_sees_a_known_allocation() {
        let (_, extra) = measure(|| { let v = vec![1u8; 1 << 20]; drop(v); });
        assert!(extra >= 1 << 20 && extra < (1 << 20) + 4096, "saw {extra}");
    }
}
