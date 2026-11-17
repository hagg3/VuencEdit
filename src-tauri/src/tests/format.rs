use super::*;

// ── Stage 1: chunk-pointer-table decode (DIAGNOSE/DIAGNOSIS.md §5.1) ──────────────────────

/// Build a minimal multi-chunk world: `n` chunks of `chunk_size` laid out back to back from
/// `HEADER`, then an `n`-entry directory at the end. Chunk coords are `(0,0)..(n-1,0)`.
/// `version` goes in the header's version field — pass `0` (or anything `< 5`) to force the
/// min-gap `chunk_size` fallback, `5` to take the authoritative 256z branch.
pub(crate) fn make_multi_chunk_world(n: usize, chunk_size: usize, version: i32) -> Vec<u8> {
    let dir_off = HEADER + n * chunk_size;
    let mut b = vec![0u8; dir_off + n * 16];
    b[32..40].copy_from_slice(&(dir_off as u64).to_le_bytes());
    b[92..96].copy_from_slice(&version.to_le_bytes());
    for i in 0..n {
        let e = dir_off + i * 16;
        b[e     ..e +  4].copy_from_slice(&(i as i32).to_le_bytes());
        b[e +  4..e +  8].copy_from_slice(&0i32.to_le_bytes());
        b[e +  8..e + 16].copy_from_slice(&((HEADER + i * chunk_size) as u64).to_le_bytes());
    }
    b
}

/// Overwrite directory entry `i`'s offset field (bytes [8..16]) in a `make_multi_chunk_world`
/// fixture. `dir_off` is where the directory starts.
pub(crate) fn set_entry_offset(b: &mut [u8], dir_off: usize, i: usize, off: u64) {
    let e = dir_off + i * 16;
    b[e + 8..e + 16].copy_from_slice(&off.to_le_bytes());
}

/// §5.1.1 — the entry decode itself, at full width. `i16` coords can't represent Y = 70000
/// and a `u32` offset can't represent 0x1_0000_00C0 (the >4 GiB case that started all this),
/// so this fails on the pre-Stage-1 decoder in three independent ways.
#[test]
pub(crate) fn test_decode_dir_entry_full_width() {
    let mut e = vec![0u8; 16];
    e[0..4].copy_from_slice(&(-5i32).to_le_bytes());
    e[4..8].copy_from_slice(&70000i32.to_le_bytes());
    e[8..16].copy_from_slice(&0x1_0000_00C0u64.to_le_bytes());
    assert_eq!(decode_dir_entry(&e), (-5, 70000, 0x1_0000_00C0));
}

// ── Stage 4: writer emits the full-width entry (i32/i32/u64) ─────────────────────────────

/// `encode_dir_entry` must be the exact inverse of `decode_dir_entry` — including the two
/// values the pre-Stage-4 `i16`+pad / `u32`+pad encoding could not represent.
#[test]
pub(crate) fn test_encode_dir_entry_round_trips() {
    for &(cx, cy, off) in &[
        (4096i32, 4096i32, 192u64),                 // the ordinary generated-world case
        (-5, 70000, 0x1_0000_00C0),                 // negative X + >i16 Y + >4 GiB offset
        (i32::MIN, i32::MAX, u64::MAX),             // field extremes
    ] {
        assert_eq!(decode_dir_entry(&encode_dir_entry(cx, cy, off)), (cx, cy, off));
    }
}

/// For the non-negative, sub-4 GiB values every writer produced before Stage 4, the widened
/// encoding must be *byte-identical* to the old `i16 + 2 pad + i16 + 2 pad + u32 + 4 pad`
/// form — that byte-compatibility is the whole reason this change can't disturb existing
/// worlds, so assert it rather than reasoning about it.
#[test]
pub(crate) fn test_encode_dir_entry_matches_legacy_bytes_for_small_values() {
    let (cx, cy, off) = (4096i32, 4123i32, 1_234_567u64);
    let mut legacy = [0u8; 16];
    legacy[0..2].copy_from_slice(&(cx as i16).to_le_bytes());
    legacy[4..6].copy_from_slice(&(cy as i16).to_le_bytes());
    legacy[8..12].copy_from_slice(&(off as u32).to_le_bytes());
    assert_eq!(encode_dir_entry(cx, cy, off), legacy);
}

/// End-to-end for the generator writer: `write_world_file` → `parse_world_inner`, pinning the
/// `is_chunk_coord` gate's upper edge (`start_cx = 32766` puts the second chunk at the last
/// legal X, 32767) and guarding 1c (`off >= 192`): the first chunk must land at exactly 192.
#[test]
pub(crate) fn test_write_world_file_round_trips_boundary_chunk_coords() {
    let chunk_size = 32768usize;
    let (w, h) = (2u32, 1u32);
    let chunks: Vec<Vec<u8>> = (0..(w * h)).map(|_| vec![0u8; chunk_size]).collect();
    let path = std::env::temp_dir().join(format!("vuencedit_stage4_{}.eden", std::process::id()));
    let p = path.to_string_lossy().to_string();
    worldgen::write_world_file(&p, "bnd", w, h, chunk_size, 32766, 4096, 10, &chunks)
        .expect("write failed");
    let bytes = fs::read(&path).expect("read back failed");
    let _ = fs::remove_file(&path);

    let world = parse_world_inner(mmap_from_bytes(bytes)).expect("parse failed");
    assert_eq!(world.chunk_map.len(), 2);
    assert_eq!(world.chunk_map.get(&(32766, 4096)), Some(&192),
        "the first chunk must land at exactly byte 192 (the real header size)");
    assert_eq!(world.chunk_map.get(&(32767, 4096)), Some(&(192 + chunk_size)));
    assert_eq!(world.min_x, 32766, "min_x must reflect the real coord");
}

