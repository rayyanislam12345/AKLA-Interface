#!/usr/bin/env python3
"""Render generated slides with real Arial metrics, and report any text overflow.

This parses the produced PPTX rather than the build model, so it catches genuine
layout errors: text taller than its box, text wider than its column, cards that
collide with the footer.
"""
import os, re, sys, zipfile
from PIL import Image, ImageDraw, ImageFont

PPTX = sys.argv[1]
OUT = sys.argv[2]
SCALE = float(sys.argv[3]) if len(sys.argv) > 3 else 110.0   # px per inch
EMU = 914400
NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
import xml.etree.ElementTree as ET
for k, v in NS.items():
    ET.register_namespace(k, v)

REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
BLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
_fc = {}


def font(pt, bold):
    key = (round(pt, 2), bold)
    if key not in _fc:
        _fc[key] = ImageFont.truetype(BLD if bold else REG, int(round(pt * SCALE / 72.0)))
    return _fc[key]


def px(emu):
    return emu / EMU * SCALE


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def wrap(text, fnt, max_px, draw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w) if cur else w
        if draw.textlength(t, font=fnt) <= max_px or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_smallcaps(dr, xy, text, pt, bold, fill):
    """Render lowercase as 80%-size capitals, as PowerPoint does."""
    x, y = xy
    big, small = font(pt, bold), font(pt * 0.80, bold)
    ab, _ = big.getmetrics()
    asm, _ = small.getmetrics()
    for ch in text:
        if ch.islower():
            dr.text((x, y + (ab - asm)), ch.upper(), font=small, fill=fill)
            x += small.getlength(ch.upper())
        else:
            dr.text((x, y), ch, font=big, fill=fill)
            x += big.getlength(ch)
    return x


def smallcaps_len(text, pt, bold):
    big, small = font(pt, bold), font(pt * 0.80, bold)
    return sum(small.getlength(c.upper()) if c.islower() else big.getlength(c) for c in text)


def wrap_sc(text, pt, bold, max_px):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w) if cur else w
        if smallcaps_len(t, pt, bold) <= max_px or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]


def fill_of(spPr):
    sf = spPr.find("a:solidFill/a:srgbClr", NS)
    return rgb(sf.get("val")) if sf is not None else None


def line_of(spPr):
    ln = spPr.find("a:ln", NS)
    if ln is None:
        return None
    sf = ln.find("a:solidFill/a:srgbClr", NS)
    return rgb(sf.get("val")) if sf is not None else None


problems = []


