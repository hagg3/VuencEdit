//! Sign parsing (256z-format plan, Phase 4). Read-only — this module never writes signs.
//!
//! Two sources decode to the same 120-byte record, per CLAUDE.md's "File Format" section and
//! the plan's Part A/C:
//!
//! - **Sidecar**: `signs_<worldfile>.eden.dat` beside the world, `"SGN1" | u32 version | u32
//!   count` then `count` records.
//! - **Inline trailer**: `LoadedWorld::dir_trailer` — the same `SGN1` container, but embedded
//!   directly after the real chunk directory, with every 16-byte row tagged `ff ff ff ff` so the
//!   game's own directory reader (which drops any row whose key is 0) skips it. This is what a
//!   live upload actually sends (Part C4) — the sidecar itself never crosses the wire.
//!
//! Record layout: `i32 x, y, z` (world block coords — same absolute space as the header's
//! `pos`/`home` fields, so `x - min_x*16, y - min_y*16` gives editor-local coordinates the same
//! way `read_spawn`/`read_player_pos` do; `z` is already an absolute height, no origin offset),
//! then `i32 a, b, c` (unconfirmed; `c` is a strong-but-unproven hypothesis for a 0–3 facing
//! quadrant, Part C3), then `char text[96]` (nul-terminated).
//!
//! Signs are **not** tied to any block type at their coordinate (Part C3 — six live specimens all
//! sit on ordinary grass at exactly surface height) — nothing here needs to consult `bytes`.

use std::path::{Path, PathBuf};

pub(crate) struct Sign {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) z: i32,
    #[allow(dead_code)] // unconfirmed field (Part C3) — kept for future decoding, not yet surfaced
    pub(crate) a: i32,
    #[allow(dead_code)]
    pub(crate) b: i32,
    /// Strong-but-unproven hypothesis: a 0–3 facing quadrant (Part C3).
    pub(crate) c: i32,
    pub(crate) text: String,
}

const RECORD_BYTES: usize = 120;
const HEADER_BYTES: usize = 12;
/// Defensive cap, far above any real sign count seen so far (max observed: 6) — a corrupt or
/// hostile `count` field must not make this allocate gigabytes before the length check below
/// even runs.
const MAX_SIGNS: usize = 100_000;

/// Parse a `signs_<world>.eden.dat` sidecar (or an equivalent in-memory buffer). Returns an empty
/// vec for anything that doesn't match the expected shape — a missing/foreign/corrupt sidecar
/// must never fail a world load, just show no signs.
pub(crate) fn parse_signs(bytes: &[u8]) -> Vec<Sign> {
    if bytes.len() < HEADER_BYTES || &bytes[0..4] != b"SGN1" { return Vec::new(); }
    let count = (u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize).min(MAX_SIGNS);
    let mut out = Vec::with_capacity(count.min(1024));
    let mut off = HEADER_BYTES;
    for _ in 0..count {
        if off + RECORD_BYTES > bytes.len() { break; }
        let rd = |o: usize| i32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        let x = rd(off);
        let y = rd(off + 4);
        let z = rd(off + 8);
        let a = rd(off + 12);
        let b = rd(off + 16);
        let c = rd(off + 20);
        let text_bytes = &bytes[off + 24..off + RECORD_BYTES];
        let nul = text_bytes.iter().position(|&byte| byte == 0).unwrap_or(text_bytes.len());
        let text = String::from_utf8_lossy(&text_bytes[..nul]).into_owned();
        out.push(Sign { x, y, z, a, b, c, text });
        off += RECORD_BYTES;
    }
    out
}

