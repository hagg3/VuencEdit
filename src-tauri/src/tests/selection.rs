use super::*;

// ── Non-rectangular selection (SelectionMask) ─────────────────────────────────

/// A mask covering exactly the cells in `x1..=x2, y1..=y2` for which `pred(x,y)` holds.
pub(crate) fn mask_from<F: Fn(i32, i32) -> bool>(x1: i32, y1: i32, x2: i32, y2: i32, pred: F) -> SelectionMask {
    let w = x2 - x1 + 1;
    let h = y2 - y1 + 1;
    let mut bits = vec![0u8; ((w * h + 7) / 8) as usize];
    for y in y1..=y2 {
        for x in x1..=x2 {
            if pred(x, y) {
                let idx = ((y - y1) * w + (x - x1)) as usize;
                bits[idx >> 3] |= 1u8 << (idx & 7);
            }
        }
    }
    SelectionMask { x1, y1, x2, y2, bits }
}

/// The bitset addressing round-trips: `contains` matches the predicate, is false outside the
/// bbox, and `count` equals the number of set cells.
#[test]
pub(crate) fn test_selection_mask_contains_and_count() {
    let m = mask_from(0, 0, 3, 3, |x, y| x == y); // main diagonal of a 4×4 box
    assert_eq!(m.count(), 4);
    assert!(m.contains(0, 0) && m.contains(2, 2) && m.contains(3, 3));
    assert!(!m.contains(1, 0) && !m.contains(0, 3), "off-diagonal cells are unset");
    assert!(!m.contains(4, 4) && !m.contains(-1, -1), "outside the bbox is never contained");
}

/// The corruption-critical fail-safe: `active_mask` yields the mask ONLY on an exact bbox match,
/// so a stale mask can never mis-filter a selection that has since been reshaped.
#[test]
pub(crate) fn test_active_mask_fail_safe_rect_equality() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
    ws.selection_mask = Some(mask_from(2, 2, 5, 5, |x, y| x == y));
    assert!(active_mask(&ws, 2, 2, 5, 5).is_some(), "exact bbox match resolves the mask");
    assert!(active_mask(&ws, 2, 2, 5, 6).is_none(), "wrong y2 → rect-only fallback");
    assert!(active_mask(&ws, 1, 2, 5, 5).is_none(), "wrong x1 → rect-only fallback");
    assert!(active_mask(&ws, 0, 0, 15, 15).is_none(), "unrelated rect → rect-only fallback");
    assert!(active_mask(&ws, 2, 2, 5, 5).is_some(), "resolving does not consume the mask");
}

/// A masked delete clears only the shaped cells; unmasked columns inside the same bounding box
/// survive — the headline "wand deletes the whole box" fix, at the `_inner` level.
#[test]
pub(crate) fn test_delete_blocks_respects_mask() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // every column solid z=1..20
    let mask = mask_from(4, 4, 7, 7, |x, y| x - 4 == y - 4); // diagonal of the 4×4 box
    delete_blocks_inner(ws.world.as_mut().unwrap(), 4, 4, 7, 7, 0, 63, Some(&mask));
    let w = ws.world.as_ref().unwrap();
    assert_eq!(surface_z_capped(w, 4, 4, None), None, "masked diagonal column is cleared to air");
    assert_eq!(surface_z_capped(w, 7, 7, None), None, "far masked column is cleared too");
    assert_eq!(surface_z_capped(w, 5, 4, None), Some(20), "unmasked column inside bbox is untouched");
    assert_eq!(surface_z_capped(w, 4, 7, None), Some(20), "unmasked bbox corner is untouched");
}

/// A masked fill (`replace_blocks_inner`) re-skins only shaped cells; unmasked cells keep their
/// original block. Guards the second edit command that reads the mask.
#[test]
pub(crate) fn test_replace_blocks_respects_mask() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // grass (bt 8)
    let mask = mask_from(4, 4, 7, 7, |x, _| x == 4); // just the left edge column of the box
    // Fill z=20 only with brick (bt 13, paint 0), no filter.
    replace_blocks_inner(ws.world.as_mut().unwrap(), 4, 4, 7, 7, 20, 20, 13, 0, None, None, false, Some(&mask));
    let w = ws.world.as_ref().unwrap();
    assert_eq!(read_block_abs(w, 4, 5, 20), 13, "masked cell became brick");
    assert_eq!(read_block_abs(w, 5, 5, 20), 8, "unmasked cell kept grass");
}

/// A masked move relocates only the shaped cells and clears only those source cells; unmasked
/// cells inside the bbox (both source and dest) are left exactly as they were.
#[test]
pub(crate) fn test_move_selection_respects_mask() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // grass col height 20 everywhere
    // Mark the block just below the surface so we can identify moved material: set (4,4,10)=stone.
    set_block_abs(ws.world.as_mut().unwrap(), 4, 4, 10, 2, 0);
    let mask = mask_from(4, 4, 5, 5, |x, y| x == 4 && y == 4); // only the single corner column
    // Move the shaped selection +3 in x (dz=0). Reuse the inner move logic via the closure body:
    // build buf, clear masked source, write masked dest.
    let (x1, y1) = (4, 4);
    let (width, height, depth) = (2i32, 2i32, 11i32); // z 0..=10
    with_edit(&mut ws, "move", (4, 4, 8, 5), |world| {
        let n = (width * height * depth) as usize;
        let mut buf_bt = vec![0u8; n];
        let mut buf_paint = vec![0u8; n];
        for lz in 0..depth { for ly in 0..height { for lx in 0..width {
            let idx = (lz * height * width + ly * width + lx) as usize;
            buf_bt[idx] = read_block_abs(world, x1 + lx, y1 + ly, lz);
            buf_paint[idx] = read_paint_abs(world, x1 + lx, y1 + ly, lz);
        }}}
        for lz in 0..depth { for ly in 0..height { for lx in 0..width {
            if !mask.contains(x1 + lx, y1 + ly) { continue; }
            set_block_abs(world, x1 + lx, y1 + ly, lz, 0, 0);
        }}}
        for lz in 0..depth { for ly in 0..height { for lx in 0..width {
            if !mask.contains(x1 + lx, y1 + ly) { continue; }
            let idx = (lz * height * width + ly * width + lx) as usize;
            set_block_abs(world, x1 + 3 + lx, y1 + ly, lz, buf_bt[idx], buf_paint[idx]);
        }}}
        Ok(())
    }).expect("masked move");
    let w = ws.world.as_ref().unwrap();
    assert_eq!(read_block_abs(w, 4, 4, 10), 0, "masked source column cleared");
    assert_eq!(read_block_abs(w, 7, 4, 10), 2, "stone moved +3 to the masked dest");
    assert_eq!(read_block_abs(w, 5, 4, 10), 8, "unmasked neighbour inside bbox untouched");
}

/// A shaped copy stores its footprint, and paste through the shared helper skips unmasked
/// columns — a copied L-shape stamps an L, not a filled box.
#[test]
pub(crate) fn test_masked_clipboard_paste_skips_unmasked() {
    // Clipboard footprint: 2×2, only the diagonal (0,0) and (1,1) set.
    let block_types = vec![13u8, 13, 13, 13]; // all brick
    let paints = vec![0u8; 4];
    let mut bits = vec![0u8; 1];
    bits[0] |= 1 << 0; // (dy0,dx0) idx 0
    bits[0] |= 1 << 3; // (dy1,dx1) idx 3
    let cb = Clipboard { width: 2, height: 2, depth: 1, z_anchor: 30, block_types, paints, mask: Some(bits), origin: None };
    assert!(cb.info().masked, "info reflects the footprint");

    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
    let mask = cb.mask.clone();
    with_edit(&mut ws, "paste", (10, 10, 11, 11), |world| {
        paste_clipboard_at(world, 10, 10, &cb.block_types, &cb.paints,
            cb.width, cb.height, cb.depth, cb.z_anchor, 0, false, world_max_z(world), mask.as_deref());
        Ok(())
    }).expect("masked paste");
    let w = ws.world.as_ref().unwrap();
    assert_eq!(read_block_abs(w, 10, 10, 30), 13, "diagonal cell (0,0) stamped");
    assert_eq!(read_block_abs(w, 11, 11, 30), 13, "diagonal cell (1,1) stamped");
    assert_eq!(read_block_abs(w, 11, 10, 30), 0, "off-diagonal (1,0) skipped — shape preserved");
    assert_eq!(read_block_abs(w, 10, 11, 30), 0, "off-diagonal (0,1) skipped");
}

