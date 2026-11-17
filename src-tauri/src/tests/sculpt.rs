use super::*;

// ── Sculpt engine (Pass 1) test fixtures ──────────────────────────────────────

/// A single-chunk (0,0) test world whose every column (lx,ly) is filled with `surf_bt` from
/// z=1 up to `height(lx,ly)` (clamped 1..=63) — a real varied surface for sculpt tests, unlike
/// the degenerate single-column `make_test_world`.
pub(crate) fn make_bumpy_world<F: Fn(usize, usize) -> i32>(surf_bt: u8, height: F) -> Vec<u8> {
    const HEADER: usize = 4096;
    const CHUNK: usize = 32768;
    const ENTRY: usize = 16;
    let chunk_off: u32 = HEADER as u32;
    let ptr_off: u32 = (HEADER + CHUNK) as u32;
    let mut b = vec![0u8; HEADER + CHUNK + ENTRY];
    b[32..36].copy_from_slice(&ptr_off.to_le_bytes());
    b[40..49].copy_from_slice(b"BumpyTest");
    let block = |lx: usize, ly: usize, z: i32| -> usize {
        HEADER + (z / 16) as usize * 8192 + lx * 256 + ly * 16 + (z % 16) as usize
    };
    for lx in 0..16 {
        for ly in 0..16 {
            let h = height(lx, ly).clamp(1, 63);
            for z in 1..=h { b[block(lx, ly, z)] = surf_bt; }
        }
    }
    let pe = HEADER + CHUNK;
    b[pe..pe + 2].copy_from_slice(&0i16.to_le_bytes());
    b[pe + 4..pe + 6].copy_from_slice(&0i16.to_le_bytes());
    b[pe + 8..pe + 12].copy_from_slice(&chunk_off.to_le_bytes());
    b
}

/// Like `make_bumpy_world` but a `chunks_side × chunks_side` grid of standard (32 KB) chunks
/// at (0..chunks_side, 0..chunks_side), so world coords span `0..chunks_side*16` on each axis.
/// Rock/Carve field-fusion tests need this: their terrain estimate is sampled just *outside*
/// the stamp's own padded bbox (see `field_stamp`'s `stable_h`), which for anything but a tiny
/// radius runs past a single 16×16 chunk's bounds on the single-chunk fixture.
pub(crate) fn make_bumpy_world_grid<F: Fn(i32, i32) -> i32>(chunks_side: i32, surf_bt: u8, height: F) -> Vec<u8> {
    const HEADER: usize = 4096;
    const CHUNK: usize = 32768;
    let n = (chunks_side * chunks_side) as usize;
    let dir_off = HEADER + n * CHUNK;
    let mut b = vec![0u8; dir_off + n * 16];
    b[32..40].copy_from_slice(&(dir_off as u64).to_le_bytes());
    b[40..49].copy_from_slice(b"GridTest\0");
    let block = |base: usize, lx: usize, ly: usize, z: i32| -> usize {
        base + (z / 16) as usize * 8192 + lx * 256 + ly * 16 + (z % 16) as usize
    };
    let mut i = 0usize;
    for cy in 0..chunks_side {
        for cx in 0..chunks_side {
            let base = HEADER + i * CHUNK;
            for lx in 0..16usize {
                for ly in 0..16usize {
                    let (wx, wy) = (cx * 16 + lx as i32, cy * 16 + ly as i32);
                    let h = height(wx, wy).clamp(1, 63);
                    for z in 1..=h { b[block(base, lx, ly, z)] = surf_bt; }
                }
            }
            let e = dir_off + i * 16;
            b[e     ..e +  4].copy_from_slice(&cx.to_le_bytes());
            b[e +  4..e +  8].copy_from_slice(&cy.to_le_bytes());
            b[e +  8..e + 16].copy_from_slice(&(base as u64).to_le_bytes());
            i += 1;
        }
    }
    b
}

pub(crate) fn ws_with(bytes: Vec<u8>) -> WorldState {
    let mut ws = WorldState::new();
    ws.world = Some(parse_world_inner(mmap_from_bytes(bytes)).expect("parse"));
    ws
}

pub(crate) fn world_bytes(ws: &WorldState) -> Vec<u8> {
    ws.world.as_ref().unwrap().bytes.to_vec()
}

// ── top_band_hint: the per-chunk scan ceiling and its invalidation hook ────────────────
//
// The hint is an upper bound on "topmost band holding anything", consulted by every top-down
// scan (the 2D map render, `surface_z_capped`, the axo raycast, the lamp scan, the 3D mesher).
// It exists to stop those scans from touching ~10 pages of pure air per column on a 256z world
// — the mechanism behind the Windows working-set blowup (H1). A hint that is too *high* is
// merely slower; a hint that is too *low* reports real terrain as air, silently, everywhere.
// So the tests that matter are the invalidation ones: an edit that raises terrain into a band
// above the stored ceiling must clear it, and so must undoing and redoing that edit.

/// The staging pre-flight (H1 Stage 4). The volume-query half is inherently platform-specific
/// and can only be exercised on the platform running the test; what is pinned here is the
/// policy around it, which is the part that could refuse a load that should have succeeded.
/// C-10/P-10: a dropped guard deletes its temp and clears the slot; `release` keeps the file;
/// the exit hook removes a still-registered one.
#[test]
pub(crate) fn test_staging_guard_lifecycle() {
    let g = StagingGuard::new();
    let p = g.path().to_path_buf();
    fs::write(&p, b"x").unwrap();
    drop(g);
    assert!(!p.exists() && staging_slot().is_none());

    let g = StagingGuard::new();
    let p = g.path().to_path_buf();
    fs::write(&p, b"x").unwrap();
    let kept = g.release();
    assert!(kept.exists() && staging_slot().is_none());
    fs::remove_file(&kept).unwrap();

    let g = StagingGuard::new();
    let p = g.path().to_path_buf();
    fs::write(&p, b"x").unwrap();
    remove_staging_temp();
    assert!(!p.exists());
    drop(g); // already gone: must not panic
}

