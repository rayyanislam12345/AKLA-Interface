#!/usr/bin/env python3
"""Daily legal-update monitor for the AKLA Matter Hub.

The law library has been a snapshot: each Act was scraped once and never
re-checked (resolve-statute deliberately short-circuits on any Act that
already has chunks), so an amended Act kept its pre-amendment text
indefinitely while Draft and Verify went on grounding answers in it. Nothing
watched SECP, the PPP authorities or the provincial regulators at all.

This runs every morning on the same Oracle VM as ocr-service and does three
things:

  1. Two AI sweeps to find what changed — a source sweep ("what did SECP
     issue in the last 48 hours?") and a rotating library sweep ("has this
     Act been amended?"). Both use Claude's hosted web_search tool, and both
     follow the posture set by supabase/functions/_shared/statuteResolver.ts:
     the model only ever LOCATES a url. Every fact stored here comes from a
     document this job downloaded and read itself, never from model prose.

  2. Acts on the library that genuinely changed. Bills and notices never
     touch it. An amending instrument is added as its own entry pointing at
     the Act it amends — a four-page amendment must never overwrite the
     principal Act's text. Only a genuine consolidated re-issue replaces an
     Act, and only after several independent checks agree.

  3. A daily digest for the homepage, written from the confirmed findings.

Usage:
    python3 monitor.py --dry-run      # read-only: search, verify, print
    python3 monitor.py                # the real run (systemd timer)
    python3 monitor.py --sources-only # skip the rotating library sweep
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR))
from supabase_io import SupabaseClient, _request_with_retry  # noqa: E402

load_dotenv(SCRIPT_DIR / ".env")

# Government sites publish IPv6 addresses they do not answer on. Python tries
# them first and waits out each timeout, so IPv4 addresses go first (the same
# fix official-fetch-relay/official-fetch.py carries).
_getaddrinfo = socket.getaddrinfo


def _ipv4_first(*args, **kwargs):
    return sorted(_getaddrinfo(*args, **kwargs), key=lambda info: info[0] != socket.AF_INET)


socket.getaddrinfo = _ipv4_first

# Sites that do not answer this VM at all (na.gov.pk, senate.gov.pk,
# pakistancode.gov.pk, the provincial assemblies, PPRA's portal) do answer the
# firm's DigitalOcean droplet, which runs a download relay reachable only over
# SSH with a key that can do nothing else (official-fetch-relay/). The chat
# service already uses it; the monitor shares the same key.
RELAY_DIR = os.environ.get("OFFICIAL_FETCH_RELAY_DIR", "/opt/chat-service/.relay")
RELAY_HOST = os.environ.get("OFFICIAL_FETCH_RELAY_HOST", "aklarelay@157.245.240.172")

# Haiku for the sweeps (many cheap calls, same model statuteResolver.ts and
# scrape.py already use for this kind of locate-and-classify work); Sonnet
# for the digest, which is prose a person actually reads every morning. The
# web_search tool version is tied to the sweep model: the basic variant is
# what Haiku 4.5 accepts.
SWEEP_MODEL = "claude-haiku-4-5-20251001"
WEB_SEARCH_TOOL = "web_search_20250305"
# Plain classification with no web search (watched-page entries, the
# incorporation check): the current Haiku.
CLASSIFY_MODEL = "claude-haiku-5-5"
DIGEST_MODEL = "claude-sonnet-5"

FINDING_SCHEMA = (
    '[{"title": string, "authority_ref": string|null, "update_type": '
    '"consolidated_replacement"|"amending_instrument"|"new_act"|"bill"|"draft"|"notice", '
    '"act_name": string|null, "summary": string, "source_url": string, '
    '"document_url": string|null, "published_date": "YYYY-MM-DD"|null, '
    '"confidence": "high"|"medium"|"low"}]'
)

UPDATE_TYPES = {
    "consolidated_replacement",
    "amending_instrument",
    "new_act",
    "bill",
    "draft",
    "notice",
}

# Rejections that no retry can change. Anything else (the document did not
# download, the PDF was unreadable) is retried from the stored url next
# morning without spending another search.
FINAL_REASON_PREFIXES = (
    "unknown update_type",
    "no title",
    "no url",
    "unparseable published_date",
    "published ",
    "published_date is in the future",
    "domain not allowlisted",
    "reference ",
    "document does not match",
    "redirect source",
    "source exceeds",
)


# ---------------------------------------------------------------- utilities


def log(msg: str) -> None:
    print(f"{datetime.now(timezone.utc).strftime('%H:%M:%S')} {msg}", flush=True)


def normalise(text: str) -> str:
    """Lowercase, collapse whitespace and drop punctuation — used to compare
    a reference number against document text, where '' S.R.O. 1234 (I)/2026 ''
    and 'SRO 1234(I)/2026' are the same thing."""
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def parse_published_period(value: str) -> tuple[date, date] | None:
    """Sources quote dates at whatever precision they feel like — a full date,
    a month, or (often) just a year. Returns the first and last day of the
    period given, with the last day capped at today.

    The age gate runs against the LAST day, so "2026" is judged on how recent
    it could be rather than being treated as 1 January and rejected as ten
    months stale. The first day is what gets stored, which is the conventional
    reading of a year-only citation."""
    value = value.strip()
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            start = datetime.strptime(value, fmt).date()
        except ValueError:
            continue
        if fmt == "%Y-%m-%d":
            last = start
        elif fmt == "%Y-%m":
            last = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        else:
            last = date(start.year, 12, 31)
        return start, min(last, date.today())
    return None


def load_config() -> dict:
    with open(SCRIPT_DIR / "sources.json") as f:
        return json.load(f)


# ------------------------------------------------------------------ the AI


# Every call's outcome, so a morning where the API refused everything (no
# credit, bad key, outage) ends as a FAILED run with the reason on the run
# row — not as a cheerful "no new legal developments were identified today".
AI_STATS = {"ok": 0, "failed": 0, "last_error": ""}


def ai_call(model: str, system: str, user: str, *, max_tokens: int = 2000, web_search_uses: int = 0) -> str | None:
    """One Claude call, optionally with the hosted web_search tool. Returns
    None rather than raising, so one bad call degrades that sweep instead of
    taking the whole morning's run down."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log("  ANTHROPIC_API_KEY not set — cannot search")
        AI_STATS["failed"] += 1
        AI_STATS["last_error"] = "ANTHROPIC_API_KEY not set"
        return None

    body: dict = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    if web_search_uses:
        body["tools"] = [{"type": WEB_SEARCH_TOOL, "name": "web_search", "max_uses": web_search_uses}]

    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=180,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as err:
        detail = ""
        response = getattr(err, "response", None)
        if response is not None:
            try:
                detail = " — " + (response.json().get("error", {}).get("message") or response.text[:300])
            except ValueError:
                detail = " — " + response.text[:300]
        log(f"  AI call failed: {err}{detail}")
        AI_STATS["failed"] += 1
        AI_STATS["last_error"] = f"{err}{detail}"[:500]
        return None

    AI_STATS["ok"] += 1
    # With a server-side tool in play the earlier text blocks are the model's
    # own search narration — the answer is the LAST text block, not the first.
    # (Same gotcha documented in statuteResolver.ts.)
    blocks = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    return blocks[-1].strip() if blocks else None


def ai_blackout() -> str | None:
    """The reason, if the API refused every single call this run."""
    if AI_STATS["failed"] and not AI_STATS["ok"]:
        return f"every AI call failed ({AI_STATS['failed']} of {AI_STATS['failed']}): {AI_STATS['last_error']}"
    return None


def parse_findings(reply: str | None) -> list[dict]:
    if not reply:
        return []
    match = re.search(r"\[[\s\S]*\]", reply)
    if not match:
        return []
    try:
        parsed = json.loads(match.group())
    except json.JSONDecodeError:
        return []
    return [f for f in parsed if isinstance(f, dict)] if isinstance(parsed, list) else []


def sweep_source(source: dict, known_refs: list[str], lookback_days: int) -> list[dict]:
    """'What did this authority publish in the last couple of days?'"""
    known = ", ".join(known_refs[:60]) or "none yet"
    reply = ai_call(
        SWEEP_MODEL,
        system=(
            "You track Pakistani legal and regulatory developments for a corporate law firm. "
            "Search the web for what the named authority has actually published recently. "
            "Report only real, verifiable items you found a page or document for — never "
            "guess, never infer, and never include an item you cannot give a working URL "
            "for. Classify each item honestly:\n"
            "- 'bill' = a proposed Act that has NOT been enacted (introduced, passed by one "
            "House, or awaiting assent)\n"
            "- 'draft' = draft rules, regulations or a policy circulated for public "
            "consultation, not yet in force\n"
            "- 'notice' = a circular, notification, guideline, press release or SRO that "
            "does not itself amend an Act's text\n"
            "- 'amending_instrument' = an Act, ordinance or SRO that amends a named existing Act\n"
            "- 'consolidated_replacement' = a newly issued full consolidated text of an "
            "existing Act\n"
            "- 'new_act' = a newly enacted Act\n\n"
            f"Respond with ONLY a JSON array, no other text, matching:\n{FINDING_SCHEMA}\n\n"
            "'act_name' is the existing Act this affects, or null. 'authority_ref' is the "
            "official reference (SRO/circular/notification number) if there is one. Prefer "
            "the official page or PDF as 'document_url'; a press report is acceptable as "
            "'source_url' when no official page exists yet. Return [] if there is genuinely "
            "nothing new."
        ),
        user=(
            f"Authority: {source['name']} — {source.get('description', '')}\n"
            f"Official sites: {', '.join(source.get('sites', []))}\n"
            f"Report anything published in the last {lookback_days} days.\n\n"
            f"Already known, do NOT report these again: {known}"
        ),
        web_search_uses=source.get("max_searches", 4),
    )
    return parse_findings(reply)


