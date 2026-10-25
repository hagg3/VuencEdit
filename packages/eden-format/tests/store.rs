//! The store's own contract: create → first commit → rename, ords and SUMMARY, compaction, the
//! decode fallback, refusals, reserved types and GENERATOR. Ports Emod's `section_writer`,
//! `section_fallback` and `section_errors` (the store half; the converter half is 26.2's).

mod common;

use common::*;
use eden_format::emod::{Codec, EncodedColumn, Error, OpenOptions, ReadStatus, RecordType, Store, BAND};

fn ords(s: &Store) -> Vec<((i32, i32), u32)> {
    s.columns().into_iter().map(|c| ((c.x, c.z), c.ord)).collect()
}

fn new_world(path: &std::path::Path, bands: u16) -> Store {
    let mut s = Store::create(path, bands, 1_234_567).unwrap();
    s.begin_batch();
    s.put_record(RecordType::WorldHeader, &eden_header(if bands == 16 { 5 } else { 4 }, "writer")).unwrap();
    s.put_record(RecordType::Creatures, &vec![0u8; 200 * 60]).unwrap();
    s
}

#[test]
fn create_appears_only_after_the_first_commit() {
    let tmp = TempDir::new("create");
    let p = tmp.path("w.emod");
    let mut s = Store::create(&p, 4, 1_234_567).unwrap();
    assert!(!p.exists() && tmp.path("w.emod.creating").exists(), "nothing at the final path before the first commit");
    // a file header with no commit is no world
    assert!(matches!(Store::open(tmp.path("w.emod.creating")), Err(Error::Refused(_))));
    let c0 = make_column(&mut Rng(77), 4, 3);
    s.begin_batch();
    s.put_column(10, 10, &c0).unwrap();
    assert!(matches!(s.commit(), Err(Error::Invalid(_))), "first batch without WORLD_HEADER/CREATURES refused");
    s.begin_batch();
    s.put_record(RecordType::WorldHeader, &eden_header(4, "writer")).unwrap();
    s.put_record(RecordType::Creatures, &vec![0u8; 200 * 60]).unwrap();
    s.put_column(10, 10, &c0).unwrap();
    s.commit().unwrap();
    assert!(p.exists() && !tmp.path("w.emod.creating").exists());
    assert_eq!(s.path(), p.as_path());
    drop(s);
    let s = Store::open(&p).unwrap();
    assert_eq!((s.bands(), s.created_unix(), s.last_seq(), s.column_count()), (4, 1_234_567, 1, 1));
}

