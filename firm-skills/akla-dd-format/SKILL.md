---
name: akla-dd-format
description: Clean up an existing legal due diligence volume and bring it to AKLA gold-standard format - A4 portrait, Arial 11, navy/gold tables, blue AKLA Comments, red AKLA Action Items, glossary, Annexure A. Audits a draft against the house standard, reformats it without changing a word, and proves nothing was lost. Use whenever someone says format this DD volume, clean up this due diligence report, make this match our house style, check this volume's formatting, or hands over a colleague's draft volume to be tidied before circulation.
---

# AKLA due diligence volume formatting

Take an associate's draft DD volume and return it in the firm's circulated format,
with the wording untouched.

**This is a formatting job, not a drafting job.** The draft's analysis is the
author's. Your task is to make it look and read like a volume the firm circulates:
correct geometry, correct colours, correct numbering, correct front and back
matter, correct register in the standing wording. Where the substance is thin or
wrong, say so in your summary; do not silently rewrite it, and never invent a
finding, a date, a figure or a citation.

A DD volume is **A4 portrait** (the firm's format from September 14, 2026). Nothing
else about the house style changed when the page turned: same margins, header and
footer, Arial 11, navy/gold tables, blue Comments, red Action Items, black underlined
headings, Word numbering, zero paragraph spacing with explicit blank lines. Only the
widths are fitted to the narrower page. Landscape is an exception: a genuinely wide
schedule that cannot be restructured (prefer a companion spreadsheet), or a re-issue
of a volume already circulated in landscape — build those with `--landscape`.

## Workflow

### 1. Audit first, always

```bash
python3 scripts/check_volume.py "Draft Volume III.docx"
```

Run from the skill's own directory. This reports `FAIL` for hard breaches (wrong font,
mis-coloured AKLA paragraphs, missing header) and `WARN` for the rest, including a
landscape page, paragraph spacing, typed list letters, a crowded glossary column and
contents page numbers that have not been refreshed. Show the user the list before you change anything — sometimes an audit is all
they wanted.

### 2. Read the draft into structure

```bash
python3 scripts/read_volume.py "Draft Volume III.docx" -o volume.json
```

Handles `.docx` and `.pdf`. It classifies every block — headings, numbered
paragraphs, AKLA Comments and Action Items, lists, data tables, contract summary
tables — and separates the Important Note, Glossary and Annexure A.

Detection is by **marker text** (`AKLA Comment:`) before colour, because in the
firm's own volumes some action items inside table cells are printed black.

It prints what it found and what is missing. Read that output. If it reports no
glossary or no Annexure A, those are genuine gaps to raise with the user, not
things for you to write.

### 3. Check and correct the JSON

Open `volume.json` and fix what the reader could not know:

- `report_title`, `volume_roman`, `volume_title`, `draft_label`, `date` — these
  become the running header, so they must be right. A draft with no header leaves
  them guessed or blank.
- Anything misclassified. A heading read as a paragraph, or a contract table read
  as a data table, will render wrongly.

Edit the JSON, not the prose. Changing wording here is out of scope.

### 4. Rebuild

```bash
python3 scripts/build_volume.py volume.json \
  -o "SP3A - DD Volume III [AKLA][First Draft][September 07, 2026].docx" \
  --date "September 07, 2026"
```

House naming: `[PREFIX][n]A - DD Volume [ROMAN] [AKLA][Draft Label][Month DD, YYYY].docx`,
where the prefix is the engagement's (`SP` for Sapphire, `FE` for FESCO). The IRL
annexed to a volume is `[PREFIX][n]B - DD Volume [ROMAN] - IRL [AKLA][…].docx`.

The contents page is a live Word field over bookmarked landmarks. Its page numbers
show `—` until fields are refreshed: in Word select all and press F9 (or right-click
the contents and Update Field), then export the PDF. Check the PDF for clipped
tables, stranded headings, oversized rows and stale page numbers before circulation.

### 5. Prove nothing was lost — do not skip this

```bash
python3 scripts/check_volume.py rebuilt.docx --against "Draft Volume III.docx"
```

Compares the rebuild to the original sentence by sentence and reports anything
missing. It exits non-zero on loss or any `FAIL`.

**If it reports missing units, do not hand the file over.** Find out why. Usually
the reader misclassified a block and the build dropped it. Fix the JSON and rebuild.
Reformatting a legal document that quietly loses a sentence is the one failure that
does real damage here.

### 6. Report

File the volume in the Hub when you can (see Filing below). Tell the user the output path, what the audit found, what you changed, and — in one
line — that the content check passed. Flag separately anything needing their
judgment: missing front matter, house-style deviations you did not touch, thin
analysis.

