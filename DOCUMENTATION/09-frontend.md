# 09 — Frontend Guide

React 19 + TypeScript, built with Vite 7, styled with Tailwind v4. The frontend
renders the UI, the 2D map (Canvas), and the 3D views (Three.js), and drives the
Rust backend via `invoke`.

## Component map (`src/`)

| File | Role |
|---|---|
| `App.tsx` (3082 L) | Global state, keyboard shortcuts, orchestration. |
| `Ribbon.tsx` (1993 L) | Tabbed ribbon toolbar (Home / Selection / View / 3D / File). |
| `MapCanvas.tsx` (1626 L) | 2D map: pan/zoom/select/paste/draw, `DragOp` input, right-click menu. |
| `FlyView3D.tsx` (1986 L) | Streaming fly-through 3D pane (Three.js + OrbitControls). |
| `SliceViewport.tsx` (838 L) | Front/side slab + ortho viewports for quad view. |
| `SelectionInspector.tsx` | Floating panel: stats + ortho preview + extrude + prefab save + trees + 3D view. |
| `ElevationPreviewPanel.tsx` | Full-height front/side elevation view (opt-in, resizable, draw). |
| `ThreeDPreview.tsx` | On-demand 3D render of a selection (≤ 64³). |
| `BlockPaintPicker.tsx` | Reusable block+paint picker (fill / filter modes), texture swatches. |
| `PrefabLibraryPanel.tsx` | Dockable prefab gallery. |
| `QuickActionsBar.tsx` | Floating pill under the ribbon: selection copy/fill/delete + clipboard paste/Z-offset/rotate/mirror. |
| `NewWorldModal.tsx` | New world dialog (Flat / Natural / Classic / Tg2). |
| `SchematicImportModal.tsx` | MC `.schematic`/`.litematic` import. |
| `WorldBrowserModal.tsx` | Search/download worlds from Eden servers. |
| `UploadModal.tsx` | Upload world + thumbnail. |
| `WorldInfoModal.tsx` | World summary dialog. |
| `SettingsModal.tsx` | Persistent app settings. |
| `HelpModal.tsx` | Shortcuts + texture-pack help. |
| `AboutModal.tsx` | About dialog. |
| `RecoveryModal.tsx` | Autosave crash-recovery prompt. |
| `Modal.tsx` | Shared modal shell (backdrop + Escape + focus-trap + ARIA). |
| `ErrorBoundary.tsx` | Inline error fallback wrapping quad-view panes. |
| `NumberField.tsx` | Numeric input that doesn't clamp mid-keystroke. |

### Support modules

| File | Role |
|---|---|
| `types.ts` | Shared IPC-shape types mirroring Rust structs. **Import from here.** |
| `codec.ts` | Base64 → typed-array decoders (`decodeU8`, `decodeF32`). All IPC decode. |
| `blockDefs.ts` | `BLOCK_DEFS`, `PAINT_COLORS`, ramp helpers, `resolveColor`; `applyBlockTables()`. |
| `drawTools.ts` | `penFootprint`, `brushFootprint`, `bresenhamLine`, `rectPixels`, `ellipsePixels`. |
| `texturePack.ts` | Atlas decoder, `BLOCK_TOP_TEX`, `tintedSwatch`. |
| `designTokens.ts` | Shared chrome recipes (`glassPanel`, `chromeButton`, `glassTab`, `accentRing`…). |
| `viewportUtils.ts` | Pure canvas helpers (`zoomAtPoint`, `resizeCanvasToContainer`, `beginFrame`…). |
| `useRecentWorlds.ts` | `localStorage` MRU world list + `timeAgo()`. |

## UI shell: Ribbon (`Ribbon.tsx`)

A collapsible tabbed toolbar pinned below the title row. Height is user-resizable
(60–240 px body, persisted in `localStorage`). Exports `RIBBON_HEIGHT_COLLAPSED`,
`TAB_BAR_HEIGHT`, `DEFAULT_BODY_HEIGHT`.

**Tabs:** Home | Selection | View | 3D | File (+ app-menu ▾ for settings/help/
about). **3D is a *contextual* tab** shown only while the fly-view is up
(`showSlicePanels && enable3dPane`); if it vanishes while active the Ribbon falls
back to View.

- **Home** — tool picker, undo/redo, draw options (brush size/shape, fill/hollow),
  sculpt strength, z-range, `BlockPaintPicker` (fill), replace filter, draw mask.
- **Selection** — stats, copy/delete/fill, filter, paste controls, advanced paste,
  paste transform, extrude, prefab save, tree gen.
