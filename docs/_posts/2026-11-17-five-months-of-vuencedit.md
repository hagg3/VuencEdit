---
layout: post
title: Five months of VuencEdit
subtitle: A look back, from the first commit to the release candidate
description: "How VuencEdit went from a weekend experiment in June to a release candidate in November, and what the beta testers helped shape along the way."
---

VuencEdit is set to leave beta soon, so I wanted to look back at how the program has evolved. Thanks to everyone who helped test the program (and suffered through some of the bugs and memory leaks). 

## June: manipulator 2.0

{% include screenshot.html src="/assets/img/blog/five-months/june1.webp" alt="The first VuencEdit builds: a 2D map of an Eden world." width="1600" height="1159" lazy=true %}
The program started on 13 June when I gave Claude Code [the source code for the old Eden World Manipulator program](https://edenworldbuilder.fandom.com/wiki/Eden_World_Manipulator) and asked for a cross-platform port based on Rust and Tauri. Within a week there was a working 2D map, copy and paste, prefabs, trees, shared worlds, and draw tools. 

{% include screenshot.html src="/assets/img/blog/five-months/june2.webp" alt="The experimental quad view with the first 3D viewport." width="1600" height="1176" lazy=true %}
The **3D viewport** showed up towards the end of June as part of an experimental Hammer editor inspired quad view. It was rough, but it meant you could finally fly around a world you were editing. 

{% include screenshot.html src="/assets/img/blog/five-months/june3.webp" alt="The first version of the ribbon." width="1600" height="195" lazy=true %}
The first version of the **ribbon** (the tabbed toolbar across the top) arrived at the end of the month. Before then, the tools lived in a much less tidy set of buttons.

## July: refinements

{% include screenshot.html src="/assets/img/blog/five-months/july1.webp" alt="VuencEdit in July, with the 3D view alongside the map." width="1600" height="973" lazy=true %}
Updates in July focussed on refining and making the editing tools feel nice to use. There was a lot of optimization work done on the 3D view especially. 

{% include screenshot.html src="/assets/img/blog/five-months/july2.webp" alt="Sculpting and selection tools in July." width="1442" height="722" lazy=true %}
- Building, selecting and lighting was brought into the 3D view.
- The **sculpt engine was reworked**, and the Hydro tool was rewritten as a proper hydraulic erosion simulation.
- You could **sculpt live in the 2D view** and see the stroke as you drew it.
- **Wand and lasso selections** meant you could select an irregular shape instead of only a rectangle.

## August: ribbon overhaul

The first ribbon was a bit of an experiment to see how well (if at all) that sort of MS Office-esque UI could work for this sort of program (it is an authoring tool after all). Given the rate of features being added and the fact that little thorough testing had been done, I felt it was worth sticking with it to balance feature discoverability whilst avoiding an intimidating interface for new users (in other words, it was easier to brush stuff into tabs until I could later figure out how to properly organize it).

{% include screenshot.html src="/assets/img/blog/five-months/august1.webp" alt="A first Figma sketch of the redesigned ribbon." width="1800" height="326" lazy=true %}
By now, it was clear that the ribbon needed a complete overhaul if it was to be kept. I read up on the [design guidelines from Microsoft](https://learn.microsoft.com/en-us/windows/win32/uxguide/cmd-ribbons) from back when they were pushing these ribbon UI's. That article is really interesting if you are kinda nerdy about UI design. What you see above is my first sketch, in figma, of a redesigned ribbon. 

{% include screenshot.html src="/assets/img/blog/five-months/august2.webp" alt="The redesigned ribbon, much like the one used today." width="1600" height="1061" lazy=true %}
Minus a few density tweaks, the outcome is pretty much the same as the UI used today.

## September: the big rewrites

September was the least visible month and probably the most important. Adding of new features stopped completely. The new Claude models were really useful in running hard audits of memory use, CPU use and disk use. Whilst (partly owing to the fact this is a Rust/Tauri based program) storage and memory usage was not really a huge problem until now, there were some serious memory leaks and other issues affecting certain Windows users that were reported via Discord.

Alongside the rewrites came a round of design exploration, which led to a cleaner set of viewports and icons.

## October: the Lens, and `.emod`

{% include screenshot.html src="/assets/img/blog/five-months/october1.webp" alt="The floating-window layout: the 2D map fills the workspace with the 3D view floating on top." width="1403" height="896" lazy=true %}
By this point, enough feedback from users (and the fact I barely used the front/side viewports) motivated a rethink of the editing space. Instead of quad view, floating and collapsable windows were opted for instead. By default the 2D map now fills the entire workspace and the 3D view floats on top (the placement of 2D and 3D can be swapped, so 3D fills the space instead).

## November: polish for 1.0

The latest betas have mostly been about polishing rough edges and cleaning up the app ready for release. 

## Thank you

If you've got a bug or a wish, open an issue on [GitHub](https://github.com/{{ site.repository }}/issues). To try the latest build, head to [Downloads]({{ '/downloads/' | relative_url }}).

sam