def draw_shape(dr, img, sp, slide_no, media):
    tag = sp.tag.split("}")[1]
    if tag == "pic":
        xfrm = sp.find("p:spPr/a:xfrm", NS)
        x, y = px(int(xfrm.find("a:off", NS).get("x"))), px(int(xfrm.find("a:off", NS).get("y")))
        w, h = px(int(xfrm.find("a:ext", NS).get("cx"))), px(int(xfrm.find("a:ext", NS).get("cy")))
        rid = sp.find("p:blipFill/a:blip", NS).get(f'{{{NS["r"]}}}embed')
        src = media.get(rid)
        if src and os.path.exists(src):
            im = Image.open(src).convert("RGBA").resize((max(1, int(w)), max(1, int(h))))
            img.paste(im, (int(x), int(y)), im)
        else:
            dr.rectangle([x, y, x + w, y + h], outline=(200, 200, 200))
        return
    if tag == "graphicFrame":
        draw_table(dr, sp, slide_no)
        return
    if tag != "sp":
        return

    spPr = sp.find("p:spPr", NS)
    xfrm = spPr.find("a:xfrm", NS)
    x, y = px(int(xfrm.find("a:off", NS).get("x"))), px(int(xfrm.find("a:off", NS).get("y")))
    w, h = px(int(xfrm.find("a:ext", NS).get("cx"))), px(int(xfrm.find("a:ext", NS).get("cy")))
    prst = spPr.find("a:prstGeom", NS).get("prst")
    f, l = fill_of(spPr), line_of(spPr)
    if prst == "rect" and (f or l):
        dr.rectangle([x, y, x + w, y + h], fill=f, outline=l)
    elif prst == "roundRect":
        dr.rounded_rectangle([x, y, x + w, y + h], radius=SCALE * 0.06, fill=f, outline=l)
    elif prst == "ellipse":
        dr.ellipse([x, y, x + w, y + h], fill=f, outline=l)
    elif prst == "line" and l:
        dr.line([x, y, x + w, y + h], fill=l, width=max(1, int(SCALE / 72)))

    paras = sp.findall("p:txBody/a:p", NS)
    bodyPr = sp.find("p:txBody/a:bodyPr", NS)
    anchor = bodyPr.get("anchor", "t") if bodyPr is not None else "t"
    name = sp.find("p:nvSpPr/p:cNvPr", NS).get("name")

    blocks = []
    for pa in paras:
        runs = pa.findall("a:r", NS)
        if not runs:
            continue
        text = "".join(r.find("a:t", NS).text or "" for r in runs)
        rPr = runs[0].find("a:rPr", NS)
        pt = int(rPr.get("sz", "1800")) / 100.0
        bold = rPr.get("b") == "1"
        caps = rPr.get("cap") == "small"
        col = rPr.find("a:solidFill/a:srgbClr", NS)
        color = rgb(col.get("val")) if col is not None else (0, 0, 0)
        ppr = pa.find("a:pPr", NS)
        algn = ppr.get("algn", "l") if ppr is not None else "l"
        bullet = ppr is not None and ppr.find("a:buChar", NS) is not None
        marL = int(ppr.get("marL", "0")) / EMU * SCALE if ppr is not None else 0
        lnSpc = ppr.find("a:lnSpc/a:spcPts", NS) if ppr is not None else None
        lh = (int(lnSpc.get("val")) / 100.0) if lnSpc is not None else pt * 1.21
        sb = ppr.find("a:spcBef/a:spcPts", NS) if ppr is not None else None
        before = (int(sb.get("val")) / 100.0) if sb is not None else 0
        blocks.append((text, pt, bold, color, algn, bullet, marL, lh, before, caps))

    if not blocks:
        return

    avail_w = w - (0 if w else 0)
    total = 0
    laid = []
    for (disp, pt, bold, color, algn, bullet, marL, lh, before, caps) in blocks:
        fnt = font(pt, bold)
        indent = marL if bullet else 0
        room = max(10, avail_w - indent)
        lines = wrap_sc(disp, pt, bold, room) if caps else wrap(disp, fnt, room, dr)
        laid.append((lines, pt, bold, color, algn, bullet, indent, lh, before, fnt, caps))
        total += before * SCALE / 72.0 + len(lines) * lh * SCALE / 72.0

    if total > h + 1.5:
        problems.append(f"slide {slide_no}: '{name}' text {total/SCALE:.2f}in > box {h/SCALE:.2f}in "
                        f"(overflow {(total-h)/SCALE:.2f}in) :: {blocks[0][0][:60]}")

    cy = y
    if anchor == "ctr":
        cy = y + (h - total) / 2.0
    for (lines, pt, bold, color, algn, bullet, indent, lh, before, fnt, caps) in laid:
        cy += before * SCALE / 72.0
        for i, ln in enumerate(lines):
            tw = smallcaps_len(ln, pt, bold) if caps else dr.textlength(ln, font=fnt)
            lx = x + indent
            if algn == "ctr":
                lx = x + (w - tw) / 2.0
            elif algn == "r":
                lx = x + w - tw
            if bullet and i == 0:
                dr.text((x, cy), "\u2022", font=fnt, fill=color)
            asc, desc = fnt.getmetrics()
            ty = cy + (lh * SCALE / 72.0 - (asc + desc)) / 2.0
            if caps:
                draw_smallcaps(dr, (lx, ty), ln, pt, bold, color)
            else:
                dr.text((lx, ty), ln, font=fnt, fill=color)
            cy += lh * SCALE / 72.0


