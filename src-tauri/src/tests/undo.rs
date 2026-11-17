use super::*;

// ── Row 18.2: bounded non-z-scoped edit pre-images ─────────────────────────────────────

/// `n × n` contiguous 64z chunks (32768 B each), chunk (cx, cy) at directory slot `cy * n + cx`.
/// Every chunk is empty except a stone floor at z=0 so `surface_z` finds terrain.
pub(crate) fn make_grid_world(n: usize) -> Vec<u8> {
    const CHUNK: usize = 32768;
    let ptr_off = HEADER + n * n * CHUNK;
    let mut b = vec![0u8; ptr_off + n * n * 16];
    b[32..36].copy_from_slice(&(ptr_off as u32).to_le_bytes());
    b[40..49].copy_from_slice(b"GridWorld");
    for cy in 0..n {
        for cx in 0..n {
            let i = cy * n + cx;
            let off = HEADER + i * CHUNK;
            for lx in 0..16 { for ly in 0..16 { b[off + lx * 256 + ly * 16] = 2; } }
            let pe = ptr_off + i * 16;
            b[pe..pe + 2].copy_from_slice(&(cx as i16).to_le_bytes());
            b[pe + 4..pe + 6].copy_from_slice(&(cy as i16).to_le_bytes());
            b[pe + 8..pe + 12].copy_from_slice(&(off as u32).to_le_bytes());
        }
    }
    b
}

/// 18.12 (B.6 test 3) — the copy-on-write pre-image trips at `PREIMAGE_GUARD_FACTOR × budget`
/// of *changed bands*: the edit is refused with a sized message and rolled back exactly, with no
/// undo entry and no dirty mark.
#[test]
pub(crate) fn test_preimage_trip_rolls_back_and_refuses() {
    let mut ws = ws_with(make_grid_world(2));
    ws.undo_budget = 3 * 8192 / PREIMAGE_GUARD_FACTOR; // limit = exactly 3 bands
    let before = world_bytes(&ws);
    let seq = ws.dirty.seq;
    let rect = (0, 0, 31, 31);
    // Five bands: all 4 of chunk (0,0) plus band 0 of chunk (1,0).
    let err = match with_edit(&mut ws, "trees", rect, |w| {
        for z in [1, 17, 33, 49] { set_block_abs(w, 3, 3, z, 9, 0); }
        set_block_abs(w, 20, 3, 1, 9, 0);
        Ok(())
    }) {
        Err(e) => e,
        Ok(_) => panic!("an over-limit pre-image must be refused"),
    };
    assert_eq!(err, preimage_trip_message(3 * 8192));
    assert!(err.contains("MB") && err.contains("undo limit"), "{err}");
    assert!(ws.world.is_some(), "the world is reinstalled on refusal");
    assert_eq!(world_bytes(&ws), before, "exact rollback");
    assert!(ws.undo_stack.is_empty());
    assert_eq!(ws.dirty.seq, seq, "a refused edit marks nothing dirty");
    assert!(ws.dirty.since_disk.is_empty());

    // Three bands is exactly the limit: applies and undoes.
    with_edit(&mut ws, "trees", rect, |w| {
        for z in [1, 17, 33] { set_block_abs(w, 3, 3, z, 9, 0); }
        Ok(())
    }).expect("at the limit");
    assert_eq!(ws.undo_stack.len(), 1);
    undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(world_bytes(&ws), before);
}

/// 18.12 — the RAM-1 win: a whole-world rect that changes one block needs one band of
/// pre-image, so it passes a limit the old rect-sized snapshot (every band of every chunk)
/// would have been refused at.
#[test]
pub(crate) fn test_huge_rect_small_change_fits_a_small_limit() {
    let mut ws = ws_with(make_grid_world(3));
    ws.undo_budget = 8192 / PREIMAGE_GUARD_FACTOR; // limit = one band; the rect is 9 × 4 bands
    let before = world_bytes(&ws);
    with_edit(&mut ws, "trees", (0, 0, 47, 47), |w| { set_block_abs(w, 40, 40, 20, 9, 0); Ok(()) })
        .expect("one changed band fits");
    undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(world_bytes(&ws), before);
}

#[test]
pub(crate) fn test_cow_snapshots_only_the_written_chunks_and_undoes() {
    let mut ws = ws_with(make_grid_world(3));
    let before = world_bytes(&ws);
    let world = ws.world.as_ref().unwrap();
    let (a0, _) = world.chunk_range(0, 0).unwrap();
    let (a2, _) = world.chunk_range(2, 2).unwrap();
    // The rect is the whole 3x3 grid; only the two corners are written.
    with_edit(&mut ws, "cells", (0, 0, 47, 47), |w| {
        w.set_byte(a0 + 3, 7);
        w.set_byte(a2 + 5, 7);
        Ok(())
    }).expect("edit");
    let snapped: Vec<(i32, i32)> = ws.undo_stack.back().unwrap().chunks.iter().map(|s| (s.cx, s.cy)).collect();
    assert_eq!(snapped, vec![(0, 0), (2, 2)]);
    undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(world_bytes(&ws), before, "undo restores the exact pre-edit bytes");
}

// ── Row 18.12: copy-on-write edit pre-image — differential oracle + contract tests ──────────

/// A `side × side`-chunk world of `bands` bands (4 = 64z, 16 = 256z), terrain to `height(x, y)`
/// (clamped to the world), stone under a painted grass top, a lamp on every 11th column.
pub(crate) fn cow_world(side: i32, bands: usize, height: impl Fn(i32, i32) -> i32) -> Vec<u8> {
    const HEADER: usize = 4096;
    let chunk = bands * 8192;
    let n = (side * side) as usize;
    let dir_off = HEADER + n * chunk;
    let mut b = vec![0u8; dir_off + n * 16];
    b[32..40].copy_from_slice(&(dir_off as u64).to_le_bytes());
    b[40..48].copy_from_slice(b"CowTest\0");
    // version 5 + a 131072 stride = 256z; a legacy version + 32768 = 64z.
    b[92..96].copy_from_slice(&(if bands == 16 { 5i32 } else { 0 }).to_le_bytes());
    let top = (bands * 16 - 2) as i32;
    let mut i = 0usize;
    for cy in 0..side {
        for cx in 0..side {
            let base = HEADER + i * chunk;
            for lx in 0..16usize {
                for ly in 0..16usize {
                    let (wx, wy) = (cx * 16 + lx as i32, cy * 16 + ly as i32);
                    let h = height(wx, wy).clamp(1, top);
                    let at = |z: i32| base + (z / 16) as usize * 8192 + lx * 256 + ly * 16 + (z % 16) as usize;
                    for z in 1..h { b[at(z)] = 1; }
                    b[at(h)] = 2;
                    b[at(h) + 4096] = ((wx + wy) % 9) as u8;
                    if (wx * 7 + wy) % 11 == 0 { b[at(h + 1)] = LAMP_BLOCK_TYPE; }
                }
            }
            let e = dir_off + i * 16;
            b[e..e + 4].copy_from_slice(&cx.to_le_bytes());
            b[e + 4..e + 8].copy_from_slice(&cy.to_le_bytes());
            b[e + 8..e + 16].copy_from_slice(&(base as u64).to_le_bytes());
            i += 1;
        }
    }
    b
}

pub(crate) fn cow_ws(bands: usize) -> WorldState {
    // 256z: heights 30..69, terrain across bands 1..4. 64z: 8..37, leaving room for canopies.
    let ws = if bands == 16 {
        ws_with(cow_world(3, bands, |x, y| 30 + (x * 7 + y * 3) % 40))
    } else {
        ws_with(cow_world(3, bands, |x, y| 8 + (x * 7 + y * 3) % 30))
    };
    assert_eq!(ws.world.as_ref().unwrap().num_bands, bands, "fixture parsed at the wrong height");
    let all: Vec<(i32, i32)> = ws.world.as_ref().unwrap().chunk_map.keys().copied().collect();
    ws.lamp_index.build_now(ws.world.as_ref().unwrap(), &all);
    ws
}

pub(crate) fn dirty_chunks(ws: &WorldState) -> Vec<(i32, i32)> {
    let mut v: Vec<_> = ws.dirty.since_disk.keys().copied().collect();
    v.sort_unstable();
    v
}

pub(crate) fn lamps_match_a_rebuild(ws: &WorldState) -> bool {
    let mut got = ws.lamp_index.snapshot();
    got.retain(|_, v| !v.is_empty());
    got == build_lamp_index(ws.world.as_ref().unwrap())
}

/// B.6 test 1: run `edit` through the pre-18.12 snapshot path (the oracle, snapshotting the whole
/// world) and through the copy-on-write path, from identical worlds, and require identical
/// post-edit bytes, patch, dirty chunk set and lamp index; exact undo; exact redo. Deltas are
/// compared semantically (apply → same bytes) — CoW may pick `Sparse` where the oracle chose a
/// whole-span `Full`.
pub(crate) fn differential(label: &str, bands: usize, patch_rect: (i32, i32, i32, i32),
                edit: &dyn Fn(&mut EditView) -> Result<(), String>) {
    let mut old = cow_ws(bands);
    let mut new = cow_ws(bands);
    let before = world_bytes(&old);
    let ro = with_edit_inner_oracle(&mut old, label, (0, 0, 47, 47), patch_rect, None, edit);
    let rn = with_edit(&mut new, label, patch_rect, edit);
    let (ro, rn) = match (ro, rn) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(a), Err(b)) => {
            assert_eq!(a, b, "{label}/{bands}: same error on both paths");
            assert_eq!(world_bytes(&new), before, "{label}/{bands}: a failed CoW edit rolls back exactly");
            assert!(new.undo_stack.is_empty() && dirty_chunks(&new).is_empty());
            return;
        }
        (a, b) => panic!("{label}/{bands}: paths disagree on success: oracle {:?} vs cow {:?}",
                         a.map(|_| ()), b.map(|_| ())),
    };
    let post = world_bytes(&old);
    assert!(post != before, "{label}/{bands}: the fixture must actually change something");
    assert!(world_bytes(&new) == post, "{label}/{bands}: post-edit worlds differ");
    assert_eq!(ro.patch.pixels, rn.patch.pixels, "{label}/{bands}: patch differs");
    assert_eq!(ro.invalidate, rn.invalidate);
    assert_eq!(dirty_chunks(&old), dirty_chunks(&new), "{label}/{bands}: dirty chunk sets differ");
    assert!(lamps_match_a_rebuild(&new), "{label}/{bands}: lamp index drifted after the edit");
    assert_eq!(old.undo_stack.len(), 1);
    assert_eq!(new.undo_stack.len(), 1);

    undo_edit_inner(&mut old).expect("oracle undo");
    undo_edit_inner(&mut new).expect("cow undo");
    assert!(world_bytes(&old) == before, "{label}/{bands}: oracle undo inexact");
    assert!(world_bytes(&new) == before, "{label}/{bands}: cow undo inexact");
    assert!(lamps_match_a_rebuild(&new), "{label}/{bands}: lamp index drifted after undo");
    redo_edit_inner(&mut new).expect("cow redo");
    assert!(world_bytes(&new) == post, "{label}/{bands}: cow redo inexact");
    assert!(lamps_match_a_rebuild(&new), "{label}/{bands}: lamp index drifted after redo");
}

/// 23.12 — `stamp_columns` (column gather → `write_column_bulk` runs) must match the per-voxel
/// loop it replaced byte for byte, and count the same clipped cells: off the west/north edge,
/// past the world's east/south edge, below z 0 and above `max_z`, with and without ignore-air,
/// a shaped mask, and a per-column `z_base` that sometimes skips a column.
#[test]
pub(crate) fn test_stamp_columns_matches_per_voxel_reference() {
    let (w, h, d) = (9, 7, 20);
    let (cbt, cpt) = cow_clipboard(w, h, d);
    let mask: Vec<u8> = (0..((w * h + 7) / 8)).map(|i| 0b1011_0111u8.rotate_left(i as u32)).collect();
    let z_base = |tx: i32, ty: i32, k: i32| -> Option<i32> {
        if (tx + ty) % 7 == 0 { None } else { Some(k + (tx * 3 + ty) % 9) }
    };
    for bands in [4usize, 16] {
        let max_z = (bands * 16 - 1) as i32;
        for &(ox, oy) in &[(-4, -3), (20, 20), (43, 44)] {
            for &k in &[-12, 10, max_z - 8] {
                for ignore_air in [false, true] {
                    for masked in [false, true] {
                        let include = |dx: i32, dy: i32| !masked || bit_set(&mask, (dy * w + dx) as usize);
                        let mut fast = cow_ws(bands).world.unwrap();
                        let mut slow = cow_ws(bands).world.unwrap();
                        let got = stamp_columns(&mut fast, ox, oy, &cbt, &cpt, w, h, d, ignore_air, max_z,
                            include, |_, tx, ty| z_base(tx, ty, k));
                        let (mnx, mny) = slow.chunk_origin();
                        let mut want = 0u32;
                        for dy in 0..h { for dx in 0..w {
                            if !include(dx, dy) { continue; }
                            let (tx, ty) = (ox + dx, oy + dy);
                            let on = tx >= 0 && ty >= 0 && slow.has_chunk(tx / 16 + mnx, ty / 16 + mny);
                            let zb = if on { z_base(tx, ty, k) } else { Some(0) };
                            let Some(zb) = zb else { continue };
                            for dz in 0..d {
                                let i = ((dz * h + dy) * w + dx) as usize;
                                if ignore_air && cbt[i] == 0 { continue; }
                                let z = zb + dz;
                                if !on || z < 0 || z > max_z { want += 1; continue; }
                                set_block_abs(&mut slow, tx, ty, z, cbt[i], cpt[i]);
                            }
                        }}
                        let tag = format!("bands={bands} o=({ox},{oy}) k={k} air={ignore_air} mask={masked}");
                        assert_eq!(got, want, "{tag}: clipped count");
                        assert!(fast.bytes[..] == slow.bytes[..], "{tag}: bytes differ");
                    }
                }
            }
        }
    }
}

