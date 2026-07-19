//! Source Engine (Hammer) VMF export.
//!
//! Stage 1: merges same-`(block_type, paint)` opaque solid voxels (filtered via `obj_occludes`,
//! i.e. not air / `BI_NOTSOLID` / `BI_RAMPORSIDE`) into maximal axis-aligned boxes — a 3D
//! generalization of `greedy_mesh_2d`'s row→rect scan (row→rect→box, Z extended last) — and emits
//! each box as a 6-sided VMF `solid`. Honors the non-rectangular `SelectionMask` from day one
//! (columns excluded from the merge *input*, like `get_obj_geometry`).
//!
//! Stage 2 (this pass): ramps (24–39) and wedges (40–55) emit as 5-sided convex prism brushes —
//! one brush per cell, no colinear-run merging (documented future optimization) — by porting
//! `emit_ramp`/`emit_wedge`'s exact per-direction vertex geometry with culling removed (a VMF
//! brush needs every bounding face closed, unlike a culled render mesh where a face touching a
//! solid neighbor is skipped). Transparent blocks (fence/glass/flower/water, classified via
//! `transparent_alpha`) get their own greedy-merge pass, kept separate from the opaque merge so a
//! water body never fuses with adjoining stone. All solids — cuboid or prism, opaque or
//! translucent — share one `func_detail` entity and one material lineage per `(block_type,
//! paint)` (see `material_name`, extended by Stage 3 below). UI (Stage 4) and the skybox
//! auto-shell (Stage 5) come later.
//!
//! Stage 3: a materials sidecar (`FlatColor` texture mode only, see below). `material_name`
//! derives a name from `BLOCK_FACE_TEX`'s side-texture name when the block has one (e.g.
//! `vuencedit/stone`), falling back to `vuencedit/m_{bt}` only for blocks with no texture-pack
//! entry — so a stone cuboid, a stone ramp, and a stone wedge intentionally share one material
//! (same texture), rather than getting three placeholder names for one visual material.
//! `write_materials_sidecar` writes one hand-rolled `.vtf` (uncompressed BGRA8888, 16×16 flat
//! color, single mip, `NOMIP|NOLOD` flags set) + `.vmt` (`LightmappedGeneric`, `$translucent 1`
//! for water/glass/fence/flower) pair per distinct `(block_type, paint)` combo actually used by
//! the exported solids — not the full 112×55 cross product — under `materials/vuencedit/` next to
//! the `.vmf`, plus a `README.txt` with copy instructions for a Source mod's content tree.
//!
//! Stage 6 (2026-07-19, real Hammer/CS:S testing): flat-color materials didn't load — a stone
//! floor rendered pink/black, confirming the hand-rolled `.vtf`'s flags were wrong for a
//! single-mip texture (see `write_vtf`'s `NOMIP|NOLOD` fix). Two new knobs on `BuildOpts`:
//! `texture_mode` (`Dev`, the new default — every solid points at Source's built-in
//! `dev/dev_measuregeneric01`, so materials always resolve with zero sidecar copying; `FlatColor`
//! keeps the Stage 3 pipeline as an opt-in) and `merge_across_materials` (opt-in — fuses adjacent
//! cells into maximal boxes ignoring `(bt,paint)` entirely, auto-picking a dominant material per
//! box via `dominant_material`, so a tiled/checkerboard floor collapses to a handful of brushes
//! instead of one per cell). Both modes keep the per-solid Hammer editor tint keyed to the real
//! `(bt,paint)` so painted/typed geometry stays visually distinguishable regardless of texture
//! mode.
//!
//! Coordinates: Eden (X east, Y south, Z up) → Source (X, −Y, Z), scaled by `units_per_block`.
//! Both are Z-up; negating Y flips handedness to match Source. VMF planes are 3 points wound
//! clockwise when viewed from outside the solid (outward normal = `(p3−p1)×(p2−p1)`).
//!
//! For an axis-aligned box this is easy to hand-verify per face (`box_face_planes`). Ramp/wedge
//! faces are ported from `emit_ramp`/`emit_wedge`'s vertex positions (correct geometry, but that
//! code culls per-neighbor and was never authored against *this* file's winding convention, so
//! trusting its vertex order blind is a trap — a per-face hand check found some faces backwards).
//! Instead `solid_source_planes` self-corrects, in Source space, *after* the `source_vertex`
//! transform (not before — the Eden→Source map negates only Y, and hand-propagating an outward
//! dot-product sign through that turned out to be exactly the kind of easy-to-get-backwards
//! algebra this file is trying to avoid): the equal-weight average of a convex polytope's own
//! vertices always lies in its strict interior, so `orient_outward` uses that average as a
//! reference point and flips any face whose normal points at it rather than away — the same
//! technique the test suite's `assert_faces_outward` already uses to verify `box_face_planes`.

use crate::export::{obj_occludes, ChunkCache};
use crate::{world_max_z, AppState, LoadedWorld, SelectionMask, WorldState};
use crate::colors::{block_color, transparent_alpha, PAINT_RGB};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

/// Hammer units per Eden block. 40 makes a 2-block-tall Eden player ≈ the 72-unit Source hull.
pub(crate) const DEFAULT_UNITS_PER_BLOCK: i32 = 40;
/// Source's hard map-wide brush limit (vbsp MAX_MAP_BRUSHES).
const SOURCE_MAX_BRUSHES: usize = 8192;
/// Default brush-count guard: comfortably under `SOURCE_MAX_BRUSHES`, leaving headroom for
/// ramp/wedge brushes (one per cell, no merging) and the Stage 5 skybox shell that share the same
/// map budget.
pub(crate) const DEFAULT_MAX_BRUSHES: usize = 6144;

/// Skybox-shell tuning (Stage 5 "Add skybox shell" toggle). Margin is in Eden blocks (expands the
/// hollow interior around the exported selection before conversion to Source units); thickness is
/// already in Source units (the slabs' own wall depth).
const SHELL_MARGIN_BLOCKS: i32 = 6;
const SHELL_THICKNESS_UNITS: i32 = 64;
/// Source's standard "this face is not rendered/compiled into visible geometry" dev texture —
/// vbsp culls faces textured with it from the final BSP, making the shell invisible in-game while
/// still bounding the compile.
const SHELL_MATERIAL: &str = "tools/toolsskybox";

/// Source's standard measuring/greyboxing dev texture, bundled with every Source game — always
/// resolves with zero sidecar copying, unlike the hand-rolled flat-color materials.
const DEV_TEXTURE: &str = "dev/dev_measuregeneric01";

/// Which material an export's non-shell solids reference. `Dev` (default) points every cuboid/
/// ramp/wedge at `DEV_TEXTURE` — no sidecar, guaranteed to load in any Source game. `FlatColor`
/// keeps the legacy per-`(block_type,paint)` hand-rolled `.vtf`/`.vmt` sidecar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextureMode {
    Dev,
    FlatColor,
}

/// Bundles `build_vmf`'s tuning knobs so adding more (texture mode, merge mode) doesn't keep
/// growing its positional argument list. `legacy()` mirrors the pre-this-struct call shape, for
/// call sites (mostly tests) that don't care about texture mode or cross-material merging.
pub(crate) struct BuildOpts {
    pub(crate) units_per_block: i32,
    pub(crate) max_brushes: usize,
    pub(crate) include_shell: bool,
    pub(crate) texture_mode: TextureMode,
    pub(crate) merge_across_materials: bool,
}

impl BuildOpts {
    pub(crate) fn legacy(units_per_block: i32, max_brushes: usize, include_shell: bool) -> Self {
        Self { units_per_block, max_brushes, include_shell, texture_mode: TextureMode::FlatColor, merge_across_materials: false }
    }
}

/// One merged axis-aligned box of identical `(block_type, paint)` cells, inclusive cell coords.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MergedBox {
    pub(crate) x0: i32,
    pub(crate) y0: i32,
    pub(crate) z0: i32,
    pub(crate) x1: i32,
    pub(crate) y1: i32,
    pub(crate) z1: i32,
    pub(crate) bt: u8,
    pub(crate) paint: u8,
}

/// Cells grouped by `(block_type, paint)` material.
type CellsByMat = HashMap<(u8, u8), Vec<(i32, i32, i32)>>;

/// Collect the opaque solid cells of a region, grouped by `(block_type, paint)`.
/// Mask-excluded columns never enter the merge input (they don't just get filtered afterward),
/// so shaped selections merge correctly along the mask boundary.
#[allow(clippy::too_many_arguments)]
fn collect_solid_cells(
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    sz1: i32, sz2: i32,
    mask: Option<&SelectionMask>,
) -> CellsByMat {
    let cache = ChunkCache::new(world);
    let mut by_mat: CellsByMat = HashMap::new();
    for wy in sy1..=sy2 {
        for wx in sx1..=sx2 {
            if let Some(m) = mask {
                if !m.contains(wx, wy) { continue; }
            }
            for wz in sz1..=sz2 {
                let (bt, paint) = cache.get(wx, wy, wz);
                if obj_occludes(bt) {
                    by_mat.entry((bt, paint)).or_default().push((wx, wy, wz));
                }
            }
        }
    }
    by_mat
}

/// Collect transparent cells (fence/glass/flower/water — `transparent_alpha(bt).is_some()`) of a
/// region, grouped by `(block_type, paint)`, kept separate from opaque solids so a water body
/// never merges with adjoining stone. Same mask-first-class treatment as `collect_solid_cells`.
#[allow(clippy::too_many_arguments)]
fn collect_transparent_cells(
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    sz1: i32, sz2: i32,
    mask: Option<&SelectionMask>,
) -> CellsByMat {
    let cache = ChunkCache::new(world);
    let mut by_mat: CellsByMat = HashMap::new();
    for wy in sy1..=sy2 {
        for wx in sx1..=sx2 {
            if let Some(m) = mask {
                if !m.contains(wx, wy) { continue; }
            }
            for wz in sz1..=sz2 {
                let (bt, paint) = cache.get(wx, wy, wz);
                if transparent_alpha(bt).is_some() {
                    by_mat.entry((bt, paint)).or_default().push((wx, wy, wz));
                }
            }
        }
    }
    by_mat
}

/// `Some((is_wedge, dir))` for ramp/wedge block types — ramps 24–39 dir 0..3 = S/W/N/E (high
/// edge direction), wedges 40–55 dir 0..3 = SE/SW/NW/NE (apex corner) — matches
/// `emit_ramp`/`emit_wedge`'s existing dir encoding (family base + `% 4`).
fn ramp_wedge_kind(bt: u8) -> Option<(bool, u8)> {
    match bt {
        24..=39 => Some((false, (bt - 24) % 4)),
        40..=55 => Some((true, (bt - 40) % 4)),
        _ => None,
    }
}

/// Collect ramp/wedge cells of a region as `(x, y, z, block_type, paint)` — never merged (one
/// brush per cell; colinear-run merging is a documented future optimization). Z-outer scan order
/// gives a deterministic `(z, y, x)` emission order for free.
#[allow(clippy::too_many_arguments)]
fn collect_ramp_wedge_cells(
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    sz1: i32, sz2: i32,
    mask: Option<&SelectionMask>,
) -> Vec<(i32, i32, i32, u8, u8)> {
    let cache = ChunkCache::new(world);
    let mut out = Vec::new();
    for wz in sz1..=sz2 {
        for wy in sy1..=sy2 {
            for wx in sx1..=sx2 {
                if let Some(m) = mask {
                    if !m.contains(wx, wy) { continue; }
                }
                let (bt, paint) = cache.get(wx, wy, wz);
                if ramp_wedge_kind(bt).is_some() {
                    out.push((wx, wy, wz, bt, paint));
                }
            }
        }
    }
    out
}

