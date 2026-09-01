//! Non-rectangular selection footprints.
//!
//! A shaped selection (magic wand, lasso) is a bounding box plus a per-column bitset. Both the
//! editing commands and every preview renderer consult it, which is why it lives here rather than
//! in either app: the mesher and the ortho renderers in this crate need `contains`, and the app
//! owns where the mask is *stored* and when it is trusted.

/// Non-rectangular selection footprint (magic-wand shape, lasso). Absolute-world bounding box
/// (`x1..=x2`, `y1..=y2`) plus a row-major bitset — `width*height` bits, bit set = that column is
/// selected. It's 2D (per-column), like the selection itself; z range still comes from the slider.
/// Memory is `w·h/8` bytes: 200×200 ≈ 5 KB, 1000×1000 ≈ 122 KB — negligible, no compression.
///
/// ⚠️ **Fail-safe contract (corruption-critical).** A command applies the mask ONLY when the rect
/// the frontend passed *exactly* equals this bbox ([`SelectionMask::matches_rect`]). Any mismatch →
/// the edit behaves rect-only, exactly as before masks existed, so a stale mask can never mis-filter
/// an unrelated selection; worst case is a silent fall-back to current behaviour. This is
/// defense-in-depth: the frontend is *also* expected to clear the mask on every selection reshape,
/// but the backend never trusts that — it re-checks the rect every edit.
#[derive(Clone)]
pub struct SelectionMask {
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
    /// Row-major bitset over the bbox, `ceil(width*height/8)` bytes. Bit `(y-y1)*width+(x-x1)`.
    pub bits: Vec<u8>,
}

impl SelectionMask {
    #[inline]
    pub fn width(&self) -> i32 { self.x2 - self.x1 + 1 }

    /// The fail-safe rule: does this mask's bbox exactly equal the rect the caller passed?
    #[inline]
    pub fn matches_rect(&self, x1: i32, y1: i32, x2: i32, y2: i32) -> bool {
        self.x1 == x1 && self.y1 == y1 && self.x2 == x2 && self.y2 == y2
    }

    /// Is absolute column `(x, y)` inside the footprint AND its bit set? Out-of-bbox → false.
    #[inline]
    pub fn contains(&self, x: i32, y: i32) -> bool {
        if x < self.x1 || x > self.x2 || y < self.y1 || y > self.y2 { return false; }
        let idx = ((y - self.y1) * self.width() + (x - self.x1)) as usize;
        self.bits.get(idx >> 3).is_some_and(|b| b & (1u8 << (idx & 7)) != 0)
    }

    /// Number of set (selected) cells — for honest selection stats.
    pub fn count(&self) -> u32 {
        self.bits.iter().map(|b| b.count_ones()).sum()
    }
}
