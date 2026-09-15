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
//! Replay comes in two shapes over **one** decoder: `replay_each` streams, handing each span to a
//! sink as a borrow of the decoder's own scratch buffer (peak allocation = the largest single
//! record, not the whole journal), and `replay` is a thin collecting wrapper over it for callers
//! that want a `Vec<Span>`. Keeping them one decoder is deliberate — the whole crash-safety story
//! lives in the truncation edge cases below, and two implementations of it would eventually
//! disagree about one of them.
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

/// An owned span, as produced by the collecting `replay`. Test-only along with it — the shipping
/// recovery paths take spans as borrows through `replay_each` and never materialize a `Vec<Span>`.
#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct Span {
    pub(crate) file_off: u64,
    pub(crate) cx: i32,
    pub(crate) cy: i32,
    pub(crate) payload: Vec<u8>,
}

#[cfg(test)]
impl Span {
    pub(crate) fn is_header(&self) -> bool {
        (self.cx, self.cy) == HEADER_SPAN
    }
}

/// One span handed to a streaming sink. `payload` borrows the decoder's scratch buffer and is valid
/// only for the duration of the callback — that borrow is exactly what lets `replay_each` reuse a
/// single allocation across a multi-GB journal instead of one `Vec` per record.
pub(crate) struct SpanRef<'a> {
    pub(crate) file_off: u64,
    pub(crate) cx: i32,
    pub(crate) cy: i32,
    pub(crate) payload: &'a [u8],
}

impl SpanRef<'_> {
    #[allow(dead_code)]
    pub(crate) fn is_header(&self) -> bool {
        (self.cx, self.cy) == HEADER_SPAN
    }
}

/// What a streaming replay reports once the stream is exhausted. The `Vec<Span>`-free counterpart of
/// `ReplayResult`; the two carry the same two flags and mean the same thing by them.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ReplaySummary {
    /// Number of span records handed to the sink.
    pub(crate) spans: u64,
    /// See `ReplayResult::ended_with_commit`.
    pub(crate) ended_with_commit: bool,
    /// See `ReplayResult::truncated`.
    pub(crate) truncated: bool,
}

/// The collecting counterpart of `ReplaySummary`. Test-only; see `replay`.
#[cfg(test)]
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

/// Why a streaming replay stopped without reaching the end of the stream. The two arms need
/// opposite reactions from the caller, which is the whole reason they're distinguished: `Journal`
/// means this journal doesn't belong to the base image in hand (throw it away), `Sink` means the
/// caller's own write failed (report it, and keep the journal so the next attempt can retry).
#[derive(Debug)]
pub(crate) enum ReplayAbort<E> {
    Journal(JournalError),
    Sink(E),
}

