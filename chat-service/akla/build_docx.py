#!/usr/bin/env python3
"""Render a document into a Word file in AKLA house format.

Copied from the firm's legal-summary skill (scripts/build_docx.py), which is
where the house format was measured and verified. Changes here: comments,
stdin input, and the logo sitting beside this file. Every document the AI
Workspace generates is rendered through this, so the house format is applied
by construction rather than asked of the model.

Comments: "[[AKLA Comment: text]]" anywhere in a line becomes a native Word
comment by "AKLA Comments" on that paragraph, and is removed from the text.
On a line of its own it attaches to the paragraph before it.

Originally: render a plain-English legal summary into a Word document in AKLA house format.

The output matches the firm's proposal/report family: Arial throughout, navy
heading bars with gold Small Caps text, a real 1. / 1.1. / 1.1.1. / (a) legal
outline, the four-line running header with the AK emblem, and a centered
"Page X of Y" footer.

Usage:
    python3 build_docx.py NOTES.md -o "Notes On X [AKLA][September 04, 2026].docx" \
        --doc-title "Notes On The Concession Agreement" \
        --doc-status "First Circulation Version" \
        --doc-date "September 04, 2026"

Input is a small Markdown subset (see the skill's SKILL.md):

    # Title                 -> navy banner, gold bold Small Caps, centered
    ## Major topic          -> navy bar heading, numbered 1.,  gold bold Small Caps
    ### Sub-topic           -> numbered 1.1.,  bold underlined Small Caps
    #### Divider            -> centered bold Small Caps, ruled above and below
    plain paragraph         -> numbered 1.1.1., Arial 11pt justified
    - short item            -> numbered (a), Arial 11pt justified
    > quoted clause text    -> italic, indented both sides, unnumbered
    ::: boxed figure        -> shaded centered box (fees, caps, key numbers)
    | a | b |               -> table, navy header row with gold Small Caps text
    **bold**  *italic*      -> inline runs
"""
import argparse
import os
import re
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Inches, RGBColor, Emu

BODY_FONT = "Arial"
BODY_PT = 11
SMALL_PT = 8

NAVY = "0E2841"    # heading bars, table header rows, banner
GOLD = "FFC000"    # text on navy
RED = "C00000"     # the confidentiality line in the running header
SHADE = "F2F2F2"   # boxed-figure fill

ABSTRACT_ID = 7100
NUM_ID = 7101

TEXT_WIDTH = Inches(6.5)   # letter page, 1" margins

# Each of these element sequences is schema-mandated: append a child out of
# order and Word declares the file corrupt on open.
PPR_ORDER = [
    "w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr",
    "w:widowControl", "w:numPr", "w:suppressLineNumbers", "w:pBdr", "w:shd",
    "w:tabs", "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap",
    "w:overflowPunct", "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN",
    "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind",
    "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc",
    "w:textDirection", "w:textAlignment", "w:textboxTightWrap", "w:outlineLvl",
    "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange",
]

TBLPR_ORDER = [
    "w:tblStyle", "w:tblpPr", "w:tblOverlap", "w:bidiVisual",
    "w:tblStyleRowBandSize", "w:tblStyleColBandSize", "w:tblW", "w:jc",
    "w:tblCellSpacing", "w:tblInd", "w:tblBorders", "w:shd", "w:tblLayout",
    "w:tblCellMar", "w:tblLook", "w:tblCaption", "w:tblDescription",
]

TCPR_ORDER = [
    "w:cnfStyle", "w:tcW", "w:gridSpan", "w:hMerge", "w:vMerge",
    "w:tcBorders", "w:shd", "w:noWrap", "w:tcMar", "w:textDirection",
    "w:tcFitText", "w:vAlign", "w:hideMark",
]


# --------------------------------------------------------------------------
# low-level Word plumbing
# --------------------------------------------------------------------------

