//! Block/paint colour tables and helpers, ported from Globals.mm / Hud.mm.
use serde::Serialize;

// ── Color system (tables ported from Globals.mm / Hud.mm game source) ─────────

// Unpainted block base colours — blockColor[NUM_BLOCKS+1][3] from Globals.mm.
// Index = block type ID (0–111 known; 112–127 new-format, see below). Zero entries
// are unused/unset in the game.
pub(crate) const BLOCK_RGB: [[u8; 3]; 128] = [
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
    // 112–127: new-format blocks (updated game, `TEST WORLDS/newblocks/`). Real names/colours are
    // unknown (`~/emod` reference source stops at 111) — per project decision these are NOT invented
    // placeholder hues. Each reuses the exact RGB of an existing, visually distinct known block (and
    // the matching BLOCK_PAINT_SCALE entry below), so paint behaves identically to that donor block.
    [158, 156, 158], // 112 unknown (new format) — reuses  2 stone
    [ 91,  61,   2], // 113 unknown (new format) — reuses  3 dirt
    [245, 221, 141], // 114 unknown (new format) — reuses  4 sand
    [ 20, 129,  28], // 115 unknown (new format) — reuses  5 leaves
    [112,  81,  19], // 116 unknown (new format) — reuses  6 trunk
    [167, 146,  79], // 117 unknown (new format) — reuses  7 wood
    [195,  98,  94], // 118 unknown (new format) — reuses 13 brick
    [ 49,  52,  54], // 119 unknown (new format) — reuses 14 slate
    [120, 145, 167], // 120 unknown (new format) — reuses 15 ice
    [255, 255, 255], // 121 unknown (new format) — reuses 19 cloud
    [ 22,  31, 184], // 122 unknown (new format) — reuses 20 water
    [216, 180, 101], // 123 unknown (new format) — reuses 21 fence
    [244,  68,   0], // 124 unknown (new format) — reuses 23 lava
    [129, 128, 128], // 125 unknown (new format) — reuses 74 steel
    [235, 201,  52], // 126 unknown (new format) — reuses 71 golden cube
    [254, 251, 149], // 127 unknown (new format) — reuses 72 lightbox
];

// Paint colour table — colorTable[54] from Hud::genColorTable() (Hud.mm:150-196).
// Index 0 is the "no-paint" white sentinel; indices 1–54 are the game's paint palette.
pub(crate) const PAINT_RGB: [[u8; 3]; 55] = [
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

pub(crate) const BI_NOTSOLID:   u32 = 0b0000_0000_0000_0010;
pub(crate) const BI_RAMPORSIDE: u32 = 0b0000_0000_0001_0000;

// blockinfo[NUM_BLOCKS+1] — one entry per block type (0–111 known; 112–127 new-format).
// Only the flags relevant to the editor are preserved verbatim; the rest stay zero.
pub(crate) const BLOCK_INFO: [u32; 128] = [
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
    // 112–127: solid/occluding (0) — right for a plain decorative cube, wrong for whichever ID turns
    // out to be a sign or another non-solid; flips with one entry once identified (see signs.rs).
    0,                           // 112 unknown (new format)
    0,                           // 113 unknown (new format)
    0,                           // 114 unknown (new format)
    0,                           // 115 unknown (new format)
    0,                           // 116 unknown (new format)
    0,                           // 117 unknown (new format)
    0,                           // 118 unknown (new format)
    0,                           // 119 unknown (new format)
    0,                           // 120 unknown (new format)
    0,                           // 121 unknown (new format)
    0,                           // 122 unknown (new format)
    0,                           // 123 unknown (new format)
    0,                           // 124 unknown (new format)
    0,                           // 125 unknown (new format)
    0,                           // 126 unknown (new format)
    0,                           // 127 unknown (new format)
];

/// Alpha (0–1) for a transparent block; None = opaque.
/// Glass/water are 50% transparent; fence nearly opaque at 90%; flower mostly see-through at 25%.
pub(crate) fn transparent_alpha(bt: u8) -> Option<f32> {
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
pub(crate) const BLOCK_PAINT_SCALE: [f32; 128] = [
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
    // 112–127: matches the donor block's scale (see BLOCK_RGB above) so paint reads identically to it.
    0.80, // 112 unknown (new format) — matches  2 stone
    0.60, // 113 unknown (new format) — matches  3 dirt
    0.80, // 114 unknown (new format) — matches  4 sand
    0.65, // 115 unknown (new format) — matches  5 leaves
    0.70, // 116 unknown (new format) — matches  6 trunk
    0.70, // 117 unknown (new format) — matches  7 wood
    0.70, // 118 unknown (new format) — matches 13 brick
    0.40, // 119 unknown (new format) — matches 14 slate
    0.90, // 120 unknown (new format) — matches 15 ice
    1.00, // 121 unknown (new format) — matches 19 cloud
    0.90, // 122 unknown (new format) — matches 20 water
    0.80, // 123 unknown (new format) — matches 21 fence
    0.60, // 124 unknown (new format) — matches 23 lava
    0.70, // 125 unknown (new format) — matches 74 steel
    0.70, // 126 unknown (new format) — matches 71 golden cube
    0.90, // 127 unknown (new format) — matches 72 lightbox
];

pub(crate) fn grass_color(sky: u8) -> [u8; 3] {
    match sky {
        11 => [242, 220, 140], // desert sky
        13 => [255, 255, 255], // snow sky
        _  => [ 82, 148,  53], // #529435
    }
}

pub(crate) fn block_color(bt: u8, paint: u8, sky: u8) -> [u8; 3] {
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

/// Canonical block/paint colour tables, shipped to the frontend at startup so
/// the TS side (`blockTables.ts`) never hand-mirrors these values. Ends the
/// Rust↔TS dual-maintenance drift (C6): both the paint RGB rounding and the
/// per-block brightness scale previously diverged.
#[derive(Serialize)]
pub(crate) struct BlockTables {
    block_rgb: Vec<[u8; 3]>,
    paint_rgb: Vec<[u8; 3]>,
    block_paint_scale: Vec<f32>,
}

#[tauri::command]
pub(crate) fn get_block_tables() -> BlockTables {
    BlockTables {
        block_rgb: BLOCK_RGB.to_vec(),
        paint_rgb: PAINT_RGB.to_vec(),
        block_paint_scale: BLOCK_PAINT_SCALE.to_vec(),
    }
}