/// Parse `LoadedWorld::dir_trailer` (Part A) into signs. Each 16-byte trailer row is `ff ff ff
/// ff` + 12 payload bytes; stripping the tag and concatenating the payloads reconstructs the raw
/// bytes the game wrote. The **first** reconstructed 12 bytes are an outer wrapper — `"SGN1" |
/// u32 length | u32 0` where `length` is the byte count of everything after it — not part of the
/// sidecar-format payload itself; skipping it exposes the identical `SGN1` container the sidecar
/// format uses, so the rest delegates to `parse_signs`. Any row not carrying the tag means this
/// isn't (or isn't only) a signs trailer — bail to an empty vec rather than guess.
pub(crate) fn parse_inline_signs(trailer: &[u8]) -> Vec<Sign> {
    if trailer.is_empty() || !trailer.len().is_multiple_of(16) { return Vec::new(); }
    let mut payload = Vec::with_capacity(trailer.len() / 16 * 12);
    for row in trailer.chunks_exact(16) {
        if row[0..4] != [0xff, 0xff, 0xff, 0xff] { return Vec::new(); }
        payload.extend_from_slice(&row[4..16]);
    }
    if payload.len() < HEADER_BYTES || &payload[0..4] != b"SGN1" { return Vec::new(); }
    parse_signs(&payload[HEADER_BYTES..])
}

