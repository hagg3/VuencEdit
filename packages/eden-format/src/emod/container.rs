//! The `.emod` byte layout: `File := FileHeader (64 B) Record*`, every record
//! `RecordHeader (32 B) payload padding(0–7 zero bytes to an 8-byte boundary)`, little-endian,
//! explicit offsets, no struct ever written by memcpy. Spec §§ Conventions → Record types.

use std::io::Write as _;

// ---- format constants -----------------------------------------------------------------------

pub const MAGIC: [u8; 8] = *b"EMODWLD\0";
/// Every record header starts with this tag (bytes `45 6D 52 31`).
pub const TAG: [u8; 4] = *b"EmR1";
pub const FMT_VERSION: u16 = 1;
pub const FILE_HEADER_LEN: u64 = 64;
pub const RECORD_HEADER_LEN: u64 = 32;
/// The largest stored payload a record may frame with.
pub const MAX_PAYLOAD: u32 = 16 << 20;
/// One 16×16×16 band of a column: 4,096 type bytes then 4,096 paint bytes, `CC(x,z,y)` order.
pub const BAND: usize = 8192;
/// The `.eden` `WorldFileHeader` that `WORLD_HEADER` carries verbatim.
pub const EDEN_HEADER_LEN: usize = 192;
/// One `.eden` directory row (`ColumnIndex`); `SIGN_TRAILER` is a multiple of it.
pub const EDEN_DIR_ROW: usize = 16;
/// One creature slot (`EntityData`).
pub const CREATURE_LEN: usize = 60;
pub const MAX_CREATURE_SLOTS: usize = 400;
pub const TRAILER_MAX: usize = 1 << 20;
pub const GENERATOR_LEN: usize = 28;
pub const SUMMARY_LEN: usize = 16;
pub const COMMIT_LEN: usize = 24;

/// Record types 1–9. Types 8 (`INDEX`, never written in v1) and 10–255 are *reserved*: a reader
/// treats such a record as a member of its batch and otherwise ignores it; compaction drops it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum RecordType {
    Column = 1,
    WorldHeader = 2,
    Creatures = 3,
    SignTrailer = 4,
    Provenance = 5,
    Summary = 6,
    Commit = 7,
    Index = 8,
    Generator = 9,
}

impl RecordType {
    pub fn from_u8(t: u8) -> Option<RecordType> {
        Some(match t {
            1 => RecordType::Column,
            2 => RecordType::WorldHeader,
            3 => RecordType::Creatures,
            4 => RecordType::SignTrailer,
            5 => RecordType::Provenance,
            6 => RecordType::Summary,
            7 => RecordType::Commit,
            8 => RecordType::Index,
            9 => RecordType::Generator,
            _ => return None,
        })
    }

    pub fn name(t: u8) -> String {
        match RecordType::from_u8(t) {
            Some(RecordType::Column) => "COLUMN".into(),
            Some(RecordType::WorldHeader) => "WORLD_HEADER".into(),
            Some(RecordType::Creatures) => "CREATURES".into(),
            Some(RecordType::SignTrailer) => "SIGN_TRAILER".into(),
            Some(RecordType::Provenance) => "PROVENANCE".into(),
            Some(RecordType::Summary) => "SUMMARY".into(),
            Some(RecordType::Commit) => "COMMIT".into(),
            Some(RecordType::Index) => "INDEX".into(),
            Some(RecordType::Generator) => "GENERATOR".into(),
            None => format!("type-{t}"),
        }
    }
}

/// Payload codecs. 3–255 are reserved (a record using one never decodes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Codec {
    None = 0,
    /// Exactly one zstd frame with the content-checksum flag and content size set, no dictionary.
    Zstd = 1,
    /// Exactly one zlib stream (RFC 1950).
    Zlib = 2,
}

impl Codec {
    pub fn from_u8(c: u8) -> Option<Codec> {
        match c {
            0 => Some(Codec::None),
            1 => Some(Codec::Zstd),
            2 => Some(Codec::Zlib),
            _ => None,
        }
    }
}

// ---- little helpers -------------------------------------------------------------------------

