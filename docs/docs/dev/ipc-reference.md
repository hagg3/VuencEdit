---
layout: doc
title: "IPC Reference"
subtitle: "Every backend command, grouped by subsystem."
---
{% raw %}
Every backend capability is a Tauri command, registered in the
`tauri::generate_handler!` block in `src-tauri/src/lib.rs`. This is the complete
surface, grouped by subsystem. Call from the frontend with
`invoke("command_name", { camelCaseArgs })`.

**Conventions**
- Rust `snake_case` params are **camelCased** on the JS side (`z_min` → `zMin`).
- Bulk binary data (`PixelPatch`/`PreviewData`/geometry/atlas) returns as a **raw
  binary envelope**, not JSON, see the section below; decode via the `decode*`
  helpers in `src/types.ts`.
- Editing commands return `EditResult { patch, invalidate, undo_depth, redo_depth,
  operation, undo_dropped }`. See [Editing, Undo & Clipboard](../editing-undo-clipboard/) for the last two.
- Commands marked **(async)** are `#[tauri::command(async)]` (off main thread).

## Binary payload envelope

Payload-carrying commands used to base64-encode their byte buffers inside a JSON
object. That cost a +33% size inflation, a full encode pass in Rust, a JSON string
the size of the whole payload, and a **per-byte `atob` loop on the JS main thread**
(five copies of every buffer). A ⌘A + Fill on a 451×528-chunk world produced a
243 MB patch → 324 MB base64 → a 243 M-iteration JS loop.

Tauri 2's `InvokeResponseBody::Raw` delivers a command's return value to JS as an
`ArrayBuffer` instead, so none of that is needed. One framing for every such
command, `ipc_envelope` in `lib.rs`, `decodeEnvelope` in `src/codec.ts`:

```
[0..4]                u32 LE   header_len
[4 .. 4+header_len]   JSON     the scalar fields (dimensions, counts, labels)
[4+header_len ..]     raw      the byte buffers, concatenated in declaration order
```

**Opting in is a trait impl, not a signature change.** The `#[tauri::command]`
macro requires `T: tauri::ipc::IpcResponse` for a `Result<T, E>`'s Ok type. Tauri
provides a blanket `impl<T: Serialize> IpcResponse for T`, but that does *not*
block a local impl on a **non-`Serialize`** local type. So each payload type drops
`#[derive(Serialize)]`, gains a small `…Header` struct that keeps it, and
implements `IpcResponse` to frame itself:

| Type | Header fields | Body |
|---|---|---|
| `PixelPatch` | `x, y, width, height, lod` | RGBA pixels |
| `EditResult` | `patch{…}, invalidate, undo_depth, redo_depth, operation, undo_dropped` | the patch's pixels (**empty** when `invalidate`) |
| `PreviewData` / `PreviewImage` | `width, height` | RGBA pixels |
| `SelectionMaskInfo` | `Option<{x1,y1,x2,y2}>` | row-major bitset (empty when `null`) |
| `TexturePackInfo` | `rows, tile, gray_row_offset, name_to_row` | RGBA atlas |
| `ObjGeometryResult` (format 1) | `vertex_count{,_t,_e}, lens[9]` | 9 f32 streams |

> ⚠️ **A payload type must not derive `Serialize`.** If it does, the blanket impl
> silently wins and the command quietly reverts to base64-in-JSON.

**Zero-copy on the JS side.** `decodeEnvelope` returns `body` as a *view* over the
response bytes; `decodePixelPatch`/`decodePreviewData` pass it straight to
`putImageData` (re-viewed as `Uint8ClampedArray`), and `decodeGeometry` splits it
with `splitBody(body, header.lens)` and views each stream with `asF32` for
`THREE.BufferAttribute`. `Float32Array` views require 4-byte alignment, which is
why `ipc_envelope` **space-pads the JSON header** until the body starts on a
4-byte boundary (JSON ignores trailing whitespace).

**Single-body payloads move, they don't copy.**
`ipc_envelope` builds a fresh `Vec::with_capacity(total)` and copies every body
into it, fine for the multi-buffer geometry payload, but it means a large pixel
payload is live **twice** in Rust before the webview allocates its own copy.
`ipc_envelope_one(header, body: Vec<u8>)` instead reserves exactly the framing's
length on the front of the body the renderer already produced and `splice`s it in:
no reallocation, peak stays at one copy. `PixelPatch`, `EditResult`, `PreviewData`,
`TexturePackInfo` and `SelectionMaskInfo` all use it; the framing it produces is
byte-identical (pinned by `test_ipc_envelope_framing`).

