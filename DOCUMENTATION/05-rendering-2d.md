# 05 — 2D Rendering

The top-down map and the slice viewports are drawn with the HTML **Canvas 2D**
API. All pixel data is rendered in Rust and shipped as base64 `PixelPatch` /
`PreviewData`; the frontend only composites and transforms.

## Render modes (top-down map)

`MapCanvas.tsx` supports three modes, all sharing one canvas:

- **Tiled (default).** `Map<string, HTMLCanvasElement>` of 512-px tiles fetched
  on demand via `fetch_tile`, up to `MAX_CONCURRENT = 4` in-flight IPC requests,
  prioritized by distance from the viewport center. Tiles are evicted as the view
  moves.
- **Full Map.** A single offscreen canvas filled in 128-px strips, with an amber
  progress bar. Best for lag-free pan/zoom on large worlds once loaded.
- **Axo (axonometric).** `render_axo_region(x1,y1,x2,y2, ski)` — `ski = 0.2` gives
  an SE isometric perspective; the Skew slider adjusts it. **Edits force a full
  reload** (the projection can't be patched incrementally).

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
gated to top-down only. The 3D pane is **not** clipped by the cutaway cap.

## Coordinate & input model (`MapCanvas.tsx`)

The canvas sizes to its container via `ResizeObserver`; `toLocal()` subtracts the
bounding-rect before every coordinate transform, so the map works decoupled from
window layout (essential for quad view).

Input is driven by a **`DragOp`** discriminated union:

```ts
DragOp = null
  | { kind: "pan" }
  | { kind: "select" }
  | { kind: "draw-stroke"; pts: Set<string> }
  | { kind: "draw-shape"; tool: "rect" | "ellipse"; start, end }
  | { kind: "cam3d-drag" }
  | { kind: "sculpt-grab"; ... }
```

Middle-mouse is **always** pan. `setPointerCapture` is only called for button 0/1,
**never button 2** — right-click context menus are unreliable via `pointerdown`
button 2 in macOS WKWebView, so the menu fires from `<canvas onContextMenu>`
(which `preventDefault()`s the OS menu). See the context-menu gotcha in
[09 — Frontend](./09-frontend.md).

**Tools:** `pan | select | wand | paste | pen | brush | rect | ellipse` (plus
sculpt tools). `TOOL_LABELS: Record<Tool, string>` is the single source of tool
display names — adding a `Tool` is a compile error until it's named.

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
