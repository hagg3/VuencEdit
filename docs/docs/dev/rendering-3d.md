---
layout: doc
title: "3D Rendering"
subtitle: "Geometry generation, culling, lighting, shadows and picking."
---
{% raw %}
> **Port reference.** This is the intended reference for a web-based Eden World
> Builder renderer. `FlyView3D.tsx` (the streaming fly-through pane) plus
> the geometry functions together form a complete voxel-to-mesh
> pipeline with face culling, directional shading, lamp lighting, sun shadows,
> texture atlasing, and voxel picking. The Rust side is pure and world-space; the
> Three.js side owns only camera, materials, and the coordinate permutation.
>
> **Where the code lives.** The pipeline is in
> `packages/voxel-core/src/{geometry,lamps,texture}.rs`, generic over the `VoxelView` trait,
> which is why it works as a port reference: it doesn't know what a world file, a
> lock or an IPC command is. `src-tauri/src/geometry.rs` is a small Tauri
> shell (`get_chunk_geometry`, `pick_block`, `get_lamps_near`, `get_light_constants`, and the
> newtype carrying the binary envelope). The world-level facts (`w_chunks`,
> `h_chunks`, `sky`) arrive through a `ViewMeta` parameter, because `VoxelView`
> deliberately doesn't name them.

`FlyView3D.tsx`: streaming fly-through of the whole world (the floating 3D window, or the main pane when swapped) -
is the app's only live 3D consumer, and its only live WebGL context. It uses
`get_chunk_geometry` per chunk.

`FlyView3D.tsx` builds Three.js `BufferGeometry` from the streams produced by
`obj_geometry_region_into` in `voxel-core`'s `geometry.rs`, decoded by `decodeGeometry`
(`src/types.ts`) as zero-copy typed-array views over the raw IPC response. See
[IPC Reference](../ipc-reference/).

### Compact indexed vertex format ("v2")

One mesher, two encoders. `obj_geometry_region_into` hands every finished face to a
`MeshSink` (`quad`/`tri`, with its stream, lit RGBA and atlas row already resolved):

| | v1, `F32Sink` → `ObjGeometryResult` | v2, `CompactSink` → `CompactGeometry` |
|---|---|---|
| topology | non-indexed, 6 verts/quad | **indexed**, 4 verts + 6 indices/quad |
| position | f32×3, world space | **Int16×4**, chunk-local fixed point (1/16 block) + 0 pad |
| colour | f32×3 (f32×4 transparent) | **Uint8×4** normalised (alpha 255 outside transparent) |
| uv (pack only) | f32×2, V = `row/atlas_rows` | **Uint16×2** integer: U in half-tiles, V = row |
| index |, | Uint16, or Uint32 from 65 535 verts |
| opaque quad | 192 B | **76 B** (60 without a pack) |

Measured on real worlds (400 chunks each, one 256z and one 64z): **2.4×** smaller
without a pack, **2.5×** with one. The whole saving lands on every tier: Rust build, IPC,
the JS heap until upload, and the VBO.

Why each choice:
- **4-component formats only.** D3D11 (ANGLE on Windows) has no 3×16-bit vertex format and
  converts one on the CPU into a shadow buffer. `Int16×4`/`Uint8×4`/`Uint16×2` are native.
- **Fixed point** is exact: every coordinate the mesher emits is a multiple of ¼ (partial
  fluid tops); 256 × 16 = 4096 fits `Int16`. `CompactSink` `debug_assert!`s the grid.
