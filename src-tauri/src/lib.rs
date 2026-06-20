use base64::{engine::general_purpose::STANDARD, Engine as _};
use memmap2::{MmapMut, MmapOptions};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufWriter, Write};
use std::sync::Mutex;
use std::time::Instant;
use tauri::Emitter;

fn serialize_bytes_b64<S: serde::Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&STANDARD.encode(bytes))
}

fn is_zip(buf: &[u8]) -> bool {
    buf.starts_with(&[0x50, 0x4B, 0x03, 0x04])
}

fn temp_world_path() -> std::path::PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!("vuencedit_{ts}.eden"))
}

// ── Public types ─────────────────────────────────────────────────────────────

/// Lightweight world metadata returned by load_world. No pixel buffer — the
/// frontend fetches tiles on demand via fetch_tile / render_zslice_patch.
#[derive(Serialize)]
pub struct WorldMeta {
    pub name: String,
    pub width_chunks: u32,
    pub height_chunks: u32,
    pub max_z: u32,
    pub was_compressed: bool,
}

/// Full pixel map — used only by render_zslice (kept for legacy callers).
#[derive(Serialize)]
pub struct WorldData {
    pub name: String,
    pub width_chunks: u32,
    pub height_chunks: u32,
    #[serde(serialize_with = "serialize_bytes_b64")]
    pub pixels: Vec<u8>,
    pub max_z: u32,
}

// ── In-memory world state ────────────────────────────────────────────────────

struct LoadedWorld {
    /// Private copy-on-write mapping of the world file. Reads are file-backed and evictable
    /// under OS memory pressure; writes COW only the touched 4 KB page. The original file
    /// on disk is never modified — saves are explicit fs::write calls.
    bytes: MmapMut,
    /// Maps (chunk_cx, chunk_cy) → byte offset of that chunk's data block in `bytes`.
    chunk_map: HashMap<(i32, i32), usize>,
    /// Chunk block size in bytes: 32768 for 64-layer worlds, 131072 for 256-layer worlds.
    chunk_size: usize,
    /// Number of z-bands per chunk: 4 (64z) or 16 (256z). Each band covers 16 z-layers.
    num_bands: usize,
    min_x: i32,
    min_y: i32,
    w_chunks: u32,
    h_chunks: u32,
    name: String,
    sky: u8,
}

// ── Undo / Redo state ─────────────────────────────────────────────────────────

struct ChunkSnapshot {
    cx: i16,
    cy: i16,
    data: Vec<u8>,
}

struct UndoEntry {
    operation: String,
    chunks: Vec<ChunkSnapshot>,
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

/// In-memory clipboard populated by copy_selection. Never serialised over IPC —
/// only ClipboardInfo (dimensions) is sent to the frontend.
struct Clipboard {
    width: i32,
    height: i32,
    depth: i32,
    /// zMin from the copy selection; paste always restores blocks at z_anchor..z_anchor+depth-1.
    z_anchor: i32,
    /// Flat [dz * height * width + dy * width + dx]
    block_types: Vec<u8>,
    paints: Vec<u8>,
}

#[derive(Serialize)]
struct ClipboardInfo {
    width: i32,
    height: i32,
    depth: i32,
    z_anchor: i32,
}

/// A single block position for the paint_blocks command.
/// z = None → resolve surface_z in Rust; z = Some(v) → write at that exact level.
#[derive(serde::Deserialize)]
struct PaintBlock {
    x: i32,
    y: i32,
    z: Option<i32>,
}

struct WorldState {
    world: Option<LoadedWorld>,
    clipboard: Option<Clipboard>,
    undo_stack: VecDeque<UndoEntry>,
    redo_stack: VecDeque<UndoEntry>,
    /// Path to the decompressed temp file when the current world was opened from a zip.
    /// Deleted after the mmap is dropped on next world load.
    temp_path: Option<std::path::PathBuf>,
}

impl WorldState {
    fn new() -> Self {
        WorldState { world: None, clipboard: None, undo_stack: VecDeque::new(), redo_stack: VecDeque::new(), temp_path: None }
    }
}

pub(crate) type AppState = Mutex<WorldState>;

// ── Eden server configuration ────────────────────────────────────────────────

struct EdenServer {
    search_url: &'static str,
    download_base_url: &'static str,
    upload_url: &'static str,
}

const CURRENT_SERVER: EdenServer = EdenServer {
    search_url: "http://app2.edengame.net/list2.php",
    download_base_url: "http://files2.edengame.net",
    upload_url: "http://app2.edengame.net/upload2.php",
};

const LEGACY_SERVER: EdenServer = EdenServer {
    search_url: "http://app.edengame.net/list2.php",
    download_base_url: "http://files.edengame.net",
    upload_url: "http://app.edengame.net/upload2.php",
};

fn get_server(server: &str) -> Result<&'static EdenServer, String> {
    match server {
        "current" => Ok(&CURRENT_SERVER),
        "legacy"  => Ok(&LEGACY_SERVER),
        _         => Err(format!("Unknown server: {server}")),
    }
}

#[derive(serde::Serialize, Clone)]
struct WorldSearchResult {
    id: String,
    name: String,
    timestamp: i64,
}

// ── Color system (HLS model, ported from la-map.c by Robert Munafo, GPL3) ─────

fn hsl_to_rgb(h: f32, l: f32, s: f32) -> [u8; 3] {
    let tc = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h / 60.0;
    if hp < 0.0 || hp >= 6.0 {
        let v = (l * 255.0).clamp(0.0, 255.0) as u8;
        return [v, v, v];
    }
    let hm2 = if hp >= 4.0 { hp - 4.0 } else if hp >= 2.0 { hp - 2.0 } else { hp };
    let tx = tc * (1.0 - (hm2 - 1.0).abs());
    let (fr, fg, fb): (f32, f32, f32) =
        if      hp < 1.0 { (tc, tx, 0.0) }
        else if hp < 2.0 { (tx, tc, 0.0) }
        else if hp < 3.0 { (0.0, tc, tx) }
        else if hp < 4.0 { (0.0, tx, tc) }
        else if hp < 5.0 { (tx, 0.0, tc) }
        else              { (tc, 0.0, tx) };
    let m = l - tc / 2.0;
    [
        ((fr + m).clamp(0.0, 1.0) * 255.0) as u8,
        ((fg + m).clamp(0.0, 1.0) * 255.0) as u8,
        ((fb + m).clamp(0.0, 1.0) * 255.0) as u8,
    ]
}

/// (hue 0-360, lightness 0-1, saturation 0-1, max_lt 0-1) per block type.
/// max_lt scales painted colours so the same paint reads differently on different materials.
fn block_hls(bt: u8) -> (f32, f32, f32, f32) {
    match bt {
        0  => (210.0, 0.80, 1.00, 1.00), // air
        1  => (  0.0, 0.20, 0.00, 0.60), // bedrock
        2  => (  0.0, 0.60, 0.00, 0.80), // stone
        3  => ( 30.0, 0.20, 1.00, 0.60), // dirt
        4  => ( 50.0, 0.80, 0.50, 0.80), // sand
        5  => (120.0, 0.20, 0.80, 0.65), // leaves
        6  => ( 30.0, 0.20, 1.00, 0.70), // trunk
        7  => ( 50.0, 0.75, 0.50, 0.70), // wood
        8  => (120.0, 0.25, 0.80, 0.60), // grass (sky override in block_color)
        9  => ( 30.0, 0.50, 0.70, 0.70), // TNT
        10 => (  0.0, 0.45, 0.00, 0.50), // dark stone
        11 => (120.0, 0.25, 0.80, 0.60), // weeds
        12 => (150.0, 0.25, 0.70, 0.60), // flowers
        13 => (  0.0, 0.40, 0.80, 0.70), // brick
        14 => (210.0, 0.25, 0.25, 0.40), // slate
        15 => (210.0, 0.80, 0.70, 0.90), // ice
        16 => (  0.0, 0.80, 0.00, 0.80), // wallpaper
        17 => (  0.0, 0.20, 0.00, 0.40), // bouncy
        18 => ( 50.0, 0.75, 0.50, 0.70), // ladder
        19 => (  0.0, 1.00, 0.00, 1.00), // cloud
        20 => (225.0, 0.40, 0.90, 0.90), // water
        21 => ( 50.0, 0.75, 0.50, 0.80), // fence
        22 => (120.0, 0.60, 0.30, 0.60), // ivy
        23 => ( 20.0, 0.40, 0.70, 0.60), // lava
        24..=27 | 40..=43       => (  0.0, 0.60, 0.00, 0.80), // stone ramps/wedges
        28..=31 | 44..=47       => ( 50.0, 0.75, 0.50, 0.70), // wood ramps/wedges
        32..=35 | 48..=51 | 56  => (  0.0, 0.40, 0.00, 0.45), // shingle ramps/wedges/block
        36..=39 | 52..=55       => (210.0, 0.80, 0.70, 0.90), // ice ramps/wedges
        57  => (  0.0, 0.90, 0.00, 0.90), // neon square
        58  => (210.0, 0.70, 0.20, 0.60), // glass
        59  => (225.0, 0.50, 0.90, 0.80), // water 3/4
        60  => (225.0, 0.60, 0.90, 0.85), // water 1/2
        61  => (225.0, 0.70, 0.90, 0.90), // water 1/4
        62  => ( 20.0, 0.50, 0.70, 0.50), // lava 3/4
        63  => ( 20.0, 0.60, 0.70, 0.55), // lava 1/2
        64  => ( 20.0, 0.70, 0.70, 0.60), // lava 1/4
        65  => ( 30.0, 0.50, 0.70, 0.70), // fireworks
        66..=70 => ( 40.0, 0.50, 0.70, 0.70), // doors
        71  => ( 50.0, 0.70, 0.50, 0.70), // treasure
        72  => ( 50.0, 0.80, 0.50, 0.90), // light
        73  => (150.0, 0.50, 0.70, 0.70), // new flower
        74  => (  0.0, 0.60, 0.00, 0.70), // steel
        75..=79 => (270.0, 0.45, 0.50, 0.60), // portals
        80..=81 => (  0.0, 0.50, 0.00, 0.50), // unused
        82  => (120.0, 0.25, 0.80, 0.60), // ExpGrass (sky override in block_color)
        83  => (  0.0, 0.40, 0.00, 0.50), // ExpDarkStone
        84  => (  0.0, 0.60, 0.00, 0.80), // ExpStone
        85  => ( 30.0, 0.40, 0.70, 0.60), // ExpDirt
        86  => ( 50.0, 0.80, 0.50, 0.80), // ExpSand
        87  => (  0.0, 0.50, 0.80, 0.70), // ExpTNT
        88  => ( 50.0, 0.75, 0.50, 0.70), // ExpWood
        89  => (  0.0, 0.40, 0.00, 0.45), // ExpShingle
        90  => (210.0, 0.70, 0.20, 0.60), // ExpGlass (transparent)
        91  => (180.0, 0.60, 0.90, 0.90), // ExpNeonSquare
        92  => ( 30.0, 0.20, 1.00, 0.70), // ExpTrunk
        93  => (120.0, 0.20, 0.80, 0.65), // ExpLeaves
        94  => (  0.0, 0.40, 0.80, 0.70), // ExpBrick
        95  => (210.0, 0.25, 0.25, 0.40), // ExpSlate
        96  => (120.0, 0.60, 0.30, 0.60), // ExpVines
        97  => (180.0, 0.60, 0.90, 0.90), // ExpLadder
        98  => (210.0, 0.80, 0.70, 0.90), // ExpIce
        99  => (  0.0, 0.80, 0.00, 0.80), // ExpWallpaper
        100 => (  0.0, 0.20, 0.00, 0.40), // ExpTrampoline
        101 => (  0.0, 1.00, 0.00, 1.00), // ExpCloud
        102..=105 => (  0.0, 0.40, 0.00, 0.50), // Exp slides
        106 => ( 50.0, 0.75, 0.50, 0.80), // ExpFence (transparent)
        107 => (225.0, 0.40, 0.90, 0.90), // ExpWater
        108 => ( 20.0, 0.40, 0.70, 0.60), // ExpLava
        109 => ( 30.0, 0.50, 0.70, 0.70), // ExpFirework
        110 => ( 50.0, 0.80, 0.50, 0.90), // ExpLight
        _   => (  0.0, 0.50, 0.00, 0.50),
    }
}

/// HLS for paint byte (1-54 = game paint colours; 0/other → unused, block_color guards against call).
fn paint_hls(paint: u8) -> (f32, f32, f32) {
    match paint {
        1  => (  0.0, 0.85, 1.00),  2  => ( 30.0, 0.85, 1.00),
        3  => ( 60.0, 0.85, 1.00),  4  => (120.0, 0.85, 1.00),
        5  => (180.0, 0.85, 1.00),  6  => (240.0, 0.85, 1.00),
        7  => (270.0, 0.85, 1.00),  8  => (300.0, 0.85, 1.00),
        9  => (  0.0, 1.00, 0.00), // white
        10 => (  0.0, 0.70, 1.00), 11 => ( 30.0, 0.70, 1.00),
        12 => ( 60.0, 0.70, 1.00), 13 => (120.0, 0.70, 1.00),
        14 => (180.0, 0.70, 1.00), 15 => (240.0, 0.70, 1.00),
        16 => (270.0, 0.70, 1.00), 17 => (300.0, 0.70, 1.00),
        18 => (  0.0, 0.80, 0.00), // 80% gray
        19 => (  0.0, 0.50, 1.00), 20 => ( 30.0, 0.50, 1.00),
        21 => ( 60.0, 0.50, 1.00), 22 => (120.0, 0.50, 1.00),
        23 => (180.0, 0.50, 1.00), 24 => (240.0, 0.50, 1.00),
        25 => (270.0, 0.50, 1.00), 26 => (300.0, 0.50, 1.00),
        27 => (  0.0, 0.60, 0.00), // 60% gray
        28 => (  0.0, 0.35, 1.00), 29 => ( 30.0, 0.35, 1.00),
        30 => ( 60.0, 0.35, 1.00), 31 => (120.0, 0.35, 1.00),
        32 => (180.0, 0.35, 1.00), 33 => (240.0, 0.35, 1.00),
        34 => (270.0, 0.35, 1.00), 35 => (300.0, 0.35, 1.00),
        36 => (  0.0, 0.40, 0.00), // 40% gray
        37 => (  0.0, 0.25, 1.00), 38 => ( 30.0, 0.25, 1.00),
        39 => ( 60.0, 0.25, 1.00), 40 => (120.0, 0.25, 1.00),
        41 => (180.0, 0.25, 1.00), 42 => (240.0, 0.25, 1.00),
        43 => (270.0, 0.25, 1.00), 44 => (300.0, 0.25, 1.00),
        45 => (  0.0, 0.20, 0.00), // 20% gray
        46 => (  0.0, 0.15, 1.00), 47 => ( 30.0, 0.15, 1.00),
        48 => ( 60.0, 0.15, 1.00), 49 => (120.0, 0.15, 1.00),
        50 => (180.0, 0.15, 1.00), 51 => (240.0, 0.15, 1.00),
        52 => (270.0, 0.15, 1.00), 53 => (300.0, 0.15, 1.00),
        54 => (  0.0, 0.00, 0.00), // black
        _  => (  0.0, 0.50, 0.00),
    }
}

/// Alpha (0–1) for a transparent block; None = opaque.
/// Glass/water are 50% transparent; fence nearly opaque at 90%; flower mostly see-through at 25%.
fn transparent_alpha(bt: u8) -> Option<f32> {
    match bt {
        20 | 59..=61 | 107 => Some(0.50), // water variants
        21 | 106           => Some(0.90), // fence (nearly opaque)
        58 | 90            => Some(0.50), // glass variants
        73                 => Some(0.25), // new flower
        _ => None,
    }
}

// ── Color helpers ─────────────────────────────────────────────────────────────

fn grass_color(sky: u8) -> [u8; 3] {
    match sky {
        11 => [242, 220, 140], // desert
        13 => [255, 255, 255], // snow
        _  => [ 82, 148,  53], // default green
    }
}

fn block_color(bt: u8, paint: u8, sky: u8) -> [u8; 3] {
    if bt == 0 { return [30, 30, 30]; }
    if bt == 8 || bt == 82 {
        return if paint != 0 {
            let (ph, pl, ps) = paint_hls(paint);
            let rgb = hsl_to_rgb(ph, pl, ps);
            [(rgb[0] as f32 * 0.60) as u8, (rgb[1] as f32 * 0.60) as u8, (rgb[2] as f32 * 0.60) as u8]
        } else { grass_color(sky) };
    }
    let (h, l, s, max_lt) = block_hls(bt);
    if paint != 0 {
        let (ph, pl, ps) = paint_hls(paint);
        let rgb = hsl_to_rgb(ph, pl, ps);
        [(rgb[0] as f32 * max_lt) as u8, (rgb[1] as f32 * max_lt) as u8, (rgb[2] as f32 * max_lt) as u8]
    } else {
        hsl_to_rgb(h, l, s)
    }
}

// ── World parsing ─────────────────────────────────────────────────────────────

fn parse_world_inner(bytes: MmapMut) -> Result<LoadedWorld, String> {
    if bytes.len() < 36 {
        return Err("File too small to be a valid .eden world".into());
    }

    // Sky color: scan bytes 132–148, majority vote of non-14 values
    let sky = {
        let candidates: Vec<u8> = bytes[132..149.min(bytes.len())]
            .iter().copied().filter(|&b| b != 14).collect();
        if candidates.is_empty() {
            14u8
        } else {
            let mut counts = [0u32; 256];
            for &b in &candidates { counts[b as usize] += 1; }
            counts.iter().enumerate().max_by_key(|(_, &c)| c)
                .map(|(i, _)| i as u8).unwrap_or(14)
        }
    };

    // World name: bytes 40–75, null-terminated ASCII
    let name_bytes = &bytes[40..76.min(bytes.len())];
    let name_end = name_bytes.iter().position(|&b| b == 0).unwrap_or(name_bytes.len());
    let name = String::from_utf8_lossy(&name_bytes[..name_end]).into_owned();

    // Chunk pointer table offset at bytes 32–35 (little-endian u32)
    let ptr_offset = u32::from_le_bytes([bytes[32], bytes[33], bytes[34], bytes[35]]) as usize;

    // Each chunk pointer entry is 16 bytes: X@[0..2], Y@[4..6], file_offset@[8..12]
    let mut chunk_map: HashMap<(i32, i32), usize> = HashMap::new();
    let mut i = ptr_offset;
    while i + 16 <= bytes.len() {
        let cx  = i16::from_le_bytes([bytes[i],     bytes[i + 1]]) as i32;
        let cy  = i16::from_le_bytes([bytes[i + 4], bytes[i + 5]]) as i32;
        let off = u32::from_le_bytes([bytes[i + 8], bytes[i + 9], bytes[i + 10], bytes[i + 11]]) as usize;
        if off + 32768 <= bytes.len() {
            chunk_map.insert((cx, cy), off);
        }
        i += 16;
    }

    if chunk_map.is_empty() {
        return Err("No valid chunks found".into());
    }

    // Detect whether this is a 64-layer world (32768 bytes/chunk, 4 bands) or a
    // 256-layer world (131072 bytes/chunk, 16 bands) by checking the minimum gap
    // between consecutive chunk offsets. Both formats use the same band formula:
    // addr + band * 8192 + x * 256 + y * 16 + z — only the band count differs.
    let chunk_size = {
        let mut offsets: Vec<usize> = chunk_map.values().copied().collect();
        offsets.sort_unstable();
        let min_gap = offsets.windows(2).map(|w| w[1] - w[0]).min().unwrap_or(32768);
        if min_gap >= 131072 { 131072 } else { 32768 }
    };
    let num_bands = chunk_size / 8192;

    let min_x = chunk_map.keys().map(|&(x, _)| x).min().unwrap();
    let min_y = chunk_map.keys().map(|&(_, y)| y).min().unwrap();
    let max_x = chunk_map.keys().map(|&(x, _)| x).max().unwrap();
    let max_y = chunk_map.keys().map(|&(_, y)| y).max().unwrap();

    Ok(LoadedWorld {
        bytes,
        chunk_map,
        chunk_size,
        num_bands,
        min_x,
        min_y,
        w_chunks: (max_x - min_x + 1) as u32,
        h_chunks: (max_y - min_y + 1) as u32,
        name,
        sky,
    })
}

