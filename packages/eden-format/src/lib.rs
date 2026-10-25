//! Eden world file formats, shared by the vuenc apps.
//!
//! - [`emod`]: the `.emod` world container (ROADMAP-EDIT 26.1): the file header, records, codecs
//!   and CRCs, and [`emod::Store`] — the reader that implements the spec's reading rules, the
//!   append-only batch writer and compaction; [`emod::export`] — the own-format export
//!   `.emod` → `.eden` (26.4), which is how VuencEdit opens an `.emod`.
//! - [`eden`]: the `.eden` file itself; [`eden::trailer`] is the post-directory trailer (signs +
//!   command blocks) as an editable model (27.0a), source of truth `~/emod/Classes/WorldTrailer.*`.
//!
//! The format's source of truth is `~/emod/docs/emod-file-format.md` (normative; its § Reading
//! is implemented by [`emod::Store::open`]). The structure follows Emod's
//! `Classes/EdenWorldStore.{h,cpp}` so the two can be read side by side.
//!
//! Rules this crate keeps (CLAUDE.md, `packages/README.md`): no `tauri` dependency, no
//! `Serialize` on payload types, and file offsets are `u64` everywhere.

pub mod eden;
pub mod emod;
