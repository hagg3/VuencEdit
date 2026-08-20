# 04 — IPC Command Reference

Every backend capability is a Tauri command, registered in the
`tauri::generate_handler!` block in `src-tauri/src/lib.rs`. This is the complete
surface, grouped by subsystem. Call from the frontend with
`invoke("command_name", { camelCaseArgs })`.

**Conventions**
- Rust `snake_case` params are **camelCased** on the JS side (`z_min` → `zMin`).
- Bulk binary data (`PixelPatch`/`PreviewData`/geometry/atlas) returns as a **raw
  binary envelope**, not JSON — see the section below; decode via the `decode*`
  helpers in `src/types.ts`.
- Editing commands return `EditResult { patch, invalidate, undo_depth, redo_depth,
  operation, undo_dropped }` — see `07-editing-undo-clipboard.md` for the last two.
- Commands marked **(async)** are `#[tauri::command(async)]` (off main thread).

## Binary payload envelope *(2026-08-05, audit H2)*

Payload-carrying commands used to base64-encode their byte buffers inside a JSON
object. That cost a +33% size inflation, a full encode pass in Rust, a JSON string
the size of the whole payload, and a **per-byte `atob` loop on the JS main thread**
— five copies of every buffer. A ⌘A + Fill on a 451×528-chunk world produced a
243 MB patch → 324 MB base64 → a 243 M-iteration JS loop.

Tauri 2's `InvokeResponseBody::Raw` delivers a command's return value to JS as an
`ArrayBuffer` instead, so none of that is needed. One framing for every such
command — `ipc_envelope` in `lib.rs`, `decodeEnvelope` in `src/codec.ts`:

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
| `ObjGeometryResult` | `vertex_count{,_t,_e}, lens[9]` | 9 f32 streams |

> ⚠️ **A payload type must not derive `Serialize`.** If it does, the blanket impl
> silently wins and the command quietly reverts to base64-in-JSON.

**Zero-copy on the JS side.** `decodeEnvelope` returns `body` as a *view* over the
response bytes; `decodePixelPatch`/`decodePreviewData` pass it straight to
`putImageData` (re-viewed as `Uint8ClampedArray`), and `decodeGeometry` splits it
with `splitBody(body, header.lens)` and views each stream with `asF32` for
`THREE.BufferAttribute`. `Float32Array` views require 4-byte alignment, which is
why `ipc_envelope` **space-pads the JSON header** until the body starts on a
4-byte boundary (JSON ignores trailing whitespace).

**Single-body payloads move, they don't copy** *(audit C2, 2026-08-19)*.
`ipc_envelope` builds a fresh `Vec::with_capacity(total)` and copies every body
into it — fine for the multi-buffer geometry payload, but it means a large pixel
payload is live **twice** in Rust before the webview allocates its own copy.
`ipc_envelope_one(header, body: Vec<u8>)` instead reserves exactly the framing's
length on the front of the body the renderer already produced and `splice`s it in:
no reallocation, peak stays at one copy. `PixelPatch`, `EditResult`, `PreviewData`,
`TexturePackInfo` and `SelectionMaskInfo` all use it; the framing it produces is
byte-identical (pinned by `test_ipc_envelope_framing`).

