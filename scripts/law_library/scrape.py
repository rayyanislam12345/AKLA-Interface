#!/usr/bin/env python3
"""Scrapes named Acts from pakistancode.gov.pk (the Ministry of Law and
Justice's official legislation site), extracts their text (OCR fallback for
any that turn out to be scanned rather than born-digital), and — only once
you re-run with --confirm after reviewing the report — ingests them into the
app's RAG store, tagged is_statute so they stay distinguishable from the
firm's own precedent documents in retrieval.

Mirrors precedent_backlog's dry-run-first shape on purpose: real legal text
going into a live system shouldn't get ingested without a review step.

    python3 scrape.py --scan
    python3 scrape.py --scan --confirm
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR.parent / "precedent_backlog"))
from supabase_io import SupabaseClient  # noqa: E402

DOWNLOADS_DIR = SCRIPT_DIR / "downloads"
MANIFEST_PATH = SCRIPT_DIR / "manifest.json"

BASE_URL = "https://pakistancode.gov.pk/english"
SEARCH_URL = f"{BASE_URL}/sHyuRsF"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AKLA-law-library-bot"}

# The major Acts a commercial/infrastructure practice actually needs day to
# day — not the whole Pakistan Code (thousands of Acts, most irrelevant).
# Broadened from the original 5-Act first pass once that batch checked out.
# Already-resolved names are skipped automatically on re-scan (see scan()),
# so it's safe to keep extending this list and re-running.
TARGET_ACTS = [
    # Contract / commercial fundamentals
    "Contract Act, 1872",
    "Sale of Goods Act, 1930",
    "Partnership Act, 1932",
    "Negotiable Instruments Act, 1881",
    "Specific Relief Act, 1877",
    "Limitation Act, 1908",
    "Carriage of Goods by Sea Act, 1925",
    # Corporate / securities
    "Companies Act, 2017",
    "Securities Act, 2015",
    "Securities and Exchange Commission of Pakistan Act, 1997",
    "Trade Organizations Act, 2013",
    "Competition Act, 2010",
    "Corporate Rehabilitation Act, 2018",
    # Banking / finance
    "Banking Companies Ordinance, 1962",
    "State Bank of Pakistan Act, 1956",
    "Financial Institutions (Recovery of Finances) Ordinance, 2001",
    # Arbitration / dispute resolution / procedure
    "Arbitration Act, 1940",
    "Recognition and Enforcement (Arbitration Agreements and Foreign Arbitral Awards) Act, 2011",
    "Code of Civil Procedure, 1908",
    "Qanun-e-Shahadat Order, 1984",
    # Property / land / registration
    "Transfer of Property Act, 1882",
    "Registration Act, 1908",
    "Land Acquisition Act, 1894",
    "Stamp Act, 1899",
    "Easements Act, 1882",
    # Tax
    "Income Tax Ordinance, 2001",
    "Sales Tax Act, 1990",
    # Labor / employment
    "Industrial Relations Act, 2012",
    "Factories Act, 1934",
    "Employees Old-Age Benefits Act, 1976",
    "Workmen's Compensation Act, 1923",
    # Intellectual property
    "Copyright Ordinance, 1962",
    "Trade Marks Ordinance, 2001",
    "Patents Ordinance, 2000",
    # Energy / infrastructure / PPP / environment — matches this firm's
    # actual practice area most directly
    "Public Private Partnership Authority Act, 2017",
    "Regulation of Generation, Transmission and Distribution of Electric Power Act, 1997",
    "Oil and Gas Regulatory Authority Ordinance, 2002",
    "Pakistan Environmental Protection Act, 1997",
    "Foreign Private Investment (Promotion and Protection) Act, 1976",
    "Foreign Exchange Regulation Act, 1947",
    # Second pass — broadened further per "as much as possible": more of
    # the same categories, plus a few (insurance, procurement, AML,
    # electronic transactions) that came up short the first time round.
    "Insurance Ordinance, 2000",
    "Payment Systems and Electronic Fund Transfers Act, 2007",
    "Anti-Money Laundering Act, 2010",
    "Public Procurement Regulatory Authority Ordinance, 2002",
    "Protection of Economic Reforms Act, 1992",
    "Alternative Dispute Resolution Act, 2017",
    "Electricity Act, 1910",
    "Customs Act, 1969",
    "Federal Excise Act, 2005",
    "Trusts Act, 1882",
    "Societies Registration Act, 1860",
    "Electronic Transactions Ordinance, 2002",
]

# A handful of the first-pass Acts came back not_found under their formal
# citation but are real, findable Acts under a shorter/more common name —
# the site's search wants bare significant words and sometimes just doesn't
# rank the formal title well. Tried in order after the primary name fails.
SEARCH_ALIASES: dict[str, list[str]] = {
    "Securities Act, 2015": ["Securities Act"],
    "Corporate Rehabilitation Act, 2018": ["Corporate Rehabilitation"],
    "Financial Institutions (Recovery of Finances) Ordinance, 2001": [
        "Recovery of Finances Ordinance",
        "Financial Institutions Recovery Finances",
    ],
    "Recognition and Enforcement (Arbitration Agreements and Foreign Arbitral Awards) Act, 2011": [
        "Arbitration Agreements and Foreign Arbitral Awards",
        "Recognition Enforcement Arbitration Agreements",
    ],
    "Qanun-e-Shahadat Order, 1984": ["Qanun e Shahadat", "Evidence Order 1984", "Shahadat Order"],
    "Sales Tax Act, 1990": ["Sales Tax Act", "Sales Tax"],
    "Copyright Ordinance, 1962": ["Copyright Ordinance", "Copyright Act"],
    "Public Private Partnership Authority Act, 2017": [
        "Public Private Partnership Authority",
        "PPP Authority Act",
    ],
    "Regulation of Generation, Transmission and Distribution of Electric Power Act, 1997": [
        "NEPRA Act",
        "National Electric Power Regulatory Authority",
        "Electric Power Act 1997",
    ],
    "Foreign Exchange Regulation Act, 1947": ["Foreign Exchange Regulation Act", "Foreign Exchange Regulation"],
}

# Minimum extracted-character count before treating a PDF as having a real
# text layer — matches the same threshold extractText.ts uses to decide a
# PDF needs OCR (see supabase/functions/_shared/extractText.ts).
MIN_TEXT_LENGTH = 20


def _get(url: str, **kwargs) -> requests.Response:
    resp = requests.get(url, headers=HEADERS, timeout=30, **kwargs)
    resp.raise_for_status()
    return resp


def search_act(name: str) -> dict | None:
    """Searches pakistancode.gov.pk for an Act by name and returns the best
    match's {title, page_url, pdf_url}, or None if nothing usable was found.
    The search results page itself doesn't carry the PDF link — each result
    has to be visited to find its `pdffiles/*.pdf` link and confirm the
    <h2> title actually matches what we searched for."""
    # Confirmed in practice: a comma in the query (as in a formal cite like
    # "Contract Act, 1872") makes the site's search return zero results —
    # it wants bare words only.
    query = re.sub(r"[^\w\s]", " ", name)
    resp = _get(SEARCH_URL, params={"query": query, "search": 1})
    result_links = sorted(set(re.findall(r'href="(https?://pakistancode\.gov\.pk/english/[^"]*-con-\d+-sg-[^"]*)"', resp.text)))

    for link in result_links[:10]:
        try:
            page = _get(link)
        except requests.exceptions.RequestException:
            continue
        title_match = re.search(r"<h2>([^<]+)", page.text)
        title = title_match.group(1).strip() if title_match else None
        pdf_match = re.search(r'href="(https://pakistancode\.gov\.pk/pdffiles/[^"]+\.pdf)"', page.text)
        if not pdf_match:
            continue
        # Loose match: the searched name's significant words should all
        # appear in the result title — good enough to reject an obviously
        # unrelated Act without needing exact-string equality (titles carry
        # inconsistent spacing/punctuation across the site).
        name_words = [w.lower() for w in re.findall(r"[A-Za-z]+", name) if len(w) > 2]
        title_lower = (title or "").lower()
        if title and all(w in title_lower for w in name_words):
            return {"title": title, "page_url": link, "pdf_url": pdf_match.group(1)}

    return None


def extract_pdf_text(pdf_path: Path) -> str:
    import pdfplumber

    text_parts = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text_parts.append(page.extract_text() or "")
    return "\n".join(text_parts)


def scan(manifest: dict) -> dict:
    DOWNLOADS_DIR.mkdir(exist_ok=True)

    for name in TARGET_ACTS:
        if name in manifest and manifest[name].get("outcome") in ("pending_ingest", "ingested"):
            print(f"Already resolved, skipping: {name}")
            continue

        print(f"Searching: {name}")
        found = None
        for query_name in [name, *SEARCH_ALIASES.get(name, [])]:
            try:
                found = search_act(query_name)
            except requests.exceptions.RequestException as err:
                manifest[name] = {"outcome": "failed", "error": f"Search failed: {err}"}
                print(f"  FAILED (search): {err}", file=sys.stderr)
                save_manifest(manifest)
                found = None
                break
            if found:
                if query_name != name:
                    print(f"  (found via alias query: {query_name!r})")
                break
        if name in manifest and manifest[name].get("outcome") == "failed":
            continue

        if not found:
            manifest[name] = {"outcome": "not_found"}
            print(f"  Not found on pakistancode.gov.pk")
            save_manifest(manifest)
            continue

        pdf_path = DOWNLOADS_DIR / (re.sub(r"[^a-zA-Z0-9 ._-]", "_", found["title"])[:150] + ".pdf")
        try:
            resp = _get(found["pdf_url"])
            pdf_path.write_bytes(resp.content)
        except requests.exceptions.RequestException as err:
            manifest[name] = {"outcome": "failed", "error": f"Download failed: {err}", **found}
            print(f"  FAILED (download): {err}", file=sys.stderr)
            save_manifest(manifest)
            continue

        text = extract_pdf_text(pdf_path)
        needs_ocr = len(text.strip()) < MIN_TEXT_LENGTH

        manifest[name] = {
            "outcome": "pending_ingest",
            "title": found["title"],
            "page_url": found["page_url"],
            "pdf_url": found["pdf_url"],
            "pdf_path": str(pdf_path),
            "needs_ocr": needs_ocr,
            "text_length": len(text) if not needs_ocr else None,
        }
        print(f"  Found: {found['title']} ({'needs OCR' if needs_ocr else f'{len(text)} chars extracted'})")
        # Save after every act (not batched) — a scan over dozens of Acts
        # hitting a real network could be interrupted partway, and nothing
        # already-found should be silently lost on the next attempt.
        save_manifest(manifest)
    print(f"\n=== Report ===")
    for name, row in manifest.items():
        print(f"  {name}: {row['outcome']}" + (" (needs OCR)" if row.get("needs_ocr") else ""))
    print(f"\nReview above, then re-run with --confirm to ingest.")
    return manifest


def confirm(manifest: dict, sb: SupabaseClient):
    pending = [(name, row) for name, row in manifest.items() if row.get("outcome") == "pending_ingest"]
    print(f"{len(pending)} act(s) to ingest")

    for name, row in pending:
        try:
            pdf_path = Path(row["pdf_path"])
            if row.get("needs_ocr"):
                if not sb.ocr_configured:
                    raise RuntimeError("Act needs OCR but OCR_SERVICE_URL/OCR_SERVICE_SECRET not set")
                print(f"  {name}: running OCR (can take a while for a long Act)...")
                text = sb.ocr_pdf(pdf_path.read_bytes())
            else:
                text = extract_pdf_text(pdf_path)

            sb.ingest_document_text(
                text,
                is_statute=True,
                metadata={
                    "act_name": row["title"],
                    "source": "pakistancode.gov.pk",
                    "source_url": row["page_url"],
                    "pdf_url": row["pdf_url"],
                    "scraped_at": datetime.now(timezone.utc).isoformat(),
                    "ocr": bool(row.get("needs_ocr")),
                },
            )
            row["outcome"] = "ingested"
            manifest[name] = row
            save_manifest(manifest)
            print(f"  Ingested: {name}")
        except Exception as err:
            row["outcome"] = "failed"
            row["error"] = str(err)
            manifest[name] = row
            save_manifest(manifest)
            print(f"  FAILED: {name}: {err}", file=sys.stderr)


def save_manifest(manifest: dict):
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, default=str))


def main():
    load_dotenv(SCRIPT_DIR / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan", action="store_true", help="Search, download, and extract text — no Supabase writes")
    parser.add_argument("--confirm", action="store_true", help="Ingest whatever --scan found into the RAG store")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text()) if MANIFEST_PATH.exists() else {}

    if not args.scan and not args.confirm:
        sys.exit("Pass --scan (dry run) and/or --confirm (ingest)")

    if args.scan:
        manifest = scan(manifest)

    if args.confirm:
        supabase_url = os.environ.get("SUPABASE_URL")
        service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        session_email = os.environ.get("SUPABASE_SESSION_EMAIL")
        session_password = os.environ.get("SUPABASE_SESSION_PASSWORD")
        if not (supabase_url and service_role_key and session_email and session_password):
            sys.exit("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SESSION_EMAIL, SUPABASE_SESSION_PASSWORD must be set in .env")
        sb = SupabaseClient(
            supabase_url, service_role_key, session_email, session_password,
            ocr_service_url=os.environ.get("OCR_SERVICE_URL"),
            ocr_service_secret=os.environ.get("OCR_SERVICE_SECRET"),
        )
        confirm(manifest, sb)


if __name__ == "__main__":
    main()