/// The game's own directory reader keys chunks by `twoToOne(x,z) = (x<<15)|z`, which cannot
/// address a negative X — `parse_world_inner` must reject such an entry rather than load a
/// chunk the game itself could never find (see `is_chunk_coord`'s doc comment). Superseded
/// `test_write_world_file_round_trips_negative_chunk_coords`, which asserted the opposite
/// before the coordinate gate existed: no in-range positive coord can distinguish the widened
/// i32 encoding from the old i16 one, so re-pointing that test at a positive value would have
/// tested nothing new.
#[test]
pub(crate) fn test_parse_rejects_negative_chunk_coords_the_game_cannot_index() {
    let chunk_size = 32768usize;
    let (w, h) = (2u32, 1u32);
    let chunks: Vec<Vec<u8>> = (0..(w * h)).map(|_| vec![0u8; chunk_size]).collect();
    let path = std::env::temp_dir().join(format!("vuencedit_stage4_neg_{}.eden", std::process::id()));
    let p = path.to_string_lossy().to_string();
    worldgen::write_world_file(&p, "neg", w, h, chunk_size, -3, 4096, 10, &chunks)
        .expect("write failed");
    let bytes = fs::read(&path).expect("read back failed");
    let _ = fs::remove_file(&path);

    assert!(parse_world_inner(mmap_from_bytes(bytes)).is_err(),
        "a negative chunk X is unaddressable in-game (twoToOne returns 0) and must be rejected");
}

/// §5.1.2 — an entry whose chunk would run past EOF is excluded from `chunk_map` rather than
/// admitted and left to produce out-of-bounds (silently-air) reads later.
#[test]
pub(crate) fn test_parse_rejects_entry_running_past_eof() {
    let mut b = make_multi_chunk_world(2, 32768, 0);
    let dir_off = HEADER + 2 * 32768;
    let len = b.len() as u64;
    set_entry_offset(&mut b, dir_off, 1, len - 1000); // 1000 bytes of a 32768-byte chunk
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    assert!(world.chunk_map.contains_key(&(0, 0)), "the valid chunk must load");
    assert!(!world.chunk_map.contains_key(&(1, 0)), "an entry running past EOF must be dropped");
}

/// §1.10.2 — the old guard hardcoded `off + 32768 <= len`, so on a 256z world it admitted
/// entries within 128 KB of EOF. This offset passes the old 32 KB test and fails the correct
/// `chunk_size` one, so it only stays out if the validation really uses the detected size.
#[test]
pub(crate) fn test_parse_rejects_short_tail_entry_on_256z_world() {
    let mut b = make_multi_chunk_world(2, 131072, 5);
    let dir_off = HEADER + 2 * 131072;
    let len = b.len() as u64;
    let off = len - 40000;
    assert!(off + 32768 <= len, "fixture must pass the old hardcoded 32 KB guard");
    assert!(off + 131072 > len, "fixture must fail the correct chunk_size guard");
    set_entry_offset(&mut b, dir_off, 1, off);
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    assert_eq!(world.chunk_size, 131072);
    assert!(world.chunk_map.contains_key(&(0, 0)), "the valid chunk must load");
    assert!(!world.chunk_map.contains_key(&(1, 0)),
        "an entry with less than chunk_size bytes left must be dropped");
}

/// §5.1.3 — 64z regression. Legacy (`version <= 4`) worlds are the only ones that exercise the
/// min-gap fallback, and the widened decode moved it from truncated `usize` chunk_map values
/// to Pass A's `u64` offsets. Two chunks 32768 B apart must still resolve to a 4-band 64z world.
#[test]
pub(crate) fn test_parse_min_gap_fallback_detects_64z() {
    let world = parse_world_inner(mmap_from_bytes(make_multi_chunk_world(2, 32768, 0)))
        .expect("parse failed");
    assert_eq!(world.chunk_size, 32768, "min-gap 32768 must detect a 64z world");
    assert_eq!(world.num_bands, 4);
    assert_eq!(world.chunk_map.len(), 2);
}

/// The other half of the fallback: two chunks 131072 B apart with a legacy version field must
/// still resolve to a 16-band 256z world.
#[test]
pub(crate) fn test_parse_min_gap_fallback_detects_256z() {
    let world = parse_world_inner(mmap_from_bytes(make_multi_chunk_world(2, 131072, 0)))
        .expect("parse failed");
    assert_eq!(world.chunk_size, 131072, "min-gap 131072 must detect a 256z world");
    assert_eq!(world.num_bands, 16);
    assert_eq!(world.chunk_map.len(), 2);
}

// ── Phase 1 (256z-format plan): post-directory sign trailer + coordinate gate ─────────────

/// The real 192-byte post-directory trailer found at the end of a real 256z world (`quarry.eden`):
/// 12 rows, each tagged `x = -1` (`ff ff ff ff`) so the game's own reader skips them. Row 0 is
/// a wrapper (`"SGN1"` + length 132); row 1 is the real `SGN1` header (version 1, count 1);
/// rows 2–4 are the one sign record's first 36 bytes (position + 3 unknown i32s + start of
/// text); rows 5–11 are zero padding to fill the 120-byte record. See the plan doc's Part A.
pub(crate) const QUARRY_SIGN_TRAILER: [u8; 192] = {
    let mut b = [0u8; 192];
    const ROWS: [[u8; 12]; 5] = [
        [0x53, 0x47, 0x4e, 0x31, 0x84, 0, 0, 0, 0, 0, 0, 0],            // "SGN1", len 132
        [0x53, 0x47, 0x4e, 0x31, 1, 0, 0, 0, 1, 0, 0, 0],               // "SGN1", version 1, count 1
        [0x84, 0xff, 0, 0, 0x2d, 0xfe, 0, 0, 0x20, 0, 0, 0],            // x=65412, y=65069, z=32
        [4, 0, 0, 0, 9, 0, 0, 0, 1, 0, 0, 0],                           // a=4, b=9, c=1
        [0x74, 0x65, 0x73, 0x74, 0, 0, 0, 0, 0, 0, 0, 0],               // "test"
    ];
    let mut row = 0;
    while row < 12 {
        let e = row * 16;
        b[e] = 0xff; b[e + 1] = 0xff; b[e + 2] = 0xff; b[e + 3] = 0xff;
        if row < ROWS.len() {
            let src = &ROWS[row];
            let mut i = 0;
            while i < 12 { b[e + 4 + i] = src[i]; i += 1; }
        }
        row += 1;
    }
    b
};

