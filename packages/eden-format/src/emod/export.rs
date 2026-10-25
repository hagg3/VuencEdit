//! The **own-format** export `.emod` → `.eden` (spec § Export to `.eden`; `emod.py export`).
//!
//! Columns go in ascending ord, the *i*-th at `192 + i × stride`, full stride; then the creature
//! block, one directory row per live column (`PROVENANCE`'s source row order first, then the rest
//! in ord order) and the sign trailer. `directory_offset` (header bytes 32..39) is recomputed, and a
//! live `GENERATOR` is mirrored into the header's `reserved[]` @152 as `EMG1`. When
//! `PROVENANCE.flags` = 0 and nothing was saved since conversion, the output is byte-identical to
//! the source `.eden`.
//!
//! The other three targets (Legacy64z / NewDawn256z / NewFormat256z) are ROADMAP-EDIT 26.3, which
//! is deferred; VuencEdit only needs this one to open an `.emod` (26.4).
//!
//! **Sparse output** ([`ExportOptions::sparse`]): the file is sized with `set_len` and only the
//! occupied bands are written, so absent bands stay holes that read as zeros. That is what lets
//! VuencEdit stage an `.emod` without writing the nominal `.eden` size (a 1 MB `.emod` can be a
//! 266 MB `.eden`). The bytes read back are identical either way.

use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::Path;

use super::container::*;
use super::fsutil::write_all_at;
use super::store::{ReadStatus, Result, Store};
use super::Error;

/// Header offset of the `GENERATOR` mirror (`EMG1` + 28-byte record + CRC-32 = 36 of `reserved[]`'s 40 B).
pub const GEN_MIRROR_OFF: usize = 152;
pub const GEN_MIRROR_MAGIC: [u8; 4] = *b"EMG1";
/// `directory_offset` inside the 192-byte `.eden` header.
const DIR_OFF_FIELD: usize = 32;

#[derive(Clone, Copy, Debug, Default)]
pub struct ExportOptions {
    /// Write only occupied bands into a pre-sized file (holes for the rest). See the module doc.
    pub sparse: bool,
    /// `fsync` the output before returning (a user-visible export wants it; a private temp doesn't).
    pub fsync: bool,
}

/// The exact sizes an own-format export will produce (spec step 1, "Pre-flight, exact").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Preflight {
    /// `192 + n × stride + creature bytes + 16 × n + trailer bytes`.
    pub total_len: u64,
    /// Bytes a sparse export actually writes: the header, every *occupied* band, the creatures, the
    /// directory and the trailer. What a free-space check should ask for.
    pub occupied_len: u64,
    pub columns: u32,
}

/// What an export wrote, for the caller that then maps the output (VuencEdit's `EmodSession`).
#[derive(Clone, Debug)]
pub struct OwnExport {
    pub preflight: Preflight,
    /// Live columns in slot order (= ascending ord): `(x, z, ord)`. Slot *i* sits at
    /// `192 + i × stride` in the output.
    pub slots: Vec<(i32, i32, u32)>,
    /// `PROVENANCE`'s source directory row order, when the store has a readable one.
    pub prov_dir_order: Option<Vec<(i32, i32)>>,
    /// `PROVENANCE.flags` (0 ⇔ a fresh conversion exports byte-identical to its source).
    pub prov_flags: Option<u32>,
    /// The live `GENERATOR` record, raw (never interpreted here).
    pub generator: Option<[u8; GENERATOR_LEN]>,
    /// Columns that read as air because no version decodes (spec: damage; never marked modified).
    pub air_columns: Vec<(i32, i32)>,
    /// Columns served by an earlier version because the newest doesn't decode (damage).
    pub fallback_columns: Vec<(i32, i32)>,
}

/// The parts of `PROVENANCE` the exporter needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProvenanceInfo {
    pub flags: u32,
    pub source_name: String,
    pub dir_order: Vec<(i32, i32)>,
}

