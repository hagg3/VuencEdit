import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  TextureCache, RecordOverlay, TextEntry, layoutText, wrapText, textureBytes, textPlacement, toThree,
  buildBoardData, buildSkinData, appendBox, frontOf, makeTextMaterial, SKIN_FACES, BUTTON_OUT, BUTTON_HALF,
  type OverlayInfo, type OverlaySign, type OverlayCmd, type Built, type Measure, type MeshData, type SignKind,
} from "./signOverlay";

/** 10 px per character at 20 px font (i.e. width = chars * px / 2). */
const measure: Measure = (s, px) => s.length * px * 0.5;

class FakeTex {
  disposed = false;
  dispose() { this.disposed = true; }
}
const fakeBuild = (bytes = 1000, log: string[] = []) => (kind: SignKind, text: string): Built<FakeTex> => {
  log.push(`${kind}:${text}`);
  return { value: new FakeTex(), bytes };
};

describe("layoutText", () => {
  it("returns null for no printable words", () => {
    expect(layoutText("", "wall", measure)).toBeNull();
    expect(layoutText("   ", "wall", measure)).toBeNull();
  });

  it("keeps the kind's font size when the text fits, and sizes the texture to the lines", () => {
    const l = layoutText("hi", "standing", measure)!;
    expect(l.px).toBe(22);
    expect(l.lines).toEqual(["hi"]);
    expect(l.lineH).toBe(Math.ceil(22 * 1.2)); // 27
    expect(l.top).toBe(5);
    expect(l.texH).toBe(5 + 27 + 4);
    expect(l.outlineR).toBe(2);
  });

  it("wraps greedily and shrinks x0.9 only when it overflows the board, down to 9 px", () => {
    const long = "word ".repeat(60).trim();
    const l = layoutText(long, "standing", measure)!;
    expect(l.px).toBeLessThan(22);
    expect(l.px).toBeGreaterThanOrEqual(9 * 0.9); // the loop stops at <= 9
    // texture never taller than the board (standing: 128 texels)
    expect(l.texH).toBeLessThanOrEqual(128);
    // 22 * 0.9^k
    const k = Math.round(Math.log(l.px / 22) / Math.log(0.9));
    expect(l.px).toBeCloseTo(22 * Math.pow(0.9, k), 6);
  });

  it("breaks a word wider than the line by characters", () => {
    const lines = wrapText("x".repeat(100), 20, 100, measure); // 10 px/char -> 10 chars per line
    expect(lines.every((s) => s.length <= 10)).toBe(true);
    expect(lines.join("")).toBe("x".repeat(100));
  });

  it("uses the wall and command boards' own aspect for the height cap", () => {
    expect(layoutText("a b c d e f g h i j k l m n o p q r s t u v w x y z".repeat(4), "cmd", measure)!.texH).toBeLessThanOrEqual(256);
    expect(layoutText("a ".repeat(120), "wall", measure)!.texH).toBeLessThanOrEqual(146);
  });
});