pub(crate) fn cow_clipboard(w: i32, h: i32, d: i32) -> (Vec<u8>, Vec<u8>) {
    let n = (w * h * d) as usize;
    let bt: Vec<u8> = (0..n).map(|i| if i % 5 == 0 { 0 } else { [3u8, 7, 13, LAMP_BLOCK_TYPE][i % 4] }).collect();
    let pt: Vec<u8> = (0..n).map(|i| (i % 11) as u8).collect();
    (bt, pt)
}

pub(crate) fn cow_sculpt_args(mode: &str) -> SculptArgs {
    SculptArgs {
        mode: mode.into(), strength: 4, strength_eff: 4.0, seed: 3,
        block_type: None, paint: None, freq: None, noise_mode: None,
        softness: 0.6, profile: "smooth".into(), grab_delta: None,
        anchor_x: None, anchor_y: None, slope_dx: None, slope_dy: None,
        smear_dx: None, smear_dy: None, clip_rect: None, mask: None, rock: None, cap: None,
    }
}

#[test]
pub(crate) fn test_cow_edits_match_the_snapshot_oracle() {
    for bands in [4usize, 16] {
        let max_z = (bands * 16 - 1) as i32;
        let all = (0, 0, 47, 47);
        differential("delete", bands, (2, 3, 40, 37), &|w| {
            delete_blocks_inner(w, 2, 3, 40, 37, 20, 50, None); Ok(())
        });
        differential("delete over air", bands, (0, 0, 20, 20), &|w| {
            delete_blocks_inner(w, 0, 0, 20, 20, 0, max_z, None); Ok(())
        });
        differential("replace", bands, all, &|w| {
            replace_blocks_inner(w, 0, 0, 47, 47, 0, max_z, 7, 3, Some(2), None, false, None); Ok(())
        });
        differential("replace inverted", bands, (5, 5, 25, 25), &|w| {
            replace_blocks_inner(w, 5, 5, 25, 25, 25, 45, 13, 0, Some(0), None, true, None); Ok(())
        });
        differential("gradient", bands, (4, 4, 30, 30), &|w| {
            gradient_fill_inner(w, 4, 4, 30, 30, 20, 60, 1, 0, 7, 5, "x", false, None); Ok(())
        });
        differential("paint + doors", bands, all, &|w| {
            for (x, y, z) in [(3, 5, 31), (6, 2, 4), (20, 20, 47), (40, 9, 63.min(max_z - 1))] {
                set_block_abs(w, x, y, z, 66, 0);
                set_block_abs(w, x, y, z + 1, 70, 0);
            }
            set_block_abs(w, 12, 12, 40, LAMP_BLOCK_TYPE, 0);
            Ok(())
        });
        let (cbt, cpt) = cow_clipboard(9, 7, 20);
        differential("paste", bands, (10, 12, 18, 18), &|w| {
            paste_clipboard_at(w, 10, 12, &cbt, &cpt, 9, 7, 20, 25, 3, false, max_z, None); Ok(())
        });
        differential("paste ignore-air", bands, (10, 12, 18, 18), &|w| {
            paste_clipboard_at(w, 10, 12, &cbt, &cpt, 9, 7, 20, 25, 3, true, max_z, None); Ok(())
        });
        differential("scatter", bands, all, &|w| {
            for (px, py) in [(1, 1), (14, 30), (35, 36), (40, 2)] {
                paste_clipboard_at(w, px, py, &cbt, &cpt, 9, 7, 20, 18, 0, true, max_z, None);
            }
            Ok(())
        });
        differential("paste terrain", bands, all, &|w| {
            // Off the west edge and over the world's top, so the clip path runs too.
            for (px, py, above) in [(-3, 20, true), (30, 30, false), (5, 5, true)] {
                paste_terrain_at(w, px, py, &cbt, &cpt, 9, 7, 20, 2, true, max_z, None, None, above);
            }
            Ok(())
        });
        let (sbt, spt) = cow_clipboard(6, 5, 8);
        differential("extrude x+", bands, all, &|w| {
            extrude_write(w, 3, 3, &sbt, &spt, 6, 5, 8, 28, max_z, "x+", 3, false, None); Ok(())
        });
        differential("extrude z+", bands, all, &|w| {
            extrude_write(w, 3, 3, &sbt, &spt, 6, 5, 8, 28, max_z, "z+", 2, true, None); Ok(())
        });
        differential("move", bands, all, &|w| {
            // `move_selection`'s closure shape: read, clear source, write shifted by (+9, +4, +5).
            let (x1, y1, wd, ht, z0, d) = (4, 4, 10, 8, 26, 20);
            let mut bt = vec![0u8; (wd * ht * d) as usize];
            let mut pt = bt.clone();
            for lx in 0..wd { for ly in 0..ht {
                let o = ((lx * ht + ly) * d) as usize;
                read_column_bulk(w, x1 + lx, y1 + ly, z0, d, &mut bt[o..o + d as usize], &mut pt[o..o + d as usize]);
            }}
            let zeros = vec![0u8; d as usize];
            for lx in 0..wd { for ly in 0..ht { write_column_bulk(w, x1 + lx, y1 + ly, z0, d, &zeros, &zeros); } }
            for lx in 0..wd { for ly in 0..ht {
                let o = ((lx * ht + ly) * d) as usize;
                write_column_bulk(w, x1 + lx + 9, y1 + ly + 4, z0 + 5, d, &bt[o..o + d as usize], &pt[o..o + d as usize]);
            }}
            Ok(())
        });
        differential("trees", bands, all, &|w| {
            generate_trees_inner(w, 0, 0, 47, 47, &["normal".to_string(), "pine".to_string(), "tall_pine".to_string()],
                0.04, &[], 11, false, None, None);
            Ok(())
        });
        differential("wavy", bands, all, &|w| {
            generate_wavy_surface_inner(w, 0, 0, 47, 47, max_z, 20, 0, 12.0, 0.5, 5, "fill", None); Ok(())
        });
        differential("flow", bands, all, &|w| {
            let z = surface_z(w, 20, 20).unwrap() + 1;
            set_block_abs(w, 20, 20, z, fluid_type_for(20, 4), 0);
            simulate_flow_inner(w, 15, 15, 25, 25, 12, 12, 28, 28, 0, max_z, false, 20, None);
            Ok(())
        });
        differential("pool (unenclosed → Err, rolled back)", bands, (5, 5, 30, 30), &|w| {
            let z = surface_z(w, 17, 17).unwrap() + 1;
            set_block_abs(w, 17, 17, z + 3, 7, 0); // a write before the Err: must roll back
            pool_fill_inner(w, 5, 5, 30, 30, 17, 17, z, max_z.min(z + 30), 20, 0, None)
        });
        differential("flood fill", bands, all, &|w| {
            let z = surface_z(w, 24, 24).unwrap() + 1;
            let cells = flood_fill_bfs(w, 24, 24, z, 3000)?;
            for (x, y, z) in cells { set_block_abs(w, x, y, z, 20, 0); }
            Ok(())
        });
        differential("fill surface", bands, all, &|w| {
            let (cells, _) = surface_region_bfs(w, 9, 9, false, 5000, None)?;
            for (x, y, z) in cells { set_block_abs(w, x, y, z, 13, 2); }
            Ok(())
        });
        for mode in ["raise", "lower", "smooth", "noise", "flatten"] {
            differential(&format!("sculpt {mode}"), bands, all, &|w| {
                let mut s = SculptSession::new(0);
                let stamps = vec![
                    SculptStamp { points: disc_points(14, 14, 6), dial: Some((14, 14, 6)) },
                    SculptStamp { points: disc_points(22, 17, 6), dial: Some((22, 17, 6)) },
                ];
                run_sculpt_flush(w, &mut s, &cow_sculpt_args(mode), &stamps)
            });
        }
    }
}

/// B.6 test 2 — an edit that writes several bands and then fails leaves the world byte-identical,
/// its scan ceilings invalidated, no undo entry and no dirty mark. (Before 18.12 the partial
/// writes stayed — un-undoable, invisible to the incremental save and the autosave journal.
/// Real closures that can do this: a multi-stamp sculpt flush where a later Flatten/Slope stamp
/// finds no surface, after earlier stamps wrote.)
#[test]
pub(crate) fn test_cow_edit_error_rolls_back_exactly() {
    let mut ws = cow_ws(16);
    let before = world_bytes(&ws);
    let seq = ws.dirty.seq;
    let hint_before = ws.world.as_ref().unwrap().top_band_hint(0, 0);
    let err = with_edit(&mut ws, "partial", (0, 0, 47, 47), |w| {
        for z in [5, 40, 90, 200] { set_block_abs(w, 3, 3, z, 9, 1); }
        set_block_abs(w, 40, 40, 33, 9, 1);
        Err("stamp 3 found no surface".into())
    }).err().expect("the closure's error propagates");
    assert_eq!(err, "stamp 3 found no surface");
    assert!(world_bytes(&ws) == before, "exact rollback");
    assert!(ws.undo_stack.is_empty() && ws.redo_stack.is_empty());
    assert_eq!(ws.dirty.seq, seq);
    assert!(dirty_chunks(&ws).is_empty());
    let w = ws.world.as_ref().unwrap();
    assert_eq!(w.top_bands.peek(0, 0), None, "the rolled-back chunk's ceiling was invalidated");
    assert_eq!(w.top_band_hint(0, 0), hint_before, "…and recomputes to the restored bytes");
    assert!(lamps_match_a_rebuild(&ws));
}

/// 29.9b — a closure that writes several bands and then **panics** keeps the world. It is rolled
/// back exactly, *before* the world goes back into `ws`, and the history around it is untouched.
/// The undo/redo that follow then reproduce the pre-panic states byte for byte. A half-written
/// world would make the next delta diff against bytes no entry describes.
#[test]
pub(crate) fn test_edit_closure_panic_keeps_world_rolled_back() {
    let mut ws = cow_ws(16);
    let base = world_bytes(&ws);
    with_edit(&mut ws, "A", (0, 0, 47, 47), |w| { set_block_abs(w, 5, 5, 100, 9, 0); Ok(()) }).expect("A");
    let after_a = world_bytes(&ws);
    with_edit(&mut ws, "B", (0, 0, 47, 47), |w| { set_block_abs(w, 30, 30, 120, 9, 0); Ok(()) }).expect("B");
    undo_edit_inner(&mut ws).expect("undo B"); // one entry on each stack
    assert_eq!(world_bytes(&ws), after_a);
    let (undo_len, redo_len, seq) = (ws.undo_stack.len(), ws.redo_stack.len(), ws.dirty.seq);

    let err = with_edit(&mut ws, "Fill", (0, 0, 47, 47), |w| {
        for z in [5, 40, 90, 200] { set_block_abs(w, 3, 3, z, 9, 1); }
        set_block_abs(w, 40, 40, 33, 9, 1);
        panic!("writer bug");
    }).err().expect("the panic becomes an Err");
    assert!(err.contains("Fill") && err.contains("writer bug"), "{err}");
    assert!(ws.world.is_some(), "the world survived the panic");
    assert!(world_bytes(&ws) == after_a, "exact rollback");
    assert_eq!((ws.undo_stack.len(), ws.redo_stack.len()), (undo_len, redo_len), "history untouched");
    assert_eq!(ws.dirty.seq, seq, "nothing marked dirty");
    assert!(lamps_match_a_rebuild(&ws));

    // A panic before any write is just as harmless.
    assert!(with_edit(&mut ws, "Early", (0, 0, 47, 47), |_| panic!("early")).is_err());
    assert!(world_bytes(&ws) == after_a);

    // The history still lines up with the bytes in both directions.
    redo_edit_inner(&mut ws).expect("redo B");
    undo_edit_inner(&mut ws).expect("undo B");
    assert!(world_bytes(&ws) == after_a);
    undo_edit_inner(&mut ws).expect("undo A");
    assert!(world_bytes(&ws) == base, "undo after the panic restores the original bytes");
}

