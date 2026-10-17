---
layout: doc
title: Getting Started
subtitle: Open a world, move around, and make your first edit.
---

## Opening a world

The splash screen has four ways in. **New** makes a world from one of four generators. **Open** loads a `.eden` or `.eden.zip` from disk. **Browse** searches and downloads from the Eden community servers. Once you've opened a few worlds, a Recent Worlds list shows up too. Settings and About are in the same column.

The first time you load a world, a short guided tour points out the main parts of the window. <kbd>Esc</kbd> skips it, and the Guided Tour entry in the application menu replays it.

## The window

You get a top-down, colour-coded map. Every block type has its own colour, and painted blocks are tinted to match.

- **Middle-drag**, or hold <kbd>Space</kbd> and drag, to pan.
- **Scroll** to zoom toward the cursor.
- <kbd>Home</kbd> or <kbd>⌘0</kbd> fits the whole world in the window.

The 3D view, a Tools window and a Hotbar float over the map. You can move, resize, collapse or hide them. The [Layout & 3D View]({{ '/docs/layout-and-3d/' | relative_url }}) page covers them.

The ribbon along the top has Home, Draw, Sculpt, Insert and View tabs. A 3D tab appears when the 3D window is open, a Selection tab when you have a selection, and a Clipboard tab when something is copied. If you can't find a command, <kbd>⌘K</kbd> (<kbd>Ctrl+K</kbd> on Windows and Linux) searches all of them.

## Your first edit

1. Pick a block and paint from the Block button, or press a hotbar key (<kbd>1</kbd> to <kbd>5</kbd> pinned, <kbd>6</kbd> to <kbd>0</kbd> recent).
2. Choose a tool: Pen (<kbd>P</kbd>) for single blocks, Brush (<kbd>B</kbd>) for a bigger footprint, or Rectangle (<kbd>R</kbd>) and Ellipse (<kbd>E</kbd>) for shapes.
3. Click or drag on the map.
4. <kbd>⌘Z</kbd> (<kbd>Ctrl+Z</kbd>) undoes it. The History tab in the sidebar lists the steps. A held stroke undoes as one step no matter how long you held the mouse down.

## Selecting a region

Drag with Select (<kbd>S</kbd>) for a rectangle. The Magic Wand (<kbd>W</kbd>) selects connected matching blocks, Lasso (<kbd>K</kbd>) is freehand, and Polygon Select (<kbd>J</kbd>) is click-by-click. The shape you select is the shape that gets edited, not its bounding box.

A selection brings up the Selection tab (fill, replace, delete, extrude, gradient), the Inspector tab in the sidebar, and the Lens window with front and side views. The [Editing]({{ '/docs/editing/' | relative_url }}) page has the details.

## Saving

<kbd>⌘S</kbd> (<kbd>Ctrl+S</kbd>) saves to the file you opened. The first save over a file also keeps a backup next to it, as a `.bak` or a smaller `.bak.zip` if you turn on Compress backups in Settings. Autosave runs in the background, and if the app or your machine crashes, you get a recovery prompt next time. Still, keep your own copy of anything you care about. This is a beta and it writes the game's binary files directly.
