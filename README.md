# VuencEdit

A map viewer and block editor for **Eden World Builder** world files (`.eden`).

Open a world file and get a colour-coded top-down map of everything in it. Pan and zoom around, select regions, fill or replace blocks, copy and paste structures, generate whole new worlds from scratch, and save your changes back — all without touching the game itself.

Based on Eden World Manipulator, which is itself based on Vuenctools. Original file format documentation by Robert Munafo.

Eden World Builder was created by Ari Ronen and made open source in 2018.

For support, visit the [Discord server](http://discord.gg/rjYXwBC) for the game and community.

---

## Downloads

Pre-built installers for macOS (Apple Silicon + Intel universal), Windows, and Linux are on the [Releases](../../releases) page.

---

## What it does

### Viewing & navigation
- **Zoomable, pannable top-down map** of any Eden world file
- **Z-slice mode** — step through horizontal layers one at a time with a slider
- **Axonometric (axo) view** — isometric-style perspective with an adjustable depth skew
- **Full map mode** — renders the entire world into a single canvas for lag-free pan/zoom
- **Elevation preview panel** — resizable front and side cross-section of the current selection, with optional draw support

### Selecting & inspecting
- **Click-drag selection** with Z-range controls
- **Magic Wand** — click any surface block to flood-select the contiguous region sharing that block type (or block+paint combination)
- **Selection inspector** — dimensions, block counts, orthographic previews
- **3D view** — on-demand Three.js 3D render of any selection up to 64×64×64

### Editing
- **Fill / replace / delete** — fill a region with any block, replace one material with another, or selectively delete blocks with an optional filter
- **Draw tools** — Pen, Brush, Rectangle, and Ellipse paint blocks directly on the map; brush size (1/3/5/7/9) and shape (square/circle), plus fill/hollow rect and ellipse
- **Draw mask** — restrict painting to cells whose current block type (and optionally paint) matches a chosen target
- **Hotbar** — 5 pinned + 5 recent block+paint combos for fast switching; hover a recent swatch to pin it
- **Undo / redo** with multi-level history and a 256 MB budget cap

### Copy, paste & prefabs
- **Copy / paste** any volume; paste with optional *No Air*, *Terrain-align*, *Rotate 90°*, *Flip X/Y*, and *Repeat* modes
- **Two-click paste lock-in** — first click locks XY position (amber ghost + elevation preview), second click places; Escape unlocks without placing
- **Save prefab** — save any selection as a `.epfab` file and reload it later; prefabs are gzip-compatible
- **Extrude** — repeat a selection N times along any of 6 axes in one undo step

### World generation
- **New World dialog** with four terrain tabs:
  - **Flat** — fixed-height world with configurable stone/dirt layers
  - **Natural (Procedural)** — full biome pipeline with domain-warped continents, mountain ridges, erosion (flat plains alternating with rugged highlands), rivers, lakes/ocean, caves, ores, trees, structures, and clouds; single or mixed biomes (Grassland / Desert / Snow / Lava / Classic+) with speckled dither at biome edges; live terrain preview
  - **Classic** — faithful port of the original legacy generator (seeded Perlin noise, hand-carved cave + skin passes, sparse flower/weed mix to avoid the game's sprite-buffer crash)
  - **Tg2** — port of the Eden 2.0 TerrainGen2 generator with 9 terrain types (Plains, Mars, RiverForest, Mtn+River, Desert, Ponies, Beach, Mix, Flat) plus sky islands, structures, amplitude and sea-level knobs, noise-warped seam blending; live terrain preview reflecting amplitude, sea level, and height format
- **64z (Legacy)** and **256z (New Dawn)** height formats for all generators

### File & server
- **Compressed world support** — reads and writes `.eden.zip` (deflate-9) alongside plain `.eden`
- **Browse Worlds** — search and download any world from the Eden community servers with preview images, date range filters, quality sorting, and a *Hide junk* toggle
- **Upload** — share your world back to the Eden servers with a PNG thumbnail
- **OBJ export** *(experimental)* — export a selection or the whole world as a Wavefront OBJ + MTL file with face-culled geometry and per-block materials; ramps and wedges export as correct prism/pyramid geometry
- **Schematic import** — import Minecraft `.schematic` and `.litematic` builds with a block-mapping table, colour-substrate selector, preset save/load, and a top-down preview before applying

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

1. **Open a world** — click *Open Local File* on the welcome screen, or use *File → Open…*. On macOS, worlds are usually in `~/Library/Containers/com.manomio.eden/Data/Documents/worlds/`.
2. **Browse Worlds** — click *Browse Worlds* on the welcome screen (or *File → Browse Worlds…*) to search the Eden community servers. Pick a result and click **Save & Open** to download and open it immediately.
3. **Create a new world** — *File → New World…* opens the generation dialog. Choose a terrain tab, configure options, preview the result, and click Create.
4. **Navigate** — scroll to zoom; middle-click-drag or the Pan tool to move. Press **Home** or *Fit* to zoom to the whole world.
5. **Select a region** — switch to the Select tool, then click-drag a rectangle. Adjust the Z range in the inspector panel, or use the Magic Wand (**W**) to flood-select matching blocks.
6. **Inspect** — the right-hand panel shows dimensions, block counts, and orthographic previews of the selection. Click **3D VIEW** to render a Three.js preview.
7. **Edit** — with a selection active, use the bottom-left panel to fill, replace, or delete blocks.
8. **Generate trees** — with a selection active, expand the **TREES** section in the inspector to place deciduous, terrain, pine, or tall-pine trees at a given density.
9. **Extrude** — expand the **EXTRUDE** section to repeat the selection along an axis.
10. **Copy / paste** — Copy captures the selection. Switch to Paste and click to place. Use the banner toggles for *No Air*, *Terrain*, *Rotate 90°*, *Flip X/Y*, and *Repeat*.
11. **Draw** — activate a draw tool (Pen / Brush / Rect / Ellipse) from the Draw menu or keyboard. Pick a block from the hotbar or the picker. Enable *Mask* to restrict painting to a specific block type.
12. **Elevation panel** — enable in the inspector to see a front/side cross-section of the selection. Clicking in the panel places blocks at the exact Z level you click.
13. **Axo view** — *View → Axo View* switches to an isometric perspective; drag the Depth slider to change skew.
14. **Import Schematic** — *File → Import Schematic…* lets you bring in a Minecraft build, remap blocks, and paste it in.
15. **Export OBJ** — *File → Export OBJ…* writes a `.obj` + `.mtl` pair. Exports the current selection if one is active, otherwise the full world.
16. **Save** — *Save* writes changes to the original file in place. *Save As* writes to a new file. Toggle *☐ Compressed* to write a `.eden.zip`.
17. **Upload** — *File → Upload to Server…* lets you share the current world to the Eden servers. A PNG thumbnail is required.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| Scroll | Zoom in / out |
| Middle drag | Pan |
| Home | Zoom to fit |
| Escape | Clear selection / exit paste / exit draw tool |
| Cmd/Ctrl+Z | Undo |
| Cmd/Ctrl+Shift+Z or Y | Redo |
| P | Pen draw tool |
| B | Brush draw tool |
| R | Rectangle draw tool |
| E | Ellipse draw tool |
| W | Magic Wand tool |
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
  App.tsx                    — file open, toolbar state, keyboard shortcuts, menu bar
  MapCanvas.tsx              — Canvas: tiled rendering, pan/zoom/select/paste/draw input
  SelectionInspector.tsx     — floating stats + orthographic preview + extrude + trees + 3D view
  ElevationPreviewPanel.tsx  — resizable front/side elevation cross-section, draw support
  ThreeDPreview.tsx          — on-demand Three.js 3D render of the current selection
  WorldBrowserModal.tsx      — search/download worlds from Eden servers
  UploadModal.tsx            — upload world + thumbnail to Eden server
  NewWorldModal.tsx          — new world dialog (Flat / Natural / Classic / Tg2 tabs)
  SchematicImportModal.tsx   — Minecraft .schematic/.litematic import with block mapping
  HelpModal.tsx              — keyboard shortcut overlay
  drawTools.ts               — geometry helpers (penFootprint, brushFootprint, Bresenham line, rect, ellipse)
  blockDefs.ts               — block type registry, display colours, ramp/wedge helpers
src-tauri/src/
  lib.rs                     — world parser, all Tauri commands, colour tables, terrain generators
EdenWorldManipulator2.0/     — reference C# implementation (source only)
MROB.txt                     — file format reverse-engineering notes
```

### IPC

Pixel buffers cross the JS↔Rust boundary as base64-encoded binary (custom `serde` serialiser), cutting JS heap usage ~8× versus JSON number arrays. Edit commands return only the changed rectangle (`EditResult { patch: PixelPatch }`), so large worlds don't retransmit unchanged data.

### Rendering

Three render modes share the same canvas:

- **Tiled (default)** — 512-pixel tiles fetched on demand, up to 4 in-flight IPC requests, prioritised by distance from the viewport centre.
- **Full Map** — entire world streamed into a single offscreen canvas in 128-pixel strips; a progress bar tracks loading.
- **Axo View** — same offscreen canvas, loaded via `render_axo_region` strips; each edit forces a full reload.

### Undo / redo

Chunk-scoped snapshots: only chunks touched by an edit are copied before the change. A 256 MB byte-budget cap evicts the oldest entries first. Chunks whose bytes are unchanged after an edit are dropped before the snapshot is pushed.

### World generation

Three procedural generators live in `lib.rs`:

- **Natural** — a whole-world pipeline (not per-chunk) so trees, structures, and clouds span chunk borders without grid artefacts. Heightmap: domain-warped 6-octave FBM continents + ridged mountain peaks + optional erosion field (reduces relief amplitude in high-erosion regions, creating Minecraft-style flat-plain / highland alternation). Biome assignment uses per-column climate jitter (BIOME_DITHER=0.16) to speckle edges. Decoration: trees, cacti, flowers, weeds flush with surface, boulders, structures (cabin/well/watchtower/ruins/pyramid), clouds.
- **Classic** — faithful port of the original legacy generator using seeded Ken-Perlin noise with the same block IDs and cave passes as the shipped game.
- **Tg2** — port of the Eden 2.0 TerrainGen2 generator. Uses an intermediate flat workspace (`Tg2Grid`) so biome passes can read back already-placed blocks. Zone seams use a smoothstep + noise-warped `tg2_make_transition`; the `blend` post-pass bidirectionally blurs natural-terrain surface heights with a noise-warped box-blur kernel and hash-dithers palette seams.

### File format

Two chunk layouts are supported: standard (32 768 B / 64 z-levels) and extended (131 072 B / 256 z-levels). Compressed worlds (deflate zip) are detected by PK magic, decompressed to a temp file, and mmapped. The format is documented in `MROB.txt` and cross-referenced against the reference C# implementation in `EdenWorldManipulator2.0/`.

### Automated releases

Pushing a `v*` tag triggers a GitHub Actions workflow that builds macOS (universal binary), Windows, and Linux installers in parallel and publishes them as a draft GitHub Release.