**The `Option` case.** `Option<T>` has no `IpcResponse` impl of its own, so a
command that can return "nothing" frames the absence itself: `get_selection_mask`
returns a `SelectionMaskInfo` whose header is an `Option<SelectionMaskHeader>`
- a literal JSON `null` header with an empty body. JS reads `header === null`.

**What's left of base64.** Only the **JS → Rust** direction: `encodeU8` in
`codec.ts` for `set_selection_mask`'s bitset. `serialize_bytes_b64` and `decodeU8`
are gone.

Tests: `test_ipc_envelope_framing` (lib.rs) pins the wire format, including the
alignment padding and the null-header case.

## World lifecycle

| Command | Signature (Rust) → returns | Notes |
|---|---|---|
| `load_world` **(async)** | `(path) → WorldMeta` | Stages a private temp copy, parses, then swaps in under lock. Never destroys current session before success. |
| `get_world_info` | `() → WorldInfo` | Name, seed, format/version, dims, chunk count, spawn, golden cubes, sky palette. |
| `rename_world` | `(name)` | Header-only write; bumps `editEpoch` so it isn't lost by the dirty guard. |
| `set_spawn_pos` | `(px, py) → (f32, f32)` | Writes the **`home`** field (header 16–27), the respawn point. Height resolves to one above the surface. Ribbon: Home ▸ Set Point ▸ Home. Caller bumps `editEpoch`. |
| `set_player_pos` | `(px, py) → (f32, f32)` | Writes the **`pos`** field (header 4–15), the last-walked position. Same abs/height convention; deliberately leaves `home` untouched. Ribbon: Home ▸ Set Point ▸ Start. Caller bumps `editEpoch`. |
| `get_player_pos` | `() → (f32, f32) \| null` | Reads `pos` back in editor coordinates; `null` = never walked. Mirrors `WorldInfo.spawn_px/py` for `home`. |
| `get_surface_z` | `(x, y) → Option<i32>` | Highest non-air Z at a column. |
| `save_world` **(async)** | `(path, compressed, backupCompressed)` | Tries an incremental in-place patch first; falls back to atomic write (`compressed` → deflate-6 ZIP). `backupCompressed` picks `.bak` vs. deflated `.bak.zip` for the one-time pre-save backup. See [File Format](../file-format/). |
| `backup_status` **(async)** | `(path, backupCompressed) → { existing_name, existing_bytes, source_bytes }` | What the next save's one-time backup is/will be, the existing `.bak`/`.bak.zip` (which the save leaves alone) or the current file's size. Filesystem metadata only, no `AppState`. Drives AppMenu ▸ Save's size note. |
| `close_world` | `()` | Releases world/clipboard/undo/temp; reconciles saved-epoch refs. |
| `autosave_world` **(async)** | `(sourcePath) → bool` | Journaled: append-only compressed journal onto a base image, the user's file (Source) or, as a fallback, a one-time clone of the staged temp (Clone). `false` = skipped because a save holds the durability mutex. |
| `load_autosave` **(async)** | `() → WorldMeta` | Recovery counterpart to `load_world`: stages the autosave base, replays the journal into the staged temp, parses, swaps in. Legacy single-file autosaves (`format: 0`) still route through `load_world`. |
| `get_autosave_info` **(async)** / `get_autosave_path` / `discard_autosave` **(async)** | | Crash-recovery sidecar management. `AutosaveInfo` gains `base` + `base_status` (`ok`/`changed`/`missing`) for format 2. `save_world` owns the post-save autosave reset (re-base); the frontend only discards on close and on a declined recovery prompt. |

**Overview-raster side effects:** `load_world` preloads `<app_data>/overview/<key>.vxr` for non-zip loads; `close_world` / a world switch persist the raster if clean; an uncompressed `save_world` persists it after the save (seq-gated). `mem_stats` (Diagnostics) reports `overviewBytes`, `overviewGranularity` (0 = none built), `overviewServed`, `overviewScanned` and `overviewBudget`. See [2D Rendering](../rendering-2d/).

## Rendering (2D)

