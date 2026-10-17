---
layout: doc
title: "Editing, Undo & Clipboard"
subtitle: "The edit pipeline, delta undo, copy and paste, prefabs and sculpting."
---
{% raw %}
## The `with_edit` contract

Every editing command goes through one of two functions in `lib.rs`, both thin
wrappers over `with_edit_inner`:

```rust
with_edit(ws, operation, patch_rect, edit_fn) -> EditResult
with_edit_grouped(ws, operation, patch_rect, group, edit_fn) -> EditResult
```

`edit_fn: FnOnce(&mut EditView) -> Result<(), String>`. `with_edit_inner` owns the
whole sequence:

1. `world.take()`: remove the world from the state.
2. Wrap it in an **`EditView`** (the copy-on-write pre-image, below) and run the
   `edit_fn` closure, the actual mutation.
3. On `Err` (or a pre-image trip) **roll back exactly**: write every captured band
   back, `invalidate_derived` those chunks (scan ceiling + overview raster), reinstall, return the error.
4. `invalidate_derived` the captured chunks (their `top_band_hint`s *and* overview-raster cells), then `edit_patch` over
   `patch_rect`: the changed pixels, at `WorldState::view_lod` and
   **capped** at `MAX_EDIT_PATCH_PIXELS`.
5. `capture_deltas`: diff each captured chunk's pre-bands against the world into a
   stored **delta** (`band_delta`).
6. Reinstall the world.
7. Push the delta onto the undo stack; clear redo, *unless* it doesn't fit the
   budget, see "Budget enforcement" below.
8. Return `EditResult { patch, invalidate, undo_depth, redo_depth, operation,
   undo_dropped }`.

Steps 6–8 are factored into **`finish_edit(ws, operation, group, patch, invalidate,
pre_snap)`**, which is also what the sculpt read/write split calls, so
the lamp-index replay, the dirty-set marking and the undo-budget rule have exactly
one implementation rather than two that can drift.

`patch_rect` is only the pixels returned to the frontend (some ops widen it past the
selection: tree canopies spill ±3, flow spreads 3 past its edges). It doesn't
bound anything undo-related, so there is no up-front range to get wrong.

### `EditView`: copy-on-write, band-granular pre-image

Copying every chunk under the edit's rect before it runs is wasteful: a rect is not a
change, and one block changed inside a ⌘A rect would cost a whole-world transient copy for a
48 B undo entry. So the pre-image is captured lazily.

`EditView` wraps `&mut LoadedWorld` and captures **the bands the edit actually
writes**, the moment it first writes them:

- `band_bytes_mut(cx, cy, band)` copies that band's current (= pre-edit) 8 KiB aside
  on first touch, then hands out the **world's** band. The world is the post-image
  at every instant, so **every read inside the edit is correct for free**: through
  the view's `VoxelView` impl or through `Deref` to `&LoadedWorld` (`chunk_range`,
  `bytes[i]` as an rvalue, `surface_z(&*view, ..)`). That is why this is CoW in
  place rather than an overlay like `ChunkScratch` (an overlay makes every read
  that bypasses it stale).
- A `last` `(cx, cy, band)` cache makes the per-voxel hot path a compare. Measured
  on a ⌘A replace over a 64z 32×32-chunk world: +6 % (dev), −7 % (release) vs a full
  snapshot (`bench_cow_select_all_replace`, ignored).
- **Compare before write.** `voxel_core::set_block_in_band` (and so `set_block_abs`)
  reads the band first and never asks for a writable band when neither byte would
  change; the migrated bulk writers (`rewrite_column_runs` behind delete/replace,
  `write_column_bulk`, `paste_clipboard_at`, `extrude_write`) do the same per band
  run. A delete over air, or a fill with the block already there, captures nothing
  and dirties no `MAP_SHARED` page.
- ⚠️ **`Deref`, deliberately no `DerefMut`.** A raw `view.bytes[i] = v` or a
  `&mut LoadedWorld` helper call doesn't compile inside an edit, so nothing can
  write around the capture. Writers are `&mut impl VoxelViewMut` (pure ones) or
  `&mut EditView` (ones that also read `LoadedWorld` fields: trees, flow, pool,
  wavy). Tests drive the latter directly with `EditView::unbounded(&mut world)`;
  `EditView::set_byte(abs, v)` is the test-only raw write.
- ⚠️ **The `top_band_hint` trap.** An edit can raise terrain above a chunk's cached
  ceiling, and the next `surface_z` in the same edit (trees stacking, flow, pool)
  would read the new blocks as air. A hint override on the view alone isn't enough -
  `Deref` reads hit the world's own cell, so `band_bytes_mut` **raises the world's
  cell** (`TopBandHints::raise`, never lowers; `UNKNOWN` stays `UNKNOWN`). Sound
  because the edit holds the write guard; step 4 invalidates the cells afterwards.
  Test: `test_cow_hint_covers_writes_inside_the_edit`.
