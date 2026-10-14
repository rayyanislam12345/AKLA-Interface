#!/usr/bin/env python3
"""
AKLA house-style PPTX builder.

Reproduces the exact visual grammar of
  "M6 - Presentation on the Legal & Land Due Diligence [AKLA][August 15, 2026].pptx"
- 13.333 x 7.5in, Arial throughout
- navy 000048 header band, gold FFC000 small-caps running header
- 002060 small-caps titles with a navy rule beneath
- EEF1FA / D7DBE4 rounded cards with navy numbered discs
- bullet columns at 10pt / 1A1A1A
- grey footer rule: akla.com.pk centred, page number right
"""
import os, re, shutil, zipfile
from xml.sax.saxutils import escape

EMU = 914400
SW, SH = 12192000, 6858000

NAVY      = "000048"
TITLENAVY = "002060"
GOLD      = "FFC000"
BODY      = "1A1A1A"
CARDFILL  = "EEF1FA"
CARDLINE  = "D7DBE4"
GREY      = "8A8D93"
WHITE     = "FFFFFF"

FONT = ('<a:latin typeface="Arial" pitchFamily="34" charset="0"/>'
        '<a:ea typeface="Arial" pitchFamily="34" charset="-122"/>'
        '<a:cs typeface="Arial" pitchFamily="34" charset="-120"/>')


def E(v):
    return int(round(v * EMU))


def esc(t):
    return escape(str(t)).replace("’", "&#8217;")


# ----------------------------------------------------------------- text metrics
# Measured against the real Arial faces, with PowerPoint's small-caps model.
import arial


def wrap_lines(text, width_in, pt, bold=False, caps=False):
    """Number of rendered lines for `text` in a box `width_in` wide."""
    return arial.n_lines(text, width_in, pt, bold, caps)


def text_h(text, width_in, pt, line_pt, bold=False, caps=False):
    return wrap_lines(text, width_in, pt, bold, caps) * line_pt / 72.0


# ----------------------------------------------------------------- shape emitters
_id = [100]


def nid():
    _id[0] += 1
    return _id[0]


def _sp(name, x, y, w, h, geom, fill, line, body=""):
    fill_xml = f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill>' if fill else '<a:noFill/>'
    if line:
        line_xml = (f'<a:ln w="12700"><a:solidFill><a:srgbClr val="{line}"/></a:solidFill>'
                    f'<a:prstDash val="solid"/></a:ln>')
    else:
        line_xml = '<a:ln/>'
    body = body or '<a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-PK"/></a:p>'
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{nid()}" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="{E(x)}" y="{E(y)}"/><a:ext cx="{E(w)}" cy="{E(h)}"/></a:xfrm>'
            f'{geom}{fill_xml}{line_xml}</p:spPr><p:txBody>{body}</p:txBody></p:sp>')


RECT = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
ELLIPSE = '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>'
ROUND = '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 2564"/></a:avLst></a:prstGeom>'
LINE = '<a:prstGeom prst="line"><a:avLst/></a:prstGeom>'

ALIGN = {"l": "l", "c": "ctr", "r": "r", "j": "just"}


def run(text, pt, color, bold=False, caps=False):
    b = ' b="1"' if bold else ''
    c = ' cap="small"' if caps else ''
    return (f'<a:r><a:rPr lang="en-US" sz="{int(pt*100)}"{b}{c} dirty="0">'
            f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>{FONT}</a:rPr>'
            f'<a:t>{esc(text)}</a:t></a:r>')


def textbox(name, x, y, w, h, text, pt, color, bold=False, caps=False,
            align="l", anchor="t", line_pt=None, space_before=0):
    ln = f'<a:lnSpc><a:spcPts val="{int(line_pt*100)}"/></a:lnSpc>' if line_pt else ''
    sb = f'<a:spcBef><a:spcPts val="{int(space_before*100)}"/></a:spcBef>' if space_before else ''
    ppr = f'<a:pPr marL="0" indent="0" algn="{ALIGN[align]}">{ln}{sb}<a:buNone/></a:pPr>'
    body = (f'<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="{anchor}"/>'
            f'<a:lstStyle/><a:p>{ppr}{run(text, pt, color, bold, caps)}</a:p>')
    return _sp(name, x, y, w, h, RECT, None, None, body)


