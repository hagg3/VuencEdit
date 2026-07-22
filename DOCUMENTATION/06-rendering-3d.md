# 06 — 3D Rendering

> **Port reference.** This is the intended reference for a web-based Eden World
> Builder renderer. `FlyView3D.tsx` (the streaming fly-through pane) plus
> `export.rs`'s geometry functions together form a complete voxel-to-mesh pipeline
> with face culling, directional shading, lamp lighting, sun shadows, texture
> atlasing, and voxel picking. The Rust side is pure and world-space; the
> Three.js side owns only camera, materials, and the coordinate permutation.

There are two 3D consumers:
- **`ThreeDPreview.tsx`** — on-demand render of a selection (≤ 64×64×64) in the
  Selection Inspector. Uses `get_obj_geometry`.
- **`FlyView3D.tsx`** — streaming fly-through of the whole world (quad-view 4th
  cell). Uses `get_chunk_geometry` per chunk.

Both build Three.js `BufferGeometry` from base64 f32 arrays produced by the shared
`obj_geometry_region` in `export.rs`.

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

### `ChunkCache` (perf)

`obj_geometry_region` reads every block through `ChunkCache` (export.rs): a
single-entry `(cx,cy) → Option<addr>` memo collapsing the 7 `chunk_map` hash
lookups per voxel (self + 6 neighbors) to one compare on the common path. It
caches chunk **absence** too — the hot path on sparse worlds. It uses `Cell`, so
it is **`!Sync`** — single-threaded scans only, never hand it to rayon.

## Lighting & shadows (baked path) *(experimental)*

`LightMode { night, shadows, sun_t, lamp_radius, flat }` is baked into vertex
colors inside `obj_geometry_region`. OBJ/JSON export and `ThreeDPreview` always
pass `LightMode::default()` (unchanged output); only `get_chunk_geometry` opts in.
Both multipliers are computed once per voxel and folded into the `push_tri!` /
`push_quad!` macros via an `lm` (light-multiplier) argument, so every face of a
block shares the same lighting.

### Night lighting

Mirrors the game's lamp-block point lighting (`Lighting.mm`, `Terrain.mm`
`calcLight`):
- Ambient drops to `NIGHT_AMBIENT = 0.35`.
- Each Lamp block (type 72) contributes `(1 - dist/radius) * lampColor` per channel
  to every block within `lamp_radius` (user-tunable; `<= 0` → legacy
  `LAMP_LIGHT_RADIUS = 5.0`), clamped to `[0.0, 1.5]`. **Lamp color is the lamp's
  paint color**, not a separate table.
- Lamps render fullbright.
- Lamps are gathered from the **lamp spatial index** (below) via
  `lamps_in_region` — O(nearby lamps), not O((16+2r)³) — so raising the radius
  isn't cubic. Empty slice → `light_at` returns fullbright.

### Lamp spatial index (`WorldState.lamp_index`)

`Option<HashMap<(i32,i32), Vec<[i32;3]>>>` (chunk-keyed). Lazily built
(`build_lamp_index`, scans only populated `chunk_map`) on the first night-lit
`get_chunk_geometry`/`get_lamps_near`; reset to `None` on world load/close. Kept
current by `refresh_lamp_index_chunks(ws, affected)` in
`with_edit`/`undo_edit`/`redo_edit` — a placed/removed lamp rescans just its
chunk's bucket. `lamps_in_region(...)` gathers positions from chunks overlapping
the region expanded by `ceil(radius/16)` chunks, then filters to the exact xy box.

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
  via an in-pane slider). The `<input type="range">` maps **1:1 to chunk radius**
  (`min=RD_MIN max=MAX_RENDER_DISTANCE step=1`, value = `loadRadius`) — one notch =
  one chunk. (The earlier quadratic `radiusToSliderPos`/`sliderPosToRadius` remap was
  dropped: it gave the low range more pixels but made the top half jump several chunks
  per pixel, e.g. 16→20 in one nudge, which read as "dodgy".)
- **`VERTEX_BUDGET = 30_000_000`** hard resident-vertex cap (opaque+transparent):
  once crossed, streaming stops pulling new chunks until eviction frees headroom;
  a "render distance limited by memory" pill appears.
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
  (`MAX_NIGHT_LIGHTS = 16`), physical falloff (`decay = 2`, `distance = lampR*4`,
  `intensity = lampR²·0.4` so brightness at `lampR` ≈ K regardless of radius — the
  Lamp R slider grows reach, not just brightness). Re-queried on camera move, on
  enable, and on `editEpoch`.
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
