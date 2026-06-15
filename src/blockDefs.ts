export interface BlockDef {
  type: number;
  name: string;
  color: readonly [number, number, number];
}

// 35 placeable block types in the same 5-row × 7-column order as the in-game block picker.
// Colors are picker display colors. Renderer uses UNPAINTED[block_type - 1] (Mapping.cs pen = blockByte - 1).
// Some entries override the raw render color where the map color is misleading as a picker icon.
// Ramp blocks use the South-facing variant as a representative type.
export const BLOCK_DEFS: readonly BlockDef[] = [
  // Row 1
  { type:  8, name: "Grass",         color: [ 82, 148,  53] }, // render=grass_color(); sentinel [255,0,0] → green
  { type: 12, name: "Flower",        color: [ 82, 148,  53] }, // render=UNPAINTED[11]=[82,148,53] green
  { type: 10, name: "Dark Stone",    color: [ 59,  59,  59] }, // render=UNPAINTED[9]=[59,59,59] dark gray
  { type:  2, name: "Stone",         color: [162, 162, 162] }, // render=UNPAINTED[1]=[162,162,162] gray
  { type:  3, name: "Dirt",          color: [162,  82,  45] }, // render=UNPAINTED[2]=Sienna brown
  { type:  4, name: "Sand",          color: [242, 220, 140] }, // render=UNPAINTED[3]=[242,220,140] sandy
  { type:  9, name: "TNT",           color: [255,   0,   0] }, // render=UNPAINTED[8]=Red
  // Row 2
  { type:  7, name: "Wood",          color: [186, 164,  88] }, // render=UNPAINTED[6]=[186,164,88] tan
  { type: 56, name: "Shingles",      color: [105, 105, 105] }, // render=UNPAINTED[55]=DimGray
  { type: 58, name: "Glass",         color: [211, 211, 211] }, // render=UNPAINTED[57]=LightGray
  { type: 57, name: "Neon Square",   color: [255, 255, 255] }, // render=UNPAINTED[56]=White
  { type:  6, name: "Trunk",         color: [186, 164,  88] }, // render=UNPAINTED[5]=[186,164,88]
  { type:  5, name: "Leaves",        color: [ 10,  63,  13] }, // render=UNPAINTED[4]=[10,63,13] dark green
  { type: 13, name: "Brick",         color: [204,  48,  41] }, // render=UNPAINTED[12]=[204,48,41] red-brick
  // Row 3
  { type:  1, name: "Cobblestone",   color: [162, 162, 162] }, // render=UNPAINTED[0]=(3,3,3) near-black → gray for picker
  { type: 22, name: "Vine",          color: [  0, 128,   0] }, // render=UNPAINTED[21]=Green
  { type: 18, name: "Ladder",        color: [210, 180, 140] }, // render=UNPAINTED[17]=Tan
  { type: 15, name: "Ice",           color: [200, 230, 255] }, // render=UNPAINTED[14]=[134,164,186] → icy blue-white
  { type: 16, name: "Wallpaper",     color: [255, 255, 255] }, // render=UNPAINTED[15]=White
  { type: 14, name: "Diamond",       color: [ 86,  92,  95] }, // render=UNPAINTED[13]=[86,92,95] gray (Slate)
  { type: 17, name: "Trampoline",    color: [210, 180, 140] }, // render=UNPAINTED[16]=[50,50,50] dark → Tan for picker
  // Row 4
  { type: 19, name: "Cloud",         color: [210, 225, 255] }, // render=UNPAINTED[18]=White → light cloud for picker
  { type: 24, name: "Stone Ramp",    color: [162, 162, 162] }, // render=UNPAINTED[23]=[162,162,162]
  { type: 28, name: "Wood Ramp",     color: [186, 164,  88] }, // render=UNPAINTED[27]=[186,164,88]
  { type: 36, name: "Ice Ramp",      color: [134, 164, 186] }, // render=UNPAINTED[35]=[134,164,186]
  { type: 32, name: "Shingle Ramp",  color: [105, 105, 105] }, // render=UNPAINTED[31]=DimGray
  { type: 21, name: "Fence",         color: [210, 180, 140] }, // render=UNPAINTED[20]=Tan
  { type: 20, name: "Water",         color: [ 70, 135, 210] }, // render=UNPAINTED[19]=Blue → mid-blue for picker
  // Row 5
  { type: 23, name: "Lava",          color: [255,  69,   0] }, // render=UNPAINTED[22]=OrangeRed
  { type: 82, name: "Expansion",     color: [100, 180, 100] }, // render=grass_color(); [0,128,0] → lighter green
  { type: 65, name: "Fireworks",     color: [255,   0,   0] }, // render=UNPAINTED[64]=Red
  { type: 66, name: "Door",          color: [210, 180, 140] }, // render=UNPAINTED[65]=Tan
  { type: 71, name: "Treasure",      color: [255, 250, 205] }, // render=UNPAINTED[70]=LemonChiffon
  { type: 72, name: "Lamp",          color: [255, 220, 100] }, // render=UNPAINTED[71]=Blue → warm yellow for picker
  { type: 74, name: "Steel",         color: [211, 211, 211] }, // render=UNPAINTED[73]=LightGray
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
// Each family occupies 4 consecutive IDs: [base+0=S, base+1=W, base+2=N, base+3=E].
// BLOCK_DEFS stores only the South variant (base) as the picker representative.

export const RAMP_FAMILIES = [
  { base: 24, name: "Stone Ramp" },
  { base: 28, name: "Wood Ramp" },
  { base: 32, name: "Shingle Ramp" },
  { base: 36, name: "Ice Ramp" },
] as const;

export const RAMP_DIRS = ["S", "W", "N", "E"] as const;

/** If blockType is any ramp variant (24–39), returns the family base ID (multiple of 4); else null. */
export function rampFamilyBase(blockType: number): number | null {
  if (blockType >= 24 && blockType <= 39) return blockType & ~3;
  return null;
}

/** Directional offset within a ramp family: 0=S, 1=W, 2=N, 3=E. */
export function rampDirIndex(blockType: number): number {
  return blockType & 3;
}

/** Display name for any block type, including non-South ramp variants. */
export function blockDisplayName(blockType: number): string {
  if (blockType === 0) return "Air";
  const base = rampFamilyBase(blockType);
  if (base !== null) {
    const family = RAMP_FAMILIES.find((f) => f.base === base);
    return `${family?.name ?? "Ramp"} (${RAMP_DIRS[rampDirIndex(blockType)]})`;
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
  const base = rampFamilyBase(blockType);
  if (base !== null) {
    const baseDef = BLOCK_DEFS.find((b) => b.type === base);
    if (baseDef) return baseDef.color;
  }
  return [128, 128, 128];
}
