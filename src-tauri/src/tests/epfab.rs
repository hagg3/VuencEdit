use super::*;

// ── ROADMAP-LINK 21.6: .epfab ORGN provenance + paste placements ───────────────────────

pub(crate) fn hex_bytes(h: &str) -> Vec<u8> {
    (0..h.len() / 2).map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap()).collect()
}

/// The golden fixture shared byte-for-byte with VuencLink's `prefab_interchange` tests: a 2×1×1
/// prefab (types [74,0], paints [5,0], z_anchor 40) + an `ORGN` section.
pub(crate) const GOLDEN_V1: &str = "455046414201020000000100000001000000280000004a0005004f52474e150000000a000100f9ffffff2800000002efcdab8967452301";
pub(crate) const GOLDEN_V2: &str = "455046414202020000000100000001000000280000004a00050001014f52474e150000000a000100f9ffffff2800000002efcdab8967452301";
pub(crate) const GOLDEN_ORGN: &str = "4f52474e150000000a000100f9ffffff2800000002efcdab8967452301";

pub(crate) fn golden_origin() -> PrefabOrigin {
    PrefabOrigin { ax: 65546, ay: -7, az: 40, source: 2, rtid: 0x0123_4567_89AB_CDEF }
}
pub(crate) fn golden_clip(mask: Option<Vec<u8>>, origin: Option<PrefabOrigin>) -> Clipboard {
    Clipboard {
        width: 2, height: 1, depth: 1, z_anchor: 40,
        block_types: vec![74, 0], paints: vec![5, 0], mask, origin,
    }
}

#[test]
pub(crate) fn test_epfab_orgn_golden_fixture() {
    for (hex, mask) in [(GOLDEN_V1, None), (GOLDEN_V2, Some(vec![0b01u8]))] {
        let bytes = hex_bytes(hex);
        let cb = golden_clip(mask.clone(), Some(golden_origin()));
        assert_eq!(serialize_prefab_raw(&cb), bytes, "serialize == golden bytes");
        let back = deserialize_prefab(&bytes).expect("golden parses");
        assert_eq!(back.origin, Some(golden_origin()));
        assert_eq!((back.width, back.height, back.depth, back.z_anchor), (2, 1, 1, 40));
        assert_eq!(back.block_types, cb.block_types);
        assert_eq!(back.paints, cb.paints);
        assert_eq!(back.mask, mask);
        // gzip wrapper round-trips too
        assert_eq!(deserialize_prefab(&serialize_prefab(&cb)).unwrap().origin, Some(golden_origin()));
        // old-reader shape: strip the section and the prefab is the same with no origin
        let stripped = &bytes[..bytes.len() - hex_bytes(GOLDEN_ORGN).len()];
        let old = deserialize_prefab(stripped).expect("stripped parses");
        assert_eq!(old.origin, None);
        assert_eq!(old.block_types, cb.block_types);
        assert_eq!(old.mask, mask);
        assert_eq!(serialize_prefab_raw(&golden_clip(mask, None)), stripped,
            "no origin → byte-identical to today's output");
    }
}

#[test]
pub(crate) fn test_epfab_sections_skip_unknown_and_tolerate_truncation() {
    let mut bytes = hex_bytes(GOLDEN_V1);
    let orgn = bytes.split_off(bytes.len() - hex_bytes(GOLDEN_ORGN).len());
    // unknown tag first, then ORGN → still found
    let mut b = bytes.clone();
    b.extend_from_slice(b"XXXX");
    b.extend_from_slice(&3u32.to_le_bytes());
    b.extend_from_slice(&[1, 2, 3]);
    b.extend_from_slice(&orgn);
    assert_eq!(deserialize_prefab(&b).unwrap().origin, Some(golden_origin()));
    // truncated section → valid prefab, no origin
    let mut t = bytes.clone();
    t.extend_from_slice(&orgn[..orgn.len() - 1]);
    assert_eq!(deserialize_prefab(&t).unwrap().origin, None);
    // ORGN longer than 21: extra bytes ignored
    let mut l = bytes.clone();
    l.extend_from_slice(b"ORGN");
    l.extend_from_slice(&23u32.to_le_bytes());
    l.extend_from_slice(&orgn[8..]);
    l.extend_from_slice(&[9, 9]);
    assert_eq!(deserialize_prefab(&l).unwrap().origin, Some(golden_origin()));
}

#[test]
pub(crate) fn test_clipboard_transforms_drop_origin() {
    let mut cb = golden_clip(None, Some(golden_origin()));
    rotate_clipboard_inner(&mut cb);
    assert_eq!(cb.origin, None);
    let mut cb = golden_clip(None, Some(golden_origin()));
    mirror_clipboard_x_inner(&mut cb);
    assert_eq!(cb.origin, None);
    let mut cb = golden_clip(None, Some(golden_origin()));
    mirror_clipboard_y_inner(&mut cb);
    assert_eq!(cb.origin, None);
}

/// A one-chunk 64z world whose chunk sits at (cx=5, cy=7), so `abs_min_* * 16` is non-zero.
pub(crate) fn offset_world_state() -> WorldState {
    let mut b = make_test_world();
    let pe = 4096 + 32768;
    b[pe..pe + 2].copy_from_slice(&5i16.to_le_bytes());
    b[pe + 4..pe + 6].copy_from_slice(&7i16.to_le_bytes());
    let ws = ws_with(b);
    let w = ws.world.as_ref().unwrap();
    assert_eq!((w.min_x, w.min_y), (5, 7));
    ws
}