- **Integer UVs + a texture transform.** The atlas texture carries `repeat = (½,
  1/atlas_rows)` (three's `uvTransform`, applied by every material that samples `map`,
  including the fence's `MeshDepthMaterial`). A normalised `Uint16` V can't hit `k/atlas_rows`
  exactly and would seam at tile edges. U is in half-tiles because a ramp/wedge triangle's
  apex sits at U = ½.
- ⚠️ **Index 0xFFFF is never used with `Uint16`.** WebGL2 always has primitive restart on, so
  a stream switches to `Uint32` at 65 535 vertices, not 65 536.

`get_chunk_geometry` takes `format` (1 = v1, the default; 2 = v2). VuencEdit always asks
for 2. The frontend places each mesh at the header's `origin` with `scale = pos_scale`
(`matrixAutoUpdate` still off), sets an index, and `releaseOnUpload` also frees the index
array (it isn't in `geometry.attributes`). The Low/Balanced/High byte budgets stayed the same, so the same budget holds ~2.5× the area.

Tests: `compact_sink_expands_to_the_f32_mesh` (20 mode × pack × z-band cases on 64z and 256z:
positions and UVs exact, colour within ½/255, same triangles, same winding, ≥2× smaller),
`compact_positions_cover_every_fractional_case`,
`compact_index_width_switches_below_the_restart_index`, the app's
`compact_envelope_sections_tile_the_body_aligned`, and `decodeGeometry` in
`types.test.ts`. `F32Sink` is byte-identical to the original mesher.

## Coordinate mapping (the one rule to get right)

**Eden world coords:** X east, **Y south**, **Z up**.
**Three.js coords:** Y-up.

The mapping used everywhere in the live 3D path is a **sign-free permutation**:

```
Eden (ex, ey, ez)  →  Three (ex, ez, ey)
```

i.e. Eden Z (height) → Three Y (up); Eden Y (south) → Three Z, so **Eden north =
Three −Z** and the camera faces −Z (north) with east (+X) on the right. The Rust
helper `o(ex, ey, ez)` emits exactly this. Direction vectors transform the same
way.

The only permutation in `geometry.rs` is `o()`. (A Y-negating `(ex, ez, -ey)` variant is
what an OBJ file writer would want, but that is a different job.)
`pick_block` takes and returns **Eden** coords, the frontend owns the Three↔Eden
transform, keeping `pick_block` a pure world-space query.

## Geometry generation (`obj_geometry_region`)

The core of `get_chunk_geometry` (fly-view chunk streaming). Emits face-culled
cubes, ramp prisms, and wedge pyramids as vertex positions + colors (+ UVs when
textured).

### Directional face shading (baked into vertex color)

Shading is **baked into vertex colors** by Rust, so the opaque mesh needs **no
scene lights** and no `computeVertexNormals()` (saves a CPU spike and the normal
buffer). The per-face multipliers match the game's own fixed shading table
(`cubeColors[]` in `Geometry.c`), a fake-AO pattern, *not* a real directional
sun:

```
SH_TOP = 1.00   (top,  +Z / face kind 2)
SH_BOT = 0.60   (bottom, -Z / face kind 1)
SH_E   = 0.847  (east,  +X)
SH_N   = 0.749  (north, -Y)
SH_S   = 0.549  (south, +Y)
SH_W   = 0.447  (west,  -X)
```

The `SH_*` value also encodes the **face kind** for texture lookup: `SH_TOP → top
(2)`, `SH_BOT → bottom (1)`, anything else → side (0). Wedge diagonal shades are
blends (e.g. `(SH_N+SH_W)*0.5`) that don't equal `SH_TOP`/`SH_BOT`, so they map to
side.

### Two (then three) vertex streams

- **Opaque stream** (`positions`/`colors`, RGB), everything solid.
- **Transparent stream** (`positions_t`/`colors_t`, RGBA), any block with a
  `transparent_alpha()` (water/glass/fence/new-flower). Rendered as a second mesh
  with `transparent: true, depthWrite: false`. Mirrors the game keeping ATLAS2
  blocks in a second buffer.
- **Emissive stream** (`positions_e`/`colors_e`, GPU/`flat` mode only), lamp
  faces, so lamps stay fullbright under dim night ambient (see GPU section).
  Empty when `!flat`, matching a plain flat fully-lit render.

### Face culling

A face is skipped when **either**:
1. the neighbor fully occludes it (`obj_occludes`: opaque, non-ramp), **or**
2. the neighbor is the **same block type** as the current voxel (stops two
   adjacent water/glass/fence blocks from both emitting their shared interior
   face, without this, a deep water column would emit ~6 quads per interior block for
   nothing visible).

Ramps/wedges always emit their diagonal face regardless. For plain cubes, all six
neighbor occlusion tests are **hoisted before** the lamp/shadow lighting
computation, so a fully-hidden voxel skips the expensive per-lamp loop and shadow
raymarch entirely.

### Greedy meshing

After face culling, a naive emitter still writes **six vertices per visible face**,
so a chunk's payload scales with its voxel count. The greedy pass makes it scale
with the terrain's **surface complexity** instead: coplanar adjacent faces that
render identically fuse into one large quad.

Measured on 16×16 heightmaps (merged quads vs. the raw visible-face count a naive emitter
produces):

| Terrain | Raw faces | Merged quads | Reduction |
|---|---|---|---|
| Flat plain | 640 | 10 | **64×** |
| Deep flat (256z-shaped, h=40) | 640 | 10 | **64×** |
| Cliff / step | 672 | 17 | **39.5×** |
| Gentle rolling | 707 | 102 | **6.9×** |
| Hilly | 1162 | 712 | 1.6× |
| Violently bumpy | 1116 | 669 | 1.7× |

The win is largest exactly where 256z worlds hurt most, deep flat ground and tall
cliff faces, whose side faces merge down the whole column. Rough terrain gains
little, which is expected: there is genuinely nothing coplanar to fuse.

**How it works.** The voxel loop no longer emits plain-cube faces; it pushes a
`FaceRec { dir, slice, bt, paint, lm, v, u }` per face and emits after the scan.

- `dir` fixes the plane and both in-plane axes, so `(slice, u, v)` rebuilds the
  world-space rectangle. The mapping table lives on `FaceRec`'s doc comment.
- **Field order is the merge key and is load-bearing.** `derive(Ord)` sorts
  lexicographically by declaration order, so a single `sort_unstable()` collects
  every legally-fusible face, same direction, plane, block and light, into one
  contiguous run that is *already ordered (v, u)*, which is precisely the
  row-major scan order the rectangle sweep wants. It is also what makes the
  output deterministic, which the z-clip tests depend on (a clipped render must
  be byte-identical to a render of the truncated world). Reorder those fields and
  you silently break both.
- `lm` is stored as raw `f32::to_bits()`: faces may merge only when they render
  **bit-identically**. That is what keeps per-block lamp falloff and sun shadows
  intact instead of averaging them across a big quad. In `flat` (GPU-shadow) mode
  the key folds to a constant, since `lit_rgb!` discards `lm` there anyway.
- **Baked-night light is snapped and capped before it becomes a key.** Lamp falloff is continuous, so
  without this every lit voxel gets its own group and the merge collapses back to
  1×1 quads on exactly the chunks that already produce the biggest payloads.
  Two mitigations, in different places on purpose:
  - `MERGE_LIGHT_STEPS` (geometry.rs, **32**: i.e. steps of 1/32) rounds `lm`
    itself, at the point it is computed in the voxel loop, and **only when
    `mode.night`**. Doing it there rather than on the key keeps `FaceRec::lm`
    exactly the value that gets rendered, so unmerged faces (ramps, wedges,
    partial-height fluids) can't seam against merged neighbours. The day path and
    the shadows-only path are constant-valued already and are left byte-identical.
  - `merge_light_cap(sh)` clamps the key at the brightness where that face
    direction's shade already saturates (`lit_rgb!` computes `(sh*lm).min(1.0)`, so
    anything past `1/sh` renders the same white). This one is **exactly lossless**,
    not approximate, pinned by `test_merge_light_cap_is_lossless`; the
    `to_bits() + 1` nudge inside it exists because `sh * (1.0/sh)` may land one ULP
    low in f32.

  ⚠️ Quantization is a visual trade-off and 1/32 is deliberately conservative: at
  both default lamp radii (Legacy 4, Modern 14) the natural *per-block* light step
  along the falloff is 2–16× larger than 1/32, so the grid cannot introduce a
  contour that block granularity did not already have. Only the extreme end of the
  radius slider (≥32) has a per-block gradient finer than the grid, and light there
  is mostly saturated anyway. Anything coarser than 1/32 bands visibly and was
  rejected.
- Within a group the sweep widens along `u` through unconsumed cells, then grows
  the whole run along `v` while every cell of the next row is present and free -
  standard maximal-rectangle greedy meshing. Scanning in (v, u) order guarantees
  the current cell is the rectangle's origin corner, so each group is covered
  exactly once.

**Only full-cell faces defer.** A face joins the merge pass only when it fills its
unit square. Ramps and wedges are not unit squares; neither is a partial-height
fluid face (a ¾/½/¼ surface, or a lateral sliver stepping down to a shallower
neighbour). Those emit immediately and unmerged, exactly as before.

⚠️ **With a texture pack loaded, the merge is U-only** (`grow_v = pack.is_none()`).
The atlas is one tile wide × N rows tall, so U can tile by repeating that single
column, but **V selects the row**, so growing V would run a merged quad straight
into the next block's texture. Tiling U means UVs run `0..w` instead of `0..1`,
which requires `tex.wrapS = THREE.RepeatWrapping` on the atlas texture, set on
`FlyView3D.tsx`'s atlas. `wrapT` must stay clamped.

⚠️ **Vertex counts stopped being a proxy for "how much is visible."** A 2×1 slab
and a lone cube are both six quads now. Tests that compared `vertex_count` to
detect missing geometry compare the `positions` bytes instead, see
`test_obj_geometry_respects_mask`.

### `ChunkCache` (perf)

`obj_geometry_region` reads every block through `ChunkCache` (geometry.rs): a
single-entry `(cx,cy) → Option<addr>` memo collapsing the 7 `chunk_map` hash
lookups per voxel (self + 6 neighbors) to one compare on the common path. It
caches chunk **absence** too, the hot path on sparse worlds. It uses `Cell`, so
it is **`!Sync`**: single-threaded scans only, never hand it to rayon.

## Lighting & shadows (baked path) *(experimental)*

`LightMode { night, shadows, sun_t, lamp_radius, flat, profile }` is baked into
vertex colors inside `obj_geometry_region`. `LightMode::default()` (`profile`
defaults to `LightingProfile::Legacy`) is a flat fully-lit render; only
`get_chunk_geometry` opts into night/shadows. Both multipliers
are computed once per voxel and folded into the `push_tri!` / `push_quad!`
macros via an `lm` (light-multiplier) argument, so every face of a block shares
the same lighting.

### Night lighting

Mirrors the game's lamp-block point lighting (`Lighting.mm`, `Terrain.mm`
`calcLight`):
- Ambient drops to `NIGHT_AMBIENT = 0.35`.
- Each Lamp block (type 72) contributes `profile.falloff(dist, radius) * lampColor`
  per channel to every block within `lamp_radius` (user-tunable; `<= 0` →
  `profile.default_radius()`), clamped to `[0.0, 1.5]`. **Lamp color is the lamp's
  paint color**, not a separate table.
- Lamps render fullbright.
- Lamps are gathered from the **lamp spatial index** (below) via
  `lamps_in_region`, O(nearby lamps), not O((16+2r)³), so raising the radius
  isn't cubic. Empty slice → `light_at` returns fullbright.

### Lighting profile (`LightingProfile`)

The original game shipped two different lamp-lighting behaviours across its
64z and 256z ("New Dawn") client eras. Both are real, previously-shipped
behaviours, not editor inventions, so the profile is a first-class enum
threaded through `LightMode` rather than a single hardcoded curve/constant:

| Profile | `default_radius()` | `falloff(dist, radius)` | Feel |
|---|---|---|---|
| `Legacy` (default) | `LEGACY_LAMP_RADIUS = 4.0` | `((1 - dist/radius).max(0)).powi(2)` (quadratic) | small, sharp-edged pool |
| `Modern` ("New Dawn") | `MODERN_LAMP_RADIUS = 14.0` | `(1 - dist/radius).max(0)` (linear) | broad, gradual pool |

