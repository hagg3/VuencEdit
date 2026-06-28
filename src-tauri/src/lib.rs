mod texturepack;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use memmap2::{Mmap, MmapMut, MmapOptions};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufWriter, Seek, SeekFrom, Write};
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
    /// Spawn position in editor (0-indexed) coordinates. None if header bytes are zero (unset).
    pub spawn_px: Option<f32>,
    pub spawn_py: Option<f32>,
    /// Centroid of populated chunks, in editor (local) block coordinates. Used to spawn the 3D
    /// fly-through camera over actual geometry on sparse worlds (where the bounding-box centre is
    /// frequently empty). None only if there are no chunks (cannot happen post-parse).
    pub center_px: Option<f32>,
    pub center_py: Option<f32>,
    /// Absolute chunk coordinates of the world's top-left corner (min_x, min_y).
    /// Used by the frontend to align template overlay coords. Eden.eden covers 4006..4185.
    pub abs_min_x: i32,
    pub abs_min_y: i32,
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

/// Read the respawn/home position from header `home` field (bytes 16–27: X f32, Y f32, Z f32 LE).
/// Returns (px, py) in editor 0-indexed coordinates, or None if the home bytes are zero (unset).
fn read_spawn(world: &LoadedWorld) -> Option<(f32, f32)> {
    let b = &world.bytes;
    if b.len() < 28 { return None; }
    let abs_x = f32::from_le_bytes([b[16], b[17], b[18], b[19]]);
    let abs_z = f32::from_le_bytes([b[24], b[25], b[26], b[27]]);
    if abs_x == 0.0 && abs_z == 0.0 { return None; }
    let px = abs_x - world.min_x as f32 * 16.0;
    let py = abs_z - world.min_y as f32 * 16.0;
    Some((px, py))
}

/// Write the respawn/home position to the `home` field (bytes 16–27). Height is set to
/// the eye/camera level above the surface at (px, py) — same convention as the game.
/// Does NOT touch `pos` (bytes 4–15), which is the game's last-walked position.
fn write_spawn(world: &mut LoadedWorld, px: f32, py: f32) {
    let abs_x = px + world.min_x as f32 * 16.0;
    let abs_z = py + world.min_y as f32 * 16.0;
    let height = surface_z(world, px as i32, py as i32)
        .map(|z| z as f32 + 2.0)
        .unwrap_or(34.0);
    if world.bytes.len() < 28 { return; }
    world.bytes[16..20].copy_from_slice(&abs_x.to_le_bytes());
    world.bytes[20..24].copy_from_slice(&height.to_le_bytes());
    world.bytes[24..28].copy_from_slice(&abs_z.to_le_bytes());
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
    /// Read-only mmap of Eden.eden template (loaded on demand via load_eden_template).
    template_bytes: Option<Mmap>,
    /// Absolute (tx, tz) chunk coords → byte offset into template_bytes.
    /// Eden.eden uses i32+i32+u64 directory, different from regular saves.
    template_dir: HashMap<(i32, i32), usize>,
    /// Per-chunk surface colors: [r,g,b,a] for each of the 256 (lx*16+ly) positions.
    /// a=255 = solid block; a=0 = air column. 1 KB/chunk vs 32 KB for full raw.
    template_surface_cache: HashMap<(i32, i32), Box<[[u8; 4]; 256]>>,
    /// Optional texture pack loaded by the user (world-independent).
    texture_pack: Option<texturepack::TexturePack>,
}

