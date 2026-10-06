#!/usr/bin/env python3
"""Make card photos consistent: same framing, same size, neutral colour.

Card photos are taken by hand on a white surface, so they arrive with the card
at different sizes, slightly rotated, and with whatever colour cast the light
had that day. For each photo this script:

  1. finds the card's outline against the background,
  2. straightens it and crops to the card with the same thin margin every time,
  3. corrects colour and brightness so the white surface around the card comes
     out as the same neutral white in every photo.

It deliberately does NOTHING else. No sharpening, smoothing or retouching:
buyers judge a card's condition from these photos, so only the framing and the
lighting may change, never the card.

A photo it cannot read confidently is left exactly as it is and reported, so a
wrong guess never replaces a good photo. Reasons a photo is left alone:

  - the card runs off the edge of the photo (no outline to find),
  - the outline found is not card-shaped (graded slabs, logos, odd crops),
  - there is another edge outside the outline, which means the outline is
    probably the artwork INSIDE a pale-bordered card rather than the card.

A photo that is cropped but has no usable white background (too little of it
showing, or the surface is not white) keeps its original colour and is reported.

Cleaned photos are exactly OUT_W x OUT_H, which is also how an already-cleaned
photo is recognised and skipped, so running this twice changes nothing.

Usage:
    python scripts/normalise_photos.py images/A.jpg images/B.jpg   # just these
    python scripts/normalise_photos.py --all                       # every photo
    python scripts/normalise_photos.py --all --out /tmp/cleaned    # write copies,
                                                                   # leave originals
    ... --summary FILE    append a Markdown report (GitHub step summary)
"""
import os
import sys

import cv2
import numpy as np

IMAGES_DIR = "images"
EXTS = (".jpg", ".jpeg")

# A card is 63 x 88 mm. The card itself is drawn CARD_W wide; MARGIN of the
# surface is kept on every side so the rounded corners sit on background.
CARD_W, MARGIN = 812, 24
CARD_H = round(CARD_W * 88 / 63)
OUT_W, OUT_H = CARD_W + 2 * MARGIN, CARD_H + 2 * MARGIN
# The photos arrive already compressed (about quality 75-80), so saving at a
# higher quality only makes bigger files, not better ones, and every replaced
# photo stays in the repo's history for good.
JPEG_QUALITY = 80
WHITE = 246            # what the surface around the card is corrected to

MIN_AREA = 0.30                 # card must cover at least this much of the photo
RATIO_MIN, RATIO_MAX = 0.67, 0.77   # width / height of the outline (a card is 0.716)
OUTER_EDGE_MAX = 7.0            # see outer_edge_strength()
BG_CHROMA_MAX = 30              # further from grey than this is not a white surface
BG_LIGHT_MIN = 140              # darker than this (0-255) is not a white surface
GAIN_MIN, GAIN_MAX = 0.6, 2.2   # limits on the colour correction, in linear light


def srgb_to_linear(v):
    v = v / 255.0
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v):
    v = np.clip(v, 0, 1)
    return 255.0 * np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)