`get_chunk_geometry` takes an optional `lighting_profile` param (camelCase JS
side: `lightingProfile`, `"legacy" | "modern"`, defaults to `Legacy`); a
separately-passed `lamp_radius` still overrides that profile's default
distance without changing which falloff curve is used, the profile picks the
*shape*, the radius slider (Ribbon "Lamp R", 2–32 range) picks the *distance*.
`get_light_constants` exposes `legacy_lamp_radius`/`modern_lamp_radius` (plus a
`lamp_light_radius` alias of the legacy value for older callers) so the
frontend's edit-sync reload radius can't drift from the Rust constants.

Frontend (`FlyView3D.tsx`): `lightingProfile` prop threads into the
`get_chunk_geometry` invoke call for the baked path. For the GPU point-light
path (`updateNightLights`), Three.js's physical light doesn't expose an
arbitrary falloff exponent, so the profile instead picks `decay`: `2`
(inverse-square) for Legacy, `1` for Modern, with `intensity` solved so
brightness at `dist == lampR` reads the same constant `K` regardless of decay
(`intensity = lampR² · K` at decay 2, `lampR · K` at decay 1).

Settings/UI: `AppSettings.lightingProfile` (`SettingsModal.tsx`, schema v5)
persists the default; `Ribbon.tsx`'s Lighting group (3D tab) has a
Legacy/New Dawn toggle next to (but independent of) the Lamp R slider -
switching profile snaps Lamp R to that profile's default radius
(`App.tsx`'s `commitLightingProfile`), same "switch resets the fine-tune"
behavior in the Settings modal's Lighting profile row.

### Lamp spatial index (`WorldState.lamp_index`)

`LampIndex` wraps `LampIndexState { lamps: HashMap<(i32,i32), FxHashSet<[i32;3]>>,
scanned: HashSet<(i32,i32)>, full_box: Option<(i32,i32,i32,i32)> }` (chunk-keyed).
The per-chunk bucket is a set (not a `Vec`) so `apply_delta`'s lamp add/remove is
O(1) rather than a linear `contains` + full-pass `retain`. **On-demand, per-chunk** (this replaced a whole-world scan on the
first night-lit request): `LampIndex::lamps_in_region`, called from
`get_chunk_geometry`/`get_lamps_near`, scans only the not-yet-`scanned` chunks a
given region query's neighbourhood touches, memoises, marks them scanned, then
gathers. Reset to empty on world load/close. Kept current by
`LampIndex::apply_delta(world, snaps)` in `with_edit_inner`/`undo_edit_inner`/
`redo_edit_inner`: a placed/removed lamp updates just its chunk's bucket from the
edit's own undo delta; a delta into an unscanned chunk is dropped (not fabricated
into a bucket), since the next real query re-derives it from truth.
`lamps_in_region(...)` gathers positions from chunks overlapping the region
expanded by `ceil(radius/16)` chunks (`region_chunk_box`), then filters to the
exact xy box. `build_lamp_index` (whole-world scan) is now `#[cfg(test)]`-only -
the parity oracle, no longer a production fallback.

A third `LampIndexState` field, `full_box: Option<(cx_lo,cx_hi,cy_lo,cy_hi)>`, caches the last chunk box `lamps_in_region` verified fully
scanned. A containment check against it lets the hot path (stationary re-fetch,
the 25-chunk edit-sync halo, contiguous streaming steps) skip the per-call
121-cell `todo` build and the rayon scan fan-out, only the pure gather runs. It
grows to the bounding union of old ∪ new when the two boxes share one axis' full
extent and overlap/touch on the other (that union is provably fully scanned),
else it just replaces. Sound with no invalidation: `scanned` only ever grows
(`apply_delta` prunes `lamps`, never `scanned`), and `clear()` drops `full_box`
along with the rest of the state.

### Voxel picking (`pick_block` / `pick_block_in`, `geometry.rs`)

DDA raycast. The march builds one `ChunkCache` so each step
and the trailing hit read hit a single-entry `chunk_range` memo instead of an
`FxHashMap` lookup, the win is largest on a miss (a ray into open sky pays the
full ~890 steps with no early-out, the common case for a horizon-aimed hover
pick). `ChunkCache` is `!Sync`; the march is single-threaded, so it must never be
handed to rayon.

### Shadows (directional sun raymarch)

Not vertical sky-occlusion, a real directional sun:
- `sun_direction(sun_t)` sweeps an arc: `sun_t` 0 = sunrise, 0.5 = noon, 1 = sunset;
  elevation eases 15°→80°→15°, azimuth 0→π east→west.
- `shadow_at` marches a 3D DDA (`dda_march`, **Amanatides–Woo**: visits every
  voxel the ray actually crosses, so a shallow dawn/dusk ray can't hop over a
  one-block-thick occluder) up to `SHADOW_RAY_STEPS = 24` world units toward the
  sun.
- Any occluding hit → hard two-tone `SUN_SHADOW = 0.55`, else `SUN_LIT = 1.0`. No
  soft falloff. Shadowed color is never pure black.

`dda_march` is a general-purpose voxel marcher (also used by `pick_block`).

## Three.js rendering (`FlyView3D.tsx`)

- **Coord mapping** `(wx,wy,wz) → (wx, wz, wy)` (see above).
- **Opaque material:** `MeshBasicMaterial` with `vertexColors` + `side:
  DoubleSide`: **unlit** (shading is in the vertex colors). No lights, no normals.
- **Transparent material:** second `MeshBasicMaterial`, `transparent: true,
  depthWrite: false`.
- Both get **textured variants** (`texMatRef`/`texMatTRef`) when a texture pack is
  loaded, sharing one `DataTexture` atlas (see [Texture Packs](../subsystems/)).
- **Sky dome:** a large inverted-sphere gradient (`ShaderMaterial`, horizon
  `#c5d5eb` → zenith `#347ee3` by default, `fog: false`, `renderOrder: -1`) follows the
  camera. Zenith and horizon are user colours (`Sky3dPrefs` in `FlyView3D.tsx`,
  `AppSettings.sky3dZenith/sky3dHorizon`, defaults `SKY_3D` in `theme.ts`), edited from the pane's
  `…` menu (two swatches, "match fog" = horizon := fog colour, ↺ reset) and pushed live through
  `sceneApi.setSkyGradient`: no scene rebuild; a world-size rebuild re-reads them from a ref.
  Editor-only, never written to `world.sky`.