| Command | Returns | Notes |
|---|---|---|
| `fetch_tile` **(async)** | `PixelPatch` | Top-down tile. Optional `lod` (world blocks per pixel), see [2D Rendering](../rendering-2d/). |
| `set_overview_budget` **(async)** |, | `(bytes)`, overview-raster byte budget, clamped 4–256 MB; drops the open world's raster if its granularity would change. Sent by `pushBackendBudgets()` with the undo budget. |
| `export_png` **(async)** |, | Renders + PNG-encodes in Rust; no pixels over IPC. |
| `set_view_cap` / `set_view_lod` / `set_view_relief` |, | Cutaway cap Z, the tile LOD that edit patches render at, and Relief shading strength. They live on the backend state so editing commands don't each take them as arguments; the frontend refetches tiles after they resolve. |
| `chunk_occupancy` | `Uint8Array` | Row-major presence map for a block of chunk cells (1 = chunk exists), so the map can tell holes from terrain. |
| `render_zslice_patch` **(async)** | `PixelPatch` | Constant-Z horizontal layer. Takes the same optional `lod` as `fetch_tile`. |

See [2D Rendering](../rendering-2d/).

## Editing (all go through `with_edit`, return `EditResult`)

| Command | Purpose |
|---|---|
| `delete_blocks` | Delete blocks in region (optional filter). |
| `replace_blocks` | Replace one material with another. |
| `paint_blocks` | Fill/draw blocks. ⚠️ `z_offset: Option<i32>` (defaults 0), keep it optional. |
| `gradient_fill` | Dither-blend one block → another across an axis. |
| `fill_surface` | Fill at each column's surface Z. |
| `sculpt_terrain` | Heightmap sculpting (16 modes, see [Editing, Undo & Clipboard](../editing-undo-clipboard/)). |
| `extrude_selection` | N non-overlapping copies along an axis. |
| `move_selection` | Translate a selection. |
| `generate_trees` | Multi-type tree placement over a selection. |
| `undo_edit` / `redo_edit` | Restore from delta stacks (not via `with_edit`). |
| `list_undo_stack` | Labels only, no chunk data. Backs the History tab. |
| `set_undo_budget` | Byte budget for the undo and redo stacks. Clamped server-side. |
| `fill_connected_face` | Re-skins the connected run of matching blocks on a face (3D Flood Fill). Goes through `paint_blocks`. |
| `flood_fill_3d` | Flood fill of connected air with a cell limit. |
| `simulate_flow` | Grows water or lava flow from source blocks inside a selection. |
| `pool_fill` | Fills a basin inside the selection up to a target Z. |
| `generate_wavy_surface` | Stamps a procedural ¾/½/¼ ripple pattern on a fluid surface. |
| `clear_selection_mask` | Drops the shaped-selection mask so edits go back to rectangular. |

`describe_selection`, `magic_wand_select`, `get_cursor_block`,
`pick_block_surface` are read-side helpers.

## Clipboard, paste & prefabs