/// 29.9b — a panic halfway through an undo (injected after the first restored chunk) keeps the
/// half-restored world. Both stacks are cleared (no delta describes these bytes any more), every
/// chunk the entry named is marked dirty, and a fresh edit's undo is exact against the bytes.
#[test]
pub(crate) fn test_undo_panic_keeps_world_and_clears_history() {
    let mut ws = cow_ws(16);
    let base = world_bytes(&ws);
    // One entry spanning three chunks, placing lamps (72) so the lamp index has work to do.
    with_edit(&mut ws, "Spread", (0, 0, 47, 47), |w| {
        set_block_abs(w, 3, 3, 100, 72, 0);
        set_block_abs(w, 20, 20, 100, 72, 0);
        set_block_abs(w, 40, 40, 100, 72, 0);
        Ok(())
    }).expect("edit");
    let after = world_bytes(&ws);
    assert_eq!(ws.undo_stack.back().unwrap().chunks.len(), 3);
    ws.dirty.since_disk.clear();

    RESTORE_PANIC_AFTER.with(|c| c.set(Some(1)));
    let err = undo_edit_inner(&mut ws).err().expect("the panic becomes an Err");
    assert!(err.contains("Undo") && err.contains("injected restore panic"), "{err}");
    let half = world_bytes(&ws);
    assert!(half != base && half != after, "a genuine half-restore");
    assert!(ws.undo_stack.is_empty() && ws.redo_stack.is_empty(), "both stacks cleared");
    assert_eq!((ws.undo_bytes, ws.redo_bytes, ws.undo_groups, ws.redo_groups), (0, 0, 0, 0));
    assert_eq!(dirty_chunks(&ws).len(), 3, "every chunk the entry named is dirty");
    assert!(ws.lamp_index.snapshot().is_empty(), "the lamp index was cleared (rebuilt lazily), not left stale");
    assert!(undo_edit_inner(&mut ws).is_err() && redo_edit_inner(&mut ws).is_err());

    // Editing goes on normally from the half-restored bytes.
    with_edit(&mut ws, "Next", (0, 0, 47, 47), |w| { set_block_abs(w, 10, 10, 150, 9, 0); Ok(()) }).expect("edit");
    undo_edit_inner(&mut ws).expect("undo");
    assert!(world_bytes(&ws) == half);

    // Redo has the same guard.
    with_edit(&mut ws, "Again", (0, 0, 47, 47), |w| {
        set_block_abs(w, 3, 3, 120, 9, 0);
        set_block_abs(w, 40, 40, 120, 9, 0);
        Ok(())
    }).expect("edit");
    undo_edit_inner(&mut ws).expect("undo");
    RESTORE_PANIC_AFTER.with(|c| c.set(Some(1)));
    let err = redo_edit_inner(&mut ws).err().expect("the panic becomes an Err");
    assert!(err.contains("Redo"), "{err}");
    assert!(ws.world.is_some() && ws.undo_stack.is_empty() && ws.redo_stack.is_empty());
}

/// B.6 test 4 — the `top_band_hint` trap. Warm a chunk's ceiling, raise a column far above it
/// inside one edit, and read the new top back *within the same edit* both through the view and
/// through `Deref` to the world. A stale ceiling would report the new blocks as air.
#[test]
pub(crate) fn test_cow_hint_covers_writes_inside_the_edit() {
    let mut ws = cow_ws(16);
    let warmed = ws.world.as_ref().unwrap().top_band_hint(1, 1);
    assert!(warmed < 10, "fixture terrain must sit well below band 12 (got {warmed})");
    with_edit(&mut ws, "tower", (16, 16, 31, 31), |w| {
        set_block_abs(w, 20, 20, 200, 1, 0); // band 12
        assert_eq!(surface_z(w, 20, 20), Some(200), "through the view");
        let world: &LoadedWorld = w;
        assert_eq!(surface_z(world, 20, 20), Some(200), "through Deref to the world");
        assert_eq!(read_block_abs(world, 20, 20, 200), 1);
        Ok(())
    }).expect("edit");
    let w = ws.world.as_ref().unwrap();
    assert_eq!(surface_z(w, 20, 20), Some(200), "and after the edit");
    assert!(w.top_band_hint(1, 1) >= 12);
}

/// B.6 test 5 — compare-before-write: an edit that rewrites every cell to its current value
/// captures nothing, keeps no undo entry and marks nothing dirty.
#[test]
pub(crate) fn test_cow_no_op_edits_capture_nothing() {
    let mut ws = cow_ws(16);
    let before = world_bytes(&ws);
    // Delete over pure air (everything above the terrain).
    let r = with_edit(&mut ws, "delete air", (0, 0, 47, 47), |w| {
        delete_blocks_inner(w, 0, 0, 47, 47, 100, 255, None); Ok(())
    }).expect("air delete");
    assert!(!r.undo_dropped);
    // Replace grass with itself, and re-paint a block with its own paint.
    with_edit(&mut ws, "replace same", (0, 0, 47, 47), |w| {
        replace_blocks_inner(w, 0, 0, 47, 47, 0, 255, 2, 0, Some(2), Some(0), false, None);
        let z = surface_z(w, 5, 5).unwrap();
        let (bt, pt) = get_block_at(w, 5, 5, z);
        set_block_abs(w, 5, 5, z, bt, pt);
        Ok(())
    }).expect("replace same");
    assert!(world_bytes(&ws) == before);
    assert!(ws.undo_stack.is_empty(), "no-op edits keep no undo entry");
    assert!(dirty_chunks(&ws).is_empty(), "…and mark nothing dirty");

    // And the capture itself is empty (not merely diffed away afterwards).
    let mut world = ws.world.take().unwrap();
    let mut view = EditView::unbounded(&mut world);
    delete_blocks_inner(&mut view, 0, 0, 47, 47, 100, 255, None);
    replace_blocks_inner(&mut view, 0, 0, 47, 47, 0, 255, 2, 0, Some(2), Some(0), false, None);
    write_column_bulk(&mut view, 7, 7, 120, 16, &[0; 16], &[0; 16]);
    assert_eq!(view.into_capture().captured, 0, "no band may be captured by a no-op write");
}

/// 18.12 hot-path budget (plan B.7): ⌘A replace on a 64z world, snapshot oracle vs copy-on-write.
/// Reports only — `cargo test -p eden-world-editor bench_cow -- --ignored --nocapture`.
#[test]
#[ignore]
pub(crate) fn bench_cow_select_all_replace() {
    let bytes = make_bumpy_world_grid(32, 3, |x, y| 10 + (x + y) % 30);
    let run = |oracle: bool| {
        let mut best = f64::MAX;
        for _ in 0..5 {
            let mut ws = ws_with(bytes.clone());
            let edit = |w: &mut EditView| {
                replace_blocks_inner(w, 0, 0, 511, 511, 0, 63, 7, 0, Some(3), None, false, None); Ok(())
            };
            let t = std::time::Instant::now();
            if oracle {
                with_edit_inner_oracle(&mut ws, "r", (0, 0, 511, 511), (0, 0, 511, 511), None, edit).unwrap();
            } else {
                with_edit(&mut ws, "r", (0, 0, 511, 511), edit).unwrap();
            }
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        }
        best
    };
    let (o, c) = (run(true), run(false));
    eprintln!("[bench] ⌘A replace 64z 32×32 chunks: oracle {o:.1} ms, cow {c:.1} ms ({:+.0} %)", (c / o - 1.0) * 100.0);
}

#[test]
pub(crate) fn test_scatter_placements_are_seeded() {
    let placements = scatter_placements(0, 0, 200, 200, 5, 42);
    assert_eq!(placements, scatter_placements(0, 0, 200, 200, 5, 42), "seeded and repeatable");
    assert_eq!(placements.len(), 5);
    assert!(placements.iter().all(|&(x, y)| (0..200).contains(&x) && (0..200).contains(&y)));
    // seed 0 maps to the fixed fallback stream, same as the edit used
    assert_eq!(scatter_placements(0, 0, 9, 9, 3, 0).len(), 3);
}

#[test]
pub(crate) fn test_scatter_and_array_edits_undo_exactly() {
    let mut ws = ws_with(make_grid_world(4));
    let before = world_bytes(&ws);
    let (w, h, d, za) = (3, 3, 2, 1);
    let bt = vec![13u8; (w * h * d) as usize];
    let pt = vec![4u8; (w * h * d) as usize];
    let spots = vec![(5, 5), (30, 14), (50, 50)]; // (30,14): footprint spans chunk seam x 30..32
    with_edit(&mut ws, "scatter", (0, 0, 63, 63), |world| {
        let mz = world_max_z(world);
        for &(px, py) in &spots {
            paste_clipboard_at(world, px, py, &bt, &pt, w, h, d, za, 0, false, mz, None);
        }
        Ok(())
    }).expect("scatter");
    let world = ws.world.as_ref().unwrap();
    for &(px, py) in &spots {
        assert_eq!(read_block_abs(world, px + 2, py + 2, za + 1), 13, "pasted at {px},{py}");
    }
    assert_eq!(read_block_abs(world, 32, 14, za), 13, "seam-straddling cell landed in the neighbour chunk");
    undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(world_bytes(&ws), before, "every chunk the paste touched was captured");
}

#[test]
pub(crate) fn test_terrain_paste_across_surface_heights_undoes() {
    // Two 16x16 chunks side by side; chunk (1,0) terrain sits at z=20, chunk (0,0) at z=1.
    let mut bytes = make_grid_world(2);
    for lx in 0..16usize { for ly in 0..16usize {
        let off = HEADER + 32768 * 1; // chunk (1,0) is slot 1
        bytes[off + lx * 256 + ly * 16 + 4] = 2; // z=4 solid
        bytes[off + 8192 + lx * 256 + ly * 16 + 4] = 2; // z=20 solid
    }}
    let mut ws = ws_with(bytes);
    let before = world_bytes(&ws);
    let lo = surface_z(ws.world.as_ref().unwrap(), 10, 2).unwrap() + 1;

    let cb = Clipboard { width: 12, height: 2, depth: 3, z_anchor: 0,
        block_types: vec![13u8; 72], paints: vec![0u8; 72], mask: None, origin: None };
    ws.clipboard = Some(cb);
    paste_terrain_inner(&mut ws, 10, 2, 0, false, true).expect("terrain paste");
    assert_eq!(ws.undo_stack.len(), 1);
    assert_eq!(read_block_abs(ws.world.as_ref().unwrap(), 10, 2, lo), 13);
    undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(world_bytes(&ws), before);
}

/// Placing more doors than `RISKY_BLOCK_GROUPS`' threshold in one edit footprint surfaces a
/// warning (the ComBlock crash writeup); staying under it stays silent, and a different block
/// type entirely never warns.
#[test]
pub(crate) fn test_risky_block_density_warns_on_dense_doors() {
    let mut ws = ws_with(make_test_world());
    let rect = (0, 0, 15, 15);

    let door_threshold = RISKY_BLOCK_GROUPS.iter().find(|g| g.name == "doors").unwrap().threshold;
    let over = (door_threshold + 1) as i32;

    let r = with_edit(&mut ws, "dense doors", rect, |w| {
        for i in 0..over { set_block_abs(w, i % 16, i / 16, 0, 66, 0); }
        Ok(())
    }).expect("edit applies");
    assert!(r.warnings.iter().any(|w| w.contains("doors")),
            "placing {over} doors in one footprint must warn");

    let r = with_edit(&mut ws, "sparse doors", rect, |w| {
        set_block_abs(w, 0, 0, 1, 66, 0);
        Ok(())
    }).expect("edit applies");
    assert!(r.warnings.is_empty(), "a single door must not warn");

    let r = with_edit(&mut ws, "dense non-risky", rect, |w| {
        for i in 0..over { set_block_abs(w, i % 16, i / 16, 2, 2, 0); } // plain Stone
        Ok(())
    }).expect("edit applies");
    assert!(r.warnings.is_empty(), "a dense placement of a non-risky block type must not warn");
}

/// Doors are placed as two physical blocks — a directional base plus a `DoorTop` one z above it
/// (`paint_blocks`'s auto-pairing; paste/gen copy both halves too). The "doors" group only sums
/// the base types (66–69), so the density check counts real door objects, not doubled block
/// cells. Before this fix the group summed base+top together, so `threshold` real doors reported
/// as `2×threshold` and warned at half the intended door count.
#[test]
pub(crate) fn test_risky_block_density_counts_real_doors_not_paired_blocks() {
    let door_threshold = RISKY_BLOCK_GROUPS.iter().find(|g| g.name == "doors").unwrap().threshold;
    let rect = (0, 0, 15, 15);

    let mut ws = ws_with(make_test_world());
    let r = with_edit(&mut ws, "doors at threshold", rect, |w| {
        for i in 0..door_threshold as i32 {
            set_block_abs(w, i % 16, i / 16, 0, 66, 0); // base
            set_block_abs(w, i % 16, i / 16, 1, 70, 0); // paired DoorTop
        }
        Ok(())
    }).expect("edit applies");
    assert!(r.warnings.is_empty(), "{door_threshold} real doors (base+paired top) must not warn");

    let mut ws = ws_with(make_test_world());
    let over = door_threshold as i32 + 1;
    let r = with_edit(&mut ws, "doors over threshold", rect, |w| {
        for i in 0..over {
            set_block_abs(w, i % 16, i / 16, 0, 66, 0);
            set_block_abs(w, i % 16, i / 16, 1, 70, 0);
        }
        Ok(())
    }).expect("edit applies");
    assert!(r.warnings.iter().any(|w| w.contains(&format!("{over} doors"))),
            "must report the real door count ({over}), not doubled by the paired top blocks: {:?}",
            r.warnings);
}

/// Regression for the `Full`/`FullZ` dense-delta branch of `count_new_block_types`: it must only
/// tally cells that actually changed, not every cell in the captured pre-edit span. A `Full`
/// delta captures the *whole* chunk once enough of it differs (`diff_span`'s 20% rule) — before
/// this fix, any edit that pushed a chunk's delta into `Full` form swept every pre-existing block
/// in that chunk into the "just placed" tally, including risky blocks the edit never touched.
#[test]
pub(crate) fn test_dense_delta_only_counts_changed_cells_not_whole_span() {
    let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");

    // Pre-existing doors from an earlier, unrelated edit — well above the "doors" threshold on
    // their own, but not part of the edit under test.
    for i in 0..200i32 {
        set_block_abs(&mut world, i % 16, i / 16, 0, 66, 0);
    }
    let pre_full = snapshot_chunks_full(&world, &[(0, 0)], None);

    // An unrelated large edit in a disjoint z-range — fill enough of the chunk with Stone to
    // force a Full/dense delta (> 20% of the 32768-byte chunk, i.e. > 6553 changed bytes).
    for z in 16..48i32 {
        for x in 0..16i32 {
            for y in 0..16i32 {
                set_block_abs(&mut world, x, y, z, 2, 0); // Stone
            }
        }
    }
    let snap = diff_chunk(&world, 0, 0, pre_full[0].2, &pre_full[0].3).expect("dense change diffs");
    assert!(matches!(snap.delta, ChunkDelta::Full(..)), "edit must have produced a Full delta");

    let counts = count_new_block_types(&world, std::slice::from_ref(&snap));
    assert_eq!(counts[66], 0, "pre-existing, untouched doors must not be tallied as newly placed");
    assert!(risky_block_warnings(&counts).is_empty(),
            "a Stone fill must never warn about doors it never touched");
}