def _el(tag, **attrs):
    e = OxmlElement(tag)
    for k, v in attrs.items():
        e.set(qn(k), str(v))
    return e


def _insert(parent, element, sequence):
    """Insert a child at the position the schema requires."""
    order = [qn(t) for t in sequence]
    idx = order.index(element.tag)
    for child in parent:
        if child.tag in order and order.index(child.tag) > idx:
            child.addprevious(element)
            return
    parent.append(element)


def _ppr_insert(ppr, element):
    _insert(ppr, element, PPR_ORDER)


def shade_paragraph(paragraph, fill):
    ppr = paragraph._p.get_or_add_pPr()
    _ppr_insert(ppr, _el("w:shd", **{
        "w:val": "clear", "w:color": "auto", "w:fill": fill}))


def set_indent(paragraph, left=None, hanging=None, first_line=None):
    ppr = paragraph._p.get_or_add_pPr()
    attrs = {}
    if left is not None:
        attrs["w:left"] = left
    if hanging is not None:
        attrs["w:hanging"] = hanging
    if first_line is not None:
        attrs["w:firstLine"] = first_line
    _ppr_insert(ppr, _el("w:ind", **attrs))


def set_mark_format(paragraph, color=None, bold=False, size_pt=None,
                    small_caps=False):
    """Format the paragraph mark, which is what the list number inherits."""
    ppr = paragraph._p.get_or_add_pPr()
    rpr = ppr.find(qn("w:rPr"))
    if rpr is None:
        rpr = OxmlElement("w:rPr")
        _ppr_insert(ppr, rpr)
    rfonts = _el("w:rFonts")
    for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rfonts.set(qn(attr), BODY_FONT)
    rpr.append(rfonts)
    if bold:
        rpr.append(_el("w:b"))
    if small_caps:
        rpr.append(_el("w:smallCaps"))
    if color:
        rpr.append(_el("w:color", **{"w:val": color}))
    if size_pt:
        rpr.append(_el("w:sz", **{"w:val": int(size_pt * 2)}))


def add_multilevel_numbering(doc):
    """Define a real 1. / 1.1. / 1.1.1. / (a) list so Word renumbers on edit."""
    numbering = doc.part.numbering_part.element

    abstract = _el("w:abstractNum", **{"w:abstractNumId": ABSTRACT_ID})
    abstract.append(_el("w:multiLevelType", **{"w:val": "hybridMultilevel"}))

    # (indent, hanging) per level; the heading level sits flush so its navy
    # bar spans the full text width.
    layout = [(0, 0), (720, 720), (1440, 720), (2160, 720)]

    for lvl, (left, hanging) in enumerate(layout):
        el = _el("w:lvl", **{"w:ilvl": lvl})
        el.append(_el("w:start", **{"w:val": 1}))
        if lvl == 3:
            el.append(_el("w:numFmt", **{"w:val": "lowerLetter"}))
            text = "(%4)"
        else:
            el.append(_el("w:numFmt", **{"w:val": "decimal"}))
            text = ".".join(f"%{i + 1}" for i in range(lvl + 1)) + "."
        el.append(_el("w:lvlText", **{"w:val": text}))
        el.append(_el("w:lvlJc", **{"w:val": "left"}))

        ppr = OxmlElement("w:pPr")
        ppr.append(_el("w:ind", **{"w:left": left, "w:hanging": hanging}))
        el.append(ppr)
        abstract.append(el)

    numbering.insert(0, abstract)

    num = _el("w:num", **{"w:numId": NUM_ID})
    num.append(_el("w:abstractNumId", **{"w:val": ABSTRACT_ID}))
    numbering.append(num)


def set_number(paragraph, level):
    ppr = paragraph._p.get_or_add_pPr()
    numpr = OxmlElement("w:numPr")
    numpr.append(_el("w:ilvl", **{"w:val": level}))
    numpr.append(_el("w:numId", **{"w:val": NUM_ID}))
    _ppr_insert(ppr, numpr)


