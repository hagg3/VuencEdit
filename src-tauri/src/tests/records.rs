use super::*;

// ── 27.8a-1: record lifecycle — op log, air rule, undo/redo, `EditResult.records` ─────────────
//
// the Stage 27 build plan's §1.5 (a–g) plus the sculpt path, grouped undo, the undo
// budget and the funnel grep guard. The world is `trailer_world()`: a 2×2-chunk 64z grid, solid
// (block 8) on z 1..=20 everywhere, with the one-sign quarry trailer (its anchor is in air).

fn rec_ws() -> WorldState {
    ws_with(trailer_world())
}

fn pos(ws: &WorldState, x: i32, y: i32, z: i32) -> trailer::Pos {
    ws.world.as_ref().unwrap().local_to_record(x, y, z)
}

fn tr(ws: &WorldState) -> &Trailer {
    &ws.world.as_ref().unwrap().trailer
}

fn tail(ws: &WorldState) -> Vec<u8> {
    ws.world.as_ref().unwrap().trailer_bytes()
}

fn sign_texts(ws: &WorldState) -> Vec<String> {
    tr(ws).signs().iter().map(|s| String::from_utf8_lossy(s.text()).into_owned()).collect()
}

/// Set up records outside any edit (test setup only: production goes through `EditView`).
fn put_sign(ws: &mut WorldState, x: i32, y: i32, z: i32, text: &str) {
    let p = pos(ws, x, y, z);
    ws.world.as_mut().unwrap().trailer.add_sign(p, 3, 2, 0, text.as_bytes()).expect("add sign");
}

fn put_cmd(ws: &mut WorldState, x: i32, y: i32, z: i32) {
    let p = pos(ws, x, y, z);
    ws.world.as_mut().unwrap().trailer.add_cmd(p, b"say hi").expect("add cmd");
}

fn delete(ws: &mut WorldState, x1: i32, y1: i32, x2: i32, y2: i32, z1: i32, z2: i32) -> EditResult {
    with_edit(ws, "delete", (x1, y1, x2, y2), |w| {
        delete_blocks_inner(w, x1, y1, x2, y2, z1, z2, None);
        Ok(())
    })
    .expect("delete")
}

/// a. The air rule is exact: the sign on a block that went non-air → air drops, a sign already
/// orphaned on an air cell in the same written band stays, and so does every record elsewhere.
#[test]
pub(crate) fn test_air_rule_drops_only_cells_that_went_air() {
    let mut ws = rec_ws();
    assert_eq!(sign_texts(&ws), ["test"], "the quarry sign");
    put_sign(&mut ws, 5, 5, 20, "on A"); // A: solid (z 20 is the top block)
    put_sign(&mut ws, 6, 5, 25, "orphan B"); // B: air, same chunk and band (z 16..31) as A
    put_sign(&mut ws, 20, 20, 20, "far"); // another chunk, untouched
    put_cmd(&mut ws, 5, 5, 20);
    let seq = ws.dirty.records_seq;

    let r = delete(&mut ws, 5, 5, 6, 5, 18, 25);
    assert_eq!(sign_texts(&ws), ["test", "orphan B", "far"]);
    assert!(tr(&ws).cmds().is_empty(), "A's command block went with it");
    assert_eq!((r.records.dropped_signs, r.records.dropped_cmds), (1, 1));
    assert_eq!(r.records.seq, seq + 1, "one bump per edit");
    assert_eq!(ws.dirty.records_seq, r.records.seq);
    assert!(ws.dirty.trailer_load && ws.dirty.trailer_disk && ws.dirty.trailer_journal);

    // Deleting over the now-air cells again changes nothing: no drop, no bump.
    let r = delete(&mut ws, 5, 5, 6, 5, 18, 25);
    assert_eq!((r.records.dropped_signs, r.records.dropped_cmds, r.records.seq), (0, 0, seq + 1));
    assert_eq!(sign_texts(&ws), ["test", "orphan B", "far"]);
}

