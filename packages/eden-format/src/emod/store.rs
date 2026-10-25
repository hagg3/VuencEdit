//! [`Store`]: open / scan / recover an `.emod`, read columns and singletons (with the spec's
//! damaged-record fallback), append a batch + COMMIT + fsync, compact, verify.
//!
//! A port of Emod's `EdenWorldStore` (`Classes/EdenWorldStore.cpp`), which follows
//! `port/tools/emod.py`'s `Store._scan` / `_evaluate` / `verify`; every rule cites the spec section
//! it implements. One owner at a time: nothing here is thread-safe and nothing needs to be (every
//! method that touches the file or the codecs takes `&mut self`).

use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::container::*;
use super::fsutil::{read_exact_at, replace_file, with_suffix, write_all_at};

// ---- errors ---------------------------------------------------------------------------------

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    /// The file must be refused (spec: a bad file header, or no valid commit — "no world").
    Refused(String),
    /// A caller-side violation: bad key or record length, a read-only store, mid-batch, …
    Invalid(String),
    /// Compaction refused: the store is damaged (the bad bytes must never be the only copy
    /// destroyed), or compaction found a live record that doesn't decode.
    Damaged(String),
    /// An encoder failure, or a payload over 16 MiB.
    Codec(String),
    /// A `commit` cut short by the crash-injection test hook. The store is closed.
    TestCrash,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(e) => write!(f, "{e}"),
            Error::Refused(s) | Error::Invalid(s) | Error::Damaged(s) | Error::Codec(s) => f.write_str(s),
            Error::TestCrash => f.write_str("test crash"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Error {
        Error::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

// ---- public value types ---------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct OpenOptions {
    /// Open read-write. Nothing is written until [`Store::commit`] or [`Store::compact`].
    pub writable: bool,
    /// Check every CRC while framing. `false` exists **only** for the corrupt gate's control run
    /// (which must then fail); never open a user's file with it.
    pub check_crc: bool,
    /// Read the file as if it ended here (read-only). An append-only file's prefix up to an earlier
    /// [`Store::truncation_point`] is that earlier state, so this reopens the state some reader saw
    /// before another writer appended (VuencEdit's autosave recovery as a copy, ROADMAP-EDIT 26.6).
    pub len_limit: Option<u64>,
}

impl Default for OpenOptions {
    fn default() -> OpenOptions {
        OpenOptions { writable: false, check_crc: true, len_limit: None }
    }
}

/// How a read was served (spec § Reading, "Decoding a live record").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadStatus {
    /// The newest committed version decoded.
    Ok,
    /// It did not; an earlier committed version did. Damage.
    Fallback,
    /// No version decodes: the column reads as air and the caller must **not** mark it
    /// modified (never substitute the default map or a generator). Damage.
    AirDamaged,
    /// No such key.
    Absent,
}

/// `SUMMARY`'s three values for the live state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Summary {
    pub live_columns: u32,
    /// 1 + the highest live ord, or 0 with no columns.
    pub next_ord: u32,
    /// OR of every live `band_mask`: the constant-time "highest occupied band".
    pub band_or: u16,
}

/// The last applied COMMIT: what an external-writer identity check compares (plan §2.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommitRef {
    pub offset: u64,
    pub crc: u32,
    pub seq: u32,
}

/// One live column, as [`Store::columns`] lists them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ColumnInfo {
    pub x: i32,
    pub z: i32,
    pub ord: u32,
    pub mask: u16,
}

/// A column already band-split and encoded, so callers can encode off-thread (a pure function
/// over owned bytes) and hand the result to [`Store::put_encoded_column`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedColumn {
    pub mask: u16,
    pub codec: Codec,
    pub payload: Vec<u8>,
}

impl EncodedColumn {
    /// Band-splits a full-stride column (`bands × 8,192` bytes; canonical — no all-zero band is
    /// stored, paint-only bands are) and encodes it. Mask 0 → codec 0 and an empty payload.
    pub fn encode(column: &[u8], bands: usize, codec: Codec, codecs: &mut Codecs) -> Result<EncodedColumn> {
        if column.len() != bands * BAND {
            return Err(Error::Invalid(format!("a column is {} bytes, got {}", bands * BAND, column.len())));
        }
        let mut raw = Vec::new();
        let mask = split_bands(column, bands, &mut raw);
        let mut payload = Vec::new();
        let codec = codecs.encode(codec, &raw, true, &mut payload).map_err(Error::Codec)?;
        Ok(EncodedColumn { mask, codec, payload })
    }
}

/// Compaction's floor: `should_compact` needs more dead bytes than this *and* than half the file.
pub const COMPACT_MIN_DEAD_BYTES: u64 = 4 << 20;

// ---- internals ------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct CommitFields {
    seq: u32,
    count: u32,
    crc_of_crcs: u32,
    prev: u64,
}

/// A framed record (scan output).
#[derive(Clone, Copy, Debug)]
struct Rec {
    off: u64,
    end: u64,
    aux: u32,
    plen: u32,
    seq: u32,
    crc: u32,
    x: i32,
    z: i32,
    mask: u16,
    rtype: u8,
    codec: u8,
    pad_ok: bool,
    /// Set iff this record is a well-formed COMMIT (spec: a COMMIT has codec 0, a 24-byte payload,
    /// `aux` 24, mask/x/z 0, a payload seq equal to the header's and a zero reserved field).
    commit: Option<CommitFields>,
}

/// An applied record (history), newest last per key.
#[derive(Clone, Copy, Debug)]
struct Entry {
    off: u64,
    aux: u32,
    plen: u32,
    x: i32,
    z: i32,
    /// The previous applied version of the same key.
    prev: Option<u32>,
    mask: u16,
    rtype: u8,
    codec: u8,
}

/// A damaged span `[p, q)` (scan output).
type Span = (u64, u64);

/// A record of the open batch: where it sits in `batch` and what its header says.
#[derive(Clone, Copy, Debug)]
struct Pending {
    rel: u64,
    rtype: u8,
    codec: u8,
    mask: u16,
    x: i32,
    z: i32,
    aux: u32,
    plen: u32,
    crc: u32,
}

const NO_TYPE: Option<u32> = None;

pub struct Store {
    file: Option<File>,
    /// The file actually open (`<final>.creating` while a new world has no commit yet).
    path: PathBuf,
    /// `Some(final path)` between [`Store::create`] and its first commit.
    creating: Option<PathBuf>,
    writable: bool,
    check_crc: bool,
    bands: u16,
    created_unix: u64,
    size: u64,
    entries: Vec<Entry>,
    columns: HashMap<(i32, i32), u32>,
    latest: [Option<u32>; 256],
    damage: Vec<String>,
    warnings: Vec<String>,
    torn: bool,
    tail_bytes: u64,
    truncate_at: u64,
    last_commit: Option<CommitRef>,
    live_record_bytes: u64,
    codec: Codec,
    codecs: Codecs,
    batch: Vec<u8>,
    pending: Vec<Pending>,
    crash_after: Option<(usize, bool)>,
}

