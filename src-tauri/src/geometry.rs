//! The Tauri shell around the shared 3D geometry pipeline.
//!
//! The pipeline itself — per-chunk face-culled/greedy-meshed mesh generation, directional
//! face-shading, night-lighting + sun-shadow previews, voxel picking, and the lamp spatial index —
//! moved to `voxel-core` (plan PR-C): it is pure voxel work, generic over `VoxelView`, and knows
//! nothing about worlds, locks or IPC. What stays here is everything that does — the
//! `RwLock<WorldState>` guards, `LoadedWorld`, the texture pack, the cutaway cap, and the binary
//! IPC envelope.
//!
//! ⚠️ `ObjGeometryResult` is the crate's type, so its `IpcResponse` impl can't live on it (orphan
//! rule) — `ChunkGeometry` below is the newtype that carries the framing. Keep it free of
//! `Serialize`: tauri's blanket `impl<T: Serialize>` would silently win and revert the payload to
//! base64-in-JSON (audit H2).
use crate::{read_ws, AppState};
use voxel_core::geometry::{self, CompactGeometry, LightMode, LightingProfile, ObjGeometryResult, PickResult};
use voxel_core::lamps::{self, LampLight};

/// IPC newtype over the crate's mesh result — see the module note on why this exists. One variant
/// per wire format: `get_chunk_geometry`'s `format` param picks it per call, which is what lets each
/// app move to v2 on its own schedule (ROADMAP-EDIT 18.14 — VuencEdit asks for v2, VuencLink's own
/// command still serves v1).
pub(crate) enum ChunkGeometry {
    /// v1: non-indexed LE `f32` streams.
    F32(ObjGeometryResult),
    /// v2: compact indexed (`Int16×4` position, `Uint8×4` colour, `Uint16×2` uv, `Uint16`/`Uint32`
    /// index) — see `voxel_core::geometry::CompactGeometry`.
    Compact(CompactGeometry),
}

impl ChunkGeometry {
    fn wire_bytes(&self) -> usize {
        match self { ChunkGeometry::F32(g) => g.wire_bytes(), ChunkGeometry::Compact(g) => g.wire_bytes() }
    }
    fn vertex_counts(&self) -> [u32; 3] {
        match self {
            ChunkGeometry::F32(g) => [g.vertex_count, g.vertex_count_t, g.vertex_count_e],
            ChunkGeometry::Compact(g) => g.streams.each_ref().map(|s| s.vertex_count),
        }
    }
}

/// Scalar half of the binary envelope (audit H2). `lens` gives the byte length of each of the nine
/// buffers, in the order they are concatenated into the body, so the JS side can slice them apart
/// without re-deriving sizes from the vertex counts (`uvs*` are empty when no texture pack is
/// loaded, and `colors_t` is 4 floats per vertex where the others are 3 or 2).
#[derive(serde::Serialize)]
struct ObjGeometryHeader {
    vertex_count: u32,
    vertex_count_t: u32,
    vertex_count_e: u32,
    lens: [u32; 9],
}

/// v2 header. The body is the twelve sections of `CompactGeometry::buffers` — per stream
/// (opaque, transparent, emissive): positions, colours, uvs, indices — each a multiple of 4 bytes, so
/// every section starts 4-aligned in the (4-aligned) body and the JS side views them in place.
/// `format` is what tells the decoder which header it has (v1's has none).
#[derive(serde::Serialize)]
struct CompactGeometryHeader {
    format: u8,
    /// Three-space mesh position; vertices are `origin + position * pos_scale`.
    origin: [f32; 3],
    pos_scale: f32,
    /// 0 = no texture pack. With one, the atlas texture maps the integer UVs with
    /// `repeat = (0.5, 1 / atlas_rows)`.
    atlas_rows: u32,
    streams: [CompactStreamHeader; 3],
}

#[derive(serde::Serialize)]
struct CompactStreamHeader {
    vertex_count: u32,
    index_count: u32,
    index_u32: bool,
    /// Byte lengths of positions, colours, uvs, indices.
    lens: [u32; 4],
}

impl tauri::ipc::IpcResponse for ChunkGeometry {
    fn body(self) -> tauri::Result<tauri::ipc::InvokeResponseBody> {
        match self {
            ChunkGeometry::F32(g) => {
                let bufs = g.buffers();
                let mut lens = [0u32; 9];
                for (i, b) in bufs.iter().enumerate() { lens[i] = b.len() as u32; }
                let header = ObjGeometryHeader {
                    vertex_count: g.vertex_count,
                    vertex_count_t: g.vertex_count_t,
                    vertex_count_e: g.vertex_count_e,
                    lens,
                };
                crate::ipc_envelope(&header, &bufs)
            }
            ChunkGeometry::Compact(g) => {
                let header = CompactGeometryHeader {
                    format: 2,
                    origin: g.origin,
                    pos_scale: 1.0 / geometry::COMPACT_POS_SUBDIV,
                    atlas_rows: g.atlas_rows,
                    streams: g.streams.each_ref().map(|s| CompactStreamHeader {
                        vertex_count: s.vertex_count,
                        index_count: s.index_count,
                        index_u32: s.index_u32,
                        lens: [s.positions.len(), s.colors.len(), s.uvs.len(), s.indices.len()].map(|n| n as u32),
                    }),
                };
                crate::ipc_envelope(&header, &g.buffers())
            }
        }
    }
}