#[inline]
pub(crate) fn rd16(p: &[u8]) -> u16 {
    u16::from_le_bytes([p[0], p[1]])
}
#[inline]
pub(crate) fn rd32(p: &[u8]) -> u32 {
    u32::from_le_bytes([p[0], p[1], p[2], p[3]])
}
#[inline]
pub(crate) fn rd64(p: &[u8]) -> u64 {
    u64::from_le_bytes(p[..8].try_into().unwrap())
}

/// The spec's CRC-32 (zlib's `crc32()`), continuing from `crc` (0 to start).
#[inline]
pub fn crc32_update(crc: u32, data: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new_with_initial(crc);
    h.update(data);
    h.finalize()
}

#[inline]
pub fn crc32(data: &[u8]) -> u32 {
    crc32_update(0, data)
}

/// Zero bytes after a record of `n` bytes up to the next 8-byte boundary.
#[inline]
pub(crate) fn pad8(n: u64) -> u64 {
    (8 - (n & 7)) & 7
}

/// A whole record's size on disk (header + payload + padding).
#[inline]
pub(crate) fn record_size(plen: u32) -> u64 {
    let n = RECORD_HEADER_LEN + plen as u64;
    n + pad8(n)
}

/// FileManager's `twoToOne` gate: `0 ≤ x, z < 32768` and `(x, z) ≠ (0, 0)` (key 0 is invalid).
#[inline]
pub fn addressable(x: i32, z: i32) -> bool {
    (0..32768).contains(&x) && (0..32768).contains(&z) && ((x as i64) << 15) + z as i64 != 0
}

pub(crate) fn all_zero(p: &[u8]) -> bool {
    let words = p.chunks_exact(8);
    let rest = words.remainder();
    words.into_iter().all(|w| u64::from_ne_bytes(w.try_into().unwrap()) == 0) && rest.iter().all(|&b| b == 0)
}

// ---- headers and fixed payloads -------------------------------------------------------------

/// The 64-byte file header: magic, `fmt_version` 1, `bands`, flags 0, `created_unix`, 36 reserved
/// zero bytes, CRC-32 of bytes 0..59.
pub(crate) fn file_header(bands: u16, created_unix: u64) -> [u8; FILE_HEADER_LEN as usize] {
    let mut h = [0u8; FILE_HEADER_LEN as usize];
    h[0..8].copy_from_slice(&MAGIC);
    h[8..10].copy_from_slice(&FMT_VERSION.to_le_bytes());
    h[10..12].copy_from_slice(&bands.to_le_bytes());
    h[16..24].copy_from_slice(&created_unix.to_le_bytes());
    let c = crc32(&h[..60]);
    h[60..64].copy_from_slice(&c.to_le_bytes());
    h
}

/// Validates a file header (spec: a reader must refuse the file when the magic, the CRC or
/// `fmt_version` doesn't match, `bands` isn't 4 or 16, or flags/reserved are non-zero). Returns
/// `(bands, created_unix)`.
pub(crate) fn parse_file_header(h: &[u8], check_crc: bool) -> Result<(u16, u64), String> {
    if h.len() < FILE_HEADER_LEN as usize {
        return Err("file shorter than the 64-byte file header".into());
    }
    if h[0..8] != MAGIC {
        return Err("bad magic (not an .emod file)".into());
    }
    if check_crc && crc32(&h[..60]) != rd32(&h[60..]) {
        return Err("file header CRC mismatch".into());
    }
    let ver = rd16(&h[8..]);
    if ver != FMT_VERSION {
        return Err(format!("fmt_version {ver} (this reader knows {FMT_VERSION})"));
    }
    let bands = rd16(&h[10..]);
    if bands != 4 && bands != 16 {
        return Err(format!("bands {bands} is neither 4 nor 16"));
    }
    if rd32(&h[12..]) != 0 || !all_zero(&h[24..60]) {
        return Err("non-zero flags/reserved in the file header (written by a newer build)".into());
    }
    Ok((bands, rd64(&h[16..])))
}

