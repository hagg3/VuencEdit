# New World — terrain generation guide

The **File ▸ New World…** dialog (`src/NewWorldModal.tsx`) creates a fresh `.eden`
world from scratch. It has three terrain tabs — **Flat**, **Natural**, and
**Classic** — each backed by a Rust command in `src-tauri/src/lib.rs`.

| Tab | Command | What it makes |
|-----|---------|---------------|
| Flat | `create_world` | Perfectly flat layered world (bedrock → stone → dirt → grass) |
| Natural | `create_natural_world` | Modern procedural world (biomes, water, mountains, structures) |
| Classic | `create_classic_world` | Faithful port of the original randomly-generated Eden terrain |

---

## Shared options (all tabs)

| Option | Notes |
|--------|-------|
| **World name** | Up to 35 characters. |
| **Size** | Width × Height in **chunks** (1–64 each). 1 chunk = 16 blocks, so an 8×8 world is 128×128 blocks. The dialog shows the block dimensions and an estimated file size. |
| **Height format** | **Legacy 64z** — z 0–63, 32 KB chunks. **New Dawn 256z** — z 0–255, 128 KB chunks. Switching format re-clamps height-sensitive sliders. |

> **Height format & the file header.** The world-file `version` byte encodes the
> column format the game expects: **64z = 4, 256z = 2** (this is *not* a monotonic
> version number). `write_world_file` sets it automatically from the chunk size.
> If a 256z world is written with the 64z version the game misreads it as 64z and
> the terrain looks scrambled — see `CLAUDE.md` → *File Format*.

---

## Flat

The simplest world: every column is identical.

| Control | Range (64z / 256z) | Meaning |
|---------|--------------------|---------|
| **Stone depth** | 0–40 / 0–100 | Stone layers above bedrock. |
| **Dirt depth** | 0–20 / 0–60 | Dirt layers above the stone. |

Layout per column: `z0` bedrock → stone → dirt → **grass** at the surface, then
empty build space up to the top. Surface z = `1 + stone + dirt` and must not
exceed the format's max z (the dialog blocks invalid combinations and previews
the layer stack).

---

## Natural (Procedural)

A modern, whole-world generator (`generate_natural_world`) — trees, structures and
clouds span chunk borders without grid artifacts. Marked **experimental**.

| Option | Choices | Notes |
|--------|---------|-------|
| **Seed** | any number (🎲 random) | Deterministic — same seed ⇒ same world. |
| **Base height** | 5 – 55 / 5 – 200 | Average sea-level/ground height. |
| **Terrain roughness** | Plains → Rolling → Hilly → Rugged → Jagged | Relief amplitude. |
| **Feature scale** | Small → Medium → Large → Huge | Wavelength of continents & ranges. |
| **Extreme mountains** | toggle (**256z only**) | Towering peaks & deep valleys using the full height. Reset when leaving 256z. |
| **Water** | None / Ponds / Lakes / Ocean | Standing-water level relative to base height. |
| **Rivers** | toggle | Carves winding river channels. |
| **Biome** | Grassland / Desert / Snow / Lava | Surface material & palette. |
| **Snow-capped peaks** | toggle (grassland only) | Alpine snow above the snowline. |
| **Tree density** | None / Sparse / Normal / Dense | Deciduous + pine trees, cacti in desert. |
| **Caves** | None / Rare / Common | Twin-perlin spaghetti tunnels. |
| **Caverns** | toggle | Large open caverns + deep lava pools. |
| **Minerals** | None / Sparse / Rich | Veins of dark stone, slate & glowing crystal. |
| **Vegetation** | None / Light / Lush | Flowers, tall grass, boulders, lily pads. |
| **Structures** | None / Sparse / Common | Cabins, wells, watchtowers, ruins, desert pyramids. |
| **Clouds** | toggle | Cloud layer near the top. |

Implementation details (heightmap, biome surface selection, structure placement,
the `WorldGen`/`VoxelSink` writer) live in `CLAUDE.md` → *New World Modal ▸ Natural
generation*.

