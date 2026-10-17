---
layout: doc
title: "Frontend"
subtitle: "The React component map, the ribbon, windows and UI conventions."
---
{% raw %}
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
| `src/panels/` | `AboutPanel` / `WorldInfoPanel`: shared by the application menu and their modals. |
| `MapCanvas.tsx` (~2700 L) | 2D map: pan/zoom/select/paste/draw, `DragOp` input, right-click menu. |
| `FlyView3D.tsx` (~4300 L) | Streaming fly-through 3D pane (Three.js + OrbitControls). |
| `Sidebar.tsx` | Docked right-edge tabbed panel (Inspector / Prefabs / History) + collapse rail + drag-resize. |
| `SelectionInspector.tsx` | Sidebar Inspector tab: selection stats, signs and clipboard info. It has no renders of its own: the front/side/top views are in the Lens window. |
| `BlockPaintPicker.tsx` | Reusable block+paint picker (fill / filter modes), texture swatches. |
| `PrefabLibraryPanel.tsx` | Dockable prefab gallery. |
| `QuickActionsBar.tsx` | Floating pill under the ribbon: selection copy/fill/delete + clipboard paste/Z-offset/rotate/mirror. |
| `theme/theme.ts`, `theme/cssVars.ts`, `theme/ThemeStyle.tsx` | The one theme module: palette A ramp → semantic roles → `--vx-…` CSS custom properties, WCAG helpers, gloss-lite material + the pushed-in current-item recipe. `contrast.test.ts` / `cssVars.test.ts`. |
| `windows/` | Floating-window framework: `windowGeometry.ts` (pure snap/clamp/anchor/collapse), `windowStorage.ts` (per-world persistence), `layoutState.ts` (`pane3dLive` + viewport placement), `useWindowLayout.ts` (store), `FloatingWindow.tsx`, `WindowLayer.tsx`, `Reparentable.tsx` (render-once/move viewports), `ToolsWindow.tsx` (was `LeftToolbar.tsx`), `View3DWindow.tsx`, `HotbarWindow.tsx`, `LensWindow.tsx`, `windowSeed.ts`. |
| `lens/` | The Lens: `lensMode.ts` (pure mode + ⌥P/✕ toggle rules), `lensPlacement.ts` (pure attach-position + aspect-layout), `lensScheduler.ts` (pure request-scheduler reducer), `useLensFetch.ts` (the shared throttle + scheduler loop), `useLensRender.ts` (its paste wrapper, `render_paste_lens`), `LensView.tsx` (the imperative canvas viewer both modes use), `lensViewMath.ts` (pure zoom/pan/hit/band math). |
| `NewWorldModal.tsx` | New world dialog (Flat / Natural / Classic / Tg2). |
| `WorldBrowserModal.tsx` | Search/download worlds from Eden servers. |
| `UploadModal.tsx` | Upload world + thumbnail. |
| `MaterializeModal.tsx` | Materialize-from-template / expand-from-template progress + confirm dialog. |
| `WorldInfoModal.tsx` | Thin `Modal` wrapper around `WorldInfoPanel`. |
| `SettingsModal.tsx` | Persistent app settings. |
| `HelpModal.tsx` | Shortcuts + texture-pack help. |
| `AboutModal.tsx` | Thin `Modal` wrapper around `AboutPanel` (also mounted by the splash screen). |
| `RecoveryModal.tsx` | Autosave crash-recovery prompt. |
| `Modal.tsx` | Shared modal shell (backdrop + Escape + focus-trap + ARIA). |
| `src/ui/Dialog.tsx` + `DialogNav.tsx` + `dialogSize.ts` | The shared dialog chrome every `*Modal.tsx` renders through, see "Dialogs" below. |
| `ErrorBoundary.tsx` | Inline error fallback wrapping the 3D pane (and other isolated panes). |
| `NumberField.tsx` | Numeric input that doesn't clamp mid-keystroke. |
| `maskUtils.ts` | Shaped-selection mask helpers (e.g. `decomposeMask` for the 3D fly-view overlay). |

### Support modules

| File | Role |
|---|---|
| `types.ts` | Shared IPC-shape types mirroring Rust structs. **Import from here.** |
| `codec.ts` | Binary-IPC framing primitives (`decodeEnvelope`, `splitBody`, `asF32`) + `encodeU8` for the JS → Rust direction. The typed `decode*` helpers live in `types.ts`. |
| `blockDefs.ts` | `BLOCK_DEFS`, `PAINT_COLORS`, ramp helpers, `resolveColor`; `applyBlockTables()`. |
| `drawTools.ts` | `penFootprint`, `brushFootprint`, `bresenhamLine`, `rectPixels`, `ellipsePixels`. |
| `texturePack.ts` | Atlas decoder, `BLOCK_TOP_TEX`, `tintedSwatch`. |
| `designTokens.ts` | The modal backdrop scrim (`glassBackdrop`) + small stateless recipes dialog bodies still reach for directly (`accentRing`, `recessedWell`, `expBadge`/`perfBadge`/`wipBadge`, `spinnerStyle`, `MODAL_TEXT`). The older panel/button chrome (`glassPanel`, `chromeButton(Accent)`, `glassTab`, `glassMenuPanel`, `EDEN_TEAL_READABLE`) is retired. See "Dialogs" below. |
| `viewportUtils.ts` | Pure canvas helpers (`zoomAtPoint`, `resizeCanvasToContainer`, `beginFrame`…). |
| `useRecentWorlds.ts` | `localStorage` MRU world list + `timeAgo()`. |

## UI shell: the Ribbon (`Ribbon.tsx` + `src/ribbon/`)

`Ribbon.tsx` is a thin shell (~250 L); everything visual
lives under `src/ribbon/`. Density target is the **Office 2007–2010 ribbon** -
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
  layout.ts        pure tier solver          layout.test.ts  its unit + property tests
  reveal.ts        ⌘K reveal retry loop, DOM-free       reveal.test.ts
  context.tsx      RibbonContext + useRibbon()      props.ts  RibbonProps / RibbonTab
  sculptTools.ts   the 16 sculpt tools, shared by SculptTab and 3D Sculpt mode
  TopBar.tsx       Menu · Undo/Redo · tabs · world pill · Help · collapse
  BlockButton.tsx  the Block button, swatch + name + caret, opens the
                   shared picker (`src/picker/PickerHost.tsx`)
  PaletteGroup.tsx TextureGroup only now, the palette half moved to BlockButton.tsx
  Cmd.tsx          <Cmd>/CmdSmall/CmdIcon/CmdSplit/CmdDropdown/CmdMenuItem/CmdSetting -
                   the only way a tab renders a command (lint-enforced)
  specs.ts         TAB_SPECS: every tab's label, group ids/labels and solver widths
                   + the floating Hotbar window (`src/windows/HotbarWindow.tsx`)
  tabs/            HomeTab DrawTab SculptTab InsertTab ViewTab ThreeDTab
                   SelectionTab ClipboardTab
```

### Geometry: and why labels can't be clipped

Fixed heights, no drag-resize (collapse remains):

| Token | Value |
|---|---|
| `TOP_BAR_HEIGHT` | 34 |
| `RIBBON_BODY_HEIGHT` | 96 |
| `RIBBON_HEIGHT_COLLAPSED` | 34 (= top bar alone) |
| `GROUP_PAD_TOP` / `GROUP_PAD_BOTTOM` | 3 / 2 |
| `GROUP_CONTENT_H` | 76 |
| `GROUP_LABEL_H` | 15 |
| `LARGE_H` / `SMALL_H` / `ROW_GAP` | 76 / 24 / 2 |

`RIBBON_BODY_HEIGHT = GROUP_PAD_TOP + GROUP_CONTENT_H + GROUP_LABEL_H + GROUP_PAD_BOTTOM`,
asserted at module load. And `3 × SMALL_H + 2 × ROW_GAP = LARGE_H = GROUP_CONTENT_H`,
so a column of three small buttons exactly fills a group. (`layout.test.ts`'s "ribbon
geometry invariants" describe block is the automated copy of both assertions, so a
regression fails in CI, not just at import in a running app.)

⚠️ **`Group` renders its control area as a fixed-height box with `overflow: hidden`,
then the label strip after it.** The old ribbon used `marginTop: auto` on the label,
which meant a group whose rows added up to more than the body pushed its own label
down and off the bottom. Structurally that can no longer happen. The consequence for
authors: **anything needing more than three 24px rows must add a column, not a row** -
see the Rock/Carve group's eight parameters laid out as three columns of three.

**Keycaps.** `LargeButton` (`tier="full"` only) draws a small `Keycap` chip
top-right, `FONT.micro`, mono, absolutely positioned so it never affects the button's
label centring or its measured width. `Cmd` (`ribbon/Cmd.tsx`) is the only source: it
formats the registry's first `keys[0]` chord (`formatChord`, `commands/keys.ts`) and
passes it down only when its own `tier` prop is `"full"`; `CommandButton` drops it before
ever reaching `SmallButton`, so a medium/small row can never grow one by accident, it
keeps carrying the shortcut in its tooltip instead, as before. `Keycap` itself moved from
`commands/CommandPalette.tsx` into `ribbon/primitives.tsx` in the same stage (⌘K's result
rows and the top bar's search-shortcut hint both import it from there now), one
implementation, so the three render a shortcut identically.

### Theme module + gloss-lite

This supersedes the colour half of the section below (its structure, scale names, recipe names and
the "accent names the family" rule still hold).

- **One source.** `src/theme/theme.ts` holds palette A's `RAMP` (hexes verbatim from the design
  exploration's `P.A`) and the roles every call site uses: `SURFACE_ROLES` (bg0, chrome, topbar,
  body, raised, hover, pressed, popover, well, modal, modalRaised), `BORDER_ROLES`, `TEXT_ROLES`
  (primary, secondary, label, **meta**, disabled), `MODAL_TEXT_ROLES`, `ACCENTS` (primary, warm,
  **selection** blue, **clipboard** green, violet), `MAP` (canvas overlay hexes). `cssVars.ts` emits
  them as `--vx-…`; `ThemeStyle` injects that plus the app-wide rules (body colours, the focus ring,
  `.vx-row` current/lift) once, from `main.tsx`.
- **Two consumers, two forms.** Recipes and `SURFACE`/`BORDER` return `var(--vx-…)`; text and accent
  constants stay hex because canvases and `hexToRgbTriplet`/`lighten` need real colours. A canvas
  must never be handed a var string.
- **Focus.** One near-white 2 px ring, `:focus-visible`, `!important` (inline `outline:none` on every
  recipe used to beat the old non-important rules). The cyan `App.css` rule is gone.
- **Contrast gate.** `contrast.test.ts` checks each text role on every surface it is allowed on
  (`CONTRAST_PAIRS`: panels carry all text roles, button faces only primary/secondary), gradients at
  every stop, translucent surfaces composited over their parent. `meta` replaces `disabled` for
  content text. Armed labels are lifted per family (`armedRecipe`) until they clear AA on the label
  band of the armed gradient, open question 7's "lighten the text".
- **gloss-lite.** Softer highlight (~.13), no 48/52 split, a 5 px armed glow; tabs and the brand
  button follow suit. The brand button was then darkened with a steeper gradient on user feedback.
- **Current = pushed in.** `currentRow()`/`liftRow()` (tokens) or `.vx-row` + `data-cur`: app-menu
  command column, sidebar tabs, Settings/Help tabs (`glassTab`), History's current entry,
  `MenuItem`/`Select` current option. No accent underline/strip on any current item.
- **Raw-hex lint.** `no-restricted-syntax` on hex string literals and hex inside template literals,
  as an error for `RAW_HEX_CLEAN_FILES` (ribbon, windows, `Ribbon.tsx`, `designTokens.ts`, …).
  Colour *data* (leaf paints, block tables) is exempted with a scoped disable comment.
- **`Select`** (`ribbon/primitives.tsx`): button + portaled Popover `role="listbox"`; ↓/↑ opens with
  focus on the current option, arrows/Home/End move, Enter picks, Esc/Tab close. Inside a modal pass
  `zIndex={1100}`.

### Visual system (`tokens.ts`)

The architecture above landed with an unsystematised visual layer: four unrelated
aesthetics (translucent white-wash buttons, a cyan default icon tone, a bright blue
floating tab pill, Office group organisation) and **68 hardcoded `accent="#hex"` props
across the 8 tabs in 18 distinct colours**. The restyle keeps every geometry constant
and every primitive signature; only values and recipes changed.

**Scales**: `RADIUS {sm 2, md 3, lg 5}` · `FONT {micro 9, label 10, body 11, tab 12}` ·
`ICON {xs 12, sm 14, lg 24}` · `SPACE {xs 2, sm 4, md 6, lg 8}`. Retired: `fontSize`
6/8/12.5/13 and icon sizes 11/13/15/16/26, none of which had a constant behind them.

**Material.** Every control sits on `SURFACE.raised` (an opaque vertical gradient) with
`inset 0 0 0 1px BORDER.outline, inset 0 1px 0 BORDER.bevel`: deliberately the same
family as `designTokens.chromeButton`, which the QuickActionsBar already used, so the
ribbon and the floating pill match at rest. The radius differs on purpose (3 vs 6): a
docked dense ribbon and a floating pill are different objects. `SURFACE.body` is a
neutral blue-grey vertical gradient; the old `90deg` slate→teal wash is gone, and
`ICON_TONE` moved from cyan `#7fd4e0` to neutral `#c3ccd2`: **cyan now appears only on
active and focus**, which is what stopped it reading as the ribbon's material.