/// Greedy 3D box merger: covers every cell in `cells` with non-overlapping axis-aligned boxes,
/// returned as inclusive `(x0, y0, z0, x1, y1, z1)`. Generalizes `greedy_mesh_2d`: scan in
/// (z, y, x) order, extend each seed along X into a run, the run along Y into a rect, and the
/// rect along Z into a box (Z last — vertical merges are the big win for architectural fills).
pub(crate) fn greedy_merge_boxes(cells: &[(i32, i32, i32)]) -> Vec<(i32, i32, i32, i32, i32, i32)> {
    let mut remaining: HashSet<(i32, i32, i32)> = cells.iter().copied().collect();
    let mut sorted: Vec<(i32, i32, i32)> = cells.to_vec();
    sorted.sort_unstable_by_key(|&(x, y, z)| (z, y, x));
    let mut boxes = Vec::new();
    for &(x0, y0, z0) in &sorted {
        if !remaining.contains(&(x0, y0, z0)) { continue; }
        let mut x1 = x0;
        while remaining.contains(&(x1 + 1, y0, z0)) { x1 += 1; }
        let mut y1 = y0;
        while (x0..=x1).all(|x| remaining.contains(&(x, y1 + 1, z0))) { y1 += 1; }
        let mut z1 = z0;
        while (y0..=y1).all(|y| (x0..=x1).all(|x| remaining.contains(&(x, y, z1 + 1)))) { z1 += 1; }
        for z in z0..=z1 {
            for y in y0..=y1 {
                for x in x0..=x1 { remaining.remove(&(x, y, z)); }
            }
        }
        boxes.push((x0, y0, z0, x1, y1, z1));
    }
    boxes
}

/// Region → merged opaque-solid boxes, deterministically ordered (materials sorted, then merge
/// scan order).
#[allow(clippy::too_many_arguments)]
pub(crate) fn merge_region(
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    sz1: i32, sz2: i32,
    mask: Option<&SelectionMask>,
) -> Vec<MergedBox> {
    let by_mat = collect_solid_cells(world, sx1, sy1, sx2, sy2, sz1, sz2, mask);
    let mut mats: Vec<(u8, u8)> = by_mat.keys().copied().collect();
    mats.sort_unstable();
    let mut out = Vec::new();
    for (bt, paint) in mats {
        for (x0, y0, z0, x1, y1, z1) in greedy_merge_boxes(&by_mat[&(bt, paint)]) {
            out.push(MergedBox { x0, y0, z0, x1, y1, z1, bt, paint });
        }
    }
    out
}

/// Region → merged transparent boxes (fence/glass/flower/water), same ordering discipline as
/// `merge_region`. Kept as a separate pass/output so translucent bodies never fuse with opaque
/// neighbors of a different material.
#[allow(clippy::too_many_arguments)]
pub(crate) fn merge_transparent_region(
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    sz1: i32, sz2: i32,
    mask: Option<&SelectionMask>,
) -> Vec<MergedBox> {
    let by_mat = collect_transparent_cells(world, sx1, sy1, sx2, sy2, sz1, sz2, mask);
    let mut mats: Vec<(u8, u8)> = by_mat.keys().copied().collect();
    mats.sort_unstable();
    let mut out = Vec::new();
    for (bt, paint) in mats {
        for (x0, y0, z0, x1, y1, z1) in greedy_merge_boxes(&by_mat[&(bt, paint)]) {
            out.push(MergedBox { x0, y0, z0, x1, y1, z1, bt, paint });
        }
    }
    out
}

/// Cell → `(block_type, paint)`, ungrouped — the merge-across-materials input. Same mask-first
/// scan as `collect_solid_cells`/`collect_transparent_cells`, just keyed per-cell instead of
/// per-material so a checkerboard of different types can still fuse into one box.
type CellMaterials = HashMap<(i32, i32, i32), (u8, u8)>;

#[allow(clippy::too_many_arguments)]
fn collect_solid_cells_all(
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    sz1: i32, sz2: i32,
    mask: Option<&SelectionMask>,
) -> CellMaterials {
    let cache = ChunkCache::new(world);
    let mut cells = CellMaterials::new();
    for wy in sy1..=sy2 {
        for wx in sx1..=sx2 {
            if let Some(m) = mask {
                if !m.contains(wx, wy) { continue; }
            }
            for wz in sz1..=sz2 {
                let (bt, paint) = cache.get(wx, wy, wz);
                if obj_occludes(bt) {
                    cells.insert((wx, wy, wz), (bt, paint));
                }
            }
        }
    }
    cells
}

#[allow(clippy::too_many_arguments)]
fn collect_transparent_cells_all(
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    sz1: i32, sz2: i32,
    mask: Option<&SelectionMask>,
) -> CellMaterials {
    let cache = ChunkCache::new(world);
    let mut cells = CellMaterials::new();
    for wy in sy1..=sy2 {
        for wx in sx1..=sx2 {
            if let Some(m) = mask {
                if !m.contains(wx, wy) { continue; }
            }
            for wz in sz1..=sz2 {
                let (bt, paint) = cache.get(wx, wy, wz);
                if transparent_alpha(bt).is_some() {
                    cells.insert((wx, wy, wz), (bt, paint));
                }
            }
        }
    }
    cells
}

/// The representative `(block_type, paint)` for a merged-across-materials box: majority vote over
/// every cell in its inclusive range, tie-broken to the smallest `(bt, paint)` tuple for
/// determinism (matters only for the editor tint / auto-picked material in the degenerate case of
/// an exact tie — the merge itself is agnostic to which material "wins").
fn dominant_material(cells: &CellMaterials, x0: i32, y0: i32, z0: i32, x1: i32, y1: i32, z1: i32) -> (u8, u8) {
    let mut counts: HashMap<(u8, u8), u32> = HashMap::new();
    for z in z0..=z1 {
        for y in y0..=y1 {
            for x in x0..=x1 {
                let mat = cells[&(x, y, z)];
                *counts.entry(mat).or_insert(0) += 1;
            }
        }
    }
    counts.into_iter()
        .max_by_key(|&(mat, count)| (count, std::cmp::Reverse(mat)))
        .map(|(mat, _)| mat)
        .expect("box always covers at least one collected cell")
}

/// Region → merged boxes that ignore block type entirely (opt-in "merge across materials"):
/// greedy-merges every solid cell regardless of `(bt, paint)`, then auto-picks each resulting
/// box's representative material via `dominant_material`. Ideal for greyboxing a tiled/
/// checkerboard floor, which otherwise degenerates to one brush per cell under `merge_region`'s
/// per-material grouping. Kept as a separate opaque/transparent pass, same as the material-keyed
/// merge, so translucent bodies still never fuse with opaque neighbors.
#[allow(clippy::too_many_arguments)]
pub(crate) fn merge_region_unified(
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    sz1: i32, sz2: i32,
    mask: Option<&SelectionMask>,
) -> Vec<MergedBox> {
    let cells = collect_solid_cells_all(world, sx1, sy1, sx2, sy2, sz1, sz2, mask);
    let coords: Vec<(i32, i32, i32)> = cells.keys().copied().collect();
    greedy_merge_boxes(&coords).into_iter()
        .map(|(x0, y0, z0, x1, y1, z1)| {
            let (bt, paint) = dominant_material(&cells, x0, y0, z0, x1, y1, z1);
            MergedBox { x0, y0, z0, x1, y1, z1, bt, paint }
        })
        .collect()
}

/// Transparent counterpart of `merge_region_unified` — same cross-material fusion, still never
/// mixed with the opaque pass.
#[allow(clippy::too_many_arguments)]
pub(crate) fn merge_transparent_region_unified(
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    sz1: i32, sz2: i32,
    mask: Option<&SelectionMask>,
) -> Vec<MergedBox> {
    let cells = collect_transparent_cells_all(world, sx1, sy1, sx2, sy2, sz1, sz2, mask);
    let coords: Vec<(i32, i32, i32)> = cells.keys().copied().collect();
    greedy_merge_boxes(&coords).into_iter()
        .map(|(x0, y0, z0, x1, y1, z1)| {
            let (bt, paint) = dominant_material(&cells, x0, y0, z0, x1, y1, z1);
            MergedBox { x0, y0, z0, x1, y1, z1, bt, paint }
        })
        .collect()
}

/// Inclusive cell box → Source-space min/max corners: `(x, −y, z) * units_per_block`.
pub(crate) fn source_bounds(b: &MergedBox, units_per_block: i32) -> ([i32; 3], [i32; 3]) {
    let u = units_per_block;
    (
        [b.x0 * u, -(b.y1 + 1) * u, b.z0 * u],
        [(b.x1 + 1) * u, -b.y0 * u, (b.z1 + 1) * u],
    )
}

/// Eden block-boundary coordinate → Source unit coordinate for one vertex, matching
/// `source_bounds`'s per-corner mapping. Unlike `source_bounds` (which only ever needs a box's
/// two extreme corners), ramp/wedge prisms have vertices that aren't at a simple min/max, so each
/// vertex is transformed individually.
fn source_vertex(x: i32, y: i32, z: i32, u: i32) -> [i32; 3] { [x * u, -y * u, z * u] }

/// The six faces of an axis-aligned box as VMF plane triples — the first three corners of each
/// face quad wound clockwise viewed from outside, so `(p3−p1)×(p2−p1)` points outward.
/// Face order: +Z top, −Z bottom, +X, −X, +Y, −Y (matches `FACE_UAXIS`/`FACE_VAXIS`).
pub(crate) fn box_face_planes(min: [i32; 3], max: [i32; 3]) -> [[[i32; 3]; 3]; 6] {
    let [ax, ay, az] = min;
    let [bx, by, bz] = max;
    [
        [[ax, by, bz], [bx, by, bz], [bx, ay, bz]], // +Z
        [[ax, ay, az], [bx, ay, az], [bx, by, az]], // -Z
        [[bx, ay, az], [bx, ay, bz], [bx, by, bz]], // +X
        [[ax, by, bz], [ax, ay, bz], [ax, ay, az]], // -X
        [[bx, by, az], [bx, by, bz], [ax, by, bz]], // +Y
        [[ax, ay, az], [ax, ay, bz], [bx, ay, bz]], // -Y
    ]
}

/// One face triple in *Eden* block-boundary coordinates (unscaled, un-negated) — transformed to
/// Source space via `source_vertex` right before emission.
type EdenTri = [[i32; 3]; 3];

/// Flip any face (swap its last two points) whose normal points *at* the shape's own vertex
/// centroid instead of away from it. Space-agnostic (just a geometric fact about a convex
/// polytope's own vertices) — called on the *Source*-space planes in `solid_source_planes`, after
/// the Eden→Source transform, so there's no need to reason about how orientation propagates
/// through that transform.
fn orient_outward<const N: usize>(mut planes: [EdenTri; N]) -> [EdenTri; N] {
    let mut sum = [0i64; 3];
    let mut count = 0i64;
    for p in &planes {
        for v in p {
            sum[0] += v[0] as i64; sum[1] += v[1] as i64; sum[2] += v[2] as i64;
            count += 1;
        }
    }
    let center = [sum[0] as f64 / count as f64, sum[1] as f64 / count as f64, sum[2] as f64 / count as f64];
    for p in planes.iter_mut() {
        let normal = plane_normal(*p);
        let d: f64 = (0..3).map(|i| normal[i] as f64 * (p[0][i] as f64 - center[i])).sum();
        if d < 0.0 { p.swap(1, 2); }
    }
    planes
}

