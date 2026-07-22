# 03 — Blocks & Colors

> **Game-format reference.** The tables here are ported directly from the game
> source (`Globals.mm`, `Hud.mm`, `la-map`) and live in
> `src-tauri/src/colors.rs`. External ports can treat this as the canonical block
> registry and color palette.

## Block type IDs

Block type is a `u8`. IDs 0–111 are defined (`[[u8;3]; 112]` tables). Selected
mapping (see `colors.rs` `BLOCK_RGB` for the full list with hex):

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
| 19 | Cloud | | |

Named constants used by the editor: `LAMP_BLOCK_TYPE = 72` (TYPE_LIGHTBOX).

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

- **`BLOCK_RGB: [[u8;3]; 112]`** — unpainted block base colors (from
  `Globals.mm` `blockColor`). Zero entries are unused. All ramp/wedge variants of
  a family share the family's base color.
- **`PAINT_RGB: [[u8;3]; 55]`** — the paint palette (from `Hud.mm`
  `genColorTable`). **Index 0 = white sentinel** (means "unpainted"); indices
  1–54 are the game colors.
- **`BLOCK_PAINT_SCALE: [f32; 112]`** — per-block brightness multiplier (from
  `la-map`'s `max_lt`), applied when a block is painted.

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

### `BLOCK_INFO: [u32; 112]` — bitflags

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
