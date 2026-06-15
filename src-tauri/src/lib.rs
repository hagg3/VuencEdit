use base64::{engine::general_purpose::STANDARD, Engine as _};
use memmap2::{MmapMut, MmapOptions};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::sync::Mutex;
use std::time::Instant;

fn serialize_bytes_b64<S: serde::Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&STANDARD.encode(bytes))
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

struct WorldState {
    world: Option<LoadedWorld>,
    clipboard: Option<Clipboard>,
    undo_stack: VecDeque<UndoEntry>,
    redo_stack: VecDeque<UndoEntry>,
}

impl WorldState {
    fn new() -> Self {
        WorldState { world: None, clipboard: None, undo_stack: VecDeque::new(), redo_stack: VecDeque::new() }
    }
}

pub(crate) type AppState = Mutex<WorldState>;

// ── Color tables (ported from MapColors.cs) ──────────────────────────────────

const PAINTED: [[u8; 3]; 54] = [
    [255, 170, 170], [255, 234, 170], [251, 255, 170], [170, 255, 191],
    [170, 255, 255], [170, 191, 255], [212, 170, 255], [255, 170, 234],
    [255, 255, 255],

    [255,  85,  85], [255, 212,  85], [246, 255,  85], [ 85, 255, 128],
    [ 85, 255, 255], [ 85, 128, 255], [170,  85, 255], [255,  85, 212],
    [204, 204, 204],

    [255,   0,   0], [255, 191,   0], [242, 255,   0], [  0, 255,  64],
    [  0, 255, 255], [  0,  64, 255], [128,   0, 255], [255,   0, 191],
    [153, 153, 153],

    [191,   0,   0], [191, 143,   0], [182, 191,   0], [  0, 191,  48],
    [  0, 191, 191], [  0,  48, 191], [ 96,   0, 191], [191,   0, 143],
    [102, 102, 102],

    [128,   0,   0], [128,  96,   0], [121, 128,   0], [  0, 128,  32],
    [  0, 128, 128], [  0,  32, 128], [ 64,   0, 128], [128,   0,  96],
    [ 51,  51,  51],

    [ 64,   0,   0], [ 64,  48,   0], [ 61,  64,   0], [  0,  64,  16],
    [  0,  64,  64], [  0,  16,  64], [ 32,   0,  64], [ 64,   0,  48],
    [  3,   3,   3],
];