fn world_max_z(world: &LoadedWorld) -> i32 {
    (world.num_bands * 16 - 1) as i32
}

// ── Pixel patch (partial re-render returned by all edit commands) ─────────────
//
// Instead of re-serialising the entire world pixel map after every edit (which
// is 243 MB for a 451×528-chunk world → ~850 MB JSON → 1.9 GB JS heap), edit
// commands now return only the changed rectangle. The frontend applies it with
// putImageData at (x, y) on the existing offscreen canvas.

#[derive(Serialize)]
struct PixelPatch {
    x: u32, y: u32,
    width: u32, height: u32,
    #[serde(serialize_with = "serialize_bytes_b64")]
    pixels: Vec<u8>,  // RGBA, row-major, (y, x) order — serialized as base64
}

/// Re-render just the sub-rectangle [px1,px2] × [py1,py2] of the top-down map.
/// Bounds are clamped to [0, world_W-1] × [0, world_H-1].
fn render_pixels_patch(world: &LoadedWorld, px1: i32, py1: i32, px2: i32, py2: i32) -> PixelPatch {
    let world_w = (world.w_chunks * 16) as i32;
    let world_h = (world.h_chunks * 16) as i32;
    let x1 = px1.clamp(0, world_w - 1) as u32;
    let y1 = py1.clamp(0, world_h - 1) as u32;
    let x2 = px2.clamp(0, world_w - 1) as u32;
    let y2 = py2.clamp(0, world_h - 1) as u32;
    let width  = x2 - x1 + 1;
    let height = y2 - y1 + 1;
    let mut pixels = vec![30u8; (width * height * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p[3] = 255; }

    for px in x1..=x2 {
        for py in y1..=y2 {
            let cx = (px / 16) as i32 + world.min_x;
            let cy = (py / 16) as i32 + world.min_y;
            let lx = (px % 16) as usize;
            let ly = (py % 16) as usize;
            let &addr = match world.chunk_map.get(&(cx, cy)) { Some(a) => a, None => continue };
            let mut top_bt = 0u8; let mut top_paint = 0u8;
            let mut under_bt = 0u8; let mut under_paint = 0u8;
            'outer: for band in (0..world.num_bands).rev() {
                for z in (0..16usize).rev() {
                    let bi = addr + band * 8192 + lx * 256 + ly * 16 + z;
                    let pi = bi + 4096;
                    if bi >= world.bytes.len() || pi >= world.bytes.len() { continue; }
                    let bt = world.bytes[bi];
                    if bt == 0 { continue; }
                    if top_bt == 0 {
                        top_bt = bt; top_paint = world.bytes[pi];
                        if transparent_alpha(bt).is_none() { break 'outer; }
                    } else {
                        under_bt = bt; under_paint = world.bytes[pi];
                        break 'outer;
                    }
                }
            }
            if top_bt == 0 { continue; }
            let c1 = block_color(top_bt, top_paint, world.sky);
            let [r, g, b] = if under_bt != 0 {
                if let Some(alpha) = transparent_alpha(top_bt) {
                    let c2 = block_color(under_bt, under_paint, world.sky);
                    [
                        (c1[0] as f32 * alpha + c2[0] as f32 * (1.0 - alpha)) as u8,
                        (c1[1] as f32 * alpha + c2[1] as f32 * (1.0 - alpha)) as u8,
                        (c1[2] as f32 * alpha + c2[2] as f32 * (1.0 - alpha)) as u8,
                    ]
                } else { c1 }
            } else { c1 };
            let off = (((py - y1) * width + (px - x1)) * 4) as usize;
            pixels[off] = r; pixels[off + 1] = g; pixels[off + 2] = b; pixels[off + 3] = 255;
        }
    }
    PixelPatch { x: x1, y: y1, width, height, pixels }
}

/// Re-render a sub-rectangle of a z-slice cross-section.
fn render_zslice_patch_inner(world: &LoadedWorld, z: i32, px1: i32, py1: i32, px2: i32, py2: i32) -> PixelPatch {
    let world_w = (world.w_chunks * 16) as i32;
    let world_h = (world.h_chunks * 16) as i32;
    let x1 = px1.clamp(0, world_w - 1) as u32;
    let y1 = py1.clamp(0, world_h - 1) as u32;
    let x2 = px2.clamp(0, world_w - 1) as u32;
    let y2 = py2.clamp(0, world_h - 1) as u32;
    let width  = x2 - x1 + 1;
    let height = y2 - y1 + 1;
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    let band = (z as usize) / 16;
    let lz   = (z as usize) % 16;

    for px in x1..=x2 {
        for py in y1..=y2 {
            let cx = (px / 16) as i32 + world.min_x;
            let cy = (py / 16) as i32 + world.min_y;
            let lx = (px % 16) as usize;
            let ly = (py % 16) as usize;
            let &addr = match world.chunk_map.get(&(cx, cy)) { Some(a) => a, None => continue };
            let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
            let pi = bi + 4096;
            if bi >= world.bytes.len() || pi >= world.bytes.len() { continue; }
            let bt = world.bytes[bi];
            if bt == 0 { continue; }
            let paint = world.bytes[pi];
            let [r, g, b] = block_color(bt, paint, world.sky);
            let off = (((py - y1) * width + (px - x1)) * 4) as usize;
            pixels[off]     = r;
            pixels[off + 1] = g;
            pixels[off + 2] = b;
            pixels[off + 3] = 255;
        }
    }
    PixelPatch { x: x1, y: y1, width, height, pixels }
}

/// Compute the pixel-space bounding box of a set of chunk coordinates and
/// return a freshly rendered top-down patch for that rectangle.
/// Used by undo/redo where the affected region is known only as chunk coords.
fn patch_from_chunk_coords(world: &LoadedWorld, chunks: &[(i16, i16)]) -> PixelPatch {
    if chunks.is_empty() {
        return PixelPatch { x: 0, y: 0, width: 1, height: 1, pixels: vec![30, 30, 30, 255] };
    }
    let px1 = chunks.iter().map(|&(cx, _)| (cx as i32 - world.min_x) * 16).min().unwrap();
    let py1 = chunks.iter().map(|&(_, cy)| (cy as i32 - world.min_y) * 16).min().unwrap();
    let px2 = chunks.iter().map(|&(cx, _)| (cx as i32 - world.min_x) * 16 + 15).max().unwrap();
    let py2 = chunks.iter().map(|&(_, cy)| (cy as i32 - world.min_y) * 16 + 15).max().unwrap();
    render_pixels_patch(world, px1, py1, px2, py2)
}

// ── Orthographic selection preview ────────────────────────────────────────────

#[derive(Serialize)]
struct PreviewData {
    width: u32,
    height: u32,
    #[serde(serialize_with = "serialize_bytes_b64")]
    pixels: Vec<u8>,
}

/// Front view: X=horizontal, Z=vertical; scans Y front-to-back, stops at first non-air block.
/// Z=z_max maps to row 0 (top), Z=z_min maps to row (ph-1) (bottom).
///
/// HashMap lookups are amortized over 16-block chunk rows: one lookup per chunk row rather
/// than one per block, reducing calls from O(W×D×H) to O(W×D×H/16).
fn render_view_front(
    world: &LoadedWorld,
    x1: i32, x2: i32, y1: i32, y2: i32, z_min: i32, z_max: i32,
    b_lo: usize,
) -> (u32, u32, Vec<u8>) {
    let pw = (x2 - x1 + 1) as u32;
    let ph = (z_max - z_min + 1) as u32;
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }
    let bytes_len = world.bytes.len();

    for x in x1..=x2 {
        let cx     = x / 16 + world.min_x;
        let lx_256 = (x & 15) as usize * 256;     // lx * 256, constant for this X column
        let col    = (x - x1) as usize;
        for z in z_min..=z_max {
            let band  = (z as usize) / 16;
            let lz    = (z as usize) & 15;
            let z_off = (band - b_lo) * 8192 + lz; // offset into band-scoped clone
            let row   = (z_max - z) as usize;
            let out   = (row * pw as usize + col) * 4;
            // Scan Y in 16-block chunk rows — one HashMap lookup per row instead of per block
            let mut y = y1;
            'y_scan: while y <= y2 {
                let cy          = y / 16 + world.min_y;
                let chunk_y_end = (y | 15).min(y2);    // last y index in same chunk row
                match world.chunk_map.get(&(cx, cy)) {
                    None => { y = chunk_y_end + 1; }   // chunk absent, skip row
                    Some(&addr) => {
                        let base = addr + z_off + lx_256;   // constant for this chunk×x×z
                        while y <= chunk_y_end {
                            let bi = base + (y & 15) as usize * 16;
                            let pi = bi + 4096;
                            if bi < bytes_len && pi < bytes_len {
                                let bt = world.bytes[bi];
                                if bt != 0 {
                                    let [r, g, b] = block_color(bt, world.bytes[pi], world.sky);
                                    pixels[out]     = r;
                                    pixels[out + 1] = g;
                                    pixels[out + 2] = b;
                                    pixels[out + 3] = 255;
                                    break 'y_scan;
                                }
                            }
                            y += 1;
                        }
                    }
                }
            }
        }
    }
    (pw, ph, pixels)
}

/// Side view: Y=horizontal, Z=vertical; scans X left-to-right, stops at first non-air block.
fn render_view_side(
    world: &LoadedWorld,
    x1: i32, x2: i32, y1: i32, y2: i32, z_min: i32, z_max: i32,
    b_lo: usize,
) -> (u32, u32, Vec<u8>) {
    let pw = (y2 - y1 + 1) as u32;
    let ph = (z_max - z_min + 1) as u32;
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }
    let bytes_len = world.bytes.len();

    for y in y1..=y2 {
        let cy    = y / 16 + world.min_y;
        let ly_16 = (y & 15) as usize * 16;        // ly * 16, constant for this Y column
        let col   = (y - y1) as usize;
        for z in z_min..=z_max {
            let band  = (z as usize) / 16;
            let lz    = (z as usize) & 15;
            let z_off = (band - b_lo) * 8192 + lz; // offset into band-scoped clone
            let row   = (z_max - z) as usize;
            let out   = (row * pw as usize + col) * 4;
            let mut x = x1;
            'x_scan: while x <= x2 {
                let cx          = x / 16 + world.min_x;
                let chunk_x_end = (x | 15).min(x2);
                match world.chunk_map.get(&(cx, cy)) {
                    None => { x = chunk_x_end + 1; }
                    Some(&addr) => {
                        let base = addr + z_off + ly_16;    // constant for this chunk×y×z
                        while x <= chunk_x_end {
                            let bi = base + (x & 15) as usize * 256;
                            let pi = bi + 4096;
                            if bi < bytes_len && pi < bytes_len {
                                let bt = world.bytes[bi];
                                if bt != 0 {
                                    let [r, g, b] = block_color(bt, world.bytes[pi], world.sky);
                                    pixels[out]     = r;
                                    pixels[out + 1] = g;
                                    pixels[out + 2] = b;
                                    pixels[out + 3] = 255;
                                    break 'x_scan;
                                }
                            }
                            x += 1;
                        }
                    }
                }
            }
        }
    }
    (pw, ph, pixels)
}

/// Top view: X=horizontal, Y=vertical; scans Z from z_max down to z_min.
/// One HashMap lookup per (x,y) pair, amortized over the full z-depth scan.
fn render_view_top(
    world: &LoadedWorld,
    x1: i32, x2: i32, y1: i32, y2: i32, z_min: i32, z_max: i32,
    b_lo: usize,
) -> (u32, u32, Vec<u8>) {
    let pw = (x2 - x1 + 1) as u32;
    let ph = (y2 - y1 + 1) as u32;
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }
    let bytes_len = world.bytes.len();

    for x in x1..=x2 {
        let cx     = x / 16 + world.min_x;
        let lx_256 = (x & 15) as usize * 256;
        let col    = (x - x1) as usize;
        for y in y1..=y2 {
            let cy   = y / 16 + world.min_y;
            let row  = (y - y1) as usize;
            let out  = (row * pw as usize + col) * 4;
            if let Some(&addr) = world.chunk_map.get(&(cx, cy)) {
                let base = addr + lx_256 + (y & 15) as usize * 16;     // constant for this x,y
                for z in (z_min..=z_max).rev() {
                    let bi = base + (z as usize / 16 - b_lo) * 8192 + (z as usize & 15);
                    let pi = bi + 4096;
                    if pi < bytes_len {
                        let bt = world.bytes[bi];
                        if bt != 0 {
                            let [r, g, b] = block_color(bt, world.bytes[pi], world.sky);
                            pixels[out]     = r;
                            pixels[out + 1] = g;
                            pixels[out + 2] = b;
                            pixels[out + 3] = 255;
                            break;
                        }
                    }
                }
            }
        }
    }
    (pw, ph, pixels)
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
fn load_world(path: String, state: tauri::State<'_, AppState>) -> Result<WorldMeta, String> {
    let t0 = Instant::now();
    let us = || t0.elapsed().as_micros();

    eprintln!("[LOAD] start");

    // Step 1: Brief lock — clear previous world so in-flight scans (render_selection_view,
    // render_zslice) fail fast on their next lock attempt instead of blocking here.
    eprintln!("[LOCK] acquire_start  cmd=load_world/step1  t=+{}µs", us());
    let t_s1 = Instant::now();
    let (_old_world, old_temp) = {
        let mut ws = state.lock().unwrap();
        let wait = t_s1.elapsed().as_micros();
        let prev_undo: usize = ws.undo_stack.iter().flat_map(|e| e.chunks.iter()).map(|c| c.data.len()).sum();
        let prev_redo: usize = ws.redo_stack.iter().flat_map(|e| e.chunks.iter()).map(|c| c.data.len()).sum();
        eprintln!("[LOCK] acquired  cmd=load_world/step1  wait={}µs  prev_undo={}B  prev_redo={}B",
            wait, prev_undo, prev_redo);
        let t_held = Instant::now();
        let taken = ws.world.take();  // pointer swap only — dealloc happens outside the lock
        ws.clipboard = None;
        ws.undo_stack.clear();
        ws.redo_stack.clear();
        let old_temp = ws.temp_path.take();
        drop(ws);
        eprintln!("[LOCK] released  cmd=load_world/step1  held={}µs  t=+{}µs", t_held.elapsed().as_micros(), us());
        (taken, old_temp)
    };
    // _old_world (Option<LoadedWorld>) drops here, releasing the mmap before we delete the temp file.
    if let Some(p) = old_temp { let _ = fs::remove_file(&p); }

    // Step 2: File I/O + parse — no lock held.
    // Peek at 4 magic bytes to detect zip without reading the whole file.
    let mut magic = [0u8; 4];
    {
        use std::io::Read;
        if let Ok(mut f) = fs::File::open(&path) { let _ = f.read_exact(&mut magic); }
    }

    let (mmap, maybe_temp): (MmapMut, Option<std::path::PathBuf>) = if is_zip(&magic) {
        use zip::ZipArchive;
        eprintln!("[LOAD] detected zip archive, decompressing  t=+{}µs", us());
        let raw = fs::read(&path).map_err(|e| format!("Failed to read file: {e}"))?;
        let cursor = std::io::Cursor::new(&raw);
        let mut archive = ZipArchive::new(cursor)
            .map_err(|e| format!("Invalid zip archive: {e}"))?;
        if archive.len() == 0 { return Err("Zip archive contains no files".into()); }
        let mut entry = archive.by_index(0)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        let temp_path = temp_world_path();
        {
            let mut tmp = fs::File::create(&temp_path)
                .map_err(|e| format!("Failed to create temp file: {e}"))?;
            std::io::copy(&mut entry, &mut tmp)
                .map_err(|e| format!("Failed to decompress: {e}"))?;
        } // tmp closed here before mmap
        eprintln!("[LOAD] decompressed to {:?}  t=+{}µs", temp_path, us());
        let file = fs::File::open(&temp_path)
            .map_err(|e| format!("Failed to open temp file: {e}"))?;
        // SAFETY: temp file is private, written by us, and stays alive for the duration of the mmap.
        let mmap = unsafe { MmapOptions::new().map_copy(&file) }
            .map_err(|e| format!("Failed to map temp file: {e}"))?;
        (mmap, Some(temp_path))
    } else {
        let file = fs::File::open(&path).map_err(|e| format!("Failed to open file: {e}"))?;
        // SAFETY: The file is opened read-only and we never truncate or replace it while mapped.
        // map_copy creates a private mapping; our writes never reach disk until explicit save.
        let mmap = unsafe { MmapOptions::new().map_copy(&file) }
            .map_err(|e| format!("Failed to map file: {e}"))?;
        (mmap, None)
    };
    eprintln!("[LOAD] file_mmap  bytes={}B  compressed={}  t=+{}µs", mmap.len(), maybe_temp.is_some(), us());

    let loaded = parse_world_inner(mmap)?;
    eprintln!("[LOAD] parsed  {}×{} chunks  count={}  world_bytes={}B  t=+{}µs",
        loaded.w_chunks, loaded.h_chunks, loaded.chunk_map.len(), loaded.bytes.len(), us());

    // Capture metadata before moving loaded into state.
    // No render_pixels call — tiles are fetched on demand by the frontend.
    let meta = WorldMeta {
        name:          loaded.name.clone(),
        width_chunks:  loaded.w_chunks,
        height_chunks: loaded.h_chunks,
        max_z:         world_max_z(&loaded) as u32,
        was_compressed: maybe_temp.is_some(),
    };

    // Step 3: Install new world.
    eprintln!("[LOCK] acquire_start  cmd=load_world/step3  t=+{}µs", us());
    let t_s3 = Instant::now();
    {
        let mut ws = state.lock().unwrap();
        eprintln!("[LOCK] acquired  cmd=load_world/step3  wait={}µs", t_s3.elapsed().as_micros());
        let t_held = Instant::now();
        ws.world = Some(loaded);
        ws.temp_path = maybe_temp;
        drop(ws);
        eprintln!("[LOCK] released  cmd=load_world/step3  held={}µs  t=+{}µs", t_held.elapsed().as_micros(), us());
    }
    eprintln!("[LOAD] end  total={}µs", us());

    Ok(meta)
}

#[tauri::command]
fn save_png(path: String, data: String) -> Result<(), String> {
    let bytes = STANDARD.decode(&data).map_err(|e| format!("Invalid base64 PNG data: {e}"))?;
    fs::write(&path, &bytes).map_err(|e| format!("Failed to write PNG: {e}"))
}