impl fmt::Debug for Store {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Store")
            .field("path", &self.path)
            .field("bands", &self.bands)
            .field("columns", &self.columns.len())
            .field("last_commit", &self.last_commit)
            .field("damaged", &self.damaged())
            .finish_non_exhaustive()
    }
}

/// `mask` sets a band bit ≥ `bands` (widened: `u16 >> 16` would overflow for a 256z world).
fn bits_above(mask: u16, bands: u16) -> bool {
    (mask as u32) >> bands != 0
}

fn col_key_sort(a: &Entry, b: &Entry) -> std::cmp::Ordering {
    (a.aux, a.x, a.z).cmp(&(b.aux, b.x, b.z))
}

impl Store {
    fn empty(path: PathBuf, writable: bool, check_crc: bool) -> Store {
        Store {
            file: None,
            path,
            creating: None,
            writable,
            check_crc,
            bands: 0,
            created_unix: 0,
            size: 0,
            entries: Vec::new(),
            columns: HashMap::new(),
            latest: [NO_TYPE; 256],
            damage: Vec::new(),
            warnings: Vec::new(),
            torn: false,
            tail_bytes: 0,
            truncate_at: FILE_HEADER_LEN,
            last_commit: None,
            live_record_bytes: 0,
            codec: Codec::Zstd,
            codecs: Codecs::new(),
            batch: Vec::new(),
            pending: Vec::new(),
            crash_after: None,
        }
    }

    // =========================================================================================
    // opening (spec § Reading (normative))
    // =========================================================================================

    /// Opens read-only with full CRC checking.
    pub fn open(path: impl AsRef<Path>) -> Result<Store> {
        Store::open_with(path, OpenOptions::default())
    }

    /// Opens read-write with full CRC checking.
    pub fn open_rw(path: impl AsRef<Path>) -> Result<Store> {
        Store::open_with(path, OpenOptions { writable: true, ..OpenOptions::default() })
    }

    /// Opens and scans per the spec's reading rules. `Err(Refused)` when the file must be refused:
    /// a bad file header or no valid commit. A torn last batch or an uncommitted tail opens
    /// normally ([`Store::torn`], [`Store::tail_bytes`]); damage opens too ([`Store::damaged`]).
    pub fn open_with(path: impl AsRef<Path>, opts: OpenOptions) -> Result<Store> {
        if opts.writable && opts.len_limit.is_some() {
            return Err(Error::Invalid("a length-limited open is read-only".into()));
        }
        let path = path.as_ref().to_path_buf();
        let file = fs::OpenOptions::new().read(true).write(opts.writable).open(&path)?;
        let mut s = Store::empty(path, opts.writable, opts.check_crc);
        s.size = file.metadata()?.len().min(opts.len_limit.unwrap_or(u64::MAX));
        s.file = Some(file);
        // 1. File header
        let mut h = [0u8; FILE_HEADER_LEN as usize];
        if s.size < FILE_HEADER_LEN {
            return Err(Error::Refused("file shorter than the 64-byte file header".into()));
        }
        read_exact_at(s.f(), 0, &mut h)?;
        let (bands, created) = parse_file_header(&h, opts.check_crc).map_err(Error::Refused)?;
        s.bands = bands;
        s.created_unix = created;
        // 2–6. Scan, commits, apply, tail, truncation point
        let (recs, spans) = s.scan()?;
        s.evaluate(&recs, &spans);
        // 7. No valid commit: the file holds no world
        if s.last_commit.is_none() && !s.torn {
            return Err(Error::Refused("no committed batch".into()));
        }
        Ok(s)
    }

    /// A brand-new world: writes the 64-byte file header to `<path>.creating`. The first
    /// [`Store::commit`] (which must carry `WORLD_HEADER` and `CREATURES`) fsyncs and renames it
    /// to `path`, so a world never appears under its name without a committed batch.
    pub fn create(path: impl AsRef<Path>, bands: u16, created_unix: u64) -> Result<Store> {
        if bands != 4 && bands != 16 {
            return Err(Error::Invalid("bands must be 4 or 16".into()));
        }
        let final_path = path.as_ref().to_path_buf();
        let tmp = with_suffix(&final_path, ".creating");
        let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&tmp)?;
        if let Err(e) = write_all_at(&file, 0, &file_header(bands, created_unix)) {
            drop(file);
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        let mut s = Store::empty(tmp, true, true);
        s.file = Some(file);
        s.creating = Some(final_path);
        s.bands = bands;
        s.created_unix = created_unix;
        s.size = FILE_HEADER_LEN;
        Ok(s)
    }

    fn f(&self) -> &File {
        self.file.as_ref().expect("store is open")
    }

    /// Framing (step 2): the tag matches, `payload_len` ≤ 16 MiB, the record plus its padding lies
    /// within the file, and the CRC matches.
    fn frame(&self, p: u64, buf: &mut Vec<u8>) -> io::Result<Option<Rec>> {
        if p + RECORD_HEADER_LEN > self.size {
            return Ok(None);
        }
        let mut h = [0u8; RECORD_HEADER_LEN as usize];
        read_exact_at(self.f(), p, &mut h)?;
        if h[0..4] != TAG {
            return Ok(None);
        }
        let plen = rd32(&h[20..]);
        if plen > MAX_PAYLOAD {
            return Ok(None);
        }
        let end = p + record_size(plen);
        if end > self.size {
            return Ok(None);
        }
        let padn = (end - p - RECORD_HEADER_LEN - plen as u64) as usize;
        buf.resize(plen as usize + padn, 0);
        read_exact_at(self.f(), p + RECORD_HEADER_LEN, buf)?;
        let crc = rd32(&h[28..]);
        if self.check_crc && crc32_update(crc32(&h[..28]), &buf[..plen as usize]) != crc {
            return Ok(None);
        }
        let mut r = Rec {
            off: p,
            end,
            rtype: h[4],
            codec: h[5],
            mask: rd16(&h[6..]),
            x: rd32(&h[8..]) as i32,
            z: rd32(&h[12..]) as i32,
            aux: rd32(&h[16..]),
            plen,
            seq: rd32(&h[24..]),
            crc,
            pad_ok: all_zero(&buf[plen as usize..]),
            commit: None,
        };
        if r.rtype == RecordType::Commit as u8
            && r.codec == Codec::None as u8
            && r.plen == COMMIT_LEN as u32
            && r.aux == COMMIT_LEN as u32
            && r.mask == 0
            && r.x == 0
            && r.z == 0
        {
            let c = &buf[..COMMIT_LEN];
            let f = CommitFields { seq: rd32(c), count: rd32(&c[4..]), crc_of_crcs: rd32(&c[8..]), prev: rd64(&c[16..]) };
            if f.seq == r.seq && rd32(&c[12..]) == 0 {
                r.commit = Some(f);
            }
        }
        Ok(Some(r))
    }