/// `make_multi_chunk_world` plus `trailer` bytes appended immediately after the real chunk
/// directory entries — mirrors how the game itself lays out a trailing `SGN1` section.
pub(crate) fn make_world_with_sign_trailer(n: usize, chunk_size: usize, version: i32, trailer: &[u8]) -> Vec<u8> {
    let mut b = make_multi_chunk_world(n, chunk_size, version);
    b.extend_from_slice(trailer);
    b
}

/// Overwrite directory entry `i`'s X/Y coordinate fields in a `make_multi_chunk_world` fixture.
pub(crate) fn set_entry_coords(b: &mut [u8], dir_off: usize, i: usize, cx: i32, cy: i32) {
    let e = dir_off + i * 16;
    b[e..e + 4].copy_from_slice(&cx.to_le_bytes());
    b[e + 4..e + 8].copy_from_slice(&cy.to_le_bytes());
}

/// The core regression: a trailing `SGN1` section must never be decoded as chunk rows — this
/// is exactly the old failure mode that reported quarry.eden as 4198 × 1,953,719,669 chunks.
#[test]
pub(crate) fn test_parse_ignores_post_directory_sign_trailer() {
    let b = make_world_with_sign_trailer(2, 32768, 0, &QUARRY_SIGN_TRAILER);
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    assert_eq!(world.chunk_map.len(), 2, "only the two real chunks may be admitted");
    assert_eq!(world.w_chunks, 2, "the trailer's bogus X=-1 rows must not widen the bbox");
    assert_eq!(world.h_chunks, 1);
    assert!(world.chunk_span.is_empty(),
        "the trailer rows must never be treated as chunks with short spans");
}

/// The trailer bytes themselves must survive parsing verbatim, so a rebuilding writer can
/// re-emit the world's real inline sign data instead of silently dropping it.
#[test]
pub(crate) fn test_parse_preserves_sign_trailer_bytes() {
    let b = make_world_with_sign_trailer(2, 32768, 0, &QUARRY_SIGN_TRAILER);
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    assert_eq!(world.trailer_bytes(), QUARRY_SIGN_TRAILER);
}

/// Ordering regression: the trailer's offset-0/offset-132 rows must be stripped *before*
/// `chunk_size` detection runs, or a legacy-version world's min-gap fallback would measure a
/// spurious tiny gap against them and misdetect 64z vs 256z.
#[test]
pub(crate) fn test_parse_min_gap_fallback_ignores_sign_trailer_offsets() {
    // version 0 forces the min-gap fallback; two real chunks 131072 B apart should read 256z
    // regardless of the trailer rows' tiny (0- and 132-byte) fake offsets.
    let b = make_world_with_sign_trailer(2, 131072, 0, &QUARRY_SIGN_TRAILER);
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    assert_eq!(world.chunk_size, 131072, "the trailer's fake offsets must not poison min-gap");
    assert_eq!(world.chunk_map.len(), 2);
}

/// An *interior* out-of-range entry (not part of a trailing run) is corruption, not a sign
/// trailer — it must be dropped and never folded into the trailer.
#[test]
pub(crate) fn test_parse_drops_interior_out_of_range_entry() {
    let mut b = make_multi_chunk_world(3, 32768, 0);
    let dir_off = HEADER + 3 * 32768;
    set_entry_coords(&mut b, dir_off, 1, -1, 999); // middle entry, not the trailing one
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    assert_eq!(world.chunk_map.len(), 2, "chunks 0 and 2 must still load");
    assert!(world.chunk_map.contains_key(&(0, 0)));
    assert!(world.chunk_map.contains_key(&(2, 0)));
    assert!(world.trailer_bytes().is_empty(),
        "an interior corrupt row must be dropped outright, not captured as a trailer");
}

/// 1c: chunk data can never start inside the 192-byte header, mirroring the `ptr_offset >= 192`
/// check. An entry pointing at offset 0 (as the real quarry trailer's wrapper row does) must be
/// rejected by Pass B even if it somehow carried an in-range coordinate.
#[test]
pub(crate) fn test_parse_drops_entry_pointing_into_header() {
    let mut b = make_multi_chunk_world(2, 32768, 0);
    let dir_off = HEADER + 2 * 32768;
    set_entry_offset(&mut b, dir_off, 1, 0); // in-range coord, but offset 0 < 192
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    assert!(world.chunk_map.contains_key(&(0, 0)));
    assert!(!world.chunk_map.contains_key(&(1, 0)),
        "an entry whose offset lands inside the header must be rejected");
}

/// The template-directory reader (1f) must apply the same coordinate gate as the world reader,
/// so a corrupt/foreign row in `Eden.eden` can't make `expand_world_from_template` write a
/// garbage-RLE chunk at an unaddressable coordinate.
#[test]
pub(crate) fn test_template_dir_skips_out_of_range_entries() {
    let dir_off = 32usize;
    let mut b = vec![0u8; dir_off + 3 * 16];
    let entry = |b: &mut [u8], i: usize, cx: i32, cy: i32, off: u64| {
        let e = dir_off + i * 16;
        b[e..e + 4].copy_from_slice(&cx.to_le_bytes());
        b[e + 4..e + 8].copy_from_slice(&cy.to_le_bytes());
        b[e + 8..e + 16].copy_from_slice(&off.to_le_bytes());
    };
    entry(&mut b, 0, 4096, 4096, 0);
    entry(&mut b, 1, -1, 999, 0);   // out of range — must be skipped
    entry(&mut b, 2, 4097, 4096, 0);

    let dir = decode_template_dir(&b, dir_off);
    assert_eq!(dir.len(), 2);
    assert!(dir.contains_key(&(4096, 4096)));
    assert!(dir.contains_key(&(4097, 4096)));
    assert!(!dir.contains_key(&(-1, 999)));
}