#[tauri::command]
fn render_zslice(z: i32, state: tauri::State<'_, AppState>) -> Result<WorldData, String> {
    let t0 = Instant::now();
    let us = || t0.elapsed().as_micros();

    eprintln!("[PREVIEW] start  cmd=render_zslice  z={z}");

    const BAND_BYTES: usize = 8192;
    eprintln!("[LOCK] acquire_start  cmd=render_zslice  t=+{}µs", us());
    let t_lock = Instant::now();
    let (slices, positions, name, w_chunks, h_chunks, min_x, min_y, sky, max_z) = {
        let ws = state.lock().unwrap();
        let wait = t_lock.elapsed().as_micros();
        eprintln!("[LOCK] acquired  cmd=render_zslice  wait={}µs", wait);
        let t_held = Instant::now();

        let world = ws.world.as_ref().ok_or("No world loaded")?;
        let max_z = world_max_z(world);
        if z < 0 || z > max_z {
            return Err(format!("Z must be 0–{max_z}, got {z}"));
        }
        let band     = (z as usize) / 16;
        let band_off = band * 8192;
        let n        = world.chunk_map.len();
        let mut slices:    Vec<u8>                     = Vec::with_capacity(n * BAND_BYTES);
        let mut positions: Vec<((i32, i32), usize)>    = Vec::with_capacity(n);
        for (&pos, &addr) in &world.chunk_map {
            let start = addr + band_off;
            if start + BAND_BYTES <= world.bytes.len() {
                let local = slices.len();
                slices.extend_from_slice(&world.bytes[start..start + BAND_BYTES]);
                positions.push((pos, local));
            }
        }
        let result = (slices, positions, world.name.clone(),
                      world.w_chunks, world.h_chunks, world.min_x, world.min_y, world.sky, max_z);
        drop(ws);
        eprintln!("[LOCK] released  cmd=render_zslice  held={}µs  cloned={}B  t=+{}µs",
            t_held.elapsed().as_micros(), result.0.len(), us());
        result
    };

    let lz = (z as usize) & 15;
    let pw = (w_chunks * 16) as usize;
    let ph = (h_chunks * 16) as usize;
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; pw * ph * 4];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    eprintln!("[SCAN] start  cmd=render_zslice  chunks={}  t=+{}µs", positions.len(), us());
    let t_scan = Instant::now();
    for ((cx, cy), local) in positions {
        let base_px = ((cx - min_x) * 16) as usize;
        let base_py = ((cy - min_y) * 16) as usize;
        let sl = &slices[local..local + BAND_BYTES];
        for x in 0..16usize {
            for y in 0..16usize {
                let bi = x * 256 + y * 16 + lz;
                let bt = sl[bi];
                if bt == 0 { continue; }
                let [r, g, b] = block_color(bt, sl[bi + 4096], sky);
                let off = ((base_py + y) * pw + (base_px + x)) * 4;
                pixels[off] = r; pixels[off + 1] = g; pixels[off + 2] = b;
            }
        }
    }
    eprintln!("[SCAN] end  cmd=render_zslice  elapsed={}µs", t_scan.elapsed().as_micros());
    eprintln!("[PREVIEW] end  cmd=render_zslice  pixels={}B  total={}µs", pixels.len(), us());
    Ok(WorldData { name, width_chunks: w_chunks, height_chunks: h_chunks, pixels, max_z: max_z as u32 })
}

// ── Selection ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct SelectionInfo {
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    width: i32,  // x2 - x1 + 1
    height: i32, // y2 - y1 + 1
    depth: i32,  // z_max - z_min + 1
}

fn validate_selection(x1: i32, y1: i32, x2: i32, y2: i32, z_min: i32, z_max: i32, max_z: i32) -> Result<(), String> {
    if x2 < x1 || y2 < y1 {
        return Err("Invalid XY bounds: x2/y2 must be >= x1/y1".into());
    }
    if z_min < 0 || z_max > max_z || z_max < z_min {
        return Err(format!("Invalid Z range {z_min}–{z_max}: must satisfy 0 ≤ zMin ≤ zMax ≤ {max_z}"));
    }
    Ok(())
}

/// Validates and returns selection metadata. Every Phase 2b editing command
/// takes these same six parameters.
#[tauri::command]
fn describe_selection(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<SelectionInfo, String> {
    validate_selection(x1, y1, x2, y2, z_min, z_max, 255)?;
    Ok(SelectionInfo {
        x1, y1, x2, y2, z_min, z_max,
        width:  x2 - x1 + 1,
        height: y2 - y1 + 1,
        depth:  z_max - z_min + 1,
    })
}

/// Return a top-down pixel patch for the rectangle (x1,y1)–(x2,y2).
/// Used by the tiled frontend to fetch individual map tiles on demand.
#[tauri::command]
fn fetch_tile(
    x1: i32, y1: i32, x2: i32, y2: i32,
    state: tauri::State<'_, AppState>,
) -> Result<PixelPatch, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    Ok(render_pixels_patch(world, x1, y1, x2, y2))
}

/// Return a z-slice patch for just the rectangle (x1,y1)–(x2,y2) at level z.
/// Used after edits when the frontend is in z-slice mode, avoiding a full 243 MB re-render.
#[tauri::command]
fn render_zslice_patch(
    z: i32, x1: u32, y1: u32, x2: u32, y2: u32,
    state: tauri::State<'_, AppState>,
) -> Result<PixelPatch, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let max_z = world_max_z(world);
    if z < 0 || z > max_z {
        return Err(format!("Z must be 0–{max_z}, got {z}"));
    }
    Ok(render_zslice_patch_inner(world, z, x1 as i32, y1 as i32, x2 as i32, y2 as i32))
}

#[tauri::command]
fn render_selection_view(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    view: String,
    state: tauri::State<'_, AppState>,
) -> Result<PreviewData, String> {
    let t0 = Instant::now();
    let us = || t0.elapsed().as_micros();

    eprintln!("[PREVIEW] start  cmd=render_selection_view  view={view}  sel={}×{}×{}  z={z_min}–{z_max}",
        x2-x1+1, y2-y1+1, z_max-z_min+1);

    // Only the bands that overlap [z_min, z_max] are needed. Cloning a band-scoped
    // slice cuts the mutex hold time proportionally (e.g. 4× for a z=0–63 query
    // in a 256-layer world, where only 4 of 16 bands are relevant).
    let b_lo = (z_min as usize) / 16;
    let b_hi = (z_max as usize) / 16;
    let bands_per_chunk = b_hi - b_lo + 1;
    let local_band_bytes = bands_per_chunk * 8192;

    eprintln!("[LOCK] acquire_start  cmd=render_selection_view  t=+{}µs", us());
    let t_lock = Instant::now();
    let scan_world = {
        let ws = state.lock().unwrap();
        let wait = t_lock.elapsed().as_micros();
        eprintln!("[LOCK] acquired  cmd=render_selection_view  wait={}µs", wait);
        let t_held = Instant::now();

        let world = ws.world.as_ref().ok_or("No world loaded")?;
        validate_selection(x1, y1, x2, y2, z_min, z_max, world_max_z(world))?;

        let cx_lo = x1 / 16 + world.min_x;
        let cx_hi = x2 / 16 + world.min_x;
        let cy_lo = y1 / 16 + world.min_y;
        let cy_hi = y2 / 16 + world.min_y;

        let n_sel = ((cx_hi - cx_lo + 1) * (cy_hi - cy_lo + 1)) as usize;
        // Build the band-scoped chunk data as a Vec first, then transfer into an anonymous
        // MmapMut so the temporary scan world has the same LoadedWorld type as the main world.
        let mut local_vec:   Vec<u8>                    = Vec::with_capacity(n_sel * local_band_bytes);
        let mut local_map:   HashMap<(i32, i32), usize> = HashMap::with_capacity(n_sel);
        for (&(cx, cy), &addr) in &world.chunk_map {
            if cx >= cx_lo && cx <= cx_hi && cy >= cy_lo && cy <= cy_hi {
                let local_addr = local_vec.len();
                for band in b_lo..=b_hi {
                    let src = addr + band * 8192;
                    if src + 8192 <= world.bytes.len() {
                        local_vec.extend_from_slice(&world.bytes[src..src + 8192]);
                    } else {
                        local_vec.extend(std::iter::repeat(0u8).take(8192));
                    }
                }
                local_map.insert((cx, cy), local_addr);
            }
        }
        let mut local_bytes = MmapOptions::new().len(local_vec.len().max(1)).map_anon()
            .map_err(|e| format!("Failed to allocate scan buffer: {e}"))?;
        local_bytes[..local_vec.len()].copy_from_slice(&local_vec);
        drop(local_vec);
        let result = LoadedWorld {
            bytes: local_bytes, chunk_map: local_map,
            min_x: world.min_x, min_y: world.min_y,
            w_chunks: world.w_chunks, h_chunks: world.h_chunks,
            chunk_size: local_band_bytes, num_bands: bands_per_chunk,
            sky: world.sky, name: String::new(),
        };
        drop(ws);  // explicit drop — lock released here, before any scanning
        eprintln!("[LOCK] released  cmd=render_selection_view  held={}µs  cloned={}B  bands={}/{}  t=+{}µs",
            t_held.elapsed().as_micros(), result.bytes.len(), bands_per_chunk, b_hi - b_lo + 1 + 0, us());
        result
    };

    eprintln!("[SCAN] start  cmd=render_selection_view  t=+{}µs", us());
    let t_scan = Instant::now();
    let (width, height, pixels) = match view.as_str() {
        "front" => render_view_front(&scan_world, x1, x2, y1, y2, z_min, z_max, b_lo),
        "side"  => render_view_side(&scan_world, x1, x2, y1, y2, z_min, z_max, b_lo),
        _       => render_view_top(&scan_world, x1, x2, y1, y2, z_min, z_max, b_lo),
    };
    eprintln!("[SCAN] end  cmd=render_selection_view  elapsed={}ms  result={}×{}", t_scan.elapsed().as_millis(), width, height);
    eprintln!("[PREVIEW] end  cmd=render_selection_view  pixels={}B  total={}ms", pixels.len(), t0.elapsed().as_millis());
    Ok(PreviewData { width, height, pixels })
}

/// Front view with `ctx` context columns on each side at 50% alpha. b_lo always 0.
fn render_view_front_ctx(
    world: &LoadedWorld,
    sel_x1: i32, sel_x2: i32, y1: i32, y2: i32,
    z_max: i32, ctx: i32,
) -> (u32, u32, Vec<u8>) {
    let rx1 = sel_x1 - ctx;
    let rx2 = sel_x2 + ctx;
    let pw = (rx2 - rx1 + 1) as u32;
    let ph = (z_max + 1) as u32;
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }
    let bytes_len = world.bytes.len();

    for x in rx1..=rx2 {
        // div_euclid handles negative x (context left of world origin).
        // x & 15 == x.rem_euclid(16) for all i32 (two's-complement property).
        let cx     = x.div_euclid(16) + world.min_x;
        let lx_256 = (x & 15) as usize * 256;
        let col    = (x - rx1) as usize;
        for z in 0..=z_max {
            let band  = (z as usize) / 16;
            let lz    = (z as usize) & 15;
            let z_off = band * 8192 + lz; // b_lo=0 always
            let row   = (z_max - z) as usize;
            let out   = (row * pw as usize + col) * 4;
            let mut y = y1;
            'y_scan: while y <= y2 {
                let cy          = y / 16 + world.min_y;
                let chunk_y_end = (y | 15).min(y2);
                match world.chunk_map.get(&(cx, cy)) {
                    None => { y = chunk_y_end + 1; }
                    Some(&addr) => {
                        let base = addr + z_off + lx_256;
                        while y <= chunk_y_end {
                            let bi = base + (y & 15) as usize * 16;
                            let pi = bi + 4096;
                            if bi < bytes_len && pi < bytes_len {
                                let bt = world.bytes[bi];
                                if bt != 0 {
                                    let [r, g, b] = block_color(bt, world.bytes[pi], world.sky);
                                    pixels[out]     = r;
                                    pixels[out + 1] = g;
                                    pixels[out + 2] = b;
                                    break 'y_scan;
                                }
                            }
                            y += 1;
                        }
                    }
                }
            }
        }
    }
    // Post-process: dim context columns to 50% opacity.
    let left_ctx  = (sel_x1 - rx1) as usize;
    let right_ctx = (sel_x2 + 1 - rx1) as usize;
    for col in (0..left_ctx).chain(right_ctx..(pw as usize)) {
        for row in 0..(ph as usize) {
            pixels[(row * pw as usize + col) * 4 + 3] = 128;
        }
    }
    (pw, ph, pixels)
}

/// Side view with `ctx` context columns on each side at 50% alpha. b_lo always 0.
fn render_view_side_ctx(
    world: &LoadedWorld,
    x1: i32, x2: i32, sel_y1: i32, sel_y2: i32,
    z_max: i32, ctx: i32,
) -> (u32, u32, Vec<u8>) {
    let ry1 = sel_y1 - ctx;
    let ry2 = sel_y2 + ctx;
    let pw = (ry2 - ry1 + 1) as u32;
    let ph = (z_max + 1) as u32;
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }
    let bytes_len = world.bytes.len();

    for y in ry1..=ry2 {
        let cy    = y.div_euclid(16) + world.min_y;
        let ly_16 = (y & 15) as usize * 16;
        let col   = (y - ry1) as usize;
        for z in 0..=z_max {
            let band  = (z as usize) / 16;
            let lz    = (z as usize) & 15;
            let z_off = band * 8192 + lz;
            let row   = (z_max - z) as usize;
            let out   = (row * pw as usize + col) * 4;
            let mut x = x1;
            'x_scan: while x <= x2 {
                let cx          = x / 16 + world.min_x;
                let chunk_x_end = (x | 15).min(x2);
                match world.chunk_map.get(&(cx, cy)) {
                    None => { x = chunk_x_end + 1; }
                    Some(&addr) => {
                        let base = addr + z_off + ly_16;
                        while x <= chunk_x_end {
                            let bi = base + (x & 15) as usize * 256;
                            let pi = bi + 4096;
                            if bi < bytes_len && pi < bytes_len {
                                let bt = world.bytes[bi];
                                if bt != 0 {
                                    let [r, g, b] = block_color(bt, world.bytes[pi], world.sky);
                                    pixels[out]     = r;
                                    pixels[out + 1] = g;
                                    pixels[out + 2] = b;
                                    break 'x_scan;
                                }
                            }
                            x += 1;
                        }
                    }
                }
            }
        }
    }
    let left_ctx  = (sel_y1 - ry1) as usize;
    let right_ctx = (sel_y2 + 1 - ry1) as usize;
    for col in (0..left_ctx).chain(right_ctx..(pw as usize)) {
        for row in 0..(ph as usize) {
            pixels[(row * pw as usize + col) * 4 + 3] = 128;
        }
    }
    (pw, ph, pixels)
}

/// Full-height contextual front/side view. `context_blocks` columns outside the
/// selection are rendered at 50% opacity to show surrounding terrain.
#[tauri::command]
fn render_full_height_view(
    x1: i32, y1: i32, x2: i32, y2: i32,
    view: String,
    context_blocks: i32,
    state: tauri::State<'_, AppState>,
) -> Result<PreviewData, String> {
    if x2 < x1 || y2 < y1 {
        return Err("Invalid XY bounds".into());
    }

    let ctx = context_blocks.max(0);
    let (scan_world, z_max) = {
        let ws = state.lock().unwrap();
        let world = ws.world.as_ref().ok_or("No world loaded")?;

        let z_max        = world_max_z(world);
        let chunk_size   = world.chunk_size;
        let num_bands    = world.num_bands;
        // Expand clone region by one extra chunk in all directions to cover context blocks.
        let ctx_chunks = ctx / 16 + 1;
        let cx_lo = x1.div_euclid(16) + world.min_x - ctx_chunks;
        let cx_hi = x2.div_euclid(16) + world.min_x + ctx_chunks;
        let cy_lo = y1.div_euclid(16) + world.min_y - ctx_chunks;
        let cy_hi = y2.div_euclid(16) + world.min_y + ctx_chunks;

        let n_sel = ((cx_hi - cx_lo + 1) * (cy_hi - cy_lo + 1)) as usize;
        let mut local_vec: Vec<u8>                    = Vec::with_capacity(n_sel * chunk_size);
        let mut local_map: HashMap<(i32, i32), usize> = HashMap::with_capacity(n_sel);

        for (&(cx, cy), &addr) in &world.chunk_map {
            if cx >= cx_lo && cx <= cx_hi && cy >= cy_lo && cy <= cy_hi {
                let local_addr = local_vec.len();
                let end = addr + chunk_size;
                if end <= world.bytes.len() {
                    local_vec.extend_from_slice(&world.bytes[addr..end]);
                } else {
                    local_vec.extend(std::iter::repeat(0u8).take(chunk_size));
                }
                local_map.insert((cx, cy), local_addr);
            }
        }

        let mut local_bytes = MmapOptions::new().len(local_vec.len().max(1)).map_anon()
            .map_err(|e| format!("Failed to allocate scan buffer: {e}"))?;
        if !local_vec.is_empty() {
            local_bytes[..local_vec.len()].copy_from_slice(&local_vec);
        }
        drop(local_vec);

        let scan_world = LoadedWorld {
            bytes: local_bytes, chunk_map: local_map,
            min_x: world.min_x, min_y: world.min_y,
            w_chunks: world.w_chunks, h_chunks: world.h_chunks,
            chunk_size, num_bands, sky: world.sky, name: String::new(),
        };
        drop(ws);
        (scan_world, z_max)
    };

    let (width, height, pixels) = match view.as_str() {
        "front" => render_view_front_ctx(&scan_world, x1, x2, y1, y2, z_max, ctx),
        _       => render_view_side_ctx(&scan_world,  x1, x2, y1, y2, z_max, ctx),
    };
    Ok(PreviewData { width, height, pixels })
}

// ── Editing — pure inner functions (also called by tests) ─────────────────────

fn delete_blocks_inner(
    world: &mut LoadedWorld,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) {
    for px in x1..=x2 {
        for py in y1..=y2 {
            let chunk_cx = px / 16 + world.min_x;
            let chunk_cy = py / 16 + world.min_y;
            let lx = (px % 16) as usize;
            let ly = (py % 16) as usize;
            let &addr = match world.chunk_map.get(&(chunk_cx, chunk_cy)) {
                Some(a) => a,
                None => continue,
            };
            for z in z_min..=z_max {
                let band = (z / 16) as usize;
                let lz   = (z % 16) as usize;
                let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
                let pi = bi + 4096;
                if bi < world.bytes.len() { world.bytes[bi] = 0; }
                if pi < world.bytes.len() { world.bytes[pi] = 0; }
            }
        }
    }
}

fn replace_blocks_inner(
    world: &mut LoadedWorld,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    new_block_type: u8,
    new_paint: u8,
    filter_block_type: Option<u8>,
    filter_paint: Option<u8>,
    filter_invert: bool,
) {
    for px in x1..=x2 {
        for py in y1..=y2 {
            let chunk_cx = px / 16 + world.min_x;
            let chunk_cy = py / 16 + world.min_y;
            let lx = (px % 16) as usize;
            let ly = (py % 16) as usize;
            let &addr = match world.chunk_map.get(&(chunk_cx, chunk_cy)) {
                Some(a) => a,
                None => continue,
            };
            for z in z_min..=z_max {
                let band = (z / 16) as usize;
                let lz   = (z % 16) as usize;
                let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
                let pi = bi + 4096;
                if bi >= world.bytes.len() || pi >= world.bytes.len() { continue; }
                let type_ok  = filter_block_type.map_or(true, |ft| world.bytes[bi] == ft);
                let paint_ok = filter_paint.map_or(true,       |fp| world.bytes[pi] == fp);
                // passes==filter_invert means "skip": skip matching when normal, skip non-matching when inverted
                if (type_ok && paint_ok) == filter_invert { continue; }
                world.bytes[bi] = new_block_type;
                world.bytes[pi] = new_paint;
            }
        }
    }
}

/// Write `world.bytes` to `path`.  Before overwriting an existing file, copies
/// it to `path.bak` — but only if that backup doesn't already exist, so the
/// first-save snapshot is preserved across multiple saves.
fn save_world_inner(world: &LoadedWorld, path: &str) -> Result<(), String> {
    let bak = format!("{path}.bak");
    if !std::path::Path::new(&bak).exists() && std::path::Path::new(path).exists() {
        fs::copy(path, &bak).map_err(|e| format!("Failed to create backup: {e}"))?;
    }
    fs::write(path, &*world.bytes).map_err(|e| format!("Failed to write world: {e}"))
}

// ── Undo / Redo helpers ────────────────────────────────────────────────────────