/// Parses a `PROVENANCE` payload (spec § PROVENANCE). `None` if it is malformed.
pub fn parse_provenance(p: &[u8]) -> Option<ProvenanceInfo> {
    // u32 prov_version, u32 flags, u64 size, i64 mtime, [u8;32] hash, u32 version, u32 rows, u64 dead, u32 slots
    const FIXED: usize = 4 + 4 + 8 + 8 + 32 + 4 + 4 + 8 + 4;
    let take = |o: &mut usize, n: usize| -> Option<&[u8]> {
        let s = p.get(*o..o.checked_add(n)?)?;
        *o += n;
        Some(s)
    };
    let mut o = 0usize;
    let fixed = take(&mut o, FIXED)?;
    if rd32(fixed) != 1 {
        return None;
    }
    let flags = rd32(&fixed[4..]);
    let nl = rd32(take(&mut o, 4)?) as usize;
    let source_name = String::from_utf8_lossy(take(&mut o, nl)?).into_owned();
    let ns = rd32(take(&mut o, 4)?) as usize;
    take(&mut o, ns.checked_mul(12)?)?;
    let nd = rd32(take(&mut o, 4)?) as usize;
    let rows = take(&mut o, nd.checked_mul(8)?)?;
    if o != p.len() {
        return None;
    }
    let dir_order = rows.chunks_exact(8).map(|r| (rd32(r) as i32, rd32(&r[4..]) as i32)).collect();
    Some(ProvenanceInfo { flags, source_name, dir_order })
}

/// The 36-byte `.eden` mirror of a `GENERATOR` record: `"EMG1"` + record + CRC-32 of those 32 B.
pub fn generator_mirror(g: &[u8; GENERATOR_LEN]) -> [u8; 36] {
    let mut b = [0u8; 36];
    b[..4].copy_from_slice(&GEN_MIRROR_MAGIC);
    b[4..32].copy_from_slice(g);
    let crc = crc32(&b[..32]);
    b[32..].copy_from_slice(&crc.to_le_bytes());
    b
}

fn singleton(store: &mut Store, t: RecordType, what: &str) -> Result<Option<Vec<u8>>> {
    match store.read_record(t)? {
        (ReadStatus::Ok | ReadStatus::Fallback, v) => Ok(Some(v)),
        (ReadStatus::Absent, _) => Ok(None),
        (ReadStatus::AirDamaged, _) => Err(Error::Damaged(format!("{what} does not decode"))),
    }
}

/// The exact pre-flight of an own-format export, without decoding any column.
pub fn preflight_own(store: &mut Store) -> Result<Preflight> {
    let creatures = singleton(store, RecordType::Creatures, "CREATURES")?.map_or(0, |c| c.len()) as u64;
    let trailer = singleton(store, RecordType::SignTrailer, "SIGN_TRAILER")?.map_or(0, |t| t.len()) as u64;
    let cols = store.columns();
    let n = cols.len() as u64;
    let stride = store.column_len() as u64;
    let fixed = EDEN_HEADER_LEN as u64 + creatures + n * EDEN_DIR_ROW as u64 + trailer;
    let bands: u64 = cols.iter().map(|c| c.mask.count_ones() as u64).sum();
    Ok(Preflight { total_len: fixed + n * stride, occupied_len: fixed + bands * BAND as u64, columns: n as u32 })
}

/// Exports the store's live state to `out` as an own-format `.eden` (see the module doc). `out` is
/// created or truncated. A damaged store exports what decodes (a column with no decodable version
/// is air), as `emod.py export --force` does; an unreadable `WORLD_HEADER` or `CREATURES` refuses.
/// On any error the partial `out` is removed.
pub fn export_own(store: &mut Store, out: &Path, opts: ExportOptions) -> Result<OwnExport> {
    let r = export_own_inner(store, out, opts);
    if r.is_err() {
        let _ = fs::remove_file(out);
    }
    r
}

