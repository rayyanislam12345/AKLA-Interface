#!/usr/bin/env python3
"""Build a findings register (Excel) in AKLA house format from a YAML file.

    python3 scripts/build_findings_register.py findings.yaml "Findings Register [AKLA].xlsx" --sheet Findings

The YAML holds `findings:` — a list of rows. A row is either a list in column
order, or a mapping keyed by the column names below (missing keys are blank):

  ID, Date, Source document, Clause, Finding, Affects, Consequence / action, Implemented in, Status

Status values Open / Implemented / Info are colour-coded. Refuses to run if the
workbook is open in Excel (lock file present), so annotations are never overwritten.
"""
import argparse, sys
from pathlib import Path
import yaml
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

HEAD = ["ID", "Date", "Source document", "Clause", "Finding", "Affects", "Consequence / action", "Implemented in", "Status"]
WIDTHS = [7, 11, 30, 22, 70, 9, 55, 34, 13]
FILLS = {"Open": "FCE4D6", "Implemented": "E2EFDA", "Info": "DDEBF7"}

def row_of(r):
    if isinstance(r, dict):
        return [r.get(h, "") for h in HEAD]
    return list(r) + [""] * (len(HEAD) - len(r))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="findings.yaml")
    ap.add_argument("out", help="output .xlsx")
    ap.add_argument("--sheet", default="Findings")
    a = ap.parse_args()
    out = Path(a.out)
    if (out.parent / ("~$" + out.name)).exists():
        sys.exit(f"{out.name} is open in Excel; close it first.")
    data = yaml.safe_load(Path(a.source).read_text(encoding="utf-8"))
    rows = [row_of(r) for r in (data.get("findings", data) if isinstance(data, dict) else data)]
    wb = Workbook(); ws = wb.active; ws.title = a.sheet
    ws.append(HEAD)
    for r in rows:
        ws.append(r)
    navy = PatternFill("solid", fgColor="1F3864")
    for c in ws[1]:
        c.fill, c.font = navy, Font(bold=True, color="FFFFFF", name="Arial", size=10)
        c.alignment = Alignment(vertical="center", wrap_text=True)
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.font = Font(name="Arial", size=9)
            c.alignment = Alignment(vertical="top", wrap_text=True)
        st = row[-1].value
        if st in FILLS:
            row[-1].fill = PatternFill("solid", fgColor=FILLS[st])
    for i, w in enumerate(WIDTHS, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    print(f"{out}  ({len(rows)} findings)")

if __name__ == "__main__":
    main()