/// 13.2 — with relief on, an edited column changes the shade of the samples one LOD step east
/// and south of it, so `edit_patch` must grow its rect there. The patch has to match a fresh
/// full render over that grown rect, pixel for pixel, at every LOD — otherwise an edit leaves a
/// stale-shaded seam beside it until the tile is refetched.
#[test]
pub(crate) fn test_relief_edit_patch_covers_east_and_south_neighbours() {
    let mut b = make_test_world();
    let at = |lx: usize, ly: usize, z: usize| 4096 + (z / 16) * 8192 + lx * 256 + ly * 16 + z % 16;
    for lx in 0..16 { for ly in 0..16 { for z in 0..=4 { b[at(lx, ly, z)] = 1; } } }
    for z in 5..=12 { b[at(6, 6, z)] = 1; } // the "edited" column, much higher than its neighbours
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    let relief = MapStyle { cap: None, relief: Some(100) };

    for (lod, rect) in [(1u32, (6, 6, 6, 6)), (2, (6, 6, 6, 6)), (4, (4, 4, 7, 7))] {
        let (p, invalidated) = edit_patch(&world, rect, relief, lod);
        assert!(!invalidated);
        let full = render_pixels_patch_styled(&world, 0, 0, 15, 15, relief, lod);
        // Grown by one step east and south of the (lod-floored) edit rect.
        let fx = (rect.0 as u32 / lod) * lod;
        assert_eq!(p.x, fx, "lod {lod}");
        assert_eq!(p.width, (rect.2 as u32 + lod - fx) / lod + 1, "lod {lod}");
        assert_eq!(p.height, (rect.3 as u32 + lod - fx) / lod + 1, "lod {lod}");
        for oy in 0..p.height {
            for ox in 0..p.width {
                let po = ((oy * p.width + ox) * 4) as usize;
                let fo = (((p.y / lod + oy) * full.width + p.x / lod + ox) * 4) as usize;
                assert_eq!(&p.pixels[po..po + 4], &full.pixels[fo..fo + 4], "lod {lod} ({ox},{oy})");
            }
        }
    }
    // …and the grown column really is shaded by the edit: the sample east of the column sits
    // in its shadow, so it differs from the plain render.
    let plain = render_pixels_patch_styled(&world, 7, 6, 7, 6, MapStyle::default(), 1);
    let shaded = render_pixels_patch_styled(&world, 7, 6, 7, 6, relief, 1);
    assert_ne!(plain.pixels, shaded.pixels);
    // Relief off: no growth — the pre-13.2 rect exactly.
    let (p, _) = edit_patch(&world, (6, 6, 6, 6), MapStyle::default(), 1);
    assert_eq!((p.width, p.height), (1, 1));
}

/// C2 — an edit patch larger than `MAX_EDIT_PATCH_PIXELS` ships as an `invalidate` rect with no
/// pixels at all, instead of the 243 MB RGBA buffer a ⌘A fill used to build.
#[test]
pub(crate) fn test_edit_patch_caps_oversized_rect() {
    let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    // A rect far larger than the cap. `edit_patch` clamps to the world first, so ask it
    // directly with the cap lowered by raising the LOD instead: at lod 1 this 1-chunk world
    // can't produce an oversized patch, so drive the arithmetic through the helper's own guard.
    let (small, invalidated) = edit_patch(&world, (0, 0, 15, 15), MapStyle::default(), 1);
    assert!(!invalidated && !small.pixels.is_empty(), "a 16×16 patch is nowhere near the cap");
    assert_eq!((small.width, small.height, small.lod), (16, 16, 1));

    // Same rect against a cap it *does* exceed (a fixture large enough to reach the real
    // 2 M-pixel ceiling would be a 260 MB world, hence the parameterised cap).
    let (big, invalidated) = edit_patch_capped(&world, (0, 0, 15, 15), MapStyle::default(), 1, 100);
    assert!(invalidated, "a patch past the cap must ask the frontend to refetch instead");
    assert!(big.pixels.is_empty(), "an invalidate patch must carry no pixels at all");
    assert_eq!((big.x, big.y, big.width, big.height, big.lod), (0, 0, 16, 16, 1),
               "…but must still describe the rect to refetch");
}

/// C2/M3 — the patch origin is floored to a multiple of `lod` so the patch point-samples the
/// same block grid the LOD tiles do; a patch half a step out of phase cannot be blitted onto
/// them. Dimensions must also describe *sampled* pixels, not world blocks.
#[test]
pub(crate) fn test_edit_patch_lod_aligns_origin_and_samples() {
    let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    let (p, invalidated) = edit_patch(&world, (5, 6, 12, 12), MapStyle::default(), 4);
    assert!(!invalidated);
    assert_eq!((p.x, p.y), (4, 4), "origin must floor to the LOD grid");
    assert_eq!(p.lod, 4);
    assert_eq!((p.width, p.height), (3, 3), "(12-4)/4 + 1 sampled pixels per axis");
    assert_eq!(p.pixels.len(), 3 * 3 * 4);
    // Same pixels a full-resolution render would show at those sampled coordinates.
    let full = render_pixels_patch(&world, 4, 4, 12, 12, None);
    for (oy, ox) in [(0usize, 0usize), (1, 2), (2, 1)] {
        let a = ((oy * 3) + ox) * 4;
        let b = (((oy * 4) * 9) + ox * 4) * 4;
        assert_eq!(&p.pixels[a..a + 4], &full.pixels[b..b + 4], "sample ({ox},{oy}) must match the full render");
    }
}

/// C3 — the writers stream chunk bytes from the mmap now, so the zero-padding a short-span
/// chunk used to get from `Vec::resize` has to come from `write_chunk_padded` instead. Both
/// directions matter: a short span pads up to `chunk_size`, and an over-long one (a chunk whose
/// successor starts further away than `chunk_size`) truncates rather than desyncing every
/// offset after it.
#[test]
pub(crate) fn test_write_chunk_padded_pads_and_truncates() {
    let mut out = Vec::new();
    write_chunk_padded(&mut out, &[1, 2, 3], 10).expect("write");
    assert_eq!(out, vec![1, 2, 3, 0, 0, 0, 0, 0, 0, 0], "a short span pads out to chunk_size");

    let mut out = Vec::new();
    write_chunk_padded(&mut out, &[9u8; 20], 8).expect("write");
    assert_eq!(out, vec![9u8; 8], "an over-long span is clipped to chunk_size");

    // The padding loop steps by an 8 KB zero block; a chunk-sized pad must still be exact.
    let mut out = Vec::new();
    write_chunk_padded(&mut out, &[], 32768).expect("write");
    assert_eq!(out.len(), 32768);
    assert!(out.iter().all(|&b| b == 0));
}

/// The `(coords, src)` pair `materialize_flat_chunks_inner` now takes (audit C3) — sorted chunk
/// coordinates plus a closure borrowing each one's bytes straight out of the world's mapping.
pub(crate) fn materialize_src<'a>(world: &'a LoadedWorld) -> (Vec<(i32, i32)>, impl Fn(i32, i32) -> Option<&'a [u8]> + 'a) {
    let mut coords: Vec<(i32, i32)> = world.chunk_map.keys().copied()
        .filter(|&(cx, cy)| world.chunk_range(cx, cy).is_some())
        .collect();
    coords.sort_unstable();
    (coords, move |cx, cy| world.chunk_range(cx, cy).map(|(off, cend)| &world.bytes[off..cend]))
}

/// Names a delta's variant for assertion messages (the enum isn't `Debug`).
pub(crate) fn delta_kind(d: &ChunkDelta) -> String {
    match d {
        ChunkDelta::Sparse(v) => format!("Sparse({} entries)", v.len()),
        ChunkDelta::Full(_, b) => format!("Full({} bytes)", b.len()),
        ChunkDelta::FullZ(_, z, raw) => format!("FullZ({} bytes, raw {raw})", z.len()),
        ChunkDelta::SparseZ(z, n) => format!("SparseZ({} bytes, {n} entries)", z.len()),
    }
}

/// Delta-undo round trip (D4): `diff_chunk` must pick `Sparse` for a single-byte edit and
/// `Full` for a dense one, and `restore_and_invert` must be exactly invertible in both cases
/// — including toggling undo→redo→undo again, not just a single pass.
#[test]
pub(crate) fn test_delta_undo_round_trip() {
    let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    let target = blk(3, 5, 0);

    // ── Sparse case: mutate exactly one byte of a 32 KB chunk ──────────────────────────
    let pre_full = snapshot_chunks_full(&world, &[(0, 0)], None);
    let original_val = world.bytes[target];
    world.bytes[target] = 99;

    let snap = diff_chunk(&world, 0, 0, pre_full[0].2, &pre_full[0].3).expect("changed chunk must diff to Some");
    match &snap.delta {
        ChunkDelta::Sparse(pairs) => assert_eq!(pairs.len(), 1, "single-byte edit must diff to one sparse entry"),
        other => panic!("single-byte edit should not fall back to Full/FullZ: {}", delta_kind(other)),
    }

    let entry = UndoEntry::new("test", vec![snap], None);
    let redo_chunks = restore_and_invert(&mut world, &entry);
    assert_eq!(world.bytes[target], original_val, "undo must restore the original byte");

    let redo_entry = UndoEntry::new("test", redo_chunks, None);
    let undo_again_chunks = restore_and_invert(&mut world, &redo_entry);
    assert_eq!(world.bytes[target], 99, "redo must restore the edited byte");

    restore_and_invert(&mut world, &UndoEntry::new("test", undo_again_chunks, None));
    assert_eq!(world.bytes[target], original_val, "second undo must restore the original byte again");

    // ── Dense case: overwrite the whole file so diff_chunk falls back to Full ──────────
    let pre_full2 = snapshot_chunks_full(&world, &[(0, 0)], None);
    for b in world.bytes.iter_mut() { *b = 0xAB; }
    let snap2 = diff_chunk(&world, 0, 0, pre_full2[0].2, &pre_full2[0].3).expect("dense change must diff to Some");
    match &snap2.delta {
        ChunkDelta::Full(_, _) => {}
        // `diff_chunk` never compresses — `UndoEntry::new` does, on the way onto a stack.
        other => panic!("dense edit should fall back to Full, got {}", delta_kind(other)),
    }
    restore_and_invert(&mut world, &UndoEntry::new("test", vec![snap2], None));
    assert_eq!(&world.bytes[HEADER..HEADER + 32768], &pre_full2[0].3[..],
        "Full-delta undo must restore the whole chunk");
}

/// 18.5 — pack/unpack is exact, including unsorted and large-gap offsets.
#[test]
pub(crate) fn test_sparse_pack_round_trip() {
    let pairs: Vec<(u32, u8)> = vec![(0, 1), (5, 2), (4, 3), (131_071, 255), (70_000, 0), (70_001, 9)];
    let z = pack_sparse(&pairs).unwrap();
    assert_eq!(unpack_sparse(&z, pairs.len() as u32).unwrap(), pairs);
    assert!(unpack_sparse(&z, 1000).is_none(), "wrong count must fail, not panic");
    assert_eq!(unpack_sparse(&pack_sparse(&[]).unwrap(), 0).unwrap(), vec![]);
}

/// 18.5 — a ~15% sparse edit is stored as `SparseZ` well under its old 8 B/entry price, the byte
/// accounting matches the real payload, and undo/redo/undo round-trips exactly. A tiny edit
/// stays plain `Sparse` (packing wouldn't pay for itself).
#[test]
pub(crate) fn test_sparse_delta_compresses_and_round_trips() {
    let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    let pre_full = snapshot_chunks_full(&world, &[(0, 0)], None);
    let orig: Vec<u8> = world.bytes[HEADER..HEADER + 32768].to_vec();
    let mut changed = 0usize;
    for i in (0..32768).step_by(7) {
        world.bytes[HEADER + i] = world.bytes[HEADER + i].wrapping_add(1);
        changed += 1;
    }
    let edited: Vec<u8> = world.bytes[HEADER..HEADER + 32768].to_vec();
    let snap = diff_chunk(&world, 0, 0, pre_full[0].2, &pre_full[0].3).unwrap();
    assert!(matches!(snap.delta, ChunkDelta::Sparse(ref p) if p.len() == changed),
        "~14% edit must be Sparse pre-push, got {}", delta_kind(&snap.delta));
    let old_cost = changed * 8;
    let entry = UndoEntry::new("t", vec![snap], None);
    match &entry.chunks[0].delta {
        ChunkDelta::SparseZ(z, n) => {
            assert_eq!(*n as usize, changed);
            assert!(entry.bytes == z.capacity() + 40 && entry.bytes < old_cost / 2,
                "SparseZ must be honestly priced and far below 8 B/entry: {} vs {old_cost}", entry.bytes);
        }
        other => panic!("expected SparseZ, got {}", delta_kind(other)),
    }
    let redo = restore_and_invert(&mut world, &entry);
    assert_eq!(&world.bytes[HEADER..HEADER + 32768], &orig[..], "undo restores original");
    let redo_entry = UndoEntry::new("t", redo, None);
    let undo2 = restore_and_invert(&mut world, &redo_entry);
    assert_eq!(&world.bytes[HEADER..HEADER + 32768], &edited[..], "redo restores edit");
    restore_and_invert(&mut world, &UndoEntry::new("t", undo2, None));
    assert_eq!(&world.bytes[HEADER..HEADER + 32768], &orig[..], "second undo restores original");

    // Tiny edit stays plain Sparse.
    let one = ChunkDelta::Sparse(vec![(3, 7)]).compressed();
    assert!(matches!(one, ChunkDelta::Sparse(_)), "1-entry delta must not be packed: {}", delta_kind(&one));
}