#[test]
pub(crate) fn test_staging_room_preflight() {
    let tmp = std::env::temp_dir().join("vuencedit_room_check.eden");

    // The system temp volume must be readable on any platform CI runs on.
    let free = free_space_bytes(&tmp).expect("temp volume free space must be readable");
    assert!(free > 0, "a writable temp volume with zero bytes free is not a realistic fixture");

    assert!(ensure_room_for(&tmp, 0).is_ok(), "a zero-byte stage always fits");
    assert!(ensure_room_for(&tmp, free.saturating_sub(1 << 30)).is_ok(),
        "a stage comfortably under the free space must be allowed");

    let err = ensure_room_for(&tmp, u64::MAX).expect_err("an impossible stage must be refused");
    let msg = err.to_string();
    assert!(msg.contains("not enough free space"), "message must say why: {msg}");
    assert!(msg.contains("GB") || msg.contains("MB"), "message must quantify it: {msg}");

    // ⚠️ The bias that matters: an unreadable volume proceeds rather than refusing, so a
    // filesystem that won't report free space can never make a world unopenable.
    let nowhere = std::path::Path::new("/vuencedit-no-such-volume-0ac1/x.eden");
    assert_eq!(free_space_bytes(nowhere), None, "an unreadable volume reports nothing");
    assert!(ensure_room_for(nowhere, u64::MAX).is_ok(), "and \"cannot tell\" means proceed");
}

/// `scan_top_band` is the ground truth the cache memoises. Pin it against a hand-known world
/// and against the all-air / missing-chunk cases, which both legitimately answer `0`.
#[test]
pub(crate) fn test_scan_top_band_matches_the_world() {
    let ws = ws_with(make_bumpy_world(8, |_, _| 20));
    let w = ws.world.as_ref().unwrap();
    assert_eq!(w.scan_top_band(0, 0), 1, "terrain tops out at z=20, which is band 1");
    assert_eq!(w.scan_top_band(7, 7), 0, "a chunk the world doesn't have is a valid 0");

    let air = ws_with(make_bumpy_world(8, |_, _| 0)); // clamped to 1 => a single z=1 layer
    assert_eq!(air.world.as_ref().unwrap().scan_top_band(0, 0), 0);
}

/// The cached value must equal the oracle for every chunk, and must be reached lazily: nothing
/// is computed until something asks.
#[test]
pub(crate) fn test_top_band_hint_is_lazy_and_matches_the_oracle() {
    let ws = ws_with(make_bumpy_world_grid(2, 8, |wx, _| 20 + wx % 30));
    let w = ws.world.as_ref().unwrap();
    for cy in 0..2 { for cx in 0..2 {
        assert_eq!(w.top_bands.peek(cx, cy), None, "({cx},{cy}) must start uncomputed");
    }}
    for cy in 0..2 { for cx in 0..2 {
        assert_eq!(w.top_band_hint(cx, cy), w.scan_top_band(cx, cy));
        assert_eq!(w.top_bands.peek(cx, cy), Some(w.scan_top_band(cx, cy)), "and be memoised");
    }}
}

/// Every cached ceiling must agree with the world's actual bytes. This is the invariant the
/// whole scheme rests on, and the one that fails *silently* — a stale-low ceiling doesn't
/// crash, it just makes terrain disappear from every renderer and from `surface_z`.
pub(crate) fn assert_hints_agree_with_world(ws: &WorldState, when: &str) {
    let w = ws.world.as_ref().unwrap();
    for &(cx, cy) in w.chunk_map.keys() {
        if let Some(cached) = w.top_bands.peek(cx, cy) {
            assert_eq!(cached, w.scan_top_band(cx, cy),
                "cached ceiling for chunk ({cx},{cy}) disagrees with the world {when}");
        }
    }
}

/// ⚠️ The load-bearing one. An edit that raises terrain into a band *above* the cached ceiling
/// must invalidate it — otherwise every renderer and `surface_z` go on reporting the new
/// terrain as air for the rest of the session. `with_edit_inner` clears it at the moment the
/// bytes change and `mark_dirty_chunks` (from `finish_edit`) clears it again from the precise
/// changed set; undo/redo must fire the hook too, since both bypass `with_edit_inner`.
#[test]
pub(crate) fn test_top_band_hint_invalidated_by_edit_undo_and_redo() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
    let base_surface = surf(&ws, 3, 3);
    assert_eq!(base_surface, 20);
    assert_eq!(ws.world.as_ref().unwrap().top_bands.peek(0, 0), Some(1),
        "reading the surface computes and caches the ceiling");

    // Raise a single column two bands higher than the cached ceiling.
    with_edit(&mut ws, "paint", (3, 3, 3, 3), |world| {
        set_block_abs(world, 3, 3, 50, 8, 0);
        Ok(())
    }).expect("edit");
    assert_hints_agree_with_world(&ws, "after the edit");
    assert_eq!(surf(&ws, 3, 3), 50, "the raised block must be visible");
    assert_eq!(ws.world.as_ref().unwrap().top_bands.peek(0, 0), Some(3));

    undo_edit_inner(&mut ws).expect("undo");
    assert_hints_agree_with_world(&ws, "after undo");
    assert_eq!(surf(&ws, 3, 3), base_surface);

    redo_edit_inner(&mut ws).expect("redo");
    assert_hints_agree_with_world(&ws, "after redo");
    assert_eq!(surf(&ws, 3, 3), 50, "redo restores the raised block, hint and all");
}