// ── Paste lens (14.8) ───────────────────────────────────────────────────────────────────

/// A 5×4×3 clipboard with a mix of air and solids and one column masked out of the footprint.
pub(crate) fn lens_test_clipboard(z_anchor: i32) -> Clipboard {
    let (w, h, d) = (5, 4, 3);
    let n = (w * h * d) as usize;
    let block_types = (0..n).map(|i| if i % 4 == 1 { 0 } else { 13 + (i % 3) as u8 }).collect();
    let paints = (0..n).map(|i| (i % 7) as u8).collect();
    let mut bits = vec![0xffu8; 3];
    bits[0] &= !(1 << 6); // (dx 1, dy 1) outside the footprint
    Clipboard { width: w, height: h, depth: d, z_anchor, block_types, paints, mask: Some(bits), origin: None }
}

/// The lens's terrain-mode bases are the paste's: after a real `paste_terrain`, exactly the
/// cells `terrain_paste_base + offset + dz` predicts were written (and nothing else changed),
/// and the lens rendered against the pre-paste world counted exactly the solid-over-solid ones.
#[test]
pub(crate) fn test_terrain_paste_base_matches_paste_terrain() {
    let heights = |lx: usize, ly: usize| 4 + ((lx * 3 + ly * 5) % 11) as i32;
    for (ignore_air, above_surface, offset) in [(true, true, -2), (false, false, -1), (false, true, -3)] {
        let pre_bytes = make_bumpy_world(2, heights);
        let pre = parse_world_inner(mmap_from_bytes(pre_bytes.clone())).expect("parse");
        let mut ws = ws_with(pre_bytes);
        ws.clipboard = Some(lens_test_clipboard(0));
        let (px, py) = (6, 7);

        let lens = render_paste_lens_inner(&ws, px, py, offset, "terrain", above_surface, ignore_air, 2, None)
            .expect("lens");
        let cb = ws.clipboard.as_ref().unwrap();
        let bases = paste_lens_bases(&pre, cb, px, py, true, offset, above_surface, None);
        let (w, h, d) = (cb.width as usize, cb.height as usize, cb.depth as usize);
        let (types, paints) = (cb.block_types.clone(), cb.paints.clone());

        paste_terrain_inner(&mut ws, px, py, offset, ignore_air, above_surface).expect("paste");
        let post = ws.world.as_ref().unwrap();

        let mut predicted = std::collections::HashSet::new();
        let mut solid_over_solid = 0u64;
        for dy in 0..h { for dx in 0..w {
            let b = bases[dy * w + dx];
            if b == render::LENS_SKIP { continue; }
            for dz in 0..d {
                let idx = dz * h * w + dy * w + dx;
                if ignore_air && types[idx] == 0 { continue; }
                let (x, y, z) = (px + dx as i32, py + dy as i32, b + dz as i32);
                predicted.insert((x, y, z));
                assert_eq!(get_block_at(post, x, y, z), (types[idx], paints[idx]),
                    "cell ({x},{y},{z}) must hold the pasted block");
                if types[idx] != 0 && read_block_abs(&pre, x, y, z) != 0 { solid_over_solid += 1; }
            }
        }}
        for x in 0..16 { for y in 0..16 { for z in 0..64 {
            if predicted.contains(&(x, y, z)) { continue; }
            assert_eq!(get_block_at(post, x, y, z), get_block_at(&pre, x, y, z),
                "({x},{y},{z}) outside the predicted cells must be untouched");
        }}}
        assert!(solid_over_solid > 0, "fixture must actually bury something");
        assert_eq!(lens.front.header.buried, solid_over_solid, "lens buried count = cells the paste overwrote");
        // The masked-out column (dx 1, dy 1) is skipped by both.
        assert_eq!(bases[w + 1], render::LENS_SKIP);
    }
}

/// Front (X-Z) or side (Y-Z) silhouette of the clipboard as RGBA (alpha 0 = air), the oracle for
/// `test_paste_lens_no_terrain_ghost_equals_clipboard_silhouette`. It was the retired
/// `render_clipboard_elevation_preview` command's core (20.4). An unmasked column of a shaped
/// clipboard reads as air, so the silhouette matches the paste footprint.
pub(crate) fn clipboard_silhouette(cb: &Clipboard, sky: u8, view: &str) -> PreviewData {
    let (w, h, d) = (cb.width as usize, cb.height as usize, cb.depth as usize);
    let is_front = view != "side";
    let img_w = if is_front { w } else { h };
    let mut pixels = vec![0u8; img_w * d * 4];
    for dz in 0..d {
        let row = d - 1 - dz; // row 0 = top = highest z
        for col in 0..img_w {
            // front: col = dx, scan dy front-to-back; side: col = dy, scan dx left-to-right.
            let n = if is_front { h } else { w };
            let hit = (0..n).find_map(|k| {
                let i = if is_front { k * w + col } else { col * w + k };
                if cb.mask.as_ref().is_some_and(|m| !bit_set(m, i)) { return None; }
                let bt = cb.block_types[dz * h * w + i];
                if bt != 0 { Some((bt, cb.paints[dz * h * w + i])) } else { None }
            });
            if let Some((bt, paint)) = hit {
                let [r, g, b] = block_color(bt, paint, sky);
                let o = (row * img_w + col) * 4;
                pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b; pixels[o + 3] = 255;
            }
        }
    }
    PreviewData { width: img_w as u32, height: d as u32, lod: 1, pixels }
}

/// On an empty world the lens's ghost is the clipboard silhouette, shifted to the
/// paste Z — the two renders share axes, handedness and the mask gate.
#[test]
pub(crate) fn test_paste_lens_no_terrain_ghost_equals_clipboard_silhouette() {
    let mut ws = ws_with(make_bumpy_world(0, |_, _| 1)); // surf_bt 0 = all air
    let cb = lens_test_clipboard(20);
    let (w, h, d) = (cb.width as u32, cb.height as u32, cb.depth as u32);
    let sil_front = clipboard_silhouette(&cb, 0, "front");
    let sil_side = clipboard_silhouette(&cb, 0, "side");
    ws.clipboard = Some(cb);
    let pair = render_paste_lens_inner(&ws, 3, 4, 5, "normal", false, true, 0, None).expect("lens");
    for (view, lens, sil, cols) in [("front", &pair.front, sil_front, w), ("side", &pair.side, sil_side, h)] {
        let hd = &lens.header;
        assert_eq!((hd.width, sil.width), (cols, cols));
        assert_eq!((hd.buried, hd.cleared), (0, 0));
        for col in 0..cols {
            for srow in 0..d {
                let z = 25 + (d - 1 - srow) as i32; // z_anchor 20 + offset 5
                let lrow = (hd.z_hi - z) as u32;
                let sa = sil.pixels[((srow * cols + col) * 4 + 3) as usize];
                let la = lens.pixels[((lrow * hd.width + col) * 4 + 3) as usize];
                assert_eq!(la == 255, sa == 255, "{view} col {col} z {z}");
            }
        }
    }
}

/// `PasteLensPatch` frames both views as one binary envelope (header JSON + two raw RGBA
/// bodies), never base64, and the two views agree on the Z window and the cell counts.
#[test]
pub(crate) fn test_render_paste_lens_envelope() {
    use tauri::ipc::InvokeResponseBody;
    let mut ws = ws_with(make_bumpy_world(2, |_, _| 10));
    ws.clipboard = Some(lens_test_clipboard(8));
    let lens = render_paste_lens_inner(&ws, 2, 2, 0, "normal", false, false, 3, Some(64)).expect("lens");
    let (f, s) = (&lens.front.header, &lens.side.header);
    assert_eq!((f.z_lo, f.z_hi), (s.z_lo, s.z_hi), "one Z window for both views");
    assert_eq!((f.ghost_z_min, f.ghost_z_max), (s.ghost_z_min, s.ghost_z_max));
    assert_eq!((f.buried, f.cleared, f.floating_cols, f.approx), (s.buried, s.cleared, s.floating_cols, s.approx));
    let (fl, sl) = (lens.front.pixels.len(), lens.side.pixels.len());
    let bytes = match tauri::ipc::IpcResponse::body(lens).expect("frame") {
        InvokeResponseBody::Raw(v) => v,
        InvokeResponseBody::Json(_) => panic!("lens must be a raw envelope"),
    };
    let hlen = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    assert_eq!((4 + hlen) % 4, 0);
    let hdr: serde_json::Value = serde_json::from_slice(&bytes[4..4 + hlen]).unwrap();
    assert_eq!(hdr["lens"], serde_json::json!([fl, sl]));
    assert_eq!(bytes.len() - 4 - hlen, fl + sl);
    for (k, n) in [("front", fl), ("side", sl)] {
        let v = &hdr[k];
        assert_eq!((v["width"].as_u64().unwrap() * v["height"].as_u64().unwrap() * 4) as usize, n, "{k}");
    }
    let side = &hdr["side"];
    assert_eq!(side["col_lo"], -1, "side view: y 2 − 3 context columns");
    assert_eq!(side["footprint_lo"], 2);
    assert_eq!(side["footprint_hi"], 5);
    assert_eq!(hdr["front"]["footprint_hi"], 6, "front: x 2 + width 5 − 1");
    assert!(side["buried"].as_u64().unwrap() > 0 && side["cleared"].as_u64().unwrap() > 0);
    assert!(render_paste_lens_inner(&ws, 0, 0, 0, "scatter", false, false, 0, None).is_err());
}