def bullets(name, x, y, w, h, items, pt=10, color=BODY, line_pt=12, gap=2.5):
    paras = []
    for i, it in enumerate(items):
        sb = f'<a:spcBef><a:spcPts val="{int(gap*100)}"/></a:spcBef>' if i else ''
        ppr = (f'<a:pPr marL="152400" indent="-152400" algn="l">'
               f'<a:lnSpc><a:spcPts val="{int(line_pt*100)}"/></a:lnSpc>{sb}'
               f'<a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="&#8226;"/></a:pPr>')
        paras.append(f'<a:p>{ppr}{run(it, pt, color)}</a:p>')
    body = ('<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"/>'
            '<a:lstStyle/>' + "".join(paras))
    return _sp(name, x, y, w, h, RECT, None, None, body)


def disc(x, y, label, d=0.34, pt=10):
    """Navy numbered disc with centred white label."""
    out = [_sp("Disc", x, y, d, d, ELLIPSE, NAVY, NAVY)]
    size = pt if len(str(label)) <= 3 else 8
    body = ('<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="ctr"/>'
            '<a:lstStyle/><a:p><a:pPr marL="0" indent="0" algn="ctr"><a:buNone/></a:pPr>'
            + run(label, size, WHITE, bold=True) + '</a:p>')
    out.append(_sp("DiscText", x, y, d, d, RECT, None, None, body))
    return out


BULLET_INDENT = 152400 / EMU      # marL used by bullets(), in inches


def body_h(text, tw, body_pt, body_line, gap=3.0):
    """Height of a card body, whether a paragraph or a list of bullets."""
    if isinstance(text, (list, tuple)):
        lines = sum(wrap_lines(t, tw - BULLET_INDENT, body_pt) for t in text)
        return lines * body_line / 72.0 + gap * (len(text) - 1) / 72.0
    return text_h(text, tw, body_pt, body_line)


def card(x, y, w, h, num, heading, text, head_pt=11, body_pt=10, body_line=12, gap=3.0):
    """EEF1FA rounded card: navy disc, navy small-caps heading, then body.

    `text` may be a paragraph (justified) or a list of strings (bulleted).
    """
    out = [_sp("Card", x, y, w, h, ROUND, CARDFILL, CARDLINE)]
    out += disc(x + 0.18, y + 0.16, num)
    tx = x + 0.62
    tw = w - 0.62 - 0.18
    head_h = text_h(heading, tw, head_pt, head_pt + 2.0, bold=True, caps=True) + 0.04
    out.append(textbox("CardHead", tx, y + 0.14, tw, head_h, heading, head_pt,
                       TITLENAVY, bold=True, caps=True, line_pt=head_pt + 2.0))
    by = y + 0.14 + head_h + 0.08
    bh = h - (by - y) - 0.12
    if isinstance(text, (list, tuple)):
        out.append(bullets("CardBody", tx, by, tw, bh, list(text), body_pt,
                           line_pt=body_line, gap=gap))
    else:
        out.append(textbox("CardBody", tx, by, tw, bh, text, body_pt, BODY,
                           align="j", line_pt=body_line))
    return out


def chip(x, y, w, h, num, label, pt=11):
    out = [_sp("Chip", x, y, w, h, ROUND, CARDFILL, CARDLINE)]
    out += disc(x + 0.13, y + (h - 0.34) / 2.0, num)
    tx = x + 0.70
    tw = w - 0.70 - 0.14
    out.append(textbox("ChipText", tx, y, tw, h, label, pt, TITLENAVY,
                       bold=True, caps=True, anchor="ctr", line_pt=pt + 2.0))
    return out


def banner_h(text, w, body_pt=10, body_line=12):
    """Natural height of a banner holding `text` at width `w`."""
    return 0.09 + 0.26 + 0.10 + text_h(text, w - 0.40, body_pt, body_line) + 0.14


