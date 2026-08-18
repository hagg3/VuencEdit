use std::collections::HashMap;
use std::io::Read;

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
    // pack would need a `KNOWN_TEX_NAMES` extension once real names are known). Empty string ⇒
    // `face_tile` returns None ⇒ falls back to atlas row 0 (white sentinel), so the placeholder
    // BLOCK_RGB colour above shows through unmodulated.
    ["", "", ""],                                   // 112 unknown (new format)
    ["", "", ""],                                   // 113 unknown (new format)
    ["", "", ""],                                   // 114 unknown (new format)
    ["", "", ""],                                   // 115 unknown (new format)
    ["", "", ""],                                   // 116 unknown (new format)
    ["", "", ""],                                   // 117 unknown (new format)
    ["", "", ""],                                   // 118 unknown (new format)
    ["", "", ""],                                   // 119 unknown (new format)
    ["", "", ""],                                   // 120 unknown (new format)
    ["", "", ""],                                   // 121 unknown (new format)
    ["", "", ""],                                   // 122 unknown (new format)
    ["", "", ""],                                   // 123 unknown (new format)
    ["", "", ""],                                   // 124 unknown (new format)
    ["", "", ""],                                   // 125 unknown (new format)
    ["", "", ""],                                   // 126 unknown (new format)
    ["", "", ""],                                   // 127 unknown (new format)
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

/// Map from canonical (app) tile name → tile index in the game's `atlas.png` — a 32-wide vertical
/// strip of 32×32 tiles. This is the **verified order of the shipped atlas.png** (top→bottom, 0-based):
///
///   0 grass_top, 1 grass_side(color), 2 grass_side, 3 dirt, 4 sand, 5 stone, 6 dark_stone,
///   7 trunk_side, 8 trunk_top, 9 wood, 10 tnt_side(color), 11 tnt_side, 12 tnt_top(color),
///   13 tnt_top, 14 weeds_top, 15 bedrock, 16 leaves, 17 steel, 18 expansion(color),
///   19 brick(color), 20 brick, 21 slate, 22 wallpaper, 23 lamp, 24 ladder, 25 cloud,
///   26 vine(color), 27 shingles, 28 neonsquare, 29 ice, 30 trampoline, 31 firework(color).
///
/// (This differs from the older `Constants.h` `BLOCK_TEXTURES` enum in a few slots — trust the
/// shipped atlas.) For blocks that have a distinct color variant we pick the **color** index; the
/// grayscale modulation variant is derived by us at assembly time. App-name aliases:
/// weeds_top→`grass_top2`, expansion→`blocktnt`, slate→`cobblestone`, wallpaper→`crystal`,
/// lamp→`lightbox`, neonsquare→`gradient` (see the `BLOCK_FACE_TEX` comments).
pub const ATLAS1_MAP: &[(&str, u32)] = &[
    ("grass_top", 0),
    ("grass_side", 1),   // color variant
    ("dirt", 3),
    ("sand", 4),
    ("stone", 5),
    ("dark_stone", 6),
    ("tree_side", 7),
    ("tree_vert", 8),
    ("wood", 9),
    ("tnt_side", 10),    // color variant
    ("tnt_top", 12),     // color variant
    ("grass_top2", 14),  // weeds top
    ("bedrock", 15),
    ("leaves", 16),
    ("steel", 17),
    ("blocktnt", 18),    // expansion (color)
    ("brick", 19),       // color variant
    ("cobblestone", 21), // slate
    ("crystal", 22),     // wallpaper
    ("lightbox", 23),    // lamp
    ("ladder", 24),
    ("cloud", 25),
    ("vine", 26),        // color variant
    ("shingle", 27),     // shingles
    ("gradient", 28),    // neonsquare
    ("ice", 29),
    ("trampoline", 30),
    ("firework", 31),    // color variant
];

