# 02 — The `.eden` File Format

> **This document is a game-format reference**, usable independently of this
> editor. Sources of truth: [`MROB.txt`](../MROB.txt) (Robert Munafo's original
> reverse-engineering), the reference C# implementation in
> [`EdenWorldManipulator2.0/`](../EdenWorldManipulator2.0/), and this editor's
> parser in `src-tauri/src/lib.rs`.

A `.eden` world file is: a **192-byte header**, followed by **chunk block data**,
followed by a **chunk pointer table** (directory). The header points to the
directory; the directory points at each chunk's block data.

Files may be stored **compressed** — a ZIP wrapper (PK magic bytes) with deflate.
This editor detects the wrapper by magic bytes, not extension, and decompresses
before parsing.

## Header (192 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | i32/f32 | `level_seed` |
| 4 | 12 | 3× f32 | player `pos` (x, y, z) |
| 32 | 8 | **u64** | `directory_offset` — file offset of the chunk pointer table |
| 40 | 50 | bytes | `name[50]` (ASCII, null-padded) |
| 92 | 4 | i32 | `version` |
| 132 | 16 | bytes | `skycolors[16]` — 16-band sky color palette |
| 148 | 4 | — | `goldencubes` |

> The header is 192 bytes total (`0x0C0`). MROB's original dump calls it "3008
> octal" = 192 decimal.

### `version` and the two chunk formats

`version` is a hint, not authority — **`version` alone no longer determines the
chunk format** (see the "updated game" discovery below). The values observed in
the wild:

- **`version >= 5`** → **256z "New Dawn"** format (versions 5 and 6 seen in the
  wild), **authoritative**. 131,072 bytes/chunk.
- **`version <= 4`** → *usually* **64z legacy** format (Eden 2.1 and older).
  32,768 bytes/chunk. **But not always** — see below.

`version` out of the range `1..=1000` triggers legacy block-ID conversion.

When **writing**, `write_world_file` picks the version from `chunk_size`
(`>= 131072` → 5, else 4). Getting the version wrong causes misaligned reads.

⚠️ **A 2026-08 game update writes `version = 2` on 256z-sized (16-band) worlds.**
`TEST WORLDS/newblocks/` is one such world: header `version` = 2, but its chunks
are unambiguously 131,072 B (`header.home.z` = 246, impossible in a 64-tall
world; see "The creature-gap chunk-size detector" below for the arithmetic that
proves it). A `version <= 4` file can therefore be either a genuinely old 64z
world *or* one written by the updated game — the byte itself can't tell them
apart, only the chunk-size detector can. This is also the marker for the new
block types (112–127, see [03-blocks-and-colors.md](03-blocks-and-colors.md))
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
always reserves directly before the real directory — see the next section.
Only when the creature-gap test is ambiguous (neither or both chunk sizes
produce a valid gap) does detection fall back to the old **min-offset-gap
heuristic**: a valid 256z file never has two chunk data blocks closer than
131,072 bytes apart, so `min_gap >= 131072 → 256z, else 64z`. (See
`detect_chunk_size_by_creature_gap` and the `chunk_size = if version >= 5 …`
block in `lib.rs`.)

`num_bands = chunk_size / 8192` → **4** bands (64z) or **16** bands (256z).

### The creature-gap chunk-size detector

Both 64z and 256z worlds reserve a **400-slot × 60-byte `EntityData` creature
block** (24,000 bytes total) directly before the chunk directory — this is
`FileManager::deriveColumnSpans`'s reserved region in the game's own source
(`~/emod/Classes/FileManager.mm:634-666`), not slack. For a candidate
`chunk_size`, define:

```
gap = directory_offset − (max_chunk_data_offset + chunk_size)
```