#[test]
fn ords_summary_rewrites_and_compaction() {
    let tmp = TempDir::new("writer");
    let p = tmp.path("w.emod");
    let mut r = Rng(77);
    let (c0, c1, c2) = (make_column(&mut r, 4, 4), make_column(&mut r, 4, 2), make_column(&mut r, 4, 3));
    let mut s = new_world(&p, 4);
    s.put_column(10, 10, &c0).unwrap();
    s.put_column(11, 10, &c1).unwrap();
    s.put_column(12, 10, &c2).unwrap();
    s.commit().unwrap();
    assert!(matches!(s.put_column(0, 0, &c0), Err(Error::Invalid(_))), "key (0,0) refused (twoToOne key 0)");
    assert!(matches!(s.put_column(-1, 3, &c0), Err(Error::Invalid(_))));
    assert!(matches!(s.put_column(1, 1, &c0[..100]), Err(Error::Invalid(_))));
    drop(s);

    let mut s = Store::open_rw(&p).unwrap();
    assert_eq!(s.column_keys(), vec![(10, 10), (11, 10), (12, 10)], "ords 0,1,2 in put order");
    // a rewrite keeps its ord; a new column gets next_ord; SUMMARY exact
    let mut c1b = c1.clone();
    c1b[5] ^= 1;
    let mut tall = vec![0u8; 4 * BAND];
    tall[3 * BAND + 9] = 5; // only band 3
    s.begin_batch();
    s.put_column(11, 10, &c1b).unwrap();
    s.put_column(13, 10, &tall).unwrap();
    s.put_column(14, 10, &vec![0u8; 4 * BAND]).unwrap(); // an all-air column
    s.commit().unwrap();
    assert_eq!(ords(&s), vec![((10, 10), 0), ((11, 10), 1), ((12, 10), 2), ((13, 10), 3), ((14, 10), 4)]);
    let sm = s.summary();
    assert_eq!((sm.live_columns, sm.next_ord), (5, 5));
    assert_ne!(sm.band_or & 8, 0);
    assert_eq!(s.column_mask(13, 10), 8, "a band-3-only column stores mask 0x8");
    assert_eq!(s.column_mask(14, 10), 0);
    let mut got = vec![0u8; 4 * BAND];
    assert_eq!(s.read_column(11, 10, &mut got).unwrap().0, ReadStatus::Ok);
    assert_eq!(got, c1b, "the newest version is read");
    assert_eq!(s.read_column(14, 10, &mut got).unwrap(), (ReadStatus::Ok, 0));
    assert!(got.iter().all(|&b| b == 0));
    assert_eq!(s.read_column(99, 99, &mut got).unwrap(), (ReadStatus::Absent, 0));
    assert_eq!(s.last_seq(), 2);
    assert!(s.verify().unwrap().is_empty(), "verify clean after appends (SUMMARY exact, prev_commit chain)");
    // mask 0 is codec 0 with an empty payload on disk
    let f = std::fs::read(&p).unwrap();
    let air = walk(&f).into_iter().find(|q| q.rtype == 1 && rd32(&f[q.off + 8..]) == 14).unwrap();
    assert_eq!((air.plen, f[air.off + 5], rd32(&f[air.off + 6..]) & 0xffff), (0, 0, 0));

    // many saves, then compaction
    let mut c0 = c0;
    let cr = vec![0u8; 200 * 60];
    for i in 0..40 {
        s.begin_batch();
        c0[100 + i] ^= 0x33;
        s.put_column(10, 10, &c0).unwrap();
        s.put_record(RecordType::Creatures, &cr).unwrap();
        s.commit().unwrap();
    }
    assert_eq!(s.last_seq(), 42);
    let before = s.state_digest().unwrap();
    let (size_before, dead) = (s.file_size(), s.dead_bytes());
    assert!(dead > 0, "dead bytes accounted ({dead} of {size_before})");
    s.compact().unwrap();
    assert_eq!(s.state_digest().unwrap(), before);
    assert!(s.file_size() < size_before);
    assert_eq!((s.last_seq(), s.dead_bytes(), s.created_unix()), (1, 0, 1_234_567));
    assert!(s.verify().unwrap().is_empty(), "verify clean after compaction");
    assert!(!tmp.path("w.emod.compact").exists(), "no .compact left");
    // a save after compaction continues from seq 2, and ords survive
    s.begin_batch();
    s.put_column(15, 10, &c2).unwrap();
    s.commit().unwrap();
    assert_eq!(s.last_seq(), 2);
    assert_eq!(s.column_ord(15, 10), Some(5));
    assert_eq!(s.column_ord(13, 10), Some(3));
    drop(s);

    // a read-only store refuses writes and compaction
    let mut s = Store::open(&p).unwrap();
    assert!(matches!(s.put_column(16, 10, &c2), Err(Error::Invalid(_))));
    assert!(matches!(s.compact(), Err(Error::Invalid(_))));
}

#[test]
fn a_column_rewritten_twice_in_one_batch_keeps_one_ord() {
    let tmp = TempDir::new("twice");
    let p = tmp.path("w.emod");
    let mut s = new_world(&p, 4);
    let mut c = vec![0u8; 4 * BAND];
    c[1] = 1;
    s.put_column(20, 20, &c).unwrap();
    c[2] = 2;
    s.put_column(20, 20, &c).unwrap();
    s.put_column(21, 20, &c).unwrap();
    s.commit().unwrap();
    assert_eq!(ords(&s), vec![((20, 20), 0), ((21, 20), 1)]);
    assert_eq!(s.summary().live_columns, 2);
    let mut got = vec![0u8; 4 * BAND];
    s.read_column(20, 20, &mut got).unwrap();
    assert_eq!(got, c, "the later put wins");
    assert!(s.verify().unwrap().is_empty());
}

