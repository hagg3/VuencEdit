# 03 — Blocks & Colors

> **Game-format reference.** The tables here are ported directly from the game
> source (`Globals.mm`, `Hud.mm`, `la-map`) and live in
> `packages/voxel-core/src/colors.rs` (re-exported as `crate::colors`, so every call site reads
> unchanged). External ports can treat this as the canonical block registry and color palette.
> The fluid-family helpers (`fluid_base`/`fluid_level`/`fluid_type_for`) sit beside them in
> `packages/voxel-core/src/blocks.rs`.

## Block type IDs

Block type is a `u8`. IDs 0–127 are defined (`[[u8;3]; 128]` tables) — 0–111
from the original game source, 112–127 from a 2026-08 game update (see
"New-format blocks (112–127)" below). Selected mapping (see `colors.rs`
`BLOCK_RGB` for the full list with hex):

| ID | Block | ID | Block |
|----|-------|----|-------|
| 0 | Air | 20 | Water |
| 1 | Bedrock/Adminium | 21 | Weave / Fence |
| 2 | Stone | 22 | Vine |
| 3 | Dirt | 23 | Lava |
| 4 | Sand | 24–27 | Stone Ramp S/W/N/E |
| 5 | Leaves | 28–31 | Wood Ramp S/W/N/E |
| 6 | Trunk | 32–35 | Shingle Ramp S/W/N/E |
| 7 | Wood | 36–39 | Ice Ramp S/W/N/E |
| 8 | Grass | 40–43 | Stone Wedge SE/SW/NW/NE |
| 9 | TNT | 44–47 | Wood Wedge SE/SW/NW/NE |
| 10 | Dark Stone | 48–51 | Shingle Wedge SE/SW/NW/NE |
| 11 | Grass2 / Weed | 52–55 | Ice Wedge SE/SW/NW/NE |
| 12 | Grass3 / Old Flower | 56 | Shingles |
| 13 | Brick | 57 | NeonSquare |
| 14 | Cobblestone / Slate | 58 | Glass |
| 15 | Ice | 59–61 | Water ¾ / ½ / ¼ |
| 16 | Crystal / Wallpaper | 72 | **Lamp** (lightbox) |
| 17 | Trampoline | 73 | NewFlower |
| 18 | Ladder | 82–110 | Expansion pack |
| 19 | Cloud | 112–127 | New-format (placeholder, see below) |

Named constants used by the editor: `LAMP_BLOCK_TYPE = 72` (TYPE_LIGHTBOX).

## New-format blocks (112–127)

A 2026-08 game update added **16 new block type IDs, 112–127**, filling the
type space to exactly 128 (the previous maximum was 111, `TYPE_BTSTEEL`). Found
in `TEST WORLDS/newblocks/`, a world written by the updated game — one of each
type, plus a second `127`, all unpainted, on grass at z=33. See
[02-file-format.md](02-file-format.md) for how such a world is detected
(`NewFormat256z`: a 256z-sized world whose `version` byte is *not* 5/6).

**Names are known** (reported in-game, 2026-09-15); **textures are not yet
supported.** The reference game source under `~/emod` is the 64z-era build and
stops at 111, so there is no atlas tile or exact hue to port for any of the 16.
Until texture support lands, each carries a single flat colour chosen to
approximate its in-game texture, and `BLOCK_PAINT_SCALE` is picked to suit the
material. The tables in `packages/voxel-core/src/colors.rs` are the single
source of truth — 2D map, 3D render and picker swatch all read them:

| Type | Name | Colour | Type | Name | Colour |
|------|------|--------|------|------|--------|
| 112 | Ore Sand | `#B05438` brick red | 120 | Moss | `#265224` darker green |
| 113 | Space Stone | `#564A58` dark grey-plum | 121 | Dark Matter | `#602C96` purple |
| 114 | Carpet | `#26B0BA` cyan | 122 | Space Sand | `#E0862E` orange |
| 115 | Snakeskin | `#7C481E` orangey dark brown | 123 | Snow | `#F0F6FA` snowy white |
| 116 | Obsidian | `#3A204A` dark purple | 124 | Moonrock | `#D6B4B2` light pink |
| 117 | Cheese | `#E8C236` yellow | 125 | Basalt | `#3E3E42` dark grey |
| 118 | Space Dirt | `#68482C` brown | 126 | Dark Tile | `#6E6E72` grey |
| 119 | Space Grass | `#2C7030` dark green | 127 | Algae | `#347658` darkish green |

`BLOCK_INFO` for all 16 is `0` — solid and occluding, the correct default for a
plain decorative cube, but wrong for whichever ID (if any) turns out to be a
sign or another non-solid special. It flips with one table entry once an ID is
identified. `BLOCK_FACE_TEX` (`texturepack.rs`) is `["", "", ""]` for all 16 —
no atlas row (the shipped game atlas has no free slots; a texture pack would
need a `KNOWN_TEX_NAMES` extension to carry these), so `face_tile` returns
`None` and the approximated `BLOCK_RGB` colour shows through unmodulated in the
3D pane exactly as it does in the flat 2D map.

Frontend mirror: `src/blockDefs.ts` `NEW_FORMAT_BLOCKS` / `isNewFormatBlock`,
displayed by name (`Ore Sand`, …) rather than the generic `Type N` fallback.
`BlockPaintPicker.tsx` shows them as an 8-wide swatch grid behind a disclosure
(not folded into one representative swatch the way ramp/expansion families are,
since the 16 are unrelated materials). They're also reachable in the Draw tab's
mask block-type dropdown.

