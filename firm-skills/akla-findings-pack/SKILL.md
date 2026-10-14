---
name: akla-findings-pack
description: Turn a structured list of findings into AKLA's internal findings register (Excel, navy header, Open / Implemented / Info colour-coded) and a short AKLA-style slide deck of numbered items, from one YAML file each. Use whenever someone has a set of review findings, issues or action points from a due diligence, a mark-up or an agreement review and wants the register, the deck, or both, in the firm's format. The memo for the same findings is written with the legal-summary skill.
---

# Findings pack: register and deck from a findings list

One source of truth, two outputs. The findings are written once as YAML; the
register and the deck are rendered from it, so a corrected finding changes
both the next time they are built. Run every command from the skill's own
directory.

## 1. Write the findings

`findings.yaml`:

```yaml
findings:
  - ID: F1
    Date: 2026-10-14
    Source document: Concession Agreement (draft 3)
    Clause: "12.4"
    Finding: Termination for convenience is one-sided; only the Agency may invoke it.
    Affects: Co
    Consequence / action: Seek a mutual right, or a compensation formula on Agency termination.
    Implemented in: ""
    Status: Open
```

`Status` is one of `Open`, `Implemented`, `Info`. `Affects` is a short code
(the party or workstream). Keep `ID` stable: the register's rows are keyed on
it, and a lawyer's annotations in Excel sit beside that ID.

## 2. Build the register

```bash
python3 scripts/build_findings_register.py findings.yaml "Findings Register [Project] [AKLA][Month DD, YYYY].xlsx"
```

Navy header row, Arial, wrapped cells, frozen header, filters on, status
colours. It refuses to overwrite a workbook that is open in Excel.

## 3. Build the deck (optional)

A separate `deck.yaml` holds the slides — a running header and, per slide, a
title and numbered items in the firm's two-column table style:

```yaml
header: Legal Review – Concession Agreement – Project Name
slides:
  - title: Key Findings
    items:
      - heading: Termination for convenience
        summary: One-sided in the Agency's favour; the Concessionaire has no equivalent right.
        bullets:
          - label: Action
            text: Seek mutuality or a compensation formula.
    notes: Speaker notes, optional.
```

```bash
python3 scripts/build_deck.py deck.yaml "Findings Deck [Project] [AKLA][Month DD, YYYY].pptx"
```

Items number continuously across slides. Keep three to five items a slide;
long summaries push the table below the logo line, so split a crowded slide
rather than shrink it. There is no automatic overflow check in this toolkit —
open the file and look, or keep items short.

## 4. The memo

Write the covering memo with the **legal-summary** skill, citing each finding's
clause; the same findings list is the source for all three.

## What this skill will not do

Invent a finding, a clause number or a status. Reorder or renumber IDs. Judge
which findings matter — that is the review; this renders what it was given.
