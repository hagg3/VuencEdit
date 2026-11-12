// The 3D pane's sign + command-block overlay (roadmap 27.6b). Pure of React and of FlyView3D: the
// pane owns one `RecordOverlay`, feeds it `get_record_overlay` results and the camera's z-band, and
// the rest (text layout, the texture LRU, mesh building, disposal) lives here so it can be tested.
//
// Geometry arrives from `voxel_core::signs` (packages/voxel-core/src/signs.rs) in FILE axes — x, y
// horizontal, z up. The 3D scene maps file (x, y, z) -> Three (x, z, y) (FlyView3D: "Three.js Z =
// Eden Y"), no negation; `toThree` is the only place that swap happens. Constants are copied from
// Emod's `Classes/SignRenderer.cpp` via signs.rs (`FONT_PX`, `TEX_W`, `SKIN_FACES`, `BUTTON_*`...);
// keep the two in step.
import * as THREE from "three";

// ---- wire types (camelCase JSON of `OverlayInfo`, lib.rs `get_record_overlay`) ------------------
export type V3 = [number, number, number];
export type SignKind = "standing" | "wall" | "cmd";
export interface OverlayBox { part: "board" | "post"; min: V3; max: V3 }
export interface OverlayQuad {
  centre: V3; right: V3; up: V3; normal: V3; halfW: number; halfH: number;
}
export interface OverlaySign {
  i: number; kind: SignKind; pos: V3; a: number; b: number; c: number;
  colour: [number, number, number]; text: string; vis: string;
  boxes: OverlayBox[]; quad: OverlayQuad; fontPx: number;
}
export interface OverlayCmd { i: number; pos: V3; faces: number }
export interface OverlayInfo {
  signs: OverlaySign[]; cmds: OverlayCmd[];
  hiddenAir: number; hiddenFront: number; truncated: boolean;
}

/** File axes -> Three.js axes (x, z, y). */
export const toThree = (v: readonly number[]): V3 => [v[0], v[2], v[1]];

// ---- text layout (SignRenderer.cpp `buildText`) -------------------------------------------------
export const TEX_W = 256;
/** signs.rs `FONT_PX`, per kind, at `TEX_W` texels across the board. */
const FONT_PX: Record<SignKind, number> = { standing: 22, wall: 30, cmd: 28 };
/** Board height / width per kind (signs.rs `STAND_*`, `WALL_HALF_*`, `PANEL_HALF`). */
const BOARD_ASPECT: Record<SignKind, number> = { standing: 0.5 / 1.0, wall: 0.5 / 0.875, cmd: 1 };
const TEXT_MARGIN = TEX_W * 0.04;
const LINE_HEIGHT = 1.2;
const SHRINK = 0.9;
const MIN_FONT_PX = 9;

export interface TextLayout {
  lines: string[];
  /** Font px after the shrink loop. */
  px: number;
  lineH: number;
  /** Top inset of the first line, texels. */
  top: number;
  /** Texels used, from the top (the canvas height). */
  texH: number;
  /** Outline radius, texels (2 for px >= 18, else 1). */
  outlineR: number;
}

export type Measure = (s: string, px: number) => number;

/** Greedy word wrap on spaces; a word wider than the line is broken by characters. */
export function wrapText(text: string, px: number, maxW: number, measure: Measure): string[] {
  const out: string[] = [];
  const words = text.split(" ").filter((w) => w.length > 0);
  let line = "";
  for (const w of words) {
    let word = w;
    const cand = line ? `${line} ${word}` : word;
    if (measure(cand, px) <= maxW) { line = cand; continue; }
    if (line) { out.push(line); line = ""; }
    while (measure(word, px) > maxW && word.length > 1) {
      let n = word.length - 1;
      while (n > 1 && measure(word.slice(0, n), px) > maxW) n--;
      out.push(word.slice(0, n));
      word = word.slice(n);
    }
    line = word;
  }
  if (line) out.push(line);
  return out;
}

/** Lay `text` out for a board of `kind`; `null` when it has no printable words. */
export function layoutText(text: string, kind: SignKind, measure: Measure): TextLayout | null {
  const boardTexH = TEX_W * BOARD_ASPECT[kind];
  let px = FONT_PX[kind];
  let lines: string[];
  for (;;) {
    lines = wrapText(text, px, TEX_W - 2 * TEXT_MARGIN, measure);
    const need = TEXT_MARGIN + lines.length * px * LINE_HEIGHT + TEXT_MARGIN;
    if (need <= boardTexH || px <= MIN_FONT_PX) break;
    px *= SHRINK;
  }
  if (lines.length === 0) return null;
  const lineH = Math.ceil(px * LINE_HEIGHT);
  const top = Math.floor(TEXT_MARGIN) >> 1; // Emod: (int)margin / 2
  let texH = top + lines.length * lineH + 4;
  if (texH > Math.floor(boardTexH)) texH = Math.floor(boardTexH);
  return { lines, px, lineH, top, texH: Math.max(1, texH), outlineR: px >= 18 ? 2 : 1 };
}