- **Limit.** Capture stops at `PREIMAGE_GUARD_FACTOR` (4) × `undo_budget` of
  *changed bands*, measured on the change rather than the rect.
  Past it the view `trips`: later writes are dropped, the edit is rolled back
  exactly and refused ("This edit changes more than N MB of world data, over the
  undo limit…"). Refusing is deliberate, rather than applying without undo. Almost no
  real edit reaches it; a genuine ⌘A change of every band still would, since its undo
  delta is that big too.
- **Exact rollback on `Err`.** A closure that fails after writing would otherwise leave
  partial writes in the world with no undo entry, no dirty mark (so the incremental save
  and autosave journal would miss them) and stale ceilings. A real case: a multi-stamp
  sculpt flush where a later Flatten/Slope stamp finds no surface. Test: `test_cow_edit_error_rolls_back_exactly`.
- **Deltas.** `band_delta(chunk, copies, copies_are_pre)` is shared with
  `ScratchChunks::commit` (where the copies are the *post*-image): `Sparse`, or a
  band-scoped `Full` over lowest..highest changed band (an uncopied band in between
  is unchanged, so its current bytes are its pre bytes). CoW may pick `Sparse` where a whole-chunk snapshot would have chosen a whole-span `Full`.
- `PEAKS.edit_preimage` records the captured bytes per edit.

`validate_volume` stays on delete/replace/gradient/move: it now bounds their CPU time
and patch, not their pre-image.

**Tests.** `test_cow_edits_match_the_snapshot_oracle` runs ~25 edit shapes (delete,
replace ±filter, gradient, paint + doors across a band seam, paste ±ignore-air,
scatter, extrude x+/z+, move, trees, wavy, flow, pool (the `Err` path), flood fill,
fill surface, five sculpt modes) on 64z **and** 256z fixtures through both the CoW
path and `with_edit_inner_oracle`, the original full-snapshot path, kept
`#[cfg(test)]` with `snapshot_chunks_full`/`preimage_span`/`diff_chunk`/`diff_span`,
and requires identical post-edit bytes, patch, dirty chunk set and lamp index,
exact undo and exact redo. Plus `test_preimage_trip_rolls_back_and_refuses`,
`test_huge_rect_small_change_fits_a_small_limit`,
`test_cow_snapshots_only_the_written_chunks_and_undoes`,
`test_cow_no_op_edits_capture_nothing`, and the `alloc_probe` whole-world guards
(transient ≤ 3 × changed bands + patch slack; one block in a whole-world rect:
33.5 MB → 1.4 MB, which is now mostly the returned patch).

### The patch is bounded, and sampled at the view's LOD

Rendering the edit's patch at full resolution unconditionally would be wasteful. With ⌘A that is the whole map: 61 M pixels = **243 MB** of RGBA on a
7216×8448 world, built in Rust, copied again by `ipc_envelope`, then copied a third
time by the webview, for a screen that can show ~1 M pixels. Two changes:

- **`edit_patch(world, rect, cap, lod)`** returns `(PixelPatch, invalidate)`. Above
  `MAX_EDIT_PATCH_PIXELS` (2 M output pixels = 8 MB) it returns the rect with **no
  pixels** and `invalidate = true`; `applyEditResult` then calls
  `MapCanvas.refetchRegion`, which re-fetches through the tile pipeline, bounded by
  the viewport rather than by the edit. That is the path z-slice mode has always used.
- **The patch renders at `WorldState::view_lod`**, mirrored from the frontend by
  `set_view_lod` (MapCanvas reports `lodForScale(scale)`). Backend state, not a per-command argument, for the same
  reason `view_cap_z` is, otherwise all 11 editing commands grow a `lod` parameter.
  Reset to 1 on world load/close, and `MapCanvas` clears its "last reported" memo on
  the same event so it re-reports.

> ⚠️ **The patch origin is floored to a multiple of `lod`.** A patch point-samples
> every `lod`-th block starting at its origin; the LOD tiles sample from a grid
> anchored at 0. An unaligned origin puts the patch half a step out of phase with
> every tile it lands in, which no amount of nearest-neighbour blitting can correct.
> `MapCanvas.applyPatch` relies on this: at `tile lod === patch.lod` it does an exact
> 1:1 sub-image blit, coarser tiles get a nearest downscale, and a tile *finer* than
> the patch is **evicted** rather than filled with coarse samples it would keep
> showing after the user zooms back in.

Tests: `test_edit_patch_caps_oversized_rect`,
`test_edit_patch_lod_aligns_origin_and_samples`.

**Invariant enforced structurally:** an `edit_fn` returning `Err` still reinstalls
the world before propagating (and rolls its writes back). A fallible op
between `take` and `reinstall` that dropped the world would leave *every* later
command failing "No world loaded". Routing all edits through `with_edit` means there
are no hand-audited call sites.

### `with_edit_grouped` and 3D build sweeps

`with_edit_grouped` stamps the resulting `UndoEntry` with `group` so a run of edits
(one sculpt stroke = many timer stamps, one 3D build sweep = many per-stamp
`paint_blocks`) coalesces on undo/redo. Copy-on-write means a one-voxel stamp captures one 8 KiB band, not 131 KB per chunk.
`test_paint_z_scoped_undo_restores_writes_outside_the_base_band` pins the
door-top-across-a-band-seam undo round trip.

## Delta undo

`ChunkSnapshot.delta: ChunkDelta` is one of:
- `Sparse(Vec<(u32, u8)>)`: (offset, original-byte) pairs, for small edits.
- `Full(u32, Vec<u8>)`: dense-edit fallback, chosen when `entries*5 >=` the span
  from the lowest to the highest changed band (`band_delta`).
- `FullZ(u32, Vec<u8>, u32)`: a **deflated** `Full`:
  `(start, deflated, raw_len)`.

**`UndoEntry::new` is the only place a snapshot becomes long-lived, and therefore
the only place compression happens.** Every consumer that needs raw bytes -
`LampIndex::apply_delta`, `DirtyState::mark_chunks`: runs *before* it at all three
call sites, so nothing downstream has to know `FullZ` exists. Deflate level is **1**,
not `journal.rs`'s 6: this runs synchronously inside the edit that produced it, and
the payload that matters (a uniformly filled or deleted chunk, the ⌘A case) is
already near-maximally compressible at level 1. An incompressible payload keeps its
raw `Full` form rather than growing. `ChunkDelta::full_bytes(&mut scratch)` inflates
one chunk at a time for `restore_and_invert`, so a stack full of compressed deltas
never has more than a single chunk expanded at once. Tests:
`test_full_delta_is_deflated_and_round_trips`,
`test_incompressible_delta_stays_uncompressed`.

### Budget enforcement at accumulation time

`trim_stack` keeps a `stack.len() > 1` floor, so the entry that most needs evicting
(a single ⌘A fill's world-sized delta) would be exempt from the budget and parked
in RAM for the rest of the session. `with_edit_inner` therefore prices the entry (after
compression, which is the first point its true size is known; a delta's size isn't
predictable *before* the edit runs) and, if it alone exceeds `undo_budget`, **drops it and
clears both stacks**, reporting `undo_dropped: true`. Clearing the rest is not
optional: every older entry is a delta that would restore pre-edit bytes over chunks
this edit has since changed. The edit itself still applies; the frontend raises an
error toast pointing at Settings ▸ General ▸ Memory budget. Undo/redo's own inverse
entries keep the old lenient `push_undo` behaviour, dropping one mid-group would
break the group chain, and it was already within budget when it was pushed.
Test: `test_oversized_undo_entry_drops_history`.

`restore_and_invert` applies a delta and derives its exact inverse in one pass, so
`undo_edit`/`redo_edit` **never take a full pre-copy**. Both stacks are capped at
`WorldState.undo_budget` (default `DEFAULT_UNDO_BYTE_BUDGET` = **96 MB**, the
"Balanced" memory-budget preset; `push_undo`/`trim_stack` evict oldest, used for
redo too). User-adjustable per session, 16–512 MB, via `set_undo_budget` (Settings
→ General → Memory budget), and lowering it
re-trims both stacks immediately. `chunk_snapshot_bytes` counts real heap
(`Vec::capacity()`, after `diff_chunk`'s `shrink_to_fit()`), not `len()`.

### Cached logical-unit counts

Every `EditResult` reports `undo_depth`/`redo_depth`, which are **logical units**,
not `stack.len()`: contiguous entries sharing the same `Some(g)` group collapse to
one (a whole sculpt stroke, a whole 3D build sweep). Computing them by
walking the whole `VecDeque` twice per edit would be unbounded in practice, since `trim_stack` won't evict a
~50-byte sparse entry until the stack holds roughly 2 M of them. So, like the byte
accounting in `push_undo`, they are cached: `WorldState::undo_groups`/`redo_groups` are
maintained incrementally by `push_undo` / `pop_undo` / `trim_stack` (each now takes
a `&mut usize` for the count alongside the byte total) plus `clear_undo`/`clear_redo`.

The whole rule lives in one predicate:

```rust
fn starts_new_group(entry: Option<u64>, neighbour: Option<Option<u64>>) -> bool
```

It is deliberately **symmetric**, so one function serves both ends of the deque:
pushing or popping at the *back* adds/removes a unit exactly when it holds against
the new back, and `trim_stack`, which evicts from the **front**, removes one
exactly when it holds against the new front. Getting that end wrong is the easy
mistake: evicting the older half of a same-group pair must *not* decrement.

`count_undo_groups` survives as a `#[cfg(test)]`-only oracle;
`test_cached_group_counts_match_the_oracle` pins the cache against a fresh walk
after each of the shapes that can diverge, two different groups back to back, an
ungrouped edit splitting one group id into two non-adjacent runs (which must count
as two units), one-entry-at-a-time budget eviction from inside a group, and
undo/redo moving whole groups between the stacks. `undo_stack_labels` (the Sidebar
History tab) still walks the stack, but it's a per-open read, not a per-edit one.

`undo_edit`/`redo_edit` restore from their own stack (not via `with_edit`), but
are invariant-safe: they `take()` the world *before* popping their stack, erroring
on "No world loaded" without touching the stack. They also
`refresh_lamp_index_chunks` so the lamp index stays current.

Test: `test_delta_undo_round_trip`.

**Dirty tracking hangs off the same choke point.** `WorldState.dirty: DirtyState` is marked from the same four sites: `with_edit_inner` marks
the bands its deltas actually changed (`ChunkDelta::band_mask`; the sets are
band-granular `chunk → BandMask`), `undo_edit_inner`/`redo_edit_inner` mark the bands of the
inverse snapshots they just wrote, and the three header-only writers mark the header flag directly.
This is what makes persistence's incremental save and journaled autosave
([File Format](../file-format/), [Subsystems](../subsystems/)) O(changed
bytes) instead of O(world size), see also the lamp index's `apply_delta`, which
replays the same undo delta for the same reason.

## Voxel views and the sculpt scratch

Every per-block accessor, `read_block_abs`, `read_paint_abs`, `surface_z_capped`,
`set_block_abs`, `world_max_z`, `sculpt_column`, `retexture_top`, `field_stamp`,
`sculpt_stamp_body`: is generic over two small traits instead of taking
`&LoadedWorld`/`&mut LoadedWorld` directly:

```rust
trait VoxelView {
    fn num_bands(&self) -> usize;
    fn chunk_origin(&self) -> (i32, i32);
    fn chunk_bytes(&self, cx: i32, cy: i32) -> Option<&[u8]>;   // the chunk's real span
}
trait VoxelViewMut: VoxelView {
    fn chunk_bytes_mut(&mut self, cx: i32, cy: i32) -> Option<&mut [u8]>;
}
```

Those three methods are everything the addressing formula
(`band*8192 + lx*256 + ly*16 + lz`, `+4096` for paint) actually needs. Because
`chunk_bytes` hands back the chunk's *real* span, an intra-chunk index is in bounds
iff it is `< slice.len()`: the same guarantee `chunk_range` gave, expressed once.

`LoadedWorld` implements both. So does **`ChunkScratch<'a>`**: a private, writable
copy of a bounded set of chunks layered over a live world.

- **Reads** of an owned chunk see the scratch; reads of any other chunk fall
  through to the world. A brush reading its 8-neighbourhood across a chunk boundary
  therefore gets real terrain, never silent air, the failure mode a naive
  "copy just these chunks into a mini-world" would have.
- **Writes** to a chunk the scratch does not own are **dropped**. Every caller must
  build the scratch from a rect that provably covers the whole write extent; for
  sculpt that is `sculpt_write_rect`.
- `into_chunks()` drops the borrow of the world and keeps the copies
  (`ScratchChunks`), which is what lets the compute phase run under a read guard and
  the commit under a write guard.
- `ScratchChunks::commit(world)` writes each owned chunk back and returns one
  `ChunkSnapshot` per chunk that actually changed, the undo delta, built by the
  same `band_delta` `EditView` uses, so the two paths can't drift.
  Output is sorted by `(cx, cy)`, matching `affected_chunk_coords`' order.

### `sculpt_write_rect` and the rock pad

Heightmap modes write only inside their own footprint. Rock/Carve's `field_stamp`
writes across a `rock_stamp_pad(params, radius)` ring *outside* it, the wider of the
noise blur kernel and the terrain fillet radius, plus one. `sculpt_write_rect` derives both the
patch rect and the scratch's chunk set from the same arithmetic `field_stamp`
itself uses, which is what makes dropping out-of-scratch writes
safe. (The in-guard path captures whatever it writes regardless; the rect
bounds the scratch and the patch.) Test: `test_rock_stamp_writes_stay_inside_the_write_rect`.

## The sculpt read/write guard split

A held brush is a near-continuous writer at ~10 flushes/second, and holding the **exclusive** guard across the whole stamp: the heightmap pre-read, the
falloff field, Rock/Carve's `w*h*d` f32 buffers and three separable blur passes, the
chunk snapshot, the diff and the patch render. `fetch_tile`, `get_chunk_geometry`,
`get_cursor_block` and every `render_*` queued behind it for the duration of the
stroke, which defeated the whole point of the `Mutex → RwLock` conversion for the
one interaction where responsiveness matters most.

`sculpt_terrain` now runs in three phases (`sculpt_split`):

| Phase | Guard | Work |
|---|---|---|
| 0 | write, brief | Note `dirty.seq`; take `ws.sculpt_session` (matching group, else fresh). |
| 1 | **read (shared)** | Build the `ChunkScratch` over `sculpt_flush_rect`, run every stamp against it. |
| 2 | write | Re-check `seq`, `commit` the scratch, render the patch, `finish_edit`. |

Phase 1 is essentially the whole cost, and readers run throughout it. The snapshot
copy disappears too: the scratch *is* the pre-image, so `commit` diffs it against the
live chunk on the way back (the scratch holds only the bands it wrote).

⚠️ **Staleness.** The guard is released twice, so there are two windows a foreign writer
could land in, and they fail differently: between phase 1 and 2 the *scratch* goes stale
and its wholesale write would clobber the other edit; between phase 0 and 1 the scratch
is fine (it is built from whatever the world holds at that moment) but the **float
workspace** taken in phase 0 is stale, which is exactly the event `with_edit_inner`
clears `sculpt_session` on.

`dirty.seq`: bumped by every `mark_chunks`/`mark_header`/`clear_all`, i.e. by every path
that mutates world bytes, is captured in **phase 0** and re-checked in phase 2. Because
it is monotonic, that single comparison covers both windows. If it moved, the scratch is
discarded and the stamp is re-run under the write guard with a **fresh** float workspace.
In practice this never fires: the frontend keeps one sculpt flush in flight at a time.

⚠️ This path bypasses `with_edit_inner`, so it owns that function's two invariants
itself, the `sculpt_session` take/reinstate above, and routing the post-edit
bookkeeping through the shared `finish_edit`.

`sculpt_terrain_inner` / `sculpt_terrain_batch_inner` / `run_sculpt_in_guard` survive as
`#[cfg(test)]`-only: they run the same flush wholly inside one `with_edit_grouped`, and
are the reference the split path is required to match byte for byte
(`test_scratch_stamp_matches_direct_stamp`). Both entry points and the command share the
same resolution types, `SculptArgs` (mode parameters), `SculptStamp` (footprint + dial)
and `run_sculpt_flush`: so parameter clamping can't diverge between them.

## Lock safety

All lock sites go through `read_ws`/`write_ws`, which ignore poisoning: a panic
while holding the lock must not poison every subsequent command. Keep this pattern
for new commands.

## Drawing tools

`paint_blocks(blocks, block_type, paint, z_offset)`: `z = None` → `surface_z`.

> ⚠️ **`paint_blocks`'s `z_offset` is `Option<i32>`** (defaults 0). If it were a
> required `i32`, any frontend caller passing exact coordinates and omitting it would fail
> at runtime with `missing required key zOffset`. Tauri won't catch this at compile
> time; keep it optional.

**Drawing on the Lens elevation** sends **one `paint_blocks` call per stroke** with every cell
(`App.tsx`'s `handleDrawElevation(points[])`), so a stroke is one edit, one undo step, one patch
render and one `editEpoch` bump.
Cells are exact coordinates, so `z_offset` is omitted.

Geometry helpers in `src/drawTools.ts`: `penFootprint`, `brushFootprint`,
`bresenhamLine`, `linePixels`, `polygonPixels`, `rectPixels`, `ellipsePixels`.
Tested in `drawTools.test.ts`.

**Draw tools** (Home-tab Tools group):
- **Pen (P)** / **Brush (B, size 1–9 sq/circ)**: freehand stamp.
- **Spray (scatter)**: `sprayDensity` fraction of the brush footprint placed per
  stamp; runs on the 140 ms hold-to-build timer (timer-only, so a quick click
  stamps once).
- **Line (L)**: `linePixels(a,b,size,shape)` thickens the bresenham centerline.
- **Rect (R)** / **Ellipse (E)**: drag shapes, fill/outline.
- **Polygon/lasso (G)**: click to add vertices, click near the first or
  double-click to close, Escape cancels; `polygonPixels` scanline-fills or
  edges-only.
- **Stroke stabilizer**: low-passes the freehand pointer path (`α = 0.35`) to
  filter jitter; flushed to the release point on pointer-up. Freehand tools only.
- **Gradient fill** (Selection tab), `gradient_fill(...)` blends Fill block → a
  second block across x/y/z with an **8×8 Bayer ordered dither** (`BAYER8`, 64
  levels) indexed purely by (x,y) so the pattern stays clean regardless of surface
  height; re-skins existing blocks unless `includeAir`. Axis default `y`.

`MapCanvas` centralizes footprint building in `stampFootprint(p, tool, cfg)`;
predicates `isFreehand`/`isShapeTool`/`isSculptStroke`.

**Draw mask:** `maskEnabled/maskBlockType/maskPaint` (frontend) → Rust
`mask_type/mask_paint` in `paint_blocks` restrict painting to matching cells.

## Terrain sculpt (`sculpt_terrain`/`sculpt_terrain_inner`) *(experimental)*

Heightmap sculpting. **16 modes:**

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
| Hydro | Beyer/SebLague-style droplet hydraulic erosion, continuous float position, bilinear height/gradient sampling, inertia-steered flow, sediment capacity/erode/deposit dynamics, erosion spread across a radial brush, dendritic gullies rather than 1-wide trenches. Workspace = footprint + 16-cell margin; commit is footprint-only (margin changes are simulated, never written). |
| Stamp/Retexture | Repaint surface by 8-neighbour steepness: flat→grass, mid→dirt, steep→stone; heights unchanged. |
| Terrace | Quantizes height to `strength`-block steps. |
| Sharpen | Unsharp mask over the Smooth kernel, amplifies deviation from the local average. |
| Smear | Advects height from `(p.x-smear_dx, p.y-smear_dy)` toward the drag direction each tick; no-op at `dx=dy=0`; forced onto the timer regardless of hold-build since a one-shot commit has no drag-direction info. |
| Rock | Volumetric, terrain and rock are two SDFs fused with a smooth-min fillet, not a heightmap offset. Bypasses `height_map`/`weight`/`blend`/`round_dither` entirely (see below). |
| Carve | Rock's inverse, cuts sky-connected material only, via smooth-max against the terrain SDF. Never opens a floating roof or a sealed cave; never touches Bedrock. Shares `field_stamp`/`RockParams` with Rock (see below). |

- **Radial falloff, two paths, same math:** `softness` (0..1) + `profile`
  (`smooth`/`linear`/`sphere`/`sharp`). *Dial* path (every 2D/3D freehand stamp):
  a clean Euclidean dome around the stamp centre. *BFS* path (shape fills:
  rect/ellipse/polygon): 8-connected distance field over the swept footprint.
  0 softness = hard flat edges on either path. Every heightmap mode blends
  `cur→target` by the per-column weight, then rounds via `round_dither`
  (`softness > 0`): a spatially-coherent threshold, a low-frequency `fbm2` field
  over world `(x,y)`: so a falloff's fractional band commits as contiguous wavy
  contour bands instead of concentric terrace rings (per-column exact rounding)
  or an 8×8 checkerboard of pepper (a fixed `BAYER8`-tiled threshold would also reinforce the same pattern on every stamp of a stroke).
  `BAYER8` is used for `gradient_fill`'s dither. Rounds plainly at `softness <= 0`. **Rock/Carve
  don't use this path at all**, see below.
- **Rock/Carve (volumetric).** `field_stamp(.., carve: bool)` (`rock_stamp` is a
  test-only `carve=false` wrapper) builds a dense `w×h×d` float field around the
  dial centre (or the footprint bbox centre if no dial), as **two signed-distance
  fields (SDFs, negative = solid) combined with an IQ polynomial smooth-min/-max**
  rather than one additive density:
  - **Terrain SDF:** `sd_terr = (z - H(x,y)) / grad(x,y)`, where `grad` is the
    slope-normalised gradient magnitude (so the fillet width doesn't visibly
    narrow on a 45° cliff).
  - **Rock SDF:** a squashed-ellipsoid distance in blocks (`flatten` sets the
    vertical/horizontal ratio, never a sphere; `sink` buries a fraction of its
    vertical half-extent below the anchor), in a **terrain-relative frame**
    (`drape`): near/below the surface its own anchor height blends toward local
    terrain height (so the base drapes over a slope instead of floating/being
    swallowed); well above the surface the frame goes world-vertical so the
    emergent top keeps a free-standing form. Plus per-stamp anisotropy (random XY
    elongation + yaw) and three additive detail terms: domain-warped `fbm3` noise
    (`noisiness`/`noise_radius`, **blurred alone** before combining, cohering
    granular noise into lumps without smoothing the ellipsoid's own shape or the
    terrain surface, `smoothing` sets the box-blur radius), and low-frequency
    Z-only ridged noise (`strata`) for sedimentary-bedding ledges.
  - **Fillet:** `k = meld * 0.3 * r_min` (clamped 1..14 blocks). Rock:
    `sd = smin(sd_rock, sd_terr, k)`. Carve: `sd = smax(sd_terr, -sd_rock, k)`.
    The smin/smax concave term is precisely the flare/rollover, no seam, because
    there's no longer a boundary, one field, one isosurface.
  - **Idempotency:** every terrain-derived quantity, the drape frame *and*
    `sd_terr`/`grad` *and* the Z bbox sizing, reads a bilinear fit over a ring
    sampled strictly **outside** the stamp's own padded bbox (`stable_h`), never a
    live in-bbox scan. A live in-bbox sample here measurably ratchets the mass taller on every
    identical repeat, the terrain SDF reacting to the previous stamp's own newly
    steep silhouette is the dominant, non-converging feedback loop, not just the
    ellipsoid's anchor height.
  - **Rock write:** cells with `sd < 0` that are currently air get the fill block
    (default stone); existing blocks are never touched (pure union, never
    deletes), re-stamping in place is a no-op. A BFS floater guard then drops any
    newly-added cell not 6-connected (through other new-or-old solid) back to
    pre-existing terrain.
  - **Carve write:** one z-descending pass per column, delete a solid cell only
    while "open" (reachable from the sky, or from another just-deleted cell,
    without having crossed a surviving solid block first); hitting a surviving
    solid or Bedrock (type 1) closes the column for the rest of the pass. Clamps
    `z >= 2`. Then re-caps the exposed floor via the same slope classifier as
    Stamp/Retexture (`classify_by_slope`, extracted so both modes share it) so a
    cut gully doesn't show raw stone under a grass landscape.
  - Params bundle: `RockParams` (`noisiness`, `noise_radius`, `smoothing`, `meld`,
    `flatten`, `sink`, `drape`, `strata`), one `rock: Option<RockParams>` arg
    shared by both modes. Both ignore `strength`/`softness`; radius sets size.
    Neither touches `WorldState.sculpt_session` (nothing to accumulate, the
    write is a deterministic volumetric field computed fresh each call). Tests:
    `test_rock_produces_connected_mass`, `test_rock_is_idempotent`,
    `test_rock_deterministic_by_seed`, `test_rock_never_deletes`,
    `test_rock_stays_in_bbox`, `test_rock_scales_with_radius`,
    `test_rock_no_air_gap_under_mass`, `test_rock_hugs_slope`,
    `test_rock_silhouette_not_spherical`, `test_rock_no_floating_components`,
    `test_carve_only_deletes`, `test_carve_no_floating_roof`,
    `test_carve_idempotent`, `test_carve_never_touches_bedrock`.
- **Grouped undo (`group_id: Option<u64>`):** a whole hold-to-build stroke commits
  as **one** undo/redo step, not one per tick, `UndoEntry.group` lets
  `undo_edit`/`redo_edit` pop-and-restore while the next stack entry shares the
  same group; `undo_depth`/`redo_depth` count groups. The frontend generates a
  monotonic stroke id at stroke-start and threads it through every stamp,
  including timer ticks.
- **`use_cap: Option<bool>`** (default true), whether surface targeting respects
  the [Cutaway view cap](../rendering-2d/#cutaway-view-experimental); 3D-pane
  sculpting passes `false` (cutaway is a 2D-only concept there).
- **Block layering (`sculpt_column`):** explicit fill block → verbatim; grass
  surface with no fill → dirt body + grass cap; else surface block all the way up.
- **Hold-to-build (airbrush), always-on:** MapCanvas/FlyView3D run a 140 ms
  interval while a stroke is held, re-stamping the live cursor footprint at the
  current radius, one `sculpt_terrain` call per tick, coalesced into one undo
  group. `accumBusyRef` skips overlapping async ticks (hydro can exceed the
  interval); a final stamp also fires on release. Excludes Flatten/Grab/Slope
  (these converge in one shot from their anchor, not a swept path).
- **Live 2D stroke sessions (the Live Brush option, on by default).** A live 2D stroke is a run of
  `sculpt_terrain` calls sharing one `group_id`: MapCanvas's brush engine stamps
  on pointer-down, emits a stamp centre every `~radius*0.5` cells of travel
  (spacing), and re-stamps in place on the 140 ms dwell timer (airbrush). Centres
  batch through one in-flight `sculpt_terrain` call at a time, carrying every
  centre queued since the last flush. Escape reverts the whole stroke (await the
  in-flight flush, then one `undo_edit`). The backend caches each stroke's
  **precise float height per column** (`WorldState.sculpt_session`) so sub-block
  deltas accumulate instead of rounding away every call, only the final dithered
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
- **3D-pane sculpting:** a fourth `mode3d`, alongside Camera/Select/Build, hold
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
- **Scatter**: N random placements (`scatter_paste`). ⚠️ When the clipboard is
  larger than the scatter box, the placement range clamps to 1 (every paste lands
  at `x1`/`y1`), so the snapshot/patch rect is widened to the true placement extent
  (`x1..max(x2, x1+width-1)`), otherwise chunks the paste touches past `x2`/`y2`
  go unsnapshotted (broken undo) and unpatched (stale tiles).
- **Array**: cols×rows grid with spacing (`array_paste`).

**Paste lens** (`render_paste_lens`): a front/side elevation of the
armed paste, rendered at the ghost's position with buried (red hatch over the ghost block, overwritten terrain) / cleared
(amber hatch, deleted terrain, only shown with "Skip air" off) cell classes. It **cannot disagree
with a real paste**: `terrain_paste_base` is the one function both `paste_terrain` and the lens's
per-column base-Z computation (`paste_lens_bases`, lib.rs) call, so terrain mode's "does this column
have a surface, and at what Z" answer is identical in both places by construction, and `ignore_air`
is threaded straight through to the lens as the same flag the paste itself reads. The frontend window
(`src/windows/LensWindow.tsx`, paste mode) binds its Z stepper to the *same* `pasteElevationOffset` App
state the QuickActionsBar stepper and PgUp/PgDn already drive. The same window also shows the
selection; see [Frontend](../frontend/#lens-window) "Lens window" and [2D Rendering](../rendering-2d/#paste-lens-elevation)
"Paste lens elevation" (the render itself).

## Non-rectangular selection

The selection can carry a per-column **cell mask** on top of its rect, so Wand
and Lasso select an actual shape instead of a bounding box. The mask is
**backend-resident state** (`WorldState.selection_mask: Option<SelectionMask>`,
bbox + row-major bitset), IPC commands don't thread a mask param, they resolve
it via `active_mask(ws, x1,y1,x2,y2)`, which only honours the mask when the
passed rect **exactly equals** the mask's bbox. A stale mask therefore degrades
to rect-only behavior, never a corrupt edit.

- **Mask-aware edits:** `delete_blocks`, `replace_blocks`, `move_selection`
  (shifts the mask's bbox with the move so the shape survives), clipboard copy/
  paste (`Clipboard.mask`, all three paste loops, rotate/mirror transforms),
  `gradient_fill` (the ramp fraction is still measured over the full bbox; the
  mask clips which columns receive it), `extrude_selection` (gates on the
  *source* cell, the shape is what repeats, never evaluated at dest coords),
  and `generate_trees` (canopy spill outside the mask is accepted, like the
  existing rect spill).
- **Mask-aware previews/views** (unmasked cells hidden, not dimmed): the 2D
  paste ghost, the Lens window's selection views (front/side let a masked block *behind* an
  unmasked column show through; unselected cells draw as 50 % context),
  The **3D fly-view** overlay decomposes the mask into merged
  fill-only slabs under one edges-only bbox ring; a mask that fragments past 64
  rects falls back to the single bbox.
- **Stays rect-only (deliberate):** sculpt clip-to-selection. Extrude/paste
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
`block_types ++ paints`. A shaped clipboard writes `\x02` plus a flag byte and a
`width*height` column bitset.

**Provenance section.** Optional tagged
sections (`tag[4] · u32 LE len · payload`) follow the body. Readers skip unknown tags,
and a truncated section just ends the walk. Older builds ignore trailing bytes, so
this is backward-compatible. Today there is one tag, **`ORGN`** (≥ 21 bytes):

- `ax, ay, az`: i32 absolute coords of the prefab's `(0,0,0)` cell.
  Absolute = `abs_min_*·16 + x/y`, which matches the multiplayer server's `(x, z)`; `az` = height.
- `source`: u8. `0` = a plain copy, `1` = copied inside a round-trip paste placement,
  `2` = exported by VuencLink (the multiplayer companion app).
- `rtid`: u64 round-trip id.

The rules that maintain it:
- `Clipboard.origin` carries it; rotate and mirror drop it.
- `copy_selection` sets it:
  - inside a **paste placement**, it inherits from the placement, offset by where you copied;
  - if the copy only partly overlaps a placement, it stays `None`;
  - otherwise it gets source 0 with the world's absolute coords.
- `paste_at` records a placement (`WorldState.paste_placements`, cap 8) only when the
  clipboard has `rtid ≠ 0`, is unmasked, is pasted with ignore-air **off**, fits inside
  the world, and commits.
- Placements are cleared on load/close/autosave-load and on every undo/redo.

The same hex fixture is pinned in the tests of both apps (`test_epfab_orgn_golden_fixture`)
so the two stay compatible.

Commands: `save_prefab` (reads clipboard → gzip → `atomic_write`), `load_prefab`,
`list_prefabs` (which uses the internal `read_prefab_header` helper for dims),
`delete_prefab`, `rename_prefab`, `prefab_exists`, `render_prefab_thumbnail`,
`get_default_prefab_dir`. The
delete/rename Rust commands **guard on the `.epfab` extension**.

**Save flow (App.tsx):** default **Save Prefab** opens an in-app name modal
(`prefabNameModal`) that writes `<name>.epfab` into the library dir and bumps
`prefabRefreshToken`: deliberately **not** the native save panel, which hangs
~30 s on macOS Sonoma (`NSSavePanel` ViewBridge XPC stall). **Overwrite guard:**
first Save calls `prefab_exists`; a taken name arms `prefabOverwrite` (amber
warning) instead of saving; a second click confirms. `savePrefabAs()` keeps the
native picker for arbitrary folders. All paths funnel through `save_prefab`.

**Prefab library gallery (`PrefabLibraryPanel.tsx`):** dockable panel listing
`.epfab` files. Thumbnails load **sequentially** (one `invoke` in flight, a
fire-all-at-once version froze on big folders), cached by `path::mtime`
(`thumbCacheRef`). Client-side search (`query`), sort (name/newest/size), and
list⇄grid view persisted in `localStorage`. Per-entry inline rename + delete.
Folder = `resolvePrefabDir()`: Settings `prefabDirectory` → app-default
`<app_data_dir>/prefabs`. Buttons: Refresh, Open Folder (`openPath`: needs
`opener:allow-open-path`), Save Selection As…

## Other editing features

- **Magic Wand** (`magic_wand_select`), BFS flood-fill, 50k-cell cap, type±paint
  match. Key `W`, violet highlight.
- **Extrude** (`extrude_selection(..., axis, count, ignore_air)`), N
  non-overlapping copies in one undo step. UI in SelectionInspector.
- **Tree gen** (`generate_trees(x1,y1,x2,y2, tree_types, density, leaf_paints,
  seed)`), multi-type (normal/terrain/pine/tall_pine, random per column),
  user-supplied `leaf_paints` pool (empty → type default). Snapshot rect is the
  selection ±3 for canopy spill; the returned patch uses the **same** expanded rect
  so spilled leaves render immediately.
{% endraw %}