fn export_own_inner(store: &mut Store, out: &Path, opts: ExportOptions) -> Result<OwnExport> {
    let header = singleton(store, RecordType::WorldHeader, "WORLD_HEADER")?
        .ok_or_else(|| Error::Damaged("no WORLD_HEADER".into()))?;
    if header.len() != EDEN_HEADER_LEN {
        return Err(Error::Damaged(format!("WORLD_HEADER is {} bytes, not 192", header.len())));
    }
    let creatures = singleton(store, RecordType::Creatures, "CREATURES")?
        .ok_or_else(|| Error::Damaged("no CREATURES".into()))?;
    let trailer = singleton(store, RecordType::SignTrailer, "SIGN_TRAILER")?.unwrap_or_default();
    // A malformed PROVENANCE only costs the row order (rows then follow ord order).
    let prov = singleton(store, RecordType::Provenance, "PROVENANCE").ok().flatten().and_then(|p| parse_provenance(&p));
    let generator: Option<[u8; GENERATOR_LEN]> = singleton(store, RecordType::Generator, "GENERATOR")
        .ok()
        .flatten()
        .and_then(|g| g.as_slice().try_into().ok());

    let cols = store.columns(); // ord order
    let n = cols.len() as u64;
    let stride = store.column_len() as u64;
    let bands = store.bands() as usize;
    let dir_off = EDEN_HEADER_LEN as u64 + n * stride + creatures.len() as u64;
    let total = dir_off + n * EDEN_DIR_ROW as u64 + trailer.len() as u64;
    let occupied_bands: u64 = cols.iter().map(|c| c.mask.count_ones() as u64).sum();
    let preflight = Preflight {
        total_len: total,
        occupied_len: total - n * stride + occupied_bands * BAND as u64,
        columns: n as u32,
    };

    let mut hdr = header;
    hdr[DIR_OFF_FIELD..DIR_OFF_FIELD + 8].copy_from_slice(&dir_off.to_le_bytes());
    if let Some(g) = &generator {
        hdr[GEN_MIRROR_OFF..GEN_MIRROR_OFF + 36].copy_from_slice(&generator_mirror(g));
        hdr[GEN_MIRROR_OFF + 36..EDEN_HEADER_LEN].fill(0);
    }

    // Directory rows: PROVENANCE's live keys in source row order, then the rest in ord order.
    let slot_of: std::collections::HashMap<(i32, i32), u64> =
        cols.iter().enumerate().map(|(i, c)| ((c.x, c.z), EDEN_HEADER_LEN as u64 + i as u64 * stride)).collect();
    let mut rows: Vec<(i32, i32)> = Vec::with_capacity(cols.len());
    let mut seen = std::collections::HashSet::with_capacity(cols.len());
    for &k in prov.as_ref().map_or(&[][..], |p| &p.dir_order[..]) {
        if slot_of.contains_key(&k) && seen.insert(k) {
            rows.push(k);
        }
    }
    rows.extend(cols.iter().map(|c| (c.x, c.z)).filter(|k| !seen.contains(k)));
    let mut dir = Vec::with_capacity(rows.len() * EDEN_DIR_ROW);
    for (x, z) in &rows {
        dir.extend_from_slice(&x.to_le_bytes());
        dir.extend_from_slice(&z.to_le_bytes());
        dir.extend_from_slice(&slot_of[&(*x, *z)].to_le_bytes());
    }

    let file = File::create(out)?;
    let mut col = vec![0u8; stride as usize];
    let mut air_columns = Vec::new();
    let mut fallback_columns = Vec::new();
    let mut read = |store: &mut Store, x: i32, z: i32, col: &mut [u8]| -> Result<u16> {
        let (st, mask) = store.read_column(x, z, col)?;
        match st {
            ReadStatus::AirDamaged => air_columns.push((x, z)),
            ReadStatus::Fallback => fallback_columns.push((x, z)),
            _ => {}
        }
        Ok(mask)
    };
    if opts.sparse {
        file.set_len(total)?;
        write_all_at(&file, 0, &hdr)?;
        for (i, c) in cols.iter().enumerate() {
            let mask = read(store, c.x, c.z, &mut col)?;
            let base = EDEN_HEADER_LEN as u64 + i as u64 * stride;
            for b in (0..bands).filter(|b| mask >> b & 1 != 0) {
                write_all_at(&file, base + (b * BAND) as u64, &col[b * BAND..(b + 1) * BAND])?;
            }
        }
        write_all_at(&file, n * stride + EDEN_HEADER_LEN as u64, &creatures)?;
        write_all_at(&file, dir_off, &dir)?;
        write_all_at(&file, dir_off + dir.len() as u64, &trailer)?;
    } else {
        let mut w = BufWriter::with_capacity(1 << 20, &file);
        w.write_all(&hdr)?;
        for c in &cols {
            read(store, c.x, c.z, &mut col)?;
            w.write_all(&col)?;
        }
        w.write_all(&creatures)?;
        w.write_all(&dir)?;
        w.write_all(&trailer)?;
        w.flush().map_err(io::Error::from)?;
    }
    if opts.fsync {
        file.sync_all()?;
    }
    let written = file.metadata()?.len();
    if written != total {
        return Err(Error::Invalid(format!("export wrote {written} B, pre-flight said {total} B")));
    }
    Ok(OwnExport {
        preflight,
        slots: cols.iter().map(|c| (c.x, c.z, c.ord)).collect(),
        prov_dir_order: prov.as_ref().map(|p| p.dir_order.clone()),
        prov_flags: prov.as_ref().map(|p| p.flags),
        generator,
        air_columns,
        fallback_columns,
    })
}
