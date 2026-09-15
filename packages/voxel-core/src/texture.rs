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
    ["grass_side", "dirt", "grass_top"],            // 12 GRASS3
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
    ["wood", "wood", "wood"],                       // 66 DOOR1
    ["wood", "wood", "wood"],                       // 67 DOOR2
    ["wood", "wood", "wood"],                       // 68 DOOR3
    ["wood", "wood", "wood"],                       // 69 DOOR4
    ["wood", "wood", "wood"],                       // 70 DOOR_TOP
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
    // 112–127: new-format blocks — no atlas row (shipped game atlas has no free slots; a texture
    // pack would need a `KNOWN_TEX_NAMES` extension to carry these). Empty string ⇒ `face_tile`
    // returns None ⇒ falls back to atlas row 0 (white sentinel), so the approximated BLOCK_RGB
    // colour above shows through unmodulated.
    ["", "", ""],                                   // 112 Ore Sand (no texture yet)
    ["", "", ""],                                   // 113 Space Stone (no texture yet)
    ["", "", ""],                                   // 114 Carpet (no texture yet)
    ["", "", ""],                                   // 115 Snakeskin (no texture yet)
    ["", "", ""],                                   // 116 Obsidian (no texture yet)
    ["", "", ""],                                   // 117 Cheese (no texture yet)
    ["", "", ""],                                   // 118 Space Dirt (no texture yet)
    ["", "", ""],                                   // 119 Space Grass (no texture yet)
    ["", "", ""],                                   // 120 Moss (no texture yet)
    ["", "", ""],                                   // 121 Dark Matter (no texture yet)
    ["", "", ""],                                   // 122 Space Sand (no texture yet)
    ["", "", ""],                                   // 123 Snow (no texture yet)
    ["", "", ""],                                   // 124 Moonrock (no texture yet)
    ["", "", ""],                                   // 125 Basalt (no texture yet)
    ["", "", ""],                                   // 126 Dark Tile (no texture yet)
    ["", "", ""],                                   // 127 Algae (no texture yet)
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
    pack.name_to_row.get(tex_name).copied()
}

/// Returns (vertex_rgb, atlas_row_opt) for a face. The vertex rgb is always the block's
/// computed colour (`block_color`) — the paint tint for painted blocks, or the natural block
/// colour otherwise.
///
/// The texture row depends on paint state, mirroring the game's two-atlas scheme:
///   - **unpainted** (`paint == 0`) → the full-color tile: `block_color × full_color ≈ natural`.
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
    (fallback_rgb, row)
}