def banner(x, y, w, h, title, text, title_pt=12, body_pt=10):
    out = [_sp("Banner", x, y, w, h, ROUND, CARDFILL, CARDLINE)]
    out.append(textbox("BannerHead", x + 0.20, y + 0.09, w - 0.40, 0.26, title,
                       title_pt, TITLENAVY, bold=True, caps=True))
    out.append(textbox("BannerBody", x + 0.20, y + 0.36, w - 0.40, h - 0.46, text,
                       body_pt, BODY, align="j", line_pt=12))
    return out


# ----------------------------------------------------------------- table
def table(x, y, col_w, headers, rows, head_pt=9.5, body_pt=9,
          head_h=0.34, row_line=11.0, min_row=0.30, fill_to=None):
    """Navy header row; body rows alternate white / EEF1FA."""
    heights = [head_h]
    for r in rows:
        need = min_row
        for ci, cell in enumerate(r):
            lines = wrap_lines(cell, col_w[ci] - 0.20, body_pt, bold=(ci == 0))
            need = max(need, lines * row_line / 72.0 + 0.16)
        heights.append(need)

    if fill_to:
        spare = fill_to - y - sum(heights)
        if spare > 0:
            share = spare / len(rows)
            heights = [heights[0]] + [h + share for h in heights[1:]]

    grid = "".join(f'<a:gridCol w="{E(c)}"/>' for c in col_w)

    def cell(text, pt, color, bold, fill, align="l"):
        ppr = (f'<a:pPr marL="0" indent="0" algn="{ALIGN[align]}">'
               f'<a:lnSpc><a:spcPts val="{int(row_line*100)}"/></a:lnSpc><a:buNone/></a:pPr>')
        b = ' b="1"' if bold else ''
        r = (f'<a:r><a:rPr lang="en-US" sz="{int(pt*100)}"{b} dirty="0">'
             f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>{FONT}</a:rPr>'
             f'<a:t>{esc(text)}</a:t></a:r>')
        ln = ('<a:lnL w="12700"><a:solidFill><a:srgbClr val="{c}"/></a:solidFill></a:lnL>'
              '<a:lnR w="12700"><a:solidFill><a:srgbClr val="{c}"/></a:solidFill></a:lnR>'
              '<a:lnT w="12700"><a:solidFill><a:srgbClr val="{c}"/></a:solidFill></a:lnT>'
              '<a:lnB w="12700"><a:solidFill><a:srgbClr val="{c}"/></a:solidFill></a:lnB>').format(c=CARDLINE)
        return (f'<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>{ppr}{r}</a:p></a:txBody>'
                f'<a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">{ln}'
                f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill></a:tcPr></a:tc>')

    trs = [f'<a:tr h="{E(head_h)}">' +
           "".join(cell(h, head_pt, WHITE, True, NAVY) for h in headers) + '</a:tr>']
    for i, r in enumerate(rows):
        fill = WHITE if i % 2 == 0 else CARDFILL
        trs.append(f'<a:tr h="{E(heights[i+1])}">' +
                   "".join(cell(c, body_pt, BODY, ci == 0, fill) for ci, c in enumerate(r)) +
                   '</a:tr>')

    tbl = ('<a:tbl><a:tblPr firstRow="1" bandRow="0"><a:tableStyleId>'
           '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>'
           f'<a:tblGrid>{grid}</a:tblGrid>' + "".join(trs) + '</a:tbl>')

    total_w = sum(col_w)
    total_h = sum(heights)
    return (f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{nid()}" name="Table"/>'
            f'<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/>'
            f'</p:nvGraphicFramePr><p:xfrm><a:off x="{E(x)}" y="{E(y)}"/>'
            f'<a:ext cx="{E(total_w)}" cy="{E(total_h)}"/></p:xfrm>'
            f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
            f'{tbl}</a:graphicData></a:graphic></p:graphicFrame>'), total_h


def picture(name, rid, x, y, w, h):
    return (f'<p:pic><p:nvPicPr><p:cNvPr id="{nid()}" name="{name}"/>'
            f'<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
            f'<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
            f'<p:spPr><a:xfrm><a:off x="{E(x)}" y="{E(y)}"/><a:ext cx="{E(w)}" cy="{E(h)}"/></a:xfrm>'
            f'{RECT}</p:spPr></p:pic>')


# ----------------------------------------------------------------- slide chrome
MARGIN_L = 0.40
CONTENT_W = 12.53
CONTENT_BOTTOM = 6.78


def chrome(header, page):
    out = [_sp("HeaderBar", 0, 0, 13.3333, 0.375, RECT, NAVY, NAVY)]
    out.append(textbox("HeaderText", 0.30, 0, 12.7333, 0.375, header, 12, GOLD,
                       bold=True, caps=True, anchor="ctr"))
    out.append(picture("FooterMark", "rId3", 0.05, 6.967, 0.42, 0.47))
    out.append(textbox("FooterUrl", 0, 7.05, 13.3333, 0.30, "https://akla.com.pk/",
                       10, GREY, align="c"))
    out.append(textbox("PageNo", 12.63, 7.05, 0.50, 0.30, str(page), 10, GREY, align="r"))
    return out


def title_block(title, pt=24):
    """Returns (shapes, y_after_rule)."""
    h = text_h(title, CONTENT_W, pt, pt + 4.0, bold=True, caps=True) + 0.06
    out = [textbox("SlideTitle", MARGIN_L, 0.52, CONTENT_W, h, title, pt,
                   TITLENAVY, bold=True, caps=True, line_pt=pt + 4.0)]
    rule_y = 0.52 + h + 0.07
    out.append(_sp("Rule", MARGIN_L, rule_y, CONTENT_W, 0, LINE, None, NAVY))
    return out, rule_y + 0.13


def label(text, y, pt=13):
    return textbox("SectionLabel", MARGIN_L, y, CONTENT_W, 0.28, text, pt,
                   TITLENAVY, bold=True, caps=True), y + 0.30


# ----------------------------------------------------------------- card grid
def card_grid(items, y_top, y_bottom, cols=2, gap_x=0.23, gap_y=0.14,
              head_pt=11, body_pt=10, body_line=12, fill=True, max_grow=0.42):
    """items = [(num, heading, body), ...] laid out left-to-right, top-to-bottom."""
    w = (CONTENT_W - gap_x * (cols - 1)) / cols
    tw = w - 0.62 - 0.18
    rows = [items[i:i + cols] for i in range(0, len(items), cols)]

    def measure(bp, bl, hp):
        hs = []
        for row in rows:
            hmax = 0
            for _, head, body in row:
                hh = text_h(head, tw, hp, hp + 2.0, bold=True, caps=True) + 0.04
                bh = body_h(body, tw, bp, bl)
                hmax = max(hmax, 0.14 + hh + 0.08 + bh + 0.14)
            hs.append(hmax)
        return hs

    bp, bl, hp = body_pt, body_line, head_pt
    heights = measure(bp, bl, hp)
    avail = y_bottom - y_top
    for _ in range(14):
        if sum(heights) + gap_y * (len(rows) - 1) <= avail:
            break
        bp -= 0.25
        bl -= 0.30
        if bp < 8.0:
            bp, bl = 8.0, 9.6
            hp = max(9.5, hp - 0.25)
        heights = measure(bp, bl, hp)

    if fill:
        spare = avail - (sum(heights) + gap_y * (len(rows) - 1))
        if spare > 0:
            # pad each card, but not so far that it becomes mostly empty;
            # what is left over widens the gaps instead
            grow = min(spare / len(rows), max_grow)
            heights = [h + grow for h in heights]
            spare -= grow * len(rows)
            if spare > 0 and len(rows) > 1:
                gap_y += min(spare / (len(rows) - 1), 0.28)

    out = []
    y = y_top
    for ri, row in enumerate(rows):
        h = heights[ri]
        for ci, (num, head, body) in enumerate(row):
            out += card(MARGIN_L + ci * (w + gap_x), y, w, h, num, head, body,
                        head_pt=hp, body_pt=bp, body_line=bl)
        y += h + gap_y
    return out


def chip_grid(items, y_top, y_bottom, cols=2, gap_x=0.23, gap_y=0.10, pt=11, fill=True):
    w = (CONTENT_W - gap_x * (cols - 1)) / cols
    rows = [items[i:i + cols] for i in range(0, len(items), cols)]
    tw = w - 0.70 - 0.14
    hs = []
    for row in rows:
        hs.append(max(max(1, wrap_lines(lab, tw, pt, True, True)) * (pt + 2.0) / 72.0 + 0.24
                      for _, lab in row))
    avail = y_bottom - y_top
    while sum(hs) + gap_y * (len(rows) - 1) > avail and pt > 8.5:
        pt -= 0.25
        tw = w - 0.70 - 0.14
        hs = [max(max(1, wrap_lines(lab, tw, pt, True, True)) * (pt + 2.0) / 72.0 + 0.24
                  for _, lab in row) for row in rows]
    if fill:
        spare = avail - (sum(hs) + gap_y * (len(rows) - 1))
        if spare > 0:
            # grow each chip a little, then spend what is left on the gaps
            grow = min(spare / len(rows), 0.26)
            hs = [h + grow for h in hs]
            spare -= grow * len(rows)
            if spare > 0 and len(rows) > 1:
                gap_y += min(spare / (len(rows) - 1), 0.34)

    out, y = [], y_top
    for ri, row in enumerate(rows):
        for ci, (num, lab) in enumerate(row):
            out += chip(MARGIN_L + ci * (w + gap_x), y, w, hs[ri], num, lab, pt)
        y += hs[ri] + gap_y
    return out


def bullet_columns(left, right, y, pt=10, line_pt=12, gap=2.5):
    gap_x = 0.30
    w = (CONTENT_W - gap_x) / 2.0
    hl = sum(wrap_lines(i, w, pt) for i in left) * line_pt / 72.0 + gap / 72.0 * len(left)
    hr = sum(wrap_lines(i, w, pt) for i in right) * line_pt / 72.0 + gap / 72.0 * len(right)
    h = max(hl, hr)
    out = [bullets("Bullets L", MARGIN_L, y, w, h, left, pt, line_pt=line_pt, gap=gap),
           bullets("Bullets R", MARGIN_L + w + gap_x, y, w, h, right, pt, line_pt=line_pt, gap=gap)]
    return out, y + h + 0.16


# ----------------------------------------------------------------- package
SLIDE_OPEN = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
              '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
              'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
              'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
              '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
              '</p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
              '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>')