/// Full round trip: a world carrying the real quarry sign trailer, materialized to a sibling
/// file, must reload with that trailer intact — proving `materialize_flat_chunks_inner` re-emits
/// it instead of silently dropping the world's inline sign data (1g).
#[test]
pub(crate) fn test_materialize_preserves_post_directory_trailer() {
    let b = make_world_with_sign_trailer(1, 32768, 0, &QUARRY_SIGN_TRAILER);
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    let chunk_size = world.chunk_size;
    let header = world.bytes[..192.min(world.bytes.len())].to_vec();
    let (coords, src) = materialize_src(&world);
    let params = FlatChunkParams { chunk_size, stone_depth: 1, dirt_depth: 2, surface_z: 4 };
    let out_path = std::env::temp_dir()
        .join(format!("vuencedit_materialize_trailer_test_{}.eden", std::process::id()));
    materialize_flat_chunks_inner(
        out_path.to_str().unwrap(), chunk_size, &header, &coords, src, &[], &params,
        &world.trailer_bytes(), &[], || false, |_, _| {},
    ).expect("materialize must succeed");
    let out_bytes = fs::read(&out_path).expect("read output");
    let _ = fs::remove_file(&out_path);
    let reloaded = parse_world_inner(mmap_from_bytes(out_bytes)).expect("output must parse");
    assert_eq!(reloaded.trailer_bytes(), QUARRY_SIGN_TRAILER);
}

/// 27.1: the adder specimen's post-directory trailer (80,480 B: `CMB1` then `SGN1`, to EOF)
/// must survive a normal save *and* both rebuilding writers. It used to be captured capped at
/// 64 KiB, so `expand_world_inner` and `materialize_flat_chunks_inner` wrote a truncated
/// trailer (data loss). The specimen is private; the test skips when it's absent.
#[test]
pub(crate) fn test_adder_trailer_survives_save_expand_and_materialize() {
    const ADDER_TRAILER_LEN: usize = 80_480;
    let Some(home) = std::env::var_os("HOME") else { return };
    let path = std::path::Path::new(&home).join("emod/TESTERS/3 bit adder 1791611312.eden");
    if !path.exists() {
        eprintln!("skipping: {path:?} not present");
        return;
    }
    let orig = fs::read(&path).expect("read adder");
    let expected = &orig[orig.len() - ADDER_TRAILER_LEN..];
    assert_eq!(&expected[..4], &[0xff; 4], "the trailer starts on a tagged row");
    assert_eq!(&expected[4..8], b"CMB1", "the adder's first section is CMB1");

    let world = parse_world_inner(map_fixture(&path)).expect("adder must parse");
    let dir_off = u64::from_le_bytes(orig[32..40].try_into().unwrap()) as usize;
    assert_eq!(dir_off + 16 * world.chunk_map.len(), orig.len() - ADDER_TRAILER_LEN,
        "the trailer runs from the end of the real rows to EOF");
    assert_eq!(world.trailer_bytes().len(), ADDER_TRAILER_LEN, "captured uncapped");
    assert_eq!(world.trailer_bytes(), expected);

    let tmp = |tag: &str| std::env::temp_dir()
        .join(format!("vuencedit_adder_trailer_{tag}_{}.eden", std::process::id()));
    let check = |out: &std::path::Path, what: &str| {
        let bytes = fs::read(out).expect("read output");
        let _ = fs::remove_file(out);
        assert!(bytes.len() >= ADDER_TRAILER_LEN && &bytes[bytes.len() - ADDER_TRAILER_LEN..] == expected,
            "{what}: the file must end with the full 80,480-byte trailer");
        let reloaded = parse_world_inner(mmap_from_bytes(bytes)).expect("output must parse");
        assert_eq!(reloaded.trailer_bytes(), expected, "{what}: trailer reloads intact");
        assert_eq!(reloaded.chunk_map.len(), world.chunk_map.len(), "{what}: chunks kept");
    };

    // Normal save: writes the mapping verbatim.
    let out = tmp("save");
    save_world_inner(&world, out.to_str().unwrap(), false).expect("save");
    check(&out, "save");

    // Template expand with an empty template: only the rebuild path runs.
    let out = tmp("expand");
    expand_world_inner(out.to_str().unwrap(), &world, &[], &FxHashMap::default(), false,
        || false, |_| {}).expect("expand");
    check(&out, "expand");

    // Materialize with nothing to add: same.
    let out = tmp("materialize");
    let header = world.bytes[..192].to_vec();
    let (coords, src) = materialize_src(&world);
    let params = FlatChunkParams { chunk_size: world.chunk_size, stone_depth: 1, dirt_depth: 2, surface_z: 4 };
    let (cb_start, cb_end) = creature_block_range(&world);
    materialize_flat_chunks_inner(
        out.to_str().unwrap(), world.chunk_size, &header, &coords, src, &[], &params,
        &world.trailer_bytes(), &world.bytes[cb_start..cb_end], || false, |_, _| {},
    ).expect("materialize");
    check(&out, "materialize");
}

// ── Phase 2a (256z-format plan): version-independent creature-gap chunk-size detector ─────

/// A single-chunk world whose directory sits `gap` bytes after the chunk's nominal end —
/// modelling the 400-slot creature block the game reserves immediately before the real
/// directory. `version` is deliberately `< 5` so neither the authoritative New Dawn rule nor
/// (with only one chunk) the min-gap fallback can resolve `chunk_size` on their own.
pub(crate) fn make_single_chunk_world_with_gap(chunk_size: usize, gap: usize, version: i32) -> Vec<u8> {
    let dir_off = HEADER + chunk_size + gap;
    let mut b = vec![0u8; dir_off + 16];
    b[32..40].copy_from_slice(&(dir_off as u64).to_le_bytes());
    b[92..96].copy_from_slice(&version.to_le_bytes());
    let e = dir_off;
    b[e..e + 4].copy_from_slice(&0i32.to_le_bytes());
    b[e + 4..e + 8].copy_from_slice(&0i32.to_le_bytes());
    b[e + 8..e + 16].copy_from_slice(&(HEADER as u64).to_le_bytes());
    b
}

/// The exact scenario the updated game produces: `version` predates the New Dawn version
/// field (2, observed on a real world from the 2026-08 update) but the world is 256z, and there is only one
/// chunk — the case the min-gap fallback structurally cannot solve.
#[test]
pub(crate) fn test_creature_gap_detects_256z_on_legacy_version() {
    let b = make_single_chunk_world_with_gap(131072, 24_000, 2); // 400 slots, the max
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    assert_eq!(world.chunk_size, 131072);
    assert_eq!(world.num_bands, 16);
}

