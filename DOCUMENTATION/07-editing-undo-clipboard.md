# 07 — Editing, Undo & Clipboard

## The `with_edit` contract

All **11 editing commands** go through one function in `lib.rs`:

```rust
with_edit(ws, operation, snap_rect, patch_rect, edit_fn) -> EditResult
```

It owns the whole sequence:

1. `world.take()` — remove the world from the state.
2. `snapshot_chunks_full(affected_chunk_coords)` — a transient full pre-copy of
   the touched chunks.
3. Run the `edit_fn` closure (the actual mutation).
4. `render_pixels_patch` over `patch_rect` — the changed pixels.
5. `diff_chunk` each touched chunk into a stored **delta**.
6. Reinstall the world.
7. Push the delta onto the undo stack; clear redo.
8. Return `EditResult { patch, undo_depth, redo_depth }`.

**Invariant enforced structurally:** an `edit_fn` returning `Err` still reinstalls
the world before propagating. A fallible op between `take` and `reinstall` that
dropped the world would leave *every* later command failing "No world loaded".
Routing all edits through `with_edit` means there are no hand-audited call sites.

## Delta undo

`ChunkSnapshot.delta: ChunkDelta` is one of:
- `Sparse(Vec<(u32, u8)>)` — (offset, original-byte) pairs, for small edits.
- `Full(Vec<u8>)` — dense-edit fallback, chosen when `entries*5 >= chunk_size`.

`restore_and_invert` applies a delta and derives its exact inverse in one pass, so
`undo_edit`/`redo_edit` **never take a full pre-copy**. Both stacks are capped at
**256 MB** (`UNDO_BYTE_BUDGET`; `push_undo` evicts oldest, used for redo too).

`undo_edit`/`redo_edit` restore from their own stack (not via `with_edit`), but
are invariant-safe: they `take()` the world *before* popping their stack, erroring
on "No world loaded" without touching the stack. They also
`refresh_lamp_index_chunks` so the lamp index stays current.

Test: `test_delta_undo_round_trip`.

## Mutex safety

**All lock sites use `state.lock().unwrap_or_else(|p| p.into_inner())`** — a panic
while holding the lock must not poison every subsequent command. Keep this pattern
for new commands.

## Drawing tools

`paint_blocks(blocks, block_type, paint, z_offset)` — `z = None` → `surface_z`.

> ⚠️ **`paint_blocks`'s `z_offset` is `Option<i32>`** (defaults 0). It was once a
> required `i32`, and three frontend callers passing exact coordinates omitted it
> — slab-viewport painting, elevation-panel drawing, and 3D break/place all failed
> at runtime with `missing required key zOffset`. Tauri won't catch this at compile
> time; keep it optional.

Geometry helpers in `src/drawTools.ts`: `penFootprint`, `brushFootprint`,
`bresenhamLine`, `linePixels`, `polygonPixels`, `rectPixels`, `ellipsePixels`.
Tested in `drawTools.test.ts`.

**Draw tools** (Home-tab Tools group):
- **Pen (P)** / **Brush (B, size 1–9 sq/circ)** — freehand stamp.
- **Spray (scatter)** — `sprayDensity` fraction of the brush footprint placed per
  stamp; runs on the 140 ms hold-to-build timer (timer-only, so a quick click
  stamps once).
- **Line (L)** — `linePixels(a,b,size,shape)` thickens the bresenham centerline.
- **Rect (R)** / **Ellipse (E)** — drag shapes, fill/outline.
- **Polygon/lasso (G)** — click to add vertices, click near the first or
  double-click to close, Escape cancels; `polygonPixels` scanline-fills or
  edges-only.
- **Stroke stabilizer** — low-passes the freehand pointer path (`α = 0.35`) to
  filter jitter; flushed to the release point on pointer-up. Freehand tools only.
- **Gradient fill** (Selection tab) — `gradient_fill(...)` blends Fill block → a
  second block across x/y/z with an **8×8 Bayer ordered dither** (`BAYER8`, 64
  levels) indexed purely by (x,y) so the pattern stays clean regardless of surface
  height; re-skins existing blocks unless `includeAir`. Axis default `y`.

`MapCanvas` centralizes footprint building in `stampFootprint(p, tool, cfg)`;
predicates `isFreehand`/`isShapeTool`/`isSculptStroke`.

**Draw mask:** `maskEnabled/maskBlockType/maskPaint` (frontend) → Rust
`mask_type/mask_paint` in `paint_blocks` restrict painting to matching cells.

