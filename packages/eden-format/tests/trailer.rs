//! `eden::trailer` against real trailers (27.0a test vi). The pack's fixtures are always present;
//! the private specimens (the adder, the 2026 game's `signlab` sidecars, Quarry) live outside the
//! repo and each test skips when its file is absent. ⚠️ Never copy a specimen trailer into
//! `tests/fixtures/`: this crate is staged into the public VuencEdit mirror.

mod common;

use std::path::PathBuf;

use common::fixture;
use eden_format::eden::trailer::{Kind, Pos, Refusal, Trailer, CMB1, SGN1};

/// `bytes[trailer_start..]`: the rows after the real directory rows, to EOF. A real row's X is an
/// addressable chunk coordinate, so it never starts `ff ff ff ff`; a trailer row always does.
fn trailer_of(world: &[u8]) -> &[u8] {
    let dir = u64::from_le_bytes(world[32..40].try_into().unwrap()) as usize;
    let mut i = dir;
    while i + 16 <= world.len() && world[i..i + 4] != [0xff; 4] {
        i += 16;
    }
    &world[i.min(world.len())..]
}

fn home(rel: &str) -> Option<PathBuf> {
    let p = PathBuf::from(std::env::var_os("HOME")?).join(rel);
    if p.exists() {
        Some(p)
    } else {
        eprintln!("skipping: {p:?} not present");
        None
    }
}

/// Parse, check counts and section order, and the parse → serialise gate.
fn check(name: &str, bytes: &[u8], signs: usize, cmds: usize, order: &[[u8; 4]]) -> Trailer {
    let t = Trailer::load(bytes);
    assert!(t.parsed(), "{name}: {}", t.why());
    assert_eq!((t.signs().len(), t.cmds().len()), (signs, cmds), "{name}: record counts");
    assert_eq!(t.section_order(), order, "{name}: section order");
    assert_eq!(&*t.encode(), bytes, "{name}: untouched encode = original");
    assert_eq!(t.rebuild(), bytes, "{name}: rebuild ≡ original");
    t
}

/// The pack's two sign fixtures come from Emod's fixture generator (`emod.py` `sign_trailer`), whose
/// section wrapper is `MAGIC | len` with no `w3` word, so the inner header isn't where rule 2 wants
/// it. `emod.py trailer --check` calls both **opaque** too; the model must agree: kept verbatim,
/// every edit refused.
#[test]
fn pack_fixtures_are_opaque_like_emod_says() {
    for name in ["f256-trailer.eden.gz", "f256-v2-signs.eden.gz"] {
        let w = fixture(name);
        let bytes = trailer_of(&w);
        assert!(!bytes.is_empty(), "{name} has a trailer");
        let mut t = Trailer::load(bytes);
        assert!(!t.parsed(), "{name}: opaque");
        assert!(t.why().contains("inner header"), "{name}: {}", t.why());
        assert_eq!(&*t.encode(), bytes, "{name}: kept verbatim");
        assert_eq!(t.add_sign(Pos::new(0, 0, 0), 3, 2, 0, b"x"), Err(Refusal::Opaque));
    }
}

/// Every record removed and re-inserted at its index: byte-identical to the original (the undo
/// invariant, T6), on the largest real trailer we have.
#[test]
fn adder_specimen() {
    let Some(path) = home("emod/TESTERS/3 bit adder 1791611312.eden") else { return };
    let world = std::fs::read(&path).unwrap();
    let bytes = trailer_of(&world);
    assert_eq!(bytes.len(), 80_480);
    let mut t = check("adder", bytes, 67, 99, &[CMB1, SGN1]);
    for i in (0..t.signs().len()).rev() {
        let s = t.remove_sign(i).unwrap();
        t.insert_sign_at(i, s).unwrap();
    }
    for i in 0..t.cmds().len() {
        let c = t.remove_cmd(i).unwrap();
        t.insert_cmd_at(i, c).unwrap();
    }
    assert!(t.is_touched());
    assert_eq!(&*t.encode(), bytes, "edit + undo ⇒ byte-identical");

    // Emptying SGN1 leaves CMB1 alone and still parses.
    while !t.signs().is_empty() {
        t.remove_sign(0).unwrap();
    }
    let re = Trailer::load(&t.encode());
    assert!(re.parsed(), "{}", re.why());
    assert_eq!(re.section_order(), vec![CMB1]);
    assert_eq!(re.cmds(), t.cmds());
}

/// Optional cross-check: Emod's independent reference (`emod.py trailer --check`) agrees.
#[test]
fn adder_agrees_with_emod_py() {
    let Some(path) = home("emod/TESTERS/3 bit adder 1791611312.eden") else { return };
    let Some(tool) = home("emod/port/tools/emod.py") else { return };
    let Ok(out) = std::process::Command::new("python3").arg("-I").arg(&tool).args(["trailer", "--check"]).arg(&path).output()
    else {
        eprintln!("skipping: python3 not runnable");
        return;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "emod.py failed: {text}{}", String::from_utf8_lossy(&out.stderr));
    assert!(text.contains("section CMB1: version 1, 99 records"), "{text}");
    assert!(text.contains("section SGN1: version 1, 67 records"), "{text}");
    assert!(text.contains("byte-identical"), "{text}");
}

/// (v) on the real files: the 2026 game's sidecars adopt into an empty trailer, `CMB1` first.
#[test]
fn signlab_sidecars_adopt() {
    let Some(dir) = home("emod/TESTERS/signlab") else { return };
    let signs = std::fs::read(dir.join("signs_1791633449.eden.dat")).unwrap();
    let cmds = std::fs::read(dir.join("cmd_1791633449.eden.dat")).unwrap();
    let mut t = Trailer::empty();
    assert_eq!(t.adopt_sidecar(&signs), Ok(Kind::Sign));
    assert_eq!(t.adopt_sidecar(&cmds), Ok(Kind::Cmd));
    assert_eq!((t.cmds().len(), t.signs().len()), (4, 14));
    assert_eq!(t.section_order(), vec![CMB1, SGN1]);
    let re = Trailer::load(&t.encode());
    assert!(re.parsed(), "{}", re.why());
    assert_eq!((re.cmds(), re.signs()), (t.cmds(), t.signs()));
    assert!(t.signs().iter().all(|s| t.find_sign(s.pos, s.a).is_some()));
    assert!(t.cmds().iter().all(|c| t.find_cmd(c.pos).is_some() && t.anchored_on(c.pos).cmds.len() == 1));
}

/// Quarry: one sign `"test"`, a = 4, b = 9, c = 1. Not on every machine (it wasn't on the one this
/// was written on), so it's looked up in the usual places.
#[test]
fn quarry_specimen() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let Some(path) = ["TEST WORLDS/quarry.eden", "TEST WORLDS/Quarry.eden"].iter().map(|r| root.join(r)).find(|p| p.exists())
    else {
        eprintln!("skipping: quarry.eden not present");
        return;
    };
    let world = std::fs::read(path).unwrap();
    let t = check("quarry", trailer_of(&world), 1, 0, &[SGN1]);
    let s = &t.signs()[0];
    assert_eq!((s.text(), s.a, s.b, s.c), (&b"test"[..], 4, 9, 1));
}