    /// Step 2: frame from offset 64; on failure `[p, q)` is a damaged span, `q` being the next
    /// 8-aligned offset at which a record frames, or EOF.
    fn scan(&self) -> io::Result<(Vec<Rec>, Vec<Span>)> {
        let mut recs = Vec::new();
        let mut spans = Vec::new();
        let mut buf = Vec::new();
        let mut win = Vec::new();
        let mut p = FILE_HEADER_LEN;
        while p < self.size {
            if let Some(r) = self.frame(p, &mut buf)? {
                recs.push(r);
                p = r.end;
                continue;
            }
            const W: u64 = 1 << 16;
            let (mut q, mut found) = (p + 8, self.size);
            while q + 4 <= self.size && found == self.size {
                let n = W.min(self.size - q) as usize;
                win.resize(n, 0);
                read_exact_at(self.f(), q, &mut win)?;
                let mut i = 0usize;
                while i + 4 <= n {
                    if win[i..i + 4] == TAG && self.frame(q + i as u64, &mut buf)?.is_some() {
                        found = q + i as u64;
                        break;
                    }
                    i += 8;
                }
                if found == self.size {
                    q += i as u64;
                }
            }
            spans.push((p, found));
            p = found;
        }
        Ok((recs, spans))
    }

    /// Steps 3–6, exactly as `emod.py` `Store._evaluate` / `EdenWorldStore::evaluate`.
    fn evaluate(&mut self, recs: &[Rec], spans: &[Span]) {
        let commits: Vec<(usize, CommitFields)> =
            recs.iter().enumerate().filter_map(|(i, r)| r.commit.map(|f| (i, f))).collect();
        let mut prev: Option<(u64, u32)> = None; // (offset, seq) of C_{k-1}
        let mut prev_end = FILE_HEADER_LEN;
        let (mut ri, mut si) = (0usize, 0usize);
        for (k, &(ci, f)) in commits.iter().enumerate() {
            let c = recs[ci];
            let last = k + 1 == commits.len();
            // R_k = [end of C_{k-1}, start of C_k): Batch(C_k) has seq S_k, the rest are orphans
            while ri < recs.len() && recs[ri].off < prev_end {
                ri += 1;
            }
            let (mut batch, mut orph) = (Vec::new(), Vec::new());
            while ri < recs.len() && recs[ri].off < c.off {
                if recs[ri].seq == f.seq { batch.push(ri) } else { orph.push(ri) }
                ri += 1;
            }
            while si < spans.len() && spans[si].0 < prev_end {
                si += 1;
            }
            let mut nspans = 0usize;
            while si < spans.len() && spans[si].0 < c.off {
                nspans += 1;
                si += 1;
            }
            // Batch check: |Batch| = count; crc_of_crcs; prev_commit names C_{k-1} (0 for k = 1) or
            // lies inside R_k (the commit it names was destroyed — its batch shows as orphans/spans).
            let prev_ok = f.prev == prev.map_or(0, |p| p.0)
                || (prev_end <= f.prev && f.prev < c.off && (!orph.is_empty() || nspans > 0));
            let mut ok = batch.len() == f.count as usize && prev_ok;
            if ok && self.check_crc {
                ok = crc_of_crcs(batch.iter().map(|&i| recs[i].crc)) == f.crc_of_crcs;
            }
            let gap = prev.is_some_and(|p| f.seq != p.1.wrapping_add(1));
            if !orph.is_empty() || (nspans > 0 && ok) || gap {
                self.damage.push(format!(
                    "batch seq {} (commit @{}): {} orphan records, {} damaged spans{}",
                    f.seq,
                    c.off,
                    orph.len(),
                    nspans,
                    if gap { ", seq gap" } else { "" }
                ));
            }
            if ok || !last {
                if !ok {
                    // fsync ordering: this batch was complete before C_{k+1} was written, so a
                    // failure here is media damage, not a tear — apply its intact records.
                    self.damage.push(format!(
                        "batch seq {} (commit @{}) fails its commit check; applying its {} intact records",
                        f.seq,
                        c.off,
                        batch.len()
                    ));
                }
                // earlier orphans (seq < S_k) + the batch, in file order
                let mut apply: Vec<usize> =
                    orph.iter().copied().filter(|&i| recs[i].seq < f.seq).chain(batch.iter().copied()).collect();
                apply.sort_unstable_by_key(|&i| recs[i].off);
                for i in apply {
                    self.apply(&recs[i]);
                }
                self.truncate_at = c.end;
                self.last_commit = Some(CommitRef { offset: c.off, crc: c.crc, seq: f.seq });
            } else {
                // the last batch is torn: discarded; the world is the state at C_{m-1} (+ orphans)
                self.torn = true;
                let mut t = prev_end;
                for &i in &orph {
                    if recs[i].seq < f.seq {
                        self.apply(&recs[i]);
                        t = t.max(recs[i].end);
                    }
                }
                self.truncate_at = t;
                self.warnings.push(format!(
                    "last batch seq {} (commit @{}) is torn: {} of {} records present -- rolled back",
                    f.seq,
                    c.off,
                    batch.len(),
                    f.count
                ));
            }
            prev = Some((c.off, f.seq));
            prev_end = c.end;
        }
        let end = commits.last().map_or(FILE_HEADER_LEN, |&(i, _)| recs[i].end);
        self.tail_bytes = self.size - end;
        for r in recs {
            if !r.pad_ok && r.off < end {
                self.damage.push(format!("non-zero padding after record @{}", r.off));
            }
            // 0 and 10–255 (INDEX is a known, never-written type: ignored without a report)
            if RecordType::from_u8(r.rtype).is_none() && r.off < self.truncate_at {
                self.warnings.push(format!("record @{} has reserved type {}", r.off, r.rtype));
            }
        }
    }

