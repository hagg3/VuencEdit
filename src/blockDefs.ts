export interface BlockDef {
  type: number;
  name: string;
  color: readonly [number, number, number];
}

// 35 placeable block types. Colors are picker display colors.
// Ramp/wedge blocks use the South/SE-facing variant as a representative type.
export const BLOCK_DEFS: readonly BlockDef[] = [
  // Row 1
  { type:  8, name: "Grass",         color: [ 82, 148,  53] }, // #529435
  { type: 73, name: "New Flower",    color: [ 28, 157, 193] }, // #1c9dc1
  { type: 10, name: "Dark Stone",    color: [ 67,  66,  66] }, // #434242
  { type:  2, name: "Stone",         color: [158, 156, 158] }, // #9e9c9e
  { type:  3, name: "Dirt",          color: [ 91,  61,   2] }, // #5b3d02
  { type:  4, name: "Sand",          color: [245, 221, 141] }, // #f5dd8d
  { type:  9, name: "TNT",           color: [148,  15,   2] }, // #940f02
  // Row 2
  { type:  7, name: "Wood",          color: [167, 146,  79] }, // #a7924f
  { type: 56, name: "Shingles",      color: [ 95,  94,  95] }, // #5f5e5f
  { type: 58, name: "Glass",         color: [182, 183, 185] }, // #b6b7b9
  { type: 57, name: "Neon Square",   color: [228, 225, 228] }, // #e4e1e4
  { type:  6, name: "Trunk",         color: [112,  81,  19] }, // #705113
  { type:  5, name: "Leaves",        color: [ 20, 129,  28] }, // #14811c
  { type: 13, name: "Brick",         color: [195,  98,  94] }, // #c3625e
  // Row 3
  { type: 14, name: "Slate",         color: [ 49,  52,  54] }, // #313436
  { type: 22, name: "Vine",          color: [ 52, 205, 109] }, // #34cd6d
  { type: 18, name: "Ladder",        color: [103,  89,  48] }, // #675930
  { type: 15, name: "Ice",           color: [120, 145, 167] }, // #7891a7
  { type: 16, name: "Wallpaper",     color: [158, 159, 158] }, // #9e9f9e
  { type: 17, name: "Trampoline",    color: [ 52,  51,  52] }, // #343334
  // Row 4
  { type: 19, name: "Cloud",         color: [255, 255, 255] }, // #ffffff
  { type: 24, name: "Stone Ramp",    color: [158, 156, 158] }, // #9e9c9e
  { type: 28, name: "Wood Ramp",     color: [167, 146,  79] }, // #a7924f
  { type: 36, name: "Ice Ramp",      color: [120, 145, 167] }, // #7891a7
  { type: 32, name: "Shingle Ramp",  color: [ 95,  94,  95] }, // #5f5e5f
  { type: 21, name: "Fence",         color: [216, 180, 101] }, // #d8b465
  { type: 20, name: "Water",         color: [ 22,  31, 184] }, // #161fb8
  // Row 5
  { type: 23, name: "Lava",          color: [244,  68,   0] }, // #f44400
  { type: 82, name: "Expansion",     color: [148,  15,   2] }, // #940f02
  { type: 65, name: "Fireworks",     color: [148,  15,   2] }, // #940f02
  { type: 66, name: "Door",          color: [102,  64,  18] }, // #664012
  { type: 71, name: "Treasure",      color: [235, 201,  52] }, // #ebc934
  { type: 72, name: "Lamp",          color: [254, 251, 149] }, // #fefb95
  { type: 74, name: "Steel",         color: [129, 128, 128] }, // #818080
  { type: 75, name: "Portal",        color: [ 39,  39,  39] }, // #272727
] as const;

// 54 paint colors from the PAINTED table in lib.rs.
// Index i in this array → paint byte value (i + 1).
// 0-based index 0 = paint byte 1 = first entry in PAINTED.
export const PAINT_COLORS: readonly (readonly [number, number, number])[] = [
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
] as const;

// ── Ramp orientation system ──────────────────────────────────────────────────
//
// Ramp orientation is encoded as separate block IDs — no metadata byte.
// Ramp families (24–39): 4 IDs each [base+0=S, base+1=W, base+2=N, base+3=E].
// Wedge families (40–55): 4 IDs each [base+0=SE, base+1=SW, base+2=NW, base+3=NE].
//   The apex (peak corner) names the direction.  Geometry source: Geometry.mm.
// BLOCK_DEFS stores only the representative variant (South for ramps, SE for wedges).

