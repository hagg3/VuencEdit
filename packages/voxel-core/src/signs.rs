//! Sign and command-block geometry in world-block space, plus the visibility rules.
//!
//! Pure and generic over [`VoxelView`]: this module knows nothing about where the records come
//! from (a trailer, a network frame). Callers hand it a [`SignSpec`] in the view's own block
//! coordinates and draw the result.
//!
//! **Constants and per-face geometry are copied from Emod's `Classes/SignRenderer.cpp`**
//! (`kStandW` … `kButtonOut`, `dirOf`, `faceNormal`, `kSkinFaces`), re-expressed in this repo's
//! axes: `x`, `y` horizontal and `z` the height (Emod's engine order is `x, y_up, z`, i.e. its
//! `y`/`z` are our `z`/`y`). Every vector here is in that file order. A block `(x, y, z)` fills
//! `[x, x+1] × [y, y+1] × [z, z+1]`.
//!
//! Faces use the trailer's `a` code everywhere (also as the bit index of a [`FaceMask`]):
//! 0 −x, 1 +x, 2 bottom (never drawn), 3 top, 4 −y, 5 +y. `c` is the quarter turn a standing
//! sign's text faces: 0 −x, 1 −y, 2 +x, 3 +y.

use crate::colors::{BI_NOTSOLID, BLOCK_INFO, PAINT_RGB};
use crate::view::{read_block_abs, VoxelView};
use serde::Serialize;

// ---- the shape, in blocks (SignRenderer.cpp) -------------------------------------------------
pub const STAND_W: f32 = 1.0;
pub const STAND_H: f32 = 0.5;
/// A standing board's lower edge above the anchor's top face.
pub const STAND_LIFT: f32 = 0.5;
pub const STAND_THICK: f32 = 1.0 / 16.0;
pub const POST_HALF: f32 = 0.04;
/// The post runs from the top face up to the board's lower edge.
pub const POST_TOP: f32 = STAND_LIFT;
pub const WALL_HALF_W: f32 = 7.0 / 16.0;
pub const WALL_HALF_H: f32 = 0.25;
/// A wall board's front, off the face.
pub const WALL_OUT: f32 = 1.0 / 32.0;
/// A command block's inner panel half-size (1/8 frame).
pub const PANEL_HALF: f32 = 0.375;
/// Text stands this far in front of its board.
pub const TEXT_LIFT: f32 = 0.004;
/// The command-block skin lies this far off the steel (the renderer adds a polygon offset).
pub const SKIN_OUT: f32 = 0.002;
pub const BUTTON_HALF: f32 = 0.14;
pub const BUTTON_OUT: f32 = WALL_OUT + 0.016;
pub const BUTTON_IDLE_RGB: [f32; 3] = [0.90, 0.08, 0.06];

// ---- the text raster (consumed by the frontend; kept here so the numbers live in one place) --
pub const TEX_W: u32 = 256;
/// Font px at `TEX_W` across the board, per [`SignKind`] (standing, wall, command panel).
pub const FONT_PX: [f32; 3] = [22.0, 30.0, 28.0];
pub const TEXT_MARGIN: f32 = TEX_W as f32 * 0.04;
pub const LINE_HEIGHT: f32 = 1.2;
pub const SHRINK: f32 = 0.9;
pub const MIN_FONT_PX: f32 = 9.0;
pub const TEXT_OUTLINE_RGB: [u8; 3] = [16, 16, 16];

// ---- culling and texture budget ---------------------------------------------------------------
pub const RADIUS: i32 = 32;
pub const CMD_RADIUS: i32 = 64;
pub const MAX_TEXTURES: usize = 256;
pub const MAX_TEX_BYTES: usize = 24 << 20;
pub const BUILDS_PER_FRAME: usize = 4;

/// The highest stock block id (Emod's `STOCK_BLOCK_MAX`).
const STOCK_BLOCK_MAX: usize = 127;