/// Appends one record (header + payload + zero padding) to `out`; returns its `crc32` field.
#[allow(clippy::too_many_arguments)]
pub(crate) fn append_record(
    out: &mut Vec<u8>,
    rtype: u8,
    codec: u8,
    mask: u16,
    x: i32,
    z: i32,
    aux: u32,
    seq: u32,
    payload: &[u8],
) -> u32 {
    let mut h = [0u8; RECORD_HEADER_LEN as usize];
    h[0..4].copy_from_slice(&TAG);
    h[4] = rtype;
    h[5] = codec;
    h[6..8].copy_from_slice(&mask.to_le_bytes());
    h[8..12].copy_from_slice(&x.to_le_bytes());
    h[12..16].copy_from_slice(&z.to_le_bytes());
    h[16..20].copy_from_slice(&aux.to_le_bytes());
    h[20..24].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    h[24..28].copy_from_slice(&seq.to_le_bytes());
    let c = crc32_update(crc32(&h[..28]), payload);
    h[28..32].copy_from_slice(&c.to_le_bytes());
    out.extend_from_slice(&h);
    out.extend_from_slice(payload);
    let pad = pad8(RECORD_HEADER_LEN + payload.len() as u64) as usize;
    out.resize(out.len() + pad, 0);
    c
}

pub(crate) fn summary_payload(live: u32, next_ord: u32, band_or: u16) -> [u8; SUMMARY_LEN] {
    let mut p = [0u8; SUMMARY_LEN];
    p[0..4].copy_from_slice(&live.to_le_bytes());
    p[4..8].copy_from_slice(&next_ord.to_le_bytes());
    p[8..10].copy_from_slice(&band_or.to_le_bytes());
    p
}

pub(crate) fn commit_payload(seq: u32, count: u32, crc_of_crcs: u32, prev_commit: u64) -> [u8; COMMIT_LEN] {
    let mut p = [0u8; COMMIT_LEN];
    p[0..4].copy_from_slice(&seq.to_le_bytes());
    p[4..8].copy_from_slice(&count.to_le_bytes());
    p[8..12].copy_from_slice(&crc_of_crcs.to_le_bytes());
    p[16..24].copy_from_slice(&prev_commit.to_le_bytes());
    p
}

/// CRC-32 over the records' `crc32` header fields, each as 4 LE bytes, in file order.
pub(crate) fn crc_of_crcs(crcs: impl IntoIterator<Item = u32>) -> u32 {
    let mut h = crc32fast::Hasher::new();
    for c in crcs {
        h.update(&c.to_le_bytes());
    }
    h.finalize()
}

// ---- bands ----------------------------------------------------------------------------------

/// `(band_mask, payload)` for one full-stride column (`bands × 8,192` bytes): band *b* is stored
/// iff any of its 8,192 bytes is non-zero — the type plane **or the paint plane** (paint-only
/// bands are real: SN City has 16, Quarry 28). Canonical: no all-zero band is ever stored.
pub fn split_bands(column: &[u8], bands: usize, payload: &mut Vec<u8>) -> u16 {
    assert_eq!(column.len(), bands * BAND, "split_bands: a column is bands × 8,192 bytes");
    payload.clear();
    let mut mask = 0u16;
    for (b, seg) in column.chunks_exact(BAND).enumerate() {
        if !all_zero(seg) {
            mask |= 1 << b;
            payload.extend_from_slice(seg);
        }
    }
    mask
}

/// The inverse: `column` (`bands × 8,192` bytes) gets each set band from `payload` in ascending
/// order and zeros for every cleared band.
pub fn join_bands(mask: u16, payload: &[u8], bands: usize, column: &mut [u8]) {
    assert_eq!(column.len(), bands * BAND, "join_bands: a column is bands × 8,192 bytes");
    let mut p = 0;
    for (b, dst) in column.chunks_exact_mut(BAND).enumerate() {
        if mask >> b & 1 != 0 {
            dst.copy_from_slice(&payload[p..p + BAND]);
            p += BAND;
        } else {
            dst.fill(0);
        }
    }
}

// ---- codecs ---------------------------------------------------------------------------------

/// The zstd level every byte-identical writer uses (conversion, compaction, saves).
pub const ZSTD_LEVEL: i32 = 3;
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

/// Encoder/decoder holding one reusable zstd context each (created lazily). Encoding is what
/// conversion, compaction and saves share, so all three produce the same bytes.
#[derive(Default)]
pub struct Codecs {
    cctx: Option<zstd_safe::CCtx<'static>>,
    dctx: Option<zstd_safe::DCtx<'static>>,
}

impl Codecs {
    pub fn new() -> Codecs {
        Codecs::default()
    }