describe("TextureCache", () => {
  it("queues a miss, builds on pump, and hits afterwards", () => {
    const log: string[] = [];
    const c = new TextureCache<FakeTex>(fakeBuild(1000, log));
    c.beginGeneration();
    expect(c.use("wall", "hello")).toBeUndefined();
    expect(c.pending).toBe(1);
    expect(c.pump()).toBe(1);
    expect(c.use("wall", "hello")).toBeInstanceOf(FakeTex);
    expect(log).toEqual(["wall:hello"]);
    expect(c.size).toBe(1);
    expect(c.bytes).toBe(1000);
  });

  it("keys on (kind, text) and dedupes the queue", () => {
    const log: string[] = [];
    const c = new TextureCache<FakeTex>(fakeBuild(10, log));
    c.beginGeneration();
    c.use("wall", "a"); c.use("wall", "a"); c.use("standing", "a");
    expect(c.pending).toBe(2);
    c.pump();
    expect(log).toEqual(["wall:a", "standing:a"]);
  });

  it("builds at most buildsPerFrame (4) per pump", () => {
    const c = new TextureCache<FakeTex>(fakeBuild(10));
    c.beginGeneration();
    for (let i = 0; i < 10; i++) c.use("wall", `t${i}`);
    expect(c.pump()).toBe(4);
    expect(c.pump()).toBe(4);
    expect(c.pump()).toBe(2);
    expect(c.pump()).toBe(0);
    expect(c.size).toBe(10);
  });

  it("evicts the least-recently-used entry not used this generation, and disposes it", () => {
    const c = new TextureCache<FakeTex>(fakeBuild(10), { maxEntries: 3 });
    c.beginGeneration();
    const vals: FakeTex[] = [];
    for (const t of ["a", "b", "c"]) c.use("wall", t);
    c.pump();
    for (const t of ["a", "b", "c"]) vals.push(c.use("wall", t)!);
    c.beginGeneration();
    c.use("wall", "c"); c.use("wall", "a"); // b is the only one unused this generation... and c, a used
    c.use("wall", "d");
    c.pump();
    expect(vals[1].disposed).toBe(true);   // b evicted
    expect(vals[0].disposed).toBe(false);
    expect(vals[2].disposed).toBe(false);
    expect(c.size).toBe(3);
  });

  it("evicts oldest-first among the unused", () => {
    const c = new TextureCache<FakeTex>(fakeBuild(10), { maxEntries: 2 });
    c.beginGeneration();
    c.use("wall", "a"); c.pump();
    c.use("wall", "b"); c.pump();
    const a = c.use("wall", "a")!; const b = c.use("wall", "b")!; // a then b: b most recent
    c.beginGeneration();
    c.use("wall", "c"); c.pump();
    expect(a.disposed).toBe(true);
    expect(b.disposed).toBe(false);
  });

  it("never evicts something used this generation: the build is skipped instead", () => {
    const log: string[] = [];
    const c = new TextureCache<FakeTex>(fakeBuild(10, log), { maxEntries: 2 });
    c.beginGeneration();
    c.use("wall", "a"); c.use("wall", "b"); c.use("wall", "c");
    c.pump();
    expect(c.size).toBe(2);
    expect(log).toEqual(["wall:a", "wall:b"]); // c never built: no room, both in use
    expect(c.use("wall", "c")).toBeUndefined();
    expect(c.pending).toBe(0); // and not re-queued within the generation
    c.beginGeneration();       // a new generation retries it
    c.use("wall", "c");
    expect(c.pending).toBe(1);
  });

  it("accounts bytes and evicts to fit the byte cap", () => {
    const c = new TextureCache<FakeTex>(fakeBuild(600), { maxBytes: 1000, maxEntries: 99 });
    // MIN_BUILD_BYTES (256x64 w/ mips) is larger than 1000, so reserve nothing here: use big cap instead
    expect(c.bytes).toBe(0);
    const big = new TextureCache<FakeTex>(fakeBuild(textureBytes(256, 100)), { maxBytes: textureBytes(256, 100) * 2 + 10 });
    big.beginGeneration();
    big.use("wall", "a"); big.pump();
    big.use("wall", "b"); big.pump();
    expect(big.bytes).toBe(textureBytes(256, 100) * 2);
    big.beginGeneration();
    big.use("wall", "c"); big.pump();
    expect(big.size).toBe(2);
    expect(big.bytes).toBe(textureBytes(256, 100) * 2);
  });

  it("disposes a freshly built value that cannot fit, and a failed build is not retried in-generation", () => {
    const made: FakeTex[] = [];
    const c = new TextureCache<FakeTex>((_k, _t) => { const v = new FakeTex(); made.push(v); return { value: v, bytes: 1 << 30 }; }, { maxBytes: 1 << 20 });
    c.beginGeneration();
    c.use("wall", "huge");
    c.pump();
    expect(made[0].disposed).toBe(true);
    expect(c.size).toBe(0);
    c.use("wall", "huge");
    expect(c.pending).toBe(0);
  });

  it("clear() disposes everything", () => {
    const c = new TextureCache<FakeTex>(fakeBuild(10));
    c.beginGeneration();
    c.use("wall", "a"); c.pump();
    const v = c.use("wall", "a")!;
    c.clear();
    expect(v.disposed).toBe(true);
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
  });

  it("a null build is dropped without retry", () => {
    const c = new TextureCache<FakeTex>(() => null);
    c.beginGeneration();
    c.use("wall", "a");
    expect(c.pump()).toBe(0);
    c.use("wall", "a");
    expect(c.pending).toBe(0);
  });
});