/// H1 (3D fly-view build-gesture audit) — `paint_blocks` accepts a `group: Option<u64>` routed
/// through `with_edit_grouped`, so a run of stamps sharing one gesture id collapses to a single
/// logical undo unit: `count_undo_groups` reports 1, and one `undo_edit` reverts every stamp.
/// `paint_blocks` itself takes a `tauri::State` the test build has no harness to construct (see
/// `test_flood_fill_accepts_new_block_types`'s comment on the same limitation), so this exercises
/// `with_edit_grouped` directly with the same one-block-per-call shape paint_blocks uses.
#[test]
pub(crate) fn test_paint_blocks_group_collapses_undo() {
    let mut ws = ws_with(make_bumpy_world_grid(1, 8, |_, _| 20));
    let group = Some(42u64);
    for i in 0..5 {
        let (x, y) = (i, 0);
        with_edit_grouped(&mut ws, "Paint 1 block", (x, y, x, y), group, |world| {
            set_block_abs(world, x, y, 21, 2, 0);
            Ok(())
        }).expect("grouped stamp");
    }
    assert_eq!(count_undo_groups(&ws.undo_stack), 1, "5 same-group stamps must collapse to one undo unit");
    assert_eq!(ws.undo_stack.len(), 5, "the stack itself still holds one entry per stamp");

    undo_edit_inner(&mut ws).expect("undo the whole gesture");
    assert!(ws.undo_stack.is_empty(), "one undo must pop every entry in the group");
    let world = ws.world.as_ref().unwrap();
    for i in 0..5 {
        assert_eq!(read_block_abs(world, i, 0, 21), 0, "stamp {i} must be reverted");
    }
}

/// Sibling of the above: `group: None` (every non-build `paint_blocks` caller) must be unaffected
/// — each call is still its own undo entry, no regression for the 2D draw/fill/slice paths.
#[test]
pub(crate) fn test_paint_blocks_ungrouped_unchanged() {
    let mut ws = ws_with(make_bumpy_world_grid(1, 8, |_, _| 20));
    for i in 0..5 {
        let (x, y) = (i, 0);
        with_edit_grouped(&mut ws, "Paint 1 block", (x, y, x, y), None, |world| {
            set_block_abs(world, x, y, 21, 2, 0);
            Ok(())
        }).expect("ungrouped stamp");
    }
    assert_eq!(count_undo_groups(&ws.undo_stack), 5, "ungrouped stamps must not coalesce");
    assert_eq!(ws.undo_stack.len(), 5);

    undo_edit_inner(&mut ws).expect("undo one entry");
    assert_eq!(ws.undo_stack.len(), 4, "an ungrouped undo must pop exactly one entry");
    let world = ws.world.as_ref().unwrap();
    assert_eq!(read_block_abs(world, 4, 0, 21), 0, "only the last stamp is reverted");
    assert_eq!(read_block_abs(world, 0, 0, 21), 2, "earlier stamps are untouched");
}

/// §1a — a fresh edit after an undo must reset `redo_bytes` to 0, not just clear `redo_stack`.
/// Before the fix, `ws.clear_redo()` didn't exist and `with_edit_inner` only cleared the
/// stack, leaving the byte counter stale for the rest of the session.
#[test]
pub(crate) fn test_redo_bytes_reset_on_new_edit() {
    let mut ws = ws_with(make_bumpy_world_grid(1, 8, |_, _| 20));
    with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
        delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
        Ok(())
    }).expect("edit 1");
    undo_edit_inner(&mut ws).expect("undo");
    assert!(ws.redo_bytes > 0, "undo must have populated the redo stack's byte total");

    with_edit(&mut ws, "delete", (0, 0, 3, 3), |world| {
        delete_blocks_inner(world, 0, 0, 3, 3, 0, 63, None);
        Ok(())
    }).expect("edit 2");
    assert_eq!(ws.redo_bytes, 0, "a new edit must reset redo_bytes, not just clear redo_stack");
    assert!(ws.redo_stack.is_empty());
}

/// §1c — lowering the undo budget via `set_undo_budget` must immediately re-trim both stacks
/// to fit, and the cached byte totals must match a fresh re-sum (no drift from the eviction).
#[test]
pub(crate) fn test_undo_budget_trims_on_lower() {
    let mut ws = ws_with(make_bumpy_world_grid(1, 8, |_, _| 20));
    // Many small, distinct edits so the stack has several evictable entries.
    for i in 0..40 {
        let z = (i % 20) as i32;
        with_edit(&mut ws, "raise", (0, 0, 15, 15), |world| {
            set_block_abs(world, i % 16, (i / 16) % 16, z, 2, 0);
            Ok(())
        }).expect("edit");
    }
    assert!(ws.undo_stack.len() > 1, "need multiple entries for trimming to be observable");

    let low_budget = 64usize; // far below any real entry — trim_stack's len()>1 floor kicks in
    trim_stack(&mut ws.undo_stack, &mut ws.undo_bytes, &mut ws.undo_groups, low_budget);
    ws.undo_budget = low_budget;

    let resummed: usize = ws.undo_stack.iter().map(|e| e.bytes).sum();
    assert_eq!(ws.undo_bytes, resummed, "cached total must match a fresh re-sum after trimming");
    assert_eq!(ws.undo_stack.len(), 1, "trims down to the len()>1 floor when every entry alone exceeds budget");
}

/// Phase 4.2 — `WorldState::undo_groups`/`redo_groups` are maintained incrementally by
/// `push_undo`/`pop_undo`/`trim_stack`, so they must agree with the `count_undo_groups` walk
/// after *every* shape of stack mutation, not just the easy ones. Same idiom as
/// `test_snapshot_bytes_matches_real_capacity`: assert the cache against a fresh recomputation.
///
/// The sequence deliberately mixes the cases the incremental rule can get almost right:
/// two different groups back to back, an ungrouped edit splitting one group id into two
/// non-adjacent runs (which must count as **two** units, not one), budget-driven front
/// eviction inside a group, and undo/redo moving whole groups between the stacks.
#[test]
pub(crate) fn test_cached_group_counts_match_the_oracle() {
    let mut ws = ws_with(make_bumpy_world_grid(1, 8, |_, _| 20));
    let mut n = 0i32;
    let mut edit = |ws: &mut WorldState, group: Option<u64>, n: &mut i32| {
        let (x, y, z) = (*n % 16, (*n / 16) % 16, 21 + *n % 8);
        *n += 1;
        with_edit_grouped(ws, "stamp", (x, y, x, y), group, |world| {
            set_block_abs(world, x, y, z, 2, 0);
            Ok(())
        }).expect("edit");
    };
    let check = |ws: &WorldState, what: &str| {
        assert_eq!(ws.undo_groups, count_undo_groups(&ws.undo_stack), "undo_groups after {what}");
        assert_eq!(ws.redo_groups, count_undo_groups(&ws.redo_stack), "redo_groups after {what}");
    };

    // Group 1 (3 stamps) → group 2 (2 stamps) → ungrouped → group 1 again (2 stamps).
    // The trailing run of group 1 is *not* contiguous with the first, so it's its own unit.
    for _ in 0..3 { edit(&mut ws, Some(1), &mut n); }
    check(&ws, "one group of 3");
    assert_eq!(ws.undo_groups, 1);
    for _ in 0..2 { edit(&mut ws, Some(2), &mut n); }
    edit(&mut ws, None, &mut n);
    for _ in 0..2 { edit(&mut ws, Some(1), &mut n); }
    check(&ws, "mixed grouped/ungrouped pushes");
    assert_eq!(ws.undo_groups, 4, "group1 | group2 | ungrouped | group1-again");
    assert_eq!(ws.undo_stack.len(), 8, "the stack still holds one entry per stamp");

    // Undo/redo move whole groups across the stacks, one logical unit at a time.
    undo_edit_inner(&mut ws).expect("undo the trailing group-1 run");
    check(&ws, "one undo");
    assert_eq!((ws.undo_groups, ws.redo_groups), (3, 1));
    undo_edit_inner(&mut ws).expect("undo the ungrouped edit");
    check(&ws, "two undos");
    assert_eq!((ws.undo_groups, ws.redo_groups), (2, 2));
    redo_edit_inner(&mut ws).expect("redo");
    check(&ws, "redo");
    assert_eq!((ws.undo_groups, ws.redo_groups), (3, 1));

    // A fresh edit clears redo — the counter must clear with the stack.
    edit(&mut ws, None, &mut n);
    check(&ws, "a new edit clearing redo");
    assert_eq!(ws.redo_groups, 0);

    // Budget-driven eviction from the *front*: entries leave oldest-first, so a group only
    // stops counting once its last member is gone. Trim one entry at a time so the boundary
    // case (evicting the first of a same-group pair) is actually exercised.
    while ws.undo_stack.len() > 1 {
        let budget = ws.undo_bytes - ws.undo_stack.front().unwrap().bytes;
        trim_stack(&mut ws.undo_stack, &mut ws.undo_bytes, &mut ws.undo_groups, budget);
        check(&ws, "an incremental front eviction");
    }

    ws.clear_undo();
    ws.clear_redo();
    check(&ws, "clear");
    assert_eq!((ws.undo_groups, ws.redo_groups), (0, 0));
}

/// Phase 4.1, kept through 18.12 — a paint batch's undo must be exactly invertible for every
/// block it writes, including across a band boundary: a door base at z=31 (band 1, top lz) whose
/// auto-placed top lands at z=32 (band 2), plus a write in band 0 in the same edit. (Before
/// 18.12 a hand-derived z range scoped the snapshot and a too-narrow one failed silently; the
/// copy-on-write capture has no range to get wrong, and this pins that.)
#[test]
pub(crate) fn test_paint_z_scoped_undo_restores_writes_outside_the_base_band() {
    let mut ws = ws_with(make_bumpy_world_grid(1, 8, |_, _| 20));
    let before = world_bytes(&ws);

    // Same write pattern `paint_blocks`' closure produces for a door batch, with the range it
    // would have derived. z=4 exercises the low end (band 0) in the same edit.
    let blocks = vec![
        PaintBlock { x: 3, y: 5, z: Some(31) },
        PaintBlock { x: 6, y: 2, z: Some(4) },
    ];
    with_edit_grouped(&mut ws, "Paint 2 blocks", (3, 2, 6, 5), Some(7), |world| {
        for b in &blocks {
            let z = b.z.unwrap();
            set_block_abs(world, b.x, b.y, z, 66, 0);
            set_block_abs(world, b.x, b.y, z + 1, 70, 0);
        }
        Ok(())
    }).expect("z-scoped paint");

    {
        let world = ws.world.as_ref().unwrap();
        assert_eq!(read_block_abs(world, 3, 5, 31), 66);
        assert_eq!(read_block_abs(world, 3, 5, 32), 70, "the top block crosses into band 2");
        assert_eq!(read_block_abs(world, 6, 2, 4), 66);
        assert_eq!(read_block_abs(world, 6, 2, 5), 70);
    }

    undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(world_bytes(&ws), before,
               "undo must restore the world byte-for-byte — including the door top one band \
                above the highest block the batch was asked to place");
}

/// §1b — `chunk_snapshot_bytes` must report real heap capacity (post `shrink_to_fit`), not an
/// undercount based on `len()` alone: `(u32,u8)` is 8 bytes (align 4, padded), not 5.
#[test]
pub(crate) fn test_snapshot_bytes_matches_real_capacity() {
    let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    let pre_full = snapshot_chunks_full(&world, &[(0, 0)], None);
    world.bytes[blk(3, 5, 0)] = 99;
    world.bytes[blk(7, 2, 10)] = 5;
    let snap = diff_chunk(&world, 0, 0, pre_full[0].2, &pre_full[0].3).expect("must diff to Some");
    match &snap.delta {
        ChunkDelta::Sparse(pairs) => {
            assert_eq!(pairs.capacity(), pairs.len(), "diff_chunk must shrink_to_fit before it's ever counted");
            assert_eq!(chunk_snapshot_bytes(&snap), pairs.capacity() * 8 + 40);
        }
        other => panic!("two-byte edit should not fall back to Full/FullZ: {}", delta_kind(other)),
    }
}

/// §5 — `TemplateSurfaceCache` must evict oldest entries once past `TEMPLATE_SURFACE_CACHE_LIMIT`,
/// keeping `map`/`order` in lockstep (no leftover key reachable via `get` after eviction).
#[test]
pub(crate) fn template_surface_cache_evicts_oldest_past_limit() {
    let mut cache = TemplateSurfaceCache::default();
    let n = TEMPLATE_SURFACE_CACHE_LIMIT + 100;
    for i in 0..n {
        cache.insert((i as i32, 0), Box::new([[0u8; 4]; 256]));
    }
    assert_eq!(cache.len(), TEMPLATE_SURFACE_CACHE_LIMIT, "must never exceed the bound");
    assert!(!cache.contains_key(&(0, 0)), "oldest entries must be evicted first");
    assert!(cache.contains_key(&((n - 1) as i32, 0)), "most recent entry must survive");
    cache.clear();
    assert_eq!(cache.len(), 0, "clear must empty both map and order");
}

