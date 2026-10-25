//! The zstd pin (Cargo.toml: `zstd-sys = "=2.0.16"`, i.e. `+zstd.1.5.7`). The spec's
//! byte-identical writers use zstd 1.5.7 at level 3; every pinned hash in these tests depends on
//! it. A different zstd still reads every file (any conforming frame decodes) but would break the
//! cross-checks against `emod.py` and Emod, so a version change must be deliberate.

use eden_format::emod::container::{zstd_version_number, Codec, Codecs};

#[test]
fn linked_zstd_is_1_5_7() {
    assert_eq!(zstd_version_number(), 10507, "ZSTD_versionNumber(): the crate must link the pinned zstd 1.5.7");
}

#[test]
fn zstd_frames_carry_checksum_and_content_size() {
    let data: Vec<u8> = (0..100_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let mut c = Codecs::new();
    let mut enc = Vec::new();
    assert_eq!(c.encode(Codec::Zstd, &data, true, &mut enc).unwrap(), Codec::Zstd);
    assert_eq!(&enc[..4], &[0x28, 0xB5, 0x2F, 0xFD]);
    assert_ne!(enc[4] & 0x04, 0, "content checksum flag");
    let mut out = vec![0u8; data.len()];
    assert!(c.decode(1, &enc, &mut out));
    assert_eq!(out, data);
    // strictness: a wrong expected length, a trailing byte, or a second frame never decode
    let mut short = vec![0u8; data.len() - 1];
    assert!(!c.decode(1, &enc, &mut short));
    let mut trailing = enc.clone();
    trailing.push(0);
    assert!(!c.decode(1, &trailing, &mut out));
    let mut two = enc.clone();
    two.extend_from_slice(&enc);
    assert!(!c.decode(1, &two, &mut out));
    // an empty payload is always codec 0, and codec 0 must be exact
    assert_eq!(c.encode(Codec::Zstd, &[], true, &mut enc).unwrap(), Codec::None);
    assert!(c.decode(0, &[], &mut []));
    assert!(!c.decode(1, &[], &mut []));
    // reserved codecs never decode
    assert!(!c.decode(3, &data, &mut vec![0u8; data.len()]));
}

#[test]
fn zlib_round_trip_is_strict() {
    let data: Vec<u8> = (0..50_000u32).map(|i| (i % 13) as u8).collect();
    let mut c = Codecs::new();
    let mut enc = Vec::new();
    assert_eq!(c.encode(Codec::Zlib, &data, true, &mut enc).unwrap(), Codec::Zlib);
    let mut out = vec![0u8; data.len()];
    assert!(c.decode(2, &enc, &mut out));
    assert_eq!(out, data);
    let mut long = vec![0u8; data.len() + 1];
    assert!(!c.decode(2, &enc, &mut long), "inflates to exactly the decoded length");
    let mut trailing = enc.clone();
    trailing.push(0);
    assert!(!c.decode(2, &trailing, &mut out), "no trailing bytes");
}