/// b + g. Edit + undo ⇒ the trailer encodes byte-identical to before, records back at their
/// indices (two drops on non-adjacent indices, and a command block); redo ⇒ the post-edit encode.
#[test]
pub(crate) fn test_air_rule_undo_is_byte_identical_and_redo_reproduces() {
    let mut ws = rec_ws();
    put_sign(&mut ws, 2, 2, 20, "drop 1");
    put_sign(&mut ws, 9, 9, 20, "keep");
    put_sign(&mut ws, 3, 2, 20, "drop 3");
    put_sign(&mut ws, 30, 30, 20, "keep far");
    put_cmd(&mut ws, 30, 2, 20);
    put_cmd(&mut ws, 2, 3, 20);
    put_cmd(&mut ws, 30, 3, 20);
    let before = tail(&ws);

    let r = delete(&mut ws, 0, 0, 4, 4, 0, 63);
    assert_eq!((r.records.dropped_signs, r.records.dropped_cmds), (2, 1));
    assert_eq!(sign_texts(&ws), ["test", "keep", "keep far"]);
    let after = tail(&ws);
    assert_ne!(after, before);

    let seq = ws.dirty.records_seq;
    let u = undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(tail(&ws), before, "T6: edit + undo is byte-identical");
    assert_eq!(sign_texts(&ws), ["test", "drop 1", "keep", "drop 3", "keep far"], "same indices");
    assert_eq!(tr(&ws).find_cmd(pos(&ws, 2, 3, 20)), Some(1), "the command block is back at its index");
    assert_eq!((u.records.seq, u.records.dropped_signs, u.records.dropped_cmds), (seq + 1, 0, 0), "undo never toasts");

    let r2 = redo_edit_inner(&mut ws).expect("redo");
    assert_eq!(tail(&ws), after, "g: redo reproduces the post-edit encode");
    assert_eq!((r2.records.dropped_signs, r2.records.seq), (0, seq + 2));
    undo_edit_inner(&mut ws).expect("undo again");
    assert_eq!(tail(&ws), before);
}

/// A delete over a big sign field: one `Dropped` op (one reindex), exact undo.
#[test]
pub(crate) fn test_air_rule_bulk_drop_round_trips() {
    let mut ws = rec_ws();
    for x in 0..32 { for y in 0..32 { for z in [8, 14, 20] {
        put_sign(&mut ws, x, y, z, &format!("{x},{y},{z}"));
    } } }
    let before = tail(&ws);
    let r = delete(&mut ws, 0, 0, 31, 31, 0, 63);
    assert_eq!(r.records.dropped_signs, 32 * 32 * 3);
    assert_eq!(sign_texts(&ws), ["test"]);
    let entry = ws.undo_stack.back().unwrap();
    assert!(matches!(entry.records.as_slice(), [RecordOp::Dropped { .. }]), "one bulk op");
    assert!(entry.bytes >= 32 * 32 * 3 * UNDO_SIGN_BYTES, "records are priced into the undo budget");
    undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(tail(&ws), before);
}

/// c. A closure that adds a record and then fails (or panics, or trips the pre-image limit)
/// leaves the trailer exactly as it was, `is_touched()` included, with no dirty mark and no bump.
#[test]
pub(crate) fn test_failed_edit_restores_the_trailer_exactly() {
    let mut ws = rec_ws();
    let before = tail(&ws);
    assert!(!tr(&ws).is_touched());
    let (seq, rseq) = (ws.dirty.seq, ws.dirty.records_seq);
    let p = pos(&ws, 5, 5, 20);

    let err = with_edit(&mut ws, "sign", (5, 5, 5, 5), |w| {
        w.add_sign(p, 3, 2, 0, b"x").expect("add");
        set_block_abs(w, 5, 5, 21, 9, 0);
        Err("later step failed".into())
    });
    assert!(err.is_err());
    let check = |ws: &WorldState, what: &str| {
        assert_eq!(tail(ws), before, "{what}: trailer bytes");
        assert!(!tr(ws).is_touched(), "{what}: is_touched restored");
        assert_eq!(tr(ws).signs().len(), 1, "{what}");
        assert_eq!((ws.dirty.seq, ws.dirty.records_seq), (seq, rseq), "{what}: nothing marked");
        assert!(ws.undo_stack.is_empty(), "{what}");
    };
    check(&ws, "Err");

    let err = with_edit(&mut ws, "sign", (5, 5, 5, 5), |w| {
        w.add_cmd(p, b"").expect("add");
        panic!("injected");
    });
    assert!(err.is_err());
    check(&ws, "panic");

    ws.undo_budget = 1; // the pre-image limit trips on the first band
    let err = with_edit(&mut ws, "sign", (5, 5, 5, 5), |w| {
        w.add_sign(p, 3, 2, 0, b"x").expect("add");
        set_block_abs(w, 5, 5, 21, 9, 0);
        Ok(())
    });
    assert!(err.is_err());
    check(&ws, "tripped");
}

