---
layout: page
title: Features
subtitle: Everything VuencEdit can do, section by section.
---

## Interface

- **Ribbon toolbar** — a tabbed, collapsible toolbar (Home · Draw · Sculpt · Insert · View, plus
  contextual 3D / Selection / Clipboard tabs) replaces a conventional menu bar; resizable height,
  persisted between sessions, with an application menu for settings, help, and about.
- **Right-click context menu** — right-click anywhere on the map for quick actions: set spawn
  here, copy, paste here, fill/delete/clear selection, teleport the 3D camera, and tool switching.
- **Docked sidebar** — a resizable right-edge panel with Inspector, Prefabs, and History tabs, so
  selection details, your prefab library, and the undo/redo stack are always one click away.
- **Settings** — persistent app preferences: default quad view, default 3D pane, save compression,
  template path, texture-pack path, and a Low / Balanced / High memory-budget preset.
- **World Info** — a summary of the open world: name, seed, format/version, dimensions, chunk
  count, spawn/last position, golden cubes, and the 16-band sky-colour palette.
- **Accessible modals** — every dialog closes on Escape, traps keyboard focus, and reports itself
  to screen readers.

{% include placeholder.html caption="The ribbon's Draw tab, with the block/paint picker open" ratio="16/9" %}

## Viewing & navigation

- **Zoomable, pannable top-down map** of any Eden world file, with tiled rendering so even large
  worlds pan smoothly.
- **Z-slice mode** — step through horizontal layers one at a time with a slider.
- **Cutaway view** — pick a height cap and everything above it disappears, so the map shows the
  cave or interior below instead of the roof; drawing, sculpting, and the eyedropper all target
  the exposed surface.
- **Axonometric (axo) view** — isometric-style perspective with an adjustable depth skew.
- **Full map mode** — renders the entire world into a single canvas for lag-free pan/zoom.
- **Quad view** — a Hammer/Radiant-style four-pane editor: top-down map + front and side
  slice/ortho viewports + a live 3D pane, with movable cut-planes, marquee selection, and
  in-viewport drawing.
- **3D fly-through** — a streaming Three.js view of the whole world with three camera modes
  (Orbit, Fly, and Minecraft-style Mouselook); the camera position shows as a dot on the top-down
  map and can be teleported by click or the right-click menu.
- **Build and select in 3D** — a dedicated 3D tab switches the pane into Build mode (left-click
  breaks, right-click places, drag to sweep a line) or Select mode; both go through the normal
  undo/redo system and stay in sync with the map and slice viewports.
- **Lighting previews**<span class="tag-exp">exp</span> — night lighting (lamp blocks cast a
  coloured glow matching their paint) and directional sun shadows with a time-of-day slider; an
  optional GPU shadow-map mode adds real-time point lights and shadows that respect glass, water,
  and fences. All performance-heavy and off by default.
- **Elevation preview panel** — a resizable front/side cross-section of the current selection,
  with optional draw support, docked inside the sidebar's Inspector tab.

## Selecting & inspecting

- **Click-drag selection** with Z-range controls.
- **Magic Wand** — click any surface block to flood-select the contiguous region sharing that
  block type (or block+paint combination).
- **Lasso** — freehand-drag a shape to select it directly, no bounding box required.
- **Non-rectangular selection** — Wand and Lasso carry a real per-column shape, not just a
  rectangle, and every edit (delete, replace, move, gradient fill, extrude, tree generation) and
  preview honours it.
- **Selection inspector** — dimensions, block counts, and orthographic previews in the sidebar.
- **3D preview** — on-demand Three.js render of any selection up to 64×64×64.

## Editing

- **Fill / replace / delete** — fill a region with any block, replace one material with another,
  or selectively delete blocks with an optional filter.
- **Draw tools** — Pen, Brush, Spray, Line, Rectangle, Ellipse, and Polygon/lasso paint blocks
  directly on the map; brush size (1–9) and shape (square/circle), fill/hollow rect and ellipse,
  and a stroke stabilizer to smooth out hand jitter on freehand strokes.
- **Gradient fill** — blend from the fill block to a second block across X, Y, or Z with a clean
  ordered-dither pattern (no banding) — great for cliff striations or smooth material transitions.
- **Draw mask** — restrict painting to cells whose current block type (and optionally paint)
  matches a chosen target.
- **Hotbar** — 5 pinned + 5 recent block+paint combos for fast switching; hover a recent swatch to
  pin it.