// Table is indexed as (block_type - 1), matching the reference (Mapping.cs: pen = blockByte - 1).
// Index 0 → block type 1 (Bedrock), index 1 → block type 2 (Stone), etc.
const UNPAINTED: [[u8; 3]; 110] = [
    [  3,   3,   3], // idx 0  → type 1  Bedrock
    [162, 162, 162], // idx 1  → type 2  Stone
    [162,  82,  45], // idx 2  → type 3  Dirt   (Sienna)
    [242, 220, 140], // idx 3  → type 4  Sand
    [ 10,  63,  13], // idx 4  → type 5  Leaves
    [125,  91,  22], // idx 5  → type 6  Trunk
    [186, 164,  88], // idx 6  → type 7  Wood
    [ 82, 148,  53], // idx 7  → type 8  Grass  (overridden by grass_color())
    [255,   0,   0], // idx 8  → type 9  TNT
    [ 59,  59,  59], // idx 9  → type 10 DarkStone
    [ 82, 148,  53], // idx 10 → type 11 Weeds
    [ 82, 148,  53], // idx 11 → type 12 Flowers
    [204,  48,  41], // idx 12 → type 13 Brick
    [ 86,  92,  95], // idx 13 → type 14 Slate
    [134, 164, 186], // idx 14 → type 15 Ice
    [255, 255, 255], // idx 15 → type 16 Wallpaper
    [ 50,  50,  50], // idx 16 → type 17 Bouncy
    [210, 180, 140], // idx 17 → type 18 Ladder (Tan)
    [255, 255, 255], // idx 18 → type 19 Cloud
    [  0,   0, 255], // idx 19 → type 20 Water
    [210, 180, 140], // idx 20 → type 21 Fence (Tan)
    [  0, 128,   0], // idx 21 → type 22 Ivy (Green)
    [255,  69,   0], // idx 22 → type 23 Lava (OrangeRed)

    [162, 162, 162], // idx 23 → type 24 RockRampSouth
    [162, 162, 162], // idx 24 → type 25 RockRampWest
    [162, 162, 162], // idx 25 → type 26 RockRampNorth
    [162, 162, 162], // idx 26 → type 27 RockRampEast
    [186, 164,  88], // idx 27 → type 28 WoodRampSouth
    [186, 164,  88], // idx 28 → type 29 WoodRampWest
    [186, 164,  88], // idx 29 → type 30 WoodRampNorth
    [186, 164,  88], // idx 30 → type 31 WoodRampEast
    [105, 105, 105], // idx 31 → type 32 ShinglesRampSouth (DimGray)
    [105, 105, 105], // idx 32 → type 33
    [105, 105, 105], // idx 33 → type 34
    [105, 105, 105], // idx 34 → type 35
    [134, 164, 186], // idx 35 → type 36 IceRampSouth
    [134, 164, 186], // idx 36 → type 37
    [134, 164, 186], // idx 37 → type 38
    [134, 164, 186], // idx 38 → type 39

    [162, 162, 162], // idx 39 → type 40 RockWedge_SE
    [162, 162, 162], // idx 40 → type 41
    [162, 162, 162], // idx 41 → type 42
    [162, 162, 162], // idx 42 → type 43
    [186, 164,  88], // idx 43 → type 44 WoodWedge_SE
    [186, 164,  88], // idx 44 → type 45
    [186, 164,  88], // idx 45 → type 46
    [186, 164,  88], // idx 46 → type 47
    [105, 105, 105], // idx 47 → type 48 ShinglesWedge_SE
    [105, 105, 105], // idx 48 → type 49
    [105, 105, 105], // idx 49 → type 50
    [105, 105, 105], // idx 50 → type 51
    [134, 164, 186], // idx 51 → type 52 IceWedge_SE
    [134, 164, 186], // idx 52 → type 53
    [134, 164, 186], // idx 53 → type 54
    [134, 164, 186], // idx 54 → type 55

    [105, 105, 105], // idx 55 → type 56 Shingles
    [255, 255, 255], // idx 56 → type 57 NeonSquare
    [211, 211, 211], // idx 57 → type 58 Glass (LightGray)
    [  0,   0, 255], // idx 58 → type 59 Water3_4
    [  0,   0, 255], // idx 59 → type 60 Water2_4
    [  0,   0, 255], // idx 60 → type 61 Water1_4
    [255,  69,   0], // idx 61 → type 62 Lava3_4
    [255,  69,   0], // idx 62 → type 63 Lava2_4
    [255,  69,   0], // idx 63 → type 64 Lava1_4

    [255,   0,   0], // idx 64 → type 65 Fireworks
    [210, 180, 140], // idx 65 → type 66 DoorSouth
    [210, 180, 140], // idx 66 → type 67 DoorWest
    [210, 180, 140], // idx 67 → type 68 DoorNorth
    [210, 180, 140], // idx 68 → type 69 DoorEast
    [218, 165,  32], // idx 69 → type 70 DoorTop (Gold)
    [255, 250, 205], // idx 70 → type 71 Treasure (LemonChiffon)
    [  0,   0, 255], // idx 71 → type 72 Light
    [105, 105, 105], // idx 72 → type 73 FlowerNew (DarkGray)
    [211, 211, 211], // idx 73 → type 74 Steel (LightGray)
    [211, 211, 211], // idx 74 → type 75 PortalSouth
    [211, 211, 211], // idx 75 → type 76 PortalWest
    [211, 211, 211], // idx 76 → type 77 PortalNorth
    [211, 211, 211], // idx 77 → type 78 PortalEast
    [255, 255, 255], // idx 78 → type 79 PortalTop
    [255, 255, 255], // idx 79 → type 80 (unused)
    [139,  69,  19], // idx 80 → type 81 (unused) SaddleBrown
    [  0, 128,   0], // idx 81 → type 82 ExpansionGrass (overridden by grass_color())
    [105, 105, 105], // idx 82 → type 83 ExpansionDarkStone
    [162, 162, 162], // idx 83 → type 84 ExpansionStone
    [242, 220, 140], // idx 84 → type 85 ExpansionDirt
    [ 10,  63,  13], // idx 85 → type 86 ExpansionSand
    [178,  34,  34], // 87 ExpansionTnt (Firebrick)
    [128, 128, 128], // 88 ExpansionWood (Gray)
    [  0, 128,   0], // 89 ExpansionShingle
    [210, 180, 140], // 90 ExpansionGlass (Tan)
    [  0, 191, 255], // 91 ExpansionNeonSquare (DeepSkyBlue)
    [255, 255, 255], // 92 ExpansionTrunk
    [ 50,  50,  50], // 93 ExpansionLeaves
    [255, 255, 255], // 94 ExpansionBrick
    [169, 169, 169], // 95 ExpansionSlate (DarkGray)
    [210, 180, 140], // 96 ExpansionVines (Tan)
    [  0, 191, 255], // 97 ExpansionLadder (DeepSkyBlue)
    [105, 105, 105], // 98 ExpansionIce (DimGray)
    [210, 180, 140], // 99 ExpansionWallpaper (Tan)
    [  0,   0, 255], // 100 ExpansionTrampoline
    [255,  69,   0], // 101 ExpansionCloud
    [255,   0,   0], // 102 ExpansionStoneSlide
    [255, 250, 205], // 103 ExpansionWoodSlide (LemonChiffon)
    [169, 169, 169], // 104 ExpansionIceSlide
    [105, 105, 105], // 105 ExpansionShingleSlide
    [  0,   0, 255], // 106 ExpansionFence
    [255,  69,   0], // 107 ExpansionWater
    [255,   0,   0], // 108 ExpansionLava
    [255, 250, 205], // 109 ExpansionFirework
    [169, 169, 169], // 110 ExpansionLight
];

