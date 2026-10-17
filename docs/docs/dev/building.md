---
layout: doc
title: "Building & Testing"
subtitle: "Building, tests, CI and conventions."
---
{% raw %}
## Prerequisites

| Tool | Version |
|------|---------|
| [Rust](https://rustup.rs) | stable |
| [Node.js](https://nodejs.org) | 18 LTS or newer |

**Linux only**: install the WebKit dev libraries:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

## Dev commands

```bash
npm install
npm run tauri dev        # run the app in dev (Vite HMR + Rust)
npm run tauri build      # release build, output in src-tauri/target/release/bundle/

cargo build --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit         # type-check the frontend
npm run lint             # eslint
npm run test             # vitest (frontend unit tests)
```

Add `$HOME/.cargo/bin` to `PATH` if the Rust toolchain isn't found.

## Dependencies

**Rust** (`src-tauri/Cargo.toml`): `tauri` 2, `tauri-plugin-opener`, `tauri-plugin-dialog`,
`serde`/`serde_json`, `base64`, `memmap2`, `flate2`, `zip`, `reqwest` (multipart, stream),
`image` (png only), `rayon`, `tokio`/`tokio-util`/`futures-util`/`bytes`, `rustc-hash`,
`crc32fast`, plus the shared `voxel-core` crate.

**Frontend** (`package.json`): `react`/`react-dom` 19, `three` ^0.184, `@tauri-apps/api` 2 with the
dialog and opener plugins. Dev: `vite` 7, `typescript` ~5.8, `eslint` 10 with
`eslint-plugin-react-hooks` and `typescript-eslint`, `tailwindcss` 4 (`@tailwindcss/vite`), `vitest` 4.

## CI

Every push and PR to `main` runs, on macOS: `tsc --noEmit`, lint, vitest, a Vite build, and
`cargo test` (clippy is advisory). A Windows job runs the type-check, build and `cargo test` so
platform-specific breakage (path separators, save-rename and mmap-lock behaviour) is caught.
A separate release workflow runs on `v*` tags.

## ESLint

- `rules-of-hooks` and correctness rules are **blocking errors**.
- The opinionated react-hooks rules (`set-state-in-effect`, `static-components`, `refs`,
  `exhaustive-deps`, `preserve-manual-memoization`) are **warnings**, along with a few unrelated
  warn-level rules (`no-useless-assignment`, `preserve-caught-error`,
  `@typescript-eslint/no-explicit-any`, `prefer-const`).
- A raw-hex rule keeps colour literals out of the chrome code (`src/ribbon/**`, `src/windows/**`).
  Colours come from `src/theme/theme.ts`.

Don't add new errors. Reducing warnings is welcome.

## Conventions

- **`timing_log!`** (lib.rs): all `[LOAD]/[LOCK]/[SCAN]/[PREVIEW]` timing instrumentation goes
  through this macro (debug builds only). Use it, not `eprintln!`.
- **Peak counters**: integer `_last`/`_max` atomics set at the operation (edit pre-image, undo
  delta, sculpt scratch, preview scan, clipboard transient, autosave/save bytes and ms), surfaced by
  `mem_stats` and the Diagnostics report. Add a counter rather than logging, and never poll.
  `alloc_probe.rs` (test-only) is a per-thread counting `#[global_allocator]` that measures an
  operation's transient allocation headlessly: `cargo test alloc_probe -- --nocapture`. It doesn't
  see `rayon` threads.
- **`RwLock`**: `AppState = RwLock<WorldState>`, and every lock site goes through
  `read_ws`/`write_ws`, never `state.read()/.write()` directly. See [Architecture](../architecture/).
- **rayon**: pure render and generation functions only. Never let a parallel closure re-lock the
  `AppState` guard the caller holds, which applies to nested *read* guards too. See
  [Architecture](../architecture/#rayon).
- **`with_edit`**: all edits route through it. See [Editing, Undo & Clipboard](../editing-undo-clipboard/).
- **IPC types**: mirror Rust structs in `types.ts` and decode via `codec.ts`. See
  [Architecture](../architecture/#ipc-architecture).
- **Colour tables**: the canonical Rust tables are installed on the frontend at startup
  (`applyBlockTables()` / `get_block_tables`). Don't hand-edit both sides. See
  [Blocks & Colors](../blocks-and-colors/).
- **Versioning**: the three version fields (`tauri.conf.json`, `Cargo.toml`, `package.json`) are
  written by one script. Don't edit them by hand.

## Releases

Pushing a `v*` tag triggers a GitHub Actions workflow that builds macOS (universal binary),
Windows and Linux installers in parallel and publishes them as a GitHub release.

## Where to start

| Task | Start in |
|---|---|
| Change a block colour or add a block | [Blocks & Colors](../blocks-and-colors/), `colors.rs` + `blockDefs.ts` |
| Add or change a backend command | [IPC Reference](../ipc-reference/), the `generate_handler!` block in `lib.rs` + `types.ts` |
| 2D map behaviour | [2D Rendering](../rendering-2d/), `MapCanvas.tsx` / `viewportUtils.ts` |
| 3D view, lighting, or a port | [3D Rendering](../rendering-3d/), `FlyView3D.tsx` + `geometry.rs` |
| Editing or a new edit operation | [Editing, Undo & Clipboard](../editing-undo-clipboard/), `with_edit` in `lib.rs` |
| Terrain generation | [World Generation](../world-generation/), `worldgen.rs` |
| UI, ribbon, state | [Frontend](../frontend/), `App.tsx` / `Ribbon.tsx` |
| Texture packs, network, template, PNG export | [Subsystems](../subsystems/), `texturepack.rs` / `network.rs` |

## Known gaps

- The strict CSP hasn't been smoke-tested in a release build.
- World rotation (chunk-scoped undo with ramp ID remapping).
- A viewport-only patch for Z-slice (it lags on large worlds).
- A single viewport tile fetch to remove per-tile IPC.
- World expansion via paste.
{% endraw %}
