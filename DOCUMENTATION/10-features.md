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

## Signs (`signs.rs`) — 256z-format plan Phase 4, landed 2026-08-18

Read-only display of the game's on-map signs. Full binary-format detail lives in
[02-file-format.md](02-file-format.md)'s "Sign records and per-world sidecar
files" section; the IPC shape is in
[04-ipc-reference.md](04-ipc-reference.md#signs-signsrs-256z-format-plan-phase-4-landed-2026-08-18).
Short version: `load_world` decodes signs from whichever source the world
actually has (sidecar file preferred, else the inline post-directory trailer —
see Part A of the file-format doc), `get_signs` exposes them with editor-local
coordinates, `MapCanvas.tsx` draws a small marker per sign, and the Sidebar's
Inspector tab lists their text/position/facing. Nothing writes a sign — `a`/`b`
stay unconfirmed and unsurfaced, `c` (facing) is shown as a raw number rather
than decoded into a compass direction, since the hypothesis is strong but not
proven (Part C3 below).

## Network / Eden servers (`network.rs`)

**HTTP only** (TLS fails against these servers). `app2.edengame.net` (current) /
`app.edengame.net` (legacy).

- **`search_worlds`** — response parser scans for `.eden`/`.name` line adjacency
  (a fixed stride-2 layout desynced on stray blank lines). `WorldBrowserModal` has
  Quality sort + date filters + Hide-junk.
- **`list_worlds`** (added 2026-08-18, Part C2 below) — browse with no search term,
  `?start=&sort=`. Shares `parse_world_list_response` with `search_worlds` (same
  response shape). `WorldBrowserModal.tsx` auto-calls `list_worlds(0, 2, server)`
  on open and on server switch whenever the query field is empty, with a "Load
  more" button appending the next page (`start = results.length so far` — the
  server never advertises a page size or total count, so this is a heuristic,
  not a real cursor). `sort`'s value semantics beyond "distinguishes an
  ordering" are unconfirmed; `2` is what the real client's own browse mode sent
  when captured.
- **`download_world`** — streams to disk (not buffering the whole body in RAM),
  decompresses file→file through a `take()`-capped reader
  (`MAX_DOWNLOADED_WORLD_BYTES = 2 GB`).
- **`upload_world`** — multipart, requires a PNG thumbnail (`UploadModal.tsx`).

### Verified against the live updated desktop client's own traffic (2026-08-18)

The "New Dawn v2" format plan's open question — whether the server publishes/accepts sign
sidecars, and whether the game's own upload/download needed reverse-engineering before touching
`WorldBrowserModal`/`network.rs` — was answered by capturing the real desktop client's own HTTP
traffic (passive `tcpdump` + `dpkt` TCP-stream reassembly; the client does **not** honor the OS
web-proxy setting, so a MITM proxy alone doesn't work against it — passive capture does, since the
server is plain HTTP, no TLS to strip). Findings:

- **Browse** (no search term) is `GET /list2.php?start=0&sort=2` — `start` paginates, `sort`
  selects an order. VuencEdit's `search_worlds` only ever sent `?search=<query>` and the frontend
  (`WorldBrowserModal.tsx` `doSearch`) refused to run with an empty query — there was no "browse
  all/recent worlds" mode, only search-by-name, unlike the real client. **Fixed 2026-08-18**: see
  the `list_worlds` entry above.
- **Search** (`?search=<term>`) and the plain-text `<id>.eden\n<name>.name\n` response format
  VuencEdit already parses are **byte-for-byte what the real client sends/receives** — no drift.