/// Map from canonical tile name → tile index in the game's `atlas2.png` (IS_ATLAS2 blocks). The
/// shipped atlas2 is four groups of 8 animation/edge variants: glass 0–7, weave/fence 8–15,
/// water 16–23, lava 24–31. We use the base (first) tile of each group.
pub const ATLAS2_MAP: &[(&str, u32)] = &[
    ("glass", 0),
    ("weave", 8),
    ("water", 16),
    ("lava", 24),
];

type Tile = image::RgbaImage;

/// Slice a vertical-strip atlas image (width = tile size, height = tile*count) into TILE×TILE
/// tiles and insert the ones named by `map`. Existing entries win (individually-named files take
/// precedence over atlas slices), so this uses `or_insert`.
fn slice_atlas_image(
    bytes: &[u8],
    map: &[(&str, u32)],
    out: &mut HashMap<String, Tile>,
) -> Result<(), String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("Not a decodable atlas image: {e}"))?
        .to_rgba8();
    let w = img.width();
    let h = img.height();
    if w == 0 || h == 0 || h % w != 0 {
        return Err(format!(
            "Atlas image must be a vertical strip of square tiles (got {w}×{h}; height must be a multiple of width)"
        ));
    }
    let tile_px = w;
    let ntiles = h / w;
    for &(name, idx) in map {
        if idx >= ntiles {
            continue;
        }
        let sub = image::imageops::crop_imm(&img, 0, idx * tile_px, tile_px, tile_px).to_image();
        let resized =
            image::imageops::resize(&sub, TILE, TILE, image::imageops::FilterType::Nearest);
        out.entry(name.to_string()).or_insert(resized);
    }
    Ok(())
}

/// Derive a brightness-normalized grayscale variant of a full-color tile, for use as a paint
/// modulation base. Luminance-flattens each pixel, then scales so the tile's mean opaque
/// luminance maps to a bright neutral (`GRAY_TARGET`) — this keeps texture detail while letting
/// the paint colour dominate the final `paint × gray` product (avoids both "too dark" and
/// "washed out"). Alpha is preserved verbatim.
fn grayscale_tile(rgba: &[u8]) -> Vec<u8> {
    const GRAY_TARGET: f32 = 184.0;
    let lum = |px: &[u8]| 0.299 * px[0] as f32 + 0.587 * px[1] as f32 + 0.114 * px[2] as f32;

    let mut sum = 0.0f32;
    let mut count = 0u32;
    for px in rgba.chunks_exact(4) {
        if px[3] == 0 {
            continue;
        }
        sum += lum(px);
        count += 1;
    }
    let mean = if count > 0 { sum / count as f32 } else { 128.0 };
    let scale = if mean > 1.0 { GRAY_TARGET / mean } else { 1.0 };

    let mut out = vec![0u8; rgba.len()];
    for (px, o) in rgba.chunks_exact(4).zip(out.chunks_exact_mut(4)) {
        let g = (lum(px) * scale).clamp(0.0, 255.0) as u8;
        o[0] = g;
        o[1] = g;
        o[2] = g;
        o[3] = px[3];
    }
    out
}

