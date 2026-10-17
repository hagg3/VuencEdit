---
layout: doc
title: "File Format"
subtitle: "The .eden binary layout, block addressing, saving, and the Eden.eden template."
---
{% raw %}
> **This page is a game-format reference** that you can use without this editor. The sources
> are [Robert Munafo's original reverse-engineering](https://mrob.com/pub/vidgames/eden-file-format.html),
> the C# [Eden World Manipulator](https://github.com/jldeiro/EdenWorldManipulator2.0), the game's
> own open-source code, and this editor's parser in `src-tauri/src/lib.rs`.

A `.eden` world file is: a **192-byte header**, followed by **chunk block data**,
followed by a **chunk pointer table** (directory). The header points to the
directory; the directory points at each chunk's block data.

Files may be stored **compressed**: a ZIP wrapper (PK magic bytes) with deflate.
This editor detects the wrapper by magic bytes, not extension, and decompresses
before parsing.

## Header (192 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | i32/f32 | `level_seed` |
| 4 | 12 | 3× f32 | player `pos` (x, y, z) |
| 16 | 12 | 3× f32 | `home` (x, y, z), Set Point ▸ Home target, `set_spawn_pos` |
| 28 | 4 | f32 | `yaw`: initial camera yaw |
| 32 | 8 | **u64** | `directory_offset`: file offset of the chunk pointer table |
| 40 | 50 | bytes | `name[50]` (ASCII, null-padded) |
| 92 | 4 | i32 | `version` |
| 96 | 36 | bytes | `hash[36]`: verification hash of the shared world preview image |
| 132 | 16 | bytes | `skycolors[16]`: 16-band sky color palette |
| 148 | 4 |, | `goldencubes` |

> `home`, `yaw` and `hash[36]` are confirmed from a reference loader written by the game's
> creator rather than reverse-engineered. Its header struct lines up byte-for-byte with the rest
> of this table (12 B `Vector pos` + 12 B `Vector home` + 4 B `yaw` bringing
> `directory_offset` to its known offset 32; `version` + 36 B `hash` bringing
> `skycolors` to its known offset 132). `yaw` and `hash` aren't otherwise used
> by this project.

> The header is 192 bytes total (`0x0C0`). Munafo's original notes call it "3008
> octal", which is 192 decimal.

### `version` and the two chunk formats

`version` is a hint, not authority, **`version` alone no longer determines the
chunk format** (see the "updated game" discovery below). The values observed in
the wild:

- **`version >= 5`** → **256z "New Dawn"** format (versions 5 and 6 seen in the
  wild), **authoritative**. 131,072 bytes/chunk.
- **`version <= 4`** → *usually* **64z legacy** format (Eden 2.1 and older).
  32,768 bytes/chunk. **But not always**: see below.

`version` out of the range `1..=1000` triggers legacy block-ID conversion.

When **writing**, `write_world_file` picks the version from `chunk_size`
(`>= 131072` → 5, else 4). Getting the version wrong causes misaligned reads.

⚠️ **A 2026 game update writes `version = 2` on 256z-sized (16-band) worlds.**
A world saved by that update has header `version` = 2, but its chunks
are unambiguously 131,072 B (`header.home.z` = 246, impossible in a 64-tall
world; see "The creature-gap chunk-size detector" below for the arithmetic that
proves it). A `version <= 4` file can therefore be either a genuinely old 64z
world *or* one written by the updated game, the byte itself can't tell them
apart, only the chunk-size detector can. This is also the marker for the new
block types (112–127, see [Blocks & Colors](../blocks-and-colors/))
and the sidecar sign format (below): a 256z-sized world with a non-`5`/`6`
version is classified `NewFormat256z` (vs. `NewDawn256z` for version 5/6, and
`Legacy64z` for a genuinely 32,768-byte-chunk world).

### Format detection when parsing

```
version >= 5                          → 256z (131072 B/chunk, 16 bands), authoritative
version <= 4 (0, 2, 4, …)             → creature-gap detector (below), then min-offset-gap fallback
```

The **creature-gap detector** runs first for any non-`>=5` version and is what
correctly resolves the updated-game case above (min-gap cannot: a world with
only one saved chunk has no gap to measure). It exploits a structure the game
always reserves directly before the real directory, see the next section.
Only when the creature-gap test is ambiguous (neither or both chunk sizes
produce a valid gap) does detection fall back to the old **min-offset-gap
heuristic**: a valid 256z file never has two chunk data blocks closer than
131,072 bytes apart, so `min_gap >= 131072 → 256z, else 64z`. (See
`detect_chunk_size_by_creature_gap` and the `chunk_size = if version >= 5 …`
block in `lib.rs`.)

`num_bands = chunk_size / 8192` → **4** bands (64z) or **16** bands (256z).

### The creature-gap chunk-size detector

Both 64z and 256z worlds reserve a **400-slot × 60-byte `EntityData` creature
block** (24,000 bytes total) directly before the chunk directory, this is
`FileManager::deriveColumnSpans`'s reserved region in the game's own source
(`Classes/FileManager.mm`), not slack. For a candidate
`chunk_size`, define:

```
gap = directory_offset − (max_chunk_data_offset + chunk_size)
```

`gap` is **valid** iff it is `0` (no creature block at all, true of every
VuencEdit-written world, which doesn't emit one) or a whole number of 60-byte
slots, `0 < gap ≤ 24000`. Trying `chunk_size ∈ {131072, 32768}` (256z checked
first) and taking the size for which the gap is valid, when exactly one of the
two is, identifies the real chunk size independent of `version` and even for a
**single-chunk** world, which the min-gap heuristic structurally cannot handle
(it needs ≥2 chunks to measure a gap at all). Verified unique against every
world sampled during this format's investigation, including a large version 5 world
(about 30,000 chunks) and a small updated-game world (version 2, 3 chunks).

`load_eden_template`'s directory decode uses the same coordinate gate (below)
but never runs this detector, the bundled `Eden.eden` template is always
131,072-byte 256z chunks by construction.

**Reading the creature block itself, and preserving it on rewrite.** `creature_block_range(world) -> (start, end)` (lib.rs) recovers
the *actual* reserved gap for the currently-loaded world, `start` is the end
of the highest-offset real chunk, `end` is `directory_offset` read fresh from
the header, rather than assuming a fixed slot count. `get_creatures` reads exactly `[start, end)`, capped at 400 slots, rather than a
fixed 12,000 bytes (which would land on the wrong half of a 256z world's 24,000-byte
block). The two *rebuilding* writers (`expand_world_from_template`,
`materialize_flat_chunks_inner`) capture `creature_block_range`'s bytes under the same read
lock as `dir_trailer` and re-emit them verbatim, directly before the directory, so
whatever the game reserved there survives. Tests:
`test_creature_block_range_detects_reserved_gap`,
`test_creature_block_range_empty_when_no_gap`,
`test_materialize_preserves_creature_block`.

## Chunk pointer table (directory)

Located at `directory_offset`. **16 bytes per entry** in a regular save:

| Bytes | Type | Meaning |
|-------|------|---------|
| `[0..4]` | i32 | chunk X |
| `[4..8]` | i32 | chunk Y |
| `[8..16]` | u64 | data offset (byte offset of this chunk's block data) |

Decoded by `decode_dir_entry` (`lib.rs`), the single source of truth for this
layout on the read path; written by its inverse `encode_dir_entry`, which both
writers (`write_world_file`, `expand_world_from_template`) go through.

> **This is the same layout the bundled `Eden.eden` template uses**; see the
> [Eden.eden Template](#edeneden-template) section. Older references describe the two as
> different formats (`{i16 x, pad, i16 y, pad, u32 off, pad}` for saves vs.
> `{i32 x, i32 z, u64 off}` for the template). They are the same: the narrow reading came
> from small worlds, where the extra bytes were always zero and so looked like padding.
>
> ⚠️ **The offset is 64-bit, and it matters.** Reading only its low word resolves
> every chunk stored past the 4 GiB mark to `true_offset − 2³²`, landing misaligned
> inside two unrelated chunks. That "mosaic" corruption was seen on two real >4 GiB worlds
> (roughly 10 to 14 % of chunks affected). Byte `[12..16]` is the offset's high word, `0`
> below 4 GiB and `1` above, *not* padding.
>
> The **writers** use the same layout. A narrower layout (i16 coords + u32 offsets) is
> byte-compatible for positive, sub-4 GiB values but not for a negative chunk coordinate, and
> it would cap "Expand from Template" at 4 GB. Both writers share `encode_dir_entry`, and the
> header's `directory_offset` is written as the full u64 at `[32..40]`.
>
> The open question was whether *the game's own reader* honors the full 64-bit field.
> The game's source (its 2.1/64z-era build) says yes: `ColumnIndex.chunk_offset` and the header's
> `directory_offset` are both `unsigned long long`, and every seek goes through
> `-[NSFileHandle seekToFileOffset:]` with no narrowing cast anywhere in the
> offset arithmetic. **Residual risk of record:** that source is the 64z-era
> build; the shipped 256z binary is closed-source and shares the identical 16-byte
> entry layout, so the evidence transfers as strong but indirect. A >4 GiB
> expand-then-load-in-game test would be the direct proof.

### The chunk-coordinate gate, and the post-directory sign trailer

The game keys its in-memory chunk directory by `twoToOne(x,z) = (x<<15)|z`
(`Classes/Util.mm`), which returns its "invalid/corrupt, skip"
sentinel `0` for any `(x,z)` outside `0..1<<15`: so a directory row naming a
coordinate outside that range is unreachable in-game no matter what the file
claims. `is_chunk_coord` (`lib.rs`) enforces the same range on the read path;
chunk `(0,0)` is deliberately kept even though `twoToOne` also maps it to 0,
since every generated world and every test fixture actually sits there.

**Why this matters beyond correctness:** the game itself relies on this gate to
skip a **signs section it appends inside the chunk-directory region** rather
than as a true sidecar. Every row of that section is tagged `x = 0xffffffff`
(−1 as i32), which fails the coordinate gate and is silently skipped by the
game's own `FileManager::readDirectory` (`Classes/FileManager.mm`,
which reads to EOF and drops any row whose `twoToOne` key is 0). A reader without
this gate parses the tag rows as real chunks at wild coordinates like
`(-1, 1953719668)`, which gives garbage world dimensions, blank 2D views and a 3D crash. The tag-row structure, stripped of its
`ff ff ff ff` prefix:

```
"SGN1" | u32 payload_len  , wrapper row (payload_len = 12 × following row count)
i32 x, i32 y, i32 z       , sign world position   ┐
i32 a, i32 b, i32 c       , unknown (see below)    │ one 120-byte sign record
char text[96]             , NUL-padded ASCII       ┘ per every 10 tag rows
… more sign records, then zero-padding rows to fill out the directory slot
```

This is **byte-for-byte the same record layout as the sidecar sign file** (see
`signs_<world>.eden.dat` below), a reader needs one record parser for both.

**Parsing.** `parse_world_inner`'s "Pass A½" runs after decoding every raw
directory row and before chunk-size detection (the tag rows manufacture a
60-byte offset gap that would otherwise poison a `version <= 4` file's min-gap
fallback, which is exactly the trap a `NewFormat256z` world could fall into). It finds the last row that
passes the coordinate gate via `rposition`, treats everything from there to the
end of the raw entries as a **trailer**, captures it verbatim (capped at 64
KiB, a multiple of 16 so it never splits a slot) into `LoadedWorld.dir_trailer`,
and drops any row that fails the gate *interior* to the real entries (never
captured, re-emitting interior garbage into a rebuilt file could feed a real
`SGN1` parser something it shouldn't see). A directory row must also start at
`off >= 192` (never inside the 192-byte header) in both the main decode and the
min-gap fallback's offset filter.

**Round-tripping.** `save_world_inner` writes `world.bytes` verbatim, so an
ordinary save/incremental-save preserves the trailer automatically, nothing to
do there. The two *rebuilding* writers (`expand_world_from_template`,
`materialize_flat_chunks_inner`) do have to re-emit it explicitly, immediately
after the real directory entries, since they reconstruct the directory region
from scratch; both now take the world's captured `dir_trailer` and write it
back byte-for-byte. Sign records hold world block coordinates, never file
offsets, so relocating chunks during a rebuild never invalidates them.
`materialize_flat_chunks`'s coordinate parameter is validated with the same
`is_chunk_coord` gate before it can write an unaddressable chunk into a new
file.

**Known limitation:** an all-zero padding row *inside* a trailer would itself
pass the coordinate gate as `(0,0)` and get dropped by the interior-rejection
path instead of captured as part of the trailer. Not observed in the wild -
every real trailer row seen so far is `ff ff ff ff`-prefixed, and widening the
predicate to "not admitted to the chunk map" would turn two legitimate
EOF-rejection cases into false-positive trailers, so this is left as a known
edge rather than "fixed" further.

### Per-chunk spans: a chunk is not always `chunk_size` long

A chunk's data runs from its directory offset until whatever comes next in the
file: the next chunk's offset, the directory itself, or EOF. Almost always that
distance is exactly `chunk_size`, and the nominal window is the real one.

**Not always.** Each of two real >4 GiB worlds we examined contains exactly one place where consecutive chunk offsets differ by
**107,072** instead of 131,072, the two chunks overlap by 24,000 bytes, verified
byte-identical. A reader that assumes `chunk_size` reads 24,000 bytes of its
neighbour (roughly z ≥ 209 of that column); a *writer* that assumes it corrupts
the neighbour, which is an "edit writes outside the chunk boundary" vector
independent of the u64 offset bug and not fixed by it.

`parse_world_inner` therefore derives every chunk's real span after the offsets
are known and stores the short ones in `LoadedWorld.chunk_span` (a parallel map
keyed like `chunk_map`; absent key = full `chunk_size`, so it is empty for every
well-formed world, and non-empty parses log a warning). **The rule for all code
touching block bytes: bound with `LoadedWorld::chunk_range(cx, cy) -> (addr,
end)`, not `bytes.len()`.** That covers the render/edit/copy/paste loops,
`set_block_abs`/`read_block_abs`/`read_paint_abs`, `get_block_at` and its
`ChunkCache`, and the undo path (`EditView`'s band capture and `band_delta`,
`restore_and_invert`), a nominal-size capture would otherwise pull a
neighbour's bytes into the delta and write them back on undo. The crate's `view_{front,side,top}`
ortho renderers are the one exception, and only because their callers
copy chunks into a scan buffer with short spans zero-padded first.

**Sparse storage:** normal worlds only save *edited* chunks. Most of the map is
absent from the directory, which is why the top-down view of a normal Eden world
has large gaps (and why the [template overlay](../subsystems/) exists).

## Block addressing

Within a chunk's block data at base `addr`, a voxel at local `(lx, ly, lz)` and
world Z-band `band = z / 16` (`lz = z % 16`) is:

```
type  = addr + band*8192 + lx*256 + ly*16 + lz
paint = addr + band*8192 + lx*256 + ly*16 + lz + 4096
```

So each **band** is 8192 bytes: a 4096-byte block-type region followed
(offset +4096) by a 4096-byte paint region. Each region is `16×16×16 = 4096`
voxels. `lx` ranges 0–15, `ly` 0–15, `lz` 0–15.

| Format | Chunk size | Bands | Z range | Detection |
|--------|-----------:|------:|:-------:|-----------|
| Standard (64z) | 32,768 B | 4 | 0–63 | creature-gap detector, then min offset gap < 131072 |
| Extended (256z) | 131,072 B | 16 | 0–255 | `version >= 5`, else creature-gap detector, then min offset gap ≥ 131072 |

World Z ceiling = `num_bands * 16 - 1` (63 for 64z, 255 for 256z).

**Storage order note (raw chunk):** voxels are stored `lx*256 + ly*16 + lz`
(z-innermost). This matters when cross-referencing the template's RLE order,
which is *different*, see below.

### Key block types

(Full registry in [Blocks & Colors](../blocks-and-colors/).)

```
0 Air     1 Bedrock  2 Stone   3 Dirt    4 Sand    5 Leaves  6 Trunk  7 Wood
8 Grass   13 Brick   14 Slate  15 Ice    19 Cloud  20 Water  21 Fence 23 Lava
24–27 Stone Ramp (S/W/N/E)   28–31 Wood Ramp   32–35 Shingle Ramp   36–39 Ice Ramp
40–55 Wedges (4 families × 4 apex dirs)      56 Shingles   57 NeonSquare  58 Glass
59–61 Water ¾/½/¼            72 Lamp (lightbox)            73 NewFlower
82–110 Expansion pack   112–127 New-format blocks (see below)
```

## Sign records and per-world sidecar files (updated-game format)

A 2026 game update writes new-format worlds with signs stored in a **true
sidecar file** rather than the inline post-directory trailer described above -
`signs_<worldfile>.eden.dat` next to the `.eden` (⚠️ the game's naming is a
**prefix on the full file name including the extension**, e.g. `foo.eden` →
`signs_foo.eden.dat`: not a suffix/stem-swap). Layout:

```
"SGN1" | u32 version | u32 count | count × 120-byte record
```

Each record (same layout as the inline trailer's stripped rows, see above):

```
i32 x, i32 y, i32 z      world block coordinates
i32 a, i32 b, i32 c      unknown, see below
char text[96]            NUL-padded ASCII
```

`c ∈ {0,1,3}` is plausibly a facing, `a ∈ {3,4}` a face/kind, `b ∈ {2,17}` a
style, **unconfirmed**. Of four specimen signs we collected, only one sits on a new-format block (type 121); the other
three sit on ordinary grass (type 8), so the position-to-block relationship isn't
determined and neither is the meaning of `a`/`b`/`c`. A controlled specimen (place signs
one at a time on known blocks in known facings, save, diff) would settle it.

**Status: signs are read and displayed, read-only.**
`src-tauri/src/signs.rs`: `parse_signs` (sidecar format) and `parse_inline_signs`
(strips the trailer's `ff ff ff ff` tags and its own outer `"SGN1"+length` wrapper
row, then delegates to `parse_signs`) are the one shared record parser for both
sources. `load_world` populates `WorldState.signs` once per load: sidecar
preferred if it exists beside the *source* path (never the staged temp, the
sidecar travels with the user's file, not the private working copy), else the
inline trailer. A missing/foreign/corrupt sidecar never fails the load, it just
means no signs. `get_signs` (Rust) converts each sign's raw `x`/`y` into
editor-local coordinates the same way `read_spawn`/`read_player_pos` do (`z` is
already an absolute height, no origin offset) and returns `facing` (`c`, still
just a hypothesis). Frontend: `MapCanvas.tsx` draws each sign as a small diamond
marker at its editor-local position; the Sidebar's Inspector tab lists sign text
+ position + facing via a `SignsList` component, shown only when the world
actually has signs. Both are read-only: nothing writes a sign, and `a`/`b`
aren't surfaced anywhere, only kept on the parsed `Sign` struct.

Two more per-world companion files exist, both deliberately unparsed:
`spacemap3_<worldfile>.eden.raw` (1,048,576 B, a 512×512×4 map-cache image that is cheap to
regenerate, not user data) and `achievements.dat` (folder-global, unrelated to any single `.eden`).

⚠️ **The sidecar does not travel with the world** on download, upload, Save As or backups.
In a network capture of the real desktop client, its own upload never sent a sidecar at all.
Signs travelled anyway because they were already inline in the `.eden` bytes being uploaded.
Whether copying the sidecar is needed at all is an open question. All sidecar I/O happens
in Rust regardless: `src-tauri/capabilities/default.json` grants the frontend no
`fs` plugin access, so the frontend cannot stat or read these files itself.

## World staging & atomic saves

This editor never maps the user's file directly, and a full save never writes over the file
in place. The rules (from `lib.rs`, and important to replicate in any editor that
shares files with the game):

- **`load_world` always maps a private temp copy.** Uncompressed worlds are
  `fs::copy`'d to `$TMPDIR/vuencedit_<ns>.eden`; compressed ones (PK magic) are
  decompressed there. Rationale: on Windows a memory-mapped file is *locked*
  against replace/delete, so mapping the source would make an atomic temp+rename
  save fail with a sharing violation; on Unix, writing over a still-mmapped file
  is UB. Mapping a throwaway copy sidesteps both.
- **The temp is mapped `MAP_SHARED`, not copy-on-write.**
  All three load paths, zip, raw, `load_autosave`, go through one helper,
  `map_staged_temp`, so they can't drift. Because the temp is a throwaway we own
  outright, letting edits land in it costs nothing and keeps every edited page
  file-backed and reclaimable under memory pressure; `MAP_PRIVATE` would turn each
  one into anonymous dirty RAM that can only go to swap, growing without bound
  across a long sculpt session.
  - The file must be reopened `read(true).write(true)`: `fs::File::open` is
    `O_RDONLY` and `map_mut` on it fails at *runtime* with `EACCES`
    (`ERROR_ACCESS_DENIED` on Windows) while compiling perfectly clean.
  - **Fallback to `map_copy`** on `VUENCEDIT_MAP=private`, on a macOS `statvfs`
    check finding less than ~1.25× the world's size free on the temp volume, or on
    any failure to take the writable mapping. The space check exists because
    `stage_copy` clones on APFS: the temp shares blocks with the source until it
    diverges, so every page a `MAP_SHARED` edit touches must allocate. Out of space
    at writeback, macOS raises **SIGBUS**: an instant abort with no chance to save
   , where `MAP_PRIVATE` would merely add swap pressure. Deliberately an env var
    rather than a Settings toggle: it would need a new `load_world` parameter for a
    knob no user can reason about.
  - ⚠️ **Consequence: the temp is no longer the pristine as-loaded image.** Nothing
    may assume it is, see the autosave notes below.
  - The test-only `map_fixture` stays `map_copy` on purpose: it maps the shared
    extracted fixture itself rather than a per-test copy, so a shared mapping would
    leak one editing test's mutations into every other test and into the fixture on
    disk.
  - No `madvise` in this pass: `MADV_DONTNEED` discards dirty `MAP_PRIVATE` pages
    and is unsafe on `MAP_SHARED` while `&LoadedWorld` borrows are live (they are,
    everywhere), and `advise` is `#[cfg(unix)]` so any call site needs a shim or the
    Windows build breaks. The problem it would have addressed, "we just paged in
    half the world", is what the on-demand lamp index removed at the source.
- **`WorldMeta.was_compressed`** is tracked separately from the temp path (every
  load has a temp now).
- **Load never destroys the current session before success is certain.** The new
  file is fully staged and parsed (`parse_world_inner`) *before* any lock is
  taken; only then does one locked section swap in the parsed world and clear the
  old clipboard/undo/redo/lamp-index/temp. A corrupt or wrong-type file leaves the
  previously-loaded world untouched; a parse failure cleans up its own staged temp.
- **Full saves go through `atomic_write(path, bytes)`**: stage `<path>.savetmp`,
  then `fs::rename` over the destination. Used by `save_world_inner`,
  `save_world_compressed` (drops the zip file handle before rename, Windows can't
  rename an open file), and `save_prefab`.
- **Full save from the temp file.** When `WorldState.temp_shared` (the world is
  `MAP_SHARED` over `temp_path`) and the temp's length equals the mapping's,
  `save_world_progress` → `atomic_copy_from_temp`: `mmap.flush()` (msync), then
  `stage_copy(temp → <path>.savetmp)` (APFS `clonefile`, else a kernel copy), fsync, rename.
  The mapping is never read, so a full save no longer fills the working set; output is
  byte-identical to the write-through-mapping path, which remains the fallback for
  `MAP_PRIVATE`, a length mismatch, and compressed saves. The read guard is held across
  flush+copy, so no edit lands between them.
- `save_world(compressed: bool, backup_compressed: bool)` → deflate-6 ZIP when
  `compressed` (`SAVE_DEFLATE_LEVEL`; level 9 was only ~1 % smaller for several times
  the single-core time). ⚠️ `save_world` tries an **incremental in-place save** first
  (below), so "every save is a temp+rename" is not an invariant.
- **Zoomed-out tiles don't touch the mapping.** Once a chunk's overview-raster cells
  are filled (first zoomed-out tile) or preloaded from the `.vxr` store at load, LOD ≥ G uncapped
  tiles and edit patches are served from the raster, not from the mapped bytes, the pages stay
  cold. Edits drop the affected chunk's cells (`invalidate_derived`). See
  [2D Rendering](../rendering-2d/).
- `close_world` releases world/clipboard/undo/temp. `sweep_stale_temps()` runs at
  startup to delete `vuencedit_*.eden` temps leaked by a previous clean quit
  (normal loads delete the prior temp; only a clean quit leaks one).

### Backups (`.bak` / `.bak.zip`)

Every save path (full, compressed, incremental) creates a one-time pre-save
snapshot of the destination through `make_backup_if_absent`, **only if no backup
of either form already exists**, the first-save snapshot is preserved across
every later save, compressed or not. `backup_compressed` (`AppSettings.backupCompressed`,
default off) selects the form:

- **Off (default):** `stage_copy` (an O(1) APFS `clonefile`
  where available, a plain copy elsewhere) to `<path>.bak`.
- **On:** `zip_file_contents` deflates the **destination file's current on-disk
  bytes**, never `world.bytes`, which is what's about to be written, not what's
  there now, to `<path>.bak.zip` at the same `SAVE_DEFLATE_LEVEL` (6). Staged
  via a sibling `.tmp` + rename, same rationale as `atomic_write`.

Which backup counts as "already backed up" (`existing_backup`) is asymmetric: with
`backup_compressed` on, either a `.bak.zip` or a plain `.bak` does; with it off, only
a plain `.bak` does, so turning compression *off* after a `.bak.zip` exists makes one
plain `.bak` on the next save.

**Policy:** a plain `.bak` is a world-sized copy kept beside the
file forever (12 GB for a 12 GB world). The default stays off (a first save stays a
fast copy/clone rather than minutes of deflate); instead the UI says the size.
`backup_status(path, backupCompressed)` reports the existing backup's name + size or
the source file's size, and AppMenu ▸ Save shows it under the backup checkbox.

## Incremental in-place save

A repeat ⌘S over the same file rewrites only the chunks that changed since that
file was last written, instead of pushing the whole world (plus `atomic_write`'s
staging copy) through the disk again, on a 2 GB world, the difference between
~8 s of I/O and ~0.1 s. This works only because a loaded world's byte layout is
fixed for its lifetime (see "Per-chunk spans" above): `chunk_map[(cx,cy)]` is a
*file* offset as much as a memory offset, so dirty chunks are addressable by
absolute offset without re-deriving anything.

**Dirty tracking (`WorldState.dirty: DirtyState`).** Four hook sites cover every
byte-mutating path: `with_edit_inner` marks the chunks whose captured bands
actually changed (`capture_deltas`), via `finish_edit`, which reads each delta's
`ChunkDelta::band_mask()`; `undo_edit_inner`/`redo_edit_inner` mark the bands of the **inverse**
snapshots `restore_and_invert` returns (exactly the bytes just rewritten); `set_spawn_pos`/
`set_player_pos`/`rename_world`/`set_sky_grid` mark the header (they write bytes
0..192 directly, bypassing `with_edit`); `load_world`/`close_world` clear everything. `since_disk`
(chunks changed since `disk_image.path` was last fully known-good) is what
`try_incremental_save` reads. A `u64 seq`, bumped by every mark and by
`clear_all`, guards the read-guard/write-guard gap described below (retaining dirty state by
written coordinates isn't enough, because an edit can land in that gap).

**Band-granular.** Each `since_*` set is an `FxHashMap<(cx,cy), BandMask>` (`BandMask(u16)`,
bit `b` = band `b` of the chunk changed; `parse_world_inner` refuses `num_bands > 16` so the mask
can't truncate) and a merge ORs masks. Marks come from the undo deltas, which already list every
changed byte, so they're complete by construction and may over-mark bands (a `Full` delta marks
its lowest..highest band) but never chunks. `dirty_spans(world, &set)` is the one emitter all
three sinks share (autosave journal tick, WAL, in-place save): one `(file_off, cx, cy, bytes)` per
maximal run of dirty bands, clamped to `chunk_range`'s end (never `bytes.len()`), sorted by
offset. `dirty_bytes(world, &set)` (same clamp) feeds the compaction and incremental-save decline
thresholds, which are now in bytes, not chunks × `chunk_size`. Journal format unchanged, a chunk
may simply have several records, or one covering part of it. A one-block edit on a 256z world
owes one 8 KB record instead of 128 KB. Journal recovery replays by offset and marks the replayed
chunks `BandMask::ALL` (over-approximate, safe).

**Both flush paths now obey that one rule.** `discharge_autosave_journal` is now `record_full_write`'s
twin: clear `since_journal`/`header_journal` wholesale on a `seq` match, clear
**nothing** on a mismatch. Keep the asymmetry in both, re-writing an
already-correct chunk costs a few KB; forgetting one loses that edit silently.
Detail, and the read-guard hold that made it possible, in
[Subsystems](../subsystems/#autosave--crash-recovery).

**Eligibility** (`try_incremental_save`), any failure declines to the full write
below, never an error, and the destination is guaranteed untouched on a decline:
caller's `compressed` flag is false and the recorded `DiskImage` isn't
compressed either; `DiskImage.path` resolves to the same file as the save target;
the destination's live `len`/`mtime` still match the recorded image (an external
modification, the game, a sync client, another editor instance, declines);
`since_disk`/`header_disk` is non-empty (an empty dirty set takes the full write
rather than silently no-op-ing, the cheap insurance against a missed hook site);
the dirty **bytes** (whole bands) stay under half the world (a ⌘A-scale edit lands here by
design).

**Procedure**, all under one **read** guard (shared, rendering/panning/hovering
keep working during a save, C1's read-guard promise):

1. `.bak`/`.bak.zip` if absent (see above), matters more here than for a full
   save, since an in-place write has no rename to fall back on.
2. Write `<path>.wal` in the journal wire format below (uncompressed -
   latency-sensitive and short-lived), append a **commit** record, `fsync` the
   WAL and its parent directory. Nothing has touched the destination yet.
3. `pwrite` each dirty span into the destination at its absolute offset
   (`apply_spans_in_place`), `fsync` the destination.
4. Delete the WAL.

Then a brief separate **write** guard (`record_full_write`) clears the discharged
dirty state and re-records `DiskImage` from a fresh `metadata()` call, comparing
against `dirty.seq` first, so an edit that landed in the gap since the read guard
was dropped isn't silently lost (see the `seq` note above).

**Crash recovery.** `load_world` calls `recover_wal(path)` for every uncompressed
path it opens, before staging the temp copy, so what gets mapped is the repaired
file. Only a WAL ending in a **commit** record is rolled forward (idempotent -
records hold absolute bytes, not deltas, so replaying an already-applied log is a
no-op); anything else, no commit, a torn tail, bad magic, a `base_len` that
doesn't fit the destination, is discarded, because a torn log always predates
the first destination byte being written.

⚠️ **Two passes, and why**. The commit marker that gates
the whole repair is a property of the *end* of the log, so nothing can be applied
until the log has been read through once. The obvious way to get that, collect
every span, then check, held the log in RAM twice over, and the WAL is
**uncompressed** while `try_incremental_save` only declines past *half* the
world: on an 11.8 GB world that is a ~5.9 GB file plus ~5.9 GB of owned spans, on
the one path that runs precisely when the user's file is half-written. So
`recover_wal` streams `journal::replay_each` twice, pass 1 validates with a
no-op sink, pass 2 rewinds and `pwrite`s, and peak memory is one record. The
second read is sequential and comes out of page cache. A pass-2 failure leaves
the log on disk so the next open retries, which is what idempotency buys.

**Known limitation:** the repair happens on the *next* `load_world` of that exact
path, not eagerly. If something else rewrites the destination between a crash and
the next open, `recover_wal` still rolls the stale spans forward, the `base_len`
check only catches a length change, and the window is milliseconds.

## Journal wire format (`journal.rs`)

Shared by the autosave journal ([Features](../subsystems/#autosave--crash-recovery))
and the incremental save's `.wal`. Self-contained, no `AppState`, no Tauri.

```
"VEJ1"      4 B    magic
flags       u32    bit0 = record payloads are raw-deflated
base_len    u64    expected byte length of the base image (sanity check on replay)
base_id     16 B   random per-session id, cross-checked against the meta sidecar
reserved    8 B
```

then an append-only stream of records:

```
kind        u8     0 = span, 1 = commit
file_off    u64    absolute offset into the base image   (kind 0 only)
cx, cy      i32,i32 chunk coords, or (i32::MIN, i32::MIN) for the header span (kind 0 only)
raw_len     u32    uncompressed payload length            (kind 0 only)
comp_len    u32    stored payload length                  (kind 0 only)
crc32       u32    of the *uncompressed* payload          (kind 0 only)
payload     comp_len bytes                                (kind 0 only)
```

Replay applies records in order by absolute offset, last write wins, so
re-dirtying a chunk across ticks is handled by appending again, and stops
cleanly at the first record that's short, has a bad CRC, or whose
`file_off + raw_len` exceeds `base_len`; everything before that point is still
applied. That's what makes an append-only journal crash-safe without an fsync
per record. A `kind = 1` commit record marks "everything above is a complete
set": the autosave journal ignores it (partial replay beats nothing); the save
WAL requires it.

**Replay is streaming**. It decodes one
record at a time and hands each clean span to a caller-supplied sink as a
**borrow of the decoder's own scratch buffer**, so peak allocation is the largest
single *record*, one chunk, and not the journal. Both shipping consumers
(`load_autosave_inner`, `recover_wal`) pwrite each span into the destination as
it arrives. That matters because the autosave journal is capped at `base_len/10`
*compressed* and voxel data deflates 5–20×, so a 1.2 GB journal on an 11.8 GB
world decompresses to roughly the whole world; a `Vec` allocation that size which
fails calls `handle_alloc_error`, i.e. **aborts**: no panic, no error dialog -
on the one path that runs after the user has already lost a session.

⚠️ Two properties that are easy to break and fail silently:

- **A span reaches the sink only after its bounds and CRC checks pass**, so
  interleaving decode with write never puts a corrupt record on disk. The
  on-disk result is byte-identical to decoding everything first, including for a
  torn journal, the clean-prefix-then-stop rule above is the contract being
  honoured in a different order, not a new policy.
- **`raw_len` and `comp_len` are `u32`s straight off disk.** The decoder must
  never size a buffer from either up front, or one corrupt record asks the
  allocator for gigabytes, reintroducing, in the recovery path, exactly the
  hazard this change removed. Both are bounded with `Read::take`, so a bogus
  length yields a short read (the truncation signal) instead of an allocation.

`journal::replay`, the collecting `Vec<Span>` form, still exists but is
**`#[cfg(test)]`-only**, in the same role `build_lamp_index` plays for the lamp
index: the easy-to-read reference implementation that the shipping decoder is
asserted to match (`streaming_replay_matches_the_collecting_form`, which pins each
edge case's absolute outcome *and* the two forms' agreement). There is one
decoder; the wrapper must never become a second one.

### Compressed flag vs. file extension (frontend)

`save_world`'s `compressed` flag is independent of the target path's extension -
it doesn't rename anything, and `load_world` detects zip-vs-raw by magic bytes
regardless of extension. But other tools (the game itself) may key off the
extension. So:
- `saveWorldAs()` silently corrects a mismatched `.eden`/`.zip` extension to match
  `saveCompressed` (fresh path choice, nothing to preserve).
- Plain `saveWorld(sourcePath)` (⌘S / Ribbon Save) can't rename the user's
  existing file, so it toasts a one-time warning per path/flag combo
  (`lastExtWarnRef`).

## Eden.eden Template

`Eden.eden` (~52 MB) is the pre-generated template bundled with the game: **32,400
RLE-compressed chunks** in a **180×180 grid** at absolute coords **4006–4185**
(centered at 4096). This editor can overlay it behind sparse worlds and bake it
into a full world file (see [Subsystems](../subsystems/) for the UI/commands).

**Directory format:** `{ i32 x, i32 z, u64 offset }` = 16 B/entry, parsed from
`directory_offset`: **the same layout regular saves use** (see [Chunk pointer
table](#chunk-pointer-table-directory)). `load_eden_template` has always decoded this correctly.

**Per-column RLE:** 4 sub-chunks, each a 2-byte **big-endian** payload size
followed by triplets `(block:u8, paint:u8, count:u8)` where `count ∈ 1..=127`.

**Voxel order mismatch (critical):**
- RLE decode order: `rle_i = lz*256 + ly*16 + lx` (**z-outer**).
- Eden raw storage order: `lx*256 + ly*16 + lz`.

These are *different permutations*, you must re-map on decode.

**Coordinate mapping** from user-local block `(px, py)` to template absolute chunk:
```
tx = px/16 + world.min_x
tz = py/16 + world.min_y
```
`WorldMeta` carries `abs_min_x`/`abs_min_y` for this.

Backend decode helpers:
- `decode_template_surface(data, col_offset, sky)`: fast surface-only decode
  (scans 4 bands high→low, keeps last non-air per xy). 1 KB out per chunk vs 32 KB
  raw; 32 MB for all 32,400 chunks.
- `decode_template_column(data, col_offset)`: full raw 32 KB decode, used only by
  `expand_world_from_template`.

**Expand output** writes the 16-byte `encode_dir_entry` layout (see
[Chunk pointer table](#chunk-pointer-table-directory)), copying user
chunks (raw) + template chunks (RLE-decoded, **padded to `chunk_size` for 256z
worlds**, a bare 32 KB write would desync every later offset → corrupt file).

## How the format was first worked out

Robert Munafo verified the format by observing that:
- The first 192 bytes contain the world name in ASCII and the directory offset.
- A flat world's first chunk is `01` (bedrock) + 15× `02` (stone) columns, the
  block data is arranged in vertical columns.
- Each 16×16 chunk = eight 4096-byte blocks (types + paints across bands) = 32,768
  bytes for the legacy format.
- The directory near end-of-file has 12×12 = 144 entries (visible area) with X/Y
  coords and valid chunk data offsets like `0x00300` → header's stored offset.
{% endraw %}