def add_field(paragraph, instruction, size_pt=SMALL_PT):
    """Insert a Word field code (PAGE, NUMPAGES) that updates on open."""
    run = paragraph.add_run()
    run.font.name = BODY_FONT
    run.font.size = Pt(size_pt)
    begin = _el("w:fldChar", **{"w:fldCharType": "begin"})
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = f" {instruction} "
    end = _el("w:fldChar", **{"w:fldCharType": "end"})
    run._r.append(begin)
    run._r.append(instr)
    run._r.append(end)


def rule(paragraph, edges=("bottom",), color="000000", size=6):
    ppr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    for edge in ("top", "left", "bottom", "right"):
        if edge in edges:
            borders.append(_el(f"w:{edge}", **{
                "w:val": "single", "w:sz": size, "w:space": 4, "w:color": color}))
    _ppr_insert(ppr, borders)


def cell_fill(cell, fill):
    tcpr = cell._tc.get_or_add_tcPr()
    _insert(tcpr, _el("w:shd", **{
        "w:val": "clear", "w:color": "auto", "w:fill": fill}), TCPR_ORDER)


def cell_margins(table, top=144, bottom=144, left=108, right=108):
    tblpr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for edge, val in (("top", top), ("left", left),
                      ("bottom", bottom), ("right", right)):
        mar.append(_el(f"w:{edge}", **{"w:w": val, "w:type": "dxa"}))
    _insert(tblpr, mar, TBLPR_ORDER)


def no_borders(table):
    tblpr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        borders.append(_el(f"w:{edge}", **{"w:val": "none", "w:sz": 0}))
    _insert(tblpr, borders, TBLPR_ORDER)


# --------------------------------------------------------------------------
# document setup
# --------------------------------------------------------------------------

def build_styles(doc, heading_pt):
    normal = doc.styles["Normal"]
    normal.font.name = BODY_FONT
    normal.font.size = Pt(BODY_PT)
    normal.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    normal.paragraph_format.space_after = Pt(8)
    # East-Asian font mapping, so Arial actually sticks in Word
    rpr = normal.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rfonts.set(qn(attr), BODY_FONT)

    # Heading 1 = navy bar, gold text. Heading 2 = black, bold, underlined.
    for name, size, color, underline in (
        ("Heading 1", heading_pt, GOLD, False),
        ("Heading 2", BODY_PT, "000000", True),
    ):
        st = doc.styles[name]
        st.font.name = BODY_FONT
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.underline = underline
        st.font.color.rgb = RGBColor.from_string(color)
        st.font.small_caps = True
        st.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
        st.paragraph_format.space_before = Pt(12)
        st.paragraph_format.space_after = Pt(6)
        st.paragraph_format.keep_with_next = True
        # The default template's heading styles name theme fonts, and in Word
        # a theme font outranks the Arial set beside it.
        fonts = st.element.get_or_add_rPr().find(qn("w:rFonts"))
        if fonts is not None:
            for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
                fonts.attrib.pop(qn(attr), None)
            for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
                fonts.set(qn(attr), BODY_FONT)


def build_header(section, title, status, notice, date, logo):
    """The four-line reference strip on the left, the AK emblem on the right."""
    lines = [
        (line, True, "000000") for line in (title or "").split("|") if line.strip()
    ]
    if status:
        lines.append((status, False, "000000"))
    if notice:
        lines.append((notice, False, RED))
    if date:
        lines.append((date, False, "000000"))
    if not lines and not logo:
        return

    original = section.header.paragraphs[0]
    table = section.header.add_table(rows=1, cols=2, width=TEXT_WIDTH)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    no_borders(table)
    cell_margins(table, top=0, bottom=0, left=0, right=0)

    left, right = table.rows[0].cells
    left.width = Inches(5.4)
    right.width = Inches(1.1)

    first = True
    for text, bold, color in lines:
        p = left.paragraphs[0] if first else left.add_paragraph()
        first = False
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.space_before = Pt(0)
        run = p.add_run(text.strip())
        run.font.name = BODY_FONT
        run.font.size = Pt(SMALL_PT)
        run.font.bold = bold
        run.font.small_caps = True
        run.font.color.rgb = RGBColor.from_string(color)

    rp = right.paragraphs[0]
    rp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    rp.paragraph_format.space_after = Pt(0)
    if logo and os.path.exists(logo):
        rp.add_run().add_picture(logo, height=Inches(0.55))
    elif logo:
        print(f"warning: logo not found at {logo}", file=sys.stderr)

    trailing = section.header.add_paragraph()
    trailing.paragraph_format.space_after = Pt(0)
    for run in trailing.runs:
        run.font.size = Pt(1)
    original._element.getparent().remove(original._element)


