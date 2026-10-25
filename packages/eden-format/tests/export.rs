//! Own-format export gates (spec § Export to `.eden`, ROADMAP-EDIT 26.4): a fresh conversion
//! (`PROVENANCE.flags` = 0) exports byte-identical to its source `.eden`; sparse ≡ dense; the
//! pre-flight equals the written size; a later batch's edits show up in the export.

mod common;

use common::*;
use eden_format::emod::{export::parse_provenance, export_own, preflight_own, ExportOptions, RecordType, Store};

/// Writes a fixture (gunzipped) into `tmp` and opens it.
fn open_fixture(tmp: &TempDir, name: &str) -> Store {
    let p = tmp.path(name.trim_end_matches(".gz"));
    std::fs::write(&p, fixture(name)).unwrap();
    Store::open(&p).unwrap()
}

fn export(store: &mut Store, tmp: &TempDir, sparse: bool) -> Vec<u8> {
    let out = tmp.path(if sparse { "out-sparse.eden" } else { "out-dense.eden" });
    let pre = preflight_own(store).unwrap();
    let r = export_own(store, &out, ExportOptions { sparse, fsync: false }).unwrap();
    assert_eq!(r.preflight, pre, "pre-flight is the same before and during the export");
    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(bytes.len() as u64, pre.total_len, "pre-flight = written size");
    assert!(pre.occupied_len <= pre.total_len);
    assert_eq!(r.slots.len() as u32, pre.columns);
    assert!(r.air_columns.is_empty() && r.fallback_columns.is_empty());
    bytes
}

#[test]
fn fresh_conversions_export_to_their_source_byte_for_byte() {
    for (emod, eden) in [("f64-basic.zlib.emod", "f64-basic.eden.gz"), ("f256-trailer.none.emod.gz", "f256-trailer.eden.gz")] {
        let tmp = TempDir::new("export-own");
        let mut st = open_fixture(&tmp, emod);
        let (_, prov) = st.read_record(RecordType::Provenance).unwrap();
        let prov = parse_provenance(&prov).expect("PROVENANCE parses");
        let source = fixture(eden);
        let dense = export(&mut st, &tmp, false);
        let sparse = export(&mut st, &tmp, true);
        assert_eq!(dense, sparse, "{emod}: sparse ≡ dense");
        if prov.flags == 0 {
            assert_eq!(sha256_hex(&dense), sha256_hex(&source), "{emod}: own-format export = source");
        } else {
            panic!("{emod}: PROVENANCE flags {} — pick a canonical fixture for this gate", prov.flags);
        }
    }
}

#[test]
fn two_batch_file_exports_its_latest_state() {
    let tmp = TempDir::new("export-2batch");
    let mut st = open_fixture(&tmp, "f256-trailer.2batch.emod");
    let dense = export(&mut st, &tmp, false);
    let sparse = export(&mut st, &tmp, true);
    assert_eq!(dense, sparse);
    // Every column in the export reads back as the store's live column (slot i at 192 + i × stride).
    let stride = st.column_len();
    let mut col = vec![0u8; stride];
    for (i, k) in st.column_keys().into_iter().enumerate() {
        st.read_column(k.0, k.1, &mut col).unwrap();
        let o = 192 + i * stride;
        assert_eq!(&dense[o..o + stride], &col[..], "column {k:?}");
    }
    // The base conversion's export is the source, so the second batch must change something.
    assert_ne!(sha256_hex(&dense), sha256_hex(&fixture("f256-trailer.eden.gz")));
}
