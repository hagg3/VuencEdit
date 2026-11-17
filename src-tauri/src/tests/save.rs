use super::*;

// ── 18.9: autosave re-based on the saved file ────────────────────────────────────────────────

/// A session wired like a non-zip `load_world`: the world file on disk at `<dir>/world.eden`,
/// recorded as the `DiskImage`, plus a staged temp for the Clone fallback. The temp is written
/// once and never follows edits (the world is an anonymous mapping), i.e. the MAP_PRIVATE shape —
/// so any Clone fallback in these tests only recovers correctly if it journals `since_load`.
pub(crate) fn rebase_session(name: &str, chunks_side: i32) -> (AppState, std::path::PathBuf, AutosavePaths, std::path::PathBuf) {
    let dir = stage4_dir(&format!("rebase_{name}"));
    let bytes = make_bumpy_world_grid(chunks_side, 8, |_, _| 20);
    let source = dir.join("world.eden");
    let staged = dir.join("staged.eden");
    let mut ws = ws_with_disk_image(bytes.clone(), &source);
    fs::write(&staged, &bytes).expect("stage temp");
    ws.temp_path = Some(staged);
    let paths = autosave_paths_at(&dir.join("appdata"));
    fs::create_dir_all(dir.join("appdata")).unwrap();
    (RwLock::new(ws), source, paths, dir)
}

/// Delete a 5×5 column stack inside chunk `(cx, 0)`.
pub(crate) fn rebase_edit(state: &AppState, cx: i32) {
    let x0 = cx * 16;
    let mut ws = write_ws(state);
    with_edit(&mut ws, "delete", (x0, 0, x0 + 4, 4), |world| {
        delete_blocks_inner(world, x0, 0, x0 + 4, 4, 0, 63, None);
        Ok(())
    }).expect("edit");
}

/// What `save_world` does for a full save, minus the `AppHandle`: write, record, re-base.
pub(crate) fn rebase_full_save(state: &AppState, paths: &AutosavePaths, dest: &std::path::Path, compressed: bool) {
    let seq = read_ws(state).dirty.seq;
    {
        let ws = read_ws(state);
        let world = ws.world.as_ref().unwrap();
        if compressed {
            save_world_compressed(world, dest.to_str().unwrap(), false, None).expect("compressed save");
        } else {
            save_world_progress(world, dest.to_str().unwrap(), false, None, None).expect("full save");
        }
    }
    record_full_write(state, dest, compressed, seq).expect("record_full_write");
    rebase_after_save_inner(state, paths, dest, compressed, seq);
}

/// Recover into a fresh state, assert it equals `expected`, and return that state.
pub(crate) fn rebase_recover(paths: &AutosavePaths, expected: &[u8]) -> AppState {
    let fresh: AppState = RwLock::new(WorldState::new());
    load_autosave_inner(&fresh, paths).expect("recovery");
    assert!(world_bytes(&read_ws(&fresh)) == expected, "recovered world must equal the last-ticked world");
    fresh
}

pub(crate) fn rebase_cleanup(fresh: Option<AppState>, dir: &std::path::Path) {
    if let Some(f) = fresh {
        if let Some(t) = read_ws(&f).temp_path.clone() { let _ = fs::remove_file(t); }
    }
    let _ = fs::remove_dir_all(dir);
}

pub(crate) fn journal_coords(paths: &AutosavePaths, base_len: u64) -> std::collections::HashSet<(i32, i32)> {
    let bytes = fs::read(&paths.journal).expect("read journal");
    journal::replay(&bytes, base_len).expect("replay").spans.iter().map(|s| (s.cx, s.cy)).collect()
}

pub(crate) fn meta_base(paths: &AutosavePaths) -> AutosaveBase {
    let info: AutosaveInfo = serde_json::from_str(&fs::read_to_string(&paths.meta).unwrap()).unwrap();
    assert_eq!(info.format, 2);
    info.base.expect("format 2 names its base")
}

/// 18.9 phase 0 — a tick whose I/O straddles a discard must not resurrect the deleted lineage.
#[test]
pub(crate) fn test_discharge_ignores_a_stale_lineage_generation() {
    let (state, _src, paths, dir) = rebase_session("stale_gen", 2);
    rebase_edit(&state, 0);
    let gen = read_ws(&state).lineage_gen;
    let seq = read_ws(&state).dirty.seq;
    discard_autosave_inner(&state, &paths); // lands while the tick is between capture and discharge
    let lineage = AutosaveLineage { base_id: random_base_id(), base: AutosaveBase::Clone, journal_written: false };
    discharge_autosave_journal(&state, gen, lineage, seq);
    let ws = read_ws(&state);
    assert!(ws.autosave.is_none(), "a discharge from before the discard must not restore its lineage");
    assert!(ws.dirty.since_journal.contains_key(&(0, 0)), "nor clear what it journalled into deleted files");
    drop(ws);
    rebase_cleanup(None, &dir);
}

/// Tests 1 + phase 3: the first tick after a raw load writes no base copy; recovery keeps the
/// Source lineage and makes ⌘S an incremental patch of the user's file.
#[test]
pub(crate) fn test_autosave_source_lineage_needs_no_clone() {
    let (state, source, paths, dir) = rebase_session("no_clone", 2);
    rebase_edit(&state, 1);
    autosave_world_inner(&state, &paths, None, None).expect("tick");
    assert!(!paths.base.exists(), "a Source lineage must not copy the world");
    assert!(matches!(meta_base(&paths), AutosaveBase::Source(ref id) if id.path == source));
    let info = autosave_info_at(&paths).unwrap().expect("offered for recovery");
    assert_eq!(info.base_status, Some(BaseStatus::Ok));

    let expected = world_bytes(&read_ws(&state));
    let fresh = rebase_recover(&paths, &expected);
    {
        let ws = read_ws(&fresh);
        assert!(matches!(ws.autosave.as_ref().map(|l| &l.base), Some(AutosaveBase::Source(_))));
        let disk: std::collections::HashSet<_> = ws.dirty.since_disk.keys().copied().collect();
        assert_eq!(disk, std::collections::HashSet::from([(1, 0)]), "since_disk = exactly the replayed chunks");
    }
    assert!(try_incremental_save(&fresh, source.to_str().unwrap(), false).expect("save after recovery"),
        "a recovered Source session saves incrementally");
    assert!(fs::read(&source).unwrap() == expected);
    rebase_cleanup(Some(fresh), &dir);
}

/// Tests 2 + 4: every save re-bases, so the journal (and any compaction) only ever holds edits
/// since the last save — the P-1b regression guard.
#[test]
pub(crate) fn test_autosave_rebases_on_full_save_and_compaction_is_bounded() {
    let (state, source, paths, dir) = rebase_session("full", 3); // 9 chunks
    let base_len = world_bytes(&read_ws(&state)).len() as u64;
    rebase_edit(&state, 0);
    autosave_world_inner(&state, &paths, None, None).expect("tick 1");
    rebase_full_save(&state, &paths, &source, false);
    assert!(!paths.meta.exists() && !paths.journal.exists(), "the re-base removes the old sidecars");
    assert!(read_ws(&state).dirty.since_base.is_empty(), "a seq-clean save resets since_base");
    assert!(read_ws(&state).dirty.since_load.contains_key(&(0, 0)), "since_load is never reset by a save");

    rebase_edit(&state, 1);
    autosave_world_inner(&state, &paths, None, None).expect("tick after save");
    assert_eq!(journal_coords(&paths, base_len), std::collections::HashSet::from([(1, 0)]));

    // Three more chunks in one tick push past base_len/4 and force a compaction.
    { let mut ws = write_ws(&state); ws.dirty.mark_chunks([(0, 1), (1, 1), (2, 1)]); }
    autosave_world_inner(&state, &paths, None, None).expect("compacting tick");
    let coords = journal_coords(&paths, base_len);
    assert!(!coords.contains(&(0, 0)), "compaction must not re-journal a chunk the save already holds");
    assert_eq!(coords.len(), 4);
    assert!(!paths.base.exists(), "no base copy at any point");

    let fresh = rebase_recover(&paths, &world_bytes(&read_ws(&state)));
    rebase_cleanup(Some(fresh), &dir);
}

/// Test 3: the same through an incremental save.
#[test]
pub(crate) fn test_autosave_rebases_on_incremental_save() {
    let (state, source, paths, dir) = rebase_session("incr", 2);
    let base_len = world_bytes(&read_ws(&state)).len() as u64;
    rebase_edit(&state, 0);
    autosave_world_inner(&state, &paths, None, None).expect("tick 1");
    let seq = try_incremental_save_seq(&state, source.to_str().unwrap(), false).unwrap().expect("incremental").seq;
    rebase_after_save_inner(&state, &paths, &source, false, seq);
    rebase_edit(&state, 1);
    autosave_world_inner(&state, &paths, None, None).expect("tick 2");
    assert_eq!(journal_coords(&paths, base_len), std::collections::HashSet::from([(1, 0)]));
    let fresh = rebase_recover(&paths, &world_bytes(&read_ws(&state)));
    rebase_cleanup(Some(fresh), &dir);
}

/// Test 5: an edit landing between the save's capture and its re-base keeps `since_base`.
#[test]
pub(crate) fn test_rebase_keeps_since_base_when_seq_moved() {
    let (state, source, paths, dir) = rebase_session("seq_moved", 2);
    rebase_edit(&state, 0);
    let seq = read_ws(&state).dirty.seq;
    {
        let ws = read_ws(&state);
        save_world_progress(ws.world.as_ref().unwrap(), source.to_str().unwrap(), false, None, None).unwrap();
    }
    rebase_edit(&state, 1); // lands after the capture
    record_full_write(&state, &source, false, seq).unwrap();
    rebase_after_save_inner(&state, &paths, &source, false, seq);
    {
        let ws = read_ws(&state);
        assert!(ws.dirty.since_base.contains_key(&(0, 0)) && ws.dirty.since_base.contains_key(&(1, 0)),
            "a moved seq leaves since_base over-approximate");
        assert!(matches!(ws.autosave.as_ref().map(|l| &l.base), Some(AutosaveBase::Source(_))),
            "the lineage is re-based regardless");
    }
    autosave_world_inner(&state, &paths, None, None).expect("tick");
    let fresh = rebase_recover(&paths, &world_bytes(&read_ws(&state)));
    rebase_cleanup(Some(fresh), &dir);
}

/// Test 6: an external write *during* the session falls back to a Clone; one *after* the last
/// tick makes recovery refuse and keep the sidecars.
#[test]
pub(crate) fn test_autosave_external_modification() {
    let (state, source, paths, dir) = rebase_session("external", 2);
    let touch = |p: &std::path::Path| {
        let mut b = fs::read(p).unwrap();
        b[200] ^= 0xFF;
        fs::write(p, &b).unwrap();
        let f = fs::OpenOptions::new().write(true).open(p).unwrap();
        f.set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000)).unwrap();
    };
    rebase_edit(&state, 0);
    autosave_world_inner(&state, &paths, None, None).expect("tick 1");
    touch(&source);
    rebase_edit(&state, 1);
    autosave_world_inner(&state, &paths, None, None).expect("tick after external write");
    assert_eq!(meta_base(&paths), AutosaveBase::Clone, "a changed source falls back to a clone");
    assert!(paths.base.exists());
    let fresh = rebase_recover(&paths, &world_bytes(&read_ws(&state)));
    rebase_cleanup(Some(fresh), &dir);

    let (state, source, paths, dir) = rebase_session("external_after", 2);
    rebase_edit(&state, 0);
    autosave_world_inner(&state, &paths, None, None).expect("tick");
    touch(&source);
    assert_eq!(autosave_info_at(&paths).unwrap().unwrap().base_status, Some(BaseStatus::Changed));
    let fresh: AppState = RwLock::new(WorldState::new());
    let err = load_autosave_inner(&fresh, &paths).err().expect("must refuse a changed base");
    assert!(err.contains("changed after this autosave"), "{err}");
    assert!(paths.meta.exists() && paths.journal.exists(), "sidecars are kept");
    rebase_cleanup(None, &dir);
}

/// Test 7: a missing source is reported, the sidecars survive, and putting it back recovers.
#[test]
pub(crate) fn test_autosave_missing_source_then_restored() {
    let (state, source, paths, dir) = rebase_session("missing", 2);
    rebase_edit(&state, 0);
    autosave_world_inner(&state, &paths, None, None).expect("tick");
    let aside = dir.join("moved.eden");
    fs::rename(&source, &aside).unwrap();
    assert_eq!(autosave_info_at(&paths).unwrap().unwrap().base_status, Some(BaseStatus::Missing));
    let err = load_autosave_inner(&RwLock::new(WorldState::new()), &paths).err().expect("missing base");
    assert!(err.contains("Can't find"), "{err}");
    assert!(paths.meta.exists() && paths.journal.exists());
    fs::rename(&aside, &source).unwrap(); // same inode, len and mtime
    let fresh = rebase_recover(&paths, &world_bytes(&read_ws(&state)));
    rebase_cleanup(Some(fresh), &dir);
}

/// Tests 8 + 9: a committed save WAL beside the source means a later save — roll it forward and
/// report "changed"; an uncommitted one is discarded and recovery proceeds.
#[test]
pub(crate) fn test_autosave_source_with_wal() {
    let (state, source, paths, dir) = rebase_session("wal_commit", 2);
    rebase_edit(&state, 0);
    autosave_world_inner(&state, &paths, None, None).expect("tick");
    let len = fs::metadata(&source).unwrap().len();
    write_test_wal(&source, len, &[(300, 0, 0, vec![7u8; 16])], true);
    assert_eq!(autosave_info_at(&paths).unwrap().unwrap().base_status, Some(BaseStatus::Changed));
    let err = load_autosave_inner(&RwLock::new(WorldState::new()), &paths).err().expect("superseded");
    assert!(err.contains("changed after this autosave"), "{err}");
    assert_eq!(&fs::read(&source).unwrap()[300..316], &[7u8; 16], "the WAL was rolled forward");
    rebase_cleanup(None, &dir);

    let (state, source, paths, dir) = rebase_session("wal_torn", 2);
    rebase_edit(&state, 0);
    autosave_world_inner(&state, &paths, None, None).expect("tick");
    let len = fs::metadata(&source).unwrap().len();
    write_test_wal(&source, len, &[(300, 0, 0, vec![7u8; 16])], false);
    assert_eq!(autosave_info_at(&paths).unwrap().unwrap().base_status, Some(BaseStatus::Ok));
    let fresh = rebase_recover(&paths, &world_bytes(&read_ws(&state)));
    assert!(!wal_path(&source).exists(), "an uncommitted WAL is discarded");
    rebase_cleanup(Some(fresh), &dir);
}

/// Tests 10 + 11 (+ 12): no disk image (zip load) → Clone; an uncompressed Save As → Source; a
/// compressed save → no lineage → the next tick clones again, from a stale (MAP_PRIVATE-shaped)
/// temp, which only recovers because a Clone journals `since_load`.
#[test]
pub(crate) fn test_autosave_clone_and_source_transitions() {
    let (state, _source, paths, dir) = rebase_session("transitions", 2);
    write_ws(&state).disk_image = None; // as after a zip load
    rebase_edit(&state, 0);
    autosave_world_inner(&state, &paths, None, None).expect("zip-load tick");
    assert_eq!(meta_base(&paths), AutosaveBase::Clone);
    assert!(paths.base.exists());

    let save_as = dir.join("saved_as.eden");
    rebase_full_save(&state, &paths, &save_as, false);
    rebase_edit(&state, 1);
    autosave_world_inner(&state, &paths, None, None).expect("tick after Save As");
    assert!(matches!(meta_base(&paths), AutosaveBase::Source(ref id) if id.path == save_as));
    assert!(!paths.base.exists(), "the clone is gone once the lineage is Source");
    let fresh = rebase_recover(&paths, &world_bytes(&read_ws(&state)));
    rebase_cleanup(Some(fresh), &dir.join("never")); // keep dir for the rest

    let zip = dir.join("saved.zip");
    rebase_full_save(&state, &paths, &zip, true);
    assert!(read_ws(&state).autosave.is_none(), "a compressed save leaves no lineage");
    rebase_edit(&state, 1);
    autosave_world_inner(&state, &paths, None, None).expect("tick after compressed save");
    assert_eq!(meta_base(&paths), AutosaveBase::Clone);
    let fresh = rebase_recover(&paths, &world_bytes(&read_ws(&state)));
    rebase_cleanup(Some(fresh), &dir);
}