/// A sign record as the geometry needs it, in the view's block coordinates (the same space
/// `read_block_abs` takes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SignSpec {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub a: i32,
    pub b: i32,
    pub c: i32,
    /// The anchor block carries a command-block record: a wall board fills the skin's inner
    /// panel instead of the usual 7/8 × 1/2 board.
    pub on_cmd: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignKind {
    Standing,
    Wall,
    /// A wall board on a command block's face.
    Cmd,
}

impl SignKind {
    /// Index into [`FONT_PX`].
    pub fn index(self) -> usize {
        match self { SignKind::Standing => 0, SignKind::Wall => 1, SignKind::Cmd => 2 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SignVis {
    Drawn,
    HiddenAir,
    HiddenFront,
    /// `a = 2` (or any code that isn't a face): never drawn.
    Bottom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BoxPart {
    Board,
    Post,
}

/// An axis-aligned box in world-block space (file axes).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct SignBox {
    pub part: BoxPart,
    pub min: [f32; 3],
    pub max: [f32; 3],
}

/// Where the text goes. `centre` is the middle of the board's front surface already pushed out by
/// [`TEXT_LIFT`]; `half_w`/`half_h` are the board's half extents. The text's own height is the
/// frontend's (it depends on the rasterised line count): the quad's centre is
/// `centre + up * (half_h - text_h / 2)`, text hangs from the board's top edge.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quad {
    pub centre: [f32; 3],
    /// What a reader facing the text sees as "right" (Emod: `(-n) x up`).
    pub right: [f32; 3],
    pub up: [f32; 3],
    pub normal: [f32; 3],
    pub half_w: f32,
    pub half_h: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignGeom {
    pub kind: SignKind,
    pub boxes: Vec<SignBox>,
    pub quad: Quad,
    pub font_px: f32,
}

type V = [f32; 3];
fn add(a: V, b: V) -> V { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
fn mul(a: V, k: f32) -> V { [a[0] * k, a[1] * k, a[2] * k] }

/// Outward unit normal of face `a` (0 −x, 1 +x, 2 −z, 3 +z, 4 −y, 5 +y), `None` out of range.
pub fn face_normal(a: i32) -> Option<[i32; 3]> {
    Some(match a {
        0 => [-1, 0, 0],
        1 => [1, 0, 0],
        2 => [0, 0, -1],
        3 => [0, 0, 1],
        4 => [0, -1, 0],
        5 => [0, 1, 0],
        _ => return None,
    })
}

/// The direction a standing sign's text faces (Emod `dirOf`): 0 −x, 1 −y, 2 +x, 3 +y.
pub fn dir_of(c: i32) -> [i32; 2] {
    match c & 3 { 0 => [-1, 0], 1 => [0, -1], 2 => [1, 0], _ => [0, 1] }
}

/// A command-block skin face: outward normal and the in-plane axes, copied from Emod's
/// `kSkinFaces` and converted to file axes. Note Emod's skin `right` is the *opposite* of the
/// wall-board `right` on the same face (the art's own orientation); both are literal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SkinFace {
    pub a: i32,
    pub normal: [i32; 3],
    pub right: [i32; 3],
    pub up: [i32; 3],
    /// Emod's fixed per-face shade so the cube reads as one.
    pub shade_pct: u8,
}

pub const SKIN_FACES: [SkinFace; 6] = [
    SkinFace { a: 0, normal: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1], shade_pct: 80 },
    SkinFace { a: 1, normal: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], shade_pct: 80 },
    SkinFace { a: 3, normal: [0, 0, 1], right: [1, 0, 0], up: [0, -1, 0], shade_pct: 100 },
    SkinFace { a: 2, normal: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], shade_pct: 55 },
    SkinFace { a: 4, normal: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1], shade_pct: 70 },
    SkinFace { a: 5, normal: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1], shade_pct: 70 },
];

