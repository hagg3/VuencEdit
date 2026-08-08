# 06 — 3D Rendering

> **Port reference.** This is the intended reference for a web-based Eden World
> Builder renderer. `FlyView3D.tsx` (the streaming fly-through pane) plus
> `export.rs`'s geometry functions together form a complete voxel-to-mesh pipeline
> with face culling, directional shading, lamp lighting, sun shadows, texture
> atlasing, and voxel picking. The Rust side is pure and world-space; the
> Three.js side owns only camera, materials, and the coordinate permutation.

There are two 3D consumers:
- **`ThreeDPreview.tsx`** — on-demand render of a selection (≤ 64×64×64). Uses
  `get_obj_geometry`. ⚠️ **Currently dead code**: nothing in `src/` imports or
  mounts it, so `FlyView3D` is the only live WebGL context in the app. Kept as the
  worked example of the `get_obj_geometry` path (and the reason that command still
  exists); references to it below describe the code, not a mounted component.
- **`FlyView3D.tsx`** — streaming fly-through of the whole world (quad-view 4th
  cell). Uses `get_chunk_geometry` per chunk.

Both build Three.js `BufferGeometry` from the f32 streams produced by the shared
`obj_geometry_region` in `export.rs`, decoded by `decodeGeometry` (`src/types.ts`)
as zero-copy `Float32Array` views over the raw IPC response — see
[04](./04-ipc-reference.md#binary-payload-envelope-2026-08-05-audit-h2).

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

⚠️ **Do not confuse this with the OBJ *file* writer.** `export.rs`'s `ov(ex, ey,
ez) = (ex, ez, -ey)` **negates Y** and is used only when writing `.obj` files (X
right, Y up, Z toward viewer). The live geometry / picking path uses the
sign-free `o()` permutation. `pick_block` takes and returns **Eden** coords — the
frontend owns the Three↔Eden transform, keeping `pick_block` a pure world-space
query.

## Geometry generation (`obj_geometry_region`)

Shared by `get_obj_geometry` (selection preview) and `get_chunk_geometry`
(fly-view). Emits face-culled cubes, ramp prisms, and wedge pyramids as vertex
positions + colors (+ UVs when textured).

### Directional face shading (baked into vertex color)

Shading is **baked into vertex colors** by Rust, so the opaque mesh needs **no
scene lights** and no `computeVertexNormals()` (saves a CPU spike and the normal
buffer). The per-face multipliers match the game's own fixed shading table
(`cubeColors[]` in `Geometry.c`) — a fake-AO pattern, *not* a real directional
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

- **Opaque stream** (`positions`/`colors`, RGB) — everything solid.
- **Transparent stream** (`positions_t`/`colors_t`, RGBA) — any block with a
  `transparent_alpha()` (water/glass/fence/new-flower). Rendered as a second mesh
  with `transparent: true, depthWrite: false`. Mirrors the game keeping ATLAS2
  blocks in a second buffer.
- **Emissive stream** (`positions_e`/`colors_e`, GPU/`flat` mode only) — lamp
  faces, so lamps stay fullbright under dim night ambient (see GPU section).
  Empty when `!flat`, so OBJ/JSON export and `ThreeDPreview` are byte-identical.

### Face culling

A face is skipped when **either**:
1. the neighbor fully occludes it (`obj_occludes` — opaque, non-ramp), **or**
2. the neighbor is the **same block type** as the current voxel (stops two
   adjacent water/glass/fence blocks from both emitting their shared interior
   face — a deep water column used to emit ~6 quads per interior block for
   nothing visible).

Ramps/wedges always emit their diagonal face regardless. For plain cubes, all six
neighbor occlusion tests are **hoisted before** the lamp/shadow lighting
computation, so a fully-hidden voxel skips the expensive per-lamp loop and shadow
raymarch entirely.

### Greedy meshing (Stage 5 of the 256z crash fix)

After face culling, a naive emitter still writes **six vertices per visible face**,
so a chunk's payload scales with its voxel count. The greedy pass makes it scale
with the terrain's **surface complexity** instead: coplanar adjacent faces that
render identically fuse into one large quad.

Measured on 16×16 heightmaps (merged quads vs. the raw visible-face count the
pre-Stage-5 emitter produced):

| Terrain | Raw faces | Merged quads | Reduction |
|---|---|---|---|
| Flat plain | 640 | 10 | **64×** |
| Deep flat (256z-shaped, h=40) | 640 | 10 | **64×** |
| Cliff / step | 672 | 17 | **39.5×** |
| Gentle rolling | 707 | 102 | **6.9×** |
| Hilly | 1162 | 712 | 1.6× |
| Violently bumpy | 1116 | 669 | 1.7× |

The win is largest exactly where 256z worlds hurt most — deep flat ground and tall
cliff faces, whose side faces merge down the whole column. Rough terrain gains
little, which is expected: there is genuinely nothing coplanar to fuse.

**How it works.** The voxel loop no longer emits plain-cube faces; it pushes a
`FaceRec { dir, slice, bt, paint, lm, v, u }` per face and emits after the scan.

- `dir` fixes the plane and both in-plane axes, so `(slice, u, v)` rebuilds the
  world-space rectangle. The mapping table lives on `FaceRec`'s doc comment.
- **Field order is the merge key and is load-bearing.** `derive(Ord)` sorts
  lexicographically by declaration order, so a single `sort_unstable()` collects
  every legally-fusible face — same direction, plane, block and light — into one
  contiguous run that is *already ordered (v, u)*, which is precisely the
  row-major scan order the rectangle sweep wants. It is also what makes the
  output deterministic, which the z-clip tests depend on (a clipped render must
  be byte-identical to a render of the truncated world). Reorder those fields and
  you silently break both.
- `lm` is stored as raw `f32::to_bits()`: faces may merge only when they render
  **bit-identically**. That is what keeps per-block lamp falloff and sun shadows
  intact instead of averaging them across a big quad. In `flat` (GPU-shadow) mode
  the key folds to a constant, since `lit_rgb!` discards `lm` there anyway.
- Within a group the sweep widens along `u` through unconsumed cells, then grows
  the whole run along `v` while every cell of the next row is present and free —
  standard maximal-rectangle greedy meshing. Scanning in (v, u) order guarantees
  the current cell is the rectangle's origin corner, so each group is covered
  exactly once.

**Only full-cell faces defer.** A face joins the merge pass only when it fills its
unit square. Ramps and wedges are not unit squares; neither is a partial-height
fluid face (a ¾/½/¼ surface, or a lateral sliver stepping down to a shallower
neighbour). Those emit immediately and unmerged, exactly as before.

⚠️ **With a texture pack loaded, the merge is U-only** (`grow_v = pack.is_none()`).
The atlas is one tile wide × N rows tall, so U can tile by repeating that single
column — but **V selects the row**, so growing V would run a merged quad straight
into the next block's texture. Tiling U means UVs run `0..w` instead of `0..1`,
which requires `tex.wrapS = THREE.RepeatWrapping` on the atlas texture, set in
**both** `FlyView3D.tsx` and `ThreeDPreview.tsx`. `wrapT` must stay clamped.

⚠️ **Vertex counts stopped being a proxy for "how much is visible."** A 2×1 slab
and a lone cube are both six quads now. Tests that compared `vertex_count` to
detect missing geometry compare the `positions` bytes instead — see
`test_obj_geometry_respects_mask`.

### `ChunkCache` (perf)

`obj_geometry_region` reads every block through `ChunkCache` (export.rs): a
single-entry `(cx,cy) → Option<addr>` memo collapsing the 7 `chunk_map` hash
lookups per voxel (self + 6 neighbors) to one compare on the common path. It
caches chunk **absence** too — the hot path on sparse worlds. It uses `Cell`, so
it is **`!Sync`** — single-threaded scans only, never hand it to rayon.

## Lighting & shadows (baked path) *(experimental)*

`LightMode { night, shadows, sun_t, lamp_radius, flat, profile }` is baked into
vertex colors inside `obj_geometry_region`. OBJ/JSON export and `ThreeDPreview`
always pass `LightMode::default()` (unchanged output, `profile` defaults to
`LightingProfile::Legacy`); only `get_chunk_geometry` opts in. Both multipliers
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
  `lamps_in_region` — O(nearby lamps), not O((16+2r)³) — so raising the radius
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
distance without changing which falloff curve is used — the profile picks the
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
Legacy/New Dawn toggle next to (but independent of) the Lamp R slider —
switching profile snaps Lamp R to that profile's default radius
(`App.tsx`'s `commitLightingProfile`), same "switch resets the fine-tune"
behavior in the Settings modal's Lighting profile row.

### Lamp spatial index (`WorldState.lamp_index`)

`LampIndex` wraps `LampIndexState { lamps: HashMap<(i32,i32), Vec<[i32;3]>>, scanned:
HashSet<(i32,i32)> }` (chunk-keyed). **On-demand, per-chunk** (2026-08
memory-efficiency pass — replaced a whole-world `build_lamp_index` scan on the
first night-lit request): `LampIndex::lamps_in_region`, called from
`get_chunk_geometry`/`get_lamps_near`, scans only the not-yet-`scanned` chunks a
given region query's neighbourhood touches, memoises, marks them scanned, then
gathers. Reset to empty on world load/close. Kept current by
`LampIndex::apply_delta(world, snaps)` in `with_edit_inner`/`undo_edit_inner`/
`redo_edit_inner` — a placed/removed lamp updates just its chunk's bucket from the
edit's own undo delta; a delta into an unscanned chunk is dropped (not fabricated
into a bucket), since the next real query re-derives it from truth.
`lamps_in_region(...)` gathers positions from chunks overlapping the region
expanded by `ceil(radius/16)` chunks (`region_chunk_box`), then filters to the
exact xy box. `build_lamp_index` (whole-world scan) is now `#[cfg(test)]`-only —
the parity oracle, no longer a production fallback.