/// Test 14: a format-1 sidecar from an older build still recovers.
#[test]
pub(crate) fn test_format_1_autosave_still_recovers() {
    let (state, _source, paths, dir) = rebase_session("format1", 2);
    let original = world_bytes(&read_ws(&state));
    rebase_edit(&state, 0);
    let expected = world_bytes(&read_ws(&state));
    fs::write(&paths.base, &original).unwrap();
    let base_id = [3u8; 16];
    {
        let ws = read_ws(&state);
        let world = ws.world.as_ref().unwrap();
        let (addr, end) = world.chunk_range(0, 0).unwrap();
        let spans = [(addr as u64, 0, 0, &world.bytes[addr..end])];
        write_fresh_journal(&paths.journal, original.len() as u64, base_id, None, None, &spans, None).unwrap();
    }
    let json = format!(r#"{{"world_name":"GridTest","source_path":null,"timestamp":0,"format":1,"base_id":{:?}}}"#, base_id);
    fs::write(&paths.meta, json).unwrap();
    let info = autosave_info_at(&paths).unwrap().expect("format 1 offered");
    assert!(info.base.is_none() && info.base_status.is_none());
    let fresh = rebase_recover(&paths, &expected);
    rebase_cleanup(Some(fresh), &dir);
}

// ── Audit C2 Stage 4: incremental in-place save ──────────────────────────────────────────────

/// Per-test scratch directory under the system temp dir, keyed by name *and* pid so a parallel
/// `cargo test` run can't have two tests writing the same destination file.
pub(crate) fn stage4_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("vuencedit_c2s4_{name}_{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create Stage 4 test dir");
    dir
}

/// A `WorldState` wired up like a freshly-`load_world`'d **uncompressed** world: the same bytes
/// exist at `dest` on disk and are recorded as the known-good `DiskImage`. That recorded image is
/// what makes an incremental save eligible at all, so this mirrors `load_world`'s non-zip branch.
pub(crate) fn ws_with_disk_image(bytes: Vec<u8>, dest: &std::path::Path) -> WorldState {
    fs::write(dest, &bytes).expect("write test destination");
    let md = fs::metadata(dest).expect("stat test destination");
    let mut ws = ws_with(bytes);
    ws.disk_image = Some(DiskImage::from_metadata(dest, &md, false));
    ws
}

/// Hand-build a `<dest>.wal` the way `try_incremental_save` would, so `recover_wal` can be tested
/// against logs this file never actually produces (uncommitted, torn, mismatched).
pub(crate) fn write_test_wal(dest: &std::path::Path, base_len: u64, spans: &[(u64, i32, i32, Vec<u8>)], commit: bool) {
    let f = fs::File::create(wal_path(dest)).expect("create test wal");
    let mut w = journal::JournalWriter::create(f, base_len, [9u8; 16], false).expect("wal header");
    for (off, cx, cy, payload) in spans {
        w.append_span(*off, *cx, *cy, payload).expect("wal span");
    }
    if commit { w.append_commit().expect("wal commit"); }
    w.flush().expect("wal flush");
}

/// A one-chunk edit followed by an incremental save must leave the destination byte-identical to
/// what a full `save_world_inner` of the same state would have produced — that equivalence is the
/// whole contract, since the fast path is only ever chosen *instead of* the slow one. Also pins
/// the surrounding bookkeeping: the `.bak` holds the pre-save file (an APFS clone must not follow
/// the in-place writes that come after it), the redo log is cleaned up, and the dirty set and
/// disk image are advanced so a follow-up save can be incremental too.
#[test]
pub(crate) fn test_incremental_save_matches_full_save() {
    let dir = stage4_dir("match_full");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let state: AppState = RwLock::new(ws_with_disk_image(original.clone(), &dest));

    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit");
    }
    assert_eq!(read_ws(&state).dirty.since_disk.len(), 1, "the edit must dirty exactly chunk (0,0)");

    let took_fast_path = try_incremental_save(&state, dest.to_str().unwrap(), false).expect("incremental save");
    assert!(took_fast_path, "a one-chunk edit on a known-good disk image must be eligible");

    let expected = world_bytes(&read_ws(&state));
    assert_eq!(fs::read(&dest).unwrap(), expected, "incrementally saved file must match the live world");

    // Byte-identical to the full-write path over the same state.
    let full = dir.join("full.eden");
    save_world_inner(read_ws(&state).world.as_ref().unwrap(), full.to_str().unwrap(), false).expect("full save");
    assert_eq!(fs::read(&full).unwrap(), expected, "full save must match too (sanity)");
    assert_eq!(fs::read(&dest).unwrap(), fs::read(&full).unwrap(),
        "incremental and full saves of the same state must be byte-identical");

    // The backup captured the file as it was *before* this save.
    let bak = dir.join("world.eden.bak");
    assert!(bak.exists(), "an in-place save must leave a .bak behind");
    assert_eq!(fs::read(&bak).unwrap(), original,
        ".bak must hold the pre-save bytes — an in-place write must not bleed through the clone");

    assert!(!wal_path(&dest).exists(), "the redo log must be removed once the save completed");
    {
        let ws = read_ws(&state);
        assert!(ws.dirty.since_disk.is_empty(), "a completed save discharges since_disk");
        assert!(!ws.dirty.header_disk);
        let di = ws.disk_image.as_ref().expect("disk image must be re-recorded");
        let md = fs::metadata(&dest).unwrap();
        assert_eq!(di.len, md.len());
        assert_eq!(di.mtime, md.modified().unwrap(), "recorded mtime must match the file we just wrote");
    }

    // And a second edit + save still works against the freshly recorded image.
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (16, 0, 20, 5), |world| {
            delete_blocks_inner(world, 16, 0, 20, 5, 0, 63, None);
            Ok(())
        }).expect("edit 2");
    }
    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("incremental save 2"),
        "the image recorded by the previous incremental save must make the next one eligible");
    assert_eq!(fs::read(&dest).unwrap(), world_bytes(&read_ws(&state)));

    let _ = fs::remove_dir_all(&dir);
}

/// The eligibility gate exists to catch a destination that something outside this editor (the
/// game, a sync client, a second instance) has written since our last save — patching such a file
/// would splice our chunks into someone else's world. Both detectors must decline *and* leave the
/// destination completely untouched, so the caller's full atomic write is still the only writer.
#[test]
pub(crate) fn test_incremental_save_declines_on_external_modification() {
    let dir = stage4_dir("external_mod");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let state: AppState = RwLock::new(ws_with_disk_image(original.clone(), &dest));

    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit");
    }

    // (a) mtime moved. Asserted by corrupting the *recorded* value rather than touching the file:
    // exactly equivalent to the file's mtime having moved, but independent of the host
    // filesystem's timestamp granularity.
    write_ws(&state).disk_image.as_mut().unwrap().mtime = std::time::SystemTime::UNIX_EPOCH;
    assert!(!try_incremental_save(&state, dest.to_str().unwrap(), false).expect("decline, not error"),
        "a destination whose mtime no longer matches our record must decline");
    assert_eq!(fs::read(&dest).unwrap(), original, "a declined save must not touch the destination");
    assert!(!wal_path(&dest).exists(), "a declined save must not leave a redo log");
    assert_eq!(read_ws(&state).dirty.since_disk.len(), 1, "a declined save must not discharge dirty state");

    // (b) length moved (an external truncation or extension).
    {
        let md = fs::metadata(&dest).unwrap();
        let mut di = write_ws(&state);
        let di = di.disk_image.as_mut().unwrap();
        di.mtime = md.modified().unwrap();     // restore (a)'s sabotage
        di.len = md.len();
    }
    let mut longer = original.clone();
    longer.push(0);
    fs::write(&dest, &longer).unwrap();
    assert!(!try_incremental_save(&state, dest.to_str().unwrap(), false).expect("decline, not error"),
        "a destination whose length no longer matches our record must decline");
    assert_eq!(fs::read(&dest).unwrap(), longer, "a declined save must not touch the destination");

    // (b2) C-04: same length, same mtime, but a different file (new inode) — a sync client or a
    // timestamp-preserving copy. Len + mtime match, so only `file_id` can catch it.
    {
        fs::write(&dest, &original).unwrap();   // undo (b)'s extension: the file must equal the image
        let md = fs::metadata(&dest).unwrap();
        let mtime = md.modified().unwrap();
        // Re-record the image against the current file so len + mtime + file_id all match,
        // leaving the inode as the only thing the swap changes.
        write_ws(&state).disk_image = Some(DiskImage::from_metadata(&dest, &md, false));
        let swap = dir.join("swap.tmp");
        fs::write(&swap, &original).unwrap();
        fs::File::options().write(true).open(&swap).unwrap().set_modified(mtime).unwrap();
        fs::rename(&swap, &dest).unwrap();
        let md2 = fs::metadata(&dest).unwrap();
        assert_eq!((md2.len(), md2.modified().unwrap()), (md.len(), mtime), "test setup: len + mtime must match");
        if file_id_of(&md2) != file_id_of(&md) {
            assert!(!try_incremental_save(&state, dest.to_str().unwrap(), false).expect("decline, not error"),
                "a replaced file with identical len + mtime must decline on file_id");
            assert_eq!(fs::read(&dest).unwrap(), original, "a declined save must not touch the destination");
        }
    }

    // (c) a compressed image can never be patched in place.
    {
        let md = fs::metadata(&dest).unwrap();
        let mut ws = write_ws(&state);
        ws.disk_image = Some(DiskImage::from_metadata(&dest, &md, true));
    }
    assert!(!try_incremental_save(&state, dest.to_str().unwrap(), false).expect("decline, not error"),
        "a zip on disk is not a patchable image of world.bytes");

    // (d) no recorded image at all (e.g. a freshly recovered autosave, or a Save As to a new path).
    write_ws(&state).disk_image = None;
    assert!(!try_incremental_save(&state, dest.to_str().unwrap(), false).expect("decline, not error"),
        "with no known-good image there is nothing to patch against");

    let _ = fs::remove_dir_all(&dir);
}

/// 21.4 / audit L3: a destination that can't be opened for writing (read-only here; a Windows
/// sharing violation in the field) must decline with nothing written and **no WAL** — a committed
/// log left behind would replay on the next open, over edits the user may have discarded since.
#[test]
pub(crate) fn test_incremental_save_unwritable_destination_leaves_no_wal() {
    let dir = stage4_dir("unwritable_dest");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let state: AppState = RwLock::new(ws_with_disk_image(original.clone(), &dest));
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit");
    }

    let set_readonly = |ro: bool| {
        let mut perms = fs::metadata(&dest).unwrap().permissions();
        perms.set_readonly(ro);
        fs::set_permissions(&dest, perms).unwrap();
    };
    set_readonly(true);
    let result = try_incremental_save(&state, dest.to_str().unwrap(), false);
    set_readonly(false); // before any assert, so a failure can't leave an undeletable file (Windows)

    assert!(!result.expect("decline, not error"), "an unwritable destination must decline");
    assert!(!wal_path(&dest).exists(), "a declined save must not leave a redo log");
    assert_eq!(fs::read(&dest).unwrap(), original, "a declined save must not touch the destination");
    assert_eq!(read_ws(&state).dirty.since_disk.len(), 1, "a declined save must not discharge dirty state");

    let _ = fs::remove_dir_all(&dir);
}

/// `set_spawn_pos` / `rename_world` write header bytes only and never dirty a
/// chunk, so the header span is the one case where an incremental save has no chunk work at all.
/// It must still be written — and must not disturb a single byte outside the 192-byte header.
#[test]
pub(crate) fn test_incremental_save_writes_header_only_change() {
    let dir = stage4_dir("header_only");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let state: AppState = RwLock::new(ws_with_disk_image(original.clone(), &dest));

    {
        let mut ws = write_ws(&state);
        write_spawn(ws.world.as_mut().unwrap(), 5.0, 7.0);
        ws.dirty.mark_header();
    }
    assert!(read_ws(&state).dirty.since_disk.is_empty(), "a header write dirties no chunk");

    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("incremental save"),
        "a header-only change must still take the fast path");

    let saved = fs::read(&dest).unwrap();
    let expected = world_bytes(&read_ws(&state));
    assert_eq!(saved, expected, "the header change must have landed");
    assert_ne!(saved[0..192], original[0..192], "sanity: the header really did change");
    assert_eq!(saved[192..], original[192..], "nothing outside the header may be rewritten");
    assert!(!read_ws(&state).dirty.header_disk, "a completed save discharges header_disk");

    let _ = fs::remove_dir_all(&dir);
}

/// Past roughly half the world, patching stops beating one sequential rewrite, so a ⌘A-scale edit
/// must fall back to the full atomic write (the plan's manual check 6) — and, like every other
/// decline, must leave the destination untouched on the way out.
#[test]
pub(crate) fn test_incremental_save_declines_when_dirty_set_too_large() {
    let dir = stage4_dir("too_large");
    // Terrain to z=60 so the delete dirties all four bands of every chunk; at z=20 only two
    // bands per chunk are dirty (18.13) — half the world, under the threshold.
    let original = make_bumpy_world_grid(2, 8, |_, _| 60);
    let dest = dir.join("world.eden");
    let state: AppState = RwLock::new(ws_with_disk_image(original.clone(), &dest));

    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 31, 31), |world| {
            delete_blocks_inner(world, 0, 0, 31, 31, 0, 63, None);
            Ok(())
        }).expect("delete everything");
    }
    assert_eq!(read_ws(&state).dirty.since_disk.len(), 4, "all four chunks must be dirty");

    assert!(!try_incremental_save(&state, dest.to_str().unwrap(), false).expect("decline, not error"),
        "4 chunks × 4 bands of a ~132 KB world is past the half-world threshold");
    assert_eq!(fs::read(&dest).unwrap(), original, "a declined save must not touch the destination");

    let _ = fs::remove_dir_all(&dir);
}

/// Save, undo, save again: the second save must put the *reverted* bytes on disk. Undo bypasses
/// `with_edit_inner` entirely, so this is the regression guard for `undo_edit_inner`'s own
/// `mark_chunks` hook still feeding the save path (Stage 1's second hook row).
#[test]
pub(crate) fn test_incremental_save_after_undo_writes_reverted_bytes() {
    let dir = stage4_dir("after_undo");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let state: AppState = RwLock::new(ws_with_disk_image(original.clone(), &dest));

    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit");
    }
    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("save 1"));
    assert_ne!(fs::read(&dest).unwrap(), original, "sanity: the edit is on disk");

    undo_edit_inner(&mut write_ws(&state)).expect("undo");
    assert_eq!(read_ws(&state).dirty.since_disk.len(), 1, "undo must re-dirty the chunk it reverted");

    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("save 2"));
    assert_eq!(fs::read(&dest).unwrap(), original,
        "saving after an undo must write the reverted bytes, restoring the original file exactly");

    let _ = fs::remove_dir_all(&dir);
}

/// A committed redo log is rolled forward on the next open, and — because every span holds the
/// exact bytes that belong at its offset, not a delta — replaying one that was already applied
/// writes the same bytes again. That idempotency is what makes "crashed somewhere between step 3
/// and step 4" a single case rather than a spectrum.
#[test]
pub(crate) fn test_wal_replay_is_idempotent() {
    let dir = stage4_dir("wal_idempotent");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    fs::write(&dest, &original).unwrap();
    let base_len = original.len() as u64;

    // A span carrying a whole rewritten chunk (0,0), plus a header span — the two span shapes a
    // real save produces.
    let chunk = vec![0x5Au8; 32768];
    let mut header = original[0..192].to_vec();
    header[40] = b'Z';
    let spans = vec![
        (0u64, journal::HEADER_SPAN.0, journal::HEADER_SPAN.1, header.clone()),
        (4096u64, 0, 0, chunk.clone()),
    ];

    let mut expected = original.clone();
    expected[0..192].copy_from_slice(&header);
    expected[4096..4096 + 32768].copy_from_slice(&chunk);

    write_test_wal(&dest, base_len, &spans, true);
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), expected, "a committed log must be rolled forward");
    assert!(!wal_path(&dest).exists(), "a successfully applied log must be removed");

    // Replay the identical log over the already-repaired file: same result, no drift.
    write_test_wal(&dest, base_len, &spans, true);
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), expected, "replaying an applied log must be a no-op");

    let _ = fs::remove_dir_all(&dir);
}

