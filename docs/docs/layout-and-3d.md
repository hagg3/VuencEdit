---
layout: doc
title: Layout & 3D View
subtitle: Floating windows, the 3D pane, and building in 3D.
---

An older beta had a four-pane "quad view" with front and side slices. It's gone. If you had it on, VuencEdit moves you to the layout below and shows a one-time notice.

## The layout

The map fills the work area. Four things float over it:

- **3D View** (<kbd>Alt</kbd>+<kbd>3</kbd>, or <kbd>⌥3</kbd> on a Mac)
- **Tools** (<kbd>Alt</kbd>+<kbd>T</kbd>), a small rail with Pan, Select and the draw tools
- **Hotbar** (<kbd>Alt</kbd>+<kbd>H</kbd>), your pinned and recent blocks
- **Lens** (<kbd>Alt</kbd>+<kbd>P</kbd>), which only appears when you have a selection or a paste armed

Drag a window by its title bar, resize it from any edge or corner, and double-click the title bar to collapse it. Windows snap to the edges of the work area (you can turn that off in Settings). With a title bar focused, the arrow keys move it, <kbd>Alt</kbd>+arrows resize it, and <kbd>Esc</kbd> sends focus back to the map. View ▸ Reset Windows puts everything back where it started.

Press <kbd>Tab</kbd> with the map focused to swap the map and the 3D view. The 3D view becomes the main pane and the map shrinks into the window.

The sidebar on the right is a separate dock, toggled from View ▸ Windows. It holds the Inspector, Prefabs and History tabs.

{% include placeholder.html caption="The default layout with the 3D, Tools and Hotbar windows floating over the map" ratio="16/9" %}

### Mode panels

Some modes get their own small panel next to your work instead of crowding the ribbon. They appear when the mode is on and the ✕ leaves the mode:

- the cutaway or Z-slice level, with a Follow surface option
- the brush shape for Noise, Slope, Rock and Carve
- the Flood Fill limit and the 3D build block
- the 3D sculpt brush

## Cutaway and Z-slice

Both live under View ▸ Map view. Z-slice shows a single horizontal layer. Cutaway hides everything above the cap you set, in both the map and the 3D view, so you can work inside a cave or a house without the roof in the way. Drawing, sculpting and the eyedropper act on the surface you can see at the cap, not on what's hidden above it.

View ▸ Render has Tiled (the default) and Relief. Relief shades slopes so you can read height on a map that is otherwise flat colours.

## The 3D view

It's an experimental Three.js view of the whole world, streamed in chunks around the camera. When it's closed it costs nothing. There are three cameras, and <kbd>Z</kbd> cycles through them:

- **Orbit** rotates around a point and keeps the cursor visible.
- **Mouselook** grabs the cursor and looks around like a first-person game.
- **Fly** moves with <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> and <kbd>Space</kbd>. <kbd>Shift</kbd> boosts and the wheel changes speed.

The camera shows up as a dot on the map. You can teleport it by clicking the map or using the right-click menu. The 3D ribbon tab has fly speed and render distance. A menu in the pane has the HUD, grid, fog and sky colour options.

### Working in 3D

The 3D tab has a mode switch:

- **Camera** only moves the camera.
- **Select**: click two blocks to make a selection box.
- **Build**: left-click breaks a block and right-click places the build block against the face you're aiming at. Drag to sweep a line of edits. Hotbar keys work here too, and Auto-orient turns ramps, wedges and doors to face you when you place them.
- **Sculpt**: hold the left button to sculpt under the crosshair.
- **Flood Fill**: click a block face to fill the connected air.

All of it goes through the same undo as the map, and a sweep or a sculpt stroke is one undo step.

### Lighting <span class="tag-exp">experimental</span>

Night lighting makes lamp blocks glow in their paint colour. Baked shadows add sun shadows, and the Sun slider moves the sun. GPU shadows are a real-time alternative with point lights. All three can be slow, particularly at a long render distance, so they're off by default. You can pick Legacy or New Dawn lamp falloff, since the two game versions light differently.

### Texture packs <span class="tag-exp">experimental</span>

View ▸ Textures loads a ZIP of PNG tiles or an atlas image for the 3D view. The map stays flat-coloured.
