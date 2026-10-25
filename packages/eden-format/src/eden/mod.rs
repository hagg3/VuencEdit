//! The `.eden` world file itself (as opposed to the [`crate::emod`] container).
//!
//! - [`trailer`]: the post-directory trailer (signs + command blocks) as an editable model
//!   (ROADMAP-EDIT 27.0a), a port of Emod's `Classes/WorldTrailer.{h,cpp}`.

pub mod trailer;
