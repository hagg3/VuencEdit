//! Texture-pack *layout* — the atlas contract the 3D mesher reads.
//!
//! Loading a pack (unzipping, slicing an atlas image, building the grayscale variants) is app work
//! and stays there; what lives here is the part `geometry` cannot render without: which tile a
//! block's face uses, how a painted block picks the grayscale row instead of the colour one, and
//! the fact that the atlas is exactly one tile wide and `atlas_rows` tall.
//!
//! ⚠️ That one-tile width is load-bearing for greedy meshing: U may tile by repeating the column
//! (with `wrapS = RepeatWrapping` on the frontend), but V *selects the row*, so a merged quad may
//! never grow along V while a pack is loaded. See `geometry::obj_geometry_region`.
//!
//! Doors (66–70) and portals (75–79) are the only tiles not in the game's `atlas.png`: the loader
//! splits a user-supplied tall `door.png` / `portal.png` (height = 2 × width) into
//! `door_top`/`door_bottom` and `portal_top`/`portal_bottom` tiles. A door block draws a thin slab
//! with its half; a portal stays a stone cube whose *front* face (chosen by the mesher, see
//! `portal_front_tile`) wears the portal half. Without them: doors fall back to `wood`, portals to
//! `stone`.

use std::collections::HashMap;

pub const TILE: u32 = 32;

