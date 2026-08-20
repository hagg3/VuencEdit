# 09 — Frontend Guide

React 19 + TypeScript, built with Vite 7, styled with Tailwind v4. The frontend
renders the UI, the 2D map (Canvas), and the 3D views (Three.js), and drives the
Rust backend via `invoke`.

## Component map (`src/`)

| File | Role |
|---|---|
| `App.tsx` | Global state, keyboard shortcuts, orchestration. |
| `Ribbon.tsx` + `src/ribbon/` | Ribbon shell + its tokens, icons, primitives, tier solver, top bar and 8 tab modules. |
| `AppMenu.tsx` | Two-pane Office-2007 application menu (replaces the old VuencEdit ▾ / File ▾ dropdowns). |
| `WorldNamePill.tsx` | Top-bar world identity, details popover and rename. |
| `src/panels/` | `AboutPanel` / `WorldInfoPanel` — shared by the application menu and their modals. |
| `MapCanvas.tsx` (1626 L) | 2D map: pan/zoom/select/paste/draw, `DragOp` input, right-click menu. |
| `FlyView3D.tsx` (1986 L) | Streaming fly-through 3D pane (Three.js + OrbitControls). |
| `SliceViewport.tsx` (838 L) | Front/side slab + ortho viewports for quad view. |
| `Sidebar.tsx` | Docked right-edge tabbed panel (Inspector / Prefabs / History) + collapse rail + drag-resize. |
| `SelectionInspector.tsx` | Sidebar Inspector tab: stats + ortho preview + extrude + prefab save + trees + 3D view. |
| `ElevationPreviewPanel.tsx` | Full-height front/side elevation view (opt-in, resizable, draw). |
| `ThreeDPreview.tsx` | On-demand 3D render of a selection (≤ 64³). |
| `BlockPaintPicker.tsx` | Reusable block+paint picker (fill / filter modes), texture swatches. |
| `PrefabLibraryPanel.tsx` | Dockable prefab gallery. |
| `QuickActionsBar.tsx` | Floating pill under the ribbon: selection copy/fill/delete + clipboard paste/Z-offset/rotate/mirror. |
| `NewWorldModal.tsx` | New world dialog (Flat / Natural / Classic / Tg2). |
| `SchematicImportModal.tsx` | MC `.schematic`/`.litematic` import. |
| `WorldBrowserModal.tsx` | Search/download worlds from Eden servers. |
| `UploadModal.tsx` | Upload world + thumbnail. |
| `WorldInfoModal.tsx` | Thin `Modal` wrapper around `WorldInfoPanel`. |
| `SettingsModal.tsx` | Persistent app settings. |
| `HelpModal.tsx` | Shortcuts + texture-pack help. |
| `AboutModal.tsx` | Thin `Modal` wrapper around `AboutPanel` (also mounted by the splash screen). |
| `RecoveryModal.tsx` | Autosave crash-recovery prompt. |
| `Modal.tsx` | Shared modal shell (backdrop + Escape + focus-trap + ARIA). |
| `ErrorBoundary.tsx` | Inline error fallback wrapping quad-view panes. |
| `NumberField.tsx` | Numeric input that doesn't clamp mid-keystroke. |

### Support modules

| File | Role |
|---|---|
| `types.ts` | Shared IPC-shape types mirroring Rust structs. **Import from here.** |
| `codec.ts` | Binary-IPC framing primitives (`decodeEnvelope`, `splitBody`, `asF32`) + `encodeU8` for the JS → Rust direction. The typed `decode*` helpers live in `types.ts`. |
| `blockDefs.ts` | `BLOCK_DEFS`, `PAINT_COLORS`, ramp helpers, `resolveColor`; `applyBlockTables()`. |
| `drawTools.ts` | `penFootprint`, `brushFootprint`, `bresenhamLine`, `rectPixels`, `ellipsePixels`. |
| `texturePack.ts` | Atlas decoder, `BLOCK_TOP_TEX`, `tintedSwatch`. |
| `designTokens.ts` | Shared chrome recipes (`glassPanel`, `chromeButton`, `glassTab`, `accentRing`…). |
| `viewportUtils.ts` | Pure canvas helpers (`zoomAtPoint`, `resizeCanvasToContainer`, `beginFrame`…). |
| `useRecentWorlds.ts` | `localStorage` MRU world list + `timeAgo()`. |

## UI shell: the Ribbon (`Ribbon.tsx` + `src/ribbon/`)

Rewritten 2026-08-12. `Ribbon.tsx` is a thin shell (~250 L); everything visual
lives under `src/ribbon/`. Density target is the **Office 2007–2010 ribbon** —
compact rows, mixed large/small buttons, not a touch toolbar.