/// Audit P-2 — `recover_wal` validates in one streaming pass and applies in a second, so that a
/// multi-GB uncompressed log never becomes a multi-GB allocation. The two things that split can
/// get wrong, and that the single-pass form couldn't: pass 2 must apply *every* span pass 1
/// validated (not stop at the first, and not re-order them away from last-write-wins), and a
/// pass-2 failure must leave the log on disk so the next open retries.
#[test]
pub(crate) fn test_wal_two_pass_applies_every_span_in_order_and_keeps_the_log_on_failure() {
    let dir = stage4_dir("wal_two_pass");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let base_len = original.len() as u64;

    // Enough spans that a "applies the first record then stops" bug is unmissable, plus a
    // deliberate overwrite of an offset an earlier span already wrote — the last-write-wins
    // semantic has to survive being replayed twice across two passes.
    let mut spans: Vec<(u64, i32, i32, Vec<u8>)> = Vec::new();
    let mut expected = original.clone();
    for i in 0..8u64 {
        let off = 4096 + i * 4096;
        let payload = vec![0xA0 + i as u8; 4096];
        expected[off as usize..off as usize + 4096].copy_from_slice(&payload);
        spans.push((off, i as i32, 0, payload));
    }
    let overwrite = vec![0xFFu8; 4096];
    expected[4096..4096 + 4096].copy_from_slice(&overwrite);
    spans.push((4096, 0, 0, overwrite));

    fs::write(&dest, &original).unwrap();
    write_test_wal(&dest, base_len, &spans, true);
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), expected,
        "every span in a committed log must be applied, with the later span winning the overlap");
    assert!(!wal_path(&dest).exists(), "a fully applied log must be removed");

    // Pass 2 can't open the destination for writing: the repair must be abandoned *and the log
    // kept*, because replay is idempotent and the next open is entitled to try again.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&dest, &original).unwrap();
        write_test_wal(&dest, base_len, &spans, true);
        let mut perms = fs::metadata(&dest).unwrap().permissions();
        perms.set_mode(0o444);
        fs::set_permissions(&dest, perms).unwrap();

        recover_wal(&dest);
        assert!(wal_path(&dest).exists(),
            "a log that could not be applied must survive for the next open to retry");
        assert_eq!(fs::read(&dest).unwrap(), original, "the destination must be untouched");

        // And the retry succeeds once the obstruction is gone — which is the whole point of
        // keeping it.
        let mut perms = fs::metadata(&dest).unwrap().permissions();
        perms.set_mode(0o644);
        fs::set_permissions(&dest, perms).unwrap();
        recover_wal(&dest);
        assert_eq!(fs::read(&dest).unwrap(), expected, "the retry must complete the repair");
        assert!(!wal_path(&dest).exists());
    }

    let _ = fs::remove_dir_all(&dir);
}

/// The commit record is the entire basis for "the destination was never touched": a log without
/// one was still being written when the crash happened, which is strictly before step 3 begins.
/// All three malformed shapes must be discarded with the destination left pristine.
#[test]
pub(crate) fn test_uncommitted_wal_is_discarded() {
    let dir = stage4_dir("wal_uncommitted");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let base_len = original.len() as u64;
    let spans = vec![(4096u64, 0, 0, vec![0x5Au8; 32768])];

    // (a) No commit record.
    fs::write(&dest, &original).unwrap();
    write_test_wal(&dest, base_len, &spans, false);
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), original, "an uncommitted log must not be applied");
    assert!(!wal_path(&dest).exists(), "an uncommitted log must be discarded");

    // (b) Committed, then torn — a crash while the log itself was being flushed.
    write_test_wal(&dest, base_len, &spans, true);
    {
        let wal = wal_path(&dest);
        let len = fs::metadata(&wal).unwrap().len();
        let f = fs::OpenOptions::new().write(true).open(&wal).unwrap();
        f.set_len(len - 3).unwrap();
    }
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), original, "a torn log must not be partially applied");
    assert!(!wal_path(&dest).exists());

    // (c) A log belonging to a different file entirely (mismatched base_len).
    write_test_wal(&dest, base_len + 1, &spans, true);
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), original, "a log that doesn't fit this file must not apply");
    assert!(!wal_path(&dest).exists());

    let _ = fs::remove_dir_all(&dir);
}

/// Stamp `dest_id` into an existing test WAL's header (what `try_incremental_save_seq` writes).
pub(crate) fn bind_test_wal(dest: &std::path::Path, dest_id: u64) {
    let mut f = fs::OpenOptions::new().write(true).open(wal_path(dest)).unwrap();
    f.seek(SeekFrom::Start(32)).unwrap();
    f.write_all(&dest_id.to_le_bytes()).unwrap();
}

pub(crate) fn wal_header_of(dest: &std::path::Path) -> [u8; journal::HEADER_LEN] {
    fs::read(wal_path(dest)).unwrap()[..journal::HEADER_LEN].try_into().unwrap()
}

/// 29.4 / audit C-03: a committed log is matched to its destination by identity, not just
/// length. A bound log still repairs the file it was written for (the crash case), but one left
/// behind and then outlived by a same-length rewrite of the file (here our own full save, which
/// renames a new file in) must neither replay nor make the file look changed to autosave.
#[test]
pub(crate) fn test_wal_bound_to_its_destination() {
    let dir = stage4_dir("wal_bound");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let base_len = original.len() as u64;
    let spans = vec![(4096u64, 0, 0, vec![0x5Au8; 32768])];
    let mut patched = original.clone();
    patched[4096..4096 + 32768].fill(0x5A);

    // (a) Bound to this very file: rolled forward exactly as before.
    fs::write(&dest, &original).unwrap();
    write_test_wal(&dest, base_len, &spans, true);
    bind_test_wal(&dest, wal_dest_id(&fs::metadata(&dest).unwrap()));
    assert!(has_committed_wal(&dest));
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), patched, "a log bound to this file must repair it");
    assert!(!wal_path(&dest).exists());

    // (b) The audit's repro: the log outlives its save (a failed unlink), then a full save of the
    // same length replaces the file. Before 29.4 the length matched and the next open reverted
    // chunk (0,0) to the log's bytes.
    fs::write(&dest, &original).unwrap();
    write_test_wal(&dest, base_len, &spans, true);
    bind_test_wal(&dest, wal_dest_id(&fs::metadata(&dest).unwrap()));
    let mut newer = original.clone();
    newer[4096..4096 + 32768].fill(0x33);
    let held = dir.join("held"); // keep the old inode alive so the new file can't reuse it
    fs::hard_link(&dest, &held).unwrap();
    save_world_inner(&parse_world_inner(mmap_from_bytes(newer.clone())).unwrap(), dest.to_str().unwrap(), false)
        .expect("full save");
    assert_eq!(fs::metadata(&dest).unwrap().len(), base_len, "same length: only identity can tell");
    assert!(!has_committed_wal(&dest), "a log for a replaced file must not count as committed");
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), newer, "a log for a replaced file must not roll it back");
    assert!(!wal_path(&dest).exists(), "and it is discarded");
    let _ = fs::remove_file(&held);

    let _ = fs::remove_dir_all(&dir);
}

/// 29.4 / audit C-03: `retire_wal` deletes the log, or neutralises it when the delete fails (an
/// AV scanner holding it on Windows; a read-only directory here), and reports only when the log
/// survives as-is. A neutralised log never replays and is cleaned up by the next open.
#[cfg(unix)]
#[test]
pub(crate) fn test_retire_wal_neutralises_or_reports() {
    use std::os::unix::fs::PermissionsExt;
    let dir = stage4_dir("wal_retire");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let spans = vec![(4096u64, 0, 0, vec![0x5Au8; 32768])];
    let set_mode = |p: &std::path::Path, m: u32| fs::set_permissions(p, fs::Permissions::from_mode(m)).unwrap();

    // No log at all, and a deletable one: both fine.
    fs::write(&dest, &original).unwrap();
    assert!(retire_wal(&dest).is_ok());
    write_test_wal(&dest, original.len() as u64, &spans, true);
    assert!(retire_wal(&dest).is_ok());
    assert!(!wal_path(&dest).exists());

    // Undeletable but writable: neutralised.
    write_test_wal(&dest, original.len() as u64, &spans, true);
    set_mode(&dir, 0o555);
    let r = retire_wal(&dest);
    set_mode(&dir, 0o755); // before any assert, so a failure can't leave an undeletable dir
    assert!(r.is_ok(), "{r:?}");
    assert!(wal_path(&dest).exists(), "the delete really did fail");
    assert_eq!(&wal_header_of(&dest)[0..4], &[0u8; 4], "its magic is zeroed");
    assert!(!has_committed_wal(&dest));
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), original, "a neutralised log never replays");
    assert!(!wal_path(&dest).exists(), "and the next open removes it");

    // Neither deletable nor writable: reported, log left as it was.
    write_test_wal(&dest, original.len() as u64, &spans, true);
    set_mode(&wal_path(&dest), 0o444);
    set_mode(&dir, 0o555);
    let r = retire_wal(&dest);
    set_mode(&dir, 0o755);
    set_mode(&wal_path(&dest), 0o644);
    assert!(r.is_err(), "a surviving committed log must be reported");
    assert!(has_committed_wal(&dest));

    let _ = fs::remove_dir_all(&dir);
}

/// 29.4 end to end: an incremental save whose log can't be deleted still succeeds, binds the log
/// to the file it patched, and leaves it neutralised, so reopening changes nothing.
#[cfg(unix)]
#[test]
pub(crate) fn test_incremental_save_neutralises_an_undeletable_log() {
    use std::os::unix::fs::PermissionsExt;
    let dir = stage4_dir("wal_undeletable");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let state: AppState = RwLock::new(ws_with_disk_image(original.clone(), &dest));
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit");
    }
    // Everything the save creates in the directory exists up front, so only the delete needs
    // the directory to be writable.
    make_backup_if_absent(&dest, false).unwrap();
    fs::write(wal_path(&dest), b"").unwrap();
    let ino = wal_dest_id(&fs::metadata(&dest).unwrap());

    fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
    let r = try_incremental_save_seq(&state, dest.to_str().unwrap(), false);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();

    let saved = r.expect("save").expect("eligible");
    assert!(saved.warning.is_none(), "a neutralised log needs no warning: {:?}", saved.warning);
    let expected = world_bytes(&read_ws(&state));
    assert_eq!(fs::read(&dest).unwrap(), expected);
    let hdr = wal_header_of(&dest);
    assert_eq!(&hdr[0..4], &[0u8; 4], "neutralised");
    assert_eq!(u64::from_le_bytes(hdr[32..40].try_into().unwrap()), ino, "bound to the file it patched");
    recover_wal(&dest);
    assert_eq!(fs::read(&dest).unwrap(), expected);
    assert!(!wal_path(&dest).exists());

    let _ = fs::remove_dir_all(&dir);
}

/// "Save As to a new path, then ⌘S" (the plan's manual check 5): the first save has no image to
/// patch against and must decline to the full write, and recording that write must make the
/// *second* save incremental against the new path.
#[test]
pub(crate) fn test_full_write_establishes_disk_image_for_next_incremental() {
    let dir = stage4_dir("save_as");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("saved-as.eden");
    let state: AppState = RwLock::new(ws_with(original.clone())); // no disk image: nothing loaded from a file

    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit 1");
    }

    assert!(!try_incremental_save(&state, dest.to_str().unwrap(), false).expect("decline, not error"),
        "a Save As to an unknown path must decline to the full write");

    // What `save_world`'s full-write branch does.
    let seq = {
        let ws = read_ws(&state);
        let seq = ws.dirty.seq;
        save_world_inner(ws.world.as_ref().unwrap(), dest.to_str().unwrap(), false).expect("full save");
        seq
    };
    record_full_write(&state, &dest, false, seq).expect("record full write");
    {
        let ws = read_ws(&state);
        assert!(ws.dirty.since_disk.is_empty(), "a full write discharges the whole dirty set");
        assert_eq!(ws.disk_image.as_ref().unwrap().path, dest);
    }

    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (16, 0, 20, 5), |world| {
            delete_blocks_inner(world, 16, 0, 20, 5, 0, 63, None);
            Ok(())
        }).expect("edit 2");
    }
    assert!(try_incremental_save(&state, dest.to_str().unwrap(), false).expect("incremental save"),
        "the image recorded by the full write must make the next save incremental");
    assert_eq!(fs::read(&dest).unwrap(), world_bytes(&read_ws(&state)));

    let _ = fs::remove_dir_all(&dir);
}

/// `record_full_write`'s `seq` comparison is what stops a save from clearing dirty state it
/// didn't actually write — an edit (or a whole world swap) landing between the save's read guard
/// and its write guard must invalidate the capture. Every mutator of `DirtyState` therefore has
/// to move the counter, `clear_all` included: a world load/close that reset it could otherwise
/// let a stale capture compare equal and discharge the *new* world's dirty set.
#[test]
pub(crate) fn test_dirty_seq_invalidates_a_stale_capture() {
    let mut d = DirtyState::default();

    let captured = d.seq;
    d.mark_chunks([(0, 0)]);
    assert_ne!(d.seq, captured, "mark_chunks must invalidate a capture taken before it");

    let captured = d.seq;
    d.mark_header();
    assert_ne!(d.seq, captured, "mark_header must invalidate a capture taken before it");

    let captured = d.seq;
    d.clear_all();
    assert_ne!(d.seq, captured, "clear_all (world load/close) must invalidate a capture too");
}

/// A declined incremental save must not have written to the destination — and the one path that
/// could violate that is `record_full_write` being reached with a stale `seq`. Exercise that
/// branch directly: a capture taken before an edit must record nothing at all.
#[test]
pub(crate) fn test_record_full_write_ignores_a_stale_capture() {
    let dir = stage4_dir("stale_capture");
    let original = make_bumpy_world_grid(2, 8, |_, _| 20);
    let dest = dir.join("world.eden");
    let state: AppState = RwLock::new(ws_with_disk_image(original.clone(), &dest));

    let stale = read_ws(&state).dirty.seq;
    {
        let mut ws = write_ws(&state);
        with_edit(&mut ws, "delete", (0, 0, 5, 5), |world| {
            delete_blocks_inner(world, 0, 0, 5, 5, 0, 63, None);
            Ok(())
        }).expect("edit landing 'during' the save");
    }

    record_full_write(&state, &dest, false, stale).expect("must not error");
    let ws = read_ws(&state);
    assert_eq!(ws.dirty.since_disk.len(), 1,
        "an edit that landed after the capture must stay dirty — clearing it would drop it from the file");
    // The pre-existing image is left as it was rather than being advanced to describe a file that
    // doesn't hold that edit, so the next save re-checks it and falls back if it no longer fits.
    assert_eq!(ws.disk_image.as_ref().unwrap().len, original.len() as u64);

    drop(ws);
    let _ = fs::remove_dir_all(&dir);
}

/// B2 face-fill bucket: `find_connected_face_cells` must follow a contiguous same-type run
/// across the clicked face's plane, stop at a differently-typed or disconnected cell, and — the
/// case that distinguishes it from a flat 2D flood-fill — refuse to cross into a same-type cell
/// whose own face (along the same normal) isn't exposed, since that's a different visible run.
#[test]
pub(crate) fn test_face_fill_connected_cells() {
    let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");

    // A 3-cell Stone floor at z=10, all with an exposed top face (air at z=11) — one connected run.
    for lx in 3..=5 {
        world.bytes[blk(lx, 5, 10)] = 2; // Stone
    }
    // Disconnected Stone cell elsewhere — must NOT be swept in.
    world.bytes[blk(10, 10, 10)] = 2;
    // Adjacent Stone cell (lx=6) whose top face is covered by another block — same type, but not
    // the same visible face, so the BFS must stop before it even though it's 4-connected in-plane.
    world.bytes[blk(6, 5, 10)] = 2;
    world.bytes[blk(6, 5, 11)] = 2;

    let mut cells = find_connected_face_cells(&world, 3, 5, 10, 0, 0, 1, false, 4_000);
    cells.sort();
    assert_eq!(cells, vec![(3, 5, 10), (4, 5, 10), (5, 5, 10)],
        "must follow the exposed-top-face run and stop at the covered-face and disconnected cells");

    // Seed on air → no match (defensive; the command layer also rejects this before calling in).
    assert!(find_connected_face_cells(&world, 0, 0, 0, 0, 0, 1, false, 4_000).is_empty());
}