// [side_tex, bottom_tex, top_tex] per block type (index = block type, "" = no texture → flat-color fallback)
// Ported from blockTypeFaces in Globals.mm + TEX_* / TYPE_* from Constants.h.
// Face mapping: Globals face 0-3 = sides, face 4 = bottom, face 5 = top.
pub const BLOCK_FACE_TEX: [[&str; 3]; 128] = [
    ["", "", ""],                                   // 0  AIR
    ["bedrock", "bedrock", "bedrock"],               // 1  BEDROCK
    ["stone", "stone", "stone"],                    // 2  STONE
    ["dirt", "dirt", "dirt"],                       // 3  DIRT
    ["sand", "sand", "sand"],                       // 4  SAND
    ["leaves", "leaves", "leaves"],                 // 5  LEAVES
    ["tree_side", "tree_vert", "tree_vert"],        // 6  TRUNK
    ["wood", "wood", "wood"],                       // 7  WOOD
    ["grass_side", "dirt", "grass_top"],            // 8  GRASS
    ["tnt_side", "tnt_side", "tnt_top"],            // 9  TNT
    ["dark_stone", "dark_stone", "dark_stone"],     // 10 DARK_STONE
    ["grass_side", "dirt", "grass_top2"],           // 11 GRASS2
    ["grass_side", "dirt", "grass_flower"],         // 12 GRASS3 (flower patch top; `face_tile` falls back to grass_top)
    ["brick", "brick", "brick"],                    // 13 BRICK
    ["cobblestone", "cobblestone", "cobblestone"],  // 14 COBBLESTONE (Slate)
    ["ice", "ice", "ice"],                          // 15 ICE
    ["crystal", "crystal", "crystal"],              // 16 CRYSTAL (Wallpaper)
    ["trampoline", "trampoline", "trampoline"],     // 17 TRAMPOLINE
    ["ladder", "wood", "wood"],                     // 18 LADDER
    ["cloud", "cloud", "cloud"],                    // 19 CLOUD
    ["water", "water", "water"],                    // 20 WATER
    ["weave", "weave", "weave"],                    // 21 WEAVE (Fence)
    ["vine", "vine", "vine"],                       // 22 VINE
    ["lava", "lava", "lava"],                       // 23 LAVA
    // 24-27 STONE_RAMP*
    ["stone", "stone", "stone"],
    ["stone", "stone", "stone"],
    ["stone", "stone", "stone"],
    ["stone", "stone", "stone"],
    // 28-31 WOOD_RAMP*
    ["wood", "wood", "wood"],
    ["wood", "wood", "wood"],
    ["wood", "wood", "wood"],
    ["wood", "wood", "wood"],
    // 32-35 SHINGLE_RAMP*
    ["shingle", "shingle", "shingle"],
    ["shingle", "shingle", "shingle"],
    ["shingle", "shingle", "shingle"],
    ["shingle", "shingle", "shingle"],
    // 36-39 ICE_RAMP*
    ["ice", "ice", "ice"],
    ["ice", "ice", "ice"],
    ["ice", "ice", "ice"],
    ["ice", "ice", "ice"],
    // 40-43 STONE wedges
    ["stone", "stone", "stone"],
    ["stone", "stone", "stone"],
    ["stone", "stone", "stone"],
    ["stone", "stone", "stone"],
    // 44-47 WOOD wedges
    ["wood", "wood", "wood"],
    ["wood", "wood", "wood"],
    ["wood", "wood", "wood"],
    ["wood", "wood", "wood"],
    // 48-51 SHINGLE wedges
    ["shingle", "shingle", "shingle"],
    ["shingle", "shingle", "shingle"],
    ["shingle", "shingle", "shingle"],
    ["shingle", "shingle", "shingle"],
    // 52-55 ICE wedges
    ["ice", "ice", "ice"],
    ["ice", "ice", "ice"],
    ["ice", "ice", "ice"],
    ["ice", "ice", "ice"],
    ["shingle", "shingle", "shingle"],              // 56 SHINGLE
    ["gradient", "gradient", "gradient"],           // 57 GRADIENT (NeonSquare)
    ["glass", "glass", "glass"],                    // 58 GLASS
    ["water", "water", "water"],                    // 59 WATER3
    ["water", "water", "water"],                    // 60 WATER2
    ["water", "water", "water"],                    // 61 WATER1
    ["lava", "lava", "lava"],                       // 62 LAVA3
    ["lava", "lava", "lava"],                       // 63 LAVA2
    ["lava", "lava", "lava"],                       // 64 LAVA1
    ["firework", "firework", "tnt_top"],            // 65 FIREWORK
    ["door_bottom", "door_bottom", "door_bottom"],     // 66 DOOR1 — slab, lower half (`face_tile` falls back to wood)
    ["door_bottom", "door_bottom", "door_bottom"],     // 67 DOOR2
    ["door_bottom", "door_bottom", "door_bottom"],     // 68 DOOR3
    ["door_bottom", "door_bottom", "door_bottom"],     // 69 DOOR4
    ["door_top", "door_top", "door_top"],              // 70 DOOR_TOP
    ["cloud", "cloud", "cloud"],                    // 71 GOLDEN_CUBE
    ["lightbox", "lightbox", "lightbox"],           // 72 LIGHTBOX (Lamp)
    ["cloud", "cloud", "cloud"],                    // 73 FLOWER
    ["steel", "steel", "steel"],                    // 74 STEEL
    ["stone", "stone", "stone"],                    // 75 PORTAL1
    ["stone", "stone", "stone"],                    // 76 PORTAL2
    ["stone", "stone", "stone"],                    // 77 PORTAL3
    ["stone", "stone", "stone"],                    // 78 PORTAL4
    ["stone", "stone", "stone"],                    // 79 PORTAL_TOP
    ["", "", ""],                                   // 80 CUSTOM
    ["blocktnt", "blocktnt", "tnt_top"],            // 81 BLOCK_TNT
    // 82-111 BT* expansion blocks (side+bottom=blocktnt, top=respective material)
    ["blocktnt", "blocktnt", "grass_top"],          // 82 BTGRASS
    ["blocktnt", "blocktnt", "dark_stone"],         // 83 BTDARKSTONE
    ["blocktnt", "blocktnt", "stone"],              // 84 BTSTONE
    ["blocktnt", "blocktnt", "dirt"],               // 85 BTDIRT
    ["blocktnt", "blocktnt", "sand"],               // 86 BTSAND
    ["blocktnt", "blocktnt", "tnt_side"],           // 87 BTTNT
    ["blocktnt", "blocktnt", "wood"],               // 88 BTWOOD
    ["blocktnt", "blocktnt", "shingle"],            // 89 BTSHINGLE
    ["blocktnt", "blocktnt", "cloud"],              // 90 BTGLASS
    ["blocktnt", "blocktnt", "gradient"],           // 91 BTGRADIENT
    ["blocktnt", "blocktnt", "tree_side"],          // 92 BTTREE
    ["blocktnt", "blocktnt", "leaves"],             // 93 BTLEAVES
    ["blocktnt", "blocktnt", "brick"],              // 94 BTBRICK
    ["blocktnt", "blocktnt", "cobblestone"],        // 95 BTCOBBLESTONE
    ["blocktnt", "blocktnt", "vine"],               // 96 BTVINES
    ["blocktnt", "blocktnt", "ladder"],             // 97 BTLADDER
    ["blocktnt", "blocktnt", "ice"],                // 98 BTICE
    ["blocktnt", "blocktnt", "crystal"],            // 99 BTCRYSTAL
    ["blocktnt", "blocktnt", "trampoline"],         // 100 BTTRAMPOLINE
    ["blocktnt", "blocktnt", "cloud"],              // 101 BTCLOUD
    ["blocktnt", "blocktnt", "stone"],              // 102 BTSTONESIDE
    ["blocktnt", "blocktnt", "wood"],               // 103 BTWOODSIDE
    ["blocktnt", "blocktnt", "ice"],                // 104 BTICESIDE
    ["blocktnt", "blocktnt", "shingle"],            // 105 BTSHINGLESIDE
    ["blocktnt", "blocktnt", "cloud"],              // 106 BTFENCE
    ["blocktnt", "blocktnt", "dirt"],               // 107 BTWATER
    ["blocktnt", "blocktnt", "dirt"],               // 108 BTLAVA
    ["blocktnt", "blocktnt", "firework"],           // 109 BTFIREWORK
    ["blocktnt", "blocktnt", "lightbox"],           // 110 BTLIGHTBOX
    ["blocktnt", "blocktnt", "steel"],              // 111 BTSTEEL
    // 112–127: new-format blocks — tiles 32–47 of the Emod 64-tile atlas.png (the 2026 game's art).
    // A pack without them (a stock 32-tile atlas) ⇒ `face_tile` returns None ⇒ atlas row 0 (white
    // sentinel), so the approximated BLOCK_RGB colour shows through unmodulated, as before.
    ["ore_sand", "ore_sand", "ore_sand"],           // 112 Ore Sand
    ["space_stone", "space_stone", "space_stone"],  // 113 Space Stone
    ["carpet", "carpet", "carpet"],                 // 114 Carpet
    ["snakeskin", "snakeskin", "snakeskin"],        // 115 Snakeskin
    ["obsidian", "obsidian", "obsidian"],           // 116 Obsidian
    ["cheese", "cheese", "cheese"],                 // 117 Cheese
    ["space_dirt", "space_dirt", "space_dirt"],     // 118 Space Dirt
    ["space_grass", "space_grass", "space_grass"],  // 119 Space Grass
    ["moss", "moss", "moss"],                       // 120 Moss
    ["dark_matter", "dark_matter", "dark_matter"],  // 121 Dark Matter
    ["space_sand", "space_sand", "space_sand"],     // 122 Space Sand
    ["snow", "snow", "snow"],                       // 123 Snow
    ["moonrock", "moonrock", "moonrock"],           // 124 Moonrock
    ["basalt", "basalt", "basalt"],                 // 125 Basalt
    ["dark_tile", "dark_tile", "dark_tile"],        // 126 Dark Tile
    ["algae", "algae", "algae"],                    // 127 Algae
];

