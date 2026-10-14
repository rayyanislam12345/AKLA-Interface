#!/usr/bin/env python3
"""Shared OOXML helpers for the concession agreement skill.

    from docxlib import Package, iter_paragraphs, para_text, replace_span

The whole skill is built on one rule: the master template is edited in place, never
regenerated. It carries 284 abstractNum definitions, a TOC field, three header/footer
parts and an ink part, none of which survive a round trip through a document builder.
So Package keeps every zip entry as raw bytes and re-serialises only the parts that
were actually touched.
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NSMAP = {"w": W}


def q(tag: str) -> str:
    """'w:t' -> '{namespace}t'."""
    return "{%s}%s" % (W, tag)


# ---------------------------------------------------------------- package

class Package:
    """A .docx held as raw zip entries, with lazily parsed XML parts.

    Only parts fetched through .xml() and then marked dirty are re-serialised on
    save; everything else is copied through byte for byte.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._zin = zipfile.ZipFile(self.path)
        self._raw: dict[str, bytes] = {n: self._zin.read(n) for n in self._zin.namelist()}
        self._order: list[zipfile.ZipInfo] = list(self._zin.infolist())
        self._trees: dict[str, etree._Element] = {}
        self._dirty: set[str] = set()
        self._zin.close()

    # -- access ---------------------------------------------------------

    def raw(self, name: str) -> bytes:
        return self._raw[name]

    def has(self, name: str) -> bool:
        return name in self._raw

    def names(self) -> list[str]:
        return list(self._raw)

    def xml(self, name: str) -> etree._Element:
        """Parsed root of a part. Call touch(name) after modifying it."""
        if name not in self._trees:
            self._trees[name] = etree.fromstring(self._raw[name])
        return self._trees[name]

    def touch(self, name: str) -> None:
        self._dirty.add(name)

    def document(self) -> etree._Element:
        return self.xml("word/document.xml")

    # -- save -----------------------------------------------------------

    def save(self, out: str | Path) -> Path:
        out = Path(out)
        for name in self._dirty:
            self._raw[name] = etree.tostring(
                self._trees[name], xml_declaration=True, encoding="UTF-8", standalone=True
            )
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in self._order:
                zout.writestr(info, self._raw[info.filename])
            for name, data in self._raw.items():
                if name not in {i.filename for i in self._order}:
                    zout.writestr(name, data)
        return out

    def untouched_parts_identical_to(self, other: "Package") -> list[str]:
        """Part names whose bytes differ from `other`. Used by the checker."""
        diff = []
        for name in self._raw:
            if not other.has(name):
                diff.append(name)
            elif name not in self._dirty and self._raw[name] != other.raw(name):
                diff.append(name)
        return diff


# ---------------------------------------------------------------- traversal

def iter_paragraphs(root: etree._Element):
    """Every w:p in document order, including inside tables and text boxes."""
    yield from root.iter(q("p"))


def text_nodes(p: etree._Element) -> list[etree._Element]:
    """Live w:t nodes of a paragraph, in order.

    Skips w:delText, which is struck-through content and not part of the visible
    text, but keeps w:t inside w:ins, which is.
    """
    out = []
    for t in p.iter(q("t")):
        if _inside(t, "del"):
            continue
        out.append(t)
    return out


def _inside(el: etree._Element, tag: str) -> bool:
    node = el.getparent()
    while node is not None:
        if node.tag == q(tag):
            return True
        node = node.getparent()
    return False


def para_text(p: etree._Element) -> str:
    """Visible text of a paragraph.

    Note that w:tab is a separate element, not a character, so tabs vanish here.
    That is deliberate: it keeps offsets aligned with the w:t nodes that
    replace_span writes into.
    """
    return "".join(t.text or "" for t in text_nodes(p))


def para_style(p: etree._Element) -> str | None:
    pPr = p.find(q("pPr"))
    if pPr is None:
        return None
    ps = pPr.find(q("pStyle"))
    return ps.get(q("val")) if ps is not None else None


def run_of(t: etree._Element) -> etree._Element | None:
    node = t.getparent()
    return node if node is not None and node.tag == q("r") else None


def is_bold(t: etree._Element) -> bool:
    r = run_of(t)
    if r is None:
        return False
    rPr = r.find(q("rPr"))
    if rPr is None:
        return False
    b = rPr.find(q("b"))
    return b is not None and b.get(q("val")) not in ("0", "false")


def in_revision(t: etree._Element) -> str | None:
    """'ins' or 'del' if this text sits inside a tracked change, else None."""
    for tag in ("ins", "del"):
        if _inside(t, tag):
            return tag
    return None


# ---------------------------------------------------------------- editing