/// Sidecar path for a world file: `signs_<full file name, incl. ".eden">.dat`, beside the world —
/// see CLAUDE.md's "File Format" section.
pub(crate) fn sign_sidecar_path(world_path: &Path) -> PathBuf {
    let file_name = world_path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    world_path.with_file_name(format!("signs_{file_name}.dat"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_sgn1(records: &[(i32, i32, i32, i32, i32, i32, &str)]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"SGN1");
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&(records.len() as u32).to_le_bytes());
        for &(x, y, z, a, bb, c, text) in records {
            b.extend_from_slice(&x.to_le_bytes());
            b.extend_from_slice(&y.to_le_bytes());
            b.extend_from_slice(&z.to_le_bytes());
            b.extend_from_slice(&a.to_le_bytes());
            b.extend_from_slice(&bb.to_le_bytes());
            b.extend_from_slice(&c.to_le_bytes());
            let mut text_field = vec![0u8; 96];
            let tb = text.as_bytes();
            text_field[..tb.len()].copy_from_slice(tb);
            b.extend_from_slice(&text_field);
        }
        b
    }

    #[test]
    fn parse_signs_round_trips_records() {
        let b = build_sgn1(&[
            (65540, 65551, 33, 4, 2, 1, "sign 1"),
            (65538, 65548, 32, 3, 2, 1, "sign 2"),
        ]);
        let signs = parse_signs(&b);
        assert_eq!(signs.len(), 2);
        assert_eq!(signs[0].x, 65540);
        assert_eq!(signs[0].y, 65551);
        assert_eq!(signs[0].z, 33);
        assert_eq!(signs[0].c, 1);
        assert_eq!(signs[0].text, "sign 1");
        assert_eq!(signs[1].text, "sign 2");
    }

    #[test]
    fn parse_signs_rejects_wrong_magic() {
        let mut b = build_sgn1(&[(1, 2, 3, 0, 0, 0, "x")]);
        b[0] = b'X';
        assert!(parse_signs(&b).is_empty());
    }

    #[test]
    fn parse_signs_truncated_buffer_yields_only_complete_records() {
        let mut b = build_sgn1(&[(1, 2, 3, 0, 0, 0, "a"), (4, 5, 6, 0, 0, 0, "b")]);
        b.truncate(b.len() - 50); // chop into the middle of the second record
        let signs = parse_signs(&b);
        assert_eq!(signs.len(), 1, "a truncated trailing record must be dropped, not misread");
        assert_eq!(signs[0].text, "a");
    }

    #[test]
    fn parse_signs_handles_empty_text() {
        let b = build_sgn1(&[(1, 2, 3, 0, 0, 0, "")]);
        let signs = parse_signs(&b);
        assert_eq!(signs.len(), 1);
        assert_eq!(signs[0].text, "");
    }

    /// The exact 192-byte trailer captured from `TEST WORLDS/quarry.eden` (Part A of the
    /// 256z-format plan): row 0 is the `SGN1`+length wrapper, row 1 the version/count row, rows
    /// 2–4 the one real sign record (12+120=132 B = 11 rows, but the record's 96-byte text field
    /// needs only one more row here since "test" fits well inside it), rows 5–11 zero padding.
    fn quarry_sign_trailer() -> Vec<u8> {
        fn tagged_row(payload: [u8; 12]) -> [u8; 16] {
            let mut row = [0xffu8; 16];
            row[4..16].copy_from_slice(&payload);
            row
        }
        let mut rows: Vec<[u8; 16]> = Vec::new();
        // Row 0: outer wrapper — "SGN1" + length(132) + 0.
        rows.push(tagged_row({
            let mut p = [0u8; 12];
            p[0..4].copy_from_slice(b"SGN1");
            p[4..8].copy_from_slice(&132u32.to_le_bytes());
            p
        }));
        // Row 1: inner sidecar header — "SGN1" + version(1) + count(1).
        rows.push(tagged_row({
            let mut p = [0u8; 12];
            p[0..4].copy_from_slice(b"SGN1");
            p[4..8].copy_from_slice(&1u32.to_le_bytes());
            p[8..12].copy_from_slice(&1u32.to_le_bytes());
            p
        }));
        // Rows 2–11: one 120-byte record (x,y,z,a,b,c,text[96]) = 10 rows of 12 bytes.
        let mut record = [0u8; 120];
        record[0..4].copy_from_slice(&65412i32.to_le_bytes());
        record[4..8].copy_from_slice(&65069i32.to_le_bytes());
        record[8..12].copy_from_slice(&32i32.to_le_bytes());
        record[12..16].copy_from_slice(&4i32.to_le_bytes());
        record[16..20].copy_from_slice(&9i32.to_le_bytes());
        record[20..24].copy_from_slice(&1i32.to_le_bytes());
        record[24..28].copy_from_slice(b"test");
        for chunk in record.chunks_exact(12) {
            let mut p = [0u8; 12];
            p.copy_from_slice(chunk);
            rows.push(tagged_row(p));
        }
        rows.into_iter().flatten().collect()
    }

    #[test]
    fn parse_inline_signs_decodes_quarry_trailer_shape() {
        let trailer = quarry_sign_trailer();
        assert_eq!(trailer.len(), 192);
        let signs = parse_inline_signs(&trailer);
        assert_eq!(signs.len(), 1, "the quarry trailer carries exactly one real sign record");
        assert_eq!(signs[0].x, 65412);
        assert_eq!(signs[0].y, 65069);
        assert_eq!(signs[0].z, 32);
        assert_eq!(signs[0].a, 4);
        assert_eq!(signs[0].b, 9);
        assert_eq!(signs[0].c, 1);
        assert_eq!(signs[0].text, "test");
    }

    #[test]
    fn parse_inline_signs_rejects_untagged_rows() {
        // A directory of real chunk-pointer rows (no ff ff ff ff tag) must not be misread as signs.
        let mut row = [0u8; 16];
        row[8..16].copy_from_slice(&192u64.to_le_bytes());
        assert!(parse_inline_signs(&row).is_empty());
    }

    #[test]
    fn parse_inline_signs_rejects_non_16_aligned_length() {
        assert!(parse_inline_signs(&[0xff; 20]).is_empty());
    }

    #[test]
    fn sign_sidecar_path_prefixes_full_file_name() {
        let world = Path::new("/Users/sam/worlds/afwx…pbgv.eden");
        let sidecar = sign_sidecar_path(world);
        assert_eq!(sidecar, Path::new("/Users/sam/worlds/signs_afwx…pbgv.eden.dat"));
    }

    /// Manual regression against the real 4-record sidecar in `TEST WORLDS/newblocks/` (Part B5 /
    /// C3). `TEST WORLDS/` is private and not guaranteed present, so this is `#[ignore]`d — run
    /// explicitly with `cargo test manual_newblocks_sidecar -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn manual_newblocks_sidecar_decodes_four_signs() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../TEST WORLDS/newblocks/signs_afwxungtbnunqwgbqcmanznucpwfbmiwrnaqpbgv.eden.dat");
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("failed to read {path:?}: {e}"));
        let signs = parse_signs(&bytes);
        assert_eq!(signs.len(), 4);
        assert_eq!(signs[0].text, "sign 1");
        assert_eq!(signs[0].x, 65540);
        assert_eq!(signs[0].y, 65551);
        assert_eq!(signs[0].z, 33);
        assert_eq!(signs[3].text, "sign 4");
        assert_eq!(signs[3].b, 17, "sign 4's b=17 is the one outlier across all 10 known records");
    }
}
