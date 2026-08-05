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

`version` selects the chunk layout. The values observed in the wild:

- **`version >= 5`** → **256z "New Dawn"** format (versions 5 and 6 seen in the
  wild). 131,072 bytes/chunk.
- **`version <= 4`** → **64z legacy** format (Eden 2.1 and older; version 2 is
  also legacy). 32,768 bytes/chunk.

`version` out of the range `1..=1000` triggers legacy block-ID conversion.

When **writing**, `write_world_file` picks the version from `chunk_size`
(`>= 131072` → 5, else 4). Getting the version wrong causes misaligned reads.

### Format detection when parsing

```
version >= 5                    → 256z (131072 B/chunk, 16 bands)
version <= 4                    → 64z  (32768 B/chunk, 4 bands)
version out of range / ambiguous→ fall back to the min-offset-gap heuristic
```

The heuristic: a valid 256z file never has two chunk data blocks closer than
131,072 bytes apart, so `min_gap >= 131072 → 256z, else 64z`. (See `lib.rs`
around the `chunk_size = if version >= 5 { 131072 } …` block.)

`num_bands = chunk_size / 8192` → **4** bands (64z) or **16** bands (256z).

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
82–110 Expansion pack
```

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
`rename_world`/`set_sky_grid` mark the header (they write bytes 0..192 directly,
bypassing `with_edit`); `load_world`/`close_world` clear everything. `since_disk`
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
