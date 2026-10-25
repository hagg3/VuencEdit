//! The post-directory trailer as a model: signs (`SGN1`) and command blocks (`CMB1`).
//!
//! A `.eden` world keeps its signs and command blocks in 16-byte rows tagged `ff ff ff ff` after
//! the real chunk-directory rows, running to EOF (an `.emod` keeps the same bytes in its
//! `SIGN_TRAILER` record). [`Trailer`] parses them into an ordered list of sections:
//!
//! - `SGN1` → [`Sign`]s (120-byte records)
//! - `CMB1` → [`Cmd`]s (528-byte records)
//! - any other magic → its bytes, kept verbatim in its slot
//!
//! **The rule that matters:** an untouched trailer encodes to its original bytes exactly
//! ([`Trailer::encode`] borrows them), and a touched one rebuilds only from the model, every
//! section in its original slot. A trailer this module can't read is **opaque**: kept verbatim,
//! every record edit refused with [`Refusal::Opaque`].
//!
//! A port of Emod's `Classes/WorldTrailer.{h,cpp}`; the rules are `~/emod/docs/eden-file-format.md`
//! "The trailer model" (restated in `TEST WORLDS/eden2026-trailer-plan-2026-10-25.md` §2). Names
//! are Rust-ier; behaviour isn't different, except that the model also refuses a new sign on the
//! bottom face (`a = 2`, which the game never writes) and caps command blocks at [`MAX_CMDS`]
//! (Emod's `CmdTool::MAX_PER_WORLD`, enforced there in the tool).
//!
//! Coordinates are the record's **anchor block in absolute world blocks, file order**: `x`, `y`
//! horizontal, `z` the height. The editor-local conversion lives app-side, in one helper.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;

use crate::emod::TRAILER_MAX;

/// The cap on the encoded trailer (= the `.emod` `SIGN_TRAILER` limit): 6,553 signs with no
/// command blocks.
pub const MAX_BYTES: usize = TRAILER_MAX;
/// Command blocks per world (`db.edengame.net/cmd.html`; Emod's `CmdTool::MAX_PER_WORLD`).
pub const MAX_CMDS: usize = 512;
/// A trailer row: the `ff ff ff ff` tag, then 12 payload bytes.
pub const ROW: usize = 16;
pub const ROW_PAYLOAD: usize = 12;
const TAG: [u8; 4] = [0xff; 4];
pub const SGN1: [u8; 4] = *b"SGN1";
pub const CMB1: [u8; 4] = *b"CMB1";
/// Bytes per `SGN1` / `CMB1` record on disk.
pub const SIGN_LEN: usize = 120;
pub const CMD_LEN: usize = 528;
/// The longest new or edited sign text (the record's 96 bytes hold a NUL).
pub const TEXT_MAX: usize = 95;
/// The longest new or edited script (512 bytes, NUL-terminated).
pub const SCRIPT_MAX: usize = 511;
/// Board colours: a paint byte, 1..=54.
pub const COLOURS: std::ops::RangeInclusive<i32> = 1..=54;

/// A record's anchor block, in the **file's** order: `x`, `y` horizontal, `z` the height (absolute).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

impl Pos {
    pub fn new(x: i32, y: i32, z: i32) -> Pos {
        Pos { x, y, z }
    }
    /// The chunk column holding this block (absolute chunk coordinates).
    pub fn column(self) -> (i32, i32) {
        (self.x.div_euclid(16), self.y.div_euclid(16))
    }
}

/// One 120-byte `SGN1` record, byte for byte (little-endian).
///
/// - `a`: the anchor face — 0 −x, 1 +x, 2 bottom (never written by the game), 3 top, 4 −y, 5 +y
/// - `b`: the board colour, a paint byte 1..=54
/// - `c`: the direction the text faces, a quarter turn — 0 −x, 1 −y, 2 +x, 3 +y
/// - `text`: up to 95 bytes + NUL; bytes after the NUL are kept as read
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sign {
    pub pos: Pos,
    pub a: i32,
    pub b: i32,
    pub c: i32,
    pub text: [u8; 96],
}

/// One 528-byte `CMB1` record. A command block is a steel voxel plus one of these. `flags` is 0
/// in every record seen and its meaning is unknown: kept verbatim, written 0 by new records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cmd {
    pub pos: Pos,
    pub flags: i32,
    pub script: [u8; 512],
}

fn rd32(p: &[u8]) -> u32 {
    u32::from_le_bytes([p[0], p[1], p[2], p[3]])
}
fn rdi(p: &[u8]) -> i32 {
    i32::from_le_bytes([p[0], p[1], p[2], p[3]])
}
fn put32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn puti(v: &mut Vec<u8>, x: i32) {
    v.extend_from_slice(&x.to_le_bytes());
}
/// The bytes before the first NUL.
fn until_nul(b: &[u8]) -> &[u8] {
    &b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())]
}

impl Sign {
    fn read(r: &[u8]) -> Sign {
        let mut text = [0u8; 96];
        text.copy_from_slice(&r[24..SIGN_LEN]);
        Sign { pos: Pos::new(rdi(r), rdi(&r[4..]), rdi(&r[8..])), a: rdi(&r[12..]), b: rdi(&r[16..]), c: rdi(&r[20..]), text }
    }
    fn write(&self, out: &mut Vec<u8>) {
        for v in [self.pos.x, self.pos.y, self.pos.z, self.a, self.b, self.c] {
            puti(out, v);
        }
        out.extend_from_slice(&self.text);
    }
    /// The text up to its NUL, raw (display it lossily).
    pub fn text(&self) -> &[u8] {
        until_nul(&self.text)
    }
}

impl Cmd {
    fn read(r: &[u8]) -> Cmd {
        let mut script = [0u8; 512];
        script.copy_from_slice(&r[16..CMD_LEN]);
        Cmd { pos: Pos::new(rdi(r), rdi(&r[4..]), rdi(&r[8..])), flags: rdi(&r[12..]), script }
    }
    fn write(&self, out: &mut Vec<u8>) {
        for v in [self.pos.x, self.pos.y, self.pos.z, self.flags] {
            puti(out, v);
        }
        out.extend_from_slice(&self.script);
    }
    /// The script up to its NUL, raw.
    pub fn script(&self) -> &[u8] {
        until_nul(&self.script)
    }
}

/// Which record section.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Sign,
    Cmd,
}

impl Kind {
    pub fn magic(self) -> [u8; 4] {
        match self {
            Kind::Sign => SGN1,
            Kind::Cmd => CMB1,
        }
    }
    fn record_len(self) -> usize {
        match self {
            Kind::Sign => SIGN_LEN,
            Kind::Cmd => CMD_LEN,
        }
    }
}

