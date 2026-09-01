//! Voxel primitives shared by the vuenc Eden apps.
//!
//! **The rule for what belongs here:** code that does not know what a `.eden` file, a network
//! session, or a Tauri command is. Colour tables, block metadata and block addressing qualify.
//! Anything touching `tauri::State` or an app's concrete world type does not — this crate has
//! no `tauri` dependency and should keep it that way.
//!
//! (This crate is published as part of the VuencEdit source tree; keep its docs free of
//! references to unreleased sibling apps.)

pub mod blocks;
pub mod colors;
pub mod geometry;
pub mod lamps;
pub mod mask;
pub mod render;
pub mod texture;
pub mod view;

#[cfg(test)]
mod testworld;
