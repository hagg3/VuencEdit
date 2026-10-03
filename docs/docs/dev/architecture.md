---
layout: doc
title: "Architecture"
subtitle: "Tauri shell, process and threading model, IPC design."
---
{% raw %}
## Stack

| Layer | Choice |
|---|---|
| Desktop shell | **Tauri 2.x** (Rust host + system WebView) |
| Backend | **Rust**: binary parsing, file I/O, world data model, rendering, geometry, generators |
| Frontend | **React 19 + TypeScript**, built with **Vite 7** |
| 2D map rendering | HTML **Canvas 2D** API |
| 3D rendering | **Three.js** (`three` ^0.184) + OrbitControls |
| Styling | **Tailwind CSS v4** (via `@tailwindcss/vite`) |

The app version lives in `package.json`, `tauri.conf.json` and `src-tauri/Cargo.toml`
(currently 1.0.18). A script writes all three together, so don't edit them by hand.

## Why Tauri + Rust

Eden world files are a dense binary format with band-addressed block data (see
[File Format](../file-format/)). Two properties make a Rust backend the
right call:

1. **Heap.** Parsing/rendering the format in JavaScript requires large
   `ArrayBuffer` operations that balloon the V8 heap. Rust does all byte-level
   arithmetic with explicit endianness.
2. **`mmap`.** World data is memory-mapped (`memmap2`, `MAP_PRIVATE`) and paged in
   on demand, keeping RSS around ~37 MB even for 1 GB+ world files.

The frontend never sees raw world bytes. It asks the backend for rendered pixel
tiles, geometry, and metadata, and sends back edit commands.

## Process & module layout

The app is a Tauri project with a shared Rust crate beside it. Everything that is **pure
voxel logic** (no world type, no lock, no Tauri command) lives in `packages/voxel-core`,
generic over the `VoxelView` trait. Paths below are relative to the app root unless they
start with `packages/`.

```
packages/voxel-core/src/   Shared voxel primitives, NO tauri dependency, ever
  colors.rs       (596 L)  BLOCK_RGB / PAINT_RGB / BLOCK_INFO tables + helpers
  blocks.rs        (62 L)  Fluid family: fluid_base / fluid_level / fluid_type_for
  view.rs         (170 L)  VoxelView / VoxelViewMut / ViewMeta + block addressing
  mask.rs          (51 L)  SelectionMask (the shaped-selection footprint)
  texture.rs      (213 L)  Atlas layout contract the mesher reads
  geometry.rs   (~2200 L)  Live 3D geometry pipeline: per-chunk face-culled/
                           greedy-meshed mesh generation, night-lighting/shadow
                           previews, voxel picking (DDA)
  lamps.rs        (495 L)  Lamp spatial index (lazy, per-chunk, interior-mutable)
  render.rs      (~2200 L) Raster + every 2D renderer: top-down map, z/y/x slices,
                           Relief shading, the selection and paste Lens renderers
  testworld.rs     (82 L)  Synthetic worlds for tests

src-tauri/src/             Rust backend (single library crate + thin main.rs)
  main.rs                  Entry point → eden_world_editor_lib::run()
  lib.rs        (~19100 L) World parse/model, all editing commands, with_edit,
                           copy/paste, prefab, sculpt/fill, sky/creatures, the
                           thin render_* wrappers over voxel-core, tests
  worldgen.rs    (~2900 L)  Perlin noise + Natural/Classic/TG2 generators + commands
  geometry.rs     (251 L)  Tauri/IPC shell only: get_chunk_geometry, pick_block,
                           get_lamps_near, get_light_constants + the binary
                           envelope newtype. The pipeline itself is voxel-core's.
  network.rs      (702 L)  Eden server search/list/download/upload
  texturepack.rs  (447 L)  Texture pack loader: atlas builder, per-face tile map
                           (the layout contract itself is voxel-core's)
  journal.rs      (891 L)  WAL / autosave journal wire format (shared by both)
  signs.rs        (255 L)  Sign sidecar decode
  overview.rs   (~1100 L)  Overview raster: per-chunk zoomed-out sample cache,
                           adaptive granularity, .vxr persistence store
  mem.rs          (484 L)  Process and system memory probes behind the diagnostics report
  alloc_probe.rs  (225 L)  Test-only peak-allocation measurement
  working_set.rs  (175 L)  Windows-only working-set trim for the world mapping
                           (VirtualUnlock, idle-debounced, off unless
                           VUENCEDIT_TRIM=1). A no-op on every other target.

src/                        React + TypeScript frontend
  App.tsx        (~4600 L)  Global state, keyboard shortcuts, orchestration
  Ribbon.tsx       (~470 L) Thin ribbon shell, see src/ribbon/ for the tab
                             modules that carry the actual bulk (09-frontend.md)
  MapCanvas.tsx  (~2800 L)  2D map: pan/zoom/select/paste/draw
  FlyView3D.tsx  (~5200 L)  Streaming 3D fly-through pane (Three.js)
  ... (see 09-frontend.md for the full component map, incl. src/ribbon/,
       src/panels/, src/tour/, Sidebar.tsx, AppMenu.tsx, WorldNamePill.tsx)
```

