//! Append-only chunk-diff journal — shared wire format for the autosave journal (C2 Stage 3) and
//! the incremental-save WAL (C2 Stage 4). Self-contained: no `AppState`, no Tauri, pure byte
//! buffers in and out so it's unit-testable without touching a filesystem.
//!
//! Wire format, all integers little-endian:
//!
//! ```text
//! "VEJ1"      4 B    magic
//! flags       u32    bit0 (FLAG_COMPRESSED) = record payloads are deflate-compressed
//! base_len    u64    expected byte length of the base image (sanity check on replay)
//! base_id     16 B   random per-session id, cross-checked by the caller against a meta sidecar
//! reserved    8 B    zero
//! ```
//!
//! followed by an append-only stream of records:
//!
//! ```text
//! kind        u8     0 = span, 1 = commit
//! file_off    u64    absolute offset into the base image   (kind 0 only)
//! cx, cy      i32,i32 chunk coords, or (i32::MIN, i32::MIN) for the header span (kind 0 only)
//! raw_len     u32    uncompressed payload length            (kind 0 only)
//! comp_len    u32    stored payload length                  (kind 0 only)
//! crc32       u32    of the *uncompressed* payload           (kind 0 only)
//! payload     comp_len bytes                                (kind 0 only)
//! ```
//!
//! Replay applies span records in stream order — a later record for the same file offset simply
//! overwrites what an earlier one wrote, so re-dirtying a chunk across ticks needs no special
//! casing. Replay stops at the first record that is short, fails its CRC, or whose
//! `file_off + raw_len` would run past `base_len`; everything decoded before that point is still
//! applied. That is what makes an append-only journal crash-safe without an fsync per record: a
//! torn trailing write just gets ignored.
//!
//! A `kind = 1` commit record has no payload — it exists purely as a marker callers can look for
//! (`ReplayResult::ended_with_commit`) when "was this file completely written" matters, e.g. the
//! Stage 4 WAL. The autosave journal (Stage 3) never writes one and callers that don't care simply
//! ignore the flag.
//!
use std::io::{self, Read, Write};

use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;

pub(crate) const MAGIC: [u8; 4] = *b"VEJ1";
pub(crate) const HEADER_LEN: usize = 4 + 4 + 8 + 16 + 8; // 40
pub(crate) const FLAG_COMPRESSED: u32 = 1 << 0;

/// Chunk-coordinate sentinel for a span that carries header bytes (0..192) rather than a chunk.
pub(crate) const HEADER_SPAN: (i32, i32) = (i32::MIN, i32::MIN);

const RECORD_KIND_SPAN: u8 = 0;
const RECORD_KIND_COMMIT: u8 = 1;
/// file_off(8) + cx(4) + cy(4) + raw_len(4) + comp_len(4) + crc32(4)
const SPAN_FIXED_LEN: usize = 8 + 4 + 4 + 4 + 4 + 4;

// ── Header ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JournalHeader {
    pub(crate) flags: u32,
    pub(crate) base_len: u64,
    pub(crate) base_id: [u8; 16],
}

impl JournalHeader {
    pub(crate) fn new(compressed: bool, base_len: u64, base_id: [u8; 16]) -> Self {
        Self { flags: if compressed { FLAG_COMPRESSED } else { 0 }, base_len, base_id }
    }

    pub(crate) fn compressed(&self) -> bool {
        self.flags & FLAG_COMPRESSED != 0
    }

    pub(crate) fn encode(&self) -> [u8; HEADER_LEN] {
        let mut buf = [0u8; HEADER_LEN];
        buf[0..4].copy_from_slice(&MAGIC);
        buf[4..8].copy_from_slice(&self.flags.to_le_bytes());
        buf[8..16].copy_from_slice(&self.base_len.to_le_bytes());
        buf[16..32].copy_from_slice(&self.base_id);
        // buf[32..40] stays zero (reserved).
        buf
    }

    /// `None` on anything short of a well-formed header — too short, or bad magic. Both are
    /// terminal rejects for the whole journal (see `JournalError::BadMagic`).
    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < HEADER_LEN || bytes[0..4] != MAGIC {
            return None;
        }
        let flags = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        let base_len = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        let mut base_id = [0u8; 16];
        base_id.copy_from_slice(&bytes[16..32]);
        Some(Self { flags, base_len, base_id })
    }
}

