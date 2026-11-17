// Shared fixtures for the per-area test modules (moved out of lib.rs, ROADMAP 33.5).
use super::*;

#[allow(unused_imports)]
use super::*;

/// Build an anonymous MmapMut from a byte vector (tests only — no file on disk).
pub(super) fn mmap_from_bytes(data: Vec<u8>) -> MmapMut {
    let mut m = MmapMut::map_anon(data.len()).expect("anon mmap");
    m.copy_from_slice(&data);
    m
}

/// Build the smallest valid .eden binary that exercises the parser and editor:
///   - 4 096-byte header section (pointer-table offset + name + padding)
///   - 32 768-byte chunk block at offset 4 096, chunk coord (0, 0)
///   - 16-byte pointer-table entry at offset 36 864
///
/// Test blocks pre-placed (all in column lx=3, ly=5 of chunk (0,0)):
///   z=0  (band 0, lz 0) → Wood  (type 7)   — tests z_min boundary
///   z=17 (band 1, lz 1) → Stone (type 2) + paint byte 5
///   z=48 (band 3, lz 0) → Dirt  (type 3)   — tests z_max boundary
///
/// Bystander block (different column, must survive delete):
///   lx=7, ly=2, z=32 (band 2, lz 0) → Grass (type 8)
pub(super) fn make_test_world() -> Vec<u8> {
    const HEADER: usize = 4096;
    const CHUNK:  usize = 32768;
    const ENTRY:  usize = 16;

    let chunk_off:   u32 = HEADER as u32;
    let ptr_off:     u32 = (HEADER + CHUNK) as u32;
    let total:       usize = HEADER + CHUNK + ENTRY;

    let mut b = vec![0u8; total];

    // Header: pointer-table offset at bytes 32–35 (little-endian u32)
    b[32..36].copy_from_slice(&ptr_off.to_le_bytes());
    // World name at 40–48
    b[40..49].copy_from_slice(b"TestWorld");

    // Helper: absolute byte index of block at (lx, ly, z) inside the chunk
    let block = |lx: usize, ly: usize, z: i32| -> usize {
        let band = (z / 16) as usize;
        let lz   = (z % 16) as usize;
        HEADER + band * 8192 + lx * 256 + ly * 16 + lz
    };
    let paint = |lx: usize, ly: usize, z: i32| block(lx, ly, z) + 4096;

    // Column under test: lx=3, ly=5
    b[block(3, 5,  0)] = 7; // Wood  — z_min boundary
    b[block(3, 5, 17)] = 2; // Stone
    b[paint(3, 5, 17)] = 5; // paint
    b[block(3, 5, 48)] = 3; // Dirt  — z_max boundary

    // Bystander: lx=7, ly=2, z=32
    b[block(7, 2, 32)] = 8; // Grass — must not be touched by delete

    // Pointer-table entry: (cx=0, cy=0) → chunk_off
    let pe = (HEADER + CHUNK) as usize;
    b[pe..pe+2].copy_from_slice(&0i16.to_le_bytes());   // cx
    b[pe+4..pe+6].copy_from_slice(&0i16.to_le_bytes()); // cy
    b[pe+8..pe+12].copy_from_slice(&chunk_off.to_le_bytes()); // file offset

    b
}

// Byte index of block/paint for lx=3,ly=5 relative to file start (chunk at 4096)
pub(super) const HEADER: usize = 4096;
pub(super) fn blk(lx: usize, ly: usize, z: i32) -> usize {
    let band = (z / 16) as usize;
    let lz   = (z % 16) as usize;
    HEADER + band * 8192 + lx * 256 + ly * 16 + lz
}
pub(super) fn pnt(lx: usize, ly: usize, z: i32) -> usize { blk(lx, ly, z) + 4096 }

/// Lamp buckets are `FxHashSet`s (unordered); tests compare a sorted `Vec`.
pub(super) fn sorted_lamps(s: &FxHashSet<[i32; 3]>) -> Vec<[i32; 3]> {
    let mut v: Vec<[i32; 3]> = s.iter().copied().collect();
    v.sort_unstable();
    v
}

/// `make_test_world()` plus a *second* directory entry for chunk (1, 0) whose offset carries a
/// nonzero high word (`chunk_off + 2^32`) — the signature of a chunk stored past the 4 GiB
/// mark, as seen on the real corrupted-mosaic worlds in `DIAGNOSE/DIAGNOSIS.md`. Chunk (0, 0)
/// still parses normally so the world loads at all; the bogus entry is correctly decoded as a
/// >4 GiB offset and then rejected by Pass B for pointing past EOF.
pub(super) fn make_test_world_with_high_offset_entry() -> Vec<u8> {
    let mut b = make_test_world();
    let mut entry = vec![0u8; 16];
    entry[0..4].copy_from_slice(&1i32.to_le_bytes());                      // cx = 1
    entry[4..8].copy_from_slice(&0i32.to_le_bytes());                      // cy = 0
    entry[8..16].copy_from_slice(&(HEADER as u64 + (1u64 << 32)).to_le_bytes());
    b.extend_from_slice(&entry);
    b
}