    fn apply(&mut self, r: &Rec) {
        let idx = self.entries.len() as u32;
        let mut e = Entry {
            off: r.off,
            aux: r.aux,
            plen: r.plen,
            x: r.x,
            z: r.z,
            prev: None,
            mask: r.mask,
            rtype: r.rtype,
            codec: r.codec,
        };
        let slot = if r.rtype == RecordType::Column as u8 {
            self.columns.insert((r.x, r.z), idx)
        } else {
            self.latest[r.rtype as usize].replace(idx)
        };
        if let Some(p) = slot {
            e.prev = Some(p);
            self.live_record_bytes -= record_size(self.entries[p as usize].plen);
        }
        self.live_record_bytes += record_size(r.plen);
        self.entries.push(e);
    }

    // =========================================================================================
    // state
    // =========================================================================================

    pub fn path(&self) -> &Path {
        self.creating.as_deref().unwrap_or(&self.path)
    }
    pub fn bands(&self) -> u16 {
        self.bands
    }
    /// Bytes per full-stride column (`bands × 8,192`).
    pub fn column_len(&self) -> usize {
        self.bands as usize * BAND
    }
    pub fn created_unix(&self) -> u64 {
        self.created_unix
    }
    pub fn file_size(&self) -> u64 {
        self.size
    }
    pub fn is_writable(&self) -> bool {
        self.writable && self.file.is_some()
    }
    pub fn last_seq(&self) -> u32 {
        self.last_commit.map_or(0, |c| c.seq)
    }
    /// The last applied COMMIT (`None` only for a store whose every batch is torn or not yet
    /// written).
    pub fn last_commit(&self) -> Option<CommitRef> {
        self.last_commit
    }
    /// The spec's per-session damaged flag: media damage inside committed data, or a live record
    /// that failed to decode. Blocks compaction. A torn last batch or a tail is **not** damage.
    pub fn damaged(&self) -> bool {
        !self.damage.is_empty()
    }
    pub fn damage(&self) -> &[String] {
        &self.damage
    }
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }
    /// The last batch was torn (and rolled back). A normal crash outcome.
    pub fn torn(&self) -> bool {
        self.torn
    }
    /// Bytes after the last framed COMMIT: a save that never reached its commit.
    pub fn tail_bytes(&self) -> u64 {
        self.tail_bytes
    }
    /// Where the next append starts (step 6); the writer truncates to it first.
    pub fn truncation_point(&self) -> u64 {
        self.truncate_at
    }

    /// The codec new records are encoded with (default zstd).
    pub fn set_codec(&mut self, codec: Codec) {
        self.codec = codec;
    }
    pub fn codec(&self) -> Codec {
        self.codec
    }

    // ---- live view ----

    pub fn column_count(&self) -> usize {
        self.columns.len()
    }

    /// Every live column, in ord order (ties — never present in a valid file — by key).
    pub fn columns(&self) -> Vec<ColumnInfo> {
        let mut v: Vec<&Entry> = self.columns.values().map(|&i| &self.entries[i as usize]).collect();
        v.sort_by(|a, b| col_key_sort(a, b));
        v.into_iter().map(|e| ColumnInfo { x: e.x, z: e.z, ord: e.aux, mask: e.mask }).collect()
    }

    /// Live keys in ord order.
    pub fn column_keys(&self) -> Vec<(i32, i32)> {
        self.columns().into_iter().map(|c| (c.x, c.z)).collect()
    }

    pub fn has_column(&self, x: i32, z: i32) -> bool {
        self.columns.contains_key(&(x, z))
    }

    /// The mask of the newest committed version (what `SUMMARY` counts); 0 if absent.
    pub fn column_mask(&self, x: i32, z: i32) -> u16 {
        self.columns.get(&(x, z)).map_or(0, |&i| self.entries[i as usize].mask)
    }

    pub fn column_ord(&self, x: i32, z: i32) -> Option<u32> {
        self.columns.get(&(x, z)).map(|&i| self.entries[i as usize].aux)
    }

    pub fn has_record(&self, t: RecordType) -> bool {
        self.latest[t as usize].is_some()
    }

    /// Decodes applied entry `i` into `out`. `Ok(false)` = it doesn't decode.
    fn decode_entry(&mut self, i: u32, out: &mut Vec<u8>) -> io::Result<bool> {
        let e = self.entries[i as usize];
        let expect = if e.rtype == RecordType::Column as u8 {
            e.mask.count_ones() as usize * BAND
        } else {
            e.aux as usize
        };
        if expect > MAX_PAYLOAD as usize * 64 {
            return Ok(false);
        }
        let mut raw = vec![0u8; e.plen as usize];
        read_exact_at(self.f(), e.off + RECORD_HEADER_LEN, &mut raw)?;
        out.clear();
        out.resize(expect, 0);
        Ok(self.codecs.decode(e.codec, &raw, out))
    }

    /// The newest decodable version along entry `i`'s history: `(entry, versions back)`.
    fn decode_newest(&mut self, i: u32, out: &mut Vec<u8>) -> io::Result<Option<(u32, usize)>> {
        let (mut cur, mut back) = (Some(i), 0usize);
        while let Some(j) = cur {
            if self.decode_entry(j, out)? {
                return Ok(Some((j, back)));
            }
            cur = self.entries[j as usize].prev;
            back += 1;
        }
        Ok(None)
    }

    /// Reads column `(x, z)` into `out` (`bands × 8,192` bytes; cleared bands zero). Returns the
    /// status and the mask of the version actually used. A decode failure falls back to the
    /// newest earlier applied version, else air ([`ReadStatus::AirDamaged`]); both are damage.
    pub fn read_column(&mut self, x: i32, z: i32, out: &mut [u8]) -> Result<(ReadStatus, u16)> {
        let bands = self.bands as usize;
        if out.len() != bands * BAND {
            return Err(Error::Invalid(format!("read_column: buffer is {} bytes, want {}", out.len(), bands * BAND)));
        }
        let Some(&i) = self.columns.get(&(x, z)) else {
            out.fill(0);
            return Ok((ReadStatus::Absent, 0));
        };
        let mut payload = Vec::new();
        let Some((j, back)) = self.decode_newest(i, &mut payload)? else {
            self.damage.push(format!(
                "COLUMN ({x},{z}) does not decode and has no decodable earlier version: loaded as air"
            ));
            out.fill(0);
            return Ok((ReadStatus::AirDamaged, 0));
        };
        let mask = self.entries[j as usize].mask;
        if bits_above(mask, bands as u16) {
            // a damaged mask that still framed; never write past the buffer
            self.damage.push(format!("COLUMN ({x},{z}) sets band bits >= {bands}"));
            out.fill(0);
            return Ok((ReadStatus::AirDamaged, 0));
        }
        join_bands(mask, &payload, bands, out);
        if back > 0 {
            self.damage.push(format!("COLUMN ({x},{z}) newest version does not decode; used the one {back} back"));
            return Ok((ReadStatus::Fallback, mask));
        }
        Ok((ReadStatus::Ok, mask))
    }

    /// The newest decodable committed version of a singleton (`WORLD_HEADER`, `CREATURES`, …).
    pub fn read_record(&mut self, t: RecordType) -> Result<(ReadStatus, Vec<u8>)> {
        if t == RecordType::Column {
            return Err(Error::Invalid("read_record: use read_column for COLUMN".into()));
        }
        let Some(i) = self.latest[t as usize] else { return Ok((ReadStatus::Absent, Vec::new())) };
        let mut out = Vec::new();
        match self.decode_newest(i, &mut out)? {
            None => {
                self.damage.push(format!("record type {} does not decode in any version", t as u8));
                Ok((ReadStatus::AirDamaged, Vec::new()))
            }
            Some((_, 0)) => Ok((ReadStatus::Ok, out)),
            Some((_, back)) => {
                self.damage
                    .push(format!("record type {} newest version does not decode; used the one {back} back", t as u8));
                Ok((ReadStatus::Fallback, out))
            }
        }
    }

    pub fn summary(&self) -> Summary {
        let mut s = Summary { live_columns: self.columns.len() as u32, ..Summary::default() };
        let mut max: Option<u32> = None;
        for &i in self.columns.values() {
            let e = &self.entries[i as usize];
            s.band_or |= e.mask;
            max = Some(max.map_or(e.aux, |m| m.max(e.aux)));
        }
        s.next_ord = max.map_or(0, |m| m + 1);
        s
    }

    /// Bytes no live record uses (superseded versions, dead records' overhead, orphans, a torn
    /// tail kept below the truncation point): compaction's input. The last COMMIT is live too.
    pub fn dead_bytes(&self) -> u64 {
        let commit = if self.last_commit.is_some() { record_size(COMMIT_LEN as u32) } else { 0 };
        let used = FILE_HEADER_LEN + self.live_record_bytes + commit;
        self.truncate_at.saturating_sub(used)
    }

    /// Emod's policy (`shouldCompact`): dead > max(half the file, 4 MiB). The caller still must
    /// not compact a damaged store ([`Store::compact`] refuses).
    pub fn should_compact(&self) -> bool {
        self.dead_bytes() > (self.truncate_at / 2).max(COMPACT_MIN_DEAD_BYTES)
    }

    // =========================================================================================
    // writing (spec § Batches and commits — writing)
    // =========================================================================================

    fn check_writable(&self) -> Result<()> {
        if self.file.is_none() || !self.writable {
            return Err(Error::Invalid("store is not open for writing".into()));
        }
        Ok(())
    }

    /// Starts a batch (discarding any uncommitted one).
    pub fn begin_batch(&mut self) {
        self.abort_batch();
    }

    /// Drops the open batch; nothing was written.
    pub fn abort_batch(&mut self) {
        self.batch.clear();
        self.pending.clear();
    }

    /// Records in the open batch (SUMMARY and COMMIT are added by [`Store::commit`]).
    pub fn batch_len(&self) -> usize {
        self.pending.len()
    }

    #[allow(clippy::too_many_arguments)]
    fn add_record(&mut self, rtype: u8, codec: Codec, mask: u16, x: i32, z: i32, aux: u32, payload: &[u8]) {
        let rel = self.batch.len() as u64;
        let seq = self.last_seq() + 1;
        let crc = append_record(&mut self.batch, rtype, codec as u8, mask, x, z, aux, seq, payload);
        self.pending.push(Pending { rel, rtype, codec: codec as u8, mask, x, z, aux, plen: payload.len() as u32, crc });
    }

    /// Adds a full-stride column (`bands × 8,192` bytes) to the open batch, encoded with the
    /// store's codec. A rewritten column keeps its ord; a new one takes the next free ord.
    pub fn put_column(&mut self, x: i32, z: i32, column: &[u8]) -> Result<()> {
        self.check_writable()?;
        let enc = EncodedColumn::encode(column, self.bands as usize, self.codec, &mut self.codecs)?;
        self.put_encoded_column(x, z, &enc)
    }

    /// Adds an already-encoded column (see [`EncodedColumn::encode`]).
    pub fn put_encoded_column(&mut self, x: i32, z: i32, enc: &EncodedColumn) -> Result<()> {
        self.check_writable()?;
        if !addressable(x, z) {
            return Err(Error::Invalid(format!("column key ({x},{z}) is not addressable")));
        }
        if bits_above(enc.mask, self.bands) {
            return Err(Error::Invalid(format!("column ({x},{z}) sets band bits >= {}", self.bands)));
        }
        if enc.mask == 0 && (enc.codec != Codec::None || !enc.payload.is_empty()) {
            return Err(Error::Invalid(format!("column ({x},{z}): mask 0 needs codec 0 and an empty payload")));
        }
        if enc.payload.len() > MAX_PAYLOAD as usize {
            return Err(Error::Codec("column payload exceeds 16 MiB".into()));
        }
        // ord: an existing column keeps its ord (also when rewritten earlier in this batch); a new
        // one takes next_ord, past any new ord this batch already handed out.
        let col = RecordType::Column as u8;
        let ord = match self.columns.get(&(x, z)) {
            Some(&i) => self.entries[i as usize].aux,
            None => match self.pending.iter().rev().find(|p| p.rtype == col && p.x == x && p.z == z) {
                Some(p) => p.aux,
                None => {
                    let base = self.summary().next_ord;
                    self.pending.iter().filter(|p| p.rtype == col).fold(base, |o, p| o.max(p.aux + 1))
                }
            },
        };
        self.add_record(col, enc.codec, enc.mask, x, z, ord, &enc.payload);
        Ok(())
    }

    /// Adds a singleton record. `WORLD_HEADER` (192 B) and `GENERATOR` (28 B) are stored raw
    /// (codec 0, as the spec requires); the rest with the store's codec. `COLUMN`, `SUMMARY` and
    /// `COMMIT` are written by [`Store::put_column`] / [`Store::commit`]; `INDEX` is reserved.
    pub fn put_record(&mut self, t: RecordType, data: &[u8]) -> Result<()> {
        self.check_writable()?;
        let n = data.len();
        let bad = |m: &str| Err(Error::Invalid(m.into()));
        match t {
            RecordType::Column | RecordType::Summary | RecordType::Commit | RecordType::Index => {
                return bad("put_record: COLUMN/SUMMARY/COMMIT are written by put_column/commit; INDEX is reserved")
            }
            RecordType::WorldHeader if n != EDEN_HEADER_LEN => return bad("WORLD_HEADER must be 192 bytes"),
            RecordType::Creatures if !n.is_multiple_of(CREATURE_LEN) || n / CREATURE_LEN > MAX_CREATURE_SLOTS => {
                return bad("CREATURES must be 0-400 x 60 bytes")
            }
            RecordType::SignTrailer if !n.is_multiple_of(EDEN_DIR_ROW) || n > TRAILER_MAX => {
                return bad("SIGN_TRAILER must be a multiple of 16, <= 1 MiB")
            }
            RecordType::Generator if n != GENERATOR_LEN => return bad("GENERATOR must be 28 bytes"),
            _ => {}
        }
        let raw = matches!(t, RecordType::WorldHeader | RecordType::Generator);
        let mut enc = Vec::new();
        let codec = self.codecs.encode(self.codec, data, !raw, &mut enc).map_err(Error::Codec)?;
        if enc.len() > MAX_PAYLOAD as usize {
            return Err(Error::Codec("record payload exceeds 16 MiB".into()));
        }
        self.add_record(t as u8, codec, 0, 0, 0, n as u32, &enc);
        Ok(())
    }

    /// Commits the open batch: adds `SUMMARY` (exact for the live state after the batch) and
    /// `COMMIT`, truncates any uncommitted or torn tail (never below an applied commit), writes the
    /// batch in **one** write, and fsyncs. On failure the file is truncated back to the last
    /// commit and the in-memory state is unchanged (the caller keeps its dirty flags).
    pub fn commit(&mut self) -> Result<()> {
        self.check_writable()?;
        if self.creating.is_some() {
            let has = |t: RecordType| self.pending.iter().any(|p| p.rtype == t as u8);
            if !has(RecordType::WorldHeader) || !has(RecordType::Creatures) {
                return Err(Error::Invalid("a world's first batch must carry WORLD_HEADER and CREATURES".into()));
            }
        }
        // SUMMARY for the live state after this batch
        let col = RecordType::Column as u8;
        let mut over: HashMap<(i32, i32), (u32, u16)> = HashMap::new();
        for p in self.pending.iter().filter(|p| p.rtype == col) {
            over.insert((p.x, p.z), (p.aux, p.mask));
        }
        let mut live = self.columns.len() as u32;
        let (mut band_or, mut max) = (0u16, None::<u32>);
        for (k, &i) in &self.columns {
            if over.contains_key(k) {
                continue;
            }
            let e = &self.entries[i as usize];
            band_or |= e.mask;
            max = Some(max.map_or(e.aux, |m| m.max(e.aux)));
        }
        for (k, &(ord, mask)) in &over {
            if !self.columns.contains_key(k) {
                live += 1;
            }
            band_or |= mask;
            max = Some(max.map_or(ord, |m| m.max(ord)));
        }
        let sp = summary_payload(live, max.map_or(0, |m| m + 1), band_or);
        self.add_record(RecordType::Summary as u8, Codec::None, 0, 0, 0, SUMMARY_LEN as u32, &sp);
        let seq = self.last_seq() + 1;
        let cc = crc_of_crcs(self.pending.iter().map(|p| p.crc));
        let cp = commit_payload(seq, self.pending.len() as u32, cc, self.last_commit.map_or(0, |c| c.offset));
        let commit_rel = self.batch.len() as u64;
        let commit_crc =
            append_record(&mut self.batch, RecordType::Commit as u8, 0, 0, 0, 0, COMMIT_LEN as u32, seq, &cp);

        let base = self.truncate_at;
        // Before appending, drop any uncommitted or torn tail.
        if self.size != base {
            if let Err(e) = self.f().set_len(base) {
                self.abort_batch();
                return Err(e.into());
            }
            self.size = base;
        }
        if let Some((k, zero_fill)) = self.crash_after.filter(|&(k, _)| k < self.batch.len()) {
            // the crash-injection gate: the process dies after `k` bytes of the batch reached the
            // file (optionally with the rest zero-filled: the size persisted, the data did not)
            let mut b = self.batch[..k].to_vec();
            if zero_fill {
                b.resize(self.batch.len(), 0);
            }
            let _ = write_all_at(self.f(), base, &b);
            self.file = None;
            self.abort_batch();
            return Err(Error::TestCrash);
        }
        let w = write_all_at(self.f(), base, &self.batch).and_then(|_| self.f().sync_all());
        if let Err(e) = w {
            // ENOSPC or an I/O error: back to the last commit, state unchanged
            let _ = self.f().set_len(base);
            self.size = self.f().metadata().map_or(base, |m| m.len());
            self.abort_batch();
            return Err(e.into());
        }
        self.size = base + self.batch.len() as u64;
        let pending = std::mem::take(&mut self.pending);
        for p in &pending {
            let off = base + p.rel;
            self.apply(&Rec {
                off,
                end: off + record_size(p.plen),
                aux: p.aux,
                plen: p.plen,
                seq,
                crc: p.crc,
                x: p.x,
                z: p.z,
                mask: p.mask,
                rtype: p.rtype,
                codec: p.codec,
                pad_ok: true,
                commit: None,
            });
        }
        self.last_commit = Some(CommitRef { offset: base + commit_rel, crc: commit_crc, seq });
        self.truncate_at = self.size;
        self.tail_bytes = 0;
        self.torn = false;
        self.abort_batch();
        if let Some(final_path) = self.creating.take() {
            self.file = None;
            replace_file(&self.path, &final_path)?;
            self.path = final_path;
            self.file = Some(fs::OpenOptions::new().read(true).write(true).open(&self.path)?);
        }
        Ok(())
    }

    // =========================================================================================
    // compaction
    // =========================================================================================

    /// Rewrites the live state as one batch (seq 1) into `<path>.compact`, fsyncs, renames it over
    /// `path` and reopens. Same `bands` and `created_unix`; ords kept (possibly sparse). Order:
    /// `WORLD_HEADER`, `CREATURES`, a non-empty `SIGN_TRAILER`, `PROVENANCE`, `GENERATOR`,
    /// `COLUMN`s by ord, `SUMMARY`, `COMMIT` — conversion's order, so compacting a fresh conversion
    /// reproduces it byte for byte. zstd payloads are copied verbatim after they decode; anything
    /// else is re-encoded with the store's codec. Reserved types are dropped. Refused while
    /// damaged, read-only, mid-batch or before the first commit.
    pub fn compact(&mut self) -> Result<()> {
        self.check_writable()?;
        if self.creating.is_some() || self.last_commit.is_none() {
            return Err(Error::Invalid("compaction needs a committed store".into()));
        }
        if !self.pending.is_empty() {
            return Err(Error::Invalid("compaction mid-batch".into()));
        }
        if self.damaged() {
            return Err(Error::Damaged("store is damaged: compaction is blocked (export first)".into()));
        }
        let tmp = with_suffix(&self.path, ".compact");
        let res = self.write_compacted(&tmp);
        if let Err(e) = res {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        let (path, codec) = (self.path.clone(), self.codec);
        self.file = None;
        if let Err(e) = replace_file(&tmp, &path) {
            let _ = fs::remove_file(&tmp);
            *self = Store::open_rw(&path)?;
            self.codec = codec;
            return Err(e.into());
        }
        *self = Store::open_rw(&path)?;
        self.codec = codec;
        Ok(())
    }

    fn write_compacted(&mut self, tmp: &Path) -> Result<()> {
        let out_file = fs::OpenOptions::new().write(true).create(true).truncate(true).open(tmp)?;
        let mut out: Vec<u8> = Vec::with_capacity(1 << 20);
        out.extend_from_slice(&file_header(self.bands, self.created_unix));
        let mut written = 0u64;
        let mut crcs: Vec<u32> = Vec::new();
        let mut data = Vec::new();
        let mut enc = Vec::new();
        let mut order: Vec<(u32, bool)> = Vec::new(); // (entry, stored raw)
        for t in [
            RecordType::WorldHeader,
            RecordType::Creatures,
            RecordType::SignTrailer,
            RecordType::Provenance,
            RecordType::Generator, // H.4: last of the singletons
        ] {
            let Some(i) = self.latest[t as usize] else { continue };
            if t == RecordType::SignTrailer && self.entries[i as usize].aux == 0 {
                continue; // an empty trailer = none
            }
            order.push((i, matches!(t, RecordType::WorldHeader | RecordType::Generator)));
        }
        let mut cols: Vec<u32> = self.columns.values().copied().collect();
        cols.sort_by(|&a, &b| col_key_sort(&self.entries[a as usize], &self.entries[b as usize]));
        order.extend(cols.into_iter().map(|i| (i, false)));
        for (i, raw) in order {
            let e = self.entries[i as usize];
            // decode to prove it is intact; copy zstd verbatim, re-encode anything else
            if !self.decode_entry(i, &mut data)? {
                self.damage.push(format!("compaction: live record @{} does not decode", e.off));
                return Err(Error::Damaged("compaction found damage; nothing was replaced".into()));
            }
            let codec = if e.codec == Codec::Zstd as u8 || (e.codec == Codec::None as u8 && (raw || data.is_empty())) {
                enc.resize(e.plen as usize, 0);
                read_exact_at(self.f(), e.off + RECORD_HEADER_LEN, &mut enc)?;
                e.codec
            } else {
                self.codecs.encode(self.codec, &data, !raw, &mut enc).map_err(Error::Codec)? as u8
            };
            crcs.push(append_record(&mut out, e.rtype, codec, e.mask, e.x, e.z, e.aux, 1, &enc));
            if out.len() >= 1 << 20 {
                write_all_at(&out_file, written, &out)?;
                written += out.len() as u64;
                out.clear();
            }
        }
        let s = self.summary();
        let sp = summary_payload(s.live_columns, s.next_ord, s.band_or);
        crcs.push(append_record(&mut out, RecordType::Summary as u8, 0, 0, 0, 0, SUMMARY_LEN as u32, 1, &sp));
        let cp = commit_payload(1, crcs.len() as u32, crc_of_crcs(crcs.iter().copied()), 0);
        append_record(&mut out, RecordType::Commit as u8, 0, 0, 0, 0, COMMIT_LEN as u32, 1, &cp);
        write_all_at(&out_file, written, &out)?;
        out_file.sync_all()?;
        Ok(())
    }

    // =========================================================================================
    // verify + state digest (emod.py Store.verify / state_digest_store)
    // =========================================================================================

    /// The full semantic check `emod.py verify` makes: every live record decodes, the invariants
    /// of a live state hold, `SUMMARY` is exact. Returns damage + errors (empty == clean). Marks
    /// the store damaged when it finds a live record that does not decode.
    pub fn verify(&mut self) -> Result<Vec<String>> {
        let mut errs: Vec<String> = Vec::new();
        let mut decode_damage: Vec<String> = Vec::new();
        let mut d = Vec::new();
        for w in &self.warnings {
            if w.contains("has reserved type") {
                errs.push(w.clone()); // spec: a reserved type is ignored on read, `verify` reports it
            }
        }
        match self.latest[RecordType::WorldHeader as usize] {
            None => errs.push("no WORLD_HEADER".into()),
            Some(i) => {
                if !self.decode_entry(i, &mut d)? {
                    errs.push("WORLD_HEADER does not decode".into());
                } else if d.len() != EDEN_HEADER_LEN {
                    errs.push(format!("WORLD_HEADER is {} B", d.len()));
                } else {
                    // S.3b: v5/6 ⇒ 16 bands, but not the converse (the 2026 game writes v2 256z worlds)
                    let v = rd32(&d[92..]) as i32;
                    if !(1..=6).contains(&v) || (v >= 5 && self.bands != 16) {
                        errs.push(format!("WORLD_HEADER version {v} does not match bands={}", self.bands));
                    }
                }
                if self.entries[i as usize].codec != Codec::None as u8 {
                    errs.push("WORLD_HEADER must be codec 0".into());
                }
            }
        }
        let aux_of = |s: &Store, t: RecordType| s.latest[t as usize].map(|i| s.entries[i as usize].aux as usize);
        match aux_of(self, RecordType::Creatures) {
            None => errs.push("no CREATURES".into()),
            Some(n) if !n.is_multiple_of(CREATURE_LEN) || n / CREATURE_LEN > MAX_CREATURE_SLOTS => {
                errs.push(format!("CREATURES raw length {n} is not 0..400 slots of 60 B"))
            }
            _ => {}
        }
        if let Some(n) = aux_of(self, RecordType::SignTrailer) {
            if !n.is_multiple_of(EDEN_DIR_ROW) || n > TRAILER_MAX {
                errs.push(format!("SIGN_TRAILER raw length {n} is not a multiple of 16 up to 1 MiB"));
            }
        }
        if let Some(n) = aux_of(self, RecordType::Generator) {
            if n != GENERATOR_LEN {
                errs.push(format!("GENERATOR raw length {n} is not {GENERATOR_LEN}"));
            }
        }
        for t in [
            RecordType::Creatures,
            RecordType::SignTrailer,
            RecordType::Provenance,
            RecordType::Summary,
            RecordType::Generator,
        ] {
            let Some(i) = self.latest[t as usize] else { continue };
            let e = self.entries[i as usize];
            if e.mask != 0 || e.x != 0 || e.z != 0 {
                errs.push(format!("record type {}: band_mask/x/z must be 0", t as u8));
            }
            match self.decode_newest(i, &mut d)? {
                None => decode_damage.push(format!("record type {} does not decode", t as u8)),
                Some((_, back)) if back > 0 => {
                    decode_damage.push(format!("record type {} does not decode; {back} versions back does", t as u8))
                }
                Some(_) => {
                    if t == RecordType::Provenance && !provenance_parses(&d) {
                        errs.push("PROVENANCE does not parse".into());
                    }
                }
            }
        }
        let mut ords: HashMap<u32, (i32, i32)> = HashMap::new();
        let (mut band_or, mut max) = (0u16, None::<u32>);
        let mut live: Vec<u32> = self.columns.values().copied().collect();
        live.sort_by(|&a, &b| col_key_sort(&self.entries[a as usize], &self.entries[b as usize]));
        for i in live {
            let e = self.entries[i as usize];
            let (x, z) = (e.x, e.z);
            if !addressable(x, z) {
                errs.push(format!("COLUMN has an unaddressable key ({x},{z})"));
            }
            if bits_above(e.mask, self.bands) {
                errs.push(format!("COLUMN ({x},{z}) sets band bits >= {}", self.bands));
            }
            if e.mask == 0 && (e.codec != Codec::None as u8 || e.plen != 0) {
                errs.push(format!("COLUMN ({x},{z}): empty mask needs codec 0 and no payload"));
            }
            if let Some(o) = ords.insert(e.aux, (x, z)) {
                errs.push(format!("COLUMN ({x},{z}) and ({},{}) share ord {}", o.0, o.1, e.aux));
            }
            band_or |= e.mask;
            max = Some(max.map_or(e.aux, |m| m.max(e.aux)));
            match self.decode_newest(i, &mut d)? {
                None => decode_damage.push(format!("COLUMN ({x},{z}) does not decode and has no earlier version")),
                Some((_, back)) if back > 0 => {
                    decode_damage.push(format!("COLUMN ({x},{z}) does not decode; fell back {back} version(s)"))
                }
                Some(_) => {
                    let stored = (0..self.bands).filter(|b| e.mask >> b & 1 != 0);
                    for (k, b) in stored.enumerate() {
                        if all_zero(&d[k * BAND..(k + 1) * BAND]) {
                            self.warnings.push(format!("COLUMN ({x},{z}): band {b} stored but all zero (non-canonical)"));
                        }
                    }
                }
            }
        }
        match self.latest[RecordType::Summary as usize] {
            None if !self.columns.is_empty() => errs.push("no SUMMARY".into()),
            None => {}
            Some(i) => {
                if !self.decode_entry(i, &mut d)? || d.len() != SUMMARY_LEN {
                    errs.push("SUMMARY does not decode".into());
                } else {
                    let (lc, no, bo) = (rd32(&d), rd32(&d[4..]), rd16(&d[8..]));
                    let want = (self.columns.len() as u32, max.map_or(0, |m| m + 1), band_or);
                    if (lc, no, bo) != want || rd16(&d[10..]) != 0 || rd32(&d[12..]) != 0 {
                        errs.push(format!(
                            "SUMMARY (live={lc} next_ord={no} band_or={bo:#x}) != the live state (live={} next_ord={} band_or={:#x})",
                            want.0, want.1, want.2
                        ));
                    }
                }
            }
        }
        for m in &decode_damage {
            if !self.damage.contains(m) {
                self.damage.push(m.clone());
            }
        }
        let mut all = self.damage.clone();
        for e in errs {
            if !all.contains(&e) {
                all.push(e);
            }
        }
        Ok(all)
    }

    /// SHA-256 of the live state, hex — identical to `emod.py digest` (`state_digest_store`):
    /// the decoded `WORLD_HEADER`, `CREATURES`, `SIGN_TRAILER` (`-` for an absent one), then per
    /// column in key order `i32 x, i32 z, u16 mask` and the decoded band payload.
    /// `Err(Damaged)` when a live record doesn't decode.
    pub fn state_digest(&mut self) -> Result<String> {
        let mut h = Sha256::new();
        let mut d = Vec::new();
        let undecodable = || Error::Damaged("undecodable".into());
        for t in [RecordType::WorldHeader, RecordType::Creatures, RecordType::SignTrailer] {
            match self.latest[t as usize] {
                None => h.update(b"-"),
                Some(i) => {
                    if !self.decode_entry(i, &mut d)? {
                        return Err(undecodable());
                    }
                    h.update(&d);
                }
            }
        }
        let mut cols: Vec<((i32, i32), u32)> = self.columns.iter().map(|(&k, &i)| (k, i)).collect();
        cols.sort_unstable();
        for ((x, z), i) in cols {
            let mask = self.entries[i as usize].mask;
            h.update(x.to_le_bytes());
            h.update(z.to_le_bytes());
            h.update(mask.to_le_bytes());
            if !self.decode_entry(i, &mut d)? {
                return Err(undecodable());
            }
            h.update(&d);
        }
        Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
    }

    // =========================================================================================
    // test hooks
    // =========================================================================================

    /// **Test hook (the crash-injection gate), not for app code.** The next [`Store::commit`]
    /// writes only the first `after` bytes of its batch (with `zero_fill`, then zeros up to the
    /// batch's full length — a filesystem that persisted the size but not the data), closes the
    /// file without truncating back and returns [`Error::TestCrash`]: a process killed mid-write.
    /// `None` disables it; `after ≥` the batch length is not a crash.
    #[doc(hidden)]
    pub fn set_test_crash(&mut self, crash: Option<(usize, bool)>) {
        self.crash_after = crash;
    }
}

/// `parse_provenance`'s shape check: 76 fixed bytes, then three length-prefixed lists (name bytes,
/// 12-byte short spans, 8-byte directory keys) ending exactly at the end.
fn provenance_parses(d: &[u8]) -> bool {
    let mut o = 76usize;
    if d.len() < o {
        return false;
    }
    for item in [1usize, 12, 8] {
        if o + 4 > d.len() {
            return false;
        }
        let n = rd32(&d[o..]) as usize;
        o += 4;
        match n.checked_mul(item).and_then(|k| o.checked_add(k)) {
            Some(e) if e <= d.len() => o = e,
            _ => return false,
        }
    }
    o == d.len()
}