// ── Record encoding ──────────────────────────────────────────────────────

/// Encode one span record. `compress` must match the journal's header flag — the caller (the
/// `JournalWriter` below, or Stage 3/4 directly) is responsible for keeping every record in one
/// journal consistent with the flag it opened it with.
pub(crate) fn encode_span_record(file_off: u64, cx: i32, cy: i32, payload: &[u8], compress: bool) -> io::Result<Vec<u8>> {
    let raw_len = payload.len() as u32;
    let crc = crc32fast::hash(payload);
    let stored: Vec<u8> = if compress {
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::new(6));
        enc.write_all(payload)?;
        enc.finish()?
    } else {
        payload.to_vec()
    };
    let mut out = Vec::with_capacity(1 + SPAN_FIXED_LEN + stored.len());
    out.push(RECORD_KIND_SPAN);
    out.extend_from_slice(&file_off.to_le_bytes());
    out.extend_from_slice(&cx.to_le_bytes());
    out.extend_from_slice(&cy.to_le_bytes());
    out.extend_from_slice(&raw_len.to_le_bytes());
    out.extend_from_slice(&(stored.len() as u32).to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&stored);
    Ok(out)
}

pub(crate) fn encode_commit_record() -> [u8; 1] {
    [RECORD_KIND_COMMIT]
}

// ── Replay ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub(crate) struct Span {
    pub(crate) file_off: u64,
    pub(crate) cx: i32,
    pub(crate) cy: i32,
    pub(crate) payload: Vec<u8>,
}

impl Span {
    /// Unused by the Stage 3 autosave journal (which applies every span identically regardless of
    /// origin) — kept for callers that do need to distinguish it, and exercised by this module's
    /// own tests.
    #[allow(dead_code)]
    pub(crate) fn is_header(&self) -> bool {
        (self.cx, self.cy) == HEADER_SPAN
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ReplayResult {
    /// Span records that decoded cleanly, in stream (append) order.
    pub(crate) spans: Vec<Span>,
    /// True iff replay reached the true end of the buffer with no corruption, and the very last
    /// record in the stream was a commit marker. False for a WAL that stopped mid-write. The
    /// autosave journal (Stage 3) never writes a commit record, so this is always false for it —
    /// the Stage 4 save WAL (`recover_wal`) is the consumer that requires it.
    pub(crate) ended_with_commit: bool,
    /// True iff replay stopped early because a record was short, failed its CRC, failed to
    /// decompress, or claimed a `file_off + raw_len` past `base_len`. `spans` still holds
    /// everything decoded before the bad record.
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JournalError {
    /// Buffer is shorter than a header, or doesn't start with the magic bytes.
    BadMagic,
    /// Header's `base_len` doesn't match what the caller expected the base image to be — the
    /// journal belongs to a different base image entirely, not a partially-written one.
    BaseLenMismatch { expected: u64, found: u64 },
}

/// Replay a journal buffer against a base image of `expected_base_len` bytes. A bad magic or a
/// `base_len` mismatch rejects the *whole* journal (`Err`) — those aren't corruption, they mean
/// this journal doesn't belong to the base image the caller has in hand. Anything past the header
/// degrades gracefully: `Ok(ReplayResult)` with `truncated` set and only the clean prefix applied.
pub(crate) fn replay(bytes: &[u8], expected_base_len: u64) -> Result<ReplayResult, JournalError> {
    let header = JournalHeader::decode(bytes).ok_or(JournalError::BadMagic)?;
    if header.base_len != expected_base_len {
        return Err(JournalError::BaseLenMismatch { expected: expected_base_len, found: header.base_len });
    }
    let compressed = header.compressed();

    let mut spans = Vec::new();
    let mut truncated = false;
    let mut last_was_commit = false;
    let mut pos = HEADER_LEN;

    while pos < bytes.len() {
        let kind = bytes[pos];
        pos += 1;

        if kind == RECORD_KIND_COMMIT {
            last_was_commit = true;
            continue;
        }
        if kind != RECORD_KIND_SPAN {
            truncated = true;
            break;
        }
        last_was_commit = false;

        if pos + SPAN_FIXED_LEN > bytes.len() {
            truncated = true;
            break;
        }
        let file_off = u64::from_le_bytes(bytes[pos..pos + 8].try_into().unwrap());
        pos += 8;
        let cx = i32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap());
        pos += 4;
        let cy = i32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap());
        pos += 4;
        let raw_len = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap());
        pos += 4;
        let comp_len = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap());
        pos += 4;
        let crc = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap());
        pos += 4;

        if pos + comp_len as usize > bytes.len() {
            truncated = true;
            break;
        }
        let stored = &bytes[pos..pos + comp_len as usize];
        pos += comp_len as usize;

        // file_off + raw_len must fit inside the base image — checked_add guards the overflow
        // case too (a corrupt file_off near u64::MAX must not wrap and pass the bounds check).
        let end = match file_off.checked_add(raw_len as u64) {
            Some(e) if e <= header.base_len => e,
            _ => { truncated = true; break; }
        };
        let _ = end;

        let payload = if compressed {
            let mut dec = DeflateDecoder::new(stored);
            let mut out = Vec::with_capacity(raw_len as usize);
            match dec.read_to_end(&mut out) {
                Ok(_) => out,
                Err(_) => { truncated = true; break; }
            }
        } else {
            stored.to_vec()
        };
        if payload.len() != raw_len as usize {
            truncated = true;
            break;
        }
        if crc32fast::hash(&payload) != crc {
            truncated = true;
            break;
        }

        spans.push(Span { file_off, cx, cy, payload });
    }

    let ended_with_commit = !truncated && pos == bytes.len() && last_was_commit;
    Ok(ReplayResult { spans, ended_with_commit, truncated })
}