/// export_png's encoder must produce a valid PNG of the right dimensions from a rendered
/// full-map RGBA buffer (the Rust-side replacement for the old JS canvas→base64 path).
#[test]
pub(crate) fn test_export_png_encodes_valid() {
    let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    let w = (world.w_chunks * 16) as i32;
    let h = (world.h_chunks * 16) as i32;
    let patch = render_pixels_patch(&world, 0, 0, w - 1, h - 1, None);
    let png = encode_rgba_png(&patch.pixels, w as u32, h as u32).expect("encode failed");
    assert_eq!(&png[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "PNG magic");
    let img = image::load_from_memory(&png).expect("decode failed");
    assert_eq!(img.width(), w as u32);
    assert_eq!(img.height(), h as u32);
}

/// Cutaway view: a cap hides everything above it, so both the top-down render and the
/// surface lookup (which is what a z-less draw targets) see the highest block *at or below*
/// the cap. The fixture column (3,5) has wood@z0, stone@z17, dirt@z48.
#[test]
pub(crate) fn test_cutaway_cap_render_and_surface() {
    let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");

    assert_eq!(surface_z(&world, 3, 5), Some(48), "uncapped surface = the true top block");
    assert_eq!(surface_z_capped(&world, 3, 5, Some(63)), Some(48), "cap above everything = no change");
    assert_eq!(surface_z_capped(&world, 3, 5, Some(30)), Some(17), "cap below dirt exposes the stone");
    assert_eq!(surface_z_capped(&world, 3, 5, Some(10)), Some(0), "cap below stone exposes the wood");
    assert_eq!(surface_z_capped(&world, 3, 5, Some(0)), Some(0), "cap at the bottom block still finds it");

    let px = |p: &PixelPatch| -> [u8; 3] { [p.pixels[0], p.pixels[1], p.pixels[2]] };
    let uncapped = render_pixels_patch(&world, 3, 5, 3, 5, None);
    let capped   = render_pixels_patch(&world, 3, 5, 3, 5, Some(30));
    let dirt  = block_color(3, 0, world.sky);
    let stone = block_color(2, 5, world.sky); // the fixture's stone is painted (paint 5)
    assert_eq!(px(&uncapped), dirt,  "normal render shows the top block (dirt)");
    assert_eq!(px(&capped),   stone, "cutaway render shows the block under the cap (stone)");
}

/// Set Point writes two *distinct* header fields: Home → `home` (bytes 16–27) and
/// Start → `pos` (bytes 4–15). Each must leave the other byte-identical, or "set my start
/// position" would silently move the respawn point too (and vice versa).
#[test]
pub(crate) fn test_set_point_home_and_start_are_independent_fields() {
    let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");

    // Neither field is set in the fixture (all-zero header), so both readers say None.
    assert_eq!(read_spawn(&world), None, "fresh fixture has no home");
    assert_eq!(read_player_pos(&world), None, "fresh fixture has no pos");

    // Write only `pos`.
    let home_before = world.bytes[16..28].to_vec();
    write_player_pos(&mut world, 3.0, 5.0);
    assert_eq!(&world.bytes[16..28], &home_before[..], "writing pos must not touch home");
    let (ppx, ppy) = read_player_pos(&world).expect("pos round-trips");
    assert_eq!((ppx, ppy), (3.0, 5.0));
    // Height resolves to one above the column's surface (dirt @ z48 → 50.0), same rule as home.
    assert_eq!(f32::from_le_bytes(world.bytes[8..12].try_into().unwrap()), 50.0);
    assert_eq!(read_spawn(&world), None, "home still unset");

    // Write only `home`.
    let pos_before = world.bytes[4..16].to_vec();
    write_spawn(&mut world, 7.0, 2.0);
    assert_eq!(&world.bytes[4..16], &pos_before[..], "writing home must not touch pos");
    assert_eq!(read_spawn(&world), Some((7.0, 2.0)));
    assert_eq!(read_player_pos(&world), Some((3.0, 5.0)), "pos survives a home write");
}

/// The binary IPC envelope (audit H2) is the contract `decodeEnvelope` in codec.ts reads back:
/// a u32 LE header length, the header JSON, then the bodies concatenated — with the header
/// padded so the body starts 4-byte aligned (the JS side takes `Float32Array` *views* over it).
#[test]
pub(crate) fn test_ipc_envelope_framing() {
    use tauri::ipc::InvokeResponseBody;
    let unwrap_raw = |b: InvokeResponseBody| match b {
        InvokeResponseBody::Raw(v) => v,
        InvokeResponseBody::Json(_) => panic!("envelope must be a raw body, not JSON"),
    };

    // Single body: a pixel patch. Header carries the dims, body is exactly the pixels.
    let patch = PixelPatch { x: 7, y: 9, width: 2, height: 1, lod: 4, pixels: vec![1, 2, 3, 4, 5, 6, 7, 8] };
    let bytes = unwrap_raw(tauri::ipc::IpcResponse::body(patch).expect("frame failed"));
    let hlen = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    assert_eq!((4 + hlen) % 4, 0, "body must start 4-byte aligned");
    let hdr: serde_json::Value = serde_json::from_slice(&bytes[4..4 + hlen]).expect("header must be valid JSON");
    assert_eq!(hdr["x"], 7);
    assert_eq!(hdr["y"], 9);
    assert_eq!(hdr["width"], 2);
    assert_eq!(hdr["height"], 1);
    assert_eq!(hdr["lod"], 4);
    assert_eq!(&bytes[4 + hlen..], &[1, 2, 3, 4, 5, 6, 7, 8], "body is the pixels, verbatim");

    // Multiple bodies concatenate in order, and the header's `lens` is what splits them.
    #[derive(Serialize)]
    struct H { lens: [u32; 3] }
    let body = unwrap_raw(
        ipc_envelope(&H { lens: [4, 0, 8] }, &[&[9u8; 4][..], &[][..], &[3u8; 8][..]]).expect("frame failed"),
    );
    let hlen = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
    assert_eq!(body.len(), 4 + hlen + 12);
    assert_eq!(&body[4 + hlen..4 + hlen + 4], &[9u8; 4]);
    assert_eq!(&body[4 + hlen + 4..], &[3u8; 8]);

    // `ipc_envelope_one` moves its single body instead of copying it (audit C2) — the framing
    // it produces must be byte-identical to the copying form, or every JS decoder breaks.
    let moved = unwrap_raw(ipc_envelope_one(&H { lens: [4, 0, 8] }, vec![7u8; 12]).expect("frame failed"));
    let copied = unwrap_raw(ipc_envelope(&H { lens: [4, 0, 8] }, &[&[7u8; 12][..]]).expect("frame failed"));
    assert_eq!(moved, copied, "the moving and copying framings must agree byte-for-byte");

    // A `None` header (the "no selection mask" case) frames as literal JSON null with no body.
    let none = unwrap_raw(tauri::ipc::IpcResponse::body(
        SelectionMaskInfo { mask: None, bits: Vec::new() },
    ).expect("frame failed"));
    let hlen = u32::from_le_bytes(none[..4].try_into().unwrap()) as usize;
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&none[4..4 + hlen]).unwrap(), serde_json::Value::Null);
    assert_eq!(none.len(), 4 + hlen, "no body when there's no mask");
}

/// LOD rendering (audit H6) is *point sampling*, not averaging: pixel (ox,oy) of a lod-N patch
/// must be byte-identical to pixel (ox*N, oy*N) of the full-resolution patch over the same
/// rect. That pins both the output dimensions and the sampling phase — an off-by-one in either
/// would shift the zoomed-out map against the tile grid it's drawn into.
#[test]
pub(crate) fn test_render_lod_matches_sampled_full_render() {
    let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    let w = (world.w_chunks * 16) as i32;
    let h = (world.h_chunks * 16) as i32;
    let full = render_pixels_patch(&world, 0, 0, w - 1, h - 1, None);
    assert_eq!(full.lod, 1, "the unscoped renderer is lod 1");

    for lod in [2u32, 4, 8] {
        let p = render_pixels_patch_lod(&world, 0, 0, w - 1, h - 1, None, lod);
        assert_eq!(p.lod, lod);
        assert_eq!(p.width,  (w as u32 - 1) / lod + 1, "lod {lod} width");
        assert_eq!(p.height, (h as u32 - 1) / lod + 1, "lod {lod} height");
        for oy in 0..p.height {
            for ox in 0..p.width {
                let lo = ((oy * p.width + ox) * 4) as usize;
                let fo = (((oy * lod) * full.width + ox * lod) * 4) as usize;
                assert_eq!(&p.pixels[lo..lo + 4], &full.pixels[fo..fo + 4],
                    "lod {lod} pixel ({ox},{oy}) must be the block at ({},{})", ox * lod, oy * lod);
            }
        }
    }

    // A range whose length isn't a multiple of the step still covers its first sample and
    // never reads past `x2`: 0..=14 at step 4 samples 0,4,8,12 → 4 pixels.
    let ragged = render_pixels_patch_lod(&world, 0, 0, 14, 14, None, 4);
    assert_eq!((ragged.width, ragged.height), (4, 4));

    // Same contract for the z-slice renderer, which shares the tile grid.
    let zfull = render_zslice_patch_inner(&world, 0, 0, 0, w - 1, h - 1);
    let zlod  = render_zslice_patch_lod(&world, 0, 0, 0, w - 1, h - 1, 4);
    assert_eq!((zlod.width, zlod.height), ((w as u32 - 1) / 4 + 1, (h as u32 - 1) / 4 + 1));
    for oy in 0..zlod.height {
        for ox in 0..zlod.width {
            let lo = ((oy * zlod.width + ox) * 4) as usize;
            let fo = (((oy * 4) * zfull.width + ox * 4) * 4) as usize;
            assert_eq!(&zlod.pixels[lo..lo + 4], &zfull.pixels[fo..fo + 4], "zslice lod 4 ({ox},{oy})");
        }
    }

    // Out-of-range steps clamp rather than producing a degenerate patch.
    assert_eq!(render_pixels_patch_lod(&world, 0, 0, w - 1, h - 1, None, 0).lod, 1);
    assert_eq!(render_pixels_patch_lod(&world, 0, 0, w - 1, h - 1, None, 9999).lod, MAX_LOD);
}

/// Backup semantics: first save to an existing path creates path.bak;
/// second save does NOT overwrite an already-present .bak.
#[test]
pub(crate) fn test_backup_semantics() {
    let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");

    let tmp     = std::env::temp_dir().join("eden_test_backup.eden");
    let tmp_bak = std::env::temp_dir().join("eden_test_backup.eden.bak");
    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(&tmp_bak);

    // Write an "existing" file to simulate overwriting a previous save
    let sentinel = b"original content before first save";
    fs::write(&tmp, sentinel).unwrap();

    // First save → .bak should capture the pre-save content
    save_world_inner(&world, tmp.to_str().unwrap(), false).expect("first save failed");
    assert!(tmp_bak.exists(), ".bak must be created on first save over existing file");
    assert_eq!(fs::read(&tmp_bak).unwrap(), sentinel,
        ".bak must contain the pre-save file content");

    // Write something else to the main file to simulate a subsequent edit
    fs::write(&tmp, b"intermediate content").unwrap();

    // Second save → .bak already exists, must NOT be overwritten
    save_world_inner(&world, tmp.to_str().unwrap(), false).expect("second save failed");
    assert_eq!(fs::read(&tmp_bak).unwrap(), sentinel,
        ".bak must not be overwritten on subsequent saves");

    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(&tmp_bak);
}

/// Audit C2 Stage 5 — `backupCompressed` writes `<path>.bak.zip` capturing the pre-save file,
/// not `world.bytes`; a pre-existing plain `.bak` still counts as "already backed up" so
/// toggling the setting mid-session doesn't produce two backups.
#[test]
pub(crate) fn test_compressed_backup_semantics() {
    let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");

    let tmp = std::env::temp_dir().join(format!("eden_test_zbackup_{}.eden", std::process::id()));
    let tmp_bak_zip = std::env::temp_dir().join(format!("eden_test_zbackup_{}.eden.bak.zip", std::process::id()));
    let tmp_bak = std::env::temp_dir().join(format!("eden_test_zbackup_{}.eden.bak", std::process::id()));
    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(&tmp_bak_zip);
    let _ = fs::remove_file(&tmp_bak);

    let sentinel = b"original content before first save";
    fs::write(&tmp, sentinel).unwrap();

    save_world_inner(&world, tmp.to_str().unwrap(), true).expect("first save failed");
    assert!(tmp_bak_zip.exists(), ".bak.zip must be created when backupCompressed is on");
    assert!(!tmp_bak.exists(), "a plain .bak must not also be written");
    let mut zip = zip::ZipArchive::new(fs::File::open(&tmp_bak_zip).unwrap()).expect("open backup zip");
    assert_eq!(zip.len(), 1);
    let mut entry = zip.by_index(0).unwrap();
    let mut contents = Vec::new();
    std::io::Read::read_to_end(&mut entry, &mut contents).unwrap();
    assert_eq!(contents, sentinel, ".bak.zip must contain the pre-save file content");
    drop(entry);
    drop(zip);

    fs::write(&tmp, b"intermediate content").unwrap();
    save_world_inner(&world, tmp.to_str().unwrap(), true).expect("second save failed");
    let mut zip = zip::ZipArchive::new(fs::File::open(&tmp_bak_zip).unwrap()).expect("open backup zip");
    let mut entry = zip.by_index(0).unwrap();
    let mut contents = Vec::new();
    std::io::Read::read_to_end(&mut entry, &mut contents).unwrap();
    assert_eq!(contents, sentinel, ".bak.zip must not be overwritten on subsequent saves");

    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(&tmp_bak_zip);
}

/// 18.8 — `backup_status` reports exactly what `make_backup_if_absent` will do: the source size
/// before a first save, the existing backup afterwards, and the asymmetric "which format counts"
/// rule (a `.bak.zip` doesn't satisfy a plain-`.bak` save; a plain `.bak` satisfies both).
#[test]
pub(crate) fn test_backup_status_matches_backup_rule() {
    let dir = std::env::temp_dir().join(format!("eden_test_bakstatus_{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let src = dir.join("w.eden");
    let path = src.to_str().unwrap().to_string();

    let none = backup_status(path.clone(), false);
    assert_eq!((none.existing_name, none.source_bytes), (None, 0), "no file ⇒ no backup, nothing to copy");

    fs::write(&src, vec![7u8; 1000]).unwrap();
    let before = backup_status(path.clone(), true);
    assert_eq!((before.existing_name, before.source_bytes), (None, 1000));

    make_backup_if_absent(&src, true).unwrap();
    let zipped = backup_status(path.clone(), true);
    assert_eq!(zipped.existing_name.as_deref(), Some("w.eden.bak.zip"));
    assert!(zipped.existing_bytes > 0 && zipped.existing_bytes < 1000, "deflated backup is reported at its own size");
    assert_eq!(backup_status(path.clone(), false).existing_name, None,
        "with backupCompressed off a .bak.zip doesn't count — the next save writes a plain .bak");

    make_backup_if_absent(&src, false).unwrap();
    let plain = backup_status(path.clone(), false);
    assert_eq!((plain.existing_name.as_deref(), plain.existing_bytes), (Some("w.eden.bak"), 1000));

    let _ = fs::remove_dir_all(&dir);
}

/// Exercise the whole-world procedural generator: it must run without
/// panicking (cross-chunk feature writes stay in-bounds), produce a sane
/// centre surface, and actually fill terrain blocks in every chunk.
#[test]
pub(crate) fn natural_generator_fills_terrain() {
    let (wc, hc) = (3usize, 3usize);
    let t_height = 64usize;
    let chunk_size = 32_768usize;
    let cfg = NaturalConfig {
        seed: 12345, base_height: 28, roughness: 0.8, erosion: 0.0, terrain_scale: 120.0, extreme: false,
        water_z: 24, rivers: true, biome: 0, biome_mode: 0, biome_scale: 200.0, snow_caps: true,
        tree_density_denom: 40, cave_density: 2, cave_style: 0, caverns: true, flood_caves: false,
        ore_density: 2, vegetation: 2, structures: 2, clouds: true,
    };
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; chunk_size]).collect();
    let center = generate_natural_world(&mut chunks, wc, hc, &cfg, t_height, &mut |_, _| {});

    assert!(center >= 2 && center < t_height, "centre surface z out of range: {center}");

    // Every chunk has bedrock at z=0 across its whole footprint, and a
    // non-trivial number of solid blocks above it.
    for data in &chunks {
        let mut solid = 0usize;
        for lx in 0..16 {
            for ly in 0..16 {
                assert_eq!(chunk_get(data, lx, ly, 0), 1, "missing bedrock");
                for z in 1..t_height {
                    if chunk_get(data, lx, ly, z) != 0 { solid += 1; }
                }
            }
        }
        assert!(solid > 16 * 16, "chunk looks empty: only {solid} solid blocks");
    }
}