    /// Encodes `data` into `out`, returning the codec actually used. Empty input, `compress ==
    /// false` or `codec == None` → `None` and the bytes themselves (an empty payload is always
    /// codec 0). zstd: level 3, content checksum on, content size on, no dictionary id,
    /// single-shot — the spec's byte-identical writer. zlib: level 6 (not byte-pinned).
    pub fn encode(&mut self, codec: Codec, data: &[u8], compress: bool, out: &mut Vec<u8>) -> Result<Codec, String> {
        out.clear();
        if data.is_empty() || !compress || codec == Codec::None {
            out.extend_from_slice(data);
            return Ok(Codec::None);
        }
        match codec {
            Codec::Zstd => {
                let c = self.cctx.get_or_insert_with(zstd_safe::CCtx::create);
                let set = |c: &mut zstd_safe::CCtx<'static>| -> Result<(), String> {
                    let e = |code| format!("zstd: {}", zstd_safe::get_error_name(code));
                    c.reset(zstd_safe::ResetDirective::SessionAndParameters).map_err(e)?;
                    c.set_parameter(zstd_safe::CParameter::CompressionLevel(ZSTD_LEVEL)).map_err(e)?;
                    c.set_parameter(zstd_safe::CParameter::ChecksumFlag(true)).map_err(e)?;
                    c.set_parameter(zstd_safe::CParameter::ContentSizeFlag(true)).map_err(e)?;
                    c.set_parameter(zstd_safe::CParameter::DictIdFlag(false)).map_err(e)?;
                    Ok(())
                };
                set(c)?;
                out.reserve(zstd_safe::compress_bound(data.len()));
                c.compress2(out, data)
                    .map_err(|code| format!("zstd compress: {}", zstd_safe::get_error_name(code)))?;
                Ok(Codec::Zstd)
            }
            Codec::Zlib => {
                let mut e = flate2::write::ZlibEncoder::new(std::mem::take(out), flate2::Compression::new(6));
                e.write_all(data).map_err(|e| format!("zlib compress: {e}"))?;
                *out = e.finish().map_err(|e| format!("zlib compress: {e}"))?;
                Ok(Codec::Zlib)
            }
            Codec::None => unreachable!(),
        }
    }

    /// Strict decode into `out` (whose length is the expected decoded length): exactly one
    /// frame/stream, no trailing bytes, the decoded length exact; zstd frames must carry the
    /// content checksum and a content size equal to `out.len()`, and no dictionary. `false` on
    /// any violation, including a reserved codec.
    pub fn decode(&mut self, codec: u8, payload: &[u8], out: &mut [u8]) -> bool {
        let expect = out.len();
        match Codec::from_u8(codec) {
            Some(Codec::None) => {
                if payload.len() != expect {
                    return false;
                }
                out.copy_from_slice(payload);
                true
            }
            _ if expect == 0 => false, // a compressed record with an empty decoded size
            Some(Codec::Zstd) => {
                // Frame header: 4-byte magic, then the descriptor (bit 2 = content checksum).
                if payload.len() < 5 || payload[..4] != ZSTD_MAGIC || payload[4] & 0x04 == 0 {
                    return false;
                }
                if zstd_safe::get_dict_id_from_frame(payload).is_some() {
                    return false;
                }
                match zstd_safe::get_frame_content_size(payload) {
                    Ok(Some(n)) if n == expect as u64 => {}
                    _ => return false,
                }
                match zstd_safe::find_frame_compressed_size(payload) {
                    Ok(n) if n == payload.len() => {} // exactly one frame, no trailing bytes
                    _ => return false,
                }
                let d = self.dctx.get_or_insert_with(zstd_safe::DCtx::create);
                matches!(d.decompress(out, payload), Ok(n) if n == expect)
            }
            Some(Codec::Zlib) => {
                let mut d = flate2::Decompress::new(true);
                match d.decompress(payload, out, flate2::FlushDecompress::Finish) {
                    Ok(flate2::Status::StreamEnd) => {
                        d.total_in() == payload.len() as u64 && d.total_out() == expect as u64
                    }
                    _ => false,
                }
            }
            None => false,
        }
    }
}

/// The linked zstd's `ZSTD_versionNumber()` (`10507` for the pinned 1.5.7).
pub fn zstd_version_number() -> u32 {
    zstd_safe::version_number()
}