---

## Classic

A faithful port of the **original randomly-generated Eden terrain** from the
earliest builds (the procedural code still exists, commented-out, in
`~/EdenWorldBuilder/Classes/TerrainGenerator.mm`; the shipped game later replaced
it with a static template). Rolling Perlin hills, a bumpy dirt/grass surface with
overhangs, trees, weeds, and clouds.

| Option | Choices / default | Meaning |
|--------|-------------------|---------|
| **Seed** | any number (🎲 random) | Deterministic per seed. |
| **Terrain variance** | Plains / Rolling / **Classic** / Rugged / Wild | Heightmap drama (`var` = 1 / 2 / 3 / 4.5 / 6). "Classic" is the legacy default. |
| **Base height** | 5 – 55 / 5 – 200 (default 32) | Heightmap baseline (`offsety`). |
| **Underground caves** | toggle (default on) | Original ~50 %-air 3D-noise caverns with dark-stone veins, deep underground. |
| → **Tall caves** | toggle (default off) | The *same* stone/dark-stone caves, but a higher cave band and vertically-stretched (taller) chambers — an even older Eden cave style. Only shown when caves are on. |
| **Tree density** | None / Sparse / **Normal** / Dense | Legacy `placeTree` (1-in-80 / 50 / 25 grass columns). Trees grow only on grass or weeds. |
| **Scatter flowers (sparse)** | toggle (default on) | Sprinkles a *few* flowers across the grass. **Kept sparse on purpose** (see below). |
| **Clouds** | toggle (default on) | Legacy flat cloud blobs near the top. |

The surface is a grass/weeds mix (~40 % tall grass, capped below 50 %) — the
classic look.

### ⚠️ Why flowers are forced sparse

The current Eden game **crashes on load** if a world contains too many flower
sprites (block 73). The legacy generator carpeted ~25 % of the surface in flowers,
which reliably crashes the modern loader. The Classic tab therefore scatters
flowers on only ~1-in-64 grass cells (`CLASSIC_FLOWER_SPARSITY` in `lib.rs`).
Tall grass / weeds (block 11) are a solid grass variant and are *not* affected, so
they keep their full legacy density.

### How it works (developer notes)

`generate_classic_world` is a whole-world pipeline:

1. **`ClassicNoise`** — a seeded port of the legacy Ken-Perlin `noise2`/`noise3`
   (gradient tables filled from `Rng64`, so output is deterministic per seed).
2. **`classic_height`** — the legacy 10-octave heightmap; baseline and amplitude
   scale by `t_height/64` so the original 64z relief fills 256z worlds.
3. **`fill_classic_chunk`** — per-column bedrock / stone / caves / holey dirt
   surface skin. Caves carve air along `n3 ≤ 0` with dark-stone where `n3 ≤ 0.01`;
   **tall caves** raise the cave band and stretch it vertically (`y_scale 0.5`).
4. **Cross-chunk pass** (`WorldGen`): `classic_decorate` (exposed dirt → grass 8 /
   weeds 11 mix + sparse flower 73), `classic_place_trees` (legacy canopy), and
   `place_classic_clouds`.

Block IDs are identical between the 2010 engine and this editor, so no remapping
is needed. Full notes and the regression tests are in `CLAUDE.md` → *New World
Modal ▸ Classic generation*.

---

## Tips

- **Determinism:** re-using a seed reproduces the exact same world (per tab).
- **Reproducibility across formats:** switching 64z ⇄ 256z changes the vertical
  envelope, so the same seed yields a similar-but-not-identical world.
- **Performance:** large worlds (e.g. 64×64) take longer to generate and produce
  big files (≈ 32 KB/column at 64z, ≈ 128 KB/column at 256z); the dialog shows the
  estimate before you commit.
- **If a generated world won't load in the game:** check the height format matches
  what you intend, and (for developers) confirm the header `version` byte — see the
  File Format note above.
