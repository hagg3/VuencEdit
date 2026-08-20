# 08 — World Generation

> Partial **game-generator reference.** The Classic and Tg2 generators are ports
> of the game's own `TerrainGenerator.mm` and `TerrainGen2.mm`. See also the
> in-repo notes: [`NEW_WORLD.md`](../TEST%20WORLDS/NEW_WORLD.md) (user+dev guide)
> and [`TerrainGen2.md`](../TEST%20WORLDS/TerrainGen2.md) (Tg2 implementation
> reference against the original ObjC).

All generation lives in `src-tauri/src/worldgen.rs` (Perlin noise + the three
procedural generators + the `create_*`/`preview_*` commands). The **New World
dialog** (`NewWorldModal.tsx`) has four tabs, each backed by a command.

Every generator supports both height formats: **64z (Legacy)** and **256z (New
Dawn)** — see [02 — File Format](./02-file-format.md).

## Flat — `create_world`

Fixed-height world with configurable stone/dirt layers. The reference flat world
(per MROB): 1 bedrock + 15 stone + 16 dirt + 1 grass, buildable 31 blocks above.

## Natural (Procedural) — `create_natural_world` / `preview_natural_world`

A **whole-world pipeline** (not per-chunk), so trees, structures, and clouds span
chunk borders without grid artefacts.

- **Heightmap:** 6-octave `fbm2` + `ridged2` — domain-warped continents + ridged
  mountain peaks.
- **Erosion:** an `fbm2` field selectively *reduces* relief amplitude in
  high-erosion regions, creating Minecraft-style flat-plain / rugged-highland
  alternation.
- **Biomes:** `biome_at` assigns single or mixed biomes (Grassland / Desert /
  Snow / Lava / Classic+) by temperature + moisture + altitude, with per-column
  climate jitter (`BIOME_DITHER = 0.16`) to speckle edges.
- **Chunk fill:** `fill_chunk_terrain` lays bedrock + stone + caves + soft layer +
  surface. A shared `VoxelSink` trait is used by both the editor and the generator.
- **Decorate:** `WorldGen` does cross-chunk decorate + structures + clouds — trees,
  cacti, flowers, weeds flush with surface, boulders, structures (cabin / well /
  watchtower / ruins / pyramid), clouds.
- **Preview:** `preview_natural_world` returns a fast downsampled heightmap for the
  live modal preview.

## Classic — `create_classic_world`

A faithful port of the game's legacy `TerrainGenerator.mm`.

- **`ClassicNoise`** = seeded Ken-Perlin noise.
- **`classic_height`** = 10-octave.
- Caves via 3D noise + a "holey dirt skin" pass.
- ⚠️ **Flower sprite limit:** the game has a sprite-buffer crash if too many
  flowers spawn. Use `CLASSIC_FLOWER_SPARSITY = 64` (1-in-64 chance); the rest are
  weeds (block 11).
- Cross-chunk passes: `classic_decorate`, `classic_place_trees`,
  `place_classic_clouds`.

## Tg2 (TerrainGen2) — `create_tg2_world` / `preview_tg2_world`

A port of the Eden 2.0 `TerrainGen2.mm` (~2,917 lines ObjC).

- **`Tg2Grid`** = an intermediate flat workspace (`x*(gsize*t_height) +
  z*t_height + y`) so biome passes can read back already-placed blocks.
- **9 terrain types exposed in the New World modal:** Plains, Mars, RiverForest,
  Mtn+River, Desert, Ponies, Beach, Mix, Flat. A 10th backend value,
  `CustomMix` (`terrain_type` field, `worldgen.rs`), exists in the enum but
  isn't wired into any frontend UI — reserved/dead as far as the app goes.
- **`tg2_flush`** pushes the grid → `WorldGen`.
- **Vertical scaling:** `vs = t_height / 64`; `g.sv` / `relief` / `sea_level`
  helpers scale to the chosen height format.
- **Biome blend:** bidirectional `tg2_blend_seams` post-pass; zone seams use a
  smoothstep + noise-warped `tg2_make_transition`.
- **`ClassicNoise`** reused. Structures: pyramid / volcano / sky island. Paint
  cycles `tg2_cc`–`cc7`.
- Knobs: amplitude, sea level, height format — the preview reflects all three.

## Noise primitives

Shared in `worldgen.rs`: `fbm2` (fractal Brownian motion), `ridged2` (ridged
multifractal for mountains), and `ClassicNoise` (the seeded Ken-Perlin used by
Classic and Tg2). Natural sculpt noise (see [07](./07-editing-undo-clipboard.md))
reuses `fbm2`/`ridged2`.

## Frontend (`NewWorldModal.tsx`)

Modals block dismissal while generation runs (`closeOnEsc={!busy}` etc.); the
completion callback is gated on `mountedRef` so a still-live callback can't switch
worlds under the user after the modal is closed. The preview tabs (Natural, Tg2)
call the `preview_*` commands with a debounce.