/** Texture bytes incl. a full mip chain (Emod: w*h*4*4/3). */
export const textureBytes = (w: number, h: number): number => Math.round((w * h * 4 * 4) / 3);

// ---- the texture LRU ----------------------------------------------------------------------------
/** signs.rs `MAX_TEXTURES` / `MAX_TEX_BYTES` / `BUILDS_PER_FRAME`. */
export const MAX_TEXTURES = 256;
export const MAX_TEX_BYTES = 24 << 20;
export const BUILDS_PER_FRAME = 4;
/** A 256x64 texture: what Emod reserves before it has built the real one. */
const MIN_BUILD_BYTES = textureBytes(TEX_W, 64);

export interface Disposable { dispose(): void }
export interface Built<T> { value: T; bytes: number }
export interface TextureCacheOpts { maxEntries?: number; maxBytes?: number; buildsPerFrame?: number }

interface CacheEntry<T> { value: T; bytes: number; lastGen: number; lastUse: number }

/**
 * An LRU of text textures keyed `(kind, text)` with byte accounting.
 *
 * Eviction protects every entry used in the current *generation* (one `OverlayInfo` apply): those are
 * exactly the textures the scene's meshes point at, so a build can never free something on screen.
 * If everything cached is in use the build is skipped (that sign draws its board without text) —
 * Emod's `makeRoom`. Misses are queued nearest-first and built `buildsPerFrame` at a time by `pump()`.
 */
export class TextureCache<T extends Disposable> {
  private entries = new Map<string, CacheEntry<T>>();
  private queue: { key: string; kind: SignKind; text: string }[] = [];
  private queued = new Set<string>();
  private failed = new Set<string>();
  private gen = 0;
  private tick = 0;
  private totalBytes = 0;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly buildsPerFrame: number;

  constructor(private build: (kind: SignKind, text: string) => Built<T> | null, opts: TextureCacheOpts = {}) {
    this.maxEntries = opts.maxEntries ?? MAX_TEXTURES;
    this.maxBytes = opts.maxBytes ?? MAX_TEX_BYTES;
    this.buildsPerFrame = opts.buildsPerFrame ?? BUILDS_PER_FRAME;
  }

  static key(kind: SignKind, text: string): string { return `${kind}\0${text}`; }

  get size(): number { return this.entries.size; }
  get bytes(): number { return this.totalBytes; }
  get pending(): number { return this.queue.length; }

  /** A new set of consumers is about to ask: drop the old queue and retry failed builds. */
  beginGeneration(): void {
    this.gen++;
    this.queue = [];
    this.queued.clear();
    this.failed.clear();
  }

  /** The cached value (marked used this generation), or `undefined` after queueing a build. */
  use(kind: SignKind, text: string): T | undefined {
    const key = TextureCache.key(kind, text);
    const e = this.entries.get(key);
    if (e) { e.lastGen = this.gen; e.lastUse = ++this.tick; return e.value; }
    if (!this.queued.has(key) && !this.failed.has(key)) {
      this.queued.add(key);
      this.queue.push({ key, kind, text });
    }
    return undefined;
  }

  /** Build up to `buildsPerFrame` queued entries; returns how many textures were added. */
  pump(): number {
    let attempts = 0;
    let added = 0;
    while (this.queue.length > 0 && attempts < this.buildsPerFrame) {
      const q = this.queue.shift()!;
      this.queued.delete(q.key);
      if (this.entries.has(q.key)) continue;
      attempts++;
      if (!this.makeRoom(MIN_BUILD_BYTES)) { this.failed.add(q.key); continue; }
      const r = this.build(q.kind, q.text);
      if (!r) { this.failed.add(q.key); continue; }
      if (this.totalBytes + r.bytes > this.maxBytes && !this.makeRoom(r.bytes)) {
        r.value.dispose();
        this.failed.add(q.key);
        continue;
      }
      this.entries.set(q.key, { value: r.value, bytes: r.bytes, lastGen: this.gen, lastUse: ++this.tick });
      this.totalBytes += r.bytes;
      added++;
    }
    return added;
  }

