"""Agreement-type classification: tier 1 (filename match, free) then tier 2
(combined relevance + type LLM call, only for what tier 1 couldn't resolve).

Tier 2 deliberately answers "is this even an agreement?" and "which type?"
in one call rather than two — these backlog folders mix real agreements
with case law, notes, presentations, and more, so relevance can't be
assumed just because a file reached tier 2.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

MODEL = "claude-sonnet-5"


def build_alias_table(document_types: list[dict]) -> list[tuple[str, dict]]:
    """Each type matches on its own name, plus any parenthetical
    abbreviation in it (e.g. "Common Terms Agreement (CTA)" -> also "CTA").
    Longest alias first so a more specific phrase wins over a shorter one
    that happens to be a substring of it."""
    aliases = []
    for dt in document_types:
        name = dt["name"]
        aliases.append((name.lower(), dt))
        for abbr in re.findall(r"\(([A-Z]{2,})\)", name):
            aliases.append((abbr.lower(), dt))
    aliases.sort(key=lambda pair: len(pair[0]), reverse=True)
    return aliases


def tier1_match(display_name: str, folder_name: str, alias_table: list[tuple[str, dict]]):
    haystack = f"{folder_name} {display_name}".lower()
    for alias, dt in alias_table:
        if re.search(rf"\b{re.escape(alias)}\b", haystack):
            return dt
    return None


@dataclass
class Tier2Result:
    is_agreement: bool
    existing_type_id: str | None = None
    proposed_type_name: str | None = None
    proposed_type_category: str | None = None
    reasoning: str = ""


TIER2_SYSTEM_PROMPT = """You are sorting a law firm's old case files into its agreement-type taxonomy.

You will be given a file's name, its containing folder, a short extracted text snippet, and the firm's current list of agreement types (with categories). Decide:

1. Is this file an actual agreement/contract (or a direct amendment to one)? Court case summaries, legal research/notes, meeting minutes, presentations, CVs, regulatory notices, and similar are NOT agreements — say so plainly.
2. If it IS an agreement: does it clearly match one of the existing types? If yes, return its id. If it's clearly a real, identifiable agreement type but doesn't match any existing one, propose a new type name + category — but only if you're genuinely confident what the agreement type is. If you can't confidently tell, say the type is unclear rather than guessing.

Respond with ONLY a JSON object, no other text:
{"is_agreement": true|false, "existing_type_id": "<uuid or null>", "proposed_type_name": "<string or null>", "proposed_type_category": "<string or null>", "reasoning": "<one short sentence>"}

If is_agreement is false, all type fields must be null. If is_agreement is true but you can't confidently determine or propose a type, all type fields must also be null (existing_type_id and proposed_type_name mutually exclusive — never fill both)."""


CONSOLIDATE_SYSTEM_PROMPT = """You are cleaning up a numbered list of proposed new agreement-type names for a law firm's document taxonomy. Each name was proposed independently (by separate, memoryless calls looking at one file each), so the same real agreement type often got slightly different wording — e.g. "Equity Subscription and Shareholders Agreement" and "Equity Subscription and Shareholding Agreement" are almost certainly meant to be the same type.

Group any numbers whose names refer to the same real agreement type, and pick ONE clear canonical name + category per group. Do NOT merge genuinely different agreement types just because they sound similar (e.g. "Shareholders Agreement" and "Share Purchase Agreement" are different things). If a name has no duplicates, it's its own group of one.

Respond with ONLY a JSON array, no other text:
[{"canonical_name": "...", "canonical_category": "...", "original_numbers": [1, 3, 7]}]

Refer to entries ONLY by their number — never retype the name/category text. Every input number must appear in exactly one group's original_numbers list."""


def consolidate_proposed_types(client, proposals: list[dict]) -> list[dict]:
    """proposals: [{"name": ..., "category": ..., "count": ...}]. Returns
    groups: [{"canonical_name", "canonical_category", "original_names"}]
    (translated back from the model's numeric references — see below)."""
    listing = "\n".join(f"{i}. {p['name']} ({p['category']}) — proposed {p['count']}x" for i, p in enumerate(proposals, 1))
    response = client.messages.create(
        model=MODEL,
        max_tokens=8000,
        # Confirmed in practice: with thinking left enabled (the default),
        # extended-thinking output for this many names consumed the whole
        # token budget before any actual JSON got written (stop_reason
        # came back "max_tokens" with zero text blocks). This is a
        # straightforward grouping task, not one that benefits from
        # exposed step-by-step reasoning, so thinking is turned off
        # instead of just kept raising the ceiling and hoping.
        thinking={"type": "disabled"},
        system=CONSOLIDATE_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": listing}],
    )
    # Deliberately no silent "[]" fallback here — a run that quietly
    # returns zero groups looks identical to "nothing needed merging"
    # instead of "something went wrong" (confirmed in practice: a missing
    # text block — e.g. the model's own extended-thinking output eating
    # the whole token budget with none left for the actual answer —
    # produced exactly that indistinguishable-from-success silent failure).
    text_block = next((b.text for b in response.content if b.type == "text"), None)
    if text_block is None:
        raise RuntimeError(f"No text content in Claude's response (stop_reason={response.stop_reason})")

    cleaned = re.sub(r"^```json\s*|```\s*$", "", text_block.strip())
    raw_groups = json.loads(cleaned)

    # Numbers are resolved back to names from OUR OWN authoritative list,
    # never trusted from the model's own retyped text — confirmed in
    # practice that asking it to retype "name (category)" strings produced
    # a real mismatch (it echoed the category back as part of the name).
    seen_numbers: set[int] = set()
    groups = []
    for g in raw_groups:
        numbers = g["original_numbers"]
        seen_numbers.update(numbers)
        groups.append({
            "canonical_name": g["canonical_name"],
            "canonical_category": g["canonical_category"],
            "original_names": [proposals[n - 1]["name"] for n in numbers],
        })

    expected = set(range(1, len(proposals) + 1))
    if seen_numbers != expected:
        missing = expected - seen_numbers
        extra = seen_numbers - expected
        raise RuntimeError(f"Consolidation response doesn't account for all input numbers — missing: {missing}, unexpected/out-of-range: {extra}")

    return groups


def tier2_classify(client, filename: str, folder_name: str, text_snippet: str, document_types: list[dict]) -> Tier2Result:
    types_listing = "\n".join(f"- {dt['id']}: {dt['name']} ({dt['category']})" for dt in document_types)
    user_content = (
        f"Filename: {filename}\n"
        f"Folder: {folder_name}\n"
        f"Existing agreement types:\n{types_listing}\n\n"
        f"Extracted text snippet:\n{text_snippet[:2000] or '(no text extracted)'}"
    )
    response = client.messages.create(
        model=MODEL,
        max_tokens=500,
        system=TIER2_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
    )
    text_block = next((b.text for b in response.content if b.type == "text"), "{}")
    cleaned = re.sub(r"^```json\s*|```\s*$", "", text_block.strip())
    data = json.loads(cleaned)
    return Tier2Result(
        is_agreement=bool(data.get("is_agreement")),
        existing_type_id=data.get("existing_type_id") or None,
        proposed_type_name=data.get("proposed_type_name") or None,
        proposed_type_category=data.get("proposed_type_category") or None,
        reasoning=data.get("reasoning", ""),
    )