/// ⚠️ The ordering half of the same invariant, and a real bug this caught: `with_edit_inner`
/// renders the edit's own `PixelPatch` *before* `finish_edit` runs, so clearing the ceiling only
/// in `finish_edit` left that patch drawn from a stale one — an edit raising terrain above the
/// old ceiling came back invisible in its own patch. The patch must match a render of the
/// post-edit world taken with a known-good cache.
#[test]
pub(crate) fn test_edit_patch_is_rendered_with_a_fresh_scan_ceiling() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
    assert_eq!(surf(&ws, 3, 3), 20, "warm the ceiling cache at the pre-edit height");

    let result = with_edit(&mut ws, "paint", (0, 0, 15, 15), |world| {
        set_block_abs(world, 3, 3, 50, 13, 0); // Brick, well above the cached ceiling
        Ok(())
    }).expect("edit");

    // A freshly parsed copy of the post-edit bytes has no cache at all, so its render is the
    // ground truth the edit's own patch has to match.
    let fresh = ws_with(world_bytes(&ws));
    let truth = render_pixels_patch(fresh.world.as_ref().unwrap(), 0, 0, 15, 15, None);
    assert_eq!(result.patch.pixels, truth.pixels,
        "the edit's own patch must show the block the edit just placed");
}

/// The whole point, end to end: a rendered tile must be byte-identical whether the hint cache
/// is cold (every chunk computed on the fly) or warm (every chunk already memoised), and must
/// still be identical after an edit that moves the ceiling. This is the app-side companion to
/// `voxel-core`'s `hint_tests`, which prove the same thing against a deliberately wrong hint.
#[test]
pub(crate) fn test_rendered_tile_is_identical_cold_warm_and_after_an_edit() {
    let mut ws = ws_with(make_bumpy_world_grid(2, 8, |wx, wy| 8 + (wx * 3 + wy) % 40));
    let render = |ws: &WorldState| {
        render_pixels_patch(ws.world.as_ref().unwrap(), 0, 0, 31, 31, None).pixels
    };
    let cold = render(&ws);
    let warm = render(&ws); // every hint is now memoised
    assert_eq!(cold, warm, "warming the hint cache must not change a single pixel");

    with_edit(&mut ws, "paint", (5, 5, 5, 5), |world| {
        set_block_abs(world, 5, 5, 60, 13, 0);
        Ok(())
    }).expect("edit");
    let after = render(&ws);
    assert_ne!(after, warm, "the new top block must actually show up");

    // A fresh parse of the same bytes has a cold cache; it must render identically.
    let fresh = ws_with(world_bytes(&ws));
    assert_eq!(render(&fresh), after, "post-edit render must match a cold-cache render");
}

/// Filled disc footprint matching the backend's/frontend's `(dx² + dy²) <= (r + 0.5)²`.
pub(crate) fn disc_points(cx: i32, cy: i32, r: i32) -> Vec<SculptPoint> {
    let rr = (r as f64 + 0.5).powi(2);
    let mut v = Vec::new();
    for dy in -r..=r {
        for dx in -r..=r {
            if ((dx * dx + dy * dy) as f64) <= rr { v.push(SculptPoint { x: cx + dx, y: cy + dy }); }
        }
    }
    v
}

pub(crate) fn surf(ws: &WorldState, x: i32, y: i32) -> i32 {
    surface_z_capped(ws.world.as_ref().unwrap(), x, y, None).unwrap()
}

/// Convenience wrapper: a "raise"/"smooth" sculpt stamp with explicit points, all the newer
/// params defaulted, so each test only spells out what it varies.
#[allow(clippy::too_many_arguments)]
pub(crate) fn sculpt(
    ws: &mut WorldState, points: Option<Vec<SculptPoint>>, mode: &str, strength: i32,
    softness: f64, stamp: Option<(i32, i32, i32)>, group: Option<u64>,
) -> EditResult {
    let (scx, scy, srad) = match stamp {
        Some((a, b, c)) => (Some(a), Some(b), Some(c)),
        None => (None, None, None),
    };
    sculpt_terrain_inner(
        ws, points, mode.into(), strength, 0, None, None, None, None,
        Some(softness), Some("smooth".into()), None, None, None, scx, scy, srad, None, group,
        None, None, None, None, None, None, None,
    ).expect("sculpt")
}

/// Row 6 — the per-stroke float workspace accumulates sub-block deltas across same-group stamps
/// instead of rounding them away every call. A soft brush over a flat plateau: the centre
/// (weight 1) rises by exactly `strength` per stamp, and — the actual fix — EVERY rim column
/// with a non-zero weight rises over the stroke rather than a fixed BAYER threshold freezing
/// roughly half of them (the reinforcing-dither stripe pathology).
#[test]
pub(crate) fn test_residual_accumulates_sub_block_deltas() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // dead-flat grass plateau at z=20
    let (cx, cy, r) = (7, 7, 5);
    let n = 10;
    let gid = Some(4242u64);
    for _ in 0..n {
        sculpt(&mut ws, None, "raise", 1, 1.0, Some((cx, cy, r)), gid);
    }
    // Centre: weight 1 → +1/stamp, exactly n.
    assert_eq!(surf(&ws, cx, cy) - 20, n, "centre rises strength·n with no rounding loss");

    // Every interior rim column (within the disc, weight > 0) must have risen — none frozen.
    let mut risen = 0;
    let mut total = 0;
    for dy in -r..=r {
        for dx in -r..=r {
            let d2 = dx * dx + dy * dy;
            // Interior columns whose weight·n is comfortably ≥ 1 (d ≤ 3, so weight ≳ 0.35);
            // the outermost ring legitimately rounds to 0 (weight → 0 at the dome edge).
            if d2 == 0 || d2 > 9 { continue; }
            total += 1;
            let rise = surf(&ws, cx + dx, cy + dy) - 20;
            assert!(rise > 0, "column ({dx},{dy}) frozen — residuals not accumulating");
            assert!(rise <= n, "column ({dx},{dy}) rose {rise} > strength·n");
            risen += 1;
        }
    }
    assert_eq!(risen, total, "no interior column may be frozen by a fixed dither threshold");
}