pub struct TexturePack {
    pub tile: u32,
    /// RGBA bytes, width = tile, height = tile * atlas_rows. Layout:
    ///   row 0                       = blank white sentinel (pass-through),
    ///   rows 1..=N                  = full-color tiles (as authored) — used for the natural,
    ///                                 *unpainted* look (vertex_color × texture ≈ block base),
    ///   rows N+1..=2N               = grayscale modulation variants of the same tiles, used for
    ///                                 *painted* blocks (paint_color × grayscale), mirroring the
    ///                                 game's two-atlas scheme (TEX_BRICK_COLOR vs TEX_BRICK).
    /// The grayscale row for a color row R is `R + gray_row_offset`.
    pub atlas_rgba: Vec<u8>,
    pub atlas_rows: u32,
    /// Number of color tiles N; add to a color row index to get its grayscale row.
    pub gray_row_offset: u32,
    pub name_to_row: HashMap<String, u32>,
}

/// Returns the atlas row for a given block face, or None when no tile is in the pack.
/// face_kind: 0=side, 1=bottom, 2=top.
pub fn face_tile(pack: &TexturePack, bt: u8, face_kind: u8) -> Option<u32> {
    if (bt as usize) >= BLOCK_FACE_TEX.len() { return None; }
    let tex_name = BLOCK_FACE_TEX[bt as usize][face_kind as usize];
    if tex_name.is_empty() { return None; }
    let row = pack.name_to_row.get(tex_name).copied();
    if row.is_some() { return row; }
    // Fallbacks for tiles a stock atlas lacks: block 12 keeps its plain grass top, a door slab
    // draws in `wood` (its pre-27.2c look).
    let fallback = match tex_name {
        "grass_flower" => "grass_top",
        "door_top" | "door_bottom" => "wood",
        _ => return None,
    };
    pack.name_to_row.get(fallback).copied()
}