/// Apply replayed spans onto a base buffer of exactly `base_len` bytes, in stream order — a later
/// span for an offset that a earlier span also touched simply overwrites it, which is the whole
/// "last write wins" semantic.
///
/// Unused outside this module's own tests for now: `load_autosave_inner` pwrites each span
/// straight into a staged temp *file* instead of holding the whole base image resident in RAM,
/// which is the point of streaming a multi-GB world through a replay in the first place — this
/// in-memory form would defeat that. Kept as a small-buffer convenience for callers (and tests)
/// that don't have that constraint.
#[allow(dead_code)]
pub(crate) fn apply_spans(base: &mut [u8], spans: &[Span]) {
    for s in spans {
        let start = s.file_off as usize;
        let end = start + s.payload.len();
        base[start..end].copy_from_slice(&s.payload);
    }
}

// ── File-backed writer ──────────────────────────────────────────────────────

/// Thin convenience wrapper over the encode functions for Stage 3/4 call sites that want to
/// stream records straight to a file instead of building a `Vec<u8>` by hand. Carries no state
/// the encode/replay functions above don't already need — it exists purely to pair a `Write` with
/// the `compress` flag its header declared, so callers can't accidentally write a mismatched
/// record into the middle of a journal.
pub(crate) struct JournalWriter<W> {
    inner: W,
    compress: bool,
}

impl<W: Write> JournalWriter<W> {
    /// Writes a fresh header and returns a writer for the record stream that follows it.
    pub(crate) fn create(mut inner: W, base_len: u64, base_id: [u8; 16], compress: bool) -> io::Result<Self> {
        let header = JournalHeader::new(compress, base_len, base_id);
        inner.write_all(&header.encode())?;
        Ok(Self { inner, compress })
    }

    /// Resumes appending to an already-headered stream (e.g. a file reopened in append mode).
    /// `compress` must match the flag the header was originally created with.
    pub(crate) fn resume(inner: W, compress: bool) -> Self {
        Self { inner, compress }
    }

    pub(crate) fn append_span(&mut self, file_off: u64, cx: i32, cy: i32, payload: &[u8]) -> io::Result<()> {
        let record = encode_span_record(file_off, cx, cy, payload, self.compress)?;
        self.inner.write_all(&record)
    }

    /// The autosave journal (Stage 3) never writes a commit record — partial replay is strictly
    /// better than nothing for it. The Stage 4 save WAL is the consumer that requires one.
    pub(crate) fn append_commit(&mut self) -> io::Result<()> {
        self.inner.write_all(&encode_commit_record())
    }