def replace_span(p: etree._Element, start: int, end: int, new: str) -> bool:
    """Replace characters [start:end) of a paragraph's visible text with `new`.

    Formatting is preserved by writing into existing w:t nodes rather than making
    new runs. When a span covers several nodes the replacement lands wholly in the
    first and the remainder are emptied, so the result carries the first node's
    formatting. Placeholders normally sit inside a single run, which makes that the
    common and exact case; read_template records the expected formatting so the
    checker can flag the rare span that does not.
    """
    nodes = text_nodes(p)
    pos = 0
    touched = False
    for t in nodes:
        txt = t.text or ""
        a, b = pos, pos + len(txt)
        pos = b
        if b <= start or a >= end:
            continue
        lo, hi = max(start, a) - a, min(end, b) - a
        if not touched:
            t.text = txt[:lo] + new + txt[hi:]
            touched = True
        else:
            t.text = txt[:lo] + txt[hi:]
        _preserve_space(t)
    return touched


def _preserve_space(t: etree._Element) -> None:
    val = t.text or ""
    key = "{http://www.w3.org/XML/1998/namespace}space"
    if val != val.strip():
        t.set(key, "preserve")


def delete_paragraph(p: etree._Element) -> None:
    parent = p.getparent()
    if parent is not None:
        parent.remove(p)


def set_update_fields(pkg: Package) -> None:
    """Make Word rebuild the table of contents when the file is opened.

    The master has no updateFields setting, so a delivered draft would show the
    cached headings and page numbers with no prompt.
    """
    name = "word/settings.xml"
    root = pkg.xml(name)
    for el in root.findall(q("updateFields")):
        root.remove(el)
    el = etree.SubElement(root, q("updateFields"))
    el.set(q("val"), "true")
    pkg.touch(name)


# ---------------------------------------------------------------- placeholders

# Whitespace-padded forms are live blanks in this template: [ ● ], [ • ], [x].
VALUE_BLANK = re.compile(r"\[\s*[●•xX]\s*\]")

DIRECTIVE = re.compile(
    r"\[\s*(?:INCLUDE ONLY IF|OPTION\b|Option\b|Conditional Amendment)[^\]]*\]"
)
STUB = re.compile(r"\[\s*(?:To Be Attached Hereto|List To Be Added)[^\]]*\]", re.I)
ANY_BRACKET = re.compile(r"\[[^\[\]]{0,200}\]")


def classify(token: str) -> str:
    """One of: value, directive, stub, choice, optional.

    The class decides what the build is allowed to do. A value is a text swap; a
    choice picks one limb; an optional block is kept-and-unbracketed or deleted
    whole; a stub waits for an attachment; a directive is an instruction to the
    drafter and must never survive into an issued draft.
    """
    if VALUE_BLANK.fullmatch(token):
        return "value"
    if DIRECTIVE.fullmatch(token):
        return "directive"
    if STUB.fullmatch(token):
        return "stub"
    inner = token[1:-1].strip()
    if "/" in inner or re.search(r"\bor\b", inner):
        return "choice"
    if inner.endswith((";", ".")) or len(inner.split()) > 6:
        return "optional"
    # Short named fields such as [Date], [Month], [Location], [1 July] are blanks
    # to be filled, not alternatives to choose between.
    return "value"


def scan_brackets(p: etree._Element):
    """Yield (start, end, token, class) for every bracket token in a paragraph."""
    txt = para_text(p)
    for m in ANY_BRACKET.finditer(txt):
        yield m.start(), m.end(), m.group(0), classify(m.group(0))


# ---------------------------------------------------------------- house register

_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
         "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
         "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]
_SCALE = [(10 ** 9, "Billion"), (10 ** 6, "Million"), (10 ** 3, "Thousand"), (100, "Hundred")]


def number_words(n: int) -> str:
    """Integer to words in the firm's title-case register: 'Two Hundred Twenty-Nine'."""
    n = int(n)
    if n == 0:
        return "Zero"
    if n < 0:
        return "Minus " + number_words(-n)
    parts = []
    for value, name in _SCALE:
        if n >= value:
            parts.append(number_words(n // value) + " " + name)
            n %= value
    if n >= 20:
        parts.append(_TENS[n // 10] + ("-" + _ONES[n % 10] if n % 10 else ""))
    elif n:
        parts.append(_ONES[n])
    return " ".join(parts)


def render(value: str, role: str) -> str:
    """Render a supplied value in the form the template slot expects.

    Numbers are supplied once as digits; the roles say how each slot spells them.
    A value that is not a clean number is passed through untouched so the drafter's
    own wording is never second-guessed.
    """
    v = str(value).strip()
    digits = re.sub(r"[,\s]", "", v)
    is_num = re.fullmatch(r"\d+(\.\d+)?", digits) is not None
    if role == "text" or not is_num:
        return v
    whole = int(float(digits))
    if role == "numeral":
        return f"{whole}"
    if role == "words":
        return number_words(whole).lower()
    if role == "pct_numeral":
        return f"{digits}"
    if role == "pct_words":
        return number_words(whole).lower()
    if role == "pct_full":
        return f"{number_words(whole).lower()} percent ({digits}%)"
    if role == "pct_sign":
        return f"{digits}%"
    if role == "money_numeral":
        return f"{whole:,}"
    if role == "money_words":
        return number_words(whole)
    return v