**The `Option` case.** `Option<T>` has no `IpcResponse` impl of its own, so a
command that can return "nothing" frames the absence itself: `get_selection_mask`
returns a `SelectionMaskInfo` whose header is an `Option<SelectionMaskHeader>`
— a literal JSON `null` header with an empty body. JS reads `header === null`.

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
| `set_spawn_pos` | `(px, py) → (f32, f32)` | Writes the **`home`** field (header 16–27) — the respawn point. Height resolves to one above the surface. Ribbon: Home ▸ Set Point ▸ Home. Caller bumps `editEpoch`. |
| `set_player_pos` | `(px, py) → (f32, f32)` | Writes the **`pos`** field (header 4–15) — the last-walked position. Same abs/height convention; deliberately leaves `home` untouched. Ribbon: Home ▸ Set Point ▸ Start. Caller bumps `editEpoch`. |
| `get_player_pos` | `() → (f32, f32) \| null` | Reads `pos` back in editor coordinates; `null` = never walked. Mirrors `WorldInfo.spawn_px/py` for `home`. |
| `get_surface_z` | `(x, y) → Option<i32>` | Highest non-air Z at a column. |
| `save_world` **(async)** | `(path, compressed, backupCompressed)` | Tries an incremental in-place patch first (audit C2 Stage 4); falls back to atomic write (`compressed` → deflate-9 ZIP). `backupCompressed` picks `.bak` vs. deflated `.bak.zip` for the one-time pre-save backup. See `DOCUMENTATION/02-file-format.md`. |
| `close_world` | `()` | Releases world/clipboard/undo/temp; reconciles saved-epoch refs. |
| `autosave_world` **(async)** | `(...)` | Journaled: a one-time-per-session base clone + append-only compressed journal, not a full rewrite. |
| `load_autosave` **(async)** | `() → WorldMeta` | Recovery counterpart to `load_world`: stages the autosave base, replays the journal into the staged temp, parses, swaps in. Legacy single-file autosaves (`format: 0`) still route through `load_world`. |
| `get_autosave_info` / `get_autosave_path` / `discard_autosave` | | Crash-recovery sidecar management. |

## Rendering (2D)

| Command | Returns | Notes |
|---|---|---|
| `fetch_tile` **(async)** | `PixelPatch` | Top-down tile. Optional `lod` (world blocks per pixel) — see [05](05-rendering-2d.md). |
| `export_png` **(async)** | — | Renders + PNG-encodes in Rust; no pixels over IPC. |
| `render_zslice_patch` **(async)** | `PixelPatch` | Constant-Z horizontal layer. Takes the same optional `lod` as `fetch_tile`. |
| `render_yslice_patch` **(async)** | `PixelPatch` | Constant world-Y plane (X×Z), row 0 = highest Z. |
| `render_xslice_patch` **(async)** | `PixelPatch` | Constant world-X plane (Y×Z). |
| `render_selection_view` **(async)** | `PreviewData` | Orthographic front/side projection of a selection. |
| `render_full_height_view` **(async)** | `PreviewData` | Full front/side elevation of the footprint. |
| `render_axo_region` **(async)** | `PixelPatch` | Axonometric (isometric) strip render. `ski` = skew. |
| `render_axo_clipboard` | `PreviewData` | Axo render of the clipboard. |

See [05 — 2D Rendering](./05-rendering-2d.md).

## Editing (all go through `with_edit`, return `EditResult`)

| Command | Purpose |
|---|---|
| `delete_blocks` | Delete blocks in region (optional filter). |
| `replace_blocks` | Replace one material with another. |
| `paint_blocks` | Fill/draw blocks. ⚠️ `z_offset: Option<i32>` (defaults 0) — keep it optional. |
| `gradient_fill` | Dither-blend one block → another across an axis. |
| `fill_surface` | Fill at each column's surface Z. |
| `sculpt_terrain` | Heightmap sculpting (16 modes — see [07](./07-editing-undo-clipboard.md)). |
| `extrude_selection` | N non-overlapping copies along an axis. |
| `move_selection` | Translate a selection. |
| `generate_trees` | Multi-type tree placement over a selection. |
| `undo_edit` / `redo_edit` | Restore from delta stacks (not via `with_edit`). |

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
| `render_clipboard_preview` / `_elevation_preview` | `PreviewData` | Ghost previews. |
| `save_prefab` / `load_prefab` | — / `ClipboardInfo` | `.epfab` gzip read/write (atomic). |
| `get_default_prefab_dir` | `String` | `<app_data_dir>/prefabs`. |
| `list_prefabs` | `Vec<PrefabEntry>` | Gallery listing + dims (uses the internal `read_prefab_header` helper). |
| `delete_prefab` / `rename_prefab` / `prefab_exists` | | Guard on `.epfab` extension. |
| `render_prefab_thumbnail` | `PreviewData` | Gallery thumbnail. |

