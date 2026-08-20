---
layout: doc
title: 3D & Quad View
subtitle: The four-pane editor, the fly-through pane, and building in 3D.
---

## Quad view

Toggle it from **View ▸ Quad View** (or the button in the ribbon). It splits the window into four
panes, Hammer/Radiant-style:

- **Top** — the same top-down map you always have.
- **Front / Side** — movable slice planes by default (an O(1)-per-pixel slab, so panning stays
  instant even on large worlds), with an opt-in ortho projection once a selection is active.
- **3D** — the live fly-through pane (see below).

All four panes share marquee selection, crosshairs, and drag-to-resize for the Z edges and the
divider between panes.

{% include placeholder.html caption="Quad view with all four panes visible: map, front slab, side slab, 3D pane" ratio="16/9" %}

## Cutaway view

Pick a height cap from the View tab's Z slider and everything above it disappears from both the
2D map and the 3D pane — useful for working on caves, basements, or building interiors without the
roof in the way. Drawing, sculpting, and the eyedropper all target the exposed surface at the cap,
not whatever's underneath it.

## 3D fly-through pane

An opt-in (zero overhead when off) streaming Three.js view of the whole world, with three camera
modes you cycle with <kbd>Z</kbd> or the corner pill:

- **Orbit** — rotate around a fixed point.
- **Fly** — free-flight camera.
- **Mouselook** — Minecraft-style look-around, using a native cursor grab.

The camera's position shows as a dot on the top-down map, and you can teleport it by clicking the
map or via the right-click context menu.

### Building and selecting in 3D

The 3D tab's mode switch adds two more ways to work directly in the pane:

- **Build** — left-click breaks, right-click places. Press-and-drag sweeps a line of edits along
  the surface you're aiming at, exactly like Minecraft's block-breaking drag. A highlight box
  always shows the exact cell that will be affected.
- **Select** — click two blocks to define a selection box.
- **Sculpt** — shape terrain right inside the pane while orbiting, flying, or in mouselook,
  previewed as a brush disc at the surface under your cursor.

Everything you do in 3D goes through the same undo/redo system as the 2D map — a whole
build-sweep or sculpt stroke is one undo step, not one per block.

### Lighting previews <span class="tag-exp">experimental</span>

Two optional, performance-heavy previews, off by default:

- **Night lighting** — lamp blocks cast a coloured glow matching their paint.
- **Sun shadows** — a directional shadow raymarch with a time-of-day slider, plus an optional real
  GPU shadow-map mode with point lights for lamps.

## Selection 3D preview

Outside the fly-through pane, the Selection Inspector can render any selection up to 64×64×64
blocks as an on-demand Three.js preview — useful for checking a structure from an angle before you
commit to copying or exporting it.
