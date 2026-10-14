#!/usr/bin/env python3
"""Audit a concession agreement draft and prove nothing moved that should not have.

    python3 check_agreement.py draft.docx
    python3 check_agreement.py draft.docx --against "assets/Standard Concession Agreement [AKLA].docx" \\
                                          --baseline assets/baseline.json

The second form is the one that matters. It compares the draft with the master
paragraph by paragraph and treats any change that is not at a placeholder as a
FAIL, asserts numbering.xml and styles.xml are byte-identical, and then runs the
drafting audit - directive residue, undefined pointers, dangling Schedule and
Article references, orphan definitions, truncated clauses, malformed definition
stems, number-word disagreement. With --baseline, findings already present in the
master are suppressed so only new ones print. Exit code is 1 on any FAIL.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from docxlib import (
    Package, iter_paragraphs, para_text, para_style, scan_brackets, classify,
    number_words, q,
)

# ---------------------------------------------------------------- patterns

DEF_HEAD = re.compile(
    r"^([A-Z][A-Za-z0-9’'&/\-\(\) ]{2,80}?)\s+(means|shall have the meaning|shall bear the meaning|has the meaning)\b"
)
POINTER = re.compile(r"meaning (?:as )?ascribed thereto in (Schedule ([A-Z]))")
SCHED_HEAD = re.compile(r"^Schedule ([A-Z])\s*[–-]")
SCHED_REF = re.compile(r"\bSchedule ([A-Z])\b(?![a-z])")
ARTICLE_REF = re.compile(r"\bArticle (\d+)\b")
SECTION_REF = re.compile(r"\bSection (\d+)\.\d+")
MALFORMED = re.compile(r"\bmeans shall\b|\bmeans means\b|\bshall shall\b|\bthe the\b|\bof of\b")
DANGLING = re.compile(r"\b(and|or|of|to|the|a|an|in|by|for|with|including|under|pursuant to)\s*$")
TERMINAL = ".;:,)]’”\"'!?"
NUM_WORD = re.compile(r"\b([a-z]+(?:[- ][a-z]+)?) \((\d+)\)")
INTERNAL_NOTE = re.compile(
    r"\bADB\b|to be discussed|drafting note|input required|\bTBD\b|to be confirmed"
    r"|to be added|to be checked|is taken from|not dicussed|not discussed", re.I)

_WORDS = {number_words(i).lower().replace("-", " "): i for i in range(0, 1001)}
_WORDS.update({number_words(i).lower().replace("-", " "): i for i in (1500, 2000, 5000, 10000)})


# ---------------------------------------------------------------- audit

def audit_findings(pkg: Package, baseline: dict | None) -> list[tuple[str, str]]:
    F: list[tuple[str, str]] = []
    doc = pkg.document()
    paras = list(iter_paragraphs(doc))
    texts = [para_text(p) for p in paras]
    full = "\n".join(texts)

    # zones and structure
    zone, zones, schedules, articles = "Preamble", [], set(), 0
    for p, t in zip(paras, texts):
        s = t.strip()
        m = SCHED_HEAD.match(s)
        if m:
            zone = f"Schedule {m.group(1)}"; schedules.add(m.group(1))
        elif para_style(p) == "Heading1" and s:
            if s in ("List of Schedules", "Signature Page"):
                zone = s
            else:
                articles += 1; zone = f"Article {articles}"
        zones.append(zone)

    # -- placeholders --------------------------------------------------------
    residue: dict[str, list] = defaultdict(list)
    for p, z in zip(paras, zones):
        for _, _, tok, cls in scan_brackets(p):
            residue[cls].append((z, tok))
    for z, tok in residue.get("directive", []):
        F.append(("FAIL", f"drafter directive left in {z}: {tok[:70]}"))
    for cls, label in (("value", "value blank"), ("choice", "unresolved choice"),
                       ("optional", "optional block still bracketed"), ("stub", "awaiting attachment")):
        by = Counter(z for z, _ in residue.get(cls, []))
        for z, n in sorted(by.items()):
            F.append(("WARN", f"{n} {label}{'s' if n > 1 else ''} in {z}"))

    # -- definitions ---------------------------------------------------------
    defs: dict[str, list[int]] = defaultdict(list)
    for i, t in enumerate(texts):
        m = DEF_HEAD.match(t.strip())
        if m:
            defs[m.group(1).strip()].append(i)
    sched_b_terms = {t for t, idx in defs.items() if any(zones[i] == "Schedule B" for i in idx)}
    for i, t in enumerate(texts):
        m = POINTER.search(t)
        if m:
            letter = m.group(2)
            head = DEF_HEAD.match(t.strip())
            term = head.group(1).strip() if head else "?"
            if letter not in schedules:
                F.append(("FAIL", f"'{term}' points to Schedule {letter}, which does not exist"))
            elif letter == "B" and term not in sched_b_terms:
                F.append(("FAIL", f"'{term}' points to Schedule B but Schedule B does not define it"))
    for term, idx in defs.items():
        base = re.sub(r"\(s\)$", "", term).strip()
        n = len(re.findall(r"(?<![A-Za-z])" + re.escape(base) + r"(?![a-z])", full))
        if n <= len(idx):
            F.append(("WARN", f"orphan definition: '{term}' is defined but used nowhere else"))
    for i, t in enumerate(texts):
        if MALFORMED.search(t):
            F.append(("WARN", f"malformed wording in {zones[i]}: …{MALFORMED.search(t).group(0)}… ({t[:60]!r})"))
    stems = Counter()
    for t in texts:
        if re.search(r"shall have the meaning ascribed thereto", t): stems["shall have"] += 1
        if re.search(r"shall bear the meaning", t): stems["shall bear"] += 1
    if stems["shall bear"] and stems["shall have"]:
        F.append(("WARN", f"two cross-reference formulae in use: {stems['shall have']} 'shall have', "
                          f"{stems['shall bear']} 'shall bear'"))

    # -- references ----------------------------------------------------------
    for i, t in enumerate(texts):
        for letter in set(SCHED_REF.findall(t)):
            if letter not in schedules:
                F.append(("FAIL", f"reference to Schedule {letter} in {zones[i]}, which does not exist"))
        for n in set(ARTICLE_REF.findall(t)):
            if not 1 <= int(n) <= articles:
                F.append(("FAIL", f"reference to Article {n} in {zones[i]}, but the body has {articles} articles"))
        for n in set(SECTION_REF.findall(t)):
            if not 1 <= int(n) <= articles:
                F.append(("FAIL", f"reference to Section {n}.x in {zones[i]}, but the body has {articles} articles"))

    # -- truncation, balance, number-word agreement --------------------------
    for i, (p, t) in enumerate(zip(paras, texts)):
        s = t.strip()
        st = para_style(p) or ""
        if len(s) < 40 or st.startswith(("Heading", "toc", "Title")):
            continue
        # cover lines and execution blocks are labels, not clauses
        if zones[i] in ("Preamble", "Signature Page") and len(s.split()) < 14:
            continue
        if s[-1] not in TERMINAL and not re.search(r"\b(and|or)$", s):
            F.append(("WARN", f"no terminal punctuation in {zones[i]}: …{s[-60:]!r}"))
        m = DANGLING.search(s)
        if m and not re.search(r";\s*(and|or)$", s):
            F.append(("WARN", f"clause ends on '{m.group(1)}' in {zones[i]}: …{s[-60:]!r}"))
        for o, c in (("(", ")"), ("[", "]"), ("“", "”")):
            if s.count(o) != s.count(c):
                F.append(("WARN", f"unbalanced {o}{c} in {zones[i]}: {s[:70]!r}"))
        for word, num in NUM_WORD.findall(s):
            w = word.lower().replace("-", " ").strip()
            if w in _WORDS and _WORDS[w] != int(num):
                F.append(("WARN", f"number-word mismatch in {zones[i]}: '{word} ({num})'"))
            elif w not in _WORDS and " " in w and w.split()[-1] in _WORDS and _WORDS[w.split()[-1]] != int(num):
                F.append(("WARN", f"number-word mismatch in {zones[i]}: '{word} ({num})'"))

    # -- footnotes, revisions, fields ----------------------------------------
    if pkg.has("word/footnotes.xml"):
        fn = pkg.xml("word/footnotes.xml")
        internal = [" ".join((x.text or "") for x in e.iter(q("t"))).strip()
                    for e in fn.findall(q("footnote")) if e.get(q("type")) is None]
        internal = [x for x in internal if INTERNAL_NOTE.search(x) and "Conditional Amendment" not in x]
        if internal:
            F.append(("WARN", f"{len(internal)} internal drafting notes remain in the footnotes, e.g. {internal[0][:60]!r}"))
    ins, dele = len(list(doc.iter(q("ins")))), len(list(doc.iter(q("del"))))
    if ins or dele:
        F.append(("WARN", f"{ins} tracked insertions and {dele} tracked deletions are unresolved"))
    settings = pkg.raw("word/settings.xml").decode("utf-8", "ignore")
    if "updateFields" not in settings:
        F.append(("WARN", "updateFields is not set; the table of contents will open stale"))

    # -- geometry vs baseline ------------------------------------------------
    if baseline:
        from baseline_template import geometry
        g = geometry(pkg)
        for k, v in baseline.get("geometry", {}).items():
            if g.get(k) != v:
                F.append(("FAIL", f"format drift: {k} is {g.get(k)} but the master has {v}"))
        known = set(baseline.get("known_findings", []))
        F = [(l, m) for l, m in F if f"{l}: {m}" not in known]
    return F


# ---------------------------------------------------------------- diff proof

def compare(draft: Package, master: Package) -> list[tuple[str, str]]:
    F: list[tuple[str, str]] = []
    for part in ("word/numbering.xml", "word/styles.xml"):
        if draft.raw(part) != master.raw(part):
            F.append(("FAIL", f"{part} is not byte-identical to the master"))
    allowed = {"word/document.xml", "word/footnotes.xml", "word/settings.xml", "docProps/core.xml"}
    for n in master.names():
        if n in allowed:
            continue
        if not draft.has(n):
            F.append(("FAIL", f"part missing from draft: {n}"))
        elif draft.raw(n) != master.raw(n):
            F.append(("FAIL", f"part changed that the build never touches: {n}"))
    dp, mp = list(iter_paragraphs(draft.document())), list(iter_paragraphs(master.document()))
    if len(dp) != len(mp):
        F.append(("FAIL", f"paragraph count changed: master {len(mp)}, draft {len(dp)}"))
        return F
    changed = 0
    for i, (a, b) in enumerate(zip(dp, mp)):
        ta, tb = para_text(a), para_text(b)
        if ta == tb:
            continue
        changed += 1
        # the cover date is a run of underscores rather than a bracket token
        had_placeholder = any(True for _ in scan_brackets(b)) or re.search(r"_{5,}", tb)
        if not had_placeholder:
            F.append(("FAIL", f"paragraph {i} changed but the master had no placeholder there: {tb[:70]!r}"))
    F.append(("INFO", f"{changed} paragraph(s) differ from the master, all at placeholders" if not any(l == "FAIL" and "paragraph" in m for l, m in F) else f"{changed} paragraph(s) differ from the master"))
    for tag in ("tbl", "ins", "del", "bookmarkStart"):
        a, b = len(list(draft.document().iter(q(tag)))), len(list(master.document().iter(q(tag))))
        if tag in ("ins", "del") and a > b:
            F.append(("FAIL", f"new tracked changes introduced: {tag} {b} -> {a}"))
        elif tag not in ("ins", "del") and a != b:
            F.append(("FAIL", f"{tag} count changed: {b} -> {a}"))
    return F


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("draft")
    ap.add_argument("--against", help="the master template, for the change proof")
    ap.add_argument("--baseline", help="baseline.json from baseline_template.py")
    args = ap.parse_args()

    pkg = Package(args.draft)
    baseline = json.loads(Path(args.baseline).read_text()) if args.baseline else None
    findings = []
    if args.against:
        findings += compare(pkg, Package(args.against))
    findings += audit_findings(pkg, baseline)

    order = {"FAIL": 0, "WARN": 1, "INFO": 2}
    findings.sort(key=lambda f: order[f[0]])
    for lvl, msg in findings:
        print(f"{lvl:5} {msg}")
    fails = sum(1 for l, _ in findings if l == "FAIL")
    warns = sum(1 for l, _ in findings if l == "WARN")
    print(f"\n{fails} FAIL, {warns} WARN")
    if fails:
        print("DO NOT hand this file over until every FAIL is resolved.")
        sys.exit(1)


if __name__ == "__main__":
    main()
