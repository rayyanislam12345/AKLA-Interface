# Concession agreement format

Measured directly from the firm's master, `Standard Concession Agreement [AKLA] [May 08, 2026].docx`,
by reading the package XML rather than transcribing a style guide. These are the values the build
preserves and the checker enforces. Trust them over any memory of how a Pakistani PPP agreement
usually looks.

The one rule that follows from all of it: **the master is edited in place, never regenerated.**
A document builder cannot reproduce 284 numbering definitions, a live contents field and a
theme-bound font set. The build clones the file and writes into existing runs.

## Page geometry

| Property | Value |
|---|---|
| Paper | A4 portrait, 11906 × 16838 twips (8.27" × 11.69") |
| Margins | top and bottom 2160 twips (1.5"); left and right 1728 twips (1.2") |
| Sections | one body section; header1, header2, footer1 parts |
| Footer | page number |

## Type

| Property | Value |
|---|---|
| Body face | Times New Roman, bound through the theme rather than a literal `rFonts` |
| Heading 1 | 13 pt (`sz` 26), bold, article titles in title case, e.g. `Definitions & Interpretation` |
| Heading 2 | bold, section titles |
| Body styles in use | `Colorful List - Accent 11` (679 paragraphs), `Normal` (670), `Heading 2` (264), `List Paragraph` (243) |
| Paragraph count | 4,106; 5 tables |

The heading text carries **no number**. Every Article, Section and list level is auto-numbered from
`numbering.xml` (284 `abstractNum`, 309 `num` definitions, 1,143 numbered paragraphs). Delete a
paragraph and everything after it renumbers, silently, while the 208 literal "Section N.N",
59 "Article N" and 95 "Schedule X" references in the text stay as typed. That is why v1 of the
build deletes nothing.

## Defined terms

A defined term sits in its own **bold** run at the head of its definition; the definition text that
follows is a separate, plain run:

```
[Acceptable Pakistani Bank]  [ means a scheduled bank or a financial institution …]
      bold run                        plain run
```

Cross-references inside definitions are partly bold in the master (`Schedule B` bold, the
parenthetical plain). The build never merges or normalises runs, so a value written into a bold run
comes out bold and one written into a plain run comes out plain, exactly as the template intends.

The main body (Section 1.1) lists ~272 terms. Forty-seven of them read only:

> `<Term>` shall have the meaning ascribed thereto in Schedule B (Specific Definitions);

and Schedule B carries the substantive definition. That is where almost every deal variable lives.

## Contents page

A single field, `TOC \o "1-1" \h \z`, listing Article titles only, with 31 cached `PAGEREF`
results. The master's `settings.xml` has **no** `updateFields`, so a copy opens showing the cached
headings and page numbers with no prompt. The build sets `<w:updateFields w:val="true"/>`; Word
then asks to update fields on open and the contents page rebuilds.

## Schedules

Twenty-five, A to Y, each introduced by a paragraph `Schedule X – Title`. See `schedules.md` for
which are drafted, which are option tables and which are attachment stubs.

## What else is in the package

Worth knowing before touching the file: an ink part (`word/ink/ink1.xml`), four `customXml` items,
`people.xml`, and the comment extension parts (`commentsExtended`, `commentsIds`,
`commentsExtensible`). The build copies every part it does not edit byte for byte, and the checker
asserts `numbering.xml` and `styles.xml` came through identical.
