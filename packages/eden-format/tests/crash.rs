//! Gate 2 (Emod S.3, K4): the real [`Store::commit`] killed after every byte `k` of a batch —
//! the prefix alone, and the prefix with the rest zero-filled (a filesystem that persisted the size
//! but not the data). Every outcome must be the old commit or the new one, never a mix; a torn
//! tail is never damage; and the next save after every crash writes exactly the uncrashed file.
//! Then the reordering-disk cases (a COMMIT reached the platter, a record of its batch did not)
//! and a long torn tail followed by a short save. Port of `section_crash`.
//!
//! The base is `emod.py convert` of f256-trailer (256z, sign trailer, PROVENANCE): the pack's
//! two-batch file cut at its first COMMIT. The batch touches every kind of record a save writes.

mod common;

use common::*;
use eden_format::emod::{Error, RecordType, Store, BAND};
use std::path::Path;

/// The batch under test: one column dug out to a sparse one (a paint-only band included), one new
/// column, and new CREATURES, WORLD_HEADER and SIGN_TRAILER. Sparse columns keep the batch small
/// enough to kill at every byte.
fn second_batch(s: &mut Store) -> Result<(), Error> {
    let keys = s.column_keys();
    let n = s.column_len();
    s.begin_batch();
    let mut dug = vec![0u8; n];
    dug[123] = 1;
    dug[2 * BAND + 4096 + 7] = 9; // band 2: air types, painted
    s.put_column(keys[0].0, keys[0].1, &dug)?;
    let mut fresh = vec![0u8; n];
    for i in (0..4096).step_by(97) {
        fresh[i] = 3;
        fresh[BAND + i] = 2;
    }
    s.put_column(5100, 5100, &fresh)?;
    let (_, mut cr) = s.read_record(RecordType::Creatures)?;
    cr[3] ^= 0x11;
    s.put_record(RecordType::Creatures, &cr)?;
    let (_, mut h) = s.read_record(RecordType::WorldHeader)?;
    h[4] ^= 1;
    s.put_record(RecordType::WorldHeader, &h)?;
    let (_, mut t) = s.read_record(RecordType::SignTrailer)?;
    t[20] ^= 0x20;
    s.put_record(RecordType::SignTrailer, &t)?;
    s.commit()
}

fn conversion() -> Vec<u8> {
    let full = fixture("f256-trailer.2batch.emod");
    let c = walk(&full).into_iter().find(|r| r.rtype == 7).unwrap();
    full[..c.off + 56].to_vec()
}

fn write(p: &Path, b: &[u8]) {
    std::fs::write(p, b).unwrap();
}

#[test]
fn a_commit_killed_at_any_byte_is_the_old_or_the_new_state() {
    let tmp = TempDir::new("crash");
    let (base, full, t) = (tmp.path("base.emod"), tmp.path("full.emod"), tmp.path("case.emod"));
    let b0 = conversion();
    write(&base, &b0);
    write(&full, &b0);
    {
        let mut s = Store::open_rw(&full).unwrap();
        second_batch(&mut s).unwrap();
    }
    let b1 = std::fs::read(&full).unwrap();
    let (d0, d1) = (digest_of(&base).2, digest_of(&full).2);
    assert!(d0 != d1 && b1.len() > b0.len(), "the batch changes the state");
    assert_eq!(d0, expected_for("f256-trailer.eden.gz").digest);
    let len = b1.len() - b0.len();
    println!("batch: {len} B, {} records", walk(&b1).len() - walk(&b0).len());

    let (mut cases, mut old, mut new, mut mixed, mut refused, mut damaged, mut rewrite_bad) = (0, 0, 0, 0, 0, 0, 0);
    for zero_fill in [false, true] {
        for k in 0..len {
            cases += 1;
            write(&t, &b0);
            {
                let mut s = Store::open_rw(&t).unwrap();
                s.set_test_crash(Some((k, zero_fill)));
                assert!(matches!(second_batch(&mut s), Err(Error::TestCrash)));
                assert!(!s.is_writable(), "a crashed store is closed");
            }
            let (opened, dmg, d) = digest_of(&t);
            // a zero-filled kill point can leave a file byte-identical to the finished one (the
            // batch's last bytes were zero anyway): then, and only then, the new commit is right
            let persisted = std::fs::read(&t).unwrap();
            let want = if persisted == b1 { &d1 } else { &d0 };
            if !opened {
                refused += 1;
            } else if d == *want {
                if d == d1 { new += 1 } else { old += 1 }
            } else {
                mixed += 1;
            }
            damaged += dmg as usize;
            // ... and the next save truncates the torn tail and lands cleanly
            if opened && d == d0 {
                let mut s = Store::open_rw(&t).unwrap();
                assert!(s.torn() || s.tail_bytes() > 0 || persisted == b0, "k={k}: the tail is visible");
                if second_batch(&mut s).is_err() || s.state_digest().unwrap() != d1 {
                    rewrite_bad += 1;
                }
                drop(s);
                if std::fs::read(&t).unwrap() != b1 {
                    rewrite_bad += 1;
                }
            }
        }
    }
    println!(
        "{cases} kill points ({len} B batch, prefix + zero-filled): {old} old commit, {new} new (file already complete), \
         {mixed} wrong/mixed, {refused} refused"
    );
    assert_eq!((mixed, refused), (0, 0));
    assert_eq!(old + new, cases);
    assert_eq!(damaged, 0, "a torn tail is never reported as damage");
    assert_eq!(rewrite_bad, 0, "the next save after every crash writes exactly the uncrashed file");

    // a kill point at the batch's full length is not a crash: the new commit
    write(&t, &b0);
    {
        let mut s = Store::open_rw(&t).unwrap();
        s.set_test_crash(Some((len, false)));
        second_batch(&mut s).unwrap();
    }
    assert_eq!(digest_of(&t).2, d1);
    assert_eq!(std::fs::read(&t).unwrap(), b1);
}

