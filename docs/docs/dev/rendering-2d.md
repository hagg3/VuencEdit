---
layout: doc
title: "2D Rendering"
subtitle: "The tiled map, Relief shading, the Lens renderers, and HiDPI canvases."
---
{% raw %}
The top-down map and the slice viewports are drawn with the HTML **Canvas 2D**
API. All pixel data is rendered in Rust and shipped as `PixelPatch` /
`PreviewData` binary envelopes (see [IPC Reference](../ipc-reference/));
the frontend only composites and transforms.

> **Where the code lives.** Every renderer named below moved to
> `packages/voxel-core/src/render.rs`, generic over the `VoxelView` trait, and returns a
> `Raster`. `render_pixels_patch` / `render_zslice_patch_inner` in `src-tauri/src/lib.rs` are now one-line
> wrappers (`render::…(world, world.meta(), …).into()`) whose only job is turning the `Raster`
> into a `PixelPatch`/`PreviewData` for IPC, the crate has no `tauri` dependency, so the
> `IpcResponse` impl cannot live on its types.

## Render modes (top-down map)

`MapCanvas.tsx` draws the map in tiles:

- **Tiled.** `Map<string, HTMLCanvasElement>` of 512-px tiles fetched
  on demand via `fetch_tile`, up to `MAX_CONCURRENT = 4` in-flight IPC requests,
  prioritized by distance from the viewport center. Multi-level (see
  [Tile LOD + LRU](#tile-lod--lru)) and evicted by a bounded
  LRU, not by leaving the viewport.
- Tiled is the only map mode. Relief is a shading toggle on it (below). The old Full Map and
  Axonometric modes were removed.

## Relief shading

A hillshade on the tiled top-down map, with light from the NW. `voxel_core::render::pixels_patch_styled`
takes a `MapStyle { cap, relief }`. With relief off it *is* `pixels_patch_lod`: the branch sits
outside every loop, and a test pins the output byte-for-byte at LOD 1/2/4/8, with and without a cap.
With relief on, pass 1 runs the usual column scan (`scan_column`, shared with the plain render) over
the patch **plus a one-sample apron** (one row north and one column west, at `−lod`), recording
each sample's top z. Pass 2 shades
`f = clamp(1 + s·((h−h_w)+(h−h_n))/lod, 0.6, 1.35)` with `s = RELIEF_BASE(0.08)·strength/100`.
Off-world or empty neighbours fall back to the sample's own height, so they're unshaded, and a
transparent top contributes its own z, so a flat lake stays flat.

Backend state follows the `view_cap_z` idiom. `WorldState.view_relief: Option<u8>` is set by
`set_view_relief(strength)`, is a *preference* that isn't cleared on load/close, and is bundled with
the cap by `WorldState::map_style()`. `fetch_tile` and every edit patch read it, and
`fetch_tile`'s signature is unchanged.

⚠️ **Edit patches grow by one LOD step east and south** when relief is on, because an edited
column is the W/N neighbour of those samples. The growth happens in `edit_patch_capped`, the
single choke point for edit/undo/redo/`patch_from_chunk_coords`, *before* the clamps, the LOD
floor and the `MAX_EDIT_PATCH_PIXELS` check. Tests cover seams (tiles vs one render, at LOD
1/2/4/8) and edit patches matching a fresh render over the grown rect. Unshaded: Z-slice (`zslice_patch_lod`), the template overlay, PNG export's full-world render,
and the Lens window.

## Tile LOD + LRU

Rendering every tile at full resolution regardless of zoom wastes nearly all the work:
fit-zoom on a 7216×8448 world would ask for 15×17 = **255 tiles**, each scanning 262,144
columns down to 256 z (about 67 M column scans and 250 MB of pixels) to fill maybe 1 M screen
pixels. So tiles are level-of-detail based and cached with an LRU.

**The inversion:** a tile always renders `TILE`×`TILE` *output pixels*; at LOD `n`
it *covers* `TILE * n` world blocks per side. The visible tile count is then
roughly constant at any zoom, that same fit-zoom asks for ~20 tiles (~5 M
column scans), about 13× less work, and it does not grow as worlds get bigger.

### Backend

`render_pixels_patch_lod` / `render_zslice_patch_lod` take a `lod` step and
**point-sample** every `lod`-th block on both axes, output pixel `(ox, oy)` is
exactly the block at `(x1 + ox*lod, y1 + oy*lod)`. Not an average: nearest-neighbour
matches the canvas's `imageSmoothingEnabled = false` upscale, and at these zooms
the skipped columns were never visible. Cost drops by `lod²`.

- `lod` is an `Option<u32>` param on `fetch_tile`, `render_zslice_patch` and
  `fetch_template_tile`, clamped to `1..=MAX_LOD` (32). Omitted or `1` is full resolution, which is what every non-tile caller (edit
  patches) gets.
- `PixelPatch` carries its own `lod`, so a patch is self-describing rather than
  relying on the requester to remember what it asked for.
- ⚠️ **`fetch_template_tile` derives the chunks to decode from the sampled grid,
  not the tile rect.** At lod 32 a tile spans 1024×1024 template chunks but
  samples only 512×512 blocks; enumerating the rect would decode up to `lod²`×
  more template columns than the tile can possibly display.
- Test: `test_render_lod_matches_sampled_full_render` asserts every LOD pixel
  equals the corresponding full-resolution pixel (pinning the sampling *phase*,
  where an off-by-one would shift the zoomed-out map against the tile grid),
  plus the ragged-range dimensions and the clamping of out-of-range steps.

### Frontend (`MapCanvas.tsx`)

- **`lodForScale(scale)`** = the largest power of two ≤ `1/scale`. That keeps a
  rendered pixel at ≤ one screen pixel, so LOD never *upscales* (which would look
  blurrier than the old behaviour); `scale ≥ 1` → 1.
- **Cache key is `"lod,tx,ty"`** (`tileKey` / `parseTileKey`), so levels coexist.
  `draw()` paints coarser levels first and the current level last, which is what
  makes a zoom-out show content immediately instead of blanking and filling in.
  Off-screen tiles are skipped per frame.
- **Bounded LRU replaces prune-to-visible.** `touchTile` marks the needed set as
  most-recently-used (delete + re-set on an insertion-ordered `Map`), then
  `evictTiles` trims from the other end. The cap is
  `min(max(TILE_CACHE_LIMIT, 2 × visible tiles), max(visible tiles, byteCap))` -
  never below the visible window (a fixed cap alone would evict tiles the frame
  they arrive on a 4K viewport, where the visible window can exceed 96 tiles by
  itself) but also never above what `tileBudgetBytes` allows (split ⅔
  base-tile / ⅓ template-tile; `tileBudgetBytes` is a `MapCanvas` prop wired from the
  Low/Balanced/High memory preset). `evictTiles`/`clearTiles` zero a canvas's
  `width`/`height` before dropping it so the ~1 MiB backing store is released
  immediately instead of waiting on GC.
- **`applyPatch` handles both levels.** Edit patches are always lod 1: lod-1
  tiles take the usual 1:1 `putImageData`; lod > 1 tiles get the patch drawn
  through a nearest-neighbour downscale instead, so coarse levels stay live
  during an edit rather than blanking until a refetch lands.
- `refetchRegion` and `snapshotSelectionPixels` are LOD-aware too, the former
  invalidates intersecting tiles at *every* level, the latter draws coarser
  levels first so a finer tile covering the same ground wins.

## The scan ceiling (`top_band_hint`)

LOD cut how many *columns* a tile scans. This cuts how deep each scan goes, and,
more to the point, how many **pages of the world mapping** it touches.

**The mechanism.** A 256z chunk is 16 bands, and each band's 4096-byte *block*
half is exactly one page. `pixels_patch_lod`'s column scan walks bands from the
top of the world down, so on a world whose terrain tops out around z ≈ 64-96 it
touched ~10 pages of pure air before reaching anything, **per column**. One tile
fetch therefore paged in 64 KB of every chunk it covered regardless of how much
terrain was in it, and re-paged it on every re-fetch of an evicted tile. The pixel
output was right, but the cost showed up as ~10 GB of resident working set on an
11.8 GB world on Windows.

**The fix** is `VoxelView::top_band_hint(cx, cy)`: an **upper bound** on the
topmost band of that chunk holding anything. Scans start there instead of at
`num_bands() - 1`, via `scan_band_ceiling` (exclusive band bound) or
`scan_z_ceiling` (highest z worth considering).

- ⚠️ **One-directional contract.** Too high is always correct and merely slower -
  that *is* the trait default. Too low silently reports terrain as air to every
  renderer and to `surface_z`, hence to paint, terrain-paste, sculpt and flood
  fill. `voxel-core`'s `view::hint_tests` asserts a too-low hint is *observable*,
  precisely so nobody later "tightens" the contract into an exact value.
- **Adopted at:** `pixels_patch_lod` (the hint is fetched alongside the chunk in
  the `cx != last_cx` memo block, probing per sample would give back much of what
  it saves), `surface_z_capped`, `scan_chunk_lamps`, and
  `obj_geometry_region`'s emission loop.
- **Deliberately not adopted at:** the ortho selection views
  (`view_top`/`view_front`/`view_side`): they run over a band-scoped *scan
  buffer* addressed with a `b_lo` offset, not the mmap, so there are no pages to
  save and mixing the two coordinate spaces would be a trap; and the `yslice`/
  `xslice` slab renderers, which take an explicit caller z range over a single row of chunks.
- **Cache + invalidation** live in the app (`TopBandHints` in `lib.rs`), because
  only the app knows when its bytes changed. The invalidation rule has two halves, and the
  ceiling must be cleared *before* `edit_patch` renders the edit's own patch, not
  in `finish_edit` afterwards.
- **Measured** on a real 256z world (868 chunks, 16 bands): band scans
  drop to **18.8%** of what they were. A 4-band 64z world sees 77%, so there is little
  headroom, which is the point: the win is specifically the 256z case. Output is
  byte-identical across every adopted renderer.
- Zoomed-out tiles additionally bypass this scan entirely once the
  [overview raster](#overview-raster) is filled.
- A debug-only `[PAGES]` line on `fetch_tile` reports the live ratio. It `peek`s
  the cache rather than querying it, so the instrumentation can't page in the
  chunks it is supposed to be measuring.

## Overview raster

Zoomed-out tiles stop re-scanning the world. `apps/vuencedit/src-tauri/src/overview.rs`
(`OverviewRaster`, held in `LoadedWorld.overview: OnceLock<Option<_>>`) keeps, per chunk, a small grid
of the exact tuple `pixels_patch_lod` computes per sample, `(top_bt, top_paint, under_bt,
under_paint, top_z)`, 5 bytes/cell, at granularity **G** blocks per cell, `G ∈ {2, 4, 8, 16}`.

- **Granularity.** Real zoomed-out views are **LOD 2–8** (`lodForScale` tops out at 4 unless the
  world doesn't fit at 0.25 px/block), so a LOD-16 raster would never be read. G is therefore picked *finest that
  fits the byte budget* (`choose_granularity` / `raster_bytes`), and the raster serves any LOD that
  is a multiple of G (`OverviewRaster::serves`).
- **Adaptive G by memory preset.** `WorldState.overview_budget` (default 32 MB; Low 16 / Balanced
  32 / High 64 via `MEMORY_PRESETS.overviewBudgetBytes`; `set_overview_budget` clamps to 4–256 MB
  and drops the raster if G would change). A small world gets G=2, a huge one G=16.
- **Lazy fill.** Cells fill per chunk on first read, from the world's own `WorldRow` scan through
  the `voxel_core::render::SampleSource`/`SampleRow` seam, `pixels_patch_lod_from` /
  `pixels_patch_styled_from` are the real renderers, and `pixels_patch_lod`/`pixels_patch_styled`
  are thin wrappers over `WorldSource` (byte-identical, test-pinned). The raster's `RasterSource`
  is just another source, so relief, bounds and blending need no second implementation.
- **Who uses it.** `render_pixels_patch_styled` routes *uncapped* renders (no cutaway cap) at a LOD
  that is a multiple of G through `RasterSource`: `fetch_tile` (which calls
  `ensure_overview(ws.overview_budget)` for `lod ≥ 2` and no cap, so a session that stays zoomed in
  never allocates one) **and** the edit/undo/redo patches, which share that function. Capped
  (cutaway) views, Z-slices, LOD 1 and LODs that aren't a multiple of G scan the world as before.
- **Exact by construction.** Cells are the same samples the direct path would take (tile and patch
  origins are multiples of the LOD, so every sample lands on the G grid), not an approximation.
  Staleness is handled at one choke point: **`invalidate_derived(&[(cx, cy)])`** /
  `invalidate_derived_one` clears the chunk's `top_band_hint`
  *and* its raster cells, so every path that used to drop a hint, edit, undo/redo, rollback,
  `take()`n-world edits, drops the raster too, before the edit's own patch renders.
- **Persistence** (`<app_data>/overview/<fnv>.vxr`). The key covers file format, length, mtime,
  file id, `num_bands`, grid and chunk count, plus G. Written (off-thread, `PersistJob`) after a
  clean **uncompressed** `save_world` (seq-gated so a newer edit cancels it) or on a clean
  close / world switch; preloaded on a non-zip `load_world`. A stale or corrupt file is deleted;
  the store is LRU-trimmed to 256 MB (`trim_store`) and `sweep_store` clears orphans. Zip loads and
  recovered (autosave) sessions have no stable on-disk identity, so their raster stays in memory
  until an uncompressed save gives one.
- **Observability.** Diagnostics prints `Overview raster` (bytes, G, budget, lifetime
  served/scanned sample counts); the debug `[PAGES]` line adds `lod=`, `raster=served|off` and
  `raster_samples=served/scanned`.

## Slice / Z modes

- **Z-slice.** `render_zslice_patch` renders a constant-Z horizontal layer; a
  slider steps through layers. Uses the display/commit slider split
  (`zSliceDisplay`/`commitZSlice`) so dragging doesn't re-render per pixel.
- **Front/side slabs are gone.** They belonged to the retired quad layout. The Lens window
  (`render_paste_lens`, `render_selection_lens`) is the side-on view. `voxel-core`'s
  `render::yslice_patch`/`xslice_patch` remain in the crate.

## Cutaway view *(experimental)*

Makes the world behave as if it ended at a cap Z, for working on caves/interiors.
It's **backend state, not a render parameter:** `WorldState.view_cap_z: Option<i32>`
set via `set_view_cap(cap)`; every render and surface-consulting edit path
(`render_pixels_patch`, `surface_z_capped` → `paint_blocks`/`paste_terrain`/
sculpt/cursor-block/pick-surface) reads it off `WorldState`, so nothing else in
the IPC surface grew a `cap` parameter.

`viewMode` gains a `"cutaway"` option; the View tab's Z slider doubles as the
cap. The frontend's `viewCapZ` state mirrors the cap the backend already has
(not the one the UI wants), it's only set inside `set_view_cap`'s success
callback and used purely as a cache-invalidation key, since keying refetch on
`viewMode`/the raw slider value directly would refetch under the stale cap.
Committing the cap clamps the selection's `zMax`; the template overlay is
gated to top-down only. **The 3D pane is also clipped by the cutaway cap** -
`get_chunk_geometry` (geometry.rs) intersects the caller's Z band with
`ws.view_cap_z` server-side, so cutaway composes into the fly-view geometry too
(see [3D Rendering](../rendering-3d/)'s "Camera z band" section).

The cap/level slider (and Z-slice's Follow-surface check) lives in the **Cutaway / Z-slice context
panel**, which exists while the view mode is Cutaway or
Z-slice and whose ✕ returns to Top-down, not in a View-tab ribbon group.

## Coordinate & input model (`MapCanvas.tsx`)

The canvas sizes to its container via `ResizeObserver`; `toLocal()` subtracts the
bounding-rect before every coordinate transform, so the map works decoupled from
window layout (the map moves between the main pane and the 3D window).

Input is driven by a **`DragOp`** discriminated union (`MapCanvas.tsx`, the
`Tool`/`DragOp` type definitions are the source of truth, this is a
convenience summary, not a substitute for reading them):

```ts
DragOp = null
  | { kind: "pan"; ... }
  | { kind: "select"; ... }
  | { kind: "resizeEdge"; edge: ResizeEdge; ... }
  | { kind: "moveSel"; ... }
  | { kind: "draw-stroke"; pts: Set<string>; ... }
  | { kind: "sculpt-grab"; ... }
  | { kind: "draw-shape"; tool: "rect" | "ellipse" | "line"; start, end }
  | { kind: "lasso"; pts: WP[] }
  | { kind: "cam3d-drag" }
  | { kind: "materialize-select"; start, end }
```

Middle-mouse is **always** pan. `setPointerCapture` is only called for button 0/1,
**never button 2**: right-click context menus are unreliable via `pointerdown`
button 2 in macOS WKWebView, so the menu fires from `<canvas onContextMenu>`
(which `preventDefault()`s the OS menu). See the context-menu notes in
[Frontend](../frontend/).

**Tools:** draw/paint, `pan | select | wand | lasso | polyselect | paste |
pen | brush | spray | line | rect | ellipse | polygon | fill | eyedropper |
poolfill | materialize`; sculpt (16), `raise | lower | smooth | flatten |
slope | noise | erode | thermal | hydro | stamp | grab | terrace | sharpen |
smear | rock | carve`. `TOOL_LABELS`/`TOOL_CURSOR: Record<Tool, string>` are
the exhaustive sources of tool display names/cursors, adding a `Tool` is a
compile error until it's named in both.

## HiDPI canvas plumbing (`viewportUtils.ts`)

⚠️ **Never read `canvas.width`/`canvas.height` for layout math** in
`MapCanvas` / `LensView`: those are **device**
pixels. `viewportUtils.ts` owns the DPR plumbing:

- `resizeCanvasToContainer` sizes the backing store to `cssPx × dpr` (capped at
  `MAX_CANVAS_DPR = 2`).
- `beginFrame(ctx, canvas)` installs the DPR scale as the base transform and
  returns the CSS-pixel size.
- `cssWidth` / `cssHeight` report CSS pixels.

All drawing and pointer math is in **CSS pixels**. (`FlyView3D` has its own DPR
handling, `MAX_DPR = 1.5`, and is unaffected.)

Other pure helpers shared by `MapCanvas` + the Lens window: `zoomAtPoint`,
`makeSeqGuard` (stale-fetch protection), `putPatchPixels`.

## Edit → canvas patch flow

1. An editing command returns `EditResult { patch: PixelPatch, … }`: only the
   changed rectangle.
2. `applyEditResult()` decodes the patch (`decodePixelPatch`), draws it onto the
   affected tiles, and increments `editEpoch`.
3. Panels keyed on `editEpoch` (the Lens window, 3D) refetch as needed.

## Lens window

Front, side and top views of a selection, and of an armed paste, live in the Lens window
(see [Frontend](../frontend/#lens-window)). Its renderers are below (`render_paste_lens`, `render_selection_lens`).

## Paste lens elevation

The backend for the paste Lens: a front or side elevation of an **armed paste** -
terrain, the clipboard ghost at the Z it would land at, and the cells where they collide. Pure core
`voxel_core::render::paste_lens` (generic over `VoxelView`); the app shell (`render_paste_lens` in
lib.rs) computes one base Z per clipboard column and hands it over as `ClipRef::base`
(`LENS_SKIP` = not pasted).

- **Why a new render:** "buried" is a 3-D intersection along the ray (∃ depth where the clip cell
  is solid *and* the world cell is occupied). The two existing silhouettes (clipboard alone, world
  alone) can't derive it, both can be non-empty at a pixel without ever sharing a cell.
- ⚠️ **Bases come from the paste's own code.** Normal → `z_anchor + offset`; terrain →
  `terrain_paste_base(world, px, py, cap, above_surface) + offset`, the *same* fn `paste_terrain`
  writes with (extracted for this). `test_terrain_paste_base_matches_paste_terrain` runs a real
  paste and checks that exactly the predicted cells changed and that the lens's `buried` equals the
  solid-over-solid count. Shaped clipboards skip unmasked columns in both.
- **Pixel classes** (priority order): **buried** = the ghost block's colour under a red **hatch** (70 %
  tint on every 4th world-anchored `col + z` diagonal) over a light wash (25 %), `lens_clash_px`,
  `lens_hatch` · **cleared** = the same treatment in amber over the ghost block (or the terrain
  being deleted where there's no ghost), only with Skip air off (the box's air cells delete terrain) ·
  **ghost** = clip colour mixed 35 % toward clipboard green · **terrain** (50 % alpha in the
  `context` columns) · transparent. The three RGB constants mirror `theme.ts`'s `MAP.*` by hand
  (the crate can't import the theme), keep them in step. "Occupied" is any non-air block, fluids
  included (the paste overwrites water too).
- **Terrain is uncapped** even in cutaway (a hidden roof is still there); terrain-mode *bases* use
  the capped surface because the paste does.
- **Z window** = ghost ∪ footprint terrain-top range ± 4, clamped to `0..=max_z` (re-centred on the
  ghost if > 256 rows, which no current format reaches). Terrain reads skip above the chunk's
  `top_band_hint` ceiling, so the lens touches no air pages.
- **LOD** point-samples **columns only**, phase `col_lo` (the tile-LOD rule); the depth ray is
  always walked in full, since a sampled ray would miss collisions.
- Crate tests: brute-force buried/cleared oracle (counts + every buried pixel = the hatch/wash over its first ghost block), side = transpose of
  front on a mirrored fixture, Z-window clamps (64z/256z), LOD point sampling, skip columns.
- **One call, both views:** `render_paste_lens` computes the bases once and returns front +
  side in one envelope (`decodePasteLensPair`); `useLensRender.ts` makes one invoke per refresh.

## Lens renderers: selection mode

The paste lens's no-clipboard siblings, for the merged Lens window (selection mode's Elevation and Top views). All three lens renders share
`lens_frame` (column frame: `col_lo`, `lod = ceil(ncols / max_px)` ≤ `MAX_LOD`, `out_w`),
`lens_assemble` (column strips → raster), `lens_column`/`lens_read` and the 128 context alpha.

- **`selection_lens`** (front/side): per pixel, the first block along the ray whose `(x, y)` is in
  the selection (mask, else bbox) at alpha 255; failing that the first block at all at 128 (context
  columns, and in-bbox rays that only cross unmasked cells: **the mask is see-through**); else
  transparent. **Full height, not clipped to the z range** (the z band is a frontend overlay), and
  uncapped in cutaway. Z window = the whole world (`0..=max_z`, 64 or 256 rows), so a z-handle drag
  never runs off the image; a hypothetical format taller than 256 rows centres on the selection, or
  on `z_max` if the selection is taller still. `terrain_z_hi` (highest drawn row) lets the window open
  framed on the terrain instead of on sky.
- **Cost:** the ray is never strided. It is walked one chunk segment (16 cells) at a time, and only
  the rows still waiting for their answer are visited; rows above every remaining segment's
  `scan_z_ceiling` are dropped (hint only, no page touched), and the walk stops when none are left.
  There is **no `MAX_PREVIEW_BYTES` refusal**: the lens degrades through column LOD instead.
  Measured (front+side, warm): synthetic 4096² 256z world with overhangs 7 ms (512²),
  38 ms (2048²), 84 ms (4096²); `Eden.eden` (64z, 2880²) 18 ms whole-world. Target was < 150 ms at 2048².
- **`selection_top`**: top-down over the bbox ± context, **one LOD for both axes**
  (`ceil(max(ncols, nrows) / max_px)`, point-sampled like the tile LOD), each column scanned from
  `min(z_max, scan ceiling)` down to `z_min`, alpha as above. ≤ `max_px²` columns × ≤ 256 reads.
  Selection mode only and **on demand** (the `top` flag): ≤ 4 ms measured.
- Crate tests: per-pixel brute-force oracle (both views, with/without a random mask, with
  context), side = transpose of front, LOD point sampling, mask see-through, 256z full height + the
  tall-format window, the one-directional hint contract; `selection_top` vs `view_top`, its LOD
  sampling and z-range clip. `#[ignore]`d benches: `bench_selection_lens_256z` (crate),
  `bench_selection_lens` (app, real world files).
{% endraw %}