- **Upload** is `POST /upload2.php?uuid=<uuid>`, `uuid` generated **client-side** (confirmed: the
  real client does not GET anything first to obtain one, contrary to this file's previous comment)
  in the same `XXXXXXXX-XXXX-4XXX-8XXX-XXXXXXXXXXXX` shape VuencEdit already generates. The
  multipart body has **exactly two parts**, gzip-compressed world first then PNG preview, filenames
  literally `file.bin`/`image.bin` — but the field **names** are `uploaded` and `uploaded2`, *not*
  `file.bin`/`image.bin`. VuencEdit's `upload_world` used the wrong field names (`"file.bin"`,
  `"image.bin"`) until this was caught and fixed 2026-08-18 — a PHP endpoint keys `$_FILES` off the
  field name, not the filename, so every prior upload from this app was almost certainly landing in
  an unused `$_FILES` slot server-side while still getting back the same `200 OK` / `YES` success
  reply, i.e. **uploads looked successful in the UI but the file likely never reached the server.**
  There is also no third `submit` field in the real request (VuencEdit's old code sent one) — left
  unremoved since an extra ignored field is very unlikely to be the difference between success and
  failure, unlike the field-name mismatch.
- **No sidecar is ever sent or received over the wire.** A real upload — of a world whose local
  in-game copy *did* have signs — carried only the two parts above; nothing named after
  `signs_*.dat` or `spacemap3_*.raw`, and no third part at all. The uploaded world's own bytes
  (decompressed and inspected byte-for-byte) had its signs in the **inline post-directory `SGN1`
  trailer** described in [02-file-format.md](02-file-format.md) — the same structure diagnosed in
  `quarry.eden`'s load bug, now confirmed to be exactly what the current, live game produces for a
  normal save, not a one-off corrupt specimen. This strongly suggests the inline trailer is the
  *canonical* on-the-wire sign representation, and the standalone `signs_<file>.eden.dat` sidecar
  (as seen in `TEST WORLDS/newblocks/`) is a separate, likely local-only artifact whose relationship
  to uploads is still unconfirmed (not tested this session — no sidecar-carrying world's own upload
  was captured). **Practical consequence for Phase 4/5 of the format plan:** sign support built on
  top of the already-landed `dir_trailer` capture (Phase 1) required no new network code at all —
  inline signs already travel through every existing download/upload/save/Save-As path unmodified,
  since they're just bytes inside `world.bytes`. **Phase 4 (read/display) landed 2026-08-18** — see
  `02-file-format.md`'s sign-sidecar section and `04-ipc-reference.md`'s `get_signs` entry. Phase
  5's sidecar-travel work (download/upload/Save-As/backup handling of `signs_<file>.eden.dat`)
  still only matters for the separate, rarer sidecar case, and even there, whether it's worth
  sending over the wire at all is genuinely unclear — the live client didn't. **Not started**;
  the plan flags the scope decision itself as needing a sharper model + human judgment call before
  committing engineering time, not just more implementation.
- The response body on upload success is the literal 3 bytes `YES` (not JSON, not the world's id).
  Search/browse responses come from a `Server: Jetty(10.0.3)` backend.

Capture method for reproducing or extending this: `tcpdump -i <interface> -w x.pcap 'tcp port 80'`
while using the real game's World Browser, then reassemble per-stream payloads with `dpkt` (a
mitmproxy-based approach failed — the client doesn't route through the OS proxy setting even when
it's the only network path available). No sudo-requiring capture tooling needed to be left running
or installed system-wide; nothing about the client or server was modified.

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

⚠️ **Base ordering (2026-08 memory pass §3).** The world is mapped `MAP_SHARED`
over the staged temp (`map_staged_temp`), so edits land *in the file the base is
cloned from* — a clone taken while an edit is in flight can capture a chunk torn at
page granularity, which would load fine and be silently half-wrong. What makes this
safe is that `autosave_world_inner` establishes the base in a **step 0, before** the
read guard that captures the tick's spans. `dirty.since_base`/`header_base` are
monotone for a session (`mark_chunks`/`mark_header` only insert; the tick's cleanup
touches only the `_journal` sets, `record_full_write` only the `_disk` sets, and the
sole reset is `clear_all` on load/close), so every byte where the base differs from
the as-loaded image was written by an edit that called `mark_*` before releasing its
write guard — hence it is already in `since_base` when the spans are captured, ends
up in the journal, and is fully overwritten on replay. **Reversing that order
reintroduces silent voxel corruption**: an edit landing between capture and clone
would be baked into the base while absent from that tick's journal. No guard is held
across the clone's I/O. Pinned by
`test_shared_temp_divergence_is_covered_by_since_base`, which is the only autosave
test that maps its temp shared — `ws_with_temp_path` builds the world from `map_anon`
and structurally cannot observe the hazard.

Recovery: `get_autosave_info` offers it via `RecoveryModal`; the frontend calls
`load_autosave` (`format: 1`) or falls back to the old `get_autosave_path` +
`openFileAt` (`format: 0`). `load_autosave` mirrors `load_world` — stage the base,
**replay the journal by `pwrite`-ing into the staged temp file**, not into any
in-memory mapping, so the recovered temp is the recovered world before it is ever
mapped — then parse and swap in under lock.

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
  Its slot-count bug is fixed regardless of UI status — see `creature_block_range`
  in `02-file-format.md`/`04-ipc-reference.md`.
