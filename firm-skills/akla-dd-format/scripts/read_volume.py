#!/usr/bin/env python3
"""Read an existing DD volume (.docx or .pdf) into the structure build_volume.py renders.

    python3 read_volume.py "Draft Volume III.docx" -o volume.json

Classifies each block as heading / subheading / para / comment / action / response / list /
table / contract_table, and pulls out the Important Note, Glossary and Annexure A.

Detection is by MARKER TEXT first ("AKLA Comment:", "AKLA Action Item:"), colour second.
Colour alone is unreliable: in the firm's own volumes some action items inside table cells
are printed black.

Nothing is rewritten here. This step only recognises structure, so that the wording can be
carried across to a correctly formatted volume unchanged.

.docx needs python-docx; .pdf needs pymupdf.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

HEAD = re.compile(r"^\s*(\d{1,2})\.\s+(.{2,}?)\s*$")
SUBHEAD = re.compile(r"^\s*(\d{1,2}\.\d{1,2})\.\s+(.{2,}?)\s*$")
PARA = re.compile(r"^\s*(\d{1,2}(?:\.\d{1,2}){1,3})\.\s+(\S.*)$")
LIST = re.compile(r"^\s*\(([a-z]{1,4}|[ivx]{1,6}|\d{1,2})\)\s+(.*)$")
MARK = re.compile(r"^\s*AKLA (Comment|Action Item|Response)\s*:\s*(.*)$", re.S)
RUNNING = re.compile(r"^\s*(LEGAL DUE DILIGENCE REPORT|VOLUME [IVX]+ \(|FIRST DRAFT|SECOND DRAFT|FINAL|"
                     r"STRICTLY CONFIDENTIAL|Page \d+ of \d+|\[\*\*\*)", re.I)
VOL_TITLE = re.compile(r"^\s*VOLUME\s+([IVX]+)\s*[–-]\s*(.+?)\s*$", re.I)
VOL_HDR = re.compile(r"VOLUME\s+([IVX]+)\s*\((.+?)\)", re.I)



# Optional sections (development package, September 15, 2026): centred title -> volume JSON key
OPTIONAL_SECTIONS = {"SCOPE, TRANSACTION OVERVIEW AND METHODOLOGY": "methodology", "EXECUTIVE SUMMARY": "executive_summary",
                     "TRANSACTION ACTIONS": "transaction_actions", "ANNEXURE B": "coverage"}


def _roman(n: int) -> str:
    out = ""
    for v, r in ((10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")):
        while n >= v:
            out, n = out + r, n - v
    return out


def docx_numbers(doc) -> dict:
    """Map each numbered paragraph to the number Word renders for it.

    The firm's volumes number by a list definition rather than by typed digits, so the number is not in
    `paragraph.text` at all. It is reconstructed the way Word does it: each level has a counter, incrementing
    a level clears every deeper one, and the label is the counters joined by full stops. Counters are kept per
    list, so two independent lists in one document do not interfere.
    """
    from docx.oxml.ns import qn
    out, counters = {}, {}
    tree = doc.element.getroottree()
    fmts = {}                                  # numId -> {level: numFmt}; lettered and roman lists are lists, not paragraphs
    try:
        numbering = doc.part.numbering_part.element
        abstract = {a.get(qn("w:abstractNumId")): {int(l.get(qn("w:ilvl"))): (l.find(qn("w:numFmt")).get(qn("w:val")) if l.find(qn("w:numFmt")) is not None else "decimal")
                                                     for l in a.findall(qn("w:lvl"))}
                    for a in numbering.findall(qn("w:abstractNum"))}
        for n in numbering.findall(qn("w:num")):
            fmts[n.get(qn("w:numId"))] = abstract.get(n.find(qn("w:abstractNumId")).get(qn("w:val")), {})
    except (AttributeError, KeyError, NotImplementedError):
        pass
    for para in doc.element.body.iter(qn("w:p")):
        ppr = para.find(qn("w:pPr"))
        if ppr is None:
            continue
        npr = ppr.find(qn("w:numPr"))
        if npr is None:
            continue
        ilvl, numid = npr.find(qn("w:ilvl")), npr.find(qn("w:numId"))
        if ilvl is None or numid is None:
            continue
        lvl, nid = int(ilvl.get(qn("w:val"))), numid.get(qn("w:val"))
        seq = counters.setdefault(nid, {})
        seq[lvl] = seq.get(lvl, 0) + 1
        for deeper in [k for k in seq if k > lvl]:
            seq.pop(deeper)
        # lxml hands out a fresh proxy each time an element is reached, so id() is not a stable
        # key; the element's path in the tree is.
        fmt = fmts.get(nid, {}).get(lvl, "decimal")
        if fmt in ("lowerLetter", "upperLetter"):
            out[tree.getpath(para)] = "(" + "abcdefghijklmnopqrstuvwxyz"[(seq[lvl] - 1) % 26] + ")"
        elif fmt in ("lowerRoman", "upperRoman"):
            out[tree.getpath(para)] = "(" + _roman(seq[lvl]) + ")"
        else:
            out[tree.getpath(para)] = ".".join(str(seq.get(k, 1)) for k in range(lvl + 1))
    return out


def classify(text: str, number: str | None = None, style: str | None = None) -> dict | None:
    t = (text or "").strip()
    if not t or RUNNING.match(t):
        return None
    m = MARK.match(t)
    if m:
        kind = {"Comment": "comment", "Action Item": "action", "Response": "response"}[m.group(1)]
        return {"type": kind, "text": m.group(2).strip()}
    if number and number.startswith("("):
        return {"type": "list_item", "label": number.strip("()"), "text": t}
    if number:
        # The number came from the list definition, so the text carries none: the style says what this is.
        st = style or ""
        kind = ("heading" if st == "Heading 1" else
                "subheading" if st.startswith("Heading") else "para")
        return {"type": kind, "number": number, "text": t}
    m = PARA.match(t)
    if m and m.group(1).count(".") >= 1:
        num, body = m.group(1), m.group(2).strip()
        if num.count(".") == 0 and body.upper() == body:
            return {"type": "heading", "number": num, "text": body}
        return {"type": "para", "number": num, "text": body}
    m = SUBHEAD.match(t)
    if m and m.group(2).upper() == m.group(2):
        return {"type": "subheading", "number": m.group(1), "text": m.group(2).strip()}
    m = HEAD.match(t)
    if m and m.group(2).upper() == m.group(2) and len(m.group(2)) > 2:
        return {"type": "heading", "number": m.group(1), "text": m.group(2).strip()}
    m = LIST.match(t)
    if m:
        return {"type": "list_item", "label": m.group(1), "text": m.group(2).strip()}
    if VOL_TITLE.match(t):
        return {"type": "title", "text": t}
    return {"type": "para", "text": t}


def _fold_lists(blocks: list[dict]) -> list[dict]:
    out, i = [], 0
    while i < len(blocks):
        if blocks[i]["type"] == "list_item":
            items, style = [], "alpha"
            while i < len(blocks) and blocks[i]["type"] == "list_item":
                if re.fullmatch(r"[ivx]+", blocks[i]["label"]) and blocks[i]["label"] != "i":
                    style = "roman"
                items.append(blocks[i]["text"])
                i += 1
            out.append({"type": "list", "items": items, "style": style})
            continue
        out.append(blocks[i])
        i += 1
    return out


# ---------------------------------------------------------------- docx
def read_docx(path: Path) -> dict:
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    d = docx.Document(str(path))
    numbers = docx_numbers(d)
    body, glossary, ann_items = [], [], []
    note_blocks, toc_seen, seen_vol_title = [], False, []
    extra = {k: [] for k in OPTIONAL_SECTIONS.values()}
    coverage_title = None
    section = None   # None -> front matter, "note", "glossary", "body", "annexure", or an optional section key

    def walk(el, parent):
        for child in el.iterchildren():
            tag = child.tag.split("}")[1]
            if tag == "p":
                yield "p", Paragraph(child, parent)
            elif tag == "tbl":
                yield "t", Table(child, parent)

    for kind, obj in walk(d.element.body, d):
        if kind == "p":
            raw = re.sub(r"\s+", " ", obj.text).strip()
            if not raw:
                continue
            if "PAGEREF" in obj._p.xml:            # a contents row (portrait contents), not a landmark or body text
                continue
            up = raw.upper()
            if up.startswith("TABLE OF CONTENTS"):
                toc_seen = True
                continue
            if up.startswith("IMPORTANT NOTE"):
                section = "note"
                continue
            key = next((k for t, k in OPTIONAL_SECTIONS.items() if up == t or (k == "coverage" and up.startswith(t))), None)
            if key and obj.alignment == 1:          # centred section title, not a body heading of the same words
                section = key
                if key == "coverage":
                    coverage_title = raw
                continue
            if up.startswith("GLOSSARY"):
                section = "glossary"
                continue
            if up.startswith("ANNEXURE A"):
                section = "annexure"
                continue
            mv = VOL_TITLE.match(raw)
            if mv:
                section = "body"
                seen_vol_title.append((mv.group(1).upper(), mv.group(2).strip()))
                continue
            b = classify(raw, numbers.get(d.element.getroottree().getpath(obj._p)), obj.style.name)
            if b is None:
                continue
            if section == "note":
                note_blocks.append(b)
            elif section in extra:
                extra[section].append(b)
            elif section == "annexure":
                if b["type"] == "list_item":
                    ann_items.append(b["text"])
            elif section in (None, "glossary"):
                # Front matter and the glossary are not carried across as body prose: the glossary
                # is read from its DEFINED TERM / MEANING table below. If a draft writes its
                # glossary as paragraphs instead, that text is dropped here and the content check
                # will refuse the rebuild - which is the intended outcome, not a silent loss.
                continue
            else:
                body.append(b)
        else:  # table
            rows = [[re.sub(r"\s+", " ", c.text).strip() for c in r.cells] for r in obj.rows]
            if not rows:
                continue
            head = [h.upper() for h in rows[0][:2]]
            if head[:2] == ["DEFINED TERM", "MEANING"]:
                for r in rows[1:]:
                    if len(r) >= 2 and r[0] and r[1]:
                        glossary.append({"term": r[0], "meaning": r[1]})
                continue
            if section is None and len(rows) == 1 and len(set(rows[0])) == 1:
                continue                            # the cover's title banner, rebuilt by the cover itself
            if section in extra:
                extra[section].append(_table_block(obj, rows))
            elif section == "body" or section is None:
                body.append(_table_block(obj, rows))

    meta = _meta_from_docx(d, path)
    if seen_vol_title:                      # a draft with no header still names the volume in the body
        roman, vtitle = seen_vol_title[0]
        if not meta.get("volume_title"):
            meta["volume_title"] = vtitle.title()
        if meta.get("volume_roman") in ("", "I") and roman:
            meta["volume_roman"] = roman
    out = {**meta, "important_note": _fold_lists(note_blocks), "glossary": glossary,
           "blocks": _fold_lists(body),
           "annexure": {"title": "ANNEXURE A – REVIEWED DOCUMENTS", "intro": "", "items": ann_items}}
    for k, blocks in extra.items():
        if blocks:
            out[k] = _fold_lists(blocks)
    if coverage_title and extra["coverage"]:
        out["coverage_title"] = coverage_title
    return out


def _table_block(tbl, rows) -> dict:
    """A 2-column table whose first row is a merged title is a contract summary table."""
    ncols = len(tbl.columns)
    first = rows[0]
    merged_first = ncols == 2 and len(set(first)) == 1 and first[0]
    if merged_first:
        groups, cur = [], None
        for r in rows[1:]:
            merged = len(set(r)) == 1 and r[0]
            if merged:
                cur = {"title": r[0], "rows": []}
                groups.append(cur)
            else:
                if cur is None:
                    cur = {"title": "", "rows": []}
                    groups.append(cur)
                blocks = []
                for chunk in re.split(r"(?=AKLA (?:Comment|Action Item|Response):)", r[1] if len(r) > 1 else ""):
                    c = classify(chunk)
                    if c:
                        blocks.append(c)
                cur["rows"].append({"label": r[0], "blocks": blocks or [{"type": "para", "text": ""}]})
        return {"type": "contract_table", "title": first[0], "groups": groups}
    return {"type": "table", "columns": first, "rows": [list(r) for r in rows[1:]]}


def _meta_from_docx(d, path: Path) -> dict:
    title, roman, vtitle, draft, date = "", "", "", "", ""
    sec = d.sections[0]
    texts = [p.text for p in sec.header.paragraphs]
    for t in sec.header.tables:
        for r in t.rows:
            for c in r.cells:
                texts += [p.text for p in c.paragraphs]
    for t in [re.sub(r"\s+", " ", x).strip() for x in texts if x.strip()]:
        if "DUE DILIGENCE REPORT" in t.upper() and not title:
            title = t
        m = VOL_HDR.search(t)
        if m and not roman:
            roman, vtitle = m.group(1).upper(), m.group(2).strip()
        if re.match(r"^(FIRST|SECOND|THIRD|FINAL)\s+DRAFT$", t, re.I) and not draft:
            draft = t.upper()
        if re.match(r"^[A-Z][a-z]+ \d{1,2}, \d{4}$", t) and not date:
            date = t
    m = re.search(r"Volume\s+([IVX]+)", path.name, re.I)
    if m and not roman:
        roman = m.group(1).upper()
    return {"report_title": title or "LEGAL DUE DILIGENCE REPORT", "volume_roman": roman or "I",
            "volume_title": vtitle or "", "draft_label": draft or "FIRST DRAFT", "date": date or ""}


# ---------------------------------------------------------------- pdf
def read_pdf(path: Path) -> dict:
    import pymupdf
    doc = pymupdf.open(str(path))
    body, glossary, ann_items, note_blocks = [], [], [], []
    section, toc_seen = None, False
    for page in doc:
        for blk in page.get_text("dict")["blocks"]:
            if blk.get("type") != 0:
                continue
            txt = " ".join("".join(s["text"] for s in l["spans"]) for l in blk["lines"])
            raw = re.sub(r"\s+", " ", txt).strip()
            if not raw:
                continue
            up = raw.upper()
            if up.startswith("TABLE OF CONTENTS"):
                toc_seen = True
                continue
            if up.startswith("IMPORTANT NOTE"):
                section = "note"; continue
            if up.startswith("GLOSSARY"):
                section = "glossary"; continue
            if up.startswith("ANNEXURE A"):
                section = "annexure"; continue
            if VOL_TITLE.match(raw):
                section = "body"; continue
            b = classify(raw)
            if b is None or not toc_seen:
                continue
            if section == "note":
                note_blocks.append(b)
            elif section in extra:
                extra[section].append(b)
            elif section == "annexure":
                if b["type"] == "list_item":
                    ann_items.append(b["text"])
            elif section == "body":
                body.append(b)
    m = re.search(r"Volume\s+([IVX]+)", path.name, re.I)
    return {"report_title": "LEGAL DUE DILIGENCE REPORT", "volume_roman": (m.group(1).upper() if m else "I"),
            "volume_title": "", "draft_label": "FIRST DRAFT", "date": "",
            "important_note": _fold_lists(note_blocks), "glossary": glossary, "blocks": _fold_lists(body),
            "annexure": {"title": "ANNEXURE A – REVIEWED DOCUMENTS", "intro": "", "items": ann_items}}


def main():
    ap = argparse.ArgumentParser(description="Read a DD volume into the structure build_volume.py renders.")
    ap.add_argument("file")
    ap.add_argument("-o", "--out", default="volume.json")
    a = ap.parse_args()
    p = Path(a.file)
    if not p.exists():
        raise SystemExit(f"not found: {p}")
    vol = read_docx(p) if p.suffix.lower() == ".docx" else read_pdf(p)
    Path(a.out).write_text(json.dumps(vol, indent=1, ensure_ascii=False))
    n = {}
    for b in vol["blocks"]:
        n[b["type"]] = n.get(b["type"], 0) + 1
    print(f"read: {p.name}")
    print(f"  Volume {vol['volume_roman']} {vol['volume_title']!r} | {vol['draft_label']} | {vol['date'] or 'no date found'}")
    print(f"  body blocks: {n}")
    print(f"  glossary {len(vol['glossary'])} | Important Note {len(vol['important_note'])} blocks "
          f"| Annexure A {len(vol['annexure']['items'])} items")
    print(f"  -> {a.out}")
    missing = [k for k, ok in (("Important Note", vol["important_note"]), ("Glossary", vol["glossary"]),
                               ("Annexure A", vol["annexure"]["items"])) if not ok]
    if missing:
        print(f"  MISSING: {', '.join(missing)} - flag to the user, do not invent")


if __name__ == "__main__":
    main()
