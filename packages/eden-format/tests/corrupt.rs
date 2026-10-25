//! Gate 3 (Emod S.1 / S.3): `emod.py corrupt_gate`, case for case, on this reader.
//!
//! The base is the pack's `f256-trailer.2batch.emod`, which is exactly the gate's base file:
//! `convert f256-trailer.eden` then `append_batch` (one column rewritten, one added, new
//! creatures and header). Cases: one byte flipped in the header (the `x` field) and in the
//! payload of the first and the last record of every type, two file-header bytes, and three
//! truncations — 29 in all. Every case must be **reported** (refused, damage/verify findings, a
//! torn batch or a tail) and none may read as a **mixed state** (a clean-looking state that is
//! neither commit). With the CRC check off the same gate must fail, as it does for emod.py
//! (10 undetected + 1 mixed) — the control that proves the CRCs are what catch it.

mod common;

use common::*;
use eden_format::emod::{OpenOptions, Store};

struct Case {
    name: String,
    flip: bool,
    at: usize,
}

fn cases(blob: &[u8]) -> Vec<Case> {
    let recs = walk(blob);
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for r in &recs {
        for last in [false, true] {
            let same: Vec<&RecPos> = recs.iter().filter(|q| q.rtype == r.rtype).collect();
            let q = if last { same[same.len() - 1] } else { same[0] };
            if !seen.insert(q.off) {
                continue;
            }
            let which = if last { "last" } else { "first" };
            out.push(Case { name: format!("flip {which} type-{} header byte (x field)", q.rtype), flip: true, at: q.off + 9 });
            if q.plen > 0 {
                out.push(Case { name: format!("flip {which} type-{} payload byte", q.rtype), flip: true, at: q.poff + q.plen / 2 });
            }
        }
    }
    out.push(Case { name: "flip file header byte (bands)".into(), flip: true, at: 10 });
    out.push(Case { name: "flip file header byte (created_unix)".into(), flip: true, at: 20 });
    let last_col = recs.iter().rfind(|r| r.rtype == 1).unwrap();
    out.push(Case { name: "truncate mid-COLUMN in the last batch".into(), flip: false, at: last_col.poff + last_col.plen / 2 });
    out.push(Case { name: "truncate mid-COMMIT of the last batch".into(), flip: false, at: recs.last().unwrap().off + 20 });
    out.push(Case { name: "truncate mid-record in the first batch".into(), flip: false, at: recs[3].off + 10 });
    out
}

/// Runs the gate; returns `(cases, undetected, mixed)` and prints each case's verdict.
fn run_gate(check_crc: bool) -> (usize, usize, usize) {
    let tmp = TempDir::new(if check_crc { "corrupt-on" } else { "corrupt-off" });
    let blob = fixture("f256-trailer.2batch.emod");
    let s2 = expected_for("f256-trailer.2batch.emod").digest;
    let s1 = expected_for("f256-trailer.eden.gz").digest; // the state at commit 1 (the conversion)
    {
        // the base must verify clean with no tail, as emod.py asserts
        let p = tmp.path("base.emod");
        std::fs::write(&p, &blob).unwrap();
        let mut s = Store::open(&p).unwrap();
        assert!(s.verify().unwrap().is_empty() && s.tail_bytes() == 0, "gate base must verify clean");
    }
    let cases = cases(&blob);
    let (mut undetected, mut mixed) = (0, 0);
    let p = tmp.path("case.emod");
    for c in &cases {
        let mut bad = blob.clone();
        if c.flip {
            bad[c.at] ^= 0xff;
        } else {
            bad.truncate(c.at);
        }
        std::fs::write(&p, &bad).unwrap();
        let (reported, sd, probs) = match Store::open_with(&p, OpenOptions { check_crc, ..OpenOptions::default() }) {
            Err(_) => (true, None, vec!["refused".to_string()]),
            Ok(mut s) => {
                let damaged_at_open = s.damaged();
                let probs = s.verify().unwrap();
                let reported = !probs.is_empty() || s.tail_bytes() > 0 || s.torn();
                let sd = (!damaged_at_open).then(|| s.state_digest().unwrap_or_else(|_| "undecodable".into()));
                (reported, sd, probs)
            }
        };
        let mix = sd.as_ref().is_some_and(|d| *d != s1 && *d != s2) && probs.is_empty();
        undetected += !reported as usize;
        mixed += mix as usize;
        let state = match sd.as_deref() {
            None => "",
            Some(d) if d == s1 => " state=commit1",
            Some(d) if d == s2 => " state=commit2",
            Some(_) => " state=other",
        };
        println!(
            "  {:<48} {}{}{}",
            c.name,
            if reported { "reported" } else { "NOT DETECTED" },
            if mix { " + MIXED STATE" } else { "" },
            state
        );
    }
    println!(
        "{} cases, {undetected} not detected, {mixed} mixed states (CRC check {})",
        cases.len(),
        if check_crc { "ON" } else { "DISABLED" }
    );
    (cases.len(), undetected, mixed)
}

#[test]
fn every_corrupted_or_truncated_file_is_reported() {
    let (n, undetected, mixed) = run_gate(true);
    assert_eq!(n, 29, "emod.py's gate has 29 cases on this base");
    assert_eq!((undetected, mixed), (0, 0), "GATE FAILED: corruption went unreported");
}

#[test]
fn control_the_gate_fails_with_the_crc_check_disabled() {
    let (n, undetected, mixed) = run_gate(false);
    assert_eq!(n, 29);
    // emod.py --no-crc on the same base: 10 undetected, 1 mixed
    assert_eq!((undetected, mixed), (10, 1), "the control must fail exactly as emod.py's does");
}
