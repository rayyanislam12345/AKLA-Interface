# AKLA house style

The AI Workspace delivers every document it writes as a Word file in the firm's
house format, rendered by `chat-service/akla/build_docx.py` and checked by
`checkAklaFormat` in `chat-service/aklaRender.js`.

## Where the format comes from

1. **The firm's Word Formatting and Shortcuts Guide** (June 17, 2026) — the
   authority: Arial 11 body; 13pt bold small caps headings; 11pt bold underlined
   small caps sub-headings; bold defined terms on first use; the firm's name in
   italic dark blue; a single-cell navy title banner with gold small caps; the
   1. / 1.1. / 1.1.1. outline; quoted law as italic, indented both sides, lettered
   (a) → (i) → A.; "Page X of Y" in 8pt; a clean first page.
2. **Circulated firm documents, measured** with `analyze_docx.py`: AM7 (Artistic
   DISCOs Proposal), OES2 (Notes on Restrictions under the MRA), FE-M01 (FESCO
   Memorandum), and the Special Technology Zone formatting exercise. These fixed
   what the Guide leaves open: A4 with one-inch margins, navy `002060`, header
   strip in 8pt small caps with the confidentiality line in red `C00000` and the
   AK emblem on the right.
3. **Choices the firm made where its documents disagree** (September 15, 2026):
   section headings are numbered "1.", left-aligned, with a rule beneath, in
   every family; the navy banner is for the title only; body text sits one
   level below its heading (1.1. under a section, 1.1.1. under a sub-heading);
   and nothing is indented — every number sits at the left margin and all text
   starts 0.75" from it at every level, headings, clauses, (a) lists, quoted
   text and tables alike. Only the number shows the depth.

## Measuring a document

    python3 scripts/akla_style/analyze_docx.py "Some Document [AKLA].docx" > report.json

Reports page setup, styles as they resolve, every numbering level in use with
its indents, the direct formatting paragraphs carry, fonts and sizes as used,
tables, and the header and footer. Use it on any new firm sample before
changing the renderer, and on the renderer's output to compare.

## Why styles, not direct formatting

Firm documents are mostly formatted by hand, paragraph by paragraph (AM7 has
38 separate numbering lists). The renderer instead puts every paragraph on a
named style (`AKLA Heading 1`, `AKLA Body 2`, `AKLA List`, …) and gives the
outline numbering to those styles, so indentation is consistent, Word
renumbers correctly, and a paragraph inserted later — in Word or by the AI's
tracked edits — inherits the same format.