  /** Evict least-recently-used entries not used this generation until `need` more bytes and one
   *  more entry fit. False when everything cached is in use. */
  private makeRoom(need: number): boolean {
    while (this.entries.size >= this.maxEntries || this.totalBytes + need > this.maxBytes) {
      let victim: string | null = null;
      let best = Infinity;
      for (const [k, e] of this.entries) {
        if (e.lastGen !== this.gen && e.lastUse < best) { best = e.lastUse; victim = k; }
      }
      if (victim === null) return false;
      const e = this.entries.get(victim)!;
      e.value.dispose();
      this.totalBytes -= e.bytes;
      this.entries.delete(victim);
    }
    return true;
  }

  forEach(fn: (v: T) => void): void { for (const e of this.entries.values()) fn(e.value); }

  clear(): void {
    for (const e of this.entries.values()) e.value.dispose();
    this.entries.clear();
    this.queue = [];
    this.queued.clear();
    this.failed.clear();
    this.totalBytes = 0;
  }
}

// ---- rasterising a layout to a canvas (browser only) ---------------------------------------------
const FONT_FAMILY = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const fontOf = (px: number) => `bold ${px}px ${FONT_FAMILY}`;
/** signs.rs `TEXT_OUTLINE_RGB`. */
const OUTLINE_CSS = "rgb(16,16,16)";

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** `ctx.measureText` width; falls back to Emod's headless estimate when there is no canvas. */
export const canvasMeasure: Measure = (s, px) => {
  if (measureCtx === undefined) {
    measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return s.length * px * 0.5;
  measureCtx.font = fontOf(px);
  const w = measureCtx.measureText(s).width;
  return w > 0 ? w : s.length * px * 0.5;
};

/** White glyphs, a dark outline (stroke under fill), transparent elsewhere; lines centred, top-down. */
export function rasterizeText(layout: TextLayout): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = TEX_W;
  canvas.height = layout.texH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = fontOf(layout.px);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = layout.outlineR * 2;
  ctx.strokeStyle = OUTLINE_CSS;
  ctx.fillStyle = "#fff";
  const y = (i: number) => layout.top + i * layout.lineH + layout.lineH / 2;
  layout.lines.forEach((l, i) => ctx.strokeText(l, TEX_W / 2, y(i)));
  layout.lines.forEach((l, i) => ctx.fillText(l, TEX_W / 2, y(i)));
  return canvas;
}

/** A live text texture, its material, and the height the quad needs. */
export class TextEntry implements Disposable {
  constructor(readonly tex: THREE.Texture, readonly mat: THREE.MeshBasicMaterial, readonly texH: number) {}
  dispose(): void { this.mat.dispose(); this.tex.dispose(); }
}

export function makeTextMaterial(tex: THREE.Texture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: tex, transparent: true, alphaTest: 0.02, depthWrite: false, side: THREE.DoubleSide,
    // Text stands 0.004 off its board: at 30+ blocks a 24-bit depth step is about that, so nudge it.
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
}

/** The real builder: layout -> canvas -> CanvasTexture (clamped, trilinear, sRGB). */
export function buildCanvasText(kind: SignKind, text: string): Built<TextEntry> | null {
  const layout = layoutText(text, kind, canvasMeasure);
  if (!layout) return null;
  const canvas = rasterizeText(layout);
  if (!canvas) return null;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return { value: new TextEntry(tex, makeTextMaterial(tex), layout.texH), bytes: textureBytes(TEX_W, layout.texH) };
}

// ---- geometry builders (pure; file axes in, Three axes out) --------------------------------------
export interface MeshData { positions: number[]; colors: number[] }
const newMeshData = (): MeshData => ({ positions: [], colors: [] });

/** Emod's `box()`: the front face (along +/- `axis`) in `rgb`, the other five x0.75. */
const SIDE_SHADE = 0.75;
/** Post colour = board colour x0.7 (SignRenderer.cpp). */
const POST_SHADE = 0.7;

function pushQuad(out: MeshData, corners: [V3, V3, V3, V3], rgb: V3): void {
  const [a, b, c, d] = corners.map(toThree) as [V3, V3, V3, V3];
  for (const p of [a, b, c, a, c, d]) { out.positions.push(p[0], p[1], p[2]); out.colors.push(rgb[0], rgb[1], rgb[2]); }
}