SLIDE_CLOSE = ('</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>')


def build(slides, base_dir, out_path, extra_media=None, title=None, author="Ali Khan Law Associates"):
    work = out_path + ".work"
    if os.path.exists(work):
        shutil.rmtree(work)
    shutil.copytree(base_dir, work)

    for d in ("ppt/slides", "ppt/notesSlides", "ppt/changesInfos", "ppt/webextensions"):
        p = os.path.join(work, d)
        if os.path.exists(p):
            shutil.rmtree(p)
    for f in ("ppt/revisionInfo.xml",):
        p = os.path.join(work, f)
        if os.path.exists(p):
            os.remove(p)
    os.makedirs(os.path.join(work, "ppt/slides/_rels"))

    for src, dst in (extra_media or {}).items():
        shutil.copy(src, os.path.join(work, "ppt/media", dst))

    for i, (xml, rels) in enumerate(slides, 1):
        with open(os.path.join(work, f"ppt/slides/slide{i}.xml"), "w", encoding="utf-8") as fh:
            fh.write(xml)
        rl = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
              '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
              'relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>']
        for rid, target in rels.items():
            rl.append(f'<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/'
                      f'officeDocument/2006/relationships/image" Target="../media/{target}"/>')
        rl.append("</Relationships>")
        with open(os.path.join(work, f"ppt/slides/_rels/slide{i}.xml.rels"), "w", encoding="utf-8") as fh:
            fh.write("".join(rl))

    n = len(slides)
    # presentation rels
    pr = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
          'relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>']
    for i in range(1, n + 1):
        pr.append(f'<Relationship Id="rId{i+1}" Type="http://schemas.openxmlformats.org/'
                  f'officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>')
    base = n + 2
    for off, (typ, tgt) in enumerate([
            ("notesMaster", "notesMasters/notesMaster1.xml"),
            ("presProps", "presProps.xml"),
            ("viewProps", "viewProps.xml"),
            ("theme", "theme/theme1.xml"),
            ("tableStyles", "tableStyles.xml")]):
        pr.append(f'<Relationship Id="rId{base+off}" Type="http://schemas.openxmlformats.org/'
                  f'officeDocument/2006/relationships/{typ}" Target="{tgt}"/>')
    pr.append("</Relationships>")
    with open(os.path.join(work, "ppt/_rels/presentation.xml.rels"), "w", encoding="utf-8") as fh:
        fh.write("".join(pr))

    # presentation.xml
    with open(os.path.join(work, "ppt/presentation.xml"), encoding="utf-8") as fh:
        px = fh.read()
    sld_lst = "".join(f'<p:sldId id="{256+i}" r:id="rId{i+2}"/>' for i in range(n))
    px = re.sub(r"<p:sldIdLst>.*?</p:sldIdLst>", f"<p:sldIdLst>{sld_lst}</p:sldIdLst>", px, flags=re.S)
    px = re.sub(r'<p:notesMasterIdLst>.*?</p:notesMasterIdLst>',
                f'<p:notesMasterIdLst><p:notesMasterId r:id="rId{n+2}"/></p:notesMasterIdLst>', px, flags=re.S)
    with open(os.path.join(work, "ppt/presentation.xml"), "w", encoding="utf-8") as fh:
        fh.write(px)

    # content types
    ct = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="png" ContentType="image/png"/>'
          '<Default Extension="jpeg" ContentType="image/jpeg"/>'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-'
          'officedocument.presentationml.presentation.main+xml"/>'
          '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.'
          'openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
          '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.'
          'openxmlformats-officedocument.presentationml.slideLayout+xml"/>']
    for i in range(1, n + 1):
        ct.append(f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.'
                  f'openxmlformats-officedocument.presentationml.slide+xml"/>')
    ct += ['<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.'
           'openxmlformats-officedocument.presentationml.notesMaster+xml"/>',
           '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-'
           'officedocument.presentationml.presProps+xml"/>',
           '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-'
           'officedocument.presentationml.viewProps+xml"/>',
           '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-'
           'officedocument.theme+xml"/>',
           '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-'
           'officedocument.theme+xml"/>',
           '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-'
           'officedocument.presentationml.tableStyles+xml"/>',
           '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-'
           'package.core-properties+xml"/>',
           '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-'
           'officedocument.extended-properties+xml"/>',
           '</Types>']
    with open(os.path.join(work, "[Content_Types].xml"), "w", encoding="utf-8") as fh:
        fh.write("".join(ct))

    # docProps
    with open(os.path.join(work, "docProps/core.xml"), "w", encoding="utf-8") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
                 '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/'
                 'metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" '
                 'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
                 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
                 f'<dc:title>{esc(title or "")}</dc:title><dc:creator>{esc(author)}</dc:creator>'
                 f'<cp:lastModifiedBy>{esc(author)}</cp:lastModifiedBy>'
                 '<cp:revision>1</cp:revision></cp:coreProperties>')
    ap = os.path.join(work, "docProps/app.xml")
    if os.path.exists(ap):
        os.remove(ap)
    ct_txt = open(os.path.join(work, "[Content_Types].xml"), encoding="utf-8").read()
    ct_txt = ct_txt.replace('<Override PartName="/docProps/app.xml" ContentType="application/vnd.'
                            'openxmlformats-officedocument.extended-properties+xml"/>', '')
    open(os.path.join(work, "[Content_Types].xml"), "w", encoding="utf-8").write(ct_txt)
    # drop relationships to parts this build removes (app props, web extensions)
    rels_p = os.path.join(work, "_rels/.rels")
    rx = open(rels_p, encoding="utf-8").read()
    rx = re.sub(r'<Relationship[^>]*Target="(?:docProps/app\.xml|ppt/webextensions/[^"]+)"\s*/>', '', rx)
    open(rels_p, "w", encoding="utf-8").write(rx)

    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(work, "[Content_Types].xml"), "[Content_Types].xml")
        for root, _, files in os.walk(work):
            for f in sorted(files):
                full = os.path.join(root, f)
                arc = os.path.relpath(full, work)
                if arc == "[Content_Types].xml":
                    continue
                z.write(full, arc)
    shutil.rmtree(work)
    return out_path