// ---- geometry ----
const wallSign = (over: Partial<OverlaySign> = {}): OverlaySign => ({
  i: 0, kind: "wall", pos: [5, 6, 7], a: 1, b: 2, c: 0, colour: [200, 100, 50], text: "hi", vis: "drawn",
  // +x wall sign on block (5,6,7): board 1/32 deep off the face at x = 6, 7/8 wide in y, 1/2 tall
  boxes: [{ part: "board", min: [6, 6.0625, 7.25], max: [6 + 1 / 32, 6.9375, 7.75] }],
  quad: { centre: [6 + 1 / 32 + 0.004, 6.5, 7.5], right: [0, -1, 0], up: [0, 0, 1], normal: [1, 0, 0], halfW: 7 / 16, halfH: 0.25 },
  fontPx: 30, ...over,
});
const info = (signs: OverlaySign[], cmds: OverlayCmd[] = []): OverlayInfo => ({ signs, cmds, hiddenAir: 2, hiddenFront: 1, truncated: false });

describe("geometry", () => {
  it("toThree swaps y and z (file z up -> Three y up), no negation", () => {
    expect(toThree([1, 2, 3])).toEqual([1, 3, 2]);
  });

  it("appendBox: 6 faces x 6 verts, front face brightest, others x0.75", () => {
    const d: MeshData = { positions: [], colors: [] };
    appendBox(d, [0, 0, 0], [1, 1, 1], [0, 1], [1, 0.8, 0.4]);
    expect(d.positions.length / 3).toBe(36);
    const reds = new Set<number>();
    for (let i = 0; i < d.colors.length; i += 3) reds.add(Math.round(d.colors[i] * 1000));
    expect([...reds].sort((a, b) => a - b)).toEqual([750, 1000]);
    // exactly one face (6 verts) is full colour
    let full = 0;
    for (let i = 0; i < d.colors.length; i += 3) if (d.colors[i] === 1) full++;
    expect(full).toBe(6);
    // the full-colour face lies at file x = 1 (+x), i.e. Three x = 1
    for (let i = 0; i < d.colors.length; i += 3) if (d.colors[i] === 1) expect(d.positions[i]).toBe(1);
  });

  it("frontOf reads the horizontal normal", () => {
    expect(frontOf([1, 0, 0])).toEqual([0, 1]);
    expect(frontOf([-1, 0, 0])).toEqual([0, -1]);
    expect(frontOf([0, 1, 0])).toEqual([1, 1]);
    expect(frontOf([0, -1, 0])).toEqual([1, -1]);
  });

  it("buildBoardData: posts are x0.7 of the board colour; vertices are in Three axes", () => {
    const standing = wallSign({
      kind: "standing", a: 3,
      boxes: [
        { part: "board", min: [5, 6, 8.5], max: [6, 6.0625, 9] },
        { part: "post", min: [5.46, 6.46, 8], max: [5.54, 6.54, 8.5] },
      ],
      quad: { centre: [5.5, 6.5, 8.75], right: [1, 0, 0], up: [0, 0, 1], normal: [0, 1, 0], halfW: 0.5, halfH: 0.25 },
    });
    const d = buildBoardData([standing]);
    expect(d.positions.length / 3).toBe(72);
    // board vertex y (Three) spans file z 8.5..9
    const ys = d.positions.filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBeCloseTo(8, 6);
    expect(Math.max(...ys)).toBeCloseTo(9, 6);
    const r = 200 / 255;
    const reds = new Set(d.colors.filter((_, i) => i % 3 === 0).map((v) => Math.round(v * 1e4)));
    expect(reds.has(Math.round(r * 1e4))).toBe(true);
    expect(reds.has(Math.round(r * 0.7 * 1e4))).toBe(true);
    expect(reds.has(Math.round(r * 0.7 * 0.75 * 1e4))).toBe(true);
  });

  it("textPlacement hangs the text from the board's top edge (centre + up*(halfH - textH/2))", () => {
    const s = wallSign();
    const texH = 64;
    const p = textPlacement(s, texH);
    const boardW = 2 * (7 / 16);
    const textH = (boardW * texH) / 256;
    // Three axes: up is +Y; file z = 7.5 + (0.25 - textH/2)
    expect(p.centre[1]).toBeCloseTo(7.5 + 0.25 - textH / 2, 6);
    expect(p.centre[0]).toBeCloseTo(6 + 1 / 32 + 0.004, 6);
    expect(p.centre[2]).toBeCloseTo(6.5, 6); // file y -> Three z
    expect(p.hh).toBeCloseTo(textH / 2, 6);
    expect(p.hw).toBeCloseTo(7 / 16, 6);
    expect(p.up).toEqual([0, 1, 0]);
    expect(p.right).toEqual([0, 0, -1]);
    expect(p.normal).toEqual([1, 0, 0]);
  });

  it("text reads unmirrored: right x up points along the normal in a right-handed frame", () => {
    // Reader sees `right` to their right and `up` up, looking *against* the normal, so
    // right x up must equal the normal's... (-normal is the view direction): right x up = normal.
    for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] as const) {
      const right: [number, number, number] = [n[1], -n[0], 0]; // signs.rs: (n.y, -n.x, 0) in file axes
      const sgn = wallSign({ quad: { ...wallSign().quad, normal: [n[0], n[1], 0], right } });
      const p = textPlacement(sgn, 32);
      const r = new THREE.Vector3(...p.right), u = new THREE.Vector3(...p.up), nn = new THREE.Vector3(...p.normal);
      // Three is right-handed: a viewer looking along -normal with up u sees right = (-normal) x u... = u x normal
      const expected = new THREE.Vector3().crossVectors(u, nn);
      expect(r.distanceTo(expected)).toBeLessThan(1e-6);
    }
  });

  it("buildSkinData: one frame (4 strips), panel and button box per exposed face", () => {
    const faces = (1 << 0) | (1 << 3); // -x and top
    const d = buildSkinData([{ i: 0, pos: [1, 2, 3], faces }]);
    expect(d.frame.positions.length / 3).toBe(2 * 4 * 6);
    expect(d.panel.positions.length / 3).toBe(2 * 6);
    expect(d.button.positions.length / 3).toBe(2 * 36);
    expect(buildSkinData([{ i: 0, pos: [0, 0, 0], faces: 0 }]).frame.positions.length).toBe(0);
  });

  it("buildSkinData: the -x face panel lies 0.002 off the steel, the button reaches BUTTON_OUT", () => {
    const d = buildSkinData([{ i: 0, pos: [10, 20, 30], faces: 1 << 0 }]);
    const xs = d.panel.positions.filter((_, i) => i % 3 === 0);
    for (const x of xs) expect(x).toBeCloseTo(10 - 0.002, 6);
    const bx = d.button.positions.filter((_, i) => i % 3 === 0);
    expect(Math.min(...bx)).toBeCloseTo(10 - BUTTON_OUT, 6);
    expect(Math.max(...bx)).toBeCloseTo(10, 6);
    // 0.28 across, centred on the face (file y 20.5, z 30.5)
    const by = d.button.positions.filter((_, i) => i % 3 === 2); // Three z = file y
    expect(Math.max(...by) - Math.min(...by)).toBeCloseTo(2 * BUTTON_HALF, 6);
  });

  it("the skin's per-face shade table matches signs.rs (80/80/100/55/70/70)", () => {
    expect(SKIN_FACES.map((f) => [f.a, f.shade])).toEqual([[0, 0.8], [1, 0.8], [3, 1], [2, 0.55], [4, 0.7], [5, 0.7]]);
  });
});

