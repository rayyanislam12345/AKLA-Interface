# AKLA Word format

Taken from the firm's *Word Formatting and Shortcuts Guide* and verified
against `AM7.1 - Artistic DISCOs Proposal [AKLA][Circulation Version][July 17,
2026].pdf`, which is the canonical reference for this family of documents.
`scripts/build_docx.py` applies all of it.

## Font and text

| Element | Specification |
|---|---|
| Body text | Arial 11pt, justified |
| Section headings | Arial 13pt Bold Small Caps, **gold `FFC000` on a navy `0E2841` bar** |
| Sub-headings | Arial 11pt Bold Underlined Small Caps, black |
| Document title | Gold Bold Small Caps, centered on a navy banner |
| Defined term, first use | Bold |
| Quoted text | Italic, indented from both margins, justified |
| Header strip and page numbers | Arial 8pt Small Caps |
| Confidentiality line in the header | Arial 8pt Small Caps, **red `C00000`** |

## Numbering

The standard three-level legal outline, with a lettered fourth level for lists:

| Level | Format | Used for |
|---|---|---|
| 1st | `1.` | section headings (the navy bars) |
| 2nd | `1.1.` | sub-headings |
| 3rd | `1.1.1.` | body paragraphs |
| 4th | `(a)` | short enumerated items |

The numbering is defined in `numbering.xml`, so inserting a section in Word
renumbers the rest. The `1.` on a navy bar is gold and Small Caps like the
heading text, because the list number inherits the paragraph mark's formatting.

Reproduced or quoted *law* uses a separate nested lettering scheme, never the
clause numbering: `(a) (b)` → `(i) (ii)` → `A. B. C.`

## Page furniture

- Letter page, 1" margins on all sides.
- **Running header on every page**, including the first: a borderless
  two-column table with the reference strip on the left - document title
  (bold), version line, confidentiality line in red, date - and the gold-on-navy
  AK emblem (`assets/akla-logo.png`, 0.55" high) on the right.
- **Footer on every page**: "Page X of Y" centered, Arial 8pt, using PAGE and
  NUMPAGES fields so it updates on open.
- Tables: header row shaded navy `0E2841`, header text gold `FFC000`, Arial
  11pt bold Small Caps, centered; TableGrid borders; cell margins 144 dxa top
  and bottom. (DD volumes use navy `002060` instead - match whichever family
  the document belongs to.)
- Key figures sit in a shaded `F2F2F2` box, centered, bold Small Caps - the
  treatment the proposal gives its fee amounts.

## Working order

The guide prescribes a task order for preparing a document: format first, then
fix content, then verify referred and reproduced laws, then a printed cleanup
pass.

## Where the generator deviates, and why

1. **Numbered headings are left-aligned.** The guide centers headings with a
   bottom border. On a navy bar with `1.` hanging off the left edge, centering
   reads badly, so the document title gets the centered banner treatment and
   the numbered section headings are left-aligned in the legal-outline
   convention - which is what the proposal itself does.
2. **Heading size defaults to 13pt** per the guide. Pass `--heading-pt 11` for
   a one-page note.
3. **No title page or table of contents is generated.** A memo opens with the
   navy title banner and goes straight into the text. The proposal's cover
   page, ranking logos and acknowledgement block belong to proposals, not to
   notes.
4. **Nothing in the header is invented.** Pass `--doc-title`, `--doc-status`
   and `--doc-date`; anything not supplied is simply omitted. The
   confidentiality line defaults to "Privileged And Confidential" and the
   emblem to the bundled AK mark - both can be overridden, and `--no-logo`
   drops the emblem.