/// Row 6 — `clip_rect` masks stamp cells server-side: a hard raise stamp straddling the rect
/// lifts only the columns inside it; columns in the disc but outside the rect are untouched.
#[test]
pub(crate) fn test_clip_rect_masks_stamp_cells() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
    // Disc centred at (8,8) r=4; clip to x >= 8 only. Hard brush (softness 0) so weight is 1
    // inside and the mask is the only thing that can zero a column.
    sculpt_terrain_inner(
        &mut ws, None, "raise".into(), 5, 0, None, None, None, None,
        Some(0.0), Some("smooth".into()), None, None, None, Some(8), Some(8), Some(4), None,
        Some(9), None, None, None, None, Some([8, 0, 100, 100]), None, None,
    ).expect("clipped raise");
    assert_eq!(surf(&ws, 9, 8) - 20, 5, "column inside the clip rect rises by strength");
    assert_eq!(surf(&ws, 8, 8) - 20, 5, "column on the clip edge (x==8) is inside and rises");
    assert_eq!(surf(&ws, 6, 8), 20, "column left of the clip rect is masked (unchanged)");
    assert_eq!(surf(&ws, 5, 8), 20, "another masked column, still pristine");
}

/// Build a bbox-sized mask from a per-cell predicate.
fn sculpt_mask_from(x1: i32, y1: i32, x2: i32, y2: i32, f: impl Fn(i32, i32) -> bool) -> SelectionMask {
    let w = (x2 - x1 + 1) as usize;
    let n = w * (y2 - y1 + 1) as usize;
    let mut bits = vec![0u8; n.div_ceil(8)];
    for y in y1..=y2 { for x in x1..=x2 {
        if f(x, y) { let i = (y - y1) as usize * w + (x - x1) as usize; bits[i >> 3] |= 1 << (i & 7); }
    } }
    SelectionMask { x1, y1, x2, y2, bits }
}

fn raise_clipped(ws: &mut WorldState, rect: [i32; 4]) {
    sculpt_terrain_inner(
        ws, None, "raise".into(), 5, 0, None, None, None, None,
        Some(0.0), Some("smooth".into()), None, None, None, Some(8), Some(8), Some(4), None,
        Some(9), None, None, None, None, Some(rect), None, None,
    ).expect("clipped raise");
}

/// Shape-clip — an active mask whose bbox equals `clip_rect` zeroes mask-0 cells (checkerboard
/// inside a rect that fully covers the disc), while mask-1 cells rise.
#[test]
pub(crate) fn test_clip_rect_honours_matching_selection_mask() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
    ws.selection_mask = Some(sculpt_mask_from(4, 4, 12, 12, |x, y| (x + y) % 2 == 0));
    raise_clipped(&mut ws, [4, 4, 12, 12]);
    assert_eq!(surf(&ws, 8, 8) - 20, 5, "mask-1 cell rises");
    assert_eq!(surf(&ws, 9, 9) - 20, 5, "mask-1 cell rises");
    assert_eq!(surf(&ws, 9, 8), 20, "mask-0 cell inside the rect is untouched");
    assert_eq!(surf(&ws, 8, 9), 20, "mask-0 cell inside the rect is untouched");
}

/// A mask whose bbox differs from `clip_rect` is ignored: rect-only behaviour.
#[test]
pub(crate) fn test_clip_rect_ignores_mismatched_selection_mask() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
    ws.selection_mask = Some(sculpt_mask_from(4, 4, 12, 11, |x, y| (x + y) % 2 == 0));
    raise_clipped(&mut ws, [4, 4, 12, 12]);
    assert_eq!(surf(&ws, 9, 8) - 20, 5, "stale mask ignored: odd cell rises like any rect cell");
    assert_eq!(surf(&ws, 8, 8) - 20, 5);
}

/// Row 6 — the float session is reaped by a foreign edit through `with_edit`. After the delete,
/// a same-group stamp must re-seed from the post-delete surface, not resurrect stale heights.
#[test]
pub(crate) fn test_sculpt_session_cleared_by_foreign_edit() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
    let gid = Some(555u64);
    sculpt(&mut ws, None, "raise", 4, 0.0, Some((8, 8, 3)), gid);
    assert!(ws.sculpt_session.is_some(), "a grouped stroke opens a session");
    assert_eq!(ws.sculpt_session.as_ref().unwrap().group_id, 555);

    // Foreign edit (group None) through the shared choke point → session must clear.
    with_edit(&mut ws, "delete", (0, 0, 15, 15), |world| {
        delete_blocks_inner(world, 0, 0, 15, 15, 0, 255, None);
        Ok(())
    }).expect("delete");
    assert!(ws.sculpt_session.is_none(), "a non-sculpt edit reaps the stale session");

    // The just-deleted footprint has no surface; a fresh same-group stamp re-seeds from the
    // post-delete world (there's nothing to raise), never from the pre-delete fheight cache.
    let before = world_bytes(&ws);
    sculpt(&mut ws, None, "raise", 4, 0.0, Some((8, 8, 3)), gid);
    assert_eq!(world_bytes(&ws), before, "no surface after delete → nothing resurrected");
}