/// Maximum total bytes held across all undo entries. Oldest entries are evicted when
/// exceeded. Always keeps the most recent entry even if it alone exceeds the budget,
/// so undo still functions after very large operations (e.g. fill on a 256-layer world).
const UNDO_BYTE_BUDGET: usize = 256 * 1024 * 1024; // 256 MB

fn undo_entry_bytes(entry: &UndoEntry) -> usize {
    entry.chunks.iter().map(|s| s.data.len()).sum()
}

/// Returns all chunk (cx, cy) coords whose x/y footprint overlaps the given pixel-space
/// rectangle. z_min/z_max are irrelevant here — Eden chunks span all z layers.
fn affected_chunk_coords(world: &LoadedWorld, x1: i32, y1: i32, x2: i32, y2: i32) -> Vec<(i16, i16)> {
    let cx_lo = x1 / 16 + world.min_x;
    let cx_hi = x2 / 16 + world.min_x;
    let cy_lo = y1 / 16 + world.min_y;
    let cy_hi = y2 / 16 + world.min_y;
    let mut out = Vec::new();
    for cx in cx_lo..=cx_hi {
        for cy in cy_lo..=cy_hi {
            if world.chunk_map.contains_key(&(cx, cy)) {
                out.push((cx as i16, cy as i16));
            }
        }
    }
    out
}

/// Copies chunk block data for each listed chunk coordinate.
fn snapshot_chunks(world: &LoadedWorld, coords: &[(i16, i16)]) -> Vec<ChunkSnapshot> {
    coords.iter().filter_map(|&(cx, cy)| {
        let addr = *world.chunk_map.get(&(cx as i32, cy as i32))?;
        let data = world.bytes[addr..addr + world.chunk_size].to_vec();
        Some(ChunkSnapshot { cx, cy, data })
    }).collect()
}

fn push_undo(stack: &mut VecDeque<UndoEntry>, entry: UndoEntry) {
    stack.push_back(entry);
    let mut total: usize = stack.iter().map(undo_entry_bytes).sum();
    while total > UNDO_BYTE_BUDGET && stack.len() > 1 {
        if let Some(evicted) = stack.pop_front() {
            total -= undo_entry_bytes(&evicted);
        }
    }
}

/// Removes snapshots whose data matches current chunk bytes — i.e. the edit left those
/// chunks unchanged (e.g. deleting air, filling with the same block). Keeps undo entries
/// small for narrow-z operations on 256-layer worlds where most chunk data is untouched.
fn filter_unchanged_snapshots(world: &LoadedWorld, mut snaps: Vec<ChunkSnapshot>) -> Vec<ChunkSnapshot> {
    snaps.retain(|snap| {
        let Some(&addr) = world.chunk_map.get(&(snap.cx as i32, snap.cy as i32)) else {
            return false;
        };
        world.bytes[addr..addr + snap.data.len()] != *snap.data
    });
    snaps
}

// ── EditResult — returned by every command that mutates world state ─────────────

#[derive(Serialize)]
struct EditResult {
    /// Pixel patch for only the changed region — replaces the old full WorldData
    /// returned on every edit. Applying this via putImageData is ~60× cheaper for
    /// large worlds than re-sending and re-parsing the entire pixel map.
    patch: PixelPatch,
    undo_depth: usize,
    redo_depth: usize,
}

// ── Editing commands ───────────────────────────────────────────────────────────
//
// Pattern for every editing command:
//  1. Validate inputs.
//  2. `take()` world out of WorldState to avoid borrow conflicts with the stacks.
//  3. Compute affected chunk coords, snapshot pre-edit bytes → push undo, clear redo.
//  4. Apply edit, re-render, put world back.
//  5. Return EditResult with fresh pixels + stack depths.

#[tauri::command]
fn delete_blocks(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap();
    let max_z = ws.world.as_ref().map(|w| world_max_z(w)).unwrap_or(63);
    validate_selection(x1, y1, x2, y2, z_min, z_max, max_z)?;
    let mut world = ws.world.take().ok_or("No world loaded")?;

    let affected = affected_chunk_coords(&world, x1, y1, x2, y2);
    let pre_snap = snapshot_chunks(&world, &affected);
    delete_blocks_inner(&mut world, x1, y1, x2, y2, z_min, z_max);
    let patch = render_pixels_patch(&world, x1, y1, x2, y2);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);

    ws.world = Some(world);
    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: "delete_blocks".into(), chunks: pre_snap });
        ws.redo_stack.clear();
    }

    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

#[tauri::command]
fn replace_blocks(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    new_block_type: u8,
    new_paint: u8,
    filter_block_type: Option<u8>,
    filter_paint: Option<u8>,
    filter_invert: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    if new_paint > 54 {
        return Err(format!("Invalid paint byte {new_paint}: must be 0–54"));
    }
    if let Some(fp) = filter_paint {
        if fp > 54 {
            return Err(format!("Invalid filter paint {fp}: must be 0–54"));
        }
    }
    let mut ws = state.lock().unwrap();
    let max_z = ws.world.as_ref().map(|w| world_max_z(w)).unwrap_or(63);
    validate_selection(x1, y1, x2, y2, z_min, z_max, max_z)?;
    let mut world = ws.world.take().ok_or("No world loaded")?;

    let affected = affected_chunk_coords(&world, x1, y1, x2, y2);
    let pre_snap = snapshot_chunks(&world, &affected);
    replace_blocks_inner(&mut world, x1, y1, x2, y2, z_min, z_max, new_block_type, new_paint, filter_block_type, filter_paint, filter_invert);
    let patch = render_pixels_patch(&world, x1, y1, x2, y2);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);

    ws.world = Some(world);
    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: "replace_blocks".into(), chunks: pre_snap });
        ws.redo_stack.clear();
    }

    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

/// Paint a batch of blocks in one operation — one undo entry for the whole stroke.
/// For each block, if z is None the topmost non-air block at (x,y) is used (surface paint);
/// if z is Some the block is placed at that exact z level.
/// Positions outside existing chunk boundaries are silently skipped.
#[tauri::command]
fn paint_blocks(
    blocks: Vec<PaintBlock>,
    block_type: u8,
    paint: u8,
    z_offset: i32,
    mask_type: Option<u8>,
    mask_paint: Option<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    if paint > 54 {
        return Err(format!("Invalid paint byte {paint}: must be 0–54"));
    }
    if blocks.is_empty() {
        return Err("No blocks to paint".into());
    }
    let mut ws = state.lock().unwrap();
    let mut world = ws.world.take().ok_or("No world loaded")?;
    let max_z = world_max_z(&world) as i32;

    // Compute bounding rect for chunk snapshot + patch render.
    let (mut x_min, mut y_min, mut x_max, mut y_max) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for b in &blocks {
        x_min = x_min.min(b.x); y_min = y_min.min(b.y);
        x_max = x_max.max(b.x); y_max = y_max.max(b.y);
    }

    let affected = affected_chunk_coords(&world, x_min, y_min, x_max, y_max);
    let pre_snap = snapshot_chunks(&world, &affected);

    for b in &blocks {
        let z = match b.z {
            Some(z) => {
                if z < 0 || z > max_z { continue; }
                z
            }
            None => match surface_z(&world, b.x, b.y) {
                Some(z) => {
                    let z2 = z + z_offset;
                    if z2 < 0 || z2 > max_z { continue; }
                    z2
                }
                None => continue,
            },
        };
        // Mask check: skip if current block doesn't match mask
        if let Some(mt) = mask_type {
            if read_block_abs(&world, b.x, b.y, z) != mt { continue; }
        }
        if let Some(mp) = mask_paint {
            if read_paint_abs(&world, b.x, b.y, z) != mp { continue; }
        }
        set_block_abs(&mut world, b.x, b.y, z, block_type, paint);
    }

    let patch = render_pixels_patch(&world, x_min, y_min, x_max, y_max);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);

    ws.world = Some(world);
    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: "paint_blocks".into(), chunks: pre_snap });
        ws.redo_stack.clear();
    }

    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

fn save_world_compressed(world: &LoadedWorld, path: &str) -> Result<(), String> {
    use zip::write::{SimpleFileOptions, ZipWriter};
    use std::io::Write;
    let inner_name = {
        let fname = std::path::Path::new(path)
            .file_name().and_then(|f| f.to_str()).unwrap_or("world.eden");
        // If saving as .eden.zip, the inner entry should be just .eden
        if fname.ends_with(".eden.zip") { fname[..fname.len() - 4].to_string() }
        else { fname.to_string() }
    };
    let bak = format!("{path}.bak");
    if !std::path::Path::new(&bak).exists() && std::path::Path::new(path).exists() {
        fs::copy(path, &bak).map_err(|e| format!("Failed to create backup: {e}"))?;
    }
    let file = fs::File::create(path).map_err(|e| format!("Failed to create file: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(9));
    zip.start_file(&inner_name, options).map_err(|e| format!("Zip error: {e}"))?;
    zip.write_all(&world.bytes).map_err(|e| format!("Write error: {e}"))?;
    zip.finish().map_err(|e| format!("Zip finish error: {e}"))?;
    Ok(())
}

#[tauri::command]
fn save_world(path: String, compressed: bool, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    if compressed { save_world_compressed(world, &path) } else { save_world_inner(world, &path) }
}

#[tauri::command]
fn undo_edit(state: tauri::State<'_, AppState>) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap();
    let entry = ws.undo_stack.pop_back().ok_or("Nothing to undo")?;
    let mut world = ws.world.take().ok_or("No world loaded")?;

    let affected: Vec<(i16, i16)> = entry.chunks.iter().map(|s| (s.cx, s.cy)).collect();
    let redo_snaps = snapshot_chunks(&world, &affected);
    for snap in &entry.chunks {
        if let Some(&addr) = world.chunk_map.get(&(snap.cx as i32, snap.cy as i32)) {
            world.bytes[addr..addr + snap.data.len()].copy_from_slice(&snap.data);
        }
    }
    let patch = patch_from_chunk_coords(&world, &affected);

    ws.world = Some(world);
    ws.redo_stack.push_back(UndoEntry { operation: entry.operation.clone(), chunks: redo_snaps });

    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

#[tauri::command]
fn redo_edit(state: tauri::State<'_, AppState>) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap();
    let entry = ws.redo_stack.pop_back().ok_or("Nothing to redo")?;
    let mut world = ws.world.take().ok_or("No world loaded")?;

    let affected: Vec<(i16, i16)> = entry.chunks.iter().map(|s| (s.cx, s.cy)).collect();
    let undo_snaps = snapshot_chunks(&world, &affected);
    for snap in &entry.chunks {
        if let Some(&addr) = world.chunk_map.get(&(snap.cx as i32, snap.cy as i32)) {
            world.bytes[addr..addr + snap.data.len()].copy_from_slice(&snap.data);
        }
    }
    let patch = patch_from_chunk_coords(&world, &affected);

    ws.world = Some(world);
    push_undo(&mut ws.undo_stack, UndoEntry { operation: entry.operation.clone(), chunks: undo_snaps });

    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

// ── Copy / Paste commands ──────────────────────────────────────────────────────

/// Capture all blocks in the selection volume into the in-memory clipboard.
/// No world mutation; no undo entry. Returns clipboard dimensions for the frontend.
#[tauri::command]
fn copy_selection(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    state: tauri::State<'_, AppState>,
) -> Result<ClipboardInfo, String> {
    let mut ws = state.lock().unwrap();
    let max_z = ws.world.as_ref().map(|w| world_max_z(w)).unwrap_or(63);
    validate_selection(x1, y1, x2, y2, z_min, z_max, max_z)?;
    let world = ws.world.as_ref().ok_or("No world loaded")?;

    let width  = x2 - x1 + 1;
    let height = y2 - y1 + 1;
    let depth  = z_max - z_min + 1;
    let vol    = (width * height * depth) as usize;

    let mut block_types = vec![0u8; vol];
    let mut paints      = vec![0u8; vol];

    for dz in 0..depth {
        let z    = z_min + dz;
        let band = (z as usize) / 16;
        let lz   = (z as usize) % 16;
        for dy in 0..height {
            let py       = y1 + dy;
            let chunk_cy = py / 16 + world.min_y;
            let ly       = (py % 16) as usize;
            for dx in 0..width {
                let px       = x1 + dx;
                let chunk_cx = px / 16 + world.min_x;
                let lx       = (px % 16) as usize;
                let &addr = match world.chunk_map.get(&(chunk_cx, chunk_cy)) {
                    Some(a) => a,
                    None    => continue, // outside world → leave 0 (air)
                };
                let bi  = addr + band * 8192 + lx * 256 + ly * 16 + lz;
                let pi  = bi + 4096;
                let idx = (dz * height * width + dy * width + dx) as usize;
                if bi < world.bytes.len() { block_types[idx] = world.bytes[bi]; }
                if pi < world.bytes.len() { paints[idx]      = world.bytes[pi]; }
            }
        }
    }

    ws.clipboard = Some(Clipboard { width, height, depth, z_anchor: z_min, block_types, paints });
    Ok(ClipboardInfo { width, height, depth, z_anchor: z_min })
}

/// Rotate a directional block ID 90° clockwise.
///
/// Ramps (24–39): [base+0=S, base+1=W, base+2=N, base+3=E]
/// Wedges (40–55): [base+0=SE, base+1=SW, base+2=NW, base+3=NE]
/// Doors (66–69): S/W/N/E order (matching C# DoorSouth=66,DoorWest=67,DoorNorth=68,DoorEast=69).
/// Portals (75–78): same S/W/N/E order.
///
/// Under 90° CW in XY screen space (S→E, E→N, N→W, W→S) the offset shifts by +3 mod 4
/// for all families (ramps, wedges, doors, portals).
#[inline]
fn rotate_ramp_id_cw(bt: u8) -> u8 {
    if (24..=55).contains(&bt) {
        let base = bt & !3;
        let off  = bt &  3;
        base | ((off + 3) & 3)
    } else if (66..=69).contains(&bt) {
        66 + ((bt - 66 + 3) & 3)
    } else if (75..=78).contains(&bt) {
        75 + ((bt - 75 + 3) & 3)
    } else {
        bt
    }
}

/// Mirror a directional block ID on the X axis (left↔right on the map).
/// Ramps: S/N unchanged, E(+3)↔W(+1).
/// Wedges: SE(+0)↔SW(+1), NE(+3)↔NW(+2) — i.e., off ^= 1.
/// Doors/Portals: S/N unchanged, E↔W.
#[inline]
fn mirror_ramp_id_x(bt: u8) -> u8 {
    if (24..=39).contains(&bt) {
        let base = bt & !3;
        let off  = bt &  3;
        base | match off { 1 => 3, 3 => 1, x => x }
    } else if (40..=55).contains(&bt) {
        // SE(0)↔SW(1), NW(2)↔NE(3): flip the E/W component → off ^ 1
        (bt & !3) | ((bt & 3) ^ 1)
    } else if (66..=69).contains(&bt) {
        let off = bt - 66;
        66 + match off { 1 => 3, 3 => 1, x => x }
    } else if (75..=78).contains(&bt) {
        let off = bt - 75;
        75 + match off { 1 => 3, 3 => 1, x => x }
    } else {
        bt
    }
}

/// Mirror a directional block ID on the Y axis (top↔bottom on the map).
/// Ramps: E/W unchanged, S(+0)↔N(+2).
/// Wedges: SE(+0)↔NE(+3), SW(+1)↔NW(+2) — i.e., off ^= 3.
/// Doors/Portals: E/W unchanged, S↔N.
#[inline]
fn mirror_ramp_id_y(bt: u8) -> u8 {
    if (24..=39).contains(&bt) {
        let base = bt & !3;
        let off  = bt &  3;
        base | match off { 0 => 2, 2 => 0, x => x }
    } else if (40..=55).contains(&bt) {
        // SE(0)↔NE(3), SW(1)↔NW(2): flip the N/S component → off ^ 3
        (bt & !3) | ((bt & 3) ^ 3)
    } else if (66..=69).contains(&bt) {
        let off = bt - 66;
        66 + match off { 0 => 2, 2 => 0, x => x }
    } else if (75..=78).contains(&bt) {
        let off = bt - 75;
        75 + match off { 0 => 2, 2 => 0, x => x }
    } else {
        bt
    }
}

/// Returns the z of the topmost non-air block at pixel position (px, py),
/// or None if the column has no chunk or is entirely air.
fn surface_z(world: &LoadedWorld, px: i32, py: i32) -> Option<i32> {
    if px < 0 || py < 0 { return None; }
    let cx = px / 16 + world.min_x;
    let cy = py / 16 + world.min_y;
    let &addr = world.chunk_map.get(&(cx, cy))?;
    let lx = (px % 16) as usize;
    let ly = (py % 16) as usize;
    for band in (0..world.num_bands).rev() {
        for lz in (0..16usize).rev() {
            let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
            if bi >= world.bytes.len() { continue; }
            if world.bytes[bi] != 0 {
                return Some((band * 16 + lz) as i32);
            }
        }
    }
    None
}

#[tauri::command]
fn rename_world(state: tauri::State<'_, AppState>, name: String) -> Result<(), String> {
    if name.len() > 32 {
        return Err("Name must be 32 characters or fewer".into());
    }
    for ch in name.chars() {
        if !ch.is_ascii_alphabetic() && !ch.is_ascii_digit() && ch != '\'' {
            return Err(format!("Invalid character '{}' — only A–Z, a–z, 0–9 and ' are allowed", ch));
        }
    }
    let mut ws = state.lock().unwrap();
    let world = ws.world.as_mut().ok_or("No world loaded")?;
    if world.bytes.len() < 76 {
        return Err("World file too small to contain name field".into());
    }
    let name_bytes = name.as_bytes();
    for i in 0..36usize {
        world.bytes[40 + i] = if i < name_bytes.len() { name_bytes[i] } else { 0 };
    }
    world.name = name;
    Ok(())
}

#[tauri::command]
fn get_surface_z(state: tauri::State<'_, AppState>, x: i32, y: i32) -> Result<Option<i32>, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("no world")?;
    Ok(surface_z(world, x, y))
}

/// Rotate clipboard 90° clockwise in the XY plane.
/// Transform: (dx, dy, dz) → (new_dx=dy, new_dy=old_width-1-dx, dz).
/// New dimensions: new_width=old_height, new_height=old_width. Z range unchanged.
/// Directional block IDs (ramps 24–39, wedges 40–55, doors 66–69, portals 75–78) are remapped.
/// Does not touch world data; no undo entry required.
#[tauri::command]
fn rotate_clipboard(state: tauri::State<'_, AppState>) -> Result<ClipboardInfo, String> {
    let mut ws = state.lock().unwrap();
    let cb = ws.clipboard.as_mut().ok_or("Clipboard is empty")?;
    let old_w = cb.width as usize;
    let old_h = cb.height as usize;
    let depth = cb.depth as usize;
    let new_w = old_h;
    let new_h = old_w;
    let vol = new_w * new_h * depth;
    let mut new_types = vec![0u8; vol];
    let mut new_paints = vec![0u8; vol];
    for dz in 0..depth {
        for dy in 0..old_h {
            for dx in 0..old_w {
                let src = dz * old_h * old_w + dy * old_w + dx;
                let ndx = dy;
                let ndy = old_w - 1 - dx;
                let dst = dz * new_h * new_w + ndy * new_w + ndx;
                new_types[dst] = rotate_ramp_id_cw(cb.block_types[src]);
                new_paints[dst] = cb.paints[src];
            }
        }
    }
    cb.width = new_w as i32;
    cb.height = new_h as i32;
    cb.block_types = new_types;
    cb.paints = new_paints;
    Ok(ClipboardInfo { width: new_w as i32, height: new_h as i32, depth: cb.depth, z_anchor: cb.z_anchor })
}

/// Mirror clipboard on the X axis (left↔right on the map): (dx,dy,dz) → (width-1-dx, dy, dz).
/// Ramp IDs are remapped so E-facing ramps become W-facing and vice versa.
#[tauri::command]
fn mirror_clipboard_x(state: tauri::State<'_, AppState>) -> Result<ClipboardInfo, String> {
    let mut ws = state.lock().unwrap();
    let cb = ws.clipboard.as_mut().ok_or("Clipboard is empty")?;
    let w = cb.width as usize;
    let h = cb.height as usize;
    let depth = cb.depth as usize;
    let vol = w * h * depth;
    let mut new_types = vec![0u8; vol];
    let mut new_paints = vec![0u8; vol];
    for dz in 0..depth {
        for dy in 0..h {
            for dx in 0..w {
                let src = dz * h * w + dy * w + dx;
                let ndx = w - 1 - dx;
                let dst = dz * h * w + dy * w + ndx;
                new_types[dst] = mirror_ramp_id_x(cb.block_types[src]);
                new_paints[dst] = cb.paints[src];
            }
        }
    }
    cb.block_types = new_types;
    cb.paints = new_paints;
    Ok(ClipboardInfo { width: cb.width, height: cb.height, depth: cb.depth, z_anchor: cb.z_anchor })
}

/// Mirror clipboard on the Y axis (top↔bottom on the map): (dx,dy,dz) → (dx, height-1-dy, dz).
/// Ramp IDs are remapped so S-facing ramps become N-facing and vice versa.
#[tauri::command]
fn mirror_clipboard_y(state: tauri::State<'_, AppState>) -> Result<ClipboardInfo, String> {
    let mut ws = state.lock().unwrap();
    let cb = ws.clipboard.as_mut().ok_or("Clipboard is empty")?;
    let w = cb.width as usize;
    let h = cb.height as usize;
    let depth = cb.depth as usize;
    let vol = w * h * depth;
    let mut new_types = vec![0u8; vol];
    let mut new_paints = vec![0u8; vol];
    for dz in 0..depth {
        for dy in 0..h {
            for dx in 0..w {
                let src = dz * h * w + dy * w + dx;
                let ndy = h - 1 - dy;
                let dst = dz * h * w + ndy * w + dx;
                new_types[dst] = mirror_ramp_id_y(cb.block_types[src]);
                new_paints[dst] = cb.paints[src];
            }
        }
    }
    cb.block_types = new_types;
    cb.paints = new_paints;
    Ok(ClipboardInfo { width: cb.width, height: cb.height, depth: cb.depth, z_anchor: cb.z_anchor })
}

/// Paste the clipboard at world pixel position (paste_x, paste_y).
/// The anchor is the top-left (min-x, min-y) corner.
/// elevation_offset shifts the z range at paste time (does not modify clipboard).
/// ignore_air = true skips clipboard voxels with block type 0 (air).
/// Blocks outside existing chunk boundaries are silently clipped.
/// Follows the full chunk-scoped undo contract.
#[tauri::command]
fn paste_at(
    paste_x: i32, paste_y: i32,
    elevation_offset: i32,
    ignore_air: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap();

    // Clone clipboard data before taking world to avoid borrow conflict.
    let (width, height, depth, z_anchor, block_types, paints) = {
        let cb = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
        (cb.width, cb.height, cb.depth, cb.z_anchor,
         cb.block_types.clone(), cb.paints.clone())
    };

    let x2_paste = paste_x + width  - 1;
    let y2_paste = paste_y + height - 1;

    let mut world = ws.world.take().ok_or("No world loaded")?;

    // Clamp to non-negative for affected_chunk_coords (negative coords have no chunks).
    let x1_clip = paste_x.max(0);
    let y1_clip = paste_y.max(0);
    let affected = if x1_clip > x2_paste || y1_clip > y2_paste {
        vec![]
    } else {
        affected_chunk_coords(&world, x1_clip, y1_clip, x2_paste, y2_paste)
    };
    let pre_snap = snapshot_chunks(&world, &affected);

    for dz in 0..depth {
        let z = z_anchor + elevation_offset + dz;
        if z < 0 || z > world_max_z(&world) { continue; }
        let band = (z as usize) / 16;
        let lz   = (z as usize) % 16;
        for dy in 0..height {
            let py = paste_y + dy;
            if py < 0 { continue; }
            let chunk_cy = py / 16 + world.min_y;
            let ly       = (py % 16) as usize;
            for dx in 0..width {
                let px = paste_x + dx;
                if px < 0 { continue; }
                let chunk_cx = px / 16 + world.min_x;
                let lx       = (px % 16) as usize;
                let &addr = match world.chunk_map.get(&(chunk_cx, chunk_cy)) {
                    Some(a) => a,
                    None    => continue, // outside world boundary — clip silently
                };
                let idx = (dz * height * width + dy * width + dx) as usize;
                if ignore_air && block_types[idx] == 0 { continue; }
                let bi  = addr + band * 8192 + lx * 256 + ly * 16 + lz;
                let pi  = bi + 4096;
                if bi < world.bytes.len() { world.bytes[bi] = block_types[idx]; }
                if pi < world.bytes.len() { world.bytes[pi] = paints[idx]; }
            }
        }
    }

    let patch = render_pixels_patch(&world, paste_x, paste_y, x2_paste, y2_paste);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);
    ws.world = Some(world);

    // Only record undo if the paste actually changed at least one existing chunk.
    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: "paste_at".into(), chunks: pre_snap });
        ws.redo_stack.clear();
    }

    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

/// Paste clipboard terrain-aligned: per (x,y) column, the bottom clipboard layer
/// is placed at `surface_z + (if above_surface { 1 } else { 0 }) + elevation_offset`.
/// Columns with no surface (all air or outside world) are skipped.
/// Follows the same chunk-scoped undo contract as paste_at.
#[tauri::command]
fn paste_terrain(
    paste_x: i32, paste_y: i32,
    elevation_offset: i32,
    ignore_air: bool,
    above_surface: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap();

    let (width, height, depth, block_types, paints) = {
        let cb = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
        (cb.width, cb.height, cb.depth,
         cb.block_types.clone(), cb.paints.clone())
    };

    let x2_paste = paste_x + width  - 1;
    let y2_paste = paste_y + height - 1;

    let mut world = ws.world.take().ok_or("No world loaded")?;
    let max_z = world_max_z(&world);

    let x1_clip = paste_x.max(0);
    let y1_clip = paste_y.max(0);
    let affected = if x1_clip > x2_paste || y1_clip > y2_paste {
        vec![]
    } else {
        affected_chunk_coords(&world, x1_clip, y1_clip, x2_paste, y2_paste)
    };
    let pre_snap = snapshot_chunks(&world, &affected);

    let surf_nudge: i32 = if above_surface { 1 } else { 0 };

    for dy in 0..height {
        let py = paste_y + dy;
        if py < 0 { continue; }
        let chunk_cy = py / 16 + world.min_y;
        let ly       = (py % 16) as usize;
        for dx in 0..width {
            let px = paste_x + dx;
            if px < 0 { continue; }
            let chunk_cx = px / 16 + world.min_x;
            let lx       = (px % 16) as usize;
            let &addr = match world.chunk_map.get(&(chunk_cx, chunk_cy)) {
                Some(a) => a,
                None    => continue,
            };
            // Read surface before writing this column — other columns' writes never
            // affect (px, py) since each (dx, dy) maps to a unique world position.
            let surf = match surface_z(&world, px, py) {
                Some(z) => z,
                None    => continue, // all-air column — skip
            };
            let z_base = surf + surf_nudge + elevation_offset;

            for dz in 0..depth {
                let z = z_base + dz;
                if z < 0 || z > max_z { continue; }
                let band = (z as usize) / 16;
                let lz   = (z as usize) % 16;
                let idx  = (dz * height * width + dy * width + dx) as usize;
                if ignore_air && block_types[idx] == 0 { continue; }
                let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
                let pi = bi + 4096;
                if bi < world.bytes.len() { world.bytes[bi] = block_types[idx]; }
                if pi < world.bytes.len() { world.bytes[pi] = paints[idx]; }
            }
        }
    }

    let patch = render_pixels_patch(&world, paste_x, paste_y, x2_paste, y2_paste);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);
    ws.world = Some(world);

    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: "paste_terrain".into(), chunks: pre_snap });
        ws.redo_stack.clear();
    }

    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

