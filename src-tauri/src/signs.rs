//! The 2026 game's sign / command-block **sidecars** (ROADMAP-EDIT 27.0b, plan §6.2).
//!
//! The records themselves live in the world's post-directory trailer, modelled by
//! `eden_format::eden::trailer::Trailer` (`LoadedWorld::trailer`). The 2026 game can also leave them
//! beside the world as `signs_<stem>.eden.dat` / `cmd_<stem>.eden.dat`: one bare section each
//! (`MAGIC | u32 version | u32 count` + records). We adopt them like Emod's `FileManager::loadTrailer`:
//!
//! - **The trailer wins per section.** A sidecar is adopted only when the trailer has no records of
//!   that kind (`Refusal::Exists` otherwise), and only if it's a readable section ≤ 1 MiB that fits
//!   under the cap. Anything else is ignored and logged; a sidecar never fails a load.
//! - Adopted records are written into the world by the next save to the world's **own** path,
//!   which then renames each adopted sidecar `<name>.adopted` (`finish_adoption` in `lib.rs`), so
//!   deleting every sign later can't bring the sidecar's back on reload.
//!
//! Sidecars sit beside the **source** file (never the staged temp), named from its stem
//! (`stem_of`, a port of Emod's `WorldSource::stemOf`).

use std::path::{Path, PathBuf};

use eden_format::eden::trailer::{self, Kind, Trailer};

use crate::RecordCounts;

/// The world-name stem the sidecars are named from — Emod's `WorldSource::stemOf`:
/// `w.eden.gz` / `w.eden.zip` / `w.gz` / `w.zip` / `w.eden` → `w`, and a bare `w.ext` with any
/// other extension (`w.emod`) drops it.
pub(crate) fn stem_of(name: &str) -> String {
    let lower = |s: &str| s.to_ascii_lowercase();
    let mut n = name.to_string();
    if lower(&n).ends_with(".gz") {
        n.truncate(n.len() - 3);
    } else if lower(&n).ends_with(".zip") {
        n.truncate(n.len() - 4);
    }
    if lower(&n).ends_with(".eden") {
        n.truncate(n.len() - 5);
    } else if n == name {
        if let Some(dot) = n.rfind('.').filter(|&d| d > 0) {
            n.truncate(dot);
        }
    }
    n
}

/// `[signs_<stem>.eden.dat, cmd_<stem>.eden.dat]` beside `world_path`.
pub(crate) fn sidecar_paths(world_path: &Path) -> [PathBuf; 2] {
    let name = world_path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = stem_of(&name);
    ["signs_", "cmd_"].map(|k| world_path.with_file_name(format!("{k}{stem}.eden.dat")))
}

/// Adopt the sidecars beside `world_path` into `trailer` (plan §6.2). Returns the adopted files and
/// how many records each kind brought in; both empty when nothing was adopted (no sidecars, the
/// trailer already has those sections, an opaque trailer, or an unreadable sidecar).
pub(crate) fn adopt_sidecars(trailer: &mut Trailer, world_path: &Path) -> (Vec<PathBuf>, RecordCounts) {
    let mut files = Vec::new();
    let mut counts = RecordCounts::default();
    for path in sidecar_paths(world_path) {
        let Ok(md) = std::fs::metadata(&path) else { continue };
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let bytes = if md.len() > 0 && md.len() <= trailer::MAX_BYTES as u64 { std::fs::read(&path).ok() } else { None };
        let r = bytes.ok_or(trailer::Refusal::Bad).and_then(|b| trailer.adopt_sidecar(&b));
        let n = match r {
            Ok(Kind::Sign) => trailer.signs().len() as u32,
            Ok(Kind::Cmd) => trailer.cmds().len() as u32,
            Err(_) => 0,
        };
        let outcome = match r {
            Ok(_) if n == 0 => "empty".to_string(),
            Ok(_) => format!("adopted {n} records"),
            Err(trailer::Refusal::Exists) => "ignored (the world has its own)".into(),
            Err(e) => format!("not adopted: {e}"),
        };
        crate::timing_log!("[LOAD] sidecar {name} ({} B): {outcome}", md.len());
        match r {
            Ok(Kind::Sign) if n > 0 => counts.signs = n,
            Ok(Kind::Cmd) if n > 0 => counts.cmds = n,
            _ => continue,
        }
        files.push(path);
    }
    (files, counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stem_matches_emod() {
        for (name, stem) in [
            ("w.eden", "w"),
            ("w.EDEN", "w"),
            ("w.eden.gz", "w"),
            ("w.eden.zip", "w"),
            ("w.zip", "w"),
            ("w.gz", "w"),
            ("command block academy.emod", "command block academy"),
            ("noext", "noext"),
            (".hidden", ".hidden"),
            ("a.b.eden", "a.b"),
        ] {
            assert_eq!(stem_of(name), stem, "{name}");
        }
    }

    #[test]
    fn sidecar_paths_use_the_stem() {
        let [s, c] = sidecar_paths(Path::new("/worlds/afwx…pbgv.eden"));
        assert_eq!(s, Path::new("/worlds/signs_afwx…pbgv.eden.dat"));
        assert_eq!(c, Path::new("/worlds/cmd_afwx…pbgv.eden.dat"));
        let [s, _] = sidecar_paths(Path::new("/worlds/x.emod"));
        assert_eq!(s, Path::new("/worlds/signs_x.eden.dat"));
    }

    /// Sidecar adoption against a synthetic pair: the trailer wins per section.
    #[test]
    fn adoption_trailer_wins_per_section() {
        let dir = std::env::temp_dir().join(format!("vx-sidecars-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let world = dir.join("w.eden");
        let section = |magic: &[u8; 4], rec: usize, n: u32| {
            let mut v = magic.to_vec();
            v.extend(1u32.to_le_bytes());
            v.extend(n.to_le_bytes());
            v.resize(12 + rec * n as usize, 0);
            v
        };
        std::fs::write(dir.join("signs_w.eden.dat"), section(b"SGN1", trailer::SIGN_LEN, 2)).unwrap();
        std::fs::write(dir.join("cmd_w.eden.dat"), section(b"CMB1", trailer::CMD_LEN, 3)).unwrap();

        let mut t = Trailer::empty();
        let (files, counts) = adopt_sidecars(&mut t, &world);
        assert_eq!(files.len(), 2);
        assert_eq!(counts, RecordCounts { signs: 2, cmds: 3 });
        assert!(t.is_touched());
        assert_eq!(t.section_order(), vec![trailer::CMB1, trailer::SGN1]);

        // A trailer that already has signs keeps them; only the command blocks are adopted.
        let mut t = Trailer::empty();
        t.add_sign(trailer::Pos::new(1, 2, 3), 3, 2, 0, b"mine").unwrap();
        let (files, counts) = adopt_sidecars(&mut t, &world);
        assert_eq!(files, vec![dir.join("cmd_w.eden.dat")]);
        assert_eq!(counts, RecordCounts { signs: 0, cmds: 3 });
        assert_eq!(t.signs().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
