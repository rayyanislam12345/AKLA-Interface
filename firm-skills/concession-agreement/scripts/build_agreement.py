#!/usr/bin/env python3
"""Fill the master template from a deal-inputs file and write the draft.

    python3 build_agreement.py deal.yaml -o "Draft Concession Agreement.docx"
    python3 build_agreement.py deal.yaml -o out.docx --template "assets/Standard Concession Agreement [AKLA].docx"

The template is cloned and edited in place - never regenerated - so numbering,
styles, headers and the table of contents come through untouched. Every value in
the inputs file is written into the slots bound to it, rendered in the house
register for each slot's role. Anything left blank stays [●] and is reported.
Nothing is invented.

The build refuses to run while the template carries unresolved tracked changes
(pass --allow-revisions to override), strips the firm's internal footnotes by
default, and sets updateFields so Word rebuilds the contents page on open.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

from docxlib import (
    Package, iter_paragraphs, para_text, replace_span, render, set_update_fields, q,
)
import read_template

HERE = Path(__file__).resolve().parent
DEFAULT_TEMPLATE = HERE.parent / "assets" / "Standard Concession Agreement [AKLA].docx"


# ---------------------------------------------------------------- inputs

def load_inputs(path: str | Path) -> dict:
    """Read the deal-inputs file. PyYAML if present, else a reader for the
    skeleton this skill emits: two-level, key: value, quoted strings, booleans."""
    text = Path(path).read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(text) or {}
    except ImportError:
        data = _simple_yaml(text)
    for k in ("variables", "slots", "choices", "conditionals", "options"):
        data.setdefault(k, {}) if data.get(k) is not None else data.__setitem__(k, {})
    return data


def _simple_yaml(text: str) -> dict:
    out: dict = {}
    section = None
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip() if not raw.lstrip().startswith("#") else ""
        if not line.strip():
            continue
        if not line.startswith(" ") and line.endswith(":"):
            section = line[:-1].strip(); out[section] = {}
            continue
        m = re.match(r"^\s+([A-Za-z0-9_]+):\s*(.*)$", line)
        if m and section:
            v = m.group(2).strip()
            if v.lower() in ("true", "false"):
                val = v.lower() == "true"
            else:
                val = v.strip('"').strip("'")
            out[section][m.group(1)] = val
    return out


# ---------------------------------------------------------------- footnotes

def strip_footnotes(pkg: Package, ids: list[str]) -> int:
    if not ids or not pkg.has("word/footnotes.xml"):
        return 0
    fn = pkg.xml("word/footnotes.xml")
    wanted = set(ids)
    removed = 0
    for e in list(fn.findall(q("footnote"))):
        if e.get(q("id")) in wanted:
            fn.remove(e); removed += 1
    doc = pkg.document()
    for ref in list(doc.iter(q("footnoteReference"))):
        if ref.get(q("id")) in wanted:
            run = ref.getparent()
            if run is not None and run.tag == q("r") and not run.findall(q("t")):
                run.getparent().remove(run)
            else:
                ref.getparent().remove(ref)
    pkg.touch("word/footnotes.xml"); pkg.touch("word/document.xml")
    return removed


# ---------------------------------------------------------------- build

def build(inputs: dict, template: Path, out: Path, allow_revisions: bool,
          fill_in_revisions: bool) -> dict:
    pkg = Package(template)
    doc = pkg.document()

    ins, dele = len(list(doc.iter(q("ins")))), len(list(doc.iter(q("del"))))
    if (ins or dele) and not allow_revisions:
        print(f"REFUSED: the template carries {ins} tracked insertion(s) and {dele} tracked "
              f"deletion(s). Accept or reject them in the master first, or pass --allow-revisions.")
        sys.exit(2)

    scan = read_template.scan(pkg)
    paras = list(iter_paragraphs(doc))
    variables = {k: str(v).strip() for k, v in inputs["variables"].items() if str(v).strip()}
    choices = {k: str(v).strip() for k, v in inputs["choices"].items() if str(v).strip()}
    direct = {k: str(v).strip() for k, v in inputs.get("slots", {}).items() if str(v).strip()}

    edits: dict[int, list] = defaultdict(list)
    report = {"filled": defaultdict(list), "skipped_in_revision": [], "open": defaultdict(list),
              "choices_open": [], "choices_made": [], "stubs": [], "directives": []}
    for s in scan["slots"]:
        cls, sid = s["class"], s["id"]
        if cls == "value":
            val = variables.get(s["variable"]) if s["variable"] else direct.get(sid)
            if not val:
                report["open"][s["zone"]].append(s["context"][:80]); continue
            if s["revision"] and not fill_in_revisions:
                report["skipped_in_revision"].append((sid, s["context"][:70])); continue
            edits[s["para_index"]].append((s["start"], s["end"], render(val, s["role"]), s))
            report["filled"][s["variable"] or sid].append(sid)
        elif cls in ("choice", "optional"):
            if sid in choices:
                edits[s["para_index"]].append((s["start"], s["end"], choices[sid], s))
                report["choices_made"].append((sid, s["token"][:50], choices[sid][:50]))
            else:
                report["choices_open"].append((s["zone"], s["token"][:70]))
        elif cls == "stub":
            report["stubs"].append((s["zone"], s["token"]))
        elif cls == "directive":
            report["directives"].append((s["zone"], s["token"][:90]))

    # right-to-left within each paragraph so earlier offsets stay valid
    applied = 0
    for pidx, items in edits.items():
        p = paras[pidx]
        for start, end, text, s in sorted(items, key=lambda x: -x[0]):
            current = para_text(p)[start:end]
            if current != s["token"]:
                print(f"skipped {s['id']}: expected {s['token']!r} at offset {start}, found {current!r}")
                continue
            replace_span(p, start, end, text); applied += 1
    if applied:
        pkg.touch("word/document.xml")

    opts = inputs["options"]
    stripped = 0
    if opts.get("strip_internal_footnotes", True):
        stripped = strip_footnotes(pkg, scan["footnotes"]["internal"])
    if opts.get("update_fields", True):
        set_update_fields(pkg)

    pkg.save(out)
    report.update({"applied": applied, "stripped": stripped,
                   "kept_substantive": len(scan["footnotes"]["substantive"]),
                   "conditionals": scan["conditionals"],
                   "cond_flags": inputs["conditionals"]})
    return report


# ---------------------------------------------------------------- report

def print_report(r: dict, out: Path) -> None:
    print(f"\nwrote {out}\n")
    print(f"FILLED  {r['applied']} slot(s) from {len(r['filled'])} value(s)")
    for name, ids in sorted(r["filled"].items()):
        print(f"  {name:<36} {len(ids)} slot(s)")
    if r["skipped_in_revision"]:
        print("\nNOT FILLED - blank sits inside a tracked change; resolve the revision first")
        for sid, ctx in r["skipped_in_revision"]:
            print(f"  {sid}  …{ctx}")
    n_open = sum(len(v) for v in r["open"].values())
    print(f"\nLEFT OPEN  {n_open} value blank(s) remain as [●]")
    for zone, items in r["open"].items():
        print(f"  {zone}: {len(items)}")
        for ctx in items[:4]:
            print(f"      …{ctx}")
        if len(items) > 4:
            print(f"      … and {len(items) - 4} more")
    if r["choices_made"]:
        print(f"\nCHOICES MADE  {len(r['choices_made'])}")
        for sid, tok, val in r["choices_made"]:
            print(f"  {sid}  {tok} -> {val}")
    print(f"\nCHOICES OPEN  {len(r['choices_open'])} bracketed alternative(s) or optional block(s) untouched")
    for zone, tok in r["choices_open"][:12]:
        print(f"  {zone}: {tok}")
    print(f"\nCONDITIONAL AMENDMENTS  {len(r['conditionals'])} in the template's footnotes; none applied "
          f"automatically. Each is a question for the drafter:")
    for c in r["conditionals"]:
        flag = r["cond_flags"].get(f"fn{c['id']}")
        mark = "CONFIRMED - apply by hand" if flag else "not confirmed"
        print(f"  [{mark}] {c['condition']}")
        print(f"      {c['instruction'][:140]}")
    print(f"\nFOOTNOTES  {r['stripped']} internal note(s) removed; {r['kept_substantive']} substantive "
          f"kept; {len(r['conditionals'])} conditional-amendment note(s) kept until resolved")
    print(f"\nMANUAL ACTIONS")
    for zone, tok in r["directives"]:
        print(f"  directive to resolve in {zone}: {tok}")
    for zone, tok in r["stubs"]:
        print(f"  attachment awaited in {zone}: {tok}")
    print("  known template gaps: no Article 28 (Change in Law) in the body; see references/known-issues.md")
    print("\nNEXT  run check_agreement.py on the output with --against and --baseline before handing over.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("inputs")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--template", default=str(DEFAULT_TEMPLATE))
    ap.add_argument("--allow-revisions", action="store_true")
    ap.add_argument("--fill-in-revisions", action="store_true",
                    help="fill a blank even where it sits inside a tracked change")
    args = ap.parse_args()
    r = build(load_inputs(args.inputs), Path(args.template), Path(args.out),
              args.allow_revisions, args.fill_in_revisions)
    print_report(r, Path(args.out))


if __name__ == "__main__":
    main()
