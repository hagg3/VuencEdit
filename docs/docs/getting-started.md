---
layout: doc
title: Getting Started
subtitle: Open a world, move around, and make your first edit.
---

## Opening a world

The splash screen that greets you on launch has four ways in: **New** (start a fresh world from
one of four generators), **Open** (pick a `.eden` or `.eden.zip` file from disk), **Browse**
(search and download a world from the Eden community servers), or a **Recent Worlds** list once
you've opened a few. Settings and About sit in the same column if you want to check them first.

The first time you load a world, VuencEdit walks you through a short, skippable guided tour of the
main surfaces — you can press <kbd>Esc</kbd> at any point, and replay it later from
**Help ▸ Take the guided tour**.

## The map

Once a world is open you're looking at a top-down, colour-coded map — every block type has its
own colour, and painted blocks are tinted accordingly.

- **Middle-drag** (or hold <kbd>Space</kbd> and drag) to pan.
- **Scroll** to zoom.
- **Home** fits the whole world in the window.

The ribbon across the top has five permanent tabs — **Home, Draw, Sculpt, Insert, View** — plus
**3D, Selection**, and **Clipboard** tabs that appear only when they're relevant. The left toolbar
holds the everyday draw and select tools, each with its own one-key shortcut, and the current
block + paint you're placing is shown in the palette (keys <kbd>1</kbd>–<kbd>5</kbd> arm pinned
blocks, <kbd>6</kbd>–<kbd>0</kbd> jump to recently used ones).

## Your first edit

1. Pick a block and paint from the palette (or press a hotbar key).
2. Choose a tool from the left toolbar — **Pen** (<kbd>P</kbd>) for single blocks, **Brush**
   (<kbd>B</kbd>) for a bigger footprint, or **Rectangle**/**Ellipse** for shapes.
3. Click (or click-drag) on the map.
4. <kbd>⌘Z</kbd> / <kbd>Ctrl+Z</kbd> undoes it if you don't like the result — the sidebar's
   **History** tab lists every step, and an entire held stroke undoes as one action no matter how
   long you held the mouse down.

## Selecting a region

Drag on the map with the **Select** tool to draw a rectangle, or use the **Magic Wand**
(<kbd>W</kbd>) to flood-select every connected block matching what you clicked, or the **Lasso**
(<kbd>K</kbd>) to freehand a shape. Wand and Lasso selections are real shapes, not just bounding
boxes — every edit and preview respects the exact cells you selected. Once something is selected,
the **Selection** and **Clipboard** tabs appear with fill/replace/delete/copy/extrude actions, and
the sidebar's **Inspector** tab shows dimensions, block counts, and an elevation preview.

## Saving

<kbd>⌘S</kbd> / <kbd>Ctrl+S</kbd> saves back to the file you opened. An autosave also runs quietly
in the background, and there's a recovery flow if the app or your machine crashes mid-session.
VuencEdit is beta software that writes binary world files directly — turn on the backup-on-save
option in Settings, or keep your own copy of anything you care about.

## Where to next

- [Editing](../editing/) — the full draw-tool, selection, and sculpting reference.
- [3D & Quad View](../3d-and-quad-view/) — the four-pane editor and the fly-through pane.
- [Prefabs & Clipboard](../prefabs-and-clipboard/) — reusing structures across worlds.