/** An axis-aligned box in file axes; `front` = [axis 0..2, sign +1/-1] gets `rgb`, the rest x0.75. */
export function appendBox(out: MeshData, min: V3, max: V3, front: [number, number], rgb: V3): void {
  const dark: V3 = [rgb[0] * SIDE_SHADE, rgb[1] * SIDE_SHADE, rgb[2] * SIDE_SHADE];
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const s of [-1, 1]) {
      const at = s > 0 ? max[axis] : min[axis];
      const p = (du: number, dv: number): V3 => {
        const r: V3 = [0, 0, 0];
        r[axis] = at; r[u] = du ? max[u] : min[u]; r[v] = dv ? max[v] : min[v];
        return r;
      };
      pushQuad(out, [p(0, 0), p(1, 0), p(1, 1), p(0, 1)], front[0] === axis && front[1] === s ? rgb : dark);
    }
  }
}

/** Which axis/sign a horizontal unit normal points along. */
export function frontOf(n: V3): [number, number] {
  const axis = Math.abs(n[0]) >= Math.abs(n[1]) ? 0 : 1;
  return [axis, n[axis] >= 0 ? 1 : -1];
}

/** Every sign's board and post, merged. */
export function buildBoardData(signs: readonly OverlaySign[]): MeshData {
  const out = newMeshData();
  for (const s of signs) {
    const board: V3 = [s.colour[0] / 255, s.colour[1] / 255, s.colour[2] / 255];
    const front = frontOf(s.quad.normal);
    for (const b of s.boxes) {
      const rgb: V3 = b.part === "post" ? [board[0] * POST_SHADE, board[1] * POST_SHADE, board[2] * POST_SHADE] : board;
      appendBox(out, b.min, b.max, front, rgb);
    }
  }
  return out;
}

// -- the command-block skin: mirrors signs.rs `SKIN_FACES` / `PANEL_HALF` / `SKIN_OUT` / `BUTTON_*` --
interface SkinFace { a: number; normal: V3; right: V3; up: V3; shade: number }
export const SKIN_FACES: readonly SkinFace[] = [
  { a: 0, normal: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1], shade: 0.8 },
  { a: 1, normal: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], shade: 0.8 },
  { a: 3, normal: [0, 0, 1], right: [1, 0, 0], up: [0, -1, 0], shade: 1.0 },
  { a: 2, normal: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], shade: 0.55 },
  { a: 4, normal: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1], shade: 0.7 },
  { a: 5, normal: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1], shade: 0.7 },
];
export const PANEL_HALF = 0.375;
export const SKIN_OUT = 0.002;
export const BUTTON_HALF = 0.14;
const WALL_OUT = 1 / 32;
export const BUTTON_OUT = WALL_OUT + 0.016;
export const BUTTON_IDLE_RGB: V3 = [0.9, 0.08, 0.06];
// The frame/panel palette is ours (the plan's "frame / panel / button"): an orange frame round a
// charcoal panel, the look Emod had before the art. Skin faces multiply their `shade`.
export const SKIN_FRAME_RGB: V3 = [0.85, 0.45, 0.1];
export const SKIN_PANEL_RGB: V3 = [0.16, 0.16, 0.18];

export interface SkinData { frame: MeshData; panel: MeshData; button: MeshData }

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/** A rectangle `centre +- right*hr +- up*hu`. */
function pushRect(out: MeshData, centre: V3, right: V3, up: V3, hr: number, hu: number, rgb: V3): void {
  const R = mul3(right, hr), U = mul3(up, hu);
  const tl = add3(add3(centre, mul3(R, -1)), U), tr = add3(add3(centre, R), U);
  const bl = add3(add3(centre, mul3(R, -1)), mul3(U, -1)), br = add3(add3(centre, R), mul3(U, -1));
  pushQuad(out, [tl, bl, br, tr], rgb);
}

/** Skin faces for every exposed face of every command block; the frame is four strips so frame and
 *  panel never overlap (no z-fight without a second offset). */
