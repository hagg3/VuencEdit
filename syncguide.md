# VuencEdit Sync & Release Guide

This guide covers the full workflow: developing in the private repo, syncing to the public repo, and publishing a release build on GitHub.

---

## Overview

| Repo | Purpose |
|------|---------|
| `~/eden-world-editor` | Private development repo — work here |
| `~/VuencEdit` | Public GitHub repo — synced from private, never edit directly |

**Never commit directly to VuencEdit.** Always develop in `eden-world-editor` and use `publish.sh` to sync.

---

## Step 1 — Develop in eden-world-editor

Make all your changes in `~/eden-world-editor` as normal. Commit them with git:

```bash
cd ~/eden-world-editor
git add src/SomeFile.tsx src-tauri/src/lib.rs   # stage specific files
git commit -m "describe what you changed"
```

---

## Step 2 — Sync to VuencEdit with publish.sh

When you're ready to push features to the public repo, run the sync script from the root of `eden-world-editor`:

```bash
cd ~/eden-world-editor
./publish.sh "brief description of what changed"
```

**What this does:**
- Rsyncs all files from `eden-world-editor` → `VuencEdit`, excluding:
  - `CLAUDE.md`, `.claude/` — private Claude Code config
  - `publish.sh`, `issues.txt` — private tooling/notes
  - `*.eden`, `*.eden.bak` — world save files (potentially large/private)
  - `node_modules/`, `src-tauri/target/`, `*/obj/`, `*/bin/` — build artifacts
- Commits all changes in VuencEdit with your message
- Pushes the commit to `github.com/hagg3/VuencEdit` on `main`

**If you want to preview what will change before syncing:**
```bash
rsync -av --dry-run --delete \
  --exclude='.git/' --exclude='CLAUDE.md' --exclude='.claude/' \
  --exclude='publish.sh' --exclude='issues.txt' \
  --exclude='*.eden' --exclude='*.eden.bak' \
  --exclude='node_modules/' --exclude='src-tauri/target/' \
  --exclude='*/obj/' --exclude='*/bin/' \
  ~/eden-world-editor/ ~/VuencEdit/
```

---

## Step 3 — Publish a Release Build (optional)

If you want GitHub Actions to build installers (macOS `.dmg`, Windows `.msi`/`.exe`, Linux `.deb`/`.AppImage`) and publish them as a GitHub release, push a version tag to VuencEdit.

**Choose a version number** using [semver](https://semver.org): `vMAJOR.MINOR.PATCH`
- Bump MAJOR for breaking changes or large rewrites
- Bump MINOR for new features
- Bump PATCH for small fixes

```bash
cd ~/VuencEdit
git tag v0.7.1            # replace with your version
git push origin v0.7.1
```

**What happens next (automatically):**
1. GitHub Actions detects the tag and starts the `Release` workflow
2. Three parallel build jobs run: macOS (universal), Windows, Linux
3. Each job compiles the Rust backend + bundles the React frontend via Tauri
4. Installers are uploaded as release assets at:
   `https://github.com/hagg3/VuencEdit/releases`

**Build time:** ~10–20 minutes. Monitor progress at:
`https://github.com/hagg3/VuencEdit/actions`

---

## Full Workflow Example

```bash
# 1. Develop and commit in private repo
cd ~/eden-world-editor
git add src/App.tsx src-tauri/src/lib.rs
git commit -m "add new feature"

# 2. Sync to public repo (commits + pushes automatically)
./publish.sh "add new feature"

# 3. Tag a release (triggers automated build)
cd ~/VuencEdit
git tag v1.3.0
git push origin v1.3.0
```

---

## Troubleshooting

**Sync pushed something it shouldn't have?**
Go to `~/VuencEdit`, delete the file, commit, and push manually. Then add the file pattern to the `--exclude` list in `publish.sh`.

**Build failed on GitHub Actions?**
Open the Actions tab → click the failed run → expand the failing step to read the error log. Common causes: missing Linux apt packages, Rust compile error, or a Node version mismatch.

**Tag already exists and you need to redo it:**
```bash
cd ~/VuencEdit
git tag -d v1.3.0              # delete local tag
git push origin :refs/tags/v1.3.0  # delete remote tag
git tag v1.3.0                 # recreate
git push origin v1.3.0
```

**Check what version tags already exist:**
```bash
git -C ~/VuencEdit tag | sort -V
```
