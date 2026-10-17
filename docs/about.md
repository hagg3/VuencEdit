---
layout: page
title: About
---

## Credits

VuencEdit is based on [Eden World Manipulator](https://github.com/jldeiro/EdenWorldManipulator2.0),
which is itself based on [Vuenctools](https://github.com/bLUUBfACE/EdenWorldManipulator). Original
file format documentation by [Robert Munafo](https://mrob.com/pub/vidgames/eden-file-format.html).

Eden World Builder was created by Ari Ronen and made open source in 2018.

The [Discord server](https://discord.com/invite/rjYXwBC) for the game and community is the place to ask for help.

<hr>

## Not affiliated

VuencEdit is an independent, community-made tool. It is **not affiliated with, endorsed by, or
supported by** Eden World Builder's developer. If something breaks in the game itself, report it on
the Discord server above, not here.

## Back up your worlds

VuencEdit reads and writes the game's binary world files directly. The first save over a file keeps
a backup next to it (`.bak`, or a smaller `.bak.zip` if you turn on Compress backups in Settings).
Saves are atomic, so an interrupted save won't leave a half-written world. That doesn't help if you
save an edit you didn't mean to make, so copy anything important before a big session.

## Provided as-is

VuencEdit comes without warranty of any kind, and you use it at your own risk. It's built in
spare time, and it may misbehave on a world, platform or game version nobody has tried.

<hr>

## Beta and experimental features

The whole app is a beta, so expect rough edges and the occasional bug. A few features are marked
<span class="tag-exp">exp</span> in the app and on this site because they're newer, heavier or more
likely to change:

- Terrain sculpting, all 16 tools.
- The 3D view itself, plus its night lighting, baked shadows and GPU shadows.
- Texture packs.
- The Eden.eden template overlay and Insert ▸ Expand.
- The compact ribbon.

The Lens window is also new in 1.0.18, so give it a bit of slack even though it isn't flagged.
Everything else has been in use for a while.

<hr>

<p style="text-align:center; color:#8b959e; font-size:13px;">
  <a href="{{ '/' | relative_url }}">VuencEdit</a> ·
  <a href="https://github.com/{{ site.repository }}">GitHub</a> ·
  <a href="https://discord.com/invite/rjYXwBC">Discord</a>
</p>
