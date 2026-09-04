#!/usr/bin/env python3
"""Add the firm's own curated statute PDFs from the Passport drive to the law
library.

Much of what this firm actually relies on is not primary federal legislation
and never appears on pakistancode.gov.pk: the NEPRA licensing, trader,
supplier and wheeling Regulations, the Grid and Distribution Codes, the Market
Commercial Code, the National Electricity Policy and Plan, the STZA and EPZA
rules and guidelines, provincial PPP policy and toolkits. The firm already
holds clean, authoritative PDFs of all of it in its own "Laws", "STZ Law",
"EPZ Law", "SEZ Law" and "Mining Laws" folders — which is a better source than
anything a scraper would find.

This walks those folders, derives an Act name from each filename, extracts the
text (falling back to the OCR service for scans), runs the same
assess_extraction() identity/coherence check the scraper uses, and writes
`pending_ingest` rows into the same manifest scrape.py uses — so `scrape.py
--confirm` ingests them through exactly one code path.

    python3 drive_laws.py --scan          # find, extract, check — no writes
    python3 drive_laws.py --scan --root "/Volumes/My Passport/AY - AKLA"
    python3 scrape.py --confirm           # then ingest as usual
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent))
from scrape import MANIFEST_PATH, MIN_TEXT_LENGTH, assess_extraction, extract_pdf_text, save_manifest  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent.parent / "precedent_backlog"))
from supabase_io import SupabaseClient  # noqa: E402

SCRIPT_DIR = Path(__file__).parent.resolve()
DEFAULT_ROOT = "/Volumes/My Passport"

# Folders whose contents are statute/regulatory material rather than the
# firm's own drafting. Matched case-insensitively against the folder name.
LAW_FOLDER_PATTERNS = [
    r"^laws?$",
    r"^\d+\.\s*laws?$",
    r"laws?\s*(,|&|and)",              # "Laws, Rules, Regulations, Caselaw"
    r"laws?\s+as\s+applicable",
    r"laws?\s+applicable",
    r"\bsez\s+law\b",
    r"\bstz\s+law\b",
    r"\bepz\s+law\b",
    r"mining\s+laws?",
    r"ppp\s+laws?",
    r"law\s*&\s*internal\s+note",
]

# Case law is precedent of a different kind — judgments, not statute text —
# and would pollute statute retrieval, so it stays out of the law library.
EXCLUDE_FOLDER_PATTERNS = [r"case\s*laws?"]

# Filenames that are the firm's own work product rather than a law.
EXCLUDE_FILE_PATTERNS = [
    r"\[AKLA\]", r"\bdraft\b", r"internal note", r"\bmemo(randum)? on\b",
    r"\breport\b", r"\bnotes?\b", r"due diligence", r"\bopinion\b",
    r"meeting", r"\bcv\b", r"proposal",
]

# Leading catalogue numbering the firm uses: "1. ", "C11 - ", "4.  ".
LEADING_INDEX = re.compile(r"^\s*(?:[A-Z]?\d+\s*[.\-–)]\s*)+", re.I)


def looks_like_law_folder(folder: str) -> bool:
    if any(re.search(p, folder, re.I) for p in EXCLUDE_FOLDER_PATTERNS):
        return False
    return any(re.search(p, folder, re.I) for p in LAW_FOLDER_PATTERNS)


def looks_like_firm_work(filename: str) -> bool:
    return any(re.search(p, filename, re.I) for p in EXCLUDE_FILE_PATTERNS)


def act_name_from_filename(filename: str) -> str:
    """"C11 - NEPRA Act 1997.pdf" -> "NEPRA Act 1997". Keeps the firm's own
    wording otherwise: these are the names its lawyers actually use, and
    act_name is the key matters and retrieval join on."""
    stem = Path(filename).stem
    stem = LEADING_INDEX.sub("", stem)
    stem = re.sub(r"\s*\[[^\]]*\]", "", stem)          # strip [Clean], [March 2, 2026]
    stem = re.sub(r"[_]+", " ", stem)
    stem = re.sub(r"\s{2,}", " ", stem).strip(" -–—.")
    return stem.strip()


def main() -> int:
    load_dotenv(SCRIPT_DIR / ".env")
    parser = argparse.ArgumentParser(description="Add the firm's own statute PDFs to the law library")
    parser.add_argument("--scan", action="store_true", required=True, help="Find, extract and check — writes no Supabase data")
    parser.add_argument("--root", default=DEFAULT_ROOT, help="Drive root to walk")
    parser.add_argument("--limit", type=int, default=0, help="Stop after this many files (for a quick look)")
    parser.add_argument("--list-only", action="store_true", help="Just list what would be picked up")
    args = parser.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        sys.exit(f"Not a directory: {root}")

    candidates: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(("$", ".")) and d != "System Volume Information"]
        folder = Path(dirpath).name
        if not looks_like_law_folder(folder):
            continue
        for fn in filenames:
            if not fn.lower().endswith(".pdf") or fn.startswith("~$"):
                continue
            if looks_like_firm_work(fn):
                continue
            candidates.append(Path(dirpath) / fn)

    print(f"{len(candidates)} statute-looking PDF(s) in law folders under {root}\n")
    if args.list_only:
        for p in sorted(candidates):
            print(f"  {act_name_from_filename(p.name)}")
            print(f"      {p.parent.name}/{p.name}")
        return 0

    manifest = json.loads(MANIFEST_PATH.read_text()) if MANIFEST_PATH.exists() else {}
    existing_titles = {
        (row.get("title") or name).strip().lower(): name
        for name, row in manifest.items()
        if row.get("outcome") in ("pending_ingest", "ingested")
    }

    sb = None
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if url and key:
        sb = SupabaseClient(
            url, key,
            os.environ.get("SUPABASE_SESSION_EMAIL"), os.environ.get("SUPABASE_SESSION_PASSWORD"),
            ocr_service_url=os.environ.get("OCR_SERVICE_URL"),
            ocr_service_secret=os.environ.get("OCR_SERVICE_SECRET"),
        )

    added = skipped = failed = 0
    for i, path in enumerate(sorted(candidates), 1):
        if args.limit and added >= args.limit:
            break
        name = act_name_from_filename(path.name)
        if not name:
            continue
        if name in manifest and manifest[name].get("outcome") in ("pending_ingest", "ingested"):
            skipped += 1
            continue
        if name.strip().lower() in existing_titles:
            print(f"[{i}/{len(candidates)}] already held: {name}")
            skipped += 1
            continue

        print(f"[{i}/{len(candidates)}] {name}")
        try:
            text = extract_pdf_text(path)
            needs_ocr = len(text.strip()) < MIN_TEXT_LENGTH
            if needs_ocr:
                if not (sb and sb.ocr_configured):
                    print("    no text layer and OCR not configured — skipping")
                    manifest[name] = {"outcome": "failed", "error": "no text layer, OCR unavailable",
                                      "pdf_path": str(path), "source": "firm drive"}
                    save_manifest(manifest)
                    failed += 1
                    continue
                print("    no text layer — running OCR (can take a while)...")
                text = sb.ocr_pdf(path.read_bytes())
                needs_ocr = False

            ai_check = assess_extraction(name, text)
            manifest[name] = {
                "outcome": "pending_ingest",
                "title": name,
                # Provenance: this came off the firm's own drive, not a public
                # site, so there is no page to link back to.
                "page_url": f"file://{path}",
                "pdf_url": f"file://{path}",
                "source": "firm drive (My Passport)",
                "pdf_path": str(path),
                "needs_ocr": False,
                "text_length": len(text),
                "ai_check": ai_check,
                "found_at": datetime.now(timezone.utc).isoformat(),
            }
            flag = f"  [AI FLAG: {ai_check['note']}]" if ai_check and not ai_check["ok"] else ""
            print(f"    {len(text)} chars extracted{flag}")
            added += 1
        except Exception as err:  # noqa: BLE001 — one bad PDF shouldn't end the walk
            manifest[name] = {"outcome": "failed", "error": str(err), "pdf_path": str(path),
                              "source": "firm drive (My Passport)"}
            failed += 1
            print(f"    FAILED: {err}", file=sys.stderr)
        save_manifest(manifest)

    print(f"\n{added} queued, {skipped} already held, {failed} failed.")
    print("Review above, then: python3 scrape.py --confirm   (add --include-flagged to ingest AI-flagged ones)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
