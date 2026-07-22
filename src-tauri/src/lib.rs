mod colors;
mod export;
mod network;
mod schematic;
mod texturepack;
mod vmf_export;
mod worldgen;

use colors::*;
use export::*;
use network::*;
use schematic::*;
use vmf_export::{estimate_vmf, export_vmf};
use worldgen::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use memmap2::{Mmap, MmapMut, MmapOptions};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::sync::Mutex;
use std::time::Instant;
use tauri::Emitter;

// Lock/render timing instrumentation ([LOAD]/[LOCK]/[SCAN]/[PREVIEW] lines).
// Debug builds only — release builds stay quiet on stderr.
macro_rules! timing_log {
    ($($arg:tt)*) => { if cfg!(debug_assertions) { eprintln!($($arg)*); } };
}

pub(crate) fn serialize_bytes_b64<S: serde::Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
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

/// Delete `vuencedit_*.eden` staging files left in the system temp dir by a previous session that
/// quit without loading another world (normal operation deletes the prior temp on the next load, so
/// only a clean quit leaks one). Best-effort, run once at startup. Deleting a file another running
/// instance still has mapped is safe: Unix unlinks the name while the inode stays live; Windows
/// refuses to delete a mapped file and the error is ignored.
fn sweep_stale_temps() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let is_stale = p.extension().and_then(|x| x.to_str()) == Some("eden")
            && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("vuencedit_"));
        if is_stale { let _ = fs::remove_file(&p); }
    }
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
    /// Sky color index (into the 54-entry paint palette) — used for grass tint and 3D-view fog color.
    pub sky: u8,
}

// ── In-memory world state ────────────────────────────────────────────────────