**Five states, defined once:** `btnBase` · `btnHover` (revived; it was dead code) ·
`btnPressed` (**new**: inverted gradient + inner shadow, no `transform`, which would
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
(= `ACCENT.primary`) are separate tokens **on purpose**: both used to be `#00dde9`, so
a focused control and an armed one looked identical.

⚠️ Accents name the **tool family**, not the individual command. Within a tab most
buttons therefore share one accent; that is the system working, not missing variety.
`ThreeDTab`'s `MODES` is the one place a row mixes hues, because each mode hands you a
*different* family (Build/Flood Fill → primary, Sculpt → warm, Camera/Select → violet).

### Tabs

Permanent **Home · Draw · Sculpt · Insert · View**; contextual **3D**
(while the 3D window is showing), **Selection** (`rawBounds`), **Clipboard**
(`clipboard`), each with an appearance flash and its own `CTX_ACCENT` hue (3D violet,
Selection warm, Clipboard green). The flash colour comes from a `--rbn-pulse` CSS custom
property set inline per tab, `@keyframes rbnCtxPulse` used to be hardcoded amber and so
flashed amber for the green Clipboard tab too.

A contextual tab carries its hue as an **Aero-style glow**: a tinted fill, an inset
halo and a matching `text-shadow`: that intensifies sharply on selection. It replaced a
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
| Home | Clipboard · Navigation · Selection · Block · Set Point |
| Draw | Tools · Brush · Options · Block · Mask |
| Sculpt | Sculpt tools · Brush · Falloff · Block (Noise/Slope/Rock/Carve shape → the Brush shape panel) |
| Insert | Prefab · Nature · Fluids · World Extent |
| View | Map View · Render · Zoom · Layout · Windows · Template · Textures (cutaway/Z-slice level → the Cutaway panel) |
| 3D | Mode · Block · Camera · Lighting (Flood Fill limit / 3D Sculpt brush → the Build slot panel) |
| Selection | Modify · Z Range · Move · Fill (Fill+Gradient merged) · Replace · Extrude |
| Clipboard | Preview · Place · Transform · Options · Mode · Prefab |

Moves worth knowing: Materialize Home → Insert; Fluids Selection → Insert (it is
selection-scoped *generation*, exactly like Trees, and Selection was at 8 groups);
Load Prefab / Expand from Template File menu → Insert; the World
readout Home → the top-bar pill; New World / Browse Online Home → the application menu.
(The Insert tab's former Import group, Schematic import, was removed along with
the rest of the format-conversion features; see [EdenToMC](https://github.com/hagg3/EdenToMC).)

Deliberate duplications, each a *shared component*, never a forked path:
Copy/Cut/Delete/Fill/Grow/Shrink/Clear on Home + Selection; Paste/Rotate/Flip on Home
+ Clipboard; `BlockButton` on Home + Draw + Sculpt + 3D (replacing the old
`PaletteGroup`); `TextureGroup` on View + 3D.

### Responsive tiers (`layout.ts`)

```ts
solveLayout(groups: GroupMetrics[], available: number): Record<string, Tier>
```

**The ribbon never scrolls.** The body is `overflowX: hidden`; the solver
guarantees the row fits down to every group collapsed (`minRowWidth`), which every tab
does well inside the 900px minimum window (`specs.test.ts` reads `tauri.conf.json`'s
`minWidth` and asserts it, contextual groups included).

Each group declares `widths: {full, medium, popup}`, a `minTier` floor, a `priority`
and optionally `conditional`. Two passes:
1. **Graceful.** Start everything at `full`; while the row overflows, demote one group
   one tier, down to its `minTier`: choosing **the widest current tier first, then the
   highest priority**. That ordering matters: demoting purely by priority would hide the
   least-important group behind a popup while its neighbours were still full-size, which
   reads as a bug. A tier no narrower than the current one is skipped (several groups'
   `medium` forms measure *wider* than `full`: Home Clipboard/Navigation, Draw Tools,
   Insert Nature, they go straight to `popup`, or stay put if floored).
2. **Last resort.** If every group is at its floor and the row still overflows, collapse
   groups straight to `popup` **ignoring `minTier`**: non-contextual groups first, by
   priority (highest first), then `conditional` ones (a solver capability no tab spec currently uses, since the contextual groups moved into context panels). A clipped group would be
   unreachable, so the floor is a preference, not a guarantee.

Nothing re-promotes, so both passes are monotonic in width (property-tested, seeded).
`minTier: "full"` still keeps a small group whole while anything else can give (MS
guidance: don't collapse a two-command group to a popup icon), View's Render is pinned
this way. Tabs call `solveRow(groups, bodyWidth)` (`specs.ts`), which first takes off the
`GroupDivider`s (3px each) and `RIBBON_TRAIL_RESERVE` (64px, the Compact/Labels toggle's
corner, so the last group's label is never drawn under it).

Tier meanings: `full` = the full layout · `medium` = large buttons become small
icon+label rows (`CommandButton` is the only place that mapping lives) · `popup` = the
MS ribbon guidelines' "pop-up group icon": one full-height button (the group icon in a
32px well, the group name wrapping to two lines, ▾) that opens the group's **full-tier**
content plus its caption in a `Popover` (`role="dialog"`, `autoFocus`). Tabs pass
`contentTier(tier.x)` to their commands, which maps `popup → full`. `popup` is fixed-width
by construction (`POPUP_GROUP_W` = 74; the label clamps instead of widening it), so
`specs.ts`'s `g()` derives it rather than taking a number. Its face uses `Group`'s `name`
prop (defaulting to a string `label`), pass it when the label is JSX or long ("Z Range ·
12 levels" → "Z Range"). A dimmed group's popup button is disabled, with the dim note in its
tooltip. **The Block button is the exception** (MS: a single-button group never becomes a
popup icon): `Group selfCollapsing` lets it draw its own narrow form instead, swatch over
caret, `BLOCK_POPUP_GROUP_W` = 58, still one click to the picker.

Popup behaviour: running any `<Cmd>` from inside closes it (`usePopupGroupClose`, read by
`Cmd.tsx`'s `resolve`), settings (sliders, segmented sets) don't, so tuning several stays one
open. A popover opened *inside* another (a split/dropdown menu or `Select` in a popup group)
registers its panel with every ancestor through `PopoverNestCtx`, so the parent's
outside-click test doesn't close it , so a click in the child menu doesn't close the parent
and unmount the child mid-click. Escape closes one level at a time.

**Overflow net (`Ribbon.tsx`).** Declared widths can go stale (a tab edit, a font), and with
scrolling gone an under-declared group would be clipped. After each solve a layout effect
compares the body's `scrollWidth` to its `clientWidth`; any overshoot is taken off the width
the solver is given and it re-solves before paint (dev builds `console.warn` with the tab
and px, so the spec gets fixed). Keyed on tab + width + compact, grows only, capped at
`bodyWidth`, and skipped until `bodyWidth` matches the element (the first render solves
against the 1400 default). It's a net, not the mechanism: it can only shrink the row as a
whole, so a wrong `medium` makes it collapse neighbours instead of the culprit.

**Tab strip.** At the 900px minimum the tab strip used to clip Insert/View/3D outright (it
had ~300px for 353px of tabs). Now the search field shrinks first (`flexShrink: 50`, down to
its icon; the strip's own weight is 0.001, because flex shrink is proportional, not ordered),
tab side padding scales 13→6px between ~1040 and 900px, and past that tabs truncate with an
ellipsis (`minWidth: 40`) rather than vanish, MS: scaled-down tab names show truncated text.

Widths are **declared, not measured**, which is what keeps the solver pure and
unit-testable. A dev-only `ResizeObserver` in `Group` `console.warn`s on drift, so it is
caught without making the solve non-deterministic.

⚠️ The guard is **two-sided** (`WIDTH_TOLERANCE` 8px). It used to fire only when a group
rendered *wider* than declared, which left the opposite mistake silent: over-declaring
reserves width the group never uses, so the row demotes earlier than it needs to and the
tab carries dead space nothing ever reports. Both directions print the measured pixel
value. There is only **one** copy to paste it
into (`ribbon/specs.ts` `TAB_SPECS`): `g(id, label, full, medium, minTier, priority)`'s `full` argument, because every
tab's `declaredWidth={W("group")}` reads `specWidth(tab, group)` from the same table
rather than repeating the number. Only the `full` tier is checked; `medium`/`compact`
widths live solely in `TAB_SPECS` and are never handed to a `Group`, so there is nothing
to compare them against.

**Width harvester.** The drift guard only
warns for whichever tier is currently rendered, and only one tab is mounted at a time
(`Ribbon.tsx`'s `{activeTab === "…" && <…Tab/>}` chain), so measuring every group at
every tier by hand is "8 tabs × 3 tiers × 4 window widths" of manual work.
`window.__harvestRibbonWidths()` instead clicks through every tab button currently in the
strip, waits two animation frames per tab for React to commit and the browser to lay out,
and reads each `[data-group]` element's rendered width plus the tier `Group` rendered it
at (`data-tier`, added on the same element for this). Readings accumulate into
`window.__ribbonWidthHarvest`, keyed by tab then group (several ids, `block`, `tools`,
`options`, `prefab`, `textures`: repeat across tabs with genuinely different content and
width), across every call in the page session, so running it once per the recommended
window width (1920 / 1440 / 1200 / 900) sweeps every group through full → medium →
popup as the solver naturally demotes it there, and each call's console table fills in
further. Arm a selection, fill the clipboard and open the 3D pane/window first so the
three contextual tabs (and their conditional groups) are in the strip to be measured too.
Registered only under `import.meta.env.DEV` (dead code in a production build), imported
unconditionally by `Ribbon.tsx` for the side effect.

Deleted with this: the `◄ ►` scroll arrows, `updateScrollArrows`/`canScrollLeft/Right`,
the wheel→horizontal remap, the resize grip, and the `ribbon_body_height` key (removed
from `localStorage` on first run). The `overflowX: auto` that remained as a silent last
resort below the minimum width was removed (see "The ribbon never scrolls" above).

### Primitives notes

- Hover, **pressed** and focus rings live in `RIBBON_CSS`, injected once by the shell -
  inline styles can't express `:hover`/`:active`, and per-button state would be ~60
  extra `useState`s per tab. The rules use `!important` scoped by
  `:not([data-active="true"]):not([aria-disabled="true"])`, so an armed button's inline
  accent still wins and a disabled one doesn't light up. A higher-specificity
  `[role="menuitem"]` pair keeps popover rows highlighting instead of growing a bevel.
- **Motion is gated by `data-motion`, not a media query.** The Popover enter
  (fade + scale-in), the contextual-tab fade-in and the Clipboard/Selection tab's flash
  pulse are each written as `:root[data-motion="full"] .x { animation: … }`: no rule at
  all under `"reduced"` (or before the app has resolved a value), so "reduced motion" is
  the *absence* of the rule rather than a second code path. An earlier version disabled
  these via a `@media (prefers-reduced-motion: reduce)` block in this same injected
  `<style>`; it was removed in favour of the shared `useMotionPref()` JS gate (see
  "Onboarding tour" below and `src/theme/motion.ts`) that every motion-gated recipe in the
  app now uses instead.
- Unselected tabs carry `.rbn-tab` purely so CSS can give them a hover state; they are
  not `.rbn-btn`, and before this they had no hover at all.
- Disabled controls use `opacity` + `pointerEvents: none` (layout stability) **and**
  `aria-disabled` + `tabIndex={-1}`: otherwise they stay focusable but unclickable.
- **Keyboard model for menus and radiogroups** **. Every popover
  opener already declared `aria-haspopup="menu"` + `aria-expanded`, so assistive tech
  announced a menu the keyboard could not drive. A `Popover` with `role="menu"` now
  focuses its first enabled `[role="menuitem"]` one frame after mount (deferred, because
  the panel is portaled and positioned in a layout effect, focusing before that lands
  would scroll to the off-screen `-9999` staging position), roves focus on
  Up/Down/Home/End, **closes on Tab** (the ARIA menu convention: a menu is not a dialog,
  so it traps nothing), and restores focus to whatever had it, but only if focus is
  still inside the panel, so a click elsewhere isn't fought. `role="dialog"` panels (the
  block picker, the world pill's details) are deliberately left alone: they own their own
  inner focus order, and stealing it would break the pill's rename field.
  ⚠️ **`onClose` is read through a ref, and the effect is keyed on `role` alone.** Nearly
  every call site passes an inline arrow, so depending on `onClose` directly would re-run
  the effect on every parent render, harmless for the outside-click/Escape listener
  (it just re-registers) but here it would re-fire the focus-first-item step and yank
  focus back to the top of the menu while the user was arrowing through it.
  `Segmented` is now **one** tab stop, not one per option, only the checked option is
  tabbable, and Left/Right/Up/Down move the selection *and* focus (wrapping), with
  Home/End at the ends. `checkedIndex` floors at 0 so a group whose `value` doesn't match
  any option still has exactly one tab stop instead of dropping out of the tab order.
  Still deferred: the block picker's swatches are mouse-only `<div>`s (roving tabindex
  over a swatch grid).
- `Popover` portals to `document.body` for **two** reasons: the ribbon body clips
  overflow, *and* the ribbon root's `z-index: 100` is its own stacking context, so an
  in-tree panel can never rise above the docked sidebar (`z-index: 120`) whatever
  z-index it asks for. Its chrome is `SURFACE.popover`: the ribbon's own material, not
  the app-wide warm-brown `glassMenuPanel`, which read as a foreign object over a cool
  slate ribbon. `Ribbon.tsx`'s `BlockPaintPicker` portal uses the same chrome. Popover
  flips above the anchor when it would overflow the viewport bottom, and handles Escape
  capture-phase with `stopPropagation` so App's global step-back doesn't also fire.
  ⚠️ That Escape listener is **capture-phase on `window`**, so a child input cannot
  `stopPropagation()` its way out of closing the panel, pass `onEscape` when the panel
  owns an inner gesture Escape should step back from first (`WorldNamePill`'s rename).
- **`dismissDelayMs`.** Delays registering the outside-click listener by
  the given ms (default `0`: every pre-existing `Popover` consumer is unaffected).
  Added for `src/ui/ContextMenu.tsx`: a right-click can synthesize a trailing
  mousedown/mouseup on macOS WKWebView *after* the `contextmenu` event that opened the
  menu, which would otherwise read as an outside click and dismiss the menu the instant
  it appears. `ContextMenu` passes `80`, the same value the old hand-rolled context menu
  used for its own (now-removed) delayed listener, this is a strict replacement, not a
  second mechanism running alongside it.
- Small shared parts, each replacing a family of one-offs: `Badge` (was `Exp()` copied
  into four tabs plus `Perf()`) · `FieldLabel` (~16 hand-rolled label spans across eight
  different widths) · `Swatch` (**three** treatments for one concept: the palette hotbar,
  InsertTab's leaf colours, SelectionTab's block chip) · `NumField` (was
  `{...fieldStyle, width: N}` spread at every call site) · `Check` · `MenuSeparator` ·
  `RangeSlider` (the dual-thumb Z-range, promoted out of `SelectionTab` where it was
  hand-built from five untokenised blues).
- One `RAIL_W` (15) for split/chevron rails, `SplitButton` used 16 and `PaletteGroup`
  15. `TOPBAR_BTN_H` (24) replaced an undeclared `23`; `PALETTE_COMPACT_H` was
  deleted once `BlockButton` became its only caller.
- The top-left **brand button** is Office 2010's File tab: permanently filled with
  `ACCENT.primary` (not a neutral control that lights up when open) and carrying the app
  identity, the 20px icon plus the **VuencEdit** wordmark, bold `Vuenc` + regular `Edit`,
  restored from the pre-rewrite ribbon. Its glow widens from 9px to 16px while the menu is
  open. ⚠️ It is `.rbn-brand`, **not** `.rbn-btn`: the neutral hover gradient would stomp
  its accent fill, so it has its own hover/active rules in `RIBBON_CSS`.
- ⚠️ **Undo/Redo in the top bar are fixed-width** (`QAT_W_LABELLED`/`QAT_W_ICON`). Both
  show a stack depth that changes on *every edit*, so an auto-width button shoved the
  whole tab strip sideways each time you drew a block. The count is clamped to `99+` and
  sits in a fixed box with tabular figures.
- `hexToRgbTriplet()` in `tokens.ts` replaces the old `accentRgb()`: a six-entry
  lookup table that silently returned green for any colour not in it.

### Shell services (`context.tsx`)

`useRibbon()` gives a tab `{ p, activeTab, setActiveTab, bodyWidth, pickerKind,
togglePicker, openAppMenu, armTransientTool }`. `RibbonProps` is passed whole rather
than threaded per-tab: only one tab is mounted at a time, so the context's changing
identity costs nothing over the old whole-component re-render.

⚠️ `pickerKind`/`togglePicker` are no longer owned by `Ribbon.tsx` (they were lifted into the
`BlockPaintPicker` portal is an App-level `src/picker/PickerHost.tsx` (`usePickerHost()`) so the
floating Hotbar window's ▣ slot can anchor the same picker without threading it through props.
`Ribbon.tsx` calls `usePickerHost()` and forwards the pair into `RibbonProvider`,
so every tab reads `useRibbon().togglePicker`/`pickerKind`.

⚠️ `armTransientTool(next, escapeTo)` exists because `react-hooks/immutability`
forbids writing a ref reached through a hook's return value. Eyedropper and Pool Fill
need to record `prevToolRef`; only `Ribbon.tsx`, which receives that ref as a prop,
may write it.

Slider *display* values (z-slice, sun, lamp radius, fly speed, render distance) live
in their own tab modules, synced from the committed prop by the render-phase derived
-state pattern. This improves on the previous convention: a drag now re-renders one
tab instead of the whole ribbon.

### Palette

The old `PaletteGroup` (full split-button + inline pinned/recent rows, one `compact`
variant) is gone. It split into two pieces:

- **`BlockButton`** (`src/ribbon/BlockButton.tsx`), one fixed-width control (swatch +
  ellipsised name + caret), four call sites (Home, Draw, Sculpt, 3D Build's mode slot).
  It reads `fillBlockType`/`fillPaint` off context, so three divergent palette states
  are structurally impossible, and opens the shared picker via `togglePicker(e,
  pickerKind)`: `block-draw` on Home/Draw/Sculpt, `build-3d` on 3D. Fixed-width by
  construction (no `full`/`compact` tiers to solve between); `declaredWidth` is a
  provisional 134px on the three tabs with their own "block" SPECS entry. 3D's Auto-orient check lives in the 3D tab's **Mode** group instead, the fixed-width
  Block button has no room for a second row.
- **`HotbarWindow`** (`src/windows/HotbarWindow.tsx`), the pinned/recent rows, now a
  floating window: ▣ (opens the picker, anchored on itself) + 5 pinned (keys 1–5) + 5
  recent (keys 6–0, dashed outline). Reflows 1 row / 2 rows / a column to the body's
  live size (`hotbarGrid(w,h)`, `windowGeometry.ts`, slot clamped 24–44px). The
  selected slot renders `currentRow()` (`ribbon/tokens`: the same pushed-in "current
  item" recipe as app-menu rows/sidebar tabs) with a 2px `ACCENT.primary` inner ring
  composed on top, replacing the old `ARMED_RING`-outside-the-cell treatment. State is
  `useHotbar()` (`src/hotbar/useHotbar.ts`), extracted out of App verbatim, same
  `HOTBAR_PINNED_KEY`/`HOTBAR_RECENT_KEY` storage keys and array format, so App's
  global digit-key handler and this window share one source of truth with no fork.

Exactly one `BlockPaintPicker` portal exists, `src/picker/PickerHost.tsx`, shared by
every `BlockButton`, the Hotbar's ▣ slot, and SelectionTab's `block-fill`/`gradient-to`/
`filter` pickers (untouched by this stage). It opens *above* its anchor when the anchor
sits in the screen's lower half (the Hotbar's default dock), from an estimated height
corrected by a post-mount viewport clamp once the picker's real size is known, note
that `togglePicker` must read `e.currentTarget` synchronously in the event handler, never inside a
`setState` updater (StrictMode re-invokes updaters outside that window and a null `currentTarget` would throw).


### Command registry + ⌘K

`src/commands/`: `meta.ts` (static `COMMAND_META`, node-importable), `bind.ts`
(`bindCommands(ctx)` → per-command `run` / `enabled: true | reason` / `armed` /
`labelOverride` / `titleOverride`), `keys.ts` (chords, scopes, platform display,
`matchChord` with the AltGr guard), `search.ts` (rank + MRU), `paths.ts`,
`CommandPalette.tsx`, `ShortcutTable.tsx` (Help). Ids are
`<tab>.<group>.<verb>` (`paste.*` for the Clipboard tab) or `app.*`.

- **Tabs don't own handlers any more.** Every ribbon button is a `<Cmd id>` (or a
  sibling wrapper) that resolves label, icon, family accent, tooltip + chord,
  disabled reason and armed state from the registry. What a tab may still choose
  is presentation: tier, `full`, a shorter placement `label`, `check` (the " ✓"
  toggle idiom), `badge`, an `active` override for split faces. Sliders, segments
  and fields stay ordinary controls wrapped in `CmdSetting` so ⌘K can reveal and
  focus them (`kind: "setting"`, never "run"). Custom-faced picker chips
  (`BlockButton`, Selection's Write/Fade/Filter) call their binding's `run`.
- **Ribbon-shell state bindings need**
  lives in `Ribbon.tsx`, not in a tab, so ⌘K sees the same value.
- **Picker commands** open through `togglePickerFor(kind, id)`: find the
  `[data-cmd=id]` element, measure it, `togglePickerAt(rect, kind)`; if it isn't
  on screen, reveal it first and open once it is.
- **⌘K**: capture-phase listener in `Ribbon.tsx`, inert while any
  `[aria-modal="true"]` exists; Ctrl+K is `preventDefault`ed. The top bar's
  "Search commands" field opens it too. Rows show label, path (`TEXT_META`),
  keycap, disabled reason; the highlighted row is pushed-in. ↵ runs (a disabled
  command toasts its reason instead), Tab reveals, Esc closes. MRU in
  `localStorage` `eden_cmd_mru`.
- **Reveal**: switch tab (preferring a placement on the active tab, `also`
  paths), peek a collapsed ribbon, then `runReveal` (`ribbon/reveal.ts`):
  each frame, look for the control; if it isn't rendered, click the next opener
  that isn't already expanded, the popup group's `data-group-chevron` button,
  then any compact-ribbon overflow button whose `data-overflow-chevron` lists the
  group, each at most once, for up to 6 frames. Found → `.cmd-flash` (static
  outline; the pulse only runs under `:root[data-motion="full"]`) and focus.
  DOM-free with injected lookups, so `reveal.test.ts` covers it in node vitest.
  Commands inside a `MoreChevron`/split/dropdown menu still reveal nothing (the menu
  stays shut, which menu holds them isn't knowable until it renders).
- **Dev tripwire**: `UnmarkedButtonCheck` warns about a `button.rbn-btn` in the
  tab panel outside `data-cmd` (Segmented/Select options, `data-group-chevron`
  popup buttons and `data-no-cmd` chrome, incl. the compact overflow button, are exempt).

### Compact command-bar ribbon

`src/ribbon/CompactRibbon.tsx` + `src/ribbon/compactSpecs.ts`. An alternative
ribbon body, a 32px icon-only command row over a 28px settings row
(`CMD_BAR_H`/`OPT_BAR_H` in `ribbon/tokens.ts`, summing to
`COMPACT_BODY_HEIGHT`), in place of the labelled ~96px body. Gated on
`AppSettings.ribbonCompact` (default `false`); **never the default layout**.

- **`Ribbon.tsx` picks the body**: `p.compact ? <CompactRibbon/> : <the eight
  tab components>`, inside the same `#ribbon-tabpanel` wrapper either way, the
  tab strip, top bar, application menu and ⌘K are unaffected.
  `ribbonHeight(collapsed, compact)` (exported from both `ribbon/tokens.ts` and
  `Ribbon.tsx`) grew a second boolean param and stays the **one** source
  `App.tsx`'s `effectiveRibbonHeight` reads, the sidebar, the floating-window
  layer and the Quick Actions bar all key off that one derived value, so none
  of them needed to learn about compact mode directly.
- **One registry, two renderers.** `compactSpecs.ts`'s pure `commandBarGroups(tab)`
  / `optionsBarGroups(tab)` bucket every `COMMAND_META` id into its
  `TAB_SPECS` group using the id's `path` **or any `also` placement**: the same
  multi-placement mechanism the labelled tabs already use by hand (e.g. Home's
  Copy/Cut also on Selection's Modify group). A `{ panel }` placement (Sculpt's tools and
  brush sliders → the 3D Build slot panel) is invisible to the compact ribbon and to the tab tests,
  and only steers ⌘K reveal (below). `kind:"setting"` ids go
  to the options row; everything else except `kind:"menu"` (whose members -
  e.g. Paste Mode's Single/Scatter/Array, already render individually as their
  own toggles) goes to the icon row. This is what keeps the two renderers from
  drifting on *which* commands exist, their labels/icons/enabled/armed state -
  only *how densely* they're drawn differs.
- **Settings widgets are the one hand-written part.** The registry has no
  generic way to describe a `kind:"setting"` command's actual control (a
  slider/segmented/select bound to one specific `RibbonProps` field), so
  `CompactRibbon.tsx`'s `SettingWidget` is a switch over the 17 current setting
  ids, each reusing the *exact* control (same min/max/step/labels/accent) its
  labelled tab already renders, copied, not reinvented, so behaviour can't
  fork even though the JSX is duplicated. `3d.camera.flySpeed`/`.distance` keep
  the same drag-time display/commit split `ThreeDTab` uses. `SETTING_WIDGET_IDS`
  (declared next to the switch) is checked against the registry's own
  `kind:"setting"` set by `compactSpecs.test.ts`: the drift guard for "a new
  setting command was added without a compact widget."
- **Tour/⌘K compatibility, no special-casing needed.** Every group wrapper
  keeps `data-group={id}` under `#ribbon-tabpanel` (a group already claimed by
  the command bar isn't repeated by the options bar, so a selector can't
  resolve to two elements), so every existing tour anchor and ⌘K reveal target
  resolves identically in both modes.
- **The "Compact"/"Labels" toggle** is a small chip pinned to the ribbon's
  bottom-right corner (writes straight through
  `saveSettings` immediately (the `sidebarOpen`/`showQuickActions` idiom, not
  gated behind the Settings modal's Save button). Also a registered command
  (`app.compactRibbon`, reachable from ⌘K) and a checkbox in Settings ▸ Layout
  & windows ▸ Ribbon.
- **Never scrolls either.** Both rows are `OverflowRow`s: whatever
  doesn't fit moves, whole group by whole group from the end, behind a trailing
  **More ▾** button (MS: "toolbars scale using an overflow button") whose popover
  lists them; running a command from it closes it. No declared widths here, each
  item's width is cached the last time it rendered, and an unmeasured item forces
  one full render inside the layout effect (before paint) to learn it; keyed per
  tab. The button carries `data-overflow-chevron="g1 g2 …"` so ⌘K's reveal can
  open the one holding a group. The options row keeps `RIBBON_TRAIL_RESERVE` of
  right padding so its More button never sits under the Labels toggle.
- **Known simplification**: compact mode doesn't replicate the labelled
  ribbon's per-armed-tool dimming of an inapplicable setting (e.g. Draw's
  brush-shape row, which the labelled tab greys out for tools that don't use a
  shape), cosmetic only, every widget still reflects and writes the real
  value.

## Dialogs
renders `Dialog` instead of hand-rolling chrome, `ui/dialogs.test.ts` greps every one of them to
enforce it, and to ban re-importing the retired `glassPanel`/`glassTab`/`chromeButton(Accent)`
recipes from `designTokens.ts`.

- **One primitive, fixed size classes.** `Dialog` wraps `Modal` (backdrop, focus trap, Esc,
  `role="dialog"`: unchanged) and owns the rest: a `sm` (440 w, content-height) / `md` (760×540) /
  `lg` (920×600) frame, an optional `icon`/`title`/`meta` title bar, an optional `DialogNav` side
  column, a scrolling body, and an optional fixed 48px footer. `sm` has no fixed height, a
  single-purpose confirmation has no tabs to jump between, so nothing can make its frame move under
  the user; `md`/`lg` are fixed on both axes and the body scrolls instead.
- **Clamp, never grow.** The rendered frame is `min(nominal, 100vw − 48, 100vh − 48)` per axis -
  pure `dialogFrame(size, vw, vh)` in `ui/dialogSize.ts`, unit-tested in `dialogSize.test.ts`. The
  frame depends only on the size class and the viewport, **never on content**: the fix for
  "Settings visibly grows and shrinks when you switch tabs".
- **`DialogNav`** (`ui/DialogNav.tsx`): a 184px left column on a recessed strip of the *modal*
  surface (`modalNav`, not the ribbon's slate), rows of icon + label + optional one-line
  description on the pushed-in `currentRow()` recipe (same as the app menu, sidebar tabs and
  History), no underline, no accent strip. `role="tablist"` + `aria-orientation="vertical"` with
  ↑/↓/Home/End roving focus, an optional footer slot (World Browser's server picker, Help's "Take
  the tour"). A dialog with no side navigation just omits `nav`.
- **`DialogButton`** (`neutral` | `primary` | `danger`): built on the ribbon's `btnBase` +
  `armedRecipe(ACCENT.primary)` for `primary`, so a dialog's Save reads like an armed ribbon
  button, this is what retired `chromeButton`/`chromeButtonAccent`. The `footer` prop is a plain
  right-aligned button row; a caller wanting a left-aligned secondary action (Settings' "Reset to
  defaults") gives that button `style={{ marginRight: "auto" }}` instead of a dedicated slot.
- **Backdrop clicks never close a dialog** (`Dialog` passes `closeOnBackdrop={false}`; guarded in
  `ui/dialogs.test.ts`). Esc and the ✕ close it; Esc is kept deliberately (keyboard convention).
- **`busy`** disables Esc and the ✕ together, the pre-existing "can't dismiss
  mid-operation" convention (Recovery, Materialize, Upload, New World).
- **Z-order via context, not a per-call prop.** `Dialog` provides its `zIndex` (default 1000)
  through `DialogLayerContext`; `Popover`/`Select` (`ribbon/primitives.tsx`) read it and default to
  `zIndex + 100`. That retires the old "remember to pass `zIndex={1100}` for anything opened inside
  a modal" rule, an explicit `zIndex` prop still wins if a call site passes one.
- **Motion:** the enter animation (`vxDialogIn`, scale+fade) is written under
  `:root[data-motion="full"]` only (the app-wide motion gate), no
  `@media (prefers-reduced-motion)` block, since that combination previously froze under WKWebView
  during the onboarding tour.
- `Dialog` deliberately doesn't import anything from `src/windows/`: a dialog can open before any
  world (and therefore any window layout) exists, e.g. `AboutModal` from the splash screen.

### Confirm dialogs

`confirmDialog(message, { title, okLabel?, cancelLabel?, kind?: "neutral" | "danger", icon? })`
returns `Promise<boolean>`, the same call shape as plugin-dialog's `ask`, which it replaced at all
five App.tsx sites (discard on open/close/quit, overwrite on Save As, save-before-upload). A
module-level queue shows one at a time, rendered by the single `<ConfirmHost />` App mounts in both
the splash and editor branches. It sits at `zIndex` 3000, so a confirm raised from inside another
dialog stays on top. Enter confirms (capture phase), and Esc/backdrop/✕ cancel. `useConfirmOpen()`
feeds `anyModalOpen`. `ui/dialogs.test.ts` bans importing `ask`/`message`/`confirm` from
plugin-dialog, and `window.confirm/alert/prompt`, anywhere in `src/`. The OS file pickers stay
native on purpose.

The Expand from Template dialog, which was hand-rolled inline in App.tsx and so escaped the
`*Modal.tsx` guard, is on `Dialog` too, with a `Segmented` in place of its native radios.

## Floating windows

- **Work area** (`[data-work-area]` in App): between the ribbon (+ QAB) and the status bar, left of
  the sidebar. Holds the main viewport and `WindowLayer` (z 20, `overflow:hidden`,
  `pointer-events:none` except window frames and the drag shield).
- **`FloatingWindow`**: title bar (icon, title, meta, buttons, collapse, ✕), body, 8 grips. Drag and
  resize run on refs with `setPointerCapture` and a 3 px threshold; the frame's style is written per
  rAF and the store is updated once on pointer-up. Click-to-front is a native capture listener
  (portal content bubbles React events to App, not to the window). Keyboard on a focused title bar:
  arrows move 8 (⇧ 32), ⌥arrows resize SE, Enter collapses, Esc/Delete return focus to the map (Esc
  never closes a window).
- **Geometry** (`windowGeometry.ts`): anchor (`l|c|r`, `t|b`) + offsets; `rectOf(state, work, limits)` derives
  the rendered rect, shrinking/clamping for display only.
- **Size limits**. `winLimits(id, work)` → `{ min, max, fit? }` per window; `MIN_SIZE` is
  just its `min` half. Tools/Hotbar are *content-sized*: `min` = the tightest reflow's extents
  (title bar included) and `max` = the natural size of the widest/tallest reflow (Hotbar at the 44 px
  slot cap; the lens is capped at 640×420, ~2× its default, since it's a preview), so there is no padding-only growth. A per-axis box can't say "wide-and-short *or*
  narrow-and-tall, but never small-and-small", so those two also carry `fit(w, h)`, which grows a size
  that is inside the box but clips every reflow to the nearest one that doesn't (`growToOption`).
  `rectOf` applies it for display (so an out-of-range stored size heals), `resizeRect` applies it while
  dragging (growing the dragged edge, sliding back inside the work area rather than shrinking below
  the fit). 3D view and lens: `max` = the work area. `toolsDims`/`hotbarDims` are the single source
  shared by the reflow pickers (`toolsGridCols`/`hotbarGrid`) and the limits. `hotbarGrid` now
  prefers a column count whose slots reach 24 px over one that would be clamped up and overflow.
  `windowStorage.sanitizeLayout` clamps stored Tools/Hotbar sizes into the static limits on load.
  Property tests in `windowGeometry.test.ts` (any resize sequence stays in [min, max] and inside the
  work area; Tools/Hotbar never end a resize clipped). Snap 12 px to an 8 px margin and the
  centre line. Collapse keeps the title bar in place; expand pushes up if needed. Enlarge toggles to
  55 % of the work width, bottom-right.
- **Persistence** (`windowStorage.ts`): per world, path, then `dims|abs_min|format` identity, then
  the last layout left anywhere; LRU 64; written 500 ms after a commit.
- **Viewport hosts** (`Reparentable.tsx`): MapCanvas and FlyView3D each render once into a detached
  host div; `OutPortal`s move the node. `computePlacement` decides what fills the main pane and what the 3D window shows.
- **Store subscription from App** is a short digit-string key (`windowLayoutKey`, 7 chars as of the
  lens), so window drags, work measurements and click-to-front don't re-render App.
- **Tools window** (formerly a docked left toolbar; its old settings are migrated). **3D view window** shows FlyView3D, or
  the map when swapped (⇄ / Tab / ribbon). **Hotbar window**: 11 cells (▣ + pinned ×5 +
  recent ×5), see "Palette" above; open by default, bottom-centre docked; toggle ⌥H / View ▸
  Windows ▸ Hotbar. **Lens window**: see its
  own subsection right below; unlike every other tenant it is only ever mounted while a paste is
  armed or a selection exists, not merely while the lens is enabled.

### Context panels

A context panel is a floating window that belongs to a **mode**, not the user's window set. It
renders only while its `when` predicate holds (always ANDed with "a world is loaded"). It is **not**
in View ▸ Windows and has no ⌥ shortcut. Its ✕ calls `onExit`, which leaves the mode;
with no `onExit` there is no ✕ and the panel just follows its mode (Q3). Geometry, `collapsed` and
`placed` persist per world like any window, but the stored `open` is normalised to true
(`windowStorage.sessionizeContext`). Panels default to top-left (`contextDefault`). Several active
at once stack downward (`stackOffsets`, display-only, registry order), until the user drags, resizes
or nudges one, which sets `WinState.placed` and pins it. Appear/disappear plays the `menu` cue
(`def.cue`). The registry is `CONTEXT_PANELS`; adding a panel = a registry entry + a `defaultWins`
entry + a `winLimits` case + `<ContextPanel when onExit>` in App's `WindowLayer`.

**Mode panels** replaced the three
contextual ribbon groups, so every tab's solver input is now static (`SPECS_WITH_ZLEVEL` and friends
are gone; `tabMetrics`'s `include` argument is unused by any tab):

| Panel (`WinId`) | Replaces | `when` | ✕ |
|---|---|---|---|
| **Cutaway / Z-slice** (`cutaway`) | View `zlevel` | `viewMode ∈ {cutaway, zslice}` | → Top-down |
| **Brush shape** (`brushshape`) | Sculpt `toolopts` | tool ∈ Noise/Slope/Rock/Carve | none (Q3) |
| **Build slot** (`buildslot`) | 3D `slot` | `pane3dLive` and `mode3d ∈ {floodfill, sculpt}` | → Build |

They render in App's `WindowLayer` (outside the ribbon's providers), so their controls are primitives
marked with `CmdSetting` (no binding context needed) rather than `<Cmd>`s. All use `SliderRow` at a
150–180px track. **Content-sized:** `PANEL_SIZES` (windowGeometry) lists each variant's size (Noise vs
Slope vs Rock, Flood Fill vs Sculpt); the panel passes its live one as `ContextPanel`'s `contentSize`,
which `setContentSize` registers *during render* so `winLimits` pins min = max for as long as it is
shown (before that, `winLimits` is the range across variants, which is what storage sanitising sees).
Defaults sit top-left but right of the Tools window's default column. ⌘K: a command can carry a
`{ panel }` `also` placement (the sculpt tools/brush sliders → `buildslot`); `Ribbon.reveal` flashes
the panel's copy (expanding it if collapsed) when the panel is showing and the active tab has no
control of its own (`reveal.ts` `panelToReveal`), else takes the normal tab path. `findCmd` prefers
the ribbon copy, since a command can be marked in both places.

**The Lens is the first client and the documented exception:** `userToggle: true`, so its
session-only flags still gate it, it *is* in View ▸ Windows (⌥P), and its ✕ turns off the flag of
the mode showing rather than disarming the paste or clearing the selection. There are **two** flags: `wins.lens.open` (paste) and `lensSelOn` (selections), both on at launch and never
stored. `ContextPanel`'s `enabled` override picks the current mode's flag.

### Lens window
Backends: `render_paste_lens` (see [Editing, Undo & Clipboard](../editing-undo-clipboard/)) and
`render_selection_lens` (see [2D Rendering](../rendering-2d/)).

One window, one stored rect, two bodies (`lens/lensMode.ts`, pure): **paste** while
`tool === "paste" && clipboard`, else **selection** while a selection exists. A paste wins while
armed, and a paste armed with its flag off shows nothing (it doesn't fall back to the selection).

- **Selection mode**. An `Elevation | Top` `Segmented` (remembered for the session), the live
  `z a–b` readout, a zoom badge, and a legend. Elevation is front + side from one
  `render_selection_lens` call, full height with 7 context columns at 50 % alpha; Top is fetched only
  while chosen. The elevation fetch key has **no z**, so a z drag never refetches; selection mode
  throttles at 150 ms (paste stays 66 ms). The rest is `LensView`: wheel zoom 1×–8× about the cursor,
  drag to pan, double-click to reset; draggable edge handles for the z range (live from the raw
  `zMin`/`zMax`, `onZRangeChange` throttled to ≤15 Hz plus a final commit, Esc reverts); draw on the
  elevation with the pen/brush/rect/ellipse tools (front paints the selection's `y = y1` face, side
  `x = x1`, **one `paint_blocks` call and one undo step per stroke**); a one-column band at the map
  cursor (`MapCanvasRef.subscribeCursor`); z± extrude bands; footprint edge lines. None of it runs
  through React state at pointer rate (refs + rAF). Selection mode never follows the ghost.
  This replaced the Inspector's Elevation and "Front view (ortho)" sections. The Axo preview was
  dropped, not ported.
- **Mount gate.** Rendered (not just visible-vs-collapsed) only while a mode is showing and that
  mode's flag is on: `wins.lens.open` (paste) or `lensSelOn` (selection). Both are **session-only**
  and start `true` at every launch. `windowStorage.sessionizeLens` forces the paste flag on both read
  and write (so a stored `open:false` from an older version can't disable the lens forever), and
  `useWindowLayout.ts`'s module-level `lensEnabled` re-applies it across world switches
  (`withLensFlag`); `lensSelOn` is store-only and never written. Geometry/collapsed/attached stay
  persisted per world. ✕ and ⌥P turn off the flag of the mode showing; with no mode showing, ⌥P turns
  both on if either is off, else both off (`lensToggle`, `setLensFlags`). Turning them on with nothing
  to show fires a one-time toast (`App.tsx`'s `onToggleLensWindow`). Settings ▸ Layout & windows has
  two rows, "Lens while pasting" and "Lens for selections". The default size is 340×240. The paste
  body's Z arrows are the Quick Actions bar's own `IconButton` and play the `nudge` cue.
- **Ghost subscription.** `MapCanvasRef.subscribeGhost(cb): () => void` is a ref-based `Set` of
  callbacks notified from the *same* code in `draw()`'s existing paste-ghost-box branch that already
  computes the ghost's screen rect for drawing (`MapCanvas.tsx`), one computation, so the lens and
  the on-canvas ghost box can never disagree. `GhostInfo = { x, y, screen: {left,top,width,height} }`
  (a plain object, not a real `DOMRect`, so it needs no DOM polyfill in node-environment tests).
  Deduped against the last-notified value so a static hover doesn't refire every `draw()`.
- **Attach/follow.** `WinState` (`windowGeometry.ts`) gained a lens-only, *persisted* `attached?:
  boolean`. `useWindowLayout.ts`'s `followLensPosition(pos)` repositions the lens (anchor `l`/`t` +
  offsets = `pos`) via a plain `set()`: deliberately **not** `commit()`, so it never restarts the
  500 ms persistence debounce or writes a meaningless transient position to `localStorage` (the
  position while attached is always re-derived from the live ghost the next time a paste is armed).
  `lensPlacement.ts`'s pure `attachPosition(ghost, size, work)` computes where: right of the ghost +
  16 px, flipped left if that would cross the work area's right margin, then clamped **fully** inside
  the work area on both axes (an off-screen ghost must never carry the lens off-screen with it). Both the render-input origin
  and the attach-follow reposition are driven off the same `subscribeGhost` callback, but
  they differ: the origin (which drives backend renders) stays throttled to ≤15 Hz
  (`LensWindow.tsx`'s `GHOST_THROTTLE_MS`), while the window *position* is a rAF-coalesced direct
  write of `left`/`top` on the `[data-win="lens"]` element (plus the context-panel stack offset,
  measured from the live element), no React state at pointer rate. The final position is committed
  through `followLensPosition` once the ghost pauses (`FOLLOW_IDLE_MS` 150 ms), goes away, or the lens
  unmounts. Dragging the title bar past
  `FloatingWindow`'s 3 px threshold detaches (`onMoved`); 🔗 (`Link2`/`Link2Off` icons) re-attaches.
  `FloatingWindow` passes `onMoved` the gesture kind (`"move"` | `"resize"`), so resizing an attached
  lens leaves it attached. 🔗 is disabled (`LensWindow`'s `mapVisible` prop, `placement.main !== "fly"`) while
  the 3D view is the main pane, there's no ghost on screen there, so the lens floats at its stored
  rect instead.
- **Request scheduler** (`src/lens/useLensFetch.ts` + `lensScheduler.ts`; `useLensRender.ts` is the paste wrapper). `reduceLensScheduler` is
  a pure `(state, event) → { state, fire }` reducer (unit-tested with no timers/DOM/`invoke`):
  `request`/`success`/`failure` events, one key in flight, a burst of newer requests coalesces to at
  most one more fetch after the in-flight one resolves, and a failed key is parked, never retried in
  a loop, until a genuinely different key arrives. The hook wraps it with the actual `invoke`s (front
  + side fetched together per key) and the same ≤15 Hz throttle the ghost subscription needs.
  `enabled=false` (collapsed, closed, no paste armed, or scatter/array mode, which has no single
  footprint) fully resets the scheduler and reports idle, no request is ever in flight while nothing
  would be shown.
- **Drawing.** Each of the two canvases blits the backend's already-coloured RGBA raster (terrain,
  ghost tinted clipboard-green, buried red, cleared amber hatch, all composited server-side, see
  `voxel_core::render::paste_lens`'s doc comment) through an offscreen canvas + nearest-neighbour
  `drawImage` (never `canvas.width` for layout math, HiDPI via `viewportUtils`' `beginFrame`/
  `resizeCanvasToContainer`, same as every other viewport pane), then draws its own Z ruler (ticks
  every 8 world Z, labelled every 16, row 0 = `data.zHi`) and a dashed line at the ghost's lowest row
  (`data.ghostZMin`). Colours are imported from `theme.ts` (`RAMP.mapBg`, `MAP.buried`/`MAP.cleared`/
  `MAP.air`, `ACCENT.clipboard`), a canvas can't read `--vx-…` CSS vars. `src/lens/**` is in
  `eslint.config.js`'s raw-hex-clean file list alongside `src/windows/**`.
- **Layout.** Side-by-side (front | side) vs. stacked is decided from the body's own `ResizeObserver`
  measurement (`lensPlacement.ts`'s pure `bodyAspectLayout(w, h)`), not a CSS container query, one
  layout mechanism, matching the rest of the windows framework. Legend/hint hide below 330 px body width.
- **Z controls.** The ▲/▼ stepper and value are bound to the *same* `pasteElevationOffset` App state
  the QuickActionsBar stepper and PgUp/PgDn already drive, there is no second copy anywhere in this
  feature.
- **Look-mode safety:** every host move calls `exitLook()` first. Only while in **mouselook** in the
  3D main pane is the window layer click-through (`passThrough`, fed by FlyView3D's `onLookChange`).
  Fly mode leaves the cursor free, so windows stay live there, and a pointerdown on the map host
  while flying calls `exitWalk()` (back to orbit), so the map gets the click and the keyboard.
  Cursor grab: macOS always takes the native grab. WKWebView exposes
  `requestPointerLock` but denies it silently, and the old "no Promise returned = it worked" branch
  left the cursor free in look mode. Elsewhere a lock only counts once `pointerLockElement` confirms
  it; `pointerlockerror`, a rejection or a 400 ms watchdog fall back to the native grab, and only
  if look mode is still active.

## Docked sidebar (`Sidebar.tsx`) 

The sidebar was the app's third competing visual system: warm-brown
`glassPanel`/`glassTab`, text-only tabs and its own eight hard-coded greys, sitting
flush against a cool-slate ribbon. It is now built from `ribbon/tokens` +
`ribbon/icons`. **Nothing about the layout changed**: same `MIN_WIDTH`/`MAX_WIDTH`
(200/420), same `COLLAPSED_RAIL` (28), same left-edge drag-resize, same
`z-index: 120`: only the material, the type tones and the tab glyphs.

- Shell: `SURFACE.body` with a `BORDER.outline`/`BORDER.bevel` inset left edge in place
  of the old glass panel + outer shadow pair.
- Tab strip: `role="tablist"` on `SURFACE.topbar`, each tab a `.rbn-tab` (not
  `.rbn-btn`: the latter's hover grows a *raised* face, wrong for a flat strip) with a
  lucide icon and an `ACCENT.primary` underline when selected, so a selected sidebar tab
  reads the same way a selected ribbon tab does. Inspector carries the **selection**
  glyph rather than a generic "info" one, because that is what it reads out.
- The collapse rail and the collapse button use `Icon name="left"/"right"` instead of
  `◀`/`▶` text glyphs.
- The three content components inside it were migrated in the same pass
  (`SelectionInspector`, `PrefabLibraryPanel`, and the since-removed elevation panel), a slate shell
  wrapped around warm-brown content would have read worse than either end state. Their
  ~40 raw hex values map onto `TEXT`/`TEXT_DIM`/`TEXT_LABEL`/`TEXT_DISABLED` and the
  four sanctioned `ACCENT` hues (clipboard green, axo violet, armed teal);
  `PrefabLibraryPanel`'s `chromeButton` calls became a local `panelBtn` over `btnBase`,
  and its `✓ ✗ ✎ 🗑 ▦ ☰` emoji became lucide icons.
- Still warm-brown, deliberately: `designTokens.ts` is now used by modals, the app menu
  and a few App-level surfaces only ; the intent is an explicit, consistent *second* surface for modals rather than eliminating it.

### Property grid + status bar segments

**`src/ui/PropertyGrid.tsx`**: `Section` (collapsible header: chevron + title + optional
mono `meta` on the right, body when open) and `PropRow`/`PropGrid` (label/value rows -
`TEXT_LABEL` label, right-aligned tabular-nums monospace value). New file, listed in
`eslint.config.js`'s `RAW_HEX_CLEAN_FILES`: no raw hex. A `Section`'s open/closed state
persists in one raw localStorage key, `sidebar_sections` (mirrors `ribbon_collapsed`),
keyed by the `id` prop passed at each call site; a module-level cache means every
`Section` mounted at once shares one parsed blob instead of each re-reading
`localStorage`. ⚠️ Ids are **not** namespaced beyond "unique within the sidebar", same
trap as the ribbon's `Group` ids across tabs.

`SelectionInspector.tsx` renders its content as a stack of these sections, in this order: **Selection** (`PropGrid`: Size, Z range,
Volume, Bounds, Shape, all derived client-side from the existing `describe_selection`
response, no new IPC; rows that no command backs are not shown rather than faked with wrong data),
*(Extrude is only in the ribbon Selection tab. Front view and Elevation are in the Lens window.)*
**Signs** (moved out of `Sidebar.tsx`, where it used to be a standalone component above
`SelectionInspector` with its own ▶/▼ header, now a `Section` here with the same rows +
"show N more" body, only rendered when the world has signs).

`PrefabLibraryPanel.tsx`'s list view got denser to match: 28px thumbnail (was 40px),
`3px 6px` row padding (was `5px`), `2px` row gap (was `6px`), grid view (64px cards)
unchanged.

**Status bar**: every segment now renders through one `StatusSeg` helper (`App.tsx`,
declared next to `FpsCounter`): a leading `ICON.xs` glyph + content + a right hairline
divider, `height:"100%"` inside the fixed 22px bar (`STATUS_BAR_HEIGHT`, unchanged).
`CursorHud`/`SelStatusHud` use it internally for their own rows, **their imperative-leaf
contract is unchanged**, they still own their state via `useImperativeHandle`, `StatusSeg`
is only their shared visual shell, so cursor/marquee updates still never touch App state.
The tool chip's colour is the armed tool's **family hue**: `MapCanvas.tsx` exports
`TOOL_ICON`/`TOOL_FAMILY` (`Record<Tool, …>`, same "new Tool is a compile error until
named" discipline as `TOOL_LABELS`), with the family as a plain string key
(`"primary"|"warm"|"selection"|"clipboard"`, no `"violet"`: no tool is 3D-only) rather
than a resolved hex, since `MapCanvas.tsx` otherwise only imports colours from
`theme/theme` and this would have been a second colour source; App.tsx resolves the key
to `ACCENT.*` locally, right before the status bar's JSX.

⚠️ **Overflow at narrow widths (§5.11's risk note, "world name first"):** the essential
segments (tool chip, world name, dims+format, both HUD leaves' rows, undo/redo, fps) are
`flexShrink:0`: they never yield width. The low-priority *informational* segments (the
armed-tool hint text, the select-tool edge-grip hint, the filter/mask chips, the paste
lock/unlock hint) are `flexShrink:1` + `minWidth:0` with an inner `overflow:hidden;
text-overflow:ellipsis` span, so they are what absorbs the crunch and disappears first -
verified at 900px in the harness (`/tmp/vxharness/run-inspector.mjs`): the hint text
ellipsizes while the world name, dims, cursor/selection readouts, undo/redo and fps all
stay fully visible. The world-name segment additionally has its own inner ellipsis span
behind a `maxWidth:220` safety net, for a pathologically long world name, not the normal
overflow path, which is the hint segments giving way.

## Application menu (`src/AppMenu.tsx`)

One two-pane Office-2007 menu replacing the old VuencEdit ▾ and File ▾ dropdowns and
their inline `showRecentSub` / `showExportSub` accordions. Opens under the top bar's
Menu button. Left column → right contextual pane:

⚠️ **The panel is a fixed `MENU_W` × `MENU_H` (720 × 540), not `minWidth`-to-`maxWidth`
elastic.** It used to be `minWidth: 880` / `maxWidth: min(1180px, 96vw)` with panes free
to be as wide as their content, so the menu visibly resized as you moved down the command
column. Consequently the explanatory panes (New · Download · Upload · Help) are plain
`term, definition` text lists (`TextList`), not the two-column icon-card grid they were:
under the fixed width those cards were both too narrow to read and wider than the pane,
and their icons were decorative. Export rows keep their cards, those are *actions*, each
with its own button, but stack title-above-description so a 476px pane can't squeeze
them. The one-off violet border and violet row highlight are now `ACCENT.primary`, so the
menu and the Menu button that opens it belong to the same system.

| Row | Right pane |
|---|---|
| New | The four generators (Flat / Natural / Classic / Tg2), what each produces, + **New World…** |
| Open | Recent worlds list (click to open) + **Browse for a file…** |
| Download | What the world browser offers (quality sort, date filters, hide junk) + **Browse Online Worlds…** |
| Save | Compressed + backup-compressed toggles, how incremental/WAL saving works, + **Save Now** |
| Save As | Same options, extension-correction and overwrite notes, + **Choose Location & Save…** |
| Export | PNG image, with its own **Export** button (the only export format in this repo; the others moved to [EdenToMC](https://github.com/hagg3/EdenToMC)) |
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
Properties panes render. **Both modals must survive**: the splash screen mounts
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

Three files plus two tests. `steps.tsx` is content-only, a flat `TOUR_STEPS: TourStep[]` array,
`TOUR_VERSION` (bumped only by `bump-version.sh`) and **`TOUR_ANCHORS`**: every selector
a step targets, by name. Steps never carry an inline selector. `TourOverlay.tsx` is the engine.
`placement.test.ts` covers placement; `anchors.test.ts` checks every `data-tour` / ribbon
`data-group` / `aria-label` a `TOUR_ANCHORS` selector names still exists in the source, that steps
only target registered anchors, and that step ids are unique, so a moved or renamed surface fails
a test instead of silently degrading a step to a centred card. Two anchors are name-stable across
UI changes: `toolsWindow` still selects `data-tour="left-toolbar"` (the Tools window's
`FloatingWindow dataTour`) and `map` is the *main pane*, which shows the 3D view while swapped.
The step after View layouts, "Mode panels" (the context panels), is a centred card: those
panels only exist while their mode is active, and `before` may not change tools.

**`TourStep`:** `{ id, title, body: ReactNode, target: string | null, placement?, padding?,
before?: (ctx: TourCtx) => void }`. `body` is JSX (hence `.tsx`, not `.ts`) so a step can carry
`<Kbd>` keycaps the same way `HelpModal`/`AppMenu` do, there's a local `Kbd` in `steps.tsx`
rather than importing `AppMenu`'s (not exported, and importing across that boundary for one
component isn't worth it). `target: null` renders a centred card with no spotlight (used once, for
the welcome step). `before` is the **guided-passive reveal**: it may switch ribbon tabs, open the
sidebar, uncollapse the ribbon or reveal the left toolbar via `TourCtx`'s five setters, but never
touches world data and never waits on a user action; it runs in a `useLayoutEffect` keyed on
`stepIndex` so any state update it triggers upstream (App) commits before the browser paints -
that's what lets the following measurement effect's `requestAnimationFrame` see the post-reveal
DOM instead of a stale one.

**Engine (`TourOverlay.tsx`, ~250 lines):**
- Portaled to `document.body`, z-index `9990`: above every chrome layer, below the block-picker
  portal and `AboutModal` (9999). Neither can be open while the tour runs.
- **Spotlight = two divs, no SVG mask.** A full-screen `pointer-events: auto` layer swallows every
  click so the app is inert during the tour; a div positioned at the padded **cutout** rect with
  `box-shadow: 0 0 0 9999px rgba(8,12,16,.66)` paints the dim scrim *and* the cutout with no
  geometry maths, `pointer-events: none` so clicks pass through to the catcher beneath it. A
  `.eden-tour-ring` div tracks the primary `target` alone (not the cutout) and carries the pulse
  (`@keyframes eden-tour-pulse`, defined in a `TOUR_CSS` `<style>` block rendered inline, the
  `RIBBON_CSS`/`SPLASH_CSS` idiom).
  ⚠️ **The reduced-motion opt-out is a JS gate, shared app-wide**. The tour calls
  `useMotionPref()` (`src/theme/motion.ts`) like every other motion-gated recipe in the app, and
  conditionally omits the `.eden-tour-ring` class when the resolved state is `"reduced"`, rather than
  a CSS `@media (prefers-reduced-motion: reduce)` block overriding the same class's animation.
  Doing it in CSS, `@media (prefers-reduced-motion: reduce) { .eden-tour-ring {
  animation: none !important; ... } }` on the class the keyframes lived on, and that combination
  froze the whole app on a real device with Reduce Motion enabled (dimmed overlay, card never
  appeared); root cause not chased down, but a WKWebView-specific interaction between a media query,
  an inline-rendered `<style>` tag and `!important` is the leading suspect. `useMotionPref()` also
  layers in `AppSettings.motion` (a Settings ▸ General override the OS setting alone never had), and
  writes the resolved state onto `<html data-motion>`: the one thing every other motion-gated CSS
  rule in the app now reads (Popover enter, the contextual-tab fade, the edit-completion outline);
  see `src/theme/motion.ts`'s header for the full rationale.
- **`secondaryTargets`** (per-step, optional): extra selectors unioned into the spotlight's cutout
  rect without taking the ring. Exists because a step spotlighting a ribbon group sits *below* the
  tab strip, without folding the strip into the cutout, the dim scrim covers it too and the active
  tab (which just changed via `before`) reads as illegible. The five ribbon-group steps include
  `RIBBON_TABLIST` (`[role="tablist"][aria-label="Ribbon tabs"]`); Draw tools additionally folds in
  the Mask group, Selecting folds in Navigation, and View layouts folds in the map (`[data-tour=
  "map"]`, since it also describes cutaway view). `unionRects` is memoized (`useMemo` keyed on
  `[rect, secondaryRects]`), the placement effect below is keyed on the union, and an unmemoized
  call would mint a new object every render, re-triggering that effect (and `setPos`) forever.
- **Measurement:** `document.querySelector(step.target)` → `getBoundingClientRect()`, re-run on a
  `requestAnimationFrame` after `before()` settles, on `window` resize, and via a `ResizeObserver`
  on `document.body` (catches a reflow that doesn't fire `resize`, e.g. the sidebar opening).
  ⚠️ **A missing target is never fatal**: an unresolved selector degrades the step to a centred
  card with no spotlight and a dev-only `console.warn`, so a hidden Tools window (user-collapsed)
  or a contextual ribbon tab that never appears during the tour can't crash it, only ask the step
  to advance without pointing at anything.
- **Card placement** is `placeCard(rect | null, card: {w,h}, vw, vh, placement)`: a pure,
  exported function: picks the side of the target with the most room (or the step's explicit
  `placement`), then clamps into the viewport with an 8px margin. `rect === null` centres it. Pure
  and node-testable, `placement.test.ts` pins the viewport-margin clamp at each corner/edge and
  the auto-side choice, the tour's counterpart to `ribbon/layout.test.ts`.
- **Card** is `role="dialog" aria-modal="true"`, styled from `ribbon/tokens`
  (`SURFACE.popover`/`BORDER`/`RADIUS.lg`/`FONT`/`ACCENT.primary`), holding an `N / total` counter
  + dot progress strip, title, body, and Skip tour / Back / Next (Done on the last step). Focus is
  trapped via `useFocusTrap` (reused from `Modal.tsx`, not reimplemented) on the card ref.
- **Keyboard**, capture-phase on `window` with `stopPropagation()` (the `AppMenu.tsx`/`Popover`
  idiom): →/Enter/Space advance, ← steps back, Esc skips (`onClose(false)`). Capture + stop is what
  keeps editor shortcuts (`P`, `[`, `⌘Z`) from firing underneath the overlay, belt-and-braces with
  App's `anyModalOpen` gate below.
- Props: `{ steps, ctx, onClose(completed: boolean) }`. Owns only `stepIndex` and the measured
  rect; everything else is derived per render from `steps[stepIndex]`.

**Wiring in `App.tsx`:** `tourOpen` state + a `tourCheckedRef` (once-per-session latch) + a
`useEffect` on `[world, anyModalOpen]`: *not* a call inside `applyLoadedWorld`, since that runs
before the editor branch has mounted and would measure into an empty DOM; running after covers
new/open/download/recent/recovery uniformly with no change to `applyLoadedWorld`'s two call sites.
It compares `loadSettings().tourVersion` against `TOUR_VERSION` and writes the flag at *open* time,
not completion (mirrors `FlyView3D.tsx`'s `FLY3D_LEGEND_SEEN_KEY` idiom, a user who skips
immediately has still been offered it once). `anyModalOpen` includes `tourOpen`, so editor
shortcuts can't fire under the overlay even before its own capture-phase listener would catch them.
`startTour = useCallback(() => setTourOpen(true), [])` is threaded onto `RibbonProps` (so `AppMenu`
and the ribbon's Help button can reach it via `useRibbon()`) and passed directly to `HelpModal` as
`onStartTour` (outside the ribbon prop bag, since `HelpModal` isn't ribbon-context-mounted).
`TourCtx` is a `useMemo` wrapping the existing `ribbonTabSetterRef.current?.(t)` escape hatch (the
same one the Quick Actions bar's "More…" jump already uses, no ribbon refactor needed) plus the
raw `setRibbonCollapsed`/`setSidebarOpen`/`setSidebarTab` setters plus `openToolsWindow()`. ⚠️ **The
overlay mounts only inside App's `if (world) { return … }` editor branch**, the standing
two-`return`-branches warning (see "App.tsx state & patterns" below) applies here too.

**Anchors** are inert `data-tour`/`data-group` attributes with zero behaviour change on their own:
`Group`'s shell div in `ribbon/primitives.tsx` (`data-group={id}`, both the compact-tier and
full/medium variant) is what makes `#ribbon-tabpanel [data-group="tools"]`-style selectors work;
`Sidebar.tsx` carries `data-tour="sidebar"` on its open-panel root and `data-tab={t.id}` per tab;
the Tools window frame (`windows/ToolsWindow.tsx`) and `QuickActionsBar.tsx` carry `data-tour="left-toolbar"`/`"quick-actions"`; `App.tsx` carries `data-tour="map"` on the main-pane map wrapper and
`data-tour="status-bar"` on `statusBarEl`; `WorldNamePill.tsx` carries `data-tour="world-pill"`.
⚠️ **`Group` ids are not globally unique** (`tools` exists on both Draw and Sculpt), only one tab is mounted at a time, but every group selector in
`steps.tsx` is still scoped under `#ribbon-tabpanel` to be unambiguous.

**Settings:** `AppSettings.tourVersion` (default `0`) gates the auto-trigger, both a fresh install
and every pre-existing one (whose stored blob predates the field and gets `0` from the
`{...DEFAULTS, ...parsed}` merge) trigger the tour once. `SETTINGS_VERSION` 11 → 12, comment-only
migration case (purely additive). `bump-version.sh` is the single writer of `TOUR_VERSION`: its
prompt is hoisted above the script's "version unchanged → exit 0" early return, so re-onboarding
existing users doesn't require an app version bump in the same run.

## App.tsx state & patterns

- **`worldRef`** mirrors `world` for `[]`-memoized callbacks (undo/redo →
  `applyEditResult` axo branch reads `worldRef`, not `world` directly).
- **`editEpoch`**: bumped on every edit; panels keyed on it refetch. Also bumped
  by header-only writes (rename/spawn) so they aren't lost by the dirty guard.
- **`worldEpoch`**: bumped once per world load; drives the 3D re-center token.
- **`FpsCounter`, `CoordHud`, `CursorHud`**: self-contained leaf components fed
  via refs (`hudRef.current.set(...)`) so high-frequency ticks (FPS, camera
  coords, cursor readout) re-render only their own `<div>`, not App and the
  ~150-prop Ribbon.
- **`reportError(e)`, not `setError`**: every `catch` calls `reportError`, which
  shows a red auto-dismissing toast (`ERROR_TOAST_MS`, hover-to-persist, stacked,
  capped at `MAX_TOASTS`) and records the message in `error`, which only the
  splash/`!world` branch renders inline (there is no toast layer there).
  `showToast(text)` is the info variant.
- **Settings**: `AppSettings { snapWindows,
  defaultSaveCompressed, templatePath, texturePackPath, prefabDirectory,
  enableFog, renderDistance, flySpeed, sunT, lampRadius, showQuickActions,
  autoOrient3d, memoryBudget, settingsVersion, … }` (list not exhaustive, see
  `SettingsModal.tsx` for the full field set, which has grown past this excerpt).
  `loadSettings()`/`saveSettings()` use
  `localStorage` key `eden_settings`. `saveSettingsDebounced` (250 ms) for slider
  drags. `memoryBudget`
  indexes `MEMORY_PRESETS` for the undo/tile/vertex ceilings. `overviewBudgetBytes` (Low 16 / Balanced 32 / High 64 MB) is the
  overview-raster budget; `App.tsx`'s `pushBackendBudgets()` sends it via `set_overview_budget`
  alongside the undo budget (see [2D Rendering](../rendering-2d/)).
- **Settings migrations** (`settingsVersion` + `migrate()`), a plain
  `{...DEFAULTS, ...parsed}` merge can never push a *changed* default onto an
  existing install, since the stored explicit value always wins. `migrate()`
  runs only on a stored blob (a fresh install just takes `DEFAULTS`, already at
  the current version), applies each version's fixups, and persists. A user who
  turns a migrated setting back off keeps their choice, since the version has
  already advanced.
  The old quad layout is retired. A settings migration opens the 3D window for anyone who was on
  it and shows a one-time notice.
- **Quick Actions bar** (`QuickActionsBar.tsx`), a floating glass pill centred
  under the ribbon, shown while a selection or clipboard is active and
  `showQuickActions` is on (default). Selection group: Copy/Fill/Delete/
  Deselect. Clipboard group: Paste, Clear, a Z-offset `NumberField` with
  ±steppers (also reachable via PgUp/PgDn, ⇧=±5, while the paste tool is
  armed), rotate, mirror. "More…" jumps the Ribbon to the Selection tab.
- **Hotbar**: 5 pinned + 5 recent block+paint swatches, state owned by `useHotbar()` and rendered in two places: the floating **Hotbar
  window** and FlyView3D's own in-pane build overlay (`hotbarSlots` prop, hidden via
  `showHotbarOverlay` while the window is open and expanded, so there's never a
  duplicate). 3D building's armed block is the same `fillBlockType`/`fillPaint` state
  the 2D draw tools and hotbar use, not a separate 3D-only value, so picking a block in
  either place arms the other. Number keys 1–5/6–0 arm hotbar slots and work in the 3D
  fly-view pane too.

### Long-operation overlay

One modal overlay for every long-running backend operation, PNG export, full save,
compressed save, plus the world-load spinner when its `op` prop is null. (OBJ/JSON/VOX
export also used this overlay before they were removed; the `"obj"`/`"json"`/`"vox"`
`LongOps` kinds are unused now, kept rather than narrowed, see [IPC Reference](../ipc-reference/).)
It replaced four hand-rolled overlays that between them offered six different levels of
feedback (a percentage bar, an indeterminate shimmer, two static "Exporting X…" labels)
and no Cancel at all.

- State is a single `longOp: LongOpState | null`, fed by the backend's `long-op` event
  (see [04]).
  The listener **merges** progress events onto the opening event rather than replacing
  it, so `label`/`cancellable` survive; a `finished` for an id no longer showing is
  ignored, so a late event can't blank the current operation.
- Adding progress to a new command is a `LongOps::begin` call in Rust and *nothing*
  on this side.
- `pointerEvents` is `"auto"` only while the operation is cancellable; otherwise the
  overlay stays click-through inert, as the old one always was.
- `reportExportError` swallows `"Cancelled"`: a cancel the user asked for should not
  raise a red toast. Every other failure still goes through `reportError`.
- `RibbonProps.longOpKind` (one string) tells the ribbon which long operation is running;
  `AppMenu`'s rows key their busy spinner off it.

### App.tsx gotchas

- ⚠️ **`saveWorld`/`saveWorldAs` are `const`** (not hoisted) and used in the
  keyboard-shortcut effect's dep array, they **must** stay declared *above* that
  effect, or every render throws "Cannot access before initialization".
- ⚠️ **The right-click context menu JSX and `statusBarEl` must live inside the
  `if (world) { return … }` editor branch.** App has a second `return` for the
  splash/launcher screen (`!world`); placing them in the splash branch makes them
  never render.
- **`closeWorld` reconciles `savedEpochRef`/`lastAutosavedEpochRef`** to the closed
  world's epoch before clearing state, or the next dirty guard re-asks to discard
  changes belonging to a world that no longer exists.
- **⌘W reaches `closeWorld` via `closeWorldRef`** because `closeWorld` isn't
  memoized, depending on it directly re-registers the keydown listener every
  render.

## UI/UX conventions

- **HiDPI canvases:** see [2D Rendering](../rendering-2d/#hidpi-canvas-plumbing-viewportutilsts).
  Never read `canvas.width`/`height` for layout.
- **`accentRing(hex)`, not `borderColor`:** `chromeButton`/`rb` set `border: none`
  and draw their outline as an inset box-shadow, so a `borderColor` override is
  inert. Spread `...accentRing("#f59e0b")` instead.
- **Destructive dismissal:** Esc/backdrop must never destroy data.
  `RecoveryModal`'s `onDismiss` keeps the autosave sidecar; only the explicit
  Discard → confirm reaches `discard_autosave`.
- **Modals block dismissal while an operation runs** (`closeOnEsc={!busy}
  closeOnBackdrop={false}`, close/Cancel disabled): NewWorld, WorldBrowser,
  Upload, Expand. Completion callbacks are gated on `mountedRef`.
- **Sliders that drive IPC use a display/commit split** (`zSliceDisplay`/
  `commitZSlice`, `sunTDisplay`), track locally
  while held, commit once on pointer-up/key-up/blur.
- **`NumberField`, not a raw `<input type="number">` with a clamping `onChange`**
 , the clamp-on-keystroke idiom snaps an emptied field to the minimum. All Ribbon
  + NewWorld numeric fields go through it.
- **Shortcuts are declared in `src/commands/meta.ts`** (a command's `keys`, or a
  `GESTURES` row for non-commands like Space-to-pan). Help's table renders from it
  and `commands.test.ts` fails on a chord collision in overlapping scopes. Only
  ⌘K is dispatched by the registry; the rest are still *implemented* in App's
  global keydown handler (`handledBy: "legacy-keydown"`), so a new shortcut
  needs both the handler branch and the meta entry. `⌘`-combos pass through the
  fly-mode gate.
- **`isTypingTarget` / `NON_TEXT_INPUT_TYPES`:** the global keydown handler only
  suppresses shortcuts for *text-entry* inputs, range sliders keep focus after a
  drag, and testing `tagName === "INPUT"` would silently kill P/B/R/E/W while a
  slider is focused.
- **`App.css`'s own `@media (prefers-reduced-motion: reduce)` block** (it kills transitions and flattens the toast slide to a fade, but
  leaves `eden-spin` running, a progress indicator rather than decoration) is the one surviving
  CSS media query in the app. Every motion-gated rule added *after* it, Popover enter, the
  contextual-tab fade, the completion outline, the tour's pulse, instead goes through the JS
  gate in `src/theme/motion.ts` (`useMotionPref()`, writing `document.documentElement.dataset.motion`)
  precisely because a `@media (prefers-reduced-motion)` block inside an *injected* `<style>` tag is
  what froze the tour on a real device (see "Onboarding tour" above), new code must not add
  another such block anywhere in the app.
- **Drag-and-drop a `.eden`/`.zip` onto the window** funnels through the same
  `openFileAt` path (and the same unsaved-changes dirty guard) as every other
  open action, via Tauri's native drag-drop event rather than a React `onDrop`.
- **One shared badge system** (`designTokens.ts`: `expBadge`/`perfBadge`/
  `wipBadge`) marks experimental, perf-heavy, and work-in-progress controls
  consistently across Ribbon/App/modals, called as a function so extra style can
  be spread in.
- **Every armed/gated mode has a visible, discoverable escape hatch**: a status
  chip, a toast, or a labeled toggle, rather than relying on the user already
  knowing the shortcut out.
- **UI sound cues (`src/sound/sfx.ts`, `sfx.play(cue)`):** on by default, Classic
  pack. Fire on completions only, tab/menu/copy/paste/rotate/save/stroke-end/
  undo/error/drag/drop, never on hover, never at pointer or stamp rate, never
  from FlyView3D's per-frame paths. `save` only after `saveWorld` resolves
  `true`; `error` piggy-backs `pushToast`'s dedupe; `stroke` fires once on a
  sculpt/draw stroke's release, not per live-brush flush. 
- **`nudge` cue + `sfx.hold()`.** `nudge` is a one-shot for each paste Z-offset step
  (lens arrows, QAB arrows, PgUp/PgDn), throttled to one per 40 ms (`CUE_INTERVAL_MS`, not the
  generic 60) so a held key doesn't buzz. `sfx.hold()` → `{ stop() }` is a quiet **tick loop** for a
  gesture that is still held, floating-window move **and** resize (`FloatingWindow.tsx`), and the
  map's selection-shaped drags + paste-tool placement (`MapCanvas.tsx`, started 4 px past pointer-down).
  Each `SoundPack` has an optional `hold: HoldVoice = { period, voices }` (`"none"` has none): one dry
  tick (a `Voice` burst, ≤ 40 ms) every 90–140 ms (±3 % jitter), scheduled ~100 ms ahead on the
  `AudioContext` clock and topped up on a 25 ms timer (not `setInterval`-timed); each voice's gain is
  capped at `HOLD_MAX_GAIN` (−12 dB under the loudest one-shot; tested). `stop()` cancels ticks still
  queued ahead; one already sounding rings out. `sfx.previewHold(pack, vol)` is Settings ▸ Sounds'
  "Hold sound ▸ Preview". Window resize end plays `drop` like move end. **Safety net:** the first `hold()` installs one capture-phase `window` guard that stops
  *every* live hold on `pointerup`/`pointercancel`/`lostpointercapture`/`blur`/`visibilitychange`
  and Escape, so a call site that forgets an end path can't leave it ticking; call sites still
  stop explicitly (release, Escape-cancel, unmount). `sfx.hold.test.ts` fakes `window` + `AudioContext`
  and asserts each end path.

## Right-click context menu

`ctxMenu` state in App.tsx `{wx,wy,x,y}`. `MapCanvas` fires
`onMapContextMenu(wx,wy,screenX,screenY)` from `<canvas onContextMenu>` (which
`preventDefault()`s the OS menu), **not** from `onPointerDown` button 2
(unreliable in macOS WKWebView). This invariant is unchanged by the rewrite below.

**Rendering.** App.tsx used to hand-roll the menu's JSX (raw hex colours,
manual `onMouseEnter`/`onMouseLeave` background swaps, a measure-after-mount viewport
clamp, its own outside-click listener). It's now a data-driven item list -
`ContextMenuItem[]` built inline in App.tsx (label, icon, `onClick`, optional
`shortcut`/`active`/`disabled`/`separatorBefore`), rendered through the generic
`src/ui/ContextMenu.tsx`, which is a thin wrapper over the ribbon's `Popover`
(`role="menu"`) and `MenuItem` row. This gets the menu, for free, the same roving
keyboard model every other `Popover` menu has (Up/Down/Home/End rove, Enter/Space
activate, Escape/Tab/outside-click close, focus returns to the opener) instead of a
second hand-written one. `Popover`'s own viewport clamp (flip above the anchor when it
would overflow the bottom, clamp horizontally) replaced the old measure-after-mount
effect; `ContextMenu` plants a zero-size `position:fixed` anchor div at the click point
so `Popover`'s `anchorRef.getBoundingClientRect()`-based math has a real element to
measure. Items: Set Spawn Here, Copy / Paste Here / Fill / Delete / Clear Selection
(guarded by `rawBounds`/`clipboard`), Teleport 3D Camera Here + **Center Map on 3D
Camera** (both shown only while `pane3dLive`; the second guarded on `hasCam3dPos` too
since it needs a live reading), tool switches (Select/Pen/Pan; the active tool gets the
app-wide "current row" pushed-in look via `MenuItem`'s `active` prop, not an inline
accent colour). Shortcut hints are pulled from `COMMAND_META`
(`src/commands/meta.ts`) + `formatChord` where a menu action has a real registered id
(Copy, Delete, Clear Selection, Select/Pen tool); actions with no 1:1 registry entry
(Paste Here locks a position before arming paste, different semantics from the
registry's "arm paste" `⌘V`: and the 3D-camera items) render with no shortcut rather
than inventing one.

**Dismissal.** `Popover` grew a `dismissDelayMs` prop for this call site (default `0`,
every other consumer unaffected): the old menu's outside-click listener was deliberately
registered 80ms after open, because a right-click can synthesize a trailing
mousedown/mouseup on macOS WKWebView *after* the `contextmenu` event that opened the
menu, which would otherwise read as an immediate outside click and dismiss the menu the
instant it appeared. `ContextMenu` passes `dismissDelayMs={80}` into `Popover`, so this
is the **only** outside-click mechanism now, the old menu's separate delayed
`document.addEventListener` in App.tsx is gone, not duplicated alongside `Popover`'s own.

## 3D camera dot & teleport

`cam3dPos` state tracks the FlyView3D camera XY (set from `onCameraMove`, wired
only while the 3D pane is mounted), shown as a teal dot on MapCanvas. Click/drag
near the dot (`"cam3d-drag"` DragOp) teleports the 3D camera via
`flyView3dRef.current.teleport(wx, wy)`. The reverse direction, recentring the 2D
map on the live 3D camera position without changing zoom, is
`mapCanvasRef.current.centerOn(wx, wy)` (`MapCanvasRef`, alongside `resetView`/
`zoomToBox`), wired to the context menu's "Center Map on 3D Camera" item.
{% endraw %}