**Deliberately left alone**, correct by default for a plain cube and only
worth revisiting once a specific ID's real identity is known: ramp/wedge
rotate-mirror tables (none of 112–127 participate — a directional block would
need new arms here), `transparent_alpha`, the grass special-case set, fluid
level helpers, `is_plantable` (new blocks currently count as plantable), and
the OBJ/GLB cube-vs-ramp export dispatch.

Signs from the same game update are a related, separately-tracked discovery —
see "Sign records and per-world sidecar files" in
[02-file-format.md](02-file-format.md). VuencEdit does not yet read or display
them.

## Ramp & wedge orientation

**4 families × 4 directions.**
- **Ramps** = IDs 24–39: family bases 24 (stone), 28 (wood), 32 (shingle),
  36 (ice); direction offset order **S, W, N, E** (0,1,2,3).
- **Wedges** = IDs 40–55: family bases 40 (stone), 44 (wood), 48 (shingle),
  52 (ice); apex direction order **SE, SW, NW, NE** (0,1,2,3).

Transform rules (implemented in `lib.rs` `rotate_ramp_id_cw`, `mirror_ramp_id_x/y`;
mirrored on the frontend in `blockDefs.ts` `rampFamilyBase`, `wedgeFamilyBase`):

| Op | Ramp | Wedge |
|----|------|-------|
| Rotate 90° CW | `(off + 3) & 3` | `(off + 3) & 3` |
| Mirror X | `1 ↔ 3` (W↔E) | `off ^ 1` |
| Mirror Y | `0 ↔ 2` (S↔N) | `off ^ 3` |

## Color system (`colors.rs`)

Three parallel tables, all indexed by block/paint ID:

- **`BLOCK_RGB: [[u8;3]; 128]`** — unpainted block base colors (0–111 from
  `Globals.mm` `blockColor`; 112–127 new-format placeholders, see above). Zero
  entries are unused. All ramp/wedge variants of a family share the family's
  base color.
- **`PAINT_RGB: [[u8;3]; 55]`** — the paint palette (from `Hud.mm`
  `genColorTable`). **Index 0 = white sentinel** (means "unpainted"); indices
  1–54 are the game colors.
- **`BLOCK_PAINT_SCALE: [f32; 128]`** — per-block brightness multiplier (0–111
  from `la-map`'s `max_lt`; 112–127 match their reused donor block), applied
  when a block is painted.

### `block_color(bt, paint, sky)`

The resolution rule:

```
if paint != 0:  PAINT_RGB[paint] * BLOCK_PAINT_SCALE[bt]
else:           BLOCK_RGB[bt]
grass (bt == 8) with paint == 0:  grass_color(sky)   // sky-dependent tint
```

So an unpainted block shows its natural color; a painted block shows the paint
color scaled by the block's brightness factor (a brick painted red ≠ ice painted
red — the substrate's brightness carries through). Grass is special-cased to a
sky-derived green when unpainted.

Helpers: `grass_color(sky)`, `transparent_alpha(bt)`.

### `BLOCK_INFO: [u32; 128]` — bitflags

Editor-relevant flags (the game defines more; the editor uses two):

| Flag | Bit | Meaning |
|------|-----|---------|
| `BI_NOTSOLID` | `0b0010` (bit 1) | non-solid (air, water, lava, glass, fence, ramps, wedges, flowers…) |
| `BI_RAMPORSIDE` | `0b1_0000` (bit 4) | ramp or wedge (has a diagonal face) |

`obj_occludes(bt)` uses `BLOCK_INFO` to decide whether a block fully hides a
neighbor's face during culling (see [06 — 3D Rendering](./06-rendering-3d.md)).

### Transparency (`transparent_alpha`)

Returns `Option<f32>` — `Some(alpha)` for see-through blocks, `None` for opaque:

| Blocks | Alpha |
|--------|-------|
| Water + variants (20, 59–61, 107) | 0.50 |
| Glass variants (58, 90) | 0.50 |
| Fence / weave (21, 106) | 0.90 (nearly opaque) |
| New flower (73) | 0.25 |

These are the blocks routed into the 3D **transparent vertex stream** and given
2D map alpha blending. (A separate per-block alpha table used for 2D map layering
distinguishes materials like dark stone 0.50 vs ice 0.90.)

## Frontend mirror & startup sync

The frontend has its own copies for the picker and 2D rendering
(`src/blockDefs.ts`): `BLOCK_DEFS`, `PAINT_COLORS`, ramp helpers,
`resolveColor(bt, paint)`. To avoid drift, **`applyBlockTables()` installs the
canonical Rust tables at startup** — the backend exposes `get_block_tables`
(command) / `get_block_tables()` (Rust) and the frontend overwrites its local
copies with them. Prefer this over hand-editing both sides.

`BlockPaintPicker.tsx` handles the picker UI for all of these: ramp/wedge
family×direction grids, doors/portals, expansion blocks, partial water/lava, and
special blocks. All ramp/wedge/expansion helpers come from `blockDefs.ts`
(`rampFamilyBase`, `wedgeFamilyBase`, `isExpansionBlock`, …).
