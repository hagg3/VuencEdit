# Eden World Editor (VuencEdit) — Documentation

This directory is the structured reference manual for **Eden World Editor**, the
private development name for the app published publicly as **VuencEdit** — a map
viewer and block editor for **Eden World Builder** `.eden` world files.

It is written for two audiences:

1. **Coding agents and contributors** working *on this project* — tweaking or
   adding features. Start with [01 — Architecture](./01-architecture.md) and the
   [Frontend](./09-frontend.md) / [IPC](./04-ipc-reference.md) references.
2. **Authors of other Eden World Builder projects** — modern ports, mods, or
   re-implementations of the original game. Several documents here are
   effectively a clean-room reverse-engineering reference for the game's data and
   rendering, independent of this specific editor:
   - [02 — File Format](./02-file-format.md) — the `.eden` binary layout.
   - [03 — Blocks & Colors](./03-blocks-and-colors.md) — block IDs, paint
     palette, and the color tables ported from the game source.
   - [06 — 3D Rendering](./06-rendering-3d.md) — voxel-to-mesh geometry,
     coordinate mapping, face culling, lighting/shadows. This is the intended
     reference for a **web-based port** built on the same approach as
     `FlyView3D.tsx`.
   - [08 — World Generation](./08-world-generation.md) — ports of the game's own
     Classic and TerrainGen2 generators.

## Relationship to `CLAUDE.md`

The repository root contains **`CLAUDE.md`**, a dense, meticulously-maintained
living document that is the canonical source of truth for implementation
decisions and gotchas. This `DOCUMENTATION/` set is a **reorganized, reference-
structured derivative** of it (plus `README.md`, `MROB.txt`, and the code
itself), split into navigable topic files with the game-format material lifted
out so it can be cited on its own.

When the two disagree, `CLAUDE.md` and the code win — but the intent is to keep
them consistent. If you change behavior, update both.

## Document index

| # | Document | For |
|---|----------|-----|
| 01 | [Architecture](./01-architecture.md) | Tauri/Rust/React shell, process & threading model, IPC design |
| 02 | [File Format](./02-file-format.md) | `.eden` binary layout, block addressing, save/staging, `Eden.eden` template |
| 03 | [Blocks & Colors](./03-blocks-and-colors.md) | Block type registry, paint palette, color/shading tables |
| 04 | [IPC Reference](./04-ipc-reference.md) | Every Tauri command, grouped by subsystem |
| 05 | [2D Rendering](./05-rendering-2d.md) | Tiled / full / axo map modes, slice viewports, HiDPI canvas |
| 06 | [3D Rendering](./06-rendering-3d.md) | FlyView3D, geometry generation, culling, lighting, shadows, picking |
| 07 | [Editing, Undo & Clipboard](./07-editing-undo-clipboard.md) | `with_edit`, delta undo, copy/paste, prefabs, drawing/sculpt tools |
| 08 | [World Generation](./08-world-generation.md) | Flat / Natural / Classic / Tg2 generators |
| 09 | [Frontend Guide](./09-frontend.md) | React component map, App.tsx state, UI conventions |
| 10 | [Features](./10-features.md) | Texture packs, schematic import, template overlay/expand, network, export |
| 11 | [Development](./11-development.md) | Build/test/CI, tooling, guardrails, versioning, open work |

## The elevator pitch

Eden world files use a dense band-addressed binary format. Parsing and rendering
them in JavaScript balloons the V8 heap, so the app is a **Tauri 2** desktop app:
a **Rust backend** does all byte-level parsing, editing, rendering, and geometry
generation over a memory-mapped file; a **React + TypeScript** frontend renders
the UI, the 2D map (HTML Canvas), and the 3D views (Three.js). All bulk data
crosses the IPC boundary as base64-encoded binary, ~8× smaller than JSON.

## Provenance

- **Eden World Builder** was created by Ari Ronen; the game source was made open
  source in 2018.
- The `.eden` format was originally reverse-engineered by **Robert Munafo (MROB)**
  — see [`MROB.txt`](../MROB.txt) at the repo root.
- This editor descends from **Eden World Manipulator** (C# WinForms, kept in
  [`EdenWorldManipulator2.0/`](../EdenWorldManipulator2.0/) as a read-only
  reference) and Vuenctools.
