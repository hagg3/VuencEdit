//! `.mpworld` / `eden_world.model` — Eden **multiplayer server world model** import.
//!
//! Phase 1 (this file): a pure, offline file→data module — parser, wrapped-coordinate
//! outlier rejection, and the `scan_mpworld` command that drives the import modal's
//! summary. It must not take `AppState` and must not hold a lock.
//!
//! Format (plan §0.1): plain ASCII, `\n`-terminated, one cell per line, five
//! `:`-separated decimal integers `worldX : height : worldZ : blockType : paint`.
//! ⚠️ **Field 2 is height, field 3 is the second horizontal axis** — the server's
//! `saveWorld` emits `wunkey` outputs in `x : y : z` order, i.e. Eden editor-X,
//! editor-Z(height), editor-Y. `type 255` is `SV_PAINTED_BASE` (a natural block that
//! was only painted), not a block id; `type 0` is an explicit carve. Both sentinels
//! and the `ground_y` suppression rule are handled in Phase 2, not here.
//!
//! Full spec: `TEST WORLDS/mpworld-import-plan-2026-09-02.md`.

use std::io::{BufRead, BufReader, Read};

/// One server cell. `x`/`z` are the two horizontal axes (server = Eden absolute
/// block coords, plan §0.6), `y` is height. 12 bytes packed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MpRec {
    pub x: i32,
    pub z: i32,
    pub y: i16,
    pub t: u8,
    pub c: u8,
}

/// A record further than this many blocks from the coordinate **median** on either
/// horizontal axis is treated as wrapped-coordinate junk and dropped (plan §0.7).
/// 2048 blocks = 128 chunks = `create_world`'s per-axis cap, so anything surviving
/// rejection is importable by construction.
pub(crate) const MP_OUTLIER_RADIUS: i32 = 2048;

/// Result of a single streaming parse pass.
pub(crate) struct MpParse {
    pub recs: Vec<MpRec>,
    pub malformed: u32,
    pub dropped_outliers: u32,
    /// Server-x span of the dropped outliers (for an actionable scan report).
    pub outlier_x_range: Option<(i32, i32)>,
    pub outlier_z_range: Option<(i32, i32)>,
}

fn trim(b: &[u8]) -> &[u8] {
    let mut s = 0;
    let mut e = b.len();
    while s < e && b[s].is_ascii_whitespace() {
        s += 1;
    }
    while e > s && b[e - 1].is_ascii_whitespace() {
        e -= 1;
    }
    &b[s..e]
}

/// Hand-rolled ASCII → `i32`. No `String`, no UTF-8 validation, no allocation —
/// the data is guaranteed ASCII digits / `-` / `:`. Returns `None` on an empty
/// field, a stray non-digit, or overflow.
fn parse_i32_ascii(b: &[u8]) -> Option<i32> {
    if b.is_empty() {
        return None;
    }
    let (neg, digits) = match b[0] {
        b'-' => (true, &b[1..]),
        b'+' => (false, &b[1..]),
        _ => (false, b),
    };
    if digits.is_empty() {
        return None;
    }
    let mut acc: i64 = 0;
    for &ch in digits {
        if !ch.is_ascii_digit() {
            return None;
        }
        acc = acc * 10 + (ch - b'0') as i64;
        if acc > i32::MAX as i64 + 1 {
            return None;
        }
    }
    let v = if neg { -acc } else { acc };
    if v < i32::MIN as i64 || v > i32::MAX as i64 {
        return None;
    }
    Some(v as i32)
}

/// Parse one line (newline already stripped by the caller is fine — we re-trim).
/// `None` = blank line or fewer than 4 numeric fields, mirroring `loadWorld`'s
/// `if (n >= 4)` so a file the server would accept never fails here.
fn parse_line(line: &[u8]) -> Option<MpRec> {
    let line = trim(line);
    if line.is_empty() {
        return None;
    }
    let mut it = line.split(|&b| b == b':');
    let x = parse_i32_ascii(it.next()?)?;
    let height = parse_i32_ascii(it.next()?)?;
    let z = parse_i32_ascii(it.next()?)?;
    let t = parse_i32_ascii(it.next()?)?;
    // Paint is optional — a 4-field line parses with paint 0.
    let c = match it.next() {
        Some(f) => parse_i32_ascii(f)?,
        None => 0,
    };
    Some(MpRec {
        x,
        z,
        y: height.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
        t: (t & 0xff) as u8,
        c: (c & 0xff) as u8,
    })
}