/// A flat-roughness desert with no water/features should still be valid and
/// produce a sand surface (regression guard for biome surface selection).
#[test]
pub(crate) fn natural_generator_desert_plains() {
    let (wc, hc) = (2usize, 2usize);
    let t_height = 64usize;
    let cfg = NaturalConfig {
        seed: 7, base_height: 20, roughness: 0.0, erosion: 0.0, terrain_scale: 120.0, extreme: false,
        water_z: -1, rivers: false, biome: 1, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
        tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
        ore_density: 0, vegetation: 0, structures: 0, clouds: false,
    };
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    let center = generate_natural_world(&mut chunks, wc, hc, &cfg, t_height, &mut |_, _| {});
    // Flat terrain → centre surface should equal base height.
    assert_eq!(center, 20);
    assert_eq!(chunk_get(&chunks[0], 8, 8, center as usize), 4, "desert surface must be sand");
}

/// The Classic Hills biome must produce a grass-capped surface (so natural
/// decoration works) over a classic stone body, and its classic 3D-noise caves
/// must carve open air underground when enabled.
#[test]
pub(crate) fn natural_classic_biome_grass_cap_and_caves() {
    let (wc, hc) = (3usize, 3usize);
    let t_height = 64usize;
    let base = NaturalConfig {
        seed: 4242, base_height: 30, roughness: 0.6, erosion: 0.0, terrain_scale: 120.0, extreme: false,
        water_z: -1, rivers: false, biome: BIOME_CLASSIC, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
        tree_density_denom: 0, cave_density: 0, cave_style: 1, caverns: false, flood_caves: false,
        ore_density: 0, vegetation: 0, structures: 0, clouds: false,
    };

    // Every column's surface is either a grass cap (soil) or a stone cap (rock
    // outcrop), and always rests on a solid body. Both kinds must appear.
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    let cn = ClassicNoise::new(base.seed);
    let ccfg = classic_cfg_for_natural(&base);
    generate_natural_world(&mut chunks, wc, hc, &base, t_height, &mut |_, _| {});
    let (mut grass_caps, mut stone_caps) = (0u32, 0u32);
    for cy in 0..hc { for cx in 0..wc {
        for lx in 0..16usize { for ly in 0..16usize {
            let wx = cx * 16 + lx; let wy = cy * 16 + ly;
            let h = classic_height(&cn, wx as f64, wy as f64, &ccfg, t_height);
            let top = chunk_get(&chunks[cy * wc + cx], lx, ly, h);
            assert!(top == 8 || top == 2, "classic-biome cap must be grass or stone, got {top}");
            assert_ne!(chunk_get(&chunks[cy * wc + cx], lx, ly, h - 1), 0, "cap must rest on a solid body");
            if top == 8 { grass_caps += 1; } else { stone_caps += 1; }
        }}
    }}
    assert!(grass_caps > 0, "classic biome should have grassy soil columns");
    assert!(stone_caps > 0, "classic biome should expose stone outcrops top-down");

    // Classic+ supports standing water (unlike the legacy Classic tab): a low
    // water level must place water blocks.
    let mut wet = base; wet.water_z = (base.base_height as i32 + 6).max(1);
    let mut wch: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_natural_world(&mut wch, wc, hc, &wet, t_height, &mut |_, _| {});
    assert!(count_blocks(&wch, t_height, 20) > 0, "Classic+ with water should place water blocks");

    // Caves on vs off: enabling caves must remove some stone (carve air).
    let mut caves_off = base; caves_off.cave_density = 0;
    let mut on = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect::<Vec<_>>();
    let mut off = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect::<Vec<_>>();
    let mut on_cfg = base; on_cfg.cave_density = 2;
    generate_natural_world(&mut on,  wc, hc, &on_cfg,    t_height, &mut |_, _| {});
    generate_natural_world(&mut off, wc, hc, &caves_off, t_height, &mut |_, _| {});
    let stone_on  = count_blocks(&on,  t_height, 2);
    let stone_off = count_blocks(&off, t_height, 2);
    assert!(stone_on < stone_off, "classic caves should carve stone: on={stone_on} off={stone_off}");
}

/// Snow biome foliage must use the cold palette: white-painted weeds, frosted
/// (white / light-gray) tree leaves, and white/blue flowers — never the default
/// green / warm paints.
#[test]
pub(crate) fn natural_snow_foliage_is_cold() {
    let (wc, hc) = (6usize, 6usize);
    let t_height = 64usize;
    let cfg = NaturalConfig {
        seed: 808, base_height: 28, roughness: 0.5, erosion: 0.0, terrain_scale: 120.0, extreme: false,
        water_z: -1, rivers: false, biome: 2, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
        tree_density_denom: 6, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
        ore_density: 0, vegetation: 2, structures: 0, clouds: false,
    };
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_natural_world(&mut chunks, wc, hc, &cfg, t_height, &mut |_, _| {});

    let (mut weeds, mut leaves, mut flowers) = (0u32, 0u32, 0u32);
    for cy in 0..hc { for cx in 0..wc {
        let data = &chunks[cy * wc + cx];
        for lx in 0..16 { for ly in 0..16 { for z in 0..t_height {
            let bt = chunk_get(data, lx, ly, z);
            let p = chunk_get_paint(data, lx, ly, z);
            match bt {
                11 => { weeds += 1; assert_eq!(p, 9, "snow weeds must be white"); }
                5  => { leaves += 1; assert!(SNOW_LEAF_PAINTS.contains(&p), "snow leaves must be frosted, got paint {p}"); }
                73 => { flowers += 1; assert!(SNOW_FLOWER_PAINTS.contains(&p), "snow flowers must be cold, got paint {p}"); }
                _ => {}
            }
        }}}
    }}
    assert!(weeds > 0 && leaves > 0 && flowers > 0,
        "expected snow weeds ({weeds}), leaves ({leaves}) and flowers ({flowers})");
}

/// Mixed-biome mode must vary the per-column biome across space (and stay
/// constant in single mode), and a generated mixed world must contain more
/// than one biome's surface material.
#[test]
pub(crate) fn natural_mixed_biomes_vary() {
    let cfg = NaturalConfig {
        seed: 2026, base_height: 30, roughness: 0.6, erosion: 0.0, terrain_scale: 120.0, extreme: false,
        water_z: -1, rivers: false, biome: 0, biome_mode: 1, biome_scale: 30.0, snow_caps: false,
        tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
        ore_density: 0, vegetation: 0, structures: 0, clouds: false,
    };
    // biome_at returns several distinct biomes over a wide area (altitude held
    // constant so this isolates the temperature/moisture blend).
    let mut seen = HashSet::new();
    for wy in 0..256i32 {
        for wx in 0..256i32 {
            seen.insert(biome_at(wx, wy, cfg.base_height, &cfg, 64));
        }
    }
    assert!(seen.len() >= 2, "mixed mode should yield multiple biomes, got {seen:?}");

    // Single mode is constant regardless of position.
    let mut single = cfg; single.biome_mode = 0; single.biome = 1;
    for wy in 0..40i32 {
        for wx in 0..40i32 {
            assert_eq!(biome_at(wx, wy, 30, &single, 64), 1, "single mode must be constant");
        }
    }

    // A generated mixed world contains both desert sand and grassland grass.
    let (wc, hc) = (8usize, 8usize);
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_natural_world(&mut chunks, wc, hc, &cfg, 64, &mut |_, _| {});
    assert!(count_blocks(&chunks, 64, 4) > 0, "mixed world should have desert sand");
    assert!(count_blocks(&chunks, 64, 8) > 0, "mixed world should have grassland grass");
}

/// Erosion is a relief multiplier that only ever *reduces* amplitude (it can
/// never add relief), so a strong-erosion world must read flatter than the
/// same seed with erosion off — the std-dev of the heightmap drops.
#[test]
pub(crate) fn natural_erosion_flattens() {
    let base = NaturalConfig {
        seed: 31337, base_height: 30, roughness: 1.0, erosion: 0.0, terrain_scale: 90.0, extreme: false,
        water_z: -1, rivers: false, biome: 0, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
        tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
        ore_density: 0, vegetation: 0, structures: 0, clouds: false,
    };
    // Standard deviation of terrain_height sampled over a wide region.
    let relief_std = |cfg: &NaturalConfig| -> f64 {
        let mut hs = Vec::new();
        for wy in 0..256i32 { for wx in 0..256i32 {
            hs.push(terrain_height(wx as f64, wy as f64, cfg, 64) as f64);
        }}
        let mean = hs.iter().sum::<f64>() / hs.len() as f64;
        (hs.iter().map(|h| (h - mean).powi(2)).sum::<f64>() / hs.len() as f64).sqrt()
    };

    let flat = base; // erosion 0.0
    let mut rugged = base; rugged.erosion = 1.0; // strong erosion → flatter
    let s_none = relief_std(&flat);
    let s_strong = relief_std(&rugged);
    assert!(s_strong < s_none,
        "strong erosion should flatten relief: std {s_strong} !< {s_none}");
}

/// The biome-edge dither perturbs each column's climate by a small per-cell
/// jitter, so a mixed-mode biome map has *more* short-range boundary flips
/// (speckled edges) than the same climate fields evaluated without jitter.
#[test]
pub(crate) fn natural_biome_band_dithers() {
    let cfg = NaturalConfig {
        seed: 5150, base_height: 30, roughness: 0.0, erosion: 0.0, terrain_scale: 120.0, extreme: false,
        water_z: -1, rivers: false, biome: 0, biome_mode: 1, biome_scale: 24.0, snow_caps: false,
        tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
        ore_density: 0, vegetation: 0, structures: 0, clouds: false,
    };
    // Surface held at base_height so altitude lapse is zero and this isolates
    // the temperature/moisture dither. Baseline replicates biome_at's threshold
    // decision *without* the per-column jitter.
    let baseline = |wx: i32, wy: i32| -> u8 {
        let (temp, moist) = biome_climate(wx, wy, &cfg);
        if temp < -0.28 { 2 } else if temp > 0.18 && moist < -0.05 { 1 } else { 0 }
    };
    let count_flips = |f: &dyn Fn(i32, i32) -> u8| -> u32 {
        let mut flips = 0u32;
        for wy in 0..256i32 {
            for wx in 0..255i32 {
                if f(wx, wy) != f(wx + 1, wy) { flips += 1; }
            }
        }
        flips
    };
    let real = count_flips(&|wx, wy| biome_at(wx, wy, cfg.base_height, &cfg, 64));
    let plain = count_flips(&baseline);
    assert!(real > plain,
        "dither should add boundary speckle: {real} !> {plain}");
}

/// The preview command returns a correctly-sized, non-blank RGB image and
/// honours the `max_px` cap.
#[test]
pub(crate) fn natural_preview_renders() {
    let img = preview_natural_world(
        16, 16, false,
        7, 30, 2, 1, 1, false,
        "lakes".into(), true,
        "grassland".into(), 1, 1, true,
        2, 1, 0, true, false, 1, 1, 1, true,
        64,
    ).expect("preview failed");
    assert!(img.width <= 64 && img.height <= 64, "preview must respect max_px");
    assert_eq!(img.pixels.len(), (img.width * img.height * 4) as usize, "RGBA buffer size");
    assert!(img.pixels.iter().any(|&c| c != 0), "preview should not be blank");
}

/// Classic and Tg2 previews render non-blank, correctly-sized RGBA images; the Tg2 shade is
/// no longer a constant (a mountainous biome must vary in brightness).
#[test]
pub(crate) fn classic_and_tg2_previews_render() {
    let img = preview_classic_world(16, 16, false, 7, 2, 32, 64).expect("classic preview");
    assert!(img.width <= 64 && img.height <= 64);
    assert_eq!(img.pixels.len(), (img.width * img.height * 4) as usize);
    assert!(img.pixels.iter().any(|&c| c != 0));
    let t = preview_tg2_world(16, 7, 3, 64, None, None, None, None).expect("tg2 preview");
    assert_eq!(t.pixels.len(), (t.width * t.height * 4) as usize);
    let lum: std::collections::HashSet<u8> = t.pixels.chunks(4).map(|p| p[0]).collect();
    assert!(lum.len() > 8, "tg2 preview should be shaded, got {} distinct reds", lum.len());
}

/// A create is atomic: the file only appears complete (no `.tmp` left), and a cancel leaves
/// neither the destination nor a temp behind and surfaces as the `Cancelled` error.
#[test]
pub(crate) fn world_create_is_atomic_and_cancellable() {
    let p = std::env::temp_dir().join("eden_atomic_create.eden");
    let ps = p.to_str().unwrap().to_string();
    let tmp = format!("{ps}.tmp");
    let _ = fs::remove_file(&p); let _ = fs::remove_file(&tmp);
    create_classic_world_inner(ps.clone(), "Atomic".into(), 2, 2, false, 7, 2, 0, true, false, 1, true, true, &mut |_, _| {})
        .expect("create failed");
    assert!(p.exists() && !std::path::Path::new(&tmp).exists(), "complete file, no temp");
    let _ = fs::remove_file(&p);

    // Cancel from the first progress callback: generation stops, nothing is written.
    let r = create_classic_world_inner(ps.clone(), "Atomic".into(), 4, 4, false, 7, 2, 0, true, false, 1, true, true,
        &mut |_, _| cancel_world_gen());
    assert_eq!(r.unwrap_err(), GEN_CANCELLED);
    assert!(!p.exists() && !std::path::Path::new(&tmp).exists(), "cancel leaves no file");
}

/// Steep terrain must expose bare rock at the surface (cliff faces), while
/// perfectly flat terrain keeps its soil surface.
#[test]
pub(crate) fn natural_cliffs_expose_rock() {
    let t_height = 64usize;
    // Surface block = first non-air scanning down from the top of a column.
    let surface_of = |data: &Vec<u8>, lx: usize, ly: usize| -> u8 {
        for z in (0..t_height).rev() {
            let b = chunk_get(data, lx, ly, z);
            if b != 0 { return b; }
        }
        0
    };

    // Jagged, dry grassland → some columns are steep enough to show stone.
    let jagged = NaturalConfig {
        seed: 555, base_height: 30, roughness: 1.05, erosion: 0.0, terrain_scale: 60.0, extreme: false,
        water_z: -1, rivers: false, biome: 0, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
        tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
        ore_density: 0, vegetation: 0, structures: 0, clouds: false,
    };
    let (wc, hc) = (4usize, 4usize);
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_natural_world(&mut chunks, wc, hc, &jagged, t_height, &mut |_, _| {});
    let mut rock = 0;
    for cy in 0..hc { for cx in 0..wc {
        let data = &chunks[cy * wc + cx];
        for lx in 0..16 { for ly in 0..16 {
            if surface_of(data, lx, ly) == 2 { rock += 1; }
        }}
    }}
    assert!(rock > 0, "jagged terrain should expose surface rock on cliffs");

    // Flat terrain → centre column surface stays grass, never stone.
    let mut flat = jagged; flat.roughness = 0.0;
    let mut fc: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    let center = generate_natural_world(&mut fc, wc, hc, &flat, t_height, &mut |_, _| {});
    assert_eq!(chunk_get(&fc[0], 8, 8, center), 8, "flat terrain centre must stay grass");
}