/// Emod's `opaque()`: `1 ≤ t ≤ STOCK_BLOCK_MAX && !(blockinfo[t] & IS_NOTSOLID)`.
pub fn is_opaque(t: u8) -> bool {
    let t = t as usize;
    (1..=STOCK_BLOCK_MAX).contains(&t) && BLOCK_INFO[t] & BI_NOTSOLID == 0
}

/// The board colour: `PAINT_RGB[b]` for `b` in 1..=54, else the `b = 2` colour (plan O5; Emod
/// itself falls back to 45).
pub fn board_rgb(b: i32) -> [u8; 3] {
    PAINT_RGB[if (1..=54).contains(&b) { b as usize } else { 2 }]
}

/// Board and post geometry plus the text quad. `None` for `a = 2` and any non-face code.
pub fn sign_geometry(s: &SignSpec) -> Option<SignGeom> {
    let centre = [s.x as f32 + 0.5, s.y as f32 + 0.5, s.z as f32 + 0.5];
    let up = [0.0, 0.0, 1.0];
    let bx = |part, c: V, half: V| SignBox {
        part,
        min: [c[0] - half[0], c[1] - half[1], c[2] - half[2]],
        max: [c[0] + half[0], c[1] + half[1], c[2] + half[2]],
    };
    // A board centred at `c` whose normal is `n` (a horizontal or vertical axis unit vector),
    // `hw` along `right`, `hh` up, `hd` deep. Axis-aligned, so the half extents land on axes.
    let board = |part, c: V, n: V, right: V, hw: f32, hh: f32, hd: f32| {
        let half = [
            n[0].abs() * hd + right[0].abs() * hw,
            n[1].abs() * hd + right[1].abs() * hw,
            hh,
        ];
        bx(part, c, half)
    };
    if s.a == 3 {
        let [nx, ny] = dir_of(s.c);
        let n = [nx as f32, ny as f32, 0.0];
        // right = (-n) x up, in file axes (n.y, -n.x, 0)
        let right = [n[1], -n[0], 0.0];
        let top = add(centre, [0.0, 0.0, 0.5]);
        let bcen = add(top, [0.0, 0.0, STAND_LIFT + STAND_H * 0.5]);
        let front = add(bcen, mul(n, STAND_THICK * 0.5));
        let post_c = add(top, [0.0, 0.0, POST_TOP * 0.5]);
        let post_half = [POST_HALF, POST_HALF, POST_TOP * 0.5];
        return Some(SignGeom {
            kind: SignKind::Standing,
            boxes: vec![
                board(BoxPart::Board, bcen, n, right, STAND_W * 0.5, STAND_H * 0.5, STAND_THICK * 0.5),
                bx(BoxPart::Post, post_c, post_half),
            ],
            quad: Quad {
                centre: add(front, mul(n, TEXT_LIFT)),
                right, up, normal: n,
                half_w: STAND_W * 0.5, half_h: STAND_H * 0.5,
            },
            font_px: FONT_PX[0],
        });
    }
    if !matches!(s.a, 0 | 1 | 4 | 5) {
        return None;
    }
    let [fx, fy, _] = face_normal(s.a)?;
    let n = [fx as f32, fy as f32, 0.0];
    let right = [n[1], -n[0], 0.0];
    let (hw, hh, kind) = if s.on_cmd {
        (PANEL_HALF, PANEL_HALF, SignKind::Cmd)
    } else {
        (WALL_HALF_W, WALL_HALF_H, SignKind::Wall)
    };
    let face_c = add(centre, mul(n, 0.5));
    let bcen = add(face_c, mul(n, WALL_OUT * 0.5));
    let front = add(face_c, mul(n, WALL_OUT));
    Some(SignGeom {
        kind,
        boxes: vec![board(BoxPart::Board, bcen, n, right, hw, hh, WALL_OUT * 0.5)],
        quad: Quad {
            centre: add(front, mul(n, TEXT_LIFT)),
            right, up, normal: n,
            half_w: hw, half_h: hh,
        },
        font_px: FONT_PX[kind.index()],
    })
}