/// Eden-space plane triples for a ramp cell at `(wx, wy, wz)`, dir 0=S/1=W/2=N/3=E (high-edge
/// direction) — vertex positions ported from `emit_ramp`'s geometry with the neighbor-occlusion
/// culling removed (a VMF brush must be a closed convex volume; a render mesh can skip a face
/// touching a solid neighbor, a brush solid cannot). 5 faces: bottom, high wall, two end-cap
/// triangles, slope. Each face keeps only the first 3 of `emit_ramp`'s corners — enough to define
/// a VMF plane; vertex *order* is not guaranteed outward-facing here (see `solid_source_planes`,
/// which corrects it after the Eden→Source transform).
fn ramp_eden_planes(wx: i32, wy: i32, wz: i32, dir: u8) -> [EdenTri; 5] {
    let (x0, x1) = (wx, wx + 1);
    let (y0, y1) = (wy, wy + 1);
    let (z0, z1) = (wz, wz + 1);
    let bottom: EdenTri = [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0]];
    match dir {
        0 => [ // South: high edge at +Y
            bottom,
            [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1]], // south wall
            [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], // west cap
            [[x1, y1, z0], [x1, y0, z0], [x1, y1, z1]], // east cap
            [[x0, y0, z0], [x1, y0, z0], [x1, y1, z1]], // slope
        ],
        1 => [ // West: high edge at -X
            bottom,
            [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], // west wall
            [[x0, y1, z0], [x1, y1, z0], [x0, y1, z1]], // south cap
            [[x1, y0, z0], [x0, y0, z0], [x0, y0, z1]], // north cap
            [[x1, y0, z0], [x1, y1, z0], [x0, y1, z1]], // slope
        ],
        2 => [ // North: high edge at -Y
            bottom,
            [[x1, y0, z0], [x0, y0, z0], [x0, y0, z1]], // north wall
            [[x1, y0, z0], [x1, y1, z0], [x1, y0, z1]], // east cap
            [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1]], // west cap
            [[x1, y1, z0], [x0, y1, z0], [x0, y0, z1]], // slope
        ],
        _ => [ // East (dir=3): high edge at +X
            bottom,
            [[x1, y1, z0], [x1, y0, z0], [x1, y0, z1]], // east wall
            [[x1, y0, z0], [x0, y0, z0], [x1, y0, z1]], // north cap
            [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1]], // south cap
            [[x0, y1, z0], [x0, y0, z0], [x1, y0, z1]], // slope
        ],
    }
}

/// Eden-space plane triples for a wedge cell at `(wx, wy, wz)`, dir 0=SE/1=SW/2=NW/3=NE (apex
/// corner) — vertex positions ported from `emit_wedge`'s geometry the same way
/// `ramp_eden_planes` ports `emit_ramp`'s (culling removed, first 3 corners of each face kept).
/// 5 faces: bottom triangle, top triangle, two axis-aligned side quads, one diagonal quad; vertex
/// order corrected in `solid_source_planes`, same as ramps.
fn wedge_eden_planes(wx: i32, wy: i32, wz: i32, dir: u8) -> [EdenTri; 5] {
    let (x0, x1) = (wx, wx + 1);
    let (y0, y1) = (wy, wy + 1);
    let (z0, z1) = (wz, wz + 1);
    match dir {
        0 => [ // SE: triangle NE-SE-SW. East+South faces; diagonal NE↔SW.
            [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], // bottom
            [[x1, y0, z1], [x0, y1, z1], [x1, y1, z1]], // top
            [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], // east
            [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1]], // south
            [[x1, y0, z0], [x0, y1, z0], [x0, y1, z1]], // diagonal
        ],
        1 => [ // SW: triangle NW-SW-SE. West+South faces; diagonal NW↔SE.
            [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], // bottom
            [[x0, y0, z1], [x1, y1, z1], [x0, y1, z1]], // top
            [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], // west
            [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1]], // south
            [[x0, y0, z0], [x1, y1, z0], [x1, y1, z1]], // diagonal
        ],
        2 => [ // NW: triangle NE-NW-SW. North+West faces; diagonal NE↔SW.
            [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0]], // bottom
            [[x1, y0, z1], [x0, y1, z1], [x0, y0, z1]], // top
            [[x1, y0, z0], [x0, y0, z0], [x0, y0, z1]], // north
            [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], // west
            [[x1, y0, z0], [x0, y1, z0], [x0, y1, z1]], // diagonal
        ],
        _ => [ // NE (dir=3): triangle NW-NE-SE. North+East faces; diagonal NW↔SE.
            [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0]], // bottom
            [[x0, y0, z1], [x1, y1, z1], [x1, y0, z1]], // top
            [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], // north
            [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], // east
            [[x0, y0, z0], [x1, y1, z0], [x1, y1, z1]], // diagonal
        ],
    }
}

/// A single VMF solid to emit: a merged axis-aligned box (opaque or transparent, 6-sided), a
/// single ramp/wedge cell (5-sided prism, never merged with its neighbors), or a raw Source-space
/// box with an explicit material (Stage 5's skybox-shell slabs — these have no `(block_type,
/// paint)` origin, so they carry their own material name and skip the Eden→Source transform,
/// already being defined directly in Source units).
pub(crate) enum VmfSolid {
    Cuboid(MergedBox),
    RampWedge { x: i32, y: i32, z: i32, bt: u8, paint: u8 },
    RawBox { min: [i32; 3], max: [i32; 3], material: String },
}

impl VmfSolid {
    /// `(block_type, paint)` origin, for the sidecar material collection — `None` for
    /// `RawBox` (its material, e.g. `tools/toolsskybox`, is a Source dev texture with no
    /// VuencEdit-generated `.vmt`/`.vtf`, so it must never enter that collection).
    fn bt_paint(&self) -> Option<(u8, u8)> {
        match self {
            VmfSolid::Cuboid(b) => Some((b.bt, b.paint)),
            VmfSolid::RampWedge { bt, paint, .. } => Some((*bt, *paint)),
            VmfSolid::RawBox { .. } => None,
        }
    }

    fn side_count(&self) -> usize {
        match self {
            VmfSolid::Cuboid(_) | VmfSolid::RawBox { .. } => 6,
            VmfSolid::RampWedge { .. } => 5,
        }
    }
}

/// This solid's faces as Source-space plane triples (post `units_per_block` scale and Eden→Source
/// transform), ready for `write_side`. Box faces are already correctly outward-wound by
/// construction (`box_face_planes`); ramp/wedge faces get `orient_outward` applied here, after the
/// transform (see its doc comment for why post-transform, not pre-). `RawBox` is already in
/// Source space (skybox-shell slabs are built directly at that scale — see `skybox_shell`), so it
/// skips the transform entirely but still goes through `box_face_planes` for correct winding.
fn solid_source_planes(solid: &VmfSolid, units_per_block: i32) -> Vec<[[i32; 3]; 3]> {
    match solid {
        VmfSolid::Cuboid(b) => {
            let (min, max) = source_bounds(b, units_per_block);
            box_face_planes(min, max).to_vec()
        }
        VmfSolid::RampWedge { x, y, z, bt, .. } => {
            let (is_wedge, dir) = ramp_wedge_kind(*bt)
                .expect("VmfSolid::RampWedge always holds a ramp/wedge block type");
            let eden = if is_wedge { wedge_eden_planes(*x, *y, *z, dir) } else { ramp_eden_planes(*x, *y, *z, dir) };
            let source: [[[i32; 3]; 3]; 5] = eden.map(|tri| tri.map(|[ex, ey, ez]| source_vertex(ex, ey, ez, units_per_block)));
            orient_outward(source).to_vec()
        }
        VmfSolid::RawBox { min, max, .. } => box_face_planes(*min, *max).to_vec(),
    }
}

/// The 6 canonical Source-space axis directions, in the fixed priority order Quake/Source map
/// compilers use to pick a default texture axis for an arbitrary-angle face ("TextureAxisFromPlane"):
/// dominant-Z first, then X, then Y. Axis-aligned cuboid faces always have an exact match; a
/// 45°-sloped ramp/wedge face (tied between two axes) resolves deterministically to the earlier
/// one in this order instead of picking an arbitrary winner.
const BASE_AXES: [[f64; 3]; 6] = [
    [0.0, 0.0, 1.0], [0.0, 0.0, -1.0],
    [1.0, 0.0, 0.0], [-1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0], [0.0, -1.0, 0.0],
];

// In-plane texture axes per `BASE_AXES` entry — an axis perpendicular to the face is a vbsp
// error, so these are fixed per dominant orientation, world-aligned.
const FACE_UAXIS: [&str; 6] = ["[1 0 0 0]", "[1 0 0 0]", "[0 1 0 0]", "[0 1 0 0]", "[1 0 0 0]", "[1 0 0 0]"];
const FACE_VAXIS: [&str; 6] = ["[0 -1 0 0]", "[0 -1 0 0]", "[0 0 -1 0]", "[0 0 -1 0]", "[0 0 -1 0]", "[0 0 -1 0]"];

fn dominant_face_index(normal: [f64; 3]) -> usize {
    let mut best = 0;
    let mut best_dot = f64::MIN;
    for (i, axis) in BASE_AXES.iter().enumerate() {
        let dot = normal[0] * axis[0] + normal[1] * axis[1] + normal[2] * axis[2];
        if dot > best_dot { best_dot = dot; best = i; }
    }
    best
}

/// VMF outward normal for a plane triple: `(p3−p1)×(p2−p1)`. i64 to stay exact at world-scale
/// coordinates.
fn plane_normal(p: [[i32; 3]; 3]) -> [i64; 3] {
    let [p1, p2, p3] = p.map(|q| [q[0] as i64, q[1] as i64, q[2] as i64]);
    let a = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
    let c = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    [
        a[1] * c[2] - a[2] * c[1],
        a[2] * c[0] - a[0] * c[2],
        a[0] * c[1] - a[1] * c[0],
    ]
}

/// Material name for `(bt, paint)`: `vuencedit/{side-texture name}` when `BLOCK_FACE_TEX` has one
/// (blocks that share a texture — e.g. a stone cuboid and a stone ramp — intentionally share one
/// material), else `vuencedit/m_{bt}` for blocks with no texture-pack entry. `_p{paint}` suffix
/// only for paint≠0, so unpainted stone and painted stone stay distinct materials.
pub(crate) fn material_name(bt: u8, paint: u8) -> String {
    let base = crate::texturepack::BLOCK_FACE_TEX
        .get(bt as usize)
        .map(|faces| faces[0])
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("m_{bt}"));
    if paint == 0 { format!("vuencedit/{base}") } else { format!("vuencedit/{base}_p{paint}") }
}

