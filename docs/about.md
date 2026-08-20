---
layout: page
title: About
---

## Credits

VuencEdit is based on [Eden World Manipulator](https://github.com/jldeiro/EdenWorldManipulator2.0),
which is itself based on [Vuenctools](https://github.com/bLUUBfACE/EdenWorldManipulator). Original
file format documentation by [Robert Munafo](https://mrob.com/pub/vidgames/eden-file-format.html).

Eden World Builder was created by Ari Ronen and made open source in 2018.

For support, visit the [Discord server](https://discord.com/invite/rjYXwBC) for the game and
community.

<hr>

## Not affiliated

VuencEdit is an independent, community-made tool. It is **not affiliated with, endorsed by, or
supported by** Eden World Builder's developer. If something breaks in the game itself, this isn't
the place to report it — the Discord server above is.

## Back up your worlds

VuencEdit is beta software, and it works by reading and writing the game's binary world files
directly. Before making significant edits, either turn on the backup-on-save option in Settings
(it keeps a compressed copy of the file's pre-save state) or copy the world file yourself. Saves
are written atomically — a save can't corrupt the world if interrupted — but that doesn't protect
you from an edit you didn't mean to make.

## Provided as-is

VuencEdit is provided as-is, without warranty of any kind. Use it at your own risk. The people
who work on it do so in their spare time and can't guarantee it will always behave exactly as
expected on every world, every platform, or every game version.

<hr>

## Beta and experimental features

The application itself is in beta — expect rough edges and the occasional bug. A few specific
features go further and are marked <span class="tag-exp">exp</span> throughout the app and this
site, because they're newer, more performance-sensitive, or more likely to change shape:

- **Terrain sculpting** — the full 16-tool sculpt system.
- **Night lighting & sun shadows** — the 3D pane's lighting previews, including the GPU shadow-map
  mode.
- **Source Engine VMF export** — brushwork export for Hammer.
- **Texture packs** — real block textures in the 3D views.
- **Eden.eden template expansion** — baking the bundled template into a full world file.

Everything else is considered stable, day-to-day functionality.

<hr>

<p style="text-align:center; color:#8b959e; font-size:13px;">
  <a href="{{ '/' | relative_url }}">VuencEdit</a> ·
  <a href="https://github.com/{{ site.repository }}">GitHub</a> ·
  <a href="https://discord.com/invite/rjYXwBC">Discord</a>
</p>
