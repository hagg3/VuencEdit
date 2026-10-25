//! Opening an `.emod` world (ROADMAP-EDIT 26.4; plan `emod-support-plan-2026-10-24.md` §2.2).
//!
//! VuencEdit never edits an `.emod` in place. Opening one = an **own-format export into the private
//! staged temp** (`eden_format::emod::export_own`, sparse: only occupied bands are written), then the
//! normal `parse_world_inner` path, so every `.eden` tool (mapped temp, `chunk_range`, `EditView`,
//! undo, overview raster) works unchanged. The temp's slot *i* is the *i*-th live column in ord
//! order, which is what [`EmodSession`] records for the save path.
//!
//! Rules kept here:
//! - Signs and command blocks come from `SIGN_TRAILER`, which the export puts in the temp's
//!   post-directory trailer (`LoadedWorld::trailer`). The game's sidecars beside an `.emod` are
//!   adopted like a `.eden`'s (27.0b, `signs::adopt_sidecars`; the trailer wins per section).
//! - **A torn last batch or an uncommitted tail is not damage** (a normal crash outcome); only the
//!   store's damage list (media damage, a record that doesn't decode) reaches the UI's banner.
//! - **Saving back** (26.5, [`save_in_place`]) appends the dirty chunks as `COLUMN` records (plus
//!   `WORLD_HEADER` / `CREATURES` when they changed) in one batch + `COMMIT` + fsync: atomic by the
//!   container's own rules, so there is no WAL and no in-place patch. It refuses when the file is no
//!   longer the state we opened (another writer appended or compacted). `SIGN_TRAILER` goes in the
//!   batch when the trailer is owed (`DirtyState::trailer_disk`, 27.0b): `file_image().tail`, and
//!   an empty one removes the record. Only the session's own `.emod` can be saved this
//!   way; `save_world` refuses every other `*.emod` destination, and a successful Save As `.eden`
//!   drops the session.
//! - **Autosave** (26.6, [`EmodBase`]): the journal's base is "this `.emod` at this last COMMIT"
//!   (the committed prefix's length + the COMMIT's offset, CRC and seq), re-based by every save.
//!   Recovery re-exports that state and replays the journal onto it: in place when the file's last
//!   COMMIT is still that one, as an unsaved copy when another writer appended since (the
//!   append-only prefix still holds the base), and never onto any other state.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use eden_format::emod::{self, Codec, Codecs, CommitRef, EncodedColumn, ExportOptions, ReadStatus, RecordType, Store};
use rayon::prelude::*;
use rustc_hash::FxHashMap;

use eden_format::emod::OpenOptions;

use crate::{ensure_room_for, read_ws, write_ws, AppState, BaseStatus, FileIdentity, LongOpHandle};

/// True for a path whose extension is `.emod` (any case). The two-sided routing rule (plan §2.2)
/// is keyed on this: `.eden` bytes never go to a `*.emod` name.
pub(crate) fn is_emod_path(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("emod"))
}

/// What the save path (26.5) and autosave (26.6) need to know about the `.emod` a session was
/// opened from. Held in `WorldState::emod`; `None` for every `.eden`/zip session.
#[derive(Debug)]
#[allow(dead_code)] // some fields are informational
pub(crate) struct EmodSession {
    pub(crate) path: PathBuf,
    pub(crate) bands: u16,
    pub(crate) created_unix: u64,
    /// Live column → its ord (kept on rewrite; new columns take `next_ord`).
    pub(crate) ord_of: FxHashMap<(i32, i32), u32>,
    pub(crate) next_ord: u32,
    /// `PROVENANCE`'s source directory row order, for an export that matches the source's rows.
    pub(crate) prov_dir_order: Option<Vec<(i32, i32)>>,
    /// `GENERATOR`, raw (copied, never interpreted).
    pub(crate) generator: Option<[u8; emod::GENERATOR_LEN]>,
    /// File size + the last applied COMMIT at open, or as of our last save: the external-writer
    /// check (plan §2.4). Re-based by every save and compaction.
    pub(crate) len: u64,
    pub(crate) last_commit: Option<CommitRef>,
    /// `Store::truncation_point()` alongside `last_commit`: the prefix of the file that holds the
    /// committed state (26.6's base for a recovery as a copy).
    pub(crate) committed_len: u64,
    /// The length of this file's own-format export at `last_commit` — what an autosave recovery
    /// stages as the Emod base, and so the journal's `base_len`. The temp's length at open; a save
    /// that writes `SIGN_TRAILER` moves it (the export ends with the trailer, 27.0b).
    pub(crate) export_len: u64,
    /// The `.emod`'s `FileIdentity` at open (or our last save) — keys the persisted overview
    /// raster (18.15).
    pub(crate) file_identity: FileIdentity,
    /// Damage reported by the store (opening + reading every live record). Non-empty ⇒ the
    /// banner, and compaction (26.5) is blocked.
    pub(crate) damage: Vec<String>,
    /// The last batch was torn and rolled back (not damage; informational).
    pub(crate) torn: bool,
    pub(crate) dead_bytes: u64,
}

/// Stages the `.emod` at `src` into the private temp `temp` as an own-format `.eden` and returns
/// the session. Refuses (with a user-facing message) a file the store refuses, a store whose
/// `WORLD_HEADER`/`CREATURES` don't decode, a volume without room, or a file that changed while it
/// was being read. On error `temp` does not exist.
pub(crate) fn stage_emod(src: &Path, temp: &Path) -> Result<EmodSession, String> {
    stage_emod_at(src, temp, None)
}

/// [`stage_emod`] of the state held by the file's first `len_limit` bytes (an earlier truncation
/// point: the state before another writer appended). `None` = the whole file.
fn stage_emod_at(src: &Path, temp: &Path, len_limit: Option<u64>) -> Result<EmodSession, String> {
    let before = std::fs::metadata(src)
        .map(|md| FileIdentity::of(src, &md))
        .map_err(|e| format!("Failed to read file: {e}"))?;
    let mut store = Store::open_with(src, OpenOptions { len_limit, ..OpenOptions::default() }).map_err(|e| match e {
        emod::Error::Refused(why) => format!("This .emod file can't be opened ({why})."),
        e => format!("Failed to read the .emod file: {e}"),
    })?;
    let pre = emod::preflight_own(&mut store).map_err(|e| format!("This .emod file can't be opened: {e}"))?;
    // APFS keeps `set_len`'s holes sparse, so a sparse export only needs its occupied bytes. NTFS
    // allocates the whole length of a non-sparse file on extend, so ask for all of it there.
    let needed = if cfg!(windows) { pre.total_len } else { pre.occupied_len };
    ensure_room_for(temp, needed).map_err(|e| format!("Failed to stage world file: {e}"))?;
    let out = emod::export_own(&mut store, temp, ExportOptions { sparse: true, fsync: false }).map_err(|e| match e {
        emod::Error::Damaged(why) => format!("This .emod file is too damaged to open ({why})."),
        e => format!("Failed to stage world file: {e}"),
    })?;
    // The staged temp must describe the file we name (the same before/after rule as `.eden` staging).
    if before.check() != BaseStatus::Ok {
        let _ = std::fs::remove_file(temp);
        return Err("The .emod file changed while it was being opened (is Emod saving it?). Try again.".into());
    }
    let summary = store.summary();
    let export_len = std::fs::metadata(temp).map_err(|e| format!("Failed to stage world file: {e}"))?.len();
    Ok(EmodSession {
        export_len,
        path: src.to_path_buf(),
        bands: store.bands(),
        created_unix: store.created_unix(),
        ord_of: out.slots.iter().map(|&(x, z, ord)| ((x, z), ord)).collect(),
        next_ord: summary.next_ord,
        prov_dir_order: out.prov_dir_order,
        generator: out.generator,
        len: store.file_size(),
        last_commit: store.last_commit(),
        committed_len: store.truncation_point(),
        file_identity: before,
        damage: store.damage().to_vec(),
        torn: store.torn(),
        dead_bytes: store.dead_bytes(),
    })
}

