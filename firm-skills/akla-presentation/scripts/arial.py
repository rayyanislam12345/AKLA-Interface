"""Real Arial metrics, including a small-caps model matching PowerPoint's cap="small".

PowerPoint renders small caps by substituting uppercase glyphs for lowercase
letters at roughly 80% of the nominal point size. Measuring with plain uppercase
overestimates width; measuring with the literal string underestimates it.
"""
from PIL import ImageFont

import os
# Arial where the machine has it; otherwise Liberation Sans, whose advance
# widths match Arial's, so wrapping and overflow measure as PowerPoint will.
_PAIRS = [
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
]
REG, BLD = next(((r, b) for r, b in _PAIRS if os.path.exists(r) and os.path.exists(b)), _PAIRS[0])

SMALLCAP_RATIO = 0.80
_RES = 4000.0          # measure at high resolution, scale down; keeps it fractional
_cache = {}


def _font(pt, bold):
    key = (round(pt, 3), bold)
    f = _cache.get(key)
    if f is None:
        f = ImageFont.truetype(BLD if bold else REG, max(1, int(round(pt))))
        _cache[key] = f
    return f


def _width_units(text, bold, size):
    """Width of `text` in font units at nominal `size` (px)."""
    return _font(size, bold).getlength(text)


def text_width_pt(text, pt, bold=False, caps=False):
    """Rendered width in points."""
    if not text:
        return 0.0
    big = _RES
    if not caps:
        return _width_units(text, bold, int(big)) * pt / big
    # small caps: split into uppercase-equivalent runs at two sizes
    full, small = [], []
    for ch in text:
        if ch.islower():
            small.append(ch.upper())
        else:
            full.append(ch)
    w = 0.0
    if full:
        w += _width_units("".join(full), bold, int(big)) * pt / big
    if small:
        w += _width_units("".join(small), bold, int(big)) * pt * SMALLCAP_RATIO / big
    return w


SAFETY = 0.975   # wrap slightly early; PowerPoint's shaper differs marginally from ours


def wrap(text, width_in, pt, bold=False, caps=False):
    """Greedy wrap; returns the list of lines as PowerPoint would break them."""
    limit = width_in * 72.0 * SAFETY
    words, lines, cur = text.split(), [], ""
    for wd in words:
        cand = (cur + " " + wd) if cur else wd
        if text_width_pt(cand, pt, bold, caps) <= limit or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    return lines or [""]


def n_lines(text, width_in, pt, bold=False, caps=False):
    return len(wrap(text, width_in, pt, bold, caps))