/// Copies the selection N times in the given axis direction.
/// axis: "z+" | "z-" | "x+" | "x-" | "y+" | "y-"
/// count: number of copies (not counting the original), 1–20.
/// ignore_air: if true, source air blocks are not written (gaps preserved).
/// All copies land in a single undo entry.
#[tauri::command]
fn extrude_selection(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    axis: String,
    count: i32,
    ignore_air: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap();
    if count <= 0 { return Err("count must be at least 1".into()); }

    // Pre-buffer source blocks under borrow, then release before taking world.
    let (max_z, src_types, src_paints, width, height, depth) = {
        let world_ref = ws.world.as_ref().ok_or("No world loaded")?;
        let max_z = world_max_z(world_ref);
        validate_selection(x1, y1, x2, y2, z_min, z_max, max_z)?;

        let width  = x2 - x1 + 1;
        let height = y2 - y1 + 1;
        let depth  = z_max - z_min + 1;
        let n = (width * height * depth) as usize;
        let mut src_types  = vec![0u8; n];
        let mut src_paints = vec![0u8; n];
        let bytes_len = world_ref.bytes.len();

        for dz in 0..depth {
            let z    = z_min + dz;
            let band = (z as usize) / 16;
            let lz   = (z as usize) % 16;
            for dy in 0..height {
                let py     = y1 + dy;
                let src_cy = py / 16 + world_ref.min_y;
                let src_ly = (py % 16) as usize;
                for dx in 0..width {
                    let px     = x1 + dx;
                    let src_cx = px / 16 + world_ref.min_x;
                    let src_lx = (px % 16) as usize;
                    let idx    = (dz * height * width + dy * width + dx) as usize;
                    if let Some(&addr) = world_ref.chunk_map.get(&(src_cx, src_cy)) {
                        let bi = addr + band * 8192 + src_lx * 256 + src_ly * 16 + lz;
                        let pi = bi + 4096;
                        if bi < bytes_len && pi < bytes_len {
                            src_types[idx]  = world_ref.bytes[bi];
                            src_paints[idx] = world_ref.bytes[pi];
                        }
                    }
                }
            }
        }
        (max_z, src_types, src_paints, width, height, depth)
    };

    // Full XY footprint covering source + all copies (for chunk snapshot + render patch).
    let (ax1, ay1, ax2, ay2) = match axis.as_str() {
        "x+" => (x1, y1, x2 + count * width,  y2),
        "x-" => ((x1 - count * width).max(0), y1, x2, y2),
        "y+" => (x1, y1, x2, y2 + count * height),
        "y-" => (x1, (y1 - count * height).max(0), x2, y2),
        _    => (x1, y1, x2, y2), // z+/z-: same XY footprint as source
    };

    let mut world = ws.world.take().ok_or("No world loaded")?;
    let affected  = affected_chunk_coords(&world, ax1, ay1, ax2, ay2);
    let pre_snap  = snapshot_chunks(&world, &affected);

    for k in 1..=count {
        let (dx_step, dy_step, dz_step) = match axis.as_str() {
            "x+" => ( k * width,   0,        0),
            "x-" => (-k * width,   0,        0),
            "y+" => ( 0,  k * height,        0),
            "y-" => ( 0, -k * height,        0),
            "z-" => ( 0,  0,       -k * depth),
            _    => ( 0,  0,        k * depth), // "z+"
        };

        for dz in 0..depth {
            let tz = z_min + dz + dz_step;
            if tz < 0 || tz > max_z { continue; }
            let band = (tz as usize) / 16;
            let lz   = (tz as usize) % 16;
            for dy in 0..height {
                let ty = y1 + dy + dy_step;
                if ty < 0 { continue; }
                let chunk_cy = ty / 16 + world.min_y;
                let ly       = (ty % 16) as usize;
                for dx in 0..width {
                    let tx = x1 + dx + dx_step;
                    if tx < 0 { continue; }
                    let chunk_cx = tx / 16 + world.min_x;
                    let lx       = (tx % 16) as usize;
                    let idx      = (dz * height * width + dy * width + dx) as usize;
                    let src_bt   = src_types[idx];
                    if ignore_air && src_bt == 0 { continue; }
                    let &addr = match world.chunk_map.get(&(chunk_cx, chunk_cy)) {
                        None    => continue,
                        Some(a) => a,
                    };
                    let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
                    let pi = bi + 4096;
                    if bi < world.bytes.len() { world.bytes[bi] = src_bt; }
                    if pi < world.bytes.len() { world.bytes[pi] = src_paints[idx]; }
                }
            }
        }
    }

    let patch    = render_pixels_patch(&world, ax1, ay1, ax2, ay2);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);
    ws.world     = Some(world);

    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: "extrude_selection".into(), chunks: pre_snap });
        ws.redo_stack.clear();
    }

    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

// ── Tree generation ───────────────────────────────────────────────────────────

/// Minimal xorshift64 RNG — avoids adding a rand dependency.
struct Rng64(u64);
impl Rng64 {
    fn new(seed: u64) -> Self { Self(if seed == 0 { 0xdeadbeef_cafebabe } else { seed }) }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    /// Returns a value in lo..=hi (inclusive).
    fn range(&mut self, lo: i32, hi: i32) -> i32 {
        (self.next() % (hi - lo + 1) as u64) as i32 + lo
    }
    /// Returns true with probability num/den.
    fn prob(&mut self, num: u64, den: u64) -> bool {
        self.next() % den < num
    }
}

/// Write one block at absolute world pixel coordinates using the correct band formula.
/// Out-of-bounds writes (missing chunk, z > max) are silently dropped.
#[inline]
fn set_block_abs(world: &mut LoadedWorld, wx: i32, wy: i32, wz: i32, bt: u8, paint: u8) {
    if wz < 0 || wz as usize >= world.num_bands * 16 { return; }
    let cx = wx.div_euclid(16) + world.min_x;
    let cy = wy.div_euclid(16) + world.min_y;
    if let Some(&addr) = world.chunk_map.get(&(cx, cy)) {
        let lx   = wx.rem_euclid(16) as usize;
        let ly   = wy.rem_euclid(16) as usize;
        let band = wz as usize / 16;
        let lz   = wz as usize % 16;
        let bi   = addr + band * 8192 + lx * 256 + ly * 16 + lz;
        let pi   = bi + 4096;
        if bi < world.bytes.len() && pi < world.bytes.len() {
            world.bytes[bi] = bt;
            world.bytes[pi] = paint;
        }
    }
}

#[inline]
fn place_leaf_abs(world: &mut LoadedWorld, wx: i32, wy: i32, wz: i32, paint: u8) {
    set_block_abs(world, wx, wy, wz, 5, paint);
}

/// Block types that trees should not grow on (air, water, lava, cloud, foliage).
fn is_plantable(bt: u8) -> bool {
    !matches!(bt, 0 | 5 | 6 | 19 | 20 | 23 | 59 | 60 | 61 | 62 | 63 | 64)
}

// Leaf paint palettes — indices into PAINTED (paint byte = index + 1).
// 0 = unpainted = dark green [10,63,13]; 22=[0,255,64]; 31=[0,191,48]; 40=[0,128,32]; 49=[0,64,16]
const NORMAL_LEAF_PAINTS: [u8; 4] = [0, 22, 31, 40];
const PINE_LEAF_PAINTS:   [u8; 3] = [31, 40, 49];

/// Deciduous mushroom-shaped tree (ported from NormalTree in reference, bug fixed: trunk placed
/// after leaves so the log shows through the canopy, not overwritten by leaf blocks).
fn place_normal_tree(world: &mut LoadedWorld, wx: i32, wy: i32, z_base: i32, rng: &mut Rng64) {
    let trunk_h   = rng.range(3, 8);
    let leaf_paint = NORMAL_LEAF_PAINTS[rng.range(0, 3) as usize];
    let z_leaves  = z_base + trunk_h;

    // 4 leaf layers above trunk (bottom-to-top: narrow → wide → narrow → tip)
    for dz in 0..4i32 {
        let wz = z_leaves + dz;
        for dx in -2i32..=2 {
            for dy in -2i32..=2 {
                let adx = dx.abs(); let ady = dy.abs();
                let place = match dz {
                    // narrow: cross@dist1 + center
                    0 | 2 => (adx == 1 && dy == 0) || (ady == 1 && dx == 0) || (dx == 0 && dy == 0),
                    // wide: cross@dist2 + inner 3×3
                    1     => (adx == 2 && dy == 0) || (ady == 2 && dx == 0) || (adx <= 1 && ady <= 1),
                    // tip: center only
                    _     => dx == 0 && dy == 0,
                };
                if place { place_leaf_abs(world, wx + dx, wy + dy, wz, leaf_paint); }
            }
        }
    }
    // Trunk written last so it punches through any leaf blocks at center.
    for dz in 0..trunk_h { set_block_abs(world, wx, wy, z_base + dz, 6, 0); }
}

/// Tall terrain tree with wide ragged canopy (ported from NormalTerrainTree).
/// Bug fixed: trunk placed after leaves so it remains visible through canopy.
fn place_terrain_tree(world: &mut LoadedWorld, wx: i32, wy: i32, z_base: i32, rng: &mut Rng64) {
    let tree_h    = rng.range(6, 11);
    let trunk_h   = 3 * tree_h / 4;
    let leaf_dz0  = 2 * tree_h / 3; // first leaf layer (rel to z_base)
    let leaf_paint = NORMAL_LEAF_PAINTS[rng.range(0, 3) as usize];

    for dz in leaf_dz0..tree_h {
        let wz       = z_base + dz;
        let is_bot   = dz == leaf_dz0;
        let is_top   = dz == tree_h - 1;
        for dx in -2i32..=2 {
            for dy in -2i32..=2 {
                let is_edge   = dx.abs() == 2 || dy.abs() == 2;
                let is_corner = dx.abs() == 2 && dy.abs() == 2;
                let place = if is_edge {
                    // Skip corners on bottom & top layers; 50% random elsewhere on edges.
                    !(is_corner && (is_bot || is_top)) && rng.prob(1, 2)
                } else {
                    true // inner 3×3 always placed
                };
                if place { place_leaf_abs(world, wx + dx, wy + dy, wz, leaf_paint); }
            }
        }
    }
    for dz in 0..trunk_h { set_block_abs(world, wx, wy, z_base + dz, 6, 0); }
}

/// Small conical pine tree (ported from PineTree).
fn place_pine_tree(world: &mut LoadedWorld, wx: i32, wy: i32, z_base: i32, rng: &mut Rng64) {
    let leaf_paint = PINE_LEAF_PAINTS[rng.range(0, 2) as usize];

    // 8 leaf layers starting at dz=2 (trunk occupies dz=0..1)
    for dz in 2..10i32 {
        let wz = z_base + dz;
        for dx in -2i32..=2 {
            for dy in -2i32..=2 {
                let adx = dx.abs(); let ady = dy.abs();
                let place = match dz {
                    // wide tier: cross@dist2 + inner 3×3
                    2 | 4 => (adx == 2 && dy == 0) || (ady == 2 && dx == 0) || (adx < 2 && ady < 2),
                    // medium tier: cross@dist1 + center
                    3 | 5 | 7 => (adx == 1 && dy == 0) || (ady == 1 && dx == 0) || (dx == 0 && dy == 0),
                    // tip tiers: center only
                    _ => dx == 0 && dy == 0,
                };
                if place { place_leaf_abs(world, wx + dx, wy + dy, wz, leaf_paint); }
            }
        }
    }
    // Trunk: 2 blocks; written after leaves so they don't overwrite.
    set_block_abs(world, wx, wy, z_base,     6, 0);
    set_block_abs(world, wx, wy, z_base + 1, 6, 0);
}