// ── 26.6: the autosave base ─────────────────────────────────────────────────────────────────

/// An autosave journal's base for an `.emod` session (ROADMAP-EDIT 26.6, plan §4 26.6): the
/// own-format export of this file's state at this COMMIT. Persisted in `autosave.meta.json`.
///
/// The export is deterministic and the session's temp layout never changes (columns sit in ord
/// order, ords survive appends and compaction, and nothing in a session adds or moves a chunk), so
/// re-exporting that state reproduces the temp the journal's offsets were taken from. Every save
/// re-bases onto its own commit.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct EmodBase {
    /// The file as of that commit. Only the autosave tick's cheap "nobody touched it" check;
    /// recovery decides on the commit fields, so a touched-but-unchanged file still recovers.
    pub(crate) file: FileIdentity,
    /// `Store::truncation_point()` at that commit: the prefix that holds the state.
    pub(crate) committed_len: u64,
    pub(crate) commit_offset: u64,
    pub(crate) commit_crc: u32,
    pub(crate) commit_seq: u32,
}

impl EmodBase {
    fn matches(&self, last_commit: Option<CommitRef>, committed_len: u64) -> bool {
        let want = CommitRef { offset: self.commit_offset, crc: self.commit_crc, seq: self.commit_seq };
        last_commit == Some(want) && committed_len == self.committed_len
    }

    pub(crate) fn path(&self) -> &Path {
        &self.file.path
    }
}

impl EmodSession {
    /// The session's current state as an autosave base. `None` when the file has no applied
    /// commit (its only batch is torn): there is no state to name, so autosave clones.
    pub(crate) fn autosave_base(&self) -> Option<EmodBase> {
        let c = self.last_commit?;
        Some(EmodBase {
            file: self.file_identity.clone(),
            committed_len: self.committed_len,
            commit_offset: c.offset,
            commit_crc: c.crc,
            commit_seq: c.seq,
        })
    }
}

/// Where an `.emod` autosave base stands, for the Recovery modal and recovery itself: `Ok` = the
/// file's last COMMIT is still the base (recover in place); `Copy` = another writer appended since
/// but the file's prefix still holds the base (recover as an unsaved copy); `Changed` = the base
/// state is gone (rewritten, compacted, truncated or replaced); `Missing` = no file.
pub(crate) fn base_status(base: &EmodBase) -> BaseStatus {
    if std::fs::metadata(base.path()).is_err() {
        return BaseStatus::Missing;
    }
    let at = |len_limit| {
        Store::open_with(base.path(), OpenOptions { len_limit, ..OpenOptions::default() })
            .is_ok_and(|s| base.matches(s.last_commit(), s.truncation_point()))
    };
    if at(None) {
        BaseStatus::Ok
    } else if at(Some(base.committed_len)) {
        BaseStatus::Copy
    } else {
        BaseStatus::Changed
    }
}

/// Recovery's staging (26.6): exports the base state into `temp` and returns the session plus
/// whether it is the file's current state (`true`: recover in place) or only its prefix (`false`:
/// another writer appended since, so the recovered world is an unsaved copy). Refuses anything
/// else; on error `temp` does not exist.
pub(crate) fn stage_autosave_base(base: &EmodBase, temp: &Path) -> Result<(EmodSession, bool), String> {
    let (limit, in_place) = match base_status(base) {
        BaseStatus::Ok => (None, true),
        BaseStatus::Copy => (Some(base.committed_len), false),
        BaseStatus::Missing => return Err(base_missing(base)),
        BaseStatus::Changed => return Err(base_changed(base)),
    };
    let session = stage_emod_at(base.path(), temp, limit)?;
    // The file could have moved on between the check and the export (Emod saving meanwhile).
    if !base.matches(session.last_commit, session.committed_len) {
        let _ = std::fs::remove_file(temp);
        return Err(base_changed(base));
    }
    Ok((session, in_place))
}

fn base_name(base: &EmodBase) -> String {
    base.path().file_name().map_or_else(|| base.path().display().to_string(), |n| n.to_string_lossy().into_owned())
}

pub(crate) fn base_missing(base: &EmodBase) -> String {
    format!(
        "Can't find the world file this autosave builds on: {}. Put the file back or reconnect its drive, then try again. The autosave has been kept.",
        base.path().display()
    )
}

pub(crate) fn base_changed(base: &EmodBase) -> String {
    format!(
        "{} was saved or changed after this autosave was taken, so the autosave no longer applies. Open the file instead.",
        base_name(base)
    )
}