## Terrain sculpt (`sculpt_terrain`/`sculpt_terrain_inner`) *(experimental)*

Axiom-style heightmap sculpting. **14 modes:**

| Mode | Behavior |
|---|---|
| Raise / Lower | Push/pull by `strength`. |
| Grab | Drag ↕ to pull terrain by `grab_delta`; domes via falloff. |
| Smooth | 8-neighbour weighted kernel (cardinals 1, diagonals √½, centre 1; missing neighbours drop out = "fix edges"); iterates `strength` Jacobi passes over a local working copy (order-independent) before committing once. |
| Flatten | Level to the pointer-down anchor column's height (`anchor_x/anchor_y`); falls back to footprint avg. |
| Slope | Flatten tilted by `slope_dx/slope_dy` (±100% grade pair from the Ribbon); at `dx=dy=0` behaves exactly like Flatten. |
| Noise | Coherent `fbm2` "hills" / `ridged2` "mountains" (`noise_mode` + `freq`); per-stroke seed offset (never white noise). |
| Erode | Drop toward lowest neighbour by `strength`. |
| Thermal | Talus-angle erosion (`talus = 9 - strength`, sheds ½ the excess). |
| Hydro | Beyer/SebLague-style droplet hydraulic erosion — continuous float position, bilinear height/gradient sampling, inertia-steered flow, sediment capacity/erode/deposit dynamics, erosion spread across a radial brush — dendritic gullies rather than 1-wide trenches. Workspace = footprint + 16-cell margin; commit is footprint-only (margin changes are simulated, never written). |
| Stamp/Retexture | Repaint surface by 8-neighbour steepness: flat→grass, mid→dirt, steep→stone; heights unchanged. |
| Terrace | Quantizes height to `strength`-block steps. |
| Sharpen | Unsharp mask over the Smooth kernel — amplifies deviation from the local average. |
| Smear | Advects height from `(p.x-smear_dx, p.y-smear_dy)` toward the drag direction each tick; no-op at `dx=dy=0`; forced onto the timer regardless of hold-build since a one-shot commit has no drag-direction info. |

- **Radial falloff — two paths, same math:** `softness` (0..1) + `profile`
  (`smooth`/`linear`/`sphere`/`sharp`). *Dial* path (every 2D/3D freehand stamp):
  a clean Euclidean dome around the stamp centre. *BFS* path (shape fills:
  rect/ellipse/polygon): 8-connected distance field over the swept footprint.
  0 softness = hard flat edges on either path. Every mode blends `cur→target` by
  the per-column weight, dithered with the shared **8×8 Bayer table** (`BAYER8`,
  also used by gradient fill) when `softness > 0` to avoid ring/terrace artifacts;
  rounds plainly at `softness <= 0`.
- **Grouped undo (`group_id: Option<u64>`):** a whole hold-to-build stroke commits
  as **one** undo/redo step, not one per tick — `UndoEntry.group` lets
  `undo_edit`/`redo_edit` pop-and-restore while the next stack entry shares the
  same group; `undo_depth`/`redo_depth` count groups. The frontend generates a
  monotonic stroke id at stroke-start and threads it through every stamp,
  including timer ticks.