/// Tall conical pine tree with 7×7 base tiers (ported from TallPineTree).
fn place_tall_pine_tree(world: &mut LoadedWorld, wx: i32, wy: i32, z_base: i32, rng: &mut Rng64) {
    let leaf_paint = PINE_LEAF_PAINTS[rng.range(0, 2) as usize];

    // 11 leaf layers (dz 2..=12)
    for dz in 2..13i32 {
        let wz = z_base + dz;
        for dx in -3i32..=3 {
            for dy in -3i32..=3 {
                let adx = dx.abs(); let ady = dy.abs();
                match dz {
                    2 | 4 => {
                        // Wide tier: cardinal points at dist 3 + inner 5×5 minus diagonal corners
                        if (adx == 3 && dy == 0) || (ady == 3 && dx == 0) {
                            place_leaf_abs(world, wx + dx, wy + dy, wz, leaf_paint);
                        } else if adx <= 2 && ady <= 2 {
                            if adx == 2 && ady == 2 {
                                // Rounded corners: clear (air) per reference behaviour
                                set_block_abs(world, wx + dx, wy + dy, wz, 0, 0);
                            } else {
                                place_leaf_abs(world, wx + dx, wy + dy, wz, leaf_paint);
                            }
                        }
                    }
                    3 | 5 | 7 => {
                        // Medium tier: cross@dist2 + inner 3×3
                        if (adx == 2 && dy == 0) || (ady == 2 && dx == 0) || (adx <= 1 && ady <= 1) {
                            place_leaf_abs(world, wx + dx, wy + dy, wz, leaf_paint);
                        }
                    }
                    6 | 8 | 10 => {
                        // Narrow tier: cross@dist1 + center
                        if (adx == 1 && dy == 0) || (ady == 1 && dx == 0) || (dx == 0 && dy == 0) {
                            place_leaf_abs(world, wx + dx, wy + dy, wz, leaf_paint);
                        }
                    }
                    _ => {
                        // Tip tiers (9, 11, 12): center only
                        if dx == 0 && dy == 0 {
                            place_leaf_abs(world, wx + dx, wy + dy, wz, leaf_paint);
                        }
                    }
                }
            }
        }
    }
    set_block_abs(world, wx, wy, z_base,     6, 0);
    set_block_abs(world, wx, wy, z_base + 1, 6, 0);
}

/// Scatter trees across the XY footprint of the current selection.
/// Each column in (x1..=x2, y1..=y2) is independently rolled against `density` (0–1).
/// Trees are planted on the topmost solid block; columns over water, lava, cloud, or
/// existing foliage are skipped. `seed` = None uses a random timestamp-based seed.
#[tauri::command]
fn generate_trees(
    x1: i32, y1: i32, x2: i32, y2: i32,
    tree_type: String,
    density: f32,
    seed: Option<u64>,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    if !matches!(tree_type.as_str(), "normal" | "terrain" | "pine" | "tall_pine") {
        return Err(format!("Unknown tree type '{tree_type}'"));
    }
    if density <= 0.0 || density > 1.0 {
        return Err("Density must be in range (0, 1]".into());
    }

    let seed = seed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as u64
    });

    let mut ws = state.lock().unwrap();
    let max_z = ws.world.as_ref().map(|w| world_max_z(w)).unwrap_or(63);
    // Only validate XY; z is ignored (trees find the surface themselves).
    if x2 < x1 || y2 < y1 {
        return Err("Invalid selection bounds".into());
    }

    let mut world = ws.world.take().ok_or("No world loaded")?;

    // Expand snapshot area by 3 to include chunks where leaves may spill over.
    let snap_x1 = (x1 - 3).max(0);
    let snap_y1 = (y1 - 3).max(0);
    let snap_x2 = x2 + 3;
    let snap_y2 = y2 + 3;
    let affected = affected_chunk_coords(&world, snap_x1, snap_y1, snap_x2, snap_y2);
    let pre_snap = snapshot_chunks(&world, &affected);

    let mut rng = Rng64::new(seed);
    let density_num = (density.clamp(0.0, 1.0) * 1_000_000.0) as u64;

    for wx in x1..=x2 {
        for wy in y1..=y2 {
            if !rng.prob(density_num, 1_000_000) { continue; }

            let sz = match surface_z(&world, wx, wy) { Some(z) => z, None => continue };

            // Read surface block type to check plantability.
            let surf_bt = {
                let cx = wx.div_euclid(16) + world.min_x;
                let cy = wy.div_euclid(16) + world.min_y;
                if let Some(&addr) = world.chunk_map.get(&(cx, cy)) {
                    let lx   = wx.rem_euclid(16) as usize;
                    let ly   = wy.rem_euclid(16) as usize;
                    let band = sz as usize / 16;
                    let lz   = sz as usize % 16;
                    let bi   = addr + band * 8192 + lx * 256 + ly * 16 + lz;
                    if bi < world.bytes.len() { world.bytes[bi] } else { 0 }
                } else { 0 }
            };

            if !is_plantable(surf_bt) { continue; }

            let z_base = sz + 1;
            if z_base > max_z { continue; }

            match tree_type.as_str() {
                "normal"    => place_normal_tree(&mut world, wx, wy, z_base, &mut rng),
                "terrain"   => place_terrain_tree(&mut world, wx, wy, z_base, &mut rng),
                "pine"      => place_pine_tree(&mut world, wx, wy, z_base, &mut rng),
                "tall_pine" => place_tall_pine_tree(&mut world, wx, wy, z_base, &mut rng),
                _ => {}
            }
        }
    }

    let patch    = render_pixels_patch(&world, x1, y1, x2, y2);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);
    ws.world     = Some(world);

    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: "generate_trees".into(), chunks: pre_snap });
        ws.redo_stack.clear();
    }

    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

/// Top-down render of the current clipboard (highest non-air block per column).
/// Axonometric top-down render for the visible region.
/// For each output pixel (px, py), rays descend from max_z. At depth dz = max_z - z,
/// the sample point drifts: sample_px = px + ski*0.5*dz, sample_py = py - ski*dz.
/// This creates a south-east viewing angle with depth-derived parallax (ski=0 is flat top-down).
#[tauri::command]
fn render_axo_region(
    x1: i32, y1: i32, x2: i32, y2: i32,
    ski: f32,
    state: tauri::State<'_, AppState>,
) -> Result<PixelPatch, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let world_w = (world.w_chunks * 16) as i32;
    let world_h = (world.h_chunks * 16) as i32;
    let ox1 = x1.clamp(0, world_w - 1) as u32;
    let oy1 = y1.clamp(0, world_h - 1) as u32;
    let ox2 = x2.clamp(0, world_w - 1) as u32;
    let oy2 = y2.clamp(0, world_h - 1) as u32;
    let width  = ox2 - ox1 + 1;
    let height = oy2 - oy1 + 1;
    let max_z = world_max_z(world) as f32;
    let mut pixels = vec![30u8; (width * height * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p[3] = 255; }

    for py in oy1..=oy2 {
        for px in ox1..=ox2 {
            let mut top_bt = 0u8; let mut top_paint = 0u8;
            let mut under_bt = 0u8; let mut under_paint = 0u8;

            'zray: for dz in 0..=(max_z as i32) {
                let wz = (max_z as i32) - dz;
                let sx = (px as f32 + ski * 0.5 * dz as f32).round() as i32;
                let sy = (py as f32 - ski * dz as f32).round() as i32;
                if sx < 0 || sx >= world_w || sy < 0 || sy >= world_h { continue; }
                let cx = (sx / 16) as i32 + world.min_x;
                let cy = (sy / 16) as i32 + world.min_y;
                let lx = (sx % 16) as usize;
                let ly = (sy % 16) as usize;
                let &addr = match world.chunk_map.get(&(cx, cy)) { Some(a) => a, None => continue };
                let band = wz as usize / 16;
                let lz   = wz as usize % 16;
                let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
                let pi = bi + 4096;
                if bi >= world.bytes.len() || pi >= world.bytes.len() { continue; }
                let bt = world.bytes[bi];
                if bt == 0 { continue; }
                if top_bt == 0 {
                    top_bt = bt; top_paint = world.bytes[pi];
                    if transparent_alpha(bt).is_none() { break 'zray; }
                } else {
                    under_bt = bt; under_paint = world.bytes[pi];
                    break 'zray;
                }
            }

            if top_bt == 0 { continue; }
            let c1 = block_color(top_bt, top_paint, world.sky);
            let [r, g, b] = if under_bt != 0 {
                if let Some(alpha) = transparent_alpha(top_bt) {
                    let c2 = block_color(under_bt, under_paint, world.sky);
                    [
                        (c1[0] as f32 * alpha + c2[0] as f32 * (1.0 - alpha)) as u8,
                        (c1[1] as f32 * alpha + c2[1] as f32 * (1.0 - alpha)) as u8,
                        (c1[2] as f32 * alpha + c2[2] as f32 * (1.0 - alpha)) as u8,
                    ]
                } else { c1 }
            } else { c1 };

            let off = (((py - oy1) * width + (px - ox1)) * 4) as usize;
            pixels[off] = r; pixels[off + 1] = g; pixels[off + 2] = b; pixels[off + 3] = 255;
        }
    }
    Ok(PixelPatch { x: ox1, y: oy1, width, height, pixels })
}

/// Used to show a block preview inside the paste ghost box.
/// Reads only from clipboard + sky — no world mutation.
#[tauri::command]
fn render_clipboard_preview(state: tauri::State<'_, AppState>) -> Result<PreviewData, String> {
    let ws  = state.lock().unwrap();
    let sky = ws.world.as_ref().map(|w| w.sky).unwrap_or(0);
    let cb  = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
    let (w, h, d) = (cb.width, cb.height, cb.depth);
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; (w * h * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }
    for dy in 0..h {
        for dx in 0..w {
            let col = (dy * w + dx) as usize;
            for dz in (0..d).rev() { // highest dz = topmost z layer
                let idx = (dz * h * w + dy * w + dx) as usize;
                let bt  = cb.block_types[idx];
                if bt != 0 {
                    let [r, g, b]       = block_color(bt, cb.paints[idx], sky);
                    pixels[col * 4]     = r;
                    pixels[col * 4 + 1] = g;
                    pixels[col * 4 + 2] = b;
                    pixels[col * 4 + 3] = 255;
                    break;
                }
            }
        }
    }
    Ok(PreviewData { width: w as u32, height: h as u32, pixels })
}

// Renders the front (X-Z) or side (Y-Z) face of the clipboard for use as a
// ghost overlay in the elevation preview panel. Transparent pixels = air.
#[tauri::command]
fn render_clipboard_elevation_preview(
    view: String,
    state: tauri::State<'_, AppState>,
) -> Result<PreviewData, String> {
    let ws  = state.lock().unwrap();
    let sky = ws.world.as_ref().map(|w| w.sky).unwrap_or(0);
    let cb  = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
    let (w, h, d) = (cb.width as usize, cb.height as usize, cb.depth as usize);
    let is_front = view != "side";
    let img_w = if is_front { w } else { h };
    let img_h = d;
    let mut pixels = vec![0u8; img_w * img_h * 4]; // alpha 0 = transparent air
    for dz in 0..d {
        let row = d - 1 - dz; // row 0 = top = highest z
        for col in 0..img_w {
            let result = if is_front {
                // col = dx, scan dy front-to-back
                (0..h).find_map(|dy| {
                    let bt = cb.block_types[dz * h * w + dy * w + col];
                    if bt != 0 { Some((bt, cb.paints[dz * h * w + dy * w + col])) } else { None }
                })
            } else {
                // col = dy, scan dx left-to-right
                (0..w).find_map(|dx| {
                    let bt = cb.block_types[dz * h * w + col * w + dx];
                    if bt != 0 { Some((bt, cb.paints[dz * h * w + col * w + dx])) } else { None }
                })
            };
            if let Some((bt, paint)) = result {
                let [r, g, b] = block_color(bt, paint, sky);
                let i = (row * img_w + col) * 4;
                pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = 255;
            }
        }
    }
    Ok(PreviewData { width: img_w as u32, height: img_h as u32, pixels })
}

// ── Prefab serialization ───────────────────────────────────────────────────────

fn serialize_prefab(cb: &Clipboard) -> Vec<u8> {
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    let n = (cb.width * cb.height * cb.depth) as usize;
    let mut raw = Vec::with_capacity(22 + 2 * n);
    raw.extend_from_slice(b"EPFAB\x01");
    for v in [cb.width, cb.height, cb.depth, cb.z_anchor] {
        raw.extend_from_slice(&v.to_le_bytes());
    }
    raw.extend_from_slice(&cb.block_types);
    raw.extend_from_slice(&cb.paints);
    let mut enc = GzEncoder::new(Vec::new(), Compression::best());
    enc.write_all(&raw).unwrap();
    enc.finish().unwrap()
}

fn deserialize_prefab(data: &[u8]) -> Result<Clipboard, String> {
    use std::borrow::Cow;
    // Auto-detect gzip (new compressed format) vs raw (legacy uncompressed).
    let raw: Cow<[u8]> = if data.starts_with(&[0x1f, 0x8b]) {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut dec = GzDecoder::new(data);
        let mut out = Vec::new();
        dec.read_to_end(&mut out)
            .map_err(|e| format!("Failed to decompress prefab: {e}"))?;
        Cow::Owned(out)
    } else {
        Cow::Borrowed(data)
    };
    let data = raw.as_ref();
    if data.len() < 22 || &data[0..6] != b"EPFAB\x01" {
        return Err("Not a valid .epfab file".into());
    }
    let width    = i32::from_le_bytes(data[6..10].try_into().unwrap());
    let height   = i32::from_le_bytes(data[10..14].try_into().unwrap());
    let depth    = i32::from_le_bytes(data[14..18].try_into().unwrap());
    let z_anchor = i32::from_le_bytes(data[18..22].try_into().unwrap());
    let n = (width * height * depth) as usize;
    if width <= 0 || height <= 0 || depth <= 0 || data.len() < 22 + 2 * n {
        return Err("Corrupt or truncated .epfab file".into());
    }
    Ok(Clipboard {
        width, height, depth, z_anchor,
        block_types: data[22..22 + n].to_vec(),
        paints:      data[22 + n..22 + 2 * n].to_vec(),
    })
}

#[tauri::command]
fn save_prefab(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let ws = state.lock().unwrap();
    let cb = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
    let bytes = serialize_prefab(cb);
    fs::write(&path, bytes).map_err(|e| format!("Failed to write prefab: {e}"))
}

#[tauri::command]
fn load_prefab(path: String, state: tauri::State<'_, AppState>) -> Result<ClipboardInfo, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read prefab: {e}"))?;
    let cb   = deserialize_prefab(&data)?;
    let info = ClipboardInfo {
        width: cb.width, height: cb.height,
        depth: cb.depth, z_anchor: cb.z_anchor,
    };
    let mut ws = state.lock().unwrap();
    ws.clipboard = Some(cb);
    Ok(info)
}

// ── OBJ Export ────────────────────────────────────────────────────────────────

fn get_block_at(world: &LoadedWorld, wx: i32, wy: i32, wz: i32) -> (u8, u8) {
    if wz < 0 || wz as usize >= world.num_bands * 16 { return (0, 0); }
    let cx = wx.div_euclid(16) + world.min_x;
    let cy = wy.div_euclid(16) + world.min_y;
    if let Some(&addr) = world.chunk_map.get(&(cx, cy)) {
        let lx = wx.rem_euclid(16) as usize;
        let ly = wy.rem_euclid(16) as usize;
        let band = wz as usize / 16;
        let lz   = wz as usize % 16;
        let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
        let pi = bi + 4096;
        if bi < world.bytes.len() && pi < world.bytes.len() {
            return (world.bytes[bi], world.bytes[pi]);
        }
    }
    (0, 0)
}

/// True if this block fully occludes an adjacent face (solid, not air/transparent/ramp/wedge).
fn obj_occludes(bt: u8) -> bool {
    bt != 0 && transparent_alpha(bt).is_none() && !matches!(bt, 24..=55)
}

/// Eden (X right, Y south, Z up) → OBJ (X right, Y up, Z toward viewer)
fn ov(ex: f32, ey: f32, ez: f32) -> (f32, f32, f32) { (ex, ez, -ey) }

fn obj_v(w: &mut impl Write, (x, y, z): (f32, f32, f32)) -> std::io::Result<()> {
    writeln!(w, "v {x} {y} {z}")
}

fn obj_quad(w: &mut impl Write) -> std::io::Result<()> { writeln!(w, "f -4 -3 -2 -1") }
fn obj_tri(w: &mut impl Write)  -> std::io::Result<()> { writeln!(w, "f -3 -2 -1") }

/// Emit a cube block with face culling (skips faces adjacent to fully-opaque neighbors).
fn emit_cube(w: &mut impl Write, wx: i32, wy: i32, wz: i32, world: &LoadedWorld) -> std::io::Result<()> {
    let (x0, x1) = (wx as f32, wx as f32 + 1.0);
    let (y0, y1) = (wy as f32, wy as f32 + 1.0);
    let (z0, z1) = (wz as f32, wz as f32 + 1.0);
    if !obj_occludes(get_block_at(world,wx,wy,wz+1).0) {
        obj_v(w,ov(x0,y0,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x0,y1,z1))?; obj_quad(w)?;
    }
    if !obj_occludes(get_block_at(world,wx,wy,wz-1).0) {
        obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_quad(w)?;
    }
    if !obj_occludes(get_block_at(world,wx,wy+1,wz).0) {
        obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x0,y1,z1))?; obj_quad(w)?;
    }
    if !obj_occludes(get_block_at(world,wx,wy-1,wz).0) {
        obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y0,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_quad(w)?;
    }
    if !obj_occludes(get_block_at(world,wx+1,wy,wz).0) {
        obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y0,z1))?; obj_v(w,ov(x1,y1,z1))?; obj_quad(w)?;
    }
    if !obj_occludes(get_block_at(world,wx-1,wy,wz).0) {
        obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_quad(w)?;
    }
    Ok(())
}

/// Emit a ramp as a triangular prism. dir: 0=South 1=West 2=North 3=East (high edge direction).
fn emit_ramp(w: &mut impl Write, wx: i32, wy: i32, wz: i32, dir: u8, world: &LoadedWorld) -> std::io::Result<()> {
    let (x0, x1) = (wx as f32, wx as f32 + 1.0);
    let (y0, y1) = (wy as f32, wy as f32 + 1.0);
    let (z0, z1) = (wz as f32, wz as f32 + 1.0);
    // Bottom — cull if solid below
    if !obj_occludes(get_block_at(world, wx, wy, wz - 1).0) {
        obj_v(w, ov(x0,y1,z0))?; obj_v(w, ov(x1,y1,z0))?;
        obj_v(w, ov(x1,y0,z0))?; obj_v(w, ov(x0,y0,z0))?;
        obj_quad(w)?;
    }
    match dir {
        0 => { // South: high edge at +Y
            obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x0,y1,z1))?; obj_quad(w)?;
            obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_tri(w)?;
            obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_tri(w)?;
            obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x0,y1,z1))?; obj_quad(w)?;
        }
        1 => { // West: high edge at -X
            obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_quad(w)?;
            obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_tri(w)?;
            obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y0,z1))?; obj_tri(w)?;
            obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_quad(w)?;
        }
        2 => { // North: high edge at -Y
            obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y0,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_quad(w)?;
            obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y0,z1))?; obj_tri(w)?;
            obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y0,z1))?; obj_tri(w)?;
            obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y0,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_quad(w)?;
        }
        _ => { // East (dir=3): high edge at +X
            obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y0,z1))?; obj_v(w,ov(x1,y1,z1))?; obj_quad(w)?;
            obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y0,z1))?; obj_tri(w)?;
            obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_tri(w)?;
            obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y0,z1))?; obj_v(w,ov(x1,y1,z1))?; obj_quad(w)?;
        }
    }
    Ok(())
}

