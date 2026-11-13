---
layout: doc
title: 3D view and building in 3D
subtitle: Fly around, then place and break blocks.
---

The 3D view is experimental. It's off until you open it, so it costs nothing when closed.

## 1. Open it

Press <kbd>⌥3</kbd> (<kbd>Alt+3</kbd>) or use View ▸ Windows ▸ 3D View. It floats over the map. Press <kbd>Tab</kbd> with the map focused to swap the two, so 3D becomes the main pane.

{% include placeholder.html caption="The 3D window floating over the map" file="tut-3d-01-open.webp" shot="Default layout, 3D window open at default size, a terrain with hills in view" %}

## 2. Move the camera

Press <kbd>Z</kbd> to cycle Orbit, Mouselook and Fly. In Fly, use <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> and <kbd>Space</kbd>, with <kbd>Shift</kbd> to go faster and the wheel to change speed. The camera shows as a dot on the map, and clicking the map teleports it.

## 3. Switch to Build

On the **3D** tab, set the mode to **Build**. Pick a block from the Block button or a hotbar key.

- Left-click breaks a block.
- Right-click places the build block against the face you're aiming at.
- Drag to sweep a line of edits.

Turn on **Auto-orient** so ramps, wedges and doors face you when you place them.

{% include placeholder.html caption="Build mode with a block face highlighted under the crosshair" file="tut-3d-02-build.webp" shot="3D pane enlarged, 3D tab in Build mode, a half-built wall, highlighted face under the cursor" %}

## 4. Other modes

- **Select**: click two blocks to make a selection box.
- **Sculpt**: hold the left button to sculpt under the crosshair.
- **Flood Fill**: click a face to fill the connected air.

## 5. Undo

All of it uses the same undo as the map. A sweep or a sculpt stroke is one step. To work inside a house or cave, set a cutaway height under View ▸ Map view so the roof is hidden.

See [Layout & 3D View]({{ '/docs/layout-and-3d/' | relative_url }}) for lighting and texture packs.
