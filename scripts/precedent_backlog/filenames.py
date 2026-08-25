"""Filename cleanup, draft-version grouping, and format-pair handling.

The backlog folders mix numbering prefixes, Word lock files, dates in a
handful of different formats, draft/final/execution markers, and — a real
trap — amendment numbering that looks like version noise but isn't:
"EPC Amendment Agreement -02" and "Amendment 03 of EPC Contract" are two
separate signed instruments, not two drafts of the same one. Everything
here is built around keeping that distinction correct.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from dateutil import parser as dateparser

NUMBERING_PREFIX = re.compile(r"^\s*\d+\s*[.)-]\s*")

# Words that mark a *version* of the same document — safe to strip when
# computing a document's identity for grouping. "amendment" is deliberately
# absent: it marks a different document, not a newer draft of this one.
VERSION_WORDS = [
    "execution version", "execution draft", "final draft", "first draft",
    "draft", "final", "revised", "clean", "redline", "signed version",
    "signed", "v1", "v2", "v3",
]

# Bracketed/parenthetical annotations, e.g. "[Final Draft]", "[AKLA]",
# "(1)" — stripped wholesale since they're almost always version/copy
# noise, not part of the document's identity.
BRACKETED = re.compile(r"[\[(][^\])]*[\])]")

COPY_SUFFIX = re.compile(r"\s*-\s*copy\s*$", re.IGNORECASE)

# Ranked so a higher-signal marker always outranks a lower one regardless
# of which file (docx or pdf) it appears on — this is what lets a signed
# PDF outrank an unsigned docx twin, not just format preference.
KEYWORD_RANK = [
    ("execution version", 5), ("execution draft", 4), ("signed version", 5),
    ("signed", 5), ("final draft", 3), ("final", 3), ("first draft", 1),
    ("draft", 1), ("revised", 2), ("clean", 2), ("redline", 1),
]


def is_lock_file(filename: str) -> bool:
    return filename.startswith("~$")


def is_supported(filename: str) -> bool:
    return filename.lower().rsplit(".", 1)[-1] in {"docx", "pdf", "xlsx", "xls"}


def strip_numbering(stem: str) -> str:
    return NUMBERING_PREFIX.sub("", stem).strip()


# Explicit date-shaped substrings only — dateutil's fuzzy mode was tried
# first and rejected: verified against real filenames, it hallucinated
# dates out of "(1)" and "Amendment -02" (no date present at all), and
# separately got the YEAR wrong on real dates ("[November 11, 2021]"
# parsed as 2026 — it silently defaults missing/unmatched components to
# *today's* date rather than failing, so a fuzzy partial match on "November
# 11" with "2021" discarded as an unmatched token produced today's year).
# Requiring day+month+year together in one matched substring, then parsing
# only that substring non-fuzzy, avoids both failure modes.
_MONTH = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
DATE_PATTERNS = [
    re.compile(rf"\b{_MONTH}\.?\s+\d{{1,2}},?\s+\d{{4}}\b", re.IGNORECASE),  # April 10, 2017
    re.compile(rf"\b\d{{1,2}}\s+{_MONTH}\.?,?\s+\d{{4}}\b", re.IGNORECASE),  # 10 April 2017
    re.compile(r"\b\d{4}-\d{1,2}-\d{1,2}\b"),                               # 2017-04-10
    re.compile(r"\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b"),                         # 10-04-2017 / 10/04/2017
]
# 27072023 (DDMMYYYY, no separators) — dateutil can't reliably tokenize an
# unseparated 8-digit run (confirmed: raises "month must be in 1..12" on
# this exact string), so day/month/year are pulled from regex groups
# directly instead of re-parsing the matched text.
DDMMYYYY = re.compile(r"\b(\d{2})(0[1-9]|1[0-2])(\d{4})\b")


def extract_date(text: str):
    """Finds the first explicit day+month+year substring and parses only
    that (non-fuzzy) — returns None rather than guess if nothing matches."""
    for pattern in DATE_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        try:
            return dateparser.parse(match.group(0), dayfirst=True, fuzzy=False).date()
        except (ValueError, OverflowError):
            continue

    match = DDMMYYYY.search(text)
    if match:
        day, month, year = match.groups()
        try:
            import datetime
            return datetime.date(int(year), int(month), int(day))
        except ValueError:
            pass
    return None


def keyword_rank(text: str) -> int:
    lowered = text.lower()
    return max((rank for phrase, rank in KEYWORD_RANK if phrase in lowered), default=0)


def group_key(stem: str) -> str:
    """Normalizes a (numbering-stripped) filename stem to a stable key so
    drafts of the same document collapse together. Amendment numbering is
    deliberately left untouched — see module docstring."""
    text = BRACKETED.sub(" ", stem)
    text = COPY_SUFFIX.sub("", text)
    lowered = text.lower()
    for word in VERSION_WORDS:
        lowered = lowered.replace(word, " ")
    # Collapse a trailing bare date (already covered by BRACKETED for the
    # common "[Month DD, YYYY]" case, but some filenames embed one
    # unbracketed, e.g. "O&G DCA - April 10, 2017").
    lowered = re.sub(
        r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b",
        " ", lowered,
    )
    lowered = re.sub(r"\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b", " ", lowered)
    lowered = DDMMYYYY.sub(" ", lowered)  # e.g. "27072023" — see extract_date
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered).strip()
    return lowered


@dataclass
class Candidate:
    path: str
    folder: str
    filename: str
    stem: str  # numbering-stripped, extension-stripped
    ext: str
    mtime: float
    group_key: str
    date: object = None
    kw_rank: int = 0
    format_bonus: int = 0

    def sort_score(self):
        date_epoch = self.date.toordinal() if self.date else -1
        return (date_epoch, self.kw_rank, self.format_bonus, self.mtime)


def build_candidate(path: str) -> Candidate:
    folder = os.path.dirname(path)
    filename = os.path.basename(path)
    stem, ext = os.path.splitext(filename)
    stem = strip_numbering(stem)
    ext = ext.lower().lstrip(".")
    key = group_key(stem)
    return Candidate(
        path=path,
        folder=folder,
        filename=filename,
        stem=stem,
        ext=ext,
        mtime=os.path.getmtime(path),
        group_key=key,
        date=extract_date(stem),
        kw_rank=keyword_rank(stem),
        format_bonus=1 if ext == "docx" else 0,
    )


def group_candidates(candidates: list[Candidate]) -> dict[tuple, list[Candidate]]:
    """Groups by (folder, group_key) — grouping only within the same
    folder avoids accidentally merging same-named documents that belong
    to different clients/matters."""
    groups: dict[tuple, list[Candidate]] = {}
    for c in candidates:
        groups.setdefault((c.folder, c.group_key), []).append(c)
    return groups


def resolve_group(group: list[Candidate]) -> tuple[Candidate, list[Candidate]]:
    """Returns (winner, superseded) for one group, ranked highest-first."""
    ranked = sorted(group, key=lambda c: c.sort_score(), reverse=True)
    return ranked[0], ranked[1:]
