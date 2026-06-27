use std::collections::HashMap;
use std::io::Read;

pub const TILE: u32 = 32;

// [side_tex, bottom_tex, top_tex] per block type (index = block type, "" = no texture → flat-color fallback)
// Ported from blockTypeFaces in Globals.mm + TEX_* / TYPE_* from Constants.h.
// Face mapping: Globals face 0-3 = sides, face 4 = bottom, face 5 = top.
pub const BLOCK_FACE_TEX: [[&str; 3]; 112] = [
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
];

pub struct TexturePack {
    pub tile: u32,
    /// RGBA bytes, width = tile, height = tile * atlas_rows. All tiles stored as grayscale+alpha
    /// so that vertex_color × texture_pixel = final tinted colour. Row 0 is a blank white sentinel.
    pub atlas_rgba: Vec<u8>,
    pub atlas_rows: u32,
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
/// computed colour (block_color); the grayscale texture provides shape/detail, and the GPU
/// multiplies the two together to produce the final tinted pixel.
pub fn face_color_and_row(
    pack: &TexturePack,
    bt: u8,
    paint: u8,
    face_kind: u8,
    fallback_rgb: [u8; 3],
) -> ([u8; 3], Option<u32>) {
    (fallback_rgb, face_tile(pack, bt, face_kind))
}

/// Known canonical tile names (lowercased, without extension).
pub const KNOWN_TEX_NAMES: &[&str] = &[
    "grass_top", "grass_top2", "grass_side",
    "dirt", "sand", "stone", "bedrock", "dark_stone",
    "tree_side", "tree_vert", "wood", "leaves", "steel", "blocktnt",
    "tnt_side", "tnt_top",
    "brick", "cobblestone", "crystal", "lightbox",
    "ladder", "cloud", "vine", "shingle", "gradient", "ice",
    "glass", "weave", "water", "lava", "trampoline", "firework",
];

/// Convert RGBA pixel data to grayscale in place (luminosity formula), preserving alpha.
fn to_grayscale(rgba: &mut [u8]) {
    for chunk in rgba.chunks_mut(4) {
        let lum = (0.299 * chunk[0] as f32
            + 0.587 * chunk[1] as f32
            + 0.114 * chunk[2] as f32)
            .round() as u8;
        chunk[0] = lum;
        chunk[1] = lum;
        chunk[2] = lum;
        // chunk[3] (alpha) unchanged
    }
}

pub fn load_pack(path: &str) -> Result<TexturePack, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip: {e}"))?;

    // Build a map from stem (lowercase, no extension) → raw PNG bytes by scanning every entry.
    // This handles subdirectories (textures/stone.png) and mixed casing (Stone.PNG) transparently.
    let known_set: std::collections::HashSet<&str> = KNOWN_TEX_NAMES.iter().copied().collect();
    let mut found: HashMap<String, Vec<u8>> = HashMap::new();

    for i in 0..zip.len() {
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() { continue; }

        // Strip any leading path components, lowercase, remove extension.
        let raw_name = entry.name().to_string();
        let filename = raw_name.rsplit('/').next().unwrap_or(&raw_name);
        let stem = match filename.rsplit_once('.') {
            Some((s, _ext)) => s.to_lowercase(),
            None => filename.to_lowercase(),
        };

        if known_set.contains(stem.as_str()) && !found.contains_key(&stem) {
            let mut buf = Vec::new();
            if entry.read_to_end(&mut buf).is_ok() {
                found.insert(stem, buf);
            }
        }
    }

    let mut row_tiles: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut name_to_row: HashMap<String, u32> = HashMap::new();
    let mut next_row: u32 = 1; // row 0 is blank white sentinel

    // Insert in KNOWN_TEX_NAMES order so the atlas layout is deterministic.
    for &name in KNOWN_TEX_NAMES {
        let data = match found.get(name) {
            Some(d) => d,
            None => continue,
        };

        if let Ok(img) = image::load_from_memory(data) {
            let resized = image::imageops::resize(
                &img.to_rgba8(),
                TILE, TILE,
                image::imageops::FilterType::Nearest,
            );
            let mut tile_data = resized.into_raw();
            to_grayscale(&mut tile_data);
            name_to_row.insert(name.to_string(), next_row);
            row_tiles.push((next_row, tile_data));
            next_row += 1;
        }
    }

    if name_to_row.is_empty() {
        return Err("No recognizable PNG tiles found in the texture pack zip".to_string());
    }

    let atlas_rows = next_row;
    let atlas_w = TILE;
    let atlas_h = TILE * atlas_rows;
    // Row 0 = blank white (all 255). Sampling row 0 → vertex colour passes through unchanged.
    let mut atlas_rgba = vec![255u8; (atlas_w * atlas_h * 4) as usize];

    for (row, tile_data) in row_tiles {
        let y_start = (row * TILE) as usize;
        for y in 0..TILE as usize {
            let src = y * TILE as usize * 4;
            let dst = (y_start + y) * atlas_w as usize * 4;
            atlas_rgba[dst..dst + TILE as usize * 4]
                .copy_from_slice(&tile_data[src..src + TILE as usize * 4]);
        }
    }

    Ok(TexturePack { tile: TILE, atlas_rgba, atlas_rows, name_to_row })
}
