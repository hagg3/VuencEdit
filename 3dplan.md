# 3D Fly-Through Preview — Implementation Plan

## Architecture: Separate Binary (Phase 1)

Build `src-tauri/src/bin/viewer3d.rs` as a second binary in the same Cargo workspace. The main editor launches it via `std::process::Command --world <path>`. The viewer mmaps the `.eden` file read-only — zero copy, zero IPC. Camera/input runs in its own winit event loop.

**Trade-off on unsaved edits:** auto-save to a temp file before launching, or prompt "Save to preview?".

Option B (in-process Tauri native window with wgpu surface) is deferred — macOS NSView/CAMetalLayer threading restrictions make it complex. Do Option A first.

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `[[bin]] viewer3d` + optional deps: wgpu 22, winit 0.30, bytemuck under `[features] viewer3d` |
| `src-tauri/src/world_format.rs` | **New** — `WorldReader<'a>` read-only parser extracted from lib.rs (parse_world_inner logic, block_at, paint_at) |
| `src-tauri/src/colors.rs` | **New** — `block_color()`, `hsl_to_rgb()`, `block_hls()`, `paint_hls()`, `grass_color()`, `transparent_alpha()` extracted from lib.rs |
| `src-tauri/src/lib.rs` | `mod world_format; mod colors;` + add `source_path: Option<PathBuf>` to WorldState + `open_3d_view` command |
| `src-tauri/src/bin/viewer3d.rs` | **New binary** — winit event loop + wgpu renderer + WorldReader |
| `src/App.tsx` | "3D View" button in View ▾ menu → `invoke("open_3d_view")` |
| `src-tauri/tauri.conf.json` | `externalBin` entry to bundle + sign viewer3d on macOS |

---

## 1. Cargo additions

```toml
[[bin]]
name = "viewer3d"
path = "src/bin/viewer3d.rs"

[dependencies]
wgpu     = { version = "22", optional = true }
winit    = { version = "0.30", optional = true }
bytemuck = { version = "1", features = ["derive"], optional = true }

[features]
viewer3d = ["dep:wgpu", "dep:winit", "dep:bytemuck"]
```

Build: `cargo build --bin viewer3d --features viewer3d`  
Main Tauri app never enables `viewer3d` — stays lean.

---

## 2. WorldReader (world_format.rs)

Read-only sibling to LoadedWorld — borrows `&[u8]` instead of owning MmapMut:

```rust
pub struct WorldReader<'a> {
    bytes:     &'a [u8],
    chunk_map: HashMap<(i32,i32), usize>,
    chunk_size: usize,
    num_bands: usize,
    pub min_x: i32, pub min_y: i32,
    pub w_chunks: u32, pub h_chunks: u32,
    pub sky: u8,
}

impl<'a> WorldReader<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, String> { /* same parse logic as lib.rs */ }
    pub fn block_at(&self, wx: i32, wy: i32, wz: i32) -> u8
    pub fn paint_at(&self, wx: i32, wy: i32, wz: i32) -> u8
    pub fn max_z(&self) -> usize { self.num_bands * 16 }
}
```

Block addressing (same as lib.rs): `addr + band*8192 + lx*256 + ly*16 + lz`

In viewer:
```rust
let file  = std::fs::File::open(path)?;
let mmap  = unsafe { MmapOptions::new().map(&file) }?;  // read-only, shares OS page cache
let world = WorldReader::parse(&mmap[..])?;
```

---

## 3. Launcher command (lib.rs)

Add `source_path: Option<std::path::PathBuf>` to WorldState (set in `load_world`).

```rust
#[tauri::command]
fn open_3d_view(state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let path = {
        let ws = state.lock().unwrap();
        ws.source_path.clone().ok_or("Save the world before opening 3D preview")?
    };
    let viewer = app.path().resource_dir()?.join("viewer3d");
    std::process::Command::new(viewer).arg("--world").arg(path).spawn()?;
    Ok(())
}
```

Register in `generate_handler![]`.

---

## 4. Face culling / meshing

Emit only faces adjacent to air or transparent blocks (~80–90% face reduction on terrain).

**Vertex layout** (10 bytes, no UV):
```rust
#[repr(C)] #[derive(bytemuck::Pod, bytemuck::Zeroable)]
struct Vertex {
    pos:        [i16; 3],  // world-space block corner
    color:      [u8;  3],  // RGB from block_color()
    normal_idx: u8,        // 0–5 for simple diffuse shading
    _pad:       u8,
}
```

Memory: ~500 KB GPU VRAM per chunk worst case; typical terrain much less.

---

## 5. Render distance

```
radius = 2  →  5×5  = 25 chunks  ≈ 12 MB VRAM  (default)
radius = 3  →  7×7  = 49 chunks  ≈ 25 MB VRAM
radius = 4  →  9×9  = 81 chunks  ≈ 40 MB VRAM
```

Chunk streaming: on camera move, drop far meshes, enqueue new visible chunks for async CPU mesh build → GPU upload via background thread + mpsc channel.

---

## 6. Render pipeline (wgpu)

Minimal pipeline — no textures, no shadows, no PBR:

```wgsl
// vertex: local pos → clip space via camera VP matrix + chunk offset uniform
// fragment: vertex color * (0.6 + 0.4 * NdotL)  — simple sun diffuse
```

One draw call per loaded chunk. Sky color from world's `sky` byte (same `grass_color`/sky logic).

---

## 7. Camera controls (winit, zero IPC)

| Input | Action |
|-------|--------|
| RMB drag | Look (yaw/pitch) |
| WASD | Fly horizontal |
| Space / Shift | Fly up / down |
| Scroll | Adjust speed |
| F | Fit to world bounds |
| +/- | Adjust render radius |
| Esc | Close |

---

## 8. Phase 2 (after Phase 1 ships)

- Async chunk mesh build on 1–2 background threads
- Z clip slider (keyboard +/-) to cut underground/sky clutter
- Greedy meshing (5–20× face reduction on flat terrain)
- Ambient occlusion (corner darkening)
- Selection highlight box (pass `--sel x1,y1,x2,y2` CLI arg)

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Unsaved edits not visible | Auto-save to temp before launch |
| macOS code signing | `externalBin` in tauri.conf.json — Tauri signs automatically |
| wgpu unavailable (VM) | Falls back to llvmpipe software renderer |
| `source_path` not set | Error: "Save the world before opening 3D preview" |
| Linux Wayland | Test X11 first; `WINIT_UNIX_BACKEND=x11` fallback |
