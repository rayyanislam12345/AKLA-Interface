#!/usr/bin/env python3
"""Walks a folder of old firm documents, groups draft versions of the same
document (picking only the latest), classifies each survivor's agreement
type (filename match, then an LLM fallback that can also flag "not an
agreement" or propose a new type), and — only once you re-run with
--confirm after reviewing the report — ingests the result into the app's
precedent library via the same Storage/Edge Function pipeline the UI uses.

    python3 ingest.py --scan "/Volumes/My Passport/AY - AKLA/Malir Expressway Phase 1"
    python3 ingest.py --scan "<same path>" --confirm
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from dotenv import load_dotenv

import filenames
import classify
from supabase_io import SupabaseClient

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(SCRIPT_DIR, ".env"))

MANIFEST_PATH = os.path.join(SCRIPT_DIR, "manifest.json")
REPORT_PATH = os.path.join(SCRIPT_DIR, "report.json")


def load_manifest() -> dict:
    if os.path.exists(MANIFEST_PATH):
        with open(MANIFEST_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_manifest(manifest: dict):
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, default=str)


def manifest_key(path: str, mtime: float) -> str:
    return f"{path}::{mtime}"


def is_under(path: str, root: str) -> bool:
    """Proper path-boundary containment — a bare .startswith(root) would
    wrongly match a sibling folder that happens to share a string prefix
    (e.g. scanning ".../Phase 1" must not pull in ".../Phase 10")."""
    return path == root or path.startswith(root + os.sep)


def walk_files(root: str):
    for dirpath, _dirnames, fnames in os.walk(root):
        for fname in fnames:
            if filenames.is_lock_file(fname) or not filenames.is_supported(fname):
                continue
            yield os.path.join(dirpath, fname)


def extract_snippet(path: str, ext: str) -> str:
    try:
        if ext == "docx":
            import docx
            doc = docx.Document(path)
            return "\n".join(p.text for p in doc.paragraphs)[:3000]
        if ext == "pdf":
            import pdfplumber
            text = ""
            with pdfplumber.open(path) as pdf:
                for page in pdf.pages[:3]:
                    text += (page.extract_text() or "") + "\n"
                    if len(text) > 3000:
                        break
            return text[:3000]
    except Exception as err:
        print(f"  (couldn't extract text from {os.path.basename(path)}: {err})", file=sys.stderr)
    return ""


def classify_winner(candidate, folder_name, alias_table, document_types, anthropic_client) -> dict:
    row = {
        "path": candidate.path,
        "filename": candidate.filename,
        "folder": folder_name,
    }
    dt = classify.tier1_match(candidate.stem, folder_name, alias_table)
    if dt:
        row.update(outcome="pending_ingest", tier=1, document_type_id=dt["id"], document_type_name=dt["name"])
        return row

    if not anthropic_client:
        # Deliberately a different outcome than "unclear" (which means tier
        # 2 genuinely couldn't tell) — this file was never actually
        # attempted, so it must stay eligible for re-classification once a
        # key is configured, unlike every other terminal outcome here.
        row.update(outcome="retry_needed", tier=None, reasoning="No ANTHROPIC_API_KEY configured for tier-2 classification.")
        return row

    snippet = extract_snippet(candidate.path, candidate.ext)
    try:
        result = classify.tier2_classify(anthropic_client, candidate.filename, folder_name, snippet, document_types)
    except Exception as err:
        # One bad call (rate limit, network hiccup, a malformed response)
        # must not crash a scan that could be classifying hundreds of
        # files — falls back to retry_needed-style retry eligibility
        # instead of a hard "unclear" so it's picked up again next run.
        print(f"  (tier-2 classification failed for {candidate.filename}: {err})", file=sys.stderr)
        row.update(outcome="retry_needed", tier=None, reasoning=f"Tier-2 call failed, will retry: {err}")
        return row

    if not result.is_agreement:
        row.update(outcome="not_an_agreement", tier=2, reasoning=result.reasoning)
    elif result.existing_type_id:
        match = next((d for d in document_types if d["id"] == result.existing_type_id), None)
        row.update(
            outcome="pending_ingest", tier=2,
            document_type_id=result.existing_type_id,
            document_type_name=match["name"] if match else None,
            reasoning=result.reasoning,
        )
    elif result.proposed_type_name:
        row.update(
            outcome="pending_ingest_new_type", tier=2,
            proposed_type_name=result.proposed_type_name,
            proposed_type_category=result.proposed_type_category,
            reasoning=result.reasoning,
        )
    else:
        row.update(outcome="unclear", tier=2, reasoning=result.reasoning)
    return row


def scan(root: str, manifest: dict, sb: SupabaseClient, anthropic_client, alias_table, document_types):
    all_paths = list(walk_files(root))
    print(f"Found {len(all_paths)} supported file(s) under {root}")

    # Grouping runs over EVERY file found, not just unprocessed ones — a
    # later draft arriving after its earlier sibling was already processed
    # must still be recognized as superseding it, not classified as if it
    # were an unrelated new document.
    candidates = [filenames.build_candidate(p) for p in all_paths]
    groups = filenames.group_candidates(candidates)

    resolved = 0
    newly_classified = 0
    for (folder, _key), group in groups.items():
        winner, superseded = filenames.resolve_group(group)
        winner_key = manifest_key(winner.path, winner.mtime)
        winner_entry = manifest.get(winner_key)

        # Retry-eligible: never actually attempted tier 2 (no key at the
        # time), so it must stay open to reclassification once one exists.
        needs_classification = winner_entry is None or (
            winner_entry.get("outcome") == "retry_needed" and anthropic_client is not None
        )

        for loser in superseded:
            loser_key = manifest_key(loser.path, loser.mtime)
            existing = manifest.get(loser_key)
            if existing and existing.get("outcome") == "ingested":
                print(
                    f"WARNING: {os.path.basename(loser.path)} was already ingested but is now "
                    f"superseded by {os.path.basename(winner.path)} — left as-is; review manually "
                    f"if the earlier draft should be removed from the precedent library."
                )
                continue
            manifest[loser_key] = {
                "path": loser.path, "outcome": "superseded_by", "superseded_by": winner.path,
            }

        if needs_classification:
            folder_name = os.path.basename(folder)
            row = classify_winner(winner, folder_name, alias_table, document_types, anthropic_client)
            manifest[winner_key] = row
            newly_classified += 1
            # A full scan can be hundreds of LLM calls — save incrementally
            # so a crash/interrupt partway through doesn't lose progress
            # already paid for.
            if newly_classified % 20 == 0:
                save_manifest(manifest)
                print(f"  ...{newly_classified} classified so far, manifest saved")
        else:
            resolved += 1

    print(f"{resolved} group(s) already resolved, {newly_classified} newly classified")
    save_manifest(manifest)


def write_report(manifest: dict, root: str):
    rows = [v for v in manifest.values() if is_under(v.get("path", ""), root)]
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, default=str)

    by_outcome: dict[str, list] = {}
    for row in rows:
        by_outcome.setdefault(row["outcome"], []).append(row)

    print(f"\n=== Report for {root} ({len(rows)} file(s)) ===")
    outcome_order = [
        "pending_ingest", "pending_ingest_new_type", "not_an_agreement",
        "unclear", "retry_needed", "superseded_by", "ingested", "failed",
    ]
    for outcome in outcome_order:
        group = by_outcome.get(outcome, [])
        if not group:
            continue
        print(f"\n-- {outcome} ({len(group)}) --")
        for row in group:
            label = os.path.basename(row["path"])
            if outcome in ("pending_ingest", "ingested"):
                print(f"  {label}  ->  {row.get('document_type_name')}")
            elif outcome == "pending_ingest_new_type":
                print(f"  {label}  ->  NEW: {row.get('proposed_type_name')} ({row.get('proposed_type_category')})")
            elif outcome == "superseded_by":
                print(f"  {label}  ->  superseded by {os.path.basename(row['superseded_by'])}")
            elif outcome in ("not_an_agreement", "unclear", "retry_needed", "failed"):
                print(f"  {label}  ->  {row.get('reasoning', row.get('error', ''))}")
    unaccounted = set(by_outcome) - set(outcome_order)
    if unaccounted:
        print(f"\n(unrecognized outcome types in manifest, not shown above: {unaccounted})")
    print(f"\nFull detail written to {REPORT_PATH}")


def confirm(manifest: dict, root: str, sb: SupabaseClient, only_existing_types: bool = False):
    outcomes = ("pending_ingest",) if only_existing_types else ("pending_ingest", "pending_ingest_new_type")
    pending = [
        (key, row) for key, row in manifest.items()
        if is_under(row.get("path", ""), root) and row["outcome"] in outcomes
    ]
    if only_existing_types:
        print(f"{len(pending)} file(s) matching EXISTING types to ingest under {root} (new-type proposals held back)")
    else:
        print(f"{len(pending)} file(s) to ingest under {root}")

    # Many files independently propose the same new type name (tier 2 has
    # no memory of what earlier files in this run already proposed) —
    # create each unique name once, seeded from what already exists so a
    # re-run of --confirm can't create it twice either.
    existing_by_name = {dt["name"].lower(): dt for dt in sb.list_document_types()}

    for i, (key, row) in enumerate(pending, 1):
        try:
            document_type_id = row.get("document_type_id")
            if row["outcome"] == "pending_ingest_new_type":
                name_key = row["proposed_type_name"].lower()
                if name_key in existing_by_name:
                    document_type_id = existing_by_name[name_key]["id"]
                else:
                    created = sb.create_document_type(row["proposed_type_name"], row["proposed_type_category"])
                    document_type_id = created["id"]
                    existing_by_name[name_key] = created
                    print(f"Created new document type: {row['proposed_type_name']} ({row['proposed_type_category']})")

            with open(row["path"], "rb") as f:
                data = f.read()
            storage_path = sb.upload_precedent_file(document_type_id, row["filename"], data)
            ext = row["filename"].rsplit(".", 1)[-1]
            sb.process_document(storage_path, row["filename"], ext, document_type_id)

            row["outcome"] = "ingested"
            row["document_type_id"] = document_type_id
            manifest[key] = row
            print(f"Ingested: {row['filename']}")
        except Exception as err:
            row["outcome"] = "failed"
            row["error"] = str(err)
            manifest[key] = row
            print(f"FAILED: {row['filename']}: {err}", file=sys.stderr)

        # A long confirm run over many files could be interrupted partway —
        # save incrementally so nothing already-uploaded gets silently
        # forgotten (and re-uploaded as a duplicate) on the next attempt.
        if i % 10 == 0:
            save_manifest(manifest)

    save_manifest(manifest)


def consolidate_types(manifest: dict, root: str, anthropic_client):
    """Different files propose the same real agreement type with slightly
    different wording (tier 2 has no memory across files) — one LLM pass
    over the full unique-name list groups near-duplicates under a single
    canonical name/category before --confirm ever creates anything."""
    if not anthropic_client:
        sys.exit("ANTHROPIC_API_KEY must be set to consolidate proposed types.")

    rows = [
        (key, row) for key, row in manifest.items()
        if is_under(row.get("path", ""), root) and row["outcome"] == "pending_ingest_new_type"
    ]
    if not rows:
        print("No pending new-type proposals to consolidate.")
        return

    by_name: dict[str, dict] = {}
    for _key, row in rows:
        name = row["proposed_type_name"]
        entry = by_name.setdefault(name, {"name": name, "category": row["proposed_type_category"], "count": 0})
        entry["count"] += 1
    proposals = sorted(by_name.values(), key=lambda p: -p["count"])
    print(f"{len(rows)} proposal(s), {len(proposals)} unique name(s) — asking Claude to group near-duplicates...")

    groups = classify.consolidate_proposed_types(anthropic_client, proposals)

    rename_map = {}
    for group in groups:
        for original in group["original_names"]:
            rename_map[original] = (group["canonical_name"], group["canonical_category"])

    changed = 0
    for key, row in rows:
        original = row["proposed_type_name"]
        canonical = rename_map.get(original)
        if canonical and canonical[0] != original:
            row["proposed_type_name"], row["proposed_type_category"] = canonical
            manifest[key] = row
            changed += 1
    save_manifest(manifest)

    print(f"\n=== Consolidated into {len(groups)} type(s) (was {len(proposals)} unique names, {changed} row(s) remapped) ===")
    for group in sorted(groups, key=lambda g: -len(g["original_names"])):
        print(f"\n{group['canonical_name']} ({group['canonical_category']})")
        for original in group["original_names"]:
            count = by_name.get(original, {}).get("count", "?")
            marker = "" if original == group["canonical_name"] else "  <- merged"
            print(f"  - {original} ({count}x){marker}")


def main():
    parser = argparse.ArgumentParser(description="Precedent backlog ingestion tool")
    parser.add_argument("--scan", required=True, help="Folder to walk (e.g. a path on the Passport drive)")
    parser.add_argument("--confirm", action="store_true", help="Act on already-classified pending files instead of (re-)scanning")
    parser.add_argument("--only-existing-types", action="store_true", help="With --confirm, ingest only files matched to existing types — hold back new-type proposals")
    parser.add_argument("--consolidate-types", action="store_true", help="Group near-duplicate proposed new type names before --confirm")
    args = parser.parse_args()

    root = os.path.abspath(args.scan)
    if not os.path.isdir(root):
        sys.exit(f"Not a directory: {root}")

    supabase_url = os.environ.get("SUPABASE_URL")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_role_key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in scripts/precedent_backlog/.env")
    session_email = os.environ.get("SUPABASE_SESSION_EMAIL")
    session_password = os.environ.get("SUPABASE_SESSION_PASSWORD")
    if args.confirm and not (session_email and session_password):
        sys.exit(
            "SUPABASE_SESSION_EMAIL and SUPABASE_SESSION_PASSWORD must be set in scripts/precedent_backlog/.env "
            "for --confirm — process-document's internal call to ingest-documents requires a real signed-in "
            "session (a service-role key alone gets rejected by ingest-documents' own auth.getUser() check)."
        )
    sb = SupabaseClient(supabase_url, service_role_key, session_email, session_password)

    anthropic_client = None
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        from anthropic import Anthropic
        anthropic_client = Anthropic(api_key=anthropic_key)
    else:
        print("No ANTHROPIC_API_KEY set — running filename-only (tier 1). Unmatched files will be 'unclear'.")

    manifest = load_manifest()

    if args.confirm:
        confirm(manifest, root, sb, only_existing_types=args.only_existing_types)
        return

    if args.consolidate_types:
        consolidate_types(manifest, root, anthropic_client)
        return

    document_types = sb.list_document_types()
    alias_table = classify.build_alias_table(document_types)
    scan(root, manifest, sb, anthropic_client, alias_table, document_types)
    write_report(manifest, root)


if __name__ == "__main__":
    main()
