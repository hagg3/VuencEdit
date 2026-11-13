---
layout: doc
title: Copy, paste and prefabs
subtitle: Copy a structure, stamp it down, and keep it in your library.
---

## 1. Select a structure

Press <kbd>S</kbd> and drag a box around a building. Use the Lens window to check the Z range: drag its edge handles so the selection covers the whole height of the structure. For a round or irregular shape, use Lasso (<kbd>K</kbd>) or Magic Wand (<kbd>W</kbd>), which keep their exact shape.

{% include placeholder.html caption="A building selected, with the Lens showing the Z range" file="tut-paste-01-select.webp" shot="Map zoomed on a small building, Select box around it, Lens window open with the front view" %}

## 2. Copy

Press <kbd>⌘C</kbd> (<kbd>Ctrl+C</kbd>). The Clipboard tab appears in the ribbon.

## 3. Paste

Press <kbd>⌘V</kbd>. A ghost of the structure follows the cursor. In the options bar:

- **Skip air** keeps what's already there wherever the structure is empty.
- **Rotate** turns it 90°, **Flip X** and **Flip Y** mirror it.
- **Follow terrain** sets each column on the local surface.

Click once to lock the position (the ghost turns amber). <kbd>Page Up</kbd> and <kbd>Page Down</kbd> change the height. Click again to stamp it. <kbd>Esc</kbd> backs out.

{% include placeholder.html caption="A locked (amber) paste ghost with the options bar showing Skip air, Rotate and Flip" file="tut-paste-02-ghost.webp" shot="Armed paste, position locked, ghost amber, options bar in frame" %}

## 4. Save it as a prefab

With the structure still on the clipboard, use **Insert ▸ Prefab ▸ Save As…** to write an `.epfab` file, or save it into your library. Open the **Prefabs** tab in the sidebar and your prefab appears with a thumbnail.

{% include placeholder.html caption="The Prefabs tab with a new prefab in the grid" file="tut-paste-03-library.webp" shot="Sidebar Prefabs tab, grid view, three or four thumbnails, the new one highlighted" ratio="4/3" %}

## 5. Reuse it

Click a prefab in the library to arm it, then paste as above. To place many, switch Paste Mode to **Scatter** or **Array**, or turn on **Repeat on each click**.

More on the [Prefabs & Clipboard]({{ '/docs/prefabs-and-clipboard/' | relative_url }}) page.