## Filing

When the AKLA Hub connector is available (its tools include `upload_file_to_project`), the finished volume is filed in the matter's project on the Hub, never handed over only as a file in the chat:

1. Find the project with `list_projects` (or `find_document_by_title`); ask the user which one if it is not clear. A reformatted volume is normally the next version of the draft already on the project: take that document's `documentId` from `list_project_documents`.
2. Call `upload_file_to_project` with the project id and the file's name (and the `documentId`, for a new version). Run the `curl` line it returns from the sandbox, pointing at the file you built (under `/mnt/user-data/outputs/` in claude.ai). If curl cannot reach the network, give the user the upload address it returns, written out in full on its own line, to open and drop the file in.
3. Call `get_upload` to confirm the file arrived, then give the user its "Open in Hub:" address, written out in full on its own line.

Without the connector (Claude Code, or the Hub's own chat), hand the file over as before.

## What "gold standard" means

`references/dd-volume-format.md` has the measured spec: geometry, the six colours,
the five-line running header, numbering and indents, table treatments, and the fixed
order of the General Provisions rows in contract summary tables. `scripts/build_volume.py`
applies all of it.

The values came off the firm's circulated volumes directly, not from a style guide,
so trust them over your memory of how legal documents usually look.

The essentials:

| Element | Standard |
|---|---|
| Page | A4 portrait, 8.27" × 11.69"; margins 0.8" sides, 1.35" top, 0.75" bottom |
| Spacing | 0pt before and after every paragraph; gaps are blank paragraphs |
| Numbering | Word lists only: `1.` / `1.1.` / `1.1.1.` and `(a)` — never typed |
| Body | Arial 11pt justified |
| AKLA Comment | blue `0070C0`, whole paragraph |
| AKLA Action Item | red `FF0000`, whole paragraph |
| AKLA Response | green `00B050` (second circulation only) |
| Table headers | navy `002060` ground, gold `FFC000` Small Caps |
| Structure | Cover → TOC → Important Note → [Scope, Transaction Overview and Methodology] → [Executive Summary] → Glossary → body → [Transaction Actions] → Annexure A → [Annexure B – Review Coverage] |

### Optional sections (from September 15, 2026)

The bracketed sections render only when the volume JSON carries them, as lists of
blocks: `methodology`, `executive_summary`, `transaction_actions`, `coverage` (with
an optional `coverage_title`). Each is a contents landmark with its **own** Word
numbering (`1.` headings, `1.1.` paragraphs), so adding one never shifts the
subject-section numbers. Comments, Action Items, lists and tables inside them keep
house formatting. A blank line after a heading is kept with the heading.

These are substantive sections. When reformatting, carry them over if the draft has
them; never compose them. An Executive Summary is a view of findings already in the
body with a body reference, not new analysis, and its Action Items are not new IRL
requests.

## House style

`references/house-style.md` covers the writing conventions: third person "the Firm",
British spelling, the standing AKLA Comment and Action Item formulae, numbers in
words then figures, dates as `October 28, 2025`, and how defined terms work.

Use it two ways. When auditing, note deviations so the author can fix them. When the
user explicitly asks you to correct the register — not merely reformat — apply it,
but keep every substantive finding intact and tell them what you changed.

Never rewrite the Important Note. It is boilerplate carrying legal weight, and its
scope disclaimers (tax, technical, environmental, insurance, financial matters, and
labour law) are deliberate.

## When a volume has no front matter at all

Common in a working draft. Build what is structural and flag what is substantive:

- **Cover, TOC, header, footer** — generate them. Pure formatting.
- **Important Note** — do not compose one. Ask for the firm's standing text, or
  copy it from another volume of the same report.
- **Glossary** — do not invent definitions. Report that it is missing.
- **Annexure A** — the list of reviewed documents is a record of what was actually
  reviewed. Only the author knows it.

## Sharing this skill

To send it to an associate, run `./package.sh` from the skill folder. That writes
`~/Desktop/akla-dd-format.zip` (pass a path to put it elsewhere) containing the
scripts, the format spec, the branding assets and an `INSTALL.md` written for
someone who has not set up a skill before.

They unzip it, run `install.sh` (macOS/Linux) or copy the folder into
`~/.claude/skills/` by hand, and install two libraries:

```bash
pip3 install python-docx pymupdf
```

`python-docx` is required; `pymupdf` only to read PDF drafts. Nothing else, and no
connection to any wider system — the folder is self-contained.