/// Streaming replay: decode `r` record by record, handing each clean span to `sink` as a borrow of
/// the decoder's scratch. Peak allocation is the largest single record — **not** the journal, and
/// not the base image (see `apply_spans`' note). This is the form the recovery paths use, where the
/// journal can decompress to something world-sized (audit P-2).
///
/// Header handling matches `replay` exactly: a bad magic or a `base_len` mismatch rejects the whole
/// journal (`Err(ReplayAbort::Journal)`), while anything past the header degrades gracefully to
/// `Ok(ReplaySummary { truncated: true, .. })` with every record before the bad one already
/// delivered. A span reaches `sink` only after its bounds and CRC checks pass, so a caller applying
/// spans as they arrive never writes a corrupt one.
pub(crate) fn replay_each<R, F, E>(
    mut r: R,
    expected_base_len: u64,
    mut sink: F,
) -> Result<ReplaySummary, ReplayAbort<E>>
where
    R: Read,
    F: FnMut(SpanRef<'_>) -> Result<(), E>,
{
    let mut header_buf = [0u8; HEADER_LEN];
    // A short read here is the streaming equivalent of `bytes.len() < HEADER_LEN`: both mean "this
    // isn't a journal", which `JournalHeader::decode` reports as `BadMagic`.
    if r.read_exact(&mut header_buf).is_err() {
        return Err(ReplayAbort::Journal(JournalError::BadMagic));
    }
    let header = JournalHeader::decode(&header_buf).ok_or(ReplayAbort::Journal(JournalError::BadMagic))?;
    if header.base_len != expected_base_len {
        return Err(ReplayAbort::Journal(JournalError::BaseLenMismatch {
            expected: expected_base_len,
            found: header.base_len,
        }));
    }
    let compressed = header.compressed();

    // The two scratch buffers the whole streaming property rests on: `clear()`ed per record, never
    // reallocated, so their capacity converges on the largest record and stays there.
    let mut stored: Vec<u8> = Vec::new();
    let mut payload: Vec<u8> = Vec::new();

    let mut spans = 0u64;
    let mut truncated = false;
    let mut hit_eof = false;
    let mut last_was_commit = false;

    loop {
        // `read`, not `read_exact` — a clean end of stream must be distinguishable from a torn
        // record, and `read_exact` collapses both into an error.
        let mut kind_buf = [0u8; 1];
        match r.read(&mut kind_buf) {
            Ok(0) => { hit_eof = true; break; }
            Ok(_) => {}
            Err(_) => { truncated = true; break; }
        }
        let kind = kind_buf[0];

        if kind == RECORD_KIND_COMMIT {
            last_was_commit = true;
            continue;
        }
        if kind != RECORD_KIND_SPAN {
            truncated = true;
            break;
        }
        last_was_commit = false;

        let mut fixed = [0u8; SPAN_FIXED_LEN];
        if r.read_exact(&mut fixed).is_err() {
            truncated = true;
            break;
        }
        let file_off = u64::from_le_bytes(fixed[0..8].try_into().unwrap());
        let cx = i32::from_le_bytes(fixed[8..12].try_into().unwrap());
        let cy = i32::from_le_bytes(fixed[12..16].try_into().unwrap());
        let raw_len = u32::from_le_bytes(fixed[16..20].try_into().unwrap());
        let comp_len = u32::from_le_bytes(fixed[20..24].try_into().unwrap());
        let crc = u32::from_le_bytes(fixed[24..28].try_into().unwrap());

        // ⚠️ `comp_len` is a u32 straight off disk, so a corrupt record can claim ~4 GB. `take` +
        // `read_to_end` allocates only what the stream actually holds and leaves a short read — the
        // truncation signal — instead of asking the allocator for the claim. (The slice form of
        // this decoder got the same guarantee for free from its bounds check.)
        stored.clear();
        let read_res = (&mut r).take(comp_len as u64).read_to_end(&mut stored);
        if read_res.is_err() || stored.len() != comp_len as usize {
            truncated = true;
            break;
        }

        // file_off + raw_len must fit inside the base image — checked_add guards the overflow
        // case too (a corrupt file_off near u64::MAX must not wrap and pass the bounds check).
        // Deliberately *before* decompression, so a bogus length is rejected without doing work.
        let end = match file_off.checked_add(raw_len as u64) {
            Some(e) if e <= header.base_len => e,
            _ => { truncated = true; break; }
        };
        let _ = end;

        payload.clear();
        if compressed {
            // ⚠️ Same u32 hazard as `comp_len`, on the output side: never size the buffer from
            // `raw_len` up front. `take(raw_len + 1)` bounds the decompression while still letting
            // an over-long stream exceed `raw_len` and trip the length check below, which is how
            // the slice form rejected it too.
            let mut dec = DeflateDecoder::new(&stored[..]).take(raw_len as u64 + 1);
            if dec.read_to_end(&mut payload).is_err() {
                truncated = true;
                break;
            }
        } else {
            payload.extend_from_slice(&stored);
        }
        if payload.len() != raw_len as usize {
            truncated = true;
            break;
        }
        if crc32fast::hash(&payload) != crc {
            truncated = true;
            break;
        }

        sink(SpanRef { file_off, cx, cy, payload: &payload }).map_err(ReplayAbort::Sink)?;
        spans += 1;
    }

    let ended_with_commit = !truncated && hit_eof && last_was_commit;
    Ok(ReplaySummary { spans, ended_with_commit, truncated })
}

/// Replay a journal buffer against a base image of `expected_base_len` bytes. A bad magic or a
/// `base_len` mismatch rejects the *whole* journal (`Err`) — those aren't corruption, they mean
/// this journal doesn't belong to the base image the caller has in hand. Anything past the header
/// degrades gracefully: `Ok(ReplayResult)` with `truncated` set and only the clean prefix applied.
///
/// A collecting wrapper over `replay_each`, which owns the only copy of the wire format.
///
/// **`#[cfg(test)]`-only**, and deliberately so: since audit P-2 both shipping callers
/// (`load_autosave_inner`, `recover_wal`) stream, because a journal can decompress to something
/// world-sized and a `Vec<Span>` of it is the allocation that aborts the process on Windows. What
/// this function is *for* now is the same thing `build_lamp_index` is for the lamp index — the
/// obvious, easy-to-read reference implementation that the shipping path is asserted to match
/// (`streaming_replay_matches_the_collecting_form`). Keep it in that role; don't call it from
/// shipping code, and don't reimplement the decoder in it.
#[cfg(test)]
pub(crate) fn replay(bytes: &[u8], expected_base_len: u64) -> Result<ReplayResult, JournalError> {
    let mut spans = Vec::new();
    let summary = replay_each(bytes, expected_base_len, |s| {
        spans.push(Span { file_off: s.file_off, cx: s.cx, cy: s.cy, payload: s.payload.to_vec() });
        Ok::<(), std::convert::Infallible>(())
    })
    .map_err(|e| match e {
        ReplayAbort::Journal(j) => j,
        // Total, not a panic: `Infallible` has no variants, so this arm is uninhabited and the
        // compiler knows the sink above cannot have failed.
        ReplayAbort::Sink(never) => match never {},
    })?;
    Ok(ReplayResult { spans, ended_with_commit: summary.ended_with_commit, truncated: summary.truncated })
}

/// Apply replayed spans onto a base buffer of exactly `base_len` bytes, in stream order — a later
/// span for an offset that a earlier span also touched simply overwrites it, which is the whole
/// "last write wins" semantic.
///
/// Test-only. The recovery paths (`load_autosave_inner`,
/// `recover_wal`) drive `replay_each` and pwrite each span straight into the destination *file*,
/// holding neither the base image nor the decoded spans resident — this in-memory form would defeat
/// both halves of that. (Before audit P-2 this comment claimed the second half was already true; it
/// was true of the base image and false of the spans, which is the bug P-2 fixed.) Kept as a
/// small-buffer convenience for the tests that don't have that constraint.
#[cfg(test)]
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

    // ── Streaming replay (audit P-2) ──────────────────────────────────────

    /// Collect what `replay_each` emits, in the shape `replay` returns, so the two can be compared
    /// field for field.
    fn stream_collect(bytes: &[u8], base_len: u64) -> Result<(Vec<Span>, ReplaySummary), JournalError> {
        let mut spans = Vec::new();
        let summary = replay_each(bytes, base_len, |s| {
            spans.push(Span { file_off: s.file_off, cx: s.cx, cy: s.cy, payload: s.payload.to_vec() });
            Ok::<(), std::convert::Infallible>(())
        })
        .map_err(|e| match e {
            ReplayAbort::Journal(j) => j,
            ReplayAbort::Sink(never) => match never {},
        })?;
        Ok((spans, summary))
    }

    /// The edge-case table for the one decoder both replay shapes run on. Each case pins the
    /// **absolute** outcome — how many spans survive, and whether the stream is reported truncated
    /// and/or cleanly committed — and then asserts `replay` and `replay_each` agree on it.
    ///
    /// Both halves matter and neither substitutes for the other. The absolute expectations are what
    /// catch a regression *inside* the shared decoder (a torn record silently reported as a clean
    /// end would otherwise slip through a purely relative comparison, since both shapes would move
    /// together). The agreement check is what catches the two forms being *forked* later — the
    /// failure mode audit P-2 exists to prevent, where a partial replay that goes wrong produces a
    /// world that loads, parses, and is quietly missing an edit.
    #[test]
    fn streaming_replay_matches_the_collecting_form() {
        let big = vec![9u8; 3000]; // compresses well, like a real chunk

        // (name, journal bytes, expected_base_len, expected outcome). `Err` = the whole journal is
        // rejected at the header; `Ok((spans, truncated, ended_with_commit))` = it decoded.
        type Outcome = Result<(u64, bool, bool), JournalError>;
        let cases: Vec<(&str, Vec<u8>, u64, Outcome)> = vec![
            ("empty stream",
                build_journal(64, false, &[], false), 64, Ok((0, false, false))),
            ("clean multi-span",
                build_journal(64, false, &[(0, 1, 2, b"AAAA"), (8, 3, 4, b"BBBB")], false), 64, Ok((2, false, false))),
            ("header span sentinel",
                build_journal(64, false, &[(0, i32::MIN, i32::MIN, b"HEAD")], false), 64, Ok((1, false, false))),
            ("overlapping spans",
                build_journal(16, false, &[(0, 0, 0, b"AAAA"), (0, 0, 0, b"BBBB")], false), 16, Ok((2, false, false))),
            ("commit terminated",
                build_journal(16, false, &[(0, 0, 0, b"GOOD")], true), 16, Ok((1, false, true))),
            ("compressed",
                build_journal(4096, true, &[(100, 3, 4, &big)], false), 4096, Ok((1, false, false))),
            ("compressed multi, committed",
                build_journal(8192, true, &[(0, 1, 1, &big), (4096, 2, 2, b"tiny")], true), 8192, Ok((2, false, true))),
            ("header only, no records",
                JournalHeader::new(false, 16, base_id(7)).encode().to_vec(), 16, Ok((0, false, false))),
            ("bad magic",
                { let mut j = build_journal(16, false, &[(0, 0, 0, b"GOOD")], false); j[0] = b'X'; j },
                16, Err(JournalError::BadMagic)),
            ("short buffer",
                vec![1, 2, 3], 16, Err(JournalError::BadMagic)),
            ("base_len mismatch",
                build_journal(16, false, &[(0, 0, 0, b"GOOD")], false), 999,
                Err(JournalError::BaseLenMismatch { expected: 999, found: 16 })),
            ("truncated mid payload",
                { let mut j = build_journal(32, false, &[(0, 0, 0, b"GOOD"), (8, 1, 1, b"MORE")], false);
                  j.truncate(j.len() - 3); j },
                32, Ok((1, true, false))),
            ("truncated mid compressed payload",
                { let mut j = build_journal(4096, true, &[(0, 0, 0, b"GOOD"), (8, 1, 1, &big)], false);
                  j.truncate(j.len() - 10); j },
                4096, Ok((1, true, false))),
            // ⚠️ Distinct from the two above: these end *inside the fixed fields*, before any payload
            // byte. Over a `Read` that is a short `read_exact`, which must be reported as a torn
            // record and not mistaken for a clean end of stream — the one branch a purely relative
            // comparison between the two shapes can never catch, since both would move together.
            ("truncated to a bare kind byte",
                { let mut j = build_journal(32, false, &[(0, 0, 0, b"GOOD")], false);
                  j.push(RECORD_KIND_SPAN); j },
                32, Ok((1, true, false))),
            ("truncated mid fixed fields",
                { let mut j = build_journal(32, false, &[(0, 0, 0, b"GOOD")], false);
                  j.push(RECORD_KIND_SPAN); j.extend_from_slice(&[0u8; SPAN_FIXED_LEN - 1]); j },
                32, Ok((1, true, false))),
            ("truncated mid fixed fields after a commit",
                { let mut j = build_journal(32, false, &[(0, 0, 0, b"GOOD")], true);
                  j.push(RECORD_KIND_SPAN); j.extend_from_slice(&[0u8; SPAN_FIXED_LEN - 1]); j },
                32, Ok((1, true, false))),
            ("bad crc",
                { let mut j = build_journal(16, false, &[(0, 0, 0, b"GOOD")], false);
                  let n = j.len(); j[n - 4] ^= 0xFF; j },
                16, Ok((0, true, false))),
            ("corrupt compressed payload",
                { let mut j = build_journal(4096, true, &[(0, 0, 0, &big)], false);
                  let n = j.len(); j[n - 5] ^= 0xFF; j },
                4096, Ok((0, true, false))),
            ("span past base_len",
                build_journal(16, false, &[(12, 0, 0, b"OVERFLOW")], false), 16, Ok((0, true, false))),
            ("unknown record kind",
                { let mut j = build_journal(16, false, &[(0, 0, 0, b"GOOD")], false); j.push(0xFF); j },
                16, Ok((1, true, false))),
            ("stray byte after commit",
                { let mut j = build_journal(16, false, &[(0, 0, 0, b"GOOD")], true); j.push(0xFF); j },
                16, Ok((1, true, false))),
            // ⚠️ Pins the `stored.len() != comp_len` check specifically. `raw_len` and the CRC are
            // both consistent with the bytes that *are* present, so every downstream check passes —
            // only comparing the payload actually read against the length the record declared can
            // tell that the writer never finished it. Without that check this torn record is
            // accepted as clean.
            ("comp_len overruns the stream but the remainder is self-consistent", {
                let mut j = JournalHeader::new(false, 4096, base_id(7)).encode().to_vec();
                j.push(RECORD_KIND_SPAN);
                j.extend_from_slice(&0u64.to_le_bytes());       // file_off
                j.extend_from_slice(&0i32.to_le_bytes());       // cx
                j.extend_from_slice(&0i32.to_le_bytes());       // cy
                j.extend_from_slice(&4u32.to_le_bytes());       // raw_len: matches what's present
                j.extend_from_slice(&999u32.to_le_bytes());     // comp_len: claims far more
                j.extend_from_slice(&crc32fast::hash(b"tiny").to_le_bytes()); // and the CRC agrees
                j.extend_from_slice(b"tiny");
                j
            }, 4096, Ok((0, true, false))),
        ];

        for (name, journal, base_len, expected) in cases {
            match (replay(&journal, base_len), stream_collect(&journal, base_len)) {
                (Err(a), Err(b)) => {
                    assert_eq!(a, b, "{name}: header rejection must match between the two shapes");
                    assert_eq!(Err(a), expected, "{name}: header rejection");
                }
                (Ok(r), Ok((spans, summary))) => {
                    // Absolute: what this journal is *supposed* to decode to.
                    assert_eq!(
                        Ok((r.spans.len() as u64, r.truncated, r.ended_with_commit)), expected,
                        "{name}: (spans, truncated, ended_with_commit)");
                    // Relative: the two shapes must not have forked.
                    assert_eq!(r.truncated, summary.truncated, "{name}: truncated flag");
                    assert_eq!(r.ended_with_commit, summary.ended_with_commit, "{name}: commit flag");
                    assert_eq!(r.spans.len() as u64, summary.spans, "{name}: span count");
                    assert_eq!(r.spans.len(), spans.len(), "{name}: emitted span count");
                    for (i, (x, y)) in r.spans.iter().zip(spans.iter()).enumerate() {
                        assert_eq!((x.file_off, x.cx, x.cy), (y.file_off, y.cx, y.cy), "{name}: span {i} fields");
                        assert_eq!(x.payload, y.payload, "{name}: span {i} payload");
                    }
                }
                (a, b) => panic!("{name}: one form rejected the journal and the other didn't: {a:?} vs {b:?}"),
            }
        }
    }

    /// The property the whole row exists for: one journal of many records must not cost one
    /// allocation per record. Observed through the sink — every payload is handed out at the same
    /// address, which is only possible if the decoder is reusing one buffer across the stream.
    #[test]
    fn streaming_replay_reuses_one_scratch_allocation() {
        let payload = vec![5u8; 2048];
        let records: Vec<(u64, i32, i32, &[u8])> =
            (0..64).map(|i| (i as u64 * 2048, i, 0, payload.as_slice())).collect();
        let journal = build_journal(64 * 2048, true, &records, false);

        let mut addrs = std::collections::HashSet::new();
        let mut seen = 0;
        let summary = replay_each(&journal[..], 64 * 2048, |s| {
            assert_eq!(s.payload.len(), 2048);
            assert_eq!(s.payload[0], 5);
            addrs.insert(s.payload.as_ptr() as usize);
            seen += 1;
            Ok::<(), std::convert::Infallible>(())
        })
        .unwrap_or_else(|_| panic!("clean journal must replay"));

        assert_eq!(summary.spans, 64);
        assert_eq!(seen, 64);
        assert_eq!(addrs.len(), 1,
            "every record must be decoded into the same reused scratch buffer, not a fresh Vec each");
    }

    /// `comp_len` is a u32 straight off disk. The slice decoder rejected an absurd one for free via
    /// its bounds check; the streaming decoder has to do it deliberately, or a single corrupt record
    /// asks the allocator for gigabytes on the one path that runs after a crash.
    #[test]
    fn streaming_replay_rejects_an_absurd_comp_len_without_allocating() {
        let mut journal = JournalHeader::new(false, 4096, base_id(7)).encode().to_vec();
        journal.push(RECORD_KIND_SPAN);
        journal.extend_from_slice(&0u64.to_le_bytes());          // file_off
        journal.extend_from_slice(&0i32.to_le_bytes());          // cx
        journal.extend_from_slice(&0i32.to_le_bytes());          // cy
        journal.extend_from_slice(&16u32.to_le_bytes());         // raw_len
        journal.extend_from_slice(&3_000_000_000u32.to_le_bytes()); // comp_len: ~3 GB, on 4 bytes of file
        journal.extend_from_slice(&0u32.to_le_bytes());          // crc
        journal.extend_from_slice(b"tiny");

        let mut calls = 0;
        let summary = replay_each(&journal[..], 4096, |_| { calls += 1; Ok::<(), std::convert::Infallible>(()) })
            .unwrap_or_else(|_| panic!("the header is intact, so the journal must not be rejected outright"));
        assert!(summary.truncated, "a comp_len past the end of the stream is a torn record");
        assert_eq!(summary.spans, 0);
        assert_eq!(calls, 0, "nothing may be handed to the sink from a torn record");

        // And the slice form must agree, since they are one decoder.
        let r = replay(&journal, 4096).expect("header intact");
        assert!(r.truncated);
        assert!(r.spans.is_empty());
    }

    /// A failing sink aborts the replay and is reported as `Sink`, not as journal corruption — the
    /// caller has to tell "your write failed" from "throw this journal away". Records delivered
    /// before the failure still happened, which is what makes a retry meaningful.
    #[test]
    fn streaming_replay_propagates_a_sink_error() {
        let journal = build_journal(64, false, &[
            (0, 1, 1, b"AAAA"),
            (8, 2, 2, b"BBBB"),
            (16, 3, 3, b"CCCC"),
        ], false);

        let mut delivered: Vec<i32> = Vec::new();
        let err = replay_each(&journal[..], 64, |s| {
            delivered.push(s.cx);
            if s.cx == 2 {
                Err(io::Error::other("disk full"))
            } else {
                Ok(())
            }
        })
        .expect_err("a failing sink must abort the replay");

        match err {
            ReplayAbort::Sink(e) => assert_eq!(e.to_string(), "disk full"),
            ReplayAbort::Journal(j) => panic!("a sink failure must not be reported as {j:?}"),
        }
        assert_eq!(delivered, vec![1, 2], "the third record must never be reached");
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
