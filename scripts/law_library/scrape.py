#!/usr/bin/env python3
"""Scrapes named Acts from pakistancode.gov.pk (the Ministry of Law and
Justice's official legislation site), extracts their text (OCR fallback for
any that turn out to be scanned rather than born-digital), and — only once
you re-run with --confirm after reviewing the report — ingests them into the
app's RAG store, tagged is_statute so they stay distinguishable from the
firm's own precedent documents in retrieval.

Mirrors precedent_backlog's dry-run-first shape on purpose: real legal text
going into a live system shouldn't get ingested without a review step.

Two small, cheap Claude Haiku calls (see _ai_call) plug the gaps plain regex
can't cover, at exactly the two points where this scraper was silently
weak: (1) search_act's word-containment match can't tell a principal Act
apart from an amendment Act or a repealed older version that happens to
share the same title words — ambiguous cases get an AI pick instead of
just taking the first regex match; (2) MIN_TEXT_LENGTH only catches a PDF
producing near-zero text, not one that extracted plenty of *garbled* text
(jumbled multi-column order, OCR noise) or the wrong Act's text entirely —
assess_extraction spot-checks coherence and identity before an Act is
allowed to reach pending_ingest. Neither call ever rewrites the extracted
text itself — verbatim legal text is what goes into the RAG store either
way; AI here only judges/selects, never edits.

    python3 scrape.py --scan
    python3 scrape.py --scan --confirm
    python3 scrape.py --confirm --include-flagged   # ingest AI-flagged Acts anyway
    python3 scrape.py --verify-existing             # spot-check what's already live
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


AI_MODEL = "claude-haiku-4-5-20251001"


def _ai_call(system: str, user: str, max_tokens: int = 200) -> str | None:
    """Small, cheap Claude Haiku call. Returns None (never raises) if the
    key is missing or the request fails, so a hiccup here degrades to the
    old regex-only behavior — search/extraction still work, just without
    the extra check — rather than crashing a scan over one bad call."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": AI_MODEL,
                "max_tokens": max_tokens,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    except requests.exceptions.RequestException as err:
        print(f"  (AI check failed, continuing without it: {err})", file=sys.stderr)
        return None


def _ai_pick_candidate(name: str, candidates: list[dict]) -> dict | None:
    """Used only when more than one search result contains all of the
    target Act's significant words — regex can't tell a principal Act
    apart from its own amendment Act(s) or an older repealed version that
    shares the same core title. Asks Haiku to pick the one result that
    actually IS the named Act."""
    listing = "\n".join(f"{i}: {c['title']}" for i, c in enumerate(candidates))
    reply = _ai_call(
        system=(
            "You are matching a Pakistani statute name to the correct result from an "
            "official legislation database. Multiple candidates below share the same core "
            "title words — likely a mix of the principal Act, one or more amendment Acts, "
            "and/or an older repealed version. Pick the ONE result that IS the named Act "
            "itself, not an amendment to it and not a different year's version.\n\n"
            'Respond with ONLY the candidate\'s number, or "none" if none of them is actually it.'
        ),
        user=f"Target Act: {name}\n\nCandidates:\n{listing}",
        max_tokens=20,
    )
    if reply is None:
        return None
    match = re.search(r"\d+", reply)
    if not match:
        return None
    idx = int(match.group())
    return candidates[idx] if 0 <= idx < len(candidates) else None