- **Undo / redo** — multi-level history with an adjustable memory budget; a held sculpt or spray
  stroke undoes/redoes as a single step no matter how long you held it.

## Terrain sculpting <span class="tag-exp">experimental</span>

- **16 brush-based sculpt tools** — Raise, Lower, Grab, Smooth, Flatten, Slope, Noise, Erode,
  Thermal, Hydro (branching hydraulic erosion), Stamp/Retexture, Terrace, Sharpen, Smear, and the
  volumetric Rock and Carve tools, which fuse a mass into the landscape rather than sitting on top
  of it.
- **Soft, per-stamp brush falloff** with four profiles (smooth/linear/sphere/sharp) and a live
  falloff-aware cursor showing the brush's real strength gradient and radius.
- **Hold-to-build** — hold the mouse down to sculpt continuously, like an airbrush.
- **Modifier keys** — hold Ctrl/⌘ to invert Raise↔Lower mid-stroke, hold Shift to temporarily
  switch to Smooth; bracket keys resize the brush and adjust strength without leaving the tool
  you're using.
- **Sculpt right inside the 3D view** — orbit, fly, or mouselook while shaping terrain, previewed
  as a brush disc at the surface under your cursor.
- **Selection-clipped sculpting** — optionally restrict a stroke to the current selection.

{% include placeholder.html caption="A hydraulic-erosion sculpt stroke reshaping a mountainside in the 3D pane" ratio="16/9" %}

## World generation

New World dialog with four terrain tabs, each supporting both the 64z (Legacy) and 256z
(New Dawn) height formats:

- **Flat** — fixed-height world with configurable stone/dirt layers.
- **Natural (Procedural)** — full biome pipeline with domain-warped continents, mountain ridges,
  erosion, rivers, lakes/ocean, caves, ores, trees, structures, and clouds; single or mixed biomes
  with speckled dither at biome edges; live terrain preview.
- **Classic** — a faithful port of the original legacy generator: seeded Perlin noise, hand-carved
  cave and skin passes, a sparse flower/weed mix.
- **Tg2** — a port of the Eden 2.0 TerrainGen2 generator, with 9 terrain types plus sky islands,
  structures, amplitude and sea-level knobs, and noise-warped seam blending.

## 3D

The selection preview and the fly-through pane both build geometry from face-culled cubes (plus
prisms for ramps and pyramids for wedges), generated in Rust with directional shading baked into
vertex colours. The fly-through streams per-chunk meshes within a load radius around the camera,
with adaptive request concurrency and a resident-memory budget so large worlds stay responsive.
Optional texture packs<span class="tag-exp">exp</span> supply greyscale tile detail multiplied by
each block's colour on the GPU.

## Server & sharing

- **Compressed world support** — reads and writes `.eden.zip` alongside plain `.eden`.
- **Browse Worlds** — search and download any world from the Eden community servers, with preview
  images, date-range filters, quality sorting, and a Hide-junk toggle.
- **Upload** — share your world back to the Eden servers with a PNG thumbnail, streamed so large
  worlds don't spike memory.

## Import / export

- **Copy / paste** any volume, with optional No Air, Terrain-align, Rotate 90°, Flip X/Y, and
  Repeat modes; two-click paste lock-in; scatter and array advanced-paste modes.
- **Prefab library** — a dockable gallery of your saved prefabs with thumbnails, search, sort, and
  inline rename/delete.
- **Extrude** — repeat a selection N times along any of 6 axes in one undo step.
- **Schematic import** — Minecraft `.schematic`/`.litematic` builds with a block-mapping table and
  top-down preview.
- **OBJ export**<span class="tag-exp">exp</span> — Wavefront OBJ + MTL with face-culled geometry
  and correct ramp/wedge prisms.
- **Source Engine VMF export**<span class="tag-exp">exp</span> — a selection becomes editable
  Hammer brushwork, with a greedy box merge, dev or flat-colour texturing, and an optional skybox
  shell.

## Texture packs <span class="tag-exp">experimental</span>

Load a ZIP of PNG block textures to give the 3D views and block-picker swatches real textures; the
2D top-down map stays flat-colour. Textures are converted to greyscale and tinted by each block's
natural or painted colour, so one pack works across every paint variant.

<div class="btn-row">
  <a class="btn btn-primary" href="{{ '/downloads/' | relative_url }}">Download VuencEdit</a>
</div>