/// Weeds (block 11) are a solid grass variant and must replace the surface
/// block, never stack on top of grass — regression guard for the bug where
/// they floated one cell above the grass surface.
#[test]
pub(crate) fn natural_weeds_flush_with_surface() {
    let (wc, hc) = (4usize, 4usize);
    let t_height = 64usize;
    let cfg = NaturalConfig {
        seed: 123, base_height: 30, roughness: 0.5, erosion: 0.0, terrain_scale: 110.0, extreme: false,
        water_z: -1, rivers: false, biome: 0, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
        tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
        ore_density: 0, vegetation: 2, structures: 0, clouds: false,
    };
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_natural_world(&mut chunks, wc, hc, &cfg, t_height, &mut |_, _| {});

    let mut weeds = 0usize;
    for cy in 0..hc {
        for cx in 0..wc {
            let data = &chunks[cy * wc + cx];
            for lx in 0..16 { for ly in 0..16 { for z in 1..t_height {
                if chunk_get(data, lx, ly, z) == 11 {
                    weeds += 1;
                    // The old bug placed weeds one cell above the grass, so a
                    // weed sat directly on a grass/weeds block. A flush weed
                    // replaces the surface and rests on dirt/stone instead.
                    let below = chunk_get(data, lx, ly, z - 1);
                    assert!(below != 8 && below != 11,
                        "weed at local ({lx},{ly},{z}) stacks on grass/weeds ({below}) — should be flush");
                }
            }}}
        }
    }
    assert!(weeds > 0, "expected some weeds to be generated");
}

/// No foliage may share a column with standing water — guards the fix for
/// vegetation/tree canopy appearing on or overhanging water.
#[test]
pub(crate) fn natural_generator_no_foliage_on_water() {
    let (wc, hc) = (4usize, 4usize);
    let t_height = 64usize;
    let cfg = NaturalConfig {
        seed: 99, base_height: 30, roughness: 0.9, erosion: 0.0, terrain_scale: 90.0, extreme: false,
        water_z: 26, rivers: true, biome: 0, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
        tree_density_denom: 8, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
        ore_density: 0, vegetation: 2, structures: 0, clouds: false,
    };
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_natural_world(&mut chunks, wc, hc, &cfg, t_height, &mut |_, _| {});

    let is_foliage = |b: u8| matches!(b, 5 | 6 | 11 | 16 | 73);
    for cy in 0..hc {
        for cx in 0..wc {
            let data = &chunks[cy * wc + cx];
            for lx in 0..16 {
                for ly in 0..16 {
                    let mut has_water = false;
                    let mut has_foliage = false;
                    for z in 0..t_height {
                        match chunk_get(data, lx, ly, z) {
                            20 | 15 => has_water = true,
                            b if is_foliage(b) => has_foliage = true,
                            _ => {}
                        }
                    }
                    assert!(!(has_water && has_foliage),
                        "foliage shares a column with water at chunk ({cx},{cy}) local ({lx},{ly})");
                }
            }
        }
    }
}

pub(crate) fn classic_cfg(seed: u32, caves: bool, trees: u64) -> ClassicConfig {
    ClassicConfig {
        seed, variance: 3.0, base_height: 32, gen_caves: caves, tall_caves: false,
        tree_spacing: trees, flowers: true, clouds: true,
    }
}

pub(crate) fn count_blocks(chunks: &[Vec<u8>], t_height: usize, bt: u8) -> usize {
    let mut n = 0;
    for data in chunks {
        for lx in 0..16 { for ly in 0..16 { for z in 0..t_height {
            if chunk_get(data, lx, ly, z) == bt { n += 1; }
        }}}
    }
    n
}

/// Flowers (block 73) must stay sparse — too many crash the modern game's
/// sprite loader — and must be absent entirely when the option is off.
#[test]
pub(crate) fn classic_flowers_are_sparse() {
    let (wc, hc) = (4usize, 4usize);
    let t_height = 64usize;

    let mut on: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_classic_world(&mut on, wc, hc, &classic_cfg(2024, true, 0), t_height, &mut |_, _| {});
    let flowers = count_blocks(&on, t_height, 73);
    let grass   = count_blocks(&on, t_height, 8);
    assert!(grass > 0, "expected a grass surface");
    // Far below the ~25% surface coverage of the old (crashing) decoration.
    assert!(flowers * 20 < grass, "flowers not sparse: {flowers} flowers vs {grass} grass");

    let mut off_cfg = classic_cfg(2024, true, 0);
    off_cfg.flowers = false;
    let mut off: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_classic_world(&mut off, wc, hc, &off_cfg, t_height, &mut |_, _| {});
    assert_eq!(count_blocks(&off, t_height, 73), 0, "flowers present with option off");
}

/// The header `version` field selects the column format the game expects:
/// 64z legacy worlds = ≤4, New Dawn 256z worlds = ≥5 (5/6 observed in the wild).
/// Writing 4 for a 256z world makes the game misread it as 64z (the
/// "legacy-conversion" corruption look).
#[test]
pub(crate) fn world_file_version_matches_format() {
    for (extended, want_version, want_stride) in [(false, 4u32, 32_768u64), (true, 5u32, 131_072u64)] {
        let p = std::env::temp_dir().join(format!("eden_ver_{extended}.eden"));
        let ps = p.to_str().unwrap().to_string();
        let _ = fs::remove_file(&p);
        create_classic_world_inner(
            ps.clone(), "VerTest".into(),
            2, 2, extended,
            7, 2, 0, true, false, 1, true, true,
            &mut |_, _| {},
        ).expect("create failed");

        let b = fs::read(&p).expect("read back");
        let version = u32::from_le_bytes(b[92..96].try_into().unwrap());
        assert_eq!(version, want_version, "wrong version for extended={extended}");

        // Column stride = gap between the first two directory entries.
        let diro = u64::from_le_bytes(b[32..40].try_into().unwrap()) as usize;
        let off0 = u64::from_le_bytes(b[diro + 8..diro + 16].try_into().unwrap());
        let off1 = u64::from_le_bytes(b[diro + 24..diro + 32].try_into().unwrap());
        assert_eq!(off1 - off0, want_stride, "wrong column stride for extended={extended}");

        let _ = fs::remove_file(&p);
    }
}

pub(crate) fn tg2_cfg(seed: u32, terrain_type: u8) -> Tg2Config {
    Tg2Config {
        seed, terrain_type, sky_islands: false, struct_freq: 1, clouds: false,
        amplitude: 1.0, sea_level_off: 0, blend: false,
        caves: false, tall_caves: false, custom_biomes: [0,6,4,2],
    }
}

/// A 256z (New Dawn) TG2 world must proportionally fill the taller space —
/// its surface should track ~t_height/2 (≈128), not stay pinned near the
/// legacy 64z baseline (~32). 64z generation must be unaffected (vs=1.0).
#[test]
pub(crate) fn tg2_scales_to_extended_height() {
    let (wc, hc) = (4usize, 4usize);
    let cfg = tg2_cfg(4242, 0); // Plains: baseline = t_height/2

    let mut c64: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    let surf64 = generate_tg2_world(&cfg, wc, hc, 64, &mut c64, &mut |_, _| {});

    let mut c256: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 131_072]).collect();
    let surf256 = generate_tg2_world(&cfg, wc, hc, 256, &mut c256, &mut |_, _| {});

    assert!((20..45).contains(&surf64), "64z plains surface off baseline: {surf64}");
    assert!((100..160).contains(&surf256), "256z plains surface did not fill height: {surf256}");

    // The tall world must carry solid terrain well above the legacy 64-block
    // ceiling (surf64 ≈ baseline already proves the 64z path is unchanged).
    let mut solid_high = false;
    'o: for data in &c256 {
        for lx in 0..16 { for ly in 0..16 {
            for z in 100..130 { if chunk_get(data, lx, ly, z) != 0 { solid_high = true; break 'o; } }
        }}
    }
    assert!(solid_high, "256z world has no terrain near z=128");
}

/// The biome-blend pass smooths surface seams in *both* directions (it may
/// raise low columns and carve high ones), so the average step between
/// neighbouring surface heights must drop after blending.
#[test]
pub(crate) fn tg2_blend_smooths_both_directions() {
    let (wc, hc) = (6usize, 6usize);
    let bw = wc * 16;
    // Build a top-down surface-height map from chunk storage.
    let surface_map = |chunks: &[Vec<u8>]| -> Vec<i32> {
        let mut m = vec![0i32; bw * bw];
        for cy in 0..hc { for cx in 0..wc {
            let data = &chunks[cy * wc + cx];
            for ly in 0..16 { for lx in 0..16 {
                let mut h = 0i32;
                for z in (0..64).rev() { if chunk_get(data, lx, ly, z) != 0 { h = z as i32 + 1; break; } }
                let (wx, wyy) = (cx * 16 + lx, cy * 16 + ly);
                m[wyy * bw + wx] = h;
            }}
        }}
        m
    };
    // Mean absolute height difference to the east/south neighbour.
    let roughness = |m: &[i32]| -> f64 {
        let (mut sum, mut cnt) = (0i64, 0i64);
        for y in 0..bw { for x in 0..bw {
            let h = m[y * bw + x];
            if x + 1 < bw { sum += (h - m[y * bw + x + 1]).unsigned_abs() as i64; cnt += 1; }
            if y + 1 < bw { sum += (h - m[(y + 1) * bw + x]).unsigned_abs() as i64; cnt += 1; }
        }}
        sum as f64 / cnt.max(1) as f64
    };

    let mut plain: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_tg2_world(&tg2_cfg(99, 7), wc, hc, 64, &mut plain, &mut |_, _| {});

    let mut blended_cfg = tg2_cfg(99, 7);
    blended_cfg.blend = true;
    let mut blended: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_tg2_world(&blended_cfg, wc, hc, 64, &mut blended, &mut |_, _| {});

    let r_plain = roughness(&surface_map(&plain));
    let r_blended = roughness(&surface_map(&blended));
    assert!(r_blended < r_plain,
        "blend did not smooth seams: {r_blended} !< {r_plain}");
}

/// The reworked `tg2_make_transition` warps the seam with low-frequency noise,
/// so the material boundary between two biomes wanders across rows instead of
/// tracing a single straight axis-aligned column.
#[test]
pub(crate) fn tg2_warped_borders_not_axis_aligned() {
    let (gsize, th) = (128usize, 64usize);
    let mut g = Tg2Grid::new(gsize, th, 1.0, 1.0, 0);
    // Left half: sand (4) at height 20; right half: stone (2) at height 30.
    for x in 0..64i32 { for z in 0..gsize as i32 {
        for y in 1..20 { g.put(x, z, y, 4, 0); }
    }}
    for x in 64..gsize as i32 { for z in 0..gsize as i32 {
        for y in 1..30 { g.put(x, z, y, 2, 0); }
    }}
    let noise = ClassicNoise::new(777);
    let (sx, ex) = (48i32, 80i32);
    tg2_make_transition(&mut g, &noise, 777.0, sx, 0, ex, gsize as i32);

    // For each row, find the first x inside the band whose surface is stone (2).
    let surface_switch = |g: &Tg2Grid, z: i32| -> i32 {
        for x in sx..ex {
            let mut top = 0u8;
            for y in (1..th as i32).rev() { let b = g.get(x, z, y); if b != 0 { top = b; break; } }
            if top == 2 { return x; }
        }
        ex
    };
    let mut switches = std::collections::HashSet::new();
    for z in 0..gsize as i32 { switches.insert(surface_switch(&g, z)); }
    assert!(switches.len() >= 3,
        "transition seam is too straight (axis-aligned): only {} distinct switch columns", switches.len());
}

/// Weeds (block 11) must appear on the surface but stay at most half of the
/// ground cover (grass 8 + weeds 11) — too many were never the crash cause
/// (flowers were), but the legacy look keeps grass dominant.
#[test]
pub(crate) fn classic_weeds_present_and_bounded() {
    let (wc, hc) = (4usize, 4usize);
    let t_height = 64usize;
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_classic_world(&mut chunks, wc, hc, &classic_cfg(2024, true, 0), t_height, &mut |_, _| {});
    let grass = count_blocks(&chunks, t_height, 8);
    let weeds = count_blocks(&chunks, t_height, 11);
    assert!(weeds > 0, "expected some tall grass / weeds on the surface");
    assert!(weeds <= grass, "weeds ({weeds}) exceed half the ground cover (grass {grass})");
}

/// Tall caves must carve open air higher up (closer to the surface) than the
/// shallow legacy cave band, and produce variegated walls (slate, type 14).
#[test]
pub(crate) fn classic_tall_caves_reach_higher() {
    let (wc, hc) = (4usize, 4usize);
    let t_height = 64usize;
    // Highest *deep* air cell (≥8 below the column's surface, so the legacy
    // holey dirt skin is excluded and only caves count).
    let highest_cave_air = |chunks: &[Vec<u8>]| -> i32 {
        let mut hi = -1i32;
        for data in chunks {
            for lx in 0..16 { for ly in 0..16 {
                let mut top = 0i32;
                for z in 0..t_height { if chunk_get(data, lx, ly, z) != 0 { top = z as i32; } }
                for z in (1..=(top - 8).max(0)).rev() {
                    if chunk_get(data, lx, ly, z as usize) == 0 { if z > hi { hi = z; } break; }
                }
            }}
        }
        hi
    };
    let mut normal_cfg = classic_cfg(2024, true, 0);
    normal_cfg.clouds = false; // clouds raise `top` and leak sky air into the measure
    let mut normal: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_classic_world(&mut normal, wc, hc, &normal_cfg, t_height, &mut |_, _| {});
    let mut tall_cfg = normal_cfg;
    tall_cfg.tall_caves = true;
    let mut tall: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_classic_world(&mut tall, wc, hc, &tall_cfg, t_height, &mut |_, _| {});

    assert!(highest_cave_air(&tall) > highest_cave_air(&normal),
        "tall caves ({}) should reach higher than normal caves ({})",
        highest_cave_air(&tall), highest_cave_air(&normal));
    // Tall caves use the same materials as normal caves: stone (2) + dark
    // stone (10) only — no cobblestone/slate (14).
    assert_eq!(count_blocks(&tall, t_height, 14), 0, "tall caves must not contain slate/cobblestone");
}

/// The classic generator must run cross-chunk without panicking, lay bedrock,
/// fill terrain, and produce a grass surface somewhere.
#[test]
pub(crate) fn classic_generator_fills_terrain() {
    let (wc, hc) = (3usize, 3usize);
    let t_height = 64usize;
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    let center = generate_classic_world(&mut chunks, wc, hc, &classic_cfg(2024, true, 50), t_height, &mut |_, _| {});
    assert!(center >= 3 && center < t_height, "centre surface z out of range: {center}");

    let mut grass = 0usize;
    for data in &chunks {
        for lx in 0..16 {
            for ly in 0..16 {
                assert_eq!(chunk_get(data, lx, ly, 0), 1, "missing bedrock");
                for z in 1..t_height {
                    if matches!(chunk_get(data, lx, ly, z), 8 | 11) { grass += 1; }
                }
            }
        }
    }
    assert!(grass > 0, "classic terrain produced no grass surface");
}

/// With caves on, the carved 3D-noise tunnels must open at least one interior
/// air cell that would be solid stone when caves are disabled.
#[test]
pub(crate) fn classic_generator_caves_carve_air() {
    let (wc, hc) = (3usize, 3usize);
    let t_height = 64usize;
    let cfg_caves = classic_cfg(555, true, 0);
    let cfg_solid = classic_cfg(555, false, 0);

    // Heightmap is identical for both (same seed); compare interior fills.
    let noise = ClassicNoise::new(555);
    let bw = wc * 16;
    let mut carved_air = 0usize;
    for cy in 0..hc {
        for cx in 0..wc {
            let mut a = vec![0u8; 32_768];
            let mut b = vec![0u8; 32_768];
            let mut heights = vec![0u16; bw * (hc * 16)];
            for wy in 0..(hc * 16) {
                for wx in 0..bw {
                    heights[wy * bw + wx] = classic_height(&noise, wx as f64, wy as f64, &cfg_caves, t_height) as u16;
                }
            }
            fill_classic_chunk(&mut a, cx, cy, wc, &heights, &cfg_caves, &noise, t_height);
            fill_classic_chunk(&mut b, cx, cy, wc, &heights, &cfg_solid, &noise, t_height);
            for lx in 0..16 {
                for ly in 0..16 {
                    for z in 1..t_height {
                        if chunk_get(&a, lx, ly, z) == 0 && chunk_get(&b, lx, ly, z) == 2 {
                            carved_air += 1;
                        }
                    }
                }
            }
        }
    }
    assert!(carved_air > 0, "caves did not carve any air pockets");
}

