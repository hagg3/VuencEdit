# VuencEdit

A map viewer and block editor for **Eden World Builder** world files (`.eden`).

Open a world file and get a colour-coded top-down map of everything in it. Pan and zoom around, select regions, fill or replace blocks, copy and paste structures, and save your changes back — all without touching the game itself.

---

## Downloads

Pre-built installers for macOS (Apple Silicon + Intel universal), Windows, and Linux are on the [Releases](../../releases) page.

---

## What it does

- **View** any Eden world as a zoomable, pannable top-down map
- **Inspect** a selection to see its dimensions, block counts, and Front / Side / Top previews
- **Edit** — fill a region with any block type, replace one material with another, delete blocks selectively
- **Copy and paste** — copy any volume and paste it anywhere; terrain-aware paste aligns to the ground surface automatically
- **Z-slice mode** — step through horizontal layers one at a time
- **Undo / redo** with multi-level history

---

## Building from source

### Prerequisites

| Tool | Version |
|------|---------|
| [Rust](https://rustup.rs) | stable (1.77+) |
| [Node.js](https://nodejs.org) | 18 LTS or newer |

**Linux only** — also install the WebKit development libraries:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

### Run in development

```bash
npm install
npm run tauri dev
```

### Build a release binary

```bash
npm run tauri build
```

The compiled app and installers appear in `src-tauri/target/release/bundle/`.

---

## Usage

1. **Open a world** — click *Open World* in the toolbar. On macOS, worlds are usually in  
   `~/Library/Containers/com.manomio.eden/Data/Documents/worlds/`.
2. **Navigate** — scroll to zoom; middle-click-drag or the pan tool to move. Press **Home** or *Fit* to zoom to the whole world.
3. **Select a region** — switch to the Select tool, then click-drag a rectangle. Adjust the Z range in the inspector panel.
4. **Inspect** — the right-hand panel shows dimensions, block counts, and orthographic previews of the selection.
5. **Edit** — with a selection active, use the bottom-left panel to fill, replace, or delete blocks.
6. **Copy / paste** — Copy captures the selection. Switch to Paste and click to place. Use the banner toggles for *No Air*, *Terrain*, and *Rotate 90°*.
7. **Save** — *Save* writes changes to the original file in place. *Save As* writes to a new file.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| Scroll | Zoom in / out |
| Middle drag | Pan |
| Home | Zoom to fit |
| Escape | Clear selection / exit paste mode |
| Cmd/Ctrl+Z | Undo |
| Cmd/Ctrl+Shift+Z | Redo |
| ? | Keyboard shortcut reference |

---

## Technical overview

VuencEdit is built with [Tauri 2](https://tauri.app) — a Rust backend exposed to a React / TypeScript frontend rendered in the system WebView.

### Why Tauri + Rust

Eden world files use a dense binary format with band-addressed block data:

```
addr + band × 8192 + x × 256 + y × 16 + z        → block type
addr + band × 8192 + x × 256 + y × 16 + z + 4096 → paint byte
```

Parsing and rendering this in JavaScript requires large `ArrayBuffer` operations that balloon V8 heap. Rust handles all byte-level arithmetic with explicit endianness, and `mmap` (MAP_PRIVATE) pages world data in on demand — keeping RSS around 37 MB even for 1+ GB world files.

### Project layout

```
src/
  App.tsx                 — file open, toolbar state, keyboard shortcuts
  MapCanvas.tsx           — Canvas: tiled rendering, pan/zoom/select/paste input
  SelectionInspector.tsx  — floating stats + orthographic preview panel
  blockDefs.ts            — block type registry, display colours, ramp helpers
src-tauri/src/
  lib.rs                  — world parser, all Tauri commands, colour tables
EdenWorldManipulator2.0/  — reference C# implementation (source only)
MROB.txt                  — file format reverse-engineering notes
```

### IPC

Pixel buffers cross the JS↔Rust boundary as base64-encoded binary (custom `serde` serialiser), cutting JS heap usage ~8× versus JSON number arrays. Edit commands return only the changed rectangle (`EditResult { patch: PixelPatch }`), so large worlds don't retransmit unchanged data.

### Rendering

The map uses a tiled canvas renderer (512 world-pixels per tile). Tiles are fetched from Rust on demand with a concurrency cap of 4 in-flight IPC requests, prioritised by distance from the viewport centre. A *Full Map* mode loads the entire world into a single offscreen canvas in streaming 128-pixel strips for lag-free pan/zoom.

### Undo / redo

Chunk-scoped snapshots: only chunks touched by an edit are copied before the change. A 256 MB byte-budget cap evicts the oldest entries first. Chunks whose bytes are unchanged after an edit are dropped before the snapshot is pushed.

### File format

Two chunk layouts are supported: standard (32 768 B / 64 z-levels) and extended (131 072 B / 256 z-levels). The format is documented in `MROB.txt` and cross-referenced against the reference C# implementation in `EdenWorldManipulator2.0/`.

### Automated releases

Pushing a `v*` tag triggers a GitHub Actions workflow that builds macOS (universal binary), Windows, and Linux installers in parallel and publishes them as a draft GitHub Release.