export const RAMP_FAMILIES = [
  { base: 24, name: "Stone Ramp" },
  { base: 28, name: "Wood Ramp" },
  { base: 32, name: "Shingle Ramp" },
  { base: 36, name: "Ice Ramp" },
] as const;

export const RAMP_DIRS = ["S", "W", "N", "E"] as const;

export const WEDGE_FAMILIES = [
  { base: 40, name: "Stone Wedge",   color: [158, 156, 158] as [number, number, number] }, // #9e9c9e
  { base: 44, name: "Wood Wedge",    color: [167, 146,  79] as [number, number, number] }, // #a7924f
  { base: 48, name: "Shingle Wedge", color: [ 95,  94,  95] as [number, number, number] }, // #5f5e5f
  { base: 52, name: "Ice Wedge",     color: [120, 145, 167] as [number, number, number] }, // #7891a7
] as const;

export const WEDGE_DIRS = ["SE", "SW", "NW", "NE"] as const;

// Door (66–69) and Portal (75–78) use the same S/W/N/E = 0/1/2/3 encoding as ramps.
// Type 70 = DoorTop, type 79 = PortalTop — not directional, not in the main picker.
export const DOOR_PORTAL_DIRS = ["S", "W", "N", "E"] as const;

/** If blockType is a directional door variant (66–69), returns 66; else null. */
export function doorFamilyBase(blockType: number): number | null {
  return blockType >= 66 && blockType <= 69 ? 66 : null;
}

/** If blockType is a directional portal variant (75–78), returns 75; else null. */
export function portalFamilyBase(blockType: number): number | null {
  return blockType >= 75 && blockType <= 78 ? 75 : null;
}

// Expansion blocks (82–111): each mirrors a base block type but accepts any paint.
// All share BLOCK_RGB color [229,207,170]; rendered color = PAINT_RGB[paint].
export const EXPANSION_BLOCKS: readonly { type: number; name: string }[] = [
  { type:  82, name: "Grass" },        { type:  83, name: "Dark Stone" },
  { type:  84, name: "Stone" },        { type:  85, name: "Dirt" },
  { type:  86, name: "Sand" },         { type:  87, name: "TNT" },
  { type:  88, name: "Wood" },         { type:  89, name: "Shingle" },
  { type:  90, name: "Glass" },        { type:  91, name: "Neon Square" },
  { type:  92, name: "Trunk" },        { type:  93, name: "Leaves" },
  { type:  94, name: "Brick" },        { type:  95, name: "Slate" },
  { type:  96, name: "Vines" },        { type:  97, name: "Ladder" },
  { type:  98, name: "Ice" },          { type:  99, name: "Wallpaper" },
  { type: 100, name: "Trampoline" },   { type: 101, name: "Cloud" },
  { type: 102, name: "Stone Ramp" },   { type: 103, name: "Wood Ramp" },
  { type: 104, name: "Ice Ramp" },     { type: 105, name: "Shingle Ramp" },
  { type: 106, name: "Fence" },        { type: 107, name: "Water" },
  { type: 108, name: "Lava" },         { type: 109, name: "Firework" },
  { type: 110, name: "Light" },        { type: 111, name: "Steel" },
] as const;

/** Returns true if blockType is any expansion block (82–111). */
export function isExpansionBlock(blockType: number): boolean {
  return blockType >= 82 && blockType <= 111;
}

// Partial water/lava fill states.
export const PARTIAL_WATER = [
  { type: 59, name: "Water ¾", fill: 0.75 },
  { type: 60, name: "Water ½", fill: 0.50 },
  { type: 61, name: "Water ¼", fill: 0.25 },
] as const;

export const PARTIAL_LAVA = [
  { type: 62, name: "Lava ¾",  fill: 0.75 },
  { type: 63, name: "Lava ½",  fill: 0.50 },
  { type: 64, name: "Lava ¼",  fill: 0.25 },
] as const;

// Weeds (type 11) and Bedrock (type 1 — TYPE_BEDROCK in code, same block as "Cobblestone" in picker but
// used as the unbreakable world foundation). Both shown in a dedicated special row.
export const SPECIAL_BLOCKS: readonly { type: number; name: string; color: [number, number, number] }[] = [
  { type:  1, name: "Bedrock", color: [90, 90, 90] },
  { type: 11, name: "Weeds",   color: [ 71, 128,  46] }, // #47802e
] as const;