### Shadows (directional sun raymarch)

Not vertical sky-occlusion — a real directional sun:
- `sun_direction(sun_t)` sweeps an arc: `sun_t` 0 = sunrise, 0.5 = noon, 1 = sunset;
  elevation eases 15°→80°→15°, azimuth 0→π east→west.
- `shadow_at` marches a 3D DDA (`dda_march`, **Amanatides–Woo** — visits every
  voxel the ray actually crosses, so a shallow dawn/dusk ray can't hop over a
  one-block-thick occluder) up to `SHADOW_RAY_STEPS = 24` world units toward the
  sun.
- Any occluding hit → hard two-tone `SUN_SHADOW = 0.55`, else `SUN_LIT = 1.0`. No
  soft falloff. Shadowed color is never pure black.

`dda_march` is a general-purpose voxel marcher (also used by `pick_block`).

## Three.js rendering (`FlyView3D.tsx`)

- **Coord mapping** `(wx,wy,wz) → (wx, wz, wy)` (see above).
- **Opaque material:** `MeshBasicMaterial` with `vertexColors` + `side:
  DoubleSide` — **unlit** (shading is in the vertex colors). No lights, no normals.
- **Transparent material:** second `MeshBasicMaterial`, `transparent: true,
  depthWrite: false`.
- Both get **textured variants** (`texMatRef`/`texMatTRef`) when a texture pack is
  loaded, sharing one `DataTexture` atlas (see [10 — Texture Packs](./10-features.md)).