/// A legacy 64z world with a 200-slot (12,000 B) creature block must still resolve to 32768.
#[test]
pub(crate) fn test_creature_gap_detects_64z_with_200_slots() {
    let b = make_single_chunk_world_with_gap(32768, 12_000, 0);
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    assert_eq!(world.chunk_size, 32768);
    assert_eq!(world.num_bands, 4);
}

/// A gap that is not a whole number of 60-byte slots for either candidate satisfies neither
/// half of the creature-gap test, so detection must fall through to the existing min-gap
/// heuristic rather than erroring — exercised here with two real chunks so min-gap has
/// something to measure.
#[test]
pub(crate) fn test_creature_gap_falls_back_to_min_gap_when_neither_matches() {
    let mut b = make_multi_chunk_world(2, 131072, 0);
    // Push the directory 37 bytes further out — not a multiple of 60 for either chunk size.
    let old_dir_off = HEADER + 2 * 131072;
    let new_dir_off = old_dir_off + 37;
    b.resize(new_dir_off + 2 * 16, 0);
    for i in 0..2 {
        let src = old_dir_off + i * 16;
        let (cx, cy, off) = decode_dir_entry(&b[src..src + 16].to_vec());
        let dst = new_dir_off + i * 16;
        b[dst..dst + 16].copy_from_slice(&encode_dir_entry(cx, cy, off));
    }
    b[32..40].copy_from_slice(&(new_dir_off as u64).to_le_bytes());
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    assert_eq!(world.chunk_size, 131072, "min-gap fallback must still resolve this correctly");
}

// ── Open work (256z-format plan, item 6): creature-block range + preservation ─────────────

/// Build a world with `n` real chunks of `chunk_size`, then `creature_bytes` verbatim
/// (modelling the reserved creature block), then a directory naming just the `n` chunks.
pub(crate) fn make_world_with_creature_block(n: usize, chunk_size: usize, creature_bytes: &[u8]) -> Vec<u8> {
    let chunks_end = HEADER + n * chunk_size;
    let dir_off = chunks_end + creature_bytes.len();
    let mut b = vec![0u8; dir_off + n * 16];
    b[32..40].copy_from_slice(&(dir_off as u64).to_le_bytes());
    b[chunks_end..chunks_end + creature_bytes.len()].copy_from_slice(creature_bytes);
    for i in 0..n {
        let e = dir_off + i * 16;
        b[e     ..e +  4].copy_from_slice(&(i as i32).to_le_bytes());
        b[e +  4..e +  8].copy_from_slice(&0i32.to_le_bytes());
        b[e +  8..e + 16].copy_from_slice(&((HEADER + i * chunk_size) as u64).to_le_bytes());
    }
    b
}

/// `creature_block_range` must recover the exact reserved-gap bytes, not a hardcoded slot
/// count — the bug `get_creatures` used to have (always assumed 200 slots / 12,000 B).
#[test]
pub(crate) fn test_creature_block_range_detects_reserved_gap() {
    let creature_bytes: Vec<u8> = (0..120u8).cycle().take(180).collect(); // 3 slots × 60 B
    let b = make_world_with_creature_block(1, 32768, &creature_bytes);
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    let (start, end) = creature_block_range(&world);
    assert_eq!(end - start, creature_bytes.len());
    assert_eq!(&world.bytes[start..end], &creature_bytes[..]);
}

/// The overwhelming majority of worlds have no creature block at all — the directory follows
/// the last chunk immediately, so the range must be empty (`start == end`), not underflow.
#[test]
pub(crate) fn test_creature_block_range_empty_when_no_gap() {
    let b = make_multi_chunk_world(2, 131072, 5);
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    let (start, end) = creature_block_range(&world);
    assert_eq!(start, end, "no gap between last chunk and directory");
}

/// `materialize_flat_chunks_inner` must re-emit the source world's creature block verbatim,
/// directly before the new directory — mirroring `test_materialize_preserves_post_directory_trailer`
/// on the other side of the directory. Before this fix the two rebuilding writers silently
/// dropped this reserved space, closing the gap between the last chunk and the directory.
#[test]
pub(crate) fn test_materialize_preserves_creature_block() {
    let creature_bytes: Vec<u8> = (0..255u8).cycle().take(600).collect(); // 10 slots × 60 B
    let b = make_world_with_creature_block(1, 32768, &creature_bytes);
    let world = parse_world_inner(mmap_from_bytes(b)).expect("parse failed");
    let chunk_size = world.chunk_size;
    let header = world.bytes[..192.min(world.bytes.len())].to_vec();
    let (coords, src) = materialize_src(&world);
    let params = FlatChunkParams { chunk_size, stone_depth: 1, dirt_depth: 2, surface_z: 4 };
    let (cb_start, cb_end) = creature_block_range(&world);
    let creature_block = world.bytes[cb_start..cb_end].to_vec();
    let out_path = std::env::temp_dir()
        .join(format!("vuencedit_materialize_creature_test_{}.eden", std::process::id()));
    materialize_flat_chunks_inner(
        out_path.to_str().unwrap(), chunk_size, &header, &coords, src, &[], &params,
        &[], &creature_block, || false, |_, _| {},
    ).expect("materialize must succeed");
    let out_bytes = fs::read(&out_path).expect("read output");
    let _ = fs::remove_file(&out_path);
    let reloaded = parse_world_inner(mmap_from_bytes(out_bytes)).expect("output must parse");
    let (rs, re) = creature_block_range(&reloaded);
    assert_eq!(&reloaded.bytes[rs..re], &creature_bytes[..], "creature block must survive materialize");
}

// ── Phase 3 (256z-format plan): new-format block types 112–127 (placeholder appearance) ────