/** If blockType is any ramp variant (24–39), returns the family base ID; else null. */
export function rampFamilyBase(blockType: number): number | null {
  if (blockType >= 24 && blockType <= 39) return blockType & ~3;
  return null;
}

/** If blockType is any wedge variant (40–55), returns the family base ID; else null. */
export function wedgeFamilyBase(blockType: number): number | null {
  if (blockType >= 40 && blockType <= 55) return blockType & ~3;
  return null;
}

/** Directional offset within a ramp or wedge family (0–3). */
export function rampDirIndex(blockType: number): number {
  return blockType & 3;
}

/** Display name for any block type, including non-representative ramp/wedge variants. */
export function blockDisplayName(blockType: number): string {
  if (blockType === 0) return "Air";
  const rbase = rampFamilyBase(blockType);
  if (rbase !== null) {
    const family = RAMP_FAMILIES.find((f) => f.base === rbase);
    return `${family?.name ?? "Ramp"} (${RAMP_DIRS[rampDirIndex(blockType)]})`;
  }
  const wbase = wedgeFamilyBase(blockType);
  if (wbase !== null) {
    const family = WEDGE_FAMILIES.find((f) => f.base === wbase);
    return `${family?.name ?? "Wedge"} (${WEDGE_DIRS[rampDirIndex(blockType)]})`;
  }
  if (blockType === 70) return "Door (Top)";
  if (doorFamilyBase(blockType) !== null) return `Door (${DOOR_PORTAL_DIRS[blockType - 66]})`;
  if (blockType === 79) return "Portal (Top)";
  if (portalFamilyBase(blockType) !== null) return `Portal (${DOOR_PORTAL_DIRS[blockType - 75]})`;
  const special = SPECIAL_BLOCKS.find(b => b.type === blockType);
  if (special) return special.name;
  if (blockType >= 59 && blockType <= 61) return ["Water ¾", "Water ½", "Water ¼"][blockType - 59];
  if (blockType >= 62 && blockType <= 64) return ["Lava ¾", "Lava ½", "Lava ¼"][blockType - 62];
  if (isExpansionBlock(blockType)) {
    return `Expansion (${EXPANSION_BLOCKS.find(e => e.type === blockType)?.name ?? blockType})`;
  }
  return BLOCK_DEFS.find((b) => b.type === blockType)?.name ?? `Type ${blockType}`;
}

/** Returns the display RGB for a given block type + paint byte, matching lib.rs logic. */
export function resolveColor(blockType: number, paintByte: number): readonly [number, number, number] {
  if (blockType === 0) return [20, 20, 35]; // void/air
  if (paintByte > 0 && paintByte <= PAINT_COLORS.length) {
    return PAINT_COLORS[paintByte - 1];
  }
  const def = BLOCK_DEFS.find((b) => b.type === blockType);
  if (def) return def.color;
  // Ramp variant: all orientations share the family base's color.
  const rbase = rampFamilyBase(blockType);
  if (rbase !== null) {
    const baseDef = BLOCK_DEFS.find((b) => b.type === rbase);
    if (baseDef) return baseDef.color;
  }
  // Wedge variant: use family color.
  const wbase = wedgeFamilyBase(blockType);
  if (wbase !== null) {
    const family = WEDGE_FAMILIES.find((f) => f.base === wbase);
    if (family) return family.color;
  }
  // Door variants (67–70) share the base Door swatch color.
  if (doorFamilyBase(blockType) !== null || blockType === 70) {
    return BLOCK_DEFS.find((b) => b.type === 66)?.color ?? [180, 152, 59];
  }
  // Portal variants (76–79) share the base Portal swatch color.
  if (portalFamilyBase(blockType) !== null || blockType === 79) {
    return BLOCK_DEFS.find((b) => b.type === 75)?.color ?? [90, 90, 90];
  }
  // Special blocks (Bedrock, Weeds, etc.)
  const specialBlock = SPECIAL_BLOCKS.find(b => b.type === blockType);
  if (specialBlock) return specialBlock.color;
  // Partial water/lava
  if (blockType >= 59 && blockType <= 61) return [70, 135, 210];
  if (blockType >= 62 && blockType <= 64) return [255, 69, 0];
  // Expansion blocks
  if (isExpansionBlock(blockType)) return [229, 207, 170];
  return [128, 128, 128];
}