def find_card(img):
    """Return (rect, mask) for the card outline, or (None, reason)."""
    h, w = img.shape[:2]
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.int16)
    b = max(6, w // 80)
    # The background is whatever the outer frame of the photo looks like.
    frame = np.concatenate([
        lab[:b].reshape(-1, 3), lab[-b:].reshape(-1, 3),
        lab[:, :b].reshape(-1, 3), lab[:, -b:].reshape(-1, 3),
    ])
    bg = np.median(frame, axis=0)
    spread = np.percentile(np.abs(frame - bg).sum(axis=1), 90)
    dist = np.abs(lab - bg).sum(axis=2)
    mask = (dist > max(18, spread * 1.6)).astype(np.uint8) * 255
    # Tidy the mask on a padded canvas. Photos are framed tightly, and without
    # the padding the clean-up glues the card to the photo's edge whenever the
    # margin is narrower than the kernel, which reads as "card cut off".
    ks = max(3, w // 40)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (ks, ks))
    mask = cv2.copyMakeBorder(mask, ks, ks, ks, ks, cv2.BORDER_CONSTANT, value=0)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k)
    mask = mask[ks:-ks, ks:-ks]
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, "no card outline found"
    c = max(contours, key=cv2.contourArea)
    if cv2.contourArea(c) < MIN_AREA * w * h:
        return None, "no card outline found"
    x, y, bw, bh = cv2.boundingRect(c)
    if x <= 2 or y <= 2 or x + bw >= w - 2 or y + bh >= h - 2:
        return None, "card runs off the edge of the photo"
    (cx, cy), (rw, rh), ang = cv2.minAreaRect(c)
    if rw > rh:
        rw, rh, ang = rh, rw, ang - 90
    if not (RATIO_MIN < rw / rh < RATIO_MAX):
        return None, "outline is not card-shaped"
    return ((cx, cy), (rw, rh), ang), None


def corners(rect):
    """The outline's corners as top-left, top-right, bottom-right, bottom-left."""
    box = cv2.boxPoints(rect)
    s, d = box.sum(axis=1), np.diff(box, axis=1).ravel()
    return np.float32([box[s.argmin()], box[d.argmin()], box[s.argmax()], box[d.argmax()]])


def outer_edge_strength(img, src):
    """How strong the strongest straight edge OUTSIDE the outline is.

    A pale-bordered card on a white surface can be missed, leaving an outline
    around the artwork inside it. That outline is card-shaped too, so shape
    alone cannot tell them apart. What gives it away is a second straight edge
    just outside: the real edge of the card. On a correct outline the band
    outside holds only the surface (and at most a soft shadow, which is spread
    over many pixels and scores low here).
    """
    cw, pad, gap = 400, 64, 9
    ch = round(cw * 88 / 63)
    dst = np.float32([[pad, pad], [pad + cw, pad], [pad + cw, pad + ch], [pad, pad + ch]])
    m = cv2.getPerspectiveTransform(src, dst)
    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    view = cv2.warpPerspective(grey, m, (cw + 2 * pad, ch + 2 * pad),
                               flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    view = cv2.GaussianBlur(view, (3, 3), 0).astype(np.float32)
    gx = np.abs(cv2.Sobel(view, cv2.CV_32F, 1, 0, ksize=3)) / 4
    gy = np.abs(cv2.Sobel(view, cv2.CV_32F, 0, 1, ksize=3)) / 4
    r0, r1 = pad + int(ch * 0.15), pad + int(ch * 0.85)
    c0, c1 = pad + int(cw * 0.15), pad + int(cw * 0.85)
    left = gx[r0:r1, 3:pad - gap].mean(axis=0).max()
    right = gx[r0:r1, pad + cw + gap:-3].mean(axis=0).max()
    top = gy[3:pad - gap, c0:c1].mean(axis=1).max()
    bottom = gy[pad + ch + gap:-3, c0:c1].mean(axis=1).max()
    return float(max(left, right, top, bottom))


def background_colour(img, src):
    """Median colour of the surface around the card, or (None, reason)."""
    h, w = img.shape[:2]
    card = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(card, src.astype(np.int32), 255)
    # Stay clear of the card's edge, where its shadow falls. Photos are framed
    # tightly, so this can only be a few pixels or no surface would be left.
    grow = max(4, w // 110)
    card = cv2.dilate(card, cv2.getStructuringElement(cv2.MORPH_RECT, (2 * grow + 1,) * 2))
    pixels = img[card == 0]
    if len(pixels) < 0.006 * w * h:
        return None, "too little background showing"
    ref = np.median(pixels, axis=0)
    lab = cv2.cvtColor(np.uint8([[ref]]), cv2.COLOR_BGR2LAB)[0, 0].astype(float)
    if lab[0] < BG_LIGHT_MIN or np.hypot(lab[1] - 128, lab[2] - 128) > BG_CHROMA_MAX:
        return None, "background is not white"
    return ref, None


def correct_colour(img, ref):
    """Scale each channel, in linear light, so the surface becomes WHITE."""
    target = srgb_to_linear(np.float64(WHITE))
    out = np.empty_like(img)
    levels = np.arange(256, dtype=np.float64)
    for ch in range(3):
        gain = np.clip(target / max(srgb_to_linear(np.float64(ref[ch])), 1e-4), GAIN_MIN, GAIN_MAX)
        lut = np.clip(np.round(linear_to_srgb(srgb_to_linear(levels) * gain)), 0, 255).astype(np.uint8)
        out[:, :, ch] = cv2.LUT(img[:, :, ch], lut)
    return out


def normalise(path, out_path):
    """Clean one photo. Returns (status, note); status is cleaned/kept/skipped/already."""
    try:
        img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        img = None
    if img is None:
        return "kept", "could not be read as an image"
    h, w = img.shape[:2]
    if (w, h) == (OUT_W, OUT_H):
        return "already", ""
    if w >= h or h < 500:
        return "kept", "not a card photo (landscape or very small)"

    rect, why = find_card(img)
    if rect is None:
        return "kept", why
    src = corners(rect)
    if outer_edge_strength(img, src) > OUTER_EDGE_MAX:
        return "kept", "another edge outside the outline (pale-bordered card?)"

    ref, colour_note = background_colour(img, src)
    if ref is not None:
        img = correct_colour(img, ref)
        fill = (WHITE, WHITE, WHITE)
    else:
        b = max(6, w // 80)
        frame = np.concatenate([img[:b].reshape(-1, 3), img[-b:].reshape(-1, 3),
                                img[:, :b].reshape(-1, 3), img[:, -b:].reshape(-1, 3)])
        fill = tuple(int(v) for v in np.median(frame, axis=0))

    dst = np.float32([[MARGIN, MARGIN], [OUT_W - MARGIN, MARGIN],
                      [OUT_W - MARGIN, OUT_H - MARGIN], [MARGIN, OUT_H - MARGIN]])
    m = cv2.getPerspectiveTransform(src, dst)
    out = cv2.warpPerspective(img, m, (OUT_W, OUT_H), flags=cv2.INTER_CUBIC,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=fill)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY,
                                          cv2.IMWRITE_JPEG_OPTIMIZE, 1])
    if not ok:
        return "kept", "could not be saved"
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    buf.tofile(out_path)
    return "cleaned", ("colour left as shot: " + colour_note) if colour_note else ""


def is_card_photo(name):
    low = name.lower()
    return low.endswith(EXTS) and "logo" not in low


def main():
    # Card filenames include characters (δ, é) a Windows console cannot print.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    out_dir = summary = None
    names = []
    do_all = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--all":
            do_all = True
        elif a == "--out":
            i += 1
            out_dir = args[i]
        elif a == "--summary":
            i += 1
            summary = args[i]
        elif not a.startswith("--"):
            # Only photos directly in images/ are cards; thumbs/ and badges/ are not.
            norm = a.replace("\\", "/")
            if os.path.dirname(norm) in ("", IMAGES_DIR):
                names.append(os.path.basename(norm))
        i += 1
    if do_all:
        names = [n for n in os.listdir(IMAGES_DIR) if os.path.isfile(os.path.join(IMAGES_DIR, n))]
    names = sorted({n for n in names if is_card_photo(n)})

    counts = {"cleaned": 0, "already": 0, "kept": 0}
    kept, colour = [], []
    for name in names:
        src = os.path.join(IMAGES_DIR, name)
        if not os.path.isfile(src):
            continue
        status, note = normalise(src, os.path.join(out_dir or IMAGES_DIR, name))
        counts[status] += 1
        if status == "kept":
            kept.append((name, note))
            print(f"  left as it is: {name} -> {note}")
        elif status == "cleaned":
            if note:
                colour.append((name, note))
            print(f"  cleaned: {name}" + (f" ({note})" if note else ""))

    print(f"Done. Cleaned {counts['cleaned']}, already clean {counts['already']}, "
          f"left as they are {counts['kept']}.")
    if summary and (counts["cleaned"] or kept):
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### Card photos\n\nCleaned {counts['cleaned']} · already clean "
                    f"{counts['already']} · left as they are {counts['kept']}\n\n")
            if kept:
                f.write("**Left exactly as uploaded** (retake, or leave):\n\n")
                f.writelines(f"- `{n}`: {why}\n" for n, why in kept)
                f.write("\n")
            if colour:
                f.write("**Cropped, but colour not corrected:**\n\n")
                f.writelines(f"- `{n}`: {why}\n" for n, why in colour)
                f.write("\n")


if __name__ == "__main__":
    main()