/// The atlas row of a portal's front-face art (`portal_bottom` for 75–78, `portal_top` for 79), or
/// None when the pack has no portal tiles — the front then stays an ordinary stone face. The mesher
/// picks *which* face is the front (it depends on the block's facing, which `face_tile` can't see).
pub fn portal_front_tile(pack: &TexturePack, bt: u8) -> Option<u32> {
    let name = match bt { 75..=78 => "portal_bottom", 79 => "portal_top", _ => return None };
    pack.name_to_row.get(name).copied()
}

/// `(vertex_rgb, atlas_row)` for a portal's front face: the portal tile, grayscale × paint when
/// painted, untinted (white) when not — the tile is finished art. None without portal tiles.
pub fn portal_front_color_and_row(pack: &TexturePack, bt: u8, paint: u8, fallback_rgb: [u8; 3]) -> Option<([u8; 3], u32)> {
    let r = portal_front_tile(pack, bt)?;
    Some(if paint != 0 { (fallback_rgb, r + pack.gray_row_offset) } else { ([255, 255, 255], r) })
}

/// Returns (vertex_rgb, atlas_row_opt) for a face. The vertex rgb is always the block's
/// computed colour (`block_color`) — the paint tint for painted blocks, or the natural block
/// colour otherwise.
///
/// The texture row depends on paint state, mirroring the game's two-atlas scheme:
///   - **unpainted** (`paint == 0`) → the full-color tile: `block_color × full_color ≈ natural`
///     (blocks 112–127: white × full_color, since their tiles are the finished colour art).
///   - **painted** (`paint != 0`)  → the grayscale variant (`row + gray_row_offset`) so that
///     `paint_color × grayscale` produces a clean tint instead of double-tinting a full-color
///     tile (which reads washed-out / oversaturated). The game does exactly this — e.g.
///     `TEX_BRICK` (grayscale) is modulated by the paint colour while `TEX_BRICK_COLOR`
///     (full-color) is only used for the natural, unpainted look.
pub fn face_color_and_row(
    pack: &TexturePack,
    bt: u8,
    paint: u8,
    face_kind: u8,
    fallback_rgb: [u8; 3],
) -> ([u8; 3], Option<u32>) {
    let row = match face_tile(pack, bt, face_kind) {
        Some(r) if paint != 0 => Some(r + pack.gray_row_offset),
        other => other,
    };
    // 112–127's colour tiles (and a door's, when the pack actually has one) are the game's finished
    // art (its unpainted look), not a base the block colour modulates — the approximated BLOCK_RGB
    // would double-tint them. Draw them white.
    if paint == 0 && row.is_some() && tile_is_finished_art(pack, bt) {
        return ([255, 255, 255], row);
    }
    (fallback_rgb, row)
}