/// Collect TILE×TILE tiles from a zip texture pack: individually-named PNGs (`stone.png`, …) plus
/// any bundled `atlas.png` / `atlas2.png` (sliced via the game index maps). Named files take
/// precedence over atlas slices for the same block.
fn collect_tiles_from_zip(bytes: &[u8]) -> Result<HashMap<String, Tile>, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("Not a valid zip: {e}"))?;

    let known_set: std::collections::HashSet<&str> = KNOWN_TEX_NAMES.iter().copied().collect();
    let mut tiles: HashMap<String, Tile> = HashMap::new();
    let mut atlas_bytes: HashMap<String, Vec<u8>> = HashMap::new(); // "atlas" / "atlas2"

    for i in 0..zip.len() {
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() {
            continue;
        }
        // Strip any leading path components, lowercase, remove extension.
        let raw_name = entry.name().to_string();
        let filename = raw_name.rsplit('/').next().unwrap_or(&raw_name);
        let stem = match filename.rsplit_once('.') {
            Some((s, _ext)) => s.to_lowercase(),
            None => filename.to_lowercase(),
        };

        if stem == "atlas" || stem == "atlas2" {
            if let std::collections::hash_map::Entry::Vacant(e) = atlas_bytes.entry(stem) {
                let mut buf = Vec::new();
                if entry.read_to_end(&mut buf).is_ok() {
                    e.insert(buf);
                }
            }
        } else if known_set.contains(stem.as_str()) && !tiles.contains_key(&stem) {
            let mut buf = Vec::new();
            if entry.read_to_end(&mut buf).is_ok() {
                if let Ok(img) = image::load_from_memory(&buf) {
                    let resized = image::imageops::resize(
                        &img.to_rgba8(),
                        TILE,
                        TILE,
                        image::imageops::FilterType::Nearest,
                    );
                    tiles.insert(stem, resized);
                }
            }
        }
    }

    // Slice bundled atlas images last, so individually-named tiles keep precedence.
    if let Some(b) = atlas_bytes.get("atlas") {
        slice_atlas_image(b, ATLAS1_MAP, &mut tiles)?;
    }
    if let Some(b) = atlas_bytes.get("atlas2") {
        slice_atlas_image(b, ATLAS2_MAP, &mut tiles)?;
    }
    Ok(tiles)
}

/// Assemble a `TexturePack` from collected tiles: row 0 = white sentinel, rows 1..=N = full-color
/// tiles (in `KNOWN_TEX_NAMES` order for a deterministic layout), rows N+1..=2N = their grayscale
/// modulation variants.
fn assemble(tiles: &HashMap<String, Tile>) -> Result<TexturePack, String> {
    // (color_row, rgba) in KNOWN_TEX_NAMES order.
    let mut row_tiles: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut name_to_row: HashMap<String, u32> = HashMap::new();
    let mut next_row: u32 = 1; // row 0 is blank white sentinel

    for &name in KNOWN_TEX_NAMES {
        if let Some(img) = tiles.get(name) {
            name_to_row.insert(name.to_string(), next_row);
            row_tiles.push((next_row, img.as_raw().clone()));
            next_row += 1;
        }
    }

    if name_to_row.is_empty() {
        return Err("No recognizable tiles found in the texture pack".to_string());
    }

    let n_color = next_row - 1; // N
    let gray_row_offset = n_color;
    let atlas_rows = 1 + n_color * 2;
    let atlas_w = TILE;
    let atlas_h = TILE * atlas_rows;
    // Row 0 = blank white (all 255). Sampling row 0 → vertex colour passes through unchanged.
    let mut atlas_rgba = vec![255u8; (atlas_w * atlas_h * 4) as usize];

    let row_bytes = TILE as usize * 4;
    let mut blit = |row: u32, data: &[u8]| {
        let y_start = (row * TILE) as usize;
        for y in 0..TILE as usize {
            let src = y * row_bytes;
            let dst = (y_start + y) * atlas_w as usize * 4;
            atlas_rgba[dst..dst + row_bytes].copy_from_slice(&data[src..src + row_bytes]);
        }
    };

    for (row, tile_data) in &row_tiles {
        blit(*row, tile_data);
        let gray = grayscale_tile(tile_data);
        blit(row + gray_row_offset, &gray);
    }

    Ok(TexturePack {
        tile: TILE,
        atlas_rgba,
        atlas_rows,
        gray_row_offset,
        name_to_row,
    })
}