def assess_extraction(name: str, text: str) -> dict:
    """Cheap coherence/identity spot-check on extracted statute text.
    Catches two things MIN_TEXT_LENGTH's character count can't: (1) a PDF
    that produced plenty of text but is actually the wrong Act — a mismatch
    that slipped past search_act; (2) text that's long enough to pass but
    is garbled — jumbled multi-column reading order, OCR noise, running
    headers/footers mixed into the body — rather than coherent statute
    text. Only judges; never rewrites the text itself."""
    excerpt = text[:2500].strip()
    if not excerpt:
        return {"ok": False, "note": "No text to assess"}
    reply = _ai_call(
        system=(
            "You are sanity-checking text extracted from a PDF that is supposed to be the "
            "Pakistani statute named below. Two things could be wrong: (1) it's actually a "
            "different Act, an amendment-only Act, or a repealed prior version rather than "
            "the named Act itself; (2) the text is garbled — jumbled word/line order from a "
            "bad multi-column extraction, OCR noise, or repeated running headers/footers "
            "mixed into the body — rather than coherent readable statute text. Ignore minor "
            "OCR typos or missing diacritics; only flag genuine incoherence or a substance "
            "mismatch.\n\n"
            'Respond with EXACTLY one line: either "OK" or "PROBLEM: <short reason>".'
        ),
        user=f"Named Act: {name}\n\nExtracted text (start of document):\n{excerpt}",
        max_tokens=100,
    )
    if reply is None:
        # AI check unavailable — don't block the pipeline over it, but say so.
        return {"ok": True, "note": "AI check unavailable, unverified"}
    if reply.strip().upper().startswith("OK"):
        return {"ok": True, "note": None}
    return {"ok": False, "note": reply.strip()}