impl WorldState {
    fn new() -> Self {
        WorldState {
            world: None,
            clipboard: None,
            undo_stack: VecDeque::new(),
            redo_stack: VecDeque::new(),
            temp_path: None,
            template_bytes: None,
            template_dir: HashMap::new(),
            template_surface_cache: HashMap::new(),
            texture_pack: None,
        }
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

// ── Color system (tables ported from Globals.mm / Hud.mm game source) ─────────

// Unpainted block base colours — blockColor[NUM_BLOCKS+1][3] from Globals.mm.
// Index = block type ID (0–111). Zero entries are unused/unset in the game.
const BLOCK_RGB: [[u8; 3]; 112] = [
    [  0,   0,   0], //   0 air (handled before table lookup)
    [ 90,  90,  90], //   1 bedrock
    [158, 156, 158], //   2 stone        #9e9c9e
    [ 91,  61,   2], //   3 dirt         #5b3d02
    [245, 221, 141], //   4 sand         #f5dd8d
    [ 20, 129,  28], //   5 leaves       #14811c
    [112,  81,  19], //   6 trunk        #705113
    [167, 146,  79], //   7 wood         #a7924f
    [ 82, 148,  53], //   8 grass        #529435 (overridden by grass_color when unpainted)
    [148,  15,   2], //   9 tnt          #940f02
    [ 67,  66,  66], //  10 dark stone   #434242
    [ 71, 128,  46], //  11 grass2 / weed  #47802e (darker grass)
    [115, 206,  74], //  12 grass3 / old flower
    [195,  98,  94], //  13 brick        #c3625e
    [ 49,  52,  54], //  14 cobblestone / slate  #313436
    [120, 145, 167], //  15 ice          #7891a7
    [158, 159, 158], //  16 crystal / wallpaper  #9e9f9e
    [ 52,  51,  52], //  17 trampoline   #343334
    [103,  89,  48], //  18 ladder       #675930
    [255, 255, 255], //  19 cloud        #ffffff
    [ 22,  31, 184], //  20 water        #161fb8
    [216, 180, 101], //  21 weave / fence  #d8b465
    [ 52, 205, 109], //  22 vine         #34cd6d
    [244,  68,   0], //  23 lava         #f44400
    [158, 156, 158], //  24 stone ramp S
    [158, 156, 158], //  25 stone ramp W
    [158, 156, 158], //  26 stone ramp N
    [158, 156, 158], //  27 stone ramp E
    [167, 146,  79], //  28 wood ramp S
    [167, 146,  79], //  29 wood ramp W
    [167, 146,  79], //  30 wood ramp N
    [167, 146,  79], //  31 wood ramp E
    [ 95,  94,  95], //  32 shingle ramp S  #5f5e5f
    [ 95,  94,  95], //  33 shingle ramp W
    [ 95,  94,  95], //  34 shingle ramp N
    [ 95,  94,  95], //  35 shingle ramp E
    [120, 145, 167], //  36 ice ramp S
    [120, 145, 167], //  37 ice ramp W
    [120, 145, 167], //  38 ice ramp N
    [120, 145, 167], //  39 ice ramp E
    [158, 156, 158], //  40 stone wedge SE
    [158, 156, 158], //  41 stone wedge SW
    [158, 156, 158], //  42 stone wedge NW
    [158, 156, 158], //  43 stone wedge NE
    [167, 146,  79], //  44 wood wedge SE
    [167, 146,  79], //  45 wood wedge SW
    [167, 146,  79], //  46 wood wedge NW
    [167, 146,  79], //  47 wood wedge NE
    [ 95,  94,  95], //  48 shingle wedge SE
    [ 95,  94,  95], //  49 shingle wedge SW
    [ 95,  94,  95], //  50 shingle wedge NW
    [ 95,  94,  95], //  51 shingle wedge NE
    [120, 145, 167], //  52 ice wedge SE
    [120, 145, 167], //  53 ice wedge SW
    [120, 145, 167], //  54 ice wedge NW
    [120, 145, 167], //  55 ice wedge NE
    [ 95,  94,  95], //  56 shingles     #5f5e5f
    [228, 225, 228], //  57 gradient / neon square  #e4e1e4
    [182, 183, 185], //  58 glass        #b6b7b9
    [ 22,  31, 184], //  59 water ¾
    [ 22,  31, 184], //  60 water ½
    [ 22,  31, 184], //  61 water ¼
    [244,  68,   0], //  62 lava ¾
    [244,  68,   0], //  63 lava ½
    [244,  68,   0], //  64 lava ¼
    [148,  15,   2], //  65 firework     #940f02
    [102,  64,  18], //  66 door 1       #664012
    [102,  64,  18], //  67 door 2
    [102,  64,  18], //  68 door 3
    [102,  64,  18], //  69 door 4
    [102,  64,  18], //  70 door top
    [235, 201,  52], //  71 golden cube  #ebc934
    [254, 251, 149], //  72 lightbox     #fefb95
    [ 28, 157, 193], //  73 new flower   #1c9dc1
    [129, 128, 128], //  74 steel        #818080
    [ 39,  39,  39], //  75 portal 1     #272727
    [ 39,  39,  39], //  76 portal 2
    [ 39,  39,  39], //  77 portal 3
    [ 39,  39,  39], //  78 portal 4
    [ 39,  39,  39], //  79 portal top
    [  0,   0,   0], //  80 custom (unset in game)
    [  0,   0,   0], //  81 block tnt (unset in game)
    [148,  15,   2], //  82 bt-grass (expansion)  #940f02
    [148,  15,   2], //  83 bt-dark-stone
    [148,  15,   2], //  84 bt-stone
    [148,  15,   2], //  85 bt-dirt
    [148,  15,   2], //  86 bt-sand
    [148,  15,   2], //  87 bt-tnt
    [148,  15,   2], //  88 bt-wood
    [148,  15,   2], //  89 bt-shingle
    [148,  15,   2], //  90 bt-glass
    [148,  15,   2], //  91 bt-gradient
    [148,  15,   2], //  92 bt-tree
    [148,  15,   2], //  93 bt-leaves
    [148,  15,   2], //  94 bt-brick
    [148,  15,   2], //  95 bt-cobblestone
    [148,  15,   2], //  96 bt-vines
    [148,  15,   2], //  97 bt-ladder
    [148,  15,   2], //  98 bt-ice
    [148,  15,   2], //  99 bt-crystal
    [148,  15,   2], // 100 bt-trampoline
    [148,  15,   2], // 101 bt-cloud
    [148,  15,   2], // 102 bt-stone-side
    [148,  15,   2], // 103 bt-wood-side
    [148,  15,   2], // 104 bt-ice-side
    [148,  15,   2], // 105 bt-shingle-side
    [148,  15,   2], // 106 bt-fence
    [148,  15,   2], // 107 bt-water
    [148,  15,   2], // 108 bt-lava
    [148,  15,   2], // 109 bt-firework
    [148,  15,   2], // 110 bt-lightbox
    [148,  15,   2], // 111 bt-steel
];

// Paint colour table — colorTable[54] from Hud::genColorTable() (Hud.mm:150-196).
// Index 0 is the "no-paint" white sentinel; indices 1–54 are the game's paint palette.
const PAINT_RGB: [[u8; 3]; 55] = [
    [255, 255, 255], //  0 unused (paint 0 = no paint; handled before lookup)
    [255, 170, 170], //  1
    [255, 233, 170], //  2
    [250, 255, 170], //  3
    [170, 255, 191], //  4
    [170, 255, 255], //  5
    [170, 191, 255], //  6
    [212, 170, 255], //  7
    [255, 170, 233], //  8
    [255, 255, 255], //  9 white
    [255,  85,  85], // 10
    [255, 212,  85], // 11
    [246, 255,  85], // 12
    [ 85, 255, 127], // 13
    [ 85, 255, 255], // 14
    [ 85, 127, 255], // 15
    [170,  85, 255], // 16
    [255,  85, 212], // 17
    [204, 204, 204], // 18 80 % gray
    [255,   0,   0], // 19
    [255, 191,   0], // 20
    [242, 255,   0], // 21
    [  0, 255,  63], // 22
    [  0, 255, 255], // 23
    [  0,  63, 255], // 24
    [127,   0, 255], // 25
    [255,   0, 191], // 26
    [153, 153, 153], // 27 60 % gray
    [191,   0,   0], // 28
    [191, 143,   0], // 29
    [181, 191,   0], // 30
    [  0, 191,  47], // 31
    [  0, 191, 191], // 32
    [  0,  47, 191], // 33
    [ 95,   0, 191], // 34
    [191,   0, 143], // 35
    [102, 102, 102], // 36 40 % gray
    [127,   0,   0], // 37
    [127,  95,   0], // 38
    [121, 127,   0], // 39
    [  0, 127,  31], // 40
    [  0, 127, 127], // 41
    [  0,  31, 127], // 42
    [ 63,   0, 127], // 43
    [127,   0,  95], // 44
    [ 50,  50,  50], // 45 20 % gray
    [ 63,   0,   0], // 46
    [ 63,  47,   0], // 47
    [ 60,  63,   0], // 48
    [  0,  63,  15], // 49
    [  0,  63,  63], // 50
    [  0,  15,  63], // 51
    [ 31,   0,  63], // 52
    [ 63,   0,  47], // 53
    [  2,   2,   2], // 54 near-black
];

// ── blockinfo[] flags (Constants.h:175-191, Globals.mm:38-167) ────────────────

const BI_NOTSOLID:   u32 = 0b0000_0000_0000_0010;
const BI_RAMPORSIDE: u32 = 0b0000_0000_0001_0000;

// blockinfo[NUM_BLOCKS+1] — one entry per block type (0–111).
// Only the flags relevant to the editor are preserved verbatim; the rest stay zero.
const BLOCK_INFO: [u32; 112] = [
    BI_NOTSOLID,                 //   0 air
    0,                           //   1 bedrock      IS_HARD
    0,                           //   2 stone         IS_HARD
    0,                           //   3 dirt
    0,                           //   4 sand
    0,                           //   5 leaves        IS_FLAMMABLE
    0,                           //   6 trunk         IS_FLAMMABLE
    0,                           //   7 wood          IS_FLAMMABLE|IS_HARD
    0,                           //   8 grass         IS_GRASS|IS_COLOREDSPECIAL
    0,                           //   9 tnt           IS_FLAMMABLE|IS_COLOREDSPECIAL|IS_HARD
    0,                           //  10 dark stone    IS_HARD
    0,                           //  11 weed          IS_GRASS|IS_COLOREDSPECIAL
    0,                           //  12 old flower    IS_GRASS|IS_COLOREDSPECIAL
    0,                           //  13 brick         IS_COLOREDSPECIAL|IS_HARD
    0,                           //  14 cobblestone   IS_HARD
    0,                           //  15 ice           IS_ICE
    0,                           //  16 crystal       IS_HARD
    0,                           //  17 trampoline
    0,                           //  18 ladder        IS_FLAMMABLE|IS_HARD
    0,                           //  19 cloud
    BI_NOTSOLID,                 //  20 water         IS_NOTSOLID|IS_ATLAS2|IS_WATER|IS_LIQUID
    BI_NOTSOLID,                 //  21 weave/fence   IS_FLAMMABLE|IS_NOTSOLID|IS_ATLAS2|IS_HARD
    0,                           //  22 vine
    BI_NOTSOLID,                 //  23 lava          IS_NOTSOLID|IS_ATLAS2|IS_LAVA|IS_LIQUID
    BI_NOTSOLID | BI_RAMPORSIDE, //  24 stone ramp S  IS_NOTSOLID|IS_RAMP|IS_RAMPORSIDE|IS_HARD
    BI_NOTSOLID | BI_RAMPORSIDE, //  25 stone ramp W
    BI_NOTSOLID | BI_RAMPORSIDE, //  26 stone ramp N
    BI_NOTSOLID | BI_RAMPORSIDE, //  27 stone ramp E
    BI_NOTSOLID | BI_RAMPORSIDE, //  28 wood ramp S   IS_FLAMMABLE|IS_NOTSOLID|IS_RAMP|IS_RAMPORSIDE
    BI_NOTSOLID | BI_RAMPORSIDE, //  29 wood ramp W
    BI_NOTSOLID | BI_RAMPORSIDE, //  30 wood ramp N
    BI_NOTSOLID | BI_RAMPORSIDE, //  31 wood ramp E
    BI_NOTSOLID | BI_RAMPORSIDE, //  32 shingle ramp S IS_NOTSOLID|IS_RAMP|IS_RAMPORSIDE
    BI_NOTSOLID | BI_RAMPORSIDE, //  33 shingle ramp W
    BI_NOTSOLID | BI_RAMPORSIDE, //  34 shingle ramp N
    BI_NOTSOLID | BI_RAMPORSIDE, //  35 shingle ramp E
    BI_NOTSOLID | BI_RAMPORSIDE, //  36 ice ramp S    IS_NOTSOLID|IS_RAMP|IS_RAMPORSIDE|IS_ICE
    BI_NOTSOLID | BI_RAMPORSIDE, //  37 ice ramp W
    BI_NOTSOLID | BI_RAMPORSIDE, //  38 ice ramp N
    BI_NOTSOLID | BI_RAMPORSIDE, //  39 ice ramp E
    BI_NOTSOLID | BI_RAMPORSIDE, //  40 stone wedge SE IS_NOTSOLID|IS_SIDE|IS_RAMPORSIDE|IS_HARD
    BI_NOTSOLID | BI_RAMPORSIDE, //  41 stone wedge SW
    BI_NOTSOLID | BI_RAMPORSIDE, //  42 stone wedge NW
    BI_NOTSOLID | BI_RAMPORSIDE, //  43 stone wedge NE
    BI_NOTSOLID | BI_RAMPORSIDE, //  44 wood wedge SE  IS_FLAMMABLE|IS_NOTSOLID|IS_SIDE|IS_RAMPORSIDE|IS_HARD
    BI_NOTSOLID | BI_RAMPORSIDE, //  45 wood wedge SW
    BI_NOTSOLID | BI_RAMPORSIDE, //  46 wood wedge NW
    BI_NOTSOLID | BI_RAMPORSIDE, //  47 wood wedge NE
    BI_NOTSOLID | BI_RAMPORSIDE, //  48 shingle wedge SE IS_NOTSOLID|IS_SIDE|IS_RAMPORSIDE|IS_HARD
    BI_NOTSOLID | BI_RAMPORSIDE, //  49 shingle wedge SW
    BI_NOTSOLID | BI_RAMPORSIDE, //  50 shingle wedge NW
    BI_NOTSOLID | BI_RAMPORSIDE, //  51 shingle wedge NE
    BI_NOTSOLID | BI_RAMPORSIDE, //  52 ice wedge SE   IS_NOTSOLID|IS_SIDE|IS_RAMPORSIDE|IS_ICE
    BI_NOTSOLID | BI_RAMPORSIDE, //  53 ice wedge SW
    BI_NOTSOLID | BI_RAMPORSIDE, //  54 ice wedge NW
    BI_NOTSOLID | BI_RAMPORSIDE, //  55 ice wedge NE
    0,                           //  56 shingles      IS_HARD
    0,                           //  57 gradient
    BI_NOTSOLID,                 //  58 glass         IS_NOTSOLID|IS_ATLAS2|IS_HARD
    BI_NOTSOLID,                 //  59 water ¾       IS_NOTSOLID|IS_ATLAS2|IS_WATER|IS_LIQUID
    BI_NOTSOLID,                 //  60 water ½
    BI_NOTSOLID,                 //  61 water ¼
    BI_NOTSOLID,                 //  62 lava ¾        IS_NOTSOLID|IS_ATLAS2|IS_LAVA|IS_LIQUID
    BI_NOTSOLID,                 //  63 lava ½
    BI_NOTSOLID,                 //  64 lava ¼
    0,                           //  65 firework      IS_FLAMMABLE|IS_COLOREDSPECIAL|IS_HARD
    BI_NOTSOLID,                 //  66 door 1        IS_FLAMMABLE|IS_NOTSOLID|IS_OBJECT|IS_DOOR
    BI_NOTSOLID,                 //  67 door 2
    BI_NOTSOLID,                 //  68 door 3
    BI_NOTSOLID,                 //  69 door 4
    BI_NOTSOLID,                 //  70 door top
    BI_NOTSOLID,                 //  71 golden cube   IS_NOTSOLID|IS_OBJECT
    0,                           //  72 lightbox      IS_HARD
    BI_NOTSOLID,                 //  73 new flower    IS_NOTSOLID|IS_OBJECT|IS_FLAMMABLE
    0,                           //  74 steel         IS_HARD
    0,                           //  75 portal 1      IS_OBJECT|IS_PORTAL|IS_HARD (solid)
    0,                           //  76 portal 2
    0,                           //  77 portal 3
    0,                           //  78 portal 4
    0,                           //  79 portal top
    BI_NOTSOLID,                 //  80 custom        IS_NOTSOLID (commented out in game)
    0,                           //  81 block tnt     IS_FLAMMABLE|IS_COLOREDSPECIAL|IS_HARD|IS_BLOCKTNT
    0,                           //  82 bt-grass      IS_FLAMMABLE|IS_COLOREDSPECIAL|IS_HARD|IS_BLOCKTNT
    0,                           //  83 bt-dark-stone
    0,                           //  84 bt-stone
    0,                           //  85 bt-dirt
    0,                           //  86 bt-sand
    0,                           //  87 bt-tnt
    0,                           //  88 bt-wood
    0,                           //  89 bt-shingle
    0,                           //  90 bt-glass
    0,                           //  91 bt-gradient
    0,                           //  92 bt-tree
    0,                           //  93 bt-leaves
    0,                           //  94 bt-brick
    0,                           //  95 bt-cobblestone
    0,                           //  96 bt-vines
    0,                           //  97 bt-ladder
    0,                           //  98 bt-ice
    0,                           //  99 bt-crystal
    0,                           // 100 bt-trampoline
    0,                           // 101 bt-cloud
    0,                           // 102 bt-stone-side
    0,                           // 103 bt-wood-side
    0,                           // 104 bt-ice-side
    0,                           // 105 bt-shingle-side
    0,                           // 106 bt-fence
    0,                           // 107 bt-water
    0,                           // 108 bt-lava
    0,                           // 109 bt-firework
    0,                           // 110 bt-lightbox
    0,                           // 111 bt-steel
];

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

// Per-block paint brightness scale, ported from la-map.c `max_lt` values.
// Scales painted colours so the same paint reads differently on different
// materials (e.g. dark stone 0.50 vs ice 0.90), preserving visual distinction
// in the flat top-down renderer where no texture contributes that difference.
const BLOCK_PAINT_SCALE: [f32; 112] = [
    1.00, // 0  air
    0.60, // 1  bedrock
    0.80, // 2  stone
    0.60, // 3  dirt
    0.80, // 4  sand
    0.65, // 5  leaves
    0.70, // 6  trunk
    0.70, // 7  wood
    0.60, // 8  grass
    0.70, // 9  tnt
    0.50, // 10 dark stone
    0.60, // 11 weed
    0.60, // 12 old flower
    0.70, // 13 brick
    0.40, // 14 slate / cobblestone
    0.90, // 15 ice
    0.80, // 16 wallpaper / crystal
    0.40, // 17 trampoline
    0.70, // 18 ladder
    1.00, // 19 cloud
    0.90, // 20 water
    0.80, // 21 fence / weave
    0.60, // 22 vine
    0.60, // 23 lava
    0.80, // 24 stone ramp S
    0.80, // 25 stone ramp W
    0.80, // 26 stone ramp N
    0.80, // 27 stone ramp E
    0.70, // 28 wood ramp S
    0.70, // 29 wood ramp W
    0.70, // 30 wood ramp N
    0.70, // 31 wood ramp E
    0.45, // 32 shingle ramp S
    0.45, // 33 shingle ramp W
    0.45, // 34 shingle ramp N
    0.45, // 35 shingle ramp E
    0.90, // 36 ice ramp S
    0.90, // 37 ice ramp W
    0.90, // 38 ice ramp N
    0.90, // 39 ice ramp E
    0.80, // 40 stone wedge SE
    0.80, // 41 stone wedge SW
    0.80, // 42 stone wedge NW
    0.80, // 43 stone wedge NE
    0.70, // 44 wood wedge SE
    0.70, // 45 wood wedge SW
    0.70, // 46 wood wedge NW
    0.70, // 47 wood wedge NE
    0.45, // 48 shingle wedge SE
    0.45, // 49 shingle wedge SW
    0.45, // 50 shingle wedge NW
    0.45, // 51 shingle wedge NE
    0.90, // 52 ice wedge SE
    0.90, // 53 ice wedge SW
    0.90, // 54 ice wedge NW
    0.90, // 55 ice wedge NE
    0.45, // 56 shingles
    0.90, // 57 neon square / gradient
    0.60, // 58 glass
    0.80, // 59 water ¾
    0.85, // 60 water ½
    0.90, // 61 water ¼
    0.50, // 62 lava ¾
    0.55, // 63 lava ½
    0.60, // 64 lava ¼
    0.70, // 65 firework
    0.70, // 66 door 1
    0.70, // 67 door 2
    0.70, // 68 door 3
    0.70, // 69 door 4
    0.70, // 70 door top
    0.70, // 71 golden cube
    0.90, // 72 lightbox
    0.70, // 73 new flower
    0.70, // 74 steel
    0.60, // 75 portal 1
    0.60, // 76 portal 2
    0.60, // 77 portal 3
    0.60, // 78 portal 4
    0.60, // 79 portal top
    0.50, // 80 custom
    0.50, // 81 block tnt
    0.60, // 82 bt-grass
    0.50, // 83 bt-dark-stone
    0.80, // 84 bt-stone
    0.60, // 85 bt-dirt
    0.80, // 86 bt-sand
    0.70, // 87 bt-tnt
    0.70, // 88 bt-wood
    0.45, // 89 bt-shingle
    0.60, // 90 bt-glass
    0.90, // 91 bt-gradient
    0.70, // 92 bt-tree
    0.65, // 93 bt-leaves
    0.70, // 94 bt-brick
    0.40, // 95 bt-cobblestone
    0.60, // 96 bt-vines
    0.90, // 97 bt-ladder
    0.90, // 98 bt-ice
    0.80, // 99 bt-crystal
    0.40, // 100 bt-trampoline
    1.00, // 101 bt-cloud
    0.80, // 102 bt-stone-side
    0.70, // 103 bt-wood-side
    0.90, // 104 bt-ice-side
    0.45, // 105 bt-shingle-side
    0.80, // 106 bt-fence
    0.90, // 107 bt-water
    0.60, // 108 bt-lava
    0.70, // 109 bt-firework
    0.90, // 110 bt-lightbox
    0.70, // 111 bt-steel
];

fn grass_color(sky: u8) -> [u8; 3] {
    match sky {
        11 => [242, 220, 140], // desert sky
        13 => [255, 255, 255], // snow sky
        _  => [ 82, 148,  53], // #529435
    }
}

fn block_color(bt: u8, paint: u8, sky: u8) -> [u8; 3] {
    if bt == 0 { return [30, 30, 30]; }
    if (bt == 8 || bt == 82) && paint == 0 { return grass_color(sky); }
    if paint != 0 && (paint as usize) < PAINT_RGB.len() {
        let [r, g, b] = PAINT_RGB[paint as usize];
        let scale = if (bt as usize) < BLOCK_PAINT_SCALE.len() { BLOCK_PAINT_SCALE[bt as usize] } else { 0.70 };
        return [
            (r as f32 * scale).clamp(0.0, 255.0) as u8,
            (g as f32 * scale).clamp(0.0, 255.0) as u8,
            (b as f32 * scale).clamp(0.0, 255.0) as u8,
        ];
    }
    if (bt as usize) < BLOCK_RGB.len() { BLOCK_RGB[bt as usize] } else { [128, 128, 128] }
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

    // Chunk pointer table offset at bytes 32–39 (little-endian u64)
    let ptr_offset = u64::from_le_bytes([
        bytes[32], bytes[33], bytes[34], bytes[35],
        bytes[36], bytes[37], bytes[38], bytes[39],
    ]) as usize;

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
    // 256-layer world (131072 bytes/chunk, 16 bands).
    //
    // Version field at bytes[92..96] selects the format:
    //   version >= 5       → 256z New Dawn (versions 5 and 6 observed in the wild)
    //   version <= 4       → 64z legacy (Eden 2.1 and older; version 2 is also legacy)
    // This check is authoritative even for single-chunk worlds where the gap heuristic
    // below would silently default to 64z.
    //
    // Fallback (unknown version): check the minimum gap between sorted chunk offsets.
    // A valid 256z file never has two chunks closer than 131072 bytes apart.
    let version = if bytes.len() >= 96 {
        i32::from_le_bytes([bytes[92], bytes[93], bytes[94], bytes[95]])
    } else { 4 };
    let chunk_size = if version >= 5 {
        131072
    } else {
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
    let mut pixels = vec![0u8; (width * height * 4) as usize];

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

/// Front slab (constant world-Y plane). Horizontal axis = world X, vertical axis = world Z.
/// One O(1) voxel read per pixel — the X/Z analog of `render_zslice_patch_inner`, fully tileable.
/// Image row 0 = top = highest Z (`pz2`); `row = pz2 - z`. The returned `PixelPatch.x` is the
/// horizontal world-X start and `.y` is the vertical world-Z start (`pz1`).
fn render_yslice_patch_inner(world: &LoadedWorld, sy: i32, px1: i32, pz1: i32, px2: i32, pz2: i32) -> PixelPatch {
    let world_w = (world.w_chunks * 16) as i32;
    let world_h = (world.h_chunks * 16) as i32;
    let max_z   = world_max_z(world);
    if sy < 0 || sy >= world_h {
        return PixelPatch { x: 0, y: 0, width: 1, height: 1, pixels: vec![20, 20, 35, 255] };
    }
    let x1 = px1.clamp(0, world_w - 1);
    let x2 = px2.clamp(0, world_w - 1);
    let z1 = pz1.clamp(0, max_z);
    let z2 = pz2.clamp(0, max_z);
    let width  = (x2 - x1 + 1) as u32;
    let height = (z2 - z1 + 1) as u32;
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    let cy = (sy.div_euclid(16)) + world.min_y;
    let ly = sy.rem_euclid(16) as usize;
    for px in x1..=x2 {
        let cx = px.div_euclid(16) + world.min_x;
        let lx = px.rem_euclid(16) as usize;
        let &addr = match world.chunk_map.get(&(cx, cy)) { Some(a) => a, None => continue };
        for z in z1..=z2 {
            let band = (z as usize) / 16;
            let lz   = (z as usize) % 16;
            let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
            let pi = bi + 4096;
            if bi >= world.bytes.len() || pi >= world.bytes.len() { continue; }
            let bt = world.bytes[bi];
            if bt == 0 { continue; }
            let [r, g, b] = block_color(bt, world.bytes[pi], world.sky);
            let row = (z2 - z) as u32;
            let off = ((row * width + (px - x1) as u32) * 4) as usize;
            pixels[off] = r; pixels[off + 1] = g; pixels[off + 2] = b; pixels[off + 3] = 255;
        }
    }
    PixelPatch { x: x1 as u32, y: z1 as u32, width, height, pixels }
}

/// Side slab (constant world-X plane). Horizontal axis = world Y, vertical axis = world Z.
/// One O(1) voxel read per pixel. Image row 0 = top = highest Z (`pz2`); `row = pz2 - z`.
/// Returned `PixelPatch.x` is the horizontal world-Y start and `.y` is the vertical world-Z start.
fn render_xslice_patch_inner(world: &LoadedWorld, sx: i32, py1: i32, pz1: i32, py2: i32, pz2: i32) -> PixelPatch {
    let world_w = (world.w_chunks * 16) as i32;
    let world_h = (world.h_chunks * 16) as i32;
    let max_z   = world_max_z(world);
    if sx < 0 || sx >= world_w {
        return PixelPatch { x: 0, y: 0, width: 1, height: 1, pixels: vec![20, 20, 35, 255] };
    }
    let y1 = py1.clamp(0, world_h - 1);
    let y2 = py2.clamp(0, world_h - 1);
    let z1 = pz1.clamp(0, max_z);
    let z2 = pz2.clamp(0, max_z);
    let width  = (y2 - y1 + 1) as u32;
    let height = (z2 - z1 + 1) as u32;
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }

    let cx = sx.div_euclid(16) + world.min_x;
    let lx = sx.rem_euclid(16) as usize;
    for py in y1..=y2 {
        let cy = py.div_euclid(16) + world.min_y;
        let ly = py.rem_euclid(16) as usize;
        let &addr = match world.chunk_map.get(&(cx, cy)) { Some(a) => a, None => continue };
        for z in z1..=z2 {
            let band = (z as usize) / 16;
            let lz   = (z as usize) % 16;
            let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
            let pi = bi + 4096;
            if bi >= world.bytes.len() || pi >= world.bytes.len() { continue; }
            let bt = world.bytes[bi];
            if bt == 0 { continue; }
            let [r, g, b] = block_color(bt, world.bytes[pi], world.sky);
            let row = (z2 - z) as u32;
            let off = ((row * width + (py - y1) as u32) * 4) as usize;
            pixels[off] = r; pixels[off + 1] = g; pixels[off + 2] = b; pixels[off + 3] = 255;
        }
    }
    PixelPatch { x: y1 as u32, y: z1 as u32, width, height, pixels }
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
    let spawn = read_spawn(&loaded);
    // Centroid of populated chunks in local block coords (chunk centres). Robust spawn target for
    // the 3D camera on sparse worlds where the bounding-box centre lands on empty space.
    let center = {
        let n = loaded.chunk_map.len();
        if n == 0 { None } else {
            let (sx, sy) = loaded.chunk_map.keys().fold((0i64, 0i64), |(ax, ay), &(cx, cy)| {
                (ax + ((cx - loaded.min_x) as i64 * 16 + 8),
                 ay + ((cy - loaded.min_y) as i64 * 16 + 8))
            });
            Some((sx as f32 / n as f32, sy as f32 / n as f32))
        }
    };
    let meta = WorldMeta {
        name:          loaded.name.clone(),
        width_chunks:  loaded.w_chunks,
        height_chunks: loaded.h_chunks,
        max_z:         world_max_z(&loaded) as u32,
        was_compressed: maybe_temp.is_some(),
        spawn_px: spawn.map(|(x, _)| x),
        spawn_py: spawn.map(|(_, y)| y),
        center_px: center.map(|(x, _)| x),
        center_py: center.map(|(_, y)| y),
        abs_min_x: loaded.min_x,
        abs_min_y: loaded.min_y,
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

#[derive(Serialize)]
struct WorldInfo {
    name: String,
    level_seed: i32,
    /// Last-walked position, converted to local block coords (editor X, editor Y, block Z/height).
    pos_local_x: f32, pos_local_y: f32, pos_height: f32,
    /// Spawn/home position, local block coords.
    home_local_x: f32, home_local_y: f32, home_height: f32,
    /// Unknown float at header byte 28 — possibly player heading/yaw.
    heading: f32,
    version: i32,
    sky_colors: Vec<u8>,
    golden_cubes: i32,
    width_chunks: u32, height_chunks: u32,
    max_z: u32, chunk_count: usize,
    abs_min_x: i32, abs_min_y: i32,
    spawn_px: Option<f32>, spawn_py: Option<f32>,
}

#[tauri::command]
fn get_world_info(state: tauri::State<'_, AppState>) -> Result<WorldInfo, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let b = &world.bytes;

    macro_rules! read_i32 { ($o:expr) => { if b.len() >= $o + 4 { i32::from_le_bytes([b[$o],b[$o+1],b[$o+2],b[$o+3]]) } else { 0 } }; }
    macro_rules! read_f32 { ($o:expr) => { if b.len() >= $o + 4 { f32::from_le_bytes([b[$o],b[$o+1],b[$o+2],b[$o+3]]) } else { 0.0 } }; }

    let level_seed = read_i32!(0);
    // @4: last-walked position (abs game x, height-y, z) — game Z maps to editor Y
    let pos_abs_x = read_f32!(4);
    let pos_height = read_f32!(8);
    let pos_abs_z = read_f32!(12);
    let home_abs_x = read_f32!(16);
    let home_height = read_f32!(20);
    let home_abs_z = read_f32!(24);
    let heading = read_f32!(28);
    let version  = read_i32!(92);

    let sky_colors: Vec<u8> = if b.len() >= 148 { b[132..148].to_vec() } else { vec![14; 16] };
    let golden_cubes = read_i32!(148);

    // Convert absolute game coords → local block coords
    let origin_x = world.min_x as f32 * 16.0;
    let origin_y = world.min_y as f32 * 16.0;
    let pos_local_x = pos_abs_x - origin_x;
    let pos_local_y = pos_abs_z - origin_y;
    let home_local_x = home_abs_x - origin_x;
    let home_local_y = home_abs_z - origin_y;

    let spawn = read_spawn(world);

    Ok(WorldInfo {
        name: world.name.clone(), level_seed,
        pos_local_x, pos_local_y, pos_height,
        home_local_x, home_local_y, home_height,
        heading, version, sky_colors, golden_cubes,
        width_chunks: world.w_chunks, height_chunks: world.h_chunks,
        max_z: world_max_z(world) as u32, chunk_count: world.chunk_map.len(),
        abs_min_x: world.min_x, abs_min_y: world.min_y,
        spawn_px: spawn.map(|(x,_)| x), spawn_py: spawn.map(|(_,y)| y),
    })
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

// ── Eden.eden template overlay ────────────────────────────────────────────────

/// Decode one column (4 RLE sub-chunks) from Eden.eden into a raw 32768-byte chunk.
/// Eden.eden voxel order: (lz, ly, lx) i.e. rle_i = lz*256 + ly*16 + lx.
/// Eden raw storage order: block at band*8192 + lx*256 + ly*16 + lz, paint at +4096.
fn decode_template_column(data: &[u8], col_offset: usize) -> Option<Box<[u8; 32768]>> {
    let mut raw = Box::new([0u8; 32768]);
    let mut pos = col_offset;
    for band in 0..4usize {
        if pos + 2 > data.len() { return None; }
        let size = (data[pos] as usize) * 256 + (data[pos + 1] as usize);
        if size < 2 || pos + size > data.len() { return None; }
        let payload = &data[pos + 2..pos + size];
        pos += size;
        let band_base = band * 8192;
        let mut rle_idx: usize = 0;
        let mut pi = 0usize;
        while pi + 2 < payload.len() && rle_idx < 4096 {
            let block = payload[pi];
            let paint = payload[pi + 1];
            let count = payload[pi + 2] as usize;
            pi += 3;
            for _ in 0..count {
                if rle_idx >= 4096 { break; }
                let lz = rle_idx / 256;
                let ly = (rle_idx % 256) / 16;
                let lx = rle_idx % 16;
                let storage = lx * 256 + ly * 16 + lz;
                raw[band_base + storage] = block;
                raw[band_base + 4096 + storage] = paint;
                rle_idx += 1;
            }
        }
    }
    Some(raw)
}

/// Decode a column's RLE directly to surface colors: one [r,g,b,a] per (lx*16+ly) position.
/// Scans bands from highest to lowest; within each band, a later (higher lz) non-air block
/// overwrites an earlier one. Stops filling positions once all 256 are covered.
/// Result: a=255 means a block exists at that column, a=0 means the entire column is air.
fn decode_template_surface(data: &[u8], col_offset: usize, sky: u8) -> Option<Box<[[u8; 4]; 256]>> {
    let mut surface = Box::new([[0u8; 4]; 256]);
    let mut filled = 0usize;

    // Collect sub-chunk offsets first (need to iterate bands highest-to-lowest)
    let mut offsets = [0usize; 4];
    let mut pos = col_offset;
    for band in 0..4usize {
        if pos + 2 > data.len() { return None; }
        let size = (data[pos] as usize) * 256 + (data[pos + 1] as usize);
        if size < 2 || pos + size > data.len() { return None; }
        offsets[band] = pos;
        pos += size;
    }

    // Process bands highest to lowest; within a band, last non-air block (highest lz) wins
    for band in (0..4usize).rev() {
        let pos0 = offsets[band];
        let size = (data[pos0] as usize) * 256 + (data[pos0 + 1] as usize);
        let payload = &data[pos0 + 2..pos0 + size];

        // Scan RLE forward; rle_idx = lz*256 + ly*16 + lx, so lz increases as rle_idx increases.
        // Overwrite band_top with each non-air block seen, so the last wins (highest lz).
        let mut band_top = [(0u8, 0u8); 256]; // (block_type, paint) per (lx*16+ly)
        let mut rle_idx: usize = 0;
        let mut pi = 0usize;
        while pi + 2 < payload.len() && rle_idx < 4096 {
            let block = payload[pi];
            let paint = payload[pi + 1];
            let count = payload[pi + 2] as usize;
            pi += 3;
            for _ in 0..count {
                if rle_idx >= 4096 { break; }
                let ly = (rle_idx % 256) / 16;
                let lx = rle_idx % 16;
                if block != 0 {
                    band_top[lx * 16 + ly] = (block, paint);
                }
                rle_idx += 1;
            }
        }

        // Merge into surface: only fill positions not already covered by a higher band
        for pos in 0..256 {
            let (bt, paint) = band_top[pos];
            if bt != 0 && surface[pos][3] == 0 {
                let [r, g, b] = block_color(bt, paint, sky);
                surface[pos] = [r, g, b, 255];
                filled += 1;
                if filled == 256 { break; }
            }
        }
        if filled == 256 { break; }
    }

    Some(surface)
}

/// Load an Eden.eden template file. Parses its i32+i32+u64 directory (different from
/// regular saves which use i16+u16+u32). Stores mmap + directory in WorldState.
#[tauri::command]
fn load_eden_template(path: String, state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let file = fs::File::open(&path).map_err(|e| format!("Cannot open template: {e}"))?;
    let mmap = unsafe { Mmap::map(&file).map_err(|e| format!("Cannot mmap template: {e}"))? };

    if mmap.len() < 192 {
        return Err("File too small to be a valid Eden.eden template".into());
    }

    let dir_offset = u64::from_le_bytes(
        mmap[32..40].try_into().map_err(|_| "Bad header")?
    ) as usize;

    if dir_offset >= mmap.len() || (mmap.len() - dir_offset) % 16 != 0 {
        return Err("Invalid template directory offset".into());
    }

    let n_entries = (mmap.len() - dir_offset) / 16;
    let mut template_dir: HashMap<(i32, i32), usize> = HashMap::with_capacity(n_entries);
    let mut i = dir_offset;
    while i + 16 <= mmap.len() {
        let tx = i32::from_le_bytes(mmap[i..i+4].try_into().unwrap());
        let tz = i32::from_le_bytes(mmap[i+4..i+8].try_into().unwrap());
        let offset = u64::from_le_bytes(mmap[i+8..i+16].try_into().unwrap()) as usize;
        if offset < mmap.len() {
            template_dir.insert((tx, tz), offset);
        }
        i += 16;
    }

    let chunk_count = template_dir.len() as u32;
    let mut ws = state.lock().unwrap();
    ws.template_bytes = Some(mmap);
    ws.template_dir = template_dir;
    ws.template_surface_cache.clear();
    Ok(chunk_count)
}

/// Render a top-down pixel patch from the Eden.eden template, aligned to the loaded world's
/// coordinate space. Returns RGBA pixels; alpha=0 where no template chunk exists.
#[tauri::command]
fn fetch_template_tile(
    x1: i32, y1: i32, x2: i32, y2: i32,
    state: tauri::State<'_, AppState>,
) -> Result<PixelPatch, String> {
    let mut ws = state.lock().unwrap();
    if ws.world.is_none() { return Err("No world loaded".into()); }
    if ws.template_bytes.is_none() { return Err("No template loaded".into()); }

    let min_x = ws.world.as_ref().unwrap().min_x;
    let min_y = ws.world.as_ref().unwrap().min_y;
    let sky    = ws.world.as_ref().unwrap().sky;
    let world_w = (ws.world.as_ref().unwrap().w_chunks * 16) as i32;
    let world_h = (ws.world.as_ref().unwrap().h_chunks * 16) as i32;

    let x1u = x1.clamp(0, world_w - 1) as u32;
    let y1u = y1.clamp(0, world_h - 1) as u32;
    let x2u = x2.clamp(0, world_w - 1) as u32;
    let y2u = y2.clamp(0, world_h - 1) as u32;
    let width  = x2u - x1u + 1;
    let height = y2u - y1u + 1;
    let mut pixels = vec![0u8; (width * height * 4) as usize];

    // Collect unique chunks needed for this tile and decode missing ones
    let cx0 = (x1u / 16) as i32 + min_x;
    let cx1 = (x2u / 16) as i32 + min_x;
    let cz0 = (y1u / 16) as i32 + min_y;
    let cz1 = (y2u / 16) as i32 + min_y;
    for tx in cx0..=cx1 {
        for tz in cz0..=cz1 {
            if ws.template_surface_cache.contains_key(&(tx, tz)) { continue; }
            if let Some(&col_off) = ws.template_dir.get(&(tx, tz)) {
                if let Some(surf) = decode_template_surface(ws.template_bytes.as_ref().unwrap(), col_off, sky) {
                    ws.template_surface_cache.insert((tx, tz), surf);
                }
            }
        }
    }

    for px in x1u..=x2u {
        for py in y1u..=y2u {
            let tx = (px / 16) as i32 + min_x;
            let tz = (py / 16) as i32 + min_y;
            let lx = (px % 16) as usize;
            let ly = (py % 16) as usize;

            if let Some(surf) = ws.template_surface_cache.get(&(tx, tz)) {
                let [r, g, b, a] = surf[lx * 16 + ly];
                if a == 255 {
                    let off = (((py - y1u) * width + (px - x1u)) * 4) as usize;
                    pixels[off] = r; pixels[off+1] = g; pixels[off+2] = b; pixels[off+3] = 255;
                }
            }
        }
    }

    Ok(PixelPatch { x: x1u, y: y1u, width, height, pixels })
}

#[derive(Serialize)]
struct ExpandResult {
    chunks_added: u32,
    total_chunks: u32,
}

/// Bake Eden.eden template chunks into a new world file. Only fills chunks not already edited
/// by the user. full_extent=true expands to full 180×180 template; false = within current bounds.
#[tauri::command]
fn expand_world_from_template(
    output_path: String,
    full_extent: bool,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ExpandResult, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    if ws.template_bytes.is_none() {
        return Err("No template loaded".into());
    }

    let min_x = world.min_x;
    let min_y = world.min_y;
    let max_x = min_x + world.w_chunks as i32 - 1;
    let max_y = min_y + world.h_chunks as i32 - 1;
    let sky = world.sky;
    let chunk_size = world.chunk_size;
    let _ = sky; // used only for rendering

    let tmpl = ws.template_bytes.as_ref().unwrap();
    let tdir = &ws.template_dir;

    // Collect target template chunks
    let mut targets: Vec<(i32, i32)> = tdir.keys().copied().filter(|&(tx, tz)| {
        if full_extent { true }
        else { tx >= min_x && tx <= max_x && tz >= min_y && tz <= max_y }
    }).collect();
    targets.sort_unstable();

    let user_chunks: HashSet<(i32, i32)> = world.chunk_map.keys().copied().collect();
    let to_add: Vec<(i32, i32)> = targets.into_iter()
        .filter(|k| !user_chunks.contains(k))
        .collect();
    let total = (user_chunks.len() + to_add.len()) as u32;
    let add_count = to_add.len() as u32;

    // Write output file using BufWriter for performance
    let out_file = fs::File::create(&output_path)
        .map_err(|e| format!("Cannot create output file: {e}"))?;
    let mut writer = BufWriter::with_capacity(4 * 1024 * 1024, out_file);

    // Header: copy from world, will patch directory_offset at the end
    let header = &world.bytes[..192.min(world.bytes.len())];
    writer.write_all(header).map_err(|e| format!("Write error: {e}"))?;
    let mut cur_offset: u64 = 192;

    let mut dir_entries: Vec<(i16, i16, u32)> = Vec::with_capacity(total as usize);

    // Write existing user chunks
    let mut user_chunk_list: Vec<(i32, i32, usize)> = world.chunk_map.iter()
        .map(|(&(cx, cy), &off)| (cx, cy, off))
        .collect();
    user_chunk_list.sort_unstable_by_key(|&(cx, cy, _)| (cx, cy));

    for (cx, cy, off) in &user_chunk_list {
        let end = off + chunk_size;
        if end > world.bytes.len() { continue; }
        writer.write_all(&world.bytes[*off..end])
            .map_err(|e| format!("Write error: {e}"))?;
        dir_entries.push((*cx as i16, *cy as i16, cur_offset as u32));
        cur_offset += chunk_size as u64;
    }

    // Write template chunks (decoded from RLE)
    let template_total = to_add.len();
    for (i, (tx, tz)) in to_add.iter().enumerate() {
        if let Some(&col_off) = tdir.get(&(*tx, *tz)) {
            if let Some(raw) = decode_template_column(tmpl, col_off) {
                writer.write_all(raw.as_ref())
                    .map_err(|e| format!("Write error: {e}"))?;
                dir_entries.push((*tx as i16, *tz as i16, cur_offset as u32));
                cur_offset += 32768u64;
            }
        }
        if (i + 1) % 500 == 0 || i + 1 == template_total {
            let pct = ((i + 1) as f64 / template_total as f64 * 100.0) as u32;
            let _ = app_handle.emit("expand_progress", pct);
        }
    }

    // Write directory (standard save format: i16 cx, pad 2, i16 cy, pad 2, u32 off, pad 4)
    let dir_offset = cur_offset;
    for (cx, cy, off) in &dir_entries {
        writer.write_all(&cx.to_le_bytes()).map_err(|e| format!("Write error: {e}"))?;
        writer.write_all(&[0u8, 0]).map_err(|e| format!("Write error: {e}"))?;
        writer.write_all(&cy.to_le_bytes()).map_err(|e| format!("Write error: {e}"))?;
        writer.write_all(&[0u8, 0]).map_err(|e| format!("Write error: {e}"))?;
        writer.write_all(&off.to_le_bytes()).map_err(|e| format!("Write error: {e}"))?;
        writer.write_all(&[0u8, 0, 0, 0]).map_err(|e| format!("Write error: {e}"))?;
    }

    writer.flush().map_err(|e| format!("Flush error: {e}"))?;
    drop(writer);

    // Patch directory_offset in header (bytes 32–39)
    let mut f = fs::OpenOptions::new().write(true).open(&output_path)
        .map_err(|e| format!("Cannot reopen output: {e}"))?;
    f.seek(SeekFrom::Start(32)).map_err(|e| format!("Seek error: {e}"))?;
    f.write_all(&dir_offset.to_le_bytes()).map_err(|e| format!("Patch error: {e}"))?;
    drop(f);

    Ok(ExpandResult { chunks_added: add_count, total_chunks: total })
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

/// Front-slab tile: constant world-Y plane. Horizontal = X (x1..x2), vertical = Z (z1..z2).
/// Tiled, O(1) per pixel. Used by the front viewport in multi-viewport mode.
#[tauri::command]
fn render_yslice_patch(
    y: i32, x1: i32, z1: i32, x2: i32, z2: i32,
    state: tauri::State<'_, AppState>,
) -> Result<PixelPatch, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let world_h = (world.h_chunks * 16) as i32;
    if y < 0 || y >= world_h {
        return Err(format!("Y must be 0–{}, got {y}", world_h - 1));
    }
    Ok(render_yslice_patch_inner(world, y, x1, z1, x2, z2))
}

/// Side-slab tile: constant world-X plane. Horizontal = Y (y1..y2), vertical = Z (z1..z2).
/// Tiled, O(1) per pixel. Used by the side viewport in multi-viewport mode.
#[tauri::command]
fn render_xslice_patch(
    x: i32, y1: i32, z1: i32, y2: i32, z2: i32,
    state: tauri::State<'_, AppState>,
) -> Result<PixelPatch, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let world_w = (world.w_chunks * 16) as i32;
    if x < 0 || x >= world_w {
        return Err(format!("X must be 0–{}, got {x}", world_w - 1));
    }
    Ok(render_xslice_patch_inner(world, x, y1, z1, y2, z2))
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

    let is_door   = (66..=69).contains(&block_type);
    let is_portal = (75..=78).contains(&block_type);
    let top_type: u8 = if is_door { 70 } else if is_portal { 79 } else { 0 };

    for b in &blocks {
        let z = match b.z {
            Some(z) => {
                if z < 0 || z > max_z { continue; }
                z
            }
            None => match surface_z(&world, b.x, b.y) {
                Some(z) => {
                    // Doors/portals float one block above ground; top goes two above.
                    let elev = if is_door || is_portal { z_offset + 1 } else { z_offset };
                    let z2 = z + elev;
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
        // Auto-place paired top block for doors and portals.
        if top_type != 0 && z + 1 <= max_z {
            set_block_abs(&mut world, b.x, b.y, z + 1, top_type, paint);
        }
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

// ── Perlin noise (ported from the Eden game's fixed permutation noiseFast) ──────
// Uses the same permutation table as TerrainGenerator.mm so generated terrain
// will match the old game's aesthetic if it ever re-enabled procedural generation.
const PERLIN_PERM: [u8; 256] = [
    151,160,137, 91, 90, 15,131, 13,201, 95, 96, 53,194,233,  7,225,
    140, 36,103, 30, 69,142,  8, 99, 37,240, 21, 10, 23,190,  6,148,
    247,120,234, 75,  0, 26,197, 62, 94,252,219,203,117, 35, 11, 32,
     57,177, 33, 88,237,149, 56, 87,174, 20,125,136,171,168, 68,175,
     74,165, 71,134,139, 48, 27,166, 77,146,158,231, 83,111,229,122,
     60,211,133,230,220,105, 92, 41, 55, 46,245, 40,244,102,143, 54,
     65, 25, 63,161,  1,216, 80, 73,209, 76,132,187,208, 89, 18,169,
    200,196,135,130,116,188,159, 86,164,100,109,198,173,186,  3, 64,
     52,217,226,250,124,123,  5,202, 38,147,118,126,255, 82, 85,212,
    207,206, 59,227, 47, 16, 58, 17,182,189, 28, 42,223,183,170,213,
    119,248,152,  2, 44,154,163, 70,221,153,101,155,167, 43,172,  9,
    129, 22, 39,253, 19, 98,108,110, 79,113,224,232,178,185,112,104,
    218,246, 97,228,251, 34,242,193,238,210,144, 12,191,179,162,241,
     81, 51,145,235,249, 14,239,107, 49,192,214, 31,181,199,106,157,
    184, 84,204,176,115,121, 50, 45,127,  4,150,254,138,236,205, 93,
    222,114, 67, 29, 24, 72,243,141,128,195, 78, 66,215, 61,156,180,
];

#[inline]
fn pnoise_fade(t: f64) -> f64 { t * t * t * (t * (t * 6.0 - 15.0) + 10.0) }
#[inline]
fn pnoise_lerp(t: f64, a: f64, b: f64) -> f64 { a + t * (b - a) }
#[inline]
fn pnoise_grad(hash: u8, x: f64, y: f64, z: f64) -> f64 {
    let h = hash & 15;
    let u = if h < 8 { x } else { y };
    let v = if h < 4 { y } else if h == 12 || h == 14 { x } else { z };
    (if h & 1 == 0 { u } else { -u }) + (if h & 2 == 0 { v } else { -v })
}
fn perlin3(x: f64, y: f64, z: f64) -> f64 {
    let p = |i: usize| PERLIN_PERM[i & 255];
    let xi = (x.floor() as i32 & 255) as usize;
    let yi = (y.floor() as i32 & 255) as usize;
    let zi = (z.floor() as i32 & 255) as usize;
    let (xf, yf, zf) = (x - x.floor(), y - y.floor(), z - z.floor());
    let (u, v, w) = (pnoise_fade(xf), pnoise_fade(yf), pnoise_fade(zf));
    let a  = p(xi)   as usize + yi;
    let aa = p(a)    as usize + zi;
    let ab = p(a+1)  as usize + zi;
    let b  = p(xi+1) as usize + yi;
    let ba = p(b)    as usize + zi;
    let bb = p(b+1)  as usize + zi;
    pnoise_lerp(w,
        pnoise_lerp(v,
            pnoise_lerp(u, pnoise_grad(p(aa),   xf,     yf,     zf  ),
                           pnoise_grad(p(ba),   xf-1.0, yf,     zf  )),
            pnoise_lerp(u, pnoise_grad(p(ab),   xf,     yf-1.0, zf  ),
                           pnoise_grad(p(bb),   xf-1.0, yf-1.0, zf  ))),
        pnoise_lerp(v,
            pnoise_lerp(u, pnoise_grad(p(aa+1), xf,     yf,     zf-1.0),
                           pnoise_grad(p(ba+1), xf-1.0, yf,     zf-1.0)),
            pnoise_lerp(u, pnoise_grad(p(ab+1), xf,     yf-1.0, zf-1.0),
                           pnoise_grad(p(bb+1), xf-1.0, yf-1.0, zf-1.0))))
}

fn chunk_set(data: &mut [u8], lx: usize, ly: usize, z: usize, bt: u8) {
    let bi = (z / 16) * 8192 + lx * 256 + ly * 16 + (z % 16);
    if bi < data.len() { data[bi] = bt; }
}
fn chunk_get(data: &[u8], lx: usize, ly: usize, z: usize) -> u8 {
    let bi = (z / 16) * 8192 + lx * 256 + ly * 16 + (z % 16);
    if bi < data.len() { data[bi] } else { 0 }
}
fn chunk_set_paint(data: &mut [u8], lx: usize, ly: usize, z: usize, paint: u8) {
    let bi = (z / 16) * 8192 + lx * 256 + ly * 16 + (z % 16) + 4096;
    if bi < data.len() { data[bi] = paint; }
}
#[cfg(test)]
fn chunk_get_paint(data: &[u8], lx: usize, ly: usize, z: usize) -> u8 {
    let bi = (z / 16) * 8192 + lx * 256 + ly * 16 + (z % 16) + 4096;
    if bi < data.len() { data[bi] } else { 0 }
}

#[derive(Clone, Copy)]
struct NaturalConfig {
    seed: u32,
    base_height: usize,
    roughness: f64,          // 0..1 amplitude scale
    erosion: f64,            // 0..1 flatness strength: high-erosion regions get reduced relief
    terrain_scale: f64,      // base noise wavelength in blocks (larger = broader features)
    extreme: bool,           // 256z only: towering mountain relief + sharper ridges
    water_z: i32,            // -1 = no standing water
    rivers: bool,
    biome: u8,               // single-mode biome: 0 grassland, 1 desert, 2 snow, 3 lava, 4 classic hills
    biome_mode: u32,         // 0 single (use `biome`), 1 mixed (per-column climate blend)
    biome_scale: f64,        // mixed-mode biome region wavelength in blocks
    snow_caps: bool,
    tree_density_denom: u64, // 0 = none; else 1-in-N grass columns
    cave_density: u32,       // 0 none, 1 rare, 2 common
    cave_style: u32,         // 0 spaghetti tunnels, 1 classic 3D-noise caves
    caverns: bool,           // large open caverns + deep lava pools
    flood_caves: bool,       // false = cave air stays dry; true = water floods caves below water_z
    ore_density: u32,        // 0 none, 1 sparse, 2 rich
    vegetation: u32,         // 0 none, 1 light, 2 lush
    structures: u32,         // 0 none, 1 sparse, 2 common
    clouds: bool,
}

/// Vertical relief as a fraction of world height, and the ridged-mountain weight.
/// "Extreme" mode (256z only) pushes peaks far higher and sharpens ridges.
#[inline]
fn relief_factor(cfg: &NaturalConfig) -> f64 { if cfg.extreme { 0.62 } else { 0.42 } }
#[inline]
fn ridge_weight(cfg: &NaturalConfig) -> f64 { if cfg.extreme { 1.7 } else { 1.1 } }

// ── Noise helpers (built on perlin3) ───────────────────────────────────────────

#[inline]
fn fbm2(x: f64, y: f64, octaves: u32) -> f64 {
    let (mut sum, mut freq, mut amp, mut norm) = (0.0f64, 1.0f64, 1.0f64, 0.0f64);
    for _ in 0..octaves {
        sum += perlin3(x * freq, y * freq, 0.5) * amp;
        norm += amp; freq *= 2.0; amp *= 0.5;
    }
    if norm > 0.0 { sum / norm } else { 0.0 }
}

#[inline]
fn fbm3(x: f64, y: f64, z: f64, octaves: u32) -> f64 {
    let (mut sum, mut freq, mut amp, mut norm) = (0.0f64, 1.0f64, 1.0f64, 0.0f64);
    for _ in 0..octaves {
        sum += perlin3(x * freq, y * freq, z * freq) * amp;
        norm += amp; freq *= 2.0; amp *= 0.5;
    }
    if norm > 0.0 { sum / norm } else { 0.0 }
}

#[inline]
fn ridged2(x: f64, y: f64, octaves: u32) -> f64 {
    let (mut sum, mut freq, mut amp, mut norm) = (0.0f64, 1.0f64, 1.0f64, 0.0f64);
    for _ in 0..octaves {
        let n = 1.0 - perlin3(x * freq, y * freq, 0.5).abs();
        sum += n * n * amp;
        norm += amp; freq *= 2.0; amp *= 0.5;
    }
    if norm > 0.0 { sum / norm } else { 0.0 }
}

#[inline]
fn hash3(x: i32, y: i32, z: i32, seed: u32) -> u64 {
    let mut h = (x as i64 as u64).wrapping_mul(0x9E3779B97F4A7C15)
        ^ (y as i64 as u64).wrapping_mul(0xC2B2AE3D27D4EB4F)
        ^ (z as i64 as u64).wrapping_mul(0x27D4EB2F165667C5)
        ^ (seed as u64).wrapping_mul(0x165667B19E3779F9);
    h ^= h >> 30; h = h.wrapping_mul(0xBF58476D1CE4E5B9);
    h ^= h >> 27; h = h.wrapping_mul(0x94D049BB133111EB);
    h ^= h >> 31; h
}
#[inline] fn hash2(x: i32, y: i32, seed: u32) -> u64 { hash3(x, y, 0x5151, seed) }
#[inline] fn rand01(h: u64) -> f64 { ((h >> 11) as f64) / ((1u64 << 53) as f64) }

const FLOWER_PAINTS: [u8; 6] = [1, 2, 3, 6, 8, 16];

#[inline]
fn natural_sf(seed: u32) -> f64 { (seed as f64) * 0.0013 + 17.0 }

/// True if the column lies inside a river channel.
#[inline]
fn river_here(wx: f64, wy: f64, cfg: &NaturalConfig) -> bool {
    if !cfg.rivers { return false; }
    let sf = natural_sf(cfg.seed);
    let scale = cfg.terrain_scale.max(24.0);
    let rn = fbm2((wx + sf * 2.0) / (scale * 2.2), (wy + sf * 2.0) / (scale * 2.2), 2);
    rn.abs() < 0.055
}

/// World-space surface height for a column (domain-warped fBm + ridged mountains + rivers).
fn terrain_height(wx: f64, wy: f64, cfg: &NaturalConfig, t_height: usize) -> i32 {
    let sf = natural_sf(cfg.seed);
    let scale = cfg.terrain_scale.max(24.0);

    // Domain warp for organic, non-grid-aligned shapes.
    let warp = scale * 0.20;
    let wxw = wx + fbm2((wx + sf) / (scale * 1.7), (wy - sf) / (scale * 1.7), 2) * warp;
    let wyw = wy + fbm2((wx - sf) / (scale * 1.7), (wy + sf) / (scale * 1.7), 2) * warp;

    let cont  = fbm2((wxw + sf) / scale, (wyw + sf) / scale, 6);                                // -1..1 rolling base
    let ridge = ridged2((wx + sf * 1.3) / (scale * 0.55), (wy - sf * 1.3) / (scale * 0.55), 4); // 0..1 sharp peaks

    let max_relief = (t_height as f64) * relief_factor(cfg);
    let mut amp = cfg.roughness * max_relief;
    // Erosion: a low-frequency field flattens relief where it reads high, giving
    // Minecraft-like alternation between flat plains and rugged highlands over the
    // *same* continuous surface (no biome cliffs). 0 = uniform relief everywhere.
    if cfg.erosion > 0.0 {
        let er = fbm2((wx + sf * 4.0) / (scale * 2.5), (wy - sf * 4.0) / (scale * 2.5), 3);
        let flat = (er * 0.5 + 0.5).clamp(0.0, 1.0).powf(1.3); // 0..1, high = flat
        amp *= 1.0 - cfg.erosion * flat * 0.80; // up to 80% relief reduction
    }
    let peak_mask = (cont * 0.5 + 0.5).clamp(0.0, 1.0).powf(1.7);

    let h = cfg.base_height as f64
        + cont * amp * 0.65
        + ridge * peak_mask * amp * ridge_weight(cfg);

    let h = river_carved_height(h, wx, wy, cfg);
    (h.round() as i32).clamp(2, (t_height - 6) as i32)
}

/// Lower a column toward the river bed where it lies inside a river channel
/// (smoothstep from bank to centre). Shared by the natural and Classic+ heightmaps.
#[inline]
fn river_carved_height(h: f64, wx: f64, wy: f64, cfg: &NaturalConfig) -> f64 {
    if !cfg.rivers { return h; }
    let sf = natural_sf(cfg.seed);
    let scale = cfg.terrain_scale.max(24.0);
    let rn = fbm2((wx + sf * 2.0) / (scale * 2.2), (wy + sf * 2.0) / (scale * 2.2), 2);
    let d = rn.abs();
    let bank = 0.055;
    if d < bank {
        let river_bottom = cfg.base_height as f64 - 4.0;
        let t = (d / bank).clamp(0.0, 1.0);
        let s = t * t * (3.0 - 2.0 * t); // smoothstep: 0 at centre, 1 at bank
        let carved = river_bottom + (h - river_bottom) * s;
        return h.min(carved);
    }
    h
}

/// True if the cell should be carved to air (cave/tunnel/cavern).
#[inline]
fn carve_cave(wx: f64, wy: f64, z: f64, cfg: &NaturalConfig) -> bool {
    if cfg.cave_density == 0 { return false; }
    let s = natural_sf(cfg.seed) * 0.7 + 3.0;
    let scale = 26.0;
    let zc = z * 1.8; // flatten tunnels vertically
    // Spaghetti tunnels: two perlin fields both near zero => tube.
    let n1 = perlin3((wx + s) / scale, (wy - s) / scale, zc / scale);
    let n2 = perlin3((wx - s) / scale + 41.0, (wy + s) / scale - 17.0, zc / scale);
    let tube = if cfg.cave_density >= 2 { 0.10 } else { 0.072 };
    if n1.abs() < tube && n2.abs() < tube { return true; }
    if cfg.caverns {
        let cav = fbm3((wx + s) / 50.0, (wy - s) / 50.0, z / 30.0, 3);
        let thr = if cfg.cave_density >= 2 { -0.40 } else { -0.48 };
        if cav < thr { return true; }
    }
    false
}

/// Stone or an ore-ish block for a given underground cell.
#[inline]
fn ore_block(wx: i32, wy: i32, z: i32, surf_z: usize, cfg: &NaturalConfig) -> u8 {
    if cfg.ore_density == 0 { return 2; }
    let v = fbm3((wx as f64 + 5.0) / 20.0, (wy as f64 - 5.0) / 20.0, z as f64 / 14.0, 3);
    let thr = if cfg.ore_density >= 2 { 0.42 } else { 0.55 };
    if v <= thr { return 2; }
    let depth = surf_z as i32 - z;
    if depth <= 3 { return 2; } // keep ore away from the immediate surface
    let pick = hash3(wx, wy, z, cfg.seed) % 100;
    if (z as usize) < surf_z / 4 && pick < 5 { 57 }   // deep glowing crystal (neon square)
    else if pick < 55 { 10 }                          // dark "coal" stone
    else { 14 }                                       // slate "ore"
}

/// Low-frequency temperature & moisture fields (each ~ -1..1) used to lay out
/// biome regions in mixed mode. Domain offsets keep the two fields uncorrelated.
#[inline]
fn biome_climate(wx: i32, wy: i32, cfg: &NaturalConfig) -> (f64, f64) {
    let sf = natural_sf(cfg.seed);
    let scale = cfg.biome_scale.max(16.0);
    let temp  = fbm2((wx as f64 + sf * 3.0) / scale,        (wy as f64 - sf * 3.0) / scale,        3);
    let moist = fbm2((wx as f64 - sf * 5.0) / (scale * 1.3), (wy as f64 + sf * 5.0) / (scale * 1.3), 3);
    (temp, moist)
}

/// Per-column biome id. In single mode this is just `cfg.biome`; in mixed mode it
/// blends grassland / desert / snow by temperature, moisture and altitude (higher
/// ground reads colder, so peaks turn snowy). Lava & classic are single-mode only.
#[inline]
fn biome_at(wx: i32, wy: i32, surf_z: usize, cfg: &NaturalConfig, t_height: usize) -> u8 {
    if cfg.biome_mode == 0 { return cfg.biome; }
    let (temp, moist) = biome_climate(wx, wy, cfg);
    // Altitude lapse: ground above the base height cools down.
    let alt = ((surf_z as f64 - cfg.base_height as f64) / t_height as f64).max(0.0);
    // Per-column jitter scatters the climate values within a small band so biome
    // borders break up into a speckled transition (à la Minecraft) instead of a
    // crisp line. Deterministic per column, so every pass agrees on the result.
    const BIOME_DITHER: f64 = 0.16;
    let jw = (rand01(hash2(wx, wy, cfg.seed ^ 0x00BE)) - 0.5) * BIOME_DITHER;
    let jm = (rand01(hash2(wx, wy, cfg.seed ^ 0x00BF)) - 0.5) * BIOME_DITHER;
    let warmth = temp - alt * 1.6 + jw;
    let moist = moist + jm;
    if warmth < -0.28 { 2 }                                 // snow (cold / high)
    else if warmth > 0.18 && moist < -0.05 { 1 }            // desert (hot & dry)
    else { 0 }                                              // grassland
}

/// Max absolute surface-height difference to the 4-connected neighbours — a cheap
/// slope measure. Steep columns (≥ `CLIFF_SLOPE`) expose bare rock instead of soil.
#[inline]
fn column_slope(heights: &[u16], bw: usize, bh: usize, wx: i32, wy: i32) -> i32 {
    let h = heights[wy as usize * bw + wx as usize] as i32;
    let mut maxd = 0;
    for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
        let (nx, ny) = (wx + dx, wy + dy);
        if nx < 0 || ny < 0 || nx as usize >= bw || ny as usize >= bh { continue; }
        let nh = heights[ny as usize * bw + nx as usize] as i32;
        maxd = maxd.max((h - nh).abs());
    }
    maxd
}

/// Surface steeper than this (blocks of drop to a neighbour) shows bare stone.
const CLIFF_SLOPE: i32 = 2;

/// Surface block + paint for a dry-land column of the given (already-resolved) biome.
fn surface_block(biome: u8, cfg: &NaturalConfig, surf_z: usize, snowline: f64, near_water: bool, wx: i32, wy: i32) -> (u8, u8) {
    match biome {
        1 => (4, 0),                       // desert sand
        2 => (8, 9),                       // snow: grass painted white
        3 => (10, 0),                      // lava: charred stone
        _ => {
            if near_water { return (4, 0); }                                 // beach
            if cfg.snow_caps && surf_z as f64 >= snowline { return (8, 9); } // alpine snow cap
            // Subtle grass mottling for a less flat look.
            let r = rand01(hash2(wx, wy, cfg.seed ^ 0x00A5));
            if r < 0.14 { (8, 31) } else if r < 0.28 { (8, 22) } else { (8, 0) }
        }
    }
}

/// Fill one chunk's terrain body: bedrock, stone+caves+ore, soft layer, surface, water.
fn fill_chunk_terrain(
    data: &mut [u8],
    cx: usize, cy: usize, wc: usize,
    heights: &[u16],
    cfg: &NaturalConfig,
    noise: &ClassicNoise,
    t_height: usize,
) {
    if cfg.biome_mode == 0 && cfg.biome == BIOME_CLASSIC {
        fill_classic_biome_chunk(data, cx, cy, wc, heights, cfg, noise, t_height);
        return;
    }
    let bw = wc * 16;
    let bh = heights.len() / bw;
    let snowline = cfg.base_height as f64 + (t_height as f64) * relief_factor(cfg) * 0.60;
    let classic_caves = cfg.cave_style == 1 && cfg.cave_density > 0;
    let seedf = cfg.seed as f64;
    for lx in 0..16usize {
        for ly in 0..16usize {
            let wx = (cx * 16 + lx) as i32;
            let wy = (cy * 16 + ly) as i32;
            let surf_z = heights[(wy as usize) * bw + wx as usize] as usize;
            let b = biome_at(wx, wy, surf_z, cfg, t_height); // resolved per-column biome

            // Standing-water level for this column (lakes/ocean + rivers).
            let mut water_level = cfg.water_z;
            if river_here(wx as f64, wy as f64, cfg) {
                water_level = water_level.max(cfg.base_height as i32 - 1);
            }
            let underwater = (surf_z as i32) <= water_level;
            let near_water = water_level >= 0 && (surf_z as i32) <= water_level + 2;
            // Steep, dry columns expose bare rock (cliff faces, rocky mountainsides).
            let cliff = !underwater && !near_water && column_slope(heights, bw, bh, wx, wy) >= CLIFF_SLOPE;

            chunk_set(data, lx, ly, 0, 1); // bedrock

            let soft_start = surf_z.saturating_sub(4);
            let soft_bt: u8 = if cliff {
                2
            } else {
                match b {
                    1 => 4,
                    3 => 2,
                    _ => if near_water { 4 } else { 3 },
                }
            };

            // Body of the column with caves + ore.
            // Classic caves carve only the deeper band so the surface stays supported.
            let cave_top = surf_z.saturating_sub(6);
            for z in 1..surf_z {
                let mut bt = if z < soft_start {
                    ore_block(wx, wy, z as i32, surf_z, cfg)
                } else {
                    soft_bt
                };
                if classic_caves {
                    // Classic 3D-noise caves: air where the noise is non-positive,
                    // dark-stone lining where it is barely positive (keeps natural
                    // ore in the rest of the rock).
                    if z >= 2 && z < cave_top {
                        match classic_cave_block(noise, wx, wy, z as i32, 1.0, seedf) {
                            0 => {
                                if cfg.caverns && (z as i32) <= cfg.base_height as i32 / 4 + 2 {
                                    bt = 23; // lava floor deep down
                                } else {
                                    bt = 0;  // open cave
                                }
                            }
                            10 if z < soft_start => bt = 10, // dark-stone vein lining
                            _ => {}
                        }
                    }
                } else if z >= 2 && z + 2 < surf_z && carve_cave(wx as f64, wy as f64, z as f64, cfg) {
                    // Spaghetti tunnels never touch the top two layers.
                    if cfg.caverns && (z as i32) <= cfg.base_height as i32 / 4 + 2 {
                        bt = 23; // lava floor deep in caverns
                    } else {
                        bt = 0;  // open air
                    }
                }
                if bt != 0 { chunk_set(data, lx, ly, z, bt); }
            }

            // Surface block.
            if underwater {
                let bed = match b { 3 => 2, _ => 4 };
                chunk_set(data, lx, ly, surf_z, bed);
            } else if cliff {
                chunk_set(data, lx, ly, surf_z, 2); // bare rock on steep faces
            } else {
                let (bt, paint) = surface_block(b, cfg, surf_z, snowline, near_water, wx, wy);
                chunk_set(data, lx, ly, surf_z, bt);
                if paint > 0 { chunk_set_paint(data, lx, ly, surf_z, paint); }
            }

            // Standing water / ice / lava fill.
            // Only fill columns whose surface is submerged (underwater), unless
            // flood_caves is set — that preserves rivers/lakes while keeping inland
            // cave voids dry.
            if water_level >= 0 && (underwater || cfg.flood_caves) {
                let fill_bt = match b { 2 => 15, 3 => 23, _ => 20 };
                let top = (water_level as usize).min(t_height - 1);
                for z in 1..=top {
                    if chunk_get(data, lx, ly, z) == 0 {
                        chunk_set(data, lx, ly, z, fill_bt);
                    }
                }
            }
        }
    }
}

/// True where the Classic Hills surface is a bare-rock outcrop rather than soil.
/// Driven by the classic skin noise: where the holey dirt skin "holes out" at the
/// surface, that column is exposed rock. Shared by the fill + the preview so they
/// agree on where the top-down stone patches appear.
#[inline]
fn classic_biome_rocky(noise: &ClassicNoise, wx: i32, wy: i32, surf_z: i32, seed: f64) -> bool {
    classic_skin_block(noise, wx, wy, surf_z, seed) == 0
}

/// Classic Hills biome column fill: the legacy stone body + classic caves + the
/// bumpy, overhung holey dirt skin. Soil columns are capped with grass so the
/// natural decoration pass (trees, vegetation, structures) still finds a grassy
/// top; rock-outcrop columns (`classic_biome_rocky`) are solid stone capped with
/// stone, giving exposed stone patches visible from directly above. Shares the
/// classic noise helpers with the Classic terrain tab.
fn fill_classic_biome_chunk(
    data: &mut [u8],
    cx: usize, cy: usize, wc: usize,
    heights: &[u16],
    cfg: &NaturalConfig,
    noise: &ClassicNoise,
    t_height: usize,
) {
    let bw = wc * 16;
    let s = t_height as f64 / 64.0;
    let skin = (6.0 * s).round() as i32;
    let cave_margin = (16.0 * s).round() as i32;
    let seed = cfg.seed as f64;
    let gen_caves = cfg.cave_density > 0;
    for lx in 0..16usize {
        for ly in 0..16usize {
            let wx = (cx * 16 + lx) as i32;
            let wy = (cy * 16 + ly) as i32;
            let h = heights[(wy as usize) * bw + wx as usize] as i32;
            chunk_set(data, lx, ly, 0, 1); // bedrock
            let formation = h - skin;

            // Standing water (lakes/ocean + rivers) — classic terrain with modern water.
            let mut water_level = cfg.water_z;
            if river_here(wx as f64, wy as f64, cfg) {
                water_level = water_level.max(cfg.base_height as i32 - 1);
            }
            let underwater = h <= water_level;
            let near_water = water_level >= 0 && h <= water_level + 2;

            // Rock outcrops are solid stone in the skin zone (no holes → no floating
            // cap); soil columns keep the holey dirt skin.
            let rocky = classic_biome_rocky(noise, wx, wy, h, seed) && !underwater;
            for y in 1..h {
                let bt: u8 = if y < formation {
                    if gen_caves && y > (h % 2 + 1) && y < formation - cave_margin {
                        classic_cave_block(noise, wx, wy, y, 1.0, seed)
                    } else {
                        2
                    }
                } else if rocky {
                    2
                } else {
                    classic_skin_block(noise, wx, wy, y, seed)
                };
                if bt != 0 { chunk_set(data, lx, ly, y as usize, bt); }
            }
            if underwater {
                chunk_set(data, lx, ly, h as usize, 4); // sandy lake/sea bed
            } else if rocky {
                chunk_set(data, lx, ly, h as usize, 2); // stone outcrop cap
            } else {
                // Soil column: guarantee the cap rests on dirt (the holey skin can
                // leave a hole directly beneath the surface).
                if h > 1 && chunk_get(data, lx, ly, (h - 1) as usize) == 0 {
                    chunk_set(data, lx, ly, (h - 1) as usize, 3);
                }
                chunk_set(data, lx, ly, h as usize, if near_water { 4 } else { 8 }); // beach / grass
            }

            // Fill the column with water up to the standing-water level.
            if water_level >= 0 && (underwater || cfg.flood_caves) {
                let top = (water_level as usize).min(t_height - 1);
                for z in 1..=top {
                    if chunk_get(data, lx, ly, z) == 0 {
                        chunk_set(data, lx, ly, z, 20);
                    }
                }
            }
        }
    }
}

// ── Cross-chunk writer + feature placement ─────────────────────────────────────

struct WorldGen<'a> {
    chunks: &'a mut Vec<Vec<u8>>,
    wc: usize,
    hc: usize,
    t_height: usize,
    water_mask: &'a [bool], // length wc*16 * hc*16; true = column is under standing water
}
impl<'a> WorldGen<'a> {
    #[inline]
    fn in_bounds(&self, wx: i32, wy: i32, z: i32) -> bool {
        wx >= 0 && wy >= 0 && z >= 0
            && (wx as usize) < self.wc * 16
            && (wy as usize) < self.hc * 16
            && (z as usize) < self.t_height
    }
    #[inline]
    fn chunk_index(&self, wx: i32, wy: i32) -> usize {
        let cx = (wx as usize) / 16;
        let cy = (wy as usize) / 16;
        cy * self.wc + cx
    }
    #[inline]
    fn get(&self, wx: i32, wy: i32, z: i32) -> u8 {
        if !self.in_bounds(wx, wy, z) { return 0; }
        let ci = self.chunk_index(wx, wy);
        chunk_get(&self.chunks[ci], (wx as usize) % 16, (wy as usize) % 16, z as usize)
    }
    /// Set a block type, always clearing the paint byte so a new block never
    /// inherits the paint of whatever terrain/feature occupied the cell before.
    #[inline]
    fn set(&mut self, wx: i32, wy: i32, z: i32, bt: u8) {
        if !self.in_bounds(wx, wy, z) { return; }
        let ci = self.chunk_index(wx, wy);
        let (lx, ly) = ((wx as usize) % 16, (wy as usize) % 16);
        chunk_set(&mut self.chunks[ci], lx, ly, z as usize, bt);
        chunk_set_paint(&mut self.chunks[ci], lx, ly, z as usize, 0);
    }
    #[inline]
    fn set_paint(&mut self, wx: i32, wy: i32, z: i32, paint: u8) {
        if !self.in_bounds(wx, wy, z) { return; }
        let ci = self.chunk_index(wx, wy);
        chunk_set_paint(&mut self.chunks[ci], (wx as usize) % 16, (wy as usize) % 16, z as usize, paint);
    }
    /// Place a block only where the cell is currently air.
    #[inline]
    fn set_if_air(&mut self, wx: i32, wy: i32, z: i32, bt: u8) {
        if self.get(wx, wy, z) == 0 { self.set(wx, wy, z, bt); }
    }
    /// True if the column at (wx, wy) lies under standing water (lake/ocean/river).
    #[inline]
    fn column_is_water(&self, wx: i32, wy: i32) -> bool {
        if wx < 0 || wy < 0 { return false; }
        let bw = self.wc * 16;
        let (x, y) = (wx as usize, wy as usize);
        if x >= bw || y >= self.hc * 16 { return false; }
        self.water_mask[y * bw + x]
    }
}

/// A voxel target that procedural feature builders (trees, etc.) can write into.
/// Implemented by `LoadedWorld` (live editor tools) and `WorldGen` (world creation),
/// so the same canopy/structure code serves both.
trait VoxelSink {
    fn put(&mut self, wx: i32, wy: i32, wz: i32, bt: u8, paint: u8);
}
impl VoxelSink for LoadedWorld {
    #[inline]
    fn put(&mut self, wx: i32, wy: i32, wz: i32, bt: u8, paint: u8) {
        set_block_abs(self, wx, wy, wz, bt, paint);
    }
}
impl<'a> VoxelSink for WorldGen<'a> {
    #[inline]
    fn put(&mut self, wx: i32, wy: i32, wz: i32, bt: u8, paint: u8) {
        // Foliage (leaves/trunk/weeds/cactus/flower) must never sit on, in, or
        // overhang water — skip the cell if its column is flooded or it already
        // holds a liquid.
        if matches!(bt, 5 | 6 | 11 | 16 | 73) {
            if self.column_is_water(wx, wy) { return; }
            if matches!(self.get(wx, wy, wz), 15 | 20 | 23 | 59..=64) { return; }
        }
        self.set(wx, wy, wz, bt);
        if paint != 0 { self.set_paint(wx, wy, wz, paint); }
    }
}

fn place_cactus(gen: &mut WorldGen, wx: i32, wy: i32, sz: i32, h: u64) {
    let ch = 2 + (h % 3) as i32;
    for i in 1..=ch {
        if sz + i >= gen.t_height as i32 { break; }
        gen.put(wx, wy, sz + i, 16, 22);
    }
}

fn place_boulder(gen: &mut WorldGen, wx: i32, wy: i32, sz: i32, h: u64) {
    let bt = if h & 1 == 0 { 2 } else { 14 };
    for dz in 1..=2i32 {
        let r = 2 - dz;
        for di in -r..=r {
            for dj in -r..=r {
                if di * di + dj * dj <= r * r && !gen.column_is_water(wx + di, wy + dj) {
                    gen.set(wx + di, wy + dj, sz + dz, bt);
                }
            }
        }
    }
}

fn decorate(gen: &mut WorldGen, heights: &[u16], cfg: &NaturalConfig) {
    let bw = gen.wc * 16;
    let bh = gen.hc * 16;
    for wy in 0..bh as i32 {
        for wx in 0..bw as i32 {
            let surf_z = heights[(wy as usize) * bw + wx as usize] as i32;
            let b = biome_at(wx, wy, surf_z as usize, cfg, gen.t_height); // resolved per-column biome
            let on = gen.get(wx, wy, surf_z);
            let above = gen.get(wx, wy, surf_z + 1);
            if above != 0 { continue; }        // occupied / underwater → never decorate
            if gen.column_is_water(wx, wy) { continue; }

            // Trees & cacti (reuse the editor's natural canopy generators).
            if cfg.tree_density_denom > 0 {
                let h = hash2(wx, wy, cfg.seed ^ 0x7777);
                if on == 8 && h % cfg.tree_density_denom == 0 {
                    // Need vertical headroom for trunk + canopy.
                    if surf_z + 10 < gen.t_height as i32 {
                        let mut rng = Rng64::new(h | 1);
                        if b == 2 {
                            // Snow biome: frosted (white/light-gray) pine canopy.
                            let leaf = SNOW_LEAF_PAINTS[rng.range(0, 1) as usize];
                            place_pine_tree(gen, wx, wy, surf_z + 1, &mut rng, Some(leaf));
                        } else {
                            // Trunks 3–5 logs, varied leaf shade.
                            let trunk_h = rng.range(3, 5);
                            let leaf = NORMAL_LEAF_PAINTS[rng.range(0, 3) as usize];
                            place_normal_tree(gen, wx, wy, surf_z + 1, trunk_h, leaf);
                        }
                    }
                    continue;
                }
                if b == 1 && on == 4 && h % (cfg.tree_density_denom * 2) == 0 {
                    place_cactus(gen, wx, wy, surf_z, h);
                    continue;
                }
            }

            // Ground vegetation.
            if cfg.vegetation > 0 && on == 8 {
                let h = hash2(wx, wy, cfg.seed ^ 0x1234);
                let r = rand01(h);
                let lush = if cfg.vegetation >= 2 { 1.0 } else { 0.45 };
                if r < 0.045 * lush {
                    // Cold flowers (white/blue) in snow, the warm palette elsewhere.
                    let paint = if b == 2 {
                        SNOW_FLOWER_PAINTS[((h >> 8) as usize) % SNOW_FLOWER_PAINTS.len()]
                    } else {
                        FLOWER_PAINTS[((h >> 8) as usize) % FLOWER_PAINTS.len()]
                    };
                    gen.put(wx, wy, surf_z + 1, 73, paint); // flower sprite sits above grass
                } else if r < (0.045 + if rand01(hash2(wx >> 3, wy >> 3, cfg.seed ^ 0x5678)) > 0.5 { 0.45 } else { 0.08 }) * lush {
                    // Weeds (11) are a solid grass variant — replace the surface block
                    // so they sit flush with the grass instead of floating above it.
                    // Painted white in snow so they match the snowy grass.
                    let weed_paint = if b == 2 { 9 } else { 0 };
                    gen.put(wx, wy, surf_z, 11, weed_paint);
                } else if r < 0.114 * lush {
                    place_boulder(gen, wx, wy, surf_z, h);
                }
            }
        }
    }
}

// ── Structures ─────────────────────────────────────────────────────────────────

/// (min, max) surface z over a rectangular footprint, or None if out of bounds.
fn pad_levels(heights: &[u16], bw: usize, bh: usize, x0: i32, y0: i32, w: i32, d: i32) -> Option<(i32, i32)> {
    let (mut mn, mut mx) = (i32::MAX, i32::MIN);
    for yy in y0..y0 + d {
        for xx in x0..x0 + w {
            if xx < 0 || yy < 0 || xx as usize >= bw || yy as usize >= bh { return None; }
            let z = heights[(yy as usize) * bw + xx as usize] as i32;
            mn = mn.min(z); mx = mx.max(z);
        }
    }
    Some((mn, mx))
}

/// Build a solid foundation up to `base_z` and clear terrain/vegetation above it.
fn prep_pad(gen: &mut WorldGen, heights: &[u16], bw: usize, x0: i32, y0: i32, w: i32, d: i32, base_z: i32, floor_bt: u8) {
    for yy in y0..y0 + d {
        for xx in x0..x0 + w {
            if xx < 0 || yy < 0 || xx as usize >= bw || yy as usize >= gen.hc * 16 { continue; }
            let s = heights[(yy as usize) * bw + xx as usize] as i32;
            for z in (s + 1)..=base_z { gen.set(xx, yy, z, floor_bt); }
            for z in (base_z + 1)..(base_z + 9) { gen.set(xx, yy, z, 0); }
        }
    }
}

// Weathered-gray paint shades for masonry (paint 18/27/36 = 80/60/40% gray).
const GRAY_PAINTS: [u8; 3] = [18, 27, 36];

/// Place a brick block tinted a natural weathered gray (so structures read as
/// stone masonry rather than the default red brick). Non-brick blocks pass through.
#[inline]
fn set_brick(gen: &mut WorldGen, x: i32, y: i32, z: i32, gray: u8) {
    gen.set(x, y, z, 13);
    gen.set_paint(x, y, z, gray);
}

fn build_cabin(gen: &mut WorldGen, heights: &[u16], bw: usize, x0: i32, y0: i32, base_z: i32) {
    let (w, d) = (6, 5);
    prep_pad(gen, heights, bw, x0, y0, w, d, base_z, 7);
    let wall_h = 4;
    for yy in y0..y0 + d { for xx in x0..x0 + w { gen.set(xx, yy, base_z, 7); } } // floor
    for z in 1..=wall_h {
        for xx in x0..x0 + w {
            gen.set(xx, y0, base_z + z, 7);
            gen.set(xx, y0 + d - 1, base_z + z, 7);
        }
        for yy in y0..y0 + d {
            gen.set(x0, yy, base_z + z, 7);
            gen.set(x0 + w - 1, yy, base_z + z, 7);
        }
    }
    let dx = x0 + w / 2;
    gen.set(dx, y0, base_z + 1, 66); // door
    gen.set(dx, y0, base_z + 2, 70); // door top
    gen.set(x0, y0 + d / 2, base_z + 2, 58);          // windows
    gen.set(x0 + w - 1, y0 + d / 2, base_z + 2, 58);
    let roof_z = base_z + wall_h + 1;
    for xx in (x0 - 1)..(x0 + w + 1) {
        for yy in (y0 - 1)..(y0 + d + 1) { gen.set(xx, yy, roof_z, 56); }
    }
    for xx in x0..x0 + w {
        for yy in (y0 + 1)..(y0 + d - 1) { gen.set(xx, yy, roof_z + 1, 56); }
    }
    gen.set(x0 + w / 2, y0 + d / 2, base_z + wall_h, 72); // interior light
}

fn build_well(gen: &mut WorldGen, heights: &[u16], bw: usize, x0: i32, y0: i32, base_z: i32, gray: u8) {
    let (w, d) = (3, 3);
    prep_pad(gen, heights, bw, x0, y0, w, d, base_z, 2);
    for yy in y0..y0 + d {
        for xx in x0..x0 + w {
            let edge = xx == x0 || xx == x0 + w - 1 || yy == y0 || yy == y0 + d - 1;
            if edge { set_brick(gen, xx, yy, base_z + 1, gray); }
            else { gen.set(xx, yy, base_z, 20); }
        }
    }
    let posts = [(x0, y0), (x0 + w - 1, y0), (x0, y0 + d - 1), (x0 + w - 1, y0 + d - 1)];
    for (px, py) in posts { for z in 2..=3 { gen.set(px, py, base_z + z, 21); } }
    for yy in y0..y0 + d { for xx in x0..x0 + w { gen.set(xx, yy, base_z + 4, 56); } }
}

fn build_tower(gen: &mut WorldGen, heights: &[u16], bw: usize, x0: i32, y0: i32, base_z: i32, h: u64, gray: u8) {
    let (w, d) = (4, 4);
    prep_pad(gen, heights, bw, x0, y0, w, d, base_z, 13);
    let th = 9 + (h % 5) as i32;
    for z in 1..=th {
        for xx in x0..x0 + w {
            for yy in y0..y0 + d {
                let edge = xx == x0 || xx == x0 + w - 1 || yy == y0 || yy == y0 + d - 1;
                if edge { set_brick(gen, xx, yy, base_z + z, gray); }
                else { gen.set(xx, yy, base_z + z, 0); }
            }
        }
    }
    for xx in x0..x0 + w {
        for yy in y0..y0 + d {
            let edge = xx == x0 || xx == x0 + w - 1 || yy == y0 || yy == y0 + d - 1;
            if edge && ((xx + yy) & 1 == 0) { set_brick(gen, xx, yy, base_z + th + 1, gray); }
        }
    }
    gen.set(x0 + 1, y0 + 1, base_z + th, 72); // beacon light
    gen.set(x0 + w / 2, y0, base_z + 1, 0);   // doorway
    gen.set(x0 + w / 2, y0, base_z + 2, 0);
}

fn build_ruins(gen: &mut WorldGen, x0: i32, y0: i32, base_z: i32, h: u64, mat: u8, gray: u8) {
    let cols = 4 + (h % 4) as i32;
    let mut hh = h;
    let nextr = |hh: &mut u64, m: i32| -> i32 {
        *hh = hh.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*hh >> 33) as usize % m as usize) as i32
    };
    for _ in 0..cols {
        let px = x0 + nextr(&mut hh, 6);
        let py = y0 + nextr(&mut hh, 6);
        let ch = 2 + nextr(&mut hh, 5);
        for z in 1..=ch {
            if mat == 13 { set_brick(gen, px, py, base_z + z, gray); }
            else { gen.set(px, py, base_z + z, mat); }
        }
        if hh & 1 == 0 { gen.set(px, py, base_z + ch + 1, 14); } // slate capstone
    }
    for _ in 0..cols * 2 {
        let px = x0 + nextr(&mut hh, 7);
        let py = y0 + nextr(&mut hh, 7);
        gen.set(px, py, base_z + 1, 14); // slate rubble
    }
}

fn build_pyramid(gen: &mut WorldGen, heights: &[u16], bw: usize, x0: i32, y0: i32, base_z: i32) {
    let size = 9;
    prep_pad(gen, heights, bw, x0, y0, size, size, base_z, 4);
    let layers = size / 2 + 1;
    for l in 0..layers {
        let z = base_z + 1 + l;
        for yy in (y0 + l)..(y0 + size - l) {
            for xx in (x0 + l)..(x0 + size - l) {
                gen.set(xx, yy, z, 4); // natural sand (unpainted)
            }
        }
    }
    let (cx, cy) = (x0 + size / 2, y0 + size / 2);
    gen.set(cx, cy, base_z + 1, 71);                       // hidden treasure
    for dz in 1..=2 { gen.set(cx, cy, base_z + 1 + dz, 0); }
}

fn try_place_structure(gen: &mut WorldGen, heights: &[u16], bw: usize, bh: usize, ax: i32, ay: i32, cfg: &NaturalConfig, h: u64) {
    let fp = 9;
    let (mn, mx) = match pad_levels(heights, bw, bh, ax, ay, fp, fp) { Some(v) => v, None => return };
    if mx - mn > 3 { return; }                              // require flat-ish ground
    if cfg.water_z >= 0 && mn <= cfg.water_z + 1 { return; } // keep clear of standing water
    if river_here(ax as f64 + 4.0, ay as f64 + 4.0, cfg) { return; }

    let cz = heights[(ay as usize + 4) * bw + (ax as usize + 4)] as i32;
    if gen.get(ax + 4, ay + 4, cz) == 0 { return; }

    let base_z = mx;
    let gray = GRAY_PAINTS[(h % 3) as usize];
    let pick = h % 100;
    match cfg.biome {
        1 => { if pick < 45 { build_pyramid(gen, heights, bw, ax, ay, base_z); }
               else { build_ruins(gen, ax, ay, mn, h, 4, gray); } }
        3 => { build_ruins(gen, ax, ay, mn, h, 10, gray); }
        _ => {
            if pick < 30 { build_cabin(gen, heights, bw, ax, ay, base_z); }
            else if pick < 50 { build_well(gen, heights, bw, ax, ay, base_z, gray); }
            else if pick < 72 { build_tower(gen, heights, bw, ax, ay, base_z, h, gray); }
            else { build_ruins(gen, ax, ay, mn, h, 13, gray); }
        }
    }
}

fn place_structures(gen: &mut WorldGen, heights: &[u16], cfg: &NaturalConfig) {
    if cfg.structures == 0 { return; }
    let bw = gen.wc * 16;
    let bh = gen.hc * 16;
    let spacing: i32 = if cfg.structures >= 2 { 44 } else { 76 };
    let prob = if cfg.structures >= 2 { 0.6 } else { 0.42 };
    let mut gy = spacing / 2;
    while gy < bh as i32 {
        let mut gx = spacing / 2;
        while gx < bw as i32 {
            let h = hash2(gx, gy, cfg.seed ^ 0xBEEF);
            if rand01(h) < prob {
                let ax = gx + (((h >> 8) as usize % 11) as i32 - 5);
                let ay = gy + (((h >> 20) as usize % 11) as i32 - 5);
                try_place_structure(gen, heights, bw, bh, ax, ay, cfg, h);
            }
            gx += spacing;
        }
        gy += spacing;
    }
}

fn place_clouds(gen: &mut WorldGen, cfg: &NaturalConfig) {
    if !cfg.clouds { return; }
    let bw = gen.wc * 16;
    let bh = gen.hc * 16;
    let cz = gen.t_height as i32 - 4;
    if cz < 2 { return; }
    let sf = natural_sf(cfg.seed) * 0.5 + 9.0;
    for wy in 0..bh as i32 {
        for wx in 0..bw as i32 {
            let n = fbm2((wx as f64 + sf) / 42.0, (wy as f64 + sf) / 42.0, 3);
            if n > 0.42 {
                gen.set_if_air(wx, wy, cz, 19);
                if n > 0.6 { gen.set_if_air(wx, wy, cz - 1, 19); }
            }
        }
    }
}

/// Biome id for the "Classic Hills" biome: legacy Eden terrain shape (rolling
/// Perlin hills) with the classic holey dirt skin (exposed stone) and classic caves.
const BIOME_CLASSIC: u8 = 4;

/// Map a `NaturalConfig` onto a `ClassicConfig` so the stable classic heightmap /
/// cave / skin routines can drive the Classic Hills biome inside the natural
/// pipeline. Roughness picks the legacy `variance`; caves follow `cave_density`.
fn classic_cfg_for_natural(cfg: &NaturalConfig) -> ClassicConfig {
    ClassicConfig {
        seed: cfg.seed,
        variance: (1.0 + cfg.roughness * 4.0).clamp(1.0, 6.0),
        base_height: cfg.base_height,
        gen_caves: cfg.cave_density > 0,
        tall_caves: false,
        tree_spacing: 0,
        flowers: false,
        clouds: false,
    }
}

/// Whole-world procedural pipeline. Fills `chunks` (row-major cy*wc+cx) and
/// returns the surface z at the world centre (for spawn placement).
fn generate_natural_world(
    chunks: &mut Vec<Vec<u8>>,
    wc: usize, hc: usize,
    cfg: &NaturalConfig,
    t_height: usize,
    progress: &mut dyn FnMut(&str, f32),
) -> usize {
    let bw = wc * 16;
    let bh = hc * 16;

    // Classic-noise generator + derived config, used by the "Classic Hills" biome
    // (legacy heightmap / surface skin) and the classic cave style.
    let classic_noise = ClassicNoise::new(cfg.seed);
    let ccfg = classic_cfg_for_natural(cfg);

    // 1. Global heightmap (single source of truth for cross-chunk features).
    let mut heights = vec![0u16; bw * bh];
    for wy in 0..bh {
        for wx in 0..bw {
            heights[wy * bw + wx] = if cfg.biome == BIOME_CLASSIC {
                let h = classic_height(&classic_noise, wx as f64, wy as f64, &ccfg, t_height) as f64;
                let h = river_carved_height(h, wx as f64, wy as f64, cfg);
                (h.round() as i32).clamp(2, (t_height - 6) as i32) as u16
            } else {
                terrain_height(wx as f64, wy as f64, cfg, t_height) as u16
            };
        }
    }
    progress("Shaping terrain", 0.08);

    // 1b. Water mask — which columns end up under standing water (lake/ocean/river).
    //     Used so vegetation and boulders never sit on or overhang water.
    let mut water_mask = vec![false; bw * bh];
    if cfg.water_z >= 0 || cfg.rivers {
        for wy in 0..bh {
            for wx in 0..bw {
                let surf = heights[wy * bw + wx] as i32;
                let mut wl = cfg.water_z;
                if river_here(wx as f64, wy as f64, cfg) {
                    wl = wl.max(cfg.base_height as i32 - 1);
                }
                if surf <= wl { water_mask[wy * bw + wx] = true; }
            }
        }
    }

    progress("Filling chunks", 0.12);

    // 2. Per-chunk column fill (cache-friendly, continuous noise across borders).
    for cy in 0..hc {
        for cx in 0..wc {
            let ci = cy * wc + cx;
            fill_chunk_terrain(&mut chunks[ci], cx, cy, wc, &heights, cfg, &classic_noise, t_height);
        }
        progress("Filling chunks", 0.12 + 0.68 * ((cy + 1) as f32 / hc as f32));
    }

    // 3. Cross-chunk features (trees, vegetation, structures, clouds).
    {
        let mut gen = WorldGen { chunks, wc, hc, t_height, water_mask: &water_mask };
        decorate(&mut gen, &heights, cfg);
        progress("Planting & decorating", 0.88);
        place_structures(&mut gen, &heights, cfg);
        progress("Building structures", 0.93);
        place_clouds(&mut gen, cfg);
    }
    progress("Finishing", 0.95);

    heights[(bh / 2) * bw + bw / 2] as usize
}

/// Build a throttled progress reporter that emits `world-gen-progress` events
/// (`{ phase, pct }`). Only fires when the rounded percentage advances, so big
/// worlds don't flood the IPC channel. Used by all three world-creation commands.
fn gen_progress_reporter(app: tauri::AppHandle) -> impl FnMut(&str, f32) {
    let mut last = -1i32;
    move |phase: &str, frac: f32| {
        let pct = (frac * 100.0).round().clamp(0.0, 100.0) as i32;
        if pct != last {
            last = pct;
            let _ = app.emit("world-gen-progress", serde_json::json!({ "phase": phase, "pct": pct }));
        }
    }
}

/// Generate a flat world file at `path`.
#[tauri::command]
fn create_world(
    app: tauri::AppHandle,
    path: String,
    name: String,
    width_chunks: u32,
    height_chunks: u32,
    extended_z: bool,
    stone_depth: u8,
    dirt_depth: u8,
) -> Result<(), String> {
    if width_chunks == 0 || height_chunks == 0 { return Err("Dimensions must be at least 1×1 chunk".into()); }
    if width_chunks > 128 || height_chunks > 128 { return Err("Maximum world size is 128×128 chunks (2048×2048 blocks)".into()); }
    let mut report = gen_progress_reporter(app);

    let max_z: u32 = if extended_z { 255 } else { 63 };
    let surface_z: u32 = 1 + stone_depth as u32 + dirt_depth as u32;
    if surface_z > max_z {
        return Err(format!("Layer depths too large: surface would be at z={surface_z} but max z={max_z}"));
    }

    let chunk_size = if extended_z { 131_072usize } else { 32_768usize };
    let n_chunks   = (width_chunks * height_chunks) as usize;

    const CENTER_CHUNK: i32 = 4096;
    let start_cx = CENTER_CHUNK;
    let start_cy = CENTER_CHUNK;

    let mut chunks: Vec<Vec<u8>> = Vec::with_capacity(n_chunks);
    for cy in 0..height_chunks {
        for _cx in 0..width_chunks {
            let mut data = vec![0u8; chunk_size];
            let set = |d: &mut Vec<u8>, z: u32, bt: u8| {
                let band = (z as usize) / 16;
                let z_in = (z as usize) % 16;
                for lx in 0..16usize {
                    for ly in 0..16usize {
                        let bi = band * 8192 + lx * 256 + ly * 16 + z_in;
                        if bi < d.len() { d[bi] = bt; }
                    }
                }
            };
            set(&mut data, 0, 1);
            for z in 1..=stone_depth as u32 { set(&mut data, z, 2); }
            for z in (1 + stone_depth as u32)..(1 + stone_depth as u32 + dirt_depth as u32) { set(&mut data, z, 3); }
            set(&mut data, surface_z, 8);
            chunks.push(data);
        }
        report("Filling chunks", 0.90 * ((cy + 1) as f32 / height_chunks as f32));
    }

    report("Writing file", 0.95);
    let res = write_world_file(&path, &name, width_chunks, height_chunks, chunk_size, start_cx, start_cy, surface_z, &chunks);
    report("Done", 1.0);
    res
}

/// Build a `NaturalConfig` (and resolve `t_height`) from the raw GUI parameters.
/// Shared by `create_natural_world` and `preview_natural_world` so the two never
/// drift apart.
#[allow(clippy::too_many_arguments)]
fn natural_config_from_params(
    extended_z: bool, seed: u32, base_height: u32,
    roughness_level: u32, erosion_level: u32, terrain_scale_level: u32, extreme: bool,
    water_mode: &str, rivers: bool,
    biome: &str, biome_mode: u32, biome_scale_level: u32, snow_caps: bool,
    tree_density: u32, cave_density: u32, cave_style: u32, caverns: bool, flood_caves: bool,
    ore_density: u32, vegetation: u32, structures: u32, clouds: bool,
) -> (NaturalConfig, usize) {
    let t_height = (if extended_z { 255u32 } else { 63 } + 1) as usize;
    let base_h = (base_height as usize).min(t_height - 10).max(5);
    let roughness = match roughness_level { 0 => 0.0f64, 1 => 0.30, 2 => 0.55, 3 => 0.80, _ => 1.05 };
    let erosion = match erosion_level { 0 => 0.0f64, 1 => 0.45, 2 => 0.75, _ => 1.0 };
    let terrain_scale = match terrain_scale_level { 0 => 70.0f64, 1 => 120.0, 2 => 190.0, _ => 300.0 };
    let mut water_z: i32 = match water_mode {
        "ponds" => base_h as i32 - 8,
        "lakes" => base_h as i32 - 4,
        "ocean" => base_h as i32 - 1,
        _       => -1,
    };
    water_z = water_z.max(-1);
    let biome_id: u8 = match biome { "desert" => 1, "snow" => 2, "lava" => 3, "classic" => 4, _ => 0 };
    let tree_density_denom: u64 = match tree_density { 0 => 0, 1 => 80, 2 => 40, _ => 20 };
    let biome_scale = match biome_scale_level { 0 => 110.0f64, 1 => 200.0, _ => 340.0 };
    let extreme = extreme && extended_z;
    // Mixed mode blends grass/desert/snow only; lava & classic stay single-mode.
    let biome_mode = if biome_id == 4 { 0 } else { biome_mode };
    (NaturalConfig {
        seed, base_height: base_h, roughness, erosion, terrain_scale, extreme, water_z, rivers,
        biome: biome_id, biome_mode, biome_scale, snow_caps,
        tree_density_denom, cave_density, cave_style, caverns, flood_caves,
        ore_density, vegetation, structures, clouds,
    }, t_height)
}

#[derive(Serialize)]
struct PreviewImage {
    width: u32,
    height: u32,
    #[serde(serialize_with = "serialize_bytes_b64")]
    pixels: Vec<u8>, // RGBA, row-major (alpha always 255)
}

/// Fast top-down preview of a natural world: samples the heightmap, biome and
/// surface colour on a downsampled grid (no chunk fill, caves or decoration) and
/// applies a light height/slope hillshade. Lets the New World dialog show the
/// terrain before committing to a full generate + file write.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn preview_natural_world(
    width_chunks: u32, height_chunks: u32, extended_z: bool,
    seed: u32, base_height: u32, roughness_level: u32, erosion_level: u32, terrain_scale_level: u32, extreme: bool,
    water_mode: String, rivers: bool,
    biome: String, biome_mode: u32, biome_scale_level: u32, snow_caps: bool,
    tree_density: u32, cave_density: u32, cave_style: u32, caverns: bool, flood_caves: bool,
    ore_density: u32, vegetation: u32, structures: u32, clouds: bool,
    max_px: u32,
) -> Result<PreviewImage, String> {
    if width_chunks == 0 || height_chunks == 0 { return Err("Dimensions must be at least 1×1 chunk".into()); }
    let (cfg, t_height) = natural_config_from_params(
        extended_z, seed, base_height, roughness_level, erosion_level, terrain_scale_level, extreme,
        &water_mode, rivers, &biome, biome_mode, biome_scale_level, snow_caps,
        tree_density, cave_density, cave_style, caverns, flood_caves, ore_density, vegetation, structures, clouds,
    );
    let bw = (width_chunks * 16) as i32;
    let bh = (height_chunks * 16) as i32;
    let cap = max_px.clamp(32, 512) as i32;
    let step = ((bw.max(bh) + cap - 1) / cap).max(1);
    let pw = ((bw + step - 1) / step).max(1);
    let ph = ((bh + step - 1) / step).max(1);

    let classic_noise = ClassicNoise::new(cfg.seed);
    let ccfg = classic_cfg_for_natural(&cfg);
    let is_classic = cfg.biome_mode == 0 && cfg.biome == BIOME_CLASSIC;
    let snowline = cfg.base_height as f64 + (t_height as f64) * relief_factor(&cfg) * 0.60;
    let sky = 14u8;

    // First pass: surface heights for the sample grid (for water test + hillshade).
    let surf_at = |wx: i32, wy: i32| -> i32 {
        if is_classic {
            let h = classic_height(&classic_noise, wx as f64, wy as f64, &ccfg, t_height) as f64;
            (river_carved_height(h, wx as f64, wy as f64, &cfg).round() as i32).clamp(2, (t_height - 6) as i32)
        } else {
            terrain_height(wx as f64, wy as f64, &cfg, t_height)
        }
    };

    let mut pixels = vec![0u8; (pw * ph * 4) as usize];
    for py in 0..ph {
        for pxi in 0..pw {
            let wx = (pxi * step).min(bw - 1);
            let wy = (py * step).min(bh - 1);
            let surf = surf_at(wx, wy);

            // Standing water for this column.
            let mut wl = cfg.water_z;
            if river_here(wx as f64, wy as f64, &cfg) { wl = wl.max(cfg.base_height as i32 - 1); }

            let mut rgb = if surf <= wl {
                // Frozen in snow regions, else water/lava.
                let b = biome_at(wx, wy, surf as usize, &cfg, t_height);
                let fill = match b { 2 => 15u8, 3 => 23, _ => 20 };
                block_color(fill, 0, sky)
            } else {
                let b = biome_at(wx, wy, surf as usize, &cfg, t_height);
                // Cliff (steep) → bare rock, matching the generator.
                let mut maxd = 0;
                for (dx, dy) in [(-step, 0), (step, 0), (0, -step), (0, step)] {
                    let (nx, ny) = (wx + dx, wy + dy);
                    if nx < 0 || ny < 0 || nx >= bw || ny >= bh { continue; }
                    maxd = maxd.max((surf - surf_at(nx, ny)).abs());
                }
                // Slope is measured over `step` blocks here, so scale the threshold.
                if maxd >= CLIFF_SLOPE * step.max(1) {
                    block_color(2, 0, sky)
                } else if is_classic {
                    if classic_biome_rocky(&classic_noise, wx, wy, surf, cfg.seed as f64) {
                        block_color(2, 0, sky) // rock outcrop
                    } else {
                        grass_color(sky)
                    }
                } else {
                    let (bt, paint) = surface_block(b, &cfg, surf as usize, snowline, surf <= wl + 2, wx, wy);
                    block_color(bt, paint, sky)
                }
            };

            // Hillshade: brighten high ground, darken low, for readable relief.
            let span = (t_height as f64).max(1.0);
            let t = ((surf as f64 - cfg.base_height as f64) / (span * 0.5)).clamp(-0.6, 0.6);
            let shade = 1.0 + t * 0.45;
            for c in rgb.iter_mut() { *c = (*c as f64 * shade).clamp(0.0, 255.0) as u8; }

            let idx = ((py * pw + pxi) * 4) as usize;
            pixels[idx] = rgb[0];
            pixels[idx + 1] = rgb[1];
            pixels[idx + 2] = rgb[2];
            pixels[idx + 3] = 255;
        }
    }

    Ok(PreviewImage { width: pw as u32, height: ph as u32, pixels })
}

/// Generate a procedural natural world file at `path`.
#[tauri::command]
fn create_natural_world(
    app: tauri::AppHandle,
    path: String,
    name: String,
    width_chunks: u32,
    height_chunks: u32,
    extended_z: bool,
    seed: u32,
    base_height: u32,
    roughness_level: u32,     // 0=plains 1=rolling 2=hilly 3=rugged 4=jagged
    erosion_level: u32,       // 0=none 1=light 2=medium 3=strong (flattens high-erosion regions)
    terrain_scale_level: u32, // 0=small 1=medium 2=large 3=huge feature size
    extreme: bool,            // 256z only: towering mountain relief
    water_mode: String,       // "none"|"ponds"|"lakes"|"ocean"
    rivers: bool,
    biome: String,            // single-mode biome: "grassland"|"desert"|"snow"|"lava"|"classic"
    biome_mode: u32,          // 0=single 1=mixed (climate blend of grass/desert/snow)
    biome_scale_level: u32,   // 0=small 1=medium 2=large biome regions (mixed mode)
    snow_caps: bool,
    tree_density: u32,        // 0=none 1=sparse 2=normal 3=dense
    cave_density: u32,        // 0=none 1=rare 2=common
    cave_style: u32,          // 0=tunnels 1=classic 3D-noise caves
    caverns: bool,
    flood_caves: bool,        // false=dry caves (default); true=flood caves below water_z
    ore_density: u32,         // 0=none 1=sparse 2=rich
    vegetation: u32,          // 0=none 1=light 2=lush
    structures: u32,          // 0=none 1=sparse 2=common
    clouds: bool,
) -> Result<(), String> {
    if width_chunks == 0 || height_chunks == 0 { return Err("Dimensions must be at least 1×1 chunk".into()); }
    if width_chunks > 128 || height_chunks > 128 { return Err("Maximum world size is 128×128 chunks (2048×2048 blocks)".into()); }

    let chunk_size = if extended_z { 131_072usize } else { 32_768usize };
    let n_chunks = (width_chunks * height_chunks) as usize;

    let (cfg, t_height) = natural_config_from_params(
        extended_z, seed, base_height, roughness_level, erosion_level, terrain_scale_level, extreme,
        &water_mode, rivers, &biome, biome_mode, biome_scale_level, snow_caps,
        tree_density, cave_density, cave_style, caverns, flood_caves, ore_density, vegetation, structures, clouds,
    );

    const CENTER_CHUNK: i32 = 4096;
    let start_cx = CENTER_CHUNK;
    let start_cy = CENTER_CHUNK;

    let mut chunks: Vec<Vec<u8>> = Vec::with_capacity(n_chunks);
    for _ in 0..n_chunks { chunks.push(vec![0u8; chunk_size]); }

    let mut report = gen_progress_reporter(app);
    let center_surface_z =
        generate_natural_world(&mut chunks, width_chunks as usize, height_chunks as usize, &cfg, t_height, &mut report) as u32;

    report("Writing file", 0.97);
    let res = write_world_file(&path, &name, width_chunks, height_chunks, chunk_size, start_cx, start_cy, center_surface_z, &chunks);
    report("Done", 1.0);
    res
}

// ── Classic terrain (legacy Eden procedural generator) ─────────────────────────
// Faithful port of the old randomly-seeded generator from
// ~/EdenWorldBuilder/Classes/TerrainGenerator.mm (the procedural path at lines
// 347–545, dead code in the shipping game). Block IDs are identical between the
// legacy engine and this editor, so no remapping is needed.

struct ClassicConfig {
    seed: u32,
    variance: f64,      // legacy heightmap `var` (default 3 = how dramatic the relief is)
    base_height: usize, // legacy `offsety` (heightmap baseline; default t_height/2)
    gen_caves: bool,    // legacy `genCaves`: 3D-noise cave carving
    tall_caves: bool,   // early-Eden style: taller, vertically-stretched caves with variegated walls
    tree_spacing: u64,  // legacy TREE_SPACING (1-in-N grass columns); 0 = no trees
    flowers: bool,      // sparse surface flowers (too many crash the modern game's sprite loader)
    clouds: bool,       // legacy generateCloud pass
}

// Place a flower on roughly 1-in-N exposed grass cells. The modern game crashes
// when a world contains too many flower sprites, so classic keeps them sparse.
const CLASSIC_FLOWER_SPARSITY: u64 = 64;

// Leaf paint bytes from the legacy placeTree (`ct[4] = {0,19,20,21}`).
const CLASSIC_LEAF_PAINTS: [u8; 4] = [0, 19, 20, 21];

/// Seeded port of the classic Perlin gradient noise (`noise2`/`noise3` + `init`,
/// TerrainGenerator.mm 636–881). The gradient tables and permutation are filled
/// from a seeded `Rng64` (instead of libc `random()`) so output is deterministic
/// per world seed.
struct ClassicNoise {
    p:  [usize; 514],
    g2: [[f64; 2]; 514],
    g3: [[f64; 3]; 514],
}
impl ClassicNoise {
    #[inline] fn sc(t: f64) -> f64 { t * t * (3.0 - 2.0 * t) }      // s_curve
    #[inline] fn lp(t: f64, a: f64, b: f64) -> f64 { a + t * (b - a) } // lerp

    fn new(seed: u32) -> Self {
        let mut rng = Rng64::new(seed as u64 ^ 0x51ED_C0DE_1234_5678);
        let grad = |rng: &mut Rng64| ((rng.next() % 512) as f64 - 256.0) / 256.0; // [-1, 1)
        let mut p  = [0usize; 514];
        let mut g2 = [[0.0f64; 2]; 514];
        let mut g3 = [[0.0f64; 3]; 514];
        for i in 0..256usize {
            p[i] = i;
            let mut v2 = [grad(&mut rng), grad(&mut rng)];
            let s2 = (v2[0] * v2[0] + v2[1] * v2[1]).sqrt();
            if s2 > 0.0 { v2[0] /= s2; v2[1] /= s2; }
            g2[i] = v2;
            let mut v3 = [grad(&mut rng), grad(&mut rng), grad(&mut rng)];
            let s3 = (v3[0] * v3[0] + v3[1] * v3[1] + v3[2] * v3[2]).sqrt();
            if s3 > 0.0 { v3[0] /= s3; v3[1] /= s3; v3[2] /= s3; }
            g3[i] = v3;
        }
        // Shuffle the permutation (legacy `while(--i)` from 255 down to 1).
        let mut i = 255usize;
        while i >= 1 {
            let k = p[i];
            let j = (rng.next() % 256) as usize;
            p[i] = p[j];
            p[j] = k;
            i -= 1;
        }
        // Wrap-around duplicate so neighbour lookups never index out of range.
        for i in 0..258usize {
            p[256 + i]  = p[i];
            g2[256 + i] = g2[i];
            g3[256 + i] = g3[i];
        }
        ClassicNoise { p, g2, g3 }
    }

    #[inline]
    fn setup(v: f64) -> (usize, usize, f64, f64) {
        const N: f64 = 4096.0;       // bias keeps the truncation positive
        let t = v + N;
        let it = t as i64;           // v is always positive here, so trunc == floor
        let b0 = (it as usize) & 0xff;
        let b1 = (b0 + 1) & 0xff;
        let r0 = t - it as f64;
        (b0, b1, r0, r0 - 1.0)
    }

    fn noise2(&self, x: f64, y: f64) -> f64 {
        let (bx0, bx1, rx0, rx1) = Self::setup(x);
        let (by0, by1, ry0, ry1) = Self::setup(y);
        let i = self.p[bx0];
        let j = self.p[bx1];
        let b00 = self.p[i + by0];
        let b10 = self.p[j + by0];
        let b01 = self.p[i + by1];
        let b11 = self.p[j + by1];
        let sx = Self::sc(rx0);
        let sy = Self::sc(ry0);
        let at2 = |q: &[f64; 2], rx: f64, ry: f64| rx * q[0] + ry * q[1];
        let a = Self::lp(sx, at2(&self.g2[b00], rx0, ry0), at2(&self.g2[b10], rx1, ry0));
        let b = Self::lp(sx, at2(&self.g2[b01], rx0, ry1), at2(&self.g2[b11], rx1, ry1));
        Self::lp(sy, a, b)
    }

    fn noise3(&self, x: f64, y: f64, z: f64) -> f64 {
        let (bx0, bx1, rx0, rx1) = Self::setup(x);
        let (by0, by1, ry0, ry1) = Self::setup(y);
        let (bz0, bz1, rz0, rz1) = Self::setup(z);
        let i = self.p[bx0];
        let j = self.p[bx1];
        let b00 = self.p[i + by0];
        let b10 = self.p[j + by0];
        let b01 = self.p[i + by1];
        let b11 = self.p[j + by1];
        let t  = Self::sc(rx0);
        let sy = Self::sc(ry0);
        let sz = Self::sc(rz0);
        let at3 = |q: &[f64; 3], rx: f64, ry: f64, rz: f64| rx * q[0] + ry * q[1] + rz * q[2];
        let a = Self::lp(t, at3(&self.g3[b00 + bz0], rx0, ry0, rz0), at3(&self.g3[b10 + bz0], rx1, ry0, rz0));
        let b = Self::lp(t, at3(&self.g3[b01 + bz0], rx0, ry1, rz0), at3(&self.g3[b11 + bz0], rx1, ry1, rz0));
        let c = Self::lp(sy, a, b);
        let a = Self::lp(t, at3(&self.g3[b00 + bz1], rx0, ry0, rz1), at3(&self.g3[b10 + bz1], rx1, ry0, rz1));
        let b = Self::lp(t, at3(&self.g3[b01 + bz1], rx0, ry1, rz1), at3(&self.g3[b11 + bz1], rx1, ry1, rz1));
        let d = Self::lp(sy, a, b);
        Self::lp(sz, c, d)
    }
}

/// Legacy 10-octave heightmap. `base_height`/`amplitude` are scaled by
/// `t_height/64` so the original 64z relief fills taller (256z) worlds too.
fn classic_height(noise: &ClassicNoise, wx: f64, wy: f64, cfg: &ClassicConfig, t_height: usize) -> usize {
    let s = t_height as f64 / 64.0;
    let seed = cfg.seed as f64;
    let mut n = cfg.base_height as f64;
    let mut freq = 2.0f64;
    let mut amp = 4.0 * s;
    for _ in 0..10 {
        n += noise.noise2(freq * (wx + seed) / 128.0, freq * (wy + seed) / 128.0) * amp * cfg.variance;
        freq *= 2.0;
        amp /= 2.0;
    }
    (n.round() as i64).clamp(3, t_height as i64 - 2) as usize
}

/// Classic deep-cave cell (legacy FREQ3=4, amp 0.25, 3 octaves). `y_scale` < 1
/// stretches chambers vertically (tall-cave style). Returns 0 = open air,
/// 10 = dark-stone vein lining (where the noise is barely positive), else 2 = stone.
#[inline]
fn classic_cave_block(noise: &ClassicNoise, wx: i32, wy: i32, y: i32, y_scale: f64, seed: f64) -> u8 {
    let mut n3 = 0.0f64;
    let mut f3 = 4.0f64;
    let mut a3 = 0.25f64;
    for _ in 0..3 {
        n3 += noise.noise3(
            f3 * (wx as f64 + seed) / 128.0,
            f3 * (wy as f64 + seed) / 128.0,
            f3 * (y  as f64 + seed) * y_scale / 128.0,
        ) * a3;
        f3 *= 2.0; a3 /= 2.0;
    }
    if n3 > 0.0 { if n3 <= 0.01 { 10 } else { 2 } } else { 0 }
}

/// Classic surface-skin cell (legacy FREQ3=3, amp 0.5, 3 octaves): dirt (3) where
/// the noise is below 0.07, else air — the bumpy, overhung dirt skin that leaves
/// exposed stone underneath.
#[inline]
fn classic_skin_block(noise: &ClassicNoise, wx: i32, wy: i32, y: i32, seed: f64) -> u8 {
    let mut n3 = 0.0f64;
    let mut f3 = 3.0f64;
    let mut a3 = 0.5f64;
    for _ in 0..3 {
        n3 += noise.noise3(
            f3 * (wx as f64 + seed) / 128.0,
            f3 * (wy as f64 + seed) / 128.0,
            f3 * (y  as f64 + seed) / 128.0,
        ) * a3;
        f3 *= 2.0; a3 /= 2.0;
    }
    if n3 < 0.07 { 3 } else { 0 }
}

/// Per-column body fill: bedrock, stone, dark-stone & dirt skin, with optional
/// 3D-noise caves (faithful legacy generateColumn 347–439). Depth constants scale
/// with world height so the cave band keeps its proportions on 256z worlds.
///
/// `tall_caves` revives an early-Eden style the game later dropped: the same
/// stone / dark-stone caves, but the band reaches much higher and the noise is
/// stretched vertically (`y_scale`) so the chambers are taller.
fn fill_classic_chunk(
    data: &mut [u8],
    cx: usize, cy: usize, wc: usize,
    heights: &[u16],
    cfg: &ClassicConfig,
    noise: &ClassicNoise,
    t_height: usize,
) {
    let bw = wc * 16;
    let s = t_height as f64 / 64.0;
    let skin = (6.0 * s).round() as i32;          // legacy FORMATION = h - 6 (dirt skin)
    // Legacy caves sit ~16 below the dirt skin and are shallow; tall caves reach
    // to ~4 below it and are vertically stretched (y_scale < 1 → taller chambers).
    let cave_margin = if cfg.tall_caves { (4.0 * s).round() as i32 } else { (16.0 * s).round() as i32 };
    let y_scale = if cfg.tall_caves { 0.5f64 } else { 1.0 };
    let seed = cfg.seed as f64;
    for lx in 0..16usize {
        for ly in 0..16usize {
            let wx = (cx * 16 + lx) as i32;
            let wy = (cy * 16 + ly) as i32;
            let h = heights[(wy as usize) * bw + wx as usize] as i32;
            chunk_set(data, lx, ly, 0, 1); // bedrock
            let formation = h - skin;
            for y in 1..h {
                let bt: u8 = if y < formation {
                    if cfg.gen_caves && y > (h % 2 + 1) && y < formation - cave_margin {
                        classic_cave_block(noise, wx, wy, y, y_scale, seed)
                    } else {
                        2
                    }
                } else {
                    // Surface skin: legacy 3D noise leaves dirt patches & overhangs.
                    classic_skin_block(noise, wx, wy, y, seed)
                };
                if bt != 0 { chunk_set(data, lx, ly, y as usize, bt); }
            }
        }
    }
}

/// Surface decoration (legacy generateColumn 462–489): turn every exposed dirt
/// surface (air-over-dirt) into a mix of grass (8) and tall grass / weeds (11),
/// and optionally drop a *sparse* scattering of the modern flower (block 73) on
/// top. The legacy code also carpeted the surface in flowers, but the modern
/// game crashes when a world holds too many flower sprites, so flowers are kept
/// rare; weeds (a solid grass variant) are fine at the legacy density.
fn classic_decorate(gen: &mut WorldGen, heights: &[u16], cfg: &ClassicConfig, rng: &mut Rng64) {
    let bw = gen.wc * 16;
    let bh = gen.hc * 16;
    let t = gen.t_height as i32;
    let s = gen.t_height as f64 / 64.0;
    let skin = (6.0 * s).round() as i32;
    for wy in 0..bh as i32 {
        for wx in 0..bw as i32 {
            let h = heights[(wy as usize) * bw + wx as usize] as i32;
            let lo = (h - skin - 4).max(1);
            let hi = (h + 1).min(t - 1);
            for y in lo..=hi {
                if gen.get(wx, wy, y) == 0 && gen.get(wx, wy, y - 1) == 3 {
                    let r = rng.next();
                    let want_flower = cfg.flowers && r % CLASSIC_FLOWER_SPARSITY == 0;
                    // ~40% tall grass / weeds (≤ 50% of the surface), rest plain
                    // grass; flowers always stand on plain grass.
                    let base: u8 = if !want_flower && (r >> 20) % 5 < 2 { 11 } else { 8 };
                    gen.set(wx, wy, y - 1, base);
                    if want_flower {
                        let paint = FLOWER_PAINTS[((r >> 8) as usize) % FLOWER_PAINTS.len()];
                        gen.set(wx, wy, y, 73); // sparse flower on top
                        gen.set_paint(wx, wy, y, paint);
                    }
                }
            }
        }
    }
}

/// Legacy placeTree (TerrainGenerator.mm 572–629). `y` is the cell directly above
/// the ground. Trees are placed only on grass (8) or tall grass / weeds (11).
fn place_classic_tree(gen: &mut WorldGen, x: i32, z: i32, y: i32, rng: &mut Rng64) {
    let t = gen.t_height as i32;
    let tree_height = (rng.next() % 3) as i32 + 6; // 6..8
    if y + tree_height >= t { return; }
    // Clearance: 3×3 footprint must stand on grass/weeds with empty space above.
    for i in (x - 1)..=(x + 1) {
        for j in (z - 1)..=(z + 1) {
            let g = gen.get(i, j, y - 1);
            if !(g == 8 || g == 11) { return; }
            if gen.get(i, j, y) != 0 { return; }
        }
    }
    let trunk = 3 * tree_height / 4;
    for i in 0..trunk { gen.set(x, z, y + i, 6); }
    let color = CLASSIC_LEAF_PAINTS[(rng.next() % 4) as usize];
    let k0 = y + 2 * tree_height / 3;
    let k1 = y + tree_height;
    for i in (x - 2)..=(x + 2) {
        for j in (z - 2)..=(z + 2) {
            for k in k0..k1 {
                if gen.get(i, j, k) == 6 { continue; }
                let edge = i == x - 2 || i == x + 2 || j == z - 2 || j == z + 2;
                if edge {
                    let corner = (i == x - 2 || i == x + 2) && (j == z - 2 || j == z + 2);
                    if corner && (k == k0 || k == k1 - 1) { continue; } // trim canopy corners
                    if rng.next() % 2 != 0 { continue; }
                }
                gen.set(i, j, k, 5);
                gen.set_paint(i, j, k, color);
            }
        }
    }
}

fn classic_place_trees(gen: &mut WorldGen, heights: &[u16], cfg: &ClassicConfig, rng: &mut Rng64) {
    if cfg.tree_spacing == 0 { return; }
    let bw = gen.wc * 16;
    let bh = gen.hc * 16;
    let t = gen.t_height as i32;
    for wy in 0..bh as i32 {
        for wx in 0..bw as i32 {
            if rng.next() % cfg.tree_spacing != 0 { continue; }
            let h = heights[(wy as usize) * bw + wx as usize] as i32;
            // Find the highest grass / weeds block near the surface.
            let top = (h + 1).min(t - 1);
            let lo  = (h - 10).max(1);
            let mut ground = -1;
            for z in (lo..=top).rev() {
                let b = gen.get(wx, wy, z);
                if b == 8 || b == 11 { ground = z; break; }
            }
            if ground < 0 { continue; }
            place_classic_tree(gen, wx, wy, ground + 1, rng);
        }
    }
}

/// Legacy generateCloud (TerrainGenerator.mm 529–545): per chunk column, a 1-in-5
/// chance to scatter a few flat cloud blobs near the top of the world.
fn place_classic_clouds(gen: &mut WorldGen, cfg: &ClassicConfig, rng: &mut Rng64) {
    if !cfg.clouds { return; }
    let t = gen.t_height as i32;
    for cy in 0..gen.hc {
        for cx in 0..gen.wc {
            if rng.next() % 5 != 0 { continue; }
            let num = (rng.next() % 4) + 4; // 4..7 blobs
            for _ in 0..num {
                let x  = (rng.next() % 7) as i32;
                let yy = (rng.next() % 7) as i32;
                let w = ((rng.next() % (16 - x  as u64)) as i32).max(4);
                let hh = ((rng.next() % (16 - yy as u64)) as i32).max(4);
                let d = (rng.next() % 2) as i32 + 2; // legacy cloud band: t-2 / t-3
                let cz = t - d;
                for i in 0..w {
                    for j in 0..hh {
                        let bx = (cx as i32) * 16 + x + i;
                        let by = (cy as i32) * 16 + yy + j;
                        gen.set_if_air(bx, by, cz, 19);
                    }
                }
            }
        }
    }
}

/// Whole-world classic pipeline. Fills `chunks` (row-major cy*wc+cx) and returns
/// the surface z at the world centre (for spawn placement).
fn generate_classic_world(
    chunks: &mut Vec<Vec<u8>>,
    wc: usize, hc: usize,
    cfg: &ClassicConfig,
    t_height: usize,
    progress: &mut dyn FnMut(&str, f32),
) -> usize {
    let bw = wc * 16;
    let bh = hc * 16;
    let noise = ClassicNoise::new(cfg.seed);

    let mut heights = vec![0u16; bw * bh];
    for wy in 0..bh {
        for wx in 0..bw {
            heights[wy * bw + wx] = classic_height(&noise, wx as f64, wy as f64, cfg, t_height) as u16;
        }
    }
    progress("Shaping terrain", 0.10);

    for cy in 0..hc {
        for cx in 0..wc {
            let ci = cy * wc + cx;
            fill_classic_chunk(&mut chunks[ci], cx, cy, wc, &heights, cfg, &noise, t_height);
        }
        progress("Filling chunks", 0.10 + 0.70 * ((cy + 1) as f32 / hc as f32));
    }

    let water_mask = vec![false; bw * bh]; // classic terrain has no standing water
    {
        let mut gen = WorldGen { chunks, wc, hc, t_height, water_mask: &water_mask };
        let mut rng = Rng64::new(cfg.seed as u64 ^ 0xC1A5_51C0_0DEF_ACED);
        classic_decorate(&mut gen, &heights, cfg, &mut rng);
        classic_place_trees(&mut gen, &heights, cfg, &mut rng);
        place_classic_clouds(&mut gen, cfg, &mut rng);
    }
    progress("Finishing", 0.95);

    heights[(bh / 2) * bw + bw / 2] as usize
}

/// Generate a classic (legacy procedural) world file at `path`.
#[tauri::command]
fn create_classic_world(
    app: tauri::AppHandle,
    path: String,
    name: String,
    width_chunks: u32,
    height_chunks: u32,
    extended_z: bool,
    seed: u32,
    variance_level: u32, // 0=plains 1=rolling 2=classic 3=rugged 4=wild
    base_height: u32,    // 0 = default to t_height/2
    caves: bool,
    tall_caves: bool,    // taller, vertically-stretched caves with variegated walls
    tree_density: u32,   // 0=none 1=sparse 2=normal 3=dense
    flowers: bool,       // sparse flowers
    clouds: bool,
) -> Result<(), String> {
    let mut report = gen_progress_reporter(app);
    create_classic_world_inner(
        path, name, width_chunks, height_chunks, extended_z, seed,
        variance_level, base_height, caves, tall_caves, tree_density, flowers, clouds,
        &mut report,
    )
}

/// Reporter-driven core of `create_classic_world` (callable from tests without an
/// `AppHandle`).
fn create_classic_world_inner(
    path: String,
    name: String,
    width_chunks: u32,
    height_chunks: u32,
    extended_z: bool,
    seed: u32,
    variance_level: u32,
    base_height: u32,
    caves: bool,
    tall_caves: bool,
    tree_density: u32,
    flowers: bool,
    clouds: bool,
    report: &mut dyn FnMut(&str, f32),
) -> Result<(), String> {
    if width_chunks == 0 || height_chunks == 0 { return Err("Dimensions must be at least 1×1 chunk".into()); }
    if width_chunks > 128 || height_chunks > 128 { return Err("Maximum world size is 128×128 chunks (2048×2048 blocks)".into()); }

    let max_z: u32 = if extended_z { 255 } else { 63 };
    let t_height = (max_z + 1) as usize;
    let chunk_size = if extended_z { 131_072usize } else { 32_768usize };
    let n_chunks = (width_chunks * height_chunks) as usize;

    let variance = match variance_level { 0 => 1.0f64, 1 => 2.0, 2 => 3.0, 3 => 4.5, _ => 6.0 };
    let base_h = if base_height == 0 { t_height / 2 } else { (base_height as usize).min(t_height - 4).max(5) };
    let tree_spacing: u64 = match tree_density { 0 => 0, 1 => 80, 2 => 50, _ => 25 };

    let cfg = ClassicConfig {
        seed, variance, base_height: base_h,
        gen_caves: caves, tall_caves: tall_caves && caves,
        tree_spacing, flowers, clouds,
    };

    const CENTER_CHUNK: i32 = 4096;
    let start_cx = CENTER_CHUNK;
    let start_cy = CENTER_CHUNK;

    let mut chunks: Vec<Vec<u8>> = Vec::with_capacity(n_chunks);
    for _ in 0..n_chunks { chunks.push(vec![0u8; chunk_size]); }

    let center_surface_z =
        generate_classic_world(&mut chunks, width_chunks as usize, height_chunks as usize, &cfg, t_height, report) as u32;

    report("Writing file", 0.97);
    let res = write_world_file(&path, &name, width_chunks, height_chunks, chunk_size, start_cx, start_cy, center_surface_z, &chunks);
    report("Done", 1.0);
    res
}

fn write_world_file(
    path: &str, name: &str,
    width_chunks: u32, height_chunks: u32,
    chunk_size: usize,
    start_cx: i32, start_cy: i32,
    surface_z: u32,
    chunks: &[Vec<u8>],
) -> Result<(), String> {
    use std::io::Write;
    let n_chunks = chunks.len();
    let ptr_table_offset = 192 + chunk_size * n_chunks;
    // Chunk data offsets and the directory pointer are stored as u32 in the file
    // format, so the whole chunk region must fit under 4 GiB. Guard against a
    // silently-corrupt file (the dialog caps dimensions, but be defensive).
    if ptr_table_offset > u32::MAX as usize {
        return Err(format!(
            "World too large: {n_chunks} chunks × {chunk_size} B exceed the 4 GB file-offset limit. Use a smaller size or the 64z format."
        ));
    }
    let mut header = vec![0u8; 192];
    header[32..36].copy_from_slice(&(ptr_table_offset as u32).to_le_bytes());
    let nb = name.as_bytes().len().min(35);
    header[40..40 + nb].copy_from_slice(&name.as_bytes()[..nb]);
    // version field at offset 92 (int, LE). Must be 1–1000 or the game applies
    // legacy block-ID conversion. The value also selects the column format the
    // game expects: 64z legacy worlds use 4 (16 384 block bytes / 4 sub-chunks),
    // New Dawn 256z worlds use 5+ (16 sub-chunks). Writing 4 for a 256z world makes
    // the game read it as 64z → totally misaligned ("conversion-bug" look).
    let version: u32 = if chunk_size >= 131_072 { 5 } else { 4 };
    header[92..96].copy_from_slice(&version.to_le_bytes());
    for b in &mut header[132..148] { *b = 14; }

    let spawn_x = (start_cx as f32 + width_chunks  as f32 * 0.5) * 16.0;
    let spawn_z = (start_cy as f32 + height_chunks as f32 * 0.5) * 16.0;
    let spawn_y = surface_z as f32 + 2.0;
    for (start, vals) in [(4usize, [spawn_x, spawn_y, spawn_z]), (16, [spawn_x, spawn_y, spawn_z])] {
        for (i, v) in vals.iter().enumerate() {
            header[start + i*4..start + i*4 + 4].copy_from_slice(&v.to_le_bytes());
        }
    }

    let mut ptr_table = vec![0u8; n_chunks * 16];
    for cy in 0..height_chunks {
        for cx in 0..width_chunks {
            let idx    = (cy * width_chunks + cx) as usize;
            let offset = (192 + idx * chunk_size) as u32;
            let entry  = &mut ptr_table[idx * 16..(idx + 1) * 16];
            entry[0..2].copy_from_slice(&((start_cx + cx as i32) as i16).to_le_bytes());
            entry[4..6].copy_from_slice(&((start_cy + cy as i32) as i16).to_le_bytes());
            entry[8..12].copy_from_slice(&offset.to_le_bytes());
        }
    }

    let mut file = fs::File::create(path).map_err(|e| format!("Failed to create file: {e}"))?;
    file.write_all(&header).map_err(|e| format!("Write error: {e}"))?;
    for chunk in chunks { file.write_all(chunk).map_err(|e| format!("Write error: {e}"))?; }
    file.write_all(&ptr_table).map_err(|e| format!("Write error: {e}"))?;
    Ok(())
}

// ── TG2 World Generator ───────────────────────────────────────────────────────
// Port of TerrainGen2.mm (Eden 2.0+ pre-generated world generator, ~2917 lines ObjC).
// Uses a flat blockz/colorz workspace (read-modify-write by multiple passes), then
// flushed into WorldGen chunks at the end — faithful to the original's architecture.

struct Tg2Config {
    seed: u32,
    terrain_type: u8,  // 0=Plains 1=Mars 2=RiverForest 3=Mtn+River 4=Desert
                       // 5=Ponies 6=Beach 7=Mix 8=Flat 9=CustomMix
    sky_islands: bool,
    struct_freq: u32,  // 0=sparse 1=normal 2=dense
    clouds: bool,
    amplitude: f64,    // relief multiplier (1.0 = native TG2 relief)
    sea_level_off: i32,// additive offset to water/sea levels (blocks, pre-vscale)
    blend: bool,       // soften biome zone boundaries (experimental)
    caves: bool,
    tall_caves: bool,
    custom_biomes: [u8; 4], // NW/NE/SW/SE biome for terrain_type=9
}

/// Flat voxel workspace.  Axes: x=EdenX, z=EdenY(south), y=EdenZ(height).
struct Tg2Grid {
    blockz: Vec<u8>,
    colorz: Vec<u8>,
    gsize:    usize,
    t_height: usize,
    // Vertical scale: 1.0 for 64z worlds, t_height/64 for taller (New Dawn 256z)
    // worlds so terrain proportionally fills the extra headroom (matches Classic).
    vs: f64,
    // User relief multiplier (Tg2Config.amplitude); folded into `relief`.
    amp: f64,
    // Additive sea/water-level offset in blocks (pre-vscale; see `sea_level`).
    sea_off: i32,
}

impl Tg2Grid {
    fn new(gsize: usize, t_height: usize, vs: f64, amp: f64, sea_off: i32) -> Self {
        let n = gsize * gsize * t_height;
        Self { blockz: vec![0u8; n], colorz: vec![0u8; n], gsize, t_height, vs, amp, sea_off }
    }
    /// Scale a vertical block offset / absolute z-band by the world's vertical scale.
    /// At vs=1.0 this is the identity, so 64z generation is byte-identical to before.
    #[inline] fn sv(&self, n: i32) -> i32 { (n as f64 * self.vs).round() as i32 }
    /// Scale a noise relief amplitude by both the vertical scale and the user
    /// amplitude knob. Pass the result as `a0` to `tg2_fbm2`.
    #[inline] fn relief(&self, a0: f64) -> f64 { a0 * self.vs * self.amp }
    /// Resolve a water/sea level: native band `n` plus the user offset, vscaled.
    #[inline] fn sea_level(&self, n: i32) -> i32 { self.sv(n + self.sea_off).max(2) }
    #[inline] fn ok(&self, x: i32, z: i32, y: i32) -> bool {
        x>=0&&z>=0&&y>=0
            &&(x as usize)<self.gsize&&(z as usize)<self.gsize&&(y as usize)<self.t_height
    }
    #[inline] fn idx(&self, x: usize, z: usize, y: usize) -> usize {
        x*(self.gsize*self.t_height)+z*self.t_height+y
    }
    fn get(&self, x: i32, z: i32, y: i32) -> u8 {
        if !self.ok(x,z,y) { return 0; }
        self.blockz[self.idx(x as usize, z as usize, y as usize)]
    }
    fn put(&mut self, x: i32, z: i32, y: i32, bt: u8, c: u8) {
        if !self.ok(x,z,y) { return; }
        let i = self.idx(x as usize, z as usize, y as usize);
        self.blockz[i]=bt; self.colorz[i]=c;
    }
    fn set_bt(&mut self, x: i32, z: i32, y: i32, bt: u8) {
        if !self.ok(x,z,y) { return; }
        let i = self.idx(x as usize, z as usize, y as usize);
        self.blockz[i]=bt;
    }
    fn clampy(&self, h: i32) -> i32 { h.max(1).min(self.t_height as i32 - 1) }
}

// Paint cycle helpers — ports of colorCycle/2-7 (TerrainGen2.mm L39-212).
// NUM_COLORS=54; return value is a paint index 0-53.
const TG2_NUM_COLORS: i32 = 54;
fn tg2_cc (idx:i32,typ:i32)->u8{let c=if typ==1{8}else{(idx/12)%8};let mut h=idx%8;if h>=4{h=7-h;}h+=1;((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
fn tg2_cc2(idx:i32,c:i32  )->u8{let mut h=(idx/5)%8;if h>=4{h=7-h;}h+=1;((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
fn tg2_cc3(idx:i32,c:i32  )->u8{let mut h=(idx/5)%8;if h>=4{h=7-h;}h+=3;if h==6{h=5;}((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
fn tg2_cc4(idx:i32,c:i32  )->u8{let mut h=(idx/5)%8;if h>=4{h=7-h;}h+=2;if h==6{return 0;}((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
fn tg2_cc5(idx:i32,c:i32  )->u8{let mut h=(idx/5)%8;if h>=4{h=7-h;}if h==6{return 0;}((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
fn tg2_cc6(idx:i32,c:i32  )->u8{let mut h=idx%8;if h>=4{h=7-h;}if h==6{return 0;}((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
fn tg2_cc7(idx:i32,c:i32  )->u8{let mut h=(idx/5)%8;if h>=5{h=8-h;}((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}

// Noise helpers
fn tg2_fbm2(n: &ClassicNoise, x: i32, z: i32, seed: f64, f0: f64, a0: f64, var: f64) -> f64 {
    let (mut f, mut a, mut acc) = (f0, a0, 0.0f64);
    for _ in 0..10 {
        acc += n.noise2(f*(x as f64+seed)/128.0, f*(z as f64+seed)/128.0)*a*var;
        f*=2.0; a/=2.0;
    }
    acc
}
fn tg2_fbm3(n: &ClassicNoise, x: i32, z: i32, y: i32, seed: f64, f0: f64, a0: f64) -> f64 {
    let (mut f, mut a, mut acc) = (f0, a0, 0.0f64);
    for _ in 0..3 {
        acc += n.noise3(f*(x as f64+seed)/128.0, f*(z as f64+seed)/128.0, f*(y as f64+seed)/128.0)*a;
        f*=2.0; a/=2.0;
    }
    acc
}

// Standard heightmap body: stone core with 3D-noise skin.
// FORMATION_HEIGHT is always overridden to T_HEIGHT-1 in the original, so `fh_cap`
// below = t_height-17 (the `FORMATION_HEIGHT-16` threshold).
fn tg2_fill_column(
    g: &mut Tg2Grid, noise: &ClassicNoise, x: i32, z: i32,
    h: i32, seed: f64, stone: u8, stone_paint: u8,
) {
    let fh_cap = (g.t_height as i32 - g.sv(17)).max(0);
    let bot = h % 2 + 1; // below this: skin (3D noise)
    for y in 0..h {
        if y > bot && y < fh_cap {
            g.put(x, z, y, stone, stone_paint);
        } else {
            let n3 = tg2_fbm3(noise, x, z, y, seed, 3.0, 0.5);
            if n3 < 0.07 { g.set_bt(x, z, y, 3); } // dirt
        }
    }
}

// Trees
fn tg2_make_tree(g: &mut Tg2Grid, x: i32, z: i32, y: i32, rng: &mut Rng64) {
    let th_i = (rng.next()%3+6) as i32;
    if y+th_i >= g.t_height as i32 { return; }
    for i in 0..(3*th_i/4) { g.put(x, z, y+i, 6, 0); }
    let ct=[0u8,19,20,21]; let lc=ct[(rng.next()%4) as usize];
    for dx in -2i32..=2 { for dz in -2i32..=2 { for dy in (2*th_i/3)..th_i {
        let (nx,nz,ny)=(x+dx,z+dz,y+dy);
        if g.get(nx,nz,ny)==6 { continue; }
        if dx.abs()==2&&dz.abs()==2&&(dy==2*th_i/3||dy==th_i-1) { continue; }
        if (dx.abs()==2||dz.abs()==2) && rng.next()%2==0 { continue; }
        g.put(nx,nz,ny,5,lc);
    }}}
}
fn tg2_make_tree2(g: &mut Tg2Grid, x: i32, z: i32, y: i32, hh: i32, rng: &mut Rng64) {
    let th_i = (rng.next()%4+hh as u64) as i32;
    if y+th_i >= g.t_height as i32 { return; }
    for i in 0..(3*th_i/4) { g.put(x, z, y+i, 6, 0); }
    let ct=[0u8,31,40,40]; let lc=ct[(rng.next()%4) as usize];
    for dx in -2i32..=2 { for dz in -2i32..=2 { for dy in (2*th_i/3)..th_i {
        let (nx,nz,ny)=(x+dx,z+dz,y+dy);
        if g.get(nx,nz,ny)==6 { continue; }
        if dx.abs()==2&&dz.abs()==2&&(dy==2*th_i/3||dy==th_i-1) { continue; }
        if (dx.abs()==2||dz.abs()==2) && rng.next()%2==0 { continue; }
        g.put(nx,nz,ny,5,lc);
    }}}
}
fn tg2_make_palm(g: &mut Tg2Grid, x: i32, z: i32, y: i32, hh: i32, rng: &mut Rng64) {
    let th_i = (rng.next()%4+hh as u64) as i32;
    if y+th_i >= g.t_height as i32 { return; }
    let colort=[2u8,0,29,38][(rng.next()%4) as usize];
    let lc=[0u8,31,22,40][(rng.next()%4) as usize];
    for i in 0..th_i { g.put(x,z,y+i,7,colort); }
    let dx=[0i32,-1,1,0,0]; let dz=[0i32,0,0,-1,1]; let yp=[0i32,1,1,1,1];
    let ty=y+th_i;
    for i in 0i32..4 { for d in 0usize..4 {
        g.put(x+dx[d]*i,z+dz[d]*i,ty+yp[i as usize],5,lc);
        if i==1 { g.put(x+dx[d]*i,z+dz[d]*i,ty+yp[1]-1,5,lc); }
    }}
}

// makeDirt: grass plains (offsety=T_HEIGHT/2, freq=2, amp=4)
fn tg2_make_dirt(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, sx: i32, sz: i32, ex: i32, ez: i32) {
    let th=g.t_height as i32; let amp=g.relief(4.0);
    for x in sx..ex { for z in sz..ez {
        let h=(th as f64/2.0+tg2_fbm2(noise,x,z,seed,2.0,amp,3.0)).round() as i32;
        let h=h.max(1).min(th-1);
        tg2_fill_column(g,noise,x,z,h,seed,2,tg2_cc2(h,8));
        g.set_bt(x,z,0,4); // sand base
    }}
    // surface: dirt → grass
    for x in sx..ex { for z in sz..ez {
        for y in 1..th { if g.get(x,z,y)==0&&g.get(x,z,y-1)==3 { g.set_bt(x,z,y-1,8); } }
    }}
}

// makeMars: red/dark-stone low terrain with lava pools (offsety=T_HEIGHT/8)
fn tg2_make_mars(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, sx: i32, sz: i32, ex: i32, ez: i32) {
    let th=g.t_height as i32; let amp=g.relief(4.0); let lava_top=g.sv(5).max(2);
    for x in sx..ex { for z in sz..ez {
        let h=(th as f64/8.0+tg2_fbm2(noise,x,z,seed,2.0,amp,3.0)).round() as i32;
        let h=h.max(1).min(th-1);
        tg2_fill_column(g,noise,x,z,h,seed,2,tg2_cc2(h,0));
        g.set_bt(x,z,0,4);
    }}
    for x in sx..ex { for z in sz..ez {
        for y in 0..lava_top { if g.get(x,z,y)==0 { g.put(x,z,y,23,0); } } // lava
    }}
}

// makeRiverTrees: rolling hills + river channel + dense trees (offsety=T_HEIGHT/2-10, amp=20)
fn tg2_make_river_trees(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, rng: &mut Rng64, sx: i32, sz: i32, ex: i32, ez: i32) {
    let th=g.t_height as i32;
    let fh_cap=(th-g.sv(17)).max(0);
    let amp=g.relief(20.0); let base=th/2-g.sv(10);
    let (riv_lo,riv_hi,riv_d)=(g.sv(6),g.sv(15),g.sv(6).max(2));
    for x in sx..ex { for z in sz..ez {
        let h=(base as f64+tg2_fbm2(noise,x,z,seed,1.0,amp,3.0)).round() as i32;
        let h=h.max(1).min(th-1);
        let bot=h%2+1;
        for y in 0..h {
            let c=if y>bot&&y<fh_cap {tg2_cc3(y+30,1)} else {tg2_cc3(h+30,1)};
            g.put(x,z,y,3,c); // dirt with green palette
        }
    }}
    // dirt → grass (top of column within y < th-dirtlevel)
    for x in sx..ex { for z in sz..ez {
        for y in 1..(th-g.sv(25)) { if g.get(x,z,y)==0&&g.get(x,z,y-1)==3 { g.put(x,z,y-1,8,tg2_cc4(y-1+30,3)); } }
    }}
    // river: fill if air in the river band
    for x in sx..ex { for z in sz..ez {
        for y in riv_lo..riv_hi {
            if g.get(x,z,y)==0 { for iy in 1..riv_d { g.put(x,z,y-iy,20,0); } }
        }
    }}
    // trees 1-in-70
    for x in (sx+4)..(ex-4) { for z in (sz+4)..(ez-4) {
        for y in 4..(th-g.sv(10)) {
            if g.get(x,z,y)==3&&g.get(x,z,y+1)==0 {
                if rng.next()%70==0 { tg2_make_tree2(g,x,z,y,12,rng); }
                break;
            }
        }
    }}
}

// makeMountains: high peaks, snow (cloud) caps at y≥34, ice/water base
fn tg2_make_mountains(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, rng: &mut Rng64, sx: i32, sz: i32, ex: i32, ez: i32) {
    let th=g.t_height as i32; let amp=g.relief(20.0); let base=th/2-g.sv(10);
    for x in sx..ex { for z in sz..ez {
        let h=(base as f64+tg2_fbm2(noise,x,z,seed,1.0,amp,3.0)).round() as i32;
        let h=h.max(1).min(th-1);
        for y in 0..h { g.put(x,z,y,2,tg2_cc5(y+50,8)); }
    }}
    // snow caps (cloud blocks): denser the higher you go, above the snow line
    let snowlevel=g.sv(34); let (b4,b6)=(g.sv(4),g.sv(6));
    for x in sx..ex { for z in sz..ez {
        for y in snowlevel..th {
            let band=y-snowlevel;
            let skip = if band<b4 { rng.next()%2==0 }
                       else if band<b6 { rng.next()%2==0 && rng.next()%2==0 }
                       else { false };
            if skip { continue; }
            if g.get(x,z,y)==0&&y>0&&g.get(x,z,y-1)==2 {
                g.put(x,z,y-1,19,0);
                if y>1&&g.get(x,z,y-2)==2 { g.put(x,z,y-2,19,0); }
            }
        }
    }}
    // base: ice/water in lower area, water elsewhere
    let xspan=ex-sx; let zspan=ez-sz;
    let (base_lo,base_hi,base_d)=(g.sv(3),g.sv(6),g.sv(3).max(2));
    for x in sx..ex { for z in sz..ez {
        for y in base_lo..base_hi {
            if g.get(x,z,y)==0 {
                let inner=(x-sx)<xspan*3/4&&(z-sz)<zspan*3/4;
                let on_edge=(x-sx)==xspan*3/4||(z-sz)==zspan*3/4;
                let bt=if inner&&!on_edge{15}else{20}; // ice or water
                for iy in 1..base_d { g.put(x,z,y-iy,bt,6); }
                break;
            }
        }
    }}
}

// makeTransition: blend terrain heights across a seam with a smoothstep ramp and
// a noise-warped boundary so the mountains↔river-forest border meanders instead
// of stepping along a straight grid line. Carries the source columns' paint too.
fn tg2_make_transition(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, sx: i32, sz: i32, ex: i32, ez: i32) {
    let th=g.t_height as i32;
    let span=(ex-sx).max(1) as f64;
    let surf=|g:&Tg2Grid,cx:i32,z:i32|->(i32,u8,u8){
        for i in (0..th).rev() {
            let bt=g.get(cx,z,i);
            if bt!=0&&bt!=19 { return (i+1, bt, g.colorz[g.idx(cx as usize,z as usize,i as usize)]); }
        }
        (0,0,0)
    };
    for z in sz..ez {
        let (lh,ltype,lpt)=surf(g,sx-1,z);
        let (rh,rtype,rpt)=surf(g,ex,z);
        let delta=(rh-lh) as f64;
        for x in sx..ex {
            // Warp the normalised seam position; smoothstep the height ramp.
            let w=tg2_fbm2(noise,x,z,seed+533.0,1.0,span*0.25,1.0);
            let fx=(((x-sx) as f64 + w)/span).clamp(0.0,1.0);
            let s=fx*fx*(3.0-2.0*fx);
            let h=(lh as f64+delta*s).round() as i32;
            let (bt,pt)=if s<0.5{(ltype,lpt)}else{(rtype,rpt)};
            for y in 1..h.max(1) { g.put(x,z,y,bt,pt); }
        }
    }
}

// makeGreenHills: rolling grass hills that fill most of the world with edge tapering
fn tg2_make_green_hills(g: &mut Tg2Grid, noise: &ClassicNoise, seed2: f64, height: i32) {
    let th=g.t_height as i32; let gs=g.gsize as i32;
    let fh_cap=(th-g.sv(17)).max(0); let amp=g.relief(8.0); let hcap=g.sv(10);
    for x in 0..gs {
        if x<gs/4-15 { continue; }
        for z in 0..(3*gs/4+15) {
            let mut oy=height;
            if x<gs/4+15&&z>gs/4    { oy=g.clampy(height+(gs/4+15-x).abs()); }
            if x<gs/4    &&z>gs/4   { oy=g.clampy(height-(gs/4-x).abs()+15); }
            if x<gs/4    &&z<=gs/4  { oy=g.clampy(height-(gs/4-x).abs()); }
            if x>3*gs/4             { oy=g.clampy(height-(x-3*gs/4)); }
            if z>gs/2&&x>=3*gs/4+35 { continue; }
            if z>3*gs/4-7&&x<3*gs/4 { oy=g.clampy(height+(3*gs/4-7-z).abs()); }
            if z>3*gs/4  &&x<3*gs/4 { oy=g.clampy(height-(3*gs/4-z).abs()+7); }
            let n=oy as f64+tg2_fbm2(noise,x,z,seed2,1.0,amp,3.0);
            let h=(n.round() as i32).min(height+hcap).max(1).min(th-1);
            let bot=h%2+1;
            for y in 0..h {
                let c=if y>bot&&y<fh_cap{tg2_cc3(y,1)}else{tg2_cc3(h,1)};
                g.put(x,z,y,3,c);
            }
        }
    }
    // dirt → grass
    for x in 0..gs { for z in 0..gs {
        for y in 1..th { if g.get(x,z,y)==0&&g.get(x,z,y-1)==3 { g.put(x,z,y-1,8,tg2_cc3(y+30,3)); } }
    }}
    // water lake in middle-left (x: gs/4..gs/2-60)
    let (lake_lo,lake_hi,lake_d,flood_y)=(g.sv(6),g.sv(19),g.sv(6).max(2),g.sv(17));
    for x in gs/4..(gs/2-60) {
        for z in 0..3*gs/4 {
            for y in lake_lo..lake_hi {
                if g.get(x,z,y)==0 {
                    for iy in 1..lake_d { g.put(x,z,y-iy,20,15); }
                    break;
                }
            }
        }
    }
    if gs/2-60 > gs/4 { // flood fill origin at (gs/2-60, z, flood_y)
        for z in 0..3*gs/4 {
            if g.get(gs/2-60,z,flood_y)==0 { g.put(gs/2-60,z,flood_y,20,15); }
        }
    }
}

// makeBeach: coastal sand with shallow ocean and palm trees
fn tg2_make_beach(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, rng: &mut Rng64, sx: i32, sz: i32, ex: i32, ez: i32) {
    let th=g.t_height as i32; let sealevel=g.sea_level(19);
    let amp=g.relief(18.0); let grass_h=sealevel+g.sv(2);
    let xe=ex-sx; // x extent for relative calculations
    let mut oy=th/2-g.sv(14);
    for x in sx..ex {
        let xr=x-sx;
        if xr>=3*xe/4-35 { oy+=1; }
        if xr>=3*xe/4    { oy-=2; }
        for z in sz..ez {
            let raw=tg2_fbm2(noise,x,z,seed,1.0,amp,3.0);
            let n=if raw>0.0{raw/9.0+oy as f64}else{raw+oy as f64};
            let h=(n.round() as i32).max(2).min(grass_h);
            for y in 0..h {
                if h>=grass_h&&xr<3*xe/4-35 { g.put(x,z,y,8,0); }
                else                          { g.put(x,z,y,4,tg2_cc6(h-1+14,1)); }
            }
        }
    }
    // water fill
    for x in sx..ex { for z in sz..ez {
        for y in 1..sealevel { if g.get(x,z,y)==0 { g.put(x,z,y,20,23); } }
    }}
    // palm trees 1-in-90
    for x in (sx+4)..(ex-4) { for z in (sz+4)..(ez-4) {
        for y in sealevel..(th-g.sv(10)) {
            if g.get(x,z,y)==8&&g.get(x,z,y+1)==0 {
                if rng.next()%90==0 { tg2_make_palm(g,x,z,y,4,rng); }
                break;
            }
        }
    }}
}

// makeDesert: flat sand with pyramid structures
fn tg2_make_desert(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, rng: &mut Rng64, sx: i32, sz: i32, ex: i32, ez: i32, pyramid_freq: u32) {
    let th=g.t_height as i32;
    let h=th/2-g.sv(10); // flat (AMPLITUDE=0)
    let water_top=g.sea_level(17);
    for x in sx..ex { for z in sz..ez {
        for y in 0..h { g.put(x,z,y,4,tg2_cc6(y-1+14,1)); } // sand
    }}
    // water at base level
    for x in sx..ex { for z in sz..ez {
        for y in 1..water_top { if g.get(x,z,y)==0 { g.put(x,z,y,20,23); break; } }
    }}
    // pyramids
    let xs=ex-sx; let zs=ez-sz;
    for _ in 0..pyramid_freq {
        let rh=(rng.next()%30+15) as i32;
        let rx=sx+(rng.next()%(xs.max(rh*2+4) as u64)) as i32;
        let rz=sz+(rng.next()%(zs.max(rh*2+4) as u64)) as i32;
        tg2_make_pyramid2(g,rx,rz,rh,45,-1);
    }
}

// makePonies: colourful stone hills with cave + water pool
fn tg2_make_ponies(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, sx: i32, sz: i32, ex: i32, ez: i32) {
    let th=g.t_height as i32; let base=th/2-g.sv(10); let amp=g.relief(4.0);
    let xe=ex-sx;
    for x in sx..ex { for z in sz..ez {
        let xr=x-sx; let zr=z-sz;
        let mut oy=base;
        if xr>xe-10 { oy=base+(xe-10-xr).abs(); if xr>=xe { oy=base+(xe-10-xr).abs()-2*(xe-xr).abs(); } }
        if zr<10    { oy=base+(10-zr).abs(); }
        let h=(oy as f64+tg2_fbm2(noise,x,z,seed,2.0,amp,3.0)).round() as i32;
        let h=h.max(1).min(th-1);
        for y in 0..h { g.put(x,z,y,2,tg2_cc2(h,6)); }
    }}
    // cave carve (3D noise) in lower portion
    let cave_top=th/2-g.sv(15);
    for x in sx..ex { for z in sz..ez {
        for y in 2..cave_top {
            let n3=tg2_fbm3(noise,x,z,y,seed,4.0,0.25);
            if n3>0.0 { let c=if y==cave_top-1{25}else{tg2_cc(z+x,0)};g.put(x,z,y,2,c); }
            else       { g.set_bt(x,z,y,0); }
        }
    }}
    // water at bottom
    let wt=th/5;
    for x in sx..ex { for z in sz..ez {
        for y in 1..wt { if g.get(x,z,y)==0 { g.put(x,z,y,20,6); } }
    }}
}

// makeClassicGen: legacy FBM terrain (dirt/stone + grass surface)
fn tg2_make_classic_gen(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, sx: i32, sz: i32, ex: i32, ez: i32) {
    let th=g.t_height as i32; let amp=g.relief(4.0); let base=th/2-g.sv(10);
    for x in sx..ex { for z in sz..ez {
        let h=(base as f64+tg2_fbm2(noise,x,z,seed,2.0,amp,3.0)).round() as i32;
        let h=h.max(1).min(th-1);
        tg2_fill_column(g,noise,x,z,h,seed,2,0);
        g.set_bt(x,z,0,1); // bedrock
    }}
    for x in sx..ex { for z in sz..ez {
        for y in 1..th { if g.get(x,z,y)==0&&g.get(x,z,y-1)==3 { g.set_bt(x,z,y-1,8); } }
    }}
}

// Structures
fn tg2_make_pyramid(g: &mut Tg2Grid, cx: i32, cz: i32, h: i32) {
    let th=g.t_height as i32;
    let mut starty=th-1; let mut found=false;
    'f: while starty>5 {
        for sx in (cx-h)..cx+h { for sz in (cz-h)..cz+h {
            let bt=g.get(sx,sz,starty);
            if bt!=4{if bt!=0{return;}found=false;break 'f;}
        }}
        found=true; break;
    }
    if !found { return; }
    let mut r=h;
    for y in starty..starty+h {
        if y>th-8 { break; }
        for sx in (cx-r)..cx+r { for sz in (cz-r)..cz+r { g.put(sx,sz,y,14,0); } }
        r-=1;
    }
}
fn tg2_make_pyramid2(g: &mut Tg2Grid, cx: i32, cz: i32, h: i32, _color: u8, sy: i32) {
    let th=g.t_height as i32;
    let starty=if sy==-1 {
        let mut sy2=th-1; let mut ok=false;
        'f: while sy2>5 {
            let mut good=true;
            'c: for sx in (cx-h)..=cx+h { for sz in (cz-h)..=cz+h {
                if (sx-cx).abs()+(sz-cz).abs()<=h {
                    let bt=g.get(sx,sz,sy2);
                    if bt!=4{if bt!=0{return;}good=false;break 'c;}
                }
            }}
            if good{ok=true;break;}
            sy2-=1;
        }
        if !ok { return; } sy2
    } else { sy };
    let mut r=h;
    for y in starty..=starty+h {
        if y>th-4 { continue; }
        for sx in (cx-r)..=cx+r { for sz in (cz-r)..=cz+r {
            if (sx-cx).abs()+(sz-cz).abs()<=r { g.put(sx,sz,y,14,0); }
        }}
        r-=1;
    }
}
fn tg2_make_volcano(g: &mut Tg2Grid, cx: i32, cz: i32, base_y: i32, start_radius: i32, rng: &mut Rng64) {
    let th=g.t_height as i32;
    let mut h=1i32;
    for radius in (1..=start_radius).rev() {
        h+=1; let w=5i32; let r2=radius+w;
        for i in -r2..=r2 { for j in -r2..=r2 {
            let ang=(i as f64).atan2(j as f64);
            let rh=r2 as f64+3.0*(12.0*ang).sin();
            if radius>2&&((i*i+j*j) as f64)<rh*rh { g.put(cx+i,cz+j,base_y+h,2,36); }
            else if i*i+j*j<r2*r2               { g.put(cx+i,cz+j,base_y+h,23,0); }
        }}
    }
    for iy in 0..h/2 {
        let r=iy+1;
        for i in -r..=r { for j in -r..=r {
            if i*i+j*j<r*r+(rng.next()%8) as i32 { g.put(cx+i,cz+j,base_y+h-iy,23,0); }
        }}
    }
}
fn tg2_make_sky_island(g: &mut Tg2Grid, cx: i32, cz: i32, r: i32, rng: &mut Rng64) {
    let th=g.t_height as i32;
    let cy=g.sv(18)+r-r/4-r/8;
    for x in -r..=r { for z in -r..=r { for y in -r..=-r/2 {
        if x*x+z*z+y*y<=r*r {
            let ny=cy+y; if ny<=1||ny>=th { continue; }
            if y==-r/2 {
                g.put(cx+x,cz+z,ny,8,0);
                if x*x+z*z+y*y<(r-1)*(r-1)&&rng.next()%90==0 { tg2_make_palm(g,cx+x,cz+z,ny,4,rng); }
            } else { g.put(cx+x,cz+z,ny,4,tg2_cc3(ny,1)); }
        }
    }}}
}

// makeMix: the original composite biome layout (faithful quadrant layout)
fn tg2_make_mix(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, seed2: f64, rng: &mut Rng64, pyramid_freq: u32, volcano_freq: u32, report: &mut dyn FnMut(&str, f32)) {
    let gs=g.gsize as i32; let th=g.t_height as i32;
    let fh_cap=(th-g.sv(17)).max(0);
    let cbase=th/2-g.sv(10); let camp=g.relief(20.0);

    let rp=|r: &mut dyn FnMut(&str,f32), sub: f32| r("Generating terrain", 0.05+0.62*sub);
    // Green hills base
    rp(report, 0.0);
    tg2_make_green_hills(g,noise,seed2,th/3);

    // Central mix heightmap (stone) overwrites interior zone
    rp(report, 0.12);
    for z in 0..gs { for x in 0..gs {
        let mut oy=cbase;
        if x<gs/4+10&&z>=gs/4&&z<gs/2+10 {
            if z>gs/2-10 { oy-=20-(gs/2+10-z); }
            if x>gs/4-10 { oy-=20-(gs/4+10-x); }
        } else {
            if z>gs/4+10 { continue; }
            if z>gs/4-10 { oy-=20-(gs/4+10-z); }
            if x>3*gs/4-10 { let v=cbase-((3*gs/4-10-x).abs());oy=v.max(th/12); }
        }
        let h=(oy as f64+tg2_fbm2(noise,x,z,seed,1.0,camp,3.0)).round() as i32;
        let h=h.max(1).min(th-1);
        let bot=h%2+1;
        for y in 0..h {
            let c=if y>bot&&y<fh_cap{tg2_cc7(y+10,8)}else{tg2_cc7(y+10,8)};
            g.put(x,z,y,2,c);
        }
    }}
    // Beach (bottom-right zone)
    rp(report, 0.24);
    tg2_make_beach(g,noise,seed,rng,gs/4,3*gs/4,3*gs/4+64.min(gs-gs/4),gs);
    // Mars (right strip)
    rp(report, 0.32);
    tg2_make_mars(g,noise,seed,3*gs/4,0,gs,gs);
    // Water in right-strip lower area
    let (ws_lo,ws_hi,ws_d)=(g.sv(3),g.sv(6),g.sv(3).max(2));
    for x in 3*gs/4..gs { for z in 0..=3*gs/4 {
        for y in ws_lo..ws_hi {
            if g.get(x,z,y)==0||g.get(x,z,y)==23 {
                for iy in 1..ws_d { g.put(x,z,y-iy,20,0); }
                break;
            }
        }
    }}
    // Second beach pass
    tg2_make_beach(g,noise,seed,rng,gs/4,3*gs/4,3*gs/4+64.min(gs-gs/4),gs);
    // Ponies (bottom-left)
    rp(report, 0.42);
    tg2_make_ponies(g,noise,seed,0,3*gs/4-15,gs/4+15,gs);
    // Classic gen (left interior)
    rp(report, 0.52);
    tg2_make_classic_gen(g,noise,seed,0,gs/2,gs/4,3*gs/4);
    // Desert (left-center)
    rp(report, 0.60);
    tg2_make_desert(g,noise,seed,rng,0,gs/4,gs/4+20,3*gs/4,0);
    // Mountains (top-left corner)
    rp(report, 0.67);
    tg2_make_mountains(g,noise,seed,rng,0,0,gs/4,gs/4);
    // Pyramids in left interior zone
    rp(report, 0.74);
    for _ in 0..pyramid_freq {
        let rh=(rng.next()%30+15) as i32;
        let rx=(rng.next()%((gs/4-(rh+3)/2).max(2) as u64)) as i32+(rh+3);
        let rz=(rng.next()%((gs/2+gs/4-(rh+3)/2).max(2) as u64)) as i32+(rh+3);
        if rx<gs/4&&rz<3*gs/4&&rz>gs/4 { tg2_make_pyramid2(g,rx,rz,rh,45,-1); }
    }
    tg2_make_pyramid2(g,gs/4,3*gs/4,25,22,g.sv(17));
    // Trees in classic-gen area
    rp(report, 0.82);
    for x in 2..gs/4-2 { for z in gs/2+2..3*gs/4-2 {
        for y in 1..th-1 {
            if (g.get(x,z,y)==8||g.get(x,z,y)==11)&&g.get(x,z,y+1)==0 {
                if rng.next()%50==0 { tg2_make_tree(g,x,z,y+1,rng); }
                break;
            }
        }
    }}
    // Sky islands in middle-upper zone
    rp(report, 0.89);
    for _ in 0..40i32 {
        let rs=(rng.next()%20+5) as i32;
        let rx=gs/4+rs+(rng.next()%((gs/2-rs*2).max(2) as u64)) as i32;
        let rz=3*gs/4+gs/8+rs+(rng.next()%((gs/8-rs).max(2) as u64)) as i32;
        tg2_make_sky_island(g,rx,rz,rs,rng);
    }
    // Volcanoes in right area — enforce minimum spacing so cones never overlap
    let mut placed_volcanoes: Vec<(i32,i32,i32)> = Vec::new(); // (rx,rz,rh)
    let mut attempts=0i32;
    let mut placed=0u32;
    while placed<volcano_freq && attempts<volcano_freq as i32*20 {
        attempts+=1;
        let rh=(rng.next()%10+25) as i32;
        let rx=3*gs/4+50+(rng.next()%((gs/4-rh*2-50).max(2) as u64)) as i32;
        let rz=gs/4+rh*2+(rng.next()%((3*gs/4-rh*2).max(2) as u64)) as i32;
        // min separation = sum of outer radii (rh+5 each) plus a 10-block gap
        let too_close=placed_volcanoes.iter().any(|&(ox,oz,oh)|{
            let min_sep=(rh+oh+20) as i64;
            let dx=(rx-ox) as i64; let dz=(rz-oz) as i64;
            dx*dx+dz*dz < min_sep*min_sep
        });
        if too_close { continue; }
        placed_volcanoes.push((rx,rz,rh));
        tg2_make_volcano(g,rx,rz,1,rh,rng);
        placed+=1;
    }
    // Bedrock floor
    for x in 0..gs { for z in 0..gs { g.set_bt(x,z,0,1); } }
    // Global trees
    for x in 4..gs-4 { for z in 4..gs-4 {
        for y in 4..th-10 {
            if g.get(x,z,y)==8&&g.get(x,z,y+1)==0 {
                if rng.next()%300==0 { tg2_make_tree2(g,x,z,y,12,rng); }
                break;
            }
        }
    }}
}

// Flush TG2 flat grid → WorldGen chunk storage, emitting progress per x-slice.
fn tg2_flush(g: &Tg2Grid, gen: &mut WorldGen, report: &mut dyn FnMut(&str, f32)) {
    let gs=g.gsize;
    for x in 0..gs {
        if x % 32 == 0 {
            report("Writing chunks", 0.84 + 0.12 * x as f32 / gs as f32);
        }
        for z in 0..gs { for y in 0..g.t_height {
            let i=g.idx(x,z,y);
            let bt=g.blockz[i]; if bt==0 { continue; }
            let paint=g.colorz[i];
            gen.set(x as i32,z as i32,y as i32,bt);
            if paint!=0 { gen.set_paint(x as i32,z as i32,y as i32,paint); }
        }}
    }
}

// Cave carving pass on the TG2 grid using the same 3D-noise formula as the
// classic generator. Applied after terrain generation, before flush.
fn tg2_carve_caves(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, tall_caves: bool) {
    let gs=g.gsize as i32; let th=g.t_height as i32;
    let vs=g.vs;
    let skin=(6.0*vs).round() as i32;
    let cave_margin=if tall_caves{(4.0*vs).round() as i32}else{(16.0*vs).round() as i32};
    let y_scale=if tall_caves{0.5f64}else{1.0};
    for x in 0..gs { for z in 0..gs {
        // Find surface (first non-air scanning down)
        let mut surf=-1i32;
        for y in (1..th).rev() { if g.get(x,z,y)!=0 { surf=y; break; } }
        if surf<1 { continue; }
        let h=surf+1; // height above surface (like fill_classic_chunk)
        let formation=h-skin;
        for y in 1..formation {
            if y<=(h%2+1) || y>=formation-cave_margin { continue; }
            let bt=g.get(x,z,y);
            if bt!=2 && bt!=10 { continue; } // only carve stone/dark-stone
            if classic_cave_block(noise,x,z,y,y_scale,seed)==0 {
                g.set_bt(x,z,y,0);
            }
        }
    }}
}

// Dispatch a single biome to a rectangular region of the grid.
// Used by tg2_make_custom_mix for each quadrant.
fn tg2_dispatch_biome(
    g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, rng: &mut Rng64,
    biome: u8, sx: i32, sz: i32, ex: i32, ez: i32, pf: u32,
) {
    match biome {
        0 => tg2_make_dirt(g,noise,seed,sx,sz,ex,ez),
        1 => tg2_make_mars(g,noise,seed,sx,sz,ex,ez),
        2 => tg2_make_river_trees(g,noise,seed,rng,sx,sz,ex,ez),
        3 => { // Mtn+River: split quadrant east/west
            let mid=(sx+ex)/2;
            tg2_make_river_trees(g,noise,seed,rng,mid,sz,ex,ez);
            tg2_make_mountains(g,noise,seed,rng,sx,sz,(mid-16).max(sx),ez);
            tg2_make_transition(g,noise,seed,(mid-16).max(sx),sz,mid,ez);
        }
        4 => tg2_make_desert(g,noise,seed,rng,sx,sz,ex,ez,pf),
        5 => tg2_make_ponies(g,noise,seed,sx,sz,ex,ez),
        6 => tg2_make_beach(g,noise,seed,rng,sx,sz,ex,ez),
        _ => {} // unknown or flat: leave as bedrock
    }
}

// Custom biome mix: user-specified biome per quadrant (NW/NE/SW/SE).
fn tg2_make_custom_mix(
    g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, rng: &mut Rng64,
    biomes: &[u8; 4], pf: u32, report: &mut dyn FnMut(&str, f32),
) {
    let gs=g.gsize as i32; let mid=gs/2;
    let rp=|r: &mut dyn FnMut(&str,f32), sub: f32| r("Generating terrain", 0.05+0.62*sub);
    rp(report, 0.0);
    tg2_dispatch_biome(g,noise,seed,rng,biomes[0],0,0,mid,mid,pf);
    rp(report, 0.25);
    tg2_dispatch_biome(g,noise,seed,rng,biomes[1],mid,0,gs,mid,pf);
    rp(report, 0.50);
    tg2_dispatch_biome(g,noise,seed,rng,biomes[2],0,mid,mid,gs,pf);
    rp(report, 0.75);
    tg2_dispatch_biome(g,noise,seed,rng,biomes[3],mid,mid,gs,gs,pf);
    rp(report, 1.0);
}

// Experimental biome blend: soften hard surface-height discontinuities between
// adjacent zones by building a talus ramp up toward higher natural-terrain
// neighbours.  Only *adds* blocks (never carves), and only between natural
// surfaces (stone/dirt/sand/grass) — so water, structures (slate) and sky
// features are left untouched.  Each iteration raises a column by at most one
// block, so N iterations yields a ~1:N slope; scaled by `vs` for taller worlds.
// When raising, the block type from the highest natural neighbour is used so
// the slope transitions into the higher biome's material rather than dragging
// the lower biome's material upward (which created painted-sand staircases, etc.)
fn tg2_blend_seams(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, iters: i32) {
    let gs=g.gsize as i32; let th=g.t_height as i32;
    // "Natural" surfaces participate in the blend; water/lava/ice/cloud and
    // structures (slate) are skipped so they keep their crisp form.
    let natural=|bt:u8| matches!(bt,2|3|4|8);
    let sidx=|x:i32,z:i32| (x*gs+z) as usize;
    // Snapshot each column's surface (h, block, paint).
    let snapshot=|g:&Tg2Grid, surf:&mut Vec<(i32,u8,u8)>| {
        for x in 0..gs { for z in 0..gs {
            surf[sidx(x,z)]=(-1,0,0);
            for y in (1..th).rev() {
                let bt=g.get(x,z,y);
                if bt!=0 && bt!=19 && bt!=20 && bt!=23 && bt!=15 && bt!=14 {
                    let c=g.colorz[g.idx(x as usize,z as usize,y as usize)];
                    surf[sidx(x,z)]=(y,bt,c);
                    break;
                }
            }
        }}
    };
    let mut surf=vec![(-1i32,0u8,0u8); (gs*gs) as usize];
    snapshot(g, &mut surf);
    // Kernel radius scales with world height; warp magnitude follows it so the
    // smoothed band wanders organically instead of tracing the straight zone grid.
    let radius=((g.vs*2.0).round() as i32).clamp(2,5);
    let warp_amp=radius as f64*1.5;
    for _ in 0..iters.max(1) {
        // Pass 1: compute the warped, box-blurred target height + a dithered
        // surface paint for every natural column from the current snapshot.
        let mut plan: Vec<(i32,i32,i32,u8,u8)> = Vec::new(); // (x,z,target_h,bt,paint)
        for x in 0..gs { for z in 0..gs {
            let (h,bt,_)=surf[sidx(x,z)];
            if h<1 || !natural(bt) { continue; }
            // Warp the kernel centre with low-frequency noise → wavy seams.
            let wx=x+(tg2_fbm2(noise,x,z,seed+700.0,1.0,warp_amp,1.0).round() as i32).clamp(-radius*2,radius*2);
            let wz=z+(tg2_fbm2(noise,z,x,seed+811.0,1.0,warp_amp,1.0).round() as i32).clamp(-radius*2,radius*2);
            let (mut hsum,mut hcnt)=(0i64,0i64);
            let mut paints: Vec<u8> = Vec::new();
            for dx in -radius..=radius { for dz in -radius..=radius {
                let (nx,nz)=(wx+dx,wz+dz);
                if nx<0||nz<0||nx>=gs||nz>=gs { continue; }
                let (nh,nbt,npt)=surf[sidx(nx,nz)];
                if nh<1 || !natural(nbt) { continue; }
                hsum+=nh as i64; hcnt+=1;
                paints.push(npt);
            }}
            if hcnt==0 { continue; }
            let avg=(hsum as f64/hcnt as f64).round() as i32;
            // Move halfway toward the blurred average (both up and down).
            let target=h+(((avg-h) as f64*0.5).round() as i32);
            // Dithered palette blend: pick one neighbour's paint by a stable hash,
            // so a seam between two palettes resolves to a speckled gradient rather
            // than averaging to a meaningless third hue.
            let hsh=((x as u32).wrapping_mul(73856093)^(z as u32).wrapping_mul(19349663)) as usize;
            let pt=if paints.is_empty(){0}else{paints[hsh%paints.len()]};
            plan.push((x,z,target.clamp(1,th-1),bt,pt));
        }}
        if plan.is_empty() { break; }
        // Pass 2: apply. Raise by stacking the column's own material; lower by
        // carving to air. Always retint the resulting surface cell.
        for (x,z,target,bt,pt) in &plan {
            let (h,_,_)=surf[sidx(*x,*z)];
            if *target>h {
                for y in h+1..=*target { g.put(*x,*z,y,*bt,*pt); }
            } else if *target<h {
                for y in *target+1..=h { g.set_bt(*x,*z,y,0); }
            }
            g.put(*x,*z,*target,*bt,*pt);
            surf[sidx(*x,*z)]=(*target,*bt,*pt);
        }
    }
}

fn tg2_place_clouds(g: &mut Tg2Grid, rng: &mut Rng64) {
    let gs=g.gsize as i32; let th=g.t_height as i32;
    let cz=(th*4/5).min(th-4);
    let n=((gs*gs/500).max(2)) as u64;
    for _ in 0..n {
        let cx=(rng.next()%gs as u64) as i32; let czr=(rng.next()%gs as u64) as i32;
        let w=(rng.next()%12+6) as i32; let d=(rng.next()%12+6) as i32;
        // Vary the slab height a little so clouds don't all sit on one flat plane.
        let yj=(rng.next()%5) as i32-2;
        let cy=(cz+yj).clamp(th/2,th-2);
        for dx in 0..w { for dz in 0..d {
            let (px,pz)=(cx+dx,czr+dz);
            if px<0||pz<0||px>=gs||pz>=gs { continue; }
            // Skip cells where terrain already rises into the cloud layer, so a
            // cloud never buries a mountain top.
            if g.get(px,pz,cy)!=0 { continue; }
            g.put(px,pz,cy,19,0);
        }}
    }
}

fn generate_tg2_world(
    cfg: &Tg2Config,
    wc: usize, hc: usize, t_height: usize,
    chunks: &mut Vec<Vec<u8>>,
    mut report: &mut dyn FnMut(&str, f32),
) -> u32 {
    let gsize=wc*16;
    // Generate at the full world height. `vs` scales every amplitude & z-band so
    // 256z worlds proportionally fill the headroom (64z → vs=1.0, unchanged).
    let tg2_h=t_height;
    let vs=(tg2_h as f64/64.0).max(1.0);
    let noise=ClassicNoise::new(cfg.seed);
    let seed=cfg.seed as f64;
    let seed2=cfg.seed as f64+123.0;
    let mut rng=Rng64::new(cfg.seed as u64^0xDEAD_C0DE_B16B_00B5);
    report("Initialising",0.0);
    let mut g=Tg2Grid::new(gsize,tg2_h,vs,cfg.amplitude.max(0.1),cfg.sea_level_off);
    // bedrock floor (clear() equivalent)
    for x in 0..gsize as i32 { for z in 0..gsize as i32 { g.set_bt(x,z,0,1); g.set_bt(x,z,1,1); } }
    // scale structure counts proportionally to world area vs canonical 2880×2880
    let sf=(gsize as f64/2880.0).powi(2);
    let ff=match cfg.struct_freq{0=>0.3f64,1=>1.0,_=>2.0};
    let pf=((175.0*sf*ff).round() as u32).max(1).min(500);
    let vf=((20.0*sf*ff).round() as u32).max(1).min(20);
    report("Generating terrain",0.05);
    let gs=gsize as i32;
    match cfg.terrain_type {
        0 => { tg2_make_dirt(&mut g,&noise,seed,0,0,gs,gs); report("Generating terrain",0.67); }
        1 => { tg2_make_mars(&mut g,&noise,seed,0,0,gs,gs); report("Generating terrain",0.67); }
        2 => { tg2_make_river_trees(&mut g,&noise,seed,&mut rng,0,0,gs,gs); report("Generating terrain",0.67); }
        3 => {
            let mid=gs/2;
            tg2_make_river_trees(&mut g,&noise,seed,&mut rng,mid,0,gs,gs);
            report("Generating terrain",0.35);
            tg2_make_mountains(&mut g,&noise,seed,&mut rng,0,0,(mid-32).max(0),gs);
            report("Generating terrain",0.56);
            tg2_make_transition(&mut g,&noise,seed,(mid-32).max(0),0,mid,gs);
            report("Generating terrain",0.67);
        }
        4 => { tg2_make_desert(&mut g,&noise,seed,&mut rng,0,0,gs,gs,pf); report("Generating terrain",0.67); }
        5 => { tg2_make_ponies(&mut g,&noise,seed,0,0,gs,gs); report("Generating terrain",0.67); }
        6 => { tg2_make_beach(&mut g,&noise,seed,&mut rng,0,0,gs,gs); report("Generating terrain",0.67); }
        7 => tg2_make_mix(&mut g,&noise,seed,seed2,&mut rng,pf,vf,&mut report),
        9 => tg2_make_custom_mix(&mut g,&noise,seed,&mut rng,&cfg.custom_biomes,pf,&mut report),
        _ => {} // Flat / unknown: bedrock only
    }
    if cfg.caves && cfg.terrain_type!=8 {
        report("Carving caves",0.70);
        tg2_carve_caves(&mut g,&noise,seed as f64,cfg.tall_caves);
    }
    if cfg.blend && cfg.terrain_type!=8 {
        report("Blending biomes",0.74);
        // Fewer, wider-kernel passes now smooth in both directions, so the old
        // 24-iteration talus count is overkill; ~6·vs gives gentle seams.
        tg2_blend_seams(&mut g,&noise,seed,(6.0*vs).round() as i32);
    }
    report("Placing features",0.79);
    if cfg.sky_islands && cfg.terrain_type!=7 && cfg.terrain_type!=9 {
        let ni=((gsize as f64/300.0*6.0) as i32).max(1);
        for _ in 0..ni {
            let rs=(rng.next()%20+5) as i32;
            let rx=rs+(rng.next()%((gsize as i64-rs as i64*2).max(2) as u64)) as i32;
            let rz=rs+(rng.next()%((gsize as i64-rs as i64*2).max(2) as u64)) as i32;
            tg2_make_sky_island(&mut g,rx,rz,rs,&mut rng);
        }
    }
    if cfg.clouds { tg2_place_clouds(&mut g,&mut rng); }
    // ensure bedrock floor
    for x in 0..gs { for z in 0..gs { g.set_bt(x,z,0,1); } }
    let water_mask=vec![false;gsize*gsize];
    let mut gen=WorldGen{chunks,wc,hc,t_height,water_mask:&water_mask};
    tg2_flush(&g,&mut gen,&mut report);
    // surface z at world centre
    let cx=gsize as i32/2; let cz=gsize as i32/2;
    let mut surf=tg2_h as i32/2;
    for y in (0..tg2_h as i32).rev() { if g.get(cx,cz,y)!=0{surf=y+1;break;} }
    surf as u32
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn create_tg2_world(
    app: tauri::AppHandle,
    path: String, name: String,
    size_chunks: u32, extended_z: bool,
    seed: u32, terrain_type: u8,
    sky_islands: bool, struct_freq: u32, clouds: bool,
    amplitude: f64, sea_level_off: i32, blend: bool,
    caves: bool, tall_caves: bool,
    custom_biomes: Option<Vec<u8>>,
) -> Result<(),String> {
    if size_chunks==0 { return Err("Size must be ≥ 1 chunk".into()); }
    if size_chunks>180 { return Err("Maximum TG2 world size is 180×180 chunks (2880×2880 blocks)".into()); }
    let mut report=gen_progress_reporter(app);
    let wc=size_chunks as usize; let hc=wc;
    let t_height=if extended_z{256}else{64};
    let chunk_size=if extended_z{131_072usize}else{32_768usize};
    let cb=custom_biomes.unwrap_or_default();
    let custom_biomes_arr=[
        cb.first().copied().unwrap_or(0),
        cb.get(1).copied().unwrap_or(6),
        cb.get(2).copied().unwrap_or(4),
        cb.get(3).copied().unwrap_or(2),
    ];
    let cfg=Tg2Config{seed,terrain_type,sky_islands,struct_freq,clouds,
        amplitude:amplitude.clamp(0.1,4.0),sea_level_off:sea_level_off.clamp(-16,32),blend,
        caves,tall_caves,custom_biomes:custom_biomes_arr};
    let mut chunks:Vec<Vec<u8>>=(0..wc*hc).map(|_|vec![0u8;chunk_size]).collect();
    let surf=generate_tg2_world(&cfg,wc,hc,t_height,&mut chunks,&mut report);
    report("Writing file",0.97);
    const CENTER_CHUNK:i32=4096;
    let res=write_world_file(&path,&name,wc as u32,hc as u32,chunk_size,CENTER_CHUNK,CENTER_CHUNK,surf,&chunks);
    report("Done",1.0);
    res
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn preview_tg2_world(
    size_chunks: u32, seed: u32, terrain_type: u8, max_px: u32,
    custom_biomes: Option<Vec<u8>>,
    extended_z: Option<bool>, amplitude: Option<f64>, sea_level_off: Option<i32>,
) -> Result<PreviewImage,String> {
    if size_chunks==0 { return Err("Size must be ≥ 1".into()); }
    let gsize=(size_chunks as usize*16).min(2880);
    let noise=ClassicNoise::new(seed);
    let sf=seed as f64; let sf2=seed as f64+123.0;
    let cap=max_px.clamp(32,512) as usize;
    let step=((gsize+cap-1)/cap).max(1);
    let pw=(gsize+step-1)/step;
    let mut pixels=vec![0u8;pw*pw*4];
    let gs=gsize as i32;
    // Reflect the same vertical envelope the generator uses so the preview tracks
    // the height-format, amplitude and sea-level knobs (still a fast heightmap-only
    // approximation: no fill, caves, structures or blend).
    let th=if extended_z.unwrap_or(false){256i32}else{64i32};
    let vs=th as f64/64.0;
    let amp=amplitude.unwrap_or(1.0).clamp(0.1,4.0)*vs; // relief multiplier
    let sea=(sea_level_off.unwrap_or(0) as f64)*vs;     // additive water-level shift
    let bl=|n:f64| n*vs;                                // scale a baseline constant
    // helper: per-pixel colour for a single biome type
    let preview_biome=|biome:u8,wx:i32,wz:i32,gs:i32|->(i32,u8,u8){
        match biome {
            0 => {let h=(bl(32.0)+tg2_fbm2(&noise,wx,wz,sf,2.0,4.0*amp,3.0)).round()as i32;(h,8u8,0u8)}
            1 => {let h=(bl(8.0)+tg2_fbm2(&noise,wx,wz,sf,2.0,4.0*amp,3.0)).round()as i32;(h,2u8,tg2_cc2(h,0))}
            2 => {let n=bl(22.0)+tg2_fbm2(&noise,wx,wz,sf,1.0,20.0*amp,3.0);let h=n.round()as i32;let bt=if (h as f64)<bl(15.0)+sea{20u8}else{8u8};(h,bt,0u8)}
            3 => {if wx<gs/2{let h=(bl(22.0)+tg2_fbm2(&noise,wx,wz,sf,1.0,20.0*amp,3.0)).round()as i32;(h,2u8,tg2_cc5(h+50,8))}
                  else      {let n=bl(22.0)+tg2_fbm2(&noise,wx,wz,sf,1.0,20.0*amp,3.0);let h=n.round()as i32;let bt=if (h as f64)<bl(15.0)+sea{20u8}else{8u8};(h,bt,0u8)}}
            4 => {let h=bl(22.0)as i32;(h,4u8,tg2_cc6(h+13,1))}
            5 => {let h=(bl(22.0)+tg2_fbm2(&noise,wx,wz,sf,2.0,4.0*amp,3.0)).round()as i32;(h,2u8,tg2_cc2(h,6))}
            6 => {let n=(bl(18.0)+tg2_fbm2(&noise,wx,wz,sf,1.0,18.0*amp,3.0))/9.0+bl(18.0)+sea;let h=n.round()as i32;let bt=if (h as f64)<bl(19.0)+sea{20u8}else{4u8};(h,bt,tg2_cc6(h+13,1))}
            _ => (2i32,1u8,0u8) // flat/unknown
        }
    };
    let cb=custom_biomes.unwrap_or_default();
    let cba=[cb.first().copied().unwrap_or(0),cb.get(1).copied().unwrap_or(6),
              cb.get(2).copied().unwrap_or(4),cb.get(3).copied().unwrap_or(2)];
    for px in 0..pw { for py in 0..pw {
        let wx=(px*step) as i32; let wz=(py*step) as i32;
        let (h,bt,paint)=match terrain_type {
            9 => { // custom mix: 4 quadrants
                let q=if wx<gs/2{if wz<gs/2{0}else{2}}else{if wz<gs/2{1}else{3}};
                preview_biome(cba[q],wx,wz,gs)
            }
            7 => {
                if wx<gs/4&&wz<gs/4      {let h=(bl(22.0)+tg2_fbm2(&noise,wx,wz,sf,1.0,20.0*amp,3.0)).round()as i32;(h,2u8,tg2_cc5(h+50,8))}
                else if wx>=3*gs/4        {(bl(8.0)as i32,2u8,tg2_cc2(8,0))}
                else if wz>=3*gs/4        {let h=((bl(18.0)+tg2_fbm2(&noise,wx,wz,sf,1.0,18.0*amp,3.0)/9.0) as i32).max(2).min(bl(21.0)as i32);(h,4u8,0u8)}
                else                      {let n=bl(21.0)+tg2_fbm2(&noise,wx,wz,sf2,1.0,8.0*amp,3.0);let h=(n.min(bl(31.0))).round()as i32;(h,8u8,tg2_cc3(h+30,3))}
            }
            t => preview_biome(t,wx,wz,gs)
        };
        let h=h.max(0).min(th-1);
        let hr=(h+1).min(th-1);
        let [r,gr,b]=block_color(bt,paint,14);
        let shade=(1.0+(hr-h) as f64*0.04).clamp(0.6,1.4);
        let ri=((r as f64*shade).round()as u32).min(255)as u8;
        let gi=((gr as f64*shade).round()as u32).min(255)as u8;
        let bi=((b as f64*shade).round()as u32).min(255)as u8;
        let i=(py*pw+px)*4;
        pixels[i]=ri;pixels[i+1]=gi;pixels[i+2]=bi;pixels[i+3]=255;
    }}
    Ok(PreviewImage{width:pw as u32,height:pw as u32,pixels})
}

/// Move the player spawn/home position to the given editor-coordinate pixel (px, py).
/// Height is resolved to one block above the surface. The change is written to the in-memory
/// mmap and persists the next time the world is saved.
#[tauri::command]
fn set_spawn_pos(px: i32, py: i32, state: tauri::State<'_, AppState>) -> Result<(f32, f32), String> {
    let mut ws = state.lock().unwrap();
    let world = ws.world.as_mut().ok_or("No world loaded")?;
    write_spawn(world, px as f32, py as f32);
    Ok((px as f32, py as f32))
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

#[derive(serde::Serialize)]
struct PickedBlock { block_type: u8, paint: u8 }

/// Return the surface Z, block type, and paint at (wx, wy). Used by status bar cursor info.
/// Returns None if no world loaded or column is empty.
#[tauri::command]
fn get_cursor_block(state: tauri::State<'_, AppState>, wx: i32, wy: i32) -> Option<[i32; 3]> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref()?;
    let z = surface_z(world, wx, wy)?;
    let (bt, paint) = get_block_at(world, wx, wy, z);
    Some([z, bt as i32, paint as i32])
}

/// Return the block type and paint at the surface of (wx, wy).
/// Returns air (0,0) if the column is empty or out of bounds.
#[tauri::command]
fn pick_block_surface(state: tauri::State<'_, AppState>, wx: i32, wy: i32) -> Result<PickedBlock, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("no world")?;
    let z = surface_z(world, wx, wy).unwrap_or(0);
    let (bt, paint) = get_block_at(world, wx, wy, z);
    Ok(PickedBlock { block_type: bt, paint })
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
fn place_leaf_abs(sink: &mut impl VoxelSink, wx: i32, wy: i32, wz: i32, paint: u8) {
    sink.put(wx, wy, wz, 5, paint);
}

/// Block types that trees should not grow on (air, water, lava, cloud, foliage).
fn is_plantable(bt: u8) -> bool {
    !matches!(bt, 0 | 5 | 6 | 19 | 20 | 23 | 59 | 60 | 61 | 62 | 63 | 64)
}

// Leaf paint palettes — indices into PAINTED (paint byte = index + 1).
// 0 = unpainted = dark green [10,63,13]; 22=[0,255,64]; 31=[0,191,48]; 40=[0,128,32]; 49=[0,64,16]
const NORMAL_LEAF_PAINTS: [u8; 4] = [0, 22, 31, 40];
const PINE_LEAF_PAINTS:   [u8; 3] = [31, 40, 49];
// Snow biome: frosted foliage (white + light gray) and cold flowers (white + blue).
const SNOW_LEAF_PAINTS:   [u8; 2] = [9, 18];     // white, 80% light gray
const SNOW_FLOWER_PAINTS: [u8; 3] = [9, 6, 15];  // white, light blue, blue

/// Deciduous mushroom-shaped tree (ported from NormalTree in reference, bug fixed: trunk placed
/// after leaves so the log shows through the canopy, not overwritten by leaf blocks).
/// `trunk_h` (log count) and `leaf_paint` are caller-chosen so both the editor tool and the
/// world generator can control trunk height / canopy tint.
fn place_normal_tree(world: &mut impl VoxelSink, wx: i32, wy: i32, z_base: i32, trunk_h: i32, leaf_paint: u8) {
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
    for dz in 0..trunk_h { world.put(wx, wy, z_base + dz, 6, 0); }
}

/// Tall terrain tree with wide ragged canopy (ported from NormalTerrainTree).
/// Bug fixed: trunk placed after leaves so it remains visible through canopy.
fn place_terrain_tree(world: &mut impl VoxelSink, wx: i32, wy: i32, z_base: i32, rng: &mut Rng64, leaf_paint: u8) {
    let tree_h    = rng.range(6, 11);
    let trunk_h   = 3 * tree_h / 4;
    let leaf_dz0  = 2 * tree_h / 3; // first leaf layer (rel to z_base)

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
    for dz in 0..trunk_h { world.put(wx, wy, z_base + dz, 6, 0); }
}

/// Small conical pine tree (ported from PineTree). `leaf_override` forces a leaf
/// paint (e.g. frosted white in snow biomes); `None` picks a random green.
fn place_pine_tree(world: &mut impl VoxelSink, wx: i32, wy: i32, z_base: i32, rng: &mut Rng64, leaf_override: Option<u8>) {
    let leaf_paint = leaf_override.unwrap_or_else(|| PINE_LEAF_PAINTS[rng.range(0, 2) as usize]);

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
    world.put(wx, wy, z_base,     6, 0);
    world.put(wx, wy, z_base + 1, 6, 0);
}

/// Tall conical pine tree with 7×7 base tiers (ported from TallPineTree).
fn place_tall_pine_tree(world: &mut impl VoxelSink, wx: i32, wy: i32, z_base: i32, rng: &mut Rng64, leaf_paint: u8) {

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
                                world.put(wx + dx, wy + dy, wz, 0, 0);
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
    world.put(wx, wy, z_base,     6, 0);
    world.put(wx, wy, z_base + 1, 6, 0);
}

/// Pick a leaf paint from the user-supplied pool, falling back to the type's default pool.
fn pick_leaf_paint(user: &[u8], default: &[u8], rng: &mut Rng64) -> u8 {
    let pool = if user.is_empty() { default } else { user };
    pool[rng.range(0, pool.len() as i32 - 1) as usize]
}

/// Scatter trees across the XY footprint of the current selection.
/// Each column in (x1..=x2, y1..=y2) is independently rolled against `density` (0–1).
/// Trees are planted on the topmost solid block; columns over water, lava, cloud, or
/// existing foliage are skipped. `seed` = None uses a random timestamp-based seed.
/// `tree_types` may include multiple types; each column picks one randomly.
/// `leaf_paints` is the user's chosen paint pool; empty = type-appropriate defaults.
#[tauri::command]
fn generate_trees(
    x1: i32, y1: i32, x2: i32, y2: i32,
    tree_types: Vec<String>,
    density: f32,
    leaf_paints: Vec<u8>,
    seed: Option<u64>,
    smart_placement: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    if tree_types.is_empty() {
        return Err("No tree types selected".into());
    }
    for t in &tree_types {
        if !matches!(t.as_str(), "normal" | "terrain" | "pine" | "tall_pine") {
            return Err(format!("Unknown tree type '{t}'"));
        }
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

            if smart_placement {
                if !matches!(surf_bt, 3 | 8) { continue; }
            } else if !is_plantable(surf_bt) { continue; }

            let z_base = sz + 1;
            if z_base > max_z { continue; }

            let chosen_type = &tree_types[rng.range(0, tree_types.len() as i32 - 1) as usize];
            match chosen_type.as_str() {
                "normal"    => {
                    let trunk_h = rng.range(3, 8);
                    let lp = pick_leaf_paint(&leaf_paints, &NORMAL_LEAF_PAINTS, &mut rng);
                    place_normal_tree(&mut world, wx, wy, z_base, trunk_h, lp);
                }
                "terrain"   => {
                    let lp = pick_leaf_paint(&leaf_paints, &NORMAL_LEAF_PAINTS, &mut rng);
                    place_terrain_tree(&mut world, wx, wy, z_base, &mut rng, lp);
                }
                "pine"      => {
                    let lp = pick_leaf_paint(&leaf_paints, &PINE_LEAF_PAINTS, &mut rng);
                    place_pine_tree(&mut world, wx, wy, z_base, &mut rng, Some(lp));
                }
                "tall_pine" => {
                    let lp = pick_leaf_paint(&leaf_paints, &PINE_LEAF_PAINTS, &mut rng);
                    place_tall_pine_tree(&mut world, wx, wy, z_base, &mut rng, lp);
                }
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
    dir: u8, // 0=SE 1=SW 2=NE 3=NW
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
    let (sx_sgn, sy_sgn): (f32, f32) = match dir {
        1 => (-1.0, -1.0), // SW
        2 => ( 1.0,  1.0), // NE
        3 => (-1.0,  1.0), // NW
        _ => ( 1.0, -1.0), // SE (default)
    };

    for py in oy1..=oy2 {
        for px in ox1..=ox2 {
            let mut top_bt = 0u8; let mut top_paint = 0u8;
            let mut under_bt = 0u8; let mut under_paint = 0u8;

            'zray: for dz in 0..=(max_z as i32) {
                let wz = (max_z as i32) - dz;
                let sx = (px as f32 + sx_sgn * ski * 0.5 * dz as f32).round() as i32;
                let sy = (py as f32 + sy_sgn * ski * dz as f32).round() as i32;
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

/// Axonometric preview of the clipboard contents for the 3D tab in SelectionInspector.
/// Same projection math as render_axo_region but iterates in-memory clipboard voxels.
#[tauri::command]
fn render_axo_clipboard(ski: f32, dir: u8, state: tauri::State<'_, AppState>) -> Result<PreviewData, String> {
    let ws  = state.lock().unwrap();
    let sky = ws.world.as_ref().map(|w| w.sky).unwrap_or(0);
    let cb  = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
    let (cw, ch, cd) = (cb.width, cb.height, cb.depth);

    let mut pixels = vec![30u8; (cw * ch * 4) as usize];
    for p in pixels.chunks_exact_mut(4) { p[3] = 255; }
    let (sx_sgn, sy_sgn): (f32, f32) = match dir {
        1 => (-1.0, -1.0), // SW
        2 => ( 1.0,  1.0), // NE
        3 => (-1.0,  1.0), // NW
        _ => ( 1.0, -1.0), // SE (default)
    };

    for py in 0..ch {
        for px in 0..cw {
            let mut top_bt = 0u8; let mut top_paint = 0u8;
            let mut under_bt = 0u8; let mut under_paint = 0u8;

            'zray: for dz in 0..cd {
                let cb_layer = cd - 1 - dz; // top clipboard layer first
                let sx = (px as f32 + sx_sgn * ski * 0.5 * dz as f32).round() as i32;
                let sy = (py as f32 + sy_sgn * ski * dz as f32).round() as i32;
                if sx < 0 || sx >= cw || sy < 0 || sy >= ch { continue; }
                let idx = (cb_layer * ch * cw + sy * cw + sx) as usize;
                if idx >= cb.block_types.len() { continue; }
                let bt = cb.block_types[idx];
                if bt == 0 { continue; }
                if top_bt == 0 {
                    top_bt = bt; top_paint = cb.paints[idx];
                    if transparent_alpha(bt).is_none() { break 'zray; }
                } else {
                    under_bt = bt; under_paint = cb.paints[idx];
                    break 'zray;
                }
            }

            if top_bt == 0 { continue; }
            let c1 = block_color(top_bt, top_paint, sky);
            let [r, g, b] = if under_bt != 0 {
                if let Some(alpha) = transparent_alpha(top_bt) {
                    let c2 = block_color(under_bt, under_paint, sky);
                    [
                        (c1[0] as f32 * alpha + c2[0] as f32 * (1.0 - alpha)) as u8,
                        (c1[1] as f32 * alpha + c2[1] as f32 * (1.0 - alpha)) as u8,
                        (c1[2] as f32 * alpha + c2[2] as f32 * (1.0 - alpha)) as u8,
                    ]
                } else { c1 }
            } else { c1 };

            let off = ((py * cw + px) * 4) as usize;
            pixels[off] = r; pixels[off + 1] = g; pixels[off + 2] = b; pixels[off + 3] = 255;
        }
    }

    Ok(PreviewData { width: cw as u32, height: ch as u32, pixels })
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

/// True if this block fully occludes an adjacent face (not air, not notsolid, not ramp/wedge).
fn obj_occludes(bt: u8) -> bool {
    let idx = bt as usize;
    idx != 0 && idx < BLOCK_INFO.len() && (BLOCK_INFO[idx] & (BI_NOTSOLID | BI_RAMPORSIDE)) == 0
}

/// Eden (X right, Y south, Z up) → OBJ (X right, Y up, Z toward viewer)
fn ov(ex: f32, ey: f32, ez: f32) -> (f32, f32, f32) { (ex, ez, -ey) }

fn obj_v(w: &mut impl Write, (x, y, z): (f32, f32, f32)) -> std::io::Result<()> {
    writeln!(w, "v {x} {y} {z}")
}

fn obj_quad(w: &mut impl Write) -> std::io::Result<()> { writeln!(w, "f -4 -3 -2 -1") }
fn obj_tri(w: &mut impl Write)  -> std::io::Result<()> { writeln!(w, "f -3 -2 -1") }

fn write_vox_chunk(buf: &mut Vec<u8>, id: &[u8; 4], content: &[u8]) {
    buf.extend_from_slice(id);
    buf.extend_from_slice(&(content.len() as i32).to_le_bytes());
    buf.extend_from_slice(&0i32.to_le_bytes()); // children_size always 0 for leaf chunks
    buf.extend_from_slice(content);
}

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
/// The vertical wall and end-cap triangles are culled against adjacent solid blocks to prevent z-fighting.
fn emit_ramp(w: &mut impl Write, wx: i32, wy: i32, wz: i32, dir: u8, world: &LoadedWorld) -> std::io::Result<()> {
    let (x0, x1) = (wx as f32, wx as f32 + 1.0);
    let (y0, y1) = (wy as f32, wy as f32 + 1.0);
    let (z0, z1) = (wz as f32, wz as f32 + 1.0);
    let solid_s = obj_occludes(get_block_at(world, wx, wy + 1, wz).0);
    let solid_n = obj_occludes(get_block_at(world, wx, wy - 1, wz).0);
    let solid_e = obj_occludes(get_block_at(world, wx + 1, wy, wz).0);
    let solid_w = obj_occludes(get_block_at(world, wx - 1, wy, wz).0);
    // Bottom — cull if solid below
    if !obj_occludes(get_block_at(world, wx, wy, wz - 1).0) {
        obj_v(w, ov(x0,y1,z0))?; obj_v(w, ov(x1,y1,z0))?;
        obj_v(w, ov(x1,y0,z0))?; obj_v(w, ov(x0,y0,z0))?;
        obj_quad(w)?;
    }
    match dir {
        0 => { // South: high edge at +Y
            if !solid_s { obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x0,y1,z1))?; obj_quad(w)?; }
            if !solid_w { obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_tri(w)?; }
            if !solid_e { obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_tri(w)?; }
            obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x0,y1,z1))?; obj_quad(w)?;
        }
        1 => { // West: high edge at -X
            if !solid_w { obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_quad(w)?; }
            if !solid_s { obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_tri(w)?; }
            if !solid_n { obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y0,z1))?; obj_tri(w)?; }
            obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_quad(w)?;
        }
        2 => { // North: high edge at -Y
            if !solid_n { obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y0,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_quad(w)?; }
            if !solid_e { obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y0,z1))?; obj_tri(w)?; }
            if !solid_w { obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y0,z1))?; obj_tri(w)?; }
            obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y0,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_quad(w)?;
        }
        _ => { // East (dir=3): high edge at +X
            if !solid_e { obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y0,z1))?; obj_v(w,ov(x1,y1,z1))?; obj_quad(w)?; }
            if !solid_n { obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y0,z1))?; obj_tri(w)?; }
            if !solid_s { obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_tri(w)?; }
            obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y0,z1))?; obj_v(w,ov(x1,y1,z1))?; obj_quad(w)?;
        }
    }
    Ok(())
}

/// Emit a wedge as a pyramid (1 apex, 4 base corners). dir: 0=SE 1=SW 2=NW 3=NE (apex at opposite corner).
/// The two vertical faces at the apex corner are culled against adjacent solid blocks.
fn emit_wedge(w: &mut impl Write, wx: i32, wy: i32, wz: i32, dir: u8, world: &LoadedWorld) -> std::io::Result<()> {
    let (x0, x1) = (wx as f32, wx as f32 + 1.0);
    let (y0, y1) = (wy as f32, wy as f32 + 1.0);
    let (z0, z1) = (wz as f32, wz as f32 + 1.0);
    let solid_s = obj_occludes(get_block_at(world, wx, wy + 1, wz).0);
    let solid_n = obj_occludes(get_block_at(world, wx, wy - 1, wz).0);
    let solid_e = obj_occludes(get_block_at(world, wx + 1, wy, wz).0);
    let solid_w = obj_occludes(get_block_at(world, wx - 1, wy, wz).0);
    // Wedges are vertical triangular prisms (full Z height, triangle footprint in XY).
    // Each wedge occupies the diagonal half named by its direction.
    // Two axis-aligned rectangular faces at the named sides + one diagonal 45° rectangular face.
    match dir {
        0 => { // SE: triangle NE(x1,y0)-SE(x1,y1)-SW(x0,y1). East+South faces; diagonal NE↔SW.
            // Bottom triangle
            if !obj_occludes(get_block_at(world, wx, wy, wz-1).0) {
                obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_tri(w)?;
            }
            // Top triangle
            if !obj_occludes(get_block_at(world, wx, wy, wz+1).0) {
                obj_v(w,ov(x1,y0,z1))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x1,y1,z1))?; obj_tri(w)?;
            }
            if !solid_e { obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_quad(w)?; }
            if !solid_s { obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x1,y1,z1))?; obj_quad(w)?; }
            obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_quad(w)?; // diag
        }
        1 => { // SW: triangle NW(x0,y0)-SW(x0,y1)-SE(x1,y1). West+South faces; diagonal NW↔SE.
            if !obj_occludes(get_block_at(world, wx, wy, wz-1).0) {
                obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_tri(w)?;
            }
            if !obj_occludes(get_block_at(world, wx, wy, wz+1).0) {
                obj_v(w,ov(x0,y0,z1))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x0,y1,z1))?; obj_tri(w)?;
            }
            if !solid_w { obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_quad(w)?; }
            if !solid_s { obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x0,y1,z1))?; obj_quad(w)?; }
            obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_quad(w)?; // diag
        }
        2 => { // NW: triangle NE(x1,y0)-NW(x0,y0)-SW(x0,y1). North+West faces; diagonal NE↔SW.
            if !obj_occludes(get_block_at(world, wx, wy, wz-1).0) {
                obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_tri(w)?;
            }
            if !obj_occludes(get_block_at(world, wx, wy, wz+1).0) {
                obj_v(w,ov(x1,y0,z1))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_tri(w)?;
            }
            if !solid_n { obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y0,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_quad(w)?; }
            if !solid_w { obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_quad(w)?; }
            obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x0,y1,z0))?; obj_v(w,ov(x0,y1,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_quad(w)?; // diag
        }
        _ => { // NE: triangle NW(x0,y0)-NE(x1,y0)-SE(x1,y1). North+East faces; diagonal NW↔SE.
            if !obj_occludes(get_block_at(world, wx, wy, wz-1).0) {
                obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_tri(w)?;
            }
            if !obj_occludes(get_block_at(world, wx, wy, wz+1).0) {
                obj_v(w,ov(x0,y0,z1))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_tri(w)?;
            }
            if !solid_n { obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y0,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_quad(w)?; }
            if !solid_e { obj_v(w,ov(x1,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x1,y0,z1))?; obj_quad(w)?; }
            obj_v(w,ov(x0,y0,z0))?; obj_v(w,ov(x1,y1,z0))?; obj_v(w,ov(x1,y1,z1))?; obj_v(w,ov(x0,y0,z1))?; obj_quad(w)?; // diag
        }
    }
    Ok(())
}

/// Greedy 2-D rectangle merger. Covers every cell in `cells` with non-overlapping axis-aligned
/// rectangles. Returns (u_min, v_min, u_max, v_max) in inclusive coordinates.
fn greedy_mesh_2d(cells: &HashSet<(i32, i32)>) -> Vec<(i32, i32, i32, i32)> {
    let mut remaining = cells.clone();
    let mut sorted: Vec<(i32, i32)> = remaining.iter().cloned().collect();
    sorted.sort_unstable();
    let mut rects = Vec::new();
    for (u0, v0) in sorted {
        if !remaining.contains(&(u0, v0)) { continue; }
        let mut u1 = u0;
        while remaining.contains(&(u1 + 1, v0)) { u1 += 1; }
        let mut v1 = v0;
        loop {
            if !(u0..=u1).all(|u| remaining.contains(&(u, v1 + 1))) { break; }
            v1 += 1;
        }
        for u in u0..=u1 { for v in v0..=v1 { remaining.remove(&(u, v)); } }
        rects.push((u0, v0, u1, v1));
    }
    rects
}

/// Emit one merged quad for a greedy-meshed transparent face.
/// dir: 0=+Z(top) 1=-Z(bot) 2=+Y(S) 3=-Y(N) 4=+X(E) 5=-X(W)
/// plane: the block coordinate perpendicular to the face.
/// u/v are the two in-plane block coordinates (inclusive range u0..=u1, v0..=v1).
fn emit_merged_quad(w: &mut impl Write, dir: u8, plane: i32, u0: i32, v0: i32, u1: i32, v1: i32) -> std::io::Result<()> {
    let (u0f, u1f) = (u0 as f32, (u1 + 1) as f32);
    let (v0f, v1f) = (v0 as f32, (v1 + 1) as f32);
    let pf = plane as f32;
    match dir {
        0 => { // +Z top  — plane=wz, u=wx, v=wy, face at z=plane+1
            obj_v(w,ov(u0f,v0f,pf+1.0))?; obj_v(w,ov(u1f,v0f,pf+1.0))?;
            obj_v(w,ov(u1f,v1f,pf+1.0))?; obj_v(w,ov(u0f,v1f,pf+1.0))?; obj_quad(w)?;
        }
        1 => { // -Z bot  — plane=wz, u=wx, v=wy, face at z=plane
            obj_v(w,ov(u0f,v1f,pf))?; obj_v(w,ov(u1f,v1f,pf))?;
            obj_v(w,ov(u1f,v0f,pf))?; obj_v(w,ov(u0f,v0f,pf))?; obj_quad(w)?;
        }
        2 => { // +Y S    — plane=wy, u=wx, v=wz, face at y=plane+1
            obj_v(w,ov(u0f,pf+1.0,v0f))?; obj_v(w,ov(u1f,pf+1.0,v0f))?;
            obj_v(w,ov(u1f,pf+1.0,v1f))?; obj_v(w,ov(u0f,pf+1.0,v1f))?; obj_quad(w)?;
        }
        3 => { // -Y N    — plane=wy, u=wx, v=wz, face at y=plane
            obj_v(w,ov(u1f,pf,v0f))?; obj_v(w,ov(u0f,pf,v0f))?;
            obj_v(w,ov(u0f,pf,v1f))?; obj_v(w,ov(u1f,pf,v1f))?; obj_quad(w)?;
        }
        4 => { // +X E    — plane=wx, u=wy, v=wz, face at x=plane+1
            obj_v(w,ov(pf+1.0,u1f,v0f))?; obj_v(w,ov(pf+1.0,u0f,v0f))?;
            obj_v(w,ov(pf+1.0,u0f,v1f))?; obj_v(w,ov(pf+1.0,u1f,v1f))?; obj_quad(w)?;
        }
        _ => { // -X W    — plane=wx, u=wy, v=wz, face at x=plane
            obj_v(w,ov(pf,u0f,v0f))?; obj_v(w,ov(pf,u1f,v0f))?;
            obj_v(w,ov(pf,u1f,v1f))?; obj_v(w,ov(pf,u0f,v1f))?; obj_quad(w)?;
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

    // Transparent block faces are collected for greedy meshing (avoids per-block seam artifacts).
    // Layout: [face_dir 0..6][plane coord][material (bt,paint)] → set of (u,v) in-plane cells.
    // dir: 0=+Z(top) 1=-Z(bot) 2=+Y(S) 3=-Y(N) 4=+X(E) 5=-X(W)
    type MatCells = HashMap<(u8, u8), HashSet<(i32, i32)>>;
    let mut trans_faces: [HashMap<i32, MatCells>; 6] = Default::default();

    // Returns true if a face of a transparent block should be visible toward the given neighbour.
    let trans_visible = |nbt: u8, npaint: u8, self_bt: u8, self_paint: u8| -> bool {
        if nbt == 0 { return true; }
        if obj_occludes(nbt) { return false; }
        nbt != self_bt || npaint != self_paint
    };

    let mut cur_mat = String::new();

    for wz in sz1..=sz2 {
        for wy in sy1..=sy2 {
            for wx in sx1..=sx2 {
                let (bt, paint) = get_block_at(world, wx, wy, wz);
                if bt == 0 { continue; }

                // Transparent non-ramp blocks → collect faces for greedy meshing.
                if transparent_alpha(bt).is_some() && !matches!(bt, 24..=55) {
                    let m = (bt, paint);
                    macro_rules! collect {
                        ($dir:expr, $plane:expr, $u:expr, $v:expr, $nbt:expr, $npaint:expr) => {
                            if trans_visible($nbt, $npaint, bt, paint) {
                                trans_faces[$dir].entry($plane).or_default()
                                    .entry(m).or_default().insert(($u, $v));
                            }
                        };
                    }
                    let (nbt, npaint) = get_block_at(world, wx, wy, wz + 1);
                    collect!(0, wz, wx, wy, nbt, npaint);
                    let (nbt, npaint) = get_block_at(world, wx, wy, wz - 1);
                    collect!(1, wz, wx, wy, nbt, npaint);
                    let (nbt, npaint) = get_block_at(world, wx, wy + 1, wz);
                    collect!(2, wy, wx, wz, nbt, npaint);
                    let (nbt, npaint) = get_block_at(world, wx, wy - 1, wz);
                    collect!(3, wy, wx, wz, nbt, npaint);
                    let (nbt, npaint) = get_block_at(world, wx + 1, wy, wz);
                    collect!(4, wx, wy, wz, nbt, npaint);
                    let (nbt, npaint) = get_block_at(world, wx - 1, wy, wz);
                    collect!(5, wx, wy, wz, nbt, npaint);
                    continue;
                }

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

    // Greedy-mesh transparent faces and emit as merged quads.
    for dir in 0u8..6 {
        for (&plane, mat_cells) in &trans_faces[dir as usize] {
            let mut mats: Vec<(u8, u8)> = mat_cells.keys().cloned().collect();
            mats.sort_unstable();
            for &(bt, paint) in &mats {
                let mat = format!("m_{bt}_{paint}");
                if mat != cur_mat {
                    writeln!(ow, "\nusemtl {mat}").map_err(|e| e.to_string())?;
                    cur_mat = mat;
                }
                let rects = greedy_mesh_2d(&mat_cells[&(bt, paint)]);
                for (u0, v0, u1, v1) in rects {
                    emit_merged_quad(&mut ow, dir, plane, u0, v0, u1, v1)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }

    Ok(())
}

// ── JSON Export ────────────────────────────────────────────────────────────────

#[tauri::command]
fn export_json(
    state: tauri::State<'_, AppState>,
    path: String,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<u32, String> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;

    let sx1 = x1.min(x2); let sx2 = x1.max(x2);
    let sy1 = y1.min(y2); let sy2 = y1.max(y2);
    let sz1 = z_min.min(z_max).max(0);
    let sz2 = z_min.max(z_max).min(world_max_z(world));

    let format_str = if world.chunk_size >= 131072 { "256z" } else { "64z" };

    let f = fs::File::create(&path).map_err(|e| format!("Cannot create file: {e}"))?;
    let mut gz = GzEncoder::new(f, Compression::best());

    // Write header manually to avoid building a giant serde_json::Value in memory.
    let header = format!(
        "{{\n\
         \"generator\":\"VuencEdit\",\n\
         \"world_name\":{},\n\
         \"format\":\"{format_str}\",\n\
         \"width_blocks\":{},\n\
         \"height_blocks\":{},\n\
         \"max_z\":{},\n\
         \"sky\":{},\n\
         \"exported_bounds\":{{\"x1\":{sx1},\"y1\":{sy1},\"x2\":{sx2},\"y2\":{sy2},\"z_min\":{sz1},\"z_max\":{sz2}}},\n\
         \"blocks\":[\n",
        serde_json::to_string(&world.name).unwrap(),
        world.w_chunks * 16,
        world.h_chunks * 16,
        world_max_z(world),
        world.sky,
    );
    gz.write_all(header.as_bytes()).map_err(|e| e.to_string())?;

    let mut count: u32 = 0;
    let mut first = true;
    for wz in sz1..=sz2 {
        for wy in sy1..=sy2 {
            for wx in sx1..=sx2 {
                let (bt, paint) = get_block_at(world, wx, wy, wz);
                if bt == 0 { continue; }
                if !first { gz.write_all(b",\n").map_err(|e| e.to_string())?; }
                first = false;
                let line = format!("{{\"x\":{wx},\"y\":{wy},\"z\":{wz},\"t\":{bt},\"p\":{paint}}}");
                gz.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
                count += 1;
            }
        }
    }

    gz.write_all(b"\n]}\n").map_err(|e| e.to_string())?;
    gz.finish().map_err(|e| e.to_string())?;

    Ok(count)
}

// ── VOX Export ────────────────────────────────────────────────────────────────

#[tauri::command]
fn export_vox(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<u32, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;

    let sx1 = x1.min(x2); let sx2 = x1.max(x2);
    let sy1 = y1.min(y2); let sy2 = y1.max(y2);
    let sz1 = z_min.min(z_max).max(0);
    let sz2 = z_min.max(z_max).min(world_max_z(world));
    let total_z = (sz2 - sz1 + 1) as f32;

    // Throttled progress emitter — fires only when rounded integer pct advances.
    let mut last_pct = -1i32;
    let mut emit_progress = |phase: &str, frac: f32| {
        let pct = (frac * 100.0).round().clamp(0.0, 100.0) as i32;
        if pct != last_pct {
            last_pct = pct;
            let _ = app_handle.emit("vox-progress",
                serde_json::json!({ "phase": phase, "pct": pct }));
        }
    };

    // Pass 1: collect unique RGB values in encounter order (0–45% of progress).
    let mut unique_colors: Vec<[u8; 3]> = Vec::new();
    let mut seen: HashSet<[u8; 3]> = HashSet::new();
    for wz in sz1..=sz2 {
        emit_progress("Scanning colors", (wz - sz1) as f32 / total_z * 0.45);
        for wy in sy1..=sy2 {
            for wx in sx1..=sx2 {
                let (bt, paint) = get_block_at(world, wx, wy, wz);
                if bt == 0 { continue; }
                let rgb = block_color(bt, paint, world.sky);
                if seen.insert(rgb) { unique_colors.push(rgb); }
            }
        }
    }
    if unique_colors.is_empty() {
        return Err("No non-air blocks in the selected region".into());
    }

    // Build palette (max 255 entries; VOX color index 0 = empty).
    let n_colors = unique_colors.len();
    let palette: Vec<[u8; 3]> = unique_colors.iter().copied().take(255).collect();
    let mut color_to_idx: HashMap<[u8; 3], u8> = palette.iter().enumerate()
        .map(|(i, &rgb)| (rgb, (i + 1) as u8))
        .collect();

    // Nearest-neighbor quantization for any overflow colors (>255 unique).
    let overflow_count = n_colors.saturating_sub(255);
    if overflow_count > 0 {
        emit_progress(&format!("Quantizing palette ({overflow_count} overflow colors)"), 0.46);
        for &rgb in unique_colors.iter().skip(255) {
            let best = palette.iter().enumerate()
                .min_by_key(|(_, &p)| {
                    let d = |a: u8, b: u8| (a as i32 - b as i32).pow(2);
                    d(p[0], rgb[0]) + d(p[1], rgb[1]) + d(p[2], rgb[2])
                })
                .map(|(i, _)| (i + 1) as u8)
                .unwrap_or(1);
            color_to_idx.insert(rgb, best);
        }
    }

    let w_blocks     = (sx2 - sx1 + 1) as usize;
    let h_blocks     = (sy2 - sy1 + 1) as usize;
    let z_depth      = (sz2 - sz1 + 1) as usize; // always ≤ 256
    let gx_count     = (w_blocks + 255) / 256;
    let gy_count     = (h_blocks + 255) / 256;
    let total_models = (gx_count * gy_count) as f32;

    // Pass 2: build children buffer (SIZE+XYZI per sub-model, then RGBA) — 47–97%.
    let mut children_buf: Vec<u8> = Vec::new();
    let mut total_voxels: u32 = 0;
    let mut model_idx: usize = 0;

    for gy in 0..gy_count {
        for gx in 0..gx_count {
            let wx_start = sx1 + (gx * 256) as i32;
            let wx_end   = (wx_start + 255).min(sx2);
            let wy_start = sy1 + (gy * 256) as i32;
            let wy_end   = (wy_start + 255).min(sy2);
            let model_w  = (wx_end - wx_start + 1) as i32;
            let model_h  = (wy_end - wy_start + 1) as i32;
            let model_z  = z_depth as i32;

            let label = if total_models > 1.0 {
                format!("Building model {}/{}", model_idx + 1, gx_count * gy_count)
            } else {
                "Building model".to_string()
            };
            emit_progress(&label, 0.47 + model_idx as f32 / total_models * 0.50);
            model_idx += 1;

            let mut voxels: Vec<[u8; 4]> = Vec::new();
            for wz in sz1..=sz2 {
                for wy in wy_start..=wy_end {
                    for wx in wx_start..=wx_end {
                        let (bt, paint) = get_block_at(world, wx, wy, wz);
                        if bt == 0 { continue; }
                        let rgb  = block_color(bt, paint, world.sky);
                        let cidx = *color_to_idx.get(&rgb).unwrap_or(&1);
                        let lx   = (wx - wx_start) as u8;
                        let ly   = (wy - wy_start) as u8;
                        let lz   = (wz - sz1) as u8;
                        voxels.push([lx, ly, lz, cidx]);
                    }
                }
            }
            if voxels.is_empty() { continue; }
            total_voxels += voxels.len() as u32;

            let mut size_content = Vec::with_capacity(12);
            size_content.extend_from_slice(&model_w.to_le_bytes());
            size_content.extend_from_slice(&model_h.to_le_bytes());
            size_content.extend_from_slice(&model_z.to_le_bytes());
            write_vox_chunk(&mut children_buf, b"SIZE", &size_content);

            let n = voxels.len() as i32;
            let mut xyzi_content = Vec::with_capacity(4 + voxels.len() * 4);
            xyzi_content.extend_from_slice(&n.to_le_bytes());
            for v in &voxels { xyzi_content.extend_from_slice(v); }
            write_vox_chunk(&mut children_buf, b"XYZI", &xyzi_content);
        }
    }

    // RGBA palette chunk (always 1024 bytes; index 0 is unused per spec).
    let mut rgba = vec![0u8; 1024];
    for (i, &[r, g, b]) in palette.iter().enumerate() {
        let s = (i + 1) * 4;
        rgba[s] = r; rgba[s + 1] = g; rgba[s + 2] = b; rgba[s + 3] = 255;
    }
    write_vox_chunk(&mut children_buf, b"RGBA", &rgba);

    // Write file: magic + version + MAIN chunk.
    emit_progress("Writing file", 0.97);
    let f = fs::File::create(&path).map_err(|e| format!("Cannot create .vox: {e}"))?;
    let mut w = BufWriter::with_capacity(1 << 20, f);
    w.write_all(b"VOX ").map_err(|e| e.to_string())?;
    w.write_all(&150i32.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(b"MAIN").map_err(|e| e.to_string())?;
    w.write_all(&0i32.to_le_bytes()).map_err(|e| e.to_string())?; // MAIN content_size
    w.write_all(&(children_buf.len() as i32).to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&children_buf).map_err(|e| e.to_string())?;
    emit_progress("Done", 1.0);

    Ok(total_voxels)
}

#[derive(serde::Serialize)]
struct ObjGeometryResult {
    #[serde(serialize_with = "serialize_bytes_b64")]
    positions: Vec<u8>, // LE f32 triplets (x,y,z) per vertex
    #[serde(serialize_with = "serialize_bytes_b64")]
    colors: Vec<u8>,    // LE f32 triplets (r,g,b 0..1) per vertex
    #[serde(serialize_with = "serialize_bytes_b64")]
    uvs: Vec<u8>,       // LE f32 pairs (u,v) per vertex; empty when no texture pack loaded
    vertex_count: u32,
}

#[tauri::command]
fn get_obj_geometry(
    state: tauri::State<'_, AppState>,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<ObjGeometryResult, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;

    let sx1 = x1.min(x2); let sx2 = x1.max(x2);
    let sy1 = y1.min(y2); let sy2 = y1.max(y2);
    let sz1 = z_min.min(z_max).max(0);
    let sz2 = z_min.max(z_max).min(world_max_z(world));

    let vol = ((sx2-sx1+1) as u64) * ((sy2-sy1+1) as u64) * ((sz2-sz1+1) as u64);
    if vol > 64*64*64 {
        return Err(format!("Selection too large ({vol} blocks) — max 64×64×64 for 3D preview"));
    }

    Ok(obj_geometry_region(world, ws.texture_pack.as_ref(), sx1, sy1, sx2, sy2, sz1, sz2))
}

/// Face-culled cube/ramp/wedge geometry for an arbitrary world box, encoded as LE f32 position +
/// colour triplets (Three.js Y-up coords). Shared by `get_obj_geometry` (64³ selection preview) and
/// `get_chunk_geometry` (world-scale fly-through chunk streaming).
fn obj_geometry_region(world: &LoadedWorld, pack: Option<&texturepack::TexturePack>, sx1: i32, sy1: i32, sx2: i32, sy2: i32, sz1: i32, sz2: i32) -> ObjGeometryResult {
    let mut pos_f: Vec<f32> = Vec::new();
    let mut col_f: Vec<f32> = Vec::new();
    let mut uv_f:  Vec<f32> = Vec::new();

    // Directional face-shading baked into vertex colours — replaces normal-based lighting.
    // Values approximate: sun from above + slightly east/south; fill from northwest.
    const SH_TOP: f32 = 1.00;
    const SH_BOT: f32 = 0.45;
    const SH_E:   f32 = 0.85; // east  (+X)
    const SH_W:   f32 = 0.60; // west  (-X)
    const SH_S:   f32 = 0.70; // south (+Y)
    const SH_N:   f32 = 0.75; // north (-Y)

    // Detect face kind from shade constant so per-face textures work without touching every call site.
    // SH_TOP → top face (2), SH_BOT → bottom face (1), anything else → side face (0).
    // Wedge diagonal blended shades ((SH_N+SH_W)*0.5 etc.) are not equal to SH_TOP/SH_BOT → side.
    macro_rules! face_kind {
        ($sh:expr) => {{
            let s: f32 = $sh;
            if s == SH_TOP { 2u8 } else if s == SH_BOT { 1u8 } else { 0u8 }
        }};
    }

    // Push UV coords for a quad (6 verts: ABD, BCD) covering atlas row with v in [v0,v1].
    macro_rules! push_quad_uv {
        ($v0:expr, $v1:expr) => {
            uv_f.extend_from_slice(&[
                0.0, $v0,  1.0, $v0,  0.0, $v1,
                1.0, $v0,  1.0, $v1,  0.0, $v1,
            ]);
        };
    }
    // Push UV coords for a triangle covering the same atlas row.
    macro_rules! push_tri_uv {
        ($v0:expr, $v1:expr) => {
            uv_f.extend_from_slice(&[0.0, $v0,  1.0, $v0,  0.5, $v1]);
        };
    }

    macro_rules! push_tri {
        ($verts:expr, $rgb:expr, $sh:expr, $btype:expr, $bpaint:expr) => {{
            let fk = face_kind!($sh);
            let (rgb2, row_opt) = if let Some(p) = pack {
                texturepack::face_color_and_row(p, $btype, $bpaint, fk, $rgb)
            } else { ($rgb, None) };
            let (r,g,b) = (rgb2[0] as f32/255.0*$sh, rgb2[1] as f32/255.0*$sh, rgb2[2] as f32/255.0*$sh);
            for (x,y,z) in $verts { pos_f.extend_from_slice(&[x,y,z]); col_f.extend_from_slice(&[r,g,b]); }
            if let Some(p) = pack {
                let ar = p.atlas_rows as f32;
                let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                push_tri_uv!(v1, v0); // swap: $v0 arg → floor vertex, $v1 arg → apex; tile reads top→bottom
            }
        }};
    }
    macro_rules! push_quad {
        ($a:expr,$b:expr,$c:expr,$d:expr,$rgb:expr,$sh:expr,$btype:expr,$bpaint:expr) => {{
            let fk = face_kind!($sh);
            let (rgb2, row_opt) = if let Some(p) = pack {
                texturepack::face_color_and_row(p, $btype, $bpaint, fk, $rgb)
            } else { ($rgb, None) };
            let (r,g,b_) = (rgb2[0] as f32/255.0*$sh, rgb2[1] as f32/255.0*$sh, rgb2[2] as f32/255.0*$sh);
            for (x,y,z) in [$a,$b,$d, $b,$c,$d] { pos_f.extend_from_slice(&[x,y,z]); col_f.extend_from_slice(&[r,g,b_]); }
            if let Some(p) = pack {
                let ar = p.atlas_rows as f32;
                let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                push_quad_uv!(v1, v0); // swap: $v0 arg → A/B vertices, $v1 arg → C/D vertices; tile reads top→bottom
            }
        }};
    }

    for wz in sz1..=sz2 {
        for wy in sy1..=sy2 {
            for wx in sx1..=sx2 {
                let (bt, paint) = get_block_at(world, wx, wy, wz);
                if bt == 0 { continue; }
                let rgb = block_color(bt, paint, world.sky);
                let (x0,x1f) = (wx as f32, wx as f32+1.0);
                let (y0,y1f) = (wy as f32, wy as f32+1.0);
                let (z0,z1f) = (wz as f32, wz as f32+1.0);
                // Eden (X east, Y south, Z up) → Three.js Y-up: (ex, ez, ey).
                // Eden north = Three.js −Z so the camera faces −Z (north) and east (+X) is on the right.
                let o = |ex:f32,ey:f32,ez:f32| -> (f32,f32,f32) { (ex,ez,ey) };

                if matches!(bt, 24..=39) {
                    let dir = (bt-24)%4;
                    let ss = obj_occludes(get_block_at(world,wx,wy+1,wz).0);
                    let sn = obj_occludes(get_block_at(world,wx,wy-1,wz).0);
                    let se = obj_occludes(get_block_at(world,wx+1,wy,wz).0);
                    let sw = obj_occludes(get_block_at(world,wx-1,wy,wz).0);
                    if !obj_occludes(get_block_at(world,wx,wy,wz-1).0) {
                        push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y0,z0),o(x0,y0,z0),rgb,SH_BOT,bt,paint);
                    }
                    match dir {
                        0 => {
                            if !ss { push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_S,bt,paint); }
                            if !sw { push_tri!([o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f)],rgb,SH_W,bt,paint); }
                            if !se { push_tri!([o(x1f,y1f,z0),o(x1f,y0,z0),o(x1f,y1f,z1f)],rgb,SH_E,bt,paint); }
                            push_quad!(o(x0,y0,z0),o(x1f,y0,z0),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_TOP,bt,paint);
                        }
                        1 => {
                            if !sw { push_quad!(o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_W,bt,paint); }
                            if !ss { push_tri!([o(x0,y1f,z0),o(x1f,y1f,z0),o(x0,y1f,z1f)],rgb,SH_S,bt,paint); }
                            if !sn { push_tri!([o(x1f,y0,z0),o(x0,y0,z0),o(x0,y0,z1f)],rgb,SH_N,bt,paint); }
                            push_quad!(o(x1f,y0,z0),o(x1f,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_TOP,bt,paint);
                        }
                        2 => {
                            if !sn { push_quad!(o(x1f,y0,z0),o(x0,y0,z0),o(x0,y0,z1f),o(x1f,y0,z1f),rgb,SH_N,bt,paint); }
                            if !se { push_tri!([o(x1f,y0,z0),o(x1f,y1f,z0),o(x1f,y0,z1f)],rgb,SH_E,bt,paint); }
                            if !sw { push_tri!([o(x0,y1f,z0),o(x0,y0,z0),o(x0,y0,z1f)],rgb,SH_W,bt,paint); }
                            push_quad!(o(x1f,y1f,z0),o(x0,y1f,z0),o(x0,y0,z1f),o(x1f,y0,z1f),rgb,SH_TOP,bt,paint);
                        }
                        _ => {
                            if !se { push_quad!(o(x1f,y1f,z0),o(x1f,y0,z0),o(x1f,y0,z1f),o(x1f,y1f,z1f),rgb,SH_E,bt,paint); }
                            if !sn { push_tri!([o(x1f,y0,z0),o(x0,y0,z0),o(x1f,y0,z1f)],rgb,SH_N,bt,paint); }
                            if !ss { push_tri!([o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f)],rgb,SH_S,bt,paint); }
                            push_quad!(o(x0,y1f,z0),o(x0,y0,z0),o(x1f,y0,z1f),o(x1f,y1f,z1f),rgb,SH_TOP,bt,paint);
                        }
                    }
                } else if matches!(bt, 40..=55) {
                    // Wedges are vertical triangular prisms: full Z height, triangle footprint in XY.
                    // Each wedge occupies the diagonal half of the block named by its direction —
                    // SE fills the NE-SE-SW triangle (cuts off the NW corner), etc.
                    // Two rectangular faces at the named sides + one diagonal 45° rectangular face.
                    let dir = (bt-40)%4;
                    let ss = obj_occludes(get_block_at(world,wx,wy+1,wz).0);
                    let sn = obj_occludes(get_block_at(world,wx,wy-1,wz).0);
                    let se = obj_occludes(get_block_at(world,wx+1,wy,wz).0);
                    let sw = obj_occludes(get_block_at(world,wx-1,wy,wz).0);
                    let s_top = obj_occludes(get_block_at(world,wx,wy,wz+1).0);
                    let s_bot = obj_occludes(get_block_at(world,wx,wy,wz-1).0);
                    match dir {
                        0 => { // SE: triangle NE(x1f,y0)-SE(x1f,y1f)-SW(x0,y1f). Diagonal NE↔SW faces NW.
                            if !s_bot { push_tri!([o(x1f,y0,z0),o(x1f,y1f,z0),o(x0,y1f,z0)],rgb,SH_BOT,bt,paint); }
                            if !s_top { push_tri!([o(x1f,y0,z1f),o(x0,y1f,z1f),o(x1f,y1f,z1f)],rgb,SH_TOP,bt,paint); }
                            if !se { push_quad!(o(x1f,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x1f,y0,z1f),rgb,SH_E,bt,paint); }
                            if !ss { push_quad!(o(x1f,y1f,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x1f,y1f,z1f),rgb,SH_S,bt,paint); }
                            push_quad!(o(x1f,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x1f,y0,z1f),rgb,(SH_N+SH_W)*0.5,bt,paint);
                        }
                        1 => { // SW: triangle NW(x0,y0)-SW(x0,y1f)-SE(x1f,y1f). Diagonal NW↔SE faces NE.
                            if !s_bot { push_tri!([o(x0,y0,z0),o(x0,y1f,z0),o(x1f,y1f,z0)],rgb,SH_BOT,bt,paint); }
                            if !s_top { push_tri!([o(x0,y0,z1f),o(x1f,y1f,z1f),o(x0,y1f,z1f)],rgb,SH_TOP,bt,paint); }
                            if !sw { push_quad!(o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_W,bt,paint); }
                            if !ss { push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_S,bt,paint); }
                            push_quad!(o(x0,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y0,z1f),rgb,(SH_N+SH_E)*0.5,bt,paint);
                        }
                        2 => { // NW: triangle NE(x1f,y0)-NW(x0,y0)-SW(x0,y1f). Diagonal NE↔SW faces SE.
                            if !s_bot { push_tri!([o(x1f,y0,z0),o(x0,y0,z0),o(x0,y1f,z0)],rgb,SH_BOT,bt,paint); }
                            if !s_top { push_tri!([o(x1f,y0,z1f),o(x0,y1f,z1f),o(x0,y0,z1f)],rgb,SH_TOP,bt,paint); }
                            if !sn { push_quad!(o(x1f,y0,z0),o(x0,y0,z0),o(x0,y0,z1f),o(x1f,y0,z1f),rgb,SH_N,bt,paint); }
                            if !sw { push_quad!(o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_W,bt,paint); }
                            push_quad!(o(x1f,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x1f,y0,z1f),rgb,(SH_S+SH_E)*0.5,bt,paint);
                        }
                        _ => { // NE: triangle NW(x0,y0)-NE(x1f,y0)-SE(x1f,y1f). Diagonal NW↔SE faces SW.
                            if !s_bot { push_tri!([o(x0,y0,z0),o(x1f,y0,z0),o(x1f,y1f,z0)],rgb,SH_BOT,bt,paint); }
                            if !s_top { push_tri!([o(x0,y0,z1f),o(x1f,y1f,z1f),o(x1f,y0,z1f)],rgb,SH_TOP,bt,paint); }
                            if !sn { push_quad!(o(x0,y0,z0),o(x1f,y0,z0),o(x1f,y0,z1f),o(x0,y0,z1f),rgb,SH_N,bt,paint); }
                            if !se { push_quad!(o(x1f,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x1f,y0,z1f),rgb,SH_E,bt,paint); }
                            push_quad!(o(x0,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y0,z1f),rgb,(SH_S+SH_W)*0.5,bt,paint);
                        }
                    }
                } else {
                    // Cube with face culling
                    if !obj_occludes(get_block_at(world,wx,wy,wz+1).0) {
                        push_quad!(o(x0,y0,z1f),o(x1f,y0,z1f),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_TOP,bt,paint);
                    }
                    if !obj_occludes(get_block_at(world,wx,wy,wz-1).0) {
                        push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y0,z0),o(x0,y0,z0),rgb,SH_BOT,bt,paint);
                    }
                    if !obj_occludes(get_block_at(world,wx,wy+1,wz).0) {
                        push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_S,bt,paint);
                    }
                    if !obj_occludes(get_block_at(world,wx,wy-1,wz).0) {
                        push_quad!(o(x1f,y0,z0),o(x0,y0,z0),o(x0,y0,z1f),o(x1f,y0,z1f),rgb,SH_N,bt,paint);
                    }
                    if !obj_occludes(get_block_at(world,wx+1,wy,wz).0) {
                        push_quad!(o(x1f,y1f,z0),o(x1f,y0,z0),o(x1f,y0,z1f),o(x1f,y1f,z1f),rgb,SH_E,bt,paint);
                    }
                    if !obj_occludes(get_block_at(world,wx-1,wy,wz).0) {
                        push_quad!(o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_W,bt,paint);
                    }
                }
            }
        }
    }

    let vertex_count = (pos_f.len()/3) as u32;
    let positions: Vec<u8> = pos_f.iter().flat_map(|f| f.to_le_bytes()).collect();
    let colors: Vec<u8> = col_f.iter().flat_map(|f| f.to_le_bytes()).collect();
    let uvs: Vec<u8> = uv_f.iter().flat_map(|f| f.to_le_bytes()).collect();
    ObjGeometryResult { positions, colors, uvs, vertex_count }
}

/// Face-culled geometry for a single chunk (16×16 XY × full Z). For the 3D fly-through pane, which
/// streams meshes per chunk near the camera.
#[tauri::command]
fn get_chunk_geometry(
    state: tauri::State<'_, AppState>,
    cx: i32, cy: i32,
) -> Result<ObjGeometryResult, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    // Defensive: only serve chunks inside the world's chunk grid. Out-of-range indices already scan
    // to all-air (empty geometry), but bailing early avoids the wasted 16×16×Z probe and documents
    // the frontend contract (local 0-based chunk indices).
    if cx < 0 || cy < 0 || cx as u32 >= world.w_chunks || cy as u32 >= world.h_chunks {
        return Ok(ObjGeometryResult { positions: Vec::new(), colors: Vec::new(), uvs: Vec::new(), vertex_count: 0 });
    }
    let sx1 = cx * 16; let sy1 = cy * 16;
    Ok(obj_geometry_region(world, ws.texture_pack.as_ref(), sx1, sy1, sx1 + 15, sy1 + 15, 0, world_max_z(world)))
}

// ── Texture pack commands ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct TexturePackInfo {
    rows: u32,
    tile: u32,
    #[serde(serialize_with = "serialize_bytes_b64")]
    atlas: Vec<u8>,
    name_to_row: HashMap<String, u32>,
}

/// Load a texture pack zip and return the atlas RGBA + name→row map.
/// The pack is stored in AppState (world-independent) and automatically used by subsequent
/// get_chunk_geometry / get_obj_geometry calls.
#[tauri::command]
fn load_texture_pack(path: String, state: tauri::State<'_, AppState>) -> Result<TexturePackInfo, String> {
    let pack = texturepack::load_pack(&path)?;
    let info = TexturePackInfo {
        rows: pack.atlas_rows,
        tile: pack.tile,
        atlas: pack.atlas_rgba.clone(),
        name_to_row: pack.name_to_row.clone(),
    };
    state.lock().unwrap().texture_pack = Some(pack);
    Ok(info)
}

/// Unload the current texture pack, reverting to flat vertex-color rendering.
#[tauri::command]
fn unload_texture_pack(state: tauri::State<'_, AppState>) {
    state.lock().unwrap().texture_pack = None;
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
fn sculpt_column(world: &mut LoadedWorld, wx: i32, wy: i32, cur_z: i32, target_z: i32, max_z: i32, surf_bt: u8, surf_paint: u8, fill_bt: Option<u8>, fill_paint: Option<u8>) {
    let target_z = target_z.clamp(1, max_z);
    if target_z == cur_z { return; }
    if target_z > cur_z {
        let bt = fill_bt.unwrap_or(surf_bt);
        let paint = fill_paint.unwrap_or(surf_paint);
        for z in (cur_z + 1)..=target_z {
            set_block_abs(world, wx, wy, z, bt, paint);
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
    block_type: Option<u8>,
    paint: Option<u8>,
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
                sculpt_column(&mut world, p.x, p.y, cur_z, avg, max_z, surf_bt, surf_paint, block_type, paint);
            }
        }
        "noise" => {
            let mut rng = Rng64::new(if seed == 0 { 0xdeadbeef_cafebabe } else { seed });
            for p in &points {
                let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                let _ = rng.next(); // positional mix for variation
                let delta = rng.range(-strength, strength);
                sculpt_column(&mut world, p.x, p.y, cur_z, cur_z + delta, max_z, surf_bt, surf_paint, block_type, paint);
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
                sculpt_column(&mut world, p.x, p.y, cur_z, avg, max_z, surf_bt, surf_paint, block_type, paint);
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
                        sculpt_column(&mut world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
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
            get_world_info,
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
            render_yslice_patch,
            render_xslice_patch,
            render_selection_view,
            render_full_height_view,
            extrude_selection,
            render_clipboard_preview,
            render_clipboard_elevation_preview,
            save_prefab,
            load_prefab,
            generate_trees,
            render_axo_region,
            render_axo_clipboard,
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
            export_json,
            export_vox,
            get_obj_geometry,
            get_chunk_geometry,
            create_world,
            create_natural_world,
            preview_natural_world,
            create_classic_world,
            create_tg2_world,
            preview_tg2_world,
            set_spawn_pos,
            import_schematic_info,
            import_schematic_apply,
            get_sky_grid,
            set_sky_grid,
            get_creatures,
            pick_block_surface,
            get_cursor_block,
            load_eden_template,
            fetch_template_tile,
            expand_world_from_template,
            load_texture_pack,
            unload_texture_pack,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Sky grid (Phase 5) ───────────────────────────────────────────────────────

/// Read the 4×4 sky-colour grid from header bytes 132–147.
/// Returns 16 paint indices (0 = default blue, 1–54 = paint palette).
#[tauri::command]
fn get_sky_grid(state: tauri::State<'_, AppState>) -> Result<Vec<u8>, String> {
    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    if world.bytes.len() < 148 {
        return Ok(vec![0u8; 16]);
    }
    Ok(world.bytes[132..148].to_vec())
}

/// Write a 4×4 sky-colour grid to header bytes 132–147 and recompute sky majority.
#[tauri::command]
fn set_sky_grid(grid: Vec<u8>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if grid.len() != 16 { return Err("Expected exactly 16 sky values".into()); }
    let mut ws = state.lock().unwrap();
    let world = ws.world.as_mut().ok_or("No world loaded")?;
    if world.bytes.len() < 148 { return Err("World header too short".into()); }
    world.bytes[132..148].copy_from_slice(&grid);
    // Recompute sky majority so grass tint updates without a reload.
    let candidates: Vec<u8> = grid.iter().copied().filter(|&b| b != 14).collect();
    world.sky = if candidates.is_empty() {
        14
    } else {
        let mut counts = [0u32; 256];
        for &b in &candidates { counts[b as usize] += 1; }
        counts.iter().enumerate().max_by_key(|(_, &c)| c)
            .map(|(i, _)| i as u8).unwrap_or(14)
    };
    Ok(())
}

// ── Creature viewer (Phase 6) ─────────────────────────────────────────────────

#[derive(Serialize)]
struct CreatureInfo {
    type_id: i32,
    color:   i32,
    x:       f32,
    y:       f32,
    z:       f32,
    angle:   f32,
}

/// Read up to 200 entity slots from the 12 000-byte block that precedes the
/// chunk directory.  Skips empty slots (type == −1) and out-of-range types.
/// Returns an empty list for editor-created worlds that have no entity block.
#[tauri::command]
fn get_creatures(state: tauri::State<'_, AppState>) -> Result<Vec<CreatureInfo>, String> {
    const MAX_SAVED: usize = 200;
    const ENTITY_BYTES: usize = 60; // sizeof(EntityData)
    const BLOCK_SIZE: usize = MAX_SAVED * ENTITY_BYTES; // 12 000

    let ws = state.lock().unwrap();
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let bytes = &world.bytes[..];

    if bytes.len() < 192 { return Ok(vec![]); }

    // directory_offset is stored as u64 at bytes 32..40 (but editor uses u32 in
    // practice; read as u64 and clamp to usize).
    let dir_off = u64::from_le_bytes(bytes[32..40].try_into().unwrap()) as usize;

    // Sanity check: the entity block must fit before directory_offset.
    if dir_off < BLOCK_SIZE || dir_off > bytes.len() { return Ok(vec![]); }

    let block_start = dir_off - BLOCK_SIZE;
    let mut out = Vec::new();

    // EntityData layout (Vector.h):
    //   pos(3×f32 @0): x=Eden-X, y=Eden-Z(up), z=Eden-Y(south)
    //   vel(3×f32 @12)
    //   angle(f32 @24)  type(i32 @28)  color(i32 @32)  touched/extra2/extra3/extra4 @36
    for i in 0..MAX_SAVED {
        let base = block_start + i * ENTITY_BYTES;
        if base + ENTITY_BYTES > bytes.len() { break; }
        let s = &bytes[base..base + ENTITY_BYTES];

        let type_id = i32::from_le_bytes(s[28..32].try_into().unwrap());
        if type_id < 0 || type_id > 6 { continue; } // −1 = empty slot

        let pos_x   = f32::from_le_bytes(s[ 0.. 4].try_into().unwrap()); // Eden X
        let pos_z   = f32::from_le_bytes(s[ 8..12].try_into().unwrap()); // Eden Y (south)
        let pos_y   = f32::from_le_bytes(s[ 4.. 8].try_into().unwrap()); // Eden Z (height)
        let angle   = f32::from_le_bytes(s[24..28].try_into().unwrap());
        let color   = i32::from_le_bytes(s[32..36].try_into().unwrap());

        out.push(CreatureInfo { type_id, color, x: pos_x, y: pos_z, z: pos_y, angle });
    }
    Ok(out)
}

// ── Minecraft Schematic / Litematica Import ──────────────────────────────────

const SC_PAINT_COLORS: [[u8; 3]; 54] = [
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

fn sc_closest_paint(r: u8, g: u8, b: u8) -> u8 {
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
const MC_DYE_RGB: [[u8; 3]; 16] = [
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

fn mc_dye_to_eden(substrate: u8, data: u8) -> (u8, u8) {
    let [r, g, b] = MC_DYE_RGB[data.min(15) as usize];
    (substrate, sc_closest_paint(r, g, b))
}

// Map MC stair data (facing bits 0–1, half bit 2) to Eden ramp direction offset.
// MC: 0=east, 1=west, 2=south, 3=north → Eden S/W/N/E = 0/1/2/3
fn mc_stair_to_ramp(family_base: u8, data: u8) -> (u8, u8) {
    let dir: u8 = match data & 3 {
        0 => 3, // east
        1 => 1, // west
        2 => 0, // south
        _ => 2, // north
    };
    (family_base + dir, 0)
}

fn mc_to_eden(id: u8, meta: u8) -> (u8, u8) {
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
        6 | 37 | 38 | 39 | 40 | 50 | 51 | 55..=69 | 75 | 76 | 77 | 84 | 90 | 92 | 93..=96 |
        97 | 101 | 102 | 117 | 118 | 119 | 120 | 122 | 123 | 124 | 127 | 129 |
        131 | 132 | 140 | 141 | 142 | 143 | 144 | 147 | 148 | 149 | 150 | 151 | 152 |
        175 | 176 | 177 | 178 | 193..=197 | 198..=207 => (0, 0),
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
        27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 => (0, 0),
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

fn facing_to_ramp_dir(facing: &str) -> u8 {
    match facing { "east" => 3, "west" => 1, "north" => 2, _ => 0 }
}

fn mc_named_to_eden(name: &str, props: Option<&HashMap<String, String>>) -> (u8, u8) {
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

fn nbt_parse_val(d: &[u8], pos: &mut usize, tag: u8) -> Option<NbtVal> {
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
            let len = nbt_read_be_i32(d, pos)? as usize;
            if *pos + len > d.len() { return None; }
            let v = d[*pos..*pos+len].to_vec(); *pos += len; Some(NbtVal::ByteArr(v))
        }
        8 => Some(NbtVal::Str(nbt_read_nbt_string(d, pos)?)),
        9 => {
            let et = nbt_read_u8(d, pos)?;
            let n  = nbt_read_be_i32(d, pos)?;
            let mut list = Vec::with_capacity(n as usize);
            for _ in 0..n { list.push(nbt_parse_val(d, pos, et)?); }
            Some(NbtVal::List(list))
        }
        10 => {
            let mut map = HashMap::new();
            loop {
                let t = nbt_read_u8(d, pos)?;
                if t == 0 { break; }
                let k = nbt_read_nbt_string(d, pos)?;
                let v = nbt_parse_val(d, pos, t)?;
                map.insert(k, v);
            }
            Some(NbtVal::Compound(map))
        }
        11 => {
            let n = nbt_read_be_i32(d, pos)? as usize;
            let mut arr = Vec::with_capacity(n);
            for _ in 0..n {
                if *pos + 4 > d.len() { return None; }
                arr.push(i32::from_be_bytes(d[*pos..*pos+4].try_into().unwrap())); *pos += 4;
            }
            Some(NbtVal::IntArr(arr))
        }
        12 => {
            let n = nbt_read_be_i32(d, pos)? as usize;
            let mut arr = Vec::with_capacity(n);
            for _ in 0..n {
                if *pos + 8 > d.len() { return None; }
                arr.push(i64::from_be_bytes(d[*pos..*pos+8].try_into().unwrap())); *pos += 8;
            }
            Some(NbtVal::LongArr(arr))
        }
        _ => None,
    }
}

fn nbt_parse_root(d: &[u8]) -> Option<NbtVal> {
    let pos = &mut 0usize;
    let tag = nbt_read_u8(d, pos)?;
    if tag != 10 { return None; }
    nbt_skip_nbt_string(d, pos)?;
    nbt_parse_val(d, pos, 10)
}

// ── Litematica parser ─────────────────────────────────────────────────────────

struct LitematicRegion {
    pos_x: i32, pos_y: i32, pos_z: i32,
    size_x: i32, size_y: i32, size_z: i32,
    /// (block_name, properties_map)
    palette: Vec<(String, HashMap<String, String>)>,
    states: Vec<i64>,
}

fn unpack_state(states: &[i64], index: usize, bits: u32) -> u32 {
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

fn parse_litematic_bytes(raw: &[u8]) -> Result<Vec<LitematicRegion>, String> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut dec = GzDecoder::new(raw);
    let mut d = Vec::new();
    dec.read_to_end(&mut d).map_err(|e| format!("gzip: {e}"))?;

    let root = nbt_parse_root(&d).ok_or("NBT parse failed")?;
    let regions_nbt = root.get("Regions").ok_or("Missing Regions")?;
    let regions_map = regions_nbt.as_compound().ok_or("Regions not a compound")?;

    let mut out = Vec::new();
    for (_, rv) in regions_map {
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
struct MappingEntry {
    mc_id: String,
    eden_type: u8,
    eden_paint: u8,
}

fn apply_mapping_lookup<'a>(
    overrides: &'a [MappingEntry],
) -> HashMap<&'a str, (u8, u8)> {
    overrides.iter().map(|e| (e.mc_id.as_str(), (e.eden_type, e.eden_paint))).collect()
}

/// Convert schematic blocks to Eden clipboard with optional mapping overrides.
fn schematic_to_clipboard(
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

fn nbt_read_u8(d: &[u8], pos: &mut usize) -> Option<u8> {
    if *pos >= d.len() { return None; }
    let v = d[*pos]; *pos += 1; Some(v)
}
fn nbt_read_be_i16(d: &[u8], pos: &mut usize) -> Option<i16> {
    if *pos + 2 > d.len() { return None; }
    let v = i16::from_be_bytes([d[*pos], d[*pos+1]]); *pos += 2; Some(v)
}
fn nbt_read_be_i32(d: &[u8], pos: &mut usize) -> Option<i32> {
    if *pos + 4 > d.len() { return None; }
    let v = i32::from_be_bytes(d[*pos..*pos+4].try_into().unwrap()); *pos += 4; Some(v)
}
fn nbt_skip_nbt_string(d: &[u8], pos: &mut usize) -> Option<()> {
    let len = nbt_read_be_i16(d, pos)? as usize;
    if *pos + len > d.len() { return None; }
    *pos += len; Some(())
}
fn nbt_read_nbt_string(d: &[u8], pos: &mut usize) -> Option<String> {
    let len = nbt_read_be_i16(d, pos)? as usize;
    if *pos + len > d.len() { return None; }
    let s = std::str::from_utf8(&d[*pos..*pos+len]).ok()?.to_string();
    *pos += len; Some(s)
}
fn nbt_skip_payload(d: &[u8], pos: &mut usize, tag: u8) -> Option<()> {
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

struct ParsedSchem {
    width: i32, height: i32, length: i32,
    palette: Vec<String>,  // palette_index → full block-state string e.g. "minecraft:oak_stairs[facing=north]"
    blocks: Vec<u32>,      // varint-decoded palette indices, order: (y*length + z)*width + x
}

fn parse_schem_bytes(raw: &[u8]) -> Result<ParsedSchem, String> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut dec = GzDecoder::new(raw);
    let mut d = Vec::new();
    dec.read_to_end(&mut d).map_err(|e| format!("gzip: {e}"))?;
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
fn split_block_state(s: &str) -> (&str, HashMap<String, String>) {
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

struct ParsedSchematic {
    width: u16, height: u16, length: u16,
    blocks: Vec<u8>, data_arr: Vec<u8>,
}

fn parse_schematic_bytes(raw: &[u8]) -> Result<ParsedSchematic, String> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut dec = GzDecoder::new(raw);
    let mut d = Vec::new();
    dec.read_to_end(&mut d).map_err(|e| format!("gzip: {e}"))?;
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
struct SchematicBlockEntry {
    mc_id: String,
    count: u32,
    eden_type: u8,
    eden_paint: u8,
}

#[derive(Serialize)]
struct SchematicInfo {
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

fn is_litematic(path: &str) -> bool {
    path.to_lowercase().ends_with(".litematic")
}
fn is_schem(path: &str) -> bool {
    path.to_lowercase().ends_with(".schem")
}

#[tauri::command]
fn import_schematic_info(path: String) -> Result<SchematicInfo, String> {
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
            let bits = (usize::BITS - (palette_sz.saturating_sub(1)).leading_zeros()).max(4) as u32;
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
fn import_schematic_apply(
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
            let bits = (usize::BITS - (palette_sz.saturating_sub(1)).leading_zeros()).max(4) as u32;
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
    state.lock().unwrap().clipboard = Some(cb);
    Ok(info)
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

    /// X/Y slice renderers place the known column (px=3, py=5) blocks at the right pixels.
    /// Column has Wood@z0, Stone@z17, Dirt@z48; image row = z2 - z (row 0 = top).
    #[test]
    fn test_xy_slice_patches() {
        let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
        let at = |p: &PixelPatch, col: u32, row: u32| -> (u8, u8, u8, u8) {
            let off = ((row * p.width + col) * 4) as usize;
            (p.pixels[off], p.pixels[off + 1], p.pixels[off + 2], p.pixels[off + 3])
        };

        // Front slab at world Y=5, X range 0..7, Z range 0..63. Column X=3.
        let front = render_yslice_patch_inner(&world, 5, 0, 0, 7, 63);
        assert_eq!(front.width, 8);
        assert_eq!(front.height, 64);
        // Wood@z0 → row 63; Stone@z17 → row 46; Dirt@z48 → row 15; all at col=3.
        assert_eq!(at(&front, 3, 63).3, 255, "wood present at z0 (row 63)");
        assert_eq!(at(&front, 3, 46).3, 255, "stone present at z17 (row 46)");
        assert_eq!(at(&front, 3, 15).3, 255, "dirt present at z48 (row 15)");
        // Empty cell (col 0, row 0) is VOID background.
        assert_eq!(at(&front, 0, 0), (20, 20, 35, 255), "void background");

        // Side slab at world X=3, Y range 0..7, Z range 0..63. Column Y=5.
        let side = render_xslice_patch_inner(&world, 3, 0, 0, 7, 63);
        assert_eq!(side.width, 8);
        assert_eq!(side.height, 64);
        assert_eq!(at(&side, 5, 63).3, 255, "wood present at z0 (row 63)");
        assert_eq!(at(&side, 5, 46).3, 255, "stone present at z17 (row 46)");
        assert_eq!(at(&side, 5, 15).3, 255, "dirt present at z48 (row 15)");
        assert_eq!(at(&side, 0, 0), (20, 20, 35, 255), "void background");
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

    /// Exercise the whole-world procedural generator: it must run without
    /// panicking (cross-chunk feature writes stay in-bounds), produce a sane
    /// centre surface, and actually fill terrain blocks in every chunk.
    #[test]
    fn natural_generator_fills_terrain() {
        let (wc, hc) = (3usize, 3usize);
        let t_height = 64usize;
        let chunk_size = 32_768usize;
        let cfg = NaturalConfig {
            seed: 12345, base_height: 28, roughness: 0.8, erosion: 0.0, terrain_scale: 120.0, extreme: false,
            water_z: 24, rivers: true, biome: 0, biome_mode: 0, biome_scale: 200.0, snow_caps: true,
            tree_density_denom: 40, cave_density: 2, cave_style: 0, caverns: true,
            ore_density: 2, vegetation: 2, structures: 2, clouds: true,
        };
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; chunk_size]).collect();
        let center = generate_natural_world(&mut chunks, wc, hc, &cfg, t_height, &mut |_, _| {});

        assert!(center >= 2 && center < t_height, "centre surface z out of range: {center}");

        // Every chunk has bedrock at z=0 across its whole footprint, and a
        // non-trivial number of solid blocks above it.
        for data in &chunks {
            let mut solid = 0usize;
            for lx in 0..16 {
                for ly in 0..16 {
                    assert_eq!(chunk_get(data, lx, ly, 0), 1, "missing bedrock");
                    for z in 1..t_height {
                        if chunk_get(data, lx, ly, z) != 0 { solid += 1; }
                    }
                }
            }
            assert!(solid > 16 * 16, "chunk looks empty: only {solid} solid blocks");
        }
    }

    /// A flat-roughness desert with no water/features should still be valid and
    /// produce a sand surface (regression guard for biome surface selection).
    #[test]
    fn natural_generator_desert_plains() {
        let (wc, hc) = (2usize, 2usize);
        let t_height = 64usize;
        let cfg = NaturalConfig {
            seed: 7, base_height: 20, roughness: 0.0, erosion: 0.0, terrain_scale: 120.0, extreme: false,
            water_z: -1, rivers: false, biome: 1, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false,
            ore_density: 0, vegetation: 0, structures: 0, clouds: false,
        };
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        let center = generate_natural_world(&mut chunks, wc, hc, &cfg, t_height, &mut |_, _| {});
        // Flat terrain → centre surface should equal base height.
        assert_eq!(center, 20);
        assert_eq!(chunk_get(&chunks[0], 8, 8, center as usize), 4, "desert surface must be sand");
    }

    /// The Classic Hills biome must produce a grass-capped surface (so natural
    /// decoration works) over a classic stone body, and its classic 3D-noise caves
    /// must carve open air underground when enabled.
    #[test]
    fn natural_classic_biome_grass_cap_and_caves() {
        let (wc, hc) = (3usize, 3usize);
        let t_height = 64usize;
        let base = NaturalConfig {
            seed: 4242, base_height: 30, roughness: 0.6, erosion: 0.0, terrain_scale: 120.0, extreme: false,
            water_z: -1, rivers: false, biome: BIOME_CLASSIC, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
            tree_density_denom: 0, cave_density: 0, cave_style: 1, caverns: false,
            ore_density: 0, vegetation: 0, structures: 0, clouds: false,
        };

        // Every column's surface is either a grass cap (soil) or a stone cap (rock
        // outcrop), and always rests on a solid body. Both kinds must appear.
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        let cn = ClassicNoise::new(base.seed);
        let ccfg = classic_cfg_for_natural(&base);
        generate_natural_world(&mut chunks, wc, hc, &base, t_height, &mut |_, _| {});
        let (mut grass_caps, mut stone_caps) = (0u32, 0u32);
        for cy in 0..hc { for cx in 0..wc {
            for lx in 0..16usize { for ly in 0..16usize {
                let wx = cx * 16 + lx; let wy = cy * 16 + ly;
                let h = classic_height(&cn, wx as f64, wy as f64, &ccfg, t_height);
                let top = chunk_get(&chunks[cy * wc + cx], lx, ly, h);
                assert!(top == 8 || top == 2, "classic-biome cap must be grass or stone, got {top}");
                assert_ne!(chunk_get(&chunks[cy * wc + cx], lx, ly, h - 1), 0, "cap must rest on a solid body");
                if top == 8 { grass_caps += 1; } else { stone_caps += 1; }
            }}
        }}
        assert!(grass_caps > 0, "classic biome should have grassy soil columns");
        assert!(stone_caps > 0, "classic biome should expose stone outcrops top-down");

        // Classic+ supports standing water (unlike the legacy Classic tab): a low
        // water level must place water blocks.
        let mut wet = base; wet.water_z = (base.base_height as i32 + 6).max(1);
        let mut wch: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_natural_world(&mut wch, wc, hc, &wet, t_height, &mut |_, _| {});
        assert!(count_blocks(&wch, t_height, 20) > 0, "Classic+ with water should place water blocks");

        // Caves on vs off: enabling caves must remove some stone (carve air).
        let mut caves_off = base; caves_off.cave_density = 0;
        let mut on = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect::<Vec<_>>();
        let mut off = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect::<Vec<_>>();
        let mut on_cfg = base; on_cfg.cave_density = 2;
        generate_natural_world(&mut on,  wc, hc, &on_cfg,    t_height, &mut |_, _| {});
        generate_natural_world(&mut off, wc, hc, &caves_off, t_height, &mut |_, _| {});
        let stone_on  = count_blocks(&on,  t_height, 2);
        let stone_off = count_blocks(&off, t_height, 2);
        assert!(stone_on < stone_off, "classic caves should carve stone: on={stone_on} off={stone_off}");
    }

    /// Snow biome foliage must use the cold palette: white-painted weeds, frosted
    /// (white / light-gray) tree leaves, and white/blue flowers — never the default
    /// green / warm paints.
    #[test]
    fn natural_snow_foliage_is_cold() {
        let (wc, hc) = (6usize, 6usize);
        let t_height = 64usize;
        let cfg = NaturalConfig {
            seed: 808, base_height: 28, roughness: 0.5, erosion: 0.0, terrain_scale: 120.0, extreme: false,
            water_z: -1, rivers: false, biome: 2, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
            tree_density_denom: 6, cave_density: 0, cave_style: 0, caverns: false,
            ore_density: 0, vegetation: 2, structures: 0, clouds: false,
        };
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_natural_world(&mut chunks, wc, hc, &cfg, t_height, &mut |_, _| {});

        let (mut weeds, mut leaves, mut flowers) = (0u32, 0u32, 0u32);
        for cy in 0..hc { for cx in 0..wc {
            let data = &chunks[cy * wc + cx];
            for lx in 0..16 { for ly in 0..16 { for z in 0..t_height {
                let bt = chunk_get(data, lx, ly, z);
                let p = chunk_get_paint(data, lx, ly, z);
                match bt {
                    11 => { weeds += 1; assert_eq!(p, 9, "snow weeds must be white"); }
                    5  => { leaves += 1; assert!(SNOW_LEAF_PAINTS.contains(&p), "snow leaves must be frosted, got paint {p}"); }
                    73 => { flowers += 1; assert!(SNOW_FLOWER_PAINTS.contains(&p), "snow flowers must be cold, got paint {p}"); }
                    _ => {}
                }
            }}}
        }}
        assert!(weeds > 0 && leaves > 0 && flowers > 0,
            "expected snow weeds ({weeds}), leaves ({leaves}) and flowers ({flowers})");
    }

    /// Mixed-biome mode must vary the per-column biome across space (and stay
    /// constant in single mode), and a generated mixed world must contain more
    /// than one biome's surface material.
    #[test]
    fn natural_mixed_biomes_vary() {
        let cfg = NaturalConfig {
            seed: 2026, base_height: 30, roughness: 0.6, erosion: 0.0, terrain_scale: 120.0, extreme: false,
            water_z: -1, rivers: false, biome: 0, biome_mode: 1, biome_scale: 30.0, snow_caps: false,
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false,
            ore_density: 0, vegetation: 0, structures: 0, clouds: false,
        };
        // biome_at returns several distinct biomes over a wide area (altitude held
        // constant so this isolates the temperature/moisture blend).
        let mut seen = HashSet::new();
        for wy in 0..256i32 {
            for wx in 0..256i32 {
                seen.insert(biome_at(wx, wy, cfg.base_height, &cfg, 64));
            }
        }
        assert!(seen.len() >= 2, "mixed mode should yield multiple biomes, got {seen:?}");

        // Single mode is constant regardless of position.
        let mut single = cfg; single.biome_mode = 0; single.biome = 1;
        for wy in 0..40i32 {
            for wx in 0..40i32 {
                assert_eq!(biome_at(wx, wy, 30, &single, 64), 1, "single mode must be constant");
            }
        }

        // A generated mixed world contains both desert sand and grassland grass.
        let (wc, hc) = (8usize, 8usize);
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_natural_world(&mut chunks, wc, hc, &cfg, 64, &mut |_, _| {});
        assert!(count_blocks(&chunks, 64, 4) > 0, "mixed world should have desert sand");
        assert!(count_blocks(&chunks, 64, 8) > 0, "mixed world should have grassland grass");
    }

    /// Erosion is a relief multiplier that only ever *reduces* amplitude (it can
    /// never add relief), so a strong-erosion world must read flatter than the
    /// same seed with erosion off — the std-dev of the heightmap drops.
    #[test]
    fn natural_erosion_flattens() {
        let base = NaturalConfig {
            seed: 31337, base_height: 30, roughness: 1.0, erosion: 0.0, terrain_scale: 90.0, extreme: false,
            water_z: -1, rivers: false, biome: 0, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false,
            ore_density: 0, vegetation: 0, structures: 0, clouds: false,
        };
        // Standard deviation of terrain_height sampled over a wide region.
        let relief_std = |cfg: &NaturalConfig| -> f64 {
            let mut hs = Vec::new();
            for wy in 0..256i32 { for wx in 0..256i32 {
                hs.push(terrain_height(wx as f64, wy as f64, cfg, 64) as f64);
            }}
            let mean = hs.iter().sum::<f64>() / hs.len() as f64;
            (hs.iter().map(|h| (h - mean).powi(2)).sum::<f64>() / hs.len() as f64).sqrt()
        };

        let flat = base; // erosion 0.0
        let mut rugged = base; rugged.erosion = 1.0; // strong erosion → flatter
        let s_none = relief_std(&flat);
        let s_strong = relief_std(&rugged);
        assert!(s_strong < s_none,
            "strong erosion should flatten relief: std {s_strong} !< {s_none}");
    }

    /// The biome-edge dither perturbs each column's climate by a small per-cell
    /// jitter, so a mixed-mode biome map has *more* short-range boundary flips
    /// (speckled edges) than the same climate fields evaluated without jitter.
    #[test]
    fn natural_biome_band_dithers() {
        let cfg = NaturalConfig {
            seed: 5150, base_height: 30, roughness: 0.0, erosion: 0.0, terrain_scale: 120.0, extreme: false,
            water_z: -1, rivers: false, biome: 0, biome_mode: 1, biome_scale: 24.0, snow_caps: false,
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false,
            ore_density: 0, vegetation: 0, structures: 0, clouds: false,
        };
        // Surface held at base_height so altitude lapse is zero and this isolates
        // the temperature/moisture dither. Baseline replicates biome_at's threshold
        // decision *without* the per-column jitter.
        let baseline = |wx: i32, wy: i32| -> u8 {
            let (temp, moist) = biome_climate(wx, wy, &cfg);
            if temp < -0.28 { 2 } else if temp > 0.18 && moist < -0.05 { 1 } else { 0 }
        };
        let count_flips = |f: &dyn Fn(i32, i32) -> u8| -> u32 {
            let mut flips = 0u32;
            for wy in 0..256i32 {
                for wx in 0..255i32 {
                    if f(wx, wy) != f(wx + 1, wy) { flips += 1; }
                }
            }
            flips
        };
        let real = count_flips(&|wx, wy| biome_at(wx, wy, cfg.base_height, &cfg, 64));
        let plain = count_flips(&baseline);
        assert!(real > plain,
            "dither should add boundary speckle: {real} !> {plain}");
    }

    /// The preview command returns a correctly-sized, non-blank RGB image and
    /// honours the `max_px` cap.
    #[test]
    fn natural_preview_renders() {
        let img = preview_natural_world(
            16, 16, false,
            7, 30, 2, 1, 1, false,
            "lakes".into(), true,
            "grassland".into(), 1, 1, true,
            2, 1, 0, true, 1, 1, 1, true,
            64,
        ).expect("preview failed");
        assert!(img.width <= 64 && img.height <= 64, "preview must respect max_px");
        assert_eq!(img.pixels.len(), (img.width * img.height * 4) as usize, "RGBA buffer size");
        assert!(img.pixels.iter().any(|&c| c != 0), "preview should not be blank");
    }

    /// Steep terrain must expose bare rock at the surface (cliff faces), while
    /// perfectly flat terrain keeps its soil surface.
    #[test]
    fn natural_cliffs_expose_rock() {
        let t_height = 64usize;
        // Surface block = first non-air scanning down from the top of a column.
        let surface_of = |data: &Vec<u8>, lx: usize, ly: usize| -> u8 {
            for z in (0..t_height).rev() {
                let b = chunk_get(data, lx, ly, z);
                if b != 0 { return b; }
            }
            0
        };

        // Jagged, dry grassland → some columns are steep enough to show stone.
        let jagged = NaturalConfig {
            seed: 555, base_height: 30, roughness: 1.05, erosion: 0.0, terrain_scale: 60.0, extreme: false,
            water_z: -1, rivers: false, biome: 0, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false,
            ore_density: 0, vegetation: 0, structures: 0, clouds: false,
        };
        let (wc, hc) = (4usize, 4usize);
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_natural_world(&mut chunks, wc, hc, &jagged, t_height, &mut |_, _| {});
        let mut rock = 0;
        for cy in 0..hc { for cx in 0..wc {
            let data = &chunks[cy * wc + cx];
            for lx in 0..16 { for ly in 0..16 {
                if surface_of(data, lx, ly) == 2 { rock += 1; }
            }}
        }}
        assert!(rock > 0, "jagged terrain should expose surface rock on cliffs");

        // Flat terrain → centre column surface stays grass, never stone.
        let mut flat = jagged; flat.roughness = 0.0;
        let mut fc: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        let center = generate_natural_world(&mut fc, wc, hc, &flat, t_height, &mut |_, _| {});
        assert_eq!(chunk_get(&fc[0], 8, 8, center), 8, "flat terrain centre must stay grass");
    }

    /// Weeds (block 11) are a solid grass variant and must replace the surface
    /// block, never stack on top of grass — regression guard for the bug where
    /// they floated one cell above the grass surface.
    #[test]
    fn natural_weeds_flush_with_surface() {
        let (wc, hc) = (4usize, 4usize);
        let t_height = 64usize;
        let cfg = NaturalConfig {
            seed: 123, base_height: 30, roughness: 0.5, erosion: 0.0, terrain_scale: 110.0, extreme: false,
            water_z: -1, rivers: false, biome: 0, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false,
            ore_density: 0, vegetation: 2, structures: 0, clouds: false,
        };
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_natural_world(&mut chunks, wc, hc, &cfg, t_height, &mut |_, _| {});

        let mut weeds = 0usize;
        for cy in 0..hc {
            for cx in 0..wc {
                let data = &chunks[cy * wc + cx];
                for lx in 0..16 { for ly in 0..16 { for z in 1..t_height {
                    if chunk_get(data, lx, ly, z) == 11 {
                        weeds += 1;
                        // The old bug placed weeds one cell above the grass, so a
                        // weed sat directly on a grass/weeds block. A flush weed
                        // replaces the surface and rests on dirt/stone instead.
                        let below = chunk_get(data, lx, ly, z - 1);
                        assert!(below != 8 && below != 11,
                            "weed at local ({lx},{ly},{z}) stacks on grass/weeds ({below}) — should be flush");
                    }
                }}}
            }
        }
        assert!(weeds > 0, "expected some weeds to be generated");
    }

    /// No foliage may share a column with standing water — guards the fix for
    /// vegetation/tree canopy appearing on or overhanging water.
    #[test]
    fn natural_generator_no_foliage_on_water() {
        let (wc, hc) = (4usize, 4usize);
        let t_height = 64usize;
        let cfg = NaturalConfig {
            seed: 99, base_height: 30, roughness: 0.9, erosion: 0.0, terrain_scale: 90.0, extreme: false,
            water_z: 26, rivers: true, biome: 0, biome_mode: 0, biome_scale: 200.0, snow_caps: false,
            tree_density_denom: 8, cave_density: 0, cave_style: 0, caverns: false,
            ore_density: 0, vegetation: 2, structures: 0, clouds: false,
        };
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_natural_world(&mut chunks, wc, hc, &cfg, t_height, &mut |_, _| {});

        let is_foliage = |b: u8| matches!(b, 5 | 6 | 11 | 16 | 73);
        for cy in 0..hc {
            for cx in 0..wc {
                let data = &chunks[cy * wc + cx];
                for lx in 0..16 {
                    for ly in 0..16 {
                        let mut has_water = false;
                        let mut has_foliage = false;
                        for z in 0..t_height {
                            match chunk_get(data, lx, ly, z) {
                                20 | 15 => has_water = true,
                                b if is_foliage(b) => has_foliage = true,
                                _ => {}
                            }
                        }
                        assert!(!(has_water && has_foliage),
                            "foliage shares a column with water at chunk ({cx},{cy}) local ({lx},{ly})");
                    }
                }
            }
        }
    }

    fn classic_cfg(seed: u32, caves: bool, trees: u64) -> ClassicConfig {
        ClassicConfig {
            seed, variance: 3.0, base_height: 32, gen_caves: caves, tall_caves: false,
            tree_spacing: trees, flowers: true, clouds: true,
        }
    }

    fn count_blocks(chunks: &[Vec<u8>], t_height: usize, bt: u8) -> usize {
        let mut n = 0;
        for data in chunks {
            for lx in 0..16 { for ly in 0..16 { for z in 0..t_height {
                if chunk_get(data, lx, ly, z) == bt { n += 1; }
            }}}
        }
        n
    }

    /// Flowers (block 73) must stay sparse — too many crash the modern game's
    /// sprite loader — and must be absent entirely when the option is off.
    #[test]
    fn classic_flowers_are_sparse() {
        let (wc, hc) = (4usize, 4usize);
        let t_height = 64usize;

        let mut on: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_classic_world(&mut on, wc, hc, &classic_cfg(2024, true, 0), t_height, &mut |_, _| {});
        let flowers = count_blocks(&on, t_height, 73);
        let grass   = count_blocks(&on, t_height, 8);
        assert!(grass > 0, "expected a grass surface");
        // Far below the ~25% surface coverage of the old (crashing) decoration.
        assert!(flowers * 20 < grass, "flowers not sparse: {flowers} flowers vs {grass} grass");

        let mut off_cfg = classic_cfg(2024, true, 0);
        off_cfg.flowers = false;
        let mut off: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_classic_world(&mut off, wc, hc, &off_cfg, t_height, &mut |_, _| {});
        assert_eq!(count_blocks(&off, t_height, 73), 0, "flowers present with option off");
    }

    /// The header `version` field selects the column format the game expects:
    /// 64z legacy worlds = 4, New Dawn 256z worlds = 2. Writing 4 for a 256z world
    /// makes the game misread it as 64z (the "legacy-conversion" corruption look).
    #[test]
    fn world_file_version_matches_format() {
        for (extended, want_version, want_stride) in [(false, 4u32, 32_768u64), (true, 2u32, 131_072u64)] {
            let p = std::env::temp_dir().join(format!("eden_ver_{extended}.eden"));
            let ps = p.to_str().unwrap().to_string();
            let _ = fs::remove_file(&p);
            create_classic_world_inner(
                ps.clone(), "VerTest".into(),
                2, 2, extended,
                7, 2, 0, true, false, 1, true, true,
                &mut |_, _| {},
            ).expect("create failed");

            let b = fs::read(&p).expect("read back");
            let version = u32::from_le_bytes(b[92..96].try_into().unwrap());
            assert_eq!(version, want_version, "wrong version for extended={extended}");

            // Column stride = gap between the first two directory entries.
            let diro = u64::from_le_bytes(b[32..40].try_into().unwrap()) as usize;
            let off0 = u64::from_le_bytes(b[diro + 8..diro + 16].try_into().unwrap());
            let off1 = u64::from_le_bytes(b[diro + 24..diro + 32].try_into().unwrap());
            assert_eq!(off1 - off0, want_stride, "wrong column stride for extended={extended}");

            let _ = fs::remove_file(&p);
        }
    }

    fn tg2_cfg(seed: u32, terrain_type: u8) -> Tg2Config {
        Tg2Config {
            seed, terrain_type, sky_islands: false, struct_freq: 1, clouds: false,
            amplitude: 1.0, sea_level_off: 0, blend: false,
            caves: false, tall_caves: false, custom_biomes: [0,6,4,2],
        }
    }

    /// A 256z (New Dawn) TG2 world must proportionally fill the taller space —
    /// its surface should track ~t_height/2 (≈128), not stay pinned near the
    /// legacy 64z baseline (~32). 64z generation must be unaffected (vs=1.0).
    #[test]
    fn tg2_scales_to_extended_height() {
        let (wc, hc) = (4usize, 4usize);
        let cfg = tg2_cfg(4242, 0); // Plains: baseline = t_height/2

        let mut c64: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        let surf64 = generate_tg2_world(&cfg, wc, hc, 64, &mut c64, &mut |_, _| {});

        let mut c256: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 131_072]).collect();
        let surf256 = generate_tg2_world(&cfg, wc, hc, 256, &mut c256, &mut |_, _| {});

        assert!((20..45).contains(&surf64), "64z plains surface off baseline: {surf64}");
        assert!((100..160).contains(&surf256), "256z plains surface did not fill height: {surf256}");

        // The tall world must carry solid terrain well above the legacy 64-block
        // ceiling (surf64 ≈ baseline already proves the 64z path is unchanged).
        let mut solid_high = false;
        'o: for data in &c256 {
            for lx in 0..16 { for ly in 0..16 {
                for z in 100..130 { if chunk_get(data, lx, ly, z) != 0 { solid_high = true; break 'o; } }
            }}
        }
        assert!(solid_high, "256z world has no terrain near z=128");
    }

    /// The biome-blend pass smooths surface seams in *both* directions (it may
    /// raise low columns and carve high ones), so the average step between
    /// neighbouring surface heights must drop after blending.
    #[test]
    fn tg2_blend_smooths_both_directions() {
        let (wc, hc) = (6usize, 6usize);
        let bw = wc * 16;
        // Build a top-down surface-height map from chunk storage.
        let surface_map = |chunks: &[Vec<u8>]| -> Vec<i32> {
            let mut m = vec![0i32; bw * bw];
            for cy in 0..hc { for cx in 0..wc {
                let data = &chunks[cy * wc + cx];
                for ly in 0..16 { for lx in 0..16 {
                    let mut h = 0i32;
                    for z in (0..64).rev() { if chunk_get(data, lx, ly, z) != 0 { h = z as i32 + 1; break; } }
                    let (wx, wyy) = (cx * 16 + lx, cy * 16 + ly);
                    m[wyy * bw + wx] = h;
                }}
            }}
            m
        };
        // Mean absolute height difference to the east/south neighbour.
        let roughness = |m: &[i32]| -> f64 {
            let (mut sum, mut cnt) = (0i64, 0i64);
            for y in 0..bw { for x in 0..bw {
                let h = m[y * bw + x];
                if x + 1 < bw { sum += (h - m[y * bw + x + 1]).unsigned_abs() as i64; cnt += 1; }
                if y + 1 < bw { sum += (h - m[(y + 1) * bw + x]).unsigned_abs() as i64; cnt += 1; }
            }}
            sum as f64 / cnt.max(1) as f64
        };

        let mut plain: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_tg2_world(&tg2_cfg(99, 7), wc, hc, 64, &mut plain, &mut |_, _| {});

        let mut blended_cfg = tg2_cfg(99, 7);
        blended_cfg.blend = true;
        let mut blended: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_tg2_world(&blended_cfg, wc, hc, 64, &mut blended, &mut |_, _| {});

        let r_plain = roughness(&surface_map(&plain));
        let r_blended = roughness(&surface_map(&blended));
        assert!(r_blended < r_plain,
            "blend did not smooth seams: {r_blended} !< {r_plain}");
    }

    /// The reworked `tg2_make_transition` warps the seam with low-frequency noise,
    /// so the material boundary between two biomes wanders across rows instead of
    /// tracing a single straight axis-aligned column.
    #[test]
    fn tg2_warped_borders_not_axis_aligned() {
        let (gsize, th) = (128usize, 64usize);
        let mut g = Tg2Grid::new(gsize, th, 1.0, 1.0, 0);
        // Left half: sand (4) at height 20; right half: stone (2) at height 30.
        for x in 0..64i32 { for z in 0..gsize as i32 {
            for y in 1..20 { g.put(x, z, y, 4, 0); }
        }}
        for x in 64..gsize as i32 { for z in 0..gsize as i32 {
            for y in 1..30 { g.put(x, z, y, 2, 0); }
        }}
        let noise = ClassicNoise::new(777);
        let (sx, ex) = (48i32, 80i32);
        tg2_make_transition(&mut g, &noise, 777.0, sx, 0, ex, gsize as i32);

        // For each row, find the first x inside the band whose surface is stone (2).
        let surface_switch = |g: &Tg2Grid, z: i32| -> i32 {
            for x in sx..ex {
                let mut top = 0u8;
                for y in (1..th as i32).rev() { let b = g.get(x, z, y); if b != 0 { top = b; break; } }
                if top == 2 { return x; }
            }
            ex
        };
        let mut switches = std::collections::HashSet::new();
        for z in 0..gsize as i32 { switches.insert(surface_switch(&g, z)); }
        assert!(switches.len() >= 3,
            "transition seam is too straight (axis-aligned): only {} distinct switch columns", switches.len());
    }

    /// Weeds (block 11) must appear on the surface but stay at most half of the
    /// ground cover (grass 8 + weeds 11) — too many were never the crash cause
    /// (flowers were), but the legacy look keeps grass dominant.
    #[test]
    fn classic_weeds_present_and_bounded() {
        let (wc, hc) = (4usize, 4usize);
        let t_height = 64usize;
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_classic_world(&mut chunks, wc, hc, &classic_cfg(2024, true, 0), t_height, &mut |_, _| {});
        let grass = count_blocks(&chunks, t_height, 8);
        let weeds = count_blocks(&chunks, t_height, 11);
        assert!(weeds > 0, "expected some tall grass / weeds on the surface");
        assert!(weeds <= grass, "weeds ({weeds}) exceed half the ground cover (grass {grass})");
    }

    /// Tall caves must carve open air higher up (closer to the surface) than the
    /// shallow legacy cave band, and produce variegated walls (slate, type 14).
    #[test]
    fn classic_tall_caves_reach_higher() {
        let (wc, hc) = (4usize, 4usize);
        let t_height = 64usize;
        // Highest *deep* air cell (≥8 below the column's surface, so the legacy
        // holey dirt skin is excluded and only caves count).
        let highest_cave_air = |chunks: &[Vec<u8>]| -> i32 {
            let mut hi = -1i32;
            for data in chunks {
                for lx in 0..16 { for ly in 0..16 {
                    let mut top = 0i32;
                    for z in 0..t_height { if chunk_get(data, lx, ly, z) != 0 { top = z as i32; } }
                    for z in (1..=(top - 8).max(0)).rev() {
                        if chunk_get(data, lx, ly, z as usize) == 0 { if z > hi { hi = z; } break; }
                    }
                }}
            }
            hi
        };
        let mut normal_cfg = classic_cfg(2024, true, 0);
        normal_cfg.clouds = false; // clouds raise `top` and leak sky air into the measure
        let mut normal: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_classic_world(&mut normal, wc, hc, &normal_cfg, t_height, &mut |_, _| {});
        let mut tall_cfg = normal_cfg;
        tall_cfg.tall_caves = true;
        let mut tall: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_classic_world(&mut tall, wc, hc, &tall_cfg, t_height, &mut |_, _| {});

        assert!(highest_cave_air(&tall) > highest_cave_air(&normal),
            "tall caves ({}) should reach higher than normal caves ({})",
            highest_cave_air(&tall), highest_cave_air(&normal));
        // Tall caves use the same materials as normal caves: stone (2) + dark
        // stone (10) only — no cobblestone/slate (14).
        assert_eq!(count_blocks(&tall, t_height, 14), 0, "tall caves must not contain slate/cobblestone");
    }

    /// The classic generator must run cross-chunk without panicking, lay bedrock,
    /// fill terrain, and produce a grass surface somewhere.
    #[test]
    fn classic_generator_fills_terrain() {
        let (wc, hc) = (3usize, 3usize);
        let t_height = 64usize;
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        let center = generate_classic_world(&mut chunks, wc, hc, &classic_cfg(2024, true, 50), t_height, &mut |_, _| {});
        assert!(center >= 3 && center < t_height, "centre surface z out of range: {center}");

        let mut grass = 0usize;
        for data in &chunks {
            for lx in 0..16 {
                for ly in 0..16 {
                    assert_eq!(chunk_get(data, lx, ly, 0), 1, "missing bedrock");
                    for z in 1..t_height {
                        if matches!(chunk_get(data, lx, ly, z), 8 | 11) { grass += 1; }
                    }
                }
            }
        }
        assert!(grass > 0, "classic terrain produced no grass surface");
    }

    /// With caves on, the carved 3D-noise tunnels must open at least one interior
    /// air cell that would be solid stone when caves are disabled.
    #[test]
    fn classic_generator_caves_carve_air() {
        let (wc, hc) = (3usize, 3usize);
        let t_height = 64usize;
        let cfg_caves = classic_cfg(555, true, 0);
        let cfg_solid = classic_cfg(555, false, 0);

        // Heightmap is identical for both (same seed); compare interior fills.
        let noise = ClassicNoise::new(555);
        let bw = wc * 16;
        let mut carved_air = 0usize;
        for cy in 0..hc {
            for cx in 0..wc {
                let mut a = vec![0u8; 32_768];
                let mut b = vec![0u8; 32_768];
                let mut heights = vec![0u16; bw * (hc * 16)];
                for wy in 0..(hc * 16) {
                    for wx in 0..bw {
                        heights[wy * bw + wx] = classic_height(&noise, wx as f64, wy as f64, &cfg_caves, t_height) as u16;
                    }
                }
                fill_classic_chunk(&mut a, cx, cy, wc, &heights, &cfg_caves, &noise, t_height);
                fill_classic_chunk(&mut b, cx, cy, wc, &heights, &cfg_solid, &noise, t_height);
                for lx in 0..16 {
                    for ly in 0..16 {
                        for z in 1..t_height {
                            if chunk_get(&a, lx, ly, z) == 0 && chunk_get(&b, lx, ly, z) == 2 {
                                carved_air += 1;
                            }
                        }
                    }
                }
            }
        }
        assert!(carved_air > 0, "caves did not carve any air pockets");
    }

    /// Every tree trunk must sit on grass (8) or tall grass / weeds (11).
    #[test]
    fn classic_trees_only_on_grass() {
        let (wc, hc) = (4usize, 4usize);
        let t_height = 64usize;
        let mut chunks: Vec<Vec<u8>> = (0..wc * hc).map(|_| vec![0u8; 32_768]).collect();
        generate_classic_world(&mut chunks, wc, hc, &classic_cfg(31337, false, 12), t_height, &mut |_, _| {});

        let water_mask = vec![false; wc * 16 * hc * 16];
        let gen = WorldGen { chunks: &mut chunks, wc, hc, t_height, water_mask: &water_mask };
        let mut trunk_bases = 0usize;
        for wy in 0..(hc * 16) as i32 {
            for wx in 0..(wc * 16) as i32 {
                for z in 1..t_height as i32 {
                    if gen.get(wx, wy, z) == 6 && gen.get(wx, wy, z - 1) != 6 {
                        // Bottom of a trunk: the block below must be grass/weeds.
                        let below = gen.get(wx, wy, z - 1);
                        assert!(below == 8 || below == 11,
                            "trunk base at ({wx},{wy},{z}) sits on block {below}, not grass/weeds");
                        trunk_bases += 1;
                    }
                }
            }
        }
        assert!(trunk_bases > 0, "no trees were generated to validate");
    }
}