/// The sign's boxes (board, then the post for a standing sign); empty for `a = 2`.
pub fn sign_boxes(s: &SignSpec) -> Vec<SignBox> {
    sign_geometry(s).map(|g| g.boxes).unwrap_or_default()
}

/// The text quad; `None` for `a = 2`.
pub fn text_quad(s: &SignSpec) -> Option<Quad> {
    sign_geometry(s).map(|g| g.quad)
}

/// Visibility: the anchor is air ⇒ hidden; the front cell (across face `a`, or the cell above for
/// a standing sign) is opaque ⇒ hidden. Hidden is never deleted.
pub fn sign_visibility(view: &impl VoxelView, s: &SignSpec) -> SignVis {
    let n = match s.a {
        3 => [0, 0, 1],
        0 | 1 | 4 | 5 => face_normal(s.a).unwrap(),
        _ => return SignVis::Bottom,
    };
    if read_block_abs(view, s.x, s.y, s.z) == 0 {
        return SignVis::HiddenAir;
    }
    if is_opaque(read_block_abs(view, s.x + n[0], s.y + n[1], s.z + n[2])) {
        SignVis::HiddenFront
    } else {
        SignVis::Drawn
    }
}

/// Which faces of a command block get the skin, as a bitmask indexed by the `a` code (bit 0 −x,
/// 1 +x, 2 bottom, 3 top, 4 −y, 5 +y). A face is exposed when its neighbour is not opaque.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct FaceMask(pub u8);

impl FaceMask {
    pub fn has(self, a: i32) -> bool { (0..6).contains(&a) && self.0 & (1 << a) != 0 }
}