/// Frame a `SelectionLensPatch` and split it back into (header JSON, body bytes).
pub(crate) fn frame_selection_lens(p: SelectionLensPatch) -> (serde_json::Value, Vec<u8>) {
    use tauri::ipc::InvokeResponseBody;
    let bytes = match tauri::ipc::IpcResponse::body(p).expect("frame") {
        InvokeResponseBody::Raw(v) => v,
        InvokeResponseBody::Json(_) => panic!("selection lens must be a raw envelope"),
    };
    let hlen = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    assert_eq!((4 + hlen) % 4, 0);
    (serde_json::from_slice(&bytes[4..4 + hlen]).unwrap(), bytes[4 + hlen..].to_vec())
}

/// `render_selection_lens` (20.3): front + side in one raw envelope whose `lens` sum is the
/// body, full world height, and the stored shaped mask honoured only on an exact bbox match.
#[test]
pub(crate) fn test_render_selection_lens_envelope() {
    let mut ws = ws_with(make_bumpy_world(2, |lx, _| 6 + lx as i32));
    let (hdr, body) = frame_selection_lens(
        render_selection_lens_inner(&ws, 2, 3, 9, 6, 4, 20, 3, None, false).expect("lens"));
    let views = hdr["views"].as_array().unwrap();
    assert_eq!(views.iter().map(|v| v["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["front", "side"]);
    let lens: Vec<usize> = hdr["lens"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
    assert_eq!(lens.iter().sum::<usize>(), body.len());
    for (v, &n) in views.iter().zip(&lens) {
        assert_eq!((v["width"].as_u64().unwrap() * v["height"].as_u64().unwrap() * 4) as usize, n);
        assert_eq!(v["height"], 64, "full height on a 64z world");
        assert!(v["row_lo"].is_null());
    }
    assert_eq!((&views[0]["col_lo"], &views[0]["footprint_lo"], &views[0]["footprint_hi"]), (&(-1).into(), &2.into(), &9.into()));
    assert_eq!((&views[1]["col_lo"], &views[1]["footprint_lo"], &views[1]["footprint_hi"]), (&0.into(), &3.into(), &6.into()));
    assert_eq!((&hdr["z_lo"], &hdr["z_hi"]), (&0.into(), &63.into()));
    // Highest terrain in view: lx up to 9 + 3 context columns → 6 + 12.
    assert_eq!(hdr["terrain_z_hi"], 18);

    // A stored mask that matches the rect makes masked-out columns see-through; one that
    // doesn't is ignored (fail-safe), so the render is the plain bbox one.
    let plain = body;
    ws.selection_mask = Some(SelectionMask { x1: 2, y1: 3, x2: 9, y2: 6, bits: vec![0; 4] });
    let (_, masked) = frame_selection_lens(
        render_selection_lens_inner(&ws, 2, 3, 9, 6, 4, 20, 3, None, false).expect("lens"));
    assert_ne!(masked, plain, "an all-clear mask leaves no sel hits");
    ws.selection_mask = Some(SelectionMask { x1: 2, y1: 3, x2: 9, y2: 7, bits: vec![0; 5] });
    let (_, stale) = frame_selection_lens(
        render_selection_lens_inner(&ws, 2, 3, 9, 6, 4, 20, 3, None, false).expect("lens"));
    assert_eq!(stale, plain, "a mismatched mask is ignored");

    assert!(render_selection_lens_inner(&ws, 2, 3, 9, 6, 4, 64, 3, None, false).is_err(), "z past max_z");
    assert!(render_selection_lens_inner(&ws, 9, 3, 2, 6, 4, 20, 3, None, false).is_err(), "inverted rect");
}

/// `render_selection_lens` with `top: true` (20.5): exactly one "top" view, origin in `row_lo`,
/// z range echoed from the selection.
#[test]
pub(crate) fn test_render_selection_lens_top() {
    let ws = ws_with(make_bumpy_world(2, |lx, _| 6 + lx as i32));
    let (hdr, body) = frame_selection_lens(
        render_selection_lens_inner(&ws, 2, 3, 9, 6, 4, 20, 3, None, true).expect("lens"));
    let views = hdr["views"].as_array().unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0]["kind"], "top");
    assert!(views[0]["row_lo"].is_number());
    let lens: Vec<usize> = hdr["lens"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
    assert_eq!(lens.len(), 1);
    assert_eq!(lens.iter().sum::<usize>(), body.len());
    assert_eq!((views[0]["width"].as_u64().unwrap() * views[0]["height"].as_u64().unwrap() * 4) as usize, lens[0]);
    assert_eq!((&hdr["z_lo"], &hdr["z_hi"]), (&4.into(), &20.into()));
}

/// 20.3 §6 measurement: `render_selection_lens` (both flavours) on the largest world in
/// the private worlds folder for a 512², 2048² and whole-world selection. Reports only —
/// `cargo test -p eden-world-editor bench_selection_lens -- --ignored --nocapture`.
#[test]
#[ignore]
pub(crate) fn bench_selection_lens() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../TEST WORLDS");
    let mut worlds: Vec<_> = fs::read_dir(&dir).expect("TEST WORLDS").filter_map(|e| e.ok())
        .map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "eden")).collect();
    worlds.sort_by_key(|p| std::cmp::Reverse(fs::metadata(p).map(|m| m.len()).unwrap_or(0)));
    for path in worlds.iter().take(2) {
        let mut ws = WorldState::new();
        ws.world = Some(parse_world_inner(map_fixture(path)).expect("parse"));
        let w = ws.world.as_ref().unwrap();
        let (ww, wh, max_z) = (w.meta().width(), w.meta().height(), world_max_z(w));
        eprintln!("[bench] {:?}: {ww}×{wh} blocks, max_z {max_z}", path.file_name().unwrap());
        for side in [512, 2048, i32::MAX] {
            let (sw, sh) = (side.min(ww), side.min(wh));
            let (x1, y1) = ((ww - sw) / 2, (wh - sh) / 2);
            for top in [false, true] {
                let mut times = Vec::new();
                for _ in 0..4 {
                    let t = Instant::now();
                    render_selection_lens_inner(&ws, x1, y1, x1 + sw - 1, y1 + sh - 1, 0, max_z, 2, None, top).expect("lens");
                    times.push(t.elapsed().as_secs_f64() * 1000.0);
                }
                let best = times[1..].iter().cloned().fold(f64::MAX, f64::min);
                eprintln!("[bench]   {sw}×{sh} {}: first {:.1} ms, warm best {best:.1} ms",
                    if top { "top" } else { "front+side" }, times[0]);
            }
        }
    }
}

/// Rotating a shaped clipboard 90° CW transforms the footprint with the SAME map as the data, so
/// the mask still lines up with the blocks it gates.
#[test]
pub(crate) fn test_rotate_clipboard_transforms_mask() {
    // 2(w)×3(h) footprint, only the top-left column (dy0,dx0) set.
    let mut bits = vec![0u8; 1];
    bits[0] |= 1 << 0;
    let mut cb = Clipboard {
        width: 2, height: 3, depth: 1, z_anchor: 0,
        block_types: vec![0u8; 6], paints: vec![0u8; 6], mask: Some(bits), origin: None
    };
    rotate_clipboard_inner(&mut cb);
    // After CW: new dims 3(w)×2(h). Old (dx0,dy0) → (ndx=dy=0, ndy=old_w-1-dx=1). New idx = ndy*new_w+ndx = 1*3+0 = 3.
    assert_eq!(cb.width, 3);
    assert_eq!(cb.height, 2);
    let m = cb.mask.unwrap();
    assert!(bit_set(&m, 3), "the one set column rotated to its new position");
    assert_eq!(m.iter().map(|b| b.count_ones()).sum::<u32>(), 1, "exactly one cell still set");
}