pub(crate) fn rt_clip(rtid: u64, mask: Option<Vec<u8>>) -> Clipboard {
    Clipboard {
        width: 4, height: 4, depth: 3, z_anchor: 10,
        block_types: vec![13; 48], paints: vec![0; 48], mask,
        origin: Some(PrefabOrigin { ax: 1000, ay: 2000, az: 10, source: 2, rtid }),
    }
}

/// 23.8: a clipboard transform runs with no world guard held (edits/renders/saves proceed), and
/// leaves the clipboard exactly as the old under-the-guard path did.
#[test]
pub(crate) fn test_clipboard_transform_runs_off_the_world_guard() {
    let mut ws = offset_world_state();
    let clip = || {
        let mut cb = rt_clip(7, Some(vec![0b0000_0001, 0]));
        cb.width = 3; cb.height = 2; cb.depth = 2; // odd width, non-square: a rotate changes shape
        cb.block_types = (0..12).map(|i| 24 + i as u8).collect();
        cb.paints = (0..12).collect();
        cb
    };
    let mut expect = clip();
    rotate_clipboard_inner(&mut expect);
    ws.clipboard = Some(clip());
    let state = RwLock::new(ws);
    let info = transform_clipboard(&state, |cb| {
        assert!(state.try_write().is_ok(), "the world guard must be free during the transform");
        rotate_clipboard_inner(cb);
    }).expect("rotate");
    assert_eq!((info.width, info.height), (2, 3));
    let ws = read_ws(&state);
    let got = ws.clipboard.as_ref().expect("clipboard restored");
    assert_eq!((got.width, got.height, got.depth), (expect.width, expect.height, expect.depth));
    assert_eq!(got.block_types, expect.block_types);
    assert_eq!(got.paints, expect.paints);
    assert_eq!(got.mask, expect.mask);
    assert!(got.origin.is_none());
    drop(ws);
    write_ws(&state).clipboard = None;
    assert_eq!(transform_clipboard(&state, mirror_clipboard_x_inner).err().as_deref(), Some("Clipboard is empty"));
}

/// 22.9: cells that fall off the world (negative origin, past max_z) are counted into one toast
/// warning; a fully-inside paste stays silent.
#[test]
pub(crate) fn test_paste_warns_when_clipped() {
    let mut ws = offset_world_state();
    ws.clipboard = Some(rt_clip(99, None));
    let ok = paste_at_inner(&mut ws, 2, 3, 0, false).expect("paste");
    assert!(ok.warnings.is_empty(), "an in-bounds paste must not warn: {:?}", ok.warnings);
    // 2 columns off the west edge → 2 cols × 4 rows × 3 layers = 24 dropped cells.
    let r = paste_at_inner(&mut ws, -2, 3, 0, false).expect("paste");
    assert!(r.warnings.iter().any(|w| w.starts_with("24 blocks")), "{:?}", r.warnings);
    // Entirely above the world: every cell is dropped.
    let r = paste_at_inner(&mut ws, 2, 3, 100_000, false).expect("paste");
    assert!(r.warnings.iter().any(|w| w.starts_with("48 blocks")), "{:?}", r.warnings);
}

#[test]
pub(crate) fn test_placement_copy_origin_offsets_exactly() {
    let mut ws = offset_world_state();
    ws.clipboard = Some(rt_clip(99, None));
    paste_at_inner(&mut ws, 2, 3, 0, false).expect("paste");
    assert_eq!(ws.paste_placements, vec![Placement {
        x: 2, y: 3, z: 10, w: 4, h: 4, d: 3, ax: 1000, ay: 2000, az: 10, rtid: 99,
    }]);
    // edit inside the pasted area, then copy a sub-box of it
    with_edit(&mut ws, "tweak", (3, 4, 3, 4), |w| { set_block_abs(w, 3, 4, 11, 2, 0); Ok(()) }).unwrap();
    // with_edit is not undo/redo, so the placement survives
    assert_eq!(ws.paste_placements.len(), 1);
    let state = RwLock::new(ws);
    let info = copy_selection_inner(&state, 3, 4, 4, 5, 11, 12).expect("copy");
    assert_eq!(info.origin, Some(PrefabOrigin { ax: 1001, ay: 2001, az: 11, source: 1, rtid: 99 }));
    // …and it round-trips through the file codec
    let cb = state.read().unwrap().clipboard.as_ref().map(serialize_prefab).unwrap();
    assert_eq!(deserialize_prefab(&cb).unwrap().origin, info.origin);

    // straddling the placement edge → ambiguous → None
    let info = copy_selection_inner(&state, 1, 3, 3, 4, 10, 10).expect("copy");
    assert_eq!(info.origin, None);
    // exceeding the placement in z → None
    let info = copy_selection_inner(&state, 3, 4, 4, 5, 11, 13).expect("copy");
    assert_eq!(info.origin, None);
    // outside every placement → this world's absolute coordinates, source 0
    let info = copy_selection_inner(&state, 10, 11, 12, 12, 0, 1).expect("copy");
    assert_eq!(info.origin, Some(PrefabOrigin { ax: 5 * 16 + 10, ay: 7 * 16 + 11, az: 0, source: 0, rtid: 0 }));
}

