//! Gate 1 (Emod S.3): the checked-in fixture pack, copied verbatim from
//! `~/emod/port/tools/fixtures/emod/` (written by `emod.py fixtures-pack`; regenerate there, never
//! hand-edit). Every `.emod` that only `emod.py` wrote — two batches, zlib, raw — reads back to the
//! state `expected.txt` pins.
//!
//! The `convert` lines are 26.2's gate (the converter); this file uses their pinned hashes for
//! compaction instead: compaction copies zstd payloads verbatim and re-encodes anything else at
//! zstd-3, so compacting the zlib / raw conversions must reproduce `emod.py convert`'s zstd output
//! byte for byte. That pins this crate's zstd writer to emod.py's.

mod common;

use common::*;
use eden_format::emod::{ReadStatus, RecordType, Store, BAND};

#[test]
fn pack_is_complete() {
    let ex = expected();
    assert_eq!(ex.len(), 11, "expected.txt: 8 convert + 3 read lines");
    for e in &ex {
        assert!(fixtures_dir().join(&e.file).is_file(), "{} missing from tests/fixtures", e.file);
        assert!(e.kind == "convert" || e.kind == "read", "unknown line kind {}", e.kind);
    }
    assert_eq!(ex.iter().filter(|e| e.kind == "read").count(), 3);
}

#[test]
fn every_emod_reads_to_the_pinned_state() {
    let tmp = TempDir::new("read");
    for e in expected().into_iter().filter(|e| e.kind == "read") {
        let bytes = fixture(&e.file);
        assert_eq!(sha256_hex(&bytes), e.sha256, "{}: pack file intact", e.file);
        let p = tmp.path(e.file.trim_end_matches(".gz"));
        std::fs::write(&p, &bytes).unwrap();
        let mut s = Store::open(&p).unwrap_or_else(|err| panic!("{}: {err}", e.file));
        assert!(!s.damaged(), "{}: damaged at open: {:?}", e.file, s.damage());
        assert!(!s.torn() && s.tail_bytes() == 0, "{}: clean tail", e.file);
        assert_eq!(s.state_digest().unwrap(), e.digest, "{}: reads to emod.py's state", e.file);
        let v = s.verify().unwrap();
        assert!(v.is_empty(), "{}: verify clean, got {v:?}", e.file);
        assert!(!s.damaged());
        // every live column reads through the public API
        let mut col = vec![0u8; s.column_len()];
        for c in s.columns() {
            let (st, mask) = s.read_column(c.x, c.z, &mut col).unwrap();
            assert_eq!((st, mask), (ReadStatus::Ok, c.mask), "{}: column ({},{})", e.file, c.x, c.z);
            for b in 0..s.bands() as usize {
                let stored = c.mask >> b & 1 != 0;
                assert_eq!(stored, col[b * BAND..(b + 1) * BAND].iter().any(|&v| v != 0), "canonical band {b}");
            }
        }
        let (st, hdr) = s.read_record(RecordType::WorldHeader).unwrap();
        assert_eq!((st, hdr.len()), (ReadStatus::Ok, 192));
    }
}

#[test]
fn two_batch_file_rewrites_and_adds() {
    let tmp = TempDir::new("2batch");
    let p = tmp.path("f256-trailer.2batch.emod");
    std::fs::write(&p, fixture("f256-trailer.2batch.emod")).unwrap();
    let s = Store::open(&p).unwrap();
    assert_eq!(s.bands(), 16);
    assert_eq!(s.last_seq(), 2);
    // f256-trailer has 8 columns at ords 0–7; batch 2 rewrote one and added (5000,5000) at ord 8
    assert_eq!(s.column_count(), 9);
    assert_eq!(s.column_ord(5000, 5000), Some(8));
    let sm = s.summary();
    assert_eq!((sm.live_columns, sm.next_ord), (9, 9));
    assert!(s.has_record(RecordType::SignTrailer) && s.has_record(RecordType::Provenance));
    assert!(s.dead_bytes() > 0, "the superseded column / creatures / header are dead");
    assert!(!s.should_compact(), "far under the 4 MiB floor");
}

/// Truncating the two-batch file to its first COMMIT gives exactly `emod.py convert`'s output for
/// f256-trailer (the pack built it as convert + append), at that conversion's pinned state.
#[test]
fn first_commit_of_the_two_batch_file_is_the_conversion() {
    let conv = expected_for("f256-trailer.eden.gz");
    let full = fixture("f256-trailer.2batch.emod");
    let first_end = {
        let recs = walk(&full);
        let c = recs.iter().find(|r| r.rtype == 7).unwrap();
        c.off + 32 + 24
    };
    assert_eq!(sha256_hex(&full[..first_end]), conv.sha256);
    let tmp = TempDir::new("first");
    let p = tmp.path("f256-trailer.emod");
    std::fs::write(&p, &full[..first_end]).unwrap();
    assert_eq!(digest_of(&p), (true, false, conv.digest.clone()));
}

fn compact_bytes(name: &str, bytes: &[u8]) -> (Vec<u8>, String) {
    let tmp = TempDir::new("compact");
    let p = tmp.path(name);
    std::fs::write(&p, bytes).unwrap();
    let mut s = Store::open_rw(&p).unwrap();
    let before = s.state_digest().unwrap();
    s.compact().unwrap();
    assert_eq!(s.state_digest().unwrap(), before, "{name}: compaction keeps the state");
    assert_eq!((s.last_seq(), s.dead_bytes()), (1, 0), "{name}: one batch, no dead bytes");
    assert!(s.verify().unwrap().is_empty(), "{name}: verify clean after compaction");
    assert!(!tmp.path(&format!("{name}.compact")).exists(), "no .compact left behind");
    drop(s);
    (std::fs::read(&p).unwrap(), before)
}

#[test]
fn compacting_the_zlib_and_raw_conversions_reproduces_emod_py_convert() {
    for (src, conv) in [
        ("f64-basic.zlib.emod", "f64-basic.eden.gz"),
        ("f256-trailer.none.emod.gz", "f256-trailer.eden.gz"),
    ] {
        let want = expected_for(conv);
        let (out, digest) = compact_bytes(src.trim_end_matches(".gz"), &fixture(src));
        assert_eq!(digest, want.digest, "{src}: same state as the zstd conversion");
        assert_eq!(sha256_hex(&out), want.sha256, "{src}: compacted == emod.py convert --epoch 0, byte for byte");
    }
}

#[test]
fn compacting_a_fresh_conversion_reproduces_it() {
    let full = fixture("f256-trailer.2batch.emod");
    let recs = walk(&full);
    let c = recs.iter().find(|r| r.rtype == 7).unwrap();
    let conv = &full[..c.off + 56];
    let (out, _) = compact_bytes("f256-trailer.emod", conv);
    assert!(out == conv, "compact(convert(x)) == convert(x)");
}

#[test]
fn compacting_the_two_batch_file_keeps_its_state() {
    let want = expected_for("f256-trailer.2batch.emod");
    let (out, digest) = compact_bytes("f256-trailer.2batch.emod", &fixture("f256-trailer.2batch.emod"));
    assert_eq!(digest, want.digest);
    assert!(out.len() < fixture("f256-trailer.2batch.emod").len());
    // the superseded column, creatures and header are gone: exactly one batch of live records
    let recs = walk(&out);
    assert!(recs.iter().all(|r| r.seq == 1));
    assert_eq!(recs.iter().filter(|r| r.rtype == 1).count(), 9);
    assert_eq!(recs.iter().filter(|r| r.rtype == 7).count(), 1);
}