    pub(crate) fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }

    pub(crate) fn get_mut(&mut self) -> &mut W {
        &mut self.inner
    }

    /// Unused by Stage 3, whose writers are dropped (closing the file) rather than unwrapped.
    #[allow(dead_code)]
    pub(crate) fn into_inner(self) -> W {
        self.inner
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_id(seed: u8) -> [u8; 16] {
        [seed; 16]
    }

    /// Build a journal buffer (header + records) directly from encode_* calls — mirrors how
    /// `JournalWriter` would build it, but keeps the tests independent of that convenience type.
    fn build_journal(base_len: u64, compress: bool, spans: &[(u64, i32, i32, &[u8])], commit: bool) -> Vec<u8> {
        let mut buf = JournalHeader::new(compress, base_len, base_id(7)).encode().to_vec();
        for &(off, cx, cy, payload) in spans {
            buf.extend(encode_span_record(off, cx, cy, payload, compress).unwrap());
        }
        if commit {
            buf.extend(encode_commit_record());
        }
        buf
    }

    #[test]
    fn round_trip_uncompressed() {
        let base_len = 64u64;
        let mut base = vec![0xAAu8; base_len as usize];
        let expected = {
            let mut e = base.clone();
            e[0..4].copy_from_slice(b"BLOK");
            e[40..44].copy_from_slice(b"HEAD");
            e
        };
        let journal = build_journal(base_len, false, &[
            (0, 1, 2, b"BLOK"),
            (40, i32::MIN, i32::MIN, b"HEAD"),
        ], false);

        let result = replay(&journal, base_len).expect("replay should succeed");
        assert!(!result.truncated);
        assert_eq!(result.spans.len(), 2);
        apply_spans(&mut base, &result.spans);
        assert_eq!(base, expected);
        assert!(result.spans[1].is_header());
    }

    #[test]
    fn round_trip_compressed() {
        let base_len = 4096u64;
        let payload = vec![7u8; 2000]; // compresses well — mostly-uniform, like a real chunk
        let mut base = vec![0u8; base_len as usize];
        let mut expected = base.clone();
        expected[100..100 + payload.len()].copy_from_slice(&payload);

        let journal = build_journal(base_len, true, &[(100, 3, 4, &payload)], false);
        // Compression must have actually shrunk the record vs. a raw encode.
        let raw_record = encode_span_record(100, 3, 4, &payload, false).unwrap();
        let comp_record_len = journal.len() - HEADER_LEN;
        assert!(comp_record_len < raw_record.len(), "deflate should shrink a uniform payload");

        let result = replay(&journal, base_len).expect("replay should succeed");
        assert!(!result.truncated);
        apply_spans(&mut base, &result.spans);
        assert_eq!(base, expected);
    }

    #[test]
    fn later_span_wins_on_overlap() {
        let base_len = 16u64;
        let mut base = vec![0u8; base_len as usize];
        let journal = build_journal(base_len, false, &[
            (0, 0, 0, b"AAAA"),
            (0, 0, 0, b"BBBB"), // same offset, appended later -> should win
        ], false);
        let result = replay(&journal, base_len).unwrap();
        apply_spans(&mut base, &result.spans);
        assert_eq!(&base[0..4], b"BBBB");
    }

    #[test]
    fn truncated_tail_stops_replay_and_applies_prefix() {
        let base_len = 32u64;
        let mut full = build_journal(base_len, false, &[
            (0, 0, 0, b"GOOD"),
            (8, 1, 1, b"MORE"),
        ], false);
        // Chop off the tail mid-second-record (leaves the fixed fields incomplete).
        full.truncate(full.len() - 3);

        let result = replay(&full, base_len).expect("header is intact, should not reject outright");
        assert!(result.truncated);
        assert_eq!(result.spans.len(), 1, "only the first, complete record should survive");
        assert_eq!(result.spans[0].payload, b"GOOD");

        let mut base = vec![0u8; base_len as usize];
        apply_spans(&mut base, &result.spans);
        assert_eq!(&base[0..4], b"GOOD");
        assert_eq!(&base[8..12], &[0, 0, 0, 0], "the truncated record must not be applied");
    }

    #[test]
    fn corrupted_crc_stops_replay() {
        let base_len = 16u64;
        let mut journal = build_journal(base_len, false, &[(0, 0, 0, b"GOOD")], false);
        // Flip a payload byte after CRC was computed, without touching the CRC field itself.
        let payload_start = journal.len() - 4;
        journal[payload_start] ^= 0xFF;

        let result = replay(&journal, base_len).expect("header is intact");
        assert!(result.truncated);
        assert!(result.spans.is_empty(), "the only record was corrupt, nothing should survive");
    }

    #[test]
    fn span_past_base_len_stops_replay() {
        let base_len = 16u64;
        // file_off + raw_len (12 + 8 = 20) exceeds base_len (16).
        let journal = build_journal(base_len, false, &[(12, 0, 0, b"OVERFLOW")], false);
        let result = replay(&journal, base_len).expect("header is intact");
        assert!(result.truncated);
        assert!(result.spans.is_empty());
    }

    #[test]
    fn bad_magic_rejects_whole_journal() {
        let mut journal = build_journal(16, false, &[(0, 0, 0, b"GOOD")], false);
        journal[0] = b'X';
        assert_eq!(replay(&journal, 16).unwrap_err(), JournalError::BadMagic);
    }

    #[test]
    fn short_buffer_rejects_as_bad_magic() {
        let journal = vec![1, 2, 3];
        assert_eq!(replay(&journal, 16).unwrap_err(), JournalError::BadMagic);
    }

    #[test]
    fn mismatched_base_len_rejects_whole_journal() {
        let journal = build_journal(16, false, &[(0, 0, 0, b"GOOD")], false);
        assert_eq!(replay(&journal, 999).unwrap_err(), JournalError::BaseLenMismatch { expected: 999, found: 16 });
    }

    #[test]
    fn commit_record_detected_when_stream_ends_cleanly() {
        let base_len = 16u64;
        let journal = build_journal(base_len, false, &[(0, 0, 0, b"GOOD")], true);
        let result = replay(&journal, base_len).unwrap();
        assert!(!result.truncated);
        assert!(result.ended_with_commit);
    }

    #[test]
    fn no_commit_record_when_absent() {
        let base_len = 16u64;
        let journal = build_journal(base_len, false, &[(0, 0, 0, b"GOOD")], false);
        let result = replay(&journal, base_len).unwrap();
        assert!(!result.ended_with_commit);
    }

    #[test]
    fn commit_not_detected_when_stream_truncated_after_it() {
        // Commit record present, but garbage bytes follow it — must not report a clean commit.
        let base_len = 16u64;
        let mut journal = build_journal(base_len, false, &[(0, 0, 0, b"GOOD")], true);
        journal.push(0xFF); // stray byte after commit: an unrecognised record kind
        let result = replay(&journal, base_len).unwrap();
        assert!(result.truncated);
        assert!(!result.ended_with_commit);
    }

    #[test]
    fn header_span_sentinel_round_trips() {
        let base_len = 8u64;
        let journal = build_journal(base_len, false, &[(0, i32::MIN, i32::MIN, b"HEAD")], false);
        let result = replay(&journal, base_len).unwrap();
        assert!(result.spans[0].is_header());
        assert_eq!((result.spans[0].cx, result.spans[0].cy), HEADER_SPAN);
    }

    #[test]
    fn journal_writer_matches_manual_encode() {
        let mut buf = Vec::new();
        {
            let mut w = JournalWriter::create(&mut buf, 16, base_id(7), false).unwrap();
            w.append_span(0, 5, 6, b"GOOD").unwrap();
            w.append_commit().unwrap();
            w.flush().unwrap();
        }
        let expected = build_journal(16, false, &[(0, 5, 6, b"GOOD")], true);
        assert_eq!(buf, expected);

        let result = replay(&buf, 16).unwrap();
        assert!(result.ended_with_commit);
        assert_eq!(result.spans[0].cx, 5);
    }

    #[test]
    fn journal_writer_resume_appends_after_existing_header() {
        let mut buf = Vec::new();
        {
            let mut w = JournalWriter::create(&mut buf, 16, base_id(1), false).unwrap();
            w.append_span(0, 0, 0, b"AAAA").unwrap();
        }
        {
            // Simulate reopening the same file in append mode for a later tick.
            let mut w = JournalWriter::resume(&mut buf, false);
            w.append_span(4, 1, 1, b"BBBB").unwrap();
        }
        let result = replay(&buf, 16).unwrap();
        assert_eq!(result.spans.len(), 2);
        assert_eq!(result.spans[1].payload, b"BBBB");
    }
}