- **Sky dome:** a large inverted-sphere gradient (`ShaderMaterial`, horizon
  `#c5d5eb` → zenith `#347ee3`, `fog: false`, `renderOrder: -1`) follows the
  camera.
- **Fog:** `scene.fog` is `FogExp2` (soft) or linear `Fog` (hard); distances from
  `fogDistances(radiusChunks)` (`far = max(20, radius*16*0.9)`, `near = far*0.3`)
  so fog fades at the edge of what's streamed. Color from an editor-only
  `fogColorOverride` (default MC-like light blue). Camera far plane (100000)
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
- **Hard resident-geometry byte cap (all three streams + in-flight fetches)**,
  `geometryBudgetBytes` prop (default `GEOMETRY_BUDGET_BYTES = 512 MB`, the "Balanced"
  memory-budget preset — App.tsx wires it from
  `MEMORY_PRESETS[memoryBudget].geometryBudgetBytes`; see CLAUDE.md's "Memory
  Budget" section): once crossed, streaming stops pulling new chunks until eviction
  frees headroom; a "render distance limited by memory" pill appears. Read via a
  ref (`geometryBudgetRef`) inside the scene-setup effect's `pump()` closure so a
  mid-session preset change takes effect without growing that effect's own
  dependency array.
  - Counted in **bytes, not vertices** (3D-pane crash fix): a vertex costs 24–36 B
    depending on stream and texture pack, and the old 30 M-vertex "Balanced" cap was
    ~1.9 GB of resident geometry — reachable within seconds on a 256z world, which is
    where the fly-view crashes came from. The number is the envelope's own `lens` sum
    (`VoxelGeometry.bytes`/`bytes_t`/`bytes_e`), stored on `mesh.userData.geomBytes`
    so `disposeMesh` subtracts exactly what was added.
  - **In-flight fetches reserve** an EWMA-estimated payload (`chunkEstimateBytes`,
    seeded 2 MB) so up to `maxConcurrent()` dense chunks landing together can't
    overshoot; the gate is re-tested per iteration inside `pump()`'s fill loop.
- **Camera z band** (`Z_BAND_ABOVE = 96`, `Z_BAND_STEP = 64`). `get_chunk_geometry`
  takes optional `zMin`/`zMax`; FlyView3D sends a `zMax` of
  `ceil((cameraEdenZ + 96) / 64) * 64`, or **omits it** when that already covers
  `world.max_z` (so every 64z world sends the pre-Stage-3 request unchanged). This
  attacks the 256z cost *at source*: a 16×16×256 chunk scan is 4× a 64z one and is
  paid in Rust before a single vertex exists, almost all of it walking empty air
  stacked above the terrain.
  - **One-sided (ceiling only), deliberately.** The original plan called for a
    symmetric ±96 band widening on look-down. A band with a *floor* hides terrain
    below the camera, and "fly up to survey the map" is a routine editor gesture —
    the landscape would vanish. Clipping only above has a bounded failure mode (a
    ceiling more than ~96–159 blocks overhead pops in as you climb toward it) and it
    is where the empty air actually is.
  - The **cutaway cap composes server-side**: `get_chunk_geometry` intersects the
    caller's band with `ws.view_cap_z` itself (both only ever narrow, so `min` is the
    whole composition). The frontend's job is invalidation only — the `viewCapZ` prop
    is a `reloadAllChunks()` trigger, nothing more. This closes the "Cutaway phase 2"
    item.
  - **Cache invalidation:** the band is not part of the chunk key. `streamSweep`
    recomputes it each tick and, when it moved, bumps `fetchGen` + disposes every
    resident mesh before sweeping — checked *before* the stationary-camera early-out,
    which compares chunk XY only and would miss a purely vertical climb. `Z_BAND_STEP`
    quantization is what keeps that full restream rare.
  - ⚠️ **The see-through-roof trap.** Face culling reads the *real* world, so the
    block just above `sz2` still occludes the top face of the topmost emitted one — a
    naive clip leaves a hole you look straight through into the terrain interior.
    `obj_geometry_region` therefore culls against **`gbz`**, `gb` clipped to
    `[sz1, sz2]`, so an out-of-band neighbour reads as air and the cap face emits.
    `shadow_at` deliberately keeps using the unclipped `gb`: the sun raymarch must
    still be blocked by terrain outside the band. Pinned by
    `test_obj_geometry_z_clip_emits_cap_faces` (a clipped render is byte-identical to
    a render of the truncated world) and `..._degenerate_bands`.
