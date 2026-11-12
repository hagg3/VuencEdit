//! Block facing: which way a directional block ID points, and how a plane transform changes it.
//!
//! Ramps (24–39), wedges (40–55), doors (66–69) and portals (75–78) encode a direction in the low
//! two bits of their ID. A rotate or flip moves the *cells*; the *IDs* must be remapped by the
//! same map or a staircase ends up climbing the wrong way. The IDs 112–127 (2026 game update)
//! are plain cubes — no directional family there (checked against `DOCUMENTATION/03`).
//!
//! **Plane convention** (the editor/file plane, the one `.epfab` cells live in): `+x` = east,
//! `+y` = south. Families are ordered by offset:
//!
//! | family        | off 0 | off 1 | off 2 | off 3 |
//! |---------------|-------|-------|-------|-------|
//! | ramp/door/portal | S `(0,1)` | W `(-1,0)` | N `(0,-1)` | E `(1,0)` |
//! | wedge         | SE `(1,1)` | SW `(-1,1)` | NW `(-1,-1)` | NE `(1,-1)` |
//!
//! A caller passes the **same 2×2 integer matrix its cell map uses** (`new = m · old`, columns are
//! the images of `+x` and `+y`; see [`ROT_CW`] / [`ROT_CCW`] / [`MIRROR_X`] / [`MIRROR_Y`]).
//! Two callers' "clockwise" can be opposite maps (one sends `(dx,dy) → (dy,-dx)`, the other
//! `(dx,dy) → (-dy,dx)`), so there is deliberately no `rotate_cw` here: pass the matrix of the
//! cell map you actually applied, and the geometric test below guarantees the ID follows it.
//!
//! Pure data, no `tauri` dependency, nothing here derives `Serialize`.

/// A 2×2 integer plane map, row-major: `[[a, b], [c, d]]`, `(x, y) → (a·x + b·y, c·x + d·y)`.
pub type PlaneMap = [[i8; 2]; 2];

/// `(dx, dy) → (dy, -dx)`: east → north. Quarter turn that sends S→E→N→W.
pub const ROT_CW: PlaneMap = [[0, 1], [-1, 0]];
/// `(dx, dy) → (-dy, dx)`: east → south. The inverse of [`ROT_CW`].
pub const ROT_CCW: PlaneMap = [[0, -1], [1, 0]];
/// `(dx, dy) → (-dx, dy)`: left ↔ right.
pub const MIRROR_X: PlaneMap = [[-1, 0], [0, 1]];
/// `(dx, dy) → (dx, -dy)`: top ↔ bottom.
pub const MIRROR_Y: PlaneMap = [[1, 0], [0, -1]];

/// Ramp/door/portal offsets 0..4 → S, W, N, E.
const CARDINAL: [(i8, i8); 4] = [(0, 1), (-1, 0), (0, -1), (1, 0)];
/// Wedge offsets 0..4 → SE, SW, NW, NE.
const DIAGONAL: [(i8, i8); 4] = [(1, 1), (-1, 1), (-1, -1), (1, -1)];

/// Which table a directional ID reads, and the ID of its offset 0.
fn family(bt: u8) -> Option<(&'static [(i8, i8); 4], u8)> {
    match bt {
        24..=39 => Some((&CARDINAL, bt & !3)),
        40..=55 => Some((&DIAGONAL, bt & !3)),
        66..=69 => Some((&CARDINAL, 66)),
        75..=78 => Some((&CARDINAL, 75)),
        _ => None,
    }
}

/// Unit facing in the plane, or `None` if `bt` isn't directional. Wedges face diagonally.
pub fn facing(bt: u8) -> Option<(i8, i8)> {
    let (table, base) = family(bt)?;
    Some(table[(bt - base) as usize])
}

/// The ID of `bt`'s family whose facing is `f`. A non-directional `bt`, or a facing the family
/// has no member for (a diagonal on a ramp, a cardinal on a wedge), returns `bt` unchanged.
pub fn with_facing(bt: u8, f: (i8, i8)) -> u8 {
    match family(bt) {
        Some((table, base)) => match table.iter().position(|&t| t == f) {
            Some(off) => base + off as u8,
            None => bt,
        },
        None => bt,
    }
}

/// Apply a plane map to a facing vector.
#[inline]
pub fn map_facing(m: PlaneMap, f: (i8, i8)) -> (i8, i8) {
    (m[0][0] * f.0 + m[0][1] * f.1, m[1][0] * f.0 + m[1][1] * f.1)
}