def build_page(doc, args):
    section = doc.sections[0]
    section.different_first_page_header_footer = False
    for attr in ("top_margin", "bottom_margin", "left_margin", "right_margin"):
        setattr(section, attr, Inches(1))

    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER

    def small(text):
        r = footer.add_run(text)
        r.font.name = BODY_FONT
        r.font.size = Pt(SMALL_PT)

    small("Page ")
    add_field(footer, "PAGE")
    small(" of ")
    add_field(footer, "NUMPAGES")

    build_header(section, args.doc_title, args.doc_status, args.doc_notice,
                 args.doc_date, args.logo)


# --------------------------------------------------------------------------
# markdown -> paragraphs
# --------------------------------------------------------------------------

INLINE = re.compile(r"(\*\*.+?\*\*|\*.+?\*|_.+?_)")

# The closing "]]" is the last pair in a run of brackets, so a comment that
# ends on a placeholder - "... PKR [●]" - keeps its own bracket.
COMMENT = re.compile(r"\[\[\s*AKLA(?:\s+Comments?)?\s*:\s*(.+?)\s*\]\](?!\])", re.IGNORECASE)
FOOTNOTE_DEF = re.compile(r"^\[\^([^\]]+)\]:\s*(.*)$")
FOOTNOTE_REF = re.compile(r"\[\^([^\]]+)\](?!:)")
COMMENT_AUTHOR = "AKLA Comments"


def plain_note(text):
    text = re.sub(r"^\*\*\s*AKLA\s+Comments?\s*\d*\s*[.:]?\s*\*\*\s*", "", text.strip(), flags=re.IGNORECASE)
    return re.sub(r"\*\*(.+?)\*\*|\*(.+?)\*", lambda m: m.group(1) or m.group(2), text).strip()


def fold_footnotes(markdown):
    """Markdown footnotes become comments where they are cited.

    Models write the Firm's remarks as footnotes; in a Word document they
    belong in the margin as comments, not in the text or at the end. A
    trailing "AKLA Comments" heading left with nothing under it is dropped.
    """
    lines = markdown.replace("\r\n", "\n").split("\n")
    notes, kept = {}, []
    i = 0
    while i < len(lines):
        m = FOOTNOTE_DEF.match(lines[i].strip())
        if not m:
            kept.append(lines[i])
            i += 1
            continue
        body = [m.group(2)]
        i += 1
        # indented continuation lines belong to the same note
        while i < len(lines) and lines[i].startswith(("    ", "\t")) and lines[i].strip():
            body.append(lines[i].strip())
            i += 1
        notes[m.group(1)] = plain_note(" ".join(body))
    if not notes:
        return markdown
    text = FOOTNOTE_REF.sub(lambda m: f"[[AKLA Comment: {notes[m.group(1)]}]]" if m.group(1) in notes else "", "\n".join(kept))
    # an "AKLA Comments" heading with nothing left beneath it
    return re.sub(r"(?im)^#{1,4}\s*AKLA\s+Comments?\s*$\s*(?=^#|\Z)", "", text)


