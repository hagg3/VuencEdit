//! Shared helpers for the `.emod` gates (the shape of Emod's `EdenWorldStoreSelftest.cpp`).
#![allow(dead_code)]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use eden_format::emod::{Store, BAND, FILE_HEADER_LEN, RECORD_HEADER_LEN};
use sha2::{Digest, Sha256};

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

/// A fixture's bytes, gunzipped when the name ends in `.gz`.
pub fn fixture(name: &str) -> Vec<u8> {
    let raw = std::fs::read(fixtures_dir().join(name)).unwrap_or_else(|e| panic!("fixture {name}: {e}"));
    if name.ends_with(".gz") {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out).unwrap();
        out
    } else {
        raw
    }
}

/// One line of `expected.txt`: `kind file sha256 state-digest`.
pub struct Expected {
    pub kind: String,
    pub file: String,
    pub sha256: String,
    pub digest: String,
}

pub fn expected() -> Vec<Expected> {
    let text = std::fs::read_to_string(fixtures_dir().join("expected.txt")).unwrap();
    text.lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            assert_eq!(f.len(), 4, "expected.txt line: {l}");
            Expected { kind: f[0].into(), file: f[1].into(), sha256: f[2].into(), digest: f[3].into() }
        })
        .collect()
}

pub fn expected_for(file: &str) -> Expected {
    expected().into_iter().find(|e| e.file == file).unwrap_or_else(|| panic!("{file} not in expected.txt"))
}

pub fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// A scratch directory under the system temp dir, removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        static N: AtomicU32 = AtomicU32::new(0);
        let p = std::env::temp_dir().join(format!(
            "eden-format-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    pub fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `(opened, damaged-at-open, digest)` — "refused" when the file doesn't open, "undecodable" when
/// a live record doesn't decode.
pub fn digest_of(path: &Path) -> (bool, bool, String) {
    match Store::open(path) {
        Err(_) => (false, false, "refused".into()),
        Ok(mut s) => {
            let dmg = s.damaged();
            let d = s.state_digest().unwrap_or_else(|_| "undecodable".into());
            (true, dmg, d)
        }
    }
}

/// A record's position in a known-clean file.
#[derive(Clone, Copy, Debug)]
pub struct RecPos {
    pub off: usize,
    pub poff: usize,
    pub plen: usize,
    pub rtype: u8,
    pub seq: u32,
}

pub fn rd32(p: &[u8]) -> u32 {
    u32::from_le_bytes(p[..4].try_into().unwrap())
}

/// Walks a clean file's records in order (stops at the first non-record).
pub fn walk(f: &[u8]) -> Vec<RecPos> {
    let mut v = Vec::new();
    let mut p = FILE_HEADER_LEN as usize;
    while p + RECORD_HEADER_LEN as usize <= f.len() && &f[p..p + 4] == b"EmR1" {
        let plen = rd32(&f[p + 20..]) as usize;
        v.push(RecPos { off: p, poff: p + 32, plen, rtype: f[p + 4], seq: rd32(&f[p + 24..]) });
        let n = 32 + plen;
        p += n + ((8 - (n & 7)) & 7);
    }
    v
}

fn crc(parts: &[&[u8]]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    for p in parts {
        h.update(p);
    }
    h.finalize()
}

/// Recomputes a record's CRC after its payload was edited, then its batch's COMMIT (crc_of_crcs
/// and the COMMIT's own CRC), so only decoding can catch the edit.
pub fn reseal(f: &mut [u8], r: RecPos) {
    let c = crc(&[&f[r.off..r.off + 28], &f[r.poff..r.poff + r.plen]]);
    f[r.off + 28..r.off + 32].copy_from_slice(&c.to_le_bytes());
    let mut cc = crc32fast::Hasher::new();
    for q in walk(f) {
        if q.seq != r.seq {
            continue;
        }
        if q.rtype == 7 {
            let v = cc.clone().finalize();
            f[q.poff + 8..q.poff + 12].copy_from_slice(&v.to_le_bytes());
            let k = crc(&[&f[q.off..q.off + 28], &f[q.poff..q.poff + q.plen]]);
            f[q.off + 28..q.off + 32].copy_from_slice(&k.to_le_bytes());
            return;
        }
        cc.update(&f[q.off + 28..q.off + 32]);
    }
}

/// xorshift64*: deterministic test content.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// A column with terrain in bands `0..top` (every 7th byte a block, some painted).
pub fn make_column(r: &mut Rng, bands: usize, top: usize) -> Vec<u8> {
    let mut c = vec![0u8; bands * BAND];
    for b in 0..top.min(bands) {
        let base = b * BAND;
        for i in (0..4096).step_by(7) {
            c[base + i] = [0u8, 0, 1, 2, 3, 13, 26][r.below(7) as usize];
            if r.below(5) == 0 {
                c[base + 4096 + i] = 1 + r.below(53) as u8;
            }
        }
    }
    c
}

/// A minimal `.eden` WorldFileHeader with `version` at @92.
pub fn eden_header(version: i32, name: &str) -> Vec<u8> {
    let mut h = vec![0u8; 192];
    h[40..40 + name.len()].copy_from_slice(name.as_bytes());
    h[92..96].copy_from_slice(&version.to_le_bytes());
    h
}