`gap` is **valid** iff it is `0` (no creature block at all — true of every
VuencEdit-written world, which doesn't emit one) or a whole number of 60-byte
slots, `0 < gap ≤ 24000`. Trying `chunk_size ∈ {131072, 32768}` (256z checked
first) and taking the size for which the gap is valid — when exactly one of the
two is — identifies the real chunk size independent of `version` and even for a
**single-chunk** world, which the min-gap heuristic structurally cannot handle
(it needs ≥2 chunks to measure a gap at all). Verified unique against every
world sampled during this format's investigation, including both `quarry.eden`
(version 5, 30,299 chunks) and the updated-game `newblocks` world (version 2, 3
chunks).

`load_eden_template`'s directory decode uses the same coordinate gate (below)
but never runs this detector — the bundled `Eden.eden` template is always
131,072-byte 256z chunks by construction.

**Reading the creature block itself, and preserving it on rewrite (fixed
2026-08-18).** `creature_block_range(world) -> (start, end)` (lib.rs) recovers
the *actual* reserved gap for the currently-loaded world — `start` is the end
of the highest-offset real chunk, `end` is `directory_offset` read fresh from
the header — rather than assuming a fixed slot count. `get_creatures` used to
hardcode `BLOCK_SIZE = 200 slots × 60 B = 12,000 B` regardless of what the world
actually had, which silently read the **wrong half** of a 256z world's real
400-slot/24,000-byte block (it would read the block's second half as if it were
the whole thing, since `dir_off - 12000` lands 12,000 bytes short of the block's
true start). It now reads exactly `[start, end)`, capped at 400 slots. The two
*rebuilding* writers (`expand_world_from_template`, `materialize_flat_chunks_inner`)
previously dropped this region entirely — they wrote real/generated chunks
directly followed by the directory, with no gap — silently discarding whatever
the game had reserved there on any world that had one. Both now capture
`creature_block_range`'s bytes under the same read lock as `dir_trailer` and
re-emit them verbatim, in the same position (directly before the directory),
mirroring the `dir_trailer` re-emission on the other side of it. Tests:
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

> **This is the same layout the bundled `Eden.eden` template uses** — see the
> [Eden.eden Template](#edeneden-template) section. Earlier revisions of this doc
> described the two as different formats (`{i16 x, pad, i16 y, pad, u32 off, pad}`
> for saves vs. `{i32 x, i32 z, u64 off}` for the template). They are not: the
> narrow reading is what the two source references (`MROB.txt`, the C# manipulator)
> derived from small worlds, where the extra bytes were always zero and so looked
> like padding.
>
> ⚠️ **The offset is 64-bit, and it matters.** Reading only its low word resolves
> every chunk stored past the 4 GiB mark to `true_offset − 2³²`, landing misaligned
> inside two unrelated chunks — the "mosaic" corruption diagnosed in
> `DIAGNOSE/DIAGNOSIS.md` (two real >4 GiB worlds, ~10–14 % of chunks affected),
> fixed 2026-07-29. Byte `[12..16]` is the offset's high word, `0` below 4 GiB and
> `1` above, *not* padding.
>
> The **writers** were widened to match on **2026-07-31**. They previously emitted
> i16 coords + u32 offsets, which is byte-compatible with this layout for the
> positive, sub-4 GiB values they produce — but *not* for a negative chunk
> coordinate (the i16 sign bits wouldn't extend across the pad), and it forced
> "Expand from Template" to cap its output at 4 GB. Both now share
> `encode_dir_entry`, that cap is gone, and the header's `directory_offset` is
> written as the full u64 at `[32..40]`.
>
> The gate on that change was whether *the game's own reader* honors the full
> 64-bit field ("Eden writes 64-bit offsets" was proven by the two sample worlds;
> "Eden reads them" was not). It's now confirmed from the game's source
> (`~/emod`, its 2.1/64z-era build): `ColumnIndex.chunk_offset` and the header's
> `directory_offset` are both `unsigned long long`, and every seek goes through
> `-[NSFileHandle seekToFileOffset:]` with no narrowing cast anywhere in the
> offset arithmetic. **Residual risk of record:** that source is the 64z-era
> build; the shipped 256z binary is closed-source and shares the identical 16-byte
> entry layout, so the evidence transfers as strong but indirect. A >4 GiB
> expand-then-load-in-game test would be the direct proof.

### The chunk-coordinate gate, and the post-directory sign trailer

The game keys its in-memory chunk directory by `twoToOne(x,z) = (x<<15)|z`
(`~/emod/Classes/Util.mm:1053`), which returns its "invalid/corrupt, skip"
sentinel `0` for any `(x,z)` outside `0..1<<15` — so a directory row naming a
coordinate outside that range is unreachable in-game no matter what the file
claims. `is_chunk_coord` (`lib.rs`) enforces the same range on the read path;
chunk `(0,0)` is deliberately kept even though `twoToOne` also maps it to 0,
since every generated world and every test fixture actually sits there.

**Why this matters beyond correctness:** the game itself relies on this gate to
skip a **signs section it appends inside the chunk-directory region** rather
than as a true sidecar. Every row of that section is tagged `x = 0xffffffff`
(−1 as i32), which fails the coordinate gate and is silently skipped by the
game's own `FileManager::readDirectory` (`~/emod/Classes/FileManager.mm:556`,
which reads to EOF and drops any row whose `twoToOne` key is 0). Before this
gate existed, VuencEdit had **no** coordinate validation (`lib.rs`'s only check
was `off + chunk_size <= bytes.len()`), so these tag rows were parsed as real
chunks at wild coordinates like `(-1, 1953719668)` — the exact cause of the
`quarry.eden` load bug (garbage `w_chunks`/`h_chunks`, blank 2D views, a 3D-pane
crash from an unbuildable `GridHelper`). The tag-row structure, stripped of its
`ff ff ff ff` prefix:

```
"SGN1" | u32 payload_len   — wrapper row (payload_len = 12 × following row count)
i32 x, i32 y, i32 z        — sign world position   ┐
i32 a, i32 b, i32 c        — unknown (see below)    │ one 120-byte sign record
char text[96]              — NUL-padded ASCII       ┘ per every 10 tag rows
… more sign records, then zero-padding rows to fill out the directory slot
```

This is **byte-for-byte the same record layout as the sidecar sign file** (see
`signs_<world>.eden.dat` below) — a reader needs one record parser for both.

**Parsing.** `parse_world_inner`'s "Pass A½" runs after decoding every raw
directory row and before chunk-size detection (the tag rows manufacture a
60-byte offset gap that would otherwise poison a `version <= 4` file's min-gap
fallback — irrelevant to quarry, since its own `version` is 5, but exactly the
trap a `NewFormat256z` world could fall into). It finds the last row that
passes the coordinate gate via `rposition`, treats everything from there to the
end of the raw entries as a **trailer**, captures it verbatim (capped at 64
KiB — a multiple of 16 so it never splits a slot) into `LoadedWorld.dir_trailer`,
and drops any row that fails the gate *interior* to the real entries (never
captured — re-emitting interior garbage into a rebuilt file could feed a real
`SGN1` parser something it shouldn't see). A directory row must also start at
`off >= 192` (never inside the 192-byte header) in both the main decode and the
min-gap fallback's offset filter.

**Round-tripping.** `save_world_inner` writes `world.bytes` verbatim, so an
ordinary save/incremental-save preserves the trailer automatically — nothing to
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
path instead of captured as part of the trailer. Not observed in the wild —
every real trailer row seen so far is `ff ff ff ff`-prefixed — and widening the
predicate to "not admitted to the chunk map" would turn two legitimate
EOF-rejection cases into false-positive trailers, so this is left as a known
edge rather than "fixed" further.

### Per-chunk spans — a chunk is not always `chunk_size` long

A chunk's data runs from its directory offset until whatever comes next in the
file: the next chunk's offset, the directory itself, or EOF. Almost always that
distance is exactly `chunk_size`, and the nominal window is the real one.

**Not always.** Each of the two real >4 GiB worlds in `DIAGNOSE/DIAGNOSIS.md`
(§1.9) contains exactly one place where consecutive chunk offsets differ by
**107,072** instead of 131,072 — the two chunks overlap by 24,000 bytes, verified
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
`ChunkCache`, and the undo trio (`snapshot_chunks_full`, `diff_chunk`,
`restore_and_invert`) — a nominal-size snapshot would otherwise pull a
neighbour's bytes into the delta and write them back on undo. The `render_view_*`
ortho/elevation renderers are the one exception, and only because their callers
copy chunks into a scan buffer with short spans zero-padded first.

**Sparse storage:** normal worlds only save *edited* chunks. Most of the map is
absent from the directory, which is why the top-down view of a normal Eden world
has large gaps (and why the [template overlay](./10-features.md) exists).

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
| Standard (64z) | 32,768 B | 4 | 0–63 | min offset gap < 131072 |
| Extended (256z) | 131,072 B | 16 | 0–255 | min offset gap ≥ 131072 |

World Z ceiling = `num_bands * 16 - 1` (63 for 64z, 255 for 256z).

**Storage order note (raw chunk):** voxels are stored `lx*256 + ly*16 + lz`
(z-innermost). This matters when cross-referencing the template's RLE order,
which is *different* — see below.

### Key block types

(Full registry in [03 — Blocks & Colors](./03-blocks-and-colors.md).)

```
0 Air     1 Bedrock  2 Stone   3 Dirt    4 Sand    5 Leaves  6 Trunk  7 Wood
8 Grass   13 Brick   14 Slate  15 Ice    19 Cloud  20 Water  21 Fence 23 Lava
24–27 Stone Ramp (S/W/N/E)   28–31 Wood Ramp   32–35 Shingle Ramp   36–39 Ice Ramp
40–55 Wedges (4 families × 4 apex dirs)      56 Shingles   57 NeonSquare  58 Glass
59–61 Water ¾/½/¼            72 Lamp (lightbox)            73 NewFlower
82–110 Expansion pack   112–127 New-format blocks (see below)
```

## Sign records and per-world sidecar files (updated-game format)

A 2026-08 game update writes new-format worlds with signs stored in a **true
sidecar file** rather than the inline post-directory trailer described above —
`signs_<worldfile>.eden.dat` next to the `.eden` (⚠️ the game's naming is a
**prefix on the full file name including the extension**, e.g. `foo.eden` →
`signs_foo.eden.dat` — not a suffix/stem-swap, so the established
`wal_path`-style `OsString`-append idiom used elsewhere in this codebase does
not transfer to it). Layout:

```
"SGN1" | u32 version | u32 count | count × 120-byte record
```

Each record (same layout as the inline trailer's stripped rows, see above):

```
i32 x, i32 y, i32 z      world block coordinates
i32 a, i32 b, i32 c      unknown — see below
char text[96]            NUL-padded ASCII
```

`c ∈ {0,1,3}` is plausibly a facing, `a ∈ {3,4}` a face/kind, `b ∈ {2,17}` a
style — **unconfirmed**. Of four specimen signs collected alongside the
`newblocks` world, only one sits on a new-format block (type 121); the other
three sit on ordinary grass (type 8), so the position↔block relationship isn't
determined and neither is the meaning of `a`/`b`/`c`. A controlled specimen —
place signs one at a time on known blocks in known facings, save, diff — would
settle it.

Two more per-world companion files exist, both currently undocumented/unparsed
by design: `spacemap3_<worldfile>.eden.raw` (1,048,576 B, a 512×512×4 map-cache
image, cheap to regenerate — not user data) and `achievements.dat` (folder-global,
not per-world, unrelated to any single `.eden`).

**Status (Phase 4, landed 2026-08-18): signs are read and displayed, read-only.**
`src-tauri/src/signs.rs` — `parse_signs` (sidecar format) and `parse_inline_signs`
(strips the trailer's `ff ff ff ff` tags and its own outer `"SGN1"+length` wrapper
row, then delegates to `parse_signs`) are the one shared record parser for both
sources. `load_world` populates `WorldState.signs` once per load: sidecar
preferred if it exists beside the *source* path (never the staged temp — the
sidecar travels with the user's file, not the private working copy), else the
inline trailer. A missing/foreign/corrupt sidecar never fails the load, it just
means no signs. `get_signs` (Rust) converts each sign's raw `x`/`y` into
editor-local coordinates the same way `read_spawn`/`read_player_pos` do (`z` is
already an absolute height, no origin offset) and returns `facing` (`c`, still
just a hypothesis). Frontend: `MapCanvas.tsx` draws each sign as a small diamond
marker at its editor-local position; the Sidebar's Inspector tab lists sign text
+ position + facing via a `SignsList` component, shown only when the world
actually has signs. Both are read-only — nothing writes a sign, and `a`/`b`
still aren't surfaced anywhere, only kept on the parsed `Sign` struct for future
use.

Two more per-world companion files exist, both still currently undocumented/unparsed
by design (not signs, so out of scope for Phase 4): `spacemap3_<worldfile>.eden.raw`
(1,048,576 B, a 512×512×4 map-cache image, cheap to regenerate — not user data)
and `achievements.dat` (folder-global, not per-world, unrelated to any single
`.eden`).

⚠️ **Sidecar travel-with-world (download/upload/Save As/backups) is still not
implemented — Phase 5, not started, re-scoped and deliberately paused.** A live
network capture (`DOCUMENTATION/10-features.md`'s Part C) found the real desktop
client's own upload never sends a sidecar at all — signs travelled anyway because
they were already inline in the `.eden` bytes being uploaded. Whether Phase 5 is
needed at all (vs. local-copy hygiene only) is an open scope question the plan
flags for a human + Opus co-decision, not started here. All sidecar I/O happens
in Rust regardless: `src-tauri/capabilities/default.json` grants the frontend no
`fs` plugin access, so the frontend cannot stat or read these files itself.

## World staging & atomic saves

This editor never maps the user's file directly, and never writes over a file
in place. The rules (from `lib.rs`, and important to replicate in any editor that
shares files with the game):

- **`load_world` always maps a private temp copy.** Uncompressed worlds are
  `fs::copy`'d to `$TMPDIR/vuencedit_<ns>.eden`; compressed ones (PK magic) are
  decompressed there. Rationale: on Windows a memory-mapped file is *locked*
  against replace/delete, so mapping the source would make an atomic temp+rename
  save fail with a sharing violation; on Unix, writing over a still-mmapped file
  is UB. Mapping a throwaway copy sidesteps both.
- **The temp is mapped `MAP_SHARED`, not copy-on-write** (2026-08 memory pass §3).
  All three load paths — zip, raw, `load_autosave` — go through one helper,
  `map_staged_temp`, so they can't drift. Because the temp is a throwaway we own
  outright, letting edits land in it costs nothing and keeps every edited page
  file-backed and reclaimable under memory pressure; `MAP_PRIVATE` would turn each
  one into anonymous dirty RAM that can only go to swap, growing without bound
  across a long sculpt session.
  - The file must be reopened `read(true).write(true)` — `fs::File::open` is
    `O_RDONLY` and `map_mut` on it fails at *runtime* with `EACCES`
    (`ERROR_ACCESS_DENIED` on Windows) while compiling perfectly clean.
  - **Fallback to `map_copy`** on `VUENCEDIT_MAP=private`, on a macOS `statvfs`
    check finding less than ~1.25× the world's size free on the temp volume, or on
    any failure to take the writable mapping. The space check exists because
    `stage_copy` clones on APFS: the temp shares blocks with the source until it
    diverges, so every page a `MAP_SHARED` edit touches must allocate. Out of space
    at writeback, macOS raises **SIGBUS** — an instant abort with no chance to save
    — where `MAP_PRIVATE` would merely add swap pressure. Deliberately an env var
    rather than a Settings toggle: it would need a new `load_world` parameter for a
    knob no user can reason about.
  - ⚠️ **Consequence: the temp is no longer the pristine as-loaded image.** Nothing
    may assume it is — see the autosave base ordering below.
  - The test-only `map_fixture` stays `map_copy` on purpose: it maps the shared
    extracted fixture itself rather than a per-test copy, so a shared mapping would
    leak one editing test's mutations into every other test and into the fixture on
    disk.
  - No `madvise` in this pass: `MADV_DONTNEED` discards dirty `MAP_PRIVATE` pages
    and is unsafe on `MAP_SHARED` while `&LoadedWorld` borrows are live (they are,
    everywhere), and `advise` is `#[cfg(unix)]` so any call site needs a shim or the
    Windows build breaks. The problem it would have addressed — "we just paged in
    half the world" — is what the on-demand lamp index (§4) removed at the source.
- **`WorldMeta.was_compressed`** is tracked separately from the temp path (every
  load has a temp now).
- **Load never destroys the current session before success is certain.** The new
  file is fully staged and parsed (`parse_world_inner`) *before* any lock is
  taken; only then does one locked section swap in the parsed world and clear the
  old clipboard/undo/redo/lamp-index/temp. A corrupt or wrong-type file leaves the
  previously-loaded world untouched; a parse failure cleans up its own staged temp.
- **Full saves go through `atomic_write(path, bytes)`** — stage `<path>.savetmp`,
  then `fs::rename` over the destination. Used by `save_world_inner`,
  `save_world_compressed` (drops the zip file handle before rename — Windows can't
  rename an open file), and `save_prefab`.
- `save_world(compressed: bool, backup_compressed: bool)` → deflate-9 ZIP when
  `compressed`. ⚠️ `save_world` tries an **incremental in-place save** first (audit
  C2 Stage 4, below) — "every save is a temp+rename" is no longer the invariant.
- `close_world` releases world/clipboard/undo/temp. `sweep_stale_temps()` runs at
  startup to delete `vuencedit_*.eden` temps leaked by a previous clean quit
  (normal loads delete the prior temp; only a clean quit leaks one).

### Backups (`.bak` / `.bak.zip`)

Every save path (full, compressed, incremental) creates a one-time pre-save
snapshot of the destination through `make_backup_if_absent`, **only if no backup
of either form already exists** — the first-save snapshot is preserved across
every later save, compressed or not. `backup_compressed` (`AppSettings.backupCompressed`,
default off) selects the form:

- **Off (default):** `stage_copy` (the H4 `clonefile` helper — an O(1) APFS clone
  where available, a plain copy elsewhere) to `<path>.bak`.
- **On:** `zip_file_contents` deflates the **destination file's current on-disk
  bytes** — never `world.bytes`, which is what's about to be written, not what's
  there now — to `<path>.bak.zip` at deflate level 6 (level 9 buys ~1% on voxel
  data for several times the time, not worth it off the interactive path). Staged
  via a sibling `.tmp` + rename, same rationale as `atomic_write`.

Toggling the setting mid-session doesn't produce two backups: a pre-existing
plain `.bak` counts as "already backed up" even when `backup_compressed` is now
on, and vice versa.

## Incremental in-place save (audit C2 Stage 4)

A repeat ⌘S over the same file rewrites only the chunks that changed since that
file was last written, instead of pushing the whole world (plus `atomic_write`'s
staging copy) through the disk again — on a 2 GB world, the difference between
~8 s of I/O and ~0.1 s. This works only because a loaded world's byte layout is
fixed for its lifetime (see "Per-chunk spans" above): `chunk_map[(cx,cy)]` is a
*file* offset as much as a memory offset, so dirty chunks are addressable by
absolute offset without re-deriving anything.

**Dirty tracking (`WorldState.dirty: DirtyState`).** Four hook sites cover every
byte-mutating path: `with_edit_inner` marks the chunks `diff_chunk` actually
changed; `undo_edit_inner`/`redo_edit_inner` mark `entry.chunks`; `set_spawn_pos`/
`set_player_pos`/`rename_world`/`set_sky_grid` mark the header (they write bytes
0..192 directly, bypassing `with_edit`); `load_world`/`close_world` clear everything. `since_disk`
(chunks changed since `disk_image.path` was last fully known-good) is what
`try_incremental_save` reads. A `u64 seq`, bumped by every mark and by
`clear_all`, guards the read-guard/write-guard gap described below — see the
"Deviation from the plan" note in `TEST WORLDS/c2-stage5-handoff-2026-08-05.md`
for why retain-by-written-coords wasn't enough.

**Eligibility** (`try_incremental_save`) — any failure declines to the full write
below, never an error, and the destination is guaranteed untouched on a decline:
caller's `compressed` flag is false and the recorded `DiskImage` isn't
compressed either; `DiskImage.path` resolves to the same file as the save target;
the destination's live `len`/`mtime` still match the recorded image (an external
modification — the game, a sync client, another editor instance — declines);
`since_disk`/`header_disk` is non-empty (an empty dirty set takes the full write
rather than silently no-op-ing — the cheap insurance against a missed hook site);
the dirty chunk count stays under half the world (a ⌘A-scale edit lands here by
design).

**Procedure**, all under one **read** guard (shared — rendering/panning/hovering
keep working during a save, C1's read-guard promise):

1. `.bak`/`.bak.zip` if absent (see above) — matters more here than for a full
   save, since an in-place write has no rename to fall back on.
2. Write `<path>.wal` in the journal wire format below (uncompressed —
   latency-sensitive and short-lived), append a **commit** record, `fsync` the
   WAL and its parent directory. Nothing has touched the destination yet.
3. `pwrite` each dirty span into the destination at its absolute offset
   (`apply_spans_in_place`), `fsync` the destination.
4. Delete the WAL.

Then a brief separate **write** guard (`record_full_write`) clears the discharged
dirty state and re-records `DiskImage` from a fresh `metadata()` call — comparing
against `dirty.seq` first, so an edit that landed in the gap since the read guard
was dropped isn't silently lost (see the `seq` note above).

**Crash recovery.** `load_world` calls `recover_wal(path)` for every uncompressed
path it opens, before staging the temp copy, so what gets mapped is the repaired
file. Only a WAL ending in a **commit** record is rolled forward (idempotent —
records hold absolute bytes, not deltas, so replaying an already-applied log is a
no-op); anything else — no commit, a torn tail, bad magic, a `base_len` that
doesn't fit the destination — is discarded, because a torn log always predates
the first destination byte being written.

**Known limitation:** the repair happens on the *next* `load_world` of that exact
path, not eagerly. If something else rewrites the destination between a crash and
the next open, `recover_wal` still rolls the stale spans forward — the `base_len`
check only catches a length change, and the window is milliseconds.

## Journal wire format (`journal.rs`)

Shared by the autosave journal ([10 — Features](./10-features.md#autosave--crash-recovery))
and the incremental save's `.wal`. Self-contained — no `AppState`, no Tauri.

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

Replay applies records in order by absolute offset — last write wins, so
re-dirtying a chunk across ticks is handled by appending again — and stops
cleanly at the first record that's short, has a bad CRC, or whose
`file_off + raw_len` exceeds `base_len`; everything before that point is still
applied. That's what makes an append-only journal crash-safe without an fsync
per record. A `kind = 1` commit record marks "everything above is a complete
set": the autosave journal ignores it (partial replay beats nothing); the save
WAL requires it.

### Compressed flag vs. file extension (frontend)

`save_world`'s `compressed` flag is independent of the target path's extension —
it doesn't rename anything, and `load_world` detects zip-vs-raw by magic bytes
regardless of extension. But other tools (the game itself) may key off the
extension. So:
- `saveWorldAs()` silently corrects a mismatched `.eden`/`.zip` extension to match
  `saveCompressed` (fresh path choice — nothing to preserve).
- Plain `saveWorld(sourcePath)` (⌘S / Ribbon Save) can't rename the user's
  existing file, so it toasts a one-time warning per path/flag combo
  (`lastExtWarnRef`).

## Eden.eden Template

`Eden.eden` (~52 MB) is the pre-generated template bundled with the game: **32,400
RLE-compressed chunks** in a **180×180 grid** at absolute coords **4006–4185**
(centered at 4096). This editor can overlay it behind sparse worlds and bake it
into a full world file (see [10 — Features](./10-features.md) for the UI/commands).

**Directory format:** `{ i32 x, i32 z, u64 offset }` = 16 B/entry, parsed from
`directory_offset` — **the same layout regular saves use** (see [Chunk pointer
table](#chunk-pointer-table-directory)). `load_eden_template` decoded this
correctly from the start; the world reader is what was narrower, until 2026-07-29.

**Per-column RLE:** 4 sub-chunks, each a 2-byte **big-endian** payload size
followed by triplets `(block:u8, paint:u8, count:u8)` where `count ∈ 1..=127`.

**Voxel order mismatch (critical):**
- RLE decode order: `rle_i = lz*256 + ly*16 + lx` (**z-outer**).
- Eden raw storage order: `lx*256 + ly*16 + lz`.

These are *different permutations* — you must re-map on decode.

**Coordinate mapping** from user-local block `(px, py)` to template absolute chunk:
```
tx = px/16 + world.min_x
tz = py/16 + world.min_y
```
`WorldMeta` carries `abs_min_x`/`abs_min_y` for this.

Backend decode helpers:
- `decode_template_surface(data, col_offset, sky)` — fast surface-only decode
  (scans 4 bands high→low, keeps last non-air per xy). 1 KB out per chunk vs 32 KB
  raw; 32 MB for all 32,400 chunks.
- `decode_template_column(data, col_offset)` — full raw 32 KB decode, used only by
  `expand_world_from_template`.

**Expand output** writes i16 cx/cy + u32 offsets into the 16-byte entry (see the
writer caveat under [Chunk pointer table](#chunk-pointer-table-directory)), copying user
chunks (raw) + template chunks (RLE-decoded, **padded to `chunk_size` for 256z
worlds** — a bare 32 KB write would desync every later offset → corrupt file).

## Reference program flow (MROB verification)

MROB verified the format by observing that:
- The first 192 bytes contain the world name in ASCII and the directory offset.
- A flat world's first chunk is `01` (bedrock) + 15× `02` (stone) columns — the
  block data is arranged in vertical columns.
- Each 16×16 chunk = eight 4096-byte blocks (types + paints across bands) = 32,768
  bytes for the legacy format.
- The directory near end-of-file has 12×12 = 144 entries (visible area) with X/Y
  coords and valid chunk data offsets like `0x00300` → header's stored offset.