/// Every tree trunk must sit on grass (8) or tall grass / weeds (11).
#[test]
pub(crate) fn classic_trees_only_on_grass() {
    let (wc, hc) = (4usize, 4usize);
    let t_height = 64usize;
    let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
    generate_classic_world(&mut chunks, wc, hc, &classic_cfg(31337, false, 12), t_height, &mut |_, _| {});

    let water_mask = vec![false; wc * 16 * hc * 16];
    let gen = WorldGen { chunks: &mut chunks, wc, hc, t_height, water_mask: &water_mask };
    let mut trunk_bases = 0usize;
    for wy in 0..(hc * 16) as i32 {
        for wx in 0..(wc * 16) as i32 {
            for z in 1..t_height as i32 {
                if gen.get(wx, wy, z) == 6 && gen.get(wx, wy, z - 1) != 6 {
                    // Bottom of a trunk: the block below must be grass/weeds.
                    let below = gen.get(wx, wy, z - 1);
                    assert!(below == 8 || below == 11,
                        "trunk base at ({wx},{wy},{z}) sits on block {below}, not grass/weeds");
                    trunk_bases += 1;
                }
            }
        }
    }
    assert!(trunk_bases > 0, "no trees were generated to validate");
}

/// Full-file identity: parsing a fixture and saving it back without any edits
/// must reproduce the original bytes exactly (not just header + pointer table).
#[test]
pub(crate) fn test_parse_save_parse_full_identity() {
    let original = make_test_world();
    let world = parse_world_inner(mmap_from_bytes(original.clone())).expect("parse failed");

    let tmp = std::env::temp_dir().join("eden_test_full_identity.eden");
    let _ = fs::remove_file(&tmp);
    save_world_inner(&world, tmp.to_str().unwrap(), false).expect("save failed");

    let saved_bytes = fs::read(&tmp).expect("read back failed");
    assert_eq!(original, saved_bytes, "unedited save must be byte-identical to the source file");

    // Re-parsing the saved file must reproduce the same test blocks.
    let world2 = parse_world_inner(mmap_from_bytes(saved_bytes)).expect("re-parse failed");
    assert_eq!(world2.bytes[blk(3, 5, 0)], 7, "Wood survives parse->save->parse");
    assert_eq!(world2.bytes[blk(3, 5, 17)], 2, "Stone survives parse->save->parse");
    assert_eq!(world2.bytes[pnt(3, 5, 17)], 5, "paint survives parse->save->parse");
    assert_eq!(world2.bytes[blk(3, 5, 48)], 3, "Dirt survives parse->save->parse");
    assert_eq!(world2.bytes[blk(7, 2, 32)], 8, "bystander survives parse->save->parse");

    let _ = fs::remove_file(&tmp);
}

/// rotate_ramp_id_cw: offset shifts +3 mod 4 (i.e. -1 mod 4) within each
/// directional family, and four rotations return to the original ID.
#[test]
pub(crate) fn test_rotate_ramp_id_cw_offsets() {
    // Ramps: base 24 (S/W/N/E = off 0/1/2/3). CW rotation: S->E->N->W->S.
    assert_eq!(rotate_ramp_id_cw(24), 27, "ramp S -> E");
    assert_eq!(rotate_ramp_id_cw(27), 26, "ramp E -> N");
    assert_eq!(rotate_ramp_id_cw(26), 25, "ramp N -> W");
    assert_eq!(rotate_ramp_id_cw(25), 24, "ramp W -> S");

    // Wedges: base 40 (SE/SW/NW/NE = off 0/1/2/3).
    assert_eq!(rotate_ramp_id_cw(40), 43);
    assert_eq!(rotate_ramp_id_cw(43), 42);
    assert_eq!(rotate_ramp_id_cw(42), 41);
    assert_eq!(rotate_ramp_id_cw(41), 40);

    // Doors 66-69 and portals 75-78 follow the same +3 mod 4 rule.
    assert_eq!(rotate_ramp_id_cw(66), 69);
    assert_eq!(rotate_ramp_id_cw(75), 78);

    // Four rotations is the identity for every family base.
    for base in [24u8, 28, 32, 36, 40, 44, 48, 52] {
        let mut bt = base;
        for _ in 0..4 { bt = rotate_ramp_id_cw(bt); }
        assert_eq!(bt, base, "4x rotation must return to start for base {base}");
    }

    // Non-directional block types pass through unchanged.
    assert_eq!(rotate_ramp_id_cw(2), 2, "stone is not directional");
    assert_eq!(rotate_ramp_id_cw(0), 0, "air is not directional");
}

/// mirror_ramp_id_x/y: involutions (applying twice returns the original ID)
/// and the specific S/W/N/E and SE/SW/NW/NE swaps documented on the functions.
#[test]
pub(crate) fn test_mirror_ramp_id_offsets() {
    // X mirror: ramps E(3)<->W(1), S(0)/N(2) unchanged.
    assert_eq!(mirror_ramp_id_x(24), 24, "ramp S unchanged under X mirror");
    assert_eq!(mirror_ramp_id_x(26), 26, "ramp N unchanged under X mirror");
    assert_eq!(mirror_ramp_id_x(25), 27, "ramp W -> E under X mirror");
    assert_eq!(mirror_ramp_id_x(27), 25, "ramp E -> W under X mirror");

    // Y mirror: ramps S(0)<->N(2), E(3)/W(1) unchanged.
    assert_eq!(mirror_ramp_id_y(24), 26, "ramp S -> N under Y mirror");
    assert_eq!(mirror_ramp_id_y(26), 24, "ramp N -> S under Y mirror");
    assert_eq!(mirror_ramp_id_y(25), 25, "ramp W unchanged under Y mirror");

    // Wedges: X mirror flips the E/W component (off ^ 1); Y mirror flips N/S (off ^ 3).
    for off in 0u8..4 {
        let bt = 40 + off;
        assert_eq!(mirror_ramp_id_x(bt), 40 + (off ^ 1));
        assert_eq!(mirror_ramp_id_y(bt), 40 + (off ^ 3));
    }

    // Both mirrors are involutions: applying twice is the identity.
    for bt in [24u8, 25, 26, 27, 40, 41, 42, 43, 66, 67, 68, 69, 75, 76, 77, 78] {
        assert_eq!(mirror_ramp_id_x(mirror_ramp_id_x(bt)), bt, "X mirror twice = identity for {bt}");
        assert_eq!(mirror_ramp_id_y(mirror_ramp_id_y(bt)), bt, "Y mirror twice = identity for {bt}");
    }

    assert_eq!(mirror_ramp_id_x(2), 2, "stone is not directional");
}

pub(crate) fn make_test_clipboard() -> Clipboard {
    // 2 (w) x 3 (h) x 1 (depth) clipboard.
    // Layout (row-major, dy*width+dx):
    //   dy=0: [ramp-S(24), wedge-SE(40)]
    //   dy=1: [stone(2),   air(0)]
    //   dy=2: [ramp-E(27), dirt(3)]
    let block_types = vec![
        24, 40,
        2, 0,
        27, 3,
    ];
    let paints = vec![
        1, 2,
        0, 0,
        3, 4,
    ];
    Clipboard { width: 2, height: 3, depth: 1, z_anchor: 10, block_types, paints, mask: None, origin: None }
}

/// rotate_clipboard_inner: dimensions swap (w,h)->(h,w), content transform
/// matches (dx,dy)->(dy, old_w-1-dx), and directional IDs are rotated CW.
#[test]
pub(crate) fn test_rotate_clipboard_inner() {
    let mut cb = make_test_clipboard();
    rotate_clipboard_inner(&mut cb);

    assert_eq!(cb.width, 3, "new width = old height");
    assert_eq!(cb.height, 2, "new height = old width");
    assert_eq!(cb.z_anchor, 10, "z_anchor untouched by XY rotation");

    // Source (dx=0,dy=0)=ramp-S(24) -> dest (ndx=0, ndy=old_w-1-0=1) -> rotated to ramp-E(27)
    let at = |cb: &Clipboard, x: usize, y: usize| -> (u8, u8) {
        let i = y * cb.width as usize + x;
        (cb.block_types[i], cb.paints[i])
    };
    assert_eq!(at(&cb, 0, 1), (27, 1), "ramp-S rotates to ramp-E and keeps its paint");
    // Source (dx=1,dy=2)=dirt(3) -> dest (ndx=2, ndy=old_w-1-1=0)
    assert_eq!(at(&cb, 2, 0), (3, 4), "dirt (non-directional) keeps id, moves per rotation, keeps paint");

    // Four rotations restores original dimensions and content.
    rotate_clipboard_inner(&mut cb);
    rotate_clipboard_inner(&mut cb);
    rotate_clipboard_inner(&mut cb);
    let original = make_test_clipboard();
    assert_eq!(cb.width, original.width);
    assert_eq!(cb.height, original.height);
    assert_eq!(cb.block_types, original.block_types, "4x rotation restores block types");
    assert_eq!(cb.paints, original.paints, "4x rotation restores paints");
}

/// mirror_clipboard_x_inner / mirror_clipboard_y_inner: dimensions unchanged,
/// content reversed along the mirrored axis, directional IDs remapped, involution holds.
#[test]
pub(crate) fn test_mirror_clipboard_inner() {
    let mut cb = make_test_clipboard();
    mirror_clipboard_x_inner(&mut cb);
    assert_eq!((cb.width, cb.height), (2, 3), "X mirror keeps dimensions");
    let at = |cb: &Clipboard, x: usize, y: usize| -> (u8, u8) {
        let i = y * cb.width as usize + x;
        (cb.block_types[i], cb.paints[i])
    };
    // dy=0 row [ramp-S(24), wedge-SE(40)] mirrors to [wedge-SW(41), ramp-S(24)]
    assert_eq!(at(&cb, 0, 0), (41, 2), "wedge-SE moves to x=0 and mirrors to SW");
    assert_eq!(at(&cb, 1, 0), (24, 1), "ramp-S moves to x=1, S is unchanged by X mirror");

    // Involution: mirroring twice restores the original.
    mirror_clipboard_x_inner(&mut cb);
    let original = make_test_clipboard();
    assert_eq!(cb.block_types, original.block_types, "2x X-mirror restores block types");
    assert_eq!(cb.paints, original.paints, "2x X-mirror restores paints");

    let mut cb_y = make_test_clipboard();
    mirror_clipboard_y_inner(&mut cb_y);
    assert_eq!((cb_y.width, cb_y.height), (2, 3), "Y mirror keeps dimensions");
    // dy=0 row moves to dy=2, ramp-S(24) mirrors to ramp-N(26)
    assert_eq!(at(&cb_y, 0, 2), (26, 1), "ramp-S moves to y=2 and mirrors to N");
    mirror_clipboard_y_inner(&mut cb_y);
    assert_eq!(cb_y.block_types, original.block_types, "2x Y-mirror restores block types");
    assert_eq!(cb_y.paints, original.paints, "2x Y-mirror restores paints");
}

/// 18.6: the in-place mirrors and slice-wise rotate must equal a naive out-of-place reference
/// on multi-slice clipboards with odd and even sides (odd = a self-mapped middle row/column
/// that is remapped but not swapped) and a footprint mask.
#[test]
pub(crate) fn test_clipboard_transforms_match_reference() {
    for &(w, h, d) in &[(1usize, 1usize, 1usize), (3, 5, 4), (4, 6, 3), (5, 2, 2), (2, 5, 1), (7, 7, 2)] {
        let vol = w * h * d;
        let mk = || Clipboard {
            width: w as i32, height: h as i32, depth: d as i32, z_anchor: 0,
            // Cycle through ramps/wedges/doors/portals/plain so every remap arm is exercised.
            block_types: (0..vol).map(|i| ((i * 5) % 80) as u8).collect(),
            paints: (0..vol).map(|i| (i % 251) as u8).collect(),
            mask: Some((0..(w * h).div_ceil(8)).map(|i| (i as u8).wrapping_mul(37) | 1).collect()), origin: None
        };
        let mask_bit = |m: &Option<Vec<u8>>, i: usize| bit_set(m.as_ref().unwrap(), i);
        let src = mk();
        let at = |c: &Clipboard, x: usize, y: usize, z: usize| {
            let i = z * (c.width * c.height) as usize + y * c.width as usize + x;
            (c.block_types[i], c.paints[i])
        };

        let mut cb = mk();
        mirror_clipboard_x_inner(&mut cb);
        for z in 0..d { for y in 0..h { for x in 0..w {
            let (bt, p) = at(&src, x, y, z);
            assert_eq!(at(&cb, w - 1 - x, y, z), (mirror_ramp_id_x(bt), p), "mirror X {w}x{h}x{d} at {x},{y},{z}");
        }}}
        for y in 0..h { for x in 0..w {
            assert_eq!(mask_bit(&cb.mask, y * w + (w - 1 - x)), mask_bit(&src.mask, y * w + x), "mirror X mask");
        }}

        let mut cb = mk();
        mirror_clipboard_y_inner(&mut cb);
        for z in 0..d { for y in 0..h { for x in 0..w {
            let (bt, p) = at(&src, x, y, z);
            assert_eq!(at(&cb, x, h - 1 - y, z), (mirror_ramp_id_y(bt), p), "mirror Y {w}x{h}x{d} at {x},{y},{z}");
        }}}
        for y in 0..h { for x in 0..w {
            assert_eq!(mask_bit(&cb.mask, (h - 1 - y) * w + x), mask_bit(&src.mask, y * w + x), "mirror Y mask");
        }}

        let mut cb = mk();
        rotate_clipboard_inner(&mut cb);
        assert_eq!((cb.width as usize, cb.height as usize), (h, w));
        assert_eq!(cb.block_types.len(), vol);
        for z in 0..d { for y in 0..h { for x in 0..w {
            let (bt, p) = at(&src, x, y, z);
            assert_eq!(at(&cb, y, w - 1 - x, z), (rotate_ramp_id_cw(bt), p), "rotate {w}x{h}x{d} at {x},{y},{z}");
        }}}
        for y in 0..h { for x in 0..w {
            assert_eq!(mask_bit(&cb.mask, (w - 1 - x) * h + y), mask_bit(&src.mask, y * w + x), "rotate mask");
        }}
    }
}

