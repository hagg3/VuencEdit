---
layout: doc
title: Prefabs & Clipboard
subtitle: Copy/paste and the prefab library.
---

## Copy & paste

With a selection active, **Copy** captures the volume (block types and paints); **Cut** copies
then deletes in one undo step. When you paste, you can combine any of:

- **No Air** — skip air cells so you only overwrite what the structure actually occupies.
- **Terrain-align** — instead of pasting at a fixed height, each column lands relative to the
  ground's own surface height, so a structure follows uneven terrain.
- **Rotate 90°** — including correct remapping for ramps and wedges.
- **Flip X / Flip Y** — mirrors, also remapping ramp/wedge orientation correctly.
- **Repeat** — keep the same clipboard armed for placing multiple copies in a row.

**Two-click placement**: the first click locks the XY position (shown as an amber ghost with a
live elevation preview), and the second click commits it. <kbd>Esc</kbd> cancels without pasting.
<kbd>Page Up</kbd>/<kbd>Page Down</kbd> nudge the paste's Z offset while it's armed.

### Advanced paste

Two extra placement modes, available once something is on the clipboard:

- **Scatter** — places N copies at random positions within a chosen area.
- **Array** — places a rows × columns grid of copies with configurable spacing.

## Prefabs

Save any selection straight into your prefab library, or use *Save As…* to write it anywhere on
disk. The library lives in the sidebar's **Prefabs** tab: a searchable, sortable gallery with
thumbnails, list/grid views, and inline rename/delete. Clicking a prefab arms it for pasting, the
same two-click flow as a regular clipboard paste.

Prefab files (`.epfab`) are gzip-compressed and store the exact shape you selected — including a
non-rectangular Wand or Lasso selection, not just its bounding box.

{% include placeholder.html caption="The Prefabs tab, showing a gallery of saved structures" ratio="4/3" %}

## Export

PNG image export — a top-down render of the map — lives on the **File → Export** menu.
Minecraft schematic import and OBJ/Source Engine VMF export moved to the sibling
[EdenToMC](https://github.com/hagg3/EdenToMC) project.
