---
layout: doc
title: World Compatibility
subtitle: Legacy64z, New Dawn 256z, and NewFormat256z, and what each means for you.
---

Eden World Builder's file format has changed twice since launch. VuencEdit works out which one a file uses when you open it. You don't have to tell it anything.

<table>
  <thead>
    <tr><th>Format</th><th>Height levels</th><th>What it is</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Legacy64z</strong></td>
      <td>0 to 63</td>
      <td>The original format, from before the New Dawn update. Worlds are 64 levels tall.</td>
    </tr>
    <tr>
      <td><strong>NewDawn256z</strong></td>
      <td>0 to 255</td>
      <td>The New Dawn update's format. Same 256 levels as NewFormat256z, without the newer block types or sign data.</td>
    </tr>
    <tr>
      <td><strong>NewFormat256z</strong></td>
      <td>0 to 255</td>
      <td>A 2026 game update. 256 levels, 16 more block types, and in-game sign text, which VuencEdit reads and shows.</td>
    </tr>
  </tbody>
</table>

## In practice

- **Opening** works the same for all three. The header tells VuencEdit the layout before anything is drawn.
- **New worlds**: every generator (Flat, Natural, Classic, Tg2) lets you pick 64 or 256 levels, so you can match the version you'll play on.
- **Saving** writes the world back in the format it was loaded in. It never upgrades or downgrades the height format.
- **The new block types (112 to 127)** can only be placed on a NewFormat256z world. They sit behind a small disclosure in the block picker so they don't clutter the palette, since most worlds don't use them.
- **Signs** are read-only. They show as markers on the map (View ▸ Sign Markers) and in the Inspector's Signs section, but VuencEdit can't create or edit sign text.
- **Zipped worlds**: `.eden.zip` opens and saves like a plain `.eden`. Settings has an option to save new worlds compressed by default.

## Which format is my world?

Open World Properties from the application menu. It shows the detected format next to the seed, dimensions and spawn position. A world that tops out at Z=63 is Legacy64z. One that reaches Z=255 is one of the two 256z formats, and World Properties says which.
