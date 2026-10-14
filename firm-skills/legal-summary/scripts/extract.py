#!/usr/bin/env python3
"""Extract text from a legal document with page/paragraph anchors for citation.

Usage:
    python3 extract.py FILE [FILE ...] [--out DIR] [--stats-only]

Emits UTF-8 text to stdout (or to DIR/<name>.txt with --out), with page markers
of the form:

    <<<page 12>>>

so every fact in a summary can be cited back to a page. Prints a stats line to
stderr: pages, words, and whether the PDF looked scanned (no extractable text).

Supported: .pdf .docx .doc .rtf .odt .txt .md .html .htm
"""
import sys
import os
import re
import shutil
import subprocess
import argparse

PAGE = "\n<<<page {n}>>>\n"


def _clean(t):
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"[ \t]+\n", "\n", t)
    t = re.sub(r"\n{4,}", "\n\n\n", t)
    return t.strip()


def from_pdf(path):
    """Try each backend in turn - availability differs across environments."""
    errors = []

    try:
        import pdfplumber
        parts = []
        with pdfplumber.open(path) as pdf:
            n = len(pdf.pages)
            for i, page in enumerate(pdf.pages, 1):
                parts.append(PAGE.format(n=i))
                parts.append(page.extract_text() or "")
        return "".join(parts), n
    except ImportError:
        pass
    except Exception as e:
        errors.append(f"pdfplumber: {e}")

    try:
        import pypdf
        reader = pypdf.PdfReader(path)
        parts = []
        for i, page in enumerate(reader.pages, 1):
            parts.append(PAGE.format(n=i))
            parts.append(page.extract_text() or "")
        return "".join(parts), len(reader.pages)
    except ImportError:
        pass
    except Exception as e:
        errors.append(f"pypdf: {e}")

    try:
        import pymupdf
        doc = pymupdf.open(path)
        parts = []
        for i, page in enumerate(doc, 1):
            parts.append(PAGE.format(n=i))
            parts.append(page.get_text("text"))
        n = doc.page_count
        doc.close()
        return "".join(parts), n
    except ImportError:
        pass
    except Exception as e:
        errors.append(f"pymupdf: {e}")

    if shutil.which("pdftotext"):
        out = subprocess.run(
            ["pdftotext", "-layout", path, "-"],
            capture_output=True, text=True, check=True,
        ).stdout
        pages = out.split("\f")
        parts = []
        for i, p in enumerate(pages, 1):
            if p.strip():
                parts.append(PAGE.format(n=i))
                parts.append(p)
        return "".join(parts), len(pages)

    raise SystemExit(
        "No PDF backend available (tried pdfplumber, pypdf, pymupdf, pdftotext)."
        + ("\n  " + "\n  ".join(errors) if errors else "")
    )


def from_docx(path):
    """Paragraphs plus tables, in document order where possible."""
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(path)
    body = doc.element.body
    parts = []
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            txt = Paragraph(child, doc).text.strip()
            if txt:
                parts.append(txt)
        elif tag == "tbl":
            for row in Table(child, doc).rows:
                cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                if any(cells):
                    parts.append(" | ".join(cells))
    return "\n\n".join(parts), None


def from_textutil(path):
    """.doc/.rtf/.odt via macOS textutil. Absent off macOS."""
    if not shutil.which("textutil"):
        raise SystemExit(
            f"Cannot read {os.path.splitext(path)[1]} here - textutil is macOS-only. "
            "Convert the file to .docx or .pdf first, or paste the text in directly."
        )
    return subprocess.run(
        ["textutil", "-convert", "txt", "-stdout", path],
        capture_output=True, text=True, check=True,
    ).stdout, None


def from_html(path):
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return from_textutil(path)
    with open(path, "rb") as fh:
        soup = BeautifulSoup(fh.read(), "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    return soup.get_text("\n"), None


def from_plain(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read(), None


HANDLERS = {
    ".pdf": from_pdf,
    ".docx": from_docx,
    ".doc": from_textutil,
    ".rtf": from_textutil,
    ".rtfd": from_textutil,
    ".odt": from_textutil,
    ".html": from_html,
    ".htm": from_html,
    ".txt": from_plain,
    ".md": from_plain,
}


def extract(path):
    ext = os.path.splitext(path)[1].lower()
    handler = HANDLERS.get(ext)
    if handler is None:
        raise SystemExit(f"Unsupported file type: {ext or path}")
    text, pages = handler(path)
    return _clean(text), pages


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--out", help="write <name>.txt into this directory")
    ap.add_argument("--stats-only", action="store_true",
                    help="report size/scan status, do not emit text")
    args = ap.parse_args()

    if args.out:
        os.makedirs(args.out, exist_ok=True)

    for path in args.files:
        if not os.path.exists(path):
            print(f"!! missing: {path}", file=sys.stderr)
            continue
        text, pages = extract(path)
        words = len(text.split())
        name = os.path.basename(path)

        note = ""
        if path.lower().endswith(".pdf") and pages and words < pages * 20:
            note = "  ** little/no extractable text - likely a SCAN, needs OCR **"
        print(f"{name}: {pages or '?'} pages, {words:,} words{note}",
              file=sys.stderr)

        if args.stats_only:
            continue
        if args.out:
            dest = os.path.join(args.out, os.path.splitext(name)[0] + ".txt")
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(dest)
        else:
            if len(args.files) > 1:
                print(f"\n\n===== {name} =====\n")
            print(text)


if __name__ == "__main__":
    main()
