---
layout: page
title: Features
subtitle: What VuencEdit does today, section by section.
---

## Interface

The map fills the window. The 3D view, a small tools window and a hotbar float on top of it. You can drag them, resize them from any edge, snap them to the window edges, collapse them to a title bar, or hide them. <kbd>Tab</kbd> swaps the map and the 3D view, so either one can be the big pane.

A ribbon runs across the top with five tabs: Home, Draw, Sculpt, Insert and View. Three more tabs show up when they apply: 3D while the 3D window is open, Selection while you have a selection, and Clipboard while something is copied. On a narrow window, ribbon groups shrink and then fold into a single dropdown instead of scrolling sideways. There is also an experimental compact ribbon, off by default.

Small panels appear next to your work when a mode needs them: the cutaway or Z-slice level, the brush shape for Noise, Slope, Rock and Carve, the Flood Fill limit, and the 3D sculpt brush.

- <kbd>⌘K</kbd> (<kbd>Ctrl+K</kbd> on Windows and Linux) searches every command and tells you where it lives in the ribbon.
- Right-clicking the map opens a menu with the usual actions: set spawn here, copy, paste here, fill or delete the selection, teleport the 3D camera. It works from the keyboard too.
- A docked sidebar on the right has Inspector, Prefabs and History tabs.
- World Properties shows the name, seed, format, dimensions, chunk count, spawn and last position, golden cubes and the sky palette.
- Settings covers general options, window layout, 3D view, editor and saving, sounds, files, and experiments. There is a memory preset (Low, Balanced, High) that trades undo depth, tile cache size and 3D streaming range against RAM.
- Small UI sounds and animations confirm things like saves, pastes and undo. Both can be turned down or off.

{% include placeholder.html caption="The default layout: map with the 3D, Tools and Hotbar windows floating on top" ratio="16/9" %}

## Viewing and navigation

The map is a zoomable, pannable top-down view, drawn in tiles so big worlds stay smooth. Zoomed all the way out, it draws from a cached summary of the terrain, which is saved per world.

- **Z-Slice** shows one horizontal layer at a time.
- **Cutaway** hides everything above a height you pick, so you can see a cave or a building's interior. Drawing, sculpting and the eyedropper all work on the exposed surface.
- **Relief** shades slopes as if lit from the north-west, so hills and cliffs show up even when the blocks are identical.
- **3D view** streams the world in chunks with Three.js. It has orbit, fly and mouselook cameras, and the camera shows as a dot on the map. You can teleport it from the map.
- **Build, select and sculpt in 3D.** Build mode breaks and places blocks Minecraft-style, and you can drag to sweep a line. Select mode takes two clicks. Flood Fill fills connected air. Everything goes through the normal undo.
- **Lens** is a floating window with front, side and top views of your selection or your paste. Details are on the [Editing]({{ '/docs/editing/' | relative_url }}) and [Prefabs & Clipboard]({{ '/docs/prefabs-and-clipboard/' | relative_url }}) pages.

Night lighting, sun shadows and GPU shadows in the 3D view are experimental<span class="tag-exp">exp</span>. They're slow on big worlds and off by default. You can also change the sky colours and hide the grid and HUD.

The old quad view (four panes with front and side slices) is gone. The Lens and the floating 3D window replaced it.

## Selecting

Drag a rectangle with Select, click with the Magic Wand to flood-select connected blocks, freehand with Lasso, or click points with Polygon Select. Wand, Lasso and Polygon selections keep their real shape, and fill, replace, delete, move, gradient, extrude and copy all respect it. A selection can also grow or shrink by a block, move by dragging inside it, or nudge with the arrow keys.

The Inspector shows the selection's size, Z range, volume, bounds and whether it's rectangular or shaped.

## Editing

The draw tools are Pen, Brush, Spray, Line, Rectangle, Ellipse, Polygon, Fill Bucket and Eyedropper. Brushes go from 1 to 9 blocks wide, square or round. A stroke stabilizer smooths shaky hands, and a draw mask limits painting to cells that already hold a chosen block.