export function buildSkinData(cmds: readonly OverlayCmd[]): SkinData {
  const frame = newMeshData(), panel = newMeshData(), button = newMeshData();
  for (const c of cmds) {
    const centre: V3 = [c.pos[0] + 0.5, c.pos[1] + 0.5, c.pos[2] + 0.5];
    for (const f of SKIN_FACES) {
      if (!(c.faces & (1 << f.a))) continue;
      const fc = add3(centre, mul3(f.normal, 0.5 + SKIN_OUT));
      const fr = mul3(SKIN_FRAME_RGB, f.shade), pr = mul3(SKIN_PANEL_RGB, f.shade);
      const band = (0.5 - PANEL_HALF) / 2; // half the frame's width
      const mid = (0.5 + PANEL_HALF) / 2;
      // top/bottom strips span the full width, left/right strips fit between them
      pushRect(frame, add3(fc, mul3(f.up, mid)), f.right, f.up, 0.5, band, fr);
      pushRect(frame, add3(fc, mul3(f.up, -mid)), f.right, f.up, 0.5, band, fr);
      pushRect(frame, add3(fc, mul3(f.right, mid)), f.right, f.up, band, PANEL_HALF, fr);
      pushRect(frame, add3(fc, mul3(f.right, -mid)), f.right, f.up, band, PANEL_HALF, fr);
      pushRect(panel, fc, f.right, f.up, PANEL_HALF, PANEL_HALF, pr);
      // The button: a box from the face out to BUTTON_OUT, in front of any wall board.
      const bc = add3(centre, mul3(f.normal, 0.5 + BUTTON_OUT / 2));
      const half: V3 = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        half[i] = Math.abs(f.right[i]) * BUTTON_HALF + Math.abs(f.up[i]) * BUTTON_HALF + Math.abs(f.normal[i]) * (BUTTON_OUT / 2);
      }
      const axis = f.normal.findIndex((x) => x !== 0);
      appendBox(button, [bc[0] - half[0], bc[1] - half[1], bc[2] - half[2]], [bc[0] + half[0], bc[1] + half[1], bc[2] + half[2]],
        [axis, f.normal[axis]], mul3(BUTTON_IDLE_RGB, f.shade));
    }
  }
  return { frame, panel, button };
}

/** Where a sign's text quad goes, in Three axes: the quad hangs from the board's top edge. */
export interface TextPlacement { centre: V3; right: V3; up: V3; normal: V3; hw: number; hh: number }
export function textPlacement(s: OverlaySign, texH: number): TextPlacement {
  const q = s.quad;
  const boardW = q.halfW * 2;
  const textH = (boardW * texH) / TEX_W;
  const centre: V3 = [
    q.centre[0] + q.up[0] * (q.halfH - textH / 2),
    q.centre[1] + q.up[1] * (q.halfH - textH / 2),
    q.centre[2] + q.up[2] * (q.halfH - textH / 2),
  ];
  return { centre: toThree(centre), right: toThree(q.right), up: toThree(q.up), normal: toThree(q.normal), hw: q.halfW, hh: textH / 2 };
}

function toGeometry(d: MeshData): THREE.BufferGeometry | null {
  if (d.positions.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(d.positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(d.colors, 3));
  return g;
}

// ---- the overlay ---------------------------------------------------------------------------------
export interface RecordOverlayOpts {
  /** Text builder; default = the canvas rasteriser. Tests inject a fake. */
  buildText?: (kind: SignKind, text: string) => Built<TextEntry> | null;
  /** Runs a callback on the next "frame" (default `requestAnimationFrame`, else a 16 ms timer). */
  schedule?: (cb: () => void) => void;
  /** Something changed on screen (the pane should repaint). */
  onChange?: () => void;
  cache?: TextureCacheOpts;
}

export interface RecordOverlayStats {
  signsDrawn: number; signsHidden: number; signTextures: number; signTexBytes: number;
}

const defaultSchedule = (cb: () => void) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
};

/**
 * One `THREE.Group` holding every sign board/post (one merged mesh), the command-block skin (frame,
 * panel and button meshes, merged) and a text quad per sign that has text. `apply` replaces the lot
 * from a fresh `OverlayInfo`; `setCull` hides records whose anchor is above the terrain's z band.
 */
export class RecordOverlay {
  readonly group = new THREE.Group();
  private cache: TextureCache<TextEntry>;
  private schedule: (cb: () => void) => void;
  private onChange: () => void;
  private info: OverlayInfo | null = null;
  private band: number | null = null;
  private cap: number | null = null;
  private pumpPending = false;
  private disposed = false;

  private geoms: THREE.BufferGeometry[] = [];
  private meshes: THREE.Mesh[] = [];
  private texts = new Map<number, THREE.Mesh>(); // index into info.signs
  private readonly quadGeom: THREE.BufferGeometry;
  private readonly boardMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  // The skin lies 0.002 off the steel; Emod's polygon offset (-1, -4) keeps it from z-fighting.
  private readonly skinMat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
  private readonly buttonMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private drawn = 0;