## 3D geometry, lighting & picking (`export.rs`)

| Command | Returns | Notes |
|---|---|---|
| `get_obj_geometry` | geometry b64 | Selection preview (≤64³), `ThreeDPreview`. Always `LightMode::default()`. |
| `get_chunk_geometry` | multi-stream geometry | One 16×16 chunk column for `FlyView3D`; opaque + transparent + emissive streams. Optional `zMin`/`zMax` clip the emitted band (omitted = full `0..=world_max_z`); the cutaway cap `view_cap_z` is intersected in server-side. See [06](./06-rendering-3d.md). |
| `get_light_constants` | `LightConstants` | `LAMP_LIGHT_RADIUS`, `SHADOW_RAY_STEPS` — for the edit-sync reload rect. |
| `get_lamps_near` | `Vec<LampLight>` | Nearest lamps for GPU point lighting (cap 64). |
| `pick_block` | `PickResult` | DDA voxel raycast (Eden coords in). Returns hit + entry face normal. |
| `set_cursor_lock` | — | Native window-level cursor grab (Minecraft mouselook). |

See [06 — 3D Rendering](./06-rendering-3d.md).

## Export

| Command | Notes |
|---|---|
| `export_obj` **(async)** | Wavefront OBJ + MTL; face-culled cubes, ramp prisms, wedge pyramids. Long-op `kind: "obj"`, cancellable. |
| `export_json` **(async)** | JSON geometry dump. Long-op `kind: "json"`, cancellable. |
| `export_vox` **(async)** | MagicaVoxel `.vox` (menu item currently disabled). Long-op `kind: "vox"`, cancellable. |
| `export_png` **(async)** | Renders + encodes in Rust. Long-op `kind: "png"`, *not* cancellable. |