#[test]
pub(crate) fn test_placement_not_recorded_unless_cell_for_cell() {
    // ignore-air on
    let mut ws = offset_world_state();
    ws.clipboard = Some(rt_clip(7, None));
    paste_at_inner(&mut ws, 2, 3, 0, true).unwrap();
    assert!(ws.paste_placements.is_empty(), "ignore-air paste must not record");
    // masked
    ws.clipboard = Some(rt_clip(7, Some(vec![0xff, 0xff])));
    paste_at_inner(&mut ws, 2, 3, 0, false).unwrap();
    assert!(ws.paste_placements.is_empty(), "masked paste must not record");
    // no rtid
    ws.clipboard = Some(rt_clip(0, None));
    paste_at_inner(&mut ws, 2, 3, 0, false).unwrap();
    assert!(ws.paste_placements.is_empty(), "rtid 0 must not record");
    // no origin at all
    let mut cb = rt_clip(7, None);
    cb.origin = None;
    ws.clipboard = Some(cb);
    paste_at_inner(&mut ws, 2, 3, 0, false).unwrap();
    assert!(ws.paste_placements.is_empty());
    // clipped by the world edge (paste at x=14, 4 wide, world is 16 wide)
    ws.clipboard = Some(rt_clip(7, None));
    paste_at_inner(&mut ws, 14, 3, 0, false).unwrap();
    assert!(ws.paste_placements.is_empty(), "a clipped paste must not record");
    // a good one records, and the cap holds at MAX_PLACEMENTS newest-last
    for i in 0..(MAX_PLACEMENTS as i32 + 3) {
        let mut cb = rt_clip(100 + i as u64, None);
        cb.width = 1; cb.height = 1; cb.depth = 1;
        cb.block_types.truncate(1); cb.paints.truncate(1);
        ws.clipboard = Some(cb);
        paste_at_inner(&mut ws, i, 0, 0, false).unwrap();
    }
    assert_eq!(ws.paste_placements.len(), MAX_PLACEMENTS);
    assert_eq!(ws.paste_placements.last().unwrap().rtid, 100 + MAX_PLACEMENTS as u64 + 2);
}

#[test]
pub(crate) fn test_undo_and_redo_clear_placements() {
    let mut ws = offset_world_state();
    ws.clipboard = Some(rt_clip(5, None));
    paste_at_inner(&mut ws, 2, 3, 0, false).unwrap();
    assert_eq!(ws.paste_placements.len(), 1);
    undo_edit_inner(&mut ws).expect("undo");
    assert!(ws.paste_placements.is_empty(), "undo clears placements");
    // redo clears whatever was recorded since too
    ws.paste_placements.push(Placement { x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, ax: 0, ay: 0, az: 0, rtid: 1 });
    redo_edit_inner(&mut ws).expect("redo");
    assert!(ws.paste_placements.is_empty(), "redo clears placements");
}

#[test]
pub(crate) fn test_derive_copy_origin_newer_overlap_beats_older_cover() {
    let older = Placement { x: 0, y: 0, z: 0, w: 10, h: 10, d: 10, ax: 100, ay: 200, az: 5, rtid: 1 };
    let newer = Placement { x: 4, y: 4, z: 0, w: 3, h: 3, d: 10, ax: 900, ay: 900, az: 5, rtid: 2 };
    // box inside older, overlapping newer's edge → ambiguous
    assert_eq!(derive_copy_origin(&[older, newer], 0, 0, 2, 2, 4, 4, 0, 1), None);
    // box inside older, clear of newer → older's origin
    let o = derive_copy_origin(&[older, newer], 0, 0, 0, 0, 1, 1, 2, 3).unwrap();
    assert_eq!((o.ax, o.ay, o.az, o.source, o.rtid), (100, 200, 7, 1, 1));
}


// ── 27.0b: the trailer in the world, the file-image seam, sidecars ─────────────────────────

/// A 2×2-chunk 64z world with the quarry sign trailer after its directory.
pub(crate) fn trailer_world() -> Vec<u8> {
    let mut b = make_bumpy_world_grid(2, 8, |_, _| 20);
    b.extend_from_slice(&QUARRY_SIGN_TRAILER);
    b
}

/// Touch the open world's trailer the way a record edit will (27.8a): a model edit plus
/// `mark_trailer`. Returns the tail every writer must now produce.
pub(crate) fn touch_trailer(ws: &mut WorldState) -> Vec<u8> {
    let w = ws.world.as_mut().unwrap();
    let p = trailer::Pos::new(w.min_x * 16 + 3, w.min_y * 16 + 4, 21);
    w.trailer.add_cmd(p, b"say hi").expect("add a command block");
    ws.dirty.mark_trailer();
    let tail = w.trailer_bytes();
    assert_ne!(tail, QUARRY_SIGN_TRAILER.to_vec());
    assert_eq!(&tail[4..8], b"CMB1", "a new CMB1 goes before SGN1");
    tail
}

/// The file a world saves as: head + tail.
pub(crate) fn image_bytes(w: &LoadedWorld) -> Vec<u8> {
    let i = w.file_image();
    [i.head, &i.tail].concat()
}

pub(crate) fn reload(path: &std::path::Path) -> LoadedWorld {
    parse_world_inner(mmap_from_bytes(fs::read(path).expect("read output"))).expect("output must parse")
}

