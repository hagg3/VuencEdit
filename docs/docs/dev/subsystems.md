---
layout: doc
title: "Subsystems"
subtitle: "Texture packs, the template overlay, networking and PNG export."
---
{% raw %}
Cross-cutting features that don't belong to a single subsystem page. Rendering,
editing, undo and world generation have their own pages.

## Texture packs *(experimental)*

Block textures for the 3D views (FlyView3D) and block-picker swatches. The 2D
top-down map stays flat-color. Two input formats (detected by content, not
extension):
1. A **ZIP of named PNGs** (`stone.png`, may also bundle `atlas.png`/`atlas2.png`).
2. A bare **atlas image** (`atlas.png`: vertical strip of square tiles in the
   game's `BLOCK_TEXTURES` index order).

### Backend (`src-tauri/src/texturepack.rs`)

- **`BLOCK_FACE_TEX: [[&str; 3]; 128]`**: `[side, bottom, top]` tile name per
  block type (covering the 128 block IDs, including the new-format blocks).
- **`KNOWN_TEX_NAMES`**: 32 canonical tile names (lowercased, no extension). The
  ZIP scanner is case-insensitive and path-stripping.
- **`ATLAS1_MAP` / `ATLAS2_MAP`**: canonical name → tile index in the game's
  `atlas.png` / `atlas2.png`, **verified against the shipped atlases**, not the older `Constants.h` enum (which differs in
  several slots). atlas.png = 28 named tiles; atlas2.png = four groups of 8
  variants (glass 0–7 / fence 8–15 / water 16–23 / lava 24–31; base tile of each).
  App-name aliases: weeds→`grass_top2`, expansion→`blocktnt`, slate→`cobblestone`,
  wallpaper→`crystal`, lamp→`lightbox`, neonsquare→`gradient`.
- **`load_pack(path)`**: `PK` magic → `collect_tiles_from_zip` (named PNGs win
  over bundled atlas slices), else `collect_tiles_from_atlas_image` (auto-includes
  a sibling `atlas2.*` so a bare `atlas.png` also textures glass/fence/water/lava).
- **`assemble(tiles)`**: resizes to 32×32 nearest-neighbour, builds a vertical
  atlas: **row 0** = white sentinel; **rows 1..=N** = full-color tiles; **rows
  N+1..=2N** = brightness-normalized **grayscale** variants (mean luminance ~184).
  `gray_row_offset = N`. Mirrors the game's paired full-color / grayscale textures.
- **`face_color_and_row(pack, bt, paint, face_kind, fallback_rgb)`**: vertex
  color is always `block_color()`. Texture **row depends on paint**: unpainted
  (`paint==0`) → full-color row (`color × full ≈ natural`); painted (`paint!=0`) →
  grayscale row `color_row + gray_row_offset` (`paint × gray` = clean tint). ⚠️ Do
  not revert to always-full-color: painting a full-color tile double-tints.
- ⚠️ Apple **CgBI**-crushed PNGs (raw iOS `atlas.png` from a `.app` bundle) fail
  to decode, users must re-save as standard PNG first.

**UV orientation:** `push_quad_uv!(v1, v0)` / `push_tri_uv!(v1, v0)`: args swapped
so floor vertices get the tile bottom and ceiling vertices the top (Three.js
`DataTexture` with `flipY=false`, V increases downward in image space).

### Frontend

- `src/texturePack.ts`: `decodeAtlas(raw)` (`AtlasData` carries `grayRowOffset`),
  `BLOCK_TOP_TEX`, `tintedSwatch(bt, paint, atlas)` (samples the grayscale row when
  `paint !== 0`, else full-color; × `resolveColor`; cached data URL).
- App state: `texturePackPath` (persisted), `texturePackInfo: AtlasData | null`,
  `texEpoch` (increments on load/unload to force chunk reload). Auto-loads on
  startup from the saved path.
- `FlyView3D` / `BlockPaintPicker` accept `texturePack` + `texEpoch`; the 3D pane
  builds a shared `DataTexture` atlas and `reloadAllChunks()` on epoch change.

## Template overlay & Expand *(experimental)*

See [File Format](../file-format/#edeneden-template) for the `Eden.eden`
binary layout and the RLE format. Feature UI/behavior:

- **Overlay:** sparse worlds leave gaps in the top-down map; point the app at the
  game's `Eden.eden` to render surrounding terrain at 35% opacity behind edits.
  State: `templateLoaded`, `templatePath` (persisted), `showTemplateOverlay`.
  `MapCanvas` co-fetches the template tile in `loadTile()` when the overlay is on
  and draws it at `globalAlpha=0.35` first; user tiles composite on top (opaque
  pixels cover, alpha=0 reveals template). PNG export bakes the template at full
  opacity where the user has no chunks, seamless output.
- **Expand:** `expand_world_from_template(output_path, full_extent)` bakes template
  chunks into a new world file (`full_extent=true` = all 180×180, else within
  current bounds). Emits `"expand_progress"` events every 500 chunks; cancellable
  via `cancel_expand` (a separate `.manage()`d `ExpandCancel` AtomicBool, so it
  never contends with the edit mutex). Drops the lock before the (up to ~1 GB)
  write; `bail_too_large!` guards the u32 offset ceiling.

## Signs (`signs.rs`)

Read-only display of the game's on-map signs. Full binary-format detail lives in
[File Format](../file-format/)'s "Sign records and per-world sidecar
files" section; the IPC shape is in the [IPC Reference](../ipc-reference/).
Short version: `load_world` decodes signs from whichever source the world
actually has (sidecar file preferred, else the inline post-directory trailer -
see the file-format page), `get_signs` exposes them with editor-local
coordinates, `MapCanvas.tsx` draws a small marker per sign, and the Sidebar's
Inspector tab lists their text/position/facing. Nothing writes a sign, `a`/`b`
stay unconfirmed and unsurfaced, `c` (facing) is shown as a raw number rather
than decoded into a compass direction, since the hypothesis is strong but not
proven.

## Network / Eden servers (`network.rs`)

World browsing, download and upload talk to the community Eden servers over plain HTTP
(TLS isn't supported by these servers). Both the current and the legacy server are supported,
chosen with the `server` argument.

- **`search_worlds`**: the response parser scans for `.eden`/`.name` line adjacency (a fixed
  stride-2 layout desyncs on stray blank lines). `WorldBrowserModal` has a Quality sort, date
  filters and a Hide-junk toggle.
- **`list_worlds`**: browse with no search term. It shares its parser with `search_worlds`.
  The browser calls it on open and on server switch whenever the query field is empty, with a
  "Load more" button that requests the next page. The server never advertises a page size or
  total count, so paging is a heuristic rather than a real cursor.
- **`fetch_featured_worlds`** and the bundled legacy featured lists back the browser's featured view.
- **`download_world`**: streams to disk (no whole-body buffering), decompresses file to file
  through a `take()`-capped reader (`MAX_DOWNLOADED_WORLD_BYTES = 12 GiB`).
- **`upload_world`**: a multipart upload that requires a PNG thumbnail (`UploadModal.tsx`). The
  world is streamed rather than loaded into memory: `gzip_world_to_temp` compresses the source
  (raw, or a zip entry decompressed on the fly) into a temp file at gzip level 6, and
  `upload_body_with_progress` streams that file with a real `upload-progress` event every 1 MB.
  Peak RAM is a 256 KB buffer. ⚠️ The staging file exists to make `Content-Length` knowable: a
  gzip stream's length isn't known until it finishes, and streaming without a length would switch
  the request to chunked transfer encoding, which the server's endpoint doesn't accept. A guard
  deletes the temp file on every exit path, and startup sweeps any left behind by a crash.
- **Signs and sidecars are not uploaded separately.** The game's own client sends only the
  compressed world and its preview image. Signs travel inside the world's own bytes (the inline
  post-directory trailer described in [File Format](../file-format/)), so they follow every
  download, upload and save with no extra code.

## Export

- **PNG** (`export_png`): renders + PNG-encodes in Rust; no pixels over IPC.
  Composites the template overlay where active. The only export format left in
  this repo, a screenshot of the editor's own view, not a format conversion.

⚠️ OBJ, JSON and VOX static-geometry export, Source Engine VMF export and Minecraft schematic import
were removed from this repo. That work continues in the separate
[EdenToMC](https://github.com/hagg3/EdenToMC) project.

## Autosave & crash recovery

Autosave is **journaled** rather than a full copy of `world.bytes` every tick: each tick appends
only the dirty band runs of the chunks in `dirty.since_journal` (plus the header; the sets are
band-granular) to `autosave.journal` in the shared wire format
([File Format](../file-format/#journal-wire-format-journalrs) "Journal wire format"), replayed on recovery onto a
**base image**. A tick whose pending set is large relative to the world, or whose
journal has grown past a threshold, **compacts** instead, rewrites the journal from
scratch from everything that differs from the base, still far cheaper than a
full-world write.

**The base** is one of two
kinds (`WorldState.autosave: Option<AutosaveLineage>`, `AutosaveBase`):
- **Source**: the user's world file itself, pinned by a `FileIdentity` (path, len,
  mtime ns, file id: `(dev, ino)` on Unix, creation time on Windows). No copy at all.
  A raw load's `DiskImage` seeds it on the first tick, and **every uncompressed save
  re-bases onto the file it just wrote** (`rebase_after_save_inner`, called by
  `save_world` after `record_full_write`): old sidecars deleted meta-first, a fresh
  `base_id`, `since_base` cleared if `dirty.seq` didn't move. Compaction therefore
  only ever covers edits since the last save . The
  frontend doesn't call `discard_autosave` after a save.
- **Clone**: `autosave.base.eden`, `stage_copy` of the staged temp (an O(1) clone on
  APFS, a real copy elsewhere). The fallback for everything without a known on-disk
  twin: zip loads, recovered Clone sessions, compressed saves (which leave no
  lineage), and a Source file someone else wrote mid-session (the tick checks the
  identity and falls back). A Clone compacts from the monotone `since_load`.

`autosave.meta.json` (`AutosaveInfo`, written last via temp + rename) carries
`format: 2` plus `base: {kind: "source", path, len, mtime_ns, file_id} | {kind:
"clone"}`. `format: 1` (always a clone base) still recovers; `format: 0`
marks a legacy single-file autosave, still recognized and still deleted by
`discard_autosave`. An older build rejects `format: 2` and leaves the sidecar alone.

**Durability mutex.** `save_world`, `autosave_world` (`try_lock`: a tick during a save
is skipped and returns `false`, and the frontend retries next interval), `load_autosave`
and `discard_autosave` serialise on the static `DURABILITY`; lock order is always
durability → world guard. `WorldState.lineage_gen` (bumped by every re-base, discard,
load, close and recovery) makes a tick whose I/O straddled one of those drop its
discharge instead of resurrecting a deleted lineage.

⚠️ **Base ordering.** The world is mapped `MAP_SHARED`
over the staged temp (`map_staged_temp`), so edits land *in the file the base is
cloned from*, a clone taken while an edit is in flight can capture a chunk torn at
page granularity, which would load fine and be silently half-wrong. What makes this
safe is that `autosave_world_inner` establishes the base in a **step 0, before** the
read guard that captures the tick's spans. `dirty.since_load`/`header_load` (what a
Clone compacts from) are monotone for a session (`mark_chunks`/`mark_header` only insert; the tick's cleanup
touches only the `_journal` sets, `record_full_write` only the `_disk` sets, and the
sole reset is `clear_all` on load/close), so every byte where the base differs from
the as-loaded image was written by an edit that called `mark_*` before releasing its
write guard, hence it is already in `since_load` when the spans are captured, ends
up in the journal, and is fully overwritten on replay. **Reversing that order
reintroduces silent voxel corruption**: an edit landing between capture and clone
would be baked into the base while absent from that tick's journal. No guard is held
across the clone's I/O. Pinned by
`test_shared_temp_divergence_is_covered_by_since_base`, which is the only autosave
test that maps its temp shared, `ws_with_temp_path` builds the world from `map_anon`
and structurally cannot observe the hazard.

Recovery: `get_autosave_info` offers it via `RecoveryModal`; the frontend calls
`load_autosave` (`format` 1–2) or falls back to the old `get_autosave_path` +
`openFileAt` (`format: 0`). For a Source base, `get_autosave_info` also reports
`base_status` (`ok`/`changed`/`missing`, side-effect free; a committed save WAL beside
the file counts as `changed`) so the modal can explain a refusal up front: *changed*
offers **Open file** (discards the stale autosave), *missing* keeps the sidecars and
offers **Try again**. `load_autosave` first runs `recover_wal` on the source, checks
the identity, stages a copy, **re-checks** it (the file could change mid-copy), and only
then replays. A recovered Source session keeps its lineage and `base_id`, with the
replayed chunks marked dirty, so ⌘S afterwards is an incremental patch of the user's
file. ⚠️ **The trade:** a Source autosave needs the user's
file in place; a moved/deleted file or an unmounted drive blocks recovery until it's
back. `load_autosave` mirrors `load_world`: stage the base,
**replay the journal by `pwrite`-ing into the staged temp file**, not into any
in-memory mapping, so the recovered temp is the recovered world before it is ever
mapped, then parse and swap in under lock.

The replay is **streamed**: `journal::replay_each` decodes
one record at a time and each span is written into the temp as it arrives, so peak
memory is one chunk rather than every decompressed span at once. The journal is
capped at `base_len/10` *compressed* and voxel data deflates 5–20×, so before this
a large journal decompressed to roughly the whole world, a world-sized allocation
whose failure **aborts the process**, on the one path that exists because the user
already lost a session. Wire format and reject/truncate semantics are unchanged;
see [File Format](../file-format/#journal-wire-format-journalrs).

⚠️ **`recoverAutosave` does not delete the sidecar on recovery.** The autosave
timer only refires on the *next edit* (`lastAutosavedEpochRef` already matches the
just-loaded epoch), so a crash between recovery and the first edit/save would
otherwise lose the only copy. The sidecar stays on disk until a real Save re-bases
the lineage (in the backend) or the user declines a fresh prompt.

**Interrupted-save recovery is a separate mechanism** from autosave: a repeat ⌘S
over the same file can now write in place (see [File Format](../file-format/#incremental-in-place-save) "Incremental in-place save"). If that's
interrupted mid-write, `load_world` repairs the destination itself on the next
open of that exact path via a committed, fsynced `<path>.wal` redo log, no
sidecar, no recovery prompt, the file is simply correct the next time it's opened.
This repair is eager only on that specific path; if something else rewrites the
destination between the crash and the next open, the stale WAL is still rolled
forward (the `base_len` check only catches a length change).

⚠️ **The whole journal write runs under one read guard**,
so spans are borrowed straight out of the mapping rather than copied. Copying
`world.bytes[addr..end].to_vec()` per dirty chunk *before*
dropping the guard would be a problem on a compact tick, where the coord set is monotone
for the session (`since_load`, Clone lineages only): after a ⌘A + Fill that is an uncompressed copy of every chunk in
the world (~11.8 GB on a 90k-chunk one, re-allocated every tick for the rest of the
session). A failed Rust allocation calls `handle_alloc_error`, which **aborts**: on
Windows, where a multi-GB transient must come from commit charge instead of being
absorbed by compressed memory, that is the editor vanishing mid-session on a timer
with no message. `try_incremental_save` rejects the same shape in its own doc for
the same reason. Peak is now bounded by the largest single chunk. Read guards are
shared, so rendering/panning/hovering and the 3D pane keep working for the duration
exactly as they do during a save; only edits queue.

That guard-hold also avoids a race. Discharging with
`since_journal.retain(|c| !written_chunks.contains(c))` after dropping the guard would lose edits:
a chunk both journalled this tick *and* re-dirtied during the I/O window would be retained out of
`since_journal` anyway, so its new bytes would never be journalled again. Discharge is
`discharge_autosave_journal`, `record_full_write`'s twin, clearing both
`since_journal` and `header_journal` wholesale on a `dirty.seq` match and **nothing
at all** on a mismatch . ⚠️ The lineage (`WorldState.autosave`) is recorded outside that
check: it names the base, not the flushed edits, and gating it would make the next tick
establish a new lineage (for a Clone, re-copying a multi-GB base). It *is* gated on
`lineage_gen`: a moved generation means a save/discard/load replaced the lineage
mid-tick, and the discharge does nothing. Pinned by `test_autosave_discharge_ignores_a_stale_capture` /
`..._clears_on_a_matching_capture`, and the wire format by
`test_autosave_journal_is_byte_identical_to_hand_encoded_records`.

A tick whose spans exceed `AUTOSAVE_PROGRESS_MIN_BYTES` (64 MB) announces itself
through the shared `LongOps` overlay as a non-cancellable **"Autosaving"** op -
below that it stays silent, since an overlay every few minutes would be noise.
Routing the span loop through `LongOpHandle::step` also stamps the working-set
access clock, so a minutes-long tick isn't mistaken for idleness by the Windows
trimmer. No frontend change was needed: `LongOpOverlay` is driven entirely by the
`long-op` event stream.

## Dirty guard

`close_world`, opening another world (`openFileAt`), and quitting all check
`isDirty()` and prompt if there are unsaved changes. Header-only writes
(rename-world, set-spawn) bump `editEpoch` so they aren't silently lost by the
guard. `window.destroy()` needs `core:window:allow-destroy`.

## Field diagnostics (`Help ▸ Diagnostics…`)

A release build needs a readout for RSS, page faults, GPU identity and fetch/frame latency, or a
report like "it lags and I got a white screen" can't be triaged past guessing.

- **`mem_stats`** (Rust, `src-tauri/src/lib.rs` and `mem.rs`): `os`/`arch` (`std::env::consts`), a
  hand-written `extern "system"`/`extern "C"` process-memory probe (`GetProcessMemoryInfo` on
  Windows including the **page-fault count**, which separates "the mmap is thrashing" from "the GPU
  is doing everything in software"; `mach_task_basic_info` + `task_events_info` on macOS), a
  system-RAM probe (`GlobalMemoryStatusEx` / `sysctlbyname hw.memsize`), and whatever is already
  tracked on `WorldState` (chunk size, bands, dimensions, header version, undo/redo bytes and group
  counts, overview-raster stats). No `windows-sys` or `sysinfo` dependency for two syscalls.
- **GPU identity** (`FlyView3D.tsx`): `getGpuInfo()` on `FlyView3DRef` reads
  `WEBGL_debug_renderer_info` off the pane's own already-live `THREE.WebGLRenderer`; it never
  allocates a context. `SOFTWARE_RENDERER_RE` is the shared software-rasterizer classification.
  An absent extension or a never-mounted pane reports `"unknown"`, deliberately distinct from
  "confirmed hardware".
- **Latency histograms and counters** (`src/perfCounters.ts`): three fixed-bucket
  (`<1,<2,<4,…,<1024,≥1024 ms`) `Uint32Array(12)` histograms (`get_chunk_geometry` round-trip,
  `fetch_tile`/`render_zslice_patch` round-trip, 3D frame time) plus plain counters (chunk fetches
  issued/dropped-stale/errored, WebGL context losses, geometry-budget-limited transitions). They
  are histograms only, because a per-event log is how a diagnostic turns into a leak. The 3D memory
  overlay (`GeomMemHud`) is controlled by the `showPerfHud` setting (Settings ▸ 3D, off by default).
- **The modal** (`DiagnosticsModal.tsx`): produces a plain-text report (easy to paste into chat) with
  **Copy to clipboard** and **Save as .txt…** (`write_text_file`). **Reset counters** lets you
  bracket a slowdown.
  ⚠️ **Privacy**: the world path, template path, texture-pack path and prefab directory are reported
  as **basename-only or `set`/`not set`**, never a full path (which would leak a Windows username),
  via the exported `basenameOnly()` helper. No world contents are ever included.
- **Out of scope**: no network telemetry (nothing is sent automatically; the user copies the text and
  chooses where it goes) and no crash reporter (a WebView2 renderer crash kills the page before any JS
  could report it).

## Hidden / re-enableable features

- **Sky editor**: `get_sky_grid`/`set_sky_grid` registered; UI hidden. Re-enable:
  add state + View toggle + 4×4 swatch panel.
- **Creature viewer**: `get_creatures` registered; MapCanvas has draw code; UI
  passes `creatures={[]}`. Re-enable: add state + View toggle + world-load fetch.
  See `creature_block_range` in [File Format](../file-format/).
{% endraw %}