/// Why a record edit was refused (≙ Emod's `TR_FULL` … `TR_BAD`). Nothing changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The encoded trailer would pass [`MAX_BYTES`], or the world already has [`MAX_CMDS`].
    Full,
    /// This trailer couldn't be read: every edit is refused.
    Opaque,
    /// A sign already hangs on that (anchor, face) / a command block on that block (or, for a
    /// sidecar, the trailer already has that section: the trailer wins).
    Exists,
    /// No such record.
    NotFound,
    /// An argument out of range (face, colour, facing, text), or a sidecar that isn't one section.
    Bad,
}

impl Refusal {
    /// The user-facing message (Emod's `resultMessage`).
    pub fn message(self) -> &'static str {
        match self {
            Refusal::Full => "No room for more signs in this world",
            Refusal::Opaque => "This world's signs can't be edited",
            Refusal::Exists => "There is already a sign there",
            Refusal::NotFound => "That sign is gone",
            Refusal::Bad => "That sign can't be written",
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for Refusal {}

#[derive(Clone, Debug)]
enum SectionBody {
    Known(Kind),
    /// An unknown magic: the whole section, wrapper included.
    Raw(Vec<u8>),
}

#[derive(Clone, Debug)]
struct Section {
    magic: [u8; 4],
    body: SectionBody,
    /// The wrapper's third word and the inner version, kept as read.
    w3: u32,
    version: u32,
    /// Emitted at all (a known section created by an edit starts present).
    present: bool,
    /// An edit touched it: emitted only while it holds records.
    edited: bool,
}

/// The record indices anchored on one block, or standing in one column.
#[derive(Clone, Copy, Debug, Default)]
pub struct Records<'a> {
    pub signs: &'a [usize],
    pub cmds: &'a [usize],
}

impl Records<'_> {
    pub fn is_empty(&self) -> bool {
        self.signs.is_empty() && self.cmds.is_empty()
    }
}

#[derive(Clone, Debug, Default)]
struct Index {
    signs: Vec<usize>,
    cmds: Vec<usize>,
}

/// The trailer model. See the module docs.
#[derive(Clone, Debug)]
pub struct Trailer {
    original: Vec<u8>,
    sections: Vec<Section>,
    /// The zero bytes after the last section, verbatim.
    tail: Vec<u8>,
    signs: Vec<Sign>,
    cmds: Vec<Cmd>,
    by_block: HashMap<Pos, Index>,
    by_column: HashMap<(i32, i32), Index>,
    parsed: bool,
    touched: bool,
    why: String,
}

impl Default for Trailer {
    fn default() -> Trailer {
        Trailer::empty()
    }
}

impl Trailer {
    /// No trailer: editable, untouched.
    pub fn empty() -> Trailer {
        Trailer {
            original: Vec::new(),
            sections: Vec::new(),
            tail: Vec::new(),
            signs: Vec::new(),
            cmds: Vec::new(),
            by_block: HashMap::new(),
            by_column: HashMap::new(),
            parsed: true,
            touched: false,
            why: String::new(),
        }
    }

    /// The trailer bytes as captured (`bytes[trailer_start..]`). Always keeps them; check
    /// [`parsed`](Self::parsed) — false means opaque.
    pub fn load(bytes: &[u8]) -> Trailer {
        let mut t = Trailer::empty();
        t.original = bytes.to_vec();
        if let Err(why) = t.parse(bytes) {
            t.sections.clear();
            t.tail.clear();
            t.signs.clear();
            t.cmds.clear();
            t.parsed = false;
            t.why = why;
        }
        t.reindex();
        t
    }

    /// An opaque trailer of `len` bytes (> [`MAX_BYTES`]) that is **not copied**: what [`load`]
    /// would return for it, minus the original bytes. A world's trailer is bounded only by the
    /// file, so a caller that holds the bytes itself (the app's mapping) uses this instead of
    /// copying a region it can never edit. [`encode`](Self::encode) is then empty: such a caller
    /// writes its own copy, which never changes (an opaque trailer refuses every edit).
    ///
    /// [`load`]: Self::load
    pub fn over_cap(len: usize) -> Trailer {
        debug_assert!(len > MAX_BYTES);
        let mut t = Trailer::empty();
        t.parsed = false;
        t.why = format!("{len} bytes, over the {MAX_BYTES}-byte cap");
        t
    }

    fn parse(&mut self, t: &[u8]) -> Result<(), String> {
        if t.is_empty() {
            return Ok(());
        }
        if t.len() > MAX_BYTES {
            return Err(format!("{} bytes, over the {MAX_BYTES}-byte cap", t.len()));
        }
        if !t.len().is_multiple_of(ROW) {
            return Err("not a whole number of 16-byte rows".into());
        }
        let mut p = Vec::with_capacity(t.len() / ROW * ROW_PAYLOAD);
        for (r, row) in t.chunks_exact(ROW).enumerate() {
            if row[..4] != TAG {
                return Err(format!("row {r} is not tagged ff ff ff ff"));
            }
            p.extend_from_slice(&row[4..]);
        }
        let mut i = 0usize;
        while i + 12 <= p.len() {
            if rd32(&p[i..]) == 0 {
                break; // the zero tail from here on
            }
            let inner = rd32(&p[i + 4..]) as usize;
            let w3 = rd32(&p[i + 8..]);
            if (i + 12) as u64 + inner as u64 > p.len() as u64 {
                return Err(format!("section at payload byte {i} runs past the end"));
            }
            let magic: [u8; 4] = p[i..i + 4].try_into().unwrap();
            let kind = match magic {
                SGN1 => Some(Kind::Sign),
                CMB1 => Some(Kind::Cmd),
                _ => None,
            };
            let mut s = Section { magic, body: SectionBody::Raw(Vec::new()), w3, version: 0, present: true, edited: false };
            if let Some(kind) = kind {
                let name = String::from_utf8_lossy(&magic).into_owned();
                if self.section_index(kind).is_some() {
                    return Err(format!("a second {name} section"));
                }
                if inner < 12 || p[i + 12..i + 16] != magic {
                    return Err("a known section without its inner header".into());
                }
                s.version = rd32(&p[i + 16..]);
                let count = rd32(&p[i + 20..]) as u64;
                let rs = kind.record_len();
                if (inner - 12) as u64 != count * rs as u64 {
                    return Err(format!("{name}: {} body bytes for {count} records of {rs}", inner - 12));
                }
                let body = &p[i + 24..i + 12 + inner];
                match kind {
                    Kind::Sign => self.signs = body.chunks_exact(rs).map(Sign::read).collect(),
                    Kind::Cmd => self.cmds = body.chunks_exact(rs).map(Cmd::read).collect(),
                }
                s.body = SectionBody::Known(kind);
            } else {
                s.body = SectionBody::Raw(p[i..i + 12 + inner].to_vec());
            }
            self.sections.push(s);
            i += 12 + inner;
        }
        self.tail = p[i..].to_vec();
        if self.tail.iter().any(|&c| c != 0) {
            return Err("non-zero bytes after the last section".into());
        }
        Ok(())
    }