def web_search_act(name: str) -> dict | None:
    """pakistancode.gov.pk only carries FEDERAL primary legislation, and its
    own search is fragile even for that. Everything the firm actually works
    with provincially — the Sindh/Punjab/KP/Balochistan PPP and procurement
    Acts, provincial environmental and services-tax law — simply isn't there,
    and comes back 'Not found' every time.

    This is the same fallback supabase/functions/_shared/statuteResolver.ts
    already uses in the app, ported here: ask Claude with the hosted
    web_search tool to LOCATE a direct PDF of the Act's real text on any
    official source (a provincial assembly, a department, the Gazette), and
    nothing more. The text itself is still downloaded and extracted by us and
    still has to clear assess_extraction() — so a hallucinated citation or a
    summary article can't become statute text in the library.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": AI_MODEL,
                "max_tokens": 1024,
                "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 4}],
                "messages": [{
                    "role": "user",
                    "content": (
                        f'Find a direct PDF URL for the full official text of the Pakistani '
                        f'statute "{name}".\n\n'
                        "It may be provincial rather than federal — check the relevant provincial "
                        "assembly (e.g. pas.gov.pk for Sindh, pap.gov.pk for Punjab, "
                        "kp.gov.pk / kpcode.kp.gov.pk, balochistanassembly.gov.pk), the responsible "
                        "department or authority's own site, or the provincial Gazette. Federal Acts "
                        "may be on pakistancode.gov.pk or na.gov.pk.\n\n"
                        "It must link directly to a PDF (or an official full-text page) of the Act's "
                        "ACTUAL TEXT — not a summary, a news article, a law-firm commentary, or a "
                        "page that merely mentions the Act. Prefer the current consolidated version.\n\n"
                        'Respond with ONLY a JSON object, no other text: '
                        '{"found": true, "title": "<exact official title>", "pdfUrl": "<direct URL>"} '
                        '— or {"found": false} if you cannot locate the actual text.'
                    ),
                }],
            },
            timeout=180,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as err:
        print(f"  (web search failed: {err})", file=sys.stderr)
        return None

    # With a server-side tool in play, earlier text blocks are the model's own
    # search narration — the answer is the LAST text block.
    blocks = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    if not blocks:
        return None
    match = re.search(r"\{[\s\S]*\}", blocks[-1])
    if not match:
        return None
    try:
        parsed = json.loads(match.group())
    except json.JSONDecodeError:
        return None
    if not parsed.get("found") or not parsed.get("pdfUrl") or not parsed.get("title"):
        return None
    return {
        "title": parsed["title"],
        "page_url": parsed.get("sourceUrl") or parsed["pdfUrl"],
        "pdf_url": parsed["pdfUrl"],
        "via_web_search": True,
    }


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

    # Loose match: the searched name's significant words should all appear
    # in the result title — good enough to reject an obviously unrelated
    # Act without needing exact-string equality (titles carry inconsistent
    # spacing/punctuation across the site). Collects every candidate that
    # passes rather than stopping at the first, since more than one often
    # does (an Act and its own amendments frequently share every word of
    # the base title) — see _ai_pick_candidate for how ties are broken.
    name_words = [w.lower() for w in re.findall(r"[A-Za-z]+", name) if len(w) > 2]
    candidates = []
    for link in result_links[:10]:
        try:
            page = _get(link)
        except requests.exceptions.RequestException:
            continue
        title_match = re.search(r"<h2>([^<]+)", page.text)
        title = title_match.group(1).strip() if title_match else None
        pdf_match = re.search(r'href="(https://pakistancode\.gov\.pk/pdffiles/[^"]+\.pdf)"', page.text)
        if not pdf_match or not title:
            continue
        title_lower = title.lower()
        if all(w in title_lower for w in name_words):
            candidates.append({"title": title, "page_url": link, "pdf_url": pdf_match.group(1)})

    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]

    picked = _ai_pick_candidate(name, candidates)
    return picked if picked is not None else candidates[0]


def extract_pdf_text(pdf_path: Path) -> str:
    import pdfplumber

    text_parts = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text_parts.append(page.extract_text() or "")
    return "\n".join(text_parts)


def scan(manifest: dict, target_acts: list[str] | None = None) -> dict:
    DOWNLOADS_DIR.mkdir(exist_ok=True)

    for name in target_acts if target_acts is not None else TARGET_ACTS:
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
            print("  Not on pakistancode.gov.pk — searching the wider web...")
            found = web_search_act(name)
            if found:
                print(f"  Located via web search: {found['title']}")

        if not found:
            manifest[name] = {"outcome": "not_found"}
            print(f"  Not found (pakistancode or web search)")
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

        # OCR happens later (only during --confirm, since it's slow and
        # costs real service time) — nothing to assess yet for those; the
        # same check runs on the OCR'd text in confirm() below instead.
        ai_check = None
        if not needs_ocr:
            print(f"  Checking extraction quality...")
            ai_check = assess_extraction(name, text)

        manifest[name] = {
            "outcome": "pending_ingest",
            "title": found["title"],
            "page_url": found["page_url"],
            "pdf_url": found["pdf_url"],
            # Provenance travels with the row so confirm() can record where
            # this text actually came from, rather than labelling everything
            # pakistancode.gov.pk.
            "source": "ai-web-search" if found.get("via_web_search") else "pakistancode.gov.pk",
            "pdf_path": str(pdf_path),
            "needs_ocr": needs_ocr,
            "text_length": len(text) if not needs_ocr else None,
            "ai_check": ai_check,
        }
        flag = f" [AI FLAG: {ai_check['note']}]" if ai_check and not ai_check["ok"] else ""
        print(f"  Found: {found['title']} ({'needs OCR' if needs_ocr else f'{len(text)} chars extracted'}){flag}")
        # Save after every act (not batched) — a scan over dozens of Acts
        # hitting a real network could be interrupted partway, and nothing
        # already-found should be silently lost on the next attempt.
        save_manifest(manifest)
    print(f"\n=== Report ===")
    for name, row in manifest.items():
        flag = ""
        if row.get("ai_check") and not row["ai_check"]["ok"]:
            flag = f"  [AI FLAG: {row['ai_check']['note']}]"
        print(f"  {name}: {row['outcome']}" + (" (needs OCR)" if row.get("needs_ocr") else "") + flag)
    print(f"\nReview above, then re-run with --confirm to ingest. AI-flagged Acts are")
    print(f"skipped by --confirm unless you also pass --include-flagged.")
    return manifest


def confirm(manifest: dict, sb: SupabaseClient, include_flagged: bool = False):
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
                print(f"  {name}: checking extraction quality...")
                ai_check = assess_extraction(name, text)
            else:
                text = extract_pdf_text(pdf_path)
                # scan() already ran this for the non-OCR path — reuse it
                # rather than paying for a second identical AI call.
                ai_check = row.get("ai_check") or assess_extraction(name, text)

            if ai_check and not ai_check["ok"] and not include_flagged:
                row["outcome"] = "needs_review"
                row["ai_check"] = ai_check
                manifest[name] = row
                save_manifest(manifest)
                print(f"  SKIPPED (AI flagged — {ai_check['note']}); re-run with --include-flagged to ingest anyway: {name}")
                continue

            sb.ingest_document_text(
                text,
                is_statute=True,
                metadata={
                    "act_name": row["title"],
                    "source": row.get("source", "pakistancode.gov.pk"),
                    "source_url": row["page_url"],
                    "pdf_url": row["pdf_url"],
                    "scraped_at": datetime.now(timezone.utc).isoformat(),
                    "ocr": bool(row.get("needs_ocr")),
                },
            )
            row["outcome"] = "ingested"
            row["ai_check"] = ai_check
            manifest[name] = row
            save_manifest(manifest)
            print(f"  Ingested: {name}")
        except Exception as err:
            row["outcome"] = "failed"
            row["error"] = str(err)
            manifest[name] = row
            save_manifest(manifest)
            print(f"  FAILED: {name}: {err}", file=sys.stderr)


def verify_existing(sb: SupabaseClient):
    """Retroactive quality pass over Acts already ingested into the live
    RAG store — reads directly from Supabase (local downloads/ files may no
    longer exist or may have been re-run since) so the report reflects
    what's actually live right now. Read-only: reports, never modifies
    anything, so it's safe to run any time out of curiosity or to check a
    library that's grown since the last scan."""
    print("Fetching ingested statute chunks from Supabase...")
    rows: list[dict] = []
    offset = 0
    page_size = 1000
    while True:
        resp = requests.get(
            f"{sb.rest_url}/documents",
            headers=sb.headers,
            params={
                "select": "id,content,metadata",
                "is_statute": "eq.true",
                "order": "id.asc",
                "limit": page_size,
                "offset": offset,
            },
            timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size

    by_act: dict[str, list[dict]] = {}
    for row in rows:
        act_name = (row.get("metadata") or {}).get("act_name") or "(unknown)"
        by_act.setdefault(act_name, []).append(row)

    print(f"\n{len(by_act)} Acts in the live library, {len(rows)} chunks total.")
    print("Sorted by chunk count (lowest first) — a real Act with very few chunks")
    print("relative to its peers, or an AI flag below, is worth a manual look.\n")

    for act_name, chunks in sorted(by_act.items(), key=lambda kv: len(kv[1])):
        check = assess_extraction(act_name, chunks[0]["content"])
        flag = "" if check["ok"] else f"  [AI FLAG: {check['note']}]"
        print(f"  {len(chunks):4d} chunks  —  {act_name}{flag}")


def save_manifest(manifest: dict):
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, default=str))