/// Remap a block ID by a plane map — the ID `bt` becomes when its cell goes through `m`.
/// Non-directional IDs pass through.
pub fn transform_id(bt: u8, m: PlaneMap) -> u8 {
    match facing(bt) {
        Some(f) => with_facing(bt, map_facing(m, f)),
        None => bt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 4 rotations × optional mirror (a rotation composed with a mirror is a reflection).
    fn all_maps() -> Vec<PlaneMap> {
        let mul = |a: PlaneMap, b: PlaneMap| -> PlaneMap {
            let mut r = [[0i8; 2]; 2];
            for i in 0..2 {
                for j in 0..2 {
                    r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j];
                }
            }
            r
        };
        let id: PlaneMap = [[1, 0], [0, 1]];
        let mut out = Vec::new();
        let mut rot = id;
        for _ in 0..4 {
            out.push(rot);
            out.push(mul(rot, MIRROR_X));
            rot = mul(ROT_CW, rot);
        }
        out
    }

    /// The load-bearing test: for every ID and every map, the remapped ID faces where the map
    /// sends the old facing. Not a table — it can't agree with a wrong table by accident.
    #[test]
    fn facing_follows_every_plane_map() {
        let maps = all_maps();
        assert_eq!(maps.len(), 8);
        for (i, a) in maps.iter().enumerate() {
            for b in &maps[i + 1..] {
                assert_ne!(a, b, "the eight maps are distinct");
            }
        }
        for bt in 0..=127u8 {
            for &m in &maps {
                let out = transform_id(bt, m);
                match facing(bt) {
                    Some(f) => assert_eq!(
                        facing(out),
                        Some(map_facing(m, f)),
                        "id {bt} under {m:?} -> {out}"
                    ),
                    None => assert_eq!(out, bt, "non-directional id {bt} must be untouched"),
                }
                // stays inside its own family (ramp stays the same material)
                if facing(bt).is_some() {
                    assert_eq!(
                        family(out).map(|(_, b)| b),
                        family(bt).map(|(_, b)| b),
                        "id {bt} left its family -> {out}"
                    );
                }
            }
        }
    }

    #[test]
    fn facing_round_trips_through_with_facing() {
        for bt in 0..=127u8 {
            if let Some(f) = facing(bt) {
                assert_eq!(with_facing(bt, f), bt);
            }
        }
        assert_eq!(with_facing(24, (1, 1)), 24, "a ramp has no diagonal member");
        assert_eq!(with_facing(40, (0, 1)), 40, "a wedge has no cardinal member");
        assert_eq!(with_facing(2, (0, 1)), 2);
    }

    #[test]
    fn quarter_turns_and_double_flips_are_identity() {
        for bt in 0..=127u8 {
            let (mut c, mut cc) = (bt, bt);
            for _ in 0..4 {
                c = transform_id(c, ROT_CW);
                cc = transform_id(cc, ROT_CCW);
            }
            assert_eq!((c, cc), (bt, bt));
            assert_eq!(transform_id(transform_id(bt, MIRROR_X), MIRROR_X), bt);
            assert_eq!(transform_id(transform_id(bt, MIRROR_Y), MIRROR_Y), bt);
            assert_eq!(transform_id(transform_id(bt, ROT_CW), ROT_CCW), bt);
        }
    }

    #[test]
    fn named_cases() {
        // S→E→N→W→S under ROT_CW, and the opposite way under ROT_CCW.
        assert_eq!(transform_id(24, ROT_CW), 27);
        assert_eq!(transform_id(27, ROT_CW), 26);
        assert_eq!(transform_id(24, ROT_CCW), 25);
        // mirror X swaps E/W, leaves S/N; wedges flip the east/west component.
        assert_eq!(transform_id(25, MIRROR_X), 27);
        assert_eq!(transform_id(24, MIRROR_X), 24);
        assert_eq!(transform_id(40, MIRROR_X), 41);
        assert_eq!(transform_id(40, MIRROR_Y), 43);
        // doors and portals
        assert_eq!(transform_id(66, ROT_CW), 69);
        assert_eq!(transform_id(75, ROT_CW), 78);
        assert_eq!(transform_id(79, ROT_CW), 79, "79 is outside the portal family table");
    }
}