- **View** — view mode (Top-down / Z-slice), render mode (Tiled / Full / Axo),
  Fit, Quad View, 3D Pane, Template Overlay, Texture Pack.
- **3D (contextual)** — 3D Mode (Camera/Select/Build), Build Block picker,
  Lighting group (Night / Shadows / GPU Shadows — each ⚡-badged perf-heavy — + Sun
  and Lamp Radius sliders), Textures.
- **File** — Save / Save As / Open / New World / World Browser / Upload / Export /
  Import Schematic / Expand from Template / Close.

**Hotbar:** 5 pinned + 5 recent block+paint swatches above the picker when a draw
tool is active (`pinnedBlocks`, `recentBlocks`, `hotbarHover`).

## App.tsx state & patterns

- **`worldRef`** mirrors `world` for `[]`-memoized callbacks (undo/redo →
  `applyEditResult` axo branch reads `worldRef`, not `world` directly).
- **`editEpoch`** — bumped on every edit; panels keyed on it refetch. Also bumped
  by header-only writes (rename/spawn) so they aren't lost by the dirty guard.
- **`worldEpoch`** — bumped once per world load; drives the 3D re-center token.
- **`FpsCounter`, `CoordHud`, `CursorHud`** — self-contained leaf components fed
  via refs (`hudRef.current.set(...)`) so high-frequency ticks (FPS, camera
  coords, cursor readout) re-render only their own `<div>`, not App and the
  ~150-prop Ribbon.
- **`reportError(e)`, not `setError`** — every `catch` calls `reportError`, which
  shows a red auto-dismissing toast (`ERROR_TOAST_MS`, hover-to-persist, stacked,
  capped at `MAX_TOASTS`) and records the message in `error`, which only the
  splash/`!world` branch renders inline (there is no toast layer there).
  `showToast(text)` is the info variant.
- **Settings** — `AppSettings { defaultQuadView, default3dPane,
  defaultSaveCompressed, templatePath, texturePackPath, prefabDirectory,
  enableFog, renderDistance, flySpeed, sunT, lampRadius, showQuickActions,
  autoOrient3d, settingsVersion }`. `loadSettings()`/`saveSettings()` use
  `localStorage` key `eden_settings`. `saveSettingsDebounced` (250 ms) for slider
  drags.
- **Settings migrations** (`settingsVersion` + `migrate()`) — a plain
  `{...DEFAULTS, ...parsed}` merge can never push a *changed* default onto an
  existing install, since the stored explicit value always wins. `migrate()`
  runs only on a stored blob (a fresh install just takes `DEFAULTS`, already at
  the current version), applies each version's fixups, and persists. A user who
  turns a migrated setting back off keeps their choice, since the version has
  already advanced.
- **Quick Actions bar** (`QuickActionsBar.tsx`) — a floating glass pill centred
  under the ribbon, shown while a selection or clipboard is active and
  `showQuickActions` is on (default). Selection group: Copy/Fill/Delete/
  Deselect. Clipboard group: Paste, Clear, a Z-offset `NumberField` with
  ±steppers (also reachable via PgUp/PgDn, ⇧=±5, while the paste tool is
  armed), rotate, mirror. "More…" jumps the Ribbon to the Selection tab.
- **Hotbar** — 5 pinned + 5 recent block+paint swatches, rendered by a shared
  helper called from both the Draw tab's palette group and the contextual 3D
  tab's Build Block group: 3D building's armed block is the same
  `fillBlockType`/`fillPaint` state the 2D draw tools and hotbar use, not a
  separate 3D-only value, so picking a block in either place arms the other.
  Number keys 1–5/6–0 arm hotbar slots and work in the 3D fly-view pane too.

### App.tsx gotchas

- ⚠️ **`saveWorld`/`saveWorldAs` are `const`** (not hoisted) and used in the
  keyboard-shortcut effect's dep array — they **must** stay declared *above* that
  effect, or every render throws "Cannot access before initialization".
- ⚠️ **The right-click context menu JSX and `statusBarEl` must live inside the
  `if (world) { return … }` editor branch.** App has a second `return` for the
  splash/launcher screen (`!world`); placing them in the splash branch makes them
  never render.
- **`closeWorld` reconciles `savedEpochRef`/`lastAutosavedEpochRef`** to the closed
  world's epoch before clearing state, or the next dirty guard re-asks to discard
  changes belonging to a world that no longer exists.
- **⌘W reaches `closeWorld` via `closeWorldRef`** because `closeWorld` isn't
  memoized — depending on it directly re-registers the keydown listener every
  render.