/// Streaming parse of the whole file. Peak memory is the record `Vec` alone — the
/// file bytes are never all resident.
pub(crate) fn parse_mpworld(path: &str) -> Result<MpParse, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = BufReader::new(file);

    // Mean line length in the reference dumps is ~19.4 B; 24 is a safe over-estimate.
    let mut recs: Vec<MpRec> = Vec::with_capacity((len / 24 + 1) as usize);
    let mut malformed = 0u32;
    let mut buf: Vec<u8> = Vec::with_capacity(64);

    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("Read error: {e}"))?;
        if n == 0 {
            break;
        }
        let line = trim(&buf);
        if line.is_empty() {
            continue;
        }
        match parse_line(line) {
            Some(r) => recs.push(r),
            None => malformed += 1,
        }
    }

    if recs.is_empty() {
        return Err(
            "No world records found — this does not look like an Eden server world model \
             (.mpworld / eden_world.model)."
                .into(),
        );
    }

    let (dropped, xr, zr) = reject_outliers(&mut recs);
    recs.shrink_to_fit();
    Ok(MpParse {
        recs,
        malformed,
        dropped_outliers: dropped,
        outlier_x_range: xr,
        outlier_z_range: zr,
    })
}

fn median(vals: &mut [i32]) -> i32 {
    let mid = vals.len() / 2;
    vals.select_nth_unstable(mid);
    vals[mid]
}

/// Drop records further than `MP_OUTLIER_RADIUS` from the coordinate median on
/// either horizontal axis. ⚠️ **Median, not min/max** — one wrapped-coordinate
/// outlier poisons a min/max bounding box, which is the whole failure mode (§1.3).
fn reject_outliers(recs: &mut Vec<MpRec>) -> (u32, Option<(i32, i32)>, Option<(i32, i32)>) {
    let mut xs: Vec<i32> = recs.iter().map(|r| r.x).collect();
    let mut zs: Vec<i32> = recs.iter().map(|r| r.z).collect();
    let cx = median(&mut xs) as i64;
    let cz = median(&mut zs) as i64;
    let r = MP_OUTLIER_RADIUS as i64;

    let mut dropped = 0u32;
    let mut xr: Option<(i32, i32)> = None;
    let mut zr: Option<(i32, i32)> = None;
    recs.retain(|rec| {
        let keep = (rec.x as i64 - cx).abs() <= r && (rec.z as i64 - cz).abs() <= r;
        if !keep {
            dropped += 1;
            xr = Some(match xr {
                Some((lo, hi)) => (lo.min(rec.x), hi.max(rec.x)),
                None => (rec.x, rec.x),
            });
            zr = Some(match zr {
                Some((lo, hi)) => (lo.min(rec.z), hi.max(rec.z)),
                None => (rec.z, rec.z),
            });
        }
        keep
    });
    (dropped, xr, zr)
}

/// Cheap content sniff: the first 512 bytes must be entirely `[0-9:\-\r\n]` and
/// contain at least one `:` and one `\n`. Rejects an `.eden` (binary header)
/// outright; combined with the frontend extension check it covers `.mpworld`,
/// `.model`, and a renamed file. Wired into the open/drag-drop funnel in Phase 3.
#[allow(dead_code)]
pub(crate) fn looks_like_mpworld(path: &str) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 512];
    let n = match f.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    if n == 0 {
        return false;
    }
    let mut has_colon = false;
    let mut has_nl = false;
    for &b in &buf[..n] {
        match b {
            b'0'..=b'9' | b'-' | b'\r' => {}
            b':' => has_colon = true,
            b'\n' => has_nl = true,
            _ => return false,
        }
    }
    has_colon && has_nl
}