- **Suspend instead of unmount** (`suspended` prop). App mounts FlyView3D the first
  time the pane goes live and never unmounts it again (`mounted3dRef` latch in
  App.tsx); the ✕3D / quad-view toggles hide it (`display: none` on its cell wrapper,
  plus `display: none` on the whole quad grid when quad view is off) and suspend it.
  `setSuspended(true)` cancels the rAF loop, clears the sweep interval, bumps
  `fetchGen`, and disposes every resident chunk mesh, so a hidden pane holds a bare
  context and nothing else; `setSuspended(false)` re-measures the canvas (it read 0
  while hidden, so `resize()` had clamped the renderer to 1×1), restarts the sweep and
  restreams. `invalidate()` and `frame()` both bail while suspended, and the
  context-restore handler doesn't restart streaming into a hidden pane. Motivation:
  WKWebView caps simultaneously live WebGL contexts, and creating/destroying one per
  toggle is a plausible secondary contributor to the crash.
- **CPU copy released after GPU upload.** Each chunk attribute gets an
  `onUpload(function () { this.array = null })` hook (`releaseOnUpload`). The decoded
  streams are zero-copy *views* over the one IPC envelope (H2), which Three.js would
  otherwise keep alive alongside the GPU VBO — double-counting every resident chunk.
  Safe because chunk meshes are never raycast (picking is the Rust-side `pick_block`
  DDA), nothing sets `needsUpdate` on them, and `computeBoundingSphere()` has already
  run at install time so frustum culling keeps working off the cached sphere.
  ⚠️ It also makes the geometry **unrecoverable after a context loss** — the
  `webglcontextrestored` handler below *must* call `reloadAllChunks()`.