/// True when `a` and `b` name the same file: equal paths, or both canonicalize to the same one
/// (a symlink, a `..`, a case-insensitive volume). Anything unresolvable is "different".
pub(crate) fn same_file(a: &Path, b: &Path) -> bool {
    a == b || matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// Temp suffixes an `.emod` writer (ours or Emod's) leaves beside `x.emod` if it dies mid-write:
/// compaction's, a new world's, and the converters'. The container's extension stays in the name.
pub(crate) const ORPHAN_SUFFIXES: [&str; 4] = [".compact", ".creating", ".converting", ".spill"];

/// Above this many dirty column bytes, [`save_in_place`] encodes straight out of the mapping
/// under the read guard instead of snapshotting them first (edits wait for the encode, as they do
/// for a `.eden` incremental save) — a ⌘A-sized edit must not cost a world-sized copy in RAM.
const SNAPSHOT_BUDGET: u64 = 256 << 20;

/// What an in-place `.emod` save did, for `save_world`'s log line and its post-save steps.
#[derive(Debug)]
pub(crate) struct EmodSave {
    /// `dirty.seq` as the save captured it (the seq gate for the re-base and the raster).
    pub(crate) seq: u64,
    pub(crate) columns: usize,
    pub(crate) header: bool,
    pub(crate) creatures: bool,
    /// The batch carried `SIGN_TRAILER` (27.0b).
    pub(crate) trailer: bool,
    /// Bytes the batch appended (0 when there was nothing to write).
    pub(crate) appended: u64,
    /// `Some(Ok(new size))` when the save compacted afterwards, `Some(Err)` when compaction was
    /// due but failed (the save itself still stands).
    pub(crate) compacted: Option<Result<u64, String>>,
}

/// The message for a file that is no longer the state this session opened.
fn changed_elsewhere(path: &Path) -> String {
    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
    format!(
        "{name} was changed by another program (is Emod open?) since VuencEdit opened it, so saving \
         here would mix the two. Nothing was written. Use Save As to keep your edits as a .eden copy, \
         or reopen the file."
    )
}

#[cfg(test)]
thread_local! {
    /// Crash injection for the save's append (`Store::set_test_crash`): `(bytes, zero_fill)`.
    static TEST_CRASH: std::cell::Cell<Option<(usize, bool)>> = const { std::cell::Cell::new(None) };
    /// Compact after the save even below Emod's 4 MiB floor (a fixture never gets near it).
    static TEST_FORCE_COMPACT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Encodes every column (rayon: a pure function over borrowed bytes, one codec context per worker).
fn encode_columns(cols: &[(i32, i32, Cow<'_, [u8]>)], bands: usize) -> Result<Vec<(i32, i32, EncodedColumn)>, String> {
    cols.par_iter()
        .map_init(Codecs::new, |codecs, (x, z, bytes)| {
            EncodedColumn::encode(bytes, bands, Codec::Zstd, codecs)
                .map(|e| (*x, *z, e))
                .map_err(|e| format!("Failed to compress chunk ({x},{z}): {e}"))
        })
        .collect()
}

/// A chunk's bytes as a full-stride column (an own-format export's spans are always full stride;
/// zero-padded if one somehow isn't, which is how the export reads a short span).
fn column_of(bytes: &[u8], range: (usize, usize), stride: usize) -> Cow<'_, [u8]> {
    let s = &bytes[range.0..range.1.min(range.0 + stride)];
    if s.len() == stride {
        Cow::Borrowed(s)
    } else {
        let mut v = s.to_vec();
        v.resize(stride, 0);
        Cow::Owned(v)
    }
}

/// ⌘S on an `.emod` session (ROADMAP-EDIT 26.5; plan §4 26.5, §2.4, §2.5). The caller holds the
/// durability mutex and has already made the first `x.emod.bak`.
///
/// 1. **Identity:** the file's size and last COMMIT must still be what we opened or last wrote;
///    otherwise refuse (never truncate a torn tail that belongs to someone else's state).
/// 2. **Gather** under the read guard: every dirty chunk's column, the header (if a header writer
///    ran) and the creature block. Copied out when small, else encoded in place under the guard.
/// 3. **Encode + append unguarded:** one batch — `WORLD_HEADER`, `CREATURES` (each only if it
///    differs from the store's), then the columns in ord order — + `SUMMARY` + `COMMIT` + fsync.
/// 4. **Compact** if Emod's policy says so and nothing is damaged (`Store::compact`: a fresh file
///    into `x.emod.compact`, fsync, rename + parent fsync — the `publish` idiom). Non-fatal.
/// 5. **Discharge:** under a short write guard, re-base the session's identity and clear the dirty
///    flags only if `dirty.seq` hasn't moved (`record_full_write`'s rule).
///
/// A save with nothing dirty writes nothing.
pub(crate) fn save_in_place(state: &AppState, dest: &Path, op: Option<&LongOpHandle>) -> Result<EmodSave, String> {
    let step = |done: u64, phase: &str| op.map_or(Ok(()), |o| o.step(done, phase));
    let (len, last_commit, damaged, generator) = {
        let ws = read_ws(state);
        let s = ws.emod.as_ref().filter(|s| same_file(&s.path, dest)).ok_or("This world wasn't opened from that .emod file.")?;
        (s.len, s.last_commit, !s.damage.is_empty(), s.generator.is_some())
    };
    // ── 1. identity (a cheap size check first, then the full scan's last COMMIT)
    step(0, "Checking")?;
    let disk_len = std::fs::metadata(dest).map_err(|e| format!("Failed to read the .emod file: {e}"))?.len();
    if disk_len != len {
        return Err(changed_elsewhere(dest));
    }
    let mut store = Store::open_rw(dest).map_err(|e| format!("Failed to open the .emod file for saving: {e}"))?;
    if store.file_size() != len || store.last_commit() != last_commit {
        return Err(changed_elsewhere(dest));
    }
    let bands = store.bands() as usize;
    let stride = store.column_len();
    let orig_header = match store.read_record(RecordType::WorldHeader) {
        Ok((ReadStatus::Ok | ReadStatus::Fallback, h)) if h.len() == emod::EDEN_HEADER_LEN => Some(h),
        _ => None,
    };
    let orig_creatures = match store.read_record(RecordType::Creatures) {
        Ok((ReadStatus::Ok | ReadStatus::Fallback, c)) => Some(c),
        _ => None,
    };

    // ── 2. gather under the read guard
    let (seq, header, creatures, trailer, mut encoded) = {
        let ws = read_ws(state);
        let world = ws.world.as_ref().ok_or("No world loaded")?;
        if world.num_bands != bands || world.chunk_size != stride {
            return Err("The open world doesn't match its .emod file's height; use Save As .eden.".into());
        }
        let seq = ws.dirty.seq;
        let header = ws.dirty.header_disk.then(|| world.bytes[..emod::EDEN_HEADER_LEN].to_vec());
        // 27.0b: the trailer as the world saves it, when owed — `(trailer_start, bytes)`.
        let trailer = ws.dirty.trailer_disk.then(|| (world.trailer_start, world.file_image().tail.into_owned()));
        // The export put the creature block right after the last column (spec § Export).
        let creatures = orig_creatures.as_ref().and_then(|c| {
            let at = emod::EDEN_HEADER_LEN + world.chunk_map.len() * stride;
            world.bytes.get(at..at + c.len()).map(<[u8]>::to_vec)
        });
        let mut keys: Vec<((i32, i32), (usize, usize))> = ws
            .dirty
            .since_disk
            .keys()
            .filter_map(|&k| world.chunk_range(k.0, k.1).map(|r| (k, r)))
            .collect();
        keys.sort_unstable_by_key(|&((x, z), _)| (store.column_ord(x, z).unwrap_or(u32::MAX), x, z));
        let cols = |owned: bool| -> Vec<(i32, i32, Cow<'_, [u8]>)> {
            keys.iter()
                .map(|&((x, z), r)| {
                    let c = column_of(&world.bytes, r, stride);
                    (x, z, if owned { Cow::Owned(c.into_owned()) } else { c })
                })
                .collect()
        };
        if (keys.len() * stride) as u64 <= SNAPSHOT_BUDGET {
            let snap: Vec<(i32, i32, Vec<u8>)> =
                cols(true).into_iter().map(|(x, z, c)| (x, z, c.into_owned())).collect();
            (seq, header, creatures, trailer, Err(snap))
        } else {
            (seq, header, creatures, trailer, Ok(encode_columns(&cols(false), bands)?))
        }
    };
    // ── 3. encode (if not already) and append, unguarded
    let n_dirty = match &encoded { Ok(v) => v.len(), Err(v) => v.len() } as u64;
    step(0, "Compressing")?;
    if let Err(snap) = &encoded {
        let cols: Vec<_> = snap.iter().map(|(x, z, c)| (*x, *z, Cow::Borrowed(&c[..]))).collect();
        encoded = Ok(encode_columns(&cols, bands)?);
    }
    let encoded = encoded.unwrap_or_default();
    // The header the store keeps: the temp's, with the fields the export recomputed restored
    // (`directory_offset`, and the GENERATOR mirror in `reserved[]`).
    let header = header.map(|mut h| {
        if let Some(o) = &orig_header {
            h[32..40].copy_from_slice(&o[32..40]);
            if generator {
                h[152..].copy_from_slice(&o[152..]);
            }
        }
        h
    });
    let header = header.filter(|h| orig_header.as_ref() != Some(h));
    let creatures = creatures.filter(|c| orig_creatures.as_ref() != Some(c));
    // `SIGN_TRAILER` only when it differs from the store's (an absent record = an empty trailer).
    // The container requires whole 16-byte rows; a trailer the model rebuilt always is, and an
    // opaque (possibly ragged) one is never owed — skip rather than fail the save if one were.
    let orig_trailer = match store.read_record(RecordType::SignTrailer) {
        Ok((ReadStatus::Ok | ReadStatus::Fallback, t)) => Some(t),
        Ok((ReadStatus::Absent, _)) => Some(Vec::new()),
        _ => None,
    };
    let trailer = trailer.filter(|(_, t)| orig_trailer.as_ref() != Some(t)).filter(|(_, t)| {
        let ok = t.len().is_multiple_of(emod::EDEN_DIR_ROW) && t.len() <= emod::TRAILER_MAX;
        if !ok { eprintln!("[SAVE] emod: trailer of {} B can't be a SIGN_TRAILER; left as it was", t.len()); }
        ok
    });
    let mut out = EmodSave {
        seq,
        columns: encoded.len(),
        header: header.is_some(),
        creatures: creatures.is_some(),
        trailer: trailer.is_some(),
        appended: 0,
        compacted: None,
    };
    if !encoded.is_empty() || header.is_some() || creatures.is_some() || trailer.is_some() {
        step(n_dirty, "Writing")?;
        let estimate: u64 = encoded.iter().map(|(_, _, e)| e.payload.len() as u64 + 40).sum::<u64>()
            + header.as_ref().map_or(0, |h| h.len() as u64 + 40)
            + creatures.as_ref().map_or(0, |c| c.len() as u64 + 40)
            + trailer.as_ref().map_or(0, |(_, t)| t.len() as u64 + 40)
            + 4096;
        ensure_room_for(dest, estimate).map_err(|e| e.to_string())?;
        store.begin_batch();
        let put = |r: Result<(), emod::Error>| r.map_err(|e| format!("Failed to save the .emod file: {e}"));
        if let Some(h) = &header {
            put(store.put_record(RecordType::WorldHeader, h))?;
        }
        if let Some(c) = &creatures {
            put(store.put_record(RecordType::Creatures, c))?;
        }
        if let Some((_, t)) = &trailer {
            put(store.put_record(RecordType::SignTrailer, t))?; // empty = no trailer (the spec)
        }
        for (x, z, e) in &encoded {
            put(store.put_encoded_column(*x, *z, e))?;
        }
        // Last look before the append: nobody grew the file since our scan.
        if std::fs::metadata(dest).map(|m| m.len()).ok() != Some(store.file_size()) {
            return Err(changed_elsewhere(dest));
        }
        #[cfg(test)]
        store.set_test_crash(TEST_CRASH.with(|c| c.get()));
        let before = store.file_size();
        store.commit().map_err(|e| format!("Failed to save the .emod file (it still holds its last save): {e}"))?;
        out.appended = store.file_size() - before;
    }
    // ── 4. compaction (non-fatal: the commit above already made the save durable)
    #[cfg(test)]
    let due = store.should_compact() || TEST_FORCE_COMPACT.with(|c| c.get());
    #[cfg(not(test))]
    let due = store.should_compact();
    if !damaged && !store.damaged() && due {
        step(n_dirty, "Compacting")?;
        let live = store.file_size() - store.dead_bytes();
        let tmp = PathBuf::from(format!("{}.compact", dest.display()));
        let r = ensure_room_for(&tmp, live).map_err(|e| e.to_string()).and_then(|()| {
            store.compact().map_err(|e| format!("{e}"))
        });
        out.compacted = Some(r.map(|()| store.file_size()));
    }
    // ── 5. discharge + re-base the identity
    let md = std::fs::metadata(dest).map_err(|e| format!("Failed to stat the saved .emod file: {e}"))?;
    let mut ws = write_ws(state);
    if let Some(s) = ws.emod.as_mut().filter(|s| same_file(&s.path, dest)) {
        if let Some((at, t)) = &trailer {
            s.export_len = at + t.len() as u64; // the export ends with the trailer just committed
        }
        s.len = store.file_size();
        s.last_commit = store.last_commit();
        s.committed_len = store.truncation_point();
        s.file_identity = FileIdentity::of(dest, &md);
        s.dead_bytes = store.dead_bytes();
        s.torn = false;
    }
    let mut adopted = Vec::new();
    if ws.dirty.seq == seq {
        ws.dirty.since_disk.clear();
        ws.dirty.header_disk = false;
        ws.dirty.trailer_disk = false;
        adopted = crate::take_adopted_for(&mut ws, dest);
    }
    drop(ws);
    crate::rename_adopted(&adopted);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{map_staged_temp_ex, parse_world_inner, temp_world_path, LoadedWorld};
    use std::io::Read;

    /// The `eden-format` crate's checked-in fixture pack (26.1).
    fn fixture(name: &str) -> Vec<u8> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/eden-format/tests/fixtures").join(name);
        let raw = std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        if name.ends_with(".gz") {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out).unwrap();
            out
        } else {
            raw
        }
    }

    fn parse_file(p: &Path) -> LoadedWorld {
        parse_world_inner(map_staged_temp_ex(p).unwrap().0).unwrap()
    }

    /// Every chunk of `a` is in `b` with the same bytes (and vice versa), and the trailers match.
    fn assert_same_world(a: &LoadedWorld, b: &LoadedWorld) {
        assert_eq!(a.num_bands, b.num_bands);
        assert_eq!(a.chunk_map.len(), b.chunk_map.len());
        assert_eq!(a.trailer_bytes(), b.trailer_bytes());
        // The header, except `directory_offset` (32..39), which the export recomputes.
        assert_eq!((&a.bytes[..32], &a.bytes[40..192]), (&b.bytes[..32], &b.bytes[40..192]), "header");
        for &(x, y) in a.chunk_map.keys() {
            let (ra, rb) = (a.chunk_range(x, y).unwrap(), b.chunk_range(x, y).expect("chunk present"));
            let (sa, sb) = (&a.bytes[ra.0..ra.1], &b.bytes[rb.0..rb.1]);
            // A short span in the source reads as zero-filled in the export (spec § Conversion).
            assert_eq!(sa, &sb[..sa.len()], "chunk ({x},{y})");
            assert!(sb[sa.len()..].iter().all(|&v| v == 0), "chunk ({x},{y}) tail");
        }
    }

    // ── 26.5: saving in place ──────────────────────────────────────────────────────────────

    /// A scratch dir holding `name` (a fixture, ungzipped) as `w.emod`.
    fn scratch(tag: &str, name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("vuencedit-emod-save-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("w.emod");
        std::fs::write(&src, fixture(name)).unwrap();
        (dir, src)
    }

    /// A `WorldState` wired the way `load_world` leaves an `.emod` session: the staged temp mapped
    /// (MAP_SHARED, like the app) and the session set. Returns the state and the temp's path.
    fn open_session(src: &Path) -> (AppState, PathBuf) {
        // Beside the source, not `temp_world_path()`: that name is a timestamp, which parallel
        // tests can share.
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let temp = src.with_file_name(format!("staged-{}.eden", SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let session = stage_emod(src, &temp).unwrap();
        let mut ws = crate::WorldState::new();
        ws.world = Some(parse_file(&temp));
        ws.temp_path = Some(temp.clone());
        ws.emod = Some(session);
        (std::sync::RwLock::new(ws), temp)
    }

    /// Deletes the top 4 layers that hold anything in the world's first 24×24 blocks (a real
    /// `with_edit`, so the dirty sets are marked exactly as in the app; each call bites deeper)
    /// and renames the world (a header writer).
    fn edit(state: &AppState) {
        let mut ws = write_ws(state);
        let world = ws.world.as_ref().unwrap();
        let before = world.bytes.to_vec();
        let top = (0..24)
            .flat_map(|x| (0..24).map(move |y| (x, y)))
            .filter_map(|(x, y)| (0..world.num_bands as i32 * 16).rev().find(|&z| crate::read_block_abs(world, x, y, z) != 0))
            .max()
            .expect("the corner holds blocks");
        crate::with_edit(&mut ws, "delete", (0, 0, 23, 23), |w| {
            crate::delete_blocks_inner(w, 0, 0, 23, 23, (top - 3).max(0), top, None);
            Ok(())
        })
        .unwrap();
        let w = ws.world.as_mut().unwrap();
        assert_ne!(&w.bytes[..], &before[..], "the test edit must change something");
        w.bytes[40..44].copy_from_slice(b"Edit");
        ws.dirty.mark_header();
    }

    fn live_bytes(state: &AppState) -> Vec<u8> {
        read_ws(state).world.as_ref().unwrap().bytes.to_vec()
    }

    fn digest(p: &Path) -> String {
        Store::open(p).unwrap().state_digest().unwrap()
    }

    fn cleanup(state: AppState, temp: &Path, dir: &Path) {
        drop(state);
        let _ = std::fs::remove_file(temp);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The core gate: edit → save → reopen gives exactly the live world (byte for byte, the
    /// trailer included), the dirty sets are discharged, and a save with nothing dirty writes nothing.
    #[test]
    fn save_in_place_round_trips_the_live_world() {
        for name in ["f64-basic.zlib.emod", "f256-trailer.none.emod.gz", "f256-trailer.2batch.emod"] {
            let (dir, src) = scratch("rt", name);
            let (state, temp) = open_session(&src);
            let trailer = read_ws(&state).world.as_ref().unwrap().trailer_bytes();
            let commits_before = Store::open(&src).unwrap().last_seq();
            edit(&state);
            let saved = save_in_place(&state, &src, None).unwrap();
            assert!(saved.columns > 0 && saved.header && !saved.creatures && saved.appended > 0, "{name}: {saved:?}");
            {
                let ws = read_ws(&state);
                assert!(ws.dirty.since_disk.is_empty() && !ws.dirty.header_disk, "{name}: dirty discharged");
                assert!(!ws.dirty.since_journal.is_empty(), "{name}: only the disk set is discharged");
                let s = ws.emod.as_ref().unwrap();
                assert_eq!(s.len, std::fs::metadata(&src).unwrap().len());
                assert_eq!(s.file_identity.check(), BaseStatus::Ok);
            }
            let mut store = Store::open(&src).unwrap();
            assert_eq!(store.last_seq(), commits_before + 1, "{name}: one batch appended");
            assert!(store.verify().unwrap().is_empty(), "{name}: the saved file verifies clean");
            drop(store);

            let temp2 = dir.join("reloaded.eden");
            stage_emod(&src, &temp2).unwrap();
            let reloaded = std::fs::read(&temp2).unwrap();
            assert_eq!(reloaded, live_bytes(&state), "{name}: reload == live world");
            assert_eq!(parse_file(&temp2).trailer_bytes(), trailer, "{name}: trailer kept");
            let _ = std::fs::remove_file(&temp2);

            let len = std::fs::metadata(&src).unwrap().len();
            let again = save_in_place(&state, &src, None).unwrap();
            assert_eq!((again.columns, again.appended), (0, 0), "{name}: nothing dirty → nothing written");
            assert_eq!(std::fs::metadata(&src).unwrap().len(), len);
            // …and the session's re-based identity accepts the next real save.
            edit(&state);
            save_in_place(&state, &src, None).unwrap();
            cleanup(state, &temp, &dir);
        }
    }

    /// Plan §2.4: a file another writer appended to (or that grew a tail) since we opened it is
    /// never saved over — nothing is written and the dirty sets stay owed.
    #[test]
    fn save_refuses_a_file_changed_elsewhere() {
        let (dir, src) = scratch("ext", "f256-trailer.none.emod.gz");
        let (state, temp) = open_session(&src);
        edit(&state);
        // Emod saves meanwhile: a real committed batch.
        {
            let mut other = Store::open_rw(&src).unwrap();
            let (_, c) = other.read_record(RecordType::Creatures).unwrap();
            other.begin_batch();
            other.put_record(RecordType::Creatures, &c).unwrap();
            other.commit().unwrap();
        }
        let theirs = std::fs::read(&src).unwrap();
        let e = save_in_place(&state, &src, None).unwrap_err();
        assert!(e.contains("changed by another program"), "{e}");
        assert_eq!(std::fs::read(&src).unwrap(), theirs, "a refused save writes nothing");
        assert!(!read_ws(&state).dirty.since_disk.is_empty(), "a refused save keeps the edits owed");
        cleanup(state, &temp, &dir);

        // An uncommitted tail someone else is writing: same size check, same refusal.
        let (dir, src) = scratch("tail", "f64-basic.zlib.emod");
        let (state, temp) = open_session(&src);
        edit(&state);
        let mut bytes = std::fs::read(&src).unwrap();
        bytes.extend_from_slice(&[0u8; 64]);
        std::fs::write(&src, &bytes).unwrap();
        assert!(save_in_place(&state, &src, None).unwrap_err().contains("changed by another program"));
        assert_eq!(std::fs::read(&src).unwrap(), bytes);
        cleanup(state, &temp, &dir);
    }

    /// Crash injection on the append: killed after any number of the batch's bytes (prefix, or
    /// the size persisted with the data zero-filled), the file reads as its old state, and the next
    /// session's save writes exactly the uncrashed result.
    #[test]
    fn a_crashed_save_reads_as_the_old_state() {
        let name = "f256-trailer.none.emod.gz";
        let (dir, src) = scratch("crash-ref", name);
        let old = digest(&src);
        let (state, temp) = open_session(&src);
        edit(&state);
        let n = save_in_place(&state, &src, None).unwrap().appended as usize;
        let new = digest(&src);
        assert_ne!(old, new);
        cleanup(state, &temp, &dir);

        let mut kills: Vec<usize> = (0..n).step_by((n / 48).max(1)).collect();
        kills.extend([1, n - 1]);
        for zero_fill in [false, true] {
            for &k in &kills {
                let (dir, src) = scratch(&format!("crash-{k}-{zero_fill}"), name);
                let (state, temp) = open_session(&src);
                edit(&state);
                TEST_CRASH.with(|c| c.set(Some((k, zero_fill))));
                let r = save_in_place(&state, &src, None);
                TEST_CRASH.with(|c| c.set(None));
                assert!(r.is_err(), "kill at {k}");
                assert!(!read_ws(&state).dirty.since_disk.is_empty(), "kill at {k}: edits still owed");
                let d = digest(&src);
                // A zero-filled kill at the very end can equal the whole batch (its last bytes are
                // zero anyway): then it is the new state. Never anything else.
                if zero_fill && d == new {
                    assert!(k + 8 >= n, "kill at {k} of {n} read as the new state");
                } else {
                    assert_eq!(d, old, "kill at {k} (zero-fill {zero_fill}) must read as the old state");
                }
                cleanup(state, &temp, &dir);
            }
        }
        // One full recovery round trip (the loop above only checks the read side).
        let (dir, src) = scratch("crash-recover", name);
        let (state, temp) = open_session(&src);
        edit(&state);
        TEST_CRASH.with(|c| c.set(Some((n / 2, true))));
        assert!(save_in_place(&state, &src, None).is_err());
        TEST_CRASH.with(|c| c.set(None));
        drop(state);
        let _ = std::fs::remove_file(&temp);
        let (state, temp) = open_session(&src);
        edit(&state);
        save_in_place(&state, &src, None).unwrap();
        assert_eq!(digest(&src), new, "the next save writes exactly the uncrashed state");
        cleanup(state, &temp, &dir);
    }

    /// Compaction after a save keeps the live state (digest), drops the dead bytes, keeps a
    /// GENERATOR record, re-bases the session (the next save is accepted), and the stored
    /// `WORLD_HEADER` keeps its own `directory_offset` / `reserved[]` rather than the export's.
    #[test]
    fn compaction_keeps_the_state_and_the_generator() {
        let gen = [7u8; emod::GENERATOR_LEN];
        let with_generator = |tag: &str| {
            let (dir, src) = scratch(tag, "f256-trailer.none.emod.gz");
            let mut s = Store::open_rw(&src).unwrap();
            s.begin_batch();
            s.put_record(RecordType::Generator, &gen).unwrap();
            s.commit().unwrap();
            (dir, src)
        };
        let (dir_a, a) = with_generator("compact-a");
        let (dir_b, b) = with_generator("compact-b");
        let orig_header = Store::open(&a).unwrap().read_record(RecordType::WorldHeader).unwrap().1;

        let (sa, ta) = open_session(&a);
        assert!(read_ws(&sa).world.as_ref().unwrap().bytes[152..156] == *b"EMG1", "export mirrors GENERATOR");
        edit(&sa);
        TEST_FORCE_COMPACT.with(|c| c.set(true));
        let saved = save_in_place(&sa, &a, None);
        TEST_FORCE_COMPACT.with(|c| c.set(false));
        let saved = saved.unwrap();
        assert!(matches!(saved.compacted, Some(Ok(_))), "{saved:?}");

        let (sb, tb) = open_session(&b);
        edit(&sb);
        assert!(save_in_place(&sb, &b, None).unwrap().compacted.is_none());

        assert_eq!(digest(&a), digest(&b), "compaction keeps the live state");
        let mut ca = Store::open(&a).unwrap();
        assert_eq!(ca.dead_bytes(), 0);
        assert!(std::fs::metadata(&a).unwrap().len() < std::fs::metadata(&b).unwrap().len());
        assert_eq!(ca.read_record(RecordType::Generator).unwrap().1, gen.to_vec(), "GENERATOR survives");
        let h = ca.read_record(RecordType::WorldHeader).unwrap().1;
        assert_eq!(&h[40..44], b"Edit", "the header edit landed");
        assert_eq!((&h[32..40], &h[152..]), (&orig_header[32..40], &orig_header[152..]), "export-only fields restored");
        drop(ca);
        assert!(!dir_a.join("w.emod.compact").exists());

        edit(&sa);
        save_in_place(&sa, &a, None).expect("the re-based identity accepts the next save");
        cleanup(sa, &ta, &dir_a);
        cleanup(sb, &tb, &dir_b);
    }

    // ── 26.6: autosave + recovery ──────────────────────────────────────────────────────────

    /// The autosave sidecar dir beside a scratch world.
    fn autosave_dir(dir: &Path) -> crate::AutosavePaths {
        let app = dir.join("appdata");
        std::fs::create_dir_all(&app).unwrap();
        crate::autosave_paths_at(&app)
    }

    fn tick(state: &AppState, paths: &crate::AutosavePaths) {
        crate::autosave_world_inner(state, paths, None, None).expect("autosave tick");
    }

    fn meta_base(paths: &crate::AutosavePaths) -> crate::AutosaveBase {
        let info: crate::AutosaveInfo = serde_json::from_str(&std::fs::read_to_string(&paths.meta).unwrap()).unwrap();
        info.base.expect("format 2 names its base")
    }

    fn status(paths: &crate::AutosavePaths) -> Option<BaseStatus> {
        crate::autosave_info_at(paths).unwrap().expect("offered for recovery").base_status
    }

    /// Recovers into a fresh state and checks the world is exactly `expected`.
    fn recover(paths: &crate::AutosavePaths, expected: &[u8]) -> (AppState, crate::WorldMeta) {
        let fresh: AppState = std::sync::RwLock::new(crate::WorldState::new());
        let meta = crate::load_autosave_inner(&fresh, paths).expect("recovery");
        assert!(live_bytes(&fresh) == expected, "the recovered world must equal the last-ticked world");
        (fresh, meta)
    }

    fn drop_recovered(fresh: AppState) {
        let temp = read_ws(&fresh).temp_path.clone();
        drop(fresh);
        if let Some(t) = temp { let _ = std::fs::remove_file(t); }
    }

    /// A commit by another writer (Emod saving the same file): one creature byte flipped.
    fn emod_appends(src: &Path) {
        let mut other = Store::open_rw(src).unwrap();
        let (_, mut c) = other.read_record(RecordType::Creatures).unwrap();
        c[0] ^= 1;
        other.begin_batch();
        other.put_record(RecordType::Creatures, &c).unwrap();
        other.commit().unwrap();
    }

    /// The base is the file at its last COMMIT — no world-sized clone — and recovery replays onto
    /// a fresh export of it, byte for byte, in place: the session comes back, the replayed chunks
    /// are owed to the file, and ⌘S appends exactly the recovered world. A save of ours that
    /// crashed mid-append (a torn tail, no new commit) leaves the base in place.
    #[test]
    fn autosave_of_an_emod_session_recovers_in_place() {
        for name in ["f64-basic.zlib.emod", "f256-trailer.none.emod.gz"] {
            let (dir, src) = scratch("as-inplace", name);
            let paths = autosave_dir(&dir);
            let (state, temp) = open_session(&src);
            edit(&state);
            tick(&state, &paths);
            assert!(!paths.base.exists(), "{name}: an .emod lineage must not clone the world");
            let crate::AutosaveBase::Emod(b) = meta_base(&paths) else { panic!("{name}: expected an Emod base") };
            assert_eq!(b.path(), src.as_path());
            assert_eq!(status(&paths), Some(BaseStatus::Ok));

            TEST_CRASH.with(|c| c.set(Some((40, false))));
            assert!(save_in_place(&state, &src, None).is_err());
            TEST_CRASH.with(|c| c.set(None));
            assert_eq!(status(&paths), Some(BaseStatus::Ok), "{name}: a torn tail of ours is not a new state");

            let expected = live_bytes(&state);
            let (fresh, meta) = recover(&paths, &expected);
            assert_eq!(meta.container, "emod");
            {
                let ws = read_ws(&fresh);
                assert!(ws.emod.as_ref().is_some_and(|s| same_file(&s.path, &src)), "{name}: the session is back");
                assert!(matches!(ws.autosave.as_ref().map(|l| &l.base), Some(crate::AutosaveBase::Emod(_))));
                assert!(!ws.dirty.since_disk.is_empty() && ws.dirty.header_disk, "{name}: replayed work is owed to the file");
            }
            let saved = save_in_place(&fresh, &src, None).expect("⌘S after recovery");
            assert!(saved.appended > 0);
            let again = dir.join("again.eden");
            stage_emod(&src, &again).unwrap();
            assert!(std::fs::read(&again).unwrap() == expected, "{name}: the file now holds the recovered world");
            let _ = std::fs::remove_file(&again);
            drop_recovered(fresh);
            cleanup(state, &temp, &dir);
        }
    }

    /// Every in-place save re-bases onto its own commit: the old sidecars go, `since_base` resets,
    /// the next journal holds only later edits, and it recovers onto the new commit. A save that
    /// compacts re-bases the same way.
    #[test]
    fn an_emod_save_rebases_the_autosave() {
        let (dir, src) = scratch("as-rebase", "f256-trailer.none.emod.gz");
        let paths = autosave_dir(&dir);
        let (state, temp) = open_session(&src);
        edit(&state);
        tick(&state, &paths);
        let crate::AutosaveBase::Emod(before) = meta_base(&paths) else { panic!() };
        for compact in [false, true] {
            TEST_FORCE_COMPACT.with(|c| c.set(compact));
            let saved = save_in_place(&state, &src, None);
            TEST_FORCE_COMPACT.with(|c| c.set(false));
            let saved = saved.unwrap();
            assert_eq!(saved.compacted.is_some(), compact);
            crate::rebase_after_save_inner(&state, &paths, &src, false, saved.seq);
            assert!(!paths.meta.exists() && !paths.journal.exists(), "the re-base removes the old sidecars");
            {
                let ws = read_ws(&state);
                assert!(ws.dirty.since_base.is_empty() && !ws.dirty.header_base, "a seq-clean save resets since_base");
                let Some(crate::AutosaveBase::Emod(b)) = ws.autosave.as_ref().map(|l| l.base.clone()) else { panic!() };
                assert_ne!((b.commit_offset, b.commit_crc), (before.commit_offset, before.commit_crc), "the new commit is the base");
            }
            edit(&state);
            tick(&state, &paths);
            assert_eq!(status(&paths), Some(BaseStatus::Ok));
            let (fresh, meta) = recover(&paths, &live_bytes(&state));
            assert_eq!(meta.container, "emod");
            drop_recovered(fresh);
        }
        cleanup(state, &temp, &dir);
    }

    /// A base mismatch never replays onto a different state. Emod appended after the last tick →
    /// recovered as an unsaved copy from the file's prefix (the file untouched, no session); Emod
    /// compacted → the base is gone and recovery refuses, keeping the sidecars; a missing file is
    /// reported and recovers once it is back.
    #[test]
    fn an_emod_base_mismatch_recovers_as_a_copy_never_in_place() {
        let (dir, src) = scratch("as-copy", "f256-trailer.none.emod.gz");
        let paths = autosave_dir(&dir);
        let (state, temp) = open_session(&src);
        edit(&state);
        tick(&state, &paths);
        let expected = live_bytes(&state);

        let aside = dir.join("moved.emod");
        std::fs::rename(&src, &aside).unwrap();
        assert_eq!(status(&paths), Some(BaseStatus::Missing));
        let fresh: AppState = std::sync::RwLock::new(crate::WorldState::new());
        let e = crate::load_autosave_inner(&fresh, &paths).err().expect("recovery must refuse");
        assert!(e.contains("Can't find"), "{e}");
        std::fs::rename(&aside, &src).unwrap();

        emod_appends(&src);
        assert_eq!(status(&paths), Some(BaseStatus::Copy));
        let theirs = std::fs::read(&src).unwrap();
        let (fresh, meta) = recover(&paths, &expected);
        assert_eq!(meta.container, "eden", "a copy is not the .emod session");
        {
            let ws = read_ws(&fresh);
            assert!(ws.emod.is_none() && ws.disk_image.is_none() && ws.autosave.is_none());
        }
        assert_eq!(std::fs::read(&src).unwrap(), theirs, "recovery never writes the .emod");
        drop_recovered(fresh);

        let mut s = Store::open_rw(&src).unwrap();
        s.compact().unwrap();
        drop(s);
        assert_eq!(status(&paths), Some(BaseStatus::Changed));
        let fresh: AppState = std::sync::RwLock::new(crate::WorldState::new());
        let e = crate::load_autosave_inner(&fresh, &paths).err().expect("recovery must refuse");
        assert!(e.contains("saved or changed after this autosave"), "{e}");
        assert!(read_ws(&fresh).world.is_none());
        assert!(paths.meta.exists() && paths.journal.exists(), "sidecars are kept");
        cleanup(state, &temp, &dir);
    }

    /// Emod writing the file *during* the session: the next tick can't trust the base any more and
    /// falls back to a clone of the temp, which still recovers (as a copy).
    #[test]
    fn an_emod_written_mid_session_falls_back_to_a_clone() {
        let (dir, src) = scratch("as-clone", "f64-basic.zlib.emod");
        let paths = autosave_dir(&dir);
        let (state, temp) = open_session(&src);
        edit(&state);
        tick(&state, &paths);
        emod_appends(&src);
        edit(&state);
        tick(&state, &paths);
        assert_eq!(meta_base(&paths), crate::AutosaveBase::Clone);
        assert!(paths.base.exists());
        let (fresh, meta) = recover(&paths, &live_bytes(&state));
        assert_eq!(meta.container, "eden");
        drop_recovered(fresh);
        cleanup(state, &temp, &dir);
    }

    #[test]
    fn emod_backups_and_temps_keep_the_extension_last() {
        let (plain, zip) = crate::backup_paths(Path::new("/w/World.emod"));
        assert_eq!(plain, Path::new("/w/World.emod.bak"));
        assert_eq!(zip, Path::new("/w/World.emod.bak.zip"));
        for s in ORPHAN_SUFFIXES {
            assert!(!s.contains("eden"), "{s}");
        }
        assert!(!same_file(Path::new("/nonexistent/a.emod"), Path::new("/nonexistent/b.emod")));
    }

    #[test]
    fn emod_extension_routing() {
        assert!(is_emod_path(Path::new("/w/World.emod")));
        assert!(is_emod_path(Path::new("World.EMOD")));
        assert!(!is_emod_path(Path::new("World.emod.eden")));
        assert!(!is_emod_path(Path::new("World.eden")));
        assert!(!is_emod_path(Path::new("emod")));
    }

    /// 26.4's gate: staging an `.emod` gives the `.eden` it was converted from — byte for byte for
    /// the canonical fixtures — and it parses to the same world (chunks, trailer/signs).
    #[test]
    fn staging_an_emod_reproduces_its_source_world() {
        for (emod_name, eden_name) in [
            ("f64-basic.zlib.emod", "f64-basic.eden.gz"),
            ("f256-trailer.none.emod.gz", "f256-trailer.eden.gz"),
        ] {
            let dir = std::env::temp_dir().join(format!("vuencedit-emod-test-{}-{emod_name}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let src = dir.join("w.emod");
            let eden = dir.join("w.eden");
            std::fs::write(&src, fixture(emod_name)).unwrap();
            std::fs::write(&eden, fixture(eden_name)).unwrap();
            let temp = temp_world_path();
            let s = stage_emod(&src, &temp).unwrap();
            assert!(s.damage.is_empty() && !s.torn);
            assert_eq!(std::fs::read(&temp).unwrap(), std::fs::read(&eden).unwrap(), "{emod_name}");
            let (staged, source) = (parse_file(&temp), parse_file(&eden));
            assert_same_world(&source, &staged);
            assert_eq!(s.ord_of.len(), staged.chunk_map.len());
            assert_eq!(s.next_ord as usize, s.ord_of.len(), "a fresh conversion's ords are dense");
            drop(staged);
            let _ = std::fs::remove_file(&temp);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_two_batch_emod_stages_its_latest_state() {
        let dir = std::env::temp_dir().join(format!("vuencedit-emod-2b-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("w.emod");
        std::fs::write(&src, fixture("f256-trailer.2batch.emod")).unwrap();
        let temp = temp_world_path();
        let s = stage_emod(&src, &temp).unwrap();
        let w = parse_file(&temp);
        assert_eq!(w.chunk_map.len(), s.ord_of.len());
        let mut store = Store::open(&src).unwrap();
        let mut col = vec![0u8; store.column_len()];
        for (x, z) in store.column_keys() {
            store.read_column(x, z, &mut col).unwrap();
            let (a, b) = w.chunk_range(x, z).unwrap();
            assert_eq!(&w.bytes[a..b], &col[..], "column ({x},{z})");
        }
        drop(w);
        let _ = std::fs::remove_file(&temp);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_refused_file_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("vuencedit-emod-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("bad.emod");
        let mut bytes = fixture("f64-basic.zlib.emod");
        bytes[60] ^= 1; // file-header CRC
        std::fs::write(&src, &bytes).unwrap();
        let temp = temp_world_path();
        let e = stage_emod(&src, &temp).unwrap_err();
        assert!(e.contains("can't be opened"), "{e}");
        assert!(!temp.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 26.4's measurement (plan §4): `VUENCEDIT_EMOD_MEASURE=<dir>` holding `X.eden` + `X.emod`
    /// pairs (`emod.py convert -o X.emod X.eden`). Times `.eden` staging (APFS clone / copy) against
    /// `.emod` staging (sparse export) and reports the temp's allocated bytes. Not CI.
    #[test]
    #[ignore]
    fn measure_emod_open() {
        let Ok(dir) = std::env::var("VUENCEDIT_EMOD_MEASURE") else { return };
        let mut pairs: Vec<PathBuf> = walk(Path::new(&dir)).into_iter().filter(|p| is_emod_path(p)).collect();
        pairs.sort();
        for emod_path in pairs {
            let eden = emod_path.with_extension("eden");
            if !eden.exists() { continue; }
            let t = std::time::Instant::now();
            let temp_e = temp_world_path();
            crate::stage_copy(&eden, &temp_e).unwrap();
            let we = parse_file(&temp_e);
            let eden_ms = t.elapsed().as_millis();
            let t = std::time::Instant::now();
            let temp_m = temp_world_path();
            stage_emod(&emod_path, &temp_m).unwrap();
            let stage_ms = t.elapsed().as_millis();
            let wm = parse_file(&temp_m);
            let emod_ms = t.elapsed().as_millis();
            assert_same_world(&we, &wm);
            println!(
                "{}: .eden {} B staged+parsed {} ms (alloc {} B) | .emod {} B staged {} ms, +parse {} ms (temp {} B, alloc {} B)",
                emod_path.file_name().unwrap().to_string_lossy(),
                std::fs::metadata(&eden).unwrap().len(), eden_ms, allocated(&temp_e),
                std::fs::metadata(&emod_path).unwrap().len(), stage_ms, emod_ms,
                std::fs::metadata(&temp_m).unwrap().len(), allocated(&temp_m),
            );
            drop((we, wm));
            let _ = std::fs::remove_file(&temp_e);
            let _ = std::fs::remove_file(&temp_m);
        }
    }

    fn walk(d: &Path) -> Vec<PathBuf> {
        let mut v = Vec::new();
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() { v.extend(walk(&p)) } else { v.push(p) }
        }
        v
    }

    /// Bytes the file actually occupies on disk (holes excluded; an APFS clone reports its own
    /// blocks even though it shares them, so the `.eden` figure is an upper bound).
    fn allocated(p: &Path) -> u64 {
        #[cfg(unix)]
        { use std::os::unix::fs::MetadataExt; std::fs::metadata(p).map_or(0, |m| m.blocks() * 512) }
        #[cfg(not(unix))]
        { std::fs::metadata(p).map_or(0, |m| m.len()) }
    }

    // ── 27.0b: SIGN_TRAILER ────────────────────────────────────────────────────────────────

    fn image(state: &AppState) -> Vec<u8> {
        let ws = read_ws(state);
        let i = ws.world.as_ref().unwrap().file_image();
        [i.head, &i.tail].concat()
    }

    /// A touched trailer is saved as `SIGN_TRAILER` (and reopens as the world's trailer), the
    /// session's export length follows it, an autosave on that Emod base recovers with the new
    /// length, and an emptied trailer removes the record.
    #[test]
    fn save_in_place_writes_sign_trailer() {
        use eden_format::eden::trailer::Pos;
        let (dir, src) = scratch("signtrailer", "f64-basic.zlib.emod");
        let (state, temp) = open_session(&src);
        let tail = {
            let mut ws = write_ws(&state);
            let w = ws.world.as_mut().unwrap();
            assert!(w.trailer_bytes().is_empty(), "the fixture has no trailer");
            let p = Pos::new(w.min_x * 16 + 2, w.min_y * 16 + 2, 10);
            w.trailer.add_sign(p, 3, 2, 1, b"hello").unwrap();
            ws.dirty.mark_trailer();
            ws.world.as_ref().unwrap().trailer_bytes()
        };
        let saved = save_in_place(&state, &src, None).unwrap();
        assert!(saved.trailer && saved.columns == 0, "a trailer-only save appends just SIGN_TRAILER");
        {
            let ws = read_ws(&state);
            assert!(!ws.dirty.trailer_disk);
            let w = ws.world.as_ref().unwrap();
            assert_eq!(ws.emod.as_ref().unwrap().export_len, w.trailer_start + tail.len() as u64);
        }
        let again = save_in_place(&state, &src, None).unwrap();
        assert_eq!(again.appended, 0, "nothing owed: nothing written");
        let temp2 = dir.join("reopen.eden");
        let session = stage_emod(&src, &temp2).unwrap();
        let reopened = parse_file(&temp2);
        assert_eq!(reopened.trailer_bytes(), tail);
        assert_eq!(reopened.trailer.signs()[0].text(), b"hello");
        assert_eq!(session.export_len, read_ws(&state).emod.as_ref().unwrap().export_len);
        drop(reopened);

        // Autosave on the Emod base: its export is now longer than the temp, and recovery agrees.
        let paths = autosave_dir(&dir);
        edit(&state);
        tick(&state, &paths);
        assert!(matches!(meta_base(&paths), crate::AutosaveBase::Emod(_)));
        let fresh: AppState = std::sync::RwLock::new(crate::WorldState::new());
        crate::load_autosave_inner(&fresh, &paths).expect("recovery onto the longer export");
        assert_eq!(image(&fresh), image(&state), "the recovered world is the ticked one");
        drop_recovered(fresh);

        // Empty the trailer: the record goes away.
        {
            let mut ws = write_ws(&state);
            ws.world.as_mut().unwrap().trailer.remove_sign(0).unwrap();
            ws.dirty.mark_trailer();
        }
        assert!(save_in_place(&state, &src, None).unwrap().trailer);
        let temp3 = dir.join("reopen2.eden");
        stage_emod(&src, &temp3).unwrap();
        assert!(parse_file(&temp3).trailer_bytes().is_empty(), "an empty SIGN_TRAILER = no trailer");
        cleanup(state, &temp, &dir);
    }
}