/// The load capture keeps a ragged last row (< 16 bytes) instead of dropping it: the trailer is
/// everything from the end of the real rows to EOF, and a save writes the file back verbatim.
#[test]
pub(crate) fn test_trailer_capture_keeps_a_ragged_last_row() {
    let mut b = trailer_world();
    b.extend_from_slice(&[1, 2, 3, 4, 5]);
    let world = parse_world_inner(mmap_from_bytes(b.clone())).expect("parse");
    assert_eq!(world.chunk_map.len(), 4);
    assert_eq!(world.trailer_start as usize, b.len() - 192 - 5);
    assert_eq!(world.trailer_bytes(), b[b.len() - 197..].to_vec(), "the ragged row is part of the trailer");
    assert!(!world.trailer.parsed(), "a partial row makes it opaque (kept verbatim)");
    let dir = stage4_dir("ragged");
    let out = dir.join("out.eden");
    save_world_inner(&world, out.to_str().unwrap(), false).expect("save");
    assert_eq!(fs::read(&out).unwrap(), b, "saved verbatim, ragged row included");

    // No tagged rows at all, just a few stray bytes after the directory: still kept.
    let mut b = make_bumpy_world_grid(2, 8, |_, _| 20);
    b.extend_from_slice(&[9; 7]);
    let world = parse_world_inner(mmap_from_bytes(b.clone())).expect("parse");
    assert_eq!(world.chunk_map.len(), 4);
    assert_eq!(world.trailer_bytes(), vec![9; 7]);
    let _ = fs::remove_dir_all(&dir);
}

/// The untouched trailer is the file's own bytes; the quarry trailer parses to its one sign.
#[test]
pub(crate) fn test_untouched_trailer_is_the_files_own_bytes() {
    let world = parse_world_inner(mmap_from_bytes(trailer_world())).expect("parse");
    assert!(world.trailer.parsed() && !world.tail_rewritten());
    assert_eq!(world.trailer.signs().len(), 1);
    assert!(matches!(world.file_image().tail, Cow::Borrowed(_)), "borrowed from the mapping while untouched");
    assert_eq!(image_bytes(&world), trailer_world());
    let r = records_info(&world, None);
    assert_eq!((r.status, r.signs.len(), r.cmds.len(), r.bytes), ("parsed", 1, 0, 192));
    let (x, y, z) = world.record_to_local(world.trailer.signs()[0].pos);
    assert_eq!((r.signs[0].x, r.signs[0].y, r.signs[0].z, r.signs[0].text.as_str()), (x, y, z, "test"));
}

/// 27.6a: `record_overlay` lists drawable signs nearest-first, counts hidden ones, applies
/// radius and caps, and an opaque trailer yields the empty result.
#[test]
pub(crate) fn test_record_overlay_order_hiding_and_caps() {
    // The grid world is solid up to z = 20 (stone-ish, opaque); the quarry sign's anchor is air.
    let mut world = parse_world_inner(mmap_from_bytes(trailer_world())).expect("parse");
    let (mx, my) = (world.min_x * 16, world.min_y * 16);
    let abs = |x: i32, y: i32, z: i32| trailer::Pos::new(mx + x, my + y, z);
    // Standing signs on the surface (z = 20, open sky above), at growing distance on x.
    for x in [10, 2, 6] {
        world.trailer.add_sign(abs(x, 5, 20), 3, 2, 0, format!("s{x}").as_bytes()).unwrap();
    }
    // Buried wall sign (front cell is solid), and one anchored in air.
    world.trailer.add_sign(abs(4, 4, 10), 5, 2, 0, b"buried").unwrap();
    world.trailer.add_sign(abs(4, 4, 30), 3, 2, 0, b"air").unwrap();
    // A command block on the surface.
    world.trailer.add_cmd(abs(3, 3, 20), b"say hi").unwrap();

    let o = record_overlay(&world, 0.0, 5.0, 21.0, 32, 64);
    let texts: Vec<&str> = o.signs.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(texts, ["s2", "s6", "s10"], "nearest first, hidden dropped (the quarry sign is in air)");
    assert!(o.signs.iter().all(|s| s.kind == voxel_core::signs::SignKind::Standing && !s.boxes.is_empty()));
    assert!(o.hidden_air == 1 && o.hidden_front == 1, "{} {}", o.hidden_air, o.hidden_front);
    assert_eq!(o.cmds.len(), 1);
    assert_eq!(o.cmds[0].pos, [3, 3, 20]);
    assert!(o.cmds[0].faces.has(3) && !o.cmds[0].faces.has(2), "top exposed, bottom buried");
    assert!(!o.truncated);
    // Radius: only the closest sign is inside 4 blocks of (2, 5, 21).
    let near = record_overlay(&world, 2.0, 5.0, 21.0, 3, 64);
    assert_eq!(near.signs.len(), 1);
    // Caps: far more standing signs than the limit.
    for x in 0..32 { for y in 0..32 {
        let _ = world.trailer.add_sign(abs(x, y, 20), 3, 2, 1, b"x");
    } }
    let big = record_overlay(&world, 16.0, 16.0, 21.0, 64, 64);
    assert_eq!(big.signs.len(), OVERLAY_MAX_SIGNS);
    assert!(big.truncated);
    let d = |s: &OverlaySign| (s.pos[0] as f64 + 0.5 - 16.0).powi(2) + (s.pos[1] as f64 + 0.5 - 16.0).powi(2);
    assert!(big.signs.windows(2).all(|w| d(&w[0]) <= d(&w[1])), "nearest first under the cap");

    // Opaque trailer: empty, not an error.
    let mut b = trailer_world();
    b.extend_from_slice(&[1, 2, 3, 4, 5]);
    let opaque = parse_world_inner(mmap_from_bytes(b)).expect("parse");
    assert!(!opaque.trailer.parsed());
    let e = record_overlay(&opaque, 0.0, 0.0, 0.0, 32, 64);
    assert!(e.signs.is_empty() && e.cmds.is_empty() && !e.truncated);
}