def take_comments(text):
    """The text without its comment markers, and the comments it carried."""
    notes = [m.group(1).strip() for m in COMMENT.finditer(text)]
    return COMMENT.sub("", text).rstrip(), notes


def attach_comments(doc, paragraph, notes):
    if not notes or paragraph is None:
        return
    runs = [r for r in paragraph.runs if r.text]
    if not runs:
        return
    for note in notes:
        doc.add_comment(runs, text=note, author=COMMENT_AUTHOR, initials="AKLA")


def add_runs(paragraph, text, color=None, size_pt=None, small_caps=False,
             bold=False, italic=False):
    for token in filter(None, INLINE.split(text)):
        if token.startswith("**") and token.endswith("**"):
            run = paragraph.add_run(token[2:-2])
            run.bold = True
        elif len(token) > 2 and token[0] in "*_" and token[-1] == token[0]:
            run = paragraph.add_run(token[1:-1])
            run.italic = True
        else:
            run = paragraph.add_run(token)
        run.font.name = BODY_FONT
        if bold:
            run.bold = True
        if italic:
            run.italic = True
        if small_caps:
            run.font.small_caps = True
        if color:
            run.font.color.rgb = RGBColor.from_string(color)
        if size_pt:
            run.font.size = Pt(size_pt)


def add_banner(doc, text, heading_pt):
    """The navy title block, gold Small Caps, as on the proposal cover."""
    table = doc.add_table(rows=1, cols=1)
    table.autofit = False
    no_borders(table)
    cell_margins(table, top=144, bottom=144, left=144, right=144)
    cell = table.rows[0].cells[0]
    cell.width = TEXT_WIDTH
    cell_fill(cell, NAVY)
    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(0)
    add_runs(p, text, color=GOLD, size_pt=heading_pt, small_caps=True, bold=True)
    doc.add_paragraph().paragraph_format.space_after = Pt(6)


def add_box(doc, lines):
    """Shaded centered box for a figure that must not be missed."""
    table = doc.add_table(rows=1, cols=1)
    table.autofit = False
    cell_margins(table, top=144, bottom=144, left=144, right=144)
    cell = table.rows[0].cells[0]
    cell.width = TEXT_WIDTH
    cell_fill(cell, SHADE)
    for i, line in enumerate(lines):
        p = cell.paragraphs[0] if i == 0 else cell.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(0)
        add_runs(p, line, small_caps=True, bold=True)
    doc.add_paragraph().paragraph_format.space_after = Pt(6)


def add_table(doc, rows):
    header, body = rows[0], rows[1:]
    table = doc.add_table(rows=len(rows), cols=len(header))
    table.style = "Table Grid"
    cell_margins(table)

    for j, text in enumerate(header):
        text, _ = take_comments(text)
        cell = table.rows[0].cells[j]
        cell_fill(cell, NAVY)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        add_runs(p, text, color=GOLD, small_caps=True, bold=True)

    for i, row in enumerate(body, start=1):
        for j, text in enumerate(row):
            if j >= len(header):
                continue
            p = table.rows[i].cells[j].paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            text, notes = take_comments(text)
            add_runs(p, text)
            attach_comments(doc, p, notes)
    doc.add_paragraph().paragraph_format.space_after = Pt(6)


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


DIVIDER = re.compile(r"^\|[\s:|-]+\|$")