## UI/UX conventions

- **HiDPI canvases:** see [05 — 2D Rendering](./05-rendering-2d.md#hidpi-canvas-plumbing-viewportutilsts).
  Never read `canvas.width`/`height` for layout.
- **`accentRing(hex)`, not `borderColor`:** `chromeButton`/`rb` set `border: none`
  and draw their outline as an inset box-shadow, so a `borderColor` override is
  inert. Spread `...accentRing("#f59e0b")` instead.
- **Destructive dismissal:** Esc/backdrop must never destroy data.
  `RecoveryModal`'s `onDismiss` keeps the autosave sidecar; only the explicit
  Discard → confirm reaches `discard_autosave`.
- **Modals block dismissal while an operation runs** (`closeOnEsc={!busy}
  closeOnBackdrop={!busy}`, close/Cancel disabled): NewWorld, WorldBrowser,
  Upload, Expand. Completion callbacks are gated on `mountedRef`.
- **Sliders that drive IPC use a display/commit split** (`zSliceDisplay`/
  `commitZSlice`, `sunTDisplay`, SliceViewport's `dragDepth`) — track locally
  while held, commit once on pointer-up/key-up/blur.
- **`NumberField`, not a raw `<input type="number">` with a clamping `onChange`**
  — the clamp-on-keystroke idiom snaps an emptied field to the minimum. All Ribbon
  + NewWorld numeric fields go through it.
- **Shortcuts** live in App's global keydown handler and must be mirrored into
  `HelpModal`'s table. Current set: P/B/R/E/L/G/W tools, ⌘Z/⌘⇧Z undo/redo, ⌘A/⌘D
  select-all/deselect, ⌘0 fit / ⌘⇧0 zoom-to-selection / ⌘± zoom, ⌘S save, ⌘W
  close, ⌘, settings, Home fit, Esc step-back, Z cycle 3D camera. `⌘`-combos pass
  through the fly-mode gate.
- **`isTypingTarget` / `NON_TEXT_INPUT_TYPES`:** the global keydown handler only
  suppresses shortcuts for *text-entry* inputs — range sliders keep focus after a
  drag, and testing `tagName === "INPUT"` would silently kill P/B/R/E/W while a
  slider is focused.
- **`prefers-reduced-motion` (App.css)** kills transitions and flattens the toast
  slide to a fade, but deliberately leaves `eden-spin` running (a progress
  indicator, not decoration).
- **Drag-and-drop a `.eden`/`.zip` onto the window** funnels through the same
  `openFileAt` path (and the same unsaved-changes dirty guard) as every other
  open action, via Tauri's native drag-drop event rather than a React `onDrop`.
- **One shared badge system** (`designTokens.ts`: `expBadge`/`perfBadge`/
  `wipBadge`) marks experimental, perf-heavy, and work-in-progress controls
  consistently across Ribbon/App/modals, called as a function so extra style can
  be spread in.
- **Every armed/gated mode has a visible, discoverable escape hatch** — a status
  chip, a toast, or a labeled toggle — rather than relying on the user already
  knowing the shortcut out.

## Right-click context menu

`ctxMenu` state in App.tsx `{wx,wy,x,y}`. `MapCanvas` fires
`onMapContextMenu(wx,wy,screenX,screenY)` from `<canvas onContextMenu>` (which
`preventDefault()`s the OS menu) — **not** from `onPointerDown` button 2
(unreliable in macOS WKWebView). Items: Set Spawn Here, Copy / Paste Here / Fill /
Delete / Clear Selection (guarded by `rawBounds`/`clipboard`), Teleport 3D Camera
Here + **Center Map on 3D Camera** (both shown only while `showSlicePanels &&
enable3dPane`; the second guarded on `cam3dPos` too since it needs a live reading),
tool switches. Dismissed by a `document` mousedown listener registered after
an 80 ms delay (avoids same-click dismiss).

## 3D camera dot & teleport

`cam3dPos` state tracks the FlyView3D camera XY (set from `onCameraMove`, wired
only while the 3D pane is mounted), shown as a teal dot on MapCanvas. Click/drag
near the dot (`"cam3d-drag"` DragOp) teleports the 3D camera via
`flyView3dRef.current.teleport(wx, wy)`. The reverse direction — recentring the 2D
map on the live 3D camera position without changing zoom — is
`mapCanvasRef.current.centerOn(wx, wy)` (`MapCanvasRef`, alongside `resetView`/
`zoomToBox`), wired to the context menu's "Center Map on 3D Camera" item.