- **Fog:** `scene.fog` is `FogExp2` (soft) or linear `Fog` (hard); distances from
  `fogDistances(radiusChunks)` (`far = max(20, radius*16*0.9)`, `near = far*0.3`)
  so fog fades at the edge of what's streamed. Color from an editor-only
  fog colour override (default MC-like light blue; `null` = the world's own sky paint). The fog colour and hard/soft model persist (`fog3dColor`, `fog3dSoft`), App owns them as
  `Sky3dPrefs`, the pane reads them as props. Fog *on/off* stays a session-level in-pane override of
  the Settings default. **HUD/Grid** (`show3dHud`/`show3dGrid`, ribbon 3D ▸ Camera, `3d.camera.hud`
  / `3d.camera.grid`): HUD off is "render only": it hides every DOM overlay in the pane -
  camera pill + legend band, the options row (`display:none`, so its state survives) and its popovers
  (closed on HUD off), compass/coordinates, perf/geometry readouts, the in-pane hotbar, the
  VIEW/SELECT/BUILD cluster and the build crosshair. Only the canvas, the floor grid (part of the
  scene) and the context-lost cover remain; the way back is the ribbon/⌘K toggle. Grid is the same flag the in-pane row toggles. Camera far plane (100000)
  untouched. `sceneApi.setFog(enabled, color)` updates in place.
- **DPR** capped at `MAX_DPR = 1.5`; an in-pane AA toggle bumps it to 2 as
  supersampling.

### Chunk streaming

- `Map<chunkKey, Mesh>` (+ a second map for the transparent mesh, third for
  emissive) within `LOAD_RADIUS = 5` chunks (user `RD_MIN=2`..`MAX_RENDER_DISTANCE = 32`
  via an in-pane slider). The `<input type="range">` runs over *slider positions*, not
  chunk radii, via `radiusToPos`/`posToRadius` (FlyView3D.tsx ~95): one notch per chunk
  up to 16, then one notch per **two** chunks to 32. So the cheap low range gets full
  per-chunk resolution while the expensive top half doesn't eat half the track.
  `RD_MIN`/`MAX_RENDER_DISTANCE` are exported from FlyView3D.tsx and imported
  by the ribbon 3D tab's slider and SettingsModal's, so the three can't disagree.
  The in-pane slider has a display/commit split, `onChange` moves a
  local `renderDistanceDisplay` only (the label, tooltip and high-distance warning
  track it live), and `commitRenderDistance` fires on `onPointerUp`/`onKeyUp`,
  routing through `sceneApi.setLoadRadius` (fog refresh + forced evicting sweep) and
  `onRenderDistanceChange` (App re-render + persistence). A drag no longer dispatches
  an App re-render and a scene re-sweep per pixel; `renderDistanceDisplay` re-syncs
  from `loadRadius` whenever the committed value moves for another reason (Settings
  revert, mount).
- **Hard resident-geometry byte cap (all three streams + in-flight fetches)**,
  `geometryBudgetBytes` prop (default `GEOMETRY_BUDGET_BYTES = 512 MB`, the "Balanced"
  memory-budget preset, App.tsx wires it from
  `MEMORY_PRESETS[memoryBudget].geometryBudgetBytes`): once crossed, streaming stops pulling new chunks until eviction
  frees headroom; a "render distance limited by memory" pill appears. Read via a
  ref (`geometryBudgetRef`) inside the scene-setup effect's `pump()` closure so a
  mid-session preset change takes effect without growing that effect's own
  dependency array.
  - **Eviction is budget-driven, not just radius-driven.** The radius pass alone
    frees only what fell *outside* the disc, so at a render distance where the whole
    disc is in range it frees nothing: the gate stayed shut permanently, lowering the
    memory preset was inert, and the queued chunks never arrived, a *streaming stall*
    rather than a slowdown.
    `streamSweep` now runs a second pass that drops chunks **farthest from the camera
    first** while over budget (never an LRU, the chunk you just flew toward is the
    newest *and* the one you need), skipping anything `inflight` or in `forceKeys`
    (`reloadChunk` owns the budget interaction for those) and anything holding zero
    bytes (an `emptyChunks` marker frees nothing and would be refetched forever).
  - ⚠️ **`budgetHorizonSq` is what stops that pass from churning.** Evicting the
    farthest chunk drops resident bytes just under the cap, which lets `pump()`
    immediately refetch it as the nearest non-resident chunk, one pointless round
    trip per sweep, forever, once the pane is pegged. So each budget eviction records
    the squared chunk distance it reached, and the radius scan refuses to queue
    anything at or beyond it (floored at 1, so the camera's own chunk stays
    fetchable). The horizon is re-opened whenever the camera chunk, the z band, the
    radius or the budget value changes, the only four things that change what fits.
    Edit-sync reloads bypass it entirely (they never go through the radius scan).
  - Both eviction passes now run **before** the queue is rebuilt and before the single
    `pump()` at the end of the sweep, so a sweep that frees headroom resumes streaming
    in the same tick .
  - The "render distance limited by memory" pill tracks `overBudget || horizon set`,
    not `overBudget` alone: after eviction the pane sits *just under* the cap with its
    disc truncated, which is exactly when the user needs to be told.
  - Counted in **bytes, not vertices**: a vertex cost 24–36 B
    depending on stream and texture pack in the v1 format (12–16 B plus indices in v2), and the old 30 M-vertex "Balanced" cap was
    ~1.9 GB of resident geometry, reachable within seconds on a 256z world, which is
    where the fly-view crashes came from. The number is the envelope's own `lens` sum
    (each `GeometryStream.bytes`, index bytes included), stored on `mesh.userData.geomBytes`
    so `disposeMesh` subtracts exactly what was added.
  - **In-flight fetches reserve** an EWMA-estimated payload (`chunkEstimateBytes`,
    seeded 2 MB) so up to `maxConcurrent()` dense chunks landing together can't
    overshoot; the gate is re-tested per iteration inside `pump()`'s fill loop.
- **Camera z band** (`Z_BAND_ABOVE = 96`, `Z_BAND_STEP = 64`). `get_chunk_geometry`
  takes optional `zMin`/`zMax`; FlyView3D sends a `zMax` of
  `ceil((cameraEdenZ + 96) / 64) * 64`, or **omits it** when that already covers
  `world.max_z`. This
  attacks the 256z cost *at source*: a 16×16×256 chunk scan is 4× a 64z one and is
  paid in Rust before a single vertex exists, almost all of it walking empty air
  stacked above the terrain.
  - **One-sided (ceiling only), deliberately.** A symmetric ±96 band would
    widen on look-down, but a band with a *floor* hides terrain
    below the camera, and "fly up to survey the map" is a routine editor gesture -
    the landscape would vanish. Clipping only above has a bounded failure mode (a
    ceiling more than ~96–159 blocks overhead pops in as you climb toward it) and it
    is where the empty air actually is.
  - The **cutaway cap composes server-side**: `get_chunk_geometry` intersects the
    caller's band with `ws.view_cap_z` itself (both only ever narrow, so `min` is the
    whole composition). The frontend's job is invalidation only, the `viewCapZ` prop
    is a `reloadAllChunks()` trigger, nothing more. 
  - **Cache invalidation:** the band is not part of the chunk key. `streamSweep`
    recomputes it each tick and, when it moved, bumps `fetchGen` + disposes every
    resident mesh before sweeping, checked *before* the stationary-camera early-out,
    which compares chunk XY only and would miss a purely vertical climb. `Z_BAND_STEP`
    quantization is what keeps that full restream rare.
  - ⚠️ **Quantization alone is not enough.** Rounding to `Z_BAND_STEP`
    bounds how often the band *moves* but not how often the camera *crosses* a
    boundary, hovering right on one (notably `camera.y ≈ 96` on a 256z world, the
    `null`⇄bounded edge) full-restreams at sweep rate. `zBandTop()` adds hysteresis:
    it holds the current band until `camera.y + Z_BAND_ABOVE` is more than
    `Z_BAND_STEP / 2` outside it in **either** direction (the extra `Z_BAND_ABOVE`
    headroom absorbs the upward lag). The `null` case compares against the pivot
    `need` would have to fall back below to re-enter a bounded band
    (`ceil(maxZ / STEP) * STEP - STEP`), so that edge gets the same margin. A 64z
    world still returns `null` on every call.
  - ⚠️ **The see-through-roof trap.** Face culling reads the *real* world, so the
    block just above `sz2` still occludes the top face of the topmost emitted one, a
    naive clip leaves a hole you look straight through into the terrain interior.
    `obj_geometry_region` therefore culls against **`gbz`**, `gb` clipped to
    `[sz1, sz2]`, so an out-of-band neighbour reads as air and the cap face emits.
    `shadow_at` deliberately keeps using the unclipped `gb`: the sun raymarch must
    still be blocked by terrain outside the band. Pinned by
    `test_obj_geometry_z_clip_emits_cap_faces` (a clipped render is byte-identical to
    a render of the truncated world) and `..._degenerate_bands`.