    /// False ⇒ opaque: [`encode`](Self::encode) is the original bytes and every edit is refused.
    pub fn parsed(&self) -> bool {
        self.parsed
    }
    /// Why it's opaque (`""` when parsed).
    pub fn why(&self) -> &str {
        &self.why
    }
    /// Changed since [`load`](Self::load)/[`empty`](Self::empty)/[`mark_saved`](Self::mark_saved)
    /// (≙ Emod's `dirty()`; the app's `DirtyState` tracks its own save horizons).
    pub fn is_touched(&self) -> bool {
        self.touched
    }

    /// What the next save writes: the original bytes while untouched (or opaque), the rebuild
    /// once touched. Empty = no trailer.
    pub fn encode(&self) -> Cow<'_, [u8]> {
        if self.touched && self.parsed {
            Cow::Owned(self.rebuild())
        } else {
            Cow::Borrowed(&self.original)
        }
    }

    fn count(&self, kind: Kind) -> usize {
        match kind {
            Kind::Sign => self.signs.len(),
            Kind::Cmd => self.cmds.len(),
        }
    }

    /// Whether a known section is emitted (rule 4: an edit-emptied one is left out).
    fn emitted(&self, s: &Section, kind: Kind) -> bool {
        s.present && !(s.edited && self.count(kind) == 0)
    }

    fn payload_len(&self) -> usize {
        self.sections
            .iter()
            .map(|s| match &s.body {
                SectionBody::Raw(raw) => raw.len(),
                SectionBody::Known(k) if self.emitted(s, *k) => 24 + self.count(*k) * k.record_len(),
                SectionBody::Known(_) => 0,
            })
            .sum()
    }

    fn rows_len(payload: usize) -> usize {
        payload.div_ceil(ROW_PAYLOAD) * ROW
    }

    fn rebuilt_len(&self) -> usize {
        match self.payload_len() {
            0 => 0,
            n => Self::rows_len(n + self.tail.len()),
        }
    }

    /// The length [`encode`](Self::encode) returns.
    pub fn encoded_len(&self) -> usize {
        if self.touched && self.parsed {
            self.rebuilt_len()
        } else {
            self.original.len()
        }
    }

    /// Serialise from the model regardless of touched (the parse → serialise gate). Opaque ⇒ the
    /// original bytes.
    pub fn rebuild(&self) -> Vec<u8> {
        if !self.parsed {
            return self.original.clone();
        }
        let mut p = Vec::with_capacity(self.payload_len() + self.tail.len());
        for s in &self.sections {
            let kind = match &s.body {
                SectionBody::Raw(raw) => {
                    p.extend_from_slice(raw);
                    continue;
                }
                SectionBody::Known(k) => *k,
            };
            if !self.emitted(s, kind) {
                continue;
            }
            let count = self.count(kind);
            p.extend_from_slice(&s.magic);
            put32(&mut p, (12 + count * kind.record_len()) as u32);
            put32(&mut p, s.w3);
            p.extend_from_slice(&s.magic);
            put32(&mut p, s.version);
            put32(&mut p, count as u32);
            match kind {
                Kind::Sign => self.signs.iter().for_each(|r| r.write(&mut p)),
                Kind::Cmd => self.cmds.iter().for_each(|r| r.write(&mut p)),
            }
        }
        if p.is_empty() {
            return Vec::new(); // nothing left: no trailer at all
        }
        p.extend_from_slice(&self.tail);
        p.resize(p.len().div_ceil(ROW_PAYLOAD) * ROW_PAYLOAD, 0);
        let mut out = Vec::with_capacity(p.len() / ROW_PAYLOAD * ROW);
        for chunk in p.chunks_exact(ROW_PAYLOAD) {
            out.extend_from_slice(&TAG);
            out.extend_from_slice(chunk);
        }
        out
    }

    /// After a save landed: the encoded bytes become the original, and the trailer is untouched.
    pub fn mark_saved(&mut self) {
        if !self.touched {
            return;
        }
        self.original = self.rebuild();
        // What was just written no longer holds the sections an edit emptied: forget them, so a
        // rebuild of this untouched state is the written bytes again.
        let (ns, nc) = (self.signs.len(), self.cmds.len());
        for s in &mut self.sections {
            if let SectionBody::Known(k) = s.body {
                let count = if k == Kind::Sign { ns } else { nc };
                if s.edited && count == 0 {
                    s.present = false;
                }
                s.edited = false;
            }
        }
        if self.original.is_empty() {
            self.tail.clear();
        }
        self.touched = false;
    }

    /// The section magics in on-disk order, a known section left out while it isn't emitted.
    pub fn section_order(&self) -> Vec<[u8; 4]> {
        self.sections
            .iter()
            .filter(|s| match &s.body {
                SectionBody::Raw(_) => true,
                SectionBody::Known(k) => self.emitted(s, *k),
            })
            .map(|s| s.magic)
            .collect()
    }

    /// A known section's `version` word, if the trailer has that section.
    pub fn section_version(&self, kind: Kind) -> Option<u32> {
        self.section_index(kind).map(|i| self.sections[i].version)
    }

    // ---- records

    pub fn signs(&self) -> &[Sign] {
        &self.signs
    }
    pub fn cmds(&self) -> &[Cmd] {
        &self.cmds
    }

    /// The sign on `anchor`'s face `a`, if any.
    pub fn find_sign(&self, anchor: Pos, a: i32) -> Option<usize> {
        self.by_block.get(&anchor)?.signs.iter().copied().find(|&i| self.signs[i].a == a)
    }
    /// The command block on `block`, if any.
    pub fn find_cmd(&self, block: Pos) -> Option<usize> {
        self.by_block.get(&block)?.cmds.first().copied()
    }
    /// Every sign (any face) and command block anchored on `block`, in record order. O(1).
    pub fn anchored_on(&self, block: Pos) -> Records<'_> {
        self.by_block.get(&block).map_or_else(Records::default, |ix| Records { signs: &ix.signs, cmds: &ix.cmds })
    }
    /// Every record whose anchor stands in chunk column `(cx, cy)` (absolute chunk coordinates),
    /// in record order.
    pub fn in_column(&self, cx: i32, cy: i32) -> Records<'_> {
        self.by_column.get(&(cx, cy)).map_or_else(Records::default, |ix| Records { signs: &ix.signs, cmds: &ix.cmds })
    }

    /// A new sign (rules 6–8): `a ∈ {0,1,3,4,5}`, `b ∈ 1..=54`, `c ∈ 0..=3`, `text` printable
    /// ASCII ≤ 95 bytes. Appended; returns its index.
    pub fn add_sign(&mut self, anchor: Pos, a: i32, b: i32, c: i32, text: &[u8]) -> Result<usize, Refusal> {
        self.editable()?;
        if !matches!(a, 0 | 1 | 3 | 4 | 5) || !COLOURS.contains(&b) || !(0..=3).contains(&c) {
            return Err(Refusal::Bad);
        }
        let text = sign_text(text)?;
        let i = self.signs.len();
        self.insert_sign_at(i, Sign { pos: anchor, a, b, c, text })?;
        Ok(i)
    }

    /// Insert a sign **as is** at index `i` (undo, paste carry, a server's signs): only the
    /// one-per-(anchor, face) rule and the cap apply.
    pub fn insert_sign_at(&mut self, i: usize, sign: Sign) -> Result<(), Refusal> {
        self.editable()?;
        if i > self.signs.len() {
            return Err(Refusal::NotFound);
        }
        if self.find_sign(sign.pos, sign.a).is_some() {
            return Err(Refusal::Exists);
        }
        let append = i == self.signs.len();
        self.signs.insert(i, sign);
        if let Err(e) = self.commit(Kind::Sign) {
            self.signs.remove(i);
            return Err(e);
        }
        if append {
            self.index_one(Kind::Sign, i);
        } else {
            self.reindex();
        }
        Ok(())
    }

    /// Remove sign `i`, returning it.
    pub fn remove_sign(&mut self, i: usize) -> Result<Sign, Refusal> {
        self.editable()?;
        if i >= self.signs.len() {
            return Err(Refusal::NotFound);
        }
        let s = self.signs.remove(i);
        self.touch(Kind::Sign);
        self.reindex();
        Ok(s)
    }

    /// Replace sign `i` **as is** (undo of a text/colour edit restores the raw record), returning
    /// the old one. The new record may not collide with another sign's (anchor, face).
    pub fn replace_sign(&mut self, i: usize, sign: Sign) -> Result<Sign, Refusal> {
        self.editable()?;
        if i >= self.signs.len() {
            return Err(Refusal::NotFound);
        }
        if self.find_sign(sign.pos, sign.a).is_some_and(|j| j != i) {
            return Err(Refusal::Exists);
        }
        let moved = self.signs[i].pos != sign.pos;
        let old = std::mem::replace(&mut self.signs[i], sign);
        self.touch(Kind::Sign);
        if moved {
            self.reindex();
        }
        Ok(old)
    }

    /// Set sign `i`'s text: printable ASCII ≤ 95 bytes, zero-padded.
    pub fn set_sign_text(&mut self, i: usize, text: &[u8]) -> Result<(), Refusal> {
        self.editable()?;
        if i >= self.signs.len() {
            return Err(Refusal::NotFound);
        }
        self.signs[i].text = sign_text(text)?;
        self.touch(Kind::Sign);
        Ok(())
    }

    /// Set sign `i`'s board colour (a paint byte, 1..=54).
    pub fn set_sign_colour(&mut self, i: usize, b: i32) -> Result<(), Refusal> {
        self.editable()?;
        if i >= self.signs.len() {
            return Err(Refusal::NotFound);
        }
        if !COLOURS.contains(&b) {
            return Err(Refusal::Bad);
        }
        self.signs[i].b = b;
        self.touch(Kind::Sign);
        Ok(())
    }

    /// A new command block on `block` with `script` (≤ 511 bytes, no NUL; empty is fine — an
    /// empty script keeps the block). Appended; returns its index.
    pub fn add_cmd(&mut self, block: Pos, script: &[u8]) -> Result<usize, Refusal> {
        self.editable()?;
        let script = cmd_script(script)?;
        let i = self.cmds.len();
        self.insert_cmd_at(i, Cmd { pos: block, flags: 0, script })?;
        Ok(i)
    }

    /// Insert a command block **as is** at index `i`: one per block, [`MAX_CMDS`] and the byte cap.
    pub fn insert_cmd_at(&mut self, i: usize, cmd: Cmd) -> Result<(), Refusal> {
        self.editable()?;
        if i > self.cmds.len() {
            return Err(Refusal::NotFound);
        }
        if self.find_cmd(cmd.pos).is_some() {
            return Err(Refusal::Exists);
        }
        if self.cmds.len() >= MAX_CMDS {
            return Err(Refusal::Full);
        }
        let append = i == self.cmds.len();
        self.cmds.insert(i, cmd);
        if let Err(e) = self.commit(Kind::Cmd) {
            self.cmds.remove(i);
            return Err(e);
        }
        if append {
            self.index_one(Kind::Cmd, i);
        } else {
            self.reindex();
        }
        Ok(())
    }

    /// Remove command block `i`, returning it.
    pub fn remove_cmd(&mut self, i: usize) -> Result<Cmd, Refusal> {
        self.editable()?;
        if i >= self.cmds.len() {
            return Err(Refusal::NotFound);
        }
        let c = self.cmds.remove(i);
        self.touch(Kind::Cmd);
        self.reindex();
        Ok(c)
    }

    /// Replace command block `i` **as is**, returning the old one.
    pub fn replace_cmd(&mut self, i: usize, cmd: Cmd) -> Result<Cmd, Refusal> {
        self.editable()?;
        if i >= self.cmds.len() {
            return Err(Refusal::NotFound);
        }
        if self.find_cmd(cmd.pos).is_some_and(|j| j != i) {
            return Err(Refusal::Exists);
        }
        let moved = self.cmds[i].pos != cmd.pos;
        let old = std::mem::replace(&mut self.cmds[i], cmd);
        self.touch(Kind::Cmd);
        if moved {
            self.reindex();
        }
        Ok(old)
    }

    /// Set command block `i`'s script (≤ 511 bytes, no NUL), zero-padded.
    pub fn set_cmd_script(&mut self, i: usize, script: &[u8]) -> Result<(), Refusal> {
        self.editable()?;
        if i >= self.cmds.len() {
            return Err(Refusal::NotFound);
        }
        self.cmds[i].script = cmd_script(script)?;
        self.touch(Kind::Cmd);
        Ok(())
    }

    /// Adopt a 2026-game sidecar (`signs_<world>.eden.dat` / `cmd_<world>.eden.dat`): one bare
    /// section, `MAGIC | u32 version | u32 count` + records, no wrapper and no row tags. Adopted
    /// only when the trailer has no records of that kind yet (the trailer wins: `Exists`); the
    /// trailer is then touched so the next save writes it in. An empty sidecar is `Ok` and
    /// changes nothing. Returns the sidecar's kind.
    pub fn adopt_sidecar(&mut self, bare: &[u8]) -> Result<Kind, Refusal> {
        self.editable()?;
        if bare.len() < 12 {
            return Err(Refusal::Bad);
        }
        let kind = match bare[..4] {
            [b'S', b'G', b'N', b'1'] => Kind::Sign,
            [b'C', b'M', b'B', b'1'] => Kind::Cmd,
            _ => return Err(Refusal::Bad),
        };
        let (version, count) = (rd32(&bare[4..]), rd32(&bare[8..]) as u64);
        if bare.len() as u64 != 12 + count * kind.record_len() as u64 {
            return Err(Refusal::Bad);
        }
        if self.section_index(kind).is_some_and(|i| self.sections[i].present) && self.count(kind) > 0 {
            return Err(Refusal::Exists);
        }
        if count == 0 {
            return Ok(kind);
        }
        if kind == Kind::Cmd && count as usize > MAX_CMDS {
            return Err(Refusal::Full);
        }
        let body = &bare[12..];
        let snapshot = (self.sections.clone(), self.touched);
        match kind {
            Kind::Sign => self.signs = body.chunks_exact(SIGN_LEN).map(Sign::read).collect(),
            Kind::Cmd => self.cmds = body.chunks_exact(CMD_LEN).map(Cmd::read).collect(),
        }
        self.touch(kind);
        let at = self.section_index(kind).unwrap();
        self.sections[at].version = version;
        if self.rebuilt_len() > MAX_BYTES {
            match kind {
                Kind::Sign => self.signs.clear(),
                Kind::Cmd => self.cmds.clear(),
            }
            (self.sections, self.touched) = snapshot;
            self.reindex();
            return Err(Refusal::Full);
        }
        self.reindex();
        Ok(kind)
    }

    // ---- internals

    fn editable(&self) -> Result<(), Refusal> {
        if self.parsed {
            Ok(())
        } else {
            Err(Refusal::Opaque)
        }
    }

    fn section_index(&self, kind: Kind) -> Option<usize> {
        self.sections.iter().position(|s| matches!(s.body, SectionBody::Known(k) if k == kind))
    }

    /// The section of `kind`, created if missing. The 2026 game writes `CMB1` first, then `SGN1`:
    /// a new `CMB1` goes in front of an existing `SGN1`, a new `SGN1` right after an existing
    /// `CMB1`, anything else at the end.
    fn section_for(&mut self, kind: Kind) -> usize {
        if let Some(i) = self.section_index(kind) {
            return i;
        }
        let mut at = self.sections.len();
        for (i, s) in self.sections.iter().enumerate() {
            match (kind, &s.body) {
                (Kind::Cmd, SectionBody::Known(Kind::Sign)) => {
                    at = i;
                    break;
                }
                (Kind::Sign, SectionBody::Known(Kind::Cmd)) => {
                    at = i + 1;
                    break;
                }
                _ => {}
            }
        }
        let s = Section { magic: kind.magic(), body: SectionBody::Known(kind), w3: 0, version: 1, present: true, edited: true };
        self.sections.insert(at, s);
        at
    }

    fn touch(&mut self, kind: Kind) {
        let i = self.section_for(kind);
        self.sections[i].present = true;
        self.sections[i].edited = true;
        self.touched = true;
    }

    /// Touch `kind` after a record was added; if the result is over the cap, put the section
    /// state back and refuse (the caller removes the record).
    fn commit(&mut self, kind: Kind) -> Result<(), Refusal> {
        let snapshot = (self.sections.clone(), self.touched);
        self.touch(kind);
        if self.rebuilt_len() > MAX_BYTES {
            (self.sections, self.touched) = snapshot;
            return Err(Refusal::Full);
        }
        Ok(())
    }

    fn index_one(&mut self, kind: Kind, i: usize) {
        let pos = match kind {
            Kind::Sign => self.signs[i].pos,
            Kind::Cmd => self.cmds[i].pos,
        };
        for ix in [self.by_block.entry(pos).or_default(), self.by_column.entry(pos.column()).or_default()] {
            match kind {
                Kind::Sign => ix.signs.push(i),
                Kind::Cmd => ix.cmds.push(i),
            }
        }
    }

    fn reindex(&mut self) {
        self.by_block.clear();
        self.by_column.clear();
        for i in 0..self.signs.len() {
            self.index_one(Kind::Sign, i);
        }
        for i in 0..self.cmds.len() {
            self.index_one(Kind::Cmd, i);
        }
    }
}

