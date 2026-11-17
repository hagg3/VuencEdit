#!/usr/bin/env python3
"""One-off: bake the footer's 88x31 badges into assets/img/badges/, styled like the VuencEdit site
(raised slate panel, hairline bevel, a coloured accent edge, system-ui label), not the pixel-art Eden CE set.
Rendered at 2x (176x62) and shown at 88x31 so the text stays crisp. Needs Pillow; PNGs are committed.
Run from the repo root: python3 docs/_tools/make-badges.py
Rule: one short label per badge, never two lines of text."""
from PIL import Image, ImageDraw, ImageFont
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "assets/img/badges"
FONT = "/System/Library/Fonts/SFNS.ttf"  # macOS system-ui, as on the site's wordmark
TOP, BOT = (0x39, 0x43, 0x4E), (0x2C, 0x34, 0x3D)  # $surface-raised-top / -bot
TEXT = (0xDF, 0xE4, 0xE8)                           # $text
BADGES = [("eden-ce", "Eden CE", (0x3F, 0xA8, 0x5C)),
          ("discord", "Discord", (0x58, 0x65, 0xF2)),
          ("github", "GitHub", (0xA3, 0xAD, 0xB6)),
          ("rss", "RSS", (0xD9, 0x8A, 0x2B))]
W, H = 176, 62


def make(name, label, accent):
    im = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(im)
    for y in range(H):
        t = y / (H - 1)
        d.line((0, y, W, y), fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOT)))
    d.rectangle((0, 0, 7, H - 1), fill=accent)                       # accent edge
    d.line((8, 1, W - 2, 1), fill=(0x4B, 0x56, 0x62))                # top bevel highlight
    d.rectangle((0, 0, W - 1, H - 1), outline=(0x14, 0x19, 0x1E), width=2)
    font = ImageFont.truetype(FONT, 30)
    try:
        font.set_variation_by_name("Semibold")
    except Exception:
        pass
    size = 30
    while True:
        l, t, r, b = d.textbbox((0, 0), label, font=font)
        if r - l <= W - 36 or size <= 12:
            break
        size -= 1
        font = ImageFont.truetype(FONT, size)
    cx = 8 + (W - 8) / 2
    d.text((round(cx - (r - l) / 2 - l), round((H - (b - t)) / 2 - t)), label, font=font, fill=TEXT)
    im.save(OUT / f"{name}.png", optimize=True)


OUT.mkdir(parents=True, exist_ok=True)
(OUT / "gpl.png").unlink(missing_ok=True)
for b in BADGES:
    make(*b)
