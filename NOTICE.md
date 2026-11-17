# VuencEdit: licence notice

VuencEdit is a fan project. It is **not affiliated with, endorsed by, or sponsored by** Kingly Games
or Ari Ronen.

**In short:** you may use, study, change and share VuencEdit's source code. If you share VuencEdit, or
a program built from any of the GPL files listed in section 1, you must pass on the source and the
same GPL v3 freedoms. Every other file of ours (section 2) may also be used on its own under the MIT
licence, including in projects that aren't open source. The Eden textures and icon (section 1b) are
not ours to license.

## 0. Overall licence: GNU GPL v3

VuencEdit ports parts of Eden: World Builder's source code (terrain generation, block colours and
geometry, lighting, liquids, signs and more). Per community records, Ari Ronen released that source in
2018 under the GNU General Public License v3. On that basis VuencEdit as a whole (the combined program
and every installer on the Releases page) is distributed under the **GPL v3 only** (`COPYING`). The
source of every release is in this repository at the release's tag.

## 1. Eden-derived material

Eden: World Builder is (c) Ari Ronen / Kingly Games.

**a. Code: GPL v3 only.** These files contain code or data tables ported from Eden's source
(`*.mm`, `Constants.h`, or Eden code as carried in Emod's `Classes/`). They are covered by
`COPYING` and **not** by the MIT licence:

- `src-tauri/src/lib.rs`
- `src-tauri/src/signs.rs`
- `src-tauri/src/texturepack.rs`
- `src-tauri/src/worldgen.rs`
- `src/blockDefs.ts`
- `src/NewWorldModal.tsx`
- `src/ribbon/tabs/InsertTab.tsx`
- `src/signOverlay.ts`
- `packages/eden-format/src/lib.rs`
- `packages/eden-format/src/eden/mod.rs`
- `packages/eden-format/src/eden/trailer.rs`
- `packages/eden-format/src/emod/store.rs`
- `packages/voxel-core/src/blocks.rs`
- `packages/voxel-core/src/colors.rs`
- `packages/voxel-core/src/geometry.rs`
- `packages/voxel-core/src/lamps.rs`
- `packages/voxel-core/src/render.rs`
- `packages/voxel-core/src/shadow.rs`
- `packages/voxel-core/src/signs.rs`
- `packages/voxel-core/src/texture.rs`

A test (`src/licence.test.ts`) fails if a file that cites Eden's source is missing from this list.

**b. Assets: not covered by either licence.** The default texture pack (`default-textures/`), the app
icon (`src/assets/app-icon.png`, `src-tauri/icons/`) and the images made from them (`assets/`,
`logo.png`) come from Eden and are (c) Ari Ronen / Kingly Games. The reported GPL grant was for the
source code; whether it extends to these assets is unconfirmed. They are included so the editor can
show worlds as they look in the game. Don't reuse them in other projects without the rights holder's
permission. `eden-leaderboards/` is a snapshot of Eden's public world lists, kept for world search.

**c. The name "Eden"** and related marks are not licensed. VuencEdit is an unofficial community tool.

**Removal on request:** if the rights holder asks for any part of this project to be changed or
removed, we will do so promptly. Open an issue on this repository.

## 2. VuencEdit's own work: MIT (part of the GPL v3 whole)

Copyright (c) 2026 VuencEdit contributors. Every file in this repository that is not listed in
section 1 is VuencEdit's own work and may also be used on its own under the MIT licence (`LICENSE`).
That includes the frontend (`src/`, except the files above), the rest of the Rust backend, the shared
crates' other modules, the build and CI files, and the documentation. Code ported from Emod's own
(MIT) files falls here too.

## 3. Credits and third-party components

- **Robert Munafo** reverse engineered the Eden file format
  ([mrob.com](https://mrob.com/pub/vidgames/eden-file-format.html)). Per-block paint brightness in
  `packages/voxel-core/src/colors.rs` comes from his `la-map.c` (GPL v3 or later).
- **Eden World Manipulator 2.0** (jldeiro, 2019) and **Vuenctools** (bLUUBfACE), the editors
  VuencEdit succeeds. The four tree shapes in `src-tauri/src/lib.rs` (`place_normal_tree`,
  `place_terrain_tree`, `place_pine_tree`, `place_tall_pine_tree`) are ported from Eden World
  Manipulator 2.0, which was published without a licence. Permission to include them is being
  sought; they will be rewritten if it isn't given.
- **Emod** ([github.com/hagg3/edencom](https://github.com/hagg3/edencom)), whose sources several
  files port (see section 1a).
- **Libraries.** VuencEdit is built with [Tauri](https://tauri.app) (MIT / Apache-2.0),
  [React](https://react.dev) (MIT), [Three.js](https://threejs.org) (MIT) and
  [Lucide](https://lucide.dev) icons (ISC), plus Rust crates under MIT, Apache-2.0, BSD, ISC, Zlib,
  MPL-2.0, Unicode-3.0 and similar GPL-compatible licences. Each one's licence text ships with its
  package (`Cargo.lock` and `package-lock.json` list them all).