/// d. A text-only edit (no block bytes) pushes an undo entry, marks the trailer dirty, bumps
/// `records_seq`, and the next save writes the new trailer. Undo puts the old text back.
#[test]
pub(crate) fn test_text_only_edit_is_undoable_and_saved() {
    let mut ws = rec_ws();
    let before = tail(&ws);
    let rseq = ws.dirty.records_seq;
    let r = with_edit(&mut ws, "Edit sign", (0, 0, 0, 0), |w| {
        w.set_sign_text(0, b"renamed").map_err(|e| e.to_string())?;
        w.set_sign_colour(0, 7).map_err(|e| e.to_string())
    })
    .expect("text edit");
    assert_eq!(r.records.seq, rseq + 1);
    assert_eq!((r.records.dropped_signs, r.records.dropped_cmds), (0, 0), "explicit edits don't toast");
    assert_eq!(r.undo_depth, 1, "a byte-less edit still gets an undo entry");
    assert!(ws.dirty.since_disk.is_empty(), "no chunk changed");
    assert!(ws.dirty.trailer_disk && ws.dirty.trailer_load && ws.dirty.trailer_journal && ws.dirty.trailer_base);
    assert_eq!(sign_texts(&ws), ["renamed"]);

    let dir = stage4_dir("records_text_edit");
    let out = dir.join("out.eden");
    save_world_inner(ws.world.as_ref().unwrap(), out.to_str().unwrap(), false).expect("save");
    let saved = reload(&out);
    assert_eq!(saved.trailer.signs()[0].text(), b"renamed");
    assert_eq!(saved.trailer.signs()[0].b, 7);
    assert_eq!(saved.trailer_bytes(), tail(&ws), "the save wrote the edited trailer");
    let _ = fs::remove_dir_all(&dir);

    undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(tail(&ws), before);
    assert_eq!(ws.dirty.records_seq, rseq + 2);
    redo_edit_inner(&mut ws).expect("redo");
    assert_eq!(sign_texts(&ws), ["renamed"]);
}

/// e. An opaque trailer: deleting the blocks under where records would be just edits blocks
/// (T8: never refused), the trailer bytes are untouched, nothing is marked, the record writers
/// refuse.
#[test]
pub(crate) fn test_opaque_trailer_never_blocks_an_edit() {
    let mut b = trailer_world();
    b.extend_from_slice(&[1, 2, 3]); // a ragged row: unreadable, kept verbatim
    let mut ws = ws_with(b);
    assert!(!tr(&ws).parsed());
    let before = tail(&ws);
    let rseq = ws.dirty.records_seq;
    let r = delete(&mut ws, 0, 0, 31, 31, 0, 63);
    assert_eq!(r.records, RecordChange { seq: rseq, dropped_signs: 0, dropped_cmds: 0 });
    assert_eq!(tail(&ws), before);
    assert!(!ws.dirty.trailer_load);
    let p = pos(&ws, 5, 5, 0);
    let refused = with_edit(&mut ws, "sign", (5, 5, 5, 5), |w| match w.add_sign(p, 3, 2, 0, b"x") {
        Err(trailer::Refusal::Opaque) => Ok(()),
        other => Err(format!("{other:?}")),
    });
    assert!(refused.is_ok(), "{:?}", refused.err());
    assert_eq!(tail(&ws), before);
    assert_eq!(ws.dirty.records_seq, rseq);
}

/// f. T7: replacing a command block's steel (74) with another non-air block keeps its `CMB1`;
/// replacing it with air drops it.
#[test]
pub(crate) fn test_cmd_survives_a_retype_but_not_air() {
    let mut ws = rec_ws();
    with_edit(&mut ws, "steel", (5, 5, 5, 5), |w| { set_block_abs(w, 5, 5, 20, 74, 0); Ok(()) }).expect("steel");
    put_cmd(&mut ws, 5, 5, 20);
    let r = with_edit(&mut ws, "stone", (5, 5, 5, 5), |w| { set_block_abs(w, 5, 5, 20, 2, 0); Ok(()) }).expect("stone");
    assert_eq!(r.records.dropped_cmds, 0);
    assert_eq!(tr(&ws).cmds().len(), 1, "T7: a retype keeps the record");
    let r = with_edit(&mut ws, "air", (5, 5, 5, 5), |w| { set_block_abs(w, 5, 5, 20, 0, 0); Ok(()) }).expect("air");
    assert_eq!(r.records.dropped_cmds, 1);
    assert!(tr(&ws).cmds().is_empty());
}