/// Exposes the legacy/modern default lamp radii + the shadow ray length to the frontend so the
/// edit-sync reload radius (FlyView3D: a placed lamp/block can affect neighboring chunks up to these
/// distances away when night lighting or shadows are on) can't silently drift out of sync with the
/// Rust constants.
#[tauri::command]
pub(crate) fn get_light_constants() -> geometry::LightConstants {
    geometry::light_constants()
}

/// Casts a ray through the voxel grid and returns the first non-air block it enters, or `None`.
///
/// Origin and direction are in **Eden** coords (X east, Y south, Z up) — the caller owns the
/// Three.js↔Eden transform, so this stays a pure world-space query usable by any viewport.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn pick_block(
    state: tauri::State<'_, AppState>,
    ox: f32, oy: f32, oz: f32,
    dx: f32, dy: f32, dz: f32,
    max_dist: f32,
) -> Result<Option<PickResult>, String> {
    let ws = read_ws(&state);
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    geometry::pick_block_in(world, ox, oy, oz, dx, dy, dz, max_dist)
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
///
/// `format`: 1 (default) = the v1 f32 streams, 2 = the compact indexed v2 (ROADMAP-EDIT 18.14,
/// ~2.5× smaller). VuencEdit's FlyView3D always asks for 2.
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
    format: Option<u8>,
) -> Result<ChunkGeometry, String> {
    let compact = match format.unwrap_or(1) {
        1 => false,
        2 => true,
        f => return Err(format!("Unknown geometry format {f}")),
    };
    // Read guard: the lazily-built lamp index is interior-mutable (`LampIndex`), so streaming
    // chunk geometry for the 3D pane never blocks — or is blocked by — other readers.
    let ws = read_ws(&state);
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let meta = world.meta();
    let mode = LightMode::resolve(
        night, shadows, sun_t,
        gpu.unwrap_or(false), lamp_radius, lighting_profile.unwrap_or_default(),
    );
    // Baked night lamps are only gathered when night survived `resolve` (GPU night uses real point
    // lights on the frontend instead). `LampIndex::lamps_in_region` scans just the handful of chunks
    // this request needs, on demand — interior-mutable, so this whole command needs only a read guard.
    let (sx1, sy1) = (cx * 16, cy * 16);
    let lamps = if mode.night {
        lamps::lamps_with_color(&ws.lamp_index, world, meta, sx1, sy1, sx1 + 15, sy1 + 15, mode.lamp_radius)
    } else {
        Vec::new()
    };

    let t0 = std::time::Instant::now();
    let (sz1, sz2) = geometry::emitted_band(world, z_min, z_max, ws.view_cap_z);
    let pack = ws.texture_pack.as_ref();
    let res = if compact {
        ChunkGeometry::Compact(geometry::chunk_geometry_compact(world, meta, pack, &lamps, cx, cy, mode, z_min, z_max, ws.view_cap_z))
    } else {
        ChunkGeometry::F32(geometry::chunk_geometry(world, meta, pack, &lamps, cx, cy, mode, z_min, z_max, ws.view_cap_z))
    };
    let [vc, vc_t, vc_e] = res.vertex_counts();
    // Stage 0 instrumentation: per-chunk payload size, so a pathological chunk (a tall 256z cliff
    // face can emit >1 M verts / tens of MB) is identifiable next to the frontend's resident-bytes
    // HUD. Debug builds only — `timing_log!` compiles to nothing in release.
    crate::timing_log!(
        "[GEOM] chunk ({},{}) z{}..{} v{} verts {}/{}/{} payload {:.2} MB in {:?}",
        cx, cy, sz1, sz2, if compact { 2 } else { 1 },
        vc, vc_t, vc_e,
        res.wire_bytes() as f64 / (1 << 20) as f64,
        t0.elapsed(),
    );
    Ok(res)
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
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    Ok(lamps::lamps_near(&ws.lamp_index, world, world.meta(), x, y, z, radius))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{IpcResponse, InvokeResponseBody};

    /// The v2 envelope: the header's per-stream `lens` tile the body exactly, and every section starts
    /// 4-aligned (the JS decoder views `Int16`/`Uint16`/`Uint32` arrays in place).
    #[test]
    fn compact_envelope_sections_tile_the_body_aligned() {
        let ws = crate::tests::ws_with(crate::tests::make_bumpy_world_grid(2, 8, |x, y| 10 + (x + y) % 20));
        let world = ws.world.as_ref().unwrap();
        let g = geometry::chunk_geometry_compact(world, world.meta(), None, &[], 1, 0, LightMode::default(), None, None, None);
        assert!(g.streams[0].vertex_count > 0);
        let InvokeResponseBody::Raw(bytes) = ChunkGeometry::Compact(g).body().unwrap() else { panic!("raw body") };
        let hlen = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        assert_eq!((4 + hlen) % 4, 0, "body starts 4-aligned");
        let h: serde_json::Value = serde_json::from_slice(&bytes[4..4 + hlen]).unwrap();
        assert_eq!(h["format"], 2);
        assert_eq!(h["origin"], serde_json::json!([16.0, 0.0, 0.0]));
        assert_eq!(h["pos_scale"], 1.0 / 16.0);
        let lens: Vec<u64> = h["streams"].as_array().unwrap().iter()
            .flat_map(|s| s["lens"].as_array().unwrap().iter().map(|l| l.as_u64().unwrap()).collect::<Vec<_>>())
            .collect();
        assert_eq!(lens.len(), 12);
        assert!(lens.iter().all(|l| l % 4 == 0), "every section is a multiple of 4 bytes: {lens:?}");
        assert_eq!(lens.iter().sum::<u64>() as usize, bytes.len() - 4 - hlen);
    }
}
