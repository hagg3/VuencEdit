//! Minecraft .schematic / .litematic / .schem import: NBT parsing, block-ID mapping
//! to Eden block types, and clipboard construction.
use crate::{AppState, Clipboard, ClipboardInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;

// Cap decompressed size for untrusted schematic/litematic/schem gzip payloads — mirrors the
// prefab decoder's take(MAX+1) pattern so a small gzip bomb can't OOM the process. 512 MB is
// generous headroom above any real-world MCEdit/litematic export.
const MAX_SCHEMATIC_DECOMPRESSED: u64 = 512 * 1024 * 1024;

fn gunzip_capped(raw: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut out = Vec::new();
    GzDecoder::new(raw).take(MAX_SCHEMATIC_DECOMPRESSED + 1).read_to_end(&mut out)
        .map_err(|e| format!("gzip: {e}"))?;
    if out.len() as u64 > MAX_SCHEMATIC_DECOMPRESSED {
        return Err("Schematic file is too large".into());
    }
    Ok(out)
}

// ── Minecraft Schematic / Litematica Import ──────────────────────────────────

pub(crate) const SC_PAINT_COLORS: [[u8; 3]; 54] = [
    [255,170,170],[255,234,170],[251,255,170],[170,255,191],[170,255,255],
    [170,191,255],[212,170,255],[255,170,234],[255,255,255],
    [255, 85, 85],[255,212, 85],[246,255, 85],[ 85,255,128],[ 85,255,255],
    [ 85,128,255],[170, 85,255],[255, 85,212],[204,204,204],
    [255,  0,  0],[255,191,  0],[242,255,  0],[  0,255, 64],[  0,255,255],
    [  0, 64,255],[128,  0,255],[255,  0,191],[153,153,153],
    [191,  0,  0],[191,143,  0],[182,191,  0],[  0,191, 48],[  0,191,191],
    [  0, 48,191],[ 96,  0,191],[191,  0,143],[102,102,102],
    [128,  0,  0],[128, 96,  0],[121,128,  0],[  0,128, 32],[  0,128,128],
    [  0, 32,128],[ 64,  0,128],[128,  0, 96],[ 51, 51, 51],
    [ 64,  0,  0],[ 64, 48,  0],[ 61, 64,  0],[  0, 64, 16],[  0, 64, 64],
    [  0, 16, 64],[ 32,  0, 64],[ 64,  0, 48],[  3,  3,  3],
];

pub(crate) fn sc_closest_paint(r: u8, g: u8, b: u8) -> u8 {
    let mut best = 0usize;
    let mut best_dist = i64::MAX;
    for (i, &[pr, pg, pb]) in SC_PAINT_COLORS.iter().enumerate() {
        let dr = r as i64 - pr as i64;
        let dg = g as i64 - pg as i64;
        let db = b as i64 - pb as i64;
        let dist = dr*dr + dg*dg + db*db;
        if dist < best_dist { best_dist = dist; best = i; }
    }
    (best + 1) as u8
}

// Minecraft classic 16-color palette (wool/concrete/terracotta/stained glass data values 0–15)
pub(crate) const MC_DYE_RGB: [[u8; 3]; 16] = [
    [221,221,221], // 0 White
    [219,125, 62], // 1 Orange
    [179, 80,188], // 2 Magenta
    [107,138,201], // 3 Light Blue
    [177,166, 39], // 4 Yellow
    [ 65,174, 56], // 5 Lime
    [208,132,153], // 6 Pink
    [ 64, 64, 64], // 7 Gray
    [154,161,161], // 8 Light Gray
    [ 46,110,137], // 9 Cyan
    [126, 61,181], // 10 Purple
    [ 46, 56,141], // 11 Blue
    [ 79, 50, 31], // 12 Brown
    [ 53, 70, 27], // 13 Green
    [150, 52, 48], // 14 Red
    [ 25, 22, 22], // 15 Black
];

pub(crate) fn mc_dye_to_eden(substrate: u8, data: u8) -> (u8, u8) {
    let [r, g, b] = MC_DYE_RGB[data.min(15) as usize];
    (substrate, sc_closest_paint(r, g, b))
}

// Map MC stair data (facing bits 0–1, half bit 2) to Eden ramp direction offset.
// MC: 0=east, 1=west, 2=south, 3=north → Eden S/W/N/E = 0/1/2/3
pub(crate) fn mc_stair_to_ramp(family_base: u8, data: u8) -> (u8, u8) {
    let dir: u8 = match data & 3 {
        0 => 3, // east
        1 => 1, // west
        2 => 0, // south
        _ => 2, // north
    };
    (family_base + dir, 0)
}

pub(crate) fn mc_to_eden(id: u8, meta: u8) -> (u8, u8) {
    match id {
        0 => (0, 0),
        1 => match meta & 0x7 {
            1 => (3,  1), // Granite     → Dirt  + paint 1
            2 => (2,  1), // Pol.Granite → Stone + paint 1
            3 => (3,  9), // Diorite     → Dirt  + paint 9
            4 => (2,  9), // Pol.Diorite → Stone + paint 9
            5 => (3, 27), // Andesite    → Dirt  + paint 27
            6 => (2, 27), // Pol.Andesite→ Stone + paint 27
            _ => (2,  0), // Stone
        },
        2 => (8, 0),
        3 => (3, 0),
        4 | 48 => (10, 18), // Cobblestone / Mossy Cobblestone → Dark Stone + paint 18
        5 => (7, 0),
        6 | 37 | 38 | 39 | 40 | 50 | 51 | 55 | 57..=66 | 68 | 69 | 75 | 76 | 77 | 84 | 90 | 92 |
        93 | 94 | 96 |
        97 | 101 | 102 | 117 | 118 | 119 | 120 | 122 | 123 | 124 | 127 | 129 |
        131 | 132 | 140 | 141 | 142 | 143 | 144 | 147 | 148 | 149 | 150 | 151 | 152 |
        175 | 176 | 177 | 178 | 193..=197 | 198..=202 | 204..=207 => (0, 0),
        7 => (1, 36), // Bedrock → Cobblestone block + paint 36
        8 | 9 => (20, 0),
        10 | 11 => (23, 0),
        12 => (4, 0),
        13 => (4, 0),
        14 | 15 | 16 | 21 | 22 | 23 | 24 | 25 | 26 | 56 | 73 | 74 => (2, 0),
        17 | 162 => (6, 0),
        18 | 161 => (5, 0),
        19 => (4, 0),
        20 => (58, 0),
        27..=34 => (0, 0),
        35 => mc_dye_to_eden(4, meta),
        36 => (0, 0),
        41 => (4, sc_closest_paint(255, 215,   0)),
        42 => (4, sc_closest_paint(211, 211, 211)),
        43 | 44 => (2, 0),
        45 => (13, 0),
        46 => (9, 0),
        47 | 54 | 146 => (7, 0),
        49 => (2, sc_closest_paint(10, 10, 10)),
        53 | 134 | 135 | 136 | 163 | 164 => mc_stair_to_ramp(28, meta),
        67 | 108 | 109 | 114 | 128 | 156 | 180 | 182 | 203 => mc_stair_to_ramp(24, meta),
        78 | 80 => (19, 0),
        79 | 174 => (15, 0),
        81 | 106 => (5, 0),
        82 => (4, sc_closest_paint(108, 113, 123)),
        85 | 113 | 188 | 189 | 190 | 191 | 192 => (21, 0),
        86 | 91 => (4, sc_closest_paint(255, 132, 0)),
        87 => (13, 0),
        88 => (3, 0),
        89 => (19, 0),
        95 | 160 => mc_dye_to_eden(58, meta),
        98 => (2, 0),
        99 | 100 => (5, 0),
        112 => (56, 0),
        125 | 126 => (7, 0),
        153 => (2, 0),
        155 => (15, 9), // Quartz Block → Ice + paint 9
        159 => mc_dye_to_eden(4, meta),
        170 => (6, 0),
        172 => (4, sc_closest_paint(146, 84, 61)),
        173 => (4, sc_closest_paint(10, 10, 10)),
        251 | 252 => mc_dye_to_eden(4, meta),
        _ => (0, 0),
    }
}

// ── Named block mapping (Litematica 1.13+) ───────────────────────────────────

pub(crate) fn facing_to_ramp_dir(facing: &str) -> u8 {
    match facing { "east" => 3, "west" => 1, "north" => 2, _ => 0 }
}

pub(crate) fn mc_named_to_eden(name: &str, props: Option<&HashMap<String, String>>) -> (u8, u8) {
    let id = name.strip_prefix("minecraft:").unwrap_or(name);

    // Color-prefixed blocks (e.g. "white_wool", "orange_concrete")
    const COLORS: &[(&str, u8, u8, u8)] = &[
        ("white",      221, 221, 221), ("orange",    219, 125,  62),
        ("magenta",    179,  80, 188), ("light_blue",107, 138, 201),
        ("yellow",     177, 166,  39), ("lime",       65, 174,  56),
        ("pink",       208, 132, 153), ("gray",       64,  64,  64),
        ("light_gray", 154, 161, 161), ("cyan",       46, 110, 137),
        ("purple",     126,  61, 181), ("blue",       46,  56, 141),
        ("brown",       79,  50,  31), ("green",      53,  70,  27),
        ("red",        150,  52,  48), ("black",      25,  22,  22),
    ];
    for &(color, r, g, b) in COLORS {
        if let Some(base) = id.strip_prefix(&format!("{color}_")) {
            let paint = sc_closest_paint(r, g, b);
            return match base {
                "wool" | "concrete" | "concrete_powder" | "terracotta" => (4, paint),
                "stained_glass" | "stained_glass_pane" => (58, paint),
                _ => (0, 0),
            };
        }
    }

    // Stairs → ramps (use facing property)
    if id.ends_with("_stairs") {
        let facing = props.and_then(|p| p.get("facing")).map(|s| s.as_str()).unwrap_or("south");
        let half   = props.and_then(|p| p.get("half")).map(|s| s.as_str()).unwrap_or("bottom");
        if half == "top" { return (2, 0); } // upside-down stairs → solid block
        let family: u8 = if id.contains("oak") || id.contains("spruce") || id.contains("birch")
            || id.contains("jungle") || id.contains("acacia") || id.contains("dark_oak")
            || id.contains("mangrove") || id.contains("cherry") || id.contains("bamboo")
            || id.contains("crimson") || id.contains("warped") { 28 }
            else if id.contains("ice") { 36 }
            else { 24 };
        return (family + facing_to_ramp_dir(facing), 0);
    }

    match id {
        "air" | "cave_air" | "void_air" => (0, 0),
        "stone" | "smooth_stone" | "smooth_stone_slab" => (2, 0),
        "granite"          => (3,  1),
        "polished_granite" => (2,  1),
        "diorite"          => (3,  9),
        "polished_diorite" => (2,  9),
        "andesite"         => (3, 27),
        "polished_andesite"=> (2, 27),
        "cobblestone" | "mossy_cobblestone" | "cobblestone_wall" |
        "mossy_cobblestone_wall" | "infested_cobblestone" => (10, 18),
        "bedrock"          => (1, 36),
        "grass_block"      => (8, 0),
        "dirt" | "coarse_dirt" | "rooted_dirt" | "podzol" | "mycelium" => (3, 0),
        "water" => (20, 0),
        "lava"  => (23, 0),
        "sand" | "red_sand" | "sandstone" | "red_sandstone" | "smooth_sandstone" |
        "cut_sandstone" | "chiseled_sandstone" | "smooth_red_sandstone" |
        "cut_red_sandstone" | "chiseled_red_sandstone" | "gravel" => (4, 0),
        "glass" | "tinted_glass" | "glass_pane" => (58, 0),
        "bricks" | "brick_wall" | "brick_slab" | "netherrack" | "crimson_nylium" |
        "warped_nylium" | "nether_bricks" | "red_nether_bricks" | "cracked_nether_bricks" |
        "chiseled_nether_bricks" | "nether_brick_wall" | "nether_brick_slab" => (13, 0),
        "obsidian" | "crying_obsidian" => (2, sc_closest_paint(10, 10, 10)),
        "snow" | "snow_block" | "powder_snow" => (19, 0),
        "ice" | "blue_ice" | "frosted_ice" | "packed_ice" => (15, 0),
        "clay" => (4, sc_closest_paint(108, 113, 123)),
        "terracotta" => (4, sc_closest_paint(146, 84, 61)),
        "hardened_clay" => (4, sc_closest_paint(146, 84, 61)),
        "soul_sand" | "soul_soil" => (3, 0),
        "glowstone" | "sea_lantern" | "shroomlight" | "froglight" | "ochre_froglight" |
        "verdant_froglight" | "pearlescent_froglight" => (19, 0),
        "gold_block"    => (4, sc_closest_paint(255, 215,   0)),
        "iron_block"    => (4, sc_closest_paint(211, 211, 211)),
        "diamond_block" => (4, sc_closest_paint( 77, 218, 215)),
        "emerald_block" => (4, sc_closest_paint( 17, 178,  75)),
        "lapis_block"   => (4, sc_closest_paint( 36,  78, 148)),
        "redstone_block"=> (4, sc_closest_paint(255,   0,   0)),
        "coal_block"    => (4, sc_closest_paint( 10,  10,  10)),
        "bone_block"    => (4, sc_closest_paint(221, 221, 221)),
        "amethyst_block"=> (4, sc_closest_paint(100,  80, 200)),
        "quartz_block" | "smooth_quartz" | "quartz_pillar" | "chiseled_quartz_block" |
        "quartz_bricks" | "quartz_slab" => (15, 9),
        "stone_bricks" | "mossy_stone_bricks" | "cracked_stone_bricks" |
        "chiseled_stone_bricks" | "infested_stone_bricks" | "stone_brick_wall" |
        "cobbled_deepslate" | "polished_deepslate" | "deepslate_bricks" |
        "deepslate_tiles" | "chiseled_deepslate" | "infested_deepslate" |
        "deepslate_brick_wall" | "deepslate_tile_wall" | "deepslate_brick_slab" |
        "polished_deepslate_slab" | "polished_deepslate_wall" => (2, 0),
        "prismarine" | "dark_prismarine" | "prismarine_bricks" | "prismarine_slab" |
        "prismarine_wall" => (2, sc_closest_paint(46, 110, 137)),
        "end_stone" | "end_stone_bricks" | "end_stone_brick_wall" | "end_stone_brick_slab" =>
            (4, sc_closest_paint(220, 220, 165)),
        "purpur_block" | "purpur_pillar" | "purpur_slab" =>
            (4, sc_closest_paint(169, 125, 169)),
        "sponge" | "wet_sponge" | "calcite" | "tuff" => (4, 0),
        "hay_block" => (6, 0),
        "cactus" | "vine" | "glow_lichen" | "moss_block" | "moss_carpet" |
        "azalea_leaves" | "flowering_azalea_leaves" => (5, 0),
        s if s.ends_with("_log") || s.ends_with("_wood") || s.contains("_stem")
            || s.starts_with("stripped_") => (6, 0),
        s if s.ends_with("_planks") => (7, 0),
        s if s.ends_with("_leaves") || s.ends_with("_sapling") => (5, 0),
        s if (s.ends_with("_fence") || s.ends_with("_fence_gate"))
            && !s.ends_with("_fence_gate") => (21, 0),
        s if s.ends_with("_slab") => (2, 0),
        s if s.ends_with("_wall") => (2, 0),
        s if s.ends_with("_ore") => (2, 0),
        _ => (0, 0),
    }
}

// ── Full NBT value (for Litematica parser) ────────────────────────────────────

#[allow(dead_code)]
enum NbtVal {
    Byte(i8), Short(i16), Int(i32), Long(i64), Float(f32), Double(f64),
    ByteArr(Vec<u8>), Str(String), List(Vec<NbtVal>),
    Compound(HashMap<String, NbtVal>), IntArr(Vec<i32>), LongArr(Vec<i64>),
}
impl NbtVal {
    fn as_int(&self) -> Option<i32> {
        match self { NbtVal::Byte(v) => Some(*v as i32), NbtVal::Short(v) => Some(*v as i32),
            NbtVal::Int(v) => Some(*v), _ => None }
    }
    fn as_str(&self) -> Option<&str> { if let NbtVal::Str(s) = self { Some(s) } else { None } }
    fn as_compound(&self) -> Option<&HashMap<String, NbtVal>> {
        if let NbtVal::Compound(m) = self { Some(m) } else { None }
    }
    fn as_list(&self) -> Option<&[NbtVal]> { if let NbtVal::List(v) = self { Some(v) } else { None } }
    fn as_long_arr(&self) -> Option<&[i64]> { if let NbtVal::LongArr(v) = self { Some(v) } else { None } }
    fn as_byte_arr(&self) -> Option<&[u8]> { if let NbtVal::ByteArr(v) = self { Some(v) } else { None } }
    fn get(&self, key: &str) -> Option<&NbtVal> { self.as_compound()?.get(key) }
}

const NBT_MAX_DEPTH: u8 = 64;

pub(crate) fn nbt_parse_val(d: &[u8], pos: &mut usize, tag: u8) -> Option<NbtVal> {
    nbt_parse_val_d(d, pos, tag, 0)
}

fn nbt_parse_val_d(d: &[u8], pos: &mut usize, tag: u8, depth: u8) -> Option<NbtVal> {
    if depth > NBT_MAX_DEPTH { return None; }
    match tag {
        1 => Some(NbtVal::Byte(nbt_read_u8(d, pos)? as i8)),
        2 => Some(NbtVal::Short(nbt_read_be_i16(d, pos)?)),
        3 => { let v = nbt_read_be_i32(d, pos)?; Some(NbtVal::Int(v)) }
        4 => {
            if *pos + 8 > d.len() { return None; }
            let v = i64::from_be_bytes(d[*pos..*pos+8].try_into().unwrap()); *pos += 8;
            Some(NbtVal::Long(v))
        }
        5 => {
            if *pos + 4 > d.len() { return None; }
            let v = f32::from_be_bytes(d[*pos..*pos+4].try_into().unwrap()); *pos += 4;
            Some(NbtVal::Float(v))
        }
        6 => {
            if *pos + 8 > d.len() { return None; }
            let v = f64::from_be_bytes(d[*pos..*pos+8].try_into().unwrap()); *pos += 8;
            Some(NbtVal::Double(v))
        }
        7 => {
            // Length is a signed i32 in the format but must be non-negative; guard the sign and
            // compare against remaining bytes with saturating_sub so `*pos + len` can't overflow.
            let len = nbt_read_be_i32(d, pos)?;
            if len < 0 || len as usize > d.len().saturating_sub(*pos) { return None; }
            let len = len as usize;
            let v = d[*pos..*pos+len].to_vec(); *pos += len; Some(NbtVal::ByteArr(v))
        }
        8 => Some(NbtVal::Str(nbt_read_nbt_string(d, pos)?)),
        9 => {
            let et = nbt_read_u8(d, pos)?;
            let n  = nbt_read_be_i32(d, pos)?;
            if n < 0 { return None; }
            // Cap the preallocation: a hostile count must not drive a huge Vec::with_capacity. The
            // loop is still bounded by the actual data (each element read is bounds-checked).
            let mut list = Vec::with_capacity((n as usize).min(1024));
            for _ in 0..n { list.push(nbt_parse_val_d(d, pos, et, depth + 1)?); }
            Some(NbtVal::List(list))
        }
        10 => {
            let mut map = HashMap::new();
            loop {
                let t = nbt_read_u8(d, pos)?;
                if t == 0 { break; }
                let k = nbt_read_nbt_string(d, pos)?;
                let v = nbt_parse_val_d(d, pos, t, depth + 1)?;
                map.insert(k, v);
            }
            Some(NbtVal::Compound(map))
        }
        11 => {
            let n = nbt_read_be_i32(d, pos)?;
            if n < 0 { return None; }
            let n = n as usize;
            let mut arr = Vec::with_capacity(n.min(1 << 16));
            for _ in 0..n {
                if *pos + 4 > d.len() { return None; }
                arr.push(i32::from_be_bytes(d[*pos..*pos+4].try_into().unwrap())); *pos += 4;
            }
            Some(NbtVal::IntArr(arr))
        }
        12 => {
            let n = nbt_read_be_i32(d, pos)?;
            if n < 0 { return None; }
            let n = n as usize;
            let mut arr = Vec::with_capacity(n.min(1 << 16));
            for _ in 0..n {
                if *pos + 8 > d.len() { return None; }
                arr.push(i64::from_be_bytes(d[*pos..*pos+8].try_into().unwrap())); *pos += 8;
            }
            Some(NbtVal::LongArr(arr))
        }
        _ => None,
    }
}

pub(crate) fn nbt_parse_root(d: &[u8]) -> Option<NbtVal> {
    let pos = &mut 0usize;
    let tag = nbt_read_u8(d, pos)?;
    if tag != 10 { return None; }
    nbt_skip_nbt_string(d, pos)?;
    nbt_parse_val(d, pos, 10)
}

// ── Litematica parser ─────────────────────────────────────────────────────────

pub(crate) struct LitematicRegion {
    pos_x: i32, pos_y: i32, pos_z: i32,
    size_x: i32, size_y: i32, size_z: i32,
    /// (block_name, properties_map)
    palette: Vec<(String, HashMap<String, String>)>,
    states: Vec<i64>,
}

pub(crate) fn unpack_state(states: &[i64], index: usize, bits: u32) -> u32 {
    if bits == 0 { return 0; }
    let bit_pos = index * bits as usize;
    let li = bit_pos / 64;
    let bo = (bit_pos % 64) as u32;
    let mask = if bits >= 64 { u64::MAX } else { (1u64 << bits) - 1 };
    let lo = if li < states.len() { (states[li] as u64) >> bo } else { 0 };
    let hi = if bo + bits > 64 && li + 1 < states.len() {
        (states[li + 1] as u64) << (64 - bo)
    } else { 0 };
    ((lo | hi) & mask) as u32
}

pub(crate) fn parse_litematic_bytes(raw: &[u8]) -> Result<Vec<LitematicRegion>, String> {
    let d = gunzip_capped(raw)?;

    let root = nbt_parse_root(&d).ok_or("NBT parse failed")?;
    let regions_nbt = root.get("Regions").ok_or("Missing Regions")?;
    let regions_map = regions_nbt.as_compound().ok_or("Regions not a compound")?;

    let mut out = Vec::new();
    for rv in regions_map.values() {
        let r = rv.as_compound().ok_or("Region not compound")?;

        let get_xyz = |key: &str| -> (i32, i32, i32) {
            let c = r.get(key).and_then(|v| v.as_compound());
            let x = c.and_then(|m| m.get("x")).and_then(|v| v.as_int()).unwrap_or(0);
            let y = c.and_then(|m| m.get("y")).and_then(|v| v.as_int()).unwrap_or(0);
            let z = c.and_then(|m| m.get("z")).and_then(|v| v.as_int()).unwrap_or(0);
            (x, y, z)
        };
        let (pos_x, pos_y, pos_z) = get_xyz("Position");
        let (size_x, size_y, size_z) = get_xyz("Size");

        let pal_list = r.get("BlockStatePalette")
            .and_then(|v| v.as_list()).ok_or("Missing BlockStatePalette")?;
        let mut palette = Vec::new();
        for entry in pal_list {
            let name = entry.get("Name").and_then(|v| v.as_str())
                .unwrap_or("minecraft:air").to_string();
            let props: HashMap<String, String> = entry.get("Properties")
                .and_then(|v| v.as_compound())
                .map(|m| m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect())
                .unwrap_or_default();
            palette.push((name, props));
        }

        let states = r.get("BlockStates")
            .and_then(|v| v.as_long_arr()).ok_or("Missing BlockStates")?.to_vec();

        out.push(LitematicRegion { pos_x, pos_y, pos_z, size_x, size_y, size_z, palette, states });
    }
    Ok(out)
}

// ── Shared apply logic ────────────────────────────────────────────────────────

/// A user override entry: mc_id → (eden_type, eden_paint).
/// mc_id for .schematic = "id" or "id:meta"; for .litematic = block name without "minecraft:".
#[derive(serde::Deserialize, Clone)]
pub(crate) struct MappingEntry {
    mc_id: String,
    eden_type: u8,
    eden_paint: u8,
}

pub(crate) fn apply_mapping_lookup(
    overrides: &[MappingEntry],
) -> HashMap<&str, (u8, u8)> {
    overrides.iter().map(|e| (e.mc_id.as_str(), (e.eden_type, e.eden_paint))).collect()
}

/// Convert schematic blocks to Eden clipboard with optional mapping overrides.
pub(crate) fn schematic_to_clipboard(
    sc_w: usize, sc_h: usize, sc_l: usize,
    get_block: impl Fn(usize, usize, usize) -> (u8, u8), // (eden_type, eden_paint) per (mc_x, mc_y, mc_z)
) -> Clipboard {
    let eden_w = sc_w;
    let eden_h = sc_l; // MC Z → Eden Y
    let eden_d = sc_h; // MC Y → Eden Z
    let size = eden_w * eden_h * eden_d;
    let mut block_types = vec![0u8; size];
    let mut paints = vec![0u8; size];
    for mc_y in 0..sc_h {
        for mc_z in 0..sc_l {
            for mc_x in 0..sc_w {
                let (et, ep) = get_block(mc_x, mc_y, mc_z);
                if et == 0 { continue; }
                let idx = mc_y * eden_h * eden_w + mc_z * eden_w + mc_x;
                if idx < size { block_types[idx] = et; paints[idx] = ep; }
            }
        }
    }
    Clipboard { width: eden_w as i32, height: eden_h as i32, depth: eden_d as i32,
        z_anchor: 0, block_types, paints }
}

// ── NBT parser (minimal, for MCEdit .schematic only) ─────────────────────────

pub(crate) fn nbt_read_u8(d: &[u8], pos: &mut usize) -> Option<u8> {
    if *pos >= d.len() { return None; }
    let v = d[*pos]; *pos += 1; Some(v)
}
pub(crate) fn nbt_read_be_i16(d: &[u8], pos: &mut usize) -> Option<i16> {
    if *pos + 2 > d.len() { return None; }
    let v = i16::from_be_bytes([d[*pos], d[*pos+1]]); *pos += 2; Some(v)
}
pub(crate) fn nbt_read_be_i32(d: &[u8], pos: &mut usize) -> Option<i32> {
    if *pos + 4 > d.len() { return None; }
    let v = i32::from_be_bytes(d[*pos..*pos+4].try_into().unwrap()); *pos += 4; Some(v)
}
pub(crate) fn nbt_skip_nbt_string(d: &[u8], pos: &mut usize) -> Option<()> {
    // NBT string lengths are unsigned u16 — read the raw bits as u16, not i16, so a length above
    // 32767 isn't misread as negative (which `as usize` would blow up into a huge value and wrap
    // the bounds check).
    let len = nbt_read_be_i16(d, pos)? as u16 as usize;
    if len > d.len().saturating_sub(*pos) { return None; }
    *pos += len; Some(())
}
pub(crate) fn nbt_read_nbt_string(d: &[u8], pos: &mut usize) -> Option<String> {
    let len = nbt_read_be_i16(d, pos)? as u16 as usize;
    if len > d.len().saturating_sub(*pos) { return None; }
    let s = std::str::from_utf8(&d[*pos..*pos+len]).ok()?.to_string();
    *pos += len; Some(s)
}
pub(crate) fn nbt_skip_payload(d: &[u8], pos: &mut usize, tag: u8) -> Option<()> {
    match tag {
        1 => { if *pos < d.len() { *pos += 1; } else { return None; } }
        2 => { if *pos + 2 <= d.len() { *pos += 2; } else { return None; } }
        3 => { if *pos + 4 <= d.len() { *pos += 4; } else { return None; } }
        4 | 6 => { if *pos + 8 <= d.len() { *pos += 8; } else { return None; } }
        5 => { if *pos + 4 <= d.len() { *pos += 4; } else { return None; } }
        7 => {
            let len = nbt_read_be_i32(d, pos)? as usize;
            if *pos + len > d.len() { return None; }
            *pos += len;
        }
        8 => { nbt_skip_nbt_string(d, pos)?; }
        9 => {
            let elem_type = nbt_read_u8(d, pos)?;
            let count = nbt_read_be_i32(d, pos)?;
            for _ in 0..count { nbt_skip_payload(d, pos, elem_type)?; }
        }
        10 => {
            loop {
                let t = nbt_read_u8(d, pos)?;
                if t == 0 { break; }
                nbt_skip_nbt_string(d, pos)?;
                nbt_skip_payload(d, pos, t)?;
            }
        }
        11 => {
            let count = nbt_read_be_i32(d, pos)? as usize;
            if *pos + count * 4 > d.len() { return None; }
            *pos += count * 4;
        }
        12 => {
            let count = nbt_read_be_i32(d, pos)? as usize;
            if *pos + count * 8 > d.len() { return None; }
            *pos += count * 8;
        }
        _ => return None,
    }
    Some(())
}

// ── Sponge .schem parser ──────────────────────────────────────────────────────

pub(crate) struct ParsedSchem {
    width: i32, height: i32, length: i32,
    palette: Vec<String>,  // palette_index → full block-state string e.g. "minecraft:oak_stairs[facing=north]"
    blocks: Vec<u32>,      // varint-decoded palette indices, order: (y*length + z)*width + x
}

pub(crate) fn parse_schem_bytes(raw: &[u8]) -> Result<ParsedSchem, String> {
    let d = gunzip_capped(raw)?;
    let root = nbt_parse_root(&d).ok_or("NBT parse failed")?;

    let width  = root.get("Width") .and_then(|v| v.as_int()).ok_or("Missing Width")?;
    let height = root.get("Height").and_then(|v| v.as_int()).ok_or("Missing Height")?;
    let length = root.get("Length").and_then(|v| v.as_int()).ok_or("Missing Length")?;

    // Palette: compound of { block_state_string → int_index }
    let pal_map = root.get("Palette")
        .and_then(|v| v.as_compound())
        .ok_or("Missing Palette")?;
    let pal_size = pal_map.len();
    let mut palette = vec![String::new(); pal_size];
    for (name, val) in pal_map {
        let idx = val.as_int().ok_or("Palette value not int")? as usize;
        if idx < pal_size { palette[idx] = name.clone(); }
    }

    // BlockData: varint-packed byte array
    let block_data = root.get("BlockData")
        .and_then(|v| v.as_byte_arr())
        .ok_or("Missing BlockData")?;

    let vol = (width * height * length) as usize;
    let mut blocks = Vec::with_capacity(vol);
    let mut i = 0;
    while i < block_data.len() && blocks.len() < vol {
        let mut val = 0u32;
        let mut shift = 0u32;
        loop {
            if i >= block_data.len() { return Err("varint truncated".into()); }
            let b = block_data[i] as u32; i += 1;
            val |= (b & 0x7F) << shift;
            shift += 7;
            if b & 0x80 == 0 { break; }
            if shift >= 35 { return Err("varint overflow".into()); }
        }
        blocks.push(val);
    }

    Ok(ParsedSchem { width, height, length, palette, blocks })
}

/// Parse "minecraft:oak_stairs[facing=north,half=bottom]" into (name, props).
pub(crate) fn split_block_state(s: &str) -> (&str, HashMap<String, String>) {
    if let Some(bi) = s.find('[') {
        let name = &s[..bi];
        let rest = s[bi+1..].trim_end_matches(']');
        let props = rest.split(',').filter_map(|kv| {
            let mut it = kv.splitn(2, '=');
            Some((it.next()?.to_string(), it.next()?.to_string()))
        }).collect();
        (name, props)
    } else {
        (s, HashMap::new())
    }
}

// ── MCEdit .schematic parser ──────────────────────────────────────────────────

pub(crate) struct ParsedSchematic {
    width: u16, height: u16, length: u16,
    blocks: Vec<u8>, data_arr: Vec<u8>,
}

pub(crate) fn parse_schematic_bytes(raw: &[u8]) -> Result<ParsedSchematic, String> {
    let d = gunzip_capped(raw)?;
    let pos = &mut 0usize;
    if nbt_read_u8(&d, pos).ok_or("truncated")? != 10 { return Err("not compound root".into()); }
    nbt_skip_nbt_string(&d, pos).ok_or("root name")?;
    let (mut width, mut height, mut length) = (None::<u16>, None::<u16>, None::<u16>);
    let (mut blocks, mut data_arr) = (None::<Vec<u8>>, None::<Vec<u8>>);
    loop {
        let t = nbt_read_u8(&d, pos).ok_or("end")?; if t == 0 { break; }
        let name = nbt_read_nbt_string(&d, pos).ok_or("name")?;
        match (t, name.as_str()) {
            (2, "Width")  => { width  = Some(nbt_read_be_i16(&d, pos).ok_or("W")? as u16); }
            (2, "Height") => { height = Some(nbt_read_be_i16(&d, pos).ok_or("H")? as u16); }
            (2, "Length") => { length = Some(nbt_read_be_i16(&d, pos).ok_or("L")? as u16); }
            (7, "Blocks") => {
                let n = nbt_read_be_i32(&d, pos).ok_or("bl")? as usize;
                if *pos + n > d.len() { return Err("blocks truncated".into()); }
                blocks = Some(d[*pos..*pos+n].to_vec()); *pos += n;
            }
            (7, "Data") => {
                let n = nbt_read_be_i32(&d, pos).ok_or("da")? as usize;
                if *pos + n > d.len() { return Err("data truncated".into()); }
                data_arr = Some(d[*pos..*pos+n].to_vec()); *pos += n;
            }
            _ => { nbt_skip_payload(&d, pos, t).ok_or_else(|| format!("skip {name}"))?; }
        }
    }
    Ok(ParsedSchematic {
        width: width.ok_or("no Width")?, height: height.ok_or("no Height")?,
        length: length.ok_or("no Length")?, blocks: blocks.ok_or("no Blocks")?,
        data_arr: data_arr.unwrap_or_default(),
    })
}

// ── Unified info / apply commands ─────────────────────────────────────────────

#[derive(Serialize)]
pub(crate) struct SchematicBlockEntry {
    mc_id: String,
    count: u32,
    eden_type: u8,
    eden_paint: u8,
}

#[derive(Serialize)]
pub(crate) struct SchematicInfo {
    format: String,          // "schematic" | "litematic"
    mc_width: u32,
    mc_height: u32,
    mc_length: u32,
    eden_width: u32,
    eden_height: u32,
    eden_depth: u32,
    block_count: u32,
    unique_blocks: Vec<SchematicBlockEntry>,
    too_large: bool,
}

pub(crate) fn is_litematic(path: &str) -> bool {
    path.to_lowercase().ends_with(".litematic")
}
pub(crate) fn is_schem(path: &str) -> bool {
    path.to_lowercase().ends_with(".schem")
}

#[tauri::command]
pub(crate) fn import_schematic_info(path: String) -> Result<SchematicInfo, String> {
    let raw = fs::read(&path).map_err(|e| format!("Read: {e}"))?;

    if is_litematic(&path) {
        // ── Litematica ──────────────────────────────────────────────────────
        let regions = parse_litematic_bytes(&raw)?;
        if regions.is_empty() { return Err("No regions found".into()); }

        // Combined bounding box (use absolute sizes, pos as min corner)
        let mut gmin_x = i32::MAX; let mut gmin_y = i32::MAX; let mut gmin_z = i32::MAX;
        let mut gmax_x = i32::MIN; let mut gmax_y = i32::MIN; let mut gmax_z = i32::MIN;
        for r in &regions {
            let (ax, ay, az) = (r.size_x.unsigned_abs() as i32,
                                r.size_y.unsigned_abs() as i32,
                                r.size_z.unsigned_abs() as i32);
            gmin_x = gmin_x.min(r.pos_x); gmax_x = gmax_x.max(r.pos_x + ax);
            gmin_y = gmin_y.min(r.pos_y); gmax_y = gmax_y.max(r.pos_y + ay);
            gmin_z = gmin_z.min(r.pos_z); gmax_z = gmax_z.max(r.pos_z + az);
        }
        let (tot_x, tot_y, tot_z) = ((gmax_x-gmin_x) as u32, (gmax_y-gmin_y) as u32, (gmax_z-gmin_z) as u32);

        // Count unique named blocks across all regions
        let mut counts: HashMap<String, u32> = HashMap::new();
        for r in &regions {
            let palette_sz = r.palette.len();
            if palette_sz == 0 { continue; }
            let bits = (usize::BITS - (palette_sz.saturating_sub(1)).leading_zeros()).max(4);
            let ax = r.size_x.unsigned_abs() as usize;
            let ay = r.size_y.unsigned_abs() as usize;
            let az = r.size_z.unsigned_abs() as usize;
            let vol = ax * ay * az;
            for i in 0..vol {
                let pi = unpack_state(&r.states, i, bits) as usize;
                let (name, _) = &r.palette[pi.min(palette_sz - 1)];
                let id = name.strip_prefix("minecraft:").unwrap_or(name);
                if id == "air" || id == "cave_air" || id == "void_air" { continue; }
                *counts.entry(id.to_string()).or_insert(0) += 1;
            }
        }

        let block_count: u32 = counts.values().sum();
        let too_large = tot_x > 256 || tot_y > 256 || tot_z > 256;

        // For the info table, we map by name only (no properties — properties affect direction
        // but don't change the block type shown, and we want one row per block type).
        let mut unique_blocks: Vec<SchematicBlockEntry> = counts.into_iter().map(|(mc_id, count)| {
            let (eden_type, eden_paint) = mc_named_to_eden(
                &format!("minecraft:{mc_id}"), None,
            );
            SchematicBlockEntry { mc_id, count, eden_type, eden_paint }
        }).collect();
        unique_blocks.sort_by(|a, b| b.count.cmp(&a.count));

        Ok(SchematicInfo {
            format: "litematic".into(),
            mc_width: tot_x, mc_height: tot_y, mc_length: tot_z,
            eden_width: tot_x, eden_height: tot_z, eden_depth: tot_y,
            block_count, unique_blocks, too_large,
        })
    } else if is_schem(&path) {
        // ── Sponge .schem ───────────────────────────────────────────────────
        let sc = parse_schem_bytes(&raw)?;
        let pal_size = sc.palette.len();
        let mut counts: HashMap<String, u32> = HashMap::new();
        for &pi in &sc.blocks {
            let state = sc.palette.get(pi as usize).map(|s| s.as_str()).unwrap_or("");
            let (name, _) = split_block_state(state);
            let id = name.strip_prefix("minecraft:").unwrap_or(name);
            if id.is_empty() || id == "air" || id == "cave_air" || id == "void_air" { continue; }
            *counts.entry(id.to_string()).or_insert(0) += 1;
        }
        let block_count: u32 = counts.values().sum();
        let too_large = sc.width > 256 || sc.height > 256 || sc.length > 256;
        let mut unique_blocks: Vec<SchematicBlockEntry> = counts.into_iter().map(|(mc_id, count)| {
            let (eden_type, eden_paint) = mc_named_to_eden(&format!("minecraft:{mc_id}"), None);
            SchematicBlockEntry { mc_id, count, eden_type, eden_paint }
        }).collect();
        unique_blocks.sort_by(|a, b| b.count.cmp(&a.count));
        let _ = pal_size;
        Ok(SchematicInfo {
            format: "schem".into(),
            mc_width: sc.width as u32, mc_height: sc.height as u32, mc_length: sc.length as u32,
            eden_width: sc.width as u32, eden_height: sc.length as u32, eden_depth: sc.height as u32,
            block_count, unique_blocks, too_large,
        })
    } else {
        // ── MCEdit .schematic ───────────────────────────────────────────────
        let sc = parse_schematic_bytes(&raw)?;
        let mut counts: HashMap<(u8, u8), u32> = HashMap::new();
        let data_len = sc.data_arr.len();
        for (i, &id) in sc.blocks.iter().enumerate() {
            if id == 0 { continue; }
            let meta = if i < data_len { sc.data_arr[i] & 0x0F } else { 0 };
            *counts.entry((id, meta)).or_insert(0) += 1;
        }
        let block_count: u32 = counts.values().sum();
        let too_large = sc.width > 256 || sc.height > 256 || sc.length > 256;
        let mut unique_blocks: Vec<SchematicBlockEntry> = counts.into_iter().map(|((id, meta), count)| {
            let (eden_type, eden_paint) = mc_to_eden(id, meta);
            let mc_id = if meta == 0 { id.to_string() } else { format!("{id}:{meta}") };
            SchematicBlockEntry { mc_id, count, eden_type, eden_paint }
        }).collect();
        unique_blocks.sort_by(|a, b| b.count.cmp(&a.count));
        Ok(SchematicInfo {
            format: "schematic".into(),
            mc_width: sc.width as u32, mc_height: sc.height as u32, mc_length: sc.length as u32,
            eden_width: sc.width as u32, eden_height: sc.length as u32, eden_depth: sc.height as u32,
            block_count, unique_blocks, too_large,
        })
    }
}

#[tauri::command]
pub(crate) fn import_schematic_apply(
    path: String,
    mapping: Vec<MappingEntry>,
    state: tauri::State<'_, AppState>,
) -> Result<ClipboardInfo, String> {
    let raw = fs::read(&path).map_err(|e| format!("Read: {e}"))?;
    let overrides = apply_mapping_lookup(&mapping);

    let cb = if is_litematic(&path) {
        // ── Litematica ──────────────────────────────────────────────────────
        let regions = parse_litematic_bytes(&raw)?;
        if regions.is_empty() { return Err("No regions".into()); }

        // Combined bounding box
        let mut gmin_x = i32::MAX; let mut gmin_y = i32::MAX; let mut gmin_z = i32::MAX;
        let mut gmax_x = i32::MIN; let mut gmax_y = i32::MIN; let mut gmax_z = i32::MIN;
        for r in &regions {
            let (ax, ay, az) = (r.size_x.unsigned_abs() as i32,
                                r.size_y.unsigned_abs() as i32,
                                r.size_z.unsigned_abs() as i32);
            gmin_x = gmin_x.min(r.pos_x); gmax_x = gmax_x.max(r.pos_x + ax);
            gmin_y = gmin_y.min(r.pos_y); gmax_y = gmax_y.max(r.pos_y + ay);
            gmin_z = gmin_z.min(r.pos_z); gmax_z = gmax_z.max(r.pos_z + az);
        }
        // MC: x=east(width), y=up(height), z=south(length) → Eden: X=x, Y=z, Z=y
        let mc_w = (gmax_x - gmin_x) as usize;
        let mc_h = (gmax_y - gmin_y) as usize;
        let mc_l = (gmax_z - gmin_z) as usize;
        let size = mc_w * mc_h * mc_l;
        let mut bt = vec![0u8; size];
        let mut pt = vec![0u8; size];

        for r in &regions {
            let (ax, ay, az) = (r.size_x.unsigned_abs() as usize,
                                r.size_y.unsigned_abs() as usize,
                                r.size_z.unsigned_abs() as usize);
            let palette_sz = r.palette.len();
            if palette_sz == 0 { continue; }
            let bits = (usize::BITS - (palette_sz.saturating_sub(1)).leading_zeros()).max(4);
            let off_x = (r.pos_x - gmin_x) as usize;
            let off_y = (r.pos_y - gmin_y) as usize;
            let off_z = (r.pos_z - gmin_z) as usize;

            // Litematica iteration order: Y outer, Z middle, X inner
            for ly in 0..ay {
                for lz in 0..az {
                    for lx in 0..ax {
                        let li = ly * az * ax + lz * ax + lx;
                        let pi = unpack_state(&r.states, li, bits) as usize;
                        let (name, props) = &r.palette[pi.min(palette_sz - 1)];
                        let short = name.strip_prefix("minecraft:").unwrap_or(name);
                        let (et, ep) = overrides.get(short).copied()
                            .unwrap_or_else(|| mc_named_to_eden(name, Some(props)));
                        if et == 0 { continue; }
                        // World coords (mc_x, mc_y, mc_z); axis-swap to Eden: dy=mc_z, dz=mc_y
                        let wx = off_x + lx;
                        let wy = off_y + ly; // mc_y → Eden Z
                        let wz = off_z + lz; // mc_z → Eden Y
                        // Eden flat index: dz * eden_h * eden_w + dy * eden_w + dx
                        // eden_w = mc_w, eden_h = mc_l, eden_d = mc_h
                        let idx = wy * mc_l * mc_w + wz * mc_w + wx;
                        if idx < size { bt[idx] = et; pt[idx] = ep; }
                    }
                }
            }
        }
        Clipboard { width: mc_w as i32, height: mc_l as i32, depth: mc_h as i32,
            z_anchor: 0, block_types: bt, paints: pt }
    } else if is_schem(&path) {
        // ── Sponge .schem ───────────────────────────────────────────────────
        let sc = parse_schem_bytes(&raw)?;
        let (mc_w, mc_h, mc_l) = (sc.width as usize, sc.height as usize, sc.length as usize);
        schematic_to_clipboard(mc_w, mc_h, mc_l, |mc_x, mc_y, mc_z| {
            let mi = (mc_y * mc_l + mc_z) * mc_w + mc_x;
            let pi = sc.blocks.get(mi).copied().unwrap_or(0) as usize;
            let state = sc.palette.get(pi).map(|s| s.as_str()).unwrap_or("");
            let (name, props) = split_block_state(state);
            let short = name.strip_prefix("minecraft:").unwrap_or(name);
            if short.is_empty() || short == "air" || short == "cave_air" || short == "void_air" {
                return (0, 0);
            }
            overrides.get(short).copied()
                .unwrap_or_else(|| mc_named_to_eden(name, Some(&props)))
        })
    } else {
        // ── MCEdit .schematic ───────────────────────────────────────────────
        let sc = parse_schematic_bytes(&raw)?;
        let (mc_w, mc_h, mc_l) = (sc.width as usize, sc.height as usize, sc.length as usize);
        let data_len = sc.data_arr.len();
        schematic_to_clipboard(mc_w, mc_h, mc_l, |mc_x, mc_y, mc_z| {
            let mi = mc_y * mc_w * mc_l + mc_z * mc_w + mc_x;
            if mi >= sc.blocks.len() { return (0, 0); }
            let id = sc.blocks[mi];
            if id == 0 { return (0, 0); }
            let meta = if mi < data_len { sc.data_arr[mi] & 0x0F } else { 0 };
            let mc_id = if meta == 0 { id.to_string() } else { format!("{id}:{meta}") };
            overrides.get(mc_id.as_str()).copied().unwrap_or_else(|| mc_to_eden(id, meta))
        })
    };

    let info = ClipboardInfo { width: cb.width, height: cb.height, depth: cb.depth, z_anchor: cb.z_anchor };
    state.lock().unwrap_or_else(|p| p.into_inner()).clipboard = Some(cb);
    Ok(info)
}

