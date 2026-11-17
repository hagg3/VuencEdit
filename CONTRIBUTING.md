# Contributing to VuencEdit

VuencEdit as a whole is licensed under the GNU GPL v3 (`COPYING`), and its own files are also MIT (`LICENSE`); `NOTICE.md` has the split. By sending a patch you agree to license it the same way: GPL v3, plus MIT for any file not listed in `NOTICE.md` section 1a. If your patch ports code from Eden's source (or Emod's `Classes/`), say so in a comment and add the file to that list (`src/licence.test.ts` checks it). Don't port code from projects that have no licence.

- **Build:** needs Node 20.19+ (22 recommended) and a stable Rust toolchain. Run `npm ci`, then `npm run tauri dev`.
- **Test:** `cargo test --workspace`, `npm test`, `npm run lint` and `npx tsc --noEmit` must pass (CI runs them).
- **Bug reports:** open an issue and attach the in-app **Diagnostics report**, plus your OS and the app version. Never attach someone else's world without their permission.
- **Pull requests:** keep them small and focused, and say how you tested. Match the style of the surrounding code.
- **Assets:** the bundled Eden assets (`default-textures/`, the app icon) are not ours to relicense, so don't send replacements or additions.
