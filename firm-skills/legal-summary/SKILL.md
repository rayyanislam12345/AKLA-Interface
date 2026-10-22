---
name: legal-summary
description: Explain a dense legal document in plain English and deliver it as a short Word memo in AKLA house format. Produces a tight "Notes On..." memo - what the document does, the handful of things that matter, and what to watch - in short numbered points, not an exhaustive clause list. Use for contracts, agreements, judgments, statutes, due diligence reports, opinions, pleadings and notices, whenever the user says summarise, digest, explain, brief me, "what does this actually say", or "make this readable". When the note cites statutes or documents, each verbatim excerpt is attached to its citation as a Word comment and every excerpt is checked against the source text.
---

# Legal document summary

Take a long, dense legal document and produce something a reader gets in one
pass: a **one- to two-page** memo of short numbered points covering only what
matters.

**Be brief.** A ranked table of thirty findings is a second dense document, and
so is four pages of flowing prose - both move the reading burden rather than
removing it. Decide what matters, say it in a sentence or two, stop.

The reader is a lawyer, so don't define "warranty" or add "consult a lawyer"
disclaimers. Plain English here means short sentences and concrete
consequences - not a simplified analysis.

## Workflow

**1. Get the text.**

```bash
python3 scripts/extract.py "FILE" --out ./extracted
```

Run from the skill's own directory. Emits `<<<page N>>>` markers - these are
how you cite. If the file is already attached and legible to you, skip this;
the script is for long documents and citation anchoring, not a gate.

The extractor tries pdfplumber, pypdf, pymupdf, then pdftotext, and uses
whichever is present. `.doc`/`.rtf`/`.odt` need macOS - elsewhere ask for a
.docx or .pdf. DOCX caveat: Word *auto-numbered* list and table numbers are not
stored as text and come out blank, so cite those rows by content, never by a
number the extract did not show you.

If it reports **likely a SCAN**, stop and say so - no OCR text means no
reliable summary. Offer to OCR with `ocrmypdf` if installed.

**2. Read all of it.** Long documents are where skimming does damage - the
indemnity cap sits in clause 47 and the carve-out that guts it sits in a
schedule. Read schedules, annexures and definitions; a defined term can invert
the plain meaning of the clause that uses it. Chunk if you must, but read every
chunk - never sample.

**3. Work out what matters** using `references/doc-types.md` (contracts,
judgments, statutes, DD reports, opinions, pleadings, correspondence) and the
selection test below. This checklist is your *reading* apparatus - it tells you
what to hunt for. It is not the shape of the output.

**4. Choose four to six things worth explaining.** This is the whole job.
A twelve-point memo is a failure of nerve: it means you declined to decide what
mattered and passed the sorting to the reader.

**5. Write the memo**, then **6. build the Word file** (both below).

## What earns a place

Rank everything you found, then keep only the top of the list. Something earns
a section if a partner would stop reading to ask about it:

- It could kill the deal, void the instrument, or expose the client to
  uncapped, criminal or regulatory liability.
- It moves real money or control - uncapped indemnities, termination for
  convenience against the client, change-of-control triggers, security over
  core assets, adverse forum.
- It starts a clock someone will otherwise miss.
- It is **missing** and should not be. No liability cap, no governing law, an
  unattached schedule, an unexecuted signature block. Absences never announce
  themselves; hunt for them deliberately.
- It contradicts another document in the same bundle. In a bundle this is
  usually the single most valuable thing you can find.

Everything else - notice mechanics, ordinary boilerplate, drafting slips -
stays out unless genuinely unusual. Sweep the leftovers into one closing point
on minor matters; never give them a section.

## How to write it

Every point does three jobs in one or two sentences: **what it says**, **what
it means in practice**, **why it matters**. Compress them into the same
sentence wherever you can.

> The cap is USD 2m (cl. 22.1, p. 31) - about 8% of contract value, so it does
> not cover a serious failure.

That is a complete point. It does not need a paragraph of setup.

Rules of the register:

- **One idea per numbered point. One to three sentences, under 60 words.**
  Most should be under 35. If a point needs more, it is two points.
- **Lead with the conclusion in the first clause.** Never build to a reveal.
  "The client cannot terminate at all" before the explanation, not after.