// ── Audit H1: the sculpt read/write guard split ───────────────────────────────

/// `ChunkScratch` must behave exactly like the world for reads — including *through* to the
/// world for chunks it doesn't own — while keeping every write to itself until `commit`.
#[test]
pub(crate) fn test_chunk_scratch_isolates_writes_and_falls_through_reads() {
    let mut world = parse_world_inner(mmap_from_bytes(make_bumpy_world_grid(2, 8, |_, _| 20)))
        .expect("parse");
    let before = world.bytes.to_vec();

    // Own chunk (0,0) only. Chunk (1,1) covers world coords 16..31 on both axes.
    let mut scratch = ChunkScratch::new(&world, &[(0, 0)]);
    assert_eq!(surface_z_capped(&scratch, 20, 20, None), Some(20), "unowned chunk reads through");
    assert_eq!(read_block_abs(&scratch, 20, 20, 20), 8, "unowned block reads through");

    set_block_abs(&mut scratch, 4, 5, 30, 2, 7);   // owned → lands in the scratch
    set_block_abs(&mut scratch, 20, 20, 30, 2, 7); // unowned → dropped

    assert_eq!(read_block_abs(&scratch, 4, 5, 30), 2, "owned write is visible in the scratch");
    assert_eq!(read_paint_abs(&scratch, 4, 5, 30), 7);
    assert_eq!(read_block_abs(&scratch, 20, 20, 30), 0, "unowned write is dropped, not applied");
    assert_eq!(world.bytes.to_vec(), before, "the world is untouched until commit");

    let chunks = scratch.into_chunks();
    let snaps = chunks.commit(&mut world);
    assert_eq!(snaps.len(), 1, "exactly the one changed chunk produces a delta");
    assert_eq!(snaps[0].cx, 0);
    assert_eq!(read_block_abs(&world, 4, 5, 30), 2, "commit lands the write");
}

/// The split path's delta must be the same delta the in-guard path builds: `commit` diffs the
/// scratch against the live chunk, `diff_chunk` diffs a pre-copy against the mutated chunk.
/// Both are `diff_span` over the same two byte images, so restoring either must undo the edit.
#[test]
pub(crate) fn test_scratch_commit_delta_round_trips() {
    let mut world = parse_world_inner(mmap_from_bytes(make_bumpy_world(8, |_, _| 20)))
        .expect("parse");
    let before = world.bytes.to_vec();

    let mut scratch = ChunkScratch::new(&world, &[(0, 0)]);
    for z in 21..=28 { set_block_abs(&mut scratch, 6, 6, z, 2, 0); }
    let snaps = scratch.into_chunks().commit(&mut world);
    assert_ne!(world.bytes.to_vec(), before, "the commit changed the world");

    let entry = UndoEntry::new("scratch", snaps, None);
    restore_and_invert(&mut world, &entry);
    assert_eq!(world.bytes.to_vec(), before, "the commit's delta restores the pre-edit world");
}

/// A flush run through a scratch must produce byte-identical output to the same flush run
/// straight against the world — the whole premise of computing under the read guard.
#[test]
pub(crate) fn test_scratch_stamp_matches_direct_stamp() {
    let base = make_bumpy_world_grid(2, 8, |x, y| 18 + ((x + y) % 5));

    let args = || SculptArgs {
        mode: "raise".into(), strength: 3, strength_eff: 3.0, seed: 0,
        block_type: None, paint: None, freq: None, noise_mode: None,
        softness: 0.6, profile: "smooth".into(), grab_delta: None,
        anchor_x: None, anchor_y: None, slope_dx: None, slope_dy: None,
        smear_dx: None, smear_dy: None, clip_rect: None, mask: None, rock: None, cap: None,
    };
    let stamps = || vec![
        SculptStamp { points: disc_points(12, 12, 5), dial: Some((12, 12, 5)) },
        SculptStamp { points: disc_points(18, 14, 5), dial: Some((18, 14, 5)) },
    ];

    // Reference: straight at the world.
    let mut direct = parse_world_inner(mmap_from_bytes(base.clone())).expect("parse");
    let mut sess_a = SculptSession::new(1);
    run_sculpt_flush(&mut direct, &mut sess_a, &args(), &stamps()).expect("direct");

    // Through a scratch sized by `sculpt_flush_rect`, then committed.
    let mut via_scratch = parse_world_inner(mmap_from_bytes(base)).expect("parse");
    let rect = sculpt_flush_rect(&args(), &stamps()).expect("rect");
    let coords = affected_chunk_coords(&via_scratch, rect.0, rect.1, rect.2, rect.3);
    let mut scratch = ChunkScratch::new(&via_scratch, &coords);
    let mut sess_b = SculptSession::new(1);
    run_sculpt_flush(&mut scratch, &mut sess_b, &args(), &stamps()).expect("scratch");
    scratch.into_chunks().commit(&mut via_scratch);

    assert_eq!(via_scratch.bytes.to_vec(), direct.bytes.to_vec(),
               "a stamp computed against a scratch must be byte-identical to one computed in place");
}