pub fn cmd_faces(view: &impl VoxelView, x: i32, y: i32, z: i32) -> FaceMask {
    let mut m = 0u8;
    for f in SKIN_FACES {
        let n = f.normal;
        if !is_opaque(read_block_abs(view, x + n[0], y + n[1], z + n[2])) {
            m |= 1 << f.a;
        }
    }
    FaceMask(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testworld::TestWorld;

    fn put(w: &mut TestWorld, x: i32, y: i32, z: i32, t: u8) {
        let i = (z as usize / 16) * 8192 + x as usize * 256 + y as usize * 16 + z as usize % 16;
        w.bytes[i] = t;
    }
    fn spec(a: i32, c: i32) -> SignSpec { SignSpec { x: 5, y: 6, z: 7, a, b: 2, c, on_cmd: false } }
    fn close(a: [f32; 3], b: [f32; 3]) -> bool { (0..3).all(|i| (a[i] - b[i]).abs() < 1e-5) }

    #[test]
    fn standing_geometry_each_c() {
        // right = (n.y, -n.x, 0) per c; board centre z = 7 + 1 + 0.5 + 0.25
        let want = [([-1.0, 0.0], [0.0, 1.0]), ([0.0, -1.0], [-1.0, 0.0]), ([1.0, 0.0], [0.0, -1.0]), ([0.0, 1.0], [1.0, 0.0])];
        for (c, (n, r)) in want.iter().enumerate() {
            let g = sign_geometry(&spec(3, c as i32)).unwrap();
            assert_eq!(g.kind, SignKind::Standing);
            assert_eq!(g.boxes.len(), 2);
            assert!(close(g.quad.normal, [n[0], n[1], 0.0]), "c={c}");
            assert!(close(g.quad.right, [r[0], r[1], 0.0]), "c={c}");
            let b = g.boxes[0];
            assert_eq!(b.part, BoxPart::Board);
            // z span: 8.5 .. 9.0 + ... board lower edge at top (8.0) + 0.5
            assert!((b.min[2] - 8.5).abs() < 1e-5 && (b.max[2] - 9.0).abs() < 1e-5);
            // thin along n, 1 wide along right
            let ext = [b.max[0] - b.min[0], b.max[1] - b.min[1]];
            let (thin, wide) = if n[0] != 0.0 { (ext[0], ext[1]) } else { (ext[1], ext[0]) };
            assert!((thin - STAND_THICK).abs() < 1e-5 && (wide - 1.0).abs() < 1e-5, "c={c}");
            // centred on the block
            assert!(close([(b.min[0] + b.max[0]) / 2.0, (b.min[1] + b.max[1]) / 2.0, 0.0], [5.5, 6.5, 0.0]));
            let p = g.boxes[1];
            assert_eq!(p.part, BoxPart::Post);
            assert!(close(p.min, [5.5 - 0.04, 6.5 - 0.04, 8.0]) && close(p.max, [5.5 + 0.04, 6.5 + 0.04, 8.5]));
            // text sits in front of the board's front face
            let off = (g.quad.centre[0] - 5.5) * n[0] + (g.quad.centre[1] - 6.5) * n[1];
            assert!((off - (STAND_THICK * 0.5 + TEXT_LIFT)).abs() < 1e-5, "c={c}");
        }
        // c is taken mod 4
        assert_eq!(sign_geometry(&spec(3, 6)), sign_geometry(&spec(3, 2)));
    }

    #[test]
    fn wall_geometry_each_a() {
        for a in [0, 1, 4, 5] {
            let n = face_normal(a).unwrap();
            let g = sign_geometry(&spec(a, 0)).unwrap();
            assert_eq!(g.kind, SignKind::Wall);
            assert_eq!(g.boxes.len(), 1);
            assert!(close(g.quad.normal, [n[0] as f32, n[1] as f32, 0.0]));
            let b = g.boxes[0];
            // 7/8 wide, 1/2 tall, 1/32 deep, flush on the face
            let (depth, width) = if n[0] != 0 { (b.max[0] - b.min[0], b.max[1] - b.min[1]) } else { (b.max[1] - b.min[1], b.max[0] - b.min[0]) };
            assert!((depth - WALL_OUT).abs() < 1e-5 && (width - 0.875).abs() < 1e-5, "a={a}");
            assert!((b.max[2] - b.min[2] - 0.5).abs() < 1e-5 && ((b.max[2] + b.min[2]) / 2.0 - 7.5).abs() < 1e-5);
            let off = (g.quad.centre[0] - 5.5) * n[0] as f32 + (g.quad.centre[1] - 6.5) * n[1] as f32;
            assert!((off - (0.5 + WALL_OUT + TEXT_LIFT)).abs() < 1e-5, "a={a}");
            assert_eq!(g.font_px, 30.0);
        }
        // a = -x: reader sees +y on the right (Emod: (-n) x up, engine +z = file +y)
        assert!(close(sign_geometry(&spec(0, 0)).unwrap().quad.right, [0.0, 1.0, 0.0]));
        assert!(close(sign_geometry(&spec(4, 0)).unwrap().quad.right, [-1.0, 0.0, 0.0]));
    }

    #[test]
    fn cmd_face_board_fills_panel() {
        let mut s = spec(1, 0);
        s.on_cmd = true;
        let g = sign_geometry(&s).unwrap();
        assert_eq!(g.kind, SignKind::Cmd);
        let b = g.boxes[0];
        assert!((b.max[1] - b.min[1] - 0.75).abs() < 1e-5 && (b.max[2] - b.min[2] - 0.75).abs() < 1e-5);
        assert_eq!(g.font_px, 28.0);
    }

    #[test]
    fn bottom_and_garbage_never_drawn() {
        for a in [2, -1, 6, 99] {
            assert!(sign_geometry(&spec(a, 0)).is_none());
            assert!(sign_boxes(&spec(a, 0)).is_empty());
            assert!(text_quad(&spec(a, 0)).is_none());
            assert_eq!(sign_visibility(&TestWorld::new(1, 1, 4), &spec(a, 0)), SignVis::Bottom);
        }
    }

    #[test]
    fn colour_fallback_is_b2() {
        assert_eq!(board_rgb(1), PAINT_RGB[1]);
        assert_eq!(board_rgb(54), PAINT_RGB[54]);
        for b in [0, 55, -3, 1000] {
            assert_eq!(board_rgb(b), PAINT_RGB[2]);
        }
    }

    #[test]
    fn opaque_rule() {
        assert!(!is_opaque(0));
        assert!(!is_opaque(58)); // glass
        assert!(is_opaque(2) && is_opaque(123)); // stone, snow
        assert!(!is_opaque(200)); // beyond STOCK_BLOCK_MAX
    }

    #[test]
    fn visibility_matrix() {
        let mut w = TestWorld::new(1, 1, 4);
        // air anchor
        assert_eq!(sign_visibility(&w, &spec(1, 0)), SignVis::HiddenAir);
        assert_eq!(sign_visibility(&w, &spec(3, 0)), SignVis::HiddenAir);
        put(&mut w, 5, 6, 7, 2);
        // wall sign on +x: front cell (6,6,7)
        assert_eq!(sign_visibility(&w, &spec(1, 0)), SignVis::Drawn);
        put(&mut w, 6, 6, 7, 2); // opaque front
        assert_eq!(sign_visibility(&w, &spec(1, 0)), SignVis::HiddenFront);
        put(&mut w, 6, 6, 7, 58); // glass front: still drawn
        assert_eq!(sign_visibility(&w, &spec(1, 0)), SignVis::Drawn);
        // other faces unaffected by that block
        assert_eq!(sign_visibility(&w, &spec(0, 0)), SignVis::Drawn);
        // standing: block above hides it
        assert_eq!(sign_visibility(&w, &spec(3, 2)), SignVis::Drawn);
        put(&mut w, 5, 6, 8, 3);
        assert_eq!(sign_visibility(&w, &spec(3, 2)), SignVis::HiddenFront);
        // -y and +y fronts
        put(&mut w, 5, 5, 7, 2);
        assert_eq!(sign_visibility(&w, &spec(4, 0)), SignVis::HiddenFront);
        assert_eq!(sign_visibility(&w, &spec(5, 0)), SignVis::Drawn);
        // edge of the world / missing chunk: front is air, drawn
        put(&mut w, 0, 0, 7, 2);
        let s = SignSpec { x: 0, y: 0, z: 7, a: 0, b: 2, c: 0, on_cmd: false };
        assert_eq!(sign_visibility(&w, &s), SignVis::Drawn);
    }

    #[test]
    fn exposed_cmd_faces() {
        let mut w = TestWorld::new(1, 1, 4);
        put(&mut w, 5, 6, 7, 2);
        assert_eq!(cmd_faces(&w, 5, 6, 7), FaceMask(0b111111));
        put(&mut w, 6, 6, 7, 2); // +x
        put(&mut w, 5, 6, 6, 2); // below
        put(&mut w, 5, 5, 7, 58); // -y glass: still exposed
        let m = cmd_faces(&w, 5, 6, 7);
        assert!(!m.has(1) && !m.has(2));
        assert!(m.has(0) && m.has(3) && m.has(4) && m.has(5));
        assert_eq!(m.0, 0b111001);
    }

    #[test]
    fn skin_faces_are_orthonormal_with_matching_a() {
        for f in SKIN_FACES {
            assert_eq!(face_normal(f.a), Some(f.normal));
            let d = |p: [i32; 3], q: [i32; 3]| p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
            assert_eq!(d(f.normal, f.right), 0);
            assert_eq!(d(f.normal, f.up), 0);
            assert_eq!(d(f.right, f.up), 0);
        }
    }
}
