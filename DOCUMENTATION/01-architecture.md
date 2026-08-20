# 01 — Architecture

## Stack

| Layer | Choice |
|---|---|
| Desktop shell | **Tauri 2.x** (Rust host + system WebView) |
| Backend | **Rust** — binary parsing, file I/O, world data model, rendering, geometry, generators |
| Frontend | **React 19 + TypeScript**, built with **Vite 7** |
| 2D map rendering | HTML **Canvas 2D** API |
| 3D rendering | **Three.js** (`three` ^0.184) + OrbitControls |
| Styling | **Tailwind CSS v4** (via `@tailwindcss/vite`) |

Versions: `package.json`/`tauri.conf.json` are at **1.0.15**; `src-tauri/Cargo.toml`
crate at 1.0.0. All version fields are written by `bump-version.sh` — never edit
them by hand (see [11 — Development](./11-development.md)).

## Why Tauri + Rust

Eden world files are a dense binary format with band-addressed block data (see
[02 — File Format](./02-file-format.md)). Two properties make a Rust backend the
right call:

1. **Heap.** Parsing/rendering the format in JavaScript requires large
   `ArrayBuffer` operations that balloon the V8 heap. Rust does all byte-level
   arithmetic with explicit endianness.
2. **`mmap`.** World data is memory-mapped (`memmap2`, `MAP_PRIVATE`) and paged in
   on demand, keeping RSS around ~37 MB even for 1 GB+ world files.

The frontend never sees raw world bytes. It asks the backend for rendered pixel
tiles, geometry, and metadata, and sends back edit commands.

## Process & module layout

```
src-tauri/src/             Rust backend (single library crate + thin main.rs)
  main.rs                  Entry point → eden_world_editor_lib::run()
  lib.rs        (~15600 L) World parse/model, all editing commands, with_edit,
                           copy/paste, prefab, sculpt/fill, sky/creatures, tests
  colors.rs       (535 L)  BLOCK_RGB / PAINT_RGB / BLOCK_INFO tables + helpers
  worldgen.rs    (2862 L)  Perlin noise + Natural/Classic/TG2 generators + commands
  schematic.rs    (926 L)  MC .schematic/.litematic/.schem import, NBT parsing
  export.rs      (2509 L)  OBJ/JSON/VOX/PNG export, geometry generation, 3D
                           lighting, voxel picking, get_chunk_geometry
  network.rs      (648 L)  Eden server search/list/download/upload
  texturepack.rs  (636 L)  Texture pack loader: atlas builder, per-face tile map
  journal.rs      (542 L)  WAL / autosave journal wire format (shared by both)
  signs.rs        (255 L)  Sign sidecar decode
  vmf_export.rs  (1688 L)  Source Engine VMF (Hammer brushwork) export

src/                        React + TypeScript frontend
  App.tsx        (~4570 L)  Global state, keyboard shortcuts, orchestration
  Ribbon.tsx       (~300 L) Thin ribbon shell — see src/ribbon/ for the tab
                             modules that carry the actual bulk (09-frontend.md)
  MapCanvas.tsx  (~2700 L)  2D map: pan/zoom/select/paste/draw
  FlyView3D.tsx  (~4300 L)  Streaming 3D fly-through pane (Three.js)
  ... (see 09-frontend.md for the full component map, incl. src/ribbon/,
       src/panels/, src/tour/, Sidebar.tsx, AppMenu.tsx, WorldNamePill.tsx)
```

Line counts are approximate and drift with every change — treat them as
order-of-magnitude, not exact. Rust `lib.rs` was intentionally split into
submodules (`colors`, `worldgen`, `schematic`, `export`, `network`,
`texturepack`, `journal`, `signs`, `vmf_export`); `lib.rs` still owns the world
model, the editing commands, and `with_edit`.

## The `WorldState` and the app lock

The backend holds one `WorldState` behind an `RwLock` (`AppState = RwLock<WorldState>`),
`.manage()`d by Tauri — not a plain `Mutex` (that was true pre-2026-08-05 audit
C1 step 2; the switch to `RwLock` let read-only commands, e.g. renders/tile
fetches, run concurrently with each other and only serialize against writers).
Every command that touches the world goes through one of two helpers in
`lib.rs`, never `state.read()/.write()` directly:

```rust
read_ws(&state)   // shared guard — ~36 commands (renders, fetch_tile, save/autosave, …)
write_ws(&state)  // exclusive guard — ~37 commands (the editors, undo/redo, load/close, …)
```

Both ignore lock poisoning (`unwrap_or_else(|p| p.into_inner())`) — a panic
while holding the lock must not poison every subsequent command. Keep this
pattern for any new command.

⚠️ **`std::sync::RwLock` is neither reentrant nor upgradable.** Never hold one
guard and then ask for the other in the same call chain — a writer queued in
between turns it into a deadlock. See CLAUDE.md's "World lock (RwLock)" section
and [07 — Editing/Undo/Clipboard](./07-editing-undo-clipboard.md) for the full
read-guard/write-guard command split and the `sculpt_terrain` three-phase
exception.

`WorldState` carries (among other things): the parsed world + its private temp
path, the clipboard, undo/redo stacks, a lazily-built lamp spatial index, and
optional `Eden.eden` template mmap + directory. See [07](./07-editing-undo-clipboard.md)
and [10](./10-features.md) for the fields.

## Threading model: sync vs async commands

