import { resolveColor } from "./blockDefs";

export interface AtlasData {
  rgba: Uint8Array;
  tile: number;
  rows: number;
  nameToRow: Record<string, number>;
}

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export interface TexturePackRaw {
  rows: number;
  tile: number;
  atlas: string;          // base64 RGBA
  name_to_row: Record<string, number>;
}

export function decodeAtlas(raw: TexturePackRaw): AtlasData {
  return {
    rgba: decodeB64(raw.atlas),
    tile: raw.tile,
    rows: raw.rows,
    nameToRow: raw.name_to_row,
  };
}

// Per-block top-face texture name, mirroring BLOCK_FACE_TEX[bt][2] in texturepack.rs.
// Only blocks with a non-empty top-face tex name are listed; all others fall back to flat color.
export const BLOCK_TOP_TEX: Record<number, string> = {
  1: "bedrock",
  2: "stone",
  3: "dirt",
  4: "sand",
  5: "leaves",
  6: "tree_vert",
  7: "wood",
  8: "grass_top",
  9: "tnt_top",
  10: "dark_stone",
  11: "grass_top2",
  12: "grass_top",
  13: "brick",
  14: "cobblestone",
  15: "ice",
  16: "crystal",
  17: "trampoline",
  18: "wood",
  19: "cloud",
  20: "water",
  21: "weave",
  22: "vine",
  23: "lava",
  // ramps 24-55: all use their base material top
  24: "stone", 25: "stone", 26: "stone", 27: "stone",
  28: "wood",  29: "wood",  30: "wood",  31: "wood",
  32: "shingle", 33: "shingle", 34: "shingle", 35: "shingle",
  36: "ice",   37: "ice",   38: "ice",   39: "ice",
  40: "stone", 41: "stone", 42: "stone", 43: "stone",
  44: "wood",  45: "wood",  46: "wood",  47: "wood",
  48: "shingle", 49: "shingle", 50: "shingle", 51: "shingle",
  52: "ice",   53: "ice",   54: "ice",   55: "ice",
  56: "shingle",
  57: "gradient",
  58: "glass",
  59: "water", 60: "water", 61: "water",
  62: "lava",  63: "lava",  64: "lava",
  65: "tnt_top",
  66: "wood", 67: "wood", 68: "wood", 69: "wood", 70: "wood",
  71: "cloud",
  72: "lightbox",
  73: "cloud",
  74: "steel",
  75: "stone", 76: "stone", 77: "stone", 78: "stone", 79: "stone",
  81: "tnt_top",
  82: "grass_top",
  83: "dark_stone",
  84: "stone",
  85: "dirt",
  86: "sand",
  87: "tnt_side",
  88: "wood",
  89: "shingle",
  90: "cloud",
  91: "gradient",
  92: "tree_side",
  93: "leaves",
  94: "brick",
  95: "cobblestone",
  96: "vine",
  97: "ladder",
  98: "ice",
  99: "crystal",
  100: "trampoline",
  101: "cloud",
  102: "stone",
  103: "wood",
  104: "ice",
  105: "shingle",
  106: "cloud",
  107: "dirt",
  108: "dirt",
  109: "firework",
  110: "lightbox",
  111: "steel",
};

// Cache: "(blockType,paint)" → data URL (or null when no tile available)
const swatchCache = new Map<string, string | null>();

export function clearSwatchCache() {
  swatchCache.clear();
}

export function tintedSwatch(
  blockType: number,
  paint: number,
  atlas: AtlasData,
): string | null {
  const key = `${blockType},${paint}`;
  if (swatchCache.has(key)) return swatchCache.get(key)!;

  const texName = BLOCK_TOP_TEX[blockType] ?? null;
  if (!texName) { swatchCache.set(key, null); return null; }

  const row = atlas.nameToRow[texName];
  if (row === undefined) { swatchCache.set(key, null); return null; }

  const { tile, rgba } = atlas;
  const imgData = new ImageData(tile, tile);
  const yStart = row * tile;
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      const src = ((yStart + y) * tile + x) * 4;
      const dst = (y * tile + x) * 4;
      // Atlas tiles are already grayscale; copy lum + alpha
      imgData.data[dst]     = rgba[src];
      imgData.data[dst + 1] = rgba[src + 1];
      imgData.data[dst + 2] = rgba[src + 2];
      imgData.data[dst + 3] = rgba[src + 3];
    }
  }

  // Multiply grayscale tile by block color (same as GPU does in 3D views)
  const [tr, tg, tb] = resolveColor(blockType, paint);
  for (let i = 0; i < imgData.data.length; i += 4) {
    imgData.data[i]     = Math.round(imgData.data[i]     * tr / 255);
    imgData.data[i + 1] = Math.round(imgData.data[i + 1] * tg / 255);
    imgData.data[i + 2] = Math.round(imgData.data[i + 2] * tb / 255);
  }

  const canvas = document.createElement("canvas");
  canvas.width = tile;
  canvas.height = tile;
  canvas.getContext("2d")!.putImageData(imgData, 0, 0);

  const url = canvas.toDataURL();
  swatchCache.set(key, url);
  return url;
}