/// Audit C2 Stage 1 — `DirtyState.since_disk` must equal the *actual* set of changed chunks
/// (+ header) after a scripted mix of edits, undo and redo. This is the test that catches a
/// missed hook site: if any of `with_edit_inner` / `undo_edit_inner` / `redo_edit_inner` /
/// the header writers forgot to call `mark_chunks`/`mark_header`, the ground-truth diff below
/// (computed independently, by comparing bytes) would disagree with `ws.dirty.since_disk`.
#[test]
pub(crate) fn test_dirty_set_matches_ground_truth() {
    let original = make_bumpy_world_grid(2, 8, |_, _| 20); // 2×2 chunks: (0,0) (1,0) (0,1) (1,1)
    let mut ws = ws_with(original.clone());

    // Edit 1: delete a rect that only touches chunk (0,0) — grouped None (immediate undo entry).
    with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
        delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
        Ok(())
    }).expect("delete chunk (0,0)");

    // Edit 2: delete a rect spanning all four chunks.
    with_edit(&mut ws, "delete", (0, 0, 31, 31), |world| {
        delete_blocks_inner(world, 0, 0, 31, 31, 0, 63, None);
        Ok(())
    }).expect("delete all chunks");

    // Undo the second delete — restores chunks (0,0),(1,0),(0,1),(1,1) again (all still "dirty"
    // relative to the original on-disk image, since undo doesn't return them to the as-loaded
    // bytes: chunk (0,0) is still missing edit 1's deletion).
    undo_edit_inner(&mut ws).expect("undo");

    // Redo it — re-deletes all four chunks.
    redo_edit_inner(&mut ws).expect("redo");

    // Header-only change: mirrors what set_spawn_pos does (write header bytes, mark dirty).
    {
        let world = ws.world.as_mut().unwrap();
        write_spawn(world, 5.0, 5.0);
    }
    ws.dirty.mark_header();

    // ── Ground truth: diff final bytes against the pristine as-loaded copy, chunk by chunk ──
    let world = ws.world.as_ref().unwrap();
    let mut expected_chunks: std::collections::HashSet<(i32, i32)> = std::collections::HashSet::new();
    for (&(cx, cy), _) in world.chunk_map.iter() {
        let (addr, end) = world.chunk_range(cx, cy).unwrap();
        if world.bytes[addr..end] != original[addr..end] {
            expected_chunks.insert((cx, cy));
        }
    }
    let expected_header = world.bytes[0..192] != original[0..192];

    let actual_chunks: std::collections::HashSet<(i32, i32)> =
        ws.dirty.since_disk.keys().copied().collect();
    assert_eq!(actual_chunks, expected_chunks,
        "since_disk must equal the ground-truth changed-chunk set");
    assert_eq!(ws.dirty.header_disk, expected_header,
        "header_disk must equal the ground-truth header diff");
    // Band level (18.13): every band whose bytes actually changed must be in the mask, in every
    // set. (The mask may over-mark — a `Full` delta covers its lowest..highest band — but never
    // under-mark: that is data loss.)
    for set in [&ws.dirty.since_disk, &ws.dirty.since_journal, &ws.dirty.since_base, &ws.dirty.since_load] {
        assert_bands_cover_diff(world, &original, set);
    }

    // since_journal and since_base track the same events in Stage 1 (nothing yet clears them
    // independently), so they must agree with since_disk too.
    let journal_chunks: std::collections::HashSet<(i32, i32)> =
        ws.dirty.since_journal.keys().copied().collect();
    let base_chunks: std::collections::HashSet<(i32, i32)> =
        ws.dirty.since_base.keys().copied().collect();
    assert_eq!(journal_chunks, expected_chunks);
    assert_eq!(base_chunks, expected_chunks);
    let load_chunks: std::collections::HashSet<(i32, i32)> =
        ws.dirty.since_load.keys().copied().collect();
    assert_eq!(load_chunks, expected_chunks);
    assert_eq!(ws.dirty.header_journal, expected_header);
    assert_eq!(ws.dirty.header_base, expected_header);
    assert_eq!(ws.dirty.header_load, expected_header);
}

/// A `WorldState` wired up like a freshly-`load_world`'d one, with a real on-disk staged temp
/// (not just an anonymous mapping) — `autosave_world_inner` needs `temp_path` to point at an
/// actual file so it can `stage_copy` the autosave base from it.
pub(crate) fn ws_with_temp_path(bytes: Vec<u8>, temp_path: &std::path::Path) -> WorldState {
    fs::write(temp_path, &bytes).expect("stage temp file for test");
    let mut ws = ws_with(bytes);
    ws.temp_path = Some(temp_path.to_path_buf());
    ws
}

/// Like `ws_with_temp_path`, but wired up the way `load_world` actually does it: the temp is
/// mapped **MAP_SHARED** via `map_staged_temp`, so edits land in the temp file on disk.
///
/// `ws_with_temp_path` writes the temp with `fs::write` and builds the world from `map_anon`,
/// which decouples the two by construction — it structurally cannot observe the "the autosave
/// base is cloned from a temp that edits are actively mutating" hazard. Only this helper can.
pub(crate) fn ws_with_shared_temp(bytes: Vec<u8>, temp_path: &std::path::Path) -> WorldState {
    fs::write(temp_path, &bytes).expect("stage temp file for test");
    let mmap = map_staged_temp(temp_path).expect("map staged temp");
    let mut ws = WorldState::new();
    ws.world = Some(parse_world_inner(mmap).expect("parse"));
    ws.temp_path = Some(temp_path.to_path_buf());
    ws
}

/// §3 ground truth — with the world mapped MAP_SHARED over the staged temp, the autosave base is
/// a clone of a file that edits are actively mutating, so it can be captured torn. What keeps
/// recovery correct is `autosave_world_inner`'s step-0 ordering: the clone happens *before* the
/// tick's spans are captured, and `since_load` is monotone, so every chunk where the temp has
/// diverged from the as-loaded image is guaranteed to be in `since_load` (hence in a Clone
/// lineage's journal, hence fully overwritten on replay). These fixtures have no `DiskImage`,
/// so every tick here takes the Clone lineage.
///
/// Asserts both halves: the containment property directly, and that recovery is still
/// byte-identical. Reversing step 0 back below the read guard leaves this test's containment
/// assertion passing but is exactly the ordering the assertion exists to pin.
/// 18.11 — a full save of a MAP_SHARED world is produced by msync + clone/copy of the staged temp
/// and must be byte-identical to the old write-through-the-mapping path, including after edits,
/// over a pre-existing destination (`.bak` made, no `.savetmp` left behind).
#[test]
pub(crate) fn test_full_save_from_shared_temp_matches_mapping_write() {
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dir = std::env::temp_dir().join(format!("vuencedit_save_from_temp_{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create test dir");
    let staged = dir.join("staged.eden");
    fs::write(&staged, &original).expect("stage temp");
    let (mmap, shared) = map_staged_temp_ex(&staged).expect("map staged temp");
    let mut ws = WorldState::new();
    ws.world = Some(parse_world_inner(mmap).expect("parse"));
    ws.temp_path = Some(staged.clone());
    ws.temp_shared = shared;

    for round in 0..2 {
        if round == 1 {
            // Edits (incl. a header write) land in the shared mapping only.
            with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
                delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
                Ok(())
            }).expect("edit");
            write_spawn(ws.world.as_mut().unwrap(), 5.0, 5.0);
        }
        let world = ws.world.as_ref().unwrap();
        let old_path = dir.join(format!("old_{round}.eden"));
        let new_path = dir.join(format!("new_{round}.eden"));
        // Pre-existing destination: exercises backup + replace.
        fs::write(&new_path, b"previous contents").unwrap();
        save_world_progress(world, old_path.to_str().unwrap(), false, None, None).expect("old-path save");
        let temp = if ws.temp_shared { ws.temp_path.as_deref() } else { None };
        save_world_progress(world, new_path.to_str().unwrap(), false, None, temp).expect("temp-path save");
        let old_bytes = fs::read(&old_path).unwrap();
        let new_bytes = fs::read(&new_path).unwrap();
        assert_eq!(&old_bytes[..], &world.bytes[..], "old path must equal the mapping");
        assert!(old_bytes == new_bytes, "clone/copy save differs from write-through-mapping (round {round})");
        assert!(dir.join(format!("new_{round}.eden.bak")).exists(), "backup of the previous file");
        assert!(!dir.join(format!("new_{round}.eden.savetmp")).exists(), "no stray .savetmp");
    }
    // Editing after a save must not disturb the already-saved (possibly cloned) destination.
    let saved_before = fs::read(dir.join("new_1.eden")).unwrap();
    with_edit(&mut ws, "delete", (16, 0, 20, 5), |world| {
        delete_blocks_inner(world, 16, 0, 20, 5, 0, 63, None);
        Ok(())
    }).expect("edit after save");
    assert!(saved_before == fs::read(dir.join("new_1.eden")).unwrap(), "saved file changed by a later edit");
    // A length mismatch (stale temp) must fall back to the mapping write rather than corrupt.
    let stale = dir.join("stale.eden");
    fs::write(&stale, b"short").unwrap();
    let fb = dir.join("fallback.eden");
    let world = ws.world.as_ref().unwrap();
    save_world_progress(world, fb.to_str().unwrap(), false, None, Some(&stale)).expect("fallback save");
    assert!(fs::read(&fb).unwrap() == world.bytes[..], "fallback must write the mapping");
    drop(ws);
    let _ = fs::remove_dir_all(&dir);
}

/// Every band of `world` that differs from `original` is in `set`'s mask for that chunk, and no
/// chunk is marked that didn't change (masks may over-mark bands, never chunks).
pub(crate) fn assert_bands_cover_diff(world: &LoadedWorld, original: &[u8], set: &DirtyMap) {
    for &(cx, cy) in world.chunk_map.keys() {
        let (addr, end) = world.chunk_range(cx, cy).unwrap();
        let mask = set.get(&(cx, cy)).copied().unwrap_or_default();
        let changed = world.bytes[addr..end] != original[addr..end];
        assert_eq!(mask != BandMask::default(), changed, "chunk ({cx},{cy}) marked iff it changed");
        for b in 0..(end - addr).div_ceil(BAND_SPAN) {
            let (lo, hi) = (addr + b * BAND_SPAN, (addr + (b + 1) * BAND_SPAN).min(end));
            if world.bytes[lo..hi] != original[lo..hi] {
                assert!(mask.contains(b), "chunk ({cx},{cy}) band {b} changed but is not in its mask");
            }
        }
    }
}

/// Replay a journal file and return its `(file_off, cx, cy, payload_len)` records.
pub(crate) fn journal_records(path: &std::path::Path, base_len: u64) -> Vec<(u64, i32, i32, usize)> {
    let bytes = fs::read(path).expect("read journal");
    journal::replay(&bytes, base_len).expect("replay").spans.iter()
        .map(|s| (s.file_off, s.cx, s.cy, s.payload.len())).collect()
}

#[test]
pub(crate) fn test_band_mask_runs_and_range() {
    assert_eq!(BandMask::default().runs().count(), 0);
    let m = BandMask::band(2) | BandMask::band(3) | BandMask::band(5) | BandMask::band(15);
    assert_eq!(m.runs().collect::<Vec<_>>(), vec![(2, 3), (5, 5), (15, 15)]);
    assert_eq!(BandMask::ALL.runs().collect::<Vec<_>>(), vec![(0, 15)]);
    assert_eq!(BandMask::range(0, 15), BandMask::ALL);
    assert_eq!(BandMask::range(3, 5).runs().collect::<Vec<_>>(), vec![(3, 5)]);
    assert!(BandMask::range(3, 5).contains(4) && !BandMask::range(3, 5).contains(6));
}

#[test]
pub(crate) fn test_chunk_delta_band_mask() {
    let b = BAND_SPAN as u32;
    let sparse = ChunkDelta::Sparse(vec![(3, 1), (b * 2 + 7, 1), (b * 2 + 9, 1), (b * 5, 1)]);
    assert_eq!(sparse.band_mask().runs().collect::<Vec<_>>(), vec![(0, 0), (2, 2), (5, 5)]);
    // A dense delta covers every band its bytes touch, inclusive of the last byte's band.
    let full = ChunkDelta::Full(b * 3, vec![0; (b * 2) as usize]);
    assert_eq!(full.band_mask().runs().collect::<Vec<_>>(), vec![(3, 4)]);
    let full = ChunkDelta::Full(b * 3 + 5, vec![0; b as usize]);
    assert_eq!(full.band_mask().runs().collect::<Vec<_>>(), vec![(3, 4)]);
    assert_eq!(ChunkDelta::FullZ(b, vec![], b * 2).band_mask().runs().collect::<Vec<_>>(), vec![(1, 2)]);
}

/// `BandMask::ALL` on a 64z world (4 bands) must clamp to the chunk's real span — no spans past
/// `chunk_range`, and `dirty_bytes` counts 4 bands, not 16.
#[test]
pub(crate) fn test_dirty_spans_clamp_to_the_chunk_span() {
    let ws = ws_with(make_bumpy_world_grid(2, 8, |_, _| 20));
    let world = ws.world.as_ref().unwrap();
    let mut dirty = DirtyMap::default();
    dirty.insert((1, 0), BandMask::ALL);
    let (addr, end) = world.chunk_range(1, 0).unwrap();
    let spans = dirty_spans(world, &dirty);
    assert_eq!(spans.len(), 1);
    assert_eq!((spans[0].0 as usize, spans[0].3.len()), (addr, end - addr));
    assert_eq!(dirty_bytes(world, &dirty), (end - addr) as u64);
    // A run that starts past the end is skipped rather than slicing out of range.
    dirty.insert((1, 0), BandMask::band(9));
    assert!(dirty_spans(world, &dirty).is_empty());
}

