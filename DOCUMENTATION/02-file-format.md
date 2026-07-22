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
| `[0..2]` | i16 | chunk X |
| `[2..4]` | — | pad |
| `[4..6]` | i16 | chunk Y |
| `[6..8]` | — | pad |
| `[8..12]` | u32 | data offset (byte offset of this chunk's block data) |
| `[12..16]` | — | pad |

> ⚠️ The bundled `Eden.eden` **template** uses a *different* 16-byte directory
> layout: `{ i32 x, i32 z, u64 offset }`. See the [Eden.eden Template](#edeneden-template)
> section — do not confuse the two.

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
- **All saves go through `atomic_write(path, bytes)`** — stage `<path>.savetmp`,
  then `fs::rename` over the destination. Used by `save_world_inner`,
  `save_world_compressed` (drops the zip file handle before rename — Windows can't
  rename an open file), `autosave_world`, and `save_prefab`.
- `save_world(compressed: bool)` → deflate-9 ZIP when `compressed`.
- `close_world` releases world/clipboard/undo/temp. `sweep_stale_temps()` runs at
  startup to delete `vuencedit_*.eden` temps leaked by a previous clean quit
  (normal loads delete the prior temp; only a clean quit leaks one).

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

**Directory format (distinct from regular saves):** `{ i32 x, i32 z, u64 offset }`
= 16 B/entry, parsed from `directory_offset`.

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

**Expand output** writes standard-save directory format (i16 cx/cy), copying user
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