def render(doc, markdown, heading_pt):
    title_done = False
    in_sections = False  # text before the first section is front matter
    body_level = 2       # 1.1. under a section heading, 1.1.1. under a sub-heading
    last = None  # the paragraph a free-standing comment belongs to
    lines = fold_footnotes(markdown).replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines):
        line, notes = take_comments(lines[i].strip())
        i += 1
        if not line:
            attach_comments(doc, last, notes)
            continue

        # pipe table: header row, divider row, then body rows
        if line.startswith("|") and i < len(lines) and DIVIDER.match(lines[i].strip()):
            rows = [split_row(line)]
            i += 1
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i]))
                i += 1
            add_table(doc, rows)
            continue

        # boxed figure: consecutive ::: lines form one box
        if line.startswith(":::"):
            box = [line[3:].strip()]
            while i < len(lines) and lines[i].strip().startswith(":::"):
                box.append(lines[i].strip()[3:].strip())
                i += 1
            add_box(doc, box)
            continue

        heading = re.match(r"^(#{1,4})\s+(.*)$", line)
        if heading:
            depth, text = len(heading.group(1)), heading.group(2).strip()
            if depth == 1:
                add_banner(doc, text, heading_pt)
                title_done = True
                if notes:
                    print("warning: a comment on the title was dropped", file=sys.stderr)
            elif depth == 4:
                p = doc.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                p.paragraph_format.space_before = Pt(12)
                p.paragraph_format.space_after = Pt(10)
                add_runs(p, text, small_caps=True, bold=True, size_pt=BODY_PT)
                rule(p, edges=("top", "bottom"))
                attach_comments(doc, p, notes)
                last = p
            else:
                in_sections = True
                p = doc.add_paragraph(style=f"Heading {depth - 1}")
                body_level = 1 if depth == 2 else 2
                add_runs(p, text,
                         color=GOLD if depth == 2 else "000000",
                         size_pt=heading_pt if depth == 2 else BODY_PT,
                         small_caps=True, bold=True)
                set_number(p, depth - 2)
                if depth == 2:
                    shade_paragraph(p, NAVY)
                    set_indent(p, left=0, hanging=0)
                    set_mark_format(p, color=GOLD, bold=True,
                                    size_pt=heading_pt, small_caps=True)
                    p.paragraph_format.line_spacing = 1.15
                attach_comments(doc, p, notes)
                last = p
            continue

        quote = re.match(r"^>\s?(.*)$", line)
        if quote:
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Inches(1.75)
            p.paragraph_format.right_indent = Inches(0.5)
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            add_runs(p, quote.group(1), italic=True)
            attach_comments(doc, p, notes)
            last = p
            continue

        item = re.match(r"^[-*•]\s+(.*)$", line)
        if item:
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(6)
            add_runs(p, item.group(1))
            if in_sections:
                set_number(p, 3)
            attach_comments(doc, p, notes)
            last = p
            continue

        p = doc.add_paragraph()
        add_runs(p, line)
        if in_sections:
            set_number(p, body_level)
        else:
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        attach_comments(doc, p, notes)
        last = p

    if not title_done:
        print("warning: no '# Title' line found", file=sys.stderr)


def main():
    default_logo = os.path.join(os.path.dirname(os.path.abspath(__file__)), "akla-logo.png")

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="Markdown file to render, or - for stdin")
    ap.add_argument("-o", "--out", required=True, help="output .docx path")
    ap.add_argument("--heading-pt", type=int, default=13,
                    help="major-heading size (default: 13)")
    ap.add_argument("--doc-title", default="",
                    help="header reference strip, bold; use | to split lines")
    ap.add_argument("--doc-status", default="",
                    help="header version line, e.g. 'First Circulation Version'")
    ap.add_argument("--doc-notice", default="Privileged And Confidential",
                    help="header confidentiality line, printed in red")
    ap.add_argument("--doc-date", default="", help="header date line")
    ap.add_argument("--logo", default=default_logo,
                    help="header emblem (default: the bundled AK mark)")
    ap.add_argument("--no-logo", action="store_true")
    args = ap.parse_args()
    if args.no_logo:
        args.logo = ""

    if args.source == "-":
        markdown = sys.stdin.read()
    else:
        with open(args.source, encoding="utf-8") as fh:
            markdown = fh.read()

    doc = Document()
    add_multilevel_numbering(doc)
    build_styles(doc, args.heading_pt)
    build_page(doc, args)
    render(doc, markdown, args.heading_pt)
    doc.save(args.out)
    print(args.out)


if __name__ == "__main__":
    main()
