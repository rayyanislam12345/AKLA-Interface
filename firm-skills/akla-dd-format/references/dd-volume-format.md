# AKLA due diligence volume format

Measured directly from the firm's circulated volumes for the Sapphire Wind Power
acquisition (first circulation, August 27, 2026) — fonts, colours, geometry and
structure were read out of the PDFs rather than transcribed from a style guide,
so these values are what the documents actually contain.

**Page orientation changed on September 14, 2026.** Following the firm's design and
drafting review, DD volumes are A4 portrait. Everything else in this spec is
unchanged; the portrait proof of FESCO Volume I (`output/dd-review/revised/` in
DD-Bot) was built this way, exported through Word and visually checked.

A DD volume is **not** the memo/proposal family. Both are now portrait, but they
differ in banner colour, running header and overall structure. Do not apply proposal
formatting to a DD volume.

## Page geometry

| Property | Value |
|---|---|
| Page | A4 **portrait**, 8.27" × 11.69" |
| Margins | left/right 0.8", top 1.35", bottom 0.75" (unchanged) |
| Usable width | about 6.67" (169 mm), against 10.09" in landscape — 34% narrower |
| Header distance | 0.45" |
| Footer distance | 0.4" |
| Body text | Arial 11pt, justified, single spaced, **0pt before and after** |

Spacing is never set on a paragraph. Where a gap is wanted, insert an empty
paragraph. This applies inside table cells too.

Landscape is now an exception, never the body default: use it only for a genuinely
wide evidentiary schedule that cannot be restructured without loss (a companion
spreadsheet is preferred), or for a re-issue of a volume already circulated in
landscape, where the presentation should not change alongside substantive edits.
The Information Request List annexed to a volume is A4 portrait with 1" margins.

### Fitting content to the portrait width

- Table column widths are proportional to the usable width, never fixed inches from
  a landscape layout. Widths given for landscape are scaled down to fit.
- Glossary columns are about **29% / 71%** (term / meaning). A fixed 2.9" term column
  would take 43% of a portrait page.
- Contract summary label column stays about 1.9" but never more than 30% of the
  width.
- Header rows repeat on every page; headings keep with their first paragraph; short
  rows (glossary) may be set not to split. Do not set every row "cannot split" — it
  leaves large gaps and does not solve an oversized row.
- Retain existing table point sizes and cell alignment. Prefer two or three columns
  for narrative tables; any consolidation of columns or movement of analysis out of a
  table is an editorial change, not a formatting one.

## Colours

| Name | Hex | Used for |
|---|---|---|
| Navy | `002060` | cover banner, table header rows, contract-table title bars |
| Gold | `FFC000` | text on navy — cover title, table header text |
| Grey | `D9D9D9` | glossary term column, contract-table group rows |
| Blue | `0070C0` | **AKLA Comment:** paragraphs, in full |
| Red | `FF0000` | **AKLA Action Item:** paragraphs, and the header confidentiality line |
| Green | `00B050` | **AKLA Response:** paragraphs (second circulation only) |

The comment and action item colours carry meaning and are the fastest way to
read a volume. Never render either in black.

## Running header and footer

The header repeats on every page including the cover, as a borderless two-column
table. Left column, five lines, Arial Small Caps, 6.5pt with 8pt initial caps:

1. `LEGAL DUE DILIGENCE REPORT FOR THE ACQUISITION OF [TARGET]` — bold
2. `VOLUME [ROMAN] ([TITLE])` — bold
3. `[DRAFT LABEL]` — e.g. FIRST DRAFT, SECOND DRAFT, FINAL
4. `STRICTLY CONFIDENTIAL AND FOR DISCUSSION PURPOSES ONLY` — **red**
5. `[MONTH DD, YYYY]`

Right column: the AK emblem, 0.55" high, right-aligned.

Footer: `Page X of Y` centered, Arial 8pt, using PAGE and NUMPAGES fields so it
updates on open.

## Document structure, in order