/// Load a texture pack from `path`. Two input formats are accepted:
///   - **Zip** (`.zip`): individually-named PNG tiles (`stone.png`, `textures/Brick.PNG`, …),
///     optionally including bundled `atlas.png` / `atlas2.png` game atlases.
///   - **Atlas image** (`.png`/any image): the game's `atlas.png` (sliced via `ATLAS1_MAP`) or
///     `atlas2.png` (sliced via `ATLAS2_MAP` — chosen when the filename stem is `atlas2`). When a
///     bare `atlas.png` is loaded, a sibling `atlas2.png` in the same folder is picked up
///     automatically so the IS_ATLAS2 blocks (glass/fence/water/lava) are textured too.
/// The format is detected by content (zip magic `PK`), not extension.
pub fn load_pack(path: &str) -> Result<TexturePack, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;

    let tiles = if bytes.starts_with(b"PK") {
        collect_tiles_from_zip(&bytes)?
    } else {
        collect_tiles_from_atlas_image(path, &bytes)?
    };

    assemble(&tiles)
}

/// Slice a bare atlas image. `atlas2*` filenames use `ATLAS2_MAP`; otherwise `ATLAS1_MAP`, and a
/// sibling `atlas2.*` image in the same directory is auto-included.
fn collect_tiles_from_atlas_image(path: &str, bytes: &[u8]) -> Result<HashMap<String, Tile>, String> {
    let p = std::path::Path::new(path);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut tiles: HashMap<String, Tile> = HashMap::new();

    if stem.starts_with("atlas2") {
        slice_atlas_image(bytes, ATLAS2_MAP, &mut tiles)?;
        return Ok(tiles);
    }

    slice_atlas_image(bytes, ATLAS1_MAP, &mut tiles)?;

    // Auto-include a sibling atlas2 image (any case/extension) if one sits next to atlas.png.
    if let Some(dir) = p.parent() {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for entry in rd.flatten() {
                let ep = entry.path();
                let s = ep
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_lowercase());
                if s.as_deref() == Some("atlas2") {
                    if let Ok(b) = std::fs::read(&ep) {
                        let _ = slice_atlas_image(&b, ATLAS2_MAP, &mut tiles);
                    }
                    break;
                }
            }
        }
    }

    Ok(tiles)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_tile(r: u8, g: u8, b: u8) -> Tile {
        image::RgbaImage::from_pixel(TILE, TILE, image::Rgba([r, g, b, 255]))
    }

    #[test]
    fn grayscale_is_achromatic_and_normalized() {
        // A dark-red brick-ish tile: luminance is low, so normalization must brighten it.
        let dark_red = solid_tile(120, 20, 20);
        let gray = grayscale_tile(dark_red.as_raw());
        for px in gray.chunks_exact(4) {
            assert_eq!(px[0], px[1], "r==g");
            assert_eq!(px[1], px[2], "g==b");
            assert_eq!(px[3], 255, "alpha preserved");
        }
        // Uniform tile → mean maps to GRAY_TARGET (184), so every pixel ≈ 184.
        assert!(
            (gray[0] as i32 - 184).abs() <= 1,
            "expected ~184, got {}",
            gray[0]
        );
    }

    #[test]
    fn grayscale_preserves_alpha() {
        let mut t = solid_tile(200, 200, 200);
        t.get_pixel_mut(0, 0).0[3] = 0; // one transparent pixel
        let gray = grayscale_tile(t.as_raw());
        assert_eq!(gray[3], 0, "transparent pixel stays transparent");
        assert_eq!(gray[7], 255, "opaque pixel stays opaque");
    }

    #[test]
    fn assemble_doubles_rows_with_gray_offset() {
        let mut tiles: HashMap<String, Tile> = HashMap::new();
        tiles.insert("stone".to_string(), solid_tile(128, 128, 128));
        tiles.insert("brick".to_string(), solid_tile(150, 40, 40));
        tiles.insert("dirt".to_string(), solid_tile(110, 80, 50));
        let pack = assemble(&tiles).unwrap();

        let n = tiles.len() as u32;
        assert_eq!(pack.gray_row_offset, n);
        assert_eq!(pack.atlas_rows, 2 * n + 1, "row 0 sentinel + N color + N gray");

        // A painted face resolves to the grayscale row (color_row + offset), which is achromatic.
        let brick_row = pack.name_to_row["brick"];
        let gray_row = brick_row + pack.gray_row_offset;
        let px = |row: u32| {
            let off = (row * TILE * TILE * 4) as usize; // first pixel of the row
            [pack.atlas_rgba[off], pack.atlas_rgba[off + 1], pack.atlas_rgba[off + 2]]
        };
        let g = px(gray_row);
        assert_eq!(g[0], g[1]);
        assert_eq!(g[1], g[2]);
    }

    #[test]
    fn slice_atlas_rejects_non_strip() {
        // 33×32 is not a vertical strip of square tiles (33 % 32 != 0 after transpose logic;
        // here height 32 % width 33 != 0).
        let img = image::RgbaImage::from_pixel(33, 32, image::Rgba([0, 0, 0, 255]));
        let mut bytes: Vec<u8> = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        let mut out: HashMap<String, Tile> = HashMap::new();
        assert!(slice_atlas_image(&bytes, ATLAS1_MAP, &mut out).is_err());
    }

    #[test]
    fn real_shipped_atlases_load_with_sibling_pickup() {
        // The shipped atlas.png + atlas2.png live in the repo's TEST WORLDS/atlas folder.
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../TEST WORLDS/atlas");
        let atlas1 = format!("{dir}/atlas.png");
        if !std::path::Path::new(&atlas1).exists() {
            return; // repo asset not present (e.g. slimmed checkout) — skip.
        }
        let pack = load_pack(&atlas1).expect("load shipped atlas.png");

        // All 28 atlas1 names + 4 atlas2 names (sibling auto-pickup) = 32 tiles → 65 rows.
        assert_eq!(pack.gray_row_offset, 32, "28 atlas1 + 4 atlas2 sibling tiles");
        assert_eq!(pack.atlas_rows, 2 * 32 + 1);

        // Sanity: names present for both atlases.
        for name in ["brick", "dark_stone", "bedrock", "glass", "water", "lava", "weave"] {
            assert!(pack.name_to_row.contains_key(name), "missing tile {name}");
        }

        // A painted brick resolves to an achromatic grayscale row.
        let (_rgb, row) = face_color_and_row(&pack, 13, 5, 0, [0, 0, 0]);
        let row = row.expect("brick tile present");
        let off = (row * TILE * TILE * 4) as usize;
        assert_eq!(pack.atlas_rgba[off], pack.atlas_rgba[off + 1]);
        assert_eq!(pack.atlas_rgba[off + 1], pack.atlas_rgba[off + 2]);
    }

    #[test]
    fn slice_atlas_maps_indices_to_names() {
        // Build a 2-wide? No — strip is width×(width*count). Use width 2, 6 tiles tall (2×12),
        // and fill each tile row with a distinct value so we can verify the index→name mapping.
        let w = 2u32;
        let count = 30u32; // enough to cover brick at index 19
        let mut img = image::RgbaImage::new(w, w * count);
        for idx in 0..count {
            let v = idx as u8;
            for y in 0..w {
                for x in 0..w {
                    img.put_pixel(x, idx * w + y, image::Rgba([v, v, v, 255]));
                }
            }
        }
        let mut bytes: Vec<u8> = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        let mut out: HashMap<String, Tile> = HashMap::new();
        slice_atlas_image(&bytes, ATLAS1_MAP, &mut out).unwrap();

        // brick → index 19; the tile's pixels should all be value 19.
        let brick = out.get("brick").expect("brick sliced");
        assert_eq!(brick.get_pixel(0, 0).0[0], 19);
        // stone → index 5.
        assert_eq!(out.get("stone").unwrap().get_pixel(0, 0).0[0], 5);
    }
}
