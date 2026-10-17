---
layout: doc
title: Editing
subtitle: Draw tools, selections, the Lens, and terrain sculpting.
---

## Draw tools

The Draw tab has the everyday tools. The same ones are in the floating Tools window.

| Tool | Key | What it does |
|---|---|---|
| Pen | <kbd>P</kbd> | One block at a time, freehand |
| Brush | <kbd>B</kbd> | Freehand at the brush size (1 to 9, square or round) |
| Line | <kbd>L</kbd> | Drag from start to end |
| Rectangle | <kbd>R</kbd> | Drag a box, filled or hollow |
| Ellipse | <kbd>E</kbd> | Drag an ellipse, filled or hollow |
| Polygon | <kbd>G</kbd> | Click points, then click the first point or double-click to close. <kbd>Esc</kbd> cancels |
| Spray | none | Scatters blocks, and builds up while you hold |
| Fill Bucket | <kbd>F</kbd> | Fills connected matching blocks |
| Eyedropper | <kbd>I</kbd> | Picks the block under the cursor |

The stroke stabilizer makes the brush trail the cursor a little, which smooths out a shaky hand. The draw mask limits painting to cells that already hold a block you choose, so you can retexture one material without touching the rest.

Pick the block and paint from the Block button, or press a hotbar key: <kbd>1</kbd> to <kbd>5</kbd> for pinned blocks, <kbd>6</kbd> to <kbd>0</kbd> for recent ones. You can pin a recent block from the Hotbar window.

## Selections

- **Select** (<kbd>S</kbd>) drags a rectangle. The Selection tab has the Z range.
- **Magic Wand** (<kbd>W</kbd>) flood-selects connected blocks that match the one you click, up to 50,000 cells. Wand: Match Colour makes it match paint as well as block type.
- **Lasso** (<kbd>K</kbd>) selects a freehand shape.
- **Polygon Select** (<kbd>J</kbd>) selects by clicking points.

<kbd>⌘A</kbd> selects the whole world and <kbd>⌘D</kbd> clears the selection (<kbd>Ctrl</kbd> on Windows and Linux). You can grow or shrink a selection by one block, drag inside it to move it (hold <kbd>Shift</kbd> to lock to an axis), or nudge it with the arrow keys. <kbd>Shift</kbd>+arrow nudges ten blocks.

Wand, Lasso and Polygon selections keep their real shape, not just their bounding box. Fill, replace, delete, move, gradient, extrude, copy and the previews all use the exact cells.

Once you have a selection:

- **Fill** writes the active block into it, and **Delete** fills it with air. Both respect the Replace filter, which only touches blocks you choose (or everything except them, if you invert it).
- **Gradient** blends the Fill block into a Fade-to block along X, Y or Z, with ordered dithering instead of visible bands. It works well for cliff striping.
- **Extrude** repeats the selection N times along an axis in one undo step.

The Inspector tab in the sidebar shows the selection's size, Z range, volume, bounds and shape.

## The Lens

When you have a selection, the Lens window opens with front and side views of it, and a Top view you can switch to. It's a live cross-section, so it's the easiest way to see how deep a selection goes.

- Drag the edge handles to change the selection's Z range. <kbd>Esc</kbd> reverts a drag.
- Scroll to zoom up to 8×, drag to pan, double-click to reset.
- Draw on the front or side view with the pen, brush, rectangle or ellipse. Each stroke is one undo step.
- A thin band follows your cursor on the map so you can see which column you're looking at.

The Lens is new in 1.0.18 and still settling. You can turn it off with <kbd>Alt</kbd>+<kbd>P</kbd>, or separately for pastes and for selections in Settings ▸ Layout & windows.

{% include placeholder.html caption="The Lens window showing front and side views of a selection" ratio="16/9" %}

## Insert tab

- **Trees**: normal, terrain, pine and tall pine, with a density slider. A "grass only" option avoids planting on stone or sand.
- **Fluids**: Simulate Flow grows water or lava from source blocks inside the selection. Pool Fill fills a basin up to a target Z. Wavy Surface stamps a ripple pattern of partial blocks.
- **Materialize** turns empty chunk space, either holes or past the map edge, into flat terrain.
- **Expand from Template** grows the world using the Eden.eden template. This one is experimental.
- **Set Home Point** and **Set Start Point** (Home tab) move the respawn point or player start to the middle of the selection.

## Terrain sculpting <span class="tag-exp">experimental</span>

The Sculpt tab has 16 brush tools for reshaping terrain. They work on the map and in the 3D view.

- **Raise, Lower, Flatten, Slope** are the basics. Flatten levels to the height you click, and Slope flattens to a tilted plane.
- **Smooth and Sharpen** are opposites. **Terrace** cuts terrain into steps.
- **Noise** adds hills or mountains.
- **Erode, Thermal and Hydro** simulate weathering. Hydro carves water channels.
- **Grab and Smear** pull terrain along with the brush.
- **Retexture** repaints the surface by slope.
- **Rock and Carve** work on volume, not a height map. Rock fuses a mass into the landscape instead of leaving a seam. Carve digs a rounded hollow into exposed terrain.

Strength, radius, softness and falloff profile are in the Brush and Falloff groups. <kbd>[</kbd> and <kbd>]</kbd> change the radius while a sculpt tool is armed, and <kbd>Shift</kbd>+<kbd>[</kbd> or <kbd>]</kbd> change the strength. Hold <kbd>Ctrl</kbd> or <kbd>⌘</kbd> to swap Raise and Lower for one stroke. Hold <kbd>Shift</kbd> to smooth (any tool except Grab). With Live Brush on, terrain changes as you drag. Off, the stroke applies when you let go.

<kbd>Esc</kbd> mid-stroke on the map reverts the stroke. A finished stroke is one undo step however long you held it. You can limit sculpting to the current selection with Sculpt in Selection.