```
src/ribbon/
  tokens.ts        geometry + the visual system (scales, surfaces, accents, state recipes);
                   throws at import if the height constants stop summing
  icons.tsx        <Icon name=… size=… tone=…/> over lucide-react (named imports only)
  primitives.tsx   Group GroupDivider MenuSeparator LargeButton SmallButton IconButton
                   CommandButton SplitButton DropdownButton MoreChevron Popover SliderRow
                   RangeSlider Segmented Caption MenuItem Row Col
                   Badge FieldLabel Swatch NumField Check + RIBBON_CSS
  layout.ts        pure tier solver          layout.test.ts  its unit tests
  context.tsx      RibbonContext + useRibbon()      props.ts  RibbonProps / RibbonTab
  sculptTools.ts   the 16 sculpt tools, shared by SculptTab and 3D Sculpt mode
  TopBar.tsx       Menu · Undo/Redo · tabs · world pill · Help · collapse
  PaletteGroup.tsx the one palette presentation (+ TextureGroup)
  tabs/            HomeTab DrawTab SculptTab InsertTab ViewTab ThreeDTab
                   SelectionTab ClipboardTab
```

### Geometry — and why labels can't be clipped

Fixed heights, no drag-resize (collapse remains):

| Token | Value |
|---|---|
| `TOP_BAR_HEIGHT` | 34 |
| `RIBBON_BODY_HEIGHT` | 104 |
| `RIBBON_HEIGHT_COLLAPSED` | 34 (= top bar alone) |
| `GROUP_PAD_TOP` / `GROUP_PAD_BOTTOM` | 4 / 2 |
| `GROUP_CONTENT_H` | 82 |
| `GROUP_LABEL_H` | 16 |
| `LARGE_H` / `SMALL_H` / `ROW_GAP` | 82 / 26 / 2 |

`RIBBON_BODY_HEIGHT = GROUP_PAD_TOP + GROUP_CONTENT_H + GROUP_LABEL_H + GROUP_PAD_BOTTOM`,
asserted at module load. And `3 × SMALL_H + 2 × ROW_GAP = LARGE_H = GROUP_CONTENT_H`,
so a column of three small buttons exactly fills a group.

⚠️ **`Group` renders its control area as a fixed-height box with `overflow: hidden`,
then the label strip after it.** The old ribbon used `marginTop: auto` on the label,
which meant a group whose rows added up to more than the body pushed its own label
down and off the bottom. Structurally that can no longer happen. The consequence for
authors: **anything needing more than three 26px rows must add a column, not a row** —
see the Rock/Carve group's eight parameters laid out as three columns of three.

### Visual system (`tokens.ts`) — restyled 2026-08-12

The architecture above landed with an unsystematised visual layer: four unrelated
aesthetics (translucent white-wash buttons, a cyan default icon tone, a bright blue
floating tab pill, Office group organisation) and **68 hardcoded `accent="#hex"` props
across the 8 tabs in 18 distinct colours**. The restyle keeps every geometry constant
and every primitive signature; only values and recipes changed.

**Scales** — `RADIUS {sm 2, md 3, lg 5}` · `FONT {micro 9, label 10, body 11, tab 12}` ·
`ICON {xs 12, sm 14, lg 24}` · `SPACE {xs 2, sm 4, md 6, lg 8}`. Retired: `fontSize`
6/8/12.5/13 and icon sizes 11/13/15/16/26, none of which had a constant behind them.

**Material.** Every control sits on `SURFACE.raised` (an opaque vertical gradient) with
`inset 0 0 0 1px BORDER.outline, inset 0 1px 0 BORDER.bevel` — deliberately the same
family as `designTokens.chromeButton`, which the QuickActionsBar already used, so the
ribbon and the floating pill match at rest. The radius differs on purpose (3 vs 6): a
docked dense ribbon and a floating pill are different objects. `SURFACE.body` is a
neutral blue-grey vertical gradient; the old `90deg` slate→teal wash is gone, and
`ICON_TONE` moved from cyan `#7fd4e0` to neutral `#c3ccd2` — **cyan now appears only on
active and focus**, which is what stopped it reading as the ribbon's material.