| Command | Returns | Notes |
|---|---|---|
| `copy_selection` | `ClipboardInfo` | Captures a volume into the clipboard. |
| `rotate_clipboard` / `mirror_clipboard_x` / `mirror_clipboard_y` | `ClipboardInfo` | In-place transforms (ramp/wedge IDs remapped). |
| `paste_at` | `EditResult` | Normal paste (`z = z_anchor + offset`). |
| `paste_terrain` | `EditResult` | Per-column surface-aligned paste. |
| `scatter_paste` | `EditResult` | N random placements. |
| `array_paste` | `EditResult` | cols×rows grid with spacing. |
| `render_clipboard_preview` | `PreviewData` | Ghost preview. |
| `render_paste_lens(x, y, elevationOffset, mode, aboveSurface, ignoreAir, context, maxPx?)` | `PasteLensPatch` (two-buffer raw envelope) | Front (looking north, columns = X) and side (looking east, columns = Y) elevations of an armed paste at origin `(x, y)` in `mode` `"normal"`/`"terrain"`; the bases are computed once and the two renders run under `rayon::join`. Async, one read guard. Header `{ front, side, lens: [frontBytes, sideBytes] }`, each view `{ width, height, lod, col_lo, z_lo, z_hi, footprint_lo, footprint_hi, ghost_z_min, ghost_z_max, buried, cleared, floating_cols, approx }` (the two share the Z window and counts); bodies = RGBA, row 0 = `z_hi`. TS: `decodePasteLensPair`. `lod` samples **columns only** (Z rows are 1:1); `context` clamped 0–16, `maxPx` default 512 (16–4096). `buried`/`cleared`/`floating_cols` are *cell* counts over the whole volume (`approx` = strided estimate above 16 M cells). Errors: no world, empty clipboard, unknown `mode`. See 05-rendering-2d "Paste lens elevation". |
| `render_selection_lens(x1, y1, x2, y2, zMin, zMax, context, maxPx?, top)` **(async)** | `SelectionLensPatch` (multi-buffer raw envelope) | The Lens's selection mode. `top: false` → front + side full-height elevations (`rayon::join`); `top: true` → only the top-down view of `zMin..=zMax` (on demand, never part of the default fetch). One read guard, `validate_selection`, shaped mask via `active_mask` (fail-safe exact bbox). Header `{ views: [{ kind: "front"\|"side"\|"top", width, height, lod, col_lo, row_lo (top only), footprint_lo, footprint_hi }], lens, z_lo, z_hi, terrain_z_hi }` (`z_lo/z_hi` = elevation rows, or the selection's z range for top). Selected blocks alpha 255, context / masked-out 128, else transparent. `context` 0–16, `maxPx` default 512 (16–4096). TS: `decodeSelectionLens`. See 05-rendering-2d "Lens renderers". |
| `save_prefab` / `load_prefab` |, / `ClipboardInfo` | `.epfab` gzip read/write (atomic). |
| `get_default_prefab_dir` | `String` | `<app_data_dir>/prefabs`. |
| `list_prefabs` | `Vec<PrefabEntry>` | Gallery listing + dims (uses the internal `read_prefab_header` helper). |
| `delete_prefab` / `rename_prefab` / `prefab_exists` | | Guard on `.epfab` extension. |
| `render_prefab_thumbnail` | `PreviewData` | Gallery thumbnail. |

## 3D geometry, lighting & picking (`geometry.rs`)

The live 3D geometry pipeline that `FlyView3D` and block picking depend on.

| Command | Returns | Notes |
|---|---|---|
| `get_chunk_geometry` | multi-stream geometry | One 16×16 chunk column for `FlyView3D`; opaque + transparent + emissive streams. Optional `zMin`/`zMax` clip the emitted band (omitted = full `0..=world_max_z`); the cutaway cap `view_cap_z` is intersected in server-side. `format`: 1 (default) = nine f32 streams, header `{vertex_count×3, lens[9]}`; **2** = compact indexed (VuencEdit always), header `{format: 2, origin, pos_scale, atlas_rows, streams[3]: {vertex_count, index_count, index_u32, lens[4]}}`, body per stream positions/colours/uvs/indices, each a multiple of 4 bytes. See [3D Rendering](../rendering-3d/) "Compact indexed vertex format". |
| `get_light_constants` | `LightConstants` | `LAMP_LIGHT_RADIUS`, `SHADOW_RAY_STEPS`: for the edit-sync reload rect. |
| `get_lamps_near` | `Vec<LampLight>` | Nearest lamps for GPU point lighting (cap 64). |
| `pick_block` | `PickResult` | DDA voxel raycast (Eden coords in). Returns hit + entry face normal. |
| `set_cursor_lock` |, | Native window-level cursor grab (Minecraft mouselook). |

See [3D Rendering](../rendering-3d/).

## Export

| Command | Notes |
|---|---|
| `export_png` **(async)** | Renders + encodes in Rust. Long-op `kind: "png"`, *not* cancellable. |

