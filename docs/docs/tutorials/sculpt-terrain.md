---
layout: doc
title: Sculpt terrain
subtitle: Raise a hill, smooth it, and add detail.
---

Sculpting is experimental. Save a copy of your world first, and remember <kbd>⌘Z</kbd> undoes each stroke as one step.

## 1. Open the Sculpt tab

Click the **Sculpt** tab in the ribbon. It has the tool list and the Brush and Falloff groups. Pick **Raise**. The options bar shows the tool picker and brush sliders.

{% include placeholder.html caption="The Sculpt tab with Raise selected" file="tut-sculpt-01-tab.webp" shot="Sculpt tab active, Raise armed, options bar showing the brush sliders" %}

## 2. Size the brush

Press <kbd>]</kbd> to grow the radius and <kbd>[</kbd> to shrink it. <kbd>Shift</kbd>+<kbd>[</kbd> and <kbd>Shift</kbd>+<kbd>]</kbd> change the strength. A low strength and a soft falloff give gentle results.

## 3. Raise a hill

Hold the mouse down and drag over a flat area. With Live Brush on the terrain changes as you drag. With it off, the stroke applies when you let go. <kbd>Esc</kbd> mid-stroke reverts it.

Hold <kbd>⌘</kbd> or <kbd>Ctrl</kbd> to lower for one stroke.

{% include placeholder.html caption="A hill raised on a flat map, shown in Relief render" file="tut-sculpt-02-raise.webp" shot="View > Render > Relief, flat world, one hill raised, brush circle visible" %}

## 4. Smooth and add detail

Hold <kbd>Shift</kbd> and drag over the hill to smooth it. Then try **Noise** for rough ground, **Terrace** for steps, or **Retexture** to repaint the surface by slope.

{% include placeholder.html caption="The same hill after Smooth, with Noise detail on the slopes" file="tut-sculpt-03-detail.webp" shot="Same view as the previous shot, hill smoothed and Noise applied to the flanks" %}

## 5. Keep it inside an area

Select a region first, then turn on **Sculpt in Selection**. Strokes only change terrain inside the selection.

## 6. Check it in 3D

Press <kbd>⌥3</kbd> (<kbd>Alt+3</kbd>) to open the 3D view. Sculpt tools work there too, and you can see the shape from the side.

Next: [Copy, paste and prefabs]({{ '/docs/tutorials/copy-paste-prefabs/' | relative_url }}). All the tools are listed on the [Editing]({{ '/docs/editing/' | relative_url }}) page.