/// The material a given solid's faces reference, per `TextureMode`. `RawBox` (the skybox shell)
/// always keeps its own material (`tools/toolsskybox`) regardless of mode — it has no
/// `(block_type, paint)` origin to redirect. Every other solid goes to `DEV_TEXTURE` in `Dev` mode
/// or the legacy per-`(bt,paint)` name in `FlatColor` mode; the per-solid Hammer editor tint
/// (`block_color`, applied in `write_vmf`) is what keeps different blocks visually distinguishable
/// under one shared dev texture.
fn solid_material(solid: &VmfSolid, mode: TextureMode) -> String {
    match solid {
        VmfSolid::RawBox { material, .. } => material.clone(),
        _ => match mode {
            TextureMode::Dev => DEV_TEXTURE.to_string(),
            TextureMode::FlatColor => {
                let (bt, paint) = solid.bt_paint().expect("bt_paint() is None only for RawBox");
                material_name(bt, paint)
            }
        },
    }
}

/// Strip the `vuencedit/` material-name prefix down to the bare filename stem used for the
/// `.vmt`/`.vtf` pair on disk (materials live at `materials/vuencedit/{stem}.vmt`, so the on-disk
/// name doesn't need to repeat the folder).
fn material_stem(name: &str) -> &str {
    name.strip_prefix("vuencedit/").unwrap_or(name)
}

const VTF_IMAGE_FORMAT_BGRA8888: u32 = 12;
const VTF_IMAGE_FORMAT_NONE: u32 = 0xFFFF_FFFF;
/// VTF 7.1 header size in bytes — see `write_vtf` for the exact field-by-field layout this counts.
const VTF_HEADER_SIZE: usize = 68;
/// `TEXTUREFLAGS_NOMIP` — this texture has no mip chain, don't try to read one.
const VTF_FLAG_NOMIP: u32 = 0x0100;
/// `TEXTUREFLAGS_NOLOD` — never drop this texture's resolution for distance/LOD.
const VTF_FLAG_NOLOD: u32 = 0x0200;

/// Hand-rolled VTF (Valve Texture Format) file: version 7.1, uncompressed BGRA8888, one mip level,
/// no low-res thumbnail, single flat-color `width`×`height` image. Field layout follows Valve's
/// documented `VTFHEADER` struct with its natural C alignment made explicit — the 3-byte gap
/// before `lowResImageFormat` and the 2-byte tail pad are real struct padding (a `uint32` field
/// can't start at a non-4-aligned offset), not omissions. `NOMIP|NOLOD` is required for a
/// single-mip texture — without it the engine expects a full mip chain and fails to load one that
/// only has level 0 (the pink/black "material found, texture failed to load" symptom).
pub(crate) fn write_vtf(width: u16, height: u16, rgb: [u8; 3]) -> Vec<u8> {
    let mut h = Vec::with_capacity(VTF_HEADER_SIZE + width as usize * height as usize * 4);
    h.extend_from_slice(b"VTF\0");
    h.extend_from_slice(&7u32.to_le_bytes());              // version[0]
    h.extend_from_slice(&1u32.to_le_bytes());               // version[1]
    h.extend_from_slice(&(VTF_HEADER_SIZE as u32).to_le_bytes());
    h.extend_from_slice(&width.to_le_bytes());
    h.extend_from_slice(&height.to_le_bytes());
    h.extend_from_slice(&(VTF_FLAG_NOMIP | VTF_FLAG_NOLOD).to_le_bytes()); // flags
    h.extend_from_slice(&1u16.to_le_bytes());                 // frames
    h.extend_from_slice(&0u16.to_le_bytes());                 // firstFrame
    h.extend_from_slice(&[0u8; 4]);                            // padding0
    for c in rgb { h.extend_from_slice(&(c as f32 / 255.0).to_le_bytes()); } // reflectivity
    h.extend_from_slice(&[0u8; 4]);                            // padding1
    h.extend_from_slice(&0f32.to_le_bytes());                  // bumpmapScale
    h.extend_from_slice(&VTF_IMAGE_FORMAT_BGRA8888.to_le_bytes());
    h.push(1);                                                  // mipmapCount
    h.extend_from_slice(&[0u8; 3]);                             // alignment pad (uint32 next)
    h.extend_from_slice(&VTF_IMAGE_FORMAT_NONE.to_le_bytes());  // lowResImageFormat (no thumbnail)
    h.push(0);                                                  // lowResImageWidth
    h.push(0);                                                  // lowResImageHeight
    h.extend_from_slice(&[0u8; 2]);                             // tail alignment pad
    debug_assert_eq!(h.len(), VTF_HEADER_SIZE);
    let [r, g, b] = rgb;
    for _ in 0..(width as usize * height as usize) {
        h.extend_from_slice(&[b, g, r, 255]); // BGRA8888
    }
    h
}

/// Minimal `LightmappedGeneric` VMT pointing at `material` (the full `vuencedit/...` name, matching
/// `$basetexture`'s materials-relative path convention). `translucent` sets `$translucent 1` for
/// water/glass/fence/flower placeholders (Stage 2's transparent-merge materials).
fn write_vmt(material: &str, translucent: bool) -> String {
    let mut s = format!("\"LightmappedGeneric\"\n{{\n\t\"$basetexture\" \"{material}\"\n\t\"$surfaceprop\" \"default\"\n");
    if translucent {
        s.push_str("\t\"$translucent\" \"1\"\n");
    }
    s.push_str("}\n");
    s
}

const MATERIALS_README: &str = "VuencEdit VMF export - materials sidecar\n\
\n\
This `materials` folder holds placeholder Source materials for the .vmf next to it: one\n\
.vmt+.vtf pair per distinct block/paint combo actually used by the export.\n\
\n\
To use them in Hammer/Source:\n\
  1. Copy this `materials` folder into your mod's content directory, e.g.\n\
     `<game>/<mod>/materials/` or `<game>/custom/vuencedit/materials/` (either works - Source\n\
     searches VPK/custom content the same way).\n\
  2. Open the .vmf in Hammer. The placeholder textures should resolve automatically by name.\n\
\n\
Limitations:\n\
  - Materials are flat-color placeholders (16x16, no mip levels) derived from VuencEdit's own\n\
    block palette, not the game's real textures.\n\
  - Water/glass/fence/flower materials are marked $translucent, but water is decorative, not\n\
    swimmable, in this MVP.\n";

/// Reduce a raw `(block_type, paint)` list down to one representative `(bt, paint)` per distinct
/// material *name* — distinct block types can legitimately share one texture name (e.g. a stone
/// cuboid and a stone ramp both resolve to `vuencedit/stone`), and both the brush-estimate command
/// and the sidecar writer need to report/produce exactly one entry for that case, not two. First
/// occurrence in sorted `(bt, paint)` order wins (the plain block over its ramp/wedge variant).
/// Sorted + deduped for deterministic output.
fn distinct_materials(materials: &[(u8, u8)]) -> Vec<(String, u8, u8)> {
    let mut sorted: Vec<(u8, u8)> = materials.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(sorted.len());
    for (bt, paint) in sorted {
        let name = material_name(bt, paint);
        if seen.insert(name.clone()) { out.push((name, bt, paint)); }
    }
    out
}

/// Write the materials sidecar for a set of `(block_type, paint)` combos actually referenced by an
/// export: `materials/vuencedit/{stem}.vmt`+`.vtf` per distinct material *name* (see
/// `distinct_materials`) next to `vmf_path`, plus a `README.txt`. Returns the full `vuencedit/...`
/// material names written, for the caller's success toast.
pub(crate) fn write_materials_sidecar(
    vmf_path: &std::path::Path,
    materials: &[(u8, u8)],
    sky: u8,
) -> std::io::Result<Vec<String>> {
    let vmf_dir = vmf_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let mat_dir = vmf_dir.join("materials").join("vuencedit");
    std::fs::create_dir_all(&mat_dir)?;

    let mut names = Vec::new();
    for (full, bt, paint) in distinct_materials(materials) {
        let stem = material_stem(&full);
        let rgb = block_color(bt, paint, sky);
        let translucent = transparent_alpha(bt).is_some();
        std::fs::write(mat_dir.join(format!("{stem}.vtf")), write_vtf(16, 16, rgb))?;
        std::fs::write(mat_dir.join(format!("{stem}.vmt")), write_vmt(&full, translucent))?;
        names.push(full);
    }
    std::fs::write(vmf_dir.join("materials").join("README.txt"), MATERIALS_README)?;
    Ok(names)
}

/// Serialize one VMF `side` block, deriving its texture axis from the face's own normal (works
/// for axis-aligned box faces and 45°-sloped ramp/wedge faces alike — see `dominant_face_index`).
fn write_side(s: &mut String, next_id: &mut u32, plane: [[i32; 3]; 3], material: &str) {
    *next_id += 1;
    let n = plane_normal(plane);
    let axis_idx = dominant_face_index([n[0] as f64, n[1] as f64, n[2] as f64]);
    let (uaxis, vaxis) = (FACE_UAXIS[axis_idx], FACE_VAXIS[axis_idx]);
    let _ = write!(
        s,
        "\t\tside\n\t\t{{\n\t\t\t\"id\" \"{}\"\n\t\t\t\"plane\" \"({} {} {}) ({} {} {}) ({} {} {})\"\n\t\t\t\"material\" \"{material}\"\n\t\t\t\"uaxis\" \"{uaxis} 0.25\"\n\t\t\t\"vaxis\" \"{vaxis} 0.25\"\n\t\t\t\"rotation\" \"0\"\n\t\t\t\"lightmapscale\" \"16\"\n\t\t\t\"smoothing_groups\" \"0\"\n\t\t}}\n",
        *next_id,
        plane[0][0], plane[0][1], plane[0][2],
        plane[1][0], plane[1][1], plane[1][2],
        plane[2][0], plane[2][1], plane[2][2],
    );
}

/// Serialize the given solids as a complete VMF document: skeleton + `worldspawn` + one
/// `func_detail` entity holding every solid (chunking into multiple entities is a later
/// refinement), plus any `extra_entities` text (Stage 5's `light_environment`/
/// `info_player_start` for the auto-shell) inserted as additional top-level entity blocks. `sky`
/// feeds `block_color` for the per-solid Hammer editor tint only (skybox-shell `RawBox` solids get
/// a fixed neutral tint, having no `(block_type, paint)` origin to derive one from). `mode`
/// selects each solid's material via `solid_material` — the editor tint stays per-`(bt,paint)`
/// regardless of mode, so tiled blocks remain visually distinguishable in Hammer even under one
/// shared dev texture.
pub(crate) fn write_vmf(solids: &[VmfSolid], units_per_block: i32, sky: u8, extra_entities: &str, mode: TextureMode) -> String {
    let mut s = String::with_capacity(solids.len() * 1500 + 1024);
    s.push_str("versioninfo\n{\n\t\"editorversion\" \"400\"\n\t\"editorbuild\" \"8864\"\n\t\"mapversion\" \"1\"\n\t\"formatversion\" \"100\"\n\t\"prefab\" \"0\"\n}\n");
    s.push_str("visgroups\n{\n}\n");
    let _ = write!(s, "viewsettings\n{{\n\t\"bSnapToGrid\" \"1\"\n\t\"bShowGrid\" \"1\"\n\t\"bShowLogicalGrid\" \"0\"\n\t\"nGridSpacing\" \"{units_per_block}\"\n\t\"bShow3DGrid\" \"0\"\n}}\n");
    s.push_str("world\n{\n\t\"id\" \"1\"\n\t\"mapversion\" \"1\"\n\t\"classname\" \"worldspawn\"\n\t\"skyname\" \"sky_day01_01\"\n}\n");

    // ids only need to be unique within their kind, but one shared counter is simplest.
    let mut next_id: u32 = 2; // 1 = worldspawn
    s.push_str("entity\n{\n\t\"id\" \"2\"\n\t\"classname\" \"func_detail\"\n");
    for solid in solids {
        let planes = solid_source_planes(solid, units_per_block);
        let material = solid_material(solid, mode);
        next_id += 1;
        let _ = write!(s, "\tsolid\n\t{{\n\t\t\"id\" \"{next_id}\"\n");
        for plane in &planes {
            write_side(&mut s, &mut next_id, *plane, &material);
        }
        let [r, g, bch] = solid.bt_paint().map(|(bt, paint)| block_color(bt, paint, sky)).unwrap_or([120, 120, 140]);
        let _ = write!(s, "\t\teditor\n\t\t{{\n\t\t\t\"color\" \"{r} {g} {bch}\"\n\t\t\t\"visgroupshown\" \"1\"\n\t\t\t\"visgroupautoshown\" \"1\"\n\t\t}}\n\t}}\n");
    }
    s.push_str("\teditor\n\t{\n\t\t\"color\" \"0 180 0\"\n\t\t\"visgroupshown\" \"1\"\n\t\t\"visgroupautoshown\" \"1\"\n\t\t\"logicalpos\" \"[0 0]\"\n\t}\n}\n");
    s.push_str(extra_entities);
    s.push_str("cameras\n{\n\t\"activecamera\" \"-1\"\n}\n");
    s.push_str("cordon\n{\n\t\"mins\" \"(-1024 -1024 -1024)\"\n\t\"maxs\" \"(1024 1024 1024)\"\n\t\"active\" \"0\"\n}\n");
    s
}

