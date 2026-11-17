#!/usr/bin/env python3
"""One-off: bake the footer's 88x31 badges into assets/img/badges/. Same recipe as the Eden CE site's
badges so the two sites match. Needs Pillow plus Eden CE's
Jersey 10 font and grass tile (neither is copied here; the PNGs are committed).
Run from the repo root: python3 docs/_tools/make-badges.py [path/to/eden-ce-checkout]
Rule: one short label per badge, never two lines of text."""
from PIL import Image, ImageDraw, ImageFont
import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "assets/img/badges"
EMOD = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path.home() / "emod")
FONT = str(EMOD / "media/fonts/Jersey10-Regular.ttf")
GRASS = EMOD / "site/static/img/tile-grass.png"
BADGES = [("eden-ce", "EDEN CE", None, (255, 255, 255)),
          ("discord", "Discord", (88, 101, 242), (255, 255, 255)),
          ("github", "GitHub", (36, 41, 47), (255, 255, 255)),
          ("gpl", "GPLv3", (164, 42, 42), (255, 255, 255)),
          ("rss", "RSS", (230, 120, 20), (255, 255, 255))]


def make(name, label, bg, fg):
    im = Image.new("RGB", (88, 31), bg or (0, 0, 0))
    if bg is None:  # grass tile
        tile = Image.open(GRASS).convert("RGB").resize((16, 16), Image.NEAREST)
        for x in range(0, 88, 16):
            for y in range(0, 31, 16):
                im.paste(tile, (x, y))
    d = ImageDraw.Draw(im)
    size = 30
    while size > 8:
        font = ImageFont.truetype(FONT, size)
        l, t, r, b = d.textbbox((0, 0), label, font=font)
        if r - l <= 80 and b - t <= 23:
            break
        size -= 1
    x = round((88 - (r - l)) / 2) - l
    y = round((31 - (b - t)) / 2) - t
    d.text((x + 1, y + 1), label, font=font, fill=(0, 0, 0))
    d.text((x, y), label, font=font, fill=fg)
    d.rectangle((0, 0, 87, 30), outline=(0, 0, 0))
    d.line((1, 1, 86, 1), fill=(255, 255, 255)); d.line((1, 1, 1, 29), fill=(255, 255, 255))
    d.line((1, 29, 86, 29), fill=(60, 60, 60)); d.line((86, 1, 86, 29), fill=(60, 60, 60))
    im.quantize(32).save(OUT / f"{name}.png", optimize=True)


OUT.mkdir(parents=True, exist_ok=True)
for b in BADGES:
    make(*b)
