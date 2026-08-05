# 10 — Features

Cross-cutting features that don't belong to a single subsystem doc. Rendering,
editing, undo, and world gen have their own files (05–08).

## Texture packs *(experimental)*

Block textures for the 3D views (FlyView3D + ThreeDPreview) and block-picker
swatches. The 2D top-down map stays flat-color. Two input formats (detected by
content, not extension):
1. A **ZIP of named PNGs** (`stone.png`, may also bundle `atlas.png`/`atlas2.png`).
2. A bare **atlas image** (`atlas.png` — vertical strip of square tiles in the
   game's `BLOCK_TEXTURES` index order).

### Backend (`src-tauri/src/texturepack.rs`)

- **`BLOCK_FACE_TEX: [[&str; 3]; 112]`** — `[side, bottom, top]` tile name per
  block type.
- **`KNOWN_TEX_NAMES`** — 32 canonical tile names (lowercased, no extension). The
  ZIP scanner is case-insensitive and path-stripping.
- **`ATLAS1_MAP` / `ATLAS2_MAP`** — canonical name → tile index in the game's
  `atlas.png` / `atlas2.png`, **verified against the shipped atlases**
  (`TEST WORLDS/atlas/`), not the older `Constants.h` enum (which differs in
  several slots). atlas.png = 28 named tiles; atlas2.png = four groups of 8
  variants (glass 0–7 / fence 8–15 / water 16–23 / lava 24–31; base tile of each).
  App-name aliases: weeds→`grass_top2`, expansion→`blocktnt`, slate→`cobblestone`,
  wallpaper→`crystal`, lamp→`lightbox`, neonsquare→`gradient`.
- **`load_pack(path)`** — `PK` magic → `collect_tiles_from_zip` (named PNGs win
  over bundled atlas slices), else `collect_tiles_from_atlas_image` (auto-includes
  a sibling `atlas2.*` so a bare `atlas.png` also textures glass/fence/water/lava).
- **`assemble(tiles)`** — resizes to 32×32 nearest-neighbour, builds a vertical
  atlas: **row 0** = white sentinel; **rows 1..=N** = full-color tiles; **rows
  N+1..=2N** = brightness-normalized **grayscale** variants (mean luminance ~184).
  `gray_row_offset = N`. Mirrors the game's paired full-color / grayscale textures.
- **`face_color_and_row(pack, bt, paint, face_kind, fallback_rgb)`** — vertex
  color is always `block_color()`. Texture **row depends on paint**: unpainted
  (`paint==0`) → full-color row (`color × full ≈ natural`); painted (`paint!=0`) →
  grayscale row `color_row + gray_row_offset` (`paint × gray` = clean tint). ⚠️ Do
  not revert to always-full-color: painting a full-color tile double-tints.
- ⚠️ Apple **CgBI**-crushed PNGs (raw iOS `atlas.png` from a `.app` bundle) fail
  to decode — users must re-save as standard PNG first.

**UV orientation:** `push_quad_uv!(v1, v0)` / `push_tri_uv!(v1, v0)` — args swapped
so floor vertices get the tile bottom and ceiling vertices the top (Three.js
`DataTexture` with `flipY=false`, V increases downward in image space).

### Frontend

- `src/texturePack.ts` — `decodeAtlas(raw)` (`AtlasData` carries `grayRowOffset`),
  `BLOCK_TOP_TEX`, `tintedSwatch(bt, paint, atlas)` (samples the grayscale row when
  `paint !== 0`, else full-color; × `resolveColor`; cached data URL).
- App state: `texturePackPath` (persisted), `texturePackInfo: AtlasData | null`,
  `texEpoch` (increments on load/unload to force chunk reload). Auto-loads on
  startup from the saved path.
- `FlyView3D` / `BlockPaintPicker` accept `texturePack` + `texEpoch`; the 3D pane
  builds a shared `DataTexture` atlas and `reloadAllChunks()` on epoch change.

## Schematic import (`schematic.rs`)

`.schematic` / `.litematic` / `.schem` → `import_schematic_info` → mapping-table
modal (`SchematicImportModal.tsx`) → `import_schematic_apply` → clipboard → paste.

**Axis mapping:** MC X → Eden X, MC Z → Eden Y, MC Y → Eden Z.

**Hardening:** the NBT parser caps recursion at `NBT_MAX_DEPTH = 64` (an untrusted
file with deeply nested List/Compound tags could overflow the stack). The three
gzip sites go through a shared `gunzip_capped()` (512 MB cap). Four block IDs
(56/67/95/203) were once silently importing as air due to shadowed match arms in
`mc_to_eden` — fixed.

## Template overlay & Expand *(experimental)*

See [02 — File Format](./02-file-format.md#edeneden-template) for the `Eden.eden`
binary layout and the RLE format. Feature UI/behavior:

- **Overlay:** sparse worlds leave gaps in the top-down map; point the app at the
  game's `Eden.eden` to render surrounding terrain at 35% opacity behind edits.
  State: `templateLoaded`, `templatePath` (persisted), `showTemplateOverlay`.
  `MapCanvas` co-fetches the template tile in `loadTile()` when the overlay is on
  and draws it at `globalAlpha=0.35` first; user tiles composite on top (opaque
  pixels cover, alpha=0 reveals template). PNG export bakes the template at full
  opacity where the user has no chunks — seamless output.
- **Expand:** `expand_world_from_template(output_path, full_extent)` bakes template
  chunks into a new world file (`full_extent=true` = all 180×180, else within
  current bounds). Emits `"expand_progress"` events every 500 chunks; cancellable
  via `cancel_expand` (a separate `.manage()`d `ExpandCancel` AtomicBool, so it
  never contends with the edit mutex). Drops the lock before the (up to ~1 GB)
  write; `bail_too_large!` guards the u32 offset ceiling.

## Network / Eden servers (`network.rs`)

**HTTP only** (TLS fails against these servers). `app2.edengame.net` (current) /
`app.edengame.net` (legacy).

- **`search_worlds`** — response parser scans for `.eden`/`.name` line adjacency
  (a fixed stride-2 layout desynced on stray blank lines). `WorldBrowserModal` has
  Quality sort + date filters + Hide-junk.
- **`download_world`** — streams to disk (not buffering the whole body in RAM),
  decompresses file→file through a `take()`-capped reader
  (`MAX_DOWNLOADED_WORLD_BYTES = 2 GB`).
- **`upload_world`** — multipart, requires a PNG thumbnail (`UploadModal.tsx`).

## Export

- **OBJ** (`export_obj`) — Eden→OBJ `v wx wz -wy` (note the `ov()` Y-negation, see
  [06](./06-rendering-3d.md#coordinate-mapping-the-one-rule-to-get-right)).
  Face-culled cubes + ramp prisms + wedge pyramids. One material per (bt, paint).
- **JSON** (`export_json`) — geometry dump.
- **PNG** (`export_png`) — renders + PNG-encodes in Rust; no pixels over IPC.
  Composites the template overlay where active.
- **VOX** (`export_vox`, hidden) — MagicaVoxel export exists but the menu item is
  commented out (the 256³ model limit + chunk-splitting are hard to validate
  without round-trip tooling).

OBJ/JSON export the current selection if one is active, else the whole world.

## Source Engine VMF export (`vmf_export.rs`) *(experimental)*

Exports a selection as editable Valve Hammer brushwork (`.vmf`, plain-text
keyvalues) plus an optional materials sidecar (`.vtf`/`.vmt`) — selection-only,
since Source caps a compile at 8,192 brushes.

- **Coordinate transform:** Eden `(x, y, z) → Source (x, −y, z) * units_per_block`
  (default 40 units/block — a 2-block-tall Eden player ≈ the 72-unit Source
  player hull).
- **Brush emission:** a **3D greedy box merge** (row → rect → box, keyed per
  `(block_type, paint)` so materials never blend across a boundary) collapses
  runs of same-material cells into cuboid brushes; opaque and transparent cells
  merge in separate passes. Ramp/wedge cells bypass merging — one 5-sided prism
  brush per cell. A brush-count guard (default 6,144, vs. Source's hard 8,192)
  leaves headroom for ramps/wedges and an optional skybox shell.
- **Texture modes:** **Dev** (default) points every solid at Source's built-in
  `dev/dev_measuregeneric01` — no sidecar needed, always resolves. **Flat color**
  (opt-in) writes a hand-rolled 16×16 flat-color `.vtf` + `LightmappedGeneric`
  `.vmt` per distinct `(block_type, paint)` combo into `materials/vuencedit/`.
  Either mode still keys each solid's Hammer editor tint to the real block
  color, so geometry stays visually distinguishable in the 2D/3D views even when
  every face shares one dev texture.
- **Merge across materials** (opt-in): fuses adjacent cells into maximal boxes
  regardless of block type, picking a dominant `(block_type, paint)` per box by
  majority vote — good for greyboxing a tiled floor into a handful of brushes;
  lossy by design (the tiling pattern itself is discarded).
- **Skybox auto-shell** (opt-in): six non-overlapping `tools/toolsskybox` slabs
  forming a hollow box around the export, plus a `light_environment` and
  `info_player_start` — so a shell-enabled export compiles into a walkable, lit
  standalone map with no manual Hammer setup.
- **IPC:** `export_vmf`/`estimate_vmf` (async), mask-aware from day one following
  `get_obj_geometry`'s pattern. `estimate_vmf` runs the identical merge+guard
  logic but skips the disk write, powering the export modal's live brush/side/
  material counter.
- **Known limitations:** adjacent independently-merged boxes aren't guaranteed
  vertex-aligned across a shared face (Source's compiler tolerates this, but a
  manual T-junction fix pass is worth running); exported water/glass are ordinary
  translucent solids, not swimmable volumes; no in-world light source (lamps)
  translates to a Source point light.

## Autosave & crash recovery

Audit C2 Stage 3 replaced the old single-file autosave (a full copy of `world.bytes`
every tick) with a **journaled** one: `autosave.base.eden` is established once per
session (`stage_copy` of the load-time temp — an O(1) zero-byte clone on APFS),
and each tick appends only the chunks in `dirty.since_journal` (+ header) to
`autosave.journal` in the shared wire format (`DOCUMENTATION/02-file-format.md`
"Journal wire format"). A tick whose pending set is large relative to the world,
or whose journal has grown past a threshold, **compacts** instead — rewrites the
journal from scratch from `since_base` rather than appending, still far cheaper
than a full-world write. `autosave.meta.json` (`AutosaveInfo`) carries
`format: 1` for the journaled sidecar; `format: 0` marks a legacy single-file
autosave, still recognized and still deleted by `discard_autosave`.

Recovery: `get_autosave_info` offers it via `RecoveryModal`; the frontend calls
`load_autosave` (`format: 1`) or falls back to the old `get_autosave_path` +
`openFileAt` (`format: 0`). `load_autosave` mirrors `load_world` — stage the base,
**replay the journal by `pwrite`-ing into the staged temp file**, not into any
in-memory mapping, so the "temp file == as-loaded image" invariant the *next*
session's base depends on still holds — then parse and swap in under lock.

⚠️ **`recoverAutosave` does not delete the sidecar on recovery.** The autosave
timer only refires on the *next edit* (`lastAutosavedEpochRef` already matches the
just-loaded epoch), so a crash between recovery and the first edit/save would
otherwise lose the only copy. The sidecar stays on disk until a real Save succeeds
(`saveWorld`/`saveWorldAs` call `discard_autosave`) or the user declines a fresh
prompt.

**Interrupted-save recovery is a separate mechanism** from autosave: a repeat ⌘S
over the same file can now write in place (audit C2 Stage 4, see
`DOCUMENTATION/02-file-format.md` "Incremental in-place save"). If that's
interrupted mid-write, `load_world` repairs the destination itself on the next
open of that exact path via a committed, fsynced `<path>.wal` redo log — no
sidecar, no recovery prompt, the file is simply correct the next time it's opened.
This repair is eager only on that specific path; if something else rewrites the
destination between the crash and the next open, the stale WAL is still rolled
forward (the `base_len` check only catches a length change).

**Known gap:** the journaled autosave's own guard-drop-then-`retain` window (step
1 drops the read guard for the journal I/O, then a write guard does
`since_journal.retain(|c| !written_chunks.contains(c))`) has the same race the
incremental save's `dirty.seq` was added to close, but hasn't been backported —
worst case a crash recovery is missing one tick's worth of one chunk, never the
user's own saved file.

## Dirty guard

`close_world`, opening another world (`openFileAt`), and quitting all check
`isDirty()` and prompt if there are unsaved changes. Header-only writes
(rename-world, set-spawn) bump `editEpoch` so they aren't silently lost by the
guard. `window.destroy()` needs `core:window:allow-destroy`.

## Hidden / re-enableable features

- **Sky editor** — `get_sky_grid`/`set_sky_grid` registered; UI hidden. Re-enable:
  add state + View toggle + 4×4 swatch panel.
- **Creature viewer** — `get_creatures` registered; MapCanvas has draw code; UI
  passes `creatures={[]}`. Re-enable: add state + View toggle + world-load fetch.
