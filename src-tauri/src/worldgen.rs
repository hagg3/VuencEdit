//! Procedural world generation: Perlin/simplex noise, natural biome terrain,
//! the classic legacy generator, and the TG2 generator — plus the tauri commands
//! that create/preview worlds from each.
use crate::colors::{block_color, grass_color};
use crate::{
    place_normal_tree, place_pine_tree, serialize_bytes_b64,
    set_block_abs, LoadedWorld, Rng64, NORMAL_LEAF_PAINTS, SNOW_FLOWER_PAINTS,
    SNOW_LEAF_PAINTS,
};
use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use tauri::Emitter;

// ── Perlin noise (ported from the Eden game's fixed permutation noiseFast) ──────
// Uses the same permutation table as TerrainGenerator.mm so generated terrain
// will match the old game's aesthetic if it ever re-enabled procedural generation.
pub(crate) const PERLIN_PERM: [u8; 256] = [
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
pub(crate) fn pnoise_fade(t: f64) -> f64 { t * t * t * (t * (t * 6.0 - 15.0) + 10.0) }
#[inline]
pub(crate) fn pnoise_lerp(t: f64, a: f64, b: f64) -> f64 { a + t * (b - a) }
#[inline]
pub(crate) fn pnoise_grad(hash: u8, x: f64, y: f64, z: f64) -> f64 {
    let h = hash & 15;
    let u = if h < 8 { x } else { y };
    let v = if h < 4 { y } else if h == 12 || h == 14 { x } else { z };
    (if h & 1 == 0 { u } else { -u }) + (if h & 2 == 0 { v } else { -v })
}
pub(crate) fn perlin3(x: f64, y: f64, z: f64) -> f64 {
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

pub(crate) fn chunk_set(data: &mut [u8], lx: usize, ly: usize, z: usize, bt: u8) {
    let bi = (z / 16) * 8192 + lx * 256 + ly * 16 + (z % 16);
    if bi < data.len() { data[bi] = bt; }
}
pub(crate) fn chunk_get(data: &[u8], lx: usize, ly: usize, z: usize) -> u8 {
    let bi = (z / 16) * 8192 + lx * 256 + ly * 16 + (z % 16);
    if bi < data.len() { data[bi] } else { 0 }
}
pub(crate) fn chunk_set_paint(data: &mut [u8], lx: usize, ly: usize, z: usize, paint: u8) {
    let bi = (z / 16) * 8192 + lx * 256 + ly * 16 + (z % 16) + 4096;
    if bi < data.len() { data[bi] = paint; }
}
#[cfg(test)]
pub(crate) fn chunk_get_paint(data: &[u8], lx: usize, ly: usize, z: usize) -> u8 {
    let bi = (z / 16) * 8192 + lx * 256 + ly * 16 + (z % 16) + 4096;
    if bi < data.len() { data[bi] } else { 0 }
}

#[derive(Clone, Copy)]
pub(crate) struct NaturalConfig {
    pub(crate) seed: u32,
    pub(crate) base_height: usize,
    pub(crate) roughness: f64,          // 0..1 amplitude scale
    pub(crate) erosion: f64,            // 0..1 flatness strength: high-erosion regions get reduced relief
    pub(crate) terrain_scale: f64,      // base noise wavelength in blocks (larger = broader features)
    pub(crate) extreme: bool,           // 256z only: towering mountain relief + sharper ridges
    pub(crate) water_z: i32,            // -1 = no standing water
    pub(crate) rivers: bool,
    pub(crate) biome: u8,               // single-mode biome: 0 grassland, 1 desert, 2 snow, 3 lava, 4 classic hills
    pub(crate) biome_mode: u32,         // 0 single (use `biome`), 1 mixed (per-column climate blend)
    pub(crate) biome_scale: f64,        // mixed-mode biome region wavelength in blocks
    pub(crate) snow_caps: bool,
    pub(crate) tree_density_denom: u64, // 0 = none; else 1-in-N grass columns
    pub(crate) cave_density: u32,       // 0 none, 1 rare, 2 common
    pub(crate) cave_style: u32,         // 0 spaghetti tunnels, 1 classic 3D-noise caves
    pub(crate) caverns: bool,           // large open caverns + deep lava pools
    pub(crate) flood_caves: bool,       // false = cave air stays dry; true = water floods caves below water_z
    pub(crate) ore_density: u32,        // 0 none, 1 sparse, 2 rich
    pub(crate) vegetation: u32,         // 0 none, 1 light, 2 lush
    pub(crate) structures: u32,         // 0 none, 1 sparse, 2 common
    pub(crate) clouds: bool,
}

/// Vertical relief as a fraction of world height, and the ridged-mountain weight.
/// "Extreme" mode (256z only) pushes peaks far higher and sharpens ridges.
#[inline]
pub(crate) fn relief_factor(cfg: &NaturalConfig) -> f64 { if cfg.extreme { 0.62 } else { 0.42 } }
#[inline]
pub(crate) fn ridge_weight(cfg: &NaturalConfig) -> f64 { if cfg.extreme { 1.7 } else { 1.1 } }

// ── Noise helpers (built on perlin3) ───────────────────────────────────────────

#[inline]
pub(crate) fn fbm2(x: f64, y: f64, octaves: u32) -> f64 {
    let (mut sum, mut freq, mut amp, mut norm) = (0.0f64, 1.0f64, 1.0f64, 0.0f64);
    for _ in 0..octaves {
        sum += perlin3(x * freq, y * freq, 0.5) * amp;
        norm += amp; freq *= 2.0; amp *= 0.5;
    }
    if norm > 0.0 { sum / norm } else { 0.0 }
}

#[inline]
pub(crate) fn fbm3(x: f64, y: f64, z: f64, octaves: u32) -> f64 {
    let (mut sum, mut freq, mut amp, mut norm) = (0.0f64, 1.0f64, 1.0f64, 0.0f64);
    for _ in 0..octaves {
        sum += perlin3(x * freq, y * freq, z * freq) * amp;
        norm += amp; freq *= 2.0; amp *= 0.5;
    }
    if norm > 0.0 { sum / norm } else { 0.0 }
}

#[inline]
pub(crate) fn ridged2(x: f64, y: f64, octaves: u32) -> f64 {
    let (mut sum, mut freq, mut amp, mut norm) = (0.0f64, 1.0f64, 1.0f64, 0.0f64);
    for _ in 0..octaves {
        let n = 1.0 - perlin3(x * freq, y * freq, 0.5).abs();
        sum += n * n * amp;
        norm += amp; freq *= 2.0; amp *= 0.5;
    }
    if norm > 0.0 { sum / norm } else { 0.0 }
}

#[inline]
pub(crate) fn hash3(x: i32, y: i32, z: i32, seed: u32) -> u64 {
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

pub(crate) const FLOWER_PAINTS: [u8; 6] = [1, 2, 3, 6, 8, 16];

#[inline]
pub(crate) fn natural_sf(seed: u32) -> f64 { (seed as f64) * 0.0013 + 17.0 }

/// True if the column lies inside a river channel.
#[inline]
pub(crate) fn river_here(wx: f64, wy: f64, cfg: &NaturalConfig) -> bool {
    if !cfg.rivers { return false; }
    let sf = natural_sf(cfg.seed);
    let scale = cfg.terrain_scale.max(24.0);
    let rn = fbm2((wx + sf * 2.0) / (scale * 2.2), (wy + sf * 2.0) / (scale * 2.2), 2);
    rn.abs() < 0.055
}

/// World-space surface height for a column (domain-warped fBm + ridged mountains + rivers).
pub(crate) fn terrain_height(wx: f64, wy: f64, cfg: &NaturalConfig, t_height: usize) -> i32 {
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
pub(crate) fn river_carved_height(h: f64, wx: f64, wy: f64, cfg: &NaturalConfig) -> f64 {
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
pub(crate) fn carve_cave(wx: f64, wy: f64, z: f64, cfg: &NaturalConfig) -> bool {
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
pub(crate) fn ore_block(wx: i32, wy: i32, z: i32, surf_z: usize, cfg: &NaturalConfig) -> u8 {
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
pub(crate) fn biome_climate(wx: i32, wy: i32, cfg: &NaturalConfig) -> (f64, f64) {
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
pub(crate) fn biome_at(wx: i32, wy: i32, surf_z: usize, cfg: &NaturalConfig, t_height: usize) -> u8 {
    if cfg.biome_mode == 0 { return cfg.biome; }
    let (temp, moist) = biome_climate(wx, wy, cfg);
    // Altitude lapse: ground above the base height cools down.
    let alt = ((surf_z as f64 - cfg.base_height as f64) / t_height as f64).max(0.0);
    // Per-column jitter scatters the climate values within a small band so biome
    // borders break up into a speckled transition (à la Minecraft) instead of a
    // crisp line. Deterministic per column, so every pass agrees on the result.
    pub(crate) const BIOME_DITHER: f64 = 0.16;
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
pub(crate) fn column_slope(heights: &[u16], bw: usize, bh: usize, wx: i32, wy: i32) -> i32 {
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
pub(crate) const CLIFF_SLOPE: i32 = 2;

/// Surface block + paint for a dry-land column of the given (already-resolved) biome.
pub(crate) fn surface_block(biome: u8, cfg: &NaturalConfig, surf_z: usize, snowline: f64, near_water: bool, wx: i32, wy: i32) -> (u8, u8) {
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
pub(crate) fn fill_chunk_terrain(
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
pub(crate) fn classic_biome_rocky(noise: &ClassicNoise, wx: i32, wy: i32, surf_z: i32, seed: f64) -> bool {
    classic_skin_block(noise, wx, wy, surf_z, seed) == 0
}

/// Classic Hills biome column fill: the legacy stone body + classic caves + the
/// bumpy, overhung holey dirt skin. Soil columns are capped with grass so the
/// natural decoration pass (trees, vegetation, structures) still finds a grassy
/// top; rock-outcrop columns (`classic_biome_rocky`) are solid stone capped with
/// stone, giving exposed stone patches visible from directly above. Shares the
/// classic noise helpers with the Classic terrain tab.
pub(crate) fn fill_classic_biome_chunk(
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

pub(crate) struct WorldGen<'a> {
    pub(crate) chunks: &'a mut Vec<Vec<u8>>,
    pub(crate) wc: usize,
    pub(crate) hc: usize,
    pub(crate) t_height: usize,
    pub(crate) water_mask: &'a [bool], // length wc*16 * hc*16; true = column is under standing water
}
impl<'a> WorldGen<'a> {
    #[inline]
    pub(crate) fn in_bounds(&self, wx: i32, wy: i32, z: i32) -> bool {
        wx >= 0 && wy >= 0 && z >= 0
            && (wx as usize) < self.wc * 16
            && (wy as usize) < self.hc * 16
            && (z as usize) < self.t_height
    }
    #[inline]
    pub(crate) fn chunk_index(&self, wx: i32, wy: i32) -> usize {
        let cx = (wx as usize) / 16;
        let cy = (wy as usize) / 16;
        cy * self.wc + cx
    }
    #[inline]
    pub(crate) fn get(&self, wx: i32, wy: i32, z: i32) -> u8 {
        if !self.in_bounds(wx, wy, z) { return 0; }
        let ci = self.chunk_index(wx, wy);
        chunk_get(&self.chunks[ci], (wx as usize) % 16, (wy as usize) % 16, z as usize)
    }
    /// Set a block type, always clearing the paint byte so a new block never
    /// inherits the paint of whatever terrain/feature occupied the cell before.
    #[inline]
    pub(crate) fn set(&mut self, wx: i32, wy: i32, z: i32, bt: u8) {
        if !self.in_bounds(wx, wy, z) { return; }
        let ci = self.chunk_index(wx, wy);
        let (lx, ly) = ((wx as usize) % 16, (wy as usize) % 16);
        chunk_set(&mut self.chunks[ci], lx, ly, z as usize, bt);
        chunk_set_paint(&mut self.chunks[ci], lx, ly, z as usize, 0);
    }
    #[inline]
    pub(crate) fn set_paint(&mut self, wx: i32, wy: i32, z: i32, paint: u8) {
        if !self.in_bounds(wx, wy, z) { return; }
        let ci = self.chunk_index(wx, wy);
        chunk_set_paint(&mut self.chunks[ci], (wx as usize) % 16, (wy as usize) % 16, z as usize, paint);
    }
    /// Place a block only where the cell is currently air.
    #[inline]
    pub(crate) fn set_if_air(&mut self, wx: i32, wy: i32, z: i32, bt: u8) {
        if self.get(wx, wy, z) == 0 { self.set(wx, wy, z, bt); }
    }
    /// True if the column at (wx, wy) lies under standing water (lake/ocean/river).
    #[inline]
    pub(crate) fn column_is_water(&self, wx: i32, wy: i32) -> bool {
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
pub(crate) trait VoxelSink {
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

pub(crate) fn place_cactus(gen: &mut WorldGen, wx: i32, wy: i32, sz: i32, h: u64) {
    let ch = 2 + (h % 3) as i32;
    for i in 1..=ch {
        if sz + i >= gen.t_height as i32 { break; }
        gen.put(wx, wy, sz + i, 16, 22);
    }
}

pub(crate) fn place_boulder(gen: &mut WorldGen, wx: i32, wy: i32, sz: i32, h: u64) {
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

pub(crate) fn decorate(gen: &mut WorldGen, heights: &[u16], cfg: &NaturalConfig) {
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
pub(crate) fn pad_levels(heights: &[u16], bw: usize, bh: usize, x0: i32, y0: i32, w: i32, d: i32) -> Option<(i32, i32)> {
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
pub(crate) fn prep_pad(gen: &mut WorldGen, heights: &[u16], bw: usize, x0: i32, y0: i32, w: i32, d: i32, base_z: i32, floor_bt: u8) {
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
pub(crate) const GRAY_PAINTS: [u8; 3] = [18, 27, 36];

/// Place a brick block tinted a natural weathered gray (so structures read as
/// stone masonry rather than the default red brick). Non-brick blocks pass through.
#[inline]
pub(crate) fn set_brick(gen: &mut WorldGen, x: i32, y: i32, z: i32, gray: u8) {
    gen.set(x, y, z, 13);
    gen.set_paint(x, y, z, gray);
}

pub(crate) fn build_cabin(gen: &mut WorldGen, heights: &[u16], bw: usize, x0: i32, y0: i32, base_z: i32) {
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

pub(crate) fn build_well(gen: &mut WorldGen, heights: &[u16], bw: usize, x0: i32, y0: i32, base_z: i32, gray: u8) {
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

pub(crate) fn build_tower(gen: &mut WorldGen, heights: &[u16], bw: usize, x0: i32, y0: i32, base_z: i32, h: u64, gray: u8) {
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

pub(crate) fn build_ruins(gen: &mut WorldGen, x0: i32, y0: i32, base_z: i32, h: u64, mat: u8, gray: u8) {
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

pub(crate) fn build_pyramid(gen: &mut WorldGen, heights: &[u16], bw: usize, x0: i32, y0: i32, base_z: i32) {
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

pub(crate) fn try_place_structure(gen: &mut WorldGen, heights: &[u16], bw: usize, bh: usize, ax: i32, ay: i32, cfg: &NaturalConfig, h: u64) {
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

pub(crate) fn place_structures(gen: &mut WorldGen, heights: &[u16], cfg: &NaturalConfig) {
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

pub(crate) fn place_clouds(gen: &mut WorldGen, cfg: &NaturalConfig) {
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
pub(crate) const BIOME_CLASSIC: u8 = 4;

/// Map a `NaturalConfig` onto a `ClassicConfig` so the stable classic heightmap /
/// cave / skin routines can drive the Classic Hills biome inside the natural
/// pipeline. Roughness picks the legacy `variance`; caves follow `cave_density`.
pub(crate) fn classic_cfg_for_natural(cfg: &NaturalConfig) -> ClassicConfig {
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
pub(crate) fn generate_natural_world(
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

    // 1. Global heightmap (single source of truth for cross-chunk features). Each row is an
    // independent noise sample, so this parallelizes cleanly over rows.
    let mut heights = vec![0u16; bw * bh];
    heights.par_chunks_mut(bw).enumerate().for_each(|(wy, row)| {
        for (wx, h_out) in row.iter_mut().enumerate() {
            *h_out = if cfg.biome == BIOME_CLASSIC {
                let h = classic_height(&classic_noise, wx as f64, wy as f64, &ccfg, t_height) as f64;
                let h = river_carved_height(h, wx as f64, wy as f64, cfg);
                (h.round() as i32).clamp(2, (t_height - 6) as i32) as u16
            } else {
                terrain_height(wx as f64, wy as f64, cfg, t_height) as u16
            };
        }
    });
    progress("Shaping terrain", 0.08);

    // 1b. Water mask — which columns end up under standing water (lake/ocean/river).
    //     Used so vegetation and boulders never sit on or overhang water.
    let mut water_mask = vec![false; bw * bh];
    if cfg.water_z >= 0 || cfg.rivers {
        water_mask.par_chunks_mut(bw).enumerate().for_each(|(wy, row)| {
            for (wx, w_out) in row.iter_mut().enumerate() {
                let surf = heights[wy * bw + wx] as i32;
                let mut wl = cfg.water_z;
                if river_here(wx as f64, wy as f64, cfg) {
                    wl = wl.max(cfg.base_height as i32 - 1);
                }
                if surf <= wl { *w_out = true; }
            }
        });
    }

    progress("Filling chunks", 0.12);

    // 2. Per-chunk column fill (cache-friendly, continuous noise across borders). Chunks are
    // independent Vec<u8>s at disjoint indices, so fill each one in parallel; progress can only
    // be reported after the whole pass (no way to observe partial completion across threads).
    chunks.par_iter_mut().enumerate().for_each(|(ci, chunk)| {
        let cx = ci % wc;
        let cy = ci / wc;
        fill_chunk_terrain(chunk, cx, cy, wc, &heights, cfg, &classic_noise, t_height);
    });
    progress("Filling chunks", 0.80);

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
pub(crate) fn gen_progress_reporter(app: tauri::AppHandle) -> impl FnMut(&str, f32) {
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
pub(crate) fn create_world(
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

    pub(crate) const CENTER_CHUNK: i32 = 4096;
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
pub(crate) fn natural_config_from_params(
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
pub(crate) struct PreviewImage {
    pub(crate) width: u32,
    pub(crate) height: u32,
    #[serde(serialize_with = "serialize_bytes_b64")]
    pub(crate) pixels: Vec<u8>, // RGBA, row-major (alpha always 255)
}

/// Fast top-down preview of a natural world: samples the heightmap, biome and
/// surface colour on a downsampled grid (no chunk fill, caves or decoration) and
/// applies a light height/slope hillshade. Lets the New World dialog show the
/// terrain before committing to a full generate + file write.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn preview_natural_world(
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
pub(crate) fn create_natural_world(
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

    pub(crate) const CENTER_CHUNK: i32 = 4096;
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

pub(crate) struct ClassicConfig {
    pub(crate) seed: u32,
    pub(crate) variance: f64,      // legacy heightmap `var` (default 3 = how dramatic the relief is)
    pub(crate) base_height: usize, // legacy `offsety` (heightmap baseline; default t_height/2)
    pub(crate) gen_caves: bool,    // legacy `genCaves`: 3D-noise cave carving
    pub(crate) tall_caves: bool,   // early-Eden style: taller, vertically-stretched caves with variegated walls
    pub(crate) tree_spacing: u64,  // legacy TREE_SPACING (1-in-N grass columns); 0 = no trees
    pub(crate) flowers: bool,      // sparse surface flowers (too many crash the modern game's sprite loader)
    pub(crate) clouds: bool,       // legacy generateCloud pass
}

// Place a flower on roughly 1-in-N exposed grass cells. The modern game crashes
// when a world contains too many flower sprites, so classic keeps them sparse.
pub(crate) const CLASSIC_FLOWER_SPARSITY: u64 = 64;

// Leaf paint bytes from the legacy placeTree (`ct[4] = {0,19,20,21}`).
pub(crate) const CLASSIC_LEAF_PAINTS: [u8; 4] = [0, 19, 20, 21];

/// Seeded port of the classic Perlin gradient noise (`noise2`/`noise3` + `init`,
/// TerrainGenerator.mm 636–881). The gradient tables and permutation are filled
/// from a seeded `Rng64` (instead of libc `random()`) so output is deterministic
/// per world seed.
pub(crate) struct ClassicNoise {
    p:  [usize; 514],
    g2: [[f64; 2]; 514],
    g3: [[f64; 3]; 514],
}
impl ClassicNoise {
    #[inline] fn sc(t: f64) -> f64 { t * t * (3.0 - 2.0 * t) }      // s_curve
    #[inline] fn lp(t: f64, a: f64, b: f64) -> f64 { a + t * (b - a) } // lerp

    pub(crate) fn new(seed: u32) -> Self {
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
    pub(crate) fn setup(v: f64) -> (usize, usize, f64, f64) {
        pub(crate) const N: f64 = 4096.0;       // bias keeps the truncation positive
        let t = v + N;
        let it = t as i64;           // v is always positive here, so trunc == floor
        let b0 = (it as usize) & 0xff;
        let b1 = (b0 + 1) & 0xff;
        let r0 = t - it as f64;
        (b0, b1, r0, r0 - 1.0)
    }

    pub(crate) fn noise2(&self, x: f64, y: f64) -> f64 {
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

    pub(crate) fn noise3(&self, x: f64, y: f64, z: f64) -> f64 {
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
pub(crate) fn classic_height(noise: &ClassicNoise, wx: f64, wy: f64, cfg: &ClassicConfig, t_height: usize) -> usize {
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
pub(crate) fn classic_cave_block(noise: &ClassicNoise, wx: i32, wy: i32, y: i32, y_scale: f64, seed: f64) -> u8 {
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
pub(crate) fn classic_skin_block(noise: &ClassicNoise, wx: i32, wy: i32, y: i32, seed: f64) -> u8 {
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
pub(crate) fn fill_classic_chunk(
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
pub(crate) fn classic_decorate(gen: &mut WorldGen, heights: &[u16], cfg: &ClassicConfig, rng: &mut Rng64) {
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
pub(crate) fn place_classic_tree(gen: &mut WorldGen, x: i32, z: i32, y: i32, rng: &mut Rng64) {
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

pub(crate) fn classic_place_trees(gen: &mut WorldGen, heights: &[u16], cfg: &ClassicConfig, rng: &mut Rng64) {
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
pub(crate) fn place_classic_clouds(gen: &mut WorldGen, cfg: &ClassicConfig, rng: &mut Rng64) {
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
pub(crate) fn generate_classic_world(
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
    heights.par_chunks_mut(bw).enumerate().for_each(|(wy, row)| {
        for (wx, h_out) in row.iter_mut().enumerate() {
            *h_out = classic_height(&noise, wx as f64, wy as f64, cfg, t_height) as u16;
        }
    });
    progress("Shaping terrain", 0.10);

    chunks.par_iter_mut().enumerate().for_each(|(ci, chunk)| {
        let cx = ci % wc;
        let cy = ci / wc;
        fill_classic_chunk(chunk, cx, cy, wc, &heights, cfg, &noise, t_height);
    });
    progress("Filling chunks", 0.80);

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
pub(crate) fn create_classic_world(
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
pub(crate) fn create_classic_world_inner(
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

    pub(crate) const CENTER_CHUNK: i32 = 4096;
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

pub(crate) fn write_world_file(
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

pub(crate) struct Tg2Config {
    pub(crate) seed: u32,
    pub(crate) terrain_type: u8,  // 0=Plains 1=Mars 2=RiverForest 3=Mtn+River 4=Desert
                       // 5=Ponies 6=Beach 7=Mix 8=Flat 9=CustomMix
    pub(crate) sky_islands: bool,
    pub(crate) struct_freq: u32,  // 0=sparse 1=normal 2=dense
    pub(crate) clouds: bool,
    pub(crate) amplitude: f64,    // relief multiplier (1.0 = native TG2 relief)
    pub(crate) sea_level_off: i32,// additive offset to water/sea levels (blocks, pre-vscale)
    pub(crate) blend: bool,       // soften biome zone boundaries (experimental)
    pub(crate) caves: bool,
    pub(crate) tall_caves: bool,
    pub(crate) custom_biomes: [u8; 4], // NW/NE/SW/SE biome for terrain_type=9
}

/// Flat voxel workspace.  Axes: x=EdenX, z=EdenY(south), y=EdenZ(height).
pub(crate) struct Tg2Grid {
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
    pub(crate) fn new(gsize: usize, t_height: usize, vs: f64, amp: f64, sea_off: i32) -> Self {
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
    pub(crate) fn get(&self, x: i32, z: i32, y: i32) -> u8 {
        if !self.ok(x,z,y) { return 0; }
        self.blockz[self.idx(x as usize, z as usize, y as usize)]
    }
    pub(crate) fn put(&mut self, x: i32, z: i32, y: i32, bt: u8, c: u8) {
        if !self.ok(x,z,y) { return; }
        let i = self.idx(x as usize, z as usize, y as usize);
        self.blockz[i]=bt; self.colorz[i]=c;
    }
    pub(crate) fn set_bt(&mut self, x: i32, z: i32, y: i32, bt: u8) {
        if !self.ok(x,z,y) { return; }
        let i = self.idx(x as usize, z as usize, y as usize);
        self.blockz[i]=bt;
    }
    pub(crate) fn clampy(&self, h: i32) -> i32 { h.max(1).min(self.t_height as i32 - 1) }
}

// Paint cycle helpers — ports of colorCycle/2-7 (TerrainGen2.mm L39-212).
// NUM_COLORS=54; return value is a paint index 0-53.
pub(crate) const TG2_NUM_COLORS: i32 = 54;
pub(crate) fn tg2_cc (idx:i32,typ:i32)->u8{let c=if typ==1{8}else{(idx/12)%8};let mut h=idx%8;if h>=4{h=7-h;}h+=1;((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
pub(crate) fn tg2_cc2(idx:i32,c:i32  )->u8{let mut h=(idx/5)%8;if h>=4{h=7-h;}h+=1;((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
pub(crate) fn tg2_cc3(idx:i32,c:i32  )->u8{let mut h=(idx/5)%8;if h>=4{h=7-h;}h+=3;if h==6{h=5;}((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
pub(crate) fn tg2_cc4(idx:i32,c:i32  )->u8{let mut h=(idx/5)%8;if h>=4{h=7-h;}h+=2;if h==6{return 0;}((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
pub(crate) fn tg2_cc5(idx:i32,c:i32  )->u8{let mut h=(idx/5)%8;if h>=4{h=7-h;}if h==6{return 0;}((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
pub(crate) fn tg2_cc6(idx:i32,c:i32  )->u8{let mut h=idx%8;if h>=4{h=7-h;}if h==6{return 0;}((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}
pub(crate) fn tg2_cc7(idx:i32,c:i32  )->u8{let mut h=(idx/5)%8;if h>=5{h=8-h;}((h*9+c+1).rem_euclid(TG2_NUM_COLORS))as u8}

// Noise helpers
pub(crate) fn tg2_fbm2(n: &ClassicNoise, x: i32, z: i32, seed: f64, f0: f64, a0: f64, var: f64) -> f64 {
    let (mut f, mut a, mut acc) = (f0, a0, 0.0f64);
    for _ in 0..10 {
        acc += n.noise2(f*(x as f64+seed)/128.0, f*(z as f64+seed)/128.0)*a*var;
        f*=2.0; a/=2.0;
    }
    acc
}
pub(crate) fn tg2_fbm3(n: &ClassicNoise, x: i32, z: i32, y: i32, seed: f64, f0: f64, a0: f64) -> f64 {
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
pub(crate) fn tg2_fill_column(
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
pub(crate) fn tg2_make_tree(g: &mut Tg2Grid, x: i32, z: i32, y: i32, rng: &mut Rng64) {
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
pub(crate) fn tg2_make_tree2(g: &mut Tg2Grid, x: i32, z: i32, y: i32, hh: i32, rng: &mut Rng64) {
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
pub(crate) fn tg2_make_palm(g: &mut Tg2Grid, x: i32, z: i32, y: i32, hh: i32, rng: &mut Rng64) {
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
pub(crate) fn tg2_make_dirt(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, sx: i32, sz: i32, ex: i32, ez: i32) {
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
pub(crate) fn tg2_make_mars(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, sx: i32, sz: i32, ex: i32, ez: i32) {
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
pub(crate) fn tg2_make_river_trees(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, rng: &mut Rng64, sx: i32, sz: i32, ex: i32, ez: i32) {
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
pub(crate) fn tg2_make_mountains(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, rng: &mut Rng64, sx: i32, sz: i32, ex: i32, ez: i32) {
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
pub(crate) fn tg2_make_transition(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, sx: i32, sz: i32, ex: i32, ez: i32) {
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
pub(crate) fn tg2_make_green_hills(g: &mut Tg2Grid, noise: &ClassicNoise, seed2: f64, height: i32) {
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
pub(crate) fn tg2_make_beach(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, rng: &mut Rng64, sx: i32, sz: i32, ex: i32, ez: i32) {
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
pub(crate) fn tg2_make_desert(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, rng: &mut Rng64, sx: i32, sz: i32, ex: i32, ez: i32, pyramid_freq: u32) {
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
pub(crate) fn tg2_make_ponies(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, sx: i32, sz: i32, ex: i32, ez: i32) {
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
pub(crate) fn tg2_make_classic_gen(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, sx: i32, sz: i32, ex: i32, ez: i32) {
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
pub(crate) fn tg2_make_pyramid(g: &mut Tg2Grid, cx: i32, cz: i32, h: i32) {
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
pub(crate) fn tg2_make_pyramid2(g: &mut Tg2Grid, cx: i32, cz: i32, h: i32, _color: u8, sy: i32) {
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
pub(crate) fn tg2_make_volcano(g: &mut Tg2Grid, cx: i32, cz: i32, base_y: i32, start_radius: i32, rng: &mut Rng64) {
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
pub(crate) fn tg2_make_sky_island(g: &mut Tg2Grid, cx: i32, cz: i32, r: i32, rng: &mut Rng64) {
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
pub(crate) fn tg2_make_mix(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, seed2: f64, rng: &mut Rng64, pyramid_freq: u32, volcano_freq: u32, report: &mut dyn FnMut(&str, f32)) {
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
pub(crate) fn tg2_flush(g: &Tg2Grid, gen: &mut WorldGen, report: &mut dyn FnMut(&str, f32)) {
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
pub(crate) fn tg2_carve_caves(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, tall_caves: bool) {
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
pub(crate) fn tg2_dispatch_biome(
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
pub(crate) fn tg2_make_custom_mix(
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
pub(crate) fn tg2_blend_seams(g: &mut Tg2Grid, noise: &ClassicNoise, seed: f64, iters: i32) {
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

pub(crate) fn tg2_place_clouds(g: &mut Tg2Grid, rng: &mut Rng64) {
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

pub(crate) fn generate_tg2_world(
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
pub(crate) fn create_tg2_world(
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
    pub(crate) const CENTER_CHUNK:i32=4096;
    let res=write_world_file(&path,&name,wc as u32,hc as u32,chunk_size,CENTER_CHUNK,CENTER_CHUNK,surf,&chunks);
    report("Done",1.0);
    res
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn preview_tg2_world(
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