/// Six non-overlapping `tools/toolsskybox` slabs (floor, ceiling, four walls) forming a hollow box
/// around the export, in Source units. `eden_min`/`eden_max` are the *inclusive* Eden cell bounds
/// of the export (`sx1,sy1,sz1`/`sx2,sy2,sz2`) — expanded by `SHELL_MARGIN_BLOCKS` and converted to
/// Source-space corners the same way `source_bounds` does for a `MergedBox` (cell `x0..=x1` →
/// `x0*u..=(x1+1)*u`), then the resulting "inner" (hollow) box is thickened outward by
/// `SHELL_THICKNESS_UNITS` to get the "outer" box. A picture-frame decomposition — floor/ceiling
/// spanning the full outer XY footprint, four walls spanning only the inner Z band — tiles
/// `outer − inner` exactly with no overlap (each unit of volume belongs to exactly one slab).
fn skybox_shell(eden_min: [i32; 3], eden_max: [i32; 3], units_per_block: i32) -> Vec<VmfSolid> {
    let m = SHELL_MARGIN_BLOCKS;
    let u = units_per_block;
    let (ex0, ey0, ez0) = (eden_min[0] - m, eden_min[1] - m, (eden_min[2] - m).max(0));
    let (ex1, ey1, ez1) = (eden_max[0] + m, eden_max[1] + m, eden_max[2] + m);

    let inner_min = [ex0 * u, -(ey1 + 1) * u, ez0 * u];
    let inner_max = [(ex1 + 1) * u, -ey0 * u, (ez1 + 1) * u];
    let t = SHELL_THICKNESS_UNITS;
    let outer_min = [inner_min[0] - t, inner_min[1] - t, inner_min[2] - t];
    let outer_max = [inner_max[0] + t, inner_max[1] + t, inner_max[2] + t];

    let mat = || SHELL_MATERIAL.to_string();
    vec![
        // Floor / ceiling: full outer XY footprint, thin in Z.
        VmfSolid::RawBox { min: outer_min, max: [outer_max[0], outer_max[1], inner_min[2]], material: mat() },
        VmfSolid::RawBox { min: [outer_min[0], outer_min[1], inner_max[2]], max: outer_max, material: mat() },
        // Walls: only the inner Z band (floor/ceiling already cover the rest).
        VmfSolid::RawBox { min: [outer_min[0], outer_min[1], inner_min[2]], max: [inner_min[0], outer_max[1], inner_max[2]], material: mat() }, // -X
        VmfSolid::RawBox { min: [inner_max[0], outer_min[1], inner_min[2]], max: [outer_max[0], outer_max[1], inner_max[2]], material: mat() }, // +X
        VmfSolid::RawBox { min: [inner_min[0], outer_min[1], inner_min[2]], max: [inner_max[0], inner_min[1], inner_max[2]], material: mat() }, // -Y
        VmfSolid::RawBox { min: [inner_min[0], inner_max[1], inner_min[2]], max: [inner_max[0], outer_max[1], inner_max[2]], material: mat() }, // +Y
    ]
}

/// `light_environment` (sun angle/color derived from the loaded world's sky paint index) +
/// `info_player_start` (centered over the export, one block above its top), so a shell-enabled
/// export compiles into a walkable, lit standalone map without any manual Hammer setup. Entity ids
/// are a fixed high range, clear of `write_vmf`'s own per-solid/per-side counter (which stays well
/// under six digits even at the brush-count guard's ceiling).
fn shell_entities(eden_min: [i32; 3], eden_max: [i32; 3], units_per_block: i32, sky: u8) -> String {
    let u = units_per_block;
    let cx = (eden_min[0] + eden_max[0] + 1) * u / 2;
    let cy = -(eden_min[1] + eden_max[1] + 1) * u / 2;
    let spawn_z = (eden_max[2] + 1) * u + u;
    let [r, g, b] = PAINT_RGB.get(sky as usize).copied().unwrap_or([200, 220, 255]);
    format!(
        "entity\n{{\n\t\"id\" \"900001\"\n\t\"classname\" \"light_environment\"\n\t\"origin\" \"{cx} {cy} {spawn_z}\"\n\t\"angles\" \"0 0 0\"\n\t\"pitch\" \"-60\"\n\t\"_light\" \"{r} {g} {b} 200\"\n\t\"_ambient\" \"{r} {g} {b} 20\"\n\t\"_lightHDR\" \"-1 -1 -1 1\"\n\t\"_lightscaleHDR\" \"1\"\n\t\"_ambientHDR\" \"-1 -1 -1 1\"\n\t\"_AmbientScaleHDR\" \"1\"\n\t\"SunSpreadAngle\" \"0\"\n}}\n\
         entity\n{{\n\t\"id\" \"900002\"\n\t\"classname\" \"info_player_start\"\n\t\"origin\" \"{cx} {cy} {spawn_z}\"\n\t\"angles\" \"0 0 0\"\n}}\n",
    )
}

/// Merge + guard + serialize. Returns the VMF text, brush count, side count, and the distinct
/// `(block_type, paint)` materials referenced (deduplicated, for the Stage 3 sidecar writer —
/// `write_materials_sidecar` takes this directly). `Err` on a degenerate scale, an empty (no
/// exportable cells) selection, or a brush count over `max_brushes`. Gathers three independent
/// categories into one combined brush list: opaque solids (merged), transparent solids (merged
/// separately), ramp/wedge cells (one brush each).
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(crate) fn build_vmf(
    world: &LoadedWorld,
    sx1: i32, sy1: i32, sx2: i32, sy2: i32,
    sz1: i32, sz2: i32,
    mask: Option<&SelectionMask>,
    opts: &BuildOpts,
) -> Result<(String, usize, usize, Vec<(u8, u8)>), String> {
    let units_per_block = opts.units_per_block;
    if units_per_block <= 0 {
        return Err(format!("units_per_block must be positive (got {units_per_block})"));
    }
    let mut solids: Vec<VmfSolid> = Vec::new();
    let opaque = if opts.merge_across_materials {
        merge_region_unified(world, sx1, sy1, sx2, sy2, sz1, sz2, mask)
    } else {
        merge_region(world, sx1, sy1, sx2, sy2, sz1, sz2, mask)
    };
    for b in opaque {
        solids.push(VmfSolid::Cuboid(b));
    }
    let transparent = if opts.merge_across_materials {
        merge_transparent_region_unified(world, sx1, sy1, sx2, sy2, sz1, sz2, mask)
    } else {
        merge_transparent_region(world, sx1, sy1, sx2, sy2, sz1, sz2, mask)
    };
    for b in transparent {
        solids.push(VmfSolid::Cuboid(b));
    }
    for (x, y, z, bt, paint) in collect_ramp_wedge_cells(world, sx1, sy1, sx2, sy2, sz1, sz2, mask) {
        solids.push(VmfSolid::RampWedge { x, y, z, bt, paint });
    }
    if solids.is_empty() {
        return Err("No exportable blocks in the selection — nothing to export".into());
    }

    // Materials are gathered from the exported geometry only, before any shell slabs are added
    // below — RawBox's bt_paint() is always None, so tools/toolsskybox structurally can't enter
    // the sidecar's material list even without this ordering, but computing it first keeps that
    // invariant obvious at the call site rather than relying on filter_map alone.
    let mut materials: Vec<(u8, u8)> = solids.iter().filter_map(VmfSolid::bt_paint).collect();
    materials.sort_unstable();
    materials.dedup();

    let extra_entities = if opts.include_shell {
        let eden_min = [sx1, sy1, sz1];
        let eden_max = [sx2, sy2, sz2];
        solids.extend(skybox_shell(eden_min, eden_max, units_per_block));
        shell_entities(eden_min, eden_max, units_per_block, world.sky)
    } else {
        String::new()
    };

    if solids.len() > opts.max_brushes {
        return Err(format!(
            "Export would produce {} brushes, over the limit of {} (Source maps cap at {SOURCE_MAX_BRUSHES} total) — shrink the selection or split the export",
            solids.len(), opts.max_brushes,
        ));
    }
    let side_count: usize = solids.iter().map(VmfSolid::side_count).sum();
    let text = write_vmf(&solids, units_per_block, world.sky, &extra_entities, opts.texture_mode);
    Ok((text, solids.len(), side_count, materials))
}

#[derive(serde::Serialize)]
pub(crate) struct VmfExportResult {
    brush_count: u32,
    side_count: u32,
    material_count: u32,
}

/// Normalize a (possibly reversed) selection rect + Z range against the loaded world, resolving
/// the active shaped-selection mask the same way `export_vmf`/`estimate_vmf` both need.
fn normalize_region<'a>(
    ws: &'a std::sync::MutexGuard<'a, WorldState>,
    world: &LoadedWorld,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
) -> (i32, i32, i32, i32, i32, i32, Option<SelectionMask>) {
    let sx1 = x1.min(x2); let sx2 = x1.max(x2);
    let sy1 = y1.min(y2); let sy2 = y1.max(y2);
    let sz1 = z_min.min(z_max).max(0);
    let sz2 = z_min.max(z_max).min(world_max_z(world));
    // Shaped selection: same normalized-rect handshake as get_obj_geometry — a stale mask
    // degrades to the full rect, never a mis-filtered export.
    let mask = crate::active_mask(ws, sx1, sy1, sx2, sy2);
    (sx1, sy1, sx2, sy2, sz1, sz2, mask)
}

/// `"flat"` → `FlatColor`; anything else (including absent) → `Dev`, the new default.
fn parse_texture_mode(mode: Option<&str>) -> TextureMode {
    match mode {
        Some("flat") => TextureMode::FlatColor,
        _ => TextureMode::Dev,
    }
}