All four refuse a region over `MAX_EXPORT_VOXELS` (256 M, matching
`MAX_CLIPBOARD_VOLUME`) up front via `check_export_volume`, with the estimate spelled
out in the message — see [10](./10-features.md#export) (audit C6).

## Long operations (`LongOps`, audit C6 + M14, 2026-08-20)

One contract shared by every long-running command, replacing ten different stories
(two had a cancel atomic + progress + modal; one had progress but no cancel; one had
an indeterminate shimmer; four had nothing at all and were indistinguishable from a
hang).

`LongOps` is managed state holding a monotonic id counter and the id the user asked to
cancel — a single slot, not a registry, because every long operation is modal in the
UI and only one runs at a time. Storing the *id* rather than a bare bool means a cancel
that arrives just after an operation finished can never leak onto the next one.

```rust
let op = ops.begin(&app, "obj", "Exporting OBJ".into(), total_rows, /* cancellable */ true);
op.step(done, "Writing geometry")?;   // emits (throttled) AND returns Err(LONG_OP_CANCELLED)
```

- Event name: **`long-op`**. The opening event carries
  `{ id, kind, label, phase, done, total, pct, cancellable, finished: false }`;
  progress events carry only what changed; `LongOpHandle::drop` emits
  `{ id, kind, finished: true }`. The frontend merges later events onto the opener, so
  `label`/`cancellable` survive the run.
- Throttled to whole-percent changes **and** a `LONG_OP_MIN_INTERVAL_MS` (80 ms) floor.
- `cancel_long_op(id)` sets the flag; `step` turns it into `Err("Cancelled")`, which
  propagates through the usual `?`. `ExportCleanup` (export.rs) deletes the
  half-written file unless `keep()` was called, so a cancel never leaves a truncated
  export that looks real.
- `kind` values: `"png" | "obj" | "json" | "vox" | "save"`.
- **Saves report progress but are not cancellable** — `try_incremental_save` writes in
  place through a committed WAL that the next load rolls forward, so "cancel" has no
  coherent meaning there. `atomic_write_progress` / `save_world_compressed` chunk their
  writes at `SAVE_PROGRESS_CHUNK` (16 MB) to report.
- **Not migrated:** `expand_world_from_template` and `materialize_flat_chunks` keep
  `ExpandCancel`/`MaterializeCancel` and their `expand_progress`/`materialize_progress`
  events. They already had working cancel + progress + a dedicated modal; converting
  them would be churn against no user-visible gain.

## World generation (`worldgen.rs`)

| Command | Notes |
|---|---|
| `create_world` **(async)** | Flat world. |
| `create_natural_world` **(async)** / `preview_natural_world` **(async)** | Procedural biome pipeline + fast preview. |
| `create_classic_world` **(async)** | Legacy generator port. |
| `create_tg2_world` **(async)** / `preview_tg2_world` **(async)** | TerrainGen2 port + preview. |

See [08 — World Generation](./08-world-generation.md).

## Template overlay & expand

| Command | Notes |
|---|---|
| `load_eden_template` | `(path) → chunk_count`. Mmaps `Eden.eden`, parses its directory. |
| `fetch_template_tile` **(async)** | `PixelPatch`; alpha=0 where no template chunk. Takes `lod`; decodes only the template columns the sampled grid touches. |
| `expand_world_from_template` **(async)** | Bake template chunks into a new world file. `"expand_progress"` events. |
| `cancel_expand` | Sets a separate `ExpandCancel` AtomicBool; deletes partial output. |

## Schematic import (`schematic.rs`)

| Command | Notes |
|---|---|
| `import_schematic_info` | Parse `.schematic`/`.litematic`/`.schem` header → mapping table. |
| `import_schematic_apply` | Apply mapping → clipboard → paste. |

## Network (`network.rs`)

| Command | Notes |
|---|---|
| `search_worlds` | `(query, server) → Vec<WorldSearchResult>`. HTTP only (TLS fails). |
| `list_worlds` **(async)** | `(start, sort, server) → Vec<WorldSearchResult>`. Browse with no search term — `?start=&sort=`, same response shape/parser as `search_worlds` (shared `parse_world_list_response`). Added 2026-08-18 (256z-format plan, Part C2) — `search_worlds` alone gave VuencEdit no way to list *any* worlds, unlike the real client. |
| `download_world` **(async)** | Streams to disk, 2 GB cap. |
| `upload_world` **(async)** | Multipart upload + PNG thumbnail. |

Servers: `app2.edengame.net` (current), `app.edengame.net` (legacy).

## Texture packs & tables

| Command | Notes |
|---|---|
| `load_texture_pack` | `(path) → TexturePackInfo` (carries `gray_row_offset`). |
| `unload_texture_pack` | — |
| `get_block_tables` | `BlockTables` — canonical color tables installed on the frontend at startup. |

## Signs (`signs.rs`, 256z-format plan Phase 4, landed 2026-08-18)

| Command | Notes |
|---|---|
| `get_signs` | `Vec<SignInfo>` — `WorldState.signs`, populated once by `load_world` (sidecar preferred, else the inline `dir_trailer`), converted to editor-local x/y on the way out. Read-only. MapCanvas draws a marker per sign; Sidebar's Inspector tab lists them via `SignsList`. |

## Sky & creatures (registered, UI hidden)

| Command | Notes |
|---|---|
| `get_sky_grid` / `set_sky_grid` | 4×4 sky color grid. UI not wired. |
| `get_creatures` | `Vec<CreatureInfo>`. MapCanvas has draw code; UI passes `creatures={[]}`. Reads `creature_block_range(world)` (fixed 2026-08-18 — used to hardcode a 200-slot/12,000-byte block, reading the wrong half of a 256z world's real 400-slot/24,000-byte one). |
