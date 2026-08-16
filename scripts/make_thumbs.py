#!/usr/bin/env python3
"""Generate any missing card thumbnails.

The storefront loads a small thumbnail for every grid card from
`images/thumbs/<same-filename>`, derived from the full scan's filename. A card
whose full image was uploaded without a matching thumbnail shows a broken image
in the grid (the storefront falls back to the heavy full scan). This script
closes that gap: for every full-size image in `images/` that has no matching
file in `images/thumbs/`, it produces a thumbnail matching the store's spec:

    320px wide, aspect preserved (a 3:4 scan -> 320x427), RGB JPEG at quality 80
    (PNG sources are kept as PNG so the derived thumbnail URL still matches).

Existing thumbnails are left untouched, so it is safe to run repeatedly and
cheap on a large catalogue. Pass --force to regenerate every thumbnail.

Usage:
    python scripts/make_thumbs.py [--force]
"""
import os
import sys

from PIL import Image

IMAGES_DIR = "images"
THUMBS_DIR = os.path.join(IMAGES_DIR, "thumbs")
THUMB_WIDTH = 320
JPEG_QUALITY = 80
EXTS = (".jpg", ".jpeg", ".png")


def main():
    force = "--force" in sys.argv[1:]
    os.makedirs(THUMBS_DIR, exist_ok=True)

    made = skipped = 0
    for name in sorted(os.listdir(IMAGES_DIR)):
        src = os.path.join(IMAGES_DIR, name)
        # Only full images sit directly in images/; skip the thumbs/ subfolder
        # and anything that isn't an image.
        if not os.path.isfile(src):
            continue
        if not name.lower().endswith(EXTS):
            continue

        dst = os.path.join(THUMBS_DIR, name)
        if os.path.exists(dst) and not force:
            continue

        try:
            im = Image.open(src).convert("RGB")
        except Exception as e:
            print(f"  skip (unreadable): {name} -> {e}")
            skipped += 1
            continue

        w, h = im.size
        new_h = round(h * THUMB_WIDTH / w)
        thumb = im.resize((THUMB_WIDTH, new_h), Image.LANCZOS)

        if name.lower().endswith(".png"):
            thumb.save(dst, "PNG", optimize=True)
        else:
            thumb.save(dst, "JPEG", quality=JPEG_QUALITY, optimize=True)

        made += 1
        print(f"  thumb: {name} ({w}x{h} -> {THUMB_WIDTH}x{new_h})")

    print(f"Done. Generated {made} thumbnail(s); {skipped} skipped.")


if __name__ == "__main__":
    main()