/// R8 test 9: Carve cuts against the session's pre-stroke heightmap, so the scratch path must
/// match the direct path *across flushes that share one session* — the second flush reads the
/// reference the first one captured. Also covers a repeated stamp (idempotent within the stroke).
#[test]
pub(crate) fn test_scratch_carve_matches_direct_across_flushes() {
    let base = make_bumpy_world_grid(3, 2, |x, y| 20 + ((x / 5 + y / 7) % 4));
    let args = || SculptArgs {
        mode: "carve".into(), strength: 3, strength_eff: 3.0, seed: 11,
        block_type: Some(3), paint: None, freq: None, noise_mode: None,
        softness: 0.0, profile: "smooth".into(), grab_delta: None,
        anchor_x: None, anchor_y: None, slope_dx: None, slope_dy: None,
        smear_dx: None, smear_dy: None, clip_rect: None, mask: None,
        rock: Some(RockParams::default()), cap: None,
    };
    let flush1 = || vec![
        SculptStamp { points: disc_points(20, 22, 5), dial: Some((20, 22, 5)) },
        SculptStamp { points: disc_points(24, 22, 5), dial: Some((24, 22, 5)) },
    ];
    let flush2 = || vec![
        SculptStamp { points: disc_points(24, 22, 5), dial: Some((24, 22, 5)) }, // repeat of the last stamp
        SculptStamp { points: disc_points(28, 23, 5), dial: Some((28, 23, 5)) },
    ];

    let mut direct = parse_world_inner(mmap_from_bytes(base.clone())).expect("parse");
    let mut sa = SculptSession::new(1);
    for stamps in [flush1(), flush2()] {
        run_sculpt_flush(&mut direct, &mut sa, &args(), &stamps).expect("direct");
    }

    let mut via_scratch = parse_world_inner(mmap_from_bytes(base.clone())).expect("parse");
    let mut sb = SculptSession::new(1);
    for stamps in [flush1(), flush2()] {
        let rect = sculpt_flush_rect(&args(), &stamps).expect("rect");
        let coords = affected_chunk_coords(&via_scratch, rect.0, rect.1, rect.2, rect.3);
        let mut scratch = ChunkScratch::new(&via_scratch, &coords);
        run_sculpt_flush(&mut scratch, &mut sb, &args(), &stamps).expect("scratch");
        scratch.into_chunks().commit(&mut via_scratch);
    }

    assert_ne!(direct.bytes.to_vec(), base[..direct.bytes.len()].to_vec(), "the carve did something");
    assert_eq!(via_scratch.bytes.to_vec(), direct.bytes.to_vec(),
               "carve through a scratch must equal carve in place, session shared across flushes");
    assert_eq!(sa.carve_ref, sb.carve_ref, "both paths capture the same pre-stroke reference");
}

/// 18.10: the lazy scratch, over several modes, must equal the direct in-place stamp byte for
/// byte, its undo snapshots must restore the pre-stamp world exactly, and it must copy only the
/// bands it wrote (construction copies nothing).
#[test]
pub(crate) fn test_lazy_scratch_matches_reference_across_modes_and_undoes() {
    let base = make_bumpy_world_grid(2, 8, |x, y| 18 + ((x * 3 + y) % 5));
    for mode in ["raise", "lower", "smooth", "flatten", "noise", "thermal", "carve"] {
        let args = || SculptArgs {
            mode: mode.into(), strength: 4, strength_eff: 4.0, seed: 7,
            block_type: None, paint: None, freq: None, noise_mode: None,
            softness: 0.5, profile: "smooth".into(), grab_delta: None,
            anchor_x: None, anchor_y: None, slope_dx: None, slope_dy: None,
            smear_dx: None, smear_dy: None, clip_rect: None, mask: None,
            rock: (mode == "carve").then(RockParams::default), cap: None,
        };
        let stamps = || vec![
            SculptStamp { points: disc_points(14, 14, 6), dial: Some((14, 14, 6)) },
            SculptStamp { points: disc_points(17, 15, 6), dial: Some((17, 15, 6)) },
        ];
        let mut direct = parse_world_inner(mmap_from_bytes(base.clone())).expect("parse");
        let mut sa = SculptSession::new(1);
        run_sculpt_flush(&mut direct, &mut sa, &args(), &stamps()).expect("direct");

        let mut lazy = parse_world_inner(mmap_from_bytes(base.clone())).expect("parse");
        let rect = sculpt_flush_rect(&args(), &stamps()).expect("rect");
        let coords = affected_chunk_coords(&lazy, rect.0, rect.1, rect.2, rect.3);
        let mut scratch = ChunkScratch::new(&lazy, &coords);
        assert_eq!(scratch.buf_len(), 0, "construction copies nothing");
        let mut sb = SculptSession::new(1);
        run_sculpt_flush(&mut scratch, &mut sb, &args(), &stamps()).expect("scratch");
        let copied = scratch.buf_len();
        let whole: usize = coords.iter().filter_map(|&(x, y)| lazy.chunk_range(x, y)).map(|(a, e)| e - a).sum();
        assert!(copied < whole, "{mode}: copied {copied} B of {whole} B — must be band-granular");
        let snaps = scratch.into_chunks().commit(&mut lazy);
        assert_eq!(lazy.bytes.to_vec(), direct.bytes.to_vec(), "{mode}: lazy != reference");

        let entry = UndoEntry::new("lazy", snaps, None);
        restore_and_invert(&mut lazy, &entry);
        assert_eq!(lazy.bytes.to_vec(), base[..lazy.bytes.len()].to_vec(), "{mode}: undo must restore");
    }
}