/// Summary shown in `MpworldImportModal` before the user commits to the conversion.
#[derive(serde::Serialize)]
pub struct MpworldScan {
    pub rows: u32,
    pub malformed: u32,
    pub dropped_outliers: u32,
    pub dropped_x_min: i32,
    pub dropped_x_max: i32,
    pub dropped_z_min: i32,
    pub dropped_z_max: i32,
    /// Server coords of the chunk-aligned bbox corner — the origin the Phase 2
    /// `editor_x = server_x - min_x` mapping subtracts.
    pub min_x: i32,
    pub min_z: i32,
    /// Exact occupied span (max - min + 1), not chunk-aligned.
    pub width_blocks: u32,
    pub height_blocks: u32,
    pub width_chunks: u32,
    pub height_chunks: u32,
    /// Absolute chunk coords — become `WorldMeta.abs_min_x`/`abs_min_y` (plan §0.6).
    pub abs_min_cx: i32,
    pub abs_min_cy: i32,
    pub max_height: u32,
    /// What a 64z import would clip.
    pub cells_above_63: u32,
    /// `type 255` records.
    pub painted_base_cells: u32,
    pub occupied_columns: u32,
    pub est_bytes_64z: u64,
    pub est_bytes_256z: u64,
}

pub(crate) fn scan_mpworld_inner(path: &str) -> Result<MpworldScan, String> {
    let p = parse_mpworld(path)?;
    let recs = &p.recs;

    let min_sx = recs.iter().map(|r| r.x).min().unwrap();
    let max_sx = recs.iter().map(|r| r.x).max().unwrap();
    let min_sz = recs.iter().map(|r| r.z).min().unwrap();
    let max_sz = recs.iter().map(|r| r.z).max().unwrap();
    let max_height = recs.iter().map(|r| r.y.max(0) as u32).max().unwrap_or(0);
    let cells_above_63 = recs.iter().filter(|r| r.y as i32 > 63).count() as u32;
    let painted_base_cells = recs.iter().filter(|r| r.t == 255).count() as u32;

    let abs_min_cx = min_sx.div_euclid(16);
    let abs_min_cy = min_sz.div_euclid(16);
    let abs_max_cx = max_sx.div_euclid(16);
    let abs_max_cy = max_sz.div_euclid(16);

    let width_chunks = (abs_max_cx - abs_min_cx + 1) as u32;
    let height_chunks = (abs_max_cy - abs_min_cy + 1) as u32;
    let width_blocks = (max_sx - min_sx + 1) as u32;
    let height_blocks = (max_sz - min_sz + 1) as u32;

    let mut cols: Vec<(i32, i32)> = recs.iter().map(|r| (r.x, r.z)).collect();
    cols.sort_unstable();
    cols.dedup();
    let occupied_columns = cols.len() as u32;

    if width_chunks > 128 || height_chunks > 128 {
        return Err(format!(
            "This server world spans {width_chunks}×{height_chunks} chunks \
             ({width_blocks}×{height_blocks} blocks), larger than the 128×128-chunk \
             maximum. Sparse-chunk import (plan Phase 5) is not implemented yet."
        ));
    }

    let est = |chunk_size: u64| -> u64 {
        192 + (width_chunks as u64) * (height_chunks as u64) * (chunk_size + 16)
    };
    let (dx0, dx1) = p.outlier_x_range.unwrap_or((0, 0));
    let (dz0, dz1) = p.outlier_z_range.unwrap_or((0, 0));

    Ok(MpworldScan {
        rows: recs.len() as u32,
        malformed: p.malformed,
        dropped_outliers: p.dropped_outliers,
        dropped_x_min: dx0,
        dropped_x_max: dx1,
        dropped_z_min: dz0,
        dropped_z_max: dz1,
        min_x: abs_min_cx * 16,
        min_z: abs_min_cy * 16,
        width_blocks,
        height_blocks,
        width_chunks,
        height_chunks,
        abs_min_cx,
        abs_min_cy,
        max_height,
        cells_above_63,
        painted_base_cells,
        occupied_columns,
        est_bytes_64z: est(32_768),
        est_bytes_256z: est(131_072),
    })
}

