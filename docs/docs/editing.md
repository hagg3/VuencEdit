---
layout: doc
title: Editing
subtitle: Draw tools, selections, and terrain sculpting.
---

## Draw tools

The **Draw** tab holds the everyday tools, all in the left toolbar too with one-key shortcuts:

| Tool | Key | What it does |
|---|---|---|
| Pen | <kbd>P</kbd> | Single blocks, freehand |
| Brush | <kbd>B</kbd> | A configurable 1–9 square or circular footprint |
| Spray | — | Scattered placement with adjustable density (click-and-hold) |
| Line | <kbd>L</kbd> | Drag-drawn straight line |
| Rectangle | <kbd>R</kbd> | Drag-drawn box, filled or hollow |
| Ellipse | <kbd>E</kbd> | Drag-drawn ellipse, filled or hollow |
| Polygon / Lasso | <kbd>G</kbd> | Click vertices, <kbd>Esc</kbd> to cancel |

A **stroke stabilizer** smooths hand jitter on freehand strokes, and a **draw mask** can restrict
painting to cells whose current block (and optionally paint) matches a target — handy for
re-texturing only specific blocks without touching anything else.

**Gradient fill** (on the Selection tab, once you have a selection) blends from your fill block to
a second block across X, Y, or Z with a clean dithered pattern — no visible banding — good for
cliff striations or smooth material transitions.

## Selections

- **Click-drag** with the Select tool draws a rectangle, with Z-range controls for how deep it
  reaches.
- **Magic Wand** (<kbd>W</kbd>) flood-fills outward from a clicked block, matching type (or
  type+paint), up to a 50,000-cell cap.
- **Lasso** (<kbd>K</kbd>) freehand-drags an arbitrary shape.

Wand and Lasso selections carry their real shape, not just a bounding rectangle — fill, replace,
delete, move, gradient fill, extrude, copy/paste, and every preview (2D ghost, elevation, 3D)
honour the exact cells you selected, not the box around them.

Once you have a selection: **Fill** replaces everything inside it with the current block, **Replace**
swaps one material for another, **Delete** clears it (optionally filtered), and **Extrude** repeats
it N times along any of 6 axes in a single undo step.

## Terrain sculpting <span class="tag-exp">experimental</span>

The **Sculpt** tab has 16 brush-based tools for shaping terrain directly, rather than placing
blocks one at a time:

- **Raise / Lower / Flatten / Slope** — the basics, with a soft radial falloff.
- **Smooth / Sharpen / Terrace** — reshape existing terrain without adding or removing volume.
- **Noise** — coherent, natural-looking hills and mountains.
- **Erode / Thermal / Hydro** — simulated weathering; Hydro is a full branching hydraulic-erosion
  model for realistic drainage patterns.
- **Grab / Smear** — drag terrain around like wet paint.
- **Stamp** — retexture the surface without changing height.
- **Rock / Carve** — volumetric, not heightmap-based: Rock fuses a mass into the landscape with a
  smooth fillet instead of sitting on top of it as a seamed object; Carve is its inverse, digging
  into terrain without ever opening a floating roof or touching bedrock.

Sculpting works both on the 2D map and directly inside the 3D pane. Hold the mouse down to sculpt
continuously like an airbrush; hold <kbd>Ctrl</kbd>/<kbd>⌘</kbd> to invert Raise↔Lower mid-stroke,
hold <kbd>Shift</kbd> to temporarily switch to Smooth, and use <kbd>[</kbd>/<kbd>]</kbd> to resize
the brush (<kbd>Shift+[</kbd>/<kbd>Shift+]</kbd> for strength) without switching tools.
<kbd>Esc</kbd> mid-stroke reverts the whole thing as one step. A whole stroke — however long you
held it — undoes in a single step too.

You can optionally clip sculpting to the current selection, so a brush stroke can't spill past a
boundary you've already marked out.