def main():
    load_dotenv(SCRIPT_DIR / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan", action="store_true", help="Search, download, and extract text — no Supabase writes")
    parser.add_argument("--confirm", action="store_true", help="Ingest whatever --scan found into the RAG store")
    parser.add_argument(
        "--include-flagged", action="store_true",
        help="Also ingest Acts the AI extraction check flagged (skipped by default)",
    )
    parser.add_argument(
        "--verify-existing", action="store_true",
        help="Read-only: spot-check Acts already ingested into the live library, no scan/confirm needed",
    )
    parser.add_argument(
        "--acts-file",
        help="Newline-separated Act names to scan instead of the built-in TARGET_ACTS list. Blank lines "
             "and lines starting with # are ignored, so the list can be grouped and commented.",
    )
    args = parser.parse_args()

    target_acts = None
    if args.acts_file:
        lines = Path(args.acts_file).read_text().splitlines()
        target_acts = [ln.strip() for ln in lines if ln.strip() and not ln.lstrip().startswith("#")]
        print(f"Using {len(target_acts)} Act name(s) from {args.acts_file}")

    manifest = json.loads(MANIFEST_PATH.read_text()) if MANIFEST_PATH.exists() else {}

    if not args.scan and not args.confirm and not args.verify_existing:
        sys.exit("Pass --scan (dry run), --confirm (ingest), and/or --verify-existing (spot-check what's live)")

    if args.scan:
        manifest = scan(manifest, target_acts)

    needs_supabase = args.confirm or args.verify_existing
    sb = None
    if needs_supabase:
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

    if args.confirm:
        confirm(manifest, sb, include_flagged=args.include_flagged)

    if args.verify_existing:
        verify_existing(sb)


if __name__ == "__main__":
    main()
