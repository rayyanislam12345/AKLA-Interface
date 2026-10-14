"""Check that every quoted excerpt in a note appears in the source law texts.

Usage: python3 scripts/check_excerpts.py note.md --sources ./sources
Normalises quotes, dashes, whitespace, footnote markers and page furniture;
splits each excerpt on [...] and on clause punctuation, and reports any piece
not found in the corpus.
"""
import re, sys, glob, html, os
import argparse
ap = argparse.ArgumentParser(description="Check every quoted excerpt in a note against the source texts.")
ap.add_argument("note", help="the note's Markdown file")
ap.add_argument("--sources", nargs="+", default=["sources"], help="folders (or files) holding the source texts: .txt, .md, .html")
args = ap.parse_args()
SOURCES = []
for src in args.sources:
    if os.path.isdir(src):
        SOURCES += [p for p in glob.glob(os.path.join(src, "**", "*"), recursive=True) if p.endswith((".txt", ".md", ".html"))]
    elif os.path.isfile(src):
        SOURCES.append(src)
if not SOURCES:
    sys.exit(f"no source texts found under {args.sources}; save the statutes or documents the note quotes there as .txt first")

def norm(s):
    s = html.unescape(s)
    s = re.sub(r"<[^>]+>", " ", s)
    for a, b in [("“", '"'), ("”", '"'), ("‘", "'"), ("’", "'"), ("—", "-"), ("–", "-"),
                 ("‑", "-"), ("­", ""), ("__", "-"), ("…", "..."), (" ", " ")]:
        s = s.replace(a, b)
    s = re.sub(r"\[Page \d+\]", " ", s)
    s = re.sub(r"Page \d+ of \d+", " ", s)
    s = re.sub(r"\b\d{1,3}\[", "", s)          # footnote markers like 13[
    s = s.replace("[", "").replace("]", "").replace('"', "").replace("'", "")
    s = re.sub(r"[*_>|]", " ", s)
    s = re.sub(r"-\s+", "-", s)                 # hyphen split across lines
    s = re.sub(r"\s+", " ", s)
    return s.lower().strip()

corpus = ""
for p in SOURCES:
    try:
        corpus += " " + norm(open(p, encoding="utf-8", errors="ignore").read())
    except Exception:
        pass

md = open(args.note, encoding="utf-8").read()
quotes = re.findall(r'^> "(.*)"\s*$', md, re.M)
quotes += [m.group(2) for m in re.finditer(r"\{\{([^|{}]+)\|([^|{}]+)(?:\|[^|{}]+)?\}\}", md)]
bad = 0
for q in quotes:
    for frag in re.split(r"\s*\[…\]\s*|\s*…\s*", q):
        frag = norm(frag)
        if len(frag) < 10 or frag in corpus:
            continue
        pieces = [p for p in re.split(r"(?<=[;:,.)]) ", frag) if len(p) > 18]
        miss = [p for p in pieces if p not in corpus]
        if miss:
            bad += 1
            print("MISS:", miss[:2], "\n")
print(f"{len(quotes)} excerpts checked; {bad} with unmatched text")
sys.exit(1 if bad else 0)