/// The sculpt "noise" branch must sample *spatially coherent* noise (fbm/ridged), not
/// per-column white noise. Coherence = adjacent columns get near-identical displacements,
/// so the mean step between horizontal neighbours is far smaller than the field's range.
/// (The old bug applied independent random deltas per column → neighbour steps ≈ the full
/// range.) This mirrors exactly how `sculpt_terrain`'s "hills"/"mountains" branches sample.
#[test]
pub(crate) fn test_sculpt_coherent_noise() {
    let freq = 1.0 / 24.0; // default feature size 24
    let so = 13.37;
    let amp = 6.0;
    let n = 64;

    // ── Hills (fbm2 ∈ [-1,1]) ──────────────────────────────────────────────
    let hill = |x: i32, y: i32| (fbm2(x as f64 * freq + so, y as f64 * freq + so, 4) * amp).round() as i32;
    let mut min_h = i32::MAX;
    let mut max_h = i32::MIN;
    let mut neighbour_steps: Vec<i32> = Vec::new();
    for y in 0..n {
        for x in 0..n {
            let v = hill(x, y);
            min_h = min_h.min(v);
            max_h = max_h.max(v);
            if x + 1 < n { neighbour_steps.push((hill(x + 1, y) - v).abs()); }
        }
    }
    let range = (max_h - min_h) as f64;
    assert!(range >= 2.0, "hills field should actually vary (range {range})");
    let max_step = *neighbour_steps.iter().max().unwrap();
    let mean_step = neighbour_steps.iter().sum::<i32>() as f64 / neighbour_steps.len() as f64;
    // Coherent noise: adjacent columns never jump more than 1 block at this frequency,
    // and on average barely move — white noise would give steps on the order of `range`.
    assert!(max_step <= 1, "adjacent hill columns must differ by ≤1 block (got {max_step})");
    assert!(mean_step < range * 0.25,
        "mean neighbour step {mean_step:.3} should be « field range {range} for coherent noise");

    // ── Mountains (ridged2 ∈ [0,1]) builds strictly upward ─────────────────
    for y in 0..n {
        for x in 0..n {
            let r = ridged2(x as f64 * freq + so, y as f64 * freq + so, 4);
            assert!((0.0..=1.0).contains(&r), "ridged2 out of range: {r}");
        }
    }

    // ── Falloff primitive: smoothstep is a monotone dome on [0,1] with clamped ends ──
    assert_eq!(smoothstep01(0.0), 0.0);
    assert_eq!(smoothstep01(1.0), 1.0);
    assert_eq!(smoothstep01(-5.0), 0.0, "clamps below 0");
    assert_eq!(smoothstep01(5.0), 1.0, "clamps above 1");
    let mut prev = -1.0;
    for i in 0..=10 {
        let s = smoothstep01(i as f64 / 10.0);
        assert!(s >= prev, "smoothstep01 must be monotonically non-decreasing");
        prev = s;
    }

    // Every falloff profile is a monotone map from rim(0)→0 to core(1)→1, clamped.
    for prof in ["smooth", "linear", "sphere", "sharp"] {
        assert_eq!(falloff_dome(0.0, prof), 0.0, "{prof}: rim weight is 0");
        assert!((falloff_dome(1.0, prof) - 1.0).abs() < 1e-9, "{prof}: core weight is 1");
        assert_eq!(falloff_dome(-3.0, prof), 0.0, "{prof}: clamps below 0");
        assert_eq!(falloff_dome(3.0, prof), 1.0, "{prof}: clamps above 1");
        let mut last = -1.0;
        for i in 0..=20 {
            let v = falloff_dome(i as f64 / 20.0, prof);
            assert!(v >= last - 1e-12, "{prof}: must be non-decreasing");
            last = v;
        }
    }
    // Distinct shapes: at the midpoint, sphere bulges above and sharp dips below linear.
    assert!(falloff_dome(0.5, "sphere") > 0.5, "sphere rises fast off the rim");
    assert!(falloff_dome(0.5, "sharp") < 0.5, "sharp keeps a wide soft skirt");
}

/// build_lamp_index buckets each lamp under its chunk coord; an empty world → empty index.
#[test]
pub(crate) fn build_lamp_index_buckets_lamps_by_chunk() {
    let empty = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    assert!(build_lamp_index(&empty).is_empty(), "world with no lamps → empty index");

    let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    // Place a lamp (type 72) at lx=4, ly=6, z=5 in chunk (0,0).
    world.bytes[blk(4, 6, 5)] = 72;
    let index = build_lamp_index(&world);
    assert_eq!(index.get(&(0, 0)).map(sorted_lamps), Some(vec![[4, 6, 5]]), "lamp bucketed at its chunk with local coords");

    // The band-major linear scan (audit H3) must decode `(lx, ly, lz)` back out of a flat
    // half-band offset correctly in *every* band, and must never read the paint half — a paint
    // byte that happens to hold 72 is colour index 72, not a lamp.
    world.bytes[blk(15, 15, 63)] = 72; // last voxel of the last band
    world.bytes[blk(0, 0, 16)] = 72;   // first voxel of band 1
    world.bytes[pnt(1, 1, 20)] = 72;   // paint byte — must be ignored
    let lamps = sorted_lamps(&build_lamp_index(&world).remove(&(0, 0)).expect("lamps present"));
    assert_eq!(lamps, vec![[0, 0, 16], [4, 6, 5], [15, 15, 63]],
               "every band decoded, paint half-band skipped");
}

/// Reads must be genuinely *shared* — that is the whole point of the `RwLock` (audit C1 step 2):
/// `fetch_tile`/`get_cursor_block`/render must keep running while `save_world` holds its guard.
/// If `AppState` is ever reverted to a `Mutex`, the second acquisition blocks forever and this
/// fails on the timeout instead of silently regressing to the old freeze-during-save behaviour.
#[test]
pub(crate) fn app_state_readers_do_not_block_each_other() {
    use std::sync::{mpsc, Arc};
    let state = Arc::new(AppState::new(WorldState::new()));
    let held = read_ws(&state); // stands in for a long save holding its read guard
    let (tx, rx) = mpsc::channel();
    let other = Arc::clone(&state);
    let t = std::thread::spawn(move || {
        let ws = read_ws(&other);
        tx.send(ws.world.is_none()).unwrap();
    });
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_secs(5)),
        Ok(true),
        "a second reader must acquire while the first still holds its guard",
    );
    drop(held);
    t.join().unwrap();
}

/// Mutate `world.bytes` at `writes` and replay the resulting undo delta into `ws.lamp_index`,
/// exactly as `with_edit_inner`/`undo_edit_inner` do. `z_range` picks the snapshot scope, which
/// is what decides `Sparse` vs `Full` in `diff_chunk`.
pub(crate) fn edit_and_replay_delta(ws: &mut WorldState, z_range: Option<(i32, i32)>, writes: &[(usize, u8)]) {
    let pre = snapshot_chunks_full(ws.world.as_ref().unwrap(), &[(0, 0)], z_range);
    for &(off, byte) in writes {
        ws.world.as_mut().unwrap().bytes[off] = byte;
    }
    let world = ws.world.as_ref().unwrap();
    let snaps: Vec<ChunkSnapshot> = pre.into_iter()
        .filter_map(|(cx, cy, start, data)| diff_chunk(world, cx, cy, start, &data))
        .collect();
    apply_lamp_delta(&ws.lamp_index, world, &snaps);
}

/// The lamp index must follow a placed/removed lamp — the core correctness invariant the
/// with_edit/undo/redo hooks rely on. Now driven by the edit's undo delta (audit H3) rather
/// than a full chunk rescan, so this also asserts the two agree.
#[test]
pub(crate) fn lamp_index_delta_tracks_place_and_remove() {
    let mut ws = WorldState::new();
    ws.world = Some(parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed"));
    lamp_build_now(&ws.lamp_index, ws.world.as_ref().unwrap());
    assert!(ws.lamp_index.snapshot().is_empty(), "starts with no lamps");

    edit_and_replay_delta(&mut ws, None, &[(blk(4, 6, 5), 72)]);
    assert_eq!(ws.lamp_index.snapshot().get(&(0, 0)).map(sorted_lamps), Some(vec![[4, 6, 5]]),
               "placed lamp indexed from the delta");
    assert_eq!(ws.lamp_index.snapshot(), build_lamp_index(ws.world.as_ref().unwrap()),
               "delta path agrees with a from-scratch rescan");

    edit_and_replay_delta(&mut ws, None, &[(blk(4, 6, 5), 0)]);
    assert!(ws.lamp_index.snapshot().get(&(0, 0)).is_none(),
            "removed lamp drops its chunk bucket");
}

/// A dense edit falls back to `ChunkDelta::Full`; the lamp index must replay that branch too.
/// Also pins the paint half-band skip: byte 72 written into a *paint* byte is a colour index,
/// not a lamp, and must never enter the index.
#[test]
pub(crate) fn lamp_index_delta_handles_full_delta_and_skips_paint() {
    let mut ws = WorldState::new();
    ws.world = Some(parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed"));
    lamp_build_now(&ws.lamp_index, ws.world.as_ref().unwrap());

    // Fill band 0's entire block half with lamps → 4096 changed bytes over an 8192-byte
    // band-scoped snapshot, so `diff_chunk` picks `Full` rather than `Sparse`.
    let writes: Vec<(usize, u8)> = (0..16)
        .flat_map(|lx| (0..16).flat_map(move |ly| (0..16).map(move |z| (blk(lx, ly, z), 72u8))))
        .collect();
    edit_and_replay_delta(&mut ws, Some((0, 15)), &writes);
    let rescan = build_lamp_index(ws.world.as_ref().unwrap());
    assert_eq!(rescan.get(&(0, 0)).map(|v| v.len()), Some(4096), "the whole band is lamps");
    let from_delta = sorted_lamps(&ws.lamp_index.snapshot().remove(&(0, 0)).unwrap());
    let from_scan = sorted_lamps(rescan.get(&(0, 0)).unwrap());
    assert_eq!(from_delta, from_scan, "Full-delta replay matches a from-scratch rescan");

    // Paint byte holding 72 must not register as a lamp.
    edit_and_replay_delta(&mut ws, None, &[(pnt(2, 2, 40), 72)]);
    assert_eq!(ws.lamp_index.snapshot().get(&(0, 0)).map(|v| v.len()), Some(4096),
               "a paint byte of 72 is a colour, not a lamp");
}

/// The core §4 invariant: an edit's delta into a chunk `LampIndex` has never scanned must be
/// dropped, not fabricated into a bucket claiming the chunk is fully known — the later
/// on-demand scan (triggered by a real region query) is what must see the edit.
#[test]
pub(crate) fn lamp_delta_dropped_for_unscanned_chunk_then_scan_sees_the_edit() {
    let mut ws = WorldState::new();
    ws.world = Some(parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed"));
    // ws.lamp_index starts empty — chunk (0,0) has never been scanned.
    edit_and_replay_delta(&mut ws, None, &[(blk(4, 6, 5), 72)]);
    assert!(ws.lamp_index.snapshot().is_empty(),
            "delta into an unscanned chunk must be dropped, not fabricate a bucket");

    let world = ws.world.as_ref().unwrap();
    let found = ws.lamp_index.lamps_in_region(world, 0, 0, 15, 15, 5.0);
    assert_eq!(found, vec![[4, 6, 5]], "on-demand scan re-derives the lamp from truth");
}

/// Once a chunk *has* been scanned (via a real region query), the delta path must track a
/// place → undo → redo cycle exactly, agreeing with a from-scratch rescan at every step. Pins
/// both delta directions (`with_edit_inner` and `undo_edit_inner`/`redo_edit_inner`) against
/// the write-then-apply ordering `apply_delta` relies on.
#[test]
pub(crate) fn lamp_delta_applied_for_scanned_chunk_matches_rescan() {
    let mut ws = WorldState::new();
    ws.world = Some(parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed"));
    {
        let world = ws.world.as_ref().unwrap();
        ws.lamp_index.lamps_in_region(world, 0, 0, 15, 15, 1.0); // scans chunk (0,0)
    }
    let check = |ws: &WorldState, label: &str| {
        let mut rescan = scan_chunk_lamps(ws.world.as_ref().unwrap(), 0, 0);
        rescan.sort_unstable();
        let from_index = sorted_lamps(&ws.lamp_index.snapshot().remove(&(0, 0)).unwrap_or_default());
        assert_eq!(from_index, rescan, "{label}: index must match a from-scratch rescan");
    };

    with_edit(&mut ws, "place lamp", (0, 0, 15, 15), |world| {
        set_block_abs(world, 4, 6, 5, LAMP_BLOCK_TYPE, 0);
        Ok(())
    }).expect("place lamp");
    check(&ws, "after place");

    undo_edit_inner(&mut ws).expect("undo");
    check(&ws, "after undo");
    assert!(ws.lamp_index.snapshot().get(&(0, 0)).is_none(), "lamp gone after undo");

    redo_edit_inner(&mut ws).expect("redo");
    check(&ws, "after redo");
    assert_eq!(ws.lamp_index.snapshot().get(&(0, 0)).map(sorted_lamps), Some(vec![[4, 6, 5]]), "lamp back after redo");
}

/// The set-vs-enum design choice §4 hinges on: a chunk with zero lamps must still be marked
/// `scanned` (so a later query doesn't rescan it every time), even though it gets no `lamps`
/// bucket at all (buckets are only created for non-empty results).
#[test]
pub(crate) fn lamp_free_chunk_is_marked_scanned_not_rescanned() {
    let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    let index = LampIndex::default();
    assert!(index.lamps_in_region(&world, 0, 0, 15, 15, 1.0).is_empty(), "no lamps yet");
    assert!(index.snapshot().is_empty(), "lamp-free chunk gets no bucket");
    // A second query over the same region must not need to touch the world again — there's no
    // way to assert "didn't rescan" directly without instrumentation, so this instead pins the
    // observable contract: the result is stable and still empty.
    assert!(index.lamps_in_region(&world, 0, 0, 15, 15, 1.0).is_empty(), "still no lamps");
}

/// `LampIndex::clear` must drop the `scanned` set along with `lamps` — otherwise a chunk that
/// was scanned for the old world would be wrongly treated as already-known for a newly loaded
/// one sharing the same chunk coords.
#[test]
pub(crate) fn lamp_index_clear_resets_scanned() {
    let mut ws = WorldState::new();
    ws.world = Some(parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed"));
    lamp_build_now(&ws.lamp_index, ws.world.as_ref().unwrap());
    ws.lamp_index.clear();
    // A delta into (0,0) after clear must be dropped again — proof `scanned` was reset, not
    // just `lamps`.
    edit_and_replay_delta(&mut ws, None, &[(blk(4, 6, 5), 72)]);
    assert!(ws.lamp_index.snapshot().is_empty(), "clear must reset scanned, not just lamps");
}

/// `LampIndex::lamps_in_region` (on-demand, per-chunk) must return exactly what a full
/// `build_lamp_index` scan finds for every populated chunk, once every chunk has been queried.
#[test]
pub(crate) fn on_demand_scan_matches_full_build() {
    let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    world.bytes[blk(4, 6, 5)] = LAMP_BLOCK_TYPE;
    world.bytes[blk(0, 0, 16)] = LAMP_BLOCK_TYPE;
    let full = build_lamp_index(&world);

    let index = LampIndex::default();
    for &(cx, cy) in world.chunk_map.keys() {
        let base_x = (cx - world.min_x) * 16;
        let base_y = (cy - world.min_y) * 16;
        index.lamps_in_region(&world, base_x, base_y, base_x + 15, base_y + 15, 1.0);
    }
    assert_eq!(index.snapshot(), full, "on-demand scan must agree with a from-scratch build");
}

/// 5.2: the `full_box` fast path must not change any result. A wide query scans a box; a
/// subsequent query whose box is contained in it takes the no-scan path and must still return
/// exactly the lamps a fresh index finds, and a post-`apply_delta` query must see the edit
/// (the `lamps` map stays current even when the `todo` sweep is skipped).
#[test]
pub(crate) fn lamp_full_box_fast_path_preserves_results() {
    let mut ws = WorldState::new();
    let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    world.bytes[blk(4, 6, 5)] = LAMP_BLOCK_TYPE;
    ws.world = Some(world);
    let w = ws.world.as_ref().unwrap();

    // Wide query — scans the whole neighbourhood of chunk (0,0) and records a `full_box`.
    let wide = ws.lamp_index.lamps_in_region(w, 0, 0, 15, 15, 64.0);
    // Contained query (radius 1 ⊂ radius 64 box) — must hit the fast path and agree.
    let mut narrow = ws.lamp_index.lamps_in_region(w, 0, 0, 15, 15, 1.0);
    let mut fresh = {
        let idx = LampIndex::default();
        idx.lamps_in_region(w, 0, 0, 15, 15, 1.0)
    };
    narrow.sort_unstable();
    fresh.sort_unstable();
    assert_eq!(narrow, fresh, "fast-path result must match a fresh scan");
    assert!(wide.contains(&[4, 6, 5]), "wide query found the lamp");

    // An edit that removes the lamp, replayed as a delta, must still be visible through the
    // fast path (chunk (0,0) is already scanned, so `apply_delta` maintains its bucket).
    edit_and_replay_delta(&mut ws, None, &[(blk(4, 6, 5), 0)]);
    let w = ws.world.as_ref().unwrap();
    let after = ws.lamp_index.lamps_in_region(w, 0, 0, 15, 15, 1.0);
    assert!(after.is_empty(), "fast path must still reflect the removed lamp");
}