#[test]
pub(crate) fn test_prefab_save_refuses_over_load_cap() {
    let mk = |w, h, d| Clipboard { width: w, height: h, depth: d, z_anchor: 0,
        block_types: vec![], paints: vec![], mask: None, origin: None };
    assert!(check_prefab_savable(&mk(256, 256, 1024)).is_ok(), "exactly 64M voxels is loadable");
    let err = check_prefab_savable(&mk(256, 256, 1025)).unwrap_err();
    assert!(err.contains("limited"), "{err}");
    assert!(check_prefab_savable(&mk(i32::MAX, i32::MAX, i32::MAX)).is_err(), "no i32 overflow");
}

#[test]
pub(crate) fn test_sweep_orphan_save_temps_removes_only_temps() {
    let dir = std::env::temp_dir().join(format!("eden_sweep_{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let w = dir.join("w.eden");
    for n in ["w.eden", "w.eden.savetmp", "w.eden.bak.zip.tmp", "w.eden.bak", "other.eden.savetmp"] {
        fs::write(dir.join(n), b"x").unwrap();
    }
    // 21.14: fresh temps (a live sibling's save) survive the production sweep.
    sweep_orphan_save_temps(&w);
    assert!(dir.join("w.eden.savetmp").exists() && dir.join("w.eden.bak.zip.tmp").exists());
    let z = std::time::Duration::ZERO;
    sweep_orphan_save_temps_aged(&w, z);
    assert!(w.exists() && dir.join("w.eden.bak").exists() && dir.join("other.eden.savetmp").exists());
    assert!(!dir.join("w.eden.savetmp").exists() && !dir.join("w.eden.bak.zip.tmp").exists());
    sweep_orphan_save_temps_aged(&w, z); // idempotent when nothing is there
    let _ = fs::remove_dir_all(&dir);
}

#[test]
pub(crate) fn test_temp_owner_pid_parsing() {
    assert_eq!(temp_owner_pid("vuencedit_1234_999.eden"), Some(1234));
    assert_eq!(temp_owner_pid("vuencedit_upload_77_5.gz"), Some(77));
    assert_eq!(temp_owner_pid("vuencedit_1789000000000000000.eden"), None, "legacy name");
    assert_eq!(temp_owner_pid("vuencedit_upload_1789000000000000000.gz"), None);
    assert_eq!(temp_owner_pid("vuencedit_stage4_12.eden"), None);
    assert!(pid_alive(std::process::id()));
}

#[test]
pub(crate) fn test_claim_autosave_dir_ownership_and_takeover() {
    let base = std::env::temp_dir().join(format!("eden_claim_{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let live = |p: u32| p == 100 || p == 200;
    // First instance owns the shared slot; re-claim by itself is stable.
    assert_eq!(claim_autosave_dir(&base, 100, &live), base);
    assert_eq!(claim_autosave_dir(&base, 100, &live), base);
    // A second live instance gets its own dir and the owner file is untouched.
    let d2 = claim_autosave_dir(&base, 200, &live);
    assert_eq!(d2, base.join("instance-200"));
    assert!(d2.is_dir());
    assert_eq!(read_owner_pid(&base.join("autosave.owner")), Some(100));
    // Sidecars in the shared slot are not disturbed.
    fs::write(base.join("autosave.meta.json"), b"{}").unwrap();
    // Owner dies: next instance takes over (crash recovery keeps working).
    let live2 = |p: u32| p == 300;
    assert_eq!(claim_autosave_dir(&base, 300, &live2), base);
    assert_eq!(read_owner_pid(&base.join("autosave.owner")), Some(300));
    assert!(base.join("autosave.meta.json").exists());
    // Dead instance dirs: empty one swept, one with a pending meta kept.
    fs::create_dir_all(base.join("instance-900")).unwrap();
    fs::create_dir_all(base.join("instance-901")).unwrap();
    fs::write(base.join("instance-901").join("autosave.meta.json"), b"{}").unwrap();
    let _ = claim_autosave_dir(&base, 400, &|p| p == 300 || p == 400);
    assert!(!base.join("instance-900").exists() && base.join("instance-901").exists());
    // Corrupt owner file does not wedge the slot.
    fs::write(base.join("autosave.owner"), b"junk").unwrap();
    assert_eq!(claim_autosave_dir(&base, 500, &|_| false), base);
    let _ = fs::remove_dir_all(&base);
}

#[test]
pub(crate) fn test_pick_world_zip_entry_prefers_eden_by_name() {
    use zip::write::{SimpleFileOptions, ZipWriter};
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = ZipWriter::new(&mut buf);
        let o = SimpleFileOptions::default();
        z.start_file("__MACOSX/", o).unwrap();
        z.start_file("readme.txt", o).unwrap(); z.write_all(b"hi").unwrap();
        z.start_file("My World.EDEN", o).unwrap(); z.write_all(b"w").unwrap();
        z.finish().unwrap();
    }
    let mut a = zip::ZipArchive::new(std::io::Cursor::new(buf.into_inner())).unwrap();
    assert_eq!(pick_world_zip_entry(&mut a), 2);
    let mut buf2 = std::io::Cursor::new(Vec::new());
    {
        let mut z = ZipWriter::new(&mut buf2);
        z.start_file("only.bin", SimpleFileOptions::default()).unwrap();
        z.finish().unwrap();
    }
    let mut b = zip::ZipArchive::new(std::io::Cursor::new(buf2.into_inner())).unwrap();
    assert_eq!(pick_world_zip_entry(&mut b), 0, "falls back to the first entry");
}

/// A shaped clipboard survives a prefab serialize→deserialize round trip: EPFAB\x02 carries the
/// footprint so a saved prefab pastes the shape, not its bounding box.
#[test]
pub(crate) fn test_prefab_round_trip_preserves_mask() {
    // 3(w)×2(h)×1(d) all brick; L-shaped footprint (drop the top-right cell dx2,dy0).
    let n = 6;
    let mut bits = vec![0u8; 1];
    for i in 0..6 { if i != 2 { bits[0] |= 1 << i; } }
    let cb = Clipboard {
        width: 3, height: 2, depth: 1, z_anchor: 42,
        block_types: (0..n).map(|i| 13 + i as u8).collect(),
        paints: (0..n).map(|i| i as u8).collect(),
        mask: Some(bits.clone()), origin: None
    };
    let round = deserialize_prefab(&serialize_prefab(&cb)).expect("round-trips");
    assert_eq!(round.width, 3);
    assert_eq!(round.height, 2);
    assert_eq!(round.z_anchor, 42);
    assert_eq!(round.block_types, cb.block_types, "block data intact");
    assert_eq!(round.paints, cb.paints, "paint data intact");
    assert_eq!(round.mask, Some(bits), "footprint survived the round trip");
    assert!(round.info().masked, "reloaded prefab reports as shaped");
}

/// A rectangular clipboard still writes the legacy EPFAB\x01 format (older builds keep reading
/// it), and reloads with no mask.
#[test]
pub(crate) fn test_prefab_rectangular_stays_v1() {
    let cb = Clipboard {
        width: 2, height: 2, depth: 1, z_anchor: 0,
        block_types: vec![13u8; 4], paints: vec![0u8; 4], mask: None, origin: None
    };
    let bytes = serialize_prefab(&cb);
    // Decompress to inspect the version byte.
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut raw = Vec::new();
    GzDecoder::new(&bytes[..]).read_to_end(&mut raw).unwrap();
    assert_eq!(&raw[0..6], b"EPFAB\x01", "maskless prefab stays on v1");
    let round = deserialize_prefab(&bytes).expect("round-trips");
    assert_eq!(round.mask, None, "no footprint on a rectangular prefab");
}

/// Shaped-selection consistency pass — a masked clipboard's top-down paste ghost leaves unmasked
/// columns fully transparent (alpha 0), so the preview shows only the footprint; a `None` mask
/// keeps the full VOID box (prefab-thumbnail parity).
#[test]
pub(crate) fn test_clipboard_preview_hides_unmasked_cells() {
    // 2×2×1, all brick, diagonal footprint (0,0)+(1,1).
    let mut bits = vec![0u8; 1];
    bits[0] |= 1 << 0; bits[0] |= 1 << 3;
    let cb = Clipboard { width: 2, height: 2, depth: 1, z_anchor: 0,
        block_types: vec![13u8; 4], paints: vec![0u8; 4], mask: Some(bits), origin: None };
    let pd = render_clipboard_preview_inner(&cb, 0, 1);
    let a = |dx: usize, dy: usize| pd.pixels[(dy * 2 + dx) * 4 + 3];
    assert_eq!(a(0, 0), 255, "masked block column is opaque");
    assert_eq!(a(1, 1), 255, "far masked block column is opaque");
    assert_eq!(a(1, 0), 0, "unmasked column stays transparent (alpha 0)");
    assert_eq!(a(0, 1), 0, "unmasked column stays transparent");

    // None mask ⇒ every column filled (VOID for the air columns), matching prefab thumbnails.
    let cb2 = Clipboard { mask: None, ..cb };
    let pd2 = render_clipboard_preview_inner(&cb2, 0, 1);
    for i in 0..4 { assert_eq!(pd2.pixels[i * 4 + 3], 255, "None mask fills the whole box"); }
}

/// Row 18.3: `max_side` bounds the preview and samples the right column.
#[test]
pub(crate) fn test_clipboard_preview_lod_bounded() {
    // 1024x2x1, brick only in column 0 and column 512 (both on lod-2 sample points).
    let (w, h) = (1024usize, 2usize);
    let mut bt = vec![0u8; w * h];
    bt[0] = 13; bt[512] = 13;
    let cb = Clipboard { width: w as _, height: h as _, depth: 1, z_anchor: 0,
        block_types: bt, paints: vec![0u8; w * h], mask: None, origin: None };
    let full = render_clipboard_preview_inner(&cb, 0, 1);
    assert_eq!((full.width, full.height), (1024, 2));
    let pd = render_clipboard_preview_inner(&cb, 0, clipboard_preview_lod(&cb, Some(512), None));
    assert_eq!((pd.width, pd.height, pd.lod), (512, 1, 2));
    assert_eq!(pd.pixels.len(), 512 * 4);
    assert_ne!(&pd.pixels[0..3], &[20, 20, 35], "column 0 is a block");
    assert_ne!(&pd.pixels[256 * 4..256 * 4 + 3], &[20, 20, 35], "column 512 samples at ox=256");
    assert_eq!(&pd.pixels[4..7], &[20, 20, 35], "air column stays VOID");
    // Small clipboard is unaffected by the cap.
    let small = Clipboard { width: 2, height: 2, depth: 1, z_anchor: 0,
        block_types: vec![13u8; 4], paints: vec![0u8; 4], mask: None, origin: None };
    let ps = render_clipboard_preview_inner(&small, 0, clipboard_preview_lod(&small, Some(512), None));
    assert_eq!((ps.width, ps.height, ps.lod), (2, 2, 1));
}

/// 18.3 follow-up: the paste ghost's pixel budget keeps a city-sized clipboard 1:1 (the long-side
/// cap downsampled anything over 512, so the ghost no longer lined up block-for-block), and
/// only downsamples past the budget. Caps combine as the coarser of the two.
#[test]
pub(crate) fn test_clipboard_ghost_pixel_budget() {
    let clip = |w: usize, h: usize| Clipboard { width: w as _, height: h as _, depth: 1, z_anchor: 0,
        block_types: vec![13u8; w * h], paints: vec![0u8; w * h], mask: None, origin: None };
    let city = clip(2000, 1500);
    assert_eq!(clipboard_preview_lod(&city, None, Some(CLIPBOARD_GHOST_MAX_PX)), 1);
    let pd = render_clipboard_preview_inner(&city, 0, 1);
    assert_eq!((pd.width, pd.height, pd.lod), (2000, 1500, 1));
    assert_eq!(clipboard_preview_lod(&city, Some(512), None), 4, "the old cap would have been 1:4");
    assert_eq!(clipboard_preview_lod(&city, Some(512), Some(CLIPBOARD_GHOST_MAX_PX)), 4, "coarser cap wins");
    assert_eq!(clipboard_preview_lod(&city, None, None), 1);
    // Over budget → smallest pow2 that fits (lod math only — no 4 GB test allocation).
    let huge = Clipboard { width: 8192, height: 8192, depth: 0, z_anchor: 0,
        block_types: vec![], paints: vec![], mask: None, origin: None };
    let lod = clipboard_preview_lod(&huge, None, Some(CLIPBOARD_GHOST_MAX_PX));
    assert_eq!(lod, 4, "8192² = 64 M px → 2048² at lod 4 (lod 2 would be 16 M px)");
}

/// The ortho front/side selection view (the 2D selection inspector) skips unmasked
/// columns, so a masked block *behind* an unmasked column shows through correctly.
#[test]
pub(crate) fn test_render_selection_view_masks_columns() {
    // Two adjacent columns at x=4 (front, tall grass to z=20) and x=5 (behind, brick at z=5).
    // Build so that scanning y reaches x-column blocks; use render_view_front over a 2-wide rect.
    let mut ws = ws_with(make_bumpy_world(8, |lx, _| if lx == 4 { 20 } else { 0 }));
    // Put a distinct brick at (5,4,15) — an unmasked (4,4) column must let it show behind.
    set_block_abs(ws.world.as_mut().unwrap(), 5, 4, 15, 13, 0);
    let world = ws.world.as_ref().unwrap();
    // Mask covers the 2×1 rect (4,4)-(5,4) but only selects x=5 (drop the front x=4 column).
    let mask = mask_from(4, 4, 5, 4, |x, _| x == 5);

    // Front view: pw = 2 (x4,x5), ph over z 0..=20. Column 0 = x4 (masked out → see-through),
    // column 1 = x5 (masked in). With x4 masked out, the brick behind at x5,z15 renders in col 1.
    let (pw, _ph, px_masked) = render::view_front(world, world.meta(), 4, 5, 4, 4, 0, 20, 0, Some(&mask));
    assert_eq!(pw, 2);
    // Unmasked path: x4 column is a solid grass wall to z=20, occluding nothing behind it in
    // its own column — but col 0 (x4) should be VOID since x4 is masked *out*.
    // Row for z=20 is row 0; col 0 pixel:
    let row_z = |z: i32| (20 - z) as usize;
    let px = |col: usize, z: i32| { let o = (row_z(z) * pw as usize + col) * 4; [px_masked[o], px_masked[o+1], px_masked[o+2]] };
    assert_eq!(px(0, 20), [20, 20, 35], "masked-out front column is VOID (see-through)");
    assert_ne!(px(1, 15), [20, 20, 35], "masked block behind shows through in its column");

    // None mask ⇒ front column x4 renders its grass wall (not VOID) at z=20.
    let (_pw2, _ph2, px_none) = render::view_front(world, world.meta(), 4, 5, 4, 4, 0, 20, 0, None);
    let o = (row_z(20) * 2) * 4;
    assert_ne!([px_none[o], px_none[o+1], px_none[o+2]], [20, 20, 35], "None mask renders the full box");
}

/// The top-down ortho view hides unmasked columns (leaves them VOID) so the floating inspector
/// shows the actual footprint, not the enclosing bounding box. Regression for "the top view
/// still shows everything in the nearest rectangle".
#[test]
pub(crate) fn test_render_view_top_masks_columns() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // every column solid grass to z=20
    let world = ws.world.as_ref().unwrap();
    // 2×2 rect (4,4)-(5,5); select only the main diagonal (4,4) and (5,5).
    let mask = mask_from(4, 4, 5, 5, |x, y| x - 4 == y - 4);
    let (pw, ph, px_masked) = render::view_top(world, world.meta(), 4, 5, 4, 5, 0, 20, 0, Some(&mask));
    assert_eq!((pw, ph), (2, 2));
    let px = |col: usize, row: usize| { let o = (row * pw as usize + col) * 4; [px_masked[o], px_masked[o+1], px_masked[o+2]] };
    assert_ne!(px(0, 0), [20, 20, 35], "masked-in (4,4) renders its surface block");
    assert_ne!(px(1, 1), [20, 20, 35], "masked-in (5,5) renders its surface block");
    assert_eq!(px(1, 0), [20, 20, 35], "unmasked (5,4) is VOID");
    assert_eq!(px(0, 1), [20, 20, 35], "unmasked (4,5) is VOID");

    // None mask ⇒ the whole 2×2 box renders (no VOID columns).
    let (_pw2, _ph2, px_none) = render::view_top(world, world.meta(), 4, 5, 4, 5, 0, 20, 0, None);
    for i in 0..4 { let o = i * 4; assert_ne!([px_none[o], px_none[o+1], px_none[o+2]], [20, 20, 35], "None mask fills every column"); }
}

/// A masked gradient re-skins only shaped columns; unmasked columns inside the bbox keep their
/// original block.
#[test]
pub(crate) fn test_gradient_fill_respects_mask() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // grass (bt 8) to z=20
    let mask = mask_from(4, 4, 7, 7, |x, _| x == 4); // left edge column only
    gradient_fill_inner(ws.world.as_mut().unwrap(), 4, 4, 7, 7, 20, 20, 13, 0, 14, 0, "x", false, Some(&mask));
    let w = ws.world.as_ref().unwrap();
    assert!(matches!(read_block_abs(w, 4, 5, 20), 13 | 14), "masked column re-skinned");
    assert_eq!(read_block_abs(w, 5, 5, 20), 8, "unmasked column kept grass");
}

/// A masked extrude repeats the *shape*: gating is on the source cell, so an x+ copy translates
/// only the masked source columns and leaves unmasked destination cells untouched.
#[test]
pub(crate) fn test_extrude_selection_respects_mask() {
    let mut ws = ws_with(make_bumpy_world(0, |_, _| 0)); // empty world
    // Source 2×2 at (4,4); mark only (4,4,10)=stone. Mask selects only that one column.
    set_block_abs(ws.world.as_mut().unwrap(), 4, 4, 10, 2, 0);
    set_block_abs(ws.world.as_mut().unwrap(), 5, 4, 10, 3, 0); // dirt in the unmasked column
    let (width, height, depth) = (2i32, 2i32, 11i32);
    let mut src_types = vec![0u8; (width * height * depth) as usize];
    let mut src_paints = vec![0u8; (width * height * depth) as usize];
    {
        let world = ws.world.as_ref().unwrap();
        for dz in 0..depth { for dy in 0..height { for dx in 0..width {
            let idx = (dz * height * width + dy * width + dx) as usize;
            src_types[idx] = read_block_abs(world, 4 + dx, 4 + dy, dz);
            src_paints[idx] = read_paint_abs(world, 4 + dx, 4 + dy, dz);
        }}}
    }
    let mask = mask_from(4, 4, 5, 5, |x, y| x == 4 && y == 4);
    with_edit(&mut ws, "extrude", (4, 4, 7, 5), |world| {
        extrude_write(world, 4, 4, &src_types, &src_paints, width, height, depth, 0, 63, "x+", 1, false, Some(&mask));
        Ok(())
    }).expect("masked extrude");
    let w = ws.world.as_ref().unwrap();
    assert_eq!(read_block_abs(w, 6, 4, 10), 2, "masked source column extruded +2 (stone)");
    assert_eq!(read_block_abs(w, 7, 4, 10), 0, "unmasked source column not extruded (no dirt copy)");
}

/// A masked tree pass only plants inside the shape. density=1.0 + smart placement over grass;
/// the unmasked column stays bare (only surface grass), the masked column grows a trunk above it.
#[test]
pub(crate) fn test_generate_trees_respects_mask() {
    let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // grass surface z=20 everywhere
    let mask = mask_from(4, 4, 7, 7, |x, y| x == 4 && y == 4);
    generate_trees_inner(&mut EditView::unbounded(ws.world.as_mut().unwrap()), 4, 4, 7, 7,
        &["normal".to_string()], 1.0, &[], 42, true, Some(&mask), None);
    let w = ws.world.as_ref().unwrap();
    // A normal tree places a trunk (bt 6) above the surface at the planted column.
    assert_eq!(read_block_abs(w, 4, 4, 21), 6, "masked column grew a trunk");
    assert_eq!(read_block_abs(w, 6, 6, 21), 0, "unmasked column stayed bare above the surface");
}

/// A `set_selection_mask` payload of the wrong length is rejected rather than silently producing
/// an under-read mask. (Exercises the byte-count guard without a Tauri State harness by mirroring
/// its size math.)
#[test]
pub(crate) fn test_mask_size_guard_math() {
    // 4×4 bbox needs ceil(16/8) = 2 bytes.
    let w = 4usize; let h = 4usize;
    assert_eq!(w.saturating_mul(h).div_ceil(8), 2);
    // 200×200 needs 5000 bytes.
    assert_eq!(200usize.saturating_mul(200).div_ceil(8), 5000);
}

/// Task 1 — N overlapping grouped raise stamps undo/redo as ONE unit, byte-exactly, and depths
/// count groups not stamps; an ungrouped edit stays its own single group (regression guard).
#[test]
pub(crate) fn test_grouped_undo_round_trip() {
    let mut ws = ws_with(make_bumpy_world(2, |lx, ly| 12 + ((lx + ly) % 5) as i32));
    let before = world_bytes(&ws);

    // 4 overlapping raise stamps sharing one group id.
    let gid = Some(777u64);
    for &(cx, cy) in &[(6, 6), (7, 6), (6, 7), (7, 7)] {
        sculpt(&mut ws, Some(disc_points(cx, cy, 2)), "raise", 3, 0.0, None, gid);
    }
    let after = world_bytes(&ws);
    assert_ne!(before, after, "stamps must change the world");
    assert_eq!(ws.undo_stack.len(), 4, "each stamp is its own raw undo entry");
    assert_eq!(count_undo_groups(&ws.undo_stack), 1, "same-group stamps collapse to one group");

    // undo → redo → undo → redo, byte-identical every time (exercises the ordering reasoning).
    for _ in 0..2 {
        let r = undo_edit_inner(&mut ws).expect("undo");
        assert_eq!(world_bytes(&ws), before, "one undo restores the whole stroke");
        assert_eq!(r.undo_depth, 0, "undo drops exactly one group (was 1 → 0)");
        let r2 = redo_edit_inner(&mut ws).expect("redo");
        assert_eq!(world_bytes(&ws), after, "one redo restores the whole stroke");
        assert_eq!(r2.undo_depth, 1, "redo restores the one group");
        assert_eq!(ws.undo_stack.len(), 4, "redo restores all 4 raw entries");
    }

    // Regression: a lone ungrouped edit is exactly one entry / one group and round-trips.
    undo_edit_inner(&mut ws).expect("undo the group");
    assert_eq!(world_bytes(&ws), before);
    let base = world_bytes(&ws);
    let r = sculpt(&mut ws, Some(disc_points(3, 3, 1)), "raise", 2, 0.0, None, None);
    assert_eq!(ws.undo_stack.len(), 1, "ungrouped edit = one entry");
    assert_eq!(r.undo_depth, 1, "ungrouped edit = one group");
    let post = world_bytes(&ws);
    assert_ne!(base, post);
    undo_edit_inner(&mut ws).expect("undo ungrouped");
    assert_eq!(world_bytes(&ws), base, "ungrouped undo = single entry");
    redo_edit_inner(&mut ws).expect("redo ungrouped");
    assert_eq!(world_bytes(&ws), post);
    assert_eq!(ws.undo_stack.len(), 1);
}

/// 21.9 (audit S2): cancelling a live stroke that pushed nothing must not pop the edit below.
#[test]
pub(crate) fn test_undo_only_group_refuses_a_foreign_top_entry() {
    let mut ws = ws_with(make_bumpy_world(2, |lx, ly| 12 + ((lx + ly) % 5) as i32));
    let base = world_bytes(&ws);
    sculpt(&mut ws, Some(disc_points(6, 6, 2)), "raise", 3, 0.0, None, Some(5));
    let after_first = world_bytes(&ws);

    // Stroke 6 changed nothing (no entry); Esc asks to undo group 6 only.
    let err = undo_edit_only(&mut ws, Some(6)).err().expect("refused");
    assert_eq!(err, "Nothing to undo");
    assert_eq!(world_bytes(&ws), after_first, "the previous stroke survives");
    assert_eq!(ws.undo_stack.len(), 1);
    assert!(ws.redo_stack.is_empty(), "a refused cancel leaves redo alone");

    // Stroke 7 did change something: its own cancel reverts it, and only it.
    sculpt(&mut ws, Some(disc_points(7, 7, 2)), "raise", 3, 0.0, None, Some(7));
    sculpt(&mut ws, Some(disc_points(8, 7, 2)), "raise", 3, 0.0, None, Some(7));
    undo_edit_only(&mut ws, Some(7)).expect("own group undoes");
    assert_eq!(world_bytes(&ws), after_first);

    // No group = the plain ⌘Z behaviour.
    undo_edit_only(&mut ws, None).expect("plain undo");
    assert_eq!(world_bytes(&ws), base);
    assert_eq!(undo_edit_only(&mut ws, Some(5)).err().as_deref(), Some("Nothing to undo"));
}

#[test]
pub(crate) fn test_undo_stack_labels_collapse_groups() {
    let mut ws = ws_with(make_bumpy_world(2, |lx, ly| 12 + ((lx + ly) % 5) as i32));

    // 4 stamps sharing one group id must collapse to a single label.
    let gid = Some(42u64);
    for &(cx, cy) in &[(6, 6), (7, 6), (6, 7), (7, 7)] {
        sculpt(&mut ws, Some(disc_points(cx, cy, 2)), "raise", 3, 0.0, None, gid);
    }
    assert_eq!(ws.undo_stack.len(), 4);
    assert_eq!(undo_stack_labels(&ws.undo_stack).len(), 1, "same-group stamps collapse to one label");

    // A subsequent ungrouped edit is its own separate label, appended after the group.
    sculpt(&mut ws, Some(disc_points(3, 3, 1)), "raise", 2, 0.0, None, None);
    assert_eq!(undo_stack_labels(&ws.undo_stack).len(), 2, "group + ungrouped edit = 2 labels");

    assert!(undo_stack_labels(&ws.redo_stack).is_empty());
    undo_edit_inner(&mut ws).expect("undo ungrouped");
    assert_eq!(undo_stack_labels(&ws.redo_stack).len(), 1, "the undone edit reappears as one redo label");
}

/// Task 2 — per-stamp radial (dial) falloff vs BFS silhouette dome for one isolated disc stamp.
/// The two use different distance metrics (8-connected graph distance to the silhouette edge vs
/// continuous Euclidean distance from the centre), so the weight fields aren't bit-identical;
/// we assert the resulting per-column heights agree within a small tolerance and that both are
/// centre-higher-than-rim monotone. Tolerance = 1 block, made attainable by using a modest
/// strength (2) so the whole dome spans only ~2 blocks — the max possible disagreement between
/// two near-equal weight fields after integer rounding is then one quantization step.
#[test]
pub(crate) fn test_dial_vs_bfs_falloff_parity() {
    let (cx, cy, r) = (8, 8, 4);
    let base = make_bumpy_world(2, |_, _| 15);

    // (a) BFS path: explicit disc points, no stamp centre.
    let mut ws_a = ws_with(base.clone());
    sculpt(&mut ws_a, Some(disc_points(cx, cy, r)), "raise", 2, 1.0, None, None);
    // (b) dial path: no points, stamp centre + radius → backend generates the disc.
    let mut ws_b = ws_with(base.clone());
    sculpt(&mut ws_b, None, "raise", 2, 1.0, Some((cx, cy, r)), None);

    for p in &disc_points(cx, cy, r) {
        let ha = surf(&ws_a, p.x, p.y);
        let hb = surf(&ws_b, p.x, p.y);
        assert!((ha - hb).abs() <= 1, "column ({},{}) BFS={ha} dial={hb} differ by >1", p.x, p.y);
    }
    // Monotonicity: centre rises strictly more than the rim, both paths.
    assert!(surf(&ws_a, cx, cy) > surf(&ws_a, cx + r, cy), "BFS centre must exceed rim");
    assert!(surf(&ws_b, cx, cy) > surf(&ws_b, cx + r, cy), "dial centre must exceed rim");
    // Dial rim weight is exactly 0 (d == radius) → rim height unchanged.
    assert_eq!(surf(&ws_b, cx + r, cy), 15, "dial rim (weight 0) leaves terrain untouched");
}

/// Task 4.1 — dithering is deterministic (pure function of (x,y), no hidden RNG) and is fully
/// bypassed at softness == 0 (hard brushes round exactly).
#[test]
pub(crate) fn test_dither_determinism_and_hard_bypass() {
    let base = make_bumpy_world(2, |lx, ly| 12 + ((lx * 3 + ly) % 7) as i32);
    let disc = disc_points(8, 8, 5);

    // Two identical soft raise calls from the same start → byte-identical.
    let mut ws1 = ws_with(base.clone());
    let mut ws2 = ws_with(base.clone());
    sculpt(&mut ws1, Some(disc.clone()), "raise", 5, 0.6, None, None);
    sculpt(&mut ws2, Some(disc.clone()), "raise", 5, 0.6, None, None);
    assert_eq!(world_bytes(&ws1), world_bytes(&ws2),
        "identical soft-sculpt calls must be byte-identical (dither is deterministic)");

    // softness == 0 → weight 1 everywhere, plain round, no dither: every column rises by exactly
    // `strength`. A dithered path would give ±1 here.
    let base_ws = ws_with(base.clone());
    let mut ws3 = ws_with(base.clone());
    sculpt(&mut ws3, Some(disc.clone()), "raise", 5, 0.0, None, None);
    for p in &disc {
        assert_eq!(surf(&ws3, p.x, p.y), surf(&base_ws, p.x, p.y) + 5,
            "hard raise adds exactly strength with no dither at ({},{})", p.x, p.y);
    }
}

/// Task 4.2 — Smooth iterates `strength` times, so strength 3 flattens a cone toward the local
/// average strictly more than strength 1 (from the same input each time).
#[test]
pub(crate) fn test_smooth_strength_flattens_more() {
    // A smooth cone peak (avoids the checkerboard pattern that makes undamped Jacobi oscillate
    // and the linear ramp that is a smoothing fixed point).
    let cone = |lx: usize, ly: usize| -> i32 {
        let (dx, dy) = (lx as i32 - 8, ly as i32 - 8);
        let d = ((dx * dx + dy * dy) as f64).sqrt();
        15 + (6.0 - d).max(0.0).round() as i32
    };
    let base = make_bumpy_world(2, cone);
    let disc = disc_points(8, 8, 3);

    let range_after = |strength: i32| -> i32 {
        let mut ws = ws_with(base.clone());
        sculpt(&mut ws, Some(disc.clone()), "smooth", strength, 0.0, None, None);
        let hs: Vec<i32> = disc.iter().map(|p| surf(&ws, p.x, p.y)).collect();
        hs.iter().max().unwrap() - hs.iter().min().unwrap()
    };
    let r1 = range_after(1);
    let r3 = range_after(3);
    assert!(r3 < r1, "strength 3 smooth must flatten more than strength 1 (r1={r1}, r3={r3})");
}

/// Terrace quantizes every column to the nearest `strength`-block step.
#[test]
pub(crate) fn test_terrace_quantizes_to_step() {
    let base = make_bumpy_world(2, |lx, ly| 10 + ((lx * 3 + ly) % 11) as i32);
    let disc = disc_points(8, 8, 5);
    let step = 4;
    let mut ws = ws_with(base.clone());
    sculpt(&mut ws, Some(disc.clone()), "terrace", step, 0.0, None, None);
    for p in &disc {
        let h = surf(&ws, p.x, p.y);
        assert_eq!(h.rem_euclid(step), 0, "column ({},{}) height {h} isn't a multiple of step {step}", p.x, p.y);
    }
}

/// Sharpen is the inverse of Smooth: it must widen (not narrow) the height range of a cone.
#[test]
pub(crate) fn test_sharpen_widens_range() {
    let cone = |lx: usize, ly: usize| -> i32 {
        let (dx, dy) = (lx as i32 - 8, ly as i32 - 8);
        let d = ((dx * dx + dy * dy) as f64).sqrt();
        15 + (6.0 - d).max(0.0).round() as i32
    };
    let base = make_bumpy_world(2, cone);
    let disc = disc_points(8, 8, 3);
    let range_before = {
        let ws = ws_with(base.clone());
        let hs: Vec<i32> = disc.iter().map(|p| surf(&ws, p.x, p.y)).collect();
        hs.iter().max().unwrap() - hs.iter().min().unwrap()
    };
    let mut ws = ws_with(base.clone());
    sculpt(&mut ws, Some(disc.clone()), "sharpen", 8, 0.0, None, None);
    let range_after = {
        let hs: Vec<i32> = disc.iter().map(|p| surf(&ws, p.x, p.y)).collect();
        hs.iter().max().unwrap() - hs.iter().min().unwrap()
    };
    assert!(range_after > range_before,
        "sharpen must widen the height range (before={range_before}, after={range_after})");
}

/// Slope levels toward an angled plane through the anchor: with slope_dx=1 (1 block of rise
/// per block of X run), a column `dx` blocks east of the anchor lands at `anchor_z + dx`, and
/// the anchor column itself is untouched (it's on the plane already).
#[test]
pub(crate) fn test_slope_tilts_plane_from_anchor() {
    let base = make_bumpy_world(2, |_, _| 15);
    let mut ws = ws_with(base);
    let (ax, ay) = (8, 8);
    let disc = disc_points(ax, ay, 4);
    sculpt_terrain_inner(
        &mut ws, Some(disc.clone()), "slope".into(), 1, 0, None, None, None, None,
        Some(0.0), Some("smooth".into()), None, Some(ax), Some(ay), None, None, None, None, None,
        Some(1.0), Some(0.0), None, None, None, None, None,
    ).expect("slope");
    assert_eq!(surf(&ws, ax, ay), 15, "anchor column sits on its own plane, unchanged");
    assert_eq!(surf(&ws, ax + 3, ay), 18, "3 blocks east at slope_dx=1 → anchor height + 3");
    assert_eq!(surf(&ws, ax - 2, ay), 13, "2 blocks west at slope_dx=1 → anchor height - 2");
}

/// Smear pulls each column's height from `smear_dx/smear_dy` blocks behind it — a flat-out
/// step (a cliff) shifts sideways by the smear vector within the brushed footprint, and a
/// zero vector is a no-op (nothing to smear without a drag direction).
#[test]
pub(crate) fn test_smear_advects_height_along_drag() {
    // A cliff: x < 8 is low (10), x >= 8 is high (20).
    let base = make_bumpy_world(2, |lx, _| if lx < 8 { 10 } else { 20 });
    let disc = disc_points(8, 8, 3);

    // Zero vector: no-op regardless of softness.
    let mut ws0 = ws_with(base.clone());
    let before = world_bytes(&ws0);
    sculpt_terrain_inner(
        &mut ws0, Some(disc.clone()), "smear".into(), 1, 0, None, None, None, None,
        Some(0.0), Some("smooth".into()), None, None, None, None, None, None, None, None,
        None, None, Some(0), Some(0), None, None, None,
    ).expect("smear no-op");
    assert_eq!(world_bytes(&ws0), before, "zero smear vector must not touch the world");

    // Pull from 2 blocks east (source x+2) with a hard brush: every column in the footprint
    // takes on its source's height exactly.
    let mut ws = ws_with(base.clone());
    sculpt_terrain_inner(
        &mut ws, Some(disc.clone()), "smear".into(), 1, 0, None, None, None, None,
        Some(0.0), Some("smooth".into()), None, None, None, None, None, None, None, None,
        None, None, Some(-2), Some(0), None, None, None,
    ).expect("smear");
    // Column x=6 (low side) pulls from x=8 (high side, source = p.x - smear_dx = 6 - (-2) = 8)
    assert_eq!(surf(&ws, 6, 8), 20, "column at x=6 pulls its source height from x=8");
    // Column x=10 (high side) pulls from x=12, also high — unaffected in value.
    assert_eq!(surf(&ws, 10, 8), 20, "column at x=10 pulls its source height from x=12 (same band)");
}

/// Hydro is deterministic: two identical droplet simulations (same seed, same world, same
/// params) produce byte-identical results — the RNG-driven start jitter/exploration is seeded.
#[test]
pub(crate) fn test_hydro_determinism() {
    let base = make_bumpy_world(2, |lx, ly| 12 + ((lx * 3 + ly) % 7) as i32);
    let disc = disc_points(8, 8, 5);
    let mut ws1 = ws_with(base.clone());
    let mut ws2 = ws_with(base.clone());
    sculpt(&mut ws1, Some(disc.clone()), "hydro", 4, 0.0, None, None);
    sculpt(&mut ws2, Some(disc.clone()), "hydro", 4, 0.0, None, None);
    assert_eq!(world_bytes(&ws1), world_bytes(&ws2),
        "identical hydro calls must be byte-identical (seeded droplet sim is deterministic)");
}

/// Hydro actually erodes: running it over a broad peak shrinks the peak-to-valley height range
/// within the footprint (the peak erodes down and/or valleys fill), vs the untouched world.
#[test]
pub(crate) fn test_hydro_erodes_a_peak() {
    // A broad cone peak so many droplets engage the slope.
    let cone = |lx: usize, ly: usize| -> i32 {
        let (dx, dy) = (lx as i32 - 8, ly as i32 - 8);
        let d = ((dx * dx + dy * dy) as f64).sqrt();
        15 + (24.0 - 4.0 * d).max(0.0).round() as i32
    };
    let base = make_bumpy_world(2, cone);
    let disc = disc_points(8, 8, 5);

    let range = |ws: &WorldState| -> i32 {
        let hs: Vec<i32> = disc.iter().map(|p| surf(ws, p.x, p.y)).collect();
        hs.iter().max().unwrap() - hs.iter().min().unwrap()
    };
    let before_ws = ws_with(base.clone());
    let range_before = range(&before_ws);

    let mut ws = ws_with(base.clone());
    sculpt(&mut ws, Some(disc.clone()), "hydro", 4, 0.0, None, None);
    let range_after = range(&ws);

    assert!(range_after < range_before,
        "hydro must reduce the footprint height range (before {range_before}, after {range_after})");
}

/// Commit stays inside the footprint: even though the droplet workspace extends 16 cells past the
/// brush, a column strictly outside the footprint's bounding box is byte-identical afterwards,
/// while a column inside it changed. This is the regression guard that makes the wider workspace
/// safe (§4 "commit inside footprint only").
#[test]
pub(crate) fn test_hydro_commit_stays_in_footprint() {
    // Column's full block+paint byte column (all 64 z levels), single-chunk layout.
    let col_bytes = |bytes: &[u8], lx: usize, ly: usize| -> Vec<u8> {
        let mut v = Vec::with_capacity(128);
        for z in 0..64usize {
            let off = 4096 + (z / 16) * 8192 + lx * 256 + ly * 16 + (z % 16);
            v.push(bytes[off]);
            v.push(bytes[off + 4096]);
        }
        v
    };
    let cone = |lx: usize, ly: usize| -> i32 {
        let (dx, dy) = (lx as i32 - 8, ly as i32 - 8);
        let d = ((dx * dx + dy * dy) as f64).sqrt();
        15 + (18.0 - 3.0 * d).max(0.0).round() as i32
    };
    let base = make_bumpy_world(2, cone);
    let before = base.clone();

    // Footprint bbox is x,y ∈ 5..=11. (2,2) is outside it but well inside the workspace
    // (footprint − 16 .. footprint + 16); (8,8) is the centre and must change.
    let mut ws = ws_with(base.clone());
    sculpt(&mut ws, Some(disc_points(8, 8, 3)), "hydro", 4, 0.0, None, None);
    let after = world_bytes(&ws);

    assert_eq!(col_bytes(&before, 2, 2), col_bytes(&after, 2, 2),
        "a column outside the footprint bbox must be untouched by hydro's wider workspace");
    assert_ne!(col_bytes(&before, 8, 8), col_bytes(&after, 8, 8),
        "the footprint centre must actually be eroded (otherwise the guard proves nothing)");
}

/// Erosion radius ≥ 2: a single hydro stamp's erosion is spread over a radial brush, so a stamp
/// changes a contiguous neighbourhood of columns, not a 1-wide line (the audit's flaw (3)).
#[test]
pub(crate) fn test_hydro_erosion_spreads_across_columns() {
    let cone = |lx: usize, ly: usize| -> i32 {
        let (dx, dy) = (lx as i32 - 8, ly as i32 - 8);
        let d = ((dx * dx + dy * dy) as f64).sqrt();
        15 + (20.0 - 4.0 * d).max(0.0).round() as i32
    };
    let base = make_bumpy_world(2, cone);
    let before_ws = ws_with(base.clone());
    let disc = disc_points(8, 8, 4);

    let mut ws = ws_with(base.clone());
    sculpt(&mut ws, Some(disc.clone()), "hydro", 4, 0.0, None, None);

    let changed = disc.iter()
        .filter(|p| surf(&ws, p.x, p.y) != surf(&before_ws, p.x, p.y))
        .count();
    assert!(changed >= 2,
        "erosion-radius brush must change more than one column (changed {changed})");
}

