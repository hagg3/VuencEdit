# 05 — 2D Rendering

The top-down map and the slice viewports are drawn with the HTML **Canvas 2D**
API. All pixel data is rendered in Rust and shipped as `PixelPatch` /
`PreviewData` binary envelopes (see [04](./04-ipc-reference.md#binary-payload-envelope-2026-08-05-audit-h2));
the frontend only composites and transforms.

## Render modes (top-down map)

`MapCanvas.tsx` supports three modes, all sharing one canvas:

- **Tiled (default).** `Map<string, HTMLCanvasElement>` of 512-px tiles fetched
  on demand via `fetch_tile`, up to `MAX_CONCURRENT = 4` in-flight IPC requests,
  prioritized by distance from the viewport center. Multi-level (see
  [Tile LOD + LRU](#tile-lod--lru-2026-08-05-audit-h6)) and evicted by a bounded
  LRU, not by leaving the viewport.
- **Full Map.** A single offscreen canvas filled in 128-px strips, with an amber
  progress bar. Best for lag-free pan/zoom on large worlds once loaded.
- **Axo (axonometric).** `render_axo_region(x1,y1,x2,y2, ski)` — `ski = 0.2` gives
  an SE isometric perspective; the Skew slider adjusts it. **Edits force a full
  reload** (the projection can't be patched incrementally).

## Tile LOD + LRU *(2026-08-05, audit H6)*

Before this, tiles were always 512×512 **world blocks** rendered at full
resolution regardless of zoom. Fit-zoom on a 7216×8448 world therefore asked for
15×17 = **255 tiles**, each scanning 262,144 columns down to 256 z — ~67 M column
scans and ~250 MB of pixels, to fill maybe 1 M screen pixels. ~99% of the work was
thrown away by the downscale. The tile cache also pruned to exactly the visible
window + 1, so panning back re-fetched tiles discarded a frame earlier.

**The inversion:** a tile always renders `TILE`×`TILE` *output pixels*; at LOD `n`
it *covers* `TILE * n` world blocks per side. The visible tile count is then
roughly constant at any zoom — that same fit-zoom now asks for ~20 tiles (~5 M
column scans), a ~13× reduction, and it does not grow as worlds get bigger.

### Backend

`render_pixels_patch_lod` / `render_zslice_patch_lod` take a `lod` step and
**point-sample** every `lod`-th block on both axes — output pixel `(ox, oy)` is
exactly the block at `(x1 + ox*lod, y1 + oy*lod)`. Not an average: nearest-neighbour
matches the canvas's `imageSmoothingEnabled = false` upscale, and at these zooms
the skipped columns were never visible. Cost drops by `lod²`.

- `lod` is an `Option<u32>` param on `fetch_tile`, `render_zslice_patch` and
  `fetch_template_tile`, clamped to `1..=MAX_LOD` (32). Omitted/`1` is the
  pre-LOD behaviour byte-for-byte, which is what every non-tile caller (edit
  patches, full-map strips, slice slabs) still gets.
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
  `min(max(TILE_CACHE_LIMIT, 2 × visible tiles), max(visible tiles, byteCap))` —
  never below the visible window (a fixed cap alone would evict tiles the frame
  they arrive on a 4K viewport, where the visible window can exceed 96 tiles by
  itself) but also never above what `tileBudgetBytes` allows (2026-08
  memory-efficiency pass §2 — the byte ceiling that was missing before; split ⅔
  base-tile / ⅓ template-tile, matching the historical 96/48-tile ratio;
  `tileBudgetBytes` is a `MapCanvas` prop wired from `MEMORY_PRESETS` — see
  CLAUDE.md's "Memory Budget" section). `evictTiles`/`clearTiles` zero a canvas's
  `width`/`height` before dropping it so the ~1 MiB backing store is released
  immediately instead of waiting on GC.
- **`applyPatch` handles both levels.** Edit patches are always lod 1: lod-1
  tiles take the usual 1:1 `putImageData`; lod > 1 tiles get the patch drawn
  through a nearest-neighbour downscale instead, so coarse levels stay live
  during an edit rather than blanking until a refetch lands.
- `refetchRegion` and `snapshotSelectionPixels` are LOD-aware too — the former
  invalidates intersecting tiles at *every* level, the latter draws coarser
  levels first so a finer tile covering the same ground wins.

## Slice / Z modes

- **Z-slice.** `render_zslice_patch` renders a constant-Z horizontal layer; a
  slider steps through layers. Uses the display/commit slider split
  (`zSliceDisplay`/`commitZSlice`) so dragging doesn't re-render per pixel.
- **Quad-view front/side slabs** are `SliceViewport.tsx` — see
  [06 — 3D Rendering](./06-rendering-3d.md#quad-view) for the quad layout, and the
  slab/ortho detail below.

## Cutaway view *(experimental)*

Makes the world behave as if it ended at a cap Z, for working on caves/interiors.
It's **backend state, not a render parameter:** `WorldState.view_cap_z: Option<i32>`
set via `set_view_cap(cap)`; every render and surface-consulting edit path
(`render_pixels_patch`, `surface_z_capped` → `paint_blocks`/`paste_terrain_at`/
sculpt/cursor-block/pick-surface) reads it off `WorldState`, so nothing else in
the IPC surface grew a `cap` parameter.

`viewMode` gains a `"cutaway"` option; the View tab's Z slider doubles as the
cap. The frontend's `viewCapZ` state mirrors the cap the backend already has
(not the one the UI wants) — it's only set inside `set_view_cap`'s success
callback and used purely as a cache-invalidation key, since keying refetch on
`viewMode`/the raw slider value directly would refetch under the stale cap.
Committing the cap clamps the selection's `zMax`; the template overlay is
gated to top-down only. **The 3D pane is also clipped by the cutaway cap** —
`get_chunk_geometry` (export.rs) intersects the caller's Z band with
`ws.view_cap_z` server-side, so cutaway composes into the fly-view geometry too
(see [06 — Rendering 3D](./06-rendering-3d.md)'s "Camera z band" section).

## Coordinate & input model (`MapCanvas.tsx`)

The canvas sizes to its container via `ResizeObserver`; `toLocal()` subtracts the
bounding-rect before every coordinate transform, so the map works decoupled from
window layout (essential for quad view).

Input is driven by a **`DragOp`** discriminated union (`MapCanvas.tsx`, the
`Tool`/`DragOp` type definitions are the source of truth — this is a
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
**never button 2** — right-click context menus are unreliable via `pointerdown`
button 2 in macOS WKWebView, so the menu fires from `<canvas onContextMenu>`
(which `preventDefault()`s the OS menu). See the context-menu gotcha in
[09 — Frontend](./09-frontend.md).

**Tools:** draw/paint — `pan | select | wand | lasso | polyselect | paste |
pen | brush | spray | line | rect | ellipse | polygon | fill | eyedropper |
poolfill | materialize`; sculpt (16) — `raise | lower | smooth | flatten |
slope | noise | erode | thermal | hydro | stamp | grab | terrace | sharpen |
smear | rock | carve`. `TOOL_LABELS`/`TOOL_CURSOR: Record<Tool, string>` are
the exhaustive sources of tool display names/cursors — adding a `Tool` is a
compile error until it's named in both.

## HiDPI canvas plumbing (`viewportUtils.ts`)

⚠️ **Never read `canvas.width`/`canvas.height` for layout math** in
`MapCanvas` / `SliceViewport` / `ElevationPreviewPanel` — those are **device**
pixels. `viewportUtils.ts` owns the DPR plumbing:

- `resizeCanvasToContainer` sizes the backing store to `cssPx × dpr` (capped at
  `MAX_CANVAS_DPR = 2`).
- `beginFrame(ctx, canvas)` installs the DPR scale as the base transform and
  returns the CSS-pixel size.
- `cssWidth` / `cssHeight` report CSS pixels.

All drawing and pointer math is in **CSS pixels**. (`FlyView3D` has its own DPR
handling, `MAX_DPR = 1.5`, and is unaffected.)

Other pure helpers shared by `MapCanvas` + `SliceViewport`: `zoomAtPoint`,
`makeSeqGuard` (stale-fetch protection), `putPatchPixels`.

## Edit → canvas patch flow

1. An editing command returns `EditResult { patch: PixelPatch, … }` — only the
   changed rectangle.
2. `applyEditResult()` decodes the patch (`decodePixelPatch`), draws it onto the
   affected tiles, and increments `editEpoch`.
3. Panels keyed on `editEpoch` (elevation preview, slabs, 3D) refetch as needed.

## Elevation preview panel (`ElevationPreviewPanel.tsx`)

Bottom-right, opt-in. Fetches `render_full_height_view` (debounced 150 ms) on
footprint/`editEpoch` change. Shows extrude ghost bands and ±7 context columns at
50% opacity. Resizable 140–800 × 100–600. **Suppressed in quad view** (the slabs
replace it). Clicking in it places blocks one block deep at the exact Z you click.

## Slab & ortho viewports (`SliceViewport.tsx`)

Self-contained component, `axis = "front" | "side" | "top"`:

- **Slab mode (default).** Offscreen `slabRef` canvas, strip-tiled
  (`STRIP = 256`) progressive fetch; `fetchSeqRef` discards stale strips.
  Selection-scoped: with a selection, fetches selection + 50% context (grays
  context columns); without one, a free window (`MAX_WIN = 2048`).
- **Ortho mode.** Auto-enables when a selection appears (front/side only); fetches
  `render_selection_view`. Painting is blocked (pan only); the depth slider moves
  a crosshair only.
- **Crosshairs:** `crossH` (violet vertical) + `crossV` (sky-blue horizontal).
- **Editing (slab only):** `onPaint(cells[])`, pen/brush/rect/ellipse, deduped to
  one undo entry via `handleSlicePaint`.
- **Overlays:** selection z-box (blue dashed), paste ghost (green), extrude bands;
  drag-to-resize Z edges (`Z_EDGE_HIT = 5px`) and the horizontal divider.
- **Marquee-select:** left-drag with the select tool — front sets X+Z, side sets
  Y+Z.
- **Edit-broadcast guard:** a slab refetches on `editEpoch` only if its depth
  plane intersects the edit bounds; ortho refetches only if the edit overlaps the
  selection XY.