def sweep_act(act_name: str, known_titles: list[str], lookback_years: int) -> list[dict]:
    """'Has this specific Act been amended or replaced?'"""
    known = "; ".join(known_titles[:40]) or "none yet"
    reply = ai_call(
        SWEEP_MODEL,
        system=(
            "You check whether a specific Pakistani statute has changed. Search the web for "
            "any amendment, ordinance, consolidated re-issue or repeal affecting the named "
            "Act, and for any bill before Parliament or a provincial assembly that would "
            "amend it. Only report a change you found an actual official document or page "
            "for, with a working URL. If the Act appears unchanged, return [].\n\n"
            "Be precise about the distinction between an amending instrument (a separate "
            "short instrument that amends the Act), a consolidated replacement (a newly "
            "published full text of the Act as amended) and a bill (proposed, not law). Do "
            "not report the Act's own original enactment as a change.\n\n"
            f"Respond with ONLY a JSON array, no other text, matching:\n{FINDING_SCHEMA}\n\n"
            "Set 'act_name' to the Act named below, exactly as given."
        ),
        user=(
            f"Act: {act_name}\n\n"
            f"Has it been amended, replaced or repealed in the last {lookback_years} years, "
            "or is a bill to amend it pending?\n\n"
            f"Already known, do NOT report these again: {known}"
        ),
        web_search_uses=3,
    )
    findings = parse_findings(reply)
    for f in findings:
        # The library keys everything on this exact string; never let the
        # model rename an Act out from under its matters.
        f["act_name"] = act_name
    return findings


# ------------------------------------------------------------ the evidence


MAX_DOWNLOAD = 20 * 1024 * 1024
UA = "Mozilla/5.0 (compatible) AKLA-law-monitor"


def _host_in(host: str, domains: list[str]) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def domain_tier(url: str, config: dict) -> str | None:
    """'verified' for an official authority, 'reported' for an allowlisted
    press domain, None for anything else. The tier decides what a finding is
    allowed to do: only verified findings may touch the library or flag a
    matter."""
    host = (urlparse(url).hostname or "").lower()
    if _host_in(host, config["allowed_domains"]):
        return "verified"
    if _host_in(host, config.get("news_domains", [])):
        return "reported"
    return None


def relay_available() -> bool:
    return os.path.exists(f"{RELAY_DIR}/id_ed25519") and os.path.exists(f"{RELAY_DIR}/known_hosts")


def _download_relay(url: str, *, browser: bool = False) -> tuple[bytes | None, str, str, str | None]:
    """(body, content_type, final_url, error). The relay applies its own
    source gate (HTTPS, official domain, redirects checked, size, timeout)
    and reports the final address so it can be checked again here. In
    browser mode the relay opens the page in a real browser — for sites
    behind a browser check (SECP) or that fill their lists by script."""
    try:
        proc = subprocess.run(
            [
                "ssh", "-i", f"{RELAY_DIR}/id_ed25519",
                "-o", f"UserKnownHostsFile={RELAY_DIR}/known_hosts",
                "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                RELAY_HOST, ("browser:" + url) if browser else url,
            ],
            capture_output=True,
            timeout=200 if browser else 150,
        )
    except (subprocess.TimeoutExpired, OSError) as err:
        return None, "", url, f"relay failed ({err.__class__.__name__})"
    lines = proc.stderr.decode("utf-8", "replace").split("\n")
    if proc.returncode != 0:
        msg = next((l[6:] for l in lines if l.startswith("ERROR ")), f"relay exit {proc.returncode}")
        return None, "", url, f"relay: {msg}"
    final = next((l[6:].strip() for l in lines if l.startswith("FINAL ")), url)
    ctype = next((l[5:].strip() for l in lines if l.startswith("TYPE ")), "")
    if len(proc.stdout) > MAX_DOWNLOAD:
        return None, "", final, "source exceeds 20 MB"
    return proc.stdout, ctype, final, None


def _download_direct(url: str, domains: list[str], timeout: int) -> tuple[bytes | None, str, str, str | None]:
    """(body, content_type, final_url, error). Redirects are followed by
    hand so every hop is checked against the same domain gate."""
    try:
        for _ in range(6):
            parsed = urlparse(url)
            host = (parsed.hostname or "").lower()
            if (
                parsed.scheme != "https" or parsed.username or parsed.password
                or parsed.port not in (None, 443) or not _host_in(host, domains)
            ):
                return None, "", url, "redirect source is not an approved HTTPS site"
            resp = requests.get(url, timeout=timeout, allow_redirects=False, stream=True, headers={"User-Agent": UA})
            if resp.status_code in (301, 302, 303, 307, 308):
                url = urljoin(url, resp.headers.get("Location", ""))
                resp.close()
                continue
            resp.raise_for_status()
            chunks, size = [], 0
            for chunk in resp.iter_content(65536):
                size += len(chunk)
                if size > MAX_DOWNLOAD:
                    resp.close()
                    return None, "", url, "source exceeds 20 MB"
                chunks.append(chunk)
            resp.close()
            return b"".join(chunks), resp.headers.get("Content-Type", ""), url, None
        return None, "", url, "too many source redirects"
    except requests.exceptions.RequestException as err:
        return None, "", url, f"fetch failed ({err.__class__.__name__}: {str(err)[:120]})"


def extract_text(body: bytes, content_type: str, url: str) -> tuple[str | None, str | None]:
    content_type = (content_type or "").lower()
    if "pdf" in content_type or url.lower().split("?")[0].endswith(".pdf") or body[:5] == b"%PDF-":
        try:
            import pdfplumber

            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as tmp:
                tmp.write(body)
                tmp.flush()
                with pdfplumber.open(tmp.name) as pdf:
                    text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        except Exception as err:  # noqa: BLE001 — a broken PDF is a rejection, not a crash
            return None, f"pdf unreadable ({err})"
        # Many SROs and gazette notifications are scanned images: pdfplumber
        # finds no text at all. The OCR service on this VM reads them.
        if len(re.sub(r"\s+", " ", text).strip()) < 200:
            ocr_text, ocr_err = ocr_pdf(body)
            if ocr_text:
                text = ocr_text
            elif ocr_err:
                log(f"    OCR unavailable: {ocr_err}")
    else:
        raw = body.decode("utf-8", "replace")
        stripped = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", raw, flags=re.I)
        text = html.unescape(re.sub(r"<[^>]+>", " ", stripped))
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) < 200:
        return None, f"document had almost no text ({len(text)} chars)"
    return text, None


# Hosts that did not answer this VM directly. Once a host has timed out it
# goes straight to the relay for the rest of the run instead of costing
# another 30-second wait per document. sources.json can pre-seed the list.
RELAY_FIRST_HOSTS: set[str] = set()