  constructor(opts: RecordOverlayOpts = {}) {
    const build = opts.buildText ?? buildCanvasText;
    this.cache = new TextureCache<TextEntry>(build, opts.cache);
    this.schedule = opts.schedule ?? defaultSchedule;
    this.onChange = opts.onChange ?? (() => {});
    this.group.name = "record-overlay";
    // A unit quad (-1..1) with uv 0..1; each text mesh scales/places it with its own matrix.
    this.quadGeom = new THREE.BufferGeometry();
    this.quadGeom.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    this.quadGeom.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  }

  private visible(z: number): boolean {
    return (this.band === null || z < this.band) && (this.cap === null || z <= this.cap);
  }

  /** Replace the overlay with `info` (`null` empties it). */
  apply(info: OverlayInfo | null): void {
    if (this.disposed) return;
    this.info = info;
    this.cache.beginGeneration();
    this.rebuild();
  }

  /** Hide records above the camera's z band / the cutaway cap. Cheap when nothing changed. */
  setCull(band: number | null, cap: number | null): void {
    if (this.disposed || (band === this.band && cap === this.cap)) return;
    this.band = band;
    this.cap = cap;
    if (this.info) this.rebuild();
  }

  /** WebGL context restored: every live texture must re-upload from its canvas. */
  restoreTextures(): void {
    this.cache.forEach((e) => { e.tex.needsUpdate = true; });
  }

  stats(): RecordOverlayStats {
    return {
      signsDrawn: this.drawn,
      signsHidden: this.info ? this.info.hiddenAir + this.info.hiddenFront : 0,
      signTextures: this.cache.size,
      signTexBytes: this.cache.bytes,
    };
  }

  private clearMeshes(): void {
    for (const m of this.meshes) this.group.remove(m);
    for (const m of this.texts.values()) this.group.remove(m);
    for (const g of this.geoms) g.dispose();
    this.meshes = [];
    this.geoms = [];
    this.texts.clear();
  }

  private rebuild(): void {
    this.clearMeshes();
    const info = this.info;
    if (!info) { this.drawn = 0; this.onChange(); return; }
    const signs = info.signs.filter((s) => this.visible(s.pos[2]));
    const cmds = info.cmds.filter((c) => this.visible(c.pos[2]));
    this.drawn = signs.length;
    const addMesh = (d: MeshData, mat: THREE.Material) => {
      const g = toGeometry(d);
      if (!g) return;
      this.geoms.push(g);
      const m = new THREE.Mesh(g, mat);
      this.meshes.push(m);
      this.group.add(m);
    };
    addMesh(buildBoardData(signs), this.boardMat);
    const skin = buildSkinData(cmds);
    addMesh(skin.frame, this.skinMat);
    addMesh(skin.panel, this.skinMat);
    addMesh(skin.button, this.buttonMat);
    this.attachText();
    this.schedulePump();
    this.onChange();
  }

  /** Add a text quad for every drawn sign whose texture is cached (queueing builds for the rest). */
  private attachText(): void {
    const info = this.info;
    if (!info) return;
    info.signs.forEach((s, idx) => {
      if (!s.text || this.texts.has(idx) || !this.visible(s.pos[2])) return;
      const entry = this.cache.use(s.kind, s.text);
      if (!entry) return;
      const p = textPlacement(s, entry.texH);
      const m = new THREE.Mesh(this.quadGeom, entry.mat);
      m.matrixAutoUpdate = false;
      m.matrix.makeBasis(
        new THREE.Vector3(...p.right).multiplyScalar(p.hw),
        new THREE.Vector3(...p.up).multiplyScalar(p.hh),
        new THREE.Vector3(...p.normal),
      ).setPosition(p.centre[0], p.centre[1], p.centre[2]);
      m.renderOrder = 1;
      this.texts.set(idx, m);
      this.group.add(m);
    });
  }

  private schedulePump(): void {
    if (this.pumpPending || this.cache.pending === 0 || this.disposed) return;
    this.pumpPending = true;
    this.schedule(() => {
      this.pumpPending = false;
      if (this.disposed) return;
      if (this.cache.pump() > 0) { this.attachText(); this.onChange(); }
      this.schedulePump();
    });
  }

  /** Drop everything, textures included. The overlay is unusable afterwards. */
  dispose(): void {
    this.disposed = true;
    this.clearMeshes();
    this.cache.clear();
    this.quadGeom.dispose();
    this.boardMat.dispose();
    this.skinMat.dispose();
    this.buttonMat.dispose();
    this.info = null;
  }
}