- **Cut throat-clearing.** Delete "it is worth noting that", "the Agreement
  provides that", "as set out above", "in this regard". Say the thing.
- **Short bullets are fine for genuinely enumerable items** - deadlines,
  missing documents, conditions precedent, unattached schedules. One line each,
  six maximum, no sub-bullets. Never bullet the analysis itself; a bullet is a
  list, not a substitute for saying what something means.
- **Put numbers in proportion**, in the same breath: "USD 2m - about 8% of
  contract value."
- **Translate in three words, parenthetically**: "a condition precedent (the
  deal does not close until it is met)". Then use the term normally.
- **Say plainly when something is fine.** One sentence: "The termination regime
  is unremarkable." Silence leaves the reader wondering whether you looked.
- **Keep inference visible.** "Clause 9 says X, so in practice Y."
- **Never fill gaps.** If no cap is stated, the finding is "no liability cap is
  stated" - not an assumed one. Inventing a plausible term is the one failure
  mode that does real damage. Write `[TO BE CONFIRMED]` where a figure or
  citation is needed and the document does not supply it.
- **Flag ambiguity, don't resolve it.** Both readings, which favours the
  client, one line each, in the open-questions section.
- **Cite lightly but always** - `(cl. 12.3, p. 18)` inline. Every substantive
  claim needs one, or the reader has to re-find it.
- Say which party you are writing for, and frame exposure from that side. Ask
  if it is not obvious from context.

## Memo structure

Write the draft as Markdown in the subset below, then render it. The AKLA memo
shape is a three-level legal outline: major topic, sub-topic, short numbered
points.

```markdown
# Notes On [Subject]

## The Short Version

What the document is, what it does, and the one thing that matters most.

Three or four sentences, total. Someone who reads only this should be able to
hold a conversation about the document.

## [First crucial aspect]

### [The specific point]

The conclusion, then the consequence. One to three sentences (cl. X, p. Y).

::: PKR 75,000,000/-
::: (Pakistani Rupees Seventy-Five Million Only)

- A short enumerable item, where a list genuinely helps
- Another one, one line each

> Quoted clause text, only where the exact words carry the risk.

## What To Watch

### [The risk]

The consequence and what would trigger it. Two sentences.

## What Is Still Unclear

### [The question]

What the document does not settle and who must answer it. One or two sentences.
```

Rules for the Markdown - this is the whole subset the renderer accepts:

| Markdown | Renders as |
|---|---|
| `# Title` | navy banner, gold Small Caps, centered - **exactly once, first line** |
| `## Major topic` | navy bar heading, numbered `1.`, gold Small Caps |
| `### Sub-topic` | numbered `1.1.`, bold underlined Small Caps |
| plain paragraph | numbered `1.1.1.`, Arial 11pt justified |
| `- item` | numbered `(a)`, for short enumerated items |
| `> text` | quoted clause text, italic, indented both sides |
| `::: figure` | shaded box, centered - consecutive `:::` lines form one box |
| `\| a \| b \|` | table, navy header row with gold Small Caps text |
| `#### Divider` | centered Small Caps, ruled above and below (annexure style) |
| `**bold**` `*italic*` | inline runs - bold sparingly, for figures |

Blank line between every line. Nothing else is supported: no other heading
depths, no nested lists, no links, no images, no code fences.

Use `:::` for a figure that must not be missed - a cap, a fee, a deadline -
the way the firm's proposals box their fee amounts. One per memo at most.
Use a table only for a genuine grid (rates, dates by party); a two-column
table of findings is the failure mode the whole skill exists to avoid.

**Budget - hold to it:**

| | Limit |
|---|---|
| Whole memo | 1-2 pages, ~600-900 words |
| The Short Version | 3-4 sentences |
| Major sections (`##`) | 4-6, including What To Watch and What Is Still Unclear |
| Points per sub-topic | 1-3 |
| Any one point | under 60 words |

A 300-page report and a 40-page contract both reduce to the same handful of
things worth saying. If it is running longer, you are listing rather than
choosing - go back to step 4 and cut, don't compress the prose.

## Building the Word file

