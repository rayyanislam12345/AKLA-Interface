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
import html
import json
import os
import re
import sys
import tempfile
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR))
from supabase_io import SupabaseClient, _request_with_retry  # noqa: E402

load_dotenv(SCRIPT_DIR / ".env")

# Haiku for the sweeps (many cheap calls, same model statuteResolver.ts and
# scrape.py already use for this kind of locate-and-classify work); Sonnet
# for the digest, which is prose a person actually reads every morning.
SWEEP_MODEL = "claude-haiku-4-5-20251001"
DIGEST_MODEL = "claude-sonnet-5"

FINDING_SCHEMA = (
    '[{"title": string, "authority_ref": string|null, "update_type": '
    '"consolidated_replacement"|"amending_instrument"|"new_act"|"bill"|"notice", '
    '"act_name": string|null, "summary": string, "source_url": string, '
    '"document_url": string|null, "published_date": "YYYY-MM-DD"|null, '
    '"confidence": "high"|"medium"|"low"}]'
)

UPDATE_TYPES = {
    "consolidated_replacement",
    "amending_instrument",
    "new_act",
    "bill",
    "notice",
}


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


def ai_call(model: str, system: str, user: str, *, max_tokens: int = 2000, web_search_uses: int = 0) -> str | None:
    """One Claude call, optionally with the hosted web_search tool. Returns
    None rather than raising, so one bad call degrades that sweep instead of
    taking the whole morning's run down."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log("  ANTHROPIC_API_KEY not set — cannot search")
        return None

    body: dict = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    if web_search_uses:
        body["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": web_search_uses}]

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
        log(f"  AI call failed: {err}")
        return None

    # With a server-side tool in play the earlier text blocks are the model's
    # own search narration — the answer is the LAST text block, not the first.
    # (Same gotcha documented in statuteResolver.ts.)
    blocks = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    return blocks[-1].strip() if blocks else None


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
            "- 'bill' = a proposed law that has NOT been enacted\n"
            "- 'notice' = a circular, notification, guideline, press release or SRO that "
            "does not itself amend an Act's text\n"
            "- 'amending_instrument' = an instrument that amends a named existing Act\n"
            "- 'consolidated_replacement' = a newly issued full consolidated text of an "
            "existing Act\n"
            "- 'new_act' = a newly enacted Act\n\n"
            f"Respond with ONLY a JSON array, no other text, matching:\n{FINDING_SCHEMA}\n\n"
            "'act_name' is the existing Act this affects, or null. 'authority_ref' is the "
            "official reference (SRO/circular/notification number) if there is one. Return "
            "[] if there is genuinely nothing new."
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


def sweep_act(act_name: str) -> list[dict]:
    """'Has this specific Act been amended or replaced?'"""
    reply = ai_call(
        SWEEP_MODEL,
        system=(
            "You check whether a specific Pakistani statute has changed. Search the web for "
            "any amendment, ordinance, consolidated re-issue or repeal affecting the named "
            "Act. Only report a change you found an actual official document or page for, "
            "with a working URL. If the Act appears unchanged, return [].\n\n"
            "Be precise about the distinction between an amending instrument (a separate "
            "short instrument that amends the Act) and a consolidated replacement (a newly "
            "published full text of the Act as amended). Do not report the Act's own "
            "original enactment as a change.\n\n"
            f"Respond with ONLY a JSON array, no other text, matching:\n{FINDING_SCHEMA}\n\n"
            "Set 'act_name' to the Act named below, exactly as given."
        ),
        user=f"Act: {act_name}\n\nHas it been amended, replaced or repealed in the last 2 years?",
        web_search_uses=3,
    )
    findings = parse_findings(reply)
    for f in findings:
        # The library keys everything on this exact string; never let the
        # model rename an Act out from under its matters.
        f["act_name"] = act_name
    return findings


# ------------------------------------------------------------ the evidence


def fetch_document(url: str, allowed_domains: list[str]) -> tuple[str | None, str | None]:
    """Download a finding's source document and return its text. Returns
    (text, None) or (None, reason). Nothing gets written to the database
    without passing through here first."""
    host = (urlparse(url).hostname or "").lower()
    if not any(host == d or host.endswith("." + d) for d in allowed_domains):
        return None, f"domain not allowlisted ({host or 'no host'})"

    try:
        resp = requests.get(
            url,
            timeout=90,
            allow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible) AKLA-law-monitor"},
        )
        resp.raise_for_status()
    except requests.exceptions.RequestException as err:
        return None, f"fetch failed ({err})"

    content_type = resp.headers.get("Content-Type", "").lower()
    if "pdf" in content_type or url.lower().endswith(".pdf"):
        try:
            import pdfplumber

            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as tmp:
                tmp.write(resp.content)
                tmp.flush()
                with pdfplumber.open(tmp.name) as pdf:
                    text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        except Exception as err:  # noqa: BLE001 — a broken PDF is a rejection, not a crash
            return None, f"pdf unreadable ({err})"
    else:
        stripped = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", resp.text, flags=re.I)
        text = html.unescape(re.sub(r"<[^>]+>", " ", stripped))

    text = re.sub(r"\s+", " ", text).strip()
    if len(text) < 200:
        return None, f"document had almost no text ({len(text)} chars)"
    return text, None


def verify_finding(finding: dict, config: dict) -> tuple[bool, str, str | None]:
    """Every gate a finding must pass before it becomes a row. A sweep that
    starts hallucinating produces rejections here rather than fiction in the
    newsletter."""
    if finding.get("update_type") not in UPDATE_TYPES:
        return False, f"unknown update_type {finding.get('update_type')!r}", None
    if not finding.get("title"):
        return False, "no title", None

    url = finding.get("document_url") or finding.get("source_url")
    if not url:
        return False, "no url", None

    published = finding.get("published_date")
    if published:
        period = parse_published_period(str(published))
        if period is None:
            return False, f"unparseable published_date {published!r}", None
        first_day, latest_possible = period
        age = (date.today() - latest_possible).days
        if age > config["max_published_age_days"]:
            return False, f"published {age} days ago", None
        if (date.today() - first_day).days < -1:
            return False, f"published_date is in the future ({published})", None
        finding["published_date"] = first_day.isoformat()

    text, reason = fetch_document(url, config["allowed_domains"])
    if text is None:
        return False, reason or "could not read document", None

    # The document has to actually be the thing the model said it was.
    ref = finding.get("authority_ref")
    if ref and normalise(ref) and normalise(ref) not in normalise(text):
        return False, f"reference {ref!r} not found in the document", None
    if not ref:
        words = [w for w in re.findall(r"[A-Za-z]{4,}", finding["title"])][:6]
        hits = sum(1 for w in words if w.lower() in text.lower())
        if len(words) >= 3 and hits < 3:
            return False, "document does not match the reported title", None

    return True, "ok", text


def dedupe_key_for(finding: dict, source_name: str) -> str:
    """Without a stable key the same SECP circular gets re-reported every
    morning forever. An official reference number is the real identity of an
    instrument; the url is the fallback."""
    ref = normalise(finding.get("authority_ref") or "")
    if ref:
        return f"{normalise(source_name)}:{ref}"
    url = (finding.get("document_url") or finding.get("source_url") or "").split("?")[0].rstrip("/").lower()
    return f"url:{url}"


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
        return [r["authority_ref"] or r["title"] for r in rows if r.get("authority_ref") or r.get("title")]

    def existing_update(self, dedupe_key: str) -> dict | None:
        rows = self.get("law_updates", {"select": "*", "dedupe_key": f"eq.{dedupe_key}", "limit": "1"})
        return rows[0] if rows else None


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


def apply_library_action(hub: Hub, finding: dict, doc_text: str, update_id: str | None) -> tuple[str, str]:
    """Returns (library_action, note). Bills and notices never reach the
    library; an amending instrument is added beside the Act it amends; only a
    verified consolidated re-issue replaces anything."""
    kind = finding["update_type"]
    act_name = finding.get("act_name")
    title = finding["title"]
    source_url = finding.get("source_url") or finding.get("document_url")

    if kind in ("bill", "notice"):
        return "skipped", "bills and notices never enter the library"

    if kind == "new_act":
        # Reported in the digest so a lawyer can add it deliberately; adding
        # every newly enacted Act automatically would grow the library
        # without anyone choosing to rely on it.
        return "none", "new Act reported for review, not auto-added"

    if kind == "amending_instrument":
        if not act_name:
            return "none", "no principal Act identified"
        if hub.act_chunks(title):
            return "skipped", "already in the library"
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
        return "ingested_amendment", f"added as its own library entry, amending {act_name}"

    # consolidated_replacement — the only path that overwrites.
    if not act_name:
        return "none", "no Act named"
    existing = hub.act_chunks(act_name)
    if not existing:
        return "none", "Act is not in the library"

    if looks_like_amendment(title):
        return "skipped", f"title reads as an amending instrument, not a consolidation: {title}"

    old_text = "\n\n".join(c["content"] for c in existing)
    ratio = len(doc_text) / max(len(old_text), 1)
    if not 0.6 <= ratio <= 1.4:
        return "skipped", f"length {ratio:.0%} of the stored text — too different to be a re-issue"

    ok, note = confirm_consolidated(act_name, title, doc_text)
    if not ok:
        return "skipped", note

    # Ingest FIRST, verify, and only then remove the old chunks: a failure
    # part-way through leaves the Act with its previous text rather than
    # with none at all.
    batch_id = str(uuid.uuid4())
    old_ids = [c["id"] for c in existing]
    log(f"    replacing {act_name}: {len(existing)} old chunks -> new batch {batch_id[:8]}")
    if hub.dry_run:
        return "replaced_act", f"[dry run] would replace {len(existing)} chunks"

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
        return "failed", "new text did not ingest — old text left in place"

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
    return "replaced_act", f"replaced {len(existing)} chunks with {len(fresh)} (previous text archived)"


# --------------------------------------------------------------- the digest


def write_digest(hub: Hub, run_id: str | None, findings: list[dict]) -> None:
    today = date.today().isoformat()
    if findings:
        listing = "\n\n".join(
            f"- {f['title']} ({f['source_name']}, {f['update_type']})\n"
            f"  ref: {f.get('authority_ref') or 'n/a'}; published: {f.get('published_date') or 'unknown'}\n"
            f"  affects: {f.get('act_name') or 'no Act in our library'}\n"
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
                "bullet per development saying what changed and what it affects.\n\n"
                "Rules: state clearly when something is a BILL or proposal that is not yet "
                "law. Say when a development affects an Act the firm holds in its library, "
                "and when it does not. Do not invent detail beyond what you are given. If "
                "the firm's library was updated automatically, mention it plainly."
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Daily legal-update monitor")
    parser.add_argument("--dry-run", action="store_true", help="search and verify, but write nothing")
    parser.add_argument("--sources-only", action="store_true", help="skip the rotating library sweep")
    parser.add_argument("--acts-only", action="store_true", help="skip the source sweep")
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
    log(f"run {run_id or '(dry run)'} starting")

    counts = {"found": 0, "written": 0, "rejected": 0, "sources": 0, "acts": 0}
    stored: list[dict] = []
    last_act: str | None = None

    try:
        candidates: list[tuple[dict, str]] = []

        if not args.acts_only:
            for source in config["sources"]:
                log(f"source sweep: {source['name']}")
                found = sweep_source(source, hub.known_refs(source["name"]), config["lookback_days"])
                counts["sources"] += 1
                log(f"  {len(found)} candidate(s)")
                candidates += [(f, source["name"]) for f in found]

        if not args.sources_only:
            previous = hub.get(
                "law_monitor_runs",
                {"select": "library_cursor", "status": "eq.ok", "order": "started_at.desc", "limit": "1"},
            )
            cursor = previous[0]["library_cursor"] if previous else None
            for act in select_acts(hub, config, cursor):
                log(f"library sweep: {act}")
                found = sweep_act(act)
                counts["acts"] += 1
                last_act = act
                if found:
                    log(f"  {len(found)} candidate(s)")
                candidates += [(f, config["library_source_name"]) for f in found]

        counts["found"] = len(candidates)
        log(f"{len(candidates)} candidate(s) to verify")

        for finding, source_name in candidates:
            title = str(finding.get("title", ""))[:90]
            key = dedupe_key_for(finding, source_name)

            if hub.existing_update(key):
                log(f"  already known, refreshing last seen: {title}")
                hub.patch(
                    "law_updates",
                    {"dedupe_key": f"eq.{key}"},
                    {"last_seen_at": datetime.now(timezone.utc).isoformat()},
                )
                continue

            ok, reason, doc_text = verify_finding(finding, config)
            if not ok:
                counts["rejected"] += 1
                log(f"  REJECTED ({reason}): {title}")
                continue

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
                "run_id": run_id,
            }
            inserted = hub.insert("law_updates", row)
            update_id = inserted["id"] if inserted else None
            counts["written"] += 1
            log(f"  CONFIRMED: {title}")

            # Isolated: refreshing the library involves an ingest call that can
            # fail on its own (no bot session configured, Voyage timeout, a
            # malformed PDF). That must cost this one finding its library
            # action, not the rest of the morning's run.
            try:
                action, note = apply_library_action(hub, finding, doc_text or "", update_id)
            except Exception as err:  # noqa: BLE001
                action, note = "failed", f"library update failed: {err}"
            log(f"    library: {action} — {note}")
            if update_id:
                hub.patch(
                    "law_updates",
                    {"id": f"eq.{update_id}"},
                    {
                        "library_action": action,
                        "library_action_at": datetime.now(timezone.utc).isoformat(),
                        "library_action_note": note,
                    },
                )
            stored.append({**row, "library_action": action, "library_action_note": note})

        write_digest(hub, run_id, stored)

        if run_id:
            hub.patch(
                "law_monitor_runs",
                {"id": f"eq.{run_id}"},
                {
                    "status": "ok",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "library_cursor": last_act,
                    "sources_checked": counts["sources"],
                    "acts_checked": counts["acts"],
                    "found": counts["found"],
                    "written": counts["written"],
                    "rejected": counts["rejected"],
                },
            )
        log(f"done: {counts['written']} written, {counts['rejected']} rejected, {counts['found']} seen")
        return 0

    except Exception as err:  # noqa: BLE001 — the run row must record why it died
        log(f"FAILED: {err}")
        if run_id:
            hub.patch(
                "law_monitor_runs",
                {"id": f"eq.{run_id}"},
                {
                    "status": "failed",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "error": str(err)[:2000],
                    "sources_checked": counts["sources"],
                    "acts_checked": counts["acts"],
                    "found": counts["found"],
                    "written": counts["written"],
                    "rejected": counts["rejected"],
                },
            )
        return 1


if __name__ == "__main__":
    sys.exit(main())