/// The sculpt path (`finish_edit` from a path other than `with_edit_inner`) gets the air rule too:
/// lowering terrain out from under a sign drops it, and undo brings it back.
#[test]
pub(crate) fn test_sculpt_lowering_drops_signs_and_undoes() {
    let mut ws = rec_ws();
    put_sign(&mut ws, 8, 8, 20, "summit");
    let before = tail(&ws);
    let r = sculpt(&mut ws, None, "lower", 4, 0.0, Some((8, 8, 3)), None);
    assert!(surf(&ws, 8, 8) < 20, "the stamp lowered the column");
    assert_eq!(r.records.dropped_signs, 1);
    assert_eq!(sign_texts(&ws), ["test"]);
    undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(tail(&ws), before);
}

/// Grouped edits (a sculpt stroke): each stamp's drops sit on its own entry; one undo of the
/// group restores all of them, in order.
#[test]
pub(crate) fn test_grouped_edits_undo_their_records_together() {
    let mut ws = rec_ws();
    put_sign(&mut ws, 2, 2, 20, "first");
    put_sign(&mut ws, 20, 20, 20, "second");
    let before = tail(&ws);
    for (x, y) in [(2, 2), (20, 20)] {
        with_edit_grouped(&mut ws, "stroke", (x, y, x, y), Some(7), |w| { set_block_abs(w, x, y, 20, 0, 0); Ok(()) })
            .expect("stamp");
    }
    assert_eq!(sign_texts(&ws), ["test"]);
    assert_eq!(ws.undo_stack.len(), 2);
    undo_edit_inner(&mut ws).expect("undo the stroke");
    assert!(ws.undo_stack.is_empty());
    assert_eq!(tail(&ws), before);
    redo_edit_inner(&mut ws).expect("redo the stroke");
    assert_eq!(sign_texts(&ws), ["test"]);
}

/// The explicit writers (27.8b's tools will call these): add / edit / remove a sign and a command
/// block over several edits; undoing them all is byte-identical, redoing them all reproduces.
#[test]
pub(crate) fn test_explicit_record_writers_round_trip() {
    let mut ws = rec_ws();
    let before = tail(&ws);
    let (a, b) = (pos(&ws, 4, 4, 20), pos(&ws, 6, 6, 20));
    let step = |ws: &mut WorldState, f: &dyn Fn(&mut EditView) -> Result<(), trailer::Refusal>| {
        with_edit(ws, "records", (0, 0, 0, 0), |w| f(w).map_err(|e| e.to_string())).expect("edit")
    };
    step(&mut ws, &|w| w.add_sign(a, 3, 2, 0, b"new").map(drop));
    step(&mut ws, &|w| w.add_cmd(b, b"say a").map(drop));
    step(&mut ws, &|w| w.set_cmd_script(0, b"say b"));
    step(&mut ws, &|w| w.remove_sign(0).map(drop)); // the quarry sign: index 1 moves to 0
    let r = step(&mut ws, &|w| w.remove_cmd(0).map(drop));
    assert_eq!(r.records.dropped_signs + r.records.dropped_cmds, 0, "explicit removals don't toast");
    assert_eq!(sign_texts(&ws), ["new"]);
    assert!(tr(&ws).cmds().is_empty());
    let after = tail(&ws);
    for _ in 0..5 { undo_edit_inner(&mut ws).expect("undo"); }
    assert_eq!(tail(&ws), before);
    for _ in 0..5 { redo_edit_inner(&mut ws).expect("redo"); }
    assert_eq!(tail(&ws), after);
    // A refused write changes nothing and logs nothing: no entry for a closure that only failed.
    let depth = ws.undo_stack.len();
    let r = with_edit(&mut ws, "dup", (0, 0, 0, 0), |w| {
        assert_eq!(w.add_sign(a, 3, 2, 0, b"again").unwrap_err(), trailer::Refusal::Exists);
        Ok(())
    }).expect("edit");
    assert_eq!((ws.undo_stack.len(), r.records.seq), (depth, ws.dirty.records_seq));
    assert_eq!(tail(&ws), after);
}

/// `get_records`' baseline `seq` is the one `EditResult.records.seq` moves from.
#[test]
pub(crate) fn test_records_seq_survives_a_world_swap() {
    let mut ws = rec_ws();
    put_sign(&mut ws, 5, 5, 20, "x");
    let r = delete(&mut ws, 5, 5, 5, 5, 20, 20);
    let seq = r.records.seq;
    assert!(seq > 0);
    ws.dirty.clear_all();
    assert_eq!(ws.dirty.records_seq, seq, "never reset: a new world's first refetch can't be skipped");
}