```bash
python3 scripts/build_docx.py notes.md \
  -o "Notes On [Subject] [AKLA][September 04, 2026].docx" \
  --doc-title "Notes On [Subject]" \
  --doc-status "First Circulation Version" \
  --doc-date "September 04, 2026"
```

Name the file in house convention: `Notes On [Subject] [AKLA][Month DD, YYYY].docx`.

The `--doc-*` values become the running header's reference strip, so they must
be real: the title as it appears on the memo, the circulation status if the
user gave one, and the date in the filename. Split a long title over two header
lines with `|`. The confidentiality line defaults to "Privileged And
Confidential" (`--doc-notice` to change it) and the AK emblem is bundled
(`--no-logo` to drop it). Never invent a status or a matter reference - omit
what you were not given.

The generator matches the firm's proposal format throughout: Arial 11pt
justified body; section headings in gold Small Caps on navy `0E2841` bars;
sub-headings Arial 11pt bold underlined Small Caps; real multi-level
`1.` / `1.1.` / `1.1.1.` / `(a)` numbering that renumbers when the associate
edits; the four-line header strip with the emblem on every page; and a centered
Arial 8pt "Page X of Y" footer. See `references/akla-format.md` for the full
spec and the four places it deviates.

Tell the user the output path when you are done (or file it in the Hub: see
Filing), and paste the Short Version into chat - they should not have to open
the file to learn what it says.


## Citing with verified excerpts

When a note relies on the words of a statute, a clause or a document, cite it
so the reader can check it without leaving the memo, and prove the quotation
is real. Write the citation in the Markdown with the excerpt beside it:

```markdown
A private company may not issue shares at a discount {{s. 82, Companies Act 2017|No company shall issue shares at a discount}}.
```

`{{citation|excerpt}}` prints the citation in the text and attaches the verbatim
excerpt to it as a Word comment. `{{display|excerpt|full citation}}` prints a
short form and puts the full citation in the comment. `--default-act` prefixes
bare `s. N` citations with the Act's name.

Build with the citing builder instead of `build_docx.py` directly — it renders
the same memo, then attaches the comments and applies the house spacing rule
(0 pt before and after everywhere; gaps as blank paragraphs):

```bash
python3 scripts/build_memo.py notes.md "Notes On [Subject] [AKLA][Month DD, YYYY].docx" \
  --title "Notes On [Subject]" --status "First Draft" --date "Month DD, YYYY" \
  --default-act "Companies Act 2017"
```

Before handing the file over, check every excerpt against the source texts.
Save the statutes or documents the note quotes as `.txt` (or `.md`/`.html`)
in a `sources/` folder — the user's attachments, extracted with
`scripts/extract.py` — then:

```bash
python3 scripts/check_excerpts.py notes.md --sources ./sources
```

It normalises quotes, dashes and page furniture, splits each excerpt at `[…]`
and clause punctuation, and names any piece it cannot find. **A note with an
unmatched excerpt does not go out**: fix the quotation or drop the citation.
The builder itself refuses to finish if a comment failed to attach.

## Filing

When the AKLA Hub connector is available (its tools include `upload_file_to_project`), the finished memo is filed in the matter's project on the Hub, never handed over only as a file in the chat:

1. Find the project with `list_projects` (or `find_document_by_title`); ask the user which one if it is not clear. If the note is a new version of a memo already on the project, take its `documentId` from `list_project_documents`.
2. Call `upload_file_to_project` with the project id and the file's name (and the `documentId`, for a new version). Run the `curl` line it returns from the sandbox, pointing at the file you built (under `/mnt/user-data/outputs/` in claude.ai). If curl cannot reach the network, give the user the upload address it returns, written out in full on its own line, to open and drop the file in.
3. Call `get_upload` to confirm the file arrived, then give the user its "Open in Hub:" address, written out in full on its own line.

A memo can go through the connector's own drafting route instead: if `list_document_types` shows the firm has a standard or pack for a memo and the user wants the note on it, draft it with `open_standard_for_filling` and `fill_standard_to_project` rather than building the file here. A note whose excerpts are attached as Word comments is built here and uploaded.

Without the connector (Claude Code, or the Hub's own chat), hand the file over as before.