**Five states, defined once:** `btnBase` · `btnHover` (revived; it was dead code) ·
`btnPressed` (**new** — inverted gradient + inner shadow, no `transform`, which would
break grid alignment) · `btnActive(accent)` (tinted + outlined, not glowing) ·
`btnDisabled` (one recipe; `QatButton`'s `.5`-opacity variant is gone). Hover and
pressed live in CSS; active and disabled are inline.

**Four sanctioned accent hues**, replacing the 18:

| Token | Hue | Meaning |
|---|---|---|
| `ACCENT.primary` | `#00a4ad` Eden teal | draw tools, generic toggles, default |
| `ACCENT.warm` | `#d98a2b` | sculpt |
| `ACCENT.green` | `#3fa85c` | selection / clipboard |
| `ACCENT.violet` | `#7c6bd6` | 3D / spatial |

`DANGER` `#c2504f` replaces `#ef4444`/`#fca5a5`/`#f87171`. `CTX_ACCENT` maps the
contextual tabs onto the same four (3D moved off sky-blue `#38bdf8`, which was
near-indistinguishable from the primary accent). `FOCUS_RING` `#5b9fd6` and `ARMED_RING`
(= `ACCENT.primary`) are separate tokens **on purpose** — both used to be `#00dde9`, so
a focused control and an armed one looked identical.

⚠️ Accents name the **tool family**, not the individual command. Within a tab most
buttons therefore share one accent; that is the system working, not missing variety.
`ThreeDTab`'s `MODES` is the one place a row mixes hues, because each mode hands you a
*different* family (Build/Flood Fill → primary, Sculpt → warm, Camera/Select → violet).

### Tabs

Permanent **Home · Draw · Sculpt · Insert · View**; contextual **3D**
(`showSlicePanels && enable3dPane`), **Selection** (`rawBounds`), **Clipboard**
(`clipboard`), each with an appearance flash and its own `CTX_ACCENT` hue (3D violet,
Selection warm, Clipboard green). The flash colour comes from a `--rbn-pulse` CSS custom
property set inline per tab — `@keyframes rbnCtxPulse` used to be hardcoded amber and so
flashed amber for the green Clipboard tab too.

A contextual tab carries its hue as an **Aero-style glow** — a tinted fill, an inset
halo and a matching `text-shadow` — that intensifies sharply on selection. It replaced a
2px top strip, which read as a hairline rather than as "this tab is special".
⚠️ **The glow is `inset`, not an outer `box-shadow`.** The tab strip is `overflow: hidden`
and that is load-bearing: at the 900px `minWidth` the strip has to clip rather than run
over the world pill, so an outer glow would be sliced off at the strip's edges and along
its bottom. A selected contextual tab's gradient still ends on `TAB_ACTIVE_BOT`, so it
merges into the body exactly like a permanent tab; only its top half is tinted.

If the 3D pane closes while its tab is active
the ribbon falls back to View. Arming a 2D draw tool jumps to Draw; arming any of
the 16 sculpt tools jumps to Sculpt.

Mental model, stated so placement is predictable:

> **Home** = what you touch constantly. **Draw** = place blocks by hand. **Sculpt** =
> reshape terrain. **Insert** = generate/import content. **View** = change what you
> see, never the world. **3D / Selection / Clipboard** = contextual, own the object
> that exists.

| Tab | Groups |
|---|---|
| Home | Clipboard · Navigation · Selection · Palette · Set Point |
| Draw | Tools · Brush · Options · Palette · Mask |
| Sculpt | Sculpt tools · Brush · Falloff · Palette (compact) · Tool Options (contextual tail) |
| Insert | Prefab · Import · Nature · Fluids · World Extent |
| View | Map View · Render · Zoom · Layout · Template · Textures (+ Z-level tail) |
| 3D | Mode · mode slot (fixed `MODE_SLOT_MIN` 416px) · Camera · Lighting · Textures |
| Selection | Modify · Z Range · Move · Fill (Fill+Gradient merged) · Replace · Extrude |
| Clipboard | Preview · Place · Transform · Options · Mode · Prefab |

Moves worth knowing: Materialize Home → Insert; Fluids Selection → Insert (it is
selection-scoped *generation*, exactly like Trees, and Selection was at 8 groups);
Load Prefab / Import Schematic / Expand from Template File menu → Insert; the World
readout Home → the top-bar pill; New World / Browse Online Home → the application menu.

Deliberate duplications — each a *shared component*, never a forked path:
Copy/Cut/Delete/Fill/Grow/Shrink/Clear on Home + Selection; Paste/Rotate/Flip on Home
+ Clipboard; `PaletteGroup` on Home + Draw + Sculpt + 3D; `TextureGroup` on View + 3D.

### Responsive tiers (`layout.ts`)

```ts
solveLayout(groups: GroupMetrics[], available: number): Record<string, Tier>
```

Each group declares `widths: {full, medium, compact}`, a `minTier` floor and a
`priority`. Start everything at `full`; while the row overflows, demote one group one
tier — choosing **the widest current tier first, then the highest priority**. That
ordering matters: demoting purely by priority would hide the least-important group
behind a chevron while its neighbours were still full-size, which reads as a bug.
`minTier: "full"` exempts a small group from shrinking at all (MS guidance: don't
collapse a two-command group to a popup icon).

Tier meanings: `full` = the mockup layout · `medium` = large buttons become small
icon+label rows (`CommandButton` is the only place that mapping lives) · `compact` =
the whole group becomes one chevron opening a `Popover` with its full content.

Widths are **declared, not measured**, which is what keeps the solver pure and
unit-testable. A dev-only `ResizeObserver` in `Group` `console.warn`s on drift, so it is
caught without making the solve non-deterministic.

⚠️ The guard is **two-sided** (`WIDTH_TOLERANCE` 8px). It used to fire only when a group
rendered *wider* than declared, which left the opposite mistake silent: over-declaring
reserves width the group never uses, so the row demotes earlier than it needs to and the
tab carries dead space nothing ever reports. Both directions print the measured pixel
value, so one dev run yields the exact number — and it must be pasted into **both** copies,
the tab's `SPECS.widths.full` *and* its matching `declaredWidth` prop. Only the `full`
tier is checked; `medium`/`compact` widths live solely in SPECS and are never handed to a
`Group`, so there is nothing to compare them against.

Deleted with this: the `◄ ►` scroll arrows, `updateScrollArrows`/`canScrollLeft/Right`,
the wheel→horizontal remap, the resize grip, and the `ribbon_body_height` key (removed
from `localStorage` on first run). `overflowX: auto` remains as a silent last resort
below the minimum window width (`tauri.conf.json` `minWidth` is 900).

### Primitives notes

- Hover, **pressed** and focus rings live in `RIBBON_CSS`, injected once by the shell —
  inline styles can't express `:hover`/`:active`, and per-button state would be ~60
  extra `useState`s per tab. The rules use `!important` scoped by
  `:not([data-active="true"]):not([aria-disabled="true"])`, so an armed button's inline
  accent still wins and a disabled one doesn't light up. A higher-specificity
  `[role="menuitem"]` pair keeps popover rows highlighting instead of growing a bevel.
- A `@media (prefers-reduced-motion: reduce)` block kills the button transitions and the
  contextual-tab pulse.
- Unselected tabs carry `.rbn-tab` purely so CSS can give them a hover state; they are
  not `.rbn-btn`, and before this they had no hover at all.
- Disabled controls use `opacity` + `pointerEvents: none` (layout stability) **and**
  `aria-disabled` + `tabIndex={-1}` — otherwise they stay focusable but unclickable.
- **Keyboard model for menus and radiogroups** *(audit M2, 2026-08-20)*. Every popover
  opener already declared `aria-haspopup="menu"` + `aria-expanded`, so assistive tech
  announced a menu the keyboard could not drive. A `Popover` with `role="menu"` now
  focuses its first enabled `[role="menuitem"]` one frame after mount (deferred, because
  the panel is portaled and positioned in a layout effect — focusing before that lands
  would scroll to the off-screen `-9999` staging position), roves focus on
  Up/Down/Home/End, **closes on Tab** (the ARIA menu convention: a menu is not a dialog,
  so it traps nothing), and restores focus to whatever had it — but only if focus is
  still inside the panel, so a click elsewhere isn't fought. `role="dialog"` panels (the
  block picker, the world pill's details) are deliberately left alone: they own their own
  inner focus order, and stealing it would break the pill's rename field.
  ⚠️ **`onClose` is read through a ref, and the effect is keyed on `role` alone.** Nearly
  every call site passes an inline arrow, so depending on `onClose` directly would re-run
  the effect on every parent render — harmless for the outside-click/Escape listener
  (it just re-registers) but here it would re-fire the focus-first-item step and yank
  focus back to the top of the menu while the user was arrowing through it.
  `Segmented` is now **one** tab stop, not one per option — only the checked option is
  tabbable — and Left/Right/Up/Down move the selection *and* focus (wrapping), with
  Home/End at the ends. `checkedIndex` floors at 0 so a group whose `value` doesn't match
  any option still has exactly one tab stop instead of dropping out of the tab order.
  Still deferred: the block picker's swatches are mouse-only `<div>`s (roving tabindex
  over a swatch grid).