1. **Cover** — navy banner with the report title in gold 15pt Small Caps; three
   blank lines; `DATED:` and the date right-aligned, a blank line between; two blank
   lines; `PREPARED BY:`, a blank line, the wide AKLA logo; three blank lines; a
   centered `RANKED BY` heading with a rule; the complete awards panel (all eight
   rankings logos, `assets/ranked-by.png`, 5.6" wide).
2. **Table of contents** — `TABLE OF CONTENTS` centered with a rule. A real Word TOC
   field built from hidden TC entries on bookmarked landmarks: Important Note,
   Glossary, the volume title, each level-1 section, Annexure A — not every
   sub-heading. Rows are bold Small Caps 10pt with a dotted leader to a PAGEREF page
   number. Refresh fields in Word before export; the page numbers read `—` until then.
3. **Important Note** — the firm's standing scope and reliance wording. It lists
   every volume in the report, names the volume in hand, and disclaims tax,
   technical, environmental, insurance and financial matters. Never paraphrase it;
   it is boilerplate that carries legal weight.
3A. **Scope, Transaction Overview and Methodology** (optional) — centred title with a
   rule, its own Word numbering (`1.` headings, `1.1.` paragraphs), one to two pages;
   only work actually performed, with dates and limits. Follows the Important Note
   without a further page break.
3B. **Executive Summary** (optional) — new page, own numbering; each finding gives the
   established position, remaining uncertainty, significance and next step, with a
   body reference, in blue Comments and red Action Items. Ends on a page break.
4. **Glossary** — two-column table, `DEFINED TERM` / `MEANING`, grey header, terms
   alphabetical, term cells grey. Definitions read "Means the …" or "Has the meaning
   ascribed thereto in …".
5. **Volume title page** — `VOLUME [ROMAN] – [TITLE]` centered, then repeated at the
   head of the body.
6. **Body** — see numbering below.
6A. **Transaction Actions** (optional) — new page after the body, own numbering; per
   matter the recommendation, proposed responsibility, timing, evidence or decision
   required, and report and request references. No proposal becomes a condition
   precedent by being listed.
7. **Annexure A – Reviewed Documents** — its own `1.` paragraph (a fresh list that
   restarts at 1), then a Word-numbered lettered list of the glossary short names of
   every document actually reviewed, `;` between, `; and` before the last, `.` at the
   end. List only documents actually reviewed; disclose partial review; a placeholder
   (for example a search report said to be awaited) stays identified as a placeholder.
8. **Annexure B – Review Coverage** (optional) — new page, own numbering; a schedule of
   record, basis and review record (file, version, pages reviewed, reliance). A file
   merely profiled is not reviewed.

A blank line directly after a heading is kept with the heading (keep with next), so a
heading never strands at the foot of a page. In the IRL, a request carrying IDs shows
them on their own left-aligned line (`FE-R-001 / FE-COR-001`) above the justified request.

`[***THE REST OF THIS PAGE HAS BEEN INTENTIONALLY LEFT BLANK***]` closes a part-full
page, centered, bold, Small Caps.

## Numbering and indents

| Level | Format | Style |
|---|---|---|
| Section | `1.` | Arial 11pt **bold**, Small Caps, underlined |
| Sub-section | `1.1.` | Arial 11pt Small Caps, underlined |
| Paragraph | `1.1.1.` | Arial 11pt justified |
| List item | `(a)` | Arial 11pt, `; ` separators, `; and` before the last — a separate Word list per list, restarting at (a) |

No number or list letter is ever typed into the text. Word supplies every one from a
list definition, so inserting or deleting a paragraph renumbers the rest. In the
numbering part every `w:abstractNum` precedes every `w:num`.

Every level uses a hanging indent: number at the margin, text at 0.5", with a tab
stop at 0.5". Deeper levels shift the whole block right by 0.5" per level.

AKLA Comments and Action Items are indented 0.5" and carry no number — they attach
to the paragraph or table row above them.

## Tables

**Data tables** (directors, shareholding, share certificates, minutes): navy header
row, gold Small Caps bold header text centered, TableGrid borders, cell margins 60
dxa top/bottom and 100 left/right, header row repeats across pages.

**Contract summary tables** (Material Contracts and Immovable Property volumes): a
two-column table opening with a merged navy title bar carrying the instrument name
in gold. Then group rows — merged, grey, Small Caps bold — for `GENERAL PROVISIONS`
and `SPECIFIC PROVISIONS`. Then label/content rows, label column about 1.9" wide (at most 30% of the page width).

The General Provisions rows appear in a fixed order and every row is present even
when the instrument is silent, in which case the content is an AKLA Comment saying
so:

Title of the agreement · Parties · Effective Date · Term · Obligations · Governing
Law · Termination · Indemnification · Limitation of Liability · Force Majeure ·
Events of Default · Dispute Resolution · Negative Covenants · Liquidated Damages/
Penalties · Confidentiality · Assignment · Change in Control · Performance
Guarantees and Security Deposits · Stamp Duty

Specific Provisions rows are named after the instrument's own operative clauses and
vary by document.

## Litigation volumes

A single table: `SR. NO.` / `TITLE OF THE CASE AND RELEVANT JUDICIAL FORUM` /
`CASE NO.` / `BACKGROUND/ DESCRIPTION OF THE CASE`. The description cell carries
`FILING DATE:` and `CURRENT STATUS:` as inline labels, and
`No further particulars are available.` where the file does not say.