- **WebGL context loss/restore.** `webglcontextlost` → `preventDefault()` (without it
  the context is never restorable), cancel the rAF loop, park the sweep interval, set
  a `contextLost` flag that makes `frame()` bail, and toast via the `onNotice` prop
  (the `SliceViewport.onNotice` idiom — the pane's only other escape hatch is throwing,
  which the ErrorBoundary turns into a full-pane replacement). `webglcontextrestored`
  → restart the sweep, `reloadAllChunks()`, resume rendering.
- **Teardown releases the context only on a true unmount.** `forceContextLoss()` is
  wrong when the scene effect merely *re-runs* (world resize, StrictMode double-mount,
  HMR): the same `<canvas>` is reused and a dead context breaks the next
  `new WebGLRenderer`. On a real unmount React discards the canvas, so releasing is
  both safe and needed — WKWebView caps simultaneously live contexts, and repeated
  pane toggles used to strand one each. Detected by `unmountingRef`, set by a
  mount-only effect declared **above** the scene effect (React runs cleanups in
  effect-definition order), with a deferred `canvas.isConnected` re-check as the
  StrictMode guard.
- **Dev-only memory HUD** (`GeomMemHud`, bottom-right): resident chunk count, GPU
  bytes vs budget, JS-heap bytes still pinned, in-flight reservations, peak, and the
  largest single-chunk payload. Fed imperatively like `CoordHud`. Its Rust counterpart
  is a `[GEOM]` `timing_log!` line per `get_chunk_geometry` (debug builds only).