/// A directory entry whose high offset word (bytes [12..16]) is nonzero names a chunk stored
/// past the 4 GiB mark. Pass B must reject it for pointing past EOF (never inserted into
/// `chunk_map`) while the file's other, valid chunk still loads normally.
#[test]
pub(super) fn test_parse_rejects_bogus_high_offset_entry_but_loads_valid_chunk() {
    let world = parse_world_inner(mmap_from_bytes(make_test_world_with_high_offset_entry()))
        .expect("parse should still succeed");
    assert!(world.chunk_map.contains_key(&(0, 0)), "the valid chunk must still load");
    assert!(!world.chunk_map.contains_key(&(1, 0)), "the bogus >4 GiB entry must be excluded");
}

/// Stage 0 originally forced worlds like this into a read-only mode (since lifted once Stages
/// 1/3/5 closed the underlying corruption vectors — see the plan doc's "Lift the flag at the
/// end of Stage 5" note). Regression guard: editing the valid chunk in a world that carries a
/// stray >4 GiB directory entry elsewhere must succeed like any other edit.
#[test]
pub(super) fn test_with_edit_succeeds_despite_bogus_high_offset_entry() {
    let world = parse_world_inner(mmap_from_bytes(make_test_world_with_high_offset_entry()))
        .expect("parse should still succeed");

    let mut ws = WorldState::new();
    ws.world = Some(world);

    let result = with_edit(&mut ws, "delete", (0, 0, 15, 15), |world| {
        delete_blocks_inner(world, 0, 0, 15, 15, 0, 63, None);
        Ok(())
    });

    assert!(result.is_ok(), "edit must succeed: {:?}", result.err());
    assert_eq!(ws.world.as_ref().unwrap().bytes[blk(3, 5, 0)], 0, "chunk (0,0) must have been edited");
    assert!(!ws.undo_stack.is_empty(), "a normal edit must push an undo entry");
}

/// The u64-offset invariant, positive path (30.1 / audit C-05): a chunk stored past the 4 GiB
/// mark must parse, edit and undo with every byte landing at its true address. The file is
/// sparse (`set_len`), so it costs a few pages of disk. Unix only: NTFS sparseness needs
/// verifying on CI before this runs there.
#[cfg(unix)]
#[test]
pub(super) fn test_chunk_past_4gib_parses_edits_and_undoes() {
    use std::io::{Seek, SeekFrom, Write};
    const CHUNK: u64 = 32768;
    let far_off: u64 = (1u64 << 32) + HEADER as u64;
    let dir_off: u64 = far_off + CHUNK;
    let path = std::env::temp_dir().join(format!("vuencedit-4gib-{}.eden", std::process::id()));
    {
        let mut f = fs::File::create(&path).unwrap();
        let mut head = vec![0u8; HEADER];
        head[32..40].copy_from_slice(&dir_off.to_le_bytes()); // directory offset: u64
        head[40..49].copy_from_slice(b"TestWorld");
        f.write_all(&head).unwrap();
        // Near chunk (0,0) at HEADER stays zeros; the far chunk (1,0) is the one under test.
        let mut dir = Vec::new();
        for (cx, off) in [(0i32, HEADER as u64), (1, far_off)] {
            dir.extend_from_slice(&cx.to_le_bytes());
            dir.extend_from_slice(&0i32.to_le_bytes());
            dir.extend_from_slice(&off.to_le_bytes());
        }
        f.seek(SeekFrom::Start(dir_off)).unwrap();
        f.write_all(&dir).unwrap();
        f.set_len(dir_off + dir.len() as u64).unwrap();
    }
    let result = std::panic::catch_unwind(|| {
        let world = parse_world_inner(map_staged_temp_ex(&path).unwrap().0).expect("parse");
        assert_eq!(world.chunk_map.get(&(1, 0)).copied(), Some(far_off as usize), "far chunk keeps its full u64 offset");
        let mut ws = WorldState::new();
        ws.world = Some(world);
        let (ex, ey) = (16 + 3, 5); // chunk (1,0), local (3,5) — world coords are min_x-relative
        let min_x = ws.world.as_ref().unwrap().min_x;
        let ex = ex + (0 - min_x) * 16;
        let at = far_off as usize + 3 * 256 + 5 * 16 + 1; // band 0, lz 1
        with_edit(&mut ws, "far-edit", (ex, ey, ex, ey), |w| {
            set_block_abs(w, ex, ey, 1, 7, 5);
            Ok(())
        })
        .expect("edit");
        assert_eq!(ws.world.as_ref().unwrap().bytes[at], 7, "edit landed at the >4 GiB address");
        assert_eq!(ws.world.as_ref().unwrap().bytes[HEADER + 3 * 256 + 5 * 16 + 1], 0, "near chunk untouched");
        undo_edit_inner(&mut ws).expect("undo");
        assert_eq!(ws.world.as_ref().unwrap().bytes[at], 0, "undo restored the far byte");
    });
    let _ = fs::remove_file(&path);
    if let Err(e) = result { std::panic::resume_unwind(e); }
}

mod format;
mod undo;
mod save;
mod sculpt;
mod selection;
mod terrain;
mod epfab;
mod records;

pub(crate) use sculpt::{make_bumpy_world_grid, ws_with};
#[allow(unused_imports)]
pub(crate) use format::*;
#[allow(unused_imports)]
pub(crate) use undo::*;
#[allow(unused_imports)]
pub(crate) use save::*;
#[allow(unused_imports)]
pub(crate) use sculpt::*;
#[allow(unused_imports)]
pub(crate) use selection::*;
#[allow(unused_imports)]
pub(crate) use terrain::*;
#[allow(unused_imports)]
pub(crate) use epfab::*;