def ocr_pdf(body: bytes) -> tuple[str | None, str | None]:
    """Text of a scanned PDF via the OCR service (ocr-service/app.py), when
    OCR_SHARED_SECRET is configured. (text, error)."""
    secret = os.environ.get("OCR_SHARED_SECRET")
    if not secret:
        return None, "OCR_SHARED_SECRET not set"
    url = os.environ.get("OCR_URL", "http://127.0.0.1:8090").rstrip("/") + "/ocr/pdf"
    try:
        resp = requests.post(url, data=body, headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/pdf"}, timeout=300)
        if resp.status_code >= 300:
            return None, f"OCR {resp.status_code}: {resp.text[:120]}"
        text = resp.json().get("text") or ""
        return (text if len(text.strip()) >= 200 else None), None if text.strip() else "OCR found no text"
    except (requests.exceptions.RequestException, ValueError) as err:
        return None, f"OCR failed: {str(err)[:120]}"


def fetch_bytes(url: str, config: dict) -> tuple[bytes | None, str, str, str | None]:
    """Download from an approved domain: directly first, then — for official
    sites only — through the relay. (body, content_type, final_url, error)."""
    tier = domain_tier(url, config)
    host = (urlparse(url).hostname or "").lower()
    if tier is None:
        return None, "", url, f"domain not allowlisted ({host or 'no host'})"
    if not RELAY_FIRST_HOSTS:
        RELAY_FIRST_HOSTS.update(h.lower() for h in config.get("relay_first_hosts", []))
    domains = config["allowed_domains"] if tier == "verified" else config.get("news_domains", [])
    use_relay = tier == "verified" and relay_available()
    err = None
    # Sites that only answer a real browser go straight to the relay's
    # browser mode; nothing else can read them.
    if use_relay and _host_in(host, config.get("browser_hosts", [])):
        body, ctype, final, rerr = _download_relay(url, browser=True)
        if body is None:
            return None, "", url, rerr
        if domain_tier(final, config) != "verified":
            return None, "", final, "redirect source is not an approved HTTPS site"
        return body, ctype, final, None
    if not (use_relay and _host_in(host, sorted(RELAY_FIRST_HOSTS))):
        body, ctype, final, err = _download_direct(url, domains, timeout=30 if tier == "verified" else 45)
        if body is not None or not use_relay:
            return body, ctype, final, err
        if err and err.startswith("fetch failed") and "HTTPError" not in err:
            RELAY_FIRST_HOSTS.add(host)
    body, ctype, final, rerr = _download_relay(url)
    if body is None:
        return None, "", url, f"{err}; {rerr}" if err else rerr
    if domain_tier(final, config) != "verified":
        return None, "", final, "redirect source is not an approved HTTPS site"
    return body, ctype, final, None


def fetch_document(url: str, config: dict) -> tuple[str | None, str | None, str | None]:
    """Download a finding's source document and return its text. Returns
    (text, tier, None) or (None, None, reason). Nothing gets written to the
    database without passing through here first."""
    tier = domain_tier(url, config)
    body, ctype, final, err = fetch_bytes(url, config)
    if body is None:
        return None, None, err
    text, terr = extract_text(body, ctype, final)
    if text is None:
        return None, None, terr
    return text, tier, None


def is_final_rejection(reason: str) -> bool:
    return reason.startswith(FINAL_REASON_PREFIXES)


def verify_finding(finding: dict, config: dict, *, max_age_days: int) -> tuple[bool, str, str | None, str | None]:
    """Every gate a finding must pass before it becomes a row. A sweep that
    starts hallucinating produces rejections here rather than fiction in the
    newsletter. Returns (ok, reason, text, tier)."""
    if finding.get("update_type") not in UPDATE_TYPES:
        return False, f"unknown update_type {finding.get('update_type')!r}", None, None
    if not finding.get("title"):
        return False, "no title", None, None

    url = finding.get("document_url") or finding.get("source_url")
    if not url:
        return False, "no url", None, None

    published = finding.get("published_date")
    if published:
        period = parse_published_period(str(published))
        if period is None:
            return False, f"unparseable published_date {published!r}", None, None
        first_day, latest_possible = period
        age = (date.today() - latest_possible).days
        if age > max_age_days:
            return False, f"published {age} days ago (window {max_age_days})", None, None
        if (date.today() - first_day).days < -1:
            return False, f"published_date is in the future ({published})", None, None
        # A year or a month alone is not a date: storing "2026-01-01" for
        # "2026" would read as a precise day that never happened.
        finding["published_date"] = first_day.isoformat() if first_day == latest_possible else None

    text, tier, reason = fetch_document(url, config)
    if text is None:
        # A press link that fails may still have an official page behind it.
        alt = finding.get("source_url") if url == finding.get("document_url") else None
        if alt and alt != url:
            text, tier, reason2 = fetch_document(alt, config)
            reason = reason if text is None else reason2
    if text is None:
        return False, reason or "could not read document", None, None

    # The document has to actually be the thing the model said it was.
    ref = finding.get("authority_ref")
    if ref and normalise(ref) and normalise(ref) not in normalise(text):
        return False, f"reference {ref!r} not found in the document", None, None
    if not ref:
        # Words every legal page contains ("draft", "amendment", "companies",
        # "regulations") prove nothing: SECP's regulations index matched a
        # "Draft Amendment to Companies Regulations" that was not on it. The
        # title has to be found through its distinctive words.
        words = [w for w in re.findall(r"[A-Za-z]{4,}", finding["title"]) if w.lower() not in GENERIC_WORDS][:6]
        hits = sum(1 for w in words if w.lower() in text.lower())
        if len(words) >= 2 and hits < min(2, len(words)):
            return False, "document does not match the reported title", None, None
        if len(words) < 2 and not finding.get("document_url"):
            return False, "document does not match the reported title (title too generic to confirm)", None, None
    # A listing page is not a document: when the only evidence is an index
    # that mentions the words, the finding stays but may not ring the bell.
    if not ref and not finding.get("document_url") and len(extract_entries(text if "<" in text[:500] else "", url)) == 0 and looks_like_index(text):
        finding["confidence"] = "low"
        finding["summary"] = ((finding.get("summary") or "").rstrip(". ") + ". Evidence is an index page, not the instrument itself.").lstrip(". ")

    # The model's date is a guess; the document's own date is evidence. When
    # the model offers nothing, or offers the day of the search itself (its
    # habit for anything it has just read about), the latest date printed in
    # the document wins.
    doc_date = latest_date_in(text)
    stored = finding.get("published_date")
    if doc_date and (not stored or (date.today() - date.fromisoformat(stored)).days <= 1):
        finding["published_date"] = doc_date

    return True, "ok", text, tier


GENERIC_WORDS = {
    "draft", "drafts", "amendment", "amendments", "amending", "amend", "companies", "company", "regulations", "regulation",
    "rules", "notification", "ordinance", "bill", "bills", "government", "pakistan", "federal", "provincial", "securities",
    "exchange", "commission", "authority", "national", "assembly", "senate", "section", "schedule", "updated", "consolidated",
    "version", "proposed", "public", "private", "partnership", "under", "with", "from", "that", "this", "being", "review",
}


def looks_like_index(text: str) -> bool:
    """A page that lists many instruments rather than being one: dozens of
    SRO numbers or year-suffixed titles."""
    return len(re.findall(r"S\.?\s?R\.?\s?O\.?\s*\d+|\b(?:Act|Ordinance|Rules|Regulations|Bill),?\s+(?:19|20)\d\d\b", text)) >= 25


def latest_date_in(text: str) -> str | None:
    """The most recent full date printed in a document that is not in the
    future, as ISO; None when the document carries no full date."""
    best: date | None = None
    months = MONTHS.split("|")
    for pattern, order in DATE_PATTERNS:
        for m in pattern.finditer(text[:20000]):
            parts = dict(zip(order, m.groups()))
            try:
                year = int(parts["year"])
                month = months.index(parts["month"].lower()) + 1 if "month" in parts else int(parts["monthnum"])
                d = date(year, month, int(parts["day"]))
            except (ValueError, KeyError):
                continue
            if d <= date.today() and (best is None or d > best):
                best = d
    return best.isoformat() if best else None


def dedupe_key_for(finding: dict, source_name: str) -> str:
    """Without a stable key the same SECP circular gets re-reported every
    morning forever. An official reference number is the real identity of an
    instrument; the url is the fallback."""
    ref = normalise(finding.get("authority_ref") or "")
    if ref:
        # Not prefixed with the source: SECP lists the same SRO on five
        # pages, and the search finds it too.
        return f"ref:{ref}"
    # The document's own address identifies it. A listing page's address does
    # not — every unlinked entry on a bills page shares it — so an entry with
    # no document of its own is keyed on its title.
    url = (finding.get("document_url") or "").split("?")[0].rstrip("/").lower()
    if url:
        return f"url:{url}"
    title = normalise(finding.get("title") or "")[:120]
    if title:
        return f"title:{title}"
    return f"url:{(finding.get('source_url') or '').split('?')[0].rstrip('/').lower()}"


# ------------------------------------------------------------- the library


class Hub:
    """Thin PostgREST wrapper for the tables this job owns, plus the shared
    SupabaseClient for ingestion (ingest-documents validates its caller with
    auth.getUser(), which the service-role key fails — supabase_io handles
    that with a bot-account session)."""

    def __init__(self, client: SupabaseClient, dry_run: bool):
        self.client = client
        self.dry_run = dry_run
        self.rest = client.rest_url
        self.headers = {**client.headers, "Content-Type": "application/json"}

    def get(self, path: str, params: dict) -> list[dict]:
        resp = _request_with_retry("GET", f"{self.rest}/{path}", headers=self.headers, params=params, timeout=60)
        return resp.json()

    def insert(self, path: str, payload: dict) -> dict | None:
        if self.dry_run:
            return None
        resp = _request_with_retry(
            "POST",
            f"{self.rest}/{path}",
            headers={**self.headers, "Prefer": "return=representation"},
            json=payload,
            timeout=60,
        )
        rows = resp.json()
        return rows[0] if rows else None

    def patch(self, path: str, params: dict, payload: dict) -> None:
        if self.dry_run:
            return
        _request_with_retry("PATCH", f"{self.rest}/{path}", headers=self.headers, params=params, json=payload, timeout=60)

    def upsert(self, path: str, payload: dict, on_conflict: str) -> None:
        if self.dry_run:
            return
        _request_with_retry(
            "POST",
            f"{self.rest}/{path}",
            headers={**self.headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
            params={"on_conflict": on_conflict},
            json=payload,
            timeout=60,
        )

    def delete_ids(self, path: str, ids: list[str]) -> None:
        if self.dry_run or not ids:
            return
        for i in range(0, len(ids), 50):
            batch = ids[i : i + 50]
            _request_with_retry(
                "DELETE",
                f"{self.rest}/{path}",
                headers=self.headers,
                params={"id": f"in.({','.join(batch)})"},
                timeout=60,
            )

    # -- library reads ----------------------------------------------------

    def library_acts(self) -> list[str]:
        resp = _request_with_retry(
            "POST", f"{self.client.base_url}/rest/v1/rpc/statute_sources", headers=self.headers, json={}, timeout=60
        )
        return [r["act_name"] for r in resp.json() if r.get("act_name")]

    def acts_on_matters(self) -> list[str]:
        rows = self.get(
            "matter_relevant_laws", {"select": "act_name", "status": "eq.available"}
        )
        return sorted({r["act_name"] for r in rows if r.get("act_name")})

    def act_chunks(self, act_name: str) -> list[dict]:
        return self.get(
            "documents",
            {
                "select": "id,content,metadata",
                "is_statute": "eq.true",
                "metadata->>act_name": f"eq.{act_name}",
                "order": "created_at.asc",
            },
        )

    def known_refs(self, source_name: str, days: int = 90) -> list[str]:
        """Everything this source has already surfaced — confirmed or
        rejected — so the morning search does not keep paying to re-find the
        same items."""
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        rows = self.get(
            "law_updates",
            {
                "select": "authority_ref,title",
                "source_name": f"eq.{source_name}",
                "discovered_at": f"gte.{since}",
                "limit": "100",
            },
        )
        known = [r["authority_ref"] or r["title"] for r in rows if r.get("authority_ref") or r.get("title")]
        seen = self.get(
            "law_monitor_candidates",
            {
                "select": "authority_ref,title",
                "source_name": f"eq.{source_name}",
                "last_seen_at": f"gte.{since}",
                "order": "last_seen_at.desc",
                "limit": "100",
            },
        )
        for r in seen:
            item = r.get("authority_ref") or r.get("title")
            if item and item not in known:
                known.append(item)
        return known

    def known_for_act(self, act_name: str) -> list[str]:
        rows = self.get(
            "law_monitor_candidates",
            {"select": "title", "act_name": f"eq.{act_name}", "order": "last_seen_at.desc", "limit": "60"},
        )
        return [r["title"] for r in rows if r.get("title")]

    def existing_update(self, dedupe_key: str) -> dict | None:
        rows = self.get("law_updates", {"select": "*", "dedupe_key": f"eq.{dedupe_key}", "limit": "1"})
        return rows[0] if rows else None

    def statute_sources(self) -> list[dict]:
        resp = _request_with_retry(
            "POST", f"{self.client.base_url}/rest/v1/rpc/statute_sources", headers=self.headers, json={}, timeout=60
        )
        rows = resp.json()
        # statute_sources() carries no pdf_url; pick it up from the first chunk
        # of each Act so a PDF source can be re-fetched as the document.
        return rows

    # -- watched pages ------------------------------------------------------

    def watch_page(self, url: str) -> dict | None:
        rows = self.get("law_watch_pages", {"select": "*", "url": f"eq.{url}", "limit": "1"})
        return rows[0] if rows else None

    def upsert_watch_page(self, row: dict) -> None:
        self.upsert("law_watch_pages", row, on_conflict="url")

    # -- notifications ------------------------------------------------------

    def notification_exists(self, row: dict) -> bool:
        params = {"select": "id", "user_id": f"eq.{row['user_id']}", "law_update_id": f"eq.{row['law_update_id']}", "limit": "1"}
        params["matter_id"] = f"eq.{row['matter_id']}" if row.get("matter_id") else "is.null"
        return bool(self.get("law_update_notifications", params))

    # -- the candidate memory ---------------------------------------------

    def candidate(self, dedupe_key: str) -> dict | None:
        rows = self.get("law_monitor_candidates", {"select": "*", "dedupe_key": f"eq.{dedupe_key}", "limit": "1"})
        return rows[0] if rows else None

    def pending_candidates(self, max_attempts: int) -> list[dict]:
        """Candidates whose document did not download last time. Retried from
        the stored url, no search needed."""
        return self.get(
            "law_monitor_candidates",
            {
                "select": "*",
                "status": "eq.pending_fetch",
                "fetch_attempts": f"lt.{max_attempts}",
                "order": "first_seen_at.asc",
                "limit": "40",
            },
        )

    def record_candidate(self, key: str, finding: dict, source_name: str, found_by: str, *,
                         status: str, reason: str | None, final: bool, run_id: str | None,
                         law_update_id: str | None = None, previous: dict | None = None) -> None:
        now = datetime.now(timezone.utc).isoformat()
        row = {
            "dedupe_key": key,
            "source_name": source_name,
            "found_by": found_by,
            "title": str(finding.get("title") or "")[:300],
            "authority_ref": finding.get("authority_ref"),
            "act_name": finding.get("act_name"),
            "update_type": finding.get("update_type"),
            "url": finding.get("document_url") or finding.get("source_url"),
            "published_date": finding.get("published_date"),
            "summary": finding.get("summary"),
            "confidence": finding.get("confidence"),
            "status": status,
            "reason": (reason or "")[:500] or None,
            "final": final,
            "fetch_attempts": (previous or {}).get("fetch_attempts", 0) + (1 if status == "pending_fetch" else 0),
            "times_seen": (previous or {}).get("times_seen", 0) + 1,
            "first_seen_at": (previous or {}).get("first_seen_at") or now,
            "last_seen_at": now,
            "law_update_id": law_update_id or (previous or {}).get("law_update_id"),
            "run_id": run_id,
        }
        self.upsert("law_monitor_candidates", row, on_conflict="dedupe_key")

    def touch_candidate(self, key: str, previous: dict) -> None:
        self.patch(
            "law_monitor_candidates",
            {"dedupe_key": f"eq.{key}"},
            {"last_seen_at": datetime.now(timezone.utc).isoformat(), "times_seen": previous.get("times_seen", 0) + 1},
        )


def looks_like_amendment(title: str) -> bool:
    return bool(re.search(r"\bamend(ment|ing|ed)?\b|\bordinance\b|\bs\.?r\.?o\.?\b", title, re.I))


def confirm_consolidated(act_name: str, title: str, text: str) -> tuple[bool, str]:
    """The last gate before an Act's stored text is replaced. Modelled on
    scrape.py's assess_extraction(), but asking the question that matters
    here: is this the full consolidated Act, or just an instrument that
    amends it? Getting this wrong would leave the library holding a
    four-page amendment as though it were the whole Act, and every AI answer
    grounded on it would be confidently wrong."""
    reply = ai_call(
        SWEEP_MODEL,
        system=(
            "You are deciding whether a document may REPLACE the stored full text of a "
            "Pakistani statute in a law firm's library. Answer PROBLEM unless the document "
            "is clearly the complete, current, consolidated text of the named Act itself. "
            "Answer PROBLEM if it is an amendment Act, an ordinance amending it, an SRO, a "
            "bill, a summary, a commentary, a single schedule, or a different Act. Also "
            "answer PROBLEM if the text is garbled or truncated.\n\n"
            'Respond with EXACTLY one line: "OK" or "PROBLEM: <short reason>".'
        ),
        user=f"Named Act: {act_name}\nDocument title: {title}\n\nStart of document:\n{text[:3000]}",
        max_tokens=100,
    )
    if reply is None:
        return False, "identity check unavailable — refusing to replace"
    if reply.strip().upper().startswith("OK"):
        return True, "confirmed consolidated text"
    return False, reply.strip()


# Pakistani amending instruments follow a fixed drafting grammar: 'for the
# words "X" the words "Y" shall be substituted', 'the words "X" shall be
# omitted', 'after the words "X" the words "Y" shall be inserted', and whole
# provisions 'shall be inserted, namely:- "..."'. Pulling the OLD and NEW
# wording out of that grammar makes it possible to ask the library's stored
# text a concrete question: does it already read the new way?
_Q = r"[\"“”']"
_SUBSTITUTE = re.compile(
    rf"for the (?:words?|figures?|expressions?|letters?|commas?|full stop|brackets?)[^\"“”']{{0,40}}{_Q}([^\"“”']{{3,400}}){_Q}[^\"“”']{{0,80}}?the (?:words?|figures?|expressions?|letters?|commas?|full stop|brackets?)[^\"“”']{{0,40}}{_Q}([^\"“”']{{3,400}}){_Q}[^\"“”']{{0,40}}shall be substituted",
    re.I,
)
_OMIT = re.compile(rf"the (?:words?|figures?|expressions?)[^\"“”']{{0,40}}{_Q}([^\"“”']{{3,400}}){_Q}[^\"“”']{{0,40}}shall be omitted", re.I)
_INSERT = re.compile(
    rf"(?:after|before) the (?:words?|figures?|expressions?)[^\"“”']{{0,40}}{_Q}[^\"“”']{{3,400}}{_Q}[^\"“”']{{0,80}}?the (?:words?|figures?|expressions?)[^\"“”']{{0,40}}{_Q}([^\"“”']{{3,400}}){_Q}[^\"“”']{{0,40}}shall be (?:inserted|added)",
    re.I,
)
_NAMELY = re.compile(rf"shall be (?:inserted|added|substituted)[^\"“”']{{0,30}}namely[:;,\-–— ]*{_Q}([^\"“”']{{25,600}})", re.I)


def amendment_wording(doc_text: str) -> tuple[list[str], list[str]]:
    """(new wording, old wording) quoted by an amending instrument, each as a
    normalised phrase of at least 15 characters."""
    new: list[str] = []
    old: list[str] = []
    for a, b in _SUBSTITUTE.findall(doc_text):
        old.append(a)
        new.append(b)
    old += _OMIT.findall(doc_text)
    new += _INSERT.findall(doc_text)
    new += _NAMELY.findall(doc_text)

    def clean(items: list[str]) -> list[str]:
        out: list[str] = []
        for item in items:
            n = normalise(item)
            if len(n) >= 15 and n not in out:
                out.append(n)
        return out[:30]

    return clean(new), clean(old)


def check_incorporation(hub: Hub, act_name: str, doc_text: str) -> tuple[str, str]:
    """Does the library's copy of the principal Act already include this
    amendment? ('incorporated' | 'not_incorporated' | 'unknown', note)."""
    existing = hub.act_chunks(act_name)
    if not existing:
        return "unknown", "principal Act is not in the library"
    stored = normalise(" ".join(c["content"] for c in existing))
    new, old = amendment_wording(doc_text)
    if len(new) + len(old) < 2:
        return "unknown", "the amendment quotes no wording that can be checked against the library copy"
    new_hits = sum(1 for p in new if p in stored)
    old_hits = sum(1 for p in old if p in stored)
    new_share = new_hits / len(new) if new else None
    old_share = old_hits / len(old) if old else None
    detail = (
        f"new wording found {new_hits}/{len(new)}"
        + (f", old wording still present {old_hits}/{len(old)}" if old else "")
    )
    if new_share is not None and new_share >= 0.6 and (old_share is None or old_share <= 0.4):
        return "incorporated", f"library copy already reads as amended ({detail})"
    if (new_share is None or new_share <= 0.3) and (old_share is None or old_share >= 0.6):
        return "not_incorporated", f"library copy predates this amendment ({detail})"
    return "unknown", f"mixed result ({detail})"


def apply_library_action(
    hub: Hub, finding: dict, doc_text: str, update_id: str | None, tier: str
) -> tuple[str, str, str | None, str | None]:
    """Returns (library_action, note, incorporation, incorporation_note).
    Bills, drafts, notices and anything merely reported in the press never
    reach the library; an amending instrument is added beside the Act it
    amends unless the library's copy already includes it; only a verified
    consolidated re-issue replaces anything."""
    kind = finding["update_type"]
    act_name = finding.get("act_name")
    title = finding["title"]
    source_url = finding.get("source_url") or finding.get("document_url")

    if tier != "verified":
        return "skipped", "reported in the press; the official text has not been located yet", None, None

    if kind in ("bill", "notice", "draft"):
        return "skipped", "bills, drafts and notices never enter the library", None, None

    if kind == "new_act":
        # Reported in the digest so a lawyer can add it deliberately; adding
        # every newly enacted Act automatically would grow the library
        # without anyone choosing to rely on it.
        return "none", "new Act reported for review, not auto-added", None, None

    if kind == "amending_instrument":
        if not act_name:
            return "none", "no principal Act identified", None, None
        incorporation, inc_note = check_incorporation(hub, act_name, doc_text)
        if incorporation == "incorporated":
            return "skipped", "the library copy already includes this amendment", incorporation, inc_note
        if hub.act_chunks(title):
            return "skipped", "already in the library", incorporation, inc_note
        log(f"    ingesting amending instrument as its own entry: {title}")
        if not hub.dry_run:
            hub.client.ingest_document_text(
                doc_text,
                is_statute=True,
                metadata={
                    "act_name": title,
                    "amends_act": act_name,
                    "source": "law-monitor",
                    "source_url": source_url,
                    "pdf_url": finding.get("document_url"),
                    "scraped_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        return "ingested_amendment", f"added as its own library entry, amending {act_name}", incorporation, inc_note

    # consolidated_replacement — the only path that overwrites.
    if not act_name:
        return "none", "no Act named", None, None
    existing = hub.act_chunks(act_name)
    if not existing:
        return "none", "Act is not in the library", None, None

    if looks_like_amendment(title):
        return "skipped", f"title reads as an amending instrument, not a consolidation: {title}", None, None

    old_text = "\n\n".join(c["content"] for c in existing)
    ratio = len(doc_text) / max(len(old_text), 1)
    if not 0.6 <= ratio <= 1.4:
        return "skipped", f"length {ratio:.0%} of the stored text — too different to be a re-issue", None, None

    ok, note = confirm_consolidated(act_name, title, doc_text)
    if not ok:
        return "skipped", note, None, None

    # Ingest FIRST, verify, and only then remove the old chunks: a failure
    # part-way through leaves the Act with its previous text rather than
    # with none at all.
    batch_id = str(uuid.uuid4())
    old_ids = [c["id"] for c in existing]
    log(f"    replacing {act_name}: {len(existing)} old chunks -> new batch {batch_id[:8]}")
    if hub.dry_run:
        return "replaced_act", f"[dry run] would replace {len(existing)} chunks", None, None

    hub.client.ingest_document_text(
        doc_text,
        is_statute=True,
        metadata={
            "act_name": act_name,  # immutable: matters and retrieval join on it
            "document_title": title,
            "source": "law-monitor",
            "source_url": source_url,
            "pdf_url": finding.get("document_url"),
            "scraped_at": datetime.now(timezone.utc).isoformat(),
            "ingest_batch_id": batch_id,
        },
    )

    fresh = [c for c in hub.act_chunks(act_name) if (c.get("metadata") or {}).get("ingest_batch_id") == batch_id]
    if not fresh:
        return "failed", "new text did not ingest — old text left in place", None, None

    hub.insert(
        "law_library_versions",
        {
            "act_name": act_name,
            "content": old_text,
            "metadata": existing[0].get("metadata") or {},
            "chunk_count": len(existing),
            "superseded_by_update_id": update_id,
        },
    )
    hub.delete_ids("documents", old_ids)
    return "replaced_act", f"replaced {len(existing)} chunks with {len(fresh)} (previous text archived)", None, None


# --------------------------------------------------------------- the digest


def write_digest(hub: Hub, run_id: str | None, findings: list[dict]) -> None:
    today = date.today().isoformat()
    if findings:
        listing = "\n\n".join(
            f"- {f['title']} ({f['source_name']}, {f['update_type']}, "
            f"{'OFFICIAL DOCUMENT VERIFIED' if f.get('tier') == 'verified' else 'REPORTED IN PRESS ONLY'})\n"
            f"  ref: {f.get('authority_ref') or 'n/a'}; published: {f.get('published_date') or 'unknown'}\n"
            f"  affects: {f.get('act_name') or 'no Act in our library'}\n"
            f"  library copy: {f.get('incorporation') or 'n/a'}"
            f"{' — ' + f['incorporation_note'] if f.get('incorporation_note') else ''}\n"
            f"  library action: {f.get('library_action')} — {f.get('library_action_note')}\n"
            f"  summary: {f.get('summary') or ''}"
            for f in findings
        )
        markdown = ai_call(
            DIGEST_MODEL,
            system=(
                "You write a short daily legal-update briefing for lawyers at a Pakistani "
                "corporate law firm. Be precise and factual — these are practising lawyers, "
                "so no hype and no padding. Use Markdown: a one-sentence opening, then one "
                "bullet per development saying what changed and what it affects. Put "
                "verified official developments first and press reports last under a short "
                "'Reported in the press' line.\n\n"
                "Rules: state clearly when something is a BILL or a DRAFT for consultation "
                "that is not yet law. Say when a development affects an Act the firm holds "
                "in its library, and whether the library's copy already includes the change "
                "(the 'library copy' line: incorporated / not_incorporated / unknown). Do "
                "not invent detail beyond what you are given. If the firm's library was "
                "updated automatically, mention it plainly."
            ),
            user=f"Date: {today}\n\nConfirmed developments:\n\n{listing}",
            max_tokens=1500,
        ) or "Automated summary unavailable; the findings below were still recorded."
    else:
        markdown = "No new legal developments were identified today."

    log(f"  digest written ({len(findings)} finding(s))")
    if hub.dry_run:
        print("\n--- digest ---\n" + markdown + "\n--------------\n")
        return
    hub.upsert(
        "law_update_digests",
        {
            "digest_date": today,
            "summary_markdown": markdown,
            "update_count": len(findings),
            "run_id": run_id,
        },
        on_conflict="digest_date",
    )


# ------------------------------------------------------------------- main


def select_acts(hub: Hub, config: dict, cursor: str | None) -> list[str]:
    """Acts a matter actually depends on are checked every day. The rest
    rotate, so a full pass over the library takes a few days instead of
    paying for 60-odd searches every morning."""
    all_acts = sorted(hub.library_acts())
    if not all_acts:
        return []
    attached = [a for a in hub.acts_on_matters() if a in all_acts]

    budget = config["max_acts_per_run"] - len(attached)
    rotation: list[str] = []
    if budget > 0:
        rest = [a for a in all_acts if a not in attached]
        start = 0
        if cursor:
            later = [i for i, a in enumerate(rest) if a > cursor]
            start = later[0] if later else 0
        rotation = (rest + rest)[start : start + budget]

    return attached + rotation


# ------------------------------------------------------------ watched pages
#
# Web search lags the authorities by days and surfaces press releases. The
# places law actually appears — the bills pages of the assemblies, Pakistan
# Code's recently-added list, PPRA's rules page — are ordinary listing
# pages. Each is read every morning and compared with the previous
# snapshot; new entries become candidates and go through the same
# verification as everything else. Classification is by rule, not by model:
# Pakistani titles say what they are ("The X (Amendment) Bill, 2026"), and a
# rule still works on a morning the API refuses every call.

LAWISH = re.compile(
    r"\b(bill|act|ordinance|rules?|regulations?|s\.?\s?r\.?\s?o\.?|notification|draft|policy|amendment|circular|order)\b",
    re.I,
)
NEWSY = re.compile(r"\b(holds?|held|session|workshop|training|seminar|inaugurat\w*|ceremony|meeting|conference|celebrat\w*|visit\w*|signs?|signed|launch\w*)\b", re.I)
SPECIFIC = re.compile(r"(19|20)\d{2}|\(amendment\)|\bs\.?\s?r\.?\s?o\.?\b|\bno\.?\s*\d", re.I)
SRO_REF = re.compile(r"S\.?\s?R\.?\s?O\.?\s*(?:No\.?)?\s*(\d+)\s*\(?\s*([IVX1]+)\s*\)?\s*/\s*((?:19|20)\d{2})", re.I)
MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december"
DATE_PATTERNS = (
    (re.compile(rf"\b((?:{MONTHS})) (\d{{1,2}}), ((?:19|20)\d{{2}})\b", re.I), ("month", "day", "year")),
    (re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)? ((?:{MONTHS})),? ((?:19|20)\d{{2}})\b", re.I), ("day", "month", "year")),
    (re.compile(r"\b(\d{1,2})[-/.](\d{1,2})[-/.]((?:19|20)\d{2})\b"), ("day", "monthnum", "year")),
    (re.compile(r"\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b"), ("year", "monthnum", "day")),
)
MAX_NEW_PER_PAGE = 40
MAX_REMEMBERED_ENTRIES = 1500


def load_watchlist() -> list[dict]:
    path = SCRIPT_DIR / "watchlist.json"
    if not path.exists():
        return []
    with open(path) as f:
        return [p for p in json.load(f).get("pages", []) if p.get("enabled", True)]


def entry_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())[:160]


def extract_entries(page_html: str, base_url: str) -> list[dict]:
    """The law-looking lines on a listing page: anchors first (they carry
    the document address), then table rows and list items for pages that
    print titles without links. A title has to name something specific — a
    year, an amendment, an SRO number — so navigation ('Bills', 'Rules of
    Procedure') does not count as an entry."""
    body = re.sub(r"<(script|style|noscript)[\s\S]*?</\1>", " ", page_html, flags=re.I)
    out: list[dict] = []
    seen: list[str] = []

    def add(raw: str, href: str | None) -> None:
        text = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", raw))).strip(" -–—|·:")
        if not (12 <= len(text) <= 250):
            return
        if not LAWISH.search(text) or not SPECIFIC.search(text):
            return
        # "PPRA holds awareness session on the Rules, 2026" names a law but
        # is not one.
        if NEWSY.search(text):
            return
        key = entry_key(text)
        if any(key == s or key.startswith(s) for s in seen):
            return
        seen.append(key)
        if href:
            href = html.unescape(href.strip())
            href = None if href.startswith(("#", "javascript:", "mailto:")) else urljoin(base_url, href)
        out.append({"text": text, "href": href})

    # A table row is one entry: its title is the first cell that reads like
    # a law, not the whole row with its serial number and dates. Rows go
    # first so the row's date travels with the entry; the anchor pass after
    # it would otherwise claim the title and lose the date.
    for row in re.findall(r"<tr\b[^>]*>([\s\S]*?)</tr>", body, re.I):
        cells = re.findall(r"<t[dh]\b[^>]*>([\s\S]*?)</t[dh]>", row, re.I)
        m = re.search(r'href="([^"]*)"', row)
        href = m.group(1) if m else None
        row_text = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", row))).strip()
        before = len(out)
        for cell in cells:
            add(cell, href)
            if len(out) > before:
                out[-1]["date"] = find_date(row_text)
                break
    for href, inner in re.findall(r'<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)</a>', body, re.I):
        add(inner, href)
    for block in re.findall(r"<(?:li|h[1-6]|p)\b[^>]*>([\s\S]*?)</(?:li|h[1-6]|p)>", body, re.I):
        m = re.search(r'href="([^"]*)"', block)
        add(block, m.group(1) if m else None)
    return out


def find_date(text: str) -> str | None:
    months = MONTHS.split("|")
    for pattern, order in DATE_PATTERNS:
        m = pattern.search(text)
        if not m:
            continue
        parts = dict(zip(order, m.groups()))
        try:
            year = int(parts["year"])
            month = months.index(parts["month"].lower()) + 1 if "month" in parts else int(parts["monthnum"])
            day = int(parts["day"])
            return date(year, month, day).isoformat()
        except (ValueError, KeyError):
            continue
    m = re.search(r"\b((?:19|20)\d{2})\b", text)
    return m.group(1) if m else None


def classify_entry(text: str, default_type: str) -> tuple[str, str | None]:
    """(update_type, authority_ref) from a title alone."""
    ref = None
    m = SRO_REF.search(text)
    if m:
        ref = f"S.R.O. {m.group(1)}({m.group(2).upper()})/{m.group(3)}"
    if re.search(r"\bbill\b", text, re.I):
        return "bill", ref
    if re.search(r"\bdraft\b|consultation", text, re.I):
        return "draft", ref
    if re.search(r"\(amendment\)|\bamendment\b|\bamending\b|further to amend", text, re.I) and re.search(r"\b(act|ordinance)\b", text, re.I):
        return "amending_instrument", ref
    if re.search(r"\b(act|ordinance)\b,?\s*(?:no\.?\s*[ivxl0-9]+\s*of\s*)?(19|20)\d{2}", text, re.I):
        return "new_act", ref
    if ref or re.search(r"\bs\.?\s?r\.?\s?o\.?\b|notification|circular", text, re.I):
        return "notice", ref
    if re.search(r"\brules?\b|\bregulations?\b|\bpolicy\b", text, re.I):
        return "notice", ref
    return default_type, ref


def act_base(name: str) -> str:
    base = re.sub(r"\((?:amendment|repeal|second amendment|third amendment)\)", " ", name, flags=re.I)
    base = re.sub(r"\b(the|bill|act|ordinance|no\.?\s*[ivxl0-9]+\s*of|\d{4})\b", " ", base, flags=re.I)
    # British and American spellings are both in use on official sites
    # ("Re-organisation" / "Re-organization").
    base = re.sub(r"isation|ising|ised", lambda m: m.group(0).replace("is", "iz"), base, flags=re.I)
    return re.sub(r"[^a-z0-9]+", "", base.lower())


def match_library_act(text: str, library_acts: list[str]) -> str | None:
    """Which library Act (if any) a title is about. 'The National Highway
    Authority (Amendment) Bill, 2026' -> 'National Highway Authority Act,
    1991'. 'further to amend the Companies Act, 2017' is also recognised."""
    cited = re.search(r"(?:further )?to amend the ([^,.;]+?(?:act|ordinance),?\s*(?:19|20)\d{2})", text, re.I)
    bases = [act_base(text)]
    if cited:
        bases.insert(0, act_base(cited.group(1)))
    for base in bases:
        if len(base) < 8:
            continue
        for act in library_acts:
            ab = act_base(act)
            if base == ab:
                return act
            # Containment only when the two are nearly the same length:
            # "registration" must not claim "national database and
            # registration authority".
            shorter, longer = sorted((base, ab), key=len)
            if len(shorter) >= 12 and shorter in longer and len(shorter) >= 0.7 * len(longer):
                return act
    return None


def watch_pages(hub: Hub, config: dict, counts: dict, library_acts: list[str]) -> list[dict]:
    """Diff every watched listing page against its snapshot. Returns the new
    entries as candidates; records a baseline for pages seen the first time."""
    out: list[dict] = []
    window = 366 * int(config.get("library_lookback_years", 2))
    for page in load_watchlist():
        url, name = page["url"], page["name"]
        if domain_tier(url, config) != "verified":
            log(f"watch page: {name} — domain not in allowed_domains, skipped")
            continue
        log(f"watch page: {name}")
        previous = hub.watch_page(url)
        now = datetime.now(timezone.utc).isoformat()
        body, ctype, final, err = fetch_bytes(url, config)
        if body is None:
            failures = (previous or {}).get("consecutive_failures", 0) + 1
            log(f"  could not read page ({err}); failure {failures} in a row")
            hub.upsert_watch_page({
                **(previous or {"url": url, "name": name, "kind": "listing", "entries": [], "entry_count": 0}),
                "name": name, "last_checked_at": now, "last_error": (err or "")[:400], "consecutive_failures": failures,
            })
            continue
        entries = extract_entries(body.decode("utf-8", "replace"), final)
        counts["pages"] += 1
        # A page whose earlier visits all failed has a row but no snapshot;
        # the first successful read is still the baseline.
        if previous is not None and not previous.get("entries") and not previous.get("entry_count"):
            previous = None
        if previous is None:
            log(f"  baseline recorded: {len(entries)} entries (nothing reported on a first visit)")
            hub.upsert_watch_page({
                "url": url, "name": name, "kind": "listing", "entries": entries[:MAX_REMEMBERED_ENTRIES],
                "entry_count": len(entries), "last_checked_at": now, "last_changed_at": now,
                "last_error": None, "consecutive_failures": 0,
            })
            continue
        old_entries = previous.get("entries") or []
        old_keys = {entry_key(e.get("text", "")) for e in old_entries}
        new = [e for e in entries if entry_key(e["text"]) not in old_keys]
        # Remember the union: a paginated or rotating page must not re-report
        # an entry that merely scrolled off and came back.
        merged = (new + old_entries)[:MAX_REMEMBERED_ENTRIES]
        hub.upsert_watch_page({
            "url": url, "name": name, "kind": "listing", "entries": merged, "entry_count": len(entries),
            "last_checked_at": now, "last_changed_at": now if new else previous.get("last_changed_at"),
            "last_error": None, "consecutive_failures": 0,
        })
        if not new:
            log("  no new entries")
            continue
        counts["pages_changed"] += 1
        log(f"  {len(new)} new entr{'y' if len(new) == 1 else 'ies'}")
        if len(new) > MAX_NEW_PER_PAGE:
            log(f"  (only the first {MAX_NEW_PER_PAGE} are taken this morning; the rest are remembered)")
        for e in new[:MAX_NEW_PER_PAGE]:
            update_type, ref = classify_entry(e["text"], page.get("default_type", "notice"))
            act = match_library_act(e["text"], library_acts)
            finding = {
                "title": e["text"],
                "authority_ref": ref,
                "update_type": update_type,
                "act_name": act,
                "summary": f"New entry on {name}" + (f" ({page['jurisdiction']})" if page.get("jurisdiction") else "") + ".",
                "source_url": url,
                "document_url": e.get("href"),
                "published_date": e.get("date") or find_date(e["text"]),
                "confidence": "medium",
            }
            out.append({"finding": finding, "source_name": name, "found_by": "watch_page", "max_age": window})
    return out


def text_fingerprint(text: str) -> str:
    """Hash of the text with digits removed, so visitor counters and dates
    do not read as amendments. (A change that only alters numbers in an
    Act is therefore not seen by this route; the amendment sweep still is.)"""
    return hashlib.sha256(re.sub(r"\d+", "", normalise(text)).encode()).hexdigest()


def recheck_library_sources(hub: Hub, config: dict, counts: dict, acts: list[str]) -> list[dict]:
    """For each Act in today's rotation whose stored source is an official
    page, re-fetch it and compare with the last snapshot. A change becomes a
    consolidated-replacement candidate and goes through the existing
    safeguards (length within 40%, identity check, archive before delete)."""
    out: list[dict] = []
    if not acts:
        return out
    sources = {r["act_name"]: r for r in hub.statute_sources() if r.get("act_name")}
    for act in acts:
        src = sources.get(act) or {}
        url = re.sub(r"^http://", "https://", src.get("source_url") or "")
        if not url or domain_tier(url, config) != "verified":
            continue
        log(f"library source: {act}")
        previous = hub.watch_page(url)
        now = datetime.now(timezone.utc).isoformat()
        body, ctype, final, err = fetch_bytes(url, config)
        text = None
        if body is not None:
            text, err = extract_text(body, ctype, final)
        if text is None:
            failures = (previous or {}).get("consecutive_failures", 0) + 1
            log(f"  could not read source ({err}); failure {failures} in a row")
            hub.upsert_watch_page({
                **(previous or {"url": url, "name": act, "kind": "library_source", "act_name": act}),
                "last_checked_at": now, "last_error": (err or "")[:400], "consecutive_failures": failures,
            })
            continue
        counts["pages"] += 1
        fp = text_fingerprint(text)
        row = {
            "url": url, "name": act, "kind": "library_source", "act_name": act, "content_hash": fp,
            "content_length": len(text), "last_checked_at": now, "last_error": None, "consecutive_failures": 0,
        }
        if previous is not None and not previous.get("content_hash"):
            previous = None
        if previous is None:
            log(f"  baseline recorded ({len(text)} chars)")
            hub.upsert_watch_page({**row, "last_changed_at": now})
            continue
        if previous.get("content_hash") == fp:
            log("  unchanged")
            hub.upsert_watch_page({**row, "last_changed_at": previous.get("last_changed_at")})
            continue
        counts["pages_changed"] += 1
        log(f"  CHANGED: {previous.get('content_length')} -> {len(text)} chars")
        hub.upsert_watch_page({**row, "last_changed_at": now})
        out.append({
            "finding": {
                "title": f"{act} — official text changed at its source",
                "authority_ref": None,
                "update_type": "consolidated_replacement",
                "act_name": act,
                "summary": f"The official page the library copy was taken from now reads differently ({previous.get('content_length')} -> {len(text)} characters).",
                "source_url": url,
                "document_url": src.get("pdf_url") if domain_tier(src.get("pdf_url") or "", config) == "verified" else url,
                "published_date": None,
                "confidence": "medium",
            },
            "source_name": config["library_source_name"],
            "found_by": "library_source",
            "max_age": 366 * int(config.get("library_lookback_years", 2)),
        })
    return out


# ------------------------------------------------------------ notifications
#
# Who is told what:
#   * the team of every matter that depends on an affected Act (lead
#     partner, creator, task assignees, anyone who has recorded time on it)
#     for verified amendments, re-issues and new Acts touching that Act;
#   * everyone approved, for bills, drafts, new Acts and amendments to any
#     library Act, unless they have switched the firm-wide stream off;
#   * nobody, for press reports, plain notices, or amendments the library
#     copy already includes.
# Email is one message per person per morning, through Resend, and only
# when RESEND_API_KEY and LAW_MONITOR_EMAIL_FROM are set in the VM's .env.

FIRM_WIDE_TYPES = {"bill", "draft", "new_act", "amending_instrument", "consolidated_replacement"}
HUB_URL = os.environ.get("HUB_URL", "https://factoriq.app").rstrip("/")


def notify(hub: Hub, stored: list[dict], counts: dict) -> list[dict]:
    """Write law_update_notifications for the morning's findings. Returns the
    rows written (for the email step)."""
    written: list[dict] = []
    if not stored or hub.dry_run:
        if stored:
            log(f"  [dry run] would notify about {len(stored)} finding(s)")
        return written

    prefs = {r["user_id"]: r for r in hub.get("notification_preferences", {"select": "user_id,firm_wide_law_updates,email_law_updates"})}
    everyone = [r["id"] for r in hub.get("profiles", {"select": "id", "status": "eq.approved"})]

    for update in stored:
        update_id = update.get("id")
        if not update_id or update.get("tier") != "verified":
            continue
        if update.get("incorporation") == "incorporated":
            continue
        if update.get("confidence") == "low":
            continue
        kind = update["update_type"]
        told: set[str] = set()

        act = update.get("act_name")
        if act and kind not in ("bill", "draft", "notice"):
            resp = _request_with_retry(
                "POST", f"{hub.client.base_url}/rest/v1/rpc/law_update_recipients",
                headers=hub.headers, json={"p_act_name": act}, timeout=60,
            )
            for r in resp.json():
                row = {"user_id": r["user_id"], "law_update_id": update_id, "matter_id": r["matter_id"], "reason": "matter"}
                if hub.notification_exists(row):
                    told.add(r["user_id"])
                    continue
                hub.insert("law_update_notifications", row)
                written.append({**row, "matter_name": r.get("matter_name"), "update": update})
                told.add(r["user_id"])

        # Firm-wide only when it touches a library Act, or came from the
        # sector-focused searches. The assemblies' pages list every bill in
        # the country; those stay in the briefing without ringing every bell.
        if kind in FIRM_WIDE_TYPES and (act or update.get("found_by") != "watch_page"):
            for user_id in everyone:
                if user_id in told:
                    continue
                if not prefs.get(user_id, {}).get("firm_wide_law_updates", True):
                    continue
                row = {"user_id": user_id, "law_update_id": update_id, "matter_id": None, "reason": "firm"}
                if hub.notification_exists(row):
                    continue
                hub.insert("law_update_notifications", row)
                written.append({**row, "matter_name": None, "update": update})

    counts["notified"] = len(written)
    log(f"  {len(written)} notification(s) written")
    return written


def email_configured() -> bool:
    return bool(os.environ.get("RESEND_API_KEY") and os.environ.get("LAW_MONITOR_EMAIL_FROM"))


def send_email(to: str, subject: str, text: str) -> str | None:
    """Returns None on success, else the reason."""
    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {os.environ['RESEND_API_KEY']}", "Content-Type": "application/json"},
            json={"from": os.environ["LAW_MONITOR_EMAIL_FROM"], "to": [to], "subject": subject, "text": text},
            timeout=30,
        )
        if resp.status_code >= 300:
            return f"{resp.status_code} {resp.text[:200]}"
        return None
    except requests.exceptions.RequestException as err:
        return str(err)[:200]


def email_digests(hub: Hub, counts: dict) -> None:
    """One email per person covering every notification not yet emailed
    from the last two days. Nothing older is sent, so switching mail on
    later does not flood anyone with the backlog."""
    if hub.dry_run:
        return
    if not email_configured():
        log("  email not configured (RESEND_API_KEY / LAW_MONITOR_EMAIL_FROM) — in-app only")
        return
    since = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    pending = hub.get(
        "law_update_notifications",
        {
            "select": "id,user_id,matter_id,reason,law_update_id,law_updates(title,act_name,update_type,source_name,source_url,document_url,published_date,summary,incorporation),matters(name)",
            "emailed_at": "is.null",
            "created_at": f"gte.{since}",
            "order": "created_at.desc",
            "limit": "1000",
        },
    )
    if not pending:
        return
    prefs = {r["user_id"]: r for r in hub.get("notification_preferences", {"select": "user_id,email_law_updates"})}
    profiles = {r["id"]: r for r in hub.get("profiles", {"select": "id,email,full_name", "status": "eq.approved"})}

    by_user: dict[str, list[dict]] = {}
    for n in pending:
        by_user.setdefault(n["user_id"], []).append(n)

    sent = 0
    for user_id, items in by_user.items():
        profile = profiles.get(user_id)
        if not profile or not profile.get("email"):
            continue
        if not prefs.get(user_id, {}).get("email_law_updates", True):
            # Opted out: mark as handled so it is never sent later either.
            hub.patch("law_update_notifications", {"id": f"in.({','.join(i['id'] for i in items)})"}, {"emailed_at": datetime.now(timezone.utc).isoformat()})
            continue
        lines = [f"Good morning{(' ' + profile['full_name'].split()[0]) if profile.get('full_name') else ''},", ""]
        matter_items = [i for i in items if i.get("matter_id")]
        firm_items = [i for i in items if not i.get("matter_id")]
        if matter_items:
            lines.append("Laws your projects depend on:")
            for i in matter_items:
                u = i.get("law_updates") or {}
                m = (i.get("matters") or {}).get("name") or "a project"
                inc = {"not_incorporated": " The library copy does not yet include this change.", "unknown": " Not yet confirmed whether the library copy includes this."}.get(u.get("incorporation") or "", "")
                lines.append(f"  - {m}: {u.get('title')} ({lawtype(u.get('update_type'))}, {u.get('source_name')}). Affects {u.get('act_name')}.{inc}")
                lines.append(f"    {HUB_URL}/matters/{i['matter_id']}")
            lines.append("")
        if firm_items:
            lines.append("Firm-wide:")
            for i in firm_items:
                u = i.get("law_updates") or {}
                src = u.get("document_url") or u.get("source_url") or ""
                lines.append(f"  - {u.get('title')} ({lawtype(u.get('update_type'))}, {u.get('source_name')})" + (f" — affects {u['act_name']}" if u.get("act_name") else "") + (f"\n    {src}" if src else ""))
            lines.append("")
        lines += [f"Full briefing: {HUB_URL}/dashboard", "", "You can switch these emails off from the bell in the Hub header."]
        subject = f"Legal updates — {len(items)} new for you ({date.today().strftime('%d %b %Y')})"
        err = send_email(profile["email"], subject, "\n".join(lines))
        if err:
            log(f"  email to {profile['email']} failed: {err}")
            continue
        hub.patch("law_update_notifications", {"id": f"in.({','.join(i['id'] for i in items)})"}, {"emailed_at": datetime.now(timezone.utc).isoformat()})
        sent += 1
    counts["emailed"] = sent
    log(f"  {sent} email(s) sent")


def lawtype(kind: str | None) -> str:
    return {
        "consolidated_replacement": "consolidated re-issue",
        "amending_instrument": "amendment",
        "new_act": "new Act",
        "bill": "bill, not yet law",
        "draft": "draft for consultation",
        "notice": "notice",
    }.get(kind or "", kind or "")


def gather_search_candidates(hub: Hub, config: dict, args, counts: dict) -> list[dict]:
    out: list[dict] = []
    if args.acts_only or args.watch_only:
        return out
    for source in config["sources"]:
        log(f"source sweep: {source['name']}")
        found = sweep_source(source, hub.known_refs(source["name"]), config["lookback_days"])
        counts["sources"] += 1
        log(f"  {len(found)} candidate(s)")
        out += [
            {"finding": f, "source_name": source["name"], "found_by": "search", "max_age": config["max_published_age_days"]}
            for f in found
        ]
    return out


def gather_library_candidates(hub: Hub, config: dict, args, counts: dict) -> tuple[list[dict], str | None, list[str]]:
    """The rotating 'has this Act changed?' sweep. Its window is the library
    window (years, not days): an amendment the library never picked up is
    news to the library however old it is. Also returns today's Acts so
    their official sources can be re-checked."""
    out: list[dict] = []
    if args.sources_only or args.watch_only:
        return out, None, []
    previous = hub.get(
        "law_monitor_runs",
        {"select": "library_cursor", "status": "eq.ok", "order": "started_at.desc", "limit": "1"},
    )
    cursor = previous[0]["library_cursor"] if previous else None
    years = int(config.get("library_lookback_years", 2))
    last_act: str | None = None
    acts = select_acts(hub, config, cursor)
    for act in acts:
        log(f"library sweep: {act}")
        found = sweep_act(act, hub.known_for_act(act), years)
        counts["acts"] += 1
        last_act = act
        if found:
            log(f"  {len(found)} candidate(s)")
        out += [
            {"finding": f, "source_name": config["library_source_name"], "found_by": "library_sweep", "max_age": years * 366}
            for f in found
        ]
    return out, last_act, acts


def parse_timestamp(value: str) -> datetime:
    """A timestamp as the database returns it. Postgres drops trailing zeros
    from the fraction (".88185") and the VM's Python 3.9 reads only three or
    six fractional digits, so the fraction is padded to six."""
    value = value.replace("Z", "+00:00")
    value = re.sub(r"\.(\d{1,6})(?=[+-]\d\d:\d\d$|$)", lambda m: "." + m.group(1).ljust(6, "0"), value)
    return datetime.fromisoformat(value)


def gather_pending_candidates(hub: Hub, config: dict, counts: dict) -> list[dict]:
    """Candidates whose document failed to download on an earlier morning.
    No search is spent: the stored url is simply tried again."""
    out: list[dict] = []
    for row in hub.pending_candidates(int(config.get("max_fetch_attempts", 5))):
        finding = {
            "title": row["title"],
            "authority_ref": row.get("authority_ref"),
            "act_name": row.get("act_name"),
            "update_type": row.get("update_type"),
            "document_url": row.get("url"),
            "source_url": row.get("url"),
            "published_date": row.get("published_date"),
            "summary": row.get("summary"),
            "confidence": row.get("confidence"),
        }
        # It passed the age gate when first seen; waiting for the site to
        # answer must not age it out.
        first_seen = row.get("first_seen_at") or datetime.now(timezone.utc).isoformat()
        waited = (datetime.now(timezone.utc) - parse_timestamp(first_seen)).days
        window = 366 * int(config.get("library_lookback_years", 2)) if row.get("found_by", "").startswith("library") else config["max_published_age_days"]
        out.append(
            {
                "finding": finding,
                "source_name": row["source_name"],
                "found_by": row.get("found_by") or "search",
                "max_age": window + waited + 1,
                "previous": row,
                "retry": True,
            }
        )
    counts["retried"] = len(out)
    if out:
        log(f"retrying {len(out)} candidate(s) whose document did not download before")
    return out


def summarise_document(finding: dict, text: str) -> str | None:
    """One plain sentence about a watched-page entry, written from the
    document itself: what it is, what it does to which law, and the date it
    carries. "New entry on National Assembly — government bills" told an
    associate nothing. The model sees only the fetched text and may not add
    to it; the sentence is marked as a summary of the document."""
    reply = ai_call(
        CLASSIFY_MODEL,
        system=(
            "You summarise one Pakistani legal document for a corporate lawyer in ONE sentence of "
            "at most 45 words, plain English, no preamble. Say what the document is (a bill "
            "introduced where, an SRO, a circular, an Act), what it does and to which law, and "
            "the date it carries if the text shows one. Use ONLY what is in the text; if the text "
            "is a scanned or garbled extract, say what can be read with certainty and no more. "
            "Do not speculate about status, passage or effect beyond the text."
        ),
        user=f"Title as listed: {finding.get('title')}\n\nStart of the document:\n{text[:4000]}",
        max_tokens=160,
    )
    if not reply:
        return None
    sentence = re.sub(r"\s+", " ", reply).strip().strip('"')
    if len(sentence) < 20 or len(sentence) > 400:
        return None
    return sentence


# The library's Act names, set once per run, so a finding's Act can be
# checked against what the firm actually holds.
LIBRARY_ACTS: list[str] = []
SUBORDINATE = re.compile(r"\b(regulations?|rules|policy|guidelines|code|directive|circular)\b", re.I)
PRIMARY = re.compile(r"\b(act|ordinance)\b", re.I)


def settle_act_and_kind(finding: dict, found_by: str) -> None:
    """Two corrections before a finding is recorded.

    The Act named must be one in the library. The search model names
    whatever law a page mentions ("Passports Act, 1974", "Securities
    Brokers Regulations, 2016"); the card would then say "affects …" and the
    bell would ring for a law the firm does not hold. A name that matches
    nothing in the library moves into the summary and the Act is cleared.
    Library-sweep findings keep their Act: it is the one being checked.

    An instrument whose title amends regulations, rules or a policy is not
    an amendment to the Act they are made under, even when the model says
    so; it is recorded as a notice and never ingested beside the Act."""
    act = finding.get("act_name")
    if act and found_by != "library_sweep" and LIBRARY_ACTS:
        matched = act if act in LIBRARY_ACTS else match_library_act(act, LIBRARY_ACTS)
        if matched:
            finding["act_name"] = matched
        else:
            finding["act_name"] = None
            finding["summary"] = ((finding.get("summary") or "").rstrip(". ") + f". Concerns {act}, which is not in the firm's library.").lstrip(". ")
    title = str(finding.get("title") or "")
    if finding.get("update_type") == "amending_instrument" and SUBORDINATE.search(title) and not PRIMARY.search(title):
        finding["update_type"] = "notice"


def process_candidate(hub: Hub, config: dict, run_id: str | None, cand: dict, counts: dict, seen_keys: set[str]) -> dict | None:
    """Verify one candidate and, if it clears the bar, record it. Returns the
    stored row (for the digest) or None."""
    finding, source_name, found_by = cand["finding"], cand["source_name"], cand["found_by"]
    title = str(finding.get("title", ""))[:90]
    key = dedupe_key_for(finding, source_name)
    if key in seen_keys:
        return None
    seen_keys.add(key)

    previous = cand.get("previous") or hub.candidate(key)

    if hub.existing_update(key):
        log(f"  already known, refreshing last seen: {title}")
        hub.patch("law_updates", {"dedupe_key": f"eq.{key}"}, {"last_seen_at": datetime.now(timezone.utc).isoformat()})
        if previous:
            hub.touch_candidate(key, previous)
        counts["known"] += 1
        return None

    if previous and previous.get("status") == "rejected" and previous.get("final") and not cand.get("retry"):
        log(f"  already rejected ({previous.get('reason')}): {title}")
        hub.touch_candidate(key, previous)
        counts["known"] += 1
        return None

    ok, reason, doc_text, tier = verify_finding(finding, config, max_age_days=cand["max_age"])
    if not ok:
        final = is_final_rejection(reason)
        attempts = (previous or {}).get("fetch_attempts", 0) + 1
        if not final and attempts >= int(config.get("max_fetch_attempts", 5)):
            final = True
            reason = f"{reason} — gave up after {attempts} attempts"
        status = "rejected" if final else "pending_fetch"
        counts["rejected" if final else "pending"] += 1
        log(f"  {'REJECTED' if final else 'PENDING (will retry)'} ({reason}): {title}")
        hub.record_candidate(key, finding, source_name, found_by, status=status, reason=reason, final=final, run_id=run_id, previous=previous)
        return None

    settle_act_and_kind(finding, found_by)
    if found_by == "watch_page" and doc_text:
        finding["summary"] = summarise_document(finding, doc_text) or finding.get("summary")

    row = {
        "dedupe_key": key,
        "source_name": source_name,
        "authority_ref": finding.get("authority_ref"),
        "act_name": finding.get("act_name"),
        "title": finding["title"],
        "summary": finding.get("summary"),
        "update_type": finding["update_type"],
        "source_url": finding.get("source_url"),
        "document_url": finding.get("document_url"),
        "published_date": finding.get("published_date"),
        "confidence": finding.get("confidence") if finding.get("confidence") in ("high", "medium", "low") else None,
        "tier": tier,
        "found_by": found_by,
        "run_id": run_id,
    }
    inserted = hub.insert("law_updates", row)
    update_id = inserted["id"] if inserted else None
    counts["written" if tier == "verified" else "reported"] += 1
    log(f"  {'CONFIRMED' if tier == 'verified' else 'REPORTED (press)'}: {title}")

    # Isolated: refreshing the library involves an ingest call that can
    # fail on its own (no bot session configured, Voyage timeout, a
    # malformed PDF). That must cost this one finding its library
    # action, not the rest of the morning's run.
    try:
        action, note, incorporation, inc_note = apply_library_action(hub, finding, doc_text or "", update_id, tier or "reported")
    except Exception as err:  # noqa: BLE001
        action, note, incorporation, inc_note = "failed", f"library update failed: {err}", None, None
    log(f"    library: {action} — {note}" + (f" [{incorporation}: {inc_note}]" if incorporation else ""))
    patch = {
        "library_action": action,
        "library_action_at": datetime.now(timezone.utc).isoformat(),
        "library_action_note": note,
        "incorporation": incorporation,
        "incorporation_note": inc_note,
    }
    if update_id:
        hub.patch("law_updates", {"id": f"eq.{update_id}"}, patch)
    hub.record_candidate(
        key, finding, source_name, found_by,
        status="confirmed" if tier == "verified" else "reported", reason=None, final=True,
        run_id=run_id, law_update_id=update_id, previous=previous,
    )
    return {**row, **patch, "id": update_id}


def finish_run(hub: Hub, run_id: str | None, status: str, counts: dict, *, last_act: str | None = None, error: str | None = None) -> None:
    if not run_id:
        return
    patch = {
        "status": status,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "sources_checked": counts["sources"],
        "acts_checked": counts["acts"],
        "found": counts["found"],
        "written": counts["written"],
        "rejected": counts["rejected"] + counts["pending"],
        "reported": counts["reported"],
        "retried": counts["retried"],
        "pages_checked": counts["pages"],
        "pages_changed": counts["pages_changed"],
        "notified": counts["notified"],
        "emailed": counts["emailed"],
    }
    if status == "ok":
        patch["library_cursor"] = last_act
    if error:
        patch["error"] = error[:2000]
    hub.patch("law_monitor_runs", {"id": f"eq.{run_id}"}, patch)


def main() -> int:
    parser = argparse.ArgumentParser(description="Daily legal-update monitor")
    parser.add_argument("--dry-run", action="store_true", help="search and verify, but write nothing")
    parser.add_argument("--sources-only", action="store_true", help="skip the rotating library sweep")
    parser.add_argument("--acts-only", action="store_true", help="skip the source sweep")
    parser.add_argument("--no-retry", action="store_true", help="skip re-fetching candidates that failed to download before")
    parser.add_argument("--watch-only", action="store_true", help="only read the watched listing pages (no AI searches)")
    parser.add_argument("--no-watch", action="store_true", help="skip the watched listing pages and library source re-check")
    args = parser.parse_args()

    config = load_config()
    required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing environment: {', '.join(missing)}", file=sys.stderr)
        return 1

    client = SupabaseClient(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        session_email=os.environ.get("SUPABASE_SESSION_EMAIL"),
        session_password=os.environ.get("SUPABASE_SESSION_PASSWORD"),
    )
    hub = Hub(client, dry_run=args.dry_run)

    run = hub.insert("law_monitor_runs", {"status": "running"})
    run_id = run["id"] if run else None
    log(f"run {run_id or '(dry run)'} starting" + ("" if relay_available() else " — download relay not configured, unreachable sites will be skipped"))

    counts = {k: 0 for k in ("found", "written", "reported", "rejected", "pending", "known", "retried", "sources", "acts", "pages", "pages_changed", "notified", "emailed")}
    stored: list[dict] = []
    last_act: str | None = None

    try:
        candidates: list[dict] = []
        if not args.no_retry:
            candidates += gather_pending_candidates(hub, config, counts)
        library_acts = sorted(hub.library_acts())
        LIBRARY_ACTS[:] = library_acts
        if not args.no_watch and not args.acts_only:
            candidates += watch_pages(hub, config, counts, library_acts)
        candidates += gather_search_candidates(hub, config, args, counts)
        library, last_act, todays_acts = gather_library_candidates(hub, config, args, counts)
        candidates += library
        if not args.no_watch:
            candidates += recheck_library_sources(hub, config, counts, todays_acts)

        counts["found"] = len(candidates)
        log(f"{len(candidates)} candidate(s) to verify")

        seen_keys: set[str] = set()
        for cand in candidates:
            row = process_candidate(hub, config, run_id, cand, counts, seen_keys)
            if row:
                stored.append(row)

        # Nothing found because nothing could be searched is a failure, and
        # yesterday's briefing must stay on the homepage with its date.
        blackout = ai_blackout()
        if blackout and not stored:
            raise RuntimeError(blackout)

        # A pages-only run is a supplement, not the morning briefing: it must
        # not overwrite the day's digest with "nothing today".
        if not args.watch_only or stored:
            write_digest(hub, run_id, stored)
        notify(hub, stored, counts)
        email_digests(hub, counts)
        finish_run(hub, run_id, "ok", counts, last_act=last_act)
        log(
            f"done: {counts['written']} verified, {counts['reported']} reported, {counts['pending']} pending retry, "
            f"{counts['rejected']} rejected, {counts['known']} already known, {counts['found']} seen"
        )
        return 0

    except Exception as err:  # noqa: BLE001 — the run row must record why it died
        log(f"FAILED: {err}")
        finish_run(hub, run_id, "failed", counts, error=str(err))
        return 1


if __name__ == "__main__":
    sys.exit(main())