/// JS side: `unitsPerBlock` / `maxBrushes` / `textureMode` / `mergeAcrossMaterials` (Tauri
/// camelCases snake_case params).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn export_vmf(
    state: tauri::State<'_, AppState>,
    path: String,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    units_per_block: Option<i32>,
    max_brushes: Option<u32>,
    auto_shell: Option<bool>,
    texture_mode: Option<String>,
    merge_across_materials: Option<bool>,
) -> Result<VmfExportResult, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let (sx1, sy1, sx2, sy2, sz1, sz2, mask) = normalize_region(&ws, world, x1, y1, x2, y2, z_min, z_max);

    let opts = BuildOpts {
        units_per_block: units_per_block.unwrap_or(DEFAULT_UNITS_PER_BLOCK),
        max_brushes: max_brushes.map(|m| m as usize).unwrap_or(DEFAULT_MAX_BRUSHES),
        include_shell: auto_shell.unwrap_or(false),
        texture_mode: parse_texture_mode(texture_mode.as_deref()),
        merge_across_materials: merge_across_materials.unwrap_or(false),
    };
    let (text, brush_count, side_count, materials) =
        build_vmf(world, sx1, sy1, sx2, sy2, sz1, sz2, mask.as_ref(), &opts)?;
    std::fs::write(&path, &text).map_err(|e| format!("Cannot write VMF: {e}"))?;
    let sky = world.sky;
    // Dev mode references a texture that already ships with every Source game — no sidecar to
    // write, and nothing for the caller to copy into their mod's content tree.
    let material_count = match opts.texture_mode {
        TextureMode::Dev => 1,
        TextureMode::FlatColor => {
            let written = write_materials_sidecar(std::path::Path::new(&path), &materials, sky)
                .map_err(|e| format!("VMF written, but failed to write materials sidecar: {e}"))?;
            written.len() as u32
        }
    };
    Ok(VmfExportResult {
        brush_count: brush_count as u32,
        side_count: side_count as u32,
        material_count,
    })
}

