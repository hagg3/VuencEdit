# New World — terrain generation guide

**File ▸ New World…** (`src/NewWorldModal.tsx`) creates a fresh `.eden` world.
Three tabs, each backed by a Rust command in `src-tauri/src/lib.rs`:

| Tab | Command | Makes |
|-----|---------|-------|
| Flat | `create_world` | Flat layered world (bedrock → stone → dirt → grass) |
| Natural | `create_natural_world` | Procedural world (biomes, water, mountains, structures) |
| Classic | `create_classic_world` | Faithful port of the original Eden terrain |

## Shared options

| Option | Notes |
|--------|-------|
| **World name** | ≤ 35 characters. |
| **Size** | Width × Height in **chunks**, 1–128 each (1 chunk = 16 blocks; max 128×128 = 2048²). Shows block dims + estimated file size; warns above ~256 MB / ~1 GB — generation holds the whole world in RAM. |
| **Height format** | **Legacy 64z** (z 0–63, 32 KB chunks) or **New Dawn 256z** (z 0–255, 128 KB chunks). Switching re-clamps height-sensitive sliders. |

> The file-header `version` byte encodes the column format (**64z = 4, 256z = 2** —
> *not* a version number); `write_world_file` sets it from the chunk size. A
> mismatch makes the game misread the terrain — see `CLAUDE.md` → *File Format*.

## Flat

Every column identical: `z0` bedrock → stone → dirt → **grass**, then build space.
Surface z = `1 + stone + dirt` (must be ≤ max z; the dialog blocks invalid combos
and previews the stack).

| Control | Range (64z / 256z) | Meaning |
|---------|--------------------|---------|
| **Stone depth** | 0–40 / 0–100 | Stone above bedrock. |
| **Dirt depth** | 0–20 / 0–60 | Dirt above stone. |

## Natural (Procedural)

Whole-world generator (`generate_natural_world`) — trees/structures/clouds cross
chunk borders without grid artifacts. **Experimental.**

| Option | Choices | Notes |
|--------|---------|-------|
| **Seed** | number (🎲) | Deterministic. |
| **Base height** | 5–55 / 5–200 | Average ground/sea level. |
| **Terrain roughness** | Plains → Jagged | Relief amplitude. |
| **Feature scale** | Small → Huge | Continent/range wavelength. |
| **Extreme mountains** | toggle (**256z only**) | Towering peaks using the full height; reset when leaving 256z. |
| **Water** | None / Ponds / Lakes / Ocean | Standing-water level vs base height. |
| **Rivers** | toggle | Carves winding channels. |
| **Biome mode** | Single / **Mixed** | **Mixed** blends Grassland/Desert/Snow per-column by temperature + moisture (+ altitude → snowy peaks) over one continuous heightmap, so no border cliffs. |
| → **Biome** (single) | Grassland / Desert / Snow / Lava / **Classic+** | Surface & palette. **Snow** uses a cold palette (white weeds, frosted leaves, white/blue flowers). **Classic+** is the legacy hill terrain & caves (with bare-stone outcrops) run through the modern pipeline, so it gains rivers, lakes/ocean, structures & natural trees the plain **Classic** tab lacks. **Lava & Classic+ are single-mode only.** |
| → **Biome size** (mixed) | Small / Medium / Large | Climate-region wavelength. |
| **Snow-capped peaks** | toggle (single grassland) | Alpine snow above the snowline. |
| **Tree density** | None → Dense | Deciduous + pine, cacti in desert. |
| **Caves** | None / Rare / Common | Underground carving. |
| → **Cave style** | Tunnels / Classic | Spaghetti tubes vs legacy 3D-noise caverns with dark-stone veins. |
| **Caverns** | toggle | Large open caverns + deep lava. |
| **Minerals** | None / Sparse / Rich | Dark-stone, slate & glowing-crystal veins. |
| **Vegetation** | None / Light / Lush | Flowers, tall grass, boulders. |
| **Structures** | None / Sparse / Common | Cabins, wells, watchtowers, ruins, pyramids. |
| **Clouds** | toggle | Cloud layer near the top. |
| **Preview terrain** | button | Fast top-down preview (heightmap, biomes, water, cliff rock; trees/structures not shown). |

Steep slopes auto-expose bare stone (cliff faces), so jagged and Classic+ terrain
reads as rock on its steepest faces. Implementation: `CLAUDE.md` → *New World Modal*.

## Classic

Faithful port of the **original randomly-generated Eden terrain** (procedural code
commented-out in `~/EdenWorldBuilder/Classes/TerrainGenerator.mm`; the shipped game
replaced it with a static template). Rolling Perlin hills, a bumpy dirt/grass
surface with overhangs (a ~40% grass/weeds mix), trees, weeds and clouds.

| Option | Choices / default | Meaning |
|--------|-------------------|---------|
| **Seed** | number (🎲) | Deterministic. |
| **Terrain variance** | Plains / Rolling / **Classic** / Rugged / Wild | Relief drama (`var` 1 / 2 / 3 / 4.5 / 6). |
| **Base height** | 5–55 / 5–200 (def 32) | Heightmap baseline. |
| **Underground caves** | toggle (on) | ~50%-air 3D-noise caverns with dark-stone veins. |
| → **Tall caves** | toggle (off) | Same caves, higher band + taller chambers. |
| **Tree density** | None / Sparse / **Normal** / Dense | Legacy `placeTree` (1-in-80/50/25); grass/weeds only. |
| **Scatter flowers (sparse)** | toggle (on) | A *few* flowers — kept sparse on purpose (below). |
| **Clouds** | toggle (on) | Legacy cloud blobs near the top. |

**⚠️ Why flowers are forced sparse.** The current game **crashes on load** with too
many flower sprites (block 73); the legacy ~25% carpet reliably triggers it. The
tab scatters flowers on only ~1-in-64 grass cells (`CLASSIC_FLOWER_SPARSITY`).
Weeds (11, a solid grass variant) are unaffected. Dev notes & tests:
`CLAUDE.md` → *Classic generation*.

## Tips

- **Determinism:** a seed reproduces the same world per tab; switching 64z ⇄ 256z
  changes the vertical envelope (similar but not identical).
- **Performance:** large worlds (up to 128×128) are slow and held in RAM while
  generating, so big 256z worlds are memory-heavy — the dialog shows an estimate +
  warning, and a live progress bar reports each phase.
- **Won't load in-game?** Check the height format; (devs) confirm the header
  `version` byte (above).