/// One block in band 3 of a 256z chunk → one 8 KB journal record, and the incremental save and
/// the WAL carry that one band; the saved file still equals a full save.
#[test]
pub(crate) fn test_band_dirty_one_block_edit_256z() {
    let dir = stage4_dir("band_one_block");
    let original = cow_world(2, 16, |x, y| 30 + (x * 7 + y * 3) % 40);
    let dest = dir.join("world.eden");
    let mut ws = ws_with_disk_image(original.clone(), &dest);
    let staged = dir.join("staged.eden");
    fs::write(&staged, &original).unwrap();
    ws.temp_path = Some(staged);
    let state: AppState = RwLock::new(ws);
    let paths = autosave_paths_at(&dir);

    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "paint", (3, 3, 3, 3), |world| {
            set_block_abs(world, 3, 3, 50, 7, 3); // z=50 → band 3
            Ok(())
        }).expect("edit");
        let m = ws.dirty.since_disk[&(0, 0)];
        assert_eq!(m.runs().collect::<Vec<_>>(), vec![(3, 3)], "a one-block edit dirties exactly band 3");
        assert_eq!(ws.dirty.since_disk.len(), 1);
    }

    autosave_world_inner(&state, &paths, None, None).expect("autosave tick");
    let base_len = read_ws(&state).world.as_ref().unwrap().bytes.len() as u64;
    let recs = journal_records(&paths.journal, base_len);
    assert_eq!(recs.len(), 1, "one journal record");
    assert_eq!((recs[0].1, recs[0].2, recs[0].3), (0, 0, BAND_SPAN), "…covering one 8 KB band of chunk (0,0)");

    // The in-place save: same span, byte-identical result to a full save.
    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("incremental save"));
    let expected = world_bytes(&read_ws(&state));
    assert_eq!(fs::read(&dest).unwrap(), expected);
    let full = dir.join("full.eden");
    save_world_inner(read_ws(&state).world.as_ref().unwrap(), full.to_str().unwrap(), false).expect("full save");
    assert_eq!(fs::read(&dest).unwrap(), fs::read(&full).unwrap());

    let _ = fs::remove_dir_all(&dir);
}

/// An edit touching bands 2 and 5 only → two runs, two records, and nothing in between.
#[test]
pub(crate) fn test_band_dirty_two_separate_bands_make_two_records() {
    let dir = stage4_dir("band_two_runs");
    let original = cow_world(2, 16, |x, y| 30 + (x * 7 + y * 3) % 40);
    let staged = dir.join("staged.eden");
    let paths = autosave_paths_at(&dir);
    let state: AppState = RwLock::new(ws_with_temp_path(original.clone(), &staged));

    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "paint", (3, 3, 4, 3), |world| {
            set_block_abs(world, 3, 3, 40, 7, 3); // band 2
            set_block_abs(world, 4, 3, 85, 7, 3); // band 5
            Ok(())
        }).expect("edit");
        let m = ws.dirty.since_journal[&(0, 0)];
        assert_eq!(m.runs().collect::<Vec<_>>(), vec![(2, 2), (5, 5)]);
    }
    autosave_world_inner(&state, &paths, None, None).expect("autosave tick");
    let base_len = read_ws(&state).world.as_ref().unwrap().bytes.len() as u64;
    let recs = journal_records(&paths.journal, base_len);
    assert_eq!(recs.len(), 2);
    let (addr, _) = read_ws(&state).world.as_ref().unwrap().chunk_range(0, 0).unwrap();
    assert_eq!(recs[0], ((addr + 2 * BAND_SPAN) as u64, 0, 0, BAND_SPAN));
    assert_eq!(recs[1], ((addr + 5 * BAND_SPAN) as u64, 0, 0, BAND_SPAN));

    // Recovery from those two records reproduces the world.
    let expected = world_bytes(&read_ws(&state));
    let fresh: AppState = RwLock::new(WorldState::new());
    load_autosave_inner(&fresh, &paths).expect("recover");
    assert!(world_bytes(&read_ws(&fresh)) == expected);
    if let Some(t) = read_ws(&fresh).temp_path.clone() { let _ = fs::remove_file(t); }
    let _ = fs::remove_dir_all(&dir);
}

/// Undo marks the *inverse's* bands: edit band 3, save, undo → the next incremental save owes
/// band 3 of that chunk and nothing else.
#[test]
pub(crate) fn test_band_dirty_undo_marks_the_inverse_bands() {
    let dir = stage4_dir("band_undo");
    let original = cow_world(2, 16, |x, y| 30 + (x * 7 + y * 3) % 40);
    let dest = dir.join("world.eden");
    let state: AppState = RwLock::new(ws_with_disk_image(original.clone(), &dest));
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "paint", (3, 3, 3, 3), |world| {
            set_block_abs(world, 3, 3, 50, 7, 3);
            Ok(())
        }).expect("edit");
    }
    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("save"));
    assert!(read_ws(&state).dirty.since_disk.is_empty());

    undo_edit_inner(&mut write_ws(&state)).expect("undo");
    {
        let ws = read_ws(&state);
        assert_eq!(ws.dirty.since_disk.len(), 1);
        assert_eq!(ws.dirty.since_disk[&(0, 0)].runs().collect::<Vec<_>>(), vec![(3, 3)],
            "undo re-dirties exactly the band it rewrote");
    }
    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("save after undo"));
    assert!(fs::read(&dest).unwrap() == original, "the reverted bytes reach the file");
    // And redo marks it again.
    redo_edit_inner(&mut write_ws(&state)).expect("redo");
    assert_eq!(read_ws(&state).dirty.since_disk[&(0, 0)].runs().collect::<Vec<_>>(), vec![(3, 3)]);

    let _ = fs::remove_dir_all(&dir);
}

/// 23.10: the exit hook releases the world and deletes the staged temp, but never waits on a
/// held guard — a busy world is left alone for the next launch's sweep.
#[test]
pub(crate) fn test_exit_cleanup_removes_temp_unless_busy() {
    let dir = std::env::temp_dir().join(format!("vuencedit_exit_cleanup_test_{}", std::process::id()));
    fs::create_dir_all(&dir).expect("create test dir");
    let staged = dir.join("staged.eden");
    let state: AppState = RwLock::new(ws_with_shared_temp(make_bumpy_world_grid(2, 2, |_, _| 20), &staged));
    {
        let _busy = read_ws(&state);
        exit_cleanup(&state, None);
    }
    assert!(staged.exists(), "a held guard must skip the cleanup, not wait for it");
    assert!(read_ws(&state).world.is_some());
    exit_cleanup(&state, None);
    assert!(!staged.exists(), "the staged temp is deleted on exit");
    let ws = read_ws(&state);
    assert!(ws.world.is_none() && ws.temp_path.is_none());
    drop(ws);
    let _ = fs::remove_dir_all(&dir);
}

/// 23.9: a compressed save deflates from a snapshot taken under the guard, so edits landing
/// during the (unguarded) deflate don't reach the file, and the snapshot is removed afterwards.
#[test]
pub(crate) fn test_compressed_save_deflates_a_snapshot_off_the_guard() {
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dir = std::env::temp_dir().join(format!("vuencedit_save_snapshot_test_{}", std::process::id()));
    fs::create_dir_all(&dir).expect("create test dir");
    let staged = dir.join("staged.eden");
    let dest = dir.join("out.eden.zip");
    let state: AppState = RwLock::new(ws_with_shared_temp(original, &staged));
    if staged_map_mode(&staged) != MapMode::Shared { let _ = fs::remove_dir_all(&dir); return; }
    let delete = |state: &AppState, x0: i32| {
        with_edit(&mut write_ws(state), "delete", (x0, 0, x0 + 4, 4), |world| {
            delete_blocks_inner(world, x0, 0, x0 + 4, 4, 0, 63, None);
            Ok(())
        }).expect("edit");
    };
    delete(&state, 0);
    let (expected, snap) = {
        let ws = read_ws(&state);
        let world = ws.world.as_ref().unwrap();
        (world_bytes(&ws).to_vec(), snapshot_shared_temp(world, &staged).expect("snapshot"))
    };
    let snap_path = snap.0.clone();
    assert!(snap_path.starts_with(&dir), "the snapshot must sit beside the temp (same volume)");
    delete(&state, 16); // lands mid-save: must not reach the file
    let mut f = fs::File::open(&snap.0).unwrap();
    let len = f.metadata().unwrap().len();
    write_zip_atomic(&mut f, len, dest.to_str().unwrap(), None).expect("deflate");
    drop(f);
    drop(snap);
    assert!(!snap_path.exists(), "the snapshot must delete itself");
    let mut zip = zip::ZipArchive::new(fs::File::open(&dest).unwrap()).expect("open zip");
    let mut got = Vec::new();
    std::io::Read::read_to_end(&mut zip.by_index(0).unwrap(), &mut got).unwrap();
    assert!(got == expected, "the zip must hold the world as of the snapshot");
    assert!(got != world_bytes(&read_ws(&state)), "the later edit must not be in the zip");
    drop(state);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
pub(crate) fn test_shared_temp_divergence_is_covered_by_since_base() {
    let original = make_bumpy_world_grid(2, 8, |_, _| 20); // 2×2 chunks
    let dir = std::env::temp_dir().join(format!("vuencedit_shared_temp_test_{}", std::process::id()));
    fs::create_dir_all(&dir).expect("create test sidecar dir");
    let staged = dir.join("staged.eden");
    let paths = autosave_paths_at(&dir);

    let ws = ws_with_shared_temp(original.clone(), &staged);
    let state: AppState = RwLock::new(ws);

    // Two edits in different chunks, one of them undone (so its final bytes match the original
    // again while the temp in between did not) — plus a header write.
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit 1");
        with_edit(&mut ws, "delete", (16, 0, 20, 5), |world| {
            delete_blocks_inner(world, 16, 0, 20, 5, 0, 63, None);
            Ok(())
        }).expect("edit 2");
        write_spawn(ws.world.as_mut().unwrap(), 5.0, 5.0);
        ws.dirty.mark_header();
    }
    undo_edit_inner(&mut write_ws(&state)).expect("undo edit 2");

    autosave_world_inner(&state, &paths, None, None).expect("autosave tick");
    assert!(paths.base.exists(), "tick must establish the base image");

    // The mapping really is shared: the edits must be visible in the temp file on disk. A
    // MAP_PRIVATE fallback (env override, or a full temp volume) leaves the temp equal to
    // `original` and there is nothing to check — but don't let that silently hollow the test
    // out, so decide from the mode this machine actually chose.
    let temp_on_disk = fs::read(&staged).expect("read staged temp");
    if staged_map_mode(&staged) == MapMode::Shared {
        assert_ne!(temp_on_disk, original,
            "MAP_SHARED must write edits through to the staged temp — if this fails, \
             map_staged_temp silently fell back to map_copy and §3 buys nothing");
    }
    if temp_on_disk != original {
        let ws = read_ws(&state);
        let world = ws.world.as_ref().unwrap();
        for &(cx, cy) in world.chunk_map.keys() {
            let (addr, end) = world.chunk_range(cx, cy).unwrap();
            if temp_on_disk[addr..end] != original[addr..end] {
                assert!(ws.dirty.since_load.contains_key(&(cx, cy)),
                    "chunk ({cx},{cy}) diverged in the shared temp but is missing from since_load — \
                     the autosave base can be torn there with nothing in the journal to repair it");
                // Band level (18.13): every diverged band, not just the chunk.
                let mask = ws.dirty.since_load[&(cx, cy)];
                for b in 0..(end - addr).div_ceil(BAND_SPAN) {
                    let (lo, hi) = (addr + b * BAND_SPAN, (addr + (b + 1) * BAND_SPAN).min(end));
                    if temp_on_disk[lo..hi] != original[lo..hi] {
                        assert!(mask.contains(b), "chunk ({cx},{cy}) band {b} diverged in the shared temp \
                            but is missing from since_load");
                    }
                }
            }
        }
        if temp_on_disk[0..192] != original[0..192] {
            assert!(ws.dirty.header_load, "header diverged in the shared temp but header_load is false");
        }
    }

    let expected = world_bytes(&read_ws(&state));
    let fresh: AppState = RwLock::new(WorldState::new());
    load_autosave_inner(&fresh, &paths).expect("load_autosave_inner");
    assert_eq!(world_bytes(&read_ws(&fresh)), expected,
        "recovery from a base cloned out from under live edits must still be byte-identical");

    let recovered_temp = read_ws(&fresh).temp_path.clone().expect("recovery must stage a temp file");
    let _ = fs::remove_file(&recovered_temp);
    let _ = fs::remove_dir_all(&dir);
}

