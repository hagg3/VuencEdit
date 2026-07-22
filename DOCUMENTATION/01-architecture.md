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

Versions: `package.json`/`tauri.conf.json` are at **1.0.2**; `src-tauri/Cargo.toml`
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
src-tauri/src/            Rust backend (single library crate + thin main.rs)
  main.rs                 Entry point → eden_world_editor_lib::run()
  lib.rs        (6038 L)  World parse/model, all editing commands, with_edit,
                          copy/paste, prefab, sculpt/fill, sky/creatures, tests
  colors.rs      (479 L)  BLOCK_RGB / PAINT_RGB / BLOCK_INFO tables + helpers
  worldgen.rs   (2843 L)  Perlin noise + Natural/Classic/TG2 generators + commands
  schematic.rs   (926 L)  MC .schematic/.litematic/.schem import, NBT parsing
  export.rs     (1729 L)  OBJ/JSON/VOX export, geometry generation, 3D lighting,
                          voxel picking, get_chunk_geometry
  network.rs     (284 L)  Eden server search/download/upload
  texturepack.rs (616 L)  Texture pack loader: atlas builder, per-face tile map

src/                      React + TypeScript frontend
  App.tsx       (3082 L)  Global state, keyboard shortcuts, orchestration
  Ribbon.tsx    (1993 L)  Tabbed ribbon toolbar
  MapCanvas.tsx (1626 L)  2D map: pan/zoom/select/paste/draw
  FlyView3D.tsx (1986 L)  Streaming 3D fly-through pane (Three.js)
  ... (see 09-frontend.md for the full component map)
```

Rust `lib.rs` was intentionally split into submodules (`colors`, `worldgen`,
`schematic`, `export`, `network`, `texturepack`); `lib.rs` still owns the world
model, the editing commands, and `with_edit`.

## The `WorldState` and the app mutex

The backend holds one `WorldState` behind a `std::sync::Mutex`, `.manage()`d by
Tauri. Every command that touches the world locks it:

```rust
state.lock().unwrap_or_else(|p| p.into_inner())
```

**Always use `unwrap_or_else(|p| p.into_inner())`, never `.unwrap()`** — a panic
while holding the lock must not poison every subsequent command. Keep this pattern
for any new command.

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

Their bodies stay **synchronous**: `lock mutex → work → unlock`, with **no
`.await` under the guard**, so the `std::Mutex` is safe. Small, frequent tile
fetches (`fetch_tile`) stay sync to avoid per-call spawn overhead.

Async is also what lets `cancel_expand` land mid-run, and lets `autosave_world`
snapshot bytes under the lock then write with the lock released.

### rayon

`rayon` is used **inside pure render/generation functions only**
(`render_pixels_patch`, the z/y/x-slice renderers, `render_axo_region`, the
Natural/Classic heightmap + per-chunk fill passes). **Invariant:** never invoke a
`par_iter`/`par_chunks_mut` in a way that lets a parallel closure try to re-lock
the app mutex the calling command already holds. Check this before adding new
parallel call sites.

## IPC architecture

- **Bulk binary payloads** (pixel buffers) cross as **base64** via a custom serde
  serializer (`serialize_bytes_b64`), decoded on the JS side by
  `decodeU8(b64) → Uint8Array` in [`src/codec.ts`](../src/codec.ts). ~8× smaller
  than JSON number arrays. Geometry float arrays use `decodeF32` (truncates to a
  4-byte multiple). **All IPC decode goes through `codec.ts` — never hand-roll
  `atob` loops.**
- **Edit flow.** Editing commands return
  `EditResult { patch: PixelPatch, undo_depth, redo_depth }`. Only the changed
  rectangle crosses IPC. `applyEditResult()` on the frontend decodes the patch,
  applies it to the canvas, and increments `editEpoch` (see [07](./07-editing-undo-clipboard.md)).
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
`download_world` streams to disk with a 2 GB cap, and `validate_selection` rejects
negative coordinates at the IPC boundary. See [10](./10-features.md).

## Capabilities

Tauri capabilities (`src-tauri/capabilities/default.json`) must allow-list plugin
commands the app uses. Notable non-default grants:
- `opener:allow-open-path` — Prefab library "Open Folder".
- `core:window:allow-destroy` — the close/quit dirty-guard's `window.destroy()`.
