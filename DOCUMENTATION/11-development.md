# 11 — Development

## Prerequisites

| Tool | Version |
|------|---------|
| [Rust](https://rustup.rs) | stable (1.77+) |
| [Node.js](https://nodejs.org) | 18 LTS or newer |

**Linux only** — install the WebKit dev libraries:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

## Dev commands

```bash
npm install
npm run tauri dev        # run the app in dev (Vite HMR + Rust)
npm run tauri build      # release build → src-tauri/target/release/bundle/

cargo build   --manifest-path src-tauri/Cargo.toml
cargo test    --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit         # type-check the frontend
npm run lint             # eslint src
npm run test             # vitest (frontend unit tests, e.g. drawTools.test.ts)
```

`export PATH="$HOME/.cargo/bin:$PATH"` if the Rust toolchain isn't in PATH.

## Dependencies

**Rust** (`src-tauri/Cargo.toml`): `tauri` 2, `tauri-plugin-opener`,
`tauri-plugin-dialog`, `serde`/`serde_json`, `base64`, `memmap2`, `flate2`, `zip`,
`reqwest` (multipart), `image` (png only), `rayon`.

**Frontend** (`package.json`): `react`/`react-dom` 19, `three` ^0.184,
`@tauri-apps/api` 2 + dialog/opener plugins; dev: `vite` 7, `typescript` ~5.8,
`eslint` 10 + `eslint-plugin-react-hooks` 7 + `typescript-eslint`, `tailwindcss` 4
(`@tailwindcss/vite`), `vitest` 4.

## CI (`.github/workflows/ci.yml`)

Every push/PR to `main` runs, on **macOS**:
`tsc --noEmit` → `npm run lint` → `vite build`, plus `cargo test` (+ clippy,
**advisory**). A **windows-latest** gate also runs (`tsc` → `vite build` →
`cargo test`) so platform-specific breakage (path separators, save-rename +
mmap-lock behavior) is caught. **Keep CI green.** The release workflow (`v*` tags)
is separate.

## ESLint (`eslint.config.js`, flat config)

- `rules-of-hooks` + correctness rules are **blocking errors**.
- react-hooks v6 opinionated rules (`set-state-in-effect`, `static-components`,
  `refs`, `exhaustive-deps`) are **warnings** (~45 pre-existing, mostly legitimate
  "reset on external change" effects).

**Don't add new errors; reducing warnings is welcome.**

## Guardrails & conventions

- **`timing_log!`** (lib.rs) — all `[LOAD]/[LOCK]/[SCAN]/[PREVIEW]` timing
  instrumentation goes through this macro (debug builds only). Use it, not
  `eprintln!`, for new instrumentation.
- **Mutex** — every lock site uses `state.lock().unwrap_or_else(|p|
  p.into_inner())` (poison-tolerant). See [01](./01-architecture.md).
- **rayon** — pure render/gen functions only; never let a parallel closure re-lock
  the app mutex the caller holds. See [01](./01-architecture.md#rayon).
- **`with_edit`** — all edits route through it. See [07](./07-editing-undo-clipboard.md).
- **IPC types** — mirror Rust structs in `types.ts`; decode via `codec.ts`. See
  [01](./01-architecture.md#ipc-architecture).
- **Color tables** — install canonical Rust tables on the frontend at startup
  (`applyBlockTables()` / `get_block_tables`); don't hand-edit both sides. See
  [03](./03-blocks-and-colors.md).

## Versioning

**`bump-version.sh` is the single writer** of all three version fields
(`tauri.conf.json`, `Cargo.toml`, `package.json`). Don't edit versions by hand.
(Currently `package.json`/`tauri.conf.json` = 1.0.2; `Cargo.toml` crate = 1.0.0.)

## Releases

Pushing a `v*` tag triggers a GitHub Actions workflow that builds macOS (universal
binary), Windows, and Linux installers in parallel and publishes them as a draft
GitHub Release.

## Public repo sync

This is a **private** repo. The public mirror is
**`github.com/hagg3/VuencEdit`** — no `CLAUDE.md`, no `.claude/`. `publish.sh`
syncs to `~/VuencEdit/` excluding `CLAUDE.md`, `AGENTS.md`, `.claude/`, `*.eden`,
`publish.sh`, `bump-version.sh`, `issues.txt`, `TEST WORLDS/`, `PREFABS/`,
`EdenWorldManipulator2.0/`, and every root `*.md` except `README.md` — so every
other root-level `.md` file is already private, not just `CLAUDE.md`. This
`DOCUMENTATION/` directory is a reference manual meant to travel with the
public mirror; if you add a file here, confirm `publish.sh`'s `*.md` exclude
isn't silently swallowing it (the exclude currently matches by basename at any
depth, so a rule written for repo-root `.md` clutter also catches these unless
special-cased). See [`syncguide.md`](../TEST%20WORLDS/syncguide.md) for the full
dev → public → release workflow.

## Repository landmarks

| Path | What |
|---|---|
| `CLAUDE.md` | Canonical living design doc (private only, kept under ~200 lines). |
| `DOCUMENTATION/` | This reference manual — topic files 01–11, meant for contributors and for authors of other Eden World Builder projects. |
| `MROB.txt` | File-format reverse-engineering notes. |
| `EdenWorldManipulator2.0/` | Reference C# WinForms implementation (read-only). |
| `TEST WORLDS/` | Private sample worlds + supplementary planning docs (NEW_WORLD, TerrainGen2, 3dplan, syncguide, changelog, feature handoff/plan docs) + shipped atlases — never published. |
| `la-map.c` | Visual-quality reference from the original tooling (untracked-but-keep). |
| `.github/workflows/ci.yml` | CI gate. |
| `bump-version.sh` | The only version writer. |
| `publish.sh` | Private → public sync. |

## Open decisions / remaining work

Tracked in full in `CLAUDE.md`; highlights:

- Smoke-test the strict CSP in a release build.
- Windows GUI testing (save-over-open-file, close/quit prompt, expand cancel) —
  developed on macOS; a `windows-latest` CI build/test gate exists but the GUI
  flows are untested on real Windows.
- Flip clippy to `-D warnings` (blocked on a `worldgen.rs` `never_loop` /
  `while_immutable_condition` pair + remaining `too_many_arguments` commands).
- L6 a11y (aria-labels on icon-only ribbon buttons; low-contrast slate-on-navy).
- World rotation (chunk-scoped undo + ramp ID remapping).
- Z-slice viewport-only patch (lag on large worlds).
- Viewport tile fetch (`fetch_viewport` to eliminate per-tile IPC).
- World expansion via paste (`serialize_world` needed).
- FlyView3D smooth per-vertex AO (only if perf demands). *(Greedy meshing landed — see `06-rendering-3d.md`.)*

## For agents: where to look first

| Task | Start in |
|---|---|
| Change a block color / add a block | [03](./03-blocks-and-colors.md), `colors.rs` + `blockDefs.ts` |
| Add / change a backend command | [04](./04-ipc-reference.md), `lib.rs` generate_handler + `types.ts` |
| 2D map behavior | [05](./05-rendering-2d.md), `MapCanvas.tsx` / `viewportUtils.ts` |
| 3D view / lighting / a port | [06](./06-rendering-3d.md), `FlyView3D.tsx` + `export.rs` |
| Editing / new edit op | [07](./07-editing-undo-clipboard.md), `with_edit` in `lib.rs` |
| Terrain generation | [08](./08-world-generation.md), `worldgen.rs` |
| UI / Ribbon / state | [09](./09-frontend.md), `App.tsx` / `Ribbon.tsx` |
| Import/export/network/template | [10](./10-features.md), `schematic.rs`/`export.rs`/`network.rs` |