#[test]
fn a_lost_record_under_a_surviving_commit_rolls_back() {
    let tmp = TempDir::new("lost");
    let (full, t) = (tmp.path("full.emod"), tmp.path("case.emod"));
    let b0 = conversion();
    write(&full, &b0);
    second_batch(&mut Store::open_rw(&full).unwrap()).unwrap();
    let b1 = std::fs::read(&full).unwrap();
    let d0 = expected_for("f256-trailer.eden.gz").digest;
    let (mut lost, mut ok) = (0, 0);
    for r in walk(&b1).into_iter().filter(|r| r.off >= b0.len() && r.rtype != 7) {
        lost += 1;
        let mut f = b1.clone();
        let n = 32 + r.plen;
        f[r.off..r.off + n + ((8 - (n & 7)) & 7)].fill(0);
        write(&t, &f);
        let mut s = Store::open(&t).unwrap();
        if s.state_digest().unwrap() == d0 && s.torn() && !s.damaged() {
            ok += 1;
        }
    }
    assert!(lost >= 6);
    assert_eq!(ok, lost, "a lost record under a surviving COMMIT rolls back to the old commit");
}

/// A long torn tail, then a short save: the writer must cut the tail before appending, or stale
/// records (and a stale COMMIT) would sit after the new commit.
#[test]
fn a_save_after_a_long_torn_tail_truncates_it_first() {
    let tmp = TempDir::new("tail");
    let (full, t) = (tmp.path("full.emod"), tmp.path("case.emod"));
    let b0 = conversion();
    write(&full, &b0);
    second_batch(&mut Store::open_rw(&full).unwrap()).unwrap();
    let b1 = std::fs::read(&full).unwrap();
    let small = |s: &mut Store| -> Result<(), Error> {
        let mut c = vec![0u8; s.column_len()];
        c[0] = 1;
        s.begin_batch();
        s.put_column(5200, 5200, &c)?;
        s.commit()
    };
    write(&t, &b0);
    small(&mut Store::open_rw(&t).unwrap()).unwrap();
    let clean = std::fs::read(&t).unwrap();
    assert!(clean.len() < b1.len());
    let mut lost_rec = b1.clone();
    let first_col = walk(&b1).into_iter().find(|r| r.off >= b0.len() && r.rtype == 1).unwrap();
    lost_rec[first_col.off..first_col.off + 32].fill(0);
    for (name, v) in [("killed one byte short", b1[..b1.len() - 1].to_vec()), ("COMMIT survived, a record did not", lost_rec)] {
        write(&t, &v);
        let mut s = Store::open_rw(&t).unwrap();
        assert!(!s.damaged(), "{name}: a torn tail is not damage");
        assert_eq!(s.truncation_point(), b0.len() as u64, "{name}: truncation point = end of the old commit");
        small(&mut s).unwrap();
        drop(s);
        assert!(std::fs::read(&t).unwrap() == clean, "{name}: the file equals a clean save byte for byte");
    }
}