- **Suspend instead of unmount** (`suspended` prop). App mounts FlyView3D the first
  time the pane goes live and never unmounts it again (`mounted3dRef` latch in
  App.tsx); closing/collapsing the 3D window detaches its host node and suspends it.
  `setSuspended(true)` cancels the rAF loop, clears the sweep interval, bumps
  `fetchGen`, and disposes every resident chunk mesh, so a hidden pane holds a bare
  context and nothing else; `setSuspended(false)` re-measures the canvas (it read 0
  while hidden, so `resize()` had clamped the renderer to 1×1), restarts the sweep and
  restreams. `invalidate()` and `frame()` both bail while suspended, and the
  context-restore handler doesn't restart streaming into a hidden pane. Motivation:
  WKWebView caps simultaneously live WebGL contexts, and creating/destroying one per
  toggle is a plausible secondary contributor to the crash.
  **Closed-pane contract:** a suspended pane does *no* background work. Every
  external trigger funnels into gated primitives, `streamSweep`, `pump`, `reloadChunk`,
  `updateNightLights` and `refreshHighlight` all return while suspended, so a world
  load (`resetCamera`), a texture/cutaway/lighting change (`reloadAllChunks`), a
  Settings render-distance change and a 2D edit's sync fetch nothing. Without that, each
  of those would stream into the hidden pane, and with no sweep running, what landed would stay
  resident. Camera moves while suspended snap instead of tweening, so the resume
  restream is centred on the new spot. Suspend also frees the GPU-shadow render target;
  three.js reallocates it on the first shadowed frame. A closure rebuilt by a world
  change while hidden skips its kick-off sweep. There is deliberately no "release the
  context when closed" option. What remains is materials plus the texture atlas, and a
  released context would also have to stay out of the `gfxBackoff` loss count.
- **CPU copy released after GPU upload.** Each chunk attribute gets an
  `onUpload(function () { this.array = null })` hook (`releaseOnUpload`). The decoded
  streams are zero-copy *views* over the one IPC envelope, which Three.js would
  otherwise keep alive alongside the GPU VBO, double-counting every resident chunk.
  Safe because chunk meshes are never raycast (picking is the Rust-side `pick_block`
  DDA), nothing sets `needsUpdate` on them, and `computeBoundingSphere()` has already
  run at install time so frustum culling keeps working off the cached sphere.
  ⚠️ It also makes the geometry **unrecoverable after a context loss**: the
  `webglcontextrestored` handler below *must* call `reloadAllChunks()`.
  ⚠️ The hook only fires for meshes three actually **draws**, and the frustum pass
  hides most of the disc at a large render distance, so those chunks keep their CPU
  copy. This is accounted for rather than fixed: an un-uploaded
  mesh has no VBO yet, so `residentBytes` is its heap cost until it first draws and its
  VRAM cost afterwards, never both, and this release is what keeps the two from
  overlapping. Adding `jsBytes` to the gate would double-count every undrawn chunk and
  roughly halve the resident chunk count at a given preset for no real saving. The
  residual risk is *which pool* holds the bytes (a WKWebView JS heap is a far tighter
  cap than VRAM); if a baked-lighting session, no GPU shadow pass, so no light-camera
  render forcing uploads, ever crashes with `js` a large fraction of `gpu` on the HUD,
  forcing the upload at install is the lever, not the accounting change.
- **WebGL context loss/restore.** `webglcontextlost` → `preventDefault()` (without it
  the context is never restorable), cancel the rAF loop, park the sweep interval, set
  a `contextLost` flag that makes `frame()` bail, and toast via the `onNotice` prop
  (the pane's only other escape hatch is throwing,
  which the ErrorBoundary turns into a full-pane replacement). `webglcontextrestored`
  → restart the sweep, `reloadAllChunks()`, resume rendering.
- **Teardown releases the context only on a true unmount.** `forceContextLoss()` is
  wrong when the scene effect merely *re-runs* (world resize, StrictMode double-mount,
  HMR): the same `<canvas>` is reused and a dead context breaks the next
  `new WebGLRenderer`. On a real unmount React discards the canvas, so releasing is
  both safe and needed, WKWebView caps simultaneously live contexts, and repeated
  pane toggles used to strand one each. Detected by `unmountingRef`, set by a
  mount-only effect declared **above** the scene effect (React runs cleanups in
  effect-definition order), with a deferred `canvas.isConnected` re-check as the
  StrictMode guard.
- **Dev-only memory HUD** (`GeomMemHud`, bottom-right): resident chunk count, GPU
  bytes vs budget, JS-heap bytes still pinned, in-flight reservations, peak, and the
  largest single-chunk payload. Fed imperatively like `CoordHud`. Its Rust counterpart
  is a `[GEOM]` `timing_log!` line per `get_chunk_geometry` (debug builds only).
