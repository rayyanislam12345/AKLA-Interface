# Known issues in the master

Defects that are in `Standard Concession Agreement [AKLA] [May 08, 2026].docx` itself. Every draft
inherits them unless the master is fixed, so the checker records them in `assets/baseline.json`
and reports only what is new. This list is what a drafter should read before issuing anything
built from the master. The skill flags these; it does not fix them, because each is a drafting
decision for the firm.

## Structure

- **No Article 28 (Change in Law).** The term `Change in Law` and `Change in Law Termination
  Amount` are defined, the contents page runs 27 then 29, and four clauses refer to "Article 30".
  The body has 29 numbered Article headings. Either the article was dropped or the numbering was
  overridden; both executed agreements have a full Change in Law article at 28.
- **Dangling `Schedule Z`.** Inside the directive `[INCLUDE ONLY IF PRICE ESCALATION MECHANISM
  APPLIES — see Schedule Z]` in Schedule B. Schedules run A to Y.
- **Four drafter directives** left in Schedule B: `[Option A:]`, `[Option B:]`, and two
  `[INCLUDE ONLY IF …]` markers. The checker treats any of these surviving into a draft as a FAIL.

## Definitions

- **Five Section 1.1 pointers with no Schedule B match**: `Change of Scope Advance Percentage`
  and `Change of Scope Limit` (Schedule B spells them `Change Of Scope …`), `Specific
  Concessionaire Undertakings` (Schedule B has the singular), `Order of Priority` and `Relief Cost
  Threshold` (not in Schedule B at all).
- **Six malformed stems** reading `means shall have the meaning ascribed thereto`: `Financial
  Close Achievement Notice`, `Financing Amendment Term Sheets`, `Financing Term Sheet`, `Class B
  Dividends`, `Excess Revenues`, `First Agency Financial Instrument Amount`.
- **Two cross-reference formulae**: 142 `shall have the meaning ascribed thereto`, 7 `shall bear
  the meaning ascribed thereto`.
- A number of definitions are used nowhere else in the master; the checker lists them as orphan
  definitions. Some are meant for schedules still to be drafted.

## Revisions and notes

- **Three unresolved tracked changes** by the firm plus ten `rPrChange` formatting revisions. One
  insertion carries the cross-reference `Section [x]` inside the `Additional Cost` definition, so a
  live blank sits inside another author's revision. `build_agreement.py` refuses to run until these
  are accepted or rejected in the master (`--allow-revisions` overrides; the blank inside the
  revision is still skipped unless `--fill-in-revisions`).
- **Eleven Word comments** by the firm recording open policy questions: liquidated damages caps and
  a separate long-stop Event of Default, the Change of Scope payment mechanism and Total Project
  Cost buffer, a separate `Specific Standards` definition, mediation being optional and local versus
  international arbitration thresholds, escalation funding split, Sindh shareholding thresholds,
  where `Agency Overriding Power Event` belongs, uninsurable risks, and the treatment of
  pre-commencement works on termination. None is resolved. The build leaves them in place.
- **128 footnotes**, of which 102 are internal (93 open items such as `Input required from ADB on
  the timeline`, 9 provenance notes such as `This point is taken from Hubcanal Concession
  Agreement`), 18 substantive, and 8 conditional-amendment instructions. The build strips the
  102 by default.

## Cover and execution

- The cover date is a run of underscores rather than a bracket; `read_template.py` binds it to
  `cover_date`.
- The Agency execution block splits `For and on behalf of` / `[•]` / `through its authorised
  signatory` across three paragraphs; the reader binds the blank by the `As the Agency` heading
  above the table.

## How the checker treats all this

`baseline_template.py` runs the full audit on the master and freezes the result (151 findings at
the time of writing). `check_agreement.py --baseline` drops any finding whose text matches one in
that list. A finding whose text changes because a value was filled (for example `3 value blanks in
Article 1` becoming `1 value blank in Article 1`) is reported, which is the intended behaviour: it
means something is still open. Regenerate the baseline whenever the master changes.