/// 18.10 hint safety: a write into a band above the world's `top_band_hint` must be visible to
/// the scratch's own `surface_z` (a too-low hint would read it back as air), and a dense write
/// must still undo.
#[test]
pub(crate) fn test_lazy_scratch_hint_covers_own_writes() {
    let mut world = parse_world_inner(mmap_from_bytes(make_bumpy_world_grid(2, 8, |_, _| 20)))
        .expect("parse");
    let before = world.bytes.to_vec();
    assert_eq!(world.top_band_hint(0, 0), 1, "fixture terrain tops out in band 1");
    let mut scratch = ChunkScratch::new(&world, &[(0, 0)]);
    assert_eq!(scratch.top_band_hint(0, 0), 1);
    set_block_abs(&mut scratch, 3, 3, 50, 2, 1); // band 3
    assert_eq!(scratch.top_band_hint(0, 0), 3, "hint must rise with the scratch's own writes");
    assert_eq!(surface_z_capped(&scratch, 3, 3, None), Some(50));
    assert_eq!(surface_z_capped(&scratch, 4, 3, None), Some(20), "untouched column reads through");
    assert_eq!(scratch.buf_len(), 8192, "exactly one band copied");
    // Dense fill of two far-apart bands → Full delta spanning both, still restorable.
    for lx in 0..16 { for ly in 0..16 {
        set_block_abs(&mut scratch, lx, ly, 3, 5, 1);
        set_block_abs(&mut scratch, lx, ly, 50, 5, 1);
    } }
    let snaps = scratch.into_chunks().commit(&mut world);
    assert_eq!(snaps.len(), 1);
    assert_eq!(read_block_abs(&world, 9, 9, 50), 5);
    restore_and_invert(&mut world, &UndoEntry::new("hint", snaps, None));
    assert_eq!(world.bytes.to_vec(), before);
}

/// Rock/Carve write a `rock_stamp_pad` ring *outside* their nominal radius. `sculpt_write_rect`
/// must cover it — it sizes both the undo snapshot (which used to miss that ring entirely) and
/// the sculpt scratch (which would silently drop those writes).
#[test]
pub(crate) fn test_sculpt_write_rect_covers_the_rock_pad() {
    let rock = Some(RockParams::default());
    let dial = Some((40, 40, 8));
    let plain = sculpt_write_rect("raise", dial, &rock, 32, 32, 48, 48);
    assert_eq!(plain, (32, 32, 48, 48), "heightmap modes write only inside their footprint");

    let pad = rock_stamp_pad(&RockParams::default(), 8);
    assert!(pad >= 1, "the pad is always at least one block");
    let padded = sculpt_write_rect("rock", dial, &rock, 32, 32, 48, 48);
    assert_eq!(padded, (40 - 8 - pad, 40 - 8 - pad, 40 + 8 + pad, 40 + 8 + pad));
    assert_eq!(sculpt_write_rect("carve", dial, &rock, 32, 32, 48, 48), padded,
               "carve stamps the same field extent as rock");
}

/// The bound `sculpt_write_rect` promises must actually hold: every cell a rock stamp writes
/// has to land inside it, or the sculpt scratch would silently drop part of the stamp and the
/// undo snapshot would silently miss it. Run over terrain with real relief, where the
/// smooth-min fillet flares the mass outward furthest.
#[test]
pub(crate) fn test_rock_stamp_writes_stay_inside_the_write_rect() {
    let (cx, cy, r) = (48, 48, 10);
    let mut world = parse_world_inner(mmap_from_bytes(
        make_bumpy_world_grid(7, 8, |x, y| 16 + ((x / 7 + y / 5) % 9)),
    )).expect("parse");
    let before = world.bytes.to_vec();
    let rp = RockParams { meld: 3.0, smoothing: 5.0, ..RockParams::default() };
    field_stamp(&mut world, cx, cy, r, &rp, 7, None, None, None, None, None, false, None);
    assert_ne!(world.bytes.to_vec(), before, "the stamp did something");

    let rock = Some(rp);
    let dial = Some((cx, cy, r));
    let (rx1, ry1, rx2, ry2) = sculpt_write_rect("rock", dial, &rock, cx - r, cy - r, cx + r, cy + r);
    let side = 7 * 16;
    for wy in 0..side {
        for wx in 0..side {
            let inside = wx >= rx1 && wx <= rx2 && wy >= ry1 && wy <= ry2;
            if inside { continue; }
            for z in 0..64 {
                assert_eq!(
                    read_block_abs_bytes(&before, &world, wx, wy, z),
                    read_block_abs_bytes(&world.bytes, &world, wx, wy, z),
                    "rock wrote to ({wx},{wy},{z}), outside the rect sculpt_write_rect promised",
                );
            }
        }
    }
}

/// Read a block from an arbitrary byte image of `world` (used to compare pre/post images).
pub(crate) fn read_block_abs_bytes(bytes: &[u8], world: &LoadedWorld, wx: i32, wy: i32, wz: i32) -> u8 {
    let cx = wx.div_euclid(16) + world.min_x;
    let cy = wy.div_euclid(16) + world.min_y;
    let Some((addr, cend)) = world.chunk_range(cx, cy) else { return 0 };
    let bi = addr + (wz as usize / 16) * 8192
        + wx.rem_euclid(16) as usize * 256 + wy.rem_euclid(16) as usize * 16 + wz as usize % 16;
    if bi < cend { bytes[bi] } else { 0 }
}

/// Row 6 — undo reaps the session (it bypasses `with_edit_inner`). Undoing the owning stroke
/// then stamping again same-group equals a fresh single stamp on the pristine world.
#[test]
pub(crate) fn test_sculpt_session_cleared_by_undo() {
    let base = make_bumpy_world(8, |_, _| 20);
    let gid = Some(321u64);

    // Reference: one fresh stamp on a pristine world.
    let mut refws = ws_with(base.clone());
    sculpt(&mut refws, None, "raise", 4, 0.0, Some((8, 8, 3)), gid);
    let reference = world_bytes(&refws);

    // Stamp, undo (reaps session), stamp again same group — must match the reference exactly.
    let mut ws = ws_with(base.clone());
    sculpt(&mut ws, None, "raise", 4, 0.0, Some((8, 8, 3)), gid);
    assert!(ws.sculpt_session.is_some());
    undo_edit_inner(&mut ws).expect("undo");
    assert!(ws.sculpt_session.is_none(), "undo reaps the session it belonged to");
    sculpt(&mut ws, None, "raise", 4, 0.0, Some((8, 8, 3)), gid);
    assert_eq!(world_bytes(&ws), reference, "post-undo stamp re-seeds, no residual carryover");
}

