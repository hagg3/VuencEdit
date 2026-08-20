//! Static geometry export: OBJ, JSON block dump, and MagicaVoxel .vox.
use crate::colors::{block_color, transparent_alpha, BI_NOTSOLID, BI_RAMPORSIDE, BLOCK_INFO};
use crate::{fluid_base, fluid_level, read_ws, world_max_z, AppState, LoadedWorld, LongOps};
use crate::texturepack;
use rustc_hash::FxHashMap;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufWriter, Write};

/// Ceiling on the voxel volume one OBJ / JSON / VOX export may span (audit C6).
///
/// All three are linear in the volume and emit a per-voxel record, so a whole-world export on a
/// populated 256z world (7216 × 8448 × 256 ≈ 1.6 × 10¹⁰ blocks) is billions of records and hundreds
/// of gigabytes — it does not finish, and it holds the read guard while not finishing, so no edit,
/// undo, save or autosave can run either. The frontend defaults these exports to the whole world
/// when there is no selection, which is how that gets reached by accident. 256 M matches the
/// clipboard's own `MAX_CLIPBOARD_VOLUME`, i.e. the volume this codebase already treats as the
/// largest single region worth materialising.
pub(crate) const MAX_EXPORT_VOXELS: u64 = 256_000_000;

/// Refuse an over-budget export up front, with the estimate spelled out — the user's next move is
/// to select a region, so say so rather than starting something that can't finish.
fn check_export_volume(sx1: i32, sy1: i32, sz1: i32, sx2: i32, sy2: i32, sz2: i32, what: &str) -> Result<u64, String> {
    let w = (sx2 - sx1 + 1).max(0) as u64;
    let h = (sy2 - sy1 + 1).max(0) as u64;
    let d = (sz2 - sz1 + 1).max(0) as u64;
    let volume = w.saturating_mul(h).saturating_mul(d);
    if volume > MAX_EXPORT_VOXELS {
        return Err(format!(
            "This region is {w}×{h}×{d} = {} blocks — more than the {} block {what} export limit. \
             Select a smaller region first.",
            fmt_big(volume), fmt_big(MAX_EXPORT_VOXELS),
        ));
    }
    Ok(volume)
}

/// "1.6 trillion" / "256 million" / "12,800" — readable magnitudes for the message above.
fn fmt_big(n: u64) -> String {
    const T: u64 = 1_000_000_000_000;
    const B: u64 = 1_000_000_000;
    const M: u64 = 1_000_000;
    if n >= T { format!("{:.1} trillion", n as f64 / T as f64) }
    else if n >= B { format!("{:.1} billion", n as f64 / B as f64) }
    else if n >= M { format!("{:.0} million", n as f64 / M as f64) }
    else { n.to_string() }
}

// ── OBJ Export ────────────────────────────────────────────────────────────────

pub(crate) fn get_block_at(world: &LoadedWorld, wx: i32, wy: i32, wz: i32) -> (u8, u8) {
    if wz < 0 || wz as usize >= world.num_bands * 16 { return (0, 0); }
    let cx = wx.div_euclid(16) + world.min_x;
    let cy = wy.div_euclid(16) + world.min_y;
    if let Some((addr, cend)) = world.chunk_range(cx, cy) {
        let lx = wx.rem_euclid(16) as usize;
        let ly = wy.rem_euclid(16) as usize;
        let band = wz as usize / 16;
        let lz   = wz as usize % 16;
        let bi = addr + band * 8192 + lx * 256 + ly * 16 + lz;
        let pi = bi + 4096;
        if pi < cend {
            return (world.bytes[bi], world.bytes[pi]);
        }
    }
    (0, 0)
}

/// Single-entry memo for the `chunk_map` lookup that dominates [`get_block_at`].
///
/// The geometry loops walk voxel by voxel, and each voxel also probes its six neighbours — so
/// consecutive queries nearly always land in the same 16×16 chunk column, and the hash lookup is
/// pure overhead. Caching the *resolved* result (including "no such chunk", which sparse worlds hit
/// constantly) collapses that to one compare on the common path.
///
/// Uses `Cell` rather than `&mut` so the `&`-capturing lighting/shadow closures can share one
/// cache. That makes it `!Sync`: it is for single-threaded scans only — do not hand it to rayon.
pub(crate) struct ChunkCache<'w> {
    world: &'w LoadedWorld,
    last: Cell<Option<(i32, i32, Option<(usize, usize)>)>>,
}

impl<'w> ChunkCache<'w> {
    pub(crate) fn new(world: &'w LoadedWorld) -> Self {
        Self { world, last: Cell::new(None) }
    }

    /// Identical in result to `get_block_at(self.world, wx, wy, wz)`.
    #[inline]
    pub(crate) fn get(&self, wx: i32, wy: i32, wz: i32) -> (u8, u8) {
        let w = self.world;
        if wz < 0 || wz as usize >= w.num_bands * 16 { return (0, 0); }
        let cx = wx.div_euclid(16) + w.min_x;
        let cy = wy.div_euclid(16) + w.min_y;
        let range = match self.last.get() {
            Some((lcx, lcy, r)) if lcx == cx && lcy == cy => r,
            _ => {
                let r = w.chunk_range(cx, cy);
                self.last.set(Some((cx, cy, r)));
                r
            }
        };
        let Some((addr, cend)) = range else { return (0, 0) };
        let lx = wx.rem_euclid(16) as usize;
        let ly = wy.rem_euclid(16) as usize;
        let bi = addr + (wz as usize / 16) * 8192 + lx * 256 + ly * 16 + (wz as usize % 16);
        let pi = bi + 4096;
        if pi < cend {
            return (w.bytes[bi], w.bytes[pi]);
        }
        (0, 0)
    }
}

/// True if this block fully occludes an adjacent face (not air, not notsolid, not ramp/wedge).
pub(crate) fn obj_occludes(bt: u8) -> bool {
    let idx = bt as usize;
    idx != 0 && idx < BLOCK_INFO.len() && (BLOCK_INFO[idx] & (BI_NOTSOLID | BI_RAMPORSIDE)) == 0
}

/// Eden (X right, Y south, Z up) → OBJ (X right, Y up, Z toward viewer)
pub(crate) fn ov(ex: f32, ey: f32, ez: f32) -> (f32, f32, f32) { (ex, ez, -ey) }

pub(crate) fn obj_v(w: &mut impl Write, (x, y, z): (f32, f32, f32)) -> std::io::Result<()> {
    writeln!(w, "v {x} {y} {z}")
}

pub(crate) fn obj_quad(w: &mut impl Write) -> std::io::Result<()> { writeln!(w, "f -4 -3 -2 -1") }
pub(crate) fn obj_tri(w: &mut impl Write)  -> std::io::Result<()> { writeln!(w, "f -3 -2 -1") }

pub(crate) fn write_vox_chunk(buf: &mut Vec<u8>, id: &[u8; 4], content: &[u8]) {
    buf.extend_from_slice(id);
    buf.extend_from_slice(&(content.len() as i32).to_le_bytes());
    buf.extend_from_slice(&0i32.to_le_bytes()); // children_size always 0 for leaf chunks
    buf.extend_from_slice(content);
}