Line counts are approximate and drift with every change, treat them as
order-of-magnitude, not exact. Rust `lib.rs` was intentionally split into
submodules (`worldgen`, `geometry`, `network`, `texturepack`, `journal`, `signs`,
`working_set`, `overview`, `mem`); `lib.rs` still owns the world model, the editing commands,
and `with_edit`. Minecraft schematic import and Source Engine VMF export were removed from
this repo and now live in the separate [EdenToMC](https://github.com/hagg3/EdenToMC) project.

## The `WorldState` and the app lock

The backend holds one `WorldState` behind an `RwLock` (`AppState = RwLock<WorldState>`),
`.manage()`d by Tauri. It's an `RwLock` rather than a `Mutex` so read-only commands
(renders, tile fetches) can run concurrently and only serialize against writers.
Every command that touches the world goes through one of two helpers in
`lib.rs`, never `state.read()/.write()` directly:

```rust
read_ws(&state)   // shared guard: renders, fetch_tile, save/autosave, …
write_ws(&state)  // exclusive guard: the editors, undo/redo, load/close, …
```

Both ignore lock poisoning (`unwrap_or_else(|p| p.into_inner())`), a panic
while holding the lock must not poison every subsequent command. Keep this
pattern for any new command.

⚠️ **`std::sync::RwLock` is neither reentrant nor upgradable.** Never hold one
guard and then ask for the other in the same call chain: a writer queued in
between turns it into a deadlock. See [Editing, Undo & Clipboard](../editing-undo-clipboard/) for the full
read-guard/write-guard command split and the `sculpt_terrain` three-phase
exception.

`WorldState` carries (among other things): the parsed world and its temp
copy's path, the clipboard, undo/redo stacks, a lazily-built lamp spatial index, and
optional `Eden.eden` template mmap + directory. See [Editing, Undo & Clipboard](../editing-undo-clipboard/)
and [Subsystems](../subsystems/) for the fields.

## Threading model: sync vs async commands

Plain `#[tauri::command]` functions run on the **main thread** and serialize all
IPC. Long or lock-heavy commands are declared `#[tauri::command(async)]` so they
run off-thread and don't stall the UI:

- `load_world`, `save_world`, `autosave_world`, `export_png`,
  `expand_world_from_template`
- The heavy renders: `render_selection_lens` (front + side, or top, in one call) and
  `render_paste_lens`
- All of `geometry.rs`'s commands
- All worldgen `create_*` / `preview_*`
- `fetch_template_tile` (a first pan over virgin template can decode ~1,000 chunk
  columns)

Their bodies stay **synchronous**: `lock → work → unlock`, with **no
`.await` under the guard**, so the `RwLock` is safe. Nearly every command that touches
`AppState` is `#[tauri::command(async)]`, because a sync command sharing the lock with an in-flight
async one still blocks on `state.lock()`/`read_ws`/`write_ws` **on the Tauri
main thread**, stalling the whole window. Only a handful of commands that never
touch `AppState` stay plain-sync (`cancel_expand`/`cancel_materialize` on their
own atomics, `get_autosave_path`, prefab directory
list/delete/rename/exists, `get_light_constants`, `set_cursor_lock`). Small,
frequent tile fetches (`fetch_tile`) are async too: the
per-call spawn overhead is cheaper than a frozen window.

Async is also what lets `cancel_expand` land mid-run, and lets `autosave_world`
snapshot bytes under the lock then write with the lock released.

### rayon

`rayon` is used **inside pure render/generation functions only**
(`render_pixels_patch`, the z/y/x-slice renderers, `render_selection_lens`, the
Natural/Classic heightmap + per-chunk fill passes). **Invariant:** never invoke a
`par_iter`/`par_chunks_mut` in a way that lets a parallel closure try to re-lock
the `AppState` guard the calling command already holds. Post-`RwLock` this is
**stricter, not looser**: a nested *read* guard is not safe just because reads
are shared. `build_lamp_index` (`par_iter` under a read guard, touching only
`&LoadedWorld`) is the pattern to copy. Check this before adding new parallel
call sites.

## IPC architecture

- **Bulk binary payloads** (pixel buffers, geometry streams, texture atlases)
  cross as a **raw `tauri::ipc::Response`**: an `ArrayBuffer` in JS, with no
  base64 and no JSON string, framed as
  `u32 LE header_len | JSON header | concatenated buffers` by `ipc_envelope`
  (lib.rs) and read back by `decodeEnvelope` in
  [`src/codec.ts`](https://github.com/hagg3/VuencEdit/blob/main/src/codec.ts). The decoded buffers are **views** over the
  response bytes, so the path to `putImageData` / `THREE.BufferAttribute` is
  copy-free. **All IPC decode goes through the `decode*` helpers in
  [`src/types.ts`](https://github.com/hagg3/VuencEdit/blob/main/src/types.ts), never hand-roll the framing.** Full
  contract, including why payload types must not derive `Serialize`:
  [IPC Command Reference].
- **Edit flow.** Editing commands return
  `EditResult { patch: PixelPatch, invalidate, undo_depth, redo_depth, operation, undo_dropped }`.
  Only the changed rectangle crosses IPC. `applyEditResult()` on the frontend
  decodes the patch, applies it to the canvas, and increments `editEpoch` (see
  [Editing, Undo & Clipboard](../editing-undo-clipboard/)).
- **Shared IPC types.** Rust struct shapes are mirrored in
  [`src/types.ts`](https://github.com/hagg3/VuencEdit/blob/main/src/types.ts): `WorldMeta`, `RecentWorld`, `PixelPatch(Raw)`,
  `EditResultRaw`, `PreviewData(Raw)` (+ `decodePixelPatch`/`decodePreviewData`),
  `SelectionInfo`, `ClipboardInfo`, `ExtrudeAxis`, `TreeType`. Import from
  `types.ts`, not from `App.tsx`/`MapCanvas.tsx`.
- **Tauri 2 camelCasing.** Rust snake_case command parameters are automatically
  camelCased on the JS side (`z_min` → `zMin`). **Always use camelCase in
  `invoke()` calls.** A Rust `Option<i32>` param that a caller omits is fine; a
  required param that a caller omits fails at *runtime* with `missing required
  key …` (Tauri can't catch it at compile time), see the `paint_blocks`
  `z_offset` gotcha in [Editing, Undo & Clipboard](../editing-undo-clipboard/).

The full command surface is in [IPC Reference](../ipc-reference/).

## Security / CSP

Production CSP (`tauri.conf.json`) is strict:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; connect-src ipc: http://ipc.localhost
```

`devCsp: null` so Vite HMR works in development. The strict CSP has **not yet been
smoke-tested in a release build**, if a pane breaks in release, the webview
console names the violated directive.

Untrusted-input hardening lives in the parsers: gzip reads are size-capped,
`download_world` streams to disk with a 12 GiB cap (`MAX_DOWNLOADED_WORLD_BYTES`,
network.rs), and `validate_selection` rejects negative coordinates at the IPC
boundary. See [Subsystems](../subsystems/).

## Capabilities

Tauri capabilities (`src-tauri/capabilities/default.json`) must allow-list plugin
commands the app uses. Notable non-default grants:
- `opener:allow-open-path`: Prefab library "Open Folder".
- `core:window:allow-destroy`: the close/quit dirty-guard's `window.destroy()`.
{% endraw %}