/// All four block-indexed tables must agree on covering exactly 128 types (0–111 known,
/// 112–127 new-format) — a length mismatch would silently reintroduce the "flood fill errors,
/// 3D geometry drops the cell, occlusion is wrong" hazard class for whichever table lagged.
#[test]
pub(crate) fn test_block_tables_cover_all_128_types() {
    assert_eq!(BLOCK_RGB.len(), 128);
    assert_eq!(BLOCK_INFO.len(), 128);
    assert_eq!(BLOCK_PAINT_SCALE.len(), 128);
    assert_eq!(crate::texturepack::BLOCK_FACE_TEX.len(), 128);
    // The 16 are named, distinct materials with hand-picked approximate colours (textures
    // aren't supported yet). Two sharing a colour would make them indistinguishable on the 2D
    // map and in the picker, which is the failure this pins; the scale must stay a sane
    // brightness multiplier.
    for bt in 112u8..=127 {
        let rgb = BLOCK_RGB[bt as usize];
        let dupes = (112u8..=127).filter(|&o| o != bt && BLOCK_RGB[o as usize] == rgb).count();
        assert_eq!(dupes, 0, "block {bt}'s colour {rgb:?} is shared with another new-format block");
        let scale = BLOCK_PAINT_SCALE[bt as usize];
        assert!((0.1..=1.0).contains(&scale), "block {bt}'s paint scale must be in 0.1..=1.0, got {scale}");
    }
}

/// `flood_fill_3d`'s only block-type validation is `(block_type as usize) >= BLOCK_RGB.len()`
/// (the one hard rejection in the whole IPC surface, per the audit) — replicated directly here
/// since the command itself takes a `tauri::State` the test build has no harness to construct.
/// Growing `BLOCK_RGB` to 128 is what fixes it; this pins that the fix covers the full new range.
#[test]
pub(crate) fn test_flood_fill_accepts_new_block_types() {
    for bt in 112usize..=127 {
        assert!(bt < BLOCK_RGB.len(), "flood_fill_3d must accept new-format block type {bt}");
    }
}

/// New-format blocks must occlude like a normal solid cube — `BLOCK_INFO[112..=127] == 0` (no
/// `BI_NOTSOLID`/`BI_RAMPORSIDE`) — so neighbours cull hidden faces, they cast sun shadows, and
/// the 3D geometry pipeline includes them instead of treating them as air-like out-of-range types.
#[test]
pub(crate) fn test_obj_occludes_treats_new_blocks_as_solid() {
    for bt in 112u8..=127 {
        assert!(obj_occludes(bt), "block {bt} must occlude (solid new-format block)");
    }
}

// ── Stage 3: per-chunk span clamping (DIAGNOSE/DIAGNOSIS.md §1.9, §5.1.4) ─────────────────

/// A 256z world whose two chunks sit **107,072 B** apart instead of 131,072 — the exact
/// spacing anomaly present once in each of the two real >4 GiB worlds. The nominal
/// `chunk_size` window of chunk (0,0) therefore overlaps chunk (1,0)'s first 24,000 bytes.
pub(crate) fn make_short_span_world() -> Vec<u8> {
    const SHORT: usize = 107_072;
    let mut b = make_multi_chunk_world(2, 131072, 5);
    let dir_off = HEADER + 2 * 131072;
    set_entry_offset(&mut b, dir_off, 1, (HEADER + SHORT) as u64);
    b
}

/// §5.1.4 — the span of a chunk cut short by its successor is the real distance between them,
/// and a write into the overlap region is dropped rather than scribbled into the neighbour.
#[test]
pub(crate) fn test_short_chunk_span_clamps_writes() {
    const SHORT: usize = 107_072;
    let mut world = parse_world_inner(mmap_from_bytes(make_short_span_world()))
        .expect("parse failed");
    assert_eq!(world.chunk_size, 131072);
    assert_eq!(world.span_of(0, 0), SHORT, "the truncated chunk owns only up to its successor");
    assert_eq!(world.span_of(1, 0), 131072, "the last chunk still runs to the directory");
    assert_eq!(world.chunk_span.len(), 1, "only short spans are recorded");

    // z=250 → band 15, which starts 122,880 B into the chunk: past the 107,072-byte span, so
    // these bytes are chunk (1,0)'s. The write must not land anywhere.
    let neighbour_before = world.bytes[HEADER + SHORT..HEADER + SHORT + 24_000].to_vec();
    set_block_abs(&mut world, 3, 5, 250, 2, 7);
    assert_eq!(
        world.bytes[HEADER + SHORT..HEADER + SHORT + 24_000],
        neighbour_before[..],
        "a write past the short span must not reach the next chunk's bytes",
    );
    assert_eq!(read_block_abs(&world, 3, 5, 250), 0, "and it must not read back either");

    // Sanity: the same column *inside* the span still writes normally, so the clamp isn't
    // just disabling the chunk.
    set_block_abs(&mut world, 3, 5, 200, 2, 7);
    assert_eq!(read_block_abs(&world, 3, 5, 200), 2);
    assert_eq!(read_paint_abs(&world, 3, 5, 200), 7);
}