/// Plan §3.2's writer table: a world with a touched trailer, saved by every full writer,
/// reloads with the new trailer and the same head.
#[test]
pub(crate) fn test_touched_trailer_reaches_every_full_writer() {
    let dir = stage4_dir("trailer_writers");
    let mut ws = ws_with(trailer_world());
    let tail = touch_trailer(&mut ws);
    let world = ws.world.as_ref().unwrap();
    let head = world.bytes[..world.trailer_start as usize].to_vec();
    let check = |w: &LoadedWorld, what: &str| {
        assert_eq!(w.trailer_bytes(), tail, "{what}: the new trailer");
        assert_eq!(w.trailer.cmds().len(), 1, "{what}");
        assert_eq!(w.trailer.signs().len(), 1, "{what}");
        assert_eq!(w.chunk_map.len(), world.chunk_map.len(), "{what}: chunks kept");
    };

    // Full write from the mapping.
    let out = dir.join("full.eden");
    save_world_inner(world, out.to_str().unwrap(), false).expect("full save");
    assert_eq!(fs::read(&out).unwrap(), [&head[..], &tail].concat(), "full: head ++ tail");
    check(&reload(&out), "full");

    // Compressed.
    let out = dir.join("zipped.eden.zip");
    save_world_compressed(world, out.to_str().unwrap(), false, None).expect("compressed save");
    let mut zip = zip::ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
    let mut inner = Vec::new();
    std::io::Read::read_to_end(&mut zip.by_index(0).unwrap(), &mut inner).unwrap();
    assert_eq!(inner, [&head[..], &tail].concat(), "compressed: head ++ tail");

    // The rebuilding writers.
    let out = dir.join("expand.eden");
    expand_world_inner(out.to_str().unwrap(), world, &[], &FxHashMap::default(), false, || false, |_| {})
        .expect("expand");
    check(&reload(&out), "expand");
    let out = dir.join("materialize.eden");
    let (coords, src) = materialize_src(world);
    let params = FlatChunkParams { chunk_size: world.chunk_size, stone_depth: 1, dirt_depth: 2, surface_z: 4 };
    materialize_flat_chunks_inner(out.to_str().unwrap(), world.chunk_size, &world.bytes[..192], &coords, src,
        &[], &params, &world.file_image().tail, &[], || false, |_, _| {}).expect("materialize");
    check(&reload(&out), "materialize");

    // The MAP_SHARED clone path (18.11): clone the temp, then patch its tail. The temp itself
    // keeps its length (T3).
    let temp = dir.join("staged.eden");
    fs::write(&temp, trailer_world()).unwrap();
    let (mmap, _) = map_staged_temp_ex(&temp).unwrap();
    let mut ws2 = WorldState::new();
    ws2.world = Some(parse_world_inner(mmap).unwrap());
    assert_eq!(touch_trailer(&mut ws2), tail);
    let out = dir.join("cloned.eden");
    save_world_progress(ws2.world.as_ref().unwrap(), out.to_str().unwrap(), false, None, Some(&temp))
        .expect("clone save");
    assert_eq!(fs::read(&out).unwrap(), [&head[..], &tail].concat(), "clone: head ++ tail");
    assert_eq!(fs::metadata(&temp).unwrap().len(), trailer_world().len() as u64, "the temp never changes length");
    drop(ws2);
    let _ = fs::remove_dir_all(&dir);
}

/// The incremental save writes the tail through the WAL, and the file's length moves with it:
/// grows on an added record, stays eligible for the next save, and shrinks when the trailer
/// empties (no trailer at all).
#[test]
pub(crate) fn test_incremental_save_writes_the_tail() {
    let dir = stage4_dir("trailer_incremental");
    let dest = dir.join("world.eden");
    let state: AppState = RwLock::new(ws_with_disk_image(trailer_world(), &dest));
    let tail = touch_trailer(&mut write_ws(&state));
    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("save"), "a trailer-only save is eligible");
    let expected = image_bytes(read_ws(&state).world.as_ref().unwrap());
    assert_eq!(fs::read(&dest).unwrap(), expected);
    assert!(expected.ends_with(&tail) && expected.len() > trailer_world().len(), "the file grew");
    assert!(!wal_path(&dest).exists());
    {
        let ws = read_ws(&state);
        assert!(!ws.dirty.trailer_disk, "the save discharged the trailer");
        assert!(ws.dirty.trailer_load && ws.dirty.trailer_journal && ws.dirty.trailer_base);
        assert_eq!(ws.disk_image.as_ref().unwrap().len, expected.len() as u64);
    }

    // A chunk edit next: the new file length is a valid image, so still incremental.
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |w| { delete_blocks_inner(w, 0, 0, 5, 5, 0, 63, None); Ok(()) })
            .expect("edit");
    }
    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("save 2"), "eligible at the new length");
    assert_eq!(fs::read(&dest).unwrap(), image_bytes(read_ws(&state).world.as_ref().unwrap()));

    // Empty the trailer: the file ends at the directory.
    {
        let mut ws = write_ws(&state);
        let w = ws.world.as_mut().unwrap();
        w.trailer.remove_cmd(0).unwrap();
        w.trailer.remove_sign(0).unwrap();
        assert!(w.trailer_bytes().is_empty(), "nothing left: no trailer");
        ws.dirty.mark_trailer();
    }
    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("save 3"));
    let ts = read_ws(&state).world.as_ref().unwrap().trailer_start;
    assert_eq!(fs::metadata(&dest).unwrap().len(), ts, "the file shrank to the end of the directory");
    assert_eq!(fs::read(&dest).unwrap(), image_bytes(read_ws(&state).world.as_ref().unwrap()));
    let _ = fs::remove_dir_all(&dir);
}