#[test]
fn encoded_columns_and_codecs() {
    let tmp = TempDir::new("codecs");
    let p = tmp.path("w.emod");
    let mut s = new_world(&p, 16);
    let mut r = Rng(5);
    let col = make_column(&mut r, 16, 6);
    // off-thread encode (the 26.5 rayon path) == put_column
    let enc = EncodedColumn::encode(&col, 16, Codec::Zstd, &mut eden_format::emod::Codecs::new()).unwrap();
    assert_eq!(enc.mask, 0b11_1111);
    s.put_encoded_column(30, 30, &enc).unwrap();
    s.put_column(31, 30, &col).unwrap();
    assert!(matches!(
        s.put_encoded_column(32, 30, &EncodedColumn { mask: 0, codec: Codec::Zstd, payload: vec![1] }),
        Err(Error::Invalid(_))
    ));
    s.set_codec(Codec::Zlib);
    s.put_column(33, 30, &col).unwrap();
    s.set_codec(Codec::None);
    s.put_column(34, 30, &col).unwrap();
    s.commit().unwrap();
    let f = std::fs::read(&p).unwrap();
    let codecs: Vec<u8> = walk(&f).into_iter().filter(|q| q.rtype == 1).map(|q| f[q.off + 5]).collect();
    assert_eq!(codecs, vec![1, 1, 2, 0], "zstd, zstd, zlib, raw");
    let a = walk(&f).into_iter().filter(|q| q.rtype == 1).take(2).map(|q| f[q.poff..q.poff + q.plen].to_vec());
    let a: Vec<_> = a.collect();
    assert_eq!(a[0], a[1], "encode-then-put writes the same payload as put_column");
    drop(s);
    let mut s = Store::open(&p).unwrap();
    let mut got = vec![0u8; 16 * BAND];
    for x in [30, 31, 33, 34] {
        assert_eq!(s.read_column(x, 30, &mut got).unwrap(), (ReadStatus::Ok, 0b11_1111));
        assert_eq!(got, col);
    }
    assert!(s.verify().unwrap().is_empty());
}

#[test]
fn put_record_validates_lengths() {
    let tmp = TempDir::new("records");
    let mut s = new_world(&tmp.path("w.emod"), 4);
    for (t, n) in [
        (RecordType::WorldHeader, 191),
        (RecordType::Creatures, 61),
        (RecordType::Creatures, 401 * 60),
        (RecordType::SignTrailer, 17),
        (RecordType::SignTrailer, (1 << 20) + 16),
        (RecordType::Generator, 27),
    ] {
        assert!(matches!(s.put_record(t, &vec![0u8; n]), Err(Error::Invalid(_))), "{t:?} {n}");
    }
    for t in [RecordType::Column, RecordType::Summary, RecordType::Commit, RecordType::Index] {
        assert!(s.put_record(t, &[0u8; 16]).is_err(), "{t:?} is not a put_record type");
    }
    s.put_record(RecordType::Creatures, &[]).unwrap(); // 0 slots is legal (the sibling editor writes none)
    s.put_record(RecordType::SignTrailer, &[]).unwrap();
    s.commit().unwrap();
    assert!(s.verify().unwrap().is_empty());
}

/// GENERATOR (H.4) is stored raw, survives saves, and compaction copies it last of the
/// singletons (after PROVENANCE, before the columns).
#[test]
fn generator_survives_and_compacts_last_of_the_singletons() {
    let tmp = TempDir::new("gen");
    let p = tmp.path("f256-trailer.emod");
    let full = fixture("f256-trailer.2batch.emod");
    std::fs::write(&p, &full).unwrap();
    let gen: Vec<u8> = (0..28u8).map(|i| if i < 17 { i + 1 } else { 0 }).collect();
    let mut s = Store::open_rw(&p).unwrap();
    s.begin_batch();
    s.put_record(RecordType::Generator, &gen).unwrap();
    s.commit().unwrap();
    assert_eq!(s.read_record(RecordType::Generator).unwrap(), (ReadStatus::Ok, gen.clone()));
    assert!(s.verify().unwrap().is_empty());
    s.compact().unwrap();
    assert_eq!(s.read_record(RecordType::Generator).unwrap(), (ReadStatus::Ok, gen));
    drop(s);
    let f = std::fs::read(&p).unwrap();
    let types: Vec<u8> = walk(&f).into_iter().map(|q| q.rtype).collect();
    assert_eq!(&types[..6], &[2, 3, 4, 5, 9, 1], "WORLD_HEADER, CREATURES, SIGN_TRAILER, PROVENANCE, GENERATOR, COLUMN…");
    let g = walk(&f).into_iter().find(|q| q.rtype == 9).unwrap();
    assert_eq!(f[g.off + 5], 0, "GENERATOR is codec 0");
}