// ---- RecordOverlay ----
function fakeText(): (kind: SignKind, text: string) => Built<TextEntry> {
  return (_k, text) => {
    const tex = new THREE.Texture();
    return { value: new TextEntry(tex, makeTextMaterial(tex), 32), bytes: textureBytes(256, 32 + text.length) };
  };
}
const manualSchedule = () => {
  const q: (() => void)[] = [];
  return { schedule: (cb: () => void) => { q.push(cb); }, run: () => { const c = q.splice(0); c.forEach((f) => f()); }, size: () => q.length };
};

describe("RecordOverlay", () => {
  it("builds boards at once and text quads over frames, <= 4 textures per frame", () => {
    const sch = manualSchedule();
    const o = new RecordOverlay({ buildText: fakeText(), schedule: sch.schedule });
    const signs = Array.from({ length: 10 }, (_, i) => wallSign({ i, text: `sign ${i}`, pos: [5 + i, 6, 7] }));
    o.apply(info(signs));
    const textMeshes = () => o.group.children.filter((c) => (c as THREE.Mesh).material instanceof THREE.MeshBasicMaterial && ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).map).length;
    expect(textMeshes()).toBe(0);
    expect(o.group.children.length).toBe(1); // the merged boards
    sch.run(); expect(textMeshes()).toBe(4);
    sch.run(); expect(textMeshes()).toBe(8);
    sch.run(); expect(textMeshes()).toBe(10);
    expect(sch.size()).toBe(0);
    const st = o.stats();
    expect(st.signsDrawn).toBe(10);
    expect(st.signsHidden).toBe(3);
    expect(st.signTextures).toBe(10);
    expect(st.signTexBytes).toBeGreaterThan(0);
  });

  it("shares a texture between signs with the same kind and text", () => {
    const sch = manualSchedule();
    const o = new RecordOverlay({ buildText: fakeText(), schedule: sch.schedule });
    o.apply(info([wallSign({ i: 0, text: "same" }), wallSign({ i: 1, text: "same", pos: [6, 6, 7] })]));
    sch.run();
    expect(o.stats().signTextures).toBe(1);
  });

  it("z cull hides records above the band and drops their text; re-showing restores them", () => {
    const sch = manualSchedule();
    const o = new RecordOverlay({ buildText: fakeText(), schedule: sch.schedule });
    o.apply(info([wallSign({ i: 0, pos: [5, 6, 7] }), wallSign({ i: 1, pos: [6, 6, 70] })], [{ i: 0, pos: [1, 1, 100], faces: 1 }]));
    sch.run();
    expect(o.stats().signsDrawn).toBe(2);
    o.setCull(64, null);
    expect(o.stats().signsDrawn).toBe(1);
    // the cmd at z 100 is culled: only the board mesh remains plus 1 text quad
    expect(o.group.children.length).toBe(2);
    o.setCull(null, null);
    sch.run();
    expect(o.stats().signsDrawn).toBe(2);
    expect(o.group.children.length).toBe(1 + 3 + 2); // boards + frame/panel/button + 2 text quads
    o.setCull(null, 10); // cutaway cap: z <= 10 only
    expect(o.stats().signsDrawn).toBe(1);
  });

  it("apply(null) clears; dispose frees geometry and every texture", () => {
    const sch = manualSchedule();
    const o = new RecordOverlay({ buildText: fakeText(), schedule: sch.schedule });
    let disposedTex = 0;
    const base = fakeText();
    const o2 = new RecordOverlay({
      buildText: (k, t) => { const b = base(k, t)!; b.value.tex.addEventListener("dispose", () => disposedTex++); return b; },
      schedule: sch.schedule,
    });
    o.apply(info([wallSign()]));
    o.apply(null);
    expect(o.group.children.length).toBe(0);
    expect(o.stats().signsDrawn).toBe(0);
    o2.apply(info([wallSign({ text: "a" }), wallSign({ i: 1, text: "b", pos: [9, 9, 9] })]));
    sch.run();
    expect(o2.stats().signTextures).toBe(2);
    o2.dispose();
    expect(disposedTex).toBe(2);
    expect(o2.group.children.length).toBe(0);
    // a late apply after dispose is ignored
    o2.apply(info([wallSign()]));
    expect(o2.group.children.length).toBe(0);
  });

  it("restoreTextures marks every live texture for re-upload", () => {
    const sch = manualSchedule();
    const texes: THREE.Texture[] = [];
    const base = fakeText();
    const o = new RecordOverlay({ buildText: (k, t) => { const b = base(k, t)!; texes.push(b.value.tex); return b; }, schedule: sch.schedule });
    o.apply(info([wallSign({ text: "a" }), wallSign({ i: 1, text: "b", pos: [9, 9, 9] })]));
    sch.run();
    const before = texes.map((t) => t.version);
    o.restoreTextures();
    expect(texes.map((t) => t.version)).toEqual(before.map((v) => v + 1));
  });

  it("a new apply keeps cached textures (no rebuild) and signs with no text get no quad", () => {
    const sch = manualSchedule();
    const log: string[] = [];
    const base = fakeText();
    const o = new RecordOverlay({ buildText: (k, t) => { log.push(t); return base(k, t); }, schedule: sch.schedule });
    const i1 = info([wallSign({ text: "a" }), wallSign({ i: 1, text: "", pos: [9, 9, 9] })]);
    o.apply(i1); sch.run();
    o.apply(i1); // same data again (camera moved a little)
    expect(log).toEqual(["a"]);
    expect(o.group.children.length).toBe(2); // boards + the one text quad (immediately, from cache)
    expect(sch.size()).toBe(0);
  });
});
