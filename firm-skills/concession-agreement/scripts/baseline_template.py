#!/usr/bin/env python3
"""Fingerprint the master template so the checker reports only what changed.

    python3 baseline_template.py "assets/Standard Concession Agreement [AKLA].docx" -o assets/baseline.json

The master already carries defects - a missing Article 28, a dangling reference to
Schedule Z, six malformed definition stems, unresolved tracked changes, a hundred
internal footnotes. Run the checks cold and the first thing the tool ever prints is
noise a lawyer learns to ignore. So the checks compare against this fingerprint and
report the delta.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from docxlib import Package, iter_paragraphs, para_text, para_style, q


def geometry(pkg: Package) -> dict:
    doc = pkg.document()
    sect = doc.find(".//" + q("sectPr"))
    out = {}
    if sect is not None:
        pg = sect.find(q("pgSz"))
        mg = sect.find(q("pgMar"))
        if pg is not None:
            out["page_w"] = pg.get(q("w")); out["page_h"] = pg.get(q("h"))
        if mg is not None:
            for k in ("top", "right", "bottom", "left"):
                out["margin_" + k] = mg.get(q(k))
    styles = pkg.xml("word/styles.xml")
    dd = styles.find(q("docDefaults"))
    if dd is not None:
        f = dd.find(".//" + q("rFonts"))
        if f is not None:
            out["default_font"] = f.get(q("ascii"))
    for s in styles.findall(q("style")):
        if s.get(q("styleId")) in ("Heading1", "Normal"):
            sz = s.find(".//" + q("sz"))
            out[f"{s.get(q('styleId'))}_sz"] = sz.get(q("val")) if sz is not None else None
    return out


def counts(pkg: Package) -> dict:
    doc = pkg.document()
    paras = list(iter_paragraphs(doc))
    by_style = Counter(para_style(p) or "(none)" for p in paras)
    c = {
        "paragraphs": len(paras),
        "tables": len(list(doc.iter(q("tbl")))),
        "ins": len(list(doc.iter(q("ins")))),
        "del": len(list(doc.iter(q("del")))),
        "rPrChange": len(list(doc.iter(q("rPrChange")))),
        "bookmarkStart": len(list(doc.iter(q("bookmarkStart")))),
        "commentReference": len(list(doc.iter(q("commentReference")))),
        "footnoteReference": len(list(doc.iter(q("footnoteReference")))),
        "fields": len(list(doc.iter(q("instrText")))),
        "heading1": by_style.get("Heading1", 0),
    }
    if pkg.has("word/footnotes.xml"):
        fn = pkg.xml("word/footnotes.xml")
        c["footnotes"] = sum(1 for e in fn.findall(q("footnote")) if e.get(q("type")) is None)
    if pkg.has("word/comments.xml"):
        c["comments"] = len(pkg.xml("word/comments.xml").findall(q("comment")))
    return c


def part_hashes(pkg: Package) -> dict:
    return {n: hashlib.sha1(pkg.raw(n)).hexdigest() for n in pkg.names()}


def text_hash(pkg: Package) -> str:
    h = hashlib.sha1()
    for p in iter_paragraphs(pkg.document()):
        h.update(para_text(p).encode("utf-8")); h.update(b"\n")
    return h.hexdigest()


def known_findings(pkg: Package) -> list[str]:
    """Defects present in the master itself, recorded so they are not re-reported."""
    from check_agreement import audit_findings
    return sorted(f"{lvl}: {msg}" for lvl, msg in audit_findings(pkg, baseline=None))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("template")
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()
    pkg = Package(args.template)
    data = {
        "template": Path(args.template).name,
        "geometry": geometry(pkg),
        "counts": counts(pkg),
        "text_sha1": text_hash(pkg),
        "parts": part_hashes(pkg),
        "known_findings": known_findings(pkg),
    }
    Path(args.out).write_text(json.dumps(data, indent=2))
    print(f"wrote {args.out}: {len(data['parts'])} parts, "
          f"{len(data['known_findings'])} pre-existing findings recorded")


if __name__ == "__main__":
    main()