/// Dry-run counterpart of `export_vmf`: same merge + guard, no file writes. Lets the pre-export
/// modal show a live brush/side/material estimate as the user tweaks `unitsPerBlock`/texture
/// mode/merge toggle (which doesn't change brush *count* for units-per-block, only scale, but is
/// accepted for a consistent call shape) without committing to disk. A brush-count-guard failure
/// here surfaces the same actionable error the real export would.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn estimate_vmf(
    state: tauri::State<'_, AppState>,
    x1: i32, y1: i32, x2: i32, y2: i32,
    z_min: i32, z_max: i32,
    units_per_block: Option<i32>,
    max_brushes: Option<u32>,
    auto_shell: Option<bool>,
    texture_mode: Option<String>,
    merge_across_materials: Option<bool>,
) -> Result<VmfExportResult, String> {
    let ws = state.lock().unwrap_or_else(|p| p.into_inner());
    let world = ws.world.as_ref().ok_or("No world loaded")?;
    let (sx1, sy1, sx2, sy2, sz1, sz2, mask) = normalize_region(&ws, world, x1, y1, x2, y2, z_min, z_max);

    let opts = BuildOpts {
        units_per_block: units_per_block.unwrap_or(DEFAULT_UNITS_PER_BLOCK),
        max_brushes: max_brushes.map(|m| m as usize).unwrap_or(DEFAULT_MAX_BRUSHES),
        include_shell: auto_shell.unwrap_or(false),
        texture_mode: parse_texture_mode(texture_mode.as_deref()),
        merge_across_materials: merge_across_materials.unwrap_or(false),
    };
    let (_text, brush_count, side_count, materials) =
        build_vmf(world, sx1, sy1, sx2, sy2, sz1, sz2, mask.as_ref(), &opts)?;
    let material_count = match opts.texture_mode {
        TextureMode::Dev => 1,
        TextureMode::FlatColor => distinct_materials(&materials).len() as u32,
    };
    Ok(VmfExportResult {
        brush_count: brush_count as u32,
        side_count: side_count as u32,
        material_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use memmap2::MmapMut;

    /// Minimal single-chunk world (same layout as export.rs's test helper, duplicated since it
    /// lives in a `mod tests` private to that file).
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

    fn set_block(world: &mut LoadedWorld, x: usize, y: usize, z: i32, bt: u8) {
        let band = (z / 16) as usize;
        let lz = (z % 16) as usize;
        world.bytes[4096 + band * 8192 + x * 256 + y * 16 + lz] = bt;
    }

    fn set_paint(world: &mut LoadedWorld, x: usize, y: usize, z: i32, paint: u8) {
        let band = (z / 16) as usize;
        let lz = (z % 16) as usize;
        world.bytes[4096 + band * 8192 + x * 256 + y * 16 + lz + 4096] = paint;
    }

    /// Boxes must exactly tile `cells`: equal total volume, no pairwise overlap, full coverage,
    /// nothing outside the input.
    fn assert_exact_cover(cells: &[(i32, i32, i32)], boxes: &[(i32, i32, i32, i32, i32, i32)]) {
        let input: HashSet<(i32, i32, i32)> = cells.iter().copied().collect();
        let mut covered: HashSet<(i32, i32, i32)> = HashSet::new();
        let mut volume = 0u64;
        for &(x0, y0, z0, x1, y1, z1) in boxes {
            assert!(x0 <= x1 && y0 <= y1 && z0 <= z1, "degenerate box");
            volume += ((x1 - x0 + 1) as u64) * ((y1 - y0 + 1) as u64) * ((z1 - z0 + 1) as u64);
            for z in z0..=z1 {
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        assert!(input.contains(&(x, y, z)), "box covers ({x},{y},{z}) outside the input cells");
                        assert!(covered.insert((x, y, z)), "boxes overlap at ({x},{y},{z})");
                    }
                }
            }
        }
        assert_eq!(volume, input.len() as u64, "merged volume != input voxel count");
        assert_eq!(covered, input, "boxes don't cover every input cell");
    }

    /// Generic outward-winding/convexity check: for a convex solid, the average of every vertex
    /// across every face lies strictly inside, so each face's outward normal must point away from
    /// it. Works for axis-aligned box faces and 45°-sloped prism faces alike (unlike a
    /// box-specific min/max-center check).
    fn assert_faces_outward(planes: &[[[i32; 3]; 3]]) {
        let mut sum = [0i64; 3];
        let mut n = 0i64;
        for p in planes {
            for v in p {
                sum[0] += v[0] as i64; sum[1] += v[1] as i64; sum[2] += v[2] as i64;
                n += 1;
            }
        }
        let center = [sum[0] as f64 / n as f64, sum[1] as f64 / n as f64, sum[2] as f64 / n as f64];
        for p in planes {
            let normal = plane_normal(*p);
            assert_ne!(normal, [0, 0, 0], "degenerate plane {p:?}");
            let p1 = p[0];
            let d: f64 = (0..3).map(|i| normal[i] as f64 * (p1[i] as f64 - center[i])).sum();
            assert!(d > 0.0, "face normal {normal:?} (plane {p:?}) does not point outward from centroid {center:?}");
        }
    }

    #[test]
    fn test_greedy_merge_cube_is_one_box() {
        let mut cells = Vec::new();
        for z in 0..5 { for y in 0..5 { for x in 0..5 { cells.push((x, y, z)); } } }
        let boxes = greedy_merge_boxes(&cells);
        assert_eq!(boxes, vec![(0, 0, 0, 4, 4, 4)]);
        assert_exact_cover(&cells, &boxes);
    }

    #[test]
    fn test_greedy_merge_l_shape_exact_cover() {
        // 6×6×2 plateau with a 2×2 tower rising 5 more on one corner — an L in cross-section.
        let mut cells = Vec::new();
        for z in 0..2 { for y in 0..6 { for x in 0..6 { cells.push((x, y, z)); } } }
        for z in 2..7 { for y in 0..2 { for x in 0..2 { cells.push((x, y, z)); } } }
        let boxes = greedy_merge_boxes(&cells);
        assert_exact_cover(&cells, &boxes);
        assert!(boxes.len() <= 3, "L-shape should merge into a few boxes, got {}", boxes.len());
    }

    #[test]
    fn test_5x5x5_cube_emits_one_brush() {
        let mut world = make_test_world();
        for z in 0..5 { for y in 3..8 { for x in 3..8 { set_block(&mut world, x, y, z, 2); } } }
        let (text, brushes, sides, materials) = build_vmf(&world, 3, 3, 7, 7, 0, 4, None, &BuildOpts::legacy(40, DEFAULT_MAX_BRUSHES, false)).unwrap();
        assert_eq!(brushes, 1);
        assert_eq!(sides, 6);
        assert_eq!(text.matches("\tsolid\n").count(), 1);
        assert_eq!(text.matches("\"plane\"").count(), 6);
        assert!(text.contains("vuencedit/stone"), "placeholder material missing");
        assert_eq!(materials, vec![(2, 0)]);
        assert!(text.contains("worldspawn") && text.contains("func_detail"));
    }

    #[test]
    fn test_checkerboard_two_materials_no_degenerate_merge() {
        // Strict 3D checkerboard of stone/dirt: no two same-material cells share a face, so
        // nothing can merge — 64 single-cell brushes from a 4×4×4 region.
        let mut world = make_test_world();
        for z in 0..4 {
            for y in 0..4 {
                for x in 0..4 {
                    let bt = if (x + y + z as usize) % 2 == 0 { 2 } else { 3 };
                    set_block(&mut world, x, y, z, bt);
                }
            }
        }
        let boxes = merge_region(&world, 0, 0, 3, 3, 0, 3, None);
        assert_eq!(boxes.len(), 64);
        assert!(boxes.iter().all(|b| (b.x0, b.y0, b.z0) == (b.x1, b.y1, b.z1)));
    }

    #[test]
    fn test_different_paint_does_not_merge() {
        let mut world = make_test_world();
        set_block(&mut world, 3, 3, 0, 2);
        set_block(&mut world, 4, 3, 0, 2);
        set_paint(&mut world, 4, 3, 0, 1);
        let boxes = merge_region(&world, 3, 3, 4, 3, 0, 0, None);
        assert_eq!(boxes.len(), 2, "paint 0 and paint 1 stone must not merge");
        assert_ne!(material_name(2, 0), material_name(2, 1));
    }

    #[test]
    fn test_non_solid_blocks_are_excluded_from_opaque_merge() {
        // merge_region (the opaque-solid pass) still excludes water/fence/ramp/wedge — they
        // export through the transparent-merge and ramp/wedge-prism paths instead, exercised by
        // the mixed-selection and ramp/wedge tests below.
        let mut world = make_test_world();
        set_block(&mut world, 1, 1, 0, 2);  // stone — the only cell this pass exports
        set_block(&mut world, 2, 1, 0, 20); // water (transparent path)
        set_block(&mut world, 3, 1, 0, 21); // fence (transparent path)
        set_block(&mut world, 4, 1, 0, 24); // stone ramp (ramp/wedge path)
        set_block(&mut world, 5, 1, 0, 40); // stone wedge (ramp/wedge path)
        let boxes = merge_region(&world, 0, 0, 8, 8, 0, 5, None);
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0], MergedBox { x0: 1, y0: 1, z0: 0, x1: 1, y1: 1, z1: 0, bt: 2, paint: 0 });
    }

    #[test]
    fn test_mask_shapes_the_merge_input() {
        // 4×4 footprint filled solid over z 0..2; mask selects only the x<2 half.
        let mut world = make_test_world();
        for z in 0..3 { for y in 0..4 { for x in 0..4 { set_block(&mut world, x, y, z, 2); } } }
        // Row-major bit (y-y1)*width + (x-x1); width 4, bits 0,1 of each row → 0b0011 per row.
        let mask = SelectionMask { x1: 0, y1: 0, x2: 3, y2: 3, bits: vec![0x33, 0x33] };
        let masked = merge_region(&world, 0, 0, 3, 3, 0, 2, Some(&mask));
        let vol: u64 = masked.iter()
            .map(|b| ((b.x1 - b.x0 + 1) as u64) * ((b.y1 - b.y0 + 1) as u64) * ((b.z1 - b.z0 + 1) as u64))
            .sum();
        assert_eq!(vol, 2 * 4 * 3, "only the masked half's cells export");
        assert!(masked.iter().all(|b| b.x1 < 2), "no box may reach into the unmasked half");
        // Without the mask the full slab exports as one brush.
        let full = merge_region(&world, 0, 0, 3, 3, 0, 2, None);
        assert_eq!(full.len(), 1);
    }

    #[test]
    fn test_brush_count_guard_trips() {
        let mut world = make_test_world();
        for x in 0..4 { set_block(&mut world, x * 2, 0, 0, 2); } // 4 isolated stones → 4 brushes
        let err = build_vmf(&world, 0, 0, 7, 0, 0, 0, None, &BuildOpts::legacy(40, 3, false)).unwrap_err();
        assert!(err.contains("brushes"), "guard error should name the brush count: {err}");
        assert!(build_vmf(&world, 0, 0, 7, 0, 0, 0, None, &BuildOpts::legacy(40, 4, false)).is_ok());
    }

    #[test]
    fn test_empty_selection_errors() {
        let world = make_test_world();
        assert!(build_vmf(&world, 0, 0, 5, 5, 0, 5, None, &BuildOpts::legacy(40, DEFAULT_MAX_BRUSHES, false)).is_err());
    }

    #[test]
    fn test_source_bounds_transform() {
        // Cell (1,2,3) at 40 units/block: X 40..80, Eden y∈[2,3] → Source Y −120..−80, Z 120..160.
        let b = MergedBox { x0: 1, y0: 2, z0: 3, x1: 1, y1: 2, z1: 3, bt: 2, paint: 0 };
        assert_eq!(source_bounds(&b, 40), ([40, -120, 120], [80, -80, 160]));
    }

    #[test]
    fn test_plane_winding_outward_every_face() {
        // Includes a box with negative Source coords (any positive Eden y negates) to catch
        // sign errors the all-positive octant would hide.
        let boxes = [
            MergedBox { x0: 0, y0: 0, z0: 0, x1: 4, y1: 4, z1: 4, bt: 2, paint: 0 },
            MergedBox { x0: -3, y0: 5, z0: 1, x1: 2, y1: 9, z1: 2, bt: 3, paint: 7 },
        ];
        for b in &boxes {
            let (min, max) = source_bounds(b, 40);
            let planes = box_face_planes(min, max);
            assert_faces_outward(&planes);
            let mut normal_dirs: Vec<[i64; 3]> = planes.iter().map(|p| plane_normal(*p).map(i64::signum)).collect();
            normal_dirs.sort_unstable();
            let mut expected = vec![
                [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
            ];
            expected.sort_unstable();
            assert_eq!(normal_dirs, expected, "each ± axis must appear exactly once");
        }
    }

    #[test]
    fn test_ramp_prism_five_sides_outward_every_direction() {
        // Exercises the exact production path (solid_source_planes, incl. orient_outward), not a
        // hand-rolled duplicate of it.
        for dir in 0u8..4 {
            for &(x, y, z) in &[(0, 0, 0), (-3, 5, 2)] {
                let solid = VmfSolid::RampWedge { x, y, z, bt: 24 + dir, paint: 0 };
                let planes = solid_source_planes(&solid, 40);
                assert_eq!(planes.len(), 5);
                assert_faces_outward(&planes);
            }
        }
    }

    #[test]
    fn test_wedge_prism_five_sides_outward_every_direction() {
        for dir in 0u8..4 {
            for &(x, y, z) in &[(0, 0, 0), (-3, 5, 2)] {
                let solid = VmfSolid::RampWedge { x, y, z, bt: 40 + dir, paint: 0 };
                let planes = solid_source_planes(&solid, 40);
                assert_eq!(planes.len(), 5);
                assert_faces_outward(&planes);
            }
        }
    }

    #[test]
    fn test_ramps_wedges_one_brush_per_cell_not_merged() {
        let mut world = make_test_world();
        set_block(&mut world, 1, 1, 0, 24); // stone ramp S
        set_block(&mut world, 2, 1, 0, 24); // adjacent same ramp type — must NOT merge
        set_block(&mut world, 3, 1, 0, 40); // stone wedge SE
        let (text, brushes, sides, _) = build_vmf(&world, 0, 0, 5, 5, 0, 0, None, &BuildOpts::legacy(40, DEFAULT_MAX_BRUSHES, false)).unwrap();
        assert_eq!(brushes, 3, "one brush per ramp/wedge cell, no merging");
        assert_eq!(sides, 5 + 5 + 5);
        assert_eq!(text.matches("\tsolid\n").count(), 3);
    }

    #[test]
    fn test_transparent_cells_merge_but_not_with_opaque() {
        let mut world = make_test_world();
        // 3×1×1 water run + adjacent stone — must not merge across the water/stone boundary.
        for x in 0..3 { set_block(&mut world, x, 0, 0, 20); }
        set_block(&mut world, 3, 0, 0, 2);
        let transparent = merge_transparent_region(&world, 0, 0, 3, 0, 0, 0, None);
        assert_eq!(transparent.len(), 1, "the 3 water cells should merge into one box");
        assert_eq!(transparent[0], MergedBox { x0: 0, y0: 0, z0: 0, x1: 2, y1: 0, z1: 0, bt: 20, paint: 0 });
        let solid = merge_region(&world, 0, 0, 3, 0, 0, 0, None);
        assert_eq!(solid.len(), 1, "the stone cell stays in its own opaque merge, unmixed with water");
    }

    #[test]
    fn test_mixed_selection_counts_solid_ramp_wedge_transparent_separately() {
        let mut world = make_test_world();
        for z in 0..2 { for y in 3..6 { for x in 3..6 { set_block(&mut world, x, y, z, 2); } } } // 3x3x2 stone -> 1 merged brush
        set_block(&mut world, 8, 3, 0, 24); // ramp
        set_block(&mut world, 8, 4, 0, 40); // wedge
        for x in 0..2 { set_block(&mut world, x, 8, 0, 58); } // 2 glass cells -> 1 merged box
        let (text, brushes, sides, materials) = build_vmf(&world, 0, 0, 9, 9, 0, 3, None, &BuildOpts::legacy(40, DEFAULT_MAX_BRUSHES, false)).unwrap();
        assert_eq!(brushes, 4, "1 solid box + 1 ramp + 1 wedge + 1 glass box");
        assert_eq!(sides, 6 + 5 + 5 + 6);
        // Stone cuboid, stone ramp, and stone wedge all resolve to the same texture name
        // (`vuencedit/stone`) — that's intentional (see `material_name`'s doc comment) — while
        // glass gets its own. Distinctness is checked at the `(bt, paint)` level, which the
        // sidecar writer dedupes down to unique *names* separately (see its own tests).
        assert_eq!(materials, vec![(2, 0), (24, 0), (40, 0), (58, 0)]);
        assert!(text.contains("vuencedit/stone") && text.contains("vuencedit/glass"));
    }

    #[test]
    fn test_written_vmf_brush_and_side_counts_match() {
        let mut world = make_test_world();
        for z in 0..2 { for y in 0..3 { for x in 0..3 { set_block(&mut world, x, y, z, 2); } } }
        set_block(&mut world, 5, 5, 0, 3); // separate dirt cell → second brush
        let (text, brushes, sides, _) = build_vmf(&world, 0, 0, 6, 6, 0, 3, None, &BuildOpts::legacy(40, DEFAULT_MAX_BRUSHES, false)).unwrap();
        assert_eq!(brushes, 2);
        assert_eq!(sides, 12);
        assert_eq!(text.matches("\tsolid\n").count(), brushes);
        assert_eq!(text.matches("\"plane\"").count(), sides);
        assert!(text.contains("vuencedit/stone") && text.contains("vuencedit/dirt"));
    }

    #[test]
    fn test_material_name_shares_texture_across_shape_but_splits_on_paint() {
        assert_eq!(material_name(2, 0), "vuencedit/stone");
        assert_eq!(material_name(24, 0), "vuencedit/stone", "stone ramp shares the stone cuboid's texture");
        assert_eq!(material_name(40, 0), "vuencedit/stone", "stone wedge shares the stone cuboid's texture");
        assert_eq!(material_name(2, 1), "vuencedit/stone_p1");
        assert_ne!(material_name(2, 0), material_name(2, 1));
        // A block type with an empty BLOCK_FACE_TEX side entry (80 "custom") falls back to the
        // m_{bt} lineage.
        assert_eq!(material_name(80, 0), "vuencedit/m_80");
    }

    #[test]
    fn test_vtf_header_layout_and_pixel_dump() {
        let bytes = write_vtf(16, 16, [10, 20, 30]);
        assert_eq!(bytes.len(), VTF_HEADER_SIZE + 16 * 16 * 4);
        assert_eq!(&bytes[0..4], b"VTF\0");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 7, "version major");
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 1, "version minor");
        assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), VTF_HEADER_SIZE as u32, "headerSize");
        assert_eq!(u16::from_le_bytes(bytes[16..18].try_into().unwrap()), 16, "width");
        assert_eq!(u16::from_le_bytes(bytes[18..20].try_into().unwrap()), 16, "height");
        assert_eq!(
            u32::from_le_bytes(bytes[20..24].try_into().unwrap()),
            VTF_FLAG_NOMIP | VTF_FLAG_NOLOD,
            "flags must set NOMIP|NOLOD for a single-mip texture",
        );
        assert_eq!(u32::from_le_bytes(bytes[52..56].try_into().unwrap()), VTF_IMAGE_FORMAT_BGRA8888, "highResImageFormat");
        assert_eq!(bytes[56], 1, "mipmapCount");
        assert_eq!(u32::from_le_bytes(bytes[60..64].try_into().unwrap()), VTF_IMAGE_FORMAT_NONE, "lowResImageFormat (no thumbnail)");
        // First pixel is BGRA for the requested color, alpha opaque.
        let px = &bytes[VTF_HEADER_SIZE..VTF_HEADER_SIZE + 4];
        assert_eq!(px, &[30, 20, 10, 255]);
        // Every pixel is identical (flat fill) and the buffer is exactly one image, no mip chain.
        assert!(bytes[VTF_HEADER_SIZE..].chunks_exact(4).all(|p| p == px));
    }

    #[test]
    fn test_vmt_marks_translucent_only_when_requested() {
        let opaque = write_vmt("vuencedit/stone", false);
        let water = write_vmt("vuencedit/water", true);
        assert!(opaque.contains("\"$basetexture\" \"vuencedit/stone\""));
        assert!(!opaque.contains("$translucent"));
        assert!(water.contains("\"$basetexture\" \"vuencedit/water\""));
        assert!(water.contains("\"$translucent\" \"1\""));
    }

    /// Scratch dir under the OS temp dir, unique per test run via a counter — this crate has no
    /// `tempfile` dependency, so a hand-rolled unique subdir is the simplest option.
    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("vuencedit_vmf_test_{tag}_{n}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_materials_sidecar_writes_one_pair_per_distinct_name_plus_readme() {
        let dir = scratch_dir("sidecar");
        let vmf_path = dir.join("out.vmf");
        // (2, 0) stone and (24, 0) stone-ramp share a name and must collapse to one file pair;
        // (58, 0) glass and (20, 0) water are distinct and translucent.
        let materials = [(2u8, 0u8), (24, 0), (58, 0), (20, 0)];
        let written = write_materials_sidecar(&vmf_path, &materials, 0).unwrap();
        assert_eq!(written.len(), 3, "stone+stone-ramp collapse to one name");
        assert!(written.contains(&"vuencedit/stone".to_string()));
        assert!(written.contains(&"vuencedit/glass".to_string()));
        assert!(written.contains(&"vuencedit/water".to_string()));

        let mat_dir = dir.join("materials").join("vuencedit");
        for stem in ["stone", "glass", "water"] {
            assert!(mat_dir.join(format!("{stem}.vtf")).is_file(), "{stem}.vtf missing");
            assert!(mat_dir.join(format!("{stem}.vmt")).is_file(), "{stem}.vmt missing");
        }
        assert!(dir.join("materials").join("README.txt").is_file());

        let water_vmt = std::fs::read_to_string(mat_dir.join("water.vmt")).unwrap();
        assert!(water_vmt.contains("$translucent"), "water must be marked translucent");
        let stone_vmt = std::fs::read_to_string(mat_dir.join("stone.vmt")).unwrap();
        assert!(!stone_vmt.contains("$translucent"), "stone must not be marked translucent");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `skybox_shell`'s 6 slabs must tile `outer − inner` exactly: no pairwise overlap, and their
    /// combined volume equals outer minus inner. Also checks each slab is a well-formed box
    /// (min < max on every axis) so `box_face_planes` never sees a degenerate input.
    #[test]
    fn test_skybox_shell_slabs_tile_without_overlap() {
        let slabs = skybox_shell([0, 0, 0], [4, 4, 4], 40);
        assert_eq!(slabs.len(), 6);
        let boxes: Vec<([i32; 3], [i32; 3])> = slabs.iter().map(|s| match s {
            VmfSolid::RawBox { min, max, .. } => (*min, *max),
            _ => panic!("skybox_shell must only emit RawBox solids"),
        }).collect();

        for &(min, max) in &boxes {
            for axis in 0..3 {
                assert!(min[axis] < max[axis], "degenerate slab: {min:?}..{max:?}");
            }
        }

        fn vol(min: [i32; 3], max: [i32; 3]) -> i64 {
            (max[0] - min[0]) as i64 * (max[1] - min[1]) as i64 * (max[2] - min[2]) as i64
        }
        fn overlap_vol(a: ([i32; 3], [i32; 3]), b: ([i32; 3], [i32; 3])) -> i64 {
            let mut v = 1i64;
            for axis in 0..3 {
                let lo = a.0[axis].max(b.0[axis]);
                let hi = a.1[axis].min(b.1[axis]);
                v *= (hi - lo).max(0) as i64;
            }
            v
        }
        for i in 0..boxes.len() {
            for j in (i + 1)..boxes.len() {
                assert_eq!(overlap_vol(boxes[i], boxes[j]), 0, "slabs {i} and {j} overlap");
            }
        }

        // outer box = union bbox of all slabs; inner box = the hollow interior the slabs frame.
        let outer_min = [
            boxes.iter().map(|b| b.0[0]).min().unwrap(),
            boxes.iter().map(|b| b.0[1]).min().unwrap(),
            boxes.iter().map(|b| b.0[2]).min().unwrap(),
        ];
        let outer_max = [
            boxes.iter().map(|b| b.1[0]).max().unwrap(),
            boxes.iter().map(|b| b.1[1]).max().unwrap(),
            boxes.iter().map(|b| b.1[2]).max().unwrap(),
        ];
        let u = 40;
        let m = SHELL_MARGIN_BLOCKS;
        let inner_min = [(0 - m) * u, -((4 + m) + 1) * u, (0 - m).max(0) * u];
        let inner_max = [((4 + m) + 1) * u, -(0 - m) * u, ((4 + m) + 1) * u];
        let expected_total = vol(outer_min, outer_max) - vol(inner_min, inner_max);
        let actual_total: i64 = boxes.iter().map(|&(mn, mx)| vol(mn, mx)).sum();
        assert_eq!(actual_total, expected_total, "slab volumes must exactly tile outer minus inner");
    }

    #[test]
    fn test_shell_solids_never_enter_materials_sidecar_list() {
        let mut world = make_test_world();
        set_block(&mut world, 2, 2, 0, 2); // one stone cell
        let (text, brushes, _sides, materials) =
            build_vmf(&world, 2, 2, 2, 2, 0, 0, None, &BuildOpts::legacy(40, DEFAULT_MAX_BRUSHES, true)).unwrap();
        assert_eq!(brushes, 1 + 6, "1 stone cuboid + 6 shell slabs");
        assert_eq!(materials, vec![(2, 0)], "shell's RawBox solids must never appear in the material list");
        assert!(text.contains("tools/toolsskybox"), "shell material must still be written into the VMF text itself");
        assert!(text.contains("light_environment"));
        assert!(text.contains("info_player_start"));
    }

    #[test]
    fn test_shell_disabled_by_default_omits_shell_geometry_and_entities() {
        let mut world = make_test_world();
        set_block(&mut world, 2, 2, 0, 2);
        let (text, brushes, _sides, _materials) =
            build_vmf(&world, 2, 2, 2, 2, 0, 0, None, &BuildOpts::legacy(40, DEFAULT_MAX_BRUSHES, false)).unwrap();
        assert_eq!(brushes, 1);
        assert!(!text.contains("tools/toolsskybox"));
        assert!(!text.contains("light_environment"));
        assert!(!text.contains("info_player_start"));
    }

    #[test]
    fn test_dev_texture_mode_uses_dev_texture_not_bt_paint_name() {
        let mut world = make_test_world();
        set_block(&mut world, 2, 2, 0, 2); // stone
        set_block(&mut world, 5, 5, 0, 20); // water — transparent pass, still dev-textured
        let opts = BuildOpts {
            units_per_block: 40,
            max_brushes: DEFAULT_MAX_BRUSHES,
            include_shell: false,
            texture_mode: TextureMode::Dev,
            merge_across_materials: false,
        };
        let (text, ..) = build_vmf(&world, 0, 0, 8, 8, 0, 0, None, &opts).unwrap();
        assert!(text.contains(DEV_TEXTURE), "solids must reference the dev texture in Dev mode");
        assert!(!text.contains("vuencedit/stone"), "flat-color material names must not appear in Dev mode");
        assert!(!text.contains("vuencedit/water"), "flat-color material names must not appear in Dev mode");
    }

    #[test]
    fn test_dev_mode_writes_no_sidecar_flat_mode_still_does() {
        for (mode, expect_sidecar) in [(TextureMode::Dev, false), (TextureMode::FlatColor, true)] {
            let mut world = make_test_world();
            set_block(&mut world, 2, 2, 0, 2);
            let opts = BuildOpts {
                units_per_block: 40,
                max_brushes: DEFAULT_MAX_BRUSHES,
                include_shell: false,
                texture_mode: mode,
                merge_across_materials: false,
            };
            let (_text, _brushes, _sides, materials) =
                build_vmf(&world, 2, 2, 2, 2, 0, 0, None, &opts).unwrap();
            // Mirrors export_vmf's own gating so the test exercises the same decision the command
            // makes, without needing a real file path / AppState.
            let should_write = matches!(mode, TextureMode::FlatColor);
            assert_eq!(should_write, expect_sidecar);
            if should_write {
                let dir = scratch_dir("dev_mode_gate");
                let vmf_path = dir.join("out.vmf");
                let written = write_materials_sidecar(&vmf_path, &materials, 0).unwrap();
                assert!(!written.is_empty());
                std::fs::remove_dir_all(&dir).ok();
            }
        }
    }

    #[test]
    fn test_merge_across_materials_collapses_checkerboard_to_one_box() {
        // Same 4x4x4 stone/dirt checkerboard as test_checkerboard_two_materials_no_degenerate_merge
        // — under merge_region it's 64 single-cell brushes; merge_region_unified must fuse it into
        // one box since it ignores (bt,paint) entirely during merge.
        let mut world = make_test_world();
        for z in 0..4 {
            for y in 0..4 {
                for x in 0..4 {
                    let bt = if (x + y + z as usize) % 2 == 0 { 2 } else { 3 };
                    set_block(&mut world, x, y, z, bt);
                }
            }
        }
        let boxes = merge_region_unified(&world, 0, 0, 3, 3, 0, 3, None);
        assert_eq!(boxes.len(), 1, "merge-across-materials must fuse the whole checkerboard into one box");
        assert_eq!(boxes[0], MergedBox { x0: 0, y0: 0, z0: 0, x1: 3, y1: 3, z1: 3, bt: 2, paint: 0 },
            "tie-broken to the smallest (bt,paint) tuple — stone (2,0) over dirt (3,0)");

        let opts = BuildOpts {
            units_per_block: 40,
            max_brushes: DEFAULT_MAX_BRUSHES,
            include_shell: false,
            texture_mode: TextureMode::FlatColor,
            merge_across_materials: true,
        };
        let (_text, brushes, ..) = build_vmf(&world, 0, 0, 3, 3, 0, 3, None, &opts).unwrap();
        assert_eq!(brushes, 1, "build_vmf must route through the unified merge when the opt-in flag is set");
    }

    #[test]
    fn test_merge_across_keeps_opaque_and_transparent_separate() {
        // 3 stone + 1 water cell in a row: merge-across-materials must still never fuse opaque
        // with transparent, even though both passes now ignore (bt,paint) internally.
        let mut world = make_test_world();
        for x in 0..3 { set_block(&mut world, x, 0, 0, 2); }
        set_block(&mut world, 3, 0, 0, 20);
        let opaque = merge_region_unified(&world, 0, 0, 3, 0, 0, 0, None);
        let transparent = merge_transparent_region_unified(&world, 0, 0, 3, 0, 0, 0, None);
        assert_eq!(opaque.len(), 1, "the 3 stone cells merge into one opaque box");
        assert_eq!(opaque[0], MergedBox { x0: 0, y0: 0, z0: 0, x1: 2, y1: 0, z1: 0, bt: 2, paint: 0 });
        assert_eq!(transparent.len(), 1, "the water cell is its own transparent box");
        assert_eq!(transparent[0], MergedBox { x0: 3, y0: 0, z0: 0, x1: 3, y1: 0, z1: 0, bt: 20, paint: 0 });
    }

    #[test]
    fn test_dominant_material_tie_breaks_to_smallest_tuple() {
        let mut cells = CellMaterials::new();
        cells.insert((0, 0, 0), (5, 0));
        cells.insert((1, 0, 0), (2, 0));
        // Equal counts (1 each) — smallest (bt,paint) tuple wins: (2,0) < (5,0).
        assert_eq!(dominant_material(&cells, 0, 0, 0, 1, 0, 0), (2, 0));
    }
}
