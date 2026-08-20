---
layout: doc
title: World Compatibility
subtitle: Legacy64z, New Dawn 256z, and NewFormat256z — what each means for you.
---

Eden World Builder's file format has changed twice since launch. VuencEdit detects which version
a world file uses automatically when you open it — you don't need to tell it anything — and shows
the detected format in the status bar and the World Info panel.

<table>
  <thead>
    <tr><th>Format</th><th>Height levels</th><th>What it is</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Legacy64z</strong></td>
      <td>0–63</td>
      <td>The original format, from before the New Dawn update. Worlds are shallower — 64
      vertical levels instead of 256.</td>
    </tr>
    <tr>
      <td><strong>NewDawn256z</strong></td>
      <td>0–255</td>
      <td>The New Dawn update's format. Same 256-level depth as NewFormat256z below, but without
      the newer block types or sign data.</td>
    </tr>
    <tr>
      <td><strong>NewFormat256z</strong></td>
      <td>0–255</td>
      <td>A 2026 game update. Also 256 levels, plus 16 additional block types and in-game sign
      text, which VuencEdit reads and displays.</td>
    </tr>
  </tbody>
</table>

## What this means in practice

- **Opening a world** works the same regardless of format — VuencEdit reads the header and picks
  the right layout before showing you anything.
- **New worlds**: every generator (Flat, Natural, Classic, Tg2) lets you choose 64z or 256z when
  you create a world, so you can target whichever format matches where you'll play it.
- **Saving** always writes back in the same format the world was loaded in — VuencEdit won't
  silently upgrade or downgrade a world's height format.
- **The new block types (112–127)** introduced by NewFormat256z are only placeable on a
  NewFormat256z world; they show up behind a small disclosure in the block picker rather than
  cluttering the default palette, since most worlds never use them.
- **Signs** — text signs placed in-game are read-only in VuencEdit right now: they show up as
  markers on the map and are listed in the sidebar, but nothing in the app currently writes new
  sign text.

## If you're not sure which format a world is

Open **World Info** from the application menu — it shows the detected format alongside the seed,
dimensions, and spawn position. If a world caps out at Z=63, it's Legacy64z; if it reaches Z=255,
it's one of the two 256z variants, and World Info tells you which.