/// Blocks whose atlas tile already carries its colour (see `face_color_and_row`): 112–127, and the
/// door slabs 66–70 *when the pack supplies `door_*`* — a `wood` fallback is a base tile the block
/// colour modulates, so it keeps today's tint. (Portal fronts go through `portal_front_color_and_row`.)
pub fn tile_is_finished_art(pack: &TexturePack, bt: u8) -> bool {
    match bt {
        112..=127 => true,
        66..=69 => pack.name_to_row.contains_key("door_bottom"),
        70 => pack.name_to_row.contains_key("door_top"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(names: &[&str]) -> TexturePack {
        let n = names.len() as u32;
        TexturePack {
            tile: 1,
            atlas_rgba: vec![255; (2 * n as usize + 1) * 4],
            atlas_rows: 2 * n + 1,
            gray_row_offset: n,
            name_to_row: names.iter().enumerate().map(|(i, s)| (s.to_string(), i as u32 + 1)).collect(),
        }
    }

    #[test]
    fn doors_fall_back_to_wood_and_portals_to_nothing() {
        let stock = pack(&["wood", "stone"]);
        for bt in 66..=70 { assert_eq!(face_tile(&stock, bt, 0), Some(1), "door {bt} → wood"); }
        assert_eq!(portal_front_tile(&stock, 75), None, "no portal art ⇒ the front stays stone");
        assert_eq!(portal_front_color_and_row(&stock, 79, 0, [1, 2, 3]), None);

        let full = pack(&["wood", "door_bottom", "door_top", "portal_bottom", "portal_top"]);
        assert_eq!(face_tile(&full, 66, 0), Some(2));
        assert_eq!(face_tile(&full, 70, 2), Some(3));
        assert_eq!(portal_front_tile(&full, 78), Some(4));
        assert_eq!(portal_front_tile(&full, 79), Some(5));
        assert_eq!(portal_front_tile(&full, 74), None);
        // A portal's cube faces stay stone in BLOCK_FACE_TEX; only the mesher-picked front differs.
        assert_eq!(BLOCK_FACE_TEX[75], ["stone", "stone", "stone"]);
    }

    #[test]
    fn finished_art_needs_the_tile_to_have_actually_resolved() {
        let stock = pack(&["wood"]);
        let full = pack(&["wood", "door_bottom", "door_top"]);
        assert!(tile_is_finished_art(&stock, 117) && tile_is_finished_art(&full, 112));
        assert!(!tile_is_finished_art(&stock, 66) && !tile_is_finished_art(&stock, 70), "a wood fallback keeps its tint");
        assert!(tile_is_finished_art(&full, 66) && tile_is_finished_art(&full, 69) && tile_is_finished_art(&full, 70));
        assert!(!tile_is_finished_art(&full, 7) && !tile_is_finished_art(&full, 75));

        // Unpainted: white + colour tile; painted: block colour + grayscale tile. Stock: wood, tinted.
        assert_eq!(face_color_and_row(&full, 66, 0, 0, [9, 9, 9]), ([255, 255, 255], Some(2)));
        assert_eq!(face_color_and_row(&full, 66, 4, 0, [9, 9, 9]), ([9, 9, 9], Some(2 + full.gray_row_offset)));
        assert_eq!(face_color_and_row(&stock, 66, 0, 0, [9, 9, 9]), ([9, 9, 9], Some(1)));
    }

    #[test]
    fn portal_front_is_white_unpainted_and_gray_times_paint_painted() {
        let p = pack(&["portal_bottom", "portal_top"]);
        assert_eq!(portal_front_color_and_row(&p, 76, 0, [5, 6, 7]), Some(([255, 255, 255], 1)));
        assert_eq!(portal_front_color_and_row(&p, 76, 3, [5, 6, 7]), Some(([5, 6, 7], 1 + p.gray_row_offset)));
    }
}
