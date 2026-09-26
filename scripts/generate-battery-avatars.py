#!/usr/bin/env python3
"""Prebuild the 21 five-percent variants of the forum avatar.

Requires Pillow only when regenerating assets; the updater needs Node alone.
"""

from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets" / "battery-avatar"
SOURCE = ASSETS / "source.jpg"


def main() -> None:
    with Image.open(SOURCE) as original:
        original = original.convert("RGB")
        width, height = original.size
        if width != height:
            raise ValueError(f"Avatar must be square, got {width}x{height}")

        for percent in range(0, 101, 5):
            image = original.copy()
            top_height = round(height * percent / 100)
            if top_height:
                area = (0, 0, width, top_height)
                image.paste(ImageOps.invert(original.crop(area)), area)
            image.save(ASSETS / f"{percent:03}.jpg", quality=95, subsampling=0)


if __name__ == "__main__":
    main()