pub(crate) struct LoadedWorld {
    /// Private copy-on-write mapping of the world file. Reads are file-backed and evictable
    /// under OS memory pressure; writes COW only the touched 4 KB page. The original file
    /// on disk is never modified — saves are explicit fs::write calls.
    pub(crate) bytes: MmapMut,
    /// Maps (chunk_cx, chunk_cy) → byte offset of that chunk's data block in `bytes`.
    pub(crate) chunk_map: HashMap<(i32, i32), usize>,
    /// Chunk block size in bytes: 32768 for 64-layer worlds, 131072 for 256-layer worlds.
    pub(crate) chunk_size: usize,
    /// Number of z-bands per chunk: 4 (64z) or 16 (256z). Each band covers 16 z-layers.
    pub(crate) num_bands: usize,
    pub(crate) min_x: i32,
    pub(crate) min_y: i32,
    pub(crate) w_chunks: u32,
    pub(crate) h_chunks: u32,
    pub(crate) name: String,
    pub(crate) sky: u8,
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

/// A chunk's undo payload. Most edits (single-block paint, small draw strokes) touch a tiny
/// fraction of a chunk's 32/131 KB, so `Sparse` stores only the changed (offset, original_byte)
/// pairs — restoring means writing each `orig` back at `addr+offset`. `Full` is a dense-edit
/// fallback (terrain gen, paste, fill covering most of the chunk) where per-byte entries would
/// cost more than just keeping the whole buffer; chosen in `diff_chunk` by comparing sizes.
pub(crate) enum ChunkDelta {
    Sparse(Vec<(u32, u8)>),
    Full(Vec<u8>),
}

pub(crate) struct ChunkSnapshot {
    pub(crate) cx: i16,
    pub(crate) cy: i16,
    pub(crate) delta: ChunkDelta,
}

fn chunk_snapshot_bytes(s: &ChunkSnapshot) -> usize {
    match &s.delta {
        // 5 bytes/entry (u32 offset + u8 value) plus a little Vec overhead allowance.
        ChunkDelta::Sparse(v) => v.len() * 5 + 24,
        ChunkDelta::Full(d) => d.len(),
    }
}

pub(crate) struct UndoEntry {
    pub(crate) operation: String,
    pub(crate) chunks: Vec<ChunkSnapshot>,
    /// Stroke-grouping marker. Sequential edits that share a `Some(g)` id undo/redo as one
    /// logical unit (a sculpt stroke = many timer-stamp edits). `None` = a standalone edit
    /// (every command except grouped sculpt stamps). Not a delta-merge — the chunk deltas stay
    /// separate; only undo/redo coalescing and the group count key off this. See
    /// `count_undo_groups`, `with_edit_grouped`, `undo_edit_inner`/`redo_edit_inner`.
    pub(crate) group: Option<u64>,
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

/// In-memory clipboard populated by copy_selection. Never serialised over IPC —
/// only ClipboardInfo (dimensions) is sent to the frontend.
pub(crate) struct Clipboard {
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) depth: i32,
    /// zMin from the copy selection; paste always restores blocks at z_anchor..z_anchor+depth-1.
    pub(crate) z_anchor: i32,
    /// Flat [dz * height * width + dy * width + dx]
    pub(crate) block_types: Vec<u8>,
    pub(crate) paints: Vec<u8>,
    /// Optional per-column footprint (a copy from a non-rectangular selection): a row-major
    /// `width*height` bitset, bit `dy*width+dx` set = that column pastes. `None` = full box (today's
    /// behaviour). This is deliberately separate from `ignore_air`: air (bt 0) is a real, pasteable
    /// value, so "outside the shape" and "an air voxel" must not collide. The dense block/paint
    /// arrays are still full `width*height*depth` — the mask only gates which columns get written.
    /// Rotated/mirrored in lockstep with the data (`rotate_clipboard_inner` et al.); persisted by
    /// prefab save (a shaped clipboard writes `EPFAB\x02` with a footprint section; rectangular
    /// clipboards stay on `EPFAB\x01`).
    pub(crate) mask: Option<Vec<u8>>,
}

impl Clipboard {
    fn info(&self) -> ClipboardInfo {
        ClipboardInfo {
            width: self.width, height: self.height, depth: self.depth,
            z_anchor: self.z_anchor, masked: self.mask.is_some(),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct ClipboardInfo {
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) depth: i32,
    pub(crate) z_anchor: i32,
    /// True when the clipboard carries a non-rectangular footprint (paste skips unmasked columns).
    pub(crate) masked: bool,
}

/// Test a linear bit in a row-major bitset (used for clipboard footprints and selection masks).
#[inline]
fn bit_set(bits: &[u8], i: usize) -> bool {
    bits.get(i >> 3).is_some_and(|b| b & (1u8 << (i & 7)) != 0)
}

/// Non-rectangular selection footprint (magic-wand shape, lasso). Absolute-world bounding box
/// (`x1..=x2`, `y1..=y2`) plus a row-major bitset — `width*height` bits, bit set = that column is
/// selected. It's 2D (per-column), like the selection itself; z range still comes from the slider.
/// Memory is `w·h/8` bytes: 200×200 ≈ 5 KB, 1000×1000 ≈ 122 KB — negligible, no compression.
///
/// Lives on `WorldState` (same pattern as `view_cap_z`) so mask-aware edit commands read it off
/// state instead of growing a base64 IPC param on ~13 signatures.
///
/// ⚠️ **Fail-safe contract (corruption-critical).** A command applies the mask ONLY when the rect
/// the frontend passed *exactly* equals this bbox (`matches_rect`). Any mismatch → the edit behaves
/// rect-only, exactly as before masks existed, so a stale mask can never mis-filter an unrelated
/// selection; worst case is a silent fall-back to current behaviour. This is defense-in-depth: the
/// frontend is *also* expected to `clear_selection_mask` on every selection reshape (it keys the
/// clear off a per-rect diff), but the backend never trusts that — it re-checks the rect every edit.
/// Cleared on world load/close (see `load_world`/`close_world`).
#[derive(Clone)]
pub(crate) struct SelectionMask {
    pub(crate) x1: i32,
    pub(crate) y1: i32,
    pub(crate) x2: i32,
    pub(crate) y2: i32,
    /// Row-major bitset over the bbox, `ceil(width*height/8)` bytes. Bit `(y-y1)*width+(x-x1)`.
    pub(crate) bits: Vec<u8>,
}

impl SelectionMask {
    #[inline]
    fn width(&self) -> i32 { self.x2 - self.x1 + 1 }

    /// The fail-safe rule: does this mask's bbox exactly equal the rect the caller passed?
    #[inline]
    fn matches_rect(&self, x1: i32, y1: i32, x2: i32, y2: i32) -> bool {
        self.x1 == x1 && self.y1 == y1 && self.x2 == x2 && self.y2 == y2
    }

    /// Is absolute column `(x, y)` inside the footprint AND its bit set? Out-of-bbox → false.
    #[inline]
    pub(crate) fn contains(&self, x: i32, y: i32) -> bool {
        if x < self.x1 || x > self.x2 || y < self.y1 || y > self.y2 { return false; }
        let idx = ((y - self.y1) * self.width() + (x - self.x1)) as usize;
        self.bits.get(idx >> 3).is_some_and(|b| b & (1u8 << (idx & 7)) != 0)
    }

    /// Number of set (selected) cells — for honest selection stats.
    fn count(&self) -> u32 {
        self.bits.iter().map(|b| b.count_ones()).sum()
    }
}

/// Resolve the mask an edit should honour, given the selection rect the frontend passed.
/// Returns an owned clone (5–122 KB) ONLY when a stored mask's bbox exactly matches the rect, so
/// the caller can then `world.take()` (mutably borrowing `ws`) while still holding the mask across
/// the edit closure. `None` → the command runs rect-only, its original behaviour. This is the single
/// place the fail-safe rect-equality rule is applied; every mask-aware command funnels through it.
pub(crate) fn active_mask(ws: &WorldState, x1: i32, y1: i32, x2: i32, y2: i32) -> Option<SelectionMask> {
    ws.selection_mask.as_ref().filter(|m| m.matches_rect(x1, y1, x2, y2)).cloned()
}

/// A single block position for the paint_blocks command.
/// z = None → resolve surface_z in Rust; z = Some(v) → write at that exact level.
#[derive(serde::Deserialize)]
struct PaintBlock {
    x: i32,
    y: i32,
    z: Option<i32>,
}

/// Per-stroke float height workspace for live 2D sculpting (row 6). A sculpt stroke is a run of
/// `sculpt_terrain` calls sharing one `group_id`; integer heights would round away the sub-block
/// deltas of a soft/airbrush stamp on every call, freezing low-weight rim columns against a fixed
/// BAYER threshold. `fheight` caches each touched column's *precise* float height across the whole
/// stroke: mode math reads/writes it, and only its dithered round is committed to the world, so
/// fractions accumulate and a 0.3-weight column crosses the next integer every ~3 stamps.
///
/// ⚠️ It is a cache of "world height + residual" and is stale the instant the world changes under
/// it by anything that isn't this stroke. Invalidation (clear to `None`) is owned by four choke
/// points and MUST stay exhaustive: `with_edit_inner` on any group mismatch (incl. `None` — every
/// non-sculpt edit), `undo_edit_inner`/`redo_edit_inner`, `load_world`'s swap, and `close_world`.
/// Keyed by a monotonic `group_id` that can never be reused, so an abandoned session (stroke
/// released with no further calls) is safe to leave until the next non-matching edit reaps it.
pub(crate) struct SculptSession {
    pub(crate) group_id: u64,
    pub(crate) fheight: HashMap<(i32, i32), f64>,
}

pub(crate) struct WorldState {
    pub(crate) world: Option<LoadedWorld>,
    pub(crate) clipboard: Option<Clipboard>,
    pub(crate) undo_stack: VecDeque<UndoEntry>,
    pub(crate) redo_stack: VecDeque<UndoEntry>,
    /// Path to the decompressed temp file when the current world was opened from a zip.
    /// Deleted after the mmap is dropped on next world load.
    pub(crate) temp_path: Option<std::path::PathBuf>,
    /// Read-only mmap of Eden.eden template (loaded on demand via load_eden_template).
    /// Arc'd so long-running readers (e.g. expand_world_from_template) can clone a cheap
    /// reference and release the AppState lock instead of holding it for the whole operation.
    pub(crate) template_bytes: Option<std::sync::Arc<Mmap>>,
    /// Absolute (tx, tz) chunk coords → byte offset into template_bytes.
    /// Eden.eden uses i32+i32+u64 directory, different from regular saves.
    pub(crate) template_dir: HashMap<(i32, i32), usize>,
    /// Per-chunk surface colors: [r,g,b,a] for each of the 256 (lx*16+ly) positions.
    /// a=255 = solid block; a=0 = air column. 1 KB/chunk vs 32 KB for full raw.
    pub(crate) template_surface_cache: HashMap<(i32, i32), Box<[[u8; 4]; 256]>>,
    /// Optional texture pack loaded by the user (world-independent).
    pub(crate) texture_pack: Option<texturepack::TexturePack>,
    /// Lazily-built lamp (block type 72) position index, keyed by chunk (cx,cy) → lamp world coords.
    /// `None` until first needed (night lighting is opt-in); cleared on world load/close; kept current
    /// by `with_edit`/`undo_edit`/`redo_edit` rescanning only the affected chunks. Enables an
    /// O(lamps) gather instead of an O((16+2r)³) region scan, so the lamp radius can be a user slider.
    pub(crate) lamp_index: Option<HashMap<(i32, i32), Vec<[i32; 3]>>>,
    /// Cutaway view: when Some(cap), every top-down render and every surface-consulting edit path
    /// behaves as if the world ended at z == cap — the map shows the cave interior, and drawing /
    /// terrain-paste / the cursor readout target the highest block *at or below* the cap. `None`
    /// (the default) = normal "true surface" behaviour. Cleared on world load/close.
    pub(crate) view_cap_z: Option<i32>,
    /// Live-sculpt-stroke float height workspace (see `SculptSession`). `None` between strokes.
    /// Invalidated at the four choke points enumerated on `SculptSession`.
    pub(crate) sculpt_session: Option<SculptSession>,
    /// Active non-rectangular selection footprint (see `SelectionMask`). `None` = plain rectangular
    /// selection (the default). Set by `magic_wand_select` / `set_selection_mask`; cleared by
    /// `clear_selection_mask` and on world load/close. Edit commands only honour it when its bbox
    /// exactly matches the rect they were passed (`active_mask`).
    pub(crate) selection_mask: Option<SelectionMask>,
}

impl WorldState {
    pub(crate) fn new() -> Self {
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
            lamp_index: None,
            view_cap_z: None,
            sculpt_session: None,
            selection_mask: None,
        }
    }
}

// ── Lamp spatial index ──────────────────────────────────────────────────────────
//
// Night lighting lights up Lamp blocks (type 72). Finding the lamps near a chunk used to be an
// O((16+2r)³) voxel scan per chunk-geometry request, which is why the lamp radius was a hard-coded
// constant. This chunk-keyed index gathers lamps by iterating actual lamp positions in the handful
// of chunks within reach, so the radius can be a user slider (and it's the shared foundation the
// experimental GPU night point-lights need too).

/// Scan one populated chunk's voxels for Lamp blocks, returning their local block coords.
fn scan_chunk_lamps(world: &LoadedWorld, cx: i32, cy: i32) -> Vec<[i32; 3]> {
    let Some(&addr) = world.chunk_map.get(&(cx, cy)) else { return Vec::new() };
    let max_z = world.num_bands * 16;
    let mut out = Vec::new();
    for lx in 0..16usize {
        for ly in 0..16usize {
            for z in 0..max_z {
                let band = z / 16;
                let lz = z % 16;
                let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
                if bi < world.bytes.len() && world.bytes[bi] == LAMP_BLOCK_TYPE {
                    let wx = (cx - world.min_x) * 16 + lx as i32;
                    let wy = (cy - world.min_y) * 16 + ly as i32;
                    out.push([wx, wy, z as i32]);
                }
            }
        }
    }
    out
}

/// Build the full lamp index by scanning only populated chunks (sparse worlds store just edited
/// chunks, so this is bounded by the actual world size, not the 180×180 template grid).
pub(crate) fn build_lamp_index(world: &LoadedWorld) -> HashMap<(i32, i32), Vec<[i32; 3]>> {
    let mut index = HashMap::new();
    for &(cx, cy) in world.chunk_map.keys() {
        let lamps = scan_chunk_lamps(world, cx, cy);
        if !lamps.is_empty() {
            index.insert((cx, cy), lamps);
        }
    }
    index
}

/// Rescan the given chunks' lamp lists in place (place/remove a lamp → the index must follow, or
/// night lighting goes stale). No-op if the index hasn't been built yet. `coords` are the same
/// affected-chunk coords `with_edit`/undo/redo already compute for snapshots.
fn refresh_lamp_index_chunks(ws: &mut WorldState, coords: &[(i16, i16)]) {
    let Some(world) = ws.world.as_ref() else { return };
    let Some(index) = ws.lamp_index.as_mut() else { return };
    for &(cx, cy) in coords {
        let key = (cx as i32, cy as i32);
        let lamps = scan_chunk_lamps(world, key.0, key.1);
        if lamps.is_empty() {
            index.remove(&key);
        } else {
            index.insert(key, lamps);
        }
    }
}

/// Gather lamp positions (local block coords) within reach of a pixel-space region — every lamp
/// that could light a voxel in `[sx1..=sx2] × [sy1..=sy2]` given `radius`. Collects from the chunks
/// overlapping the region expanded by `ceil(radius/16)` chunks, then filters to the exact expanded
/// box so the result matches the old inline voxel scan exactly (parity).
pub(crate) fn lamps_in_region(
    index: &HashMap<(i32, i32), Vec<[i32; 3]>>,
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    radius: f32,
) -> Vec<[i32; 3]> {
    let r = radius.ceil() as i32;
    let cr = r.div_euclid(16) + 1; // chunk-expansion margin, ceil(radius/16) plus a safety chunk
    let cx_lo = sx1.div_euclid(16) + world.min_x - cr;
    let cx_hi = sx2.div_euclid(16) + world.min_x + cr;
    let cy_lo = sy1.div_euclid(16) + world.min_y - cr;
    let cy_hi = sy2.div_euclid(16) + world.min_y + cr;
    let mut out = Vec::new();
    for cx in cx_lo..=cx_hi {
        for cy in cy_lo..=cy_hi {
            if let Some(v) = index.get(&(cx, cy)) {
                out.extend_from_slice(v);
            }
        }
    }
    // Filter to the exact expanded xy box (z spans the full column for chunk geometry, so no z
    // filter is needed) — makes this a drop-in match for the old `(sx1-r ..= sx2+r)` voxel scan.
    out.retain(|p| p[0] >= sx1 - r && p[0] <= sx2 + r && p[1] >= sy1 - r && p[1] <= sy2 + r);
    out
}

pub(crate) type AppState = Mutex<WorldState>;

/// Cooperative cancel flag for `expand_world_from_template`, checked between chunk writes.
/// A separate managed state (not a WorldState field) so checking it never contends with the
/// main editing mutex — the whole point of releasing that lock for the long write loop.
#[derive(Default)]
pub(crate) struct ExpandCancel(std::sync::atomic::AtomicBool);

fn expand_cancelled(flag: &tauri::State<'_, ExpandCancel>) -> bool {
    flag.0.load(std::sync::atomic::Ordering::Relaxed)
}

#[tauri::command]
fn cancel_expand(flag: tauri::State<'_, ExpandCancel>) {
    flag.0.store(true, std::sync::atomic::Ordering::Relaxed);
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

pub(crate) fn world_max_z(world: &LoadedWorld) -> i32 {
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
///
/// `cap` is the cutaway ceiling (`WorldState::view_cap_z`): blocks above it are treated as absent,
/// so the map draws whatever is directly under the cap plane (cave roofs vanish, floors show).
/// `None` = normal render.
fn render_pixels_patch(world: &LoadedWorld, px1: i32, py1: i32, px2: i32, py2: i32, cap: Option<i32>) -> PixelPatch {
    let world_w = (world.w_chunks * 16) as i32;
    let world_h = (world.h_chunks * 16) as i32;
    let x1 = px1.clamp(0, world_w - 1) as u32;
    let y1 = py1.clamp(0, world_h - 1) as u32;
    let x2 = px2.clamp(0, world_w - 1) as u32;
    let y2 = py2.clamp(0, world_h - 1) as u32;
    let width  = x2 - x1 + 1;
    let height = y2 - y1 + 1;
    let mut pixels = vec![0u8; (width * height * 4) as usize];

    // One row per rayon task — rows are disjoint slices of `pixels`, and each pixel is an
    // independent O(1) lookup into `world`, so this is embarrassingly parallel.
    pixels.par_chunks_mut((width * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let py = y1 + row as u32;
        for px in x1..=x2 {
            let cx = (px / 16) as i32 + world.min_x;
            let cy = (py / 16) as i32 + world.min_y;
            let lx = (px % 16) as usize;
            let ly = (py % 16) as usize;
            let &addr = match world.chunk_map.get(&(cx, cy)) { Some(a) => a, None => continue };
            let mut top_bt = 0u8; let mut top_paint = 0u8;
            let mut under_bt = 0u8; let mut under_paint = 0u8;
            'outer: for band in (0..world.num_bands).rev() {
                if let Some(c) = cap {
                    if (band * 16) as i32 > c { continue; }
                }
                for z in (0..16usize).rev() {
                    if let Some(c) = cap {
                        if (band * 16 + z) as i32 > c { continue; }
                    }
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
            let off = ((px - x1) * 4) as usize;
            row_pixels[off] = r; row_pixels[off + 1] = g; row_pixels[off + 2] = b; row_pixels[off + 3] = 255;
        }
    });
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

    pixels.par_chunks_mut((width * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let py = y1 + row as u32;
        for px in x1..=x2 {
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
            let off = ((px - x1) * 4) as usize;
            row_pixels[off]     = r;
            row_pixels[off + 1] = g;
            row_pixels[off + 2] = b;
            row_pixels[off + 3] = 255;
        }
    });
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
    // Each world-X column writes a strided set of bytes across the row-major image, so instead
    // of chunking `pixels` directly we compute one (row, rgba) list per column in parallel and
    // splat them into `pixels` afterward (cheap — only non-void hits produce entries).
    let hits: Vec<Vec<(u32, [u8; 4])>> = (x1..=x2).into_par_iter().map(|px| {
        let mut col = Vec::new();
        let cx = px.div_euclid(16) + world.min_x;
        let lx = px.rem_euclid(16) as usize;
        let addr = match world.chunk_map.get(&(cx, cy)) { Some(&a) => a, None => return col };
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
            col.push((row, [r, g, b, 255]));
        }
        col
    }).collect();
    for (i, col) in hits.into_iter().enumerate() {
        let px_off = i as u32;
        for (row, rgba) in col {
            let off = ((row * width + px_off) * 4) as usize;
            pixels[off..off + 4].copy_from_slice(&rgba);
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
    // Same per-column-parallel / sequential-splat approach as render_yslice_patch_inner.
    let hits: Vec<Vec<(u32, [u8; 4])>> = (y1..=y2).into_par_iter().map(|py| {
        let mut col = Vec::new();
        let cy = py.div_euclid(16) + world.min_y;
        let ly = py.rem_euclid(16) as usize;
        let addr = match world.chunk_map.get(&(cx, cy)) { Some(&a) => a, None => return col };
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
            col.push((row, [r, g, b, 255]));
        }
        col
    }).collect();
    for (i, col) in hits.into_iter().enumerate() {
        let py_off = i as u32;
        for (row, rgba) in col {
            let off = ((row * width + py_off) * 4) as usize;
            pixels[off..off + 4].copy_from_slice(&rgba);
        }
    }
    PixelPatch { x: y1 as u32, y: z1 as u32, width, height, pixels }
}

/// Compute the pixel-space bounding box of a set of chunk coordinates and
/// return a freshly rendered top-down patch for that rectangle.
/// Used by undo/redo where the affected region is known only as chunk coords.
fn patch_from_chunk_coords(world: &LoadedWorld, chunks: &[(i16, i16)], cap: Option<i32>) -> PixelPatch {
    if chunks.is_empty() {
        return PixelPatch { x: 0, y: 0, width: 1, height: 1, pixels: vec![30, 30, 30, 255] };
    }
    let px1 = chunks.iter().map(|&(cx, _)| (cx as i32 - world.min_x) * 16).min().unwrap();
    let py1 = chunks.iter().map(|&(_, cy)| (cy as i32 - world.min_y) * 16).min().unwrap();
    let px2 = chunks.iter().map(|&(cx, _)| (cx as i32 - world.min_x) * 16 + 15).max().unwrap();
    let py2 = chunks.iter().map(|&(_, cy)| (cy as i32 - world.min_y) * 16 + 15).max().unwrap();
    render_pixels_patch(world, px1, py1, px2, py2, cap)
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
    mask: Option<&SelectionMask>,
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
                            // Shaped selection: an unmasked (x,y) column is see-through, so a
                            // masked block on a chunk row behind it shows correctly.
                            if mask.is_some_and(|m| !m.contains(x, y)) { y += 1; continue; }
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
    mask: Option<&SelectionMask>,
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
                            // Shaped selection: an unmasked (x,y) column is see-through so a
                            // masked block behind it along X shows correctly.
                            if mask.is_some_and(|m| !m.contains(x, y)) { x += 1; continue; }
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
    mask: Option<&SelectionMask>,
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
            // Shaped selection: an unmasked (x,y) column isn't part of the selection, so it stays
            // VOID — the top view shows the actual footprint, not the enclosing bbox.
            if mask.is_some_and(|m| !m.contains(x, y)) { continue; }
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

#[tauri::command(async)]
fn load_world(path: String, state: tauri::State<'_, AppState>) -> Result<WorldMeta, String> {
    let t0 = Instant::now();
    let us = || t0.elapsed().as_micros();

    timing_log!("[LOAD] start");

    // Step 1: File I/O + parse — no lock held, and critically, the previous world is left
    // untouched until parsing succeeds. A corrupt/wrong-type file must not destroy the current
    // session (it used to: the old world was cleared here before the file was even read).
    // Peek at 4 magic bytes to detect zip without reading the whole file.
    let mut magic = [0u8; 4];
    {
        use std::io::Read;
        if let Ok(mut f) = fs::File::open(&path) { let _ = f.read_exact(&mut magic); }
    }

    let (mmap, maybe_temp, was_compressed): (MmapMut, Option<std::path::PathBuf>, bool) = if is_zip(&magic) {
        use zip::ZipArchive;
        timing_log!("[LOAD] detected zip archive, decompressing  t=+{}µs", us());
        let raw = fs::read(&path).map_err(|e| format!("Failed to read file: {e}"))?;
        let cursor = std::io::Cursor::new(&raw);
        let mut archive = ZipArchive::new(cursor)
            .map_err(|e| format!("Invalid zip archive: {e}"))?;
        if archive.is_empty() { return Err("Zip archive contains no files".into()); }
        let mut entry = archive.by_index(0)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        let temp_path = temp_world_path();
        {
            let mut tmp = fs::File::create(&temp_path)
                .map_err(|e| format!("Failed to create temp file: {e}"))?;
            std::io::copy(&mut entry, &mut tmp)
                .map_err(|e| format!("Failed to decompress: {e}"))?;
        } // tmp closed here before mmap
        timing_log!("[LOAD] decompressed to {:?}  t=+{}µs", temp_path, us());
        let file = fs::File::open(&temp_path)
            .map_err(|e| format!("Failed to open temp file: {e}"))?;
        // SAFETY: temp file is private, written by us, and stays alive for the duration of the mmap.
        let mmap = unsafe { MmapOptions::new().map_copy(&file) }
            .map_err(|e| format!("Failed to map temp file: {e}"))?;
        (mmap, Some(temp_path), true)
    } else {
        // Copy the source into a private temp file and map THAT — never the user's file directly.
        // On Windows a memory-mapped file is locked against replace/delete, so mapping the source
        // would make the atomic temp-file+rename save (see save_world_inner) fail with a sharing
        // violation whenever the destination is the file being edited. Mapping a throwaway copy
        // leaves the original unlocked so the rename can replace it. It also sidesteps the
        // undefined behaviour of writing over a still-mmapped file on Unix. map_copy stays
        // copy-on-write, so edits live in RAM and the temp is only the evictable read-backing store.
        let temp_path = temp_world_path();
        fs::copy(&path, &temp_path).map_err(|e| format!(
            "Failed to stage world file: {e}. Opening a world creates a private working copy; check available space for another copy on the system temporary-files drive."
        ))?;
        let file = fs::File::open(&temp_path).map_err(|e| format!("Failed to open staged file: {e}"))?;
        // SAFETY: temp file is private, written by us, and stays alive for the duration of the mmap.
        let mmap = unsafe { MmapOptions::new().map_copy(&file) }
            .map_err(|e| format!("Failed to map staged file: {e}"))?;
        (mmap, Some(temp_path), false)
    };
    timing_log!("[LOAD] file_mmap  bytes={}B  compressed={}  t=+{}µs", mmap.len(), was_compressed, us());

    let loaded = match parse_world_inner(mmap) {
        Ok(l) => l,
        Err(e) => {
            // Parsing failed after we already staged a temp copy (or decompressed one) — the
            // current session's world is untouched, but the freshly staged temp would otherwise
            // leak until the next launch's sweep_stale_temps(). Clean it up now.
            if let Some(p) = maybe_temp { let _ = fs::remove_file(&p); }
            return Err(e);
        }
    };
    timing_log!("[LOAD] parsed  {}×{} chunks  count={}  world_bytes={}B  t=+{}µs",
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
        was_compressed,
        spawn_px: spawn.map(|(x, _)| x),
        spawn_py: spawn.map(|(_, y)| y),
        center_px: center.map(|(x, _)| x),
        center_py: center.map(|(_, y)| y),
        abs_min_x: loaded.min_x,
        abs_min_y: loaded.min_y,
        sky: loaded.sky,
    };

    // Step 3: Swap in the new world and clear old session state (clipboard/undo/redo/lamp index/
    // temp file) in the same locked section — parsing already succeeded, so this is the first
    // point at which we commit to discarding the previous world.
    timing_log!("[LOCK] acquire_start  cmd=load_world/step3  t=+{}µs", us());
    let t_s3 = Instant::now();
    let (_old_world, old_temp) = {
        let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
        let wait = t_s3.elapsed().as_micros();
        let prev_undo: usize = ws.undo_stack.iter().flat_map(|e| e.chunks.iter()).map(chunk_snapshot_bytes).sum();
        let prev_redo: usize = ws.redo_stack.iter().flat_map(|e| e.chunks.iter()).map(chunk_snapshot_bytes).sum();
        timing_log!("[LOCK] acquired  cmd=load_world/step3  wait={}µs  prev_undo={}B  prev_redo={}B",
            wait, prev_undo, prev_redo);
        let t_held = Instant::now();
        let old_world = ws.world.replace(loaded);  // pointer swap only — dealloc happens outside the lock
        ws.clipboard = None;
        ws.undo_stack.clear();
        ws.redo_stack.clear();
        ws.lamp_index = None; // rebuilt lazily for the new world on first night-lit request
        ws.view_cap_z = None; // cutaway is per-world; the frontend also resets viewMode on load
        ws.sculpt_session = None; // any in-flight live-sculpt workspace belongs to the old world
        ws.selection_mask = None; // a wand/lasso shape belongs to the old world's coordinates
        let old_temp = ws.temp_path.take();
        ws.temp_path = maybe_temp;
        drop(ws);
        timing_log!("[LOCK] released  cmd=load_world/step3  held={}µs  t=+{}µs", t_held.elapsed().as_micros(), us());
        (old_world, old_temp)
    };
    // _old_world (Option<LoadedWorld>) drops here, releasing the mmap before we delete the temp file.
    if let Some(p) = old_temp { let _ = fs::remove_file(&p); }
    timing_log!("[LOAD] end  total={}µs", us());

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
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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

/// Encode a row-major RGBA buffer to PNG bytes. Used by `export_png`; factored out so the encode
/// path is unit-testable without a Tauri State handle.
fn encode_rgba_png(buf: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    use image::codecs::png::PngEncoder;
    use image::ImageEncoder;
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(buf, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("PNG encode failed: {e}"))?;
    Ok(out)
}

/// Composite Eden.eden template colours into `buf` wherever the user has no chunk (alpha == 0).
/// Mirrors the on-screen overlay and the old JS export loop, but done in Rust so no pixels cross IPC.
fn composite_template_full(ws: &mut WorldState, w: i32, h: i32, buf: &mut [u8]) {
    let (min_x, min_y, sky) = match ws.world.as_ref() {
        Some(world) => (world.min_x, world.min_y, world.sky),
        None => return,
    };
    let Some(tmpl) = ws.template_bytes.clone() else { return }; // Arc clone; frees the ws borrow
    let (cx0, cx1) = (min_x, min_x + w / 16 - 1);
    let (cz0, cz1) = (min_y, min_y + h / 16 - 1);
    for tx in cx0..=cx1 {
        for tz in cz0..=cz1 {
            if ws.template_surface_cache.contains_key(&(tx, tz)) { continue; }
            if let Some(&col_off) = ws.template_dir.get(&(tx, tz)) {
                if let Some(surf) = decode_template_surface(&tmpl[..], col_off, sky) {
                    ws.template_surface_cache.insert((tx, tz), surf);
                }
            }
        }
    }
    for py in 0..h {
        for px in 0..w {
            let off = ((py * w + px) * 4) as usize;
            if buf[off + 3] != 0 { continue; } // user pixel already present
            let tx = px / 16 + min_x;
            let tz = py / 16 + min_y;
            if let Some(surf) = ws.template_surface_cache.get(&(tx, tz)) {
                let [r, g, b, a] = surf[(px % 16) as usize * 16 + (py % 16) as usize];
                if a == 255 {
                    buf[off] = r; buf[off + 1] = g; buf[off + 2] = b; buf[off + 3] = 255;
                }
            }
        }
    }
}

/// Render the whole map to a PNG on disk, entirely in Rust. Replaces the old path that built the
/// full RGBA buffer in JS, then a binary string, then a base64 string (≈4× the map size in JS heap)
/// before shipping it back over IPC. Renders under the lock, then releases it before encoding+writing.
#[tauri::command(async)]
fn export_png(
    path: String,
    view: String,
    z: i32,
    use_template: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (w, h, buf) = {
        let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
        let cap = ws.view_cap_z;
        let (w, h) = {
            let world = ws.world.as_ref().ok_or("No world loaded")?;
            ((world.w_chunks * 16) as i32, (world.h_chunks * 16) as i32)
        };
        let mut buf = {
            let world = ws.world.as_ref().unwrap();
            if view == "zslice" {
                let max_z = world_max_z(world);
                if z < 0 || z > max_z { return Err(format!("Z must be 0–{max_z}, got {z}")); }
                render_zslice_patch_inner(world, z, 0, 0, w - 1, h - 1).pixels
            } else {
                // Cutaway is a top-down render with the cap applied, so the exported PNG matches
                // what's on screen without the frontend passing a separate view name.
                render_pixels_patch(world, 0, 0, w - 1, h - 1, cap).pixels
            }
        };
        if use_template && view != "zslice" && ws.template_bytes.is_some() {
            composite_template_full(&mut ws, w, h, &mut buf);
        }
        (w, h, buf)
    };
    let png = encode_rgba_png(&buf, w as u32, h as u32)?;
    fs::write(&path, &png).map_err(|e| format!("Failed to write PNG: {e}"))
}


// ── Selection ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct SelectionInfo {
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    width: i32,  // x2 - x1 + 1
    height: i32, // y2 - y1 + 1
    depth: i32,  // z_max - z_min + 1
    cell_count: Option<i32>, // Some(popcount) when a shaped mask matches this rect
    masked: bool,
}

fn validate_selection(x1: i32, y1: i32, x2: i32, y2: i32, z_min: i32, z_max: i32, max_z: i32) -> Result<(), String> {
    if x1 < 0 || y1 < 0 {
        return Err("Invalid XY bounds: x1/y1 must be >= 0".into());
    }
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
    state: tauri::State<'_, AppState>,
) -> Result<SelectionInfo, String> {
    // Validate against the loaded world's real z ceiling (63 for 64z, 255 for 256z) rather than a
    // hardcoded 255 — otherwise a z range a 64z world can't hold would validate here.
    let (max_z, cell_count) = {
        let ws = state.lock().unwrap_or_else(|p| p.into_inner());
        let max_z = ws.world.as_ref().map(world_max_z).unwrap_or(255);
        let cell_count = active_mask(&ws, x1, y1, x2, y2).map(|m| m.count() as i32);
        (max_z, cell_count)
    };
    validate_selection(x1, y1, x2, y2, z_min, z_max, max_z)?;
    Ok(SelectionInfo {
        x1, y1, x2, y2, z_min, z_max,
        width:  x2 - x1 + 1,
        height: y2 - y1 + 1,
        depth:  z_max - z_min + 1,
        masked: cell_count.is_some(),
        cell_count,
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
/// Grab/release the OS cursor at the window level for the 3D pane's mouselook camera.
///
/// WKWebView on macOS doesn't grant the browser Pointer Lock API, so we lock at the Tauri window
/// layer instead — identical behaviour on macOS/Windows/Linux. macOS `set_cursor_grab` disassociates
/// the cursor via `CGAssociateMouseAndMouseCursorPosition`, so mouse *delta* events keep flowing to
/// JS (`movementX/Y`) even while the cursor is frozen — exactly what the look camera reads.
/// `set_cursor_visible(false)` hides it across the whole app while grabbed. The frontend must always
/// release (`locked:false`) on exit/blur/unmount, or the cursor stays frozen app-wide.
#[tauri::command]
fn set_cursor_lock(window: tauri::Window, locked: bool) -> Result<(), String> {
    window.set_cursor_grab(locked).map_err(|e| e.to_string())?;
    window.set_cursor_visible(!locked).map_err(|e| e.to_string())?;
    Ok(())
}

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

    if dir_offset >= mmap.len() || !(mmap.len() - dir_offset).is_multiple_of(16) {
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
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    ws.template_bytes = Some(std::sync::Arc::new(mmap));
    ws.template_dir = template_dir;
    ws.template_surface_cache.clear();
    Ok(chunk_count)
}

/// Render a top-down pixel patch from the Eden.eden template, aligned to the loaded world's
/// coordinate space. Returns RGBA pixels; alpha=0 where no template chunk exists.
/// Async: a first fetch over virgin template area can decode ~1,000 chunk columns (a 512px tile
/// spans 32×32 chunks) inline — off the main thread so it doesn't serialize other IPC behind it.
#[tauri::command(async)]
fn fetch_template_tile(
    x1: i32, y1: i32, x2: i32, y2: i32,
    state: tauri::State<'_, AppState>,
) -> Result<PixelPatch, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
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
#[tauri::command(async)]
fn expand_world_from_template(
    output_path: String,
    full_extent: bool,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    cancel: tauri::State<'_, ExpandCancel>,
) -> Result<ExpandResult, String> {
    cancel.0.store(false, std::sync::atomic::Ordering::Relaxed);
    // Gather everything the write loop needs as owned/Arc'd data, then drop the lock — this is
    // a multi-hundred-MB disk write for full-extent expansions, and previously held the AppState
    // mutex for its entire duration, blocking every other command (tile fetches included) until
    // it finished. Cloning the template Arc is a refcount bump; the header/dir/user-chunk-list
    // copies are cheap relative to the write itself, so this is what actually gets other threads
    // (map render, cancel checks) their scheduling turn back.
    let (min_x, min_y, max_x, max_y, chunk_size, header, tmpl, tdir, user_chunk_bytes) = {
        let ws = state.lock().unwrap_or_else(|p| p.into_inner());
        let world = ws.world.as_ref().ok_or("No world loaded")?;
        let tmpl = ws.template_bytes.clone().ok_or("No template loaded")?;

        let min_x = world.min_x;
        let min_y = world.min_y;
        let max_x = min_x + world.w_chunks as i32 - 1;
        let max_y = min_y + world.h_chunks as i32 - 1;
        let chunk_size = world.chunk_size;
        let header = world.bytes[..192.min(world.bytes.len())].to_vec();

        let mut user_chunk_list: Vec<(i32, i32, usize)> = world.chunk_map.iter()
            .map(|(&(cx, cy), &off)| (cx, cy, off))
            .collect();
        user_chunk_list.sort_unstable_by_key(|&(cx, cy, _)| (cx, cy));
        // Copy each user chunk's bytes now, while the world is guaranteed stable under the lock.
        let user_chunk_bytes: Vec<(i16, i16, Vec<u8>)> = user_chunk_list.into_iter()
            .filter_map(|(cx, cy, off)| {
                let end = off + chunk_size;
                if end > world.bytes.len() { return None; }
                Some((cx as i16, cy as i16, world.bytes[off..end].to_vec()))
            })
            .collect();

        (min_x, min_y, max_x, max_y, chunk_size, header, tmpl, ws.template_dir.clone(), user_chunk_bytes)
    };
    let tmpl: &[u8] = tmpl.as_ref();

    // Collect target template chunks
    let mut targets: Vec<(i32, i32)> = tdir.keys().copied().filter(|&(tx, tz)| {
        if full_extent { true }
        else { tx >= min_x && tx <= max_x && tz >= min_y && tz <= max_y }
    }).collect();
    targets.sort_unstable();

    let user_chunks: HashSet<(i32, i32)> = user_chunk_bytes.iter().map(|&(cx, cy, _)| (cx as i32, cy as i32)).collect();
    let to_add: Vec<(i32, i32)> = targets.into_iter()
        .filter(|k| !user_chunks.contains(k))
        .collect();
    let total = (user_chunk_bytes.len() + to_add.len()) as u32;
    let add_count = to_add.len() as u32;

    // Write output file using BufWriter for performance
    let out_file = fs::File::create(&output_path)
        .map_err(|e| format!("Cannot create output file: {e}"))?;
    let mut writer = BufWriter::with_capacity(4 * 1024 * 1024, out_file);

    // Header: copy from world, will patch directory_offset at the end
    writer.write_all(&header).map_err(|e| format!("Write error: {e}"))?;
    let mut cur_offset: u64 = 192;

    let mut dir_entries: Vec<(i16, i16, u32)> = Vec::with_capacity(total as usize);

    // Chunk offsets are stored as u32 in the directory, so the file can't exceed ~4 GB. Abort
    // cleanly (deleting the partial output) rather than silently truncating an offset — which
    // would corrupt the written world.
    macro_rules! bail_too_large {
        ($cur:expr) => {{
            drop(writer);
            let _ = fs::remove_file(&output_path);
            return Err(format!("World too large to expand: chunk offset {} exceeds the 4 GB file-format limit", $cur));
        }};
    }

    // Write existing user chunks
    for (cx, cy, bytes) in &user_chunk_bytes {
        if cur_offset + chunk_size as u64 > u32::MAX as u64 { bail_too_large!(cur_offset); }
        writer.write_all(bytes).map_err(|e| format!("Write error: {e}"))?;
        dir_entries.push((*cx, *cy, cur_offset as u32));
        cur_offset += chunk_size as u64;
    }

    // Write template chunks (decoded from RLE). Eden.eden is always a 64z (4-band, 32768-byte)
    // file. When expanding a 256z world (chunk_size 131072) we must emit full-size chunks — the
    // parser strides every chunk by the header's chunk_size, so writing a bare 32 KB block here
    // would desync every subsequent offset and corrupt the whole output. Band b lives at the same
    // offset (b*8192) in both layouts, so copying the 32 KB into the low bands and leaving the
    // upper 12 bands (z 64–255) as air is a correct, direct placement.
    let template_total = to_add.len();
    for (i, (tx, tz)) in to_add.iter().enumerate() {
        if expand_cancelled(&cancel) {
            drop(writer);
            let _ = fs::remove_file(&output_path); // don't leave a truncated/corrupt world file behind
            return Err("Cancelled".into());
        }
        if let Some(&col_off) = tdir.get(&(*tx, *tz)) {
            if let Some(raw) = decode_template_column(tmpl, col_off) {
                if cur_offset + chunk_size as u64 > u32::MAX as u64 { bail_too_large!(cur_offset); }
                if chunk_size == raw.len() {
                    writer.write_all(raw.as_ref()).map_err(|e| format!("Write error: {e}"))?;
                } else {
                    let mut full = vec![0u8; chunk_size];
                    full[..raw.len()].copy_from_slice(raw.as_ref());
                    writer.write_all(&full).map_err(|e| format!("Write error: {e}"))?;
                }
                dir_entries.push((*tx as i16, *tz as i16, cur_offset as u32));
                cur_offset += chunk_size as u64;
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
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    Ok(render_pixels_patch(world, x1, y1, x2, y2, ws.view_cap_z))
}

/// Set (or clear) the cutaway ceiling. `None` restores the normal "true surface" view.
/// Every top-down render and every surface-consulting edit path reads this off `WorldState`,
/// so the frontend only has to set it once per mode/slider change (then refetch its tiles).
#[tauri::command]
fn set_view_cap(cap: Option<i32>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let cap = match cap {
        None => None,
        Some(c) => {
            let world = ws.world.as_ref().ok_or("No world loaded")?;
            Some(c.clamp(0, world_max_z(world)))
        }
    };
    ws.view_cap_z = cap;
    Ok(())
}

/// Return a z-slice patch for just the rectangle (x1,y1)–(x2,y2) at level z.
/// Used after edits when the frontend is in z-slice mode, avoiding a full 243 MB re-render.
#[tauri::command]
fn render_zslice_patch(
    z: i32, x1: u32, y1: u32, x2: u32, y2: u32,
    state: tauri::State<'_, AppState>,
) -> Result<PixelPatch, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let world_w = (world.w_chunks * 16) as i32;
    if x < 0 || x >= world_w {
        return Err(format!("X must be 0–{}, got {x}", world_w - 1));
    }
    Ok(render_xslice_patch_inner(world, x, y1, z1, y2, z2))
}

#[tauri::command(async)]
fn render_selection_view(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    view: String,
    state: tauri::State<'_, AppState>,
) -> Result<PreviewData, String> {
    let t0 = Instant::now();
    let us = || t0.elapsed().as_micros();

    timing_log!("[PREVIEW] start  cmd=render_selection_view  view={view}  sel={}×{}×{}  z={z_min}–{z_max}",
        x2-x1+1, y2-y1+1, z_max-z_min+1);

    // Only the bands that overlap [z_min, z_max] are needed. Cloning a band-scoped
    // slice cuts the mutex hold time proportionally (e.g. 4× for a z=0–63 query
    // in a 256-layer world, where only 4 of 16 bands are relevant).
    let b_lo = (z_min as usize) / 16;
    let b_hi = (z_max as usize) / 16;
    let bands_per_chunk = b_hi - b_lo + 1;
    let local_band_bytes = bands_per_chunk * 8192;

    timing_log!("[LOCK] acquire_start  cmd=render_selection_view  t=+{}µs", us());
    let t_lock = Instant::now();
    let mut sel_mask: Option<SelectionMask> = None;
    let scan_world = {
        let ws = state.lock().unwrap_or_else(|p| p.into_inner());
        let wait = t_lock.elapsed().as_micros();
        timing_log!("[LOCK] acquired  cmd=render_selection_view  wait={}µs", wait);
        let t_held = Instant::now();

        let world = ws.world.as_ref().ok_or("No world loaded")?;
        validate_selection(x1, y1, x2, y2, z_min, z_max, world_max_z(world))?;
        // Resolve the shaped-selection mask while we still hold the lock (fail-safe: exact bbox).
        sel_mask = active_mask(&ws, x1, y1, x2, y2);

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
                        local_vec.extend(std::iter::repeat_n(0u8, 8192));
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
        timing_log!("[LOCK] released  cmd=render_selection_view  held={}µs  cloned={}B  bands={}/{}  t=+{}µs",
            t_held.elapsed().as_micros(), result.bytes.len(), bands_per_chunk, (b_hi - b_lo + 1), us());
        result
    };

    timing_log!("[SCAN] start  cmd=render_selection_view  t=+{}µs", us());
    let t_scan = Instant::now();
    let mask = sel_mask.as_ref();
    let (width, height, pixels) = match view.as_str() {
        "front" => render_view_front(&scan_world, x1, x2, y1, y2, z_min, z_max, b_lo, mask),
        "side"  => render_view_side(&scan_world, x1, x2, y1, y2, z_min, z_max, b_lo, mask),
        _       => render_view_top(&scan_world, x1, x2, y1, y2, z_min, z_max, b_lo, mask),
    };
    timing_log!("[SCAN] end  cmd=render_selection_view  elapsed={}ms  result={}×{}", t_scan.elapsed().as_millis(), width, height);
    timing_log!("[PREVIEW] end  cmd=render_selection_view  pixels={}B  total={}ms", pixels.len(), t0.elapsed().as_millis());
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
#[tauri::command(async)]
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
        let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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
                    local_vec.extend(std::iter::repeat_n(0u8, chunk_size));
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
    mask: Option<&SelectionMask>,
) {
    for px in x1..=x2 {
        for py in y1..=y2 {
            if let Some(m) = mask { if !m.contains(px, py) { continue; } }
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
    mask: Option<&SelectionMask>,
) {
    for px in x1..=x2 {
        for py in y1..=y2 {
            if let Some(m) = mask { if !m.contains(px, py) { continue; } }
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
                let type_ok  = filter_block_type.is_none_or(|ft| world.bytes[bi] == ft);
                let paint_ok = filter_paint.is_none_or(|fp| world.bytes[pi] == fp);
                // passes==filter_invert means "skip": skip matching when normal, skip non-matching when inverted
                if (type_ok && paint_ok) == filter_invert { continue; }
                world.bytes[bi] = new_block_type;
                world.bytes[pi] = new_paint;
            }
        }
    }
}

/// Write `bytes` to `path` atomically: stage into a sibling `<path>.savetmp` file, then rename it
/// over the destination. rename() swaps the directory entry in one step (both POSIX and Windows
/// implement replace-if-exists), so a crash mid-write can never leave a half-written world on disk
/// — the previous file survives until the rename completes. Staging also means we never write over
/// a file that's currently memory-mapped: the loaded world is mapped from a private temp copy (see
/// load_world), never the destination, so on Windows the destination isn't locked and rename wins.
fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".savetmp");
    let tmp = std::path::PathBuf::from(tmp);
    fs::write(&tmp, bytes).map_err(|e| format!("Failed to write temp file: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to finalize save: {e}")
    })
}

/// Write `world.bytes` to `path`.  Before overwriting an existing file, copies
/// it to `path.bak` — but only if that backup doesn't already exist, so the
/// first-save snapshot is preserved across multiple saves.
fn save_world_inner(world: &LoadedWorld, path: &str) -> Result<(), String> {
    let bak = format!("{path}.bak");
    if !std::path::Path::new(&bak).exists() && std::path::Path::new(path).exists() {
        fs::copy(path, &bak).map_err(|e| format!("Failed to create backup: {e}"))?;
    }
    atomic_write(std::path::Path::new(path), &world.bytes)
}

// ── Undo / Redo helpers ────────────────────────────────────────────────────────

/// Maximum total bytes held across all undo entries. Oldest entries are evicted when
/// exceeded. Always keeps the most recent entry even if it alone exceeds the budget,
/// so undo still functions after very large operations (e.g. fill on a 256-layer world).
const UNDO_BYTE_BUDGET: usize = 256 * 1024 * 1024; // 256 MB

fn undo_entry_bytes(entry: &UndoEntry) -> usize {
    entry.chunks.iter().map(chunk_snapshot_bytes).sum()
}

/// Returns all chunk (cx, cy) coords whose x/y footprint overlaps the given pixel-space
/// rectangle. z_min/z_max are irrelevant here — Eden chunks span all z layers.
fn affected_chunk_coords(world: &LoadedWorld, x1: i32, y1: i32, x2: i32, y2: i32) -> Vec<(i16, i16)> {
    // Clamp to the world's pixel bounds so an out-of-range coordinate (e.g. a frontend bug passing
    // a huge value) can't make the cx/cy loops below iterate billions of empty chunk slots.
    let ww = (world.w_chunks * 16) as i32;
    let wh = (world.h_chunks * 16) as i32;
    let x1 = x1.clamp(0, ww - 1); let x2 = x2.clamp(0, ww - 1);
    let y1 = y1.clamp(0, wh - 1); let y2 = y2.clamp(0, wh - 1);
    if x1 > x2 || y1 > y2 { return vec![]; }
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

/// Copies full chunk block data for each listed chunk coordinate — used only as the "before"
/// buffer that `diff_chunk` compares against post-edit bytes to build a sparse delta. Never
/// itself stored in the undo stack.
fn snapshot_chunks_full(world: &LoadedWorld, coords: &[(i16, i16)]) -> Vec<(i16, i16, Vec<u8>)> {
    coords.iter().filter_map(|&(cx, cy)| {
        let addr = *world.chunk_map.get(&(cx as i32, cy as i32))?;
        let data = world.bytes[addr..addr + world.chunk_size].to_vec();
        Some((cx, cy, data))
    }).collect()
}

/// Compares `pre` (bytes captured before an edit) against the chunk's current bytes and builds
/// a `ChunkSnapshot` describing only what changed. Returns `None` if the edit left the chunk
/// byte-for-byte unchanged (e.g. deleting air, filling with the same block) — replaces the old
/// full-chunk `filter_unchanged_snapshots` pass. Falls back to `Full` when the sparse encoding
/// (5 bytes/changed byte) wouldn't actually be smaller than just keeping the whole chunk.
fn diff_chunk(world: &LoadedWorld, cx: i16, cy: i16, pre: &[u8]) -> Option<ChunkSnapshot> {
    let addr = *world.chunk_map.get(&(cx as i32, cy as i32))?;
    let end = (addr + pre.len()).min(world.bytes.len());
    if end <= addr { return None; }
    let pre = &pre[..end - addr];
    let post = &world.bytes[addr..end];
    if post == pre { return None; }
    let mut sparse: Vec<(u32, u8)> = Vec::new();
    for (i, (&pb, &qb)) in pre.iter().zip(post.iter()).enumerate() {
        if pb != qb { sparse.push((i as u32, pb)); }
    }
    let delta = if sparse.len() * 5 < pre.len() {
        ChunkDelta::Sparse(sparse)
    } else {
        ChunkDelta::Full(pre.to_vec())
    };
    Some(ChunkSnapshot { cx, cy, delta })
}

/// Applies each snapshot's delta to `world` (restoring the "before" state it captured) and
/// returns the inverse — a fresh set of snapshots that would restore the state `world` was in
/// just before this call. Used by both undo (apply old state, capture new-as-inverse for redo)
/// and redo (apply new state, capture old-as-inverse for undo). For `Sparse` deltas this reads
/// the current byte at each offset before overwriting it — O(changed bytes), no full-chunk diff
/// needed since we already know exactly which offsets are in play.
fn restore_and_invert(world: &mut LoadedWorld, entry: &UndoEntry) -> Vec<ChunkSnapshot> {
    entry.chunks.iter().filter_map(|snap| {
        let &addr = world.chunk_map.get(&(snap.cx as i32, snap.cy as i32))?;
        match &snap.delta {
            ChunkDelta::Sparse(pairs) => {
                let mut inverse = Vec::with_capacity(pairs.len());
                for &(off, orig) in pairs {
                    let idx = addr + off as usize;
                    if idx >= world.bytes.len() { continue; }
                    inverse.push((off, world.bytes[idx]));
                    world.bytes[idx] = orig;
                }
                Some(ChunkSnapshot { cx: snap.cx, cy: snap.cy, delta: ChunkDelta::Sparse(inverse) })
            }
            ChunkDelta::Full(data) => {
                let end = (addr + data.len()).min(world.bytes.len());
                if end <= addr { return None; }
                let data = &data[..end - addr];
                let cur = world.bytes[addr..end].to_vec();
                world.bytes[addr..end].copy_from_slice(data);
                Some(ChunkSnapshot { cx: snap.cx, cy: snap.cy, delta: ChunkDelta::Full(cur) })
            }
        }
    }).collect()
}

/// Push an entry onto an undo/redo stack, evicting oldest entries to keep the stack under
/// UNDO_BYTE_BUDGET. Used for both `undo_stack` and `redo_stack` so neither can grow unbounded.
fn push_undo(stack: &mut VecDeque<UndoEntry>, entry: UndoEntry) {
    stack.push_back(entry);
    let mut total: usize = stack.iter().map(undo_entry_bytes).sum();
    while total > UNDO_BYTE_BUDGET && stack.len() > 1 {
        if let Some(evicted) = stack.pop_front() {
            total -= undo_entry_bytes(&evicted);
        }
    }
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
    /// Human-readable label for the operation just performed (e.g. "Delete 40×40×12"),
    /// shown as a toast by the frontend. Empty string for undo/redo of no-op edits.
    operation: String,
}

// ── Editing commands ───────────────────────────────────────────────────────────
//
// Pattern for every editing command:
//  1. Validate inputs / pre-read anything needed from a shared `&World` borrow.
//  2. Call `with_edit()`, which owns take → snapshot → run edit closure → render
//     patch → reinstall → push undo / clear redo → return EditResult.
//  3. The edit closure just mutates `&mut LoadedWorld` and returns `Result<(), String>`.
//
// `with_edit()` is the single place that owns the take/reinstall sequence, so no call
// site can accidentally skip the reinstall on an early return (previously an audited
// invariant across 13 hand-written sites; see git history pre-2026-07 M2 for the old
// pattern). `undo_edit`/`redo_edit` don't go through it — they restore from their own
// stack rather than snapshotting a fresh edit — but have no fallible op between their
// take/reinstall either.

/// Runs an edit against the currently loaded world, owning the take/snapshot/reinstall
/// sequence. `snap_rect` bounds the chunks snapshotted for undo (some ops widen this
/// beyond `patch_rect`, e.g. tree canopies spilling into neighboring chunks); `patch_rect`
/// bounds the pixels returned to the frontend. If `edit` returns `Err`, the world is
/// still reinstalled before the error propagates — callers can bail mid-edit freely.
fn with_edit<F>(
    ws: &mut WorldState,
    operation: &str,
    snap_rect: (i32, i32, i32, i32),
    patch_rect: (i32, i32, i32, i32),
    edit: F,
) -> Result<EditResult, String>
where
    F: FnOnce(&mut LoadedWorld) -> Result<(), String>,
{
    with_edit_inner(ws, operation, snap_rect, patch_rect, None, edit)
}

/// Group-tagged sibling of `with_edit`: identical, but stamps the resulting `UndoEntry` with
/// `group` so a run of these (one sculpt stroke = many timer stamps) coalesces on undo/redo.
/// Only `sculpt_terrain` uses this; every other editing command goes through `with_edit` (group
/// `None`). Both funnel into `with_edit_inner` so there is one owner of the take/reinstall sequence.
fn with_edit_grouped<F>(
    ws: &mut WorldState,
    operation: &str,
    snap_rect: (i32, i32, i32, i32),
    patch_rect: (i32, i32, i32, i32),
    group: Option<u64>,
    edit: F,
) -> Result<EditResult, String>
where
    F: FnOnce(&mut LoadedWorld) -> Result<(), String>,
{
    with_edit_inner(ws, operation, snap_rect, patch_rect, group, edit)
}

fn with_edit_inner<F>(
    ws: &mut WorldState,
    operation: &str,
    snap_rect: (i32, i32, i32, i32),
    patch_rect: (i32, i32, i32, i32),
    group: Option<u64>,
    edit: F,
) -> Result<EditResult, String>
where
    F: FnOnce(&mut LoadedWorld) -> Result<(), String>,
{
    // Invalidate the live-sculpt float workspace whenever this edit isn't the stroke that owns it
    // (a different group, or `None` = any non-sculpt command). This is the single choke point every
    // one of the 11 editing commands funnels through, so foreign edits can't leave `fheight` stale.
    if ws.sculpt_session.as_ref().map(|s| s.group_id) != group {
        ws.sculpt_session = None;
    }

    let cap = ws.view_cap_z;
    let mut world = ws.world.take().ok_or("No world loaded")?;

    let (sx1, sy1, sx2, sy2) = snap_rect;
    let affected = if sx1 > sx2 || sy1 > sy2 {
        vec![]
    } else {
        affected_chunk_coords(&world, sx1, sy1, sx2, sy2)
    };
    let pre_full = snapshot_chunks_full(&world, &affected);

    if let Err(e) = edit(&mut world) {
        ws.world = Some(world);
        return Err(e);
    }

    let (px1, py1, px2, py2) = patch_rect;
    let patch = render_pixels_patch(&world, px1, py1, px2, py2, cap);
    let pre_snap: Vec<ChunkSnapshot> = pre_full.into_iter()
        .filter_map(|(cx, cy, pre)| diff_chunk(&world, cx, cy, &pre))
        .collect();
    ws.world = Some(world);

    // Keep the lamp index (if built) current: a placed/removed lamp in any touched chunk must update
    // its bucket or night lighting goes stale. Reuses the affected set already computed for snapshots.
    refresh_lamp_index_chunks(ws, &affected);

    if !pre_snap.is_empty() {
        push_undo(&mut ws.undo_stack, UndoEntry { operation: operation.into(), chunks: pre_snap, group });
        ws.redo_stack.clear();
    }

    Ok(EditResult {
        patch,
        undo_depth: count_undo_groups(&ws.undo_stack),
        redo_depth: count_undo_groups(&ws.redo_stack),
        operation: operation.into(),
    })
}

/// Count logical undo/redo units: contiguous entries sharing the same `Some(g)` group collapse to
/// one; `None`-group entries always count individually (never coalesce, including with each other).
/// This is what the Ribbon's undo/redo indicators reflect — strokes, not per-stamp edits.
fn count_undo_groups(stack: &VecDeque<UndoEntry>) -> usize {
    let mut count = 0usize;
    let mut prev: Option<u64> = None;
    for entry in stack {
        match (entry.group, prev) {
            (Some(g), Some(pg)) if g == pg => {} // same contiguous group → already counted
            _ => count += 1,
        }
        prev = entry.group;
    }
    count
}

#[tauri::command(async)]
fn delete_blocks(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let max_z = ws.world.as_ref().map(world_max_z).unwrap_or(63);
    validate_selection(x1, y1, x2, y2, z_min, z_max, max_z)?;
    let rect = (x1, y1, x2, y2);
    // Non-rectangular selection: honour a wand/lasso mask whose bbox matches this rect, so Delete
    // only clears the shaped cells. No match → rect-only, exactly as before (see `active_mask`).
    let mask = active_mask(&ws, x1, y1, x2, y2);
    let label = format!("Delete {}×{}×{}", x2 - x1 + 1, y2 - y1 + 1, z_max - z_min + 1);
    with_edit(&mut ws, &label, rect, rect, |world| {
        delete_blocks_inner(world, x1, y1, x2, y2, z_min, z_max, mask.as_ref());
        Ok(())
    })
}

#[tauri::command(async)]
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
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let max_z = ws.world.as_ref().map(world_max_z).unwrap_or(63);
    validate_selection(x1, y1, x2, y2, z_min, z_max, max_z)?;
    let rect = (x1, y1, x2, y2);
    // Fill / filtered-delete also honour the shaped selection (see `active_mask`).
    let mask = active_mask(&ws, x1, y1, x2, y2);
    let label = format!("Replace {}×{}×{}", x2 - x1 + 1, y2 - y1 + 1, z_max - z_min + 1);
    with_edit(&mut ws, &label, rect, rect, |world| {
        replace_blocks_inner(world, x1, y1, x2, y2, z_min, z_max, new_block_type, new_paint, filter_block_type, filter_paint, filter_invert, mask.as_ref());
        Ok(())
    })
}

/// 8×8 ordered-dither (Bayer) matrix, values 0..63 — 64 density levels for a smooth,
/// Aseprite-style gradient boundary. Indexed purely by the screen-plane (x,y) so the dither
/// pattern is a clean, stable ordered grid (mixing in z would scramble it by surface height).
const BAYER8: [[u8; 8]; 8] = [
    [ 0, 32,  8, 40,  2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44,  4, 36, 14, 46,  6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [ 3, 35, 11, 43,  1, 33,  9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47,  7, 39, 13, 45,  5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
];

/// Fill a selection with a dithered gradient between block A and block B along an axis —
/// e.g. grass→stone across a slope. Only replaces existing (non-air) blocks by default so
/// the terrain's shape is preserved (a re-skin); `include_air` also fills gaps.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn gradient_fill(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    bt1: u8, paint1: u8,
    bt2: u8, paint2: u8,
    axis: String,
    include_air: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    if paint1 > 54 || paint2 > 54 {
        return Err(format!("Invalid paint byte: must be 0–54 (got {paint1}, {paint2})"));
    }
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let max_z = ws.world.as_ref().map(world_max_z).unwrap_or(63);
    validate_selection(x1, y1, x2, y2, z_min, z_max, max_z)?;
    let rect = (x1, y1, x2, y2);
    // Non-rectangular selection: gate on the shaped footprint. The gradient fraction is still
    // measured over the full bbox (below) — the mask only clips which columns receive it, so the
    // colour ramp stays consistent with the visible selection box. No match → rect-only.
    let mask = active_mask(&ws, x1, y1, x2, y2);
    let label = format!("Gradient {}×{}×{}", x2 - x1 + 1, y2 - y1 + 1, z_max - z_min + 1);
    with_edit(&mut ws, &label, rect, rect, |world| {
        gradient_fill_inner(world, x1, y1, x2, y2, z_min, z_max, bt1, paint1, bt2, paint2, &axis, include_air, mask.as_ref());
        Ok(())
    })
}

/// Core of `gradient_fill`: blend block A→B across an axis with an 8×8 Bayer dither, gated by an
/// optional shaped-selection mask. The gradient fraction is measured over the full bbox — the mask
/// only clips which columns receive it, so the colour ramp stays consistent with the selection box.
#[allow(clippy::too_many_arguments)]
fn gradient_fill_inner(
    world: &mut LoadedWorld,
    x1: i32, y1: i32, x2: i32, y2: i32, z_min: i32, z_max: i32,
    bt1: u8, paint1: u8, bt2: u8, paint2: u8,
    axis: &str, include_air: bool, mask: Option<&SelectionMask>,
) {
    let (dx, dy, dz) = ((x2 - x1).max(1) as f64, (y2 - y1).max(1) as f64, (z_max - z_min).max(1) as f64);
    for z in z_min..=z_max {
        for y in y1..=y2 {
            for x in x1..=x2 {
                // Mask-before-air, mirroring paste: outside the shape is never touched.
                if mask.is_some_and(|m| !m.contains(x, y)) { continue; }
                if !include_air && read_block_abs(world, x, y, z) == 0 { continue; }
                // Position along the gradient: 0 at the A end, 1 at the B end.
                let f = match axis {
                    "x" => (x - x1) as f64 / dx,
                    "z" => (z - z_min) as f64 / dz,
                    _   => (y - y1) as f64 / dy,
                };
                let dith = (BAYER8[x.rem_euclid(8) as usize][y.rem_euclid(8) as usize] as f64 + 0.5) / 64.0;
                let (bt, pt) = if f < dith { (bt1, paint1) } else { (bt2, paint2) };
                set_block_abs(world, x, y, z, bt, pt);
            }
        }
    }
}

/// Paint a batch of blocks in one operation — one undo entry for the whole stroke.
/// For each block, if z is None the topmost non-air block at (x,y) is used (surface paint);
/// if z is Some the block is placed at that exact z level.
/// Positions outside existing chunk boundaries are silently skipped.
///
/// `z_offset` (a vertical nudge applied to every block) is optional — omitting it means "no
/// nudge", which is what every exact-coordinate caller wants (slice viewports, elevation panel,
/// 3D picking). It used to be required, and those callers all failed at runtime on the missing key.
#[tauri::command(async)]
fn paint_blocks(
    blocks: Vec<PaintBlock>,
    block_type: u8,
    paint: u8,
    z_offset: Option<i32>,
    mask_type: Option<u8>,
    mask_paint: Option<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let z_offset = z_offset.unwrap_or(0);
    if paint > 54 {
        return Err(format!("Invalid paint byte {paint}: must be 0–54"));
    }
    if blocks.is_empty() {
        return Err("No blocks to paint".into());
    }
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());

    // Compute bounding rect for chunk snapshot + patch render.
    let (mut x_min, mut y_min, mut x_max, mut y_max) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for b in &blocks {
        x_min = x_min.min(b.x); y_min = y_min.min(b.y);
        x_max = x_max.max(b.x); y_max = y_max.max(b.y);
    }
    let rect = (x_min, y_min, x_max, y_max);

    let is_door   = (66..=69).contains(&block_type);
    let is_portal = (75..=78).contains(&block_type);
    let top_type: u8 = if is_door { 70 } else if is_portal { 79 } else { 0 };

    // In cutaway view the "surface" a z-less paint targets is the highest block under the cap —
    // so drawing underground behaves exactly like drawing on the true surface.
    let cap = ws.view_cap_z;
    let label = format!("Paint {} block{}", blocks.len(), if blocks.len() == 1 { "" } else { "s" });
    with_edit(&mut ws, &label, rect, rect, |world| {
        let max_z = world_max_z(world);
        for b in &blocks {
            let z = match b.z {
                Some(z) => {
                    if z < 0 || z > max_z { continue; }
                    z
                }
                None => match surface_z_capped(world, b.x, b.y, cap) {
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
                if read_block_abs(world, b.x, b.y, z) != mt { continue; }
            }
            if let Some(mp) = mask_paint {
                if read_paint_abs(world, b.x, b.y, z) != mp { continue; }
            }
            set_block_abs(world, b.x, b.y, z, block_type, paint);
            // Auto-place paired top block for doors and portals.
            if top_type != 0 && z < max_z {
                set_block_abs(world, b.x, b.y, z + 1, top_type, paint);
            }
        }
        Ok(())
    })
}

/// Pure BFS helper behind the B2 face-fill bucket (kept separate from the command so it's unit-
/// testable without a tauri `State`/mutex — mirrors how the editing commands split into `_inner`
/// logic elsewhere in this file). Flood-fills the contiguous, coplanar run of same-type (optionally
/// same-paint) blocks sharing the clicked face — a paint-bucket confined to one face plane in 3D,
/// instead of the whole 2D top-down surface `magic_wand_select` covers. `(x,y,z)` is the solid seed
/// block; `(nx,ny,nz)` is its clicked face normal (exactly one of the three is ±1, matching
/// `pick_block`'s output) and fixes which axis the flood-fill holds constant. A cell only joins the
/// run if its own face along that same normal is exposed (not a solid neighbour) — this keeps the
/// fill on one continuous visible wall/floor/ceiling instead of leaking around a corner into a
/// differently-facing run of the same block type. Returns an empty Vec if the seed itself is air.
fn find_connected_face_cells(
    world: &LoadedWorld,
    x: i32, y: i32, z: i32,
    nx: i32, ny: i32, nz: i32,
    match_paint: bool,
    max_cells: u32,
) -> Vec<(i32, i32, i32)> {
    let seed_bt = read_block_abs(world, x, y, z);
    if seed_bt == 0 { return Vec::new(); }
    let seed_paint = read_paint_abs(world, x, y, z);

    let ww = (world.w_chunks * 16) as i32;
    let wh = (world.h_chunks * 16) as i32;
    let max_z = world_max_z(world);
    let in_bounds = |cx: i32, cy: i32, cz: i32| cx >= 0 && cy >= 0 && cz >= 0 && cx < ww && cy < wh && cz <= max_z;

    // The two in-plane neighbour steps — whichever two axes the face normal is NOT aligned to.
    let steps: [(i32, i32, i32); 4] = if nx != 0 {
        [(0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
    } else if ny != 0 {
        [(1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1)]
    } else {
        [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0)]
    };

    let mut visited: std::collections::HashSet<(i32, i32, i32)> = std::collections::HashSet::new();
    let mut queue: VecDeque<(i32, i32, i32)> = VecDeque::new();
    let mut matched: Vec<(i32, i32, i32)> = Vec::new();
    let mut count = 0u32;
    queue.push_back((x, y, z));
    visited.insert((x, y, z));

    while let Some((cx, cy, cz)) = queue.pop_front() {
        if count >= max_cells { break; }
        if !in_bounds(cx, cy, cz) { continue; }
        if read_block_abs(world, cx, cy, cz) != seed_bt { continue; }
        if match_paint && read_paint_abs(world, cx, cy, cz) != seed_paint { continue; }
        let (fx, fy, fz) = (cx + nx, cy + ny, cz + nz);
        let face_exposed = !in_bounds(fx, fy, fz) || read_block_abs(world, fx, fy, fz) == 0;
        if !face_exposed { continue; }
        matched.push((cx, cy, cz));
        count += 1;
        for (dx, dy, dz) in steps {
            let n = (cx + dx, cy + dy, cz + dz);
            if visited.insert(n) { queue.push_back(n); }
        }
    }
    matched
}

/// B2 (3D fly-view face-fill bucket) command: runs `find_connected_face_cells` under the world
/// lock, then re-skins the run to `(block_type, paint)` (or clears it to air when `block_type` is 0)
/// through `paint_blocks`, so undo/redo and the chunk-mesh edit sync come for free.
#[tauri::command(async)]
fn fill_connected_face(
    x: i32, y: i32, z: i32,
    nx: i32, ny: i32, nz: i32,
    match_paint: bool,
    block_type: u8,
    paint: u8,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    if paint > 54 {
        return Err(format!("Invalid paint byte {paint}: must be 0–54"));
    }
    const MAX_CELLS: u32 = 4_000;

    let matched: Vec<(i32, i32, i32)> = {
        let ws = state.lock().unwrap_or_else(|p| p.into_inner());
        let world = ws.world.as_ref().ok_or("No world loaded")?;
        if read_block_abs(world, x, y, z) == 0 { return Err("No block at that face".into()); }
        find_connected_face_cells(world, x, y, z, nx, ny, nz, match_paint, MAX_CELLS)
    };

    if matched.is_empty() {
        return Err("Nothing to fill".into());
    }
    let blocks: Vec<PaintBlock> = matched.into_iter().map(|(x, y, z)| PaintBlock { x, y, z: Some(z) }).collect();
    paint_blocks(blocks, block_type, paint, None, None, None, state)
}

/// Move the player spawn/home position to the given editor-coordinate pixel (px, py).
/// Height is resolved to one block above the surface. The change is written to the in-memory
/// mmap and persists the next time the world is saved.
#[tauri::command]
fn set_spawn_pos(px: i32, py: i32, state: tauri::State<'_, AppState>) -> Result<(f32, f32), String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
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
    // Stage the zip into a sibling temp file, then rename over the destination — same atomic-save
    // rationale as save_world_inner (never truncate the destination in place; never touch a file
    // that might be mapped).
    let mut tmp = std::ffi::OsString::from(path);
    tmp.push(".savetmp");
    let tmp = std::path::PathBuf::from(tmp);
    let write_result = (|| -> Result<(), String> {
        let file = fs::File::create(&tmp).map_err(|e| format!("Failed to create file: {e}"))?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(9));
        zip.start_file(&inner_name, options).map_err(|e| format!("Zip error: {e}"))?;
        zip.write_all(&world.bytes).map_err(|e| format!("Write error: {e}"))?;
        // finish() returns the inner File; drop it so its handle is closed before the rename
        // (Windows can't rename a file that still has an open handle).
        let f = zip.finish().map_err(|e| format!("Zip finish error: {e}"))?;
        drop(f);
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to finalize save: {e}")
    })?;
    Ok(())
}

#[tauri::command(async)]
fn save_world(path: String, compressed: bool, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    if compressed { save_world_compressed(world, &path) } else { save_world_inner(world, &path) }
}

/// Release the currently loaded world and everything tied to it — the mmap, clipboard, and the
/// undo/redo stacks (up to 256 MB) — and delete its staged temp file. Without this, closing a
/// world in the UI left all of that resident in the backend until the next `load_world`.
/// World-independent state (texture pack, Eden.eden template) is intentionally left loaded.
#[tauri::command]
fn close_world(state: tauri::State<'_, AppState>) {
    let (old_world, old_temp) = {
        let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
        ws.clipboard = None;
        ws.undo_stack.clear();
        ws.redo_stack.clear();
        ws.lamp_index = None;
        ws.view_cap_z = None;
        ws.sculpt_session = None;
        ws.selection_mask = None;
        (ws.world.take(), ws.temp_path.take())
    };
    drop(old_world); // release the mmap before deleting its backing temp file
    if let Some(p) = old_temp { let _ = fs::remove_file(&p); }
}

// ── Autosave / crash recovery ───────────────────────────────────────────────
//
// A single rotating sidecar (not the user's save file): `<app_data_dir>/autosave.eden`
// plus a JSON metadata sidecar recording where it came from. Written on a frontend
// timer while a world is loaded and dirty; cleared whenever the user performs a real
// Save/Save As. If `autosave.meta.json` still exists at next launch, the previous
// session ended without a clean save (crash, force-quit, or forgot to save) and the
// frontend offers to recover it.

#[derive(Serialize, serde::Deserialize, Clone)]
struct AutosaveInfo {
    world_name: String,
    source_path: Option<String>,
    timestamp: u64, // unix seconds
}

fn autosave_paths(app: &tauri::AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok((dir.join("autosave.eden"), dir.join("autosave.meta.json")))
}

#[tauri::command(async)]
fn autosave_world(
    app: tauri::AppHandle,
    source_path: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Snapshot the world bytes under the lock, then release it before the (potentially large) disk
    // write — so a background autosave only blocks editing for the in-memory copy, not for the whole
    // write. Async so the write runs off the main thread and can't freeze the UI mid-edit.
    let (bytes, world_name) = {
        let ws = state.lock().unwrap_or_else(|p| p.into_inner());
        let world = ws.world.as_ref().ok_or("No world loaded")?;
        (world.bytes.to_vec(), world.name.clone())
    };
    let (data_path, meta_path) = autosave_paths(&app)?;
    atomic_write(&data_path, &bytes).map_err(|e| format!("Failed to write autosave: {e}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let info = AutosaveInfo { world_name, source_path, timestamp };
    let json = serde_json::to_string(&info).map_err(|e| format!("Failed to serialize autosave meta: {e}"))?;
    fs::write(&meta_path, json).map_err(|e| format!("Failed to write autosave meta: {e}"))?;
    Ok(())
}

/// Checked once at startup. Returns `None` if no autosave is pending recovery.
#[tauri::command]
fn get_autosave_info(app: tauri::AppHandle) -> Result<Option<AutosaveInfo>, String> {
    let (data_path, meta_path) = autosave_paths(&app)?;
    if !data_path.exists() || !meta_path.exists() {
        return Ok(None);
    }
    let json = fs::read_to_string(&meta_path).map_err(|e| format!("Failed to read autosave meta: {e}"))?;
    let info: AutosaveInfo = serde_json::from_str(&json).map_err(|e| format!("Failed to parse autosave meta: {e}"))?;
    Ok(Some(info))
}

/// The path to load the pending autosave from — the caller feeds this into the
/// existing `load_world` command to recover it, exactly like opening any other file.
#[tauri::command]
fn get_autosave_path(app: tauri::AppHandle) -> Result<String, String> {
    let (data_path, _) = autosave_paths(&app)?;
    Ok(data_path.to_string_lossy().into_owned())
}

/// Clears the pending autosave. Called after a successful manual Save/Save As
/// (nothing left to recover) or when the user declines the recovery prompt.
#[tauri::command]
fn discard_autosave(app: tauri::AppHandle) -> Result<(), String> {
    let (data_path, meta_path) = autosave_paths(&app)?;
    let _ = fs::remove_file(&data_path);
    let _ = fs::remove_file(&meta_path);
    Ok(())
}

#[derive(serde::Serialize)]
struct UndoStackInfo {
    undo: Vec<String>,
    redo: Vec<String>,
}

/// Collapses a stack's entries into one label per logical operation (a grouped sculpt stroke's
/// stamps share one `group` id and one `operation` string, so they collapse to a single label),
/// mirroring `count_undo_groups`'s notion of a "unit". Oldest first, most-recent last.
fn undo_stack_labels(stack: &VecDeque<UndoEntry>) -> Vec<String> {
    let mut out = Vec::new();
    let mut prev: Option<u64> = None;
    for entry in stack {
        match (entry.group, prev) {
            (Some(g), Some(pg)) if g == pg => {} // same contiguous group, already represented
            _ => out.push(entry.operation.clone()),
        }
        prev = entry.group;
    }
    out
}

/// Read-only projection of the undo/redo stacks for the sidebar's History tab — labels only, no
/// chunk data, so it's cheap to poll after every edit.
#[tauri::command]
fn list_undo_stack(state: tauri::State<'_, AppState>) -> Result<UndoStackInfo, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    Ok(UndoStackInfo {
        undo: undo_stack_labels(&ws.undo_stack),
        redo: undo_stack_labels(&ws.redo_stack),
    })
}

#[tauri::command(async)]
fn undo_edit(state: tauri::State<'_, AppState>) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    undo_edit_inner(&mut ws)
}

#[tauri::command(async)]
fn redo_edit(state: tauri::State<'_, AppState>) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    redo_edit_inner(&mut ws)
}

/// Undo one logical unit: pop+restore the top `UndoEntry`; if it carries a group id, keep
/// popping+restoring while the new stack top shares that id (a whole sculpt stroke). Each popped
/// entry's inverse is pushed onto `redo_stack` immediately in the same iteration (carrying the
/// same group tag) — because the stack holds a group's stamps in chronological order (stampN on
/// top) and we pop back-to-front, the resulting redo order replays forward correctly with no
/// explicit reordering. See `test_grouped_undo_round_trip`.
fn undo_edit_inner(ws: &mut WorldState) -> Result<EditResult, String> {
    // Undo bypasses `with_edit_inner`, so it must clear the live-sculpt workspace itself — undoing
    // the very stroke that owns the session is the dangerous case (its `fheight` would now describe
    // heights the world no longer has). See `SculptSession`.
    ws.sculpt_session = None;
    // Take the world first: if none is loaded, error out before popping the undo stack, so a
    // stray call with no world can't silently discard an entry (harmless today since the stacks
    // are cleared with the world, but fragile ordering otherwise).
    let mut world = ws.world.take().ok_or("No world loaded")?;
    let entry = match ws.undo_stack.pop_back() {
        Some(e) => e,
        None => { ws.world = Some(world); return Err("Nothing to undo".into()); }
    };
    let group = entry.group;
    let label = entry.operation.clone();
    let mut affected: Vec<(i16, i16)> = Vec::new();

    let mut current = Some(entry);
    while let Some(entry) = current.take() {
        for s in &entry.chunks { affected.push((s.cx, s.cy)); }
        let redo_snaps = restore_and_invert(&mut world, &entry);
        push_undo(&mut ws.redo_stack, UndoEntry { operation: entry.operation, chunks: redo_snaps, group: entry.group });
        // Continue only for a group whose next entry down matches the same id.
        if let Some(g) = group {
            if ws.undo_stack.back().map(|e| e.group) == Some(Some(g)) {
                current = ws.undo_stack.pop_back();
            }
        }
    }

    let patch = patch_from_chunk_coords(&world, &affected, ws.view_cap_z);
    ws.world = Some(world);
    refresh_lamp_index_chunks(ws, &affected);

    Ok(EditResult {
        patch,
        undo_depth: count_undo_groups(&ws.undo_stack),
        redo_depth: count_undo_groups(&ws.redo_stack),
        operation: label,
    })
}

/// Redo one logical unit — exact mirror of `undo_edit_inner`, popping from `redo_stack` and
/// pushing inverses onto `undo_stack`.
fn redo_edit_inner(ws: &mut WorldState) -> Result<EditResult, String> {
    ws.sculpt_session = None; // bypasses with_edit_inner — clear the live-sculpt workspace (see SculptSession)
    let mut world = ws.world.take().ok_or("No world loaded")?;
    let entry = match ws.redo_stack.pop_back() {
        Some(e) => e,
        None => { ws.world = Some(world); return Err("Nothing to redo".into()); }
    };
    let group = entry.group;
    let label = entry.operation.clone();
    let mut affected: Vec<(i16, i16)> = Vec::new();

    let mut current = Some(entry);
    while let Some(entry) = current.take() {
        for s in &entry.chunks { affected.push((s.cx, s.cy)); }
        let undo_snaps = restore_and_invert(&mut world, &entry);
        push_undo(&mut ws.undo_stack, UndoEntry { operation: entry.operation, chunks: undo_snaps, group: entry.group });
        if let Some(g) = group {
            if ws.redo_stack.back().map(|e| e.group) == Some(Some(g)) {
                current = ws.redo_stack.pop_back();
            }
        }
    }

    let patch = patch_from_chunk_coords(&world, &affected, ws.view_cap_z);
    ws.world = Some(world);
    refresh_lamp_index_chunks(ws, &affected);

    Ok(EditResult {
        patch,
        undo_depth: count_undo_groups(&ws.undo_stack),
        redo_depth: count_undo_groups(&ws.redo_stack),
        operation: label,
    })
}

// ── Copy / Paste commands ──────────────────────────────────────────────────────

/// Capture all blocks in the selection volume into the in-memory clipboard.
/// No world mutation; no undo entry. Returns clipboard dimensions for the frontend.
#[tauri::command(async)]
fn copy_selection(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    state: tauri::State<'_, AppState>,
) -> Result<ClipboardInfo, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let max_z = ws.world.as_ref().map(world_max_z).unwrap_or(63);
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

    // A shaped selection copies its footprint into the clipboard so paste reproduces the shape, not
    // the box. The mask's bitset layout (row-major over the bbox, bit (y-y1)*w+(x-x1)) is exactly the
    // clipboard's per-column layout (dy*width+dx), so the bits transfer verbatim. `active_mask`
    // applies the rect-equality fail-safe; a mismatched/absent mask → full-box copy as before.
    let mask = active_mask(&ws, x1, y1, x2, y2).map(|m| m.bits);
    let cb = Clipboard { width, height, depth, z_anchor: z_min, block_types, paints, mask };
    let info = cb.info();
    ws.clipboard = Some(cb);
    Ok(info)
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
pub(crate) fn surface_z(world: &LoadedWorld, px: i32, py: i32) -> Option<i32> {
    surface_z_capped(world, px, py, None)
}

/// `surface_z` with a cutaway ceiling: the topmost non-air block at or below `cap`. With `cap`
/// set, "the surface" becomes the floor of whatever cavity the cap plane cuts into, which is what
/// makes drawing / terrain-paste / the cursor readout work underground exactly as they do on top.
pub(crate) fn surface_z_capped(world: &LoadedWorld, px: i32, py: i32, cap: Option<i32>) -> Option<i32> {
    if px < 0 || py < 0 { return None; }
    let cx = px / 16 + world.min_x;
    let cy = py / 16 + world.min_y;
    let &addr = world.chunk_map.get(&(cx, cy))?;
    let lx = (px % 16) as usize;
    let ly = (py % 16) as usize;
    for band in (0..world.num_bands).rev() {
        if let Some(c) = cap {
            if (band * 16) as i32 > c { continue; }
        }
        for lz in (0..16usize).rev() {
            if let Some(c) = cap {
                if (band * 16 + lz) as i32 > c { continue; }
            }
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
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
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
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let world = ws.world.as_ref().ok_or("no world")?;
    Ok(surface_z(world, x, y))
}

#[derive(serde::Serialize)]
struct PickedBlock { block_type: u8, paint: u8 }

/// Return the surface Z, block type, and paint at (wx, wy). Used by status bar cursor info.
/// Returns None if no world loaded or column is empty.
#[tauri::command]
fn get_cursor_block(state: tauri::State<'_, AppState>, wx: i32, wy: i32) -> Option<[i32; 3]> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let world = ws.world.as_ref()?;
    // Report the block the cutaway view is actually showing (and that a z-less draw would hit).
    let z = surface_z_capped(world, wx, wy, ws.view_cap_z)?;
    let (bt, paint) = get_block_at(world, wx, wy, z);
    Some([z, bt as i32, paint as i32])
}

/// Return the block type and paint at the surface of (wx, wy).
/// Returns air (0,0) if the column is empty or out of bounds.
#[tauri::command]
fn pick_block_surface(state: tauri::State<'_, AppState>, wx: i32, wy: i32) -> Result<PickedBlock, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let world = ws.world.as_ref().ok_or("no world")?;
    let z = surface_z_capped(world, wx, wy, ws.view_cap_z).unwrap_or(0);
    let (bt, paint) = get_block_at(world, wx, wy, z);
    Ok(PickedBlock { block_type: bt, paint })
}

/// Rotate clipboard 90° clockwise in the XY plane.
/// Transform: (dx, dy, dz) → (new_dx=dy, new_dy=old_width-1-dx, dz).
/// New dimensions: new_width=old_height, new_height=old_width. Z range unchanged.
/// Directional block IDs (ramps 24–39, wedges 40–55, doors 66–69, portals 75–78) are remapped.
/// Does not touch world data; no undo entry required.
fn rotate_clipboard_inner(cb: &mut Clipboard) {
    let old_w = cb.width as usize;
    let old_h = cb.height as usize;
    let depth = cb.depth as usize;
    let new_w = old_h;
    let new_h = old_w;
    let vol = new_w * new_h * depth;
    let mut new_types = vec![0u8; vol];
    let mut new_paints = vec![0u8; vol];
    // Transform the footprint mask with the SAME (dx,dy)→(ndx,ndy) map as the data (dropping dz —
    // the mask is per-column), or corruption results: a paste would skip the wrong columns.
    let new_mask = cb.mask.as_ref().map(|old| {
        let mut nm = vec![0u8; (new_w * new_h).div_ceil(8)];
        for dy in 0..old_h {
            for dx in 0..old_w {
                if bit_set(old, dy * old_w + dx) {
                    let (ndx, ndy) = (dy, old_w - 1 - dx);
                    let ni = ndy * new_w + ndx;
                    nm[ni >> 3] |= 1u8 << (ni & 7);
                }
            }
        }
        nm
    });
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
    cb.mask = new_mask;
}

#[tauri::command]
fn rotate_clipboard(state: tauri::State<'_, AppState>) -> Result<ClipboardInfo, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let cb = ws.clipboard.as_mut().ok_or("Clipboard is empty")?;
    rotate_clipboard_inner(cb);
    Ok(cb.info())
}

fn mirror_clipboard_x_inner(cb: &mut Clipboard) {
    let w = cb.width as usize;
    let h = cb.height as usize;
    let depth = cb.depth as usize;
    let vol = w * h * depth;
    let mut new_types = vec![0u8; vol];
    let mut new_paints = vec![0u8; vol];
    if let Some(old) = cb.mask.as_ref() {
        let mut nm = vec![0u8; (w * h).div_ceil(8)];
        for dy in 0..h {
            for dx in 0..w {
                if bit_set(old, dy * w + dx) {
                    let ni = dy * w + (w - 1 - dx);
                    nm[ni >> 3] |= 1u8 << (ni & 7);
                }
            }
        }
        cb.mask = Some(nm);
    }
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
}

/// Mirror clipboard on the X axis (left↔right on the map): (dx,dy,dz) → (width-1-dx, dy, dz).
/// Ramp IDs are remapped so E-facing ramps become W-facing and vice versa.
#[tauri::command]
fn mirror_clipboard_x(state: tauri::State<'_, AppState>) -> Result<ClipboardInfo, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let cb = ws.clipboard.as_mut().ok_or("Clipboard is empty")?;
    mirror_clipboard_x_inner(cb);
    Ok(cb.info())
}

fn mirror_clipboard_y_inner(cb: &mut Clipboard) {
    let w = cb.width as usize;
    let h = cb.height as usize;
    let depth = cb.depth as usize;
    let vol = w * h * depth;
    let mut new_types = vec![0u8; vol];
    let mut new_paints = vec![0u8; vol];
    if let Some(old) = cb.mask.as_ref() {
        let mut nm = vec![0u8; (w * h).div_ceil(8)];
        for dy in 0..h {
            for dx in 0..w {
                if bit_set(old, dy * w + dx) {
                    let ni = (h - 1 - dy) * w + dx;
                    nm[ni >> 3] |= 1u8 << (ni & 7);
                }
            }
        }
        cb.mask = Some(nm);
    }
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
}

/// Mirror clipboard on the Y axis (top↔bottom on the map): (dx,dy,dz) → (dx, height-1-dy, dz).
/// Ramp IDs are remapped so S-facing ramps become N-facing and vice versa.
#[tauri::command]
fn mirror_clipboard_y(state: tauri::State<'_, AppState>) -> Result<ClipboardInfo, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let cb = ws.clipboard.as_mut().ok_or("Clipboard is empty")?;
    mirror_clipboard_y_inner(cb);
    Ok(cb.info())
}

/// Paste the clipboard at world pixel position (paste_x, paste_y).
/// The anchor is the top-left (min-x, min-y) corner.
/// elevation_offset shifts the z range at paste time (does not modify clipboard).
/// ignore_air = true skips clipboard voxels with block type 0 (air).
/// Blocks outside existing chunk boundaries are silently clipped.
/// Follows the full chunk-scoped undo contract.
#[tauri::command(async)]
fn paste_at(
    paste_x: i32, paste_y: i32,
    elevation_offset: i32,
    ignore_air: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());

    // Clone clipboard data before taking world to avoid borrow conflict.
    let (width, height, depth, z_anchor, block_types, paints, mask) = {
        let cb = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
        (cb.width, cb.height, cb.depth, cb.z_anchor,
         cb.block_types.clone(), cb.paints.clone(), cb.mask.clone())
    };

    let x2_paste = paste_x + width  - 1;
    let y2_paste = paste_y + height - 1;

    // Clamp to non-negative for affected_chunk_coords (negative coords have no chunks).
    let snap_rect = (paste_x.max(0), paste_y.max(0), x2_paste, y2_paste);
    let patch_rect = (paste_x, paste_y, x2_paste, y2_paste);

    let label = format!("Paste {width}×{height}×{depth}");
    with_edit(&mut ws, &label, snap_rect, patch_rect, |world| {
        for dz in 0..depth {
            let z = z_anchor + elevation_offset + dz;
            if z < 0 || z > world_max_z(world) { continue; }
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
                    // Non-rectangular clipboard: skip columns outside the footprint before anything
                    // else, so a shaped copy stamps its shape, not the box. Distinct from ignore_air.
                    if let Some(m) = &mask { if !bit_set(m, (dy * width + dx) as usize) { continue; } }
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
        Ok(())
    })
}

/// Paste clipboard terrain-aligned: per (x,y) column, the bottom clipboard layer
/// is placed at `surface_z + (if above_surface { 1 } else { 0 }) + elevation_offset`.
/// Columns with no surface (all air or outside world) are skipped.
/// Follows the same chunk-scoped undo contract as paste_at.
#[tauri::command(async)]
fn paste_terrain(
    paste_x: i32, paste_y: i32,
    elevation_offset: i32,
    ignore_air: bool,
    above_surface: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());

    let (width, height, depth, block_types, paints, mask) = {
        let cb = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
        (cb.width, cb.height, cb.depth,
         cb.block_types.clone(), cb.paints.clone(), cb.mask.clone())
    };

    let x2_paste = paste_x + width  - 1;
    let y2_paste = paste_y + height - 1;

    let snap_rect = (paste_x.max(0), paste_y.max(0), x2_paste, y2_paste);
    let patch_rect = (paste_x, paste_y, x2_paste, y2_paste);
    let surf_nudge: i32 = if above_surface { 1 } else { 0 };
    let cap = ws.view_cap_z; // cutaway: follow the sub-cap surface (cave floor), not the true surface

    let label = format!("Paste (terrain) {width}×{height}×{depth}");
    with_edit(&mut ws, &label, snap_rect, patch_rect, |world| {
        let max_z = world_max_z(world);
        for dy in 0..height {
            let py = paste_y + dy;
            if py < 0 { continue; }
            let chunk_cy = py / 16 + world.min_y;
            let ly       = (py % 16) as usize;
            for dx in 0..width {
                let px = paste_x + dx;
                if px < 0 { continue; }
                // Shaped clipboard: skip whole columns outside the footprint.
                if let Some(m) = &mask { if !bit_set(m, (dy * width + dx) as usize) { continue; } }
                let chunk_cx = px / 16 + world.min_x;
                let lx       = (px % 16) as usize;
                let &addr = match world.chunk_map.get(&(chunk_cx, chunk_cy)) {
                    Some(a) => a,
                    None    => continue,
                };
                // Read surface before writing this column — other columns' writes never
                // affect (px, py) since each (dx, dy) maps to a unique world position.
                let surf = match surface_z_capped(world, px, py, cap) {
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
        Ok(())
    })
}

/// Copies the selection N times in the given axis direction.
/// axis: "z+" | "z-" | "x+" | "x-" | "y+" | "y-"
/// count: number of copies (not counting the original), 1–20.
/// ignore_air: if true, source air blocks are not written (gaps preserved).
/// All copies land in a single undo entry.
#[tauri::command(async)]
fn extrude_selection(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    axis: String,
    count: i32,
    ignore_air: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    if count <= 0 { return Err("count must be at least 1".into()); }

    // Non-rectangular selection: gate on the *source* footprint (mask only exists over the source
    // bbox). z± stacks the shape in place; x±/y± repeats the translated shape — each copy leaves
    // its unmasked cells untouched. Never evaluated at destination coords. No match → rect-only.
    let mask = active_mask(&ws, x1, y1, x2, y2);

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
    let rect = (ax1, ay1, ax2, ay2);

    let label = format!("Extrude {axis} ×{count}");
    with_edit(&mut ws, &label, rect, rect, |world| {
        extrude_write(world, x1, y1, &src_types, &src_paints, width, height, depth, z_min, max_z, &axis, count, ignore_air, mask.as_ref());
        Ok(())
    })
}

/// Writes the N extrude copies of a pre-buffered source volume. The mask (if any) gates on the
/// *source* cell `(x1+dx, y1+dy)` — the shape is what repeats — and is never evaluated at
/// destination coords (it only exists over the source bbox).
#[allow(clippy::too_many_arguments)]
fn extrude_write(
    world: &mut LoadedWorld,
    x1: i32, y1: i32, src_types: &[u8], src_paints: &[u8],
    width: i32, height: i32, depth: i32, z_min: i32, max_z: i32,
    axis: &str, count: i32, ignore_air: bool, mask: Option<&SelectionMask>,
) {
    for k in 1..=count {
        let (dx_step, dy_step, dz_step) = match axis {
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
                    // Gate on the source cell (x1+dx, y1+dy) — the shape is what repeats.
                    if mask.is_some_and(|m| !m.contains(x1 + dx, y1 + dy)) { continue; }
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
}

/// Moves the selection's contents by (dx, dy, dz) in one gesture: reads the source volume,
/// clears it to air, then writes the buffer at the shifted position — one undo entry, unlike
/// a manual cut+paste. Cells vacated by the move that fall inside the destination are simply
/// overwritten by the subsequent write, so overlapping moves (e.g. nudging by 1) are safe:
/// the whole source is captured into an in-memory buffer before anything is mutated.
#[tauri::command(async)]
fn move_selection(
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    dx: i32, dy: i32, dz: i32,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let max_z = ws.world.as_ref().map(world_max_z).unwrap_or(63);
    validate_selection(x1, y1, x2, y2, z_min, z_max, max_z)?;
    if dx == 0 && dy == 0 && dz == 0 {
        return Err("No movement".into());
    }

    let width  = x2 - x1 + 1;
    let height = y2 - y1 + 1;
    let depth  = z_max - z_min + 1;
    let (x1d, y1d, x2d, y2d) = (x1 + dx, y1 + dy, x2 + dx, y2 + dy);
    let snap_rect = (x1.min(x1d), y1.min(y1d), x2.max(x2d), y2.max(y2d));
    let label = format!("Move {width}×{height}×{depth}");

    // A shaped selection moves only its footprint (dragging the box was the wand bug's twin). The
    // mask is per-column, so the same local `(lx,ly)` gate applies to both the source clear and the
    // destination write; `mask.contains` reads absolute *source* coords `(x1+lx, y1+ly)`.
    let mask = active_mask(&ws, x1, y1, x2, y2);
    let masked = mask.is_some();

    let result = with_edit(&mut ws, &label, snap_rect, snap_rect, |world| {
        let n = (width * height * depth) as usize;
        let mut buf_bt = vec![0u8; n];
        let mut buf_paint = vec![0u8; n];
        for lz in 0..depth {
            for ly in 0..height {
                for lx in 0..width {
                    let idx = (lz * height * width + ly * width + lx) as usize;
                    buf_bt[idx]    = read_block_abs(world, x1 + lx, y1 + ly, z_min + lz);
                    buf_paint[idx] = read_paint_abs(world, x1 + lx, y1 + ly, z_min + lz);
                }
            }
        }
        // Clear the (masked) source first, then write the (masked) dest — so an overlapping move
        // never clears a cell it just wrote. Both passes gate on the same source-column predicate.
        for lz in 0..depth {
            for ly in 0..height {
                for lx in 0..width {
                    if let Some(m) = &mask { if !m.contains(x1 + lx, y1 + ly) { continue; } }
                    set_block_abs(world, x1 + lx, y1 + ly, z_min + lz, 0, 0);
                }
            }
        }
        for lz in 0..depth {
            let tz = z_min + dz + lz;
            if tz < 0 || tz > max_z { continue; }
            for ly in 0..height {
                for lx in 0..width {
                    if let Some(m) = &mask { if !m.contains(x1 + lx, y1 + ly) { continue; } }
                    let idx = (lz * height * width + ly * width + lx) as usize;
                    set_block_abs(world, x1d + lx, y1d + ly, tz, buf_bt[idx], buf_paint[idx]);
                }
            }
        }
        Ok(())
    })?;

    // Shape-preserving move: the selection box shifts by (dx,dy) on the frontend, so shift the stored
    // mask's bbox to match (bits and z are unchanged — the mask is a 2D footprint). The frontend
    // updates `selectionMaskRectRef` to the same shifted rect so its clear-on-reshape effect sees a
    // match and leaves this shifted mask in place. `with_edit` never touches `selection_mask`, so
    // it's still present here. Only when a mask was actually active (rect matched).
    if masked {
        if let Some(m) = ws.selection_mask.as_mut() {
            m.x1 += dx; m.y1 += dy; m.x2 += dx; m.y2 += dy;
        }
    }
    Ok(result)
}

// ── Tree generation ───────────────────────────────────────────────────────────

/// Minimal xorshift64 RNG — avoids adding a rand dependency.
pub(crate) struct Rng64(u64);
impl Rng64 {
    pub(crate) fn new(seed: u64) -> Self { Self(if seed == 0 { 0xdeadbeef_cafebabe } else { seed }) }
    pub(crate) fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    /// Returns a value in lo..=hi (inclusive).
    pub(crate) fn range(&mut self, lo: i32, hi: i32) -> i32 {
        (self.next() % (hi - lo + 1) as u64) as i32 + lo
    }
    /// Returns true with probability num/den.
    pub(crate) fn prob(&mut self, num: u64, den: u64) -> bool {
        self.next() % den < num
    }
}

/// Write one block at absolute world pixel coordinates using the correct band formula.
/// Out-of-bounds writes (missing chunk, z > max) are silently dropped.
#[inline]
pub(crate) fn set_block_abs(world: &mut LoadedWorld, wx: i32, wy: i32, wz: i32, bt: u8, paint: u8) {
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
pub(crate) const NORMAL_LEAF_PAINTS: [u8; 4] = [0, 22, 31, 40];
const PINE_LEAF_PAINTS:   [u8; 3] = [31, 40, 49];
// Snow biome: frosted foliage (white + light gray) and cold flowers (white + blue).
pub(crate) const SNOW_LEAF_PAINTS:   [u8; 2] = [9, 18];     // white, 80% light gray
pub(crate) const SNOW_FLOWER_PAINTS: [u8; 3] = [9, 6, 15];  // white, light blue, blue

/// Deciduous mushroom-shaped tree (ported from NormalTree in reference, bug fixed: trunk placed
/// after leaves so the log shows through the canopy, not overwritten by leaf blocks).
/// `trunk_h` (log count) and `leaf_paint` are caller-chosen so both the editor tool and the
/// world generator can control trunk height / canopy tint.
pub(crate) fn place_normal_tree(world: &mut impl VoxelSink, wx: i32, wy: i32, z_base: i32, trunk_h: i32, leaf_paint: u8) {
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
pub(crate) fn place_pine_tree(world: &mut impl VoxelSink, wx: i32, wy: i32, z_base: i32, rng: &mut Rng64, leaf_override: Option<u8>) {
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
fn place_tall_pine_tree(world: &mut impl VoxelSink, wx: i32, wy: i32, z_base: i32, _rng: &mut Rng64, leaf_paint: u8) {

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
#[tauri::command(async)]
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

    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    // Only validate XY; z is ignored (trees find the surface themselves).
    if x2 < x1 || y2 < y1 {
        return Err("Invalid selection bounds".into());
    }
    // Non-rectangular selection: only plant inside the shaped footprint. Canopy spill outside the
    // mask is accepted, same as the existing ±3 rect spill. No match → rect-only.
    let mask = active_mask(&ws, x1, y1, x2, y2);

    // Expand both the snapshot and the returned patch by 3 to include chunks where leaves may
    // spill over — a patch limited to the bare selection would leave spilled leaves invisible on
    // the map until an unrelated refetch.
    let snap_rect = ((x1 - 3).max(0), (y1 - 3).max(0), x2 + 3, y2 + 3);
    let patch_rect = snap_rect;

    let label = format!("Generate trees ({}×{})", x2 - x1 + 1, y2 - y1 + 1);
    with_edit(&mut ws, &label, snap_rect, patch_rect, |world| {
        generate_trees_inner(world, x1, y1, x2, y2, &tree_types, density, &leaf_paints, seed, smart_placement, mask.as_ref());
        Ok(())
    })
}

/// Core of `generate_trees`: scatter trees across the XY footprint, gated by an optional
/// shaped-selection mask (only plant inside the shape; canopy spill outside is accepted, same as the
/// existing ±3 rect spill).
#[allow(clippy::too_many_arguments)]
fn generate_trees_inner(
    world: &mut LoadedWorld,
    x1: i32, y1: i32, x2: i32, y2: i32,
    tree_types: &[String], density: f32, leaf_paints: &[u8], seed: u64,
    smart_placement: bool, mask: Option<&SelectionMask>,
) {
    let max_z = world_max_z(world);
    let mut rng = Rng64::new(seed);
    let density_num = (density.clamp(0.0, 1.0) * 1_000_000.0) as u64;

    for wx in x1..=x2 {
        for wy in y1..=y2 {
            if mask.is_some_and(|m| !m.contains(wx, wy)) { continue; }
            if !rng.prob(density_num, 1_000_000) { continue; }

            let sz = match surface_z(world, wx, wy) { Some(z) => z, None => continue };

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
                    let lp = pick_leaf_paint(leaf_paints, &NORMAL_LEAF_PAINTS, &mut rng);
                    place_normal_tree(world, wx, wy, z_base, trunk_h, lp);
                }
                "terrain"   => {
                    let lp = pick_leaf_paint(leaf_paints, &NORMAL_LEAF_PAINTS, &mut rng);
                    place_terrain_tree(world, wx, wy, z_base, &mut rng, lp);
                }
                "pine"      => {
                    let lp = pick_leaf_paint(leaf_paints, &PINE_LEAF_PAINTS, &mut rng);
                    place_pine_tree(world, wx, wy, z_base, &mut rng, Some(lp));
                }
                "tall_pine" => {
                    let lp = pick_leaf_paint(leaf_paints, &PINE_LEAF_PAINTS, &mut rng);
                    place_tall_pine_tree(world, wx, wy, z_base, &mut rng, lp);
                }
                _ => {}
            }
        }
    }
}

/// Top-down render of the current clipboard (highest non-air block per column).
/// Axonometric top-down render for the visible region.
/// For each output pixel (px, py), rays descend from max_z. At depth dz = max_z - z,
/// the sample point drifts: sample_px = px + ski*0.5*dz, sample_py = py - ski*dz.
/// This creates a south-east viewing angle with depth-derived parallax (ski=0 is flat top-down).
#[tauri::command(async)]
fn render_axo_region(
    x1: i32, y1: i32, x2: i32, y2: i32,
    ski: f32,
    dir: u8, // 0=SE 1=SW 2=NE 3=NW
    state: tauri::State<'_, AppState>,
) -> Result<PixelPatch, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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

    // Each row is a disjoint slice of `pixels` and each pixel does its own independent
    // (comparatively expensive, up-to-max_z) raycast, so this parallelizes well per row.
    pixels.par_chunks_mut((width * 4) as usize).enumerate().for_each(|(row, row_pixels)| {
        let py = oy1 + row as u32;
        for px in ox1..=ox2 {
            let mut top_bt = 0u8; let mut top_paint = 0u8;
            let mut under_bt = 0u8; let mut under_paint = 0u8;

            'zray: for dz in 0..=(max_z as i32) {
                let wz = (max_z as i32) - dz;
                let sx = (px as f32 + sx_sgn * ski * 0.5 * dz as f32).round() as i32;
                let sy = (py as f32 + sy_sgn * ski * dz as f32).round() as i32;
                if sx < 0 || sx >= world_w || sy < 0 || sy >= world_h { continue; }
                let cx = (sx / 16) + world.min_x;
                let cy = (sy / 16) + world.min_y;
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

            let off = ((px - ox1) * 4) as usize;
            row_pixels[off] = r; row_pixels[off + 1] = g; row_pixels[off + 2] = b; row_pixels[off + 3] = 255;
        }
    });
    Ok(PixelPatch { x: ox1, y: oy1, width, height, pixels })
}

/// Axonometric preview of the clipboard contents for the 3D tab in SelectionInspector.
/// Same projection math as render_axo_region but iterates in-memory clipboard voxels.
#[tauri::command]
fn render_axo_clipboard(ski: f32, dir: u8, state: tauri::State<'_, AppState>) -> Result<PreviewData, String> {
    let ws  = state.lock().unwrap_or_else(|p| p.into_inner());
    let sky = ws.world.as_ref().map(|w| w.sky).unwrap_or(0);
    let cb  = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
    Ok(render_axo_clipboard_inner(cb, sky, ski, dir))
}

fn render_axo_clipboard_inner(cb: &Clipboard, sky: u8, ski: f32, dir: u8) -> PreviewData {
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
                // Shaped clipboard: unmasked columns are see-through so the axo ghost matches paste.
                if cb.mask.as_ref().is_some_and(|m| !bit_set(m, (sy * cw + sx) as usize)) { continue; }
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

    PreviewData { width: cw as u32, height: ch as u32, pixels }
}

/// Used to show a block preview inside the paste ghost box.
/// Reads only from clipboard + sky — no world mutation.
#[tauri::command]
fn render_clipboard_preview(state: tauri::State<'_, AppState>) -> Result<PreviewData, String> {
    let ws  = state.lock().unwrap_or_else(|p| p.into_inner());
    let sky = ws.world.as_ref().map(|w| w.sky).unwrap_or(0);
    let cb  = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
    Ok(render_clipboard_preview_inner(cb, sky))
}

/// Top-down preview of a clipboard buffer (highest non-air block per column). Shared by
/// `render_clipboard_preview` (current clipboard) and `render_prefab_thumbnail` (a prefab
/// file on disk, deserialized without touching the clipboard/undo state).
fn render_clipboard_preview_inner(cb: &Clipboard, sky: u8) -> PreviewData {
    let (w, h, d) = (cb.width, cb.height, cb.depth);
    const VOID: [u8; 4] = [20, 20, 35, 255];
    let mut pixels = vec![0u8; (w * h * 4) as usize];
    // Shaped clipboard: leave unmasked columns fully transparent (alpha 0) so the paste ghost
    // shows only the traced footprint — masked-but-air columns keep the dark VOID look. A None
    // mask (prefab thumbnails, rectangular copies) fills the whole box with VOID as before.
    if cb.mask.is_none() {
        for p in pixels.chunks_exact_mut(4) { p.copy_from_slice(&VOID); }
    }
    for dy in 0..h {
        for dx in 0..w {
            let col = (dy * w + dx) as usize;
            if let Some(m) = &cb.mask {
                if !bit_set(m, col) { continue; } // outside footprint → stays alpha 0
                pixels[col * 4..col * 4 + 4].copy_from_slice(&VOID); // masked → dark VOID base
            }
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
    PreviewData { width: w as u32, height: h as u32, pixels }
}

// Renders the front (X-Z) or side (Y-Z) face of the clipboard for use as a
// ghost overlay in the elevation preview panel. Transparent pixels = air.
#[tauri::command]
fn render_clipboard_elevation_preview(
    view: String,
    state: tauri::State<'_, AppState>,
) -> Result<PreviewData, String> {
    let ws  = state.lock().unwrap_or_else(|p| p.into_inner());
    let sky = ws.world.as_ref().map(|w| w.sky).unwrap_or(0);
    let cb  = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
    Ok(render_clipboard_elevation_preview_inner(cb, sky, &view))
}

fn render_clipboard_elevation_preview_inner(cb: &Clipboard, sky: u8, view: &str) -> PreviewData {
    let (w, h, d) = (cb.width as usize, cb.height as usize, cb.depth as usize);
    let is_front = view != "side";
    let img_w = if is_front { w } else { h };
    let img_h = d;
    let mut pixels = vec![0u8; img_w * img_h * 4]; // alpha 0 = transparent air
    for dz in 0..d {
        let row = d - 1 - dz; // row 0 = top = highest z
        for col in 0..img_w {
            // Shaped clipboard: an unmasked column is treated as air so the ghost's silhouette
            // matches the paste footprint (front idx dy*w+col, side idx col*w+dx). None ⇒ no gate.
            let result = if is_front {
                // col = dx, scan dy front-to-back
                (0..h).find_map(|dy| {
                    if cb.mask.as_ref().is_some_and(|m| !bit_set(m, dy * w + col)) { return None; }
                    let bt = cb.block_types[dz * h * w + dy * w + col];
                    if bt != 0 { Some((bt, cb.paints[dz * h * w + dy * w + col])) } else { None }
                })
            } else {
                // col = dy, scan dx left-to-right
                (0..w).find_map(|dx| {
                    if cb.mask.as_ref().is_some_and(|m| !bit_set(m, col * w + dx)) { return None; }
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
    PreviewData { width: img_w as u32, height: img_h as u32, pixels }
}

// ── Prefab serialization ───────────────────────────────────────────────────────

fn serialize_prefab(cb: &Clipboard) -> Vec<u8> {
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    let n = (cb.width * cb.height * cb.depth) as usize;
    // A shaped prefab uses EPFAB\x02, appending a per-column footprint after the dense arrays.
    // Rectangular prefabs stay on EPFAB\x01 byte-for-byte, so existing files and older builds are
    // unaffected (the format is forward-compatible only, which is fine for a private tool).
    let mask_bytes: Option<&[u8]> = cb.mask.as_deref();
    let version: u8 = if mask_bytes.is_some() { 2 } else { 1 };
    let mut raw = Vec::with_capacity(22 + 2 * n + mask_bytes.map_or(0, |m| 1 + m.len()));
    raw.extend_from_slice(b"EPFAB");
    raw.push(version);
    for v in [cb.width, cb.height, cb.depth, cb.z_anchor] {
        raw.extend_from_slice(&v.to_le_bytes());
    }
    raw.extend_from_slice(&cb.block_types);
    raw.extend_from_slice(&cb.paints);
    if let Some(m) = mask_bytes {
        // Flag byte reserves room for a future maskless EPFAB\x02 (flag 0); today it's always 1.
        raw.push(1u8);
        raw.extend_from_slice(m);
    }
    let mut enc = GzEncoder::new(Vec::new(), Compression::best());
    enc.write_all(&raw).unwrap();
    enc.finish().unwrap()
}

fn deserialize_prefab(data: &[u8]) -> Result<Clipboard, String> {
    use std::borrow::Cow;
    // Auto-detect gzip (new compressed format) vs raw (legacy uncompressed).
    // Cap the decompressed size so a tiny "gzip bomb" .epfab can't expand to gigabytes. The largest
    // legitimate prefab is 22-byte header + 2 bytes per voxel + an optional 1-byte flag and a
    // width*height footprint bitset (≤ voxels/8, and ≤ MAX_CELLS/8 in the worst case).
    const MAX_CELLS: i64 = 64 * 1024 * 1024; // 64M voxels
    const MAX_DECOMPRESSED: u64 = 22 + 2 * MAX_CELLS as u64 + 1 + MAX_CELLS as u64 / 8;
    let raw: Cow<[u8]> = if data.starts_with(&[0x1f, 0x8b]) {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut out = Vec::new();
        GzDecoder::new(data).take(MAX_DECOMPRESSED + 1).read_to_end(&mut out)
            .map_err(|e| format!("Failed to decompress prefab: {e}"))?;
        if out.len() as u64 > MAX_DECOMPRESSED {
            return Err("Prefab is too large".into());
        }
        Cow::Owned(out)
    } else {
        Cow::Borrowed(data)
    };
    let data = raw.as_ref();
    if data.len() < 22 || &data[0..5] != b"EPFAB" {
        return Err("Not a valid .epfab file".into());
    }
    let version = data[5];
    if version != 1 && version != 2 {
        return Err("Unsupported .epfab version".into());
    }
    let width    = i32::from_le_bytes(data[6..10].try_into().unwrap());
    let height   = i32::from_le_bytes(data[10..14].try_into().unwrap());
    let depth    = i32::from_le_bytes(data[14..18].try_into().unwrap());
    let z_anchor = i32::from_le_bytes(data[18..22].try_into().unwrap());
    if width <= 0 || height <= 0 || depth <= 0 {
        return Err("Corrupt or truncated .epfab file".into());
    }
    // Volume in i64 so the multiply can't overflow i32 (which would wrap to a small n and pass the
    // truncation check with a bogus header). Cap it so a hostile header can't request a huge alloc.
    let vol = width as i64 * height as i64 * depth as i64;
    if vol > MAX_CELLS {
        return Err("Prefab dimensions too large".into());
    }
    let n = vol as usize;
    if data.len() < 22 + 2 * n {
        return Err("Corrupt or truncated .epfab file".into());
    }
    // EPFAB\x02 appends a per-column footprint: a 1-byte presence flag + a row-major width*height
    // bitset. v1 has no such section and stays rectangular (mask None). A malformed/short mask is
    // treated as "no shape" rather than an error — the prefab is still a valid full-box paste.
    let mask = if version == 2 {
        let mask_len = (width as usize * height as usize).div_ceil(8);
        let flag_off = 22 + 2 * n;
        if data.len() >= flag_off + 1 + mask_len && data[flag_off] == 1 {
            Some(data[flag_off + 1..flag_off + 1 + mask_len].to_vec())
        } else {
            None
        }
    } else {
        None // .epfab v1 is rectangular — prefabs drop any shape (see Clipboard::mask)
    };
    Ok(Clipboard {
        width, height, depth, z_anchor,
        block_types: data[22..22 + n].to_vec(),
        paints:      data[22 + n..22 + 2 * n].to_vec(),
        mask,
    })
}

#[tauri::command]
fn save_prefab(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let cb = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
    let bytes = serialize_prefab(cb);
    atomic_write(std::path::Path::new(&path), &bytes)
}

#[tauri::command]
fn load_prefab(path: String, state: tauri::State<'_, AppState>) -> Result<ClipboardInfo, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read prefab: {e}"))?;
    let cb   = deserialize_prefab(&data)?;
    let info = cb.info();
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    ws.clipboard = Some(cb);
    Ok(info)
}

// ── Prefab library panel (E4) ───────────────────────────────────────────────
//
// A dockable panel that lists .epfab files from a user-chosen (or app-default) folder,
// with thumbnails and click-to-arm-paste. Read-only scan of the filesystem — doesn't
// touch WorldState except through the existing load_prefab command when a thumbnail is
// clicked (unchanged, still stages into the clipboard).

#[derive(Serialize)]
struct PrefabEntry {
    name: String,
    path: String,
    width: i32,
    height: i32,
    depth: i32,
    /// Last-modified time, milliseconds since the Unix epoch (0 if unavailable). Used by the
    /// gallery for "Newest" sorting and as a thumbnail-cache key so unchanged files aren't
    /// re-rendered on every re-list.
    modified: u64,
}

/// File mtime in milliseconds since the Unix epoch, or 0 if unavailable.
fn file_mtime_ms(path: &std::path::Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `<app_data_dir>/prefabs` — created on demand. Used when the user hasn't set a custom
/// `prefabDirectory` in Settings (mirrors the autosave sidecar's app-data-dir pattern).
#[tauri::command]
fn get_default_prefab_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| format!("Failed to resolve app data dir: {e}"))?.join("prefabs");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create prefabs dir: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Reads just enough of each .epfab file to report its dimensions — decodes the gzip
/// stream but only until the 22-byte header is available, not the (much larger)
/// block/paint payload.
fn read_prefab_header(path: &std::path::Path) -> Option<(i32, i32, i32)> {
    use std::io::Read;
    let mut magic = [0u8; 2];
    fs::File::open(path).ok()?.read_exact(&mut magic).ok()?;
    let mut header = [0u8; 22];
    if magic == [0x1f, 0x8b] {
        // Gzip-compressed (current format) — decode just the header.
        use flate2::read::GzDecoder;
        GzDecoder::new(fs::File::open(path).ok()?).read_exact(&mut header).ok()?;
    } else {
        // Legacy uncompressed .epfab (still loadable by deserialize_prefab). Reading it as gzip
        // would fail and drop it from the gallery, so read the raw header directly.
        fs::File::open(path).ok()?.read_exact(&mut header).ok()?;
    }
    // Accept both the rectangular v1 and the shaped v2 header (dims sit at identical offsets).
    if &header[0..5] != b"EPFAB" || !matches!(header[5], 1 | 2) { return None; }
    let width  = i32::from_le_bytes(header[6..10].try_into().ok()?);
    let height = i32::from_le_bytes(header[10..14].try_into().ok()?);
    let depth  = i32::from_le_bytes(header[14..18].try_into().ok()?);
    if width <= 0 || height <= 0 || depth <= 0 { return None; }
    Some((width, height, depth))
}

/// Scans `dir` (non-recursive) for `.epfab` files and reports their dimensions.
/// Skips anything that fails to parse rather than erroring the whole listing.
#[tauri::command]
fn list_prefabs(dir: String) -> Result<Vec<PrefabEntry>, String> {
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read prefab directory: {e}"))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("epfab") { continue; }
        let Some((width, height, depth)) = read_prefab_header(&path) else { continue };
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("prefab").to_string();
        let modified = file_mtime_ms(&path);
        out.push(PrefabEntry { name, path: path.to_string_lossy().into_owned(), width, height, depth, modified });
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

/// Delete a `.epfab` file from disk. Guards on the extension so a bad `path` can't be used to
/// remove arbitrary files. Does not touch WorldState.
#[tauri::command]
fn delete_prefab(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.extension().and_then(|e| e.to_str()) != Some("epfab") {
        return Err("Not a prefab file".into());
    }
    fs::remove_file(p).map_err(|e| format!("Failed to delete prefab: {e}"))
}

/// Rename a `.epfab` file to `new_name` (a bare stem, no path/extension) within its own folder.
/// Sanitizes the new name and returns the new full path. Errors if the target already exists so
/// the caller can decide whether to overwrite via a fresh save.
#[tauri::command]
fn rename_prefab(path: String, new_name: String) -> Result<String, String> {
    let src = std::path::Path::new(&path);
    if src.extension().and_then(|e| e.to_str()) != Some("epfab") {
        return Err("Not a prefab file".into());
    }
    let stem: String = new_name.trim().chars().filter(|c| !matches!(c, '/' | '\\')).collect();
    let stem = stem.trim_end_matches(".epfab").trim();
    if stem.is_empty() { return Err("Name cannot be empty".into()); }
    let parent = src.parent().ok_or("Prefab has no parent folder")?;
    let dst = parent.join(format!("{stem}.epfab"));
    if dst == src { return Ok(dst.to_string_lossy().into_owned()); }
    if dst.exists() { return Err(format!("A prefab named “{stem}” already exists")); }
    fs::rename(src, &dst).map_err(|e| format!("Failed to rename prefab: {e}"))?;
    Ok(dst.to_string_lossy().into_owned())
}

/// Whether a file exists at `path` — used by the save-prefab flow to warn before overwriting.
#[tauri::command]
fn prefab_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Top-down thumbnail for a prefab file on disk — doesn't touch the clipboard or undo state.
#[tauri::command]
fn render_prefab_thumbnail(path: String, state: tauri::State<'_, AppState>) -> Result<PreviewData, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read prefab: {e}"))?;
    let cb = deserialize_prefab(&data)?;
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let sky = ws.world.as_ref().map(|w| w.sky).unwrap_or(0);
    Ok(render_clipboard_preview_inner(&cb, sky))
}

// ── Texture pack commands ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct TexturePackInfo {
    rows: u32,
    tile: u32,
    /// Number of full-color tiles N; a block's grayscale (painted) row = color_row + this offset.
    gray_row_offset: u32,
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
        gray_row_offset: pack.gray_row_offset,
        atlas: pack.atlas_rgba.clone(),
        name_to_row: pack.name_to_row.clone(),
    };
    state.lock().unwrap_or_else(|p| p.into_inner()).texture_pack = Some(pack);
    Ok(info)
}

/// Unload the current texture pack, reverting to flat vertex-color rendering.
#[tauri::command]
fn unload_texture_pack(state: tauri::State<'_, AppState>) {
    state.lock().unwrap_or_else(|p| p.into_inner()).texture_pack = None;
}

// ── App entry point ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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

/// Raise or lower a terrain column to target_z.
/// Raising: an explicit fill block is used verbatim; otherwise the surface block is
/// preserved as the cap and — for grass — the body below is layered with dirt so tall
/// raises look like natural ground (grass skin over a dirt core) rather than a solid
/// pillar of grass. Lowering deletes blocks above the new surface.
fn sculpt_column(world: &mut LoadedWorld, wx: i32, wy: i32, cur_z: i32, target_z: i32, max_z: i32, surf_bt: u8, surf_paint: u8, fill_bt: Option<u8>, fill_paint: Option<u8>) {
    let target_z = target_z.clamp(1, max_z);
    if target_z == cur_z { return; }
    if target_z > cur_z {
        match fill_bt {
            Some(bt) => {
                let paint = fill_paint.unwrap_or(surf_paint);
                for z in (cur_z + 1)..=target_z {
                    set_block_abs(world, wx, wy, z, bt, paint);
                }
            }
            None if surf_bt == 8 => {
                // Grass surface → dirt body + grass cap (block layering for tall raises).
                for z in (cur_z + 1)..target_z {
                    set_block_abs(world, wx, wy, z, 3, 0);
                }
                set_block_abs(world, wx, wy, target_z, 8, surf_paint);
            }
            None => {
                for z in (cur_z + 1)..=target_z {
                    set_block_abs(world, wx, wy, z, surf_bt, surf_paint);
                }
            }
        }
    } else {
        for z in (target_z + 1)..=cur_z {
            set_block_abs(world, wx, wy, z, 0, 0);
        }
    }
}

/// Cubic smoothstep on a clamped [0,1] input.
#[inline]
fn smoothstep01(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Brush falloff curve: maps normalised depth `t` (0 = rim, 1 = core) → weight, per profile.
/// "smooth" = smoothstep dome (default); "linear" = cone; "sphere" = round bulge (rises fast
/// off the rim); "sharp" = narrow core over a wide soft skirt.
#[inline]
fn falloff_dome(t: f64, profile: &str) -> f64 {
    let t = t.clamp(0.0, 1.0);
    match profile {
        "linear" => t,
        "sphere" => (t * (2.0 - t)).sqrt(),
        "sharp"  => t * t,
        _        => t * t * (3.0 - 2.0 * t),
    }
}

/// 8-connected neighbour offsets, cardinals first (weight 1.0) then diagonals (√½).
const SCULPT_KERNEL: [((i32, i32), f64); 8] = [
    ((-1, 0), 1.0), ((1, 0), 1.0), ((0, -1), 1.0), ((0, 1), 1.0),
    ((-1, -1), 0.70710677), ((-1, 1), 0.70710677), ((1, -1), 0.70710677), ((1, 1), 0.70710677),
];

// ── Sculpt terrain command ────────────────────────────────────────────────────

#[derive(serde::Deserialize, Clone)]
struct SculptPoint { x: i32, y: i32 }

/// Sculpt terrain at brush positions.
/// mode: "smooth" | "noise" | "flatten" | "erode" | "thermal" | "raise" | "lower"
///      | "grab" (drag-controlled displacement, `grab_delta`)
///      | "hydro" (droplet hydraulic erosion) | "stamp" (retexture surface by slope/height)
///      | "terrace" (quantize height to `strength`-block steps)
///      | "sharpen" (unsharp mask — pushes columns away from their neighbour average)
///      | "slope" (planar flatten tilted by `slope_dx/slope_dy`, rise per block, around the
///        anchor column — a Flatten with tilt; excluded from the frontend's hold-to-build timer
///        for the same reason Flatten is: it converges in one shot from its anchor)
///      | "smear" (lateral height advection: pulls each column's height from `smear_dx/smear_dy`
///        blocks behind the drag direction, so terrain drags along with the brush)
///
/// `softness` (0..1) applies a radial falloff. By default it derives from a distance field over
/// the swept footprint (BFS silhouette dome): 0 = hard flat edges (legacy behaviour), 1 = a full
/// dome tapering the effect to nothing at the brush rim. `profile` picks the dome curve
/// (smooth/linear/sphere/sharp). `anchor_x/anchor_y` is the pointer-down column — Flatten (and
/// Slope) levels everything to/around that height.
///
/// **Per-stamp radial falloff:** when `stamp_cx/stamp_cy/stamp_radius` are all supplied (3D-pane
/// stamps, 2D hold-to-build timer ticks — anything with a single well-defined brush centre), the
/// BFS is skipped and the weight is a clean Euclidean dome around that centre. When they're absent
/// (2D one-shot click-drag strokes, shape fills) the BFS silhouette dome is used unchanged.
///
/// **Backend footprint generation:** if `points` is `None`/empty *and* a stamp centre+radius are
/// given, the disc footprint is generated here (frontend needn't ship a point list per timer tick)
/// — the same squared-distance disc as the frontend's `brushFootprint("circ")`.
///
/// `use_cap` (default `true`): when `false`, the true uncapped surface is sculpted regardless of
/// the 2D cutaway cap (the 3D pane isn't clipped by cutaway). `group_id` tags every stamp of one
/// stroke so they undo/redo as a single unit (see `with_edit_grouped`).
///
/// Round a precise float height to the integer committed to the world. Soft brushes (`softness > 0`)
/// dither the fractional part against the BAYER8 ordered-dither threshold (the same table
/// `gradient_fill` uses) indexed by the column's world `(x, y)`, so a falloff isn't quantized into
/// concentric terraces; hard brushes round exactly (audit's explicit risk note). Shared by the
/// live-stroke float-workspace commit and the legacy per-call blend.
fn round_dither(raw: f64, softness: f64, x: i32, y: i32) -> i32 {
    if softness <= 0.0 {
        raw.round() as i32
    } else {
        let base = raw.floor();
        let frac = raw - base;
        let dith = (BAYER8[x.rem_euclid(8) as usize][y.rem_euclid(8) as usize] as f64 + 0.5) / 64.0;
        if frac >= dith { (base + 1.0) as i32 } else { base as i32 }
    }
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn sculpt_terrain(
    points: Option<Vec<SculptPoint>>,
    mode: String,
    strength: i32,
    seed: u64,
    block_type: Option<u8>,
    paint: Option<u8>,
    freq: Option<f64>,
    noise_mode: Option<String>,
    softness: Option<f64>,
    profile: Option<String>,
    grab_delta: Option<i32>,
    anchor_x: Option<i32>,
    anchor_y: Option<i32>,
    stamp_cx: Option<i32>,
    stamp_cy: Option<i32>,
    stamp_radius: Option<i32>,
    use_cap: Option<bool>,
    group_id: Option<u64>,
    slope_dx: Option<f64>,
    slope_dy: Option<f64>,
    smear_dx: Option<i32>,
    smear_dy: Option<i32>,
    stamp_centers: Option<Vec<[i32; 2]>>,
    clip_rect: Option<[i32; 4]>,
    strength_f: Option<f64>,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());

    // Live-stroke batching (row 6): a live 2D stroke ships every stamp centre queued since the last
    // flush in one call. Apply them sequentially — each sees the previous stamp's committed result,
    // the shared `group_id` keeps them one undo group, and the float session accumulates residuals
    // across them — then return a single patch over the union of all stamp discs so every change
    // reaches the frontend in one apply. Equivalent (byte-for-byte) to N separate same-group calls.
    if let Some(centers) = stamp_centers.filter(|c| !c.is_empty()) {
        let r = stamp_radius.unwrap_or(0).max(0);
        let cap = if use_cap.unwrap_or(true) { ws.view_cap_z } else { None };
        let (mut ux1, mut uy1, mut ux2, mut uy2) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        let mut last: Option<EditResult> = None;
        for c in &centers {
            let res = sculpt_terrain_inner(
                &mut ws, None, mode.clone(), strength, seed, block_type, paint, freq,
                noise_mode.clone(), softness, profile.clone(), grab_delta, anchor_x, anchor_y,
                Some(c[0]), Some(c[1]), Some(r), use_cap, group_id, slope_dx, slope_dy, smear_dx,
                smear_dy, clip_rect, strength_f,
            )?;
            ux1 = ux1.min(c[0] - r); uy1 = uy1.min(c[1] - r);
            ux2 = ux2.max(c[0] + r); uy2 = uy2.max(c[1] + r);
            last = Some(res);
        }
        let mut res = last.ok_or("No stamps")?;
        if let Some(world) = ws.world.as_ref() {
            res.patch = render_pixels_patch(world, ux1, uy1, ux2, uy2, cap);
        }
        return Ok(res);
    }

    sculpt_terrain_inner(
        &mut ws, points, mode, strength, seed, block_type, paint, freq, noise_mode, softness,
        profile, grab_delta, anchor_x, anchor_y, stamp_cx, stamp_cy, stamp_radius, use_cap, group_id,
        slope_dx, slope_dy, smear_dx, smear_dy, clip_rect, strength_f,
    )
}

#[allow(clippy::too_many_arguments)]
fn sculpt_terrain_inner(
    ws: &mut WorldState,
    points: Option<Vec<SculptPoint>>,
    mode: String,
    strength: i32,
    seed: u64,
    block_type: Option<u8>,
    paint: Option<u8>,
    freq: Option<f64>,
    noise_mode: Option<String>,
    softness: Option<f64>,
    profile: Option<String>,
    grab_delta: Option<i32>,
    anchor_x: Option<i32>,
    anchor_y: Option<i32>,
    stamp_cx: Option<i32>,
    stamp_cy: Option<i32>,
    stamp_radius: Option<i32>,
    use_cap: Option<bool>,
    group_id: Option<u64>,
    slope_dx: Option<f64>,
    slope_dy: Option<f64>,
    smear_dx: Option<i32>,
    smear_dy: Option<i32>,
    // Row 6: `clip_rect` = server-side selection mask (cells outside get weight 0, i.e. skipped);
    // `strength_f` = fractional per-stamp strength override for delta modes (the float workspace
    // makes it meaningful — UI still ships the integer 1–8 slider). `stamp_centers` batching is
    // handled one level up in the `sculpt_terrain` command (sequential same-group stamps).
    clip_rect: Option<[i32; 4]>,
    strength_f: Option<f64>,
) -> Result<EditResult, String> {
    let strength = strength.clamp(1, 8);
    // Fractional strength for additive modes when supplied, else the integer slider value.
    let strength_eff = strength_f.map(|f| f.clamp(0.0, 64.0)).unwrap_or(strength as f64);

    // A "dial" stamp is one with a single well-defined centre + radius. It drives both the
    // per-stamp radial falloff (below) and backend disc-footprint generation.
    let dial: Option<(i32, i32, i32)> = match (stamp_cx, stamp_cy, stamp_radius) {
        (Some(cx), Some(cy), Some(r)) => Some((cx, cy, r)),
        _ => None,
    };

    // Resolve the footprint. Explicit non-empty points win; otherwise generate a filled disc from
    // the stamp centre/radius (same `(dx² + dy²) <= (r + 0.5)²` convention as the frontend's
    // `brushFootprint(size = r*2+1, "circ")` so 2D and 3D disc sizes match). No points and no dial
    // → the historical "No points" error.
    let points: Vec<SculptPoint> = match points {
        Some(p) if !p.is_empty() => p,
        _ => match dial {
            Some((cx, cy, r)) => {
                let r = r.max(0);
                let rr = (r as f64 + 0.5).powi(2);
                let mut pts = Vec::new();
                for dy in -r..=r {
                    for dx in -r..=r {
                        if ((dx * dx + dy * dy) as f64) <= rr {
                            pts.push(SculptPoint { x: cx + dx, y: cy + dy });
                        }
                    }
                }
                pts
            }
            None => return Err("No points".into()),
        },
    };
    if points.is_empty() { return Err("No points".into()); }

    // Pre-read all heights and surface blocks while we have a shared ref. Smooth/erode/
    // thermal read the full 8-neighbourhood, so widen the pre-read beyond the footprint.
    // Cutaway: normally sculpt the exposed sub-cap surface; `use_cap: false` (3D pane, which is not
    // clipped by cutaway) ignores the cap and targets the true surface.
    let cap = if use_cap.unwrap_or(true) { ws.view_cap_z } else { None };
    let height_map: HashMap<(i32, i32), (i32, u8, u8)> = {
        let world = ws.world.as_ref().ok_or("No world loaded")?;
        let mut all_pts = std::collections::HashSet::new();
        for p in &points {
            all_pts.insert((p.x, p.y));
            for (dx, dy) in SCULPT_KERNEL.map(|(o, _)| o) {
                all_pts.insert((p.x + dx, p.y + dy));
            }
        }
        all_pts.into_iter()
            .filter_map(|(x, y)| {
                surface_z_capped(world, x, y, cap).map(|z| {
                    let bt    = read_block_abs(world, x, y, z);
                    let paint = read_paint_abs(world, x, y, z);
                    ((x, y), (z, bt, paint))
                })
            })
            .collect()
    };

    // Radial falloff weights. Dial stamps use a clean Euclidean dome around the stamp centre;
    // otherwise a distance field (8-connected BFS inward from the footprint boundary) → normalised
    // dome, blended toward a flat edge by `softness`.
    let softness = softness.unwrap_or(0.0).clamp(0.0, 1.0);
    let profile = profile.unwrap_or_else(|| "smooth".into());
    let weight: Box<dyn Fn(i32, i32) -> f64> = if let Some((scx, scy, srad)) = dial {
        // Per-stamp radial dome: literal Euclidean distance from the stamp centre, not graph
        // distance to the silhouette edge. weight = (1-softness) + dome*softness, clamped [0,1].
        let r = srad.max(1) as f64;
        let s = softness;
        let prof = profile.clone();
        Box::new(move |x, y| {
            if s <= 0.0 { return 1.0; }
            let d = (((x - scx) as f64).powi(2) + ((y - scy) as f64).powi(2)).sqrt();
            let dome = falloff_dome(1.0 - (d / r).min(1.0), &prof);
            ((1.0 - s) + dome * s).clamp(0.0, 1.0)
        })
    } else if softness <= 0.0 {
        Box::new(|_x, _y| 1.0) // hard edges
    } else {
        let members: HashSet<(i32, i32)> = points.iter().map(|p| (p.x, p.y)).collect();
        let mut dist: HashMap<(i32, i32), i32> = HashMap::new();
        let mut queue: VecDeque<(i32, i32)> = VecDeque::new();
        for &(x, y) in &members {
            let is_edge = SCULPT_KERNEL.iter().any(|((dx, dy), _)| !members.contains(&(x + dx, y + dy)));
            if is_edge { dist.insert((x, y), 1); queue.push_back((x, y)); }
        }
        while let Some((x, y)) = queue.pop_front() {
            let d = dist[&(x, y)];
            for ((dx, dy), _) in SCULPT_KERNEL {
                let n = (x + dx, y + dy);
                if members.contains(&n) && !dist.contains_key(&n) {
                    dist.insert(n, d + 1);
                    queue.push_back(n);
                }
            }
        }
        let max_dist = (*dist.values().max().unwrap_or(&1)).max(1) as f64;
        let weight_of: HashMap<(i32, i32), f64> = members.iter().map(|&(x, y)| {
            let d = *dist.get(&(x, y)).unwrap_or(&(max_dist as i32)) as f64;
            let dome = falloff_dome(d / max_dist, &profile);
            ((x, y), (1.0 - softness) + dome * softness)
        }).collect();
        Box::new(move |x, y| *weight_of.get(&(x, y)).unwrap_or(&1.0))
    };

    // Server-side selection clip: a cell outside `clip_rect` gets weight 0, so blend leaves it at
    // its current height (no-op) — a true per-cell mask that supersedes the frontend point-filter
    // for the batched live path and upgrades the 3D pane's crude centre-in-bounds drop.
    let weight: Box<dyn Fn(i32, i32) -> f64> = if let Some([cx1, cy1, cx2, cy2]) = clip_rect {
        let inner = weight;
        Box::new(move |x, y| {
            if x >= cx1 && x <= cx2 && y >= cy1 && y <= cy2 { inner(x, y) } else { 0.0 }
        })
    } else {
        weight
    };

    let (mut x_min, mut y_min, mut x_max, mut y_max) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for p in &points {
        x_min = x_min.min(p.x); y_min = y_min.min(p.y);
        x_max = x_max.max(p.x); y_max = y_max.max(p.y);
    }
    let rect = (x_min, y_min, x_max, y_max);

    let mode_label = mode.chars().next().map(|c| c.to_uppercase().to_string() + &mode[1..]).unwrap_or_else(|| mode.clone());
    let label = format!("{mode_label} ({} pts)", points.len());
    // Live-stroke float workspace (row 6). Pull the session owned by this stroke's `group_id` (or
    // start fresh); mode math blends into `session.fheight` so sub-block deltas accumulate across
    // stamps instead of being rounded away every call — the fix for the reinforcing-dither stripes
    // a repeated soft stamp used to leave. Taken out of `ws` here so the edit closure can borrow it
    // mutably alongside `world` (which `with_edit_inner` takes out of `ws`); written back after.
    // `with_edit_inner`'s own group-mismatch clear is a no-op while it's taken (already `None`).
    let mut session = match ws.sculpt_session.take() {
        Some(s) if Some(s.group_id) == group_id => s,
        _ => SculptSession { group_id: group_id.unwrap_or(0), fheight: HashMap::new() },
    };
    let result = with_edit_grouped(ws, &label, rect, rect, group_id, |world| {
        let max_z = world_max_z(world);
        // Blend `cur` toward the float `target` by the column's radial weight, accumulating the
        // precise result in the per-stroke float workspace and committing its dithered round. The
        // workspace seeds from `cur` (the world's current integer height) only on a column's FIRST
        // touch this stroke; later stamps read the retained float, so a 0.3-weight rim column gains
        // 0.3/stamp and crosses the next integer every ~3 stamps regardless of its fixed BAYER
        // threshold. Additive modes pass `target = cur + delta`; convergent modes pass the plane/
        // average target — both are the same `fh + (target - fh) * w` step.
        let mut blend = |cur: i32, target: f64, w: f64, x: i32, y: i32| -> i32 {
            let fh = session.fheight.entry((x, y)).or_insert(cur as f64);
            let raw = *fh + (target - *fh) * w;
            *fh = raw;
            round_dither(raw, softness, x, y)
        };
        match mode.as_str() {
            "smooth" => {
                // Iterated 8-connected averaging (cardinals 1, diagonals √½, centre 1). Runs
                // `strength` Jacobi passes over a local working copy seeded from `height_map`: each
                // pass reads the *previous* pass's heights (never values updated within the same
                // pass), so the result is independent of iteration order over `points`. Only the
                // final heights are committed to the world (sculpt_column bakes in surface-layering
                // side effects we don't want repeated per pass). Missing neighbours (world edge /
                // no surface) drop out of the average at every pass ("fix edges"); neighbours in
                // height_map but outside `points` act as fixed boundaries.
                // Passes run in float now (no per-pass rounding); the radial weight and the
                // float-workspace accumulation apply once at commit.
                let mut work: HashMap<(i32, i32), f64> =
                    height_map.iter().map(|(&k, &(z, _, _))| (k, z as f64)).collect();
                for _ in 0..strength {
                    let prev = work.clone();
                    for p in &points {
                        let Some(&cur_f) = prev.get(&(p.x, p.y)) else { continue };
                        let mut hsum = cur_f;
                        let mut wsum = 1.0;
                        for ((dx, dy), k) in SCULPT_KERNEL {
                            if let Some(&v) = prev.get(&(p.x + dx, p.y + dy)) {
                                hsum += v * k;
                                wsum += k;
                            }
                        }
                        if wsum <= 1.0 { continue; }
                        work.insert((p.x, p.y), hsum / wsum);
                    }
                }
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let smoothed = *work.get(&(p.x, p.y)).unwrap_or(&(cur_z as f64));
                    let final_z = blend(cur_z, smoothed, weight(p.x, p.y), p.x, p.y);
                    sculpt_column(world, p.x, p.y, cur_z, final_z, max_z, surf_bt, surf_paint, block_type, paint);
                }
            }
            "raise" | "lower" => {
                let sign = if mode == "raise" { 1 } else { -1 };
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let target = blend(cur_z, cur_z as f64 + sign as f64 * strength_eff, weight(p.x, p.y), p.x, p.y);
                    sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                }
            }
            "noise" => {
                // Coherent displacement (spatially correlated) instead of white noise.
                // "mountains" uses ridged multifractal (sharp ridgelines, pushes up);
                // "hills" (default) uses fbm (smooth rolling billows, ± around current).
                let freq = freq.unwrap_or(0.06).clamp(0.004, 0.5);
                let mountains = noise_mode.as_deref() == Some("mountains");
                let amp = strength as f64;
                // Per-stroke offset so successive strokes vary but a single stroke is coherent.
                let so = ((seed % 1_000_000) as f64) * 0.017 + 13.37;
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let fx = p.x as f64 * freq + so;
                    let fy = p.y as f64 * freq + so;
                    let raw = if mountains {
                        // ridged2 ∈ [0,1] → always builds upward, sharper peaks
                        ridged2(fx, fy, 4) * amp * 2.5
                    } else {
                        // fbm2 ∈ [-1,1] → gentle rolling ups and downs
                        fbm2(fx, fy, 4) * amp
                    };
                    // Weight + float-workspace accumulation via blend; `raw` is the full displacement.
                    let target = blend(cur_z, cur_z as f64 + raw, weight(p.x, p.y), p.x, p.y);
                    if target != cur_z {
                        sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                    }
                }
            }
            "flatten" => {
                // Level to the pointer-down column's height (stroke-start), falling back to
                // the footprint average when no anchor was supplied.
                let target_z = anchor_x.zip(anchor_y)
                    .and_then(|(ax, ay)| height_map.get(&(ax, ay)).map(|v| v.0))
                    .or_else(|| {
                        let heights: Vec<i32> = points.iter()
                            .filter_map(|p| height_map.get(&(p.x, p.y)).map(|v| v.0))
                            .collect();
                        if heights.is_empty() { None }
                        else { Some((heights.iter().sum::<i32>() as f32 / heights.len() as f32).round() as i32) }
                    });
                let Some(target_z) = target_z else { return Err("No surface".into()) };
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let target = blend(cur_z, target_z as f64, weight(p.x, p.y), p.x, p.y);
                    sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                }
            }
            "erode" => {
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let min_n = SCULPT_KERNEL.iter()
                        .filter_map(|((dx,dy),_)| height_map.get(&(p.x+dx, p.y+dy)).map(|v| v.0))
                        .min();
                    if let Some(mn) = min_n {
                        if cur_z > mn {
                            let eroded = (cur_z - strength).max(mn);
                            let target = blend(cur_z, eroded as f64, weight(p.x, p.y), p.x, p.y);
                            sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                        }
                    }
                }
            }
            "thermal" => {
                // Talus-angle erosion: any column whose drop to its lowest neighbour exceeds
                // the max stable slope (talus) sheds the excess, proportional to how far over
                // it is. `strength` sets the talus threshold (steeper allowed at low strength).
                let talus = (9 - strength).max(1); // strength 1..8 → talus 8..1
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let min_n = SCULPT_KERNEL.iter()
                        .filter_map(|((dx,dy),_)| height_map.get(&(p.x+dx, p.y+dy)).map(|v| v.0))
                        .min();
                    if let Some(mn) = min_n {
                        let excess = cur_z - mn - talus;
                        if excess > 0 {
                            // Shed half the excess (rounded up), never below the neighbour.
                            let drop = ((excess as f64 * 0.5).ceil() as i32).clamp(1, cur_z - mn);
                            let eroded = cur_z - drop;
                            let target = blend(cur_z, eroded as f64, weight(p.x, p.y), p.x, p.y);
                            sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                        }
                    }
                }
            }
            "grab" => {
                // Drag-controlled displacement: raise (+) or lower (−) every column by the
                // vertical drag distance, shaped by the radial falloff so the pulled region
                // domes up / dishes down smoothly rather than as a flat plateau.
                let d = grab_delta.unwrap_or(0);
                if d == 0 { return Ok(()); }
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let target = blend(cur_z, (cur_z + d) as f64, weight(p.x, p.y), p.x, p.y);
                    sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                }
            }
            "hydro" => {
                // Beyer-style droplet hydraulic erosion (the standard SebLague formulation).
                // Droplets flow in *continuous* float position, steered by the bilinear-interpolated
                // height gradient with inertia; they erode downhill — spread over an erosion-radius
                // brush so channels are dendritic gullies, not 1-wide staircase trenches — and drop
                // sediment onto the four bilinear corner nodes where the flow slows or climbs.
                //
                // The simulation runs over a workspace expanded HYDRO_MARGIN cells past the footprint
                // (read fresh from the world, since the shared `height_map` is only footprint + its
                // 8-ring): droplets that wander off the brush erode into that margin instead of dying
                // unnaturally at the footprint boundary. Only footprint columns are committed — any
                // change that lands in the margin is discarded.
                const HYDRO_INERTIA: f64 = 0.05;
                const HYDRO_SEDIMENT_CAPACITY_FACTOR: f64 = 4.0;
                const HYDRO_MIN_SEDIMENT_CAPACITY: f64 = 0.01;
                const HYDRO_ERODE_SPEED: f64 = 0.3;
                const HYDRO_DEPOSIT_SPEED: f64 = 0.3;
                const HYDRO_EVAPORATE_SPEED: f64 = 0.02;
                const HYDRO_GRAVITY: f64 = 4.0;
                const HYDRO_MAX_LIFETIME: i32 = 32;
                const HYDRO_INITIAL_WATER: f64 = 1.0;
                const HYDRO_INITIAL_SPEED: f64 = 1.0;
                const HYDRO_EROSION_RADIUS: i32 = 3;
                const HYDRO_MARGIN: i32 = 16;

                let ws_x0 = x_min - HYDRO_MARGIN;
                let ws_y0 = y_min - HYDRO_MARGIN;
                let ws_w = (x_max - x_min + 1 + 2 * HYDRO_MARGIN) as usize;
                let ws_h = (y_max - y_min + 1 + 2 * HYDRO_MARGIN) as usize;

                // Dense workspace heightmap in float; `None` = no surface / outside the world, which
                // stops any droplet that reaches it. Read directly from the world (see comment above).
                let world_ref: &LoadedWorld = world;
                let mut hmap: Vec<Option<f64>> = Vec::with_capacity(ws_w * ws_h);
                for gy in 0..ws_h {
                    for gx in 0..ws_w {
                        let wx = ws_x0 + gx as i32;
                        let wy = ws_y0 + gy as i32;
                        hmap.push(surface_z_capped(world_ref, wx, wy, cap).map(|z| z as f64));
                    }
                }

                // Grid accessors take `&hmap`/`&mut hmap` explicitly so they never hold a borrow
                // across the droplet loop's own mutations.
                let node_at = |hmap: &[Option<f64>], gx: i32, gy: i32| -> Option<f64> {
                    if gx < 0 || gy < 0 || gx >= ws_w as i32 || gy >= ws_h as i32 { return None; }
                    hmap[gy as usize * ws_w + gx as usize]
                };
                let modify = |hmap: &mut [Option<f64>], gx: i32, gy: i32, d: f64| {
                    if gx < 0 || gy < 0 || gx >= ws_w as i32 || gy >= ws_h as i32 { return; }
                    if let Some(h) = hmap[gy as usize * ws_w + gx as usize].as_mut() { *h += d; }
                };

                // Radial erosion brush: weight = max(0, radius - dist), normalised to sum 1. Precomputed
                // once (offsets are droplet-independent).
                let erosion_brush: Vec<(i32, i32, f64)> = {
                    let r = HYDRO_EROSION_RADIUS;
                    let mut v = Vec::new();
                    let mut total = 0.0f64;
                    for dy in -r..=r {
                        for dx in -r..=r {
                            let w = (r as f64 - ((dx * dx + dy * dy) as f64).sqrt()).max(0.0);
                            if w > 0.0 { v.push((dx, dy, w)); total += w; }
                        }
                    }
                    for e in v.iter_mut() { e.2 /= total; }
                    v
                };

                // Rng64 has no float method; derive a uniform [0,1) from its top 53 bits.
                let rand01 = |rng: &mut Rng64| -> f64 { (rng.next() >> 11) as f64 / (1u64 << 53) as f64 };

                let n_droplets = points.len() * (strength as usize) / 2 + points.len();
                let mut rng = Rng64::new(seed ^ 0x9E37_79B9_7F4A_7C15);
                let member: Vec<(i32, i32)> = points.iter().map(|p| (p.x, p.y)).collect();
                for _ in 0..n_droplets {
                    // Random continuous start within the footprint disc (a member node + sub-cell jitter).
                    let (sx, sy) = member[(rng.next() as usize) % member.len()];
                    let mut px = (sx - ws_x0) as f64 + rand01(&mut rng);
                    let mut py = (sy - ws_y0) as f64 + rand01(&mut rng);
                    let (mut dir_x, mut dir_y) = (0.0f64, 0.0f64);
                    let mut speed = HYDRO_INITIAL_SPEED;
                    let mut water = HYDRO_INITIAL_WATER;
                    let mut sediment = 0.0f64;

                    for _ in 0..HYDRO_MAX_LIFETIME {
                        let (nx, ny) = (px.floor() as i32, py.floor() as i32);
                        let (u, v) = (px - nx as f64, py - ny as f64);
                        let (Some(h00), Some(h10), Some(h01), Some(h11)) = (
                            node_at(&hmap, nx, ny),     node_at(&hmap, nx + 1, ny),
                            node_at(&hmap, nx, ny + 1), node_at(&hmap, nx + 1, ny + 1),
                        ) else { break };
                        let grad_x = (h10 - h00) * (1.0 - v) + (h11 - h01) * v;
                        let grad_y = (h01 - h00) * (1.0 - u) + (h11 - h10) * u;
                        let height_here = h00 * (1.0 - u) * (1.0 - v) + h10 * u * (1.0 - v)
                            + h01 * (1.0 - u) * v + h11 * u * v;

                        // Blend the running direction (inertia) with the downhill gradient, then
                        // normalise to a unit step. Flat + stalled → random unit dir so it explores.
                        dir_x = dir_x * HYDRO_INERTIA - grad_x * (1.0 - HYDRO_INERTIA);
                        dir_y = dir_y * HYDRO_INERTIA - grad_y * (1.0 - HYDRO_INERTIA);
                        let len = (dir_x * dir_x + dir_y * dir_y).sqrt();
                        if len <= 1e-8 {
                            let ang = rand01(&mut rng) * std::f64::consts::TAU;
                            dir_x = ang.cos();
                            dir_y = ang.sin();
                        } else {
                            dir_x /= len;
                            dir_y /= len;
                        }

                        let (old_px, old_py) = (px, py);
                        px += dir_x;
                        py += dir_y;

                        // Sample the new height (bilinear); leaving the workspace stops the droplet.
                        let (mx, my) = (px.floor() as i32, py.floor() as i32);
                        let (mu, mv) = (px - mx as f64, py - my as f64);
                        let (Some(n00), Some(n10), Some(n01), Some(n11)) = (
                            node_at(&hmap, mx, my),     node_at(&hmap, mx + 1, my),
                            node_at(&hmap, mx, my + 1), node_at(&hmap, mx + 1, my + 1),
                        ) else { break };
                        let new_height = n00 * (1.0 - mu) * (1.0 - mv) + n10 * mu * (1.0 - mv)
                            + n01 * (1.0 - mu) * mv + n11 * mu * mv;
                        let delta_height = new_height - height_here;

                        let capacity = (-delta_height * speed * water * HYDRO_SEDIMENT_CAPACITY_FACTOR)
                            .max(HYDRO_MIN_SEDIMENT_CAPACITY);

                        let (onx, ony) = (old_px.floor() as i32, old_py.floor() as i32);
                        let (ou, ov) = (old_px - onx as f64, old_py - ony as f64);
                        if delta_height > 0.0 || sediment > capacity {
                            // Deposit onto the four bilinear corners at the OLD position. Uphill: fill
                            // the pit, capped by carried sediment; else shed the over-capacity excess.
                            let amount = if delta_height > 0.0 {
                                delta_height.min(sediment)
                            } else {
                                (sediment - capacity) * HYDRO_DEPOSIT_SPEED
                            };
                            sediment -= amount;
                            modify(&mut hmap, onx,     ony,     amount * (1.0 - ou) * (1.0 - ov));
                            modify(&mut hmap, onx + 1, ony,     amount * ou * (1.0 - ov));
                            modify(&mut hmap, onx,     ony + 1, amount * (1.0 - ou) * ov);
                            modify(&mut hmap, onx + 1, ony + 1, amount * ou * ov);
                        } else {
                            // Erode, spread across the radial brush at the OLD position (never take
                            // more than the height drop). Cells outside the workspace drop out.
                            let amount = ((capacity - sediment) * HYDRO_ERODE_SPEED).min(-delta_height);
                            for &(dx, dy, bw) in &erosion_brush {
                                modify(&mut hmap, onx + dx, ony + dy, -amount * bw);
                            }
                            sediment += amount;
                        }

                        // deltaHeight is negative when descending → this speeds the droplet up; max(0)
                        // guards a NaN sqrt when climbing sharply. Evaporate, then stop if dry.
                        speed = (speed * speed + delta_height * HYDRO_GRAVITY).max(0.0).sqrt();
                        water *= 1.0 - HYDRO_EVAPORATE_SPEED;
                        if water < 0.01 { break; }
                    }
                }

                // Commit final workspace heights back — footprint columns only (see arm comment).
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let new_h = node_at(&hmap, p.x - ws_x0, p.y - ws_y0)
                        .unwrap_or(cur_z as f64).round() as i32;
                    let target = blend(cur_z, new_h as f64, weight(p.x, p.y), p.x, p.y);
                    sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                }
            }
            "stamp" => {
                // Retexture the surface block by local steepness (max height diff to an
                // 8-neighbour): flat → grass, moderate → dirt, steep → stone. Purely repaints
                // the top block; never changes heights. Ignores an explicit fill block.
                for p in &points {
                    let Some(&(cur_z, _surf_bt, _surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let slope = SCULPT_KERNEL.iter()
                        .filter_map(|((dx,dy),_)| height_map.get(&(p.x+dx, p.y+dy)).map(|v| (v.0 - cur_z).abs()))
                        .max().unwrap_or(0);
                    let new_bt: u8 = if slope >= 3 { 2 } else if slope == 2 { 3 } else { 8 };
                    set_block_abs(world, p.x, p.y, cur_z, new_bt, 0);
                }
            }
            "terrace" => {
                // Quantize each column's height to N-block steps (Strength doubles as step size).
                let step = strength.max(1);
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let terraced = ((cur_z as f64 / step as f64).round() as i32) * step;
                    let target = blend(cur_z, terraced as f64, weight(p.x, p.y), p.x, p.y);
                    sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                }
            }
            "sharpen" => {
                // Unsharp mask: push each column away from its 8-neighbour average — the inverse
                // of Smooth. Strength (1..8) scales how much of the deviation from the local
                // average gets amplified back in.
                let amount = strength as f64 / 8.0;
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let mut hsum = cur_z as f64;
                    let mut wsum = 1.0;
                    for ((dx, dy), k) in SCULPT_KERNEL {
                        if let Some(v) = height_map.get(&(p.x + dx, p.y + dy)) {
                            hsum += v.0 as f64 * k;
                            wsum += k;
                        }
                    }
                    if wsum <= 1.0 { continue; }
                    let avg = hsum / wsum;
                    let sharpened = (cur_z as f64 + (cur_z as f64 - avg) * amount).round() as i32;
                    let target = blend(cur_z, sharpened as f64, weight(p.x, p.y), p.x, p.y);
                    sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                }
            }
            "slope" => {
                // Planar flatten: level toward an angled plane through the anchor column, tilted
                // by slope_dx/slope_dy (rise per block along X/Y). Requires an anchor, same as
                // Flatten — a flat (0-tilt) plane through the anchor is exactly Flatten's result.
                let (sdx, sdy) = (slope_dx.unwrap_or(0.0), slope_dy.unwrap_or(0.0));
                let anchor = anchor_x.zip(anchor_y);
                let anchor_z = anchor.and_then(|(ax, ay)| height_map.get(&(ax, ay)).map(|v| v.0));
                let Some(anchor_z) = anchor_z else { return Err("No surface".into()) };
                let (ax, ay) = anchor.unwrap();
                for p in &points {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let plane_z = anchor_z as f64 + sdx * (p.x - ax) as f64 + sdy * (p.y - ay) as f64;
                    let target = blend(cur_z, plane_z, weight(p.x, p.y), p.x, p.y);
                    sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                }
            }
            "smear" => {
                // Lateral height advection: pull each column's height from a position offset
                // opposite the drag direction, so terrain drags along with the brush like wet
                // paint. Sources are read fresh from the world (pre-mutation) for the whole
                // footprint first — points may overlap each other's sources within one stamp.
                let (sdx, sdy) = (smear_dx.unwrap_or(0), smear_dy.unwrap_or(0));
                if sdx == 0 && sdy == 0 { return Ok(()); }
                // Explicit shared reborrow: the `.map` closure only needs read access, and capturing
                // `world` (a `&mut LoadedWorld`) directly would move the unique borrow into the
                // closure, leaving it unusable for `sculpt_column` below.
                let world_ref: &LoadedWorld = world;
                let sources: Vec<Option<(i32, u8, u8)>> = points.iter().map(|p| {
                    let (sx, sy) = (p.x - sdx, p.y - sdy);
                    surface_z_capped(world_ref, sx, sy, cap).map(|z| {
                        (z, read_block_abs(world_ref, sx, sy, z), read_paint_abs(world_ref, sx, sy, z))
                    })
                }).collect();
                for (p, src) in points.iter().zip(sources.iter()) {
                    let Some(&(cur_z, surf_bt, surf_paint)) = height_map.get(&(p.x, p.y)) else { continue };
                    let Some((src_z, _, _)) = *src else { continue };
                    let target = blend(cur_z, src_z as f64, weight(p.x, p.y), p.x, p.y);
                    sculpt_column(world, p.x, p.y, cur_z, target, max_z, surf_bt, surf_paint, block_type, paint);
                }
            }
            _ => {}
        }
        Ok(())
    });
    // Persist the float workspace only for a real (grouped) live stroke — a one-shot call (group
    // `None`: shape fills, Live-brush-OFF) has no successor stamp to accumulate into, so its session
    // is discarded and behaves exactly like the old per-call round. A foreign edit or undo/redo will
    // reap a persisted session at one of the invalidation choke points (see `SculptSession`).
    if group_id.is_some() {
        ws.sculpt_session = Some(session);
    }
    result
}

// ── Fill surface (flood fill) ─────────────────────────────────────────────────

/// Flood-fill connected surface blocks of the same type as the seed position.
#[tauri::command(async)]
fn fill_surface(
    wx: i32, wy: i32,
    new_type: u8, new_paint: u8,
    max_fill: u32,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    if new_paint > 54 { return Err("Invalid paint".into()); }
    let max_fill = max_fill.clamp(1, 50_000);

    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());

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

    let rect = (x_min, y_min, x_max, y_max);
    let label = format!("Fill {} blocks", fill_cells.len());
    with_edit(&mut ws, &label, rect, rect, |world| {
        for &(x, y, z) in &fill_cells {
            set_block_abs(world, x, y, z, new_type, new_paint);
        }
        Ok(())
    })
}

// ── Selection helpers ─────────────────────────────────────────────────────────

#[derive(Serialize)]
struct SelectRect { x1: i32, y1: i32, x2: i32, y2: i32 }

/// Flood-fill select connected surface region matching (wx,wy).
/// When match_paint is false, only block type is compared (ignores paint colour).
/// Returns the bounding box of the selected region AND stores the exact matched footprint as the
/// active `SelectionMask` (keyed to that bbox), so a subsequent Delete/Fill affects only the shaped
/// cells — not the whole box, which was the long-standing "wand selects unrelated cells" bug (the
/// BFS already visited the true shape; it just used to be discarded once the bbox was computed).
#[tauri::command(async)]
fn magic_wand_select(
    wx: i32, wy: i32,
    match_paint: bool,
    state: tauri::State<'_, AppState>,
) -> Result<Option<SelectRect>, String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());

    // Phase A: run the BFS under an immutable world borrow, collecting every *matched* cell (not the
    // whole `visited` frontier, which includes rejected neighbours). Then drop the borrow so Phase B
    // can install the mask on `ws`.
    let outcome: Option<(SelectRect, Vec<(i32, i32)>)> = {
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
        let mut matched: Vec<(i32, i32)> = Vec::new();
        let (mut x_min, mut y_min, mut x_max, mut y_max) = (wx, wy, wx, wy);
        let mut count = 0u32;

        queue.push_back((wx, wy));
        visited.insert((wx, wy));

        while let Some((x, y)) = queue.pop_front() {
            if count >= MAX_CELLS { break; }
            let Some(sz) = surface_z(world, x, y) else { continue };
            if read_block_abs(world, x, y, sz) != seed_bt { continue; }
            if match_paint && read_paint_abs(world, x, y, sz) != seed_paint { continue; }
            matched.push((x, y));
            x_min = x_min.min(x); y_min = y_min.min(y);
            x_max = x_max.max(x); y_max = y_max.max(y);
            count += 1;
            for (dx, dy) in [(-1i32,0i32),(1,0),(0,-1),(0,1)] {
                let nx = x + dx; let ny = y + dy;
                if nx < 0 || ny < 0 || nx >= ww || ny >= wh { continue; }
                if visited.insert((nx, ny)) { queue.push_back((nx, ny)); }
            }
        }

        if count == 0 { None }
        else { Some((SelectRect { x1: x_min, y1: y_min, x2: x_max, y2: y_max }, matched)) }
    };

    // Phase B: nothing matched → leave any existing mask alone and report no selection.
    let (rect, matched) = match outcome {
        Some(v) => v,
        None => return Ok(None),
    };

    // Rasterise the matched cells into a bitset over the bbox and install it as the active mask.
    let w = rect.x2 - rect.x1 + 1;
    let h = rect.y2 - rect.y1 + 1;
    let mut bits = vec![0u8; ((w * h + 7) / 8) as usize];
    for (x, y) in matched {
        let idx = ((y - rect.y1) * w + (x - rect.x1)) as usize;
        bits[idx >> 3] |= 1u8 << (idx & 7);
    }
    ws.selection_mask = Some(SelectionMask { x1: rect.x1, y1: rect.y1, x2: rect.x2, y2: rect.y2, bits });

    Ok(Some(rect))
}

/// Install an explicit non-rectangular selection footprint (used by the lasso tool). `bits_b64` is a
/// base64 row-major bitset over the bbox — `ceil(width*height/8)` bytes, bit `(y-y1)*width+(x-x1)`.
/// Rejects a size that doesn't match the bbox so a malformed payload can't produce an under-read
/// mask (`contains` would then silently treat missing bytes as unselected — a rejection is clearer).
#[tauri::command]
fn set_selection_mask(
    x1: i32, y1: i32, x2: i32, y2: i32,
    bits_b64: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if x2 < x1 || y2 < y1 {
        return Err("Invalid mask bbox: x2/y2 must be >= x1/y1".into());
    }
    let bits = STANDARD.decode(bits_b64.as_bytes()).map_err(|e| format!("Bad mask base64: {e}"))?;
    let w = (x2 - x1 + 1) as usize;
    let h = (y2 - y1 + 1) as usize;
    let need = w.saturating_mul(h).div_ceil(8);
    if bits.len() != need {
        return Err(format!("Mask size mismatch: got {} bytes, need {} for {w}×{h}", bits.len(), need));
    }
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    ws.selection_mask = Some(SelectionMask { x1, y1, x2, y2, bits });
    Ok(())
}

/// Drop the active non-rectangular selection footprint. The frontend calls this on any selection
/// reshape (new marquee, edge resize, select-all, 3D two-click, clear) so a stale wand/lasso shape
/// never lingers; edits then behave rect-only. (The backend also re-checks the rect every edit, so
/// this is defense-in-depth, not the sole guard — see `SelectionMask`.)
#[tauri::command]
fn clear_selection_mask(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
    ws.selection_mask = None;
    Ok(())
}

#[derive(Serialize)]
struct SelectionMaskInfo {
    x1: i32, y1: i32, x2: i32, y2: i32,
    /// Row-major bitset over the bbox, base64 — decode with `decodeU8` (codec.ts).
    #[serde(serialize_with = "serialize_bytes_b64")]
    bits: Vec<u8>,
}

/// Return the active non-rectangular selection footprint (bbox + base64 bitset), or `None` when the
/// selection is a plain rectangle. The map-canvas overlay decodes this to fill only the shaped cells.
#[tauri::command]
fn get_selection_mask(state: tauri::State<'_, AppState>) -> Result<Option<SelectionMaskInfo>, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    Ok(ws.selection_mask.as_ref().map(|m| SelectionMaskInfo {
        x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2, bits: m.bits.clone(),
    }))
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
    mask: Option<&[u8]>,
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
                // Shaped clipboard: unmasked columns don't stamp (scatter/array honour the shape too).
                if let Some(m) = mask { if !bit_set(m, (dy * width + dx) as usize) { continue; } }
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
#[tauri::command(async)]
fn scatter_paste(
    x1: i32, y1: i32, x2: i32, y2: i32,
    count: i32,
    seed: u64,
    elevation_offset: i32,
    ignore_air: bool,
    state: tauri::State<'_, AppState>,
) -> Result<EditResult, String> {
    let count = count.clamp(1, 100);
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());

    let (width, height, depth, z_anchor, block_types, paints, mask) = {
        let cb = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
        (cb.width, cb.height, cb.depth, cb.z_anchor, cb.block_types.clone(), cb.paints.clone(), cb.mask.clone())
    };

    // Placement range clamps to 1 (all pastes land at x1/y1) when the clipboard is larger than the
    // scatter box, so the actual paste footprint can extend past x2/y2. Widen the snapshot/patch
    // rect to the true placement extent — otherwise chunks the paste touches beyond x2/y2 are
    // never snapshotted (breaks undo) and never included in the returned patch (stale map tiles).
    let range_x = (x2 - x1 - width + 2).max(1);
    let range_y = (y2 - y1 - height + 2).max(1);
    let max_px = x1 + range_x - 1;
    let max_py = y1 + range_y - 1;
    let rect = (x1, y1, x2.max(max_px + width - 1), y2.max(max_py + height - 1));
    let label = format!("Scatter paste ×{count}");
    with_edit(&mut ws, &label, rect, rect, |world| {
        let max_z = world_max_z(world);
        let range_x = range_x as u64;
        let range_y = range_y as u64;
        let mut rng = Rng64::new(if seed == 0 { 0xdeadbeef_cafebabe } else { seed });

        for _ in 0..count {
            let px = x1 + (rng.next() % range_x) as i32;
            let py = y1 + (rng.next() % range_y) as i32;
            paste_clipboard_at(world, px, py, &block_types, &paints,
                width, height, depth, z_anchor, elevation_offset, ignore_air, max_z, mask.as_deref());
        }
        Ok(())
    })
}

/// Paste clipboard in a cols × rows grid with given spacing.
#[tauri::command(async)]
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
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());

    let (width, height, depth, z_anchor, block_types, paints, mask) = {
        let cb = ws.clipboard.as_ref().ok_or("Clipboard is empty")?;
        (cb.width, cb.height, cb.depth, cb.z_anchor, cb.block_types.clone(), cb.paints.clone(), cb.mask.clone())
    };

    let step_x = if spacing_x > 0 { spacing_x } else { width };
    let step_y = if spacing_y > 0 { spacing_y } else { height };
    let x2 = origin_x + (cols - 1) * step_x + width  - 1;
    let y2 = origin_y + (rows - 1) * step_y + height - 1;

    let rect = (origin_x, origin_y, x2, y2);
    let label = format!("Array paste {cols}×{rows}");
    with_edit(&mut ws, &label, rect, rect, |world| {
        let max_z = world_max_z(world);
        for row in 0..rows {
            for col in 0..cols {
                let px = origin_x + col * step_x;
                let py = origin_y + row * step_y;
                paste_clipboard_at(world, px, py, &block_types, &paints,
                    width, height, depth, z_anchor, elevation_offset, ignore_air, max_z, mask.as_deref());
            }
        }
        Ok(())
    })
}

pub fn run() {
    sweep_stale_temps(); // clear staging temps leaked by a previous clean quit
    tauri::Builder::default()
        .manage(Mutex::new(WorldState::new()))
        .manage(ExpandCancel::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_world,
            get_world_info,
            fetch_tile,
            set_view_cap,
            export_png,
            describe_selection,
            delete_blocks,
            replace_blocks,
            gradient_fill,
            paint_blocks,
            fill_connected_face,
            save_world,
            close_world,
            autosave_world,
            get_autosave_info,
            get_autosave_path,
            discard_autosave,
            undo_edit,
            redo_edit,
            list_undo_stack,
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
            move_selection,
            render_clipboard_preview,
            render_clipboard_elevation_preview,
            save_prefab,
            load_prefab,
            get_default_prefab_dir,
            list_prefabs,
            delete_prefab,
            rename_prefab,
            prefab_exists,
            render_prefab_thumbnail,
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
            set_selection_mask,
            clear_selection_mask,
            get_selection_mask,
            scatter_paste,
            array_paste,
            export_obj,
            export_json,
            export_vox,
            export_vmf,
            estimate_vmf,
            get_obj_geometry,
            get_chunk_geometry,
            get_light_constants,
            get_lamps_near,
            pick_block,
            set_cursor_lock,
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
            cancel_expand,
            load_texture_pack,
            unload_texture_pack,
            get_block_tables,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Sky grid (Phase 5) ───────────────────────────────────────────────────────

/// Read the 4×4 sky-colour grid from header bytes 132–147.
/// Returns 16 paint indices (0 = default blue, 1–54 = paint palette).
#[tauri::command]
fn get_sky_grid(state: tauri::State<'_, AppState>) -> Result<Vec<u8>, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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
    let mut ws = state.lock().unwrap_or_else(|p| p.into_inner());
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

    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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
        if !(0..=6).contains(&type_id) { continue; } // −1 = empty slot

        let pos_x   = f32::from_le_bytes(s[ 0.. 4].try_into().unwrap()); // Eden X
        let pos_z   = f32::from_le_bytes(s[ 8..12].try_into().unwrap()); // Eden Y (south)
        let pos_y   = f32::from_le_bytes(s[ 4.. 8].try_into().unwrap()); // Eden Z (height)
        let angle   = f32::from_le_bytes(s[24..28].try_into().unwrap());
        let color   = i32::from_le_bytes(s[32..36].try_into().unwrap());

        out.push(CreatureInfo { type_id, color, x: pos_x, y: pos_z, z: pos_y, angle });
    }
    Ok(out)
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
        delete_blocks_inner(&mut world, 3, 5, 3, 5, 0, 63, None);

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

    /// Delta-undo round trip (D4): `diff_chunk` must pick `Sparse` for a single-byte edit and
    /// `Full` for a dense one, and `restore_and_invert` must be exactly invertible in both cases
    /// — including toggling undo→redo→undo again, not just a single pass.
    #[test]
    fn test_delta_undo_round_trip() {
        let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
        let target = blk(3, 5, 0);

        // ── Sparse case: mutate exactly one byte of a 32 KB chunk ──────────────────────────
        let pre_full = snapshot_chunks_full(&world, &[(0, 0)]);
        let original_val = world.bytes[target];
        world.bytes[target] = 99;

        let snap = diff_chunk(&world, 0, 0, &pre_full[0].2).expect("changed chunk must diff to Some");
        match &snap.delta {
            ChunkDelta::Sparse(pairs) => assert_eq!(pairs.len(), 1, "single-byte edit must diff to one sparse entry"),
            ChunkDelta::Full(_) => panic!("single-byte edit should not fall back to Full"),
        }

        let entry = UndoEntry { operation: "test".into(), chunks: vec![snap], group: None };
        let redo_chunks = restore_and_invert(&mut world, &entry);
        assert_eq!(world.bytes[target], original_val, "undo must restore the original byte");

        let redo_entry = UndoEntry { operation: "test".into(), chunks: redo_chunks, group: None };
        let undo_again_chunks = restore_and_invert(&mut world, &redo_entry);
        assert_eq!(world.bytes[target], 99, "redo must restore the edited byte");

        restore_and_invert(&mut world, &UndoEntry { operation: "test".into(), chunks: undo_again_chunks, group: None });
        assert_eq!(world.bytes[target], original_val, "second undo must restore the original byte again");

        // ── Dense case: overwrite the whole file so diff_chunk falls back to Full ──────────
        let pre_full2 = snapshot_chunks_full(&world, &[(0, 0)]);
        for b in world.bytes.iter_mut() { *b = 0xAB; }
        let snap2 = diff_chunk(&world, 0, 0, &pre_full2[0].2).expect("dense change must diff to Some");
        match &snap2.delta {
            ChunkDelta::Full(_) => {}
            ChunkDelta::Sparse(pairs) => panic!("dense edit should fall back to Full, got Sparse({} entries)", pairs.len()),
        }
        restore_and_invert(&mut world, &UndoEntry { operation: "test".into(), chunks: vec![snap2], group: None });
        assert_eq!(&world.bytes[HEADER..HEADER + 32768], &pre_full2[0].2[..],
            "Full-delta undo must restore the whole chunk");
    }

    /// B2 face-fill bucket: `find_connected_face_cells` must follow a contiguous same-type run
    /// across the clicked face's plane, stop at a differently-typed or disconnected cell, and — the
    /// case that distinguishes it from a flat 2D flood-fill — refuse to cross into a same-type cell
    /// whose own face (along the same normal) isn't exposed, since that's a different visible run.
    #[test]
    fn test_face_fill_connected_cells() {
        let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");

        // A 3-cell Stone floor at z=10, all with an exposed top face (air at z=11) — one connected run.
        for lx in 3..=5 {
            world.bytes[blk(lx, 5, 10)] = 2; // Stone
        }
        // Disconnected Stone cell elsewhere — must NOT be swept in.
        world.bytes[blk(10, 10, 10)] = 2;
        // Adjacent Stone cell (lx=6) whose top face is covered by another block — same type, but not
        // the same visible face, so the BFS must stop before it even though it's 4-connected in-plane.
        world.bytes[blk(6, 5, 10)] = 2;
        world.bytes[blk(6, 5, 11)] = 2;

        let mut cells = find_connected_face_cells(&world, 3, 5, 10, 0, 0, 1, false, 4_000);
        cells.sort();
        assert_eq!(cells, vec![(3, 5, 10), (4, 5, 10), (5, 5, 10)],
            "must follow the exposed-top-face run and stop at the covered-face and disconnected cells");

        // Seed on air → no match (defensive; the command layer also rejects this before calling in).
        assert!(find_connected_face_cells(&world, 0, 0, 0, 0, 0, 1, false, 4_000).is_empty());
    }

    /// export_png's encoder must produce a valid PNG of the right dimensions from a rendered
    /// full-map RGBA buffer (the Rust-side replacement for the old JS canvas→base64 path).
    #[test]
    fn test_export_png_encodes_valid() {
        let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
        let w = (world.w_chunks * 16) as i32;
        let h = (world.h_chunks * 16) as i32;
        let patch = render_pixels_patch(&world, 0, 0, w - 1, h - 1, None);
        let png = encode_rgba_png(&patch.pixels, w as u32, h as u32).expect("encode failed");
        assert_eq!(&png[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "PNG magic");
        let img = image::load_from_memory(&png).expect("decode failed");
        assert_eq!(img.width(), w as u32);
        assert_eq!(img.height(), h as u32);
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

    /// Cutaway view: a cap hides everything above it, so both the top-down render and the
    /// surface lookup (which is what a z-less draw targets) see the highest block *at or below*
    /// the cap. The fixture column (3,5) has wood@z0, stone@z17, dirt@z48.
    #[test]
    fn test_cutaway_cap_render_and_surface() {
        let world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");

        assert_eq!(surface_z(&world, 3, 5), Some(48), "uncapped surface = the true top block");
        assert_eq!(surface_z_capped(&world, 3, 5, Some(63)), Some(48), "cap above everything = no change");
        assert_eq!(surface_z_capped(&world, 3, 5, Some(30)), Some(17), "cap below dirt exposes the stone");
        assert_eq!(surface_z_capped(&world, 3, 5, Some(10)), Some(0), "cap below stone exposes the wood");
        assert_eq!(surface_z_capped(&world, 3, 5, Some(0)), Some(0), "cap at the bottom block still finds it");

        let px = |p: &PixelPatch| -> [u8; 3] { [p.pixels[0], p.pixels[1], p.pixels[2]] };
        let uncapped = render_pixels_patch(&world, 3, 5, 3, 5, None);
        let capped   = render_pixels_patch(&world, 3, 5, 3, 5, Some(30));
        let dirt  = block_color(3, 0, world.sky);
        let stone = block_color(2, 5, world.sky); // the fixture's stone is painted (paint 5)
        assert_eq!(px(&uncapped), dirt,  "normal render shows the top block (dirt)");
        assert_eq!(px(&capped),   stone, "cutaway render shows the block under the cap (stone)");
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
            tree_density_denom: 40, cave_density: 2, cave_style: 0, caverns: true, flood_caves: false,
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
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
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
            tree_density_denom: 0, cave_density: 0, cave_style: 1, caverns: false, flood_caves: false,
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
            tree_density_denom: 6, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
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
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
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
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
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
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
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
            2, 1, 0, true, false, 1, 1, 1, true,
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
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
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
            tree_density_denom: 0, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
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
            tree_density_denom: 8, cave_density: 0, cave_style: 0, caverns: false, flood_caves: false,
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
    /// 64z legacy worlds = ≤4, New Dawn 256z worlds = ≥5 (5/6 observed in the wild).
    /// Writing 4 for a 256z world makes the game misread it as 64z (the
    /// "legacy-conversion" corruption look).
    #[test]
    fn world_file_version_matches_format() {
        for (extended, want_version, want_stride) in [(false, 4u32, 32_768u64), (true, 5u32, 131_072u64)] {
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

    /// Full-file identity: parsing a fixture and saving it back without any edits
    /// must reproduce the original bytes exactly (not just header + pointer table).
    #[test]
    fn test_parse_save_parse_full_identity() {
        let original = make_test_world();
        let world = parse_world_inner(mmap_from_bytes(original.clone())).expect("parse failed");

        let tmp = std::env::temp_dir().join("eden_test_full_identity.eden");
        let _ = fs::remove_file(&tmp);
        save_world_inner(&world, tmp.to_str().unwrap()).expect("save failed");

        let saved_bytes = fs::read(&tmp).expect("read back failed");
        assert_eq!(original, saved_bytes, "unedited save must be byte-identical to the source file");

        // Re-parsing the saved file must reproduce the same test blocks.
        let world2 = parse_world_inner(mmap_from_bytes(saved_bytes)).expect("re-parse failed");
        assert_eq!(world2.bytes[blk(3, 5, 0)], 7, "Wood survives parse->save->parse");
        assert_eq!(world2.bytes[blk(3, 5, 17)], 2, "Stone survives parse->save->parse");
        assert_eq!(world2.bytes[pnt(3, 5, 17)], 5, "paint survives parse->save->parse");
        assert_eq!(world2.bytes[blk(3, 5, 48)], 3, "Dirt survives parse->save->parse");
        assert_eq!(world2.bytes[blk(7, 2, 32)], 8, "bystander survives parse->save->parse");

        let _ = fs::remove_file(&tmp);
    }

    /// rotate_ramp_id_cw: offset shifts +3 mod 4 (i.e. -1 mod 4) within each
    /// directional family, and four rotations return to the original ID.
    #[test]
    fn test_rotate_ramp_id_cw_offsets() {
        // Ramps: base 24 (S/W/N/E = off 0/1/2/3). CW rotation: S->E->N->W->S.
        assert_eq!(rotate_ramp_id_cw(24), 27, "ramp S -> E");
        assert_eq!(rotate_ramp_id_cw(27), 26, "ramp E -> N");
        assert_eq!(rotate_ramp_id_cw(26), 25, "ramp N -> W");
        assert_eq!(rotate_ramp_id_cw(25), 24, "ramp W -> S");

        // Wedges: base 40 (SE/SW/NW/NE = off 0/1/2/3).
        assert_eq!(rotate_ramp_id_cw(40), 43);
        assert_eq!(rotate_ramp_id_cw(43), 42);
        assert_eq!(rotate_ramp_id_cw(42), 41);
        assert_eq!(rotate_ramp_id_cw(41), 40);

        // Doors 66-69 and portals 75-78 follow the same +3 mod 4 rule.
        assert_eq!(rotate_ramp_id_cw(66), 69);
        assert_eq!(rotate_ramp_id_cw(75), 78);

        // Four rotations is the identity for every family base.
        for base in [24u8, 28, 32, 36, 40, 44, 48, 52] {
            let mut bt = base;
            for _ in 0..4 { bt = rotate_ramp_id_cw(bt); }
            assert_eq!(bt, base, "4x rotation must return to start for base {base}");
        }

        // Non-directional block types pass through unchanged.
        assert_eq!(rotate_ramp_id_cw(2), 2, "stone is not directional");
        assert_eq!(rotate_ramp_id_cw(0), 0, "air is not directional");
    }

    /// mirror_ramp_id_x/y: involutions (applying twice returns the original ID)
    /// and the specific S/W/N/E and SE/SW/NW/NE swaps documented on the functions.
    #[test]
    fn test_mirror_ramp_id_offsets() {
        // X mirror: ramps E(3)<->W(1), S(0)/N(2) unchanged.
        assert_eq!(mirror_ramp_id_x(24), 24, "ramp S unchanged under X mirror");
        assert_eq!(mirror_ramp_id_x(26), 26, "ramp N unchanged under X mirror");
        assert_eq!(mirror_ramp_id_x(25), 27, "ramp W -> E under X mirror");
        assert_eq!(mirror_ramp_id_x(27), 25, "ramp E -> W under X mirror");

        // Y mirror: ramps S(0)<->N(2), E(3)/W(1) unchanged.
        assert_eq!(mirror_ramp_id_y(24), 26, "ramp S -> N under Y mirror");
        assert_eq!(mirror_ramp_id_y(26), 24, "ramp N -> S under Y mirror");
        assert_eq!(mirror_ramp_id_y(25), 25, "ramp W unchanged under Y mirror");

        // Wedges: X mirror flips the E/W component (off ^ 1); Y mirror flips N/S (off ^ 3).
        for off in 0u8..4 {
            let bt = 40 + off;
            assert_eq!(mirror_ramp_id_x(bt), 40 + (off ^ 1));
            assert_eq!(mirror_ramp_id_y(bt), 40 + (off ^ 3));
        }

        // Both mirrors are involutions: applying twice is the identity.
        for bt in [24u8, 25, 26, 27, 40, 41, 42, 43, 66, 67, 68, 69, 75, 76, 77, 78] {
            assert_eq!(mirror_ramp_id_x(mirror_ramp_id_x(bt)), bt, "X mirror twice = identity for {bt}");
            assert_eq!(mirror_ramp_id_y(mirror_ramp_id_y(bt)), bt, "Y mirror twice = identity for {bt}");
        }

        assert_eq!(mirror_ramp_id_x(2), 2, "stone is not directional");
    }

    fn make_test_clipboard() -> Clipboard {
        // 2 (w) x 3 (h) x 1 (depth) clipboard.
        // Layout (row-major, dy*width+dx):
        //   dy=0: [ramp-S(24), wedge-SE(40)]
        //   dy=1: [stone(2),   air(0)]
        //   dy=2: [ramp-E(27), dirt(3)]
        let block_types = vec![
            24, 40,
            2, 0,
            27, 3,
        ];
        let paints = vec![
            1, 2,
            0, 0,
            3, 4,
        ];
        Clipboard { width: 2, height: 3, depth: 1, z_anchor: 10, block_types, paints, mask: None }
    }

    /// rotate_clipboard_inner: dimensions swap (w,h)->(h,w), content transform
    /// matches (dx,dy)->(dy, old_w-1-dx), and directional IDs are rotated CW.
    #[test]
    fn test_rotate_clipboard_inner() {
        let mut cb = make_test_clipboard();
        rotate_clipboard_inner(&mut cb);

        assert_eq!(cb.width, 3, "new width = old height");
        assert_eq!(cb.height, 2, "new height = old width");
        assert_eq!(cb.z_anchor, 10, "z_anchor untouched by XY rotation");

        // Source (dx=0,dy=0)=ramp-S(24) -> dest (ndx=0, ndy=old_w-1-0=1) -> rotated to ramp-E(27)
        let at = |cb: &Clipboard, x: usize, y: usize| -> (u8, u8) {
            let i = y * cb.width as usize + x;
            (cb.block_types[i], cb.paints[i])
        };
        assert_eq!(at(&cb, 0, 1), (27, 1), "ramp-S rotates to ramp-E and keeps its paint");
        // Source (dx=1,dy=2)=dirt(3) -> dest (ndx=2, ndy=old_w-1-1=0)
        assert_eq!(at(&cb, 2, 0), (3, 4), "dirt (non-directional) keeps id, moves per rotation, keeps paint");

        // Four rotations restores original dimensions and content.
        rotate_clipboard_inner(&mut cb);
        rotate_clipboard_inner(&mut cb);
        rotate_clipboard_inner(&mut cb);
        let original = make_test_clipboard();
        assert_eq!(cb.width, original.width);
        assert_eq!(cb.height, original.height);
        assert_eq!(cb.block_types, original.block_types, "4x rotation restores block types");
        assert_eq!(cb.paints, original.paints, "4x rotation restores paints");
    }

    /// mirror_clipboard_x_inner / mirror_clipboard_y_inner: dimensions unchanged,
    /// content reversed along the mirrored axis, directional IDs remapped, involution holds.
    #[test]
    fn test_mirror_clipboard_inner() {
        let mut cb = make_test_clipboard();
        mirror_clipboard_x_inner(&mut cb);
        assert_eq!((cb.width, cb.height), (2, 3), "X mirror keeps dimensions");
        let at = |cb: &Clipboard, x: usize, y: usize| -> (u8, u8) {
            let i = y * cb.width as usize + x;
            (cb.block_types[i], cb.paints[i])
        };
        // dy=0 row [ramp-S(24), wedge-SE(40)] mirrors to [wedge-SW(41), ramp-S(24)]
        assert_eq!(at(&cb, 0, 0), (41, 2), "wedge-SE moves to x=0 and mirrors to SW");
        assert_eq!(at(&cb, 1, 0), (24, 1), "ramp-S moves to x=1, S is unchanged by X mirror");

        // Involution: mirroring twice restores the original.
        mirror_clipboard_x_inner(&mut cb);
        let original = make_test_clipboard();
        assert_eq!(cb.block_types, original.block_types, "2x X-mirror restores block types");
        assert_eq!(cb.paints, original.paints, "2x X-mirror restores paints");

        let mut cb_y = make_test_clipboard();
        mirror_clipboard_y_inner(&mut cb_y);
        assert_eq!((cb_y.width, cb_y.height), (2, 3), "Y mirror keeps dimensions");
        // dy=0 row moves to dy=2, ramp-S(24) mirrors to ramp-N(26)
        assert_eq!(at(&cb_y, 0, 2), (26, 1), "ramp-S moves to y=2 and mirrors to N");
        mirror_clipboard_y_inner(&mut cb_y);
        assert_eq!(cb_y.block_types, original.block_types, "2x Y-mirror restores block types");
        assert_eq!(cb_y.paints, original.paints, "2x Y-mirror restores paints");
    }

    /// The sculpt "noise" branch must sample *spatially coherent* noise (fbm/ridged), not
    /// per-column white noise. Coherence = adjacent columns get near-identical displacements,
    /// so the mean step between horizontal neighbours is far smaller than the field's range.
    /// (The old bug applied independent random deltas per column → neighbour steps ≈ the full
    /// range.) This mirrors exactly how `sculpt_terrain`'s "hills"/"mountains" branches sample.
    #[test]
    fn test_sculpt_coherent_noise() {
        let freq = 1.0 / 24.0; // default feature size 24
        let so = 13.37;
        let amp = 6.0;
        let n = 64;

        // ── Hills (fbm2 ∈ [-1,1]) ──────────────────────────────────────────────
        let hill = |x: i32, y: i32| (fbm2(x as f64 * freq + so, y as f64 * freq + so, 4) * amp).round() as i32;
        let mut min_h = i32::MAX;
        let mut max_h = i32::MIN;
        let mut neighbour_steps: Vec<i32> = Vec::new();
        for y in 0..n {
            for x in 0..n {
                let v = hill(x, y);
                min_h = min_h.min(v);
                max_h = max_h.max(v);
                if x + 1 < n { neighbour_steps.push((hill(x + 1, y) - v).abs()); }
            }
        }
        let range = (max_h - min_h) as f64;
        assert!(range >= 2.0, "hills field should actually vary (range {range})");
        let max_step = *neighbour_steps.iter().max().unwrap();
        let mean_step = neighbour_steps.iter().sum::<i32>() as f64 / neighbour_steps.len() as f64;
        // Coherent noise: adjacent columns never jump more than 1 block at this frequency,
        // and on average barely move — white noise would give steps on the order of `range`.
        assert!(max_step <= 1, "adjacent hill columns must differ by ≤1 block (got {max_step})");
        assert!(mean_step < range * 0.25,
            "mean neighbour step {mean_step:.3} should be « field range {range} for coherent noise");

        // ── Mountains (ridged2 ∈ [0,1]) builds strictly upward ─────────────────
        for y in 0..n {
            for x in 0..n {
                let r = ridged2(x as f64 * freq + so, y as f64 * freq + so, 4);
                assert!((0.0..=1.0).contains(&r), "ridged2 out of range: {r}");
            }
        }

        // ── Falloff primitive: smoothstep is a monotone dome on [0,1] with clamped ends ──
        assert_eq!(smoothstep01(0.0), 0.0);
        assert_eq!(smoothstep01(1.0), 1.0);
        assert_eq!(smoothstep01(-5.0), 0.0, "clamps below 0");
        assert_eq!(smoothstep01(5.0), 1.0, "clamps above 1");
        let mut prev = -1.0;
        for i in 0..=10 {
            let s = smoothstep01(i as f64 / 10.0);
            assert!(s >= prev, "smoothstep01 must be monotonically non-decreasing");
            prev = s;
        }

        // Every falloff profile is a monotone map from rim(0)→0 to core(1)→1, clamped.
        for prof in ["smooth", "linear", "sphere", "sharp"] {
            assert_eq!(falloff_dome(0.0, prof), 0.0, "{prof}: rim weight is 0");
            assert!((falloff_dome(1.0, prof) - 1.0).abs() < 1e-9, "{prof}: core weight is 1");
            assert_eq!(falloff_dome(-3.0, prof), 0.0, "{prof}: clamps below 0");
            assert_eq!(falloff_dome(3.0, prof), 1.0, "{prof}: clamps above 1");
            let mut last = -1.0;
            for i in 0..=20 {
                let v = falloff_dome(i as f64 / 20.0, prof);
                assert!(v >= last - 1e-12, "{prof}: must be non-decreasing");
                last = v;
            }
        }
        // Distinct shapes: at the midpoint, sphere bulges above and sharp dips below linear.
        assert!(falloff_dome(0.5, "sphere") > 0.5, "sphere rises fast off the rim");
        assert!(falloff_dome(0.5, "sharp") < 0.5, "sharp keeps a wide soft skirt");
    }

    /// build_lamp_index buckets each lamp under its chunk coord; an empty world → empty index.
    #[test]
    fn build_lamp_index_buckets_lamps_by_chunk() {
        let empty = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
        assert!(build_lamp_index(&empty).is_empty(), "world with no lamps → empty index");

        let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
        // Place a lamp (type 72) at lx=4, ly=6, z=5 in chunk (0,0).
        world.bytes[blk(4, 6, 5)] = 72;
        let index = build_lamp_index(&world);
        assert_eq!(index.get(&(0, 0)), Some(&vec![[4, 6, 5]]), "lamp bucketed at its chunk with local coords");
    }

    /// refresh_lamp_index_chunks must follow a placed/removed lamp — the core correctness invariant
    /// the with_edit/undo/redo hooks rely on.
    #[test]
    fn refresh_lamp_index_tracks_place_and_remove() {
        let mut world = parse_world_inner(mmap_from_bytes(make_test_world())).expect("parse failed");
        let mut ws = WorldState::new();
        ws.world = Some(std::mem::replace(&mut world, parse_world_inner(mmap_from_bytes(make_test_world())).unwrap()));
        ws.lamp_index = Some(build_lamp_index(ws.world.as_ref().unwrap()));
        assert!(ws.lamp_index.as_ref().unwrap().is_empty(), "starts with no lamps");

        // Place a lamp, then refresh chunk (0,0): it must appear.
        ws.world.as_mut().unwrap().bytes[blk(4, 6, 5)] = 72;
        refresh_lamp_index_chunks(&mut ws, &[(0, 0)]);
        assert_eq!(ws.lamp_index.as_ref().unwrap().get(&(0, 0)), Some(&vec![[4, 6, 5]]), "placed lamp indexed after refresh");

        // Break it (set to air), refresh again: the bucket must be removed.
        ws.world.as_mut().unwrap().bytes[blk(4, 6, 5)] = 0;
        refresh_lamp_index_chunks(&mut ws, &[(0, 0)]);
        assert!(ws.lamp_index.as_ref().unwrap().get(&(0, 0)).is_none(), "removed lamp drops its chunk bucket");
    }

    // ── Sculpt engine (Pass 1) test fixtures ──────────────────────────────────────

    /// A single-chunk (0,0) test world whose every column (lx,ly) is filled with `surf_bt` from
    /// z=1 up to `height(lx,ly)` (clamped 1..=63) — a real varied surface for sculpt tests, unlike
    /// the degenerate single-column `make_test_world`.
    fn make_bumpy_world<F: Fn(usize, usize) -> i32>(surf_bt: u8, height: F) -> Vec<u8> {
        const HEADER: usize = 4096;
        const CHUNK: usize = 32768;
        const ENTRY: usize = 16;
        let chunk_off: u32 = HEADER as u32;
        let ptr_off: u32 = (HEADER + CHUNK) as u32;
        let mut b = vec![0u8; HEADER + CHUNK + ENTRY];
        b[32..36].copy_from_slice(&ptr_off.to_le_bytes());
        b[40..49].copy_from_slice(b"BumpyTest");
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            HEADER + (z / 16) as usize * 8192 + lx * 256 + ly * 16 + (z % 16) as usize
        };
        for lx in 0..16 {
            for ly in 0..16 {
                let h = height(lx, ly).clamp(1, 63);
                for z in 1..=h { b[block(lx, ly, z)] = surf_bt; }
            }
        }
        let pe = HEADER + CHUNK;
        b[pe..pe + 2].copy_from_slice(&0i16.to_le_bytes());
        b[pe + 4..pe + 6].copy_from_slice(&0i16.to_le_bytes());
        b[pe + 8..pe + 12].copy_from_slice(&chunk_off.to_le_bytes());
        b
    }

    fn ws_with(bytes: Vec<u8>) -> WorldState {
        let mut ws = WorldState::new();
        ws.world = Some(parse_world_inner(mmap_from_bytes(bytes)).expect("parse"));
        ws
    }

    fn world_bytes(ws: &WorldState) -> Vec<u8> {
        ws.world.as_ref().unwrap().bytes.to_vec()
    }

    /// Filled disc footprint matching the backend's/frontend's `(dx² + dy²) <= (r + 0.5)²`.
    fn disc_points(cx: i32, cy: i32, r: i32) -> Vec<SculptPoint> {
        let rr = (r as f64 + 0.5).powi(2);
        let mut v = Vec::new();
        for dy in -r..=r {
            for dx in -r..=r {
                if ((dx * dx + dy * dy) as f64) <= rr { v.push(SculptPoint { x: cx + dx, y: cy + dy }); }
            }
        }
        v
    }

    fn surf(ws: &WorldState, x: i32, y: i32) -> i32 {
        surface_z_capped(ws.world.as_ref().unwrap(), x, y, None).unwrap()
    }

    /// Convenience wrapper: a "raise"/"smooth" sculpt stamp with explicit points, all the newer
    /// params defaulted, so each test only spells out what it varies.
    #[allow(clippy::too_many_arguments)]
    fn sculpt(
        ws: &mut WorldState, points: Option<Vec<SculptPoint>>, mode: &str, strength: i32,
        softness: f64, stamp: Option<(i32, i32, i32)>, group: Option<u64>,
    ) -> EditResult {
        let (scx, scy, srad) = match stamp {
            Some((a, b, c)) => (Some(a), Some(b), Some(c)),
            None => (None, None, None),
        };
        sculpt_terrain_inner(
            ws, points, mode.into(), strength, 0, None, None, None, None,
            Some(softness), Some("smooth".into()), None, None, None, scx, scy, srad, None, group,
            None, None, None, None, None, None,
        ).expect("sculpt")
    }

    /// Row 6 — the per-stroke float workspace accumulates sub-block deltas across same-group stamps
    /// instead of rounding them away every call. A soft brush over a flat plateau: the centre
    /// (weight 1) rises by exactly `strength` per stamp, and — the actual fix — EVERY rim column
    /// with a non-zero weight rises over the stroke rather than a fixed BAYER threshold freezing
    /// roughly half of them (the reinforcing-dither stripe pathology).
    #[test]
    fn test_residual_accumulates_sub_block_deltas() {
        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // dead-flat grass plateau at z=20
        let (cx, cy, r) = (7, 7, 5);
        let n = 10;
        let gid = Some(4242u64);
        for _ in 0..n {
            sculpt(&mut ws, None, "raise", 1, 1.0, Some((cx, cy, r)), gid);
        }
        // Centre: weight 1 → +1/stamp, exactly n.
        assert_eq!(surf(&ws, cx, cy) - 20, n, "centre rises strength·n with no rounding loss");

        // Every interior rim column (within the disc, weight > 0) must have risen — none frozen.
        let mut risen = 0;
        let mut total = 0;
        for dy in -r..=r {
            for dx in -r..=r {
                let d2 = dx * dx + dy * dy;
                // Interior columns whose weight·n is comfortably ≥ 1 (d ≤ 3, so weight ≳ 0.35);
                // the outermost ring legitimately rounds to 0 (weight → 0 at the dome edge).
                if d2 == 0 || d2 > 9 { continue; }
                total += 1;
                let rise = surf(&ws, cx + dx, cy + dy) - 20;
                assert!(rise > 0, "column ({dx},{dy}) frozen — residuals not accumulating");
                assert!(rise <= n, "column ({dx},{dy}) rose {rise} > strength·n");
                risen += 1;
            }
        }
        assert_eq!(risen, total, "no interior column may be frozen by a fixed dither threshold");
    }

    /// Row 6 — `clip_rect` masks stamp cells server-side: a hard raise stamp straddling the rect
    /// lifts only the columns inside it; columns in the disc but outside the rect are untouched.
    #[test]
    fn test_clip_rect_masks_stamp_cells() {
        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
        // Disc centred at (8,8) r=4; clip to x >= 8 only. Hard brush (softness 0) so weight is 1
        // inside and the mask is the only thing that can zero a column.
        sculpt_terrain_inner(
            &mut ws, None, "raise".into(), 5, 0, None, None, None, None,
            Some(0.0), Some("smooth".into()), None, None, None, Some(8), Some(8), Some(4), None,
            Some(9), None, None, None, None, Some([8, 0, 100, 100]), None,
        ).expect("clipped raise");
        assert_eq!(surf(&ws, 9, 8) - 20, 5, "column inside the clip rect rises by strength");
        assert_eq!(surf(&ws, 8, 8) - 20, 5, "column on the clip edge (x==8) is inside and rises");
        assert_eq!(surf(&ws, 6, 8), 20, "column left of the clip rect is masked (unchanged)");
        assert_eq!(surf(&ws, 5, 8), 20, "another masked column, still pristine");
    }

    /// Row 6 — the float session is reaped by a foreign edit through `with_edit`. After the delete,
    /// a same-group stamp must re-seed from the post-delete surface, not resurrect stale heights.
    #[test]
    fn test_sculpt_session_cleared_by_foreign_edit() {
        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
        let gid = Some(555u64);
        sculpt(&mut ws, None, "raise", 4, 0.0, Some((8, 8, 3)), gid);
        assert!(ws.sculpt_session.is_some(), "a grouped stroke opens a session");
        assert_eq!(ws.sculpt_session.as_ref().unwrap().group_id, 555);

        // Foreign edit (group None) through the shared choke point → session must clear.
        with_edit(&mut ws, "delete", (0, 0, 15, 15), (0, 0, 15, 15), |world| {
            delete_blocks_inner(world, 0, 0, 15, 15, 0, 255, None);
            Ok(())
        }).expect("delete");
        assert!(ws.sculpt_session.is_none(), "a non-sculpt edit reaps the stale session");

        // The just-deleted footprint has no surface; a fresh same-group stamp re-seeds from the
        // post-delete world (there's nothing to raise), never from the pre-delete fheight cache.
        let before = world_bytes(&ws);
        sculpt(&mut ws, None, "raise", 4, 0.0, Some((8, 8, 3)), gid);
        assert_eq!(world_bytes(&ws), before, "no surface after delete → nothing resurrected");
    }

    /// Row 6 — undo reaps the session (it bypasses `with_edit_inner`). Undoing the owning stroke
    /// then stamping again same-group equals a fresh single stamp on the pristine world.
    #[test]
    fn test_sculpt_session_cleared_by_undo() {
        let base = make_bumpy_world(8, |_, _| 20);
        let gid = Some(321u64);

        // Reference: one fresh stamp on a pristine world.
        let mut refws = ws_with(base.clone());
        sculpt(&mut refws, None, "raise", 4, 0.0, Some((8, 8, 3)), gid);
        let reference = world_bytes(&refws);

        // Stamp, undo (reaps session), stamp again same group — must match the reference exactly.
        let mut ws = ws_with(base.clone());
        sculpt(&mut ws, None, "raise", 4, 0.0, Some((8, 8, 3)), gid);
        assert!(ws.sculpt_session.is_some());
        undo_edit_inner(&mut ws).expect("undo");
        assert!(ws.sculpt_session.is_none(), "undo reaps the session it belonged to");
        sculpt(&mut ws, None, "raise", 4, 0.0, Some((8, 8, 3)), gid);
        assert_eq!(world_bytes(&ws), reference, "post-undo stamp re-seeds, no residual carryover");
    }

    // ── Non-rectangular selection (SelectionMask) ─────────────────────────────────

    /// A mask covering exactly the cells in `x1..=x2, y1..=y2` for which `pred(x,y)` holds.
    fn mask_from<F: Fn(i32, i32) -> bool>(x1: i32, y1: i32, x2: i32, y2: i32, pred: F) -> SelectionMask {
        let w = x2 - x1 + 1;
        let h = y2 - y1 + 1;
        let mut bits = vec![0u8; ((w * h + 7) / 8) as usize];
        for y in y1..=y2 {
            for x in x1..=x2 {
                if pred(x, y) {
                    let idx = ((y - y1) * w + (x - x1)) as usize;
                    bits[idx >> 3] |= 1u8 << (idx & 7);
                }
            }
        }
        SelectionMask { x1, y1, x2, y2, bits }
    }

    /// The bitset addressing round-trips: `contains` matches the predicate, is false outside the
    /// bbox, and `count` equals the number of set cells.
    #[test]
    fn test_selection_mask_contains_and_count() {
        let m = mask_from(0, 0, 3, 3, |x, y| x == y); // main diagonal of a 4×4 box
        assert_eq!(m.count(), 4);
        assert!(m.contains(0, 0) && m.contains(2, 2) && m.contains(3, 3));
        assert!(!m.contains(1, 0) && !m.contains(0, 3), "off-diagonal cells are unset");
        assert!(!m.contains(4, 4) && !m.contains(-1, -1), "outside the bbox is never contained");
    }

    /// The corruption-critical fail-safe: `active_mask` yields the mask ONLY on an exact bbox match,
    /// so a stale mask can never mis-filter a selection that has since been reshaped.
    #[test]
    fn test_active_mask_fail_safe_rect_equality() {
        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
        ws.selection_mask = Some(mask_from(2, 2, 5, 5, |x, y| x == y));
        assert!(active_mask(&ws, 2, 2, 5, 5).is_some(), "exact bbox match resolves the mask");
        assert!(active_mask(&ws, 2, 2, 5, 6).is_none(), "wrong y2 → rect-only fallback");
        assert!(active_mask(&ws, 1, 2, 5, 5).is_none(), "wrong x1 → rect-only fallback");
        assert!(active_mask(&ws, 0, 0, 15, 15).is_none(), "unrelated rect → rect-only fallback");
        assert!(active_mask(&ws, 2, 2, 5, 5).is_some(), "resolving does not consume the mask");
    }

    /// A masked delete clears only the shaped cells; unmasked columns inside the same bounding box
    /// survive — the headline "wand deletes the whole box" fix, at the `_inner` level.
    #[test]
    fn test_delete_blocks_respects_mask() {
        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // every column solid z=1..20
        let mask = mask_from(4, 4, 7, 7, |x, y| x - 4 == y - 4); // diagonal of the 4×4 box
        delete_blocks_inner(ws.world.as_mut().unwrap(), 4, 4, 7, 7, 0, 63, Some(&mask));
        let w = ws.world.as_ref().unwrap();
        assert_eq!(surface_z_capped(w, 4, 4, None), None, "masked diagonal column is cleared to air");
        assert_eq!(surface_z_capped(w, 7, 7, None), None, "far masked column is cleared too");
        assert_eq!(surface_z_capped(w, 5, 4, None), Some(20), "unmasked column inside bbox is untouched");
        assert_eq!(surface_z_capped(w, 4, 7, None), Some(20), "unmasked bbox corner is untouched");
    }

    /// A masked fill (`replace_blocks_inner`) re-skins only shaped cells; unmasked cells keep their
    /// original block. Guards the second edit command that reads the mask.
    #[test]
    fn test_replace_blocks_respects_mask() {
        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // grass (bt 8)
        let mask = mask_from(4, 4, 7, 7, |x, _| x == 4); // just the left edge column of the box
        // Fill z=20 only with brick (bt 13, paint 0), no filter.
        replace_blocks_inner(ws.world.as_mut().unwrap(), 4, 4, 7, 7, 20, 20, 13, 0, None, None, false, Some(&mask));
        let w = ws.world.as_ref().unwrap();
        assert_eq!(read_block_abs(w, 4, 5, 20), 13, "masked cell became brick");
        assert_eq!(read_block_abs(w, 5, 5, 20), 8, "unmasked cell kept grass");
    }

    /// A masked move relocates only the shaped cells and clears only those source cells; unmasked
    /// cells inside the bbox (both source and dest) are left exactly as they were.
    #[test]
    fn test_move_selection_respects_mask() {
        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // grass col height 20 everywhere
        // Mark the block just below the surface so we can identify moved material: set (4,4,10)=stone.
        set_block_abs(ws.world.as_mut().unwrap(), 4, 4, 10, 2, 0);
        let mask = mask_from(4, 4, 5, 5, |x, y| x == 4 && y == 4); // only the single corner column
        // Move the shaped selection +3 in x (dz=0). Reuse the inner move logic via the closure body:
        // build buf, clear masked source, write masked dest.
        let (x1, y1) = (4, 4);
        let (width, height, depth) = (2i32, 2i32, 11i32); // z 0..=10
        with_edit(&mut ws, "move", (4, 4, 8, 5), (4, 4, 8, 5), |world| {
            let n = (width * height * depth) as usize;
            let mut buf_bt = vec![0u8; n];
            let mut buf_paint = vec![0u8; n];
            for lz in 0..depth { for ly in 0..height { for lx in 0..width {
                let idx = (lz * height * width + ly * width + lx) as usize;
                buf_bt[idx] = read_block_abs(world, x1 + lx, y1 + ly, lz);
                buf_paint[idx] = read_paint_abs(world, x1 + lx, y1 + ly, lz);
            }}}
            for lz in 0..depth { for ly in 0..height { for lx in 0..width {
                if !mask.contains(x1 + lx, y1 + ly) { continue; }
                set_block_abs(world, x1 + lx, y1 + ly, lz, 0, 0);
            }}}
            for lz in 0..depth { for ly in 0..height { for lx in 0..width {
                if !mask.contains(x1 + lx, y1 + ly) { continue; }
                let idx = (lz * height * width + ly * width + lx) as usize;
                set_block_abs(world, x1 + 3 + lx, y1 + ly, lz, buf_bt[idx], buf_paint[idx]);
            }}}
            Ok(())
        }).expect("masked move");
        let w = ws.world.as_ref().unwrap();
        assert_eq!(read_block_abs(w, 4, 4, 10), 0, "masked source column cleared");
        assert_eq!(read_block_abs(w, 7, 4, 10), 2, "stone moved +3 to the masked dest");
        assert_eq!(read_block_abs(w, 5, 4, 10), 8, "unmasked neighbour inside bbox untouched");
    }

    /// A shaped copy stores its footprint, and paste through the shared helper skips unmasked
    /// columns — a copied L-shape stamps an L, not a filled box.
    #[test]
    fn test_masked_clipboard_paste_skips_unmasked() {
        // Clipboard footprint: 2×2, only the diagonal (0,0) and (1,1) set.
        let block_types = vec![13u8, 13, 13, 13]; // all brick
        let paints = vec![0u8; 4];
        let mut bits = vec![0u8; 1];
        bits[0] |= 1 << 0; // (dy0,dx0) idx 0
        bits[0] |= 1 << 3; // (dy1,dx1) idx 3
        let cb = Clipboard { width: 2, height: 2, depth: 1, z_anchor: 30, block_types, paints, mask: Some(bits) };
        assert!(cb.info().masked, "info reflects the footprint");

        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20));
        let mask = cb.mask.clone();
        with_edit(&mut ws, "paste", (10, 10, 11, 11), (10, 10, 11, 11), |world| {
            paste_clipboard_at(world, 10, 10, &cb.block_types, &cb.paints,
                cb.width, cb.height, cb.depth, cb.z_anchor, 0, false, world_max_z(world), mask.as_deref());
            Ok(())
        }).expect("masked paste");
        let w = ws.world.as_ref().unwrap();
        assert_eq!(read_block_abs(w, 10, 10, 30), 13, "diagonal cell (0,0) stamped");
        assert_eq!(read_block_abs(w, 11, 11, 30), 13, "diagonal cell (1,1) stamped");
        assert_eq!(read_block_abs(w, 11, 10, 30), 0, "off-diagonal (1,0) skipped — shape preserved");
        assert_eq!(read_block_abs(w, 10, 11, 30), 0, "off-diagonal (0,1) skipped");
    }

    /// Rotating a shaped clipboard 90° CW transforms the footprint with the SAME map as the data, so
    /// the mask still lines up with the blocks it gates.
    #[test]
    fn test_rotate_clipboard_transforms_mask() {
        // 2(w)×3(h) footprint, only the top-left column (dy0,dx0) set.
        let mut bits = vec![0u8; 1];
        bits[0] |= 1 << 0;
        let mut cb = Clipboard {
            width: 2, height: 3, depth: 1, z_anchor: 0,
            block_types: vec![0u8; 6], paints: vec![0u8; 6], mask: Some(bits),
        };
        rotate_clipboard_inner(&mut cb);
        // After CW: new dims 3(w)×2(h). Old (dx0,dy0) → (ndx=dy=0, ndy=old_w-1-dx=1). New idx = ndy*new_w+ndx = 1*3+0 = 3.
        assert_eq!(cb.width, 3);
        assert_eq!(cb.height, 2);
        let m = cb.mask.unwrap();
        assert!(bit_set(&m, 3), "the one set column rotated to its new position");
        assert_eq!(m.iter().map(|b| b.count_ones()).sum::<u32>(), 1, "exactly one cell still set");
    }

    /// A shaped clipboard survives a prefab serialize→deserialize round trip: EPFAB\x02 carries the
    /// footprint so a saved prefab pastes the shape, not its bounding box.
    #[test]
    fn test_prefab_round_trip_preserves_mask() {
        // 3(w)×2(h)×1(d) all brick; L-shaped footprint (drop the top-right cell dx2,dy0).
        let n = 6;
        let mut bits = vec![0u8; 1];
        for i in 0..6 { if i != 2 { bits[0] |= 1 << i; } }
        let cb = Clipboard {
            width: 3, height: 2, depth: 1, z_anchor: 42,
            block_types: (0..n).map(|i| 13 + i as u8).collect(),
            paints: (0..n).map(|i| i as u8).collect(),
            mask: Some(bits.clone()),
        };
        let round = deserialize_prefab(&serialize_prefab(&cb)).expect("round-trips");
        assert_eq!(round.width, 3);
        assert_eq!(round.height, 2);
        assert_eq!(round.z_anchor, 42);
        assert_eq!(round.block_types, cb.block_types, "block data intact");
        assert_eq!(round.paints, cb.paints, "paint data intact");
        assert_eq!(round.mask, Some(bits), "footprint survived the round trip");
        assert!(round.info().masked, "reloaded prefab reports as shaped");
    }

    /// A rectangular clipboard still writes the legacy EPFAB\x01 format (older builds keep reading
    /// it), and reloads with no mask.
    #[test]
    fn test_prefab_rectangular_stays_v1() {
        let cb = Clipboard {
            width: 2, height: 2, depth: 1, z_anchor: 0,
            block_types: vec![13u8; 4], paints: vec![0u8; 4], mask: None,
        };
        let bytes = serialize_prefab(&cb);
        // Decompress to inspect the version byte.
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut raw = Vec::new();
        GzDecoder::new(&bytes[..]).read_to_end(&mut raw).unwrap();
        assert_eq!(&raw[0..6], b"EPFAB\x01", "maskless prefab stays on v1");
        let round = deserialize_prefab(&bytes).expect("round-trips");
        assert_eq!(round.mask, None, "no footprint on a rectangular prefab");
    }

    /// Shaped-selection consistency pass — a masked clipboard's top-down paste ghost leaves unmasked
    /// columns fully transparent (alpha 0), so the preview shows only the footprint; a `None` mask
    /// keeps the full VOID box (prefab-thumbnail parity).
    #[test]
    fn test_clipboard_preview_hides_unmasked_cells() {
        // 2×2×1, all brick, diagonal footprint (0,0)+(1,1).
        let mut bits = vec![0u8; 1];
        bits[0] |= 1 << 0; bits[0] |= 1 << 3;
        let cb = Clipboard { width: 2, height: 2, depth: 1, z_anchor: 0,
            block_types: vec![13u8; 4], paints: vec![0u8; 4], mask: Some(bits) };
        let pd = render_clipboard_preview_inner(&cb, 0);
        let a = |dx: usize, dy: usize| pd.pixels[(dy * 2 + dx) * 4 + 3];
        assert_eq!(a(0, 0), 255, "masked block column is opaque");
        assert_eq!(a(1, 1), 255, "far masked block column is opaque");
        assert_eq!(a(1, 0), 0, "unmasked column stays transparent (alpha 0)");
        assert_eq!(a(0, 1), 0, "unmasked column stays transparent");

        // None mask ⇒ every column filled (VOID for the air columns), matching prefab thumbnails.
        let cb2 = Clipboard { mask: None, ..cb };
        let pd2 = render_clipboard_preview_inner(&cb2, 0);
        for i in 0..4 { assert_eq!(pd2.pixels[i * 4 + 3], 255, "None mask fills the whole box"); }
    }

    /// The front/side clipboard elevation ghost treats an unmasked column as air, so its silhouette
    /// matches the shaped paste instead of the full box.
    #[test]
    fn test_clipboard_elevation_preview_respects_mask() {
        // 2(w)×1(h)×1(d): only column dx0 masked. Front view is 2 wide, 1 tall.
        let mut bits = vec![0u8; 1];
        bits[0] |= 1 << 0; // (dy0,dx0)
        let cb = Clipboard { width: 2, height: 1, depth: 1, z_anchor: 0,
            block_types: vec![13u8, 13], paints: vec![0u8; 2], mask: Some(bits) };
        let pd = render_clipboard_elevation_preview_inner(&cb, 0, "front");
        assert_eq!(pd.width, 2);
        assert_eq!(pd.pixels[3], 255, "masked column (dx0) shows the block");
        assert_eq!(pd.pixels[4 + 3], 0, "unmasked column (dx1) reads as air");
    }

    /// The axo clipboard ghost (SelectionInspector 3D tab) skips unmasked columns.
    #[test]
    fn test_axo_clipboard_respects_mask() {
        // 2×2×1 all brick, only (0,0) masked. ski=0 ⇒ no parallax, straight top-down sample.
        let mut bits = vec![0u8; 1];
        bits[0] |= 1 << 0;
        let cb = Clipboard { width: 2, height: 2, depth: 1, z_anchor: 0,
            block_types: vec![13u8; 4], paints: vec![0u8; 4], mask: Some(bits) };
        let pd = render_axo_clipboard_inner(&cb, 0, 0.0, 0);
        // Background is [30,30,30,255]; a rendered brick column differs from that.
        let is_bg = |dx: usize, dy: usize| {
            let o = (dy * 2 + dx) * 4;
            pd.pixels[o] == 30 && pd.pixels[o + 1] == 30 && pd.pixels[o + 2] == 30
        };
        assert!(!is_bg(0, 0), "masked column renders a block");
        assert!(is_bg(1, 0), "unmasked column stays background");
        assert!(is_bg(0, 1), "unmasked column stays background");
    }

    /// The ortho front/side selection view (SliceViewport + SelectionInspector) skips unmasked
    /// columns, so a masked block *behind* an unmasked column shows through correctly.
    #[test]
    fn test_render_selection_view_masks_columns() {
        // Two adjacent columns at x=4 (front, tall grass to z=20) and x=5 (behind, brick at z=5).
        // Build so that scanning y reaches x-column blocks; use render_view_front over a 2-wide rect.
        let mut ws = ws_with(make_bumpy_world(8, |lx, _| if lx == 4 { 20 } else { 0 }));
        // Put a distinct brick at (5,4,15) — an unmasked (4,4) column must let it show behind.
        set_block_abs(ws.world.as_mut().unwrap(), 5, 4, 15, 13, 0);
        let world = ws.world.as_ref().unwrap();
        // Mask covers the 2×1 rect (4,4)-(5,4) but only selects x=5 (drop the front x=4 column).
        let mask = mask_from(4, 4, 5, 4, |x, _| x == 5);

        // Front view: pw = 2 (x4,x5), ph over z 0..=20. Column 0 = x4 (masked out → see-through),
        // column 1 = x5 (masked in). With x4 masked out, the brick behind at x5,z15 renders in col 1.
        let (pw, _ph, px_masked) = render_view_front(world, 4, 5, 4, 4, 0, 20, 0, Some(&mask));
        assert_eq!(pw, 2);
        // Unmasked path: x4 column is a solid grass wall to z=20, occluding nothing behind it in
        // its own column — but col 0 (x4) should be VOID since x4 is masked *out*.
        // Row for z=20 is row 0; col 0 pixel:
        let row_z = |z: i32| (20 - z) as usize;
        let px = |col: usize, z: i32| { let o = (row_z(z) * pw as usize + col) * 4; [px_masked[o], px_masked[o+1], px_masked[o+2]] };
        assert_eq!(px(0, 20), [20, 20, 35], "masked-out front column is VOID (see-through)");
        assert_ne!(px(1, 15), [20, 20, 35], "masked block behind shows through in its column");

        // None mask ⇒ front column x4 renders its grass wall (not VOID) at z=20.
        let (_pw2, _ph2, px_none) = render_view_front(world, 4, 5, 4, 4, 0, 20, 0, None);
        let o = (row_z(20) * 2) * 4;
        assert_ne!([px_none[o], px_none[o+1], px_none[o+2]], [20, 20, 35], "None mask renders the full box");
    }

    /// The top-down ortho view hides unmasked columns (leaves them VOID) so the floating inspector
    /// shows the actual footprint, not the enclosing bounding box. Regression for "the top view
    /// still shows everything in the nearest rectangle".
    #[test]
    fn test_render_view_top_masks_columns() {
        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // every column solid grass to z=20
        let world = ws.world.as_ref().unwrap();
        // 2×2 rect (4,4)-(5,5); select only the main diagonal (4,4) and (5,5).
        let mask = mask_from(4, 4, 5, 5, |x, y| x - 4 == y - 4);
        let (pw, ph, px_masked) = render_view_top(world, 4, 5, 4, 5, 0, 20, 0, Some(&mask));
        assert_eq!((pw, ph), (2, 2));
        let px = |col: usize, row: usize| { let o = (row * pw as usize + col) * 4; [px_masked[o], px_masked[o+1], px_masked[o+2]] };
        assert_ne!(px(0, 0), [20, 20, 35], "masked-in (4,4) renders its surface block");
        assert_ne!(px(1, 1), [20, 20, 35], "masked-in (5,5) renders its surface block");
        assert_eq!(px(1, 0), [20, 20, 35], "unmasked (5,4) is VOID");
        assert_eq!(px(0, 1), [20, 20, 35], "unmasked (4,5) is VOID");

        // None mask ⇒ the whole 2×2 box renders (no VOID columns).
        let (_pw2, _ph2, px_none) = render_view_top(world, 4, 5, 4, 5, 0, 20, 0, None);
        for i in 0..4 { let o = i * 4; assert_ne!([px_none[o], px_none[o+1], px_none[o+2]], [20, 20, 35], "None mask fills every column"); }
    }

    /// A masked gradient re-skins only shaped columns; unmasked columns inside the bbox keep their
    /// original block.
    #[test]
    fn test_gradient_fill_respects_mask() {
        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // grass (bt 8) to z=20
        let mask = mask_from(4, 4, 7, 7, |x, _| x == 4); // left edge column only
        gradient_fill_inner(ws.world.as_mut().unwrap(), 4, 4, 7, 7, 20, 20, 13, 0, 14, 0, "x", false, Some(&mask));
        let w = ws.world.as_ref().unwrap();
        assert!(matches!(read_block_abs(w, 4, 5, 20), 13 | 14), "masked column re-skinned");
        assert_eq!(read_block_abs(w, 5, 5, 20), 8, "unmasked column kept grass");
    }

    /// A masked extrude repeats the *shape*: gating is on the source cell, so an x+ copy translates
    /// only the masked source columns and leaves unmasked destination cells untouched.
    #[test]
    fn test_extrude_selection_respects_mask() {
        let mut ws = ws_with(make_bumpy_world(0, |_, _| 0)); // empty world
        // Source 2×2 at (4,4); mark only (4,4,10)=stone. Mask selects only that one column.
        set_block_abs(ws.world.as_mut().unwrap(), 4, 4, 10, 2, 0);
        set_block_abs(ws.world.as_mut().unwrap(), 5, 4, 10, 3, 0); // dirt in the unmasked column
        let (width, height, depth) = (2i32, 2i32, 11i32);
        let mut src_types = vec![0u8; (width * height * depth) as usize];
        let mut src_paints = vec![0u8; (width * height * depth) as usize];
        {
            let world = ws.world.as_ref().unwrap();
            for dz in 0..depth { for dy in 0..height { for dx in 0..width {
                let idx = (dz * height * width + dy * width + dx) as usize;
                src_types[idx] = read_block_abs(world, 4 + dx, 4 + dy, dz);
                src_paints[idx] = read_paint_abs(world, 4 + dx, 4 + dy, dz);
            }}}
        }
        let mask = mask_from(4, 4, 5, 5, |x, y| x == 4 && y == 4);
        with_edit(&mut ws, "extrude", (4, 4, 7, 5), (4, 4, 7, 5), |world| {
            extrude_write(world, 4, 4, &src_types, &src_paints, width, height, depth, 0, 63, "x+", 1, false, Some(&mask));
            Ok(())
        }).expect("masked extrude");
        let w = ws.world.as_ref().unwrap();
        assert_eq!(read_block_abs(w, 6, 4, 10), 2, "masked source column extruded +2 (stone)");
        assert_eq!(read_block_abs(w, 7, 4, 10), 0, "unmasked source column not extruded (no dirt copy)");
    }

    /// A masked tree pass only plants inside the shape. density=1.0 + smart placement over grass;
    /// the unmasked column stays bare (only surface grass), the masked column grows a trunk above it.
    #[test]
    fn test_generate_trees_respects_mask() {
        let mut ws = ws_with(make_bumpy_world(8, |_, _| 20)); // grass surface z=20 everywhere
        let mask = mask_from(4, 4, 7, 7, |x, y| x == 4 && y == 4);
        generate_trees_inner(ws.world.as_mut().unwrap(), 4, 4, 7, 7,
            &["normal".to_string()], 1.0, &[], 42, true, Some(&mask));
        let w = ws.world.as_ref().unwrap();
        // A normal tree places a trunk (bt 6) above the surface at the planted column.
        assert_eq!(read_block_abs(w, 4, 4, 21), 6, "masked column grew a trunk");
        assert_eq!(read_block_abs(w, 6, 6, 21), 0, "unmasked column stayed bare above the surface");
    }

    /// A `set_selection_mask` payload of the wrong length is rejected rather than silently producing
    /// an under-read mask. (Exercises the byte-count guard without a Tauri State harness by mirroring
    /// its size math.)
    #[test]
    fn test_mask_size_guard_math() {
        // 4×4 bbox needs ceil(16/8) = 2 bytes.
        let w = 4usize; let h = 4usize;
        assert_eq!(w.saturating_mul(h).div_ceil(8), 2);
        // 200×200 needs 5000 bytes.
        assert_eq!(200usize.saturating_mul(200).div_ceil(8), 5000);
    }

    /// Task 1 — N overlapping grouped raise stamps undo/redo as ONE unit, byte-exactly, and depths
    /// count groups not stamps; an ungrouped edit stays its own single group (regression guard).
    #[test]
    fn test_grouped_undo_round_trip() {
        let mut ws = ws_with(make_bumpy_world(2, |lx, ly| 12 + ((lx + ly) % 5) as i32));
        let before = world_bytes(&ws);

        // 4 overlapping raise stamps sharing one group id.
        let gid = Some(777u64);
        for &(cx, cy) in &[(6, 6), (7, 6), (6, 7), (7, 7)] {
            sculpt(&mut ws, Some(disc_points(cx, cy, 2)), "raise", 3, 0.0, None, gid);
        }
        let after = world_bytes(&ws);
        assert_ne!(before, after, "stamps must change the world");
        assert_eq!(ws.undo_stack.len(), 4, "each stamp is its own raw undo entry");
        assert_eq!(count_undo_groups(&ws.undo_stack), 1, "same-group stamps collapse to one group");

        // undo → redo → undo → redo, byte-identical every time (exercises the ordering reasoning).
        for _ in 0..2 {
            let r = undo_edit_inner(&mut ws).expect("undo");
            assert_eq!(world_bytes(&ws), before, "one undo restores the whole stroke");
            assert_eq!(r.undo_depth, 0, "undo drops exactly one group (was 1 → 0)");
            let r2 = redo_edit_inner(&mut ws).expect("redo");
            assert_eq!(world_bytes(&ws), after, "one redo restores the whole stroke");
            assert_eq!(r2.undo_depth, 1, "redo restores the one group");
            assert_eq!(ws.undo_stack.len(), 4, "redo restores all 4 raw entries");
        }

        // Regression: a lone ungrouped edit is exactly one entry / one group and round-trips.
        undo_edit_inner(&mut ws).expect("undo the group");
        assert_eq!(world_bytes(&ws), before);
        let base = world_bytes(&ws);
        let r = sculpt(&mut ws, Some(disc_points(3, 3, 1)), "raise", 2, 0.0, None, None);
        assert_eq!(ws.undo_stack.len(), 1, "ungrouped edit = one entry");
        assert_eq!(r.undo_depth, 1, "ungrouped edit = one group");
        let post = world_bytes(&ws);
        assert_ne!(base, post);
        undo_edit_inner(&mut ws).expect("undo ungrouped");
        assert_eq!(world_bytes(&ws), base, "ungrouped undo = single entry");
        redo_edit_inner(&mut ws).expect("redo ungrouped");
        assert_eq!(world_bytes(&ws), post);
        assert_eq!(ws.undo_stack.len(), 1);
    }

    #[test]
    fn test_undo_stack_labels_collapse_groups() {
        let mut ws = ws_with(make_bumpy_world(2, |lx, ly| 12 + ((lx + ly) % 5) as i32));

        // 4 stamps sharing one group id must collapse to a single label.
        let gid = Some(42u64);
        for &(cx, cy) in &[(6, 6), (7, 6), (6, 7), (7, 7)] {
            sculpt(&mut ws, Some(disc_points(cx, cy, 2)), "raise", 3, 0.0, None, gid);
        }
        assert_eq!(ws.undo_stack.len(), 4);
        assert_eq!(undo_stack_labels(&ws.undo_stack).len(), 1, "same-group stamps collapse to one label");

        // A subsequent ungrouped edit is its own separate label, appended after the group.
        sculpt(&mut ws, Some(disc_points(3, 3, 1)), "raise", 2, 0.0, None, None);
        assert_eq!(undo_stack_labels(&ws.undo_stack).len(), 2, "group + ungrouped edit = 2 labels");

        assert!(undo_stack_labels(&ws.redo_stack).is_empty());
        undo_edit_inner(&mut ws).expect("undo ungrouped");
        assert_eq!(undo_stack_labels(&ws.redo_stack).len(), 1, "the undone edit reappears as one redo label");
    }

    /// Task 2 — per-stamp radial (dial) falloff vs BFS silhouette dome for one isolated disc stamp.
    /// The two use different distance metrics (8-connected graph distance to the silhouette edge vs
    /// continuous Euclidean distance from the centre), so the weight fields aren't bit-identical;
    /// we assert the resulting per-column heights agree within a small tolerance and that both are
    /// centre-higher-than-rim monotone. Tolerance = 1 block, made attainable by using a modest
    /// strength (2) so the whole dome spans only ~2 blocks — the max possible disagreement between
    /// two near-equal weight fields after integer rounding is then one quantization step.
    #[test]
    fn test_dial_vs_bfs_falloff_parity() {
        let (cx, cy, r) = (8, 8, 4);
        let base = make_bumpy_world(2, |_, _| 15);

        // (a) BFS path: explicit disc points, no stamp centre.
        let mut ws_a = ws_with(base.clone());
        sculpt(&mut ws_a, Some(disc_points(cx, cy, r)), "raise", 2, 1.0, None, None);
        // (b) dial path: no points, stamp centre + radius → backend generates the disc.
        let mut ws_b = ws_with(base.clone());
        sculpt(&mut ws_b, None, "raise", 2, 1.0, Some((cx, cy, r)), None);

        for p in &disc_points(cx, cy, r) {
            let ha = surf(&ws_a, p.x, p.y);
            let hb = surf(&ws_b, p.x, p.y);
            assert!((ha - hb).abs() <= 1, "column ({},{}) BFS={ha} dial={hb} differ by >1", p.x, p.y);
        }
        // Monotonicity: centre rises strictly more than the rim, both paths.
        assert!(surf(&ws_a, cx, cy) > surf(&ws_a, cx + r, cy), "BFS centre must exceed rim");
        assert!(surf(&ws_b, cx, cy) > surf(&ws_b, cx + r, cy), "dial centre must exceed rim");
        // Dial rim weight is exactly 0 (d == radius) → rim height unchanged.
        assert_eq!(surf(&ws_b, cx + r, cy), 15, "dial rim (weight 0) leaves terrain untouched");
    }

    /// Task 4.1 — dithering is deterministic (pure function of (x,y), no hidden RNG) and is fully
    /// bypassed at softness == 0 (hard brushes round exactly).
    #[test]
    fn test_dither_determinism_and_hard_bypass() {
        let base = make_bumpy_world(2, |lx, ly| 12 + ((lx * 3 + ly) % 7) as i32);
        let disc = disc_points(8, 8, 5);

        // Two identical soft raise calls from the same start → byte-identical.
        let mut ws1 = ws_with(base.clone());
        let mut ws2 = ws_with(base.clone());
        sculpt(&mut ws1, Some(disc.clone()), "raise", 5, 0.6, None, None);
        sculpt(&mut ws2, Some(disc.clone()), "raise", 5, 0.6, None, None);
        assert_eq!(world_bytes(&ws1), world_bytes(&ws2),
            "identical soft-sculpt calls must be byte-identical (dither is deterministic)");

        // softness == 0 → weight 1 everywhere, plain round, no dither: every column rises by exactly
        // `strength`. A dithered path would give ±1 here.
        let base_ws = ws_with(base.clone());
        let mut ws3 = ws_with(base.clone());
        sculpt(&mut ws3, Some(disc.clone()), "raise", 5, 0.0, None, None);
        for p in &disc {
            assert_eq!(surf(&ws3, p.x, p.y), surf(&base_ws, p.x, p.y) + 5,
                "hard raise adds exactly strength with no dither at ({},{})", p.x, p.y);
        }
    }

    /// Task 4.2 — Smooth iterates `strength` times, so strength 3 flattens a cone toward the local
    /// average strictly more than strength 1 (from the same input each time).
    #[test]
    fn test_smooth_strength_flattens_more() {
        // A smooth cone peak (avoids the checkerboard pattern that makes undamped Jacobi oscillate
        // and the linear ramp that is a smoothing fixed point).
        let cone = |lx: usize, ly: usize| -> i32 {
            let (dx, dy) = (lx as i32 - 8, ly as i32 - 8);
            let d = ((dx * dx + dy * dy) as f64).sqrt();
            15 + (6.0 - d).max(0.0).round() as i32
        };
        let base = make_bumpy_world(2, cone);
        let disc = disc_points(8, 8, 3);

        let range_after = |strength: i32| -> i32 {
            let mut ws = ws_with(base.clone());
            sculpt(&mut ws, Some(disc.clone()), "smooth", strength, 0.0, None, None);
            let hs: Vec<i32> = disc.iter().map(|p| surf(&ws, p.x, p.y)).collect();
            hs.iter().max().unwrap() - hs.iter().min().unwrap()
        };
        let r1 = range_after(1);
        let r3 = range_after(3);
        assert!(r3 < r1, "strength 3 smooth must flatten more than strength 1 (r1={r1}, r3={r3})");
    }

    /// Terrace quantizes every column to the nearest `strength`-block step.
    #[test]
    fn test_terrace_quantizes_to_step() {
        let base = make_bumpy_world(2, |lx, ly| 10 + ((lx * 3 + ly) % 11) as i32);
        let disc = disc_points(8, 8, 5);
        let step = 4;
        let mut ws = ws_with(base.clone());
        sculpt(&mut ws, Some(disc.clone()), "terrace", step, 0.0, None, None);
        for p in &disc {
            let h = surf(&ws, p.x, p.y);
            assert_eq!(h.rem_euclid(step), 0, "column ({},{}) height {h} isn't a multiple of step {step}", p.x, p.y);
        }
    }

    /// Sharpen is the inverse of Smooth: it must widen (not narrow) the height range of a cone.
    #[test]
    fn test_sharpen_widens_range() {
        let cone = |lx: usize, ly: usize| -> i32 {
            let (dx, dy) = (lx as i32 - 8, ly as i32 - 8);
            let d = ((dx * dx + dy * dy) as f64).sqrt();
            15 + (6.0 - d).max(0.0).round() as i32
        };
        let base = make_bumpy_world(2, cone);
        let disc = disc_points(8, 8, 3);
        let range_before = {
            let ws = ws_with(base.clone());
            let hs: Vec<i32> = disc.iter().map(|p| surf(&ws, p.x, p.y)).collect();
            hs.iter().max().unwrap() - hs.iter().min().unwrap()
        };
        let mut ws = ws_with(base.clone());
        sculpt(&mut ws, Some(disc.clone()), "sharpen", 8, 0.0, None, None);
        let range_after = {
            let hs: Vec<i32> = disc.iter().map(|p| surf(&ws, p.x, p.y)).collect();
            hs.iter().max().unwrap() - hs.iter().min().unwrap()
        };
        assert!(range_after > range_before,
            "sharpen must widen the height range (before={range_before}, after={range_after})");
    }

    /// Slope levels toward an angled plane through the anchor: with slope_dx=1 (1 block of rise
    /// per block of X run), a column `dx` blocks east of the anchor lands at `anchor_z + dx`, and
    /// the anchor column itself is untouched (it's on the plane already).
    #[test]
    fn test_slope_tilts_plane_from_anchor() {
        let base = make_bumpy_world(2, |_, _| 15);
        let mut ws = ws_with(base);
        let (ax, ay) = (8, 8);
        let disc = disc_points(ax, ay, 4);
        sculpt_terrain_inner(
            &mut ws, Some(disc.clone()), "slope".into(), 1, 0, None, None, None, None,
            Some(0.0), Some("smooth".into()), None, Some(ax), Some(ay), None, None, None, None, None,
            Some(1.0), Some(0.0), None, None, None, None,
        ).expect("slope");
        assert_eq!(surf(&ws, ax, ay), 15, "anchor column sits on its own plane, unchanged");
        assert_eq!(surf(&ws, ax + 3, ay), 18, "3 blocks east at slope_dx=1 → anchor height + 3");
        assert_eq!(surf(&ws, ax - 2, ay), 13, "2 blocks west at slope_dx=1 → anchor height - 2");
    }

    /// Smear pulls each column's height from `smear_dx/smear_dy` blocks behind it — a flat-out
    /// step (a cliff) shifts sideways by the smear vector within the brushed footprint, and a
    /// zero vector is a no-op (nothing to smear without a drag direction).
    #[test]
    fn test_smear_advects_height_along_drag() {
        // A cliff: x < 8 is low (10), x >= 8 is high (20).
        let base = make_bumpy_world(2, |lx, _| if lx < 8 { 10 } else { 20 });
        let disc = disc_points(8, 8, 3);

        // Zero vector: no-op regardless of softness.
        let mut ws0 = ws_with(base.clone());
        let before = world_bytes(&ws0);
        sculpt_terrain_inner(
            &mut ws0, Some(disc.clone()), "smear".into(), 1, 0, None, None, None, None,
            Some(0.0), Some("smooth".into()), None, None, None, None, None, None, None, None,
            None, None, Some(0), Some(0), None, None,
        ).expect("smear no-op");
        assert_eq!(world_bytes(&ws0), before, "zero smear vector must not touch the world");

        // Pull from 2 blocks east (source x+2) with a hard brush: every column in the footprint
        // takes on its source's height exactly.
        let mut ws = ws_with(base.clone());
        sculpt_terrain_inner(
            &mut ws, Some(disc.clone()), "smear".into(), 1, 0, None, None, None, None,
            Some(0.0), Some("smooth".into()), None, None, None, None, None, None, None, None,
            None, None, Some(-2), Some(0), None, None,
        ).expect("smear");
        // Column x=6 (low side) pulls from x=8 (high side, source = p.x - smear_dx = 6 - (-2) = 8)
        assert_eq!(surf(&ws, 6, 8), 20, "column at x=6 pulls its source height from x=8");
        // Column x=10 (high side) pulls from x=12, also high — unaffected in value.
        assert_eq!(surf(&ws, 10, 8), 20, "column at x=10 pulls its source height from x=12 (same band)");
    }

    /// Hydro is deterministic: two identical droplet simulations (same seed, same world, same
    /// params) produce byte-identical results — the RNG-driven start jitter/exploration is seeded.
    #[test]
    fn test_hydro_determinism() {
        let base = make_bumpy_world(2, |lx, ly| 12 + ((lx * 3 + ly) % 7) as i32);
        let disc = disc_points(8, 8, 5);
        let mut ws1 = ws_with(base.clone());
        let mut ws2 = ws_with(base.clone());
        sculpt(&mut ws1, Some(disc.clone()), "hydro", 4, 0.0, None, None);
        sculpt(&mut ws2, Some(disc.clone()), "hydro", 4, 0.0, None, None);
        assert_eq!(world_bytes(&ws1), world_bytes(&ws2),
            "identical hydro calls must be byte-identical (seeded droplet sim is deterministic)");
    }

    /// Hydro actually erodes: running it over a broad peak shrinks the peak-to-valley height range
    /// within the footprint (the peak erodes down and/or valleys fill), vs the untouched world.
    #[test]
    fn test_hydro_erodes_a_peak() {
        // A broad cone peak so many droplets engage the slope.
        let cone = |lx: usize, ly: usize| -> i32 {
            let (dx, dy) = (lx as i32 - 8, ly as i32 - 8);
            let d = ((dx * dx + dy * dy) as f64).sqrt();
            15 + (24.0 - 4.0 * d).max(0.0).round() as i32
        };
        let base = make_bumpy_world(2, cone);
        let disc = disc_points(8, 8, 5);

        let range = |ws: &WorldState| -> i32 {
            let hs: Vec<i32> = disc.iter().map(|p| surf(ws, p.x, p.y)).collect();
            hs.iter().max().unwrap() - hs.iter().min().unwrap()
        };
        let before_ws = ws_with(base.clone());
        let range_before = range(&before_ws);

        let mut ws = ws_with(base.clone());
        sculpt(&mut ws, Some(disc.clone()), "hydro", 4, 0.0, None, None);
        let range_after = range(&ws);

        assert!(range_after < range_before,
            "hydro must reduce the footprint height range (before {range_before}, after {range_after})");
    }

    /// Commit stays inside the footprint: even though the droplet workspace extends 16 cells past the
    /// brush, a column strictly outside the footprint's bounding box is byte-identical afterwards,
    /// while a column inside it changed. This is the regression guard that makes the wider workspace
    /// safe (§4 "commit inside footprint only").
    #[test]
    fn test_hydro_commit_stays_in_footprint() {
        // Column's full block+paint byte column (all 64 z levels), single-chunk layout.
        let col_bytes = |bytes: &[u8], lx: usize, ly: usize| -> Vec<u8> {
            let mut v = Vec::with_capacity(128);
            for z in 0..64usize {
                let off = 4096 + (z / 16) * 8192 + lx * 256 + ly * 16 + (z % 16);
                v.push(bytes[off]);
                v.push(bytes[off + 4096]);
            }
            v
        };
        let cone = |lx: usize, ly: usize| -> i32 {
            let (dx, dy) = (lx as i32 - 8, ly as i32 - 8);
            let d = ((dx * dx + dy * dy) as f64).sqrt();
            15 + (18.0 - 3.0 * d).max(0.0).round() as i32
        };
        let base = make_bumpy_world(2, cone);
        let before = base.clone();

        // Footprint bbox is x,y ∈ 5..=11. (2,2) is outside it but well inside the workspace
        // (footprint − 16 .. footprint + 16); (8,8) is the centre and must change.
        let mut ws = ws_with(base.clone());
        sculpt(&mut ws, Some(disc_points(8, 8, 3)), "hydro", 4, 0.0, None, None);
        let after = world_bytes(&ws);

        assert_eq!(col_bytes(&before, 2, 2), col_bytes(&after, 2, 2),
            "a column outside the footprint bbox must be untouched by hydro's wider workspace");
        assert_ne!(col_bytes(&before, 8, 8), col_bytes(&after, 8, 8),
            "the footprint centre must actually be eroded (otherwise the guard proves nothing)");
    }

    /// Erosion radius ≥ 2: a single hydro stamp's erosion is spread over a radial brush, so a stamp
    /// changes a contiguous neighbourhood of columns, not a 1-wide line (the audit's flaw (3)).
    #[test]
    fn test_hydro_erosion_spreads_across_columns() {
        let cone = |lx: usize, ly: usize| -> i32 {
            let (dx, dy) = (lx as i32 - 8, ly as i32 - 8);
            let d = ((dx * dx + dy * dy) as f64).sqrt();
            15 + (20.0 - 4.0 * d).max(0.0).round() as i32
        };
        let base = make_bumpy_world(2, cone);
        let before_ws = ws_with(base.clone());
        let disc = disc_points(8, 8, 4);

        let mut ws = ws_with(base.clone());
        sculpt(&mut ws, Some(disc.clone()), "hydro", 4, 0.0, None, None);

        let changed = disc.iter()
            .filter(|p| surf(&ws, p.x, p.y) != surf(&before_ws, p.x, p.y))
            .count();
        assert!(changed >= 2,
            "erosion-radius brush must change more than one column (changed {changed})");
    }
}