- Throttled sweep (`STREAM_MS = 150`) disposes chunks outside `(r+2)` **Euclidean**
  distance (matches the loading disc's `d2 <= r*r` test). Air-only chunks tracked
  in a `Set<string>`.
- **Adaptive concurrency:** `MAX_CONCURRENT_IDLE = 4` / `MAX_CONCURRENT_FLY = 2` —
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
lifetime, so cleanup uses `renderer.dispose()` **only — never
`forceContextLoss()`**: under `React.StrictMode` double-mount / HMR the effect
re-runs on the *same* canvas, and a lost context makes `new WebGLRenderer` crash
in `getShaderPrecisionFormat`. Init is wrapped in try/catch and rethrows to the
error boundary on failure.

## Camera modes

`CamMode = "orbit" | "fly" | "look"`, all routed through one `applyMode(next)`:

- **orbit** (default) — `OrbitControls`, `enableDamping`, cursor `grab`.
- **fly** — WASD walk + drag-to-look (left-button only). Never grabs pointer lock,
  so it works where the webview refuses it. Cursor `move`.
- **look** — WASD walk + free mouselook, cursor **grabbed + hidden app-wide**
  (Minecraft-style). ⚠️ Does **not** use the browser Pointer Lock API (WKWebView
  on macOS silently fails it). Instead it grabs the cursor at the **Tauri window
  level** via `set_cursor_lock(locked)` (→ `window.set_cursor_grab` +
  `set_cursor_visible`). tao's macOS `set_cursor_grab` calls
  `CGDisplay::associate_mouse_and_mouse_cursor_position(!grab)` — the cursor
  freezes but mouse *delta* events keep flowing, and `onMouseMove`'s
  `camMode==="look"` branch steers from `movementX/Y`. `setNativeCursorLock(bool)`
  is called on every look enter/leave, plus on blur and unmount — **never leave it
  grabbed**. The grab's first `movementX/Y` event is a large synthetic recentring
  delta from the OS cursor warp — `lookJustEngaged` (set on look-entry, consumed by
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

## Voxel picking (`pick_block`)

`pick_block(ox,oy,oz, dx,dy,dz, maxDist)` marches `dda_march` from a ray **in Eden
coords** and returns `PickResult { x,y,z, block_type, paint, nx,ny,nz }` — the
first non-air voxel plus the unit-normal face it entered through. `hit + normal` is
the empty voxel a placed block occupies. Ramps/wedges pick as full cubes;
non-solid blocks are pickable. Ray casting is in Rust, not `THREE.Raycaster`
(which would test every triangle of every loaded mesh) — the DDA visits ~50 voxels
and doesn't need the chunk streamed in.

- **Hover highlight:** one reused `LineSegments(EdgesGeometry(BoxGeometry))`,
  repicked at ~30 Hz. Previews the cell a left-click acts on: build → placement
  cell `hit + normal` (green); select → the hit voxel (blue).
- **Build controls:** **left-click breaks**, **right-click (contextmenu) places**
  at `hit + normal` (matches vanilla Minecraft L-break/R-place; place uses
  `contextmenu` to avoid button-2 unreliability). Edits go through `paint_blocks`
  → `with_edit`, so undo/redo + chunk-mesh reload are free.
- **Hold-to-repeat break/place:** holding the button past `BUILD_REPEAT_DELAY_MS`
  arms a `setInterval` (`BUILD_REPEAT_MS`) that re-picks and re-fires each tick,
  cancelling itself once the pointer drifts past click-slop (→ an orbit-drag took
  over) or the tool leaves build mode. `onPickDown` calls `stopBuildRepeat()`
  **before** arming — idempotent re-arm, so a missed release (pointer released
  off-canvas, focus loss) can never leave a stale interval running underneath a new
  one. Belt-and-suspenders: `canvas.setPointerCapture(e.pointerId)` on build-down
  guarantees the matching `pointerup` lands on this canvas even if released
  elsewhere, and a `pointercancel` listener (webview-issued, e.g. an OS gesture)
  also calls `stopBuildRepeat()`.
- **3D two-click selection:** two picked voxels reduce to `rawBounds` + zMin/zMax
  (a full 3D box), lighting up copy/paste/fill/extrude/gradient/prefab and the slab
  viewports. App owns the state machine (`pick3dFirst`, amber ghost, Escape).
- **Mode ownership:** `interact3d` derives from `mode3d` (`off|select|build`),
  owned by the contextual **3D ribbon tab** — *not* the map's Draw/Select tools.
  3D build has its own armed block (`build3dBlock`/`build3dPaint`).

### Select-mode transform gizmo (Axiom-style)

Hand-rolled (not THREE's `TransformControls` — its scale gizmo is center-symmetric).
Auto-shown whenever `interact3d==="select"` and a selection exists. Handles, all
`depthTest:false`/`renderOrder:1000` so they float over geometry:

- **Center move-cube** (light gray) — grab to slide the *whole box* on the ground
  plane (Eden x,y). 2-axis drag.
- **3 arrows** (R=x, G=up/height, B=Eden-y), each a **cone tip + scaling shaft**
  stemming from the center — single-axis whole-box move. The shaft is a unit-height
  cylinder scaled per-layout to reach from center to the cone base.
- **3 plane squares** (colored by their normal axis — ground=green, side=red/blue)
  — move the whole box **on that plane** (2 axes at once, incl. the two vertical
  planes the single arrows can't cover). 2-axis drag.
- **6 small face boxes** — resize a single face along its axis (the only resize
  handles).

**Move vs resize:** resize (face handles) is **always region-only**. Move (center +
arrows + planes) honours the shared **`moveWithContents`** toggle (App state, also the
Selection ribbon tab's *Move: Box/Contents* pill, mirrored into `moveWithContentsRef`
+ flipped by the in-pane ⇄ pill) — region-only, or relocate contents via the
undoable `move_selection` (`onGizmoMoveBlocks`). So 2D and 3D share one move mode.

**Drag math:** 1-axis handles build a camera-facing plane containing the axis and
project ray∩plane onto it (`gizmoDragAxisVec`/`gizmoDragAnchorProj`). 2-axis handles
(`gizmoDrag2d`) fix the plane by the handle's normal axis through the box center and
project onto both in-plane axes (`gizmoDrag2dAxisA/B`, referenced to the pointerdown
intersection so both deltas start at 0). All deltas round to whole voxels; the live
preview box is transformed (not rebuilt) per move. Escape/pointercancel abort with no
commit. *No rotation rings* — selection rotation has no backend yet.

## GPU shadow-map mode (H5) *(experimental, opt-in)*

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
- **Payoff:** `sunT` is *free* — the per-frame sun-follow repositions the light and
  its ortho shadow box; moving the sun is a light move, not a chunk rebuild. The
  `lightEpoch` reload effect early-outs to one repaint.
- **Emissive lamp stream** keeps lamps fullbright under the dim night ambient.
- **Patterned transparent shadows:** the transparent stream casts via a shared
  `customDepthMaterial` (`patchDepthAlpha`) that discards shadow-pass fragments
  with vertex alpha < 0.75 — water/glass/flower pass light, fence casts; with a
  texture pack a textured depth variant punches the fence-weave lattice.
- **GPU night point lights:** GPU + Night → real `THREE.PointLight`s at lamps
  (`MAX_NIGHT_LIGHTS = 16`), physical falloff with `distance = lampR*4` and a
  per-profile `decay`/`intensity` pair approximating the baked-path curve for
  that `LightingProfile` (see "Lighting profile" above): Legacy `decay = 2`,
  `intensity = lampR²·0.4`; Modern `decay = 1`, `intensity = lampR·0.4` — both
  solved so brightness at `lampR` ≈ K regardless of radius (the Lamp R slider
  grows reach, not just brightness). Re-queried on camera move, on enable, on
  `editEpoch`, and on profile switch.
- **Shadow quality:** ortho half-extent clamped to `min(reach,
  SHADOW_MAX_REACH=320)·1.1`; `mapSize` bumps to 4096 when `loadRadius > 16`;
  `sun.shadow.radius = 3`.
- **Sun disc** (`sunDisc`, a billboarded Sprite) + warm sunrise/sunset tinting of
  sun/disc/ambient by `warmth = 1 - sin(π·sunT)`.

Precedence: GPU+Night = GPU night point lights; GPU alone = day sun; Night alone
(no GPU) = baked night. Zero regression to the default path — everything is gated
on the flag.

### Edit sync (3D)

`editEpoch` + `lastEdit` reload chunk meshes overlapping the edit's top-down
bounds — expanded by `ceil(max(lampRadius, shadowRayScan)/16)` chunks when night
lighting or shadows are on (a placed lamp or new occluder affects the *next* chunk
over). GPU mode early-outs the `lightEpoch` reload to a single repaint.

## Quad view

Full-screen CSS-grid 2×2 (`paddingTop: 50`): top-left `MapCanvas`, top-right Front
slab, bottom-left Side slab, bottom-right the 3D pane (`FlyView3D`). Toggle:
View → Quad view (`showSlicePanels`). The 3D pane is separately opt-in
(`enable3dPane`) for performance. Panes are wrapped in `ErrorBoundary` so a
single-pane throw shows an inline fallback + Retry instead of blanking the app.

**Spawn (sparse worlds):** the camera starts over real geometry, not the bounding
box (often empty on sparse worlds). `spawnAt` = home/spawn point →
`center_px/center_py` centroid → undefined. The re-center effect keys on
`worldLoadToken` (App's `worldEpoch`), *not* `spawnAt`'s coords — so "Set Spawn
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
  leaf component with its own state — a moving camera re-renders only that `<div>`,
  not the pane.
- The ~3 fps `onCameraMove` callback bubbles to App state (`setCam3dPos`, draws the
  map's camera dot) and is throttled harder — it's the expensive one.
- Render-distance/fly-speed slider persistence is debounced 250 ms.
