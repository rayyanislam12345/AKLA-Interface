#!/usr/bin/env python3
"""Scan the master template and emit a deal-inputs skeleton.

    python3 read_template.py "assets/Standard Concession Agreement [AKLA].docx" -o deal.yaml
    python3 read_template.py "…docx" --inventory      # human-readable listing

Nothing is written to the template. This step only finds the blanks, works out what
kind of blank each one is, and records where it sits, so that build_agreement.py can
fill them without guessing.

Blanks are keyed by named variable rather than by position. The Agency's name has to
fill four separate slots — cover page, preamble, Schedule B and the execution block —
and asking for each one independently is how a draft ends up with a cover page that
disagrees with its signature page.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from docxlib import (
    Package, iter_paragraphs, para_text, para_style, scan_brackets,
    text_nodes, is_bold, in_revision, q,
)

# ---------------------------------------------------------------- variables

# A slot is bound to a variable when the words around it identify the value. Each
# pattern is tested against "<text before>␣<text after>", so a blank that opens a
# sentence is bound by what follows it. Order matters: first match wins.
BINDINGS: list[tuple[str, str, str]] = [
    (r"␣ having its offices at",                     "agency_name", "text"),
    (r"having its offices at ␣",                     "agency_office", "text"),
    (r"for and on behalf of the ␣",                  "government_name", "text"),
    (r"␣, a company incorporated under",             "concessionaire_name", "text"),
    (r"registered office located at ␣",              "concessionaire_office", "text"),
    (r"submitted to the Agency on ␣",                "bid_submission_date", "text"),
    (r"Sponsor\(s\) means␣|Sponsor\(s\) means ␣",    "sponsor_names", "text"),
    (r"the Government of ␣",                         "province_name", "text"),
    (r"entered into on this ␣",                      "execution_day", "text"),
    (r"on this \[Date\] of ␣",                       "execution_month", "text"),
    (r"of \[Month\], ␣",                             "execution_year", "text"),
    (r"\[Year\] at ␣",                               "execution_place", "text"),
    (r"commencing on ␣",                             "fy_start", "text"),
    (r"and ending on ␣",                             "fy_end", "text"),
    (r"␣\s*\(As The Agency\)",                       "agency_name", "text"),
    (r"␣\s*\(As The Concessionaire\)",               "concessionaire_name", "text"),
    (r"In Respect Of\s*␣",                           "project_name", "text"),
    (r"Step In Rights\s*␣",                          "step_in_rights_text", "text"),
    (r"Part B — Extension Mechanism\s*␣",            "agency_instrument_extension_text", "text"),
    (r"Concessionaire CP Failure Termination Amount\s*␣", "cp_failure_concessionaire_pct", "pct_full"),
    (r"Agency CP Failure Termination Amount\s*␣",    "cp_failure_agency_pct", "pct_full"),
]

# The execution blocks give both parties the identical phrase "For and on behalf
# of", so they are told apart by the "As the Agency" / "As the Concessionaire"
# heading that precedes each table rather than by the words around the blank.
EXECUTION = re.compile(r"For and on behalf of")
PARTY_HEADING = re.compile(r"^As the (Agency|Concessionaire)\s*$", re.I)
PARTY_VARIABLE = {"agency": "agency_name", "concessionaire": "concessionaire_name"}

# Schedule B definitions carry their blanks in pairs - "[●] percent ([●]%)",
# "PKR [●] (Pakistani Rupees [●])", "[●] ([●]) years". One number is asked for
# and the build renders each slot in the role the template gives it, in the
# house register ("thirty (30)", "PKR 1,000,000 (Pakistani Rupees One Million
# only)"). Each entry: (regex on the start of the paragraph, [(variable, role)...])
# assigned to that paragraph's value blanks in order of appearance.
TERM_BINDINGS: list[tuple[str, list[tuple[str, str]]]] = [
    (r"^Change Of Scope Advance Percentage",   [("change_of_scope_advance_pct", "pct_words"), ("change_of_scope_advance_pct", "pct_numeral")]),
    (r"^Change Of Scope Limit",                [("change_of_scope_limit_pct", "pct_numeral")]),
    (r"^Daily Development Period Damages",     [("daily_development_damages_pct", "pct_numeral")]),
    (r"^\(a\)for the period commencing from the Effective Date", [("dps_pre_commencement_pkr", "money_numeral"), ("dps_pre_commencement_pkr", "money_words")]),
    (r"^\(b\)for the period commencing from the Commencement Date", [("dps_pct_of_project_cost", "pct_words"), ("dps_pct_of_project_cost", "pct_numeral")]),
    (r"^Development Performance Security Expiry Date", [("dps_expiry_months", "numeral")]),
    (r"^Development Period Damages Cap",       [("development_damages_cap_pct", "pct_numeral")]),
    (r"^Development Progress Reporting Timeline", [("development_reporting_frequency", "words"), ("development_reporting_frequency", "numeral")]),
    (r"^Final Expiry Date",                    [("concession_years", "words"), ("concession_years", "numeral")]),
    (r"^Indemnity Survival Period",            [("indemnity_survival_years", "words"), ("indemnity_survival_years", "numeral")]),
    (r"^Maximum Extension Period",             [("max_extension_years", "words"), ("max_extension_years", "numeral")]),
    (r"^Minimum Credit Rating",                [("min_credit_rating", "text"), ("rating_agency_1", "text"), ("rating_agency_2", "text")]),
    (r"^Minimum Indemnification Amount",       [("min_indemnification_pkr", "money_numeral"), ("min_indemnification_pkr", "money_words")]),
    (r"^O&M Performance Security means",       [("om_ps_pct_of_om_costs", "pct_words"), ("om_ps_pct_of_om_costs", "pct_numeral"),
                                                ("om_ps_floor_pkr", "money_numeral"), ("om_ps_floor_pkr", "money_words"),
                                                ("om_ps_escalation_pct", "pct_numeral")]),
    (r"^O&M Status Reporting Timeline",        [("om_reporting_frequency", "words"), ("om_reporting_frequency", "numeral")]),
    (r"^Project Jurisdiction",                 [("project_city", "text")]),
    (r"^Project Modality",                     [("project_modality", "text")]),
    (r"^Project Site Land Instrument Right Period", [("site_right_period", "words"), ("site_right_period", "numeral")]),
    (r"^Relevant Environmental Protection Agency", [("environmental_agency", "text")]),
    (r"^Scheduled Commencement Date",          [("scheduled_commencement_days", "numeral")]),
    (r"^Scheduled Substantial Completion Date", [("scheduled_completion_months", "numeral")]),
    (r"the Concessionaire has obtained the Specified Concessionaire Permits", [("specified_permits_qualifier", "text")]),
    (r"^Specific Concessionaire Undertaking",  [("specific_undertaking", "text")]),
    (r"^Sponsor Base Equity Amount",           [("sponsor_base_equity_pkr", "money_numeral"), ("sponsor_base_equity_pkr", "money_words")]),
    (r"Equity IRR means",                       [("equity_irr_pct", "pct_full")]),
    (r"^Agency Funding Amount",                [("agency_funding_amount_pkr", "money_numeral"), ("agency_funding_amount_pkr", "money_words")]),
    (r"Independent Engineer with the (?:other )?counterparties", [("ie_contract_period", "text")]),
    (r"Independent Auditor with the (?:other )?counterparties",  [("ia_contract_period", "text")]),
    (r"Relief Costs only for any delays that directly result from", [("relief_costs_trigger", "text")]),
]

# Each "Band N:" label in the Schedule R revenue table is followed by two cells,
# Concessionaire share then Agency share, each reading "[●]% — insert from
# Financial Model". They are bound in that order off the label.
BAND_VARS = [["band1_concessionaire_pct", "band1_agency_pct"],
             ["band2_concessionaire_pct", "band2_agency_pct"],
             ["band3_concessionaire_pct", "band3_agency_pct"]]

# Not a blank at all: the sentence in Schedule B that explains what [●] means.
NOT_A_BLANK = re.compile(r"All \[●\] placeholders are mandatory")

TEXT_ROLES = {"text", "numeral", "words", "pct_numeral", "pct_words", "pct_full",
              "pct_sign", "money_numeral", "money_words"}

DESCRIPTIONS = {
    "agency_name":          "Procuring agency's full legal name",
    "concessionaire_name":  "Concessionaire SPV's full legal name",
    "project_name":         "Project name as it appears on the cover",
    "province_name":        "Province or territory of the Government",
    "government_name":      "Government the Agency acts for",
    "agency_office":        "Agency's office address",
    "concessionaire_office":"Concessionaire's registered office address",
    "bid_submission_date":  "Bid Submission Date",
    "sponsor_names":        "Sponsor(s)",
    "execution_day":        "Day of execution, e.g. 21st",
    "execution_month":      "Month of execution",
    "execution_year":       "Year of execution",
    "execution_place":      "Place of execution, e.g. Karachi",
    "fy_start":             "Accounting Year start, e.g. 1 July",
    "fy_end":               "Accounting Year end, e.g. 30 June",
    "execution_party":      "Party name in the execution block",
    "cover_date":           "Date on the cover page, e.g. May 21, 2026",
}

CONDITIONAL = re.compile(r"\[Conditional Amendment\s*[—-]\s*([^\]]+)\]", re.I)
INTERNAL_NOTE = re.compile(
    r"\bADB\b|to be discussed|drafting note|input required|\bTBD\b|to be confirmed"
    r"|to be added|to be checked|is taken from|not dicussed|not discussed"
    r"|Concession Ag?reement\b.*\d|^\s*(?:Islamabad Airport|NED|TP ?1|Hubcanal)\b",
    re.I,
)


# ---------------------------------------------------------------- zones

def zones(doc) -> list[tuple[object, str]]:
    """Pair every paragraph with the Article or Schedule it belongs to."""
    out, zone = [], "Preamble"
    for p in iter_paragraphs(doc):
        txt = para_text(p).strip()
        m = re.match(r"^(Schedule [A-Z])\b\s*[–-]\s*(.+)$", txt)
        if m:
            zone = f"{m.group(1)} ({m.group(2).strip()})"
        elif para_style(p) == "Heading1" and txt:
            zone = f"Article: {txt}"
        out.append((p, zone))
    return out


# ---------------------------------------------------------------- scan

def scan(pkg: Package) -> dict:
    doc = pkg.document()
    paired = zones(doc)
    slots, party, band_queue = [], None, []

    for idx, (p, zone) in enumerate(paired):
        txt = para_text(p)
        if NOT_A_BLANK.search(txt):
            continue
        heading = PARTY_HEADING.match(txt.strip())
        if heading:
            party = heading.group(1).lower()
        m = re.match(r"^Band (\d):", txt)
        if m:
            band_queue = [(v, "pct_sign") for v in BAND_VARS[int(m.group(1)) - 1]]
        term_roles: list[tuple[str, str]] = []
        for pat, roles in TERM_BINDINGS:
            if re.search(pat, txt):
                term_roles = list(roles)
                break
        if not term_roles and band_queue and txt.startswith("[●]% — insert"):
            term_roles = [band_queue.pop(0)]
        tokens = list(scan_brackets(p))
        # the cover date is a run of underscores rather than a bracket
        m_date = re.search(r"_{5,}", txt)
        if m_date and txt.strip().startswith("Dated"):
            tokens.append((m_date.start(), m_date.end(), m_date.group(0), "value"))
            term_roles = [("cover_date", "text")]
        for start, end, token, cls in tokens:
            # Schedule R cells read "[●]% — insert from Financial Model"; the
            # instruction has to go with the blank, so the token is widened.
            tail = "% — insert from Financial Model"
            if cls == "value" and txt[end:end + len(tail)] == tail:
                end += len(tail)
                token = txt[start:end]
            before = txt[max(0, start - 90):start]
            after = txt[end:end + 90]
            # The execution blocks split "For and on behalf of" / "[•]" /
            # "through its authorised signatory" across three paragraphs, so a
            # slot with nothing either side of it borrows its neighbours' text.
            if not before.strip():
                before = _neighbour(paired, idx, -1) + " " + before
            if not after.strip():
                after = after + " " + _neighbour(paired, idx, +1)

            window = f"{before[-70:]}␣{after[:70]}"
            var, role = "", "text"
            if cls == "value":
                if term_roles:
                    var, role = term_roles.pop(0)
                elif EXECUTION.search(window) and party:
                    var = PARTY_VARIABLE[party]
                else:
                    for pat, v, r in BINDINGS:
                        if re.search(pat, window):
                            var, role = v, r
                            break

            node = _node_at(p, start)
            slots.append({
                "id": f"s{idx:04d}_{start:03d}",
                "class": cls,
                "zone": zone,
                "token": token,
                "start": start,
                "end": end,
                "variable": var,
                "role": role,
                "description": DESCRIPTIONS.get(var, ""),
                "context": window.strip(),
                "bold": bool(node is not None and is_bold(node)),
                "revision": (in_revision(node) if node is not None else None),
                "para_index": idx,
                "para_hash": _hash(txt),
            })

    return {
        "slots": slots,
        "conditionals": conditionals(pkg),
        "footnotes": footnote_census(pkg),
    }


def _neighbour(paired, idx: int, step: int, span: int = 3) -> str:
    """Text of the nearest non-empty paragraph in one direction."""
    i = idx + step
    while 0 <= i < len(paired) and abs(i - idx) <= span:
        t = para_text(paired[i][0]).strip()
        if t:
            return t[-90:] if step < 0 else t[:90]
        i += step
    return ""


def _node_at(p, offset: int):
    pos = 0
    for t in text_nodes(p):
        n = len(t.text or "")
        if pos <= offset < pos + n:
            return t
        pos += n
    return None


def _hash(text: str) -> str:
    import hashlib
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------- footnotes

def _footnotes(pkg: Package):
    if not pkg.has("word/footnotes.xml"):
        return []
    root = pkg.xml("word/footnotes.xml")
    out = []
    for fn in root.findall(q("footnote")):
        if fn.get(q("type")) is not None:
            continue
        text = " ".join((t.text or "") for t in fn.iter(q("t"))).strip()
        out.append((fn.get(q("id")), text))
    return out


def conditionals(pkg: Package) -> list[dict]:
    """The drafting guide the firm wrote into the footnotes.

    Each one names a condition and the amendment to make if it holds. These become
    questions at intake; they are never inferred from the deal facts.
    """
    out = []
    for fid, text in _footnotes(pkg):
        m = CONDITIONAL.search(text)
        if m:
            out.append({
                "id": fid,
                "condition": m.group(1).strip(),
                "instruction": CONDITIONAL.sub("", text).strip(),
                "apply": None,
            })
    return out


def footnote_census(pkg: Package) -> dict:
    internal, substantive, conditional = [], [], []
    for fid, text in _footnotes(pkg):
        if CONDITIONAL.search(text):
            conditional.append(fid)
        elif not text or INTERNAL_NOTE.search(text):
            internal.append(fid)
        else:
            substantive.append(fid)
    return {"internal": internal, "substantive": substantive, "conditional": conditional}


# ---------------------------------------------------------------- output

def to_yaml(data: dict) -> str:
    """Hand-rolled so the skill has no dependency beyond python-docx and lxml."""
    varmap: dict[str, dict] = {}
    for s in data["slots"]:
        if s["class"] == "value" and s["variable"]:
            v = varmap.setdefault(s["variable"], {"desc": s["description"], "slots": [],
                                                  "zone": s["zone"], "role": s["role"],
                                                  "context": s["context"], "revision": s["revision"]})
            v["slots"].append(s["id"])

    HINT = {"numeral": "a number", "words": "a number", "pct_numeral": "a percentage, number only",
            "pct_words": "a percentage, number only", "pct_full": "a percentage, number only",
            "pct_sign": "a percentage, number only", "money_numeral": "an amount in PKR, digits only",
            "money_words": "an amount in PKR, digits only", "text": "text"}

    L = [
        "# Deal inputs for the AKLA standard concession agreement.",
        "# Fill a value to have it inserted. Leave it blank and the [●] stays in the",
        "# draft and is reported as an open item. Never guess a commercial term.",
        "# Numbers are given once as digits; the build writes them out in words where",
        "# the template does (\"thirty (30)\", \"PKR 1,000,000 (Pakistani Rupees One",
        "# Million only)\").",
        "",
        "variables:",
    ]
    cur = None
    for name, info in sorted(varmap.items(), key=lambda kv: (kv[1]["zone"], kv[0])):
        if info["zone"] != cur:
            cur = info["zone"]
            L.append(f"\n  # ---- {cur}")
        desc = info["desc"] or info["context"][:88]
        L.append(f"  # {desc}  [{HINT.get(info['role'], 'text')}; {len(info['slots'])} slot(s)]")
        if info["revision"]:
            L.append("  # NOTE: this blank sits inside a tracked change; resolve the revision first")
        L.append(f"  {name}: \"\"")
    L += ["", "# Blanks with no variable bound. Key is the slot id from --inventory.", "slots:"]
    for s in data["slots"]:
        if s["class"] == "value" and not s["variable"]:
            L.append(f"  # {s['zone']} :: {s['context'][:88]}")
            L.append(f"  {s['id']}: \"\"")

    L += ["", "# Choices. Replace with one limb of the alternative.", "choices:"]
    for s in data["slots"]:
        if s["class"] in ("choice", "optional"):
            L.append(f"  # {s['zone']} :: {s['token'][:96]}")
            L.append(f"  {s['id']}: \"\"")

    L += ["", "# Conditional amendments from the template's own footnotes.",
          "# Set true only on explicit instruction. Never inferred.", "conditionals:"]
    for c in data["conditionals"]:
        L.append(f"  # {c['condition']}")
        L.append(f"  fn{c['id']}: false")

    L += ["", "options:",
          "  strip_internal_footnotes: true   # 102 internal notes; see SKILL.md",
          "  update_fields: true              # rebuild the TOC when Word opens the file",
          ""]
    return "\n".join(L)


def inventory(data: dict) -> str:
    L, cur = [], None
    counts: dict[str, int] = {}
    for s in data["slots"]:
        counts[s["class"]] = counts.get(s["class"], 0) + 1
        if s["zone"] != cur:
            cur = s["zone"]
            L.append(f"\n{cur}")
            L.append("-" * len(cur))
        flag = " [IN REVISION]" if s["revision"] else ""
        bold = " bold" if s["bold"] else ""
        L.append(f"  {s['id']}  {s['class']:<9}{bold:<5}{flag} {s['token'][:60]}")
        if s["variable"]:
            L.append(f"{'':>16}-> {s['variable']}")
        L.append(f"{'':>16}   …{s['context'][:100]}")
    fc = data["footnotes"]
    head = [
        "TEMPLATE INVENTORY",
        "==================",
        f"blanks: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())),
        f"footnotes: {len(fc['internal'])} internal, {len(fc['substantive'])} substantive, "
        f"{len(fc['conditional'])} conditional amendments",
        f"conditional amendments: {len(data['conditionals'])}",
    ]
    return "\n".join(head + L)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("template")
    ap.add_argument("-o", "--out", help="write the deal-inputs skeleton here")
    ap.add_argument("--inventory", action="store_true", help="print a human listing instead")
    ap.add_argument("--json", help="dump the raw scan as JSON")
    args = ap.parse_args()

    data = scan(Package(args.template))

    if args.json:
        Path(args.json).write_text(json.dumps(data, indent=2))
    if args.inventory:
        print(inventory(data))
        return
    text = to_yaml(data)
    if args.out:
        Path(args.out).write_text(text)
        n = sum(1 for s in data["slots"] if s["class"] == "value")
        print(f"wrote {args.out}: {n} value blanks, "
              f"{len(data['conditionals'])} conditional amendments")
    else:
        print(text)


if __name__ == "__main__":
    main()
