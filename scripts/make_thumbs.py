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
cheap on a large catalogue.

Modes:
    python scripts/make_thumbs.py                 # only generate MISSING thumbnails
    python scripts/make_thumbs.py --force         # (re)generate EVERY thumbnail
    python scripts/make_thumbs.py images/A.jpg …  # (re)generate just these, even if
                                                  # the thumbnail already exists

The last form is what keeps a REPLACED image's thumbnail in step: a replacement
keeps the same filename, so the thumbnail already exists and the default run skips
it — pass the changed file(s) explicitly (the workflow does this automatically for
every image touched in a push) to force those thumbnails to be rebuilt.
"""
import os
import sys

from PIL import Image

IMAGES_DIR = "images"
THUMBS_DIR = os.path.join(IMAGES_DIR, "thumbs")
THUMB_WIDTH = 320
JPEG_QUALITY = 80
EXTS = (".jpg", ".jpeg", ".png")


def render(name):
    """Build one thumbnail from images/<name>; return True if written."""
    src = os.path.join(IMAGES_DIR, name)
    if not os.path.isfile(src) or not name.lower().endswith(EXTS):
        return False
    dst = os.path.join(THUMBS_DIR, name)
    try:
        im = Image.open(src).convert("RGB")
    except Exception as e:
        print(f"  skip (unreadable): {name} -> {e}")
        return False
    w, h = im.size
    new_h = round(h * THUMB_WIDTH / w)
    thumb = im.resize((THUMB_WIDTH, new_h), Image.LANCZOS)
    if name.lower().endswith(".png"):
        thumb.save(dst, "PNG", optimize=True)
    else:
        thumb.save(dst, "JPEG", quality=JPEG_QUALITY, optimize=True)
    print(f"  thumb: {name} ({w}x{h} -> {THUMB_WIDTH}x{new_h})")
    return True


def main():
    os.makedirs(THUMBS_DIR, exist_ok=True)
    args = sys.argv[1:]
    force = "--force" in args
    # Explicit files (any arg that isn't a flag) are always (re)generated, so a
    # replaced image's stale thumbnail gets rebuilt even though it already exists.
    explicit = [a for a in args if not a.startswith("--")]

    if explicit:
        # Accept "images/Foo.jpg", "thumbs/Foo.jpg" or a bare "Foo.jpg".
        names = []
        for a in explicit:
            base = os.path.basename(a.replace("\\", "/"))
            if base:
                names.append(base)
        made = sum(1 for n in sorted(set(names)) if render(n))
        print(f"Done. (Re)generated {made} thumbnail(s) from {len(set(names))} requested.")
        return

    made = skipped = 0
    for name in sorted(os.listdir(IMAGES_DIR)):
        src = os.path.join(IMAGES_DIR, name)
        if not os.path.isfile(src) or not name.lower().endswith(EXTS):
            continue
        if os.path.exists(os.path.join(THUMBS_DIR, name)) and not force:
            continue
        if render(name):
            made += 1
        else:
            skipped += 1

    print(f"Done. Generated {made} thumbnail(s); {skipped} skipped.")


if __name__ == "__main__":
    main()