PNG is the only export in this repo: a screenshot of the editor's own top-down
view, not a format conversion. OBJ/JSON/VOX export moved to
[EdenToMC](https://github.com/hagg3/EdenToMC).

## Long operations

One progress-and-cancel contract is shared by every long-running command.

`LongOps` is managed state holding a monotonic id counter and the id the user asked to
cancel, a single slot, not a registry, because every long operation is modal in the
UI and only one runs at a time. Storing the *id* rather than a bare bool means a cancel
that arrives just after an operation finished can never leak onto the next one.

```rust
let op = ops.begin(&app, kind, label.into(), total_rows, cancellable);
op.step(done, "Writing chunks")?;   // emits (throttled) AND returns Err(LONG_OP_CANCELLED)
```

- Event name: **`long-op`**. The opening event carries
  `{ id, kind, label, phase, done, total, pct, cancellable, finished: false }`;
  progress events carry only what changed; `LongOpHandle::drop` emits
  `{ id, kind, finished: true }`. The frontend merges later events onto the opener, so
  `label`/`cancellable` survive the run.
- Throttled to whole-percent changes **and** a `LONG_OP_MIN_INTERVAL_MS` (80 ms) floor.
- `cancel_long_op(id)` sets the flag; `step` turns it into `Err("Cancelled")`, which
  propagates through the usual `?`.
- `kind` values include `"png"` and `"save"`. The enum still lists `"obj"`, `"json"` and
  `"vox"`, which nothing emits any more.
- **Saves report progress but are not cancellable**: `try_incremental_save` writes in
  place through a committed WAL that the next load rolls forward, so "cancel" has no
  coherent meaning there. `atomic_write_progress` / `save_world_compressed` chunk their
  writes at `SAVE_PROGRESS_CHUNK` (16 MB) to report.
- **Not on this contract:** `expand_world_from_template` and `materialize_flat_chunks` keep
  `ExpandCancel`/`MaterializeCancel` and their `expand_progress`/`materialize_progress`
  events, plus a dedicated modal.

## World generation (`worldgen.rs`)

| Command | Notes |
|---|---|
| `create_world` **(async)** | Flat world. |
| `create_natural_world` **(async)** / `preview_natural_world` **(async)** | Procedural biome pipeline + fast preview. |
| `create_classic_world` **(async)** | Legacy generator port. |
| `create_tg2_world` **(async)** / `preview_tg2_world` **(async)** | TerrainGen2 port + preview. |

See [World Generation](../world-generation/).

## Template overlay & expand

| Command | Notes |
|---|---|
| `load_eden_template` | `(path) → chunk_count`. Mmaps `Eden.eden`, parses its directory. |
| `fetch_template_tile` **(async)** | `PixelPatch`; alpha=0 where no template chunk. Takes `lod`; decodes only the template columns the sampled grid touches. |
| `expand_world_from_template` **(async)** | Bake template chunks into a new world file. `"expand_progress"` events. |
| `cancel_expand` / `cancel_materialize` | Set a separate cancel `AtomicBool`; expand deletes its partial output. |

## Network (`network.rs`)

| Command | Notes |
|---|---|
| `search_worlds` | `(query, server) → Vec<WorldSearchResult>`. HTTP only (TLS fails). |
| `list_worlds` **(async)** | `(start, sort, server) → Vec<WorldSearchResult>`. Browse with no search term. Same response shape and parser as `search_worlds`. |
| `fetch_world_preview` **(async)** | Raw preview image bytes for a world id (shown through a `blob:` URL, which the CSP allows). |
| `fetch_featured_worlds` **(async)** | The server's live featured/popular list. |
| `list_legacy_featured_lists` / `load_legacy_featured_list` | Bundled historic featured-world snapshots. The filename is validated so it can't escape the archive directory. |
| `download_world` **(async)** | Streams to disk, 12 GiB cap. |
| `upload_world` **(async)** | Multipart upload + PNG thumbnail. |
| `check_for_update` **(async)** | Looks up the latest release. Failures are swallowed by the caller. |

The current and legacy Eden servers are both supported, selected by the `server` argument.

## Texture packs & tables

| Command | Notes |
|---|---|
| `load_texture_pack` | `(path) → TexturePackInfo` (carries `gray_row_offset`). |
| `unload_texture_pack` |, |
| `get_block_tables` | `BlockTables`: canonical color tables installed on the frontend at startup. |

## Signs

| Command | Notes |
|---|---|
| `get_signs` | `Vec<SignInfo>`: `WorldState.signs`, populated once by `load_world` (sidecar preferred, else the inline `dir_trailer`), converted to editor-local x/y on the way out. Read-only. MapCanvas draws a marker per sign; Sidebar's Inspector tab lists them via `SignsList`. |

## Sky & creatures (registered, UI hidden)

| Command | Notes |
|---|---|
| `get_sky_grid` / `set_sky_grid` | 4×4 sky color grid. UI not wired. |
| `get_creatures` | `Vec<CreatureInfo>`. MapCanvas has draw code; UI passes `creatures={[]}`. Reads `creature_block_range(world)`. |

## Utilities

| Command | Notes |
|---|---|
| `write_text_file` | Writes text to a user-picked path (the Diagnostics "Save as .txt" button). No `AppState`. |
{% endraw %}
