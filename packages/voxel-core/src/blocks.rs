//! Block-type semantics that aren't colour: the fluid family.
//!
//! Water and lava each occupy four block ids — a full source plus ¾/½/¼ partial levels — and both
//! the editors' fluid simulation and the 3D mesher need to move between "which fluid is this" and
//! "how full is it" constantly. These are direct ports of `Liquids.mm`, so they belong with the
//! rest of the shared block metadata rather than in either app.

/// `(base, level)` → block type. `base` is 20 (water) or 23 (lava); `level` 4 = source, 3/2/1 =
/// ¾/½/¼, 0 = air. Mirrors `Liquids.mm`'s `genLevel`.
#[inline]
pub fn fluid_type_for(base: u8, level: u8) -> u8 {
    match (base, level) {
        (20, 4) => 20, (20, 3) => 59, (20, 2) => 60, (20, 1) => 61,
        (23, 4) => 23, (23, 3) => 62, (23, 2) => 63, (23, 1) => 64,
        _ => 0,
    }
}

/// Block type → fluid level (4 = source … 1 = ¼), 0 for anything that isn't water/lava. Mirrors
/// `Liquids.mm`'s `getLevel`.
#[inline]
pub fn fluid_level(bt: u8) -> u8 {
    match bt {
        20 | 23 => 4,
        59 | 62 => 3,
        60 | 63 => 2,
        61 | 64 => 1,
        _ => 0,
    }
}

/// Block type → its fluid base (20 water / 23 lava), or `None` if not a fluid. Mirrors `Liquids.mm`'s
/// `getBaseType`.
#[inline]
pub fn fluid_base(bt: u8) -> Option<u8> {
    match bt {
        20 | 59 | 60 | 61 => Some(20),
        23 | 62 | 63 | 64 => Some(23),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three helpers describe one table from three directions; a change to any one of them that
    /// isn't mirrored in the others silently mis-renders fluid surfaces.
    #[test]
    fn fluid_helpers_round_trip() {
        for base in [20u8, 23] {
            for level in 1u8..=4 {
                let bt = fluid_type_for(base, level);
                assert_eq!(fluid_base(bt), Some(base), "base of {bt}");
                assert_eq!(fluid_level(bt), level, "level of {bt}");
            }
        }
        assert_eq!(fluid_base(2), None);
        assert_eq!(fluid_level(2), 0);
        assert_eq!(fluid_type_for(2, 4), 0, "a non-fluid base has no fluid ids");
    }
}