/// `OpenOptions::len_limit`: the prefix up to an earlier truncation point opens as that earlier
/// state, even after another writer appended (what VuencEdit's autosave recovery as a copy relies on).
#[test]
fn a_length_limited_open_reads_the_earlier_state() {
    let tmp = TempDir::new("limit");
    let p = tmp.path("w.emod");
    std::fs::write(&p, fixture("f256-trailer.2batch.emod")).unwrap();
    let mut before = Store::open(&p).unwrap();
    let (cut, commit, digest) = (before.truncation_point(), before.last_commit(), before.state_digest().unwrap());
    drop(before);
    let mut s = Store::open_rw(&p).unwrap();
    let (_, c) = s.read_record(RecordType::Creatures).unwrap();
    let mut c2 = c.clone();
    c2[0] ^= 1;
    s.begin_batch();
    s.put_record(RecordType::Creatures, &c2).unwrap();
    s.commit().unwrap();
    drop(s);
    let open_at = |limit| Store::open_with(&p, OpenOptions { len_limit: Some(limit), ..OpenOptions::default() });
    let mut old = open_at(cut).unwrap();
    assert_eq!((old.last_commit(), old.file_size(), old.tail_bytes()), (commit, cut, 0));
    assert_eq!(old.state_digest().unwrap(), digest);
    assert_eq!(old.read_record(RecordType::Creatures).unwrap().1, c);
    // A limit past the end is the whole file; a limited open can't write.
    assert_ne!(open_at(u64::MAX).unwrap().last_commit(), commit);
    let rw = OpenOptions { writable: true, len_limit: Some(cut), ..OpenOptions::default() };
    assert!(matches!(Store::open_with(&p, rw), Err(Error::Invalid(_))));
}

/// A reserved type is a member of its batch (the batch check counts it) and otherwise ignored;
/// `verify` reports it; compaction drops it.
#[test]
fn reserved_types_are_counted_ignored_reported_and_dropped() {
    let tmp = TempDir::new("reserved");
    let p = tmp.path("r.emod");
    let mut f = fixture("f256-trailer.2batch.emod");
    let prov = walk(&f).into_iter().find(|q| q.rtype == 5).unwrap();
    f[prov.off + 4] = 12;
    reseal(&mut f, prov);
    std::fs::write(&p, &f).unwrap();
    let mut s = Store::open_rw(&p).unwrap();
    assert!(!s.damaged() && !s.torn(), "the batch still checks: the reserved record is a member");
    assert!(!s.has_record(RecordType::Provenance));
    assert_eq!(s.state_digest().unwrap(), expected_for("f256-trailer.2batch.emod").digest, "ignored");
    let v = s.verify().unwrap();
    assert!(v.len() == 1 && v[0].contains("reserved type 12"), "verify reports it: {v:?}");
    s.compact().unwrap();
    assert!(s.verify().unwrap().is_empty(), "compaction dropped it");
    assert!(walk(&std::fs::read(&p).unwrap()).iter().all(|q| q.rtype != 12));
}