/// Emit a wedge as a pyramid (1 apex, 4 base corners). dir: 0=SE 1=SW 2=NW 3=NE (apex at opposite corner).
fn emit_wedge(w: &mut impl Write, wx: i32, wy: i32, wz: i32, dir: u8, world: &LoadedWorld) -> std::io::Result<()> {
    let (x0, x1) = (wx as f32, wx as f32 + 1.0);
    let (y0, y1) = (wy as f32, wy as f32 + 1.0);
    let (z0, z1) = (wz as f32, wz as f32 + 1.0);
    // Bottom
    if !obj_occludes(get_block_at(world, wx, wy, wz - 1).0) {
        obj_v(w, ov(x0,y1,z0))?; obj_v(w, ov(x1,y1,z0))?;
        obj_v(w, ov(x1,y0,z0))?; obj_v(w, ov(x0,y0,z0))?;
        obj_quad(w)?;
    }
    // Apex corner and 4 sloped/vertical faces
    let (ax, ay) = match dir {
        0 => (x0, y0), // SE wedge: apex at NW
        1 => (x1, y0), // SW wedge: apex at NE
        2 => (x1, y1), // NW wedge: apex at SE
        _ => (x0, y1), // NE wedge: apex at SW
    };
    // Two vertical faces adjacent to the apex corner
    match dir {
        0 => {
            obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(ax,ay,z1))?; obj_tri(w)?; // West
            obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(ax,ay,z1))?; obj_tri(w)?; // North
            obj_v(w,ov(ax,ay,z1))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_tri(w)?; // Slope1
            obj_v(w,ov(ax,ay,z1))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_tri(w)?; // Slope2
        }
        1 => {
            obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(ax,ay,z1))?; obj_tri(w)?; // East
            obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(ax,ay,z1))?; obj_tri(w)?; // North
            obj_v(w,ov(ax,ay,z1))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_tri(w)?; // Slope1
            obj_v(w,ov(ax,ay,z1))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_tri(w)?; // Slope2
        }
        2 => {
            obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(ax,ay,z1))?; obj_tri(w)?; // East
            obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(ax,ay,z1))?; obj_tri(w)?; // South
            obj_v(w,ov(ax,ay,z1))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_tri(w)?; // Slope1
            obj_v(w,ov(ax,ay,z1))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_tri(w)?; // Slope2
        }
        _ => {
            obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(ax,ay,z1))?; obj_tri(w)?; // West
            obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(ax,ay,z1))?; obj_tri(w)?; // South
            obj_v(w,ov(ax,ay,z1))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_tri(w)?; // Slope1
            obj_v(w,ov(ax,ay,z1))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_tri(w)?; // Slope2
        }
    }
    Ok(())
}

#[tauri::command]
fn export_obj(
    state: tauri::State<'_, AppState>,
    path: String,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<(), String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;

    let sx1 = x1.min(x2); let sx2 = x1.max(x2);
    let sy1 = y1.min(y2); let sy2 = y1.max(y2);
    let sz1 = z_min.min(z_max).max(0);
    let sz2 = z_min.max(z_max).min(world_max_z(world));

    // Collect unique (block_type, paint) combos for the MTL file.
    let mut mat_set: HashSet<(u8, u8)> = HashSet::new();
    for wz in sz1..=sz2 {
        for wy in sy1..=sy2 {
            for wx in sx1..=sx2 {
                let (bt, paint) = get_block_at(world, wx, wy, wz);
                if bt != 0 { mat_set.insert((bt, paint)); }
            }
        }
    }
    let mut mat_list: Vec<(u8, u8)> = mat_set.into_iter().collect();
    mat_list.sort();

    let obj_path = std::path::Path::new(&path);
    let stem = obj_path.file_stem().and_then(|s| s.to_str()).unwrap_or("world");
    let mtl_path = obj_path.with_extension("mtl");
    let mtl_filename = format!("{stem}.mtl");

    // Write MTL
    {
        let f = fs::File::create(&mtl_path).map_err(|e| format!("Cannot create MTL: {e}"))?;
        let mut mw = BufWriter::new(f);
        writeln!(mw, "# Eden World Editor — material library").map_err(|e| e.to_string())?;
        for &(bt, paint) in &mat_list {
            let [r, g, b] = block_color(bt, paint, world.sky);
            writeln!(mw, "\nnewmtl m_{bt}_{paint}").map_err(|e| e.to_string())?;
            writeln!(mw, "Kd {:.4} {:.4} {:.4}", r as f32/255.0, g as f32/255.0, b as f32/255.0)
                .map_err(|e| e.to_string())?;
            writeln!(mw, "Ka 0.1 0.1 0.1\nKs 0.0 0.0 0.0").map_err(|e| e.to_string())?;
            if let Some(a) = transparent_alpha(bt) {
                writeln!(mw, "d {a:.2}").map_err(|e| e.to_string())?;
            }
        }
    }

    // Write OBJ
    let f = fs::File::create(&path).map_err(|e| format!("Cannot create OBJ: {e}"))?;
    let mut ow = BufWriter::new(f);
    writeln!(ow, "# Eden World Editor OBJ export").map_err(|e| e.to_string())?;
    writeln!(ow, "# Bounds ({sx1},{sy1},{sz1})–({sx2},{sy2},{sz2})").map_err(|e| e.to_string())?;
    writeln!(ow, "mtllib {mtl_filename}").map_err(|e| e.to_string())?;

    let mut cur_mat = String::new();

    for wz in sz1..=sz2 {
        for wy in sy1..=sy2 {
            for wx in sx1..=sx2 {
                let (bt, paint) = get_block_at(world, wx, wy, wz);
                if bt == 0 { continue; }

                let mat = format!("m_{bt}_{paint}");
                if mat != cur_mat {
                    writeln!(ow, "\nusemtl {mat}").map_err(|e| e.to_string())?;
                    cur_mat = mat;
                }

                if matches!(bt, 24..=39) {
                    let base = 24 + ((bt - 24) / 4) * 4;
                    emit_ramp(&mut ow, wx, wy, wz, bt - base, world).map_err(|e| e.to_string())?;
                } else if matches!(bt, 40..=55) {
                    let base = 40 + ((bt - 40) / 4) * 4;
                    emit_wedge(&mut ow, wx, wy, wz, bt - base, world).map_err(|e| e.to_string())?;
                } else {
                    emit_cube(&mut ow, wx, wy, wz, world).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    Ok(())
}

// ── App entry point ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ── Network commands ─────────────────────────────────────────────────────────

/// Search the Eden world server. Returns worlds ordered as received from server.
/// Fetches file sizes via parallel HEAD requests.
#[tauri::command]
async fn search_worlds(query: String, server: String) -> Result<Vec<WorldSearchResult>, String> {
    let srv = get_server(&server)?;
    let url = format!("{}?search={}", srv.search_url, urlencoding_encode(&query));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let text = client.get(&url).send().await
        .map_err(|e| format!("Failed to query {server} server: {e}"))?
        .text().await
        .map_err(|e| e.to_string())?;

    let lines: Vec<&str> = text.lines().collect();
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i + 1 < lines.len() {
        let id_line = lines[i].trim();
        let name_line = lines[i + 1].trim();
        if id_line.ends_with(".eden") && name_line.ends_with(".name") {
            let id = id_line.trim_end_matches(".eden").to_string();
            let name = name_line.trim_end_matches(".name").to_string();
            pairs.push((id, name));
        }
        i += 2;
    }

    let results: Vec<WorldSearchResult> = pairs
        .into_iter()
        .map(|(id, name)| {
            let timestamp = id.parse::<i64>().unwrap_or(0);
            WorldSearchResult { id, name, timestamp }
        })
        .collect();

    Ok(results)
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(char::from_digit((b >> 4) as u32, 16).unwrap().to_ascii_uppercase());
                out.push(char::from_digit((b & 0xf) as u32, 16).unwrap().to_ascii_uppercase());
            }
        }
    }
    out
}

/// Download a world from the Eden server, streaming to disk with progress events.
#[tauri::command]
async fn download_world(
    app: tauri::AppHandle,
    id: String,
    server: String,
    dest_path: String,
) -> Result<(), String> {
    let srv = get_server(&server)?;
    let url = format!("{}/{}.eden", srv.download_base_url, id);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client.get(&url).send().await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Server returned {}", response.status()));
    }

    let total = response.content_length();
    let mut downloaded: u64 = 0;
    let mut body: Vec<u8> = Vec::new();

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        downloaded += chunk.len() as u64;
        body.extend_from_slice(&chunk);
        let _ = app.emit("download-progress", serde_json::json!({
            "downloaded": downloaded,
            "total": total
        }));
    }

    // Server delivers worlds gzip-compressed; decompress to raw .eden before saving
    // so load_world can mmap it directly (it only handles zip-PK or raw).
    let final_bytes: Vec<u8> = if body.starts_with(&[0x1f, 0x8b]) {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut dec = GzDecoder::new(body.as_slice());
        let mut out = Vec::new();
        dec.read_to_end(&mut out).map_err(|e| format!("Decompression failed: {e}"))?;
        out
    } else {
        body
    };

    let tmp_path = format!("{}.tmp", dest_path);
    fs::write(&tmp_path, &final_bytes).map_err(|e| format!("Write failed: {e}"))?;
    fs::rename(&tmp_path, &dest_path).map_err(|e| format!("Rename failed: {e}"))?;

    Ok(())
}

/// Upload a world file + PNG preview to the Eden server.
/// GETs the upload page first to obtain the server-assigned uuid (client IP),
/// then POSTs the multipart form with ?uuid=<ip>.
#[tauri::command]
async fn upload_world(
    app: tauri::AppHandle,
    world_path: String,
    image_path: String,
    server: String,
) -> Result<String, String> {
    let srv = get_server(&server)?;
    let raw_world = fs::read(&world_path).map_err(|e| format!("Cannot read world: {e}"))?;
    let image_bytes = fs::read(&image_path).map_err(|e| format!("Cannot read image: {e}"))?;
    const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
    if image_bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "Preview image is {:.1} MB — maximum allowed size is 2 MB",
            image_bytes.len() as f64 / 1_048_576.0
        ));
    }

    // Server stores and delivers worlds as gzip; upload in gzip format to match.
    // If already gzip: upload as-is. If zip (PK): decompress to raw first, then gzip.
    let world_bytes: Vec<u8> = if raw_world.starts_with(&[0x1f, 0x8b]) {
        raw_world
    } else {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let raw = if raw_world.starts_with(&[0x50, 0x4B, 0x03, 0x04]) {
            use zip::ZipArchive;
            let cursor = std::io::Cursor::new(&raw_world);
            let mut archive = ZipArchive::new(cursor).map_err(|e| format!("Invalid zip: {e}"))?;
            let mut entry = archive.by_index(0).map_err(|e| format!("Zip entry: {e}"))?;
            let mut out = Vec::new();
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("Decompress zip: {e}"))?;
            out
        } else {
            raw_world
        };
        let mut enc = GzEncoder::new(Vec::new(), Compression::best());
        enc.write_all(&raw).map_err(|e| format!("Gzip write: {e}"))?;
        enc.finish().map_err(|e| format!("Gzip finish: {e}"))?
    };

    let total = (world_bytes.len() + image_bytes.len()) as u64;

    let _ = app.emit("upload-progress", serde_json::json!({ "bytes_sent": 0u64, "total": total }));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // Generate a UUID-format identifier matching what the iOS Eden client sends
    // (UIDevice.identifierForVendor — format XXXXXXXX-XXXX-4XXX-8XXX-XXXXXXXXXXXX).
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let uuid = format!("{:08X}-{:04X}-4{:03X}-{:04X}-{:012X}",
        ts as u32,
        (ts >> 32) as u16,
        (ts >> 16) as u16 & 0xFFF,
        0x8000u16 | ((ts >> 48) as u16 & 0x3FFF),
        ts & 0x0000_FFFF_FFFF_FFFF_u64);
    let post_url = format!("{}?uuid={}", srv.upload_url, uuid);

    let world_filename = std::path::Path::new(&world_path)
        .file_name().and_then(|f| f.to_str()).unwrap_or("world.eden")
        .to_string();
    let image_filename = std::path::Path::new(&image_path)
        .file_name().and_then(|f| f.to_str()).unwrap_or("preview.png")
        .to_string();

    let form = reqwest::multipart::Form::new()
        .part("file.bin", reqwest::multipart::Part::bytes(world_bytes)
            .file_name(world_filename)
            .mime_str("application/octet-stream").unwrap())
        .part("image.bin", reqwest::multipart::Part::bytes(image_bytes)
            .file_name(image_filename)
            .mime_str("image/png").unwrap())
        .text("submit", "Upload");

    let response = client.post(&post_url).multipart(form).send().await
        .map_err(|e| format!("Upload failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    let _ = app.emit("upload-progress", serde_json::json!({ "bytes_sent": total, "total": total }));

    if !status.is_success() {
        return Err(format!("Server returned {status}: {body}"));
    }

    Ok(body)
}

// ── Terrain helpers ───────────────────────────────────────────────────────────

/// Read block type at absolute world coords (0 if out of bounds or missing chunk).
fn read_block_abs(world: &LoadedWorld, wx: i32, wy: i32, wz: i32) -> u8 {
    if wz < 0 || wz as usize >= world.num_bands * 16 { return 0; }
    let cx = wx.div_euclid(16) + world.min_x;
    let cy = wy.div_euclid(16) + world.min_y;
    if let Some(&addr) = world.chunk_map.get(&(cx, cy)) {
        let lx = wx.rem_euclid(16) as usize;
        let ly = wy.rem_euclid(16) as usize;
        let bi = addr + (wz as usize / 16) * 8192 + lx * 256 + ly * 16 + wz as usize % 16;
        if bi < world.bytes.len() { return world.bytes[bi]; }
    }
    0
}

/// Read paint byte at absolute world coords (0 if out of bounds or missing chunk).
fn read_paint_abs(world: &LoadedWorld, wx: i32, wy: i32, wz: i32) -> u8 {
    if wz < 0 || wz as usize >= world.num_bands * 16 { return 0; }
    let cx = wx.div_euclid(16) + world.min_x;
    let cy = wy.div_euclid(16) + world.min_y;
    if let Some(&addr) = world.chunk_map.get(&(cx, cy)) {
        let lx = wx.rem_euclid(16) as usize;
        let ly = wy.rem_euclid(16) as usize;
        let bi = addr + (wz as usize / 16) * 8192 + lx * 256 + ly * 16 + wz as usize % 16;
        let pi = bi + 4096;
        if pi < world.bytes.len() { return world.bytes[pi]; }
    }
    0
}

/// Raise or lower a terrain column to target_z. Raising copies the surface block;
/// lowering deletes blocks above the new surface.
fn sculpt_column(world: &mut LoadedWorld, wx: i32, wy: i32, cur_z: i32, target_z: i32, max_z: i32, surf_bt: u8, surf_paint: u8) {
    let target_z = target_z.clamp(1, max_z);
    if target_z == cur_z { return; }
    if target_z > cur_z {
        for z in (cur_z + 1)..=target_z {
            set_block_abs(world, wx, wy, z, surf_bt, surf_paint);
        }
    } else {
        for z in (target_z + 1)..=cur_z {
            set_block_abs(world, wx, wy, z, 0, 0);
        }
    }
}

// ── Sculpt terrain command ────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct SculptPoint { x: i32, y: i32 }

/// Sculpt terrain at brush positions. mode: "smooth" | "noise" | "flatten" | "erode"
#[tauri::command]
fn sculpt_terrain(
    points: Vec<SculptPoint>,
    mode: String,
    strength: i32,
    seed: u64,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    if points.is_empty() { return Err("No points".into()); }
    let strength = strength.clamp(1, 5);

    let mut ws = state.lock().unwrap();

    // Pre-read all heights and surface blocks while we have a shared ref.
    let height_map: HashMap<(i32, i32), (i32, u8, u8)> = {
        let world = ws.world.as_ref().ok_or("No world loaded")?;
        let mut all_pts = std::collections::HashSet::new();
        for p in &points {
            all_pts.insert((p.x, p.y));
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                all_pts.insert((p.x + dx, p.y + dy));
            }
        }
        all_pts.into_iter()
            .filter_map(|(x, y)| {
                surface_z(world, x, y).map(|z| {
                    let bt    = read_block_abs(world, x, y, z);
                    let paint = read_paint_abs(world, x, y, z);
                    ((x, y), (z, bt, paint))
                })
            })
            .collect()
    };

    let mut world = ws.world.take().ok_or("No world loaded")?;
    let max_z = world_max_z(&world) as i32;

    let (mut x_min, mut y_min, mut x_max, mut y_max) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for p in &points {
        x_min = x_min.min(p.x); y_min = y_min.min(p.y);
        x_max = x_max.max(p.x); y_max = y_max.max(p.y);
    }

    let affected = affected_chunk_coords(&world, x_min, y_min, x_max, y_max);
    let pre_snap = snapshot_chunks(&world, &affected);

    match mode.as_str() {
        "smooth" => {
            for p in &points {
                let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                let neighbors: Vec<i32> = [(-1i32,0i32),(1,0),(0,-1),(0,1)].iter()
                    .filter_map(|(dx,dy)| height_map.get(&(p.x+dx, p.y+dy)).map(|v| v.0))
                    .collect();
                if neighbors.is_empty() { continue; }
                let sum = neighbors.iter().sum::<i32>() + cur_z;
                let avg = (sum as f32 / (neighbors.len() + 1) as f32).round() as i32;
                sculpt_column(&mut world, p.x, p.y, cur_z, avg, max_z, surf_bt, surf_paint);
            }
        }
        "noise" => {
            let mut rng = Rng64::new(if seed == 0 { 0xdeadbeef_cafebabe } else { seed });
            for p in &points {
                let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                let _ = rng.next(); // positional mix for variation
                let delta = rng.range(-strength, strength);
                sculpt_column(&mut world, p.x, p.y, cur_z, cur_z + delta, max_z, surf_bt, surf_paint);
            }
        }
        "flatten" => {
            let heights: Vec<i32> = points.iter()
                .filter_map(|p| height_map.get(&(p.x, p.y)).map(|v| v.0))
                .collect();
            if heights.is_empty() { ws.world = Some(world); return Err("No surface".into()); }
            let avg = (heights.iter().sum::<i32>() as f32 / heights.len() as f32).round() as i32;
            for p in &points {
                let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                sculpt_column(&mut world, p.x, p.y, cur_z, avg, max_z, surf_bt, surf_paint);
            }
        }
        "erode" => {
            for p in &points {
                let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                let min_n = [(-1i32,0i32),(1,0),(0,-1),(0,1)].iter()
                    .filter_map(|(dx,dy)| height_map.get(&(p.x+dx, p.y+dy)).map(|v| v.0))
                    .min();
                if let Some(mn) = min_n {
                    if cur_z > mn {
                        let target = (cur_z - strength).max(mn);
                        sculpt_column(&mut world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint);
                    }
                }
            }
        }
        _ => {}
    }

    let patch = render_pixels_patch(&world, x_min, y_min, x_max, y_max);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);
    ws.world = Some(world);

    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: format!("sculpt_{mode}"), chunks: pre_snap });
        ws.redo_stack.clear();
    }
    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

// ── Fill surface (flood fill) ─────────────────────────────────────────────────