/// A committed WAL with a tail record rolls forward whether the crash left the destination at
/// its old length or at its final one (the apply sets the length first), and is discarded at
/// any other length.
#[test]
pub(crate) fn test_wal_tail_recovers_at_either_length() {
    let dir = stage4_dir("trailer_wal");
    let base = trailer_world();
    let ts = base.len() - QUARRY_SIGN_TRAILER.len();
    let mut ws = ws_with(base.clone());
    let tail = touch_trailer(&mut ws);
    let span_off = 4096u64; // somewhere in chunk data
    let span = vec![0x5a; 64];
    let mut expected = [&base[..ts], &tail].concat();
    expected[span_off as usize..span_off as usize + 64].copy_from_slice(&span);
    let write_wal = |dest: &std::path::Path| {
        let f = fs::File::create(wal_path(dest)).unwrap();
        let hdr = journal::JournalHeader::new(false, base.len() as u64, [9; 16]).with_tail();
        let mut w = journal::JournalWriter::create_with(f, hdr).unwrap();
        w.append_tail(ts as u64, &tail).unwrap();
        w.append_span(span_off, 0, 0, &span).unwrap();
        w.append_commit().unwrap();
        w.flush().unwrap();
    };
    let dest = dir.join("w.eden");
    for (case, before) in [
        ("crash before the apply", base.clone()),
        ("crash after set_len + tail, spans owed", [&base[..ts], &tail].concat()),
        ("crash after set_len only", { let mut v = base.clone(); v.resize(ts + tail.len(), 0); v }),
    ] {
        fs::write(&dest, &before).unwrap();
        write_wal(&dest);
        assert!(has_committed_wal(&dest), "{case}");
        recover_wal(&dest);
        assert_eq!(fs::read(&dest).unwrap(), expected, "{case}");
        assert!(!wal_path(&dest).exists(), "{case}: the log is cleaned up");
    }
    // Any other length is not this log's destination: discarded, file untouched.
    let other = [&base[..], &[0u8; 16]].concat();
    fs::write(&dest, &other).unwrap();
    write_wal(&dest);
    assert!(!has_committed_wal(&dest));
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), other);
    assert!(!wal_path(&dest).exists());
    let _ = fs::remove_dir_all(&dir);
}

/// The autosave journal carries the trailer as a tail record, for a Source lineage (the file's
/// own length as `base_len`) and a Clone (the temp's), and recovery restores it with
/// `trailer_load` set.
#[test]
pub(crate) fn test_autosave_tail_record_recovers_the_trailer() {
    for clone in [false, true] {
        let dir = stage4_dir(if clone { "trailer_autosave_clone" } else { "trailer_autosave_source" });
        let src = dir.join("w.eden");
        fs::write(&src, trailer_world()).unwrap();
        let state: AppState = RwLock::new(WorldState::new());
        load_world_inner(src.to_str().unwrap().into(), &state).expect("load");
        if clone {
            write_ws(&state).disk_image = None; // no Source base: the tick clones the temp
        }
        let paths = autosave_paths_at(&dir);
        let tail = touch_trailer(&mut write_ws(&state));
        {
            let mut ws = write_ws(&state);
            with_edit(&mut ws, "delete", (0, 0, 5, 5), |w| { delete_blocks_inner(w, 0, 0, 5, 5, 0, 63, None); Ok(()) })
                .expect("edit");
        }
        autosave_world_inner(&state, &paths, None, None).expect("tick");
        assert!(!read_ws(&state).dirty.trailer_journal, "the tick discharged the trailer");
        let expected = image_bytes(read_ws(&state).world.as_ref().unwrap());

        let fresh: AppState = RwLock::new(WorldState::new());
        load_autosave_inner(&fresh, &paths).expect("recovery");
        {
            let ws = read_ws(&fresh);
            let w = ws.world.as_ref().unwrap();
            assert_eq!(image_bytes(w), expected, "clone={clone}: the recovered world is the ticked one");
            assert_eq!(w.trailer_bytes(), tail);
            assert!(ws.dirty.trailer_load && ws.dirty.trailer_disk, "clone={clone}: the replayed trailer is owed");
        }
        for s in [&state, &fresh] {
            let t = read_ws(s).temp_path.clone();
            write_ws(s).world = None;
            if let Some(t) = t { let _ = fs::remove_file(t); }
        }
        let _ = fs::remove_dir_all(&dir);
    }
}

