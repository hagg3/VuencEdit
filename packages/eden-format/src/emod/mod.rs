//! The `.emod` world container (format version 1).
//!
//! An `.emod` holds exactly the content of a `.eden` world in a different container: columns are
//! compressed per column and store only their occupied 16-block bands, a save appends records and
//! never overwrites a committed byte (a COMMIT record makes a batch live, so a torn save rolls back
//! with no journal), and every record carries a CRC-32. The 192-byte `.eden` header, the creature
//! block and the sign trailer are stored verbatim.
//!
//! - [`container`]: the byte layout — constants, record types, codecs, CRC, band split/join.
//! - [`store`]: [`Store`], the reader / writer / compactor.
//! - [`export`]: the own-format export `.emod` → `.eden` ([`export_own`]), sparse or not.
//!
//! **Naming:** the extension is `.emod`, never `.eden` (the shipped game would run its 1.x
//! conversion over the file and destroy it). Temps keep it: `x.emod.creating`, `x.emod.compact`.

pub mod container;
pub mod export;
mod fsutil;
pub mod store;

pub use container::{
    addressable, join_bands, split_bands, Codec, Codecs, RecordType, BAND, COMMIT_LEN, CREATURE_LEN,
    EDEN_DIR_ROW, EDEN_HEADER_LEN, FILE_HEADER_LEN, FMT_VERSION, GENERATOR_LEN, MAGIC, MAX_CREATURE_SLOTS,
    MAX_PAYLOAD, RECORD_HEADER_LEN, SUMMARY_LEN, TAG, TRAILER_MAX,
};
pub use export::{export_own, preflight_own, ExportOptions, OwnExport, Preflight};
pub use store::{
    CommitRef, EncodedColumn, Error, OpenOptions, ReadStatus, Store, Summary, COMPACT_MIN_DEAD_BYTES,
};