/// A new or edited sign text: printable ASCII (0x20..=0x7e), ≤ 95 bytes, zero-padded to 96.
fn sign_text(text: &[u8]) -> Result<[u8; 96], Refusal> {
    if text.len() > TEXT_MAX || text.iter().any(|&c| !(0x20..=0x7e).contains(&c)) {
        return Err(Refusal::Bad);
    }
    let mut out = [0u8; 96];
    out[..text.len()].copy_from_slice(text);
    Ok(out)
}

/// A new or edited script: ≤ 511 bytes and no NUL (Emod's rule; newlines are allowed),
/// zero-padded to 512.
fn cmd_script(script: &[u8]) -> Result<[u8; 512], Refusal> {
    if script.len() > SCRIPT_MAX || script.contains(&0) {
        return Err(Refusal::Bad);
    }
    let mut out = [0u8; 512];
    out[..script.len()].copy_from_slice(script);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- synthetic builders (made-up data only: this crate is in the public mirror)

    /// Wrap a payload in tagged rows, zero-padding to a whole row.
    fn rows(payload: &[u8]) -> Vec<u8> {
        let mut p = payload.to_vec();
        p.resize(p.len().div_ceil(ROW_PAYLOAD) * ROW_PAYLOAD, 0);
        p.chunks_exact(ROW_PAYLOAD).flat_map(|c| TAG.iter().chain(c).copied()).collect()
    }
    fn sign(x: i32, y: i32, z: i32, a: i32, b: i32, c: i32, text: &[u8]) -> Sign {
        let mut t = [0u8; 96];
        t[..text.len()].copy_from_slice(text);
        Sign { pos: Pos::new(x, y, z), a, b, c, text: t }
    }
    fn cmd(x: i32, y: i32, z: i32, script: &[u8]) -> Cmd {
        let mut s = [0u8; 512];
        s[..script.len()].copy_from_slice(script);
        Cmd { pos: Pos::new(x, y, z), flags: 0, script: s }
    }
    /// A bare section (`MAGIC | version | count` + records), i.e. a sidecar file.
    fn bare_signs(version: u32, signs: &[Sign]) -> Vec<u8> {
        let mut v = SGN1.to_vec();
        put32(&mut v, version);
        put32(&mut v, signs.len() as u32);
        signs.iter().for_each(|s| s.write(&mut v));
        v
    }
    fn bare_cmds(version: u32, cmds: &[Cmd]) -> Vec<u8> {
        let mut v = CMB1.to_vec();
        put32(&mut v, version);
        put32(&mut v, cmds.len() as u32);
        cmds.iter().for_each(|c| c.write(&mut v));
        v
    }
    /// A wrapped section: `MAGIC | inner_len | w3` + inner.
    fn wrapped(magic: [u8; 4], w3: u32, inner: &[u8]) -> Vec<u8> {
        let mut v = magic.to_vec();
        put32(&mut v, inner.len() as u32);
        put32(&mut v, w3);
        v.extend_from_slice(inner);
        v
    }

    /// One sign, shaped like the real one-sign worlds (a 192-byte trailer: 132 B of section plus
    /// a zero tail of 12 rows' worth), with made-up values.
    fn one_sign_trailer() -> Vec<u8> {
        let mut p = wrapped(SGN1, 0, &bare_signs(1, &[sign(65_001, 64_002, 40, 4, 9, 1, b"hello")]));
        p.resize(12 * ROW_PAYLOAD, 0);
        rows(&p)
    }

    /// `CMB1` + an unknown `XYZ1` + `SGN1`, with odd `w3`/version words and a zero tail.
    fn three_section_trailer() -> Vec<u8> {
        let mut p = wrapped(CMB1, 7, &bare_cmds(3, &[cmd(100, 200, 30, b"SAY hi"), cmd(101, 200, 30, b"")]));
        p.extend(wrapped(*b"XYZ1", 0, b"opaque-ish payload 123"));
        p.extend(wrapped(
            SGN1,
            0,
            &bare_signs(2, &[sign(100, 200, 31, 3, 2, 0, b"top"), sign(-5, 17, 0, 0, 54, 3, b"west"), sign(100, 200, 30, 1, 9, 2, b"")]),
        ));
        p.extend([0u8; 30]);
        rows(&p)
    }

    #[test]
    fn empty_is_no_trailer() {
        let t = Trailer::load(&[]);
        assert!(t.parsed() && !t.is_touched());
        assert!(t.encode().is_empty() && t.rebuild().is_empty() && t.encoded_len() == 0);
        assert!(Trailer::empty().section_order().is_empty());
    }

    /// (i) the one-sign shape parses and re-encodes byte-identical.
    #[test]
    fn one_sign_round_trips() {
        let b = one_sign_trailer();
        assert_eq!(b.len(), 192);
        let t = Trailer::load(&b);
        assert!(t.parsed(), "{}", t.why());
        assert_eq!(t.signs().len(), 1);
        let s = &t.signs()[0];
        assert_eq!((s.pos, s.a, s.b, s.c), (Pos::new(65_001, 64_002, 40), 4, 9, 1));
        assert_eq!(s.text(), b"hello");
        assert!(matches!(t.encode(), Cow::Borrowed(_)), "untouched encode borrows the original");
        assert_eq!(&*t.encode(), &b[..]);
        assert_eq!(t.rebuild(), b, "the parse → serialise gate");
        assert_eq!(t.section_version(Kind::Sign), Some(1));
    }

    /// (ii) sections in their slots, w3/version kept, remove + re-insert is byte-identical,
    /// emptying SGN1 drops it and keeps XYZ1 in place.
    #[test]
    fn three_sections_keep_their_slots() {
        let b = three_section_trailer();
        let mut t = Trailer::load(&b);
        assert!(t.parsed(), "{}", t.why());
        assert_eq!((t.cmds().len(), t.signs().len()), (2, 3));
        assert_eq!(t.section_order(), vec![CMB1, *b"XYZ1", SGN1]);
        assert_eq!(t.rebuild(), b);

        let removed = t.remove_sign(1).unwrap();
        assert!(t.is_touched());
        assert_eq!(removed.text(), b"west");
        t.insert_sign_at(1, removed).unwrap();
        assert_eq!(&*t.encode(), &b[..], "remove + re-insert at the same index ≡ original");
        let c = t.remove_cmd(0).unwrap();
        t.insert_cmd_at(0, c).unwrap();
        assert_eq!(&*t.encode(), &b[..]);

        while !t.signs().is_empty() {
            t.remove_sign(0).unwrap();
        }
        assert_eq!(t.section_order(), vec![CMB1, *b"XYZ1"]);
        let re = Trailer::load(&t.encode());
        assert!(re.parsed(), "{}", re.why());
        assert_eq!(re.section_order(), vec![CMB1, *b"XYZ1"]);
        assert_eq!(re.cmds(), t.cmds());
        assert!(re.signs().is_empty());
        assert_eq!(re.section_version(Kind::Cmd), Some(3), "version kept as read");

        // Everything gone but the raw section: it alone is the trailer.
        while !t.cmds().is_empty() {
            t.remove_cmd(0).unwrap();
        }
        assert_eq!(t.section_order(), vec![*b"XYZ1"]);
        assert_eq!(t.encoded_len(), t.encode().len());
    }

    /// An untouched empty section stays; an edit that empties one drops it.
    #[test]
    fn untouched_empty_section_stays() {
        let mut p = wrapped(SGN1, 0, &bare_signs(1, &[]));
        p.extend(wrapped(CMB1, 0, &bare_cmds(1, &[cmd(1, 2, 3, b"x")])));
        let b = rows(&p);
        let mut t = Trailer::load(&b);
        assert!(t.parsed(), "{}", t.why());
        assert_eq!(t.rebuild(), b);
        t.set_cmd_script(0, b"y").unwrap();
        assert_eq!(t.section_order(), vec![SGN1, CMB1], "untouched empty SGN1 kept in its slot");
        t.remove_cmd(0).unwrap();
        assert_eq!(t.section_order(), vec![SGN1]);
        assert_eq!(Trailer::load(&t.encode()).section_order(), vec![SGN1]);
    }

    /// (iii) every opaque case: encode = original, every edit refused.
    #[test]
    fn opaque_cases() {
        let good = three_section_trailer();
        let mut untagged = good.clone();
        untagged[16] = 0;
        let mut bad_count = good.clone();
        bad_count[ROW + 4 + 8] ^= 1; // CMB1's inner count word: payload byte 20 = row 1, byte 8
        let second_sgn = {
            let mut p = wrapped(SGN1, 0, &bare_signs(1, &[sign(1, 1, 1, 3, 2, 0, b"a")]));
            p.extend(wrapped(SGN1, 0, &bare_signs(1, &[sign(2, 1, 1, 3, 2, 0, b"b")])));
            rows(&p)
        };
        let second_cmb = {
            let mut p = wrapped(CMB1, 0, &bare_cmds(1, &[]));
            p.extend(wrapped(CMB1, 0, &bare_cmds(1, &[])));
            rows(&p)
        };
        let nonzero_tail = {
            let mut p = wrapped(SGN1, 0, &bare_signs(1, &[]));
            p.extend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7]);
            rows(&p)
        };
        let no_inner = rows(&wrapped(SGN1, 0, b"XXXX\x01\0\0\0\0\0\0\0"));
        let past_end = rows(&{
            let mut p = SGN1.to_vec();
            put32(&mut p, 10_000);
            put32(&mut p, 0);
            p
        });
        let ragged = good[..good.len() - 3].to_vec();
        let huge = rows(&wrapped(*b"BIG1", 0, &vec![1u8; MAX_BYTES]));
        for (name, b) in [
            ("untagged row", untagged),
            ("count disagrees", bad_count),
            ("second SGN1", second_sgn),
            ("second CMB1", second_cmb),
            ("non-zero tail", nonzero_tail),
            ("no inner header", no_inner),
            ("runs past the end", past_end),
            ("partial row", ragged),
            ("over 1 MiB", huge),
        ] {
            let mut t = Trailer::load(&b);
            assert!(!t.parsed(), "{name} must be opaque");
            assert!(!t.why().is_empty(), "{name}: a reason");
            assert_eq!(&*t.encode(), &b[..], "{name}: encode = original");
            assert_eq!(t.rebuild(), b, "{name}: rebuild = original");
            assert_eq!(t.encoded_len(), b.len());
            assert!(t.signs().is_empty() && t.cmds().is_empty());
            let p = Pos::new(1, 2, 3);
            assert_eq!(t.add_sign(p, 3, 2, 0, b"x"), Err(Refusal::Opaque), "{name}");
            assert_eq!(t.add_cmd(p, b""), Err(Refusal::Opaque));
            assert_eq!(t.insert_sign_at(0, sign(1, 2, 3, 3, 2, 0, b"")), Err(Refusal::Opaque));
            assert_eq!(t.remove_sign(0), Err(Refusal::Opaque));
            assert_eq!(t.remove_cmd(0), Err(Refusal::Opaque));
            assert_eq!(t.set_sign_text(0, b"x"), Err(Refusal::Opaque));
            assert_eq!(t.set_sign_colour(0, 3), Err(Refusal::Opaque));
            assert_eq!(t.set_cmd_script(0, b"x"), Err(Refusal::Opaque));
            assert_eq!(t.adopt_sidecar(&bare_signs(1, &[])), Err(Refusal::Opaque));
            assert!(t.anchored_on(p).is_empty());
            assert!(!t.is_touched());
        }
    }

    /// `over_cap`: opaque like a loaded over-cap trailer, without holding its bytes.
    #[test]
    fn over_cap_is_opaque_without_a_copy() {
        let mut t = Trailer::over_cap(MAX_BYTES + ROW);
        assert!(!t.parsed());
        assert!(t.why().contains("over the"));
        assert!(t.encode().is_empty() && t.encoded_len() == 0);
        assert_eq!(t.add_sign(Pos::new(1, 2, 3), 3, 2, 0, b"x"), Err(Refusal::Opaque));
        assert_eq!(t.adopt_sidecar(&bare_signs(1, &[])), Err(Refusal::Opaque));
        assert!(!t.is_touched());
    }

    /// (iv) fill to the last sign that fits; the next is Full and changes nothing.
    #[test]
    fn cap_refuses_the_sign_that_does_not_fit() {
        let mut t = Trailer::empty();
        let mut n = 0;
        let err = loop {
            match t.add_sign(Pos::new(n, 0, 10), 3, 2, 0, b"x") {
                Ok(_) => n += 1,
                Err(e) => break e,
            }
        };
        assert_eq!(err, Refusal::Full);
        assert_eq!(n, 6553, "(786,432 − 24) / 120");
        assert!(t.encoded_len() <= MAX_BYTES);
        let before = t.encode().into_owned();
        assert_eq!(before.len(), t.encoded_len());
        assert_eq!(t.add_sign(Pos::new(-1, 0, 10), 3, 2, 0, b"x"), Err(Refusal::Full));
        assert_eq!(t.add_cmd(Pos::new(0, 0, 0), b""), Err(Refusal::Full), "a command block is bigger still");
        assert_eq!(t.signs().len(), 6553);
        assert!(t.find_sign(Pos::new(-1, 0, 10), 3).is_none(), "the refused sign is not indexed");
        assert_eq!(t.encode().into_owned(), before);
        let re = Trailer::load(&before);
        assert!(re.parsed(), "{}", re.why());
        assert_eq!(re.signs().len(), 6553);
    }

    #[test]
    fn command_block_cap() {
        let mut t = Trailer::empty();
        for i in 0..MAX_CMDS as i32 {
            t.add_cmd(Pos::new(i, 0, 0), b"").unwrap();
        }
        assert_eq!(t.add_cmd(Pos::new(-1, 0, 0), b""), Err(Refusal::Full));
        let c = t.remove_cmd(5).unwrap();
        t.insert_cmd_at(5, c).unwrap();
        assert_eq!(t.cmds().len(), MAX_CMDS);
    }

    /// (v) both sidecars adopt into an empty trailer, CMB1 first whatever the adoption order.
    #[test]
    fn adopt_sidecars_into_an_empty_trailer() {
        let signs: Vec<Sign> = (0..14).map(|i| sign(10 + i, 20, 5, 3, 2, i % 4, b"s")).collect();
        let cmds: Vec<Cmd> = (0..4).map(|i| cmd(30 + i, 20, 5, b"SAY x")).collect();
        let mut t = Trailer::empty();
        assert_eq!(t.adopt_sidecar(&bare_signs(1, &signs)), Ok(Kind::Sign));
        assert_eq!(t.adopt_sidecar(&bare_cmds(1, &cmds)), Ok(Kind::Cmd));
        assert!(t.is_touched());
        assert_eq!((t.cmds().len(), t.signs().len()), (4, 14));
        assert_eq!(t.section_order(), vec![CMB1, SGN1]);
        let re = Trailer::load(&t.encode());
        assert!(re.parsed(), "{}", re.why());
        assert_eq!(re.section_order(), vec![CMB1, SGN1]);
        assert_eq!((re.cmds(), re.signs()), (&cmds[..], &signs[..]));
        assert_eq!(re.find_cmd(Pos::new(31, 20, 5)), Some(1));

        // The trailer wins; a malformed sidecar is Bad; an empty one is a no-op.
        assert_eq!(t.adopt_sidecar(&bare_signs(1, &signs[..1])), Err(Refusal::Exists));
        let mut short = bare_cmds(1, &cmds);
        short.pop();
        assert_eq!(Trailer::empty().adopt_sidecar(&short), Err(Refusal::Bad));
        assert_eq!(Trailer::empty().adopt_sidecar(b"XYZ1\0\0\0\0\0\0\0\0"), Err(Refusal::Bad));
        let mut e = Trailer::empty();
        assert_eq!(e.adopt_sidecar(&bare_signs(1, &[])), Ok(Kind::Sign));
        assert!(!e.is_touched() && e.encode().is_empty());
    }

    #[test]
    fn adopt_into_a_trailer_with_the_other_kind() {
        let mut t = Trailer::load(&rows(&wrapped(SGN1, 0, &bare_signs(1, &[sign(1, 1, 1, 3, 2, 0, b"a")]))));
        t.adopt_sidecar(&bare_cmds(6, &[cmd(9, 9, 9, b"")])).unwrap();
        assert_eq!(t.section_order(), vec![CMB1, SGN1], "a new CMB1 goes in front of SGN1");
        assert_eq!(t.section_version(Kind::Cmd), Some(6), "the sidecar's version is kept");
    }

    #[test]
    fn new_sign_validation() {
        let mut t = Trailer::empty();
        let p = Pos::new(1, 2, 3);
        assert_eq!(t.add_sign(p, 2, 2, 0, b"x"), Err(Refusal::Bad), "never the bottom face");
        assert_eq!(t.add_sign(p, 6, 2, 0, b"x"), Err(Refusal::Bad));
        assert_eq!(t.add_sign(p, 3, 0, 0, b"x"), Err(Refusal::Bad));
        assert_eq!(t.add_sign(p, 3, 55, 0, b"x"), Err(Refusal::Bad));
        assert_eq!(t.add_sign(p, 3, 2, 4, b"x"), Err(Refusal::Bad));
        assert_eq!(t.add_sign(p, 3, 2, 0, b"tab\there"), Err(Refusal::Bad));
        assert_eq!(t.add_sign(p, 3, 2, 0, &[b'a'; 96]), Err(Refusal::Bad));
        assert!(!t.is_touched(), "refusals change nothing");
        assert_eq!(t.add_sign(p, 3, 2, 0, &[b'a'; 95]), Ok(0));
        assert_eq!(t.add_sign(p, 3, 5, 1, b"again"), Err(Refusal::Exists), "one sign per (anchor, face)");
        assert_eq!(t.add_sign(p, 4, 5, 1, b"side"), Ok(1));
        assert_eq!(t.add_sign(Pos::new(1, 2, 4), 0, 54, 3, b""), Ok(2));
        assert_eq!(t.set_sign_colour(0, 0), Err(Refusal::Bad));
        assert_eq!(t.set_sign_colour(9, 3), Err(Refusal::NotFound));
        assert_eq!(t.remove_sign(9), Err(Refusal::NotFound));
        assert_eq!(t.insert_sign_at(9, sign(0, 0, 0, 3, 2, 0, b"")), Err(Refusal::NotFound));
    }

    #[test]
    fn scripts_and_texts() {
        let mut t = Trailer::empty();
        let p = Pos::new(-17, 33, 70);
        assert_eq!(t.add_cmd(p, b""), Ok(0), "an empty script keeps the block");
        assert_eq!(t.add_cmd(p, b"x"), Err(Refusal::Exists), "one command block per block");
        assert_eq!(t.set_cmd_script(0, &[b'a'; 512]), Err(Refusal::Bad));
        assert_eq!(t.set_cmd_script(0, b"a\0b"), Err(Refusal::Bad));
        t.set_cmd_script(0, b"LINE 1\nLINE 2").unwrap();
        assert_eq!(t.cmds()[0].script(), b"LINE 1\nLINE 2");
        t.set_cmd_script(0, &[b'z'; 511]).unwrap();
        t.set_cmd_script(0, b"short").unwrap();
        assert!(t.cmds()[0].script[5..].iter().all(|&c| c == 0), "zero-padded");
    }

    /// Bytes after the NUL survive an untouched record, and an edit of another record.
    #[test]
    fn bytes_after_the_nul_survive() {
        let mut s = sign(1, 1, 1, 3, 2, 0, b"hi");
        s.text[50] = 0x99;
        let b = rows(&wrapped(SGN1, 0, &bare_signs(1, &[s.clone(), sign(2, 1, 1, 3, 2, 0, b"b")])));
        let mut t = Trailer::load(&b);
        t.set_sign_text(1, b"edited").unwrap();
        let re = Trailer::load(&t.encode());
        assert_eq!(re.signs()[0], s);
        assert_eq!(re.signs()[1].text(), b"edited");
        // replace_sign restores a record exactly (the undo of a text edit).
        let old = t.replace_sign(0, sign(1, 1, 1, 3, 2, 0, b"new")).unwrap();
        t.replace_sign(0, old).unwrap();
        assert_eq!(t.signs()[0], s);
        assert_eq!(t.replace_sign(0, sign(2, 1, 1, 3, 2, 0, b"")), Err(Refusal::Exists));
    }

    /// Loaded records keep out-of-range values (asIs), and they round-trip.
    #[test]
    fn loaded_values_kept_as_is() {
        let s = sign(1, 1, 1, 2, 99, -4, b"\x01\x02");
        let b = rows(&wrapped(SGN1, 0, &bare_signs(1, std::slice::from_ref(&s))));
        let mut t = Trailer::load(&b);
        assert!(t.parsed());
        assert_eq!(t.signs()[0], s);
        let s2 = t.remove_sign(0).unwrap();
        t.insert_sign_at(0, s2).unwrap();
        assert_eq!(&*t.encode(), &b[..]);
    }

    #[test]
    fn mark_saved_makes_the_encoding_the_original() {
        let mut t = Trailer::load(&three_section_trailer());
        while !t.signs().is_empty() {
            t.remove_sign(0).unwrap();
        }
        let written = t.encode().into_owned();
        t.mark_saved();
        assert!(!t.is_touched());
        assert_eq!(&*t.encode(), &written[..]);
        assert_eq!(t.rebuild(), written, "an emptied section stays gone after the save");
        assert_eq!(t.section_order(), vec![CMB1, *b"XYZ1"]);
        // A new sign after the save brings SGN1 back in its old slot (as Emod's `section()` does).
        t.add_sign(Pos::new(0, 0, 0), 3, 2, 0, b"n").unwrap();
        assert_eq!(t.section_order(), vec![CMB1, *b"XYZ1", SGN1]);

        let mut e = Trailer::load(&one_sign_trailer());
        e.remove_sign(0).unwrap();
        assert!(e.encode().is_empty(), "nothing left: no trailer");
        e.mark_saved();
        assert!(e.encode().is_empty() && e.rebuild().is_empty());
    }

    #[test]
    fn indexes_track_edits() {
        let mut t = Trailer::load(&three_section_trailer());
        let block = Pos::new(100, 200, 30);
        let on = t.anchored_on(block);
        assert_eq!((on.signs, on.cmds), (&[2usize][..], &[0usize][..]));
        assert_eq!(t.find_sign(Pos::new(100, 200, 31), 3), Some(0));
        assert_eq!(t.find_sign(Pos::new(100, 200, 31), 4), None);
        let col = t.in_column(6, 12);
        assert_eq!((col.signs, col.cmds), (&[0usize, 2][..], &[0usize, 1][..]));
        let neg = t.in_column(-1, 1);
        assert_eq!(neg.signs, &[1usize][..], "x = −5 is in column −1");
        t.remove_sign(0).unwrap();
        assert_eq!(t.in_column(6, 12).signs, &[1usize][..], "indices shift after a removal");
        assert_eq!(t.find_sign(block, 1), Some(1));
        let i = t.add_sign(Pos::new(96, 192, 1), 5, 2, 0, b"").unwrap();
        assert_eq!(t.in_column(6, 12).signs, &[1usize, i][..]);
        assert!(t.anchored_on(Pos::new(0, 0, 0)).is_empty());
    }
}
