---
layout: doc
title: Prefabs & Clipboard
subtitle: Copy, paste, and the prefab library.
---

## Copy and paste

With a selection, <kbd>⌘C</kbd> copies the volume (block types and paints). Cut copies it and then clears it, as a single undo step. <kbd>⌘V</kbd> arms a paste, and the Clipboard tab shows up in the ribbon.

Paste options:

- **Skip air** leaves existing blocks alone wherever the clipboard has air, so you only overwrite what the structure fills.
- **Follow terrain** places each column on the local surface instead of at one fixed height, so a structure can follow uneven ground.
- **Rotate** turns the clipboard 90°, and **Flip X** and **Flip Y** mirror it. Ramps, wedges and doors are remapped so they still face the right way.
- **Repeat on each click** keeps the paste armed after you place it.

Placement takes two clicks. The first locks the position and turns the ghost amber. The second stamps it. <kbd>Esc</kbd> backs out. <kbd>Page Up</kbd> and <kbd>Page Down</kbd> change the height offset by one block, and <kbd>Shift</kbd> makes it five. <kbd>.</kbd> repeats the last paste step in the same direction.

The paste Lens is a window next to the ghost with front and side views, so you can see how deep a paste will sit in the terrain before you commit. It's on by default. Settings ▸ Layout & windows has a switch for it.

{% include placeholder.html caption="The Lens next to an armed paste, showing front and side views" ratio="16/9" %}

### Scatter and Array

Paste Mode switches between Single (one copy per click), Scatter and Array. Scatter places N copies at random positions inside the selection. Array places a grid of copies with fixed spacing.

## Prefabs

Copy something, then save the clipboard as a prefab. Save goes into your prefab library, and Save As writes the `.epfab` file wherever you want. Load Prefab reads one back into the clipboard.

The library is the sidebar's Prefabs tab, also reachable from Insert ▸ Prefab. It has search, sorting, thumbnails, and list or grid views, with rename and delete in place. Clicking a prefab arms it for pasting, and from there it works like any other paste.

Prefab files are gzip-compressed and keep the exact shape you selected. A Lasso or Wand selection stays non-rectangular. You can change the library's folder in Settings ▸ Files.

{% include placeholder.html caption="The Prefabs tab, showing a gallery of saved structures" ratio="4/3" %}

## Export

Export PNG, in the application menu, saves a top-down render of the map at one pixel per block. There's no OBJ, VOX or VMF export and no Minecraft schematic import. Those were removed from this project and live on in [EdenToMC](https://github.com/hagg3/EdenToMC).