/// Audit C2 Stage 3 — a scripted mix of a chunk edit, a header edit, and an edit-then-undo,
/// autosaved across two ticks (exercising both the first-tick "establish base" path and a
/// plain incremental append), must recover byte-identical via `load_autosave_inner` — including
/// the header change and the fact that the undone edit's chunk ends up back at its original
/// bytes. This is the ground-truth check for the whole base+journal round trip, mirroring
/// `test_dirty_set_matches_ground_truth`'s style for Stage 1.
#[test]
pub(crate) fn test_journaled_autosave_round_trip_with_recovery() {
    let original = make_bumpy_world_grid(2, 8, |_, _| 20); // 2×2 chunks: (0,0) (1,0) (0,1) (1,1)
    let dir = std::env::temp_dir().join(format!("vuencedit_autosave_test_{}", std::process::id()));
    fs::create_dir_all(&dir).expect("create test sidecar dir");
    let staged = dir.join("staged.eden");
    let paths = autosave_paths_at(&dir);

    let ws = ws_with_temp_path(original, &staged);
    let state: AppState = RwLock::new(ws);

    // Tick 1: a single chunk edit, then autosave — establishes the base image + journal.
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit 1");
    }
    autosave_world_inner(&state, &paths, None, None).expect("autosave tick 1");
    assert!(paths.base.exists(), "first tick must establish the base image");
    assert!(paths.journal.exists(), "first tick must create the journal");

    // Header change (mirrors set_spawn_pos: write header bytes directly, then mark dirty).
    {
        let mut ws = write_ws(&state);
        write_spawn(ws.world.as_mut().unwrap(), 5.0, 5.0);
        ws.dirty.mark_header();
    }
    // Edit-then-undo in a different chunk — still dirty (Stage 1's tracking is conservative),
    // but its final bytes are back to the pristine original for that chunk.
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (16, 0, 20, 5), |world| {
            delete_blocks_inner(world, 16, 0, 20, 5, 0, 63, None);
            Ok(())
        }).expect("edit 2");
    }
    undo_edit_inner(&mut write_ws(&state)).expect("undo edit 2");

    // Tick 2: incremental append (base already established this session).
    autosave_world_inner(&state, &paths, Some("source.eden".into()), None).expect("autosave tick 2");
    assert!(read_ws(&state).dirty.since_journal.is_empty(), "tick 2 must flush everything pending");
    assert!(!read_ws(&state).dirty.header_journal, "tick 2 must flush the header too");

    let expected = world_bytes(&read_ws(&state));

    // Recover into a brand-new, otherwise-empty WorldState/AppState.
    let fresh: AppState = RwLock::new(WorldState::new());
    let meta = load_autosave_inner(&fresh, &paths).expect("load_autosave_inner");
    assert_eq!(meta.name, "GridTest");
    let recovered = world_bytes(&read_ws(&fresh));
    assert_eq!(recovered, expected, "recovered world must be byte-identical to the last-autosaved state");

    let recovered_temp = read_ws(&fresh).temp_path.clone().expect("recovery must stage a temp file");
    let _ = fs::remove_file(&recovered_temp);
    let _ = fs::remove_dir_all(&dir);
}

/// Audit C2 Stage 3 — when a single tick's pending chunks are large relative to the world (here
/// forced by editing 2 of the world's 4 chunks in one tick against a tiny fixture), autosave
/// must take the compaction path (`write_fresh_journal` from `since_base`) instead of appending,
/// and the resulting journal must still recover byte-identical. A compacted journal also must
/// not carry forward stale records: replaying it directly should yield exactly one span per
/// distinct dirty chunk, not one per edit.
#[test]
pub(crate) fn test_autosave_compaction_recovers_and_dedupes_spans() {
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dir = std::env::temp_dir().join(format!("vuencedit_autosave_compact_test_{}", std::process::id()));
    fs::create_dir_all(&dir).expect("create test sidecar dir");
    let staged = dir.join("staged.eden");
    let paths = autosave_paths_at(&dir);

    let ws = ws_with_temp_path(original, &staged);
    let state: AppState = RwLock::new(ws);

    // Tick 1: touch chunk (0,0) only, establish base + journal.
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit 1");
    }
    autosave_world_inner(&state, &paths, None, None).expect("autosave tick 1");
    let base_len = fs::metadata(&paths.base).unwrap().len();

    // Before tick 2: re-touch chunk (0,0) and touch chunks (1,0) and (0,1). The terrain tops out
    // at z=20, so each chunk dirties bands 0..=1 (16 KB): 3 chunks × 16 KB exceeds base_len/4
    // for this small fixture, forcing the compact branch (band-granular since 18.13 — two
    // chunks' worth no longer does).
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 8, 8), |world| {
            delete_blocks_inner(world, 0, 0, 8, 8, 0, 63, None);
            Ok(())
        }).expect("edit 2");
        with_edit(&mut ws, "delete", (16, 0, 20, 5), |world| {
            delete_blocks_inner(world, 16, 0, 20, 5, 0, 63, None);
            Ok(())
        }).expect("edit 3");
        with_edit(&mut ws, "delete", (0, 16, 5, 20), |world| {
            delete_blocks_inner(world, 0, 16, 5, 20, 0, 63, None);
            Ok(())
        }).expect("edit 4");
    }
    autosave_world_inner(&state, &paths, None, None).expect("autosave tick 2 (compaction)");

    let journal_bytes = fs::read(&paths.journal).expect("read compacted journal");
    let replay = journal::replay(&journal_bytes, base_len).expect("replay compacted journal");
    assert!(!replay.truncated);
    let distinct: std::collections::HashSet<(i32, i32)> =
        replay.spans.iter().map(|s| (s.cx, s.cy)).collect();
    assert_eq!(replay.spans.len(), distinct.len(),
        "a compacted journal must carry exactly one span per dirty chunk (here one band run each), not one per edit");
    assert_eq!(distinct, std::collections::HashSet::from([(0, 0), (1, 0), (0, 1)]));

    let expected = world_bytes(&read_ws(&state));
    let fresh: AppState = RwLock::new(WorldState::new());
    load_autosave_inner(&fresh, &paths).expect("load_autosave_inner after compaction");
    let recovered = world_bytes(&read_ws(&fresh));
    assert_eq!(recovered, expected, "post-compaction recovery must match the live world");

    let recovered_temp = read_ws(&fresh).temp_path.clone().expect("recovery must stage a temp file");
    let _ = fs::remove_file(&recovered_temp);
    let _ = fs::remove_dir_all(&dir);
}

/// Audit X-1 — after a manual save the frontend discards the autosave files; the lineage must be
/// forgotten with them, or the next tick appends to a deleted journal / journals against a
/// deleted base and recovery fails with "Failed to stat autosave base".
#[test]
pub(crate) fn test_autosave_survives_discard_after_save() {
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dir = std::env::temp_dir().join(format!("vuencedit_autosave_x1_test_{}", std::process::id()));
    fs::create_dir_all(&dir).expect("create test sidecar dir");
    let staged = dir.join("staged.eden");
    let paths = autosave_paths_at(&dir);
    let state: AppState = RwLock::new(ws_with_temp_path(original, &staged));

    let edit = |x0: i32, x1: i32| {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (x0, 0, x1, 5), |world| {
            delete_blocks_inner(world, x0, 0, x1, 5, 0, 63, None);
            Ok(())
        }).expect("edit");
    };

    edit(0, 5);
    autosave_world_inner(&state, &paths, None, None).expect("tick 1");

    // The manual-save aftermath: the discharge the save records, then the discard command.
    let seq = read_ws(&state).dirty.seq;
    let saved = dir.join("saved.eden");
    fs::write(&saved, world_bytes(&read_ws(&state))).expect("write saved file");
    record_full_write(&state, &saved, false, seq).expect("record_full_write");
    discard_autosave_inner(&state, &paths);
    assert!(!paths.base.exists() && !paths.journal.exists() && !paths.meta.exists());

    edit(16, 20);
    autosave_world_inner(&state, &paths, None, None).expect("tick after discard must succeed");
    assert!(paths.journal.exists(), "the tick must re-establish its lineage");
    // 18.9: the saved file is a known-good image of the world, so the new lineage builds on it
    // (Source) instead of re-copying the world into `autosave.base.eden`.
    assert!(!paths.base.exists(), "a Source lineage needs no base clone");
    assert!(matches!(read_ws(&state).autosave.as_ref().map(|l| &l.base), Some(AutosaveBase::Source(_))));

    let expected = world_bytes(&read_ws(&state));
    let fresh: AppState = RwLock::new(WorldState::new());
    load_autosave_inner(&fresh, &paths).expect("recovery after save + discard + edit must load");
    assert_eq!(world_bytes(&read_ws(&fresh)), expected);

    let recovered_temp = read_ws(&fresh).temp_path.clone().expect("recovery must stage a temp file");
    let _ = fs::remove_file(&recovered_temp);
    let _ = fs::remove_dir_all(&dir);
}

/// Audit P-1 — the wire format must not have moved when the span capture became a borrow.
/// Pins a whole tick's journal file against `journal.rs`'s encode primitives, byte for byte:
/// the header flags (compressed), `base_len`, `base_id`, the header span going first under its
/// `HEADER_SPAN` sentinel, and each chunk span's absolute offset. Deliberately one dirty chunk,
/// so there is no `FxHashSet` iteration order to depend on.
#[test]
pub(crate) fn test_autosave_journal_is_byte_identical_to_hand_encoded_records() {
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dir = std::env::temp_dir().join(format!("vuencedit_autosave_wire_test_{}", std::process::id()));
    fs::create_dir_all(&dir).expect("create test sidecar dir");
    let staged = dir.join("staged.eden");
    let paths = autosave_paths_at(&dir);
    let state: AppState = RwLock::new(ws_with_temp_path(original, &staged));

    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit");
        write_spawn(ws.world.as_mut().unwrap(), 5.0, 5.0);
        ws.dirty.mark_header();
    }
    autosave_world_inner(&state, &paths, None, None).expect("autosave tick");

    let expected = {
        let ws = read_ws(&state);
        let world = ws.world.as_ref().unwrap();
        let (addr, end) = world.chunk_range(0, 0).expect("chunk (0,0) must exist");
        let base_id = ws.autosave.as_ref().expect("the tick records its base lineage").base_id;
        // Every autosave journal carries FLAG_TAIL (27.0b: a later tick may append a tail).
        let mut buf = journal::JournalHeader::new(true, world.bytes.len() as u64, base_id)
            .with_tail().encode().to_vec();
        buf.extend(journal::encode_span_record(
            0, journal::HEADER_SPAN.0, journal::HEADER_SPAN.1, &world.bytes[0..192], true).unwrap());
        // Bands 0..=1 only (terrain tops out at z=20): one record per dirty band run, 18.13.
        let run_end = (addr + 2 * BAND_SPAN).min(end);
        buf.extend(journal::encode_span_record(
            addr as u64, 0, 0, &world.bytes[addr..run_end], true).unwrap());
        buf
    };

    let actual = fs::read(&paths.journal).expect("read journal");
    assert_eq!(actual, expected,
        "the journal wire format must be exactly what journal.rs's encoders produce — the P-1 \
         capture rewrite changed how the bytes are *reached*, never what is written");

    let _ = fs::remove_dir_all(&dir);
}

/// Audit P-1 — the regression test for the hole the `retain` discharge had: a chunk that was
/// both journalled this tick *and* re-dirtied before the discharge landed used to be retained
/// out of `since_journal` anyway, so its new bytes were never journalled again and a crash lost
/// them silently. `discharge_autosave_journal` must clear **nothing** when `dirty.seq` moved.
///
/// Mirrors `test_record_full_write_ignores_a_stale_capture` — the save path's twin of this rule.
#[test]
pub(crate) fn test_autosave_discharge_ignores_a_stale_capture() {
    let state: AppState = RwLock::new(ws_with(make_bumpy_world_grid(2, 8, |_, _| 20)));
    let base_id = random_base_id();
    let lineage = AutosaveLineage { base_id, base: AutosaveBase::Clone, journal_written: false };
    let gen = read_ws(&state).lineage_gen;

    // Stand in for a tick that captured the world at `stale`, having flushed chunk (0,0).
    {
        let mut ws = write_ws(&state);
        ws.dirty.mark_chunks([(0, 0)]);
        ws.dirty.mark_header();
    }
    let stale = read_ws(&state).dirty.seq;

    // An edit to the *same* chunk lands during the tick's I/O window. This is the case the old
    // retain got wrong.
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit landing 'during' the autosave");
        write_spawn(ws.world.as_mut().unwrap(), 5.0, 5.0);
        ws.dirty.mark_header();
    }

    discharge_autosave_journal(&state, gen, lineage, stale);

    let ws = read_ws(&state);
    assert!(ws.dirty.since_journal.contains_key(&(0, 0)),
        "a chunk re-dirtied after the capture must stay owed to the journal — clearing it would \
         drop that edit from crash recovery");
    assert!(ws.dirty.header_journal, "a header re-written after the capture is still owed too");
    assert_eq!(ws.autosave.as_ref().map(|l| l.base_id), Some(base_id),
        "the base lineage is recorded regardless: gating it would make the next tick re-clone a \
         multi-GB base image for nothing");
}

/// Audit P-1 — the positive half of the discharge rule, so nobody "fixes" the guard above into a
/// blanket no-op. Nothing touched the world between capture and discharge, so the journal holds
/// everything that was owed and both sets clear.
#[test]
pub(crate) fn test_autosave_discharge_clears_on_a_matching_capture() {
    let state: AppState = RwLock::new(ws_with(make_bumpy_world_grid(2, 8, |_, _| 20)));
    let base_id = random_base_id();
    let lineage = AutosaveLineage { base_id, base: AutosaveBase::Clone, journal_written: false };
    let gen = read_ws(&state).lineage_gen;
    {
        let mut ws = write_ws(&state);
        ws.dirty.mark_chunks([(0, 0), (1, 0)]);
        ws.dirty.mark_header();
    }
    let seq = read_ws(&state).dirty.seq;

    discharge_autosave_journal(&state, gen, lineage, seq);

    let ws = read_ws(&state);
    assert!(ws.dirty.since_journal.is_empty(), "a clean capture discharges every journalled chunk");
    assert!(!ws.dirty.header_journal);
    let recorded = ws.autosave.as_ref().expect("lineage recorded");
    assert_eq!(recorded.base_id, base_id);
    assert!(recorded.journal_written, "a discharged lineage has a journal on disk");
    // `since_disk`/`since_base`/`since_load` advance on their own cadence and must be untouched
    // by a journal flush — the whole reason `DirtyState` carries independent sets.
    assert_eq!(ws.dirty.since_disk.len(), 2, "a journal flush must not discharge the save path");
    assert_eq!(ws.dirty.since_base.len(), 2, "nor the base-image compaction accounting");
    assert_eq!(ws.dirty.since_load.len(), 2);
    assert!(ws.dirty.header_disk && ws.dirty.header_base && ws.dirty.header_load);
}