def draw_table(dr, gf, slide_no):
    xf = gf.find("p:xfrm", NS)
    x0, y0 = px(int(xf.find("a:off", NS).get("x"))), px(int(xf.find("a:off", NS).get("y")))
    tbl = gf.find("a:graphic/a:graphicData/a:tbl", NS)
    cols = [px(int(g.get("w"))) for g in tbl.findall("a:tblGrid/a:gridCol", NS)]
    y = y0
    for tr in tbl.findall("a:tr", NS):
        rh = px(int(tr.get("h")))
        x = x0
        maxneed = 0
        for ci, tc in enumerate(tr.findall("a:tc", NS)):
            tcPr = tc.find("a:tcPr", NS)
            f = tcPr.find("a:solidFill/a:srgbClr", NS)
            fill = rgb(f.get("val")) if f is not None else None
            dr.rectangle([x, y, x + cols[ci], y + rh], fill=fill, outline=(215, 219, 228))
            pa = tc.find("a:txBody/a:p", NS)
            runs = pa.findall("a:r", NS) if pa is not None else []
            if runs:
                text = "".join(r.find("a:t", NS).text or "" for r in runs)
                rPr = runs[0].find("a:rPr", NS)
                pt = int(rPr.get("sz", "900")) / 100.0
                bold = rPr.get("b") == "1"
                col = rPr.find("a:solidFill/a:srgbClr", NS)
                color = rgb(col.get("val")) if col is not None else (0, 0, 0)
                lnSpc = pa.find("a:pPr/a:lnSpc/a:spcPts", NS)
                lh = (int(lnSpc.get("val")) / 100.0) if lnSpc is not None else pt * 1.21
                fnt = font(pt, bold)
                pad = px(91440)
                lines = wrap(text, fnt, cols[ci] - 2 * pad, dr)
                need = len(lines) * lh * SCALE / 72.0 + px(45720) * 2
                maxneed = max(maxneed, need)
                ty = y + (rh - len(lines) * lh * SCALE / 72.0) / 2.0
                for ln in lines:
                    asc, desc = fnt.getmetrics()
                    dr.text((x + pad, ty + (lh * SCALE / 72.0 - (asc + desc)) / 2.0), ln, font=fnt, fill=color)
                    ty += lh * SCALE / 72.0
            x += cols[ci]
        if maxneed > rh + 1.5:
            problems.append(f"slide {slide_no}: table row needs {maxneed/SCALE:.2f}in > {rh/SCALE:.2f}in")
        y += rh
    if y / SCALE > 6.95:
        problems.append(f"slide {slide_no}: table bottom at {y/SCALE:.2f}in overruns footer")


z = zipfile.ZipFile(PPTX)
os.makedirs(OUT, exist_ok=True)
tmp = os.path.join(OUT, "_media")
os.makedirs(tmp, exist_ok=True)
for n in z.namelist():
    if n.startswith("ppt/media/"):
        open(os.path.join(tmp, os.path.basename(n)), "wb").write(z.read(n))

n_slides = len([n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)])
for i in range(1, n_slides + 1):
    rels = {}
    rx = z.read(f"ppt/slides/_rels/slide{i}.xml.rels").decode()
    for m in re.finditer(r'Id="(rId\d+)"[^>]*Target="\.\./media/([^"]+)"', rx):
        rels[m.group(1)] = os.path.join(tmp, m.group(2))
    root = ET.fromstring(z.read(f"ppt/slides/slide{i}.xml"))
    img = Image.new("RGB", (int(13.3333 * SCALE), int(7.5 * SCALE)), (255, 255, 255))
    dr = ImageDraw.Draw(img)
    tree = root.find("p:cSld/p:spTree", NS)
    for sp in list(tree):
        if sp.tag.split("}")[1] in ("sp", "pic", "graphicFrame"):
            draw_shape(dr, img, sp, i, rels)
    img.save(os.path.join(OUT, f"slide{i:02d}.png"))

print(f"rendered {n_slides} slides -> {OUT}")
if problems:
    print("\n!! LAYOUT PROBLEMS:")
    for p in problems:
        print("  -", p)
else:
    print("no overflow detected")