/// Sidecar adoption (plan §6.2): the trailer wins per section; adoption owes the trailer to the
/// file but doesn't make the world "unsaved"; Save As elsewhere doesn't rename; a save to the
/// world's own path writes the records in and renames the adopted sidecar `*.adopted`.
#[test]
pub(crate) fn test_sidecar_adoption_and_rename_on_save() {
    let dir = stage4_dir("trailer_sidecars");
    let src = dir.join("w.eden");
    fs::write(&src, trailer_world()).unwrap();
    let section = |magic: &[u8; 4], rec: usize, n: u32| {
        let mut v = magic.to_vec();
        v.extend(1u32.to_le_bytes());
        v.extend(n.to_le_bytes());
        v.resize(12 + rec * n as usize, 0);
        v
    };
    fs::write(dir.join("signs_w.eden.dat"), section(b"SGN1", trailer::SIGN_LEN, 2)).unwrap();
    fs::write(dir.join("cmd_w.eden.dat"), section(b"CMB1", trailer::CMD_LEN, 3)).unwrap();

    let state: AppState = RwLock::new(WorldState::new());
    let meta = load_world_inner(src.to_str().unwrap().into(), &state).expect("load");
    assert_eq!(meta.records_adopted, RecordCounts { signs: 0, cmds: 3 }, "the world's own SGN1 wins");
    {
        let ws = read_ws(&state);
        let d = &ws.dirty;
        assert!(d.trailer_disk && d.trailer_journal && d.trailer_base && d.trailer_adopt_pending);
        assert!(!d.trailer_load, "adoption alone isn't an unsaved change");
        let r = records_info(ws.world.as_ref().unwrap(), ws.adopted.as_ref());
        assert_eq!((r.signs.len(), r.cmds.len(), r.adopted.cmds), (1, 3, 3));
    }

    // Save As elsewhere: written in there, but the sidecar stays (the original still lacks it).
    let other = dir.join("copy.eden");
    let seq = read_ws(&state).dirty.seq;
    save_world_progress(read_ws(&state).world.as_ref().unwrap(), other.to_str().unwrap(), false, None, None).unwrap();
    record_full_write(&state, &other, false, seq).unwrap();
    assert_eq!(reload(&other).trailer.cmds().len(), 3);
    assert!(dir.join("cmd_w.eden.dat").exists(), "Save As elsewhere doesn't rename");
    assert!(read_ws(&state).dirty.trailer_adopt_pending);

    // Back to its own path (Save As back, a full write): written in, sidecar renamed.
    let seq = read_ws(&state).dirty.seq;
    save_world_progress(read_ws(&state).world.as_ref().unwrap(), src.to_str().unwrap(), false, None, None).unwrap();
    record_full_write(&state, &src, false, seq).unwrap();
    assert!(!dir.join("cmd_w.eden.dat").exists() && dir.join("cmd_w.eden.dat.adopted").exists());
    assert!(dir.join("signs_w.eden.dat").exists(), "an ignored sidecar is left alone");
    assert!(!read_ws(&state).dirty.trailer_adopt_pending);

    // Reload: the records are the world's own now, nothing adopted.
    let state2: AppState = RwLock::new(WorldState::new());
    let meta = load_world_inner(src.to_str().unwrap().into(), &state2).expect("reload");
    assert_eq!(meta.records_adopted, RecordCounts::default());
    let ws = read_ws(&state2);
    assert_eq!((ws.world.as_ref().unwrap().trailer.signs().len(), ws.world.as_ref().unwrap().trailer.cmds().len()), (1, 3));
    drop(ws);
    for s in [&state, &state2] {
        let t = read_ws(s).temp_path.clone();
        write_ws(s).world = None;
        if let Some(t) = t { let _ = fs::remove_file(t); }
    }
    let _ = fs::remove_dir_all(&dir);
}

/// 29.5 / audit C-06: a `w.emod` or `w.eden.zip` beside the game's `w.eden` shares its stem, so it
/// adopts `w.eden`'s sidecars — read-only. Its own save ends the adoption without renaming them
/// (the game's `w.eden` still relies on them); only a save to the `.eden` they're named for retires
/// them, and that never replaces an `.adopted` left by an earlier adoption.
#[test]
pub(crate) fn test_sidecar_adoption_read_only_for_siblings() {
    let dir = stage4_dir("sidecar_siblings");
    let signs = dir.join("signs_w.eden.dat");
    let cmds = dir.join("cmd_w.eden.dat");
    fs::write(&signs, b"s").unwrap();
    fs::write(&cmds, b"c").unwrap();
    let adopt = |ws: &mut WorldState, from: &str| {
        ws.dirty.mark_adopted();
        ws.adopted = Some(AdoptedSidecars {
            world_path: dir.join(from),
            files: vec![signs.clone(), cmds.clone()],
            counts: RecordCounts { signs: 1, cmds: 1 },
        });
    };
    let mut ws = WorldState::new();

    for sibling in ["w.emod", "w.eden.zip", "w.zip"] {
        adopt(&mut ws, sibling);
        // Save As elsewhere: still pending.
        assert!(take_adopted_for(&mut ws, &dir.join("other.eden")).is_empty(), "{sibling}");
        assert!(ws.dirty.trailer_adopt_pending && ws.adopted.is_some(), "{sibling}");
        // Its own save: written into itself, adoption over, nothing to rename.
        assert!(take_adopted_for(&mut ws, &dir.join(sibling)).is_empty(), "{sibling}");
        assert!(!ws.dirty.trailer_adopt_pending && ws.adopted.is_none(), "{sibling}");
    }

    // A sibling saved as the `.eden` the sidecars name: that file holds them now, so they retire.
    adopt(&mut ws, "w.emod");
    assert_eq!(take_adopted_for(&mut ws, &dir.join("w.eden")), vec![signs.clone(), cmds.clone()]);
    assert!(!ws.dirty.trailer_adopt_pending);

    // A `.eden` in another folder with the same name isn't theirs.
    let sub = dir.join("sub");
    fs::create_dir_all(&sub).unwrap();
    adopt(&mut ws, "w.eden");
    assert!(take_adopted_for(&mut ws, &sub.join("w.eden")).is_empty());
    assert!(ws.dirty.trailer_adopt_pending);
    let files = take_adopted_for(&mut ws, &dir.join("w.eden"));
    assert_eq!(files.len(), 2);

    // An earlier adoption's `.adopted` (and `.2.adopted`) are kept; this one gets the next name.
    fs::write(dir.join("signs_w.eden.dat.adopted"), b"old1").unwrap();
    fs::write(dir.join("signs_w.eden.dat.2.adopted"), b"old2").unwrap();
    rename_adopted(&files);
    assert!(!signs.exists() && !cmds.exists());
    assert_eq!(fs::read(dir.join("signs_w.eden.dat.adopted")).unwrap(), b"old1");
    assert_eq!(fs::read(dir.join("signs_w.eden.dat.2.adopted")).unwrap(), b"old2");
    assert_eq!(fs::read(dir.join("signs_w.eden.dat.3.adopted")).unwrap(), b"s");
    assert_eq!(fs::read(dir.join("cmd_w.eden.dat.adopted")).unwrap(), b"c");
    let _ = fs::remove_dir_all(&dir);
}