// ── Color helpers ─────────────────────────────────────────────────────────────

fn grass_color(sky: u8) -> [u8; 3] {
    match sky {
        11 => [242, 220, 140], // desert
        13 => [255, 255, 255], // snow
        _  => [ 82, 148,  53], // default green
    }
}

fn block_color(block_type: u8, paint: u8, sky: u8) -> [u8; 3] {
    if paint != 0 {
        let idx = (paint as usize).saturating_sub(1);
        if idx < PAINTED.len() {
            return PAINTED[idx];
        }
    }
    if block_type == 8 || block_type == 82 {
        return grass_color(sky);
    }
    // The reference (Mapping.cs) indexes Unpainted as (block_type - 1), so the table
    // is offset by one: index 0 maps to block type 1 (Bedrock), index 1 to Stone, etc.
    let idx = (block_type as usize).saturating_sub(1);
    if idx < UNPAINTED.len() { UNPAINTED[idx] } else { [128, 128, 128] }
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
            'outer: for band in (0..world.num_bands).rev() {
                for z in (0..16usize).rev() {
                    let bi = addr + band * 8192 + lx * 256 + ly * 16 + z;
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
                    break 'outer;
                }
            }
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
    let _old_world = {
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
        drop(ws);
        eprintln!("[LOCK] released  cmd=load_world/step1  held={}µs  t=+{}µs", t_held.elapsed().as_micros(), us());
        taken
    };
    // _old_world (Option<LoadedWorld>) drops here, ~2 GB freed outside the mutex

    // Step 2: File I/O + parse + render_pixels — no lock held.
    // Open read-only: map_copy (MAP_PRIVATE | PROT_WRITE) never writes back to the file,
    // so read-only file access is sufficient. Pages are file-backed and OS-evictable until
    // written; writes COW only the affected 4 KB page into process-private RAM.
    let file = fs::File::open(&path).map_err(|e| format!("Failed to open file: {e}"))?;
    // SAFETY: The file is opened read-only and we never truncate or replace it while mapped.
    // map_copy creates a private mapping; external file changes after this point do not
    // affect the mapping and our writes never reach disk until explicit save.
    let mmap = unsafe { MmapOptions::new().map_copy(&file) }
        .map_err(|e| format!("Failed to map file: {e}"))?;
    eprintln!("[LOAD] file_mmap  bytes={}B  t=+{}µs", mmap.len(), us());

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
    };

    // Step 3: Install new world.
    eprintln!("[LOCK] acquire_start  cmd=load_world/step3  t=+{}µs", us());
    let t_s3 = Instant::now();
    {
        let mut ws = state.lock().unwrap();
        eprintln!("[LOCK] acquired  cmd=load_world/step3  wait={}µs", t_s3.elapsed().as_micros());
        let t_held = Instant::now();
        ws.world = Some(loaded);
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
    if new_paint as usize > PAINTED.len() {
        return Err(format!("Invalid paint byte {new_paint}: must be 0–{}", PAINTED.len()));
    }
    if let Some(fp) = filter_paint {
        if fp as usize > PAINTED.len() {
            return Err(format!("Invalid filter paint {fp}: must be 0–{}", PAINTED.len()));
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

#[tauri::command]
fn save_world(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    save_world_inner(world, &path)
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

/// Rotate a ramp block ID 90° clockwise.
/// Ramp families occupy consecutive 4-ID bands: [base+0=S, base+1=W, base+2=N, base+3=E].
/// Under 90° CW in XY screen space: S→E, E→N, N→W, W→S → offset shifts by +3 mod 4.
/// Ramp ID ranges: Rock 24–27, Wood 28–31, Shingles 32–35, Ice 36–39.
/// All other block types are returned unchanged.
#[inline]
fn rotate_ramp_id_cw(bt: u8) -> u8 {
    if (24..=39).contains(&bt) {
        let base = bt & !3; // round down to multiple of 4
        let off  = bt &  3;
        base | ((off + 3) & 3)
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

/// Rotate clipboard 90° clockwise in the XY plane.
/// Transform: (dx, dy, dz) → (new_dx=dy, new_dy=old_width-1-dx, dz).
/// New dimensions: new_width=old_height, new_height=old_width. Z range unchanged.
/// Ramp block IDs (24–39) are remapped to match the new physical facing direction.
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

// ── App entry point ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
            save_world,
            undo_edit,
            redo_edit,
            copy_selection,
            rotate_clipboard,
            paste_at,
            paste_terrain,
            render_zslice_patch,
            render_selection_view,
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