On a selection you can fill, replace, delete (with an optional block filter, which can be inverted), extrude along any axis, or run a gradient fill that blends one block into another with ordered dithering instead of visible bands.

The hotbar holds five pinned blocks (keys <kbd>1</kbd> to <kbd>5</kbd>) and five recent ones (<kbd>6</kbd> to <kbd>0</kbd>). A held stroke undoes as one step. Undo has a memory budget, and an edit too big to undo is refused up front and leaves the world alone.

The Insert tab has a few extras: tree planting (normal, terrain, pine and tall pine), water and lava flow simulation, pool fill, a wavy water surface, and Materialize, which turns empty chunk space into flat terrain.

## Terrain sculpting <span class="tag-exp">experimental</span>

Sixteen brush tools: Raise, Lower, Rock, Carve, Smooth, Flatten, Slope, Noise, Erode, Thermal, Hydro, Terrace, Sharpen, Smear, Grab and Retexture. Rock and Carve work on volume rather than a height map. Rock fuses a mass into the terrain so it doesn't sit on top like a pasted object, and Carve digs a rounded hollow without opening a roof or hitting bedrock.

You pick the falloff profile, radius, strength and softness. With Live Brush on, the terrain changes as you drag. Off, it applies when you let go. Hold <kbd>Ctrl</kbd> or <kbd>⌘</kbd> to swap Raise and Lower, hold <kbd>Shift</kbd> to smooth, and use <kbd>[</kbd> and <kbd>]</kbd> to resize the brush. You can limit a stroke to the current selection, and sculpt in the 3D view as well as on the map.

## World generation

The New World dialog has four generators, and each can make a 64-high (Legacy) or 256-high world.

- **Flat**: a fixed-height world with stone and dirt layers you set.
- **Natural**: continents, ridges, erosion, rivers, lakes and ocean, caves, ores, trees, structures and clouds. You can use one biome or mix several, and get a live preview.
- **Classic**: a port of the original game's generator, with seeded Perlin noise and hand-carved caves.
- **Tg2**: a port of the Eden 2.0 TerrainGen2 generator, with nine terrain types, sky islands and structures.

## Clipboard and prefabs

Copy and cut any volume (cut is a single undo step). When pasting you can rotate, mirror, skip air, follow the terrain surface, or stay armed and repeat. Paste places in two clicks: the first locks the position, the second commits. Scatter drops N copies at random inside an area, and Array lays out a grid with fixed spacing.

Prefabs (`.epfab` files) save the clipboard, including its exact shape. The Prefabs tab in the sidebar is a searchable gallery with thumbnails, and clicking one arms it for pasting. Extrude repeats a selection N times along an axis.

{% include placeholder.html caption="The Prefabs tab in the sidebar, showing a gallery of saved structures" ratio="4/3" %}

## Files and servers

VuencEdit opens and saves `.eden` and `.eden.zip`. The first save over a file keeps a backup next to it. Autosave records only your changes, and if the app crashes there is a recovery prompt on the next launch.

Browse Worlds searches and downloads from the Eden community servers, with preview images, date filters and a sort that pushes junk down. Upload sends a world back with a PNG thumbnail. Export PNG renders the top-down map at one pixel per block.

OBJ, VOX and VMF export, and Minecraft schematic import, were removed. That work continues in [EdenToMC](https://github.com/hagg3/EdenToMC).

## Texture packs <span class="tag-exp">experimental</span>

Load a ZIP of PNG tiles, or an atlas image, to texture the 3D view and the block picker. The top-down map stays flat-coloured. Tiles are converted to greyscale and tinted by each block's colour, so one pack covers every paint variant.

## Eden.eden template <span class="tag-exp">experimental</span>

Load the game's `Eden.eden` to show its terrain under your world as an overlay, or use Insert ▸ Expand to grow your world from it.

<div class="btn-row">
  <a class="btn btn-primary" href="{{ '/downloads/' | relative_url }}">Download VuencEdit</a>
</div>