/// R8 test 7: Carve persists its session (the pre-stroke heightmap), and a mode switch inside one
/// group (Shift → temporary Smooth mid-stroke) invalidates the cache that mode doesn't own: a
/// non-carve stamp clears `carve_ref`, a carve stamp clears `fheight`. After the round trip the
/// final carve must still stay inside its hollow (nothing cut past the fillet band).
#[test]
pub(crate) fn test_carve_session_mode_switch() {
    let gid = Some(900u64);
    let mut ws = ws_with(make_bumpy_world_grid(4, 2, |_, _| 20));
    let run = |ws: &mut WorldState, mode: &str, cx: i32, cy: i32| {
        let args = SculptArgs {
            mode: mode.into(), strength: 4, strength_eff: 4.0, seed: 5,
            block_type: None, paint: None, freq: None, noise_mode: None,
            softness: 0.5, profile: "smooth".into(), grab_delta: None,
            anchor_x: None, anchor_y: None, slope_dx: None, slope_dy: None,
            smear_dx: None, smear_dy: None, clip_rect: None, mask: None,
            rock: Some(RockParams::default()), cap: None,
        };
        let stamps = vec![SculptStamp { points: disc_points(cx, cy, 6), dial: Some((cx, cy, 6)) }];
        run_sculpt_in_guard(ws, "Test", gid, args, stamps).expect("stamp");
    };

    run(&mut ws, "carve", 30, 30);
    let s = ws.sculpt_session.as_ref().expect("carve persists a grouped session");
    assert!(!s.carve_ref.is_empty(), "carve records its pre-stroke reference");

    run(&mut ws, "smooth", 30, 30);
    let s = ws.sculpt_session.as_ref().expect("smooth persists the session");
    assert!(s.carve_ref.is_empty(), "a non-carve stamp must clear carve_ref");
    assert!(!s.fheight.is_empty(), "smooth fills the float workspace");

    let before = ws.world.as_ref().unwrap().bytes.to_vec();
    run(&mut ws, "carve", 36, 30);
    let s = ws.sculpt_session.as_ref().expect("carve persists the session again");
    assert!(s.fheight.is_empty(), "a carve stamp must clear fheight");
    assert!(!s.carve_ref.is_empty(), "the re-captured reference is back");

    // The post-switch carve may only touch the hollow it was asked for: far columns stay put.
    let w = ws.world.as_ref().unwrap();
    let base = parse_world_inner(mmap_from_bytes(before)).expect("parse");
    let r = 6.0 / 0.7 + 1.0 + 2.0;
    for y in 8..=56 { for x in 8..=60 {
        let d = (((x - 36) * (x - 36) + (y - 30) * (y - 30)) as f64).sqrt();
        if d > r {
            assert_eq!(surface_z_capped(w, x, y, None), surface_z_capped(&base, x, y, None),
                       "column ({x},{y}) at distance {d:.1} changed in the post-switch carve");
        }
    }}
}

/// Audit M1 — `sculpt_terrain_batch_inner` (one `with_edit_grouped` call for N stamps) must be
/// byte-for-byte equivalent to N sequential same-group `sculpt_terrain_inner` calls (the old
/// per-stamp loop). Covers a mode that reads the float session (`raise`) and one that reads a
/// wide neighbourhood off the live world each stamp (`smooth`), over overlapping discs so a
/// stamp's own prior neighbours are re-read after mutation — the case a naive batch could get
/// wrong by reusing a stale `height_map`.
#[test]
pub(crate) fn test_stamp_batch_matches_sequential_calls() {
    let base = make_bumpy_world(8, |x, y| 20 + ((x * 7 + y * 3) % 5) as i32);
    let centers = vec![[6, 6], [8, 6], [7, 8], [9, 9]];
    let r = 3;
    let gid = Some(777u64);

    for mode in ["raise", "smooth"] {
        // Reference: N sequential single-stamp calls sharing one group.
        let mut seq = ws_with(base.clone());
        for c in &centers {
            sculpt_terrain_inner(
                &mut seq, None, mode.into(), 3, 0, None, None, None, None,
                Some(0.3), Some("smooth".into()), None, None, None,
                Some(c[0]), Some(c[1]), Some(r), None, gid,
                None, None, None, None, None, None, None,
            ).expect("sequential stamp");
        }

        // Batched: one `sculpt_terrain_batch_inner` call over all centres.
        let mut batch = ws_with(base.clone());
        sculpt_terrain_batch_inner(
            &mut batch, centers.clone(), mode.into(), 3, 0, None, None, None, None,
            Some(0.3), Some("smooth".into()), None, None, None, r, None, gid,
            None, None, None, None, None, None, None,
        ).expect("batched stamps");

        assert_eq!(
            world_bytes(&seq), world_bytes(&batch),
            "mode {mode}: batched stamps must match N sequential same-group calls exactly"
        );
        // One flush = one undo stack entry now, vs. N before — still one logical undo unit
        // either way (count_undo_groups collapses a same-group run), but the batch path is the
        // whole point of M1: assert it landed.
        assert_eq!(batch.undo_stack.len(), 1, "batch commits one UndoEntry for the whole flush");
        assert_eq!(seq.undo_stack.len(), centers.len(), "sequential calls still push one entry each");
        assert_eq!(count_undo_groups(&batch.undo_stack), count_undo_groups(&seq.undo_stack),
                   "same logical undo-group count either way");
    }
}

