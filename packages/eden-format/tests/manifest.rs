//! The crate's dependency rules, enforced: no `tauri` (pure file-format code, like voxel-core),
//! no `serde` (payload types never derive `Serialize`, so an app's IPC newtype can't be silently
//! reverted to base64-in-JSON), and the zstd pin stays exact (`tests/zstd_version.rs`).

#[test]
fn dependencies_stay_pure_and_pinned() {
    let toml = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    let deps: Vec<&str> = toml
        .lines()
        .skip_while(|l| l.trim() != "[dependencies]")
        .skip(1)
        .take_while(|l| !l.trim_start().starts_with('['))
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    let names: Vec<&str> = deps.iter().map(|l| l.split(['=', ' ']).next().unwrap()).collect();
    for banned in ["tauri", "serde", "serde_json"] {
        assert!(!names.iter().any(|n| n.starts_with(banned)), "eden-format must not depend on {banned}");
    }
    let pin = deps.iter().find(|l| l.starts_with("zstd-sys")).expect("zstd-sys is pinned directly");
    assert!(pin.contains("\"=2.0.16\""), "zstd-sys must stay pinned to =2.0.16 (+zstd.1.5.7): {pin}");
    assert!(!toml.contains("[dev-dependencies]"), "tests use the crate's own dependencies only");
}