/// The funnel guard: outside the record-writer block, no non-test app code mutates the trailer
/// model. A write that bypasses `EditView` / undo would change what a save writes with no undo
/// entry, no dirty mark and no `records.seq` bump.
#[test]
pub(crate) fn test_trailer_mutators_stay_in_the_funnel() {
    const BEGIN: &str = "// ── Record lifecycle (27.8a-1)";
    const END: &str = "// ── end record writers";
    let mutators = ["add_sign(", "add_cmd(", "insert_sign_at(", "insert_cmd_at(", "remove_sign(", "remove_cmd(",
        "replace_sign(", "replace_cmd(", "set_sign_text(", "set_sign_colour(", "set_cmd_script(", "remove_many(",
        "insert_many(", "mark_saved("];
    for (name, src) in [("lib.rs", include_str!("../lib.rs")), ("emod.rs", include_str!("../emod.rs")),
                        ("signs.rs", include_str!("../signs.rs")), ("journal.rs", include_str!("../journal.rs"))] {
        // Production code only: each file's tests live in its `#[cfg(test)] mod tests`, last.
        let prod = src.split("#[cfg(test)]\nmod tests").next().unwrap();
        let (outside, inside) = match (prod.find(BEGIN), prod.find(END)) {
            (Some(b), Some(e)) => (format!("{}{}", &prod[..b], &prod[e..]), &prod[b..e]),
            _ => (prod.to_string(), ""),
        };
        if name == "lib.rs" {
            assert!(!inside.is_empty(), "the record-writer block markers moved");
        }
        for line in outside.lines() {
            let code = line.split("//").next().unwrap();
            for m in mutators {
                assert!(!(code.contains("trailer.") && code.contains(m)),
                        "{name}: a trailer mutation outside the record funnel: {}", line.trim());
            }
        }
    }
}

// ── 22.3: `EditResult.changed_cells`; a no-op edit stays clean ───────────────────────────────

/// Sparse and dense deltas both count cells (block and paint of one cell count once); undo/redo
/// report the same count; a delete over air reports 0 and leaves history, dirty state and records
/// untouched — the frontend's `isNoOpEdit` keys off exactly this.
#[test]
pub(crate) fn test_changed_cells_counts_and_no_op_edit_stays_clean() {
    let mut ws = rec_ws();

    // Sparse: 2×1 columns, z 18..=20 solid → 6 cells.
    let r = delete(&mut ws, 5, 5, 6, 5, 18, 22);
    assert_eq!(r.changed_cells, 6);
    let r = undo_edit_inner(&mut ws).expect("undo");
    assert_eq!(r.changed_cells, 6, "undo restores the same cells");
    let r = redo_edit_inner(&mut ws).expect("redo");
    assert_eq!(r.changed_cells, 6, "redo too");

    // Same cell, block unchanged + paint changed = 1; block and paint both changed = 1.
    let r = with_edit(&mut ws, "paint", (0, 0, 4, 4), |w| {
        set_block_abs(w, 3, 3, 20, 8, 5);
        set_block_abs(w, 4, 3, 20, 9, 5);
        Ok(())
    }).expect("paint");
    assert_eq!(r.changed_cells, 2);

    // Dense: one whole chunk column z 1..=20 → 16·16·20 cells, delta stored `Full`.
    let r = delete(&mut ws, 16, 16, 31, 31, 0, 30);
    assert_eq!(r.changed_cells, 16 * 16 * 20);
    let r = undo_edit_inner(&mut ws).expect("undo dense");
    assert_eq!(r.changed_cells, 16 * 16 * 20);
    redo_edit_inner(&mut ws).expect("redo dense");

    // No-op: delete over the air just made.
    let (undo, seq, rseq) = (ws.undo_groups, ws.dirty.seq, ws.dirty.records_seq);
    let r = delete(&mut ws, 16, 16, 31, 31, 0, 30);
    assert_eq!(r.changed_cells, 0);
    assert_eq!(r.records.seq, rseq, "no record change");
    assert_eq!((r.undo_depth, ws.undo_groups), (undo, undo), "no undo entry");
    assert_eq!(ws.dirty.seq, seq, "nothing marked dirty");
    assert_eq!(r.redo_depth, 0);
}