/// The Command Block Academy specimen (private: skips when absent): the
/// `.eden` has no trailer and its records live in the game's sidecars (109 signs, 45 command
/// blocks); the `.emod` holds its own (one more sign). Both open with every record; saving the `.eden`
/// in place writes them in (`CMB1` first) and retires the sidecars.
#[test]
pub(crate) fn test_academy_specimen_adopts_and_saves() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../TEST WORLDS/academy");
    let world = root.join("Command Block Academy.eden");
    if !world.exists() {
        eprintln!("skipping: {world:?} not present");
        return;
    }
    let dir = stage4_dir("academy");
    let src = dir.join("Command Block Academy.eden");
    for f in ["Command Block Academy.eden", "signs_Command Block Academy.eden.dat", "cmd_Command Block Academy.eden.dat"] {
        fs::copy(root.join(f), dir.join(f)).unwrap();
    }
    let state: AppState = RwLock::new(WorldState::new());
    let meta = load_world_inner(src.to_str().unwrap().into(), &state).expect("load academy");
    assert_eq!(meta.records_adopted, RecordCounts { signs: 109, cmds: 45 });
    {
        let ws = read_ws(&state);
        let t = &ws.world.as_ref().unwrap().trailer;
        assert_eq!(t.section_order(), vec![trailer::CMB1, trailer::SGN1]);
    }
    assert!(try_incremental_save(&state, src.to_str().unwrap(), false).expect("save"), "a trailer-only save is incremental");
    assert!(dir.join("signs_Command Block Academy.eden.dat.adopted").exists());
    assert!(dir.join("cmd_Command Block Academy.eden.dat.adopted").exists());
    let state2: AppState = RwLock::new(WorldState::new());
    let meta = load_world_inner(src.to_str().unwrap().into(), &state2).expect("reload");
    assert_eq!(meta.records_adopted, RecordCounts::default());
    {
        let ws = read_ws(&state2);
        let t = &ws.world.as_ref().unwrap().trailer;
        assert!(t.parsed());
        assert_eq!((t.signs().len(), t.cmds().len()), (109, 45));
    }

    // The `.emod`: its own SIGN_TRAILER (any sidecar beside it would lose to it).
    let emod_path = root.join("command block academy.emod");
    if emod_path.exists() {
        let e = dir.join("academy.emod");
        fs::copy(&emod_path, &e).unwrap();
        let state3: AppState = RwLock::new(WorldState::new());
        let meta = load_world_inner(e.to_str().unwrap().into(), &state3).expect("load the .emod");
        assert_eq!(meta.container, "emod");
        assert_eq!(meta.records_adopted, RecordCounts::default());
        let ws = read_ws(&state3);
        let t = &ws.world.as_ref().unwrap().trailer;
        // Measured 2026-10-25: the .emod has one sign more than the .eden's sidecar (it was
        // saved from a later session), the same 45 command blocks.
        assert_eq!((t.signs().len(), t.cmds().len()), (110, 45), "the .emod carries its own records");
        assert_eq!(t.section_order(), vec![trailer::CMB1, trailer::SGN1]);
        drop(ws);
        let t = read_ws(&state3).temp_path.clone();
        write_ws(&state3).world = None;
        if let Some(t) = t { let _ = fs::remove_file(t); }
    }
    for s in [&state, &state2] {
        let t = read_ws(s).temp_path.clone();
        write_ws(s).world = None;
        if let Some(t) = t { let _ = fs::remove_file(t); }
    }
    let _ = fs::remove_dir_all(&dir);
}

/// Plan §3.2's guard: no shipping code hands the mapping to a file writer — the file is
/// `file_image()` (head + the trailer as it saves). Comment lines and the test module are
/// exempt; a new writer that needs the raw temp (e.g. a snapshot) belongs in this allowlist
/// with a reason.
#[test]
pub(crate) fn test_no_file_writer_takes_the_raw_mapping() {
    let forbidden = ["&world.bytes[..]", "&*world.bytes", "write_all(&world.bytes", "(&world.bytes)",
        "&w.bytes[..]", ", &world.bytes,", "&mut &world.bytes"];
    for (name, src) in [("lib.rs", include_str!("../lib.rs")), ("emod.rs", include_str!("../emod.rs")),
        ("worldgen.rs", include_str!("../worldgen.rs")), ("network.rs", include_str!("../network.rs"))] {
        let shipping = src.split("#[cfg(test)]\nmod tests").next().unwrap();
        for (n, line) in shipping.lines().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") { continue; }
            for f in forbidden {
                assert!(!code.contains(f), "{name}:{}: `{f}` — write through `LoadedWorld::file_image()`", n + 1);
            }
        }
    }
}