Plain `#[tauri::command]` functions run on the **main thread** and serialize all
IPC. Long or lock-heavy commands are declared `#[tauri::command(async)]` so they
run off-thread and don't stall the UI:

- `load_world`, `save_world`, `autosave_world`, `export_png`,
  `expand_world_from_template`
- The heavy renders: `render_selection_view`, `render_full_height_view`,
  `render_axo_region`
- All of `export.rs`
- All worldgen `create_*` / `preview_*`
- `fetch_template_tile` (a first pan over virgin template can decode ~1,000 chunk
  columns)

Their bodies stay **synchronous**: `lock → work → unlock`, with **no
`.await` under the guard**, so the `RwLock` is safe. As of the 2026-08-05 audit
C1 step 1, nearly every remaining command that touches `AppState` is also
`#[tauri::command(async)]` — a sync command sharing the lock with an in-flight
async one still blocks on `state.lock()`/`read_ws`/`write_ws` **on the Tauri
main thread**, stalling the whole window. Only a handful of commands that never
touch `AppState` stay plain-sync (`cancel_expand`/`cancel_materialize` on their
own atomics, `get_autosave_info/path`, `discard_autosave`, prefab directory
list/delete/rename/exists, `get_light_constants`, `set_cursor_lock`). Small,
frequent tile fetches (`fetch_tile`) are async too now, not sync — the
per-call spawn overhead lost to the freeze this fix removes.

Async is also what lets `cancel_expand` land mid-run, and lets `autosave_world`
snapshot bytes under the lock then write with the lock released.

### rayon

`rayon` is used **inside pure render/generation functions only**
(`render_pixels_patch`, the z/y/x-slice renderers, `render_axo_region`, the
Natural/Classic heightmap + per-chunk fill passes). **Invariant:** never invoke a
`par_iter`/`par_chunks_mut` in a way that lets a parallel closure try to re-lock
the `AppState` guard the calling command already holds. Post-`RwLock` this is
**stricter, not looser** — a nested *read* guard is not safe just because reads
are shared. `build_lamp_index` (`par_iter` under a read guard, touching only
`&LoadedWorld`) is the pattern to copy. Check this before adding new parallel
call sites.

## IPC architecture

- **Bulk binary payloads** (pixel buffers, geometry streams, texture atlases)
  cross as a **raw `tauri::ipc::Response`** — an `ArrayBuffer` in JS, with no
  base64 and no JSON string — framed as
  `u32 LE header_len | JSON header | concatenated buffers` by `ipc_envelope`
  (lib.rs) and read back by `decodeEnvelope` in
  [`src/codec.ts`](../src/codec.ts). The decoded buffers are **views** over the
  response bytes, so the path to `putImageData` / `THREE.BufferAttribute` is
  copy-free. **All IPC decode goes through the `decode*` helpers in
  [`src/types.ts`](../src/types.ts) — never hand-roll the framing.** Full
  contract, including why payload types must not derive `Serialize`:
  [04 — IPC Command Reference](./04-ipc-reference.md#binary-payload-envelope-2026-08-05-audit-h2).
- **Edit flow.** Editing commands return
  `EditResult { patch: PixelPatch, invalidate, undo_depth, redo_depth, operation, undo_dropped }`.
  Only the changed rectangle crosses IPC. `applyEditResult()` on the frontend
  decodes the patch, applies it to the canvas, and increments `editEpoch` (see
  [07](./07-editing-undo-clipboard.md)).
- **Shared IPC types.** Rust struct shapes are mirrored in
  [`src/types.ts`](../src/types.ts): `WorldMeta`, `RecentWorld`, `PixelPatch(Raw)`,
  `EditResultRaw`, `PreviewData(Raw)` (+ `decodePixelPatch`/`decodePreviewData`),
  `SelectionInfo`, `ClipboardInfo`, `ExtrudeAxis`, `TreeType`. Import from
  `types.ts`, not from `App.tsx`/`MapCanvas.tsx`.
- **Tauri 2 camelCasing.** Rust snake_case command parameters are automatically
  camelCased on the JS side (`z_min` → `zMin`). **Always use camelCase in
  `invoke()` calls.** A Rust `Option<i32>` param that a caller omits is fine; a
  required param that a caller omits fails at *runtime* with `missing required
  key …` (Tauri can't catch it at compile time) — see the `paint_blocks`
  `z_offset` gotcha in [07](./07-editing-undo-clipboard.md).

The full command surface is in [04 — IPC Reference](./04-ipc-reference.md).

## Security / CSP

Production CSP (`tauri.conf.json`) is strict:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; connect-src ipc: http://ipc.localhost
```

`devCsp: null` so Vite HMR works in development. The strict CSP has **not yet been
smoke-tested in a release build** — if a pane breaks in release, the webview
console names the violated directive.

Untrusted-input hardening lives in the parsers: NBT recursion is capped
(`NBT_MAX_DEPTH=64`), gzip reads go through a size-capped `gunzip_capped()`,
`download_world` streams to disk with a 12 GiB cap (`MAX_DOWNLOADED_WORLD_BYTES`,
network.rs), and `validate_selection` rejects negative coordinates at the IPC
boundary. See [10](./10-features.md).

## Capabilities

Tauri capabilities (`src-tauri/capabilities/default.json`) must allow-list plugin
commands the app uses. Notable non-default grants:
- `opener:allow-open-path` — Prefab library "Open Folder".
- `core:window:allow-destroy` — the close/quit dirty-guard's `window.destroy()`.