- Throttled sweep (`STREAM_MS = 150`) disposes chunks outside `(r+2)` **Euclidean**
  distance (matches the loading disc's `d2 <= r*r` test), then runs the budget pass
  above. Air-only chunks tracked in a `Set<string>`.
- **Adaptive concurrency:** `MAX_CONCURRENT_IDLE = 4` / `MAX_CONCURRENT_FLY = 2` -
  drops to 2 while flying so geometry callbacks don't hitch frames.
- Frustum culling via `.visible` toggle (not disposal).
- **Stale-fetch protection:** a monotonic `fetchGen` counter + per-key `staleKeys`
  set stop a superseded fetch from landing. `reloadAllChunks()` bumps `fetchGen`
  (texture/lighting toggles); `reloadChunk()` marks a specific in-flight fetch
  stale (edit-sync).

Out-of-range `cx/cy` and chunks absent from `chunk_map` early-return empty
(frontend contract = local 0-based chunk indices; sparse worlds skip the full scan
of pure-air chunks).

### Render-on-demand

`dirty + rafPending` double-flag: `invalidate()` schedules a single rAF; `frame()`
reschedules only while fly-mode or orbit damping needs it, and only when
`!rafPending`. `frame()` bails if the scene was disposed (guards a mid-unmount
orphaned callback). Idles at ~0 GPU when static.

### Canvas / context lifecycle (gotcha)

Binds to a fixed `<canvas>` ref. A canvas owns exactly one WebGL context for its
lifetime, so cleanup uses `renderer.dispose()` **only, never
`forceContextLoss()`**: under `React.StrictMode` double-mount / HMR the effect
re-runs on the *same* canvas, and a lost context makes `new WebGLRenderer` crash
in `getShaderPrecisionFormat`. Init is wrapped in try/catch and rethrows to the
error boundary on failure.

## Camera modes

`CamMode = "orbit" | "fly" | "look"`, all routed through one `applyMode(next)`:

- **orbit** (default), `OrbitControls`, `enableDamping`, cursor `grab`.
- **fly**: WASD walk + drag-to-look (left-button only). Never grabs pointer lock,
  so it works where the webview refuses it. Cursor `move`.
- **look**: WASD walk + free mouselook, cursor **grabbed + hidden app-wide**
  (Minecraft-style). ⚠️ Does **not** use the browser Pointer Lock API (WKWebView
  on macOS silently fails it). Instead it grabs the cursor at the **Tauri window
  level** via `set_cursor_lock(locked)` (→ `window.set_cursor_grab` +
  `set_cursor_visible`). tao's macOS `set_cursor_grab` calls
  `CGDisplay::associate_mouse_and_mouse_cursor_position(!grab)`: the cursor
  freezes but mouse *delta* events keep flowing, and `onMouseMove`'s
  `camMode==="look"` branch steers from `movementX/Y`. `setNativeCursorLock(bool)`
  is called on every look enter/leave, plus on blur and unmount, **never leave it
  grabbed**. The grab's first `movementX/Y` event is a large synthetic recentring
  delta from the OS cursor warp, `lookJustEngaged` (set on look-entry, consumed by
  the very next `onMouseMove`) swallows exactly that one event so the view doesn't
  whip around on entry.

Cycle (`Z` or the corner pill): **orbit → look → fly → orbit** (first `Z` lands in
mouselook, the headline mode). **Esc** → orbit. `onBlur` drops look → orbit.
Shared walk controls: Space/E up, Ctrl/Q down, Shift boost (3.5×), wheel = speed
(0.1–12×). Speed formula `max(12, maxZ*0.6) * boost * speedMult * dt`.

**Orbit re-entry target resync:** `applyMode` re-syncs `controls.target` to a point
10 blocks ahead of the camera's current facing *before* re-enabling `OrbitControls`
on the walk→orbit transition. Without this, `controls.target` is left wherever it
was before flying (usually far behind the camera after a fly/look session) and
`OrbitControls` re-aims at that stale target the instant it re-enables, producing a
hard snap back toward it.

**Key drift fix:** `keys.clear()` on leaving a walking mode and on `window.blur`.
**App-level interaction:** App's global keydown gates on `flyActiveRef` so WASD
doesn't fire editor shortcuts while flying, but lets ⌘-combos through.

### Discoverability

The pane's toggle is View ▸ Windows ▸ 3D view (⌥3) and is on by default on capable hardware. Once open, the control reference
lives behind the "?" legend button (bottom-right), a 24px hit target (the glyph itself stays small), and **auto-opens the
first time the pane component ever mounts**, gated on a `localStorage` flag
(`eden_3dpane_legend_seen`). This works because FlyView3D mounts once per session and
is suspended/resumed thereafter rather than remounted (see "suspend-don't-unmount"
above), so "first mount" is exactly "first time the pane is used", no separate
gesture-tracking needed.

**HUD type floor.** Every HUD text element (compass ring letters/arrow,
the coord/geometry-memory readouts, the mode-strip badges, the WASD legend, the
render-distance/Fog/AA/Grid row, the in-pane hotbar's digit labels) sits at the
app's 10px type floor. The compass ring is 26px so the N/E/S/W labels fit. The
mode-strip row (top-left: mode badge + WASD legend + speed/loading/budget badges) and
the Render/Fog/AA/Grid row (top-right) are two independent `position: absolute` bands
sharing the same top edge whenever `compactHud` is false. The left row caps at
`calc(100% - 580px)` (the right row's own worst-case expanded width) with
`flexWrap: "wrap"` when not `compactHud`, so it grows down instead of into the other row.

## Voxel picking (`pick_block`)

`pick_block(ox,oy,oz, dx,dy,dz, maxDist)` marches `dda_march` from a ray **in Eden
coords** and returns `PickResult { x,y,z, block_type, paint, nx,ny,nz }`: the
first non-air voxel plus the unit-normal face it entered through. `hit + normal` is
the empty voxel a placed block occupies. Ramps/wedges pick as full cubes;
non-solid blocks are pickable. Ray casting is in Rust, not `THREE.Raycaster`
(which would test every triangle of every loaded mesh), the DDA visits ~50 voxels
and doesn't need the chunk streamed in.

- **Hover highlight:** one reused `LineSegments(EdgesGeometry(BoxGeometry))`,
  repicked at ~30 Hz. Previews the cell a left-click acts on: build → placement
  cell `hit + normal` (green); select → the hit voxel (blue).
- **Two reaches, not one.** `PICK_DIST = 256` serves the *informational* picks
 , select-mode hover/clicks, the eyedropper, flood-fill seeds. Build mode instead
  picks at **`buildReach`** (`AppSettings.buildReach`, default 64, Settings ▸ 3D,
  slider 8–256, clamped to `PICK_DIST` in the pane). Build **hover uses the same
  reach as the build click**, so past the cap the pick simply misses, the green box
  disappears, and the click no-ops, the refusal is visible rather than silent, and
  the outline can never promise an edit the click would refuse. This exists because
  a 250-block edit lands where the 1-block outline is already sub-pixel.
- **3D two-click selection:** two picked voxels reduce to `rawBounds` + zMin/zMax
  (a full 3D box), lighting up copy/paste/fill/extrude/gradient/prefab. App owns the state machine (`pick3dFirst`, amber ghost, Escape).
- **Mode ownership:** `interact3d` derives from `mode3d`
  (`off|select|build|sculpt|floodfill`), owned by the contextual **3D ribbon tab** -
  *not* the map's Draw/Select tools. 3D build has **no armed block of its own**: it
  places App's shared `fillBlockType`/`fillPaint`, the same pair the 2D Draw tools
  and every palette surface use, which is why the in-pane hotbar and the ribbon
  palette stay in lock-step for free.

### Build input model (Minecraft-style drag-sweep)

**Left = break, right = place** at `hit + normal`, both as *sweeps*: press, drag
across a surface, get a line of blocks along it. Right-click places through
**both** `contextmenu` and the button-2 `pointerup`, sharing one `placeAt`, with a per-press
`rightHandled` flag so whichever fires first wins and the other is swallowed. `contextmenu` alone
(button 2 is unreliable in macOS WKWebView, MapCanvas hit the same) broke on **Windows look mode**:
there the pane holds real Pointer Lock, and Chromium/WebView2 doesn't dispatch `contextmenu` while
the pointer is locked, so a right-click would otherwise reach neither handler and place nothing.
(This path hasn't been verified on Windows.) Edits go through `paint_blocks` →
`with_edit`, so undo/redo + chunk-mesh reload are free.

**Build mode owns both drags.** The mode effect calls
`setOrbitLeftEnabled(interact3d !== "sculpt" && interact3d !== "build")` **and**
`setOrbitBuildMode(interact3d === "build")` (order matters, the latter resets the
Alt override). `setOrbitBuildMode` nulls OrbitControls' RIGHT and remaps MIDDLE to
ROTATE. So in build mode the camera is: **middle-drag** orbits, **Alt+left** orbits,
**Alt+right** pans, wheel zooms. Middle *click* is still the eyedropper -
`onPickUp`'s `isClick` slop test separates click from drag. Both mappings are also
seeded at scene-init from `interact3dRef`, because the scene effect re-runs on a
world-size change while `interact3d` may already be build/sculpt and the mode effect
(dependency unchanged) will not re-fire.

Taking RIGHT away also makes a right-drag *pan* ending in a stray
placed block structurally impossible rather than merely slop-guarded. The
`withinClickSlop` test in `onPickContext` stays anyway: a right-drag is now a
place-*sweep*, whose stamps come from the tick, so a release far from the press must
not add one more block at the release point.

**Two things drive stamps** out of a live gesture (`buildRepeatButton >= 0`):

- **`pointermove`**: the sweep. A drift past `CLICK_SLOP_PX` doesn't cancel the
  hold, because nothing else owns the drag; every move is a stamp
  attempt instead. `buildRepeatBusy` (set *before* the `await pick`) collapses the
  60–120 Hz move stream to exactly one pick+edit in flight. ⚠️ **The sweep does not
  start until the press outgrows a click**, `buildRepeatTick` returns early while
  `withinClickSlop(cursorX, cursorY)` holds (still inside `CLICK_SLOP_MS` *and*
  `CLICK_SLOP_PX`). Until then the click path owns the gesture and places exactly one
  block. Without this gate a few-px hand-shake between `pointerdown` and `contextmenu`
  would become a stamp, and its own trailing-edge re-tick a second one, so a single
  right-click would place two blocks.
- **the interval** (`BUILD_REPEAT_DELAY_MS` → `BUILD_REPEAT_MS`), the stationary
  airbrush fallback. It earns its keep in fly/look mode, where the pointer never
  moves but WASD/mouselook still re-aims the crosshair. Its delay stays longer than
  `CLICK_SLOP_MS` so a quick click resolves through the click path instead of racing
  it; `buildRepeatFired` then suppresses the click path in `onPickUp`/`onPickContext`
  whenever a stamp already ran for that press.

**Three things bound a gesture**, and they are why a hold can no longer run away:

- **`buildRepeatCells`**: every cell edited *this gesture*, not just the previous
  one. Each edit changes the world, so the next pick along the same ray returns a
  new cell one step nearer (place) / further (break); a previous-cell-only dedupe is
  what used to march a tower into the camera's face at ~4.5 blocks/sec. A swept path
  never revisits a cell, so the set costs a sweep nothing.
- **the placement-plane lock** (`buildRepeatPlane`, `"nx,ny,nz@offset"`), the first
  stamp fixes both the face *orientation* and the acted cell's coordinate along that
  normal's axis; every later stamp must match. Orientation alone would not do:
  sweeping a flat field from above, the ray dips into the hole you just made and hits
  the next block down through its newly-exposed *top* face, same normal, one layer
  deeper. The offset is what keeps a break-sweep peeling exactly one surface layer
  and a place-sweep laying exactly one; the normal is what keeps either from wrapping
  around a corner onto the adjoining face.
- **the aim-change gate**: the tick returns *before issuing a pick* when neither the
  cursor nor the camera pose has moved since the last one. An unchanged aim cannot
  resolve to a new cell, so this is what stops a stationary hold from spinning IPC
  (and the world mutex behind it). A fixed count of idle ticks would kill a sweep that merely paused instead. `BUILD_GESTURE_MAX_MS` (20 s) is the remaining
  hard bound, for a hold whose `pointerup` the webview never delivers at all.

**Disarm paths**, all calling `endBuildGesture()` (a wrapper around
`stopBuildRepeat()`, see "Undo grouping" below; it bumps `buildRepeatGen`, so a
tick already parked on `await pick(...)` drops its edit instead of landing it one
block after you let go): `onPickDown` **before** arming (idempotent re-arm, so a
missed release can't leave a stale interval under a new one), `onPickUp`,
`pointercancel`, `setSuspended(true)`, `onBlur`, a mode change out of build
(`clearHighlight`), and `onPickContext`: the last one **only when the press is
outside the click-slop window**, because platforms disagree on whether `contextmenu`
fires at press or release time and an unconditional stop would cancel every
right-hold on a fire-at-press platform. Belt-and-suspenders: `canvas.setPointerCapture(e.pointerId)` on build-down
guarantees the matching `pointerup` lands on this canvas even if released elsewhere.

### Undo grouping, hover-pick reuse, and highlight freshness

**One undo entry per gesture, not per stamp.** `paint_blocks` (lib.rs) takes an
optional `group: Option<u64>` and routes through `with_edit_grouped` instead of
`with_edit`: identical machinery to sculpt strokes (contiguous same-group entries
collapse into one logical unit, so the History tab and undo/redo depth badges pick
this up for free; that collapsing is now a cached count on `WorldState` rather than
a per-edit stack walk; see
[Editing, Undo & Clipboard](../editing-undo-clipboard/)).

Every edit's pre-image is copy-on-write and captures only the 8 KiB bands it actually
changes, so a one-voxel stamp on a 256z world costs one band, not all 16 (131 KB). See
[Editing, Undo & Clipboard](../editing-undo-clipboard/) "`EditView`". FlyView3D mints one id per build gesture
(`buildGestureGroup = ++sculptGroupSeq`, shared counter with sculpt so the two
families' ids never collide) in `onPickDown`'s arm branch, which runs for every
build press regardless of whether it resolves as a plain click or a sweep, so both
paths tag their stamps with the same id. `onPickBreak`/`onPickPlace` gained a
trailing optional `group` param carrying it through to App's
`handlePick3dBreak`/`handlePick3dPlace` → `paint_blocks`. A grouped stamp's
`applyEditResult` call passes `{ silent: true }`, suppressing its own toast; a new
`onBuildGestureEnd(mode, count)` callback fires once when the gesture truly ends
(wrapped as `endBuildGesture()`, replacing the disarm paths' old bare
`stopBuildRepeat()` calls) and App shows one summary toast ("Placed 14 blocks").
A plain click that never reaches `buildRepeatTick` (short press, no sweep tick
fired) reports its own one-block gesture directly at its call site in
`onPickUp`/`onPickContext`, since by the time execution reaches that point
`endBuildGesture()` already ran higher up the same handler and found an empty
`buildRepeatCells` (nothing to summarize there).

**The placement outline can't show a stale pre-edit target.** The
green/blue box would otherwise refresh only on real pointer movement (`onPickMove`) or, in
fly mode, the render loop, so in **orbit** mode a stationary click would leave the box
showing the target *before* the edit until the mouse jiggled. `sceneApi` gained
`refreshHighlight()` (resets `lastPickT` to 0, bypassing the hover throttle, then
re-picks), called from the `editEpoch` effect, which already fires after every
edit regardless of origin (2D or 3D), so this one call site covers all of them.

**A click reuses the hover pick that drove the outline** instead of re-picking
from scratch. `refreshHighlight`'s pick is cached (`lastHoverPick` +
cursor position + timestamp); `pickOrHover(cx, cy, maxDist)` returns the cache when
the cursor hasn't moved and it's fresher than `HOVER_PICK_REUSE_MS` (100ms), else
falls back to a real pick, so this is a pure latency win (one fewer `pick_block`
round trip per click) with no correctness risk, and it guarantees the click can
never resolve to a cell other than the one the outline just showed. Applied in
`onPickUp` (select/floodfill/build-break) and `onPickContext` (place); the
middle-click eyedropper still picks fresh.

Alt is tracked from raw `keydown`/`keyup`/`blur` on `window` rather than read off the
pointer event, because OrbitControls reads `mouseButtons` inside its *own*
`pointerdown` handler, whose ordering against ours isn't guaranteed; keeping the
mapping correct while the key is merely held sidesteps that. `onPickDown` and
`onPickContext` both refuse to act while `altKey` is set, so an Alt camera drag never
edits.

### Select-mode transform gizmo (Axiom-style)

Hand-rolled (not THREE's `TransformControls`: its scale gizmo is center-symmetric).
Auto-shown whenever `interact3d==="select"` and a selection exists. Handles, all
`depthTest:false`/`renderOrder:1000` so they float over geometry:

- **Center move-cube** (light gray), grab to slide the *whole box* on the ground
  plane (Eden x,y). 2-axis drag.
- **3 arrows** (R=x, G=up/height, B=Eden-y), each a **cone tip + scaling shaft**
  stemming from the center, single-axis whole-box move. The shaft is a unit-height
  cylinder scaled per-layout to reach from center to the cone base.
- **3 plane squares** (colored by their normal axis, ground=green, side=red/blue)
 , move the whole box **on that plane** (2 axes at once, incl. the two vertical
  planes the single arrows can't cover). 2-axis drag.
- **6 small face boxes**: resize a single face along its axis (the only resize
  handles).

**Move vs resize:** resize (face handles) is **always region-only**. Move (center +
arrows + planes) honours the shared **`moveWithContents`** toggle (App state, also the
Selection ribbon tab's *Move: Box/Contents* pill, mirrored into `moveWithContentsRef`
+ flipped by the in-pane ⇄ pill), region-only, or relocate contents via the
undoable `move_selection` (`onGizmoMoveBlocks`). So 2D and 3D share one move mode.

**Drag math:** 1-axis handles build a camera-facing plane containing the axis and
project ray∩plane onto it (`gizmoDragAxisVec`/`gizmoDragAnchorProj`). 2-axis handles
(`gizmoDrag2d`) fix the plane by the handle's normal axis through the box center and
project onto both in-plane axes (`gizmoDrag2dAxisA/B`, referenced to the pointerdown
intersection so both deltas start at 0). All deltas round to whole voxels; the live
preview box is transformed (not rebuilt) per move. Escape/pointercancel abort with no
commit. *No rotation rings*, selection rotation has no backend yet.

## GPU shadow-map mode *(experimental, opt-in)*

`gpuShadows` prop. **Session-only, always off at startup, reset off on world
load/close** (`resetHeavyLighting()`); not persisted. When on:

- Chunk meshes switch from unlit `MeshBasicMaterial` to lit `MeshLambertMaterial`
  (`matL`/`matLT`, plus textured `texMatL*`), with an `AmbientLight` + a
  shadow-casting `DirectionalLight` (`sun`).
- Rust fetches **flat geometry** (`get_chunk_geometry` `gpu: true` →
  `LightMode.flat` → skips SH_* shading, lamp loop, and raymarch; emits raw
  `block_color`; face *kind* for textures still comes from the SH_* constant).
- Lambert materials use **`flatShading: true`** (normals derived in-shader) → **no
  `computeVertexNormals()` CPU pass**, visually identical for voxels.
- **Payoff:** `sunT` is *free*, the per-frame sun-follow repositions the light and
  its ortho shadow box; moving the sun is a light move, not a chunk rebuild. The
  `lightEpoch` reload effect early-outs to one repaint.
- **Emissive lamp stream** keeps lamps fullbright under the dim night ambient.
- **Patterned transparent shadows:** the transparent stream casts via a shared
  `customDepthMaterial` (`patchDepthAlpha`) that discards shadow-pass fragments
  with vertex alpha < 0.75, water/glass/flower pass light, fence casts; with a
  texture pack a textured depth variant punches the fence-weave lattice.
- **GPU night point lights:** GPU + Night → real `THREE.PointLight`s at lamps
  (`MAX_NIGHT_LIGHTS = 16`), physical falloff with `distance = lampR*4` and a
  per-profile `decay`/`intensity` pair approximating the baked-path curve for
  that `LightingProfile` (see "Lighting profile" above): Legacy `decay = 2`,
  `intensity = lampR²·0.4`; Modern `decay = 1`, `intensity = lampR·0.4`: both
  solved so brightness at `lampR` ≈ K regardless of radius (the Lamp R slider
  grows reach, not just brightness). Re-queried on camera move, on enable, on
  `editEpoch`, and on profile switch.
- **Shadow quality:** ortho half-extent clamped to `min(reach,
  SHADOW_MAX_REACH=320)·1.1`; `mapSize` bumps to 4096 when `loadRadius > 16`.
  `renderer.shadowMap.type` is `PCFShadowMap` (a hard PCF kernel), three r184
  deprecated `PCFSoftShadowMap` and silently falls back to `PCFShadowMap` anyway,
  which also made `sun.shadow.radius` inert, so both were dropped.
- **Sun disc** (`sunDisc`, a billboarded Sprite) + warm sunrise/sunset tinting of
  sun/disc/ambient by `warmth = 1 - sin(π·sunT)`.

Precedence: GPU+Night = GPU night point lights; GPU alone = day sun; Night alone
(no GPU) = baked night. Zero regression to the default path, everything is gated
on the flag.

### Edit sync (3D)

`editEpoch` + `lastEdit` reload chunk meshes overlapping the edit's top-down bounds,
expanded by `max(1, ceil(max(lampRadius, shadowRayScan)/16))` chunks. The floor of 1
chunk applies **regardless of lighting**: face culling for a voxel
is decided against its neighbour, so a block added/removed at or near a chunk boundary
changes which faces the *neighbouring* chunk's own mesh should be emitting, that
neighbour is never part of `core` (below), and with night lighting/shadows both off,
`reach` would be `0`, so it would never be reloaded at all. Left unfixed, that's a
permanently stale culled (or wrongly-visible) face at the seam, not just until the
next debounce, since nothing ever scheduled the reload, until something forces a full
`reloadAllChunks()` (e.g. toggling the pane off/on). Night lighting/shadows still widen
the pad further, since a placed lamp or new occluder affects the *next* chunk over. The
two halves of that rect are **not** on the same schedule :

- **core**: the chunks the edit's own bounds touch, usually 1. Reloaded
  immediately: this is the block you just placed appearing, so it can't be deferred.
- **halo**: everything the reach adds on top (now always ≥1 ring). Accumulated into a
  `"cx,cy"` key set and flushed on a trailing `HALO_FLUSH_MS` (350 ms) debounce. With
  baked shadows on, `shadowRayScan = 24` makes the padded rect **5×5 = 25 chunks**;
  paying that per *placed block* is the refetch storm that made building on a large
  world feel broken. A build sweep stamps far faster than the debounce, so it now pays
  the halo once, after release, the "coalesce per gesture" outcome with no gesture
  plumbing between the scene closure and the effect, because the edit rate *is* the
  gesture signal. A lone click pays it 350 ms later, and the seam it fixes was never
  visible sooner than that. The flush no-ops on a suspended pane (which disposed every
  mesh and emptied its queue; its resume path restreams from scratch).

⚠️ **A forced reload can be silently dropped by the periodic stream sweep unless the sweep re-merges it.** `reloadChunk` queues its target and returns, but the chunk isn't fetched
until `pump()` reaches it, gated by `maxConcurrent()` (2–4). `streamSweep` itself runs
unconditionally every `STREAM_MS` (150 ms) and used to unconditionally overwrite `queue`
with a fresh radius scan (`needed`), which, since a forced chunk is *resident* (stale
mesh) and therefore excluded from `needed` by construction, discarded any forced reload
that hadn't reached `active` yet. An edit large enough to force-reload more chunks than
`maxConcurrent()` can start within one 150 ms tick (a big paste is the common case) would
therefore only ever show the first couple of chunks, "an edit only partially appears
until the 3D pane is toggled off/on". `streamSweep` now re-merges every `forceKeys` entry
that isn't already `inflight` back into the rebuilt queue before pumping, so a pending
forced reload survives any number of intervening sweep ticks until `pump()` actually
starts it (which is also the point `forceKeys` itself is consumed).

Both halves go through the same `reloadChunk`, and therefore the same
`forceKeys`/`staleKeys` discipline: the old mesh stays in the
scene until its replacement lands (`startFetch`'s `.then()` disposes and installs
atomically), so an edit no longer punches a visible hole in the terrain for a full
round-trip. `forceKeys` is what lets a *resident* chunk refetch at all, it's set on
the in-flight path too, or the `staleKeys` requeue in `startFetch`'s `finally{}` would
be skipped as "already resident" and strand pre-edit geometry. The one exception: when
`residentBytes + inflightBytes` is already at the geometry budget, `reloadChunk` keeps
the old eager `disposeMesh(k)`: `pump()` refuses to start a fetch while the stale mesh
still counts against the cap, so on a budget-limited pane the hole is the correct trade
against stranding pre-edit geometry indefinitely.

GPU mode early-outs the `lightEpoch` reload to a single repaint.

## Where the pane lives

FlyView3D renders once into a detached host node (`windows/Reparentable.tsx`) and is *moved*
between the floating **3D view window** and the main work area (when swapped with the map).
`pane3dLive` (`windows/layoutState.ts`) is the single definition of "on screen";
a closed/collapsed window detaches the host and the pane suspends. Every move first calls
`FlyView3DRef.exitLook()` (moving a pointer-locked/grabbed canvas is how a cursor ends up frozen).
The HUD compacts below 720×300 (hints and the Render/Fog/AA/Grid row fold behind "⋯").
`onCameraMove(wx, wy, yaw, hfov)` feeds the map's camera dot and its new view wedge. Resize cost:
the renderer resizes from a `ResizeObserver`, which already delivers at most once per frame.

**Spawn (sparse worlds):** the camera starts over real geometry, not the bounding
box (often empty on sparse worlds). `spawnAt` = home/spawn point →
`center_px/center_py` centroid → undefined. The re-center effect keys on
`worldLoadToken` (App's `worldEpoch`), *not* `spawnAt`'s coords, so "Set Spawn
Here" mid-session doesn't yank the camera.

## Overlay boxes (`Overlay3D`)

`{ min:[x,y,z], max:[x,y,z], color }`. Selection = blue `0x3b82f6`, extrude =
amber `0xf59e0b`, paste = green `0x22c55e`, 3D-pick first corner = amber. Each is a
`Group` of **three passes** (not `Box3Helper`): a translucent tinted body
(`depthWrite:false`), solid unoccluded edges, and dimmer `depthTest:false` x-ray
edges so the box stays legible through terrain. All materials `fog:false`.
`clearOverlays` disposes geometries **and** materials. The live selection box uses
`dragSelectRect ?? rawBounds` so it tracks a marquee drag live.

## Perf notes

- The ~10 fps HUD update goes through `hudRef.current.set(...)` into `CoordHud`, a
  leaf component with its own state, a moving camera re-renders only that `<div>`,
  not the pane.
- The ~3 fps `onCameraMove` callback bubbles to App state (`setCam3dPos`, draws the
  map's camera dot) and is throttled harder, it's the expensive one.
- Render-distance/fly-speed slider persistence is debounced 250 ms.
{% endraw %}