- **`use_cap: Option<bool>`** (default true) — whether surface targeting respects
  the [Cutaway view cap](./05-rendering-2d.md#cutaway-view-experimental); 3D-pane
  sculpting passes `false` (cutaway is a 2D-only concept there).
- **Block layering (`sculpt_column`):** explicit fill block → verbatim; grass
  surface with no fill → dirt body + grass cap; else surface block all the way up.
- **Hold-to-build (airbrush), always-on:** MapCanvas/FlyView3D run a 140 ms
  interval while a stroke is held, re-stamping the live cursor footprint at the
  current radius — one `sculpt_terrain` call per tick, coalesced into one undo
  group. `accumBusyRef` skips overlapping async ticks (hydro can exceed the
  interval); a final stamp also fires on release. Excludes Flatten/Grab/Slope
  (these converge in one shot from their anchor, not a swept path).
- **Live 2D stroke sessions ("Row 6", default on).** A live 2D stroke is a run of
  `sculpt_terrain` calls sharing one `group_id`: MapCanvas's brush engine stamps
  on pointer-down, emits a stamp centre every `~radius*0.5` cells of travel
  (spacing), and re-stamps in place on the 140 ms dwell timer (airbrush). Centres
  batch through one in-flight `sculpt_terrain` call at a time, carrying every
  centre queued since the last flush. Escape reverts the whole stroke (await the
  in-flight flush, then one `undo_edit`). The backend caches each stroke's
  **precise float height per column** (`WorldState.sculpt_session`) so sub-block
  deltas accumulate instead of rounding away every call — only the final dithered
  round hits the world. This float workspace **must be cleared the instant a
  non-stroke edit changes the world**; it's wired into every edit command, undo/
  redo, world load, and world close. Live brush off falls back to the legacy
  one-shot swept-path commit (silhouette dome).
- **Modifiers (both viewports):** Ctrl/⌘ held during a stroke swaps Raise↔Lower;
  Shift temporarily switches to Smooth (all tools except Grab, to avoid silently
  discarding `grab_delta`). `[`/`]` resize radius, Shift+`[`/Shift+`]` resize
  strength.
- **Selection mask:** `sculptClipToSelection` filters stroke points to
  `rawBounds` (2D: point-list filter; 3D: stamp-centre-in-bounds skip).
- **3D-pane sculpting:** a fourth `mode3d`, alongside Camera/Select/Build — hold
  left to stamp the raycast-picked column with the same brush settings as the 2D
  map (backend generates the disc server-side, no point list over IPC).
- Grab is a dedicated `sculpt-grab` DragOp (fixed disc + vertical-drag `delta`).

Tests (lib.rs): `test_sculpt_coherent_noise`, `test_grouped_undo_round_trip`,
`test_dial_vs_bfs_falloff_parity`, `test_dither_determinism_and_hard_bypass`,
`test_smooth_strength_flattens_more`, `test_terrace_quantizes_to_step`,
`test_sharpen_widens_range`, `test_slope_tilts_plane_from_anchor`,
`test_smear_advects_height_along_drag`, `test_hydro_determinism`,
`test_hydro_erodes_a_peak`, `test_hydro_commit_stays_in_footprint`,
`test_hydro_erosion_spreads_across_columns`,
`test_residual_accumulates_sub_block_deltas`, `test_clip_rect_masks_stamp_cells`,
`test_sculpt_session_cleared_by_foreign_edit`,
`test_sculpt_session_cleared_by_undo`.

## Copy / paste system

```rust
struct Clipboard { width, height, depth, z_anchor, block_types: Vec<u8>, paints: Vec<u8> }
// flat index: dz * height * width + dy * width + dx
```

- **Normal paste:** `z = z_anchor + elevation_offset`.
- **Terrain paste:** per-column `surface_z + elevation_offset`.
- **Rotation 90° CW:** `(dx,dy) → (dy, width-1-dx)`; ramps/wedges `(off+3)&3`.
- **Mirror X/Y:** `mirror_ramp_id_x/y`.
- **Two-click paste:** first click locks XY (amber ghost), second fires.
- Commands: `paste_at`, `paste_terrain`, `rotate_clipboard`,
  `mirror_clipboard_x/y`.

**Advanced paste:**
- **Scatter** — N random placements (`scatter_paste`). ⚠️ When the clipboard is
  larger than the scatter box, the placement range clamps to 1 (every paste lands
  at `x1`/`y1`), so the snapshot/patch rect is widened to the true placement extent
  (`x1..max(x2, x1+width-1)`) — otherwise chunks the paste touches past `x2`/`y2`
  go unsnapshotted (broken undo) and unpatched (stale tiles).
- **Array** — cols×rows grid with spacing (`array_paste`).

## Non-rectangular selection

The selection can carry a per-column **cell mask** on top of its rect, so Wand
and Lasso select an actual shape instead of a bounding box. The mask is
**backend-resident state** (`WorldState.selection_mask: Option<SelectionMask>`,
bbox + row-major bitset) — IPC commands don't thread a mask param, they resolve
it via `active_mask(ws, x1,y1,x2,y2)`, which only honours the mask when the
passed rect **exactly equals** the mask's bbox. A stale mask therefore degrades
to rect-only behavior, never a corrupt edit.

- **Mask-aware edits:** `delete_blocks`, `replace_blocks`, `move_selection`
  (shifts the mask's bbox with the move so the shape survives), clipboard copy/
  paste (`Clipboard.mask`, all three paste loops, rotate/mirror transforms),
  `gradient_fill` (the ramp fraction is still measured over the full bbox; the
  mask clips which columns receive it), `extrude_selection` (gates on the
  *source* cell — the shape is what repeats, never evaluated at dest coords),
  and `generate_trees` (canopy spill outside the mask is accepted, like the
  existing rect spill).
- **Mask-aware previews/views** (unmasked cells hidden, not dimmed): the 2D
  paste ghost, the elevation ghost, the axo clipboard ghost, the ortho selection
  view (front/side let a masked block *behind* an unmasked column show through),
  and the floating 3D preview (unmasked columns read as air, so hole-facing side
  faces emit). The **3D fly-view** overlay decomposes the mask into merged
  fill-only slabs under one edges-only bbox ring; a mask that fragments past 64
  rects falls back to the single bbox.
- **Stays rect-only (deliberate):** sculpt clip-to-selection, the world-context
  axo region view (parallax sampling would punch incoherent holes — the
  *clipboard* axo path is masked), and the elevation panel's full-height view
  (an explicit ±N-context orientation view, not an edit preview). Extrude/paste
  amber ghosts stay bbox.
- **Wand** (`magic_wand_select`) installs the mask from its BFS match. **Lasso**
  (freehand drag → scanline polygon fill → `set_selection_mask`) is the
  frontend-only counterpart. `describe_selection` reports `cell_count`/`masked`
  for the status-bar "shaped selection" badge; `get_selection_mask` feeds the
  canvas overlay (an offscreen bitset canvas blitted over the selection box,
  only while idle and only when the mask's bbox matches the committed rect).
- **Prefab save carries the mask:** a shaped clipboard serializes with an extra
  footprint section, rectangular ones stay byte-for-byte compatible with the
  original format; both round-trip through load, and thumbnails/paste already
  honour the mask so they follow automatically.
- The mask clears on world load/close. A single frontend effect clears the
  backend mask whenever the selection is reshaped by anything other than the
  wand/lasso commit that created it.

## Prefabs (`.epfab`)

**Format:** `b"EPFAB\x01"` + width/height/depth/z_anchor (i32 LE) + gzipped
`block_types ++ paints`.

Commands: `save_prefab` (reads clipboard → gzip → `atomic_write`), `load_prefab`,
`list_prefabs` (which uses the internal `read_prefab_header` helper for dims),
`delete_prefab`, `rename_prefab`, `prefab_exists`, `render_prefab_thumbnail`,
`get_default_prefab_dir`. The
delete/rename Rust commands **guard on the `.epfab` extension**.

**Save flow (App.tsx):** default **Save Prefab** opens an in-app name modal
(`prefabNameModal`) that writes `<name>.epfab` into the library dir and bumps
`prefabRefreshToken` — deliberately **not** the native save panel, which hangs
~30 s on macOS Sonoma (`NSSavePanel` ViewBridge XPC stall). **Overwrite guard:**
first Save calls `prefab_exists`; a taken name arms `prefabOverwrite` (amber
warning) instead of saving; a second click confirms. `savePrefabAs()` keeps the
native picker for arbitrary folders. All paths funnel through `save_prefab`.

**Prefab library gallery (`PrefabLibraryPanel.tsx`):** dockable panel listing
`.epfab` files. Thumbnails load **sequentially** (one `invoke` in flight — a
fire-all-at-once version froze on big folders), cached by `path::mtime`
(`thumbCacheRef`). Client-side search (`query`), sort (name/newest/size), and
list⇄grid view persisted in `localStorage`. Per-entry inline rename + delete.
Folder = `resolvePrefabDir()`: Settings `prefabDirectory` → app-default
`<app_data_dir>/prefabs`. Buttons: Refresh, Open Folder (`openPath` — needs
`opener:allow-open-path`), Save Selection As…

## Other editing features

- **Magic Wand** (`magic_wand_select`) — BFS flood-fill, 50k-cell cap, type±paint
  match. Key `W`, violet highlight.
- **Extrude** (`extrude_selection(..., axis, count, ignore_air)`) — N
  non-overlapping copies in one undo step. UI in SelectionInspector.
- **Tree gen** (`generate_trees(x1,y1,x2,y2, tree_types, density, leaf_paints,
  seed)`) — multi-type (normal/terrain/pine/tall_pine, random per column),
  user-supplied `leaf_paints` pool (empty → type default). Snapshot rect is the
  selection ±3 for canopy spill; the returned patch uses the **same** expanded rect
  so spilled leaves render immediately.