- `Popover` portals to `document.body` for **two** reasons: the ribbon body clips
  overflow, *and* the ribbon root's `z-index: 100` is its own stacking context, so an
  in-tree panel can never rise above the docked sidebar (`z-index: 120`) whatever
  z-index it asks for. Its chrome is `SURFACE.popover` — the ribbon's own material, not
  the app-wide warm-brown `glassMenuPanel`, which read as a foreign object over a cool
  slate ribbon. `Ribbon.tsx`'s `BlockPaintPicker` portal uses the same chrome. Popover
  flips above the anchor when it would overflow the viewport bottom, and handles Escape
  capture-phase with `stopPropagation` so App's global step-back doesn't also fire.
  ⚠️ That Escape listener is **capture-phase on `window`**, so a child input cannot
  `stopPropagation()` its way out of closing the panel — pass `onEscape` when the panel
  owns an inner gesture Escape should step back from first (`WorldNamePill`'s rename).
- Small shared parts, each replacing a family of one-offs: `Badge` (was `Exp()` copied
  into four tabs plus `Perf()`) · `FieldLabel` (~16 hand-rolled label spans across eight
  different widths) · `Swatch` (**three** treatments for one concept: the palette hotbar,
  InsertTab's leaf colours, SelectionTab's block chip) · `NumField` (was
  `{...fieldStyle, width: N}` spread at every call site) · `Check` · `MenuSeparator` ·
  `RangeSlider` (the dual-thumb Z-range, promoted out of `SelectionTab` where it was
  hand-built from five untokenised blues).
- One `RAIL_W` (15) for split/chevron rails — `SplitButton` used 16 and `PaletteGroup`
  15. `TOPBAR_BTN_H` (24) and `PALETTE_COMPACT_H` (34) replace an undeclared `23` and
  the expression `SMALL_H + 8`.
- The top-left **brand button** is Office 2010's File tab: permanently filled with
  `ACCENT.primary` (not a neutral control that lights up when open) and carrying the app
  identity — the 20px icon plus the **VuencEdit** wordmark, bold `Vuenc` + regular `Edit`,
  restored from the pre-rewrite ribbon. Its glow widens from 9px to 16px while the menu is
  open. ⚠️ It is `.rbn-brand`, **not** `.rbn-btn`: the neutral hover gradient would stomp
  its accent fill, so it has its own hover/active rules in `RIBBON_CSS`.
- ⚠️ **Undo/Redo in the top bar are fixed-width** (`QAT_W_LABELLED`/`QAT_W_ICON`). Both
  show a stack depth that changes on *every edit*, so an auto-width button shoved the
  whole tab strip sideways each time you drew a block. The count is clamped to `99+` and
  sits in a fixed box with tabular figures.
- `hexToRgbTriplet()` in `tokens.ts` replaces the old `accentRgb()` — a six-entry
  lookup table that silently returned green for any colour not in it.

### Shell services (`context.tsx`)

`useRibbon()` gives a tab `{ p, activeTab, setActiveTab, bodyWidth, pickerKind,
togglePicker, openAppMenu, armTransientTool }`. `RibbonProps` is passed whole rather
than threaded per-tab: only one tab is mounted at a time, so the context's changing
identity costs nothing over the old whole-component re-render.

⚠️ `armTransientTool(next, escapeTo)` exists because `react-hooks/immutability`
forbids writing a ref reached through a hook's return value. Eyedropper and Pool Fill
need to record `prevToolRef`; only `Ribbon.tsx`, which receives that ref as a prop,
may write it.

Slider *display* values (z-slice, sun, lamp radius, fly speed, render distance) live
in their own tab modules, synced from the committed prop by the render-phase derived
-state pattern. This improves on the previous convention: a drag now re-renders one
tab instead of the whole ribbon.

### Palette

One `PaletteGroup` component, two variants (`full` = large split Block button + Pinned
×5 + Recent ×5; `compact` = swatch + name), four call sites (Home, Draw, Sculpt, 3D
Build). It reads `fillBlockType`/`fillPaint` off context, so three divergent palette
states are structurally impossible. Exactly one `BlockPaintPicker` portal exists,
hoisted into the shell; tabs only ask it to open via `togglePicker(e, kind)`.

Hotbar cells are `Swatch`es, and the selected one carries the `ARMED_RING` **outside**
the cell (`0 0 0 2px`) rather than the old `inset 0 0 0 2px #fff, 0 0 0 1px #00dde9`
double ring. ⚠️ That is why the two hotbar rows use `gap: SPACE.sm` (4) instead of
`COL_GAP` (2) — at 2px a selected cell's ring would touch its neighbour. It costs the
Palette group ~10px, which is why its declared width is 264, not 252.

## Docked sidebar (`Sidebar.tsx`) — restyled 2026-08-20 *(audit H10 step 3)*

The sidebar was the app's third competing visual system: warm-brown
`glassPanel`/`glassTab`, text-only tabs and its own eight hard-coded greys, sitting
flush against a cool-slate ribbon. It is now built from `ribbon/tokens` +
`ribbon/icons`. **Nothing about the layout changed** — same `MIN_WIDTH`/`MAX_WIDTH`
(200/420), same `COLLAPSED_RAIL` (28), same left-edge drag-resize, same
`z-index: 120` — only the material, the type tones and the tab glyphs.

- Shell: `SURFACE.body` with a `BORDER.outline`/`BORDER.bevel` inset left edge in place
  of the old glass panel + outer shadow pair.
- Tab strip: `role="tablist"` on `SURFACE.topbar`, each tab a `.rbn-tab` (not
  `.rbn-btn` — the latter's hover grows a *raised* face, wrong for a flat strip) with a
  lucide icon and an `ACCENT.primary` underline when selected, so a selected sidebar tab
  reads the same way a selected ribbon tab does. Inspector carries the **selection**
  glyph rather than a generic "info" one, because that is what it reads out.
- The collapse rail and the collapse button use `Icon name="left"/"right"` instead of
  `◀`/`▶` text glyphs.
- The three content components inside it were migrated in the same pass
  (`SelectionInspector`, `PrefabLibraryPanel`, `ElevationPreviewPanel`) — a slate shell
  wrapped around warm-brown content would have read worse than either end state. Their
  ~40 raw hex values map onto `TEXT`/`TEXT_DIM`/`TEXT_LABEL`/`TEXT_DISABLED` and the
  four sanctioned `ACCENT` hues (clipboard green, axo violet, armed teal);
  `PrefabLibraryPanel`'s `chromeButton` calls became a local `panelBtn` over `btnBase`,
  and its `✓ ✗ ✎ 🗑 ▦ ☰` emoji became lucide icons.
- Still warm-brown, deliberately: `designTokens.ts` is now used by modals, the app menu
  and a few App-level surfaces only — the audit's stated end state is that it becomes an
  explicit, consistent *second* surface for modals rather than being eliminated.

## Application menu (`src/AppMenu.tsx`)

One two-pane Office-2007 menu replacing the old VuencEdit ▾ and File ▾ dropdowns and
their inline `showRecentSub` / `showExportSub` accordions. Opens under the top bar's
Menu button. Left column → right contextual pane:

⚠️ **The panel is a fixed `MENU_W` × `MENU_H` (720 × 540), not `minWidth`-to-`maxWidth`
elastic.** It used to be `minWidth: 880` / `maxWidth: min(1180px, 96vw)` with panes free
to be as wide as their content, so the menu visibly resized as you moved down the command
column. Consequently the explanatory panes (New · Download · Upload · Help) are plain
`term — definition` text lists (`TextList`), not the two-column icon-card grid they were:
under the fixed width those cards were both too narrow to read and wider than the pane,
and their icons were decorative. Export rows keep their cards — those are *actions*, each
with its own button — but stack title-above-description so a 476px pane can't squeeze
them. The one-off violet border and violet row highlight are now `ACCENT.primary`, so the
menu and the Menu button that opens it belong to the same system.

| Row | Right pane |
|---|---|
| New | The four generators (Flat / Natural / Classic / Tg2), what each produces, + **New World…** |
| Open | Recent worlds list (click to open) + **Browse for a file…** |
| Download | What the world browser offers (quality sort, date filters, hide junk) + **Browse Online Worlds…** |
| Save | Compressed + backup-compressed toggles, how incremental/WAL saving works, + **Save Now** |
| Save As | Same options, extension-correction and overwrite notes, + **Choose Location & Save…** |
| Export | One row per format (PNG · JSON · OBJ *exp* · VMF *exp*), each with its own **Export** button |
| Upload | What is sent, naming, save-first, permanence, + **Upload This World…** |
| Properties | `WorldInfoPanel` + an inline rename field |
| Settings | Quick view toggles + **Open Settings…** |
| Help | Shortcut cheat-sheet cards + **Open Help** |
| About | `AboutPanel` |
| Close World | What closing releases + **Close World** (red) |

Two rules drive that table:

1. **No pane is ever blank.** Rows with nothing to preview explain the command *and*
   the feature behind it, so the menu teaches rather than showing dead space.
2. **Slow or destructive rows repeat their action as a button in the pane.** Once a
   row also drives a preview, "click the row to run it" stops being obvious.

`AboutModal` and `WorldInfoModal` are now thin `Modal` wrappers around
`src/panels/AboutPanel.tsx` and `src/panels/WorldInfoPanel.tsx`, which the About and
Properties panes render. **Both modals must survive** — the splash screen mounts
`AboutModal` and has no ribbon to open the menu from.

## World name pill (`src/WorldNamePill.tsx`)

Top-bar right cluster, before Help and the collapse chevron. Face = the world name +
a 64z/256z badge; click opens a popover with format, chunk and block dimensions, Z
range, Home/Start positions, the file name, an inline rename, and links to the
Properties pane and the World Info dialog.

The rename flow is ported verbatim from Home's old World group, including the
`renameCancelledRef` guard: Escape triggers a blur, and without the flag that blur
would commit the very edit Escape cancelled. ⚠️ `rename_world` bypasses `with_edit`,
so App bumps `editEpoch` by hand or the change is silently lost on close.

⚠️ The component destructures every field it needs off `p` up front. The lint rule
guarding ref access treats any object reached through a hook's return value as
ref-like once one of its fields *is* a ref (`renameInputRef`), so reading `p.<field>`
inline in the JSX trips it on every unrelated field too.

## Onboarding tour (`src/tour/`)

Three files. `steps.tsx` is content-only — a flat `TOUR_STEPS: TourStep[]` array and
`TOUR_VERSION` (bumped only by `bump-version.sh`). `TourOverlay.tsx` is the engine.
`placement.test.ts` is the tour's only automated coverage.

**`TourStep`:** `{ id, title, body: ReactNode, target: string | null, placement?, padding?,
before?: (ctx: TourCtx) => void }`. `body` is JSX (hence `.tsx`, not `.ts`) so a step can carry
`<Kbd>` keycaps the same way `HelpModal`/`AppMenu` do — there's a local `Kbd` in `steps.tsx`
rather than importing `AppMenu`'s (not exported, and importing across that boundary for one
component isn't worth it). `target: null` renders a centred card with no spotlight (used once, for
the welcome step). `before` is the **guided-passive reveal** — it may switch ribbon tabs, open the
sidebar, uncollapse the ribbon or reveal the left toolbar via `TourCtx`'s five setters, but never
touches world data and never waits on a user action; it runs in a `useLayoutEffect` keyed on
`stepIndex` so any state update it triggers upstream (App) commits before the browser paints —
that's what lets the following measurement effect's `requestAnimationFrame` see the post-reveal
DOM instead of a stale one.

**Engine (`TourOverlay.tsx`, ~250 lines):**
- Portaled to `document.body`, z-index `9990` — above every chrome layer, below the block-picker
  portal and `AboutModal` (9999). Neither can be open while the tour runs.
- **Spotlight = two divs, no SVG mask.** A full-screen `pointer-events: auto` layer swallows every
  click so the app is inert during the tour; a div positioned at the padded **cutout** rect with
  `box-shadow: 0 0 0 9999px rgba(8,12,16,.66)` paints the dim scrim *and* the cutout with no
  geometry maths, `pointer-events: none` so clicks pass through to the catcher beneath it. A
  `.eden-tour-ring` div tracks the primary `target` alone (not the cutout) and carries the pulse
  (`@keyframes eden-tour-pulse`, defined in a `TOUR_CSS` `<style>` block rendered inline — the
  `RIBBON_CSS`/`SPLASH_CSS` idiom).
  ⚠️ **The reduced-motion opt-out is a JS `matchMedia` check** (`prefersReducedMotion()`, read once
  via `useState`'s lazy initializer), which conditionally omits the `.eden-tour-ring` class rather
  than a CSS `@media (prefers-reduced-motion: reduce)` block overriding the same class's animation.
  An earlier version did it in CSS — `@media (prefers-reduced-motion: reduce) { .eden-tour-ring {
  animation: none !important; ... } }` on the class the keyframes lived on — and that combination
  froze the whole app on a real device with Reduce Motion enabled (dimmed overlay, card never
  appeared); root cause not chased down, but a WKWebView-specific interaction between a media query,
  an inline-rendered `<style>` tag and `!important` is the leading suspect. The JS branch sidesteps
  it entirely and isn't more code.
- **`secondaryTargets`** (per-step, optional): extra selectors unioned into the spotlight's cutout
  rect without taking the ring. Exists because a step spotlighting a ribbon group sits *below* the
  tab strip — without folding the strip into the cutout, the dim scrim covers it too and the active
  tab (which just changed via `before`) reads as illegible. The five ribbon-group steps include
  `RIBBON_TABLIST` (`[role="tablist"][aria-label="Ribbon tabs"]`); Draw tools additionally folds in
  the Mask group, Selecting folds in Navigation, and View layouts folds in the map (`[data-tour=
  "map"]`, since it also describes cutaway view). `unionRects` is memoized (`useMemo` keyed on
  `[rect, secondaryRects]`) — the placement effect below is keyed on the union, and an unmemoized
  call would mint a new object every render, re-triggering that effect (and `setPos`) forever.
- **Measurement:** `document.querySelector(step.target)` → `getBoundingClientRect()`, re-run on a
  `requestAnimationFrame` after `before()` settles, on `window` resize, and via a `ResizeObserver`
  on `document.body` (catches a reflow that doesn't fire `resize`, e.g. the sidebar opening).
  ⚠️ **A missing target is never fatal** — an unresolved selector degrades the step to a centred
  card with no spotlight and a dev-only `console.warn`, so a hidden `LeftToolbar` (user-collapsed)
  or a contextual ribbon tab that never appears during the tour can't crash it, only ask the step
  to advance without pointing at anything.
- **Card placement** is `placeCard(rect | null, card: {w,h}, vw, vh, placement)` — a pure,
  exported function: picks the side of the target with the most room (or the step's explicit
  `placement`), then clamps into the viewport with an 8px margin. `rect === null` centres it. Pure
  and node-testable — `placement.test.ts` pins the viewport-margin clamp at each corner/edge and
  the auto-side choice, the tour's counterpart to `ribbon/layout.test.ts`.
- **Card** is `role="dialog" aria-modal="true"`, styled from `ribbon/tokens`
  (`SURFACE.popover`/`BORDER`/`RADIUS.lg`/`FONT`/`ACCENT.primary`), holding an `N / total` counter
  + dot progress strip, title, body, and Skip tour / Back / Next (Done on the last step). Focus is
  trapped via `useFocusTrap` (reused from `Modal.tsx`, not reimplemented) on the card ref.
- **Keyboard**, capture-phase on `window` with `stopPropagation()` (the `AppMenu.tsx`/`Popover`
  idiom): →/Enter/Space advance, ← steps back, Esc skips (`onClose(false)`). Capture + stop is what
  keeps editor shortcuts (`P`, `[`, `⌘Z`) from firing underneath the overlay — belt-and-braces with
  App's `anyModalOpen` gate below.
- Props: `{ steps, ctx, onClose(completed: boolean) }`. Owns only `stepIndex` and the measured
  rect; everything else is derived per render from `steps[stepIndex]`.

**Wiring in `App.tsx`:** `tourOpen` state + a `tourCheckedRef` (once-per-session latch) + a
`useEffect` on `[world, anyModalOpen]` — *not* a call inside `applyLoadedWorld`, since that runs
before the editor branch has mounted and would measure into an empty DOM; running after covers
new/open/download/recent/recovery uniformly with no change to `applyLoadedWorld`'s two call sites.
It compares `loadSettings().tourVersion` against `TOUR_VERSION` and writes the flag at *open* time,
not completion (mirrors `FlyView3D.tsx`'s `FLY3D_LEGEND_SEEN_KEY` idiom — a user who skips
immediately has still been offered it once). `anyModalOpen` includes `tourOpen`, so editor
shortcuts can't fire under the overlay even before its own capture-phase listener would catch them.
`startTour = useCallback(() => setTourOpen(true), [])` is threaded onto `RibbonProps` (so `AppMenu`
and the ribbon's Help button can reach it via `useRibbon()`) and passed directly to `HelpModal` as
`onStartTour` (outside the ribbon prop bag, since `HelpModal` isn't ribbon-context-mounted).
`TourCtx` is a `useMemo` wrapping the existing `ribbonTabSetterRef.current?.(t)` escape hatch (the
same one the Quick Actions bar's "More…" jump already uses — no ribbon refactor needed) plus the
raw `setRibbonCollapsed`/`setSidebarOpen`/`setSidebarTab`/`setLeftToolbarOpen` setters. ⚠️ **The
overlay mounts only inside App's `if (world) { return … }` editor branch** — the standing
two-`return`-branches warning (see "App.tsx state & patterns" below) applies here too.

**Anchors** are inert `data-tour`/`data-group` attributes with zero behaviour change on their own:
`Group`'s shell div in `ribbon/primitives.tsx` (`data-group={id}`, both the compact-tier and
full/medium variant) is what makes `#ribbon-tabpanel [data-group="tools"]`-style selectors work;
`Sidebar.tsx` carries `data-tour="sidebar"` on its open-panel root and `data-tab={t.id}` per tab;
`LeftToolbar.tsx`/`QuickActionsBar.tsx` carry `data-tour="left-toolbar"`/`"quick-actions"` on their
roots; `App.tsx` carries `data-tour="map"` on the non-quad map wrapper and the quad view's
top-left cell (mutually exclusive via `showSlicePanels`, since the quad grid stays mounted-but-
hidden once the 3D pane has been used this session — its cell's attribute is conditional on
`showSlicePanels` too, so `document.querySelector` never resolves to the hidden copy) and
`data-tour="status-bar"` on `statusBarEl`; `WorldNamePill.tsx` carries `data-tour="world-pill"`.
⚠️ **`Group` ids are not globally unique** (`tools` exists on both Draw and Sculpt, `toolopts`
repeats within Sculpt) — only one tab is mounted at a time, but every group selector in
`steps.tsx` is still scoped under `#ribbon-tabpanel` to be unambiguous.

**Settings:** `AppSettings.tourVersion` (default `0`) gates the auto-trigger — both a fresh install
and every pre-existing one (whose stored blob predates the field and gets `0` from the
`{...DEFAULTS, ...parsed}` merge) trigger the tour once. `SETTINGS_VERSION` 11 → 12, comment-only
migration case (purely additive). `bump-version.sh` is the single writer of `TOUR_VERSION` — its
prompt is hoisted above the script's "version unchanged → exit 0" early return, so re-onboarding
existing users doesn't require an app version bump in the same run.

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
  autoOrient3d, memoryBudget, settingsVersion, … }` (list not exhaustive — see
  `SettingsModal.tsx` for the full field set, which has grown past this excerpt).
  `loadSettings()`/`saveSettings()` use
  `localStorage` key `eden_settings`. `saveSettingsDebounced` (250 ms) for slider
  drags. `memoryBudget` ("low"|"balanced"|"high", 2026-08 memory-efficiency pass)
  indexes `MEMORY_PRESETS` for the undo/tile/vertex ceilings — see CLAUDE.md's
  "Memory Budget" section.
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

### Long-operation overlay (`LongOpOverlay`, audit C6 + M14, 2026-08-20)

One modal overlay for every long-running backend operation — PNG/OBJ/JSON/VOX export,
full save, compressed save — plus the world-load spinner when its `op` prop is null.
It replaced four hand-rolled overlays that between them offered six different levels of
feedback (a percentage bar, an indeterminate shimmer, two static "Exporting X…" labels)
and no Cancel at all.

- State is a single `longOp: LongOpState | null`, fed by the backend's `long-op` event
  (see [04](./04-ipc-reference.md#long-operations-longops-audit-c6--m14-2026-08-20)).
  The listener **merges** progress events onto the opening event rather than replacing
  it, so `label`/`cancellable` survive; a `finished` for an id no longer showing is
  ignored, so a late event can't blank the current operation.
- Adding progress to a new command is a `LongOps::begin` call in Rust and *nothing*
  on this side.
- `pointerEvents` is `"auto"` only while the operation is cancellable; otherwise the
  overlay stays click-through inert, as the old one always was.
- `reportExportError` swallows `"Cancelled"` — a cancel the user asked for should not
  raise a red toast. Every other failure still goes through `reportError`.
- `RibbonProps.longOpKind` (one string) replaced the three `exporting` /
  `exportingObj` / `exportingJson` booleans; `AppMenu`'s export rows key their busy
  spinner off it.
- Styled from `ribbon/tokens`, per H10's "finish the migration" direction.

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