/// Flood-fill connected surface blocks of the same type as the seed position.
#[tauri::command]
fn fill_surface(
    wx: i32, wy: i32,
    new_type: u8, new_paint: u8,
    max_fill: u32,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    if new_paint > 54 { return Err("Invalid paint".into()); }
    let max_fill = max_fill.clamp(1, 50_000);

    let mut ws = state.lock().unwrap();

    // Phase 1: BFS to collect all cells to fill (read-only pass).
    let (fill_cells, x_min, y_min, x_max, y_max) = {
        let world = ws.world.as_ref().ok_or("No world loaded")?;
        let seed_z     = surface_z(world, wx, wy).ok_or("No surface at position")?;
        let seed_bt    = read_block_abs(world, wx, wy, seed_z);
        let seed_paint = read_paint_abs(world, wx, wy, seed_z);
        if seed_bt == 0 { return Err("No block at surface".into()); }
        let ww = (world.w_chunks * 16) as i32;
        let wh = (world.h_chunks * 16) as i32;

        let mut visited: std::collections::HashSet<(i32, i32)> = std::collections::HashSet::new();
        let mut queue: VecDeque<(i32, i32)> = VecDeque::new();
        let mut cells: Vec<(i32, i32, i32)> = Vec::new();
        queue.push_back((wx, wy));
        visited.insert((wx, wy));

        while let Some((x, y)) = queue.pop_front() {
            if cells.len() as u32 >= max_fill { break; }
            let Some(sz) = surface_z(world, x, y) else { continue };
            if read_block_abs(world, x, y, sz) != seed_bt { continue; }
            if read_paint_abs(world, x, y, sz) != seed_paint { continue; }
            cells.push((x, y, sz));
            for (dx, dy) in [(-1i32,0i32),(1,0),(0,-1),(0,1)] {
                let nx = x + dx; let ny = y + dy;
                if nx < 0 || ny < 0 || nx >= ww || ny >= wh { continue; }
                if visited.insert((nx, ny)) { queue.push_back((nx, ny)); }
            }
        }

        if cells.is_empty() {
            return Err("No fillable surface found".into());
        }
        let (x0, y0, x1, y1) = cells.iter().fold(
            (i32::MAX, i32::MAX, i32::MIN, i32::MIN),
            |(x0,y0,x1,y1), &(x,y,_)| (x0.min(x), y0.min(y), x1.max(x), y1.max(y))
        );
        (cells, x0, y0, x1, y1)
    };

    let mut world = ws.world.take().ok_or("No world loaded")?;
    let affected = affected_chunk_coords(&world, x_min, y_min, x_max, y_max);
    let pre_snap = snapshot_chunks(&world, &affected);

    for &(x, y, z) in &fill_cells {
        set_block_abs(&mut world, x, y, z, new_type, new_paint);
    }

    let patch = render_pixels_patch(&world, x_min, y_min, x_max, y_max);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);
    ws.world = Some(world);

    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: "fill_surface".into(), chunks: pre_snap });
        ws.redo_stack.clear();
    }
    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

// ── Selection helpers ─────────────────────────────────────────────────────────

#[derive(Serialize)]
struct SelectRect { x1: i32, y1: i32, x2: i32, y2: i32 }

/// Flood-fill select connected surface region matching (wx,wy).
/// When match_paint is false, only block type is compared (ignores paint colour).
/// Returns the bounding box of the selected region.
#[tauri::command]
fn magic_wand_select(
    wx: i32, wy: i32,
    match_paint: bool,
    state: tauri::State<'_, AppState>,
) -> Result<Option<SelectRect>, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let seed_z     = match surface_z(world, wx, wy) { Some(z) => z, None => return Ok(None) };
    let seed_bt    = read_block_abs(world, wx, wy, seed_z);
    let seed_paint = read_paint_abs(world, wx, wy, seed_z);
    if seed_bt == 0 { return Ok(None); }

    let ww = (world.w_chunks * 16) as i32;
    let wh = (world.h_chunks * 16) as i32;
    const MAX_CELLS: u32 = 50_000;

    let mut visited: std::collections::HashSet<(i32, i32)> = std::collections::HashSet::new();
    let mut queue:   VecDeque<(i32, i32)> = VecDeque::new();
    let (mut x_min, mut y_min, mut x_max, mut y_max) = (wx, wy, wx, wy);
    let mut count = 0u32;

    queue.push_back((wx, wy));
    visited.insert((wx, wy));

    while let Some((x, y)) = queue.pop_front() {
        if count >= MAX_CELLS { break; }
        let Some(sz) = surface_z(world, x, y) else { continue };
        if read_block_abs(world, x, y, sz) != seed_bt { continue; }
        if match_paint && read_paint_abs(world, x, y, sz) != seed_paint { continue; }
        x_min = x_min.min(x); y_min = y_min.min(y);
        x_max = x_max.max(x); y_max = y_max.max(y);
        count += 1;
        for (dx, dy) in [(-1i32,0i32),(1,0),(0,-1),(0,1)] {
            let nx = x + dx; let ny = y + dy;
            if nx < 0 || ny < 0 || nx >= ww || ny >= wh { continue; }
            if visited.insert((nx, ny)) { queue.push_back((nx, ny)); }
        }
    }

    if count == 0 { return Ok(None); }
    Ok(Some(SelectRect { x1: x_min, y1: y_min, x2: x_max, y2: y_max }))
}

// ── Scatter / Array paste ─────────────────────────────────────────────────────

/// Helper: paste clipboard at a single world position. Assumes world is already taken.
fn paste_clipboard_at(
    world: &mut LoadedWorld,
    px: i32, py: i32,
    block_types: &[u8], paints: &[u8],
    width: i32, height: i32, depth: i32, z_anchor: i32,
    elevation_offset: i32, ignore_air: bool,
    max_z: i32,
) {
    for dz in 0..depth {
        let tz = z_anchor + elevation_offset + dz;
        if tz < 0 || tz > max_z { continue; }
        let band = tz as usize / 16;
        let lz   = tz as usize % 16;
        for dy in 0..height {
            let ty = py + dy; if ty < 0 { continue; }
            let chunk_cy = ty / 16 + world.min_y;
            let ly = (ty % 16) as usize;
            for dx in 0..width {
                let tx = px + dx; if tx < 0 { continue; }
                let chunk_cx = tx / 16 + world.min_x;
                let lx = (tx % 16) as usize;
                let idx = (dz * height * width + dy * width + dx) as usize;
                let bt = block_types[idx];
                if ignore_air && bt == 0 { continue; }
                let &addr = match world.chunk_map.get(&(chunk_cx, chunk_cy)) { Some(a) => a, None => continue };
                let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
                let pi = bi + 4096;
                if bi < world.bytes.len() { world.bytes[bi] = bt; }
                if pi < world.bytes.len() { world.bytes[pi] = paints[idx]; }
            }
        }
    }
}

/// Paste clipboard at `count` random positions within the bounding box.
#[tauri::command]
fn scatter_paste(
    x1: i32, y1: i32, x2: i32, y2: i32,
    count: i32,
    seed: u64,
    elevation_offset: i32,
    ignore_air: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let count = count.clamp(1, 100);
    let mut ws = state.lock().unwrap();

    let (width, height, depth, z_anchor, block_types, paints) = {
        let cb = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
        (cb.width, cb.height, cb.depth, cb.z_anchor, cb.block_types.clone(), cb.paints.clone())
    };

    let mut world = ws.world.take().ok_or("No world loaded")?;
    let max_z = world_max_z(&world) as i32;

    let affected = affected_chunk_coords(&world, x1, y1, x2, y2);
    let pre_snap = snapshot_chunks(&world, &affected);

    let range_x = (x2 - x1 - width + 2).max(1) as u64;
    let range_y = (y2 - y1 - height + 2).max(1) as u64;
    let mut rng = Rng64::new(if seed == 0 { 0xdeadbeef_cafebabe } else { seed });

    for _ in 0..count {
        let px = x1 + (rng.next() % range_x) as i32;
        let py = y1 + (rng.next() % range_y) as i32;
        paste_clipboard_at(&mut world, px, py, &block_types, &paints,
            width, height, depth, z_anchor, elevation_offset, ignore_air, max_z);
    }

    let patch = render_pixels_patch(&world, x1, y1, x2, y2);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);
    ws.world = Some(world);

    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: "scatter_paste".into(), chunks: pre_snap });
        ws.redo_stack.clear();
    }
    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

/// Paste clipboard in a cols × rows grid with given spacing.
#[tauri::command]
fn array_paste(
    origin_x: i32, origin_y: i32,
    cols: i32, rows: i32,
    spacing_x: i32, spacing_y: i32,
    elevation_offset: i32,
    ignore_air: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let cols = cols.clamp(1, 20);
    let rows = rows.clamp(1, 20);
    let mut ws = state.lock().unwrap();

    let (width, height, depth, z_anchor, block_types, paints) = {
        let cb = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
        (cb.width, cb.height, cb.depth, cb.z_anchor, cb.block_types.clone(), cb.paints.clone())
    };

    let step_x = if spacing_x > 0 { spacing_x } else { width };
    let step_y = if spacing_y > 0 { spacing_y } else { height };
    let x2 = origin_x + (cols - 1) * step_x + width  - 1;
    let y2 = origin_y + (rows - 1) * step_y + height - 1;

    let mut world = ws.world.take().ok_or("No world loaded")?;
    let max_z = world_max_z(&world) as i32;

    let affected = affected_chunk_coords(&world, origin_x, origin_y, x2, y2);
    let pre_snap = snapshot_chunks(&world, &affected);

    for row in 0..rows {
        for col in 0..cols {
            let px = origin_x + col * step_x;
            let py = origin_y + row * step_y;
            paste_clipboard_at(&mut world, px, py, &block_types, &paints,
                width, height, depth, z_anchor, elevation_offset, ignore_air, max_z);
        }
    }

    let patch = render_pixels_patch(&world, origin_x, origin_y, x2, y2);
    let pre_snap = filter_unchanged_snapshots(&world, pre_snap);
    ws.world = Some(world);

    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: "array_paste".into(), chunks: pre_snap });
        ws.redo_stack.clear();
    }
    Ok(EditResult { patch, undo_depth: ws.undo_stack.len(), redo_depth: ws.redo_stack.len() })
}

// ── Find nearest block ────────────────────────────────────────────────────────

#[derive(Serialize)]
struct WorldPos { x: i32, y: i32 }

/// Find the nearest surface block of a given type, searching outward from center.
#[tauri::command]
fn find_nearest_block(
    center_x: i32, center_y: i32,
    block_type: u8,
    state: tauri::State<'_, AppState>,
) -> Result<Option<WorldPos>, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let ww = (world.w_chunks * 16) as i32;
    let wh = (world.h_chunks * 16) as i32;
    const MAX_RADIUS: i32 = 512;

    for radius in 0..=MAX_RADIUS {
        let x_lo = (center_x - radius).max(0);
        let x_hi = (center_x + radius).min(ww - 1);
        let y_lo = (center_y - radius).max(0);
        let y_hi = (center_y + radius).min(wh - 1);
        for y in y_lo..=y_hi {
            for x in x_lo..=x_hi {
                // Only scan the ring at this radius
                if (y - center_y).abs() < radius && (x - center_x).abs() < radius { continue; }
                if let Some(sz) = surface_z(world, x, y) {
                    if read_block_abs(world, x, y, sz) == block_type {
                        return Ok(Some(WorldPos { x, y }));
                    }
                }
            }
        }
    }
    Ok(None)
}

pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(WorldState::new()))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_world,
            fetch_tile,
            save_png,
            render_zslice,
            describe_selection,
            delete_blocks,
            replace_blocks,
            paint_blocks,
            save_world,
            undo_edit,
            redo_edit,
            copy_selection,
            rotate_clipboard,
            mirror_clipboard_x,
            mirror_clipboard_y,
            paste_at,
            paste_terrain,
            render_zslice_patch,
            render_selection_view,
            render_full_height_view,
            extrude_selection,
            render_clipboard_preview,
            render_clipboard_elevation_preview,
            save_prefab,
            load_prefab,
            generate_trees,
            render_axo_region,
            search_worlds,
            download_world,
            upload_world,
            get_surface_z,
            rename_world,
            sculpt_terrain,
            fill_surface,
            magic_wand_select,
            scatter_paste,
            array_paste,
            find_nearest_block,
            export_obj,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an anonymous MmapMut from a byte vector (tests only — no file on disk).
    fn mmap_from_bytes(data: Vec<u8>) -> MmapMut {
        let mut m = MmapMut::map_anon(data.len()).expect("anon mmap");
        m.copy_from_slice(&data);
        m
    }

    /// Build the smallest valid .eden binary that exercises the parser and editor:
    ///   - 4 096-byte header section (pointer-table offset + name + padding)
    ///   - 32 768-byte chunk block at offset 4 096, chunk coord (0, 0)
    ///   - 16-byte pointer-table entry at offset 36 864
    ///
    /// Test blocks pre-placed (all in column lx=3, ly=5 of chunk (0,0)):
    ///   z=0  (band 0, lz 0) → Wood  (type 7)   — tests z_min boundary
    ///   z=17 (band 1, lz 1) → Stone (type 2) + paint byte 5
    ///   z=48 (band 3, lz 0) → Dirt  (type 3)   — tests z_max boundary
    ///
    /// Bystander block (different column, must survive delete):
    ///   lx=7, ly=2, z=32 (band 2, lz 0) → Grass (type 8)
    fn make_test_world() -> Vec<u8> {
        const HEADER: usize = 4096;
        const CHUNK:  usize = 32768;
        const ENTRY:  usize = 16;

        let chunk_off:   u32 = HEADER as u32;
        let ptr_off:     u32 = (HEADER + CHUNK) as u32;
        let total:       usize = HEADER + CHUNK + ENTRY;

        let mut b = vec![0u8; total];

        // Header: pointer-table offset at bytes 32–35 (little-endian u32)
        b[32..36].copy_from_slice(&ptr_off.to_le_bytes());
        // World name at 40–48
        b[40..49].copy_from_slice(b"TestWorld");

        // Helper: absolute byte index of block at (lx, ly, z) inside the chunk
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz   = (z % 16) as usize;
            HEADER + band * 8192 + lx * 256 + ly * 16 + lz
        };
        let paint = |lx: usize, ly: usize, z: i32| block(lx, ly, z) + 4096;

        // Column under test: lx=3, ly=5
        b[block(3, 5,  0)] = 7; // Wood  — z_min boundary
        b[block(3, 5, 17)] = 2; // Stone
        b[paint(3, 5, 17)] = 5; // paint
        b[block(3, 5, 48)] = 3; // Dirt  — z_max boundary

        // Bystander: lx=7, ly=2, z=32
        b[block(7, 2, 32)] = 8; // Grass — must not be touched by delete

        // Pointer-table entry: (cx=0, cy=0) → chunk_off
        let pe = (HEADER + CHUNK) as usize;
        b[pe..pe+2].copy_from_slice(&0i16.to_le_bytes());   // cx
        b[pe+4..pe+6].copy_from_slice(&0i16.to_le_bytes()); // cy
        b[pe+8..pe+12].copy_from_slice(&chunk_off.to_le_bytes()); // file offset

        b
    }

    // Byte index of block/paint for lx=3,ly=5 relative to file start (chunk at 4096)
    const HEADER: usize = 4096;
    fn blk(lx: usize, ly: usize, z: i32) -> usize {
        let band = (z / 16) as usize;
        let lz   = (z % 16) as usize;
        HEADER + band * 8192 + lx * 256 + ly * 16 + lz
    }
    fn pnt(lx: usize, ly: usize, z: i32) -> usize { blk(lx, ly, z) + 4096 }

    /// Round-trip: parse → delete column (3,5) z 0–63 → save to new path →
    /// reload → verify air + byte-identical header and pointer table.
    #[test]
    fn test_save_round_trip() {
        let original = make_test_world();

        // ── parse ──────────────────────────────────────────────────────────
        let mut world = parse_world_inner(mmap_from_bytes(original.clone())).expect("parse failed");
        assert_eq!(world.w_chunks, 1);
        assert_eq!(world.h_chunks, 1);

        // Pre-conditions: test blocks are present
        assert_eq!(world.bytes[blk(3, 5,  0)], 7, "Wood pre-delete");
        assert_eq!(world.bytes[blk(3, 5, 17)], 2, "Stone pre-delete");
        assert_eq!(world.bytes[pnt(3, 5, 17)], 5, "paint pre-delete");
        assert_eq!(world.bytes[blk(3, 5, 48)], 3, "Dirt pre-delete");
        assert_eq!(world.bytes[blk(7, 2, 32)], 8, "bystander pre-delete");

        // ── delete column (px=3, py=5), full z range ───────────────────────
        delete_blocks_inner(&mut world, 3, 5, 3, 5, 0, 63);

        assert_eq!(world.bytes[blk(3, 5,  0)], 0, "Wood post-delete");
        assert_eq!(world.bytes[blk(3, 5, 17)], 0, "Stone post-delete");
        assert_eq!(world.bytes[pnt(3, 5, 17)], 0, "paint post-delete");
        assert_eq!(world.bytes[blk(3, 5, 48)], 0, "Dirt post-delete");
        assert_eq!(world.bytes[blk(7, 2, 32)], 8, "bystander unchanged after delete");

        // ── save to a temp path (no pre-existing file → no .bak created) ──
        let tmp = std::env::temp_dir().join("eden_test_round_trip.eden");
        let tmp_str = tmp.to_str().unwrap();
        let _ = fs::remove_file(&tmp);
        save_world_inner(&world, tmp_str).expect("save failed");
        assert!(!std::path::Path::new(&format!("{tmp_str}.bak")).exists(),
            ".bak should not be created when destination didn't exist");

        // ── reload saved file ───────────────────────────────────────────────
        let saved_bytes = fs::read(&tmp).expect("read back failed");
        let world2 = parse_world_inner(mmap_from_bytes(saved_bytes.clone())).expect("re-parse failed");

        // Deleted column reads as air
        assert_eq!(world2.bytes[blk(3, 5,  0)], 0, "Wood air after reload");
        assert_eq!(world2.bytes[blk(3, 5, 17)], 0, "Stone air after reload");
        assert_eq!(world2.bytes[pnt(3, 5, 17)], 0, "paint air after reload");
        assert_eq!(world2.bytes[blk(3, 5, 48)], 0, "Dirt air after reload");

        // Bystander survives
        assert_eq!(world2.bytes[blk(7, 2, 32)], 8, "bystander survived save/reload");

        // Header bytes (0 .. HEADER) are byte-identical to original
        assert_eq!(&original[..HEADER], &saved_bytes[..HEADER],
            "header section must be byte-identical to original");

        // Pointer-table bytes are byte-identical to original
        let ptr_off = u32::from_le_bytes(original[32..36].try_into().unwrap()) as usize;
        assert_eq!(&original[ptr_off..], &saved_bytes[ptr_off..],
            "pointer table must be byte-identical to original");

        // Sanity: total file size unchanged
        assert_eq!(original.len(), saved_bytes.len(), "file size must not change");

        let _ = fs::remove_file(&tmp);
    }

    /// Backup semantics: first save to an existing path creates path.bak;
    /// second save does NOT overwrite an already-present .bak.
    #[test]
    fn test_backup_semantics() {
        let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");

        let tmp     = std::env::temp_dir().join("eden_test_backup.eden");
        let tmp_bak = std::env::temp_dir().join("eden_test_backup.eden.bak");
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(&tmp_bak);

        // Write an "existing" file to simulate overwriting a previous save
        let sentinel = b"original content before first save";
        fs::write(&tmp, sentinel).unwrap();

        // First save → .bak should capture the pre-save content
        save_world_inner(&world, tmp.to_str().unwrap()).expect("first save failed");
        assert!(tmp_bak.exists(), ".bak must be created on first save over existing file");
        assert_eq!(fs::read(&tmp_bak).unwrap(), sentinel,
            ".bak must contain the pre-save file content");

        // Write something else to the main file to simulate a subsequent edit
        fs::write(&tmp, b"intermediate content").unwrap();

        // Second save → .bak already exists, must NOT be overwritten
        save_world_inner(&world, tmp.to_str().unwrap()).expect("second save failed");
        assert_eq!(fs::read(&tmp_bak).unwrap(), sentinel,
            ".bak must not be overwritten on subsequent saves");

        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(&tmp_bak);
    }
}
