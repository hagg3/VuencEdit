---
layout: page
title: About
description: "About VuencEdit, a community-made world editor for Eden: World Builder: credits, history (Eden World Manipulator, Vuenctools) and backing up your worlds."
---

## Credits

VuencEdit is based on [Eden World Manipulator](https://github.com/jldeiro/EdenWorldManipulator2.0),
which is itself based on [Vuenctools](https://github.com/bLUUBfACE/EdenWorldManipulator). Original
file format documentation by [Robert Munafo](https://mrob.com/pub/vidgames/eden-file-format.html).

Eden World Builder was created by Ari Ronen and made open source in 2018.

The [Discord server](https://discord.com/invite/rjYXwBC) for the game and community is the place to ask for help.

## Licence

VuencEdit is free software, and its source is on [GitHub](https://github.com/{{ site.repository }}).
It ports parts of Eden World Builder's source code, which was released under the GNU GPL v3, so the
app as a whole is GPL v3. VuencEdit's own code can also be reused under the MIT licence. The
[licence notice](https://github.com/{{ site.repository }}/blob/main/NOTICE.md) lists which files are
which. The Eden textures and app icon bundled with the app belong to Ari Ronen / Kingly Games and
aren't covered by either licence.

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

- Terrain sculpting, all 15 tools.
- The 3D view itself, plus its night lighting, baked shadows and GPU shadows.
- Texture packs.
- The Eden.eden template overlay and Insert ▸ Expand.
- The compact ribbon.

The Lens window is newer than most of the app, so give it a bit of slack even though it isn't flagged.
Everything else has been in use for a while.

<hr>

<p class="center dim">
  <a href="{{ '/' | relative_url }}">VuencEdit</a> ·
  <a href="https://github.com/{{ site.repository }}">GitHub</a> ·
  <a href="https://discord.com/invite/rjYXwBC">Discord</a>
</p>