/// Scan a `.mpworld` / `eden_world.model` for the import modal. File I/O only,
/// touches no `AppState`, so it takes no guard.
#[tauri::command(async)]
pub(crate) fn scan_mpworld(path: String) -> Result<MpworldScan, String> {
    scan_mpworld_inner(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_tmp(name: &str, body: &[u8]) -> String {
        let p = std::env::temp_dir().join(format!("ve_mpworld_{}_{name}", std::process::id()));
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body).unwrap();
        p.to_str().unwrap().to_string()
    }

    /// One clustered cell block around a server origin, plus optional extras.
    fn cluster(lines: &mut String, x0: i32, z0: i32, n: i32) {
        for i in 0..n {
            lines.push_str(&format!(
                "{}:{}:{}:{}:{}\n",
                x0 + (i % 4),
                32 + (i % 4),
                z0 + ((i / 4) % 4),
                2,
                0
            ));
        }
    }

    #[test]
    fn test_mpworld_parses_reference_sample() {
        // Opt-in only: points at a private sibling-app reference world that doesn't
        // exist in a flattened public checkout (or most local ones), so the test
        // no-ops unless the env var is set — no hardcoded cross-app path here.
        let Ok(p) = std::env::var("VUENCEDIT_MPWORLD_FIXTURE") else {
            eprintln!(
                "skipping test_mpworld_parses_reference_sample: \
                 VUENCEDIT_MPWORLD_FIXTURE not set"
            );
            return;
        };
        if !std::path::Path::new(&p).exists() {
            eprintln!("skipping test_mpworld_parses_reference_sample: {p} not present");
            return;
        }
        let parsed = parse_mpworld(&p).expect("reference sample parses");
        assert_eq!(parsed.malformed, 0, "reference sample has no malformed lines");
        let total = parsed.recs.len() + parsed.dropped_outliers as usize;
        assert!(
            (2900..=3019).contains(&total),
            "expected ~3019 rows, got {total}"
        );

        let scan = scan_mpworld_inner(&p).expect("scan");
        assert!(scan.width_chunks <= 128 && scan.height_chunks <= 128);
        assert_eq!(scan.min_x, scan.abs_min_cx * 16);
    }

    #[test]
    fn test_mpworld_rejects_wrapped_outliers() {
        let mut body = String::new();
        cluster(&mut body, 65_500, 65_500, 100);
        // 3 wrapped-coordinate outliers at assorted bit widths.
        body.push_str("4194302:33:11:2:0\n");
        body.push_str("1048572:34:17:2:0\n");
        body.push_str("262125:34:262127:2:0\n");
        let path = write_tmp("wrapped", body.as_bytes());

        let p = parse_mpworld(&path).unwrap();
        assert_eq!(p.recs.len(), 100);
        assert_eq!(p.dropped_outliers, 3);

        let scan = scan_mpworld_inner(&path).unwrap();
        assert_eq!(scan.width_chunks, 1, "surviving spread is one chunk");
        assert_eq!(scan.height_chunks, 1);
        assert_eq!(scan.dropped_outliers, 3);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_mpworld_tolerates_short_and_blank_lines() {
        let body = "65500:32:65500:8:0\n\
                    65501:33:65500:20\n\
                    \n\
                    not:a:number:x\n\
                    65502:34:65500:2:5\n";
        let path = write_tmp("short", body.as_bytes());
        let p = parse_mpworld(&path).unwrap();
        assert_eq!(p.recs.len(), 3, "3 numeric rows");
        assert_eq!(p.malformed, 1, "one garbage line, blank line skipped silently");
        // The 4-field line parsed with paint 0.
        let four = p.recs.iter().find(|r| r.x == 65501).unwrap();
        assert_eq!(four.c, 0);
        assert_eq!(four.y, 33);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_mpworld_errors_when_nothing_parses() {
        let path = write_tmp("empty", b"\n\ngarbage\n");
        assert!(parse_mpworld(&path).is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_mpworld_sniff_rejects_eden_header() {
        // A plausible `.eden` header: zero seed, float pos, then binary.
        let mut eden = vec![0u8; 200];
        eden[92] = 5; // version field
        eden[40..45].copy_from_slice(b"World");
        let bad = write_tmp("fake.eden", &eden);
        assert!(!looks_like_mpworld(&bad));

        let good = write_tmp("good.model", b"65500:32:65500:8:0\n65501:33:65500:20:0\n");
        assert!(looks_like_mpworld(&good));
        std::fs::remove_file(&bad).ok();
        std::fs::remove_file(&good).ok();
    }
}