#[test]
fn an_undecodable_record_falls_back_or_loads_as_air() {
    let tmp = TempDir::new("fallback");
    let p = tmp.path("fb.emod");
    let full = fixture("f256-trailer.2batch.emod");
    let c1 = walk(&full).into_iter().find(|r| r.rtype == 7).unwrap();
    std::fs::write(&p, &full[..c1.off + 56]).unwrap();
    let keys;
    let mut v1 = vec![0u8; 16 * BAND];
    {
        let mut s = Store::open_rw(&p).unwrap();
        keys = s.column_keys();
        s.read_column(keys[0].0, keys[0].1, &mut v1).unwrap();
        let mut v2 = v1.clone();
        v2[77] ^= 0x40;
        s.begin_batch();
        s.put_column(keys[0].0, keys[0].1, &v2).unwrap();
        s.commit().unwrap();
    }
    // break the zstd frame of the NEWEST version of keys[0] (seq 2) and of keys[1] (its only
    // version); reseal so both still frame and commit: only decoding can catch them
    let mut f = std::fs::read(&p).unwrap();
    for r in walk(&f) {
        if r.rtype != 1 || r.plen < 16 {
            continue;
        }
        let k = (rd32(&f[r.off + 8..]) as i32, rd32(&f[r.off + 12..]) as i32);
        if (r.seq == 2 && k == keys[0]) || (r.seq == 1 && k == keys[1]) {
            f[r.poff + r.plen / 2] ^= 0xff;
            reseal(&mut f, r);
        }
    }
    std::fs::write(&p, &f).unwrap();
    let mut s = Store::open_rw(&p).unwrap();
    assert!(!s.damaged(), "the resealed file opens with no framing damage");
    let mut got = vec![0xEEu8; 16 * BAND];
    let (st, _) = s.read_column(keys[0].0, keys[0].1, &mut got).unwrap();
    assert_eq!(st, ReadStatus::Fallback);
    assert_eq!(got, v1, "an undecodable newest version falls back to the previous committed one");
    got.fill(0xEE);
    assert_eq!(s.read_column(keys[1].0, keys[1].1, &mut got).unwrap(), (ReadStatus::AirDamaged, 0));
    assert!(got.iter().all(|&b| b == 0), "an undecodable only version loads as air (never the default map)");
    assert!(s.damaged(), "both set the damaged flag");
    assert!(matches!(s.compact(), Err(Error::Damaged(_))), "compaction is refused while damaged");
    assert!(p.exists() && !tmp.path("fb.emod.compact").exists());
    assert!(!s.verify().unwrap().is_empty(), "verify reports it");
    // a damaged store still appends (damage blocks compaction only)
    s.begin_batch();
    s.put_column(6000, 6000, &got).unwrap();
    s.commit().unwrap();
}

#[test]
fn refused_inputs() {
    let tmp = TempDir::new("refuse");
    let junk = tmp.path("junk.emod");
    std::fs::write(&junk, vec![0x42u8; 4096]).unwrap();
    assert!(matches!(Store::open(&junk), Err(Error::Refused(_))), "a non-.emod file is refused");
    std::fs::write(&junk, b"EMODWLD\0").unwrap();
    assert!(matches!(Store::open(&junk), Err(Error::Refused(_))), "shorter than a file header");
    let good = fixture("f64-basic.zlib.emod");
    // flags non-zero (a newer writer), fmt_version 2, bands 8 — each with a valid header CRC
    for (at, v) in [(12usize, 1u8), (8, 2), (10, 8), (30, 1)] {
        let mut b = good.clone();
        b[at] = v;
        let c = crc32fast::hash(&b[..60]);
        b[60..64].copy_from_slice(&c.to_le_bytes());
        std::fs::write(&junk, &b).unwrap();
        assert!(matches!(Store::open(&junk), Err(Error::Refused(_))), "header byte {at} = {v}");
    }
    assert!(matches!(Store::create(tmp.path("x.emod"), 8, 0), Err(Error::Invalid(_))));
    assert!(matches!(Store::open(tmp.path("missing.emod")), Err(Error::Io(_))));
}

#[test]
fn compaction_policy() {
    let tmp = TempDir::new("policy");
    let p = tmp.path("w.emod");
    let mut s = new_world(&p, 16);
    s.set_codec(Codec::None); // 128 KiB per rewrite: reach the 4 MiB floor in a few dozen saves
    let mut c = make_column(&mut Rng(9), 16, 16);
    s.put_column(40, 40, &c).unwrap();
    s.commit().unwrap();
    assert!(!s.should_compact());
    let mut saves = 0;
    while !s.should_compact() {
        c[saves] ^= 1;
        s.begin_batch();
        s.put_column(40, 40, &c).unwrap();
        s.commit().unwrap();
        saves += 1;
        assert!(saves < 64);
    }
    assert!(s.dead_bytes() > 4 << 20 && s.dead_bytes() > s.truncation_point() / 2);
    // 32 superseded 128 KiB payloads are exactly 4 MiB; their headers and the dead SUMMARY/COMMIT
    // records tip it over. Half the file was passed long before: the floor decides.
    assert_eq!(saves, 32, "the 4 MiB floor, not half the file, decides here");
    let last = s.last_commit().unwrap();
    s.compact().unwrap();
    assert!(!s.should_compact());
    assert_ne!(s.last_commit().unwrap(), last, "compaction is a new identity");
    let mut got = vec![0u8; 16 * BAND];
    s.read_column(40, 40, &mut got).unwrap();
    assert_eq!(got, c);
}