/// Audit M8 — `read_column_bulk`/`write_column_bulk` must agree with the scalar
/// `read_block_abs`/`read_paint_abs`/`set_block_abs` they replace in `copy_selection`/
/// `move_selection`'s hot loops, including across a 16-z band boundary (the whole reason for the
/// per-band `copy_from_slice` split) and outside any chunk (missing-chunk → 0 / write dropped).
#[test]
pub(crate) fn test_column_bulk_matches_scalar_band_crossing() {
    let base = make_multi_chunk_world(1, 131072, 5);
    let mut world = parse_world_inner(mmap_from_bytes(base.clone())).expect("parse failed");
    assert_eq!(world.num_bands, 16, "256z world for a real band boundary at z=16");

    // Scribble a distinct (type, paint) at every z in a column spanning two bands (10..=25
    // crosses the z=16 boundary), plus a neighbouring column, via the scalar path.
    for z in 0..40 {
        set_block_abs(&mut world, 5, 5, z, (z % 251 + 1) as u8, (z % 53 + 1) as u8);
        set_block_abs(&mut world, 6, 5, z, ((z * 3) % 251 + 1) as u8, ((z * 7) % 53 + 1) as u8);
    }

    for &(wx, wy, z0, depth) in &[(5, 5, 10, 16), (5, 5, 0, 40), (6, 5, 15, 3), (9, 9, 0, 40)] {
        let mut bulk_bt = vec![0u8; depth as usize];
        let mut bulk_paint = vec![0u8; depth as usize];
        read_column_bulk(&world, wx, wy, z0, depth, &mut bulk_bt, &mut bulk_paint);
        for i in 0..depth {
            assert_eq!(bulk_bt[i as usize], read_block_abs(&world, wx, wy, z0 + i),
                "block mismatch at ({wx},{wy},{}) window z0={z0} depth={depth}", z0 + i);
            assert_eq!(bulk_paint[i as usize], read_paint_abs(&world, wx, wy, z0 + i),
                "paint mismatch at ({wx},{wy},{}) window z0={z0} depth={depth}", z0 + i);
        }
    }

    // Write side: bulk-write a band-crossing run to a fresh column and diff the resulting bytes
    // against an independently-parsed world written the old (scalar) way.
    let mut bulk_world = parse_world_inner(mmap_from_bytes(base.clone())).expect("parse failed");
    let mut scalar_world = parse_world_inner(mmap_from_bytes(base)).expect("parse failed");
    let pattern_bt: Vec<u8> = (0..20).map(|i| (i * 11 % 250 + 1) as u8).collect();
    let pattern_paint: Vec<u8> = (0..20).map(|i| (i * 5 % 52 + 1) as u8).collect();
    for (i, (&bt, &pt)) in pattern_bt.iter().zip(pattern_paint.iter()).enumerate() {
        set_block_abs(&mut scalar_world, 7, 7, 8 + i as i32, bt, pt);
    }
    write_column_bulk(&mut bulk_world, 7, 7, 8, 20, &pattern_bt, &pattern_paint);
    assert_eq!(&bulk_world.bytes[..], &scalar_world.bytes[..],
        "bulk write must match the scalar set_block_abs loop byte-for-byte");
}

/// Audit M8 — the bulk helpers must fall back to the same clamp-at-span behaviour as
/// `read_block_abs`/`set_block_abs` when a run crosses a short chunk span (`DIAGNOSE/
/// DIAGNOSIS.md` §1.9): the neighbour's bytes are never touched or read as this chunk's.
#[test]
pub(crate) fn test_column_bulk_respects_short_chunk_span() {
    const SHORT: usize = 107_072;
    let mut world = parse_world_inner(mmap_from_bytes(make_short_span_world()))
        .expect("parse failed");
    let neighbour_before = world.bytes[HEADER + SHORT..HEADER + SHORT + 24_000].to_vec();

    // z=250 (band 15) starts past the short span for chunk (0,0); a bulk write covering it
    // must be silently dropped, exactly like `set_block_abs`.
    let bt = vec![9u8; 8];
    let pt = vec![3u8; 8];
    write_column_bulk(&mut world, 3, 5, 248, 8, &bt, &pt);
    assert_eq!(
        world.bytes[HEADER + SHORT..HEADER + SHORT + 24_000],
        neighbour_before[..],
        "a bulk write past the short span must not reach the next chunk's bytes",
    );
    let mut out_bt = vec![0u8; 8];
    let mut out_pt = vec![0u8; 8];
    read_column_bulk(&world, 3, 5, 248, 8, &mut out_bt, &mut out_pt);
    assert_eq!(out_bt, vec![0u8; 8], "reading past the short span returns 0, not neighbour data");
    assert_eq!(out_pt, vec![0u8; 8]);
}

/// The undo path must be span-aware too: snapshotting a short chunk at its nominal size would
/// pull the neighbour's bytes into this chunk's delta, and restoring would write them back at
/// the same wrong address — turning undo itself into the corruption vector.
#[test]
pub(crate) fn test_snapshot_uses_real_chunk_span() {
    const SHORT: usize = 107_072;
    let world = parse_world_inner(mmap_from_bytes(make_short_span_world()))
        .expect("parse failed");
    let snaps = snapshot_chunks_full(&world, &[(0, 0), (1, 0)], None);
    let short = snaps.iter().find(|&(cx, cy, _, _)| (*cx, *cy) == (0, 0)).unwrap();
    let full  = snaps.iter().find(|&(cx, cy, _, _)| (*cx, *cy) == (1, 0)).unwrap();
    assert_eq!(short.3.len(), SHORT, "short chunk snapshots only what it owns");
    assert_eq!(full.3.len(), 131072);
}

/// Round-trip: parse → delete column (3,5) z 0–63 → save to new path →
/// reload → verify air + byte-identical header and pointer table.
#[test]
pub(crate) fn test_save_round_trip() {
    let original = make_test_world();

    // ── parse ──────────────────────────────────────────────────────────
    let mut world = parse_world_inner(mmap_from_bytes(original.clone())).expect("parse failed");
    assert_eq!(world.w_chunks, 1);
    assert_eq!(world.h_chunks, 1);

    // Pre-conditions: test blocks are present
    assert_eq!(world.bytes[blk(3, 5,  0)], 7, "Wood pre-delete");
    assert_eq!(world.bytes[blk(3, 5, 17)], 2, "Stone pre-delete");
    assert_eq!(world.bytes[pnt(3, 5, 17)], 5, "paint pre-delete");
    assert_eq!(world.bytes[blk(3, 5, 48)], 3, "Dirt pre-delete");
    assert_eq!(world.bytes[blk(7, 2, 32)], 8, "bystander pre-delete");

    // ── delete column (px=3, py=5), full z range ───────────────────────
    delete_blocks_inner(&mut world, 3, 5, 3, 5, 0, 63, None);

    assert_eq!(world.bytes[blk(3, 5,  0)], 0, "Wood post-delete");
    assert_eq!(world.bytes[blk(3, 5, 17)], 0, "Stone post-delete");
    assert_eq!(world.bytes[pnt(3, 5, 17)], 0, "paint post-delete");
    assert_eq!(world.bytes[blk(3, 5, 48)], 0, "Dirt post-delete");
    assert_eq!(world.bytes[blk(7, 2, 32)], 8, "bystander unchanged after delete");

    // ── save to a temp path (no pre-existing file → no .bak created) ──
    let tmp = std::env::temp_dir().join("eden_test_round_trip.eden");
    let tmp_str = tmp.to_str().unwrap();
    let _ = fs::remove_file(&tmp);
    save_world_inner(&world, tmp_str, false).expect("save failed");
    assert!(!std::path::Path::new(&format!("{tmp_str}.bak")).exists(),
        ".bak should not be created when destination didn't exist");

    // ── reload saved file ───────────────────────────────────────────────
    let saved_bytes = fs::read(&tmp).expect("read back failed");
    let world2 = parse_world_inner(mmap_from_bytes(saved_bytes.clone())).expect("re-parse failed");

    // Deleted column reads as air
    assert_eq!(world2.bytes[blk(3, 5,  0)], 0, "Wood air after reload");
    assert_eq!(world2.bytes[blk(3, 5, 17)], 0, "Stone air after reload");
    assert_eq!(world2.bytes[pnt(3, 5, 17)], 0, "paint air after reload");
    assert_eq!(world2.bytes[blk(3, 5, 48)], 0, "Dirt air after reload");

    // Bystander survives
    assert_eq!(world2.bytes[blk(7, 2, 32)], 8, "bystander survived save/reload");

    // Header bytes (0 .. HEADER) are byte-identical to original
    assert_eq!(&original[..HEADER], &saved_bytes[..HEADER],
        "header section must be byte-identical to original");

    // Pointer-table bytes are byte-identical to original
    let ptr_off = u32::from_le_bytes(original[32..36].try_into().unwrap()) as usize;
    assert_eq!(&original[ptr_off..], &saved_bytes[ptr_off..],
        "pointer table must be byte-identical to original");

    // Sanity: total file size unchanged
    assert_eq!(original.len(), saved_bytes.len(), "file size must not change");

    let _ = fs::remove_file(&tmp);
}