/// Emit a cube block with face culling (skips faces adjacent to fully-opaque neighbors).
pub(crate) fn emit_cube(w: &mut impl Write, wx: i32, wy: i32, wz: i32, world: &LoadedWorld) -> std::io::Result<()> {
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
pub(crate) fn emit_ramp(w: &mut impl Write, wx: i32, wy: i32, wz: i32, dir: u8, world: &LoadedWorld) -> std::io::Result<()> {
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
pub(crate) fn emit_wedge(w: &mut impl Write, wx: i32, wy: i32, wz: i32, dir: u8, world: &LoadedWorld) -> std::io::Result<()> {
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
pub(crate) fn greedy_mesh_2d(cells: &HashSet<(i32, i32)>) -> Vec<(i32, i32, i32, i32)> {
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
pub(crate) fn emit_merged_quad(w: &mut impl Write, dir: u8, plane: i32, u0: i32, v0: i32, u1: i32, v1: i32) -> std::io::Result<()> {
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

#[tauri::command(async)]
pub(crate) fn export_obj(
    app: tauri::AppHandle,
    ops: tauri::State<'_, LongOps>,
    state: tauri::State<'_, AppState>,
    path: String,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<(), String> {
    let ws = read_ws(&state);
    let world = ws.world.as_ref().ok_or("No world loaded")?;

    let sx1 = x1.min(x2); let sx2 = x1.max(x2);
    let sy1 = y1.min(y2); let sy2 = y1.max(y2);
    let sz1 = z_min.min(z_max).max(0);
    let sz2 = z_min.max(z_max).min(world_max_z(world));
    check_export_volume(sx1, sy1, sz1, sx2, sy2, sz2, "OBJ")?;

    // Two full passes over the volume (materials, then geometry), reported as one 0–100% bar.
    let rows = (sz2 - sz1 + 1).max(0) as u64 * 2;
    let op = ops.begin(&app, "obj", "Exporting OBJ".into(), rows, true);
    let cleanup = ExportCleanup::new(&path);

    // Collect unique (block_type, paint) combos for the MTL file.
    let mut mat_set: HashSet<(u8, u8)> = HashSet::new();
    for wz in sz1..=sz2 {
        op.step((wz - sz1) as u64, "Scanning materials")?;
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
        op.step((sz2 - sz1 + 1) as u64 + (wz - sz1) as u64, "Writing geometry")?;
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

    ow.flush().map_err(|e| e.to_string())?;
    cleanup.keep();
    Ok(())
}

/// Deletes a half-written export file unless `keep()` was called (audit C6). A cancelled or failed
/// export used to leave a truncated `.obj`/`.json.gz`/`.vox` behind that looks like a real one.
pub(crate) struct ExportCleanup { path: std::path::PathBuf, keep: Cell<bool> }
impl ExportCleanup {
    pub(crate) fn new(path: &str) -> Self {
        ExportCleanup { path: std::path::PathBuf::from(path), keep: Cell::new(false) }
    }
    pub(crate) fn keep(&self) { self.keep.set(true); }
}
impl Drop for ExportCleanup {
    fn drop(&mut self) {
        if !self.keep.get() { let _ = fs::remove_file(&self.path); }
    }
}

// ── JSON Export ────────────────────────────────────────────────────────────────

#[tauri::command(async)]
pub(crate) fn export_json(
    app: tauri::AppHandle,
    ops: tauri::State<'_, LongOps>,
    state: tauri::State<'_, AppState>,
    path: String,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<u32, String> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let ws = read_ws(&state);
    let world = ws.world.as_ref().ok_or("No world loaded")?;

    let sx1 = x1.min(x2); let sx2 = x1.max(x2);
    let sy1 = y1.min(y2); let sy2 = y1.max(y2);
    let sz1 = z_min.min(z_max).max(0);
    let sz2 = z_min.max(z_max).min(world_max_z(world));
    check_export_volume(sx1, sy1, sz1, sx2, sy2, sz2, "JSON")?;

    let op = ops.begin(&app, "json", "Exporting JSON".into(), (sz2 - sz1 + 1).max(0) as u64, true);
    let cleanup = ExportCleanup::new(&path);

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
        op.step((wz - sz1) as u64, "Writing blocks")?;
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
    let mut f = gz.finish().map_err(|e| e.to_string())?;
    f.flush().map_err(|e| e.to_string())?;
    cleanup.keep();
    Ok(count)
}

// ── VOX Export ────────────────────────────────────────────────────────────────

#[tauri::command(async)]
pub(crate) fn export_vox(
    app: tauri::AppHandle,
    ops: tauri::State<'_, LongOps>,
    state: tauri::State<'_, AppState>,
    path: String,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<u32, String> {
    let ws = read_ws(&state);
    let world = ws.world.as_ref().ok_or("No world loaded")?;

    let sx1 = x1.min(x2); let sx2 = x1.max(x2);
    let sy1 = y1.min(y2); let sy2 = y1.max(y2);
    let sz1 = z_min.min(z_max).max(0);
    let sz2 = z_min.max(z_max).min(world_max_z(world));
    check_export_volume(sx1, sy1, sz1, sx2, sy2, sz2, "VOX")?;
    let total_z = (sz2 - sz1 + 1) as f32;

    // Progress and cancellation now go through the shared long-operation contract (audit C6/M14)
    // rather than this command's own private `vox-progress` event — VOX was the one export that
    // already had a progress bar, and it is what the contract was modelled on.
    let op = ops.begin(&app, "vox", "Exporting VOX".into(), 1000, true);
    let cleanup = ExportCleanup::new(&path);
    let emit_progress = |phase: &str, frac: f32| -> Result<(), String> {
        op.step((frac.clamp(0.0, 1.0) * 1000.0) as u64, phase)
    };

    // Pass 1: collect unique RGB values in encounter order (0–45% of progress).
    let mut unique_colors: Vec<[u8; 3]> = Vec::new();
    let mut seen: HashSet<[u8; 3]> = HashSet::new();
    for wz in sz1..=sz2 {
        emit_progress("Scanning colors", (wz - sz1) as f32 / total_z * 0.45)?;
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
        emit_progress(&format!("Quantizing palette ({overflow_count} overflow colors)"), 0.46)?;
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
    let gx_count     = w_blocks.div_ceil(256);
    let gy_count     = h_blocks.div_ceil(256);
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
            let model_w  = (wx_end - wx_start + 1);
            let model_h  = (wy_end - wy_start + 1);
            let model_z  = z_depth as i32;

            let label = if total_models > 1.0 {
                format!("Building model {}/{}", model_idx + 1, gx_count * gy_count)
            } else {
                "Building model".to_string()
            };
            emit_progress(&label, 0.47 + model_idx as f32 / total_models * 0.50)?;
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
    emit_progress("Writing file", 0.97)?;
    let f = fs::File::create(&path).map_err(|e| format!("Cannot create .vox: {e}"))?;
    let mut w = BufWriter::with_capacity(1 << 20, f);
    w.write_all(b"VOX ").map_err(|e| e.to_string())?;
    w.write_all(&150i32.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(b"MAIN").map_err(|e| e.to_string())?;
    w.write_all(&0i32.to_le_bytes()).map_err(|e| e.to_string())?; // MAIN content_size
    w.write_all(&(children_buf.len() as i32).to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&children_buf).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    emit_progress("Done", 1.0)?;
    cleanup.keep();
    Ok(total_voxels)
}

pub(crate) struct ObjGeometryResult {
    positions: Vec<u8>, // LE f32 triplets (x,y,z) per vertex
    colors: Vec<u8>,    // LE f32 triplets (r,g,b 0..1) per vertex
    uvs: Vec<u8>,       // LE f32 pairs (u,v) per vertex; empty when no texture pack loaded
    vertex_count: u32,
    // Blocks with `transparent_alpha()` (water/fence/glass/new-flower) — mirrors the game's
    // second ATLAS2 vertex buffer, kept separate so the frontend can render them with their own
    // `transparent:true` material instead of blending into the opaque draw call.
    positions_t: Vec<u8>,
    colors_t: Vec<u8>,  // LE f32 quadruplets (r,g,b,a 0..1) per vertex
    uvs_t: Vec<u8>,
    vertex_count_t: u32,
    // Emissive stream (RGB, like the opaque one) — populated only in `flat` (GPU-shadow) mode and
    // only with `LAMP_BLOCK_TYPE` faces. Lamps must render fullbright in GPU mode: the flat opaque
    // stream is shaded by Three.js's lit material + ambient, which would darken lamps like any other
    // block, so the frontend draws these faces with an unlit `MeshBasicMaterial` instead. Empty (0)
    // whenever `!flat` — OBJ/JSON export and `ThreeDPreview` pass `LightMode::default()`, so their
    // output is byte-for-byte unchanged and lamp faces stay in the opaque stream as before.
    positions_e: Vec<u8>,
    colors_e: Vec<u8>,
    uvs_e: Vec<u8>,
    vertex_count_e: u32,
}

impl ObjGeometryResult {
    /// Total wire bytes this result will occupy on the JS side (the nine buffers, exclusive of the
    /// envelope header). The frontend's geometry budget and its dev memory HUD count the same
    /// number — a GPU VBO is the size of the buffer it was uploaded from — so this is the honest
    /// per-chunk memory cost, unlike the vertex counts (which ignore UV/RGBA stream width).
    pub(crate) fn wire_bytes(&self) -> usize {
        self.positions.len() + self.colors.len() + self.uvs.len()
            + self.positions_t.len() + self.colors_t.len() + self.uvs_t.len()
            + self.positions_e.len() + self.colors_e.len() + self.uvs_e.len()
    }
}

/// Scalar half of the binary envelope (audit H2). `lens` gives the byte length of each of the nine
/// buffers, in the order they are concatenated into the body, so the JS side can slice them apart
/// without re-deriving sizes from the vertex counts (`uvs*` are empty when no texture pack is loaded,
/// and `colors_t` is 4 floats per vertex where the others are 3 or 2).
#[derive(serde::Serialize)]
pub(crate) struct ObjGeometryHeader {
    vertex_count: u32,
    vertex_count_t: u32,
    vertex_count_e: u32,
    lens: [u32; 9],
}

impl tauri::ipc::IpcResponse for ObjGeometryResult {
    fn body(self) -> tauri::Result<tauri::ipc::InvokeResponseBody> {
        let bufs: [&[u8]; 9] = [
            &self.positions, &self.colors, &self.uvs,
            &self.positions_t, &self.colors_t, &self.uvs_t,
            &self.positions_e, &self.colors_e, &self.uvs_e,
        ];
        let mut lens = [0u32; 9];
        for (i, b) in bufs.iter().enumerate() { lens[i] = b.len() as u32; }
        let header = ObjGeometryHeader {
            vertex_count: self.vertex_count,
            vertex_count_t: self.vertex_count_t,
            vertex_count_e: self.vertex_count_e,
            lens,
        };
        crate::ipc_envelope(&header, &bufs)
    }
}

#[tauri::command(async)]
pub(crate) fn get_obj_geometry(
    state: tauri::State<'_, AppState>,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<ObjGeometryResult, String> {
    let ws = read_ws(&state);
    let world = ws.world.as_ref().ok_or("No world loaded")?;

    let sx1 = x1.min(x2); let sx2 = x1.max(x2);
    let sy1 = y1.min(y2); let sy2 = y1.max(y2);
    let sz1 = z_min.min(z_max).max(0);
    let sz2 = z_min.max(z_max).min(world_max_z(world));

    let vol = ((sx2-sx1+1) as u64) * ((sy2-sy1+1) as u64) * ((sz2-sz1+1) as u64);
    if vol > 64*64*64 {
        return Err(format!("Selection too large ({vol} blocks) — max 64×64×64 for 3D preview"));
    }

    // Shaped selection: honour the wand/lasso footprint so the floating 3D preview matches paste.
    // Normalized rect (sx1..sx2, sy1..sy2) is what ThreeDPreview sends, so active_mask's exact-bbox
    // check lines up; a mismatch degrades to the full box.
    let mask = crate::active_mask(&ws, sx1, sy1, sx2, sy2);
    Ok(obj_geometry_region(world, ws.texture_pack.as_ref(), sx1, sy1, sx2, sy2, sz1, sz2, &[], LightMode::default(), mask.as_ref()))
}

/// Which of the game's two shipped lighting behaviours a lamp's falloff follows. The original
/// (64z-era) client used a tight, steep-falloff pool (~4 tile effective radius); "New Dawn"
/// (256z) widened it to a much broader, gradual pool (~14 tiles). Both are real, previously-shipped
/// behaviours — not an editor invention — so the profile is a first-class parameter threaded through
/// `LightMode` rather than a single hardcoded curve.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LightingProfile {
    Legacy,
    Modern,
}

impl Default for LightingProfile {
    fn default() -> Self { LightingProfile::Legacy }
}

impl LightingProfile {
    /// The lamp radius (blocks) this profile snaps to when the user hasn't overridden it.
    pub(crate) fn default_radius(self) -> f32 {
        match self {
            LightingProfile::Legacy => LEGACY_LAMP_RADIUS,
            LightingProfile::Modern => MODERN_LAMP_RADIUS,
        }
    }

    /// Per-lamp intensity contribution at `dist` blocks for a pool of `radius` blocks, in `[0,1]`.
    /// Legacy: quadratic falloff — stays bright near the lamp then drops off abruptly, matching the
    /// small, sharp-edged pools of the original 64z client. Modern: linear falloff — the same shape
    /// New Dawn's much larger radius already reads as "gradual" (its per-tile slope is `1/radius`,
    /// shallower simply because radius is ~3.5x larger), so it keeps the existing curve.
    fn falloff(self, dist: f32, radius: f32) -> f32 {
        let t = (1.0 - dist / radius).max(0.0);
        match self {
            LightingProfile::Legacy => t * t,
            LightingProfile::Modern => t,
        }
    }
}

/// Night-lighting/shadow preview toggles for `obj_geometry_region`. Both default off, reproducing
/// today's flat fully-lit output exactly (OBJ/JSON export and `ThreeDPreview` always pass `default()`
/// — only `FlyView3D`'s chunk streaming opts in).
#[derive(Clone, Copy, Default)]
pub(crate) struct LightMode {
    pub night: bool,
    pub shadows: bool,
    /// Simulated sun position, 0=sunrise, 0.5=noon, 1=sunset (see `sun_direction`). Inert whenever
    /// `shadows` is false; `f32::default()` = 0.0 keeps `LightMode::default()` unaffected.
    pub sun_t: f32,
    /// Emit **flat, unshaded** vertex colours (raw `block_color`, no per-face SH_* shading) for the
    /// opt-in GPU-shadow path: Three.js then does the directional shading + shadow map from real
    /// vertex normals, so baking any shading here would double up. Face *kind* (top/bottom/side, for
    /// texture selection) is still derived from the SH_* constant — only the brightness multiply is
    /// skipped. Mutually exclusive with `night`/`shadows` in practice (the frontend clears them).
    pub flat: bool,
    /// User-tunable lamp light radius (blocks). `<= 0.0` (the `Default`) falls back to
    /// `profile.default_radius()`, so `LightMode::default()` output is byte-for-byte unchanged for
    /// OBJ/JSON export and `ThreeDPreview`. Only `get_chunk_geometry` (FlyView3D) passes a live value.
    pub lamp_radius: f32,
    /// Which falloff curve/default-radius pairing to use (see `LightingProfile`). Independent of
    /// `lamp_radius` — the profile picks the *shape* of the pool; the radius slider can still
    /// override the profile's default distance without changing which curve is used.
    pub profile: LightingProfile,
}

pub(crate) const LAMP_BLOCK_TYPE: u8 = 72; // TYPE_LIGHTBOX
const LEGACY_LAMP_RADIUS: f32 = 4.0;
const MODERN_LAMP_RADIUS: f32 = 14.0;
const NIGHT_AMBIENT: f32 = 0.35;
const SHADOW_RAY_STEPS: i32 = 24; // unit steps marched toward the sun per voxel

#[derive(serde::Serialize)]
pub(crate) struct LightConstants {
    lamp_light_radius: f32,
    legacy_lamp_radius: f32,
    modern_lamp_radius: f32,
    shadow_ray_steps: i32,
}

/// Exposes the legacy/modern default lamp radii + `SHADOW_RAY_STEPS` to the frontend so the edit-sync
/// reload radius (FlyView3D: a placed lamp/block can affect neighboring chunks up to these distances
/// away when night lighting or shadows are on) can't silently drift out of sync with the Rust
/// constants. `lamp_light_radius` is kept as an alias of `legacy_lamp_radius` for callers that haven't
/// been updated to the per-profile fields yet.
#[tauri::command]
pub(crate) fn get_light_constants() -> LightConstants {
    LightConstants {
        lamp_light_radius: LEGACY_LAMP_RADIUS,
        legacy_lamp_radius: LEGACY_LAMP_RADIUS,
        modern_lamp_radius: MODERN_LAMP_RADIUS,
        shadow_ray_steps: SHADOW_RAY_STEPS,
    }
}
const SUN_SHADOW: f32 = 0.55; // hard shadow multiplier — stays well above black even combined
                               // with the darkest per-face shade constant (SH_W=0.447)
const SUN_LIT: f32 = 1.0;

/// Unit vector pointing from a voxel toward the simulated sun. `sun_t` sweeps a half-arc
/// (sunrise -> noon -> sunset): elevation eases 15°..80°..15° via `sin(pi*t)`, azimuth sweeps
/// 0..pi (east->west) linearly. There's no night-side sun (no sky dome/moon-shadow concept here —
/// "night" is a separate ambient toggle), so this deliberately never goes sub-horizon.
fn sun_direction(sun_t: f32) -> [f32; 3] {
    let az = std::f32::consts::PI * sun_t;
    let el = 15.0f32.to_radians() + (std::f32::consts::PI * sun_t).sin() * 65.0f32.to_radians();
    [el.cos() * az.cos(), el.cos() * az.sin(), el.sin()]
}

/// 3D DDA (Amanatides–Woo) — marches a ray from `(ox,oy,oz)` in direction `dir` (need not be
/// normalized) up to `max_dist` world units, visiting every voxel the ray actually crosses. This is
/// what makes it safe for a shallow ray: stepping by a fixed unit-length offset each iteration (the
/// old approach) advances less than 1 unit along any single axis for a diagonal direction, so
/// `floor()` can jump clean over a one-block-thick occluder (a fence post, a wall seen edge-on, a
/// thin horizontal slab) between two samples. A DDA can't skip a voxel boundary — it steps exactly
/// to the next one on whichever axis is nearest. `hit(x,y,z)` is called for each visited voxel in
/// order; marching stops and returns that voxel's coords on the first `true`, or `None` if the ray
/// exhausts `max_dist` unhit. Doesn't test the origin voxel itself — marching starts at its first
/// exit boundary, matching the old code's "step before testing" behaviour.
fn dda_march(ox: f32, oy: f32, oz: f32, dir: [f32; 3], max_dist: f32, mut hit: impl FnMut(i32, i32, i32) -> bool) -> Option<(i32, i32, i32)> {
    let [dx, dy, dz] = dir;
    let (mut x, mut y, mut z) = (ox.floor() as i32, oy.floor() as i32, oz.floor() as i32);
    let step = |d: f32| -> i32 { if d > 0.0 { 1 } else if d < 0.0 { -1 } else { 0 } };
    let (sx, sy, sz) = (step(dx), step(dy), step(dz));
    let t_delta = |d: f32| -> f32 { if d != 0.0 { (1.0 / d).abs() } else { f32::INFINITY } };
    let (tdx, tdy, tdz) = (t_delta(dx), t_delta(dy), t_delta(dz));
    // Parametric distance from the origin to the first voxel boundary crossed on each axis.
    let boundary = |p: f32, s: i32| -> f32 {
        if s > 0 { p.floor() + 1.0 - p } else if s < 0 { p - p.floor() } else { f32::INFINITY }
    };
    let mut tmx = if sx != 0 { boundary(ox, sx) * tdx } else { f32::INFINITY };
    let mut tmy = if sy != 0 { boundary(oy, sy) * tdy } else { f32::INFINITY };
    let mut tmz = if sz != 0 { boundary(oz, sz) * tdz } else { f32::INFINITY };
    let mut t = 0.0f32;
    while t < max_dist {
        if tmx < tmy && tmx < tmz {
            x += sx; t = tmx; tmx += tdx;
        } else if tmy < tmz {
            y += sy; t = tmy; tmy += tdy;
        } else {
            z += sz; t = tmz; tmz += tdz;
        }
        if hit(x, y, z) { return Some((x, y, z)); }
    }
    None
}

/// The voxel a ray hit, plus the face it entered through as a unit normal in Eden coords
/// (`nx/ny/nz`). `hit + normal` is the empty voxel adjacent to that face — i.e. where a block
/// placed against it goes.
#[derive(serde::Serialize)]
pub(crate) struct PickResult {
    pub x: i32, pub y: i32, pub z: i32,
    pub block_type: u8,
    pub paint: u8,
    pub nx: i32, pub ny: i32, pub nz: i32,
}

/// Maximum ray length for `pick_block`, in blocks. Clamps a bad/hostile `max_dist` so a single
/// pick can't march the whole world.
const PICK_MAX_DIST: f32 = 512.0;

/// Casts a ray through the voxel grid and returns the first non-air block it enters, or `None`.
///
/// Origin and direction are in **Eden** coords (X east, Y south, Z up) — the caller owns the
/// Three.js↔Eden transform, so this stays a pure world-space query usable by any viewport.
///
/// Ramps and wedges (24..=55) pick as full cubes: the ray hits them at their voxel bounds, not at
/// their true sloped surface. Eden's own placement does roughly this, and the alternative (exact
/// prism/pyramid intersection per block type) buys very little for a picker whose result snaps to a
/// voxel anyway. Non-solid blocks (water, glass, fence, flowers) are hits too — you can break and
/// build against them, which matches what the block under the crosshair looks like.
#[tauri::command(async)]
pub(crate) fn pick_block(
    state: tauri::State<'_, AppState>,
    ox: f32, oy: f32, oz: f32,
    dx: f32, dy: f32, dz: f32,
    max_dist: f32,
) -> Result<Option<PickResult>, String> {
    let ws = read_ws(&state);
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    pick_block_in(world, ox, oy, oz, dx, dy, dz, max_dist)
}

/// Lock-free core of [`pick_block`], so it can be tested against a bare `LoadedWorld`.
pub(crate) fn pick_block_in(
    world: &LoadedWorld,
    ox: f32, oy: f32, oz: f32,
    dx: f32, dy: f32, dz: f32,
    max_dist: f32,
) -> Result<Option<PickResult>, String> {
    let len = (dx * dx + dy * dy + dz * dz).sqrt();
    if !len.is_finite() || len < 1e-6 {
        return Err("pick_block: degenerate ray direction".into());
    }
    if !ox.is_finite() || !oy.is_finite() || !oz.is_finite() {
        return Err("pick_block: non-finite ray origin".into());
    }
    let dir = [dx / len, dy / len, dz / len];
    let dist = max_dist.clamp(0.0, PICK_MAX_DIST);

    // `dda_march` never tests the origin voxel, so the voxel preceding the first visited one is the
    // origin voxel itself — seeding `prev` with it makes the entry normal correct even for a hit on
    // the very first step.
    let mut prev = (ox.floor() as i32, oy.floor() as i32, oz.floor() as i32);
    let mut found: Option<(i32, i32, i32)> = None;
    let hit = dda_march(ox, oy, oz, dir, dist, |vx, vy, vz| {
        if get_block_at(world, vx, vy, vz).0 != 0 {
            found = Some((vx, vy, vz));
            true
        } else {
            prev = (vx, vy, vz);
            false
        }
    });
    let Some((x, y, z)) = hit.and(found) else { return Ok(None) };
    let (bt, paint) = get_block_at(world, x, y, z);
    Ok(Some(PickResult {
        x, y, z,
        block_type: bt,
        paint,
        nx: prev.0 - x, ny: prev.1 - y, nz: prev.2 - z,
    }))
}

/// One plain-cube face, deferred out of the voxel pass so coplanar neighbours can be greedily merged
/// into a single large quad before any vertex exists (Stage 5 of the 3D-pane crash fix).
///
/// `dir` also fixes the face's plane and its two in-plane axes, so `slice`/`u`/`v` are enough to
/// rebuild the world-space rectangle — see `MERGE_DIRS` and the emission loop at the end of
/// `obj_geometry_region`:
///
/// | `dir` | face | plane | `slice` | `u` | `v` |
/// |---|---|---|---|---|---|
/// | 0 | top    | `z = slice+1` | `wz` | `wx` | `wy` |
/// | 1 | bottom | `z = slice`   | `wz` | `wx` | `wy` |
/// | 2 | south (+Y) | `y = slice+1` | `wy` | `wx` | `wz` |
/// | 3 | north (−Y) | `y = slice`   | `wy` | `wx` | `wz` |
/// | 4 | east (+X)  | `x = slice+1` | `wx` | `wy` | `wz` |
/// | 5 | west (−X)  | `x = slice`   | `wx` | `wy` | `wz` |
///
/// **Field order is the merge key and it is load-bearing**: `derive(Ord)` sorts lexicographically by
/// declaration order, so sorting the whole face list groups everything that may merge — same
/// direction, same plane, same block, same light — into one contiguous run ordered (v, u), which is
/// exactly the scan order the greedy rectangle pass wants. `lm` is stored as raw bits because two
/// faces may only merge when they render *bit-identically*; that is what keeps per-block lamp light
/// and sun shadows intact through the merge instead of averaging them across a big quad.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct FaceRec {
    dir: u8,
    slice: i32,
    bt: u8,
    paint: u8,
    lm: [u32; 3],
    v: i32,
    u: i32,
}

/// Face-culled cube/ramp/wedge geometry for an arbitrary world box, encoded as LE f32 position +
/// colour triplets (Three.js Y-up coords). Shared by `get_obj_geometry` (64³ selection preview) and
/// `get_chunk_geometry` (world-scale fly-through chunk streaming).
///
/// Plain cube faces are **greedily meshed**: instead of six quads per voxel, coplanar adjacent faces
/// that render identically fuse into one large quad, which is what keeps a 256z world's chunk
/// payload (and the GPU buffers it becomes) proportional to the terrain's *surface complexity*
/// rather than its voxel count. Ramps, wedges and partial-height fluid faces stay per-block — they
/// are not unit squares, so there is nothing to tile. See `FaceRec`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn obj_geometry_region(world: &LoadedWorld, pack: Option<&texturepack::TexturePack>, sx1: i32, sy1: i32, sx2: i32, sy2: i32, sz1: i32, sz2: i32, lamps: &[([i32; 3], [f32; 3])], mode: LightMode, mask: Option<&crate::SelectionMask>) -> ObjGeometryResult {
    // Every block read below goes through the chunk-address memo. Single-threaded by construction
    // (see ChunkCache) — this function is not parallelised.
    let cache = ChunkCache::new(world);
    // Shaped selection (3D preview): an unmasked column reads as air here, so both emission and
    // occlusion see the hole through the single block-getter — side faces at hole edges emit
    // correctly without a separate emission-loop gate. `None` (FlyView3D streaming, export) is a
    // no-op. Fail-safe is upstream: `get_obj_geometry` resolves the mask via `active_mask` (exact
    // bbox), so a mismatched selection never reaches here masked.
    let gb = |wx: i32, wy: i32, wz: i32| {
        if mask.is_some_and(|m| !m.contains(wx, wy)) { return (0u8, 0u8); }
        cache.get(wx, wy, wz)
    };

    // Face-culling neighbour getter — `gb` clipped to the emitted z range. A block just *outside*
    // `[sz1, sz2]` is not part of this render, so it must not occlude the face it touches: without
    // this, clipping the range (FlyView3D's camera band / cutaway cap, or any sub-column selection
    // preview) culls the top face of the topmost emitted block and the bottom face of the lowest,
    // producing a see-through roof/floor at the cut plane. Only the vertical lookups can leave the
    // range — laterals share `wz`, so `gbz == gb` for them — but every neighbour read in the
    // emission loop goes through it so a future lookup can't reintroduce the hole.
    //
    // Deliberately NOT used by `shadow_at`: the sun raymarch reads the *real* world, so a clipped
    // render keeps the shadows it would have had unclipped (a ray escaping the band must still be
    // blocked by the terrain above it).
    let gbz = |wx: i32, wy: i32, wz: i32| -> (u8, u8) {
        if wz < sz1 || wz > sz2 { return (0u8, 0u8); }
        gb(wx, wy, wz)
    };

    let mut pos_f: Vec<f32> = Vec::new();
    let mut col_f: Vec<f32> = Vec::new();
    let mut uv_f:  Vec<f32> = Vec::new();
    // Transparent stream (water/glass/fence/new-flower) — same layout except colors are RGBA.
    let mut pos_ft: Vec<f32> = Vec::new();
    let mut col_ft: Vec<f32> = Vec::new();
    let mut uv_ft:  Vec<f32> = Vec::new();
    // Emissive stream (lamp blocks in flat/GPU mode) — RGB, drawn unlit by the frontend so lamps
    // stay fullbright. Only populated when `mode.flat`.
    let mut pos_ef: Vec<f32> = Vec::new();
    let mut col_ef: Vec<f32> = Vec::new();
    let mut uv_ef:  Vec<f32> = Vec::new();

    // Deferred plain-cube faces, merged and emitted after the voxel pass (see `FaceRec`). A record is
    // ~28 B where the six vertices it stands for cost ≥ 144 B, so collecting first is cheaper in peak
    // memory than emitting first — before merging removes any of them.
    let mut faces: Vec<FaceRec> = Vec::new();

    // Lamp positions + light colour within reach of this region are supplied by the caller (only
    // populated when night preview is on — day-lit/no-lamp regions pass an empty slice). The caller
    // (`get_chunk_geometry`) gathers them from the chunk-keyed lamp spatial index rather than scanning
    // the voxel volume, so the lamp radius can be a user slider without the scan going cubic in radius.
    // Colour is the lamp block's own paint via the same `block_color` lookup normal painted blocks use
    // (Lighting.mm `addlight` is passed `colorTable[getColorc(x,z,y)]` — the lamp's paint index into
    // the shared paint table, not a dedicated lamp-colour table).
    let lamp_radius = if mode.lamp_radius > 0.0 { mode.lamp_radius } else { mode.profile.default_radius() };

    let sun_dir = sun_direction(mode.sun_t);

    // Per-block, per-channel light: Eden's `calcLight` adds each nearby lamp's `colorTable[paint]`
    // (scaled by linear falloff) onto the ambient base independently per R/G/B channel (Terrain.mm
    // `calcLight`/`addlight` keep a `Vector8 lightarray` — one accumulator per channel, not a single
    // scalar), then clamps to [0, 1.5]. Keeping the channels separate is what makes a red lamp cast
    // red light instead of just a brighter grey. Evaluated once per voxel (not per vertex) — a
    // per-block approximation of the game's per-voxel lightarray grid. Lamp blocks themselves render
    // fullbright, matching the game.
    let light_at = |wx: i32, wy: i32, wz: i32, bt: u8| -> [f32; 3] {
        if !mode.night || bt == LAMP_BLOCK_TYPE { return [1.0, 1.0, 1.0]; }
        let mut l = [NIGHT_AMBIENT; 3];
        for (&[lx, ly, lz], &color) in lamps.iter().map(|(p, c)| (p, c)) {
            let dx = (wx - lx) as f32;
            let dy = (wy - ly) as f32;
            let dz = (wz - lz) as f32;
            let dist = (dx * dx + dy * dy + dz * dz).sqrt();
            if dist < lamp_radius {
                let contrib = mode.profile.falloff(dist, lamp_radius);
                l[0] += contrib * color[0];
                l[1] += contrib * color[1];
                l[2] += contrib * color[2];
            }
        }
        [l[0].clamp(0.0, 1.5), l[1].clamp(0.0, 1.5), l[2].clamp(0.0, 1.5)]
    };

    // Directional sun-raycast shadow: march a 3D DDA toward the sun (see `sun_direction`) for
    // SHADOW_RAY_STEPS world units; if any voxel the ray actually crosses is solid/occluding, the
    // origin voxel is in shadow. Hard two-tone (SUN_LIT/SUN_SHADOW) — no soft falloff. `sun_dir` is
    // constant for the whole region, so it's computed once above rather than per voxel.
    let shadow_at = |wx: i32, wy: i32, wz: i32| -> f32 {
        if !mode.shadows { return 1.0; }
        let hit = dda_march(
            wx as f32 + 0.5, wy as f32 + 0.5, wz as f32 + 0.5,
            sun_dir, SHADOW_RAY_STEPS as f32,
            |vx, vy, vz| obj_occludes(gb(vx, vy, vz).0),
        );
        if hit.is_some() { SUN_SHADOW } else { SUN_LIT }
    };

    // Directional face-shading baked into vertex colours — replaces normal-based lighting.
    // Magnitudes match the game's own fixed per-face shading table (cubeColors[] in
    // Geometry.c: {216,140,191,114,153,255} normalized); there's no real directional sun to
    // align to, just this fixed fake-AO pattern, so only the six magnitudes matter here.
    const SH_TOP: f32 = 1.00;
    const SH_BOT: f32 = 0.60;
    const SH_E:   f32 = 0.847; // east  (+X)
    const SH_W:   f32 = 0.447; // west  (-X)
    const SH_S:   f32 = 0.549; // south (+Y)
    const SH_N:   f32 = 0.749; // north (-Y)

    // Detect face kind from shade constant so per-face textures work without touching every call site.
    // SH_TOP → top face (2), SH_BOT → bottom face (1), anything else → side face (0).
    // Wedge diagonal blended shades ((SH_N+SH_W)*0.5 etc.) are not equal to SH_TOP/SH_BOT → side.
    macro_rules! face_kind {
        ($sh:expr) => {{
            let s: f32 = $sh;
            if s == SH_TOP { 2u8 } else if s == SH_BOT { 1u8 } else { 0u8 }
        }};
    }

    // Push UV coords for a quad (6 verts: ABD, BCD) covering atlas row with v in [v0,v1], into a
    // caller-chosen buffer (opaque `uv_f` or transparent `uv_ft`).
    //
    // `$nu` is how many block-sized tiles the quad spans along its U axis — 1 for every per-block
    // quad, and the merged width for a greedy-meshed face (see `FaceRec` below). U therefore runs
    // 0..$nu instead of 0..1, which needs `wrapS = RepeatWrapping` on the atlas texture; the atlas is
    // exactly one tile wide (`texturepack.rs`: `atlas_w = TILE`), so repeating in U re-tiles the same
    // column and never bleeds into a neighbouring row. **V has no such freedom** — the atlas is a
    // vertical strip and V selects the row, so tiling it would walk into the next block's texture.
    // That is why greedy merging only grows along V when no pack is loaded.
    macro_rules! push_quad_uv {
        ($buf:expr, $v0:expr, $v1:expr, $nu:expr) => {{
            let nu: f32 = $nu;
            $buf.extend_from_slice(&[
                0.0, $v0,  nu, $v0,  0.0, $v1,
                nu, $v0,   nu, $v1,  0.0, $v1,
            ]);
        }};
    }
    // Push UV coords for a triangle covering the same atlas row.
    macro_rules! push_tri_uv {
        ($buf:expr, $v0:expr, $v1:expr) => {
            $buf.extend_from_slice(&[0.0, $v0,  1.0, $v0,  0.5, $v1]);
        };
    }

    // Per-channel colour after light + face shading, capped so light can brighten a shaded face back
    // up to its flat paint colour but never past it — mirrors TerrainChunk.mm's
    // `if(color>paint[coord]*255) color=paint[coord]*255` (light recovers full colour, it doesn't
    // blow it out).
    // Flat (GPU-shadow) mode skips the per-face SH_* shading and lamp/shadow multiplier entirely —
    // Three.js supplies all lighting downstream. `$sh` is still passed to `face_kind!` in the macros
    // for texture selection; only the brightness multiply here is neutralised.
    let flat = mode.flat;
    macro_rules! lit_rgb {
        ($rgb2:expr, $sh:expr, $lm:expr) => {{
            let rgb2 = $rgb2;
            let sh: f32 = if flat { 1.0 } else { $sh };
            let lm: [f32; 3] = if flat { [1.0, 1.0, 1.0] } else { $lm };
            [
                rgb2[0] as f32 / 255.0 * (sh * lm[0]).min(1.0),
                rgb2[1] as f32 / 255.0 * (sh * lm[1]).min(1.0),
                rgb2[2] as f32 / 255.0 * (sh * lm[2]).min(1.0),
            ]
        }};
    }

    macro_rules! push_tri {
        ($verts:expr, $rgb:expr, $sh:expr, $lm:expr, $btype:expr, $bpaint:expr) => {{
            let fk = face_kind!($sh);
            let (rgb2, row_opt) = if let Some(p) = pack {
                texturepack::face_color_and_row(p, $btype, $bpaint, fk, $rgb)
            } else { ($rgb, None) };
            let [r,g,b] = lit_rgb!(rgb2, $sh, $lm);
            if flat && $btype == LAMP_BLOCK_TYPE {
                for (x,y,z) in $verts { pos_ef.extend_from_slice(&[x,y,z]); col_ef.extend_from_slice(&[r,g,b]); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_tri_uv!(uv_ef, v1, v0);
                }
            } else if let Some(alpha) = transparent_alpha($btype) {
                for (x,y,z) in $verts { pos_ft.extend_from_slice(&[x,y,z]); col_ft.extend_from_slice(&[r,g,b,alpha]); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_tri_uv!(uv_ft, v1, v0);
                }
            } else {
                for (x,y,z) in $verts { pos_f.extend_from_slice(&[x,y,z]); col_f.extend_from_slice(&[r,g,b]); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_tri_uv!(uv_f, v1, v0); // swap: $v0 arg → floor vertex, $v1 arg → apex; tile reads top→bottom
                }
            }
        }};
    }
    // Tiled quad: `$nu` block-tiles along U (1 for a per-block face, the merged width for a
    // greedy-meshed one). `push_quad!` below is the 1-tile wrapper every ramp/wedge/partial-fluid
    // call site uses.
    macro_rules! push_quad_t {
        ($a:expr,$b:expr,$c:expr,$d:expr,$rgb:expr,$sh:expr,$lm:expr,$btype:expr,$bpaint:expr,$nu:expr) => {{
            let fk = face_kind!($sh);
            let (rgb2, row_opt) = if let Some(p) = pack {
                texturepack::face_color_and_row(p, $btype, $bpaint, fk, $rgb)
            } else { ($rgb, None) };
            let [r,g,b_] = lit_rgb!(rgb2, $sh, $lm);
            if flat && $btype == LAMP_BLOCK_TYPE {
                for (x,y,z) in [$a,$b,$d, $b,$c,$d] { pos_ef.extend_from_slice(&[x,y,z]); col_ef.extend_from_slice(&[r,g,b_]); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_quad_uv!(uv_ef, v1, v0, $nu);
                }
            } else if let Some(alpha) = transparent_alpha($btype) {
                for (x,y,z) in [$a,$b,$d, $b,$c,$d] { pos_ft.extend_from_slice(&[x,y,z]); col_ft.extend_from_slice(&[r,g,b_,alpha]); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_quad_uv!(uv_ft, v1, v0, $nu);
                }
            } else {
                for (x,y,z) in [$a,$b,$d, $b,$c,$d] { pos_f.extend_from_slice(&[x,y,z]); col_f.extend_from_slice(&[r,g,b_]); }
                if let Some(p) = pack {
                    let ar = p.atlas_rows as f32;
                    let (v0, v1) = match row_opt { Some(row) => (row as f32/ar, (row+1) as f32/ar), None => (0.0, 1.0/ar) };
                    push_quad_uv!(uv_f, v1, v0, $nu); // swap: $v0 arg → A/B vertices, $v1 arg → C/D vertices; tile reads top→bottom
                }
            }
        }};
    }
    macro_rules! push_quad {
        ($a:expr,$b:expr,$c:expr,$d:expr,$rgb:expr,$sh:expr,$lm:expr,$btype:expr,$bpaint:expr) => {
            push_quad_t!($a,$b,$c,$d,$rgb,$sh,$lm,$btype,$bpaint, 1.0)
        };
    }

    for wz in sz1..=sz2 {
        for wy in sy1..=sy2 {
            for wx in sx1..=sx2 {
                let (bt, paint) = gb(wx, wy, wz);
                if bt == 0 { continue; }

                // A face is invisible if the neighbor fully occludes it, OR the neighbor is the same
                // block type as this voxel — two adjacent water/glass/fence blocks (all BI_NOTSOLID,
                // so `obj_occludes` alone says false) share a face that's never actually visible from
                // either side, but without this they both still emit it. For a deep water column this
                // is the difference between ~6 quads/block and 0 for every interior block.
                let face_hidden = |nbt: u8| obj_occludes(nbt) || nbt == bt;

                let is_ramp_or_wedge = matches!(bt, 24..=55);
                // Ramp/wedge branches below do their own neighbor lookups (their diagonal face is
                // unconditional, so there's no early-out for them); only plain cubes reuse these.
                let (n_top, n_bot, n_s, n_n, n_e, n_w) = if is_ramp_or_wedge {
                    (0, 0, 0, 0, 0, 0)
                } else {
                    (
                        gbz(wx, wy, wz + 1).0,
                        gbz(wx, wy, wz - 1).0,
                        gbz(wx, wy + 1, wz).0,
                        gbz(wx, wy - 1, wz).0,
                        gbz(wx + 1, wy, wz).0,
                        gbz(wx - 1, wy, wz).0,
                    )
                };
                // Cheap early-out: a plain cube with every face hidden emits nothing, so skip the
                // lamp/shadow lighting below entirely — that's the expensive part (O(lamps) per voxel
                // plus a 24-step shadow raymarch), today paid by every voxel even when nothing is drawn.
                if !is_ramp_or_wedge
                    && face_hidden(n_top) && face_hidden(n_bot)
                    && face_hidden(n_s) && face_hidden(n_n)
                    && face_hidden(n_e) && face_hidden(n_w)
                {
                    continue;
                }

                let rgb = block_color(bt, paint, world.sky);
                let base_lm = light_at(wx, wy, wz, bt);
                let shadow = shadow_at(wx, wy, wz);
                let lm = [base_lm[0] * shadow, base_lm[1] * shadow, base_lm[2] * shadow];
                let (x0,x1f) = (wx as f32, wx as f32+1.0);
                let (y0,y1f) = (wy as f32, wy as f32+1.0);
                let (z0,z1f) = (wz as f32, wz as f32+1.0);
                // Eden (X east, Y south, Z up) → Three.js Y-up: (ex, ez, ey).
                // Eden north = Three.js −Z so the camera faces −Z (north) and east (+X) is on the right.
                let o = |ex:f32,ey:f32,ez:f32| -> (f32,f32,f32) { (ex,ez,ey) };

                if matches!(bt, 24..=39) {
                    let dir = (bt-24)%4;
                    let ss = obj_occludes(gbz(wx,wy+1,wz).0);
                    let sn = obj_occludes(gbz(wx,wy-1,wz).0);
                    let se = obj_occludes(gbz(wx+1,wy,wz).0);
                    let sw = obj_occludes(gbz(wx-1,wy,wz).0);
                    if !obj_occludes(gbz(wx,wy,wz-1).0) {
                        push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y0,z0),o(x0,y0,z0),rgb,SH_BOT,lm,bt,paint);
                    }
                    match dir {
                        0 => {
                            if !ss { push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_S,lm,bt,paint); }
                            if !sw { push_tri!([o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f)],rgb,SH_W,lm,bt,paint); }
                            if !se { push_tri!([o(x1f,y1f,z0),o(x1f,y0,z0),o(x1f,y1f,z1f)],rgb,SH_E,lm,bt,paint); }
                            push_quad!(o(x0,y0,z0),o(x1f,y0,z0),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_TOP,lm,bt,paint);
                        }
                        1 => {
                            if !sw { push_quad!(o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_W,lm,bt,paint); }
                            if !ss { push_tri!([o(x0,y1f,z0),o(x1f,y1f,z0),o(x0,y1f,z1f)],rgb,SH_S,lm,bt,paint); }
                            if !sn { push_tri!([o(x1f,y0,z0),o(x0,y0,z0),o(x0,y0,z1f)],rgb,SH_N,lm,bt,paint); }
                            push_quad!(o(x1f,y0,z0),o(x1f,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_TOP,lm,bt,paint);
                        }
                        2 => {
                            if !sn { push_quad!(o(x1f,y0,z0),o(x0,y0,z0),o(x0,y0,z1f),o(x1f,y0,z1f),rgb,SH_N,lm,bt,paint); }
                            if !se { push_tri!([o(x1f,y0,z0),o(x1f,y1f,z0),o(x1f,y0,z1f)],rgb,SH_E,lm,bt,paint); }
                            if !sw { push_tri!([o(x0,y1f,z0),o(x0,y0,z0),o(x0,y0,z1f)],rgb,SH_W,lm,bt,paint); }
                            push_quad!(o(x1f,y1f,z0),o(x0,y1f,z0),o(x0,y0,z1f),o(x1f,y0,z1f),rgb,SH_TOP,lm,bt,paint);
                        }
                        _ => {
                            if !se { push_quad!(o(x1f,y1f,z0),o(x1f,y0,z0),o(x1f,y0,z1f),o(x1f,y1f,z1f),rgb,SH_E,lm,bt,paint); }
                            if !sn { push_tri!([o(x1f,y0,z0),o(x0,y0,z0),o(x1f,y0,z1f)],rgb,SH_N,lm,bt,paint); }
                            if !ss { push_tri!([o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f)],rgb,SH_S,lm,bt,paint); }
                            push_quad!(o(x0,y1f,z0),o(x0,y0,z0),o(x1f,y0,z1f),o(x1f,y1f,z1f),rgb,SH_TOP,lm,bt,paint);
                        }
                    }
                } else if matches!(bt, 40..=55) {
                    // Wedges are vertical triangular prisms: full Z height, triangle footprint in XY.
                    // Each wedge occupies the diagonal half of the block named by its direction —
                    // SE fills the NE-SE-SW triangle (cuts off the NW corner), etc.
                    // Two rectangular faces at the named sides + one diagonal 45° rectangular face.
                    let dir = (bt-40)%4;
                    let ss = obj_occludes(gbz(wx,wy+1,wz).0);
                    let sn = obj_occludes(gbz(wx,wy-1,wz).0);
                    let se = obj_occludes(gbz(wx+1,wy,wz).0);
                    let sw = obj_occludes(gbz(wx-1,wy,wz).0);
                    let s_top = obj_occludes(gbz(wx,wy,wz+1).0);
                    let s_bot = obj_occludes(gbz(wx,wy,wz-1).0);
                    match dir {
                        0 => { // SE: triangle NE(x1f,y0)-SE(x1f,y1f)-SW(x0,y1f). Diagonal NE↔SW faces NW.
                            if !s_bot { push_tri!([o(x1f,y0,z0),o(x1f,y1f,z0),o(x0,y1f,z0)],rgb,SH_BOT,lm,bt,paint); }
                            if !s_top { push_tri!([o(x1f,y0,z1f),o(x0,y1f,z1f),o(x1f,y1f,z1f)],rgb,SH_TOP,lm,bt,paint); }
                            if !se { push_quad!(o(x1f,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x1f,y0,z1f),rgb,SH_E,lm,bt,paint); }
                            if !ss { push_quad!(o(x1f,y1f,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x1f,y1f,z1f),rgb,SH_S,lm,bt,paint); }
                            push_quad!(o(x1f,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x1f,y0,z1f),rgb,(SH_N+SH_W)*0.5,lm,bt,paint);
                        }
                        1 => { // SW: triangle NW(x0,y0)-SW(x0,y1f)-SE(x1f,y1f). Diagonal NW↔SE faces NE.
                            if !s_bot { push_tri!([o(x0,y0,z0),o(x0,y1f,z0),o(x1f,y1f,z0)],rgb,SH_BOT,lm,bt,paint); }
                            if !s_top { push_tri!([o(x0,y0,z1f),o(x1f,y1f,z1f),o(x0,y1f,z1f)],rgb,SH_TOP,lm,bt,paint); }
                            if !sw { push_quad!(o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_W,lm,bt,paint); }
                            if !ss { push_quad!(o(x0,y1f,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y1f,z1f),rgb,SH_S,lm,bt,paint); }
                            push_quad!(o(x0,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y0,z1f),rgb,(SH_N+SH_E)*0.5,lm,bt,paint);
                        }
                        2 => { // NW: triangle NE(x1f,y0)-NW(x0,y0)-SW(x0,y1f). Diagonal NE↔SW faces SE.
                            if !s_bot { push_tri!([o(x1f,y0,z0),o(x0,y0,z0),o(x0,y1f,z0)],rgb,SH_BOT,lm,bt,paint); }
                            if !s_top { push_tri!([o(x1f,y0,z1f),o(x0,y1f,z1f),o(x0,y0,z1f)],rgb,SH_TOP,lm,bt,paint); }
                            if !sn { push_quad!(o(x1f,y0,z0),o(x0,y0,z0),o(x0,y0,z1f),o(x1f,y0,z1f),rgb,SH_N,lm,bt,paint); }
                            if !sw { push_quad!(o(x0,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x0,y0,z1f),rgb,SH_W,lm,bt,paint); }
                            push_quad!(o(x1f,y0,z0),o(x0,y1f,z0),o(x0,y1f,z1f),o(x1f,y0,z1f),rgb,(SH_S+SH_E)*0.5,lm,bt,paint);
                        }
                        _ => { // NE: triangle NW(x0,y0)-NE(x1f,y0)-SE(x1f,y1f). Diagonal NW↔SE faces SW.
                            if !s_bot { push_tri!([o(x0,y0,z0),o(x1f,y0,z0),o(x1f,y1f,z0)],rgb,SH_BOT,lm,bt,paint); }
                            if !s_top { push_tri!([o(x0,y0,z1f),o(x1f,y1f,z1f),o(x1f,y0,z1f)],rgb,SH_TOP,lm,bt,paint); }
                            if !sn { push_quad!(o(x0,y0,z0),o(x1f,y0,z0),o(x1f,y0,z1f),o(x0,y0,z1f),rgb,SH_N,lm,bt,paint); }
                            if !se { push_quad!(o(x1f,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x1f,y0,z1f),rgb,SH_E,lm,bt,paint); }
                            push_quad!(o(x0,y0,z0),o(x1f,y1f,z0),o(x1f,y1f,z1f),o(x0,y0,z1f),rgb,(SH_S+SH_W)*0.5,lm,bt,paint);
                        }
                    }
                } else {
                    // Cube with face culling. Non-fluids reuse the occludes-or-same-type rule; fluids
                    // get extra care so a mass of *mixed-level* water (e.g. Simulate Flow output) no
                    // longer emits stacked interior quads that z-fight through the translucent material:
                    //  • a lateral face against a same-base fluid is culled up to that neighbour's
                    //    surface height, leaving only the exposed step sliver (or nothing when covered);
                    //  • a cell with fluid directly above is "submerged" — it renders full height with
                    //    no top face, exactly like an interior block of a pool.
                    // Partial fluids (¾/½/¼, levels 3/2/1) that ARE the surface still sit at a level/4
                    // top (the wavy-water look, mirroring TerrainChunk.mm). Non-fluids: ztop == z1f,
                    // base_fluid None, so the branch collapses to plain occludes-or-same-type culling.
                    let base_fluid = fluid_base(bt);
                    let fl = fluid_level(bt);
                    let submerged = base_fluid.is_some_and(|bf| fluid_base(n_top) == Some(bf));
                    let ztop = if fl > 0 && fl < 4 && !submerged { z0 + fl as f32 / 4.0 } else { z1f };
                    // Block directly above each lateral neighbour — only fluids need it (to tell a
                    // submerged neighbour, which reaches full height, from a partial surface one).
                    let (nab_s, nab_n, nab_e, nab_w) = if base_fluid.is_some() {
                        (gbz(wx, wy + 1, wz + 1).0, gbz(wx, wy - 1, wz + 1).0,
                         gbz(wx + 1, wy, wz + 1).0, gbz(wx - 1, wy, wz + 1).0)
                    } else { (0, 0, 0, 0) };

                    // Surface height of a same-base fluid neighbour, in this cell's z units — how far up
                    // it occludes the shared face. A submerged neighbour (fluid above it) reaches z1f.
                    let neigh_surf = |ncell: u8, nabove: u8| -> f32 {
                        match fluid_level(ncell) {
                            0 => z0,
                            4 => z1f,
                            nfl => if fluid_base(nabove) == fluid_base(ncell) { z1f } else { z0 + nfl as f32 / 4.0 },
                        }
                    };
                    // (hidden?, face-bottom-z) for a lateral neighbour block `ncell` with `nabove` on top.
                    let lat = |ncell: u8, nabove: u8| -> (bool, f32) {
                        if obj_occludes(ncell) || ncell == bt { return (true, z0); }
                        if let Some(bf) = base_fluid {
                            if fluid_base(ncell) == Some(bf) {
                                let s = neigh_surf(ncell, nabove);
                                return (s >= ztop, s.min(ztop));
                            }
                        }
                        (false, z0)
                    };

                    // Greedy-merge bookkeeping. A face only defers to the merge pass when it covers its
                    // whole unit cell — i.e. it is a real 1×1 square that can tile with its neighbours.
                    // Partial-height fluid faces (a ¾/½/¼ surface, or a lateral sliver stepping down to
                    // a shallower neighbour) are not squares, so they emit immediately and unmerged,
                    // exactly as before. `key_lm` is the light the merge key compares: in flat mode
                    // `lit_rgb!` discards `lm` entirely, so folding it to a constant there lets a
                    // GPU-shadow render merge across lamp light it isn't going to bake anyway.
                    let full_top = ztop == z1f;
                    let key_lm = if flat { [1.0f32, 1.0, 1.0] } else { lm };
                    let key_lm = [key_lm[0].to_bits(), key_lm[1].to_bits(), key_lm[2].to_bits()];
                    let mut defer = |dir: u8, slice: i32, u: i32, v: i32| {
                        faces.push(FaceRec { dir, slice, bt, paint, lm: key_lm, v, u });
                    };

                    let top_hidden = obj_occludes(n_top) || n_top == bt
                        || base_fluid.is_some_and(|bf| fluid_base(n_top) == Some(bf));
                    if !top_hidden {
                        if full_top { defer(0, wz, wx, wy); }
                        else { push_quad!(o(x0,y0,ztop),o(x1f,y0,ztop),o(x1f,y1f,ztop),o(x0,y1f,ztop),rgb,SH_TOP,lm,bt,paint); }
                    }
                    let bot_hidden = obj_occludes(n_bot) || n_bot == bt
                        || base_fluid.is_some_and(|bf| fluid_base(n_bot) == Some(bf));
                    if !bot_hidden {
                        // The bottom face always sits at z0 and always spans the full cell.
                        defer(1, wz, wx, wy);
                    }
                    // A lateral face spans [zb, ztop]; it fills its cell only when that is the whole
                    // block. `zb != z0` means a fluid neighbour occluded the lower part of it.
                    let (h_s, zb_s) = lat(n_s, nab_s);
                    if !h_s {
                        if full_top && zb_s == z0 { defer(2, wy, wx, wz); }
                        else { push_quad!(o(x0,y1f,zb_s),o(x1f,y1f,zb_s),o(x1f,y1f,ztop),o(x0,y1f,ztop),rgb,SH_S,lm,bt,paint); }
                    }
                    let (h_n, zb_n) = lat(n_n, nab_n);
                    if !h_n {
                        if full_top && zb_n == z0 { defer(3, wy, wx, wz); }
                        else { push_quad!(o(x1f,y0,zb_n),o(x0,y0,zb_n),o(x0,y0,ztop),o(x1f,y0,ztop),rgb,SH_N,lm,bt,paint); }
                    }
                    let (h_e, zb_e) = lat(n_e, nab_e);
                    if !h_e {
                        if full_top && zb_e == z0 { defer(4, wx, wy, wz); }
                        else { push_quad!(o(x1f,y1f,zb_e),o(x1f,y0,zb_e),o(x1f,y0,ztop),o(x1f,y1f,ztop),rgb,SH_E,lm,bt,paint); }
                    }
                    let (h_w, zb_w) = lat(n_w, nab_w);
                    if !h_w {
                        if full_top && zb_w == z0 { defer(5, wx, wy, wz); }
                        else { push_quad!(o(x0,y0,zb_w),o(x0,y1f,zb_w),o(x0,y1f,ztop),o(x0,y0,ztop),rgb,SH_W,lm,bt,paint); }
                    }
                }
            }
        }
    }

    // ---- Greedy mesh pass ---------------------------------------------------------------------
    // Sorting collects the deferred faces into contiguous runs of "same direction, same plane, same
    // block, same light" — everything that may legally fuse — with each run already ordered (v, u),
    // which is the row-major scan order the rectangle sweep wants. It is also what makes the output
    // deterministic, which several tests lean on (a z-clipped render must be byte-identical to a
    // render of the equivalently truncated world).
    faces.sort_unstable();
    // The second in-plane axis may only grow when no texture pack is loaded: U tiles by repeating a
    // one-tile-wide atlas, but V *selects the row*, so growing it would run into the next block's
    // texture. See `push_quad_uv!`. Untextured (the default) gets the full 2D merge.
    let grow_v = pack.is_none();
    // Eden (X east, Y south, Z up) → Three.js Y-up, same mapping the voxel pass uses.
    let o = |ex: f32, ey: f32, ez: f32| -> (f32, f32, f32) { (ex, ez, ey) };
    // Reused across groups so a world of single-face groups (every block differently lit, e.g. sun
    // shadows on) doesn't pay an allocation per group.
    let mut idx: FxHashMap<(i32, i32), usize> = FxHashMap::default();
    let mut used: Vec<bool> = Vec::new();
    let mut gi = 0usize;
    while gi < faces.len() {
        let head = faces[gi];
        let mut gj = gi + 1;
        while gj < faces.len()
            && faces[gj].dir == head.dir && faces[gj].slice == head.slice
            && faces[gj].bt == head.bt && faces[gj].paint == head.paint && faces[gj].lm == head.lm
        { gj += 1; }
        let group = &faces[gi..gj];
        gi = gj;

        let rgb = block_color(head.bt, head.paint, world.sky);
        let lm = [f32::from_bits(head.lm[0]), f32::from_bits(head.lm[1]), f32::from_bits(head.lm[2])];

        idx.clear();
        used.clear();
        used.resize(group.len(), false);
        if group.len() > 1 {
            idx.extend(group.iter().enumerate().map(|(k, f)| ((f.v, f.u), k)));
        }

        for k in 0..group.len() {
            if used[k] { continue; }
            let (u0, v0) = (group[k].u, group[k].v);
            let mut w = 1i32;
            let mut h = 1i32;
            if group.len() > 1 {
                // Widen along u through unconsumed cells, then grow the whole run along v while every
                // cell of the next row is present and unconsumed. Scanning in (v, u) order guarantees
                // `k` is the rectangle's origin corner, so this covers the group exactly once.
                let free = |uu: i32, vv: i32| idx.get(&(vv, uu)).is_some_and(|&m| !used[m]);
                while free(u0 + w, v0) { w += 1; }
                if grow_v {
                    while (0..w).all(|du| free(u0 + du, v0 + h)) { h += 1; }
                }
                for dv in 0..h {
                    for du in 0..w {
                        if let Some(&m) = idx.get(&(v0 + dv, u0 + du)) { used[m] = true; }
                    }
                }
            } else {
                used[k] = true;
            }

            // Rebuild the world-space rectangle from (slice, u, v, w, h) — see the table on `FaceRec`.
            let (f0, f1) = (u0 as f32, (u0 + w) as f32);
            let (g0, g1) = (v0 as f32, (v0 + h) as f32);
            let s0 = head.slice as f32;
            let s1 = s0 + 1.0;
            let (bt, paint) = (head.bt, head.paint);
            let nu = w as f32;
            match head.dir {
                0 => push_quad_t!(o(f0,g0,s1),o(f1,g0,s1),o(f1,g1,s1),o(f0,g1,s1),rgb,SH_TOP,lm,bt,paint,nu),
                1 => push_quad_t!(o(f0,g1,s0),o(f1,g1,s0),o(f1,g0,s0),o(f0,g0,s0),rgb,SH_BOT,lm,bt,paint,nu),
                2 => push_quad_t!(o(f0,s1,g0),o(f1,s1,g0),o(f1,s1,g1),o(f0,s1,g1),rgb,SH_S,lm,bt,paint,nu),
                3 => push_quad_t!(o(f1,s0,g0),o(f0,s0,g0),o(f0,s0,g1),o(f1,s0,g1),rgb,SH_N,lm,bt,paint,nu),
                4 => push_quad_t!(o(s1,f1,g0),o(s1,f0,g0),o(s1,f0,g1),o(s1,f1,g1),rgb,SH_E,lm,bt,paint,nu),
                _ => push_quad_t!(o(s0,f0,g0),o(s0,f1,g0),o(s0,f1,g1),o(s0,f0,g1),rgb,SH_W,lm,bt,paint,nu),
            }
        }
    }

    let vertex_count = (pos_f.len()/3) as u32;
    let positions: Vec<u8> = pos_f.iter().flat_map(|f| f.to_le_bytes()).collect();
    let colors: Vec<u8> = col_f.iter().flat_map(|f| f.to_le_bytes()).collect();
    let uvs: Vec<u8> = uv_f.iter().flat_map(|f| f.to_le_bytes()).collect();

    let vertex_count_t = (pos_ft.len()/3) as u32;
    let positions_t: Vec<u8> = pos_ft.iter().flat_map(|f| f.to_le_bytes()).collect();
    let colors_t: Vec<u8> = col_ft.iter().flat_map(|f| f.to_le_bytes()).collect();
    let uvs_t: Vec<u8> = uv_ft.iter().flat_map(|f| f.to_le_bytes()).collect();

    let vertex_count_e = (pos_ef.len()/3) as u32;
    let positions_e: Vec<u8> = pos_ef.iter().flat_map(|f| f.to_le_bytes()).collect();
    let colors_e: Vec<u8> = col_ef.iter().flat_map(|f| f.to_le_bytes()).collect();
    let uvs_e: Vec<u8> = uv_ef.iter().flat_map(|f| f.to_le_bytes()).collect();

    ObjGeometryResult {
        positions, colors, uvs, vertex_count,
        positions_t, colors_t, uvs_t, vertex_count_t,
        positions_e, colors_e, uvs_e, vertex_count_e,
    }
}

/// Face-culled geometry for a single chunk (16×16 XY × a z band). For the 3D fly-through pane, which
/// streams meshes per chunk near the camera.
///
/// `z_min`/`z_max` (Stage 3 of the 3D-pane crash fix) clip the emitted band; omitted = the full
/// `0..=world_max_z` column, i.e. the pre-Stage-3 behaviour. The frontend sends a camera-relative
/// band so a 256z world doesn't cost 4× a 64z one per chunk; the **cutaway cap is applied here**,
/// not by the caller — `view_cap_z` is backend state (see `set_view_cap`), so composing it server-
/// side keeps the one source of truth. Both only ever *narrow* the range, so they compose by `min`.
/// The frontend still has to invalidate its chunk cache when the cap changes (it does — `viewCapZ`
/// is a `reloadAllChunks()` trigger in FlyView3D), which is why the band itself stays an explicit
/// parameter rather than being derived here too.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn get_chunk_geometry(
    state: tauri::State<'_, AppState>,
    cx: i32, cy: i32,
    night: bool, shadows: bool, sun_t: f32,
    gpu: Option<bool>,
    lamp_radius: Option<f32>,
    lighting_profile: Option<LightingProfile>,
    z_min: Option<i32>, z_max: Option<i32>,
) -> Result<ObjGeometryResult, String> {
    let profile = lighting_profile.unwrap_or_default();
    // Read guard: the lazily-built lamp index is interior-mutable (`LampIndex`), so streaming
    // chunk geometry for the 3D pane never blocks — or is blocked by — other readers.
    let ws = read_ws(&state);
    let empty = || ObjGeometryResult {
        positions: Vec::new(), colors: Vec::new(), uvs: Vec::new(), vertex_count: 0,
        positions_t: Vec::new(), colors_t: Vec::new(), uvs_t: Vec::new(), vertex_count_t: 0,
        positions_e: Vec::new(), colors_e: Vec::new(), uvs_e: Vec::new(), vertex_count_e: 0,
    };
    {
        let world = ws.world.as_ref().ok_or("No world loaded")?;
        // Defensive: only serve chunks inside the world's chunk grid. Out-of-range indices already scan
        // to all-air (empty geometry), but bailing early avoids the wasted 16×16×Z probe and documents
        // the frontend contract (local 0-based chunk indices).
        if cx < 0 || cy < 0 || cx as u32 >= world.w_chunks || cy as u32 >= world.h_chunks {
            return Ok(empty());
        }
        // Early-out on an unpopulated chunk. Eden only saves edited chunks, so on sparse worlds most
        // chunks streamed by the fly-through pane's radius sweep are entirely unwritten — without this
        // check they'd still pay the full 16×16×maxZ scan (~460K get_block_at lookups) just to discover
        // every voxel is air. This is the single biggest win available for fly-mode hitching on sparse
        // worlds; it does not affect worlds with contiguous chunk coverage (chunk_map hit on the first try).
        if !world.chunk_map.contains_key(&(cx + world.min_x, cy + world.min_y)) {
            return Ok(empty());
        }
    }
    // GPU-shadow mode emits flat colours (Three.js lights it); it overrides the baked night/shadow
    // toggles, which would otherwise double-shade. Baked night lamps are only gathered when night is
    // on and we're NOT in flat/GPU mode (GPU night uses real point lights on the frontend instead).
    let flat = gpu.unwrap_or(false);
    let baked_night = night && !flat;
    let lamp_r = lamp_radius.unwrap_or_else(|| profile.default_radius()).clamp(1.0, 64.0);
    let sx1 = cx * 16; let sy1 = cy * 16;

    let world = ws.world.as_ref().unwrap();
    // Gather lamps within reach of this chunk from the spatial index (O(lamps), not an O((16+2r)³)
    // voxel scan), resolving each lamp's colour from its own paint. `LampIndex::lamps_in_region`
    // scans just the handful of chunks this request needs, on demand — interior-mutable, so this
    // whole command needs only a read guard.
    let lamps: Vec<([i32; 3], [f32; 3])> = if baked_night {
        ws.lamp_index
            .lamps_in_region(world, sx1, sy1, sx1 + 15, sy1 + 15, lamp_r)
            .into_iter()
            .map(|p| {
                let (_, paint) = get_block_at(world, p[0], p[1], p[2]);
                let rgb = block_color(LAMP_BLOCK_TYPE, paint, world.sky);
                (p, [rgb[0] as f32 / 255.0, rgb[1] as f32 / 255.0, rgb[2] as f32 / 255.0])
            })
            .collect()
    } else {
        Vec::new()
    };

    let mode = LightMode {
        night: baked_night,
        shadows: shadows && !flat,
        sun_t: sun_t.clamp(0.0, 1.0),
        flat,
        lamp_radius: lamp_r,
        profile,
    };
    let t0 = std::time::Instant::now();
    // Emitted z band: the caller's camera band ∩ the cutaway cap ∩ the world's real z range. Clamped
    // (not rejected) so a nonsensical band degrades to a smaller render, never an error mid-stream;
    // an inverted or fully out-of-range band collapses to sz1 > sz2, and the emission loop then emits
    // nothing — the same empty result an all-air chunk gives.
    let max_z = world_max_z(world);
    let cap = ws.view_cap_z.unwrap_or(max_z);
    let sz1 = z_min.unwrap_or(0).clamp(0, max_z);
    let sz2 = z_max.unwrap_or(max_z).min(cap).clamp(0, max_z);
    let res = obj_geometry_region(world, ws.texture_pack.as_ref(), sx1, sy1, sx1 + 15, sy1 + 15, sz1, sz2, &lamps, mode, None); // FlyView3D streaming stays unmasked
    // Stage 0 instrumentation: per-chunk payload size, so a pathological chunk (a tall 256z cliff
    // face can emit >1 M verts / tens of MB) is identifiable next to the frontend's resident-bytes
    // HUD. Debug builds only — `timing_log!` compiles to nothing in release.
    crate::timing_log!(
        "[GEOM] chunk ({},{}) z{}..{} verts {}/{}/{} payload {:.2} MB in {:?}",
        cx, cy, sz1, sz2,
        res.vertex_count, res.vertex_count_t, res.vertex_count_e,
        res.wire_bytes() as f64 / (1 << 20) as f64,
        t0.elapsed(),
    );
    Ok(res)
}

/// One lamp light for the experimental GPU night path (real `THREE.PointLight`s). Position is in
/// Eden local block coords (voxel centre); the frontend maps Eden(x,y,z)→THREE(x,z,y). Colour is the
/// lamp's own paint, normalized 0..1.
#[derive(serde::Serialize)]
pub(crate) struct LampLight {
    pub x: f32, pub y: f32, pub z: f32,
    pub r: f32, pub g: f32, pub b: f32,
}

/// Returns the lamp blocks within `radius` blocks of a point, nearest-first (capped), for the GPU
/// night path. Reads the chunk-keyed lamp index (built lazily), so this is O(nearby lamps) rather
/// than a voxel scan. The frontend assigns the nearest N to a fixed pool of point lights.
#[tauri::command(async)]
pub(crate) fn get_lamps_near(
    state: tauri::State<'_, AppState>,
    x: f32, y: f32, z: f32, radius: f32,
) -> Result<Vec<LampLight>, String> {
    let ws = read_ws(&state);
    if ws.world.is_none() { return Err("No world loaded".into()); }
    let radius = radius.clamp(1.0, 512.0);
    let world = ws.world.as_ref().unwrap();
    let sx = x.floor() as i32;
    let sy = y.floor() as i32;
    let mut lamps: Vec<(f32, LampLight)> = ws.lamp_index
        .lamps_in_region(world, sx, sy, sx, sy, radius)
        .into_iter()
        .filter_map(|p| {
            let dx = p[0] as f32 + 0.5 - x;
            let dy = p[1] as f32 + 0.5 - y;
            let dz = p[2] as f32 + 0.5 - z;
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 > radius * radius { return None; }
            let (_, paint) = get_block_at(world, p[0], p[1], p[2]);
            let rgb = block_color(LAMP_BLOCK_TYPE, paint, world.sky);
            Some((d2, LampLight {
                x: p[0] as f32 + 0.5, y: p[1] as f32 + 0.5, z: p[2] as f32 + 0.5,
                r: rgb[0] as f32 / 255.0, g: rgb[1] as f32 / 255.0, b: rgb[2] as f32 / 255.0,
            }))
        })
        .collect();
    lamps.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    // Server-side cap — the frontend pool is smaller still, but bounding here keeps the IPC payload
    // tiny even on a lamp-dense world.
    const SERVER_CAP: usize = 64;
    lamps.truncate(SERVER_CAP);
    Ok(lamps.into_iter().map(|(_, l)| l).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use memmap2::MmapMut;

    /// Minimal single-chunk world (same layout as lib.rs's `make_test_world`, duplicated here since
    /// that helper lives in a `mod tests` private to lib.rs).
    fn make_test_world() -> LoadedWorld {
        const HEADER: usize = 4096;
        const CHUNK: usize = 32768;
        const ENTRY: usize = 16;
        let chunk_off: u32 = HEADER as u32;
        let ptr_off: u32 = (HEADER + CHUNK) as u32;
        let mut b = vec![0u8; HEADER + CHUNK + ENTRY];
        b[32..36].copy_from_slice(&ptr_off.to_le_bytes());
        b[40..49].copy_from_slice(b"TestWorld");
        let pe = HEADER + CHUNK;
        b[pe..pe + 2].copy_from_slice(&0i16.to_le_bytes());
        b[pe + 4..pe + 6].copy_from_slice(&0i16.to_le_bytes());
        b[pe + 8..pe + 12].copy_from_slice(&chunk_off.to_le_bytes());
        let mut m = MmapMut::map_anon(b.len()).expect("anon mmap");
        m.copy_from_slice(&b);
        crate::parse_world_inner(m).expect("parse failed")
    }

    /// Old-style voxel scan for lamps within `radius` of a region — the pre-index reference the
    /// production path (`get_chunk_geometry`) used to run inline. Kept in the test module both to
    /// build the lamp slice `obj_geometry_region` now expects and as the parity baseline for the
    /// index-based gather (`lamps_in_region`).
    fn scan_lamps(world: &LoadedWorld, sx1: i32, sy1: i32, sx2: i32, sy2: i32, sz1: i32, sz2: i32, radius: f32) -> Vec<([i32; 3], [f32; 3])> {
        let cache = ChunkCache::new(world);
        let r = radius.ceil() as i32;
        let mut found = Vec::new();
        for wz in (sz1 - r).max(0)..=(sz2 + r) {
            for wy in (sy1 - r)..=(sy2 + r) {
                for wx in (sx1 - r)..=(sx2 + r) {
                    let (bt, paint) = cache.get(wx, wy, wz);
                    if bt == LAMP_BLOCK_TYPE {
                        let rgb = block_color(bt, paint, world.sky);
                        found.push(([wx, wy, wz], [rgb[0] as f32 / 255.0, rgb[1] as f32 / 255.0, rgb[2] as f32 / 255.0]));
                    }
                }
            }
        }
        found
    }

    /// A block's side-face color (any face other than top/bottom) under a given `LightMode`,
    /// found by matching the shading multiplier used for side faces (SH_S etc, all < 1.0 and != SH_BOT).
    fn side_face_color(world: &LoadedWorld, x: i32, y: i32, z: i32, z2: i32, mode: LightMode) -> [f32; 3] {
        let radius = if mode.lamp_radius > 0.0 { mode.lamp_radius } else { mode.profile.default_radius() };
        let lamps = if mode.night { scan_lamps(world, x, y, x, y, z, z2, radius) } else { Vec::new() };
        let g = obj_geometry_region(world, None, x, y, x, y, z, z2, &lamps, mode, None);
        let floats: Vec<f32> = g.colors.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        // Plain-cube push order (see the `else` branch in obj_geometry_region): top, bottom, south,
        // north, east, west quads, 6 vertices × 3 floats each. South is the 3rd quad (index 2).
        let quad_floats = 6 * 3;
        let south_start = 2 * quad_floats;
        [floats[south_start], floats[south_start + 1], floats[south_start + 2]]
    }

    #[test]
    fn night_lighting_dims_and_lamps_dont_darken_faster_than_ambient() {
        let mut world = make_test_world();
        // Probe stone column at (3,5,0..1); lamp block directly above at z=3 (distance 3 < radius 5).
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz
        };
        world.bytes[block(3, 5, 0)] = 2; // Stone
        world.bytes[block(3, 5, 3)] = LAMP_BLOCK_TYPE;

        let day = side_face_color(&world, 3, 5, 0, 0, LightMode::default());
        let night = side_face_color(&world, 3, 5, 0, 0, LightMode { night: true, shadows: false, sun_t: 0.0, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy });

        for c in 0..3 {
            assert!(night[c] < day[c], "night lighting should dim an unlit block relative to full daylight");
            assert!(night[c] > 0.0, "ambient + lamp contribution should keep the block above pure black");
        }
    }

    #[test]
    fn lamp_light_is_tinted_by_the_lamp_paint_not_a_separate_colour_table() {
        let mut world = make_test_world();
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz
        };
        let paint = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz + 4096
        };
        world.bytes[block(3, 5, 0)] = 2; // Stone probe
        world.bytes[block(3, 5, 3)] = LAMP_BLOCK_TYPE;
        world.bytes[paint(3, 5, 3)] = 1; // PAINT_RGB[1] = [255,170,170] — red-dominant

        let night = side_face_color(&world, 3, 5, 0, 0, LightMode { night: true, shadows: false, sun_t: 0.0, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy });

        // A red-dominant lamp should tint the probe's lit colour red-dominant too: the red channel
        // should gain more (relative to its unlit value) than green/blue. Checked via the raw ratio
        // rather than absolute values since face shading differs per channel only through `lm`.
        assert!(night[0] > night[1] && night[0] > night[2],
            "red-painted lamp should cast red-dominant light, got {night:?}");
    }

    #[test]
    fn flat_mode_routes_lamp_faces_to_the_emissive_stream() {
        let mut world = make_test_world();
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz
        };
        world.bytes[block(3, 5, 0)] = LAMP_BLOCK_TYPE; // isolated lamp in air → all 6 faces emit

        // Non-flat (baked default): lamp faces stay in the opaque stream; the emissive stream is
        // untouched, so OBJ/JSON export and ThreeDPreview see byte-identical output.
        let baked = obj_geometry_region(&world, None, 3, 5, 3, 5, 0, 0, &[], LightMode::default(), None);
        assert_eq!(baked.vertex_count_e, 0, "default (non-flat) mode must not populate the emissive stream");
        assert!(baked.vertex_count > 0, "lamp faces belong to the opaque stream in non-flat mode");
        assert_eq!(baked.vertex_count_t, 0, "a lamp is opaque — nothing in the transparent stream");

        // Flat (GPU) mode: the same lamp faces move to the emissive stream; the opaque stream is empty.
        let flat = obj_geometry_region(&world, None, 3, 5, 3, 5, 0, 0, &[], LightMode { flat: true, ..Default::default() }, None);
        assert!(flat.vertex_count_e > 0, "flat mode must route lamp faces into the emissive stream");
        assert_eq!(flat.vertex_count, 0, "no non-lamp opaque faces expected for an isolated lamp");
        assert_eq!(flat.vertex_count_e, baked.vertex_count, "same lamp geometry, just a different stream");
    }

    /// Shaped-selection 3D preview: an unmasked column reads as air through the single block-getter,
    /// so it contributes no geometry, and the masked neighbour's face toward the hole now emits
    /// (the hole is treated as air for occlusion too). `None` renders the full box.
    #[test]
    fn test_obj_geometry_respects_mask() {
        let mut world = make_test_world();
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz
        };
        world.bytes[block(3, 5, 0)] = 2; // stone
        world.bytes[block(4, 5, 0)] = 2; // stone (adjacent in +x)

        // Full box (no mask): both cubes present; the shared face between them is culled.
        let full = obj_geometry_region(&world, None, 3, 5, 4, 5, 0, 0, &[], LightMode::default(), None);

        // Mask over bbox (3,5)-(4,5), only column (3,5) set.
        let mask = crate::SelectionMask { x1: 3, y1: 5, x2: 4, y2: 5, bits: vec![0b01] };
        let masked = obj_geometry_region(&world, None, 3, 5, 4, 5, 0, 0, &[], LightMode::default(), Some(&mask));

        assert!(masked.vertex_count > 0, "masked cell still emits geometry");
        // NB: vertex *counts* can't tell these apart any more — greedy meshing fuses the two cubes'
        // coplanar faces, so the 2×1 slab and the lone cube both come out as six quads. Compare the
        // geometry itself: the masked render must not reach past the surviving column at x=4.
        assert_ne!(masked.positions, full.positions, "the unmasked cube is gone");
        let max_x = masked.positions.chunks_exact(4).step_by(3)
            .map(|v| f32::from_le_bytes([v[0], v[1], v[2], v[3]]))
            .fold(f32::NEG_INFINITY, f32::max);
        assert_eq!(max_x, 4.0, "no vertex from the masked-out cube (which would reach x=5)");

        // Masking the neighbour exposes the +x face that was culled while it was solid: the surviving
        // cube renders exactly like a genuinely isolated one. Build that reference from a world whose
        // only solid block is (3,5,0), so its +x neighbour really is air.
        let mut lone_world = make_test_world();
        lone_world.bytes[block(3, 5, 0)] = 2;
        let isolated = obj_geometry_region(&lone_world, None, 3, 5, 3, 5, 0, 0, &[], LightMode::default(), None);
        assert_eq!(masked.vertex_count, isolated.vertex_count, "hole-facing side face emits (full cube)");
        assert_eq!(masked.positions, isolated.positions, "and is byte-identical to a genuinely lone cube");
    }

    /// Stage 3 (fly-view camera z band / cutaway phase 2): a z-clipped render must behave as if the
    /// world *ended* at the cut planes. The trap this pins is the see-through roof — face culling
    /// reads the real world through `gb`, so the block just above `sz2` would otherwise occlude the
    /// top face of the topmost emitted block, leaving a hole you can look straight through into the
    /// interior. Same in reverse at `sz1` for the floor.
    ///
    /// Reference: the identical column rendered *unclipped* in a world where the out-of-band blocks
    /// genuinely don't exist. Byte-identical output is the invariant — a clipped render is exactly a
    /// render of the truncated world.
    #[test]
    fn test_obj_geometry_z_clip_emits_cap_faces() {
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz
        };
        // Tall column z=0..=5 at (3,5), rendered clipped to the middle slab z=2..=4.
        let mut tall = make_test_world();
        for z in 0..=5 { tall.bytes[block(3, 5, z)] = 2; }
        let clipped = obj_geometry_region(&tall, None, 3, 5, 3, 5, 2, 4, &[], LightMode::default(), None);

        // Same three blocks, but z=1 and z=5 really are air — rendered over the whole world column so
        // no clipping is in play at all.
        let mut short = make_test_world();
        for z in 2..=4 { short.bytes[block(3, 5, z)] = 2; }
        let reference = obj_geometry_region(&short, None, 3, 5, 3, 5, 0, world_max_z(&short), &[], LightMode::default(), None);

        // 4 side faces (each greedy-merged into one 3-tall quad down the column) + the two cap faces
        // = 6 quads = 36 verts. Spelled out so a regression that silently drops the caps (24) or
        // double-emits fails loudly, not just "differs".
        assert_eq!(clipped.vertex_count, 6 * 6, "clipped slab emits 4 merged sides plus both cap faces");
        assert_eq!(clipped.vertex_count, reference.vertex_count);
        assert_eq!(clipped.positions, reference.positions, "a clipped render == a render of the truncated world");
        assert_eq!(clipped.colors, reference.colors);

        // Nothing escapes the band. THREE coords are (ex, ez, ey), so index 1 is Eden z; a block at
        // z spans [z, z+1].
        for v in clipped.positions.chunks_exact(4).skip(1).step_by(3) {
            let y = f32::from_le_bytes([v[0], v[1], v[2], v[3]]);
            assert!((2.0..=5.0).contains(&y), "vertex at z={y} outside the clipped band 2..=4");
        }
    }

    /// Degenerate bands emit nothing rather than erroring or wrapping: a band entirely above the
    /// terrain, and an inverted one (which `get_chunk_geometry`'s clamp can produce when the cutaway
    /// cap sits below the camera band). `for wz in sz1..=sz2` is empty when sz1 > sz2.
    #[test]
    fn test_obj_geometry_z_clip_degenerate_bands() {
        let mut world = make_test_world();
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz
        };
        for z in 0..=5 { world.bytes[block(3, 5, z)] = 2; }

        let above = obj_geometry_region(&world, None, 3, 5, 3, 5, 40, 48, &[], LightMode::default(), None);
        assert_eq!(above.vertex_count, 0, "band above the terrain emits nothing");
        let inverted = obj_geometry_region(&world, None, 3, 5, 3, 5, 4, 2, &[], LightMode::default(), None);
        assert_eq!(inverted.vertex_count, 0, "inverted band emits nothing");
    }

    // ---- Greedy meshing (Stage 5 of the 3D-pane crash fix) --------------------------------------

    /// Byte index of block `(lx, ly, z)`'s *type* in `make_test_world`'s single chunk.
    fn tblock(lx: usize, ly: usize, z: i32) -> usize {
        let band = (z / 16) as usize;
        let lz = (z % 16) as usize;
        4096 + band * 8192 + lx * 256 + ly * 16 + lz
    }

    /// The emitted opaque quads as `[(three_x, three_y, three_z); 6]` vertex tuples. Positions are
    /// non-indexed, 6 verts per quad, so the stream chunks exactly.
    fn quads(res: &ObjGeometryResult) -> Vec<[(f32, f32, f32); 6]> {
        let f: Vec<f32> = res.positions.chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        f.chunks_exact(18).map(|q| {
            let v = |i: usize| (q[i * 3], q[i * 3 + 1], q[i * 3 + 2]);
            [v(0), v(1), v(2), v(3), v(4), v(5)]
        }).collect()
    }

    /// As `quads`, but over the transparent stream (water/glass/fence/flower).
    fn quads_t(res: &ObjGeometryResult) -> Vec<[(f32, f32, f32); 6]> {
        let f: Vec<f32> = res.positions_t.chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        f.chunks_exact(18).map(|q| {
            let v = |i: usize| (q[i * 3], q[i * 3 + 1], q[i * 3 + 2]);
            [v(0), v(1), v(2), v(3), v(4), v(5)]
        }).collect()
    }

    /// Quads lying entirely in the horizontal plane `three_y == y` — i.e. the top faces of blocks at
    /// `z = y - 1` (bottom faces of the same blocks sit at `three_y == z`).
    fn quads_in_plane_y(res: &ObjGeometryResult, y: f32) -> Vec<[(f32, f32, f32); 6]> {
        quads(res).into_iter().filter(|q| q.iter().all(|v| v.1 == y)).collect()
    }

    /// The unit cells a set of horizontal quads covers, as `(x, eden_y)` integer pairs — panics on any
    /// cell covered twice, which is what makes "the merge tiles the footprint exactly" checkable.
    fn covered_cells(qs: &[[(f32, f32, f32); 6]]) -> HashSet<(i32, i32)> {
        let mut cells = HashSet::new();
        for q in qs {
            // THREE (ex, ez, ey): index 0 is Eden x, index 2 is Eden y.
            let x0 = q.iter().map(|v| v.0).fold(f32::INFINITY, f32::min) as i32;
            let x1 = q.iter().map(|v| v.0).fold(f32::NEG_INFINITY, f32::max) as i32;
            let y0 = q.iter().map(|v| v.2).fold(f32::INFINITY, f32::min) as i32;
            let y1 = q.iter().map(|v| v.2).fold(f32::NEG_INFINITY, f32::max) as i32;
            for x in x0..x1 {
                for y in y0..y1 {
                    assert!(cells.insert((x, y)), "cell ({x},{y}) covered by two merged quads");
                }
            }
        }
        cells
    }

    /// The headline win: a flat slab's whole exposed surface collapses to one quad per face
    /// direction, independent of how many blocks it is made of. 4×4×1 stone = 16 top + 16 bottom +
    /// 16 side faces unmerged (48 quads); merged it is 6.
    #[test]
    fn test_greedy_merge_flat_slab_collapses_to_one_quad_per_face() {
        let mut world = make_test_world();
        for x in 3..=6 { for y in 5..=8 { world.bytes[tblock(x, y, 0)] = 2; } }
        let g = obj_geometry_region(&world, None, 3, 5, 6, 8, 0, 0, &[], LightMode::default(), None);
        assert_eq!(g.vertex_count, 6 * 6, "top + bottom + four merged sides");

        // The single top quad really spans the whole 4×4 footprint, rather than six quads happening
        // to add up to the right count.
        let top = quads_in_plane_y(&g, 1.0);
        assert_eq!(top.len(), 1);
        assert_eq!(covered_cells(&top).len(), 16);
        assert_eq!(top[0].iter().map(|v| v.0).fold(f32::NEG_INFINITY, f32::max), 7.0, "x spans 3..7");
        assert_eq!(top[0].iter().map(|v| v.2).fold(f32::NEG_INFINITY, f32::max), 9.0, "eden y spans 5..9");
    }

    /// A non-rectangular footprint must be tiled *exactly* — every cell covered once, none twice, and
    /// nothing outside the shape. This is the property that makes the merge safe in general; the
    /// quad count is incidental (an L is two maximal rectangles).
    #[test]
    fn test_greedy_merge_tiles_an_l_shape_exactly() {
        let mut world = make_test_world();
        let shape = [(3, 5), (4, 5), (5, 5), (3, 6), (3, 7)];
        for &(x, y) in &shape { world.bytes[tblock(x, y, 0)] = 2; }
        let g = obj_geometry_region(&world, None, 3, 5, 5, 7, 0, 0, &[], LightMode::default(), None);

        let top = quads_in_plane_y(&g, 1.0);
        let cells = covered_cells(&top);
        let want: HashSet<(i32, i32)> = shape.iter().map(|&(x, y)| (x as i32, y as i32)).collect();
        assert_eq!(cells, want, "merged top faces cover the L and nothing else");
        assert_eq!(top.len(), 2, "an L is two maximal rectangles");
    }

    /// Faces only fuse when they render identically. A checkerboard of two block types shares no
    /// edge between same-typed cells, so nothing merges — the guard against a merge keyed on
    /// position alone, which would smear one material over its neighbour.
    #[test]
    fn test_greedy_merge_splits_on_block_type() {
        let mut world = make_test_world();
        for x in 3..=6 { for y in 5..=8 {
            world.bytes[tblock(x, y, 0)] = if (x + y) % 2 == 0 { 2 } else { 3 }; // stone / dirt
        } }
        let g = obj_geometry_region(&world, None, 3, 5, 6, 8, 0, 0, &[], LightMode::default(), None);
        let top = quads_in_plane_y(&g, 1.0);
        assert_eq!(top.len(), 16, "no two same-type cells are edge-adjacent, so no top face merges");
        assert_eq!(covered_cells(&top).len(), 16);
    }

    /// …and only when they are lit identically. Two adjacent stone blocks under night lighting sit at
    /// different distances from a lamp, so their top faces carry different colours and must stay
    /// separate quads — merging them would flatten the lamp falloff into one average.
    #[test]
    fn test_greedy_merge_splits_on_per_block_light() {
        let mut world = make_test_world();
        world.bytes[tblock(3, 5, 0)] = 2;
        world.bytes[tblock(4, 5, 0)] = 2;
        world.bytes[tblock(3, 5, 3)] = LAMP_BLOCK_TYPE;

        let day = obj_geometry_region(&world, None, 3, 5, 4, 5, 0, 0, &[], LightMode::default(), None);
        assert_eq!(quads_in_plane_y(&day, 1.0).len(), 1, "unlit: identical colour, one merged quad");

        let night_mode = LightMode { night: true, shadows: false, sun_t: 0.0, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy };
        let lamps = scan_lamps(&world, 3, 5, 4, 5, 0, 0, night_mode.profile.default_radius());
        let night = obj_geometry_region(&world, None, 3, 5, 4, 5, 0, 0, &lamps, night_mode, None);
        let top = quads_in_plane_y(&night, 1.0);
        assert_eq!(top.len(), 2, "lit differently → not merged");
        assert_eq!(covered_cells(&top).len(), 2);
    }

    /// Texture packs constrain the merge to one axis. The atlas is a vertical strip of per-block rows,
    /// so U can tile (it repeats the same one-tile-wide column) but V *selects the row* — growing V
    /// would run a merged quad into the next block's texture. A 3×3 wall therefore merges into three
    /// 3-wide rows with a pack loaded, and into a single quad without one, and every emitted V stays
    /// inside one atlas row either way.
    #[test]
    fn test_greedy_merge_with_texture_pack_tiles_u_only() {
        let mut world = make_test_world();
        for x in 3..=5 { for z in 0..=2 { world.bytes[tblock(x, 5, z)] = 2; } }

        let pack = texturepack::TexturePack {
            tile: 1,
            atlas_rgba: vec![255u8; 3 * 4], // tile 1×1 RGBA × 3 rows; only `atlas_rows` is read here
            atlas_rows: 3, // row 0 sentinel + 1 colour row + 1 grayscale row
            gray_row_offset: 1,
            name_to_row: [("stone".to_string(), 1u32)].into_iter().collect(),
        };

        // South (+Y) faces lie in the Eden-y = 6 plane → THREE z == 6.
        let south = |res: &ObjGeometryResult| -> Vec<[(f32, f32, f32); 6]> {
            quads(res).into_iter().filter(|q| q.iter().all(|v| v.2 == 6.0)).collect()
        };

        let bare = obj_geometry_region(&world, None, 3, 5, 5, 5, 0, 2, &[], LightMode::default(), None);
        assert_eq!(south(&bare).len(), 1, "untextured: the 3×3 wall face is one quad");

        let textured = obj_geometry_region(&world, Some(&pack), 3, 5, 5, 5, 0, 2, &[], LightMode::default(), None);
        assert_eq!(south(&textured).len(), 3, "textured: 3-wide rows, never merged vertically");

        // U tiles up to the merged width; V never leaves the single row it started in.
        let uv: Vec<f32> = textured.uvs.chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        assert!(!uv.is_empty(), "a loaded pack must emit UVs");
        let us: Vec<f32> = uv.iter().step_by(2).copied().collect();
        let vs: Vec<f32> = uv.iter().skip(1).step_by(2).copied().collect();
        assert_eq!(us.iter().cloned().fold(f32::NEG_INFINITY, f32::max), 3.0, "U tiles across the merged width");
        let vmin = vs.iter().cloned().fold(f32::INFINITY, f32::min);
        let vmax = vs.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let row_h = 1.0 / pack.atlas_rows as f32;
        assert!((vmax - vmin - row_h).abs() < 1e-6, "V spans exactly one atlas row ({vmin}..{vmax})");
    }

    /// Ramps and wedges are not unit squares, so they never enter the merge pass — and a plain-cube
    /// run must not merge *through* one as if the cell were empty or flat. A row of stone cubes with a
    /// stone ramp in the middle therefore yields two separate merged top quads (left of the ramp and
    /// right of it), covering exactly the cube cells and skipping the ramp's.
    #[test]
    fn test_greedy_merge_leaves_ramps_unmerged_and_splits_the_run_around_them() {
        let mut world = make_test_world();
        for x in 3..=7 { world.bytes[tblock(x, 5, 0)] = 2; } // stone row
        world.bytes[tblock(5, 5, 0)] = 24; // Stone Ramp (south) in the middle

        let g = obj_geometry_region(&world, None, 3, 5, 7, 5, 0, 0, &[], LightMode::default(), None);
        let top = quads_in_plane_y(&g, 1.0);
        // The ramp's own top is a sloped quad, not in the z=1 plane, so only the cubes' tops appear.
        assert_eq!(top.len(), 2, "the ramp splits the cube run into two merged quads");
        assert_eq!(
            covered_cells(&top),
            [(3, 5), (4, 5), (6, 5), (7, 5)].into_iter().collect::<HashSet<_>>(),
            "merged tops cover the cube cells and never the ramp's",
        );
    }

    /// Fluids: a face defers to the merge pass only when it fills its unit cell. Full-height water
    /// merges normally (and lands in the *transparent* stream, not the opaque one); a ½-height surface
    /// sits at z+0.5, so its top faces are not unit squares and must emit one per block, unmerged —
    /// merging them would be harmless here but the same gate protects the stepped-sliver lateral faces
    /// a mixed-level pool produces.
    #[test]
    fn test_greedy_merge_full_fluid_merges_partial_fluid_does_not() {
        let mut full = make_test_world();
        for x in 3..=6 { full.bytes[tblock(x, 5, 0)] = 20; } // Water, level 4
        let g = obj_geometry_region(&full, None, 3, 5, 6, 5, 0, 0, &[], LightMode::default(), None);
        assert_eq!(g.vertex_count, 0, "water is transparent — nothing in the opaque stream");
        let top: Vec<_> = quads_t(&g).into_iter().filter(|q| q.iter().all(|v| v.1 == 1.0)).collect();
        assert_eq!(top.len(), 1, "full-height water tops merge into one quad");
        assert_eq!(covered_cells(&top).len(), 4);

        let mut half = make_test_world();
        for x in 3..=6 { half.bytes[tblock(x, 5, 0)] = 60; } // Water ½, level 2
        let g = obj_geometry_region(&half, None, 3, 5, 6, 5, 0, 0, &[], LightMode::default(), None);
        let top: Vec<_> = quads_t(&g).into_iter().filter(|q| q.iter().all(|v| v.1 == 0.5)).collect();
        assert_eq!(top.len(), 4, "a ½-height surface is not a unit square — one quad per block");
        assert_eq!(covered_cells(&top).len(), 4);
    }

    #[test]
    fn shadows_darken_a_block_directly_under_an_overhang_at_high_noon() {
        let mut world = make_test_world();
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz
        };
        world.bytes[block(3, 5, 0)] = 2; // probe
        for z in 1..=10 { world.bytes[block(3, 5, z)] = 2; } // solid overhang directly above

        let unshadowed = side_face_color(&world, 3, 5, 0, 0, LightMode::default());
        // sun_t=0.5 -> near-overhead (elevation ~80deg), closest analogue to the old vertical scan.
        let shadowed = side_face_color(&world, 3, 5, 0, 0, LightMode { night: false, shadows: true, sun_t: 0.5, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy });

        for c in 0..3 {
            assert!(shadowed[c] < unshadowed[c], "a block under a solid overhang should be darker at high noon");
            assert!(shadowed[c] > 0.0, "shadowed colour must have a floor above pure black");
        }
    }

    #[test]
    fn low_sun_angle_does_not_darken_a_block_with_no_lateral_occluders() {
        let mut world = make_test_world();
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz
        };
        world.bytes[block(3, 5, 0)] = 2; // isolated probe, nothing else around

        let unshadowed = side_face_color(&world, 3, 5, 0, 0, LightMode::default());
        // sun_t=0.0 -> sunrise, low angle, nothing along the ray to occlude it.
        let lit_at_sunrise = side_face_color(&world, 3, 5, 0, 0, LightMode { night: false, shadows: true, sun_t: 0.0, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy });

        assert_eq!(lit_at_sunrise, unshadowed, "an isolated block with no occluders along the ray should stay fully lit");
    }

    #[test]
    fn shadowed_colour_is_never_pure_black() {
        let mut world = make_test_world();
        let block = |lx: usize, ly: usize, z: i32| -> usize {
            let band = (z / 16) as usize;
            let lz = (z % 16) as usize;
            4096 + band * 8192 + lx * 256 + ly * 16 + lz
        };
        world.bytes[block(3, 5, 0)] = 2;
        for z in 1..=10 { world.bytes[block(3, 5, z)] = 2; }

        let shadowed = side_face_color(&world, 3, 5, 0, 0, LightMode { night: false, shadows: true, sun_t: 0.5, flat: false, lamp_radius: 0.0, profile: LightingProfile::Legacy });
        for c in 0..3 {
            assert!(shadowed[c] > 0.05, "shadowed voxel colour must stay well above pure black, got {shadowed:?}");
        }
    }

    #[test]
    fn sun_direction_is_overhead_at_noon_and_low_angle_at_sunrise_sunset() {
        let noon = sun_direction(0.5);
        assert!(noon[2] > 0.9, "sun should be nearly straight up at t=0.5, got {noon:?}");
        let sunrise = sun_direction(0.0);
        assert!(sunrise[2] < 0.3, "sun should be low-angle at t=0.0, got {sunrise:?}");
        let sunset = sun_direction(1.0);
        assert!(sunset[2] < 0.3, "sun should be low-angle at t=1.0, got {sunset:?}");
    }

    /// Raw block-byte index for the test world's single chunk.
    fn tb(lx: usize, ly: usize, z: i32) -> usize {
        4096 + (z / 16) as usize * 8192 + lx * 256 + ly * 16 + (z % 16) as usize
    }

    /// The index-based lamp gather (`lamps_in_region`) must return exactly the same lamp positions
    /// as the old inline voxel scan for a given radius, and a larger radius must never drop lamps
    /// the smaller one found (it can only widen the box).
    #[test]
    fn lamps_in_region_matches_full_scan_and_radius_only_widens() {
        let mut world = make_test_world();
        // Two lamps in the single chunk, plus a decoy stone block that must not be picked up.
        world.bytes[tb(2, 3, 4)] = LAMP_BLOCK_TYPE;
        world.bytes[tb(10, 12, 20)] = LAMP_BLOCK_TYPE;
        world.bytes[tb(6, 6, 6)] = 2; // stone decoy

        let index = crate::build_lamp_index(&world);
        // build_lamp_index buckets by absolute chunk coord (0,0 here).
        assert_eq!(index.get(&(0, 0)).map(|v| v.len()), Some(2), "both lamps land in chunk (0,0)");

        let region = (0, 0, 15, 15);
        for &radius in &[1.0f32, 5.0, 12.0, 40.0] {
            let mut from_index = crate::lamps_in_region(&index, &world, region.0, region.1, region.2, region.3, radius);
            let mut from_scan: Vec<[i32; 3]> = scan_lamps(&world, region.0, region.1, region.2, region.3, 0, world_max_z(&world), radius)
                .into_iter().map(|(p, _)| p).collect();
            from_index.sort();
            from_scan.sort();
            assert_eq!(from_index, from_scan, "index gather must match the old voxel scan at radius {radius}");
        }
    }

    /// Regression: `obj_geometry_region` night output with index-gathered lamps must be byte-identical
    /// to the old scan-gathered lamps at the legacy radius 5 (the refactor is a pure speedup).
    #[test]
    fn night_geometry_unchanged_between_index_and_scan_gather() {
        let mut world = make_test_world();
        world.bytes[tb(3, 5, 0)] = 2; // stone probe
        world.bytes[tb(3, 5, 3)] = LAMP_BLOCK_TYPE;
        world.bytes[tb(3, 5, 3) + 4096] = 1; // red-ish paint on the lamp

        let mode = LightMode { night: true, shadows: false, sun_t: 0.0, flat: false, lamp_radius: 5.0, profile: LightingProfile::Legacy };

        // Old path: scan the region for lamps.
        let scan = scan_lamps(&world, 0, 0, 15, 15, 0, world_max_z(&world), 5.0);
        let g_scan = obj_geometry_region(&world, None, 0, 0, 15, 15, 0, world_max_z(&world), &scan, mode, None);

        // New path: gather from the index and resolve colours exactly as get_chunk_geometry does.
        let index = crate::build_lamp_index(&world);
        let idx_lamps: Vec<([i32; 3], [f32; 3])> = crate::lamps_in_region(&index, &world, 0, 0, 15, 15, 5.0)
            .into_iter().map(|p| {
                let (_, paint) = get_block_at(&world, p[0], p[1], p[2]);
                let rgb = block_color(LAMP_BLOCK_TYPE, paint, world.sky);
                (p, [rgb[0] as f32 / 255.0, rgb[1] as f32 / 255.0, rgb[2] as f32 / 255.0])
            }).collect();
        let g_idx = obj_geometry_region(&world, None, 0, 0, 15, 15, 0, world_max_z(&world), &idx_lamps, mode, None);

        assert_eq!(g_scan.colors, g_idx.colors, "night vertex colours must be identical (index vs scan gather)");
        assert_eq!(g_scan.positions, g_idx.positions, "geometry positions must be identical");
    }

    /// The memo must be a pure speedup: same answer as the uncached reader for every probe,
    /// including out-of-bounds Z, negative coords, and columns with no chunk at all (the case a
    /// naive "cache the address" memo gets wrong by not caching the *absence* of a chunk).
    #[test]
    fn chunk_cache_agrees_with_the_uncached_block_reader() {
        let mut world = make_test_world();
        world.bytes[tb(3, 5, 2)] = 2;
        world.bytes[tb(3, 5, 2) + 4096] = 7; // a paint byte, so we compare both halves of the tuple
        world.bytes[tb(0, 0, 0)] = 1;
        world.bytes[tb(15, 15, 17)] = 4; // crosses into the second band

        let cache = ChunkCache::new(&world);
        // Deliberately interleave in-chunk and out-of-chunk probes so a stale memo would show up.
        for wz in [-1, 0, 2, 17, 63, 64, 9999] {
            for wy in [-17, -1, 0, 5, 15, 16, 33] {
                for wx in [-17, -1, 0, 3, 15, 16, 33] {
                    assert_eq!(
                        cache.get(wx, wy, wz),
                        get_block_at(&world, wx, wy, wz),
                        "mismatch at ({wx},{wy},{wz})"
                    );
                }
            }
        }
    }

    #[test]
    fn pick_block_hits_the_first_solid_voxel_and_reports_the_entry_face() {
        let mut world = make_test_world();
        world.bytes[tb(3, 5, 2)] = 2; // Stone

        // Ray from above, straight down: enters through the top face (+Z normal).
        let hit = pick_block_in(&world, 3.5, 5.5, 9.0, 0.0, 0.0, -1.0, 32.0).unwrap().expect("expected a hit");
        assert_eq!((hit.x, hit.y, hit.z), (3, 5, 2));
        assert_eq!(hit.block_type, 2);
        assert_eq!((hit.nx, hit.ny, hit.nz), (0, 0, 1), "downward ray must enter the top face");

        // Ray from the west, heading east: enters through the -X face.
        let hit = pick_block_in(&world, 0.5, 5.5, 2.5, 1.0, 0.0, 0.0, 32.0).unwrap().expect("expected a hit");
        assert_eq!((hit.x, hit.y, hit.z), (3, 5, 2));
        assert_eq!((hit.nx, hit.ny, hit.nz), (-1, 0, 0), "eastward ray must enter the west face");

        // `hit + normal` is the empty voxel a placed block would occupy.
        assert_eq!(get_block_at(&world, hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz).0, 0);
    }

    #[test]
    fn pick_block_misses_return_none_and_respect_max_dist() {
        let mut world = make_test_world();
        world.bytes[tb(3, 5, 2)] = 2;

        // Parallel ray that never crosses the block.
        assert!(pick_block_in(&world, 0.5, 0.5, 8.5, 1.0, 0.0, 0.0, 32.0).unwrap().is_none());
        // Aimed correctly but stopped short: the block is ~6 units below the origin.
        assert!(pick_block_in(&world, 3.5, 5.5, 9.0, 0.0, 0.0, -1.0, 2.0).unwrap().is_none());
        // Same ray, enough distance.
        assert!(pick_block_in(&world, 3.5, 5.5, 9.0, 0.0, 0.0, -1.0, 32.0).unwrap().is_some());
    }

    #[test]
    fn pick_block_hits_a_voxel_the_origin_is_already_touching() {
        let mut world = make_test_world();
        world.bytes[tb(3, 5, 2)] = 2;
        // Origin sits in the air voxel directly above; the very first DDA step lands on the block,
        // so `prev` must still resolve to the origin voxel rather than an uninitialised one.
        let hit = pick_block_in(&world, 3.5, 5.5, 3.01, 0.0, 0.0, -1.0, 4.0).unwrap().expect("expected a hit");
        assert_eq!((hit.x, hit.y, hit.z), (3, 5, 2));
        assert_eq!((hit.nx, hit.ny, hit.nz), (0, 0, 1));
    }

    #[test]
    fn pick_block_rejects_a_degenerate_ray_direction() {
        let world = make_test_world();
        assert!(pick_block_in(&world, 3.5, 5.5, 9.0, 0.0, 0.0, 0.0, 32.0).is_err());
    }

    #[test]
    fn pick_block_hits_non_solid_blocks_like_water_and_glass() {
        let mut world = make_test_world();
        world.bytes[tb(3, 5, 2)] = 20; // Water — BI_NOTSOLID, so `obj_occludes` is false for it
        let hit = pick_block_in(&world, 3.5, 5.5, 9.0, 0.0, 0.0, -1.0, 32.0).unwrap().expect("water is pickable");
        assert_eq!(hit.block_type, 20);
    }

    // ── Audit C6: export volume guard ─────────────────────────────────────────

    /// A whole-world 256z export is ~15 trillion voxels — `export_json` would emit one JSON record
    /// each while holding the read guard, so it must be refused up front rather than started.
    #[test]
    fn test_export_volume_guard_refuses_whole_256z_world() {
        let err = check_export_volume(0, 0, 0, 7215, 8447, 255, "JSON")
            .expect_err("a whole 256z world is far past the budget");
        assert!(err.contains("15.6 billion"), "the message states the magnitude: {err}");
        assert!(err.contains("Select a smaller region"), "and what to do about it: {err}");
    }

    /// A selection at the budget is allowed; one voxel past it is not. The boundary matters —
    /// this is the same 256 M figure the clipboard uses, so the two guards agree.
    #[test]
    fn test_export_volume_guard_boundary() {
        let side = 16_000; // 16000 × 16000 × 1 = 256 M exactly
        assert_eq!(
            check_export_volume(0, 0, 0, side - 1, side - 1, 0, "OBJ").expect("at the budget"),
            MAX_EXPORT_VOXELS,
        );
        assert!(check_export_volume(0, 0, 0, side, side - 1, 0, "OBJ").is_err(), "one row over");
        // A realistic selection is nowhere near it.
        assert!(check_export_volume(100, 100, 0, 355, 355, 63, "OBJ").is_ok());
    }

    /// Degenerate/inverted bounds must not wrap into a small volume that slips past the guard.
    #[test]
    fn test_export_volume_guard_handles_degenerate_bounds() {
        assert_eq!(check_export_volume(10, 10, 5, 9, 9, 4, "OBJ").expect("empty"), 0);
    }

    #[test]
    fn test_fmt_big_reads_naturally() {
        assert_eq!(fmt_big(12_800), "12800");
        assert_eq!(fmt_big(256_000_000), "256 million");
        assert_eq!(fmt_big(1_600_000_000), "1.6 billion");
        assert_eq!(fmt_big(15_600_000_000_000), "15.6 trillion");
    }
}
