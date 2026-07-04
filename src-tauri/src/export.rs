//! Static geometry export: OBJ, JSON block dump, and MagicaVoxel .vox.
use crate::colors::{block_color, transparent_alpha, BI_NOTSOLID, BI_RAMPORSIDE, BLOCK_INFO};
use crate::{serialize_bytes_b64, world_max_z, AppState, LoadedWorld};
use crate::texturepack;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufWriter, Write};
use tauri::Emitter;

// ── OBJ Export ────────────────────────────────────────────────────────────────

pub(crate) fn get_block_at(world: &LoadedWorld, wx: i32, wy: i32, wz: i32) -> (u8, u8) {
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
    state: tauri::State<'_, AppState>,
    path: String,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<(), String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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

#[tauri::command(async)]
pub(crate) fn export_json(
    state: tauri::State<'_, AppState>,
    path: String,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<u32, String> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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

#[tauri::command(async)]
pub(crate) fn export_vox(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<u32, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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
pub(crate) struct ObjGeometryResult {
    #[serde(serialize_with = "serialize_bytes_b64")]
    positions: Vec<u8>, // LE f32 triplets (x,y,z) per vertex
    #[serde(serialize_with = "serialize_bytes_b64")]
    colors: Vec<u8>,    // LE f32 triplets (r,g,b 0..1) per vertex
    #[serde(serialize_with = "serialize_bytes_b64")]
    uvs: Vec<u8>,       // LE f32 pairs (u,v) per vertex; empty when no texture pack loaded
    vertex_count: u32,
}

#[tauri::command(async)]
pub(crate) fn get_obj_geometry(
    state: tauri::State<'_, AppState>,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> Result<ObjGeometryResult, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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
pub(crate) fn obj_geometry_region(world: &LoadedWorld, pack: Option<&texturepack::TexturePack>, sx1: i32, sy1: i32, sx2: i32, sy2: i32, sz1: i32, sz2: i32) -> ObjGeometryResult {
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
#[tauri::command(async)]
pub(crate) fn get_chunk_geometry(
    state: tauri::State<'_, AppState>,
    cx: i32, cy: i32,
) -> Result<ObjGeometryResult, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
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