/// C1 step 2 — a `Full` delta is deflated on the way into an `UndoEntry`, and inflates back to
/// exactly the bytes it captured. The dense fallback is the one that costs a whole chunk, and a
/// uniformly-filled chunk (the ⌘A-fill shape) is the case that has to compress hard.
#[test]
pub(crate) fn test_full_delta_is_deflated_and_round_trips() {
    let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
    let pre_full = snapshot_chunks_full(&world, &[(0, 0)], None);
    let original = pre_full[0].3.clone();
    for b in world.bytes[HEADER..HEADER + 32768].iter_mut() { *b = 0x2A; } // "fill with Stone"
    let snap = diff_chunk(&world, 0, 0, pre_full[0].2, &pre_full[0].3).expect("dense change diffs");
    let raw_bytes = chunk_snapshot_bytes(&snap);

    let entry = UndoEntry::new("fill", vec![snap], None);
    match &entry.chunks[0].delta {
        ChunkDelta::FullZ(_, z, raw) => {
            assert_eq!(*raw as usize, original.len(), "raw_len must describe the captured span");
            assert!(z.len() * 4 < original.len(), "a mostly-empty chunk must deflate hard, got {} of {}",
                    z.len(), original.len());
        }
        other => panic!("a Full delta must be stored deflated, got {}", delta_kind(other)),
    }
    assert!(entry.bytes < raw_bytes, "the entry must be priced at its compressed size ({} vs {raw_bytes})", entry.bytes);

    // …and undo still restores the chunk byte-for-byte through the compressed form.
    restore_and_invert(&mut world, &entry);
    assert_eq!(&world.bytes[HEADER..HEADER + 32768], &original[..],
               "inflating a FullZ delta must restore the exact pre-edit bytes");
}

/// C1 step 2 — an incompressible payload must stay `Full` rather than growing: deflate on random
/// bytes emits *more* than it consumed, and paying that (plus an inflate on every undo) for a
/// negative saving is the one case where compressing is strictly worse.
#[test]
pub(crate) fn test_incompressible_delta_stays_uncompressed() {
    // A deterministic LCG — no rand dependency, and reproducible across runs.
    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    let noise: Vec<u8> = (0..40_000).map(|_| {
        seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; (seed >> 24) as u8
    }).collect();
    let snap = ChunkSnapshot { cx: 0, cy: 0, delta: ChunkDelta::Full(0, noise.clone()) };
    let entry = UndoEntry::new("noise", vec![snap], None);
    match &entry.chunks[0].delta {
        ChunkDelta::Full(_, d) => assert_eq!(d, &noise),
        other => panic!("incompressible payload must stay Full, got {}", delta_kind(other)),
    }
}

/// C1 step 3 — an entry that alone exceeds the whole undo budget is dropped rather than kept
/// (the old `trim_stack` `len() > 1` floor kept it, which is what parked a world-sized
/// allocation in RAM for the session). Dropping it must take the *rest* of the history with it:
/// every older entry is a delta whose restore would write pre-edit bytes over chunks this edit
/// has since changed.
#[test]
pub(crate) fn test_oversized_undo_entry_drops_history() {
    let mut ws = ws_with(make_test_world());
    let rect = (0, 0, 15, 15);
    // A first edit establishes some history to lose — and fills the chunk with noise, so the next
    // edit's pre-image is incompressible (a zero pre-image would deflate to almost nothing).
    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    with_edit(&mut ws, "first", rect, |w| {
        for i in HEADER..HEADER + 32768 {
            seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
            w.set_byte(i, (seed >> 24) as u8 | 1);
        }
        Ok(())
    }).expect("first edit");
    assert_eq!(ws.undo_stack.len(), 1);

    // Budget 8 KiB: the pre-image limit (4×) is exactly the chunk's 32 KiB, so the edit runs,
    // but its ~32 KiB incompressible delta can't fit the budget.
    ws.undo_budget = 8192;
    let r = with_edit(&mut ws, "huge", rect, |w| {
        for i in HEADER..HEADER + 32768 { w.set_byte(i, 0x2A); }
        Ok(())
    }).expect("edit itself still applies");
    assert!(r.undo_dropped, "an over-budget edit must report that its undo was dropped");
    assert_eq!(r.undo_depth, 0, "…and the whole stack goes with it");
    assert!(ws.undo_stack.is_empty() && ws.redo_stack.is_empty());
    assert_eq!(ws.undo_bytes, 0, "the byte counter must be cleared with the stack");
    assert_eq!(ws.world.as_ref().unwrap().bytes[blk(1, 1, 0)], 0x2A, "the edit itself is not rolled back");
}

